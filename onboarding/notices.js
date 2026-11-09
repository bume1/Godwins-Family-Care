// ============================================================================
// WHO HEARS ABOUT ONBOARDING AND CREDENTIALS — pure, no I/O
// ============================================================================
// Owner, 2026-11-09: "make sure email notifications updates accordingly. Esp
// for new employees who need onboarding or credentialing reminders."
//
// Everything this file decides was ALREADY COMPUTED by `track.buildTrack`
// (items waiting on her, returned items, expiring credentials, recurring
// duties, spaced re-checks). None of those rules is restated here: the office
// overview, her own portal and these emails read one set of numbers, which is
// why a rule narrowed in `track.js` or `renewals.js` narrows the email on the
// next sweep. This file only decides WHO is told, WHEN, and WHAT GOES IN ONE
// ENVELOPE.
//
// ---------------------------------------------------------------------------
// Owner decisions, 2026-11-09
// ---------------------------------------------------------------------------
//   * HER NUDGE IS DAILY, AND IT IS ONE EMAIL. A new hire carries dozens of
//     open items; one email per item would be forty emails on a Monday and
//     the next one would be filtered unread. So the daily nudge is a DIGEST:
//     everything waiting on her in one envelope, and her expiring credentials
//     ride in it too rather than arriving as a second email the same morning.
//   * A CREDENTIAL REACHES HER AND THE OFFICE. She renews it; the office
//     verifies it and may have to take her off shifts. A lapsed licence is a
//     stop-work condition, so neither side may be the only one watching.
//   * THE OFFICE GETS A WEEKLY ROLL-UP *AND* AN IMMEDIATE NOTICE WHEN SHE
//     SUBMITS SOMETHING. The roll-up is what has not moved; the submit notice
//     is what can be verified now.
//
// NOTHING HERE IS PHI, and that is a fact about the data rather than a
// convenience: an onboarding item is employment and credentialing data about
// a member of staff, which is what the welcome packet's own collection entry
// already records. So these notices carry their detail on any transport. The
// other side of that coin is enforced rather than trusted: A PATIENT MUST
// NEVER APPEAR IN ONE. An onboarding track knows nothing about clients, and a
// test asserts these notices never reach for one.
// ============================================================================

'use strict';

// 9am Eastern, like the visit reminders and the to-do sweep. One constant.
const DIGEST_SEND_HOUR_ET = 9;
// The office roll-up goes out once a week, on a Monday morning.
const WEEKLY_WEEKDAY = 1;                  // 1 = Monday
// Days before expiry at which the OFFICE is told, plus the day it lapses.
// Her own copy rides the daily digest, so she is not held to these.
const OFFICE_EXPIRY_MILESTONES = Object.freeze([30, 14, 7, 1]);
// A track with items still waiting on her this long after her start date is
// reported to the office as stalled.
const STALLED_DAYS = 14;

const isYmd = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !Number.isNaN(Date.parse(v));
const atNoon = (ymd) => new Date(`${ymd}T12:00:00Z`);
const daysBetween = (from, to) => Math.round((atNoon(to) - atNoon(from)) / 864e5);

// The ISO week a date falls in, as `2026-W46`. Read at midday UTC so no zone
// moves the date across a boundary, and used only as a dedupe key: one
// roll-up per week, whatever day the sweep first runs in it.
function isoWeekOf(ymd) {
  if (!isYmd(ymd)) return null;
  const d = atNoon(ymd);
  const day = (d.getUTCDay() + 6) % 7;                    // Monday = 0
  d.setUTCDate(d.getUTCDate() - day + 3);                  // the week's Thursday
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const fd = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - fd + 3);
  const week = 1 + Math.round((d - firstThursday) / (7 * 864e5));
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

// Georgia's weekday for a date, Monday = 1.
const weekdayOf = (ymd) => (isYmd(ymd) ? ((atNoon(ymd).getUTCDay() + 6) % 7) + 1 : null);

// ---------------------------------------------------------------------------
// Dedupe keys. The queue drops a second notice with the same key, so these
// are what hold "one a day" and "one a week" — never the sweep's cadence,
// which may change, and never a stored sent-flag, which a restart loses.
// ---------------------------------------------------------------------------
const digestKey = (userId, today) => `onbdigest:${userId}:${today}`;
const weeklyKey = (userId, today) => `onbweekly:${userId}:${isoWeekOf(today)}`;
// Keyed on the MILESTONE, not the date: a credential 30 days out is announced
// once at 30 and again at 14, not every morning in between.
const expiryKey = (userId, itemId, milestone) => `onbexpiry:${userId}:${itemId}:${milestone}`;

/**
 * The milestone a credential has just reached, or null between milestones.
 * `0` is the day it lapses and every day after: an expired credential is a
 * stop-work condition, so it is not announced once and then dropped.
 */
function officeMilestone(daysLeft) {
  if (!Number.isFinite(daysLeft)) return null;
  if (daysLeft <= 0) return 0;
  return OFFICE_EXPIRY_MILESTONES.includes(daysLeft) ? daysLeft : null;
}

