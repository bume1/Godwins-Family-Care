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
  assert.deepStrictEqual(ok.value, { firstName: 'Ann', lastName: 'Lee', dob: '1970-01-01', examDate: TODAY, site: 'savannah', examTime: null, durationMinutes: null });
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

test('exams are counted by status and keep the roster\'s own order', () => {
  const e = (o) => v.examDayRow(row(o), null);
  const d = myDay.imeDay([
    e({ id: '1', status: 'expected', examTime: '09:00' }), e({ id: '2', status: 'arrived' }),
    e({ id: '3', status: 'seen' }), e({ id: '4', status: 'no_show', site: 'atlanta' })
  ]);
  assert.deepStrictEqual(d.totals, { exams: 4, expected: 1, arrived: 1, seen: 1, noShow: 1 });
  // The roster already sorts by day, then time, then site, then surname. A
  // second sort here is how the day and the board start disagreeing.
  assert.deepStrictEqual(d.exams.map(x => x.id), ['1', '2', '3', '4']);
  assert.strictEqual(d.exams[0].siteLabel, 'Savannah clinic');
  // A site the catalog does not name falls back to its own key, never blank.
  assert.strictEqual(d.exams[3].siteLabel, 'atlanta');
  assert.deepStrictEqual(myDay.imeDay([]).totals.exams, 0);
  assert.deepStrictEqual(myDay.imeDay(undefined).exams, []);
});

