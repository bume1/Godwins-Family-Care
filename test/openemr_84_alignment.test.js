// Session 4.5 preflight — 8.4 alignment guards.
//
// Everything asserted here was verified against the LIVE instance on
// 2026-09-06 and then pinned as a test, because each one failed silently in
// production: a 404 that means "empty" rendered as a red error, a document
// upload keyed by the wrong id stopped filing PDFs with the failure swallowed,
// and a narrowed OAuth token showed as a healthy green "OpenEMR connected".
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const openemrSrc = fs.readFileSync(path.join(root, 'openemr.js'), 'utf8');

// ---- Scope list: the patched routes are unreachable without these ----
test('config requests the five Phase 6B scopes', () => {
  const scopes = require(path.join(root, 'config.js')).OPENEMR.SCOPES.split(/\s+/);
  for (const s of ['user/billing.read', 'user/billing.write', 'user/order.read',
    'user/order.write', 'user/codes.read']) {
    assert.ok(scopes.includes(s), `missing ${s} — the 6B routes 401 "Unauthorized" without it`);
  }
  // A token is the intersection of requested and registered, so requesting
  // fewer than the v4 client holds silently re-creates the stale-client bug.
  assert.strictEqual(scopes.length, 54, 'scope list must match the v4 client (54)');
});

test('prescription scopes are requested (8.4 native Rx write)', () => {
  const scopes = require(path.join(root, 'config.js')).OPENEMR.SCOPES.split(/\s+/);
  assert.ok(scopes.includes('user/prescription.write'));
  // 8.4 does not define this one; requesting it is harmless but recording the
  // fact stops a future session re-litigating it (orders go via the 6B route).
  assert.ok(!scopes.includes('user/procedure.write'), 'user/procedure.write does not exist on 8.4');
});

// ---- The document route is keyed by NUMERIC pid on 8.4 ----
test('uploadPatientDocument resolves a numeric pid before posting', () => {
  const fn = openemrSrc.slice(openemrSrc.indexOf('async uploadPatientDocument'));
  const body = fn.slice(0, fn.indexOf('\n    }'));
  assert.match(body, /const pid = await resolvePid\(puuid\)/,
    'must resolve the numeric pid — 8.4 answers 400 {"pid":["Invalid pid"]} for a uuid');
  assert.match(body, /patient\/\$\{pid\}\/document/, 'the path must carry the numeric pid');
  assert.doesNotMatch(body, /patient\/\$\{encodeURIComponent\(puuid\)\}\/document/,
    'the uuid-keyed path is the 7.0.4 shape and 400s on 8.4');
});

// ---- 404 means "empty", not "broken" ----
test('list reads that answer 404-when-empty return an empty array', () => {
  for (const fnName of ['getPatientAppointmentRows', 'getMedicationRows']) {
    const fn = openemrSrc.slice(openemrSrc.indexOf(`async ${fnName}`));
    const body = fn.slice(0, fn.indexOf('\n    }'));
    assert.match(body, /if \(res\.status === 404\) return \[\]/,
      `${fnName} must treat 404 as an empty list — verified live: a patient with no ` +
      'appointments answers 404 with an empty body, and without this the tab shows a red error');
  }
});

// ---- The status probe must name a scope shortfall ----
test('getStatus reports the scope shortfall by capability, not just connectivity', () => {
  const g = openemrSrc.slice(openemrSrc.indexOf('const getStatus'));
  for (const key of ['missingScopes', 'requestedScopeCount', 'nativeWriteScopes', 'billingRouteScopes']) {
    assert.match(g, new RegExp(key), `getStatus must surface ${key}`);
  }
  // The whole point: a narrowed token still connects, so `connected` alone
  // cannot be the signal. Since Session 5.2 the token is the USER's, so the
  // capability check lives in emrAuth.statusFor and getStatus forwards it.
  const emrAuthSrc = fs.readFileSync(path.join(root, 'emrAuth.js'), 'utf8');
  const sf = emrAuthSrc.slice(emrAuthSrc.indexOf('const statusFor'));
  assert.match(sf, /user\/billing\.write/, 'the billing-route check must name the 6B scopes');
  assert.match(g, /tokenProvider\.statusFor\(actor\)/, 'getStatus reports the acting user\'s own grant');
});

