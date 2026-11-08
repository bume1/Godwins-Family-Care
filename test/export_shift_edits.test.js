// A shift corrected after it started or concluded must show up on the payroll
// and billing exports.
//
// Owner report, 2026-11-06: changes management makes to a caregiver's shift
// time do not carry across to the payroll sheet, and a caregiver was overpaid.
//
// What was actually true, established by driving the real export routes before
// anything was changed:
//
//  1. `applyShiftEdit` DOES move the time log's copy of the schedule and DOES
//     stamp `schedule_corrected_at` / `schedule_corrected_by_name`. Neither
//     export read either stamp, so a corrected visit read exactly like an
//     uncorrected one.
//  2. Hours come from the clock, never the schedule — correct, you pay for
//     time worked — but nothing on the row said when the two disagreed. A
//     shift corrected on the board and not on the clock went on paying the old
//     figure in silence.
//  3. Worse, re-deriving the flags REMOVES `late_clock_out`, so correcting the
//     schedule deleted the one visible hint that the clock ran past the shift.
//  4. And a shift the board calls completed with NO time log was in NEITHER
//     sheet: payroll and billing are both built from time logs, so the
//     caregiver went unpaid, the client unbilled, and nothing said a visit was
//     missing.
//
// Nothing here changes what is PAID. The clock still decides the money; these
// tests pin that the disagreement is now visible.
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const bodyParser = require('body-parser');
const http = require('node:http');
const sched = require('../schedulingRepository');

// ---- The pure helpers ------------------------------------------------------

test('a log with no schedule has NO scheduled window, not a zero-length one', () => {
  // ⚠️ THE EPOCH TRAP, FOURTH OCCURRENCE. `new Date(null)` is 1970 and 1970 is
  // finite, so the repo's own totalMinutes answers 0 for a pair of nulls. A
  // scheduled window read as "0 hours" would report every log with no schedule
  // as an overpayment of its whole length. This control assertion is what
  // makes the guard in scheduledMinutes load-bearing rather than decorative.
  assert.equal(sched.totalMinutes(null, null), 0, 'the trap is real: totalMinutes says zero');
  assert.equal(sched.scheduledMinutes({ scheduled_start: null, scheduled_end: null }), null);
  assert.equal(sched.scheduledMinutes({}), null);
  assert.equal(sched.scheduledMinutes({ scheduled_start: '', scheduled_end: '' }), null);
  assert.equal(sched.scheduledMinutes({ scheduled_start: '2026-10-12T13:00:00Z', scheduled_end: null }), null);
  assert.equal(sched.scheduledMinutes({ scheduled_start: '2026-10-12T13:00:00Z', scheduled_end: '2026-10-12T17:00:00Z' }), 240);
});

test('hoursVsSchedule answers in words a payroll run can act on', () => {
  const win = { scheduled_start: '2026-10-12T13:00:00Z', scheduled_end: '2026-10-12T17:00:00Z' };
  // Nothing to compare against is NOT a match.
  assert.equal(sched.hoursVsSchedule({ total_minutes: 238 }), '');
  // No hours at all is its own answer, never "match" and never zero.
  assert.equal(sched.hoursVsSchedule({ ...win, total_minutes: null }), 'no hours recorded');
  assert.equal(sched.hoursVsSchedule({ ...win, total_minutes: undefined }), 'no hours recorded');
  // Inside the flags' own grace, so a row reading 'match' earned no lateness
  // flag either. Two different answers to one question is how a sheet stops
  // being trusted.
  assert.equal(sched.hoursVsSchedule({ ...win, total_minutes: 240 }), 'match');
  assert.equal(sched.hoursVsSchedule({ ...win, total_minutes: 240 + sched.DEFAULT_GRACE_MINUTES }), 'match');
  assert.equal(sched.hoursVsSchedule({ ...win, total_minutes: 240 - sched.DEFAULT_GRACE_MINUTES }), 'match');
  // Outside it, the direction and the size, because "which way and how much"
  // is the whole question when money has moved.
  assert.equal(sched.hoursVsSchedule({ ...win, total_minutes: 293 }), 'over by 0.88 h');
  assert.equal(sched.hoursVsSchedule({ ...win, total_minutes: 180 }), 'under by 1.00 h');
});

