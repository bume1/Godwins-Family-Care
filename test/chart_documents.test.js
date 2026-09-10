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

// ── The EMR's own documents (Phase 6B patch, 8.4.0-p1) ──────────────
// The one half the app can never know about on its own: a fax, an outside
// record, anything filed straight into OpenEMR. Added after the owner confirmed
// the EMR rebuild path works — the corrected controller deployed on the second
// attempt and code search is live, so a patch route can now be shipped and
// verified rather than shipped and hoped over.

test('the EMR read is feature-detected, never assumed', () => {
  // These routes exist only once the patch is rebuilt and deployed, and the app
  // has to work either side of that.
  const off = repo.buildChartDocumentIndex({
    client: CLIENT, emrRows: [{ id: 7, description: 'Scanned referral' }],
    carePlanVersions: [], roiAuthorizations: [], clientUploads: [],
    consentDefs: [], consentSatisfied: () => false
  });
  assert.equal(off.find(r => r.id === 'emr:7').openable, false);
  assert.match(off.find(r => r.id === 'emr:7').note, /not deployed/);

  const on = repo.buildChartDocumentIndex({
    client: CLIENT, emrReadSupported: true, emrRows: [{ id: 7, description: 'Scanned referral' }],
    carePlanVersions: [], roiAuthorizations: [], clientUploads: [],
    consentDefs: [], consentSatisfied: () => false
  });
  assert.equal(on.find(r => r.id === 'emr:7').openable, true);
  assert.equal(on.find(r => r.id === 'emr:7').note, null);
});

test('"not deployed" and "no documents" are never collapsed', () => {
  // A 404 on the list route means the patch is not deployed. Treating that as
  // an empty patient would show a clinician an empty chart and no reason.
  const oe = fs.readFileSync(path.join(__dirname, '..', 'openemr.js'), 'utf8');
  assert.match(oe, /if \(res\.status === 404\) return \{ supported: false, rows: \[\] \};/);
  assert.match(oe, /async listPatientDocuments\(puuid\)/);
  assert.match(oe, /async getPatientDocument\(puuid, documentId\)/);
  // Keyed by numeric pid, like every other document route on this instance —
  // the standard API coerces a uuid to 0, which orphaned Session 4.1's notes.
  const list = oe.slice(oe.indexOf('async listPatientDocuments(puuid)'));
  assert.match(list, /const pid = await resolvePid\(puuid\);/);
  assert.match(list, /apiUrl\(`patient\/\$\{pid\}\/document`\)/);
});

const PATCH_DIR = path.join(__dirname, '..', 'docs', 'openemr-patches', '8.4.0-p1');
const ROUTES = fs.readFileSync(path.join(PATCH_DIR, 'apis', 'routes', '_rest_routes_gfc.inc.php'), 'utf8');

test('the document routes cost no new OAuth scope, and therefore no new client', () => {
  // OpenEMR derives the required scope from the last non-parameter path
  // segment. A plural /documents would demand `user/documents.read`, which the
  // server does not define — a new registered scope, a new OAuth client and
  // another credential swap in the deployed environment. Every one of those
  // has cost this project days already.
  assert.match(ROUTES, /"GET \/api\/patient\/:pid\/document"/);
  assert.match(ROUTES, /"GET \/api\/patient\/:pid\/document\/:id"/);
  assert.ok(!/\/api\/patient\/:pid\/documents/.test(ROUTES), 'a plural path would need a scope the server does not have');
  // And the scope it does derive is one the app already asks for.
  const scopes = require(path.join(__dirname, '..', 'config.js')).OPENEMR.SCOPES;
  assert.ok(String(scopes).includes('user/document.read'), 'the app must already request the scope these routes derive');
  // Guarded by the ACL the documents screen itself uses.
  assert.match(ROUTES, /request_authorization_check\(\$request, "patients", "docs"\)/);
});

