#!/usr/bin/env node
/**
 * One family login for several patients, POA per patient, no-email patients,
 * and moving a patient's login to their POA (owner, 2026-10-20).
 *
 * Runs the REAL server and routes with an in-memory store. Emails are not
 * sent. Assertions read stored state back.
 *
 *   node scripts/verify_family_multi_patient.js
 */
process.env.PORT = process.env.PORT || '4621';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'family-multi-verification-secret';
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

const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const config = require(path.join(__dirname, '..', 'config.js'));
const BASE = `http://127.0.0.1:${process.env.PORT}`;
let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
};
const tok = (u) => {
  const sid = `sess_${u.id}_${Math.random().toString(36).slice(2)}`;
  const at = new Date().toISOString();
  STORE.set(`auth_session:${sid}`, { id: sid, userId: u.id, role: u.role, createdAt: at, lastSeenAt: at, absoluteExpiresAt: null, revokedAt: null, revokedReason: null, ipHash: null, userAgent: null, mfaVerified: true, surface: null });
  return jwt.sign({ id: u.id, email: u.email, name: u.name, role: u.role, sid }, process.env.JWT_SECRET, { expiresIn: '1h' });
};
const call = async (method, url, token, body, headers = {}) => {
  const res = await fetch(`${BASE}${url}`, { method, headers: Object.assign({ Authorization: `Bearer ${token || ''}` }, body ? { 'Content-Type': 'application/json' } : {}, headers), body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const userById = (id) => (STORE.get('users') || []).find(u => u.id === id);

const MOM = { id: 'client_mom', role: config.ROLES.CLIENT, email: 'mom@example.test', name: 'Mae Mom', slug: 'mae-mom', serviceLine: 'PHC', enrollmentStatus: 'enrolled', consents: { roiFamily: 'signed' }, intake: {} };
const DAD = { id: 'client_dad', role: config.ROLES.CLIENT, email: 'dad@example.test', name: 'Dee Dad', slug: 'dee-dad', serviceLine: 'PHC', enrollmentStatus: 'enrolled', consents: { roiFamily: 'signed' }, intake: {} };
const STRANGER = { id: 'client_stranger', role: config.ROLES.CLIENT, email: 'stranger@example.test', name: 'Sol Stranger', slug: 'sol', serviceLine: 'PHC', enrollmentStatus: 'enrolled', consents: { roiFamily: 'signed' }, intake: {} };
// The daughter: POA for Mom, plain family for Dad. Old single-field shape on
// purpose; the boot migration and linksOf must read it.
const DAUGHTER = { id: 'fam_daughter', role: config.ROLES.FAMILY, email: 'daughter@example.test', name: 'Dot Daughter', familyLinks: [{ clientId: MOM.id, isPoa: true, relationship: 'Daughter' }, { clientId: DAD.id, isPoa: false, relationship: 'Daughter' }] };
const OLDSHAPE = { id: 'fam_old', role: config.ROLES.FAMILY, email: 'old@example.test', name: 'Olive Old', familyOfClientId: MOM.id, familyIsPoa: false };
const ADMIN = { id: 'admin_multi', role: config.ROLES.ADMIN, email: 'multiadmin@example.test', name: 'Multi Admin' };

(async () => {
  // A patient whose husband has been signing in as her.
  const GRAN = { id: 'client_gran', role: config.ROLES.CLIENT, email: 'husband@example.test', password: await bcrypt.hash('Shared!Pass1', 4), name: 'Gail Gran', slug: 'gail', serviceLine: 'PHC', enrollmentStatus: 'enrolled', consents: { roiFamily: 'signed' }, intake: { decisionMaker: { name: 'Hal Husband' } } };
  const AUNT = { id: 'client_aunt', role: config.ROLES.CLIENT, email: 'son-old@example.test', password: await bcrypt.hash('x', 4), name: 'Ada Aunt', slug: 'ada', serviceLine: 'PHC', enrollmentStatus: 'enrolled', consents: { roiFamily: 'signed' }, intake: {} };
  const JOE = { id: 'client_joe', role: config.ROLES.CLIENT, email: 'client+client_joe@placeholder.local', name: 'Joseph Hendricks', slug: 'joe', serviceLine: 'PHC', enrollmentStatus: 'intake_pending', consents: {}, intake: {} };
  const STEPH = { id: 'fam_steph', role: config.ROLES.FAMILY, email: 'steph@example.test', name: 'Stephanie Hendricks', familyLinks: [{ clientId: JOE.id, isPoa: true }] };
  const COUSIN = { id: 'fam_cousin', role: config.ROLES.FAMILY, email: 'cuz@example.test', name: 'Cee Cousin', familyLinks: [{ clientId: JOE.id, isPoa: false }] };
  STORE.set('users', [MOM, DAD, STRANGER, DAUGHTER, OLDSHAPE, ADMIN, GRAN, AUNT, JOE, STEPH, COUSIN]);
  require(path.join(__dirname, '..', 'server.js'));
  await new Promise(r => setTimeout(r, 2500));
  const at = tok(ADMIN);

  console.log('\n── Boot migration ──');
  const old = userById(OLDSHAPE.id);
  check('a single-field family account was given a linked-patient list', Array.isArray(old.familyLinks) && old.familyLinks.length === 1 && old.familyLinks[0].clientId === MOM.id && old.familyLinks[0].isPoa === false, JSON.stringify(old.familyLinks));

  console.log('\n── One login, two patients ──');
  const dt = tok(DAUGHTER);
  let r = await call('GET', '/api/gfc/me', dt);
  check('linked to two patients and none chosen: the portal asks', r.status === 200 && r.body.needsClientChoice === true && r.body.linkedClients.length === 2, JSON.stringify(r.body));
  check('the list carries the POA flag per patient', (r.body.linkedClients || []).find(c => c.id === MOM.id).isPoa === true && (r.body.linkedClients || []).find(c => c.id === DAD.id).isPoa === false);
  r = await call('GET', '/api/gfc/care-plan', dt);
  check('a gated route refuses until a patient is chosen, without signing anyone out', r.status === 403 && r.body.code === 'CLIENT_CHOICE_REQUIRED', JSON.stringify(r.body));
  r = await call('POST', '/api/gfc/active-client', dt, { clientId: STRANGER.id });
  check('a patient this person is not linked to cannot be chosen', r.status === 403 && r.body.code === 'CLIENT_NOT_LINKED');

  r = await call('POST', '/api/gfc/active-client', dt, { clientId: MOM.id });
  check('choosing Mom works', r.status === 200);
  r = await call('GET', '/api/gfc/me', dt);
  check('on Mom she is POA', r.body.isPoa === true && r.body.activeClientId === MOM.id && r.body.clientFullName === MOM.name, JSON.stringify({ isPoa: r.body.isPoa, a: r.body.activeClientId }));
  r = await call('GET', '/api/gfc/care-plan', dt, null, { 'X-GFC-Client': MOM.id });
  check('Mom’s care plan reads at the POA level', r.status === 200 && r.body.audience === 'poa', JSON.stringify(r.body).slice(0, 200));
  r = await call('GET', '/api/gfc/care-plan', dt, null, { 'X-GFC-Client': DAD.id });
  check('a stale tab still showing another patient is stopped (409)', r.status === 409 && r.body.code === 'ACTIVE_CLIENT_CHANGED');

  r = await call('POST', '/api/gfc/active-client', dt, { clientId: DAD.id });
  r = await call('GET', '/api/gfc/me', dt);
  check('switched to Dad she is plain family, not POA', r.body.isPoa === false && r.body.activeClientId === DAD.id);
  r = await call('GET', '/api/gfc/care-plan', dt);
  check('Dad’s care plan reads at the family level', r.status === 200 && r.body.audience === 'family');
  r = await call('GET', '/api/gfc/family', dt);
  check('Dad’s family list shows her as family, not POA', r.status === 200 && (r.body.people.find(p => p.id === DAUGHTER.id) || {}).isPoa === false, JSON.stringify(r.body.people));

  console.log('\n── Admin edits the links ──');
  r = await call('GET', '/api/users', at);
  const listed = (r.body || []).find(u => u.id === DAUGHTER.id);
  check('the user list returns the linked patients', listed && Array.isArray(listed.familyLinks) && listed.familyLinks.length === 2);
  r = await call('PUT', `/api/users/${DAUGHTER.id}`, at, { familyLinks: [{ clientId: MOM.id, isPoa: true }, { clientId: MOM.id, isPoa: false }] });
  check('a patient listed twice is refused', r.status === 400 && r.body.code === 'FAMILY_LINK_DUPLICATE');
  r = await call('PUT', `/api/users/${DAUGHTER.id}`, at, { familyLinks: [{ clientId: ADMIN.id, isPoa: true }] });
  check('linking to a non-patient account is refused', r.status === 400 && r.body.code === 'FAMILY_LINK_NOT_A_CLIENT');
  r = await call('PUT', `/api/users/${DAUGHTER.id}`, at, { familyLinks: [{ clientId: MOM.id, isPoa: true, relationship: 'Daughter' }] });
  check('removing Dad saves', r.status === 200, JSON.stringify(r.body));
  const d2 = userById(DAUGHTER.id);
  check('the stored links and the mirror fields agree', d2.familyLinks.length === 1 && d2.familyOfClientId === MOM.id && d2.familyIsPoa === true);
  r = await call('GET', '/api/gfc/me', dt);
  check('her open sign-in, which was on Dad, now lands on the one patient she still has', r.body.activeClientId === MOM.id && r.body.needsClientChoice === false);
  const logs = STORE.get('activity_log') || [];
  check('the removal is logged against Dad', JSON.stringify(logs).includes('family_link_removed'));

  console.log('\n── Emails go to the POA of THAT patient only ──');
  r = await call('PUT', `/api/users/${DAUGHTER.id}`, at, { familyLinks: [{ clientId: MOM.id, isPoa: false }, { clientId: DAD.id, isPoa: true }] });
  check('POA moves from Mom to Dad', r.status === 200);
  const notifications = require(path.join(__dirname, '..', 'notifications.js'));
  // The real notifier, its queue captured: what each person would be sent.
  const sent = [];
  const notifier = notifications.createNotifier({
    getUsers: async () => STORE.get('users'),
    getAppBaseUrl: async () => 'https://app.test',
    emailTransport: { transportStatus: () => ({ baaCovered: true }) },
    queueNotification: async (type, userId, email, name, tpl) => { sent.push({ type, userId, cta: tpl.ctaUrl }); return { id: 'q' + sent.length }; },
    staffRoles: ['admin'], clientRole: config.ROLES.CLIENT, familyRole: config.ROLES.FAMILY
  });
  const mom = await notifier.clientSideRecipients(MOM.id);
  const dad = await notifier.clientSideRecipients(DAD.id);
  check('Mom’s notices no longer reach her', !mom.recipients.some(x => x.user.id === DAUGHTER.id));
  check('Dad’s notices now do', dad.recipients.some(x => x.user.id === DAUGHTER.id));
  await notifier.documentReviewed({ clientId: DAD.id, decision: 'rejected', label: 'Insurance card', reason: 'Blurry', uploadId: 'u1', actorId: ADMIN.id });
  const toHer = sent.find(x => x.userId === DAUGHTER.id);
  const toDad = sent.find(x => x.userId === DAD.id);
  check('a real notice about Dad reaches her and Dad', !!toHer && !!toDad, JSON.stringify(sent));
  check('her button opens Dad’s portal, by record id', toHer && toHer.cta === `https://app.test/portal?for=${DAD.id}`, toHer && toHer.cta);
  check('Dad’s own button is unchanged', toDad && toDad.cta === 'https://app.test/portal/dee-dad', toDad && toDad.cta);
  check('nothing about Dad goes to Mom’s side', !sent.some(x => x.userId === MOM.id));

  console.log('\n── The emailed link opens the right patient ──');
  await call('POST', '/api/gfc/active-client', dt, { clientId: MOM.id });
  r = await call('POST', '/api/gfc/active-client', dt, { clientId: DAD.id });
  r = await call('GET', '/api/gfc/me', dt);
  check('following Dad’s link from Mom switches her to Dad', r.body.activeClientId === DAD.id && r.body.isPoa === true);

  console.log('\n── A patient with no email ──');
  r = await call('POST', '/api/users', at, { name: 'Nell Noemail', practiceName: 'Nell Noemail', accountType: 'client', role: 'client', noEmail: true, sendWelcomeEmail: true });
  const nell = (STORE.get('users') || []).find(u => u.name === 'Nell Noemail');
  check('is created with a placeholder login', r.status === 200 && nell && /@placeholder\.local$/.test(nell.email) && nell.noLogin === true, JSON.stringify(r.body));
  r = await call('POST', '/api/users', at, { name: 'Dup', practiceName: 'Dup', email: 'MOM@example.test', password: 'Abcdefg1!', accountType: 'client', role: 'client' });
  check('an email already in use, in another case, is refused', r.status === 400 && r.body.code === 'EMAIL_IN_USE');
  r = await call('PUT', `/api/users/${STRANGER.id}`, at, { email: 'Dad@Example.test' });
  check('editing an email onto one already in use is refused (it used to save)', r.status === 409 && r.body.code === 'EMAIL_IN_USE');
  check('and nothing was changed', userById(STRANGER.id).email === STRANGER.email);

  console.log('\n── A patient stays a patient ──');
  r = await call('PUT', `/api/users/${MOM.id}`, at, { accountType: 'family' });
  check('switching a patient to Family is refused', r.status === 409 && r.body.code === 'PATIENT_TYPE_LOCKED', JSON.stringify(r.body));
  check('and she is still a patient', userById(MOM.id).role === 'client');
  r = await call('PUT', `/api/users/${MOM.id}`, at, { role: 'family' });
  check('the old role field cannot do it either', r.status === 409 && userById(MOM.id).role === 'client');
  r = await call('POST', '/api/users', at, { name: 'Hal Husband', email: 'husband@example.test', password: 'Abcdefg1!', accountType: 'family', role: 'family', familyLinks: [{ clientId: GRAN.id, isPoa: true }] });
  check('adding a POA on an email that is a patient\u2019s login says whose it is', r.status === 400 && r.body.existingUser && r.body.existingUser.id === GRAN.id && r.body.existingUser.kind === 'patient', JSON.stringify(r.body));
  check('and creates nothing', !(STORE.get('users') || []).some(u => u.name === 'Hal Husband'));
  r = await call('POST', '/api/users', at, { name: 'Dot again', email: 'DAUGHTER@example.test', password: 'Abcdefg1!', accountType: 'family', role: 'family' });
  check('an email on a family login says so, so the patient can be added to it', r.status === 400 && r.body.existingUser && r.body.existingUser.kind === 'family' && r.body.existingUser.id === DAUGHTER.id);

  console.log('\n── Moving a shared login to the POA ──');
  r = await call('GET', '/api/gfc/admin/clients/possible-poa-logins', at);
  check('the possible list names Gail, with the reason', r.status === 200 && (r.body.clients || []).some(c => c.id === GRAN.id && c.reasons.length), JSON.stringify(r.body));
  const granOld = tok(GRAN);
  r = await call('POST', `/api/gfc/admin/clients/${GRAN.id}/poa-cutover`, at, { mode: 'move', name: 'Hal Husband', confirmName: 'someone else' });
  check('a wrong confirmation name is refused', r.status === 400 && r.body.code === 'POA_CUTOVER_CONFIRM');
  r = await call('POST', `/api/gfc/admin/clients/${GRAN.id}/poa-cutover`, at, { mode: 'move', targetFamilyId: DAUGHTER.id, confirmName: 'Gail Gran' });
  check('an account with its own login is never merged into', r.status === 409 && r.body.code === 'POA_CUTOVER_TARGET_HAS_LOGIN');
  const before = JSON.stringify(userById(GRAN.id));
  r = await call('POST', `/api/gfc/admin/clients/${GRAN.id}/poa-cutover`, at, { mode: 'move', name: 'Hal Husband', relationship: 'Husband', confirmName: ' gail  gran ' });
  check('the move goes through', r.status === 200 && r.body.familyIsNew === true, JSON.stringify(r.body));
  const gran = userById(GRAN.id);
  const hal = userById(r.body.familyUserId);
  check('the patient now has a placeholder login', /@placeholder\.local$/.test(gran.email) && gran.noLogin === true);
  check('the POA has the email and the same password hash', hal && hal.email === 'husband@example.test' && hal.password === JSON.parse(before).password);
  check('and a POA link to the patient', hal && hal.familyLinks.length === 1 && hal.familyLinks[0].clientId === GRAN.id && hal.familyLinks[0].isPoa === true && hal.familyLinks[0].via === 'poa_cutover');
  check('the change is noted on the patient', gran.poaCutover && gran.poaCutover.familyUserId === hal.id);
  r = await call('GET', '/api/gfc/me', granOld);
  check('the patient’s old sessions are ended', r.status === 403 && r.body.code === 'AUTH_REVOKED', JSON.stringify(r.body));
  r = await call('POST', '/api/auth/login', null, { email: 'husband@example.test', password: 'Shared!Pass1' });
  check('the POA signs in with the same email and password', r.status === 200 && r.body.user && r.body.user.role === 'family', JSON.stringify(r.body).slice(0, 200));
  const halToken = r.body.token;
  r = await call('GET', '/api/gfc/me', halToken);
  check('and lands on the patient as her POA', r.status === 200 && r.body.isPoa === true && r.body.activeClientId === GRAN.id && /Hal Husband/.test(r.body.actingAs || ''), JSON.stringify(r.body).slice(0, 300));
  check('the activity log records the move without the address', JSON.stringify(STORE.get('activity_log') || []).includes('poa_login_cutover') && !JSON.stringify((STORE.get('activity_log') || []).filter(a => a.action === 'poa_login_cutover')).includes('husband@example.test'));
  r = await call('POST', `/api/gfc/admin/clients/${GRAN.id}/poa-cutover`, at, { mode: 'move', name: 'Again', confirmName: 'Gail Gran' });
  check('a patient with no login left cannot be moved twice', r.status === 409 && r.body.code === 'POA_CUTOVER_NOTHING_TO_MOVE');

  console.log('\n── The POA already has their own login ──');
  r = await call('POST', `/api/gfc/admin/clients/${AUNT.id}/poa-cutover`, at, { mode: 'link_existing', targetFamilyId: DAUGHTER.id, confirmName: 'Ada Aunt' });
  check('linking to the existing account goes through', r.status === 200 && r.body.familyIsNew === false);
  const d3 = userById(DAUGHTER.id);
  check('her own email and password are untouched', d3.email === DAUGHTER.email && !d3.password);
  check('she is now linked to three patients, POA for the aunt', d3.familyLinks.length === 3 && d3.familyLinks.find(l => l.clientId === AUNT.id).isPoa === true);
  check('the aunt’s old login is retired', /@placeholder\.local$/.test(userById(AUNT.id).email));
  r = await call('GET', '/api/gfc/me', tok(d3));
  check('with three patients the portal asks whose to open', r.body.needsClientChoice === true && r.body.linkedClients.length === 3);

  console.log('\n── A POA enrolls a patient who has no login of their own ──');
  // Joe has not done intake and nobody has signed his family release (seeded at the top).
  const st = tok(STEPH), cz = tok(COUSIN);
  r = await call('GET', '/api/gfc/me', st);
  check('the POA sees the patient, as POA', r.status === 200 && r.body.isPoa === true && r.body.enrollmentStatus === 'intake_pending', JSON.stringify(r.body).slice(0, 200));
  r = await call('GET', '/api/gfc/care-plan', st);
  check('the POA is gated on intake, not on the family release', r.status === 403 && r.body.code === 'INTAKE_REQUIRED', JSON.stringify(r.body));
  r = await call('GET', '/api/gfc/care-plan', cz);
  check('plain family is still gated on the family release', r.status === 403 && r.body.code === 'ROI_FAMILY_REQUIRED');
  r = await call('GET', '/api/gfc/intake', st);
  check('the POA opens the patient\u2019s intake', r.status === 200, JSON.stringify(r.body).slice(0, 200));
  r = await call('GET', '/api/gfc/intake', cz);
  check('plain family cannot', r.status === 403);
  r = await call('POST', '/api/gfc/intake', st, { intake: { firstName: 'Joseph', lastName: 'Hendricks' } });
  check('the POA saves intake answers onto the patient', r.status === 200 && (userById(JOE.id).intake || {}).firstName === 'Joseph', JSON.stringify(r.body).slice(0, 200));
  check('and nothing lands on the POA\u2019s own account', !userById(STEPH.id).intake);
  r = await call('POST', '/api/gfc/consents', st, { type: 'npp', typedName: 'Stephanie Hendricks', acknowledged: true });
  const npp = (userById(JOE.id).consentMeta || {}).npp || {};
  check('the POA signs a consent for the patient', r.status === 200 && (userById(JOE.id).consents || {}).npp === 'signed', JSON.stringify(r.body).slice(0, 200));
  check('it reads "Stephanie Hendricks as POA for Joseph Hendricks"', npp.signedAs === 'Stephanie Hendricks as POA for Joseph Hendricks' && npp.signerRole === 'poa' && npp.signedById === STEPH.id, JSON.stringify(npp));
  r = await call('POST', '/api/gfc/consents', cz, { type: 'npp', typedName: 'Cee Cousin', acknowledged: true });
  check('plain family cannot sign', r.status === 403);
  r = await call('GET', '/api/gfc/admin/clients/possible-poa-logins', at);
  check('a POA signing as POA does not flag the patient as a shared login', !(r.body.clients || []).some(c => c.id === JOE.id));
  await call('PUT', `/api/users/${JOE.id}`, at, { enrollmentStatus: 'intake_complete' });
  r = await call('GET', '/api/gfc/care-plan', st);
  check('once intake is done the POA is in, with no family release signed', r.status === 200 && r.body.audience === 'poa', JSON.stringify(r.body).slice(0, 200));

  console.log('\n── Who may do this ──');
  r = await call('POST', `/api/gfc/admin/clients/${MOM.id}/poa-cutover`, dt, { mode: 'move', name: 'X', confirmName: MOM.name });
  check('a family account cannot move a login', r.status === 403);
  check('and Mom’s login is unchanged', userById(MOM.id).email === MOM.email);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
