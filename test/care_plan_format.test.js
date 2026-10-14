// ============================================================
// The care plan format (owner-directed, 2026-10-14)
// docs/decisions/2026-10-14-care-plan-format.md
//
//   1. Required fields depend on the service line; a plan with no line keeps
//      the original minimum (a problem and a goal).
//   2. Plans written as plain strings still save, and `problems`/`goals` stay
//      plain lists derived from the structured items.
//   3. Goal status carries across versions by goal id, and updating a status
//      never writes a new version.
//   4. Interventions only point at goals in the same plan; forged ids are
//      replaced.
//   5. Caregiver-scope advice, never a refusal.
//   6. Patients, family and caregivers see projections, never the raw blocks.
//   7. Every client can have a care plan (the routes no longer refuse PHC).
//   8. The signed PDF prints the new sections and never prints goal status.
// Run: npm test
// ============================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { PDFDocument } = require('pdf-lib');

const fmt = require('../carePlanFormat');
const { buildCarePlanVersion } = require('../clinicalRepository');
const patientRead = require('../patientReadRepository');
const cg = require('../caregiverRepository');
const pdf = require('../pdf-generator');
const packetImport = require('../welcomePacketImport');
const { COLLECTION_REGISTRY } = require('../dataMigration');

const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const AUTHOR = { name: 'Bethel Godwins, FNP-C', id: 'u-1', at: '2026-10-14T12:00:00.000Z' };

const PHC_FULL = {
  problemItems: [{ id: 'p-aaaaaa', text: 'Fall risk' }],
  goalItems: [{ id: 'g-aaaaaa', problemId: 'p-aaaaaa', statement: 'No falls this quarter' }],
  eachVisit: ['Walk to the mailbox if steady'],
  visitFrequency: '3x/week',
  escalation: { callGfcWhen: ['Any fall'] },
  review: { cadence: '90_days', nextReviewDate: '2027-01-01' }
};
const IHPC_FULL = {
  problemItems: [{ id: 'p-bbbbbb', text: 'Heart failure', prognosis: 'Stable with adherence', expectedOutcome: 'No admissions this quarter' }],
  goalItems: [{ id: 'g-bbbbbb', problemId: 'p-bbbbbb', statement: 'Stay out of hospital', measure: 'Daily weight', baseline: '181 lb', target: '178 lb', targetDate: '2027-01-01', priority: 'high', patientStated: true }],
  interventions: [{ id: 'i-bbbbbb', goalIds: ['g-bbbbbb'], description: 'Furosemide review', responsible: 'gfc_clinician', frequency: 'each_visit', type: 'medication' }],
  medicationManagement: { managedBy: 'family', adherenceConcerns: 'Skips the evening dose', pharmacy: 'Kroger Acworth' },
  escalation: { callGfcWhen: ['Weight up 3 lb overnight'], call911When: ['Chest pain'], callOrder: ['GFC on-call', 'Angela'], afterHours: 'GFC on-call line' },
  review: { cadence: '90_days', nextReviewDate: '2027-01-01' }
};

const build = (input, line, prev = null) => buildCarePlanVersion(prev, input, AUTHOR, { serviceLine: line });

// ---- 1. Required fields by service line ----------------------------------
test('a home care plan needs tasks, a frequency, escalation and a review; nothing clinical', () => {
  assert.ok(build(PHC_FULL, 'PHC').plan, 'a complete home care plan saves without prognosis, measures or medications');
  for (const [drop, key] of [['eachVisit', 'eachVisit'], ['visitFrequency', 'visitFrequency'], ['escalation', 'escalation'], ['review', 'review']]) {
    const r = build({ ...PHC_FULL, [drop]: undefined }, 'PHC');
    assert.equal(r.code, 'CARE_PLAN_INCOMPLETE', `dropping ${drop} must refuse`);
    assert.deepEqual(r.missing, [key]);
  }
});

