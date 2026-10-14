// Care Coordinator (owner, 2026-10-14). Unlicensed clinical support staff who
// back up the case managers: they prepare notes and book visits, and a
// licensed clinician signs. These tests pin both halves — what a coordinator
// may do, and the licensed acts they may never reach.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const roles = require('../clinicalRoles');
const apptTypes = require('../appointmentTypes');
const notes = require('../clinicalNotes');
const messaging = require('../messagingRepository');
const orderReq = require('../orderRequisitions');

const serverCode = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const coordinator = { id: 'cc1', name: 'Casey Coord', role: 'caseManager', clinicalRole: 'coordinator' };
const readOnlyCm = { id: 'cm1', role: 'caseManager', clinicalRole: 'readOnly' };
const rn = { id: 'rn1', role: 'user', clinicalRole: 'rn' };

const routeLine = (needle) => {
  const line = serverCode.split('\n').find(l => l.includes(needle));
  assert.ok(line, `route not found: ${needle}`);
  return line;
};

test('a coordinator documents and schedules, and holds no licensed capability', () => {
  const C = roles.CAPABILITIES;
  // CARE_PLAN_AUTHOR joined this list on 2026-10-14 (owner): the plan they
  // write waits on a clinician's co-signature, so it is not a licensed act.
  for (const cap of [C.NURSING_NOTE, C.BEHAVIORAL_NOTE, C.VITALS_WRITE, C.SCREENING_INSTRUMENT, C.SCHEDULING, C.CHART_READ, C.CARE_PLAN_AUTHOR]) {
    assert.equal(roles.can(coordinator, cap), true, cap);
  }
  for (const cap of [C.PRESCRIBE, C.ORDER_DIRECT, C.ORDER_STANDING, C.SELECT_SERVICE_CODES, C.SIGN_BILLABLE_ENCOUNTER,
    C.CARE_PLAN_SIGN, C.MED_REC, C.PROBLEM_LIST_WRITE, C.ACKNOWLEDGE_ABNORMAL_RESULT,
    C.AUTHOR_STANDING_ORDER, C.REFER_INTERNAL, C.REFER_EXTERNAL, C.ORDER_STATUS_ADVANCE, C.BEHAVIORAL_DIAGNOSIS]) {
    assert.equal(roles.can(coordinator, cap), false, cap);
  }
  assert.deepEqual(roles.ceilingFor(coordinator), [], 'no standing order can be executed by a coordinator');
});

test('a coordinator is not licensed: they document, they never write as a clinician', () => {
  assert.equal(roles.LICENSED_CLINICAL_ROLES.includes('coordinator'), false);
  assert.equal(roles.derivedHasClinicalAccess(coordinator), false);
  assert.equal(roles.canClinicalWrite(coordinator), false);
  assert.equal(roles.canDocumentClinically(coordinator), true);
  assert.equal(roles.isCoordinator(coordinator), true);
  // The read-only case manager stays read-only; the RN still documents.
  assert.equal(roles.canDocumentClinically(readOnlyCm), false);
  assert.equal(roles.canDocumentClinically(rn), true);
  assert.equal(roles.isCoordinator(rn), false);
});

test('a coordinator never signs or co-signs a note', () => {
  const sig = roles.evaluateEncounterSignature(coordinator, []);
  assert.equal(sig.code, 'SIGN_COORDINATOR');
  assert.equal(roles.evaluateEncounterSignature(coordinator, ['99349']).code, 'SIGN_COORDINATOR');
  assert.equal(roles.canCoSignEncounter(coordinator), false);
  assert.equal(roles.canCoSignNote(coordinator), false);
});

// Owner, 2026-10-14: a coordinator authors and updates a care plan, and it is
// not active until a clinician co-signs it. (This replaces the earlier rule
// that a coordinator could not author one at all.)
test('a coordinator authors a care plan that waits on a clinician, on every line', () => {
  assert.equal(roles.can(coordinator, roles.CAPABILITIES.CARE_PLAN_AUTHOR), true);
  assert.equal(roles.can(coordinator, roles.CAPABILITIES.CARE_PLAN_SIGN), false);
  for (const line of ['PHC', 'IHPC', 'BOTH']) {
    const r = roles.evaluateCarePlanSignature(coordinator, line);
    assert.equal(r.outcome, roles.CARE_PLAN_OUTCOME.PENDING_PROVIDER, line);
    assert.equal(r.signatureRole, 'authoring', line);
    assert.equal(roles.canCompleteCarePlan(coordinator, line), false, `a coordinator never completes a plan (${line})`);
  }
});

