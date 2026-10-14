#!/usr/bin/env node
// ============================================================
// Live probe — the care plan format (2026-10-14), through the real HTTP routes
//
//   DATA_STORE=memory MFA_ENFORCE=false JWT_SECRET=probe PORT=3199 node server.js
//   node scripts/verify_care_plan_format.js
//
// Reads stored values back; never trusts a status code alone.
// ============================================================

const BASE = process.env.PROBE_BASE || 'http://localhost:3199';
const ADMIN_EMAIL = process.env.PROBE_ADMIN_EMAIL || 'admin@godwinsfamilycarellc.com';
const ADMIN_PASSWORD = process.env.PROBE_ADMIN_PASSWORD || 'gfcforever2026';

let pass = 0, fail = 0;
const ok = (label, cond, detail) => {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail !== undefined ? `\n         ${JSON.stringify(detail).slice(0, 600)}` : ''}`); }
};
const call = async (method, path, token, body) => {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
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
  const email = `probe.cp.${name.split(' ')[0].toLowerCase()}.${STAMP}@example.test`;
  const r = await call('POST', '/api/users', token, {
    email, password: PW, name: `${name} (TEST DATA)`, role, sendWelcomeEmail: false,
    ...(role === 'client' ? { practiceName: `${name} (TEST DATA)` } : {}), ...extra
  });
  return { id: r.body && (r.body.user ? r.body.user.id : r.body.id), email };
};

const PHC_PLAN = {
  problemItems: [{ id: 'p-probe1', text: 'Fall risk' }],
  goalItems: [{ id: 'g-probe1', problemId: 'p-probe1', statement: 'No falls this quarter', measure: 'Falls per month', baseline: '2', target: '0' }],
  interventions: [{ id: 'i-probe1', goalIds: ['g-probe1'], description: 'Remove hallway rug', responsible: 'gfc_caregiver', frequency: 'one_time', type: 'caregiver_task' }],
  eachVisit: ['Walk to the mailbox if steady', 'Check blood pressure'],
  visitFrequency: '3x/week', visitDays: ['Mon', 'Wed', 'Fri'],
  escalation: { callGfcWhen: ['Any fall'], call911When: ['Fall with injury'] },
  review: { cadence: '90_days', nextReviewDate: '2027-01-15' },
  rnSignatureImageB64: SIG
};

(async () => {
  const admin = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
  if (!admin) { console.log('LOGIN FAILED — is the app running with MFA_ENFORCE=false?'); process.exit(1); }
  const rn = await makeUser(admin, 'Ruth Nurse', 'user', { clinicalRole: 'rn', licenseLevel: 'RN' });
  const cm = await makeUser(admin, 'Casey Manager', 'caseManager', { clinicalRole: 'readOnly' });
  const phc = await makeUser(admin, 'Hattie Home', 'client');
  const ihpc = await makeUser(admin, 'Ivan Clinic', 'client');
  await call('PUT', `/api/gfc/admin/enrollment/${ihpc.id}/service-line`, admin, { serviceLine: 'IHPC' });
  const rnT = await login(rn.email, PW);
  const cmT = await login(cm.email, PW);
  ok('probe users sign in', !!(rnT && cmT));

  console.log('\n--- 1. a home care client can have a care plan ---');
  const g0 = await call('GET', `/api/clinical/patients/${phc.id}/care-plan`, rnT);
  ok('GET answers 200 for a home care client (was 409 wrong line)', g0.status === 200, g0.body);
  ok('  and serves the vocabulary and requirements', !!(g0.body.vocabulary && g0.body.vocabulary.requirements.PHC), g0.body.vocabulary);

  const bad = await call('POST', `/api/clinical/patients/${phc.id}/care-plan`, rnT, { ...PHC_PLAN, escalation: {}, review: {} });
  ok('an incomplete home care plan is refused, naming what is missing',
    bad.status === 400 && bad.body.code === 'CARE_PLAN_INCOMPLETE' && bad.body.missing.join() === 'escalation,review', bad.body);
  const afterBad = await call('GET', `/api/clinical/patients/${phc.id}/care-plan`, rnT);
  ok('  and nothing was written', afterBad.body.carePlan === null, afterBad.body.carePlan);

  const saved = await call('POST', `/api/clinical/patients/${phc.id}/care-plan`, rnT, PHC_PLAN);
  ok('a complete home care plan saves', saved.status === 200 && saved.body.carePlan.version === 1, saved.body);
  ok('  an RN signature completes a home care plan', saved.body.providerCoSignStatus === 'not_required', saved.body.providerCoSignStatus);
  ok('  caregiver-scope advice comes back for the blood pressure task',
    (saved.body.warnings || []).some(w => w.where === 'Each visit' && /signed off/.test(w.warning)), saved.body.warnings);

  const g1 = (await call('GET', `/api/clinical/patients/${phc.id}/care-plan`, rnT)).body;
  const goal = g1.carePlan.goalItems[0];
  ok('the stored goal keeps its id, measure and target', goal.id === 'g-probe1' && goal.measure === 'Falls per month' && goal.target === '0', goal);
  ok('problems/goals are derived plain lists', JSON.stringify(g1.carePlan.goals) === '["No falls this quarter"]', g1.carePlan.goals);

  console.log('\n--- 2. goal status without a new version ---');
  const st = await call('POST', `/api/clinical/patients/${phc.id}/care-plan/goals/g-probe1/status`, rnT, { status: 'in_progress', note: 'one fall in October' });
  ok('the status update is accepted', st.status === 200, st.body);
  const g2 = (await call('GET', `/api/clinical/patients/${phc.id}/care-plan`, rnT)).body;
  ok('  the version did not change', g2.carePlan.version === 1, g2.carePlan.version);
  ok('  the goal reads in progress, stamped with who', g2.carePlan.goalItems[0].status === 'in_progress' && /Ruth Nurse/.test(g2.carePlan.goalItems[0].statusBy), g2.carePlan.goalItems[0]);
  ok('  no new version row', (g2.history || []).length === 1, g2.history);
  const hist = await call('GET', `/api/clinical/patients/${phc.id}/care-plan/goals/g-probe1/history`, rnT);
  ok('  the history route lists the change', hist.status === 200 && hist.body.history.length === 1 && hist.body.history[0].note === 'one fall in October', hist.body);
  const roSt = await call('POST', `/api/clinical/patients/${phc.id}/care-plan/goals/g-probe1/status`, cmT, { status: 'met' });
  ok('a read-only case manager cannot change status', roSt.status === 403, roSt);
  const roRead = await call('GET', `/api/clinical/patients/${phc.id}/care-plan`, cmT);
  ok('  but can read the plan', roRead.status === 200);

  console.log('\n--- 3. the next version keeps the status ---');
  const v2 = await call('POST', `/api/clinical/patients/${phc.id}/care-plan`, rnT, PHC_PLAN);
  ok('version 2 saves', v2.status === 200 && v2.body.carePlan.version === 2, v2.body);
  ok('  and the goal is still in progress', v2.body.carePlan.goalItems[0].status === 'in_progress', v2.body.carePlan.goalItems[0]);

  console.log('\n--- 4. a clinical patient needs the clinical blocks ---');
  const ib = await call('POST', `/api/clinical/patients/${ihpc.id}/care-plan`, rnT, PHC_PLAN);
  ok('the home care plan shape is refused for an IHPC patient',
    ib.status === 400 && ['problemDetail', 'medicationManagement'].every(k => ib.body.missing.includes(k)), ib.body);
  const full = await call('POST', `/api/clinical/patients/${ihpc.id}/care-plan`, rnT, {
    ...PHC_PLAN,
    problemItems: [{ id: 'p-probe2', text: 'Heart failure', prognosis: 'Stable with adherence', expectedOutcome: 'No admissions' }],
    goalItems: [{ id: 'g-probe2', problemId: 'p-probe2', statement: 'Stay out of hospital', measure: 'Daily weight', target: '178 lb' }],
    interventions: [{ goalIds: ['g-probe2'], description: 'Furosemide review', responsible: 'gfc_clinician', frequency: 'each_visit', type: 'medication' }],
    medicationManagement: { managedBy: 'family', pharmacy: 'Kroger' }
  });
  ok('a complete IHPC plan saves', full.status === 200, full.body);
  ok('  and an RN signature leaves it waiting on a provider', full.body.providerCoSignStatus === 'pending', full.body.providerCoSignStatus);

  console.log('\n--- 5. the enrollment record names the plan version ---');
  const en = await call('GET', `/api/gfc/admin/enrollment/${phc.id}`, admin);
  ok('enrollment detail carries the version only', en.body.client.carePlan && en.body.client.carePlan.version === 2 && !en.body.client.carePlan.goalItems, en.body.client.carePlan);

  console.log('\n--- 6. a care coordinator writes a plan; a clinician activates it ---');
  const coord = await makeUser(admin, 'Cora Coordinator', 'caseManager', { clinicalRole: 'coordinator' });
  const coordT = await login(coord.email, PW);
  const phc2 = await makeUser(admin, 'Hank Home', 'client');
  const cw = await call('POST', `/api/clinical/patients/${phc2.id}/care-plan`, coordT, PHC_PLAN);
  ok('a coordinator can write a home care plan', cw.status === 200, cw.body);
  ok('  and it waits on a clinician', cw.body.providerCoSignStatus === 'pending', cw.body.providerCoSignStatus);
  const cst = await call('POST', `/api/clinical/patients/${phc2.id}/care-plan/goals/g-probe1/status`, coordT, { status: 'in_progress' });
  ok('a coordinator can update a goal status', cst.status === 200, cst.body);
  const coordView = (await call('GET', `/api/clinical/patients/${phc2.id}/care-plan`, coordT)).body;
  ok('  the coordinator is not offered the co-signature', coordView.canCoSign === false, coordView.canCoSign);
  const coordSelf = await call('POST', `/api/clinical/patients/${phc2.id}/care-plan/provider-cosign`, coordT, { signatureImageB64: SIG });
  ok('  and cannot co-sign their own plan', coordSelf.status === 403, coordSelf.status);
  const rnView = (await call('GET', `/api/clinical/patients/${phc2.id}/care-plan`, rnT)).body;
  ok('an RN is offered the co-signature on a home care plan', rnView.canCoSign === true, rnView.canCoSign);
  const rnCo = await call('POST', `/api/clinical/patients/${phc2.id}/care-plan/provider-cosign`, rnT, { signatureImageB64: SIG });
  ok('  and the RN co-signature makes it active', rnCo.status === 200 && rnCo.body.carePlan.providerCoSignStatus === 'complete', rnCo.body);

  const ihpc2 = await makeUser(admin, 'Iris Clinic', 'client');
  await call('PUT', `/api/gfc/admin/enrollment/${ihpc2.id}/service-line`, admin, { serviceLine: 'IHPC' });
  const cwi = await call('POST', `/api/clinical/patients/${ihpc2.id}/care-plan`, coordT, {
    ...PHC_PLAN,
    problemItems: [{ id: 'p-probe3', text: 'Heart failure', prognosis: 'Stable', expectedOutcome: 'No admissions' }],
    goalItems: [{ id: 'g-probe3', problemId: 'p-probe3', statement: 'Stay home', measure: 'Weight', target: '178 lb' }],
    medicationManagement: { managedBy: 'family' }
  });
  ok('a coordinator can write a clinical patient\u2019s plan', cwi.status === 200 && cwi.body.providerCoSignStatus === 'pending', cwi.body);
  const rnIhpc = await call('POST', `/api/clinical/patients/${ihpc2.id}/care-plan/provider-cosign`, rnT, { signatureImageB64: SIG });
  ok('  an RN cannot activate a clinical patient\u2019s plan', rnIhpc.status === 403, rnIhpc.status);
  const rnIhpcView = (await call('GET', `/api/clinical/patients/${ihpc2.id}/care-plan`, rnT)).body;
  ok('  and is not offered the co-signature', rnIhpcView.canCoSign === false, rnIhpcView.canCoSign);
  const adminCo = await call('POST', `/api/clinical/patients/${ihpc2.id}/care-plan/provider-cosign`, admin, { signatureImageB64: SIG });
  ok('  a provider-level signature activates it', adminCo.status === 200 && adminCo.body.carePlan.providerCoSignStatus === 'complete', adminCo.body);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
