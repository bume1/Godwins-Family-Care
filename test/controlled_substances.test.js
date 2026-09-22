// ============================================================================
// Session 4.10 Scope B — the Schedule II guard
//
// Georgia APRNs may not prescribe Schedule I or II substances. Before this
// session `buildPrescription` took the drug as free text and checked nothing,
// and PRESCRIBE was `provider` — which covers an MD and an NP alike.
//
// There is no e-prescribing here, so the app is not the prescription. IT IS THE
// CHART SAYING A PRESCRIPTION WAS WRITTEN, which is the same exposure 4.8 closed
// for RNs: the app producing the record asserting somebody acted outside scope.
//
// What this file pins:
//   1. A missing prescriber credential FAILS CLOSED. Nothing is parsed out of
//      the free-text licence level.
//   2. Every prescription declares a schedule and there is NO DEFAULT.
//   3. The drug-text backstop catches "Adderall declared non-controlled" and
//      NAMES the matched term — and does not false-positive on Tylenol #3.
//   4. NP + CII and PA + CII are refused; MD + CII with a valid DEA is permitted.
//   5. No DEA / expired DEA / uncovered schedule are three separate refusals,
//      because they are three different jobs.
//   6. A controlled prescription requires a PDMP attestation with a date.
//   7. THE APRN EMERGENCY OPIOID EXCEPTION IS A DELIBERATE NON-BUILD.
//   8. Existing prescriptions are FLAGGED unclassified, never guessed.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

process.env.TZ = require('../public/gfc-time').PRACTICE_TIMEZONE;

const cs = require('../controlledSubstances');
const clinicalRepo = require('../clinicalRepository');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const CODE = (src) => src.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
const SERVER_CODE = CODE(read('server.js'));

const TODAY = '2026-09-22';
// A real DEA number: two letters, seven digits, the last a checksum of the rest.
const DEA = 'AB1234563';
const prescriber = (extra = {}) => ({
  id: 'p1', name: 'Bethel Godwins', clinicalRole: 'provider', licenseLevel: 'FNP-BC', npi: '1234567893',
  prescriberCredential: 'NP', deaNumber: DEA, deaSchedules: ['CII', 'CIII', 'CIV', 'CV'], deaExpiresAt: '2028-01-31',
  ...extra
});
const ev = (user, drug, schedule, pdmp) => cs.evaluatePrescription({ user, drug, schedule, pdmp, today: TODAY });
const PDMP_OK = { checked: true, checkedOn: TODAY };

// ══════════════════════════════════════════════════════════════════════════
// B1 — know what the prescriber IS
// ══════════════════════════════════════════════════════════════════════════

test('B1: no prescriber credential on file refuses every prescription — fail closed', () => {
  const out = ev(prescriber({ prescriberCredential: null }), 'Lisinopril 10mg', 'non_controlled');
  assert.equal(out.ok, false);
  assert.equal(out.code, 'PRESCRIBER_CREDENTIAL_UNKNOWN');
  assert.match(out.error, /MD, DO, NP or PA/);
  // Empty string and a value outside the enum are the same thing: absent.
  assert.equal(ev(prescriber({ prescriberCredential: '' }), 'Lisinopril', 'non_controlled').code, 'PRESCRIBER_CREDENTIAL_UNKNOWN');
  assert.equal(ev(prescriber({ prescriberCredential: 'FNP-BC' }), 'Lisinopril', 'non_controlled').code, 'PRESCRIBER_CREDENTIAL_UNKNOWN');
});

test('B1: the credential is a STRUCTURED field — nothing is parsed out of licenseLevel', () => {
  // "FNP-BC, APRN" contains "NP". Parsing it is how a guard starts passing the
  // wrong people, so this must not happen anywhere.
  const src = CODE(read('controlledSubstances.js'));
  assert.ok(!/licenseLevel/.test(src), 'licenseLevel is free text and gates nothing — never read it here');
  // An MD whose licence string happens to contain "NP" is still an MD.
  const md = prescriber({ prescriberCredential: 'MD', licenseLevel: 'MD, formerly NP' });
  assert.equal(ev(md, 'Oxycodone 5mg', 'CII', PDMP_OK).ok, true);
});

