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
