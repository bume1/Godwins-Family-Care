// test/document_reading_surfaces.test.js — reading a document from the CHART
// as well as from enrollment (2026-09-23, owner-directed follow-up).
//
// The rules that make reading safe were built in 4.9b and extended without a
// model on 2026-09-23. NONE of them are specific to a surface: buildProposals
// takes a plain { path: value } map. So a second surface must reuse the
// handlers rather than grow a second copy of what an extraction is.
//
// MUTATION-CHECKED. Comments are stripped before every source scan — a scan
// that cannot tell live code from prose about that code proves nothing, which
// this repo has now paid for six times.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const repo = require('../clinicalRepository');

const root = path.join(__dirname, '..');

const stripComments = (src) => src
  .replace(/^[ \t]*\/\/.*$/gm, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

const strippedSafely = (src, label) => {
  const out = stripComments(src);
  assert.ok(1 - out.length / src.length < 0.45,
    `stripComments removed too much of ${label} — it has swallowed code`);
  return out;
};

const serverCode = strippedSafely(fs.readFileSync(path.join(root, 'server.js'), 'utf8'), 'server.js');
const pageCode = strippedSafely(fs.readFileSync(path.join(root, 'public/clinical.html'), 'utf8'), 'clinical.html');

// ===========================================================================
// 1. ONE implementation, registered twice
// ===========================================================================

test('both surfaces share the SAME three handlers', () => {
  // What an extraction is — the allow-list, the identity-conflict guard, the
  // stale-field refusal, the staff-verified provenance, the review ledger —
  // has exactly one implementation. A second surface must not grow a copy.
  ['extractionStatusHandler', 'extractDocumentHandler', 'extractionReviewHandler'].forEach(h => {
    const declarations = (serverCode.match(new RegExp(`const ${h} = `, 'g')) || []).length;
    assert.strictEqual(declarations, 1, `${h} must be declared exactly once`);
    const uses = (serverCode.match(new RegExp(`\\b${h}\\b`, 'g')) || []).length;
    assert.ok(uses >= 3, `${h} must be registered on both surfaces, saw ${uses} mentions`);
  });
});

test('the clinical routes are registered, and each on the right gate', () => {
  const rows = [
    [`app.get('/api/clinical/patients/:clientId/extraction'`, 'requireClinicalRead', 'extractionStatusHandler'],
    [`app.post('/api/clinical/patients/:clientId/documents/:docId/extract'`, 'requireClinicalWrite', 'extractDocumentHandler'],
    [`app.post('/api/clinical/patients/:clientId/extraction/:id/review'`, 'requireClinicalWrite', 'extractionReviewHandler']
  ];
  rows.forEach(([route, gate, handler]) => {
    const i = serverCode.indexOf(route);
    assert.ok(i > 0, `not registered: ${route}`);
    const line = serverCode.slice(i, serverCode.indexOf('\n', i));
    assert.ok(line.includes(gate), `${route} must be gated on ${gate}: ${line}`);
    assert.ok(line.includes(handler), `${route} must use the shared ${handler}`);
    assert.ok(line.includes('requireClinicalOnLine'),
      `${route} must refuse a patient who is not on a clinical service line`);
  });
});

test('READING is a write and STATUS is a read, on both surfaces', () => {
  // A case manager sees what is waiting without being able to approve any of
  // it — the 4.3 split, unchanged by adding a surface.
  const statusLine = (needle) => serverCode.slice(serverCode.indexOf(needle), serverCode.indexOf('\n', serverCode.indexOf(needle)));
  assert.match(statusLine(`app.get('/api/clinical/patients/:clientId/extraction'`), /requireClinicalRead/);
  assert.match(statusLine(`app.get('/api/gfc/admin/enrollment/:clientId/extraction'`), /requireEnrollmentStaff/);
  // And the two that change a record are not on a read gate.
  [`app.post('/api/clinical/patients/:clientId/documents/:docId/extract'`,
    `app.post('/api/clinical/patients/:clientId/extraction/:id/review'`].forEach(r => {
    assert.ok(!/requireClinicalRead[,)]/.test(statusLine(r)), `${r} must not sit on the read gate`);
  });
  [`app.post('/api/gfc/admin/enrollment/:clientId/documents/:docId/extract'`,
    `app.post('/api/gfc/admin/enrollment/:clientId/extraction/:id/review'`].forEach(r => {
    assert.match(statusLine(r), /requireEnrollmentEditor/);
  });
});