test('B1: the DEA number checksum is validated — a transposed digit is somebody else', () => {
  assert.equal(cs.normalizeDea(DEA), DEA);
  assert.equal(cs.normalizeDea('ab-1234563'), DEA, 'punctuation and case are tolerated');
  assert.equal(cs.normalizeDea('AB1234564'), null, 'the checksum fails');
  assert.equal(cs.normalizeDea('AB123456'), null, 'too short');
  assert.equal(cs.normalizeDea('A11234563'), null, 'the registrant prefix is two letters');
  assert.equal(cs.normalizeDea(''), null);
  assert.equal(cs.normalizeDea(null), null);
});

// ══════════════════════════════════════════════════════════════════════════
// B2 — every prescription declares its schedule
// ══════════════════════════════════════════════════════════════════════════

test('B2: a schedule is required and there is NO DEFAULT', () => {
  const out = ev(prescriber(), 'Lisinopril 10mg', undefined);
  assert.equal(out.ok, false);
  assert.equal(out.code, 'RX_NO_SCHEDULE');
  assert.equal(ev(prescriber(), 'Lisinopril', '').code, 'RX_NO_SCHEDULE');
  assert.equal(ev(prescriber(), 'Lisinopril', 'CVI').code, 'RX_NO_SCHEDULE', 'an invented schedule is not a schedule');
  // A PRE-SELECTED "non_controlled" would be a declaration nobody made, so the
  // form ships the choice empty. Build-enforced against the page.
  const page = CODE(read('public/clinical.html'));
  assert.match(page, /schedule:\s*''/, 'the Rx form must not pre-select a schedule');
  assert.match(page, /<option value="">Choose…<\/option>/);
  assert.deepEqual(cs.SCHEDULES, ['non_controlled', 'CII', 'CIII', 'CIV', 'CV']);
});

test('B2: the builder refuses a prescription with no verdict attached', () => {
  // The route runs the scope check and hands the builder its verdict. A builder
  // that quietly accepts a missing one is a builder a later route can call
  // without running the check at all.
  const out = clinicalRepo.buildPrescription({
    id: 'r', clientId: 'c', encounterUuid: 'e', actor: prescriber(),
    input: { drug: 'Oxycodone', dose: '5mg', frequency: 'q6h', route: 'oral', quantity: 30 }
  });
  assert.equal(out.code, 'RX_NO_SCHEDULE');
  // And a half-verdict — a schedule with no credential — is refused too.
  const half = clinicalRepo.buildPrescription({
    id: 'r', clientId: 'c', encounterUuid: 'e', actor: prescriber(),
    input: { drug: 'Oxycodone', dose: '5mg', frequency: 'q6h', route: 'oral', quantity: 30, authority: { schedule: 'CII' } }
  });
  assert.equal(half.code, 'RX_NO_SCHEDULE');
});

// ══════════════════════════════════════════════════════════════════════════
// B3 — the backstop
// ══════════════════════════════════════════════════════════════════════════

test('B3: "Adderall" declared non-controlled is REFUSED, and the matched term is named', () => {
  // This is the realistic failure: not a clinician lying about a schedule, but
  // one not thinking of Adderall as a Schedule II drug.
  const out = ev(prescriber({ prescriberCredential: 'MD' }), 'Adderall XR 20mg', 'non_controlled');
  assert.equal(out.ok, false);
  assert.equal(out.code, 'SCHEDULE_MISMATCH');
  assert.equal(out.matchedTerm, 'adderall');
  assert.match(out.error, /"adderall"/, 'the refusal names the term, so the clinician knows what to change');
  // Declaring it as something else controlled is still a mismatch — it is CII or
  // it is a different drug.
  assert.equal(ev(prescriber({ prescriberCredential: 'MD' }), 'Adderall', 'CIV').code, 'SCHEDULE_MISMATCH');
});

