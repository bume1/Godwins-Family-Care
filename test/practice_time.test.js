// EVERY time this app shows is Eastern, on both sides (owner rule, 2026-09-16).
//
// Reported live: a shift offer email read "9/17/2026, 1:00:00 PM" for a 9:00 AM
// shift. `shift.start` was a correct UTC instant; the notice rendered it with
// `toLocaleString('en-US')` and NO timeZone, so Node formatted it in the
// container's zone — UTC — and Georgia was four hours behind it.
//
// These guards RUN the formatters rather than reading them, and the browser
// shim is installed against a real Date and exercised.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const T = require('../public/gfc-time');

// 9:00 AM in Georgia on 2026-09-17 (EDT, UTC-4) is 13:00 UTC.
const NINE_AM_ET = new Date('2026-09-17T09:00:00-04:00').toISOString();
// 9:00 AM in Georgia on 2026-12-17 (EST, UTC-5) is 14:00 UTC.
const NINE_AM_EST = new Date('2026-12-17T09:00:00-05:00').toISOString();

test('the reported defect: a 9am shift renders as 9am, not 1pm', () => {
  assert.strictEqual(NINE_AM_ET, '2026-09-17T13:00:00.000Z', 'the fixture is the instant it claims to be');
  assert.match(T.fmtDateTime(NINE_AM_ET), /9:00\s*AM/, 'the shift notice must say 9:00 AM');
  assert.ok(!/1:00\s*PM/.test(T.fmtDateTime(NINE_AM_ET)), 'the UTC reading is what shipped and must not come back');
});

test('daylight saving is handled by the zone, never by a hardcoded offset', () => {
  // The same wall-clock hour on either side of the November switch. An offset
  // baked in as -4 would read 8:00 AM here and be wrong all winter.
  assert.match(T.fmtDateTime(NINE_AM_ET), /9:00\s*AM/, 'September, EDT');
  assert.match(T.fmtDateTime(NINE_AM_EST), /9:00\s*AM/, 'December, EST');
  assert.ok(!/[+-]\d{2}:?\d{2}/.test(T.PRACTICE_TIMEZONE), 'the zone is named, not an offset');
  assert.strictEqual(T.PRACTICE_TIMEZONE, 'America/New_York');
});

test('a stored instant is never altered — only how it is read', () => {
  const d = new Date(NINE_AM_ET);
  assert.strictEqual(d.toISOString(), '2026-09-17T13:00:00.000Z');
  assert.strictEqual(d.getUTCHours(), 13, 'getUTC* must stay UTC or the scheduling arithmetic moves');
});

test('zonedParts reads the weekday, hour and DATE in Georgia', () => {
  // Tuesday 8pm in Georgia is Wednesday 00:00 UTC. All three fields differ.
  const tuesdayEvening = new Date('2026-09-15T20:00:00-04:00').toISOString();
  assert.strictEqual(new Date(tuesdayEvening).getUTCDay(), 3, 'UTC calls it Wednesday');

  const p = T.zonedParts(tuesdayEvening);
  assert.strictEqual(p.weekday, 'Tue');
  assert.strictEqual(p.weekdayIndex, 2);
  assert.strictEqual(p.hour, 20);
  assert.strictEqual(p.minutesOfDay, 20 * 60);
  assert.strictEqual(p.isoDate, '2026-09-15', 'the date is the one in Georgia, not the UTC rollover');
});

test('midnight in Georgia reads as hour 0, not 24', () => {
  // hour12:false yields "24" for midnight on some ICU builds, which would make
  // minutesOfDay 1440 and put a midnight shift past the end of every window.
  const p = T.zonedParts(new Date('2026-09-15T00:00:00-04:00').toISOString());
  assert.strictEqual(p.hour, 0);
  assert.strictEqual(p.minutesOfDay, 0);
  assert.strictEqual(p.isoDate, '2026-09-15');
});

test('an unparseable value yields empty, never "Invalid Date" in front of a person', () => {
  for (const bad of [null, undefined, '', 'not a date', {}]) {
    assert.strictEqual(T.fmtDateTime(bad), '', `fmtDateTime(${JSON.stringify(bad)})`);
    assert.strictEqual(T.fmtTime(bad), '');
    assert.strictEqual(T.fmtDayTime(bad), '');
    assert.strictEqual(T.zonedParts(bad), null);
  }
});

// ---- the server lever ------------------------------------------------------

// Every lookup below is done on CODE, with comment lines stripped. A raw
// substring search finds `process.env.TZ =` inside a commented-out copy of the
// line and reports the fix as present when it has been disabled — which is
// exactly what happened under mutation, in the second test in this file to
// make that mistake. Strip first, then look.
const codeOf = (file) => read(file).split('\n')
  .filter(l => !l.trim().startsWith('//')).join('\n');

test('server.js pins the process to Eastern, after the scrubber and before the rest', () => {
  const src = codeOf('server.js');
  const scrubber = src.indexOf("require('./logScrubber').install(console)");
  const tz = src.indexOf('process.env.TZ =');
  assert.ok(tz > 0, 'server.js must set the process timezone');
  assert.ok(scrubber >= 0 && scrubber < tz, 'the scrubber stays first — PHI in a log outranks a date format');

  // Every other require must come AFTER it, or a module that formats at load
  // time captures the old zone.
  const laterRequires = ['./config', './email', './pdf-generator', './openemr'];
  for (const mod of laterRequires) {
    const at = src.indexOf(`require('${mod}')`);
    if (at === -1) continue;
    assert.ok(at > tz, `require('${mod}') must come after the timezone is set`);
  }
  // And it takes the zone from the shared module rather than restating it.
  assert.match(src.slice(tz, tz + 200), /PRACTICE_TIMEZONE/,
    'the zone comes from public/gfc-time.js — a second copy is a second thing to forget');
});

