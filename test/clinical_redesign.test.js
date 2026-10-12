// 2026-10-12 clinical redesign (owner mockups), part 2: the chart.
// The mockups show things the app does not hold: lab values, reference
// ranges, a vitals reading for every box. These guards keep the new screens
// from filling those gaps with something invented.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'clinical.html'), 'utf8');
const slice = (from, to) => {
  const i = page.indexOf(from);
  assert.ok(i > 0, `${from} must be findable`);
  const j = page.indexOf(to, i + from.length);
  assert.ok(j > i, `${to} must follow ${from}`);
  return page.slice(i, j);
};

// Lift the two pure helpers out of the page and RUN them, rather than reading them.
const helpers = new Function(`${slice('const OV_VITALS = [', 'const OvRow = (')}; return { latestVitals, vitalDisplay };`)();

test('the Overview never shows a vitals number it did not read', () => {
  const out = helpers.latestVitals([
    { name: 'Heart rate', value: '72 beats/min', at: '2026-10-01' },
    { name: 'Blood pressure panel', value: 'Systolic blood pressure 128 / Diastolic blood pressure 76', at: '2026-10-01' }
  ]);
  const by = Object.fromEntries(out.map(v => [v.label, v]));
  assert.strictEqual(by.BP.big, '128/76');
  assert.strictEqual(by.HR.big, '72');
  assert.strictEqual(by.HR.small, 'beats/min', 'the unit is the reading\'s own');
  assert.strictEqual(by.Temp.big, null, 'no temperature was read, so none is shown');
  assert.strictEqual(by['SpO₂'].big, null);
});

test('the newest reading wins, and a draft reading (appended last) beats OpenEMR', () => {
  const out = helpers.latestVitals([
    { name: 'Heart rate', value: '90 /min', at: '2026-09-01' },
    { name: 'Heart rate', value: '72 /min', at: '2026-10-01' },
    { name: 'Heart rate', value: '66 /min', at: '2026-10-12', draft: true }
  ]);
  const hr = out.find(v => v.label === 'HR');
  assert.strictEqual(hr.big, '66');
  assert.strictEqual(hr.draft, true);
});

test('the Results table has no value, range or trend column', () => {
  const body = slice('const ResultsTab = (', '// ---- D5 TIMELINE');
  const heads = [...body.matchAll(/<th>([^<]*)<\/th>/g)].map(m => m[1]);
  assert.deepStrictEqual(heads, ['Date', 'Test', 'Flag', 'Status', 'Reviewed by']);
  assert.ok(!/Reference range|Ref\. range|View Trends|r\.value\b/i.test(body), 'the app stores no values, so the page must not imply it does');
});

test('the Flag is the recorded interpretation, never inferred', () => {
  const body = slice('const RESULT_FLAG = {', 'const ResultsTab = (');
  assert.match(body, /RESULT_FLAG\[String\(r\.interpretation \|\| ''\)\]/);
  assert.match(body, /Not set/, 'an unrecorded interpretation says so');
});

