// test/chart_packet.test.js — what the comprehensive review is allowed to read
// (2026-10-12, spec sections D and E3).
//
// The review is comprehensive by owner decision, so the interesting rules are
// the two exclusions and the citation check. Both have a failure mode that is
// silent: a packet carrying two patients produces findings that merge them,
// and a finding whose citation does not resolve is one a clinician cannot
// check but will act on anyway.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const P = require('../chartPacket.js');

const CLIENT = 'client_juanita';

// A fixture patient with every source kind in D2 present.
const fixture = (over = {}) => ({
  clientId: CLIENT,
  emr: {
    demographics: { age: 78, sex: 'female', language: 'English' },
    problems: [{ description: 'Type 2 diabetes' }],
    medications: [{ drug: 'metformin' }],
    allergies: [{ substance: 'penicillin' }],
    vitals: [{ date: '2026-02-01', bp: '138/82' }],
    encounters: [{ date: '2026-02-01' }],
    immunizations: [{ name: 'influenza' }],
    procedures: [{ name: 'A1c draw' }],
    goals: [{ goal: 'walk daily' }],
    careTeam: [{ name: 'Bethel Godwins' }],
    coverage: { payer: 'Medicare' }
  },
  encounters: [{
    clientId: CLIENT, encounterUuid: 'e-1', type: 'Home visit', date: '2026-02-01',
    clinician: 'Bethel Godwins', diagnoses: ['E11.9'], serviceCodes: ['99349'],
    note: 'Patient reports fatigue.', addenda: [], coSignStatus: null
  }],
  orders: [{ clientId: CLIENT, id: 'o-1', orderType: 'lab', date: '2026-02-02', encounterUuid: 'e-1' }],
  results: [{ clientId: CLIENT, id: 'r-1', title: 'A1c', date: '2026-02-09', encounterUuid: 'e-1' }],
  prescriptions: [{ clientId: CLIENT, id: 'rx-1', drug: 'metformin', date: '2026-02-01' }],
  carePlanVersions: [{ clientId: CLIENT, version: 2, effectiveDate: '2026-01-15', problems: ['DM'] }],
  intake: { history: 'lives alone', advanceDirective: { status: 'none' } },
  medReconciliations: [{ clientId: CLIENT, id: 'mr-1', at: '2026-02-01', changeLog: [] }],
  caregiverLogs: [{ clientId: CLIENT, id: 'cg-1', kind: 'visit log', date: '2026-02-03' }],
  messageThreads: [{ clientId: CLIENT, threadId: 't-1', channel: 'care_coordination', messages: [{ body: 'BP running high' }], lastAt: '2026-02-04' }],
  consentElections: { telehealth: true, codeStatus: 'full' },
  documents: [{ clientId: CLIENT, id: 'd-1', title: 'Cardiology consult', mimeType: 'application/pdf', bytes: Buffer.from('%PDF'), date: '2026-02-05', encounterUuid: 'e-1' }],
  ...over
});

const idsOf = (built) => built.sections.map(s => s.sourceId);

// ── D2: everything, and it is all citable ─────────────────────────────────

test('every source kind in D2 is present for a patient who has them all', () => {
  const built = P.buildSections(fixture());
  const ids = idsOf(built);
  for (const kind of Object.values(P.SECTION_KINDS)) {
    assert.ok(ids.includes(kind), `${kind} is missing from the packet`);
  }
  // And the per-row sources, each under its declared prefix.
  for (const expected of ['enc:e-1', 'order:o-1', 'result:r-1', 'rx:rx-1', 'careplan:v2', 'medrec:mr-1', 'caregiver:cg-1', 'msg:t-1']) {
    assert.ok(ids.includes(expected), `${expected} is missing`);
  }
  assert.deepStrictEqual(built.documents.map(d => d.sourceId), ['doc:d-1']);
  assert.strictEqual(built.notRead.length, 0, 'nothing should be unread for a complete fixture');
});

