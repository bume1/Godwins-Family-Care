// Two owner-directed changes, 2026-09-16.
//
// 1. Adding a client with the agreed-rate boxes left EMPTY answered 400
//    "hourlyRate must be a positive number" — on a form whose own card says to
//    skip the rate for a clinical-only patient. The form ships both boxes as
//    empty strings, so "no rate given" arrives as a two-key object, and the
//    route read that as a rate to validate. Every client added without a rate
//    was refused, and a clinical-only client could not be added at all.
//
// 2. The enrollment surface is READ for clinicians and case managers, WRITE for
//    admin only. Previously seven write routes sat behind the wider staff gate.
//
// Plus the new admin editor for the client's own details, which exists because a
// client an admin adds by hand has no intake behind them: the Client and
// Primary contact cards read "—" across the board with no writer but the
// client's own intake wizard.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SERVER = fs.readFileSync(path.resolve(__dirname, '..', 'server.js'), 'utf8');
const HUB = fs.readFileSync(path.resolve(__dirname, '..', 'public', 'admin-hub.html'), 'utf8');
const ENROL = fs.readFileSync(path.resolve(__dirname, '..', 'public', 'admin-enrollment.html'), 'utf8');

// Lift the real function out of server.js and RUN it. Requiring server.js boots
// a server, and reading the source only proves the text is present — the
// question is what it decides.
function loadRateSupplied() {
  const start = SERVER.indexOf('function rateAgreementSupplied(');
  assert.notStrictEqual(start, -1, 'rateAgreementSupplied is gone');
  const end = SERVER.indexOf('\n}', start) + 2;
  // eslint-disable-next-line no-new-func
  return new Function(`${SERVER.slice(start, end)}; return rateAgreementSupplied;`)();
}

// ── 1. A skipped rate means skipped ─────────────────────────────────

test('the Add-User form\'s untouched rate boxes read as "no rate given"', () => {
  const supplied = loadRateSupplied();
  // This is defaultFormData in admin-hub.html, verbatim. It is the exact
  // payload that 400'd in live testing.
  assert.equal(supplied({ hourlyRate: '', dailyMinimumHours: '' }), false);
  assert.equal(supplied({}), false);
  assert.equal(supplied(undefined), false);
  assert.equal(supplied({ hourlyRate: '   ', dailyMinimumHours: '  ' }), false,
    'whitespace is not a rate either');
});

test('a HALF-filled rate is still supplied, so it still gets validated', () => {
  const supplied = loadRateSupplied();
  // One number without the other is a slip, not a decision. It must reach
  // buildRateAgreement and be refused there, naming the missing half.
  assert.equal(supplied({ hourlyRate: '32', dailyMinimumHours: '' }), true);
  assert.equal(supplied({ hourlyRate: '', dailyMinimumHours: '4' }), true);
  assert.equal(supplied({ hourlyRate: 32, dailyMinimumHours: 4 }), true);
  assert.equal(supplied({ hourlyRate: 0, dailyMinimumHours: 0 }), true,
    'an explicit zero is a number somebody typed — refused loudly, not ignored');
});

