// ============================================================
// The chart's document list
//
// A clinician reviewing a chart could see no documents at all. Probed live on
// OpenEMR 8.4 (2026-09-09): the upload returns 200 with a body of `true` and no
// id; FHIR DocumentReference returns total 0 INSTANCE-WIDE, immediately after a
// successful upload; there is no list route; and read-by-id 500s on a CSRF
// check. OpenEMR takes documents and gives none back.
//
// So the list is assembled from what the app holds and merged with whatever the
// EMR does return. The failures worth guarding are the dishonest ones: a row
// that looks openable and is not, an EMR row silently dropped so the chart reads
// as "no such document", and a rejected upload presented as part of the record.
// ============================================================
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const repo = require('../clinicalRepository');
const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const CLINICAL = fs.readFileSync(path.join(__dirname, '..', 'public', 'clinical.html'), 'utf8');

const CLIENT = {
  id: 'c1', serviceLine: 'BOTH',
  consents: { npp: 'signed', consentToTreat: 'signed_offline', pcaScope: 'pending' },
  consentMeta: { npp: { signedAt: '2026-09-03T10:00:00.000Z' } },
  carePlanCoSign: { v1: { at: '2026-09-04T10:00:00.000Z' } },
  carePlanDocs: { v1: { chartFiled: { emrDocumented: true } } }
};
const build = (over) => repo.buildChartDocumentIndex(Object.assign({
  client: CLIENT,
  emrRows: [],
  carePlanVersions: [{ client_id: 'c1', version: 1, createdAt: '2026-09-02T10:00:00.000Z' }],
  roiAuthorizations: [],
  clientUploads: [],
  consentDefs: [{ type: 'npp', title: 'Notice of Privacy Practices' }, { type: 'consentToTreat', title: 'Consent to Treat' }, { type: 'pcaScope', title: 'PCA Scope' }],
  consentSatisfied: (s) => s === 'signed' || s === 'signed_offline'
}, over || {}));

test('the chart lists what the app holds, not only what the EMR returns', () => {
  // The whole point: OpenEMR returns nothing here, and the chart is still full.
  const rows = build();
  assert.ok(rows.length >= 3, 'care plan + two executed consents at minimum');
  assert.ok(rows.some(r => r.id === 'careplan:1'));
  assert.ok(rows.some(r => r.id === 'consent:npp'));
  assert.ok(rows.every(r => r.source === 'app'));
});

test('an unexecuted consent is not in the chart', () => {
  // pcaScope is pending. A chart must not list a document nobody signed.
  const rows = build();
  assert.ok(!rows.some(r => r.id === 'consent:pcaScope'));
  // A paper signature counts exactly as an in-app one.
  assert.ok(rows.some(r => r.id === 'consent:consentToTreat'));
});

test('every care-plan VERSION is listed, not only the current one', () => {
  // A prior version is the plan that was in force at the time; a reviewer needs
  // it, and keeping only the latest quietly rewrites history.
  const rows = build({
    carePlanVersions: [
      { client_id: 'c1', version: 1, createdAt: '2026-09-02T10:00:00.000Z' },
      { client_id: 'c1', version: 2, createdAt: '2026-09-06T10:00:00.000Z' }
    ]
  });
  assert.ok(rows.some(r => r.id === 'careplan:1'));
  assert.ok(rows.some(r => r.id === 'careplan:2'));
  // And an unsigned version says so rather than reading as executed.
  assert.match(rows.find(r => r.id === 'careplan:2').title, /awaiting co-signature/);
});

test('another client\'s rows never appear', () => {
  const rows = build({
    carePlanVersions: [{ client_id: 'SOMEONE_ELSE', version: 9, createdAt: '2026-09-02T10:00:00.000Z' }],
    clientUploads: [{ id: 'u9', clientId: 'SOMEONE_ELSE', fileName: 'theirs.pdf', status: 'accepted' }]
  });
  assert.ok(!rows.some(r => r.id === 'careplan:9'));
  assert.ok(!rows.some(r => r.id === 'upload:u9'));
});

