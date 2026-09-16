// ============================================================================
// The caregiver Feed — who sees what, driven through the shipped router.
//
// The Feed has two halves and they are scoped DIFFERENTLY on purpose:
//
//   broadcast  → every caregiver, by design. It is the office talking to the
//                whole roster: payroll moved, the office is closed Monday.
//   escalation → ONLY the caregiver who raised it. It carries a client's NAME
//                and the nature of a concern about them, so it is that
//                caregiver's own record of what they reported, not news.
//
// Those two rules look alike in the code — one list, one filter — which is
// exactly how a filter gets dropped in a refactor. Drop it and every
// caregiver's Feed starts naming every other caregiver's clients, which is
// the cross-client messaging leak (PR #88) in a different surface.
//
// Messaging deliberately does NOT reach the Feed. On the admin side the
// composer sits in a tab NEXT TO Messages in one Inbox; they are neighbours
// on a screen, never one stream.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const express = require('express');
const config = require('../config');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

const CG_A = { id: 'cg-a', role: 'vendor', name: 'Rosa Adeyemi', licenseLevel: 'cna', email: 'rosa@example.com' };
const CG_B = { id: 'cg-b', role: 'vendor', name: 'Tunde Bello', licenseLevel: 'pca', email: 'tunde@example.com' };
const ADMIN = { id: 'a1', role: 'admin', name: 'GFC Admin', email: 'admin@example.com' };

// Both caregivers are through the app-access gate, so a 403 in these tests is
// the Feed's own answer and never the welcome packet's.
const PACKETS = [
  { caregiver_id: 'cg-a', status: 'submitted' },
  { caregiver_id: 'cg-b', status: 'submitted' }
];

