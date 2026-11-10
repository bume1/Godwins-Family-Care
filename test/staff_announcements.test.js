'use strict';

// My GFC → Announcements (owner, 2026-11-10): office news for every staff
// member, read from the caregiver Feed's own rows through one audience rule.

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const config = require('../config');
const A = require('../staffAnnouncements');

const ADMIN = { id: 'a1', name: 'Office Admin', role: 'admin', email: 'admin@gfc.test' };
const COORD = { id: 'k1', name: 'Coco Ordinator', role: 'user', accountType: 'coordinator', email: 'coco@gfc.test' };
const RN = { id: 'r1', name: 'Rae Nurse', role: 'user', accountType: 'rn', clinicalRole: 'rn', hasClinicalAccess: true };
const CG = { id: 'c1', name: 'Cara Giver', role: 'vendor', accountType: 'caregiver', licenseLevel: 'PCA' };
const CLIENT = { id: 'p1', name: 'Pat Client', role: 'client', accountType: 'client' };
const FAMILY = { id: 'f1', name: 'Fay Mily', role: 'family', accountType: 'family' };
const USERS = [ADMIN, COORD, RN, CG, CLIENT, FAMILY];

async function mount(t) {
  const store = { welcome_packets: [{ caregiver_id: 'c1', status: 'submitted' }] };
  const queued = [];
  const db = { get: async (k) => (k in store ? JSON.parse(JSON.stringify(store[k])) : null), set: async (k, v) => { store[k] = JSON.parse(JSON.stringify(v)); } };
  let current = ADMIN;
  const auth = (req, _res, next) => { req.user = current; next(); };
  let n = 0;
  const uuidv4 = () => `id-${++n}`;
  const app = express();
  app.use(express.json());
  app.use(require('../routes/staffPortal')({
    db, uuidv4, drive: {}, detectFileType: () => null, logActivity: async () => {},
    getUsers: async () => USERS, enrollmentSummary: () => ({}), authenticateToken: auth
  }));
  app.use(require('../routes/caregiver')({
    db, config, logActivity: async () => {}, getUsers: async () => USERS,
    queueNotification: async (type, userId, email, name, data, opts) => { queued.push({ type, userId, email, data, opts }); return { id: 'q' }; },
    invalidateUsersCache: () => {}, authenticateToken: auth, uuidv4, drive: {}, detectFileType: () => null
  }));
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    let data = null; try { data = await res.json(); } catch (_) { /* empty */ }
    return { status: res.status, data };
  };
  return { store, queued, call, as: (u) => { current = u; } };
}

test('a post made before audiences stays caregivers-only', () => {
  const old = { id: 'b0', title: 'Holiday pay', active: true };
  assert.strictEqual(A.visibleTo(old, 'caregiver'), true);
  for (const t of ['admin', 'rn', 'manager', 'liaison']) assert.strictEqual(A.visibleTo(old, t), false, t);
  assert.strictEqual(A.visibleTo({ ...old, audience: 'all_staff', active: false }, 'rn'), false, 'a taken-down post is hidden');
  assert.strictEqual(A.visibleTo({ ...old, audience: 'all_staff' }, 'client'), false, 'clients are never staff');
});

test('an all-staff post reaches every staff type, and caregivers see it in their Feed', async (t) => {
  const h = await mount(t);
  h.as(COORD);
  const posted = await h.call('POST', '/api/caregiver/broadcasts', { title: 'App update', body: 'What changed', audience: 'all_staff', link: 'https://docs.google.com/x' });
  assert.strictEqual(posted.status, 200);
  for (const u of [ADMIN, COORD, RN, CG]) {
    h.as(u);
    const r = await h.call('GET', '/api/my/announcements');
    assert.strictEqual(r.data.announcements.length, 1, u.name);
    assert.strictEqual(r.data.announcements[0].link, 'https://docs.google.com/x');
  }
  h.as(CG);
  const feed = await h.call('GET', '/api/caregiver/feed');
  assert.ok(feed.data.items.some(i => i.title === 'App update'), 'the caregiver Feed carries it');
});

