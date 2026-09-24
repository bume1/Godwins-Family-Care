// ============================================================
// NCCI/MUE sign-time bundling gate.
//
// A claim naming two codes CMS's Procedure-to-Procedure edits forbid
// together, or billing a code past its Medically Unlikely Edit unit cap, was
// signable with nothing catching it — the denial arrives weeks later. This
// pins checkNcciBundling (clinicalRepository.js) and its wiring into
// checkSignReadiness, the one hard gate the /sign route already treats a
// non-ok result from as a 409.
//
// Written the way checkSignReadiness's caller (the /sign route) actually
// calls it: services come out of applyCoding, which is what the route calls,
// not a hand-built shape that could drift from what the app really stores
// (the exact class of bug the modifier/dxLinks key-mismatch was).
// Run: npm test
// ============================================================
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const R = require('../clinicalRepository');

const FNP = { id: 'u-fnp', name: 'Bethel Godwins', licenseLevel: 'FNP-C', npi: '1234567893' };
const BILLING_NPI = '1999999992';
const VISIT = { appointmentType: 'pc_follow_up', modality: 'in_person', location: 'home' };
const TELE_VISIT = { appointmentType: 'pc_follow_up', modality: 'telehealth', location: 'home' };
const POS = '12';

// A fresh, non-stale sourceVersion — the happy-path default for tests that
// are not themselves about staleness.
const FRESH = () => ({
  ptp: { quarter: '2026Q3', loadedAt: new Date().toISOString() },
  mue: { quarter: '2026Q3', loadedAt: new Date().toISOString() }
});
const STALE_UNLOADED = { ptp: { quarter: 'UNLOADED', loadedAt: null }, mue: { quarter: 'UNLOADED', loadedAt: null } };

// Services out of applyCoding — the same function the coding route calls —
// so this fixture cannot drift from the shape the app actually stores.
const coded = (services, diagnoses = [{ code: 'E11.9', description: 'T2DM', primary: true }]) => R.applyCoding(
  { clientId: 'c', encounterUuid: 'e', diagnoses: [], services: [] },
  { diagnoses, services },
  FNP, BILLING_NPI
).record;

const readyArgs = (record, overrides = {}) => ({
  hasNote: true, record, billingNpi: BILLING_NPI, posCode: POS, visit: VISIT,
  completedSections: R.requiredSectionsForVisit(VISIT),
  ncciPtpEdits: [], ncciMue: {}, ncciSourceVersion: FRESH(),
  ...overrides
});

// ---- D2.1 — indicator 0: never billable together ----
test('a PTP indicator-0 pair blocks signing and names both codes', () => {
  const rec = coded([
    { code: '99213', units: 1, dxLinks: ['E11.9'] },
    { code: '36415', units: 1, dxLinks: ['E11.9'] }
  ]);
  const ready = R.checkSignReadiness(readyArgs(rec, {
    ncciPtpEdits: [{ column1Code: '99213', column2Code: '36415', modifierIndicator: 0 }]
  }));
  assert.equal(ready.ok, false);
  assert.ok(ready.codes.includes('NCCI_PTP_BLOCKED'));
  assert.match(ready.message, /99213/);
  assert.match(ready.message, /36415/);
});

// ---- D2.2 — indicator 1, no modifier present: blocked ----
test('a PTP indicator-1 pair with no unbundling modifier blocks signing', () => {
  const rec = coded([
    { code: '99213', units: 1, dxLinks: ['E11.9'] },
    { code: '36415', units: 1, dxLinks: ['E11.9'] }
  ]);
  const ready = R.checkSignReadiness(readyArgs(rec, {
    ncciPtpEdits: [{ column1Code: '99213', column2Code: '36415', modifierIndicator: 1 }]
  }));
  assert.equal(ready.ok, false);
  assert.ok(ready.codes.includes('NCCI_PTP_MODIFIER_REQUIRED'));
  assert.match(ready.message, /99213/);
  assert.match(ready.message, /36415/);
});

// ---- D2.3 — the same pair, modifier 25 present: allowed, but flagged ----
test('the same indicator-1 pair with modifier 25 on one line signs, and warns rather than passing silently', () => {
  const rec = coded([
    { code: '99213', units: 1, dxLinks: ['E11.9'], modifiers: ['25'] },
    { code: '36415', units: 1, dxLinks: ['E11.9'] }
  ]);
  const ready = R.checkSignReadiness(readyArgs(rec, {
    ncciPtpEdits: [{ column1Code: '99213', column2Code: '36415', modifierIndicator: 1 }]
  }));
  assert.equal(ready.ok, true);
  assert.ok(ready.warnings.length >= 1, 'a resolved-but-flagged pair must not pass silently');
  assert.match(ready.warnings[0], /99213/);
  assert.match(ready.warnings[0], /36415/);
});

