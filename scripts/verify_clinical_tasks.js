#!/usr/bin/env node
// scripts/verify_clinical_tasks.js — patient to-dos and the daily digest
// (owner, 2026-10-13), driven through the REAL Express routes over HTTP.
//
//   DATA_STORE=memory MFA_ENFORCE=false JWT_SECRET=probe PORT=3214 node server.js
//   GFC_PROBE_BASE=http://localhost:3214 node scripts/verify_clinical_tasks.js
//
// Asserts what was stored by reading it back. NOT proven here: upcoming visits
// in the digest, because the calendar is OpenEMR's and none is reachable from
// a sandbox — the digest says so rather than listing nothing.

const BASE = process.env.GFC_PROBE_BASE || 'http://localhost:3214';
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
  let j = null; try { j = await r.json(); } catch (_) {}
  return { status: r.status, body: j };
};
const login = async (email, password) => {
  const r = await call('POST', '/api/auth/login', null, { email, password });
  return (r.body && r.body.token) || null;
};
const STAMP = Date.now();
const PW = 'Probe12345!';
const makeUser = async (token, name, role, clinicalRole, extra) => {
  const slug = String(name).toLowerCase().replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '');
  const email = `tasks.${slug}.${STAMP}@example.test`;
  const r = await call('POST', '/api/users', token, {
    email, password: PW, name: `${name} (TEST DATA)`, role, clinicalRole,
    ...(role === 'client' ? { practiceName: `${name} (TEST DATA)` } : {}),
    licenseLevel: { provider: 'FNP', rn: 'RN' }[clinicalRole] || undefined,
    sendWelcomeEmail: false, ...(extra || {})
  });
  return { id: r.body && (r.body.user ? r.body.user.id : r.body.id), email, status: r.status, body: r.body };
};

