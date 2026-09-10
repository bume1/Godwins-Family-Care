// ============================================================================
// Caregiver app (Session 6) — build-enforced invariants
//
// The tests that matter here are not "does the form render". They are the four
// rules that, if they ever broke, would break quietly and wrongly:
//
//   1. A Sitter or PCA form NEVER surfaces a skilled or delegated field, and a
//      skilled field posted anyway is ABSENT from the stored payload — not
//      hidden, absent. (spec §3)
//   2. A CNA without the verified competency does not receive that field, and
//      an unverified or expired competency counts as not present. (§3c, profile §4)
//   3. Escalation routes off the patient's care team, and the confirmation
//      names the actual humans. (§4)
//   4. A caregiver cannot read a client they are not assigned to, and never
//      sees rates, billing or clinical narrative. (§5)
//
// Every one of these was written to FAIL if the behaviour is reverted.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const cg = require('../caregiverRepository');

// ---- Fixtures --------------------------------------------------------------
const caregiver = (licenseLevel, competencies = [], extra = {}) => ({
  id: `cg-${licenseLevel}`, name: `Test ${licenseLevel}`, role: 'vendor', licenseLevel,
  skilledCompetencies: competencies.map(c => (typeof c === 'string' ? { task: c, verified: true } : c)),
  ...extra
});

const client = (extra = {}) => ({
  id: 'client-1', name: 'Margaret Whitfield', role: 'client',
  careTier: 'A2', careTeam: { assignedFNPs: [], assignedCaseManager: null, primaryCaregiver: null, backupCaregiver: null },
  ...extra
});

const taskIdsIn = (schema) =>
  (schema.taskGroups || []).reduce((acc, g) => acc.concat(g.items.map(i => i.id)), []);

// ============================================================================
// 1. Tier branching — all four levels
// ============================================================================

test('sitter sees presence, companionship and observation only — no ADLs, no skilled work', () => {
  const schema = cg.visitLogSchemaFor(caregiver('sitter'));
  const ids = taskIdsIn(schema);
  assert.strictEqual(schema.level, 'sitter');
  assert.ok(ids.includes('presence_confirmed'), 'sitter documents presence');
  assert.ok(ids.includes('companion'), 'sitter documents companionship');
  assert.ok(ids.includes('fluid'), 'sitter may offer fluids');
  // Excluded per spec §3b: every personal-care ADL, transfers, household,
  // medication support, vitals, and every skilled task.
  for (const forbidden of ['bath', 'toileting', 'peri', 'dressing', 'transfers', 'sweep', 'med_remind']) {
    assert.ok(!ids.includes(forbidden), `sitter must not be offered "${forbidden}"`);
  }
  assert.strictEqual(schema.measurements.length, 0, 'sitter records no measurements');
});

test('PCA sees the full ADL/IADL set and medication REMINDER — never administration', () => {
  const schema = cg.visitLogSchemaFor(caregiver('pca'));
  const ids = taskIdsIn(schema);
  for (const expected of ['bath', 'toileting', 'peri', 'dressing', 'transfers', 'sweep', 'cook', 'med_remind']) {
    assert.ok(ids.includes(expected), `PCA documents "${expected}"`);
  }
  assert.ok(!ids.includes('med_administer'),
    'a PCA form must never offer medication administration — reminder only');
  assert.strictEqual(schema.measurements.length, 0, 'PCA records no vitals');
});

test('CNA WITH competencies sees vitals, glucose and intake/output; the PCA set is still there', () => {
  const schema = cg.visitLogSchemaFor(caregiver('cna', ['vital_signs', 'blood_glucose', 'intake_output']));
  const ids = taskIdsIn(schema);
  assert.ok(ids.includes('bath'), 'CNA keeps the whole PCA set');
  assert.ok(ids.includes('vitals') && ids.includes('blood_sugar') && ids.includes('intake_output'));
  const measurementIds = schema.measurements.map(m => m.id);
  for (const m of ['temperatureF', 'bloodPressure', 'pulse', 'bloodGlucose', 'intakeMl', 'outputMl']) {
    assert.ok(measurementIds.includes(m), `CNA with the competency records "${m}"`);
  }
});

