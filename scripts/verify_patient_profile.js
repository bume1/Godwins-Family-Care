#!/usr/bin/env node
/**
 * The patient edits their own contact details (owner, 2026-10-13).
 *
 *   - The patient, or their POA, changes contact details; plain family cannot.
 *   - Name, date of birth and insurance are not changed from here.
 *   - The change lands everywhere the record is read: the staff enrollment
 *     view, the clinical banner, the profile, and the greeting.
 *   - A POA cannot change the client's sign-in email.
 *   - OpenEMR is updated with the next clinician's sign-in on chart open,
 *     never under the patient's name.
 *
 * Runs the REAL server and routes with an in-memory store and a stubbed
 * OpenEMR. Assertions read stored state back.
 *
 *   node scripts/verify_patient_profile.js
 */
process.env.PORT = process.env.PORT || '4617';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'patient-profile-verification-secret';
process.env.AUTO_CHANGELOG = 'false';
process.env.MFA_ENFORCE = 'false';

const path = require('path');
const Module = require('module');
const STORE = new Map();
class MemDb {
  async get(k) { return STORE.has(k) ? JSON.parse(JSON.stringify(STORE.get(k))) : null; }
  async set(k, v) { STORE.set(k, JSON.parse(JSON.stringify(v))); return true; }
  async delete(k) { STORE.delete(k); return true; }
  async list(prefix) { return [...STORE.keys()].filter(k => !prefix || k.startsWith(prefix)); }
  async empty() { STORE.clear(); return true; }
}
const realResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === '@replit/database') return '__memdb__';
  return realResolve.call(this, request, ...rest);
};
require.cache['__memdb__'] = { id: '__memdb__', filename: '__memdb__', loaded: true, exports: MemDb };

// Stubbed OpenEMR: records contact updates and who sent them.
const EMR_UPDATES = [];
const openemr = require(path.join(__dirname, '..', 'openemr.js'));
openemr.isConfigured = () => true;
const realForActor = openemr.forActor;
openemr.forActor = (actor) => ({
  ...realForActor(actor),
  async updatePatientContact(puuid, contact) { EMR_UPDATES.push({ puuid, contact, byId: actor && actor.id }); return true; }
});
const EMR_CONNECTED = new Set(['rn_prof_1']);
const emrAuthMod = require(path.join(__dirname, '..', 'emrAuth.js'));
const realCreate = emrAuthMod.createEmrAuth;
emrAuthMod.createEmrAuth = (o) => { const a = realCreate(o); return { ...a, statusFor: async (id) => ({ ...(await a.statusFor(id)), connected: EMR_CONNECTED.has(id) }) }; };

