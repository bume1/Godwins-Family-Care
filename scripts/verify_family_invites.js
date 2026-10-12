#!/usr/bin/env node
/**
 * Family & Caregivers invites (portal redesign, owner 2026-10-12).
 *
 *   - The patient or their POA invites someone; plain family cannot.
 *   - The invite is only a request: nothing can sign in until an ADMIN approves.
 *   - Approving makes a plain family account linked to this client, never a POA.
 *   - A decline needs a reason, and the patient sees it.
 *
 * Runs the REAL server and routes with an in-memory store. Welcome emails are
 * captured, not sent. Assertions read stored state back.
 *
 *   node scripts/verify_family_invites.js
 */
process.env.PORT = process.env.PORT || '4613';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'family-invite-verification-secret';
process.env.AUTO_CHANGELOG = 'false';
process.env.MFA_ENFORCE = 'false';

const path = require('path');
const Module = require('module');
const STORE = new Map();
class MemDb {
  async get(k) { return STORE.has(k) ? JSON.parse(JSON.stringify(STORE.get(k))) : null; }
  async set(k, v) { STORE.set(k, JSON.parse(JSON.stringify(v))); return true; }
  async delete(k) { STORE.delete(k); return true; }
  async list(prefix) { return [...STORE.keys()].filter(k => !prefix || k.startsWith(prefix)); }
  async empty() { STORE.clear(); return true; }
}
const realResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === '@replit/database') return '__memdb__';
  return realResolve.call(this, request, ...rest);
};
require.cache['__memdb__'] = { id: '__memdb__', filename: '__memdb__', loaded: true, exports: MemDb };

