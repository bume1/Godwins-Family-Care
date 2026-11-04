// ============================================================
// gfc_billable_codes — the NCCI loader's code universe (owner, 2026-11-04).
//
// In September the loader's universe (favorites + prior selections + billed
// history) came to eight home-visit codes, so the MUE table held eight rows
// and PTP only home-visit pairs, with nothing saying so. These tests pin the
// fix: the list exists and is registered, the loader unions it with the old
// three sources, stops when it is empty, and its summary names what matched
// nothing.
//
// The MUE-coverage test runs the REAL loader (real unzip) against a fixture
// CMS-shaped file. A run against CMS's actual 2026 Q4 file, done by hand on
// 2026-11-04, kept 87 of the 91 codes; CMS publishes no MUE for G0568,
// G0569, G0570 or G2211.
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
const B = require('../billableCodes');
const CMD = require('../scripts/billable_codes');

const mem = () => dataStore.createStore({ adapter: 'memory', env: { NODE_ENV: 'test' } });
const quiet = async (fn) => {
  const orig = { log: console.log, error: console.error };
  const out = [];
  console.log = (...a) => out.push(a.join(' '));
  console.error = (...a) => out.push(a.join(' '));
  try { return { result: await fn(), out: out.join('\n') }; } finally { Object.assign(console, orig); }
};
const emptyDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gfc-bc-'));
// Codes CMS really does not publish an MUE for (checked against the 2026 Q4 file).
const NO_MUE = new Set(['G0568', 'G0569', 'G0570', 'G2211']);

// ---- the collection ----
test('the seed holds the owner\'s 91 OpenEMR codes, each once, none of the excluded codes', () => {
  const codes = B.readSeedCodes();
  assert.equal(codes.length, 91);
  assert.equal(new Set(codes).size, 91);
  for (const c of ['99343', '99999', 'G0177', 'G0409', 'G0410']) assert.ok(!codes.includes(c), `${c} must not be in the seed`);
});

test('gfc_billable_codes is registered for migration, and is not PHI', () => {
  const { findHandler } = require('../dataMigration');
  const h = findHandler('gfc_billable_codes');
  assert.ok(h);
  assert.equal(h.phi, false);
});

test('rows are { code, source, updatedAt }, one per code, bad shapes dropped', () => {
  const rows = B.normalizeList([
    { code: '99350', source: 'openemr_seed', updatedAt: '2026-11-01' },
    { code: '99350', source: 'manual', updatedAt: '2026-11-04' },
    { code: 'nope', source: 'manual', updatedAt: '2026-11-04' },
    { code: 'g2211', source: 'weird', updatedAt: '2026-11-04' }
  ]);
  assert.deepEqual(rows, [
    { code: '99350', source: 'manual', updatedAt: '2026-11-04' },
    { code: 'G2211', source: 'manual', updatedAt: '2026-11-04' }
  ]);
});

test('the boot seed writes only when the list has never been set', async () => {
  const db = mem();
  assert.deepEqual(await B.seedIfMissing(db), { seeded: true, count: 91 });
  const rows = await db.get('gfc_billable_codes');
  assert.ok(rows.every(r => r.source === 'openemr_seed' && r.updatedAt));
  assert.equal((await B.seedIfMissing(db)).seeded, false, 'a second boot does nothing');
  await db.set('gfc_billable_codes', []);
  assert.equal((await B.seedIfMissing(db)).seeded, false, 'an empty list saved on purpose stays empty');
  assert.deepEqual(await db.get('gfc_billable_codes'), []);
});

// ---- the loader ----
test('an empty gfc_billable_codes stops the loader and writes nothing', async () => {
  const db = mem();
  await db.set('clinical_settings', { serviceCodeFavorites: [{ code: '99350' }] });
  await db.set('gfc_ncci_mue', { '99350': { mueValue: 1, mai: '3' } });
  let fetched = false;
  const { result, out } = await quiet(() => L.main({ db, ptpDir: emptyDir(), quarter: '2026Q4', fetchMueZip: async () => { fetched = true; return createZip([{ name: 'm.txt', data: '99349\t1\t3\tx\n' }]); } }));
  assert.equal(result.stopped, 'billable_codes_empty');
  assert.equal(fetched, false, 'nothing is fetched');
  assert.match(out, /STOPPED: gfc_billable_codes is empty/);
  assert.deepEqual(await db.get('gfc_ncci_mue'), { '99350': { mueValue: 1, mai: '3' } }, 'the prior table is untouched');
  assert.equal(await db.get('gfc_ncci_source_version'), null);
});

test('the universe unions gfc_billable_codes with favorites, prior selections and billed history', () => {
  const u = L.deriveGfcCodeUniverse({
    billableCodes: [{ code: '99350' }],
    serviceCodeFavorites: [{ code: '99347' }],
    codeUsage: [{ code: '99213', set: 'CPT4' }, { code: 'E11.9', set: 'ICD10' }],
    encounterBillingRows: [{ services: [{ code: '99999' }] }]
  });
  assert.deepEqual([...u].sort(), ['99213', '99347', '99350', '99999'],
    'a code a clinician billed stays in even when nobody added it to the list');
});