test('a schedule moved onto a different Georgia day is detectable', () => {
  assert.equal(sched.scheduleDateMoved({
    clock_in_at: '2026-10-12T13:02:00Z', scheduled_start: '2026-10-14T13:00:00Z'
  }), true);
  assert.equal(sched.scheduleDateMoved({
    clock_in_at: '2026-10-12T13:02:00Z', scheduled_start: '2026-10-12T13:00:00Z'
  }), false);
  // A 9pm Georgia shift is already tomorrow in UTC. Judged in Georgia, not UTC,
  // or every evening visit would read as moved.
  assert.equal(sched.scheduleDateMoved({
    clock_in_at: '2026-10-13T01:02:00Z', scheduled_start: '2026-10-13T01:00:00Z'
  }), false, 'both are 9pm on the 12th in Georgia');
  // Nothing to compare: never a false positive.
  assert.equal(sched.scheduleDateMoved({ scheduled_start: '2026-10-14T13:00:00Z' }), false);
  assert.equal(sched.scheduleDateMoved({ clock_in_at: '2026-10-12T13:02:00Z' }), false);
});

test('a row with no clock is dated by its schedule, not dropped', () => {
  // This fallback IS the fix for the missing visit: the date filter read the
  // clock, so a visit nobody clocked into had no date and fell out entirely.
  assert.equal(sched.exportRowDate({ clock_in_at: '2026-10-12T13:02:00Z' }), '2026-10-12');
  assert.equal(sched.exportRowDate({ scheduled_start: '2026-10-14T13:00:00Z' }), '2026-10-14');
  assert.equal(sched.exportRowDate({
    clock_in_at: '2026-10-12T13:02:00Z', scheduled_start: '2026-10-14T13:00:00Z'
  }), '2026-10-12', 'the clock wins: it is when the work was actually done');
  assert.equal(sched.exportRowDate({}), '');
});

test('both sheets carry the correction columns', () => {
  const keys = (cols) => cols.map(c => c.key);
  for (const cols of [sched.PAYROLL_CSV_COLUMNS, sched.BILLING_CSV_COLUMNS]) {
    assert.ok(keys(cols).includes('scheduledHours'), 'the scheduled length');
    assert.ok(keys(cols).includes('hoursMatch'), 'whether it agrees with the pay');
    assert.ok(keys(cols).includes('scheduleCorrected'), 'when it was corrected');
  }
  assert.ok(keys(sched.PAYROLL_CSV_COLUMNS).includes('scheduleCorrectedBy'), 'and by whom');
  // A caregiver's own copy gets both figures but NOT the agreement column:
  // "under by 0.50 h" on a personal record reads as an accusation.
  assert.ok(keys(sched.CAREGIVER_HOURS_CSV_COLUMNS).includes('scheduledHours'));
  assert.ok(!keys(sched.CAREGIVER_HOURS_CSV_COLUMNS).includes('hoursMatch'));
});

// ---- Driven through the real export routes --------------------------------
// ⚠️ THE PURE TESTS ABOVE CANNOT PROVE A COLUMN IS POPULATED. A helper that
// answers correctly and a builder that never calls it look identical to them,
// which is exactly the defect being fixed here: the stamps existed and nothing
// read them. These mount the shipped router and read the sheets back.