test('a clinical plan also needs prognosis, outcome, measures, an intervention and medication management', () => {
  assert.ok(build(IHPC_FULL, 'IHPC').plan);
  const noPrognosis = build({ ...IHPC_FULL, problemItems: [{ ...IHPC_FULL.problemItems[0], prognosis: '' }] }, 'IHPC');
  assert.deepEqual(noPrognosis.missing, ['problemDetail']);
  const noTarget = build({ ...IHPC_FULL, goalItems: [{ ...IHPC_FULL.goalItems[0], target: '' }] }, 'IHPC');
  assert.deepEqual(noTarget.missing, ['goalMeasures']);
  assert.deepEqual(build({ ...IHPC_FULL, interventions: [] }, 'IHPC').missing, ['interventions']);
  assert.deepEqual(build({ ...IHPC_FULL, medicationManagement: {} }, 'IHPC').missing, ['medicationManagement']);
  // IHPC-only has no caregiver schedule to require.
  assert.ok(!fmt.REQUIREMENTS.IHPC.includes('eachVisit'));
});

test('BOTH needs the clinical blocks AND the home care schedule', () => {
  const r = build(IHPC_FULL, 'BOTH');
  assert.deepEqual(r.missing, ['eachVisit', 'visitFrequency']);
  assert.ok(build({ ...IHPC_FULL, eachVisit: ['Weight before breakfast'], visitFrequency: '5x/week' }, 'BOTH').plan);
});

test('the refusal names what is missing in words', () => {
  const r = build({ ...PHC_FULL, eachVisit: [] }, 'PHC');
  assert.match(r.error, /at least one task for each visit/);
  assert.deepEqual(r.missingLabels, [fmt.REQUIREMENT_LABELS.eachVisit]);
});

test('with no service line only a problem and a goal are required, as before', () => {
  assert.ok(buildCarePlanVersion(null, { problems: ['p'], goals: ['g'] }, AUTHOR).plan);
});

// ---- 2. Plain strings still work; derived lists ---------------------------
test('plain string problems and goals still save, and become structured items', () => {
  const { plan } = buildCarePlanVersion(null, { problems: ['Hypertension'], goals: ['BP under 130/80'] }, AUTHOR);
  assert.deepEqual(plan.problems, ['Hypertension']);
  assert.deepEqual(plan.goals, ['BP under 130/80']);
  assert.equal(plan.goalItems[0].statement, 'BP under 130/80');
  assert.match(plan.goalItems[0].id, /^g-[a-z0-9]+$/);
  assert.equal(plan.goalItems[0].status, 'not_started');
});

test('problems and goals are derived from the structured items, so the two never disagree', () => {
  const { plan } = build(IHPC_FULL, 'IHPC');
  assert.deepEqual(plan.problems, ['Heart failure']);
  assert.deepEqual(plan.goals, ['Stay out of hospital']);
});

test('an older plan is shown in the new shape without being rewritten', () => {
  const old = { version: 2, problems: ['CHF'], goals: ['Walk daily'] };
  const view = fmt.structuredView(old);
  assert.equal(view.legacyFormat, true);
  assert.equal(view.goalItems[0].statement, 'Walk daily');
  assert.equal(view.goalItems[0].id, null, 'no id is invented for a goal that was never given one');
  assert.equal(old.goalItems, undefined, 'the stored plan is not touched');
});

// ---- 3. Goal status --------------------------------------------------------
test('goal status carries into the next version by goal id', () => {
  const v1 = build(IHPC_FULL, 'IHPC').plan;
  const updated = fmt.applyGoalStatus(v1, 'g-bbbbbb', { status: 'in_progress', note: 'down to 179' }, { id: 'u-2', name: 'RN Two' }, '2026-10-20T10:00:00Z').plan;
  const v2 = build(IHPC_FULL, 'IHPC', updated).plan;
  assert.equal(v2.version, 2);
  assert.equal(v2.goalItems[0].status, 'in_progress');
  assert.equal(v2.goalItems[0].statusBy, 'RN Two', 'carried, not restamped by the new author');
  assert.equal(v2.goalItems[0].statusNote, 'down to 179');
});

