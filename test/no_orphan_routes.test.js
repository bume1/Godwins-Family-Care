// ============================================================
// No orphan routes (owner-directed, 2026-11-05: "we need to address this
// issue of routes with no ui")
//
// Five times this repo has shipped a live, gated, tested route that NO screen
// called, so the capability silently did not exist: the facility assignment,
// the MFA reset, `acknowledgeAbnormalResult`, the veteran roster edit, and the
// provider picker. Each time, route tests proved the endpoint worked and page
// tests proved the component rendered, and nothing asserted the two were
// connected.
//
// This test is that assertion. Every `/api/` route either has a caller in
// `public/`, or is named below with a reason. Adding to the list is a
// deliberate act somebody has to justify in writing.
//
// WHAT IT CANNOT DO, said plainly so nobody trusts it for more: it proves a
// path APPEARS in a page, not that the control is reachable. The
// care-coordinator defect of the same day would have passed — the route was
// called, behind a flag that was false for that role.
// Run: npm test
// ============================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const routeCallers = require('../routeCallers');

const ROOT = path.join(__dirname, '..');

// ---- The allow-list -----------------------------------------------------
// `reason` is required and is what a reviewer reads. `evidence` points at the
// line that makes the claim checkable where the route IS reachable but by a
// route this matcher cannot follow.
const NOT_UI_CALLED = [
  // --- Machine-to-machine: another system posts to these -----------------
  { method: 'POST', path: '/api/webhooks/stripe', reason: 'Stripe posts here; signature-verified. Never a browser.' },
  { method: 'POST', path: '/api/webhooks/quo', reason: 'Quo posts here. Never a browser.' },
  { method: 'POST', path: '/api/payroll/paystubs', reason: 'The payroll Google Apps Script posts here with PAYROLL_INGEST_KEY. Never a browser.', evidence: 'scripts/payroll_paystubs.gs' },
  { method: 'GET', path: '/api/payroll/automation/tax-sources', reason: 'The payroll automations Apps Script reads the pages to watch here with PAYROLL_INGEST_KEY. Never a browser.', evidence: 'scripts/payroll_automations.gs' },
  { method: 'POST', path: '/api/payroll/automation/:p', reason: 'The payroll automations Apps Script posts here with PAYROLL_INGEST_KEY on its triggers. Never a browser.', evidence: 'scripts/payroll_automations.gs' },
  { method: 'POST', path: '/api/webhooks/hubspot', reason: 'HubSpot posts here; validateHubSpotWebhook. Never a browser.' },
  { method: 'POST', path: '/api/webhook/hubspot/ticket-created', reason: 'HubSpot ticket webhook. Never a browser.' },
  { method: 'POST', path: '/api/webhook/hubspot/ticket-stage-change', reason: 'HubSpot ticket webhook. Never a browser.' },

  // --- Clicked from an email, so the URL is built in the mail, not a page -
  { method: 'GET', path: '/api/unsubscribe', reason: 'Clicked from an email; the URL is built in emailTemplates.js.', evidence: 'emailTemplates.js' },
  { method: 'GET', path: '/api/resubscribe', reason: 'Clicked from an email; the URL is built in emailTemplates.js.', evidence: 'emailTemplates.js' },

  // --- Reachable, but by a URL the SERVER hands to the page --------------
  // The page opens `o.url` without ever writing the path, so no grep can find
  // it. Each `evidence` is the line that builds the URL.
  { method: 'GET', path: '/api/gfc/clinical/care-plan.pdf', reason: 'Opened from the URL the server puts on carePlan.signedPdf.', evidence: 'server.js builds signedPdf.url; portal.html:5896 opens it' },
  { method: 'GET', path: '/api/gfc/enrollment-packet.pdf', reason: 'Opened from a server-built document url.', evidence: 'server.js:8388 → portal.html:6794 opens o.url' },
  { method: 'GET', path: '/api/gfc/enrollment-packet.zip', reason: 'Opened from a server-built document url.', evidence: 'server.js:8403 consentPacketZip.url → portal.html:6794' },
  { method: 'GET', path: '/api/gfc/documents/uploads/:id/file', reason: 'Opened from a server-built document url.', evidence: 'server.js:8292 / 18634 build url' },
  { method: 'GET', path: '/api/gfc/admin/enrollment/:clientId/enrollment-packet.zip', reason: 'Opened from client.packetZipUrl.', evidence: 'server.js:20757 → admin-enrollment.html:2459' },
  { method: 'GET', path: '/api/gfc/admin/enrollment/:clientId/consent/:type.pdf', reason: 'Opened from consent.signedCopyUrl.', evidence: 'admin-enrollment.html:1547' },
  { method: 'GET', path: '/api/gfc/admin/enrollment/:clientId/consent/:type/blank.pdf', reason: 'Opened from consent.blankCopyUrl.', evidence: 'admin-enrollment.html:1150' },
  { method: 'POST', path: '/api/gfc/admin/enrollment/:clientId/consent/:type/offline', reason: 'Posted to consent.recordOfflineUrl.', evidence: 'admin-enrollment.html:1130' },

  // --- Retired on purpose: these answer 410 so a cached page gets a reason
  { method: 'GET', path: '/api/gfc/messages', reason: 'Retired in Session 9; answers 410 MESSAGING_MOVED by design.' },
  { method: 'POST', path: '/api/gfc/messages', reason: 'Retired in Session 9; answers 410 MESSAGING_MOVED by design.' },

  // --- Dormant lab-era HubSpot connector --------------------------------
  // CLAUDE.md, standing instruction: "Do not delete — dormant lab HubSpot
  // connector… intentionally retained but inactive (reactivate on CRM
  // upgrade). Do not remove it in any session." So these get no screen AND no
  // deletion. They are listed here to say that is deliberate, not forgotten.
  { method: 'GET', path: '/api/admin/portal-tickets', reason: 'Dormant lab HubSpot connector; CLAUDE.md says retain, do not remove.' },
  { method: 'DELETE', path: '/api/admin/portal-tickets', reason: 'Dormant lab HubSpot connector; CLAUDE.md says retain, do not remove.' },
  { method: 'GET', path: '/api/admin/ticket-config', reason: 'Dormant lab HubSpot connector; CLAUDE.md says retain, do not remove.' },
  { method: 'PUT', path: '/api/admin/ticket-config', reason: 'Dormant lab HubSpot connector; CLAUDE.md says retain, do not remove.' },
  { method: 'GET', path: '/api/admin/ticket-polling/config', reason: 'Dormant lab HubSpot connector; CLAUDE.md says retain, do not remove.' },
  { method: 'PUT', path: '/api/admin/ticket-polling/config', reason: 'Dormant lab HubSpot connector; CLAUDE.md says retain, do not remove.' },
  { method: 'POST', path: '/api/admin/ticket-polling/reset', reason: 'Dormant lab HubSpot connector; CLAUDE.md says retain, do not remove.' },
  { method: 'POST', path: '/api/admin/ticket-polling/trigger', reason: 'Dormant lab HubSpot connector; CLAUDE.md says retain, do not remove.' },
  { method: 'GET', path: '/api/hubspot/deals', reason: 'Dormant lab HubSpot connector; CLAUDE.md says retain, do not remove.' },
  { method: 'POST', path: '/api/hubspot/upload-to-deal', reason: 'Dormant lab HubSpot connector; CLAUDE.md says retain, do not remove.' },
  { method: 'GET', path: '/api/hubspot/record/:recordId', reason: 'Dormant lab HubSpot connector; CLAUDE.md says retain, do not remove.' },
  { method: 'GET', path: '/api/client/hubspot/file/:fileId', reason: 'Dormant lab HubSpot connector; CLAUDE.md says retain, do not remove.' },

  // --- One-off operator tools, run by hand, never a screen --------------
  { method: 'POST', path: '/api/bootstrap-admin', reason: 'Deliberate lockout recovery, run by hand. Its own comment says to remove it once the admin is confirmed.' },
  { method: 'POST', path: '/api/messaging/admin/migrate-interim', reason: 'One-off Session 9 migration, run by hand. Admin-gated inside the handler.' },
  { method: 'POST', path: '/api/projects/:id/fix-client-names', reason: 'One-off data repair, run by hand.' },
  { method: 'DELETE', path: '/api/admin/reset-test-data', reason: 'Test-data helper, run by hand; never for production use.' },

  // --- Superseded login surfaces ----------------------------------------
  // Every page posts to /api/auth/login only. These three are kept so an old
  // cached client still authenticates; they are delete candidates, not
  // missing screens. OWNER DECISION PENDING — see the decision file.
  { method: 'POST', path: '/api/auth/admin-login', reason: 'Superseded by /api/auth/login; every page uses that one. Delete candidate, owner decision pending.' },
  { method: 'POST', path: '/api/auth/client-login', reason: 'Superseded by /api/auth/login; every page uses that one. Delete candidate, owner decision pending.' },
  { method: 'POST', path: '/api/auth/service-login', reason: 'Superseded by /api/auth/login; every page uses that one. Delete candidate, owner decision pending.' },

  // --- Vestigial --------------------------------------------------------
  { method: 'GET', path: '/api/config', reason: 'Public non-sensitive config for "frontend portals"; no portal reads it. Vestigial, delete candidate.' }
];

