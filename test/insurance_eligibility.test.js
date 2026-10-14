// ============================================================================
// test/insurance_eligibility.test.js — B1, the insurance round trip (2026-10-13)
//
// WHAT THIS FILE PINS
//   1. Every payer code the repo produces or accepts — 'medicare_b' included —
//      reads as ONE canonical kind, through one translation table.
//   2. A Medicare Part B patient is Medicare through the normaliser alone; the
//      old `intake.insurance` and `primaryName` fallbacks are gone.
//   3. The MBI format: S, L, O, I, B and Z are never valid, and a malformed
//      number is SAVED and flagged, never refused.
//   4. Ranked payers survive; two primaries are refused.
//   5. QMB is stated, never inferred, and 'unknown' when nobody said.
//   6. Nothing auto-verifies; an Advantage plan found where intake said
//      Original Medicare is a MISMATCH that keeps both values.
//   7. The insurance check blocks the CLAIM and never the signature; an admin
//      may override with a reason, nobody else.
//   8. A QMB patient gets no copay statement, under Original Medicare or
//      Medicare Advantage.
//   9. No X12 parsing anywhere in the app.
//  10. Every new intake field is declared, so assertIntakeIsDeclared passes.
// ============================================================================
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const ins = require(path.join(root, 'insuranceEligibility.js'));
const orderReq = require(path.join(root, 'orderRequisitions.js'));
const intakeFields = require(path.join(root, 'public', 'intake-fields.js'));
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

const VALID_MBI = '1EG4TE5MK72';

// ---- 1. every legacy code → a canonical kind -------------------------------
// One row per payer string found in the Scope 0A sweep. `null` is a situation
// ('combination'), resolved from the blocks rather than guessed.
const LEGACY_ROWS = [
  ['medicare_b', 'medicare_ffs'],          // server.js ENUM.payerType 'Medicare Part B'
  ['private_pay', 'private_pay'],          // 'Private pay'
  ['ltc_insurance', 'ltc'],                // 'LTC insurance'
  ['medicaid_waiver', 'medicaid'],         // 'Medicaid waiver'
  ['va', 'va'],                            // 'VA'
  ['combination', null],                   // 'Dual eligible' and 'Combination'
  ['medicare', 'medicare_ffs'],            // accepted by the old isMedicarePatient
  ['medicare_advantage', 'medicare_advantage'],
  ['medicareadvantage', 'medicare_advantage'],
  ['ma', 'medicare_advantage'],
  ['commercial', 'commercial'],            // test fixtures
  ['Medicare Part B', 'medicare_ffs'],     // the intake label itself
  ['Medicare Part A & B', 'medicare_ffs'], // insuranceTypes label
  ['Medicare Advantage (Part C)', 'medicare_advantage'] // medicare.type label
];
for (const [code, kind] of LEGACY_ROWS) {
  test(`1. legacy payer string "${code}" → ${kind === null ? 'a situation, not a payer' : kind}`, () => {
    assert.strictEqual(ins.kindFromLegacy(code), kind);
    if (kind) {
      const norm = ins.normalizePayers({ payer: { type: code } });
      assert.ok(norm.entries.some(e => e.kind === kind), `${code} produced ${JSON.stringify(norm.entries.map(e => e.kind))}`);
      assert.ok(ins.KINDS.includes(kind));
    }
  });
}

test('1b. every code the payer mirror PRODUCES is in the translation table', () => {
  const src = read('server.js');
  const line = src.slice(src.indexOf("  payerType: { 'Private pay'"), src.indexOf('\n', src.indexOf("  payerType: { 'Private pay'")));
  const codes = [...line.matchAll(/:\s*'([a-z_]+)'/g)].map(m => m[1]);
  assert.ok(codes.length >= 5, 'found the mirror map');
  for (const c of codes) assert.ok(Object.prototype.hasOwnProperty.call(ins.LEGACY_TO_KIND, c), `${c} is produced by server.js and not translated`);
});

