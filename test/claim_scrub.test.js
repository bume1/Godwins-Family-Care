'use strict';
// The claim scrub and the documentation gate (AI coding pipeline, Phase 1,
// 2026-11-04). One test per rule, each proving the rule fires AND that a clean
// claim passes it. The gate middleware is lifted out of server.js and RUN.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const S = require('../claimScrub');
const clinicalRepo = require('../clinicalRepository');
const emLevels = require('../emLevels');

const TODAY = '2026-11-04';
const FRESH = () => ({ ptp: { quarter: '2026Q4', loadedAt: new Date().toISOString() }, mue: { quarter: '2026Q4', loadedAt: new Date().toISOString() } });
const catalogOf = (active, inactive = []) => ({
  fetchedAt: new Date().toISOString(),
  codes: active.map(code => ({ code, modifier: '', codeType: /^\d/.test(code) ? 'CPT4' : 'HCPCS', shortLabel: code, longLabel: code })),
  inactive: inactive.map(code => ({ code, modifier: '', codeType: 'CPT4' }))
});

// A claim with nothing wrong with it.
const clean = (over = {}) => ({
  phase: 'final', today: TODAY,
  encounter: { date: '2026-11-02', facts: { checked: true, facilityId: '5', posCode: '12', facilityName: 'Private Residence' }, visit: { location: 'home', modality: 'in_person' } },
  encounterFacility: { id: '5', name: 'Private Residence', pos_code: '12' },
  facilityListKnown: true,
  billingFacility: { id: '3', name: 'Vinings', fieldsRead: true, npi: '1538078357', ein: '12-3456789', taxonomy: '363LF0000X' },
  renderingProvider: { name: 'Bethel Godwins', npi: '1902310568' },
  diagnoses: [{ code: 'I10', description: 'Essential (primary) hypertension' }],
  lines: [{ code: '99349', modifiers: [], units: 1, dxLinks: ['I10'], fee: 180 }],
  icd10: { I10: { exists: true, description: 'Essential (primary) hypertension', unspecified: false, moreSpecific: [] } },
  catalog: catalogOf(['99349', '99350', '99497', 'G0439']),
  ncci: { ptpEdits: [], mueByCode: { 99349: { mueValue: 1, mai: '2' } }, sourceVersion: FRESH() },
  payer: { kind: 'medicare_ffs', payerName: 'Medicare', memberId: '1EG4TE5MK73' },
  sameDayOtherCodes: [],
  // Phase 4.2: modifier 25 sits on a line only with the clinician's recorded reason.
  modifierJustifications: { '99349-25': { text: 'A separately identifiable problem was managed.' }, '99350-25': { text: 'A separately identifiable problem was managed.' } },
  ...over
});
const codesOf = (r) => r.findings.map(f => f.code);
const blocks = (r) => r.findings.filter(f => f.severity === 'block').map(f => f.code);
const warns = (r) => r.findings.filter(f => f.severity === 'warn').map(f => f.code);

test('a clean claim passes with no findings at all', () => {
  const r = S.scrubClaim(clean());
  assert.deepEqual(r.findings, [], JSON.stringify(r.findings));
  assert.equal(r.ok, true);
  assert.deepEqual(r.counts, { block: 0, warn: 0 });
});

test('every finding carries severity, code, message and the field it concerns', () => {
  const r = S.scrubClaim(clean({ renderingProvider: { name: 'X', npi: '' }, lines: [{ code: '99350', units: 1, dxLinks: ['I10'], fee: 1 }] }));
  assert.ok(r.findings.length >= 2);
  for (const f of r.findings) {
    assert.ok(['block', 'warn'].includes(f.severity));
    for (const k of ['code', 'message', 'field', 'fieldLabel']) assert.ok(f[k] && String(f[k]).length, `${f.code} has ${k}`);
  }
});

test('blockers sort before warnings, and nothing is dropped', () => {
  const r = S.scrubClaim(clean({
    lines: [{ code: '99350', modifiers: ['25'], units: 1, dxLinks: ['I10'], fee: 0 }],
    renderingProvider: { name: 'X', npi: null }
  }));
  const sev = r.findings.map(f => f.severity);
  assert.deepEqual(sev, [...sev].sort((a, b) => (a === 'block' ? 0 : 1) - (b === 'block' ? 0 : 1)));
  assert.ok(warns(r).includes('EM_HIGHEST_LEVEL') && warns(r).includes('MODIFIER_25_ALONE'), 'both warnings present');
  assert.equal(r.counts.block + r.counts.warn, r.findings.length);
});