const KEY = (r) => `${r.method} ${routeCallers.normalizeRoutePath(r.path)}`;

// ---- The work list ------------------------------------------------------
// Routes with no caller and no allow-list entry: capabilities users cannot
// perform. Each is a screen somebody owes. This list shrinks as they land; it
// must never grow, which is what the first test enforces.
// EIGHTEEN ENTRIES LEFT THIS LIST ON 2026-11-06, which is the list working:
// each was a capability nobody could reach, each now has a screen, and the
// assertion below is what said so. Three remain, and every one of them is an
// OWNER DECISION rather than an oversight: the lab-era service-report
// signature, the financial-change request, and the notification-preferences
// route whose three keys nothing in this repo reads.
const KNOWN_MISSING_SCREENS = [
  'PUT /api/client/service-reports/:p/sign',
  'POST /api/users/:p/financial-change-requests',
  'PUT /api/users/:p/notification-preferences'
];

// ---- Method-level gaps the matcher cannot see --------------------------
// `routeCallers` matches on PATH, not method, so a page that GETs `/api/x`
// satisfies a POST route at `/api/x`. These were found by hand and are listed
// here because no assertion below can find them — the matcher calls them
// wired. Written down rather than left in a head: a known blind spot with a
// list is a limitation, the same blind spot without one is a lie.
const METHOD_LEVEL_GAPS = [
  {
    method: 'GET', path: '/api/clinical/visits/:eid/timing',
    note: 'REDUNDANT, not a missing capability: the page POSTs to this path to stamp a visit ' +
          '(clinical.html:271) and reads timing back as `v.timing` embedded in the encounter ' +
          'payload, never from this GET. Nothing is owed a screen.'
  }
];

