'use strict';

// SIGN OR ACKNOWLEDGE, declared once per policy (owner, 2026-11-15): "the Code
// of Conduct is now an acknowledgement document across all staff, though it
// needs to be signed by all staff", and offer letters must be signed, not
// ticked. The rules run as pure functions, then through the real router over
// HTTP with a fake store and a fake Drive holding Word files.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { createZip } = require('../zipWriter');
const T = require('../onboarding/track');
const C = require('../onboarding/chapterC');
const PS = require('../onboarding/policySigning');
const policyPdf = require('../onboarding/policyPdf');
const portal = require('../routes/staffPortal');

const NOW = '2026-11-15T15:00:00.000Z';
const HER = { id: 'n1', name: 'Bethel Godwins', isOffice: false };
const OFFICE = { id: 'a1', name: 'Office Admin', isOffice: true };
const item = (id) => T.findItem(id);
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const SIG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function docx(paragraphs) {
  const body = paragraphs.map(([text, style]) =>
    `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t>${text}</w:t></w:r></w:p>`).join('');
  const xml = `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="x"><w:body>${body}</w:body></w:document>`;
  return createZip([{ name: 'word/document.xml', data: Buffer.from(xml) }]);
}

// ---- the setting --------------------------------------------------------------
test('the Code of Conduct, Field Addendum, Handbook and HIPAA are signed; the manuals are acknowledged', () => {
  const action = (id) => T.ackAction(T.ALL_ACKS.find(a => a.id === id));
  for (const id of ['CODE_OF_CONDUCT', 'FIELD_ADDENDUM', 'EMPLOYEE_HANDBOOK', 'HIPAA_ACK']) assert.strictEqual(action(id), 'sign', id);
  for (const id of ['CLINICAL_MANUAL', 'PHC_MANUAL', 'ADMIN_MANUAL', 'JOB_DESCRIPTION']) assert.strictEqual(action(id), 'acknowledge', id);
  // One entry, read by every chapter: no chapter can set it differently.
  for (const ch of ['B', 'C', 'F', 'G', 'H']) {
    const coc = T.CHAPTERS[ch].ACKNOWLEDGMENTS.find(a => a.id === 'CODE_OF_CONDUCT');
    assert.strictEqual(coc, C.ACKNOWLEDGMENTS.find(a => a.id === 'CODE_OF_CONDUCT'), `chapter ${ch} reads chapter C's entry`);
  }
});

test('a document to sign counts only when signed; a click-acknowledgment of it asks for a signature', () => {
  const it = item('C.5.04');
  let st = T.recordAcknowledgment(it, null, 'CODE_OF_CONDUCT', '2.0', HER, NOW, { method: 'signed' });
  assert.strictEqual(T.ackStatus(it, st).find(a => a.id === 'CODE_OF_CONDUCT').current, true, 'signed in the app');
  // An older click-acknowledgment (no method) is kept and reads "needs a signature".
  st = { acknowledgments: { CODE_OF_CONDUCT: { version: '2.0', at: NOW, filedBy: 'SELF' } } };
  const row = T.ackStatus(it, st).find(a => a.id === 'CODE_OF_CONDUCT');
  assert.strictEqual(row.current, false);
  assert.strictEqual(row.needsSignature, true);
  assert.strictEqual(row.stale, false);
  // She cannot satisfy a signed document with an acknowledgment.
  assert.throws(() => T.recordAcknowledgment(it, st, 'CODE_OF_CONDUCT', '2.0', HER, NOW, { method: 'acknowledged' }), e => e.code === 'ACK_SIGNATURE_REQUIRED');
  // Nor by a tick with no screen behind it.
  assert.throws(() => T.recordAcknowledgment(it, st, 'CLINICAL_MANUAL', '2.2', HER, NOW), e => e.code === 'ACK_OPEN_DOCUMENT');
  // The office files a signed paper copy: it counts, and says so.
  const paper = T.recordAcknowledgment(it, st, 'CODE_OF_CONDUCT', '2.0', OFFICE, NOW);
  const p = T.ackStatus(it, paper).find(a => a.id === 'CODE_OF_CONDUCT');
  assert.strictEqual(p.current, true);
  assert.strictEqual(p.method, 'paper');
  assert.strictEqual(paper.ackHistory[0].ackId, 'CODE_OF_CONDUCT', 'the older acknowledgment is kept');
  // An acknowledged document counts on an acknowledgment.
  const man = T.recordAcknowledgment(it, null, 'CLINICAL_MANUAL', '2.2', HER, NOW, { method: 'acknowledged' });
  assert.strictEqual(T.ackStatus(it, man).find(a => a.id === 'CLINICAL_MANUAL').current, true);
});