test('LPN gets the skilled note plus the clinical narrative, and files as Pending Review', () => {
  const schema = cg.visitLogSchemaFor(caregiver('lpn', ['wound_care', 'injections', 'med_administration']));
  const ids = taskIdsIn(schema);
  assert.ok(ids.includes('wound') && ids.includes('injection') && ids.includes('med_administer'));
  const narrativeIds = schema.narratives.map(n => n.id);
  assert.ok(narrativeIds.includes('clinicalObservations') && narrativeIds.includes('responseToTreatment'),
    'the skilled visit note carries clinical observations and response to treatment');
  assert.strictEqual(schema.submitStatus, 'pending_review');
  assert.strictEqual(schema.skilledNote, true);
  // An LPN performs vitals under their own license, no competency needed.
  assert.ok(schema.measurements.map(m => m.id).includes('bloodPressure'),
    'an LPN records vitals by license, not by delegated competency');
});

test('SAFETY: no skilled or delegated task id can reach a Sitter or PCA schema', () => {
  for (const level of ['sitter', 'pca']) {
    // Even handed every competency in the book — a competency must not
    // promote someone past their license level.
    const schema = cg.visitLogSchemaFor(caregiver(level, cg.COMPETENCIES.slice()));
    const ids = taskIdsIn(schema);
    for (const restricted of cg.RESTRICTED_TASK_IDS) {
      assert.ok(!ids.includes(restricted),
        `${level} must never be offered the restricted task "${restricted}", competency or not`);
    }
    assert.strictEqual(schema.measurements.length, 0,
      `${level} must never be offered a measurement field`);
  }
});

test('a caregiver with no license level gets no form at all', () => {
  const schema = cg.visitLogSchemaFor({ id: 'x', role: 'vendor', licenseLevel: null });
  assert.strictEqual(schema.valid, false);
  assert.strictEqual(schema.reason, 'NO_LICENSE_LEVEL');
  assert.deepStrictEqual(schema.taskGroups, []);
});

// ============================================================================
// 2. Competency gating — fails safe
// ============================================================================

test('a CNA WITHOUT the competency does not receive that field', () => {
  const schema = cg.visitLogSchemaFor(caregiver('cna', ['blood_glucose']));
  const ids = taskIdsIn(schema);
  assert.ok(ids.includes('blood_sugar'), 'the competency they hold is offered');
  assert.ok(!ids.includes('vitals'), 'the competency they do NOT hold is withheld');
  assert.ok(!ids.includes('temperature'));
  const measurementIds = schema.measurements.map(m => m.id);
  assert.ok(measurementIds.includes('bloodGlucose'));
  assert.ok(!measurementIds.includes('bloodPressure'),
    'a CNA without vital_signs must not be offered a blood-pressure field');
});

test('a CNA with NO competencies recorded gets the PCA form and nothing more', () => {
  const schema = cg.visitLogSchemaFor(caregiver('cna', []));
  const ids = taskIdsIn(schema);
  assert.ok(ids.includes('bath'), 'the PCA scope is intact');
  for (const delegated of ['vitals', 'blood_sugar', 'intake_output', 'turn_schedule']) {
    assert.ok(!ids.includes(delegated), `"${delegated}" needs a recorded competency`);
  }
  assert.strictEqual(schema.measurements.length, 0);
});

test('SAFETY: an unverified or expired competency counts as NOT PRESENT', () => {
  const unverified = caregiver('cna', [{ task: 'vital_signs', verified: false }]);
  assert.deepStrictEqual(cg.verifiedCompetencies(unverified), [],
    'verified:false must fail the filter, not merely lower a score');

  const expired = caregiver('cna', [{ task: 'vital_signs', verified: true, expiry: '2020-01-01' }]);
  assert.deepStrictEqual(cg.verifiedCompetencies(expired), [],
    'a past expiry must fail the filter');

  const future = caregiver('cna', [{ task: 'vital_signs', verified: true, expiry: '2099-01-01' }]);
  assert.deepStrictEqual(cg.verifiedCompetencies(future), ['vital_signs']);

  // A bare string carries no verification, so it cannot count.
  assert.deepStrictEqual(cg.verifiedCompetencies({ skilledCompetencies: ['vital_signs'] }), []);

  assert.ok(!taskIdsIn(cg.visitLogSchemaFor(expired)).includes('vitals'),
    'an expired competency must not put the field back on the form');
});

