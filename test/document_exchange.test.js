// ============================================================
// Staged consent signing · staff service-line change · two-way document exchange
//
// The consent REGISTRY and its text are Session 4.6's (consentRegistry.js,
// public/consent-text.js) and are covered by test/consent_registry.test.js.
// What is guarded here is what sits on top of it: which VISIT a record is
// signed at, the staff-facing door onto a lane change, the Client Information
// Face Sheet, and documents travelling from the client back to us.
//
// The failures worth guarding are the silent ones — a document recorded as
// received that was never stored, a rejection the client is never told about,
// a checklist that has gone stale against the service line it is derived from.
// ============================================================
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const registry = require('../consentRegistry');
const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const PORTAL = fs.readFileSync(path.join(__dirname, '..', 'public', 'portal.html'), 'utf8');
const ADMIN = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin-enrollment.html'), 'utf8');

// ── Staging: which visit a record is signed at ──────────────────────

test('stage is a second axis, and every medical-lane record sits on it', () => {
  // Scope says which LANE. Stage says which VISIT. The paper packet is headed
  // "Packet 2 of 2 — do not sign this on the same visit as home care", and a
  // BOTH client was being shown every applicable record in one sitting.
  for (const d of registry.GFC_CONSENT_DEFS) {
    assert.ok(registry.CONSENT_STAGES.includes(d.stage), `${d.type} has no valid stage`);
    assert.equal(d.stage, d.scope === 'ihpc' ? 'medical' : 'homecare', `${d.type} is staged wrong`);
  }
});

test('a single-line client has exactly one stage', () => {
  // The staging must be invisible to a client who is only on one line —
  // otherwise it is a second screen for nothing.
  assert.equal(registry.consentDefsForStage('PHC', 'medical').length, 0);
  assert.equal(registry.consentDefsForStage('IHPC', 'homecare').filter(d => d.scope === 'phc').length, 0);
  // And a BOTH client genuinely has two.
  assert.ok(registry.consentDefsForStage('BOTH', 'homecare').length > 0);
  assert.equal(registry.consentDefsForStage('BOTH', 'medical').length, 4);
});

test('an inactive record can never hold a stage open', () => {
  // `monitoring` is registered and not live. If stage completion counted it,
  // a client could never leave the first stage.
  const consents = {};
  registry.consentDefsForStage('PHC', 'homecare')
    .filter(d => d.required && !d.inactive)
    .forEach(d => { consents[d.type] = 'signed'; });
  assert.equal(registry.stageComplete('PHC', 'homecare', consents), true);
});

test('a paper signature completes a stage exactly as an in-app one does', () => {
  const consents = {};
  registry.consentDefsForStage('PHC', 'homecare')
    .filter(d => d.required && !d.inactive)
    .forEach(d => { consents[d.type] = 'signed_offline'; });
  assert.equal(registry.stageComplete('PHC', 'homecare', consents), true);
  assert.match(PORTAL, /consents\[t\] === 'signed' \|\| consents\[t\] === 'signed_offline'/);
});