test('B3: the list covers the agents the brief names, generic and brand', () => {
  const required = ['amphetamine', 'dextroamphetamine', 'lisdexamfetamine', 'methylphenidate',
    'dexmethylphenidate', 'oxycodone', 'hydrocodone', 'morphine', 'hydromorphone', 'fentanyl',
    'methadone', 'oxymorphone', 'tapentadol'];
  for (const term of required) {
    assert.equal(cs.matchScheduleTwoTerm(`${term} 10mg`), term, term);
  }
  for (const brand of ['Adderall', 'Vyvanse', 'Ritalin', 'Concerta', 'OxyContin', 'Percocet',
    'Norco', 'Vicodin', 'Dilaudid', 'Duragesic', 'Nucynta', 'Opana', 'MS Contin']) {
    assert.ok(cs.matchScheduleTwoTerm(brand), `${brand} must be recognised`);
  }
});

test('B3: word boundaries, and a case-insensitive match', () => {
  assert.equal(cs.matchScheduleTwoTerm('METHYLPHENIDATE ER 18MG'), 'methylphenidate');
  assert.equal(cs.matchScheduleTwoTerm('methylphenidate-ER'), 'methylphenidate', 'a hyphen is a boundary');
  assert.equal(cs.matchScheduleTwoTerm('Oxycodone/APAP 5-325'), 'oxycodone', 'a slash is a boundary');
  // A drug that merely CONTAINS a term's letters must not match.
  assert.equal(cs.matchScheduleTwoTerm('Lisinopril 10mg'), null);
  assert.equal(cs.matchScheduleTwoTerm('Metformin 500mg'), null);
  assert.equal(cs.matchScheduleTwoTerm(''), null);
  assert.equal(cs.matchScheduleTwoTerm(null), null);
});

test('B3: codeine is CII only as a SINGLE AGENT — the combinations are not', () => {
  // Codeine alone is Schedule II; Tylenol #3 and the cough syrups are III or V.
  // Flagging those as CII would refuse a legitimate CIII declaration.
  assert.equal(cs.matchScheduleTwoTerm('Codeine sulfate'), 'codeine');
  assert.equal(cs.matchScheduleTwoTerm('codeine'), 'codeine');
  for (const combo of ['Tylenol #3', 'Acetaminophen with codeine 300/30', 'Promethazine with codeine',
    'Guaifenesin and codeine', 'Fioricet with codeine']) {
    assert.equal(cs.matchScheduleTwoTerm(combo), null, `${combo} is not Schedule II`);
  }
  // So a CIII declaration on Tylenol #3 goes through.
  assert.equal(ev(prescriber(), 'Tylenol #3', 'CIII', PDMP_OK).ok, true);
});

test('B3: buprenorphine is not Schedule II and is not flagged as one', () => {
  for (const d of ['Buprenorphine/naloxone film', 'Suboxone 8-2mg', 'Belbuca', 'Butrans patch']) {
    assert.equal(cs.matchScheduleTwoTerm(d), null, d);
  }
  assert.equal(ev(prescriber(), 'Suboxone 8-2mg', 'CIII', PDMP_OK).ok, true);
});

test('B3: the module header says plainly that the list is a backstop, not a formulary', () => {
  // A later session must not read this list as authoritative and start treating
  // an absent drug as non-controlled.
  const header = read('controlledSubstances.js').slice(0, 2500);
  assert.match(header, /BACKSTOP, NOT A FORMULARY/i);
  assert.match(header, /NEVER BE COMPLETE/i);
  // An unknown drug's declaration STANDS — absence is not evidence.
  assert.equal(ev(prescriber({ prescriberCredential: 'MD' }), 'Some New Stimulant 10mg', 'CII', PDMP_OK).ok, true);
  assert.equal(ev(prescriber(), 'Some New Stimulant 10mg', 'non_controlled').ok, true);
});

// ══════════════════════════════════════════════════════════════════════════
// B4 — the rule
// ══════════════════════════════════════════════════════════════════════════

test('B4: NP + CII is refused, and the refusal says to route it to the collaborating physician', () => {
  const out = ev(prescriber({ prescriberCredential: 'NP' }), 'Oxycodone 5mg', 'CII', PDMP_OK);
  assert.equal(out.ok, false);
  assert.equal(out.code, 'APRN_SCHEDULE_II_PROHIBITED');
  assert.equal(out.prescriberCredential, 'NP');
  assert.match(out.error, /collaborating physician/,
    'a refusal with nothing to do about it is how a control gets worked around');
});

