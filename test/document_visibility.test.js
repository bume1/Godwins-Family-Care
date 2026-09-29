'use strict';
// Who sees a client document, and removing one (owner, 2026-09-29).
// Live half: scripts/verify_document_visibility.js.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const docs = require('../clientDocuments');
const repo = require('../clinicalRepository');

const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const CLINICAL = fs.readFileSync(path.join(__dirname, '..', 'public', 'clinical.html'), 'utf8');
const ENROLL = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin-enrollment.html'), 'utf8');

const own = { id: 'u1', clientId: 'c1', source: 'client', status: 'accepted', fileName: 'licence.png', kind: 'photoId' };
const staff = { id: 'u2', clientId: 'c1', source: 'staff', status: 'accepted', fileName: 'summary.pdf', kind: 'priorRecords' };
const removed = (u) => ({ ...u, removed: { at: '2026-09-29T00:00:00Z', byId: 'a', byName: 'A', reason: 'dup' } });

test('a patient sees their own upload, and an office-filed one only once it is shared', () => {
  assert.strictEqual(docs.patientCanSee(own), true);
  assert.strictEqual(docs.patientCanSee(staff), false);
  assert.strictEqual(docs.patientCanSee({ ...staff, sharedWithPatient: true }), true);
  assert.strictEqual(docs.patientCanSee({ ...staff, sharedWithPatient: 'yes' }), false, 'only a real true shares');
  assert.strictEqual(docs.patientCanSee(removed(own)), false);
  assert.strictEqual(docs.patientCanSee(removed({ ...staff, sharedWithPatient: true })), false);
  assert.strictEqual(docs.patientCanSee(null), false);
});

test('removing is admin or manager only', () => {
  assert.strictEqual(docs.canRemoveDocuments({ role: 'admin' }), true);
  assert.strictEqual(docs.canRemoveDocuments({ role: 'user', isManager: true }), true);
  assert.strictEqual(docs.canRemoveDocuments({ role: 'user', hasClinicalAccess: true, clinicalRole: 'provider' }), false);
  assert.strictEqual(docs.canRemoveDocuments({ role: 'caseManager' }), false);
  assert.strictEqual(docs.canRemoveDocuments({ role: 'client' }), false);
  assert.strictEqual(docs.canRemoveDocuments(null), false);
});

test('a removal needs a reason and cannot happen twice', () => {
  assert.strictEqual(docs.checkRemoval(own, '').code, 'REMOVE_REASON_REQUIRED');
  assert.strictEqual(docs.checkRemoval(own, '  a ').code, 'REMOVE_REASON_REQUIRED');
  assert.strictEqual(docs.checkRemoval(null, 'dup file').code, 'DOCUMENT_NOT_FOUND');
  assert.strictEqual(docs.checkRemoval(removed(own), 'dup file').code, 'DOCUMENT_ALREADY_REMOVED');
  const ok = docs.checkRemoval(own, '  Uploaded twice  ');
  assert.deepStrictEqual(ok, { ok: true, reason: 'Uploaded twice' });
  const r = docs.buildRemoval({ actor: { id: 'm1', name: 'Mgr' }, reason: ok.reason, at: '2026-09-29T01:00:00Z' });
  assert.deepStrictEqual(r, { at: '2026-09-29T01:00:00Z', byId: 'm1', byName: 'Mgr', reason: 'Uploaded twice' });
});

test('sharing is only for an office-filed document that is still on file', () => {
  assert.strictEqual(docs.checkShare(own).code, 'CLIENT_OWN_DOCUMENT');
  assert.strictEqual(docs.checkShare({ ...staff, status: 'rejected' }).code, 'DOCUMENT_REJECTED');
  assert.strictEqual(docs.checkShare(removed(staff)).code, 'DOCUMENT_NOT_FOUND');
  assert.strictEqual(docs.checkShare(staff).ok, true);
});

test('a removed row stays in the store; only the reads filter it', () => {
  assert.deepStrictEqual(docs.liveUploads([own, removed(staff), null]).map(u => u.id), ['u1']);
});

// ── The chart index, both audiences ───────────────────────────────────────