// ---- 1.2 blocking rules ----
test('billing facility NPI, EIN and taxonomy: each missing one blocks, by name', () => {
  for (const [field, code] of [['npi', 'BILLING_FACILITY_NPI'], ['ein', 'BILLING_FACILITY_EIN'], ['taxonomy', 'BILLING_FACILITY_TAXONOMY']]) {
    const bf = { ...clean().billingFacility, [field]: '' };
    const r = S.scrubClaim(clean({ billingFacility: bf }));
    assert.deepEqual(blocks(r), [code], `${field} missing`);
    assert.match(r.findings[0].field, new RegExp(`billingFacility\\.${field}`));
    // "Missing" and "malformed" are different fixes, so they read differently.
    assert.match(r.findings[0].message, /has no /, `${field}: says it is missing, not that it is malformed`);
  }
  assert.deepEqual(blocks(S.scrubClaim(clean({ billingFacility: { ...clean().billingFacility, npi: '1538078358' } }))), ['BILLING_FACILITY_NPI'], 'a bad check digit is not an NPI');
  assert.deepEqual(blocks(S.scrubClaim(clean({ billingFacility: { ...clean().billingFacility, ein: '12-34567' } }))), ['BILLING_FACILITY_EIN']);
  assert.deepEqual(blocks(S.scrubClaim(clean({ billingFacility: { ...clean().billingFacility, taxonomy: '363LF0000' } }))), ['BILLING_FACILITY_TAXONOMY']);
});
test('a facility copy that predates the NPI/EIN/taxonomy read says NOT READ, never "missing"', () => {
  const r = S.scrubClaim(clean({ billingFacility: { id: '3', name: 'Vinings', fieldsRead: false } }));
  assert.deepEqual(blocks(r), ['BILLING_FACILITY_NOT_READ']);
  assert.deepEqual(blocks(S.scrubClaim(clean({ billingFacility: { id: null, error: 'none configured' } }))), ['BILLING_FACILITY_UNKNOWN']);
});
test('NPI check digit follows CMS: real NPIs pass, a one-digit change fails', () => {
  for (const ok of ['1234567893', '1538078357', '1902310568']) assert.equal(S.isValidNpi(ok), true, ok);
  for (const bad of ['1234567890', '123456789', 'ABCDEFGHIJ', '', null]) assert.equal(S.isValidNpi(bad), false, String(bad));
});

test('the rendering provider must have an individual NPI', () => {
  const none = S.scrubClaim(clean({ renderingProvider: { name: 'Bethel', npi: null } }));
  assert.deepEqual(blocks(none), ['RENDERING_PROVIDER_NPI']);
  assert.match(none.findings[0].message, /Bethel has no individual NPI/);
  assert.deepEqual(blocks(S.scrubClaim(clean({ renderingProvider: { name: 'Bethel', npi: '1902310569' } }))), ['RENDERING_PROVIDER_NPI']);
});

test('the encounter has a facility, and the place of service is the facility record\'s', () => {
  const enc = (facts) => ({ ...clean().encounter, facts });
  assert.deepEqual(blocks(S.scrubClaim(clean({ encounter: enc({ checked: false, error: 'timeout' }) }))), ['ENCOUNTER_FACILITY_NOT_CHECKED']);
  assert.deepEqual(blocks(S.scrubClaim(clean({ encounter: enc({ checked: true, facilityId: null, posCode: '12' }) }))), ['ENCOUNTER_NO_FACILITY']);
  assert.deepEqual(blocks(S.scrubClaim(clean({ encounter: enc({ checked: true, facilityId: '5', posCode: null }) }))), ['ENCOUNTER_NO_POS']);
  // Typed by hand on the encounter: it disagrees with its own facility.
  const typed = S.scrubClaim(clean({ encounter: enc({ checked: true, facilityId: '5', posCode: '11' }) }));
  assert.deepEqual(blocks(typed), ['POS_NOT_FROM_FACILITY']);
  assert.match(typed.findings[0].message, /\(11\).*Private Residence, 12/);
  assert.deepEqual(blocks(S.scrubClaim(clean({ encounterFacility: null }))), ['ENCOUNTER_FACILITY_UNKNOWN']);
  assert.deepEqual(blocks(S.scrubClaim(clean({ encounterFacility: { id: '5', name: 'X', pos_code: '' } }))), ['FACILITY_NO_POS']);
  assert.deepEqual(blocks(S.scrubClaim(clean({ facilityListKnown: false, encounterFacility: null }))), ['ENCOUNTER_FACILITY_NOT_CHECKED'], 'no facility list is NOT CHECKED, not a pass');
});

