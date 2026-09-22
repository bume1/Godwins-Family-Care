// test/user_directory_unavailable.test.js
//
// A READ THAT FAILED IS NOT AN EMPTY ROSTER.
//
// `getUsers()` was `(await db.get('users')) || []`. A transient store failure
// became "there are no users", got CACHED, and `authenticateToken`'s
// `users.find(...)` then missed and answered 403 AUTH_INVALID — which
// session-guard.js treats as a dead session, so it cleared the browser's
// tokens and redirected to /login?reason=invalid. Every signed-in person, on
// every screen, for the length of the cache TTL. Reported live 2026-09-22.
//
// The second consequence was worse: ~40 sites do `getUsers()` then
// `db.set('users', users)`, so an empty array from a failed read would have
// been written back over every account in the system.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const GUARD = fs.readFileSync(path.join(__dirname, '..', 'public', 'session-guard.js'), 'utf8');

// getUsers is lifted out and RUN — requiring server.js boots a server. The
// slice is anchored at both ends and fails loudly if either anchor moves, so
// it can never quietly grab the wrong region and prove nothing.
function loadGetUsers(db) {
  const start = SERVER.indexOf('class UserDirectoryUnavailable extends Error {');
  assert.notStrictEqual(start, -1, 'the UserDirectoryUnavailable type is gone');
  const endAnchor = '\n// Invalidate user cache after writes';
  const end = SERVER.indexOf(endAnchor, start);
  assert.ok(end > start, 'the end anchor after getUsers has moved');
  const src = SERVER.slice(start, end);
  assert.ok(/const getUsers = async/.test(src), 'the slice must contain getUsers');
  const factory = new Function('db', 'USERS_CACHE_TTL', `
    let _usersCache = { data: null, lastRefresh: 0 };
    ${src}
    return { getUsers, UserDirectoryUnavailable, peek: () => _usersCache };
  `);
  return factory(db, 30000);
}

const ROSTER = [{ id: 'u1', email: 'a@b.test', role: 'admin' }];

test('a store read that THROWS is not an empty roster', async () => {
  const m = loadGetUsers({ get: async () => { throw new Error('ECONNRESET'); } });
  await assert.rejects(() => m.getUsers(), (e) => e.code === 'USER_DIRECTORY_UNAVAILABLE');
});

test('a roster that reads back EMPTY is a failed read, not a deleted world', async () => {
  // A running app always has at least the seeded admin, so zero users is not a
  // state this store can legitimately be in. An empty result is not a diagnosis.
  const m = loadGetUsers({ get: async () => [] });
  await assert.rejects(() => m.getUsers(), (e) => e.code === 'USER_DIRECTORY_UNAVAILABLE');
});

test('a roster that reads back null or a non-array is refused', async () => {
  for (const bad of [null, undefined, {}, 'users', 0]) {
    const m = loadGetUsers({ get: async () => bad });
    await assert.rejects(() => m.getUsers(), (e) => e.code === 'USER_DIRECTORY_UNAVAILABLE',
      `${JSON.stringify(bad)} is not a roster`);
  }
});

test('a bad read is NEVER cached — otherwise one hiccup is TTL seconds of outage', async () => {
  let calls = 0;
  const m = loadGetUsers({ get: async () => { calls++; return calls === 1 ? [] : ROSTER; } });
  await assert.rejects(() => m.getUsers());
  assert.deepStrictEqual(m.peek().data, null, 'nothing may be cached from a failed read');
  const good = await m.getUsers();
  assert.deepStrictEqual(good, ROSTER, 'the very next call must recover');
});

test('a good read still caches, so this did not turn into a read per request', async () => {
  let calls = 0;
  const m = loadGetUsers({ get: async () => { calls++; return ROSTER; } });
  await m.getUsers(); await m.getUsers();
  assert.strictEqual(calls, 1, 'the TTL cache must still work');
});

// ── the half that actually stops the logout ───────────────────────────────

test('a roster we could not READ never signs anyone out', () => {
  // "This user does not exist" and "we could not check whether this user
  // exists" are different facts, and only the first is a reason to sign
  // somebody out.
  const at = SERVER.slice(SERVER.indexOf('const authenticateToken'), SERVER.indexOf("res.status(500).json({ error: 'Authentication error' });"));
  assert.match(at, /error instanceof UserDirectoryUnavailable/,
    'authenticateToken must distinguish an unreadable directory from a missing user');
  assert.match(at, /status\(503\)/, 'it is a retry, not a dead session');
  assert.match(at, /code: 'USER_DIRECTORY_UNAVAILABLE'/);
});

test('the browser guard does NOT treat an unreadable directory as a dead session', () => {
  // THE LOAD-BEARING ASSERTION. If a later session adds this code to the
  // guard's list, the logout comes straight back.
  const codes = (GUARD.match(/const AUTH_CODES = \[([^\]]*)\]/) || [])[1] || '';
  assert.ok(codes.length, 'the guard must still declare its sign-out codes');
  assert.ok(!/USER_DIRECTORY_UNAVAILABLE/.test(codes),
    'a store hiccup must cost one retry, never everyone\'s session');
  // And the codes it DOES act on must all be real refusals the server sends.
  for (const c of ['AUTH_REVOKED', 'AUTH_IDLE', 'AUTH_EXPIRED']) {
    assert.ok(codes.includes(c), `${c} must stay a sign-out code`);
  }
});