test('the phone section menu reads the SAME tabs list as the strip', () => {
  const app = slice('const App = () => {', 'ReactDOM.createRoot');
  assert.strictEqual((app.match(/const tabs = \[/g) || []).length, 1, 'one list of chart sections');
  assert.ok((app.match(/tabs\.map\(/g) || []).length >= 2, 'the strip and the phone menu both map it');
  assert.match(app, /onClick=\{\(\) => \{ setTab\(k\); setSectionMenu\(false\); \}\}/);
});

test('the header keeps every action behind its gate', () => {
  const body = slice('const PatientBanner = (', '\n    // ── Session 4.12 Scope D — CHART NAVIGATION');
  assert.match(body, /\{onStartVisit && access\.canWrite && \(/, 'Start visit stays a write');
  assert.match(body, /\{patient && patient\.id && access\.canWrite && \(/, 'Refresh portal chart stays a write');
  assert.match(body, /\{canBill && <BannerFact label="Facility &amp; POS">/, 'place of service stays billing\'s');
});

// Owner rule, 2026-10-12: "No reason for Open care plan with a capital O and
// lower case c… I want succinct/concise text buttons." Every button label is
// Title Case and at most five words; small joining words stay lower case.
// Progress text ("Saving…") and sentences are not labels and are skipped.
const SMALL = new Set(['a', 'an', 'the', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'as', 'at', 'by', 'vs', 'via', 'with', 'from', 'per', 'no']);
const buttonLabelProblems = (src) => {
  const bad = [];
  const re = /<button\b([^>]*)>([\s\S]*?)<\/button>/g;
  let m;
  while ((m = re.exec(src))) {
    if (!/className="[^"]*\b(btn|chip)\b|className=\{`[^`]*\b(btn|chip)\b/.test(m[1])) continue;
    const cands = [];
    ('>' + m[2]).replace(/(?:>|\/>)\s*([A-Z][A-Za-z'’&;.\- ]{2,60}?)\s*(?=<|\{|$)/g, (_, t) => cands.push(t));
    m[2].replace(/[?:]\s*'([A-Z][A-Za-z'’& .\-]{2,60})'/g, (_, t) => cands.push(t));
    for (const c of cands) {
      const t = c.replace(/&amp;/g, '&').trim();
      if (!t.includes(' ') || /[.…]$/.test(t)) continue;
      const words = t.split(/\s+/);
      const line = src.slice(0, m.index).split('\n').length;
      if (words.length > 5) bad.push(`${line}: "${t}" is longer than five words`);
      else if (words.slice(1).some(w => /^[a-z]/.test(w) && !SMALL.has(w))) bad.push(`${line}: "${t}" is not Title Case`);
    }
  }
  return bad;
};

test('every clinical button label is Title Case and short (owner rule)', () => {
  assert.deepStrictEqual(buttonLabelProblems(page), []);
});

test('the label guard actually catches a sentence-case button', () => {
  assert.deepStrictEqual(buttonLabelProblems('<button className="btn ghost">Open care plan</button>').length, 1);
  assert.deepStrictEqual(buttonLabelProblems('<button className="btn">Open Care Plan</button>'), []);
  assert.deepStrictEqual(buttonLabelProblems("<button className=\"btn\">{busy ? 'Saving…' : 'Save Draft'}</button>"), []);
});

// Part 3 wiring: every row opens the place where its work is done.
test('Inbox, Results and the visit checklist open the right chart section', () => {
  const inbox = slice('const InboxView = (', '\n    // ── Session 4.12 — the persistent patient banner');
  assert.match(inbox, /onOpenChart\(i\.clientId, i\.kind === 'care_plan_co_sign' \? \{ tab: 'careplan' \} : undefined\)/);
  const app = slice('const App = () => {', 'ReactDOM.createRoot');
  assert.match(app, /<InboxView[\s\S]{0,200}onOpenChart=\{\(clientId, opts\) => openChartById\(clientId, opts\)\}/);
  assert.match(app, /<ResultsInbox onOpenChart=\{\(clientId, opts\) => openChartById\(clientId, opts\)\} \/>/);
  assert.match(app, /<MyDayView user=\{user\} onOpenChart=\{\(clientId, opts\) => openChartById\(clientId, opts\)\}/);
  const details = slice('const VisitDetails = (', '\n    // ── The AI review card');
  for (const t of ['problems', 'allergies', 'orders', 'referrals', 'results', 'careplan']) {
    assert.ok(details.includes(`goTab('${t}')`), `the ${t} line must open its section`);
  }
  assert.match(details, /const goTab = \(t\) => \(\) => onOpenChart\(v\.clientId, \{ tab: t \}\);/);
});

test('the chart Messages split is the server\'s mark, never a list on the page', () => {
  const msg = slice('const MessagesTab = (', '\n    const App = () => {');
  assert.match(msg, /audience,/);
  assert.ok(!/care_team|clinical_escalation|behavioral_escalation/.test(msg), 'no channel ids on the page');
  const comp = fs.readFileSync(path.join(__dirname, '..', 'public', 'components', 'gfc-messaging.js'), 'utf8');
  assert.match(comp, /state\.audience === 'patient' \? !!x\.withPatient : !x\.withPatient/);
  const repo = require('../messagingRepository');
  assert.strictEqual(repo.withPatient('care_team'), true);
  assert.strictEqual(repo.withPatient('clinical_escalation'), true, 'the client is a participant');
  assert.strictEqual(repo.withPatient('clinical_oversight'), false, 'clinician and caregiver only');
  assert.strictEqual(repo.withPatient('behavioral_escalation'), false);
  const routes = fs.readFileSync(path.join(__dirname, '..', 'routes', 'messaging.js'), 'utf8');
  assert.match(routes, /withPatient: msg\.withPatient\(t\.channel\)/);
});

// Part 4 (owner, 2026-10-12: "complete messages", "yes to note screen", the
// remaining screens to the mockups).
test('Tasks and Overdue rows open the chart section where the work is done', () => {
  const tasks = slice('const WorkQueuesView = (', 'const Metric = (');
  assert.match(tasks, /onOpenChart\(r\.clientId, \{ tab: 'results' \}\)/);
  assert.match(tasks, /onOpenChart\(r\.clientId, \{ tab: 'referrals' \}\)/);
  assert.match(tasks, /onOpenChart\(r\.clientId, \{ tab: 'orders' \}\)/);
  assert.match(tasks, /onOpenEncounter\(r\.clientId, r\.encounterUuid\)/);
  const overdue = slice('const OverdueOrders = (', '// The encounter panel: coding, Rx, orders');
  assert.match(overdue, /onOpenChart\(o\.clientId, \{ tab: 'orders' \}\)/);
  const app = slice('const App = () => {', 'ReactDOM.createRoot');
  assert.match(app, /<OverdueOrders onOpenChart=\{\(clientId, opts\) => openChartById\(clientId, opts\)\} \/>/);
  assert.match(app, /<WorkQueuesView\s+onOpenChart=\{\(clientId, opts\) => openChartById\(clientId, opts\)\}/);
});

test('every queue still says so when it is empty', () => {
  const tasks = slice('const WorkQueuesView = (', 'const Metric = (');
  assert.ok(!/rows\.length === 0\) return null/.test(tasks), 'an empty queue is shown with its sentence, never hidden');
});

test('a chat bubble keeps the sender line, so a POA message says whose behalf it is on', () => {
  const comp = fs.readFileSync(path.join(__dirname, '..', 'public', 'components', 'gfc-messaging.js'), 'utf8');
  const i = comp.indexOf('function renderThread(state)');
  const body = comp.slice(i, comp.indexOf('// ---- Bind', i));
  assert.match(body, /<div class="mwrap ' \+ side \+ '"><div class="mbub ' \+ side \+ '">/);
  assert.match(body, /'<div class="mwho">' \+ esc\(m\.from\)/);
  assert.ok(!/innerHTML|m\.body \+/.test(body), 'the body goes through messageHtml, which escapes');
});

test('the note screen asks where the visit happened, never for a place of service', () => {
  const hp = slice('const HpTab = (', 'const MedRecTab');
  assert.match(hp, /<Field label="Visit Type">/);
  assert.match(hp, /<Field label="Visit Location">/);
  assert.ok(!/Place of Service|place of service/i.test(hp.replace(/\/\/.*$/gm, '')), 'POS is billing\'s, never the clinician\'s');
});

// Owner report, 2026-10-12: "when saving in the coding area, it still shows an
// unsaved changes message". The reload after a save compared the boxes with
// the record from BEFORE the save, so it kept them as "unsaved", never cleared
// "add to problem list", and the flag (and the Sign block) never went away.
// The real load callback is lifted out of the page and RUN against fakes.
const encounterLoad = () => {
  const src = slice('      const codingRef = useRef({});', '      useEffect(load, ');
  const body = src.slice(src.indexOf('const load = useCallback('), src.lastIndexOf(', [patient.id, euuid]);'));
  const fn = body.replace('const load = useCallback(', '');
  return (env) => new Function(...Object.keys(env), `return (${fn})`)(...Object.values(env));
};
const runLoad = async ({ adopt, typed, before, saved }) => {
  const state = {};
  const env = {
    api: { encounterDetail: () => Promise.resolve({ record: saved }) },
    patient: { id: 'c1' }, euuid: 'e1',
    codingRef: { current: { ...typed, record: before, key: 'c1|e1' } },
    adoptCodingRef: { current: adopt },
    setD: (v) => { state.d = v; }, setErr: () => {},
    setDiagnoses: (v) => { state.diagnoses = v; }, setServices: (v) => { state.services = v; },
    setAddToProblemList: (v) => { state.addToProblemList = v; }, setFacing: (v) => { state.facing = v; }
  };
  encounterLoad()(env)();
  await new Promise(r => setTimeout(r, 0));
  return { state, adoptLeft: env.adoptCodingRef.current };
};
const TYPED = { diagnoses: [{ code: 'R55.' }], services: [], facing: { patientSummary: '', followUpInstructions: '' }, addToProblemList: ['R55.'] };
const BEFORE = { diagnoses: [], services: [] };
const SAVED = { diagnoses: [{ code: 'R55', description: 'Syncope' }], services: [], patientSummary: '', followUpInstructions: '' };

test('after a coding save, the reload takes the saved copy and clears "add to problem list"', async () => {
  const { state, adoptLeft } = await runLoad({ adopt: true, typed: TYPED, before: BEFORE, saved: SAVED });
  assert.deepStrictEqual(state.diagnoses, SAVED.diagnoses, 'the boxes now hold what the server stored');
  assert.deepStrictEqual(state.addToProblemList, [], 'the ticks are cleared, or "Unsaved changes" never goes away');
  assert.strictEqual(adoptLeft, false, 'the flag is spent by the one reload it was for');
});

test('any other reload still keeps coding that has not been saved', async () => {
  const { state } = await runLoad({ adopt: false, typed: TYPED, before: BEFORE, saved: SAVED });
  assert.strictEqual(state.diagnoses, undefined, 'typed coding is left alone after an Rx or order reload');
});

test('the adopt flag is set only by a SUCCESSFUL coding save', () => {
  assert.match(page, /api\.saveCoding\(patient\.id, euuid, \{ diagnoses, services, addToProblemList, \.\.\.facing \}\)\.then\(r => \{ adoptCodingRef\.current = true; return r; \}\)/);
});

// Owner report, 2026-10-12 ("same here"): the encounter's Sign & Submit card
// read the SAVED note, so while Subjective, Assessment and Plan were typed and
// not yet saved it listed them as missing. The editors now report whether the
// note on screen differs from the one last loaded or saved. The real hook is
// lifted out of the page and run with a tiny fake hook runner.
const makeHookRunner = () => {
  const slots = []; let i = 0; const effects = [];
  const React = {
    useRef: (init) => { const k = i++; if (!slots[k]) slots[k] = { current: init }; return slots[k]; },
    useEffect: (fn, deps) => { const k = i++; const first = !slots[k]; slots[k] = true; if (!deps || first) effects.push(fn); }
  };
  const src = slice('const useNoteDirty = (', '// Shown on the Sign & Submit card');
  const hook = new Function('useRef', 'useEffect', `${src}; return useNoteDirty;`)(React.useRef, React.useEffect);
  return (f, onNoteState, save) => { i = 0; effects.length = 0; const r = hook(f, onNoteState, save); effects.forEach(e => e()); return r; };
};

test('the note reads as unsaved only after typing, and clean again after a save', () => {
  const render = makeHookRunner();
  const seen = [];
  const report = (s) => seen.push(s);
  let markSaved = render({ subjective: '' }, report, () => 'saved');
  assert.strictEqual(seen.at(-1).dirty, false, 'a blank note before load is not "unsaved"');
  markSaved(); // the load lands
  markSaved = render({ subjective: 'Feels better' }, report, () => 'saved');
  assert.strictEqual(seen.at(-1).dirty, false, 'the note as loaded is the saved copy');
  markSaved = render({ subjective: 'Feels better today' }, report, () => 'saved');
  assert.strictEqual(seen.at(-1).dirty, true, 'typing makes it unsaved');
  assert.strictEqual(seen.at(-1).save(), 'saved', 'the card can save it');
  markSaved(); // the save succeeded
  render({ subjective: 'Feels better today' }, report, () => 'saved');
  assert.strictEqual(seen.at(-1).dirty, false, 'a successful save makes it clean again');
});

test('both editors report their note state, and mark it saved after a load and a save', () => {
  const hp = slice('const HpTab = (', 'const MedRecTab');
  const fu = slice('const FollowUpNoteEditor = (', 'const SignedNoteView');
  for (const [name, src, saver] of [['HpTab', hp, 'saveDraft'], ['FollowUpNoteEditor', fu, 'save']]) {
    assert.match(src, new RegExp(`const markSaved = useNoteDirty\\(f, onNoteState, \\(\\) => ${saver}\\(\\)\\)`), `${name} reports up`);
    assert.match(src, /\.then\(r => \{ (if \(live && r && r\.note\)|if \(r\))[^\n]*markSaved\(\)/, `${name} marks the loaded note as saved`);
    assert.match(src, /\.then\(r => \{\s*markSaved\(\);/, `${name} marks a successful save`);
  }
  assert.strictEqual((page.match(/onNoteState=\{onNoteState\}/g) || []).length, 2, 'the encounter listens to both editors');
});

test('while the note is unsaved, the sign card says save first and cannot sign', () => {
  const card = slice('{on(\'sign\') && !locked && ns.status === \'draft\' && na.canEdit && (', '{/* The clinician addendum');
  assert.match(card, /\{noteDirty && <UnsavedNoteLine onSave=\{saveNoteFirst\} \/>\}/);
  assert.match(card, /\{!noteDirty && !d\.signReadiness\.ok && <p/, 'the stale section list is hidden while the note is unsaved');
  assert.match(card, /disabled=\{!attest \|\| !d\.signReadiness\.ok \|\| dirty \|\| noteDirty \|\|/);
  const add = slice('{/* The clinician addendum', '{/* BILLING');
  assert.match(add, /\{!noteDirty && d\.addendumReadiness/);
  assert.match(add, /dirty \|\| noteDirty \|\|/);
});

// Owner report, 2026-10-12: a Care Management call note read "Ready to sign"
// with Sign & Submit greyed and no reason given. Unsaved coding greys the
// button (signing reads the saved diagnoses); the card now says so even when
// the sign check itself passes. No appointment is required to sign.
test('a ready note with unsaved coding says why it cannot sign', () => {
  const card = slice('{on(\'sign\') && !locked && ns.status === \'draft\' && na.canEdit && (', '{/* The clinician addendum');
  assert.match(card, /\{!noteDirty && d\.signReadiness\.ok && dirty && <p[^>]*>.*Save your coding changes first\./);
  const add = slice('{/* The clinician addendum', '{/* BILLING');
  assert.match(add, /\(!d\.addendumReadiness \|\| d\.addendumReadiness\.ok\) && dirty && <p/);
});