test('B4: PA + CII is refused too', () => {
  assert.equal(ev(prescriber({ prescriberCredential: 'PA' }), 'Oxycodone 5mg', 'CII', PDMP_OK).code, 'APRN_SCHEDULE_II_PROHIBITED');
  assert.deepEqual(cs.SCHEDULE_II_PROHIBITED_CREDENTIALS, ['NP', 'PA']);
});

test('B4: MD and DO + CII are permitted, subject to the DEA checks', () => {
  for (const cred of ['MD', 'DO']) {
    const out = ev(prescriber({ prescriberCredential: cred }), 'Oxycodone 5mg', 'CII', PDMP_OK);
    assert.equal(out.ok, true, cred);
    assert.equal(out.schedule, 'CII');
    assert.equal(out.prescriberCredential, cred);
    assert.equal(out.dea.deaNumber, DEA);
  }
});

test('B4: an NP may prescribe CIII, CIV, CV and non-controlled — only CII is out', () => {
  for (const sc of ['CIII', 'CIV', 'CV']) {
    assert.equal(ev(prescriber({ prescriberCredential: 'NP' }), 'Alprazolam 0.5mg', sc, PDMP_OK).ok, true, sc);
  }
  assert.equal(ev(prescriber({ prescriberCredential: 'NP' }), 'Lisinopril 10mg', 'non_controlled').ok, true);
});

test('B4: THE EMERGENCY OPIOID EXCEPTION IS A DELIBERATE NON-BUILD', () => {
  // Georgia's sole statutory exception lets an APRN prescribe hydrocodone,
  // oxycodone or compounds thereof in an emergency, capped at a 5-day initial
  // supply. It is narrow, it is rare in home-based primary care, and A WRONGLY
  // GRANTED EXCEPTION IS WORSE THAN ROUTING TO A PHYSICIAN — the app cannot
  // decide "is this an emergency" on the strength of a checkbox.
  const src = CODE(read('controlledSubstances.js')) + SERVER_CODE;
  assert.ok(!/emergencyException|isEmergency|emergencySupply|fiveDaySupply/i.test(src),
    'the emergency exception must not exist in code');
  // No input can talk an NP past a CII.
  for (const pdmp of [PDMP_OK, { checked: true, checkedOn: TODAY, notes: 'EMERGENCY' }]) {
    assert.equal(cs.evaluatePrescription({
      user: prescriber({ prescriberCredential: 'NP' }), drug: 'Hydrocodone 5-325',
      schedule: 'CII', pdmp, today: TODAY, emergency: true, daysSupply: 5
    }).code, 'APRN_SCHEDULE_II_PROHIBITED');
  }
  // And it is recorded as a deliberate decision, not an oversight.
  assert.match(read('CLAUDE.md'), /emergency (opioid )?exception/i);
});

test('B4: no DEA, an expired DEA and an uncovered schedule are THREE separate refusals', () => {
  // Three different jobs: get a registration, renew it, or add a schedule to it.
  const noDea = ev(prescriber({ prescriberCredential: 'MD', deaNumber: null }), 'Oxycodone', 'CII', PDMP_OK);
  assert.equal(noDea.code, 'DEA_NOT_ON_FILE');

  const expired = ev(prescriber({ prescriberCredential: 'MD', deaExpiresAt: '2026-09-21' }), 'Oxycodone', 'CII', PDMP_OK);
  assert.equal(expired.code, 'DEA_EXPIRED');
  assert.match(expired.error, /2026-09-21/);
  // A registration expiring TODAY is still valid today.
  assert.equal(ev(prescriber({ prescriberCredential: 'MD', deaExpiresAt: TODAY }), 'Oxycodone', 'CII', PDMP_OK).ok, true);

  const uncovered = ev(prescriber({ prescriberCredential: 'MD', deaSchedules: ['CIII', 'CIV'] }), 'Oxycodone', 'CII', PDMP_OK);
  assert.equal(uncovered.code, 'DEA_SCHEDULE_NOT_COVERED');
  assert.deepEqual(uncovered.covers, ['CIII', 'CIV']);
  // A checksum-invalid number on file is NOT on file. Storing garbage and
  // treating it as a registration is the worst of the three states.
  assert.equal(ev(prescriber({ prescriberCredential: 'MD', deaNumber: 'AB1234564' }), 'Oxycodone', 'CII', PDMP_OK).code, 'DEA_NOT_ON_FILE');
});

