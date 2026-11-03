// ============================================================
// A charge posted with no fee is priced the way the Fee Sheet prices it
// (owner, 2026-10-28). It used to default to $0.00, so every charge reached
// Billing Manager at $0.
//
// The PHP half runs the REAL GfcChargeRestController::postCharge against
// stubbed OpenEMR tables (test/php/fee_resolution.php). The app half checks
// that a $0 line is recorded and shown, never silent.
// Run: npm test
// ============================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const R = require('../clinicalRepository');

const ROOT = path.join(__dirname, '..');
const hasPhp = spawnSync('php', ['-v']).status === 0;
let out = null;
const run = () => out || (out = JSON.parse(execFileSync('php', [path.join(__dirname, 'php', 'fee_resolution.php')], { encoding: 'utf8' })));

test('99350 posted with no fee resolves to the standard-level price', { skip: !hasPhp && 'php is not installed' }, () => {
  const c = run().no_fee_99350;
  assert.equal(c.written.fee, '245.50', 'the fee handed to addBilling');
  assert.equal(c.written.pricelevel, 'standard');
  assert.equal(c.row.fee_used, '245.50', 'the response says which fee was used');
  assert.equal(c.row.fee_source, 'price_table');
});

test('99350 with modifier 25 and no priced modifier row falls back to the base code price', { skip: !hasPhp && 'php is not installed' }, () => {
  const c = run().mod25_99350;
  assert.equal(c.written.modifier, '25');
  assert.equal(c.written.fee, '245.50');
  assert.equal(c.row.fee_source, 'base_code_fallback');
});

test('the price is multiplied by units, read at the patient\'s own level, and a posted fee wins', { skip: !hasPhp && 'php is not installed' }, () => {
  const o = run();
  assert.equal(o.two_units_99350.written.fee, '491.00');
  assert.equal(o.medicare_level_99350.written.fee, '199.00');
  assert.equal(o.medicare_level_99350.row.price_level, 'medicare');
  assert.equal(o.posted_fee_99350.written.fee, '10.00');
  assert.equal(o.posted_fee_99350.row.fee_source, 'posted');
});

test('a code with no price still posts, at $0, and the response says so', { skip: !hasPhp && 'php is not installed' }, () => {
  const c = run().no_price_99349_standard;
  assert.equal(c.written.fee, '0.00');
  assert.equal(c.row.fee_source, 'none');
});

test('the app records the fee OpenEMR used, and null when it did not say', () => {
  const p = { code: '99350', code_type: 'CPT4', modifier: '25' };
  assert.deepEqual(R.postedChargeEntry(p, { id: 7, fee_used: '245.50', fee_source: 'base_code_fallback' }),
    { id: '7', code: '99350', codeType: 'CPT4', modifier: '25', fee: 245.5, feeSource: 'base_code_fallback' });
  assert.equal(R.postedChargeEntry(p, { id: 7, fee_used: '0.00' }).fee, 0);
  assert.equal(R.postedChargeEntry(p, { id: 7 }).fee, null, 'unknown is not $0');
});

test('a $0 line is named in a warning; an unknown fee is not called $0', () => {
  const record = { postedCharges: [{ code: '99350', fee: 0 }, { code: '99349', fee: 150 }, { code: '99348', fee: null }] };
  assert.deepEqual(R.zeroFeeCharges(record).map(c => c.code), ['99350']);
  assert.match(R.zeroFeeWarning(R.zeroFeeCharges(record)), /99350 posted to Billing Manager at \$0\.00/);
  assert.equal(R.zeroFeeWarning([]), null);
});

test('the coding queue serves and shows $0 charges by code and encounter', () => {
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const q = server.slice(server.indexOf("app.get('/api/clinical/encounters/queue'"));
  const body = q.slice(0, q.indexOf('\napp.'));
  assert.equal((body.match(/zeroFeeCharges: clinicalRepo\.zeroFeeCharges\(record\)/g) || []).length, 2, 'both the EMR and the degraded path');
  assert.match(body, /res\.json\(\{ filter, encounters: filtered, zeroFee,/);
  assert.match(server, /posted\.push\(clinicalRepo\.postedChargeEntry\(payload, row\)\)[\s\S]{0,400}zeroFeeWarning/);
  const page = fs.readFileSync(path.join(ROOT, 'public', 'clinical.html'), 'utf8');
  assert.match(page, /Charges posted at \$0\.00/);
  assert.match(page, /\$0 charge: \{e\.zeroFeeCharges/);
});