test('a coordinator does not document psychotherapy', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'appointmentTypes.js'), 'utf8');
  const types = apptTypes.APPOINTMENT_TYPES || [];
  const psych = types.find(t => t && t.psychotherapy);
  assert.ok(psych || /psychotherapy: true/.test(src), 'precondition: a psychotherapy type exists');
  const key = psych.key;
  assert.equal(apptTypes.canDocumentType(key, 'coordinator').code, 'PSYCHOTHERAPY_NOT_COORDINATOR');
});

test('the note says who prepared it, beside who signed it', () => {
  const record = {};
  notes.stampPreparedBy(record, { id: 'cc1', name: 'Casey Coord', clinicalRole: 'coordinator' });
  notes.stampPreparedBy(record, { id: 'cc1', name: 'Casey Coord', clinicalRole: 'coordinator' });
  notes.stampPreparedBy(record, { id: 'p1', name: 'Bethel Godwins', clinicalRole: 'provider' });
  assert.equal(record.preparedBy.length, 1, 'one line per coordinator, and never a licensed saver');
  const summary = notes.buildSignatureSummary({ attestation: { signedAt: '2026-10-14T15:00:00Z', signedBy: { id: 'p1', name: 'Bethel Godwins' } }, record });
  const lines = notes.signatureBlockLines(summary).join('\n');
  assert.match(lines, /Prepared by Casey Coord — Care Coordinator \(documentation support, not a signature\)/);
  assert.match(lines, /Signed by Bethel Godwins/);
});

test('the note and calendar routes admit a coordinator; the licensed acts do not', () => {
  for (const r of [
    "app.post('/api/clinical/patients/:clientId/notes'",
    "app.put('/api/clinical/patients/:clientId/encounters/:euuid/note'",
    "app.post('/api/clinical/patients/:clientId/appointments'",
    "app.post('/api/clinical/appointments/:eid/reschedule'",
    "app.post('/api/clinical/appointments/:eid/cancel'",
    "app.post('/api/clinical/visits/:eid/timing'"
  ]) assert.match(routeLine(r), /requireClinicalDocumenter/, r);
  for (const r of [
    "app.post('/api/clinical/patients/:clientId/encounters/:euuid/sign'",
    "app.post('/api/clinical/patients/:clientId/encounters/:euuid/prescriptions'",
    "app.post('/api/clinical/patients/:clientId/encounters/:euuid/orders'",
    "app.post('/api/clinical/patients/:clientId/encounters/:euuid/addenda'"
  ]) {
    const l = routeLine(r);
    assert.doesNotMatch(l, /requireClinicalDocumenter/, r);
    assert.match(l, /requireClinicalWrite/, r);
  }
  const mw = serverCode.slice(serverCode.indexOf('const requireClinicalDocumenter ='), serverCode.indexOf('const requireClinicalWrite ='));
  assert.match(mw, /clinicalRoles\.canDocumentClinically\(req\.user\)/);
  assert.match(mw, /CLINICAL_READ_ONLY/, 'a read-only case manager is still refused by name');
});

test('the screen is told it may edit but not sign', () => {
  const i = serverCode.indexOf('noteActions: {');
  const block = serverCode.slice(i, i + 1800);
  assert.match(block, /canEdit: clinicalRoles\.canDocumentClinically\(req\.user\)/);
  assert.match(block, /canSign: clinicalRoles\.canClinicalWrite\(req\.user\)/);
  const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'clinical.html'), 'utf8');
  assert.match(page, /na\.canEdit && na\.canSign !== false && \(/, 'the Sign card needs canSign');
});

test("a coordinator's encounter files under the visit's clinician, not the practice default", () => {
  const i = serverCode.indexOf("app.post('/api/clinical/patients/:clientId/notes'");
  const body = serverCode.slice(i, i + 6000);
  assert.match(body, /if \(coordinator && appointment && appointment\.pc_aid\) encounter\.provider_id = String\(appointment\.pc_aid\)/);
});

test('care coordinators sit on the client record and share the case manager scope', () => {
  const client = { careTeam: { assignedCaseManager: 'cm0', careCoordinators: ['cc1'] } };
  assert.ok(messaging.caseManagerIds(client).includes('cc1'));
  assert.equal(orderReq.isOnCareTeam(client.careTeam, 'cc1'), true);
  assert.match(serverCode, /team\.careCoordinators[^\n]*'Care coordinator'/, 'the portal care team names them');
  const hub = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin-hub.html'), 'utf8');
  assert.match(hub, /Care Coordinators<\/label>/);
  assert.match(hub, /<option value="coordinator">Care Coordinator<\/option>/);
});