test('a section the clinician\'s own EMR session could not return is LISTED, never filled another way', () => {
  const f = fixture();
  delete f.emr.problems;
  f.emr.coverage = null;
  const built = P.buildSections(f);
  const unread = built.notRead.map(n => n.sourceId);
  assert.ok(unread.includes('emr:problems'), 'a refused section must be reported');
  assert.ok(unread.includes('emr:coverage'));
  assert.ok(!idsOf(built).includes('emr:problems'), 'and must not appear as if it had been read');
  assert.match(built.notRead.find(n => n.sourceId === 'emr:problems').why, /EMR session/);
});

test('no time window and no caps — a long history is all there', () => {
  const many = Array.from({ length: 300 }, (_, i) => ({
    clientId: CLIENT, encounterUuid: `e-${i}`, type: 'Home visit',
    date: `20${20 + Math.floor(i / 50)}-01-01`, note: `visit ${i}`
  }));
  const built = P.buildSections(fixture({ encounters: many }));
  assert.strictEqual(built.sections.filter(s => s.kind === 'encounter').length, 300,
    'the review is comprehensive by owner decision — nothing is trimmed here');
});

// ── exclusion 1: another patient's data ───────────────────────────────────

test('another client\'s row is DROPPED and counted, never arranged', () => {
  const f = fixture();
  f.encounters.push({ clientId: 'client_someone_else', encounterUuid: 'e-X', note: 'OTHER PATIENT NOTE' });
  f.messageThreads.push({ clientId: 'client_someone_else', threadId: 't-X', messages: [{ body: 'OTHER PATIENT MESSAGE' }] });
  f.documents.push({ clientId: 'client_someone_else', id: 'd-X', title: 'OTHER', mimeType: 'application/pdf', bytes: Buffer.from('x') });
  const built = P.buildSections(f);

  const blob = JSON.stringify(built);
  assert.ok(!blob.includes('OTHER PATIENT NOTE'), 'another patient\'s note must not reach the packet');
  assert.ok(!blob.includes('OTHER PATIENT MESSAGE'), 'nor their message');
  assert.ok(!idsOf(built).includes('enc:e-X'));
  assert.ok(!built.documents.some(d => d.sourceId === 'doc:d-X'));
  // Counted, by LABEL — what was in it is exactly what must not be recorded.
  assert.strictEqual(built.droppedForeign.length, 3);
  assert.ok(built.droppedForeign.every(l => !/OTHER/.test(l)), 'the drop record names the id, not the content');
});

test('a row that is not client-keyed is allowed, because the EMR read was already scoped', () => {
  // emr.* rows come back from a patient-scoped read and carry no clientId.
  // Treating "no clientId" as a mismatch would empty the packet.
  assert.strictEqual(P.belongsTo({ description: 'HTN' }, CLIENT), true);
  assert.strictEqual(P.belongsTo({ clientId: CLIENT }, CLIENT), true);
  assert.strictEqual(P.belongsTo({ clientId: 'other' }, CLIENT), false);
  assert.strictEqual(P.belongsTo({ client_id: 'other' }, CLIENT), false);
});

// ── exclusion 2: non-clinical artefacts ───────────────────────────────────

test('signature images, IP hashes and prices never reach the packet, at any depth', () => {
  const f = fixture();
  f.carePlanVersions[0].rnSignature = 'data:image/png;base64,SIGNATUREBYTES';
  f.carePlanVersions[0].nested = { deeper: { signatureImage: 'SIGNATUREBYTES', ipHash: 'HASHVALUE' } };
  f.encounters[0].ipHash = 'HASHVALUE';
  f.intake.rateAgreement = { hourlyRate: 42 };
  const built = P.buildSections(f);
  const blob = JSON.stringify(built);
  for (const leak of ['SIGNATUREBYTES', 'HASHVALUE', 'hourlyRate', '42']) {
    assert.ok(!blob.includes(leak), `"${leak}" must not reach the packet`);
  }
  // What the plan SAID is clinical and must survive the stripping.
  assert.match(JSON.stringify(built.sections.find(s => s.sourceId === 'careplan:v2')), /DM/);
});