// ============================================================================
// 3. Sanitization — the field is ABSENT, not hidden
// ============================================================================

test('SAFETY: a skilled field posted by a PCA is absent from the stored payload', () => {
  const schema = cg.visitLogSchemaFor(caregiver('pca'));
  const { clean, rejected } = cg.sanitizeVisitLogSubmission(schema, {
    tasks: { bath: { done: true }, wound: { done: true }, med_administer: { done: true }, vitals: { done: true } },
    measurements: { bloodPressure: '120/80', bloodGlucose: '98' },
    narratives: { additionalNotes: 'ok', clinicalObservations: 'wound clean and dry' }
  });

  assert.ok(clean.tasks.bath, 'the in-scope task stores');
  for (const key of ['wound', 'med_administer', 'vitals']) {
    assert.strictEqual(Object.prototype.hasOwnProperty.call(clean.tasks, key), false,
      `"${key}" must be ABSENT from a PCA payload, not stored false`);
  }
  assert.deepStrictEqual(clean.measurements, {}, 'a PCA stores no measurements at all');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(clean.narratives, 'clinicalObservations'), false,
    'the LPN clinical narrative must be absent from a PCA payload');
  assert.ok(clean.narratives.additionalNotes, 'the in-scope narrative survives');

  // The attempt is reported so it can be audited rather than silently swallowed.
  for (const key of ['tasks.wound', 'tasks.med_administer', 'measurements.bloodPressure', 'narratives.clinicalObservations']) {
    assert.ok(rejected.includes(key), `the dropped field "${key}" must be reported`);
  }
});

test('a sitter posting the whole PCA form keeps only the sitter subset', () => {
  const schema = cg.visitLogSchemaFor(caregiver('sitter'));
  const { clean } = cg.sanitizeVisitLogSubmission(schema, {
    tasks: ['presence_confirmed', 'companion', 'bath', 'peri', 'transfers', 'med_remind']
  });
  assert.deepStrictEqual(Object.keys(clean.tasks).sort(), ['companion', 'presence_confirmed']);
});

test('unknown condition, safety and standing-instruction ids are dropped', () => {
  const schema = cg.visitLogSchemaFor(caregiver('pca'));
  const { clean, rejected } = cg.sanitizeVisitLogSubmission(schema, {
    patientCondition: ['alert', 'sedated'],
    safetyConcerns: ['falls', 'made_up'],
    standingInstructionsAcknowledged: ['report_falls', 'nonsense'],
    satisfaction: 'thrilled'
  });
  assert.deepStrictEqual(clean.patientCondition, ['alert']);
  assert.deepStrictEqual(clean.safetyConcerns, ['falls']);
  assert.deepStrictEqual(clean.standingInstructionsAcknowledged, ['report_falls']);
  assert.strictEqual(clean.satisfaction, null, 'an unknown satisfaction value is not stored');
  assert.ok(rejected.includes('patientCondition.sedated') && rejected.includes('safetyConcerns.made_up'));
});

// ============================================================================
// 4. Care-plan narrowing
// ============================================================================

test('the checklist narrows to the tasks the care plan authorizes', () => {
  const withPlan = client({ carePlan: { version: 1, tasks: ['bath', 'toileting', 'Change linens'] } });
  const schema = cg.visitLogSchemaFor(caregiver('pca'), withPlan);
  const ids = taskIdsIn(schema);
  assert.ok(ids.includes('bath') && ids.includes('toileting'));
  assert.ok(ids.includes('linens'), 'a plan naming a task by its label maps to the same item');
  assert.ok(!ids.includes('peri'), 'a task the plan does not authorize is not offered');
  assert.ok(ids.includes('presence_confirmed'), 'presence is always documentable');
});

