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
  const app = express();
  app.use(express.json());
  app.use(require('../routes/onboarding')({
    db, config: {}, logActivity: async () => {}, getUsers: async () => [OFFICE, NP],
    authenticateToken: (req, _res, next) => { req.user = current; next(); },
    drive, detectFileType: () => 'image/png', uuidv4: () => Math.random().toString(36).slice(2), sourceLoader
  }));
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body) => {
    const res = await fetch(base + path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    let data = null; try { data = await res.json(); } catch (_) { /* binary */ }
    return { status: res.status, data };
  };
  return { store, uploads, call, base, as: (u) => { current = u; } };
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
  assert.strictEqual(me.data.track.items[0].steps[0].actorBasis, undefined, 'the internal basis never reaches her');
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
  const ok = await h.call('POST', '/api/onboarding/me/modules/TRN-001/complete', {});
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

test('the overview counts whose turn it is and lists clinicians not yet set up', async (t) => {
  const h = await mount(t);
  h.as(OFFICE);
  let o = await h.call('GET', '/api/onboarding/admin/overview');
  assert.deepStrictEqual(o.data.notStarted.map(p => p.userId), ['n1']);
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
