// EVERY LINK IN EVERY EMAIL POINTS AT app.godwinsfamilycarellc.com, AND AT A
// PAGE THAT EXISTS (owner report, 2026-09-16).
//
// Three defects, none of which announced itself:
//   1. `getAppBaseUrl()` fell back to the MARKETING SITE, so with the stored
//      domain unset every CTA pointed at a public website with no app on it.
//   2. A shift email said "Open the caregiver app" and dropped the caregiver on
//      Home — told about a shift, then left to go find it.
//   3. The message notice sent EVERYONE to `/portal`. Messaging mounts on four
//      surfaces, so caregivers, clinicians, case managers and admins were all
//      being sent to the client's portal.
// And `/admin-hub`, in a live notice, was a 404. "It looks like a path" is not
// evidence a route exists — so this file BOOTS THE APP AND REQUESTS THEM.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const links = require('../appLinks');

// ---- who goes where ---------------------------------------------------------

test('each role is sent to the surface it can actually open', () => {
  assert.strictEqual(links.homeFor({ role: 'client' }), '/portal');
  assert.strictEqual(links.homeFor({ role: 'family' }), '/portal');
  assert.strictEqual(links.homeFor({ role: 'vendor', licenseLevel: 'CNA' }), '/caregiver');
  assert.strictEqual(links.homeFor({ role: 'user', clinicalRole: 'provider' }), '/clinical');
  assert.strictEqual(links.homeFor({ role: 'caseManager' }), '/clinical');
  assert.strictEqual(links.homeFor({ role: 'admin' }), '/admin');
});

test('a vendor with no licence level is NOT sent to the caregiver app', () => {
  // Session 6's rule: a vendor without a level is the lab-era vendor surface,
  // not a caregiver. Sending them to /caregiver is a 403 with extra steps.
  assert.notStrictEqual(links.homeFor({ role: 'vendor' }), '/caregiver');
  assert.notStrictEqual(links.messagesFor({ role: 'vendor' }), '/caregiver#more');
});

test('the message notice resolves PER RECIPIENT, not to one surface', () => {
  // The reported defect, stated as behaviour: five roles, and `/portal` was
  // right for two of them.
  const seen = new Set([
    links.messagesFor({ role: 'client' }),
    links.messagesFor({ role: 'vendor', licenseLevel: 'CNA' }),
    links.messagesFor({ role: 'user', clinicalRole: 'provider' }),
    links.messagesFor({ role: 'admin' })
  ]);
  assert.ok(seen.size >= 3, `messages must not collapse to one surface, got ${[...seen].join(', ')}`);
  assert.strictEqual(links.messagesFor({ role: 'vendor', licenseLevel: 'CNA' }), '/caregiver#more');
  assert.strictEqual(links.messagesFor({ role: 'admin' }), '/admin');
});

test('a shift notice points at the schedule, never the admin board', () => {
  assert.strictEqual(links.shiftFor(), '/caregiver#schedule');
  // `/scheduling` is the ADMIN board. A caregiver cannot use it.
  assert.notStrictEqual(links.shiftFor(), links.PATHS.SCHEDULING);
});

test('the admin hub is /admin — /admin-hub is not a route', () => {
  assert.strictEqual(links.PATHS.ADMIN, '/admin');
  for (const p of links.ALL_PATHS) {
    assert.notStrictEqual(links.routeOf(p), '/admin-hub', 'no link may point at /admin-hub');
  }
});

// ---- the host ---------------------------------------------------------------

// `getAppBaseUrl` is not exported (requiring server.js boots a server), so it
// is lifted out by source and RUN against a fake store — the technique the
// welcome-email and queue-drain guards use. Reading the source would only
// prove the string is present somewhere near it; running it proves what a
// notice actually gets.
function loadGetAppBaseUrl(storedDomain) {
  const src = read('server.js');
  const from = src.indexOf('const DEFAULT_APP_BASE_URL');
  const to = src.indexOf('function resolveSystemVars');
  assert.ok(from !== -1 && to > from, 'could not lift getAppBaseUrl out of server.js');
  const db = { get: async () => storedDomain };
  // eslint-disable-next-line no-new-func
  return new Function('db', `${src.slice(from, to)}\nreturn getAppBaseUrl;`)(db);
}

test('with nothing configured, links point at the APP — not the marketing site', async () => {
  const before = process.env.APP_BASE_URL;
  delete process.env.APP_BASE_URL;
  try {
    const base = await loadGetAppBaseUrl(null)();
    assert.strictEqual(base, 'https://app.godwinsfamilycarellc.com');
    assert.notStrictEqual(base, 'https://godwinsfamilycarellc.com',
      'the marketing site has no portal on it — that was the reported defect');
  } finally {
    if (before === undefined) delete process.env.APP_BASE_URL; else process.env.APP_BASE_URL = before;
  }
});

