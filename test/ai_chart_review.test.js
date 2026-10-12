// test/ai_chart_review.test.js — the chart review's wiring (2026-10-12, G1 E).
//
// The packet's own rules are in test/chart_packet.test.js and the gating is
// driven over real HTTP by scripts/verify_ai_chart_review.js. What is pinned
// here is what neither of those can reach: that the review schema is one the
// engine accepts BEFORE a chart is sent, that patients never reach an AI
// route, and that retention and the audit say what they claim.
//
// MUTATION-CHECKED. Comments are stripped before every source scan — a scan
// that cannot tell live code from prose about that code proves nothing.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const M = require('../modelEngine.js');
const P = require('../chartPacket.js');

const root = path.join(__dirname, '..');
const stripComments = (src) => src
  .replace(/^[ \t]*\/\/.*$/gm, '')
  .replace(/\/\*[\s\S]*?\*\//g, '');
const readSrc = (f) => {
  const raw = fs.readFileSync(path.join(root, f), 'utf8');
  const out = stripComments(raw);
  assert.ok(1 - out.length / raw.length < 0.45, `stripComments swallowed code in ${f}`);
  return out;
};
const server = readSrc('server.js');

// Reads a PDF's text layer through the repo's own extractor — the same path
// documentTemplates uses.
const readPdfText = async (file) => {
  const { PDFDocument } = require('pdf-lib');
  const packet = require('../welcomePacketImport.js');
  const pdf = await PDFDocument.load(fs.readFileSync(file), { ignoreEncryption: true, updateMetadata: false });
  const runs = await packet.extractRuns(pdf);
  return packet.groupIntoLines(runs).map(l => l.text || '').join('\n');
};

// Lift the schema literal out of server.js and RUN it. Requiring server.js
// boots a server, which is the established reason this repo extracts by
// source — but a schema that is only READ is a schema nobody proved the
// engine accepts.
const liftSchema = () => {
  const start = server.indexOf('const AI_REVIEW_SCHEMA = Object.freeze({');
  assert.ok(start > 0, 'AI_REVIEW_SCHEMA must still be findable');
  const end = server.indexOf('\n});', start);
  assert.ok(end > start, 'the schema literal must still be closed the same way');
  const code = server.slice(start, end + 4).replace('const AI_REVIEW_SCHEMA =', 'return');
  // eslint-disable-next-line no-new-func
  return new Function(code)();
};

// ── the schema is one the engine accepts BEFORE anything is sent ──────────

test('the review schema passes the engine\'s own shape check — or a whole chart is sent and then refused', () => {
  const schema = liftSchema();
  assert.strictEqual(M.validateSchemaShape(schema), null,
    'B5 moved the schema check ahead of the transport; a schema that fails it would refuse every review');
});

test('the review schema actually validates a well-formed review', () => {
  const schema = liftSchema();
  const r = M.validateAgainstSchema({
    summary: 'One patient, reviewed.',
    timeline: [{ date: '2026-02-01', event: 'Home visit', citations: [{ sourceId: 'enc:e1', quote: 'fatigue' }] }],
    findings: [{
      category: 'medication_issue', statement: 'Metformin with no recent A1c.',
      priority: 'attention', citations: [{ sourceId: 'emr:medications', page: 2, quote: 'metformin 500mg' }]
    }],
    questionsForClinician: ['Is the metformin still indicated?'],
    notReviewed: ['doc:12: the stored file could not be retrieved']
  }, schema);
  assert.ok(!r.error, r.error);
  assert.strictEqual(r.value.findings[0].category, 'medication_issue');
  assert.strictEqual(r.value.findings[0].citations[0].page, 2);
  assert.strictEqual(r.value.questionsForClinician.length, 1);
});

test('the schema refuses an invented category or priority rather than coercing it', () => {
  const schema = liftSchema();
  for (const bad of [
    { category: 'diagnosis', statement: 's', priority: 'attention', citations: [{ sourceId: 'a' }] },
    { category: 'care_gap', statement: 's', priority: 'critical', citations: [{ sourceId: 'a' }] }
  ]) {
    const r = M.validateAgainstSchema({ summary: 's', findings: [bad] }, schema);
    assert.match(r.error || '', /not one of the permitted values/,
      'a coerced field is a wrong field that reads as plausibly as a right one');
  }
});

test('a finding longer than 600 characters is refused, not truncated', () => {
  const schema = liftSchema();
  const r = M.validateAgainstSchema({
    summary: 's',
    findings: [{ category: 'other', statement: 'x'.repeat(601), priority: 'info', citations: [{ sourceId: 'a' }] }]
  }, schema);
  assert.match(r.error || '', /longer than the 600/);
});

test('every finding must carry at least one citation in the schema itself', () => {
  const schema = liftSchema();
  assert.strictEqual(schema.fields.findings.items.citations.minItems, 1,
    'the server drops an uncited finding anyway; declaring it tells the model before it answers rather than after');
  assert.strictEqual(schema.fields.timeline.items.citations.minItems, 1);
  assert.strictEqual(schema.fields.findings.items.citations.items.sourceId.required, true);
});

// ── patients never reach an AI route ─────────────────────────────────────

test('every AI route is on a clinical gate — a patient reaches none of them', () => {
  const routes = [...server.matchAll(/app\.(get|post|put|delete)\('([^']*\/ai\/[^']*)'([^)]*)\)/g)];
  assert.ok(routes.length >= 4, `expected the AI routes to be findable, found ${routes.length}`);
  for (const [, , route, rest] of routes) {
    assert.match(rest, /authenticateToken/, `${route} must authenticate`);
    assert.match(rest, /requireClinicalRead|requireClinicalWrite|requireAdmin/,
      `${route} must be on a clinical or admin gate — owner decision 7, and a patient must never reach the AI`);
    assert.doesNotMatch(rest, /requireEnrolledClient|requireClientForIntake/,
      `${route} must never be on a client gate`);
  }
});

