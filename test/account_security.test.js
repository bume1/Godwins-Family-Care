'use strict';
// YOUR OWN ACCOUNT — the page five routes were waiting for.
//
// Five things a signed-in person could do only by calling an API by hand:
//   GET  /api/auth/mfa/status                      their two-factor state
//   POST /api/auth/mfa/recovery-codes/regenerate   fresh backup codes
//   GET  /api/auth/sessions                        where they are signed in
//   POST /api/emr/disconnect                       their own OpenEMR sign-in
//   POST /api/auth/change-password                 reachable ONLY through
//        login.html's FORCED change, so somebody who simply wanted to change
//        their password had no way to
//
// What these tests pin:
//   1. /account exists, is linked from every signed-in surface, and reads its
//      identity from the server rather than from localStorage.
//   2. It offers no control the server would refuse: the OpenEMR card is
//      drawn only when /api/clinical/status answered, and there is no
//      "sign out one device" button, because no route does that.
//   3. ⚠️ It builds NO toggle for `notificationPreferences`. That route writes
//      three keys NOTHING in this repo reads, so a switch there would be a
//      lie a person acts on. Asserted both ways: the preferences stay unread,
//      and the page does not pretend otherwise.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const server = read('server.js');
const page = read('public/account.html');

const babel = (src) => {
  const blocks = [...src.matchAll(/<script type="text\/babel"[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  assert.ok(blocks.length, 'no babel block found');
  return blocks.sort((a, b) => b.length - a.length)[0];
};
// Comments stripped before any scan: a search that cannot tell live code from
// prose about that code proves nothing, and this repo has paid for it five
// times.
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:\\])\/\/[^\n]*/g, '$1');
const js = strip(babel(page));
// `strip`'s block-comment regex is fooled by a `/*` inside a string or a
// regex literal and will swallow everything to the next `*/`. It is safe on
// this page's script and NOT safe on a large file — proven: run it over
// server.js and `emailReminders` disappears. So the page block asserts it
// survived, rather than letting a scan pass on a gutted string.
assert.ok(js.includes('const deviceOf') && js.includes('EmailCard') && js.includes('ReactDOM'),
  'stripping comments ate part of the page script — every scan below would be vacuous');

// ---- 1. it exists, and people can get to it ---------------------------------

