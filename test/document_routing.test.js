// test/document_routing.test.js — a client-uploaded document, routed
// elsewhere (2026-09-24, owner-directed).
//
// Two gaps: a document a client sent (an ID, an insurance card, records
// mailed or emailed in) never reached the patient's own OpenEMR chart — a
// care plan and a signed consent each had their own path in; a client
// upload did not. And a document that turns out to be about a CAREGIVER,
// not the client, had no way to reach the caregiver's own document store —
// the two stores are entirely separate.
//
// FILING TO EMR IS AUTOMATIC, NOT A BUTTON (owner correction, same day:
// "no file to open emr button. documents should automatically file to open
// emr every time"). The first version of this shipped as a manual action on
// both the enrollment screen and the clinical chart; it was wrong. There is
// no file-to-emr ROUTE any more — `attemptEmrFiling` is called from every
// place a document is stored (the client's own upload, the staff-filed
// upload, the no-login link) plus a catch-up pass at the moment a patient is
// linked, for anything uploaded before the chart existed.
//
// The live, end-to-end proof (upload → filed automatically, no second call →
// idempotent on a re-run → a rejected document never filed → the link-time
// catch-up pass files what arrived early → move to caregiver → lands in the
// caregiver's own store → the original is never destroyed) is
// `scripts/verify_document_routing.js`, through the real HTTP routes. What
// is guarded here is the pure logic and the structural invariants a live run
// cannot cheaply repeat on every commit.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const clinicalRepo = require('../clinicalRepository');
const root = path.join(__dirname, '..');
const SERVER = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

// `categoryForDocumentKind` is not exported (requiring server.js boots a
// server), so it is lifted out by source and RUN — the technique the
// welcome-email and getAppBaseUrl guards use. Reading the source would only
// prove the mapping is present somewhere; running it proves what a real
// call would actually send to OpenEMR.
function loadCategoryForDocumentKind() {
  const from = SERVER.indexOf('const CATEGORY_BY_DOCUMENT_KIND');
  const to = SERVER.indexOf('// A document belongs to a visit or to the client');
  assert.ok(from !== -1 && to > from, 'could not lift categoryForDocumentKind out of server.js');
  // eslint-disable-next-line no-new-func
  return new Function(`${SERVER.slice(from, to)}\nreturn categoryForDocumentKind;`)();
}

// ── the category mapping ────────────────────────────────────────────────

test('a referral files under /Consult', () => {
  assert.strictEqual(loadCategoryForDocumentKind()('referral'), '/Consult');
});

test('a physician order files under /Orders', () => {
  assert.strictEqual(loadCategoryForDocumentKind()('physicianOrder'), '/Orders');
});

test('an unmapped kind defaults to /Medical Record — never an invented folder', () => {
  const categoryFor = loadCategoryForDocumentKind();
  for (const kind of ['photoId', 'insuranceCard', 'poaGuardianship', 'advanceDirective',
    'otherDocument', 'dnrPolst', 'medicationList', 'priorRecords', 'made_up_kind', '', null, undefined]) {
    assert.strictEqual(categoryFor(kind), '/Medical Record', `${kind} did not default`);
  }
});

// ── the chart's "In EMR" chip is a real fact, not a permanent placeholder ──

test('an upload with no emrFiled record reads as NOT in the EMR chart', () => {
  const client = { id: 'c1' };
  const idx = clinicalRepo.buildChartDocumentIndex({
    client, clientUploads: [{ id: 'u1', clientId: 'c1', status: 'accepted', fileName: 'x.pdf' }]
  });
  const row = idx.find(r => r.id === 'upload:u1');
  assert.strictEqual(row.inChart, false);
});

test('once filed, the SAME upload row reads as in the EMR chart — no second flag to keep in sync', () => {
  const client = { id: 'c1' };
  const idx = clinicalRepo.buildChartDocumentIndex({
    client,
    clientUploads: [{
      id: 'u1', clientId: 'c1', status: 'accepted', fileName: 'x.pdf',
      emrFiled: { at: '2026-09-24T00:00:00.000Z', byId: 'staff1', byName: 'Staff One', category: '/Medical Record' }
    }]
  });
  const row = idx.find(r => r.id === 'upload:u1');
  assert.strictEqual(row.inChart, true);
});

test('a rejected upload never reaches the chart at all, filed or not', () => {
  const client = { id: 'c1' };
  const idx = clinicalRepo.buildChartDocumentIndex({
    client,
    clientUploads: [{
      id: 'u1', clientId: 'c1', status: 'rejected', fileName: 'x.pdf',
      emrFiled: { at: '2026-09-24T00:00:00.000Z' }
    }]
  });
  assert.strictEqual(idx.find(r => r.id === 'upload:u1'), undefined,
    'a rejected document must not appear in the chart even if it was somehow marked filed');
});

// ── the checklist carries the additive facts, not just status ─────────────

