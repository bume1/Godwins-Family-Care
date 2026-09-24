// ============================================================
// scripts/load_ncci_tables.js — pure parsing/derivation logic, and an
// end-to-end run through the REAL `unzip` binary against a zip this repo's
// own zipWriter.js builds (the same "verify against the real tool, not a
// mock of it" rule the enrollment-packet ZIP already follows).
//
// What this does NOT prove: that CMS's live URL still answers, or that a
// real CMS file parses cleanly — that needs a live fetch, which is the
// owner's to run quarterly, same as every other scripts/verify_*.js probe in
// this repo that touches something outside this sandbox.
// Run: npm test
// ============================================================
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dataStore = require('../dataStore');
const { createZip } = require('../zipWriter');
const L = require('../scripts/load_ncci_tables');

const mem = () => dataStore.createStore({ adapter: 'memory', env: { NODE_ENV: 'test' } });

// ---- quarter arithmetic ----
test('computeTargetQuarter targets the NEXT quarter once within 45 days of it', () => {
  // Aug 20 2026 is 42 days before Oct 1 — CMS's own posted-a-month-ahead
  // pattern (2026 Q4 posted Sept 2 for an Oct 1 effective date).
  assert.deepEqual(L.computeTargetQuarter(new Date('2026-08-20T00:00:00Z')), { year: 2026, quarter: 4 });
  // Jan 10 is well inside Q1 and nowhere near the Q2 boundary.
  assert.deepEqual(L.computeTargetQuarter(new Date('2026-01-10T00:00:00Z')), { year: 2026, quarter: 1 });
  // Dec 20 rolls the quarter AND the year over.
  assert.deepEqual(L.computeTargetQuarter(new Date('2026-12-20T00:00:00Z')), { year: 2027, quarter: 1 });
});
test('quarterLabel and parseQuarterArg round-trip, and reject junk', () => {
  assert.equal(L.quarterLabel({ year: 2026, quarter: 4 }), '2026Q4');
  assert.deepEqual(L.parseQuarterArg('2026Q4'), { year: 2026, quarter: 4 });
  assert.deepEqual(L.parseQuarterArg('2026q4'), { year: 2026, quarter: 4 });
  assert.throws(() => L.parseQuarterArg('not-a-quarter'));
  assert.throws(() => L.parseQuarterArg('2026Q5'));
});
test('mueUrl matches the literal CMS pattern', () => {
  assert.equal(L.mueUrl({ year: 2026, quarter: 4 }), 'https://www.cms.gov/files/zip/medicare-ncci-2026-q4-practitioner-services-mue-table.zip');
});

// ---- field-shape parsing ----
test('parsePtpLine finds the two codes and the modifier indicator by shape, tab-delimited', () => {
  assert.deepEqual(L.parsePtpLine('99213\t36415\t*\t20260101\t*\t1\tStandards of practice'),
    { column1Code: '99213', column2Code: '36415', modifierIndicator: 1 });
});
test('parsePtpLine tolerates comma-delimited and multi-space-delimited rows the same way', () => {
  assert.deepEqual(L.parsePtpLine('99213,36415,*,20260101,*,0,rationale'),
    { column1Code: '99213', column2Code: '36415', modifierIndicator: 0 });
  assert.deepEqual(L.parsePtpLine('99213   36415   *   20260101   *   9   rationale'),
    { column1Code: '99213', column2Code: '36415', modifierIndicator: 9 });
});
test('parsePtpLine returns null for a row that is not data — a header, a blank line, a lone code', () => {
  assert.equal(L.parsePtpLine('Column 1\tColumn 2\tModifier Indicator'), null);
  assert.equal(L.parsePtpLine(''), null);
  assert.equal(L.parsePtpLine('99213'), null); // only one code — nothing to pair
});
test('parseMueLine finds the code, the unit cap and the MAI in column order', () => {
  assert.deepEqual(L.parseMueLine('99213\t3\t3\tCMS policy'), { code: '99213', mueValue: 3, mai: '3' });
  assert.deepEqual(L.parseMueLine('G0180\t1\t2\tclinical rationale'), { code: 'G0180', mueValue: 1, mai: '2' });
});
test('parseMueLine returns null when nothing on the line looks like a code', () => {
  assert.equal(L.parseMueLine('HCPCS/CPT Code\tMUE Values\tMAI'), null);
});

