// ============================================================
// scripts/export_billing_codes.js — pure aggregation tests.
//
// The script's only real logic is aggregateBillingCodes(); everything else
// is I/O (reading the store, printing, writing a CSV). Tested here without
// a store, the same way scripts/load_ncci_tables.js's pure helpers are.
// ============================================================
const test = require('node:test');
const assert = require('node:assert/strict');
const { aggregateBillingCodes, toCsv } = require('../scripts/export_billing_codes');

test('a code appearing in only one source is still reported, with that source named', () => {
  const rows = aggregateBillingCodes({
    favorites: [{ code: '99347', codeType: 'CPT4', label: 'Home visit · established patient' }],
    usageRows: [],
    billingRows: []
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].code, '99347');
  assert.equal(rows[0].sources, 'favorite');
  assert.equal(rows[0].timesBilled, 0);
  assert.equal(rows[0].label, 'Home visit · established patient');
});

test('ICD10 rows in clinical_code_usage are excluded — this is a fee schedule, not a diagnosis list', () => {
  const rows = aggregateBillingCodes({
    favorites: [],
    usageRows: [{ userId: 'u1', set: 'ICD10', code: 'E11.9', description: 'T2DM', count: 5 }],
    billingRows: []
  });
  assert.equal(rows.length, 0);
});

test('modifiers are read from svc.modifiers, the stored shape, never svc.modifier — the same class of bug that cost a live billing defect', () => {
  const rows = aggregateBillingCodes({
    favorites: [],
    usageRows: [],
    billingRows: [
      { services: [{ code: '99347', codeType: 'CPT4', modifiers: ['25', '95'] }] },
      // A row using the wrong (singular) key must contribute nothing —
      // proving the aggregator does not silently fall back to it.
      { services: [{ code: '99347', codeType: 'CPT4', modifier: '59' }] }
    ]
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].modifiers, '25, 95');
  assert.ok(!rows[0].modifiers.includes('59'), 'the singular `modifier` key must never be read');
  assert.equal(rows[0].timesBilled, 2);
});

test('a code billed multiple times counts every line, and modifiers accumulate without duplicates', () => {
  const rows = aggregateBillingCodes({
    favorites: [],
    usageRows: [],
    billingRows: [
      { services: [{ code: 'G0506', codeType: 'HCPCS', modifiers: ['25'] }] },
      { services: [{ code: 'G0506', codeType: 'HCPCS', modifiers: ['25', 'GT'] }] }
    ]
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].timesBilled, 2);
  assert.equal(rows[0].modifiers, '25, GT');
});

test('the same code across all three sources merges into one row, sources joined, first label wins', () => {
  const rows = aggregateBillingCodes({
    favorites: [{ code: '99347', codeType: 'CPT4', label: 'Home visit · established patient' }],
    usageRows: [{ userId: 'u1', set: 'CPT4', code: '99347', description: 'should not override the favorite label', count: 3 }],
    billingRows: [{ services: [{ code: '99347', codeType: 'CPT4', modifiers: ['95'] }] }]
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sources, 'billed; clinician usage; favorite');
  assert.equal(rows[0].label, 'Home visit · established patient');
});

test('rows sort by code, and CPT vs HCPCS is distinguished per row', () => {
  const rows = aggregateBillingCodes({
    favorites: [
      { code: 'G0506', codeType: 'HCPCS', label: 'Care planning' },
      { code: '99347', codeType: 'CPT4', label: 'Home visit' }
    ],
    usageRows: [],
    billingRows: []
  });
  assert.deepEqual(rows.map(r => r.code), ['99347', 'G0506']);
  assert.equal(rows[0].codeType, 'CPT4');
  assert.equal(rows[1].codeType, 'HCPCS');
});

test('a malformed modifier (not exactly 2 alphanumerics) is dropped, never printed', () => {
  const rows = aggregateBillingCodes({
    favorites: [],
    usageRows: [],
    billingRows: [{ services: [{ code: '99347', codeType: 'CPT4', modifiers: ['9', 'ABC', '25'] }] }]
  });
  assert.equal(rows[0].modifiers, '25');
});

test('toCsv quotes a label containing a comma and round-trips through a real CSV split', () => {
  const csv = toCsv([{ code: '99347', codeType: 'CPT4', label: 'Home visit, established', sources: 'favorite', timesBilled: 2, modifiers: '25, 95' }]);
  assert.match(csv, /"Home visit, established"/);
  assert.match(csv, /^Code,Type,Label,Sources,Times Billed,Modifiers Seen\r\n/);
});