test('the day reads in one order over both lines, as POINTERS not copies', () => {
  const a = myDay.buildAgenda({
    visits: [{ eid: 'v-am', time: '09:00' }, { eid: 'v-pm', time: '14:00' }, { eid: 'v-none', time: null }],
    exams: [{ id: 'e-mid', examTime: '11:00' }, { id: 'e-none', examTime: null }, { id: 'e-am', examTime: '09:00' }]
  });
  assert.deepStrictEqual(a.map(x => `${x.kind}:${x.id}`),
    ['visit:v-am', 'ime:e-am', 'ime:e-mid', 'visit:v-pm', 'visit:v-none', 'ime:e-none']);
  // ⚠️ UNTIMED SORTS LAST. The first draft used a '~' sentinel with
  // localeCompare and put every untimed row at the HEAD of the day, because
  // ICU collation sorts punctuation before digits. Caught by running it.
  assert.deepStrictEqual(a.slice(-2).map(x => x.id), ['v-none', 'e-none']);
  // Pointers only: the rows live in `visits` and `ime.exams`, so there is one
  // copy of each and the order cannot drift from what it orders.
  assert.deepStrictEqual([...new Set(a.flatMap(Object.keys))], ['kind', 'id', 'time']);
  assert.deepStrictEqual(myDay.buildAgenda({}), []);
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

test('page: the exam rows are read-only and the empty-day sentence narrows', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'clinical.html'), 'utf8');
  const i = src.indexOf('const ImeExamRow');
  assert.ok(i > 0, 'ImeExamRow not found');
  assert.ok(/^    const ImeExamRow/m.test(src), 'must sit at module scope (react_input_focus)');
  const comp = src.slice(i, src.indexOf('const DayScheduleRow', i));
  // Status is marked on the Veterans board and nowhere else, or this screen
  // becomes a second writer of it.
  assert.ok(!/veterans\/roster/.test(comp), 'the row must not call a roster route');
  assert.ok(!/method: 'POST'/.test(comp), 'the row must not write');
  assert.ok(/Open Board/.test(src), 'it links to the board, which is where status is marked');
  // "No visits scheduled" is false on a day that carries exams.
  assert.ok(/No clinical visits scheduled for this day/.test(src),
    'the empty-day sentence must narrow when exams are on the day');
  // THE PAGE SORTS NOTHING. One ordering, computed on the server, or the day
  // and the board disagree about what comes first.
  assert.ok(/agenda\.map\(a =>/.test(src), 'the day must render from the served agenda');
  const view = src.slice(src.indexOf('const MyDayView'), src.indexOf('const VisitDetails'));
  assert.ok(!/\.sort\(/.test(view), 'My Day must not re-sort the day it was served');
  // ONE slot formatter for both screens: a 24-hour time on one and a 12-hour
  // on the other is how somebody turns up an hour out.
  assert.strictEqual((src.match(/const fmtSlot = /g) || []).length, 1, 'exactly one slot formatter');
  assert.ok(/^    const fmtSlot = /m.test(src), 'and it sits at module scope');
  // AND BOTH SCREENS ACTUALLY CALL IT. Asserting the formatter exists proves
  // nothing about the rows: a row rendering the stored `examTime` straight
  // shows a clinician "14:00" on a screen where every other time reads "2:00
  // PM", which is how somebody turns up an hour out. A mutation that swapped
  // the call for the raw value survived until this line existed.
  assert.ok(/fmtSlot\(e\.examTime, e\.durationMinutes\)/.test(comp),
    'the My Day exam row must render through the shared formatter');
  const board = src.slice(src.indexOf('const VeteransView'), src.indexOf('const OverdueOrders'));
  assert.ok(/fmtSlot\(r\.examTime, r\.durationMinutes\)/.test(board),
    'the Veterans board must render through the same formatter');
  assert.ok(/No set time/.test(comp) && /No set time/.test(board),
    'an exam with no slot says so on both screens rather than showing a blank');
});

// ── A time slot on an exam (owner, 2026-11-04) ─────────────────────────────

test('⚠️ a time NEVER narrows the sign-in match: early, late and wrong-hour all match', () => {
  // The owner's own concern, 2026-11-04, and the thing most likely to break:
  // a veteran who turns up at 08:40 for a 09:00 exam is the person we are
  // expecting. Matching on the slot would read as "we don't have you down", at
  // an iPad, with nobody standing there to ask.
  const booked = row({ id: 't1', firstName: 'Ann', lastName: 'Lee', dob: '1970-01-01', examTime: '09:00', durationMinutes: 60 });
  const checkin = { firstName: 'Ann', lastName: 'Lee', dob: '1970-01-01' };
  assert.strictEqual(v.matchCheckin([booked], checkin, TODAY).state, 'matched');
  // The same veteran, same day, whatever the clock says now — there is no
  // "now" in the call at all, which is what makes this true by construction.
  assert.strictEqual(v.candidatesFor([booked], TODAY).length, 1);
  // And an untimed row still matches exactly as it did before slots existed.
  const untimed = row({ id: 't2', firstName: 'Ann', lastName: 'Lee', dob: '1970-01-01' });
  assert.strictEqual(v.matchCheckin([untimed], checkin, TODAY).state, 'matched');
  // Build-enforced: neither function may learn about the time.
  const src = fs.readFileSync(path.join(__dirname, '..', 'veteranRoster.js'), 'utf8');
  const slice = src.slice(src.indexOf('function candidatesFor'), src.indexOf('// ── the window a roster read covers'));
  assert.ok(slice.length > 200, 'match slice looks wrong');
  assert.ok(!/examTime|durationMinutes|minutesOfDay|occupies/.test(slice),
    'the sign-in match is keyed on the DAY — a time here turns an early arrival into an unmatched veteran');
});

test('a slot is optional, validated when typed, and a length needs a start', () => {
  const base = { firstName: 'A', lastName: 'B', dob: '1970-01-01', examDate: TODAY };
  const at = (o) => v.normalizeRosterInput({ ...base, ...o }, { today: TODAY });
  assert.strictEqual(at({}).value.examTime, null, 'an untimed exam is still a real booking');
  assert.strictEqual(at({ examTime: '09:30', durationMinutes: 60 }).value.examTime, '09:30');
  assert.strictEqual(at({ examTime: '09:30', durationMinutes: '60' }).value.durationMinutes, 60);
  assert.strictEqual(at({ examTime: '' }).value.examTime, null, 'a cleared time is not an error');
  // A time that was TYPED and is not a time is a slip, not a blank.
  assert.ok(at({ examTime: '9:30' }).fieldErrors.examTime, 'needs two-digit hours');
  assert.ok(at({ examTime: '24:00' }).fieldErrors.examTime);
  assert.ok(at({ examTime: '09:60' }).fieldErrors.examTime);
  assert.ok(at({ examTime: '09:00', durationMinutes: 0 }).fieldErrors.durationMinutes);
  assert.ok(at({ examTime: '09:00', durationMinutes: 1.5 }).fieldErrors.durationMinutes);
  assert.ok(at({ examTime: '09:00', durationMinutes: v.MAX_EXAM_MINUTES + 1 }).fieldErrors.durationMinutes);
  // Refused BY NAME rather than ignored: a length with no start is a half
  // -filled slot the day cannot place.
  assert.match(at({ durationMinutes: 60 }).fieldErrors.durationMinutes, /start time/);
});

test('one provider cannot examine two veterans at once, and a length is never guessed', () => {
  const booked = [row({ id: 'a', providerUserId: 'p1', examTime: '09:00', durationMinutes: 60 })];
  const at = (o) => v.slotClash(booked, { examDate: TODAY, providerUserId: 'p1', ...o });
  assert.ok(at({ examTime: '09:00' }), 'the same minute is a clash even with no length on either side');
  assert.ok(at({ examTime: '09:30' }), 'inside the hour is a clash');
  assert.ok(!at({ examTime: '10:00' }), 'the minute it ends is free');
  assert.ok(!at({ examTime: '08:00' }));
  assert.ok(!at({ examTime: '09:30', providerUserId: 'p2' }), 'another provider is another room');
  assert.ok(!at({ examTime: '09:30', examDate: v.isoDate('2026-12-01') }), 'another day is not a clash');
  assert.ok(!at({}), 'an untimed exam occupies no slot and clashes with nothing');
  assert.ok(!v.slotClash(booked, { id: 'a', examDate: TODAY, providerUserId: 'p1', examTime: '09:00' }, { exceptId: 'a' }),
    'editing a row must not clash with itself');
  assert.ok(!v.slotClash([row({ id: 'r', providerUserId: 'p1', examTime: '09:00', durationMinutes: 60, removedAt: new Date().toISOString() })],
    { examDate: TODAY, providerUserId: 'p1', examTime: '09:00' }), 'a removed exam frees its slot');
  // TWO ROWS WITH NO LENGTH 30 MINUTES APART DO NOT CLASH. The app cannot know
  // whether a 09:00 exam runs past 09:30, and inventing a default length would
  // refuse a real booking on the strength of a number nobody entered.
  assert.ok(!v.slotClash([row({ id: 'n', providerUserId: 'p1', examTime: '09:00' })],
    { examDate: TODAY, providerUserId: 'p1', examTime: '09:30' }));
});

test('a day reads in time order, and an untimed exam sorts AFTER the timed ones', () => {
  const rows = [
    row({ id: 'none', lastName: 'Adams' }),
    row({ id: 'pm', lastName: 'Baker', examTime: '14:00' }),
    row({ id: 'am', lastName: 'Zane', examTime: '09:00' })
  ];
  // Surnames fight the clock on purpose: Adams sorts first alphabetically and
  // must still come last, and Zane sorts last and must come first.
  assert.deepStrictEqual(
    v.rowsInRange(rows, { from: TODAY, to: TODAY }, {}).map(r => r.id),
    ['am', 'pm', 'none']);
});

test('the slot travels to both screens, and My Day still carries no DOB', () => {
  const r = row({ examTime: '09:30', durationMinutes: 45 });
  assert.strictEqual(v.publicRow(r, null).examTime, '09:30');
  assert.strictEqual(v.publicRow(r, null).durationMinutes, 45);
  const d = v.examDayRow(r, null);
  assert.strictEqual(d.examTime, '09:30');
  assert.strictEqual(d.durationMinutes, 45);
  assert.ok(!('dob' in d), 'the slot must not have smuggled the rest of the row along with it');
});

test('server: a double-booked slot is refused at BOTH write doors, before the write', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const post = src.slice(src.indexOf("app.post('/api/veterans/roster'"), src.indexOf("app.put('/api/veterans/roster/:id'"));
  const put = src.slice(src.indexOf("app.put('/api/veterans/roster/:id'"), src.indexOf("app.delete('/api/veterans/roster/:id'"));
  for (const [name, route] of [['post', post], ['put', put]]) {
    assert.ok(route.length > 400 && route.length < 4000, `${name} slice looks wrong`);
    assert.ok(/vetRoster\.slotClash\(/.test(route), `${name} must check the slot`);
    assert.ok(/VETERAN_SLOT_TAKEN/.test(route), `${name} must name the refusal`);
    // The refusal names WHO holds the slot: "that time is taken" without
    // saying by whom is a refusal nobody can act on.
    assert.ok(/clash\.firstName/.test(route), `${name} must name the veteran already booked`);
    // Before the write, or a refused booking leaves a row behind.
    assert.ok(route.indexOf('slotClash') < route.indexOf("db.set('veteran_roster'"), `${name} must refuse before writing`);
  }
  assert.ok(/exceptId: rows\[i\]\.id/.test(put), 'editing a row must not clash with itself');
});

// ── An exam on the board can be edited (owner report, 2026-11-05) ─────────
// The PUT route has shipped since the roster did and NOTHING ever called it,
// so a veteran added without a time could never be given one: remove and
// re-add was the only way, and that loses the row's history. The same class
// of gap as the facility-assignment route and acknowledgeAbnormalResult.

test('page: the roster row can be edited, through the same form that adds', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'clinical.html'), 'utf8');
  // The route is reached at all — this is the assertion that was false.
  assert.match(src, /authedFetch\(`\/api\/veterans\/roster\/\$\{editing\.id\}`, \{ method: 'PUT'/,
    'nothing called the edit route, so a booking could never be corrected');
  const i = src.indexOf('const VeteranAddForm =');
  const form = src.slice(i, src.indexOf('\n    const ', i + 10));
  // ONE form for both. A second would be a second idea of what a booking is,
  // and the server validates them through one normalizeRosterInput.
  assert.strictEqual((src.match(/const VeteranAddForm = /g) || []).length, 1);
  assert.match(form, /useEffect\(\(\) => \{ setF\(editing \? fromRow\(editing\) : blank\)/,
    'the effect that actually fills the form from the row');
  assert.match(form, /Save Changes/);
  // Moving the board's day must not silently rewrite the date of the row
  // being edited.
  assert.match(form, /if \(!editing\) setF\(x => \(\{ \.\.\.x, examDate: date \}\)\)/,
    'the day picker must not overwrite the edited row');
  // Clearing a time has consequences the form cannot show on its own.
  assert.match(form, /Clearing the time removes this exam from the clinical calendar/);
  // One form on screen at a time.
  assert.match(src, /setEditing\(null\); setShowAdd\(s => !s\)/, 'opening Add closes an edit');
  assert.match(src, /setShowAdd\(false\); setEditing\(/, 'and opening an edit closes Add');
  assert.match(src, /\{editing && editing\.id === r\.id \? 'Close' : 'Edit'\}/,
    'the Edit button must be labelled — an onClick with no label is an invisible control');
});

test('server: the edit route re-validates and re-mirrors, it does not just store', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const i = src.indexOf("app.put('/api/veterans/roster/:id'");
  const route = src.slice(i, src.indexOf("app.delete('/api/veterans/roster/:id'", i));
  assert.ok(route.length > 400, 'route slice looks wrong');
  // An edit goes through the same validation as an add, or the two doors
  // start accepting different things.
  assert.match(route, /vetRoster\.normalizeRosterInput\(/);
  // And through the same slot-clash check, excluding itself.
  assert.match(route, /vetRoster\.slotClash\(rows, next, \{ exceptId: rows\[i\]\.id \}\)/);
  // The calendar follows the edit — a moved exam that stays put on Google is
  // worse than one that was never there.
  assert.match(route, /mirrorExamToGoogle\(rows\[i\]\)/);
  // A provider still cannot edit somebody else's veteran.
  assert.match(route, /vetRoster\.canEditRow\(/);
});
