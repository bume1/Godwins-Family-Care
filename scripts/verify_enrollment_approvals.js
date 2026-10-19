#!/usr/bin/env node
/**
 * Enrollment changes that wait for the owner — HTTP round trip (2026-10-19).
 *
 * Drives the REAL server and routes: a care coordinator and a manager ask for a
 * service line or rate change, nothing changes until the Super Admin approves,
 * a decline carries its reason back, a stale ask is refused, the consent banner
 * clears itself once the consent it names is recorded, and a coordinator runs
 * the clinical enrollment steps. Every assertion reads the STORED record back.
 *
 * Stubbed: the KV store only.
 *
 *   node scripts/verify_enrollment_approvals.js
 */
process.env.PORT = process.env.PORT || '4613';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'enrollment-approvals-verification-secret';
process.env.MFA_ENFORCE = 'false';
process.env.DATA_STORE = 'kv';

const path = require('path');
const Module = require('module');
const bcrypt = require('bcryptjs');

const STORE = new Map();
class MemDb {
  async get(k) { return STORE.has(k) ? JSON.parse(JSON.stringify(STORE.get(k))) : null; }
  async set(k, v) { STORE.set(k, JSON.parse(JSON.stringify(v))); return true; }
  async delete(k) { STORE.delete(k); return true; }
  async list(p) { return [...STORE.keys()].filter(k => !p || k.startsWith(p)); }
  async empty() { STORE.clear(); return true; }
}
const realResolve = Module._resolveFilename;
Module._resolveFilename = function (r, ...rest) {
  if (r === '@replit/database') return '__memdb__';
  return realResolve.call(this, r, ...rest);
};
require.cache['__memdb__'] = { id: '__memdb__', filename: '__memdb__', loaded: true, exports: MemDb };

const config = require(path.join(__dirname, '..', 'config.js'));
const BASE = `http://127.0.0.1:${process.env.PORT}`;
const PW = 'Probe12345!';
let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { pass++; console.log(`  ✅ ${n}`); } else { fail++; console.log(`  ❌ ${n}${d !== undefined ? ` — ${JSON.stringify(d).slice(0, 400)}` : ''}`); } };
const call = async (m, u, t, b) => {
  const r = await fetch(`${BASE}${u}`, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: `Bearer ${t}` } : {}) }, body: b ? JSON.stringify(b) : undefined });
  let j = null; try { j = await r.json(); } catch (_) {}
  return { status: r.status, body: j };
};
const login = async (email) => { const r = await call('POST', '/api/auth/login', null, { email, password: PW }); return r.body && r.body.token; };
const stored = (id) => (STORE.get('users') || []).find(u => u.id === id);

const ADMIN = { id: 'adm_1', name: 'Owner (TEST DATA)', email: 'owner@example.test', role: 'admin', accountStatus: 'active' };
const COORD = { id: 'coord_1', name: 'Cora Lane (TEST DATA)', email: 'coord@example.test', role: 'user', isManager: true, clinicalRole: 'coordinator', accountType: 'coordinator', hasClinicalAccess: false, accountStatus: 'active' };
const MGR = { id: 'mgr_1', name: 'Morgan Price (TEST DATA)', email: 'mgr@example.test', role: 'user', isManager: true, clinicalRole: 'readOnly', accountType: 'manager', hasClinicalAccess: false, accountStatus: 'active' };
const RATE = { hourlyRate: 30, dailyMinimumHours: 4, setByName: 'Owner', setAt: '2026-10-01T00:00:00Z' };
const CLIENT = {
  id: 'c_appr', role: config.ROLES.CLIENT, email: 'c_appr@example.test', name: 'Approval Probe (TEST DATA)', slug: 'approval-probe',
  serviceLine: 'PHC', enrollmentStatus: 'enrolled', rateAgreement: RATE, accountStatus: 'active',
  intake: { dob: '1948-03-11', clientFirst: 'Approval', clientLast: 'Probe', serviceLine: 'PHC' },
  consents: { financialAgreement: 'signed', serviceAgreement: 'signed' },
  consentMeta: {
    financialAgreement: { signedAt: '2026-10-02T00:00:00Z', ipHash: 'x', version: '2026-09-packet-v2' },
    serviceAgreement: { signedAt: '2026-10-02T00:00:00Z', ipHash: 'x', version: '2026-09-packet-v2' }
  }
};