test('B4: a NON-controlled prescription needs no DEA at all', () => {
  const out = ev(prescriber({ deaNumber: null, deaSchedules: [], deaExpiresAt: null }), 'Lisinopril 10mg', 'non_controlled');
  assert.equal(out.ok, true);
  assert.equal(out.dea, null);
  assert.equal(out.pdmpAttestation, null, 'and no PDMP attestation');
  assert.equal(cs.checkDeaAuthority({ user: {}, schedule: 'non_controlled', today: TODAY }).required, false);
});

test('B4: the DEA expiry is judged against the date in GEORGIA, not in UTC', () => {
  // For four hours of every evening UTC is already tomorrow. A registration
  // expiring today would expire a day early if the check used toISOString().
  assert.match(SERVER_CODE, /today:\s*practiceToday\(\)/);
  assert.match(SERVER_CODE, /const practiceToday = \(\) => \{[\s\S]{0,300}practiceTime\.zonedParts/);
  // 23:30 ET on the 22nd is 03:30Z on the 23rd. The practice date is still the 22nd.
  const practiceTime = require('../public/gfc-time');
  assert.equal(practiceTime.zonedParts(new Date('2026-09-23T03:30:00.000Z')).isoDate, '2026-09-22');
});

// ══════════════════════════════════════════════════════════════════════════
// B4/B5 — the PDMP attestation
// ══════════════════════════════════════════════════════════════════════════

test('B4: any controlled schedule requires a PDMP attestation WITH A DATE', () => {
  for (const sc of ['CII', 'CIII', 'CIV', 'CV']) {
    const cred = sc === 'CII' ? 'MD' : 'NP';
    assert.equal(ev(prescriber({ prescriberCredential: cred }), 'Alprazolam', sc, null).code, 'PDMP_ATTESTATION_REQUIRED', sc);
    assert.equal(ev(prescriber({ prescriberCredential: cred }), 'Alprazolam', sc, { checked: false }).code, 'PDMP_ATTESTATION_REQUIRED', sc);
    // "I checked it" with no date is not a record of having checked it on THIS
    // occasion.
    assert.equal(ev(prescriber({ prescriberCredential: cred }), 'Alprazolam', sc, { checked: true }).code, 'PDMP_NO_DATE', sc);
    assert.equal(ev(prescriber({ prescriberCredential: cred }), 'Alprazolam', sc, { checked: true, checkedOn: '2026-12-01' }).code, 'PDMP_DATE_FUTURE', sc);
  }
});

test('B5: the schedule, the credential and the PDMP land on the row AND in the OpenEMR note', () => {
  const verdict = ev(prescriber({ prescriberCredential: 'MD' }), 'Oxycodone 5mg', 'CII', PDMP_OK);
  assert.equal(verdict.ok, true);
  const { prescription } = clinicalRepo.buildPrescription({
    id: 'r1', clientId: 'c1', encounterUuid: 'e1', actor: prescriber({ prescriberCredential: 'MD' }),
    input: { drug: 'Oxycodone 5mg', dose: '5 mg', frequency: 'q6h prn', route: 'oral', quantity: 30, date: TODAY, authority: verdict }
  });
  assert.equal(prescription.schedule, 'CII');
  assert.equal(prescription.prescriberCredential, 'MD');
  assert.equal(prescription.deaNumber, DEA);
  assert.deepEqual(prescription.pdmpAttestation, { checked: true, checkedOn: TODAY, registry: 'Georgia PDMP', notes: null });

  // And the note stamp, which on this instance is the only free-text field that
  // reliably persists (drug_route / drug_interval are empty option lists).
  const row = clinicalRepo.prescriptionToEmrRow(prescription);
  assert.match(row.note, /CII/);
  assert.match(row.note, /MD/);
  assert.match(row.note, new RegExp(`PDMP checked ${TODAY}`));
  assert.ok(row.note.length <= 255, 'the note is capped and attribution must survive truncation');
  assert.match(row.note, /Prescriber: .*NPI/);

  // A NON-controlled prescription does not carry a DEA number or a PDMP line —
  // neither is part of that record.
  const plain = ev(prescriber(), 'Lisinopril 10mg', 'non_controlled');
  const { prescription: p2 } = clinicalRepo.buildPrescription({
    id: 'r2', clientId: 'c1', encounterUuid: 'e1', actor: prescriber(),
    input: { drug: 'Lisinopril', dose: '10 mg', frequency: 'daily', route: 'oral', quantity: 30, authority: plain }
  });
  assert.equal(p2.deaNumber, null);
  assert.equal(p2.pdmpAttestation, null);
  assert.ok(!/PDMP/.test(clinicalRepo.prescriptionToEmrRow(p2).note));
});

test('B5: the audit row records the schedule, the credential and whether the PDMP was checked', () => {
  assert.match(SERVER_CODE, /schedule:\s*rx\.schedule,\s*prescriberCredential:\s*rx\.prescriberCredential/);
  assert.match(SERVER_CODE, /pdmpChecked:\s*!!\(rx\.pdmpAttestation && rx\.pdmpAttestation\.checked\)/);
});

// ══════════════════════════════════════════════════════════════════════════
// B6 — existing prescriptions
// ══════════════════════════════════════════════════════════════════════════

test('B6: a prescription with no schedule is FLAGGED unclassified, never guessed', () => {
  const rows = [
    { id: 'a', drug: 'Adderall XR 20mg', date: '2026-06-01', clientId: 'c1' },
    { id: 'b', drug: 'Lisinopril 10mg', date: '2026-07-01', clientId: 'c2' },
    { id: 'c', drug: 'Oxycodone 5mg', date: '2026-08-01', clientId: 'c3', schedule: 'CII' }
  ];
  const { rows: next, flagged } = cs.applyPrescriptionScheduleMigration(rows);
  assert.equal(flagged.length, 2);
  assert.equal(next[0].schedule, cs.UNCLASSIFIED);
  assert.equal(next[1].schedule, cs.UNCLASSIFIED);
  // A DRUG THE LIST WOULD RECOGNISE IS STILL NOT GUESSED. "Adderall" is plainly
  // Schedule II, and inferring it here would produce a record indistinguishable
  // from one a clinician declared — which is the entire control.
  assert.notEqual(next[0].schedule, 'CII');
  assert.equal(next[0].scheduleClassifiedBy, 'migration_4_10');
  // An already-classified row is untouched.
  assert.equal(next[2].schedule, 'CII');
  assert.ok(!('scheduleClassifiedBy' in next[2]));
});

test('B6: the migration is idempotent and does not block reading', () => {
  const once = cs.applyPrescriptionScheduleMigration([{ id: 'a', drug: 'X' }]);
  const twice = cs.applyPrescriptionScheduleMigration(once.rows);
  assert.equal(twice.flagged.length, 0);
  assert.deepEqual(twice.rows, once.rows);
  assert.deepEqual(cs.applyPrescriptionScheduleMigration([]).rows, []);
  assert.deepEqual(cs.applyPrescriptionScheduleMigration(null).rows, []);
  // The chart is the chart: nothing about an unclassified row stops it being read.
  const listRoute = SERVER_CODE.match(/app\.get\('\/api\/clinical\/patients\/:clientId\/orders'[\s\S]{0,1200}/);
  assert.ok(listRoute && !/unclassified/.test(listRoute[0]), 'reading prescriptions must not filter on the schedule');
});

test('B6: the unclassified warning says plainly that nothing was guessed', () => {
  const w = cs.buildUnclassifiedWarning([{ id: 'a', drug: 'X' }, { id: 'b', drug: 'Y' }]);
  assert.match(w, /2 prescriptions/);
  assert.match(w, /Nothing was guessed/i);
  assert.equal(cs.buildUnclassifiedWarning([]), null, 'no warning when there is nothing to warn about');
  assert.match(SERVER_CODE, /controlled\.applyPrescriptionScheduleMigration\(rows\)/);
  assert.match(SERVER_CODE, /await migratePrescriptionSchedules\(\)/);
});

// ══════════════════════════════════════════════════════════════════════════
// The route, and the screen that must not offer what the route refuses
// ══════════════════════════════════════════════════════════════════════════

test('the route reads the prescriber FRESH, not from the token', () => {
  // A credential an admin corrected this morning must take effect on the next
  // request — the rule POA status and clinicalRole already follow. Reading it
  // from the JWT would mean a narrowed credential still prescribing until the
  // next sign-in.
  assert.match(SERVER_CODE, /const rxUsers = await getUsers\(\);\s*const prescriber = rxUsers\.find\(u => u && u\.id === req\.user\.id\) \|\| req\.user;/);
  assert.match(SERVER_CODE, /controlled\.evaluatePrescription\(\{\s*user: prescriber/);
});

test('the route answers 403 for a SCOPE refusal and 400 for a bad submission', () => {
  // A clinician reading the response has to be able to tell "not you" from "not
  // like that" — they are different problems with different fixes.
  const m = SERVER_CODE.match(/const scopeCodes = \[[\s\S]{0,300}?\];/);
  assert.ok(m, 'the scope codes must be named');
  for (const code of ['APRN_SCHEDULE_II_PROHIBITED', 'PRESCRIBER_CREDENTIAL_UNKNOWN', 'DEA_NOT_ON_FILE', 'DEA_EXPIRED', 'DEA_SCHEDULE_NOT_COVERED']) {
    assert.ok(m[0].includes(code), `${code} is a scope refusal`);
  }
  // SCHEDULE_MISMATCH is deliberately NOT a scope refusal: the credential is
  // fine, the submission contradicts itself.
  assert.ok(!m[0].includes('SCHEDULE_MISMATCH'));
  assert.match(SERVER_CODE, /scopeCodes\.includes\(verdict\.code\) \? 403 : 400/);
});

test('the Rx form asks the SERVER what the prescriber is, and says so before the click', () => {
  const page = CODE(read('public/clinical.html'));
  // A button that is going to answer 403 is worse than no button.
  assert.match(page, /scheduleTwoBlocked/);
  assert.match(page, /collaborating physician/);
  assert.match(page, /deaMissing/);
  assert.match(page, /deaUncovered/);
  // Resolved on the SERVER per request and served, never derived in the page
  // from a stored login.
  assert.match(SERVER_CODE, /scheduleIIProhibited:\s*controlled\.SCHEDULE_II_PROHIBITED_CREDENTIALS\.includes/);
  assert.match(SERVER_CODE, /deaOnFile:\s*!!controlled\.normalizeDea\(req\.user\.deaNumber\)/);
  assert.ok(!/SCHEDULE_II_PROHIBITED|\['NP', 'PA'\]/.test(page), 'the page must not restate the prohibition');
});

test('the admin form refuses a bad credential, DEA number and expiry BY NAME', () => {
  // Silently dropping a bad value leaves an admin believing a prescriber is
  // registered when the record says they are not.
  assert.match(SERVER_CODE, /code: 'PRESCRIBER_CREDENTIAL_INVALID'/);
  assert.match(SERVER_CODE, /code: 'DEA_INVALID'/);
  assert.match(SERVER_CODE, /code: 'DEA_EXPIRY_INVALID'/);
  // And the GET returns them, or the round-tripped form wipes them on save.
  assert.match(SERVER_CODE, /prescriberCredential: u\.prescriberCredential \|\| null/);
  assert.match(SERVER_CODE, /deaNumber: u\.deaNumber \|\| null/);
  assert.match(SERVER_CODE, /deaSchedules: Array\.isArray\(u\.deaSchedules\) \? u\.deaSchedules : \[\]/);
  const hub = CODE(read('public/admin-hub.html'));
  assert.match(hub, /prescriberCredential: user\.prescriberCredential \|\| ''/);
  assert.match(hub, /deaNumber: user\.deaNumber \|\| ''/);
});