test('the upload route is left to upstream; only the dead read is taken over', () => {
  // The map returns two sets on purpose: additions lose a key collision to
  // upstream, overrides win one. Merging them the same way would silently put
  // GFC routes on top of working upstream ones.
  assert.match(ROUTES, /\$gfcAddedRoutes = \[/);
  assert.match(ROUTES, /\$gfcOverrideRoutes = \[/);
  assert.match(ROUTES, /return \['routes' => \$gfcAddedRoutes, 'overrides' => \$gfcOverrideRoutes\];/);
  // The overrides half holds the document reads and nothing else.
  const overrides = ROUTES.slice(ROUTES.indexOf('$gfcOverrideRoutes = ['));
  const keys = [...overrides.matchAll(/"([A-Z]+ \/api\/[^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(keys, ['GET /api/patient/:pid/document', 'GET /api/patient/:pid/document/:id']);
  // Never the upload. The app depends on it and it works.
  assert.ok(!/"POST \/api\/patient\/:pid\/document"/.test(ROUTES), 'the upload route stays upstream\'s');

  const wrapper = fs.readFileSync(path.join(PATCH_DIR, 'apis', 'routes', '_rest_routes_standard.inc.php'), 'utf8');
  assert.match(wrapper, /array_merge\(\$gfcOurRoutes\['routes'\], \$gfcStandardRoutes, \$gfcOurRoutes\['overrides'\]\)/);
});

test('the build ships and syntax-checks the document controller', () => {
  // The corrected code-search route taught this the hard way: a file that is
  // not in the image is not deployed, however good it is in the repo.
  const dockerfile = fs.readFileSync(path.join(PATCH_DIR, 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /COPY src\/RestControllers\/GfcDocumentRestController\.php/);
  assert.match(dockerfile, /php -l src\/RestControllers\/GfcDocumentRestController\.php/);
});

test('the patch controller cannot return another patient\'s document', () => {
  // The pid is part of the lookup, not decoration.
  const php = fs.readFileSync(path.join(__dirname, '..', 'docs', 'openemr-patches', '8.4.0-p1', 'src', 'RestControllers', 'GfcDocumentRestController.php'), 'utf8');
  assert.match(php, /WHERE id = \? AND foreign_id = \?/);
  // A deleted document is not part of the record.
  assert.match(php, /\(deleted IS NULL OR deleted = 0\)/);
  // An unreadable file is reported, never returned as an empty document — a
  // zero-byte PDF in a chart looks like the record is blank.
  assert.match(php, /could not be read on the server/);
  // readBytes returns null, not '', so the caller can tell an unreadable file
  // from an empty one.
  assert.match(php, /private function readBytes\(int \$id\): \?string/);
  assert.ok(!/return '';/.test(php), "readBytes must never return an empty string for 'unreadable'");
});

test('an EMR document opens through the same one route as everything else', () => {
  const route = SERVER.slice(
    SERVER.indexOf("app.get('/api/clinical/patients/:clientId/documents/:docId/file'"),
    SERVER.indexOf("app.get('/api/clinical/patients/:clientId/chart'")
  );
  assert.match(route, /getPatientDocument\(client\.openEmrPatientId, ref\)/);
  assert.match(route, /code: 'EMR_DOCUMENT_READ_UNAVAILABLE'/);
  assert.match(route, /audit\(`emr_\$\{ref\}`\)/, 'an EMR document read is audited like every other');
});

test('a missing EMR document is not reported as a missing feature', () => {
  // The patch answers "no such document" with a 400 validation message and
  // "no such route" with a 404. Collapsing them would tell a clinician the
  // read is undeployed on an instance where it is running fine — the same
  // mistake as reading an empty code search as an unloaded code set.
  const oe = fs.readFileSync(path.join(__dirname, '..', 'openemr.js'), 'utf8');
  const fn = oe.slice(oe.indexOf('async getPatientDocument(puuid, documentId)'));
  assert.match(fn, /if \(res\.status === 404\) return \{ supported: false, doc: null \};/);
  assert.match(fn, /if \(res\.status === 400\) return \{ supported: true, doc: null \};/);

  const route = SERVER.slice(
    SERVER.indexOf("app.get('/api/clinical/patients/:clientId/documents/:docId/file'"),
    SERVER.indexOf("app.get('/api/clinical/patients/:clientId/chart'")
  );
  assert.match(route, /if \(!read\.supported\)[\s\S]{0,700}EMR_DOCUMENT_READ_UNAVAILABLE/);
  assert.match(route, /if \(!read\.doc\)[\s\S]{0,400}EMR_DOCUMENT_NOT_FOUND/);
});

test('the install checksums match the files actually in the repo', () => {
  // The operator's `sha256sum -c` is the gate that stops a half-fetched patch
  // reaching the EMR. A stale line here stalls a deploy with a checksum
  // mismatch that looks like a tampered file, which is the worst possible way
  // to find out the docs drifted.
  const crypto = require('crypto');
  const install = fs.readFileSync(path.join(PATCH_DIR, 'INSTALL.md'), 'utf8');
  const claimed = [...install.matchAll(/^([0-9a-f]{64})\s+(\S+)$/gm)];
  assert.ok(claimed.length >= 6, 'INSTALL.md must publish a checksum for every patch file');
  const seen = new Set();
  for (const [, sum, file] of claimed) {
    const actual = crypto.createHash('sha256').update(fs.readFileSync(path.join(PATCH_DIR, file))).digest('hex');
    assert.equal(sum, actual, `${file} checksum in INSTALL.md is stale`);
    seen.add(file);
  }
  // And every file the Dockerfile copies is one of them.
  const dockerfile = fs.readFileSync(path.join(PATCH_DIR, 'Dockerfile'), 'utf8');
  for (const m of dockerfile.matchAll(/^COPY (\S+) /gm)) {
    assert.ok(seen.has(m[1]), `${m[1]} is built into the image but has no published checksum`);
  }
});

test('the install guide never treats an unauthenticated 401 as proof a route exists', () => {
  // Verified live 2026-09-10: OpenEMR runs its auth check BEFORE it matches a
  // route, so /apis/default/api/definitely-not-a-real-route answers 401 exactly
  // like a real one. The guide told the operator to read that 401 as "the patch
  // is live", and it reported a rebuild as successful when the new files had
  // never reached the server. The confirmation must read the running container.
  const install = fs.readFileSync(path.join(PATCH_DIR, 'INSTALL.md'), 'utf8');
  for (const claim of [
    /`401` is the right answer\.\*\* It means the route exists/,
    /`401` is the right answer\*\* — the route exists/,
    /401\) echo "PATCH OK/
  ]) {
    assert.ok(!claim.test(install), `INSTALL.md must not claim a 401 proves a route exists: ${claim}`);
  }
  // And it must say so explicitly, so nobody reintroduces the check.
  assert.match(install, /authenticates before it routes/i);
  // The confirmation reads the container, not an HTTP status.
  assert.match(install, /docker compose exec -T openemr sha256sum/);
});

test('SHA256SUMS matches the files, and covers everything the build copies', () => {
  // The manifest is what deploy.sh verifies against before it touches the
  // server. A stale line here stops a real deploy; a missing one lets an
  // unverified file through.
  const crypto = require('crypto');
  const manifest = fs.readFileSync(path.join(PATCH_DIR, 'SHA256SUMS'), 'utf8');
  const listed = new Set();
  for (const line of manifest.trim().split('\n')) {
    const [sum, file] = line.split(/\s+/);
    const actual = crypto.createHash('sha256').update(fs.readFileSync(path.join(PATCH_DIR, file))).digest('hex');
    assert.equal(sum, actual, `${file} is stale in SHA256SUMS`);
    listed.add(file);
  }
  const dockerfile = fs.readFileSync(path.join(PATCH_DIR, 'Dockerfile'), 'utf8');
  for (const m of dockerfile.matchAll(/^COPY (\S+) /gm)) {
    assert.ok(listed.has(m[1]), `${m[1]} is built into the image but is not in SHA256SUMS`);
  }
  assert.ok(listed.has('Dockerfile'), 'the Dockerfile itself must be verifiable');
});

test('deploy.sh verifies before it builds, and proves the build inside the container', () => {
  // The ordering IS the guarantee. Verifying after the build would let a failed
  // fetch reach a rebuild, which is the exact silent no-op this replaces.
  const sh = fs.readFileSync(path.join(PATCH_DIR, 'deploy.sh'), 'utf8');
  assert.match(sh, /^set -eu$/m, 'must stop at the first failure');
  const verifyAt = sh.indexOf('sha256sum -c SHA256SUMS');
  const buildAt = sh.indexOf('docker compose build');
  assert.ok(verifyAt > -1 && buildAt > -1, 'must both verify and build');
  assert.ok(verifyAt < buildAt, 'the checksum verification must come BEFORE the build');
  // Fetch by immutable commit sha, never by branch name: raw.githubusercontent
  // negatively caches a newly added path for minutes (measured 2026-09-10).
  assert.match(sh, /api\.github\.com\/repos\/\$REPO\/commits\/\$BRANCH/);
  assert.match(sh, /BASE="https:\/\/raw\.githubusercontent\.com\/\$REPO\/\$SHA\//);
  // The proof is the container's own bytes, not an HTTP status.
  assert.match(sh, /docker compose exec -T openemr sha256sum/);
  assert.ok(!/%\{http_code\}/.test(sh), 'must not verify a deploy with an HTTP status code');
  // And the preserved upstream route map, without which the wrapper throws.
  assert.match(sh, /_rest_routes_standard\.upstream\.inc\.php/);
});

test('the install guide leads with the script that cannot skip a step', () => {
  const install = fs.readFileSync(path.join(PATCH_DIR, 'INSTALL.md'), 'utf8');
  assert.match(install, /deploy\.sh/);
  assert.ok(install.indexOf('deploy.sh') < install.indexOf('## Step 1'),
    'the one-paste path must come before the manual steps');
  // The raw-CDN cache is why a fetch can fail for no visible reason.
  assert.match(install, /negatively\s+caches/i);
});
