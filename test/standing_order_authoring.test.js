// ============================================================
// A provider can author a standing order (owner: "Fix all", 2026-11-06)
//
// Session 4.8 built the mechanism that lets an RN, LCSW or LMSW place an order
// under a provider's standing authority. FOUR OF ITS FIVE ROUTES HAD NO
// CALLER — create, read one, revise, activate/retire — so nobody could write
// the protocol the whole mechanism rests on. The feature has never been usable.
//
// It hid because the orphan-route guard matches on PATH, not method: the page
// calls GET /api/clinical/standing-orders?executable=true to fill the order and
// screening pickers, so the POST at the same path read as wired. See
// METHOD_LEVEL_GAPS in test/no_orphan_routes.test.js.
// Run: npm test
// ============================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'clinical.html'), 'utf8');
const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const standingOrders = require('../standingOrders');
const clinicalRoles = require('../clinicalRoles');
// Comments stripped before any scan: an apostrophe in prose has already cost
// this repo a wrong answer in the route matcher.
const strip = (s) => s.replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

const sliceOf = (code, start, end, name) => {
  const a = code.indexOf(start);
  assert.ok(a > 0, `${name}: start anchor not found (${start})`);
  const b = code.indexOf(end, a + 1);
  assert.ok(b > a, `${name}: end anchor moved (${end})`);
  const out = code.slice(a, b);
  assert.ok(out.length > 300, `${name}: slice looks wrong (${out.length} chars)`);
  return out;
};

