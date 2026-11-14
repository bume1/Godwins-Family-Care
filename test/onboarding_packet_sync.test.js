'use strict';

// One approval, every view (owner, 2026-11-13): "we have reviewed and approved
// most of these items for a caregiver, yet it did not automatically check off."
// The office approves in onboarding; her clearance list, her own checklist and
// onboarding all read the welcome packet, so the approval lands there.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const express = require('express');
const T = require('../onboarding/track');
const VF = require('../onboarding/versionFlags');
const sync = require('../onboarding/packetSync');
const gate = require('../caregiverOnboardingGate');

const OFFICE = { id: 'a1', name: 'Office Admin', email: 'a@x.test', role: 'admin' };
const CG = { id: 'c1', name: 'Tasha Green', email: 't@x.test', role: 'vendor', accountType: 'caregiver', licenseLevel: 'pca' };

async function mount(t, store = {}) {
  const db = { get: async (k) => (k in store ? JSON.parse(JSON.stringify(store[k])) : null), set: async (k, v) => { store[k] = JSON.parse(JSON.stringify(v)); } };
  let current = OFFICE;
  const auth = (req, _res, next) => { req.user = current; next(); };
  const app = express(); app.use(express.json());
  app.use(require('../routes/onboarding')({
    db, config: require('../config'), logActivity: async () => {}, getUsers: async () => [OFFICE, CG], authenticateToken: auth,
    drive: { uploadStaffDocumentFile: async () => ({ fileId: 'drive1' }), downloadFileBuffer: async () => Buffer.from('%PDF-1.4') },
    detectFileType: (b) => (b.slice(0, 4).toString() === '%PDF' ? 'application/pdf' : null), uuidv4: () => 'u' + Math.random().toString(36).slice(2),
    sourceLoader: { manualState: async () => ({ ok: true, currentVersion: '2.2', changeLog: VF.SEEDED_CHANGES.slice() }), checks: async () => ({ ok: true, sops: {}, library: {}, errors: [] }) },
    notify: () => null, getAppBaseUrl: async () => 'https://app.test.local'
  }));
  app.use(require('../routes/welcomePacket')({
    db, config: require('../config'), logActivity: async () => {}, queueNotification: async () => {},
    getUsers: async () => [OFFICE, CG], authenticateToken: auth, uuidv4: () => 'x',
    drive: { async uploadCaregiverDocument() { return { id: 'f1' }; } }, detectFileType: () => 'application/pdf', hashIp: () => 'h'
  }));
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body) => {
    const isForm = body instanceof FormData;
    const res = await fetch(base + p, { method, headers: body && !isForm ? { 'Content-Type': 'application/json' } : {}, body: body ? (isForm ? body : JSON.stringify(body)) : undefined });
    let data = null; try { data = await res.json(); } catch (_) { /* empty */ }
    return { status: res.status, data };
  };
  await call('PUT', `/api/onboarding/admin/people/${CG.id}/inputs`, { chapter: 'A' });
  return { store, call, as: (u) => { current = u; } };
}

const doc = (id, kind, status = 'received') => ({ id, caregiver_id: CG.id, kind, status, file_name: `${kind}.pdf`, drive_file_id: 'd' + id, uploaded_at: '2026-11-12T12:00:00Z' });
const packetStatus = (rows, kind) => (rows.find(r => r.kind === kind) || {}).status;
const checklistFor = (store) => require('../welcomePacketRepository').buildChecklist(((store.welcome_packets || [])[0] || {}).data, store.caregiver_documents || [], ((store.welcome_packets || [])[0] || {}).office, store.caregiver_attestations || []);

