// ============================================================================
// Spreadsheet/app time formats, and a visit log somebody can actually read
// ============================================================================
// Owner, 2026-10-03, two reports in one message:
//
//   "fix the formatting for our billing and payroll spreadsheets. And for the
//    scheduling app. It is in military time and idk what the time format is
//    for the spreadsheets."
//
// The spreadsheets were worse than military time — they carried the raw stored
// instant, `2026-10-04T01:00:00.000Z`, which is not a format anyone asked for,
// is not a value Excel parses as a time, and reads FOUR HOURS WRONG as a
// wall-clock reading of a Georgia shift.
//
// Underneath that was a correctness bug, not a cosmetic one: the row's date,
// the export's date FILTER and the PAY PERIOD all came from
// `iso.slice(0, 10)` — the UTC date. A 9pm Georgia shift is already tomorrow
// in UTC, so an evening visit filed under the wrong day and could be paid in
// the wrong period. That is the same class of defect as the 2026-09-16 shift
// email that read four hours late, and the fix is the same: one clock module.
//
// The app's own military time was real and ours: availability windows and
// shift requests store the "HH:MM" string typed into an `<input type="time">`
// and were rendered verbatim, so a rota read "Tue 18:00–23:00".
//
// Plus the three visit-note items the owner approved in the same message: the
// review screen showed only a header line while the content sat served and
// unread, there was nothing to download, and a manager could not open the
// supervision queue at all.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const T = require('../public/gfc-time');
const sched = require('../schedulingRepository');
const cg = require('../caregiverRepository');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

// Two instants that make the UTC-vs-Georgia difference observable. A test
// fixture that sits in the middle of a Georgia afternoon proves nothing here:
// the UTC date and the Eastern date agree, so the old code and the new code
// return the same answer and the assertion cannot distinguish them.
const NIGHT_IN  = '2026-10-04T01:00:00.000Z';   // 9:00 PM Sat Oct 3, Eastern
const NIGHT_OUT = '2026-10-04T06:00:00.000Z';   // 2:00 AM Sun Oct 4, Eastern
const DAY_IN    = '2026-10-03T17:00:00.000Z';   // 1:00 PM Sat Oct 3, Eastern

// ---------------------------------------------------------------------------
// fmtClock — a stored wall-clock string
// ---------------------------------------------------------------------------

test('fmtClock turns a stored HH:MM into the 12-hour time people read', () => {
  assert.strictEqual(T.fmtClock('09:00'), '9:00 AM');
  assert.strictEqual(T.fmtClock('18:00'), '6:00 PM');
  assert.strictEqual(T.fmtClock('17:30'), '5:30 PM');
  assert.strictEqual(T.fmtClock('23:59'), '11:59 PM');
});

test('midnight is 12 AM and noon is 12 PM — not 0 AM, not 12 AM', () => {
  // The off-by-twelve a hand-rolled `h % 12` gets wrong in both directions.
  assert.strictEqual(T.fmtClock('00:00'), '12:00 AM');
  assert.strictEqual(T.fmtClock('00:30'), '12:30 AM');
  assert.strictEqual(T.fmtClock('12:00'), '12:00 PM');
  assert.strictEqual(T.fmtClock('12:45'), '12:45 PM');
});

test('fmtClock never builds a Date, so it cannot invent a day or a zone', () => {
  // An availability window has no date and no zone: "Tue 18:00" means those
  // hours on any Tuesday. Running it through `new Date('18:00')` would give
  // Invalid Date, and `new Date('2026-01-01T18:00')` would read it in whatever
  // zone the reader sits in. Proven by behaviour: the answer must not move
  // when the process zone does.
  const saved = process.env.TZ;
  try {
    process.env.TZ = 'Asia/Tokyo';
    assert.strictEqual(T.fmtClock('18:00'), '6:00 PM');
    process.env.TZ = 'UTC';
    assert.strictEqual(T.fmtClock('18:00'), '6:00 PM');
  } finally {
    if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved;
  }
});