test('a care plan that maps to nothing known does NOT blank the form', () => {
  const odd = client({ carePlan: { version: 1, tasks: ['something we cannot map'] } });
  const ids = taskIdsIn(cg.visitLogSchemaFor(caregiver('pca'), odd));
  assert.ok(ids.length > 10, 'an unmappable plan falls back to the full level-appropriate catalog');
  assert.strictEqual(cg.authorizedTaskIds(odd), null);
});

test('a care plan can never widen scope past the license level', () => {
  const plan = client({ carePlan: { version: 1, tasks: ['wound', 'injection', 'bath'] } });
  const ids = taskIdsIn(cg.visitLogSchemaFor(caregiver('pca'), plan));
  assert.ok(!ids.includes('wound') && !ids.includes('injection'),
    'the care plan authorizes the CLIENT to receive a task; it does not license the caregiver');
  assert.ok(ids.includes('bath'));
});

// ============================================================================
// 5. Escalation — routing, severity, confirmation, lifecycle
// ============================================================================

const users = [
  { id: 'fnp-1', name: 'Bethel Godwins', email: 'bethel@example.test', role: 'user', hasClinicalAccess: true, licenseLevel: 'fnp' },
  { id: 'fnp-2', name: 'Dianne Cole', email: 'dianne@example.test', role: 'user', hasClinicalAccess: true },
  { id: 'cm-1', name: 'Courtney Hale', email: 'courtney@example.test', role: 'caseManager' },
  { id: 'admin-1', name: 'GFC Admin', email: 'admin@example.test', role: 'admin' },
  { id: 'cg-pca', name: 'Test pca', email: 'pca@example.test', role: 'vendor', licenseLevel: 'pca' }
];
const teamed = client({ careTeam: { assignedFNPs: ['fnp-1'], assignedCaseManager: 'cm-1', primaryCaregiver: 'cg-pca', backupCaregiver: null } });

test('Clinical notifies the assigned FNPs and nobody else', () => {
  const r = cg.routeEscalation({ concernType: 'clinical', client: teamed, users });
  assert.deepStrictEqual(r.notify.map(n => n.id), ['fnp-1']);
  assert.strictEqual(r.severity, 'standard');
  assert.strictEqual(r.requiresDescription, false);
  assert.ok(!r.notify.some(n => n.id === 'cm-1'), 'the case manager is not paged on a clinical concern');
  assert.ok(!r.notify.some(n => n.id === 'admin-1'), 'admin has visibility but is not paged');
  assert.ok(r.visibility.map(v => v.id).includes('admin-1'), 'admin always has visibility');
});

test('Behavioral notifies the case manager only', () => {
  const r = cg.routeEscalation({ concernType: 'behavioral', client: teamed, users });
  assert.deepStrictEqual(r.notify.map(n => n.id), ['cm-1']);
  assert.ok(!r.notify.some(n => n.id === 'fnp-1'));
});

test('Safety-urgent notifies FNPs, case manager and admin, and adds SMS', () => {
  const r = cg.routeEscalation({ concernType: 'safety_urgent', client: teamed, users });
  assert.deepStrictEqual(r.notify.map(n => n.id).sort(), ['admin-1', 'cm-1', 'fnp-1']);
  assert.strictEqual(r.severity, 'urgent');
  assert.strictEqual(r.requiresDescription, true, 'urgent requires a one-line description');
  assert.deepStrictEqual(r.channels, ['in_app', 'push', 'sms']);
});

test('severity is derived from the type — the caregiver never picks it', () => {
  assert.strictEqual(cg.severityForConcernType('clinical'), 'standard');
  assert.strictEqual(cg.severityForConcernType('behavioral'), 'standard');
  assert.strictEqual(cg.severityForConcernType('safety_urgent'), 'urgent');
  assert.strictEqual(cg.severityForConcernType('made_up'), null);
});

