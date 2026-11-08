// ============================================================================
// RENEWALS, RECURRING DUTIES AND SPACED RE-CHECKS — pure, no I/O
// ============================================================================
// Owner, 2026-11-08: finish the clinician onboarding so nothing lapses
// unnoticed after the first ninety days.
//
//   * EXPIRING CREDENTIALS. Some items are documents with an expiration date
//     (a license, a DEA registration, malpractice cover, a TB result, a
//     driver's license). The date is recorded on the item; the item reads
//     "Renewal Due" once it passes and warns 60 days before.
//   * RECURRING DUTIES. The Playbook's C.9 schedule (every 30 days, quarterly,
//     annually ...) gets a next-due date per person, counted from the last
//     time it was recorded done, or from the start date.
//   * SPACED RE-CHECKS. Training Library TRN-406: a knowledge module comes
//     back at days 3, 10, 30 and 90 after it was completed.
//
// Which items EXPIRE is not stated item by item in the Playbook. The list
// below is the documents that carry an expiration date by their nature, and
// is marked so the office can see it was chosen, not read.
// ============================================================================

'use strict';

const C = require('./chapterC');

const SOON_DAYS = 60;          // warn this long before a credential expires
const RECURRING_SOON_DAYS = 14; // warn this long before a recurring duty is due

const EXPIRING_ITEMS = Object.freeze({
  'C.4.01': 'License or authorization',
  'C.6.05': 'DEA registration',
  'C.6.06': 'Malpractice policy',
  'C.6.10': 'TB screening',
  'C.6.12': "Driver's license or auto insurance",
  'C.6.13': 'License in another state',
  // Chapter B (registered nurse)
  'B.6.01': 'RN license',
  'B.6.04': 'TB screening',
  'B.6.05': 'BLS certification',
  // Chapter D (contracted clinician)
  'D.5.05': 'DEA registration',
  'D.5.06': 'Certificate of insurance'
});
const EXPIRING_BASIS = 'Chosen as the documents that carry an expiration date (owner direction, 2026-11-08); the Playbook does not list them item by item.';

const isYmd = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !Number.isNaN(Date.parse(v));
const ymd = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d || '').slice(0, 10));
const dayMs = 864e5;
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / dayMs);
const addDays = (on, n) => new Date(Date.parse(`${on}T12:00:00Z`) + n * dayMs).toISOString().slice(0, 10);

/** The expiration state of one item, or null if it does not expire or has no date. */
function expiryOf(itemId, state, today) {
  if (!EXPIRING_ITEMS[itemId]) return null;
  const on = state && state.expiresOn;
  const t = ymd(today);
  if (!isYmd(on)) return { what: EXPIRING_ITEMS[itemId], on: null, daysLeft: null, status: 'NO_DATE' };
  const left = daysBetween(t, on);
  return { what: EXPIRING_ITEMS[itemId], on, daysLeft: left,
    status: left < 0 ? 'EXPIRED' : left <= SOON_DAYS ? 'SOON' : 'OK' };
}

/** Record an expiration date on an item. */
function setExpiry(itemId, state, expiresOn, actor, now) {
  if (!EXPIRING_ITEMS[itemId]) {
    const e = new Error('This item has no expiration date to record.'); e.code = 'ITEM_DOES_NOT_EXPIRE'; throw e;
  }
  if (!isYmd(expiresOn)) { const e = new Error('Give the expiration date.'); e.code = 'EXPIRY_DATE_REQUIRED'; throw e; }
  const st = JSON.parse(JSON.stringify(state || {}));
  st.expiresOn = expiresOn;
  st.expirySetBy = { at: now, byName: actor.name || null };
  return st;
}

/**
 * Start a renewal: the completed steps move into history (never deleted) and
 * the item opens again, so the new document goes through the same steps as
 * the first, verification included.
 */
function startRenewal(itemId, state, actor, now) {
  if (!EXPIRING_ITEMS[itemId]) {
    const e = new Error('This item is not renewed.'); e.code = 'ITEM_DOES_NOT_EXPIRE'; throw e;
  }
  const st = JSON.parse(JSON.stringify(state || {}));
  st.history = (st.history || []).concat([{ steps: st.steps || {}, expiresOn: st.expiresOn || null, closedAt: now, byName: actor.name || null }]);
  st.steps = {};
  st.expiresOn = null;
  st.returned = null;
  return st;
}

