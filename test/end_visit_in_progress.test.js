// The office ends — or adjusts — a visit that is UNDER WAY.
//
// Owner request, 2026-10-22: "give admin and manager the option of deleting
// shifts or adjusting shifts that are in progress for caregivers."
//
// Adjusting already worked. REMOVING was refused (409 SHIFT_IN_PROGRESS on both
// the single and the bulk door) and the board rendered no control for it at all.
//
// ⚠️ THE RISK IN THIS CHANGE IS A TIME LOG, NOT A STATUS. Clock-out requires
// `status === 'in_progress'`, so cancelling the shift without closing its open
// log leaves the caregiver unable to clock out for ever, the log without a
// `total_minutes`, and their worked hours out of payroll. Every test below
// exists because of that.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const sched = require('../schedulingRepository');
const T = require('../public/gfc-time.js');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// A source scan that cannot tell live code from prose ABOUT that code proves
// nothing — the house rule, bought five times in this repo.
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

const MIN = 60 * 1000;
const iso = (msFromNow) => new Date(Date.now() + msFromNow).toISOString();

test('in_progress -> cancelled is a legal transition now', () => {
  assert.ok(sched.canTransitionShift('in_progress', 'cancelled'),
    'the office must be able to take a visit under way off the board');
  // Clocking out is still how a caregiver finishes one.
  assert.ok(sched.canTransitionShift('in_progress', 'completed'));
});

test('the in-progress refusal no longer claims clocking out is the only way', () => {
  // This sentence is literally what the owner was reading. A cancel is legal
  // now, so the message must not still say it is impossible.
  const refusal = sched.transitionRefusal('in_progress', 'open');
  assert.equal(refusal.code, 'SHIFT_IN_PROGRESS');
  assert.match(refusal.message, /ended by the office/i,
    'the refusal must name the office route that now exists');

  // And cancelling is not refused at all.
  assert.equal(sched.transitionRefusal('in_progress', 'cancelled'), null);
});

test('a completed shift is still refused, with its own wording', () => {
  const refusal = sched.transitionRefusal('completed', 'cancelled');
  assert.equal(refusal.code, 'SHIFT_COMPLETED');
  assert.ok(!sched.canTransitionShift('completed', 'cancelled'));
});

test('closeOfficeEndedLog keeps the hours worked', () => {
  const inAt = iso(-95 * MIN);
  const closed = sched.closeOfficeEndedLog(
    { clock_in_at: inAt, clock_out_at: null, total_minutes: null, flags: [] },
    { at: iso(0), reason: 'Client hospitalised', byId: 'mgr', byName: 'Office Manager', documented: false }
  );
  assert.ok(closed.clock_out_at, 'the clock must be stopped or the log is orphaned');
  assert.ok(closed.total_minutes >= 94 && closed.total_minutes <= 96,
    `hours worked must survive, got ${closed.total_minutes}`);
});

test('closeOfficeEndedLog never awards early_clock_out', () => {
  // The caregiver did not leave early. Somebody at the office stopped their
  // clock, and awarding this is a mark on their record they did not earn.
  const closed = sched.closeOfficeEndedLog(
    { clock_in_at: iso(-60 * MIN), flags: ['late_clock_in', 'early_clock_out'] },
    { at: iso(0), reason: 'x', documented: true }
  );
  assert.ok(!closed.flags.includes('early_clock_out'));
  assert.ok(closed.flags.includes('late_clock_in'),
    'a flag they DID earn is kept — this strips one flag, not the row');
});

test('closeOfficeEndedLog marks it as the office stopping the clock, with provenance', () => {
  const closed = sched.closeOfficeEndedLog(
    { clock_in_at: iso(-30 * MIN), flags: [] },
    { at: iso(0), reason: 'Caregiver sent home unwell', byId: 'mgr', byName: 'Office Manager', documented: true }
  );
  // Payroll reads this row, not the shift, and "the caregiver went home" and
  // "the office called the visit off" are different facts about who decided.
  assert.ok(closed.flags.includes('ended_by_office'));
  assert.equal(closed.ended_by_office, true);
  assert.equal(closed.ended_by_office_name, 'Office Manager');
  assert.equal(closed.ended_by_office_id, 'mgr');
  assert.equal(closed.ended_by_office_reason, 'Caregiver sent home unwell');
  assert.ok(closed.ended_by_office_at);
});