/**
 * Everything waiting on HER, read off the track the app already builds.
 * `total` is what decides whether an email is sent at all: a digest with
 * nothing in it is never sent, because a daily email that says "nothing to
 * do" is how a daily email stops being read.
 */
function digestFor(track) {
  const items = (track && track.items) || [];
  const renewals = (track && track.renewals) || { items: [], recurring: [] };
  const outstanding = items
    .filter(i => i && i.waitingOnHer && i.status !== 'RETURNED')
    .map(i => ({ id: i.id, title: i.title }));
  // Returned items are listed FIRST and separately: the office has sent one
  // back with a reason, which is the item she can act on today.
  const returned = items
    .filter(i => i && i.status === 'RETURNED')
    .map(i => ({ id: i.id, title: i.title, reason: returnReasonOf(i) }));
  const expiring = (renewals.items || [])
    .filter(x => x && x.expiry && (x.expiry.status === 'EXPIRED' || x.expiry.status === 'SOON'))
    .map(x => ({ id: x.id, what: x.expiry.what || x.title, on: x.expiry.on, daysLeft: x.expiry.daysLeft, expired: x.expiry.status === 'EXPIRED' }))
    .sort((a, b) => (a.daysLeft ?? 0) - (b.daysLeft ?? 0));
  const recurring = (renewals.recurring || [])
    .filter(r => r && (r.status === 'OVERDUE' || r.status === 'SOON'))
    .map(r => ({ id: r.id, requirement: r.requirement, nextDue: r.nextDue, overdue: r.status === 'OVERDUE' }));
  const rechecks = ((track && track.modules) || [])
    .filter(m => m && m.rechecks && m.rechecks.dueNow && m.rechecks.dueNow.length)
    .map(m => ({ id: m.id, title: m.title || m.id, days: m.rechecks.dueNow.slice() }));
  return {
    outstanding, returned, expiring, recurring, rechecks,
    total: outstanding.length + returned.length + expiring.length + recurring.length + rechecks.length
  };
}

// The reason the office gave when it sent a step back. Read from whichever
// step carries it; absent rather than invented when the shape has no reason.
function returnReasonOf(item) {
  const r = item && item.returned;
  if (r && typeof r === 'object' && r.reason) return String(r.reason);
  if (typeof r === 'string' && r) return r;
  const steps = (item && item.steps) || [];
  const withReason = (Array.isArray(steps) ? steps : Object.values(steps)).find(s => s && s.returned && s.returned.reason);
  return withReason ? String(withReason.returned.reason) : null;
}

/**
 * The office's weekly roll-up across everybody: what has not moved.
 * `people` and `notStarted` are the admin overview's own rows, so the roll-up
 * and the screen cannot disagree about a count.
 */
function weeklyFor(people, today, notStarted) {
  const rows = (people || []).filter(Boolean);
  const waitingOnOffice = rows.filter(p => p.waitingOnOffice > 0)
    .map(p => ({ userId: p.userId, name: p.name, count: p.waitingOnOffice }))
    .sort((a, b) => b.count - a.count);
  const expiring = rows.filter(p => p.renewalsDue > 0 || p.expired > 0)
    .map(p => ({ userId: p.userId, name: p.name, due: p.renewalsDue, expired: p.expired }));
  // Stalled: started long enough ago to be moving, and still is not.
  const stalled = rows.filter(p => p.waitingOnHer > 0 && isYmd(p.startDate) && daysBetween(p.startDate, today) >= STALLED_DAYS)
    .map(p => ({ userId: p.userId, name: p.name, count: p.waitingOnHer, since: p.startDate, days: daysBetween(p.startDate, today) }))
    .sort((a, b) => b.days - a.days);
  // Who is on the roster with no track at all. Passed in, because only the
  // caller reads the roster; a field this function always set to zero would
  // be the inert state this repo keeps paying for.
  const notYetStarted = (notStarted || []).map(p => ({ userId: p.userId, name: p.name }));
  return { waitingOnOffice, expiring, stalled, notYetStarted,
    total: waitingOnOffice.length + expiring.length + stalled.length + notYetStarted.length };
}

/**
 * Is it time for the day's sweep? PURE: handed Georgia's hour, so nothing
 * here reads a clock and a test does not have to run in Eastern to mean
 * anything. Before the hour, nothing goes out; after it, the keys above hold
 * each notice to one.
 */
const sendHourReached = (hourEt) => Number.isFinite(hourEt) && hourEt >= DIGEST_SEND_HOUR_ET;
const isWeeklyDay = (today) => weekdayOf(today) === WEEKLY_WEEKDAY;

module.exports = {
  DIGEST_SEND_HOUR_ET, WEEKLY_WEEKDAY, OFFICE_EXPIRY_MILESTONES, STALLED_DAYS,
  isoWeekOf, weekdayOf, daysBetween,
  digestKey, weeklyKey, expiryKey, officeMilestone,
  digestFor, returnReasonOf, weeklyFor,
  sendHourReached, isWeeklyDay
};
