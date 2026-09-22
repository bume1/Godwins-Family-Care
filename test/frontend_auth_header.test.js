// ============================================================================
// frontend_auth_header.test.js
//
// One rule, and it cost a live sign-out loop to learn: a page may not build an
// Authorization header out of an inline localStorage read.
//
// `admin-enrollment.html` shipped three fetches whose header was
// `Bearer ${localStorage.getItem('token')}`. That key is written by exactly one
// surface — `public/app.js`, the retired lab tracker — so on every GFC page it
// reads back `null`, the header goes out as the literal string "Bearer null",
// `jwt.verify` refuses it, and the server answers 403 `AUTH_INVALID`. That code
// is in `session-guard.js`'s sign-out family, so the browser cleared the
// tokens and replaced the page with `/login?reason=invalid`. One of the three
// sat in a `useEffect` on the documents panel, so opening ANY client's
// enrollment record signed the admin out on the spot.
//
// The page already had `getToken()`, which reads the keys the app actually
// writes. Every Bearer header must go through a resolved binding like it —
// never a `localStorage.getItem(...)` spelled out in the template — because an
// inline read that misses is indistinguishable from one that hits until a real
// person is thrown back to the login screen.
// ============================================================================
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const PUBLIC = path.join(__dirname, '..', 'public');

const files = () => {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(html|js)$/.test(e.name)) out.push(p);
    }
  };
  walk(PUBLIC);
  return out;
};

// A source scan that cannot tell live code from prose ABOUT that code proves
// nothing — the header above names the bad expression in order to explain it.
// The `:` guard keeps `https://` intact.
const code = (p) => fs.readFileSync(p, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

// Every `Bearer ${...}` template in a served file, with its expression.
const bearerExpressions = (source) => {
  const out = [];
  const re = /Bearer\s+\$\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(source))) out.push(m[1].trim());
  return out;
};

test('no page builds an Authorization header from an inline localStorage read', () => {
  const offenders = [];
  for (const p of files()) {
    for (const expr of bearerExpressions(code(p))) {
      if (/localStorage/.test(expr)) {
        offenders.push(`${path.relative(PUBLIC, p)}: Bearer \${${expr}}`);
      }
    }
  }
  assert.deepStrictEqual(
    offenders, [],
    'A Bearer header must use the page\'s token helper, not an inline localStorage read:\n  ' + offenders.join('\n  ')
  );
});

