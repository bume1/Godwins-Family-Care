// ============================================================
// Booking a clinical visit when the booker cannot read OpenEMR's facility list
// (owner report, 2026-09-29: Bethel booking Juanita Guess got "OpenEMR did not
// return an appointment id").
//
// A clinician's own OpenEMR login cannot read facilities, and is not being
// given that permission. Until an admin or manager synced the saved copy, the
// booking route sent OpenEMR an appointment with no pc_facility and no
// pc_billing_location. OpenEMR refused it with a bare complaint map, which the
// app read as "no id". Three guards:
//   1. the facility and billing ids are still resolved without the list;
//   2. a patient with no facility is refused by the app, in plain words;
//   3. whatever OpenEMR says when it returns no id is put in the error.
// The helpers are lifted out of server.js and RUN, not read.
// Run: npm test
// ============================================================

process.env.OPENEMR_BASE_URL = process.env.OPENEMR_BASE_URL || 'https://emr.test';
process.env.OPENEMR_CLIENT_ID = process.env.OPENEMR_CLIENT_ID || 'cid';
process.env.OPENEMR_CLIENT_SECRET = process.env.OPENEMR_CLIENT_SECRET || 'secret';
process.env.OPENEMR_REDIRECT_URI = process.env.OPENEMR_REDIRECT_URI || 'https://app.test/cb';
process.env.EMR_TOKEN_ENCRYPTION_KEY = process.env.EMR_TOKEN_ENCRYPTION_KEY || 'k'.repeat(64);

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const clinicalRepo = require('../clinicalRepository');
const apptTypes = require('../appointmentTypes');

const slice = (from, to) => {
  const a = server.indexOf(from); const b = server.indexOf(to, a);
  assert.ok(a >= 0 && b > a, `anchors moved: ${from} … ${to}`);
  return server.slice(a, b);
};

const load = (configOverrides) => {
  const helpers = slice('const FACILITY_SNAPSHOT_KEY', '// Linkage pointers ONLY');
  const resolver = slice('const resolveFacilityForVisit =', 'const loadEncounterContext =');
  const gap = slice('const appointmentSetupGap =', '// The billing entity on a claim.');
  const store = new Map();
  const db = { get: async (k) => store.get(k) || null, set: async (k, v) => { store.set(k, v); } };
  const config = { OPENEMR: { BILLING_FACILITY_ID: '3', TELEHEALTH_FACILITY_ID: '', ...(configOverrides || {}) } };
  // eslint-disable-next-line no-new-func
  const mk = new Function('db', 'config', 'clinicalRepo', 'apptTypes',
    `${gap}\n${helpers}\n${resolver}\nreturn { appointmentSetupGap, resolveFacilityForVisit, resolveBillingForVisit };`);
  return mk(db, config, clinicalRepo, apptTypes);
};

const clinicianEmr = { getFacilities: async () => { throw new Error('OpenEMR list facilities failed (HTTP 403)'); } };

test('a clinician with no saved facility copy still books with both facility ids', async () => {
  const h = load();
  const client = { id: 'c1', openEmrFacilityId: '5' };
  const place = await h.resolveFacilityForVisit(clinicianEmr, client, 'home');
  assert.equal(place.facilityId, '5', "the patient's own assignment needs no read");
  assert.equal(place.posCode, null, 'the POS still needs the list, so billing sets it');
  assert.equal(place.warning, null, 'and nothing POS-related reaches the clinician');
  const bill = await h.resolveBillingForVisit(clinicianEmr);
  assert.equal(bill.facilityId, '3', 'the configured billing entity needs no read');
  assert.equal(bill.warning, null);
  const fields = clinicalRepo.buildAppointmentFields({ providerId: '7', date: '2026-10-02', startTime: '15:00', durationMinutes: 45, location: 'telehealth' }, { categoryId: '5' }).fields;
  fields.pc_facility = place.facilityId; fields.pc_billing_location = bill.facilityId;
  assert.equal(h.appointmentSetupGap(fields), null, 'so the booking goes through');
});

test('telehealth uses the configured telehealth facility when there is one', async () => {
  const h = load({ TELEHEALTH_FACILITY_ID: '9' });
  const place = await h.resolveFacilityForVisit(clinicianEmr, { openEmrFacilityId: '5' }, 'telehealth');
  assert.equal(place.facilityId, '9');
  const home = await h.resolveFacilityForVisit(clinicianEmr, { openEmrFacilityId: '5' }, 'home');
  assert.equal(home.facilityId, '5', 'only telehealth moves to it');
});

test('a fallback billing id is not cached over a real read', async () => {
  const h = load();
  await h.resolveBillingForVisit(clinicianEmr);
  const adminEmr = { getFacilities: async () => [{ id: '3', name: 'Vinings', primary_business_entity: '1', billing_location: '1' }] };
  const real = await h.resolveBillingForVisit(adminEmr);
  assert.notEqual(real.source, 'configured_unverified', 'the next login that can read the list verifies it');
});

test('a patient with no facility is refused by the app, in words about setup, not POS', async () => {
  const h = load();
  const place = await h.resolveFacilityForVisit(clinicianEmr, { id: 'c2' }, 'home');
  assert.equal(place.facilityId, null);
  const gap = h.appointmentSetupGap({ pc_billing_location: '3' });
  assert.equal(gap.code, 'APPT_PATIENT_SETUP_INCOMPLETE');
  assert.match(gap.error, /assign their facility/);
  assert.doesNotMatch(gap.error, /place of service|POS/i);
  assert.equal(h.appointmentSetupGap({ pc_facility: '5' }).code, 'APPT_BILLING_ENTITY_UNSET');
});

test('the booking and reschedule routes check the gap before calling OpenEMR', () => {
  const create = slice("app.post('/api/clinical/patients/:clientId/appointments'", 'emr.createAppointmentRow(');
  assert.match(create, /const apptSetupGap = appointmentSetupGap\(built\.fields\);\s*if \(apptSetupGap\) return res\.status\(409\)/);
  const resched = slice("app.post('/api/clinical/appointments/:eid/reschedule'", 'emr.swapAppointment(');
  assert.match(resched, /const rsSetupGap = appointmentSetupGap\(built\.fields\);\s*if \(rsSetupGap\) return res\.status\(409\)/);
});

test('when OpenEMR returns no id, the error carries what OpenEMR said', async () => {
  const openemr = require('../openemr');
  openemr.setTokenProvider(async () => ({ accessToken: 't', emrUser: { username: 'bethel' } }));
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    const json = (o) => ({ status: 200, text: async () => JSON.stringify(o) });
    if (opts.method === 'GET') return json({ data: { id: 12 } });
    return json({ pc_facility: { 'Required::NON_EXISTENT_KEY': 'pc_facility must be provided' } });
  };
  try {
    const emr = openemr.forActor({ id: 'u1', name: 'Bethel' });
    await assert.rejects(emr.createAppointmentRow('puuid-1', { pc_title: 'x' }),
      (e) => /did not accept the appointment/.test(e.message) && /pc_facility must be provided/.test(e.message));
  } finally { global.fetch = realFetch; }
});
