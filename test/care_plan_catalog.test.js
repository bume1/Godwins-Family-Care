// ============================================================
// Care plan catalog: standard interventions, pick-lists and pathway templates
// (owner, 2026-10-14). docs/decisions/2026-10-14-care-plan-templates.md
// Run: npm test
// ============================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const cat = require('../carePlanCatalog');
const fmt = require('../carePlanFormat');
const { buildCarePlanVersion } = require('../clinicalRepository');
const AUTHOR = { name: 'RN', id: 'u1', at: '2026-10-14T12:00:00Z' };
const CLINICAL = fs.readFileSync(path.join(__dirname, '..', 'public', 'clinical.html'), 'utf8');
const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('every standard intervention has a unique code and a type the format knows', () => {
  const codes = cat.INTERVENTIONS.map(i => i.code);
  assert.equal(new Set(codes).size, codes.length);
  assert.ok(!codes.includes(cat.CUSTOM_INTERVENTION));
  for (const i of cat.INTERVENTIONS) {
    assert.ok(fmt.INTERVENTION_TYPES.includes(i.type), i.code);
    assert.ok(fmt.RESPONSIBLE.includes(i.responsible), i.code);
    assert.ok(fmt.FREQUENCIES.includes(i.frequency), i.code);
  }
});

test('every pathway resolves its interventions and fits the format', () => {
  const served = cat.catalog().pathways;
  for (const p of cat.PATHWAYS) {
    const s = served.find(x => x.key === p.key);
    assert.equal(s.interventions.length, p.interventions.length, `${p.key}: an unknown intervention code`);
    assert.ok(p.problem.text && p.goals.length && p.callGfcWhen.length && p.call911When.length, p.key);
    for (const g of p.goals) assert.ok(!g.priority || fmt.PRIORITIES.includes(g.priority), p.key);
  }
  for (const key of ['chf', 'falls', 'diabetes']) assert.ok(served.some(p => p.key === key), key);
});

test('a coded intervention takes its type from the catalog, whatever is posted', () => {
  const { plan } = buildCarePlanVersion(null, {
    problems: ['CHF'], goals: ['Stay home'],
    interventions: [{ code: 'daily_weight', type: 'referral', description: '' }, { code: 'med_review', description: 'Furosemide review' }]
  }, AUTHOR);
  assert.deepEqual(plan.interventions.map(i => [i.code, i.type]), [['daily_weight', 'caregiver_task'], ['med_review', 'medication']]);
  assert.equal(plan.interventions[0].description, 'Daily weight, logged before breakfast', 'blank takes the catalog wording');
  assert.equal(plan.interventions[1].description, 'Furosemide review', 'the wording can be adjusted');
  assert.equal(plan.interventions[0].responsible, 'gfc_caregiver', 'defaults come from the catalog');
});

test('anything not in the catalog is custom, with the clinician’s own words and type', () => {
  const { plan } = buildCarePlanVersion(null, {
    problems: ['CHF'], goals: ['Stay home'],
    interventions: [{ code: 'made_up', description: 'Church van on Sundays', type: 'referral' }, { description: 'Pet therapy', type: 'clinical' }]
  }, AUTHOR);
  assert.deepEqual(plan.interventions.map(i => [i.code, i.type]), [['custom', 'referral'], ['custom', 'clinical']]);
});

test('a plan built from the CHF pathway saves for a clinical patient', () => {
  const p = cat.catalog().pathways.find(x => x.key === 'chf');
  const r = buildCarePlanVersion(null, {
    problemItems: [{ id: 'p-chf001', text: p.problem.text, prognosis: p.problem.prognosis, expectedOutcome: p.problem.expectedOutcome }],
    goalItems: p.goals.map((g, i) => ({ id: `g-chf00${i}`, problemId: 'p-chf001', ...g })),
    interventions: p.interventions.map(iv => ({ code: iv.code, goalIds: ['g-chf000'] })),
    medicationManagement: { managedBy: 'family' },
    outsideCare: { externalTeam: [{ name: 'Dr. Patel' }] },
    visitFrequency: '2x/month',
    escalation: { callGfcWhen: p.callGfcWhen, call911When: p.call911When },
    review: cat.newPlanDefaults('2026-10-14').review
  }, AUTHOR, { serviceLine: 'IHPC' });
  assert.ok(r.plan, r.error);
  assert.equal(r.plan.interventions.length, p.interventions.length);
  assert.ok(r.plan.interventions.every(i => i.code !== 'custom'));
});

