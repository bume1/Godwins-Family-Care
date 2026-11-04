// ============================================================================
// GODWINS FAMILY CARE — Veterans for independent medical exams (owner, 2026-10-30)
//
// The vendor gives us each veteran's first name, last name and date of birth.
// Staff (or the provider) put them on the roster for an exam day and assign a
// provider. When the veteran signs in on the clinic iPad (/veterans) with
// name, date of birth and phone, the sign-in is matched to the roster and the
// assigned provider is told by email and text.
//
// Rules:
//  - Veterans have no account and no portal. A roster row is not a user.
//  - A sign-in only matches veterans expected TODAY (Georgia's date).
//  - A match never guesses: two possible veterans is "ambiguous" and goes to
//    the office, the same as no match at all.
//  - An admin or manager manages every row. A provider manages only the rows
//    assigned to them, and can only assign new rows to themselves.
// ============================================================================
'use strict';

// Calendar-date arithmetic is the shared clock's, not ours: a second copy of
// "the day after" is a second thing to get wrong at a clock change.
const gfcTime = require('./public/gfc-time');

const STATUSES = Object.freeze(['expected', 'arrived', 'seen', 'no_show']);
const STATUS_LABELS = Object.freeze({ expected: 'Expected', arrived: 'Arrived', seen: 'Seen', no_show: 'No show' });
// A provider marks these by hand. "arrived" only ever comes from a sign-in.
const SETTABLE_STATUSES = Object.freeze(['expected', 'seen', 'no_show']);
const SITES = Object.freeze({ savannah: 'Savannah clinic' });
const DEFAULT_SITE = 'savannah';
const NAME_MAX = 60;

// Same folding as the patient-link guard (clinicalRepository normNamePart):
// case, accents and punctuation do not decide whether two names match.
const foldName = (s) => String(s == null ? '' : s)
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9]/g, '');

const cleanName = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);

// A real calendar date as YYYY-MM-DD, or '' — "2026-02-30" is not a date.
function isoDate(s) {
  const t = String(s == null ? '' : s).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (!m) return '';
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] ? t : '';
}

// ── A time slot on an exam (owner, 2026-11-04) ─────────────────────────────
// OPTIONAL, AND OPTIONAL FOR GOOD. Every row already on the roster has no time
// and is still a real booking; a clinic that runs an exam day first-come has
// nothing to type. So an untimed row is valid, sorts after the timed ones, and
// is never shown a made-up time.
//
// ⚠️ A TIME NEVER NARROWS THE SIGN-IN MATCH. `candidatesFor` and `matchCheckin`
// are keyed on the DAY and must stay that way: a veteran arrives early, arrives
// late, and arrives at the wrong hour entirely, and every one of them is the
// person we are expecting. Matching on the slot would turn an ordinary early
// arrival into "we don't have you down", at an iPad, with nobody to ask.
// Build-enforced in test/veteran_roster.test.js.
const MAX_EXAM_MINUTES = 8 * 60;

// 'HH:MM' on a 24-hour clock, or ''. No seconds: nobody books an exam at 9:00:30.
function isoTime(s) {
  const t = String(s == null ? '' : s).trim();
  const m = /^(\d{2}):(\d{2})$/.exec(t);
  if (!m) return '';
  return (+m[1] <= 23 && +m[2] <= 59) ? t : '';
}
const minutesOfDay = (hhmm) => { const t = isoTime(hhmm); return t ? (+t.slice(0, 2) * 60 + +t.slice(3)) : null; };

// What an exam OCCUPIES, for the clash check. A row with no length recorded is
// a POINT IN TIME, not a guessed hour: the app cannot know whether a 9:00 exam
// runs past 9:30, and inventing a default here would refuse a real booking on
// the strength of a number nobody entered.
const occupies = (row) => {
  const start = minutesOfDay(row && row.examTime);
  if (start == null) return null;
  const len = Number(row && row.durationMinutes);
  return { start, end: start + (Number.isFinite(len) && len > 0 ? len : 0) };
};
const spansOverlap = (a, b) => {
  if (!a || !b) return false;
  // Two exams booked at the identical minute clash even when neither records a
  // length, which is the commonest double-booking and the one zero-length
  // spans would otherwise let through.
  if (a.start === b.start) return true;
  return a.start < b.end && b.start < a.end;
};

// The exam already in that slot for the same provider on the same day, or null.
// `exceptId` is the row being edited, which must not clash with itself.
function slotClash(rows, row, { exceptId = null } = {}) {
  const want = occupies(row);
  if (!want) return null;
  return (rows || []).find(r => r && !r.removedAt && r.id !== exceptId &&
    r.examDate === row.examDate && String(r.providerUserId) === String(row.providerUserId) &&
    spansOverlap(want, occupies(r))) || null;
}

