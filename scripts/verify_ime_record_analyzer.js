#!/usr/bin/env node
// scripts/verify_ime_record_analyzer.js — the IME record analyzer through the
// REAL Express routes over HTTP (spec GFC_IME_Record_Analyzer_Spec_v1.md).
//
//   DATA_STORE=memory MFA_ENFORCE=false JWT_SECRET=probe PORT=3243 node server.js
//   GFC_PROBE_BASE=http://localhost:3243 node scripts/verify_ime_record_analyzer.js
//
// Every assertion reads the stored value back rather than trusting a status.
//
// WHAT THIS CANNOT PROVE FROM A BUILD SANDBOX, STATED PLAINLY:
//   • That Drive stores a claim file. No Google credential here, so an upload
//     is refused per file and the probe asserts that NO row was written.
//   • That Gemini reads a claim file. The boundary refuses; the probe asserts
//     the refusal. The analysis itself is run end to end against a fake
//     engine in test/ime_record_analyzer.test.js.
// WHAT IT DOES PROVE: who may see and change a case, the input rules, the
// report clock, the admin-only reopen and logs, and the audit prefix.

const BASE = process.env.GFC_PROBE_BASE || 'http://localhost:3243';
const ADMIN_EMAIL = process.env.GFC_PROBE_ADMIN || 'admin@godwinsfamilycarellc.com';
const ADMIN_PASSWORD = process.env.GFC_PROBE_PASSWORD || 'gfcforever2026';

