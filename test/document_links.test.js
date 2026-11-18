'use strict';

// Document Links (owner, 2026-11-16): every SOP, manual, policy and guide the app
// opens follows the Drive file the Super Admin chose, not a file id written into
// the code. Through the real router over HTTP; every check reads what is served.

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const S = require('../onboarding/sources');
const DL = require('../onboarding/documentLinks');
const T = require('../onboarding/track');
const TM = require('../onboarding/trainingMaterial');
const { findModule } = require('../onboarding/modules');

const NEW = '1NewSet1FileIdAAAAAAAAAAAAAAAAAA';
const ADMIN = { id: 'a1', name: 'Owner', role: 'admin' };
const MANAGER = { id: 'm1', name: 'Manager', role: 'user', accountType: 'manager', moduleAccess: { granted: ['onboarding'] } };

async function mount(t) {
  const store = {};
  const db = { get: async (k) => (k in store ? JSON.parse(JSON.stringify(store[k])) : null), set: async (k, v) => { store[k] = JSON.parse(JSON.stringify(v)); } };
  let current = ADMIN; const log = [];
  const app = express(); app.use(express.json());
  app.use(require('../routes/onboarding')({
    db, config: {}, logActivity: async (...a) => { log.push(a); }, getUsers: async () => [ADMIN, MANAGER],
    authenticateToken: (req, _res, next) => { req.user = current; next(); },
    drive: {}, detectFileType: () => null, uuidv4: () => 'x',
    sourceLoader: { manualState: async () => ({ ok: false }), checks: async () => ({ ok: true, sops: {}, library: {}, errors: [] }) }
  }));
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  t.after(() => { server.close(); S.setOverrides({}); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body) => {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  return { store, log, call, as: (u) => { current = u; } };
}

test('a Drive link in any usual shape gives its file id; anything else gives none', () => {
  assert.strictEqual(DL.parseDriveId(`https://drive.google.com/file/d/${NEW}/view?usp=sharing`), NEW);
  assert.strictEqual(DL.parseDriveId(`https://docs.google.com/document/d/${NEW}/edit`), NEW);
  assert.strictEqual(DL.parseDriveId(`https://drive.google.com/open?id=${NEW}`), NEW);
  assert.strictEqual(DL.parseDriveId(NEW), NEW);
  assert.strictEqual(DL.parseDriveId('https://example.com/policy.pdf'), null);
  assert.strictEqual(DL.parseDriveId(''), null);
});

test('one change moves every place the document opens: the source, the training link and the policy', () => {
  {
    S.setOverrides({ 'source:ADMIN_SOPS_SET1': NEW, 'source:ADMIN_MANUAL': NEW, 'policy:CODE_OF_CONDUCT': NEW });
    assert.strictEqual(S.SOURCES.ADMIN_SOPS_SET1.driveFileId, NEW);
    assert.strictEqual(S.driveViewUrl('ADMIN_SOPS_SET1'), `https://drive.google.com/file/d/${NEW}/view`);
    // A training link seeded before the change follows it.
    const seeded = TM.seedDefaults({}, 'T1').all['TRN-004'];
    const mat = TM.materialFor(findModule('TRN-004'), seeded, null);
    assert.ok(mat.links.some(l => l.url.includes(NEW)), 'the seeded Set 1 link opens the new file');
    // A policy with its own file, and a policy whose file is a source document.
    assert.deepStrictEqual(T.ALL_ACKS.find(a => a.id === 'CODE_OF_CONDUCT').driveFileIds, [NEW]);
    assert.deepStrictEqual(T.ALL_ACKS.find(a => a.id === 'ADMIN_MANUAL').driveFileIds, [NEW]);
  }
  S.setOverrides({});
  assert.strictEqual(S.SOURCES.ADMIN_SOPS_SET1.driveFileId, S.SOURCES.ADMIN_SOPS_SET1.defaultDriveFileId);
  assert.strictEqual(T.ALL_ACKS.find(a => a.id === 'EMPLOYEE_HANDBOOK').driveFileIds.length, 2, 'the Handbook keeps both default files');
  assert.ok(S.PAY_GUIDE.url.includes(S.SOURCES.STAFF_PAY_GUIDE.defaultDriveFileId));
});

test('the Super Admin changes a link, it is stored and applied, and Use Default undoes it', async (t) => {
  const h = await mount(t);
  let r = await h.call('GET', '/api/onboarding/admin/document-links');
  assert.strictEqual(r.status, 200); assert.strictEqual(r.data.canEdit, true);
  assert.ok(r.data.rows.some(x => x.key === 'source:ADMIN_SOPS_SET1'));
  assert.ok(r.data.rows.some(x => x.key === 'policy:CODE_OF_CONDUCT'), 'policies with their own file are listed');
  assert.ok(!r.data.rows.some(x => x.key === 'policy:ADMIN_MANUAL'), 'a policy that is a source document is covered by its source row');

  r = await h.call('PUT', '/api/onboarding/admin/document-links/source%3AADMIN_SOPS_SET1', { link: `https://drive.google.com/file/d/${NEW}/view` });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(h.store[DL.COLLECTION].overrides['source:ADMIN_SOPS_SET1'].fileId, NEW);
  assert.strictEqual(S.SOURCES.ADMIN_SOPS_SET1.driveFileId, NEW, 'applied at once');
  assert.ok(r.data.rows.find(x => x.key === 'source:ADMIN_SOPS_SET1').changed);
  assert.ok(h.log.some(a => a[2] === 'document_link_changed'), 'the change is logged');

  r = await h.call('PUT', '/api/onboarding/admin/document-links/source%3AADMIN_SOPS_SET1', { reset: true });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(S.SOURCES.ADMIN_SOPS_SET1.driveFileId, S.SOURCES.ADMIN_SOPS_SET1.defaultDriveFileId);
});

test('a bad link, an unknown document, and anyone but the Super Admin are refused, and nothing is stored', async (t) => {
  const h = await mount(t);
  let r = await h.call('PUT', '/api/onboarding/admin/document-links/source%3AADMIN_SOPS_SET1', { link: 'https://example.com/x.pdf' });
  assert.strictEqual(r.data.code, 'DOC_LINK_INVALID');
  r = await h.call('PUT', '/api/onboarding/admin/document-links/source%3ANOPE', { link: NEW });
  assert.strictEqual(r.status, 404);
  h.as(MANAGER);
  r = await h.call('GET', '/api/onboarding/admin/document-links');
  assert.strictEqual(r.status, 200); assert.strictEqual(r.data.canEdit, false, 'the office sees the list');
  r = await h.call('PUT', '/api/onboarding/admin/document-links/source%3AADMIN_SOPS_SET1', { link: NEW });
  assert.strictEqual(r.data.code, 'DOC_LINK_SUPER_ADMIN');
  assert.strictEqual(h.store[DL.COLLECTION], undefined);
});

test('a stored choice takes effect when the app starts, before anyone opens the list', async () => {
  const store = { [DL.COLLECTION]: { overrides: { 'source:STAFF_PAY_GUIDE': { fileId: NEW } } } };
  const db = { get: async (k) => store[k] || null, set: async () => {} };
  require('../routes/onboarding')({ db, config: {}, logActivity: async () => {}, getUsers: async () => [], authenticateToken: (q, s, n) => n(), drive: {}, detectFileType: () => null, uuidv4: () => 'x',
    sourceLoader: { manualState: async () => ({}), checks: async () => ({}) } });
  await new Promise(r => setTimeout(r, 20));
  assert.ok(S.PAY_GUIDE.url.includes(NEW));
  S.setOverrides({});
});

// Staff could not open policy links (2026-11-18): every one was a Private file.
test('sharing: only "anyone with the link" reads as open; private, domain-only and trashed are flagged', () => {
  assert.strictEqual(DL.sharingVerdict({ anyoneWithLink: true }).state, 'open');
  assert.strictEqual(DL.sharingVerdict({ anyoneWithLink: false, people: 1 }).state, 'private');
  assert.strictEqual(DL.sharingVerdict({ anyoneWithLink: false, domainWithLink: true }).state, 'domain');
  assert.strictEqual(DL.sharingVerdict({ anyoneWithLink: true, trashed: true }).state, 'trashed');
  assert.strictEqual(DL.sharingVerdict(null).state, 'unknown');
});

test('the sharing check reads every linked file, a failed read is never "open", and the worst file decides the row', async (t) => {
  const store = {};
  const db = { get: async (k) => store[k] || null, set: async (k, v) => { store[k] = v; } };
  const handbook = T.ALL_ACKS.find(a => a.id === 'EMPLOYEE_HANDBOOK').driveFileIds;
  const seen = [];
  const drive = { getLinkSharing: async (id) => {
    seen.push(id);
    if (id === S.SOURCES.TEAM_ROLES.driveFileId) return { anyoneWithLink: false, people: 1 };
    if (id === S.SOURCES.ADMIN_SOPS_SET2.driveFileId) throw new Error('boom');
    if (id === handbook[1]) return { anyoneWithLink: false };
    return { anyoneWithLink: true };
  } };
  const app = express(); app.use(express.json());
  app.use(require('../routes/onboarding')({ db, config: {}, logActivity: async () => {}, getUsers: async () => [ADMIN],
    authenticateToken: (req, _res, next) => { req.user = ADMIN; next(); }, drive, detectFileType: () => null, uuidv4: () => 'x',
    sourceLoader: { manualState: async () => ({ ok: false }), checks: async () => ({ ok: true, sops: {}, library: {}, errors: [] }) } }));
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  t.after(() => server.close());
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/onboarding/admin/document-links/sharing`);
  const j = await res.json();
  const by = Object.fromEntries(j.rows.map(r => [r.key, r]));
  assert.strictEqual(by['source:TEAM_ROLES'].state, 'private');
  assert.strictEqual(by['source:ADMIN_SOPS_SET2'].state, 'unknown', 'a failed read is not a pass');
  assert.strictEqual(by['source:ADMIN_SOPS_SET1'].state, 'open');
  assert.strictEqual(by['policy:EMPLOYEE_HANDBOOK'].state, 'private', 'one private file of two flags the row');
  assert.strictEqual(by['policy:EMPLOYEE_HANDBOOK'].files, 2);
  assert.ok(handbook.every(id => seen.includes(id)), 'both Handbook files are checked');
  assert.strictEqual(new Set(seen).size, seen.length, 'each file is read once');
});

test('the sharing check says Drive is not connected rather than calling files open', async (t) => {
  const h = await mount(t);
  const r = await h.call('GET', '/api/onboarding/admin/document-links/sharing');
  assert.strictEqual(r.status, 503);
  assert.strictEqual(r.data.code, 'DOC_LINK_SHARING_UNAVAILABLE');
});