test('Verify in onboarding accepts the files she sent for that item, so it ticks everywhere', async (t) => {
  const h = await mount(t, { caregiver_documents: [doc('d1', 'certification'), doc('d2', 'cpr_first_aid')] });
  assert.strictEqual(packetStatus(checklistFor(h.store), 'cpr_first_aid'), 'in_review');
  const r = await h.call('POST', `/api/onboarding/admin/people/${CG.id}/items/A.6.06/steps/0`, { source: 'Card on file', verifiedOn: '2026-11-13' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.strictEqual(packetStatus(checklistFor(h.store), 'cpr_first_aid'), 'complete', 'the clearance list reads it done');
  assert.strictEqual(packetStatus(checklistFor(h.store), 'certification'), 'complete');
  const item = (await h.call('GET', `/api/onboarding/admin/people/${CG.id}`)).data.track.items.find(i => i.id === 'A.6.06');
  assert.ok(item.packet.every(p => p.status === 'complete'), 'onboarding reads it done');
  h.as(CG);
  const mine = (await h.call('GET', '/api/onboarding/me')).data.track.items.find(i => i.id === 'A.6.06');
  assert.strictEqual(mine.status, 'COMPLETE', 'her own view reads it done');
});

test('the office item: done in onboarding is done on the staff record, and the reverse', async (t) => {
  const h = await mount(t);
  await h.call('POST', `/api/onboarding/admin/people/${CG.id}/items/A.7.03/steps/0`, {});
  assert.strictEqual(h.store.welcome_packets[0].office.skills_check.status, 'done');
  assert.strictEqual(h.store.welcome_packets[0].office.skills_check.byName, 'Office Admin');
  // The staff record's dropdown and onboarding's Mark Done share one route.
  const put = await h.call('PUT', `/api/caregiver/admin/welcome-packets/${CG.id}/office-item`, { kind: 'orientation', status: 'done' });
  assert.strictEqual(put.status, 200);
  const a701 = (await h.call('GET', `/api/onboarding/admin/people/${CG.id}`)).data.track.items.find(i => i.id === 'A.7.01');
  assert.strictEqual(a701.status, 'COMPLETE');
  assert.ok(a701.packet[0].office, 'the page knows this row is the office\'s');
});

test('a file uploaded in onboarding is filed under its packet document; the office\'s is already accepted', async (t) => {
  const h = await mount(t);
  const fd = () => { const f = new FormData(); f.append('file', new Blob([Buffer.from('%PDF-1.4 tb')], { type: 'application/pdf' }), 'tb.pdf'); return f; };
  assert.strictEqual((await h.call('POST', `/api/onboarding/admin/people/${CG.id}/items/A.6.03/files`, fd())).status, 200);
  const row = h.store.caregiver_documents[0];
  assert.strictEqual(row.kind, 'tb_test');
  assert.strictEqual(row.status, 'accepted');
  assert.strictEqual(packetStatus(checklistFor(h.store), 'tb_test'), 'complete');
  const item = (await h.call('GET', `/api/onboarding/admin/people/${CG.id}`)).data.track.items.find(i => i.id === 'A.6.03');
  assert.strictEqual(item.files.length, 1, 'listed once, not twice');
  // Several documents: she says which.
  const no = await h.call('POST', `/api/onboarding/admin/people/${CG.id}/items/A.6.06/files`, fd());
  assert.strictEqual(no.data.code, 'PACKET_KIND_REQUIRED');
  const f = fd(); f.append('kind', 'cpr_first_aid');
  assert.strictEqual((await h.call('POST', `/api/onboarding/admin/people/${CG.id}/items/A.6.06/files`, f)).status, 200);
  assert.ok(h.store.caregiver_documents.some(d => d.kind === 'cpr_first_aid'));
  // Hers waits on review, with the id the page reviews it by.
  h.as(CG);
  await h.call('POST', `/api/onboarding/me/items/A.6.04/files`, (() => { const x = fd(); return x; })());
  const mine = h.store.caregiver_documents.find(d => d.kind === 'drug_screen');
  assert.strictEqual(mine.status, 'received');
  h.as(OFFICE);
  const a604 = (await h.call('GET', `/api/onboarding/admin/people/${CG.id}`)).data.track.items.find(i => i.id === 'A.6.04');
  assert.strictEqual(a604.files[0].documentId, mine.id);
  assert.strictEqual(a604.files[0].status, 'received');
});

test('a file waiting on review is waiting on the office, not on her', () => {
  const out = gate.outstandingForClearance([{ item: 9, title: 'TB', source: 'caregiver', required: true, status: 'in_review' },
    { item: 10, title: 'Drug', source: 'caregiver', required: true, status: 'missing' }]);
  assert.strictEqual(out[0].waitingOn, 'us');
  assert.strictEqual(out[1].waitingOn, 'you');
});

test('the one-time repair carries earlier approvals over, once', async () => {
  const store = {
    onboarding_records: [{ userId: CG.id, inputs: { chapter: 'A' }, items: {
      'A.6.06': { steps: { 0: { byId: 'a1', byName: 'Office Admin', at: '2026-11-10T12:00:00Z' } } },
      'A.6.01': { steps: { 0: { byId: 'a1', byName: 'Office Admin', at: '2026-11-10T12:00:00Z' } } }
    } }],
    caregiver_documents: [doc('d1', 'cpr_first_aid'),
      { ...doc('d2', 'clinician_onboarding'), onboarding_item_id: 'A.6.03', uploaded_by_office: true },
      { ...doc('d3', 'clinician_onboarding'), onboarding_item_id: 'A.5.02' }]
  };
  const db = { get: async (k) => store[k] || null, set: async (k, v) => { store[k] = v; } };
  const r = await sync.repairOnce(db, { findItem: T.findItem, now: '2026-11-13T12:00:00Z' });
  assert.deepStrictEqual({ rekinded: r.rekinded, accepted: r.accepted, officeDone: r.officeDone, unsure: r.unsure }, { rekinded: 1, accepted: 1, officeDone: 1, unsure: 1 });
  const by = (id) => store.caregiver_documents.find(d => d.id === id);
  assert.strictEqual(by('d1').status, 'accepted');
  assert.strictEqual(by('d2').kind, 'tb_test');
  assert.strictEqual(by('d2').status, 'accepted');
  assert.strictEqual(by('d3').kind, 'clinician_onboarding', 'several possible documents: left for the office');
  assert.strictEqual(store.welcome_packets[0].office.fingerprinting.status, 'done');
  store.caregiver_documents.push(doc('d4', 'cpr_first_aid'));
  assert.ok((await sync.repairOnce(db, { findItem: T.findItem, now: 'x' })).skipped);
  assert.strictEqual(by('d4').status, 'received', 'it runs once');
});

test('the pages: onboarding offers Mark Done, Accept and the document choice; the staff record refreshes and has no default type', () => {
  const ob = fs.readFileSync(path.join(__dirname, '..', 'public', 'onboarding.html'), 'utf8');
  assert.match(ob, /office && r\.office && r\.status !== 'complete'/);
  assert.match(ob, /office && f\.documentId && f\.status === 'received'/);
  assert.match(ob, /if \(upKinds\.length > 1\) fd\.append\('kind', upKind\)/);
  const hub = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin-hub.html'), 'utf8');
  assert.match(hub, /addEventListener\('gfc-staff-docs-changed', load\)/);
  assert.match(hub, /<option value="">Choose a type<\/option>/);
  assert.doesNotMatch(hub, /setKind\(cur => cur \|\|/);
});