test('every charge line points at a diagnosis on this encounter', () => {
  assert.deepEqual(blocks(S.scrubClaim(clean({ lines: [{ code: '99349', units: 1, dxLinks: [], fee: 1 }] }))), ['LINE_NO_DIAGNOSIS']);
  assert.deepEqual(blocks(S.scrubClaim(clean({ lines: [{ code: '99349', units: 1, dxLinks: ['E11.9'], fee: 1 }] }))), ['LINE_DX_NOT_ON_ENCOUNTER']);
  assert.deepEqual(blocks(S.scrubClaim(clean({ diagnoses: [], lines: [{ code: '99349', units: 1, dxLinks: ['I10'], fee: 1 }] }))).sort(), ['CLAIM_NO_DIAGNOSIS', 'LINE_DX_NOT_ON_ENCOUNTER'].sort());
  assert.deepEqual(blocks(S.scrubClaim(clean({ lines: [] }))), ['CLAIM_NO_LINES']);
});

test('every diagnosis pointed at exists in OpenEMR\'s ICD-10 table; an unchecked one blocks as NOT CHECKED', () => {
  assert.deepEqual(blocks(S.scrubClaim(clean({ icd10: { I10: { exists: false } } }))), ['DX_NOT_IN_ICD10']);
  assert.deepEqual(blocks(S.scrubClaim(clean({ icd10: {} }))), ['DX_NOT_CHECKED']);
});

test('every code exists in OpenEMR\'s codes table and is active', () => {
  assert.deepEqual(blocks(S.scrubClaim(clean({ catalog: catalogOf(['99350']) }))), ['LINE_CODE_MISSING']);
  assert.deepEqual(blocks(S.scrubClaim(clean({ catalog: catalogOf(['99350'], ['99349']) }))), ['LINE_CODE_INACTIVE']);
  assert.deepEqual(blocks(S.scrubClaim(clean({ catalog: null }))), ['CODE_CATALOG_NOT_LOADED']);
});
test('a stale catalog is stated with the date it was refreshed', () => {
  const cat = { ...catalogOf(['99349']), fetchedAt: '2026-10-01T00:00:00.000Z' };
  const r = S.scrubClaim(clean({ catalog: cat }));
  assert.deepEqual(warns(r), ['CODE_CATALOG_STALE']);
  assert.match(r.findings[0].message, /2026-10-01/);
});

test('every line carries a price greater than zero (final phase); before posting there is no price to judge', () => {
  assert.deepEqual(blocks(S.scrubClaim(clean({ lines: [{ code: '99349', units: 1, dxLinks: ['I10'], fee: 0 }] }))), ['LINE_PRICE_ZERO']);
  assert.deepEqual(blocks(S.scrubClaim(clean({ lines: [{ code: '99349', units: 1, dxLinks: ['I10'], fee: null }] }))), ['LINE_PRICE_UNKNOWN']);
  assert.deepEqual(blocks(S.scrubClaim(clean({ phase: 'pre_post', lines: [{ code: '99349', units: 1, dxLinks: ['I10'], fee: null }] }))), []);
});

test('MUE: MAI 2 over the cap blocks; MAI 1 and 3 warn and ask for documentation', () => {
  const line = { code: '99349', units: 2, dxLinks: ['I10'], fee: 1 };
  const mue = (mai) => ({ ...clean().ncci, mueByCode: { 99349: { mueValue: 1, mai } } });
  const two = S.scrubClaim(clean({ lines: [line], ncci: mue('2') }));
  assert.deepEqual(blocks(two), ['MUE_ABSOLUTE']);
  assert.match(two.findings[0].message, /absolute/);
  for (const mai of ['1', '3']) {
    const r = S.scrubClaim(clean({ lines: [line], ncci: mue(mai) }));
    assert.deepEqual(blocks(r), [], `MAI ${mai}`);
    assert.deepEqual(warns(r), ['MUE_DOCUMENTATION_REQUIRED']);
    assert.match(r.findings[0].message, /documentation/);
    assert.equal(r.findings[0].field, 'lines[0].units');
  }
  assert.deepEqual(blocks(S.scrubClaim(clean({ lines: [line], ncci: mue(null) }))), ['MUE_ABSOLUTE'], 'unknown MAI is absolute');
});

