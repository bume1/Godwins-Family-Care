// ============================================================
// A care coordinator books appointments (owner, 2026-11-05)
//
// The defect this file pins: `resolveProviderScope` has given a care
// coordinator the whole practice's calendar since the role was added
// (2026-10-14), and the SCREEN never found out. The flag it drew the provider
// picker and the calendar filter from was a SECOND COPY of the rule, spelled
// `providersData.isAdmin` and naming admin and the case manager — so a
// coordinator the route would have accepted got a disabled "Provider —" box
// and a 400 APPT_NO_PROVIDER on save. Nothing had ever tested
// `resolveProviderScope`, which is exactly how the two drifted apart.
//
// So the tests here are in two halves:
//   1. the enforcer itself — who may work which calendar;
//   2. that the served flag is ASKED OF the enforcer and the page restates
//      nothing, which is what stops the next role from drifting the same way.
// Run: npm test
// ============================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'clinical.html'), 'utf8');
// A guard that reads a comment as code proves nothing — this repo has paid for
// that five times. Strip them before any source scan.
const stripComments = (s) => s.replace(/^\s*\/\/.*$/gm, '');

const lift = (anchor) => {
  const i = SERVER.indexOf(anchor);
  assert.ok(i > 0, `anchor not found: ${anchor}`);
  const body = SERVER.slice(i, SERVER.indexOf('\n};', i) + 3);
  assert.ok(body.length > 100 && body.length < 4000, `slice looks wrong (${body.length} chars)`);
  // eslint-disable-next-line no-new-func
  return new Function('config', 'clinicalRoles',
    `${body}; return ${anchor.replace('const ', '').replace(' = ', '')};`
  )(require('../config'), require('../clinicalRoles'));
};

const COORDINATOR = { id: 'co', role: 'user', isManager: true, clinicalRole: 'coordinator' };
const ADMIN = { id: 'ad', role: 'admin' };
const CASE_MANAGER = { id: 'cm', role: 'caseManager', clinicalRole: 'lmsw' };
const CLINICIAN = { id: 'np', role: 'user', clinicalRole: 'provider', openEmrProviderId: 7 };
const UNMAPPED = { id: 'nx', role: 'user', clinicalRole: 'provider' };

// ---- 1. The enforcer ---------------------------------------------------

test('a care coordinator may book on any provider calendar; a clinician only on their own', () => {
  const scope = lift('const resolveProviderScope = ');

  // The whole practice: the office roles plus the coordinator.
  for (const u of [ADMIN, CASE_MANAGER, COORDINATOR]) {
    assert.equal(scope(u, null).all, true, `${u.id} should get the unified view`);
    // and may name any provider, which is what booking for someone else is
    assert.equal(scope(u, '7').providerId, '7', `${u.id} should be able to pick provider 7`);
    assert.equal(scope(u, '7').error, undefined, `${u.id} should not be refused provider 7`);
  }

  // A clinician is locked to their own calendar and is REFUSED another's.
  assert.equal(scope(CLINICIAN, null).providerId, '7');
  assert.equal(scope(CLINICIAN, null).locked, true);
  assert.notEqual(scope(CLINICIAN, null).all, true);
  assert.equal(scope(CLINICIAN, '9').code, 'PROVIDER_SCOPE');

  // Mapped to no OpenEMR provider: named, never silently given everybody's.
  assert.equal(scope(UNMAPPED, null).code, 'PROVIDER_NOT_MAPPED');
  assert.notEqual(scope(UNMAPPED, null).all, true);
});

// ---- 2. The screen cannot disagree with it -----------------------------

test('the provider-picker flag is computed BY the enforcer, not restated', () => {
  const code = stripComments(SERVER);
  const i = code.indexOf("app.get('/api/clinical/providers'");
  assert.ok(i > 0, 'providers route not found');
  const route = code.slice(i, code.indexOf('\n});', i));

  // It must ASK resolveProviderScope. A hand-written list of roles here is the
  // bug: the enum grows, the route is updated, and this copy is not.
  assert.match(route, /canPickProvider:\s*resolveProviderScope\(/,
    'canPickProvider must be derived from resolveProviderScope');
  // And it must not name a role of its own anywhere in the response.
  assert.doesNotMatch(route, /ROLES\.(ADMIN|CASE_MANAGER)/,
    'the providers route must not decide calendar scope from a role name');
  // The misnamed flag is gone: `isAdmin` is what let a role be added to the
  // enforcer without anyone thinking to touch the screen's copy.
  assert.doesNotMatch(route, /isAdmin\s*:/, 'the isAdmin flag must not come back');
});

test('both calendar controls read the served flag, and the page decides no role', () => {
  const code = stripComments(PAGE);

  // The booking form's provider dropdown.
  const pick = /const canPickProvider = ([^;]+);/.exec(code);
  assert.ok(pick, 'canPickProvider declaration not found');
  assert.match(pick[1], /providersData\.canPickProvider/,
    'the picker must read the served flag');

  // The calendar's provider filter.
  const all = /const allCalendars = ([^;]+);/.exec(code);
  assert.ok(all, 'allCalendars declaration not found');
  assert.match(all[1], /providersData\.canPickProvider/,
    'the calendar filter must read the served flag');

  // Neither may fall back to a role, a manager flag or the old name — a page
  // that answers this itself is the second copy all over again.
  for (const [name, expr] of [['canPickProvider', pick[1]], ['allCalendars', all[1]]]) {
    assert.doesNotMatch(expr, /isAdmin|\.role|isManager|clinicalRole/,
      `${name} must not decide calendar scope from the user record`);
  }

  // And the filter actually renders behind it, in both directions: the
  // all-providers select, and the single-calendar chip for everyone else.
  assert.match(code, /\{allCalendars && \(\s*<select/, 'the all-providers select must render behind the flag');
  assert.match(code, /\{!allCalendars && providersData && \(/, 'the my-calendar chip must render behind the flag');
});

test('the booking form refuses to save with no provider, so a blank picker cannot book', () => {
  // The other half of why the missing picker was fatal rather than cosmetic:
  // an empty providerId is refused at the boundary, by name.
  const { buildAppointmentFields } = require('../clinicalRepository');
  const good = { providerId: '7', date: '2026-11-10', startTime: '09:00', durationMinutes: 30 };
  assert.equal(buildAppointmentFields(good, {}).error, undefined);
  for (const bad of ['', null, undefined, '   ', 'abc']) {
    const r = buildAppointmentFields({ ...good, providerId: bad }, {});
    assert.equal(r.code, 'APPT_NO_PROVIDER', `providerId ${JSON.stringify(bad)} must be refused`);
  }
});

test('a coordinator reaches the booking route: documenter gate plus the scheduling capability', () => {
  const clinicalRoles = require('../clinicalRoles');
  // Both halves the route gates on. Either one false and they cannot book.
  assert.equal(clinicalRoles.canDocumentClinically(COORDINATOR), true);
  assert.equal(clinicalRoles.can(COORDINATOR, clinicalRoles.CAPABILITIES.SCHEDULING), true);
  // Unchanged: scheduling is not a licence. They still cannot sign.
  assert.equal(clinicalRoles.canClinicalWrite(COORDINATOR), false);
  // And a read-only account still books nothing.
  const readOnly = { id: 'ro', role: 'user', clinicalRole: 'readOnly' };
  assert.equal(clinicalRoles.canDocumentClinically(readOnly), false);
  assert.equal(clinicalRoles.can(readOnly, clinicalRoles.CAPABILITIES.SCHEDULING), false);
});
