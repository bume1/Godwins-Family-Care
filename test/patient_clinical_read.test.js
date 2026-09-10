// ============================================================
// Session 4.3 — patient clinical read + POA acting gates + case-manager
// scoped read: build-fail guards (npm test / node --test)
//
//   1. Sharing-rule filter: clinician-only fields can never be serialized
//      into a patient, family, or POA payload (ONE reviewable map).
//   2. Access gate: unlinked, non-clinical line, missing consent-to-treat,
//      and revoked ROI-family each deny; POA = client-equivalent.
//   3. Family sharing defaults: care-plan summary yes, medications no,
//      visit summaries at summary level only.
//   4. Session scoping: the patient-facing routes take NO id parameter, and
//      the resolver ignores anything injected.
//   5. POA identity: "<POA name> as POA for <client name>" on the event and
//      the PDF signature block; the client is never named as the signer.
//   6. Case manager: read yes, write no — and every /api/clinical route in
//      server.js is registered with the matching guard.
//   7. Appointments: tombstones ('x') and no-shows ('?') never reach the
//      patient list. Vitals: parsed from the note, omitted when absent.
//   8. Audit: every patient/POA/case-manager read path calls logActivity.
// ============================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const R = require('../patientReadRepository');

const isConsentSatisfied = (s) => ['signed', 'signed_offline'].includes(s);
const isClinicalServiceLine = (l) => ['IHPC', 'BOTH'].includes(String(l || '').toUpperCase());
const CLIENT = { id: 'c-1', role: 'client', name: 'Test PatientOne', preferredName: 'Pat', serviceLine: 'IHPC', openEmrPatientId: 'puuid-1',
  consents: { roiFamily: 'signed', consentToTreat: 'signed' } };
const CLIENT_USER = { id: 'c-1', role: 'client', name: 'Test PatientOne' };
const FAMILY = { id: 'f-1', role: 'family', name: 'Sam Relative', familyOfClientId: 'c-1', familyIsPoa: false };
const POA = { ...FAMILY, id: 'f-2', name: 'Jordan Agent', familyIsPoa: true };
const CASE_MANAGER = { id: 'cm-1', role: 'caseManager', name: 'Casey Manager' };
const CLINICIAN = { id: 'u-1', role: 'user', name: 'Bethel Godwins', hasClinicalAccess: true };
const ADMIN = { id: 'a-1', role: 'admin', name: 'Admin' };