test('a client reaches NONE of the six routes', () => {
  // A proposal is a change to a client's own record and the entire design is
  // that somebody other than the subject approves it. The client's own upload
  // is read by STAFF, from the list it already appears on.
  const clientReachable = /\/api\/gfc\/(me|portal|consents|intake|documents)/;
  ['/api/clinical/patients/:clientId/extraction',
    '/api/clinical/patients/:clientId/documents/:docId/extract',
    '/api/gfc/admin/enrollment/:clientId/documents/:docId/extract'].forEach(r => {
    assert.ok(!clientReachable.test(r), `${r} must not sit on a client-facing prefix`);
  });
  // No extraction route may carry the client-intake gate.
  const extractionRoutes = serverCode.split('\n').filter(l => /app\.(get|post)\('[^']*extract/.test(l));
  assert.ok(extractionRoutes.length >= 4, `expected the extraction routes, found ${extractionRoutes.length}`);
  extractionRoutes.forEach(l => {
    assert.ok(!/requireClientForIntake|requireEnrolledClient/.test(l),
      `a client must not be able to read a document into proposals: ${l}`);
  });
});

test('the clinical routes refuse a patient who is not on a clinical line', () => {
  // Otherwise they are a side door onto a home-care-only client's record.
  const i = serverCode.indexOf('const requireClinicalOnLine');
  assert.ok(i > 0, 'the gate is not defined');
  const body = serverCode.slice(i, serverCode.indexOf('\n};', i));
  assert.match(body, /loadClinicalClient\(req\.params\.clientId\)/);
  assert.match(body, /NOT_CLINICAL_LINE/);
  assert.match(body, /wrongLine \? 409 : 404/);
});

// ===========================================================================
// 2. What the chart offers to read
// ===========================================================================

test('only an UPLOAD carries what a read needs', () => {
  // A consent, a care plan and a record release are documents this app
  // GENERATED from the record, so reading them back would propose the record
  // to itself.
  const index = repo.buildChartDocumentIndex({
    client: {
      id: 'c1', carePlan: { version: 1 },
      // The care plan store keys on `client_id`, and the consent rows are
      // driven off the client's own consent map — the first version of this
      // fixture used `clientId` and declared no consents, so it produced ONE
      // row and had no generated document to check at all. Two mutations that
      // handed a care plan and a consent an upload id walked straight through
      // it. A fixture that cannot produce the thing it forbids proves nothing.
      consents: { npp: 'signed' },
      consentMeta: { npp: { signedAt: '2026-09-01' } }
    },
    emrReadSupported: false, emrRows: [],
    carePlanVersions: [{ client_id: 'c1', version: 1, createdAt: '2026-09-01' }],
    roiAuthorizations: [],
    clientUploads: [{
      id: 'u1', clientId: 'c1', fileName: 'card.pdf', kind: 'insuranceCard',
      status: 'received', source: 'client', uploadedAt: '2026-09-23'
    }],
    consentDefs: [{ type: 'npp', title: 'Notice of Privacy Practices' }],
    consentSatisfied: (st) => st === 'signed'
  });
  const upload = index.find(d => String(d.id).startsWith('upload:'));
  assert.ok(upload, 'the upload is on the chart');
  assert.strictEqual(upload.uploadId, 'u1');
  assert.strictEqual(upload.kind, 'insuranceCard');

  const generated = index.filter(d => !String(d.id).startsWith('upload:'));
  assert.ok(generated.length >= 2,
    `this fixture must produce generated rows to forbid, saw ${JSON.stringify(index.map(d => d.id))}`);
  assert.ok(generated.some(d => String(d.id).startsWith('careplan:')), 'a care plan row');
  assert.ok(generated.some(d => String(d.id).startsWith('consent:')), 'a consent row');
  generated.forEach(d => {
    assert.strictEqual(d.uploadId, undefined, `${d.id} must not offer an upload id`);
  });
});

