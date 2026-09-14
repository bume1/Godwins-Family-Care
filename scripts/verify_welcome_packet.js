#!/usr/bin/env node
// ============================================================================
// verify_welcome_packet.js — the caregiver onboarding journey, end to end
// ============================================================================
// Drives the SHIPPED routers over real HTTP and asserts STORED VALUES READ BACK,
// never status codes alone — the trap that cost this repo six OpenEMR defects.
//
// It walks the whole thing in the order a new caregiver meets it:
//   the app is shut → they upload their filled PDF → it prefills → they finish
//   → they sign → the app opens → the shift board is still shut → the office
//   works the checklist → they are cleared → a shift can be claimed.
//
// Run with no arguments to drive an in-memory store (what the build sandbox can
// reach). The deployment's own store is the thing to point it at when there is
// one — the contract is the same get/set pair.
//
//   node scripts/verify_welcome_packet.js

'use strict';

const express = require('express');
const assert = require('node:assert');
const { PDFDocument } = require('pdf-lib');

const config = require('../config');
const wp = require('../welcomePacketRepository');
const packetPdf = require('../welcomePacketPdf');

let passed = 0, failed = 0;
const check = (label, fn) => {
  try { fn(); passed += 1; console.log(`  ok   ${label}`); }
  catch (e) { failed += 1; console.log(`  FAIL ${label}\n       ${e.message}`); }
};

const CAREGIVER = { id: 'cg1', name: 'Ada Lovelace', email: 'ada@example.com', role: 'vendor', licenseLevel: 'cna' };
const ADMIN = { id: 'ad1', name: 'GFC Admin', email: 'admin@example.com', role: 'admin' };
const CLIENT = {
  id: 'cl1', name: 'Ruth Okafor', role: 'client', enrollmentStatus: 'enrolled',
  careTeam: { primaryCaregiver: 'cg1' }
};

const PROFILE = {
  firstName: 'Ada', lastName: 'Lovelace', mobilePhone: '404-555-0111', email: 'ada@example.com',
  dateOfBirth: '1990-04-01', homeAddress: '42 Peachtree Rd NE, Atlanta', homeZip: '30339',
  maxCommute: '30', transportation: 'own_vehicle', licenseAndInsurance: 'both_current',
  willingToDriveClients: 'no',
  availability: { monday: ['morning'], tuesday: ['morning'] },
  hoursPerWeek: '30_40', earliestStartDate: '2026-10-01',
  yearsExperience: '3_7', careExperience: ['bathing', 'companionship'], liftingComfort: 'with_equipment',
  ownWords: 'Seven years at home with people who needed a steady hand.',
  references: [
    { name: 'Jane Doe', relationship: 'Supervisor', phone: '404-555-0122' },
    { name: 'John Roe', relationship: 'Client family', phone: '404-555-0133' }
  ],
  emergencyName: 'Mary Byron', emergencyRelationship: 'Sister', emergencyPhone: '404-555-0144'
};

const fakeDrive = () => {
  const files = new Map();
  return {
    async uploadCaregiverDocumentFile(_name, fileName, buf) {
      const id = `drv_${files.size + 1}`;
      files.set(id, buf);
      return { fileId: id, fileName, webViewLink: `https://drive/${id}` };
    },
    async downloadFileBuffer(id) { return files.get(id); },
    describeDriveError: (e) => ({ reason: e.message, hint: null })
  };
};

const detectFileType = (buf) => {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return null;
  if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return 'application/pdf';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png';
  return null;
};

