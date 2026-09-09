// ============================================================
// Consent registry + body text invariants (build-fail guards)
//
// The consent set is the enrollment gate and the signed legal record, so the
// failures worth guarding here are the SILENT ones: a consent that renders blank
// and is still signable, a home care agency taking a medical consent it cannot
// take, and paper-packet instructions ported into an app where they are false.
//
// Source of truth: docs/GFC_Consent_Source_Text_v2_1.md
// ============================================================
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const PORTAL = fs.readFileSync(path.join(__dirname, '..', 'public', 'portal.html'), 'utf8');

const REGISTRY = SERVER.match(/const GFC_CONSENT_DEFS = \[([\s\S]*?)\n\];/)[1];
const ENTRIES = [...REGISTRY.matchAll(
  /type: '(\w+)',\s*scope: '(\w+)',\s*stage: '(\w+)',\s*required: (true|false)(?:,\s*title: '([^']*)')?(,\s*inactive: true)?/g
)].map(m => ({ type: m[1], scope: m[2], stage: m[3], required: m[4] === 'true', inactive: !!m[6] }));

const BODY_BLOCK = PORTAL.match(/const CONSENT_BODY = \{([\s\S]*?)\n    \};/)[1];
const BODY_KEYS = [...BODY_BLOCK.matchAll(/^      (\w+): \(<React\.Fragment>/gm)].map(m => m[1]);
const bodyOf = (key) => {
  const i = BODY_BLOCK.indexOf(`      ${key}: (<React.Fragment>`);
  if (i < 0) return '';
  const next = BODY_KEYS.map(k => BODY_BLOCK.indexOf(`      ${k}: (<React.Fragment>`)).filter(x => x > i).sort((a, b) => a - b)[0];
  return BODY_BLOCK.slice(i, next === undefined ? BODY_BLOCK.length : next);
};

test('every consent in the registry has a body, and every body is in the registry', () => {
  assert.equal(ENTRIES.length, 14, 'the approved source text defines fourteen records');
  const types = ENTRIES.map(e => e.type);
  for (const t of types) {
    assert.ok(BODY_KEYS.includes(t), `${t} is offered for signature with no text to read`);
  }
  for (const k of BODY_KEYS) {
    assert.ok(types.includes(k), `${k} has body text but no registry entry — it can never be shown`);
  }
});

test('the signature block is gated on the body existing', () => {
  // Without this a missing body renders an empty box with a live signature block
  // under it: the client signs nothing and the enrollment gate counts it done.
  assert.match(PORTAL, /const hasBody = !!CONSENT_BODY\[def\.type\];/);
  assert.match(PORTAL, /\{!signed && hasBody && \(/,
    'the signature block must require hasBody, not just !signed');
});

test('scope math matches the approved source: 9 home care, 10 medical, 13 both', () => {
  const active = ENTRIES.filter(e => !e.inactive);
  const sees = (line) => active.filter(e => e.scope === 'both' || e.scope === line).length;
  assert.equal(sees('phc'), 9);
  assert.equal(sees('ihpc'), 10);
  assert.equal(active.length, 13);

  // serviceAgreement is home care only; an IHPC patient signs ihpcServiceAgreement.
  assert.equal(ENTRIES.find(e => e.type === 'serviceAgreement').scope, 'phc');
  assert.equal(ENTRIES.find(e => e.type === 'ihpcServiceAgreement').scope, 'ihpc');
});

test('the medical packet is a separate stage from home care', () => {
  // The paper instruction "do not sign this on the same visit as home care" is
  // not ported as a sentence; it is this split. Every IHPC-only record is staged
  // `medical`, everything else `homecare`.
  for (const e of ENTRIES) {
    assert.equal(e.stage, e.scope === 'ihpc' ? 'medical' : 'homecare', `${e.type} is staged wrong`);
  }
  assert.ok(ENTRIES.some(e => e.stage === 'medical'), 'a medical stage must exist');
});

test('the home care agency does not take a consent to medical treatment', () => {
  // The pre-2026-09 text read "In a medical emergency, I authorize emergency
  // treatment and transport as needed" on a PRIVATE HOME CARE consent. A home
  // care provider licensed under PHCP013073 cannot take that consent. This is
  // the highest-priority correction in the approved source text.
  const body = bodyOf('emergencyFinancial');
  assert.ok(body, 'emergencyFinancial must have a body');
  assert.match(body, /not a consent to medical treatment/i,
    'emergencyFinancial must disclaim that it authorizes treatment');
  assert.match(body, /caregivers are[\s\S]{0,40}not[\s\S]{0,20}clinicians/i);
  assert.doesNotMatch(body, /I authorize emergency treatment/i,
    'a home care agency must never take a consent to treat');
});

test('paper-packet mechanics are not ported into the app', () => {
  // These are instructions for handling a stack of paper. In an app that knows
  // what is signed they are false, and "sign this in one sitting" is the exact
  // opposite of the staged flow.
  const PAPER_ONLY = [
    /packet \d of \d/i,
    /signed in one sitting/i,
    /take this packet away/i,
    /do not sign again/i,
    /nothing here requires a computer/i
  ];
  for (const key of BODY_KEYS) {
    const body = bodyOf(key);
    for (const re of PAPER_ONLY) {
      assert.doesNotMatch(body, re, `${key} carries a paper-packet instruction (${re})`);
    }
  }
});

test('the anti-tying language survives, in both agreements', () => {
  // This reads like packet chrome and is not: it is what separates a licensed
  // home care agency from a medical practice, and it must stay in the record.
  assert.match(bodyOf('ihpcServiceAgreement'), /under no obligation to sign/i);
  assert.match(bodyOf('ihpcServiceAgreement'), /home care does not change/i);
  assert.match(bodyOf('serviceAgreement'), /never a condition of receiving medical care/i);
});

test('cross-references are by name, never by document number', () => {
  // The packet renumbered from ten documents to nine, and both the source text
  // and the packet PDF still carry stale numbers. A client in the app sees
  // titled consents, so a number can only ever be wrong.
  for (const key of BODY_KEYS) {
    assert.doesNotMatch(bodyOf(key), /\bDocument \d/,
      `${key} refers to a document by number; use its name`);
  }
});

test('an inactive consent cannot be signed', () => {
  const monitoring = ENTRIES.find(e => e.type === 'monitoring');
  assert.ok(monitoring.inactive);
  assert.equal(monitoring.required, false);
  assert.match(PORTAL, /Not available to sign while this service is inactive/);
  assert.doesNotMatch(PORTAL, /onClick=\{\(\) => handleSign\(true\)\}/,
    'the inactive opt-in/out buttons wrote a consent record for a service that does not run');
});

test('the counsel-review disclaimer is gone now that the real text is in', () => {
  assert.doesNotMatch(PORTAL, /Working draft — pending counsel/);
});

test('the medical packet is its own wizard step, gated behind the first', () => {
  // A BOTH client used to get all thirteen records on one screen. The paper
  // packet forbids exactly that ("Packet 1 of 2 — sign this one first").
  assert.match(PORTAL, /const medicalDefs = activeConsentDefs\.filter\(d => d\.stage === 'medical'\);/);
  assert.match(PORTAL, /const homecareDefs = activeConsentDefs\.filter\(d => d\.stage !== 'medical'\);/);

  // The extra step only exists when there is a medical packet to sign.
  assert.match(PORTAL, /\.\.\.\(hasMedicalStage \? \[\{ key: 'consentsMedical'/);

  // And it cannot be reached until the first stage's required records are signed.
  assert.match(PORTAL, /steps\[step\]\.key === 'consents' && hasMedicalStage && !homecareComplete/);

  // Stage one renders from homecareDefs, never the full set.
  assert.match(PORTAL, /\{homecareDefs\.map\(def => \(/);
  assert.doesNotMatch(PORTAL, /\{activeConsentDefs\.map\(def => \(/,
    'the consents step must render one stage, not every applicable record');
});

test('the medical stage leads with the voluntariness language', () => {
  // The one piece of the packet framing that is substantive rather than chrome.
  const i = PORTAL.indexOf("k === 'consentsMedical'");
  assert.ok(i > 0, 'the medical stage must exist');
  const stage = PORTAL.slice(i, i + 2200);
  assert.match(stage, /under no obligation to sign/i);
  assert.match(stage, /home care does not\s*\n?\s*change/i);
});

test('a home-care-only client never sees a second consent stage', () => {
  // hasMedicalStage is driven by the records themselves, so a PHC client — who
  // has no ihpc-scoped records — gets one step and notices no change.
  const phcTypes = ENTRIES.filter(e => e.scope === 'both' || e.scope === 'phc');
  assert.equal(phcTypes.filter(e => e.stage === 'medical').length, 0);
  const ihpcTypes = ENTRIES.filter(e => e.scope === 'both' || e.scope === 'ihpc');
  assert.equal(ihpcTypes.filter(e => e.stage === 'medical').length, 4,
    'the medical packet is four documents');
});

test('consent labels shown to the client come from the registry, not a copy', () => {
  // The duplicate map had already drifted: the old emergencyFinancial title and
  // no entry at all for ihpcServiceAgreement, which would have listed itself to
  // the client as a raw key.
  assert.match(SERVER, /const consentLabels = GFC_CONSENT_DEFS\.reduce/);
  assert.doesNotMatch(SERVER, /emergencyFinancial: 'Emergency Treatment & Financial Responsibility'/);
});

test('every consent in the registry has PDF-renderable text', () => {
  // consentText.js is the single source both the portal and the PDF generator
  // read. A registry entry missing from it is a document that can be signed on
  // screen and then cannot be produced afterwards.
  const { CONSENT_TEXT } = require('../consentText');
  for (const e of ENTRIES) {
    assert.ok(Array.isArray(CONSENT_TEXT[e.type]) && CONSENT_TEXT[e.type].length,
      `${e.type} has no renderable text — a signed copy could never be produced`);
  }
  for (const k of Object.keys(CONSENT_TEXT)) {
    assert.ok(ENTRIES.some(e => e.type === k), `${k} has text but is in no registry entry`);
  }
});

test('a signed consent is its own document, not a row in a packet', () => {
  // 07/2026 requirement: every signable document renders a PDF with its own
  // captured signature. The only artifact before this was one enrollment packet
  // listing each consent as a line.
  assert.match(SERVER, /app\.get\('\/api\/gfc\/consents\/:type\.pdf'/);
  assert.match(SERVER, /url: `\/api\/gfc\/consents\/\$\{k\}\.pdf`/,
    'each signed consent must carry its own download url');
  // An unsigned consent has no signature to carry.
  assert.match(SERVER, /code: 'CONSENT_NOT_SIGNED'/);
});

test('the face sheet exists and is generated from the record', () => {
  // Five consents point at it, and it existed nowhere in the app.
  assert.match(SERVER, /app\.get\('\/api\/gfc\/face-sheet\.pdf'/);
  const gen = require('fs').readFileSync(require('path').join(__dirname, '..', 'pdf-generator.js'), 'utf8');
  assert.match(gen, /async function generateFaceSheetPDF/);
  assert.match(gen, /async function generateConsentPDF/);
  // It must refuse to render a document whose text is missing, the same rule
  // the portal applies before showing a signature block.
  assert.match(gen, /refusing to generate a document with no body/);
});

test('the PDF text comes from the same source the portal renders', () => {
  // Two copies of legal text is a copy that drifts. That is not hypothetical
  // here: the consent TITLE map had already drifted before this was centralised.
  const gen = require('fs').readFileSync(require('path').join(__dirname, '..', 'pdf-generator.js'), 'utf8');
  assert.match(gen, /require\('\.\/consentText'\)/);
});

// ── Staff service-line change ───────────────────────────────────────
// The medical packet is signed at a later visit than the home-care packet, so
// somebody on staff has to be able to move a client from PHC to BOTH after
// enrollment. Before this the only place the line could change was the client's
// own intake wizard.

test('staff can change a client service line, and only enrollment staff can', () => {
  assert.match(SERVER, /app\.put\('\/api\/gfc\/admin\/enrollment\/:clientId\/service-line', authenticateToken, requireEnrollmentStaff/);
  assert.match(SERVER, /code: 'BAD_SERVICE_LINE'/);
});

test('narrowing the service line never unsigns a signed consent', () => {
  // A signed consent is a signed record. Dropping it because it no longer
  // applies would destroy evidence of a real signature.
  const route = SERVER.slice(
    SERVER.indexOf("app.put('/api/gfc/admin/enrollment/:clientId/service-line'"),
    SERVER.indexOf("app.post('/api/gfc/admin/enrollment/:clientId/review'")
  );
  assert.ok(route.length > 200, 'the service-line route must exist');
  // The only delete in the route is guarded on the consent being unsigned.
  const deletes = [...route.matchAll(/delete consents\[(\w+)\];/g)];
  assert.equal(deletes.length, 1, 'exactly one delete, and it must be guarded');
  const line = route.split('\n').find(l => l.includes('delete consents['));
  assert.match(line, /=== 'pending'/, 'only a never-signed obligation may be dropped');
  // And the change is recorded, both on the client and in the activity trail.
  assert.match(route, /serviceLineHistory/);
  assert.match(route, /'service_line_changed'/);
});

test('widening the service line queues the newly owed documents', () => {
  const route = SERVER.slice(
    SERVER.indexOf("app.put('/api/gfc/admin/enrollment/:clientId/service-line'"),
    SERVER.indexOf("app.post('/api/gfc/admin/enrollment/:clientId/review'")
  );
  assert.match(route, /consents\[def\.type\] = 'pending';/);
  assert.match(route, /!def\.inactive/, 'a retired record must never be queued for signature');
});

test('a retained consent stays visible to staff', () => {
  // Keeping the record but hiding it leaves a real signature traceable only
  // through a KV key nobody opens.
  assert.match(SERVER, /const retainedDefs = GFC_CONSENT_DEFS\.filter/);
  assert.match(SERVER, /retained: true/);
  const view = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin-enrollment.html'), 'utf8');
  assert.match(view, /Signed previously — no longer required on this service line/);
});

test('the enrollment view groups consents by the visit they are signed at', () => {
  const view = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin-enrollment.html'), 'utf8');
  assert.match(view, /stage: 'homecare', label: 'Home-care packet/);
  assert.match(view, /stage: 'medical',  label: 'Medical packet/);
  assert.match(view, /api\.setServiceLine/);
  // The detail payload has to carry the stage for the grouping to mean anything —
  // on the applicable records AND on the retained ones, or half the list ends up
  // silently grouped under home care.
  assert.equal((SERVER.match(/stage: d\.stage \|\| 'homecare'/g) || []).length, 2);
});

// ── Two-way document exchange ───────────────────────────────────────
// The app could produce documents and could not receive them. These guard the
// three properties that would fail quietly if someone "simplified" the code.

test('a document we cannot store is a document we did not receive', () => {
  // The tempting shortcut is the intake-upload pattern: log the Drive error and
  // record the row anyway. That produces a checklist saying "received" pointing
  // at nothing — the same silent-success trap OpenEMR has sprung five times.
  const route = SERVER.slice(
    SERVER.indexOf("app.post('/api/gfc/documents/upload'"),
    SERVER.indexOf("app.get('/api/gfc/documents/uploads/:id/file'")
  );
  assert.ok(route.length > 200, 'the upload route must exist');
  assert.match(route, /code: 'DOCUMENT_STORAGE_UNAVAILABLE'/);
  // The row is only written after the store succeeded.
  assert.ok(route.indexOf('DOCUMENT_STORAGE_UNAVAILABLE') < route.indexOf("db.set('client_document_uploads'"),
    'the failure must short-circuit before anything is recorded');
});

test('an upload is type-checked by its bytes, not its declared type', () => {
  const route = SERVER.slice(
    SERVER.indexOf("app.post('/api/gfc/documents/upload'"),
    SERVER.indexOf("app.get('/api/gfc/documents/uploads/:id/file'")
  );
  assert.match(route, /detectFileType\(buffer\)/);
  assert.match(route, /code: 'DOCUMENT_KIND_UNKNOWN'/,
    'a file filed under a kind no checklist reads is a file nobody sees again');
});

test('the checklist is derived, never stored', () => {
  // A stored copy goes stale the moment the service line changes. Both the
  // client view and the staff view call the same builder.
  assert.match(SERVER, /const buildDocumentChecklist = \(client, uploads, requests\)/);
  const uses = (SERVER.match(/buildDocumentChecklist\(client, uploads, requests\)/g) || []).length;
  assert.equal(uses, 2, 'the client and staff views must read the same derivation');
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

test('the stored file is served through the app, never a Drive link', () => {
  // The Drive copy is not link-shared. Routing every read through the app is
  // what makes it authenticated and audited.
  assert.match(SERVER, /const serveStoredDocument = async \(res, row, actor\)/);
  assert.match(SERVER, /'client_document_read'/);
  const view = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin-enrollment.html'), 'utf8');
  assert.match(view, /const openStoredDoc = async \(path\)/);
});

test('the portal offers each signed consent as its own file', () => {
  // Every row on this screen used to open the same enrollment packet, so a
  // client who signed nine documents could retrieve none of them individually.
  assert.match(PORTAL, /onClick=\{canOpen \? \(\) => openDoc\(s\.url\) : undefined\}/);
  assert.ok(!/const openConsentPdf/.test(PORTAL), 'the packet-for-everything handler must be gone');
});

test('the client portal can send documents back', () => {
  assert.match(PORTAL, /uploadGfcClientDocument/);
  assert.match(PORTAL, /const GfcNeededDoc = /);
  // A rejected file keeps its reason on screen: told only "we still need your
  // insurance card", a client sends the same blurry photo again.
  assert.match(PORTAL, /we could not use this: \$\{f\.rejectionReason\}/);
});

test('no working-draft caveat survives on the consent text', () => {
  assert.ok(!/WORKING DRAFT/.test(SERVER));
  assert.ok(!/WORKING DRAFT/.test(PORTAL));
});