test('the LMSW boot migration never overrules a role an admin chose', () => {
  const { users } = roles.applyCaseManagerLmswMigration([{ ...coordinator }], '2026-10-14T00:00:00Z');
  assert.equal(users[0].clinicalRole, 'coordinator');
  // An admin choosing Read-only on a case manager is stamped so the next boot keeps it.
  const put = serverCode.slice(serverCode.indexOf('users[idx].clinicalRole = wanted;'), serverCode.indexOf('users[idx].clinicalRole = wanted;') + 900);
  assert.match(put, /if \(users\[idx\]\.role === config\.ROLES\.CASE_MANAGER && !users\[idx\]\.caseManagerLmswMigration\) \{\s*users\[idx\]\.caseManagerLmswMigration = \{ version: clinicalRoles\.CASE_MANAGER_LMSW_MARKER/);
  const stamped = roles.applyCaseManagerLmswMigration([{ ...readOnlyCm, caseManagerLmswMigration: { version: roles.CASE_MANAGER_LMSW_MARKER, from: 'admin_set' } }]);
  assert.equal(stamped.users[0].clinicalRole, 'readOnly');
});

test('who can complete a coordinator’s plan depends on the service line', () => {
  const provider = { id: 'p1', role: 'user', clinicalRole: 'provider' };
  const lcsw = { id: 'l1', role: 'user', clinicalRole: 'lcsw' };
  const lmsw = { id: 'm1', role: 'caseManager', clinicalRole: 'lmsw' };
  // Home care: an RN's own signature completes a plan, so an RN can co-sign.
  assert.equal(roles.canCompleteCarePlan(rn, 'PHC'), true);
  assert.equal(roles.canCompleteCarePlan(provider, 'PHC'), true);
  // A clinical patient needs a provider or an LCSW.
  assert.equal(roles.canCompleteCarePlan(rn, 'IHPC'), false);
  assert.equal(roles.canCompleteCarePlan(provider, 'IHPC'), true);
  assert.equal(roles.canCompleteCarePlan(lcsw, 'BOTH'), true);
  // An LMSW and read-only staff never complete one.
  assert.equal(roles.canCompleteCarePlan(lmsw, 'PHC'), false);
  assert.equal(roles.canCompleteCarePlan(readOnlyCm, 'PHC'), false);
});

test('the care plan write and goal-status routes admit a coordinator; the co-sign route does not', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const head = (sig) => { const i = server.indexOf(sig); assert.ok(i > 0, sig); return server.slice(i, i + 300); };
  assert.match(head("app.post('/api/clinical/patients/:clientId/care-plan',"), /requireClinicalDocumenter, requireCapability\(clinicalRoles\.CAPABILITIES\.CARE_PLAN_AUTHOR\)/);
  assert.match(head("app.post('/api/clinical/patients/:clientId/care-plan/goals/:goalId/status',"), /requireClinicalDocumenter, requireCapability\(clinicalRoles\.CAPABILITIES\.CARE_PLAN_AUTHOR\)/);
  assert.match(head("app.post('/api/clinical/patients/:clientId/care-plan/provider-cosign',"), /requireClinicalWrite, requireCapability\(clinicalRoles\.CAPABILITIES\.CARE_PLAN_SIGN\)/);
});

test('a coordinator’s pending plan reaches the inbox of whoever can complete it, and nobody else', () => {
  const inbox = require('../clinicalInbox');
  const client = (line) => ({ id: `c-${line}`, name: 'Hattie', serviceLine: line,
    carePlan: { version: 1, providerCoSignStatus: 'pending', authoredById: 'cc1', authoredAt: '2026-10-14T12:00:00Z' } });
  const row = (viewer, line) => inbox.buildInbox({ viewer, carePlanClients: [client(line)], now: '2026-10-14T13:00:00Z' })
    .items.find(i => i.clientId === `c-${line}`);
  assert.equal(row(rn, 'PHC').actionable, true, 'an RN can complete a home care plan');
  assert.equal(row(rn, 'IHPC').actionable, false, 'but not a clinical patient’s');
  assert.equal(row(coordinator, 'PHC').actionable, false, 'the coordinator who wrote it cannot');
});
