#!/usr/bin/env node
// ============================================================
// Live probe — a care plan reaches the patient only once a licensed clinician
// has signed it (owner, 2026-10-14). Signs in as a real patient.
//
//   DATA_STORE=memory MFA_ENFORCE=false JWT_SECRET=probe PORT=3199 node server.js
//   node scripts/verify_care_plan_patient_visibility.js
// ============================================================

const BASE = process.env.PROBE_BASE || 'http://localhost:3199';
const ADMIN_EMAIL = process.env.PROBE_ADMIN_EMAIL || 'admin@godwinsfamilycarellc.com';
const ADMIN_PASSWORD = process.env.PROBE_ADMIN_PASSWORD || 'gfcforever2026';

let pass = 0, fail = 0;
const ok = (label, cond, detail) => {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail !== undefined ? `\n         ${JSON.stringify(detail).slice(0, 500)}` : ''}`); }
};
const call = async (method, path, token, body) => {
  const r = await fetch(BASE + path, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  let j = null; try { j = await r.json(); } catch (_) {}
  return { status: r.status, body: j };
};
const login = async (email, password) => ((await call('POST', '/api/auth/login', null, { email, password })).body || {}).token || null;
const STAMP = Date.now();
const PW = 'Probe12345!';
const SIG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';
const makeUser = async (token, name, role, extra = {}) => {
  const email = `probe.vis.${name.split(' ')[0].toLowerCase()}.${STAMP}@example.test`;
  const r = await call('POST', '/api/users', token, {
    email, password: PW, name: `${name} (TEST DATA)`, role, sendWelcomeEmail: false,
    ...(role === 'client' ? { practiceName: `${name} (TEST DATA)` } : {}), ...extra
  });
  return { id: r.body && (r.body.user ? r.body.user.id : r.body.id), email };
};
const PLAN = (goal) => ({
  problemItems: [{ id: 'p-vis001', text: 'Fall risk' }],
  goalItems: [{ id: 'g-vis001', problemId: 'p-vis001', statement: goal }],
  eachVisit: ['Walk to the mailbox if steady'], visitFrequency: '3x/week',
  escalation: { callGfcWhen: ['Any fall'] }, review: { cadence: '90_days', nextReviewDate: '2027-01-15' },
  rnSignatureImageB64: SIG
});

(async () => {
  const admin = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
  if (!admin) { console.log('LOGIN FAILED — is the app running with MFA_ENFORCE=false?'); process.exit(1); }
  const rn = await makeUser(admin, 'Ruth Nurse', 'user', { clinicalRole: 'rn', licenseLevel: 'RN' });
  const lmsw = await makeUser(admin, 'Mara Social', 'caseManager', { clinicalRole: 'lmsw' });
  const client = await makeUser(admin, 'Pat Patient', 'client');
  await call('PUT', `/api/users/${client.id}`, admin, { enrollmentStatus: 'enrolled' });
  const rnT = await login(rn.email, PW);
  const lmswT = await login(lmsw.email, PW);
  const clientT = await login(client.email, PW);
  ok('probe users sign in, the patient included', !!(rnT && lmswT && clientT));

  console.log('\n--- 1. a plan waiting on a clinician is not shown ---');
  const w1 = await call('POST', `/api/clinical/patients/${client.id}/care-plan`, lmswT, PLAN('No falls (v1)'));
  ok('an LMSW writes v1, which waits on a clinician', w1.status === 200 && w1.body.providerCoSignStatus === 'pending', w1.body);
  const p1 = await call('GET', '/api/gfc/care-plan', clientT);
  ok('the patient sees no plan', p1.status === 200 && p1.body.carePlan === null, p1.body && p1.body.carePlan);
  ok('  and is told it is in clinical review', p1.body.carePlanInReview === true, p1.body.carePlanInReview);
  const c1 = await call('POST', '/api/gfc/care-plan/cosign', clientT, { version: 1, signatureImageB64: SIG });
  ok('the patient cannot co-sign it', c1.status === 409 && c1.body.code === 'CARE_PLAN_AWAITING_CLINICIAN', c1.body);
  const pdf1 = await call('GET', '/api/gfc/clinical/care-plan.pdf', clientT);
  ok('the PDF is not served', pdf1.status === 404, pdf1.status);

  console.log('\n--- 2. a licensed clinician signs, and the patient sees it ---');
  const co = await call('POST', `/api/clinical/patients/${client.id}/care-plan/provider-cosign`, rnT, { signatureImageB64: SIG });
  ok('an RN co-signs the home care plan', co.status === 200, co.body);
  const p2 = await call('GET', '/api/gfc/care-plan', clientT);
  ok('the patient now sees v1', p2.body.carePlan && p2.body.carePlan.version === 1 && p2.body.carePlan.goals[0] === 'No falls (v1)', p2.body.carePlan);
  ok('  and it can be co-signed', p2.body.carePlan.coSignable === true, p2.body.carePlan.coSignable);
  const c2 = await call('POST', '/api/gfc/care-plan/cosign', clientT, { version: 1, signatureImageB64: SIG });
  ok('the patient co-signs v1', c2.status === 200, c2.body);

  console.log('\n--- 3. an update waiting on a clinician leaves the active plan in place ---');
  const w2 = await call('POST', `/api/clinical/patients/${client.id}/care-plan`, lmswT, PLAN('No falls (v2)'));
  ok('the LMSW writes v2, waiting on a clinician', w2.status === 200 && w2.body.carePlan.version === 2, w2.body);
  const p3 = await call('GET', '/api/gfc/care-plan', clientT);
  ok('the patient still sees v1', p3.body.carePlan && p3.body.carePlan.version === 1 && p3.body.carePlan.goals[0] === 'No falls (v1)', p3.body.carePlan);
  ok('  with a note that an update is in review', p3.body.carePlan.newVersionInReview === true);
  ok('  and v2 cannot be signed yet', p3.body.carePlan.coSignable === false);
  const c3 = await call('POST', '/api/gfc/care-plan/cosign', clientT, { version: 2, signatureImageB64: SIG });
  ok('a co-signature on v2 is refused', c3.status === 409 && c3.body.code === 'CARE_PLAN_AWAITING_CLINICIAN', c3.body);
  const pdf3 = await fetch(BASE + '/api/gfc/clinical/care-plan.pdf', { headers: { Authorization: `Bearer ${clientT}` } });
  const disp = pdf3.headers.get('content-disposition') || '';
  ok('the signed PDF served is v1\u2019s', pdf3.status === 200 && /_v1_signed/.test(disp), { status: pdf3.status, disp });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