// ---- 2. Medicare through the normaliser alone ------------------------------
test('2. a Part B patient, as the intake mirror stores them, is a Medicare patient', () => {
  const asStored = {
    payer: { type: 'medicare_b', insuranceTypes: ['Medicare Part A & B'], medicare: { id: VALID_MBI } },
    intake: { payerType: 'Medicare Part B', insuranceTypes: ['Medicare Part A & B'], medicare: { id: VALID_MBI } }
  };
  assert.strictEqual(orderReq.isMedicarePatient(asStored), true);
  assert.strictEqual(orderReq.isMedicarePatient({ payer: { type: 'medicare_b' } }), true, 'the bare code alone');
  assert.strictEqual(orderReq.isMedicarePatient({ payer: {} }), false, 'unknown is not Medicare');
});

test('2b. isMedicarePatient is one line through the normaliser, with both fallbacks removed', () => {
  const src = stripComments(read('orderRequisitions.js'));
  const fn = src.slice(src.indexOf('const isMedicarePatient'), src.indexOf('const checkOrderingEnrollment'));
  assert.match(fn, /insuranceEligibility\.isMedicare\(client\)/);
  assert.doesNotMatch(fn, /primaryName|insuranceTypes|\/medicare\/i/);
});

test('2c. no consumer parses a raw payer code outside the normaliser', () => {
  for (const f of ['orderRequisitions.js', 'clinicalRepository.js', 'myDay.js', 'pdf-generator.js']) {
    const src = stripComments(read(f));
    assert.doesNotMatch(src, /'medicare_b'|'medicareadvantage'|payer\.primaryName/, `${f} reads a raw payer string`);
  }
});

// ---- 3. the MBI -------------------------------------------------------------
test('3. a valid MBI passes, normalised from the way cards print it', () => {
  assert.deepStrictEqual(ins.checkMbi('1eg4-te5-mk72'), { value: VALID_MBI, valid: true, message: null });
  assert.strictEqual(ins.checkMbi(' 1EG4 TE5 MK72 ').valid, true);
});

test('3b. S, L, O, I, B and Z fail the format — in every letter position', () => {
  // Positions 2, 5, 8 and 9 are always letters; 3 and 6 may be.
  for (const bad of 'SLOIBZ') {
    for (const pos of [1, 2, 4, 5, 7, 8]) {
      const mbi = VALID_MBI.slice(0, pos) + bad + VALID_MBI.slice(pos + 1);
      const r = ins.checkMbi(mbi);
      assert.strictEqual(r.valid, false, `${mbi} should fail`);
      assert.ok(r.message, 'and say why');
    }
  }
  assert.strictEqual(ins.checkMbi('0EG4TE5MK72').valid, false, 'position 1 is never 0');
  assert.strictEqual(ins.checkMbi('1EG4TE5MK7').valid, false, '10 characters');
});

test('3c. a malformed MBI is SAVED and flagged invalid, never refused', () => {
  const { intake, mbi } = ins.normalizeIntakeInsurance({ medicare: { id: '1sg4-te5-mk72' } });
  assert.strictEqual(intake.medicare.id, '1SG4TE5MK72', 'kept, normalised');
  assert.strictEqual(intake.medicare.idValid, false);
  assert.strictEqual(mbi.valid, false);
  const n = ins.normalizePayers({ intake });
  assert.strictEqual(n.entries[0].memberId, '1SG4TE5MK72');
  assert.strictEqual(n.entries[0].memberIdValid, false);
  // And the intake save route never turns that into a refusal.
  const src = read('server.js');
  const route = src.slice(src.indexOf("app.post('/api/gfc/intake',"), src.indexOf("app.post('/api/gfc/intake',") + 6000);
  assert.match(route, /insuranceWarnings/);
  assert.doesNotMatch(route.slice(0, route.indexOf('insuranceWarnings')), /mbi[^;]*status\(400\)/);
});

