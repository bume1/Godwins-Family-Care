#!/usr/bin/env node
/**
 * Self sign-up (owner, 2026-10-12): a sign-up is a request, never an account.
 *
 *   - The form creates nothing that can sign in. The email is confirmed first.
 *   - Signing in before approval says where the request stands, but only to
 *     someone who knows its password.
 *   - An ADMIN approves as a new client, links as family of a client on file,
 *     or declines with a reason. Approved accounts start at intake_pending.
 *   - A sign-up for a loved one makes a client record with no login, plus a
 *     family account for the person who signed up. Never a POA.
 *   - The public routes answer the same whether or not an email is known.
 *
 * Runs the REAL server and routes with an in-memory store. Emails are captured.
 *   node scripts/verify_self_signup.js
 */
process.env.PORT = process.env.PORT || '4617';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'self-signup-verification-secret';
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
// Capture outgoing email instead of sending it.
const SENT = [];
const email = require(path.join(__dirname, '..', 'email.js'));
email.sendEmail = async (to, subject, text, opts) => { SENT.push({ to, subject, text, html: opts && opts.htmlBody }); return { success: true }; };

const jwt = require('jsonwebtoken');
const config = require(path.join(__dirname, '..', 'config.js'));
const BASE = `http://127.0.0.1:${process.env.PORT}`;
let pass = 0, fail = 0;
const check = (name, cond, detail) => { if (cond) { pass++; console.log(`  ✅ ${name}`); } else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); } };
const tok = (u) => {
  const sid = `sess_${u.id}`; const at = new Date().toISOString();
  STORE.set(`auth_session:${sid}`, { id: sid, userId: u.id, role: u.role, createdAt: at, lastSeenAt: at, absoluteExpiresAt: null, revokedAt: null, revokedReason: null, ipHash: null, userAgent: null, mfaVerified: true, surface: null });
  return jwt.sign({ id: u.id, email: u.email, name: u.name, role: u.role, sid }, process.env.JWT_SECRET, { expiresIn: '1h' });
};
const call = async (method, url, token, body, headers) => {
  const res = await fetch(`${BASE}${url}`, { method, headers: Object.assign({}, token ? { Authorization: `Bearer ${token}` } : {}, body ? { 'Content-Type': 'application/json' } : {}, headers || {}), body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const tokenFrom = (m) => { const x = /verify=([a-f0-9]{48})/.exec(m && m.text || ''); return x && x[1]; };

const ADMIN = { id: 'admin_su', role: config.ROLES.ADMIN, email: 'suadmin@example.test', name: 'SU Admin' };
const CM = { id: 'cm_su', role: 'caseManager', email: 'sucm@example.test', name: 'SU CM' };
const EXISTING = { id: 'client_su_1', role: config.ROLES.CLIENT, email: 'juanita@example.test', name: 'Juanita Guess', slug: 'juanita-guess', enrollmentStatus: 'enrolled', intake: { lastName: 'Guess', dob: '1941-03-02' } };

const base = (over) => Object.assign({
  name: 'Jordan Smith', dob: '1960-05-01', email: 'jordan@example.test', phone: '(404) 555-0100', password: 'correct horse 1',
  who: 'self', address: { line1: '1 Main St', city: 'Marietta', state: 'ga', zip: '30060' }, interests: ['home_care', 'primary_care'],
  coverage: 'Medicare', memberId: '1EG4TE5MK72', agreeTerms: true
}, over || {});

(async () => {
  STORE.set('users', [ADMIN, CM, EXISTING]);
  require(path.join(__dirname, '..', 'server.js'));
  await new Promise(r => setTimeout(r, 2500));
  const at = tok(ADMIN), cmt = tok(CM);
  const rows = () => STORE.get('signup_requests') || [];
  const ip = (n) => ({ 'X-Forwarded-For': `10.0.0.${n}` });

  console.log('\n── The form ──');
  let r = await call('POST', '/api/auth/self-signup', null, base({ agreeTerms: false }), ip(1));
  check('terms must be agreed, refused by field', r.status === 400 && r.body.field === 'agreeTerms');
  r = await call('POST', '/api/auth/self-signup', null, base({ website: 'http://spam' }), ip(1));
  check('a bot that fills the hidden field is told "thanks" and nothing is stored', r.status === 200 && rows().length === 0);
  r = await call('POST', '/api/auth/self-signup', null, base(), ip(1));
  check('a real sign-up is accepted', r.status === 200 && rows().length === 1, JSON.stringify(r.body));
  const row = rows()[0];
  check('nothing that can sign in was created', !(STORE.get('users') || []).some(u => u.email === 'jordan@example.test'));
  check('the password is stored only as a hash', row.passwordHash && !JSON.stringify(row).includes('correct horse 1'));
  check('the verify token is stored only as a hash', row.verifyTokenHash && !rows().some(x => JSON.stringify(x).includes(tokenFrom(SENT[0]))));
  check('a confirm email went out, with no health details', SENT.length === 1 && SENT[0].to === 'jordan@example.test' && !/1EG4TE5MK72|Medicare/.test(SENT[0].text + (SENT[0].html || '')));

  r = await call('POST', '/api/auth/self-signup', null, base({ email: 'juanita@example.test' }), ip(2));
  check('an email that already has an account gets the same answer, and nothing is stored', r.status === 200 && rows().length === 1 && SENT.length === 1);

  console.log('\n── Signing in before approval ──');
  r = await call('POST', '/api/auth/login', null, { email: 'jordan@example.test', password: 'wrong password' });
  check('the wrong password reveals nothing', r.status === 400 && r.body.error === 'Invalid credentials');
  r = await call('POST', '/api/auth/login', null, { email: 'jordan@example.test', password: 'correct horse 1' });
  check('before confirming: told to confirm the email', r.status === 403 && r.body.code === 'SIGNUP_UNVERIFIED');

  console.log('\n── Confirming the email ──');
  r = await call('POST', '/api/auth/self-signup/verify', null, { token: 'f'.repeat(48) });
  check('a made-up token is refused', r.status === 400 && r.body.code === 'SIGNUP_LINK_INVALID');
  r = await call('POST', '/api/auth/self-signup/verify', null, { token: tokenFrom(SENT[0]) });
  check('the real link confirms it', r.status === 200 && rows()[0].status === 'verified');
  r = await call('POST', '/api/auth/login', null, { email: 'jordan@example.test', password: 'correct horse 1' });
  check('after confirming: told the office is reviewing', r.status === 403 && r.body.code === 'SIGNUP_PENDING');

  console.log('\n── Staff ──');
  r = await call('GET', '/api/gfc/admin/signups', cmt);
  check('a case manager can see confirmed sign-ups', r.status === 200 && r.body.signups.length === 1);
  check('staff never see the password or token hash', !JSON.stringify(r.body).includes('passwordHash') && !JSON.stringify(r.body).includes('verifyTokenHash'));
  r = await call('POST', `/api/gfc/admin/signups/${row.id}/decide`, cmt, { action: 'approve_client' });
  check('a case manager cannot approve', r.status === 403);
  r = await call('POST', `/api/gfc/admin/signups/${row.id}/decide`, at, { action: 'approve_client' });
  check('an admin approves as a new client', r.status === 200 && r.body.clientId, JSON.stringify(r.body));
  const client = (STORE.get('users') || []).find(u => u.email === 'jordan@example.test');
  check('the account is a client at intake_pending, so the gate and consents still run', client && client.role === 'client' && client.enrollmentStatus === 'intake_pending');
  check('the service line follows what they asked for', client && client.serviceLine === 'BOTH');
  check('the intake starts from what they typed, insurance in the intake\'s own field', client && client.intake.firstName === 'Jordan' && client.intake.medicare && client.intake.medicare.id === '1EG4TE5MK72' && client.intake.address.state === 'GA');
  r = await call('POST', '/api/auth/login', null, { email: 'jordan@example.test', password: 'correct horse 1' });
  check('they now sign in with the password they chose', r.status === 200 && r.body.token, JSON.stringify(r.body).slice(0, 200));
  check('and were emailed that the account is ready', SENT.some(m => m.to === 'jordan@example.test' && /ready/i.test(m.subject)));
  r = await call('POST', `/api/gfc/admin/signups/${row.id}/decide`, at, { action: 'decline', reason: 'x' });
  check('an answered sign-up cannot be answered again', r.status === 409);

  console.log('\n── For a loved one ──');
  r = await call('POST', '/api/auth/self-signup', null, base({ email: 'kelvin@example.test', name: 'Kelvin Ume', who: 'loved_one', patientName: 'Mary Ume', patientDob: '1938-01-10', relationship: 'Child', interests: ['home_care'] }), ip(3));
  await call('POST', '/api/auth/self-signup/verify', null, { token: tokenFrom(SENT[SENT.length - 1]) });
  const lr = rows().find(x => x.email === 'kelvin@example.test');
  r = await call('POST', `/api/gfc/admin/signups/${lr.id}/decide`, at, { action: 'approve_client' });
  const us = STORE.get('users');
  const mary = us.find(u => u.id === r.body.clientId);
  const kel = us.find(u => u.email === 'kelvin@example.test');
  check('the loved one gets a client record with no login of their own', mary && mary.role === 'client' && /placeholder\.local$/.test(mary.email) && mary.name === 'Mary Ume');
  check('the person who signed up gets a family login linked to them', kel && kel.role === 'family' && kel.familyOfClientId === mary.id);
  check('never as a POA', kel && kel.familyIsPoa === false);
  check('and the signer is the client\'s primary contact', mary && mary.intake.primaryContact && mary.intake.primaryContact.name === 'Kelvin Ume');

  console.log('\n── Link as family, and decline ──');
  r = await call('POST', '/api/auth/self-signup', null, base({ email: 'dana@example.test', name: 'Dana Guess', who: 'loved_one', patientName: 'Juanita Guess', patientDob: '1941-03-02', relationship: 'Child' }), ip(4));
  await call('POST', '/api/auth/self-signup/verify', null, { token: tokenFrom(SENT[SENT.length - 1]) });
  r = await call('GET', '/api/gfc/admin/signups', at);
  const dana = r.body.signups.find(x => x.email === 'dana@example.test');
  check('staff are shown the client already on file with that surname and birth date', dana && dana.possibleMatches.some(m => m.id === EXISTING.id));
  r = await call('POST', `/api/gfc/admin/signups/${dana.id}/decide`, at, { action: 'link_family' });
  check('linking needs a client chosen', r.status === 400);
  r = await call('POST', `/api/gfc/admin/signups/${dana.id}/decide`, at, { action: 'link_family', clientId: EXISTING.id });
  const danaUser = STORE.get('users').find(u => u.email === 'dana@example.test');
  check('linked as family of the existing client, no new client made', r.status === 200 && danaUser && danaUser.familyOfClientId === EXISTING.id && STORE.get('users').filter(u => u.name === 'Juanita Guess').length === 1);

  r = await call('POST', '/api/auth/self-signup', null, base({ email: 'nope@example.test' }), ip(5));
  await call('POST', '/api/auth/self-signup/verify', null, { token: tokenFrom(SENT[SENT.length - 1]) });
  const nope = rows().find(x => x.email === 'nope@example.test');
  r = await call('POST', `/api/gfc/admin/signups/${nope.id}/decide`, at, { action: 'decline' });
  check('a decline needs a reason', r.status === 400);
  r = await call('POST', `/api/gfc/admin/signups/${nope.id}/decide`, at, { action: 'decline', reason: 'We do not serve that area yet.' });
  r = await call('POST', '/api/auth/login', null, { email: 'nope@example.test', password: 'correct horse 1' });
  check('signing in after a decline shows the reason', r.status === 403 && r.body.code === 'SIGNUP_DECLINED' && /serve that area/.test(r.body.error));

  console.log('\n── Rate limit ──');
  let limited = false;
  for (let i = 0; i < 7; i++) { const x = await call('POST', '/api/auth/self-signup', null, base({ email: `flood${i}@example.test` }), ip(9)); if (x.status === 429) limited = true; }
  check('one address cannot flood the queue', limited);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