test('an undocumented visit the office ended is flagged for supervision', () => {
  const undoc = sched.closeOfficeEndedLog({ clock_in_at: iso(-30 * MIN), flags: [] },
    { at: iso(0), reason: 'x', documented: false });
  assert.ok(undoc.flags.includes('no_visit_log'),
    'the office is never blocked by a visit log, but an undocumented visit must not vanish quietly');

  const doc = sched.closeOfficeEndedLog({ clock_in_at: iso(-30 * MIN), flags: [] },
    { at: iso(0), reason: 'x', documented: true });
  assert.ok(!doc.flags.includes('no_visit_log'));
});

test('closeOfficeEndedLog invents no clock-out location', () => {
  // Nobody was standing anywhere when an administrator pressed a button.
  const closed = sched.closeOfficeEndedLog({ clock_in_at: iso(-30 * MIN), flags: [] },
    { at: iso(0), reason: 'x', documented: true });
  assert.equal(closed.clock_out_gps, null);
  assert.equal(closed.clock_out_geofence.verdict, 'unverifiable');
});

test('closeOfficeEndedLog is idempotent in its flags', () => {
  const once = sched.closeOfficeEndedLog({ clock_in_at: iso(-30 * MIN), flags: [] },
    { at: iso(0), reason: 'x', documented: false });
  const twice = sched.closeOfficeEndedLog({ clock_in_at: iso(-30 * MIN), flags: once.flags },
    { at: iso(0), reason: 'x', documented: false });
  assert.equal(twice.flags.filter(f => f === 'ended_by_office').length, 1);
  assert.equal(twice.flags.filter(f => f === 'no_visit_log').length, 1);
});

test('rederiveScheduleFlags does not put early_clock_out back on an office-ended log', () => {
  // A SCHEDULE CORRECTION IS EXACTLY WHEN THIS WOULD HAPPEN: adjusting the
  // shift re-derives these flags, which would quietly restore the mark
  // closeOfficeEndedLog removed.
  const start = iso(-120 * MIN);
  const end = iso(120 * MIN);
  const base = { clock_in_at: start, clock_out_at: iso(0) };

  const office = sched.rederiveScheduleFlags(
    { ...base, ended_by_office: true, flags: ['ended_by_office'] }, { start, end });
  assert.ok(!office.includes('early_clock_out'), JSON.stringify(office));
  assert.ok(office.includes('ended_by_office'), 'the non-derived flag is preserved');

  // CONTROL — without this the test above could pass for the wrong reason.
  const normal = sched.rederiveScheduleFlags({ ...base, flags: [] }, { start, end });
  assert.ok(normal.includes('early_clock_out'),
    'a genuine early clock-out must still earn the flag');
});

test('an in-progress shift can never be hard-deleted', () => {
  // isNeverHeld is what decides delete vs tombstone, and it requires `open`.
  // A visit somebody actually worked always leaves a record.
  const live = {
    id: 's1', status: 'in_progress', caregiver_id: 'cg1',
    claimed_at: iso(-90 * MIN), started_at: iso(-60 * MIN)
  };
  assert.equal(sched.isNeverHeld(live, []), false);
  assert.equal(sched.isNeverHeld(live, [{ shift_id: 's1' }]), false);

  // isNeverHeld guards this in three redundant layers. Each is pinned on its
  // own, because a mutation of any ONE of them is invisible while the others
  // hold — and "it is covered by the line above" is how the load-bearing one
  // gets removed by a later simplification.
  assert.equal(sched.isNeverHeld({ id: 's2', status: 'in_progress' }, []), false,
    'the status layer');
  assert.equal(sched.isNeverHeld({ id: 's3', status: 'open', confirmed_at: iso(-60 * MIN) }, []), false,
    'the held-markers layer');
  assert.equal(sched.isNeverHeld({ id: 's4', status: 'open', started_at: iso(-60 * MIN) }, []), false,
    'the worked-markers layer — somebody clocked in on it, however odd the status looks');
  assert.equal(sched.isNeverHeld({ id: 's5', status: 'open' }, [{ shift_id: 's5' }]), false,
    'the time-log layer');

  // CONTROL: a genuinely untouched pool shift IS deletable, or the above
  // would pass for a function that always says false.
  assert.equal(sched.isNeverHeld({ id: 's6', status: 'open' }, []), true);
});

