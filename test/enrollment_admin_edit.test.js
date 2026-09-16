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

// ── 3. Enrollment writes are admin only ─────────────────────────────

const ENROLLMENT_WRITES = [
  ["app.put('/api/gfc/admin/enrollment/:clientId/service-line'", 'change a service line'],
  ["app.post('/api/gfc/admin/enrollment/:clientId/documents/request'", 'ask a client for documents'],
  ["app.post('/api/gfc/admin/enrollment/:clientId/documents/remind'", 'chase them'],
  ["app.post('/api/gfc/admin/enrollment/:clientId/documents/:uploadId/review'", 'accept or reject a file'],
  ["app.post('/api/gfc/admin/enrollment/:clientId/review'", 'mark reviewed'],
  ["app.post('/api/gfc/admin/enrollment/:clientId/follow-up'", 'request follow-up'],
  ["app.post('/api/gfc/admin/enrollment/:clientId/consent/:type/offline'", 'record a paper signature'],
  ["app.post('/api/gfc/admin/enrollment/:clientId/approve'", 'approve enrollment'],
  ["app.put('/api/gfc/admin/enrollment/:clientId/rate'", 'set the agreed rate'],
  ["app.put('/api/gfc/admin/enrollment/:clientId/details'", "edit the client's details"]
];

test('every WRITE on the enrollment surface is admin only', () => {
  for (const [decl, what] of ENROLLMENT_WRITES) {
    const at = SERVER.indexOf(decl);
    assert.notStrictEqual(at, -1, `route missing: ${what}`);
    const line = SERVER.slice(at, SERVER.indexOf('\n', at));
    assert.ok(line.includes('requireAdmin'), `${what} must be admin-gated — got: ${line.trim()}`);
    assert.ok(!line.includes('requireEnrollmentStaff'), `${what} still on the wider staff gate`);
  }
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
  // A button that answers 403 is worse than no button.
  assert.match(ENROL, /const canEdit = isAdminRole\(user\)/);
  for (const ctl of ['Mark as reviewed', 'Request follow-up', 'Change service line',
                     'Approve enrollment', 'Request documents', 'Record paper signature']) {
    assert.ok(ENROL.includes(ctl), `control missing: ${ctl}`);
  }
  // Each write control sits behind canEdit; the read-only viewer is TOLD so
  // rather than left with a page where nothing happens.
  assert.match(ENROL, /Read-only — an admin makes changes here/);
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

test('the details route writes an allow-list and nothing else', () => {
  const route = detailsRoute();
  assert.match(SERVER, /const ENROLLMENT_DETAIL_FIELDS = \['dob', 'gender', 'primaryLanguage', 'phone'\]/);
  assert.match(SERVER, /const ENROLLMENT_CONTACT_FIELDS = \['name', 'relationship', 'phone', 'email'\]/);
  // The rate has its own route and its own re-signature rule. Two writers for
  // one agreed price is how the two start disagreeing.
  assert.ok(!route.includes('rateAgreement'), 'the rate must not be writable from here');
  assert.ok(!route.includes('enrollmentStatus'),
    'filling in details is not the client submitting intake');
  assert.ok(!route.includes('consents['), 'it must not touch the consent map');
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
  assert.match(detailsRoute(), /mirrorIntakeToClientProfile\(client, next, undefined, undefined\)/);
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

test('the editor is on the page, admin-gated, and re-reads after saving', () => {
  assert.match(ENROL, /const ClientDetailsEditor = /);
  assert.match(ENROL, /<ClientDetailsEditor client=\{client\} canEdit=\{canEdit\} onSaved=\{load\} \/>/);
  assert.match(ENROL, /\{canEdit && <button className="btn btn-ghost mt-3" onClick=\{\(\) => setOpen\(true\)\}>Edit details<\/button>\}/);
  // Age, the profile mirror and the re-signature flag are all resolved
  // server-side, so local state would show a client something the record does
  // not say. Same rule the consent prefill editor follows.
  assert.match(ENROL, /\.then\(\(\) => \{ setOpen\(false\); onSaved\(\); \}\)/);
});