// ---- GFC's own code universe, derived from three local sources ----
test('deriveGfcCodeUniverse unions favorites, usage history and billed history, case-insensitively', () => {
  const codes = L.deriveGfcCodeUniverse({
    serviceCodeFavorites: [{ code: '99347' }],
    codeUsage: [{ code: '99213', set: 'CPT4' }, { code: 'E11.9', set: 'ICD10' }], // ICD10 usage is not a service code
    encounterBillingRows: [{ services: [{ code: 'g0180' }] }]
  });
  assert.deepEqual([...codes].sort(), ['99213', '99347', 'G0180']);
});
test('an empty store yields an empty universe, never a guessed default', () => {
  assert.equal(L.deriveGfcCodeUniverse({}).size, 0);
});

// ---- diffing ----
test('diffPtp reports added, removed and indicator-changed pairs against the prior load', () => {
  const before = [
    { column1Code: 'A', column2Code: 'B', modifierIndicator: 1 },
    { column1Code: 'C', column2Code: 'D', modifierIndicator: 0 }
  ];
  const after = [
    { column1Code: 'A', column2Code: 'B', modifierIndicator: 0 }, // indicator changed
    { column1Code: 'E', column2Code: 'F', modifierIndicator: 1 }  // added
    // C|D removed
  ];
  assert.deepEqual(L.diffPtp(before, after), { added: 1, removed: 1, indicatorChanged: 1 });
});
test('diffMue reports added, removed and value/MAI-changed codes', () => {
  const before = { A: { mueValue: 1, mai: '3' }, B: { mueValue: 2, mai: '2' } };
  const after = { A: { mueValue: 2, mai: '3' }, C: { mueValue: 1, mai: '1' } };
  assert.deepEqual(L.diffMue(before, after), { added: 1, removed: 1, valueChanged: 1 });
});

// ---- end to end, through the real `unzip` binary, against a zip this
// repo's own zipWriter.js builds — no network, no PHI. ----
test('extractTextLines reads a .txt member out of a real zip via unzip', async () => {
  const buf = createZip([{ name: 'sample_MUE.txt', data: '99213\t3\t3\trationale\nG0180\t1\t2\trationale\n' }]);
  const tmp = path.join(os.tmpdir(), `gfc-ncci-test-${Date.now()}.zip`);
  fs.writeFileSync(tmp, buf);
  try {
    const lines = await L.extractTextLines(tmp);
    assert.deepEqual(lines.map(L.parseMueLine).filter(Boolean), [
      { code: '99213', mueValue: 3, mai: '3' },
      { code: 'G0180', mueValue: 1, mai: '2' }
    ]);
  } finally { fs.unlinkSync(tmp); }
});
test('extractTextLines refuses a zip with no .txt member, naming what it did find', async () => {
  const buf = createZip([{ name: 'sample.xlsx', data: 'not really an xlsx, just bytes' }]);
  const tmp = path.join(os.tmpdir(), `gfc-ncci-test-noxt-${Date.now()}.zip`);
  fs.writeFileSync(tmp, buf);
  try {
    await assert.rejects(L.extractTextLines(tmp), /no \.txt file/);
  } finally { fs.unlinkSync(tmp); }
});

