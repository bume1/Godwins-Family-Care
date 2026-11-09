#!/usr/bin/env node
// ============================================================
// Live probe — a care plan an unlicensed author wrote reaches a licensed
// clinician to sign, and once signed it is released to the patient
// (owner, 2026-11-09).
//
//   DATA_STORE=memory MFA_ENFORCE=false JWT_SECRET=probe PORT=3199 node server.js
//   node scripts/verify_care_plan_cosign_release.js
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
  const email = `probe.rel.${name.split(' ')[0].toLowerCase()}.${STAMP}@example.test`;
  const r = await call('POST', '/api/users', token, {
    email, password: PW, name: `${name} (TEST DATA)`, role, sendWelcomeEmail: false,
    ...(role === 'client' ? { practiceName: `${name} (TEST DATA)` } : {}), ...extra
  });
  return { id: r.body && (r.body.user ? r.body.user.id : r.body.id), email, status: r.status, body: r.body };
};
const PLAN = (goal) => ({
  problemItems: [{ id: 'p-rel001', text: 'Fall risk' }],
  goalItems: [{ id: 'g-rel001', problemId: 'p-rel001', statement: goal }],
  eachVisit: ['Walk to the mailbox if steady'], visitFrequency: '3x/week',
  escalation: { callGfcWhen: ['Any fall'] }, review: { cadence: '90_days', nextReviewDate: '2027-01-15' },
  rnSignatureImageB64: SIG
});
// A clinical patient's plan carries more: prognosis, measures, interventions,
// medication management and outside care.
const CLINICAL_PLAN = () => ({
  ...PLAN('Stay out of hospital'),
  problemItems: [{ id: 'p-rel002', text: 'Heart failure', prognosis: 'Stable with adherence', expectedOutcome: 'No admissions' }],
  goalItems: [{ id: 'g-rel002', problemId: 'p-rel002', statement: 'Stay out of hospital', measure: 'Daily weight', target: '178 lb' }],
  interventions: [{ goalIds: ['g-rel002'], description: 'Furosemide review', responsible: 'gfc_clinician', frequency: 'each_visit', type: 'medication' }],
  medicationManagement: { managedBy: 'family', pharmacy: 'Kroger' },
  outsideCare: { externalTeam: [{ name: 'Dr. Patel', role: 'Cardiology' }] }
});
const inboxItem = async (token, clientId) => {
  const r = await call('GET', '/api/clinical/inbox?scope=all', token);
  const items = (r.body && r.body.items) || [];
  return items.find(i => i.kind === 'care_plan_co_sign' && i.clientId === String(clientId)) || null;
};
const readyNotices = async (admin, clientId) => {
  const q = await call('GET', '/api/admin/notifications/queue?type=care_plan_ready', admin);
  return (q.body || []).filter(n => String(n.relatedEntityId || '').startsWith(`${clientId}:careplan:`));
};