test('an empty time is empty, and an unrecognised one is shown as it is', () => {
  // Empty prints nothing rather than "12:00 AM" — the epoch trap gfc-time was
  // fixed for. Something that is not an HH:MM is not ours to reformat, and
  // showing it unchanged is better than showing a guess.
  ['', null, undefined].forEach(v => assert.strictEqual(T.fmtClock(v), ''));
  assert.strictEqual(T.fmtClock('bad'), 'bad');
  assert.strictEqual(T.fmtClock('24:00'), '24:00');
});

// ---------------------------------------------------------------------------
// The spreadsheet columns
// ---------------------------------------------------------------------------

test('a shift is dated the day it happened in GEORGIA, not in UTC', () => {
  // THE PAYROLL BUG. A 9pm Saturday shift is Sunday in UTC, so the old
  // `slice(0, 10)` dated it Oct 4 — and handed Oct 4 to payPeriodFor().
  assert.strictEqual(NIGHT_IN.slice(0, 10), '2026-10-04');   // what it used to say
  assert.strictEqual(sched.csvLocalDate(NIGHT_IN), '2026-10-03');
  assert.strictEqual(sched.csvDate(NIGHT_IN), '10/3/2026');
});

test('the wrong date could put an evening shift in the wrong pay period', () => {
  // Not hypothetical: the two dates can fall either side of a period boundary,
  // and then the hours are paid in the wrong run. Asserted through the real
  // payPeriodFor so this is the app's own period maths, not a restatement.
  const utcDay = NIGHT_IN.slice(0, 10);
  const gaDay = sched.csvLocalDate(NIGHT_IN);
  assert.notStrictEqual(utcDay, gaDay);
  const a = sched.payPeriodFor(utcDay);
  const b = sched.payPeriodFor(gaDay);
  assert.ok(a && b);
  // For this pair the boundary is a Monday anchor, so they agree here; what
  // the test pins is that the period is derived from the GEORGIA date, which
  // is the only one that can be relied on to be right.
  assert.strictEqual(b.start <= gaDay && gaDay <= b.end, true);
});

test('a time column reads "9:00 PM", never a raw ISO instant', () => {
  const day = sched.csvLocalDate(NIGHT_IN);
  assert.strictEqual(sched.csvTime(NIGHT_IN, day), '9:00 PM');
  assert.strictEqual(sched.csvTime(DAY_IN, sched.csvLocalDate(DAY_IN)), '1:00 PM');
  // The shape that used to land in the cell.
  assert.ok(!/T\d\d:\d\d|Z$/.test(sched.csvTime(NIGHT_IN, day)));
});

test('an overnight shift date-stamps the end, so 2 AM is not read as before the start', () => {
  // Time alone is what a timesheet wants beside a date column — but an
  // overnight shift ends on the NEXT day, and a bare "2:00 AM" there reads as
  // nineteen hours before the 9 PM start instead of five hours after it.
  const day = sched.csvLocalDate(NIGHT_IN);
  assert.strictEqual(sched.csvTime(NIGHT_OUT, day), '10/4 2:00 AM');
  // And the common case stays clean: same day, no date noise.
  assert.strictEqual(sched.csvTime(DAY_IN, sched.csvLocalDate(DAY_IN)), '1:00 PM');
});

test('a shift still running leaves the clock-out cell EMPTY', () => {
  // Never "12:00 AM" and never the epoch: an open shift has no clock-out, and
  // a blank cell is a question for whoever runs payroll rather than a wrong
  // answer. The same rule the pay-rate column already follows.
  const day = sched.csvLocalDate(NIGHT_IN);
  ['', null, undefined].forEach(v => assert.strictEqual(sched.csvTime(v, day), ''));
});

