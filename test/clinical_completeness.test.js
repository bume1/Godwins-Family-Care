// ============================================================
// Session 4.4 — clinical completeness P0 invariants (build-fail guards)
//
// Pure-function tests over clinicalRepository.js:
//   1. Code FORMAT validation only — the app keeps no code list (spec §7).
//   2. Follow-up SOAP writes carry the acting clinician's name + NPI in the
//      note header AND the encounter record (attribution interim, spec §4).
//   3. Coding: every service links to an encounter diagnosis; the billing
//      provider NPI is whatever config passes in — never a literal (§2.5).
//   4. Sign & close is refused with a SPECIFIC code until note + ≥1 dx +
//      ≥1 svc + billing NPI exist; a closed encounter is read-only and
//      corrections are addenda with their own signer + timestamp (§3).
//   5. Rx / order builders: record-only, status transitions are gated.
//   6. Coding assist T1/T2: proposals only, per-clinician, overridable (§8).
//   7. The structured note is machine-parseable: render → parse round-trips.
// Run: npm test
// ============================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../clinicalRepository');

const FNP = { id: 'u-fnp', name: 'Bethel Godwins', licenseLevel: 'FNP-C', npi: '1234567893', openEmrProviderId: '5' };
const RN = { id: 'u-rn', name: 'Test Nurse', licenseLevel: 'RN', npi: null };
const BILLING_NPI = '1999999992'; // passed in as "config" — the point is that it is an argument
const DX = [{ code: 'E11.9', description: 'Type 2 diabetes', primary: true }, { code: 'I10', description: 'Essential hypertension' }];
const SVC = [{ code: '99348', units: 1, dxLinks: ['E11.9', 'I10'] }];
const baseRecord = () => R.buildEncounterBillingRecord({
  id: 'eb-1', clientId: 'c-1', puuid: 'p-uuid', encounterUuid: 'enc-uuid', encounterEid: 19,
  reason: 'Follow-up', date: '2026-09-04', actor: FNP, billingNpi: BILLING_NPI, narrativeNoteSid: '5', at: '2026-09-04T10:00:00.000Z'
});

// ---- 1. Code format validation ----
test('ICD-10 normalization accepts real formats, dots the undotted form, rejects junk', () => {
  assert.equal(R.normalizeIcd10('e119'), 'E11.9');
  assert.equal(R.normalizeIcd10(' ICD10:Z79.899 '), 'Z79.899');
  assert.equal(R.normalizeIcd10('I10'), 'I10');
  assert.equal(R.normalizeIcd10('12345'), null);
  assert.equal(R.normalizeIcd10('E'), null);
  assert.equal(R.normalizeIcd10(''), null);
});
test('service codes classify as CPT or HCPCS by format only', () => {
  assert.deepEqual(R.classifyServiceCode('99347'), { code: '99347', codeType: 'CPT4' });
  assert.deepEqual(R.classifyServiceCode('g0506'), { code: 'G0506', codeType: 'HCPCS' });
  assert.equal(R.classifyServiceCode('9934'), null);
  assert.equal(R.classifyServiceCode('ABCDE'), null);
});
test('default service favorites are code numbers + family labels, not AMA descriptors', () => {
  assert.ok(R.DEFAULT_SERVICE_CODE_FAVORITES.length >= 8);
  for (const f of R.DEFAULT_SERVICE_CODE_FAVORITES) {
    assert.equal(R.classifyServiceCode(f.code).codeType, 'CPT4');
    assert.ok(f.label.length < 50, 'labels are short family names');
  }
  // an admin list with a bad code is dropped, never stored
  assert.deepEqual(R.sanitizeServiceFavorites([{ code: 'nope' }, { code: '99350', label: 'x' }]).map(f => f.code), ['99350']);
});