test('a rejected upload is not part of the record', () => {
  // It is not evidence of anything, and a chart showing it would mislead.
  const rows = build({
    clientUploads: [
      { id: 'ok', clientId: 'c1', fileName: 'id.png', status: 'accepted', uploadedAt: '2026-09-05T10:00:00.000Z' },
      { id: 'bad', clientId: 'c1', fileName: 'blurry.png', status: 'rejected', uploadedAt: '2026-09-05T11:00:00.000Z' }
    ]
  });
  assert.ok(rows.some(r => r.id === 'upload:ok'));
  assert.ok(!rows.some(r => r.id === 'upload:bad'));
  // And the route refuses it too, rather than trusting the list to hide it.
  assert.match(SERVER, /code: 'DOCUMENT_REJECTED'/);
});

test('an EMR row is listed and marked unopenable, never dropped', () => {
  // Dropping it would tell the clinician the document does not exist. It does;
  // this instance just cannot hand it back.
  const rows = build({ emrRows: [{ id: 'x1', description: 'Scanned referral', date: '2026-09-07T10:00:00.000Z' }] });
  const emr = rows.find(r => r.id === 'emr:x1');
  assert.ok(emr, 'the EMR row must be listed');
  assert.equal(emr.openable, false);
  assert.match(emr.note, /OpenEMR/);
  assert.match(SERVER, /code: 'EMR_DOCUMENT_READ_UNAVAILABLE'/);
});

test('a record release with no stored copy is not offered as openable', () => {
  const rows = build({
    roiAuthorizations: [
      { id: 'a1', client_id: 'c1', provider_name: 'Emory', generated_pdf_drive_url: 'https://drive/x' },
      { id: 'a2', client_id: 'c1', provider_name: 'Piedmont', generated_pdf_drive_url: null }
    ]
  });
  assert.equal(rows.find(r => r.id === 'roi:a1').openable, true);
  assert.equal(rows.find(r => r.id === 'roi:a2').openable, false);
  assert.match(rows.find(r => r.id === 'roi:a2').note, /No stored copy/);
});

test('newest first, and an undated row sorts last rather than to 1970', () => {
  const rows = build({
    clientUploads: [{ id: 'u1', clientId: 'c1', fileName: 'no-date.pdf', status: 'accepted', uploadedAt: null }]
  });
  assert.equal(rows[rows.length - 1].id, 'upload:u1');
  const dated = rows.filter(r => r.date).map(r => r.date);
  assert.deepEqual(dated, [...dated].sort((a, b) => String(b).localeCompare(String(a))));
});

test('one route opens every openable row, and it is a clinical read', () => {
  // One composite-id route rather than four parallel ones, so the list and the
  // thing it opens cannot drift apart. Case managers read charts too.
  assert.match(SERVER, /app\.get\('\/api\/clinical\/patients\/:clientId\/documents\/:docId\/file', authenticateToken, requireClinicalRead/);
  for (const kind of ['careplan', 'consent', 'upload', 'roi', 'emr']) {
    assert.ok(SERVER.includes(`if (kind === '${kind}')`), `${kind} must resolve`);
  }
  assert.match(SERVER, /code: 'DOCUMENT_REF_UNKNOWN'/, 'an unknown reference is refused, not guessed at');
});

test('the consent copy comes from the one renderer, not a fourth version', () => {
  const route = SERVER.slice(
    SERVER.indexOf("app.get('/api/clinical/patients/:clientId/documents/:docId/file'"),
    SERVER.indexOf("app.get('/api/clinical/patients/:clientId/chart'")
  );
  assert.match(route, /renderConsentPdf\(client, ref, \{ audience: 'staff' \}\)/);
  assert.ok(!/generateConsentPDF/.test(route), 'the route must not render its own');
});

test('every chart document read is audited', () => {
  assert.match(SERVER, /'chart_document_read'/);
});

test('the chart panel is not wired to the FHIR document read', () => {
  // A panel fed by emr.documents shows an empty chart for a patient whose
  // record is full, because that read returns nothing on this instance.
  assert.match(CLINICAL, /<ChartDocuments docs=\{chart\.chartDocuments \|\| \[\]\}/);
  assert.ok(!/Sec title="Documents"/.test(CLINICAL), 'the old FHIR-fed section must be gone');
  // An unopenable row renders as text with a pointer to OpenEMR, not a link.
  assert.match(CLINICAL, /Open in OpenEMR/);
});