test('starting a review needs clinical WRITE; reading one needs only read', () => {
  const start = server.match(/app\.post\('\/api\/clinical\/patients\/:clientId\/ai\/review'([^)]*)\)/);
  assert.ok(start, 'the start route must be findable');
  assert.match(start[1], /requireClinicalWrite/, 'owner decision 7: read-only staff cannot run one');

  const list = server.match(/app\.get\('\/api\/clinical\/patients\/:clientId\/ai\/reviews'([^)]*)\)/);
  assert.match(list[1], /requireClinicalRead/, 'a case manager may see what was asked and what came back');

  const decide = server.match(/app\.post\('\/api\/clinical\/ai\/reviews\/:id\/decisions'([^)]*)\)/);
  assert.match(decide[1], /requireClinicalWrite/, 'a decision is an act, not a read');
});

test('nothing is gathered before the boundary is checked', () => {
  const i = server.indexOf("app.post('/api/clinical/patients/:clientId/ai/review'");
  const body = server.slice(i, server.indexOf('\n});', i));
  const guard = body.indexOf('MODEL_BOUNDARY_REFUSED');
  const gather = body.indexOf('runAiReview');
  assert.ok(guard > 0 && gather > guard,
    'a chart must not be assembled in memory for a call that was never going to be allowed');
});

// ── the review is not the medical record ─────────────────────────────────

test('a review says on every read that it is not part of the record', () => {
  const i = server.indexOf('const aiReviewGetHandler');
  const body = server.slice(i, server.indexOf('\n};', i));
  assert.match(body, /notPartOfRecord: true/,
    'owner decision 8 — the screen must never imply otherwise');
});

test('retention is a setting with a documented default, and the purge logs a COUNT only', () => {
  assert.match(server, /GFC_AI_REVIEW_RETENTION_DAYS \|\| 180/, 'owner decision 8: 180 days');
  const i = server.indexOf('const purgeAiReviews');
  const body = server.slice(i, server.indexOf('\n};', i));
  assert.match(body, /purged \$\{rows\.length - keep\.length\} chart review/, 'a count');
  assert.ok(!/output|findings|summary|statement/.test(body),
    'the purge must not touch the content on its way out');
  // A row whose timestamp cannot be parsed is KEPT. Deleting something
  // because its date was unreadable is the wrong way round.
  assert.match(body, /Number\.isNaN\(t\) \? true/, 'an unparseable date keeps the row');
});

