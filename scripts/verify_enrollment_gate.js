#!/usr/bin/env node
// ============================================================================
// VERIFY: the enrollment gate on scheduling  (owner decision, 2026-09-13)
// ============================================================================
// Run against a RUNNING app:
//   DATA_STORE=memory JWT_SECRET=... PORT=3199 node server.js
//   GFC_PROBE_BASE=http://localhost:3199 node scripts/verify_enrollment_gate.js
//
// Every assertion reads the STORED ROW back through the API, never a status
// code. A 200 that wrote nothing is the trap this repo has now been caught by
// six times on the OpenEMR side, and a gate is exactly the kind of thing that
// looks fine from the caller's seat while doing nothing at all.

const BASE = process.env.GFC_PROBE_BASE || 'http://localhost:3199';
const ADMIN_EMAIL = process.env.GFC_PROBE_ADMIN || 'admin@godwinsfamilycarellc.com';
const ADMIN_PASSWORD = process.env.GFC_PROBE_PASSWORD || 'gfcforever2026';
let pass = 0, fail = 0;
const ok = (label, cond, detail) => {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail ? `\n         ${JSON.stringify(detail)}` : ''}`); }
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

(async () => {
  const login = await call('POST', '/api/auth/login', null,
    { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  const token = login.body && login.body.token;
  if (!token) { console.log('LOGIN FAILED', login.status, login.body); process.exit(1); }
  console.log('\n--- setup ---');
  const made = await call('POST', '/api/users', token, {
    email: `gate.probe.${Date.now()}@example.com`, password: 'Probe12345!', name: 'Gate Probe Client',
    role: 'client', practiceName: 'Gate Probe Client'
  });
  const clientId = made.body && (made.body.user ? made.body.user.id : made.body.id);
  const usersNow = await call('GET', '/api/users', token);
  const stored = (usersNow.body.users || usersNow.body || []).find(u => u.id === clientId);
  ok('a new client is stored at intake_pending',
    !!stored && stored.enrollmentStatus === 'intake_pending', stored && stored.enrollmentStatus);

  const shift = (extra) => ({
    clientId, start: '2026-12-01T14:00:00.000Z', end: '2026-12-01T18:00:00.000Z',
    requiredLicenseLevel: 'any', poolVisibility: 'all_eligible', ...extra
  });

  console.log('\n--- the gate refuses ---');
  const r1 = await call('POST', '/api/scheduling/shifts', token, shift());
  ok('posting a shift for a non-enrolled client is refused', r1.status === 409, r1.body);
  ok('  with CLIENT_NOT_ENROLLED', r1.body.code === 'CLIENT_NOT_ENROLLED', r1.body);
  ok('  naming the client and what is missing', /Gate Probe Client/.test(r1.body.error || ''), r1.body);
  ok('  and telling an admin an override exists', r1.body.overridable === true, r1.body);

  const after1 = await call('GET', '/api/scheduling/shifts', token);
  const mine = () => (after1.body.shifts || []).filter(s => s.clientId === clientId);
  ok('  and NOTHING was written', mine().length === 0, after1.body.shifts);

  const r2 = await call('POST', '/api/scheduling/shifts', token, shift({ override: true }));
  ok('an override with no reason is refused', r2.status === 400 && r2.body.code === 'OVERRIDE_REASON_REQUIRED', r2.body);

  console.log('\n--- the override goes through, loudly ---');
  const r3 = await call('POST', '/api/scheduling/shifts', token,
    shift({ override: true, overrideReason: 'Hospital discharge Monday; consents signing at the first visit.' }));
  ok('an admin override posts the shift', r3.status === 200, r3.body);
  const list = await call('GET', '/api/scheduling/shifts', token);
  const row = (list.body.shifts || []).find(s => s.clientId === clientId);
  ok('  the shift is really stored', !!row, list.body.shifts && list.body.shifts.length);
  ok('  the STORED row carries the override', !!(row && row.enrollmentOverride), row);
  ok('  with the reason on it', !!(row && row.enrollmentOverride &&
    /Hospital discharge/.test(row.enrollmentOverride.reason)), row && row.enrollmentOverride);
  ok('  and the status it overrode, frozen',
    !!(row && row.enrollmentOverride && row.enrollmentOverride.enrollmentStatus === 'intake_pending'),
    row && row.enrollmentOverride);
  ok('  and who did it', !!(row && row.enrollmentOverride && row.enrollmentOverride.byName), row && row.enrollmentOverride);

  console.log('\n--- an enrolled client needs none of it ---');
  await call('PUT', `/api/users/${clientId}`, token, { enrollmentStatus: 'enrolled' });
  const r4 = await call('POST', '/api/scheduling/shifts', token,
    shift({ start: '2026-12-02T14:00:00.000Z', end: '2026-12-02T18:00:00.000Z' }));
  ok('an enrolled client schedules with no override at all', r4.status === 200, r4.body);
  const list2 = await call('GET', '/api/scheduling/shifts', token);
  const clean = (list2.body.shifts || []).find(s => s.clientId === clientId && s.start.startsWith('2026-12-02'));
  ok('  and the stored row carries NO override stamp',
    !!clean && clean.enrollmentOverride === null, clean && clean.enrollmentOverride);

  console.log('\n--- the forced status left a trace ---');
  const acts = await call('GET', '/api/admin/activity-log?limit=300', token);
  const rows = ((acts.body || {}).activities || (acts.body || {}).logs || (Array.isArray(acts.body) ? acts.body : []));
  const forced = (Array.isArray(rows) ? rows : []).find(a => a && a.action === 'enrollment_status_forced');
  ok('setting enrolled on the user form over an incomplete checklist is logged', !!forced, {
    sample: (Array.isArray(rows) ? rows.slice(0, 3).map(a => a && a.action) : rows)
  });

  console.log('\n--- asking is free; committing is what is gated ---');
  // A FRESH client: the one above was flipped to enrolled two steps ago, and a
  // probe that reuses it would assert the not-enrolled case against an enrolled
  // record and pass for the wrong reason.
  const askC = await call('POST', '/api/users', token, {
    email: `gate.probe3.${Date.now()}@example.com`, password: 'Probe12345!', name: 'Request Probe Client',
    role: 'client', practiceName: 'Request Probe Client'
  });
  const askId = askC.body && (askC.body.user ? askC.body.user.id : askC.body.id);
  const rq = await call('POST', '/api/scheduling/shift-requests', token, {
    clientId: askId, date: '2026-12-05', start: '09:00', end: '13:00',
    careNeeds: 'Mornings, help with bathing and breakfast.'
  });
  ok('a not-yet-enrolled client can still have a shift REQUESTED', rq.status === 200, rq.body);
  const rlist = await call('GET', '/api/scheduling/shift-requests', token);
  const rrow = ((rlist.body || {}).shiftRequests || []).find(r => r.client_id === askId);
  ok('  the request is really stored', !!rrow, rlist.body);
  ok('  and carries the enrollment state as it stood when they asked',
    !!rrow && rrow.client_enrollment_ok === false, rrow && rrow.client_enrollment_ok);
  ok('  with the reason, so the queue is not blind',
    !!rrow && /not completed enrollment|not been approved/.test(rrow.client_enrollment_note || ''),
    rrow && rrow.client_enrollment_note);
  ok('  and the care needs survived', !!rrow && /bathing/.test(rrow.care_needs || ''), rrow && rrow.care_needs);

  console.log('\n--- the approval override ---');
  const c2 = await call('POST', '/api/users', token, {
    email: `gate.probe2.${Date.now()}@example.com`, password: 'Probe12345!', name: 'Approval Probe Client',
    role: 'client', practiceName: 'Approval Probe Client'
  });
  const id2 = c2.body && (c2.body.user ? c2.body.user.id : c2.body.id);

  const a1 = await call('POST', `/api/gfc/admin/enrollment/${id2}/approve`, token, {});
  ok('approving an incomplete file is refused', a1.status === 409 && a1.body.code === 'ENROLLMENT_INCOMPLETE', a1.body);
  ok('  naming what is missing', (a1.body.missingConsents || []).length > 0, a1.body);
  ok('  and offering the override', a1.body.overridable === true, a1.body);

  const a2 = await call('POST', `/api/gfc/admin/enrollment/${id2}/approve`, token, { override: true });
  ok('an override with no reason is refused', a2.status === 400 && a2.body.code === 'OVERRIDE_REASON_REQUIRED', a2.body);

  const a3 = await call('POST', `/api/gfc/admin/enrollment/${id2}/approve`, token,
    { override: true, overrideReason: 'Starting care Monday; packet signing at the first visit.' });
  ok('the override approves', a3.status === 200, a3.body);

  const det = await call('GET', `/api/gfc/admin/enrollment/${id2}`, token);
  const appr = det.body && det.body.client && det.body.client.enrollmentApproval;
  ok('  the STORED record shows the client is enrolled',
    !!(det.body && det.body.client && det.body.client.enrollmentStatus === 'enrolled'),
    det.body && det.body.client && det.body.client.enrollmentStatus);
  ok('  and carries the override, visible in the detail view', !!(appr && appr.override), appr);
  ok('  with the reason', !!(appr && appr.override && /Starting care Monday/.test(appr.override.reason)), appr && appr.override);
  ok('  and what was outstanding, frozen onto it',
    !!(appr && appr.override && (appr.override.missingConsents || []).length > 0), appr && appr.override);

  const s3 = await call('POST', '/api/scheduling/shifts', token, {
    clientId: id2, start: '2026-12-03T14:00:00.000Z', end: '2026-12-03T18:00:00.000Z',
    requiredLicenseLevel: 'any', poolVisibility: 'all_eligible'
  });
  ok('and an overridden approval really does unlock scheduling', s3.status === 200, s3.body);

  console.log(`\n${pass}/${pass + fail} assertions passed\n`);
  process.exit(fail ? 1 : 0);
})();
