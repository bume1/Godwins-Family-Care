#!/usr/bin/env node
// ============================================================================
// VERIFY: referrals to the care team or to a saved outside provider, and the
//         scope-of-practice roles behind them (owner, 2026-10-12)
// ============================================================================
// Run against a RUNNING app:
//   DATA_STORE=memory MFA_ENFORCE=false JWT_SECRET=probe PORT=3199 node server.js
//   GFC_PROBE_BASE=http://localhost:3199 node scripts/verify_referrals.js
//
// Every assertion reads what the server stored back through the API, not a
// status code alone. KILL BY PID AND READ THE BOOT LOG FIRST: a stale server on
// the port has made a probe "prove" a fix failed in this repo before.
//
// WHAT THIS CAN AND CANNOT PROVE:
//   • It DOES prove over real HTTP: who is offered in the "Refer to" list and
//     who is not (self, read-only, inactive), each role's referral rights as the
//     server answers them, the saved-provider list (save, duplicate refused,
//     fax twin refused unless confirmed, fax edit needs a reason, the edit read
//     back), the referral credential refusals that happen before the patient
//     is loaded, and case managers reading as LMSW.
//   • It does NOT place a referral end to end. Placing any order resolves an
//     OpenEMR encounter first, and no EMR is reachable from a sandbox. The
//     builders, the after-save step (care team, email, provider list) and the
//     accept/complete steps are covered by test/referrals.test.js, which runs
//     the server's own after-save function against a fake store. Run this
//     against the deployment, where an EMR-linked patient exists, to close it.

const BASE = process.env.GFC_PROBE_BASE || 'http://localhost:3199';
const ADMIN_EMAIL = process.env.GFC_PROBE_ADMIN || 'admin@godwinsfamilycarellc.com';
const ADMIN_PASSWORD = process.env.GFC_PROBE_PASSWORD || 'gfcforever2026';