test('these formats hold across the November daylight-saving change', () => {
  // An offset is right today and wrong from November 1; a named zone carries
  // its own rules. 01:30Z on Nov 1 is still Oct 31 in Georgia.
  assert.strictEqual(sched.csvLocalDate('2026-11-01T01:30:00.000Z'), '2026-10-31');
  assert.strictEqual(sched.csvTime('2026-11-01T01:30:00.000Z', '2026-10-31'), '9:30 PM');
  // Same wall-clock hour either side of the change, five hours apart in UTC.
  assert.strictEqual(sched.csvTime('2026-07-15T13:00:00.000Z', '2026-07-15'), '9:00 AM');
  assert.strictEqual(sched.csvTime('2026-01-15T14:00:00.000Z', '2026-01-15'), '9:00 AM');
});

test('no export puts a stored instant or a UTC date slice into a cell', () => {
  // Build-enforced, because the next export would be written by copying a
  // neighbour. Every timestamp column in the three CSV routes goes through
  // the formatters, and no route re-derives a date with slice(0, 10).
  const src = read('routes/scheduling.js');

  // Scoped to the three CSV route bodies BY NAME. A looser slice caught the
  // time-log JSON projection too, where the raw instant is correct — the
  // browser formats it through gfc-time. A guard that cannot tell a
  // spreadsheet cell from an API field would have to be ignored, so it is
  // narrowed instead of relaxed.
  const bodyOf = (routePath) => {
    const i = src.indexOf(`router.get('${routePath}'`);
    assert.ok(i > 0, `${routePath} not found — the guard is pointed at nothing`);
    const next = src.indexOf('\n  // GET /api/scheduling', i + 1);
    return src.slice(i, next === -1 ? src.length : next);
  };

  for (const route of ['/api/scheduling/payroll.csv', '/api/scheduling/billing.csv',
                       '/api/scheduling/my-hours.csv']) {
    const body = bodyOf(route);
    [/scheduledStart:\s*l\.scheduled_start\b/, /clockInAt:\s*l\.clock_in_at\b/,
     /clockOutAt:\s*l\.clock_out_at\b/, /scheduledEnd:\s*l\.scheduled_end\b/,
     /(?:shiftDate|serviceDate):\s*String\(/]
      .forEach(re => assert.ok(!re.test(body),
        `${route} still carries a raw instant or a UTC date slice: ${re}`));
    assert.ok(/sched\.csvTime\(/.test(body), `${route} should format its times`);

    // THE FILTER, per route and by name. A first version of this counted
    // `csvLocalDate(` call sites across the file and required three or more —
    // which one reverted filter sails straight through, because the column
    // formatting uses the same call several times over. Counting a thing that
    // appears for two different reasons cannot tell you about either.
    assert.ok(!/const d = String\(l\.clock_in_at \|\| ''\)\.slice\(0, 10\)/.test(body),
      `${route} filters on the UTC date, so an evening Georgia shift falls in the wrong range`);
    assert.ok(/const d = sched\.csvLocalDate\(l\.clock_in_at\)/.test(body),
      `${route} should filter on the date the shift happened in Georgia`);
  }

  // And the pay period is derived from that same Georgia date, not the slice.
  const payroll = bodyOf('/api/scheduling/payroll.csv');
  assert.ok(/const shiftDate = sched\.csvLocalDate\(l\.clock_in_at\)/.test(payroll),
    'the pay period is derived from shiftDate, so shiftDate must be the Georgia date');

  // The three date/time columns and the three filters, all on the helpers.
  assert.ok(src.includes('sched.csvDate('), 'the date column should use csvDate');
  assert.ok(src.includes('sched.csvTime('), 'the time columns should use csvTime');

});

// ---------------------------------------------------------------------------
// The scheduling app's own military time
// ---------------------------------------------------------------------------

test('the rota renders a stored HH:MM through fmtClock, never verbatim', () => {
  // "Tue 18:00–23:00" on the admin board and in the caregiver app. The
  // `<input type="time">` VALUE stays HH:MM — that is what the element
  // requires — so only the read-back lines change.
  const admin = read('public/scheduling.html');
  const comp = read('public/components/caregiver-schedule.js');

  assert.ok(!/\$\{w\.day\}\s*\$\{w\.start\}/.test(admin),
    'the admin availability line still prints the raw 24-hour window');
  assert.ok(/fmtClock\(w\.start\)/.test(admin) && /fmtClock\(w\.end\)/.test(admin),
    'the admin availability line should format both ends');

  assert.ok(!/w\.day \+ ' ' \+ w\.start \+/.test(comp),
    "the caregiver app's availability line still prints the raw 24-hour window");
  assert.ok(/fmtClock\(w\.start\)/.test(comp) && /fmtClock\(w\.end\)/.test(comp),
    "the caregiver app's availability line should format both ends");

  // A shift request carried the same raw pair plus a bare ISO date.
  assert.ok(/fmtClock\(r\.start\)/.test(admin) && /fmtPlainDate\(r\.date\)/.test(admin),
    'a shift request row should format its times and its date');

  // The input values must NOT be reformatted — that would break the element.
  assert.ok(/type="time" value=\{start\}/.test(admin),
    'an <input type="time"> must keep its HH:MM value');
});

// ---------------------------------------------------------------------------
// Visit notes, item 1 — the content, as labelled sections
// ---------------------------------------------------------------------------

const LOG_ROW = {
  id: 'vl-1',
  client_id: 'c-1',
  caregiver_id: 'cg-1',
  caregiver_name: 'Ada Nwosu',
  license_level: 'cna',
  visit_date: '2026-10-03',
  visit_type: 'Daily visit',
  // REAL ids out of TASK_GROUPS — `bath`, `cook`, `dressing`. The first draft
  // of this fixture used 'bathing'/'cooking', which are not in the catalog, so
  // describeVisitLog correctly dropped them and the test reported a bug that
  // was the fixture's. A probe that seeds the wrong world reports on a world
  // that is not production.
  tasks: {
    bath: { done: true, note: '' },
    // Done=false WITH a reason: the row a reviewer most needs.
    cook: { done: false, note: 'Client had already eaten.' },
    // Stored but neither done nor noted — nothing to report.
    dressing: { done: false, note: '' },
    // An id that is NOT in the catalog (retired, or a client that invented
    // one) must not surface as a raw key on the screen.
    legacy_made_up_task: { done: true, note: '' }
  },
  measurements: { bloodPressure: '128/82', pulse: '72', weightLbs: '' },
  narratives: { additionalNotes: 'Settled and comfortable.' },
  standing_instructions_acknowledged: ['report_falls'],
  patient_condition: ['alert', 'happy'],
  safety_concerns: ['meal_consumption'],
  satisfaction: 'not_satisfied',
  status: 'submitted',
  submitted_at: '2026-10-04T01:30:00.000Z'
};

test('a visit log describes itself in labels, not in stored ids', () => {
  const d = cg.describeVisitLog(LOG_ROW);
  const labels = d.tasks.map(t => t.label);
  // Real labels out of the catalog in caregiverRepository.js — not 'bathing'.
  assert.ok(labels.some(l => /bath/i.test(l)), `expected a bathing label, got ${labels}`);
  assert.ok(!labels.includes('bath'), 'a raw task id reached the screen');
  assert.ok(!labels.includes('legacy_made_up_task') && !labels.some(l => /legacy_made_up/.test(l)),
    'an id the catalog does not carry surfaced as a raw key');
  assert.deepStrictEqual(d.measurements.map(m => m.label).includes('Blood pressure'), true);
  assert.deepStrictEqual(d.patientCondition, ['Alert', 'Happy']);
  assert.deepStrictEqual(d.safetyConcerns, ['Meal consumption']);
  assert.deepStrictEqual(d.standingInstructionsAcknowledged, ['Report all falls']);
  assert.deepStrictEqual(d.narratives, [{ label: 'Additional notes', value: 'Settled and comfortable.' }]);
});

test('a task NOT done, with a reason, is kept and marked as not done', () => {
  const d = cg.describeVisitLog(LOG_ROW);
  const cooking = d.tasks.find(t => /cook/i.test(t.label));
  assert.ok(cooking, 'the not-done task was dropped');
  assert.strictEqual(cooking.done, false);
  assert.strictEqual(cooking.note, 'Client had already eaten.');
  // And one with neither a tick nor a note has nothing to say.
  assert.ok(!d.tasks.some(t => /dress/i.test(t.label)), 'an empty task row was listed');
});

test('an empty measurement is not listed as a blank reading', () => {
  const d = cg.describeVisitLog(LOG_ROW);
  assert.ok(!d.measurements.some(m => m.value === ''), 'a blank measurement reached the screen');
  assert.ok(!d.measurements.some(m => m.label === 'Weight (lb)'));
});

test('satisfaction reads as words, and an unanswered one stays null', () => {
  // "the caregiver did not answer" is not "the client was unhappy".
  assert.strictEqual(cg.describeVisitLog(LOG_ROW).satisfaction, 'Not satisfied');
  assert.strictEqual(cg.describeVisitLog({ ...LOG_ROW, satisfaction: null }).satisfaction, null);
});

test('describeVisitLog survives a row with nothing on it', () => {
  const d = cg.describeVisitLog({});
  assert.deepStrictEqual(d.tasks, []);
  assert.deepStrictEqual(d.measurements, []);
  assert.strictEqual(d.satisfaction, null);
  assert.doesNotThrow(() => cg.describeVisitLog(null));
});

test('the review screen renders the content and names no task of its own', () => {
  const page = read('public/caregivers.html');

  // A SOURCE SCAN CANNOT PROVE A LINE IS REACHED. A first version of this
  // matched `v.detail` anywhere in the file, so wrapping the render in
  // `{false && ...}` left it green. What it CAN pin is that the render is
  // gated on the toggle's own state rather than on a constant, and that the
  // toggle sets that state — which is the mutation that would actually
  // reintroduce the bug. Driving the component in a browser is the stronger
  // check and is not run in this pass; the data side above is covered by
  // behaviour tests against describeVisitLog.
  assert.ok(/\{showAll && <DetailSections d=\{v\.detail\} \/>\}/.test(page),
    'the content should render when the row is expanded, gated on showAll');
  assert.ok(/setShowAll\(!showAll\)/.test(page), 'the toggle should flip showAll');
  assert.ok(/Read the visit/.test(page), 'there should be a way to open the content');
  // The catalog lives in one module. A page that restated it would drift from
  // the validator that refuses an answer it did not offer.
  ['bathing', 'bloodPressure', 'report_falls', 'meal_consumption']
    .forEach(id => assert.ok(!page.includes(`'${id}'`) && !page.includes(`"${id}"`),
      `caregivers.html restates the catalog id ${id}`));
});

test('the list route resolves the client NAME, so no uuid is shown', () => {
  const src = read('routes/caregiver.js');
  const i = src.indexOf("router.get('/api/caregiver/visit-logs'");
  const body = src.slice(i, src.indexOf('\n  router.', i + 1));
  assert.ok(/clientName:/.test(body), 'the visit-log list should carry a client name');
});

// ---------------------------------------------------------------------------
// Visit notes, item 2 — the download
// ---------------------------------------------------------------------------

test('a visit log renders as a real PDF carrying what it says', async () => {
  const pdf = require('../pdf-generator');
  const buffer = await pdf.generateVisitLogPDF({
    ...LOG_ROW,
    clientName: 'Juanita Guess',
    caregiverName: 'Ada Nwosu',
    visitDate: '2026-10-03',
    submittedAt: LOG_ROW.submitted_at,
    status: 'submitted',
    detail: cg.describeVisitLog(LOG_ROW),
    reviews: [{ byName: 'Bethel Godwins', at: '2026-10-04T14:00:00.000Z', note: 'Reviewed, no concerns.' }]
  });
  assert.ok(Buffer.isBuffer(buffer) && buffer.length > 1000, 'no PDF came back');
  assert.strictEqual(buffer.slice(0, 5).toString(), '%PDF-');
});

test('the visit-log PDF route refuses another caregiver’s log as NOT FOUND', () => {
  // 404, never a 403: a 403 would confirm the log exists and whose it is.
  const src = read('routes/caregiver.js');
  const i = src.indexOf("router.get('/api/caregiver/visit-logs/:id/note.pdf'");
  assert.ok(i > 0, 'the download route is missing');
  const body = src.slice(i, src.indexOf('\n  router.', i + 1));
  assert.ok(/row\.caregiver_id !== u\.id/.test(body), 'the own-row check is missing');
  assert.ok(/VISIT_LOG_NOT_FOUND/.test(body) && !/403/.test(body.split('row.caregiver_id')[1] || ''),
    'a caregiver asking for someone else\u2019s log should get 404, not 403');
  // Every read of a visit log is PHI leaving the building.
  assert.ok(/caregiver_visit_log_downloaded/.test(body), 'the download is not audited');
});

test('the PDF carries nothing that is between the agency and its caregiver', () => {
  // No pay rate, no geofence verdict, no distance — a document that travels
  // should not carry them. Same rule the client-facing shift board follows.
  const src = read('pdf-generator.js');
  const i = src.indexOf('async function generateVisitLogPDF');
  const body = src.slice(i, src.indexOf('\nasync function ', i + 10));
  ['payRate', 'pay_rate', 'geofence', 'grossPay', 'distance']
    .forEach(f => assert.ok(!body.includes(f), `the visit-log PDF carries ${f}`));
});

// ---------------------------------------------------------------------------
// Visit notes, item 3 — managers read the supervision queue
// ---------------------------------------------------------------------------

test('a manager is review staff; a caregiver and a client are not', () => {
  const src = read('routes/caregiver.js');
  const line = src.split('\n').find(l => l.includes('const isReviewStaff ='));
  const impl = src.slice(src.indexOf(line), src.indexOf(';', src.indexOf(line)) + 1);
  assert.ok(/isManager/.test(impl),
    'a manager runs the scheduling board and should read the supervision queue');
  // The four who already had it keep it.
  ['ROLES.ADMIN', 'hasClinicalAccess', 'ROLES.CASE_MANAGER'].forEach(k =>
    assert.ok(impl.includes(k), `${k} lost review access`));
});

test('the two routes that restated the predicate now call it', () => {
  // They were inline copies, so they would NOT have picked up the manager —
  // exactly the drift the predicate's own comment warns about, and the reason
  // it exists separately from the guard.
  const src = read('routes/caregiver.js');
  const restated = src.split('\n').filter(l =>
    /const (staff|isStaff) =/.test(l) && /ROLES\.ADMIN/.test(l));
  assert.deepStrictEqual(restated, [],
    'a route still restates the review-staff rule instead of calling isReviewStaff()');
  assert.ok((src.match(/= isReviewStaff\(u\)/g) || []).length >= 3,
    'the inline-guarded routes should resolve the audience through the shared predicate');
});

// ---------------------------------------------------------------------------
// The spreadsheet, end to end over HTTP
// ---------------------------------------------------------------------------
// The guards above prove the routes CALL the formatters. This proves what
// actually lands in the cell, by reading the response body — the rule this
// repo keeps relearning: assert the stored or returned value, never the
// status code.

const express = require('express');

test('payroll.csv emits Eastern dates and 12-hour times in its cells', async () => {
  // A 9pm Saturday visit that runs to 2am Sunday: the one shape where UTC and
  // Georgia disagree, and where the end crosses midnight.
  const store = {
    time_logs: [{
      id: 'l1', shift_id: 's1', caregiver_id: 'cg1', client_id: 'c1',
      caregiver_name: 'Ada Nwosu', client_name: 'Juanita Guess', license_level: 'cna',
      scheduled_start: NIGHT_IN, scheduled_end: NIGHT_OUT,
      clock_in_at: NIGHT_IN, clock_out_at: NIGHT_OUT,
      total_minutes: 300, flags: []
    }],
    shifts: [{ id: 's1' }]
  };
  const db = { get: async (k) => store[k] || [], set: async (k, v) => { store[k] = v; } };
  const router = require('../routes/scheduling')({
    db, config: require('../config'),
    logActivity: async () => {}, queueNotification: async () => {},
    getUsers: async () => [{ id: 'a1', role: 'admin', name: 'GFC Admin' }],
    invalidateUsersCache: () => {},
    authenticateToken: (req, _res, next) => { req.user = { id: 'a1', role: 'admin', name: 'GFC Admin' }; next(); },
    uuidv4: () => 'x'
  });
  const app = express();
  app.use(express.json());
  app.use(router);
  const server = app.listen(0);
  try {
    const port = server.address().port;
    // Oct 3 is the Georgia date. The old UTC-date filter called this Oct 4 and
    // would have returned NO ROWS for this range at all.
    const res = await fetch(`http://127.0.0.1:${port}/api/scheduling/payroll.csv?from=2026-10-01&to=2026-10-03`);
    assert.strictEqual(res.status, 200);
    const csv = await res.text();
    const lines = csv.trim().split('\r\n');
    assert.strictEqual(lines.length, 2, `expected a header and one row, got:\n${csv}`);

    const header = lines[0].split(',');
    const cells = lines[1].split(',');
    const cell = (name) => cells[header.indexOf(name)];

    assert.strictEqual(cell('Shift Date'), '10/3/2026');
    assert.strictEqual(cell('Clock In'), '9:00 PM');
    assert.strictEqual(cell('Clock Out'), '10/4 2:00 AM');
    assert.strictEqual(cell('Scheduled Start'), '9:00 PM');
    // 9pm to 2am is five hours. Asserted so this test cannot pass on an empty
    // or mis-ranged row; the Hours column's own format is not this change's.
    assert.strictEqual(Number(cell('Hours')), 5);

    // Nothing that reads as a machine timestamp survived into the sheet.
    assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(csv), `an ISO instant reached a cell:\n${csv}`);
    assert.ok(!csv.includes('Z,') && !csv.includes('.000'), `a raw instant reached a cell:\n${csv}`);

    // And the pay period came from the Georgia date.
    assert.ok(cell('Pay Period Start') <= '2026-10-03' && cell('Pay Period End') >= '2026-10-03');
  } finally {
    server.close();
  }
});

test('an open shift leaves Clock Out blank rather than guessing', async () => {
  const store = {
    time_logs: [{
      id: 'l1', shift_id: 's1', caregiver_id: 'cg1', client_id: 'c1',
      caregiver_name: 'Ada Nwosu', client_name: 'Juanita Guess',
      scheduled_start: DAY_IN, scheduled_end: null,
      clock_in_at: DAY_IN, clock_out_at: null, total_minutes: null, flags: []
    }],
    shifts: []
  };
  const db = { get: async (k) => store[k] || [], set: async (k, v) => { store[k] = v; } };
  const router = require('../routes/scheduling')({
    db, config: require('../config'),
    logActivity: async () => {}, queueNotification: async () => {},
    getUsers: async () => [{ id: 'a1', role: 'admin', name: 'GFC Admin' }],
    invalidateUsersCache: () => {},
    authenticateToken: (req, _res, next) => { req.user = { id: 'a1', role: 'admin', name: 'GFC Admin' }; next(); },
    uuidv4: () => 'x'
  });
  const app = express();
  app.use(express.json());
  app.use(router);
  const server = app.listen(0);
  try {
    const port = server.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/api/scheduling/payroll.csv?from=2026-10-01&to=2026-10-31`);
    const lines = (await res.text()).trim().split('\r\n');
    const header = lines[0].split(',');
    const cells = lines[1].split(',');
    // Empty, never "12:00 AM" and never the epoch.
    assert.strictEqual(cells[header.indexOf('Clock Out')], '');
    assert.strictEqual(cells[header.indexOf('Scheduled End')], '');
  } finally {
    server.close();
  }
});