// ---- D2.4 — telehealth's auto-derived 95, never typed, must still resolve ----
// THIS is the case that proves the check reads modifiersForCharge's RESOLVED
// output, not svc.modifiers directly: no modifier is typed on either line, so
// only a real call to modifiersForCharge (which derives 95 from the visit's
// modality) can find anything here at all.
test('a telehealth visit resolves its auto-derived 95 as the unbundling modifier, never typed', () => {
  const rec = coded([
    { code: '99213', units: 1, dxLinks: ['E11.9'] }, // no modifiers typed by the clinician
    { code: '36415', units: 1, dxLinks: ['E11.9'] }
  ]);
  assert.deepEqual(rec.services[0].modifiers, [], 'precondition: nothing was typed');
  const ready = R.checkSignReadiness(readyArgs(rec, {
    // Telehealth bills at POS 10, never 12 — a different POS is what a
    // telehealth visit actually resolves to (see checkVisitAgainstPos); this
    // test is about the NCCI modifier resolution, not the POS check, so it
    // must use the POS that visit is actually allowed to carry.
    posCode: '10', visit: TELE_VISIT, completedSections: R.requiredSectionsForVisit(TELE_VISIT),
    ncciPtpEdits: [{ column1Code: '99213', column2Code: '36415', modifierIndicator: 1 }]
  }));
  assert.equal(ready.ok, true, ready.message);
  assert.ok(ready.warnings.length >= 1);
  // And the SAME pair, in person (no 95 derived, nothing typed), is blocked —
  // proving 95 is genuinely doing the work, not some other precondition.
  const inPerson = R.checkSignReadiness(readyArgs(rec, {
    ncciPtpEdits: [{ column1Code: '99213', column2Code: '36415', modifierIndicator: 1 }]
  }));
  assert.equal(inPerson.ok, false);
});

// ---- D2.5 — MUE cap exceeded ----
test('a code billed past its MUE cap blocks signing and states the code, units and cap', () => {
  const rec = coded([{ code: '99213', units: 3, dxLinks: ['E11.9'] }]);
  const ready = R.checkSignReadiness(readyArgs(rec, {
    ncciMue: { '99213': { mueValue: 1, mai: '3' } }
  }));
  assert.equal(ready.ok, false);
  assert.ok(ready.codes.includes('MUE_EXCEEDED'));
  assert.match(ready.message, /99213/);
  assert.match(ready.message, /3 units/);
  assert.match(ready.message, /1-unit/);
});
test('units under the cap sign cleanly, and units repeated across two lines of the SAME code sum', () => {
  const single = coded([{ code: '99213', units: 1, dxLinks: ['E11.9'] }]);
  assert.equal(R.checkSignReadiness(readyArgs(single, { ncciMue: { 99213: { mueValue: 1, mai: '3' } } })).ok, true);
  // Two lines of the same code are a units question, never a PTP pairing —
  // the loop must skip a=b and MUE must still see the combined total.
  const twoLines = coded([
    { code: '99213', units: 1, dxLinks: ['E11.9'] },
    { code: '99213', units: 1, dxLinks: ['E11.9'] }
  ]);
  const blocked = R.checkSignReadiness(readyArgs(twoLines, { ncciMue: { 99213: { mueValue: 1, mai: '3' } } }));
  assert.equal(blocked.ok, false);
  assert.ok(blocked.codes.includes('MUE_EXCEEDED'));
  assert.ok(!blocked.codes.includes('NCCI_PTP_BLOCKED'), 'identical codes on two lines are not a PTP pair');
});