test('the workspace renders a stale-client banner keyed to those capabilities', () => {
  const html = fs.readFileSync(path.join(root, 'public', 'clinical.html'), 'utf8');
  assert.match(html, /billingRouteScopes === false \|\| emrStatus\.nativeWriteScopes === false/,
    'the banner must fire on either shortfall');
  assert.match(html, /OpenEMR client is out of date for 8\.4/);
});

// ---- Things 4.5 must NOT do (guardrails from the session prompt) ----
test('the patient-facing care-plan PDF is never served from OpenEMR Documents', () => {
  // DocumentReference still 403s at the ACL layer; the Drive reference stands.
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const route = server.slice(server.indexOf("'/api/gfc/clinical/care-plan.pdf'"));
  const block = route.slice(0, 4000);
  assert.doesNotMatch(block, /getDocumentReferences|uploadPatientDocument/,
    'the patient download must come from client.carePlanDocs via Drive');
});

test('the FHIR bundle dedupe is still in place (8.4 still returns encounters twice)', () => {
  assert.match(openemrSrc, /const bundleResources = \(bundle\) => \{[\s\S]*?seen\.has\(key\)/,
    'verified live 2026-09-06: 28 rows for 14 encounters');
});

// ---- An expired session must send the user to login, not paint red text ----
test('auth failures carry codes a client can act on, distinct from permission 403s', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  for (const c of ['AUTH_MISSING', 'AUTH_EXPIRED', 'AUTH_INVALID', 'AUTH_INACTIVE']) {
    assert.ok(server.includes(c), `authenticateToken must emit ${c}`);
  }
  // A permission denial is a signed-in user being told no — it must NOT carry
  // an auth code, or the client would log them out for asking.
  const readOnly = server.slice(server.indexOf('CLINICAL_READ_ONLY') - 200, server.indexOf('CLINICAL_READ_ONLY') + 60);
  assert.doesNotMatch(readOnly, /AUTH_(EXPIRED|INVALID|MISSING|INACTIVE)/,
    'CLINICAL_READ_ONLY must stay distinguishable from an auth failure');
});

test('the client treats an auth-coded 403 as session expiry', () => {
  const html = fs.readFileSync(path.join(root, 'public', 'clinical.html'), 'utf8');
  assert.match(html, /AUTH_MISSING'?,\s*'AUTH_EXPIRED'?,\s*'AUTH_INVALID'?,\s*'AUTH_INACTIVE'/,
    'handleResponse must key on the auth codes — the server answers a bad JWT with 403, not 401');
  assert.match(html, /isAuthFailure/);
});

test('an unknown EMR status is not painted as a failed one', () => {
  const html = fs.readFileSync(path.join(root, 'public', 'clinical.html'), 'utf8');
  assert.match(html, /emrStatus === null \? 'bg-stone-300'/,
    'a status that has not answered yet must read neutral, not red');
});

// ---- Scope B: the charge payload must never swap CPT and ICD ----
// Phase 6B's second defect was introduced by the fix for its first: a loop
// reused the variable holding the CPT, so the charge billed the diagnosis. It
// returned 201 and looked right in Billing Manager. Pin the separation.
const R = require('../clinicalRepository.js');
const CHARGE_REC = {
  diagnoses: [{ code: 'E11.9' }, { code: 'I10' }],
  services: [{ code: '99348', codeType: 'CPT4', description: 'Home visit' },
             { code: 'G0180', codeType: 'HCPCS', description: 'Cert' }]
};

