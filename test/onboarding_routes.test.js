'use strict';

// The onboarding routes, through the real router over HTTP, with a fake store
// and a fake Drive. Every assertion reads what was stored, not a status code
// alone.

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const C = require('../onboarding/chapterC');
const VF = require('../onboarding/versionFlags');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const OFFICE = { id: 'a1', name: 'Office Admin', role: 'admin' };
const NP = { id: 'n1', name: 'Jordan Ellis', role: 'user', hasClinicalAccess: true };

async function mount(t) {
  const store = {};
  const db = { get: async (k) => (k in store ? JSON.parse(JSON.stringify(store[k])) : null), set: async (k, v) => { store[k] = JSON.parse(JSON.stringify(v)); } };
  let current = OFFICE;
  const uploads = [];
  const drive = {
    uploadStaffDocumentFile: async (role, person, name, buf, mime) => { uploads.push({ role, person, name }); return { fileId: 'DRIVE_SECRET_1' }; },
    downloadFileBuffer: async () => PNG,
    describeDriveError: (e) => ({ reason: e.message })
  };
  // The manual reads as v2.2 with no Drive call, so the flags are the seeded ones.
  const sourceLoader = {
    manualState: async () => ({ ok: true, currentVersion: '2.2', changeLog: VF.SEEDED_CHANGES.slice() }),
    checks: async () => ({ ok: true, sops: { 'SOP-SYS-01': [{ prompt: 'Where is the record?', answer: 'OpenEMR.', source: 'Manual 3.1' }] }, library: {}, errors: [] })
  };
  const notices = [];
  const notify = require('../notifications').createNotifier({
    getUsers: async () => [OFFICE, NP],
    queueNotification: async (type, id, email, name, data) => { notices.push({ type, email, ...data }); return { id: 'q' }; },
    getAppBaseUrl: async () => 'https://app.test.local',
    emailTransport: { transportStatus: () => ({ baaCovered: true }) },
    staffRoles: ['admin', 'user'], clientRole: 'client', familyRole: 'family'
  });
  const app = express();
  app.use(express.json());
  app.use(require('../routes/onboarding')({
    db, config: {}, logActivity: async () => {}, getUsers: async () => [OFFICE, NP],
    authenticateToken: (req, _res, next) => { req.user = current; next(); },
    drive, detectFileType: () => 'image/png', uuidv4: () => Math.random().toString(36).slice(2), sourceLoader,
    // The notifier is injected because server.js injects one (2026-11-09).
    // Without it these tests exercise a router where nobody is ever emailed,
    // which is a different function from the one that ships.
    notify: () => notify, getAppBaseUrl: async () => 'https://app.test.local'
  }));
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body) => {
    const res = await fetch(base + path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    let data = null; try { data = await res.json(); } catch (_) { /* binary */ }
    return { status: res.status, data };
  };
  return { store, uploads, call, base, notices, as: (u) => { current = u; } };
}

const startHer = async (h, inputs) => {
  h.as(OFFICE);
  const r = await h.call('PUT', `/api/onboarding/admin/people/${NP.id}/inputs`, inputs || { serviceLines: ['PRIVATE_PAY', 'IME'], credentials: ['FNP'] });
  assert.strictEqual(r.status, 200);
};

test('her door: she sees her track only once the office starts it, and is told whose turn it is', async (t) => {
  const h = await mount(t);
  h.as(NP);
  let me = await h.call('GET', '/api/onboarding/me');
  assert.strictEqual(me.data.started, false);
  assert.strictEqual(me.data.viewer.isOffice, false);
  await startHer(h);
  h.as(NP);
  me = await h.call('GET', '/api/onboarding/me');
  assert.strictEqual(me.data.started, true);
  // Step 1 is the welcome packet (2026-11-09), which has no steps of its own.
  assert.strictEqual(me.data.track.items[0].id, 'WELCOME');
  assert.strictEqual(me.data.track.items.find(x => x.steps.length).steps[0].actorBasis, undefined, 'the internal basis never reaches her');
  assert.deepStrictEqual(me.data.track.checks.byModule, {}, 'check questions are OFF for staff by default');
  h.as(OFFICE);
  await h.call('PUT', '/api/onboarding/admin/settings', { checkQuestionsForStaff: true });
  h.as(NP);
  me = await h.call('GET', '/api/onboarding/me');
  assert.ok(me.data.track.checks.byModule['TRN-003'], 'switched on, they arrive read from the SOP');
  h.as(NP);
  assert.strictEqual((await h.call('PUT', '/api/onboarding/admin/settings', { checkQuestionsForStaff: false })).status, 403, 'only the office switches them');
});