test('/account serves the page', () => {
  assert.ok(fs.existsSync(path.join(root, 'public', 'account.html')), 'public/account.html is missing');
  assert.match(server, /app\.get\('\/account',[\s\S]{0,160}?account\.html'\)/,
    '/account does not serve public/account.html');
});

test('every signed-in surface links to it, because every role has an account', () => {
  // A screen nobody can reach is a screen that does not exist — the
  // /scheduling lesson, and the whole reason this batch of work exists.
  // Match the LINK, not the bare path: my own comments on those pages say
  // "/account", so a scan for the path survived deleting every link — the
  // comment-as-code trap, pointed at my own test for the third time.
  const links = {
    'public/admin-hub.html': /<a href="\/account"/,
    'public/clinical.html': /<a className="btn ghost" href="\/account">/,
    'public/portal.html': /window\.location\.href = '\/account'/,
    // The caregiver app is a caregiver's My GFC (owner, 2026-11-08): it loads
    // the shared My GFC sections, whose Account section links the page.
    'public/caregiver.html': /<script type="text\/babel" src="\/my-gfc\.js"><\/script>/,
    'public/my-gfc.js': /<a className="mg-btn" href="\/account">/
  };
  for (const [f, re] of Object.entries(links)) {
    assert.match(read(f), re, `${f} has no way to reach the account page`);
  }
});

test('the page reads who it is from the server, never from localStorage', () => {
  // A stored user object that has gone stale is indistinguishable from a good
  // one until somebody acts on the wrong account (PR #113's `Bearer null`).
  assert.match(js, /call\('\/api\/auth\/mfa\/status'\)/, 'the page does not ask the server who it is');
  const reads = [...js.matchAll(/localStorage\.getItem\('([^']+)'\)/g)].map(m => m[1]);
  assert.deepEqual(reads.sort(), ['admin_token', 'portal_token', 'unified_token'],
    `the page reads ${reads.join(', ')} from localStorage — it may read tokens and nothing else`);
  assert.doesNotMatch(js, /localStorage\.getItem\('[a-z_]*user'\)/,
    'the page takes its identity from a stored user object');
  // Every Bearer header goes through the token helper. Build-enforced since #113.
  const headers = [...js.matchAll(/Authorization:\s*`Bearer \$\{([^}]*)\}`/g)].map(m => m[1].trim());
  assert.ok(headers.length, 'no Bearer header found');
  for (const e of headers) assert.equal(e, 'getToken()', `a Bearer header is built from \`${e}\``);
});

test('the status route carries the account, and is bound to the caller', () => {
  const r = server.slice(server.indexOf("app.get('/api/auth/mfa/status'"));
  const body = r.slice(0, r.indexOf('\n});'));
  assert.match(body, /authenticateToken/, 'the status route is unauthenticated');
  assert.match(body, /account: \{/, 'the status route does not carry the account the page needs');
  assert.match(body, /users\.find\(x => x\.id === req\.user\.id\)/,
    'the status route no longer resolves the CALLER — it must take no user parameter');
  assert.doesNotMatch(body, /req\.params/, 'the status route reads a URL parameter, so it could serve someone else');
  assert.doesNotMatch(body, /password/, 'the status route returns something password-shaped');
});

// ---- 2. no control the server would refuse ----------------------------------

test('the OpenEMR card is drawn only when the server says this person has one', () => {
  // /api/clinical/status is requireClinicalRead, so a 403 IS the answer that
  // this person has no OpenEMR sign-in to manage. The page asks rather than
  // deciding a credential question itself — the 4.8 rule.
  assert.match(js, /call\('\/api\/clinical\/status'\)/, 'the page never asks whether this is a clinical user');
  assert.match(js, /catch \(e\) \{ setEmr\(null\); \}/,
    'a refused clinical status does not hide the OpenEMR card');
  assert.match(js, /\{emr && <EmrCard/, 'the OpenEMR card renders even when the server refused the read');
});

test('there is no "sign out this one device" button, because no route does that', () => {
  // POST /api/auth/logout revokes the CURRENT session; the per-user revoke is
  // requireAdmin. Offering a per-row button would hand out a control the
  // server refuses. Changing the password is the real control, so it is named.
  const revoke = server.slice(server.indexOf("app.post('/api/users/:userId/sessions/revoke'"));
  assert.match(revoke.slice(0, 120), /authenticateToken, requireAdmin/,
    'the per-user session revoke is no longer admin-only — the page can offer a button now');
  const card = js.slice(js.indexOf('const SessionsCard'), js.indexOf('const EmrCard'));
  assert.doesNotMatch(card, /sessions\/revoke/, 'the page calls an admin-only revoke route');
  assert.match(card, /There is no way to sign out a single device on its own/,
    'the page does not say that signing out one device is not possible');
  assert.match(card, /change your password above\. That signs them all out at once/,
    'the page does not name the control that actually ends the other sessions');
  // And that control is real: changing the password revokes every other session.
  const pw = server.slice(server.indexOf("app.post('/api/auth/change-password'"));
  assert.match(pw.slice(0, 2200), /revokeAllForUser\(user\.id, 'password_changed'/,
    'changing the password no longer ends the other sessions — the page says it does');
});

test('regenerating backup codes needs a live authenticator code', () => {
  // Somebody holding a stolen session must not be able to mint themselves a
  // set of permanent keys. The server asks; the page must send it and must
  // not offer the button without one.
  const r = server.slice(server.indexOf("app.post('/api/auth/mfa/recovery-codes/regenerate'"));
  assert.match(r.slice(0, 1200), /verifyTotp\(/, 'the server stopped checking a live code');
  const card = js.slice(js.indexOf('const MfaCard'), js.indexOf('const SessionsCard'));
  assert.match(card, /body: \{ code: code\.trim\(\) \}/, 'the page does not send the live code');
  assert.match(card, /disabled=\{busy \|\| code\.trim\(\)\.length < 6\}/,
    'the page offers the button with no code typed, which the server will refuse');
  assert.match(card, /only time they are shown/i,
    'the page does not warn that the codes are shown once');
});

test('two-step enrolment is not offered here, because it happens at sign-in', () => {
  // There is no self-service enrol route: enrolment runs inside the login
  // flow. A button here would go nowhere.
  const card = js.slice(js.indexOf('const MfaCard'), js.indexOf('const SessionsCard'));
  assert.doesNotMatch(card, /mfa\/enroll|mfa\/setup/, 'the page calls an enrolment route that does not exist');
  assert.match(card, /You set this up at sign-in, not here/,
    'the page does not say where two-step is actually set up');
});

// ---- 3. the dead route, which is the honest part -----------------------------

test('nothing in this repo reads notificationPreferences, so the page builds no toggle', () => {
  // ⚠️ PUT /api/users/:userId/notification-preferences writes three keys —
  // emailReminders, overdueReminders, milestoneNotifications — and NOTHING
  // reads any of them. A switch for them would be a setting somebody turns
  // off and is then emailed anyway: the inert-field trap this repo keeps
  // paying for. Scanned across every .js and .html in the tree.
  // RAW source, NOT `strip`: the block-comment regex is fooled by a `/*`
  // inside a string or a regex literal somewhere in server.js and swallows
  // real code after it, which made this scan report zero hits and pass
  // vacuously. A comment that merely names a key is a false positive here,
  // and an exact baseline makes that loud rather than silent — the only
  // honest way to read a whole tree with a regex.
  const skip = new Set(['node_modules', '.git', 'test']);
  const hits = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(js|jsx|html|mjs|cjs)$/.test(e.name)) continue;
      const src = fs.readFileSync(p, 'utf8');
      for (const k of ['emailReminders', 'overdueReminders', 'milestoneNotifications']) {
        if (src.includes(k)) hits.push(`${path.relative(root, p)}: ${k}`);
      }
    }
  };
  walk(root);
  assert.ok(hits.length, 'the tree scan found nothing at all — it is not reading the files');
  // One place writes the defaults; the route itself names none of the three
  // keys (it spreads req.body). If a READER ever appears, this fails and the
  // page should grow the toggles it currently refuses to fake.
  assert.deepEqual(hits.sort(), [
    'server.js: emailReminders', 'server.js: milestoneNotifications', 'server.js: overdueReminders'
  ], `notification preferences are now read somewhere: ${hits.join(', ')} — build the toggles`);
  assert.doesNotMatch(js, /notification-preferences/,
    'the account page calls the notification-preferences route, whose values nothing reads');
  assert.doesNotMatch(js, /emailReminders|overdueReminders|milestoneNotifications/,
    'the account page offers a preference switch nothing honours');
});

test('the email card states what is true and offers no switch it cannot honour', () => {
  // `emailUnsubscribed` and `accountStatus` are what queueNotification checks
  // at the choke point, so they are the only email settings this app honours.
  const gate = server.slice(server.indexOf('// Whether a recipient may be emailed at all'));
  assert.match(gate.slice(0, 1400), /user\.emailUnsubscribed/,
    'the email gate no longer reads emailUnsubscribed — the page reports it as the live setting');
  const card = js.slice(js.indexOf('const EmailCard'), js.indexOf('const App ='));
  // The STATE, not merely a mention: the trailing paragraph also reads
  // `account.emailUnsubscribed`, so a bare match survived deleting the chip
  // that shows it. Assert the thing a person actually sees.
  assert.match(card, /account\.emailUnsubscribed \? <span className="chip r">Turned off<\/span> : <span className="chip">On<\/span>/,
    'the card no longer shows whether automated email is on or off');
  assert.match(card, /unsubscribe link at the foot/,
    'the card does not say how this is actually changed');
  assert.doesNotMatch(card, /method: 'P(UT|OST)'|call\(/,
    'the card writes a setting through a route that cannot take it');
});

// ---- the clock ----------------------------------------------------------------

test('times come from the shared clock, never a literal', () => {
  assert.doesNotMatch(page, /America\/New_York/,
    'the account page restates the practice timezone instead of reading it from gfc-time.js');
  assert.match(js, /window\.GFC_TIME && window\.GFC_TIME\.PRACTICE_TIMEZONE/,
    'the page does not read the zone from the one source of the clock');
  assert.match(page, /<script src="\/gfc-time\.js">/, 'gfc-time.js is not loaded');
});

test('a device name is read from the user agent, and labelled as a guess', () => {
  const src = js.slice(js.indexOf('const deviceOf'), js.indexOf('const Card ='));
  // eslint-disable-next-line no-new-func
  const deviceOf = new Function(`${src}; return deviceOf;`)();
  assert.equal(deviceOf(''), 'Unknown device');
  assert.equal(deviceOf(undefined), 'Unknown device');
  assert.equal(deviceOf('totally made up'), 'Unknown device',
    'an unrecognised user agent is given an invented device name');
  assert.match(deviceOf('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1'), /Safari on iPhone/);
  assert.match(deviceOf('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0 Safari/537.36'), /Chrome on Mac/);
  // Edge and Opera both carry "Chrome/" in their user agent, so a naive check
  // calls every Edge session Chrome.
  assert.match(deviceOf('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/120.0 Safari/537.36 Edg/120.0'), /Edge on Windows/);
  assert.match(js, /treat it as a hint rather than proof/,
    'the page presents a guessed device name as fact');
});