test('buildChargePayloads bills the service code, never a diagnosis', () => {
  const p = R.buildChargePayloads(CHARGE_REC, { providerId: 5 });
  assert.equal(p.length, 2, 'one line per service');
  assert.deepEqual(p.map(x => x.code), ['99348', 'G0180']);
  assert.deepEqual(p.map(x => x.code_type), ['CPT4', 'HCPCS']);
  for (const line of p) {
    const dx = line.diagnoses.map(d => d.code);
    assert.deepEqual(dx, ['E11.9', 'I10'], 'diagnoses are the ICD codes');
    assert.ok(!dx.includes(line.code), 'the billed code must never appear as its own diagnosis');
    assert.ok(!dx.some(c => ['99348', 'G0180'].includes(c)), 'no service code may leak into diagnoses');
    assert.ok(line.diagnoses.every(d => d.code_type === 'ICD10'));
  }
});

test('a service linked to specific diagnoses bills only those', () => {
  const rec = { ...CHARGE_REC, services: [{ code: '99348', codeType: 'CPT4', linkedDiagnoses: ['I10'] }] };
  const [line] = R.buildChargePayloads(rec, { providerId: 5 });
  assert.deepEqual(line.diagnoses.map(d => d.code), ['I10']);
  assert.equal(line.code, '99348');
});

test('billing_facility is never on a charge payload', () => {
  // addBilling() has no such parameter and the billing table no such column;
  // it belongs on form_encounter. Build-enforced so nobody "helpfully" adds it.
  for (const line of R.buildChargePayloads(CHARGE_REC, { providerId: 5 })) {
    assert.ok(!('billing_facility' in line), 'billing_facility must stay off the charge');
  }
  const src = fs.readFileSync(path.join(root, 'clinicalRepository.js'), 'utf8');
  const fn = src.slice(src.indexOf('const buildChargePayloads'), src.indexOf('const ORDER_STATUS_TO_EMR'));
  assert.doesNotMatch(fn, /billing_facility\s*:/, 'no billing_facility key in the charge builder');
});

test('order status maps app vocabulary to OpenEMR vocabulary', () => {
  assert.equal(R.orderStatusToEmr('ordered'), 'pending');
  assert.equal(R.orderStatusToEmr('sent'), 'routed');
  assert.equal(R.orderStatusToEmr('resulted'), 'complete');
  assert.equal(R.orderStatusToEmr('cancelled'), 'canceled');
  assert.equal(R.orderStatusToEmr('nonsense'), 'pending', 'unknown falls back to the safe start state');
});

test('charges post at sign-and-close with the signing clinician as rendering provider', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const sign = server.slice(server.indexOf("encounters/:euuid/sign'"), server.indexOf("encounters/:euuid/sign'") + 6000);
  assert.match(sign, /buildChargePayloads/, 'sign-and-close must post charges');
  assert.match(sign, /attestation\.signedBy && attestation\.signedBy\.openEmrProviderId/,
    'rendering provider is the signing clinician');
  assert.match(sign, /billing_npi_used/, 'billing provider stays the config value');
  // A charge failure must never void a signature that already succeeded.
  assert.match(sign, /chargesPosted = false/);
});

// ---- Scope D: per-visit billing facility ----
test('a visit may carry a billing facility, and omits the key when none is picked', () => {
  const actor = { id: 'u', name: 'Bethel Godwins', licenseLevel: 'FNP', npi: '1902310568' };
  const form = { reason: 'Follow-up', subjective: 'S', objective: 'O', assessment: 'A', plan: 'P' };
  const picked = R.buildFollowUpWrites({ ...form, billingFacilityId: '4' }, actor, {});
  assert.equal(picked.encounter.billing_facility, '4');
  const none = R.buildFollowUpWrites(form, actor, {});
  assert.ok(!('billing_facility' in none.encounter),
    'with no pick the key is omitted so the instance default applies');
  const junk = R.buildFollowUpWrites({ ...form, billingFacilityId: 'not-a-number' }, actor, {});
  assert.ok(!('billing_facility' in junk.encounter), 'a non-numeric id is ignored, not passed through');
});

test('the billing-facility route writes form_encounter and verifies the read-back', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const route = server.slice(server.indexOf("billing-facility'"), server.indexOf("billing-facility'") + 3000);
  assert.match(route, /updateEncounter\(/, 'it must go through the encounter PUT');
  assert.match(route, /billing_facility: facilityId/);
  // OpenEMR can answer 200 without storing; the route must read back.
  assert.match(route, /FACILITY_NOT_STORED/, 'the route must assert the stored value, not the status code');
  assert.doesNotMatch(route, /postCharge/, 'the facility must never touch a charge');
});

