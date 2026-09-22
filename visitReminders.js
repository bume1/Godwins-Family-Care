// visitReminders.js — Session 4.11
//
// A patient gets one email when a clinical visit is booked and nothing after.
// For a home-visit practice a forgotten visit is a wasted drive and a lost slot,
// so this adds the day-before reminder.
//
// ⚠️ THE ARCHITECTURAL CONSTRAINT, AND IT DECIDES THE WHOLE DESIGN. Since
// Session 5.2 OpenEMR access is authorization_code + PKCE **per clinician**: the
// password grant and the service account are gone and there is no
// system-to-system client. **A BACKGROUND JOB CANNOT READ THE OPENEMR
// CALENDAR.** Adding a client_credentials client, a stored clinician token or
// any service identity to get around that would reverse a HIPAA-gate decision,
// and it is explicitly out of scope.
//
// So THE REMINDER IS CAPTURED AT WRITE TIME. When the app books, reschedules or
// cancels a visit it already holds every fact the reminder needs, so the row is
// written then — display strings and all — and the existing notification scanner
// sends it. OpenEMR is never read to send a reminder.
//
// THE CONSEQUENCE, STATED PLAINLY BECAUSE IT IS AN OPERATING RULE RATHER THAN A
// BUG: a visit created or moved DIRECTLY in OpenEMR's calendar, rather than
// through the app, gets no reminder — and a visit moved there after booking
// keeps a reminder for the old time. Clinical visits are booked and changed
// through the app.

'use strict';

const practiceTime = require('./public/gfc-time');

// Owner decision: 9:00 AM Eastern on the calendar day BEFORE the visit. One
// constant, so moving it earlier or later is a one-line edit.
const REMINDER_SEND_HOUR_ET = 9;

// A row found this far past its send time means the server was down over the
// window. It is VOIDED, never sent late: a reminder that arrives after the visit
// is worse than none — it tells somebody to expect a clinician who has already
// been and gone.
const MISSED_WINDOW_HOURS = 12;

const STATUSES = Object.freeze(['scheduled', 'sent', 'void']);
const VOID_REASONS = Object.freeze(['rescheduled', 'cancelled', 'missed_window']);

const clean = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const isYmd = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));

/**
 * The instant the reminder should go out: REMINDER_SEND_HOUR_ET on the calendar
 * day before the visit, in EASTERN.
 *
 * Built through `instantFromZoned` rather than by subtracting 24 hours from the
 * visit: an offset is right today and wrong from November 1, and "the day
 * before at 9 AM" is a calendar statement, not a duration. A Monday visit is
 * reminded Sunday at 9 AM ET whatever the clocks did in between.
 */
