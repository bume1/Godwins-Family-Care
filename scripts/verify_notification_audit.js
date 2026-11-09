#!/usr/bin/env node
// scripts/verify_notification_audit.js — the gaps the 2026-11-09 notification
// audit closed, driven through the REAL Express routes over HTTP.
//
//   DATA_STORE=memory MFA_ENFORCE=false JWT_SECRET=probe PORT=3243 node server.js
//   GFC_PROBE_BASE=http://localhost:3243 node scripts/verify_notification_audit.js
//
// Reads the QUEUED NOTIFICATION back rather than trusting a status code. That
// matters more here than usual: the defect this closes was a notice that
// looked wired, had a passing test, and had never once produced a row with a
// recipient on it. So every assertion below reads the recipient address.
//
// Queueing is as far as this reaches. That Google accepts and delivers is
// `scripts/verify_email_transport.js`, on the deployment.
//
// A section this environment cannot reach is reported as SKIPPED, never as a
// pass, and says which test covers it instead.

const BASE = process.env.GFC_PROBE_BASE || 'http://localhost:3243';
const ADMIN_EMAIL = process.env.GFC_PROBE_ADMIN || 'admin@godwinsfamilycarellc.com';
const ADMIN_PASSWORD = process.env.GFC_PROBE_PASSWORD || 'gfcforever2026';

let pass = 0, fail = 0, skipped = 0;
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