// ---- Facility and POS derive from the PATIENT, never a global ----
// Owner spec 2026-09-08: POS is a property of the facility record, set once.
// The patient's facility assignment selects it. A clinician never sees or picks
// a POS. The global default is the actual defect: it puts POS 12 on a Hickory
// Log claim, silently, the day that facility goes live.
test('createEncounter defaults neither facility_id nor pos_code', () => {
  const src = fs.readFileSync(path.join(root, 'openemr.js'), 'utf8');
  const fn = src.slice(src.indexOf('async createEncounter'), src.indexOf('async createEncounter') + 1400);
  assert.doesNotMatch(fn, /facility_id:\s*config\./,
    'facility_id must come from the patient, resolved by the caller — never config');
  assert.doesNotMatch(fn, /pos_code:\s*config\./,
    'pos_code must come from the facility record — never config');
  // The business address IS legitimately global: it is the practice.
  assert.match(fn, /billing_facility: config\.OPENEMR\.BILLING_FACILITY_ID/);
});

test('POS follows the patient facility, and telehealth is the only per-visit variation', () => {
  const F = [{ id: 3, name: 'Vinings', pos_code: '11' },
             { id: 5, name: 'Private residence', pos_code: '12' },
             { id: 6, name: 'Hickory Log', pos_code: '13' },
             { id: 7, name: 'Telehealth', pos_code: '10' }];
  const go = (o) => R.resolveEncounterFacility({ facilities: F, ...o });

  assert.equal(go({ patientFacilityId: 5 }).posCode, '12', 'private residence bills 12');
  assert.equal(go({ patientFacilityId: 6 }).posCode, '13', 'Hickory Log bills 13, not the old global 12');
  assert.equal(go({ patientFacilityId: 3 }).posCode, '11', 'an office visit bills 11');

  // Telehealth keys off the appointment, not a dropdown.
  const tele = go({ patientFacilityId: 6, telehealthFacilityId: 7, appointmentLocation: 'telehealth' });
  assert.equal(tele.posCode, '10');
  assert.equal(tele.source, 'telehealth_appointment');

  // No telehealth record yet: use the patient's place and SAY SO. Never invent 10.
  const noTele = go({ patientFacilityId: 6, appointmentLocation: 'telehealth' });
  assert.equal(noTele.posCode, '13');
  assert.match(noTele.warning, /no telehealth facility record/i);
});

test('an unassigned patient is reported, never silently defaulted', () => {
  // This is the whole point: silence is the defect being removed.
  const F = [{ id: 5, name: 'Private residence', pos_code: '12' }];
  const none = R.resolveEncounterFacility({ facilities: F });
  assert.equal(none.posCode, null, 'no POS may be invented for an unassigned patient');
  assert.equal(none.error, R.FACILITY_UNASSIGNED);
  assert.match(none.warning, /not assigned to an OpenEMR facility/i);

  const stale = R.resolveEncounterFacility({ patientFacilityId: 99, facilities: F });
  assert.equal(stale.posCode, null);
  assert.equal(stale.error, R.FACILITY_UNASSIGNED);

  // A facility with no POS on its record is an OpenEMR data gap, and the fix is
  // on the facility — not a code typed in the app.
  const noPos = R.resolveEncounterFacility({ patientFacilityId: 8, facilities: [{ id: 8, name: 'New ALF' }] });
  assert.equal(noPos.posCode, null);
  assert.match(noPos.warning, /no place-of-service code on its record/i);
});

test('signing is gated on a derived place of service', () => {
  const src = fs.readFileSync(path.join(root, 'clinicalRepository.js'), 'utf8');
  assert.match(src, /facility_pos: 'SIGN_NO_FACILITY_POS'/,
    'a signed encounter becomes a claim, and a claim needs a real POS');
});