// ---- 2. Follow-up writes + attribution ----
test('follow-up writes stamp the clinician name + NPI on the note header and the encounter record', () => {
  const w = R.buildFollowUpWrites({ reason: 'Diabetes follow-up', subjective: 'Feels well', vitals: { bpSys: '128', bpDia: '78', hr: '72' } }, FNP, { serviceAccount: 'gfc-app-api' });
  assert.ok(!w.error);
  assert.match(w.soapNote.subjective, /^\[GFC CLINICIAN\] Bethel Godwins, FNP-C \(NPI 1234567893\)/);
  assert.match(w.soapNote.subjective, /gfc-app-api/);
  assert.match(w.encounter.reason, /Diabetes follow-up — Bethel Godwins, FNP-C \(NPI 1234567893\)/);
  assert.match(w.encounter.billing_note, /Rendering clinician: Bethel Godwins/);
  assert.equal(w.encounter.class_code, 'HH');
  // vitals preserved verbatim in the objective (server-side vitals defect)
  assert.match(w.soapNote.objective, /BP 128\/78; HR 72/);
  assert.equal(w.vitals.bps, '128');
});
test('follow-up without vitals writes no vitals form and never sends an empty SOAP section', () => {
  const w = R.buildFollowUpWrites({ reason: 'Check-in' }, RN);
  assert.equal(w.vitals, null);
  for (const k of ['subjective', 'objective', 'assessment', 'plan']) assert.ok(w.soapNote[k].length >= 2, `${k} non-empty`);
  assert.match(w.soapNote.subjective, /NPI not on file/);
  assert.equal(R.buildFollowUpWrites({}, RN).code, 'ENCOUNTER_NO_REASON');
  // a 1-character section would be rejected by OpenEMR's validator (HTTP 200 + map, no note written)
  const stray = R.buildFollowUpWrites({ reason: 'x', subjective: 'S', objective: 'O', assessment: 'A', plan: 'P' }, RN);
  for (const k of ['subjective', 'objective', 'assessment', 'plan']) assert.ok(stray.soapNote[k] === '' || stray.soapNote[k].length >= 2, `${k} never 1 char`);
  const hp = R.buildHpWrites({ vitals: { bpRightSys: '130', bpLeftSys: '128' }, subjective: 'S', assessment: 'A', plan: 'P' }, 'RN');
  for (const k of ['subjective', 'objective', 'assessment', 'plan']) assert.ok(hp.soapNote[k] === '' || hp.soapNote[k].length >= 2, `H&P ${k} never 1 char`);
});