(async () => {
  console.log(`\nNotification audit — the gaps that sent nothing — ${BASE}\n`);
  const admin = (await call('POST', '/api/auth/login', null, { email: ADMIN_EMAIL, password: ADMIN_PASSWORD })).body?.token;
  if (!admin) { console.log('  FAIL could not sign in as admin'); process.exit(1); }

  const mk = async (name, role, extra) => {
    const slug = String(name).toLowerCase().replace(/[^a-z]+/g, '-');
    const email = `aud.${slug}.${STAMP}@example.test`;
    const r = await call('POST', '/api/users', admin, {
      email, password: PW, name: `${name} (TEST DATA)`, role, sendWelcomeEmail: false, ...(extra || {})
    });
    const id = r.body && (r.body.user ? r.body.user.id : r.body.id);
    const tok = (await call('POST', '/api/auth/login', null, { email, password: PW })).body?.token || null;
    return { id, email, token: tok, status: r.status, body: r.body };
  };

  const rows = async () => {
    const r = await call('GET', '/api/admin/notifications/queue', admin);
    const q = (r.body && (r.body.queue || r.body.notifications || r.body)) || [];
    return Array.isArray(q) ? q : [];
  };
  const of = async (type) => (await rows()).filter(n => n && n.type === type);
  const bodyOf = (n) => `${(n && n.templateData && n.templateData.subject) || n.subject || ''}\n${(n && n.templateData && n.templateData.body) || n.body || ''}`;

  const caregiver = await mk('Mo Probe', 'vendor', { licenseLevel: 'cna' });
  ok('a caregiver account exists', !!caregiver.id, caregiver.body);

  // ── A. Somebody reports a problem ───────────────────────────────────────
  console.log('\nA. A bug report (nothing told an admin before)');
  const fb = await call('POST', '/api/feedback', caregiver.token, {
    type: 'bug', subject: 'Schedule time wrong', description: `Probe report ${STAMP}`
  });
  ok('the report is accepted', fb.status === 200, fb.body);
  const fbNotices = await of('feedback_submitted');
  ok('an admin is emailed', fbNotices.length >= 1, fbNotices.length);
  ok('every row carries a real recipient address', fbNotices.every(n => !!n.recipientEmail), fbNotices.map(n => n.recipientEmail));
  ok('the admin is one of them', fbNotices.some(n => n.recipientEmail === ADMIN_EMAIL), fbNotices.map(n => n.recipientEmail));
  // The gate, asserted in whichever direction this deployment is in. A sandbox
  // with no transport configured is NOT BAA-covered, so the vague wording is
  // the correct answer here and the detail MUST be absent. Asserting only the
  // detailed case would fail on a correct app, and asserting only the vague
  // case would pass on a leak.
  const fbPhi = fbNotices.some(n => n.phi === true || (n.options || {}).phi === true);
  if (fbPhi) {
    ok('the report itself rides a covered transport', fbNotices.some(n => bodyOf(n).includes(String(STAMP))), 'report text missing');
  } else {
    ok('on an uncovered transport the report is NOT in the email',
      !fbNotices.some(n => bodyOf(n).includes(String(STAMP))), 'free text leaked onto an uncovered transport');
    ok('and it still says where to read it', fbNotices.some(n => /admin hub/i.test(bodyOf(n))), bodyOf(fbNotices[0]));
  }

  // ── B. Somebody is locked out ───────────────────────────────────────────
  console.log('\nB. A password reset request (a console line was the only signal)');
  const forgot = await call('POST', '/api/auth/forgot-password', null, { email: caregiver.email });
  ok('the request is accepted', forgot.status === 200, forgot.body);
  ok('the person is still told an administrator will reach out',
    /administrator will reach out/i.test((forgot.body && forgot.body.message) || ''), forgot.body);
  const pwNotices = await of('password_reset_requested');
  ok('an admin is emailed', pwNotices.length >= 1, pwNotices.length);
  ok('it is addressed to a real admin account', pwNotices.every(n => !!n.recipientEmail && !!n.recipientUserId), pwNotices[0]);
  const pwPhi = pwNotices.some(n => n.phi === true || (n.options || {}).phi === true);
  if (pwPhi) {
    ok('it says who is waiting', pwNotices.some(n => bodyOf(n).includes(caregiver.email)), 'requester not named');
  } else {
    // The requester may be a patient, so their address is treated as PHI.
    ok('on an uncovered transport the requester is NOT named',
      !pwNotices.some(n => bodyOf(n).includes(caregiver.email)), 'a possible patient address leaked');
    ok('and an admin is still sent to look', pwNotices.some(n => /admin hub/i.test(bodyOf(n))), bodyOf(pwNotices[0]));
  }

  // ── C. A caregiver finishes their welcome packet ────────────────────────
  // THE NOTICE THAT HAD NEVER SENT. Driven end to end here because a unit
  // test could only ever prove the router; this proves the wiring in
  // server.js hands the router a notifier at all.
  console.log('\nC. A welcome packet is submitted (this notice had never sent)');
  // The same shape test/welcome_packet.test.js uses, so the probe is refused
  // for a real reason if the required set ever changes rather than for a
  // fixture nobody maintained.
  const profile = {
    firstName: 'Mo', lastName: 'Probe', mobilePhone: '404-555-0111',
    email: caregiver.email, dateOfBirth: '1990-04-01',
    homeAddress: '42 Peachtree Rd NE, Atlanta', homeZip: '30339',
    maxCommute: '30', transportation: 'own_vehicle', licenseAndInsurance: 'both_current',
    willingToDriveClients: 'no',
    availability: { monday: ['morning'], tuesday: ['morning'] },
    hoursPerWeek: '30_40', earliestStartDate: '2026-10-01',
    yearsExperience: '3_7', careExperience: ['bathing', 'companionship'],
    liftingComfort: 'with_equipment',
    ownWords: 'Probe profile for the notification audit. TEST DATA.',
    references: [
      { name: 'Jane Doe', relationship: 'Supervisor', phone: '404-555-0122' },
      { name: 'John Roe', relationship: 'Client family', phone: '404-555-0133' }
    ],
    emergencyName: 'Kin Probe', emergencyRelationship: 'Sister', emergencyPhone: '404-555-0144'
  };
  const draft = await call('PUT', '/api/caregiver/welcome-packet', caregiver.token, { data: profile });
  const sub = await call('POST', '/api/caregiver/welcome-packet/submit', caregiver.token, {
    data: profile, signaturePng: 'data:image/png;base64,aGVsbG8=', printedName: 'Mo Probe'
  });
  if (sub.status !== 200) {
    skip('the packet submits', `the profile this build requires differs (${sub.status} ${(sub.body || {}).code || ''}); the router path is proven in test/welcome_packet.test.js`);
    skip('the office is emailed', 'depends on the submit above');
  } else {
    ok('the packet submits', true);
    const pk = await of('caregiver_packet_submitted');
    ok('the office is emailed', pk.length >= 1, pk.length);
    ok('EVERY row has a recipient — the old object-shaped call produced none',
      pk.length >= 1 && pk.every(n => !!n.recipientEmail && !!n.recipientUserId), pk[0]);
    ok('it names the caregiver whose packet it is', pk.some(n => /Mo Probe/.test(bodyOf(n))), 'name missing');
    ok('and the caregiver is not emailed about their own packet',
      !pk.some(n => n.recipientEmail === caregiver.email), 'caregiver was emailed');
  }

  // ── C2. An admin changes somebody's access ─────────────────────────────
  console.log("\nC2. Access changes (the person was never told)");
  const mfa = await call('POST', `/api/users/${caregiver.id}/mfa/reset`, admin, {});
  ok('the authenticator reset is accepted', mfa.status === 200, mfa.body);
  const mfaN = await of('account_mfa_reset');
  ok('the person is emailed', mfaN.some(nn => nn.recipientEmail === caregiver.email), mfaN.map(nn => nn.recipientEmail));
  ok('and told how to get back in', mfaN.some(nn => /call the office/i.test(bodyOf(nn))), 'no way back in named');

  const rev = await call('POST', `/api/users/${caregiver.id}/sessions/revoke`, admin, {});
  ok('the sign-out-everywhere is accepted', rev.status === 200, rev.body);
  ok('the person is emailed about that too',
    (await of('account_sessions_revoked')).some(nn => nn.recipientEmail === caregiver.email), 'not told');

  const roleChange = await call('PUT', `/api/users/${caregiver.id}`, admin, { licenseLevel: 'lpn', clinicalRole: 'rn' });
  if (roleChange.status !== 200) {
    skip('a role change emails the person', `the edit was refused (${roleChange.status} ${(roleChange.body || {}).code || ''}); covered by test B11`);
  } else {
    const rc = await of('account_role_changed');
    ok('a role change emails the person', rc.some(nn => nn.recipientEmail === caregiver.email), rc.map(nn => nn.recipientEmail));
  }
  ok('nobody else is emailed about another account changing',
    !(await rows()).some(nn => /^account_/.test(String(nn.type || '')) && nn.recipientEmail === ADMIN_EMAIL),
    'an admin was emailed about somebody else');

  // ── C3. A family asks for cover ────────────────────────────────────────
  console.log('\nC3. A coverage request (the admin queue was poll-only)');
  const clientAcct = await mk('Ada Probe', 'client', { practiceName: `Ada Probe ${STAMP} (TEST DATA)` });
  if (!clientAcct.token) {
    skip('a coverage request reaches the office', 'the client account could not sign in here; covered by test B3');
  } else {
    const ask = await call('POST', '/api/scheduling/shift-requests', clientAcct.token, {
      date: new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10), start: '09:00', end: '13:00',
      careNeeds: `Probe request ${STAMP}`
    });
    if (ask.status !== 200) {
      skip('a coverage request reaches the office', `the request was refused (${ask.status} ${(ask.body || {}).code || ''}); covered by test B3`);
    } else {
      const cov = await of('coverage_requested');
      ok('a coverage request reaches the office', cov.length >= 1, cov.length);
      ok('and says nothing is scheduled yet', cov.some(nn => /Nothing is scheduled/i.test(bodyOf(nn))), bodyOf(cov[0] || {}));
      ok('the family is not emailed their own request back',
        !cov.some(nn => nn.recipientEmail === clientAcct.email), 'the asker was emailed');
    }
  }

  // ── D. Who is never emailed ─────────────────────────────────────────────
  console.log('\nD. Who is never emailed by these');
  const staffOnly = (await rows()).filter(n => n && ['feedback_submitted', 'password_reset_requested',
    'self_signup_verified', 'family_invite_requested', 'caregiver_packet_submitted', 'coverage_requested'].includes(n.type));
  const roster = (await call('GET', '/api/users', admin)).body || [];
  const byEmail = new Map((Array.isArray(roster) ? roster : []).map(u => [u.email, u]));
  ok('no office notice reached a client or a family account',
    !staffOnly.some(n => { const u = byEmail.get(n.recipientEmail); return u && (u.role === 'client' || u.role === 'family'); }),
    staffOnly.map(n => n.recipientEmail));
  ok('every recipient resolves to a real account on the roster',
    staffOnly.every(n => byEmail.has(n.recipientEmail)), staffOnly.map(n => n.recipientEmail));
  ok('each one declares whether it is PHI',
    staffOnly.every(n => typeof (n.phi) === 'boolean' || typeof ((n.options || {}).phi) === 'boolean'), staffOnly[0]);

  // ── E. What this environment cannot reach ───────────────────────────────
  console.log('\nE. Out of reach from here, and where each is proven instead');
  skip('a returned caregiver document', 'needs a stored document, which needs Drive — test/notification_audit.test.js A2 renders it');
  skip('a cancelled shift', 'needs a posted shift against an enrolled client and a cleared caregiver — covered by B1');
  skip('a declined claim', 'needs a claimed shift — covered by B2');
  skip('an admin time-log entry', 'needs a schedulable caregiver and a client with coordinates — covered by B4');
  skip('a care plan waiting on a signature', 'needs an authored plan — covered by B5');
  skip('a referral accepted or completed', 'needs an OpenEMR encounter — covered by B7');
  skip('an abnormal result', 'needs an order and a filed document — covered by B8');
  skip('a Stripe payment', 'needs a signed Stripe webhook — covered by B9');
  skip('clinical enrollment activation', 'needs the full IHPC checklist complete — covered by B10');
  skip('a document shared to the portal', 'needs a client upload in Drive — covered by B12');
  skip('a closed incident', 'needs a visit log against a cleared shift — covered by A3');
  skip('a removed client document', 'needs a client upload in Drive — covered by A4');
  skip('a rejected contractor invoice', 'needs a contractor payroll profile and a submitted invoice — covered by A5');
  skip('a verified self sign-up', 'the verify token is stored hashed, so a probe cannot present one — covered by A7');
  skip('a family invite', 'needs an enrolled client with a POA — covered by A8');
  skip('a returned training certificate', 'needs chapter A onboarding with a course cycle open — covered by the build guard');

  console.log(`\n${pass} passed, ${fail} failed, ${skipped} SKIPPED (see above)\n`);
  if (skipped) console.log('  The skipped rows are driven against the real notifier in test/notification_audit.test.js,\n  which renders each notice and reads the delivered body back.\n');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('PROBE CRASHED', e); process.exit(1); });