test('the method-level gap list is honest about what it holds', () => {
  const routes = routeCallers.collectRoutes(ROOT);
  const defined = new Set(routes.map(KEY));
  for (const g of METHOD_LEVEL_GAPS) {
    assert.ok(defined.has(`${g.method} ${routeCallers.normalizeRoutePath(g.path)}`),
      `${g.method} ${g.path} is not a route any more; drop the entry`);
    // A length check could not tell a gutted note from a whole one (the note
    // is concatenated, so losing a line still leaves plenty of characters).
    // Require it to CITE THE CALL SITE that makes the claim checkable — the
    // file and line of the call the matcher saw instead. That is the fact a
    // reader needs to confirm or refute the entry.
    assert.match(g.note, /\b[a-z-]+\.html:\d+/,
      `${g.method} ${g.path}: the note must cite the call site (file.html:line) the matcher saw instead`);
    assert.ok(g.note.length >= 60, `${g.method} ${g.path} needs a real note`);
  }
  // These are exactly the routes the matcher CANNOT help with: if one ever
  // starts reading as an orphan on its path alone, it belongs in the normal
  // lists instead and this entry should go.
  const callers = routeCallers.collectCallerPaths(ROOT);
  const isCalled = routeCallers.buildMatcher(callers);
  for (const g of METHOD_LEVEL_GAPS) {
    assert.ok(isCalled(g.path),
      `${g.path} now reads as an orphan on its path alone — move it to KNOWN_MISSING_SCREENS or NOT_UI_CALLED`);
  }
});

test('no API route is unreachable from the front end without a written reason', () => {
  const routes = routeCallers.collectRoutes(ROOT);
  const callers = routeCallers.collectCallerPaths(ROOT);
  const isCalled = routeCallers.buildMatcher(callers);

  // The matcher must not be vacuously permissive: if it claims everything is
  // called, it proves nothing. Sanity-check the shape of what it collected.
  assert.ok(routes.length > 400, `expected hundreds of routes, found ${routes.length}`);
  assert.ok(callers.size > 500, `expected hundreds of caller paths, found ${callers.size}`);

  const allowed = new Set(NOT_UI_CALLED.map(KEY));
  const orphans = routes.filter(r => !isCalled(r.path)).map(r => ({ ...r, key: KEY(r) }));
  const unexplained = orphans.filter(o => !allowed.has(o.key));
  const known = new Set(KNOWN_MISSING_SCREENS);
  const brandNew = unexplained.filter(o => !known.has(o.key));

  assert.deepEqual(
    brandNew.map(o => `${o.key}  (${o.file}:${o.line})`),
    [],
    'A route was added that no page calls. Wire it to a screen, or add it to ' +
    'NOT_UI_CALLED with a reason. A capability nobody can reach is not shipped.'
  );
});

