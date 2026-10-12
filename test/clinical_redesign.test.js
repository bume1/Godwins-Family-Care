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