test('a status update does not create a new version', () => {
  const v1 = build(IHPC_FULL, 'IHPC').plan;
  const r = fmt.applyGoalStatus(v1, 'g-bbbbbb', { status: 'met' }, { id: 'u-2', name: 'RN Two' }, '2026-10-20T10:00:00Z');
  assert.equal(r.plan.version, v1.version);
  assert.equal(r.plan.goalItems[0].status, 'met');
  assert.deepEqual({ previous: r.event.previous, status: r.event.status, planVersion: r.event.planVersion }, { previous: 'not_started', status: 'met', planVersion: 1 });
  assert.equal(v1.goalItems[0].status, 'not_started', 'the input plan is not mutated');
});

test('a status update is refused when it cannot be applied, by name', () => {
  const v1 = build(IHPC_FULL, 'IHPC').plan;
  const actor = { id: 'u', name: 'X' };
  assert.equal(fmt.applyGoalStatus(v1, 'g-bbbbbb', { status: 'done' }, actor, 't').code, 'GOAL_STATUS_INVALID');
  assert.equal(fmt.applyGoalStatus(v1, 'g-zzzzzz', { status: 'met' }, actor, 't').code, 'GOAL_NOT_FOUND');
  assert.equal(fmt.applyGoalStatus(v1, 'g-bbbbbb', { status: 'not_started' }, actor, 't').code, 'GOAL_STATUS_UNCHANGED');
  assert.equal(fmt.applyGoalStatus({ version: 1, goals: ['x'] }, 'g-bbbbbb', { status: 'met' }, actor, 't').code, 'CARE_PLAN_LEGACY_GOALS');
});

test('the status route writes no version row and is gated to whoever writes plans (clinicians and coordinators)', () => {
  const start = SERVER.indexOf("app.post('/api/clinical/patients/:clientId/care-plan/goals/:goalId/status'");
  assert.ok(start > 0, 'the status route exists');
  const route = SERVER.slice(start, SERVER.indexOf('\n});', start));
  assert.match(route, /requireClinicalDocumenter, requireCapability\(clinicalRoles\.CAPABILITIES\.CARE_PLAN_AUTHOR\)/);
  assert.ok(!route.includes("'care_plan_versions'"), 'a status change never writes a version row');
  assert.ok(route.includes("'care_plan_goal_status_events'"), 'every change is its own row');
  const logCall = route.slice(route.indexOf('logActivity('));
  assert.ok(!/note/.test(logCall.slice(0, logCall.indexOf(');'))), 'the audit row never carries the note');
});

test('the status history collection is registered as PHI', () => {
  const row = COLLECTION_REGISTRY.find(r => r.key === 'care_plan_goal_status_events');
  assert.ok(row && row.phi === true);
});

// ---- 4. Ids and references -------------------------------------------------
test('interventions only point at goals in the same plan', () => {
  const { plan } = build({ ...IHPC_FULL, interventions: [{ ...IHPC_FULL.interventions[0], goalIds: ['g-bbbbbb', 'g-notreal'] }] }, 'IHPC');
  assert.deepEqual(plan.interventions[0].goalIds, ['g-bbbbbb']);
});

test('an id that is not shaped like one of ours is replaced, never kept', () => {
  const { plan } = build({ ...IHPC_FULL, goalItems: [{ ...IHPC_FULL.goalItems[0], id: '<script>' }] }, 'IHPC');
  assert.match(plan.goalItems[0].id, /^g-[a-z0-9]+$/);
});

test('an unknown option falls back rather than being stored', () => {
  const { plan } = build({ ...IHPC_FULL, interventions: [{ ...IHPC_FULL.interventions[0], responsible: 'someone', frequency: 'hourly', type: 'magic' }] }, 'IHPC');
  assert.deepEqual([plan.interventions[0].responsible, plan.interventions[0].frequency, plan.interventions[0].type], ['gfc_clinician', 'ongoing', 'clinical']);
});