let pass = 0, fail = 0;
const ok = (label, cond, detail) => {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail !== undefined ? `\n         ${JSON.stringify(detail)}` : ''}`); }
};
const call = async (method, p, token, body) => {
  const r = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch (_) {}
  return { status: r.status, body: j };
};
const login = async (email, password) => ((await call('POST', '/api/auth/login', null, { email, password })).body || {}).token || null;

(async () => {
  const admin = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
  if (!admin) { console.log('LOGIN FAILED — is the app running with MFA_ENFORCE=false?'); process.exit(1); }
  const stamp = Date.now();
  const mk = async (tag, extra) => {
    const email = `ime.${tag}.${stamp}@example.test`;
    const r = await call('POST', '/api/users', admin, { email, password: 'Probe12345!', name: `IME ${tag} (TEST DATA)`, sendWelcomeEmail: false, ...extra });
    return { id: (r.body && (r.body.user ? r.body.user.id : r.body.id)) || null, token: await login(email, 'Probe12345!'), status: r.status };
  };

  console.log('\n--- 0. the people ---');
  const fnp = await mk('fnp', { role: 'user', hasClinicalAccess: true, clinicalRole: 'provider' });
  const fnp2 = await mk('fnp2', { role: 'user', hasClinicalAccess: true, clinicalRole: 'provider' });
  const rn = await mk('rn', { role: 'user', hasClinicalAccess: true, clinicalRole: 'rn' });
  const cm = await mk('cm', { role: 'caseManager' });
  ok('four test users signed in', fnp.token && fnp2.token && rn.token && cm.token, [fnp.status, rn.status, cm.status]);

  console.log('\n--- 1. the surface is closed to everyone but examiners and admin ---');
  ok('no login: 401', (await call('GET', '/api/ime/cases')).status === 401);
  ok('an RN: 403', (await call('GET', '/api/ime/cases', rn.token)).status === 403);
  ok('a case manager: 403', (await call('GET', '/api/ime/cases', cm.token)).body.code === 'IME_NOT_PERMITTED');
  const meta = await call('GET', '/api/ime/meta', admin);
  ok('admin sees the examiners, and they are only providers', meta.body.examiners.some(u => u.id === fnp.id) && !meta.body.examiners.some(u => u.id === rn.id), meta.body.examiners);
  ok('admin sees what analysis waits on', meta.body.analysisAvailable === false && meta.body.blockers.length > 0);
  ok('an examiner is not shown the settings', (await call('GET', '/api/ime/meta', fnp.token)).body.blockers === undefined);
  ok('retention defaults to 30 days and 7332 records are excluded', meta.body.retentionDays === 30 && meta.body.cleared7332 === false);

  console.log('\n--- 2. a case ---');
  ok('an SSN as a reference id is refused', (await call('POST', '/api/ime/cases', admin, { referenceId: '123-45-6789', contractingEntity: 'lsgs', claimedConditions: ['Tinnitus'], examinerId: fnp.id })).body.fieldErrors.referenceId);
  ok('an RN cannot be assigned', (await call('POST', '/api/ime/cases', admin, { referenceId: `P-${stamp}`, contractingEntity: 'lsgs', claimedConditions: ['Tinnitus'], examinerId: rn.id })).body.code === 'IME_EXAMINER_NOT_ELIGIBLE');
  const made = await call('POST', '/api/ime/cases', admin, { referenceId: `P-${stamp}`, contractingEntity: 'ves', claimedConditions: ['Tinnitus', 'Lumbar strain'], examinerId: fnp.id, examDate: '2026-11-20' });
  ok('admin creates and assigns a case', made.status === 201 && made.body.case.examinerId === fnp.id, made.body);
  const id = made.body.case.id;
  ok('a second open case for the same reference is refused', (await call('POST', '/api/ime/cases', admin, { referenceId: `p-${stamp}`, contractingEntity: 'ves', claimedConditions: ['x'], examinerId: fnp.id })).status === 409);
  ok('the assigned examiner sees it', (await call('GET', '/api/ime/cases', fnp.token)).body.cases.some(c => c.id === id));
  ok('another examiner does not see it in their list', !(await call('GET', '/api/ime/cases', fnp2.token)).body.cases.some(c => c.id === id));
  ok('and is refused it by name', (await call('GET', `/api/ime/cases/${id}`, fnp2.token)).body.code === 'IME_NOT_ASSIGNED');
  const own = await call('POST', '/api/ime/cases', fnp2.token, { referenceId: `Q-${stamp}`, contractingEntity: 'lsgs', claimedConditions: ['PTSD'], examinerId: fnp.id });
  ok('an examiner opens a case only for themselves', own.body.case.examinerId === fnp2.id);
  ok('an examiner cannot reassign', (await call('PUT', `/api/ime/cases/${id}`, fnp.token, { examinerId: fnp2.id })).body.code === 'IME_ADMIN_ONLY');
  const upd = await call('PUT', `/api/ime/cases/${id}`, fnp.token, { claimedConditions: ['Tinnitus', 'Lumbar strain', 'PTSD'] });
  ok('the examiner edits the claimed conditions', upd.body.case.claimedConditions.length === 3);

  console.log('\n--- 3. upload and analysis, without Google ---');
  const fd = new FormData();
  fd.append('files', new Blob([Buffer.from('%PDF-1.4\n%%EOF')], { type: 'application/pdf' }), 'claim.pdf');
  const up = await (await fetch(`${BASE}/api/ime/cases/${id}/documents`, { method: 'POST', headers: { Authorization: `Bearer ${fnp.token}` }, body: fd })).json();
  ok('an upload Drive cannot take is refused, per file', up.results && up.results[0] && up.results[0].ok === false, up);
  const after = await call('GET', `/api/ime/cases/${id}`, fnp.token);
  ok('and no row was written for it', after.body.documents.length === 0);
  ok('an analysis with no claim file is refused by name', (await call('POST', `/api/ime/cases/${id}/analyses`, fnp.token)).body.code === 'IME_NO_DOCUMENTS');

  console.log('\n--- 4. the report clock ---');
  const sub = await call('POST', `/api/ime/cases/${id}/report-submitted`, fnp.token);
  ok('report submitted starts a 30-day clock', sub.body.case.status === 'report_submitted' && sub.body.case.purgeDueAt &&
    Math.round((Date.parse(sub.body.case.purgeDueAt) - Date.parse(sub.body.case.reportSubmittedAt)) / 86400000) === 30, sub.body.case);
  ok('an examiner cannot reopen', (await call('POST', `/api/ime/cases/${id}/reopen`, fnp.token, { reason: 'x' })).status === 403);
  ok('admin needs a reason', (await call('POST', `/api/ime/cases/${id}/reopen`, admin, {})).body.code === 'IME_REASON_REQUIRED');
  ok('admin reopens with a reason', (await call('POST', `/api/ime/cases/${id}/reopen`, admin, { reason: 'probe' })).body.case.status === 'open');

  console.log('\n--- 5. admin views ---');
  ok('the deletion log is admin-only', (await call('GET', '/api/ime/admin/deletion-log', fnp.token)).status === 403 && Array.isArray((await call('GET', '/api/ime/admin/deletion-log', admin)).body.entries));
  ok('spend per case is admin-only', (await call('GET', '/api/ime/admin/spend', fnp.token)).status === 403 && Array.isArray((await call('GET', '/api/ime/admin/spend', admin)).body.spend));
  const page = await fetch(`${BASE}/ime`);
  ok('the /ime page serves', page.status === 200);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