// ── the audit records the review, never a finding ────────────────────────

test('the audit rows name the review and the counts, never a finding', () => {
  for (const action of ['ai_chart_review_started', 'ai_review_decided']) {
    const i = server.indexOf(`'${action}'`);
    assert.ok(i > 0, `${action} must be logged`);
    const meta = server.slice(i, server.indexOf('\n', server.indexOf('{', i) + 1) + 1);
    assert.ok(!/statement|summary|quote|finding:|output/.test(meta),
      `${action} must not carry a finding's text: ${meta}`);
  }
});

// ── the engine is still the only door ────────────────────────────────────

test('the review calls the engine, never the transport directly', () => {
  const i = server.indexOf('const runAiReview');
  const body = server.slice(i, server.indexOf('\n// E1.', i));
  assert.match(body, /gfcModelEngine\.invoke/, 'every call goes through the engine');
  assert.ok(!/vertexTransport\.transport|generateContent/.test(body),
    'a second call site is a second place the boundary rules get implemented differently');
  // countTokens is the one transport function the planner may use: it
  // generates nothing and sends no chart.
  assert.ok(!/vertexTransport\.(?!countTokens|buildContents)/.test(body),
    'only countTokens and buildContents are the planner\'s to use');
});

test('a merge runs only when there was more than one pass', () => {
  const i = server.indexOf('const runAiReview');
  const body = server.slice(i, server.indexOf('\n// E1.', i));
  assert.match(body, /if \(outputs\.length > 1\)/,
    'a single-pass review must not pay for a merge call that merges one thing');
  assert.match(body, /CHART_REVIEW_MERGE/);
});

test('the citation check runs on the SERVER after the model, and its count is kept', () => {
  const i = server.indexOf('const runAiReview');
  const body = server.slice(i, server.indexOf('\n// E1.', i));
  assert.match(body, /chartPacket\.enforceCitations\(merged, manifest\)/,
    'enforced after the merge, against the manifest of what was actually sent');
  assert.match(body, /droppedUncited/, 'and the count is stored so the screen can show it');
});

test('what the packet could not read is told to the reader whether the model mentioned it or not', () => {
  const i = server.indexOf('const runAiReview');
  const body = server.slice(i, server.indexOf('\n// E1.', i));
  assert.match(body, /manifest\.notRead\.map/,
    'an omission the model does not mention is still an omission');
});

// ── the packet module is the one place the arranging happens ─────────────

test('the loader hands rows to chartPacket rather than arranging them itself', () => {
  const i = server.indexOf('const gatherChartPacketInput');
  const body = server.slice(i, server.indexOf('\n// ── D5', i));
  assert.ok(!/DRAFT_HEADING|'UNSIGNED DRAFT/.test(body),
    'the draft heading is chartPacket\'s rule, not a second copy here');
  assert.ok(!/stripNonClinical =/.test(body), 'nor the stripping');
  assert.match(body, /messagingRepo\.threadVisibility/,
    'and visibility is messagingRepository\'s rule, never a copy of it — that is where the cross-client leak lived');
});

test('the loader narrows demographics and coverage before they ever reach a prompt', () => {
  const i = server.indexOf('const gatherChartPacketInput');
  const body = server.slice(i, server.indexOf('\n// ── D5', i));
  const demo = body.slice(body.indexOf('SECTION_KINDS.DEMOGRAPHICS'), body.indexOf('SECTION_KINDS.PROBLEMS'));
  assert.match(demo, /age/);
  assert.match(demo, /language/);
  assert.ok(!/address|ssn|social/i.test(demo),
    'an address and an SSN have no bearing on a review and are never put in a prompt');
  const cov = body.slice(body.indexOf('SECTION_KINDS.COVERAGE'));
  assert.ok(!/memberId|member_id/.test(cov.slice(0, 400)), 'payer NAME only — a member id is an identifier');
});

