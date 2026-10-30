/**
 * Veterans for IME exams (owner, 2026-10-30): the roster, the clinic iPad
 * sign-in, and the arrival notice to the assigned provider.
 *
 * Runs the REAL server and routes with an in-memory store. Quo (texts) and the
 * mailer are stubbed and recorded. Assertions read stored state back.
 *
 *   node scripts/verify_veterans.js
 */
process.env.PORT = process.env.PORT || '4631';
process.env.QUO_API_KEY = 'probe-key';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'veterans-verification-secret';
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

// The mailer, recorded instead of sent.
const EMAILS = [];
const email = require(path.join(__dirname, '..', 'email.js'));
email.sendEmail = async (to, subject, body, opts) => { EMAILS.push({ to, subject, body, phi: !!(opts && opts.phi) }); return { ok: true }; };
// Quo, recorded instead of called.
const TEXTS = [];
global.fetch = ((real) => async (url, opts) => {
  if (String(url).includes('api.openphone.com')) { TEXTS.push(JSON.parse(opts.body)); return { ok: true, status: 202, json: async () => ({ data: { id: 'QM-probe' } }) }; }
  return real(url, opts);
})(global.fetch);

const jwt = require('jsonwebtoken');
const config = require(path.join(__dirname, '..', 'config.js'));
const practiceTime = require(path.join(__dirname, '..', 'public', 'gfc-time.js'));
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
  const res = await fetch(`${BASE}${url}`, { method, headers: Object.assign(token ? { Authorization: `Bearer ${token}` } : {}, body ? { 'Content-Type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const wait = (ms) => new Promise(r => setTimeout(r, ms));

const ADMIN = { id: 'admin_v', role: 'admin', email: 'admin-v@example.test', name: 'Office Admin' };
const DOC1 = { id: 'doc_v1', role: 'user', hasClinicalAccess: true, clinicalRole: 'provider', clinicalRoleConfirmed: true, email: 'doc1@example.test', name: 'Dana Provider', phone: '(912) 555-0101' };
const DOC2 = { id: 'doc_v2', role: 'user', hasClinicalAccess: true, clinicalRole: 'provider', clinicalRoleConfirmed: true, email: 'doc2@example.test', name: 'Sam Provider' };
const CG = { id: 'cg_v', role: 'vendor', licenseLevel: 'PCA', email: 'cg@example.test', name: 'Care Giver' };

(async () => {
  STORE.set('users', [ADMIN, DOC1, DOC2, CG]);
  require(path.join(__dirname, '..', 'server.js'));
  await wait(2500);
  const today = practiceTime.zonedParts(new Date()).isoDate;
  const at = tok(ADMIN), d1 = tok(DOC1), d2 = tok(DOC2), cg = tok(CG);
  const roster = () => STORE.get('veteran_roster') || [];

  console.log('\n── The page ──');
  let r = await fetch(`${BASE}/veterans`);
  check('/veterans serves the iPad page', r.status === 200 && /Medical Disability Exam/.test(await r.text()));

  console.log('\n── Building the list ──');
  r = await call('POST', '/api/veterans/roster', at, { firstName: 'James', lastName: "O'Brien", dob: '1970-05-04', examDate: today, providerUserId: DOC1.id });
  check('the office adds a veteran for Dana', r.status === 200 && r.body.row.providerName === 'Dana Provider', JSON.stringify(r.body));
  const jamesId = r.body.row && r.body.row.id;
  r = await call('POST', '/api/veterans/roster', at, { firstName: 'Ann', lastName: 'Lee', dob: '1980-01-01', examDate: today });
  check('the office must choose a provider', r.status === 400 && r.body.fieldErrors && r.body.fieldErrors.providerUserId);
  r = await call('POST', '/api/veterans/roster', d2, { firstName: 'Ann', lastName: 'Lee', dob: '1980-01-01', examDate: today, providerUserId: DOC1.id });
  check('a provider adds to their own list, whatever provider they name', r.status === 200 && roster().find(x => x.lastName === 'Lee').providerUserId === DOC2.id);
  const annId = r.body.row && r.body.row.id;
  r = await call('GET', `/api/veterans/roster?date=${today}`, d1);
  check('Dana sees only her veteran', r.status === 200 && r.body.rows.length === 1 && r.body.rows[0].lastName === "O'Brien" && r.body.office === false);
  r = await call('GET', `/api/veterans/roster?date=${today}`, at);
  check('the office sees both, with the provider list', r.body.rows.length === 2 && r.body.providers.some(p => p.id === DOC1.id && p.hasPhone) && r.body.providers.some(p => p.id === DOC2.id && !p.hasPhone));
  r = await call('POST', `/api/veterans/roster/${annId}/status`, d1, { status: 'seen' });
  check('Dana cannot change Sam\'s veteran', r.status === 403 && r.body.code === 'VETERAN_NOT_YOURS');
  r = await call('GET', `/api/veterans/roster?date=${today}`, cg);
  check('a caregiver cannot read the list', r.status === 403);
  r = await call('GET', `/api/veterans/roster?date=${today}`, null);
  check('nobody signed out can read the list', r.status === 401 || r.status === 403);

  console.log('\n── A matched sign-in ──');
  r = await call('POST', '/api/veterans/check-in', null, { firstName: 'jim', lastName: 'obrien', dob: '1970-05-04', phone: '912 555 7777' });
  check('a veteran signs in with a nickname and the thank-you comes back', r.status === 200 && /call you back/.test(r.body.message), JSON.stringify(r.body));
  await wait(200);
  const j = roster().find(x => x.id === jamesId);
  check('the roster row is now arrived, with the phone they gave', j.status === 'arrived' && j.arrivalPhone === '(912) 555-7777' && j.checkinId);
  const docMail = EMAILS.find(e => e.to === DOC1.email);
  check('Dana is emailed, marked PHI, with no name in the subject', docMail && docMail.phi && !/James|Brien/i.test(docMail.subject), JSON.stringify(EMAILS));
  check('the provider text comes from the GFC main line', TEXTS.find(t => t.to[0] === '+19125550101').from === '+14049136705');
  const toDana = TEXTS.filter(t => t.to[0] === '+19125550101');
  check('Dana is texted, with no name in the text', toDana.length === 1 && !/James|Brien/i.test(toDana[0].content), JSON.stringify(TEXTS));
  const toJames = TEXTS.filter(t => t.to[0] === '+19125557777');
  check('the veteran gets a confirmation from the main line saying his provider was notified',
    toJames.length === 1 && toJames[0].from === '+14049136705' && /Your provider has been notified/.test(toJames[0].content), JSON.stringify(TEXTS));
  const ck = (STORE.get('veteran_checkins') || []).find(c => c.id === j.checkinId);
  check('the sign-in records the match and that every message went out', ck && ck.matchState === 'matched' && ck.notified.email === 'sent' && ck.notified.text === 'sent' && ck.veteranText === 'sent', JSON.stringify(ck));
  r = await call('GET', `/api/veterans/roster?date=${today}`, d1);
  check('Dana\'s list shows him arrived with the number to call', r.body.rows[0].status === 'arrived' && r.body.rows[0].arrivalPhone === '(912) 555-7777');
  r = await call('POST', `/api/veterans/roster/${jamesId}/status`, d1, { status: 'seen' });
  check('Dana marks him seen', r.status === 200 && r.body.row.status === 'seen');

  console.log('\n── An unmatched sign-in ──');
  const before = EMAILS.length, textsBefore = TEXTS.length;
  r = await call('POST', '/api/veterans/check-in', null, { firstName: 'Ann', lastName: 'Lee', dob: '1980-01-02', phone: '9125558888', email: 'ann@example.test' });
  await wait(200);
  check('a wrong DOB still gets the same thank-you', r.status === 200 && /call you back/.test(r.body.message));
  const newTexts = TEXTS.slice(textsBefore);
  check('no provider is texted, and the office is emailed', newTexts.every(t => t.to[0] === '+19125558888') && EMAILS.slice(before).some(e => e.to === config.ROI_ADMIN_EMAIL && e.phi), JSON.stringify(newTexts));
  check('the veteran still gets a confirmation, without promising a provider was told', newTexts.length === 1 && !/provider/i.test(newTexts[0].content) && newTexts[0].from === '+14049136705');
  r = await call('GET', `/api/veterans/checkins?date=${today}`, at);
  const un = r.body.rows && r.body.rows.find(c => !c.rosterId);
  check('the office sees it under sign-ins to match', r.status === 200 && un && un.lastName === 'Lee' && un.email === 'ann@example.test');
  r = await call('GET', `/api/veterans/checkins?date=${today}`, d1);
  check('a provider cannot read the sign-ins list', r.status === 403);
  r = await call('POST', `/api/veterans/checkins/${un.id}/match`, at, { rosterId: annId });
  await wait(200);
  check('the office matches it, and Sam is emailed (no phone, so no text)', r.status === 200 && r.body.notified.email === 'sent' && r.body.notified.text === 'no_phone_on_file' && EMAILS.some(e => e.to === DOC2.email), JSON.stringify(r.body));
  check('Ann is arrived on Sam\'s list', roster().find(x => x.id === annId).status === 'arrived');

  console.log('\n── Checks on the form ──');
  r = await call('POST', '/api/veterans/check-in', null, { firstName: 'A', lastName: 'B', dob: '', phone: '123', email: 'nope' });
  check('missing DOB, a short phone and a bad email are each named', r.status === 400 && r.body.fieldErrors.dob && r.body.fieldErrors.phone && r.body.fieldErrors.email);
  r = await call('POST', '/api/veterans/check-in', null, { firstName: 'Bot', lastName: 'Bot', dob: '1970-01-01', phone: '9125550000', website: 'spam' });
  check('the hidden field drops a bot quietly', r.status === 200 && !(STORE.get('veteran_checkins') || []).some(c => c.firstName === 'Bot'));
  r = await call('DELETE', `/api/veterans/roster/${annId}`, d2);
  check('removing keeps the row, marked removed', r.status === 200 && roster().find(x => x.id === annId).removedAt);

  console.log(`\n${pass}/${pass + fail} checks passed.`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