test('the create-user route asks whether a rate was supplied, not whether keys exist', () => {
  assert.match(SERVER, /if \(rateAgreementSupplied\(rateAgreement\)\) \{/);
  assert.ok(!/rateAgreement && Object\.keys\(rateAgreement\)\.length/.test(SERVER),
    'the key-count test is what refused every client added without a rate');
});

test('the rate route itself keeps refusing a blank — setting a rate is its whole job', () => {
  const route = SERVER.slice(
    SERVER.indexOf("app.put('/api/gfc/admin/enrollment/:clientId/rate'"),
    SERVER.indexOf("// GET /api/gfc/admin/enrollment/:clientId/consent/:type.pdf"));
  assert.ok(route.length > 200, 'found the rate route');
  assert.match(route, /buildRateAgreement\(b, req\.user\)/);
  assert.ok(!route.includes('rateAgreementSupplied'),
    'a blank posted AT the rate route is an error, not a decision to skip');
});

// ── 2. The pages stop swallowing the server's message ───────────────

for (const [name, src] of [['admin-hub.html', HUB], ['service-portal.html', ENROL === HUB ? HUB : fs.readFileSync(path.resolve(__dirname, '..', 'public', 'service-portal.html'), 'utf8')]]) {
  test(`${name} surfaces the server's own error message`, () => {
    // The throw used to sit INSIDE a try whose catch replaced it with the
    // status code, so every failure read "HTTP error 400" and named nothing.
    // "hourlyRate must be a positive number" became "HTTP error 400".
    assert.ok(!/throw new Error\(errorData\.error \|\| `HTTP error/.test(src),
      'the message is thrown inside the try that swallows it');
    assert.match(src, /serverMessage \|\| `HTTP error \$\{response\.status\}`/);
    // The fallback still exists: a non-JSON body must not produce "undefined".
    assert.match(src, /catch \(e\) \{ \/\* no JSON body/);
  });
}

// ── 3. Who may write what on the enrollment surface ─────────────────
//
// REPOINTED 2026-09-18, owner-directed: correcting the SUBMISSION is now open
// to a clinician as well as an admin. The rule these guards protect did not go
// away — gated at the API layer, never only in the UI — it grew a second
// permitted role on exactly one route. The WORKFLOW writes, which are decisions
// about the file rather than corrections to what is in it, stay admin-only.

const WORKFLOW_WRITES = [
  ["app.put('/api/gfc/admin/enrollment/:clientId/service-line'", 'change a service line'],
  ["app.post('/api/gfc/admin/enrollment/:clientId/documents/request'", 'ask a client for documents'],
  ["app.post('/api/gfc/admin/enrollment/:clientId/documents/remind'", 'chase them'],
  ["app.post('/api/gfc/admin/enrollment/:clientId/documents/:uploadId/review'", 'accept or reject a file'],
  ["app.post('/api/gfc/admin/enrollment/:clientId/review'", 'mark reviewed'],
  ["app.post('/api/gfc/admin/enrollment/:clientId/follow-up'", 'request follow-up'],
  ["app.post('/api/gfc/admin/enrollment/:clientId/consent/:type/offline'", 'record a paper signature'],
  ["app.post('/api/gfc/admin/enrollment/:clientId/approve'", 'approve enrollment'],
  ["app.put('/api/gfc/admin/enrollment/:clientId/rate'", 'set the agreed rate']
];

test('every WORKFLOW write on the enrollment surface is still admin only', () => {
  for (const [decl, what] of WORKFLOW_WRITES) {
    const at = SERVER.indexOf(decl);
    assert.notStrictEqual(at, -1, `route missing: ${what}`);
    const line = SERVER.slice(at, SERVER.indexOf('\n', at));
    assert.ok(line.includes('requireAdmin'), `${what} must be admin-gated — got: ${line.trim()}`);
    assert.ok(!line.includes('requireEnrollmentStaff'), `${what} still on the wider staff gate`);
    assert.ok(!line.includes('requireEnrollmentEditor'),
      `${what} is a decision about the file, not a correction to it — admin only`);
  }
});

test('the submission edit is admin OR clinician, and never the wider staff gate', () => {
  const at = SERVER.indexOf("app.put('/api/gfc/admin/enrollment/:clientId/details'");
  assert.notStrictEqual(at, -1, 'the submission route is gone');
  const line = SERVER.slice(at, SERVER.indexOf('\n', at));
  assert.ok(line.includes('requireEnrollmentEditor'), `submission edit gate changed: ${line.trim()}`);
  // requireEnrollmentStaff would hand it to case managers too, which is the
  // 4.3 scoped-READ rule and must not become a write.
  assert.ok(!line.includes('requireEnrollmentStaff'), 'the submission edit must not sit on the staff gate');
});

// The gate's DECISION, lifted out of server.js and run against the real
// clinical-role module — reading the source only proves the text is there.
function loadCanEdit() {
  const start = SERVER.indexOf('const canEditEnrollment = (user) =>');
  assert.notStrictEqual(start, -1, 'canEditEnrollment is gone');
  const end = SERVER.indexOf('const requireEnrollmentEditor', start);
  assert.ok(end > start, 'the gate moved away from its predicate');
  const clinicalRoles = require('../clinicalRoles');
  // eslint-disable-next-line no-new-func
  return new Function('config', 'patientRead',
    `${SERVER.slice(start, end)}; return canEditEnrollment;`
  )({ ROLES: { ADMIN: 'admin' } }, { canClinicalWrite: clinicalRoles.canClinicalWrite });
}

test('an admin and a licensed clinician may edit; a case manager still may not', () => {
  const canEdit = loadCanEdit();
  assert.ok(canEdit({ role: 'admin' }), 'an admin edits');
  assert.ok(canEdit({ role: 'user', hasClinicalAccess: true }), 'a clinician edits');
  assert.ok(canEdit({ role: 'user', clinicalRole: 'rn' }), 'an RN edits');
  assert.ok(canEdit({ role: 'user', clinicalRole: 'lcsw' }), 'an LCSW edits');
  // A case manager resolves to readOnly. Widening them here would turn the 4.3
  // scoped READ into a write, which is a different decision and not this one.
  assert.ok(!canEdit({ role: 'caseManager' }), 'a case manager reads only');
  assert.ok(!canEdit({ role: 'caseManager', hasClinicalAccess: true }), 'still read-only with the legacy flag');
  assert.ok(!canEdit({ role: 'user', clinicalRole: 'readOnly' }), 'readOnly is read-only');
  assert.ok(!canEdit({ role: 'user' }), 'a non-clinical staff user does not edit');
  assert.ok(!canEdit({ role: 'client' }), 'a client does not edit their own file from here');
  assert.ok(!canEdit(null), 'no user, no edit');
});

test('every READ stays open to clinicians and case managers', () => {
  // Narrowing the writes must not take the view away from the people whose job
  // is to read it. A case manager scoped to their own clients keeps this page.
  const reads = SERVER.split('\n').filter(l =>
    l.includes("app.get('/api/gfc/admin/enrollment"));
  assert.ok(reads.length >= 6, `expected the enrollment reads, found ${reads.length}`);
  for (const line of reads) {
    assert.ok(line.includes('requireEnrollmentStaff'),
      `a read was narrowed to admin: ${line.trim()}`);
  }
});

test('the enrollment page offers no control the API will refuse', () => {
  // A button that answers 403 is worse than no button. TWO answers now, because
  // the API gives two, and each is asked once so no control can drift from the
  // route behind it.
  assert.match(ENROL, /const canEdit = isAdminRole\(user\)/);
  // The submission answer comes FROM THE SERVER, on the record it just served —
  // never inferred from a login stored in this browser, which is how a screen
  // starts offering a button a role narrowed this morning can no longer use.
  assert.match(ENROL, /const canEditSubmission = !!\(client && client\.canEdit\)/);
  assert.match(SERVER, /canEdit: canEditEnrollment\(req\.user\)/);
  assert.ok(!/canEditSubmission = isAdminRole|canEditSubmission = user\./.test(ENROL),
    'the page must not decide the submission gate for itself');
  for (const ctl of ['Mark as reviewed', 'Request follow-up', 'Change service line',
                     'Approve enrollment', 'Request documents', 'Record paper signature']) {
    assert.ok(ENROL.includes(ctl), `control missing: ${ctl}`);
  }
  // A viewer is TOLD which of the two states they are in rather than left with
  // a page where nothing happens.
  assert.match(ENROL, /Read-only — an admin or clinician makes changes here/);
  assert.match(ENROL, /You can correct this submission/);
  // Note the arrow function in the onClick — [^>]* would stop at its ">".
  assert.match(ENROL, /\{canEdit && <button [\s\S]{0,120}?>Record paper signature<\/button>\}/);
  assert.match(ENROL, /<DocumentExchange clientId=\{clientId\} canEdit=\{canEdit\} \/>/);
});

test('printing a blank consent stays open to staff — it is a read', () => {
  // The distinction is the point: printing a document for a visit is reading,
  // recording the signature that comes back is writing.
  const at = ENROL.indexOf('Print for signature');
  assert.notStrictEqual(at, -1);
  const line = ENROL.slice(ENROL.lastIndexOf('\n', at), ENROL.indexOf('\n', at));
  assert.ok(!line.includes('canEdit'), 'the blank-copy link must not be admin-gated');
});

// ── 4. The admin details editor ─────────────────────────────────────

function detailsRoute() {
  const start = SERVER.indexOf("app.put('/api/gfc/admin/enrollment/:clientId/details'");
  assert.notStrictEqual(start, -1, 'the details route is gone');
  const end = SERVER.indexOf('// PUT /api/gfc/admin/enrollment/:clientId/rate', start);
  return SERVER.slice(start, end);
}

// The allow-list and the function that applies it, lifted out of server.js and
// RUN. Anchored on the surrounding text at BOTH ends and loud if either anchor
// moves — a slice that silently grabs the wrong region proves nothing. (Brace
// counting is what broke the download extractor: a destructured parameter
// closes the first brace before the body opens.)
// The allow-list and the function that applies it are lifted out of server.js
// and RUN, rather than read — requiring server.js boots a server. The slice is
// anchored at both ends and asserts loudly if either anchor moves, so it can
// never quietly grab the wrong region and prove nothing.
//
// Since 2026-09-20 the list itself lives in public/intake-fields.js, which the
// client's wizard and this editor both read; the slice therefore runs a real
// `require` of that module rather than a copy of it. Asserting against a copy
// would be asserting against the wrong file.
function loadEditSpec() {
  const start = SERVER.indexOf("const intakeFields = require('./public/intake-fields');");
  assert.notStrictEqual(start, -1, 'the editor no longer reads the shared field map');
  const end = SERVER.indexOf('// PUT /api/gfc/admin/enrollment/:clientId/details — staff fill in', start);
  assert.ok(end > start, 'the allow-list no longer sits above the route it guards');
  const rootRequire = (id) => require(id.replace('./', '../'));
  // eslint-disable-next-line no-new-func
  return new Function('require',
    `${SERVER.slice(start, end)}
     return { PATHS: ENROLLMENT_EDITABLE_PATHS, LISTS: ENROLLMENT_EDITABLE_LISTS, apply: applyEnrollmentEdits, fields: intakeFields };`
  )(rootRequire);
}
const loadApplyEdits = () => loadEditSpec().apply;

test('the route writes an allow-list of paths and nothing else', () => {
  const route = detailsRoute();
  const spec = loadEditSpec();
  // The paths the enrollment page shows plus the ones its own checklist calls
  // missing — the values staff are looking at when something needs correcting.
  for (const path of ['dob', 'gender', 'primaryLanguage', 'phone',
                      'address.line1', 'address.city', 'address.state', 'address.zip',
                      'primaryContact.name', 'primaryContact.relationship',
                      'crisisNotify', 'allergies', 'advanceDirective.status',
                      'medicalTeam.pcpName', 'medicalTeam.preferredPharmacy',
                      'medicalTeam.preferredHospital', 'payerType', 'ltc.carrier', 'ltc.policyNum']) {
    assert.ok(spec.PATHS.includes(path), `missing editable path: ${path}`);
  }
  assert.deepStrictEqual(Object.keys(spec.LISTS).sort(),
    ['emergencyContacts', 'insuranceIds', 'medications']);
  // WIDENED 2026-09-20 to the whole submission, on the owner's instruction.
  // The paths above are the ones the enrollment page displays; these are the
  // wizard's other steps, which had no staff writer at all until now.
  for (const path of ['situation.mainReason', 'schedule.startDate', 'schedule.urgency',
                      'homebound', 'conditions', 'adl.bathing', 'fallRisk',
                      'behavioralFlags', 'homeSafetyFlags', 'matching.genderPreference',
                      'matching.personality', 'medicare.id', 'medicaid.waiver',
                      'commercial.carrier', 'auth911', 'clientFirst', 'preferredName']) {
    assert.ok(spec.PATHS.includes(path), `the whole submission must be editable: ${path}`);
  }
  assert.ok(spec.PATHS.length > 100,
    `the editor covers the submission, not a corner of it (found ${spec.PATHS.length})`);
  // Four values have their own writer, and two writers for one value is how the
  // two start disagreeing.
  for (const forbidden of ['rateAgreement', 'serviceLine', 'careTier', 'name']) {
    assert.ok(!spec.PATHS.includes(forbidden), `${forbidden} has its own writer and must not be here`);
  }
  assert.ok(!route.includes('rateAgreement'), 'the rate must not be writable from here');
  assert.ok(!route.includes('enrollmentStatus'),
    'correcting a submission is not the client submitting it');
  assert.ok(!route.includes('consents['), 'it must not touch the consent map');
});

test('a key outside the allow-list never reaches the record', () => {
  const apply = loadApplyEdits();
  const intake = { dob: '1950-04-02' };
  const changed = apply(intake, {
    dob: '1950-04-02',                 // unchanged — not a change
    rateAgreement: { hourlyRate: 999 },  // has its own route
    careTier: 'A1', serviceLine: 'IHPC', ssn: '123-45-6789', enrollmentStatus: 'enrolled'
  });
  assert.deepStrictEqual(changed, []);
  assert.deepStrictEqual(intake, { dob: '1950-04-02' });
});

test('an absent key means "leave this alone", so one section cannot blank another', () => {
  const apply = loadApplyEdits();
  const intake = { dob: '1950-04-02', allergies: 'Penicillin', medicalTeam: { pcpName: 'Dr Adeyemi' } };
  const changed = apply(intake, { 'medicalTeam.preferredPharmacy': 'CVS Main St' });
  assert.deepStrictEqual(changed, ['medicalTeam.preferredPharmacy']);
  assert.strictEqual(intake.allergies, 'Penicillin');
  assert.strictEqual(intake.medicalTeam.pcpName, 'Dr Adeyemi');
  assert.strictEqual(intake.medicalTeam.preferredPharmacy, 'CVS Main St');
});

test('a value is read whether the body nests it or sends a flat dotted key', () => {
  // The page nests; a script reaches for the flat key. Accepting only one shape
  // means the other answers 200 and changes nothing.
  const apply = loadApplyEdits();
  const nested = {};
  assert.deepStrictEqual(apply(nested, { address: { city: 'Vinings' } }), ['address.city']);
  assert.strictEqual(nested.address.city, 'Vinings');
  const flat = {};
  assert.deepStrictEqual(apply(flat, { 'address.city': 'Vinings' }), ['address.city']);
  assert.strictEqual(flat.address.city, 'Vinings');
});

test('a nested write clones its container rather than reaching into the source', () => {
  const apply = loadApplyEdits();
  const source = { medicalTeam: { pcpName: 'Dr Adeyemi' }, address: { city: 'Smyrna' } };
  const intake = { ...source };                       // the shallow copy the route makes
  apply(intake, { 'medicalTeam.pcpName': 'Dr Osei', 'address.city': 'Vinings' });
  // The record the before/after consent comparison reads must not have moved.
  assert.strictEqual(source.medicalTeam.pcpName, 'Dr Adeyemi');
  assert.strictEqual(source.address.city, 'Smyrna');
  assert.strictEqual(intake.medicalTeam.pcpName, 'Dr Osei');
});

test('a repeating block is normalized to its declared keys and empty rows are dropped', () => {
  const apply = loadApplyEdits();
  const intake = {};
  const changed = apply(intake, {
    medications: [
      { name: '  Lisinopril ', dose: '10mg', frequency: 'daily', smuggled: 'nope' },
      { name: '', dose: '' },                    // a row the form left behind
      { name: 'Metformin', route: 'oral' }
    ],
    emergencyContacts: [{ name: 'Ada Nwosu', relationship: 'Daughter', phone: '404-555-0100' }, {}],
    insuranceIds: [{ carrier: 'Aetna', memberId: 'W123', group: 'G9' }, { carrier: '', memberId: '' }]
  });
  assert.deepStrictEqual(changed.sort(), ['emergencyContacts', 'insuranceIds', 'medications']);
  assert.strictEqual(intake.medications.length, 2);
  assert.strictEqual(intake.medications[0].name, 'Lisinopril');       // trimmed
  assert.strictEqual(intake.medications[0].smuggled, undefined);      // key outside the list
  assert.deepStrictEqual(Object.keys(intake.medications[0]),
    ['name', 'dose', 'route', 'frequency', 'prescriber', 'pharmacy']);
  assert.strictEqual(intake.emergencyContacts.length, 1);
  assert.strictEqual(intake.insuranceIds.length, 1);
});

test('resubmitting the same rows is not a change', () => {
  const apply = loadApplyEdits();
  const rows = [{ name: 'Lisinopril', dose: '10mg', route: '', frequency: 'daily', prescriber: '', pharmacy: '' }];
  const intake = { medications: rows.map(r => ({ ...r })) };
  assert.deepStrictEqual(apply(intake, { medications: rows }), []);
});

test('it validates with the same function intake and offline onboarding use', () => {
  const route = detailsRoute();
  assert.match(route, /validateClientCoreFields\(next\)/);
  assert.match(route, /code: 'INTAKE_INVALID'/);
});

test('the login email is checked against every other account before it is taken', () => {
  const route = detailsRoute();
  assert.match(route, /EMAIL_TAKEN/);
  assert.match(route, /users\.some\(\(u, i\) => i !== idx/);
  assert.match(route, /EMAIL_INVALID/);
  assert.match(route, /EMAIL_REQUIRED/);
});

test('it mirrors through the one writer, so this page cannot store its own shape', () => {
  const route = detailsRoute();
  assert.match(route, /mirrorIntakeToClientProfile\(\s*client, next,/);
  // The medications it just saved, so client.medications and intake.medications
  // cannot end up disagreeing about what the client takes.
  assert.match(route, /Array\.isArray\(next\.medications\) \? next\.medications : undefined/);
});

test('correcting a PCP rebuilds the ROI provider list through the one derivation', () => {
  const route = detailsRoute();
  // Otherwise the Transfer-of-Care form keeps offering the provider that was
  // just corrected. Same function the client's own intake save calls.
  assert.match(route, /const priorProviders = resolvePriorProviders\(client, next\)/);
  const intakeSave = SERVER.slice(SERVER.indexOf("app.post('/api/gfc/intake'"),
                                  SERVER.indexOf("app.post('/api/gfc/consents'"));
  assert.match(intakeSave, /resolvePriorProviders\(users\[idx\], intake\)/);
  // One derivation with ONE call site, not two copies that drift.
  assert.match(SERVER, /const deriveProvidersFromMedicalTeam = /);
  assert.strictEqual(SERVER.split('deriveProvidersFromMedicalTeam(').length - 1, 1,
    'the medical-team derivation must be called from exactly one place');
});

test('an edited payer merges rather than leaving the two shapes disagreeing', () => {
  const route = detailsRoute();
  // The wizard's structured fields live on the intake; the assembled summary
  // lives on the client record and is what billing reads. The mirror only
  // assembles that summary when the intake carries no payer object of its own.
  assert.match(route, /changed\.some\(p => p === 'payerType' \|\| p === 'insuranceIds' \|\| p\.startsWith\('ltc\.'\)\)/);
  assert.match(route, /type: codeFrom\('payerType', next\.payerType\)/);
});

test('the before/after copy is DEEP, or the re-signature flag could never fire', () => {
  const route = detailsRoute();
  // A shallow copy shares `address`, `medicalTeam` and every other nested block
  // with the record being edited, so each comparison would read "unchanged".
  assert.match(route, /const priorClient = JSON\.parse\(JSON\.stringify\(client\)\)/);
});

test('correcting a value a SIGNED consent prints flags it for re-signature', () => {
  const route = detailsRoute();
  // A signed consent copy is rendered from this record, so the correction
  // changes what that document says. It is still allowed — a typo in a date of
  // birth has to be fixable — but it is never silent.
  assert.match(route, /reason: 'client_details_changed'/);
  assert.match(route, /consentActionRequired/);
  // Asked of the DOCUMENTS, by resolving each one before and after, rather than
  // kept as a second map of which field feeds which consent.
  assert.match(route, /resolveForConsent\(consentText, d\.type, priorClient\)/);
  assert.match(route, /resolveForConsent\(consentText, d\.type, client\)/);
  assert.match(route, /isConsentSatisfied\(\(client\.consents \|\| \{\}\)\[d\.type\]\)/);
});

test('the audit records WHICH fields changed, never what they changed to', () => {
  const route = detailsRoute();
  assert.match(route, /'client_details_updated'/);
  assert.match(route, /fields: changed/);
  // A date of birth and a phone number belong to the patient. An audit trail is
  // not a second copy of them — the same rule the client-location route follows.
  assert.ok(!/fields: next/.test(route) && !/values:/.test(route),
    'no field VALUES may reach the activity log');
  assert.ok(!route.includes('dob: next.dob'), 'no value echoed into the log');
});

test('the editor is on the page, gated by the served answer, and re-reads after saving', () => {
  assert.match(ENROL, /const SubmissionEditor = /);
  assert.match(ENROL, /<SubmissionEditor client=\{client\} canEdit=\{canEditSubmission\} onSaved=\{load\} \/>/);
  assert.match(ENROL, /\{canEditSubmission && \(/);
  // Age, the profile mirror, the ROI provider list and the re-signature flag
  // are all resolved server-side, so local state would show staff something the
  // record does not say. Same rule the consent prefill editor follows.
  assert.match(ENROL, /setOpen\(false\); setSaved\(r\.message \|\| 'Saved'\); onSaved\(\);/);
});

test('the form never silently rewrites a value it cannot represent', () => {
  // Two ways a form quietly loses an answer, both closed:
  //   a value the form cannot show is LEFT OUT of the body, because an absent
  //   key means "leave this alone" while a blank one clears what is there;
  assert.match(ENROL, /if \(typeof v === 'object'\) return;/);
  //   and a stored option the select does not list is ADDED to the list, or the
  //   select shows blank and saves that blank over the client's own answer.
  //   (Repointed 2026-09-20: the options come from the shared field map now, so
  //   the check reads the map's catalog rather than an inline array.)
  assert.match(ENROL, /held && !opts\.includes\(held\) \? opts\.concat\(\[held\]\) : opts/);
  //   The same rule for a checkbox group, which is the shape the widened editor
  //   added: an option the client picked before the list changed is still their
  //   answer, so it is shown and kept rather than dropped on the next save.
  assert.match(ENROL, /\(f\[fd\.path\] \|\| \[\]\)\.filter\(v => !FIELD_MAP\.optionsFor\(fd\)\.includes\(v\)\)/);
});

// REPOINTED 2026-09-20, and the rule got STRICTER rather than looser. It used
// to compare the page's own inline field list against the server's allow-list,
// because a form offering a field the route refuses is a field somebody fills
// in and loses. The page no longer has a list: it renders from the same
// declaration the server validates against, so the two cannot differ at all.
// What needs guarding now is that it stays that way.
test('the page declares no question of its own — it renders the shared map', () => {
  const spec = loadEditSpec();
  assert.ok(ENROL.includes('window.GFC_INTAKE_FIELDS'),
    'the editor must read the shared field map');
  assert.ok(ENROL.includes('FIELD_MAP.SECTIONS.map('),
    'the sections are served, not restated');
  assert.ok(ENROL.includes('const SUBMISSION_LISTS = FIELD_MAP.LISTS;'),
    'the repeating blocks come from the map too');

  // One field of its own, and exactly one: the login email, which is an account
  // detail rather than an answer on the submission. Any OTHER hardcoded path is
  // the drift this test exists to stop.
  const declared = [...ENROL.matchAll(/\{ path: '([^']+)'/g)].map(m => m[1]);
  assert.deepStrictEqual(declared, ['email'],
    `the page must name no intake field of its own, found ${JSON.stringify(declared)}`);

  // And no option list may be restated in the page either — that was the second
  // copy that drifted.
  assert.ok(!/options: \[\s*'/.test(ENROL),
    'an option list in the page is a second catalog that will drift from the wizard');

  for (const name of ['medications', 'emergencyContacts', 'insuranceIds']) {
    assert.ok(Object.keys(spec.LISTS).includes(name), `${name} must still be editable`);
  }
});

test('a checkbox group saves as an array, and an empty one is a real answer', () => {
  const apply = loadApplyEdits();
  const intake = { conditions: ['Diabetes'] };
  // "None of these" and "never asked" must stay different stored values: the
  // matching engine reads them, and an empty string would be neither.
  assert.deepStrictEqual(apply(intake, { conditions: [] }), ['conditions']);
  assert.deepStrictEqual(intake.conditions, []);

  const second = { conditions: [] };
  assert.deepStrictEqual(apply(second, { conditions: ['Diabetes', 'Cancer'] }), ['conditions']);
  assert.deepStrictEqual(second.conditions, ['Diabetes', 'Cancer']);

  // Absent still means leave alone, for an array as for anything else.
  const third = { conditions: ['Diabetes'] };
  assert.deepStrictEqual(apply(third, { allergies: 'None' }), ['allergies']);
  assert.deepStrictEqual(third.conditions, ['Diabetes']);
});

test('an option the client was never offered is refused BY NAME, not dropped', () => {
  const apply = loadApplyEdits();
  const intake = {};
  const rejected = [];
  apply(intake, { conditions: ['Diabetes', 'Lycanthropy'] }, rejected);
  assert.deepStrictEqual(intake.conditions, ['Diabetes'],
    'the client picked from a fixed list; staff do not get to invent a diagnosis');
  // Silence is the worst of the three answers: somebody types a correction, the
  // screen says saved, and the old value is still there.
  assert.deepStrictEqual(rejected.map(r => r.value), ['Lycanthropy']);

  const sel = { fallRisk: 'Low' };
  const rejected2 = [];
  assert.deepStrictEqual(apply(sel, { fallRisk: 'Catastrophic' }, rejected2), [],
    'a closed select is held to its own catalog too');
  assert.strictEqual(sel.fallRisk, 'Low', 'and the stored answer is left alone');
  assert.deepStrictEqual(rejected2.map(r => r.path), ['fallRisk']);
  assert.ok(rejected2[0].options.includes('Low'), 'the refusal carries what IS on offer');
});

test('an OPEN select takes a typed answer — those four were free-text boxes', () => {
  const apply = loadApplyEdits();
  const fields = require('../public/intake-fields');
  // Staff transcribing from a phone call write "Daughter" where the wizard
  // offers "Adult child". Every one of these was a plain input on the staff
  // editor before the fields were declared centrally, so making them closed
  // vocabularies would have narrowed the office silently.
  assert.deepStrictEqual(fields.VALUE_FIELDS.filter(f => f.open).map(f => f.path).sort(),
    ['address.state', 'gender', 'ltc.carrier', 'primaryContact.relationship']);
  const intake = {};
  const rejected = [];
  const changed = apply(intake, {
    primaryContact: { relationship: 'Daughter' },
    ltc: { carrier: 'A carrier nobody listed' }
  }, rejected);
  assert.deepStrictEqual(rejected, [], 'an open select refuses nothing');
  assert.strictEqual(intake.primaryContact.relationship, 'Daughter');
  assert.strictEqual(intake.ltc.carrier, 'A carrier nobody listed');
  assert.ok(changed.includes('primaryContact.relationship'));
});

test('a stored option the catalog no longer lists survives, and can be cleared', () => {
  const apply = loadApplyEdits();
  // Somebody's real answer from before a list changed. Saving the rest of the
  // form must not wipe it, and staff must be able to remove it deliberately.
  const intake = { fallRisk: 'Extremely high (retired wording)', allergies: 'None' };
  assert.deepStrictEqual(apply(intake, { allergies: 'Penicillin' }), ['allergies']);
  assert.strictEqual(intake.fallRisk, 'Extremely high (retired wording)',
    'a stale option is not collateral damage of editing another field');
  assert.deepStrictEqual(apply(intake, { fallRisk: '' }), ['fallRisk']);
  assert.strictEqual(intake.fallRisk, '', 'clearing a wrong answer is always allowed');
});

test('duplicates in a checkbox group are collapsed', () => {
  const apply = loadApplyEdits();
  const intake = {};
  apply(intake, { equipment: ['Walker', 'Walker', 'Cane'] });
  assert.deepStrictEqual(intake.equipment, ['Walker', 'Cane']);
});

test('the whole submission round-trips: every declared field is writable', () => {
  const apply = loadApplyEdits();
  const fields = require('../public/intake-fields');
  const intake = {};
  const body = {};
  fields.VALUE_FIELDS.forEach(f => {
    if (f.type === 'multi') { body[f.path] = fields.optionsFor(f).slice(0, 1); return; }
    if (f.type === 'select') { body[f.path] = fields.optionsFor(f)[0]; return; }
    body[f.path] = `v-${f.path}`;
  });
  const changed = apply(intake, body);
  // Every field the map declares must actually land. A path that silently does
  // nothing is a question somebody answers and loses.
  const missed = fields.EDITABLE_PATHS.filter(p => !changed.includes(p));
  assert.deepStrictEqual(missed, [], `these declared paths did not save: ${missed.join(', ')}`);

  // And each one reads back at its own path, nested correctly.
  const read = (o, p) => p.split('.').reduce((x, k) => (x === null || x === undefined ? undefined : x[k]), o);
  fields.VALUE_FIELDS.forEach(f => {
    assert.notStrictEqual(read(intake, f.path), undefined, `${f.path} did not reach the record`);
  });
});

test('the four values with another writer are still outside the map', () => {
  const fields = require('../public/intake-fields');
  for (const forbidden of ['name', 'clientName', 'serviceLine', 'careTier', 'rateAgreement',
                           'consents', 'consentMeta', 'uploads', 'age', 'priorProviders',
                           'enrollmentStatus', 'submittedAt', 'updatedAt']) {
    assert.ok(!fields.EDITABLE_PATHS.includes(forbidden),
      `${forbidden} has its own writer, or is derived, and must not be staff-editable here`);
    assert.ok(!Object.keys(fields.LISTS).includes(forbidden));
  }
  // Named, so the refusal can say WHY rather than "unknown field".
  assert.ok(fields.HAS_ANOTHER_WRITER.rateAgreement.includes('own route'));
  assert.ok(fields.HAS_ANOTHER_WRITER.careTier.includes('triage'));
});

test('every declared path is unique — a duplicate would shadow one of the two', () => {
  const fields = require('../public/intake-fields');
  const seen = new Set();
  const dupes = [];
  fields.ALL_FIELDS.forEach(f => { if (seen.has(f.path)) dupes.push(f.path); seen.add(f.path); });
  assert.deepStrictEqual(dupes, []);
});

test('the wizard and the staff editor read ONE option catalog', () => {
  const portal = fs.readFileSync(path.join(__dirname, '..', 'public', 'portal.html'), 'utf8');
  assert.ok(portal.includes('const IO = window.GFC_INTAKE_FIELDS.OPTIONS;'),
    'the intake wizard must read the shared catalog, not its own copy');
  assert.ok(portal.includes('<script src="/intake-fields.js">'),
    'the wizard page must load the shared map');
  assert.ok(ENROL.includes('<script src="/intake-fields.js">'),
    'the enrollment page must load the shared map');

  // The module is the one that must not drift from the server's allow-list.
  const fields = require('../public/intake-fields');
  const spec = loadEditSpec();
  assert.deepStrictEqual(spec.PATHS.slice(), fields.EDITABLE_PATHS.slice(),
    'the server validates against the same declaration the pages render');
  // Every select and checkbox group resolves to a real catalog. A field naming a
  // catalog that does not exist renders an empty dropdown and refuses every
  // value posted into it — silently.
  fields.VALUE_FIELDS.forEach(f => {
    if (!f.options) return;
    assert.ok(fields.OPTIONS[f.options] && fields.OPTIONS[f.options].length,
      `${f.path} names the option list '${f.options}', which is empty or missing`);
  });
});
