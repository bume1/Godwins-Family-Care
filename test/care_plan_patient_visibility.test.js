// ============================================================
// A care plan reaches the patient only once a licensed clinician has signed
// it (owner, 2026-10-14). docs/decisions/2026-10-14-care-plan-patient-visibility.md
//
// Active = not waiting on a co-signature: an RN (or provider/LCSW) signature
// for a home care plan, a provider or LCSW for a clinical patient's.
// clinicalRoles.evaluateCarePlanSignature decides who completes a plan; this
// file checks every door the patient side uses honours the result.
// Run: npm test
// ============================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const fmt = require('../carePlanFormat');
const patientRead = require('../patientReadRepository');
const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const PUBLISH = fs.readFileSync(path.join(__dirname, '..', 'patientPublish.js'), 'utf8');
const PORTAL = fs.readFileSync(path.join(__dirname, '..', 'public', 'portal.html'), 'utf8');

const plan = (version, status) => ({ version, goals: [`goal v${version}`], providerCoSignStatus: status });
const row = (version, status, signed) => ({ client_id: 'c1', version, plan: plan(version, status),
  ...(signed ? { providerSignature: { signatureImage: 'data:image/png;base64,AAA', name: 'Dr' } } : {}) });

test('a plan is active unless it is waiting on a clinician', () => {
  assert.equal(fmt.isPlanActive(plan(1, 'not_required')), true, 'an RN signed a home care plan');
  assert.equal(fmt.isPlanActive(plan(1, 'complete')), true, 'a provider co-signed');
  assert.equal(fmt.isPlanActive({ version: 1, goals: ['x'] }), true, 'written before the co-signature step');
  assert.equal(fmt.isPlanActive(plan(1, 'pending')), false);
  assert.equal(fmt.isPlanActive(null), false);
});

test('a stored version that was pending becomes active once its co-signature is on the row', () => {
  assert.equal(fmt.isPlanActive(row(1, 'pending', false).plan, row(1, 'pending', false)), false);
  assert.equal(fmt.isPlanActive(row(1, 'pending', true).plan, row(1, 'pending', true)), true);
});

test('the patient sees the current plan only when it is active', () => {
  const v = fmt.patientVisiblePlan(plan(2, 'not_required'), []);
  assert.deepEqual([v.version, v.isCurrent, v.newerInReview], [2, true, false]);
  assert.equal(fmt.patientVisiblePlan(plan(1, 'pending'), [row(1, 'pending', false)]), null, 'never active: nothing shown');
});

test('while an update waits on a clinician, the last active version is shown', () => {
  const rows = [row(1, 'not_required'), row(2, 'pending', true), row(3, 'pending', false)];
  const v = fmt.patientVisiblePlan(plan(3, 'pending'), rows);
  assert.deepEqual([v.version, v.isCurrent, v.newerInReview], [2, false, true], 'v2 was co-signed, v3 is waiting');
  assert.equal(v.plan.goals[0], 'goal v2');
});

test('the portal care plan route shows only the visible plan and says when one is in review', () => {
  const start = SERVER.indexOf("app.get('/api/gfc/care-plan',");
  const route = SERVER.slice(start, SERVER.indexOf('\n});', start));
  assert.ok(route.includes('const visible = await loadPatientVisiblePlan(client);'));
  assert.ok(route.includes('buildClientCarePlan(client, visible)'));
  assert.ok(route.includes('carePlanInReview:'));
  assert.ok(!/buildClientCarePlan\(client\)/.test(SERVER), 'no caller builds the patient plan from the raw current plan');
});

test('the client cannot co-sign a plan that is still waiting on a clinician', () => {
  const start = SERVER.indexOf("app.post('/api/gfc/care-plan/cosign'");
  const route = SERVER.slice(start, SERVER.indexOf('\n});', start));
  const gate = route.indexOf("code: 'CARE_PLAN_AWAITING_CLINICIAN'");
  assert.ok(gate > 0 && route.includes('carePlanFormat.isPlanActive(client.carePlan)'));
  assert.ok(gate < route.indexOf("db.set('care_plan_cosign_events'"), 'refused before anything is written');
});

test('the signed PDF and the patient documents list serve only active versions', () => {
  const pdfStart = SERVER.indexOf("app.get('/api/gfc/clinical/care-plan.pdf'");
  assert.ok(SERVER.slice(pdfStart, pdfStart + 1500).includes('loadPatientVisiblePlan(client)'));
  const listStart = SERVER.indexOf("app.get('/api/gfc/clinical/documents',");
  assert.ok(SERVER.slice(listStart, listStart + 2500).includes('carePlanVersions: (planVersions || []).filter(r => r && carePlanFormat.isPlanActive(r.plan, r))'));
  const fileStart = SERVER.indexOf("app.get('/api/gfc/clinical/documents/:docId/file'");
  const careplan = SERVER.slice(SERVER.indexOf("if (kind === 'careplan')", fileStart), SERVER.indexOf("if (kind === 'consent')", fileStart));
  assert.ok(careplan.includes('carePlanFormat.isPlanActive(row.plan, row)'), 'opening a version by id is gated too');
});

test('a pending plan’s problem list does not reach the patient’s health panel', () => {
  assert.ok(PUBLISH.includes("const planOk = c.carePlan && c.carePlan.providerCoSignStatus !== 'pending';"));
  assert.ok(PUBLISH.includes('(planOk && Array.isArray(c.carePlan.problems)'));
});

test('the portal offers no signature on an earlier version and says why', () => {
  assert.ok(patientRead.FILTER_MAP.carePlan.full.includes('coSignable'));
  const line = (name) => (PORTAL.split('\n').find(l => l.includes(`const ${name} = `) && l.includes('hasPlan')) || '');
  assert.ok(line('needsSignature').includes('cp.coSignable !== false'), 'the "your signature is needed" prompt checks it');
  assert.ok(line('padVisible').includes('cp.coSignable !== false'), 'the signature pad checks it');
  assert.ok(PORTAL.includes('data.carePlanInReview'), 'the portal says a plan is in clinical review');
});