/** The recurring duties that apply, each with when it is next due. */
function recurringFor(applicable, rec, startDate, today) {
  const t = ymd(today);
  const done = (rec && rec.recurring) || {};
  return applicable.map(r => {
    const last = done[r.id] && done[r.id].lastDoneOn;
    if (!r.days) {
      return { id: r.id, requirement: r.requirement, interval: r.interval, onEvent: true, lastDoneOn: last || null, nextDue: null, status: 'ON_EVENT' };
    }
    const base = last || (isYmd(startDate) ? startDate : null);
    const nextDue = base ? addDays(base, r.days) : null;
    const left = nextDue ? daysBetween(t, nextDue) : null;
    return { id: r.id, requirement: r.requirement, interval: r.interval, onEvent: false,
      lastDoneOn: last || null, lastDoneBy: done[r.id] ? done[r.id].byName : null, nextDue,
      status: !nextDue ? 'NO_START' : left < 0 ? 'OVERDUE' : left <= RECURRING_SOON_DAYS ? 'SOON' : 'OK' };
  });
}

function recordRecurring(rid, rec, doneOn, actor, now) {
  if (![C, require('./chapterF'), require('./chapterB'), require('./chapterD'), require('./chapterG')].some(ch => ch.RECURRING.some(r => r.id === rid))) { const e = new Error('Unknown recurring duty.'); e.code = 'RECURRING_UNKNOWN'; throw e; }
  if (!isYmd(doneOn)) { const e = new Error('Give the date it was done.'); e.code = 'RECURRING_DATE_REQUIRED'; throw e; }
  const out = JSON.parse(JSON.stringify(rec || {}));
  out.recurring = out.recurring || {};
  const prev = out.recurring[rid];
  out.recurring[rid] = { lastDoneOn: doneOn, at: now, byName: actor.name || null,
    history: ((prev && prev.history) || []).concat(prev ? [{ lastDoneOn: prev.lastDoneOn, byName: prev.byName }] : []) };
  return out;
}

// ---- spaced re-checks (TRN-406) ------------------------------------------------
// Knowledge modules only. A live review, an observed skill or a shadow shift
// is not something a person "re-checks" on day 10.
const RECHECK_FORMATS = /^(VIDEO|READ|IN_APP)/;
const rechecksApply = (m) => RECHECK_FORMATS.test(String(m.format || '')) && Array.isArray(m.spacedRecheck);

function rechecksFor(m, progress, today) {
  if (!rechecksApply(m) || !progress || !progress.completedAt) return null;
  const t = ymd(today);
  const from = ymd(progress.completedAt);
  const done = progress.rechecks || {};
  const list = m.spacedRecheck.map(day => {
    const dueOn = addDays(from, day);
    return { day, dueOn, done: !!done[day], at: done[day] ? done[day].at : null, due: !done[day] && dueOn <= t };
  });
  const next = list.find(x => !x.done) || null;
  return { list, dueNow: list.filter(x => x.due).map(x => x.day), next: next ? { day: next.day, dueOn: next.dueOn } : null };
}

function recordRecheck(m, progress, day, actor, now, today) {
  const r = rechecksFor(m, progress, today);
  if (!r) { const e = new Error('This module has no re-checks.'); e.code = 'RECHECK_NONE'; throw e; }
  const slot = r.list.find(x => x.day === Number(day));
  if (!slot) { const e = new Error('No such re-check.'); e.code = 'RECHECK_UNKNOWN'; throw e; }
  if (slot.done) { const e = new Error('That re-check is already recorded.'); e.code = 'RECHECK_DONE'; throw e; }
  if (!slot.due) { const e = new Error(`This re-check opens on ${slot.dueOn}.`); e.code = 'RECHECK_NOT_YET'; throw e; }
  const p = JSON.parse(JSON.stringify(progress));
  p.rechecks = p.rechecks || {};
  p.rechecks[slot.day] = { at: now, byName: actor.name || null, filedBy: actor.isOffice ? 'OFFICE_ON_BEHALF' : 'SELF' };
  return p;
}

module.exports = {
  SOON_DAYS, RECURRING_SOON_DAYS, EXPIRING_ITEMS, EXPIRING_BASIS,
  expiryOf, setExpiry, startRenewal, recurringFor, recordRecurring,
  rechecksApply, rechecksFor, recordRecheck
};