// ---- D2.6 — unloaded/stale reference data blocks regardless of the codes ----
test('UNLOADED reference data blocks signing regardless of what the codes themselves would allow', () => {
  const rec = coded([{ code: '99213', units: 1, dxLinks: ['E11.9'] }]); // nothing wrong with this on its own
  const ready = R.checkSignReadiness(readyArgs(rec, { ncciSourceVersion: STALE_UNLOADED }));
  assert.equal(ready.ok, false);
  assert.ok(ready.codes.includes('NCCI_DATA_STALE'));
});
test('reference data loaded long ago (over the 100-day limit) blocks the same way', () => {
  const rec = coded([{ code: '99213', units: 1, dxLinks: ['E11.9'] }]);
  const old = new Date(Date.now() - 101 * 86400000).toISOString();
  const ready = R.checkSignReadiness(readyArgs(rec, {
    ncciSourceVersion: { ptp: { quarter: '2026Q1', loadedAt: old }, mue: { quarter: '2026Q3', loadedAt: new Date().toISOString() } }
  }));
  assert.equal(ready.ok, false);
  assert.ok(ready.codes.includes('NCCI_DATA_STALE'));
  assert.match(ready.message, /PTP/);
});
test('reference data loaded within the limit does not block', () => {
  const rec = coded([{ code: '99213', units: 1, dxLinks: ['E11.9'] }]);
  const recent = new Date(Date.now() - 99 * 86400000).toISOString();
  const ready = R.checkSignReadiness(readyArgs(rec, {
    ncciSourceVersion: { ptp: { quarter: '2026Q3', loadedAt: recent }, mue: { quarter: '2026Q3', loadedAt: recent } }
  }));
  assert.equal(ready.ok, true);
});

// ---- D2.7 — zero services: unaffected, whatever the reference data says ----
test('an encounter with zero services is not touched by the NCCI check at all', () => {
  assert.deepEqual(R.checkNcciBundling([], VISIT, { ptpEdits: [], mueByCode: {}, sourceVersion: STALE_UNLOADED }), {
    ok: true, message: null, codes: [], missing: [], warnings: []
  });
  assert.deepEqual(R.checkNcciBundling(null, VISIT, { ptpEdits: [], mueByCode: {}, sourceVersion: STALE_UNLOADED }).ok, true);
});

// ---- backward compatibility: every pre-existing call in this repo's own
// test suite never mentions ncci at all, and must keep behaving exactly as
// it did before this feature existed. ----
test('a caller that never mentions ncci gets no bundling check — old callers are unaffected', () => {
  const rec = coded([
    { code: '99213', units: 1, dxLinks: ['E11.9'] },
    { code: '36415', units: 1, dxLinks: ['E11.9'] }
  ]);
  // No ncciPtpEdits/ncciMue/ncciSourceVersion key at all — the shape every
  // pre-existing checkSignReadiness call in this repo uses.
  const ready = R.checkSignReadiness({
    hasNote: true, record: rec, billingNpi: BILLING_NPI, posCode: POS, visit: VISIT,
    completedSections: R.requiredSectionsForVisit(VISIT)
  });
  assert.equal(ready.ok, true);
  assert.deepEqual(ready.warnings, []);
  // Direct check: even data that would otherwise BLOCK is inert without the
  // caller asking.
  assert.equal(R.checkNcciBundling(rec.services, VISIT, undefined).ok, true);
});

// ---- checkNcciBundling reuses modifiersForCharge, never svc.modifiers raw ----
// Structural guard for the exact regression class this repo keeps meeting
// (svc.modifier vs modifiers, svc.linkedDiagnoses vs dxLinks, 2026-09-23).
test('build-enforced: the bundling check resolves modifiers through modifiersForCharge, never svc.modifiers directly', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'clinicalRepository.js'), 'utf8');
  const from = src.indexOf('const NCCI_STALE_DAYS');
  const to = src.indexOf('// The app\'s order lifecycle is ordered');
  assert.ok(from > 0 && to > from, 'both anchors must still be present and in order');
  const fn = src.slice(from, to);
  assert.ok(fn.includes('const checkNcciBundling'), 'the slice must cover the check itself');
  assert.match(fn, /modifiersForCharge\(svc, visit\)/, 'must resolve through modifiersForCharge');
  assert.doesNotMatch(fn, /svc\.modifiers\b/, 'must never read svc.modifiers directly — only the resolved output');
});

