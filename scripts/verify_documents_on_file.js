#!/usr/bin/env node
/**
 * Documents on file fulfil their requirements (owner, 2026-11-15), through the
 * REAL server and routes. The office uploads a paper W-9, the app reads it two
 * ways (printed title + AI check, which reports "not run" here), the office
 * marks it on file WITHOUT the taxpayer ID (one rule: the office never types a
 * full SSN or TIN), the person enters their own in Pay Setup, and Pay Setup,
 * My Documents and the money gates all count it. Stored values are read back. TEST DATA only:
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
// A test number on its own, never digits that happen to sit inside a
// timestamp-based id (cgdoc_1763234567890 holds "234567890").
const holds = (text, ...nums) => nums.some(n => new RegExp(`(?<![0-9])${n.replace(/-/g, '-?')}(?![0-9])`).test(text));

const ADMIN = { id: 'admin_dof', role: 'admin', email: 'dofadmin@example.test', name: 'Dof Admin' };
// A 1099 contractor on staff whose W-9 was signed on paper. (A caregiver is
// always W-2, so their paper forms are the W-4 and I-9; the W-9 is a contractor's.)
const PERSON = { id: 'cg_dof', role: 'user', accountType: 'coordinator', email: 'dofperson@example.test', name: 'Probe Person (TEST DATA)', employmentType: '1099' };
// A second 1099 contractor whose Social Security card is on file (2026-11-15).
const P2U = { id: 'cg_dof3', role: 'user', accountType: 'coordinator', email: 'dofp2@example.test', name: 'Probe Contractor (TEST DATA)', employmentType: '1099' };

(async () => {
  const CG = { id: 'cg_dof2', role: 'vendor', accountType: 'caregiver', email: 'dofcg@example.test', name: 'Probe Caregiver (TEST DATA)', licenseLevel: 'pca' };
  STORE.set('users', [ADMIN, PERSON, CG, P2U]);
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
  r = await call('PUT', `/api/payroll/admin/people/${PERSON.id}/forms/w4/on-file`, a, { ...base, filingStatus: 'single' });
  check('a W-9 cannot be put on file as a W-4', r.status === 409 && r.body.code === 'ON_FILE_KIND', r.body);
  // A number typed on the W-9 is checked like any SSN.
  r = await call('PUT', `/api/payroll/admin/people/${PERSON.id}/forms/w9/on-file`, a, { ...base, tin: '987-65-4321' });
  check('a typed number that is not a valid SSN is refused', r.status === 400 && r.body.code === 'W9_TIN', r.body);
  // Left blank (the office does not have it): on file, and they enter it.
  r = await call('PUT', `/api/payroll/admin/people/${PERSON.id}/forms/w9/on-file`, a, base);
  check('it goes on file with the number left blank (paper showing only the last 4 is fine)', r.status === 200 && !(r.body.missing || []).includes('W-9'), r.body);
  check('…and pay waits on the full number, which they enter in Pay Setup', (r.body.missing || []).includes('Taxpayer ID (they add it in Pay Setup)'), r.body.missing);
  let stored = STORE.get('payroll_profiles')[PERSON.id];
  check('no number was stored', !stored.tin);
  check('the W-9 names its document and what the reads found', stored.w9.onFile.documentId === w9Id && stored.w9.onFile.match.readsAs === 'w9');

  console.log('\n── The person enters their own taxpayer ID ──');
  r = await call('GET', '/api/my/pay-setup', me);
  let tinRow = (r.body.profile.checklist || []).find(c => c.key === 'tin');
  check('Pay Setup shows "Taxpayer ID for your 1099" as To do', tinRow && tinRow.done === false && /full Social Security number or EIN/.test(tinRow.note || ''), r.body.profile.checklist);
  r = await call('PUT', '/api/my/pay-setup/tin', me, { tinType: 'ssn', tin: '12-34' });
  check('a short number is refused', r.status === 400 && r.body.code === 'TIN_INVALID', r.body);
  r = await call('PUT', '/api/my/pay-setup/tin', tok(CG), { tinType: 'ssn', tin: '123-45-6789' });
  check('someone with no W-9 on file cannot use this step', r.status === 409 && r.body.code === 'TIN_NO_W9', r.body);
  r = await call('PUT', '/api/my/pay-setup/tin', me, { tinType: 'ssn', tin: '123-45-6789' });
  tinRow = r.body.profile && (r.body.profile.checklist || []).find(c => c.key === 'tin');
  check('they save it; the row reads done, ending 6789', r.status === 200 && tinRow && tinRow.done === true && r.body.profile.tinLast4 === '6789', r.body);
  stored = STORE.get('payroll_profiles')[PERSON.id];
  check('it is sealed, last four shown, never stored plain', stored.tin && stored.tin.last4 === '6789' && stored.tin.source === 'self' && !holds(JSON.stringify(stored), '123-45-6789'));
  const gate = require(path.join(__dirname, '..', 'payrollProfiles.js')).missingForPay(stored, { asContractor: true });
  check('the money gate clears (nothing missing for pay on the stored record)', Array.isArray(gate) && !gate.some(m => /W-9|Taxpayer/.test(m)), gate);

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

  console.log('\n── The SSN, entered once: read off the card, used by the W-9, revised by the office ──');
  const P2 = 'cg_dof3';
  const cardPdf = async () => { const { PDFDocument, StandardFonts } = require('pdf-lib'); const d = await PDFDocument.create(); const pg = d.addPage([350, 220]); const f = await d.embedFont(StandardFonts.Helvetica);
    pg.drawText('SOCIAL SECURITY', { x: 20, y: 180, size: 16, font: f }); pg.drawText('123-45-6789', { x: 20, y: 140, size: 18, font: f });
    pg.drawText('THIS NUMBER HAS BEEN ESTABLISHED FOR', { x: 20, y: 100, size: 9, font: f }); pg.drawText('PROBE CONTRACTOR (TEST DATA)', { x: 20, y: 80, size: 11, font: f }); return Buffer.from(await d.save()); };
  r = await call('POST', '/api/caregiver/documents', a, { caregiverId: P2, kind: 'ssn_card', fileName: 'SS card.pdf', fileDataB64: b64(await cardPdf()) });
  const cardId = r.body.document && r.body.document.id;
  check('the office files a Social Security card', r.status === 200 && r.body.document.status === 'accepted', r.body);
  r = await call('POST', `/api/caregiver/admin/caregivers/${P2}/documents/match`, a, { all: true });
  r = await call('GET', `/api/caregiver/documents?caregiverId=${P2}`, a);
  const card = (r.body.documents || []).find(d => d.id === cardId);
  check('the number is read off the card: ending 6789, printed digits', card && card.ssnRead && card.ssnRead.last4 === '6789' && card.ssnRead.reads === 'text', card && card.ssnRead);
  const raw = (STORE.get('caregiver_documents') || []).find(d => d.id === cardId);
  check('it is stored SEALED on the document, never plain', raw.ssnRead.enc && !holds(JSON.stringify(raw), '123-45-6789'));
  check('the document list never carries the sealed value', !JSON.stringify(card).includes(raw.ssnRead.enc.slice(0, 20)));
  r = await call('GET', `/api/payroll/admin/people/${P2}/forms/on-file`, a);
  check('Mark On File knows the card read (last 4 only)', r.body.ssn && r.body.ssn.cards.length === 1 && r.body.ssn.cards[0].last4 === '6789' && !r.body.ssn.last4, r.body.ssn);
  r = await call('PUT', `/api/payroll/admin/people/${P2}/ssn`, a, { ssnCardDocumentId: w9Id });
  check('another person\'s document cannot give the number', r.status === 400 && r.body.code === 'SSN_CARD', r.body);
  r = await call('PUT', `/api/payroll/admin/people/${P2}/ssn`, a, { ssnCardDocumentId: cardId });
  let s2 = STORE.get('payroll_profiles')[P2];
  check('Use For SSN saves it from the card: ending 6789, by the office', r.status === 200 && r.body.profile.ssnLast4 === '6789' && r.body.profile.ssnSource === 'office' && s2.ssn.documentId === cardId, r.body.profile);
  // Their paper W-9, put on file with NO number typed: the SSN answers it.
  r = await call('POST', '/api/caregiver/documents', a, { caregiverId: P2, kind: 'w9', fileName: 'W9.pdf', fileDataB64: b64(blank('fw9-2024-03.pdf')) });
  const w9b = r.body.document.id;
  await call('POST', `/api/caregiver/admin/caregivers/${P2}/documents/match`, a, { all: true });
  r = await call('PUT', `/api/payroll/admin/people/${P2}/forms/w9/on-file`, a, { documentId: w9b, name: 'Probe Contractor', taxClass: 'individual', signedName: 'Probe Contractor', signedOn: '2026-10-01' });
  s2 = STORE.get('payroll_profiles')[P2];
  check('the W-9 takes the SSN already on file: entered once, nothing missing', r.status === 200 && s2.tin && s2.tin.last4 === '6789' && !(r.body.missing || []).some(m => /Taxpayer/.test(m)), r.body.missing);
  r = await call('GET', '/api/my/pay-setup', tok(P2U));
  check('their Pay Setup shows no taxpayer ID to-do: it reads done, added by the office', ((r.body.profile.checklist || []).find(c => c.key === 'tin') || {}).done === true && r.body.profile.tinSource === 'office', r.body.profile.checklist);
  // The office revises it; the W-9 number follows.
  r = await call('PUT', `/api/payroll/admin/people/${P2}/ssn`, a, { ssn: '234-56-7890' });
  s2 = STORE.get('payroll_profiles')[P2];
  check('the office revises it: both the SSN and the W-9 number now end 7890', r.status === 200 && s2.ssn.last4 === '7890' && s2.tin.last4 === '7890', { ssn: s2.ssn.last4, tin: s2.tin.last4 });
  r = await call('PUT', `/api/payroll/admin/people/${P2}/ssn`, tok(CG), { ssn: '234-56-7890' });
  check('a caregiver cannot set someone\'s SSN', r.status === 403 || r.status === 401, r.status);
  const logs = JSON.stringify(STORE.get('activity_log') || []) + JSON.stringify(s2.history || []);
  check('logs and history never carry either number', !holds(logs, '123-45-6789', '234-56-7890'));

  console.log('\n── A W-4 uploaded as "W-9" (owner report, 2026-11-15) ──');
  const CGID = 'cg_dof2';
  r = await call('POST', '/api/caregiver/documents', a, { caregiverId: CGID, kind: 'w9', fileName: 'Tasha W-9.pdf', fileDataB64: b64(blank('fw4-2026.pdf')) });
  const misId = r.body.document.id;
  // As before the reads existed: no reading on the row yet.
  { const all = STORE.get('caregiver_documents'); delete all.find(d => d.id === misId).match; STORE.set('caregiver_documents', all); }
  const w4Body = { documentId: misId, name: 'Probe Caregiver', taxClass: 'individual', signedName: 'Probe Caregiver', signedOn: '2026-10-01' };
  r = await call('PUT', `/api/payroll/admin/people/${CGID}/forms/w9/on-file`, a, w4Body);
  check('an unchecked document is never put on file on its filed type alone', r.status === 409 && r.body.code === 'ON_FILE_NOT_READ', r.body);
  r = await call('POST', `/api/caregiver/admin/caregivers/${CGID}/documents/match`, a, {});
  const mis = (r.body.results || []).find(x => x.id === misId);
  check('checked, it reads as a W-4 and is flagged as filed under the wrong type', mis && mis.match.readsAs === 'w4' && mis.match.filedAsDiffers === true, mis);
  r = await call('PUT', `/api/payroll/admin/people/${CGID}/forms/w9/on-file`, a, w4Body);
  check('and it cannot be used as a W-9', r.status === 409 && r.body.code === 'ON_FILE_READS_DIFFERENT', r.body);
  r = await call('PUT', `/api/caregiver/documents/${misId}/kind`, a, { kind: 'w4' });
  check('Change Type files it as a W-4', r.status === 200 && r.body.document.kind === 'w4' && r.body.document.match.filedAsDiffers === false, r.body);
  r = await call('PUT', `/api/payroll/admin/people/${CGID}/forms/w4/on-file`, a, { documentId: misId, filingStatus: 'mfj', signedName: 'Probe Caregiver', signedOn: '2026-10-01' });
  check('then it goes on file as their W-4', r.status === 200 && !(r.body.missing || []).includes('W-4'), r.body);
  r = await call('PUT', `/api/caregiver/documents/${misId}/kind`, a, { kind: 'tb_test' });
  check('a document on file cannot change type until it is taken off file', r.status === 409 && r.body.code === 'DOC_ON_FILE', r.body);
  // Change Type before acceptance works too: a caregiver's own upload waits on review.
  r = await call('POST', '/api/caregiver/documents', tok(CG), { kind: 'other', fileName: 'scan.pdf', fileDataB64: b64(blank('fw4-2026.pdf')) });
  const pendingId = r.body.document && r.body.document.id;
  r = await call('PUT', `/api/caregiver/documents/${pendingId}/kind`, a, { kind: 'w4' });
  check('Change Type works before the office accepts it', r.status === 200 && r.body.document.kind === 'w4' && r.body.document.status === 'received', r.body);
  // An SS card filed as "Something else" and never read: changing its type reads it.
  r = await call('POST', '/api/caregiver/documents', a, { caregiverId: CGID, kind: 'other', fileName: 'card.pdf', fileDataB64: b64(await cardPdf()) });
  const lateCard = r.body.document.id;
  await sleep(1500);
  { const all = STORE.get('caregiver_documents'); const row = all.find(d => d.id === lateCard); delete row.match; delete row.ssnRead; STORE.set('caregiver_documents', all); }
  r = await call('PUT', `/api/caregiver/documents/${lateCard}/kind`, a, { kind: 'ssn_card' });
  await sleep(2000);
  r = await call('GET', `/api/caregiver/documents?caregiverId=${CGID}`, a);
  const lc = (r.body.documents || []).find(d => d.id === lateCard);
  check('changing an unread file to Social Security card reads it and its number', lc && lc.match && lc.ssnRead && lc.ssnRead.last4 === '6789', lc);

  // KEEP=<file>: stop here with the server up, for screenshots of this state.
  if (process.env.KEEP) {
    // For screenshots only: a stand-in AI answer on the W-4 (Vertex is off
    // here), and the person's number cleared so the Pay Setup to-do shows.
    const docs = STORE.get('caregiver_documents');
    const w4 = docs.find(d => d.id === otherId);
    w4.match = { ...w4.match, verdict: 'agree', ai: { status: 'ok', kind: 'w4', confidence: 0.96, fields: { filingStatus: 'single', extraWithholding: '20', signedName: 'Probe Person', signedOn: '2026-09-15' } } };
    STORE.set('caregiver_documents', docs);
    const all = STORE.get('payroll_profiles'); all[PERSON.id].tin = null;
    // …and the second contractor's W-9 back off file, so its number choices show.
    all[P2].w9 = null; all[P2].tin = null; STORE.set('payroll_profiles', all);
    fs.writeFileSync(process.env.KEEP, JSON.stringify({ admin: a, person: me, personId: PERSON.id, p2: P2, base: BASE })); await new Promise(() => {});
  }

  console.log('\n── Take Off File ──');
  r = await call('DELETE', `/api/payroll/admin/people/${PERSON.id}/forms/w9/on-file`, a);
  check('taken off file, Pay Setup asks for the W-9 again; the number they entered stays theirs', r.status === 200 && (r.body.missing || []).includes('W-9') && STORE.get('payroll_profiles')[PERSON.id].tin.last4 === '6789', r.body);
  r = await call('DELETE', `/api/payroll/admin/people/${PERSON.id}/forms/w9/on-file`, a);
  check('a form not on file cannot be taken off', r.status === 409 && r.body.code === 'ON_FILE_NONE');

  const acts = JSON.stringify(STORE.get('activity_log') || []);
  const hist = JSON.stringify(STORE.get('payroll_profiles')[PERSON.id].history || []);
  check('the activity log and history never carry the number', !holds(acts, '123-45-6789', '987-65-4321') && !holds(hist, '123-45-6789'));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