const jwt = require('jsonwebtoken');
const config = require(path.join(__dirname, '..', 'config.js'));
const BASE = `http://127.0.0.1:${process.env.PORT}`;
let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
};
const tok = (u) => {
  const sid = `sess_${u.id}`;
  const at = new Date().toISOString();
  STORE.set(`auth_session:${sid}`, { id: sid, userId: u.id, role: u.role, createdAt: at, lastSeenAt: at, absoluteExpiresAt: null, revokedAt: null, revokedReason: null, ipHash: null, userAgent: null, mfaVerified: true, surface: null });
  return jwt.sign({ id: u.id, email: u.email, name: u.name, role: u.role, sid }, process.env.JWT_SECRET, { expiresIn: '1h' });
};
const call = async (method, url, token, body) => {
  const res = await fetch(`${BASE}${url}`, { method, headers: Object.assign({ Authorization: `Bearer ${token || ''}` }, body ? { 'Content-Type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

const CLIENT = {
  id: 'client_prof_1', role: config.ROLES.CLIENT, email: 'juanita@example.test', name: 'Ms Juanita Guess', slug: 'juanita-guess',
  serviceLine: 'BOTH', enrollmentStatus: 'enrolled', consents: { roiFamily: 'signed', consentToTreat: 'signed' }, consentMeta: {},
  openEmrPatientId: 'emr-prof-uuid',
  intake: { clientFirst: 'Juanita', clientLast: 'Guess', dob: '1941-03-02', phone: '404-555-0100',
    address: { line1: '1 Old Rd', city: 'Atlanta', state: 'GA', zip: '30301' }, primaryContact: { name: 'Lee Guess', relationship: 'Adult child', phone: '404-555-0111' } }
};
const POA = { id: 'poa_prof_1', role: config.ROLES.FAMILY, email: 'poa-prof@example.test', name: 'Pat Poa', familyOfClientId: CLIENT.id, familyIsPoa: true };
const COUSIN = { id: 'fam_prof_1', role: config.ROLES.FAMILY, email: 'cousin-prof@example.test', name: 'Cee Cousin', familyOfClientId: CLIENT.id, familyIsPoa: false };
const OTHER = { id: 'client_prof_2', role: config.ROLES.CLIENT, email: 'taken@example.test', name: 'Other Person', slug: 'other-person', serviceLine: 'PHC', enrollmentStatus: 'enrolled', consents: {}, intake: {} };
const ADMIN = { id: 'admin_prof_1', role: config.ROLES.ADMIN, email: 'admin-prof@example.test', name: 'Prof Admin' };
const RN = { id: 'rn_prof_1', role: 'user', hasClinicalAccess: true, clinicalRole: 'rn', clinicalRoleConfirmed: true, email: 'rn-prof@example.test', name: 'Prof Nurse' };

(async () => {
  STORE.set('users', [CLIENT, POA, COUSIN, OTHER, ADMIN, RN]);
  require(path.join(__dirname, '..', 'server.js'));
  await new Promise(r => setTimeout(r, 2500));
  const ct = tok(CLIENT), pt = tok(POA), ft = tok(COUSIN), at = tok(ADMIN), rt = tok(RN);
  const stored = () => (STORE.get('users') || []).find(u => u.id === CLIENT.id);

  console.log('\n── The greeting uses the name, not a title ──');
  let r = await call('GET', '/api/gfc/care-plan', ct);
  check('"Ms Juanita Guess" is greeted as Juanita', r.body.greetingName === 'Juanita', JSON.stringify(r.body.greetingName));

  console.log('\n── Who can edit ──');
  r = await call('PUT', '/api/gfc/profile', ft, { phone: '404-555-0000' });
  check('plain family cannot (403) and nothing changes', r.status === 403 && stored().intake.phone === '404-555-0100', JSON.stringify(r.body));
  r = await call('GET', '/api/gfc/profile', ct);
  check('the profile carries the parts the form starts from', r.body.edit && r.body.edit.address && r.body.edit.address.city === 'Atlanta', JSON.stringify(r.body.edit));

  console.log('\n── The patient changes their details ──');
  r = await call('PUT', '/api/gfc/profile', ct, {
    preferredName: 'Ms. Guess', phone: '404-555-0199',
    address: { line1: '22 New St', line2: 'Apt 4', city: 'Decatur', state: 'GA', zip: '30030' },
    primaryContact: { name: 'Lee Guess', relationship: 'Adult child', phone: '404-555-0122' },
    dob: '1999-01-01', clientLast: 'Changed', payerType: 'Self-pay'
  });
  check('saved', r.status === 200 && r.body.changed.includes('phone'), JSON.stringify(r.body).slice(0, 300));
  let c = stored();
  check('the intake holds the new phone and address', c.intake.phone === '404-555-0199' && c.intake.address.city === 'Decatur' && c.intake.address.line2 === 'Apt 4');
  check('the one-line address follows', c.intake.addressLine1 === '22 New St, Apt 4, Decatur, GA 30030', c.intake.addressLine1);
  check('the client record phone follows', c.phone === '404-555-0199', c.phone);
  check('date of birth, legal name and payer are NOT changed from here', c.intake.dob === '1941-03-02' && c.intake.clientLast === 'Guess' && !c.intake.payerType);
  check('OpenEMR is marked to update', !!c.emrContactPendingSince);
  check('nothing was sent to OpenEMR under the patient', EMR_UPDATES.length === 0);

  console.log('\n── It carries across the app ──');
  r = await call('GET', `/api/gfc/admin/enrollment/${CLIENT.id}`, at);
  const enr = JSON.stringify(r.body);
  check('the staff enrollment view shows the new phone and city', r.status === 200 && enr.includes('404-555-0199') && enr.includes('Decatur'), enr.slice(0, 200));
  r = await call('GET', '/api/gfc/care-plan', ct);
  check('the greeting now uses the preferred name as given', r.body.greetingName === 'Ms. Guess', JSON.stringify(r.body.greetingName));
  r = await call('GET', '/api/gfc/profile', ct);
  check('the profile reads the new address', r.body.address === '22 New St, Apt 4, Decatur, GA 30030', r.body.address);

  console.log('\n── The clinical record ──');
  r = await call('GET', `/api/clinical/patients/${CLIENT.id}/chart`, rt);
  const banner = JSON.stringify((r.body && r.body.banner) || {});
  check('the clinical banner shows the new phone', banner.includes('404-555-0199'), banner.slice(0, 300));
  await new Promise(res => setTimeout(res, 500));
  check('opening the chart sent the new details to OpenEMR with the nurse\'s sign-in',
    EMR_UPDATES.length === 1 && EMR_UPDATES[0].byId === RN.id && EMR_UPDATES[0].contact.city === 'Decatur' && EMR_UPDATES[0].contact.phone_home === '404-555-0199', JSON.stringify(EMR_UPDATES));
  check('and the pending mark is cleared', !stored().emrContactPendingSince && !!stored().emrContactSyncedAt);
  await call('GET', `/api/clinical/patients/${CLIENT.id}/chart`, rt);
  await new Promise(res => setTimeout(res, 300));
  check('opening it again sends nothing new', EMR_UPDATES.length === 1, String(EMR_UPDATES.length));

  console.log('\n── Email ──');
  r = await call('PUT', '/api/gfc/profile', pt, { email: 'new-juanita@example.test' });
  check('a POA cannot change the client\'s sign-in email', r.status === 403 && r.body.code === 'PROFILE_EMAIL_CLIENT_ONLY' && stored().email === 'juanita@example.test', JSON.stringify(r.body));
  r = await call('PUT', '/api/gfc/profile', pt, { phone: '404-555-0177' });
  check('a POA can change the phone', r.status === 200 && stored().intake.phone === '404-555-0177');
  r = await call('PUT', '/api/gfc/profile', ct, { email: 'taken@example.test' });
  check('an email another account uses is refused', r.status === 400 && r.body.code === 'EMAIL_TAKEN');
  r = await call('PUT', '/api/gfc/profile', ct, { email: 'New-Juanita@Example.test' });
  check('the client changes their own email', r.status === 200 && stored().email === 'new-juanita@example.test', JSON.stringify(r.body).slice(0, 200));

  console.log('\n── The audit trail names fields, never values ──');
  const log = (STORE.get('activity_log') || []).filter(e => e.action === 'client_details_updated');
  check('each save is logged', log.length >= 3, String(log.length));
  check('no phone number or address is in the log', !JSON.stringify(log).includes('404-555-0199') && !JSON.stringify(log).includes('Decatur'));

  console.log(`\n${pass}/${pass + fail} checks passed.`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