test('stripping is by key at any depth, and leaves clinical values alone', () => {
  const out = P.stripNonClinical({
    drug: 'metformin',
    signature: 'x', ipHash: 'y', price: 9,
    rows: [{ dose: '500mg', payRate: 1, clientSignature: 'z' }]
  });
  assert.deepStrictEqual(out, { drug: 'metformin', rows: [{ dose: '500mg' }] });
});

// ── a draft is never presented as the record ──────────────────────────────

test('an unsigned note appears ONLY under the UNSIGNED DRAFT heading', () => {
  const f = fixture();
  f.encounters.push({
    clientId: CLIENT, encounterUuid: 'e-draft', type: 'Home visit', date: '2026-03-01',
    note: 'Draft impression: possible CHF', unsigned: true
  });
  const built = P.buildSections(f);
  const draft = built.sections.find(s => s.sourceId === 'enc:e-draft');
  assert.ok(draft.text.startsWith(P.DRAFT_HEADING),
    'a draft presented as part of the record is a finding built on something nobody attested to');
  assert.strictEqual(draft.draft, true);
  // And a signed one carries no such heading.
  const signed = built.sections.find(s => s.sourceId === 'enc:e-1');
  assert.ok(!signed.text.includes(P.DRAFT_HEADING));
  assert.strictEqual(signed.draft, false);
});

// ── message bodies ────────────────────────────────────────────────────────

test('message bodies are included — but only for the threads handed in', () => {
  const built = P.buildSections(fixture());
  const thread = built.sections.find(s => s.sourceId === 'msg:t-1');
  assert.match(thread.text, /BP running high/, 'the body is the content worth reviewing');
  assert.match(thread.text, /care_coordination/);
  // The caller applies threadVisibility; this module arranges what it is
  // given and drops anything belonging to another client (tested above).
  const none = P.buildSections(fixture({ messageThreads: [] }));
  assert.ok(!idsOf(none).some(id => id.startsWith('msg:')));
});

// ── every section is headed so a finding can cite it ─────────────────────

test('every section and document has a stable sourceId in the manifest', () => {
  const built = P.buildSections(fixture());
  const manifest = P.buildManifest(built);
  const ids = P.manifestIds(manifest);
  for (const s of built.sections) assert.ok(ids.has(s.sourceId), `${s.sourceId} missing from manifest`);
  for (const d of built.documents) assert.ok(ids.has(d.sourceId), `${d.sourceId} missing from manifest`);
  assert.ok(manifest.sources.every(s => s.title && s.kind), 'a manifest row names what it is');
});

test('notRead survives into the manifest, because "what it could not read" is the point', () => {
  const f = fixture();
  delete f.emr.goals;
  const built = P.buildSections(f);
  const manifest = P.buildManifest(built);
  assert.ok(manifest.notRead.some(n => n.sourceId === 'emr:goals'));
  // A bare string is normalised rather than dropped.
  const m2 = P.buildManifest({ notRead: ['doc:99'] });
  assert.deepStrictEqual(m2.notRead, [{ sourceId: 'doc:99', why: 'could not be read' }]);
});

// ── D4: the planner ───────────────────────────────────────────────────────

test('a packet inside the budget runs in ONE pass', () => {
  assert.strictEqual(P.fitsInOnePass(1000, 10000), true);
  assert.strictEqual(P.fitsInOnePass(9000, 10000), true, '90% is the line');
  assert.strictEqual(P.fitsInOnePass(9001, 10000), false);
  const built = P.buildSections(fixture());
  const passes = P.splitIntoPasses({ ...built, passCount: 1 });
  assert.strictEqual(passes.length, 1);
  assert.strictEqual(passes[0].sections.length, built.sections.length, 'one pass carries everything');
});