let pass = 0, fail = 0;
const ok = (label, cond, detail) => {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail !== undefined ? `\n         ${JSON.stringify(detail)}` : ''}`); }
};
const call = async (method, path, token, body) => {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  let j = null; try { j = await r.json(); } catch (_) { }
  return { status: r.status, body: j };
};
const login = async (email, password) => {
  const r = await call('POST', '/api/auth/login', null, { email, password });
  return (r.body && r.body.token) || null;
};
const STAMP = Date.now();
const PW = 'Probe12345!';
const makeUser = async (token, name, role, extra = {}) => {
  const email = `probe.ref.${name.replace(/\W+/g, '').toLowerCase()}.${STAMP}@example.test`;
  const r = await call('POST', '/api/users', token, {
    email, password: PW, name: `${name} (TEST DATA)`, role, sendWelcomeEmail: false,
    ...(role === 'client' ? { practiceName: `${name} (TEST DATA)` } : {}),
    ...extra
  });
  return { id: r.body && (r.body.user ? r.body.user.id : r.body.id), email, status: r.status, body: r.body };
};
// Unique fax numbers per run so a re-run against a live store does not collide.
const fax = (n) => `404${String(5550000 + ((STAMP + n) % 9999)).padStart(7, '0')}`;

(async () => {
  const admin = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
  if (!admin) { console.log('LOGIN FAILED — is the app running with MFA_ENFORCE=false?'); process.exit(1); }

  console.log('\n--- A. the team, by scope of practice ---');
  const lmsw = await makeUser(admin, 'Morgan Shaw', 'user', { clinicalRole: 'lmsw' });
  const lcsw = await makeUser(admin, 'Lee Carter', 'user', { clinicalRole: 'lcsw' });
  const rn = await makeUser(admin, 'Rita Nurse', 'user', { clinicalRole: 'rn' });
  const cm = await makeUser(admin, 'Courtney Hale', 'caseManager', {});
  const ro = await makeUser(admin, 'Casey Reed', 'user', { clinicalRole: 'readOnly' });
  const gone = await makeUser(admin, 'Gone Person', 'user', { clinicalRole: 'lmsw' });
  ok('the team members were created', [lmsw, lcsw, rn, cm, ro, gone].every(u => u.id), [lmsw, lcsw, rn, cm, ro, gone].map(u => u.status));
  // Creating a user always stores them active; deactivating is the edit route,
  // as an admin does it. (The first run of this probe set it at creation and
  // "found" an inactive person in the list who was in fact active.)
  const deactivated = await call('PUT', `/api/users/${gone.id}`, admin, { accountStatus: 'inactive' });
  const allUsers = (await call('GET', '/api/users', admin)).body;
  const goneRow = ((allUsers && (allUsers.users || allUsers)) || []).find(u => u.id === gone.id) || {};
  ok('one of them is deactivated', deactivated.status === 200 && goneRow.accountStatus === 'inactive', { status: deactivated.status, accountStatus: goneRow.accountStatus });
  const client = await makeUser(admin, 'Juanita Guess', 'client', {});
  const lined = await call('PUT', `/api/gfc/admin/enrollment/${client.id}/service-line`, admin, { serviceLine: 'IHPC' });
  ok('the client is on the clinical line', lined.status === 200, lined.body);

  const tokens = {
    lmsw: await login(lmsw.email, PW), lcsw: await login(lcsw.email, PW),
    rn: await login(rn.email, PW), cm: await login(cm.email, PW), ro: await login(ro.email, PW)
  };
  ok('everyone signs in', Object.values(tokens).every(Boolean), Object.keys(tokens).filter(k => !tokens[k]));

  const status = async (t) => ((await call('GET', '/api/clinical/status', t)).body || {}).access || {};
  const cmAccess = await status(tokens.cm);
  ok('a case manager reads as LMSW', cmAccess.clinicalRole === 'lmsw', cmAccess.clinicalRole);
  ok('…and the label says case manager / counselor', /case manager \/ counselor/.test(cmAccess.clinicalRoleLabel || ''), cmAccess.clinicalRoleLabel);
  ok('…and may refer within the team', cmAccess.capabilities && cmAccess.capabilities.referInternal === true);
  ok('…but not out', cmAccess.capabilities && cmAccess.capabilities.referExternal === false);
  const lcswAccess = await status(tokens.lcsw);
  ok('an LCSW refers out and adds a mental health diagnosis',
    lcswAccess.capabilities && lcswAccess.capabilities.referExternal === true && lcswAccess.capabilities.behavioralDiagnosis === true, lcswAccess.capabilities);
  ok('an LCSW still has no general problem-list or allergy write', lcswAccess.capabilities && lcswAccess.capabilities.problemListWrite === false);
  const roAccess = await status(tokens.ro);
  ok('read-only staff refer nobody', roAccess.capabilities && roAccess.capabilities.referInternal === false);

  console.log('\n--- B. the "Refer to" list ---');
  const asAdmin = await call('GET', `/api/clinical/patients/${client.id}/referral-targets`, admin);
  ok('the list loads', asAdmin.status === 200, asAdmin.body);
  const names = ((asAdmin.body && asAdmin.body.internal) || []).map(t => t.userId);
  ok('it offers the LMSW, LCSW, RN and case manager', [lmsw.id, lcsw.id, rn.id, cm.id].every(id => names.includes(id)), names);
  ok('it does not offer read-only staff', !names.includes(ro.id));
  ok('it does not offer an inactive account', !names.includes(gone.id));
  const cmRow = ((asAdmin.body && asAdmin.body.internal) || []).find(t => t.userId === cm.id) || {};
  ok('a case manager reads as LMSW · Case management', cmRow.credential === 'LMSW' && cmRow.discipline === 'Case management', cmRow);
  ok('…and is not on this patient\'s care team yet', cmRow.onCareTeam === false, cmRow);
  const asLmsw = await call('GET', `/api/clinical/patients/${client.id}/referral-targets`, tokens.lmsw);
  ok('an LMSW sees the list', asLmsw.status === 200, asLmsw.body);
  ok('…without themselves in it', !((asLmsw.body && asLmsw.body.internal) || []).some(t => t.userId === lmsw.id));
  ok('…and is told they refer within the team only', asLmsw.body && asLmsw.body.canReferInternal === true && asLmsw.body.canReferExternal === false, asLmsw.body);

  console.log('\n--- C. the saved provider list ---');
  const FAX_A = fax(1);
  const added = await call('POST', '/api/clinical/referral-providers', tokens.lcsw, { practice: `Midtown Psychiatry ${STAMP}`, specialty: 'Psychiatry', fax: FAX_A, phone: '4045551000' });
  ok('an LCSW saves a provider', added.status === 200 && added.body.provider && added.body.provider.fax === FAX_A, added.body);
  const pid = added.body && added.body.provider && added.body.provider.id;
  const again = await call('POST', '/api/clinical/referral-providers', tokens.lcsw, { practice: `Midtown Psychiatry ${STAMP}`, fax: FAX_A });
  ok('the same provider twice is refused', again.status === 409 && again.body.code === 'REFERRAL_PROVIDER_EXISTS', again.body);
  const twin = await call('POST', '/api/clinical/referral-providers', tokens.cm, { name: 'Dr Second', practice: `Midtown Psychiatry ${STAMP}`, fax: FAX_A });
  ok('a second name on that fax is shown the match first', twin.status === 409 && twin.body.code === 'REFERRAL_PROVIDER_FAX_MATCH' && (twin.body.matches || []).some(m => m.id === pid), twin.body);
  const twinOk = await call('POST', '/api/clinical/referral-providers', tokens.cm, { name: 'Dr Second', practice: `Midtown Psychiatry ${STAMP}`, fax: FAX_A, confirmDistinct: true });
  ok('…and saved when the case manager confirms it is a different provider', twinOk.status === 200, twinOk.body);
  const badFax = await call('POST', '/api/clinical/referral-providers', tokens.lmsw, { practice: 'Nowhere', fax: '555' });
  ok('a bad fax is refused', badFax.status === 400 && badFax.body.code === 'REFERRAL_PROVIDER_BAD_FAX', badFax.body);
  const roAdd = await call('POST', '/api/clinical/referral-providers', tokens.ro, { practice: 'Ro Practice', fax: fax(2) });
  ok('read-only staff cannot add to the list', roAdd.status === 403, roAdd.body);

  const FAX_B = fax(3);
  const noReason = await call('PUT', `/api/clinical/referral-providers/${pid}`, tokens.lcsw, { fax: FAX_B });
  ok('changing a saved fax without a reason is refused', noReason.status === 400 && noReason.body.code === 'REFERRAL_PROVIDER_REASON_REQUIRED', noReason.body);
  const withReason = await call('PUT', `/api/clinical/referral-providers/${pid}`, tokens.lcsw, { fax: FAX_B, changeReason: 'Practice confirmed a new referral fax' });
  ok('with a reason it saves', withReason.status === 200, withReason.body);
  const stray = await call('PUT', `/api/clinical/referral-providers/${pid}`, tokens.lcsw, { clientId: client.id });
  ok('a key that is not a provider field is refused by name', stray.status === 400 && stray.body.code === 'REFERRAL_PROVIDER_FIELD_UNKNOWN', stray.body);
  const listed = await call('GET', `/api/clinical/patients/${client.id}/referral-targets`, admin);
  const entry = ((listed.body && listed.body.external) || []).find(e => e.id === pid) || {};
  ok('the list reads back the new fax', entry.fax === FAX_B, entry);

  console.log('\n--- D. referral credentials, refused before the patient is loaded ---');
  const path = '/api/clinical/patients/no-such-client/encounters/no-such-encounter/orders';
  const lmswOut = await call('POST', path, tokens.lmsw, { orderType: 'referral', destination: 'external' });
  ok('an LMSW referring out is refused with the scope reason', lmswOut.status === 403 && lmswOut.body.capability === 'referExternal', lmswOut.body);
  const lmswProto = await call('POST', path, tokens.lmsw, { orderType: 'referral', destination: 'internal', standingOrderId: 'so-1' });
  ok('a referral under a protocol is refused', lmswProto.status === 400 && lmswProto.body.code === 'REFERRAL_NOT_UNDER_PROTOCOL', lmswProto.body);
  const lmswIn = await call('POST', path, tokens.lmsw, { orderType: 'referral', destination: 'internal' });
  ok('an LMSW referring within the team gets past the credential gate (then the unknown patient)', lmswIn.status !== 403, lmswIn);
  const lcswOut = await call('POST', path, tokens.lcsw, { orderType: 'referral', destination: 'external' });
  ok('an LCSW referring out gets past the credential gate', lcswOut.status !== 403, lcswOut);
  const rnDme = await call('POST', path, tokens.rn, { orderType: 'dme' });
  ok('an RN is still refused a DME order', rnDme.status === 403 && rnDme.body.capability === 'orderDirect', rnDme.body);
  const roIn = await call('POST', path, tokens.ro, { orderType: 'referral', destination: 'internal' });
  ok('read-only staff cannot refer', roIn.status === 403, roIn.body);

  console.log('\n--- E. working an order through ---');
  const lmswStatus = await call('POST', '/api/clinical/orders/no-such-order/status', tokens.lmsw, { status: 'cancelled', note: 'x' });
  ok('social work reaches the status route (and the missing order is a 404)', lmswStatus.status === 404, lmswStatus.body);
  const roStatus = await call('POST', '/api/clinical/orders/no-such-order/status', tokens.ro, { status: 'cancelled', note: 'x' });
  ok('read-only staff do not', roStatus.status === 403, roStatus.body);
  const accept = await call('POST', '/api/clinical/orders/no-such-order/accept', tokens.cm, {});
  ok('accept on a missing order is a 404, not a crash', accept.status === 404, accept.body);
  const inbox = await call('GET', '/api/clinical/inbox', tokens.cm);
  ok('a case manager\'s inbox loads', inbox.status === 200 && Array.isArray(inbox.body.items), inbox.body);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