test('a post for chosen roles reaches only them', async (t) => {
  const h = await mount(t);
  await h.call('POST', '/api/caregiver/broadcasts', { title: 'Nurses only', audience: ['rn'] });
  h.as(RN); assert.strictEqual((await h.call('GET', '/api/my/announcements')).data.announcements.length, 1);
  h.as(COORD); assert.strictEqual((await h.call('GET', '/api/my/announcements')).data.announcements.length, 0);
  h.as(CG); assert.strictEqual((await h.call('GET', '/api/caregiver/feed')).data.items.length, 0);
  h.as(ADMIN);
  const bad = await h.call('POST', '/api/caregiver/broadcasts', { title: 'x', audience: ['client'] });
  assert.strictEqual(bad.status, 400, 'a client is not a staff audience');
  const badLink = await h.call('POST', '/api/caregiver/broadcasts', { title: 'x', audience: 'all_staff', link: 'javascript:alert(1)' });
  assert.strictEqual(badLink.status, 400, 'https links only');
});

test('clients and family are refused', async (t) => {
  const h = await mount(t);
  for (const u of [CLIENT, FAMILY]) {
    h.as(u);
    assert.strictEqual((await h.call('GET', '/api/my/announcements')).status, 403);
  }
});

test('"I\'ve reviewed this" is your own receipt, once, and the admin team sees who has not', async (t) => {
  const h = await mount(t);
  const { data } = await h.call('POST', '/api/caregiver/broadcasts', { title: 'Read me', audience: 'all_staff' });
  const id = data.broadcast.id;
  h.as(RN);
  assert.strictEqual((await h.call('POST', `/api/my/announcements/${id}/reviewed`, { userId: 'c1' })).status, 200);
  await h.call('POST', `/api/my/announcements/${id}/reviewed`);
  const reads = h.store.staff_announcement_reads;
  assert.strictEqual(reads.length, 1, 'once');
  assert.strictEqual(reads[0].user_id, 'r1', 'a body cannot name someone else');
  h.as(RN);
  assert.ok((await h.call('GET', '/api/my/announcements')).data.announcements[0].reviewedAt);
  assert.strictEqual((await h.call('GET', '/api/my/admin/announcements')).status, 403, 'the report is the admin team\'s');
  h.as(COORD);
  const rep = (await h.call('GET', '/api/my/admin/announcements')).data.announcements[0];
  assert.deepStrictEqual(rep.reviewed, ['Rae Nurse']);
  assert.deepStrictEqual(rep.notReviewed.sort(), ['Cara Giver', 'Coco Ordinator', 'Office Admin']);
});

test('a post someone cannot see cannot be marked reviewed; a taken-down post disappears', async (t) => {
  const h = await mount(t);
  const { data } = await h.call('POST', '/api/caregiver/broadcasts', { title: 'RN news', audience: ['rn'] });
  h.as(CG);
  assert.strictEqual((await h.call('POST', `/api/my/announcements/${data.broadcast.id}/reviewed`)).status, 404);
  h.as(CG);
  assert.strictEqual((await h.call('POST', `/api/caregiver/broadcasts/${data.broadcast.id}/retire`)).status, 403, 'only the office takes posts down');
  h.as(ADMIN);
  assert.strictEqual((await h.call('POST', `/api/caregiver/broadcasts/${data.broadcast.id}/retire`)).status, 200);
  assert.strictEqual(h.store.caregiver_broadcasts.length, 1, 'kept, never deleted');
  h.as(RN);
  assert.strictEqual((await h.call('GET', '/api/my/announcements')).data.announcements.length, 0);
});

