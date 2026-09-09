// Service location vs billing entity — they must never come from one source.
//
// Owner report, 2026-09-09: "The app currently sets both from the same setting,
// which means they'll always match, which is exactly wrong for a home-visit
// practice." Encounters were split in Session 4.5; APPOINTMENTS were not, and
// the config chained one env var into the other, so on the deployed instance
// both halves still came from `OPENEMR_FACILITY_ID`.
//
// The failure mode is the dangerous kind: OpenEMR accepts it, the row looks
// right on the calendar and in Billing Manager, and it surfaces months later as
// a denial on every home visit. So these assert the SHAPE of the code as well
// as its output — a future edit that reintroduces a shared default fails here.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const repo = require(path.join(root, 'clinicalRepository.js'));

const FACILITIES = [
  { id: '3', name: 'Godwins Family Care, LLC - Vinings', pos_code: '11', service_location: '1', billing_location: '1', primary_business_entity: '0' },
  { id: '4', name: 'Godwins Family Care, LLC - Buckhead', pos_code: '11', service_location: '1', billing_location: '1', primary_business_entity: '1' },
  { id: '5', name: 'Private Residence', pos_code: '12', service_location: '1', billing_location: '0', primary_business_entity: '0' },
  { id: '6', name: 'Hickory Log Personal Care Home', pos_code: '13', service_location: '0', billing_location: '0', primary_business_entity: '0' }
];

// ---- The billing entity comes from OpenEMR, not from a setting ----

test('billing facility resolves to the primary business entity', () => {
  const r = repo.resolveBillingFacility({ facilities: FACILITIES, configuredId: null });
  assert.strictEqual(r.facilityId, '4');
  assert.strictEqual(r.source, 'primary_business_entity');
  assert.strictEqual(r.warning, null);
});

test('an explicit configured id wins over OpenEMR, and the disagreement is reported', () => {
  // The live case, and the owner's decision (2026-09-09): bill to 3 (Vinings),
  // while OpenEMR's primary-business-entity flag points at 4 (Buckhead). The
  // practice decides who bills; deferring to a flag nobody maintains would put
  // the wrong address on every claim. But it is never silent — the warning is
  // what eventually gets OpenEMR corrected.
  const r = repo.resolveBillingFacility({ facilities: FACILITIES, configuredId: '3' });
  assert.strictEqual(r.facilityId, '3', "the practice's decision wins");
  assert.strictEqual(r.source, 'configured');
  assert.match(r.warning, /OpenEMR marks 4/);
  assert.match(r.warning, /mark 3 as the primary business entity/);
});

test('agreement produces no warning', () => {
  const agreed = FACILITIES.map(f => ({ ...f, primary_business_entity: f.id === '3' ? '1' : '0' }));
  const r = repo.resolveBillingFacility({ facilities: agreed, configuredId: '3' });
  assert.strictEqual(r.facilityId, '3');
  assert.strictEqual(r.warning, null, 'nothing to report once OpenEMR and the setting agree');
});

test('a configured id naming a facility that does not exist is surfaced', () => {
  const r = repo.resolveBillingFacility({ facilities: FACILITIES, configuredId: '99' });
  assert.strictEqual(r.facilityId, '4', "falls back to OpenEMR's own business entity");
  assert.match(r.warning, /does not exist in OpenEMR/);
});

test('ambiguous flags with no configured id are reported, never guessed', () => {
  // Several billing locations and no primary: there is no honest answer, and
  // guessing puts an address on a claim.
  const ambiguous = FACILITIES.map(f => ({ ...f, primary_business_entity: '0' }));
  const r = repo.resolveBillingFacility({ facilities: ambiguous, configuredId: null });
  assert.strictEqual(r.facilityId, null);
  assert.strictEqual(r.error, repo.BILLING_FACILITY_UNRESOLVED);
});

test('ambiguous flags WITH a configured id use it and say why', () => {
  const ambiguous = FACILITIES.map(f => ({ ...f, primary_business_entity: '0' }));
  const r = repo.resolveBillingFacility({ facilities: ambiguous, configuredId: '3' });
  assert.strictEqual(r.facilityId, '3');
  assert.match(r.warning, /2 facilities as billing locations/);
});

test('no business entity and no config is an error, never a guess', () => {
  const none = FACILITIES.map(f => ({ ...f, primary_business_entity: '0', billing_location: '0' }));
  const r = repo.resolveBillingFacility({ facilities: none, configuredId: null });
  assert.strictEqual(r.facilityId, null);
  assert.strictEqual(r.error, repo.BILLING_FACILITY_UNRESOLVED);
});

