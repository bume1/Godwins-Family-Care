// Shadow-data audit fixes — live proof that four silent defects are closed.
//
// Every one of these returned 201/200 BEFORE the fix while OpenEMR stored a
// shell. So this asserts STORED VALUES read back through OpenEMR's own API,
// never a status code. It drives the same builders and transport the clinical
// routes use, so what it proves is what those routes actually send.
//
// Covers, from docs/GFC_Shadow_Data_Audit.md:
//   G3 — the order carries the test name and the diagnosis link
//   G5 — the prescription carries a date, and route + frequency reach the chart
//   G6 — the prescription is linked to its encounter
//   G7 — the encounter names the acting clinician, not the config default
//   G4 — an allergy reaches the chart at all, and reads back as its allergen
//
// TEST DATA only — it writes one encounter, one order and one prescription to
// the TEST patient.
//
//   OPENEMR_BASE_URL=… OPENEMR_CLIENT_ID=… OPENEMR_CLIENT_SECRET=… \
//   OPENEMR_API_USERNAME=… OPENEMR_API_PASSWORD=… node scripts/verify_shadow_data_fixes.js
//
// Result on 2026-09-08 against the live instance: 23/23.
const o = require('../openemr.js');
const R = require('../clinicalRepository.js');
const U = 'a284d5c2-670e-4a62-aa95-2d1aa629003c'; // TEST PatientOne

// The acting clinician. openEmrProviderId is the whole point of G7: the
// encounter must come back naming 5, not the configured default.
const CLINICIAN = { id: 'u-bethel', name: 'Bethel Godwins', licenseLevel: 'FNP-C', npi: '1902310568', openEmrProviderId: '5', role: 'clinical' };
const CONFIG_DEFAULT_PROVIDER = String(require('../config').OPENEMR.PROVIDER_ID);
const e = o.forActor(CLINICIAN);

let pass = 0, fail = 0;
const ok = (c, l, x) => { c ? (pass++, console.log('  PASS  ' + l)) : (fail++, console.log('  FAIL  ' + l + (x !== undefined ? ' :: ' + JSON.stringify(x) : ''))); };