// ---- 3. Coding ----
test('diagnoses dedupe, default a primary, and reject bad codes', () => {
  const r = R.buildEncounterDiagnoses([{ code: 'e119', description: 'T2DM' }, { code: 'E11.9' }, { code: 'I10' }]);
  assert.deepEqual(r.diagnoses.map(d => d.code), ['E11.9', 'I10']);
  assert.equal(r.diagnoses[0].primary, true);
  assert.equal(r.diagnoses[1].primary, false);
  assert.equal(R.buildEncounterDiagnoses([{ code: 'bad' }]).code, 'DX_BAD_CODE');
  assert.equal(R.buildEncounterDiagnoses('nope').code, 'DX_INVALID');
});
test('every service must link to a diagnosis ON THIS ENCOUNTER', () => {
  const dx = R.buildEncounterDiagnoses(DX).diagnoses;
  assert.equal(R.buildEncounterServices([{ code: '99348', dxLinks: [] }], dx).code, 'SVC_DX_LINK_REQUIRED');
  assert.equal(R.buildEncounterServices([{ code: '99348', dxLinks: ['J45.909'] }], dx).code, 'SVC_DX_LINK_UNKNOWN');
  assert.equal(R.buildEncounterServices([{ code: '9934', dxLinks: ['I10'] }], dx).code, 'SVC_BAD_CODE');
  const ok = R.buildEncounterServices([{ code: '99348', units: '2', dxLinks: ['I10'], modifiers: ['25'] }], dx);
  assert.deepEqual(ok.services[0], { code: '99348', codeType: 'CPT4', label: '', units: 2, modifiers: ['25'], dxLinks: ['I10'] });
});
test('coding state flips to coded only with ≥1 dx and ≥1 linked svc; billing NPI is the passed config value', () => {
  const rec = baseRecord();
  assert.equal(rec.codingStatus, 'not_coded');
  assert.equal(rec.billingProviderNpi, BILLING_NPI);
  assert.equal(rec.renderingProvider.npi, FNP.npi);
  const dxOnly = R.applyCoding(rec, { diagnoses: DX, services: [] }, FNP, BILLING_NPI, '2026-09-04T11:00:00.000Z').record;
  assert.equal(dxOnly.codingStatus, 'not_coded');
  assert.deepEqual(R.deriveCodingStatus(dxOnly).missing, ['service']);
  const coded = R.applyCoding(dxOnly, { diagnoses: DX, services: SVC }, FNP, BILLING_NPI, '2026-09-04T11:05:00.000Z').record;
  assert.equal(coded.codingStatus, 'coded');
  assert.equal(coded.codedAt, '2026-09-04T11:05:00.000Z');
  assert.equal(coded.codedBy.name, FNP.name);
  // never a hardcoded NPI: a different config value flows straight through
  const other = R.applyCoding(rec, { diagnoses: DX, services: SVC }, FNP, '1000000004').record;
  assert.equal(other.billingProviderNpi, '1000000004');
  const none = R.buildEncounterBillingRecord({ id: 'x', clientId: 'c', puuid: 'p', encounterUuid: 'e', actor: FNP, billingNpi: null });
  assert.equal(none.billingProviderNpi, null);
  assert.equal(R.applyCoding(rec, { diagnoses: DX, services: [{ code: '99348', dxLinks: [] }] }, FNP, BILLING_NPI).code, 'SVC_DX_LINK_REQUIRED');
});

// ---- 4. Sign & close ----
test('signing is refused with a specific code for each missing element', () => {
  const rec = baseRecord();
  // POS is supplied in every case below except the one testing its absence:
  // a signed encounter becomes a claim, so it needs a real place of service.
  const POS = '12';
  assert.deepEqual(R.checkSignReadiness({ hasNote: false, record: rec, billingNpi: BILLING_NPI, posCode: POS }).codes, ['SIGN_NO_NOTE', 'SIGN_NO_DIAGNOSIS', 'SIGN_NO_SERVICE']);
  const dxOnly = R.applyCoding(rec, { diagnoses: DX, services: [] }, FNP, BILLING_NPI).record;
  assert.deepEqual(R.checkSignReadiness({ hasNote: true, record: dxOnly, billingNpi: BILLING_NPI, posCode: POS }).codes, ['SIGN_NO_SERVICE']);
  const coded = R.applyCoding(rec, { diagnoses: DX, services: SVC }, FNP, BILLING_NPI).record;
  assert.deepEqual(R.checkSignReadiness({ hasNote: true, record: coded, billingNpi: null, posCode: POS }).codes, ['SIGN_NO_BILLING_NPI']);

  // No derived POS: the visit is documented, but it must not become a claim.
  // This is the silent Hickory Log failure, caught at the last safe moment.
  const noPos = R.checkSignReadiness({ hasNote: true, record: coded, billingNpi: BILLING_NPI });
  assert.deepEqual(noPos.codes, ['SIGN_NO_FACILITY_POS']);
  assert.match(noPos.message, /place of service/i);
  assert.match(noPos.message, /admin fixes it on the patient or the facility, not here/i);

  const ready = R.checkSignReadiness({ hasNote: true, record: coded, billingNpi: BILLING_NPI, posCode: POS });
  assert.equal(ready.ok, true);
  assert.equal(ready.message, null);
  assert.match(R.checkSignReadiness({ hasNote: true, record: rec, billingNpi: BILLING_NPI, posCode: POS }).message, /at least one ICD-10 diagnosis/);
});