test('the facility assignment is per-patient, admin-set, and never a clinician choice', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const route = server.slice(server.indexOf("patients/:clientId/facility'"), server.indexOf("patients/:clientId/facility'") + 2600);
  assert.match(route, /requireAdmin/, 'assignment is an admin action, not a clinician one');
  assert.match(route, /openEmrFacilityId/);
  // The POS is read off OpenEMR's facility record; it is never typed here.
  assert.doesNotMatch(route, /pos_code\s*=/, 'the app must never set a POS itself');
  assert.match(route, /Set it on the facility/, 'a missing POS is fixed on the facility, not in the app');
});

test('encounter creation resolves the place from the patient, at every site', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const creates = server.split('createEncounter(puuid, built.encounter)');
  assert.equal(creates.length, 3, 'expected exactly two encounter-create sites');
  // Each site must resolve the place immediately before creating.
  for (const before of creates.slice(0, 2)) {
    const tail = before.slice(-700);
    assert.match(tail, /resolveFacilityForVisit\(emr, client/,
      'every encounter create must derive facility and POS from the patient');
  }
  // Telehealth comes off the appointment, never a dropdown.
  assert.match(server, /decodeAppointmentNotes\(appointment\.pc_hometext\)\.location/);
});

// ---- Code search must not infer a load state from a search result ----
//
// The bug this pins cost a wrong answer to the owner. `GET /api/codes`
// returning zero rows was read as "the ICD-10-CM set has not been loaded", and
// the app said so to clinicians. Two unrelated things produce zero rows: a term
// that matches nothing, and a code set that was never installed. The load HAD
// run; the search simply could not see it, because the 6B route was querying
// the manually entered `codes` table while OpenEMR's External Data Loads writes
// ICD-10 to its own external table. Both halves are guarded here.

const serverSrc = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

test('searchEmrCodes reports no load state — a search result is not evidence of one', () => {
  const fn = serverSrc.slice(serverSrc.indexOf('const searchEmrCodes ='));
  const body = fn.slice(0, fn.indexOf('\n};'));
  assert.ok(!/loaded\s*:/.test(body),
    'searchEmrCodes must not return a `loaded` flag — zero rows means the term ' +
    'matched nothing, which says nothing about whether the code set is installed');
  assert.ok(!/rows\.length > 0/.test(body),
    'row count must not stand in for load state');
});

test('the clinician-facing notice never claims a code set is unloaded', () => {
  const route = serverSrc.slice(serverSrc.indexOf("app.get('/api/clinical/codes/search'"));
  // to the next top-level route — the handler nests plenty of its own `});`
  const body = route.slice(0, route.indexOf('\napp.', 1));
  assert.ok(!/has not been loaded|hasn't been loaded|load has not run/i.test(body),
    'the route cannot observe whether a code set is loaded, so it must not assert it');
  assert.ok(!/codeTableLoaded/.test(body),
    'codeTableLoaded was the inference itself — it must stay gone');
  // It may still point an ADMIN at the loader as a possibility, which is
  // advice rather than a claim about the current state.
  // the apostrophe is backslash-escaped in the source string
  assert.match(body, /No match in OpenEMR\\?'s code tables for this term/,
    'the notice should describe the search that just ran');
});

// ---- The 6B route must search OpenEMR's external code tables ----
test('the 6B code search defers to OpenEMR main_code_set_search', () => {
  const ctrl = fs.readFileSync(path.join(root,
    'docs/openemr-patches/8.4.0-p1/src/RestControllers/GfcChargeRestController.php'), 'utf8');
  const fn = ctrl.slice(ctrl.indexOf('public function searchCodes'));
  const body = fn.slice(0, fn.indexOf("\n    private function"));
  assert.match(body, /main_code_set_search\(/,
    'must use OpenEMR own search, which reads the external code tables the ' +
    'Fee Sheet reads (interface/forms/fee_sheet/new.php calls the same function)');
  assert.ok(!/FROM codes c JOIN code_types/.test(body),
    'the hand-written `codes`-only query never sees an externally loaded code ' +
    'set, so it returns zero rows whether or not the load has run');
  assert.match(body, /require_once.*code_types\.inc\.php/,
    'main_code_set_search lives in custom/code_types.inc.php');
});