// ---- 5. Caregiver scope advice ---------------------------------------------
test('medication work assigned to a caregiver is flagged, and saving still goes ahead', () => {
  const r = build({
    ...PHC_FULL,
    eachVisit: ['Fill the weekly pill organizer', 'Check blood pressure'],
    interventions: [{ description: 'Give evening dose', responsible: 'gfc_caregiver', type: 'medication', frequency: 'daily' }],
    medicationManagement: { managedBy: 'caregiver' }
  }, 'PHC');
  assert.ok(r.plan, 'advice never refuses the save');
  const where = r.warnings.map(w => w.where);
  assert.ok(where.includes('Each visit') && where.includes('Intervention') && where.includes('Medications'));
  assert.ok(r.warnings.some(w => /reminders only/.test(w.warning)));
  assert.ok(r.warnings.some(w => /signed off/.test(w.warning)), 'a measurement needs a sign-off');
});

test('the same work assigned to a clinician raises nothing', () => {
  assert.deepEqual(build(IHPC_FULL, 'IHPC').warnings, []);
});

// ---- 6. Who sees what --------------------------------------------------------
test('the patient sees goals, interventions and escalation, never prognosis, adherence notes or ids', () => {
  const plan = build(IHPC_FULL, 'IHPC').plan;
  const proj = fmt.patientProjection(plan);
  assert.equal(proj.goalProgress[0].statement, 'Stay out of hospital');
  assert.equal(proj.goalProgress[0].statusLabel, 'Not started');
  assert.equal(proj.interventionList[0].who, 'GFC clinician');
  assert.deepEqual(proj.escalationPlan.call911When, ['Chest pain']);
  const flat = JSON.stringify(proj);
  for (const secret of ['Stable with adherence', 'Skips the evening dose', 'g-bbbbbb', 'p-bbbbbb', 'i-bbbbbb']) {
    assert.ok(!flat.includes(secret), `the patient view must not carry "${secret}"`);
  }
});

test('the portal filter carries the projections and never the raw structured blocks', () => {
  const full = patientRead.FILTER_MAP.carePlan.full;
  for (const raw of ['goalItems', 'problemItems', 'interventions', 'medicationManagement', 'outsideCare', 'escalation', 'review', 'chargePlanNote']) {
    assert.ok(!full.includes(raw), `${raw} must not reach a patient`);
  }
  for (const p of ['goalProgress', 'interventionList', 'escalationPlan', 'nextReviewDate']) assert.ok(full.includes(p));
  assert.ok(!patientRead.FILTER_MAP.carePlan.summary.includes('goalProgress'), 'family at the summary level get the plain goal list');
});

test('a caregiver sees their tasks, schedule, their own interventions and escalation, nothing clinical', () => {
  const plan = build({ ...IHPC_FULL, eachVisit: ['Weight before breakfast'], visitFrequency: '5x/week',
    interventions: [...IHPC_FULL.interventions, { description: 'Log daily weight', responsible: 'gfc_caregiver', type: 'caregiver_task', frequency: 'daily' }] }, 'BOTH').plan;
  const view = cg.caregiverClientView({ id: 'c1', name: 'Mary', carePlan: plan });
  assert.deepEqual(view.carePlan.tasks, ['Weight before breakfast']);
  assert.equal(view.carePlan.frequency, '5x/week');
  assert.deepEqual(view.carePlan.caregiverInterventions.map(i => i.description), ['Log daily weight']);
  assert.deepEqual(view.carePlan.escalation.callGfcWhen, ['Weight up 3 lb overnight']);
  const flat = JSON.stringify(view);
  for (const secret of ['Heart failure', 'Furosemide', 'Skips the evening dose', 'Stable with adherence']) {
    assert.ok(!flat.includes(secret), `the caregiver view must not carry "${secret}"`);
  }
});

