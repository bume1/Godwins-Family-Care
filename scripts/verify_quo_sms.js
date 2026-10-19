#!/usr/bin/env node
/**
 * Care Team texts through Quo (owner, 2026-10-15): the patient and their POA
 * turn texts on in the portal, and a signed Quo webhook from either phone lands
 * in the patient's Care Team thread. Quo itself is never called: sending is
 * stubbed below.
 *
 * (Harness below is the patient-profile probe's.)
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
process.env.PORT = process.env.PORT || '4618';
process.env.QUO_API_KEY = 'probe-key';
process.env.QUO_WEBHOOK_SECRET = Buffer.from('probe-secret').toString('base64');
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


const CLIENT = { id: 'client_sms_1', role: config.ROLES.CLIENT, email: 'sms-client@example.test', name: 'Juanita Guess', slug: 'juanita-sms',
  serviceLine: 'BOTH', enrollmentStatus: 'enrolled', consents: { roiFamily: 'signed', consentToTreat: 'signed' }, consentMeta: {},
  intake: { clientFirst: 'Juanita', clientLast: 'Guess', phone: '' }, careTeam: { assignedFNPs: ['rn_sms_1'] } };
const POA = { id: 'poa_sms_1', role: config.ROLES.FAMILY, email: 'sms-poa@example.test', name: 'Pat Poa', familyOfClientId: CLIENT.id, familyIsPoa: true };
const COUSIN = { id: 'fam_sms_1', role: config.ROLES.FAMILY, email: 'sms-cousin@example.test', name: 'Cee Cousin', familyOfClientId: CLIENT.id, familyIsPoa: false };
const RN = { id: 'rn_sms_1', role: 'user', hasClinicalAccess: true, clinicalRole: 'provider', clinicalRoleConfirmed: true, email: 'sms-rn@example.test', name: 'Bethel Godwins' };
const crypto = require('crypto');
const sign = (raw) => { const ts = Date.now(); return `hmac;1;${ts};` + crypto.createHmac('sha256', Buffer.from(process.env.QUO_WEBHOOK_SECRET, 'base64')).update(ts + '.' + raw).digest('base64'); };
const hook = async (evt) => { const raw = JSON.stringify(evt); const r = await fetch(`${BASE}/api/webhooks/quo`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'openphone-signature': sign(raw) }, body: raw }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const text = (from, body) => ({ type: 'message.received', data: { object: { id: 'AC' + Math.random().toString(36).slice(2), from, to: ['+14049136705'], direction: 'incoming', body, createdAt: new Date().toISOString() } } });
// Quo is never called from a probe.
global.fetch = ((real) => async (url, opts) => String(url).includes('api.openphone.com') ? { ok: true, status: 202, json: async () => ({ data: { id: 'QM-probe' } }) } : real(url, opts))(global.fetch);

(async () => {
  STORE.set('users', [CLIENT, POA, COUSIN, RN]);
  require(path.join(__dirname, '..', 'server.js'));
  await new Promise(r => setTimeout(r, 2500));
  const ct = tok(CLIENT), pt = tok(POA), ft = tok(COUSIN);
  const u = (id) => (STORE.get('users') || []).find(x => x.id === id);

  console.log('\n── Turning texts on ──');
  let r = await call('GET', '/api/gfc/text-messages', ct);
  check('texting shows as available and off', r.status === 200 && r.body.available === true && r.body.enabled === false, JSON.stringify(r.body));
  r = await call('PUT', '/api/gfc/text-messages', ct, { enabled: true });
  check('the client cannot turn it on with no phone on file', r.status === 400 && r.body.code === 'TEXTS_NO_PHONE', JSON.stringify(r.body));
  r = await call('PUT', '/api/gfc/profile', ct, { phone: '404-555-0100' });
  check('the client adds a phone on the profile', r.status === 200, JSON.stringify(r.body).slice(0, 200));
  r = await call('PUT', '/api/gfc/text-messages', ct, { enabled: true });
  check('then turns texts on', r.status === 200 && r.body.enabled === true && r.body.phone === '(404) 555-0100' && u(CLIENT.id).smsOptIn.enabled === true, JSON.stringify(r.body));
  r = await call('PUT', '/api/gfc/text-messages', ct, { phone: '404-555-9999' });
  check('the client changes their number on the profile, not here', r.status === 400 && r.body.code === 'TEXTS_PHONE_ON_PROFILE');
  r = await call('PUT', '/api/gfc/text-messages', pt, { phone: '404-555-020', enabled: true });
  check('a POA\'s short number is refused', r.status === 400 && r.body.code === 'TEXTS_PHONE_INVALID');
  r = await call('PUT', '/api/gfc/text-messages', pt, { phone: '404-555-0200', enabled: true });
  check('the POA adds their own mobile and turns texts on', r.status === 200 && r.body.enabled === true && u(POA.id).phone === '(404) 555-0200', JSON.stringify(r.body));
  r = await call('GET', '/api/gfc/text-messages', ft);
  check('plain family cannot', r.status === 403);

  console.log('\n── Replies by text ──');
  r = await hook(text('+14045550100', 'Feeling better today'));
  check('a text from the patient is recorded', r.status === 200 && r.body.outcome === 'recorded', JSON.stringify(r.body));
  r = await hook(text('+14045550200', 'She ate breakfast'));
  check('a text from the POA is recorded', r.body.outcome === 'recorded', JSON.stringify(r.body));
  const msgs = STORE.get('messages') || [];
  const a = msgs.find(m => m.body === 'Feeling better today'); const b = msgs.find(m => m.body === 'She ate breakfast');
  check('both are on the patient\'s Care Team thread', a && b && a.client_id === CLIENT.id && b.client_id === CLIENT.id && a.thread_id === b.thread_id);
  check('the POA is named as the POA', b && /as POA for Juanita Guess/.test(b.display_name));
  r = await call('GET', `/api/messaging/threads/${a && a.thread_id}`, tok(RN));
  check('the clinician reads both in the thread', r.status === 200 && r.body.messages.filter(m => m.via === 'sms').length === 2, JSON.stringify(r.body).slice(0, 200));
  r = await call('POST', `/api/messaging/threads/${a && a.thread_id}/messages`, tok(RN), { body: 'Glad to hear it.' });
  await new Promise(res => setTimeout(res, 300));
  const box = STORE.get('sms_outbox') || [];
  check('the clinician\'s reply is texted (or held for 8am) to both', r.status === 200 && ['+14045550100', '+14045550200'].every(n => box.some(x => x.to === n && ['sent', 'waiting'].includes(x.status))), JSON.stringify(box.map(x => [x.to, x.status, x.error])));
  r = await hook(text('+14045550100', 'STOP'));
  check('STOP turns the patient\'s texts off', r.body.outcome === 'opted_out' && u(CLIENT.id).smsOptIn.enabled === false);
  r = await call('GET', '/api/gfc/text-messages', ct);
  check('and the portal says it was turned off by STOP', r.body.enabled === false && r.body.stoppedByText === true);

  console.log(`\n${pass}/${pass + fail} checks passed.`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