test('the old coalesce cannot come back', () => {
  const start = SERVER.indexOf('const getUsers = async');
  const src = SERVER.slice(start, SERVER.indexOf('\n};', start));
  assert.ok(!/db\.get\('users'\)\s*\|\|\s*\[\]/.test(src),
    "`db.get('users') || []` is the defect: it makes a failed read look like an empty roster");
});

test('the boot seeder never goes through getUsers, or first boot cannot happen', () => {
  // On a genuinely fresh store the roster IS empty, and getUsers refuses that.
  // REPOINTED: this used to assert the seeder read `db.get('users')` directly,
  // which stopped being the mechanism when that read moved into
  // readUsersForSeeding. The rule it protects — a first boot must be able to
  // seed — did not go away, and is now also covered by the fresh-store test
  // below, so this keeps only the half that is still about the seeder itself.
  const seeder = SERVER.slice(SERVER.indexOf('const adminInitReady'), SERVER.indexOf('// Helper functions'));
  assert.ok(!/await getUsers\(\)/.test(seeder),
    'routing the seeder through getUsers would make an empty first boot unbootable');
});

// ── the seeders: the one place allowed to see an empty roster ─────────────
//
// Found after the first fix landed, by tracing every `db.set('users', …)` back
// to the read that fed it. getUsers() was protected; these two were not, and
// the boot seeder runs at EVERY container start.

function loadSeedReader(db) {
  const start = SERVER.indexOf('const readUsersForSeeding = async () => {');
  assert.notStrictEqual(start, -1, 'the seeding reader is gone');
  const end = SERVER.indexOf('\n};', start);
  assert.ok(end > start, 'its end anchor has moved');
  return new Function('db', `${SERVER.slice(start, end + 3)}\nreturn readUsersForSeeding;`)(db);
}

test('a fresh store still seeds — an empty roster with no history is a real first boot', async () => {
  const read = loadSeedReader({ get: async (k) => (k === 'users' ? null : []) });
  assert.deepStrictEqual(await read(), [], 'first boot must still be able to create the admin');
});

test('an empty roster WITH history is a failed read, and the seeder refuses', async () => {
  // This is the one that matters. Writing here replaces every account in the
  // system with the default admin, silently, on a container restart.
  const read = loadSeedReader({
    get: async (k) => (k === 'users' ? null : [{ id: 'a' }, { id: 'b' }])
  });
  await assert.rejects(() => read(), /refusing to seed/i);
});

test('a transient blip is not believed on one read', async () => {
  let n = 0;
  const read = loadSeedReader({
    get: async (k) => { if (k !== 'users') return []; n++; return n === 1 ? null : [{ id: 'u1' }]; }
  });
  assert.deepStrictEqual(await read(), [{ id: 'u1' }], 'the confirming read must win');
});

test('a throwing read propagates, so the seeder writes nothing', async () => {
  const read = loadSeedReader({ get: async () => { throw new Error('ECONNRESET'); } });
  await assert.rejects(() => read(), /ECONNRESET/);
});

test('a FIRST read that throws is never swallowed into an empty roster', async () => {
  // Caught by mutation: the test above threw on EVERY read, so a version that
  // swallowed the first throw still rejected on the second — the assertion
  // could not tell the two states apart. Here only the first read fails and
  // the store then looks like a fresh install, which is exactly the shape that
  // would seed a one-account roster over everyone.
  let n = 0;
  const read = loadSeedReader({
    get: async (k) => {
      if (k !== 'users') return [];
      n++;
      if (n === 1) throw new Error('ECONNRESET');
      return null;
    }
  });
  await assert.rejects(() => read(), /ECONNRESET/,
    'a failed read must never be converted into "this is a fresh install"');
});

test('both seeders go through it — neither reads the roster raw any more', () => {
  const boot = SERVER.slice(SERVER.indexOf('const adminInitReady'), SERVER.indexOf('// Helper functions'));
  assert.match(boot, /await readUsersForSeeding\(\)/, 'the boot seeder must use it');
  assert.ok(!/db\.get\('users'\)\s*\|\|\s*\[\]/.test(boot), 'and must not read the roster raw');

  const at = SERVER.indexOf("app.post('/api/bootstrap-admin'");
  assert.notStrictEqual(at, -1, 'the bootstrap-admin route is gone');
  const route = SERVER.slice(at, SERVER.indexOf('\n});', at));
  assert.match(route, /await readUsersForSeeding\(\)/, 'the recovery route must use it too');
  assert.ok(!/db\.get\('users'\)\s*\|\|\s*\[\]/.test(route));
});

test('no write-back of the roster is fed by an unprotected read, anywhere', () => {
  // The sweep that found these two. It walks every `db.set('users', X)` back to
  // where X came from, so a third one added later fails the build rather than
  // waiting to wipe the roster on some future restart.
  const lines = SERVER.split('\n');
  const offenders = [];
  lines.forEach((l, i) => {
    const m = /db\.set\('users',\s*([A-Za-z_$][\w$]*)/.exec(l);
    if (!m) return;
    for (let j = i - 1; j >= Math.max(0, i - 80); j--) {
      const a = new RegExp(`(?:const|let|var)\\s+${m[1]}\\s*=\\s*(.+)`).exec(lines[j]);
      if (!a) continue;
      if (/db\.get\('users'\)\s*\|\|\s*\[\]/.test(a[1])) offenders.push(`line ${i + 1}`);
      break;
    }
  });
  assert.deepStrictEqual(offenders, [],
    'a roster written back from `db.get(\'users\') || []` replaces every account when that read fails');
});
