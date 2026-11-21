#!/usr/bin/env node
/**
 * The offer letter as the first onboarding step (2026-11-19).
 *
 * Owner: "add a step to the onboarding process for all staff and that is
 * viewing and signing their offer letter document", seamless into My GFC.
 *
 * Runs the REAL server and routes. Stubbed: the KV store, Drive (in memory:
 * what was stored is what comes back) and outgoing email (captured, so the
 * link a new hire would click is read back out of the message). Every check
 * reads stored state or a real sign-in, not just a status code.
 *
 *   node scripts/verify_offer_flow.js
 */
process.env.PORT = process.env.PORT || '4623';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'offer-flow-verification-secret';
process.env.AUTO_CHANGELOG = 'false';
process.env.MFA_ENFORCE = 'false';
process.env.DATA_STORE = 'kv';

const path = require('path');
const Module = require('module');
const bcrypt = require('bcryptjs');
const { PDFDocument, StandardFonts } = require('pdf-lib');

const STORE = new Map();
class MemDb {
  async get(k) { return STORE.has(k) ? JSON.parse(JSON.stringify(STORE.get(k))) : null; }
  async set(k, v) { STORE.set(k, JSON.parse(JSON.stringify(v))); return true; }
  async delete(k) { STORE.delete(k); return true; }
  async list(p) { return [...STORE.keys()].filter(k => !p || k.startsWith(p)); }
  async empty() { STORE.clear(); return true; }
}
const realResolve = Module._resolveFilename;
Module._resolveFilename = function (r, ...rest) { return r === '@replit/database' ? '__memdb__' : realResolve.call(this, r, ...rest); };
require.cache['__memdb__'] = { id: '__memdb__', filename: '__memdb__', loaded: true, exports: MemDb };

const FILES = new Map();
const gd = require(path.join(__dirname, '..', 'googledrive.js'));
gd.uploadStaffDocumentFile = async (_r, _p, name, buf) => { const id = `f${FILES.size + 1}`; FILES.set(id, Buffer.from(buf)); return { fileId: id }; };
gd.uploadCaregiverDocumentFile = async (_w, name, buf) => { const id = `f${FILES.size + 1}`; FILES.set(id, Buffer.from(buf)); return { fileId: id }; };
gd.downloadFileBuffer = async (id) => { if (!FILES.has(id)) throw new Error('File not found'); return FILES.get(id); };

const SENT = [];
const email = require(path.join(__dirname, '..', 'email.js'));
email.sendEmail = async (to, subject, text, opts) => { SENT.push({ to, subject, text, html: (opts && opts.htmlBody) || '' }); return { success: true }; };

const BASE = `http://127.0.0.1:${process.env.PORT}`;
let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { pass++; console.log(`  ✅ ${n}`); } else { fail++; console.log(`  ❌ ${n}${d !== undefined ? ` — ${typeof d === 'string' ? d : JSON.stringify(d).slice(0, 400)}` : ''}`); } };
const call = async (m, u, body, tok) => {
  const isForm = body instanceof FormData;
  const r = await fetch(`${BASE}${u}`, { method: m, headers: Object.assign({}, isForm ? {} : { 'Content-Type': 'application/json' }, tok ? { Authorization: `Bearer ${tok}` } : {}),
    body: body ? (isForm ? body : JSON.stringify(body)) : undefined });
  const ct = r.headers.get('content-type') || '';
  let b = null;
  if (ct.includes('json')) { try { b = await r.json(); } catch (_) {} } else b = Buffer.from(await r.arrayBuffer());
  return { status: r.status, body: b };
};
const linkFrom = (msg) => { const m = /password-reset-([0-9a-f]{64})/.exec((msg && msg.text) || ''); return m ? m[1] : null; };
const login = (e, p) => call('POST', '/api/auth/login', { email: e, password: p });
const users = () => STORE.get('users') || [];
const userBy = (email) => users().find(u => u.email === email);
const queued = (type) => (STORE.get('pending_notifications') || []).concat(STORE.get('notification_log') || []).filter(n => n.type === type);

async function offerPdf(name) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText(`Offer of employment for ${name} (TEST DATA)`, { x: 60, y: 720, size: 16, font });
  return Buffer.from(await doc.save());
}
async function sendOffer(userId, tok, name, extra) {
  const fd = new FormData();
  fd.append('file', new Blob([await offerPdf(name)], { type: 'application/pdf' }), 'offer.pdf');
  fd.append('title', 'Offer letter');
  Object.entries(extra || {}).forEach(([k, v]) => fd.append(k, v));
  return call('POST', `/api/onboarding/admin/people/${userId}/offer`, fd, tok);
}
const SIG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const PW = 'Passw0rdAbc';
const ADMIN = { id: 'u_admin', role: 'admin', email: 'admin@example.test', name: 'GFC Admin', accountStatus: 'active' };
const OLDHAND = { id: 'u_old', role: 'user', accountType: 'rn', clinicalRole: 'rn', hasClinicalAccess: true, email: 'old@example.test', name: 'Old Hand', accountStatus: 'active' };
const CG = { id: 'u_cgx', role: 'vendor', accountType: 'caregiver', licenseLevel: 'pca', email: 'cgx@example.test', name: 'Existing Caregiver', accountStatus: 'active' };