test('a document that could not be fetched is REPORTED, not silently left out', () => {
  const i = server.indexOf('const gatherChartPacketInput');
  const body = server.slice(i, server.indexOf('\n// ── D5', i));
  assert.match(body, /the stored file could not be retrieved/,
    'a review that says nothing about the one record that mattered is worse than one that says it could not read it');
});

test('the collection is registered as PHI, or the migration guard fails the build', () => {
  const mig = readSrc('dataMigration.js');
  assert.match(mig, /key: 'ai_reviews', phi: true/);
});

// ── E7: the card on the chart ─────────────────────────────────────────────

const page = (() => {
  const raw = fs.readFileSync(path.join(root, 'public', 'clinical.html'), 'utf8');
  const out = raw
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(1 - out.length / raw.length < 0.45, 'stripComments swallowed code in clinical.html');
  return out;
})();
const cardBody = (() => {
  const i = page.indexOf('const AiReviewCard = (');
  assert.ok(i > 0, 'AiReviewCard must be findable');
  return page.slice(i, page.indexOf('\n    const SummaryTab = (', i));
})();

test('a route with no screen is a capability that does not exist', () => {
  assert.match(page, /<AiReviewCard/, 'the card must actually be rendered');
  assert.match(page, /api\.startAiReview/);
  assert.match(page, /api\.aiReviews/);
  assert.match(page, /api\.decideAiFindings/);
});

test('the card decides no credential question itself — it renders the server\'s verdict', () => {
  assert.ok(!/clinicalRole|capabilit/i.test(cardBody),
    'a screen that decides a credential question drifts from the route that enforces it');
  assert.match(cardBody, /state\.canRun/, 'whether this viewer may run one is the server\'s answer');
  assert.match(cardBody, /canDecide/, 'and so is whether they may decide a finding');
  assert.ok(!/role === 'admin'|user\.role/.test(cardBody), 'no role test in the page');
});

test('"not switched on" is a sentence, and only an admin sees the blockers', () => {
  assert.match(cardBody, /AI review isn't switched on yet/,
    '"off" and "nothing to review" are different facts');
  // The page shows whatever blockers it was SENT; the server sends them to an
  // admin only, which is where that decision belongs.
  assert.match(cardBody, /state\.blockers/);
});

test('the AI banner is fixed, not dismissible, and names what it is', () => {
  assert.match(cardBody, /AI draft from Gemini\. Check every item against its source before acting\. Nothing here is saved to the chart\./);
  // A dismissible banner is one the reader turns off and then forgets.
  const i = cardBody.indexOf('AI draft from Gemini');
  const around = cardBody.slice(Math.max(0, i - 400), i + 200);
  assert.ok(!/dismiss|setHide|onClose|hidden/i.test(around), 'the banner must not be dismissible');
});

test('a running review says which pass it is on', () => {
  assert.match(cardBody, /Reading pass \$\{open\.currentPass\} of \$\{open\.passes\}/,
    'a long chart takes minutes; a silent spinner tells the clinician nothing');
  assert.match(cardBody, /read in passes and can take a few minutes/);
});

test('findings are ordered urgent first, and every citation is clickable', () => {
  assert.match(page, /AI_PRIORITY_ORDER = \['urgent', 'attention', 'info'\]/);
  assert.match(cardBody, /AI_PRIORITY_ORDER\.indexOf/, 'sorted by priority, not by the order the model happened to answer in');
  assert.match(cardBody, /onOpenSource/, 'a citation a clinician cannot open is one they cannot check');
  assert.match(cardBody, /c\.sourceId/);
});

