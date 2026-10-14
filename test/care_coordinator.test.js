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
  for (const cap of [C.NURSING_NOTE, C.BEHAVIORAL_NOTE, C.VITALS_WRITE, C.SCREENING_INSTRUMENT, C.SCHEDULING, C.CHART_READ]) {
    assert.equal(roles.can(coordinator, cap), true, cap);
  }
  for (const cap of [C.PRESCRIBE, C.ORDER_DIRECT, C.ORDER_STANDING, C.SELECT_SERVICE_CODES, C.SIGN_BILLABLE_ENCOUNTER,
    C.CARE_PLAN_AUTHOR, C.CARE_PLAN_SIGN, C.MED_REC, C.PROBLEM_LIST_WRITE, C.ACKNOWLEDGE_ABNORMAL_RESULT,
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

test('a coordinator can never sign, co-sign or author a care plan', () => {
  const sig = roles.evaluateEncounterSignature(coordinator, []);
  assert.equal(sig.code, 'SIGN_COORDINATOR');
  assert.equal(roles.evaluateEncounterSignature(coordinator, ['99349']).code, 'SIGN_COORDINATOR');
  assert.equal(roles.canCoSignEncounter(coordinator), false);
  assert.equal(roles.canCoSignNote(coordinator), false);
  for (const line of ['phc', 'ihpc', 'both']) {
    assert.equal(roles.evaluateCarePlanSignature(coordinator, line).code, 'CARE_PLAN_NO_CREDENTIAL', line);
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
