// test/document_extraction.test.js — reading a scanned document into proposals.
//
// The owner asked for scanned documents to populate the record "automatically".
// What is pinned here is every place that word is refused, because the failure
// mode is not a crash. A misread member ID reads exactly as plausibly as a
// right one and surfaces months later as a denied claim; a misread date of
// birth on somebody else's face sheet is a patient-identity error. A blank
// field gets asked about. A wrong one gets billed.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const X = require('../documentExtraction.js');
const intakeFields = require('../public/intake-fields.js');
const fs = require('fs');
const path = require('path');

const src = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

// A source scan that cannot tell live code from PROSE ABOUT that code proves
// nothing — the fifth time this repo has paid for it, and this test caught the
// sixth on its first run: the module's own header explains why it does not own
// the document catalog, and names it to say so. Comments are stripped before
// any scan below. The `:` guard keeps `https://` intact, since one of the
// scans is looking for exactly that.
const code = (f) => src(f)
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const propose = (over = {}) => X.buildProposals({
  kind: over.kind || 'insuranceCard',
  docId: over.docId || 'doc_1',
  extracted: over.extracted || { 'commercial.carrier': 'Aetna', 'commercial.memberId': 'W123456789' },
  readValue: over.readValue || (() => ''),
  confidence: over.confidence,
  at: '2026-09-22T12:00:00.000Z'
});

// -- nothing is written automatically, at any confidence -------------------

test('a proposal is not a value - every row arrives undecided', () => {
  const p = propose({ confidence: 1 });
  assert.strictEqual(p.rows.length, 2);
  for (const r of p.rows) {
    assert.strictEqual(r.decision, null, 'a row a person has not looked at has no decision');
  }
  assert.strictEqual(p.reviewCount, 2, 'and the count of what needs a human must show it');
});

test('a review with anything undecided is not complete, so enrollment cannot finish on a half-read scan', () => {
  const p = propose();
  const r = X.applyReview({
    proposal: p,
    decisions: { 'commercial.carrier': { decision: 'accept' } },
    readValue: () => '', actor: { name: 'B. Ume' }
  });
  assert.strictEqual(r.complete, false);
  assert.strictEqual(r.undecided.length, 1);
  assert.strictEqual(r.undecided[0].path, 'commercial.memberId');
  assert.strictEqual(r.writes.length, 1, 'the decided one still lands - a review is per field');
});

test('a discarded proposal writes nothing at all', () => {
  const p = propose();
  const r = X.applyReview({
    proposal: p,
    decisions: {
      'commercial.carrier': { decision: 'discard' },
      'commercial.memberId': { decision: 'discard' }
    },
    readValue: () => '', actor: {}
  });
  assert.deepStrictEqual(r.writes, []);
  assert.strictEqual(r.complete, true);
  assert.strictEqual(r.outcome, 'discarded');
});