function harness() {
  const store = new Map();
  const db = {
    get: async k => (store.has(k) ? JSON.parse(JSON.stringify(store.get(k))) : null),
    set: async (k, v) => { store.set(k, JSON.parse(JSON.stringify(v))); }
  };
  const users = [
    { id: 'adm', email: 'a@g.test', name: 'GFC Admin', role: 'admin' },
    // ⚠️ LPN while the shift below REQUIRES cna. If the two matched, the
    // assertion that a no-time-log row reports the HOLDER's licence rather
    // than the shift's requirement could not tell the two apart.
    { id: 'cg1', email: 'g@g.test', name: 'Danielle Carter', role: 'vendor', licenseLevel: 'lpn', payRate: 20 },
    { id: 'client-1', email: 'cl@g.test', name: 'Margaret Whitfield', role: 'client', enrollmentStatus: 'enrolled' }
  ];
  const app = express();
  app.use(bodyParser.json());
  app.use(require('../routes/scheduling')({
    db,
    // The REAL config: a harness missing what production supplies exercises a
    // different function.
    config: require('../config'),
    logActivity: async () => {}, queueNotification: async () => ({ id: 'n' }),
    getUsers: async () => JSON.parse(JSON.stringify(users)),
    invalidateUsersCache: () => {},
    authenticateToken: (req, res, next) => {
      const u = users.find(x => x.id === (req.headers['x-as'] || 'adm'));
      if (!u) return res.status(401).json({ error: 'no' });
      req.user = {
        id: u.id, email: u.email, name: u.name, role: u.role, isManager: false,
        accountType: u.role === 'admin' ? 'admin' : null, clinicalRole: null,
        hasClinicalAccess: false, licenseLevel: u.licenseLevel || null,
        assignedClients: [], careTeam: null, familyOfClientId: null
      };
      next();
    },
    uuidv4: () => `id-${Math.random().toString(36).slice(2, 10)}`
  }));
  return { app, db };
}

const call = (app, method, url, body, as) => new Promise((resolve, reject) => {
  const srv = http.createServer(app).listen(0, () => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      port: srv.address().port, path: url, method,
      headers: Object.assign({ 'x-as': as || 'adm' },
        data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {})
    }, (res) => {
      let b = ''; res.on('data', c => b += c);
      // `text` as well as `body`: the CSV routes send text, and a JSON-only
      // reader hands back null for them — which silently passed an assertion
      // in the first draft of this file.
      res.on('end', () => { srv.close(); let j = null; try { j = JSON.parse(b); } catch {} resolve({ status: res.statusCode, body: j, text: b }); });
    });
    req.on('error', e => { srv.close(); reject(e); });
    if (data) req.write(data); req.end();
  });
});

// Georgia times. 13:00Z is 9:00 AM ET on 2026-10-12.
const SCHED_START = '2026-10-12T13:00:00.000Z';
const SCHED_END = '2026-10-12T17:00:00.000Z';
const WINDOW = 'from=2026-10-01&to=2026-10-31';

const shift = (over = {}) => Object.assign({
  id: 's1', client_id: 'client-1', client_name: 'Margaret Whitfield', status: 'completed',
  start: SCHED_START, end: SCHED_END, required_license_level: 'cna',
  pool_visibility: 'all_eligible', care_tier: 'A2', notes: '', pay_rate: null,
  caregiver_id: 'cg1', caregiver_name: 'Danielle Carter'
}, over);

const timeLog = (over = {}) => Object.assign({
  id: 'tl1', shift_id: 's1', caregiver_id: 'cg1', caregiver_name: 'Danielle Carter',
  client_id: 'client-1', client_name: 'Margaret Whitfield', license_level: 'cna',
  clock_in_at: '2026-10-12T13:02:00.000Z', clock_out_at: '2026-10-12T17:55:00.000Z',
  clock_in_geofence: { verdict: 'inside' }, total_minutes: 293,
  flags: ['late_clock_out'], scheduled_start: SCHED_START, scheduled_end: SCHED_END
}, over);

async function seed(h, shifts, logs) {
  await h.db.set('users', [{
    id: 'client-1', name: 'Margaret Whitfield', role: 'client',
    enrollmentStatus: 'enrolled', address: { lat: 33.9, lng: -84.4 }
  }]);
  await h.db.set('shifts', shifts);
  await h.db.set('time_logs', logs);
}

const sheets = async (h, window = WINDOW) => {
  const p = await call(h.app, 'GET', `/api/scheduling/payroll?${window}`);
  const b = await call(h.app, 'GET', `/api/scheduling/billing?${window}`);
  assert.equal(p.status, 200, 'payroll read');
  assert.equal(b.status, 200, 'billing read');
  return { payroll: p.body.rows || [], billing: b.body.rows || [] };
};

