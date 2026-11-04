'use strict';
// Veterans for IME exams (owner, 2026-10-30): the roster rules and the sign-in
// match. A wrong match texts the wrong provider about the wrong person, so the
// matcher must never guess.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const v = require('../veteranRoster');

const TODAY = '2026-10-30';
const row = (o) => ({ id: o.id || 'r1', firstName: 'James', lastName: "O'Brien", dob: '1970-05-04', examDate: TODAY, site: v.DEFAULT_SITE, status: 'expected', providerUserId: 'p1', ...o });

test('exact name and DOB matches, case, accents and punctuation folded', () => {
  const m = v.matchCheckin([row({})], { firstName: 'james', lastName: 'OBRIEN', dob: '1970-05-04' }, TODAY);
  assert.strictEqual(m.state, 'matched');
  assert.strictEqual(m.row.id, 'r1');
});

test('a nickname matches on last name + DOB only when exactly one veteran fits', () => {
  assert.strictEqual(v.matchCheckin([row({})], { firstName: 'Jim', lastName: "O'Brien", dob: '1970-05-04' }, TODAY).state, 'matched');
  const two = [row({ id: 'a', firstName: 'James' }), row({ id: 'b', firstName: 'John' })];
  assert.strictEqual(v.matchCheckin(two, { firstName: 'Jim', lastName: "O'Brien", dob: '1970-05-04' }, TODAY).state, 'ambiguous');
});

test('an exact first name wins over a same-surname, same-DOB twin', () => {
  const two = [row({ id: 'a', firstName: 'James' }), row({ id: 'b', firstName: 'John' })];
  const m = v.matchCheckin(two, { firstName: 'John', lastName: "O'Brien", dob: '1970-05-04' }, TODAY);
  assert.strictEqual(m.state, 'matched');
  assert.strictEqual(m.row.id, 'b');
});

test('two identical veterans are ambiguous, never a guess', () => {
  const m = v.matchCheckin([row({ id: 'a' }), row({ id: 'b' })], { firstName: 'James', lastName: "O'Brien", dob: '1970-05-04' }, TODAY);
  assert.strictEqual(m.state, 'ambiguous');
  assert.strictEqual(m.row, null);
});

test('a different DOB, another day, a seen or removed veteran never match', () => {
  const who = { firstName: 'James', lastName: "O'Brien", dob: '1970-05-04' };
  assert.strictEqual(v.matchCheckin([row({ dob: '1970-05-05' })], who, TODAY).state, 'unmatched');
  assert.strictEqual(v.matchCheckin([row({ examDate: '2026-10-29' })], who, TODAY).state, 'unmatched');
  assert.strictEqual(v.matchCheckin([row({ status: 'seen' })], who, TODAY).state, 'unmatched');
  assert.strictEqual(v.matchCheckin([row({ status: 'no_show' })], who, TODAY).state, 'unmatched');
  assert.strictEqual(v.matchCheckin([row({ removedAt: '2026-10-30T10:00:00Z' })], who, TODAY).state, 'unmatched');
  assert.strictEqual(v.matchCheckin([row({})], { ...who, dob: '' }, TODAY).state, 'unmatched');
});

test('input validation: real dates, DOB in the past, required fields', () => {
  assert.ok(v.normalizeRosterInput({ firstName: 'A', lastName: 'B', dob: '1970-02-30', examDate: TODAY }, { today: TODAY }).fieldErrors.dob);
  assert.ok(v.normalizeRosterInput({ firstName: 'A', lastName: 'B', dob: TODAY, examDate: TODAY }, { today: TODAY }).fieldErrors.dob);
  assert.ok(v.normalizeRosterInput({ lastName: 'B', dob: '1970-01-01', examDate: TODAY }, { today: TODAY }).fieldErrors.firstName);
  assert.ok(v.normalizeRosterInput({ firstName: 'A', lastName: 'B', dob: '1970-01-01' }, { today: TODAY }).fieldErrors.examDate);
  const ok = v.normalizeRosterInput({ firstName: '  Ann  ', lastName: 'Lee', dob: '1970-01-01', examDate: TODAY }, { today: TODAY });
  assert.deepStrictEqual(ok.value, { firstName: 'Ann', lastName: 'Lee', dob: '1970-01-01', examDate: TODAY, site: 'savannah' });
});

