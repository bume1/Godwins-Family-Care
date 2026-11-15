'use strict';

// Staff know a document is waiting on them (owner, 2026-11-13: "documents sent
// for signature don't appear in the staff portal for their awareness ... the
// banner still shows that nothing is waiting"). Each recipient is emailed, and
// Home and the menu say so.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { PDFDocument } = require('pdf-lib');
const portal = require('../routes/staffPortal');
const links = require('../appLinks');

const ADMIN = { id: 'a1', name: 'Office Admin', role: 'admin', email: 'admin@gfc.test' };
const MGR = { id: 'm1', name: 'Mona Manager', role: 'user', accountType: 'manager', isManager: true, email: 'mona@gfc.test' };
const CG = { id: 'c1', name: 'Cara Giver', email: 'cara@gfc.test', role: 'vendor', accountType: 'caregiver', licenseLevel: 'PCA' };
const CG2 = { id: 'c2', name: 'Cal Giver', email: 'cal@gfc.test', role: 'vendor', accountType: 'caregiver', licenseLevel: 'PCA' };

async function mount(t, { notify } = {}) {
  const store = {};
  const db = { get: async (k) => (k in store ? JSON.parse(JSON.stringify(store[k])) : null), set: async (k, v) => { store[k] = JSON.parse(JSON.stringify(v)); } };
  let current = ADMIN;
  const sent = [];
  const fakeNotify = notify === undefined ? { staffDocumentSent: async (a) => { sent.push(a); return { notified: 1 }; } } : notify;
  const app = express();
  app.use(express.json());
  app.use(portal({
    db, uuidv4: () => Math.random().toString(36).slice(2), payrollIngestKey: 'k',
    drive: { uploadStaffDocumentFile: async () => ({ fileId: 'DRV_1' }), downloadFileBuffer: async () => Buffer.from('%PDF') },
    detectFileType: (buf) => (buf.slice(0, 4).toString() === '%PDF' ? 'application/pdf' : null),
    logActivity: async () => {}, getUsers: async () => [ADMIN, MGR, CG, CG2], enrollmentSummary: () => ({}),
    authenticateToken: (req, _res, next) => { req.user = current; next(); },
    notify: () => fakeNotify, getAppBaseUrl: async () => 'https://app.test'
  }));
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const pdf = Buffer.from(await (await PDFDocument.create()).save());
  const send = async (fields) => {
    const fd = new FormData();
    fd.append('file', new Blob([pdf], { type: 'application/pdf' }), 'Agreement.pdf');
    for (const [k, v] of Object.entries(fields)) fd.append(k, typeof v === 'string' ? v : JSON.stringify(v));
    return (await fetch(base + '/api/my/admin/document-sends', { method: 'POST', body: fd })).json();
  };
  const mine = async (u) => { current = u; const r = await (await fetch(base + '/api/my/document-sends')).json(); current = ADMIN; return r; };
  return { send, mine, sent, store };
}

test('a document sent to caregivers reaches each one and emails each one, with a link to their own Documents', async (t) => {
  const h = await mount(t);
  const r = await h.send({ title: 'Updated handbook', action: 'acknowledge', scope: { types: ['caregiver'] } });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.emailed, 2);
  assert.deepStrictEqual(h.sent.map(s => s.user.id).sort(), ['c1', 'c2']);
  assert.ok(h.sent.every(s => s.ctaUrl === 'https://app.test/caregiver#documents'));
  assert.ok(h.sent.every(s => s.title === 'Updated handbook' && s.action === 'acknowledge'));
  assert.strictEqual((await h.mine(CG)).waiting.length, 1);
  assert.strictEqual((await h.mine(MGR)).waiting.length, 0);
});

test('a document sent to one manager emails only them, to My GFC', async (t) => {
  const h = await mount(t);
  const r = await h.send({ title: 'Offer letter', action: 'sign', scope: { userId: 'm1' } });
  assert.strictEqual(r.emailed, 1);
  assert.strictEqual(h.sent[0].ctaUrl, 'https://app.test/my#documents');
  assert.strictEqual((await h.mine(MGR)).waiting[0].title, 'Offer letter');
});

test('a missing notifier never fails the send', async (t) => {
  const h = await mount(t, { notify: null });
  const r = await h.send({ title: 'Policy', action: 'sign', scope: { userId: 'c1' } });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.emailed, 0);
});

test('the notice names the document and never attaches it', async () => {
  const queued = [];
  const notifier = require('../notifications').createNotifier({
    queueNotification: async (...a) => { queued.push(a); return { id: 'q' }; },
    getUsers: async () => [], getAppBaseUrl: async () => 'https://app.test',
    emailTransport: { transportStatus: () => ({ baaCovered: true }) }, staffRoles: ['admin'], clientRole: 'client', familyRole: 'family'
  });
  const out = await notifier.staffDocumentSent({ user: CG, title: 'Updated handbook', action: 'sign', sendId: 's1', ctaUrl: 'https://app.test/caregiver#documents' });
  assert.strictEqual(out.notified, 1);
  const [type, userId, email, , data] = queued[0];
  assert.strictEqual(type, 'staff_document_sent');
  assert.strictEqual(userId, 'c1'); assert.strictEqual(email, 'cara@gfc.test');
  assert.match(data.subject, /waiting for you to sign/);
  assert.match(data.body, /Updated handbook/);
  assert.ok(!data.attachments, 'no file goes by email');
  assert.strictEqual(links.documentsFor(CG), '/caregiver#documents');
  assert.strictEqual(links.documentsFor(MGR), '/my#documents');
});

test('the pages: Home banner, menu count, and the caregiver card counts what is waiting', () => {
  const root = path.join(__dirname, '..', 'public');
  const lib = fs.readFileSync(path.join(root, 'my-gfc.js'), 'utf8');
  const my = fs.readFileSync(path.join(root, 'my.html'), 'utf8');
  const cg = fs.readFileSync(path.join(root, 'caregiver.html'), 'utf8');
  assert.match(lib, /call\('\/api\/my\/document-sends'\)\.then\(d => setSends\(d\.waiting/);
  assert.match(lib, /loadNews\(\);\s*loadSends\(\);/, 'loaded when the page opens');
  assert.match(lib, /const reloadDocs = useCallback\(\(\) => \{ loadSends\(\);/, 'signing clears the banner');
  assert.match(my, /<window\.MyGFC\.DocsWaitingBanner docs=\{data\.waitingDocs\} onOpen=\{\(\) => go\('documents'\)\} \/>/);
  assert.match(my, /s\.id === 'documents' \? \{ \.\.\.s, count: data\.waitingDocs\.length \}/);
  assert.match(cg, /<window\.MyGFC\.DocsWaitingBanner docs=\{waitingDocs\} onOpen=\{onOpenDocs\} \/>/);
  assert.match(cg, /waitingDocs=\{staff\.waitingDocs\} onOpenDocs=\{\(\) => setTab\('documents'\)\}/);
  assert.match(cg, /concat\(\(waitingDocs \|\| \[\]\)\.map/, 'the card never says nothing is waiting while a document is');
  assert.match(cg, /me\.onboarding\.cleared && !theirs\.length/);
});
