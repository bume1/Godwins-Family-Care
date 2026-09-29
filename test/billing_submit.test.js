// ============================================================
// Clinician signs → billing submits (owner, 2026-09-29).
//
// "Notes should be able to be signed and submitted following ICD code
// submission. CPT isn't necessary for the note to be signable because the
// billing person adds it after. The clinician should sign and submit which
// locks the note to clinicians and allows it to remain editable for billing
// and admin. Then billing submits fully."
//
// And: a place of service is billing's alone. A clinician never sees one, is
// never warned about one, and is never refused over one.
//
// The HTTP half is scripts/verify_note_lifecycle.js sections 13–14, through the
// real routes with a clinician login that cannot read OpenEMR's facilities.
// ============================================================
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const R = require('../clinicalRepository');
const roles = require('../clinicalRoles');
const inbox = require('../clinicalInbox');

const root = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const page = fs.readFileSync(path.join(root, 'public', 'clinical.html'), 'utf8');
const routeBody = (src, anchor) => {
  const i = src.indexOf(anchor);
  assert.ok(i > 0, `anchor missing: ${anchor}`);
  return src.slice(i, src.indexOf('\n});\n', i));
};

const DX = [{ code: 'I10', description: 'Essential hypertension' }];
const SVC = [{ code: '99349', codeType: 'CPT4', dxLinks: ['I10'], modifiers: [] }];
const NPI = '1234567893';

// ---- the two gates -------------------------------------------------------

test('the clinical gate signs with a note and one ICD-10 — no CPT, no billing NPI, no place of service', () => {
  const r = R.checkSignReadiness({ hasNote: true, record: { diagnoses: DX, services: [] }, gate: 'clinical' });
  assert.equal(r.ok, true, r.message);
  assert.equal(r.message, null);
});

test('the clinical gate refuses with no ICD-10, and says nothing about CPT or a place of service', () => {
  const r = R.checkSignReadiness({ hasNote: true, record: { diagnoses: [], services: [] }, gate: 'clinical' });
  assert.equal(r.ok, false);
  assert.deepEqual(r.codes, ['SIGN_NO_DIAGNOSIS']);
  assert.match(r.message, /ICD-10/);
  assert.doesNotMatch(r.message, /CPT|place of service|POS|facility|billing/i,
    'a clinician is never told about a billing blocker');
});

test('the clinical gate ignores billing inputs even when they are wrong', () => {
  // Handed a missing POS, no billing NPI and an NCCI table that has never been
  // loaded — every one of which would block the BILLING gate.
  const r = R.checkSignReadiness({
    hasNote: true, record: { diagnoses: DX, services: SVC }, gate: 'clinical',
    posCode: null, posError: 'HTTP 403', billingNpi: null, ncciSourceVersion: { ptp: {}, mue: {} }
  });
  assert.equal(r.ok, true, r.message);
});

test('the author gate (RN, LMSW) still needs no diagnosis — a licensed clinician\'s addendum confirms it', () => {
  const r = R.checkSignReadiness({ hasNote: true, record: { diagnoses: [], services: [] }, gate: 'author' });
  assert.equal(r.ok, true);
  // And the pre-split spelling of the same gate still resolves to it.
  assert.equal(R.checkSignReadiness({ hasNote: true, record: { diagnoses: [], services: [] }, billingChecks: false }).gate, 'author');
});

test('the billing gate holds the claim: services, dx links, billing NPI, place of service', () => {
  const none = R.checkSignReadiness({ record: { diagnoses: DX, services: [] }, gate: 'billing' });
  assert.deepEqual(none.missing.sort(), ['billing_npi', 'facility_pos', 'service'].sort());
  assert.match(none.message, /^Cannot submit to billing:/);
  const unlinked = R.checkSignReadiness({ record: { diagnoses: DX, services: [{ ...SVC[0], dxLinks: [] }] }, billingNpi: NPI, posCode: '12', gate: 'billing' });
  assert.deepEqual(unlinked.missing, ['service_dx_link']);
  const ready = R.checkSignReadiness({ record: { diagnoses: DX, services: SVC }, billingNpi: NPI, posCode: '12', gate: 'billing',
    ncciSourceVersion: { ptp: { quarter: '2026Q4', loadedAt: new Date().toISOString() }, mue: { quarter: '2026Q4', loadedAt: new Date().toISOString() } } });
  assert.equal(ready.ok, true, ready.message);
});

