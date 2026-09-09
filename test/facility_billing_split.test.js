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

test('a configured id that disagrees with OpenEMR is reported, not silently preferred', () => {
  // This is the live case: config defaulted to 3, OpenEMR names 4.
  const r = repo.resolveBillingFacility({ facilities: FACILITIES, configuredId: '3' });
  assert.strictEqual(r.facilityId, '4', "OpenEMR's own record wins");
  assert.match(r.warning, /configured billing facility is 3/);
  assert.match(r.warning, /admin should settle it/);
});

test('ambiguous flags fall to the configured id and say why', () => {
  const ambiguous = FACILITIES.map(f => ({ ...f, primary_business_entity: '0' }));
  const r = repo.resolveBillingFacility({ facilities: ambiguous, configuredId: '3' });
  assert.strictEqual(r.facilityId, '3');
  assert.strictEqual(r.source, 'configured');
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
  const bill = repo.resolveBillingFacility({ facilities: FACILITIES, configuredId: null });
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