test('the confirmation names the actual recipients, not a generic toast', () => {
  const r = cg.routeEscalation({ concernType: 'safety_urgent', client: teamed, users });
  const text = cg.escalationConfirmation(r);
  assert.ok(text.includes('Bethel Godwins'), 'the FNP is named');
  assert.ok(text.includes('Courtney Hale, case manager'), 'the case manager is named with their role');
  assert.match(text, /^Sent to /);
  // Two recipients read "A and B"; three or more use the serial comma.
  assert.strictEqual(cg.describeRecipients([{ name: 'A', role: 'admin' }, { name: 'B', role: 'FNP' }]),
    'A, admin and B, FNP');
});

test('a concern with nobody assigned falls back to admin and SAYS SO', () => {
  const orphan = client({ careTeam: { assignedFNPs: [], assignedCaseManager: null } });
  const r = cg.routeEscalation({ concernType: 'clinical', client: orphan, users });
  assert.strictEqual(r.fallbackToAdmin, true);
  assert.deepStrictEqual(r.notify.map(n => n.id), ['admin-1']);
  assert.match(cg.escalationConfirmation(r), /No clinician is assigned/,
    'an unrouted concern must never read as if it reached the intended person');
});

test('escalation status advances forward only, through all four states', () => {
  assert.ok(cg.canAdvanceEscalation('raised', 'received'));
  assert.ok(cg.canAdvanceEscalation('received', 'acknowledged'));
  assert.ok(cg.canAdvanceEscalation('acknowledged', 'action_taken'));
  assert.ok(cg.canAdvanceEscalation('action_taken', 'resolved'));
  assert.ok(cg.canAdvanceEscalation('acknowledged', 'resolved'), 'acknowledged may resolve directly');

  assert.ok(!cg.canAdvanceEscalation('resolved', 'acknowledged'), 'a resolved concern cannot be reopened backwards');
  assert.ok(!cg.canAdvanceEscalation('received', 'resolved'), 'a recipient must acknowledge before resolving');
  assert.ok(!cg.canAdvanceEscalation('raised', 'acknowledged'));
  assert.deepStrictEqual(cg.ESCALATION_NOTE_REQUIRED.slice(), ['action_taken', 'resolved']);
});

test('an unknown concern type is refused rather than defaulted', () => {
  const r = cg.routeEscalation({ concernType: 'kind-of-worried', client: teamed, users });
  assert.strictEqual(r.valid, false);
  assert.strictEqual(r.reason, 'INVALID_CONCERN_TYPE');
});

// ============================================================================
// 6. Incidents — a separate record, not a checkbox
// ============================================================================

test('falls and abuse/neglect spawn incident records; other concerns do not', () => {
  const incidents = cg.incidentsFromSubmission({ safetyConcerns: ['falls', 'abuse_neglect', 'weight_loss'] });
  assert.deepStrictEqual(incidents.map(i => i.kind).sort(), ['abuse_neglect', 'falls']);
  assert.strictEqual(cg.incidentsFromSubmission({ safetyConcerns: ['weight_loss', 'meal_consumption'] }).length, 0);
  assert.deepStrictEqual(cg.INCIDENT_SAFETY_CONCERNS.slice().sort(), ['abuse_neglect', 'falls']);
});

// ============================================================================
// 7. RBAC (spec §5)
// ============================================================================

test('a caregiver reaches a client only through an explicit assignment', () => {
  const byId = caregiver('pca', [], { id: 'cg-1', assignedClients: ['client-1'] });
  const byName = caregiver('pca', [], { id: 'cg-2', assignedClients: ['Margaret Whitfield'] });
  const byCareTeam = caregiver('pca', [], { id: 'cg-3' });
  const stranger = caregiver('pca', [], { id: 'cg-4', assignedClients: ['someone-else'] });
  const c = client({ careTeam: { primaryCaregiver: 'cg-3', backupCaregiver: null } });

  assert.ok(cg.isAssignedToCaregiver(byId, c), 'assignedClients by id');
  assert.ok(cg.isAssignedToCaregiver(byName, c), 'assignedClients by name (the existing vendor picker)');
  assert.ok(cg.isAssignedToCaregiver(byCareTeam, c), 'careTeam.primaryCaregiver');
  assert.ok(!cg.isAssignedToCaregiver(stranger, c), 'an unassigned caregiver is denied');
  assert.ok(!cg.isAssignedToCaregiver(caregiver('pca', [], { id: 'x' }), c));
});