test('an over-budget packet splits, and each encounter keeps its own orders, results and documents', () => {
  // ONLY the two encounter groups, so a two-way split genuinely separates
  // them. With the full fixture's other dated rows both encounters land in
  // pass 1 quite correctly — that is the date ordering doing its job, and
  // asserting otherwise would be asserting the arithmetic rather than the
  // rule this test is about.
  const f = fixture({
    emr: { demographics: { age: 78 }, problems: [], medications: [], allergies: [] },
    intake: null, consentElections: null, carePlanVersions: [],
    prescriptions: [], medReconciliations: [], caregiverLogs: [], messageThreads: [],
    encounters: [
      { clientId: CLIENT, encounterUuid: 'e-old', date: '2024-01-01', note: 'old visit' },
      { clientId: CLIENT, encounterUuid: 'e-new', date: '2026-02-01', note: 'new visit' }
    ],
    orders: [
      { clientId: CLIENT, id: 'o-old', date: '2024-01-02', encounterUuid: 'e-old' },
      { clientId: CLIENT, id: 'o-new', date: '2026-02-02', encounterUuid: 'e-new' }
    ],
    results: [{ clientId: CLIENT, id: 'r-new', date: '2026-02-09', encounterUuid: 'e-new' }],
    documents: [
      { clientId: CLIENT, id: 'd-old', mimeType: 'application/pdf', bytes: Buffer.from('a'), date: '2024-01-03', encounterUuid: 'e-old' },
      { clientId: CLIENT, id: 'd-new', mimeType: 'application/pdf', bytes: Buffer.from('b'), date: '2026-02-05', encounterUuid: 'e-new' }
    ]
  });
  const built = P.buildSections(f);
  const passes = P.splitIntoPasses({ ...built, passCount: 2 });
  assert.strictEqual(passes.length, 2);

  const passWith = (id) => passes.find(p => p.sections.some(s => s.sourceId === id) || p.documents.some(d => d.sourceId === id));
  // A pass holding the result but not its encounter produces a finding
  // nobody can place.
  assert.strictEqual(passWith('enc:e-old'), passWith('order:o-old'), 'the old encounter keeps its order');
  assert.strictEqual(passWith('enc:e-old'), passWith('doc:d-old'), 'and its document');
  assert.strictEqual(passWith('enc:e-new'), passWith('order:o-new'), 'the new encounter keeps its order');
  assert.strictEqual(passWith('enc:e-new'), passWith('result:r-new'), 'and its result');
  assert.strictEqual(passWith('enc:e-new'), passWith('doc:d-new'), 'and its document');
  assert.notStrictEqual(passWith('enc:e-old'), passWith('enc:e-new'), 'the two encounters landed in different passes');
});

test('the header travels in EVERY pass', () => {
  const built = P.buildSections(fixture({
    encounters: Array.from({ length: 6 }, (_, i) => ({ clientId: CLIENT, encounterUuid: `e-${i}`, date: `2026-0${i + 1}-01`, note: `v${i}` }))
  }));
  const passes = P.splitIntoPasses({ ...built, passCount: 3 });
  assert.strictEqual(passes.length, 3);
  for (const p of passes) {
    for (const kind of P.HEADER_KINDS) {
      assert.ok(p.sections.some(s => s.sourceId === kind),
        `${kind} must be in pass ${p.pass} — a medication finding is wrong if the pass could not see the allergies`);
    }
    assert.strictEqual(p.of, 3, 'each pass knows how many there are, so "pass 2 of 3" means something');
  }
});