(async () => {
  const TAG = 'SHADOWFIX-' + Date.now();
  const today = new Date().toISOString().slice(0, 10);

  // ---- Encounter, through the real follow-up builder ----------------------
  const built = R.buildFollowUpWrites({
    reason: `${TAG} shadow-data fix verification`, date: today,
    subjective: 'Audit probe.', objective: 'Audit probe.', assessment: 'Essential hypertension.', plan: 'Continue.'
  }, CLINICIAN, { serviceAccount: 'gfc-app-api' });
  const enc = await e.createEncounter(U, { ...built.encounter, facility_id: '3', pos_code: '11' });
  const euuid = enc.euuid || enc.uuid;
  ok(!!euuid, 'encounter created', enc);

  // ---- G7: the encounter names the clinician ------------------------------
  const row = await e.getEncounterRow(U, euuid);
  ok(String(row.provider_id) === '5', 'G7 encounter provider_id is the acting clinician (5)', { got: row.provider_id });
  ok(String(row.provider_id) !== CONFIG_DEFAULT_PROVIDER || CONFIG_DEFAULT_PROVIDER === '5',
    `G7 encounter provider is not the config default (${CONFIG_DEFAULT_PROVIDER})`, { got: row.provider_id });

  // ---- G3: the order carries its test name and diagnosis ------------------
  const order = R.buildOrder({
    id: 'o1', clientId: 'c1', puuid: U, encounterUuid: euuid,
    input: { orderType: 'lab', tests: ['CBC with differential'], priority: 'routine', diagnosisCodes: ['I10'] },
    actor: CLINICIAN, encounterDiagnoses: [{ code: 'I10' }]
  }).order;
  const payload = R.buildOrderPayload(order, { providerId: 5 });
  ok(payload.codes[0].code_text === 'CBC with differential', 'G3 payload carries the test name', payload.codes[0]);
  ok(payload.codes[0].diagnoses.length === 1, 'G3 payload carries the diagnosis link', payload.codes[0].diagnoses);
  const posted = await e.postOrder(U, euuid, payload);
  ok(posted && posted.procedure_order_id != null, 'G3 order posted', posted);
  const backOrders = await e.getOrders(U, euuid);
  const mine = backOrders.find(x => String(x.procedure_order_id) === String(posted.procedure_order_id));
  ok(!!mine, 'G3 order readable back on the encounter');
  ok(String(mine.provider_id) === '5', 'G3 order provider is the clinician', { got: mine.provider_id });
  const codeRow = (mine.codes || [])[0] || {};
  ok(String(codeRow.diagnoses || '') === 'ICD10:I10', 'G3 STORED diagnosis link on the order code row', codeRow);
  // The 6B route drops code_text into the name column (server defect, filed in
  // OPENEMR_SERVER_DEFECTS). Report it rather than assert it green: the app
  // side is proven by the payload assertions above.
  console.log(`  NOTE  6B route stored procedure_name=${JSON.stringify(codeRow.procedure_name || '')} ` +
    `(empty = the server-side code_text defect is still open; the app sent "${payload.codes[0].code_text}")`);

  // ---- G5 + G6: the prescription -----------------------------------------
  const rx = R.buildPrescription({
    id: 'r1', clientId: 'c1', puuid: U, encounterUuid: euuid,
    input: { drug: `Lisinopril ${TAG.slice(-6)}`, dose: '10 mg', route: 'oral', frequency: 'once daily',
             quantity: 30, refills: 3, date: today, instructions: 'Take one tablet by mouth daily' },
    actor: CLINICIAN
  }).prescription;
  const emrRow = R.prescriptionToEmrRow(rx);
  ok(emrRow.date_added === today, 'G5 payload sends date_added, not start_date', emrRow);
  ok(!('start_date' in emrRow), 'G5 start_date (silently discarded by OpenEMR) is not sent');
  await e.createPrescription(U, emrRow, euuid);

  const rxBack = (await e.getPrescriptions(U)).find(r => String(r.drug || '').includes(TAG.slice(-6)));
  ok(!!rxBack, 'G5 prescription readable back');
  ok(!!rxBack.date_added, 'G5 STORED date_added is populated', { got: rxBack.date_added });
  ok(/oral/i.test(rxBack.note || ''), 'G5 route reached the chart (note, while drug_route is unseeded)', { note: rxBack.note });
  ok(/once daily/i.test(rxBack.note || ''), 'G5 frequency reached the chart (note, while drug_interval is unseeded)', { note: rxBack.note });
  ok(/NPI 1902310568/.test(rxBack.note || ''), 'G5 prescriber stamp survived', { note: rxBack.note });
  ok(String(rxBack.euuid || '') === String(euuid), 'G6 STORED prescription is linked to its encounter', { got: rxBack.euuid, want: euuid });

  // ---- G4: allergies -------------------------------------------------------
  // `addAllergy` existed since 4.1 and was called from nowhere, so the chart
  // carried only what someone typed into OpenEMR by hand. It also could not
  // have worked: the route rejects a datetime begdate and reports the refusal
  // as HTTP 200 with an empty data array.
  const allergyTag = 'ALLERGY-' + Date.now();
  const beforeAllergies = (await e.getAllergies(U)).length;
  const allergyRow = await e.addAllergy(U, {
    title: `Penicillin ${allergyTag}`, begdate: today,
    comments: 'Reaction: hives. Severity: moderate. Recorded via the GFC Care Platform'
  });
  ok(!!(allergyRow && (allergyRow.uuid || allergyRow.id)), 'G4 allergy write returns a real row', allergyRow);
  const allergies = await e.getAllergies(U);
  ok(allergies.length === beforeAllergies + 1, 'G4 STORED: the allergy count grew by one',
    { before: beforeAllergies, after: allergies.length });
  const savedAllergy = allergies.find(a => JSON.stringify(a).includes(allergyTag));
  ok(!!savedAllergy, 'G4 the allergy reads back as FHIR AllergyIntolerance');
  ok(R.summarizeAllergy(savedAllergy).title.includes('Penicillin'),
    'G4 the chart shows the allergen, not "Unknown"', savedAllergy && R.summarizeAllergy(savedAllergy));
  ok(!allergies.map(a => R.summarizeAllergy(a).title).includes('Unknown'),
    'G4 no allergy on this patient renders as "Unknown"', allergies.map(a => R.summarizeAllergy(a).title));
  let allergyThrew = false;
  try { await e.addAllergy(U, { title: `ShouldFail ${allergyTag}`, begdate: 'not-a-date' }); }
  catch { allergyThrew = true; }
  ok(allergyThrew, 'G4 an invalid allergy write throws instead of silently writing nothing');

  console.log(`\n${pass}/${pass + fail} passed${fail ? ` — ${fail} FAILED` : ''}`);
  console.log(`encounter ${euuid} (TEST DATA, tagged ${TAG})`);
  process.exit(fail ? 1 : 0);
})().catch(err => { console.error('FATAL', err.message); process.exit(1); });