test('the retired tracker key is never read as a credential on its own', () => {
  // `public/app.js` is the lab-era tracker (served only by index.html and
  // changelog.html) and is the ONLY writer of `token`. Everywhere else that
  // key reads back null, so a read of it standing ALONE is the bug above
  // wearing a different shape.
  //
  // A read inside a `||` chain is deliberately allowed: `service_token ||
  // token || unified_token` cannot yield null-as-a-credential, because the
  // chain carries on past it. What this catches is the unguarded read — the
  // one whose miss reaches the server as the string "null".
  const offenders = [];
  for (const p of files()) {
    const src = code(p);
    const re = /localStorage\.getItem\(\s*(['"])token\1\s*\)/g;
    let m;
    while ((m = re.exec(src))) {
      const before = src.slice(Math.max(0, m.index - 6), m.index);
      const after = src.slice(m.index + m[0].length, m.index + m[0].length + 6);
      const chained = /\|\|\s*$/.test(before) || /^\s*\|\|/.test(after);
      if (!chained) offenders.push(`${path.relative(PUBLIC, p)}: ${m[0]}`);
    }
  }
  assert.deepStrictEqual(offenders, [], 'unguarded reads of the retired tracker key:\n  ' + offenders.join('\n  '));
});

test('the enrollment page resolves its token through getToken, on every fetch', () => {
  // The page that carried the defect, pinned by name: every Bearer header on
  // it must resolve to `getToken()` — directly, or through a const assigned
  // from it. A page with zero Bearer headers would pass the two sweeps above
  // vacuously, so this one asserts the count as well.
  const src = code(path.join(PUBLIC, 'admin-enrollment.html'));
  const exprs = bearerExpressions(src);
  assert.ok(exprs.length >= 8, `expected the enrollment page to still carry its Bearer headers, found ${exprs.length}`);
  const allowed = new Set(['getToken()', 'token']);
  const bad = exprs.filter(e => !allowed.has(e));
  assert.deepStrictEqual(bad, [], 'unexpected Bearer expression on the enrollment page: ' + bad.join(', '));
  // ...and every bare `token` binding on it comes from getToken().
  const bindings = [...src.matchAll(/const\s+token\s*=\s*([^;\n]+)/g)].map(m => m[1].trim());
  assert.ok(bindings.length > 0, 'expected at least one token binding');
  for (const b of bindings) {
    assert.ok(/getToken\(\)/.test(b), `a token binding that does not come from getToken(): ${b}`);
  }
});

test('session-guard signs out on AUTH_INVALID — which is why the above matters', () => {
  // The blast radius, pinned. If a later session narrows this family, the
  // sweeps above stop being urgent; if it widens, they get more so. Either
  // way the two facts belong in one place.
  const guard = code(path.join(PUBLIC, 'session-guard.js'));
  assert.match(guard, /AUTH_CODES\s*=\s*\[[^\]]*'AUTH_INVALID'/, 'AUTH_INVALID is no longer a sign-out code');
  assert.match(guard, /window\.location\.replace\(`\/login\?reason=/, 'session-guard no longer redirects to /login');
});

test('every AUTH_INVALID answer says which of the three fired', () => {
  // The reason this bug took hours: `jwt.verify` refusing a token, a token
  // minted before server-side sessions, and a token naming an account that is
  // not there all answered the identical `AUTH_INVALID`, and the browser put
  // the identical `/login?reason=invalid` in the address bar. A message that
  // cannot distinguish two states sends the next person at the wrong layer.
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const invalids = [...src.matchAll(/code:\s*(?:expired\s*\?\s*'AUTH_EXPIRED'\s*:\s*)?'AUTH_INVALID'[^}]*/g)];
  assert.ok(invalids.length >= 3, `expected the three AUTH_INVALID sources, found ${invalids.length}`);
  for (const m of invalids) {
    assert.match(m[0], /detail:/, `an AUTH_INVALID answer with no detail: ${m[0].slice(0, 120)}`);
  }
  // The detail is a layer name, never a value: no token, no email, no id.
  const details = [...src.matchAll(/detail:\s*(?:expired\s*\?\s*'[a-z_]+'\s*:\s*)?'([a-z_]+)'/g)].map(m => m[1]);
  assert.ok(details.length >= 3, 'expected at least three declared details');
  for (const d of details) assert.match(d, /^[a-z_]{1,40}$/);
});

test('the sign-out carries the detail into the URL, and only a layer name', () => {
  const guard = code(path.join(PUBLIC, 'session-guard.js'));
  assert.match(guard, /why=\$\{encodeURIComponent\(why\)\}/, 'the detail no longer reaches the login URL');
  // Anything the server did not shape like a layer name is dropped rather than
  // pasted into an address bar — a server that started echoing a value back
  // must not turn this into a way to put it in browser history.
  assert.match(guard, /\/\^\[a-z_\]\{1,40\}\$\//, 'the detail is no longer shape-checked before it reaches the URL');
});

test('a sign-out caused by no stored token says so, instead of blaming the session', () => {
  // `Bearer ${getToken()}` with nothing in localStorage goes out as the literal
  // string "Bearer null". The server cannot tell that from a forged token, so
  // it answers the same AUTH_INVALID — and the person reads `?reason=invalid`
  // as "your session broke" when the truth is that this browser never had one.
  // That is exactly what made the sign-out on one screen look like a second bug
  // on the next. The browser knows which it was, so the browser says.
  const guard = code(path.join(PUBLIC, 'session-guard.js'));
  assert.match(guard, /bearerIsMissing/, 'the no-token case is no longer distinguished');
  assert.match(guard, /'no_token_in_browser'/, 'the no-token reason is gone');

  // Run the predicate rather than read it: what counts as a missing credential
  // is the whole point, and a regex that matched nothing would read fine.
  const m = /const MISSING = \[[^\]]*\];\s*const bearerIsMissing = \([\s\S]*?\n  \};/.exec(guard);
  assert.ok(m, 'could not lift bearerIsMissing out of the guard');
  const bearerIsMissing = new Function(`${m[0]} return bearerIsMissing;`)();

  for (const sent of ['Bearer null', 'Bearer undefined', 'Bearer ', 'bearer null', 'Bearer  null  ']) {
    assert.strictEqual(bearerIsMissing(sent), true, `should read as missing: ${JSON.stringify(sent)}`);
  }
  // 'X-Thing Bearer null' is here because without it the `^` anchor is not
  // load-bearing and a mutation removing it survives: 'Basic null' fails to
  // match either way, since it contains no "Bearer" at all.
  for (const sent of ['Bearer eyJhbGciOiJIUzI1NiJ9.abc.def', 'Bearer nullify', 'Bearer undefinedX', 'Basic null', 'X-Thing Bearer null', '']) {
    assert.strictEqual(bearerIsMissing(sent), false, `should read as a real credential: ${JSON.stringify(sent)}`);
  }
});