test('what it could not read, and what was dropped for not citing, are both shown', () => {
  assert.match(cardBody, /Not read/);
  // ANCHORED ON THE CONDITION, NOT THE REFERENCE. The first version of this
  // asserted that `open.output.notReviewed` appeared somewhere in the card,
  // and `{false && (…)}` left the reference sitting inside a dead branch — so
  // hiding the list entirely passed. An assertion that cannot distinguish two
  // states proves nothing, and the mutation harness is the only reason I know
  // these two did not.
  assert.match(cardBody, /\{!!\(open\.output\.notReviewed \|\| \[\]\)\.length && \(/,
    'the Not read list must render on a real truthiness test, not inside a dead branch');
  assert.match(cardBody, /\{open\.droppedUncited > 0 && \(/,
    'a list with items silently removed is one nobody can trust the length of');
  // And both must be guarded by a condition that can actually be false —
  // `{false && …}` is not a guard, it is a deletion.
  assert.ok(!/\{false &&/.test(cardBody), 'nothing in the card may be switched off with a literal false');
});

test('the plan says what will be read before anything is sent, and documents can be unticked', () => {
  assert.match(cardBody, /What will be read/);
  assert.match(cardBody, /no time limit and nothing is capped/);
  assert.match(cardBody, /excludeDocumentIds/, 'the clinician may leave a document out');
  assert.match(cardBody, /maxLength=\{500\}/, 'the focus line is bounded the way the route bounds it');
});

// ── H: the admin screen and the go-live proof ────────────────────────────

test('the admin status route returns the KIND of credential, never the credential', () => {
  const i = server.indexOf("app.get('/api/admin/ai/status'");
  assert.ok(i > 0, 'the status route must exist');
  const body = server.slice(i, server.indexOf('\n});', i));
  assert.match(body, /requireAdmin/);
  assert.match(body, /credentialType: st\.credentialType/);
  assert.ok(!/GOOGLE_APPLICATION_CREDENTIALS|readFileSync|private_key|secret/i.test(body),
    'a credentials file in a diagnostic is the leak the check exists to prevent');
});

test('the go-live test takes no client id and forces a two-pass split', () => {
  const i = server.indexOf("app.post('/api/admin/ai/test'");
  assert.ok(i > 0, 'the test route must exist');
  const body = server.slice(i, server.indexOf('\n});', i));
  assert.match(body, /requireAdmin/);
  assert.match(body, /passCount: 2/,
    'a single-pass review working says nothing about whether a long chart does, and the merge has the most moving parts');
  assert.match(body, /CHART_REVIEW_MERGE/, 'and the merge is exercised');
  assert.ok(!/req\.params\.clientId|loadClinicalClient/.test(body),
    'NO PATIENT DATA is structural here, not promised: the route cannot name a client at all');
  assert.match(body, /patientId: null/, 'the audit row carries null rather than a made-up id');
  assert.match(body, /syntheticOnly: true/);
  assert.match(body, /ai_synthetic_chart\.json/);
  assert.match(body, /ai_synthetic_note\.pdf/);
});

test('an admin can re-run the Google-side checks without waiting six hours', () => {
  const i = server.indexOf("app.post('/api/admin/ai/recheck'");
  assert.ok(i > 0, 'the recheck route must exist');
  const body = server.slice(i, server.indexOf('\n});', i));
  assert.match(body, /requireAdmin/);
  assert.match(body, /runLiveChecks/);
});

test('the synthetic fixtures contain NO real person and no PHI-shaped identifiers', () => {
  const raw = fs.readFileSync(path.join(root, 'test', 'fixtures', 'ai_synthetic_chart.json'), 'utf8');
  const chart = JSON.parse(raw);
  assert.strictEqual(chart.clientId, 'SYNTHETIC-NOT-A-PATIENT',
    'the id is deliberately absurd so a row that leaked into a real screen would be unmistakable');
  // No SSN, no MBI, no date of birth, no email, no phone.
  assert.ok(!/\b\d{3}-\d{2}-\d{4}\b/.test(raw), 'no SSN shape');
  assert.ok(!/\b[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}\b/.test(raw), 'no email');
  assert.ok(!/\b\d{3}[-. ]\d{3}[-. ]\d{4}\b/.test(raw), 'no phone');
  assert.ok(!/\bdob\b|dateOfBirth/i.test(raw), 'no date of birth');
  // The MBI shape, position by position — the one identifier a chart fixture
  // is most likely to carry by accident.
  assert.ok(!/\b[0-9][ACDEFGHJKMNPQRTUVWXY][0-9ACDEFGHJKMNPQRTUVWXY][0-9][ACDEFGHJKMNPQRTUVWXY][0-9ACDEFGHJKMNPQRTUVWXY][0-9][ACDEFGHJKMNPQRTUVWXY][ACDEFGHJKMNPQRTUVWXY][0-9][0-9]\b/.test(raw), 'no MBI shape');
  // NOT asserted: that the scrubber leaves the file untouched. It redacts
  // ISO dates, and a clinical fixture is MEANT to carry visit dates — that
  // assertion would have been testing the scrubber, not the fixture.
});

test('the synthetic chart really does split into two passes, each keeping its own documents', () => {
  const chart = JSON.parse(fs.readFileSync(path.join(root, 'test', 'fixtures', 'ai_synthetic_chart.json'), 'utf8'));
  const built = P.buildSections({
    ...chart,
    documents: [{
      clientId: chart.clientId, id: 'SYN-DOC-1', sourceId: 'doc:SYN-DOC-1',
      title: 'Synthetic cardiology consult', date: '2026-03-02',
      mimeType: 'application/pdf', bytes: Buffer.from('%PDF-1.4 synthetic')
    }]
  });
  const passes = P.splitIntoPasses({ ...built, passCount: 2 });
  assert.strictEqual(passes.length, 2, 'the fixture must be able to produce the split the test forces');
  // Both encounters are present across the passes, and the header is in each.
  const all = passes.flatMap(p => p.sections.map(s => s.sourceId));
  assert.ok(all.includes('enc:SYN-ENC-1') && all.includes('enc:SYN-ENC-2'));
  for (const p of passes) {
    for (const kind of P.HEADER_KINDS) {
      assert.ok(p.sections.some(s => s.sourceId === kind), `${kind} missing from pass ${p.pass}`);
    }
  }
  assert.strictEqual(passes.flatMap(p => p.documents).length, 1, 'the document travels with its encounter');
});

test('the synthetic note PDF is a real PDF, or the test proves nothing about document reading', async () => {
  const bytes = fs.readFileSync(path.join(root, 'test', 'fixtures', 'ai_synthetic_note.pdf'));
  assert.ok(bytes.length > 500, 'not an empty file');
  assert.strictEqual(bytes.slice(0, 5).toString(), '%PDF-', 'a real PDF header');
  // READ THE TEXT BACK WITH THE REPO'S OWN EXTRACTOR rather than grepping the
  // bytes: pdfkit encodes its text streams, so a byte scan cannot distinguish
  // "the words are not there" from "the words are compressed" — which is the
  // same mistake the caregiver attestation test made and had to be rewritten
  // for.
  const words = await readPdfText(path.join(root, 'test', 'fixtures', 'ai_synthetic_note.pdf'));
  assert.match(words, /SYNTHETIC TEST DOCUMENT/, 'it must say on its face that it is synthetic');
  assert.match(words, /NOT A REAL PATIENT/);
});

test('H3: the admin panel exists, is rendered, and restates no role rule', () => {
  const hub = (() => {
    const raw = fs.readFileSync(path.join(root, 'public', 'admin-hub.html'), 'utf8');
    return raw.replace(/^[ \t]*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  })();
  assert.match(hub, /const AiSetupPanel = \(/, 'the panel must exist');
  assert.match(hub, /<AiSetupPanel token=\{token\} \/>/, 'a panel nobody renders is not a panel');
  const i = hub.indexOf('const AiSetupPanel = (');
  const body = hub.slice(i, hub.indexOf('\n    const DashboardPage', i));
  assert.match(body, /if \(!st\) return null/,
    'it renders nothing when the server refuses — the gate is the route, never the absence of a tile');
  assert.ok(!/isSuperAdmin|user\.role|isManager/.test(body), 'the page must not decide who may see this');
  assert.match(body, /Run test/);
  assert.match(body, /no real patient/i, 'the owner must know the test sends nothing real');
  assert.match(body, /Re-run checks/, 'an admin who just changed a console setting should not wait six hours');
  // A static key is named as refused rather than shown as a neutral value.
  assert.match(body, /refused rather than used/);
});