(async () => {
  const store = {};
  const db = { get: async (k) => store[k] || null, set: async (k, v) => { store[k] = v; } };
  const users = [CAREGIVER, ADMIN, CLIENT];
  let actor = CAREGIVER;

  const deps = {
    db, config,
    logActivity: async () => {},
    queueNotification: async () => {},
    getUsers: async () => users,
    invalidateUsersCache: () => {},
    authenticateToken: (req, _res, next) => { req.user = actor; next(); },
    uuidv4: () => `id_${Math.random().toString(36).slice(2, 10)}`,
    drive: fakeDrive(),
    detectFileType,
    hashIp: () => 'hashed-ip'
  };

  const app = express();
  app.use(express.json({ limit: '20mb' }));
  app.use(require('../routes/welcomePacket')(deps));
  app.use(require('../routes/caregiver')(deps));
  app.use(require('../routes/scheduling')(deps));
  const server = app.listen(0);
  const port = server.address().port;
  const call = (p, init) => fetch(`http://127.0.0.1:${port}${p}`, init);
  const send = (p, body, method = 'POST') => call(p, {
    method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });

  console.log('\nGFC caregiver welcome packet — live route verification\n');

  // -- 1. The app is shut ----------------------------------------------------
  console.log('The app before the packet');
  {
    const refused = await call('/api/caregiver/clients');
    const body = await refused.json();
    check('the client list is refused', () => assert.strictEqual(refused.status, 403));
    check('and it names the packet as the reason', () => assert.strictEqual(body.code, 'WELCOME_PACKET_REQUIRED'));

    const me = await (await call('/api/caregiver/me')).json();
    check('the shell can still read /me', () => assert.strictEqual(me.onboarding.appAccess, false));
    check('and it carries all 23 checklist items', () => assert.strictEqual(me.checklist.length, 23));
  }

  // -- 2. They upload the PDF they already filled ----------------------------
  console.log('\nImporting a packet they filled on their computer');
  {
    const blank = await packetPdf.generateFillableWelcomePacketPDF({});
    const pdf = await PDFDocument.load(blank);
    const form = pdf.getForm();
    form.getTextField('gfc.firstName').setText('Ada');
    form.getTextField('gfc.lastName').setText('Lovelace');
    form.getTextField('gfc.homeZip').setText('30339');
    form.getRadioGroup('gfc.maxCommute').select('30');
    form.getCheckBox('gfc.availability.monday.morning').check();
    const filled = Buffer.from(await pdf.save());

    const res = await send('/api/caregiver/welcome-packet/import', {
      fileName: 'GFC packet.pdf', fileDataB64: filled.toString('base64')
    });
    const body = await res.json();
    check('the import is accepted', () => assert.strictEqual(res.status, 200));
    check('read by NAME off our own form', () => assert.strictEqual(body.source, 'form'));
    check('the text answers land', () => assert.strictEqual(body.data.firstName, 'Ada'));
    check('so do the tick boxes', () => assert.deepStrictEqual(body.data.availability, { monday: ['morning'] }));
    check('and the radio choice', () => assert.strictEqual(body.data.maxCommute, '30'));
    check('it says what is still missing', () => assert.ok(body.missing.length > 0));

    // STORED, not just returned.
    check('the packet they sent is on file', () =>
      assert.strictEqual(store.caregiver_documents[0].kind, 'welcome_packet'));
    check('the draft is stored with what was read', () =>
      assert.strictEqual(store.welcome_packets[0].data.homeZip, '30339'));
  }

  // -- 3. They finish and sign -----------------------------------------------
  console.log('\nFinishing and signing');
  {
    await send('/api/caregiver/welcome-packet', { data: PROFILE }, 'PUT');
    const early = await send('/api/caregiver/welcome-packet/submit', { printedName: 'Ada Lovelace' });
    check('signing without a signature is refused', async () => assert.strictEqual(early.status, 400));

    const res = await send('/api/caregiver/welcome-packet/submit', {
      signaturePng: 'data:image/png;base64,aGVsbG8=', printedName: 'Ada Lovelace'
    });
    const body = await res.json();
    check('the packet is accepted', () => assert.strictEqual(res.status, 200));
    check('the app opens', () => assert.strictEqual(body.onboarding.appAccess, true));
    check('the shift board does not', () => assert.strictEqual(body.onboarding.cleared, false));

    const row = store.welcome_packets[0];
    check('the signature is stored', () => assert.ok(row.signature_png));
    check('with the signer address hashed', () => assert.strictEqual(row.signer_ip_hash, 'hashed-ip'));
    check('and the packet version it was signed against', () =>
      assert.strictEqual(row.version, wp.PACKET_VERSION));

    const edit = await send('/api/caregiver/welcome-packet', { data: { firstName: 'Someone' } }, 'PUT');
    check('a signed packet refuses edits', () => assert.strictEqual(edit.status, 409));
    check('and the stored answer is untouched', () =>
      assert.strictEqual(store.welcome_packets[0].data.firstName, 'Ada'));
  }

  // -- 4. The app is open; the shift board is not ----------------------------
  console.log('\nThe app after the packet');
  {
    const clients = await call('/api/caregiver/clients');
    check('the client list opens', () => assert.strictEqual(clients.status, 200));

    actor = ADMIN;
    await send('/api/scheduling/shifts', {
      clientId: 'cl1',
      start: new Date(Date.now() + 86400000).toISOString(),
      end: new Date(Date.now() + 86400000 + 4 * 3600000).toISOString(),
      requiredLicenseLevel: 'any'
    });
    const shiftId = (store.shifts || [])[0] && store.shifts[0].id;
    check('an admin can post a shift', () => assert.ok(shiftId));

    actor = CAREGIVER;
    const claim = await send(`/api/scheduling/shifts/${shiftId}/claim`, {});
    const claimBody = await claim.json();
    check('claiming it is refused while they are not cleared', () =>
      assert.strictEqual(claim.status, 409));
    check('and the refusal names the clearance', () =>
      assert.strictEqual(claimBody.code, 'CAREGIVER_NOT_CLEARED'));
    check('it lists what is outstanding', () => assert.ok(claimBody.outstanding.length > 0));
    check('split by who each item waits on', () => {
      assert.ok(claimBody.outstanding.some(o => o.waitingOn === 'you'));
      assert.ok(claimBody.outstanding.some(o => o.waitingOn === 'us'));
    });
    check('and the shift is untouched', () =>
      assert.strictEqual(store.shifts[0].status, 'open'));

    // The admin override — with a reason, stamped on the row it created.
    actor = ADMIN;
    const noReason = await send(`/api/scheduling/shifts/${shiftId}/assign`, { caregiverId: 'cg1', override: true });
    check('an override with no reason is refused', () => assert.strictEqual(noReason.status, 400));

    const overridden = await send(`/api/scheduling/shifts/${shiftId}/assign`, {
      caregiverId: 'cg1', override: true, overrideReason: 'Cover needed tonight; TB result seen on paper.'
    });
    const shift = (await overridden.json()).shift;
    check('an override with a reason goes through', () => assert.strictEqual(overridden.status, 200));
    check('and the shift SAYS it was overridden', () =>
      assert.match(shift.clearanceOverride.reason, /Cover needed tonight/));
    check('naming who did it', () => assert.strictEqual(shift.clearanceOverride.byName, 'GFC Admin'));
    check('and freezing what was outstanding at the time', () =>
      assert.ok(shift.clearanceOverride.outstanding.length > 0));
  }

  // -- 5. Working the checklist ---------------------------------------------
  console.log('\nWorking the checklist to a real clearance');
  {
    actor = CAREGIVER;
    const pdfBytes = Buffer.from('%PDF-1.4\nstub\n');
    const required = wp.DOCUMENT_ITEMS.filter(d => d.upload && wp.itemRequired(d, PROFILE));
    for (const item of required) {
      await send('/api/caregiver/documents', {
        kind: item.kind, fileName: `${item.kind}.pdf`, fileDataB64: pdfBytes.toString('base64')
      });
    }
    check(`${required.length} required documents were accepted for upload`, () =>
      assert.strictEqual(store.caregiver_documents.filter(d => d.kind !== 'welcome_packet').length, required.length));

    const stillShut = await (await call('/api/caregiver/welcome-packet')).json();
    check('an uploaded document reads as with the office, not done', () =>
      assert.strictEqual(stillShut.checklist.find(r => r.kind === 'tb_test').status, 'in_review'));
    check('so the caregiver is still not cleared', () =>
      assert.strictEqual(stillShut.onboarding.cleared, false));

    // The office accepts them, and ticks its own items.
    actor = ADMIN;
    for (const row of store.caregiver_documents) {
      if (row.kind === 'welcome_packet') continue;
      await send(`/api/caregiver/documents/${row.id}/review`, { decision: 'accepted' });
    }
    for (const kind of wp.OFFICE_ITEM_KINDS) {
      await send(`/api/caregiver/admin/welcome-packets/cg1/office-item`, { kind, status: 'done' }, 'PUT');
    }

    const queue = await (await call('/api/caregiver/admin/welcome-packets')).json();
    const row = queue.caregivers.find(c => c.caregiverId === 'cg1');
    check('the queue reports the caregiver as cleared', () => assert.strictEqual(row.cleared, true));
    check('with nothing outstanding', () => assert.strictEqual(row.outstandingCount, 0));
    check('and the queue carries no answers, only counts', () =>
      assert.ok(!JSON.stringify(queue).includes('1990-04-01')));

    // And now a claim goes through on its own merits.
    actor = ADMIN;
    await send('/api/scheduling/shifts', {
      clientId: 'cl1',
      start: new Date(Date.now() + 3 * 86400000).toISOString(),
      end: new Date(Date.now() + 3 * 86400000 + 4 * 3600000).toISOString(),
      requiredLicenseLevel: 'any'
    });
    const second = store.shifts[store.shifts.length - 1];
    actor = CAREGIVER;
    const claim = await send(`/api/scheduling/shifts/${second.id}/claim`, {});
    check('a cleared caregiver can claim a shift', () => assert.strictEqual(claim.status, 200));
    check('and it is stored as claimed by them', () => {
      const stored = store.shifts.find(s => s.id === second.id);
      assert.strictEqual(stored.status, 'claimed');
      assert.strictEqual(stored.caregiver_id, 'cg1');
    });
    check('with no override on it, because none was needed', () => {
      const stored = store.shifts.find(s => s.id === second.id);
      assert.ok(!stored.clearance_override);
    });
  }

  server.close();
  console.log(`\n${passed}/${passed + failed} checks passed${failed ? ` — ${failed} FAILED` : ''}\n`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('probe crashed:', e); process.exit(1); });