const reminderSendAt = (visitDate) => {
  // NOTE, because a later simplification could get this wrong: BOTH guards below
  // are belt-and-braces, and mutation-checking proved it rather than assuming it.
  //
  //   • `isYmd` — a malformed date string produces an invalid Date one line down
  //     and is refused there anyway. This one exists to refuse it by SHAPE rather
  //     than by accident, and to keep `T12:00:00Z` from being appended to
  //     something that is not a date.
  //   • `T12:00:00Z` — midday rather than midnight. For every zone west of UTC,
  //     which includes Eastern in both halves of the year, reading a bare date at
  //     local midnight lands on the same UTC calendar day, so this changes no
  //     outcome today. It is here so the function does not depend on the practice
  //     zone happening to be west of UTC.
  //
  // WHAT ACTUALLY DOES THE WORK is the NaN check and `instantFromZoned` below.
  // Removing either of those changes real behaviour and fails the tests.
  if (!isYmd(visitDate)) return null;
  const d = new Date(`${visitDate}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() - 1);
  const dayBefore = d.toISOString().slice(0, 10);
  return practiceTime.instantFromZoned(dayBefore, `${String(REMINDER_SEND_HOUR_ET).padStart(2, '0')}:00`);
};

/**
 * Build the reminder row, or explain why there is none.
 *
 * Returns { reminder } or { skipped, reason }. A skip is a normal outcome and is
 * reported as one — it is not an error, and the caller must not log it as a
 * failure. (`queueNotification` learned the same lesson: unsubscribing is not a
 * failed send.)
 */
const buildVisitReminder = ({ id, clientId, eid, visitDate, startTime, when, clinician, place, now }) => {
  if (!clientId) return { skipped: true, reason: 'no client' };
  if (!eid) return { skipped: true, reason: 'no appointment id' };
  const sendAt = reminderSendAt(visitDate);
  if (!sendAt) return { skipped: true, reason: `unusable visit date ${visitDate}` };

  // ALREADY PAST → NO REMINDER. Booked yesterday evening for tomorrow morning,
  // or booked the same day: the booking email has just gone out, and a second
  // one minutes later is noise rather than a reminder.
  const at = now ? new Date(now) : new Date();
  if (new Date(sendAt).getTime() <= at.getTime()) {
    return { skipped: true, reason: 'the send time is already past — the booking notice covers it' };
  }

  return {
    reminder: {
      id, clientId, eid: String(eid),
      visitDate: String(visitDate),
      startTime: clean(startTime, 8) || null,
      // SNAPSHOT THE DISPLAY STRINGS. The reminder must not need OpenEMR to
      // render — that is the whole point of capturing at write time, and a
      // reminder that has to re-read the calendar is a reminder no background
      // job can send.
      when: clean(when, 200) || null,
      clinician: clean(clinician, 200) || null,
      place: clean(place, 80) || null,
      sendAt,
      status: 'scheduled',
      voidReason: null,
      createdAt: at.toISOString(),
      sentAt: null
    }
  };
};

// Void every scheduled reminder for an eid. Returns the changed rows so the
// caller writes once. A reschedule voids the OLD eid and creates on the NEW one:
// the tombstone swap CHANGES the eid, so keying the void on the new one would
// leave the old reminder live and send a patient to yesterday's time.
const voidRemindersForEid = (rows, eid, reason, at) => {
  const when = at || new Date().toISOString();
  let voided = 0;
  const next = (Array.isArray(rows) ? rows : []).map(r => {
    if (!r || String(r.eid) !== String(eid) || r.status !== 'scheduled') return r;
    voided += 1;
    return { ...r, status: 'void', voidReason: VOID_REASONS.includes(reason) ? reason : 'cancelled', voidedAt: when };
  });
  return { rows: next, voided };
};

// What the scanner should act on right now. Two lists, because they are two
// different actions and collapsing them is how a stale reminder gets sent.
const dueReminders = (rows, now) => {
  const at = (now ? new Date(now) : new Date()).getTime();
  const cutoff = at - MISSED_WINDOW_HOURS * 3600 * 1000;
  const due = [];
  const missed = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || r.status !== 'scheduled' || !r.sendAt) continue;
    const t = new Date(r.sendAt).getTime();
    if (Number.isNaN(t) || t > at) continue;
    if (t < cutoff) missed.push(r);
    else due.push(r);
  }
  // Oldest first, so a backlog drains in the order the visits happen.
  const bySendAt = (a, b) => String(a.sendAt).localeCompare(String(b.sendAt));
  return { due: due.sort(bySendAt), missed: missed.sort(bySendAt) };
};

// ---- The copy ------------------------------------------------------------
// BOTH FIRST PARAGRAPHS MUST BEGIN WITH THE WORDS "Your visit".
// `sendToClientSide` rewrites /^Your visit/ to "{Name}'s visit" for a POA, so a
// paragraph that starts any other way tells a POA "your visit" about somebody
// else's appointment. That is not a style rule; it is the mechanism.
const reminderCopy = ({ detail, when, orgPhone }) => (detail
  ? {
      subject: `Reminder: your visit tomorrow at ${when}`,
      headline: 'See you tomorrow',
      paragraphs: [
        'Your visit is tomorrow. The details are below and in your portal.',
        `If you need to change it, please call the office at ${orgPhone} as soon as you can.`
      ]
    }
  : {
      subject: 'You have a visit coming up',
      headline: 'See you tomorrow',
      paragraphs: [
        'Your visit is coming up tomorrow. The details are in your secure portal.',
        'For privacy we do not put visit details in email.'
      ]
    });

// ---- Scope B: a "Who" line a patient understands ------------------------
//
// The old formatter rendered `name, licenseLevel` — "Bethel Godwins, FNP" when
// the field was filled, a bare name when it was empty, and never said in plain
// words what the person IS. A patient opening their front door should know a
// nurse practitioner is coming.
//
// NEVER GUESS A ROLE. An unrecognised or blank credential yields the name alone:
// inventing "your physician" for a credential this file does not know would tell
// a patient something untrue about who is treating them, which is worse than
// telling them only a name.
const ROLE_PHRASES = Object.freeze([
  // Order matters: the first match wins, so the more specific patterns come
  // first. PA-C must beat the bare-letter NP patterns, and the NP family has to
  // be recognised in all the shapes a licence actually carries.
  { re: /^(?:PMHNP|AGNP|ANP|FNP|WHNP|NNP|CNP|NP|APRN|ARNP)(?:[-\s]?(?:BC|C|CNS))?$/i, phrase: 'your nurse practitioner' },
  { re: /^(?:MD|DO)$/i, phrase: 'your physician' },
  { re: /^(?:PA|PA-C|PAC)$/i, phrase: 'your physician assistant' },
  { re: /^(?:RN|BSN|RN-BSN|RN,?\s?BSN)$/i, phrase: 'your nurse' },
  { re: /^(?:LCSW|LMSW|MSW|LCSW-C)$/i, phrase: 'your social worker' }
]);
const rolePhraseFor = (credential) => {
  const c = clean(credential, 40).replace(/\s+/g, ' ');
  if (!c) return null;
  for (const { re, phrase } of ROLE_PHRASES) if (re.test(c)) return phrase;
  return null;
};

/**
 * "Bethel Godwins, FNP — your nurse practitioner"
 *
 * ONE formatter, used by booking, reschedule, cancel AND the reminder. Four
 * copies of "how a clinician is described to a patient" is four copies that
 * drift, and the drift is silent: the booking email and the reminder would
 * describe the same person differently.
 *
 * The credential prefers the STRUCTURED `prescriberCredential` that Session 4.10
 * added, and falls back to the free-text `licenseLevel`. Structured first,
 * because free text is what made the old line unreliable.
 */
const visitClinicianLabel = (user) => {
  if (!user) return null;
  const name = clean(user.name, 120);
  if (!name) return null;
  const credential = clean(user.prescriberCredential, 40) || clean(user.licenseLevel || user.credential, 40);
  const phrase = rolePhraseFor(credential);
  const head = credential ? `${name}, ${credential}` : name;
  return phrase ? `${head} — ${phrase}` : head;
};

// B2 — A BLANK CREDENTIAL IS A DATA GAP AND IT SHOULD BE VISIBLE. Any user
// mapped to an OpenEMR provider with no credential on file has their name shown
// to patients with no title at all, and nobody finds that out from the code.
// Same pattern as 4.8's role-confirmation banner: an owner item is only open for
// the owner once there is somewhere to do it.
const cliniciansWithoutCredential = (users) => (Array.isArray(users) ? users : [])
  .filter(u => u && u.openEmrProviderId &&
    !clean(u.prescriberCredential, 40) && !clean(u.licenseLevel || u.credential, 40))
  .map(u => ({ id: u.id, name: u.name || '(no name)', email: u.email || '(no email)' }));

// A credential we hold but do not recognise is a DIFFERENT gap: the patient gets
// the name and the credential, just no plain-English role. Reported separately
// so an admin can tell "fill this in" from "we do not know this one".
const cliniciansWithUnrecognisedCredential = (users) => (Array.isArray(users) ? users : [])
  .filter(u => {
    if (!u || !u.openEmrProviderId) return false;
    const c = clean(u.prescriberCredential, 40) || clean(u.licenseLevel || u.credential, 40);
    return !!c && !rolePhraseFor(c);
  })
  .map(u => ({
    id: u.id, name: u.name || '(no name)',
    credential: clean(u.prescriberCredential, 40) || clean(u.licenseLevel || u.credential, 40)
  }));

module.exports = {
  REMINDER_SEND_HOUR_ET, MISSED_WINDOW_HOURS, STATUSES, VOID_REASONS,
  reminderSendAt, buildVisitReminder, voidRemindersForEid, dueReminders, reminderCopy,
  ROLE_PHRASES, rolePhraseFor, visitClinicianLabel,
  cliniciansWithoutCredential, cliniciansWithUnrecognisedCredential
};