(async () => {
  const admin = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
  if (!admin) { console.log('LOGIN FAILED — is the app running with MFA_ENFORCE=false?'); process.exit(1); }
  const patient = await makeUser(admin, 'Tasks Probe Patient', 'client');
  const fnp = await makeUser(admin, 'Fiona Provider', 'user', 'provider');
  const rn = await makeUser(admin, 'Rhea Nurse', 'user', 'rn');
  const other = await makeUser(admin, 'Otto Other', 'user', 'provider');
  const cm = await makeUser(admin, 'Cass Manager', 'caseManager', 'readOnly');
  const fTok = await login(fnp.email, PW), rTok = await login(rn.email, PW);
  const oTok = await login(other.email, PW), cTok = await login(cm.email, PW);
  if (!patient.id || !fTok || !rTok || !oTok || !cTok) { console.log('Seeding failed'); process.exit(1); }

  console.log('\nA. Create and assign');
  const today = (await call('GET', '/api/clinical/tasks', fTok)).body.today;
  ok('the list answers with today (Georgia)', /^\d{4}-\d{2}-\d{2}$/.test(today || ''), today);
  const c1 = await call('POST', '/api/clinical/tasks', fTok, {
    clientId: patient.id, title: 'Call daughter about PT', dueDate: today, priority: 'soon', category: 'call', assigneeId: rn.id
  });
  ok('a provider creates a to-do for the nurse (201)', c1.status === 201, c1.body);
  const tid = c1.body && c1.body.task && c1.body.task.id;
  ok('it lands assigned to the nurse, bucket today', c1.body.task.assigneeId === String(rn.id) && c1.body.task.bucket === 'today', c1.body.task);
  const noClient = await call('POST', '/api/clinical/tasks', fTok, { title: 'x' });
  ok('a to-do with no patient is refused', noClient.status === 400 && noClient.body.code === 'TASK_CLIENT_REQUIRED', noClient.body);
  const badAssignee = await call('POST', '/api/clinical/tasks', fTok, { clientId: patient.id, title: 'x', assigneeId: patient.id });
  ok('a client cannot be the assignee', badAssignee.status === 400 && badAssignee.body.code === 'TASK_ASSIGNEE_NOT_ELIGIBLE', badAssignee.body);

  console.log('\nB. Only the assignee and the author see it');
  const seenBy = async (tok) => ((await call('GET', '/api/clinical/tasks?scope=all', tok)).body.tasks || []).some(t => t.id === tid);
  ok('the author sees it', await seenBy(fTok));
  ok('the nurse sees it', await seenBy(rTok));
  ok('another provider does not', !(await seenBy(oTok)));
  ok('admin does not', !(await seenBy(admin)));
  const poke = await call('PUT', `/api/clinical/tasks/${tid}`, oTok, { action: 'done' });
  ok('another provider gets 404 trying to close it', poke.status === 404 && poke.body.code === 'TASK_NOT_FOUND', poke.body);
  const mine = (await call('GET', '/api/clinical/tasks?scope=mine', rTok)).body.tasks.map(t => t.id);
  const iAssigned = (await call('GET', '/api/clinical/tasks?scope=assigned_by_me', fTok)).body.tasks.map(t => t.id);
  ok('the nurse finds it under Assigned to Me', mine.includes(tid));
  ok('the provider finds it under I Assigned', iAssigned.includes(tid));
  const forPatient = (await call('GET', `/api/clinical/tasks?clientId=${patient.id}`, fTok)).body.tasks.map(t => t.id);
  ok('the chart card filters by patient', forPatient.includes(tid));

  console.log('\nC. The digest');
  let dg = await call('GET', '/api/clinical/digest', rTok);
  ok('the digest answers for the nurse', dg.status === 200, dg.body);
  ok('her to-do due today is pending now', dg.body.pending.some(p => p.id === tid), dg.body.pending);
  ok('it names who handed it over', (dg.body.pending.find(p => p.id === tid) || {}).from === 'Fiona Provider (TEST DATA)');
  ok('it is not in the author\'s pending (handed over)', !(await call('GET', '/api/clinical/digest', fTok)).body.pending.some(p => p.id === tid));
  ok('no own calendar is reported, not shown as empty', dg.body.calendar && dg.body.calendar.ok === false, dg.body.calendar);
  const soon = new Date(`${today}T12:00:00Z`); soon.setUTCDate(soon.getUTCDate() + 3);
  const c2 = await call('POST', '/api/clinical/tasks', rTok, { clientId: patient.id, title: 'Recheck BP', dueDate: soon.toISOString().slice(0, 10) });
  dg = await call('GET', '/api/clinical/digest', rTok);
  ok('a to-do due in 3 days is coming up, not pending', dg.body.upcoming.some(p => p.id === c2.body.task.id) && !dg.body.pending.some(p => p.id === c2.body.task.id));
  ok('the counts match the lists', dg.body.counts.pending === dg.body.pending.length && dg.body.counts.upcoming === dg.body.upcoming.length);

  console.log('\nD. Done, cancel, reopen');
  const done = await call('PUT', `/api/clinical/tasks/${tid}`, rTok, { action: 'done', note: 'Spoke to daughter' });
  ok('the nurse marks it done', done.status === 200 && done.body.task.status === 'done' && done.body.task.completionNote === 'Spoke to daughter', done.body);
  dg = await call('GET', '/api/clinical/digest', rTok);
  ok('a done to-do leaves the digest', !dg.body.pending.some(p => p.id === tid));
  const closed = (await call('GET', '/api/clinical/tasks?scope=all&includeClosed=true', fTok)).body.tasks.find(t => t.id === tid);
  ok('the author sees it done, with who did it', closed && closed.status === 'done' && /Rhea Nurse/.test(closed.completedByName || ''), closed);
  const noReason = await call('PUT', `/api/clinical/tasks/${c2.body.task.id}`, rTok, { action: 'cancel' });
  ok('cancelling with no reason is refused', noReason.status === 400 && noReason.body.code === 'TASK_CANCEL_REASON_REQUIRED');
  const reopen = await call('PUT', `/api/clinical/tasks/${tid}`, fTok, { action: 'reopen' });
  ok('the author can reopen it', reopen.status === 200 && reopen.body.task.status === 'open');

  console.log('\nE. Case manager');
  const cmTask = await call('POST', '/api/clinical/tasks', cTok, { clientId: patient.id, title: 'Send intake packet to facility', category: 'paperwork' });
  ok('a case manager creates a to-do', cmTask.status === 201, cmTask.body);
  const cmDone = await call('PUT', `/api/clinical/tasks/${cmTask.body.task.id}`, cTok, { action: 'done' });
  ok('and completes it', cmDone.status === 200 && cmDone.body.task.status === 'done');
  const cmDigest = await call('GET', '/api/clinical/digest', cTok);
  ok('a case manager gets a digest', cmDigest.status === 200, cmDigest.body);
  const st = await call('GET', '/api/clinical/status', cTok);
  ok('status serves canManageTasks to a case manager', st.body && st.body.access && st.body.access.canManageTasks === true, st.body && st.body.access);

  console.log('\nF. Gate and audit');
  const pTok = await login(patient.email, PW);
  const pt = await call('GET', '/api/clinical/tasks', pTok);
  ok('a patient is refused', pt.status === 403);
  const log = await call('GET', '/api/admin/activity-log?limit=500', admin);
  const rows = JSON.stringify((log.body && (log.body.activities || log.body)) || []);
  ok('the audit trail names the action', log.status === 200 && /clinical_task_created/.test(rows) && /clinical_task_done/.test(rows), log.status);
  ok('the audit trail never carries a to-do\'s words', !/Call daughter about PT|Recheck BP/.test(rows));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