test('each person owes the policies their own checklist gives them', () => {
  const ids = (inputs) => PS.policiesFor(T.normalizeInputs(inputs)).map(d => d.id);
  for (const ch of ['B', 'C', 'F', 'G', 'H']) assert.ok(ids({ chapter: ch }).includes('CODE_OF_CONDUCT'), `chapter ${ch}`);
  // Caregivers sign the Code of Conduct, Handbook and HIPAA in their welcome packet.
  assert.ok(!ids({ chapter: 'A' }).includes('CODE_OF_CONDUCT'));
  // The admin team gets the Field Addendum only when the role enters a home.
  assert.ok(!ids({ chapter: 'F' }).includes('FIELD_ADDENDUM'));
  assert.ok(ids({ chapter: 'F', entersResidence: true }).includes('FIELD_ADDENDUM'));
  // A policy with no file to open is not offered (the office files it).
  assert.ok(!ids({ chapter: 'C' }).includes('JOB_DESCRIPTION'));
});

// ---- offer letters --------------------------------------------------------------
test('her signature on an offer letter is never a tick', () => {
  const it = item('C.5.01');
  const idx = it.steps.findIndex(s => s.actor === 'NEW_HIRE' && s.action === 'SIGN');
  assert.ok(idx >= 0);
  assert.throws(() => T.recordStep(it, {}, idx, HER, {}, NOW), e => e.code === 'SIGN_IN_APP');
  assert.throws(() => T.recordStep(it, {}, idx, OFFICE, {}, NOW), e => e.code === 'SIGNED_COPY_REQUIRED');
  const withPaper = { files: [{ id: 'f1', name: 'Offer letter (signed).pdf' }] };
  assert.ok(T.recordStep(it, withPaper, idx, OFFICE, {}, NOW).steps[idx], 'the office records it once the signed copy is on the item');
  assert.ok(T.recordStep(it, {}, idx, HER, {}, NOW, { viaDocument: true }).steps[idx], 'signing the attached document records it');
  // The office's own steps are unaffected.
  const officeIdx = it.steps.findIndex(s => s.actor !== 'NEW_HIRE');
  assert.ok(T.recordStep(it, {}, officeIdx, OFFICE, {}, NOW).steps[officeIdx]);
});

test('signing an attached document records her SIGN step', () => {
  const src = read('routes/staffPortal.js');
  assert.match(src, /T\.recordStep\(def, st, idx, \{ id: user\.id, name: user\.name \|\| user\.email, isOffice: false \}, \{\}, at, \{ viaDocument: true \}\)/);
});

// ---- the PDF --------------------------------------------------------------------
test('a Word policy is drawn as a PDF, and its hash is of the source file', async () => {
  const buf = docx([['Staff Code of Conduct', 'Heading1'], ['Treat every client with dignity.']]);
  const blocks = policyPdf.docxBlocks(buf);
  assert.deepStrictEqual(blocks.map(b => [b.text, b.heading]), [['Staff Code of Conduct', true], ['Treat every client with dignity.', false]]);
  const out = await policyPdf.buildPolicyPdf({ title: 'Staff Code of Conduct', version: '2.0', parts: [{ name: 'x', buf }] });
  assert.strictEqual(out.bytes.slice(0, 5).toString(), '%PDF-');
  assert.strictEqual(out.sourceSha256, require('crypto').createHash('sha256').update(buf).digest('hex'));
});

// ---- through the router ----------------------------------------------------------
const RN = { id: 'r1', name: 'Rae Nurse', email: 'rae@gfc.test', role: 'user', accountType: 'rn', clinicalRole: 'rn', hasClinicalAccess: true };
const CG = { id: 'c1', name: 'Cara Giver', email: 'cara@gfc.test', role: 'vendor', accountType: 'caregiver', licenseLevel: 'PCA' };

async function mount(t, store0) {
  const store = JSON.parse(JSON.stringify(store0 || {}));
  const db = { get: async (k) => (k in store ? JSON.parse(JSON.stringify(store[k])) : null), set: async (k, v) => { store[k] = JSON.parse(JSON.stringify(v)); } };
  let current = RN;
  const files = {};
  for (const a of T.ALL_ACKS) for (const id of a.driveFileIds || []) files[id] = docx([[a.title, 'Title'], [`The text of ${a.title}.`]]);
  const uploads = [];
  const drive = {
    downloadFileBuffer: async (id) => { if (!files[id]) throw new Error('File not found'); return files[id]; },
    uploadStaffDocumentFile: async (role, person, name, buf) => { const id = `DRV_${uploads.length + 1}`; files[id] = Buffer.from(buf); uploads.push({ name, id }); return { fileId: id }; },
    describeDriveError: (e) => ({ reason: e.message }), listFolderChildren: async () => [], getFileFingerprint: async () => ({})
  };
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use(portal({
    db, uuidv4: () => Math.random().toString(36).slice(2), drive, payrollIngestKey: 'k',
    detectFileType: () => 'application/pdf', logActivity: async () => {}, getUsers: async () => [RN, CG],
    enrollmentSummary: () => ({}), authenticateToken: (req, _res, next) => { req.user = current; next(); }
  }));
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    if ((res.headers.get('content-type') || '').includes('application/pdf')) return { status: res.status, bytes: Buffer.from(await res.arrayBuffer()) };
    let data = null; try { data = await res.json(); } catch (_) { /* empty */ }
    return { status: res.status, data };
  };
  return { store, uploads, call, as: (u) => { current = u; } };
}
const policies = (d) => ({ waiting: d.waiting.filter(x => x.kind === 'policy'), done: d.done.filter(x => x.kind === 'policy') });

