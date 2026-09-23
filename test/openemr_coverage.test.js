// Session 4.12 Scope J — the coverage catalog, and the build-fail on an
// untriaged capability.
//
// WHY THESE GUARDS. Five sessions hit the same wall from different directions:
// a capability that looked wired and was not. A document upload returning
// `true`. An allergy route answering 200 with `data: []`. A narrowed OAuth
// token behind a green "OpenEMR connected". `acknowledgeAbnormalResult` with
// no route for two sessions. Each was invisible because nothing said in ONE
// place what had been proven as distinct from what had merely been written.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const root = path.join(__dirname, '..');
const coverage = require('../openemrCoverage');
const transport = fs.readFileSync(path.join(root, 'openemr.js'), 'utf8');

test('every FHIR resource the transport calls is triaged in the catalog', () => {
  // THE BUILD FAILS ON AN UNTRIAGED CAPABILITY, because that is exactly the
  // one that turns out not to work — nobody has looked at it.
  assert.deepEqual(coverage.untriaged(transport), [],
    'a FHIR resource is called with no row in openemrCoverage.js — classify it live / wired_unproven / not_wired');
  // The detector must actually be able to see a resource, or it would report
  // a clean sheet for a transport that calls nothing it knows.
  const found = coverage.untriaged("fhirGet(`Nonsense?patient=${x}`, 'Nonsense', p)");
  assert.deepEqual(found, ['Nonsense'], 'precondition: the detector finds an unclassified resource');
});

test('every row carries a status from the enum and a note somebody can act on', () => {
  assert.deepEqual(coverage.malformed(), [],
    'a row with no status, no kind or no note tells nobody anything');
  // The detector must be GIVEN something to find, or an empty result from a
  // clean catalog says nothing about whether it still checks anything. This
  // survived its first mutation for exactly that reason.
  assert.deepEqual(coverage.malformed([
    { resource: 'NoStatus', kind: 'read', status: 'probably_fine', note: 'a real note' },
    { resource: 'NoNote', kind: 'read', status: 'live', note: '   ' },
    { resource: 'NoKind', status: 'live', note: 'a real note' },
    { kind: 'read', status: 'live', note: 'a real note' },
    { resource: 'Fine', kind: 'read', status: 'live', note: 'a real note' }
  ]), ['NoStatus', 'NoNote', 'NoKind', '(no resource)'],
    'each way a row can be useless must be caught, and a good row left alone');
  assert.deepEqual([...coverage.STATUSES], ['live', 'wired_unproven', 'not_wired']);
  for (const r of coverage.CATALOG) {
    assert.ok(coverage.STATUSES.includes(r.status), `${r.resource} has status ${r.status}`);
    // The note must say something the status does not. "This is live" as a
    // note is a row that took space and added nothing.
    assert.ok(r.note.length > 25, `${r.resource} (${r.kind}) needs a note worth reading`);
    assert.ok(!new RegExp(`^${r.status}\\.?$`, 'i').test(r.note.trim()), `${r.resource}: the note must not restate the status`);
  }
  // A resource+kind pair may appear once. Two rows for one capability is two
  // answers to whether it works.
  const keys = coverage.CATALOG.map(r => `${r.resource}:${r.kind}`);
  assert.equal(new Set(keys).size, keys.length, 'a resource+kind pair is declared twice');
});

test('the nine reads added in 4.12 are declared as UNPROVEN, not as working', () => {
  // None of them has been run against a live EMR. Recording them as `live`
  // because the code exists is the precise mistake this catalog is for.
  const added = ['Coverage', 'Immunization', 'CareTeam', 'RelatedPerson', 'Goal', 'Device', 'Media', 'QuestionnaireResponse', 'Procedure'];
  for (const r of added) {
    const row = coverage.CATALOG.find(x => x.resource === r && x.kind === 'read');
    assert.ok(row, `${r} read must be declared`);
    assert.equal(row.status, 'wired_unproven', `${r} has not been proven live — saying it has is the failure this file exists to stop`);
    assert.ok(transport.includes(`fhirGet(\`${r}?patient=`), `${r} must actually be called by the transport`);
  }
  // And no write was added for any of them: on 8.4 FHIR is read-only for
  // clinical resources, and a write that silently no-ops is the trap this repo
  // has paid for six times.
  for (const r of added) {
    assert.ok(!new RegExp(`fhirPost\\(\`?${r}|fhirPut\\(\`?${r}`).test(transport), `${r} must not have gained a FHIR write`);
  }
});