test('NCCI PTP runs again on THIS charge set', () => {
  const lines = [{ code: '99349', units: 1, dxLinks: ['I10'], fee: 1 }, { code: '99497', units: 1, dxLinks: ['I10'], fee: 1 }];
  const edit = (ind) => ({ ...clean().ncci, ptpEdits: [{ column1Code: '99349', column2Code: '99497', modifierIndicator: ind }] });
  assert.deepEqual(blocks(S.scrubClaim(clean({ lines, ncci: edit(0) }))), ['NCCI_PTP_BLOCKED']);
  assert.deepEqual(blocks(S.scrubClaim(clean({ lines, ncci: edit(1) }))), ['NCCI_PTP_MODIFIER_REQUIRED']);
  const withMod = [{ ...lines[0], modifiers: ['25'] }, lines[1]];
  const flagged = S.scrubClaim(clean({ lines: withMod, ncci: edit(1) }));
  assert.deepEqual(blocks(flagged), []);
  assert.ok(warns(flagged).includes('NCCI_PTP_MODIFIER_PRESENT'));
});
test('a stale NCCI dataset blocks and states when each half was loaded, even with no lines', () => {
  const sv = { ptp: { quarter: '2026Q1', loadedAt: '2026-01-05T00:00:00.000Z' }, mue: { quarter: '2026Q1', loadedAt: '2026-01-05T00:00:00.000Z' } };
  const r = S.scrubClaim(clean({ lines: [], ncci: { ptpEdits: [], mueByCode: {}, sourceVersion: sv } }));
  assert.ok(blocks(r).includes('NCCI_DATA_STALE'));
  assert.match(r.findings.find(f => f.code === 'NCCI_DATA_STALE').message, /2026Q1, loaded 2026-01-05/);
});

test('the patient has an insurance record with a policy number', () => {
  assert.deepEqual(blocks(S.scrubClaim(clean({ payer: null }))), ['PATIENT_NO_INSURANCE']);
  assert.deepEqual(blocks(S.scrubClaim(clean({ payer: { kind: 'commercial', payerName: 'Aetna', memberId: '' } }))), ['PATIENT_NO_POLICY_NUMBER']);
  assert.deepEqual(blocks(S.scrubClaim(clean({ payerProblem: 'Two primaries.' }))), ['PATIENT_PAYER_UNRESOLVED']);
  assert.deepEqual(blocks(S.scrubClaim(clean({ payer: { kind: 'commercial', payerName: 'Aetna', memberId: 'W123' } }))), []);
  assert.deepEqual(blocks(S.scrubClaim(clean({ payer: { kind: 'private_pay', payerName: 'Private pay' } }))), [], 'self-pay is not a claim to a payer');
});
test('for Original Medicare the policy number matches CMS\'s 11-character MBI format', () => {
  for (const bad of ['1EG4TE5MK7', '1EG4TE5MK7S', '0EG4TE5MK73', 'ABCDEFGHIJK']) {
    assert.deepEqual(blocks(S.scrubClaim(clean({ payer: { kind: 'medicare_ffs', payerName: 'Medicare', memberId: bad } }))), ['PATIENT_MBI_FORMAT'], bad);
  }
  // CMS's own example, with the card's dashes.
  assert.deepEqual(blocks(S.scrubClaim(clean({ payer: { kind: 'medicare_ffs', payerName: 'Medicare', memberId: '1EG4-TE5-MK73' } }))), []);
  // An Advantage plan's member id is the plan's, not an MBI.
  assert.deepEqual(blocks(S.scrubClaim(clean({ payer: { kind: 'medicare_advantage', payerName: 'Humana', memberId: 'H1234' } }))), []);
});

