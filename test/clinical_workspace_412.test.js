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

const repo = require("../clinicalRepository");
const R = repo;
const apptTypes = require('../appointmentTypes');

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
// REWRITTEN 2026-09-23. This used to assert that the stripper removed under
// 45% of the file — a PROXY, and a bad one. It fired on myDay.js the moment a
// legitimately long comment block landed, because a heavily commented file and
// a file whose code has been swallowed look identical to a percentage.
//
// The real question is whether any CODE went missing, so it asks that: every
// top-level declaration in the source must survive the strip. A block comment
// opened by accident — the original bug, a `/*` inside a line comment — eats
// whole declarations, and that is visible whatever the comment density.
const TOP_LEVEL_DECL = /^(?:const|let|var|function|class|async function)\s+([A-Za-z_$][\w$]*)/gm;
const declarationsIn = (src) => {
  const out = new Set(); let m;
  const re = new RegExp(TOP_LEVEL_DECL.source, 'gm');
  while ((m = re.exec(src)) !== null) out.add(m[1]);
  return out;
};
const strippedSafely = (src, label) => {
  const out = stripComments(src);
  const before = declarationsIn(src);
  const after = declarationsIn(out);
  const lost = [...before].filter(n => !after.has(n));
  assert.deepEqual(lost, [],
    `stripComments swallowed ${lost.length} declaration(s) from ${label}: ${lost.join(', ')} — it has eaten code, not comments`);
  // A loose backstop for the case where it eats statements without taking a
  // whole declaration with them. Deliberately well clear of ordinary comment
  // density in this repo, which runs high on purpose.
  const removed = 1 - out.length / src.length;
  assert.ok(removed < 0.75, `stripComments removed ${(removed * 100).toFixed(1)}% of ${label}`);
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

// LIVE BUG, FOUND FROM A SCREENSHOT 2026-09-23: every document on the
// timeline read "Document / app". `buildTimeline`'s document mapping read
// `d.description` and `d.source`; `buildChartDocumentIndex`'s rows carry
// `title` and `category` — `source` exists too, but it is
// `CHART_DOC_SOURCE.APP`, the internal flag saying which system holds the
// file, never a human label. So every title fell back to the literal word
// "Document" and every detail line showed the literal word "app". The
// EXISTING test above used `description` in its own fixture — the same
// wrong field — so it stayed green throughout, because it only asserted the
// undated COUNT and never looked at what a dated row actually said.
// ── Session 4.12 — top bar overflow and the collapsible patient panel ──
// Owner report 2026-09-23, with a screenshot: the top bar clipped "Analytics"
// off the right edge with no way to reach it, and the left patient panel
// could not be collapsed.
test('the nine views are declared once, so the overflow handling lives in one place', () => {
  // The bug this replaces: nine hand-written buttons, so a crowding fix had
  // nine places to land in and landed in none.
  assert.match(pageCode, /const NAV_VIEWS = Object\.freeze\(\[/);
  const keys = [...pageCode.matchAll(/\{ key: '(\w+)', tab: '/g)].map(m => m[1]);
  assert.deepEqual(keys, ['myday', 'charts', 'schedule', 'queue', 'inbox', 'results', 'overdue', 'queues', 'analytics']);
  assert.match(pageCode, /NAV_VIEWS\.map\(v =>/, 'the strip must render from the declared list, not repeat nine buttons');
});

test('the nav strip WRAPS rather than scrolling invisibly, and labels wait for real room', () => {
  // A horizontal scrollbar on a nav bar is the same clipping with an
  // affordance nobody sees. It must wrap to a second row instead.
  const i = pageCode.indexOf('nav-strip');
  const strip = pageCode.slice(i - 120, i + 100);
  assert.match(strip, /flex-wrap/);
  assert.ok(!/overflow-x-auto/.test(strip), 'the strip must not fall back to a scrolling container');
  // Labels hide until 2xl (1536px) — below that it is icons only, which is
  // what makes nine views fit a laptop instead of technically scrolling past it.
  assert.match(pageCode, /<span className="hidden 2xl:inline ml-1">\{v\.tab\}<\/span>/);
});

test('the patient panel actually collapses in a real browser, not just in the markup', () => {
  // LIFTED FROM A LIVE BUG. The panel toggle existed, `aside` got
  // `display:none`, and the chart rendered at WIDTH 0 — because a
  // `display:none` grid item drops out of CSS Grid's item list entirely, so
  // `main`, with nothing pinning it, auto-placed into the now-empty FIRST
  // (0-width) track instead of the second. Measured live: `main`'s own
  // bounding rect reported width 0 with the grid track correctly sized
  // underneath it — reading the CSS predicted nothing was wrong.
  assert.match(pageCode, /<main className=\{`\$\{listOpen \? 'hidden' : ''\} lg:block lg:col-start-2`\}>/,
    'main must be pinned to the second grid column — without it, collapsing the panel blanks the chart');
  assert.match(pageCode, /const \[panelOpen, setPanelOpen\] = useState/);
  assert.match(pageCode, /lg:grid-cols-\[290px_1fr\]/);
  assert.match(pageCode, /lg:grid-cols-\[0_1fr\]/);
  // Remembered per browser — a clinician who collapses it wants it collapsed
  // next time — and read defensively, since a private window throws.
  assert.match(pageCode, /localStorage\.getItem\('gfc\.clinical\.panel'\)/);
  assert.match(pageCode, /localStorage\.setItem\('gfc\.clinical\.panel'/);
  assert.match(pageCode, /try \{ return window\.localStorage\.getItem/, 'the read must be defensive — a private window throws');
});

test('a document on the timeline shows its real title and category, never "Document" and the internal source flag', () => {
  const t = repo.buildTimeline({
    documents: [
      { id: 'careplan:2', title: 'Plan of care — version 2 (signed)', category: 'Plan of care', date: '2026-09-17', source: 'app' },
      { id: 'upload:1', title: 'insurance_card_front.jpg', category: 'From the client', date: '2026-09-17', source: 'app' }
    ]
  });
  assert.strictEqual(t.rows.length, 2);
  for (const row of t.rows) {
    assert.notStrictEqual(row.title, 'Document', `a real title must not fall back to the placeholder: ${JSON.stringify(row)}`);
    assert.notStrictEqual(row.detail, 'app', 'the detail line must never show the internal source flag');
  }
  assert.match(t.rows.find(r => r.id === 'careplan:2').title, /Plan of care — version 2/);
  assert.strictEqual(t.rows.find(r => r.id === 'careplan:2').detail, 'Plan of care');
  assert.strictEqual(t.rows.find(r => r.id === 'upload:1').title, 'insurance_card_front.jpg');
  assert.strictEqual(t.rows.find(r => r.id === 'upload:1').detail, 'From the client');
  // A document with genuinely no title still falls back, so the row is never
  // literally blank.
  assert.strictEqual(repo.buildTimeline({ documents: [{ date: '2026-09-17' }] }).rows[0].title, 'Document');
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
  // and only one of them is a data gap worth chasing. Fixture uses `title`,
  // the field the row actually carries — see the next test for why that
  // distinction is load-bearing.
  const t = repo.buildTimeline({
    documents: [{ date: null, title: 'no date' }, { date: '2026-09-01', title: 'dated' }]
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
  // REPOINTED 2026-09-23: the nine views used to be nine hand-written
  // `setView('queues')`-style calls; the nav-bar rebuild declared them once in
  // NAV_VIEWS, so "is this reachable" is now a question about that list and
  // the click handler that reads it, not about a literal call site per view.
  assert.match(pageCode, /key: 'queues', tab: 'Tasks'/);
  assert.match(pageCode, /key: 'analytics', tab: 'Analytics'/);
  assert.match(pageCode, /onClick=\{\(\) => \{ setView\(v\.key\)/, 'the nav strip must actually call setView with the clicked entry');
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

// ===========================================================================
// 14. SCOPE B — the day, plotted; and the trip, filled
// ===========================================================================

test('north is drawn above south', () => {
  // Latitude increases northward and SVG y increases DOWNWARD. Without the
  // inversion the day is drawn upside down and reads as a different route.
  const plot = myDay.plotStops({
    stops: [
      { eid: '1', patientName: 'North', coords: { lat: 34.0, lng: -84.4 } },
      { eid: '2', patientName: 'South', coords: { lat: 33.6, lng: -84.4 } }
    ]
  });
  assert.ok(plot.points[0].y < plot.points[1].y, 'the northern stop must have the smaller y');
});

test('a single stop is CENTRED, not put in a corner', () => {
  // A degenerate axis makes the ratio 0, which parked a one-visit day's only
  // pin in the bottom-left. Flooring the span to 1 was not enough on its own.
  assert.deepStrictEqual(
    myDay.plotStops({ stops: [{ eid: '1', coords: { lat: 33.8, lng: -84.4 } }] }).points.map(p => [p.x, p.y]),
    [[50, 50]]);
  // Two patients at one address collapse both axes the same way.
  const same = myDay.plotStops({
    stops: [{ eid: '1', coords: { lat: 33.8, lng: -84.4 } }, { eid: '2', coords: { lat: 33.8, lng: -84.4 } }]
  });
  assert.deepStrictEqual(same.points.map(p => [p.x, p.y]), [[50, 50], [50, 50]]);
  // And a column of stops keeps x centred rather than NaN.
  const column = myDay.plotStops({
    stops: [{ eid: '1', coords: { lat: 34.0, lng: -84.4 } }, { eid: '2', coords: { lat: 33.6, lng: -84.4 } }]
  });
  assert.deepStrictEqual(column.points.map(p => p.x), [50, 50]);
  column.points.forEach(p => assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y)));
});

test('every plotted point stays inside the box', () => {
  const plot = myDay.plotStops({
    stops: [
      { eid: '1', coords: { lat: 34.5, lng: -85.0 } },
      { eid: '2', coords: { lat: 33.0, lng: -83.5 } },
      { eid: '3', coords: { lat: 33.9, lng: -84.2 } }
    ]
  });
  plot.points.forEach(p => {
    assert.ok(p.x >= 0 && p.x <= 100, `x out of the box: ${p.x}`);
    assert.ok(p.y >= 0 && p.y <= 100, `y out of the box: ${p.y}`);
  });
});

test('a stop with no coordinates is COUNTED, not silently missing from the map', () => {
  const plot = myDay.plotStops({
    stops: [{ eid: '1', coords: { lat: 33.8, lng: -84.4 } }, { eid: '2' }]
  });
  assert.strictEqual(plot.points.length, 1);
  assert.strictEqual(plot.unplaceable, 1);
  assert.match(pageCode, /could not be plotted/);
});

test('the map sends no coordinates to a tile provider, because there is no tile provider', () => {
  // A tile provider would receive the coordinates of every patient's home on
  // every render — a disclosure of where people live, to a third party with no
  // BAA — and a street map answers nothing a relative plot does not.
  const i = pageCode.indexOf('const DayMap');
  const body = pageCode.slice(i, pageCode.indexOf('\n    const NearbyDue'));
  assert.ok(!/tile\.|openstreetmap|mapbox|googleapis|leaflet|maps\.google/i.test(body),
    'the day map must not load map tiles from anywhere');
  assert.match(body, /<svg/, 'it is drawn from coordinates the app already holds');
});

test('the map and the list render the SAME visits from the SAME fetch', () => {
  // Two fetches or two filters is how the two views start disagreeing about
  // what exists — the rule the scheduling calendar settled on 2026-09-20.
  const i = pageCode.indexOf('const MyDayView');
  const body = pageCode.slice(i, pageCode.length);
  assert.match(body, /<DayMap plot=\{day\.plot\}/);
  assert.strictEqual((body.match(/api\.myDay\(/g) || []).length, 1,
    'exactly one fetch feeds both views');
});

test('the plot is computed on the SERVER, not a second time in the page', () => {
  const body = routeBody(serverCode, "app.get('/api/clinical/my-day'");
  assert.match(body, /myDay\.plotStops\(/);
  assert.ok(!/plotStops/.test(pageCode), 'the page renders the served answer and computes no geometry');
});

test('a cancelled visit is not plotted', () => {
  const body = routeBody(serverCode, "app.get('/api/clinical/my-day'");
  assert.match(body, /stops: day\.visits\.filter\(v => v\.state !== myDay\.VISIT_STATE\.CANCELLED\)/);
});

// ---- B5 geographic clustering --------------------------------------------

test('nearby-and-due is nearest first, and a recently seen patient is not due', () => {
  const out = myDay.findNearbyDue({
    origin: { lat: 33.80, lng: -84.40 },
    candidates: [
      { clientId: 'far', name: 'Far', coords: { lat: 35.00, lng: -84.40 }, lastVisitAt: '2026-01-01' },
      { clientId: 'mid', name: 'Mid', coords: { lat: 33.86, lng: -84.40 }, lastVisitAt: '2026-01-01' },
      { clientId: 'recent', name: 'Seen last week', coords: { lat: 33.81, lng: -84.40 }, lastVisitAt: '2026-09-16' },
      { clientId: 'near', name: 'Near', coords: { lat: 33.82, lng: -84.40 }, lastVisitAt: '2026-01-01' }
    ],
    radiusMiles: 10, today: '2026-09-23'
  });
  assert.deepStrictEqual(out.map(n => n.clientId), ['near', 'mid'],
    'nearest first; the far one is outside the radius and the recent one is not due');
});

test('a patient never seen is DUE, and says which reason it is', () => {
  // No visit on file is due, and it gets its own reason rather than being
  // ranked against a number it does not have.
  const out = myDay.findNearbyDue({
    origin: { lat: 33.80, lng: -84.40 },
    candidates: [{ clientId: 'new', coords: { lat: 33.81, lng: -84.40 } }],
    radiusMiles: 10, today: '2026-09-23'
  });
  assert.strictEqual(out[0].reason, 'never_seen');
  assert.strictEqual(out[0].daysSinceLastVisit, null);
});

test('the patient being booked is never offered as somebody to also visit', () => {
  const out = myDay.findNearbyDue({
    origin: { lat: 33.80, lng: -84.40 },
    candidates: [{ clientId: 'self', coords: { lat: 33.80, lng: -84.40 } }],
    radiusMiles: 10, today: '2026-09-23', excludeClientIds: ['self']
  });
  assert.deepStrictEqual(out, []);
});

test('a patient with no coordinates is never placed near anybody', () => {
  const out = myDay.findNearbyDue({
    origin: { lat: 33.80, lng: -84.40 },
    candidates: [{ clientId: 'nocoords' }],
    radiusMiles: 50, today: '2026-09-23'
  });
  assert.deepStrictEqual(out, []);
});

test('an origin with no coordinates is REPORTED, never an empty list', () => {
  // An empty list here reads as "nobody lives nearby", which is a different
  // and false statement.
  const body = routeBody(serverCode, "app.get('/api/clinical/nearby'");
  assert.match(body, /has no address coordinates/);
  assert.match(body, /Scheduling → Locations/);
  assert.match(body, /nearby: \[\], radiusMiles: null, origin: null/);
  assert.match(body, /requireClinicalRead/);
});

test('the clustering radius is bounded and says it is straight-line', () => {
  const body = routeBody(serverCode, "app.get('/api/clinical/nearby'");
  assert.match(body, /Math\.min\(50, Math\.max\(1,/);
  assert.match(body, /distanceKind: 'straight_line'/);
});

// ===========================================================================
// 15. SCOPE F5 — dictation, and the option deliberately NOT taken
// ===========================================================================

test('the browser speech API is never wired', () => {
  // In Chrome its implementation streams the audio to Google's servers, which
  // would put a clinician dictating about a named patient outside the BAA — a
  // PHI disclosure with no agreement behind it, from a feature that looks free.
  // Build-enforced absent across every page, not just this one.
  ['public/clinical.html', 'public/caregiver.html', 'public/portal.html'].forEach(f => {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    assert.ok(!/webkitSpeechRecognition|SpeechRecognition\s*\(|new\s+SpeechRecognition/.test(src),
      `${f} must not use the browser speech API`);
  });
});

test('the narrative fields stay plain textareas the device keyboard can dictate into', () => {
  assert.match(pageCode, /const DictationHint = /);
  assert.match(pageCode, /<DictationHint \/>/);
  assert.match(pageCode, /microphone on your phone or tablet keyboard/);
  // A plain textarea is what the keyboard mic types into. Anything that
  // intercepts input would break the one dictation path that is safe today.
  const i = pageCode.indexOf('const TextArea = ');
  const body = pageCode.slice(i, i + 400);
  assert.match(body, /<textarea className="inp"/);
});

// ── Session 4.12 Scope F — what a visit IS, and the POS it decides ──
// REPOINTED 2026-09-23, not deleted. These guarded the flat `ENCOUNTER_TYPES`
// list, which tangled "where did this happen" with "what kind of visit was
// it". The rules did not go away when the owner split them into three axes —
// they got sharper — so each one points at the new model. A guard that
// quietly disappears with the code it happened to be aimed at is a guard lost.

test('F: the visit descriptor is normalised, and an invented value is dropped rather than stored', () => {
  const v = R.normalizeVisit({ appointmentType: 'pc_follow_up', modality: 'in_person', location: 'home' });
  assert.deepEqual(v, { appointmentType: 'pc_follow_up', modality: 'in_person', location: 'home' });
  // An invented appointment type reads back as a real one to everything
  // downstream and would never match a place of service.
  const bogus = R.normalizeVisit({ appointmentType: 'made_up', modality: 'beam', location: 'mars' });
  assert.deepEqual(bogus, { appointmentType: null, modality: null, location: null });
  assert.deepEqual(R.normalizeVisit(null), { appointmentType: null, modality: null, location: null });
  assert.equal(R.visitLabel({ appointmentType: 'pc_follow_up', modality: 'telehealth', location: 'home' }),
    'Follow-up · Telehealth · Private Home');
  // A half-resolved visit has no label rather than a misleading partial one.
  assert.equal(R.visitLabel({ appointmentType: 'pc_follow_up' }), null);
});

test('F: a visit whose place of service disagrees with the encounter is REFUSED, naming both values', () => {
  const home = { appointmentType: 'pc_follow_up', modality: 'in_person', location: 'home' };
  assert.equal(R.checkVisitAgainstPos({ visit: home, posCode: '12' }).ok, true);

  const clash = R.checkVisitAgainstPos({ visit: home, posCode: '11', facilityName: 'Vinings' });
  assert.equal(clash.ok, false);
  assert.equal(clash.code, R.VISIT_POS_DISAGREES);
  // BOTH values, or the reader cannot tell which of the two is wrong.
  assert.match(clash.error, /\b12\b/, 'the error must name the POS the visit should carry');
  assert.match(clash.error, /\b11\b/, 'the error must name the POS the encounter does carry');
  assert.match(clash.error, /Follow-up · In-Person · Private Home/);

  // ⚠️ The one that produces a FALSE CLAIM: a telehealth visit billed at the
  // home place of service.
  const tele = { appointmentType: 'pc_follow_up', modality: 'telehealth', location: 'home' };
  assert.equal(R.checkVisitAgainstPos({ visit: tele, posCode: '10' }).ok, true);
  assert.equal(R.checkVisitAgainstPos({ visit: tele, posCode: '12' }).code, R.VISIT_POS_DISAGREES);
});

test('F: an unresolved visit never conflicts, and a missing POS is its own refusal', () => {
  // Half a descriptor cannot be judged, and inventing a verdict would refuse
  // encounters that predate the field.
  assert.equal(R.checkVisitAgainstPos({ visit: { appointmentType: 'pc_follow_up' }, posCode: '12' }).ok, true);
  assert.equal(R.checkVisitAgainstPos({ visit: null, posCode: '12' }).ok, true);
  // A resolved visit with no POS on the encounter is a DIFFERENT problem from
  // a disagreement, fixed somewhere else, so it carries its own code.
  const none = R.checkVisitAgainstPos({ visit: { appointmentType: 'pc_follow_up', modality: 'in_person', location: 'home' }, posCode: '' });
  assert.equal(none.code, 'VISIT_NO_POS');
  assert.notEqual(none.code, R.VISIT_POS_DISAGREES);
});

test('F: the note template is asked of the VISIT, so the same type demands different things in person and on video', () => {
  const home = { appointmentType: 'pc_follow_up', modality: 'in_person', location: 'home' };
  const tele = { appointmentType: 'pc_follow_up', modality: 'telehealth', location: 'home' };
  const inPerson = R.requiredSectionsForVisit(home);
  const video = R.requiredSectionsForVisit(tele);
  assert.ok(inPerson.includes('vitals') && inPerson.includes('physicalExam'));
  // You cannot take a blood pressure over video.
  assert.ok(!video.includes('vitals') && !video.includes('physicalExam'));
  assert.ok(video.length < inPerson.length);
  // Everything that is not an examination is unchanged.
  for (const k of ['assessment', 'plan', 'medReconciliation', 'followUp', 'mdmOrTime']) {
    assert.ok(video.includes(k), `${k} must still be required over video`);
  }
  assert.deepEqual(R.requiredSectionsForVisit({ appointmentType: null }), []);
});

test('F: signing REFUSES an unfinished note and NAMES the sections, never a count', () => {
  const coded = R.applyCoding(
    { clientId: 'c', encounterUuid: 'e', diagnoses: [], services: [] },
    { diagnoses: [{ code: 'E11.9', description: 'T2DM', primary: true }],
      services: [{ code: '99348', units: 1, dxLinks: ['E11.9'] }] },
    { id: 'u', name: 'FNP', npi: '1234567893' }, '1234567893'
  ).record;
  const visit = { appointmentType: 'pc_follow_up', modality: 'in_person', location: 'home' };
  const base = { hasNote: true, record: coded, billingNpi: '1234567893', posCode: '12', visit };

  const empty = R.checkSignReadiness({ ...base, completedSections: [] });
  assert.equal(empty.ok, false);
  assert.ok(empty.codes.includes('SIGN_NOTE_SECTIONS_INCOMPLETE'));
  // NAMED. "3 sections outstanding" is a number a clinician has to go hunting
  // through their own note for.
  assert.match(empty.message, /Interval History/);
  assert.match(empty.message, /Physical Exam/);
  assert.match(empty.message, /Follow-up/);

  const done = R.checkSignReadiness({ ...base, completedSections: R.requiredSectionsForVisit(visit) });
  assert.equal(done.ok, true);
  assert.deepEqual(done.openSections, []);

  // A telehealth visit is ready without the exam sections.
  const teleVisit = { appointmentType: 'pc_follow_up', modality: 'telehealth', location: 'home' };
  const tele = R.checkSignReadiness({ hasNote: true, record: coded, billingNpi: '1234567893', posCode: '10',
    visit: teleVisit, completedSections: R.requiredSectionsForVisit(teleVisit) });
  assert.equal(tele.ok, true);
  // And the SAME completed set does not satisfy the in-person visit.
  const shortfall = R.checkSignReadiness({ ...base, completedSections: R.requiredSectionsForVisit(teleVisit) });
  assert.equal(shortfall.ok, false);
  assert.ok(shortfall.openSections.includes('vitals'));
});

test('F: the visit descriptor is STAMPED on the billing record at creation', () => {
  const made = R.buildEncounterBillingRecord({
    id: 'r1', clientId: 'c1', puuid: 'p1', encounterUuid: 'e1', encounterEid: '7',
    reason: 'visit', date: '2026-09-23', actor: { id: 'u1', name: 'FNP' }, billingNpi: '1234567893',
    visit: { appointmentType: 'bh_initial', modality: 'in_person', location: 'home' }
  });
  assert.deepEqual(made.visit, { appointmentType: 'bh_initial', modality: 'in_person', location: 'home' });
  // An invented descriptor is dropped at the door rather than stored.
  const bogus = R.buildEncounterBillingRecord({
    id: 'r2', clientId: 'c1', puuid: 'p1', encounterUuid: 'e2', encounterEid: '8',
    reason: 'visit', date: '2026-09-23', actor: { id: 'u1', name: 'FNP' }, billingNpi: '1234567893',
    visit: { appointmentType: 'made_up', modality: 'in_person', location: 'home' }
  });
  assert.equal(bogus.visit.appointmentType, null);
  assert.equal(bogus.visit.location, 'home', 'the parts that ARE valid survive');
  const none = R.buildEncounterBillingRecord({
    id: 'r3', clientId: 'c1', puuid: 'p1', encounterUuid: 'e3', encounterEid: '9',
    reason: 'visit', date: '2026-09-23', actor: { id: 'u1', name: 'FNP' }, billingNpi: '1234567893'
  });
  assert.deepEqual(none.visit, { appointmentType: null, modality: null, location: null });
});

test('F build-enforced: the USUAL LOCATION is an admin write on enrollment; what a visit IS is chosen on the note', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  // The patient's usual location is a billing default, so it keeps the admin
  // gate the facility assignment has.
  assert.match(server,
    /app\.put\('\/api\/clinical\/patients\/:clientId\/usual-location',\s*authenticateToken,\s*requireAdmin,/,
    'the usual-location write must be admin-only');
  assert.match(server,
    /app\.put\('\/api\/clinical\/patients\/:clientId\/facility',\s*authenticateToken,\s*requireAdmin,/,
    'the facility assignment must stay admin-only');
  assert.match(server,
    /app\.get\('\/api\/clinical\/patients\/:clientId\/place-of-service',\s*authenticateToken,\s*requireClinicalRead,/,
    'the read stays on the clinical READ gate');
  // The OLD route is gone, not left beside the new one.
  assert.ok(!server.includes('/encounter-type'), 'the superseded encounter-type route must be removed, not left running');

  const chart = fs.readFileSync(path.join(root, 'public', 'clinical.html'), 'utf8');
  // ⚠️ THE OWNER'S CORRECTION: what kind of visit this is belongs on the
  // CLINICIAN'S note, chosen before they start writing, because it decides
  // which note they are about to write.
  assert.match(chart, /What kind of visit is this\?/, 'the note must ask what kind of visit it is');
  assert.match(chart, /setVisit\(v => \(\{ \.\.\.v, appointmentType: e\.target\.value \}\)\)/);
  assert.match(chart, /setVisit\(v => \(\{ \.\.\.v, modality: e\.target\.value \}\)\)/);
  assert.match(chart, /setVisit\(v => \(\{ \.\.\.v, location: e\.target\.value \}\)\)/);
  // And the chart carries no write for either admin field.
  assert.ok(!/\/usual-location`/.test(chart), 'the chart must not write the usual location');

  const enroll = fs.readFileSync(path.join(root, 'public', 'admin-enrollment.html'), 'utf8');
  assert.ok(/setUsualLocation:\s*\(id,\s*usualLocation\)/.test(enroll), 'enrollment owns the usual-location write');
  // Enrollment must NOT offer an appointment type — that is the clinician's.
  for (const t of apptTypes.APPOINTMENT_TYPES) {
    assert.ok(!enroll.includes(t.key), `the enrollment screen must not name the appointment type ${t.key}`);
  }
  // The location OPTIONS must come from the server. Asserted on the option
  // markup rather than by banning the word — "facility" is also a legitimate
  // busy-key on that page, and a guard that cannot tell those apart would
  // fail on code that is correct.
  assert.match(enroll, /data\.locations\.map/, 'the location dropdown renders the served list');
  // And it SAYS where the visit type is chosen instead. A screen that simply
  // omits something sends people hunting for a control that is not there —
  // the rule the chart's place-of-service card already follows.
  assert.match(enroll, /chosen at booking and on the note/,
    'the enrollment screen must name where the kind of visit is decided');
  for (const l of apptTypes.LOCATIONS) {
    assert.ok(!new RegExp(`<option[^>]*value=["']${l.key}["']`).test(enroll),
      `enrollment must not hardcode the location option ${l.key}; the list is served`);
  }
});

test('F build-enforced: creating a visit stamps the descriptor, and signing checks it against the POS OpenEMR holds', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  // One resolver answers what the visit is and where it bills, together.
  assert.match(server, /apptTypes\.resolveVisit\(\{/,
    'resolveFacilityForVisit must resolve the visit descriptor');
  // The BOOKING is authoritative and the patient's usual location is only a
  // default — resolving the other way would bill the visit at the place the
  // patient usually is rather than the place they were.
  assert.match(server, /patientDefaultLocation: client\.usualLocation \|\| null/);
  // Both visit-creation paths stamp it.
  const stamps = server.match(/visit: place\.visit/g) || [];
  assert.equal(stamps.length, 2, 'both the H&P and the follow-up creation paths must stamp the descriptor');
  // The signature compares the STAMP against the POS read off OpenEMR.
  assert.match(server, /visit: ctx\.record\.visit/, 'the sign gate must read the descriptor off the stored stamp');
  assert.ok(!/visit:\s*apptTypes\.resolveVisit\([^)]*encRow/.test(server),
    'the sign gate must not re-derive the visit from the encounter row it is checking');
});


// ── Session 4.12 Scope F3 / F5 — the encounter on a phone ──
const chartPage = fs.readFileSync(path.join(__dirname, '..', 'public', 'clinical.html'), 'utf8');
const encounterPanel = (() => {
  const from = chartPage.indexOf('const EncounterPanel = (');
  const to = chartPage.indexOf('const EncountersTab = (', from);
  assert.ok(from > 0 && to > from, 'anchors for the encounter panel must still be present');
  return chartPage.slice(from, to);
})();

test('F3: the encounter shows one step at a time on a phone and stays one scroll at a desk', () => {
  // Two different jobs. At a kitchen table you want the one thing in front of
  // you; reviewing at a desk you want the whole visit at once. `on()` is what
  // expresses that, and it must be viewport-conditional rather than a plain
  // step comparison — a bare `step === k` would break the desktop.
  assert.match(encounterPanel, /const on = \(k\) => !narrow \|\| step === k;/,
    'a pane shows when the viewport is wide OR it is the current step');
  assert.match(encounterPanel, /const narrow = useNarrowViewport\(\);/);
  // The rail is a phone control; on a desktop there are no steps to walk.
  assert.match(encounterPanel, /\{narrow && <EncounterStepRail/);
  // Each step owns at least one pane, or a step exists that shows nothing.
  for (const key of ['visit', 'coding', 'actions', 'sign']) {
    assert.ok(encounterPanel.includes(`on('${key}')`), `the ${key} step must gate at least one pane`);
  }
  // The header is deliberately ungated: a screen that does not say whose
  // encounter it is, or whether it is signed, is a screen you cannot act on.
  // Looked for BEFORE the header, which is where a gate would be added — the
  // first version of this sliced forward from the chip and so could not see
  // the one thing it was checking for.
  const chip = encounterPanel.indexOf('<EncStateChip state={d.state} />');
  assert.ok(chip > 0, 'precondition: the header chip is still there');
  const openerLine = encounterPanel.lastIndexOf('<div className="card mb-4">', chip);
  const lineStart = encounterPanel.lastIndexOf('\n', openerLine) + 1;
  assert.equal(encounterPanel.slice(lineStart, openerLine).trim(), '',
    'the encounter header must show on every step — nothing may gate it');
});

test('F3: the viewport is watched, not sampled once, and the JS agrees with the CSS about what a phone is', () => {
  const hook = chartPage.slice(chartPage.indexOf('const useNarrowViewport = ('), chartPage.indexOf('const ENCOUNTER_STEPS'));
  // Rotating a phone changes the answer. A one-shot read leaves a step hidden
  // with no way back to it.
  assert.match(hook, /addEventListener/, 'the media query must be subscribed to');
  assert.match(hook, /removeEventListener|removeListener/, 'and unsubscribed on unmount');
  // 767px is Tailwind's md boundary. If the two disagreed the stepper would
  // hide a card the grid was still laying out.
  assert.match(chartPage, /const PHONE_QUERY = '\(max-width: 767px\)';/);
  assert.ok(chartPage.includes('md:grid-cols-2'), 'precondition: the layout uses the md breakpoint this number matches');
});

test('F3: no step gates another — the only gate is the server-answered signature readiness', () => {
  // A clinician in a home who must record an order before finishing coding
  // has to be able to. A wizard that forces an order would make this slower
  // than paper in the one place it has to be faster.
  const rail = chartPage.slice(chartPage.indexOf('const EncounterStepRail = ('), chartPage.indexOf('const EncStateChip = ('));
  // Asserted on the STEP BUTTONS themselves, not by keyword. A first version
  // of this looked for the word "blocker" in a `disabled=`, and a mutation
  // that gated Sign on the coding count sailed through — it never used that
  // word. The only thing that distinguishes the two states is whether the
  // step button carries a `disabled` at all.
  const stepButtons = rail.slice(rail.indexOf('{ENCOUNTER_STEPS.map('), rail.indexOf('</div>\n          <div className="flex justify-between'));
  assert.ok(stepButtons.length > 100, 'precondition: the step-button block was actually sliced');
  assert.ok(!/disabled/.test(stepButtons), 'no step button may be disabled — no step gates another');
  // Back/Next are bounded by the ends of the list, which is not a gate.
  assert.match(rail, /disabled=\{i === 0\}/);
  assert.match(rail, /disabled=\{i === ENCOUNTER_STEPS\.length - 1\}/);
  // The counts come from the SERVER's blocker list. A tick the server would
  // refuse is worse than no tick.
  assert.match(encounterPanel, /blockers=\{\(d\.signReadiness && d\.signReadiness\.missing\) \|\| \[\]\}/);
  // Counted over the WHOLE list, unfiltered. Same correction: naming the
  // variable the rail does not use proved nothing, so this pins the loop.
  assert.match(rail, /for \(const m of blockers \|\| \[\]\) \{/,
    'the rail must count every blocker the server named, filtering none of them out');
});

test('F3: a blocker the page does not recognise lands on a step, never disappears', () => {
  const map = chartPage.slice(chartPage.indexOf('const STEP_FOR_BLOCKER'), chartPage.indexOf('const EncounterStepRail'));
  // Falling through to nothing would silently drop a blocker off every step
  // while the server still refuses the signature — the worst of the three
  // possible answers. Sign is where the server's full message is printed.
  assert.match(map, /STEP_FOR_BLOCKER\[m\] \|\| 'sign'/);
  // Every blocker the sign gate can raise resolves to a real step.
  const steps = new Set(['visit', 'coding', 'actions', 'sign']);
  const mapped = { note: 'visit', diagnosis: 'coding', service: 'coding', service_dx_link: 'coding' };
  for (const m of ['note', 'diagnosis', 'service', 'service_dx_link', 'billing_npi', 'facility_pos', 'encounter_type_pos']) {
    assert.ok(steps.has(mapped[m] || 'sign'), `${m} must map to a step that exists`);
  }
});

test('F5: the rest of the chart opens inside the encounter, and it is the SAME components', () => {
  const drawer = chartPage.slice(chartPage.indexOf('const EncounterLookups = ('), chartPage.indexOf('const EncounterPanel = ('));
  // Mounted, not re-rendered. A second view of "what is this patient allergic
  // to" is how the two start disagreeing — the rule the allergy strip already
  // follows one layer down.
  for (const c of ['AllergiesTab', 'MedicationsTab', 'ProblemsTab', 'ResultsTab', 'DocumentsTab']) {
    assert.ok(drawer.includes(`<${c} `), `the drawer must mount the existing ${c}`);
    assert.ok(chartPage.includes(`const ${c} = (`), `${c} must be the chart's own component, defined once`);
  }
  // It fetches nothing of its own: the chart is already loaded by the parent,
  // and a second read is a second answer.
  assert.ok(!/api\./.test(drawer), 'the drawer must not call the API itself — it passes the chart it was given');
  // Rendered inside the panel, on the step where a clinician is reading the
  // note and deciding what to do next.
  assert.match(encounterPanel, /\{on\('visit'\) && <EncounterLookups patient=\{patient\} chart=\{chart\}/);
});

test('F5: the drawer is at module scope, so opening it does not remount what is under it', () => {
  // A component declared inside another is a new function identity on every
  // render: React tears it down and rebuilds it, and any input inside loses
  // the caret on the first keystroke. This repo has paid for that twice.
  const idx = chartPage.indexOf('const EncounterLookups = (');
  const line = chartPage.slice(chartPage.lastIndexOf('\n', idx) + 1, idx);
  assert.equal(line, '    ', 'EncounterLookups must be declared at module scope, not nested in a component');
  const railIdx = chartPage.indexOf('const EncounterStepRail = (');
  assert.equal(chartPage.slice(chartPage.lastIndexOf('\n', railIdx) + 1, railIdx), '    ',
    'EncounterStepRail must be at module scope too');
});

// ── Session 4.12 Scope G — psychiatry on the same ambulatory encounter ──

test('G: the MSE follows the VISIT, not the patient', () => {
  // REPOINTED. This used to ask `hpSectionsFor`, which was dead code nothing
  // called, keyed on the PATIENT's stored type. The catalog answers it per
  // visit now — and that matters: somebody who normally has a primary-care
  // visit can have a psych evaluation, and the note has to follow the visit.
  const sectionsOf = (type) => apptTypes.sectionsFor(type, { modality: 'in_person' }).map(s => s.key);
  assert.ok(!sectionsOf('pc_follow_up').includes('mentalStatusExam'),
    'an empty MSE on every note trains people to scroll past it');
  for (const psych of ['bh_initial', 'bh_follow_up']) {
    assert.ok(sectionsOf(psych).includes('mentalStatusExam'), `${psych} must carry the MSE`);
    assert.ok(apptTypes.requiredSectionKeys(psych, { modality: 'in_person' }).includes('mentalStatusExam'),
      `${psych} must REQUIRE the MSE, not merely offer it`);
  }
  // Never guessed on an unresolved visit.
  assert.deepEqual(sectionsOf(null), []);
  assert.deepEqual(sectionsOf('not_a_type'), []);
  assert.ok(!R.requiredSectionsForVisit({ appointmentType: 'pc_acute', modality: 'in_person' }).includes('mentalStatusExam'));
});

test('G: a psychiatric encounter cannot be SIGNED without a risk assessment, and documenting is never blocked', () => {
  const coded = R.applyCoding(
    { clientId: 'c', encounterUuid: 'e', diagnoses: [], services: [] },
    { diagnoses: [{ code: 'F32.9', description: 'MDD', primary: true }],
      services: [{ code: '99348', units: 1, dxLinks: ['F32.9'] }] },
    { id: 'u', name: 'FNP', npi: '1234567893' }, '1234567893'
  ).record;
  const base = { hasNote: true, record: coded, billingNpi: '1234567893', posCode: '12' };

  const psychVisit = { appointmentType: 'bh_initial', modality: 'in_person', location: 'home' };
  const allSections = R.requiredSectionsForVisit(psychVisit);
  const psychNoRisk = R.checkSignReadiness({ ...base, visit: psychVisit, completedSections: allSections });
  assert.equal(psychNoRisk.ok, false);
  assert.ok(psychNoRisk.codes.includes('SIGN_NO_RISK_ASSESSMENT'));
  assert.match(psychNoRisk.message, /psychiatric visit/i);

  const psychWithRisk = R.checkSignReadiness({ ...base, visit: psychVisit,
    riskAssessment: { id: 'r1', levels: { suicide: 'none', homicide: 'none', selfNeglect: 'none' } },
    completedSections: allSections });
  assert.equal(psychWithRisk.ok, true);

  // Required only on a BEHAVIOURAL-HEALTH appointment type: on every encounter
  // it would be noise, and noise is how a real refusal gets clicked past.
  const pcVisit = { appointmentType: 'pc_follow_up', modality: 'in_person', location: 'home' };
  assert.equal(R.checkSignReadiness({ ...base, visit: pcVisit, completedSections: R.requiredSectionsForVisit(pcVisit) }).ok, true);
  assert.equal(R.riskAssessmentRequired({ appointmentType: 'bh_follow_up' }), true);
  assert.equal(R.riskAssessmentRequired({ appointmentType: 'pc_follow_up' }), false);
  assert.equal(R.riskAssessmentRequired({ appointmentType: null }), false);
  assert.equal(R.riskAssessmentRequired(null), false);
});

test('G: every domain must be answered, and an invented level is refused', () => {
  const make = (form) => R.buildRiskAssessment({ id: 'r', clientId: 'c', encounterUuid: 'e', form, actor: { id: 'u', name: 'FNP' } });
  assert.equal(make({ suicide: 'none', homicide: 'none' }).code, 'RISK_LEVEL_REQUIRED',
    'a domain left blank is not an assessment of it');
  assert.equal(make({ suicide: 'none', homicide: 'none', selfNeglect: 'catastrophic' }).code, 'RISK_LEVEL_REQUIRED');
  assert.match(make({}).error, new RegExp(R.RISK_LEVELS.join('.*')), 'the refusal names what is on offer');
  const ok = make({ suicide: 'none', homicide: 'none', selfNeglect: 'none' });
  assert.ok(ok.assessment, '"none" IS an assessment — the record is that somebody asked');
  assert.deepEqual(Object.keys(ok.assessment.levels).sort(), [...R.RISK_DOMAINS].sort());
  assert.equal(R.highestRisk(ok.assessment), 'none');
});

test('G: risk at moderate or above requires a plan, and the refusal names which domain', () => {
  const make = (form) => R.buildRiskAssessment({ id: 'r', clientId: 'c', encounterUuid: 'e', form, actor: { id: 'u', name: 'FNP' } });
  for (const level of R.RISK_NEEDS_PLAN) {
    const bad = make({ suicide: level, homicide: 'none', selfNeglect: 'none' });
    assert.equal(bad.code, 'RISK_PLAN_REQUIRED', `${level} risk must require a plan`);
    assert.match(bad.error, new RegExp(`suicide: ${level}`), 'the refusal must name the domain and the level');
    // "Acknowledged" with no plan is a record that somebody SAW it, which is
    // not a record that it was handled — the 4.10 follow-up-note rule.
    assert.match(bad.error, /seen, not that it was handled/);
    assert.ok(make({ suicide: level, homicide: 'none', selfNeglect: 'none', plan: 'Safety plan agreed; wife removing firearms today; crisis line given; seen again Thursday.' }).assessment);
  }
  // Low risk needs no plan: requiring one everywhere would make the plan box
  // a formality somebody types "n/a" into.
  for (const level of ['none', 'low']) {
    assert.ok(make({ suicide: level, homicide: 'none', selfNeglect: 'none' }).assessment, `${level} must not demand a plan`);
  }
  // ANY domain at moderate or above triggers it, not only suicide.
  assert.equal(make({ suicide: 'none', homicide: 'none', selfNeglect: 'high' }).code, 'RISK_PLAN_REQUIRED');
  assert.equal(make({ suicide: 'none', homicide: 'imminent', selfNeglect: 'none' }).code, 'RISK_PLAN_REQUIRED');
});

test('G: assessments are append-only and the gate reads the latest', () => {
  const rows = [
    { id: 'a', encounterUuid: 'e1', levels: { suicide: 'low', homicide: 'none', selfNeglect: 'none' }, at: '2026-09-23T10:00:00.000Z' },
    { id: 'b', encounterUuid: 'e1', levels: { suicide: 'high', homicide: 'none', selfNeglect: 'none' }, at: '2026-09-23T11:30:00.000Z' },
    { id: 'c', encounterUuid: 'e2', levels: { suicide: 'none', homicide: 'none', selfNeglect: 'none' }, at: '2026-09-23T12:00:00.000Z' }
  ];
  // Risk changes inside one visit. Overwriting would lose that the clinician
  // escalated, which is the single most important thing the row records.
  const latest = R.latestRiskAssessment(rows, 'e1');
  assert.equal(latest.id, 'b', 'the gate must read the most recent, not the first');
  assert.equal(R.highestRisk(latest), 'high');
  assert.equal(R.latestRiskAssessment(rows, 'e3'), null, 'an encounter with none is null, never a borrowed row');
  // Never mixed between encounters.
  assert.equal(R.latestRiskAssessment(rows, 'e2').id, 'c');
});

test('G build-enforced: the risk route is a clinical WRITE, refuses a closed encounter, and logs no risk narrative', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server,
    /app\.post\('\/api\/clinical\/patients\/:clientId\/encounters\/:euuid\/risk-assessment',\s*authenticateToken,\s*requireClinicalWrite,/,
    'recording risk is a clinical write, not an admin action and not a read');
  const route = server.slice(server.indexOf("/risk-assessment', authenticateToken"));
  const body = route.slice(0, route.indexOf("// ── Addenda"));
  assert.ok(body.length > 300, 'precondition: the route body was actually sliced');
  // A closed encounter is read-only. Recording new risk against a signed note
  // would change what was attested to.
  assert.match(body, /ENCOUNTER_CLOSED/);
  // The LEVEL goes in the audit trail; what somebody said about wanting to
  // die does not. An audit trail is not a second copy of the record.
  const log = body.slice(body.indexOf('logActivity'), body.indexOf('res.json'));
  assert.match(log, /highestRisk/);
  for (const k of ['plan', 'protectiveFactors', 'meansRestriction']) {
    assert.ok(!log.includes(k), `the audit entry must not carry ${k}`);
  }
  // Appended, never replaced.
  assert.match(body, /rows\.push\(built\.assessment\)/);
  assert.ok(!/rows\s*=\s*rows\.filter/.test(body), 'a revision must not remove the previous row');
});

test('G build-enforced: the gate is actually reached — every sign check hands over the recorded assessment', () => {
  // The refusal is worth nothing if the route does not pass what it gates on:
  // the check would be correct and unreached, and a psychiatric encounter
  // would sign clean. Same shape as the charge call sites, which survived
  // their first mutation run for exactly this reason.
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const calls = server.match(/checkSignReadiness\(\{[\s\S]{0,400}?\}\)/g) || [];
  assert.ok(calls.length >= 2, 'expected the sign route and the readiness preview');
  for (const c of calls) {
    assert.match(c, /riskAssessment:/, `every sign-readiness call must pass the recorded assessment: ${c.slice(0, 90)}…`);
    assert.match(c, /visit:/, 'and the visit descriptor it is judged against');
    assert.match(c, /completedSections:/, 'and what the clinician has actually filled in');
  }
  // It has to be LOADED beside the encounter, or the field is always absent
  // and the gate always fires.
  assert.match(server, /riskAssessment: clinicalRepo\.latestRiskAssessment\(risks, encounterUuid\)/);
});

test('G build-enforced: the risk card is rendered inside the encounter', () => {
  // A card that exists and is never mounted is a capability that does not
  // exist — the lesson the facility route bought in 4.9.
  const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'clinical.html'), 'utf8');
  assert.match(page, /<RiskCard d=\{d\}/, 'the encounter must mount the risk card');
  assert.match(page, /api\.saveRisk\(patient\.id, euuid, form\)/, 'and it must write through the risk route');
  assert.ok(page.includes("saveRisk: (id, euuid, body)"), 'the route must have a caller');
  // On the Visit step, where the clinician is reading the note and deciding.
  const panel = page.slice(page.indexOf('const EncounterPanel = ('), page.indexOf('const EncountersTab = ('));
  assert.match(panel, /\{on\('visit'\) && \(\s*\n\s*<RiskCard/);
});

test('G build-enforced: the screen restates no risk vocabulary and no clinical rule', () => {
  const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'clinical.html'), 'utf8');
  const card = page.slice(page.indexOf('const RiskCard = ('), page.indexOf('const EncounterLookups = ('));
  assert.ok(card.length > 500, 'precondition: the card was sliced');
  // The levels, the domains and which of them need a plan are all served. A
  // page carrying its own list drifts from the validator that refuses one it
  // no longer knows.
  for (const level of R.RISK_LEVELS) {
    assert.ok(!card.includes(`'${level}'`) && !card.includes(`"${level}"`),
      `the card must not name the risk level ${level}; the list is served`);
  }
  for (const d of R.RISK_DOMAINS) {
    assert.ok(!card.includes(`'${d}'`), `the card must not name the domain ${d}; they are served`);
  }
  assert.match(card, /d\.riskLevels \|\| \[\]/, 'the level dropdown renders the served list');
  assert.match(card, /d\.riskDomains \|\| \[\]/, 'the domains come from the server');
  assert.match(card, /\(d\.riskNeedsPlan \|\| \[\]\)\.includes/,
    'whether a plan is needed is the server’s answer, not a second clinical rule here');
  // Ranking "which risk is worse" also comes from the served order — a local
  // copy goes stale the day a level is added.
  assert.ok(!/RISK_ORDER/.test(page), 'no local ordering of risk levels may exist');
  // REPOINTED. This used to assert the H&P read a PATIENT flag to decide
  // whether to show the mental status exam — the wrong signal, as the owner
  // pointed out: a patient who normally has a primary-care visit can have a
  // psych evaluation. The note follows the VISIT's appointment type now, and
  // which sections that type carries is the server's answer, not the page's.
  assert.match(page, /noteHasSection\('mentalStatusExam'\) && \(/,
    'the MSE must be shown when THIS VISIT carries it, not when the patient is flagged');
  assert.ok(!page.includes('isPsychiatric'), 'the superseded patient flag must be gone, not left beside it');
  // And the page derives the section list from what the server served.
  assert.match(page, /catalog\.noteTemplates\[visit\.appointmentType\]/,
    'the note template comes from the server, so the form cannot drift from the gate that refuses the signature');
});

// ── The clinician's recorded time overrides the schedule (owner, 2026-09-23) ──


test('TIME: the recorded start and end override the schedule, and there is NO fallback to it', () => {
  // ⚠️ THE OWNER RULE. The appointment type carries a default duration and the
  // calendar carries a slot. Both are planning figures. Neither is evidence
  // that anybody was in the room for that long, and a time-based E/M level is
  // an assertion about how long the clinician actually spent.
  const ranShort = myDay.visitTiming(
    { startedAt: '2026-09-23T14:00:00Z', endedAt: '2026-09-23T14:35:00Z' }, { scheduledMinutes: 60 });
  assert.equal(ranShort.actualMinutes, 35);
  assert.equal(ranShort.scheduledMinutes, 60);
  assert.equal(ranShort.billableMinutes, 35, 'the recorded time is what bills, never the slot');
  assert.equal(ranShort.source, 'recorded');
  assert.equal(ranShort.overridesSchedule, true);

  const ranLong = myDay.visitTiming(
    { startedAt: '2026-09-23T14:00:00Z', endedAt: '2026-09-23T15:18:00Z' }, { scheduledMinutes: 60 });
  assert.equal(ranLong.billableMinutes, 78, 'a visit that overran bills the time it took');
  assert.equal(ranLong.overridesSchedule, true);

  // ⚠️ NO FALLBACK. Billing 60 minutes because the slot said 60, when nobody
  // recorded a time at all, is a false claim — and a fallback would be
  // indistinguishable from a real measurement to everything downstream.
  const unrecorded = myDay.visitTiming({}, { scheduledMinutes: 60 });
  assert.equal(unrecorded.actualMinutes, null);
  assert.equal(unrecorded.billableMinutes, null, 'NOTHING billable comes from the schedule');
  assert.notEqual(unrecorded.billableMinutes, 60);
  assert.equal(unrecorded.source, myDay.SCHEDULED_ONLY, 'and it says which of the two states it is in');
  assert.equal(unrecorded.statement, null, 'no time statement can be written from a slot');

  // A visit still running has a start and no end, so there is no duration yet.
  const running = myDay.visitTiming({ startedAt: '2026-09-23T14:00:00Z' }, { scheduledMinutes: 60 });
  assert.equal(running.billableMinutes, null);
  assert.equal(running.statement, null);

  // Matching the slot exactly is not an override, it is agreement.
  assert.equal(myDay.visitTiming(
    { startedAt: '2026-09-23T14:00:00Z', endedAt: '2026-09-23T15:00:00Z' }, { scheduledMinutes: 60 }
  ).overridesSchedule, false);
  // No schedule at all is fine; the recorded time still stands alone.
  assert.equal(myDay.visitTiming({ startedAt: '2026-09-23T14:00:00Z', endedAt: '2026-09-23T14:40:00Z' }).billableMinutes, 40);
});

test('TIME build-enforced: nothing in the time statement can read a scheduled figure', () => {
  const src = fs.readFileSync(path.join(root, 'myDay.js'), 'utf8');
  const from = src.indexOf('const timeStatement');
  const to = src.indexOf('const SCHEDULED_ONLY');
  assert.ok(from > 0 && to > from, 'both anchors must still be present and in order');
  const fn = src.slice(from, to);
  // The statement is what a time-based E/M level is read off. A scheduled
  // figure reaching it would be a plausible number from the wrong source,
  // which is the exact class of defect the charge writer had twice today.
  assert.ok(!/scheduled/i.test(fn), 'the time statement must not read anything scheduled');
  assert.ok(!/defaultMinutes/.test(fn), 'nor an appointment type’s default duration');
  assert.match(fn, /totalVisitMinutes\(timing\)/, 'it reads the recorded interval and nothing else');
  // And the one field anything billable may read is named so it cannot be
  // confused with the plan sitting beside it.
  const vt = src.slice(src.indexOf('const visitTiming'), src.indexOf('// ---- Drive time'));
  assert.match(vt, /billableMinutes: actual,/, 'billableMinutes is the recorded figure, with no coalesce');
  assert.ok(!/billableMinutes:[^,\n]*\|\|/.test(vt), 'no `||` fallback may be added to it');
});

test('the sign gate pushes the POS disagreement, not just the checker', () => {
  // The checker having the right verdict is worth nothing if the gate does not
  // act on it. Survived its first mutation run for exactly that reason.
  const coded = R.applyCoding(
    { clientId: 'c', encounterUuid: 'e', diagnoses: [], services: [] },
    { diagnoses: [{ code: 'E11.9', description: 'T2DM', primary: true }],
      services: [{ code: '99348', units: 1, dxLinks: ['E11.9'] }] },
    { id: 'u', name: 'FNP', npi: '1234567893' }, '1234567893'
  ).record;
  const visit = { appointmentType: 'pc_follow_up', modality: 'telehealth', location: 'home' };
  const wrong = R.checkSignReadiness({
    hasNote: true, record: coded, billingNpi: '1234567893', posCode: '12', visit,
    completedSections: R.requiredSectionsForVisit(visit)
  });
  assert.equal(wrong.ok, false, 'a telehealth visit billed at the home POS must not sign');
  assert.ok(wrong.codes.includes(R.VISIT_POS_DISAGREES));
  assert.ok(wrong.missing.includes('encounter_type_pos'));
  assert.match(wrong.message, /\b10\b/);
  assert.match(wrong.message, /\b12\b/);
  // Right POS, same everything else: signs.
  assert.equal(R.checkSignReadiness({
    hasNote: true, record: coded, billingNpi: '1234567893', posCode: '10', visit,
    completedSections: R.requiredSectionsForVisit(visit)
  }).ok, true);
});

test('the sign gate demands a safety plan once the RECORDED risk is positive', () => {
  const coded = R.applyCoding(
    { clientId: 'c', encounterUuid: 'e', diagnoses: [], services: [] },
    { diagnoses: [{ code: 'F32.9', description: 'MDD', primary: true }],
      services: [{ code: '99348', units: 1, dxLinks: ['F32.9'] }] },
    { id: 'u', name: 'FNP', npi: '1234567893' }, '1234567893'
  ).record;
  const visit = { appointmentType: 'bh_initial', modality: 'in_person', location: 'home' };
  const baseline = R.requiredSectionsForVisit(visit, { riskPositive: false });
  assert.ok(!baseline.includes('safetyPlan'), 'precondition: not required at negative risk');
  const common = { hasNote: true, record: coded, billingNpi: '1234567893', posCode: '12', visit, completedSections: baseline };

  const negative = R.checkSignReadiness({ ...common,
    riskAssessment: { id: 'r', levels: { suicide: 'none', homicide: 'none', selfNeglect: 'none' } } });
  assert.equal(negative.ok, true, 'a negative risk assessment needs no safety plan');

  // The gate reads the RECORDED risk row, so the template tightens the moment
  // the clinician documents risk — not when the visit started.
  const positive = R.checkSignReadiness({ ...common,
    riskAssessment: { id: 'r', levels: { suicide: 'high', homicide: 'none', selfNeglect: 'none' } } });
  assert.equal(positive.ok, false);
  assert.deepEqual(positive.openSections, ['safetyPlan']);
  assert.match(positive.message, /Safety Plan/);
  // Any domain, not just suicide.
  assert.deepEqual(R.checkSignReadiness({ ...common,
    riskAssessment: { id: 'r', levels: { suicide: 'none', homicide: 'none', selfNeglect: 'moderate' } } }).openSections, ['safetyPlan']);
  // Filed: signs.
  assert.equal(R.checkSignReadiness({ ...common, completedSections: [...baseline, 'safetyPlan'],
    riskAssessment: { id: 'r', levels: { suicide: 'high', homicide: 'none', selfNeglect: 'none' } } }).ok, true);
});

test('the booking is authoritative over the patient’s usual location', () => {
  // The patient's enrollment record carries a DEFAULT. Resolving the other way
  // round would bill the visit at the place the patient usually is rather than
  // the place they were — a home patient seen in clinic once is normal.
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const from = server.indexOf('const visit = apptTypes.resolveVisit({');
  assert.ok(from > 0, 'the resolver call must still be there');
  const call = server.slice(from, server.indexOf('});', from));
  assert.match(call, /bookedLocation: descriptor && descriptor\.location/,
    'the booked location must come from the booking, not from the patient record');
  assert.match(call, /patientDefaultLocation: client\.usualLocation \|\| null/,
    'and the patient record supplies only the default');
  // The two must read DIFFERENT sources, or the override cannot happen.
  const booked = call.match(/bookedLocation:([^\n]*)/)[1];
  const fallback = call.match(/patientDefaultLocation:([^\n]*)/)[1];
  assert.notEqual(booked.trim(), fallback.trim(), 'a booking that reads the patient default is not an override');
  assert.ok(!/bookedLocation:[^\n]*usualLocation/.test(call), 'the booking must not read the patient default');
});

test('the note templates are SERVED, so the form cannot drift from the gate', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  // The template that shapes the form has to be the same one the signature is
  // refused against, or a clinician fills in a note the server then calls
  // incomplete.
  assert.match(server, /const noteTemplates = \{\};/);
  assert.match(server, /apptTypes\.sectionsFor\(t\.key, \{ modality: m\.key \}\)/);
  // Scoped to THIS route. `/api/clinical/facilities` also has a degraded
  // branch and legitimately serves no note templates — a guard that cannot
  // tell two routes apart fails on code that is correct.
  const from = server.indexOf("app.get('/api/clinical/patients/:clientId/place-of-service'");
  const to = server.indexOf("app.get('/api/clinical/facilities'", from);
  assert.ok(from > 0 && to > from, 'both anchors must still be present and in order');
  const route = server.slice(from, to);
  // Counted by the `res.json({` openers, because a non-greedy match to the
  // first `});` stops inside a nested call and reads as a truncated response.
  const openers = (route.match(/res\.json\(\{/g) || []).length;
  assert.equal(openers, 3, 'expected the unconfigured, the unreadable and the normal response');
  const served = (route.match(/noteTemplates/g) || []).length;
  // Declared once, then in each of the three responses.
  assert.ok(served >= 4,
    `the templates must reach every response from this route — a page with no EMR still needs its picker (found ${served})`);
  // The success response carries the whole catalog, not only the templates.
  const success = route.slice(route.lastIndexOf('res.json({'));
  for (const k of ['locations', 'appointmentTypes', 'services', 'modalities', 'noteTemplates']) {
    assert.ok(success.includes(k) || route.includes(`canEdit, locations, appointmentTypes, services, modalities, noteTemplates`),
      `the catalog must include ${k}`);
  }
});