test('nothing in the module writes to a record itself', () => {
  const s = code('documentExtraction.js');
  assert.ok(!/db\.set\(|await db\.|writeFile/.test(s),
    'the module proposes; a route puts it in front of a person and only then writes');
});

// -- the provenance of an accepted value is the HUMAN ----------------------

test('an accepted value lands staff-verified, not as an extraction', () => {
  const p = propose();
  const r = X.applyReview({
    proposal: p,
    decisions: {
      'commercial.carrier': { decision: 'accept' },
      'commercial.memberId': { decision: 'accept' }
    },
    readValue: () => '', actor: { name: 'B. Ume' }
  });
  for (const w of r.writes) {
    assert.strictEqual(w.source, 'staff_verified', 'a person looked at it - that is what makes it verified');
    assert.strictEqual(w.verifiedBy, 'B. Ume');
    // And the trail back to the scan survives the acceptance.
    assert.strictEqual(w.evidence, 'uploaded_doc:doc_1');
  }
});

test('an edited value is the reviewer value, never the model value', () => {
  const p = propose();
  const r = X.applyReview({
    proposal: p,
    decisions: {
      'commercial.carrier': { decision: 'edit', value: 'Aetna Better Health' },
      'commercial.memberId': { decision: 'discard' }
    },
    readValue: () => '', actor: { name: 'B. Ume' }
  });
  assert.strictEqual(r.writes[0].value, 'Aetna Better Health');
  assert.strictEqual(r.outcome, 'edited');
});

test('one retyped field makes the whole run an EDIT, however many were accepted', () => {
  // Caught by mutation: the only mixed case tested was edit+discard, where
  // accepted is 0 - so flipping the precedence to accept-wins changed nothing
  // and the assertion could not tell the two states apart. A run where the
  // reviewer had to retype anything cost them time, and reading it back as a
  // clean acceptance is how a feature that is not helping looks like one that
  // is. That signal is the only honest measure 10.3 asks for.
  const p = propose({ extracted: { 'commercial.carrier': 'Aetna', 'commercial.memberId': 'W1', payerType: '' } });
  const r = X.applyReview({
    proposal: p,
    decisions: {
      'commercial.carrier': { decision: 'accept' },
      'commercial.memberId': { decision: 'edit', value: 'W123456789' }
    },
    readValue: () => '', actor: {}
  });
  assert.strictEqual(r.counts.accepted, 1);
  assert.strictEqual(r.counts.edited, 1);
  assert.strictEqual(r.outcome, 'edited');
});

// -- identity: a document may simply be about somebody else ----------------

test('a date of birth read off a document is NEVER writable, whatever the decision says', () => {
  const p = propose({
    kind: 'referral',
    extracted: { dob: '1948-03-02', 'medicalTeam.pcpName': 'Dr Hale' },
    readValue: (path) => (path === 'dob' ? '1951-11-08' : '')
  });
  const dobRow = p.rows.find(r => r.path === 'dob');
  assert.strictEqual(dobRow.verifyOnly, true);
  const r = X.applyReview({
    proposal: p,
    decisions: {
      dob: { decision: 'accept' },
      'medicalTeam.pcpName': { decision: 'accept' }
    },
    readValue: (path) => (path === 'dob' ? '1951-11-08' : ''), actor: {}
  });
  assert.ok(!r.writes.some(w => w.path === 'dob'),
    'silently correcting a DOB from a document about the wrong patient is the worst thing this could do');
  assert.ok(r.refused.some(x => x.path === 'dob'), 'and it is refused visibly, not dropped');
});

test('a document that disagrees about identity says so before anything else', () => {
  const p = propose({
    kind: 'referral',
    extracted: { dob: '1948-03-02' },
    readValue: (path) => (path === 'dob' ? '1951-11-08' : '')
  });
  assert.strictEqual(p.identityConflicts.length, 1);
  assert.strictEqual(p.identityConflicts[0].onFile, '1951-11-08');
  assert.strictEqual(p.identityConflicts[0].onDocument, '1948-03-02');
});

test('a verify field never makes a data field look answered', () => {
  const p = propose({ kind: 'referral', extracted: { dob: '1948-03-02' } });
  assert.strictEqual(p.ledgerProposals.dob, undefined,
    'the ledger reads this - a verify row there would propose into a field it may not write');
});

// -- the stale check -------------------------------------------------------

test('a field that changed after the scan is refused, with both values named', () => {
  // The reviewer is reasoning about a value that is no longer there. Applying
  // their decision would apply it to a different one, and nobody would know.
  const p = propose({ readValue: () => '' });
  const r = X.applyReview({
    proposal: p,
    decisions: { 'commercial.carrier': { decision: 'accept' }, 'commercial.memberId': { decision: 'discard' } },
    readValue: (path) => (path === 'commercial.carrier' ? 'Humana' : ''),
    actor: {}
  });
  assert.deepStrictEqual(r.writes, []);
  const ref = r.refused.find(x => x.path === 'commercial.carrier');
  assert.strictEqual(ref.code, 'EXTRACTION_SUPERSEDED');
  assert.strictEqual(ref.onFile, 'Humana');
  assert.strictEqual(ref.wasOnFile, '');
});

test('a value that already matches is not a write', () => {
  const p = propose({ readValue: (path) => (path === 'commercial.carrier' ? 'Aetna' : '') });
  const r = X.applyReview({
    proposal: p,
    decisions: { 'commercial.carrier': { decision: 'accept' }, 'commercial.memberId': { decision: 'discard' } },
    readValue: (path) => (path === 'commercial.carrier' ? 'Aetna' : ''),
    actor: {}
  });
  assert.deepStrictEqual(r.writes, [], 're-saving the same string is not a correction');
  assert.strictEqual(r.counts.accepted, 1, 'but the reviewer did decide it');
});

test('a proposal that agrees with the record is flagged as agreeing, not as work', () => {
  const p = propose({ readValue: (path) => (path === 'commercial.carrier' ? 'Aetna' : '') });
  assert.strictEqual(p.rows.find(r => r.path === 'commercial.carrier').agrees, true);
  assert.strictEqual(p.reviewCount, 1, 'only the disagreeing row needs attention');
});

// -- the allow-list is the editor's, not a second one ----------------------

test('every declared target is a path the staff editor can also write', () => {
  for (const [kind, t] of Object.entries(X.TARGETS)) {
    for (const p of [...(t.fill || []), ...(t.verify || [])]) {
      assert.ok(intakeFields.fieldAt(p), kind + ' -> ' + p + ' must be a declared intake field');
    }
    for (const p of (t.fill || [])) {
      assert.ok(intakeFields.isEditablePath(p),
        kind + ' -> ' + p + ' must be writable by a person, or nobody can correct what was proposed');
    }
  }
});

test('a closed select holds the model to exactly the catalog it holds a person to', () => {
  const schema = X.schemaFor('insuranceCard');
  const field = intakeFields.fieldAt('payerType');
  assert.deepStrictEqual(schema.fields.payerType.enum, intakeFields.optionsFor(field),
    'derived, never restated - narrowing the field narrows the schema on the next request');
});

test('an invented option is refused at review even if it reached a proposal', () => {
  const p = propose({ extracted: { payerType: 'Cryptocurrency' } });
  const r = X.applyReview({
    proposal: p, decisions: { payerType: { decision: 'accept' } },
    readValue: () => '', actor: {}
  });
  assert.deepStrictEqual(r.writes, []);
  assert.ok(r.refused.some(x => x.path === 'payerType' && Array.isArray(x.options)),
    'and the refusal names what IS on offer');
});

test('an open select stays open - the ones the editor deliberately left open', () => {
  // A refactor that centralises a rule must not quietly tighten it. Caught by
  // mutation: this used to loop the insuranceCard schema looking for an open
  // select, and NONE of today's targets is one - so closing every select
  // silently passed. A loop that iterates nothing proves nothing about the rule
  // it loops over, so the rule is exercised against a field that IS open.
  const openField = intakeFields.ALL_FIELDS.find(f => f.type === 'select' && f.open);
  assert.ok(openField, 'the editor must still have an open select for this to mean anything');
  assert.strictEqual(X.schemaFieldFor(openField.path).enum, undefined,
    openField.path + ' is an open select and must not be given a closed vocabulary here');
  // And the closed case, so this cannot pass by never closing anything.
  const closedField = intakeFields.ALL_FIELDS.find(f => f.type === 'select' && !f.open && intakeFields.optionsFor(f).length);
  assert.ok(Array.isArray(X.schemaFieldFor(closedField.path).enum));
});

test('a module with a bad target REFUSES TO LOAD, rather than shipping it', () => {
  // `validateTargets` being right is not the same fact as anything calling it.
  // Caught by mutation: the throw could be removed and every test still passed,
  // because the shipped targets are valid and the validator was being exercised
  // directly. So this drives the real load, on a real copy, with a real bad
  // target in it.
  const os = require('os');
  const root = path.join(__dirname, '..');
  const copy = path.join(os.tmpdir(), `dx_probe_${process.pid}.js`);
  const mutated = src('documentExtraction.js')
    .replace("require('./public/intake-fields')", `require(${JSON.stringify(path.join(root, 'public', 'intake-fields.js'))})`)
    .replace("require('./enrollmentLedger')", `require(${JSON.stringify(path.join(root, 'enrollmentLedger.js'))})`)
    .replace("      'payerType',", "      'payerType', 'no.such.field',");
  assert.ok(/no\.such\.field/.test(mutated), 'the probe must actually have injected a bad target');
  fs.writeFileSync(copy, mutated);
  try {
    assert.throws(() => require(copy), /not a declared intake field/,
      'a target proposing into a field no person can correct must stop the module loading');
  } finally { fs.unlinkSync(copy); }
});

test('a target naming a path the editor does not declare refuses at load', () => {
  // The guard only fires on bad data, so the data has to be supplied. Without
  // this the guard could be deleted and every test would still pass, because
  // today's targets are all valid.
  assert.deepStrictEqual(X.validateTargets({ insuranceCard: { fill: ['no.such.field'] } }).length, 1);
  const listPath = intakeFields.ALL_FIELDS.find(f => f.type === 'list' || f.type === 'multi').path;
  const bad = X.validateTargets({ insuranceCard: { fill: [listPath] } });
  assert.strictEqual(bad.length, 1, 'a repeating or multi answer must be refused by name');
  assert.match(bad[0], /not extractable yet/);
  assert.deepStrictEqual(X.validateTargets(X.TARGETS), [], 'and the shipped targets must be clean');
});

test('the module names no document kind of its own', () => {
  const s = code('documentExtraction.js');
  assert.ok(!/GFC_EXPECTED_DOCUMENTS/.test(s), 'the document catalog has an owner');
  // And every extractable kind must be a kind that catalog actually carries,
  // or a scan lands in a bucket no checklist reads and nobody ever sees it.
  const server = src('server.js');
  const catalog = (server.match(/const GFC_EXPECTED_DOCUMENTS = \[[\s\S]*?\n\];/) || [''])[0];
  assert.ok(catalog.length > 100, 'the catalog must still be findable');
  for (const kind of X.extractableKinds()) {
    if (kind === X.CONSENT_PACKET_KIND) continue;
    assert.ok(new RegExp("kind: '" + kind + "'").test(catalog),
      '"' + kind + '" is extractable but is not a document kind the registry carries');
  }
});

test('a repeating or multi-select answer is refused by name, never half-read', () => {
  // A dropped medication reads as a medication the patient is not taking.
  const listPaths = intakeFields.ALL_FIELDS.filter(f => f.type === 'list' || f.type === 'multi').map(f => f.path);
  assert.ok(listPaths.length, 'there must be some to guard against');
  for (const [kind, t] of Object.entries(X.TARGETS)) {
    for (const p of [...(t.fill || []), ...(t.verify || [])]) {
      assert.ok(!listPaths.includes(p), kind + ' -> ' + p + ' is a repeating or multi answer and is not extractable yet');
    }
  }
});

// -- an undeclared kind cannot be extracted at all -------------------------

test('a kind with no declared targets has no schema and cannot be read', () => {
  // `photoId` used to be this example — it now has a verify-only target of
  // its own (2026-09-23, "it needs to be able to read any document
  // uploaded"), so a kind genuinely outside the catalog is the one to use
  // here, or this test stops proving anything the day a kind gets declared.
  assert.strictEqual(X.schemaFor('somethingNobodyDeclared'), null);
  assert.strictEqual(X.isExtractable('somethingNobodyDeclared'), false);
  const r = X.buildProposals({ kind: 'somethingNobodyDeclared', docId: 'd1', extracted: { anything: 'x' } });
  assert.strictEqual(r.code, 'EXTRACTION_KIND_UNSUPPORTED');
});

test('a field outside the declared targets never reaches a proposal', () => {
  const p = propose({ extracted: { 'commercial.carrier': 'Aetna', ssnLast4: '1234', 'matching.interests': 'x' } });
  assert.deepStrictEqual(p.rows.map(r => r.path), ['commercial.carrier'],
    'an insurance card does not get to write the SSN box because the model returned one');
});

test('a proposal must name the document it came from', () => {
  assert.strictEqual(X.buildProposals({ kind: 'insuranceCard', extracted: {} }).code, 'EXTRACTION_NO_DOCUMENT');
});

// -- confidence never decides anything -------------------------------------

test('confidence is carried for triage and never branches into an auto-accept', () => {
  const s = code('documentExtraction.js');
  // A threshold constant is the shape this goes wrong in: >= 0.95 auto-apply.
  assert.ok(!/confidence\s*[><]=?\s*0?\.\d/.test(s),
    'a confidence threshold that applies a value is an auto-write wearing a number');
  const p = propose({ confidence: 0.99 });
  const r = X.applyReview({ proposal: p, decisions: {}, readValue: () => '', actor: {} });
  assert.deepStrictEqual(r.writes, [], 'however confident, an undecided row writes nothing');
});

test('a confidence outside 0..1 is discarded rather than displayed as fact', () => {
  assert.strictEqual(propose({ confidence: 7 }).rows[0].confidence, null);
  assert.strictEqual(propose({ confidence: 0.4 }).rows[0].confidence, 0.4);
});

// -- consent packets are classified, never recorded ------------------------

const DEFS = [{ type: 'npp', title: 'Notice of Privacy Practices', bodyVersion: 'v2' }];

test('a classified consent proposes a row and does not record a signature', () => {
  const p = X.buildConsentProposals({
    docId: 'd3', consentDefs: DEFS,
    found: [{ type: 'npp', signedAt: '2026-08-01', bodyVersion: 'draft-1', confidence: 0.8 }]
  });
  assert.strictEqual(p.rows.length, 1);
  assert.strictEqual(p.rows[0].decision, null);
  assert.strictEqual(p.rows[0].requiredVersion, 'v2');
  assert.match(p.note, /never recorded/i, 'the screen must say what accepting does not do');
});

test('a consent the registry does not carry is reported, never proposed', () => {
  const p = X.buildConsentProposals({
    docId: 'd3', consentDefs: DEFS,
    found: [{ type: 'npp' }, { type: 'inventedConsent' }]
  });
  assert.strictEqual(p.rows.length, 1);
  assert.deepStrictEqual(p.unrecognised, ['inventedConsent'],
    'the registry owns that vocabulary and this is not a second one');
});

// -- the engine is the only way out of the boundary ------------------------

test('extraction goes through the one model engine, never a provider directly', () => {
  const s = code('documentExtraction.js');
  assert.ok(!/BedrockRuntime|invokeModel|fetch\(|https?:\/\//.test(s),
    'a second call site is a second place the 10.3 boundary rules get implemented slightly differently');
});

// ── the screen decides nothing ────────────────────────────────────────────
//
// An owner item is only open for the owner once there is somewhere to do it,
// and a screen that restates a server rule drifts from it silently.

test('the review screen lists no readable kind and no target of its own', () => {
  const page = src('public/admin-enrollment.html');
  const panel = page.slice(page.indexOf('const ExtractionRow'), page.indexOf('const DocumentExchange'));
  assert.ok(panel.length > 500, 'the review panel must still be findable');
  for (const kind of X.extractableKinds()) {
    assert.ok(!new RegExp(`['"\`]${kind}['"\`]`).test(panel),
      `the page names "${kind}" — that is a second copy of a list the server already serves`);
  }
  for (const t of Object.values(X.TARGETS)) {
    for (const p of (t.fill || [])) {
      assert.ok(!panel.includes(`'${p}'`), `the page names the target ${p} rather than rendering what it was sent`);
    }
  }
  assert.ok(/extractableKinds\.includes/.test(panel), 'it must ask the server which kinds are readable');
});

test('the screen never decides whether the boundary is satisfied', () => {
  const page = src('public/admin-enrollment.html');
  const panel = page.slice(page.indexOf('const ExtractionRow'), page.indexOf('const DocumentExchange'));
  assert.ok(!/BEDROCK_|ZERO_DATA_RETENTION|process\.env/.test(panel),
    'a page that decides the boundary offers a button the route then refuses');
  assert.ok(/extraction\.available/.test(panel), 'it renders the server verdict');
  assert.ok(/not switched on/i.test(panel),
    '"not switched on" and "nothing to read here" are different facts and must read differently');
});

test('the screen says plainly that nothing has been saved yet', () => {
  const page = src('public/admin-enrollment.html');
  const panel = page.slice(page.indexOf('const ExtractionReview'), page.indexOf('const ReadDocumentButton'));
  assert.ok(/Nothing here has been saved/i.test(panel),
    'a reviewer who believes the values already landed is the failure mode of this screen');
});

test('a verify-only row is rendered without any way to save it', () => {
  const page = src('public/admin-enrollment.html');
  const row = page.slice(page.indexOf('const ExtractionRow'), page.indexOf('const ExtractionReview'));
  const verifyBranch = row.slice(row.indexOf('if (row.verifyOnly)'), row.indexOf('return (\n        <div className="py-2 border-b'));
  assert.ok(verifyBranch.length > 200, 'the verify branch must still be findable');
  assert.ok(!/onDecide/.test(verifyBranch),
    'offering a decision on a field that is never writable is a button the server will refuse');
  assert.ok(/never saved from here/i.test(verifyBranch), 'and the row must say why there is no button');
});

test('an identity conflict is shown before anything else on the panel', () => {
  const page = src('public/admin-enrollment.html');
  const panel = page.slice(page.indexOf('const ExtractionReview'), page.indexOf('const ReadDocumentButton'));
  const guard = '{(extraction.identityConflicts || []).length > 0 && (';
  const conflictAt = panel.indexOf(guard);
  const rowsAt = panel.indexOf('(extraction.rows || []).map');
  // Caught by mutation: asserting only the POSITION passed with the block
  // disabled by a `false &&`, because a dead branch still sits where it sat.
  // The guard is pinned exactly, so nothing else can gate it either.
  assert.ok(conflictAt > -1, 'the conflict block must render on exactly the conflict count');
  assert.ok(rowsAt > -1);
  assert.ok(conflictAt < rowsAt,
    '"whose document is this" is asked before any value off it is offered');
});