test('attestation records signer, NPI and timestamp; closes the encounter; warns when the signer has no NPI', () => {
  const coded = R.applyCoding(baseRecord(), { diagnoses: DX, services: SVC }, FNP, BILLING_NPI).record;
  const att = R.buildAttestation({ id: 'att-1', record: coded, actor: FNP, at: '2026-09-04T12:00:00.000Z', billingNpi: BILLING_NPI });
  assert.equal(att.signedAt, '2026-09-04T12:00:00.000Z');
  assert.equal(att.signedBy.name, 'Bethel Godwins');
  assert.equal(att.signedBy.npi, '1234567893');
  assert.equal(att.attestationText, R.ATTESTATION_TEXT);
  assert.deepEqual(att.diagnosisCodes, ['E11.9', 'I10']);
  assert.deepEqual(att.serviceCodes, ['99348']);
  assert.deepEqual(att.warnings, []);
  assert.equal(R.isEncounterClosed(att), true);
  assert.equal(R.isEncounterClosed(null), false);
  assert.equal(R.deriveEncounterState(coded, att), 'signed');
  assert.equal(R.deriveEncounterState(coded, null), 'coded');
  assert.equal(R.deriveEncounterState(baseRecord(), null), 'not_coded');
  const rnAtt = R.buildAttestation({ id: 'att-2', record: coded, actor: RN, billingNpi: BILLING_NPI });
  assert.equal(rnAtt.warnings.length, 1);
  assert.match(rnAtt.warnings[0], /no NPI on file/);
});
test('addenda carry their own signer + timestamp and reject empty text', () => {
  assert.equal(R.buildAddendum({ id: 'a', encounterUuid: 'e', clientId: 'c', text: ' ', actor: FNP }).code, 'ADDENDUM_EMPTY');
  const a = R.buildAddendum({ id: 'a-1', encounterUuid: 'enc-uuid', clientId: 'c-1', text: 'Corrected BP to 128/78', actor: RN, at: '2026-09-05T09:00:00.000Z' }).addendum;
  assert.equal(a.at, '2026-09-05T09:00:00.000Z');
  assert.equal(a.by.name, 'Test Nurse');
  assert.equal(a.by.npi, null);
  assert.equal(a.text, 'Corrected BP to 128/78');
});

