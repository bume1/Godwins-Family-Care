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