test('the date of service is not in the future and is within twelve months', () => {
  const at = (date) => ({ encounter: { ...clean().encounter, date } });
  assert.deepEqual(blocks(S.scrubClaim(clean(at('2026-11-05')))), ['DOS_FUTURE']);
  assert.deepEqual(blocks(S.scrubClaim(clean(at('2025-11-03')))), ['DOS_OUTSIDE_12_MONTHS']);
  assert.deepEqual(blocks(S.scrubClaim(clean(at('2025-11-04')))), [], 'exactly twelve months is inside');
  assert.deepEqual(blocks(S.scrubClaim(clean(at(null)))), ['DOS_MISSING']);
});

// ---- 1.3 warning rules ----
test('modifier 25 with no other billable service on the same date warns; another service clears it', () => {
  const l25 = { code: '99349', modifiers: ['25'], units: 1, dxLinks: ['I10'], fee: 1 };
  assert.deepEqual(warns(S.scrubClaim(clean({ lines: [l25] }))), ['MODIFIER_25_ALONE']);
  assert.deepEqual(warns(S.scrubClaim(clean({ lines: [l25, { code: '99497', units: 1, dxLinks: ['I10'], fee: 1 }] }))), []);
  assert.deepEqual(warns(S.scrubClaim(clean({ lines: [l25], sameDayOtherCodes: ['99497'] }))), [], 'another encounter the same day counts');
});
test('an unspecified ICD-10 code warns when OpenEMR lists a more specific sibling', () => {
  const r = S.scrubClaim(clean({
    diagnoses: [{ code: 'E11.9' }], lines: [{ code: '99349', units: 1, dxLinks: ['E11.9'], fee: 1 }],
    icd10: { 'E11.9': { exists: true, unspecified: true, moreSpecific: ['E11.65', 'E11.22'] } }
  }));
  assert.deepEqual(warns(r), ['DX_UNSPECIFIED']);
  assert.match(r.findings[0].message, /E11\.65/);
  const none = S.scrubClaim(clean({
    diagnoses: [{ code: 'R69' }], lines: [{ code: '99349', units: 1, dxLinks: ['R69'], fee: 1 }],
    icd10: { R69: { exists: true, unspecified: true, moreSpecific: [] } }
  }));
  assert.deepEqual(warns(none), [], 'no sibling, no warning');
});
test('the highest E/M level in its family warns and says it is not wrong', () => {
  for (const code of ['99345', '99350', '99205', '99215']) {
    const r = S.scrubClaim(clean({ lines: [{ code, units: 1, dxLinks: ['I10'], fee: 1 }], catalog: catalogOf([code]), ncci: { ...clean().ncci, mueByCode: {} } }));
    assert.deepEqual(warns(r), ['EM_HIGHEST_LEVEL'], code);
    assert.match(r.findings[0].message, /Not wrong/);
  }
  assert.deepEqual(warns(S.scrubClaim(clean())), [], '99349 is not the top');
});

test('no finding coaches toward a code: messages never tell anyone to document to reach a level', () => {
  const r = S.scrubClaim(clean({ lines: [{ code: '99350', modifiers: ['25'], units: 3, dxLinks: ['I10'], fee: 0 }], ncci: { ...clean().ncci, mueByCode: { 99350: { mueValue: 1, mai: '3' } } } }));
  for (const f of r.findings) assert.doesNotMatch(f.message, /document \d+ minutes|to reach 99\d{3}|to bill 99\d{3}/i, f.code);
});