test('new-plan defaults: effective today, reviewed every 90 days', () => {
  assert.deepEqual(cat.newPlanDefaults('2026-10-14'), { effectiveDate: '2026-10-14', review: { cadence: '90_days', nextReviewDate: '2027-01-12' } });
  assert.equal(cat.addDays('2026-12-31', 1), '2027-01-01');
});

test('the form is served the catalog and uses it: pathways, coded interventions, pick-lists, defaults', () => {
  const get = SERVER.slice(SERVER.indexOf("app.get('/api/clinical/patients/:clientId/care-plan',"));
  assert.ok(get.slice(0, 3000).includes('catalog: carePlanCatalog.catalog()'));
  assert.ok(get.slice(0, 3000).includes('newPlanDefaults: carePlanCatalog.newPlanDefaults(practiceToday())'));
  assert.ok(CLINICAL.includes('onClick={() => setF(prev => applyPathway(prev, p, on))}'), 'one-click pathway');
  assert.ok(CLINICAL.includes('<option value="custom">Other (type your own)</option>'), 'interventions are picked, with Other');
  assert.ok(CLINICAL.includes('list="cp-prognosis"') && CLINICAL.includes('list="cp-outcomes"'), 'prognosis and outcome pick-lists');
  assert.ok(CLINICAL.includes('existing.newPlanDefaults'), 'smart defaults for a new plan');
  // The page restates no clinical content: no intervention label is written into it.
  const form = CLINICAL.slice(CLINICAL.indexOf('const applyPathway = '), CLINICAL.indexOf('const CarePlanTab = '));
  assert.ok(form.length > 1000, 'precondition: the care plan form was found');
  for (const i of cat.INTERVENTIONS) assert.ok(!form.includes(i.label), `the care plan form restates "${i.label}"`);
});

// Evidence (owner, 2026-10-14): every suggestion names where it comes from.
test('every pathway names its guideline source, and the form shows it', () => {
  for (const p of cat.PATHWAYS) assert.ok(p.source && p.source.length > 10, `${p.key} has no source`);
  assert.ok(/AHA\/ACC\/HFSA/.test(cat.PATHWAYS.find(p => p.key === 'chf').source));
  assert.ok(/STEADI/.test(cat.PATHWAYS.find(p => p.key === 'falls').source));
  assert.ok(/ADA Standards/.test(cat.PATHWAYS.find(p => p.key === 'diabetes').source));
  assert.ok(CLINICAL.includes('title={`Based on: ${p.source}`}') && CLINICAL.includes('Evidence behind these suggestions'));
});

test('guideline thresholds: CHF weight 2-3 lb a day or 5 lb a week; BP goal under 130/80; low sugar under 70', () => {
  const by = (k) => cat.PATHWAYS.find(p => p.key === k);
  assert.ok(by('chf').callGfcWhen.some(x => /2-3 lb in a day or 5 lb in a week/.test(x)));
  assert.ok(by('hypertension').goals[0].target.startsWith('Under 130/80'));
  assert.ok(by('diabetes').callGfcWhen.some(x => /under 70 mg\/dL/.test(x)));
  assert.ok(/Individualized/.test(by('diabetes').goals[0].target), 'A1C goal is individualized, not one number');
  for (const code of ['fall_risk_med_review', 'orthostatic_bp', 'ref_pt', 'home_safety_eval', 'ref_vision', 'footwear_check']) {
    assert.ok(by('falls').interventions.includes(code), `STEADI element missing: ${code}`);
  }
});

test('every standard intervention carries its Omaha System category, and a saved row keeps it', () => {
  const cats = Object.values(cat.OMAHA);
  for (const i of cat.INTERVENTIONS) assert.ok(cats.includes(i.omaha), i.code);
  const { plan } = buildCarePlanVersion(null, { problems: ['x'], goals: ['y'], interventions: [{ code: 'edu_low_sodium' }, { description: 'Own words' }] }, AUTHOR);
  assert.deepEqual(plan.interventions.map(i => i.omaha), ['Teaching, Guidance and Counseling', null]);
});

test('no terminology code is invented: no SNOMED, LOINC or Omaha target code is written into the catalog', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'carePlanCatalog.js'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/snomed|loinc|\bsctid\b/i.test(src), 'add a code only once a loaded code set can check it');
});