test('the wizard cannot leave the first stage with it unsigned', () => {
  // Without this the two packets can be signed together, which is the only
  // thing the staging exists to prevent.
  assert.match(PORTAL, /steps\[step\]\.key === 'consents' && hasMedicalStage && !homecareComplete/);
  assert.match(PORTAL, /\{homecareDefs\.map\(def => \(/,
    'the first stage must render one packet, not every applicable record');
  assert.match(PORTAL, /k === 'consentsMedical' &&/);
});

test('the medical stage leads with the voluntariness language', () => {
  const i = PORTAL.indexOf("k === 'consentsMedical'");
  assert.ok(i > 0);
  const stage = PORTAL.slice(i, i + 2200);
  assert.match(stage, /under no obligation to sign/i);
  assert.match(stage, /home care does not\s*\n?\s*change/i);
});

// ── Staff service-line change ───────────────────────────────────────

test('staff can change a service line, and only enrollment staff can', () => {
  assert.match(SERVER, /app\.put\('\/api\/gfc\/admin\/enrollment\/:clientId\/service-line', authenticateToken, requireEnrollmentStaff/);
  assert.match(SERVER, /code: 'BAD_SERVICE_LINE'/);
  assert.match(ADMIN, /api\.setServiceLine/);
});

test('the route does not restate the transition rules', () => {
  // Two copies of "what a lane change does to the consent set" is the drift
  // this codebase has already paid for twice. The route is a door onto
  // applyServiceLineChange, which is what the intake save already calls.
  const route = SERVER.slice(
    SERVER.indexOf("app.put('/api/gfc/admin/enrollment/:clientId/service-line'"),
    SERVER.indexOf("app.post('/api/gfc/admin/enrollment/:clientId/review'")
  );
  assert.ok(route.length > 200, 'the service-line route must exist');
  assert.match(route, /applyServiceLineChange\(client, line, req\.user\)/);
  assert.ok(!/delete consents\[/.test(route), 'the route must not touch the consent map itself');
  assert.match(route, /'service_line_changed'/);
});

test('a lane change never unsigns a signed consent', () => {
  // A signature is a fact. Ceasing to apply does not undo it.
  const client = { serviceLine: 'BOTH', consents: { consentToTreat: 'signed', npp: 'signed' } };
  const out = registry.applyServiceLineChange(client, 'PHC', { id: 'u1', name: 'Staff' });
  assert.ok(out.noLongerRequired.includes('consentToTreat'));
  assert.equal(client.consents.consentToTreat, 'signed', 'the record must survive the change');
  assert.equal(client.serviceLineHistory.length, 1);
});

test('widening queues the newly owed records', () => {
  const client = { serviceLine: 'PHC', consents: { npp: 'signed' } };
  const out = registry.applyServiceLineChange(client, 'BOTH', { id: 'u1', name: 'Staff' });
  assert.ok(out.newlyRequired.includes('ihpcServiceAgreement'));
  assert.equal(client.consents.ihpcServiceAgreement, 'pending',
    'written explicitly, or it reads as "nothing to do" on any screen listing rows');
  assert.equal(client.consents.npp, 'signed', 'an already-signed shared record is not re-queued');
});

test('the enrollment view groups consents by the visit they are signed at', () => {
  assert.match(ADMIN, /stage: 'homecare', label: 'Home-care packet/);
  assert.match(ADMIN, /stage: 'medical',  label: 'Medical packet/);
  assert.match(SERVER, /stage: d\.stage \|\| 'homecare'/);
});

// ── The Client Information Face Sheet ───────────────────────────────

test('the face sheet exists and is assembled from the record', () => {
  // Five consents point at it — "recorded once on your Client Information Face
  // Sheet" — and it existed nowhere in the app.
  assert.match(SERVER, /app\.get\('\/api\/gfc\/face-sheet\.pdf'/);
  const gen = fs.readFileSync(path.join(__dirname, '..', 'pdf-generator.js'), 'utf8');
  assert.match(gen, /async function generateFaceSheetPDF/);
  // Footers are stamped on buffered pages after layout. Writing them below the
  // bottom margin during the flow makes pdfkit add a page for the overflow,
  // which produced footer-only pages in the middle of the document.
  assert.match(gen, /function faceSheetFooters\(doc\) \{[\s\S]*?bufferedPageRange\(\)/);
});

// ── Two-way document exchange ───────────────────────────────────────

test('a document we cannot store is a document we did not receive', () => {
  // The tempting shortcut is the intake-upload pattern: log the Drive error and
  // record the row anyway. That produces a checklist saying "received" pointing
  // at nothing — the silent-success trap OpenEMR has sprung five times, and
  // worse here because the client believes they have sent it.
  const route = SERVER.slice(
    SERVER.indexOf("app.post('/api/gfc/documents/upload'"),
    SERVER.indexOf("app.get('/api/gfc/documents/uploads/:id/file'")
  );
  assert.ok(route.length > 200, 'the upload route must exist');
  assert.match(route, /code: 'DOCUMENT_STORAGE_UNAVAILABLE'/);
  assert.ok(route.indexOf('DOCUMENT_STORAGE_UNAVAILABLE') < route.indexOf("db.set('client_document_uploads'"),
    'the failure must short-circuit before anything is recorded');
  assert.match(route, /detectFileType\(buffer\)/, 'typed by its bytes, not its declared type');
  assert.match(route, /code: 'DOCUMENT_KIND_UNKNOWN'/,
    'a file filed under a kind no checklist reads is a file nobody sees again');
});

test('the checklist is derived, never stored', () => {
  // A stored copy goes stale the moment the service line changes. Both the
  // client view and the staff view call the same builder.
  assert.match(SERVER, /const buildDocumentChecklist = \(client, uploads, requests\)/);
  assert.equal((SERVER.match(/buildDocumentChecklist\(client, uploads, requests\)/g) || []).length, 2,
    'the client and staff views must read the same derivation');
  assert.ok(!/client_document_checklist/.test(SERVER), 'nothing may persist a checklist');
});

test('a rejected document is re-requested, with a reason the client can act on', () => {
  const route = SERVER.slice(
    SERVER.indexOf("app.post('/api/gfc/admin/enrollment/:clientId/documents/:uploadId/review'"),
    SERVER.indexOf("app.get('/api/gfc/admin/enrollment/:clientId/documents/:uploadId/file'")
  );
  assert.match(route, /code: 'REASON_REQUIRED'/);
  assert.match(route, /status: 'open', note: reason/,
    'rejecting must reopen the ask, or the client is never told to send another');
  // And the client is shown the reason: told only "we still need your insurance
  // card", they send the same blurry photo again.
  assert.match(PORTAL, /we could not use this: \$\{f\.rejectionReason\}/);
});

test('every reminder is stamped on the record', () => {
  const route = SERVER.slice(
    SERVER.indexOf("app.post('/api/gfc/admin/enrollment/:clientId/documents/remind'"),
    SERVER.indexOf("app.post('/api/gfc/admin/enrollment/:clientId/documents/:uploadId/review'")
  );
  assert.match(route, /reminders: \[\.\.\.\(r\.reminders \|\| \[\]\), stamp\]/,
    '"we asked three times" has to be a fact on the record, not a recollection');
  assert.match(route, /'client_documents_reminded'/);
});

test('a stored file is served through the app, never a Drive link', () => {
  // The Drive copy is not link-shared. Routing every read through the app is
  // what makes it authenticated and audited.
  assert.match(SERVER, /const serveStoredDocument = async \(res, row, actor\)/);
  assert.match(SERVER, /'client_document_read'/);
  assert.match(ADMIN, /const openStoredDoc = async \(path\)/);
});

test('the client portal can send documents back', () => {
  assert.match(PORTAL, /uploadGfcClientDocument/);
  assert.match(PORTAL, /const GfcNeededDoc = /);
});

// ── The plan of care and the chart ──────────────────────────────────
// Owner rule, 2026-09-09: the plan lives in the app; it reaches the patient's
// OpenEMR document record only when the client is a clinical patient, whether
// they enrolled that way or were toggled onto it later.

test('the plan reaches the chart only for a clinical patient', () => {
  // Stated as a rule, not inferred from an EMR id happening to be present.
  assert.match(SERVER, /const carePlanBelongsInChart = \(client\) =>\s*\n?\s*isClinicalServiceLine\(client && client\.serviceLine\) && !!\(client && client\.openEmrPatientId\)/);
  // And it is the gate at BOTH existing filing points — author and co-sign.
  assert.equal((SERVER.match(/carePlanBelongsInChart\(/g) || []).length, 2,
    'both existing filing sites — author and co-sign — must ask the same question');
  // A home care client is a named outcome, never a silent skip.
  assert.match(SERVER, /reason: 'HOME_CARE_ONLY'/);
});

test('becoming a patient backfills the plan into the chart', () => {
  // The gap this closes: filing happened at author time and at co-sign, both of
  // which are over by the time a home care client adds medical care. Nothing
  // re-filed, so the chart had no plan of care and nothing said so.
  const line = SERVER.slice(
    SERVER.indexOf("app.put('/api/gfc/admin/enrollment/:clientId/service-line'"),
    SERVER.indexOf("app.post('/api/gfc/admin/enrollment/:clientId/review'")
  );
  assert.match(line, /fileCarePlanToChart\(client\.id, req\.user, 'service_line_changed'\)/);
  const link = SERVER.slice(
    SERVER.indexOf("app.post('/api/clinical/patients/:clientId/link'"),
    SERVER.indexOf("app.post('/api/clinical/patients/:clientId/link'") + 6000
  );
  assert.match(link, /fileCarePlanToChart\(client\.id, req\.user, 'patient_linked'\)/);
});

test('filing is idempotent and every outcome is named', () => {
  const fn = SERVER.slice(
    SERVER.indexOf('const fileCarePlanToChart ='),
    SERVER.indexOf("// Visits for a client from the visit_logs")
  );
  assert.ok(fn.length > 400, 'the filing helper must exist');
  // A re-toggle or a re-link must not stack duplicate PDFs in the chart.
  assert.match(fn, /reason: 'ALREADY_FILED'/);
  assert.match(fn, /existing\.chartFiled && existing\.chartFiled\.emrDocumented/);
  // "Home care only" and "the upload failed" are different facts.
  for (const r of ['HOME_CARE_ONLY', 'NOT_LINKED', 'NO_CARE_PLAN', 'UPLOAD_FAILED']) {
    assert.ok(fn.includes(`reason: '${r}'`), `${r} must be a named outcome`);
  }
  assert.match(fn, /'care_plan_filed_to_chart'/);
});

test('an un-cosigned plan is filed as authored, never as signed', () => {
  // The chart must not carry a signature block the client has not signed.
  const builder = SERVER.slice(
    SERVER.indexOf('const buildCarePlanPdfForVersion ='),
    SERVER.indexOf('const fileCarePlanToChart =')
  );
  assert.match(builder, /state: ev \? 'signed' : 'authored'/);
});