test('a provider edits only their own rows; the office edits any', () => {
  const r = row({ providerUserId: 'p1' });
  assert.strictEqual(v.canEditRow({ id: 'p1', role: 'user' }, r, { isProvider: true }), true);
  assert.strictEqual(v.canEditRow({ id: 'p2', role: 'user' }, r, { isProvider: true }), false);
  assert.strictEqual(v.canEditRow({ id: 'p1', role: 'user' }, r, { isProvider: false }), false);
  assert.strictEqual(v.canEditRow({ id: 'x', role: 'admin' }, r), true);
  assert.strictEqual(v.canEditRow({ id: 'x', role: 'user', isManager: true }, r), true);
});

test('the provider text and email subject carry no veteran name', () => {
  assert.doesNotMatch(v.providerText('Savannah clinic'), /James|O'Brien/);
  assert.match(v.providerText('Savannah clinic'), /signed in at the Savannah clinic/);
  assert.doesNotMatch(v.providerEmailSubject('Savannah clinic'), /James|O'Brien/);
});

test('server: the provider email is marked PHI and its subject is the nameless one', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const a = src.indexOf('async function notifyProviderOfArrival');
  const block = src.slice(a, src.indexOf('function notifyOfficeOfUnmatched', a));
  assert.ok(a > 0, 'notifyProviderOfArrival not found');
  assert.match(block, /sendEmail\(provider\.email, vetRoster\.providerEmailSubject\(siteLabel\)/);
  assert.match(block, /\{ htmlBody, phi: true \}/);
  // An office notice: it goes out on the main line, not the Care Team line.
  assert.match(block, /sendText\(\{ to, content: vetRoster\.providerText\(siteLabel\), from: require\('\.\/quoSms'\)\.officeNumber\(\) \}\)/);
});

test('server: a provider can only add veterans to their own list', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /const providerUserId = vetRoster\.isOffice\(req\.user\) \? String\(\(req\.body \|\| \{\}\)\.providerUserId \|\| ''\) : req\.user\.id;/);
});

test('the veteran confirmation only says the provider was notified when one was', () => {
  assert.match(v.veteranText(true), /Your provider has been notified/);
  assert.doesNotMatch(v.veteranText(false), /provider/i);
  assert.match(v.veteranText(false), /will call you shortly/);
});

test('server: the veteran confirmation goes out on the office main line', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const a = src.indexOf('async function textVeteranConfirmation');
  const block = src.slice(a, src.indexOf("app.post('/api/veterans/check-in'", a));
  assert.ok(a > 0);
  assert.match(block, /sendText\(\{ to, content: vetRoster\.veteranText\(matched\), from: q\.officeNumber\(\) \}\)/);
  assert.match(src, /\n    textVeteranConfirmation\(row\.id, phone, m\.state === 'matched'\);/);
});

// ── the roster read is a WINDOW (owner, 2026-11-04) ─────────────────────────
// A single exam day is the degenerate case. These pin that the day screen's
// contract did not change when the forward schedule arrived, and that the
// provider scoping cannot be left out of a windowed read.
const T = require('../public/gfc-time');

test('no parameters still means today only — the exam-day screen is untouched', () => {
  assert.deepStrictEqual(v.rosterRange({}, TODAY), { from: TODAY, to: TODAY, capped: false });
  assert.deepStrictEqual(v.rosterRange({ date: '2026-11-10' }, TODAY), { from: '2026-11-10', to: '2026-11-10', capped: false });
});

test('a window returns its days oldest first, then surname — and the two can disagree', () => {
  const rows = [
    row({ id: 'early-z', lastName: 'Zane', examDate: '2026-11-05' }),
    row({ id: 'late-a', lastName: 'Adams', examDate: '2026-11-10' }),
    row({ id: 'early-b', lastName: 'Baker', examDate: '2026-11-05' })
  ];
  const r = v.rosterRange({ from: '2026-11-01', to: '2026-11-30' }, TODAY);
  // Date first: both Nov 5 rows precede the Nov 10 row even though Adams
  // sorts first by surname. A surname-only sort would read adams, baker, zane.
  assert.deepStrictEqual(v.rowsInRange(rows, r, {}).map(x => x.id), ['early-b', 'early-z', 'late-a']);
  // Outside the window is outside it, both ends.
  const narrow = v.rosterRange({ from: '2026-11-06', to: '2026-11-09' }, TODAY);
  assert.deepStrictEqual(v.rowsInRange(rows, narrow, {}).map(x => x.id), []);
});