test('she cannot complete an office step through her own door', async (t) => {
  const h = await mount(t);
  await startHer(h);
  h.as(NP);
  const r = await h.call('POST', '/api/onboarding/me/items/C.4.05/steps/1', { source: 'x', verifiedOn: '2026-11-08' });
  assert.strictEqual(r.status, 403);
  assert.strictEqual(r.data.code, 'STEP_NOT_YOURS');
  assert.ok(!h.store.onboarding_records[0].items['C.4.05'] || !h.store.onboarding_records[0].items['C.4.05'].steps);
});

test('the office files her step on her behalf, and it is stored that way', async (t) => {
  const h = await mount(t);
  await startHer(h);
  h.as(OFFICE);
  await h.call('POST', `/api/onboarding/admin/people/${NP.id}/items/C.4.05/steps/0`, {});
  const v = await h.call('POST', `/api/onboarding/admin/people/${NP.id}/items/C.4.05/steps/1`, { source: 'Prior employer', verifiedOn: '2026-11-08' });
  assert.strictEqual(v.status, 200);
  const st = h.store.onboarding_records[0].items['C.4.05'];
  assert.strictEqual(st.steps[0].filedBy, 'OFFICE_ON_BEHALF');
  assert.strictEqual(st.steps[1].source, 'Prior employer');
  h.as(NP);
  const me = await h.call('GET', '/api/onboarding/me');
  assert.strictEqual(me.data.track.items.find(i => i.id === 'C.4.05').status, 'COMPLETE');
});

test('she acknowledges at the version the server states, whatever the page posts', async (t) => {
  const h = await mount(t);
  await startHer(h);
  h.as(NP);
  await h.call('POST', '/api/onboarding/me/items/C.5.04/acknowledgments/CLINICAL_MANUAL', { version: '1.0' });
  assert.strictEqual(h.store.onboarding_records[0].items['C.5.04'].acknowledgments.CLINICAL_MANUAL.version, '2.2');
});

test('the office files an older signed copy, and it reads stale, never complete', async (t) => {
  const h = await mount(t);
  await startHer(h);
  h.as(OFFICE);
  await h.call('POST', `/api/onboarding/admin/people/${NP.id}/items/C.5.04/acknowledgments/CLINICAL_MANUAL`, { version: '2.0' });
  const p = await h.call('GET', `/api/onboarding/admin/people/${NP.id}`);
  const ack = p.data.track.items.find(i => i.id === 'C.5.04').acknowledgments.find(a => a.id === 'CLINICAL_MANUAL');
  assert.strictEqual(ack.stale, true);
  assert.ok(ack.links[0].includes('1LBCQ-OHx1x6be9TfiXOTg7-O0a3-rwN6'), 'the canonical copy');
});

test('an upload lands in her clinician folder, completes her send step, and the Drive id never leaves the server', async (t) => {
  const h = await mount(t);
  await startHer(h);
  h.as(NP);
  const fd = new FormData();
  fd.append('file', new Blob([PNG], { type: 'image/png' }), 'history.png');
  const up = await fetch(`${h.base}/api/onboarding/me/items/C.4.05/files`, { method: 'POST', body: fd });
  assert.strictEqual(up.status, 200);
  assert.strictEqual(h.uploads[0].role, 'GFC Clinician Documents');
  assert.strictEqual(h.uploads[0].person, 'Jordan Ellis');
  const st = h.store.onboarding_records[0].items['C.4.05'];
  assert.strictEqual(st.steps[0].filedBy, 'SELF');
  assert.strictEqual(h.store.caregiver_documents[0].clinician_item_id || h.store.caregiver_documents[0].onboarding_item_id, 'C.4.05');
  const me = await h.call('GET', '/api/onboarding/me');
  const raw = JSON.stringify(me.data);
  assert.ok(!raw.includes('DRIVE_SECRET_1'), 'Drive id leaked to the browser');
  assert.strictEqual(me.data.track.items.find(i => i.id === 'C.4.05').status, 'SUBMITTED');
});

test('a returned step needs a reason and reaches her screen', async (t) => {
  const h = await mount(t);
  await startHer(h);
  h.as(NP);
  await h.call('POST', '/api/onboarding/me/items/C.4.05/steps/0', {});
  h.as(OFFICE);
  const bad = await h.call('POST', `/api/onboarding/admin/people/${NP.id}/items/C.4.05/return`, { step: 0, reason: '' });
  assert.strictEqual(bad.data.code, 'RETURN_REASON_REQUIRED');
  await h.call('POST', `/api/onboarding/admin/people/${NP.id}/items/C.4.05/return`, { step: 0, reason: 'Explain the 2019 gap.' });
  h.as(NP);
  const me = await h.call('GET', '/api/onboarding/me');
  const it = me.data.track.items.find(i => i.id === 'C.4.05');
  assert.strictEqual(it.status, 'RETURNED');
  assert.strictEqual(it.returned.reason, 'Explain the 2019 gap.');
});

