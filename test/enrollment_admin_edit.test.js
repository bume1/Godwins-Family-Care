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
function loadEditSpec() {
  const start = SERVER.indexOf('const ENROLLMENT_EDITABLE_PATHS = Object.freeze([');
  assert.notStrictEqual(start, -1, 'the editable-path allow-list is gone');
  const end = SERVER.indexOf('// PUT /api/gfc/admin/enrollment/:clientId/details — staff fill in', start);
  assert.ok(end > start, 'the allow-list no longer sits above the route it guards');
  // eslint-disable-next-line no-new-func
  return new Function(
    `${SERVER.slice(start, end)}
     return { PATHS: ENROLLMENT_EDITABLE_PATHS, LISTS: ENROLLMENT_EDITABLE_LISTS, apply: applyEnrollmentEdits };`
  )();
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
  assert.match(ENROL, /fd\.options\.includes\(f\[fd\.path\] \|\| ''\) \? fd\.options : \[\.\.\.fd\.options, f\[fd\.path\]\]/);
});

test('the page names no editable field the server would drop', () => {
  // The section list mirrors the server's allow-list; a form that offers a field
  // the route refuses is a field somebody fills in and loses.
  const spec = loadEditSpec();
  const paths = [...ENROL.matchAll(/\{ path: '([^']+)'/g)].map(m => m[1]);
  assert.ok(paths.length >= 20, `expected the section list, found ${paths.length} paths`);
  for (const path of paths) {
    if (path === 'email') continue;   // the account's own identity, not an intake key
    assert.ok(spec.PATHS.includes(path), `the page offers '${path}', which the server drops`);
  }
  // And every list the page edits is a list the server accepts.
  for (const name of ['medications', 'emergencyContacts', 'insuranceIds']) {
    assert.ok(ENROL.includes(`${name}:`), `the page must edit ${name}`);
    assert.ok(Object.keys(spec.LISTS).includes(name));
  }
});