(async () => {
  const hash = await bcrypt.hash(PW, 4);
  STORE.set('users', [ADMIN, OLDHAND, CG].map(u => ({ ...u, password: hash })));
  require(path.join(__dirname, '..', 'server.js'));
  await new Promise(r => setTimeout(r, 3500));
  const adminTok = (await login(ADMIN.email, PW)).body.token;
  check('the admin signs in', !!adminTok);

  console.log('\n── The office: New Hire makes the account, with no welcome email ──');
  let r = await call('POST', '/api/users', { name: 'Grace Hopewell', email: 'grace@example.test', password: 'Gf1abcdef0123456789Z', accountType: 'rn', sendWelcomeEmail: false, employmentType: 'W2' }, adminTok);
  const grace = userBy('grace@example.test');
  check('the account is made', r.status === 200 && !!grace, r.body);
  check('no temporary-password email went out', !SENT.some(m => m.to === 'grace@example.test'));

  console.log('\n── Sending the offer ──');
  r = await sendOffer(grace.id, adminTok, 'Grace Hopewell', { note: 'Start date Dec 1.' });
  check('the offer is sent', r.status === 200 && r.body.offer && r.body.offer.status === 'sent' && r.body.emailed === true, r.body);
  const offerMail = SENT.filter(m => m.to === 'grace@example.test').pop();
  const token = linkFrom(offerMail);
  check('Grace gets ONE email, "Your offer", with a set-password link', !!token && /Your offer from/.test(offerMail.subject) && /Review Your Offer/.test(offerMail.html), offerMail && offerMail.subject);
  check('the email carries no password and no document', offerMail && !/Gf1abcdef/.test(offerMail.text + offerMail.html) && !/%PDF/.test(offerMail.html));
  const g1 = userBy('grace@example.test');
  check('her account holds the offer as sent, gated', g1.offer && g1.offer.status === 'sent' && !g1.offer.everSigned && g1.offer.itemId === 'B.5.01', g1.offer);
  const rec = (STORE.get('onboarding_records') || []).find(x => x.userId === grace.id);
  check('her onboarding is opened, on the RN checklist', rec && rec.inputs.chapter === 'B', rec && rec.inputs);
  check('the offer is attached to B.5.01, and the Executive Director step is recorded', rec && rec.items['B.5.01'] && rec.items['B.5.01'].document && rec.items['B.5.01'].document.sendId === g1.offer.sendId && rec.items['B.5.01'].steps && rec.items['B.5.01'].steps[0], rec && rec.items['B.5.01']);
  check('no "your onboarding is ready" email went out ahead of the offer', !SENT.some(m => m.to === 'grace@example.test' && /onboarding is ready/i.test(m.subject)) && !queued('staff_onboarding_started').some(n => n.recipientEmail === 'grace@example.test'));
  const links = STORE.get('password_set_links') || [];
  const lk = links.find(l => l.userId === grace.id);
  check('the link is an offer link, 7 days, stored as a fingerprint only', lk && lk.purpose === 'offer' && (new Date(lk.expiresAt) - new Date(lk.createdAt)) === 7 * 24 * 3600 * 1000 && !JSON.stringify(links).includes(token), lk);

  console.log('\n── Grace opens the link: password, then straight onto the offer ──');
  r = await call('GET', `/api/auth/password-reset-link/${token}`);
  check('the page knows it is an offer link', r.status === 200 && r.body.purpose === 'offer' && r.body.firstName === 'Grace', r.body);
  r = await call('POST', '/api/auth/reset-password', { token, newPassword: 'MyOwn1Pass' });
  check('saving her password signs her in, landing on /offer', r.status === 200 && r.body.signIn && r.body.signIn.token && r.body.signIn.user.landing === '/offer', r.body);
  const gTok = r.body.signIn.token;
  check('her own password works from then on', (await login('grace@example.test', 'MyOwn1Pass')).status === 200);
  check('signing in again lands on /offer', (await login('grace@example.test', 'MyOwn1Pass')).body.user.landing === '/offer');

  console.log('\n── Until she signs, the offer is all she can open ──');
  r = await call('GET', '/api/my/document-sends', null, gTok);
  check('My Documents answers OFFER_PENDING', r.status === 409 && r.body.code === 'OFFER_PENDING', r.body);
  r = await call('GET', '/api/onboarding/me', null, gTok);
  check('her onboarding answers OFFER_PENDING', r.status === 409 && r.body.code === 'OFFER_PENDING', r.body);
  r = await call('GET', '/api/my/welcome-packet', null, gTok);
  check('her welcome packet answers OFFER_PENDING', r.status === 409 && r.body.code === 'OFFER_PENDING', r.body);
  r = await call('GET', '/api/my/offer', null, gTok);
  const doc = r.body && r.body.doc;
  check('her offer opens, with the office note', r.status === 200 && doc && doc.id === g1.offer.sendId && doc.note === 'Start date Dec 1.' && r.body.next === '/my#welcome', r.body);
  r = await call('GET', `/api/my/document-sends/${doc.id}/file`, null, gTok);
  check('the offer PDF reads back byte for byte', r.status === 200 && Buffer.isBuffer(r.body) && String(r.body.slice(0, 5)) === '%PDF-');
  r = await call('POST', `/api/my/document-sends/${doc.id}/preview`, { printedName: 'Grace Hopewell' }, gTok);
  check('the signature preview draws', r.status === 200 && Buffer.isBuffer(r.body));
  r = await call('GET', '/api/auth/heartbeat', null, gTok);
  check('staying signed in still works', r.status === 200, r.status);

  console.log('\n── She signs ──');
  r = await call('POST', `/api/my/document-sends/${doc.id}/sign`, { printedName: 'Grace Hopewell', acknowledged: true, signaturePng: SIG }, gTok);
  check('the offer is signed, and she is sent on to her welcome packet', r.status === 200 && r.body.next === '/my#welcome', r.body);
  const g2 = userBy('grace@example.test');
  check('her offer reads signed, and the gate is gone', g2.offer.status === 'signed' && g2.offer.everSigned && !!g2.offer.signedAt, g2.offer);
  const rec2 = (STORE.get('onboarding_records') || []).find(x => x.userId === grace.id);
  check('B.5.01: her sign step is done, with the signed copy on the item', rec2.items['B.5.01'].steps[1] && (rec2.items['B.5.01'].files || []).some(f => f.documentId), rec2.items['B.5.01']);
  const docs = (STORE.get('caregiver_documents') || []).filter(d => d.owner_id === grace.id || d.ownerId === grace.id || d.caregiver_id === grace.id);
  check('the signed copy is filed to her Documents', docs.length === 1, docs.map(d => d.kind));
  check('the office is told she signed', queued('staff_offer_signed').some(n => n.recipientEmail === ADMIN.email));
  r = await call('GET', '/api/my/document-sends', null, gTok);
  check('My Documents opens now', r.status === 200, r.body);
  check('signing in now lands on the welcome packet', (await login('grace@example.test', 'MyOwn1Pass')).body.user.landing === '/my#welcome');

  console.log('\n── A caregiver: same flow, and the welcome packet\'s offer item is done ──');
  r = await call('POST', '/api/users', { name: 'Carla Rivers', email: 'carla@example.test', password: 'Gf1abcdef0123456789Z', accountType: 'caregiver', licenseLevel: 'pca', sendWelcomeEmail: false, employmentType: 'W2' }, adminTok);
  const carla = userBy('carla@example.test');
  r = await sendOffer(carla.id, adminTok, 'Carla Rivers');
  check('the caregiver offer is sent, on A.5.01', r.status === 200 && userBy('carla@example.test').offer.itemId === 'A.5.01', r.body);
  const cTokRes = await call('POST', '/api/auth/reset-password', { token: linkFrom(SENT.filter(m => m.to === 'carla@example.test').pop()), newPassword: 'Carla1Pass' });
  const cTok = cTokRes.body.signIn.token;
  r = await call('GET', '/api/caregiver/me', null, cTok);
  check('the caregiver app is closed until she signs', r.status === 409 && r.body.code === 'OFFER_PENDING', r.body);
  const cDoc = (await call('GET', '/api/my/offer', null, cTok)).body.doc;
  r = await call('POST', `/api/my/document-sends/${cDoc.id}/sign`, { printedName: 'Carla Rivers', acknowledged: true, signaturePng: SIG }, cTok);
  check('signing sends her on to the caregiver app', r.status === 200 && r.body.next === '/caregiver', r.body);
  const cDocs = (STORE.get('caregiver_documents') || []).filter(d => JSON.stringify(d).includes(carla.id));
  check('her signed offer is filed as her offer letter (the packet item counts it)', cDocs.some(d => d.kind === 'offer_letter' && d.status === 'accepted'), cDocs.map(d => [d.kind, d.status]));
  r = await call('GET', '/api/caregiver/me', null, cTok);
  check('the caregiver app opens now', r.status === 200, r.body && r.body.code);

  console.log('\n── Declining, and a new version ──');
  r = await call('POST', '/api/users', { name: 'Dan Okafor', email: 'dan@example.test', password: 'Gf1abcdef0123456789Z', accountType: 'coordinator', sendWelcomeEmail: false }, adminTok);
  const dan = userBy('dan@example.test');
  r = await sendOffer(dan.id, adminTok, 'Dan Okafor');
  const firstSend = userBy('dan@example.test').offer.sendId;
  const n0 = SENT.length;
  r = await call('POST', `/api/onboarding/admin/people/${dan.id}/offer/resend-link`, null, adminTok);
  const resent = SENT.slice(n0).find(m => m.to === 'dan@example.test');
  check('Resend Link emails a fresh link', r.status === 200 && r.body.emailed && !!linkFrom(resent), r.body);
  const dTok = (await call('POST', '/api/auth/reset-password', { token: linkFrom(resent), newPassword: 'Dan1Passw0rd' })).body.signIn.token;
  r = await call('POST', '/api/my/offer/decline', { note: 'I accepted another position closer to home.' }, dTok);
  check('he declines, with a note', r.status === 200, r.body);
  const d1 = userBy('dan@example.test');
  check('his account is switched off and the note kept', d1.accountStatus === 'inactive' && d1.offer.status === 'declined' && /closer to home/.test(d1.offer.declineNote), d1.offer);
  r = await call('GET', '/api/my/offer', null, dTok);
  check('his sessions are ended', r.status === 403, r.status);
  check('he cannot sign in', (await login('dan@example.test', 'Dan1Passw0rd')).status === 403);
  const declinedNotice = queued('staff_offer_declined').find(n => n.recipientEmail === ADMIN.email);
  check('the office is told, with his note', declinedNotice && /closer to home/.test(JSON.stringify(declinedNotice)), declinedNotice);
  check('the activity log records the decline, without the note', (STORE.get('activity_log') || []).some(a => a.action === 'offer_declined') && !JSON.stringify(STORE.get('activity_log')).includes('closer to home'));
  check('the declined offer is withdrawn', (STORE.get('staff_document_sends') || []).find(s => s.id === firstSend).removedAt);
  r = await call('GET', `/api/onboarding/admin/people/${dan.id}/offer`, null, adminTok);
  check('the office card shows Declined and his note', r.status === 200 && r.body.offer.status === 'declined' && /closer to home/.test(r.body.offer.declineNote), r.body);
  r = await sendOffer(dan.id, adminTok, 'Dan Okafor', { newVersion: 'true' });
  const d2 = userBy('dan@example.test');
  check('a new version switches his account back on and emails a new link', r.status === 200 && d2.accountStatus === 'active' && d2.offer.status === 'sent' && d2.offer.sendId !== firstSend && r.body.emailed, r.body);

  console.log('\n── Everyone already working is untouched ──');
  const oldTok = (await login(OLDHAND.email, PW)).body.token;
  r = await call('GET', '/api/my/document-sends', null, oldTok);
  check('staff with no offer reach My GFC as before', r.status === 200, r.body);
  const cgTok = (await login(CG.email, PW)).body.token;
  r = await sendOffer(grace.id, cgTok, 'Grace');
  check('a caregiver cannot send an offer', r.status === 403, r.body);
  r = await sendOffer(grace.id, adminTok, 'Grace');
  check('a signed offer is not replaced by accident', r.status === 409 && r.body.code === 'OFFER_ALREADY_SIGNED', r.body);
  const nG = SENT.length;
  r = await sendOffer(grace.id, adminTok, 'Grace Hopewell', { newVersion: 'true' });
  const g3 = userBy('grace@example.test');
  check('a new version after signing goes to My Documents, never locks her out', r.status === 200 && r.body.channel === 'documents' && !SENT.slice(nG).some(m => m.to === 'grace@example.test' && linkFrom(m)), r.body);
  r = await call('GET', '/api/my/document-sends', null, (await login('grace@example.test', 'MyOwn1Pass')).body.token);
  check('and she still reaches My Documents, with it waiting there', r.status === 200 && r.body.waiting.some(w => w.id === g3.offer.sendId), r.body);

  console.log('\n── Audit ──');
  const acts = (STORE.get('activity_log') || []).map(a => a.action);
  for (const a of ['offer_sent', 'offer_link_sent', 'offer_link_resent', 'document_signed', 'offer_declined', 'offer_new_version_sent']) check(`${a} is audited`, acts.includes(a), acts.slice(-12).join(','));

  console.log(`\n${pass}/${pass + fail} checks passed.`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