// ---- 7. Every client can have a care plan ---------------------------------
test('the care plan routes accept every client, home care included', () => {
  for (const sig of [
    "app.get('/api/clinical/patients/:clientId/care-plan',",
    "app.post('/api/clinical/patients/:clientId/care-plan',",
    "app.post('/api/clinical/patients/:clientId/care-plan/provider-cosign',"
  ]) {
    const start = SERVER.indexOf(sig);
    assert.ok(start > 0, sig);
    const head = SERVER.slice(start, start + 600);
    assert.ok(head.includes('loadCarePlanClient('), `${sig} must not refuse a home care client`);
    assert.ok(!head.includes('loadClinicalClient('), sig);
  }
});

test('the save passes the client’s service line, so the right fields are required', () => {
  const start = SERVER.indexOf("app.post('/api/clinical/patients/:clientId/care-plan',");
  const route = SERVER.slice(start, start + 2500);
  const call = route.slice(route.indexOf('buildCarePlanVersion('), route.indexOf('if (built.error)'));
  assert.ok(call.includes("{ serviceLine: client.serviceLine || 'PHC' }"), call);
});

test('a home care plan waiting on a second signature still reaches the inbox', () => {
  const start = SERVER.indexOf("app.get('/api/clinical/inbox'");
  const route = SERVER.slice(start, start + 1500);
  assert.ok(!/carePlanClients = clients\.filter\(c => isClinicalServiceLine/.test(route));
});

// ---- 8. The signed PDF ----------------------------------------------------
const pdfText = async (buffer) => {
  const doc = await PDFDocument.load(buffer);
  return (await packetImport.extractRuns(doc)).map(r => r.text).join(' ').replace(/\s+/g, ' ');
};

test('the PDF prints the new sections and never prints goal status', async () => {
  const v1 = build(IHPC_FULL, 'IHPC').plan;
  const plan = fmt.applyGoalStatus(v1, 'g-bbbbbb', { status: 'in_progress' }, { id: 'u', name: 'RN' }, '2026-10-20T10:00:00Z').plan;
  const text = await pdfText(await pdf.generateCarePlanPDF({
    state: 'authored', patientName: 'Mary J', patientDOB: '1948-01-01', serviceLine: 'IHPC',
    codeStatus: 'DNR on file', plan, rnSignature: { name: 'RN', at: '2026-10-14T12:00:00Z' }, clientSignature: { pending: true }
  }));
  for (const want of ['Stable with adherence', 'Daily weight', 'Furosemide review', 'Weight up 3 lb overnight', 'Chest pain', 'DNR on file', 'Kroger Acworth', 'Every 90 days']) {
    assert.ok(text.includes(want), `the PDF must print "${want}"`);
  }
  assert.ok(!text.includes('In progress'), 'status changes without a new version, so the signed PDF never prints it');
});

test('a plan written before the format still prints as before', async () => {
  const text = await pdfText(await pdf.generateCarePlanPDF({
    state: 'authored', patientName: 'Mary J', patientDOB: '', serviceLine: 'PHC',
    plan: { version: 1, problems: ['CHF'], goals: ['Walk daily'], eachVisit: ['Bath'], visitFrequency: '3x/week' },
    rnSignature: { name: 'RN', at: '2026-10-14T12:00:00Z' }, clientSignature: { pending: true }
  }));
  for (const want of ['CHF', 'Walk daily', 'Bath', '3x/week']) assert.ok(text.includes(want), want);
  assert.ok(!/SAFETY AND ESCALATION/i.test(text), 'no empty new sections on an old plan');
});

test('the requirements check stands on its own, not only behind the builder', () => {
  const empty = { problemItems: [], goalItems: [], interventions: [], eachVisit: [], visitFrequency: '',
    medicationManagement: {}, escalation: { callGfcWhen: [] }, review: {} };
  assert.deepEqual(fmt.missingRequirements(empty, 'PHC'), ['problems', 'goals', 'eachVisit', 'visitFrequency', 'escalation', 'review']);
  assert.deepEqual(fmt.missingRequirements(empty, null), ['problems', 'goals']);
});