const CLIENT = { id: 'c1', consents: { npp: 'signed' }, consentMeta: {} };
const index = (extra) => repo.buildChartDocumentIndex({
  client: CLIENT,
  clientUploads: [own, staff, removed({ ...own, id: 'u3', fileName: 'gone.png' })],
  consentDefs: [{ type: 'npp', title: 'Notice of Privacy Practices' }],
  consentSatisfied: (s) => s === 'signed',
  emrReadSupported: true,
  emrRows: [{ id: 'e1', description: 'Lab result.pdf' }],
  ...extra
});

test('the patient\'s record lists what they sent and what they signed, nothing else', () => {
  const rows = index({ audience: 'patient' });
  assert.deepStrictEqual(rows.map(r => r.id).sort(), ['consent:npp', 'upload:u1']);
  assert.strictEqual(rows.find(r => r.id === 'upload:u1').category, 'You sent this');
});

test('a shared office document reaches the patient, labelled as from their care team', () => {
  const rows = repo.buildChartDocumentIndex({ client: CLIENT, clientUploads: [{ ...staff, sharedWithPatient: true }], audience: 'patient' });
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].category, 'From your care team');
});

test('the patient\'s record never lists an OpenEMR-only document, even when handed one', () => {
  const rows = index({ audience: 'patient' });
  assert.ok(!rows.some(r => r.id.startsWith('emr:')));
});

test('the clinician\'s chart labels who filed each upload and drops removed ones', () => {
  const rows = index({});
  const byId = Object.fromEntries(rows.map(r => [r.id, r]));
  assert.strictEqual(byId['upload:u1'].category, 'From the client');
  assert.strictEqual(byId['upload:u2'].category, 'Filed by staff');
  assert.strictEqual(byId['upload:u2'].sharedWithPatient, false);
  assert.strictEqual(byId['upload:u1'].sharedWithPatient, true);
  assert.ok(!byId['upload:u3'], 'a removed upload is not listed');
  assert.ok(byId['emr:e1'], 'the chart still reads OpenEMR');
});

test('an upload filed into OpenEMR is not listed a second time as its OpenEMR copy — unless it was removed', () => {
  const filed = { ...own, emrFiled: { at: 'x' } };
  const rows = repo.buildChartDocumentIndex({
    client: CLIENT, emrReadSupported: true,
    clientUploads: [filed, removed({ ...staff, emrFiled: { at: 'x' } })],
    emrRows: [{ id: 'e1', description: 'licence.png' }, { id: 'e2', description: 'summary.pdf' }, { id: 'e3', description: 'Fax from Dr Lee.pdf' }]
  });
  const ids = rows.map(r => r.id);
  assert.ok(!ids.includes('emr:e1'), 'the auto-filed copy of a live upload is dropped');
  assert.ok(ids.includes('emr:e2'), 'a removed upload\'s OpenEMR copy is still shown: it is still in OpenEMR');
  assert.ok(ids.includes('emr:e3'));
  assert.ok(ids.includes('upload:u1'));
});

test('every category the clinician\'s chart can be handed has a group on the page, or its rows vanish', () => {
  const rows = repo.buildChartDocumentIndex({
    client: { ...CLIENT, carePlanDocs: {} },
    carePlanVersions: [{ client_id: 'c1', version: 1 }],
    roiAuthorizations: [{ id: 'r1', client_id: 'c1' }],
    clientUploads: [own, staff],
    consentDefs: [{ type: 'npp', title: 'NPP' }],
    consentSatisfied: (s) => s === 'signed',
    emrRows: [{ id: 'e1', description: 'x' }]
  });
  const order = (CLINICAL.match(/const order = \[([^\]]*)\]/) || [])[1] || '';
  for (const cat of new Set(rows.map(r => r.category))) {
    assert.ok(order.includes(`'${cat}'`), `the chart page has no group for "${cat}"`);
  }
});

// ── The checklist ────────────────────────────────────────────────────────

const lift = () => {
  const start = SERVER.indexOf('const GFC_EXPECTED_DOCUMENTS = [');
  const end = SERVER.indexOf('app.get(\'/api/gfc/documents\', authenticateToken');
  assert.ok(start > 0 && end > start, 'checklist source not found');
  // eslint-disable-next-line no-new-func
  return new Function('docRules', `${SERVER.slice(start, end)}; return buildDocumentChecklist;`)(docs);
};