// Validates what staff or a provider types in. `today` is Georgia's date.
// Returns { value } or { error, fieldErrors }.
function normalizeRosterInput(body, { today } = {}) {
  const b = body || {};
  const firstName = cleanName(b.firstName);
  const lastName = cleanName(b.lastName);
  const dob = isoDate(b.dob);
  const examDate = isoDate(b.examDate);
  const site = b.site && SITES[b.site] ? b.site : DEFAULT_SITE;
  const examTime = isoTime(b.examTime);
  const rawLen = b.durationMinutes;
  const hasLen = rawLen !== undefined && rawLen !== null && String(rawLen).trim() !== '';
  const durationMinutes = hasLen ? Number(rawLen) : null;
  const fieldErrors = {};
  if (!firstName) fieldErrors.firstName = 'First name is required.';
  if (!lastName) fieldErrors.lastName = 'Last name is required.';
  if (!dob) fieldErrors.dob = 'Date of birth is required.';
  else if (today && dob >= today) fieldErrors.dob = 'Date of birth must be in the past.';
  else if (dob < '1900-01-01') fieldErrors.dob = 'Date of birth looks wrong.';
  if (!examDate) fieldErrors.examDate = 'Exam date is required.';
  // A time is optional; a time that was TYPED and is not a time is a slip, and
  // dropping it silently would book the exam at no time at all.
  if (b.examTime !== undefined && b.examTime !== null && String(b.examTime).trim() !== '' && !examTime) {
    fieldErrors.examTime = 'Use a 24-hour time like 09:30.';
  }
  if (hasLen) {
    if (!Number.isFinite(durationMinutes) || !Number.isInteger(durationMinutes) || durationMinutes <= 0) {
      fieldErrors.durationMinutes = 'Length must be a whole number of minutes.';
    } else if (durationMinutes > MAX_EXAM_MINUTES) {
      fieldErrors.durationMinutes = `Length cannot be more than ${MAX_EXAM_MINUTES / 60} hours.`;
    } else if (!examTime) {
      // Refused BY NAME rather than ignored: a length with no start is a half
      // -filled slot, and storing it would show a length the day cannot place.
      fieldErrors.durationMinutes = 'Add a start time before a length.';
    }
  }
  if (Object.keys(fieldErrors).length) return { error: 'Please check the highlighted fields.', code: 'VETERAN_INVALID', fieldErrors };
  return { value: { firstName, lastName, dob, examDate, site, examTime: examTime || null,
    durationMinutes: (examTime && Number.isFinite(durationMinutes) && durationMinutes > 0) ? durationMinutes : null } };
}

// Who may do what. `isOffice` = admin or manager.
const isOffice = (u) => !!u && (u.role === 'admin' || u.isManager === true);
function canEditRow(actor, row, { isProvider } = {}) {
  if (!actor || !row) return false;
  if (isOffice(actor)) return true;
  return !!isProvider && row.providerUserId === actor.id;
}

// The rows a sign-in can match: today's, still waiting, not removed.
function candidatesFor(rows, today) {
  return (rows || []).filter(r => r && !r.removedAt && r.examDate === today &&
    (r.status === 'expected' || r.status === 'arrived'));
}

// { state: 'matched' | 'unmatched' | 'ambiguous', row, candidates }
// First + last + DOB first; then last + DOB alone (a nickname: "Jim" for
// "James"), but only when exactly one veteran fits. Never a guess.
function matchCheckin(rows, checkin, today) {
  const pool = candidatesFor(rows, today);
  const dob = isoDate(checkin && checkin.dob);
  const first = foldName(checkin && checkin.firstName);
  const last = foldName(checkin && checkin.lastName);
  if (!dob || !last) return { state: 'unmatched', row: null, candidates: [] };
  const sameLastDob = pool.filter(r => foldName(r.lastName) === last && r.dob === dob);
  const exact = sameLastDob.filter(r => foldName(r.firstName) === first);
  const pick = exact.length ? exact : sameLastDob;
  if (pick.length === 1) return { state: 'matched', row: pick[0], candidates: pick };
  if (pick.length > 1) return { state: 'ambiguous', row: null, candidates: pick };
  return { state: 'unmatched', row: null, candidates: [] };
}

// ── the window a roster read covers ─────────────────────────────────────────
// A READ IS A WINDOW, and a single day is the degenerate case where both ends
// are the same date. The exam-day screen and the forward schedule therefore
// share ONE filter rather than two that drift the first time one of them
// learns about removed rows and the other does not.
//
// Uncapped, a range is a way to pull the whole roster in one request, so the
// window is clamped and SAYS when it was clamped. A quarter is longer than any
// exam schedule anybody plans from.
const RANGE_MAX_DAYS = 92;
// What the forward view asks for when nobody has picked a window.
const RANGE_DEFAULT_DAYS = 28;

// { from, to, capped }. NO PARAMETERS AT ALL MEANS TODAY ONLY, which is what
// the exam-day screen asks for and must keep getting.
function rosterRange(query, today) {
  const q = query || {};
  const day = isoDate(q.date);
  const from = isoDate(q.from) || day || isoDate(today) || '';
  if (!from) return { from: '', to: '', capped: false };
  let to = isoDate(q.to) || day || from;
  // An inverted window is a slip in whatever asked for it. One day is a
  // predictable answer; swapping the ends would hand back a window nobody
  // asked for and look like it worked.
  if (to < from) to = from;
  const ceiling = gfcTime.addDays(from, RANGE_MAX_DAYS);
  const capped = to > ceiling;
  return { from, to: capped ? ceiling : to, capped };
}