test('3d. the MBI pattern is written once', () => {
  for (const f of ['server.js', 'orderRequisitions.js', 'clinicalRepository.js', 'public/portal.html', 'public/admin-enrollment.html']) {
    // The order reference alphabet shares these letters, so look for the MBI's
    // own shape: a bracketed letter class beside a 1-9 first digit.
    assert.doesNotMatch(read(f), /\[1-9\]\[?A?C?DEFGHJKMNPQRTUVWXY|\bMBI_RE\s*=/, `${f} restates the MBI pattern`);
  }
});

// ---- 4 & 5. rank -------------------------------------------------------------
const dual = (extra = {}) => ({
  intake: {
    payerType: 'Dual eligible',
    medicare: { id: VALID_MBI, coverageStart: '2024-01-01', ...(extra.medicare || {}) },
    medicaid: { memberId: '123456789012', coverageStart: '2024-03-01', ...(extra.medicaid || {}) },
    ...(extra.intake || {})
  }
});

test('4. two ranked payers survive the round trip with their ranks intact', () => {
  const stated = ins.normalizePayers(dual({ medicare: { rank: 'Primary' }, medicaid: { rank: 'Secondary' } }));
  assert.deepStrictEqual(stated.entries.map(e => [e.kind, e.rank, e.rankSource]),
    [['medicare_ffs', 'primary', 'stated'], ['medicaid', 'secondary', 'stated']]);
  assert.strictEqual(stated.primary.kind, 'medicare_ffs');
  assert.strictEqual(stated.secondary.coverageStart, '2024-03-01');
});

test("4b. 'Dual eligible' no longer collapses to one code: it is two ranked payers", () => {
  const inferred = ins.normalizePayers(dual());
  assert.deepStrictEqual(inferred.entries.map(e => [e.kind, e.rank]), [['medicare_ffs', 'primary'], ['medicaid', 'secondary']]);
  // With only the label, the data does not support a member id: two entries
  // still appear, and nothing invents an id.
  const labelOnly = ins.normalizePayers({ payer: { type: 'combination' }, intake: { payerType: 'Dual eligible' } });
  assert.deepStrictEqual(labelOnly.entries.map(e => e.kind).sort(), ['medicaid', 'medicare_ffs']);
  assert.ok(labelOnly.entries.every(e => !e.memberId));
});

test("4c. 'Combination' with payers that do not say who is first is UNRESOLVED, never guessed", () => {
  const n = ins.normalizePayers({ intake: { payerType: 'Combination', medicare: { id: VALID_MBI }, commercial: { carrier: 'Aetna', memberId: 'W1' } } });
  assert.strictEqual(n.primary, null);
  assert.ok(n.unresolved.some(u => u.code === 'PAYER_RANK_NOT_STATED'));
});

test('5. two blocks both marked primary are refused', () => {
  const r = ins.validateRanks({ medicare: { rank: 'Primary' }, commercial: { rank: 'Primary' } });
  assert.strictEqual(r.code, 'PAYER_RANK_DUPLICATE_PRIMARY');
  assert.ok(ins.validateRanks({ medicare: { rank: 'Primary' }, medicaid: { rank: 'Secondary' } }).ok);
  assert.strictEqual(ins.validateRanks({ medicare: { rank: 'First' } }).code, 'PAYER_RANK_INVALID');
  // Both save routes ask before writing.
  const src = read('server.js');
  assert.ok((src.match(/insurance\.validateRanks\(/g) || []).length >= 2, 'intake save and the staff editor');
});

test('5b. a member id with no coverage start is flagged, not refused', () => {
  const n = ins.normalizePayers({ intake: { medicare: { id: VALID_MBI } } });
  assert.deepStrictEqual(n.entries[0].missing, ['coverageStart']);
});

// ---- 6. QMB is stated, never inferred ----------------------------------------
test('6. QMB is never set from payerType, insuranceTypes or Medicaid presence', () => {
  const looksQmb = { intake: { payerType: 'Dual eligible', insuranceTypes: ['Dual eligible', 'Medicaid', 'Medicare Part A & B'], medicaid: { memberId: '1', plan: 'QMB plan' } }, payer: { type: 'combination' } };
  assert.strictEqual(ins.readQmb(looksQmb), 'unknown');
  assert.strictEqual(ins.normalizePayers(looksQmb).qmb, 'unknown');
  assert.strictEqual(ins.readQmb({}), 'unknown');
  assert.strictEqual(ins.readQmb({ intake: { qmb: 'Yes' } }), 'yes');
  assert.strictEqual(ins.readQmb({ intake: { qmb: 'No' } }), 'no');
});

// ---- 7. nothing auto-verifies; mismatch keeps both ----------------------------
const medicareClient = (extra = {}) => ({
  id: 'c1', name: 'Juanita Guess', consents: { assignmentOfBenefits: 'signed' },
  intake: { clientFirst: 'Juanita', clientLast: 'Guess', dob: '1941-03-09', gender: 'Female',
    address: { line1: '118 Hickory Log Dr', city: 'Canton', state: 'GA', zip: '30114' },
    medicare: { id: VALID_MBI, coverageStart: '2024-01-01' }, ...(extra.intake || {}) },
  ...(extra.client || {})
});
const verify = (client, body) => {
  const current = ins.normalizePayers(client).entries.find(e => e.rank === 'primary');
  const b = ins.buildVerification({ current, body: { method: 'availity_portal', ...body }, actor: { id: 'u1', name: 'Biller' }, now: '2026-10-13T15:00:00.000Z' });
  if (b.value) client.insuranceVerification = { primary: b.value };
  return b;
};

test('7. coverage from intake is unverified, and reading it never verifies it', () => {
  const c = medicareClient();
  const s = ins.verificationState(c, { today: '2026-10-13' });
  assert.strictEqual(s.status, 'unverified');
  ins.normalizePayers(c); ins.verificationState(c); ins.checkInsuranceForBilling(c);
  assert.strictEqual(c.insuranceVerification, undefined, 'no read wrote a verification');
  assert.strictEqual(ins.buildVerification({ current: ins.normalizePayers(c).primary, body: { status: 'unverified', method: 'availity_portal', planTypeAsFound: 'medicare_ffs', payerAsFound: 'x' } }).code, 'VERIFICATION_STATUS_INVALID', "'unverified' is not something a person records");
});

test('7b. verified stays verified with age (no expiry), until the coverage itself changes', () => {
  const c = medicareClient();
  verify(c, { status: 'verified', planTypeAsFound: 'medicare_ffs', payerAsFound: 'Medicare Part B', checkedAt: '2025-01-01' });
  const s = ins.verificationState(c, { today: '2026-10-13' });
  assert.strictEqual(s.status, 'verified', 'a year and more later, still verified: a clock does not un-state it');
  assert.ok(s.ageDays > 600);
  c.intake.medicare.id = '2EG4TE5MK72';
  assert.strictEqual(ins.verificationState(c).status, 'unverified', 'a different member id was never checked');
});

test('9. Medicare Advantage found where intake said Original Medicare is a MISMATCH, keeping both values', () => {
  const c = medicareClient();
  const b = verify(c, { status: 'verified', planTypeAsFound: 'medicare_advantage', payerAsFound: 'Humana Gold Plus HMO' });
  assert.strictEqual(b.value.status, 'mismatch');
  assert.strictEqual(b.value.autoMismatch, true);
  assert.deepStrictEqual(b.value.recorded, { kind: 'medicare_ffs', payerName: 'Medicare', memberId: VALID_MBI });
  assert.strictEqual(b.value.planTypeAsFound, 'medicare_advantage');
  assert.strictEqual(b.value.payerAsFound, 'Humana Gold Plus HMO');
  const s = ins.verificationState(c);
  assert.match(s.label, /Original Medicare/);
  assert.match(s.label, /Humana Gold Plus HMO/);
});

// ---- 8 & 11. the billing gate ------------------------------------------------
test('8. an unverified primary payer blocks claim release, naming the payer', () => {
  const g = ins.checkInsuranceForBilling(medicareClient());
  assert.strictEqual(g.ok, false);
  assert.strictEqual(g.code, 'BILLING_INSURANCE_UNVERIFIED');
  assert.strictEqual(g.message, 'Cannot submit to billing: Medicare coverage is unverified.');
  const ma = medicareClient({ intake: { medicare: { advantagePlan: 'Humana Gold Plus', advMemberId: 'H123', coverageStart: '2024-01-01' } } });
  assert.strictEqual(ins.checkInsuranceForBilling(ma).message, 'Cannot submit to billing: Humana Gold Plus coverage is unverified.');
  const c = medicareClient();
  verify(c, { status: 'verified', planTypeAsFound: 'medicare_ffs', payerAsFound: 'Medicare Part B' });
  assert.strictEqual(ins.checkInsuranceForBilling(c).ok, true);
  assert.strictEqual(ins.checkInsuranceForBilling({ intake: { payerType: 'Private pay' } }).ok, true, 'private pay has nothing to verify');
});

test('8b. ...and does NOT block signing the note: the gate sits on billing-submit only', () => {
  const src = read('server.js');
  const at = src.indexOf('insurance.checkInsuranceForBilling(');
  const submit = src.indexOf("app.post('/api/clinical/patients/:clientId/encounters/:euuid/billing-submit'");
  assert.ok(at > submit, 'the check is inside the billing-submit route');
  const next = src.indexOf('\napp.', submit + 10);
  assert.ok(at < next, 'and nowhere after it');
  assert.strictEqual((src.match(/insurance\.checkInsuranceForBilling\(/g) || []).length, 1, 'one call site');
  // Nothing in the clinical sign gate knows insurance exists.
  const repo = stripComments(read('clinicalRepository.js'));
  const sign = repo.slice(repo.indexOf('const checkSignReadiness'), repo.indexOf('\nconst ', repo.indexOf('const checkSignReadiness') + 10));
  assert.doesNotMatch(sign, /insurance/i);
  const ready = src.slice(src.indexOf('const readinessFor = '), src.indexOf('const readinessFor = ') + 3000);
  assert.doesNotMatch(ready.slice(0, ready.indexOf('\n};')), /insurance/i);
});

test('11. the admin override releases the claim with a logged reason; no reason, or not an admin, is refused', () => {
  const c = medicareClient();
  const ok = ins.checkInsuranceForBilling(c, { override: { reason: 'Verified by phone with Palmetto' }, isAdmin: true, actor: { id: 'a1', name: 'Admin' } });
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.status, 'overridden');
  assert.strictEqual(ok.override.reason, 'Verified by phone with Palmetto');
  assert.strictEqual(ok.override.overrode, 'BILLING_INSURANCE_UNVERIFIED');
  const noReason = ins.checkInsuranceForBilling(c, { override: { reason: '  ' }, isAdmin: true });
  assert.strictEqual(noReason.ok, false);
  assert.strictEqual(noReason.code, 'BILLING_OVERRIDE_REASON_REQUIRED');
  const manager = ins.checkInsuranceForBilling(c, { override: { reason: 'x' }, isAdmin: false });
  assert.strictEqual(manager.ok, false);
  assert.ok(manager.overrideRefused);
  // The route logs it and stores it on the record.
  const src = read('server.js');
  assert.match(src, /'billing_insurance_override'[\s\S]{0,200}reason: insuranceGate\.override\.reason/);
  assert.match(src, /insuranceCheck: \{ status: insuranceGate\.status, override: insuranceGate\.override \|\| null/);
});

// ---- 10. QMB: no statement --------------------------------------------------
test('10. a QMB patient generates no copay statement, collection task or balance transfer — Medicare Advantage too', () => {
  const qmbFfs = medicareClient({ intake: { qmb: 'Yes' } });
  const qmbMa = medicareClient({ intake: { qmb: 'Yes', medicare: { advantagePlan: 'Humana Gold Plus', advMemberId: 'H1' } } });
  for (const c of [qmbFfs, qmbMa]) {
    for (const kind of ['copay', 'collection_task', 'balance_transfer']) {
      const r = ins.qmbBlocksPatientBilling(c, kind);
      assert.strictEqual(r.blocked, true, kind);
      assert.strictEqual(r.code, 'QMB_NO_PATIENT_BILLING');
    }
  }
  assert.strictEqual(ins.qmbBlocksPatientBilling(medicareClient(), 'copay').blocked, false, 'unknown is not QMB');
  assert.strictEqual(ins.qmbBlocksPatientBilling(qmbFfs, 'home_care').blocked, false, 'private-pay home care is not Medicare cost sharing');
});

test('10b. the block sits on BOTH the creation and the sending of a copay statement', () => {
  const src = read('server.js');
  const create = src.slice(src.indexOf('const createCopayInvoice = '), src.indexOf('const isClientOrPoaFor'));
  assert.match(create, /qmbBlocksPatientBilling\(client, 'copay'\)[\s\S]{0,120}if \(qmbBlock\.blocked\)/);
  assert.ok(create.indexOf('qmbBlocksPatientBilling') < create.indexOf('buildInvoice'), 'refused before anything is built');
  const action = src.slice(src.indexOf("app.post('/api/gfc/admin/billing/invoices/:id/:action'"), src.indexOf("app.post('/api/webhooks/stripe'"));
  assert.match(action, /qmbBlocksPatientBilling\(qmbClient, inv\.kind\)/);
  assert.ok(action.indexOf('qmbBlocksPatientBilling') < action.indexOf('saveInvoice'));
});

// ---- 12. no X12 in the app --------------------------------------------------
test('12. no X12 or 271 parsing exists anywhere in the app', () => {
  const skip = new Set(['node_modules', '.git', 'docs', 'test']);
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (skip.has(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|html)$/.test(e.name)) files.push(p);
    }
  };
  walk(root);
  assert.ok(files.length > 50);
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    assert.doesNotMatch(src, /ISA\*|['"`]EB\*|\bST\*27[01]\b|\bparse(?:X12|Edi|271|270)\b|x12-parser|node-x12|edi-parser/i, `${path.relative(root, f)} parses X12`);
  }
});

// ---- 13. intake fields are declared -----------------------------------------
test('13. every new intake field resolves, and assertIntakeIsDeclared still passes', () => {
  require(path.join(root, 'appointmentTypes.js')); // throws at load if a reference does not resolve
  const added = ['qmb'];
  for (const b of ['medicare', 'medicaid', 'commercial', 'ltc']) added.push(`${b}.coverageStart`, `${b}.coverageEnd`, `${b}.rank`);
  for (const p of added) assert.ok(intakeFields.fieldAt(p), `${p} is declared`);
  assert.deepStrictEqual(intakeFields.OPTIONS.payerRank.map(x => ins.readRank(x)), ['primary', 'secondary', 'tertiary', 'not_billed']);
  assert.deepStrictEqual(intakeFields.OPTIONS.qmb.map(x => ins.readQmb({ intake: { qmb: x } })), ['unknown', 'yes', 'no']);
  // Nothing was renamed.
  for (const old of ['medicare.id', 'medicare.advantagePlan', 'medicaid.memberId', 'commercial.memberId', 'ltc.policyNum', 'payerType', 'insuranceTypes']) {
    assert.ok(intakeFields.fieldAt(old), `${old} still declared`);
  }
});

// ---- the OpenEMR row --------------------------------------------------------
test('C2. the OpenEMR row is the shape 8.4 validates, with no SSN and every refusal named', () => {
  const c = medicareClient();
  const e = ins.normalizePayers(c).primary;
  const r = ins.buildOpenEmrInsuranceRow({ entry: e, client: c, companyId: '33', assignmentSigned: true });
  assert.deepStrictEqual(r.row, {
    type: 'primary', provider: '33', plan_name: 'Medicare', policy_number: VALID_MBI,
    subscriber_fname: 'Juanita', subscriber_lname: 'Guess', subscriber_relationship: 'self',
    subscriber_DOB: '1941-03-09', subscriber_sex: 'Female',
    subscriber_street: '118 Hickory Log Dr', subscriber_city: 'Canton', subscriber_state: 'GA', subscriber_postal_code: '30114',
    accept_assignment: 'TRUE', date: '2024-01-01'
  });
  assert.strictEqual(ins.buildOpenEmrInsuranceRow({ entry: e, client: c, companyId: '' }).code, 'EMR_INSURANCE_COMPANY_REQUIRED');
  const noStart = medicareClient({ intake: { medicare: { id: VALID_MBI } } });
  assert.strictEqual(ins.buildOpenEmrInsuranceRow({ entry: ins.normalizePayers(noStart).primary, client: noStart, companyId: '33' }).code, 'EMR_INSURANCE_NO_START');
});

test('C2b. the write checks the BODY, because 8.4 answers a refused row with HTTP 200', () => {
  const src = read('openemr.js');
  const w = src.slice(src.indexOf('async writePatientInsurance'), src.indexOf('async getCoverage'));
  assert.match(w, /data\.validationErrors/);
  assert.match(w, /!saved \|\| !saved\.uuid/);
  assert.match(w, /insuranceScopeError\(res, 'write'\)/);
});

test('C1. docs/OPENEMR_COVERAGE.md no longer records the coverage write as a deliberate omission', () => {
  const doc = read('docs/OPENEMR_COVERAGE.md');
  assert.doesNotMatch(doc, /Writing a coverage row the app cannot verify would put an unchecked payer on a claim\.\s*\|/);
  assert.match(doc, /insurance/i);
});
