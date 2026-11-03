#!/usr/bin/env node
// scripts/verify_phc_access.js — private home care access for managers and
// care coordinators (owner, 2026-11-03), driven through the REAL server.
//
//   DATA_STORE=memory MFA_ENFORCE=false JWT_SECRET=probe PORT=3231 node server.js
//   GFC_PROBE_BASE=http://localhost:3231 node scripts/verify_phc_access.js
//
// Reads stored values back rather than trusting a status code.

const BASE = process.env.GFC_PROBE_BASE || 'http://localhost:3231';
const ADMIN_EMAIL = process.env.GFC_PROBE_ADMIN || 'admin@godwinsfamilycarellc.com';
const ADMIN_PASSWORD = process.env.GFC_PROBE_PASSWORD || 'gfcforever2026';

let pass = 0, fail = 0;
const ok = (label, cond, detail) => {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail !== undefined ? `\n         ${JSON.stringify(detail).slice(0, 400)}` : ''}`); }
};
const call = async (method, path, token, body) => {
  const r = await fetch(BASE + path, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch (_) {}
  return { status: r.status, body: j, text };
};
const STAMP = Date.now();
const PW = 'Probe12345!';

(async () => {
  console.log(`\nPrivate home care access — ${BASE}\n`);
  const admin = (await call('POST', '/api/auth/login', null, { email: ADMIN_EMAIL, password: ADMIN_PASSWORD })).body?.token;
  if (!admin) { console.log('  FAIL could not sign in as admin'); process.exit(1); }

  const mk = async (token, name, accountType, extra = {}) => {
    const email = `phc.${accountType}.${name.toLowerCase().replace(/[^a-z]+/g, '')}.${STAMP}@example.test`;
    const r = await call('POST', '/api/users', token, {
      email, password: PW, name: `${name} (TEST DATA)`, accountType, sendWelcomeEmail: false,
      ...(accountType === 'client' ? { practiceName: `${name} (TEST DATA)`, enrollmentStatus: 'enrolled' } : {}),
      ...extra
    });
    return { r, id: r.body && r.body.id, email };
  };
  const login = async (email) => (await call('POST', '/api/auth/login', null, { email, password: PW })).body?.token || null;

  const mgrU = await mk(admin, 'Mary Manager', 'manager');
  const crdU = await mk(admin, 'Cora Coordinator', 'coordinator');
  const lmsU = await mk(admin, 'Courtney Social', 'lmsw');
  const mgr = await login(mgrU.email);
  const crd = await login(crdU.email);
  const lms = await login(lmsU.email);
  ok('manager, coordinator and LMSW sign in', !!(mgr && crd && lms));

  console.log('\nE — user administration');
  const cat = await call('GET', '/api/admin/clinical-roles', mgr);
  const offered = (cat.body?.accountTypes || []).map(t => t.value).sort().join(',');
  ok('the user form offers a manager only caregiver, client and family', cat.status === 200 && offered === 'caregiver,client,family', offered);
  const catAdmin = await call('GET', '/api/admin/clinical-roles', admin);
  ok('and the Super Admin all ten', (catAdmin.body?.accountTypes || []).length === 10);
  const cg = await mk(mgr, 'Danielle Carer', 'caregiver', { licenseLevel: 'cna' });
  ok('a manager creates a caregiver account', cg.r.status === 200 && cg.id, cg.r.body);
  const cl = await mk(crd, 'Juanita Client', 'client');
  ok('a coordinator creates a client account', cl.r.status === 200 && cl.id, cl.r.body);
  for (const t of ['admin', 'manager', 'coordinator', 'provider', 'rn', 'lcsw', 'lmsw']) {
    const r = (await mk(mgr, `Nope ${t}`, t)).r;
    ok(`a manager is refused a ${t} account, with the reason`, r.status === 403 && /Super Admin manages staff and clinical accounts/.test(r.body?.error || ''), r.body);
  }
  const elevate = await mk(mgr, 'Sneaky', 'caregiver', { licenseLevel: 'cna', isManager: true });
  ok('a caregiver created with the manager flag is refused', elevate.r.status === 403, elevate.r.body);
  const selfType = await call('PUT', `/api/users/${mgrU.id}`, mgr, { accountType: 'admin' });
  ok('a manager changing their own account type is refused', selfType.status === 403 && selfType.body?.code === 'USER_SELF_EDIT_FORBIDDEN', selfType.body);
  const editFnp = await call('PUT', `/api/users/${lmsU.id}`, mgr, { name: 'Renamed' });
  ok('a manager editing a clinician is refused with the reason', editFnp.status === 403 && /Super Admin/.test(editFnp.body?.error || ''), editFnp.body);
  const lmsCreate = (await mk(lms, 'From LMSW', 'caregiver', { licenseLevel: 'cna' })).r;
  ok('an LMSW cannot create accounts', lmsCreate.status === 403, lmsCreate.body);

  console.log('\nF — money is held');
  const edit = await call('PUT', `/api/users/${cg.id}`, mgr, { name: 'Danielle Carter-Smith (TEST DATA)', payRate: 22 });
  ok('a name + pay rate edit answers 200', edit.status === 200, edit.body);
  ok('and names the held field', (edit.body?.financialHeld || []).some(h => h.field === 'payRate'), edit.body);
  let users = (await call('GET', '/api/users', admin)).body || [];
  let row = users.find(u => u.id === cg.id);
  ok('the name saved', row && row.name === 'Danielle Carter-Smith (TEST DATA)', row);
  ok('the pay rate did not', row && (row.payRate === null || row.payRate === undefined), row && row.payRate);
  const q = await call('GET', `/api/users/financial-change-requests?userId=${cg.id}`, crd);
  const fr = (q.body?.requests || []).find(r => r.field === 'payRate' && r.status === 'pending');
  ok('a financial change request exists, visible to a coordinator', q.status === 200 && fr && fr.requestedValue === 22, q.body);
  const again = await call('POST', `/api/users/${cg.id}/financial-change-requests`, crd, { field: 'payRate', value: 25, reason: 'x' });
  ok('a second pending request for the same field is refused', again.status === 409, again.body);
  const mgrDecide = await call('POST', `/api/users/financial-change-requests/${fr && fr.id}/decide`, mgr, { decision: 'approved' });
  ok('a manager cannot approve it', mgrDecide.status === 403);
  const decide = await call('POST', `/api/users/financial-change-requests/${fr && fr.id}/decide`, admin, { decision: 'approved' });
  ok('the Super Admin approves it', decide.status === 200 && decide.body?.request?.status === 'approved', decide.body);
  users = (await call('GET', '/api/users', admin)).body || [];
  row = users.find(u => u.id === cg.id);
  ok('and the pay rate is now on the record', row && Number(row.payRate) === 22, row && row.payRate);

  console.log('\nA — scheduling');
  const d = new Date(Date.now() + 45 * 864e5).toISOString().slice(0, 10);
  for (const [who, tok] of [['manager', mgr], ['coordinator', crd]]) {
    const r = await call('POST', '/api/scheduling/availability', tok, { caregiverId: cg.id, effectiveFrom: d, windows: [{ day: 'Mon', start: '09:00', end: '13:00' }] });
    ok(`a ${who} records availability for the caregiver`, r.status === 200 && r.body?.availability?.caregiverId === cg.id, r.body);
  }
  const lmsAvail = await call('POST', '/api/scheduling/availability', lms, { caregiverId: cg.id, effectiveFrom: d, windows: [{ day: 'Mon', start: '09:00', end: '13:00' }] });
  ok('an LMSW no longer does', lmsAvail.status === 403, lmsAvail.body);
  const loc = await call('PUT', `/api/scheduling/clients/${cl.id}/location`, crd, { lat: 33.75, lng: -84.39 });
  ok('a coordinator sets the client location', loc.status === 200, loc.body);

  // A finished visit, entered by the Super Admin.
  const tl = await call('POST', '/api/scheduling/time-logs', admin, {
    caregiverId: cg.id, clientId: cl.id, clockInAt: '2026-10-20T13:00:00Z', clockOutAt: '2026-10-20T17:00:00Z', reason: 'probe seed'
  });
  ok('the Super Admin enters a time log', tl.status === 200, tl.body);
  const tlId = tl.body?.timeLog?.id;
  const R = 'from=2026-10-01&to=2026-10-31';
  for (const [who, tok] of [['manager', mgr], ['coordinator', crd]]) {
    const v = await call('GET', `/api/scheduling/payroll?${R}`, tok);
    ok(`a ${who} reads payroll`, v.status === 200 && (v.body?.rows || []).some(x => x.timeLogId === tlId), v.body);
    const b = await call('GET', `/api/scheduling/billing?${R}`, tok);
    ok(`a ${who} reads billing`, b.status === 200 && (b.body?.rows || []).some(x => x.timeLogId === tlId), b.body);
    ok(`a ${who} is refused payroll.csv`, (await call('GET', `/api/scheduling/payroll.csv?${R}`, tok)).status === 403);
    ok(`a ${who} is refused billing.csv`, (await call('GET', `/api/scheduling/billing.csv?${R}`, tok)).status === 403);
  }

  console.log('\nB/C — time adjustment');
  const ar = await call('POST', `/api/scheduling/time-logs/${tlId}/adjustment-requests`, mgr, { clockOutAt: '2026-10-20T18:00:00Z', reason: 'Stayed until 2pm' });
  ok('a manager raises an adjustment request', ar.status === 200, ar.body);
  const dec = await call('POST', `/api/scheduling/adjustment-requests/${ar.body?.request?.id}/decide`, admin, { decision: 'approved' });
  ok('the Super Admin approves it', dec.status === 200, dec.body);
  const logs = (await call('GET', '/api/scheduling/time-logs', admin)).body?.timeLogs || [];
  const lg = logs.find(x => x.id === tlId);
  ok('the log carries the new time and the original', lg && lg.adjusted && lg.clockOutAt === '2026-10-20T18:00:00.000Z' && lg.originalClockOut === '2026-10-20T17:00:00.000Z', lg);
  for (const f of ['payroll.csv', 'billing.csv']) {
    const csv = await call('GET', `/api/scheduling/${f}?${R}`, admin);
    const lines = csv.text.trim().split(/\r?\n/);
    const heads = lines[0].split(',');
    const line = lines.find(l => l.includes('Danielle Carter-Smith'));
    const cells = line ? line.split(',') : [];
    ok(`${f}: adjusted = yes, the caregiver is still the subject`,
      line && cells[heads.indexOf('Adjusted')] === 'yes' && cells[heads.indexOf('Caregiver')].includes('Danielle Carter-Smith') && cells[heads.indexOf('Original Hours')] === '4',
      { heads, line });
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
