'use strict';

// Documents the office sends staff to review or sign (owner, 2026-11-09),
// through the real router over HTTP with a fake store and a fake Drive that
// keeps the bytes. Assertions read what was stored, filed or returned.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const portal = require('../routes/staffPortal');
const DS = require('../staffDocumentSends');
const T = require('../onboarding/track');
const signedDocument = require('../onboarding/signedDocument');

const ADMIN = { id: 'a1', name: 'Office Admin', role: 'admin', email: 'admin@gfc.test' };
const MGR = { id: 'm1', name: 'Mona Manager', role: 'user', accountType: 'manager', isManager: true, email: 'mona@gfc.test' };
const NP = { id: 'n1', name: 'Bethel Godwins', email: 'bethel@gfc.test', role: 'user', accountType: 'provider', clinicalRole: 'provider', hasClinicalAccess: true };
const RN = { id: 'r1', name: 'Rae Nurse', email: 'rae@gfc.test', role: 'user', accountType: 'rn', clinicalRole: 'rn', hasClinicalAccess: true };
const CG = { id: 'c1', name: 'Cara Giver', email: 'cara@gfc.test', role: 'vendor', accountType: 'caregiver', licenseLevel: 'PCA' };
const CLIENT = { id: 'p1', name: 'Pat Client', role: 'client', accountType: 'client' };
const SIG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

async function makePdf(text) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  page.drawText(text, { x: 72, y: 700, size: 14, font: await doc.embedFont(StandardFonts.Helvetica) });
  return Buffer.from(await doc.save());
}

async function mount(t) {
  const store = {};
  const db = { get: async (k) => (k in store ? JSON.parse(JSON.stringify(store[k])) : null), set: async (k, v) => { store[k] = JSON.parse(JSON.stringify(v)); } };
  let current = ADMIN;
  const logged = [];
  const files = {};
  const uploads = [];
  const drive = {
    downloadFileBuffer: async (id) => { if (!files[id]) throw new Error('File not found'); return files[id]; },
    uploadStaffDocumentFile: async (role, person, name, buf) => { const id = `DRV_${uploads.length + 1}`; files[id] = Buffer.from(buf); uploads.push({ role, person, name, id }); return { fileId: id }; },
    describeDriveError: (e) => ({ reason: e.message }),
    listFolderChildren: async () => [], getFileFingerprint: async () => ({})
  };
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use(portal({
    db, uuidv4: () => Math.random().toString(36).slice(2), drive, payrollIngestKey: 'k',
    detectFileType: (buf) => (buf.slice(0, 4).toString() === '%PDF' ? 'application/pdf' : null),
    logActivity: async (...a) => { logged.push(a); },
    getUsers: async () => [ADMIN, MGR, NP, RN, CG, CLIENT],
    enrollmentSummary: () => ({}),
    authenticateToken: (req, _res, next) => { req.user = current; next(); }
  }));
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const type = res.headers.get('content-type') || '';
    if (type.includes('application/pdf')) return { status: res.status, bytes: Buffer.from(await res.arrayBuffer()) };
    let data = null; try { data = await res.json(); } catch (_) { /* empty */ }
    return { status: res.status, data };
  };
  const send = async (fields, buf) => {
    const fd = new FormData();
    if (buf !== null) fd.append('file', new Blob([buf || await makePdf('Employment Agreement')], { type: 'application/pdf' }), 'Agreement.pdf');
    for (const [k, v] of Object.entries(fields)) fd.append(k, typeof v === 'string' ? v : JSON.stringify(v));
    const res = await fetch(base + '/api/my/admin/document-sends', { method: 'POST', body: fd });
    return { status: res.status, data: await res.json() };
  };
  return { store, logged, files, uploads, call, send, as: (u) => { current = u; } };
}

const SIGN_BODY = { printedName: 'Rae Nurse', acknowledged: true, signaturePng: SIG };

