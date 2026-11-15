#!/usr/bin/env node
/**
 * Documents on file fulfil their requirements (owner, 2026-11-15), through the
 * REAL server and routes. The office uploads a paper W-9, the app reads it two
 * ways (printed title + AI check, which reports "not run" here), the office
 * marks it on file with the TIN, and the person's Pay Setup, My Documents and
 * the money gates all count it. Stored values are read back. TEST DATA only:
 * the "paper" forms are the blank government forms the app already fills.
 *   node scripts/verify_documents_on_file.js
 */
process.env.PORT = process.env.PORT || '4623';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'docs-on-file-verification-secret';
process.env.AUTO_CHANGELOG = 'false';
process.env.MFA_ENFORCE = 'false';
process.env.PAYROLL_ENCRYPTION_KEY = process.env.PAYROLL_ENCRYPTION_KEY || require('crypto').randomBytes(32).toString('hex');
const path = require('path'); const fs = require('fs'); const Module = require('module');
const STORE = new Map();
class MemDb {
  async get(k) { return STORE.has(k) ? JSON.parse(JSON.stringify(STORE.get(k))) : null; }
  async set(k, v) { STORE.set(k, JSON.parse(JSON.stringify(v))); return true; }
  async delete(k) { STORE.delete(k); return true; }
  async list(prefix) { return [...STORE.keys()].filter(k => !prefix || k.startsWith(prefix)); }
  async empty() { STORE.clear(); return true; }
}
const realResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) { if (request === '@replit/database') return '__memdb__'; return realResolve.call(this, request, ...rest); };
require.cache['__memdb__'] = { id: '__memdb__', filename: '__memdb__', loaded: true, exports: MemDb };
// Drive, in memory: what was stored is what comes back.
const FILES = new Map();
const gd = require(path.join(__dirname, '..', 'googledrive.js'));
gd.uploadCaregiverDocumentFile = async (_who, name, buf) => { const id = `f${FILES.size + 1}`; FILES.set(id, Buffer.from(buf)); return { fileId: id, webViewLink: null }; };
gd.uploadStaffDocumentFile = async (_r, _p, name, buf) => { const id = `f${FILES.size + 1}`; FILES.set(id, Buffer.from(buf)); return { fileId: id }; };
gd.downloadFileBuffer = async (id) => { if (!FILES.has(id)) throw new Error('File not found'); return FILES.get(id); };
const email = require(path.join(__dirname, '..', 'email.js'));
email.sendEmail = async () => ({ success: true });
const jwt = require('jsonwebtoken');
const BASE = `http://127.0.0.1:${process.env.PORT}`;
let pass = 0, fail = 0;
const check = (name, cond, detail) => { if (cond) { pass++; console.log(`  ✅ ${name}`); } else { fail++; console.log(`  ❌ ${name}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 500)}` : ''}`); } };
const tok = (u) => { const sid = `sess_${u.id}`; const at = new Date().toISOString();
  STORE.set(`auth_session:${sid}`, { id: sid, userId: u.id, role: u.role, createdAt: at, lastSeenAt: at, absoluteExpiresAt: null, revokedAt: null, revokedReason: null, ipHash: null, userAgent: null, mfaVerified: true, surface: null });
  return jwt.sign({ id: u.id, email: u.email, name: u.name, role: u.role, sid }, process.env.JWT_SECRET, { expiresIn: '1h' }); };
const call = async (method, url, token, body) => {
  const res = await fetch(`${BASE}${url}`, { method, headers: Object.assign({}, token ? { Authorization: `Bearer ${token}` } : {}, body ? { 'Content-Type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined });
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, body: ct.includes('json') ? await res.json().catch(() => ({})) : Buffer.from(await res.arrayBuffer()) };
};
const blank = (f) => fs.readFileSync(path.join(__dirname, '..', 'govforms', f));
const b64 = (buf) => `data:application/pdf;base64,${buf.toString('base64')}`;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const ADMIN = { id: 'admin_dof', role: 'admin', email: 'dofadmin@example.test', name: 'Dof Admin' };
// A 1099 contractor on staff whose W-9 was signed on paper. (A caregiver is
// always W-2, so their paper forms are the W-4 and I-9; the W-9 is a contractor's.)
const PERSON = { id: 'cg_dof', role: 'user', accountType: 'coordinator', email: 'dofperson@example.test', name: 'Probe Person (TEST DATA)', employmentType: '1099' };

(async () => {
  const CG = { id: 'cg_dof2', role: 'vendor', accountType: 'caregiver', email: 'dofcg@example.test', name: 'Probe Caregiver (TEST DATA)', licenseLevel: 'pca' };
  STORE.set('users', [ADMIN, PERSON, CG]);
  require(path.join(__dirname, '..', 'server.js'));
  await sleep(2500);
  const a = tok(ADMIN), me = tok(PERSON);

  console.log('\n── Upload and read ──');
  let r = await call('POST', '/api/caregiver/documents', a, { caregiverId: PERSON.id, kind: 'w9', fileName: 'W9 signed on paper.pdf', fileDataB64: b64(blank('fw9-2024-03.pdf')) });
  check('the office files the W-9 and it is accepted on sight', r.status === 200 && r.body.document.status === 'accepted', r.body);
  const w9Id = r.body.document.id;
  r = await call('POST', `/api/caregiver/admin/caregivers/${PERSON.id}/documents/match`, a, { all: true });
  const m = r.body.results && r.body.results[0] && r.body.results[0].match;
  check('Check Documents reads it as a W-9 by its printed title', r.status === 200 && m && m.readsAs === 'w9' && m.smart && m.smart.kind === 'w9', r.body);
  check('the AI check says "not run" here, and that is not counted as agreement', m && m.ai.status === 'not_run' && m.verdict === 'one_read', m);
  r = await call('GET', `/api/caregiver/documents?caregiverId=${PERSON.id}`, a);
  const listed = (r.body.documents || []).find(d => d.id === w9Id);
  check('the list carries the reading and which form it can be put on file for', listed && listed.match && listed.match.summary && listed.onFileForm === 'w9', listed);

  console.log('\n── Before: Pay Setup asks for a W-9 ──');
  r = await call('GET', '/api/my/pay-setup', me);
  const before = (r.body.profile.checklist || []).find(c => c.key === 'w9');
  check('W-9 is "To do"', before && before.done === false, r.body.profile && r.body.profile.checklist);

  console.log('\n── Mark On File ──');
  const base = { documentId: w9Id, name: 'Probe Person', taxClass: 'individual', signedName: 'Probe Person', signedOn: '2026-10-01' };
  r = await call('PUT', `/api/payroll/admin/people/${PERSON.id}/forms/w9/on-file`, a, base);
  check('without the taxpayer ID it is refused', r.status === 400 && r.body.code === 'W9_TIN', r.body);
  r = await call('PUT', `/api/payroll/admin/people/${PERSON.id}/forms/w4/on-file`, a, { ...base, filingStatus: 'single' });
  check('a W-9 cannot be put on file as a W-4', r.status === 409 && r.body.code === 'ON_FILE_KIND', r.body);
  r = await call('PUT', `/api/payroll/admin/people/${PERSON.id}/forms/w9/on-file`, a, { ...base, tin: '123-45-6789' });
  check('with the TIN it is on file', r.status === 200 && !(r.body.missing || []).includes('W-9'), r.body);
  const stored = STORE.get('payroll_profiles')[PERSON.id];
  check('the TIN is sealed, last four shown, never stored plain', stored.tin && stored.tin.last4 === '6789' && !JSON.stringify(stored).includes('123456789'));
  check('the W-9 names its document and what the reads found', stored.w9.onFile.documentId === w9Id && stored.w9.onFile.match.readsAs === 'w9');

  console.log('\n── After: the person sees it done, with their copy ──');
  r = await call('GET', '/api/my/pay-setup', me);
  const after = (r.body.profile.checklist || []).find(c => c.key === 'w9');
  check('W-9 is done, "on file"', after && after.done === true && after.onFileDocumentId === w9Id && /on paper/.test(after.note || ''), after);
  r = await call('GET', '/api/my/pay-setup/forms/w9.pdf', me);
  check('Open Copy returns the uploaded paper form, byte for byte', r.status === 200 && Buffer.compare(r.body, blank('fw9-2024-03.pdf')) === 0, r.status);
  r = await call('GET', '/api/my/documents', me);
  check('My Documents lists it as signed on paper', (r.body.signed || []).some(s => s.id === 'taxform:w9' && s.onFile), r.body.signed);

  console.log('\n── A form filed under the wrong type ──');
  r = await call('POST', '/api/caregiver/documents', a, { caregiverId: PERSON.id, kind: 'other', fileName: 'scan.pdf', fileDataB64: b64(blank('fw4-2026.pdf')) });
  const otherId = r.body.document.id;
  r = await call('POST', `/api/caregiver/admin/caregivers/${PERSON.id}/documents/match`, a, {});
  const om = (r.body.results || []).find(x => x.id === otherId);
  check('a W-4 filed as "Something else" is flagged as reading as a W-4', om && om.match.readsAs === 'w4' && om.match.filedAsDiffers === true, om);
  r = await call('PUT', `/api/caregiver/documents/${otherId}/kind`, a, { kind: 'w4' });
  check('Change Type files it as a W-4 and the flag clears', r.status === 200 && r.body.document.kind === 'w4' && r.body.document.match.filedAsDiffers === false, r.body);
  r = await call('PUT', `/api/caregiver/documents/${otherId}/kind`, tok(CG), { kind: 'w9' });
  check('a caregiver cannot change a type (the office only)', r.status === 403, r.body);

  // KEEP=<file>: stop here with the server up, for screenshots of this state.
  if (process.env.KEEP) { fs.writeFileSync(process.env.KEEP, JSON.stringify({ admin: a, person: me, personId: PERSON.id, base: BASE })); await new Promise(() => {}); }

  console.log('\n── Take Off File ──');
  r = await call('DELETE', `/api/payroll/admin/people/${PERSON.id}/forms/w9/on-file`, a);
  check('taken off file, Pay Setup asks again and the TIN goes with it', r.status === 200 && (r.body.missing || []).includes('W-9') && !STORE.get('payroll_profiles')[PERSON.id].tin, r.body);
  r = await call('DELETE', `/api/payroll/admin/people/${PERSON.id}/forms/w9/on-file`, a);
  check('a form not on file cannot be taken off', r.status === 409 && r.body.code === 'ON_FILE_NONE');

  const acts = JSON.stringify(STORE.get('activity_log') || []);
  check('the activity log never carries the TIN', !acts.includes('123456789') && !acts.includes('123-45-6789'));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
