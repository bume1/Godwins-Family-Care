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
const row = (o) => ({ id: o.id || 'r1', firstName: 'James', lastName: "O'Brien", dob: '1970-05-04', examDate: TODAY, status: 'expected', providerUserId: 'p1', ...o });

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