test('the MUE table holds a row for every billable code CMS publishes an MUE for, and more than eight', async () => {
  const db = mem();
  await B.seedIfMissing(db);
  const billable = (await db.get('gfc_billable_codes')).map(r => r.code);
  // A CMS-shaped file: the GFC codes CMS publishes, plus codes GFC does not bill.
  const published = billable.filter(c => !NO_MUE.has(c));
  const csv = ['HCPCS/CPT Code,Practitioner Services MUE Values,MUE Adjudication Indicator,MUE Rationale',
    ...published.map(c => `${c},1,3 Date of Service Edit: Clinical,Clinical: Data`),
    '11042,1,2 Per Day Edit: Policy,CMS Policy', '27447,1,2 Per Day Edit: Policy,CMS Policy'].join('\n');
  const { result } = await quiet(() => L.main({ db, ptpDir: emptyDir(), quarter: '2026Q4',
    fetchMueZip: async () => createZip([{ name: 'MCR_MUE_PractitionerServices.csv', data: csv }]) }));
  const mue = await db.get('gfc_ncci_mue');
  for (const c of published) assert.ok(mue[c], `${c} is published by CMS but has no MUE row`);
  assert.ok(Object.keys(mue).length > 8, `the MUE table holds ${Object.keys(mue).length} rows`);
  assert.equal(Object.keys(mue).length, published.length);
  assert.ok(!mue['11042'] && !mue['27447'], 'codes GFC does not bill are filtered out');
  assert.deepEqual(result.codesWithoutMue, [...NO_MUE].sort());
});

test('the summary prints rows per file, rows kept, the quarter, matched and unmatched counts, and the diff', async () => {
  const db = mem();
  await db.set('gfc_billable_codes', ['99350', '99349', 'G2211'].map(code => ({ code, source: 'manual', updatedAt: 'x' })));
  await db.set('gfc_ncci_mue', { '99350': { mueValue: 2, mai: '3' } });
  const ptpDir = emptyDir();
  fs.writeFileSync(path.join(ptpDir, 'ptp_a.zip'), createZip([{ name: 'a.txt', data: '99350\t36415\t*\t*\t*\t1\tr\n11042\t11043\t*\t*\t*\t1\tr\n' }]));
  fs.writeFileSync(path.join(ptpDir, 'ptp_b.zip'), createZip([{ name: 'b.txt', data: '99349\t99211\t*\t*\t*\t0\tr\n' }]));
  const { result, out } = await quiet(() => L.main({ db, ptpDir, quarter: '2026Q4',
    fetchMueZip: async () => createZip([{ name: 'mue.txt', data: '99350\t1\t3\tx\n27447\t1\t2\tx\n' }]) }));
  assert.deepEqual(result.ptp.files, [{ file: 'ptp_a.zip', rowsSeen: 2, rowsKept: 1 }, { file: 'ptp_b.zip', rowsSeen: 1, rowsKept: 1 }]);
  assert.equal(result.mue.files[0].rowsSeen, 2);
  assert.equal(result.mue.files[0].rowsKept, 1);
  assert.equal(result.matchedCodes, 2);
  assert.deepEqual(result.unmatchedCodes, ['G2211']);
  assert.match(out, /NCCI\/MUE load summary — 2026Q4/);
  assert.match(out, /ptp_a\.zip: 2 row\(s\) seen, 1 kept/);
  assert.match(out, /GFC codes matched: 2 of 3/);
  assert.match(out, /Universe codes that matched nothing: 1 — G2211/);
  assert.match(out, /MUE[\s\S]*vs prior load: added 0, removed 0, value\/MAI changed 1/);
});

// ---- the command ----
test('the command seeds only an empty list, adds, removes and refuses a bad code', async () => {
  const db = mem(); const log = () => {};
  assert.equal((await CMD.main(['seed'], { db, log })).count, 91);
  assert.equal((await CMD.main(['seed'], { db, log })).ok, false, 'seed will not overwrite without --replace');
  assert.equal((await CMD.main(['add', '99211'], { db, log })).count, 92);
  assert.equal((await db.get('gfc_billable_codes')).find(r => r.code === '99211').source, 'manual');
  assert.equal((await CMD.main(['remove', '99211'], { db, log })).count, 91);
  const bad = await CMD.main(['add', '99211', 'nope'], { db, log });
  assert.equal(bad.ok, false);
  assert.equal((await db.get('gfc_billable_codes')).length, 91, 'a bad code changes nothing');
});

test('from-catalog copies every cached catalog code, active and inactive, and never removes', async () => {
  const db = mem(); const log = () => {};
  assert.equal((await CMD.main(['from-catalog'], { db, log })).ok, false, 'no cached catalog: nothing changes');
  await db.set('gfc_billable_codes', [{ code: '99350', source: 'openemr_seed', updatedAt: 'x' }]);
  await db.set('openemr_code_catalog', { fetchedAt: '2026-11-04T00:00:00Z', codes: [{ code: '99349' }], inactive: [{ code: '99211' }] });
  const r = await CMD.main(['from-catalog'], { db, log });
  assert.equal(r.count, 3);
  const rows = await db.get('gfc_billable_codes');
  assert.deepEqual(rows.map(x => x.code), ['99211', '99349', '99350']);
  assert.equal(rows.find(x => x.code === '99349').source, 'openemr_catalog');
});