test('the generated document is current, and it is generated rather than hand-kept', () => {
  const out = cp.spawnSync('node', [path.join(root, 'scripts', 'openemr_coverage.js'), '--check'], { cwd: root, encoding: 'utf8' });
  assert.equal(out.status, 0, `docs/OPENEMR_COVERAGE.md is stale or the catalog is untriaged:\n${out.stderr}`);
  const doc = fs.readFileSync(path.join(root, 'docs', 'OPENEMR_COVERAGE.md'), 'utf8');
  assert.match(doc, /Do not hand-edit/, 'a hand-maintained list of what works is a list that goes stale silently');
  // Three lists, each headed with its count, so a reader cannot mistake one
  // for another.
  for (const status of coverage.STATUSES) {
    const n = coverage.byStatus(status).length;
    assert.ok(doc.includes(`(${n})`), `the ${status} list must show its count`);
  }
  assert.ok(coverage.byStatus('wired_unproven').length > 0,
    'precondition: there is something unproven, or this test proves nothing about the distinction');
});

test('the rest-of-the-record read names WHICH failure it got, and never renders one as another', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const fn = server.slice(server.indexOf('const describeEmrReadFailure'), server.indexOf("app.get('/api/clinical/patients/:clientId/record-extras'"));
  assert.ok(fn.length > 200, 'precondition: the describer was sliced');
  // 403, 404 and zero rows have three different fixes and looked identical as
  // a blank panel. An empty result is not a diagnosis.
  assert.match(fn, /status === 403/);
  assert.match(fn, /status === 404/);
  assert.match(fn, /ACL/, 'a 403 must point at the org ACL, which an admin fixes');
  assert.match(fn, /NOT_ROUTED/, 'a 404 must say the EMR does not serve it, which nothing here can fix');
  // The three reasons must be distinct strings, or the screen cannot tell them
  // apart whatever the code does.
  const reasons = (fn.match(/reason: '([A-Z_]+)'/g) || []);
  assert.equal(new Set(reasons).size, reasons.length, 'each failure layer needs its own reason');
  assert.ok(reasons.length >= 3);

  const route = server.slice(server.indexOf("app.get('/api/clinical/patients/:clientId/record-extras'"));
  const body = route.slice(0, route.indexOf('// ── Encounter type'));
  // It is a READ, so a case manager sees it.
  assert.match(server, /record-extras',\s*authenticateToken,\s*requireClinicalRead,/);
  // One failing section must not take the others with it: a 404 on Media says
  // nothing about whether Immunization returns.
  assert.match(body, /Promise\.all\(EXTENDED_READS\.map/);
  assert.match(body, /catch \(e\) \{\s*\n\s*return \{ key: r\.key/);
  // The audit entry records WHICH sections failed, never what any of them
  // held. An audit trail is not a second copy of the record.
  const log = body.slice(body.indexOf('logActivity'), body.indexOf('res.json'));
  assert.match(log, /failed:/);
  // It may name the sections that FAILED — a key is not a record. What it may
  // never carry is a row, which is what `.rows` would hand it.
  assert.ok(!/\.rows/.test(log), 'the audit entry must not carry the rows themselves');
  assert.match(log, /sections\.filter\(s => s\.failure\)\.map\(s => s\.key\)/,
    'only the keys of the sections that failed');
  // And the response says plainly that none of this is proven.
  assert.match(body, /unproven: true/);
});

test('the screen restates no section list and no failure wording of its own', () => {
  const page = fs.readFileSync(path.join(root, 'public', 'clinical.html'), 'utf8');
  const tab = page.slice(page.indexOf('const RecordExtrasTab = ('), page.indexOf('const codeableText = ('));
  assert.ok(tab.length > 400, 'precondition: the tab was sliced');
  // The sections, their labels and the failure sentences are served. A second
  // copy on the page would be a second answer to why a read failed.
  assert.match(tab, /data\.sections\.map/);
  assert.match(tab, /\{sec\.failure\.message\}/, "the server's own sentence, not the page's");
  assert.match(tab, /\{data\.unprovenNote\}/);
  for (const label of ['Immunizations', 'Goals', 'Devices']) {
    assert.ok(!tab.includes(`'${label}'`), `the page must not name the section ${label}; the list is served`);
  }
  // An empty section that ANSWERED is stated as such, never left blank — the
  // whole distinction this scope exists to make visible.
  assert.match(tab, /OpenEMR answered, and has nothing recorded here/);
  assert.match(page, /\{tab === 'extras' && <RecordExtrasTab/, 'a tab nobody can open is a capability that does not exist');
});