test('the allow-list cannot rot: every entry still names a real, still-uncalled route', () => {
  const routes = routeCallers.collectRoutes(ROOT);
  const callers = routeCallers.collectCallerPaths(ROOT);
  const isCalled = routeCallers.buildMatcher(callers);
  const defined = new Map(routes.map(r => [KEY(r), r]));

  const stale = [];
  for (const entry of NOT_UI_CALLED) {
    const key = KEY(entry);
    if (!defined.has(key)) { stale.push(`${key} — no such route any more; drop the entry`); continue; }
    // An entry that has since GAINED a caller is the good outcome, and it
    // still has to be removed, or the list becomes a place to hide things.
    if (isCalled(entry.path)) stale.push(`${key} — now has a caller; drop the entry`);
  }
  assert.deepEqual(stale, [], 'NOT_UI_CALLED has stale entries');
});

test('every allow-list entry carries a reason a reviewer can weigh', () => {
  for (const e of NOT_UI_CALLED) {
    assert.ok(e.method && e.path && e.path.startsWith('/api/'), `malformed entry: ${JSON.stringify(e)}`);
    assert.ok(typeof e.reason === 'string' && e.reason.length >= 25,
      `${KEY(e)} needs a real reason, not "${e.reason}"`);
  }
  // No duplicates — two entries for one route means one of them is unread.
  const keys = NOT_UI_CALLED.map(KEY);
  assert.equal(new Set(keys).size, keys.length, 'duplicate entries in NOT_UI_CALLED');
});

test('the work list cannot rot either: a screen that landed must leave it', () => {
  const routes = routeCallers.collectRoutes(ROOT);
  const callers = routeCallers.collectCallerPaths(ROOT);
  const isCalled = routeCallers.buildMatcher(callers);
  const defined = new Map(routes.map(r => [KEY(r), r]));

  const stale = [];
  for (const key of KNOWN_MISSING_SCREENS) {
    if (!defined.has(key)) { stale.push(`${key} — no such route any more`); continue; }
    if (isCalled(defined.get(key).path)) stale.push(`${key} — now wired; remove it from KNOWN_MISSING_SCREENS`);
  }
  assert.deepEqual(stale, [], 'KNOWN_MISSING_SCREENS is out of date');
});

// ---- The matcher's own reading, pinned ----------------------------------
// Each of these is a shape that produced a WRONG answer while this was being
// built, so each is a regression test rather than a demonstration.
test('the matcher reads all four shapes a path reaches a page in', () => {
  const v = (s) => routeCallers.callerVariants(s);

  // A conditional query string with nested backticks. Reading this wrong
  // reported /api/clinical/patients — called four times — as an orphan.
  assert.ok(v('/api/clinical/patients${q ? `?q=${encodeURIComponent(q)}` : ``}').includes('/api/clinical/patients'));

  // A plain template parameter.
  assert.ok(v('/api/clinical/patients/${id}/appointments').includes('/api/clinical/patients/:p/appointments'));

  // Concatenation, which is how ime.html and caregiver-schedule.js build paths.
  const chain = routeCallers.concatChainFrom("'/api/ime/cases/' + encodeURIComponent(id) + '/documents'", 0);
  assert.ok(v(chain.text).includes('/api/ime/cases/:p/documents'));

  // Nested braces must not end the interpolation early.
  assert.equal(routeCallers.stripInterpolations('a${ {x:1} }b'), 'a\u0001b');
});

test('the matcher reproduces the known-fixed state (it would have caught all five)', () => {
  const callers = routeCallers.collectCallerPaths(ROOT);
  const isCalled = routeCallers.buildMatcher(callers);
  // Every one of these was an orphan once and has since been wired. If the
  // matcher calls any of them uncalled, it is too strict to be trusted.
  for (const p of [
    '/api/veterans/roster/:id',              // fixed 2026-11-05 (#248)
    '/api/users/:userId/mfa/reset',          // fixed 2026-09-27
    '/api/clinical/patients/:clientId/facility', // fixed in 4.9
    '/api/clinical/patients',                // never broken; a false positive in an earlier audit
    '/api/ime/cases/:caseId/documents/:docId',   // built by concatenation
    '/api/scheduling/shifts/:id/clock-in'    // built from a variable action name
  ]) {
    assert.ok(isCalled(p), `${p} has a caller but the matcher cannot see it`);
  }
});