// ---- ICD-10 lookups and OpenEMR's charge rows ----
test('an ICD-10 lookup is built only from OpenEMR\'s own rows', () => {
  const exact = [{ code: 'E11.9', code_text: 'Type 2 diabetes mellitus without complications' }];
  const cat = [{ code: 'E11.65', code_text: 'Type 2 diabetes mellitus with hyperglycemia' }, { code: 'E11.9', code_text: 'Type 2 diabetes mellitus without complications' }];
  const plain = S.buildIcd10Lookup('E11.9', exact, cat);
  assert.equal(plain.exists, true);
  assert.equal(plain.unspecified, false, '"without complications" is not the word unspecified');
  const r = S.buildIcd10Lookup('R51.9', [{ code: 'R51.9', code_text: 'Headache, unspecified' }], [{ code: 'R51.0', code_text: 'Headache with orthostatic component, not elsewhere classified' }]);
  assert.deepEqual(r.moreSpecific, ['R51.0']);
  assert.equal(S.buildIcd10Lookup('Z99.99', [], []).exists, false);
  assert.equal(S.parentOf('E11.9'), 'E11');
  assert.equal(S.parentOf('I10'), null, 'a three-character code has no parent to search');
});
test('OpenEMR charge rows become scrub lines, ICD10 pointer rows excluded', () => {
  const lines = S.linesFromCharges([
    { code: '99349', code_type: 'CPT4', modifier: '25', units: '1', fee: '180.00', justify: 'ICD10|I10:ICD10|E11.9:' },
    { code: 'I10', code_type: 'ICD10', fee: '0' }
  ]);
  assert.deepEqual(lines, [{ code: '99349', modifiers: ['25'], units: 1, dxLinks: ['I10', 'E11.9'], fee: 180 }]);
});
test('the hold queue: awaiting billing, held after submission, released by a person', () => {
  const BS = clinicalRepo.BILLING_STATUS;
  assert.equal(S.holdState({}, BS.AWAITING_BILLING), 'awaiting_billing');
  assert.equal(S.holdState({}, BS.BILLED), 'held');
  assert.equal(S.holdState({ claimRelease: { at: 'x' } }, BS.BILLED), 'released');
  assert.equal(S.holdState({}, BS.NO_CHARGE), null);
  assert.equal(S.holdState({}, BS.NOT_SIGNED), null);
});

// ---- 1.4 the documentation gate ----
test('the documentation gate names exactly what is missing', () => {
  const g = S.documentationGate({ record: { diagnoses: [], note: {} }, totalMinutes: null, noteState: 'draft' });
  assert.deepEqual(g.missing, ['total_time', 'diagnosis', 'note']);
  assert.match(g.error, /total time in minutes.*diagnosis.*note/);
  const one = S.documentationGate({ record: { diagnoses: [{ code: 'I10' }], narrativeNoteSid: '9' }, totalMinutes: null, noteState: 'draft' });
  assert.deepEqual(one.missing, ['total_time']);
  assert.equal(S.documentationGate({ record: { diagnoses: [{ code: 'I10' }], note: { plan: 'Recheck in 2 weeks' } }, totalMinutes: 40, noteState: 'draft' }).ok, true);
  assert.equal(S.documentationGate({ record: { diagnoses: [{ code: 'I10' }] }, totalMinutes: 40, noteState: 'signed' }).ok, true, 'an author-signed note counts');
  assert.deepEqual(S.documentationGate({ record: { diagnoses: [{ code: 'I10' }], note: { plan: '- ' } }, totalMinutes: 40, noteState: 'draft' }).missing, ['note'], 'an empty bullet is not a note');
});
test('total time is a number, never prose', () => {
  assert.deepEqual(S.parseTotalMinutes('45'), { ok: true, minutes: 45 });
  for (const bad of ['about 40', '40 min', '0', '-5', '4.5', '', '99999']) assert.equal(S.parseTotalMinutes(bad).ok, false, bad);
});

// ---- server wiring, read from source and run ----
const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const routeLine = (frag) => serverSrc.split('\n').find(l => l.startsWith('app.') && l.includes(frag)) || '';