// ---- 1. Filter map ----
test('no clinician-only field is allowed by any section of the filter map', () => {
  for (const [section, levels] of Object.entries(R.FILTER_MAP)) {
    for (const [level, allow] of Object.entries(levels)) {
      const leak = allow.filter(f => R.CLINICIAN_ONLY_FIELDS.includes(f));
      assert.deepEqual(leak, [], `${section}.${level} allows clinician-only field(s): ${leak.join(', ')}`);
    }
  }
});
test('a hostile row carrying every clinician-only field is stripped for patient, POA and family', () => {
  const hostile = Object.fromEntries(R.CLINICIAN_ONLY_FIELDS.map(f => [f, `LEAK-${f}`]));
  const visit = { ...hostile, id: 'e1', date: '2026-09-04', provider: 'Bethel Godwins, FNP-C', reason: 'Follow-up', summary: 'ok', status: 'complete' };
  for (const level of ['full', 'summary']) {
    const out = R.filterRow('visit', level, visit);
    for (const f of R.CLINICIAN_ONLY_FIELDS) assert.ok(!(f in out), `${f} leaked at level ${level}`);
    assert.equal(out.reason, 'Follow-up');
  }
  assert.ok(!('summary' in R.filterRow('visit', 'summary', visit)), 'summary level drops the visit text');
  for (const section of ['medication', 'allergy', 'problem', 'appointment', 'vital', 'carePlan']) {
    const out = R.filterRow(section, 'full', { ...hostile, id: 'x', name: 'y', version: 1 });
    for (const f of R.CLINICIAN_ONLY_FIELDS) assert.ok(!(f in out), `${section}: ${f} leaked`);
  }
});
test('the visit summary builder never reads or emits narrative note text', () => {
  const v = R.buildVisitSummary({
    encounterUuid: 'enc-1', encounter: { id: 'enc-1', type: 'Encounter', start: '2026-09-04T10:00:00Z', provider: null },
    record: { reason: 'Diabetes follow-up — Bethel Godwins, FNP-C (NPI 1234567893)', date: '2026-09-04', renderingProvider: { name: 'Bethel Godwins', npi: '1234567893' },
      diagnoses: [{ code: 'E11.9', description: 'Type 2 diabetes' }], services: [{ code: '99348' }], narrativeNoteSid: '5', structuredNoteSid: '6', billingProviderNpi: '1999999992' },
    attestation: { signedAt: '2026-09-04T11:00:00Z', signedBy: { name: 'Bethel Godwins', npi: '1234567893' }, attestationText: 'I attest' },
    prescriptions: [{ drug: 'Metformin', dose: '500 mg', route: 'oral', frequency: 'twice daily', prescriber: { npi: '1' } }],
    orders: [{ orderType: 'lab', tests: ['A1c'], status: 'sent' }, { orderType: 'imaging', tests: ['CXR'], status: 'cancelled' }]
  });
  assert.equal(v.provider, 'Bethel Godwins');
  assert.equal(v.reason, 'Diabetes follow-up', 'attribution suffix stripped');
  assert.match(v.summary, /Type 2 diabetes/);
  assert.match(v.summary, /Metformin 500 mg/);
  assert.match(v.summary, /Lab work \(A1c\) — sent to the lab/);
  assert.doesNotMatch(v.summary, /CXR/, 'cancelled orders are not reported');
  assert.equal(v.status, 'complete');
  assert.doesNotMatch(JSON.stringify(v), /1234567893|99348|attest|narrative/i, 'no NPI, service code or note text');
  const filtered = R.filterRow('visit', 'full', v);
  assert.deepEqual(Object.keys(filtered).sort(), [...R.FILTER_MAP.visit.full].sort());
});
test('provider name falls back to the app-side visit stamp, never a blank or an id', () => {
  const v = R.buildVisitSummary({ encounterUuid: 'e', encounter: { id: 'e', start: '2026-08-01', provider: null }, record: null, providerFallbackName: 'Test Nurse' });
  assert.equal(v.provider, 'Test Nurse');
  const w = R.buildVisitSummary({ encounterUuid: 'e', encounter: { id: 'e', start: '2026-08-01', provider: null }, record: null });
  assert.equal(w.provider, 'Your care team');
  assert.match(w.summary, /still finishing/);
});
test('clinician-authored patient text is bounded and never carries a code', () => {
  const f = R.buildPatientFacingFields({ patientSummary: '  We checked   your BP.  ', followUpInstructions: 'x'.repeat(700) });
  assert.equal(f.patientSummary, 'We checked your BP.');
  assert.equal(f.followUpInstructions.length, 600);
  assert.deepEqual(R.buildPatientFacingFields({ patientSummary: '' }), { patientSummary: null, followUpInstructions: null });
});