test('the CURRENT care plan travels in every pass; superseded versions do not', () => {
  const built = P.buildSections(fixture({
    emr: { demographics: { age: 78 }, problems: [], medications: [], allergies: [] },
    carePlanVersions: [
      { clientId: CLIENT, version: 1, effectiveDate: '2024-01-01', problems: ['old plan'] },
      { clientId: CLIENT, version: 3, effectiveDate: '2026-01-15', problems: ['current plan'] }
    ],
    encounters: Array.from({ length: 4 }, (_, i) => ({ clientId: CLIENT, encounterUuid: `e-${i}`, date: `2026-0${i + 1}-01` }))
  }));
  const passes = P.splitIntoPasses({ ...built, passCount: 2 });
  assert.strictEqual(passes.length, 2);
  for (const p of passes) {
    assert.ok(p.sections.some(s => s.sourceId === 'careplan:v3'),
      `what the plan says TODAY is context every finding needs (pass ${p.pass})`);
  }
  // v1 is history: it belongs to the pass its date falls in, not to all of them.
  const withV1 = passes.filter(p => p.sections.some(s => s.sourceId === 'careplan:v1'));
  assert.strictEqual(withV1.length, 1, 'a superseded version is not header context');
});

test('nothing is silently dropped by a split: every source lands in some pass', () => {
  const built = P.buildSections(fixture({
    encounters: Array.from({ length: 7 }, (_, i) => ({ clientId: CLIENT, encounterUuid: `e-${i}`, date: `2026-0${i + 1}-01` }))
  }));
  for (const n of [2, 3, 4, 5]) {
    const passes = P.splitIntoPasses({ ...built, passCount: n });
    const seen = new Set(passes.flatMap(p => [...p.sections, ...p.documents]).map(s => s.sourceId));
    for (const s of [...built.sections, ...built.documents]) {
      assert.ok(seen.has(s.sourceId), `${s.sourceId} vanished in a ${n}-way split`);
    }
  }
});

test('an undated group sorts last rather than being guessed a date', () => {
  const built = P.buildSections(fixture({
    encounters: [{ clientId: CLIENT, encounterUuid: 'e-undated' }, { clientId: CLIENT, encounterUuid: 'e-dated', date: '2026-01-01' }],
    orders: [], results: [], prescriptions: [], caregiverLogs: [], medReconciliations: [], messageThreads: [], documents: []
  }));
  const passes = P.splitIntoPasses({ ...built, passCount: 2 });
  const firstIds = passes[0].sections.map(s => s.sourceId);
  assert.ok(firstIds.includes('enc:e-dated'), 'the dated encounter comes first');
});

// ── E3: citation enforcement ──────────────────────────────────────────────

test('a finding whose citation does not resolve is DROPPED and counted', () => {
  const manifest = P.buildManifest({ sections: [{ sourceId: 'enc:e-1', kind: 'encounter', title: 'Visit' }] });
  const { output, droppedUncited } = P.enforceCitations({
    summary: 'ok',
    findings: [
      { statement: 'real', citations: [{ sourceId: 'enc:e-1', quote: 'fatigue' }] },
      { statement: 'invented source', citations: [{ sourceId: 'enc:NOPE' }] },
      { statement: 'no citation at all', citations: [] },
      { statement: 'citations missing entirely' },
      { statement: 'one good one bad', citations: [{ sourceId: 'enc:e-1' }, { sourceId: 'doc:ghost' }] }
    ],
    timeline: [
      { date: '2026-02-01', event: 'visit', citations: [{ sourceId: 'enc:e-1' }] },
      { date: '2026-02-02', event: 'ghost', citations: [{ sourceId: 'order:nope' }] }
    ]
  }, manifest);

  assert.deepStrictEqual(output.findings.map(f => f.statement), ['real'],
    'EVERY citation must resolve — one bad citation in a finding makes the finding uncheckable');
  assert.deepStrictEqual(output.timeline.map(t => t.event), ['visit']);
  assert.strictEqual(droppedUncited, 5, 'the count is surfaced so nobody wonders whether the list is complete');
  assert.strictEqual(output.summary, 'ok', 'the rest of the output is untouched');
});

test('a review with nothing citable comes back empty rather than unverifiable', () => {
  const manifest = P.buildManifest({ sections: [] });
  const { output, droppedUncited } = P.enforceCitations({
    findings: [{ statement: 'x', citations: [{ sourceId: 'anything' }] }], timeline: []
  }, manifest);
  assert.deepStrictEqual(output.findings, []);
  assert.strictEqual(droppedUncited, 1);
});