// The rows inside a window. `providerUserId` narrows to one provider's list;
// null is the office's view of everybody. BOTH filters live here together on
// purpose — the date filter and the who-may-see-it filter split across two
// files is how a later caller surfaces one provider's veterans to another.
// Oldest day first, then site, then surname: the order a person reads a
// schedule in. A removed row never appears.
// `providerUserIds` is the same question asked of several ids at once, which is
// what My Day needs: an OpenEMR provider id can stand for more than one app
// user. It NORMALIZES into the one filter rather than adding a second — and an
// EMPTY array means NOBODY, never everybody, because the tempting bug is a
// narrowed scope falling through to the whole roster.
function rowsInRange(rows, range, { providerUserId = null, providerUserIds = null } = {}) {
  const { from, to } = range || {};
  if (!from || !to) return [];
  const scope = providerUserIds != null
    ? new Set((providerUserIds || []).map(String))
    : (providerUserId !== null ? new Set([String(providerUserId)]) : null);
  return (rows || [])
    .filter(r => r && !r.removedAt && r.examDate >= from && r.examDate <= to &&
      (scope === null || scope.has(String(r.providerUserId))))
    // Day, then TIME, then site, then surname. An untimed exam sorts AFTER the
    // timed ones on its day rather than first: it happens "sometime today", and
    // putting it at the head of a timed list reads as the 8am appointment.
    .sort((a, b) => (a.examDate || '').localeCompare(b.examDate || '')
      || ((minutesOfDay(a.examTime) ?? Infinity) - (minutesOfDay(b.examTime) ?? Infinity))
      || (a.site || '').localeCompare(b.site || '')
      || (a.lastName || '').localeCompare(b.lastName || ''));
}

// What a list returns: the stored row plus the provider's display name.
function publicRow(row, providerName) {
  return {
    id: row.id, firstName: row.firstName, lastName: row.lastName, dob: row.dob,
    examDate: row.examDate, examTime: row.examTime || null, durationMinutes: row.durationMinutes || null,
    site: row.site, siteLabel: SITES[row.site] || row.site,
    providerUserId: row.providerUserId, providerName: providerName || null,
    status: row.status, statusLabel: STATUS_LABELS[row.status] || row.status,
    arrivedAt: row.arrivedAt || null, checkinId: row.checkinId || null,
    arrivalPhone: row.arrivalPhone || null, arrivalEmail: row.arrivalEmail || null,
    seenAt: row.seenAt || null, createdAt: row.createdAt, createdByName: row.createdByName || null
  };
}

// WHAT MY DAY SHOWS ABOUT A VETERAN, WHICH IS LESS THAN THE ROSTER BOARD DOES.
// An allow-list, not a filtered copy of publicRow: date of birth is the
// identity-matching data the sign-in screen compares against, and the phone and
// email a veteran typed at the iPad are contact details for whoever rings them
// back. A clinician reading their day needs none of the three, so they are not
// put on the wire and then hidden. Build-enforced.
function examDayRow(row, providerName) {
  return {
    id: row.id,
    firstName: row.firstName, lastName: row.lastName,
    examTime: row.examTime || null, durationMinutes: row.durationMinutes || null,
    site: row.site, siteLabel: SITES[row.site] || row.site,
    providerUserId: row.providerUserId, providerName: providerName || null,
    status: row.status, statusLabel: STATUS_LABELS[row.status] || row.status,
    arrivedAt: row.arrivedAt || null, seenAt: row.seenAt || null
  };
}

// The text to the provider carries no name: a text sits on a lock screen.
function providerText(siteLabel) {
  return `Godwins Family Care: a veteran for your exam has signed in at the ${siteLabel || 'clinic'}. Open the GFC app to see who.`;
}
// The confirmation text to the veteran, from the office main line. "Your
// provider has been notified" is only said when a provider was.
function veteranText(matched) {
  return matched
    ? 'Thanks for checking in at Godwins Family Care. Your provider has been notified and will call you shortly.'
    : 'Thanks for checking in at Godwins Family Care. Our team has your details and will call you shortly.';
}
function providerEmailSubject(siteLabel) {
  return `Your veteran has arrived at the ${siteLabel || 'clinic'}`;
}

module.exports = {
  STATUSES, STATUS_LABELS, SETTABLE_STATUSES, SITES, DEFAULT_SITE,
  RANGE_MAX_DAYS, RANGE_DEFAULT_DAYS, MAX_EXAM_MINUTES,
  foldName, isoDate, isoTime, minutesOfDay, occupies, slotClash, rosterRange, rowsInRange,
  normalizeRosterInput, isOffice, canEditRow, examDayRow,
  candidatesFor, matchCheckin, publicRow, providerText, veteranText, providerEmailSubject
};