test('setting process.env.TZ actually changes how Node formats — the lever is real', () => {
  // Verify the BEHAVIOUR, not that the line exists. This asserts the mechanism
  // the whole server-side fix rests on.
  const before = process.env.TZ;
  try {
    process.env.TZ = 'UTC';
    const utc = new Date(NINE_AM_ET).toLocaleString('en-US');
    process.env.TZ = T.PRACTICE_TIMEZONE;
    const et = new Date(NINE_AM_ET).toLocaleString('en-US');
    assert.match(utc, /1:00:00\s*PM/, 'under UTC a bare format gives the reported wrong time');
    assert.match(et, /9:00:00\s*AM/, 'under the practice zone it gives the right one');
  } finally {
    if (before === undefined) delete process.env.TZ; else process.env.TZ = before;
  }
});

// ---- the browser shim ------------------------------------------------------

test('installDefaultTimeZone fills in the zone a caller omitted, and is idempotent', () => {
  const original = Date.prototype.toLocaleString;
  try {
    T.installDefaultTimeZone();
    T.installDefaultTimeZone();   // a second install must not wrap the wrapper
    const d = new Date(NINE_AM_ET);
    assert.match(d.toLocaleString('en-US'), /9:00:00\s*AM/, 'a bare call now renders Eastern');
    assert.match(d.toLocaleTimeString('en-US'), /9:00:00\s*AM/);
    assert.match(d.toLocaleDateString('en-US'), /9\/17\/2026/);
  } finally {
    Date.prototype.toLocaleString = original;
    delete Date.prototype.toLocaleDateString.gfcZoned;
    delete Date.prototype.toLocaleTimeString.gfcZoned;
  }
});

test('the shim NEVER overrides a timeZone a caller passed deliberately', () => {
  const original = Date.prototype.toLocaleString;
  try {
    T.installDefaultTimeZone();
    const d = new Date(NINE_AM_ET);
    assert.match(d.toLocaleString('en-US', { timeZone: 'UTC' }), /1:00:00\s*PM/,
      'an explicit zone wins — otherwise the shim would silently break a deliberate choice');
  } finally {
    Date.prototype.toLocaleString = original;
  }
});

test('the shim is display-only: it does not touch the arithmetic getters', () => {
  // Patching getHours/getDay would silently move every calendar grid in the
  // app. A wrong label is recoverable; a wrong grid is not.
  const src = read('public/gfc-time.js');
  const install = src.slice(src.indexOf('function installDefaultTimeZone'));
  for (const getter of ['getHours', 'getDay', 'getDate', 'getMonth', 'getFullYear', 'getTime']) {
    assert.ok(!install.includes(getter),
      `installDefaultTimeZone must not patch ${getter} — it feeds arithmetic, not display`);
  }
});

// ---- the surfaces -----------------------------------------------------------

test('every GFC page loads the timezone module before its own scripts', () => {
  const pages = ['caregiver.html', 'portal.html', 'scheduling.html', 'caregivers.html',
                 'admin-hub.html', 'admin-enrollment.html', 'clinical.html'];
  for (const page of pages) {
    const src = read(`public/${page}`);
    // Match the TAG, not the path. The comment above the tag names the file, so
    // a bare `indexOf('/gfc-time.js')` still finds it after the tag is deleted —
    // it did, under mutation. That is the THIRD guard in this session to read a
    // comment as code; the rule is now written down in CLAUDE.md.
    const tag = /<script\s+src="\/gfc-time\.js"><\/script>/.exec(src);
    assert.ok(tag, `${page} must load /gfc-time.js with a real script tag`);
    const at = tag.index;
    assert.match(src, /installDefaultTimeZone\(\)/, `${page} must install the default zone`);
    const firstBabel = src.indexOf('<script type="text/babel">');
    assert.ok(firstBabel === -1 || at < firstBabel,
      `${page} must load it before the page's own script, or a formatter runs first`);
  }
});

test('no shift or visit surface formats a bare instant any more', () => {
  // The files that show a caregiver or a client when to be somewhere. A bare
  // toLocale* here is the defect that was reported.
  const surfaces = ['routes/scheduling.js', 'public/components/caregiver-schedule.js',
                    'public/scheduling.html', 'public/caregivers.html'];
  for (const f of surfaces) {
    const src = read(f);
    const bare = src.match(/\.toLocale(String|TimeString|DateString)\(\s*'en-US'\s*(\)|,\s*\{(?![^}]*timeZone))/);
    assert.ok(!bare, `${f} formats a time without a zone (${bare && bare[0]}) — use GFC_TIME`);
  }
});

test('availability is matched on the Georgia weekday, not the UTC one', () => {
  // Comments stripped, same reason as above: the fix's own comment NAMES
  // getUTCDay to explain what it replaced.
  const src = read('schedulingRepository.js');
  const fn = codeOf('schedulingRepository.js')
    .slice(codeOf('schedulingRepository.js').indexOf('function availabilityCoversShift'));
  assert.ok(fn.includes('practiceTime.zonedParts'), 'it must read the shift in Eastern');
  assert.ok(!fn.includes('getUTCDay()'), 'getUTCDay put a Tuesday evening shift on Wednesday');
  assert.ok(!fn.includes('getUTCHours()'), 'and gave it the wrong hour of day');
});