test('both ends of the window are inside it', () => {
  const rows = [
    row({ id: 'on-from', lastName: 'Aaa', examDate: '2026-11-05' }),
    row({ id: 'middle', lastName: 'Bbb', examDate: '2026-11-07' }),
    row({ id: 'on-to', lastName: 'Ccc', examDate: '2026-11-09' }),
    row({ id: 'before', lastName: 'Ddd', examDate: '2026-11-04' }),
    row({ id: 'after', lastName: 'Eee', examDate: '2026-11-10' })
  ];
  const r = v.rosterRange({ from: '2026-11-05', to: '2026-11-09' }, TODAY);
  // A row ON each end must be included: exclusive ends would drop the first
  // and last exam day of every window somebody picks.
  assert.deepStrictEqual(v.rowsInRange(rows, r, {}).map(x => x.id), ['on-from', 'middle', 'on-to']);
  // A single-day window still returns that day.
  const oneDay = v.rosterRange({ date: '2026-11-07' }, TODAY);
  assert.deepStrictEqual(v.rowsInRange(rows, oneDay, {}).map(x => x.id), ['middle']);
});

test('an inverted window collapses to one day rather than silently swapping', () => {
  const r = v.rosterRange({ from: '2026-11-10', to: '2026-11-01' }, TODAY);
  assert.deepStrictEqual(r, { from: '2026-11-10', to: '2026-11-10', capped: false });
});

test('a window is capped and SAYS it was capped', () => {
  const r = v.rosterRange({ from: '2026-01-01', to: '2026-12-31' }, TODAY);
  assert.strictEqual(r.capped, true);
  assert.strictEqual(r.to, T.addDays('2026-01-01', v.RANGE_MAX_DAYS));
  // A window inside the cap is never reported as capped.
  assert.strictEqual(v.rosterRange({ from: '2026-01-01', to: '2026-02-01' }, TODAY).capped, false);
});

test('a provider sees only their own veterans in a window, and removed rows never appear', () => {
  const rows = [
    row({ id: 'mine', providerUserId: 'p1', examDate: '2026-11-05', lastName: 'Mine' }),
    row({ id: 'theirs', providerUserId: 'p2', examDate: '2026-11-05', lastName: 'Theirs' }),
    row({ id: 'gone', providerUserId: 'p1', examDate: '2026-11-05', lastName: 'Gone', removedAt: '2026-11-01T00:00:00Z' })
  ];
  const r = v.rosterRange({ from: '2026-11-01', to: '2026-11-30' }, TODAY);
  assert.deepStrictEqual(v.rowsInRange(rows, r, { providerUserId: 'p1' }).map(x => x.id), ['mine']);
  assert.deepStrictEqual(v.rowsInRange(rows, r, {}).map(x => x.id), ['mine', 'theirs']);
});

test('a window cannot be built out of a date that does not exist', () => {
  assert.strictEqual(T.addDays('2026-02-30', 1), '');
  assert.strictEqual(T.addDays('not-a-date', 1), '');
  assert.deepStrictEqual(v.rosterRange({ from: '2026-02-30' }, TODAY), { from: TODAY, to: TODAY, capped: false });
  // No window at all yields no rows rather than every row.
  assert.deepStrictEqual(v.rowsInRange([row({})], { from: '', to: '' }, {}), []);
});

test('addDays lives in the shared clock, and the roster does not keep a second copy', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'veteranRoster.js'), 'utf8');
  assert.ok(/require\('\.\/public\/gfc-time'\)/.test(src), 'the roster must use the shared clock');
  assert.ok(!/^function addDays/m.test(src), 'a second addDays in the roster is the drift this consolidated');
  assert.strictEqual(typeof T.addDays, 'function');
});