// ---- The service facility still follows the patient ----

test('service facility follows the patient, and carries that facility POS', () => {
  const hickory = repo.resolveEncounterFacility({
    patientFacilityId: '6', telehealthFacilityId: null, appointmentLocation: null, facilities: FACILITIES });
  assert.strictEqual(hickory.facilityId, '6');
  assert.strictEqual(hickory.posCode, '13', 'a Hickory Log visit must not inherit the office POS');

  const home = repo.resolveEncounterFacility({
    patientFacilityId: '5', telehealthFacilityId: null, appointmentLocation: null, facilities: FACILITIES });
  assert.strictEqual(home.posCode, '12');

  // The whole point: two patients, two different places, one billing entity.
  const bill = repo.resolveBillingFacility({ facilities: FACILITIES, configuredId: '3' });
  assert.notStrictEqual(hickory.facilityId, bill.facilityId);
  assert.notStrictEqual(home.facilityId, bill.facilityId);
});

// ---- The appointment builder must not supply either field ----

test('buildAppointmentFields emits neither facility field', () => {
  const built = repo.buildAppointmentFields(
    { date: '2026-09-10', startTime: '10:00', durationMinutes: 60, providerId: '5' },
    { categoryId: '5' });
  assert.ok(!built.error, built.error);
  assert.ok(!('pc_facility' in built.fields),
    'the builder must not set a service facility — it cannot know where the patient lives');
  assert.ok(!('pc_billing_location' in built.fields),
    'the builder must not set a billing entity — that is a live read');
});

test('no hardcoded facility id survives in the appointment builders', () => {
  const src = fs.readFileSync(path.join(root, 'clinicalRepository.js'), 'utf8');
  const fn = src.slice(src.indexOf('const buildAppointmentFields'), src.indexOf('const findAppointmentConflict'));
  assert.ok(!/\|\|\s*'3'/.test(fn),
    "'3' as a fallback is the office — a home visit must never silently land there");
});

test('a swap re-stamps the billing entity instead of copying the old one', () => {
  const legacyRow = {  // booked before the split: billing == service == office
    pc_eid: '9', pc_catid: '5', pc_title: 'Visit', pc_duration: '3600',
    pc_eventDate: '2026-09-10', pc_startTime: '10:00', pc_aid: '5',
    pc_facility: '5', pc_billing_location: '5'
  };
  const t = repo.buildCancelTombstone(legacyRow,
    { reason: 'test', byName: 'X', billingFacilityId: '4' });
  assert.strictEqual(t.pc_facility, '5', 'the place the visit happened is preserved verbatim');
  assert.strictEqual(t.pc_billing_location, '4', 'the billing entity is corrected, not inherited');

  const ns = repo.buildStatusSwap(legacyRow, repo.APPT_STATUS.noShow,
    { byName: 'X', billingFacilityId: '4' });
  assert.strictEqual(ns.pc_billing_location, '4');
});

// ---- Build-enforced: one value can never feed both fields again ----

test('no call site sets both facility fields from one expression', () => {
  for (const f of ['clinicalRepository.js', 'server.js']) {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    const lines = src.split('\n');
    lines.forEach((line, n) => {
      const code = line.replace(/\/\/.*$/, '');   // prose may name both; code may not
      if (/pc_facility/.test(code) && /pc_billing_location/.test(code)) {
        assert.fail(`${f}:${n + 1} sets both facility fields on one line — they have two sources`);
      }
    });
    // The old shape: `facilityId` handed to something that fills both. Strip
    // comments first — the history is deliberately recorded in them.
    const code = src.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
    assert.ok(!/defaults\.facilityId/.test(code),
      `${f}: a single defaults.facilityId is what fed both fields`);
  }
});

test('BILLING_FACILITY_ID does not chain to the service facility env var', () => {
  const src = fs.readFileSync(path.join(root, 'config.js'), 'utf8');
  const line = src.split('\n').find(l => /BILLING_FACILITY_ID:/.test(l));
  assert.ok(line, 'BILLING_FACILITY_ID must still exist as an override');
  assert.ok(!/OPENEMR_FACILITY_ID/.test(line),
    'chaining these is the reported defect: the deployment sets only OPENEMR_FACILITY_ID, ' +
    'so both halves came from one value and always matched');
});

test('there is no global SERVICE facility config value at all', () => {
  const cfg = require(path.join(root, 'config.js'));
  assert.ok(!('FACILITY_ID' in cfg.OPENEMR),
    'a global service facility is what puts the office POS on every home visit');
});
