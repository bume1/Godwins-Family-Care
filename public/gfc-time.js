// ============================================================
// GODWINS FAMILY CARE — PRACTICE TIME (single source of truth for the clock)
//
// EVERY time this app shows a person is Eastern, on both sides (owner rule,
// 2026-09-16). GFC operates in Georgia; a shift at 9am means 9am in Georgia to
// the caregiver driving to it, to the client expecting them, and to the office
// running payroll. A caregiver who travels does not get a different schedule.
//
// WHY THIS FILE EXISTS. Reported live: a shift offer email read "9/17/2026,
// 1:00:00 PM" for a 9:00 AM shift. `shift.start` is a correct UTC instant; the
// email rendered it with `toLocaleString('en-US')` and NO timeZone, so Node
// formatted it in the container's zone, which is UTC. Georgia was four hours
// behind, so every shift time in every notice read four hours late — and would
// have read FIVE hours late from November 1, when Eastern leaves daylight time.
//
// TWO MECHANISMS, because the two runtimes have different levers:
//
//   SERVER — `server.js` sets `process.env.TZ` from PRACTICE_TIMEZONE before
//   anything else runs. Node then formats every bare `toLocaleString()` in the
//   tree in Eastern: the notices, the PDF signature timestamps, the CSV
//   exports, and any call site added later without anyone remembering this
//   rule. `toISOString()` and every `getUTC*` accessor are unaffected, which is
//   what makes it safe — `schedulingRepository.js` does its date arithmetic in
//   explicit UTC and is untouched.
//
//   BROWSER — there is no TZ switch, so `installDefaultTimeZone()` fills in
//   `timeZone` on the three `toLocale*` formatters when a caller did not pass
//   one. It is DISPLAY ONLY: it never touches `getHours`, `getDay` or anything
//   arithmetic depends on. That is deliberate — patching those would silently
//   change calendar maths, and a wrong grid is worse than a wrong label.
//
// The explicit helpers below are still used at every shift, visit and clock
// site. The shim is the floor, not the plan: code that says what it means
// survives a future session deleting the shim, and reads correctly on its own.
// ============================================================

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GFC_TIME = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Georgia. Named, never an offset: "-04:00" is correct today and wrong from
  // November 1. An IANA zone carries its own daylight-saving rules, so the
  // switch costs nothing and cannot be forgotten.
  const PRACTICE_TIMEZONE = 'America/New_York';
  const LOCALE = 'en-US';

  // `new Date(null)` is the EPOCH, not an invalid date, and `new Date(0)` is a
  // real instant somebody could mean. So empties are rejected BEFORE
  // construction: without this a missing shift time printed "12/31/1969, 7:00
  // PM" to a caregiver, which is worse than printing nothing. Caught by its own
  // test.
  const EMPTY = (v) => v === null || v === undefined || v === '' ||
    (typeof v === 'object' && !(v instanceof Date));
  const toDate = (v) => (v instanceof Date ? v : new Date(v));
  const ok = (d) => d instanceof Date && !isNaN(d.getTime());

  function fmt(value, options) {
    if (EMPTY(value)) return '';
    const d = toDate(value);
    if (!ok(d)) return '';
    return d.toLocaleString(LOCALE, Object.assign({ timeZone: PRACTICE_TIMEZONE }, options));
  }

  // "9/17/2026, 9:00 AM" — the shift notices and anywhere a full stamp is shown.
  const fmtDateTime = (v) => fmt(v, {
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: '2-digit'
  });

  // "9/17/2026"
  const fmtDate = (v) => fmt(v, { year: 'numeric', month: 'numeric', day: 'numeric' });

  // "9:00 AM"
  const fmtTime = (v) => fmt(v, { hour: 'numeric', minute: '2-digit' });

  // "Thu, Sep 17 · 9:00 AM" — the caregiver schedule and the admin board.
  function fmtDayTime(v) {
    if (EMPTY(v)) return '';
    const d = toDate(v);
    if (!ok(d)) return '';
    return fmt(d, { weekday: 'short', month: 'short', day: 'numeric' }) + ' · ' + fmtTime(d);
  }

  // "Thursday, September 17 at 9:00 AM" — the long form a patient email uses.
  function fmtLongDayTime(v) {
    if (EMPTY(v)) return '';
    const d = toDate(v);
    if (!ok(d)) return '';
    return fmt(d, { weekday: 'long', month: 'long', day: 'numeric' }) + ' at ' + fmtTime(d);
  }

  // The calendar fields of an instant AS READ IN EASTERN. Needed wherever code
  // asks "which weekday is this shift on" or "what time of day does it start" —
  // `getUTCDay()` answers for UTC, so an 8pm Tuesday shift in Georgia is a
  // WEDNESDAY at 00:00 there, which matches the wrong availability window.
  // Built from formatToParts rather than arithmetic so daylight saving is the
  // platform's problem, not ours.
  const PARTS_FMT = {
    timeZone: PRACTICE_TIMEZONE, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short'
  };
  const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

  function zonedParts(value) {
    if (EMPTY(value)) return null;
    const d = toDate(value);
    if (!ok(d)) return null;
    const parts = {};
    new Intl.DateTimeFormat(LOCALE, PARTS_FMT).formatToParts(d)
      .forEach(p => { if (p.type !== 'literal') parts[p.type] = p.value; });
    // Midnight comes back as hour 24 in some ICU builds under hour12:false.
    const hour = Number(parts.hour) % 24;
    const minute = Number(parts.minute);
    return {
      year: Number(parts.year),
      month: Number(parts.month),
      day: Number(parts.day),
      hour,
      minute,
      minutesOfDay: hour * 60 + minute,
      weekday: parts.weekday,
      weekdayIndex: WEEKDAY_INDEX[parts.weekday],
      // "2026-09-17" as the date IS in Georgia — not the UTC date, which rolls
      // over at 8pm local and would file an evening shift under tomorrow.
      isoDate: `${parts.year}-${parts.month}-${parts.day}`
    };
  }

  // ---- Eastern wall clock -> the instant it names ---------------------------
  // "2026-11-01" + "09:00" is a time SOMEBODY TYPED ON A FORM. It means 9am in
  // Georgia, and the instant that names moves with daylight time: an hour
  // earlier in July than in December. `new Date("2026-11-01T09:00")` reads it
  // in whatever zone the reader happens to sit in — the browser's, or the
  // server's — so a bulk range spanning November 1 would silently shift by an
  // hour halfway through, and an admin working from outside Georgia would post
  // every shift at the wrong time.
  //
  // So the offset is MEASURED at the instant in question rather than assumed.
  // Two passes: guess, read the guess back in practice time, correct by the
  // gap. A second pass settles the case where the correction itself crosses a
  // transition. A local time that does not exist (2:30am on the spring-forward
  // Sunday) resolves to the nearest real instant rather than to nothing.
  const pad2 = (n) => String(n).padStart(2, '0');

  function instantFromZoned(isoDate, hhmm) {
    if (EMPTY(isoDate) || EMPTY(hhmm)) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(isoDate))) return null;
    if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(String(hhmm))) return null;
    const wanted = Date.parse(`${isoDate}T${hhmm}:00Z`);
    if (isNaN(wanted)) return null;
    let ts = wanted;
    for (let i = 0; i < 2; i++) {
      const p = zonedParts(new Date(ts));
      if (!p) return null;
      const readBack = Date.parse(
        `${p.year}-${pad2(p.month)}-${pad2(p.day)}T${pad2(p.hour)}:${pad2(p.minute)}:00Z`);
      if (isNaN(readBack)) return null;
      const gap = wanted - readBack;
      if (gap === 0) break;
      ts += gap;
    }
    return new Date(ts).toISOString();
  }

  // Browser only. Fills in `timeZone` where a caller passed none, so a page
  // that was written before this rule still renders Eastern. Idempotent, and
  // display-only by design: see the header.
  function installDefaultTimeZone(zone) {
    if (typeof Date === 'undefined' || !Date.prototype) return false;
    const z = zone || PRACTICE_TIMEZONE;
    ['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString'].forEach(function (name) {
      const original = Date.prototype[name];
      if (!original || original.gfcZoned) return;
      function zoned(locales, options) {
        const opts = options ? Object.assign({}, options) : {};
        if (!opts.timeZone) opts.timeZone = z;
        return original.call(this, locales === undefined ? LOCALE : locales, opts);
      }
      zoned.gfcZoned = true;
      Date.prototype[name] = zoned;
    });
    return true;
  }

  return {
    PRACTICE_TIMEZONE, LOCALE,
    fmtDateTime, fmtDate, fmtTime, fmtDayTime, fmtLongDayTime,
    zonedParts, instantFromZoned, installDefaultTimeZone
  };
});