test('a nurse sees the Code of Conduct waiting to SIGN, signs it on the signing screen, and it files and counts', async (t) => {
  // She clicked Acknowledge on it before the change, in onboarding.
  const rec = { id: 'rec1', userId: RN.id, inputs: T.normalizeInputs({ chapter: 'B' }),
    items: { 'B.5.03': { acknowledgments: { CODE_OF_CONDUCT: { version: '2.0', at: '2026-11-01T12:00:00Z', filedBy: 'SELF' } } } } };
  const h = await mount(t, { onboarding_records: [rec] });
  const mine = policies((await h.call('GET', '/api/my/document-sends')).data);
  const coc = mine.waiting.find(x => x.policyId === 'CODE_OF_CONDUCT');
  assert.ok(coc, 'waiting on her again: everyone re-signs');
  assert.strictEqual(coc.action, 'sign');
  assert.strictEqual(coc.needsSignature, true);
  assert.match(coc.note, /now has to be signed/);
  assert.strictEqual(mine.waiting.find(x => x.policyId === 'PHC_MANUAL').action, 'acknowledge');

  assert.strictEqual((await h.call('GET', '/api/my/policy-docs/CODE_OF_CONDUCT/file')).bytes.slice(0, 5).toString(), '%PDF-');
  const pre = await h.call('POST', '/api/my/policy-docs/CODE_OF_CONDUCT/preview', { printedName: 'Rae Nurse' });
  assert.strictEqual(pre.status, 200);
  assert.deepStrictEqual(Object.keys(h.store).sort(), ['onboarding_records'], 'the preview writes nothing');

  // A sign document refuses an acknowledgment without a signature.
  let r = await h.call('POST', '/api/my/policy-docs/CODE_OF_CONDUCT/sign', { printedName: 'Rae Nurse', acknowledged: true });
  assert.strictEqual(r.data.code, 'SIGNATURE_REQUIRED');
  r = await h.call('POST', '/api/my/policy-docs/CODE_OF_CONDUCT/sign', { printedName: 'Rae Nurse', acknowledged: true, signaturePng: SIG, version: '1.0' });
  assert.strictEqual(r.status, 200);

  const row = h.store.staff_policy_signings[0];
  assert.strictEqual(row.method, 'signed');
  assert.strictEqual(row.version, '2.0', 'the version the server states, whatever the page posts');
  const doc = h.store.caregiver_documents.find(d => d.id === r.data.documentId);
  assert.ok(doc && doc.kind === 'signed_document', 'filed to her Documents');
  const ack = h.store.onboarding_records[0].items['B.5.03'].acknowledgments.CODE_OF_CONDUCT;
  assert.strictEqual(ack.method, 'signed');
  assert.strictEqual(ack.documentId, r.data.documentId);
  assert.strictEqual(h.store.onboarding_records[0].items['B.5.03'].ackHistory.length, 1, 'her earlier acknowledgment is kept');

  const after = policies((await h.call('GET', '/api/my/document-sends')).data);
  assert.ok(!after.waiting.some(x => x.policyId === 'CODE_OF_CONDUCT'));
  assert.ok(after.done.some(x => x.policyId === 'CODE_OF_CONDUCT' && x.documentId === r.data.documentId));
  assert.strictEqual((await h.call('POST', '/api/my/policy-docs/CODE_OF_CONDUCT/sign', { printedName: 'Rae Nurse', acknowledged: true, signaturePng: SIG })).data.code, 'DOC_ALREADY_DONE');
});

test('an acknowledged policy needs the tick and a name, and no signature', async (t) => {
  const h = await mount(t);
  let r = await h.call('POST', '/api/my/policy-docs/PHC_MANUAL/sign', { printedName: 'Rae Nurse' });
  assert.strictEqual(r.data.code, 'ACK_REQUIRED');
  r = await h.call('POST', '/api/my/policy-docs/PHC_MANUAL/sign', { printedName: 'Rae Nurse', acknowledged: true });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(h.store.staff_policy_signings[0].method, 'acknowledged');
});

test('a policy that is not theirs is refused', async (t) => {
  const h = await mount(t);
  h.as(CG);
  const r = await h.call('POST', '/api/my/policy-docs/CLINICAL_MANUAL/sign', { printedName: 'Cara Giver', acknowledged: true });
  assert.strictEqual(r.status, 404);
  assert.strictEqual(r.data.code, 'POLICY_UNKNOWN');
});

test('the onboarding drawer opens policies on the signing screen and shows sign or acknowledge', () => {
  const page = read('public/onboarding.html');
  assert.match(page, /const PolicyAck = /);
  assert.match(page, /signs \? 'Open and Sign' : 'Open and Acknowledge'/);
  assert.match(page, /signs \? 'File Paper Signature' : 'File For Her'/);
  assert.match(read('public/document-sign-ui.js'), /`\/api\/my\/policy-docs\/\$\{encodeURIComponent\(d\.policyId\)\}\/sign`/);
});