test('an encounter that could not be READ is not reported as a patient with no facility', () => {
  // The owner report: a swallowed read failure read as "this patient has no
  // facility assigned", which sent people to fix the wrong thing.
  const unread = R.checkSignReadiness({ record: { diagnoses: DX, services: SVC }, billingNpi: NPI, posCode: null, posError: 'HTTP 403', gate: 'billing' });
  assert.deepEqual(unread.missing, ['pos_unreadable']);
  assert.deepEqual(unread.codes, ['BILLING_POS_UNREADABLE']);
  assert.match(unread.message, /could not be read back from OpenEMR/);
  assert.doesNotMatch(unread.message, /no facility assigned/);
  const missing = R.checkSignReadiness({ record: { diagnoses: DX, services: SVC }, billingNpi: NPI, posCode: null, gate: 'billing' });
  assert.deepEqual(missing.missing, ['facility_pos']);
});

test('the pre-split full gate is unchanged for any caller that predates it', () => {
  const r = R.checkSignReadiness({ hasNote: false, record: { diagnoses: [], services: [] }, billingNpi: NPI, posCode: '12' });
  assert.deepEqual(r.codes, ['SIGN_NO_NOTE', 'SIGN_NO_DIAGNOSIS', 'SIGN_NO_SERVICE']);
});

// ---- where a signed visit stands with billing ------------------------------

test('billing status: unsigned, awaiting an addendum, awaiting billing, billed, no charge — and legacy reads as billed', () => {
  const att = { signedAt: '2026-09-29T10:00:00Z' };
  assert.equal(R.deriveBillingStatus({}, null), 'not_signed');
  assert.equal(R.deriveBillingStatus({ coSignStatus: 'pending' }, att), 'awaiting_addendum');
  assert.equal(R.deriveBillingStatus({ billingStatus: 'awaiting_billing' }, att), 'awaiting_billing');
  assert.equal(R.deriveBillingStatus({ billingStatus: 'billed' }, att), 'billed');
  assert.equal(R.deriveBillingStatus({ billingStatus: 'no_charge' }, att), 'no_charge');
  // Signed before the split: the old sign posted charges itself. Nothing is migrated.
  assert.equal(R.deriveBillingStatus({ chargesPosted: true }, att), 'billed');
  assert.equal(R.isBillingSubmitted({ billingStatus: 'awaiting_billing' }, att), false);
  assert.equal(R.isBillingSubmitted({ billingStatus: 'no_charge' }, att), true);
});

test('the clinician attests to the note and the diagnoses, not to service codes billing adds later', () => {
  assert.match(R.ATTESTATION_TEXT, /diagnoses are supported by the note/);
  assert.doesNotMatch(R.ATTESTATION_TEXT, /service codes/);
});

// ---- who billing is --------------------------------------------------------

test('billing is an admin or a manager — never a clinical role by itself', () => {
  assert.equal(roles.canSubmitBilling({ role: 'admin' }), true);
  assert.equal(roles.canSubmitBilling({ role: 'user', isManager: true }), true);
  for (const clinicalRole of ['provider', 'rn', 'lcsw', 'lmsw', 'readOnly']) {
    assert.equal(roles.canSubmitBilling({ role: 'user', clinicalRole, hasClinicalAccess: true }), false, clinicalRole);
  }
  assert.equal(roles.canSubmitBilling({ role: 'caseManager' }), false);
  assert.equal(roles.canSubmitBilling({ role: 'user', isManager: true, accountStatus: 'inactive' }), false);
  assert.equal(roles.canSubmitBilling(null), false);
});