test('a flagged module cannot be started by a new learner; an unflagged one can', async (t) => {
  const h = await mount(t);
  await startHer(h);
  h.as(NP);
  const flagged = await h.call('POST', '/api/onboarding/me/modules/TRN-207/complete', {});
  assert.strictEqual(flagged.data.code, 'MODULE_UNDER_REVIEW');
  // TRN-001 teaches no SOP, so it opens only once the office adds material
  // (owner, 2026-11-09). TRN-003 teaches SOP-SYS-01 and is open as it stands.
  const ok = await h.call('POST', '/api/onboarding/me/modules/TRN-003/complete', {});
  assert.strictEqual(ok.status, 200);
  const office = await h.call('POST', '/api/onboarding/me/modules/TRN-006/complete', {});
  assert.strictEqual(office.data.code, 'MODULE_OFFICE_SIGNOFF', 'a countersigned module is the office\'s');
});

test('the office opens a service line only with every condition and a scope, and never through her door', async (t) => {
  const h = await mount(t);
  await startHer(h, { serviceLines: ['IME'] });
  h.as(NP);
  const hers = await h.call('POST', `/api/onboarding/admin/people/${NP.id}/determinations/IME`, {});
  assert.strictEqual(hers.status, 403);
  h.as(OFFICE);
  const early = await h.call('POST', `/api/onboarding/admin/people/${NP.id}/determinations/IME`, {});
  assert.strictEqual(early.data.code, 'DETERMINATION_NOT_READY');
  for (const id of ['TRN-101', 'TRN-102', 'TRN-103', 'TRN-104', 'TRN-105']) {
    await h.call('POST', `/api/onboarding/admin/people/${NP.id}/modules/${id}/complete`, {});
  }
  const det = C.DETERMINATIONS.find(d => d.id === 'IME');
  const opened = await h.call('POST', `/api/onboarding/admin/people/${NP.id}/determinations/IME`, { conditionsConfirmed: det.conditions, approvedScope: 'C&P examinations' });
  assert.strictEqual(opened.status, 200);
  assert.strictEqual(h.store.onboarding_records[0].determinations.IME.reviewedBy.name, 'Office Admin');
});

test('the overview counts whose turn it is and lists everyone not yet set up, with their chapter', async (t) => {
  const h = await mount(t);
  h.as(OFFICE);
  let o = await h.call('GET', '/api/onboarding/admin/overview');
  assert.deepStrictEqual(o.data.notStarted.map(p => [p.userId, p.chapter]), [['a1', 'F'], ['n1', 'C']], 'the admin team on F, clinicians on C');
  await startHer(h);
  o = await h.call('GET', '/api/onboarding/admin/overview');
  assert.strictEqual(o.data.counts.active, 1);
  assert.ok(o.data.counts.waitingOnStaff > 0);
  assert.strictEqual(o.data.people[0].currentPhase.number, 1);
  assert.strictEqual(o.data.counts.modulesFlagged, 4);
  h.as(NP);
  assert.strictEqual((await h.call('GET', '/api/onboarding/admin/overview')).status, 403);
});

test('the Clinical Director confirms a pending module\'s sections, and they then drive its flag', async (t) => {
  const h = await mount(t);
  h.as(OFFICE);
  const r = await h.call('POST', '/api/onboarding/admin/library/TRN-210/review', { confirmedManualRefs: ['18.1'] });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(h.store.onboarding_module_reviews['TRN-210'].confirmedManualRefs, ['18.1']);
  const lib = await h.call('GET', '/api/onboarding/admin/library');
  assert.strictEqual(lib.data.modules.find(m => m.id === 'TRN-210').flag.status, 'CURRENT');
  assert.strictEqual(lib.data.modules.find(m => m.id === 'TRN-207').phaseNumber, 4);
});