test('the gate is MIDDLEWARE on both doors into the coding queue, so the route sweep sees it', () => {
  assert.match(routeLine("/encounters/:euuid/sign'"), /requireClinicalWrite, requireCodingQueueReady\('sign'\)/);
  assert.match(routeLine("/encounters/:euuid/co-sign'"), /requireClinicalWrite, requireCodingQueueReady\('addendum'\)/);
});
test('the scrub routes are billing\'s alone', () => {
  assert.match(routeLine("/claim-scrub'"), /^app\.get\(.*requireBilling/);
  assert.match(routeLine("/claim-release'"), /^app\.post\(.*requireBilling/);
});
test('Submit to billing runs the scrub before anything posts; Release re-reads OpenEMR\'s lines', () => {
  const submit = serverSrc.slice(serverSrc.indexOf("encounters/:euuid/billing-submit', authenticateToken"));
  const scrubAt = submit.indexOf("liveClaimScrub(ctx, { phase: 'pre_post'");
  const postAt = submit.indexOf('await postEncounterCharges(');
  assert.ok(scrubAt > 0 && postAt > scrubAt, 'the scrub runs before the charge write');
  assert.match(submit.slice(scrubAt, postAt), /if \(!pre\.scrub\.ok\)[\s\S]*?CLAIM_SCRUB_BLOCKED/);
  const live = serverSrc.slice(serverSrc.indexOf('const liveClaimScrub ='), serverSrc.indexOf('// ---- The documentation gate (spec §1.4)'));
  assert.match(live, /phase === 'final'[\s\S]*?getCharges\(/, 'the final phase reads the lines OpenEMR holds');
});
test('the server maps getNcciTables field names onto the scrub\'s, or every claim reads "never loaded"', () => {
  const run = serverSrc.slice(serverSrc.indexOf('const runClaimScrub ='), serverSrc.indexOf('const liveClaimScrub ='));
  assert.match(run, /ncci: \{ ptpEdits: ncci\.ncciPtpEdits, mueByCode: ncci\.ncciMue, sourceVersion: ncci\.ncciSourceVersion \}/);
});
test('the scrub panel renders only inside billing\'s card, never on a clinician screen', () => {
  const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'clinical.html'), 'utf8');
  const uses = page.split('<ClaimScrubPanel ').length - 1;
  assert.equal(uses, 1, 'one use');
  const at = page.indexOf('<ClaimScrubPanel ');
  const card = page.lastIndexOf("{on('sign') && closed && ba.canBill", at);
  assert.ok(card > 0 && at - card < 2000, 'inside the Billing card, which only billing sees');
});

// Lift requireCodingQueueReady (and encounterTotalMinutes) out of server.js and
// run it against fakes shaped like production.
const liftGate = (deps) => {
  const start = serverSrc.indexOf('const encounterTotalMinutes = async');
  const end = serverSrc.indexOf('// ── Sign & close (Scope F, spec §3 normative)');
  assert.ok(start > 0 && end > start, 'gate source found');
  const body = serverSrc.slice(start, end);
  // eslint-disable-next-line no-new-func
  return new Function(...Object.keys(deps), `${body}\nreturn requireCodingQueueReady;`)(...Object.values(deps));
};
const runGate = async ({ door, user, records, attestations = [], body = { attest: true, text: 'Agree with the plan.' }, links = [], timings = [] }) => {
  const gate = liftGate({
    loadRows: async (n) => (n === 'encounter_billing' ? records : n === 'encounter_attestations' ? attestations : []),
    findBillingRecord: (rows, id) => rows.find(r => r.encounterUuid === String(id)) || null,
    clinicalRoles: require('../clinicalRoles'), clinicalNotes: require('../clinicalNotes'), clinicalRepo, claimScrub: S,
    getAppointmentLinkage: async () => links, loadVisitTimings: async () => timings, myDay: require('../myDay')
  })(door);
  const req = { user, params: { clientId: 'c1', euuid: 'e1' }, body };
  let out = null; let nexted = false;
  const res = { status(c) { out = { status: c }; return this; }, json(b) { out = { ...out, body: b }; return this; } };
  await gate(req, res, () => { nexted = true; });
  return { nexted, out, req };
};
const NP = { id: 'u1', role: 'user', hasClinicalAccess: true, clinicalRole: 'provider' };
const RN = { id: 'u2', role: 'user', hasClinicalAccess: true, clinicalRole: 'rn' };
const REC = (over = {}) => ({ encounterUuid: 'e1', clientId: 'c1', diagnoses: [{ code: 'I10' }], narrativeNoteSid: '7', ...over });

test('RUN: a billable signature with no time and no diagnosis is refused, naming both, and nothing passes', async () => {
  const r = await runGate({ door: 'sign', user: NP, records: [REC({ diagnoses: [] })] });
  assert.equal(r.nexted, false);
  assert.equal(r.out.status, 409);
  assert.equal(r.out.body.code, 'CODING_QUEUE_GATE');
  assert.deepEqual(r.out.body.missing, ['total_time', 'diagnosis']);
  assert.ok(r.out.body.codes.includes('SIGN_NO_DIAGNOSIS'), 'the sign card still offers Go to Coding');
  assert.match(r.out.body.error, /ICD-10 diagnosis/);
});
test('RUN: typed minutes pass the gate and ride on the request to the handler', async () => {
  const r = await runGate({ door: 'sign', user: NP, records: [REC()], body: { attest: true, totalMinutes: '45' } });
  assert.equal(r.nexted, true);
  assert.deepEqual(r.req.codingQueueEntry, { totalMinutes: 45, totalMinutesSource: 'entered' });
});
test('RUN: prose is refused as prose', async () => {
  const r = await runGate({ door: 'sign', user: NP, records: [REC()], body: { attest: true, totalMinutes: 'about 40' } });
  assert.equal(r.out.status, 400);
  assert.equal(r.out.body.code, 'TOTAL_TIME_NOT_A_NUMBER');
});
test('RUN: the recorded start and end on My Day count, the scheduled duration never does', async () => {
  const myDay = require('../myDay');
  const links = [{ eid: '501', encounterUuid: 'e1' }];
  const timings = [{ id: myDay.timingId('501'), startedAt: '2026-11-03T14:00:00Z', endedAt: '2026-11-03T14:42:00Z', scheduledMinutes: 60 }];
  const r = await runGate({ door: 'sign', user: NP, records: [REC()], links, timings });
  assert.equal(r.nexted, true);
  assert.deepEqual(r.req.codingQueueEntry, { totalMinutes: 42, totalMinutesSource: 'recorded_start_end' });
  const noEnd = await runGate({ door: 'sign', user: NP, records: [REC()], links, timings: [{ ...timings[0], endedAt: null }] });
  assert.equal(noEnd.out.status, 409, 'a started visit with no end has no total time');
});
test('RUN: an RN author signature does not enter the queue and passes; her clinician addendum is gated', async () => {
  const a = await runGate({ door: 'sign', user: RN, records: [REC({ diagnoses: [] })] });
  assert.equal(a.nexted, true);
  const add = await runGate({ door: 'addendum', user: NP, records: [REC({ coSignStatus: 'pending', diagnoses: [] })] });
  assert.equal(add.out.status, 409);
  assert.deepEqual(add.out.body.missing, ['total_time', 'diagnosis'], 'an author-signed note counts as the note');
});
test('RUN: a request the handler will refuse for its own reason passes the gate, so that reason is what the person reads', async () => {
  const closed = await runGate({ door: 'sign', user: NP, records: [REC({ diagnoses: [] })], attestations: [{ encounterUuid: 'e1', signedAt: 'x', signedBy: { id: 'u9' } }] });
  assert.equal(closed.nexted, true, 'already signed: the handler says ENCOUNTER_CLOSED');
  const voided = await runGate({ door: 'sign', user: NP, records: [REC({ noteStatus: 'voided', diagnoses: [] })] });
  assert.equal(voided.nexted, true);
  const wrongClient = await runGate({ door: 'sign', user: NP, records: [REC({ clientId: 'c2', diagnoses: [] })] });
  assert.equal(wrongClient.nexted, true, 'the handler reports the client mismatch itself');
  const unattested = await runGate({ door: 'sign', user: NP, records: [REC({ diagnoses: [] })], body: {} });
  assert.equal(unattested.nexted, true, 'no attestation: the handler asks for it');
  const blankText = await runGate({ door: 'addendum', user: NP, records: [REC({ coSignStatus: 'pending', diagnoses: [] })], body: { attest: true, text: '' } });
  assert.equal(blankText.nexted, true, 'a blank addendum: the handler asks for the text');
  const lcswEm = await runGate({ door: 'addendum', user: { ...NP, clinicalRole: 'lcsw' }, records: [REC({ coSignStatus: 'pending', diagnoses: [], services: [{ code: '99349' }] })] });
  assert.equal(lcswEm.nexted, true, 'wrong credential for the codes: the handler says so');
});

// ---- the level table (spec §3.1), as far as Phase 1 reads it ----
test('emLevels.js is verified, carries its provenance, and has a known review date', () => {
  assert.equal(emLevels.verified, true);
  assert.equal(emLevels.verifiedOn, '2026-11-04');
  assert.equal(emLevels.nextReviewDue, '2027-01-01');
  assert.equal(emLevels.verifiedAgainst.length, 3);
  assert.equal(emLevels.FAMILIES.length, 4);
  assert.equal(emLevels.FAMILIES.flatMap(f => f.levels).length, 16);
  assert.equal(emLevels.reviewStatus('2026-12-31').overdue, false);
  assert.equal(emLevels.reviewStatus('2027-01-01').overdue, true);
});
