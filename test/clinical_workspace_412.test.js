// test/clinical_workspace_412.test.js — Session 4.12
//
// The clinical workspace rebuilt as a house-call tool: the persistent patient
// banner, the home-visit standing facts, and every form grid collapsing at
// phone width.
//
// MUTATION-CHECKED. Every guard below was confirmed to FAIL when the rule it
// guards is put back the old way. A test whose assertion cannot distinguish the
// two states proves nothing — the house rule this repo has now paid for six
// times, most recently against two assertions written in Session 4.11.
//
// A SOURCE SCAN STRIPS COMMENTS BEFORE IT LOOKS. Three guards in the 2026-09-16
// pass matched the prose ABOVE the code they were written to check, and one in
// 4.9b read a module's own header. Comments explaining a rule contain the words
// of the rule, so a scan that cannot tell live code from prose about that code
// proves nothing.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const repo = require('../clinicalRepository');

const root = path.join(__dirname, '..');
const serverSrc = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const pageSrc = fs.readFileSync(path.join(root, 'public/clinical.html'), 'utf8');

// Block and line comments out, string contents left alone.
//
// THE ORDER IS LOAD-BEARING AND THE FIRST DRAFT OF THIS FUNCTION WAS WRONG.
// Stripping block comments first meant the `/*` inside server.js's own line
// comment `// ... /api/caregiver/*. Every route inside` opened a block that ran
// on until the next `*/` — 316,000 characters of real code, silently deleted,
// and every scan below then passed or failed on a file that was half missing.
// Whole-line `//` comments go FIRST, so a `/*` living inside one is gone before
// the block pass runs. The line pattern is anchored to the start of a line so
// it never eats the tail of a `'https://…'`.
const stripComments = (src) => src
  .replace(/^[ \t]*\/\/.*$/gm, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

// A stripper that grabs the wrong slice proves nothing, so it says so out loud
// rather than quietly handing every later assertion a truncated file.
const strippedSafely = (src, label) => {
  const out = stripComments(src);
  const removed = 1 - out.length / src.length;
  assert.ok(removed < 0.45,
    `stripComments removed ${(removed * 100).toFixed(1)}% of ${label} — it has swallowed code, not comments`);
  return out;
};

const pageCode = strippedSafely(pageSrc, 'public/clinical.html');
const serverCode = strippedSafely(serverSrc, 'server.js');

// ===========================================================================
// 1. SCOPE H1 — every grid starts at ONE column
// ===========================================================================
// "A four- or five-column grid on a 390px screen is the defect that made the
// H&P unusable in the field." The fix is a base of one column with the old
// density restored at a breakpoint, so desktop is unchanged (H2).

test('no grid in the clinical workspace is multi-column at phone width', () => {
  const offenders = [];
  // A Tailwind grid-cols utility with NO responsive prefix applies from 0px up.
  const re = /(^|[\s"'`])(grid-cols-([2-9]|1[0-2]))/g;
  let m;
  while ((m = re.exec(pageCode))) {
    const before = pageCode.slice(Math.max(0, m.index - 4), m.index + m[1].length);
    if (/(sm|md|lg|xl|2xl):$/.test(before)) continue;
    const line = pageCode.slice(0, m.index).split('\n').length;
    offenders.push(`line ${line}: ${m[2]}`);
  }
  assert.deepStrictEqual(offenders, [],
    'every grid must start at one column and widen at a breakpoint:\n' + offenders.join('\n'));
});

test('a column span starts at the breakpoint where the extra track exists', () => {
  // `col-span-2` inside a one-column grid is a span over tracks that are not
  // there. It is not a rendering bug; it is a line that misleads the next
  // reader about how many columns the grid has.
  const spans = pageCode.match(/className="col-span-\d/g) || [];
  assert.deepStrictEqual(spans, [], 'every col-span must carry a breakpoint prefix');
});

test('no grid was flattened to a single column everywhere', () => {
  // H2: phone-first for the encounter, DESKTOP KEEPS THE DENSITY. The first
  // version of this guard counted wide grids and asserted a floor, so
  // flattening any ONE of them survived it — it could not distinguish the two
  // states. Every grid that starts at one column must widen somewhere, and the
  // widening must be wider than the base.
  const ORDER = { base: 0, sm: 1, md: 2, lg: 3, xl: 4, '2xl': 5 };
  const decls = pageCode.match(/grid grid-cols-1[^"]*/g) || [];
  assert.ok(decls.length >= 8, `expected the collapsed grids to be found, saw ${decls.length}`);
  decls.forEach(d => {
    const steps = [{ bp: 'base', n: 1 }];
    [...d.matchAll(/(sm|md|lg|xl|2xl):grid-cols-(\d+)/g)]
      .forEach(m => steps.push({ bp: m[1], n: Number(m[2]) }));
    assert.ok(steps.length > 1, `grid never widens on a larger screen: "${d.trim()}"`);
    steps.sort((a, b) => ORDER[a.bp] - ORDER[b.bp]);
    // Column count must never DROP as the screen grows. A grid that goes
    // 1 → 2 at sm and back to 1 at md has lost its desktop density while still
    // "widening somewhere", which is what the previous version of this guard
    // could not see.
    steps.reduce((prev, step) => {
      assert.ok(step.n >= prev.n,
        `grid narrows from ${prev.n} to ${step.n} columns at ${step.bp}: "${d.trim()}"`);
      return step;
    });
    assert.ok(steps[steps.length - 1].n > 1, `grid is one column at every width: "${d.trim()}"`);
  });
});

// ===========================================================================
// 2. SCOPE C — the allergy strip has THREE states
// ===========================================================================
// C2: "the absence of the strip must never be what communicates 'none on
// file'". The inverse is the one a bug produces and is worse: a strip reading
// "No known allergies" on a patient whose list simply failed to load.

test('a chart that was read and is empty says NO KNOWN ALLERGIES', () => {
  const strip = repo.buildAllergyStrip({ linked: true, emrAllergies: { ok: true, rows: [] } });
  assert.strictEqual(strip.state, repo.ALLERGY_STATE.NONE_KNOWN);
  assert.strictEqual(strip.source, 'chart');
});

test('a chart that could NOT be read is UNAVAILABLE, never "no known allergies"', () => {
  const strip = repo.buildAllergyStrip({
    linked: true, emrAllergies: { ok: false, status: 403, error: 'Organization policy' }
  });
  assert.strictEqual(strip.state, repo.ALLERGY_STATE.UNAVAILABLE);
  assert.notStrictEqual(strip.state, repo.ALLERGY_STATE.NONE_KNOWN);
  assert.match(strip.reason, /Organization policy/);
});

test('an unlinked patient is UNAVAILABLE, never "no known allergies"', () => {
  const strip = repo.buildAllergyStrip({ linked: false, emrAllergies: null, reportedAllergies: '' });
  assert.strictEqual(strip.state, repo.ALLERGY_STATE.UNAVAILABLE);
  assert.match(strip.reason, /not linked/i);
});

test('what the family reported at intake is shown, and is LABELLED as intake', () => {
  // Better than a blank strip on an unlinked patient — and it must never be
  // presented as a reconciled chart allergy list.
  const strip = repo.buildAllergyStrip({
    linked: false, emrAllergies: null, reportedAllergies: 'Penicillin — rash'
  });
  assert.strictEqual(strip.state, repo.ALLERGY_STATE.LISTED);
  assert.strictEqual(strip.source, 'intake');
  assert.deepStrictEqual(strip.rows, ['Penicillin — rash']);
  assert.match(strip.reason, /intake/i);
});

test('a resolved or entered-in-error allergy is not on the strip', () => {
  const strip = repo.buildAllergyStrip({
    linked: true,
    emrAllergies: {
      ok: true,
      rows: [
        { allergen: 'Penicillin' },
        { allergen: 'Latex', status: 'resolved' },
        { allergen: 'Sulfa', status: 'entered-in-error' },
        { allergen: 'Codeine', status: 'active' }
      ]
    }
  });
  assert.deepStrictEqual(strip.rows, ['Penicillin', 'Codeine']);
});

test('an allergy with no status recorded stays on the strip', () => {
  // No status is not evidence of resolution, and dropping it would hide a real
  // allergy on exactly the rows a sparse chart produces.
  assert.strictEqual(repo.isActiveAllergy({ allergen: 'Penicillin' }), true);
});

// ===========================================================================
// 3. SCOPE C — age is computed on the PRACTICE clock, passed in
// ===========================================================================

test('age turns over on the birthday and not before', () => {
  assert.strictEqual(repo.ageOn('1948-03-18', '2026-03-17'), 77);
  assert.strictEqual(repo.ageOn('1948-03-18', '2026-03-18'), 78);
  assert.strictEqual(repo.ageOn('1948-03-18', '2026-03-19'), 78);
});

test('a missing or malformed date of birth yields no age, never a number', () => {
  ['', null, undefined, 'not a date', '1948-13-99x'].forEach(dob => {
    assert.strictEqual(repo.ageOn(dob, '2026-09-23'), null, `dob ${JSON.stringify(dob)}`);
  });
  assert.strictEqual(repo.ageOn('1948-03-18', ''), null);
});

test('the banner never reads the clock itself', () => {
  // For four hours of every evening UTC is already tomorrow, so an age derived
  // from `new Date()` inside a pure builder ages a patient a day early on their
  // birthday. `today` is passed in, from practiceToday().
  const src = strippedSafely(fs.readFileSync(path.join(root, 'clinicalRepository.js'), 'utf8'), 'clinicalRepository.js');
  const start = src.indexOf('const ageOn = (');
  const end = src.indexOf('\nconst ', start + 10);
  assert.ok(start > 0 && end > start, 'ageOn not found');
  const body = src.slice(start, end);
  assert.ok(!/new Date\(/.test(body), 'ageOn must not construct a Date');
  assert.match(serverCode, /today:\s*practiceToday\(\)/);
});

test('the care tier LABEL is passed in, never derived inside the pure module', () => {
  // The label lives in server.js. Reaching for it from the pure repository
  // compiles and then throws a ReferenceError the first time a chart is opened.
  const src = strippedSafely(fs.readFileSync(path.join(root, 'clinicalRepository.js'), 'utf8'), 'clinicalRepository.js');
  assert.ok(!/careTierLabelFor\s*\(/.test(src),
    'clinicalRepository.js must not call careTierLabelFor — it is not defined there');
});

// ===========================================================================
// 4. SCOPE F4 — the home-visit facts belong to the PATIENT
// ===========================================================================
// "Re-entering 'use the side entrance' every visit is how it stops being
// entered at all." Move them to the encounter and these must fail.

test('the home-visit facts are read off the client record', () => {
  const notes = repo.homeVisitNotesOf({ homeVisit: { accessInstructions: 'Use side entrance.' } });
  assert.strictEqual(notes.accessInstructions, 'Use side entrance.');
});

test('the banner takes home-visit facts from the client and from nowhere else', () => {
  const banner = repo.buildPatientBanner({
    client: { id: 'c1', name: 'Mary Johnson', homeVisit: { accessInstructions: 'Side entrance.' } },
    linked: false, emrAllergies: null, today: '2026-09-23'
  });
  assert.strictEqual(banner.homeVisit.accessInstructions, 'Side entrance.');

  // The mutation this is written against: sourcing them from an encounter.
  // A builder handed an encounter carrying different facts must ignore it.
  const withEncounter = repo.buildPatientBanner({
    client: { id: 'c1', name: 'Mary Johnson', homeVisit: { accessInstructions: 'Side entrance.' } },
    encounter: { homeVisit: { accessInstructions: 'Front door today.' } },
    linked: false, emrAllergies: null, today: '2026-09-23'
  });
  assert.strictEqual(withEncounter.homeVisit.accessInstructions, 'Side entrance.',
    'the standing facts are the patient\'s; an encounter never overrides them');
});

test('nothing that resolves a standing fact reads an encounter', () => {
  // The first version of this scan covered only buildPatientBanner's own body,
  // so moving the encounter lookup one function down — into homeVisitNotesOf,
  // which the banner calls — sailed through it. The scan covers the whole
  // home-visit region now: the sanitizer, the reader and the builder.
  const src = strippedSafely(fs.readFileSync(path.join(root, 'clinicalRepository.js'), 'utf8'), 'clinicalRepository.js');
  const start = src.indexOf('const HOME_VISIT_FIELDS = Object.freeze');
  assert.ok(start > 0, 'the home-visit region was not found');
  const end = src.indexOf('\nmodule.exports', start);
  const region = src.slice(start, end > start ? end : src.length);
  assert.match(region, /const homeVisitNotesOf/, 'the region must contain the reader');
  assert.match(region, /const buildPatientBanner/, 'the region must contain the builder');
  assert.ok(!/encounter/i.test(region),
    'a standing fact is the patient\'s; nothing here may source one from an encounter');
  // And the reader takes the CLIENT and nothing else — a second parameter is
  // how a caller starts passing an encounter in.
  assert.match(region, /const homeVisitNotesOf = \(client\) =>/);
});

test('an unknown key never reaches a patient record through the home-visit route', () => {
  const notes = repo.sanitizeHomeVisitNotes({
    accessInstructions: 'Side entrance.', enrollmentStatus: 'enrolled', role: 'admin'
  });
  assert.deepStrictEqual(Object.keys(notes), ['accessInstructions']);
});

test('an empty home-visit answer is dropped rather than stored blank', () => {
  assert.deepStrictEqual(repo.sanitizeHomeVisitNotes({ accessInstructions: '   ' }), {});
  assert.strictEqual(repo.hasHomeVisitNotes({}), false);
});

test('the home-visit route is a clinical WRITE and logs which fields changed, never their values', () => {
  const i = serverCode.indexOf("app.put('/api/clinical/patients/:clientId/home-visit'");
  assert.ok(i > 0, 'the home-visit route is not registered');
  const body = serverCode.slice(i, i + 2200);
  assert.match(body, /requireClinicalWrite/,
    'a clinician standing at a locked gate must be able to record it');
  assert.match(body, /patient_home_visit_notes_updated/);
  assert.match(body, /\{\s*fields:\s*changed\s*\}/,
    'the audit records WHICH facts changed, never what a patient\'s home looks like');
  assert.ok(!/homeVisit:\s*notes\s*\}\s*\)/.test(body.slice(body.indexOf('logActivity'))),
    'the note text must not reach the activity log');
});

// ===========================================================================
// 5. SCOPE C — the banner is on every tab, and is not a tab
// ===========================================================================

test('the banner renders UNCONDITIONALLY, so every tab carries it', () => {
  // The first version of this compared the position of `<PatientBanner` against
  // the position of `tab === 'summary'`, which survived wrapping the banner in
  // `{tab === "summary" && …}` — the double-quoted guard did not match the
  // single-quoted needle and a later occurrence kept the ordering true. It
  // could not distinguish the two states.
  //
  // What distinguishes them is the SHAPE of the line: an unconditional JSX
  // element opens its own line, where one behind a guard is preceded by `&&`,
  // `?` or `{`. Same anchoring the 4.11 wiring guards had to learn.
  const lines = pageCode.split('\n');
  const rendered = lines.filter(l => l.includes('<PatientBanner'));
  assert.strictEqual(rendered.length, 1, 'exactly one banner render site, or two copies drift');
  assert.match(rendered[0], /^\s*<PatientBanner\b/,
    'the banner must open its own line — anything before it on that line is a condition it renders behind');
  const i = pageCode.indexOf('<PatientBanner');
  assert.match(pageCode.slice(i, i + 1200), /tabs\.map/,
    'the tab bar follows the banner in the shell, so the banner sits above every tab');
  const firstTabBody = pageCode.search(/tab ===\s*['"]summary['"]/);
  assert.ok(firstTabBody > i, 'the banner must precede the tab bodies');
});

test('the banner is not a tab', () => {
  const i = pageCode.indexOf('const tabs = [');
  const decl = pageCode.slice(i, pageCode.indexOf(']', i));
  assert.ok(!/banner/i.test(decl), 'the banner is a fixture of the chart, never a destination in it');
});

test('the identity line and the allergy strip are never behind the expander', () => {
  const i = pageCode.indexOf('const PatientBanner = (');
  const body = pageCode.slice(i, pageCode.indexOf('\n    const ', i + 10));
  const idLine = body.indexOf('idBits');
  const stripLine = body.indexOf('<AllergyStrip');
  const expander = body.indexOf('{open && (');
  assert.ok(idLine > 0 && stripLine > 0 && expander > 0, 'banner internals not found');
  assert.ok(idLine < expander, 'the identity line must render unconditionally');
  assert.ok(stripLine < expander, 'the allergy strip must render unconditionally');
});

test('the page states no home-visit field of its own', () => {
  // Served by GET /api/clinical/status, so the form cannot offer a key the
  // sanitizer refuses. The rule the competency catalog and intake-fields set.
  assert.match(pageCode, /emrStatus\s*&&\s*emrStatus\.homeVisitFields/);
  ['accessInstructions', 'caregiverPresent', 'patientPreferences', 'safetyNotes']
    .forEach(k => assert.ok(!pageCode.includes(`'${k}'`) && !pageCode.includes(`"${k}"`),
      `the page must not name the home-visit field ${k}`));
  assert.match(serverCode, /homeVisitFields:\s*clinicalRepo\.HOME_VISIT_FIELDS/);
});

// ===========================================================================
// 6. PRESERVATION — this session is a presentation-layer change
// ===========================================================================
// "Encounter records, visit drafts, PAINAD scores, systems exam and the
// home-hazard inventory keep their existing field names and shapes."

test('the visit draft, the encounter and the hazard inventory keep their names', () => {
  ['clinical_note_drafts', 'encounter_billing', 'care_plan_versions', 'clinical_orders']
    .forEach(c => assert.ok(serverCode.includes(`'${c}'`), `collection ${c} must still be read`));
  const repoSrc = fs.readFileSync(path.join(root, 'clinicalRepository.js'), 'utf8');
  ['systemsExam', 'skinWound', 'painAssessment', 'homeHazards', 'triage', 'noteDraftId'].forEach(k =>
    assert.ok(repoSrc.includes(k), `${k} must keep its name`));
});

test('the banner added no migration and deletes nothing', () => {
  const i = serverCode.indexOf("app.put('/api/clinical/patients/:clientId/home-visit'");
  const body = serverCode.slice(i, i + 2200);
  assert.ok(!/db\.set\('(?!users)/.test(body),
    'the home-visit route writes the users blob and nothing else');
  assert.ok(!/\.filter\(.*!==.*\)\s*;\s*await db\.set/.test(body), 'nothing is removed here');
});

// ===========================================================================
// 7. The guard's own guard
// ===========================================================================

test('stripComments removes comments and not code', () => {
  const sample = [
    "// a line comment mentioning /api/caregiver/*. and more",
    "const kept = 'https://example.test/path';",
    "/* a real block",
    "   spanning lines */",
    "const alsoKept = 2;"
  ].join('\n');
  const out = stripComments(sample);
  assert.match(out, /const kept = 'https:\/\/example\.test\/path';/,
    'a URL inside a string is not a comment');
  assert.match(out, /const alsoKept = 2;/,
    'a stray /* inside a line comment must not swallow the rest of the file');
  assert.ok(!out.includes('a real block'), 'a genuine block comment is removed');
});

// ===========================================================================
// 8. SCOPE A — MY DAY
// ===========================================================================

const myDay = require('../myDay');
const pageCodeLines = pageCode.split('\n');

test('the day advances through its own states, and the record beats the stamps', () => {
  const st = (timing, signed, appointment) =>
    myDay.deriveVisitState({ appointment: appointment || {}, timing, signed });
  assert.strictEqual(st(null, false), 'scheduled');
  assert.strictEqual(st({ enRouteAt: 'x' }, false), 'en_route');
  assert.strictEqual(st({ enRouteAt: 'x', arrivedAt: 'y' }, false), 'arrived');
  assert.strictEqual(st({ arrivedAt: 'y', startedAt: 'z' }, false), 'in_progress');
  // A visit documented from the office afterwards never had an Arrive pressed.
  // Signed is the record's own answer and outranks every stamp.
  assert.strictEqual(st({ startedAt: 'z' }, true), 'signed');
  assert.strictEqual(st(null, true), 'signed');
  // And a cancelled visit outranks even that.
  assert.strictEqual(st({ startedAt: 'z' }, true, { status: 'x' }), 'cancelled');
  assert.strictEqual(st(null, false, { status: '?' }), 'no_show');
});

test('a visit still running has NO total, not a total of zero', () => {
  // `new Date(null)` is the epoch and the epoch is finite. This repo has paid
  // for that twice — a 1970 clock-out that earned an "early clock out" flag,
  // and a formatter that printed 12/31/1969.
  assert.strictEqual(myDay.totalVisitMinutes({ startedAt: '2026-09-23T14:05:00Z' }), null);
  assert.strictEqual(myDay.totalVisitMinutes({}), null);
  assert.strictEqual(myDay.totalVisitMinutes(null), null);
  assert.strictEqual(myDay.minutesBetween(null, null), null);
  assert.strictEqual(myDay.minutesBetween('2026-09-23T14:05:00Z', '2026-09-23T14:47:00Z'), 42);
});

test('an impossible duration is refused rather than recorded', () => {
  // Backwards, and longer than any home visit. Both are a mis-stamp, and a
  // mis-stamp that becomes a time statement becomes a billed E/M level.
  assert.strictEqual(myDay.minutesBetween('2026-09-23T15:00:00Z', '2026-09-23T14:00:00Z'), null);
  assert.strictEqual(myDay.minutesBetween('2026-09-23T00:00:00Z', '2026-09-25T00:00:00Z'), null);
});

test('the time statement never counts a minute twice', () => {
  // Psychotherapy minutes are documented separately from E/M minutes and the
  // same minute is never both (billing guide). The E/M figure is net.
  const s = myDay.timeStatement({
    startedAt: '2026-09-23T14:00:00Z', endedAt: '2026-09-23T15:00:00Z', psychotherapyMinutes: 30
  });
  assert.match(s, /60 minutes/);
  assert.match(s, /30 minutes of psychotherapy/);
  assert.match(s, /30 minutes of evaluation and management/);
  assert.match(s, /separate and distinct/);
});

test('an unfinished visit produces no time statement at all', () => {
  assert.strictEqual(myDay.timeStatement({ startedAt: '2026-09-23T14:00:00Z' }), null);
});

test('psychotherapy minutes longer than the visit are ignored, not subtracted', () => {
  // Otherwise the E/M figure goes negative and the note asserts something
  // impossible about a visit.
  const s = myDay.timeStatement({
    startedAt: '2026-09-23T14:00:00Z', endedAt: '2026-09-23T14:20:00Z', psychotherapyMinutes: 45
  });
  assert.match(s, /20 minutes/);
  assert.ok(!/-\d+ minutes/.test(s), 'the statement must never show negative E/M minutes');
});

test('no coordinates yields no distance, never zero miles', () => {
  // The rule the ICD-10 correction bought and the geofence followed: the app
  // must not claim a state it cannot observe.
  assert.strictEqual(myDay.haversineMiles(null, { lat: 33.9, lng: -84.3 }), null);
  assert.strictEqual(myDay.haversineMiles({ lat: 33.9, lng: -84.3 }, null), null);
  // 0,0 is an unset field, not a location in the Gulf of Guinea.
  assert.strictEqual(myDay.haversineMiles({ lat: 0, lng: 0 }, { lat: 33.9, lng: -84.3 }), null);
  assert.strictEqual(myDay.coordsOf({ address: { lat: 0, lng: 0 } }), null);
  assert.strictEqual(myDay.coordsOf({ address: { lat: '', lng: '' } }), null);
  assert.deepStrictEqual(myDay.coordsOf({ address: { lat: 33.9, lng: -84.3 } }), { lat: 33.9, lng: -84.3 });
});

test('a distance is LABELLED straight-line and never presented as drive time', () => {
  // A 3-mile straight line across a river is a 20-minute drive. A clinician
  // planning a day around a number called "drive time" that is really a crow's
  // flight will be late, so the label and the missing provider are both stated.
  const row = myDay.buildDayRow({
    appointment: { eid: '2', startTime: '10:15' },
    client: { id: 'c2', name: 'Robert Williams', address: { lat: 33.94, lng: -84.35 } },
    previousCoords: { lat: 33.88, lng: -84.47 }
  });
  assert.strictEqual(row.distance.kind, 'straight_line');
  assert.strictEqual(row.distance.driveMinutes, null);
  assert.strictEqual(row.distance.reason, myDay.DISTANCE_UNAVAILABLE);
  assert.ok(typeof row.distance.miles === 'number' && row.distance.miles > 0);
});

test('the first stop and an unplaceable stop are different facts', () => {
  const first = myDay.buildDayRow({
    appointment: { eid: '1' }, client: { id: 'c1', address: { lat: 33.8, lng: -84.4 } },
    previousCoords: null
  });
  assert.strictEqual(first.distance.reason, 'first_stop');
  const noCoords = myDay.buildDayRow({
    appointment: { eid: '2' }, client: { id: 'c2', intake: {} },
    previousCoords: { lat: 33.8, lng: -84.4 }
  });
  assert.strictEqual(noCoords.distance.reason, 'no_coordinates');
  assert.strictEqual(noCoords.distance.miles, null);
});

test('a cancelled visit is not a leg, and the mileage total says when it is partial', () => {
  const day = myDay.buildMyDay({
    date: '2026-09-23',
    appointments: [
      { eid: '1', clientId: 'c1', startTime: '08:30', date: '2026-09-23' },
      { eid: '2', clientId: 'c2', startTime: '10:15', date: '2026-09-23', status: 'x' },
      { eid: '3', clientId: 'c3', startTime: '13:30', date: '2026-09-23' },
      { eid: '4', clientId: 'c4', startTime: '15:00', date: '2026-09-23' }
    ],
    clientsById: new Map([
      ['c1', { id: 'c1', name: 'A', address: { lat: 33.80, lng: -84.40 } }],
      // c2 is cancelled and 200 miles away — measuring it as a leg would
      // inflate every mile after it.
      ['c2', { id: 'c2', name: 'B', address: { lat: 31.00, lng: -84.40 } }],
      // c3 MUST have coordinates, or the leg from the cancelled stop is never
      // measured and this fixture cannot tell the two states apart — which is
      // exactly what the first version of it did.
      ['c3', { id: 'c3', name: 'C', address: { lat: 33.82, lng: -84.41 } }],
      ['c4', { id: 'c4', name: 'D', intake: {} }]
    ]),
    timingsByEid: new Map(), signedEids: new Set(),
    unsignedEarlier: [], openTasks: 0, blocks: [], homeVisitFields: []
  });
  assert.strictEqual(day.totals.visits, 3, 'a cancelled visit is not counted');
  assert.strictEqual(day.totals.milesPartial, true);
  assert.strictEqual(day.totals.unplaceableStops, 1, 'c4 has no coordinates');
  assert.strictEqual(day.totals.driveMinutes, null);
  assert.strictEqual(day.totals.driveMinutesReason, myDay.DISTANCE_UNAVAILABLE);
  // Nothing after the cancelled stop was measured from 200 miles south.
  assert.ok((day.totals.miles || 0) < 50, `mileage inflated by the cancelled stop: ${day.totals.miles}`);
  // c1 → c3 is a couple of miles. Measuring through the cancelled c2 would be
  // roughly four hundred, so the fixture can now tell the two states apart.
  assert.ok((day.totals.miles || 0) > 0, 'a real leg must be measured, or this proves nothing');
});

test('the day is ordered by time, whatever order the calendar returned', () => {
  const day = myDay.buildMyDay({
    date: '2026-09-23',
    appointments: [
      { eid: '3', clientId: 'c3', startTime: '13:30', date: '2026-09-23' },
      { eid: '1', clientId: 'c1', startTime: '08:30', date: '2026-09-23' },
      { eid: '2', clientId: 'c2', startTime: '10:15', date: '2026-09-23' }
    ],
    clientsById: new Map(), timingsByEid: new Map(), signedEids: new Set(),
    unsignedEarlier: [], openTasks: 0, blocks: [], homeVisitFields: []
  });
  assert.deepStrictEqual(day.visits.map(v => v.time), ['08:30', '10:15', '13:30']);
});

test('an unsigned note from an earlier day is pinned, oldest first', () => {
  const day = myDay.buildMyDay({
    date: '2026-09-23',
    appointments: [], clientsById: new Map(), timingsByEid: new Map(), signedEids: new Set(),
    unsignedEarlier: [
      { eid: '9', date: '2026-09-20', patientName: 'Later' },
      { eid: '8', date: '2026-09-11', patientName: 'Oldest' },
      // Today's own visit is not backlog, however unsigned it is.
      { eid: '7', date: '2026-09-23', patientName: 'Today' }
    ],
    openTasks: 0, blocks: [], homeVisitFields: []
  });
  assert.deepStrictEqual(day.unsigned.map(u => u.patientName), ['Oldest', 'Later'],
    'oldest first, and today is not backlog');
});

test('the My Day row reads the home-visit facts off the patient', () => {
  const row = myDay.buildDayRow({
    appointment: { eid: '1' },
    client: { id: 'c1', name: 'Mary', homeVisit: { accessInstructions: 'Use side entrance.' } },
    homeVisitFields: [['accessInstructions', 'Access instructions'], ['caregiverPresent', 'Who will be there']]
  });
  assert.deepStrictEqual(row.homeVisit,
    [{ key: 'accessInstructions', label: 'Access instructions', value: 'Use side entrance.' }]);
});

test('route optimisation PROPOSES and never applies', () => {
  const visits = [
    { eid: '1', clientId: 'c1', patientName: 'Far', time: '08:30', state: 'scheduled', coords: { lat: 34.30, lng: -84.40 } },
    { eid: '2', clientId: 'c2', patientName: 'Near', time: '10:15', state: 'scheduled', coords: { lat: 33.81, lng: -84.40 } },
    { eid: '3', clientId: 'c3', patientName: 'Mid', time: '13:30', state: 'scheduled', coords: { lat: 33.95, lng: -84.40 } }
  ];
  const out = myDay.proposeRouteOrder({ visits, startCoords: { lat: 33.80, lng: -84.40 } });
  assert.deepStrictEqual(out.proposal.order.map(o => o.patientName), ['Near', 'Mid', 'Far']);
  assert.match(out.proposal.caveat, /routing provider/i);
  assert.strictEqual(out.proposal.kind, 'straight_line_nearest_neighbour');
  // The module hands back a proposal and holds no power to apply one.
  assert.ok(!('applied' in out.proposal));
});

test('a visit already started is never reordered out from under the clinician', () => {
  const visits = [
    { eid: '1', patientName: 'Started', time: '08:30', state: 'in_progress', coords: { lat: 34.3, lng: -84.4 } },
    { eid: '2', patientName: 'A', time: '10:15', state: 'scheduled', coords: { lat: 33.81, lng: -84.4 } },
    { eid: '3', patientName: 'B', time: '13:30', state: 'scheduled', coords: { lat: 33.95, lng: -84.4 } }
  ];
  const out = myDay.proposeRouteOrder({ visits, startCoords: { lat: 33.8, lng: -84.4 } });
  assert.ok(!out.proposal.order.some(o => o.eid === '1'), 'a started visit is a fixed stop');
  assert.deepStrictEqual(out.proposal.fixedStops, [{ eid: '1', state: 'in_progress' }]);
});

test('the optimize route never writes and says it did not', () => {
  const body = routeBody(serverCode, "app.post('/api/clinical/my-day/optimize'");
  assert.ok(!/db\.set/.test(body), 'proposing an order must not write anything');
  assert.ok(!/reschedule|swapAppointment/.test(body), 'it must not rebook on its own');
  assert.match(body, /applied:\s*false/);
});

// Slice a route from its registration to the NEXT one, rather than by a
// character count. A fixed window is a guard that works only on the code it was
// written against, and this one had already fallen short of its own subject.
const routeBody = (src, needle) => {
  const i = src.indexOf(needle);
  assert.ok(i > 0, `route not registered: ${needle}`);
  const rest = src.slice(i + needle.length);
  const next = rest.search(/\napp\.(get|post|put|delete)\(/);
  return rest.slice(0, next > 0 ? next : rest.length);
};

test('a re-stamp of a time already recorded needs a reason', () => {
  const body = routeBody(serverCode, "app.post('/api/clinical/visits/:eid/timing'");
  assert.match(body, /TIMING_ALREADY_SET/);
  assert.match(body, /!reason/, 'a correction without a reason is refused');
  // The correction keeps the value it replaced, who changed it and why — the
  // same rule every other time correction in this app follows.
  assert.match(body, /next\.corrections = \[/, 'corrections are appended, never overwritten');
  assert.match(body, /from: existing\[field\]/, 'the value being replaced is kept');
  assert.match(body, /reason,/, 'the reason is kept on the correction');
  assert.match(body, /requireClinicalWrite/);
});

test('the timing route refuses an event it does not know, by name', () => {
  const body = routeBody(serverCode, "app.post('/api/clinical/visits/:eid/timing'");
  assert.match(body, /BAD_VISIT_EVENT/);
  assert.match(body, /Object\.keys\(VISIT_TIMING_EVENTS\)/,
    'the refusal names the events that do work rather than dead-ending');
});

test('My Day is the default landing view', () => {
  assert.match(pageCode, /useState\('myday'\)/,
    'the workspace must open on the day, not on a patient list');
  assert.match(pageCode, /<MyDayView/);
});

test('an unreadable calendar is reported, never rendered as an empty day', () => {
  // An empty day and an unreachable calendar look identical on screen and are
  // opposite facts. Same rule as the Drive read and the ICD-10 correction.
  const body = routeBody(serverCode, "app.get('/api/clinical/my-day'");
  // BOTH failure branches, and asserted separately. The first version matched
  // `calendar = { ok: false` once, so gutting the catch block still passed on
  // the not-configured branch — it could not tell the two states apart.
  assert.match(body, /is not configured, so the calendar could not be read/,
    'no EMR configured is reported');
  assert.match(body, /catch \(e\) \{\s*calendar = \{ ok: false/,
    'a calendar READ FAILURE must set ok:false, not silently leave an empty day');
  // THREE ways the calendar can fail, and each reports rather than falling
  // through to an empty day: the caller is not mapped to a provider, no EMR is
  // configured, or the read itself failed.
  assert.match(body, /if \(scopeProblem\) \{\s*calendar = \{ ok: false/,
    'an unmapped provider is reported');
  assert.strictEqual((body.match(/calendar = \{ ok: false/g) || []).length, 3,
    'every failure branch reports, and none falls through to an empty day');
  const pageIdx = pageCode.indexOf('The calendar could not be read');
  assert.ok(pageIdx > 0, 'the screen must say the calendar failed');
  assert.match(pageCode.slice(pageIdx, pageIdx + 400), /not an empty day/);
});

test('the day defaults to today in GEORGIA, not to the container day', () => {
  const body = routeBody(serverCode, "app.get('/api/clinical/my-day'");
  assert.match(body, /practiceToday\(\)/);
  assert.ok(!/toISOString\(\)\.slice\(0, ?10\)/.test(body),
    'for four hours of every evening UTC is already tomorrow');
});

test('NAVIGATE hands off to the device map app', () => {
  assert.match(pageCode, /const navigateHref = /);
  assert.match(pageCode, /maps\.google\.com/);
  const at = pageCode.indexOf('navigateHref(v.address)');
  assert.ok(at > 0, 'the row must offer Navigate');
  // The whole anchor element, not the one line the href happens to sit on.
  const el = pageCode.slice(pageCode.lastIndexOf('<a ', at), pageCode.indexOf('</a>', at));
  assert.match(el, /target="_blank"/);
  assert.match(el, /rel="noopener noreferrer"/);
});

// ===========================================================================
// 9. SCOPE E — the pre-visit packet
// ===========================================================================

test('everything on the packet is derived; nothing is typed twice', () => {
  const packet = myDay.buildPreVisitPacket({
    client: { id: 'c1', name: 'Mary Johnson', homeVisit: { accessInstructions: 'Call daughter before arrival.' } },
    appointment: { title: 'CHF follow-up', date: '2026-09-23', startTime: '08:30' },
    banner: { allergies: { state: 'listed', rows: ['Penicillin'] } },
    lastVisitAt: '2026-09-03',
    activeProblems: [{ description: 'CHF' }, { description: 'DM2' }],
    openOrders: [{ id: 'o1', label: 'BMP', orderType: 'lab', orderedAt: '2026-09-18T00:00:00Z' }],
    unacknowledgedResults: [{ id: 'r1', label: 'BMP', interpretation: 'abnormal' }],
    openReferrals: [{ id: 'f1', specialty: 'Cardiology', status: 'pending' }],
    carePlanGoalsUnmet: ['Weight under 180 lb'],
    homeVisitFields: [['accessInstructions', 'Access instructions']]
  });
  assert.strictEqual(packet.reason, 'CHF follow-up');
  assert.strictEqual(packet.lastVisitAt, '2026-09-03');
  assert.deepStrictEqual(packet.homeVisit,
    [{ key: 'accessInstructions', label: 'Access instructions', value: 'Call daughter before arrival.' }]);
  const kinds = packet.openItems.map(i => i.kind);
  assert.deepStrictEqual(kinds, ['referral', 'order', 'result', 'goal'],
    'open items pull from pending orders, unacknowledged results, open referrals and unmet goals');
  assert.match(packet.openItems[0].text, /Cardiology/);
});

test('the packet loads as ONE request', () => {
  // E3: it is read on a phone in a car, so it must not wait on the full chart.
  assert.match(pageCode, /preVisit: \(id, eid\) =>/);
  const i = pageCode.indexOf('const PreVisitPacket');
  const body = pageCode.slice(i, pageCode.indexOf('\n    const MyDayView'));
  const calls = (body.match(/api\.[a-zA-Z]+\(/g) || []);
  assert.deepStrictEqual([...new Set(calls)], ['api.preVisit('],
    `the packet must make exactly one kind of call, saw ${JSON.stringify(calls)}`);
});

test('the packet carries the allergy strip, with its three states intact', () => {
  const i = pageCode.indexOf('const PreVisitPacket');
  const body = pageCode.slice(i, pageCode.indexOf('\n    const MyDayView'));
  assert.match(body, /<AllergyStrip allergies=/,
    'the packet reuses the banner strip rather than restating what an allergy means');
});

test('visit_timings is claimed in the collection registry', () => {
  // Session 5's guard: a collection nobody claimed fails the migration before a
  // single value is copied.
  const reg = fs.readFileSync(path.join(root, 'dataMigration.js'), 'utf8');
  assert.match(reg, /key: 'visit_timings', phi: true/);
});

// ===========================================================================
// 10. Two defects the LIVE PROBE found and unit tests did not
// ===========================================================================

test('an unmapped provider id degrades the calendar, it does not refuse the day', () => {
  // My Day 409'd for any clinician whose openEmrProviderId is unset — which is
  // every clinician on their first day. The DEFAULT LANDING SCREEN refused to
  // load over one unset field. The backlog, the open-task count and the
  // standing facts all come from this app's own store and are exactly what
  // that clinician still needs.
  const body = routeBody(serverCode, "app.get('/api/clinical/my-day'");
  assert.ok(!/if \(scope\.error\) return res\.status\(409\)/.test(body),
    'a scope problem must not refuse the landing screen');
  assert.match(body, /scopeProblem/, 'it is reported as a calendar problem instead');
  assert.match(body, /if \(scopeProblem\) \{\s*calendar = \{ ok: false/);
});

test('the chart reports the draft state whether or not the patient is EMR-linked', () => {
  // The draft is this app's own row. Leaving it out of the unlinked branch
  // meant the banner's action could never read "Resume draft" on exactly the
  // patients a clinician is most likely to be part-way through a note on.
  const body = routeBody(serverCode, "app.get('/api/clinical/patients/:clientId/chart'");
  // The negative lookahead matters: a bare /visitDraft/ also matches
  // `visitDraftDisabled`, so renaming the key away survived this guard on its
  // first run. It could not distinguish the two states.
  assert.ok((body.match(/visitDraft(?![A-Za-z])/g) || []).length >= 3,
    'both the linked and the unlinked return must carry a visitDraft key');
  assert.match(body, /linked: true, banner, visitDraft,/, 'the linked chart carries it');
  assert.match(body, /visitDraft: \{ open: !!unlinkedDraft/, 'the unlinked chart carries it');
  assert.match(body, /unlinkedDraft/);
  // Both keyed to the CALLER, so a colleague's half-written note is never
  // offered here as something to resume.
  assert.strictEqual((body.match(/noteDraftId\(client\.id, req\.user\.id\)/g) || []).length, 2);
});

// ===========================================================================
// 11. SCOPE D — chart navigation is PLACES, not actions
// ===========================================================================

test('every chart tab is a place in the record, and no workflow is one', () => {
  const i = pageCode.indexOf('const tabs = [');
  const decl = pageCode.slice(i, pageCode.indexOf('];', i));
  const keys = [...decl.matchAll(/\['([a-z]+)',/g)].map(m => m[1]);
  // The brief's twelve places, plus Appointments (the per-patient calendar,
  // kept because removing a working surface is not what a reorganisation is
  // for). Enrollment left for Admin in PR #116.
  ['summary', 'timeline', 'encounters', 'problems', 'medications', 'allergies',
    'orders', 'results', 'imaging', 'referrals', 'documents', 'careplan']
    .forEach(k => assert.ok(keys.includes(k), `missing place: ${k}`));
  // The H&P is NOT a tab — it opens as a visit from the banner.
  assert.ok(!keys.includes('visit'), 'the H&P must not be a sibling tab');
  // Med rec is a section under MEDICATIONS, not a place beside it (D4).
  assert.ok(!keys.includes('medrec'), 'med reconciliation is not its own place');
  assert.ok(!keys.includes('enrollment'), 'enrollment lives in Admin');
});

test('the H&P is still reachable, and says where you are while it is open', () => {
  // Removing it from the tab bar must not strand it. It opens from the
  // banner's Start visit action and from an appointment.
  assert.match(pageCode, /onStartVisit=\{canWrite \? \(\) => setTab\('visit'\) : null\}/);
  assert.match(pageCode, /tab === 'visit' && \(chart \?/, 'the H&P body still renders');
  // With no tab highlighted, a clinician has to be told where they are.
  assert.match(pageCode, /Documenting a visit/);
  assert.match(pageCode, /Back to the chart/);
});

test('med reconciliation renders INSIDE medications', () => {
  const i = pageCode.indexOf('const MedicationsTab');
  const body = pageCode.slice(i, pageCode.indexOf('\n    const DocumentsTab'));
  assert.match(body, /<MedRecTab patient=/);
});

test('the allergies place and the banner strip are the SAME component', () => {
  // Two renderings of "what is this patient allergic to" is how the two start
  // disagreeing, which is the whole reason the strip has three states.
  const i = pageCode.indexOf('const AllergiesTab');
  const body = pageCode.slice(i, pageCode.indexOf('\n    const MedicationsTab'));
  assert.match(body, /<AllergyStrip allergies=\{chart && chart\.banner && chart\.banner\.allergies\}/);
});

test('there is exactly ONE chart section renderer, at module scope', () => {
  // It was declared inside SummaryTab, which is a new function identity on
  // every render. Hoisting it is what lets every place render the same way.
  assert.strictEqual((pageCode.match(/const ChartSection = /g) || []).length, 1);
  const at = pageCode.indexOf('const ChartSection = ');
  assert.match(pageCode.slice(at - 60, at), /\n {4}$/,
    'ChartSection must sit at module scope, not nested inside a component');
  assert.ok(!/const Sec = \(/.test(pageCode), 'the old nested renderer is gone');
});

test('ORDERS, RESULTS, IMAGING and REFERRALS are wired, not placeholders', () => {
  // D2. Session 4.10 shipped all of this with no per-patient place to read it.
  ['OrdersTab', 'ResultsTab', 'ImagingTab', 'ReferralsTab']
    .forEach(c => assert.ok(pageCode.includes(`const ${c} = `), `${c} is not defined`));
  assert.match(pageCode, /patientOrders: \(id\) => authedFetch/);
  assert.match(pageCode, /patientResults: \(id\) => authedFetch/);
  assert.ok(!/TODO|placeholder|coming soon/i.test(
    pageCode.slice(pageCode.indexOf('const OrdersTab'), pageCode.indexOf('const TIMELINE_LABELS'))),
  'none of these may be a placeholder');
});

test('imaging shows a study together with its report', () => {
  // D3. A study and its report read in one place rather than two.
  const i = pageCode.indexOf('const ImagingTab');
  const body = pageCode.slice(i, pageCode.indexOf('\n    const ResultsTab'));
  assert.match(body, /api\.patientResults/);
  assert.match(body, /No report attached yet/);
});

test('an empty place says so in a sentence', () => {
  // I3, applied to the chart: a blank panel and a place with nothing in it are
  // indistinguishable, and only one of them is correct.
  assert.match(pageCode, /const EmptyPlace = /);
  ['No orders on this chart yet', 'No referrals on this chart yet',
    'No results on this chart yet', 'No imaging on this chart yet']
    .forEach(t => assert.ok(pageCode.includes(t), `missing empty state: ${t}`));
});

// ---- D5 TIMELINE ---------------------------------------------------------

test('the timeline is one thread, newest first', () => {
  const t = repo.buildTimeline({
    encounters: [{ date: '2026-09-22', type: 'Home Visit', id: 'e1' }],
    orders: [{ createdAt: '2026-09-12T00:00:00Z', orderType: 'lab', tests: ['BMP'], id: 'o1' }],
    results: [{ receivedAt: '2026-09-18', label: 'BMP', id: 'r1' }]
  });
  assert.deepStrictEqual(t.rows.map(r => r.date), ['2026-09-22', '2026-09-18', '2026-09-12']);
  assert.deepStrictEqual(t.rows.map(r => r.kind), ['visit', 'result', 'order']);
});

test('a documented appointment is not on the thread twice', () => {
  // It is already there as a visit. Showing every documented visit twice is
  // the trap the portal's upcoming/recent merge already paid for.
  const t = repo.buildTimeline({
    encounters: [{ date: '2026-09-22', type: 'Home Visit', id: 'e1' }],
    appointments: [
      { date: '2026-09-22', title: 'the same visit', eid: 'a2', encounterUuid: 'e1' },
      { date: '2026-09-25', title: 'not yet documented', eid: 'a1' }
    ]
  });
  assert.strictEqual(t.rows.filter(r => r.date === '2026-09-22').length, 1);
  assert.strictEqual(t.rows.length, 2);
});

test('a referral is its own kind on the thread, not a generic order', () => {
  const t = repo.buildTimeline({
    orders: [
      { createdAt: '2026-09-15', orderType: 'referral', specialty: 'Cardiology', id: 'o2' },
      { createdAt: '2026-09-12', orderType: 'lab', tests: ['BMP'], id: 'o1' }
    ]
  });
  assert.deepStrictEqual(t.rows.map(r => r.kind), ['referral', 'order']);
  assert.match(t.rows[0].title, /Cardiology/);
});

test('an undated row is COUNTED, never dropped and never sorted to the top', () => {
  // "Nothing here" and "four things could not be placed" are different facts,
  // and only one of them is a data gap worth chasing.
  const t = repo.buildTimeline({
    documents: [{ date: null, description: 'no date' }, { date: '2026-09-01', description: 'dated' }]
  });
  assert.strictEqual(t.undated, 1);
  assert.strictEqual(t.rows.length, 1);
  assert.ok(!t.rows.some(r => !r.date));
});

test('the timeline filters by kind, and an unknown kind narrows to nothing rather than everything', () => {
  const src = {
    results: [{ receivedAt: '2026-09-18', label: 'BMP' }],
    orders: [{ createdAt: '2026-09-12', orderType: 'lab', tests: ['X'] }]
  };
  assert.strictEqual(repo.buildTimeline({ ...src, kinds: ['result'] }).rows.length, 1);
  assert.strictEqual(repo.buildTimeline({ ...src, kinds: [] }).rows.length, 2, 'no filter means everything');
  // A kind nobody declares must not silently widen the filter back to all.
  assert.strictEqual(repo.buildTimeline({ ...src, kinds: ['nonsense'] }).rows.length, 0);
});

test('the timeline asks the messaging module who may read a conversation', () => {
  // That function is where the cross-client leak lived (PR #88). A second
  // implementation of "may this person read this" is how the next one is
  // written. The timeline carries a thread's EXISTENCE and never a body.
  const body = routeBody(serverCode, "app.get('/api/clinical/patients/:clientId/timeline'");
  assert.match(body, /messagingRepo\.threadVisibility\(req\.user, t, \{ client \}\)/);
  assert.ok(!/\bbody\b\s*:\s*(t|thread)\./.test(body), 'a message body must not reach the timeline');
  assert.match(serverCode, /const messagingRepo = require\('\.\/messagingRepository'\)/);
});

// ===========================================================================
// 12. SCOPE I — work queues and analytics
// ===========================================================================

test('the work queues are cross-patient, and each says so when empty', () => {
  const body = routeBody(serverCode, "app.get('/api/clinical/work-queues'");
  ['unsignedEncounters', 'unacknowledgedResults', 'openReferrals', 'overdueOrders']
    .forEach(q => assert.ok(body.includes(q), `missing queue: ${q}`));
  ['Every documented encounter is signed', 'No results are waiting to be acknowledged',
    'No referrals are outstanding', 'Nothing is overdue']
    .forEach(t => assert.ok(pageCode.includes(t), `missing empty state: ${t}`));
});

test('overdue reuses 4.10\'s own builder rather than a second copy of the rule', () => {
  // The first version of this line guarded a function name that does not
  // exist, so the queue would have been permanently empty and nothing would
  // have said so. A defensive check that hides a missing function is worse
  // than the crash it prevents.
  const body = routeBody(serverCode, "app.get('/api/clinical/work-queues'");
  assert.match(body, /orderReq\.buildOverdueList\(orderRows \|\| \[\]\)/);
  assert.ok(!/orderReq\.overdueOrders/.test(body), 'that function does not exist');
  assert.ok(!/OVERDUE_DAYS\s*=/.test(body), 'the thresholds are 4.10\'s, never restated here');
  assert.match(body, /overdueThresholds: orderReq\.OVERDUE_DAYS/);
  const orderReqMod = require('../orderRequisitions');
  assert.strictEqual(typeof orderReqMod.buildOverdueList, 'function');
});

test('results waiting are ordered critical first, then oldest', () => {
  // The same ordering 4.10's inbox uses: the oldest unanswered result is the
  // one most likely to have been forgotten.
  const body = routeBody(serverCode, "app.get('/api/clinical/work-queues'");
  assert.match(body, /critical: 0, abnormal: 1/);
  assert.match(body, /rank\(a\) - rank\(b\) \|\| String\(a\.receivedAt/);
});

test('a metric this app cannot observe is reported as unavailable, never as zero', () => {
  // Miles driven needs a routing provider and screening completion needs the
  // Questionnaire surfacing of Scope J. A zero would read as "nobody drove
  // anywhere" and "no screenings are done", which are different claims.
  const body = routeBody(serverCode, "app.get('/api/clinical/analytics'");
  assert.match(body, /milesDriven: \{ value: null, unavailable: true, reason: myDay\.DISTANCE_UNAVAILABLE \}/);
  assert.match(body, /screeningCompletionRate: \{ value: null, unavailable: true/);
  assert.match(pageCode, /Not available — /);
});

test('all six analytics metrics have a home', () => {
  const body = routeBody(serverCode, "app.get('/api/clinical/analytics'");
  ['visitsPerWeek', 'milesDriven', 'averageVisitMinutes',
    'unsignedNotesAgeing', 'openOrdersAgeing', 'screeningCompletionRate']
    .forEach(m => assert.ok(body.includes(m), `missing metric: ${m}`));
});

test('both new destinations are reachable and neither is hidden when empty', () => {
  // I3: a missing menu item is indistinguishable from a broken one.
  assert.match(pageCode, /setView\('queues'\)/);
  assert.match(pageCode, /setView\('analytics'\)/);
  assert.match(pageCode, /<WorkQueuesView/);
  assert.match(pageCode, /<AnalyticsView/);
  const i = pageCode.indexOf('const VIEW_TITLES');
  const titles = pageCode.slice(i, pageCode.indexOf('};', i));
  assert.match(titles, /queues:/);
  assert.match(titles, /analytics:/);
});

test('the per-patient results read is a READ, so a case manager keeps it', () => {
  const body = routeBody(serverCode, "app.get('/api/clinical/patients/:clientId/results'");
  assert.match(body, /requireClinicalRead/);
  assert.ok(!/requireClinicalWrite/.test(body));
});

// ===========================================================================
// 13. WHERE A CLIENT LIVES HAS ONE READER
// ===========================================================================
// Owner question, 2026-09-23: "why can't we use whatever we use for the
// caregiver side?" The answer is that we already can and should — and asking
// it surfaced a real bug.
//
// There is NO geocoding service anywhere in this app. An admin pastes
// coordinates from Google Maps into /scheduling → Locations, which writes them
// to `client.address.lat/lng`. The geofence has read them since Session 7.

const sched = require('../schedulingRepository');

test('My Day and the geofence read the SAME coordinates', () => {
  // The bug this is written against: My Day wrote its own reader and looked in
  // `client.intake.address` first. That object exists on every enrolled client
  // and carries no coordinates, so it won every time and My Day reported "no
  // coordinates" for the whole practice while the real ones sat one field away.
  const client = {
    id: 'c1',
    address: { lat: 33.88, lng: -84.47 },
    // Present on every enrolled client, and carrying no coordinates.
    intake: { address: { line1: '123 Main St', city: 'Atlanta', state: 'GA' } }
  };
  assert.deepStrictEqual(myDay.coordsOf(client), sched.clientCoords(client));
  assert.deepStrictEqual(myDay.coordsOf(client), { lat: 33.88, lng: -84.47 });
});

test('the two readers agree on every case, not just the happy one', () => {
  [
    { address: { lat: 33.88, lng: -84.47 } },
    { address: { lat: 0, lng: 0 } },                       // unset, not the Gulf of Guinea
    { address: { lat: '', lng: '' } },
    { address: {} },
    { intake: { address: { line1: 'no coordinates here' } } },
    {},
    null
  ].forEach((c, i) => {
    assert.deepStrictEqual(myDay.coordsOf(c), sched.clientCoords(c),
      `the readers disagree on fixture ${i}: ${JSON.stringify(c)}`);
  });
});

test('My Day delegates rather than keeping a second copy of the rule', () => {
  const src = strippedSafely(fs.readFileSync(path.join(root, 'myDay.js'), 'utf8'), 'myDay.js');
  assert.match(src, /const coordsOf = \(client\) => sched\.clientCoords\(client\);/,
    'one answer to "where does this client live", owned by the module that owns the write');
  assert.ok(!/client\.intake\.address/.test(src),
    'the intake address carries no coordinates and must not be consulted for them');
});

test('the dependency runs clinical → scheduling, never the reverse', () => {
  // test/scheduling.test.js forbids the scheduling module requiring the EMR
  // client or reaching into /api/clinical/. This direction is the safe one, and
  // asserting it here keeps that asymmetry deliberate rather than accidental.
  const myDaySrc = fs.readFileSync(path.join(root, 'myDay.js'), 'utf8');
  const schedSrc = fs.readFileSync(path.join(root, 'schedulingRepository.js'), 'utf8');
  assert.match(myDaySrc, /require\('\.\/schedulingRepository'\)/);
  assert.ok(!/require\(\s*['"]\.\/myDay['"]\s*\)/.test(schedSrc),
    'scheduling must not depend back on the clinical day');
  assert.ok(!/require\(\s*['"][./]*openemr['"]\s*\)/i.test(schedSrc),
    'and pulling myDay in must not have dragged the EMR client into the scheduling lane');
});