const mount = async (t, { as = CG_A, store = {} } = {}) => {
  store.welcome_packets = store.welcome_packets || PACKETS;
  const db = { get: async (k) => store[k] || null, set: async (k, v) => { store[k] = v; } };
  const router = require('../routes/caregiver')({
    db, config,
    logActivity: async () => {},
    queueNotification: async () => {},
    getUsers: async () => [CG_A, CG_B, ADMIN],
    invalidateUsersCache: () => {},
    authenticateToken: (req, _res, next) => { req.user = as; next(); },
    uuidv4: () => `id-${Math.random().toString(16).slice(2)}`,
    drive: {},
    detectFileType: () => null
  });
  const app = express();
  app.use(express.json());
  app.use(router);
  const server = app.listen(0);
  t.after(() => server.close());
  const port = server.address().port;
  return {
    store,
    feed: async () => (await (await fetch(`http://127.0.0.1:${port}/api/caregiver/feed`)).json()),
    post: (p, body) => fetch(`http://127.0.0.1:${port}${p}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    })
  };
};

// An escalation raised by cg-a about a named client.
const ESCALATION = {
  id: 'esc-1', caregiver_id: 'cg-a', caregiver_name: 'Rosa Adeyemi',
  client_id: 'client-1', client_name: 'Margaret Whitfield',
  concern_type: 'clinical', status: 'raised', raised_at: '2026-09-15T14:00:00.000Z',
  notified: []
};

const BROADCAST = {
  id: 'b-1', title: 'Office closed Monday', body: 'Payroll runs Tuesday this week.',
  active: true, posted_at: '2026-09-15T12:00:00.000Z', posted_by_name: 'GFC Admin'
};

// ---------------------------------------------------------------------------

test('a broadcast reaches every caregiver — that is what a broadcast is', async (t) => {
  const store = { caregiver_broadcasts: [BROADCAST] };
  for (const who of [CG_A, CG_B]) {
    const h = await mount(t, { as: who, store });
    const { items } = await h.feed();
    assert.strictEqual(items.length, 1, `${who.name} sees the broadcast`);
    assert.strictEqual(items[0].kind, 'broadcast');
    assert.strictEqual(items[0].title, 'Office closed Monday');
  }
});

test('an escalation reaches ONLY the caregiver who raised it, and carries a client name', async (t) => {
  const store = { escalation_events: [ESCALATION] };

  const a = await mount(t, { as: CG_A, store });
  const mine = (await a.feed()).items;
  assert.strictEqual(mine.length, 1, 'the caregiver who raised it sees it');
  assert.strictEqual(mine[0].kind, 'escalation');
  // This is the payload that makes the scoping matter: a client's name and
  // what was reported about them. If this assertion ever stops holding, the
  // scoping test below is guarding an empty box.
  assert.match(mine[0].title, /Margaret Whitfield/);

  const b = await mount(t, { as: CG_B, store });
  const theirs = (await b.feed()).items;
  assert.strictEqual(theirs.length, 0, 'another caregiver sees nothing of it');
  assert.ok(
    !JSON.stringify(theirs).includes('Margaret Whitfield'),
    'another caregiver never sees the client named in it'
  );
});

test('the two halves are mixed correctly — shared news, private concern', async (t) => {
  const store = { caregiver_broadcasts: [BROADCAST], escalation_events: [ESCALATION] };

  const a = (await (await mount(t, { as: CG_A, store })).feed()).items;
  assert.deepStrictEqual(a.map(i => i.kind).sort(), ['broadcast', 'escalation']);

  const b = (await (await mount(t, { as: CG_B, store })).feed()).items;
  assert.deepStrictEqual(b.map(i => i.kind), ['broadcast']);
});

test('a retired broadcast stops appearing', async (t) => {
  const store = { caregiver_broadcasts: [{ ...BROADCAST, active: false }] };
  const h = await mount(t, { as: CG_A, store });
  assert.strictEqual((await h.feed()).items.length, 0);
});

test('only an admin can post to the Feed — a caregiver posting is refused', async (t) => {
  const asCaregiver = await mount(t, { as: CG_A });
  const refused = await asCaregiver.post('/api/caregiver/broadcasts', { title: 'Hi everyone', body: 'x' });
  assert.ok(refused.status === 403 || refused.status === 401, `caregiver refused, got ${refused.status}`);
  assert.ok(!asCaregiver.store.caregiver_broadcasts || asCaregiver.store.caregiver_broadcasts.length === 0,
    'nothing was written');

  const asAdmin = await mount(t, { as: ADMIN });
  const ok = await asAdmin.post('/api/caregiver/broadcasts', { title: 'Office closed Monday', body: 'x' });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(asAdmin.store.caregiver_broadcasts.length, 1);
});

test('nothing from messaging reaches the Feed', () => {
  // The Feed reads exactly two collections. Messaging lives in its own store
  // and is read through its own visibility function, which resolves the
  // VIEWER's own client — the fix from PR #88. A message arriving on a
  // broadcast, which every caregiver reads, would route around all of it.
  const src = read('routes/caregiver.js');
  const feed = src.slice(src.indexOf("router.get('/api/caregiver/feed'"));
  const body = feed.slice(0, feed.indexOf('router.post('));
  const collections = [...body.matchAll(/readRows\('([a-z_]+)'\)/g)].map(m => m[1]).sort();
  assert.deepStrictEqual(collections, ['caregiver_broadcasts', 'escalation_events'],
    'the Feed reads these two collections and no others');
});

test('the composer tells the admin the broadcast reaches everyone', () => {
  // The only control on what goes INTO a broadcast is the person typing it,
  // so the screen has to say who it reaches before they type. A composer that
  // reads like a message box invites a client name into it.
  const hub = read('public/admin-hub.html');
  const panel = hub.slice(hub.indexOf('const CaregiverFeedPanel'));
  const help = panel.slice(0, panel.indexOf('Post to Feed'));
  assert.match(help, /every caregiver/i, 'the composer says it goes to every caregiver');
  assert.match(help, /no client names/i, 'and that it carries no client names');
});