const jwt = require('jsonwebtoken');
const config = require(path.join(__dirname, '..', 'config.js'));
const BASE = `http://127.0.0.1:${process.env.PORT}`;
let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
};
const tok = (u) => {
  const sid = `sess_${u.id}`;
  const at = new Date().toISOString();
  STORE.set(`auth_session:${sid}`, { id: sid, userId: u.id, role: u.role, createdAt: at, lastSeenAt: at, absoluteExpiresAt: null, revokedAt: null, revokedReason: null, ipHash: null, userAgent: null, mfaVerified: true, surface: null });
  return jwt.sign({ id: u.id, email: u.email, name: u.name, role: u.role, sid }, process.env.JWT_SECRET, { expiresIn: '1h' });
};
const call = async (method, url, token, body) => {
  const res = await fetch(`${BASE}${url}`, { method, headers: Object.assign({ Authorization: `Bearer ${token || ''}` }, body ? { 'Content-Type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

const CLIENT = { id: 'client_fam_1', role: config.ROLES.CLIENT, email: 'fampatient@example.test', name: 'Fam Patient', slug: 'fam-patient', serviceLine: 'PHC', enrollmentStatus: 'enrolled', consents: { roiFamily: 'signed' }, intake: {} };
const OTHER = { id: 'client_fam_2', role: config.ROLES.CLIENT, email: 'other@example.test', name: 'Other Patient', slug: 'other-patient', serviceLine: 'PHC', enrollmentStatus: 'enrolled', consents: {}, intake: {} };
const POA = { id: 'poa_fam_1', role: config.ROLES.FAMILY, email: 'poa@example.test', name: 'Pat Poa', familyOfClientId: CLIENT.id, familyIsPoa: true };
const COUSIN = { id: 'fam_fam_1', role: config.ROLES.FAMILY, email: 'cousin@example.test', name: 'Cee Cousin', familyOfClientId: CLIENT.id, familyIsPoa: false };
const ADMIN = { id: 'admin_fam_1', role: config.ROLES.ADMIN, email: 'famadmin@example.test', name: 'Fam Admin' };
const CM = { id: 'cm_fam_1', role: 'caseManager', email: 'famcm@example.test', name: 'Fam CM' };

(async () => {
  STORE.set('users', [CLIENT, OTHER, POA, COUSIN, ADMIN, CM]);
  const server = require(path.join(__dirname, '..', 'server.js'));
  await new Promise(r => setTimeout(r, 2500));
  const ct = tok(CLIENT), pt = tok(POA), ft = tok(COUSIN), at = tok(ADMIN), cmt = tok(CM), ot = tok(OTHER);
  const invites = () => STORE.get('family_invites') || [];

  console.log('\n── Who can invite ──');
  let r = await call('POST', '/api/gfc/family/invites', ft, { name: 'Sneaky', email: 'sneaky@example.test', relationship: 'Friend' });
  check('plain family cannot invite (403), and nothing is written', r.status === 403 && invites().length === 0, JSON.stringify(r.body));
  r = await call('POST', '/api/gfc/family/invites', ct, { name: 'Dana Daughter', email: 'Dana@Example.test', relationship: 'Child', saysPoa: true });
  check('the patient invites someone', r.status === 200 && r.body.invite && r.body.invite.status === 'pending', JSON.stringify(r.body));
  const inv1 = r.body.invite && r.body.invite.id;
  check('the email is stored lowercased', invites()[0] && invites()[0].email === 'dana@example.test');
  r = await call('POST', '/api/gfc/family/invites', pt, { name: 'Sam Son', email: 'sam@example.test', relationship: 'Child' });
  check('a POA invites someone too', r.status === 200);
  const inv2 = r.body.invite && r.body.invite.id;
  r = await call('POST', '/api/gfc/family/invites', ct, { name: 'Dana again', email: 'dana@example.test', relationship: 'Child' });
  check('a second invite for the same email is refused', r.status === 409 && r.body.code === 'INVITE_DUPLICATE');
  r = await call('POST', '/api/gfc/family/invites', ct, { name: 'Cee', email: 'COUSIN@example.test', relationship: 'Other relative' });
  check('an email that already has an account is refused', r.status === 409 && r.body.code === 'INVITE_EMAIL_IN_USE');
  r = await call('POST', '/api/gfc/family/invites', ct, { name: 'X', email: 'x@example.test', relationship: 'Neighbour' });
  check('a relationship not on the list is refused by name', r.status === 400 && r.body.code === 'INVITE_RELATIONSHIP_INVALID');

  console.log('\n── Nothing can sign in until an admin approves ──');
  const users0 = STORE.get('users');
  check('no account exists for the invited email', !users0.some(u => u.email === 'dana@example.test'));

  console.log('\n── What each person sees ──');
  r = await call('GET', '/api/gfc/family', ct);
  check('the patient sees the people with access and their open invites', r.status === 200 && r.body.people.length === 2 && r.body.invites.length === 2 && r.body.canManage === true);
  check('the POA reads as full access', (r.body.people.find(p => p.id === POA.id) || {}).access === 'Full access (Power of Attorney)');
  r = await call('GET', '/api/gfc/family', ft);
  check('plain family see who has access, but no invites and cannot manage', r.status === 200 && r.body.invites.length === 0 && r.body.canManage === false);

  console.log('\n── Staff ──');
  r = await call('GET', `/api/gfc/admin/enrollment/${CLIENT.id}/family-invites`, cmt);
  check('a case manager reads the invites', r.status === 200 && r.body.invites.length === 2);
  r = await call('POST', `/api/gfc/admin/enrollment/${CLIENT.id}/family-invites/${inv1}/decide`, cmt, { decision: 'approved' });
  check('a case manager cannot approve', r.status === 403);
  r = await call('POST', `/api/gfc/admin/enrollment/${OTHER.id}/family-invites/${inv1}/decide`, at, { decision: 'approved' });
  check('an invite cannot be approved under another client', r.status === 404);
  r = await call('POST', `/api/gfc/admin/enrollment/${CLIENT.id}/family-invites/${inv1}/decide`, at, { decision: 'approved' });
  check('an admin approves', r.status === 200 && r.body.userId);
  const made = (STORE.get('users') || []).find(u => u.email === 'dana@example.test');
  check('approving made a family account linked to this client', made && made.role === config.ROLES.FAMILY && made.familyOfClientId === CLIENT.id);
  check('and NOT a POA, though the patient said so', made && made.familyIsPoa === false);
  check('with the relationship carried over', made && made.familyRelationship === 'Child');
  check('and a hashed password, never the plain one', made && /^\$2[aby]\$/.test(made.password));
  r = await call('POST', `/api/gfc/admin/enrollment/${CLIENT.id}/family-invites/${inv1}/decide`, at, { decision: 'approved' });
  check('an answered invite cannot be answered again', r.status === 409 && r.body.code === 'INVITE_NOT_PENDING');
  r = await call('POST', `/api/gfc/admin/enrollment/${CLIENT.id}/family-invites/${inv2}/decide`, at, { decision: 'declined' });
  check('a decline needs a reason', r.status === 400 && r.body.code === 'INVITE_DECLINE_REASON_REQUIRED');
  r = await call('POST', `/api/gfc/admin/enrollment/${CLIENT.id}/family-invites/${inv2}/decide`, at, { decision: 'declined', reason: 'We could not reach Sam to confirm.' });
  check('an admin declines with a reason', r.status === 200);
  r = await call('GET', '/api/gfc/family', ct);
  check('the patient sees the decline and its reason', (r.body.invites.find(i => i.id === inv2) || {}).declineReason === 'We could not reach Sam to confirm.');
  check('the approved person now shows under who has access', r.body.people.some(p => p.name === 'Dana Daughter'));
  check('and the patient is never told which staff member decided', !JSON.stringify(r.body).includes('Fam Admin'));

  console.log('\n── Cancel ──');
  r = await call('POST', '/api/gfc/family/invites', ct, { name: 'Gina Grand', email: 'gina@example.test', relationship: 'Grandchild' });
  const inv3 = r.body.invite.id;
  r = await call('POST', `/api/gfc/family/invites/${inv3}/cancel`, ot);
  check('another client cannot cancel it', r.status === 404);
  r = await call('POST', `/api/gfc/family/invites/${inv3}/cancel`, ct);
  check('the patient cancels their own invite', r.status === 200 && r.body.invite.status === 'cancelled');

  console.log('\n── Profile ──');
  r = await call('GET', '/api/gfc/profile', ct);
  check('the patient reads their profile', r.status === 200 && Array.isArray(r.body.coverage));
  r = await call('GET', '/api/gfc/profile', pt);
  check('a POA reads it', r.status === 200);
  r = await call('GET', '/api/gfc/profile', ft);
  check('plain family cannot', r.status === 403 && r.body.code === 'PROFILE_CLIENT_ONLY');

  console.log('\n── The audit trail names no one ──');
  const acts = JSON.stringify(STORE.get('activity_log') || []);
  check('activity rows never carry the invited email', !acts.includes('dana@example.test') && !acts.includes('gina@example.test'));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