// ---- 2. Access gate ----
const gate = (reqUser, client) => R.evaluateClinicalReadAccess({ reqUser, client, isConsentSatisfied, isClinicalServiceLine });
test('linked clinical client with consent to treat passes as audience patient', () => {
  const a = gate(CLIENT_USER, CLIENT);
  assert.equal(a.ok, true); assert.equal(a.audience, 'patient');
  assert.equal(a.sections.visits, 'full');
});
test('unlinked, PHC-only, and missing consent-to-treat each deny with a specific code', () => {
  assert.equal(gate(CLIENT_USER, { ...CLIENT, openEmrPatientId: null }).code, 'CLINICAL_NOT_LINKED');
  assert.equal(gate(CLIENT_USER, { ...CLIENT, serviceLine: 'PHC' }).code, 'CLINICAL_NOT_ON_LINE');
  assert.equal(gate(CLIENT_USER, { ...CLIENT, consents: { roiFamily: 'signed', consentToTreat: 'pending' } }).code, 'CLINICAL_CONSENT_REQUIRED');
  assert.equal(gate(CLIENT_USER, { ...CLIENT, consents: { roiFamily: 'signed', consentToTreat: 'signed_offline' } }).ok, true, 'paper-signed consent counts');
  assert.equal(gate(CLINICIAN, CLIENT).code, 'CLIENT_OR_FAMILY_ONLY');
  assert.equal(gate(CLIENT_USER, null).status, 404);
});
test('family is ROI-gated; revoking ROI-family denies on the next request', () => {
  assert.equal(gate(FAMILY, CLIENT).ok, true);
  assert.equal(gate(FAMILY, { ...CLIENT, consents: { roiFamily: 'revoked', consentToTreat: 'signed' } }).code, 'ROI_FAMILY_REQUIRED');
  assert.equal(gate(FAMILY, { ...CLIENT, consents: { consentToTreat: 'signed' } }).code, 'ROI_FAMILY_REQUIRED');
});
test('POA is client-equivalent: full sections, audience poa', () => {
  const a = gate(POA, CLIENT);
  assert.equal(a.audience, 'poa');
  assert.deepEqual(a.sections, R.sectionsFor('patient', {}));
  assert.equal(a.sections.medications, 'full');
});

// ---- 3. Sharing defaults ----
test('non-POA family defaults: care-plan summary yes, medications no, visits summary-level only', () => {
  const s = R.sectionsFor('family', undefined);
  assert.equal(s.carePlan, 'summary');
  assert.equal(s.medications, 'none');
  assert.equal(s.visits, 'summary');
  assert.equal(s.problems, 'none');
  assert.equal(s.vitals, 'none');
  assert.equal(s.appointments, 'full');
});
test('the client can open or close each section; junk input falls back to defaults', () => {
  const s = R.sectionsFor('family', { medications: true, visitSummaries: 'full', carePlan: false, vitals: 'yes' });
  assert.equal(s.medications, 'full'); assert.equal(s.visits, 'full'); assert.equal(s.carePlan, 'none'); assert.equal(s.vitals, 'full');
  assert.equal(R.normalizeSharing({ visitSummaries: 'everything' }).visitSummaries, 'summary');
  assert.deepEqual(R.normalizeSharing(null), { ...R.SHARING_DEFAULTS });
});
test('family summary-level care plan drops the charge note and problems, keeps goals and schedule', () => {
  const plan = { version: 2, goals: ['Walk daily'], problems: ['Falls'], chargePlanNote: '$$', visitSchedule: 'Mon/Wed', coSignedAt: 'x', rnName: 'RN', signedPdf: { available: true } };
  const out = R.filterRow('carePlan', 'summary', plan);
  assert.deepEqual(out.goals, ['Walk daily']);
  assert.ok(!('problems' in out) && !('chargePlanNote' in out) && !('rnName' in out));
  assert.equal(R.filterRow('carePlan', 'full', plan).chargePlanNote, '$$');
});

