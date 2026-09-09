// Live proof that service location and billing entity are two different things.
//
// Owner report 2026-09-09: both were set from one setting, so they always
// matched — wrong for a practice whose care happens in patients' homes. This
// asserts the STORED values on real OpenEMR rows, never a status code: the
// conflated version returned 201 and looked correct on the calendar.
//
//   OPENEMR_CLIENT_ID=… OPENEMR_CLIENT_SECRET=… OPENEMR_API_USERNAME=… \
//     OPENEMR_API_PASSWORD=… node scripts/verify_facility_split.js
//
// TEST DATA only. Appointments it creates are cancelled (tombstoned) at the end.
const o = require('../openemr.js');
const repo = require('../clinicalRepository.js');
const e = o.forActor({ id: 'splitprobe', name: 'facility split probe', role: 'admin' });
const U = 'a284d5c2-670e-4a62-aa95-2d1aa629003c';
let pass = 0, fail = 0;
const ok = (c, l, x) => { c ? (pass++, console.log('  PASS  ' + l))
  : (fail++, console.log('  FAIL  ' + l + (x !== undefined ? ' :: ' + JSON.stringify(x) : ''))); };

(async () => {
  const facilities = await e.getFacilities();
  console.log('facilities on the instance:');
  facilities.forEach(f => console.log(`  ${f.id}  POS ${f.pos_code}  service=${f.service_location} ` +
    `billing=${f.billing_location} primary=${f.primary_business_entity}  ${f.name}`));
  console.log('');

  // ---- The billing entity is what OpenEMR says it is ----
  const bill = repo.resolveBillingFacility({ facilities, configuredId: null });
  ok(bill.facilityId, 'a billing entity resolves from OpenEMR', bill);
  ok(bill.source === 'primary_business_entity' || bill.source === 'sole_billing_location',
    `billing entity comes from OpenEMR's own flag (${bill.source})`, bill);

  // ---- Each service facility keeps its OWN pos, and none is the biller ----
  const services = facilities.filter(f => String(f.service_location) === '1');
  ok(services.length > 0, 'at least one facility is a service location');
  for (const f of services) {
    const r = repo.resolveEncounterFacility({
      patientFacilityId: f.id, telehealthFacilityId: null, appointmentLocation: null, facilities });
    ok(r.posCode === String(f.pos_code),
      `facility ${f.id} (${f.name}) resolves to its own POS ${f.pos_code}, not a global`, r);
  }
  const nonOffice = facilities.filter(f => String(f.pos_code) !== '11');
  ok(nonOffice.length > 0,
    'a non-office place of service exists (POS 12/13 — the whole point of the split)',
    facilities.map(f => f.pos_code));
  for (const f of nonOffice) {
    ok(String(f.id) !== String(bill.facilityId),
      `service facility ${f.id} (POS ${f.pos_code}) is NOT the billing entity — that is the split`);
  }

  // ---- A real appointment: the two fields must differ on the stored row ----
  const provs = await e.getPractitionerRows();
  const PROV = Number((provs.find(p => p.id) || {}).id);
  const homeFac = services.find(f => String(f.pos_code) !== '11') || services[0];
  const built = repo.buildAppointmentFields({
    date: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
    startTime: '09:00', durationMinutes: 30, providerId: String(PROV),
    title: 'TEST DATA facility split probe', location: 'home'
  }, { categoryId: '5' });
  if (built.error) { ok(false, 'appointment builder', built); return done(); }
  ok(!('pc_facility' in built.fields) && !('pc_billing_location' in built.fields),
    'the builder supplies NEITHER facility field', built.fields);

  built.fields.pc_facility = String(homeFac.id);
  built.fields.pc_billing_location = String(bill.facilityId);
  const eid = await e.createAppointmentRow(U, built.fields);
  const row = await e.getAppointmentRow(U, eid);
  ok(String(row.pc_facility) === String(homeFac.id),
    `stored service facility is the patient's place (${homeFac.id})`, row.pc_facility);
  ok(String(row.pc_billing_location) === String(bill.facilityId),
    `stored billing location is the business entity (${bill.facilityId})`, row.pc_billing_location);
  ok(String(row.pc_facility) !== String(row.pc_billing_location),
    'THE REPORTED DEFECT: the two stored values differ', 
    { facility: row.pc_facility, billing: row.pc_billing_location });

  // ---- A swap re-stamps billing rather than inheriting it ----
  const tomb = repo.buildCancelTombstone(row,
    { reason: 'TEST DATA probe cleanup', byName: 'probe', billingFacilityId: bill.facilityId });
  ok(String(tomb.pc_facility) === String(homeFac.id),
    'the tombstone preserves where the visit was to happen');
  ok(String(tomb.pc_billing_location) === String(bill.facilityId),
    'the tombstone carries the business entity, not the service facility');
  const swap = await e.swapAppointment(U, row.pc_eid, [tomb]);
  const tombRow = await e.getAppointmentRow(U, swap.newEids[0]);
  ok(String(tombRow.pc_facility) !== String(tombRow.pc_billing_location),
    'the stored tombstone keeps them distinct too',
    { facility: tombRow.pc_facility, billing: tombRow.pc_billing_location });

  done();
})().catch(err => { console.error('\nPROBE ERROR:', err.message); process.exit(1); });

function done() {
  console.log(`\n================  ${pass} passed, ${fail} failed  ================`);
  process.exit(fail ? 1 : 0);
}