test('buildDocumentChecklist surfaces emrFiled and movedTo on each file row', () => {
  assert.match(SERVER, /emrFiled: u\.emrFiled \|\| null,\s*\n\s*movedTo: u\.movedTo \|\| null/,
    'the checklist rows must carry both additive facts, or the admin screen has nothing to render a status from');
});

// ── there is no button, there is no route ──────────────────────────────────

test('file-to-emr has NO route — filing is automatic, never a manual action', () => {
  assert.ok(!/\/documents\/:docId\/file-to-emr/.test(SERVER),
    'a file-to-emr route reappearing means the manual button is back, which the owner explicitly ruled out');
});

test('neither edited page still calls a file-to-emr endpoint or renders a File to OpenEMR control', () => {
  const ADMIN = fs.readFileSync(path.join(root, 'public', 'admin-enrollment.html'), 'utf8');
  const CLINICAL = fs.readFileSync(path.join(root, 'public', 'clinical.html'), 'utf8');
  for (const [name, src] of [['admin-enrollment.html', ADMIN], ['clinical.html', CLINICAL]]) {
    assert.ok(!/file-to-emr/.test(src), `${name} still references a file-to-emr endpoint`);
    assert.ok(!/File to OpenEMR/.test(src), `${name} still renders a manual filing button`);
  }
});

test('move-to-caregiver is admin-only, on the enrollment screen only — the owner\'s explicit ask, and it is a separate decision automatic filing never touches', () => {
  assert.match(SERVER, /app\.post\('\/api\/gfc\/admin\/enrollment\/:clientId\/documents\/:docId\/move-to-caregiver',\s*authenticateToken,\s*requireAdmin,\s*moveDocumentToCaregiverHandler\)/);
  assert.ok(!/\/api\/clinical\/patients\/:clientId\/documents\/:docId\/move-to-caregiver/.test(SERVER),
    'move-to-caregiver must not gain a second door from the clinical chart');
});