test('all four authoring routes now have a caller', () => {
  const code = strip(PAGE);
  // The whole point: before this, only the executable list was called.
  assert.match(code, /createStandingOrder: \(body\) => authedFetch\('\/api\/clinical\/standing-orders', \{ method: 'POST'/);
  assert.match(code, /standingOrder: \(id\) => authedFetch\(`\/api\/clinical\/standing-orders\/\$\{id\}`\)/);
  assert.match(code, /reviseStandingOrder: \(id, body\) => authedFetch\(`\/api\/clinical\/standing-orders\/\$\{id\}\/revise`, \{ method: 'POST'/);
  assert.match(code, /standingOrderStatus: \(id, status\) => authedFetch\(`\/api\/clinical\/standing-orders\/\$\{id\}\/status`, \{ method: 'POST'/);
  // And each helper is actually invoked — a helper nobody calls is the same
  // defect one layer in.
  for (const fn of ['createStandingOrder', 'reviseStandingOrder', 'standingOrderStatus', 'standingOrder', 'allStandingOrders']) {
    assert.match(code, new RegExp(`api\\.${fn}\\(`), `nothing calls api.${fn}`);
  }
});

test('the view is reachable: a nav entry and a route that renders it', () => {
  const code = strip(PAGE);
  assert.match(code, /\{ key: 'protocols', tab: 'Protocols'/, 'no nav entry');
  // A component nothing renders is exactly the defect this PR is fixing.
  assert.match(code, /\{view === 'protocols' && <ProtocolsView \/>\}/, 'the view is never rendered');
});

test('write controls are drawn from the SERVED capability, never a role check in the page', () => {
  const code = strip(PAGE);
  // Anchored on CODE: `strip` blanks comments, so a comment anchor is never
  // found. Caught by this test failing on its first run.
  const view = sliceOf(code, 'const ProtocolsView = ', 'const Prefilled = ', 'ProtocolsView');
  assert.match(view, /const canAuthor = !!data\.canAuthor;/, 'canAuthor must come from the server');
  // The route re-checks the capability; a page that decides it itself can
  // offer a button the server refuses, or hide one it would have allowed.
  assert.doesNotMatch(view, /clinicalRole === 'provider'|role === 'provider'/,
    'the page must not decide the credential question');
  // New Protocol is behind it, and a reader who cannot author is TOLD why,
  // in the server's own words, rather than left hunting for a missing button.
  assert.match(view, /\{canAuthor && <button className="btn gold"/);
  assert.match(view, /\{!canAuthor && <div className="card[^>]*>\{data\.authorRefusal\}/);
  // The server serves that refusal from the shared reasons table.
  assert.match(SERVER, /authorRefusal: clinicalRoles\.CAPABILITY_REASONS\.authorStandingOrder/);
});

test('every option is served, so the form cannot offer one the validator drops', () => {
  const code = strip(PAGE);
  const route = sliceOf(SERVER, "app.get('/api/clinical/standing-orders'", '\n});', 'list route');
  for (const f of ['orderTypes', 'executorRoles', 'roleLabels', 'patientScopes']) {
    assert.match(route, new RegExp(`${f}:`), `the list route must serve ${f}`);
  }
  // buildStandingOrder FILTERS anything outside its own lists, so a hardcoded
  // option would read as accepted and authorise nothing.
  const form = sliceOf(code, 'const ProtocolForm = ', 'const ProtocolDetail = ', 'ProtocolForm');
  assert.match(form, /\(meta\.orderTypes \|\| \[\]\)\.map/);
  assert.match(form, /\(meta\.executorRoles \|\| \[\]\)\.map/);
  assert.match(form, /\(meta\.patientScopes \|\| \[\]\)\.map/);
  for (const bad of ["'lab'", "'imaging'", "'procedure'", "'rn'", "'lcsw'", "'lmsw'"]) {
    assert.ok(!form.includes(`[${bad}`) && !form.includes(`${bad},`),
      `the form must not name ${bad} itself — it is served`);
  }
});

test('activating needs a signature, and the form says so before the save fails', () => {
  const code = strip(PAGE);
  const form = sliceOf(code, 'const ProtocolForm = ', 'const ProtocolDetail = ', 'ProtocolForm');
  assert.match(form, /if \(activate && !sig\)/, 'the form must refuse to activate unsigned');
  assert.match(form, /Save it as a draft if you are not ready to sign/,
    'and offer the thing they can do instead');
  // The server refuses it too; the client check is a courtesy, not the control.
  const unsigned = standingOrders.buildStandingOrder({
    id: 'x',
    input: {
      title: 'T', permittedOrderTypes: ['lab'], permittedTests: ['HbA1c'],
      permittedExecutorRoles: ['rn'], indications: ['E11.9'],
      expiresAt: '2027-01-01', status: 'active'
    },
    // A PROVIDER: without a clinical role the builder refuses on the
    // capability check first and this would test the wrong rule.
    author: { id: 'p', name: 'P', role: 'user', clinicalRole: 'provider' }
  });
  assert.equal(unsigned.code, 'STANDING_ORDER_UNSIGNED');
});

test('a revision starts from the version it supersedes', () => {
  const code = strip(PAGE);
  const form = sliceOf(code, 'const ProtocolForm = ', 'const ProtocolDetail = ', 'ProtocolForm');
  // Retyping a protocol to change its expiry is how a test goes missing from
  // the permitted list without anybody noticing.
  assert.match(form, /const \[f, setF\] = useState\(\(\) => \(existing \? fromExisting\(existing\) : blank\)\)/);
  assert.match(form, /permittedTests: \(o\.permittedTests \|\| \[\]\)\.join\('\\n'\)/);
  assert.match(form, /permittedOrderTypes: \[\.\.\.\(o\.permittedOrderTypes \|\| \[\]\)\]/);
  // And it says what a revision does, because retiring the old version is not
  // obvious from a button marked Revise.
  assert.match(form, /creates version \{\(existing\.version \|\| 1\) \+ 1\} and retires v\{existing\.version\}/);
});

test('a protocol is retired, never deleted, and an expired one is revised not activated', () => {
  const code = strip(PAGE);
  const detail = sliceOf(code, 'const ProtocolDetail = ', 'const ProtocolsView = ', 'ProtocolDetail');
  assert.match(detail, /setStatus\('retired'\)/);
  assert.match(detail, /setStatus\('active'\)/);
  // No delete: orders executed under a version reference that version.
  assert.ok(!/deleteStandingOrder|method: 'DELETE'/.test(detail), 'a protocol must not be deletable from here');
  // Activate is offered on a draft only, and an expired one is told to revise.
  assert.match(detail, /o\.effectiveStatus === 'draft' && <button[^>]*>\s*<\/button>|o\.effectiveStatus === 'draft'/);
  assert.match(detail, /This protocol has expired/);
  assert.match(detail, /Revise it to issue a new version/);
  // The server agrees: activating an expired protocol is refused.
  const expired = standingOrders.setStandingOrderStatus(
    { id: 'x', status: 'draft', signatureImage: 'data:image/png;base64,AAA', signedAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-02-01T00:00:00.000Z' },
    'active', { role: 'user', clinicalRole: 'provider' }, '2026-11-06T00:00:00.000Z');
  assert.equal(expired.code, 'STANDING_ORDER_EXPIRED');
});

test('the version history is shown, because an execution references its version', () => {
  const code = strip(PAGE);
  const detail = sliceOf(code, 'const ProtocolDetail = ', 'const ProtocolsView = ', 'ProtocolDetail');
  assert.match(detail, /\(d\.versions \|\| \[\]\)\.length > 1/);
  assert.match(detail, /you are reading this one/, 'the current version must be identifiable in the lineage');
  assert.match(detail, /d\.executionCount/, 'how often it has been executed belongs on the document');
});

test('the executor list offers no provider, and says why', () => {
  // A provider needs no protocol, so EXECUTOR_ROLES excludes one. If that ever
  // changes, the form copy below becomes wrong.
  assert.deepEqual([...standingOrders.EXECUTOR_ROLES], ['rn', 'lcsw', 'lmsw']);
  assert.ok(!standingOrders.EXECUTOR_ROLES.includes(clinicalRoles.CLINICAL_ROLES.PROVIDER));
  const form = sliceOf(strip(PAGE), 'const ProtocolForm = ', 'const ProtocolDetail = ', 'ProtocolForm');
  assert.match(form, /A provider needs no protocol, so a provider is not an option/);
  // And that naming a role cannot widen their licence.
  assert.match(form, /licence ceiling at execution/);
});

test('an empty tests or indications entry is dropped, not sent as a blank', () => {
  const code = strip(PAGE);
  assert.match(code, /const protoList = \(text\) => String\(text \|\| ''\)\.split\(\/\[\\n,\]\/\)\.map\(t => t\.trim\(\)\)\.filter\(Boolean\)/);
  // The server refuses an empty list by name, so sending blanks would surface
  // as a confusing refusal rather than a dropped row.
  const noTests = standingOrders.buildStandingOrder({
    id: 'x',
    input: { title: 'T', permittedOrderTypes: ['lab'], permittedTests: ['', '  '], permittedExecutorRoles: ['rn'], indications: ['E11.9'], expiresAt: '2027-01-01' },
    author: { id: 'p', name: 'P', role: 'user', clinicalRole: 'provider' }
  });
  assert.equal(noTests.code, 'STANDING_ORDER_NO_TESTS');
});