// ---- build-enforced: the gate is actually reached from both server.js call
// sites, the same shape this repo already uses for the risk-assessment gate
// (2026-09-23's own lesson: a correct, unreached check catches nothing). ----
test('build-enforced: both checkSignReadiness call sites in server.js hand over the NCCI reference data', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const calls = server.match(/checkSignReadiness\(\{[\s\S]{0,500}?\}\)/g) || [];
  assert.ok(calls.length >= 2, 'expected the sign route and the readiness preview');
  for (const c of calls) {
    assert.match(c, /ncciPtpEdits:/, `every sign-readiness call must pass the PTP table: ${c.slice(0, 90)}…`);
    assert.match(c, /ncciMue:/, 'and the MUE table');
    assert.match(c, /ncciSourceVersion:/, 'and the source version the staleness guard reads');
  }
  // And it must be loaded FRESH per request, from the store — not cached at
  // boot, or a reload (scripts/load_ncci_tables.js) would need a restart to
  // take effect.
  const getterCalls = server.match(/getNcciTables\(\)/g) || [];
  assert.ok(getterCalls.length >= 2, 'both call sites must fetch the NCCI tables themselves');
  assert.match(server, /db\.get\('gfc_ncci_source_version'\)/);
});

// ---- warnings reach the /sign route's response, not only the readiness
// preview — C2's requirement that a flagged-but-allowed pair is visible at
// the moment of signing, not just discoverable beforehand. ----
test('build-enforced: the /sign route threads NCCI warnings into its own response', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const from = server.indexOf("app.post('/api/clinical/patients/:clientId/encounters/:euuid/sign'");
  const to = server.indexOf("app.post('/api/clinical/patients/:clientId/encounters/:euuid/co-sign'");
  assert.ok(from > 0 && to > from, 'both anchors must still be present and in order');
  const route = server.slice(from, to);
  assert.match(route, /ready\.warnings/, 'the sign route must read the readiness check\'s own warnings');
});

// ---- checkNcciBundling's own return shape (B5) ----
test('checkNcciBundling returns the documented shape on both outcomes', () => {
  const ok = R.checkNcciBundling([{ code: '99213', units: 1 }], VISIT, { ptpEdits: [], mueByCode: {}, sourceVersion: FRESH() });
  assert.deepEqual(Object.keys(ok).sort(), ['codes', 'message', 'missing', 'ok', 'warnings'].sort());
  assert.equal(ok.ok, true);
  const blocked = R.checkNcciBundling(
    [{ code: '99213', units: 1 }, { code: '36415', units: 1 }], VISIT,
    { ptpEdits: [{ column1Code: '99213', column2Code: '36415', modifierIndicator: 0 }], mueByCode: {}, sourceVersion: FRESH() }
  );
  assert.equal(blocked.ok, false);
  assert.deepEqual(blocked.missing, ['ncci_bundling']);
});

// ---- indicator 9 is explicitly "not applicable" — never a match ----
test('a modifier indicator of 9 is treated as no match at all', () => {
  const rec = coded([
    { code: '99213', units: 1, dxLinks: ['E11.9'] },
    { code: '36415', units: 1, dxLinks: ['E11.9'] }
  ]);
  const ready = R.checkSignReadiness(readyArgs(rec, {
    ncciPtpEdits: [{ column1Code: '99213', column2Code: '36415', modifierIndicator: 9 }]
  }));
  assert.equal(ready.ok, true);
  assert.deepEqual(ready.warnings, []);
});

// ---- the file is directional, but a pair may appear in either order in the
// edits table relative to which service line comes first on the encounter ----
test('a PTP edit is found whichever service line lists it first', () => {
  const edit = [{ column1Code: '36415', column2Code: '99213', modifierIndicator: 0 }];
  const forward = coded([{ code: '99213', units: 1, dxLinks: ['E11.9'] }, { code: '36415', units: 1, dxLinks: ['E11.9'] }]);
  const backward = coded([{ code: '36415', units: 1, dxLinks: ['E11.9'] }, { code: '99213', units: 1, dxLinks: ['E11.9'] }]);
  assert.equal(R.checkSignReadiness(readyArgs(forward, { ncciPtpEdits: edit })).ok, false);
  assert.equal(R.checkSignReadiness(readyArgs(backward, { ncciPtpEdits: edit })).ok, false);
});

// ============================================================
// ncciRefreshReminder — the admin/manager dashboard nudge (2026-09-24).
//
// Distinct from ncciStaleness (the hard sign-time block at 100 days): this is
// the proactive reminder that fires well before that, on the same stored
// data, with no separate "dismissed" state — until there is a real billing
// backend, this banner IS the process for keeping the quarterly CMS tables
// current.
// ============================================================
test('never-loaded reference data is due starting from day one — "starting from today"', () => {
  const r = R.ncciRefreshReminder({ ptp: { quarter: 'UNLOADED', loadedAt: null }, mue: { quarter: 'UNLOADED', loadedAt: null } });
  assert.equal(r.due, true);
  assert.equal(r.items.length, 2, 'both halves are unloaded, both must be named');
  assert.ok(r.items.every(i => i.neverLoaded === true));
  assert.match(r.message, /PTP edits.*never been loaded/);
  assert.match(r.message, /MUE table.*never been loaded/);
  assert.match(r.message, /load_ncci_tables\.js/);
});