test('a post can name individual team members, alone or beside roles', async (t) => {
  const h = await mount(t);
  const only = await h.call('POST', '/api/caregiver/broadcasts', { title: 'Just Rae', audience: [], userIds: ['r1'] });
  assert.strictEqual(only.status, 200);
  h.as(RN); assert.strictEqual((await h.call('GET', '/api/my/announcements')).data.announcements.length, 1, 'the named person sees it');
  h.as(COORD); assert.strictEqual((await h.call('GET', '/api/my/announcements')).data.announcements.length, 0, 'nobody else does');
  h.as(CG); assert.strictEqual((await h.call('GET', '/api/caregiver/feed')).data.items.length, 0, 'it is not an old caregiver post');
  h.as(ADMIN);
  await h.call('POST', '/api/caregiver/broadcasts', { title: 'Nurses plus Cara', audience: ['rn'], userIds: ['c1'] });
  h.as(CG); assert.ok((await h.call('GET', '/api/caregiver/feed')).data.items.some(i => i.title === 'Nurses plus Cara'), 'a named caregiver sees it in Feed');
  h.as(ADMIN);
  assert.strictEqual((await h.call('POST', '/api/caregiver/broadcasts', { title: 'x', userIds: ['p1'] })).status, 400, 'a client is never a named recipient');
  assert.strictEqual((await h.call('POST', '/api/caregiver/broadcasts', { title: 'x', audience: [] })).status, 400, 'an empty choice is refused');
  const rep = (await h.call('GET', '/api/my/admin/announcements')).data.announcements.find(a => a.title === 'Just Rae');
  assert.deepStrictEqual(rep.notReviewed, ['Rae Nurse'], 'the report counts only who it reaches');
});

test('each person it reaches gets it by email, word for word, with a button to the right screen', async (t) => {
  const people = [ADMIN, COORD, RN, CG, CLIENT, FAMILY].map(u => Object.assign({ email: `${u.id}@gfc.test` }, u));
  USERS.splice(0, USERS.length, ...people);
  const h = await mount(t);
  h.as(people[1]); // the coordinator posts
  const text = 'Line one.\n\nLine two, exactly as typed.';
  const r = await h.call('POST', '/api/caregiver/broadcasts', { title: 'App update', body: text, audience: 'all_staff', link: 'https://docs.google.com/x' });
  assert.strictEqual(r.status, 200);
  const to = h.queued.map(q => q.userId).sort();
  assert.deepStrictEqual(to, ['a1', 'c1', 'r1'], 'every staff reader but the poster; never a client or family');
  for (const q of h.queued) {
    assert.strictEqual(q.type, 'staff_announcement');
    assert.strictEqual(q.data.subject, 'App update');
    assert.ok(q.data.body.startsWith(text), 'the message is sent verbatim');
    assert.match(q.data.body, /https:\/\/docs\.google\.com\/x/);
  }
  assert.strictEqual(h.queued.find(q => q.userId === 'c1').data.ctaUrl, '/caregiver#feed');
  assert.strictEqual(h.queued.find(q => q.userId === 'r1').data.ctaUrl, '/my#announcements');
  assert.strictEqual(r.data.emailed, 3);
  h.queued.length = 0;
  await h.call('POST', '/api/caregiver/broadcasts', { title: 'Nurses', body: 'x', audience: ['rn'] });
  assert.deepStrictEqual(h.queued.map(q => q.userId), ['r1'], 'a scoped post emails only its readers');
});

test('no "draft" shows on a signed form', () => {
  const a = require('../caregiverAttestations');
  assert.doesNotMatch(String(a.versionLabel(a.CURRENT_VERSION)), /draft/i);
  assert.strictEqual(a.CURRENT_VERSION, '2026-09-draft-1', 'the stored id is unchanged, so no one is asked to sign again');
  const fs = require('fs'); const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'caregiverAttestations.js'), 'utf8');
  assert.doesNotMatch(src, /DRAFT PENDING COUNSEL/);
});
