'use strict';
// THE AUDIT LOG FINALLY HAS A SCREEN.
//
// Session 5.4 (PR #72) built the durable, append-only audit_log and wrote its
// own route comment: "Session 12 builds the UI; this is the verification
// surface for go-live acceptance". Session 12 never ran. So for fourteen
// months the only way to read the log was an API call made by hand, which
// means an accounting of disclosures under 45 CFR 164.528 was something nobody
// at GFC could actually produce from a screen — the same class of gap as the
// facility-assignment route, acknowledgeAbnormalResult and the MFA reset:
// a route with no UI is a capability nobody has.
//
// What these tests pin, and why each one is here rather than being obvious:
//   1. The page exists and is reachable at /audit (a screen nobody can reach
//      is a screen that does not exist — the /scheduling lesson).
//   2. Reads only. No write verb anywhere in the page, and no route that
//      could change or remove an entry. Append-only is the whole value.
//   3. The zone comes from gfc-time.js, never a literal, and the page refuses
//      to print the word Eastern over a clock it cannot prove is Eastern.
//   4. ⚠️ readAudit is `ORDER BY id DESC LIMIT n` with NO offset, so a full
//      page is the NEWEST n in the window and the rest are simply not
//      returned. A "Load more" button would re-fetch the same rows and imply
//      there is nothing older. The page must warn instead, and must never
//      offer paging.
//   5. The hub tile is Super-Admin-only, because the route is requireAdmin
//      and a button that answers 403 is worse than no button.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const server = read('server.js');
const page = read('public/audit.html');
const hub = read('public/admin-hub.html');
const store = read('dataStore.js');
const gfcTime = require('../public/gfc-time.js');

// The page's own script, with comments stripped. A source scan that cannot
// tell live code from prose about that code proves nothing — this repo has
// paid for that five times (the extraction module's header, the availability
// matcher's own explanation, an apostrophe in the word "protocol's").
const babel = (src) => {
  const blocks = [...src.matchAll(/<script type="text\/babel"[^>]*>([\s\S]*?)<\/script>/g)]
    .map(m => m[1]);
  assert.ok(blocks.length, 'no babel block found');
  return blocks.sort((a, b) => b.length - a.length)[0];
};
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1');

const js = stripComments(babel(page));

// ---- 1. it exists and it is reachable ---------------------------------------

