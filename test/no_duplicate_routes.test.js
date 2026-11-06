'use strict';
// A ROUTE REGISTERED TWICE IS A ROUTE WHOSE SECOND COPY NEVER RUNS.
//
// Express matches registrations in order, so the later one is dead — and it
// is not harmless, because it reads as live code. Five email-template routes
// were shadowed this way: somebody wrote the whole block again with pool
// variables, a tighter `requireAdmin` gate and the welcome-email preview fix
// from PR #81, and none of it had ever executed. The preview fix in
// particular meant the admin previewing the welcome email saw the generic
// house wrapper while the recipient got the credentials table.
//
// This test is the systemic half: the duplicates are gone, and the build
// fails if a path is ever registered twice again.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

// Every file that mounts routes, not just server.js. A grep bounded to one
// file is not a search.
const routeFiles = ['server.js', ...fs.readdirSync(path.join(root, 'routes'))
  .filter(f => f.endsWith('.js')).map(f => `routes/${f}`)];

const registrations = (src, obj) => {
  const re = new RegExp(`${obj}\\.(get|post|put|patch|delete)\\('([^']+)'`, 'g');
  const out = []; let m;
  while ((m = re.exec(src))) {
    out.push({ key: `${m[1].toUpperCase()} ${m[2]}`, line: src.slice(0, m.index).split('\n').length });
  }
  return out;
};

test('no path is registered twice in the same router', () => {
  const problems = [];
  for (const f of routeFiles) {
    const src = read(f);
    const obj = f === 'server.js' ? 'app' : 'router';
    const seen = new Map();
    for (const r of registrations(src, obj)) {
      if (!seen.has(r.key)) seen.set(r.key, []);
      seen.get(r.key).push(r.line);
    }
    for (const [key, lines] of seen) {
      if (lines.length > 1) problems.push(`${f}  ${key}  lines ${lines.join(', ')}`);
    }
  }
  assert.deepEqual(problems, [],
    'these paths are registered more than once; only the FIRST runs, and the rest ' +
    'are dead code that reads as live:\n  ' + problems.join('\n  '));
});

test('the scan is actually finding routes, so an empty result means something', () => {
  // An empty result is not a diagnosis. If the regex ever stops matching, the
  // test above would pass on nothing at all.
  const found = registrations(read('server.js'), 'app');
  assert.ok(found.length > 300, `only ${found.length} routes found in server.js — the scan is broken`);
  assert.ok(found.some(r => r.key === "GET /api/admin/audit-log" || r.key === "POST /api/admin/test-email"),
    'the scan did not find a route known to exist');
});

test('the dead email-template block is gone, and its one real fix was ported', () => {
  const s = read('server.js');
  // The live preview now carries the welcome email's own builder, which is
  // what the dead copy had and the live one lacked. Without it the PREVIEW
  // disagrees with both the test-send beside it and the real send.
  const preview = s.slice(s.indexOf("app.post('/api/admin/email-templates/:id/preview'"));
  const body = preview.slice(0, preview.indexOf('\n});'));
  assert.match(body, /template\.id === 'welcome_email'[\s\S]{0,80}WELCOME_HTML_BODY\(vars\)/,
    'the welcome email preview no longer uses its own builder, so it shows something the recipient will not get');
  // And the live block keeps what the dead one lacked.
  assert.match(s, /app\.get\('\/api\/admin\/email-templates\/pools'/, 'the /pools route is gone');
  const put = s.slice(s.indexOf("app.put('/api/admin/email-templates/:id'"));
  const putBody = put.slice(0, put.indexOf('\n});'));
  assert.match(putBody, /const \{ variables, poolGroups, pools, \.\.\.rest \} = t;/,
    'the update route no longer strips computed pool fields before persisting');
  assert.match(putBody, /logActivity\(/, 'the update route no longer writes an activity entry');
});

test('the notification preview is the email the drain sends, not a guess at it', () => {
  const s = read('server.js');
  const r = s.slice(s.indexOf("app.get('/api/admin/notifications/preview/:id'"));
  const body = r.slice(0, r.indexOf('\n});'));
  // Branding belongs to the drain (PR #90): a notice queued with only a body
  // is wrapped by buildQueuedEmail on its way out. Reading templateData
  // .htmlBody directly showed unbranded plain text for every one of those.
  assert.match(body, /buildQueuedEmail\(notification\.templateData, appBaseUrl\)/,
    'the preview route does not build the email the way the drain does');
  assert.doesNotMatch(body, /templateData\?\.body \|\|/,
    'the preview route still falls back to interpolating a raw body into HTML');
  assert.match(body, /nosniff/, 'the preview response is served without nosniff');
  // The drain and the preview must call the same builder, or they drift.
  const drain = s.slice(s.indexOf('// Branding belongs to the drain'));
  assert.match(drain.slice(0, 400), /buildQueuedEmail\(notification\.templateData, appBaseUrl\)/,
    'the drain no longer uses buildQueuedEmail — the preview claims to match it');
});

test('the admin page reads the preview from that route, and says so when it cannot', () => {
  const hub = read('public/admin-hub.html');
  assert.match(hub, /\/api\/admin\/notifications\/preview\/\$\{encodeURIComponent\(previewNotification\.id\)\}/,
    'the preview modal does not call the server route');
  assert.doesNotMatch(hub, /srcDoc=\{previewNotification\.templateData\?\.htmlBody/,
    'the modal still builds the preview in the page');
  assert.match(hub, /the preview itself failed/,
    'a failed preview read is not distinguished from an empty email');
  // No scripts run in the preview, whatever a stored body contains.
  // Read the ATTRIBUTE, not the surrounding window: my own comment beside it
  // contains the words "allow-scripts", so a window scan reported the iframe
  // as unsafe while it was correct. Fourth time this session that a comment
  // was read as code.
  const sandbox = /<iframe[\s\S]{0,900}?title="Email Preview"/.exec(hub);
  assert.ok(sandbox, 'the preview iframe is gone');
  const attr = /sandbox="([^"]*)"/.exec(sandbox[0]);
  assert.ok(attr, 'the preview iframe is not sandboxed');
  assert.equal(attr[1], 'allow-same-origin',
    `the preview iframe's sandbox is "${attr[1]}" — anything beyond allow-same-origin lets a stored body run`);
});

test('the test-email control exists, is the Super Admin\'s, and never claims more than the transport said', () => {
  const hub = read('public/admin-hub.html');
  assert.match(hub, /apiFetch\('\/api\/admin\/test-email'/, 'nothing calls the test-email route');
  const card = hub.slice(hub.indexOf('Send a test email') - 200, hub.indexOf('Send a test email') + 2200);
  assert.match(card, /activeTab === 'overview' && stats && isSuperAdmin/,
    'the test-email card is not gated on the Super Admin, but the route is requireAdmin');
  assert.match(card, /Accepted for delivery/,
    'the card claims the email arrived, which the transport cannot tell it');
  assert.match(card, /Not sent: \$\{testEmail\.result\.error/,
    'a failed send does not show the transport\'s own reason');
  const route = read('server.js');
  const r = route.slice(route.indexOf("app.post('/api/admin/test-email'"));
  assert.match(r.slice(0, 120), /authenticateToken, requireAdmin,/,
    'the test-email route is no longer Super Admin only');
});