test('main() end to end: MUE fetched (mocked), PTP found locally, both stored and read back', async () => {
  const db = mem();
  await db.set('clinical_settings', { serviceCodeFavorites: [{ code: '99213' }] });
  const mueZipBuf = createZip([{ name: 'mue.txt', data: '99213\t2\t3\trationale\n' }]);
  const ptpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gfc-ncci-ptp-'));
  fs.writeFileSync(path.join(ptpDir, 'ptp_range1.zip'),
    createZip([{ name: 'ptp1.txt', data: '99213\t36415\t*\t20260101\t*\t1\trationale\n' }]));
  try {
    const summary = await L.main({ db, ptpDir, quarter: '2026Q4', fetchMueZip: async () => mueZipBuf });
    assert.equal(summary.mue.ok, true);
    assert.equal(summary.ptp.ok, true);
    assert.equal(summary.mue.rowsKept, 1);
    assert.equal(summary.ptp.rowsKept, 1);

    const storedMue = await db.get('gfc_ncci_mue');
    assert.deepEqual(storedMue, { '99213': { mueValue: 2, mai: '3' } });
    const storedPtp = await db.get('gfc_ncci_ptp_edits');
    assert.deepEqual(storedPtp, [{ column1Code: '99213', column2Code: '36415', modifierIndicator: 1 }]);
    const version = await db.get('gfc_ncci_source_version');
    assert.equal(version.ptp.quarter, '2026Q4');
    assert.equal(version.mue.quarter, '2026Q4');
    assert.ok(version.ptp.loadedAt && version.mue.loadedAt);
  } finally {
    fs.rmSync(ptpDir, { recursive: true, force: true });
  }
});

test('main() reports PTP as not-found, and names the CMS page, when no local zips exist', async () => {
  const db = mem();
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gfc-ncci-empty-'));
  try {
    const summary = await L.main({
      db, ptpDir: emptyDir, quarter: '2026Q4',
      fetchMueZip: async () => createZip([{ name: 'mue.txt', data: '99999\t1\t1\tx\n' }])
    });
    assert.equal(summary.ptp.ok, false);
    assert.equal(summary.ptp.error, 'not_found');
    // MUE succeeds independently — the two halves do not gate each other.
    assert.equal(summary.mue.ok, true);
  } finally {
    fs.rmSync(emptyDir, { recursive: true, force: true });
  }
});

test('a fetch failure on the MUE half is reported, never thrown past main()', async () => {
  const db = mem();
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gfc-ncci-empty2-'));
  try {
    const summary = await L.main({ db, ptpDir: emptyDir, quarter: '2026Q4', fetchMueZip: async () => { throw new Error('ETIMEDOUT'); } });
    assert.equal(summary.mue.ok, false);
    assert.match(summary.mue.error, /ETIMEDOUT/);
  } finally {
    fs.rmSync(emptyDir, { recursive: true, force: true });
  }
});

// ---- a re-run replaces outright — idempotent by construction, never a
// second copy of the same quarter ----
test('re-running with the same data leaves the stored table identical, not doubled', async () => {
  const db = mem();
  await db.set('clinical_settings', { serviceCodeFavorites: [{ code: '99213' }] });
  const ptpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gfc-ncci-ptp2-'));
  fs.writeFileSync(path.join(ptpDir, 'ptp.zip'), createZip([{ name: 'ptp.txt', data: '99213\t36415\t*\t*\t*\t0\tr\n' }]));
  const fetchMueZip = async () => createZip([{ name: 'mue.txt', data: '99213\t1\t1\tr\n' }]);
  try {
    await L.main({ db, ptpDir, quarter: '2026Q4', fetchMueZip });
    const first = await db.get('gfc_ncci_ptp_edits');
    await L.main({ db, ptpDir, quarter: '2026Q4', fetchMueZip });
    const second = await db.get('gfc_ncci_ptp_edits');
    assert.deepEqual(first, second);
    assert.equal(second.length, 1);
  } finally {
    fs.rmSync(ptpDir, { recursive: true, force: true });
  }
});

// ---- build-enforced: the three collections this script owns are claimed in
// the migration registry, or a real deployment would refuse to migrate the
// day this data needs to move (the exact failure the registry exists to
// catch before cutover, not after). ----
test('build-enforced: gfc_ncci_ptp_edits, gfc_ncci_mue and gfc_ncci_source_version are all registered collections', () => {
  const { findHandler } = require('../dataMigration');
  for (const key of ['gfc_ncci_ptp_edits', 'gfc_ncci_mue', 'gfc_ncci_source_version']) {
    const h = findHandler(key);
    assert.ok(h, `${key} has no COLLECTION_REGISTRY handler`);
    assert.equal(h.phi, false, `${key} carries only CMS reference data, never PHI`);
  }
});