test('ROUTE: correcting a CONCLUDED shift shows on both sheets', async () => {
  const h = harness();
  await seed(h, [shift()], [timeLog()]);

  const before = await sheets(h);
  assert.equal(before.payroll[0].hoursMatch, 'over by 0.88 h',
    'the clock ran 53 minutes past the shift');
  assert.equal(before.payroll[0].scheduleCorrected, '', 'nothing corrected yet');

  // The visit really ran to 2pm. Management corrects the concluded shift.
  const edit = await call(h.app, 'PUT', '/api/scheduling/shifts/s1',
    { start: SCHED_START, end: '2026-10-12T18:00:00.000Z' });
  assert.equal(edit.status, 200);
  assert.equal(edit.body.timeLogsUpdated, 1, 'the log moved with the shift');

  const after = await sheets(h);
  const [pay] = after.payroll;
  const [bill] = after.billing;

  // THE REPORT: the change now carries across. Both sheets.
  assert.equal(pay.scheduledHours, 5, 'payroll reads the corrected schedule');
  assert.equal(bill.scheduledHours, 5, 'billing reads it too');
  assert.match(pay.scheduleCorrected, /^11?\/|^\d+\//, 'payroll stamps when');
  assert.equal(pay.scheduleCorrectedBy, 'GFC Admin', 'and who');
  assert.ok(bill.scheduleCorrected, 'billing stamps when');
  assert.equal(pay.hoursMatch, 'match', 'the pay now agrees with the schedule');
  assert.equal(bill.hoursMatch, 'match');

  // AND THE MONEY DID NOT MOVE. The clock still decides what is paid; this
  // change makes the disagreement visible, it does not pay the schedule.
  assert.equal(pay.hours, 4.88, 'hours are still the clock');
  assert.equal(pay.grossPay, '97.60');
});

test('ROUTE: a schedule corrected but the clock left alone says so', async () => {
  const h = harness();
  await seed(h, [shift()], [timeLog()]);
  // Management shortens a concluded shift to 9-11 without touching the clock.
  // The caregiver is still paid 4.88 h against a 2 h schedule, and that has to
  // be legible or it is an overpayment nobody can find.
  const edit = await call(h.app, 'PUT', '/api/scheduling/shifts/s1',
    { start: SCHED_START, end: '2026-10-12T15:00:00.000Z' });
  assert.equal(edit.status, 200);

  const { payroll, billing } = await sheets(h);
  assert.equal(payroll[0].scheduledHours, 2);
  assert.equal(payroll[0].hours, 4.88);
  assert.equal(payroll[0].hoursMatch, 'over by 2.88 h', 'the overpayment is on the row');
  assert.equal(billing[0].hoursMatch, 'over by 2.88 h', 'and on the invoice sheet');
  assert.equal(payroll[0].scheduleCorrectedBy, 'GFC Admin');
});

test('ROUTE: a visit nobody clocked into is on BOTH sheets, with no hours', async () => {
  const h = harness();
  // The whole money hole: a completed visit with no time log at all.
  await seed(h, [shift({ id: 's9' })], []);

  const { payroll, billing } = await sheets(h);
  assert.equal(payroll.length, 1, 'payroll no longer hides it');
  assert.equal(billing.length, 1, 'neither does billing');

  const [pay] = payroll;
  assert.equal(pay.shiftDate, '10/12/2026', 'dated by the shift, since there is no clock');
  assert.equal(pay.scheduledHours, 4, 'the size of the gap is visible');
  assert.equal(pay.hours, null, 'and NO hours are invented');
  assert.equal(pay.grossPay, '', 'so nothing is paid');
  assert.equal(pay.hoursMatch, 'no hours recorded');
  assert.equal(pay.source, 'No time recorded');
  assert.match(pay.flags, /no_time_log/);
  assert.equal(pay.caregiverName, 'Danielle Carter', 'and who was meant to be there');
  assert.equal(pay.licenseLevel, 'LPN',
    "the HOLDER's licence, not the shift's cna requirement");

  assert.equal(billing[0].hours, null, 'the billable cell stays empty');
  assert.equal(billing[0].scheduledHours, 4);
  assert.equal(billing[0].verification, 'unverifiable', 'nothing was verified, because nothing happened');
});

test('ROUTE: a completed visit with no clock-out is a visible gap on billing', async () => {
  const h = harness();
  // Previously dropped from billing entirely (no clock-out, no row), so a
  // caregiver who forgot to clock out left the client unbilled in silence.
  await seed(h, [shift()], [timeLog({ clock_out_at: null, total_minutes: null, flags: [] })]);

  const { payroll, billing } = await sheets(h);
  assert.equal(payroll.length, 1);
  assert.equal(billing.length, 1, 'the gap is listed');
  assert.equal(billing[0].hours, null, 'with NO number on it — that rule stands');
  assert.equal(billing[0].hoursMatch, 'no hours recorded');
  assert.equal(billing[0].scheduledHours, 4);
});

test('ROUTE: a visit still IN PROGRESS stays off the billing sheet', async () => {
  const h = harness();
  // The original rule, and it is right: a half-open visit on an invoice is a
  // credit note waiting to happen. It is not finished, so it is not a gap.
  await seed(h, [shift({ status: 'in_progress' })],
    [timeLog({ clock_out_at: null, total_minutes: null, flags: [] })]);

  const { payroll, billing } = await sheets(h);
  assert.equal(billing.length, 0, 'not billable yet');
  assert.equal(payroll.length, 1, 'but payroll still shows the open visit');
  assert.equal(payroll[0].hours, null);
});

test('ROUTE: an IN-PROGRESS shift with no log is a payroll row, not a billing gap', async () => {
  const h = harness();
  // ⚠️ THE CASE THE TEST ABOVE CANNOT SEE. That one seeds a shift that HAS a
  // log, so it says nothing about which statuses count as a billing gap —
  // widening them to include in_progress left it green. A visit still running
  // has not failed to produce hours yet; it is not an unbilled gap.
  await seed(h, [shift({ status: 'in_progress', id: 's8' })], []);
  const { payroll, billing } = await sheets(h);
  assert.equal(billing.length, 0, 'a running visit is not an invoice gap');
  assert.equal(payroll.length, 1, 'but payroll shows it is owed hours');
  assert.equal(payroll[0].source, 'No time recorded');
  assert.equal(payroll[0].hours, null);
});

test('ROUTE: a cancelled shift nobody worked is on neither sheet', async () => {
  const h = harness();
  // Nothing happened: no pay, no invoice, and no gap row either.
  await seed(h, [shift({ status: 'cancelled' }), shift({ id: 's2', status: 'no_show' })], []);
  const { payroll, billing } = await sheets(h);
  assert.equal(payroll.length, 0);
  assert.equal(billing.length, 0);
});

test('ROUTE: a shift moved to another DAY is flagged, never re-filed', async () => {
  const h = harness();
  await seed(h, [shift()], [timeLog()]);
  // Management moves a concluded 10/12 visit onto 10/14.
  const edit = await call(h.app, 'PUT', '/api/scheduling/shifts/s1',
    { start: '2026-10-14T13:00:00.000Z', end: '2026-10-14T17:00:00.000Z' });
  assert.equal(edit.status, 200);

  const { payroll } = await sheets(h);
  // The row KEEPS the date the work was done. Re-bucketing it onto a day
  // nobody worked would move real hours into the wrong pay period — so it is
  // flagged instead, because either the date edit was wrong or the clock was
  // and both want a person to look.
  assert.equal(payroll[0].shiftDate, '10/12/2026', 'still the day it was worked');
  assert.match(payroll[0].flags, /schedule_date_moved/, 'and the contradiction is named');
  assert.equal(payroll[0].scheduleCorrectedBy, 'GFC Admin');
});

test('ROUTE: a caregiver sees both figures and their own unrecorded visit', async () => {
  const h = harness();
  await seed(h, [shift(), shift({ id: 's9', start: '2026-10-15T13:00:00.000Z', end: '2026-10-15T17:00:00.000Z' })],
    [timeLog()]);
  const r = await call(h.app, 'GET', '/api/scheduling/my-hours.csv?from=2026-10-01&to=2026-10-31', null, 'cg1');
  assert.equal(r.status, 200);
  const lines = r.text.split('\r\n').filter(l => l.trim());
  const header = lines[0].split(',');
  assert.ok(header.includes('Scheduled Hours'), 'their own copy carries both figures');
  assert.ok(!header.includes('Hours vs Schedule'), 'but not the agreement column');
  // ⚠️ THE HEADER IS NOT THE DATA. A first draft asserted only the header,
  // which comes from the column definition — so dropping the populated cell
  // left this test green. Read the CELL.
  const col = header.indexOf('Scheduled Hours');
  const cells = (i) => lines[i].split(',');
  assert.equal(cells(1)[header.indexOf('Hours')], '4.88', 'their clocked hours');
  assert.equal(cells(1)[col], '4', 'and the scheduled length beside it');
  // Their worked visit AND the 10/15 visit the office has no hours for, so a
  // caregiver can find their own unpaid work — the cheapest control there is.
  assert.equal(lines.length, 3, 'header plus two visits');
  assert.equal(cells(2)[header.indexOf('Date')], '10/15/2026', 'the unrecorded one');
  assert.equal(cells(2)[header.indexOf('Hours')], '', 'with no hours');
  assert.equal(cells(2)[col], '4', 'but its scheduled length, so the gap is sized');
});

test('ROUTE: every row has a stable key, gap rows included', async () => {
  const h = harness();
  // The screen keys its table rows on the row's id. A gap row has NO time log,
  // so two of them would both key on null — a React key collision that can
  // mis-render the table. Found by reading what the page does with these rows,
  // not by reading the builder.
  await seed(h, [
    shift({ id: 'g1', start: '2026-10-12T13:00:00.000Z', end: '2026-10-12T17:00:00.000Z' }),
    shift({ id: 'g2', start: '2026-10-13T13:00:00.000Z', end: '2026-10-13T17:00:00.000Z' })
  ], []);
  const { payroll, billing } = await sheets(h);
  assert.equal(payroll.length, 2);
  for (const rows of [payroll, billing]) {
    const keys = rows.map(r => r.rowKey);
    assert.ok(keys.every(k => typeof k === 'string' && k.length > 0), 'every row has a key');
    assert.equal(new Set(keys).size, keys.length, 'and no two rows share one');
    assert.ok(rows.every(r => r.timeLogId === null), 'these really are gap rows');
  }
  // A normal row keys on its own time log, unchanged.
  const h2 = harness();
  await seed(h2, [shift()], [timeLog()]);
  const s2 = await sheets(h2);
  assert.equal(s2.payroll[0].rowKey, 'tl1');
});

test('the screen keys its rows on that field, not on the time log id', () => {
  const page = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'public', 'scheduling.html'), 'utf8');
  assert.match(page, /<tr key=\{r\.rowKey \|\| r\.timeLogId\}/,
    'a null timeLogId on a gap row would collide with every other gap row');
  // And the new columns need no page change at all: the table renders whatever
  // the server says its columns are. Pinned so a later edit does not hardcode
  // a column list and quietly drop the correction columns from the screen.
  assert.match(page, /const cols = \(data\.columns \|\| \[\]\)\.filter/,
    'columns come from the server, never a list in the page');
});

test('the CSV file itself carries the new headers', () => {
  const csv = sched.toPayrollCsv([{ scheduledHours: 5, hoursMatch: 'match' }]);
  const header = csv.split('\r\n')[0];
  assert.ok(header.includes('Scheduled Hours'));
  assert.ok(header.includes('Hours vs Schedule'));
  assert.ok(header.includes('Schedule Corrected'));
  assert.ok(header.includes('Corrected By'));
  const bill = sched.toPayrollCsv([{}], sched.BILLING_CSV_COLUMNS).split('\r\n')[0];
  assert.ok(bill.includes('Scheduled Hours'));
  assert.ok(bill.includes('Hours vs Schedule'));
  assert.ok(bill.includes('Schedule Corrected'));
});