test('a chart row says WHO filed the document', () => {
  // A reviewer weighs a document the client sent differently from one the
  // office scanned in.
  const mk = (source) => repo.buildChartDocumentIndex({
    client: { id: 'c1' }, emrReadSupported: false, emrRows: [],
    carePlanVersions: [], roiAuthorizations: [],
    clientUploads: [{ id: 'u1', clientId: 'c1', fileName: 'f.pdf', kind: 'referral', status: 'received', source, uploadedAt: '2026-09-23' }],
    consentDefs: [], consentSatisfied: () => false
  }).find(d => String(d.id).startsWith('upload:'));
  assert.strictEqual(mk('client').filedBy, 'client');
  assert.strictEqual(mk('staff').filedBy, 'staff');
  // An older row with no source recorded is the client's — that is who the
  // only writer was before staff filing existed.
  assert.strictEqual(mk(undefined).filedBy, 'client');
});

test('a rejected document never reaches the chart, so nothing offers to read it', () => {
  const index = repo.buildChartDocumentIndex({
    client: { id: 'c1' }, emrReadSupported: false, emrRows: [],
    carePlanVersions: [], roiAuthorizations: [],
    clientUploads: [{ id: 'u1', clientId: 'c1', fileName: 'bad.pdf', kind: 'referral', status: 'rejected', source: 'client', uploadedAt: '2026-09-23' }],
    consentDefs: [], consentSatisfied: () => false
  });
  assert.strictEqual(index.filter(d => String(d.id).startsWith('upload:')).length, 0);
});

test('the page decides no readable kind of its own', () => {
  // Served, so the control cannot drift from the module that refuses a kind.
  assert.match(pageCode, /status\.extractableKinds \|\| \[\]\)\.includes\(doc\.kind\)/);
  // SCOPED TO THE COMPONENT, not the file. `referral` is also a 4.10 ORDER
  // type, and the page names that one legitimately in four places — a
  // whole-file scan failed on a different vocabulary that happens to share a
  // word. A guard must be pointed at its own subject.
  const i = pageCode.indexOf('const ChartReadButton');
  assert.ok(i > 0, 'ChartReadButton not found');
  const body = pageCode.slice(i, pageCode.indexOf('\n    const ChartDocuments', i));
  assert.ok(!/orderType/.test(body), 'this slice must be the read control, not an orders list');
  ['insuranceCard', 'referral', 'physicianOrder', 'consentPacket'].forEach(k => {
    assert.ok(!body.includes(`'${k}'`) && !body.includes(`"${k}"`),
      `the read control must not name the extractable kind ${k}`);
  });
});

test('the chart offers no read control to a reader', () => {
  const i = pageCode.indexOf('const ChartReadButton');
  const body = pageCode.slice(i, pageCode.indexOf('\n    const ChartDocuments', i));
  assert.match(body, /if \(!access\.canWrite/, 'a case manager may look, not read');
  assert.match(body, /!doc\.uploadId/, 'only an upload can be read');
  assert.match(body, /Reading not switched on/, '"off" and "nothing to read" are different facts');
});

test('the chart review carries the same three warnings the staff one does', () => {
  const i = pageCode.indexOf('const ChartExtractionReview');
  const body = pageCode.slice(i, pageCode.indexOf('\n    const ChartReadButton', i));
  assert.match(body, /Nothing here has been saved/, 'the sentence that makes it safe to use');
  assert.match(body, /Read from a picture/, 'an OCR read is weaker evidence and must say so');
  assert.match(body, /may not be about this patient/, 'the identity conflict is surfaced');
  assert.match(body, /still to decide/, 'a half-decided review cannot be saved');
  assert.match(body, /disabled=\{busy \|\| undecided > 0\}/);
});

test('the chart review posts to the CLINICAL routes, not the enrollment ones', () => {
  assert.match(pageCode, /\/api\/clinical\/patients\/\$\{id\}\/extraction/);
  assert.match(pageCode, /\/api\/clinical\/patients\/\$\{id\}\/documents\/\$\{encodeURIComponent\(docId\)\}\/extract/);
  assert.ok(!/\/api\/gfc\/admin\/enrollment\/[^`'"]*extract/.test(pageCode),
    'the chart must not reach the enrollment gate');
});