test('the caregiver picker list is a READ, open to every enrollment-staff role — narrowing writes must not take the view away', () => {
  assert.match(SERVER, /app\.get\('\/api\/gfc\/admin\/enrollment\/meta\/caregivers',\s*authenticateToken,\s*requireEnrollmentStaff,/);
});

test('the caregiver picker sits under meta/, not a bare single segment — the exact collision meta/consent-registry already avoids', () => {
  // Express matches in registration order; GET …/enrollment/:clientId is
  // registered earlier and a single-segment literal after it is dead code,
  // read as a client id instead. Both known reference-data reads must live
  // under the two-segment meta/ path for the same reason.
  assert.ok(!/app\.get\('\/api\/gfc\/admin\/enrollment\/caregivers'/.test(SERVER),
    'a bare single-segment /enrollment/caregivers would collide with the :clientId route and never be reached');
});

// ── attemptEmrFiling: the ONE place filing actually happens ────────────────

function loadAttemptEmrFilingSource() {
  const from = SERVER.indexOf('const attemptEmrFiling = async');
  const to = SERVER.indexOf('// The catch-up pass.');
  assert.ok(from !== -1 && to > from, 'could not find attemptEmrFiling in server.js');
  return SERVER.slice(from, to);
}

test('filing twice is refused by name — ALREADY_FILED, before the second Drive read or EMR call is ever made', () => {
  const body = loadAttemptEmrFilingSource();
  const already = body.indexOf("row.emrFiled) return { filed: false, reason: 'ALREADY_FILED'");
  const download = body.indexOf('googledrive.downloadFileBuffer');
  assert.ok(already !== -1, 'the ALREADY_FILED guard is missing');
  assert.ok(already < download, 'ALREADY_FILED must be checked before touching Drive, or a re-file re-downloads for nothing');
});

test('a rejected document is refused before a not-linked or already-filed client is even considered', () => {
  const body = loadAttemptEmrFilingSource();
  const rejected = body.indexOf("row.status === 'rejected') return { filed: false, reason: 'DOCUMENT_REJECTED' }");
  assert.ok(rejected !== -1 && rejected < body.indexOf('NOT_LINKED'),
    'a rejected document must never be filed regardless of link state');
});

test('an unlinked client is refused, not attempted and silently swallowed', () => {
  assert.match(loadAttemptEmrFilingSource(), /!client\.openEmrPatientId\) return \{ filed: false, reason: 'NOT_LINKED' \}/);
});

test('attemptEmrFiling never throws out of its own catch blocks — a Drive or EMR failure returns a reason, it does not propagate', () => {
  const body = loadAttemptEmrFilingSource();
  assert.match(body, /catch \(e\) \{\s*\n\s*console\.error\('\[AUTO FILE-TO-EMR\] could not read the document back from storage:'[\s\S]{0,80}return \{ filed: false, reason: 'DOCUMENT_UNREADABLE' \}/);
  assert.match(body, /catch \(e\) \{\s*\n\s*console\.error\('\[AUTO FILE-TO-EMR\] OpenEMR refused the document:'[\s\S]{0,80}return \{ filed: false, reason: 'EMR_UPLOAD_FAILED' \}/);
});

// ── every upload site calls it automatically — no site left as a silent gap ──

test('attemptEmrFiling is called, unconditionally, from all three places a document is stored', () => {
  // Anchored on `await attemptEmrFiling({` as a real statement, not a mention
  // in a comment — a source scan that cannot tell live code from prose about
  // that code proves nothing, the fifth-plus time this repo has paid for it.
  const matches = SERVER.match(/\n\s*const emrFiling = await attemptEmrFiling\(\{/g) || [];
  assert.strictEqual(matches.length, 3,
    `expected 3 call sites (client upload, staff upload, link upload), found ${matches.length}`);
});

test('the client upload response reports emrFiling — the screen can show the outcome, never has to guess', () => {
  assert.match(SERVER, /message: 'Document received', emrFiling,/);
});

test('the staff-filed response reports emrFiling BEFORE the checklist is re-read, so the returned checklist already reflects it', () => {
  const idx = SERVER.indexOf('client_document_filed_by_staff');
  const emrCall = SERVER.indexOf('const emrFiling = await attemptEmrFiling', idx);
  const checklistRead = SERVER.indexOf("db.get('client_document_uploads'), db.get('client_document_requests')", idx);
  assert.ok(idx !== -1 && emrCall !== -1 && checklistRead !== -1 && emrCall < checklistRead,
    'attemptEmrFiling must run before the checklist re-read, or the response is stale');
});

test('the link-only route\'s upload has no signed-in actor, so it files under the CLIENT, not a null or synthetic id', () => {
  assert.match(SERVER, /attemptEmrFiling\(\{ client, row, actor: \{ id: client\.id, name: client\.name \|\| client\.email \} \}\)/);
});

// ── the catch-up pass: a document uploaded before the chart existed ────────

test('the link route runs a catch-up pass for documents uploaded before the chart existed, right after the care-plan backfill it already mirrors', () => {
  const carePlanIdx = SERVER.indexOf("fileCarePlanToChart(client.id, req.user, 'patient_linked')");
  const backfillIdx = SERVER.indexOf('backfillEmrFilingForClient(client.id, req.user)');
  assert.ok(carePlanIdx !== -1 && backfillIdx !== -1 && backfillIdx > carePlanIdx,
    'the document catch-up pass must run at link time, alongside the care-plan backfill it mirrors');
});

test('backfillEmrFilingForClient only considers rows with no emrFiled that are not rejected — never re-files or resurrects a rejection', () => {
  const from = SERVER.indexOf('const backfillEmrFilingForClient');
  const to = SERVER.indexOf('// POST …/documents/:docId/move-to-caregiver');
  assert.ok(from !== -1 && to > from);
  assert.match(SERVER.slice(from, to), /u\.status !== 'rejected' && !u\.emrFiled/);
});

test('backfillEmrFilingForClient runs sequentially, not Promise.all — a concurrent read-modify-write on client_document_uploads would drop writes', () => {
  const from = SERVER.indexOf('const backfillEmrFilingForClient');
  const to = SERVER.indexOf('// POST …/documents/:docId/move-to-caregiver');
  const body = SERVER.slice(from, to);
  assert.match(body, /for \(const row of candidates\) \{\s*\n\s*const result = await attemptEmrFiling/);
  assert.ok(!/Promise\.all/.test(body), 'a concurrent backfill can lose writes on the shared uploads array');
});

// ── moving twice is refused, and a move is a copy, not a relocation ────────

test('moving twice is refused by name — ALREADY_MOVED, not a second copy in the caregiver store', () => {
  assert.match(SERVER, /if \(row\.movedTo\) \{\s*\n\s*return res\.status\(409\)\.json\(\{ error: `Already filed under/);
});

test('a rejected document cannot be moved to a caregiver', () => {
  const from = SERVER.indexOf('const moveDocumentToCaregiverHandler');
  const to = SERVER.indexOf('// file-to-emr has NO ROUTE');
  assert.ok(from !== -1 && to > from);
  assert.match(SERVER.slice(from, to), /row\.status === 'rejected'[\s\S]{0,200}DOCUMENT_REJECTED/);
});

test('moving to a caregiver never deletes or rewrites the client\'s own upload row — only an ADDITIVE movedTo pointer', () => {
  const from = SERVER.indexOf('const moveDocumentToCaregiverHandler');
  const to = SERVER.indexOf('// file-to-emr has NO ROUTE');
  const body = SERVER.slice(from, to);
  assert.ok(!/uploads\.splice|\.filter\(u => u\.id !== row\.id\)/.test(body),
    'the original client_document_uploads row must never be removed by a move');
  assert.match(body, /movedTo: \{/, 'the row must gain a movedTo pointer');
});