// ---- 5. Rx + orders ----
test('prescriptions are validated, stamped with the prescriber, and marked not transmitted', () => {
  const bad = (input) => R.buildPrescription({ id: 'rx', clientId: 'c', puuid: 'p', encounterUuid: 'e', input, actor: FNP });
  assert.equal(bad({}).code, 'RX_NO_DRUG');
  assert.equal(bad({ drug: 'Metformin' }).code, 'RX_NO_DOSE');
  assert.equal(bad({ drug: 'Metformin', dose: '500 mg' }).code, 'RX_NO_FREQUENCY');
  assert.equal(bad({ drug: 'Metformin', dose: '500 mg', frequency: 'BID', route: 'sideways' }).code, 'RX_BAD_ROUTE');
  assert.equal(bad({ drug: 'Metformin', dose: '500 mg', frequency: 'BID', route: 'oral', quantity: 0 }).code, 'RX_BAD_QUANTITY');
  assert.equal(bad({ drug: 'Metformin', dose: '500 mg', frequency: 'BID', route: 'oral', quantity: 60, refills: 100 }).code, 'RX_BAD_REFILLS');
  const rx = bad({ drug: 'Metformin', dose: '500 mg', frequency: 'BID', route: 'Oral', quantity: '60', refills: '3', kind: 'refill', date: '2026-09-04' }).prescription;
  assert.equal(rx.route, 'oral');
  assert.equal(rx.quantity, 60);
  assert.equal(rx.refills, 3);
  assert.equal(rx.kind, 'refill');
  assert.equal(rx.transmission, 'none');
  assert.equal(rx.prescriber.npi, FNP.npi);
  // 4.5: 8.4 takes a real prescription row. The 7.0.4 workaround — a
  // medication-list row with the sig packed into its title — is retired.
  const row = R.prescriptionToEmrRow(rx);
  assert.equal(row.drug, 'Metformin');
  assert.equal(row.dosage, '500 mg');
  assert.equal(row.quantity, '60');
  assert.equal(row.route, 'oral');
  assert.equal(row.interval, 'BID');
  assert.equal(row.refills, 3);
  // Shadow-data audit G5a: the prescriptions table reads `date_added`.
  // `start_date` is accepted by the route and silently discarded, so every Rx
  // written with it landed dateless. Verified live both ways 2026-09-08.
  assert.equal(row.date_added, '2026-09-04');
  assert.ok(!('start_date' in row), 'start_date is silently discarded by OpenEMR — must not be sent');
  // G5b: drug_route and drug_interval are EMPTY option lists on this instance,
  // so route and frequency cannot resolve to an id and the columns store null.
  // They are clinical content, so the note must carry them regardless. The day
  // the lists are seeded the structured fields above start working too.
  assert.match(row.note, /oral/, 'route must survive in the note while drug_route is unseeded');
  assert.match(row.note, /BID/, 'frequency must survive in the note while drug_interval is unseeded');
  // OpenEMR attributes every API write to the service account, so the
  // prescriber must be stamped or it is unrecoverable from the EMR side.
  assert.match(row.note, /Prescriber: .*NPI/);
  assert.match(row.note, /Refill/);
  assert.ok(row.note.length <= 255);
  assert.ok(!('title' in row), 'the packed-title workaround must be gone');
});
test('orders require an encounter diagnosis and advance through gated statuses', () => {
  const dx = R.buildEncounterDiagnoses(DX).diagnoses;
  const mk = (input) => R.buildOrder({ id: 'o-1', clientId: 'c', puuid: 'p', encounterUuid: 'e', input, actor: FNP, encounterDiagnoses: dx, at: '2026-09-04T10:00:00.000Z' });
  assert.equal(mk({ orderType: 'xray' }).code, 'ORDER_BAD_TYPE');
  assert.equal(mk({ orderType: 'lab' }).code, 'ORDER_NO_TESTS');
  assert.equal(mk({ orderType: 'lab', tests: ['A1c'] }).code, 'ORDER_NO_DIAGNOSIS');
  assert.equal(mk({ orderType: 'lab', tests: ['A1c'], diagnosisCodes: ['J45.909'] }).code, 'ORDER_DX_UNKNOWN');
  const o = mk({ orderType: 'lab', tests: ['A1c', 'BMP'], diagnosisCodes: ['E11.9'], priority: 'urgent' }).order;
  assert.equal(o.status, 'ordered');
  assert.equal(o.transmission, 'manual');
  assert.equal(o.orderingClinician.npi, FNP.npi);
  assert.equal(o.statusHistory.length, 1);
  const sent = R.advanceOrderStatus(o, 'sent', RN, 'faxed requisition', '2026-09-04T11:00:00.000Z').order;
  assert.equal(sent.status, 'sent');
  assert.equal(sent.statusHistory[1].by.name, 'Test Nurse');
  assert.equal(sent.statusHistory[1].note, 'faxed requisition');
  const resulted = R.advanceOrderStatus(sent, 'resulted', RN).order;
  assert.equal(R.advanceOrderStatus(resulted, 'sent', RN).code, 'ORDER_BAD_TRANSITION');
  assert.equal(R.advanceOrderStatus(R.advanceOrderStatus(o, 'cancelled', RN).order, 'sent', RN).code, 'ORDER_BAD_TRANSITION');
  assert.equal(R.advanceOrderStatus(o, 'lost', RN).code, 'ORDER_BAD_STATUS');
});