test('the audit log has a page, and /audit serves it', () => {
  assert.ok(fs.existsSync(path.join(root, 'public', 'audit.html')),
    'public/audit.html is missing');
  assert.match(server, /app\.get\('\/audit',[\s\S]{0,160}?audit\.html'\)/,
    '/audit does not serve public/audit.html — express.static has no `extensions` ' +
    'option, so the .html filename alone is not a reachable screen');
  // The route it reads is still the Super Admin's. If this ever widens, the
  // tile's gate below widens with it as a deliberate decision, not by drift.
  const api = server.slice(server.indexOf("app.get('/api/admin/audit-log'"));
  // The trailing comma matters: `requireAdminHubAccess` CONTAINS the string
  // `requireAdmin`, so a bare match could not tell the Super Admin gate from
  // the wider hub gate — it survived that mutation until this was tightened.
  assert.match(api.slice(0, 200), /authenticateToken, requireAuditReader,/,
    'the audit-log read is no longer requireAdmin');
});

test('the page asks for the log through the route, with the token in the header', () => {
  assert.match(js, /\/api\/admin\/audit-log\?/, 'the page does not call the audit-log route');
  // The house rule, build-enforced since PR #113: a Bearer header may not
  // inline a localStorage read. An inline read that misses sends
  // `Bearer null`, which answers AUTH_INVALID and signs the admin out —
  // indistinguishable from a dead session until somebody reads the network tab.
  const headers = [...js.matchAll(/Authorization:\s*`Bearer \$\{([^}]*)\}`/g)].map(m => m[1].trim());
  assert.ok(headers.length, 'no Bearer header found');
  for (const expr of headers) {
    assert.equal(expr, 'getToken()',
      `a Bearer header is built from \`${expr}\` instead of the page's token helper`);
  }
  assert.match(js, /const getToken = \(\) =>[\s\S]{0,140}admin_token/,
    'getToken does not read the key the admin pages actually write');
});

// ---- 2. reads only ----------------------------------------------------------

test('nothing on this page can change or remove an entry', () => {
  // Append-only is the entire value of an audit log. The page has exactly one
  // request helper and it sends no method, so it can only ever GET.
  assert.doesNotMatch(js, /method:\s*['"`](POST|PUT|PATCH|DELETE)/i,
    'the audit page issues a write');
  assert.doesNotMatch(js, /\b(fetch|axios)\s*\([^)]*,\s*\{[^}]*method/i,
    'the audit page passes a method to fetch');
  // And no such route exists to call. Scanned across the whole server rather
  // than one handler: a delete added anywhere under this path is the defect.
  const writes = [...server.matchAll(/app\.(post|put|patch|delete)\('([^']*audit[^']*)'/gi)]
    .map(m => `${m[1].toUpperCase()} ${m[2]}`);
  assert.deepEqual(writes, [],
    `a write route now exists on the audit log: ${writes.join(', ')}`);
});

// ---- 3. the clock ------------------------------------------------------------

test('the zone comes from gfc-time.js, never a literal in the page', () => {
  assert.doesNotMatch(page, /America\/New_York/,
    'the audit page restates the practice timezone instead of reading it from gfc-time.js');
  assert.match(js, /window\.GFC_TIME && window\.GFC_TIME\.PRACTICE_TIMEZONE/,
    'the page does not read the zone from the one source of the clock');
  assert.match(page, /<script src="\/gfc-time\.js">/,
    'gfc-time.js is not loaded on the page');
  assert.equal(gfcTime.PRACTICE_TIMEZONE, 'America/New_York',
    'the shared clock no longer answers Eastern — this page follows it, so check both');
});

test('the page never prints "Eastern" over a clock it cannot prove is Eastern', () => {
  // Lifted and RUN both ways. The app must not claim a state it cannot
  // observe: if gfc-time.js did not load there is no zone, and labelling the
  // viewer's own clock "Eastern" is a wrong answer to a compliance question.
  const src = js.slice(js.indexOf('const TZ ='), js.indexOf('const fmtTs'));
  const label = (hasTime) => {
    // eslint-disable-next-line no-new-func
    const f = new Function('window', `${src}; return { TZ, TZ_LABEL };`);
    return f(hasTime ? { GFC_TIME: { PRACTICE_TIMEZONE: 'America/New_York' } } : {});
  };
  const withTime = label(true);
  assert.equal(withTime.TZ, 'America/New_York');
  assert.match(withTime.TZ_LABEL, /Eastern/);
  const without = label(false);
  assert.ok(!without.TZ, 'a missing gfc-time.js still yielded a zone');
  assert.doesNotMatch(without.TZ_LABEL, /^Eastern$/,
    'with no clock loaded the page still calls its timestamps Eastern');
  assert.match(without.TZ_LABEL, /NOT Eastern/i,
    'the fallback label does not say the times are not Eastern');
  // And the label is what the screen shows, in both places that name a zone.
  assert.match(js, /When \(\{TZ_LABEL\}\)/, 'the column header hardcodes its zone name');
  assert.match(js, /Times are \{TZ_LABEL\}/, 'the filter note hardcodes its zone name');
});

test('a local datetime filter is resolved against the practice zone, not sent raw', () => {
  // A `datetime-local` box yields "YYYY-MM-DDTHH:mm" with NO zone. Sent as
  // is, the server reads it as UTC — five hours adrift in Georgia in
  // November, so "since 9am" would silently mean 4am and return five extra
  // hours of other people's activity.
  const src = js.slice(js.indexOf('const easternToIso'), js.indexOf('const METHOD_CLASS'));
  // eslint-disable-next-line no-new-func
  const easternToIso = new Function('window', `${src}; return easternToIso;`)({ GFC_TIME: gfcTime });
  assert.equal(easternToIso(''), '');
  // 2026-11-06 is EST (UTC-5): 09:00 Eastern is 14:00Z.
  assert.equal(easternToIso('2026-11-06T09:00'), '2026-11-06T14:00:00.000Z');
  // And across the daylight-saving boundary the offset is not a constant:
  // 2026-10-30 is EDT (UTC-4), so the same wall clock is 13:00Z.
  assert.equal(easternToIso('2026-10-30T09:00'), '2026-10-30T13:00:00.000Z');
});

// ---- 4. the cap, which is the honest part ------------------------------------

test('readAudit still has no offset, so the page must not offer paging', () => {
  // This is the premise the warning rests on. If a later session adds an
  // offset, this test fails and the page should gain real paging — the
  // warning becomes a lie at that moment, not a harmless leftover.
  assert.match(store, /ORDER BY id DESC LIMIT \$\$\{params\.length\}|ORDER BY id DESC LIMIT/,
    'the Postgres audit read no longer orders newest-first with a bare LIMIT');
  const pg = store.slice(store.indexOf('async readAudit({'), store.indexOf('async countAudit()'));
  assert.doesNotMatch(pg, /OFFSET/i, 'readAudit gained an OFFSET — the page needs real paging now');
  assert.doesNotMatch(js, /load more/i, 'the page offers "Load more" over a read that cannot page');
  assert.doesNotMatch(js, /\boffset\b/i, 'the page sends an offset the route does not accept');
});

test('a full page says so, and says narrowing the dates is the way to older rows', () => {
  // Anchored AFTER the declaration, not from the top of the file: `return (`
  // appears in the Row component above, so a bare indexOf sliced backwards and
  // handed `new Function` an empty string — which fails loudly here but would
  // have passed vacuously had the assertion been a regex over the slice.
  const start = js.indexOf('const atCap =');
  assert.ok(start > 0, 'atCap is gone from the page');
  const src = js.slice(start, js.indexOf('return (', start));
  assert.ok(src.includes('atCap'), 'the atCap slice is empty — the anchors moved');
  const atCap = (count, limit) => {
    // eslint-disable-next-line no-new-func
    const f = new Function('data', 'limit', `${src}; return atCap;`);
    return f({ count }, limit);
  };
  assert.ok(atCap(200, 200), 'a page filled to the cap did not warn');
  assert.ok(!atCap(199, 200), 'a short page warned anyway, which would train people to ignore it');
  assert.ok(!atCap(0, 200), 'an empty result warned about a cap it never reached');
  const warn = js.slice(js.indexOf('{atCap &&'), js.indexOf('</div>', js.indexOf('{atCap &&')));
  assert.match(warn, /newest \{limit\} in the window/,
    'the warning does not say the rows shown are the newest in the window');
  assert.match(warn, /narrowing the From and To dates/,
    'the warning does not say how to reach older entries');
  assert.match(warn, /raising the row\s*\n?\s*count only moves the cap/,
    'the warning lets someone think a bigger limit reaches further back');
});

test('an empty result is not reported as nothing having happened', () => {
  // An empty result is not a diagnosis — the ICD-10 lesson, pointed at a
  // compliance screen where the stakes are "nobody opened her record".
  const empty = js.slice(js.indexOf('No entries match these filters'));
  assert.match(empty.slice(0, 400), /not the same as nothing having happened/,
    'the empty state reads as a statement about the log rather than about the filters');
  assert.match(js, /OpenEMR patient uuid/,
    'the patient box does not say the value is a uuid, so a typed name reads as "nobody opened this record"');
});

// ---- 5. who can see it -------------------------------------------------------

test('the hub tile is the Super Admin\'s, because the route is', () => {
  const at = hub.indexOf('href="/audit"');
  assert.ok(at > 0, 'nothing in the admin hub links to /audit');
  // The gate must be the nearest thing BEFORE the link, not merely present
  // somewhere on a 4,000-line page. Bounded to the window the tile occupies,
  // so deleting the gate leaves the previous tile's markup here and fails.
  const before = stripComments(hub.slice(Math.max(0, at - 700), at));
  assert.match(before, /user\?\.role === 'admin' && \(\s*<a\s*$/,
    'the Audit Log tile is not gated on the Super Admin, so it would answer 403');
  const tile = hub.slice(at, hub.indexOf('</a>', at) + 4);
  assert.match(tile, /Audit Log/, 'the tile does not name itself');
  assert.match(tile, /accounting of disclosures/,
    'the tile does not say what the log is for');
});

test('the page says plainly that it is append-only', () => {
  assert.match(js, /Append-only/,
    'the page does not tell its reader that nothing here can be edited');
});