test('the office sends a PDF to one person; only that person sees it waiting', async (t) => {
  const h = await mount(t);
  const r = await h.send({ title: 'Employment Agreement', action: 'sign', scope: { userId: RN.id }, note: 'Please sign by Friday.' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  const row = h.store.staff_document_sends[0];
  assert.strictEqual(row.action, 'sign');
  assert.deepStrictEqual(row.scope, { userId: RN.id });
  assert.match(row.sha256, /^[a-f0-9]{64}$/);
  assert.ok(row.driveFileId, 'the original is stored in Drive');
  assert.deepStrictEqual(r.data.send.recipients.map(x => x.userId), [RN.id]);
  h.as(RN);
  const mine = (await h.call('GET', '/api/my/document-sends')).data;
  assert.deepStrictEqual(mine.waiting.map(x => x.title), ['Employment Agreement']);
  assert.strictEqual(mine.waiting[0].note, 'Please sign by Friday.');
  h.as(NP);
  assert.deepStrictEqual((await h.call('GET', '/api/my/document-sends')).data.waiting, []);
  // A person it did not reach cannot open it either.
  assert.strictEqual((await h.call('GET', `/api/my/document-sends/${row.id}/file`)).status, 404);
});

test('a send to a type reaches everyone of that type, and "all" reaches every staff member', async (t) => {
  const h = await mount(t);
  await h.send({ title: 'Nursing Policy', action: 'acknowledge', scope: { types: ['rn'] } });
  await h.send({ title: 'Handbook Update', action: 'acknowledge', scope: { types: ['all'] } });
  h.as(RN);
  assert.deepStrictEqual((await h.call('GET', '/api/my/document-sends')).data.waiting.map(x => x.title).sort(), ['Handbook Update', 'Nursing Policy']);
  h.as(CG);
  assert.deepStrictEqual((await h.call('GET', '/api/my/document-sends')).data.waiting.map(x => x.title), ['Handbook Update']);
  h.as(CLIENT);
  assert.strictEqual((await h.call('GET', '/api/my/document-sends')).status, 403, 'a client is not staff');
});

test('the send refuses a missing file, a non-PDF, no action and nobody to send to', async (t) => {
  const h = await mount(t);
  assert.strictEqual((await h.send({ title: 'X', action: 'sign', scope: { userId: RN.id } }, null)).data.code, 'NO_FILE');
  assert.strictEqual((await h.send({ title: 'X', action: 'sign', scope: { userId: RN.id } }, Buffer.from('hello world'))).data.code, 'DOC_NOT_PDF');
  assert.strictEqual((await h.send({ title: 'X', action: 'approve', scope: { userId: RN.id } })).data.code, 'DOC_ACTION_REQUIRED');
  assert.strictEqual((await h.send({ title: 'X', action: 'sign', scope: { userId: CLIENT.id } })).data.code, 'DOC_SCOPE_REQUIRED');
  assert.strictEqual((await h.send({ title: 'X', action: 'sign', scope: { types: ['client'] } })).data.code, 'DOC_SCOPE_REQUIRED');
  assert.strictEqual((await h.send({ title: '', action: 'sign', scope: { userId: RN.id } })).data.code, 'DOC_TITLE_REQUIRED');
  assert.ok(!h.store.staff_document_sends, 'nothing was stored on a refusal');
  h.as(RN);
  assert.strictEqual((await h.send({ title: 'X', action: 'sign', scope: { userId: RN.id } })).status, 403, 'only the admin team sends');
});

test('signing files the original plus a signature page to Drive and to their Documents', async (t) => {
  const h = await mount(t);
  const original = await makePdf('Employment Agreement');
  await h.send({ title: 'Employment Agreement', action: 'sign', scope: { userId: RN.id } }, original);
  const id = h.store.staff_document_sends[0].id;
  h.as(RN);
  const r = await h.call('POST', `/api/my/document-sends/${id}/sign`, SIGN_BODY);
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  const doc = h.store.caregiver_documents.find(d => d.id === r.data.documentId);
  assert.strictEqual(doc.caregiver_id, RN.id);
  assert.strictEqual(doc.kind, 'signed_document');
  assert.strictEqual(doc.status, 'accepted');
  // The filed copy is the original's page plus the record page.
  const filed = await PDFDocument.load(h.files[doc.drive_file_id]);
  assert.strictEqual(filed.getPageCount(), 2);
  const signing = h.store.staff_document_signings[0];
  assert.strictEqual(signing.originalSha256, signedDocument.sha256(original));
  assert.strictEqual(signing.printedName, 'Rae Nurse');
  // It stored in the person's staff folder, not the "Sent" folder.
  assert.notStrictEqual(h.uploads[1].person, 'Sent');
  // Now done, not waiting, and pointing at the copy.
  const mine = (await h.call('GET', '/api/my/document-sends')).data;
  assert.deepStrictEqual(mine.waiting, []);
  assert.strictEqual(mine.done[0].documentId, doc.id);
  // They open their copy; the office sees it as done on the send.
  assert.strictEqual((await h.call('GET', `/api/my/documents/${doc.id}/file`)).status, 200);
  h.as(MGR);
  const office = (await h.call('GET', `/api/my/admin/document-sends?userId=${RN.id}`)).data.sends[0];
  assert.deepStrictEqual(office.recipients.map(x => [x.userId, x.done, x.documentId]), [[RN.id, true, doc.id]]);
  assert.ok(h.logged.some(a => a[2] === 'document_signed'));
});

test('signing is refused without a signature, a name or the box, and twice', async (t) => {
  const h = await mount(t);
  await h.send({ title: 'Agreement', action: 'sign', scope: { userId: RN.id } });
  await h.send({ title: 'Policy', action: 'acknowledge', scope: { userId: RN.id } });
  const [sign, ack] = h.store.staff_document_sends.map(s => s.id);
  h.as(RN);
  assert.strictEqual((await h.call('POST', `/api/my/document-sends/${sign}/sign`, { printedName: 'Rae', acknowledged: true })).data.code, 'SIGNATURE_REQUIRED');
  assert.strictEqual((await h.call('POST', `/api/my/document-sends/${sign}/sign`, { printedName: ' ', acknowledged: true, signaturePng: SIG })).data.code, 'NAME_REQUIRED');
  assert.strictEqual((await h.call('POST', `/api/my/document-sends/${ack}/sign`, { printedName: 'Rae' })).data.code, 'ACK_REQUIRED');
  assert.ok(!h.store.staff_document_signings, 'a refusal records nothing');
  assert.strictEqual((await h.call('POST', `/api/my/document-sends/${ack}/sign`, { printedName: 'Rae', acknowledged: true })).status, 200, 'acknowledging needs no drawn signature');
  assert.strictEqual((await h.call('POST', `/api/my/document-sends/${ack}/sign`, { printedName: 'Rae', acknowledged: true })).data.code, 'DOC_ALREADY_DONE');
  // Someone it was not sent to cannot sign it.
  h.as(NP);
  assert.strictEqual((await h.call('POST', `/api/my/document-sends/${sign}/sign`, SIGN_BODY)).status, 404);
});

test('a document changed after it was sent is refused, not signed', async (t) => {
  const h = await mount(t);
  await h.send({ title: 'Agreement', action: 'sign', scope: { userId: RN.id } });
  const row = h.store.staff_document_sends[0];
  h.files[row.driveFileId] = await makePdf('A different agreement');
  h.as(RN);
  assert.strictEqual((await h.call('POST', `/api/my/document-sends/${row.id}/sign`, SIGN_BODY)).data.code, 'DOC_CHANGED');
});

test('a withdrawn document leaves the waiting list, and copies already signed stay filed', async (t) => {
  const h = await mount(t);
  await h.send({ title: 'Agreement', action: 'acknowledge', scope: { types: ['rn', 'provider'] } });
  const id = h.store.staff_document_sends[0].id;
  h.as(RN);
  await h.call('POST', `/api/my/document-sends/${id}/sign`, { printedName: 'Rae', acknowledged: true });
  h.as(ADMIN);
  assert.strictEqual((await h.call('DELETE', `/api/my/admin/document-sends/${id}`)).status, 200);
  assert.ok(h.store.staff_document_sends[0].removedAt, 'kept, marked withdrawn');
  h.as(NP);
  assert.deepStrictEqual((await h.call('GET', '/api/my/document-sends')).data.waiting, []);
  assert.strictEqual(h.store.caregiver_documents.length, 1, 'the signed copy is still on file');
});

test('an onboarding task carrying a document completes when the document is signed', async (t) => {
  const h = await mount(t);
  await h.send({ title: 'Contractor Agreement', action: 'sign', scope: { userId: RN.id } });
  const sendId = h.store.staff_document_sends[0].id;
  h.store.onboarding_custom_tasks = [{ id: 'GFC-abc12345', title: 'Contractor Agreement', scope: { userId: RN.id }, documentSendId: sendId, documentAction: 'sign' }];
  h.store.onboarding_records = [{ userId: RN.id, inputs: { chapter: 'C' }, items: {} }];
  h.as(RN);
  const r = await h.call('POST', `/api/my/document-sends/${sendId}/sign`, SIGN_BODY);
  const state = h.store.onboarding_records[0].items['GFC-abc12345'];
  assert.ok(state && state.steps && state.steps[0], 'step recorded');
  assert.strictEqual(state.files[0].documentId, r.data.documentId, 'the signed copy is attached to the task');
});

test('the task step cannot be marked done by hand, only by signing', () => {
  const item = T.customItem({ id: 'GFC-x', title: 'Agreement', scope: { userId: 'u' }, documentSendId: 'send_1', documentAction: 'acknowledge' });
  assert.strictEqual(item.steps[0].action, 'ACKNOWLEDGE');
  assert.deepStrictEqual(item.document, { sendId: 'send_1', action: 'acknowledge', title: 'Agreement' });
  assert.throws(() => T.recordStep(item, {}, 0, { id: 'u', name: 'U' }, {}, new Date().toISOString()), e => e.code === 'DOCUMENT_SIGN_ROUTE');
  assert.throws(() => T.recordStep(item, {}, 0, { id: 'u', name: 'U' }, {}, new Date().toISOString(), {}), e => e.code === 'DOCUMENT_SIGN_ROUTE');
  assert.throws(() => T.recordStep(item, {}, 0, { id: 'u', name: 'U' }, { viaDocument: true }, new Date().toISOString()), e => e.code === 'DOCUMENT_SIGN_ROUTE', 'a request body cannot claim it');
  assert.ok(T.recordStep(item, {}, 0, { id: 'u', name: 'U' }, {}, new Date().toISOString(), { viaDocument: true }).steps[0]);
  // A task without a document is unchanged.
  assert.strictEqual(T.customItem({ id: 'GFC-y', title: 'Shadow', scope: { userId: 'u' } }).steps[0].action, 'COMPLETE');
});

test('scope rules: one person, types, a chapter, and never a withdrawn send', () => {
  const p = { userId: 'r1', audience: 'rn', chapter: 'C' };
  assert.ok(DS.reaches({ scope: { userId: 'r1' } }, p));
  assert.ok(!DS.reaches({ scope: { userId: 'x' } }, p));
  assert.ok(DS.reaches({ scope: { types: ['rn'] } }, p));
  assert.ok(DS.reaches({ scope: { types: ['all'] } }, p));
  assert.ok(!DS.reaches({ scope: { types: ['provider'] } }, p));
  assert.ok(DS.reaches({ scope: { chapter: 'C' } }, p));
  assert.ok(!DS.reaches({ scope: { chapter: 'A' } }, p));
  assert.ok(!DS.reaches({ scope: { types: ['all'] }, removedAt: 'x' }, p));
  assert.ok(!DS.reaches({ scope: { types: ['all'] } }, { userId: 'p1', audience: null }), 'a non-staff account is never reached');
});

test('the signature page names the signer and the original', async () => {
  const original = await makePdf('Agreement');
  const out = await signedDocument.buildSignedCopy(original, { action: 'sign', title: 'Agreement', printedName: 'Rae Nurse',
    email: 'rae@gfc.test', signedAt: '2026-11-09T15:00:00Z', signedAtLabel: 'November 9, 2026 10:00 AM Eastern', ipHash: 'abc', signaturePng: SIG });
  assert.strictEqual(out.originalSha256, signedDocument.sha256(original));
  const doc = await PDFDocument.load(out.bytes);
  assert.strictEqual(doc.getPageCount(), 2);
  // pdf-lib writes text as hex inside compressed streams; read them back.
  const zlib = require('zlib');
  const raw = out.bytes.toString('latin1');
  let text = '';
  for (const m of raw.matchAll(/stream\r?\n([\s\S]*?)endstream/g)) {
    try { text += zlib.inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1'); } catch (_) { text += m[1]; }
  }
  const hex = (str) => Buffer.from(str).toString('hex').toUpperCase();
  assert.ok(text.toUpperCase().includes(hex('Rae Nurse')), 'the printed name is drawn');
  assert.ok(text.toUpperCase().includes(hex(out.originalSha256.slice(0, 16))), 'the original document hash is drawn');
});

// ---- Build-enforced wiring ---------------------------------------------------
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

test('the sign route is blocked while viewing as someone else', () => {
  const imp = require('../impersonation');
  const list = imp.BLOCKED_WHILE_ACTING_AS || [];
  assert.ok(list.some(b => b.method === 'POST' && b.pattern.test('/api/my/document-sends/send_abc/sign')));
});

test('both collections are registered for migration', () => {
  const src = read('dataMigration.js');
  assert.match(src, /key: 'staff_document_sends'/);
  assert.match(src, /key: 'staff_document_signings'/);
});

test('the screens: My GFC waits on them, the staff record and Admin Hub send, onboarding signs in the drawer', () => {
  const ui = read('public/document-sign-ui.js');
  assert.match(ui, /window\.GFCDocSign = \{/);
  assert.match(ui, /GFCWelcomePacketUI\.SignaturePad/, 'the shared signature pad, not a second one');
  assert.match(ui, /\(!userId \|\| \(s\.scope && s\.scope\.userId === String\(userId\)\)\) && <button className="ds-btn ds-warn"/, 'a person\'s record withdraws only what went to them alone');
  assert.doesNotMatch(ui.replace(/\/\/.*$/gm, ''), /\?token=/, 'the token goes in the header, never the URL');
  assert.match(read('public/my-gfc.js'), /GFCDocSign\.WaitingOnYou/);
  const hub = read('public/admin-hub.html');
  assert.match(hub, /<window\.GFCDocSign\.OfficeDocuments userId=/, 'one person, on their Staff Record');
  assert.match(hub, /case 'documents':[\s\S]{0,600}<window\.GFCDocSign\.OfficeDocuments \/>/, 'by type, on its own page');
  const ob = read('public/onboarding.html');
  assert.match(ob, /<DocSign\.WaitingOnYou only=\{item\.document\.sendId\}/);
  assert.match(ob, /!\(item\.document && s\.index === 0\)/, 'no Mark Done on a document step');
  for (const f of ['public/my.html', 'public/caregiver.html', 'public/admin-hub.html', 'public/onboarding.html']) {
    assert.match(read(f), /src="\/document-sign-ui\.js"/, f);
  }
});