// ---- 6. Coding assist T1 + T2 ----
test('T1: active coded problems are proposed (pre-selected); uncoded ones are listed but not pre-selected; inactive excluded', () => {
  const problems = [
    { id: 'p1', title: 'Type 2 diabetes', code: 'E11.9', status: 'active' },
    { id: 'p2', title: 'Old fracture', code: 'S72.001A', status: 'resolved' },
    { id: 'p3', title: 'Preflight test problem', code: null, status: 'active' }
  ];
  const c = R.buildCandidateDiagnoses(problems);
  assert.deepEqual(c.map(x => [x.code, x.preselected, x.needsCode]), [['E11.9', true, false], [null, false, true]]);
  assert.equal(c[0].source, 'problem_list');
  // the clinician disposes: unchecking a candidate keeps it off the encounter
  const kept = R.buildEncounterDiagnoses(c.filter(x => x.code && x.code !== 'E11.9')).diagnoses;
  assert.deepEqual(kept, []);
});
test('T2: usage ranking is per clinician (never global), most used then most recent', () => {
  let rows = [];
  const at = (n) => `2026-09-0${n}T10:00:00.000Z`;
  rows = R.recordCodeUsage(rows, { userId: 'u-fnp', set: 'ICD10', code: 'E11.9', description: 'T2DM', at: at(1) });
  rows = R.recordCodeUsage(rows, { userId: 'u-fnp', set: 'ICD10', code: 'E11.9', at: at(2) });
  rows = R.recordCodeUsage(rows, { userId: 'u-fnp', set: 'ICD10', code: 'I10', description: 'HTN', at: at(3) });
  rows = R.recordCodeUsage(rows, { userId: 'u-fnp', set: 'ICD10', code: 'N18.30', at: at(4) });
  rows = R.recordCodeUsage(rows, { userId: 'u-rn', set: 'ICD10', code: 'J44.9', at: at(5) });
  rows = R.recordCodeUsage(rows, { userId: 'u-rn', set: 'ICD10', code: 'J44.9', at: at(6) });
  rows = R.recordCodeUsage(rows, { userId: 'u-rn', set: 'ICD10', code: 'J44.9', at: at(7) });
  const fnp = R.rankFavorites(rows, 'u-fnp', 'ICD10');
  assert.deepEqual(fnp.map(f => f.code), ['E11.9', 'N18.30', 'I10']);
  assert.equal(fnp[0].count, 2);
  assert.equal(fnp[0].description, 'T2DM');
  assert.ok(!fnp.some(f => f.code === 'J44.9'), 'another clinician\'s picks never appear');
  assert.deepEqual(R.rankFavorites(rows, 'u-rn', 'ICD10').map(f => f.code), ['J44.9']);
  assert.deepEqual(R.rankFavorites(rows, 'u-fnp', 'CPT4'), []);
  assert.equal(R.recordCodeUsage(rows, { userId: null, set: 'ICD10', code: 'X' }).length, rows.length, 'no user → no row');
});

// ---- 7. Structured note round-trip ----
test('the structured note is the sign-and-close record only (4.5)', () => {
  // 4.5 retired [GFC CODING], [GFC ORDERS] and [GFC RX]: on 8.4 all three are
  // native OpenEMR records, and a second copy in a note is a second record
  // that can disagree. ATTESTATION and ADDENDA stay, because OpenEMR has no
  // encounter sign/close concept at all — the note IS the attestation record.
  const coded = R.applyCoding(baseRecord(), { diagnoses: DX, services: SVC }, FNP, BILLING_NPI).record;
  const open = R.buildStructuredNote({ attestation: null, addenda: [] });
  assert.match(open.plan, /Encounter OPEN/);
  const att = R.buildAttestation({ id: 'att-1', record: coded, actor: FNP, at: '2026-09-04T12:00:00.000Z', billingNpi: BILLING_NPI });
  const add = R.buildAddendum({ id: 'a-1', encounterUuid: 'enc-uuid', clientId: 'c', text: 'Line one\nLine two', actor: RN, at: '2026-09-05T09:00:00.000Z' }).addendum;
  const note = R.buildStructuredNote({ attestation: att, addenda: [add] });
  // OpenEMR's SOAP validator needs >= 2 chars per section it receives.
  for (const k of ['subjective', 'objective', 'assessment', 'plan']) assert.ok(note[k].length >= 2);

  const parsed = R.parseGfcBlocks([note.objective, note.assessment, note.plan].join('\n\n'));
  assert.deepEqual(Object.keys(parsed).sort(), ['ADDENDA', 'ATTESTATION'],
    'only the two blocks that have no native OpenEMR home may remain');
  assert.deepEqual(parsed.ATTESTATION.records.find(r => r.key === 'signed_by').parts, ['Bethel Godwins', 'NPI 1234567893']);
  assert.deepEqual(parsed.ATTESTATION.records.find(r => r.key === 'signed_at').parts, ['2026-09-04T12:00:00.000Z']);
  assert.deepEqual(parsed.ADDENDA.records[0].parts, ['a-1', '2026-09-05T09:00:00.000Z', 'Test Nurse', 'NPI none']);
  assert.equal(parsed.ADDENDA.records[0].text, 'Line one\nLine two');

  const whole = JSON.stringify(note);
  for (const gone of ['[GFC CODING', '[GFC RX', '[GFC ORDERS']) {
    assert.ok(!whole.includes(gone), `${gone}] must not be regenerated — OpenEMR owns it now`);
  }
  // The note must not still claim 7.0.4 cannot do these writes.
  assert.doesNotMatch(note.subjective, /7\.0\.4/);
});


