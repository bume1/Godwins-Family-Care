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
const CLINICAL_PAGE = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'clinical.html'), 'utf8');
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

// The medical stage used to lead with "you are under no obligation to sign
// these" — true only for a client who added medical care as an optional
// extra, false for anyone who chose the BOTH service line at intake, where
// these items are REQUIRED to complete enrollment. It contradicted the
// REQUIRED badge rendered right below it, so it was removed (2026-09-10).
// This guards it does not silently come back, and that the stage still
// explains what the medical consents actually are for.
test('the medical stage explains the service without the misleading voluntariness claim', () => {
  const i = PORTAL.indexOf("k === 'consentsMedical'");
  assert.ok(i > 0);
  const stage = PORTAL.slice(i, i + 2200);
  assert.match(stage, /different service from personal home care/i);
  assert.doesNotMatch(stage, /under no obligation to sign/i);
});

// ── Staff service-line change ───────────────────────────────────────

test('a service line can be changed, and only an admin can change it', () => {
  // Owner rule, 2026-09-16: the enrollment surface is READ for clinicians and
  // case managers, WRITE for admin. A lane change rewrites which consents a
  // client owes, so it is squarely a write.
  assert.match(SERVER, /app\.put\('\/api\/gfc\/admin\/enrollment\/:clientId\/service-line', authenticateToken, requireAdmin/);
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
  // REPOINTED 2026-09-22, not deleted. Byte-typing moved into the shared
  // `prepareClientDocument` when staff got a door of their own; a scan bounded
  // to this one route stopped seeing it. The rule did not go away, so neither
  // does its guard — and it now covers BOTH doors, which is stricter than it
  // was when only one existed.
  assert.match(route, /prepareClientDocument\(/, 'the client door must use the shared checks');
  assert.match(route, /resolveDocumentKind\(/,
    'a file filed under a kind no checklist reads is a file nobody sees again');
});

test('both doors onto a client file type by BYTES and refuse an unknown kind', () => {
  // One definition of "a valid document upload", shared. Two copies is how the
  // staff door starts accepting what the client door refuses — and this is the
  // check that decides what reaches a patient's file.
  const helper = SERVER.slice(
    SERVER.indexOf('const prepareClientDocument = ('),
    SERVER.indexOf('const buildClientDocumentRow = (')
  );
  assert.ok(helper.length > 200, 'the shared preparer must exist');
  assert.match(helper, /detectFileType\(buffer\)/, 'typed by its bytes, not its declared type');
  assert.match(helper, /MAX_FILE_SIZE/, 'the size ceiling belongs in the shared check too');
  const kindResolver = SERVER.slice(
    SERVER.indexOf('const resolveDocumentKind = ('),
    SERVER.indexOf('const buildClientDocumentRow = (')
  );
  assert.match(kindResolver, /code: 'DOCUMENT_KIND_UNKNOWN'/,
    'an unknown kind must still be refused, wherever the check now lives');

  const staff = SERVER.slice(
    SERVER.indexOf("app.post('/api/gfc/admin/enrollment/:clientId/documents/upload'"),
    SERVER.indexOf("app.post('/api/gfc/admin/enrollment/:clientId/documents/request'")
  );
  assert.ok(staff.length > 200, 'the staff filing route must exist');
  assert.match(staff, /prepareClientDocument\(/, 'the staff door must use the same checks');
  assert.match(staff, /resolveDocumentKind\(/, 'and the same kind resolution');
  assert.match(staff, /code: 'DOCUMENT_STORAGE_UNAVAILABLE'/);
  assert.ok(staff.indexOf('DOCUMENT_STORAGE_UNAVAILABLE') < staff.indexOf("db.set('client_document_uploads'"),
    'a Drive failure must short-circuit before any row is written — a ticked checklist pointing at nothing is worse than no row');
});

test('a staff-filed document is ACCEPTED, so it ticks its own checklist item', () => {
  // It did not arrive needing review: the office IS the reviewer. Landing it
  // as `received` would leave the item reading "with the office", chasing a
  // review nobody will do, for a document the office filed itself. The
  // caregiver document store settled this on 2026-09-14; same rule here.
  const builder = SERVER.slice(
    SERVER.indexOf('const buildClientDocumentRow = ('),
    SERVER.indexOf("app.post('/api/gfc/documents/upload'")
  );
  assert.match(builder, /source === 'staff' \? 'accepted' : 'received'/,
    'office-filed lands accepted; client-sent lands received');
  assert.match(builder, /source: source === 'staff' \? 'staff' : 'client'/,
    '"the client sent this" and "the office filed it" are different facts');
});

test('a staff filing answers the open request rather than leaving it chasing', () => {
  const staff = SERVER.slice(
    SERVER.indexOf("app.post('/api/gfc/admin/enrollment/:clientId/documents/upload'"),
    SERVER.indexOf("app.post('/api/gfc/admin/enrollment/:clientId/documents/request'")
  );
  assert.match(staff, /status: 'fulfilled'/,
    'the office must not keep asking the client for a document it filed itself');
});

test('the staff filing door is admin OR clinician, never the wider staff gate', () => {
  const line = (SERVER.match(/app\.post\('\/api\/gfc\/admin\/enrollment\/:clientId\/documents\/upload'[^\n]*/) || [])[0];
  assert.ok(line, 'the staff filing route is missing');
  assert.ok(line.includes('requireEnrollmentEditor'),
    'the clinician holding the document must be able to file it');
  assert.ok(!line.includes('requireEnrollmentStaff'),
    'a case manager reads this surface; filing into a patient file is a write');
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


test('the clinical scanner names no document kind of its own', () => {
  // The catalog is SERVED. A page that restates it drifts from the validator
  // that refuses a kind it does not know — silently, and the file lands in a
  // bucket no checklist reads. Same rule as the competency catalog and the
  // caregiver document kinds.
  const comp = CLINICAL_PAGE.slice(
    CLINICAL_PAGE.indexOf('const ChartScanIn = ('),
    CLINICAL_PAGE.indexOf('const ChartDocuments = (')
  );
  assert.ok(comp.length > 200, 'the chart scanner must exist');
  assert.match(comp, /api\.documentKinds\(/, 'the kinds must be fetched, not listed');
  assert.match(comp, /r && r\.catalog/, 'it must render the served catalog');
  // No literal kind/label pair may be built in the page.
  assert.ok(!/kind:\s*'[a-z_]+'/.test(comp),
    'the page must not name a document kind of its own');
});

test('scanning from the chart files into the CLIENT document store', () => {
  // A clinical-only store would mean the office chasing a document a clinician
  // already holds, and the client never seeing it. One store, three readers.
  const comp = CLINICAL_PAGE.slice(
    CLINICAL_PAGE.indexOf('const ChartScanIn = ('),
    CLINICAL_PAGE.indexOf('const ChartDocuments = (')
  );
  assert.match(comp, /api\.fileClientDocument\(/, 'it must file through the shared client-document route');
  assert.match(CLINICAL_PAGE, /fileClientDocument: \(clientId, body\) => authedFetch\(`\/api\/gfc\/admin\/enrollment\/\$\{clientId\}\/documents\/upload`/,
    'and that route is the enrollment one — one store for a client\'s documents');
});

// ── Per-visit documents (Session 4.12, owner 2026-09-23) ──
// "I do need the creation of documents specific to one visit like the
// discharge summary and med list."
const apptTypes412 = require('../appointmentTypes');

test('per-visit kinds are in the ONE catalog, scoped so they never reach the client checklist', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const block = (src.match(/const GFC_EXPECTED_DOCUMENTS = \[[\s\S]*?\n\];/) || [''])[0];
  assert.ok(block.length > 100, 'precondition: the catalog was found');
  for (const kind of ['dischargeSummary', 'dischargeMedList', 'imeRecords', 'imeExamRequest']) {
    assert.match(block, new RegExp(`kind: '${kind}',\\s*scope: 'VISIT'`),
      `${kind} must be declared in the one catalog, scoped to a visit`);
  }
  // A second catalog would be a second set of the rules that make an upload
  // safe — byte-typing, the size ceiling, the Drive path, the chart index.
  assert.equal((src.match(/const GFC_EXPECTED_DOCUMENTS = \[/g) || []).length, 1);

  // ⚠️ THE BUG THIS CLOSES, AND IT WAS ALREADY THERE. The service-line filter
  // answered `true` for EVERYTHING on a dual-lane client, so a VISIT-scoped
  // document would have appeared on a BOTH client's own checklist — asking a
  // patient to produce their own discharge summary.
  const filter = src.slice(src.indexOf('const expectedDocumentsForServiceLine'), src.indexOf('// The checklist the client sees'));
  assert.match(filter, /d\.scope !== 'VISIT'/, 'visit documents must be excluded before the BOTH branch');
  const visitExcludedFirst = filter.indexOf("d.scope !== 'VISIT'") < filter.indexOf("line === 'BOTH'");
  assert.ok(visitExcludedFirst, 'the exclusion must come first, or the BOTH branch lets them through');
});

test('a visit document must name its visit, and a standing document must not', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  // LIFTED OUT AND RUN, not grepped. The first version of this asserted the
  // error codes appeared in the source — which still passed with the
  // condition around them replaced by `if (false)`, leaving the strings in a
  // branch nothing reaches. Both mutations survived. Requiring server.js
  // boots a server, so the function is extracted and executed, which is the
  // pattern this repo already uses for getAppBaseUrl and the welcome email.
  const from = src.indexOf('const checkVisitDocumentPairing = (');
  const to = src.indexOf('\n};', from) + 3;
  assert.ok(from > 0 && to > from, 'the pairing rule must still be extractable');
  // eslint-disable-next-line no-new-func
  const checkPairing = new Function(`${src.slice(from, to)}; return checkVisitDocumentPairing;`)();
  const isVisitKind = (k) => ['dischargeSummary', 'dischargeMedList', 'imeRecords', 'imeExamRequest'].includes(k);

  // A discharge summary with no encounter lands in the client's standing file
  // where nobody working that visit will look for it.
  const orphan = checkPairing('dischargeSummary', '', isVisitKind);
  assert.equal(orphan.ok, false);
  assert.equal(orphan.code, 'VISIT_DOCUMENT_NEEDS_ENCOUNTER');
  assert.match(orphan.error, /File it from the visit/);
  assert.equal(checkPairing('imeRecords', null, isVisitKind).code, 'VISIT_DOCUMENT_NEEDS_ENCOUNTER');
  assert.equal(checkPairing('dischargeMedList', '   ', isVisitKind).code, 'VISIT_DOCUMENT_NEEDS_ENCOUNTER',
    'whitespace is not an encounter');

  // And a photo ID filed against an encounter would sit on that visit's
  // outstanding list forever.
  const misfiled = checkPairing('photoId', 'enc-1', isVisitKind);
  assert.equal(misfiled.ok, false);
  assert.equal(misfiled.code, 'DOCUMENT_IS_NOT_PER_VISIT');

  // The two legitimate pairings both pass, or the guard is refusing everything.
  assert.equal(checkPairing('dischargeSummary', 'enc-1', isVisitKind).ok, true);
  assert.equal(checkPairing('photoId', '', isVisitKind).ok, true);
  assert.equal(checkPairing('photoId', null, isVisitKind).ok, true);

  // And the route delegates rather than re-deriving it.
  assert.match(src, /const pairing = checkVisitDocumentPairing\(kind, encounterUuid, isVisitDocumentKind\);/);
  assert.match(src, /if \(!pairing\.ok\) return res\.status\(400\)/);
  // The row carries the link, defaulting to null rather than to a string.
  const row = src.slice(src.indexOf('const buildClientDocumentRow'), src.indexOf('const resolveDocumentKind') > src.indexOf('const buildClientDocumentRow') ? src.indexOf('const resolveDocumentKind') : src.indexOf('const buildClientDocumentRow') + 2000);
  assert.match(src, /encounterUuid: encounterUuid \? String\(encounterUuid\) : null,/,
    'a document that belongs to no visit must say null, not an empty string');
  // The kind list is DERIVED from the catalog, never a second list.
  assert.match(src, /GFC_EXPECTED_DOCUMENTS\.filter\(d => d\.scope === 'VISIT'\)\.map\(d => d\.kind\)/);
});

test('which documents a visit wants is derived from its appointment type', () => {
  // No second list of "what a TCM visit needs" to keep in step with the
  // appointment config.
  const tcm = apptTypes412.visitDocumentsFor('pc_tcm', []);
  assert.deepEqual(tcm.map(d => d.kind).sort(), ['dischargeMedList', 'dischargeSummary', 'priorRecords'].sort());
  assert.deepEqual(apptTypes412.visitDocumentsOutstanding('pc_tcm', []).sort(),
    ['dischargeMedList', 'dischargeSummary', 'priorRecords'].sort());
  // Filing one takes it off the outstanding list and nothing else.
  const partly = apptTypes412.visitDocumentsFor('pc_tcm', ['dischargeSummary']);
  assert.equal(partly.find(d => d.kind === 'dischargeSummary').filed, true);
  assert.equal(partly.find(d => d.kind === 'dischargeMedList').filed, false);
  assert.deepEqual(apptTypes412.visitDocumentsOutstanding('pc_tcm', ['dischargeSummary', 'dischargeMedList', 'priorRecords']), []);

  const ime = apptTypes412.visitDocumentsFor('ime_exam', []);
  assert.deepEqual(ime.map(d => d.kind).sort(), ['imeExamRequest', 'imeRecords']);
  // A visit type that wants none says so with an empty list, not by failing.
  assert.deepEqual(apptTypes412.visitDocumentsFor('pc_follow_up', []), []);
  assert.deepEqual(apptTypes412.visitDocumentsFor('made_up', []), []);
});

test('the visit-documents read is gated, audited, and hides nothing that was filed', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src,
    /app\.get\('\/api\/clinical\/patients\/:clientId\/encounters\/:euuid\/documents',\s*authenticateToken,\s*requireClinicalRead,/,
    'reading a visit’s documents is a clinical read');
  const from = src.indexOf("/encounters/:euuid/documents', authenticateToken");
  const body = src.slice(from, src.indexOf('// ── The rest of the record', from));
  assert.ok(body.length > 400, 'precondition: the route body was sliced');
  // Scoped to THIS encounter and THIS client — a document filed for another
  // visit must not appear on this one.
  assert.match(body, /u\.clientId === client\.id && u\.encounterUuid === encounterUuid/);
  // Everything filed is listed, including a kind the type did not ask for. A
  // document somebody attached must never become invisible because a list did
  // not expect it.
  assert.match(body, /filed: uploads\.map/);
  assert.ok(!/filed: uploads\.filter\([^)]*wanted/.test(body), 'the filed list must not be narrowed to what was expected');
  // Read back through the app so every read is audited; the Drive id stays
  // server-side.
  assert.match(body, /api\/gfc\/documents\/uploads\/\$\{u\.id\}\/file/);
  assert.ok(!/driveFileId/.test(body), 'the Drive id must never be projected');
  assert.match(body, /logActivity\(/, 'the read must be audited');
});
