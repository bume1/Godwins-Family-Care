'use strict';

// A document the office attaches to one person's onboarding item (owner,
// 2026-11-10): she signs it from the item, her step completes, and the
// signed copy is filed and opens from the item.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { PDFDocument } = require('pdf-lib');
const VF = require('../onboarding/versionFlags');

const OFFICE = { id: 'a1', name: 'Office Admin', role: 'admin', email: 'admin@gfc.test' };
const NP = { id: 'n1', name: 'Nia Provider', email: 'nia@gfc.test', role: 'user', accountType: 'provider', clinicalRole: 'provider', hasClinicalAccess: true };
const NP2 = { id: 'n2', name: 'Noa Provider', email: 'noa@gfc.test', role: 'user', accountType: 'provider', clinicalRole: 'provider', hasClinicalAccess: true };
const SIG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

async function mount(t) {
  const store = {};
  const db = { get: async (k) => (k in store ? JSON.parse(JSON.stringify(store[k])) : null), set: async (k, v) => { store[k] = JSON.parse(JSON.stringify(v)); } };
  let current = OFFICE;
  const files = {}; let n = 0;
  const drive = {
    downloadFileBuffer: async (id) => { if (!files[id]) throw new Error('File not found'); return files[id]; },
    uploadStaffDocumentFile: async (a, b, name, buf) => { const id = `D${++n}`; files[id] = Buffer.from(buf); return { fileId: id }; },
    describeDriveError: (e) => ({ reason: e.message }), listFolderChildren: async () => [], getFileFingerprint: async () => ({})
  };
  const auth = (req, _res, next) => { req.user = current; next(); };
  const detect = (b) => (b.slice(0, 4).toString() === '%PDF' ? 'application/pdf' : null);
  const app = express(); app.use(express.json({ limit: '2mb' }));
  app.use(require('../routes/staffPortal')({ db, uuidv4: () => Math.random().toString(36).slice(2), drive, payrollIngestKey: 'k', detectFileType: detect,
    logActivity: async () => {}, getUsers: async () => [OFFICE, NP, NP2], enrollmentSummary: () => ({}), authenticateToken: auth }));
  app.use(require('../routes/onboarding')({ db, config: {}, logActivity: async () => {}, getUsers: async () => [OFFICE, NP, NP2], authenticateToken: auth, drive,
    detectFileType: detect, uuidv4: () => Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2), notify: () => null, getAppBaseUrl: async () => 'x',
    sourceLoader: { manualState: async () => ({ ok: true, currentVersion: '2.2', changeLog: VF.SEEDED_CHANGES.slice() }), checks: async () => ({ ok: true, sops: {}, library: {}, errors: [] }) } }));
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    if ((res.headers.get('content-type') || '').includes('pdf')) return { status: res.status, bytes: Buffer.from(await res.arrayBuffer()) };
    let data = null; try { data = await res.json(); } catch (_) { /* empty */ } return { status: res.status, data };
  };
  const send = async (userId) => {
    const d = await PDFDocument.create(); d.addPage();
    const fd = new FormData();
    fd.append('file', new Blob([Buffer.from(await d.save())], { type: 'application/pdf' }), 'Agreement.pdf');
    fd.append('title', 'Employment Agreement'); fd.append('action', 'sign'); fd.append('scope', JSON.stringify({ userId }));
    return (await (await fetch(base + '/api/my/admin/document-sends', { method: 'POST', body: fd })).json()).send;
  };
  return { store, call, send, as: (u) => { current = u; } };
}

test('the office attaches a document to her item; she signs it from there; the item completes and the copy opens', async (t) => {
  const h = await mount(t);
  await h.call('PUT', `/api/onboarding/admin/people/${NP.id}/inputs`, { chapter: 'C' });
  await h.call('PUT', `/api/onboarding/admin/people/${NP2.id}/inputs`, { chapter: 'C' });
  const s = await h.send(NP.id);
  assert.strictEqual((await h.call('PUT', `/api/onboarding/admin/people/${NP.id}/items/C.5.03/document`, { documentSendId: s.id })).status, 200);

  h.as(NP);
  let item = (await h.call('GET', '/api/onboarding/me')).data.track.items.find(i => i.id === 'C.5.03');
  assert.deepStrictEqual(item.document, { sendId: s.id, action: 'sign', title: 'Employment Agreement' });
  const hers = item.steps.findIndex(x => x.hers);
  assert.strictEqual((await h.call('POST', `/api/onboarding/me/items/C.5.03/steps/${hers}`, {})).data.code, 'DOCUMENT_SIGN_ROUTE', 'no Mark Done');
  assert.strictEqual((await h.call('POST', `/api/my/document-sends/${s.id}/sign`, { printedName: 'Nia Provider', acknowledged: true, signaturePng: SIG })).status, 200);
  item = (await h.call('GET', '/api/onboarding/me')).data.track.items.find(i => i.id === 'C.5.03');
  assert.ok(item.steps[hers].done, 'her step is done');
  const file = item.files.find(f => /signed/.test(f.name));
  assert.ok(file, 'the signed copy is on the item');
  const opened = await h.call('GET', `/api/onboarding/me/items/C.5.03/files/${file.id}`);
  assert.strictEqual(opened.status, 200);
  assert.strictEqual((await PDFDocument.load(opened.bytes)).getPageCount(), 2, 'original plus the signature page');

  h.as(NP2);
  const other = (await h.call('GET', '/api/onboarding/me')).data.track.items.find(i => i.id === 'C.5.03');
  assert.strictEqual(other.document, null, 'another person with the same item is untouched');
});

test('attaching the offer letter records the office having issued it, then she signs', async (t) => {
  const h = await mount(t);
  await h.call('PUT', `/api/onboarding/admin/people/${NP.id}/inputs`, { chapter: 'C' });
  const s = await h.send(NP.id);
  await h.call('PUT', `/api/onboarding/admin/people/${NP.id}/items/C.5.01/document`, { documentSendId: s.id });
  h.as(NP);
  let item = (await h.call('GET', '/api/onboarding/me')).data.track.items.find(i => i.id === 'C.5.01');
  assert.ok(item.steps[0].done && !item.steps[0].hers, 'the office step is done');
  assert.strictEqual(item.next.hers, true, 'now waiting on her');
  await h.call('POST', `/api/my/document-sends/${s.id}/sign`, { printedName: 'Nia Provider', acknowledged: true, signaturePng: SIG });
  item = (await h.call('GET', '/api/onboarding/me')).data.track.items.find(i => i.id === 'C.5.01');
  assert.strictEqual(item.status, 'COMPLETE');
});

test('attaching refuses a document sent to someone else, and only the office attaches', async (t) => {
  const h = await mount(t);
  await h.call('PUT', `/api/onboarding/admin/people/${NP.id}/inputs`, { chapter: 'C' });
  const s = await h.send(NP2.id);
  assert.strictEqual((await h.call('PUT', `/api/onboarding/admin/people/${NP.id}/items/C.5.03/document`, { documentSendId: s.id })).data.code, 'ITEM_DOCUMENT_NOT_THEIRS');
  h.as(NP);
  assert.strictEqual((await h.call('PUT', `/api/onboarding/admin/people/${NP.id}/items/C.5.03/document`, { documentSendId: s.id })).status, 403);
});

test('the side panel offers Attach Document to Sign to the office', () => {
  const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'onboarding.html'), 'utf8');
  assert.match(page, /\{office && !item\.document && item\.steps\.some\(s => s\.hers\) && track\.person && <AttachDocument/);
});
