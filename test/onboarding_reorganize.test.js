'use strict';

// Owner, 2026-11-18:
// - "we should be able to edit and reorganize hard-coded onboarding tasks"
// - "these tasks should be able to be reopened if closed too"
// - connections across onboarding and training
// - "no reason why anyone should be uploading W-9 info in two areas"

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const express = require('express');
const VF = require('../onboarding/versionFlags');

const OFFICE = { id: 'a1', name: 'Office Admin', role: 'admin' };
const CG = { id: 'c1', name: 'Cara Giver', role: 'vendor', accountType: 'caregiver', licenseLevel: 'pca' };
const RN = { id: 'r1', name: 'Rae Nurse', role: 'user', accountType: 'rn', clinicalRole: 'rn', hasClinicalAccess: true };

async function mount(t) {
  const store = {};
  const db = { get: async (k) => (k in store ? JSON.parse(JSON.stringify(store[k])) : null), set: async (k, v) => { store[k] = JSON.parse(JSON.stringify(v)); } };
  let current = OFFICE;
  const app = express(); app.use(express.json());
  app.use(require('../routes/onboarding')({
    db, config: {}, logActivity: async () => {}, getUsers: async () => [OFFICE, CG, RN],
    authenticateToken: (req, _res, next) => { req.user = current; next(); },
    drive: { uploadStaffDocumentFile: async () => ({ fileId: 'd1' }) }, detectFileType: () => 'application/pdf', uuidv4: () => Math.random().toString(36).slice(2),
    sourceLoader: { manualState: async () => ({ ok: true, currentVersion: '2.2', changeLog: VF.SEEDED_CHANGES.slice() }), checks: async () => ({ ok: true, sops: {}, library: {}, errors: [] }) },
    notify: () => null, getAppBaseUrl: async () => 'https://app.test.local'
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
  await call('PUT', `/api/onboarding/admin/people/${RN.id}/inputs`, { chapter: 'B' });
  return { store, call, as: (u) => { current = u; } };
}
const trackOf = async (h, id) => (await h.call('GET', `/api/onboarding/admin/people/${id}`)).data.track;
const ids = (t, phase) => t.items.filter(i => i.phase === phase).map(i => i.id);

test('rename, move to another phase, reorder, hide and restore a built-in task: every view follows', async (t) => {
  const h = await mount(t);
  let tr = await trackOf(h, CG.id);
  const a4 = ids(tr, 'A.4');
  assert.ok(a4.length >= 2);
  // Rename and move.
  assert.strictEqual((await h.call('PUT', '/api/onboarding/admin/items/A.4.03', { chapter: 'A', title: 'Check work history', phase: 'A.5' })).status, 200);
  tr = await trackOf(h, CG.id);
  const moved = tr.items.find(i => i.id === 'A.4.03');
  assert.strictEqual(moved.title, 'Check work history');
  assert.strictEqual(moved.phase, 'A.5');
  assert.ok(moved.edited);
  assert.ok(tr.phases.find(p => p.id === 'A.5').items.includes('A.4.03'), 'phase counts follow');
  // A phase this chapter does not have is refused.
  assert.strictEqual((await h.call('PUT', '/api/onboarding/admin/items/A.4.03', { chapter: 'A', phase: 'C.4' })).data.code, 'PHASE_UNKNOWN');
  // Reorder within the phase.
  const a5 = ids(tr, 'A.5');
  await h.call('PUT', '/api/onboarding/admin/phases/A.5/order', { chapter: 'A', ids: [a5[1], a5[0]] });
  tr = await trackOf(h, CG.id);
  assert.deepStrictEqual(ids(tr, 'A.5').slice(0, 2), [a5[1], a5[0]]);
  // Staff see the same order.
  h.as(CG);
  assert.deepStrictEqual(ids((await h.call('GET', '/api/onboarding/me')).data.track, 'A.5').slice(0, 2), [a5[1], a5[0]]);
  assert.strictEqual((await h.call('PUT', '/api/onboarding/admin/items/A.4.03', { chapter: 'A', title: 'x' })).status, 403, 'staff cannot edit');
  h.as(OFFICE);
  // Hide keeps what was recorded; restore brings it back.
  await h.call('POST', `/api/onboarding/admin/people/${CG.id}/items/A.4.02/steps/0`, { source: 'Called', verifiedOn: '2026-11-18' });
  await h.call('PUT', '/api/onboarding/admin/items/A.4.02', { chapter: 'A', hidden: true });
  tr = await trackOf(h, CG.id);
  assert.ok(!tr.items.some(i => i.id === 'A.4.02'));
  assert.ok(tr.hiddenItems.some(i => i.id === 'A.4.02'), 'the office can find it to restore');
  await h.call('PUT', '/api/onboarding/admin/items/A.4.02', { chapter: 'A', hidden: false });
  tr = await trackOf(h, CG.id);
  assert.strictEqual(tr.items.find(i => i.id === 'A.4.02').status, 'COMPLETE', 'its steps survived');
  // Restore original.
  await h.call('DELETE', '/api/onboarding/admin/items/A.4.03/override');
  tr = await trackOf(h, CG.id);
  assert.strictEqual(tr.items.find(i => i.id === 'A.4.03').phase, 'A.4');
});

test('the office reopens a finished task with a reason; what was recorded is kept in its history', async (t) => {
  const h = await mount(t);
  await h.call('POST', `/api/onboarding/admin/people/${CG.id}/items/A.4.02/steps/0`, { source: 'Called', verifiedOn: '2026-11-18' });
  assert.strictEqual((await h.call('POST', `/api/onboarding/admin/people/${CG.id}/items/A.4.02/reopen`, {})).data.code, 'REOPEN_REASON_REQUIRED');
  assert.strictEqual((await h.call('POST', `/api/onboarding/admin/people/${CG.id}/items/A.4.02/reopen`, { reason: 'Wrong reference' })).status, 200);
  const tr = await trackOf(h, CG.id);
  assert.notStrictEqual(tr.items.find(i => i.id === 'A.4.02').status, 'COMPLETE');
  const rec = h.store.onboarding_records.find(r => r.userId === CG.id);
  assert.strictEqual(rec.items['A.4.02'].reopened[0].reason, 'Wrong reference');
  assert.ok(rec.items['A.4.02'].reopened[0].steps[0], 'the old step is kept');
  assert.strictEqual((await h.call('POST', `/api/onboarding/admin/people/${CG.id}/items/A.4.02/reopen`, { reason: 'again' })).data.code, 'NOTHING_TO_REOPEN');
  h.as(CG);
  assert.strictEqual((await h.call('POST', `/api/onboarding/admin/people/${CG.id}/items/A.4.02/reopen`, { reason: 'x' })).status, 403);
});

test('pay and tax forms have one home: no Mark Sent or upload on those items, and the checklist ticks from Pay Setup', async (t) => {
  const h = await mount(t);
  h.as(RN);
  let item = (await h.call('GET', '/api/onboarding/me')).data.track.items.find(i => i.id === 'B.5.02');
  assert.deepStrictEqual(item.packet.map(p => p.kind), ['payform:w4', 'payform:i9', 'payform:pay']);
  assert.strictEqual(item.link.url, '/my#hours/pay');
  const sub = item.steps.findIndex(s => s.hers);
  assert.strictEqual((await h.call('POST', `/api/onboarding/me/items/B.5.02/steps/${sub}`, {})).data.code, 'PAY_SETUP_ROUTE');
  const fd = new FormData(); fd.append('file', new Blob([Buffer.from('%PDF-1.4 w4')], { type: 'application/pdf' }), 'w4.pdf');
  assert.strictEqual((await h.call('POST', '/api/onboarding/me/items/B.5.02/files', fd)).data.code, 'PAY_SETUP_ROUTE');
  // Done in Pay Setup, her step ticks.
  h.store.payroll_profiles = { [RN.id]: { w4: { signedAt: 'x' }, i9: { section1: { at: 'x' } }, payMethod: 'direct_deposit' } };
  item = (await h.call('GET', '/api/onboarding/me')).data.track.items.find(i => i.id === 'B.5.02');
  assert.ok(item.packet.every(p => p.status === 'complete'));
  assert.ok(item.steps[sub].done, 'her step reads done from Pay Setup');
});

test('a caregiver is sent to Pay Setup for W-4, I-9 and direct deposit', () => {
  const T = require('../onboarding/track');
  const a502 = T.findItem('A.5.02');
  assert.strictEqual(a502.link.url, '/caregiver#hours');
  assert.ok(['payform:w4', 'payform:i9', 'payform:pay'].every(k => a502.packet.includes(k)));
  for (const id of ['B.5.02', 'F.5.03']) assert.deepStrictEqual(T.findItem(id).packet, ['payform:w4', 'payform:i9', 'payform:pay'], id);
});

test('the office library lists who has each training, and the pages connect onboarding and training', async (t) => {
  const h = await mount(t);
  const lib = (await h.call('GET', '/api/onboarding/admin/library')).data.modules;
  const tr1 = lib.find(m => m.id === 'TRN-001');
  assert.ok(tr1.people.some(p => p.userId === CG.id && p.name === 'Cara Giver'));
  const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'onboarding.html'), 'utf8');
  assert.match(page, /const MINE_TABS = \['home', 'checklist', 'training', 'library', 'documents'\];/, 'each tab has its own link');
  assert.match(page, /<StaffLibrary onGoTraining=\{\(\) => setTab\('training'\)\} \/>/);
  assert.match(page, /\(item\.courses \|\| item\.modulesFrom\) && onGoTraining/);
  assert.match(page, /href=\{`\/onboarding\?module=\$\{encodeURIComponent\(m\.id\)\}#office-library`\}/);
  assert.match(page, /href=\{`\/onboarding\?person=\$\{encodeURIComponent\(p\.userId\)\}`\}/);
  assert.match(page, /<TaskEditor item=\{item\} track=\{track\} onSaved=\{onChanged\} \/>/);
  assert.match(page, /\/reopen`, \{ method: 'POST'/);
  const my = fs.readFileSync(path.join(__dirname, '..', 'public', 'my-gfc.js'), 'utf8');
  assert.match(my, /href="\/onboarding#training"/);
});

test('drag-and-drop reorder saves a whole phase at once; one row of controls, not arrows on every row', async (t) => {
  const h = await mount(t);
  let tr = await trackOf(h, CG.id);
  const a5 = ids(tr, 'A.5');
  const want = a5.slice().reverse();
  assert.strictEqual((await h.call('PUT', '/api/onboarding/admin/phases/A.5/order', { chapter: 'A', userId: CG.id, ids: want })).status, 200);
  tr = await trackOf(h, CG.id);
  assert.deepStrictEqual(ids(tr, 'A.5'), want);
  assert.strictEqual((await h.call('PUT', '/api/onboarding/admin/phases/A.5/order', { chapter: 'A', ids: ['A.4.01'] })).data.code, 'ORDER_MISMATCH');
  assert.strictEqual((await h.call('PUT', '/api/onboarding/admin/phases/Z.9/order', { chapter: 'A', ids: [] })).data.code, 'PHASE_UNKNOWN');
  const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'onboarding.html'), 'utf8');
  assert.match(page, /<ReorderList items=\{items\}/);
  assert.doesNotMatch(page, /aria-label="Move up"/, 'no arrows on every row');
});

test('admins and managers rename and remove a file on a task; staff cannot', async (t) => {
  const h = await mount(t);
  const fd = new FormData(); fd.append('file', new Blob([Buffer.from('%PDF-1.4 x')], { type: 'application/pdf' }), 'scan.pdf');
  assert.strictEqual((await h.call('POST', `/api/onboarding/admin/people/${RN.id}/items/B.4.02/files`, fd)).status, 200);
  const item = async () => (await trackOf(h, RN.id)).items.find(i => i.id === 'B.4.02');
  const f = (await item()).files[0];
  const url = `/api/onboarding/admin/people/${RN.id}/items/B.4.02/files/${f.id}`;
  assert.strictEqual((await h.call('PUT', url, { name: 'Documentation sample.pdf' })).status, 200);
  assert.strictEqual((await item()).files[0].name, 'Documentation sample.pdf');
  assert.strictEqual(h.store.caregiver_documents[0].file_name, 'Documentation sample.pdf', 'the Staff Record copy follows the name');
  h.as(RN);
  assert.strictEqual((await h.call('DELETE', url)).status, 403);
  h.as(OFFICE);
  assert.strictEqual((await h.call('DELETE', url)).status, 200);
  assert.strictEqual((await item()).files.length, 0);
  assert.strictEqual((await h.call('GET', url)).status, 404, 'a removed file no longer opens from the task');
  assert.ok(h.store.caregiver_documents[0], 'the Staff Record keeps its copy');
});

test('policies are signed in the app from the task, the same signature as My GFC → Policies; paper is the tucked-away exception', () => {
  const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'onboarding.html'), 'utf8');
  assert.match(page, /It is the same signature, so it ticks both\./);
  assert.match(page, /<summary className="meta" style=\{\{ cursor: 'pointer' \}\}>Signed on paper instead\?<\/summary>/);
  assert.match(page, /\{signs \? 'Open and Sign' : 'Open and Acknowledge'\}/, 'the Sign button sits on the task');
  const ui = fs.readFileSync(path.join(__dirname, '..', 'public', 'document-sign-ui.js'), 'utf8');
  assert.match(ui, /\/api\/my\/policy-docs\/\$\{encodeURIComponent\(d\.policyId\)\}\/sign/, 'one signing route for both places');
  assert.match(page, /r\.signs && r\.status !== 'complete'/, 'a welcome-packet form opens where it is signed');
  const T = require('../onboarding/track');
  const t = T.buildTrack({ inputs: { chapter: 'A' }, record: { userId: 'c1' }, accountType: 'caregiver', packetRows: require('../welcomePacketRepository').buildChecklist({}, [], {}, []) });
  assert.ok(t.items.find(i => i.id === 'A.5.03').packet.every(p => p.signs), 'handbook, privacy and code of conduct are signed forms');
});

test('every clinician gets the credentialing tasks first set up by hand: Medicare, CAQH, PDMP, BLS, education, I-9 documents', () => {
  const T = require('../onboarding/track');
  for (const chapter of ['C', 'E']) {
    const t = T.buildTrack({ inputs: { chapter, serviceLines: ['PRIVATE_PAY'], credentials: ['FNP'], prescribes: true }, record: { userId: 'n1' }, accountType: 'provider' });
    const got = (id) => t.items.find(i => i.id === id);
    for (const id of ['C.5.07', 'C.6.15', 'C.6.16', 'C.6.17', 'C.6.18', 'C.6.19']) assert.ok(got(id), `${chapter} has ${id}`);
    assert.match(got('C.6.16').description, /proview\.caqh\.org/);
    assert.ok(got('C.6.18').steps.some(s => s.hers && s.action === 'SUBMIT'));
  }
  assert.ok(require('../onboarding/renewals').EXPIRING_ITEMS['C.6.18'], 'the BLS card expiry is tracked');
  const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'onboarding.html'), 'utf8');
  assert.match(page, /Use Attach Document to Sign above, and they sign it in the app\./, 'an offer letter is signed in the app; paper is the backup');
});