test('the patient\'s checklist hides an unshared office file but still counts it, so they are not chased', () => {
  const build = lift();
  const client = { id: 'c1', serviceLine: 'BOTH' };
  const staffRows = build(client, [own, staff], []);
  const patientRows = build(client, [own, staff], [], { audience: 'patient' });
  const rec = (rows) => rows.find(r => r.kind === 'priorRecords');
  assert.strictEqual(rec(staffRows).files.length, 1);
  assert.strictEqual(rec(patientRows).files.length, 0);
  assert.strictEqual(rec(patientRows).status, 'accepted');
  assert.strictEqual(patientRows.find(r => r.kind === 'photoId').files.length, 1);
});

test('a removed upload no longer counts: removing the only one puts the item back on the list', () => {
  const build = lift();
  const rows = build({ id: 'c1', serviceLine: 'PHC' }, [removed(own)], []);
  const photo = rows.find(r => r.kind === 'photoId');
  assert.strictEqual(photo.status, 'missing');
  assert.strictEqual(photo.files.length, 0);
});

// ── Wiring ───────────────────────────────────────────────────────────────

const route = (sig) => {
  const i = SERVER.indexOf(sig);
  assert.ok(i > 0, `route not found: ${sig}`);
  return SERVER.slice(i, SERVER.indexOf('\napp.', i + 10));
};

test('remove is gated admin-or-manager and share is gated at the API, never only in the page', () => {
  assert.match(SERVER, /app\.post\('\/api\/gfc\/admin\/enrollment\/:clientId\/documents\/:uploadId\/remove', authenticateToken, requireDocumentRemover,/);
  assert.match(SERVER, /app\.put\('\/api\/gfc\/admin\/enrollment\/:clientId\/documents\/:uploadId\/share', authenticateToken, requireDocumentSharer,/);
  assert.match(SERVER, /const requireDocumentRemover = [\s\S]{0,80}docRules\.canRemoveDocuments\(req\.user\)/);
});

test('both patient file routes refuse what the patient may not see', () => {
  assert.match(route("app.get('/api/gfc/documents/uploads/:id/file'"), /!docRules\.patientCanSee\(row\)/);
  const chart = route("app.get('/api/gfc/clinical/documents/:docId/file'");
  assert.match(chart, /if \(!row \|\| !docRules\.patientCanSee\(row\)\) return res\.status\(404\)/);
});

test('the patient\'s record asks for the patient audience', () => {
  assert.match(route("app.get('/api/gfc/clinical/documents', authenticateToken"), /audience: 'patient',/);
});

test('staff and clinician reads refuse a removed upload', () => {
  assert.match(route("app.get('/api/gfc/admin/enrollment/:clientId/documents/:uploadId/file'"), /docRules\.isRemoved\(row\)/);
  assert.match(route("app.post('/api/gfc/admin/enrollment/:clientId/documents/:uploadId/review'"), /docRules\.isRemoved\(uploads\[i\]\)/);
  assert.match(route("app.get('/api/clinical/patients/:clientId/documents/:docId/file'"), /docRules\.isRemoved\(row\)/);
  assert.match(SERVER, /u\.status !== 'rejected' && !u\.emrFiled && !docRules\.isRemoved\(u\)/, 'the EMR catch-up pass skips removed uploads');
});

test('the activity log records a removal without its reason text', () => {
  const r = route("app.post('/api/gfc/admin/enrollment/:clientId/documents/:uploadId/remove'");
  const log = r.slice(r.indexOf("'client_document_removed'"), r.indexOf("'client_document_removed'") + 200);
  assert.ok(log.length > 30 && !/reason/.test(log), 'the log entry must not carry the reason');
});

test('the pages ask the server who may remove or share, rather than deciding it', () => {
  assert.match(ENROLL, /access\.canRemove && \(/);
  assert.match(ENROLL, /access\.canShare/);
  assert.match(SERVER, /access: \{ canRemove: docRules\.canRemoveDocuments\(req\.user\), canShare: canShareDocuments\(req\.user\) \}/);
});