// ---- 4. Session scoping ----
const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const routeLines = serverSrc.split('\n').filter(l => /^app\.(get|post|put|delete)\('/.test(l));
test('patient-facing clinical routes take NO id parameter — the patient comes from the session', () => {
  const patientRoutes = routeLines.filter(l => l.includes("'/api/gfc/clinical") || l.includes("'/api/gfc/sharing") || l.includes("'/api/gfc/care-plan"));
  assert.ok(patientRoutes.length >= 4, 'patient clinical routes are registered');
  for (const l of patientRoutes) {
    const routePath = l.match(/'([^']+)'/)[1];
    assert.doesNotMatch(routePath, /:/, `${routePath} must not take a request parameter`);
    assert.match(l, /requireEnrolledClient/, `${routePath} must sit behind the enrollment gate`);
  }
});
test('the access resolver ignores any injected client id — only the session user decides', () => {
  const other = { ...CLIENT, id: 'c-OTHER', openEmrPatientId: 'puuid-OTHER' };
  // A tampering request can only ever hand the resolver the SESSION client;
  // the function has no parameter through which another client could arrive.
  assert.equal(R.evaluateClinicalReadAccess.length, 1);
  const a = R.evaluateClinicalReadAccess({ reqUser: { ...CLIENT_USER, clientId: 'c-OTHER', openEmrPatientId: 'puuid-OTHER' }, client: CLIENT, isConsentSatisfied, isClinicalServiceLine });
  assert.equal(a.ok, true);
  assert.equal(R.buildActingIdentity({ ...POA, familyOfClientId: 'c-OTHER' }, CLIENT).actingFor, 'c-1', 'acting-for is the resolved client, not a claimed id');
  assert.notEqual(R.buildActingIdentity(POA, other).actingFor, 'c-1');
});

// ---- 5. POA identity ----
test('a POA signs and acts as "<POA name> as POA for <client name>", never as the client', () => {
  assert.equal(R.poaSignerName('Jordan Agent', 'Test PatientOne'), 'Jordan Agent as POA for Test PatientOne');
  const id = R.buildActingIdentity(POA, CLIENT);
  assert.equal(id.isPoa, true); assert.equal(id.signerRole, 'poa'); assert.equal(id.actingFor, 'c-1');
  assert.equal(id.signerName, 'Jordan Agent as POA for Test PatientOne');
  assert.doesNotMatch(id.signerName, /^Test PatientOne/);
  const c = R.buildActingIdentity(CLIENT_USER, CLIENT);
  assert.equal(c.isPoa, false); assert.equal(c.actingFor, null); assert.equal(c.signerName, 'Pat');
  const f = R.buildActingIdentity(FAMILY, CLIENT);
  assert.equal(f.isPoa, false, 'non-POA family never gains an acting identity');
});
test('the co-sign route stamps the POA signer role onto the event and the PDF signature (source guard)', () => {
  const cosign = serverSrc.slice(serverSrc.indexOf("app.post('/api/gfc/care-plan/cosign'"), serverSrc.indexOf("// PATIENT CLINICAL READ (Session 4.3)"));
  assert.match(cosign, /acting\.isPoa \? acting\.signerName/, 'signer name is the POA identity when a POA signs');
  assert.match(cosign, /signerRole: acting\.signerRole/, 'event carries the signer role');
  assert.match(cosign, /emitSignedCarePlanPdf\(client\.id, currentVersion,\s*\{ \.\.\.signer/, 'the PDF signature block receives the same signer');
  const pdfSrc = fs.readFileSync(path.join(__dirname, '..', 'pdf-generator.js'), 'utf8');
  assert.match(pdfSrc, /sig\.signerRole === 'poa'/, 'PDF renders the POA designation line');
});
test('the messaging acting gate lets a POA send, non-POA family stays read-only (source guard)', () => {
  const msg = serverSrc.slice(serverSrc.indexOf("app.post('/api/gfc/messages'"), serverSrc.indexOf("app.get('/api/gfc/documents'"));
  assert.match(msg, /req\.user\.role !== config\.ROLES\.CLIENT && !acting\.isPoa/);
  assert.match(msg, /fromName: acting\.isPoa \? acting\.signerName/);
});

// ---- 6. Case manager read/write split ----
test('case manager can read but not write; clinician and admin can write; client/family neither', () => {
  assert.equal(R.canClinicalRead(CASE_MANAGER), true);
  assert.equal(R.canClinicalWrite(CASE_MANAGER), false);
  assert.equal(R.canClinicalWrite({ ...CASE_MANAGER, hasClinicalAccess: true }), false, 'the flag cannot widen a case manager to write');
  assert.equal(R.canClinicalWrite(CLINICIAN), true);
  assert.equal(R.canClinicalWrite(ADMIN), true);
  assert.equal(R.canClinicalRead(CLIENT_USER), false);
  assert.equal(R.canClinicalRead(FAMILY), false);
  assert.equal(R.canClinicalRead({ role: 'user', hasClinicalAccess: false }), false);
});
test('every /api/clinical route is registered with the matching guard (GET → read, mutations → write)', () => {
  const clinical = routeLines.filter(l => l.includes("'/api/clinical"));
  assert.ok(clinical.length >= 36, `expected the full clinical route table, found ${clinical.length}`);
  for (const l of clinical) {
    const method = l.match(/^app\.(\w+)/)[1];
    if (method === 'get') {
      assert.match(l, /requireClinicalRead/, `GET route must use requireClinicalRead: ${l.slice(0, 90)}`);
      assert.doesNotMatch(l, /requireClinicalWrite/, l.slice(0, 90));
    } else {
      assert.match(l, /requireClinicalWrite|requireAdmin/, `${method.toUpperCase()} route must use requireClinicalWrite (or requireAdmin): ${l.slice(0, 90)}`);
      assert.doesNotMatch(l, /requireClinicalRead/, l.slice(0, 90));
    }
  }
  assert.ok(!serverSrc.includes('requireClinicalStaff'), 'the pre-4.3 single guard is retired');
});
test('the write guard answers case managers with a specific 403 code and the read guard audits them', () => {
  const mw = serverSrc.slice(serverSrc.indexOf('const requireClinicalRead ='), serverSrc.indexOf('// Require Admin Hub access'));
  assert.match(mw, /CLINICAL_READ_ONLY/);
  assert.match(mw, /case_manager_clinical_read/);
  assert.match(mw, /patientRead\.canClinicalWrite\(req\.user\)/);
});

// ---- 7. Appointments + vitals ----
test('tombstoned (cancelled) and no-show rows never reach the patient list; past rows are excluded', () => {
  const now = new Date('2026-09-05T12:00:00Z');
  const rows = [
    { eid: '1', date: '2026-09-10', startTime: '10:00', status: '-', state: 'scheduled', title: 'Home visit' },
    { eid: '2', date: '2026-09-10', startTime: '10:00', status: 'x', state: 'cancelled', title: 'Home visit (tombstone)' },
    { eid: '3', date: '2026-09-11', startTime: '09:00', status: '?', state: 'no_show', title: 'Missed' },
    { eid: '4', date: '2026-09-01', startTime: '09:00', status: '-', state: 'needs_documentation', title: 'Past' },
    { eid: '5', date: '2026-09-08', startTime: '14:00', status: '-', state: 'scheduled', title: 'Earlier' }
  ];
  assert.deepEqual(R.selectUpcomingAppointments(rows, now).map(r => r.eid), ['5', '1']);
  const out = R.filterRow('appointment', 'full', R.summarizeAppointmentForPatient({ ...rows[0], location: 'home', notes: 'clinician notes', providerId: '5', patientPuuid: 'p' }, 'Bethel Godwins, FNP-C'));
  assert.equal(out.provider, 'Bethel Godwins, FNP-C'); assert.equal(out.location, 'Your home');
  assert.ok(!('notes' in out) && !('providerId' in out) && !('patientPuuid' in out));
});
test('vitals parse from both note shapes and are omitted (null) when nothing is presentable', () => {
  const hp = R.parseVitalsFromNote('VITALS — BP right arm 130/80; BP left arm 138/84; HR 72; Temp 98.1; RR 16; SpO2 97; Wt 160; Ht 66\n\nSYSTEMS EXAM:\nGeneral: well', '2026-08-20');
  assert.equal(hp.bloodPressure, '138/84', 'higher-reading arm shown');
  assert.match(hp.bloodPressureNote, /right arm 130\/80 · left arm 138\/84/);
  assert.equal(hp.heartRate, '72'); assert.equal(hp.date, '2026-08-20');
  const fu = R.parseVitalsFromNote('[GFC CLINICIAN] x\n\nVITALS — BP 128/78; HR —; Temp —; RR —; SpO2 96; Wt —; Ht —; Pain 3/10');
  assert.equal(fu.bloodPressure, '128/78'); assert.equal(fu.heartRate, null); assert.equal(fu.oxygen, '96'); assert.equal(fu.pain, '3');
  assert.equal(R.parseVitalsFromNote('VITALS — BP —/—; HR —; Temp —; RR —; SpO2 —; Wt —; Ht —'), null);
  assert.equal(R.parseVitalsFromNote('Subjective only, no vitals line'), null);
  assert.equal(R.parseVitalsFromNote(''), null);
  const filtered = R.filterRow('vital', 'full', { ...hp, objective: 'LEAK', narrativeNoteSid: '5' });
  assert.ok(!('objective' in filtered) && !('narrativeNoteSid' in filtered));
});

// ---- 8. Audit ----
test('every patient / POA / case-manager read path writes to logActivity with actingFor and resource', () => {
  const summary = serverSrc.slice(serverSrc.indexOf("app.get('/api/gfc/clinical/summary'"), serverSrc.indexOf("app.get('/api/gfc/clinical/care-plan.pdf'"));
  assert.match(summary, /logPatientClinicalRead\(req, ctx, 'clinical_summary'/);
  const helper = serverSrc.slice(serverSrc.indexOf('const logPatientClinicalRead ='), serverSrc.indexOf('const providerNameMap ='));
  for (const k of ['role: req.user.role', 'audience: ctx.audience', 'actingFor: ctx.acting.actingFor', 'patientId: ctx.client.openEmrPatientId', 'resource']) assert.ok(helper.includes(k), `audit helper records ${k}`);
  const pdf = serverSrc.slice(serverSrc.indexOf("app.get('/api/gfc/clinical/care-plan.pdf'"), serverSrc.indexOf("app.put('/api/gfc/sharing'"));
  assert.match(pdf, /'patient_clinical_read'[\s\S]*resource: 'care_plan_pdf'/);
  assert.doesNotMatch(pdf, /getDocumentReferences|uploadPatientDocument/, 'the PDF is never read from OpenEMR Documents');
  // The Drive read moved into buildCarePlanPdfForVersion, shared with the chart
  // filing so the copy a client downloads and the copy in their chart cannot
  // differ. The property is unchanged and now checked on both halves: the route
  // delegates, and the thing it delegates to reads Drive and never OpenEMR.
  assert.match(pdf, /buildCarePlanPdfForVersion\(client, version\)/);
  const builder = serverSrc.slice(
    serverSrc.indexOf('const buildCarePlanPdfForVersion ='),
    serverSrc.indexOf('const fileCarePlanToChart =')
  );
  assert.ok(builder.length > 200, 'the shared care-plan PDF builder must exist');
  assert.match(builder, /googledrive\.downloadFileBuffer/);
  assert.doesNotMatch(builder, /getDocumentReferences|uploadPatientDocument|openemr\./,
    'the builder must never source a patient-facing document from OpenEMR');
});
test('no patient-, family- or POA-facing route reaches an OpenEMR write method', () => {
  const start = serverSrc.indexOf('// PATIENT CLINICAL READ (Session 4.3)');
  const end = serverSrc.indexOf('// CLINICIAN WORKSPACE (Session 4.1)');
  const block = serverSrc.slice(start, end);
  for (const w of ['createEncounter', 'addSoapNote', 'updateSoapNote', 'addVitals', 'addProblem', 'updateProblem', 'addMedication', 'updateMedication', 'addAllergy', 'createAppointmentRow', 'swapAppointment', 'uploadPatientDocument', 'createPatient']) {
    assert.ok(!block.includes(`.${w}(`), `patient-facing block must not call openemr ${w}`);
  }
});