test('server: the windowed read goes through rowsInRange, so the provider scoping cannot be dropped', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const i = src.indexOf("app.get('/api/veterans/roster'");
  assert.ok(i > 0, 'roster route not found');
  const route = src.slice(i, i + 1600);
  assert.ok(/vetRoster\.rowsInRange\(/.test(route), 'the route must delegate the filter');
  assert.ok(/providerUserId: office \? null : req\.user\.id/.test(route), 'the scoping must travel with the filter');
  // The old inline filter must not come back beside the shared one.
  assert.ok(!/r\.examDate === date/.test(route), 'the inline date filter was replaced, not duplicated');
});

// ── My Day: the IME exams beside the clinical day (owner, 2026-11-04) ───────
// Option B — the exam line is billed to the contracting vendor, so it keeps its
// own record and this is a join at the READ layer only.
const myDay = require('../myDay');

test('one window filter answers several provider ids, which is what My Day needs', () => {
  const rows = [row({ id: 'a', providerUserId: 'p1' }), row({ id: 'b', providerUserId: 'p2' }),
    row({ id: 'c', providerUserId: 'p3' })];
  const r = { from: TODAY, to: TODAY };
  assert.deepStrictEqual(v.rowsInRange(rows, r, { providerUserIds: ['p1', 'p3'] }).map(x => x.id), ['a', 'c']);
  // A single id and a set of ids must agree, or the two scopings drift.
  assert.deepStrictEqual(v.rowsInRange(rows, r, { providerUserId: 'p2' }).map(x => x.id),
    v.rowsInRange(rows, r, { providerUserIds: ['p2'] }).map(x => x.id));
  // Numbers and strings are the same id, BOTH WAYS — user ids arrive as both.
  // A string-only fixture here proves nothing: the row id is folded with
  // String() on the way in, so two strings match whether or not the scope was
  // folded too. The mismatched pairs are what the folding actually buys.
  assert.strictEqual(v.rowsInRange([row({ id: 'n', providerUserId: '7' })], r, { providerUserIds: [7] }).length, 1,
    'a numeric id in the scope must match a string id on the row');
  assert.strictEqual(v.rowsInRange([row({ id: 'n', providerUserId: 7 })], r, { providerUserIds: ['7'] }).length, 1,
    'and the other way round');
});

test('an EMPTY provider scope means nobody, never the whole roster', () => {
  const rows = [row({ id: 'a', providerUserId: 'p1' }), row({ id: 'b', providerUserId: 'p2' })];
  const r = { from: TODAY, to: TODAY };
  assert.deepStrictEqual(v.rowsInRange(rows, r, { providerUserIds: [] }), []);
  // And no scope at all is still everybody — the office view.
  assert.strictEqual(v.rowsInRange(rows, r, {}).length, 2);
  assert.strictEqual(v.rowsInRange(rows, r, { providerUserIds: null }).length, 2);
});

test("My Day's exam row carries no DOB and no arrival contact details", () => {
  const r = v.examDayRow(row({
    id: 'x', status: 'arrived', arrivedAt: '2026-10-30T14:00:00Z', seenAt: null,
    checkinId: 'c1', arrivalPhone: '+15555550123', arrivalEmail: 'vet@example.com'
  }), 'Dr Example');
  assert.strictEqual(r.lastName, "O'Brien");
  assert.strictEqual(r.providerName, 'Dr Example');
  assert.strictEqual(r.statusLabel, 'Arrived');
  assert.strictEqual(r.siteLabel, 'Savannah clinic');
  for (const k of ['dob', 'checkinId', 'arrivalPhone', 'arrivalEmail']) {
    assert.ok(!(k in r), `${k} must not reach My Day — it is sign-in data, not day data`);
  }
  // Proven against the roster board's own projection, which DOES carry them:
  // if publicRow ever stopped carrying dob this test would otherwise be vacuous.
  assert.ok('dob' in v.publicRow(row({}), null), 'the roster board still needs the DOB');
});