(async () => {
  const admin = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
  if (!admin) { console.log('LOGIN FAILED — is the app running with MFA_ENFORCE=false?'); process.exit(1); }
  const coord = await makeUser(admin, 'Cora Coordinator', 'caseManager', { clinicalRole: 'coordinator' });
  const rn = await makeUser(admin, 'Ruth Nurse', 'user', { clinicalRole: 'rn', licenseLevel: 'RN' });
  const rn2 = await makeUser(admin, 'Rita Nurse', 'user', { clinicalRole: 'rn', licenseLevel: 'RN' });
  const prov = await makeUser(admin, 'Paula Provider', 'user', { clinicalRole: 'provider', licenseLevel: 'FNP' });
  const home = await makeUser(admin, 'Hal Homecare', 'client');
  const clin = await makeUser(admin, 'Cleo Clinical', 'client');
  await call('PUT', `/api/users/${home.id}`, admin, { enrollmentStatus: 'enrolled', serviceLine: 'PHC' });
  await call('PUT', `/api/users/${clin.id}`, admin, { enrollmentStatus: 'enrolled' });
  const line = await call('PUT', `/api/gfc/admin/enrollment/${clin.id}/service-line`, admin, { serviceLine: 'IHPC' });
  ok('the clinical client is on the clinical line', line.status === 200, line.body);
  const coordT = await login(coord.email, PW);
  const rnT = await login(rn.email, PW);
  const rn2T = await login(rn2.email, PW);
  const provT = await login(prov.email, PW);
  const homeT = await login(home.email, PW);
  ok('probe users sign in', !!(coordT && rnT && rn2T && provT && homeT), { coord: coord.status, rn: rn.status, prov: prov.status });

  console.log('\n--- 1. a coordinator writes a home care plan ---');
  const w = await call('POST', `/api/clinical/patients/${home.id}/care-plan`, coordT, PLAN('No falls'));
  ok('the coordinator can save it', w.status === 200, w.body);
  ok('it waits on a clinician', w.body && w.body.providerCoSignStatus === 'pending', w.body);
  ok('the patient is not told yet', (await readyNotices(admin, home.id)).length === 0);
  const hidden = await call('GET', '/api/gfc/care-plan', homeT);
  ok('the patient cannot see it yet', hidden.status === 200 && !(hidden.body && hidden.body.carePlan), hidden.body);

  console.log('\n--- 2. the RN finds it and can sign ---');
  const it = await inboxItem(rnT, home.id);
  ok('it is in the RN\'s inbox', !!it);
  ok('the RN can act on it', !!(it && it.actionable), it);
  ok('it opens on its own page, not a chart', !!(it && it.noChart === true), it);
  const digest = await call('GET', '/api/clinical/digest', rnT);
  const dText = JSON.stringify(digest.body || {});
  ok('it is on the RN\'s My Day digest', digest.status === 200 && dText.includes(String(home.id)), { status: digest.status });
  const view = await call('GET', `/api/clinical/patients/${home.id}/care-plan`, rnT);
  ok('the care plan page offers the RN the signature', view.status === 200 && view.body && view.body.canCoSign === true, view.body && { canCoSign: view.body.canCoSign });
  const selfView = await call('GET', `/api/clinical/patients/${home.id}/care-plan`, coordT);
  ok('the coordinator is not offered their own co-signature', selfView.body && selfView.body.canCoSign === false);

  console.log('\n--- 3. the RN signs, and the plan is released ---');
  const s = await call('POST', `/api/clinical/patients/${home.id}/care-plan/provider-cosign`, rnT, { signatureImageB64: SIG });
  ok('the co-signature saves', s.status === 200, s.body);
  ok('the plan is complete', s.body && s.body.carePlan && s.body.carePlan.providerCoSignStatus === 'complete', s.body);
  const shown = await call('GET', '/api/gfc/care-plan', homeT);
  ok('the patient can now see it', shown.status === 200 && shown.body && shown.body.carePlan, shown.body);
  const notes = await readyNotices(admin, home.id);
  ok('the patient is told it is ready to sign', notes.length === 1, notes);
  ok('the notice carries no plan content', notes.length === 1 && !JSON.stringify(notes[0]).includes('Fall risk'), notes[0]);
  ok('it is gone from the RN\'s inbox', !(await inboxItem(rnT, home.id)));

  console.log('\n--- 4. a coordinator writes a clinical patient\'s plan; an RN signs it ---');
  const w2 = await call('POST', `/api/clinical/patients/${clin.id}/care-plan`, coordT, CLINICAL_PLAN());
  ok('the coordinator can save it', w2.status === 200 && w2.body.providerCoSignStatus === 'pending', w2.body);
  const rnIt = await inboxItem(rnT, clin.id);
  ok('the RN can act on it', !!rnIt && rnIt.actionable === true, rnIt);
  ok('it opens in the chart', !!rnIt && rnIt.noChart === false, rnIt);
  const provIt = await inboxItem(provT, clin.id);
  ok('the provider can act on it too', !!provIt && provIt.actionable === true, provIt);
  const rnView = await call('GET', `/api/clinical/patients/${clin.id}/care-plan`, rnT);
  ok('the chart\'s care plan tab offers the RN the signature', rnView.body && rnView.body.canCoSign === true, rnView.body && { canCoSign: rnView.body.canCoSign });
  const r = await call('POST', `/api/clinical/patients/${clin.id}/care-plan/provider-cosign`, rnT, { signatureImageB64: SIG });
  ok('the RN signs', r.status === 200 && r.body.carePlan.providerCoSignStatus === 'complete', r.body);
  const clinT = await login(clin.email, PW);
  const clinView = await call('GET', '/api/gfc/care-plan', clinT);
  ok('the clinical patient can now see it', clinView.status === 200 && clinView.body && clinView.body.carePlan, clinView.body);
  ok('the patient is told', (await readyNotices(admin, clin.id)).length === 1);

  console.log('\n--- 4b. an RN writes a clinical patient\'s plan; it still needs a provider ---');
  const w2b = await call('POST', `/api/clinical/patients/${clin.id}/care-plan`, rnT, CLINICAL_PLAN());
  ok('the RN\'s save waits on a co-signature', w2b.status === 200 && w2b.body.providerCoSignStatus === 'pending', w2b.body);
  const rn2It = await inboxItem(rn2T, clin.id);
  ok('another RN sees it but cannot act', !!rn2It && rn2It.actionable === false, rn2It);
  const rn2View = await call('GET', `/api/clinical/patients/${clin.id}/care-plan`, rn2T);
  ok('the care plan tab does not offer another RN the signature', rn2View.body && rn2View.body.canCoSign === false);
  const rn2Try = await call('POST', `/api/clinical/patients/${clin.id}/care-plan/provider-cosign`, rn2T, { signatureImageB64: SIG });
  ok('another RN is refused, and told who can sign', rn2Try.status === 403 && /provider or an LCSW/.test(rn2Try.body && rn2Try.body.error), rn2Try.body);
  const p = await call('POST', `/api/clinical/patients/${clin.id}/care-plan/provider-cosign`, provT, { signatureImageB64: SIG });
  ok('the provider signs it', p.status === 200 && p.body.carePlan.providerCoSignStatus === 'complete', p.body);
  ok('the patient is told about the new version', (await readyNotices(admin, clin.id)).length === 2);

  console.log('\n--- 5. a licensed author\'s own plan is released at once ---');
  const w3 = await call('POST', `/api/clinical/patients/${home.id}/care-plan`, rnT, PLAN('No falls (v2)'));
  ok('an RN\'s home care plan needs no co-signature', w3.status === 200 && w3.body.providerCoSignStatus === 'not_required', w3.body);
  ok('the patient is told about the new version', (await readyNotices(admin, home.id)).length === 2);

  console.log('\n--- 6. the shared admin account (no NPI) is an author, not a signer ---');
  const adminUser = ((await call('GET', '/api/users', admin)).body || []).find(u => u.email === ADMIN_EMAIL) || {};
  if (/^\d{10}$/.test(String(adminUser.npi || ''))) {
    console.log('  (skipped: this admin account carries an NPI, so it signs as a provider)');
  } else {
    const w4 = await call('POST', `/api/clinical/patients/${clin.id}/care-plan`, admin, CLINICAL_PLAN());
    ok('the admin\'s plan waits on a clinician', w4.status === 200 && w4.body.providerCoSignStatus === 'pending', w4.body);
    const adminView = await call('GET', `/api/clinical/patients/${clin.id}/care-plan`, admin);
    ok('the admin is not offered the co-signature', adminView.body && adminView.body.canCoSign === false);
    const rnSees = await call('GET', `/api/clinical/patients/${clin.id}/care-plan`, rnT);
    ok('an RN is offered it', rnSees.body && rnSees.body.canCoSign === true);
    const a2 = await call('POST', `/api/clinical/patients/${clin.id}/care-plan/provider-cosign`, rnT, { signatureImageB64: SIG });
    ok('the RN signs it and it is complete', a2.status === 200 && a2.body.carePlan.providerCoSignStatus === 'complete', a2.body);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