test('the new time-log flags are declared, so nothing writes an unknown flag', () => {
  assert.ok(sched.TIME_LOG_FLAGS.includes('ended_by_office'));
  assert.ok(sched.TIME_LOG_FLAGS.includes('no_visit_log'));
});

// ---- Build enforcement ----------------------------------------------------

test('ONE WRITER closes an office-ended clock, shared by both doors', () => {
  const src = stripComments(read('routes/scheduling.js'));

  // Exactly one definition of the writer.
  const defs = (src.match(/const endOfficeVisit = async/g) || []).length;
  assert.equal(defs, 1, 'two copies of this rule is how one door starts losing hours the other keeps');

  // And exactly one place that calls the pure closer, inside that writer.
  const closers = (src.match(/sched\.closeOfficeEndedLog\(/g) || []).length;
  assert.equal(closers, 1, 'the log close must not be restated at a call site');

  // Both doors go through it — asserted PER ROUTE, so losing the call from one
  // of them cannot be covered by the other still having it.
  //
  // Both call sites are legitimately guarded (`if (wasInProgress)`), so there is
  // nothing unconditional to anchor on here, and A SOURCE SCAN CANNOT PROVE A
  // CALL IS REACHED. What proves that is `scripts/verify_end_visit.js`, which
  // drives both doors over real HTTP and reads the closed log back. This guard
  // only pins that neither door quietly stops calling the shared writer — so it
  // also checks each call's guard is derived from the in-progress check rather
  // than from something that could be false always.
  const routeBlock = (marker) => {
    const i = src.indexOf(marker);
    assert.ok(i > 0, `${marker} not found`);
    return src.slice(i, i + 4200);
  };
  for (const marker of [
    "router.post('/api/scheduling/shifts/:id/cancel'",
    "router.post('/api/scheduling/shifts/bulk-remove'"
  ]) {
    const block = routeBlock(marker);
    assert.ok(block.includes('await endOfficeVisit({'), `${marker} must call the shared writer`);
    assert.ok(/wasInProgress/.test(block) && block.includes("=== 'in_progress'"),
      `${marker} must decide from the shift's own status`);
  }
});

test('the single cancel reads the status BEFORE the transition overwrites it', () => {
  const src = stripComments(read('routes/scheduling.js'));
  const i = src.indexOf("router.post('/api/scheduling/shifts/:id/cancel'");
  assert.ok(i > 0);
  const block = src.slice(i, i + 2500);
  const peek = block.indexOf("=== 'in_progress'");
  const move = block.indexOf("moveShift({ shiftId: req.params.id, to: 'cancelled'");
  assert.ok(peek > 0 && move > 0, 'both sites must be in this route');
  assert.ok(peek < move,
    'moveShift has already overwritten the status by the time it returns, so whether a clock needs stopping must be read first');
});

test('the visit-log gate is a caregiver rule, never applied to the office', () => {
  const src = stripComments(read('routes/scheduling.js'));
  // The refusal belongs to clock-out alone. The office is never blocked by
  // documentation somebody else may never file.
  const refusals = (src.match(/VISIT_LOG_REQUIRED/g) || []).length;
  assert.equal(refusals, 1, 'only the caregiver clock-out may refuse over a visit log');

  const i = src.indexOf('const endOfficeVisit = async');
  const writer = src.slice(i, src.indexOf('const notifyOfficeEnded'));
  assert.ok(!writer.includes('VISIT_LOG_REQUIRED'),
    'the office writer must not refuse over documentation');
  assert.ok(writer.includes('documented'),
    'it must still RECORD whether the visit was documented');
});

test('ending a visit is behind the manager gate, not the caregiver gate', () => {
  const src = stripComments(read('routes/scheduling.js'));
  const i = src.indexOf("router.post('/api/scheduling/shifts/:id/cancel'");
  const line = src.slice(i, i + 220);
  assert.ok(line.includes('requireScheduleManager'),
    'admin or manager — a caregiver cannot end their own visit this way');

  const b = src.indexOf("router.post('/api/scheduling/shifts/bulk-remove'");
  assert.ok(src.slice(b, b + 220).includes('requireScheduleManager'));
});

test('the caregiver is told, and told their hours are kept', () => {
  const src = stripComments(read('routes/scheduling.js'));
  const i = src.indexOf('const notifyOfficeEnded');
  assert.ok(i > 0, 'the notifier must exist — the caregiver is standing in the client\'s home');
  const notifier = src.slice(i, i + 1600);
  assert.match(notifier, /will be paid|hours are recorded/i,
    'the hours are the first thing anybody worries about');
  assert.match(notifier, /do not need to clock out/i,
    'otherwise they stand there trying to clock out of a cancelled shift');
  assert.ok(notifier.includes('links.shiftFor()'),
    'the destination comes from appLinks, never a literal');
});

test('the board offers the control, and calls it ending a visit rather than cancelling a shift', () => {
  const src = read('public/scheduling.html');
  // Before this change the gate was ['open','claimed','assigned','confirmed'],
  // so an in-progress shift had no cancel control at all.
  assert.ok(src.includes("s.status === 'in_progress' && ("),
    'the board must render a control for a visit under way');
  assert.ok(src.includes('End Visit'),
    '"Cancel Shift" reads as taking a FUTURE visit off the board, which is a different decision');
  assert.match(src, /Ending the visit clocks them\s*out now, keeps the hours/,
    'the screen must say what actually happens to their hours');
  assert.ok(src.includes('required to end this visit'),
    'a reason is required, and the placeholder must say so for this case too');
});

// ---- A stale clock is not hours worked ------------------------------------
// Owner report, 2026-10-22: "the payroll export ... reflecting days incorrectly
// such as the 10/12 shift for our caregiver showing as a 10/14 shift."
//
// The export's date handling was right; the DATA was wrong. A caregiver clocked
// in on 10/12 and never clocked out; the office ended the visit on 10/14, and
// the first version of closeOfficeEndedLog measured the hours to the moment the
// office pressed the button — 49.25 hours on a four-hour shift, with the row's
// Clock Out reading 10/14 against a 10/12 Shift Date.

test('the office ending a visit UNDER WAY still records the real hours', () => {
  const closed = sched.closeOfficeEndedLog(
    { clock_in_at: iso(-120 * MIN), scheduled_end: iso(120 * MIN), flags: [] },
    { at: iso(0), reason: 'Client taken to hospital', documented: true }
  );
  assert.ok(closed.total_minutes >= 119 && closed.total_minutes <= 121,
    `the normal case must keep paying the hours, got ${closed.total_minutes}`);
  assert.ok(!closed.flags.includes('hours_need_review'));
});

test('a visit ended a little past its scheduled end still pays', () => {
  // Running over is ordinary. Only a clock nobody stopped is in doubt.
  const closed = sched.closeOfficeEndedLog(
    { clock_in_at: iso(-5 * 60 * MIN), scheduled_end: iso(-30 * MIN), flags: [] },
    { at: iso(0), reason: 'x', documented: true }
  );
  assert.ok(closed.total_minutes > 0, 'a 30-minute overrun is not a stale clock');
  assert.ok(!closed.flags.includes('hours_need_review'));
});

test('⚠️ a clock still running long after the visit ended pays NOBODY days of hours', () => {
  // The reported case, to the hour.
  const clockIn = T.instantFromZoned('2026-10-12', '09:00');
  const schedEnd = T.instantFromZoned('2026-10-12', '13:00');
  const officeEnds = T.instantFromZoned('2026-10-14', '10:15');
  const closed = sched.closeOfficeEndedLog(
    { clock_in_at: clockIn, scheduled_end: schedEnd, clock_out_at: null, total_minutes: null, flags: [] },
    { at: officeEnds, reason: 'Caregiver never clocked out', documented: false }
  );
  assert.equal(closed.total_minutes, null,
    'nobody knows when they left, so the row carries NO total — a blank asks payroll a question');
  assert.ok(closed.flags.includes('hours_need_review'));
  // The clock is still STOPPED, or the caregiver is stranded in progress.
  assert.equal(closed.clock_out_at, officeEnds);
  // And the hours they did work are not asserted as zero either.
  assert.notEqual(closed.total_minutes, 0);
});

test('with no schedule to measure against, only an implausible clock is stale', () => {
  // ⚠️ THE EPOCH TRAP: `new Date(null)` is 1970 and IS finite, so an unguarded
  // version measured a schedule-less log against 1970 and called three hours
  // stale — dropping the hours of a visit nobody did anything wrong on.
  const ok3h = sched.closeOfficeEndedLog(
    { clock_in_at: iso(-3 * 60 * MIN), scheduled_end: null, flags: [] },
    { at: iso(0), reason: 'x', documented: true }
  );
  assert.ok(ok3h.total_minutes >= 179 && ok3h.total_minutes <= 181,
    `three hours with no schedule must still pay, got ${ok3h.total_minutes}`);
  assert.ok(!ok3h.flags.includes('hours_need_review'));

  for (const missing of [null, undefined, '']) {
    const r = sched.closeOfficeEndedLog(
      { clock_in_at: iso(-3 * 60 * MIN), scheduled_end: missing, flags: [] },
      { at: iso(0), reason: 'x', documented: true });
    assert.ok(r.total_minutes > 0, `scheduled_end ${JSON.stringify(missing)} must not read as 1970`);
  }

  const stale = sched.closeOfficeEndedLog(
    { clock_in_at: iso(-49 * 60 * MIN), scheduled_end: null, flags: [] },
    { at: iso(0), reason: 'x', documented: true }
  );
  assert.equal(stale.total_minutes, null, '49 hours on one clock is a clock nobody stopped');
  assert.ok(stale.flags.includes('hours_need_review'));
});

test('isStaleClock reads the window from one declared constant', () => {
  const end = iso(0);
  const inAt = iso(-4 * 60 * MIN);
  const within = new Date(Date.parse(end) + (sched.STALE_CLOCK_AFTER_MINUTES - 1) * MIN).toISOString();
  const past = new Date(Date.parse(end) + (sched.STALE_CLOCK_AFTER_MINUTES + 1) * MIN).toISOString();
  assert.equal(sched.isStaleClock({ clock_in_at: inAt, scheduled_end: end }, within, 100), false);
  assert.equal(sched.isStaleClock({ clock_in_at: inAt, scheduled_end: end }, past, 100), true);
  assert.ok(sched.STALE_CLOCK_AFTER_MINUTES > 0 && sched.MAX_PLAUSIBLE_SHIFT_MINUTES > 0);
});

test('the review flag is declared, so nothing writes an unknown flag', () => {
  assert.ok(sched.TIME_LOG_FLAGS.includes('hours_need_review'));
});

test('payroll prints a blank for hours it cannot work out, never a number', () => {
  // The payroll CSV computes gross from hours; a null total must reach it as a
  // blank cell, because a zero is an answer and the wrong one.
  const closed = sched.closeOfficeEndedLog(
    { clock_in_at: iso(-49 * 60 * MIN), scheduled_end: iso(-45 * 60 * MIN), flags: [] },
    { at: iso(0), reason: 'x', documented: true }
  );
  assert.equal(sched.minutesToHours(closed.total_minutes), null,
    'minutesToHours must carry the blank through to the CSV, not coerce it to 0');
});