// ---- 6b. T1 fallback: codes the EMR read-back drops come from prior encounters ----
test('T1 merge: uncoded OpenEMR problems regain their code via the app\'s prior encounter records; other prior codes are offered unchecked', () => {
  const candidates = R.buildCandidateDiagnoses([
    { id: 'p1', title: 'Type 2 diabetes', code: null, status: 'active' },
    { id: 'p9', title: 'Never coded', code: null, status: 'active' }
  ]);
  const prior = [
    { date: '2026-08-01', diagnoses: [{ code: 'E11.9', description: 'T2DM', problemUuid: 'p1' }, { code: 'I10', description: 'HTN', problemUuid: null }] },
    { date: '2026-07-01', diagnoses: [{ code: 'E11.9', description: 'old desc', problemUuid: 'p1' }, { code: 'N18.30', description: 'CKD', problemUuid: null }] }
  ];
  const merged = R.mergeCandidateSources(candidates, prior);
  assert.deepEqual(merged.map(c => [c.code, c.source, c.preselected, c.needsCode]), [
    ['E11.9', 'problem_list', true, false],
    [null, 'problem_list', false, true],
    ['I10', 'prior_encounter', false, false],
    ['N18.30', 'prior_encounter', false, false]
  ]);
  assert.equal(merged[0].description, 'Type 2 diabetes', 'OpenEMR title wins over the app description');
  assert.equal(merged[0].codeVia, 'prior_encounter');
  assert.deepEqual(R.mergeCandidateSources([], []), []);
});

// ---- 8. EMR client: duplicated bundle rows are collapsed ----
test('bundleResources dedupes the duplicated Encounter rows this instance returns', () => {
  const { bundleResources } = require('../openemr')._internal;
  const bundle = { entry: [
    { resource: { resourceType: 'Encounter', id: 'e1' } }, { resource: { resourceType: 'Encounter', id: 'e1' } },
    { resource: { resourceType: 'Encounter', id: 'e2' } }, { resource: { resourceType: 'Condition', id: 'e1' } }, { resource: null }
  ] };
  assert.deepEqual(bundleResources(bundle).map(r => `${r.resourceType}/${r.id}`), ['Encounter/e1', 'Encounter/e2', 'Condition/e1']);
  assert.deepEqual(bundleResources(null), []);
});

// ============================================================
// Shadow-data audit regression guards (2026-09-08)
//
// Each of these failed live BEHIND A 201/200 before the fix. The app looked
// fine; OpenEMR held a shell. They are pinned here because none of them is
// visible from the app side, which is exactly why they survived Session 4.5's
// own verification. See docs/GFC_Shadow_Data_Audit.md.
// ============================================================

