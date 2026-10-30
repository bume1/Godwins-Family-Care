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