test('the admin team is onboarded on Chapter F: no clinical training, and a Field Addendum only for a role that enters a home', async (t) => {
  const h = await mount(t);
  h.as(OFFICE);
  const COORD = { id: 'k1', name: 'Coco Ordinator', role: 'user', isManager: true, clinicalRole: 'coordinator', accountType: 'coordinator' };
  // start the office admin herself on F
  await h.call('PUT', `/api/onboarding/admin/people/${OFFICE.id}/inputs`, { startDate: '2026-11-10' });
  const p = await h.call('GET', `/api/onboarding/admin/people/${OFFICE.id}`);
  const tr = p.data.track;
  assert.strictEqual(tr.chapter.id, 'F');
  assert.deepStrictEqual(tr.modules.map(m => m.id).sort(), [...require('../onboarding/libraryTrainings').SHARED_MODULE_IDS].sort(), 'only the general modules, never the clinical curriculum');
  assert.ok(!tr.items.some(i => i.id === 'F.5.06'), 'no Field Addendum unless the role enters a client residence');
  assert.ok(!tr.items.some(i => i.id === 'F.6.01'), 'no out-of-state registration for a Georgia worker');
  const ack = tr.items.find(i => i.id === 'F.5.05').acknowledgments.find(a => a.id === 'ADMIN_MANUAL');
  assert.strictEqual(ack.required, '2.3');
  assert.ok(ack.links[0].includes('1E-1J1l86cyC0sfdlcmOQDeHJExjwIBlr'), 'the canonical Administrative P&P');
  await h.call('PUT', `/api/onboarding/admin/people/${OFFICE.id}/inputs`, { entersResidence: true, workState: 'TX' });
  const q = (await h.call('GET', `/api/onboarding/admin/people/${OFFICE.id}`)).data.track;
  assert.strictEqual(q.chapter.id, 'F', 'the chapter is kept when inputs change');
  assert.ok(q.items.some(i => i.id === 'F.5.06') && q.items.some(i => i.id === 'F.6.01'));
  void COORD;
});

test('a registered nurse is onboarded on Chapter B: PHC P&P 3.1, clearance before client contact, supervisory items only when delegated', async (t) => {
  const T = require('../onboarding/track');
  const b = T.buildTrack({ inputs: { chapter: 'B' }, record: {} });
  assert.strictEqual(b.chapter.id, 'B');
  assert.deepStrictEqual(b.modules.map(m => m.id).sort(), [...require('../onboarding/libraryTrainings').SHARED_MODULE_IDS].sort(), 'only the general modules');
  assert.ok(!b.items.some(i => i.id === 'B.7.04') && !b.items.some(i => i.id === 'B.7.05'), 'no delegated duties unless set');
  const ack = b.items.find(i => i.id === 'B.5.03').acknowledgments.find(a => a.id === 'PHC_MANUAL');
  assert.strictEqual(ack.required, '3.1');
  assert.strictEqual(T.ALL_ACKS.find(a => a.id === 'PHC_MANUAL').playbookStates, '3.0', 'the Playbook figure stays visible');
  const d = T.buildTrack({ inputs: { chapter: 'B', supervisoryDelegation: true, directsTraining: true }, record: {} });
  assert.ok(d.items.some(i => i.id === 'B.7.04') && d.items.some(i => i.id === 'B.7.05'));
  assert.ok(d.recurring.some(r => r.id === 'B.8.R3'), 'supervisory visits recur when delegated');
  assert.deepStrictEqual(d.renewals.items.map(x => x.id), ['B.6.01', 'B.6.04', 'B.6.05']);
  // An RN account starts on Chapter B without anybody choosing it.
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'routes', 'onboarding.js'), 'utf8');
  assert.match(src, /if \(t === 'rn'\) return 'B';/);
});

test('step 1 is the welcome packet: it ticks itself from the signed packet and cannot be ticked by hand', async (t) => {
  const h = await mount(t);
  await startHer(h);
  h.as(NP);
  let w = (await h.call('GET', '/api/onboarding/me')).data.track.items[0];
  assert.strictEqual(w.id, 'WELCOME');
  assert.strictEqual(w.status, 'NOT_STARTED');
  assert.strictEqual(w.waitingOnHer, true);
  assert.deepStrictEqual(w.steps, []);
  // No door ticks it: there is no catalog item behind it.
  assert.strictEqual((await h.call('POST', `/api/onboarding/me/items/WELCOME/steps/0`, {})).status, 404);
  h.as(OFFICE);
  assert.strictEqual((await h.call('POST', `/api/onboarding/admin/people/${NP.id}/items/WELCOME/not-applicable`, { reason: 'x' })).status, 404);
  // Started but not signed is still hers to do.
  h.store.staff_welcome_packets = [{ user_id: NP.id, status: 'in_progress' }];
  h.as(NP);
  w = (await h.call('GET', '/api/onboarding/me')).data.track.items[0];
  assert.notStrictEqual(w.status, 'COMPLETE');
  h.store.staff_welcome_packets = [{ user_id: NP.id, status: 'submitted', signed_at: '2026-11-09T12:00:00Z' }];
  w = (await h.call('GET', '/api/onboarding/me')).data.track.items[0];
  assert.strictEqual(w.status, 'COMPLETE');
  assert.strictEqual(w.waitingOnHer, false);
  // Someone else's signed packet never counts for her.
  h.store.staff_welcome_packets = [{ user_id: 'someone-else', status: 'submitted' }];
  assert.strictEqual((await h.call('GET', '/api/onboarding/me')).data.track.items[0].status, 'NOT_STARTED');
});