test('exams are grouped by site and counted by status, with no time invented', () => {
  const e = (o) => v.examDayRow(row(o), null);
  const d = myDay.imeDay([
    e({ id: '1', status: 'expected' }), e({ id: '2', status: 'arrived' }),
    e({ id: '3', status: 'seen' }), e({ id: '4', status: 'no_show', site: 'atlanta' })
  ]);
  assert.deepStrictEqual(d.totals, { exams: 4, expected: 1, arrived: 1, seen: 1, noShow: 1 });
  // TWO sites in the fixture on purpose: with every exam at one site, grouping
  // and one flat list are indistinguishable and the assertion proves nothing.
  assert.deepStrictEqual(d.sites.map(g => [g.site, g.exams.length]), [['savannah', 3], ['atlanta', 1]]);
  assert.strictEqual(d.sites[0].siteLabel, 'Savannah clinic');
  // A site the catalog does not name falls back to its own key rather than
  // rendering as blank.
  assert.strictEqual(d.sites[1].siteLabel, 'atlanta');
  // A roster row has no time of day, so nothing here may claim one.
  assert.ok(d.exams.every(x => !('time' in x) && !('startTime' in x)));
  assert.deepStrictEqual(myDay.imeDay([]).totals.exams, 0);
  assert.deepStrictEqual(myDay.imeDay(undefined).exams, []);
});

test('an exam never reaches a clinical figure: not the totals, the plot or the route', () => {
  const day = myDay.buildMyDay({
    date: TODAY, appointments: [], clientsById: new Map(), timingsByEid: new Map(),
    signedEids: new Set(), unsignedEarlier: [], openTasks: 0, blocks: [],
    homeVisitFields: [], imeExams: [v.examDayRow(row({ id: '1' }), null), v.examDayRow(row({ id: '2' }), null)]
  });
  assert.strictEqual(day.ime.totals.exams, 2);
  // The clinical day is untouched: two exams are not two visits, and they are
  // not two stops without coordinates either — that would make an accurate
  // mileage total report itself as partial.
  assert.strictEqual(day.totals.visits, 0);
  assert.strictEqual(day.totals.unplaceableStops, 0);
  assert.strictEqual(day.totals.milesPartial, false);
  assert.strictEqual(day.visits.length, 0);
  assert.ok(!Object.keys(day.totals).some(k => /exam|ime|veteran/i.test(k)),
    'an exam count in the clinical totals is how the two lines start being added together');
  // The plot and the route proposal are built from `visits`, so neither can
  // see an exam. Driving to somebody with no address is the failure.
  assert.deepStrictEqual(myDay.plotStops({ stops: day.visits }).points, []);
  assert.strictEqual(myDay.proposeRouteOrder({ visits: day.visits }).proposal, null);
});

test('server: My Day scopes exams by the ROSTER\'s own rule, not a second copy', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const i = src.indexOf("app.get('/api/clinical/my-day'");
  assert.ok(i > 0, 'my-day route not found');
  const route = src.slice(i, src.indexOf("app.post('/api/clinical/visits/:eid/timing'", i));
  assert.ok(route.length > 500 && route.length < 20000, 'route slice looks wrong');
  assert.ok(/vetRoster\.rowsInRange\(/.test(route), 'the exam read must go through the shared filter');
  assert.ok(/vetRoster\.isOffice\(req\.user\)/.test(route), 'who may see which veteran is the roster module\'s answer');
  assert.ok(/vetRoster\.examDayRow\(/.test(route), 'My Day must use the narrow projection, not publicRow');
  assert.ok(!/publicRow/.test(route), 'publicRow carries the DOB and must not be used here');
  // Display only: My Day may not write a roster row.
  assert.ok(!/db\.set\('veteran_roster'/.test(route), 'My Day is a read of the exam line, never a writer');
});

test('page: the IME block is read-only and the empty-day sentence narrows', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'clinical.html'), 'utf8');
  const i = src.indexOf('const ImeExamBlock');
  assert.ok(i > 0, 'ImeExamBlock not found');
  assert.ok(/^    const ImeExamBlock/m.test(src), 'must sit at module scope (react_input_focus)');
  const comp = src.slice(i, src.indexOf('const DayScheduleRow', i));
  // Status is marked on the Veterans board and nowhere else, or this screen
  // becomes a second writer of it.
  assert.ok(!/veterans\/roster/.test(comp), 'the block must not call a roster route');
  assert.ok(!/method: 'POST'/.test(comp), 'the block must not write');
  assert.ok(/onOpen/.test(comp), 'it links to the board, which is where status is marked');
  // "No visits scheduled" is false on a day that carries exams.
  assert.ok(/No clinical visits scheduled for this day/.test(src),
    'the empty-day sentence must narrow when exams are on the day');
  assert.ok(/ImeExamBlock ime=\{day\.ime\}/.test(src), 'the block must be rendered from the served day');
});