test('freshly loaded reference data is not due', () => {
  const now = new Date();
  const r = R.ncciRefreshReminder({
    ptp: { quarter: '2026Q3', loadedAt: now.toISOString() },
    mue: { quarter: '2026Q3', loadedAt: now.toISOString() }
  }, now);
  assert.deepEqual(r, { due: false, items: [], message: null });
});

test('data loaded just under the reminder threshold is not yet due; just at it, is', () => {
  const now = new Date('2026-09-24T12:00:00Z');
  const justUnder = new Date(now.getTime() - (R.NCCI_REFRESH_REMINDER_DAYS - 1) * 86400000).toISOString();
  const notDue = R.ncciRefreshReminder({ ptp: { quarter: '2026Q2', loadedAt: justUnder }, mue: { quarter: '2026Q2', loadedAt: justUnder } }, now);
  assert.equal(notDue.due, false);

  const atThreshold = new Date(now.getTime() - R.NCCI_REFRESH_REMINDER_DAYS * 86400000).toISOString();
  const due = R.ncciRefreshReminder({ ptp: { quarter: '2026Q2', loadedAt: atThreshold }, mue: { quarter: '2026Q2', loadedAt: atThreshold } }, now);
  assert.equal(due.due, true);
  assert.equal(due.items.length, 2);
  assert.match(due.message, /2026Q2.*was loaded 80 day\(s\) ago/);
});

test('the reminder is well ahead of the hard sign-time block, not the same threshold', () => {
  assert.ok(R.NCCI_REFRESH_REMINDER_DAYS < R.NCCI_STALE_DAYS,
    'the nudge must fire before the hard block, giving admin/manager time to act before a clinician is refused at sign time');
});

test('one stale half and one fresh half reports only the stale one, by name', () => {
  const now = new Date();
  const old = new Date(now.getTime() - 90 * 86400000).toISOString();
  const r = R.ncciRefreshReminder({
    ptp: { quarter: '2026Q2', loadedAt: old },
    mue: { quarter: '2026Q3', loadedAt: now.toISOString() }
  }, now);
  assert.equal(r.due, true);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].label, 'PTP edits');
  assert.match(r.message, /PTP edits/);
  assert.doesNotMatch(r.message, /MUE table/);
});

test('build-enforced: the admin-hub dashboard route computes the reminder from the same stored source version the sign gate reads, and never a second, drifting copy', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const from = server.indexOf("app.get('/api/admin-hub/dashboard'");
  const to = server.indexOf('\n});', from);
  assert.ok(from > 0 && to > from, 'the dashboard route must still exist');
  const route = server.slice(from, to);
  assert.match(route, /getNcciTables\(\)/, 'must reuse the one function that reads gfc_ncci_source_version, never re-fetch it directly');
  assert.match(route, /clinicalRepo\.ncciRefreshReminder\(/, 'must call the pure reminder function, not restate its logic inline');
  assert.doesNotMatch(route, /db\.get\('gfc_ncci_source_version'\)/, 'the route itself must not read the collection a second, independent way');
  // Not just "the string appears somewhere in the route" — it must actually
  // sit inside the `stats` object literal that gets sent back, or computing
  // it is dead work nobody ever sees.
  const statsFrom = route.indexOf('const stats = {');
  const statsTo = route.indexOf('};', statsFrom);
  assert.ok(statsFrom > 0 && statsTo > statsFrom, 'the stats object literal must still exist');
  assert.match(route.slice(statsFrom, statsTo), /billingDataRefresh/, 'the computed reminder must actually be a key on the response payload, not just computed and discarded');
});

test('build-enforced: the dashboard route is reachable by both admin and manager, matching "admin and manager inbox"', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const line = server.split('\n').find(l => l.includes("app.get('/api/admin-hub/dashboard'"));
  assert.ok(line, 'the dashboard route declaration must exist on one line');
  assert.match(line, /requireAdminHubAccess/, 'must use the gate that already admits admin, manager and hasAdminHubAccess — never a narrower admin-only gate');
});