test('G3: an order payload carries the test name and the diagnosis link', () => {
  // buildOrder stores `tests` as STRINGS and the dx field as `diagnosisCodes`.
  // The original buildOrderPayload read t.name and order.diagnoses, so both
  // went out empty and every order filed as a nameless, dx-less shell.
  const built = R.buildOrder({
    id: 'o1', clientId: 'c1', puuid: 'p1', encounterUuid: 'e1',
    input: { orderType: 'lab', tests: ['CBC with differential', 'Basic metabolic panel'], diagnosisCodes: ['I10'] },
    actor: FNP, encounterDiagnoses: [{ code: 'I10' }]
  });
  assert.ok(!built.error, built.error);
  assert.deepEqual(built.order.tests, ['CBC with differential', 'Basic metabolic panel']);

  const payload = R.buildOrderPayload(built.order, { providerId: 5 });
  assert.equal(payload.codes.length, 2);
  assert.equal(payload.codes[0].code_text, 'CBC with differential');
  assert.equal(payload.codes[1].code_text, 'Basic metabolic panel');
  for (const c of payload.codes) {
    assert.ok(c.code_text, 'a test name must never go out blank');
    assert.deepEqual(c.diagnoses, [{ code_type: 'ICD10', code: 'I10' }]);
  }
  // The record has no `diagnoses` key at all — reading it is the original bug.
  assert.ok(!('diagnoses' in built.order), 'the order dx field is diagnosisCodes; a `diagnoses` key would mask the bug');

  // A coded object entry (a future test picker) must still work.
  const coded = R.buildOrderPayload(
    { ...built.order, tests: [{ code: '85025', name: 'CBC with differential' }] }, { providerId: 5 });
  assert.equal(coded.codes[0].code, '85025');
  assert.equal(coded.codes[0].code_text, 'CBC with differential');

  // The test name must go out under ALL THREE keys. The 6B controller's charge
  // half reads `code_text` but its order half reads `name`/`title`, so sending
  // only code_text stored a blank procedure_name. That was first written up as
  // a server defect; it is our own two halves disagreeing on a field name.
  // Proven live both ways 2026-09-08.
  for (const c of payload.codes) {
    assert.equal(c.name, c.code_text, 'the order half of the 6B controller reads `name`');
    assert.equal(c.title, c.code_text, 'the order half of the 6B controller reads `title`');
    assert.ok(c.name, 'a blank name stores a nameless order row');
  }
});

test('G5: the prescriber stamp survives note truncation, the sig is what gets trimmed', () => {
  // The note is capped at 255. Attribution is the one thing that must not be
  // lost to a long sig, because OpenEMR attributes the write to the service
  // account and the note is the only place the prescriber exists.
  const rx = R.buildPrescription({
    id: 'r1', clientId: 'c1', puuid: 'p1', encounterUuid: 'e1',
    input: {
      drug: 'Lisinopril', dose: '10 mg', route: 'oral', frequency: 'once daily',
      quantity: 30, refills: 3, date: '2026-09-08', instructions: 'X'.repeat(900)
    },
    actor: FNP
  }).prescription;
  const row = R.prescriptionToEmrRow(rx);
  assert.ok(row.note.length <= 255);
  assert.match(row.note, /Prescriber: .*NPI/, 'the prescriber must survive truncation');
  assert.match(row.note, /New Rx/);
  assert.equal(row.date_added, '2026-09-08');
});

test('G7: the encounter provider is the acting clinician, not a config constant', () => {
  // Resolved in openemr.js createEncounter from the actor the client was built
  // for. Asserted here at the source so a refactor that reinstates the
  // unconditional config default fails the build rather than the next claim.
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'openemr.js'), 'utf8');
  const line = src.split('\n').find(l => /^\s*provider_id:/.test(l));
  assert.ok(line, 'createEncounter must set provider_id');
  assert.match(line, /actor\s*&&\s*actor\.openEmrProviderId/,
    'the encounter provider must come from the acting clinician; a bare config default puts the wrong provider on every claim');
});