test('backup caregivers are assigned too', () => {
  const backup = caregiver('cna', [], { id: 'cg-9' });
  assert.ok(cg.isAssignedToCaregiver(backup, client({ careTeam: { backupCaregiver: 'cg-9' } })));
});

test('SAFETY: the caregiver client view never carries rates, billing or clinical narrative', () => {
  const full = client({
    carePlan: { version: 2, goals: ['walk daily'], tasks: ['bath'], frequency: '3x/week', chargeNote: '$38/hr', problems: ['CHF'], rnSignature: 'data:image/png;base64,AAA' },
    rateAgreement: { hourly: 38 }, payer: { type: 'private' }, password: 'hashed',
    intake: { ssn4: '1234' }, consents: { serviceAgreement: 'signed' }, openEmrPatientId: 'uuid-x',
    behavioralProtocols: ['Redirect gently at sundown']
  });
  const view = cg.caregiverClientView(full);
  const flat = JSON.stringify(view);

  for (const forbidden of cg.CAREGIVER_FORBIDDEN_FIELDS) {
    assert.ok(!Object.prototype.hasOwnProperty.call(view, forbidden),
      `the caregiver view must not carry "${forbidden}"`);
    assert.ok(!Object.prototype.hasOwnProperty.call(view.carePlan || {}, forbidden),
      `the caregiver care-plan view must not carry "${forbidden}"`);
  }
  assert.ok(!flat.includes('38'), 'no rate value reaches a caregiver');
  assert.ok(!flat.includes('1234'), 'no intake detail reaches a caregiver');
  assert.ok(!flat.includes('CHF'), 'the clinical problem list is not a caregiver field');
  assert.ok(!flat.includes('base64'), 'the RN signature image never leaves the clinical surface');

  // It IS an allow-list, so what the caregiver legitimately needs survives.
  assert.strictEqual(view.name, 'Margaret Whitfield');
  assert.strictEqual(view.carePlan.frequency, '3x/week');
  assert.deepStrictEqual(view.carePlan.goals, ['walk daily']);
  assert.deepStrictEqual(view.behavioralProtocols, ['Redirect gently at sundown']);
});

test('isCaregiver requires the vendor role AND a license level', () => {
  assert.ok(cg.isCaregiver({ role: 'vendor', licenseLevel: 'pca' }));
  assert.ok(!cg.isCaregiver({ role: 'vendor', licenseLevel: null }), 'a lab-era vendor is not a caregiver');
  assert.ok(!cg.isCaregiver({ role: 'vendor', licenseLevel: 'rn' }), 'an unknown level does not qualify');
  assert.ok(!cg.isCaregiver({ role: 'admin', licenseLevel: 'pca' }));
  assert.ok(!cg.isCaregiver({ role: 'client' }));
  assert.ok(!cg.isCaregiver(null));
});

// ============================================================================
// 8. Idempotency — an offline retry must not file the visit twice
// ============================================================================

test('idempotency keys are scoped per user', () => {
  assert.strictEqual(cg.idempotencyKeyFor('user-a', 'k1'), 'user-a:k1');
  assert.notStrictEqual(cg.idempotencyKeyFor('user-a', 'k1'), cg.idempotencyKeyFor('user-b', 'k1'),
    'two caregivers using the same client-generated key must not collide');
  assert.strictEqual(cg.idempotencyKeyFor('user-a', ''), null, 'a submission with no key is refused');
  assert.strictEqual(cg.idempotencyKeyFor('user-a', '   '), null);
});

// ============================================================================
// 9. Wiring — the routes exist, are guarded, and the mount points are stubbed
// ============================================================================

const routeSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'caregiver.js'), 'utf8');
const pageSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'caregiver.html'), 'utf8');
const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('every /api/caregiver route authenticates and carries a role guard', () => {
  const re = /router\.(get|post|put|delete)\(\s*'(\/api\/caregiver[^']*)'\s*,([^)]*?)(?:async\s*)?\(req/g;
  let m, checked = 0;
  while ((m = re.exec(routeSrc)) !== null) {
    const [, method, routePath, middleware] = m;
    assert.ok(middleware.includes('authenticateToken'),
      `${method.toUpperCase()} ${routePath} must authenticate`);
    const guarded = /requireCaregiver|requireReviewStaff|requireAdmin/.test(middleware);
    // Two routes guard inline because they serve two audiences (a caregiver
    // reads their own rows; staff read the queue). They must still branch.
    const inlineGuarded = ['/api/caregiver/visit-logs', '/api/caregiver/escalations'].includes(routePath) && method === 'get';
    assert.ok(guarded || inlineGuarded,
      `${method.toUpperCase()} ${routePath} must carry a role guard, not rely on the UI`);
    checked++;
  }
  assert.ok(checked >= 10, `expected the caregiver route surface, found ${checked}`);
});

test('there is NO route that edits a submitted visit log — immutability is structural', () => {
  assert.ok(!/router\.(put|patch)\(\s*'\/api\/caregiver\/visit-logs/.test(routeSrc),
    'a submitted visit log must have no update route; corrections are appended review notes');
  assert.ok(routeSrc.includes("/api/caregiver/visit-logs/:id/review-note"),
    'the clinician appends a review note instead');
});

test('the caregiver module writes nothing to OpenEMR — PHCP is app-side', () => {
  // The invariant is the coupling, not the word: no session file may require
  // the EMR client or call through it. (Both files name OpenEMR in prose, to
  // say precisely that they do not touch it.)
  const repoSrc = fs.readFileSync(path.join(__dirname, '..', 'caregiverRepository.js'), 'utf8');
  for (const [label, src] of [['routes/caregiver.js', routeSrc], ['caregiverRepository.js', repoSrc]]) {
    assert.ok(!/require\(\s*['"][./]*openemr['"]\s*\)/i.test(src),
      `${label} must not require the OpenEMR client`);
    assert.ok(!/\bopenemr\s*\.\s*[a-z]/i.test(src),
      `${label} must not call the OpenEMR client — PHCP documentation is app-side`);
  }
});

test('Session 6 rides the existing notification queue and activity log', () => {
  assert.ok(routeSrc.includes('queueNotification'), 'escalations ride pending_notifications');
  assert.ok(routeSrc.includes('logActivity'), 'every caregiver action leaves an audit trail');
  assert.ok(!/db\.set\('pending_notifications'/.test(routeSrc), 'no second notification queue');
});

test('server.js registers the caregiver routes with exactly one require and one mount', () => {
  const requires = serverSrc.match(/require\('\.\/routes\/caregiver'\)/g) || [];
  const mounts = serverSrc.match(/app\.use\(caregiverRoutes\(/g) || [];
  assert.strictEqual(requires.length, 1, 'one require — the parallel-build protocol');
  assert.strictEqual(mounts.length, 1, 'one app.use — the parallel-build protocol');
});

test('the schedule mount is FILLED and the messaging one is still a placeholder', () => {
  // Both ids must still be unique — an id in the DOM twice means one of the
  // two components renders into a node it does not own.
  for (const id of ['gfc-mount-schedule', 'gfc-mount-messaging']) {
    assert.strictEqual(pageSrc.split(`id="${id}"`).length - 1, 1,
      `"${id}" must appear exactly once — ids are unique`);
  }

  // Schedule: wired 2026-09-10. The div is now an empty target the component
  // fills, so it carries no placeholder chrome of its own.
  const sched = pageSrc.slice(pageSrc.indexOf('id="gfc-mount-schedule"'),
    pageSrc.indexOf('id="gfc-mount-schedule"') + 120);
  assert.ok(!sched.includes('aria-disabled'), 'the schedule mount is live, not a disabled panel');
  assert.ok(/GFCCaregiverSchedule/.test(pageSrc), 'and the component is what fills it');

  // Messaging: Session 9 has not been built, so it MUST still read as coming,
  // with no fake interactivity.
  const msgIdx = pageSrc.indexOf('id="gfc-mount-messaging"');
  const msg = pageSrc.slice(msgIdx, msgIdx + 400);
  assert.ok(msg.includes('aria-disabled="true"'), 'the messaging mount must be disabled, not fake-interactive');
  assert.ok(msg.includes('className="mount"'), 'and render as a labeled placeholder panel');

  // The contract Session 9 still needs, and the corrected schedule contract.
  for (const needle of [
    'MOUNT POINT — MESSAGING (Session 9)',
    'GET /api/caregiver/me',
    'authToken'
  ]) {
    assert.ok(pageSrc.includes(needle), `the mount contract must document: ${needle}`);
  }
});

test('the page builds no second offline queue and reuses one idempotency key per submission', () => {
  const queueKeys = pageSrc.match(/localStorage\.(get|set)Item\(\s*QUEUE_KEY/g) || [];
  assert.ok(queueKeys.length >= 2, 'the one queue reads and writes through a single key');
  assert.strictEqual((pageSrc.match(/const QUEUE_KEY/g) || []).length, 1, 'exactly one queue');
  // The key is generated when the caregiver taps submit and travels with the
  // stored payload; regenerating it on retry would defeat the whole mechanism.
  assert.strictEqual((pageSrc.match(/idempotencyKey: newIdempotencyKey\(\)/g) || []).length, 1);
});

test('the visit-log form renders from the server schema, never a local task list', () => {
  assert.ok(pageSrc.includes('schema.taskGroups'), 'the form iterates the server-issued schema');
  for (const skilled of cg.SKILLED_TASK_IDS) {
    assert.ok(!new RegExp(`['"\`]${skilled}['"\`]`).test(pageSrc),
      `the page must not hardcode the skilled task "${skilled}" — the schema decides`);
  }
});

test('the competency catalog is SERVED, not restated in the admin page', () => {
  assert.ok(routeSrc.includes("'/api/caregiver/admin/competencies'"), 'the catalog has a route');
  const hubSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin-hub.html'), 'utf8');
  assert.ok(hubSrc.includes('getCompetencyCatalog'), 'the hub fetches it');
  // A second copy of the vocabulary in a page is the thing that drifts, and a
  // drifting competency list decides what a CNA may document.
  const restated = cg.COMPETENCIES.filter(t => hubSrc.includes(`'${t}'`) || hubSrc.includes(`"${t}"`));
  assert.deepStrictEqual(restated, [], `admin-hub.html must not hardcode competencies: ${restated.join(', ')}`);
});

test('SAFETY: editing a user cannot wipe their competencies', () => {
  // Two independent guarantees, because one alone would be a convention.
  // 1. The user PUT never assigns the field at all.
  const userPut = serverSrc.slice(serverSrc.indexOf("app.put('/api/users/:userId'"));
  const handler = userPut.slice(0, userPut.indexOf('app.delete'));
  assert.ok(!/users\[idx\]\.skilledCompetencies\s*=/.test(handler),
    'the user update route must not write skilledCompetencies');
  // 2. The hub saves them through the caregiver route instead, as its own call.
  const hubSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin-hub.html'), 'utf8');
  assert.ok(/\/api\/caregiver\/admin\/caregivers\/\$\{userId\}\/competencies/.test(hubSrc),
    'the hub uses the caregiver endpoint to save competencies');
  assert.ok(!/formData\.skilledCompetencies|skilledCompetencies:\s*formData/.test(hubSrc),
    'competencies stay out of formData, which is round-tripped to the user PUT');
  // And the list serializer returns them, or the form could not show what is set.
  assert.ok(/skilledCompetencies:\s*Array\.isArray/.test(serverSrc),
    'GET /api/users returns skilledCompetencies so the form can render them');
});

test('caregiver mobile body text is at least 16px', () => {
  const body = pageSrc.match(/body\{[^}]*font-size:(\d+)px/);
  assert.ok(body && Number(body[1]) >= 16, 'caregiver views set a 16px minimum body size');
});