test('the inbox says a signed visit is waiting on billing, and only billing may act on it', () => {
  const recs = [{ encounterUuid: 'e1', clientId: 'c1', billingStatus: 'awaiting_billing', coSignStatus: 'not_required', services: [] }];
  const atts = [{ encounterUuid: 'e1', signedAt: '2026-09-29T10:00:00Z', signedBy: { id: 'fnp', name: 'Bethel' } }];
  const forAdmin = inbox.buildInbox({ viewer: { id: 'a', role: 'admin' }, encounterRecords: recs, attestations: atts });
  const a = forAdmin.items.find(i => i.kind === 'encounter_awaiting_billing');
  assert.ok(a && a.actionable === true && a.waitingOn === 'you');
  const forFnp = inbox.buildInbox({ viewer: { id: 'fnp', role: 'user', clinicalRole: 'provider' }, encounterRecords: recs, attestations: atts });
  const f = forFnp.items.find(i => i.kind === 'encounter_awaiting_billing');
  assert.ok(f && f.actionable === false && f.waitingOn === 'billing');
  assert.doesNotMatch(JSON.stringify(f), /place of service|POS/i);
});

// ---- the routes (build-enforced) -------------------------------------------

test('signing never posts a charge; it sends the note to billing', () => {
  const sign = server.slice(server.indexOf("encounters/:euuid/sign'"), server.indexOf("encounters/:euuid/co-sign'"));
  assert.doesNotMatch(sign, /postEncounterCharges\(/);
  assert.match(sign, /gate: authorSignature \? 'author' : 'clinical'/, 'the clinician is held to the clinical gate');
  assert.match(sign, /billingStatus = clinicalRepo\.BILLING_STATUS\.AWAITING_BILLING/);
  const coSign = routeBody(server, "app.post('/api/clinical/patients/:clientId/encounters/:euuid/co-sign'");
  assert.doesNotMatch(coSign, /postEncounterCharges\(/, 'the clinician addendum sends to billing too');
  assert.match(coSign, /gate: 'clinical'/);
});

test('Submit to billing is billing-only, runs the billing gate, and names the signing clinician on the charge', () => {
  const submit = routeBody(server, "app.post('/api/clinical/patients/:clientId/encounters/:euuid/billing-submit'");
  assert.match(submit, /authenticateToken, requireBilling,/);
  assert.match(submit, /gate: 'billing'/);
  assert.match(submit, /signedBy: record\.renderingProvider/, 'never the biller');
  assert.match(submit, /disallowedServiceCodesFor\(renderer/, 'the RENDERING clinician\'s code set, not the biller\'s');
  assert.match(submit, /stampEncounterPos\(ctx\)/, 'a missing place of service is stamped with billing\'s login');
  assert.match(submit, /BILLING_AWAITS_ADDENDUM/);
  assert.match(submit, /NO_CHARGE_REASON/);
  // Charge void and re-post are billing's too.
  assert.match(server, /charges\/repost', authenticateToken, requireBilling,/);
  assert.match(server, /charges\/:chargeId', authenticateToken, requireBilling,/);
});

test('after signing, the codes are billing\'s and the diagnoses stay the clinician\'s', () => {
  const coding = routeBody(server, "app.put('/api/clinical/patients/:clientId/encounters/:euuid/coding'");
  assert.match(coding, /requireClinicalWriteOrBilling/);
  assert.match(coding, /ENCOUNTER_WITH_BILLING/, 'a clinician is refused once the note is with billing');
  // The refusal must sit directly under the comparison — asserting the code
  // merely EXISTS passed with the refusal disabled (mutation-checked).
  assert.match(coding, /if \(dxKey\(before\) !== dxKey\(record\)\) \{\s*return res\.status\(409\)\.json\(\{[^}]*code: 'DX_LOCKED_AFTER_SIGN'/, 'billing cannot change a diagnosis');
  assert.match(coding, /record\.renderingProvider = before\.renderingProvider/, 'billing\'s edit never makes the biller the rendering provider');
  assert.match(coding, /BILLING_SUBMITTED/, 'codes lock for everyone once submitted');
});

test('no place of service reaches a clinician: warnings, the encounter, the banner, the catalog', () => {
  const resolver = server.slice(server.indexOf('const resolveFacilityForVisit ='), server.indexOf('const loadEncounterContext ='));
  // Both returns — the failed read AND the resolved place — carry no
  // clinician-facing warning. Counted, because one surviving match satisfied a
  // bare regex when the other was reverted (mutation-checked).
  assert.equal((resolver.match(/warning: null,\s*billingWarning:/g) || []).length, 2, 'resolveFacilityForVisit hands no caller a clinician-facing warning');
  assert.doesNotMatch(resolver, /[^A-Za-z]warning: place\.warning/);
  assert.match(resolver, /readFacilities\(emr\)/, 'and reads through the saved copy');
  const detail = routeBody(server, "app.get('/api/clinical/patients/:clientId/encounters/:euuid',");
  assert.match(detail, /\.\.\.\(canBill \? \{[\s\S]{0,200}posCode:/, 'the encounter\'s POS is spread in only for billing');
  assert.match(detail, /billingReadiness: canBill && ctx\.closed \?/);
  const chart = routeBody(server, "app.get('/api/clinical/patients/:clientId/chart'");
  assert.match(chart, /if \(!clinicalRoles\.canSubmitBilling\(req\.user\)\) delete banner\.facility;/);
  const pos = routeBody(server, "app.get('/api/clinical/patients/:clientId/place-of-service'");
  assert.match(pos, /if \(!clinicalRoles\.canSubmitBilling\(req\.user\)\) \{[\s\S]{0,120}return res\.json\(clinicianView\);/);
  assert.match(server, /app\.get\('\/api\/clinical\/facilities', authenticateToken, requireBilling,/);
});

test('the page draws place-of-service and billing controls only for billing', () => {
  assert.match(page, /\{chart\.linked && canBill && <PlaceOfServiceCard patient=\{patient\} \/>\}/);
  assert.match(page, /\{canBill && <BannerFact label="Facility &amp; POS">/);
  assert.match(page, /on\('sign'\) && closed && ba\.canBill && !awaitingAddendum && \(/, 'the Billing card');
  assert.match(page, /billingNpiConfigured === false && access\.canSubmitBilling &&/, 'the NPI banner');
  assert.match(page, /canSubmitBilling: !!\(emrStatus && emrStatus\.access && emrStatus\.access\.canSubmitBilling\)/, 'read from the server, not decided here');
  assert.doesNotMatch(page, /Its place of service will follow/, 'attaching a note says nothing about a place of service');
});

test('clinicians\' visits take their place of service from the copy billing saved', () => {
  const helpers = server.slice(server.indexOf('const FACILITY_SNAPSHOT_KEY'), server.indexOf('let billingFacilityCache'));
  // Run the helpers against a fake store rather than reading them.
  const store = new Map();
  const db = { get: async (k) => store.get(k) || null, set: async (k, v) => { store.set(k, v); } };
  // eslint-disable-next-line no-new-func
  const mk = new Function('db', `${helpers}; return { saveFacilitySnapshot, readFacilities, getFacilitySnapshot };`);
  const h = mk(db);
  const rows = [{ id: '5', name: 'Private Residence', pos_code: '12', street: 'not kept' }];
  const billingEmr = { getFacilities: async () => rows };
  const clinicianEmr = { getFacilities: async () => { throw new Error('HTTP 403'); } };
  return (async () => {
    await assert.rejects(h.readFacilities(clinicianEmr), /403/, 'with no copy yet, the live error surfaces');
    const live = await h.readFacilities(billingEmr, { id: 'mgr', name: 'M' });
    assert.equal(live.source, 'live');
    const snap = await h.getFacilitySnapshot();
    assert.deepEqual(snap.facilities, [{ id: '5', name: 'Private Residence', pos_code: '12' }], 'only the org fields are kept');
    const viaCopy = await h.readFacilities(clinicianEmr);
    assert.equal(viaCopy.source, 'snapshot');
    assert.equal(viaCopy.rows[0].pos_code, '12');
    // An empty live read never wipes a real copy.
    await h.readFacilities({ getFacilities: async () => [] });
    assert.equal((await h.getFacilitySnapshot()).facilities.length, 1);
  })();
});
