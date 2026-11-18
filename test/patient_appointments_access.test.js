// A booked clinical visit is visible to the patient even before the full
// clinical record is cleared (owner report, 2026-11-18).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const pr = require('../patientReadRepository');

const ok = (c) => !!c && (c.status === 'signed' || c.status === 'signed_offline');
const client = (over = {}) => ({ id: 'c1', serviceLine: 'phc', openEmrPatientId: 'puuid', consents: {}, ...over });

test('a home care client with a linked chart and no consent to treat can read visits', () => {
  const a = pr.evaluateAppointmentReadAccess({ reqUser: { role: 'client' }, client: client(), isConsentSatisfied: ok });
  assert.strictEqual(a.ok, true);
  assert.strictEqual(a.sections.appointments, 'full');
  // the full clinical record is still refused for the same client
  const full = pr.evaluateClinicalReadAccess({ reqUser: { role: 'client' }, client: client(), isConsentSatisfied: ok, isClinicalServiceLine: (l) => l === 'ihpc' || l === 'both' });
  assert.strictEqual(full.ok, false);
});

test('an unlinked client has no visits to read', () => {
  const a = pr.evaluateAppointmentReadAccess({ reqUser: { role: 'client' }, client: client({ openEmrPatientId: null }), isConsentSatisfied: ok });
  assert.strictEqual(a.code, 'CLINICAL_NOT_LINKED');
});

test('family still need the release, and a staff login is refused', () => {
  const fam = pr.evaluateAppointmentReadAccess({ reqUser: { role: 'family' }, client: client(), isConsentSatisfied: ok });
  assert.strictEqual(fam.code, 'ROI_FAMILY_REQUIRED');
  const exp = pr.evaluateAppointmentReadAccess({ reqUser: { role: 'family', familyReleaseExpired: true }, client: client({ consents: { roiFamily: { status: 'signed' } } }), isConsentSatisfied: ok });
  assert.strictEqual(exp.code, 'FAMILY_RELEASE_EXPIRED');
  const staff = pr.evaluateAppointmentReadAccess({ reqUser: { role: 'admin' }, client: client(), isConsentSatisfied: ok });
  assert.strictEqual(staff.ok, false);
});

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const portal = fs.readFileSync(path.join(__dirname, '..', 'public', 'portal.html'), 'utf8');

test('the visits route and the join route use the lighter gate; join still checks consent to treat', () => {
  const route = server.slice(server.indexOf("app.get('/api/gfc/clinical/appointments', "), server.indexOf("app.get('/api/gfc/clinical/summary'"));
  assert.match(route, /resolvePatientAppointmentContext\(req, res\)/);
  assert.doesNotMatch(route, /openemr\.forActor\(|emr\./);
  const join = server.slice(server.indexOf("app.get('/api/gfc/clinical/appointments/:eid/join'"));
  const head = join.slice(0, 900);
  assert.match(head, /resolvePatientAppointmentContext\(req, res\)/);
  assert.match(head, /consentToTreat/);
});

test('the portal shows booked visits when the full clinical read is not available', () => {
  assert.match(portal, /getGfcClinicalAppointments\(token\)/);
  assert.match(portal, /<GfcSchedule [^>]*clinical=\{clinicalAvailable \? clinical : visitsOnly\}/);
});