test('a stored domain is honoured, with or without its own scheme', async () => {
  const before = process.env.APP_BASE_URL;
  delete process.env.APP_BASE_URL;
  try {
    assert.strictEqual(await loadGetAppBaseUrl('portal.example.com')(), 'https://portal.example.com');
    // `https://${domain}` unconditionally turned a pasted URL into
    // https://https://portal… — a dead link nobody would think to look for.
    assert.strictEqual(await loadGetAppBaseUrl('https://portal.example.com')(), 'https://portal.example.com');
    assert.strictEqual(await loadGetAppBaseUrl('https://portal.example.com/')(), 'https://portal.example.com');
  } finally {
    if (before === undefined) delete process.env.APP_BASE_URL; else process.env.APP_BASE_URL = before;
  }
});

test('an explicit APP_BASE_URL wins over both', async () => {
  const before = process.env.APP_BASE_URL;
  process.env.APP_BASE_URL = 'https://staging.example.com';
  try {
    assert.strictEqual(await loadGetAppBaseUrl('portal.example.com')(), 'https://staging.example.com');
  } finally {
    if (before === undefined) delete process.env.APP_BASE_URL; else process.env.APP_BASE_URL = before;
  }
});

// ---- the deep link ----------------------------------------------------------

test('the caregiver app opens the tab a link names', () => {
  const src = read('public/caregiver.html');
  assert.match(src, /tabFromHash/, 'the app must read the fragment');
  assert.match(src, /useState\(tabFromHash\)/, 'and use it as the INITIAL tab, not after a render');
  // Every tab a link can name must be one the app actually has.
  const ids = (src.match(/const TAB_IDS = \[([^\]]+)\]/) || [])[1] || '';
  for (const p of links.ALL_PATHS) {
    const frag = String(p).split('#')[1];
    if (!frag || !p.startsWith('/caregiver')) continue;
    assert.ok(ids.includes(`'${frag}'`), `/caregiver#${frag} names a tab the app does not have`);
  }
});

// ---- no route may hand-roll a path ------------------------------------------

test('no notice hard-codes a path — every CTA comes from appLinks', () => {
  for (const f of ['routes/scheduling.js', 'routes/caregiver.js', 'routes/messaging.js', 'routes/welcomePacket.js']) {
    const src = read(f);
    const literal = src.match(/ctaUrl:\s*'\/[^']*'/);
    assert.ok(!literal, `${f} hard-codes a CTA path (${literal && literal[0]}) — name it in appLinks.js`);
    assert.match(src, /require\('\.\.\/appLinks'\)/, `${f} must require the resolver it uses`);
  }
});

// ---- and the one that would have caught /admin-hub --------------------------

test('EVERY link the app can email resolves to a real page', { timeout: 60000 }, async () => {
  // The guard the dead `/admin-hash` link needed. A path is not a route until
  // the server answers for it, so the server is asked.
  const PORT = 3417;
  const server = spawn(process.execPath, [path.join(root, 'server.js')], {
    cwd: root,
    env: { ...process.env, NODE_ENV: 'development', DATA_STORE: 'memory', PORT: String(PORT) },
    stdio: 'ignore'
  });

  try {
    // Wait for it to answer, rather than guessing at a sleep.
    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${PORT}/healthz`);
        up = r.ok;
      } catch (e) { await new Promise(r => setTimeout(r, 500)); }
    }
    assert.ok(up, 'the app did not come up, so this proves nothing either way');

    const dead = [];
    for (const p of links.ALL_PATHS) {
      const route = links.routeOf(p);
      const r = await fetch(`http://127.0.0.1:${PORT}${route}`, { redirect: 'manual' });
      if (r.status >= 400) dead.push(`${p} -> ${route} answered ${r.status}`);
    }
    assert.deepStrictEqual(dead, [], `a link in appLinks.js points at a page that does not exist:\n  ${dead.join('\n  ')}`);

    // And prove the check can fail: a path nobody serves must 404, or the
    // assertion above is passing for the wrong reason.
    const control = await fetch(`http://127.0.0.1:${PORT}/admin-hub`, { redirect: 'manual' });
    assert.strictEqual(control.status, 404,
      '/admin-hub must still 404 — if it resolves, this test can no longer tell a dead link from a live one');
  } finally {
    server.kill('SIGKILL');
  }
});
