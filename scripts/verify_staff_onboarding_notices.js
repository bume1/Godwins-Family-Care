#!/usr/bin/env node
// scripts/verify_staff_onboarding_notices.js — email for staff onboarding and
// credentialing (owner, 2026-11-09), through the REAL Express routes over HTTP.
//
//   DATA_STORE=memory MFA_ENFORCE=false JWT_SECRET=probe PORT=3243 node server.js
//   GFC_PROBE_BASE=http://localhost:3243 node scripts/verify_staff_onboarding_notices.js
//
// Reads the QUEUED NOTIFICATION back rather than trusting a status code: what
// matters is the message that would be delivered, to whom, carrying which key.
// Queueing is as far as this reaches — that Google accepts and delivers is
// `scripts/verify_email_transport.js` on the deployment.

const BASE = process.env.GFC_PROBE_BASE || 'http://localhost:3243';
const ADMIN_EMAIL = process.env.GFC_PROBE_ADMIN || 'admin@godwinsfamilycarellc.com';
const ADMIN_PASSWORD = process.env.GFC_PROBE_PASSWORD || 'gfcforever2026';

let pass = 0, fail = 0, skipped = 0;
// A section the clock puts out of reach is reported as SKIPPED, never as a
// pass: "it is 1am so nothing was sent" and "the digest works" are different
// facts, and printing ok for the first would claim the second.
const skip = (label, why) => { skipped++; console.log(`  skip ${label} — ${why}`); };
const ok = (label, cond, detail) => {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail !== undefined ? `\n         ${JSON.stringify(detail).slice(0, 400)}` : ''}`); }
};
const call = async (method, path, token, body) => {
  const r = await fetch(BASE + path, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  let j = null; try { j = await r.json(); } catch (_) {}
  return { status: r.status, body: j };
};
const STAMP = Date.now();
const PW = 'Probe12345!';
const ymd = (offsetDays) => new Date(Date.now() + offsetDays * 864e5).toISOString().slice(0, 10);

(async () => {
  console.log(`\nStaff onboarding + credentialing email — ${BASE}\n`);
  const admin = (await call('POST', '/api/auth/login', null, { email: ADMIN_EMAIL, password: ADMIN_PASSWORD })).body?.token;
  if (!admin) { console.log('  FAIL could not sign in as admin'); process.exit(1); }

  const mk = async (name, role, extra) => {
    const slug = String(name).toLowerCase().replace(/[^a-z]+/g, '-');
    const email = `onb.${slug}.${STAMP}@example.test`;
    const r = await call('POST', '/api/users', admin, {
      email, password: PW, name: `${name} (TEST DATA)`, role, sendWelcomeEmail: false, ...(extra || {})
    });
    const id = r.body && (r.body.user ? r.body.user.id : r.body.id);
    const tok = (await call('POST', '/api/auth/login', null, { email, password: PW })).body?.token || null;
    return { id, email, token: tok, status: r.status, body: r.body };
  };

  const her = await mk('Jordan Probe', 'user', { clinicalRole: 'provider', licenseLevel: 'FNP', hasClinicalAccess: true });
  ok('a clinician account exists to onboard', !!her.id, her.body);
  const patient = await mk('Patient Probe', 'client', { practiceName: `Patient Probe ${STAMP} (TEST DATA)` });

  const queued = async (type, email) => {
    const r = await call('GET', '/api/admin/notifications/queue', admin);
    const rows = (r.body && (r.body.queue || r.body.notifications || r.body)) || [];
    return (Array.isArray(rows) ? rows : []).filter(n => n && (!type || n.type === type) && (!email || n.recipientEmail === email));
  };
  const allStaffNotices = async () => {
    const r = await call('GET', '/api/admin/notifications/queue', admin);
    const rows = (r.body && (r.body.queue || r.body.notifications || r.body)) || [];
    return (Array.isArray(rows) ? rows : []).filter(n => n && /^staff_(onboarding|item|credential)/.test(String(n.type || '')));
  };
  const scan = () => call('POST', '/api/admin/reminders/trigger', admin);

  // ── A. Her onboarding is opened ─────────────────────────────────────────
  console.log('\nA. The office opens her onboarding');
  const started = await call('PUT', `/api/onboarding/admin/people/${her.id}/inputs`, admin,
    { chapter: 'C', serviceLines: ['PRIVATE_PAY'], credentials: ['FNP'], startDate: ymd(-40) });
  ok('her track is created', started.status === 200, started.body);
  const welcome = await queued('staff_onboarding_started', her.email);
  ok('she is welcomed', welcome.length === 1, welcome.map(n => n.templateData?.subject));
  ok('the welcome points at her own portal',
    String(welcome[0]?.templateData?.ctaUrl || '').endsWith('/my#onboarding'), welcome[0]?.templateData?.ctaUrl);
  ok('and it is not marked PHI (employment data)', welcome[0]?.phi === false, welcome[0]?.phi);
  await call('PUT', `/api/onboarding/admin/people/${her.id}/inputs`, admin, { chapter: 'C', serviceLines: ['PRIVATE_PAY', 'IME'], credentials: ['FNP'], startDate: ymd(-40) });
  ok('changing her inputs later is not a second welcome', (await queued('staff_onboarding_started', her.email)).length === 1);

  // ── B. She submits; the office is told ──────────────────────────────────
  console.log('\nB. She submits an item');
  const sub = await call('POST', '/api/onboarding/me/items/C.4.05/steps/0', her.token, {});
  ok('her step is accepted', sub.status === 200, sub.body);
  const toOffice = await queued('staff_item_submitted');
  ok('the office is told it can be verified', toOffice.length >= 1, toOffice.map(n => n.recipientEmail));
  ok('and that notice points at the OFFICE screen, not her portal',
    String(toOffice[0]?.templateData?.ctaUrl || '').endsWith('/onboarding'), toOffice[0]?.templateData?.ctaUrl);

  // ── C. The office returns it, with the reason ───────────────────────────
  console.log('\nC. The office sends it back');
  const reason = 'The scan was cut off at the expiration date';
  const ret = await call('POST', `/api/onboarding/admin/people/${her.id}/items/C.4.05/return`, admin, { step: 0, reason });
  ok('the return is recorded', ret.status === 200, ret.body);
  const back = await queued('staff_onboarding_returned', her.email);
  ok('she is emailed about it', back.length === 1, back.map(n => n.templateData?.subject));
  ok('AND THE REASON IS IN IT — the whole point of the notice',
    String(back[0]?.templateData?.body || '').includes(reason),
    String(back[0]?.templateData?.body || '').slice(0, 200));

  // ── D. Her daily digest ─────────────────────────────────────────────────
  console.log('\nD. Her daily digest');
  await scan();
  const digest = await queued('staff_onboarding_digest', her.email);
  const etHour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }).format(new Date()));
  if (etHour < 9) {
    ok(`nothing is sent before 9am Eastern (it is ${etHour}:00 there)`, digest.length === 0, digest.length);
    skip('the digest itself', `it is ${etHour}:00 in Georgia; re-run after 09:00 ET to prove this half through the full server`);
  } else {
    ok('one digest, carrying everything waiting on her', digest.length === 1, digest.map(n => n.templateData?.subject));
    const body = String(digest[0]?.templateData?.body || '');
    ok('it lists what is waiting on her', /WAITING ON YOU/.test(body), body.slice(0, 160));
    ok('and the returned item leads it', /SENT BACK TO YOU/.test(body));
    ok('keyed per person per day', /^onbdigest:/.test(String(digest[0]?.relatedEntityId)), digest[0]?.relatedEntityId);
    await scan(); await scan();
    ok('three scans in one day is still ONE digest', (await queued('staff_onboarding_digest', her.email)).length === 1);
  }

  // ── E. A credential expiring ────────────────────────────────────────────
  console.log('\nE. A credential 14 days out');
  const exp = await call('PUT', `/api/onboarding/admin/people/${her.id}/items/C.4.01/expiry`, admin, { expiresOn: ymd(14) });
  ok('the expiration date is recorded', exp.status === 200, exp.body);
  const person = await call('GET', `/api/onboarding/admin/people/${her.id}`, admin);
  ok('the licence is on her track (precondition)',
    (person.body?.track?.renewals?.items || []).some(x => x.id === 'C.4.01'), 'otherwise nothing below proves anything');
  await scan();
  if (etHour >= 9) {
    const cred = await queued('staff_credential_expiring');
    ok('the office is told at the 14-day milestone', cred.length >= 1, cred.map(n => n.templateData?.subject));
    ok('the notice names the person and the credential',
      /Jordan Probe/.test(String(cred[0]?.templateData?.subject || '')) && /License or authorization/.test(String(cred[0]?.templateData?.subject || '')),
      cred[0]?.templateData?.subject);
    const d2 = await queued('staff_onboarding_digest', her.email);
    ok('she hears in her ONE daily email, not a second one', d2.length === 1 && /CREDENTIALS/.test(String(d2[0]?.templateData?.body || '')));
    await scan();
    ok('and the office is not told again the same day', (await queued('staff_credential_expiring')).length === cred.length);
  } else {
    ok('before 9am Eastern nothing is sent, which is the rule', (await queued('staff_credential_expiring')).length === 0);
    skip('the credential milestone', `it is ${etHour}:00 in Georgia; re-run after 09:00 ET`);
  }

  // ── F. Who is never emailed ─────────────────────────────────────────────
  console.log('\nF. Who is never emailed');
  const all = await allStaffNotices();
  ok('no staff-onboarding notice reached the patient',
    !all.some(n => n.recipientEmail === patient.email), all.filter(n => n.recipientEmail === patient.email).map(n => n.type));
  ok('and none of them carries the patient name',
    !all.some(n => `${n.templateData?.subject} ${n.templateData?.body}`.includes('Patient Probe')));
  ok('every one is marked not-PHI (employment data, not a patient\'s)', all.every(n => n.phi === false));
  // Checked against the ROSTER rather than against this run's addresses: the
  // queue is shared, so an earlier run's rows are legitimately in it and an
  // assertion keyed on this run's email would fail on them. The rule that
  // matters is run-independent — no client or family account is ever a
  // recipient of a staff onboarding notice.
  const roster = (await call('GET', '/api/users', admin)).body || [];
  const byEmail = new Map((Array.isArray(roster) ? roster : roster.users || []).map(u => [u.email, u]));
  const nonStaff = all.filter(n => {
    const u = byEmail.get(n.recipientEmail);
    return u && (u.role === 'client' || u.role === 'family');
  });
  ok('no client or family account is ever a recipient', nonStaff.length === 0,
    nonStaff.map(n => `${n.type} -> ${n.recipientEmail}`));
  ok('every recipient resolves to a real account on the roster',
    all.every(n => byEmail.has(n.recipientEmail)),
    all.filter(n => !byEmail.has(n.recipientEmail)).map(n => n.recipientEmail));

  console.log(`\n${pass} passed, ${fail} failed${skipped ? `, ${skipped} SKIPPED (see above)` : ''}\n`);
  if (skipped) console.log('  The skipped sections are exercised over HTTP in test/staff_onboarding_notices.test.js,\n  which hands the sweep the date and hour instead of waiting for them.\n');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('PROBE CRASHED', e); process.exit(1); });
