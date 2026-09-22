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

test('the boot seeder still reads the store DIRECTLY, or first boot cannot happen', () => {
  // On a genuinely fresh store the roster IS empty, and getUsers now refuses
  // that. The seeder must not go through it.
  const seeder = SERVER.slice(SERVER.indexOf('const adminInitReady'), SERVER.indexOf('// Helper functions'));
  assert.match(seeder, /await db\.get\('users'\)/, 'the seeder reads the store directly');
  assert.ok(!/await getUsers\(\)/.test(seeder),
    'routing the seeder through getUsers would make an empty first boot unbootable');
});
