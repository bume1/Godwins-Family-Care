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
// The live, end-to-end proof (upload → file to EMR → idempotent re-file
// refused → move to caregiver → lands in the caregiver's own store → the
// original is never destroyed) is `scripts/verify_document_routing.js`,
// 37/37 through the real HTTP routes. What is guarded here is the pure
// logic and the structural invariants a live run cannot cheaply repeat on
// every commit.
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

// ── route wiring: two doors onto file-to-emr, one onto move ───────────────

test('file-to-emr is reachable from BOTH the enrollment screen and the clinical chart, one handler', () => {
  assert.match(SERVER, /app\.post\('\/api\/gfc\/admin\/enrollment\/:clientId\/documents\/:docId\/file-to-emr',\s*authenticateToken,\s*requireEnrollmentEditor,\s*fileDocumentToEmrHandler\)/);
  assert.match(SERVER, /app\.post\('\/api\/clinical\/patients\/:clientId\/documents\/:docId\/file-to-emr',\s*authenticateToken,\s*requireClinicalWrite,\s*requireClinicalOnLine,\s*fileDocumentToEmrHandler\)/);
});

test('move-to-caregiver is admin-only, on the enrollment screen only — the owner\'s explicit ask', () => {
  assert.match(SERVER, /app\.post\('\/api\/gfc\/admin\/enrollment\/:clientId\/documents\/:docId\/move-to-caregiver',\s*authenticateToken,\s*requireAdmin,\s*moveDocumentToCaregiverHandler\)/);
  // And it must not also be reachable from the clinical chart under any name —
  // a second door onto "whose record this belongs to" is how the enrollment
  // screen and the chart start disagreeing about who decided it.
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

// ── idempotency: refused BEFORE the second write, not silently no-op'd ────

test('filing twice is refused by name — ALREADY_FILED, not a quiet no-op or a duplicate', () => {
  assert.match(SERVER, /if \(row\.emrFiled\) \{\s*\n\s*return res\.status\(409\)\.json\(\{ error: 'Already filed to the OpenEMR chart\.', code: 'ALREADY_FILED'/);
});

test('moving twice is refused by name — ALREADY_MOVED, not a second copy in the caregiver store', () => {
  assert.match(SERVER, /if \(row\.movedTo\) \{\s*\n\s*return res\.status\(409\)\.json\(\{ error: `Already filed under/);
});

// ── a rejected document is off-limits to both actions ──────────────────────

test('a rejected document cannot be filed to EMR', () => {
  const from = SERVER.indexOf('const fileDocumentToEmrHandler');
  const to = SERVER.indexOf('const moveDocumentToCaregiverHandler');
  assert.ok(from !== -1 && to > from);
  assert.match(SERVER.slice(from, to), /row\.status === 'rejected'[\s\S]{0,200}DOCUMENT_REJECTED/);
});

test('a rejected document cannot be moved to a caregiver', () => {
  const from = SERVER.indexOf('const moveDocumentToCaregiverHandler');
  const to = SERVER.indexOf("app.post('/api/gfc/admin/enrollment/:clientId/documents/:docId/file-to-emr'");
  assert.ok(from !== -1 && to > from);
  assert.match(SERVER.slice(from, to), /row\.status === 'rejected'[\s\S]{0,200}DOCUMENT_REJECTED/);
});

// ── a move is a COPY with a cross-reference, never a delete ────────────────

test('moving to a caregiver never deletes or rewrites the client\'s own upload row — only an ADDITIVE movedTo pointer', () => {
  const from = SERVER.indexOf('const moveDocumentToCaregiverHandler');
  const to = SERVER.indexOf("app.post('/api/gfc/admin/enrollment/:clientId/documents/:docId/file-to-emr'");
  const body = SERVER.slice(from, to);
  assert.ok(!/uploads\.splice|\.filter\(u => u\.id !== row\.id\)/.test(body),
    'the original client_document_uploads row must never be removed by a move');
  assert.match(body, /movedTo: \{/, 'the row must gain a movedTo pointer');
});