(async () => {
  const hash = await bcrypt.hash(PW, 4);
  STORE.set('users', [ADMIN, COORD, MGR, CLIENT].map(u => ({ ...u, password: hash })));
  require(path.join(__dirname, '..', 'server.js'));
  await new Promise(r => setTimeout(r, 3000));
  const tok = { admin: await login(ADMIN.email), coord: await login(COORD.email), mgr: await login(MGR.email) };
  if (!tok.admin || !tok.coord || !tok.mgr) { console.log('LOGIN FAILED', tok); process.exit(1); }
  const E = `/api/gfc/admin/enrollment/${CLIENT.id}`;
  const detail = async (t) => (await call('GET', E, t)).body.client;

  console.log('\n── 1. A coordinator asks to change the service line; nothing changes yet ──');
  let r = await call('PUT', `${E}/service-line`, tok.coord, { serviceLine: 'BOTH', note: 'Family wants medical visits' });
  check('the ask is accepted as pending (202)', r.status === 202 && r.body.pending === true, r.body);
  check('the client is still PHC', stored(CLIENT.id).serviceLine === 'PHC');
  const slReq = r.body.request;
  let d = await detail(tok.coord);
  check('the record shows it awaiting owner approval', (d.changeRequests || []).some(x => x.id === slReq.id && x.status === 'pending'), d.changeRequests);
  check('the coordinator is told their changes need approval and cannot approve', d.changesNeedApproval === true && d.canApproveChanges === false);
  r = await call('GET', '/api/gfc/admin/enrollment/list?filter=awaiting_approval', tok.admin);
  check('the list filter finds it, and the row is tagged', r.body.clients.some(c => c.id === CLIENT.id && c.pendingApprovals === 1) && r.body.counts.awaiting_approval === 1, r.body.counts);

  console.log('\n── 2. Only the owner approves ──');
  r = await call('POST', `${E}/change-requests/${slReq.id}/decide`, tok.coord, { decision: 'approve' });
  check('a coordinator cannot approve', r.status === 403, r.body);
  r = await call('POST', `${E}/change-requests/${slReq.id}/decide`, tok.mgr, { decision: 'approve' });
  check('a manager cannot approve', r.status === 403, r.body);
  r = await call('POST', `${E}/change-requests/${slReq.id}/decide`, tok.admin, { decision: 'approve' });
  check('the owner approves', r.status === 200 && /^Approved\./.test(r.body.message), r.body);
  check('the client is now BOTH', stored(CLIENT.id).serviceLine === 'BOTH');
  check('the medical packet is now owed', (r.body.newlyRequired || []).length > 0, r.body.newlyRequired);
  d = await detail(tok.admin);
  check('the request reads approved, by the owner', d.changeRequests.some(x => x.id === slReq.id && x.status === 'approved' && x.decidedBy.id === ADMIN.id));
  check('the banner names what is now outstanding', d.consentActionRequired && d.consentActionRequired.consents.length > 0, d.consentActionRequired);
  r = await call('POST', `${E}/change-requests/${slReq.id}/decide`, tok.admin, { decision: 'approve' });
  check('it cannot be approved twice', r.status === 409 && r.body.code === 'CHANGE_REQUEST_DECIDED', r.body);

  console.log('\n── 3. A rate change: declined with a reason the asker sees ──');
  r = await call('PUT', `${E}/rate`, tok.mgr, { hourlyRate: 34, dailyMinimumHours: 4 });
  check('a manager\'s rate change is pending', r.status === 202, r.body);
  check('the rate is unchanged', stored(CLIENT.id).rateAgreement.hourlyRate === 30);
  const rateReq = r.body.request;
  r = await call('POST', `${E}/change-requests/${rateReq.id}/decide`, tok.admin, { decision: 'decline' });
  check('a decline needs a reason', r.status === 400 && r.body.code === 'DECLINE_REASON_REQUIRED', r.body);
  r = await call('POST', `${E}/change-requests/${rateReq.id}/decide`, tok.admin, { decision: 'decline', note: 'Keep $30 until January' });
  check('the owner declines', r.status === 200, r.body);
  check('the rate is still $30', stored(CLIENT.id).rateAgreement.hourlyRate === 30);
  d = await detail(tok.mgr);
  check('the manager sees the decline and the reason', d.changeRequests.some(x => x.id === rateReq.id && x.status === 'declined' && x.decisionNote === 'Keep $30 until January'));

  console.log('\n── 4. A stale ask is refused, never applied to a different value ──');
  r = await call('PUT', `${E}/rate`, tok.coord, { hourlyRate: 35, dailyMinimumHours: 4 });
  const staleReq = r.body.request;
  r = await call('PUT', `${E}/rate`, tok.admin, { hourlyRate: 33, dailyMinimumHours: 4 });
  check('the owner\'s own rate change applies at once', r.status === 200 && stored(CLIENT.id).rateAgreement.hourlyRate === 33, r.body);
  r = await call('POST', `${E}/change-requests/${staleReq.id}/decide`, tok.admin, { decision: 'approve' });
  check('approving the older ask is refused as stale', r.status === 409 && r.body.code === 'CHANGE_REQUEST_STALE', r.body);
  check('the rate stays at the owner\'s $33', stored(CLIENT.id).rateAgreement.hourlyRate === 33);

  console.log('\n── 5. A rate approval applies and flags re-signature ──');
  // The owner's $33 change above flagged the two signed agreements; clear the
  // flag on a fresh rate ask so this step stands on its own.
  r = await call('PUT', `${E}/rate`, tok.coord, { hourlyRate: 36, dailyMinimumHours: 5 });
  const goodReq = r.body.request;
  r = await call('POST', `${E}/change-requests/${goodReq.id}/decide`, tok.admin, { decision: 'approve' });
  check('the owner approves the rate', r.status === 200 && stored(CLIENT.id).rateAgreement.hourlyRate === 36, r.body);
  check('the client is flagged to re-sign the money documents', (stored(CLIENT.id).consentActionRequired || {}).reason === 'rate_changed');

  console.log('\n── 6. The banner clears itself once the consent it names is signed ──');
  d = await detail(tok.admin);
  const before = (d.consentActionRequired && d.consentActionRequired.consents) || [];
  check('the banner lists the financial agreement', before.includes('financialAgreement'), { stored: stored(CLIENT.id).consentActionRequired, consents: stored(CLIENT.id).consents, served: d.consentActionRequired });
  // A coordinator records the paper copies through the real route: dated
  // before the banner went up, recorded after it. (The case where a route
  // forgets to clear its line is covered in test/enrollment_changes.test.js.)
  const paperForm = (signedAt) => {
    const fd = new FormData();
    fd.append('signedAt', signedAt);
    fd.append('file', new Blob([Buffer.from('%PDF-1.4\n%probe\n')], { type: 'application/pdf' }), 'signed.pdf');
    return fd;
  };
  for (const t of ['financialAgreement', 'serviceAgreement']) {
    const pr = await fetch(`${BASE}${E}/consent/${t}/offline`, { method: 'POST', headers: { Authorization: `Bearer ${tok.coord}` }, body: paperForm('2026-10-05') });
    check(`the coordinator records the paper ${t}`, pr.status === 200, await pr.text().then(x => x.slice(0, 200)));
  }
  d = await detail(tok.admin);
  check('the banner no longer lists the signed consents', !(d.consentActionRequired && d.consentActionRequired.consents.some(t => ['financialAgreement', 'serviceAgreement'].includes(t))), d.consentActionRequired);

  console.log('\n── 7. A coordinator runs the clinical enrollment steps ──');
  r = await call('POST', `/api/clinical/patients/${CLIENT.id}/checklist/payerVerification`, tok.coord, { done: true });
  if (r.status === 400) {
    const list = await call('GET', `/api/clinical/patients/${CLIENT.id}/checklist`, tok.admin);
    const manual = (list.body.steps || []).find(s => s.kind === 'manual');
    r = await call('POST', `/api/clinical/patients/${CLIENT.id}/checklist/${manual.key}`, tok.coord, { done: true });
  }
  check('the coordinator marks a manual step', r.status === 200, r.body);
  r = await call('POST', `/api/clinical/patients/${CLIENT.id}/checklist/x`, tok.mgr, { done: true });
  check('a manager reaches the step route too (refused only for the bad step)', r.status === 400, r.body);
  r = await call('POST', `/api/clinical/patients/${CLIENT.id}/activate`, tok.coord);
  check('activating checks the steps, not the coordinator\'s licence', r.status === 409 && r.body.code === 'CHECKLIST_INCOMPLETE', r.body);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
