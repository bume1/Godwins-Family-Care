'use strict';

// The onboarding catalog: references into the Drive source documents, never
// their content. See onboarding/sources.js.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { SOURCES, ref, driveViewUrl } = require('../onboarding/sources');
const V = require('../onboarding/vocabulary');
const C = require('../onboarding/chapterC');
const { MODULES, SOP_MANUAL_REFS, SOP_PLANNED } = require('../onboarding/modules');
const VF = require('../onboarding/versionFlags');

const DIR = path.join(__dirname, '..', 'onboarding');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/.*$/gm, '$1');

test('every source carries a Drive file id and a transcribed-from version', () => {
  for (const s of Object.values(SOURCES)) {
    assert.match(s.driveFileId, /^[A-Za-z0-9_-]{20,}$/, s.key);
    assert.match(s.transcribedFromVersion, /^\d+\.\d+$/, s.key);
  }
  assert.match(driveViewUrl('CLINICAL_MANUAL'), /^https:\/\/drive\.google\.com\/file\/d\/1LBCQ/);
  assert.throws(() => ref('NOPE', '1'), /Unknown onboarding source/);
  assert.throws(() => ref('PLAYBOOK', ''), /needs a section/);
});

test('no onboarding module reads a document from docs/ (Drive governs, GFC-WIZ-PROMPT §2)', () => {
  for (const f of fs.readdirSync(DIR)) {
    const code = stripComments(fs.readFileSync(path.join(DIR, f), 'utf8'));
    assert.doesNotMatch(code, /docs\//, `${f} references docs/`);
  }
});

test('classification phrases parse to document classes, and an unknown phrase is refused', () => {
  assert.deepStrictEqual(V.parseClassification('Statutory and regulatory'), ['STATUTORY', 'REGULATORY']);
  assert.deepStrictEqual(V.parseClassification('  Accreditation   standard '), ['ACCREDITATION']);
  assert.throws(() => V.parseClassification('Federal law'), (e) => e.code === 'CLASSIFICATION_UNKNOWN');
  assert.throws(() => V.classification('Regulatory', 'row', null), /no source reference/);
});

test('only statutory or regulatory classes read as a legal requirement', () => {
  const P = ref('PLAYBOOK', 'C.2');
  assert.strictEqual(V.isLegalRequirement(V.classification('Internal policy', 'x', P)), false);
  assert.strictEqual(V.isLegalRequirement(V.classification('Accreditation standard', 'x', P)), false);
  assert.strictEqual(V.isLegalRequirement(V.classification('Recommended practice', 'x', P)), false);
  assert.strictEqual(V.isLegalRequirement(V.classification('Regulatory and internal policy', 'x', P)), true);
});

test('Chapter C items: unique ids, known phases, valid actors, every step says where its actor came from', () => {
  const phases = new Set(C.PHASES.map(p => p.id));
  const ids = new Set();
  for (const it of C.ITEMS) {
    assert.ok(!ids.has(it.id), `duplicate ${it.id}`); ids.add(it.id);
    assert.ok(phases.has(it.phase), `${it.id} phase ${it.phase}`);
    assert.ok(it.id.startsWith(it.phase + '.'), `${it.id} not numbered under its phase`);
    if (it.addedBy) {
      // An owner addition cites the manual section that requires it, or
      // nothing; never the Playbook, which does not list it.
      assert.ok(it.ref === null || it.ref.source === 'CLINICAL_MANUAL', `${it.id} owner addition cites ${it.ref && it.ref.source}`);
      assert.match(it.addedBy, /Owner addition/);
    } else {
      assert.strictEqual(it.ref.source, 'PLAYBOOK', it.id);
    }
    assert.ok(it.steps.length >= 1, it.id);
    for (const s of it.steps) {
      assert.ok(Object.values(V.ACTORS).includes(s.actor), `${it.id} actor ${s.actor}`);
      assert.ok(Object.values(V.ACTIONS).includes(s.action), `${it.id} action ${s.action}`);
      assert.ok(['STATED', 'INFERRED', 'OWNER_CONFIRMED'].includes(s.actorBasis), `${it.id} actorBasis`);
    }
  }
});

test('an item either carries the document\'s classification or says the table has no row; never one we assigned', () => {
  for (const it of C.ITEMS) {
    assert.ok(Array.isArray(it.classifications), it.id);
    if (!it.classifications.length) {
      assert.ok(it.classificationNote && it.classificationNote.length > 10, `${it.id} unclassified with no note`);
    }
    for (const c of it.classifications) {
      assert.ok(['PLAYBOOK', 'CLINICAL_MANUAL'].includes(c.from.source), `${it.id} classification source`);
      assert.ok(c.row && c.phrase, it.id);
    }
  }
});

test('C.6.05 carries BOTH documents\' classification of the Schedule I/II prohibition, each with its source', () => {
  const it = C.ITEMS.find(i => i.id === 'C.6.05');
  const bySource = Object.fromEntries(it.classifications.map(c => [c.from.source + ':' + c.from.section, c.phrase]));
  assert.strictEqual(bySource['PLAYBOOK:C.2'], 'Statutory');
  assert.strictEqual(bySource['CLINICAL_MANUAL:1.6'], 'Statutory and regulatory');
});

test('the new hire is a party to collaborative onboarding: she acts on her own items', () => {
  const hers = C.ITEMS.filter(it => it.steps.some(s => s.actor === V.ACTORS.NEW_HIRE));
  assert.ok(hers.length >= 15, `only ${hers.length} items involve her`);
  // Where her submission is followed by a verification, the verifier is office.
  for (const it of hers) {
    const i = it.steps.findIndex(s => s.actor === V.ACTORS.NEW_HIRE);
    const after = it.steps.slice(i + 1);
    for (const s of after.filter(x => x.action === V.ACTIONS.VERIFY)) {
      assert.ok(V.OFFICE_ACTORS.includes(s.actor), `${it.id}: verification by ${s.actor}`);
    }
  }
});

test('clinicians acknowledge Clinical P&P 2.2, the version in Drive, and the Playbook\'s 2.0 stays visible', () => {
  const ack = C.ACKNOWLEDGMENTS.find(a => a.id === 'CLINICAL_MANUAL');
  assert.strictEqual(ack.version, '2.2');
  assert.strictEqual(ack.version, SOURCES.CLINICAL_MANUAL.transcribedFromVersion);
  assert.strictEqual(ack.playbookStates, '2.0');
  assert.match(ack.versionSetBy, /Owner decision/);
});

test('C.8 determinations are the Playbook\'s four service lines, each recorded by a named owner', () => {
  assert.deepStrictEqual(C.DETERMINATIONS.map(d => d.id), ['IME', 'PRIVATE_PAY', 'INSURED', 'BEHAVIORAL']);
  assert.deepStrictEqual(C.DETERMINATIONS.map(d => d.id), V.DETERMINATIONS.slice());
  for (const d of C.DETERMINATIONS) assert.strictEqual(d.recordedBy, V.ACTORS.READINESS_OWNER);
  assert.strictEqual(C.DETERMINATIONS.find(d => d.id === 'IME').openItem, 'NON_PRESCRIBING_PROTOCOL');
});

test('C.9 recurring rows carry the table\'s own classification', () => {
  const byId = Object.fromEntries(C.RECURRING.map(r => [r.id, r.classification.phrase]));
  assert.strictEqual(byId['C.9.R1'], 'Recommended practice');
  assert.strictEqual(byId['C.9.R4'], 'Accreditation standard');
  assert.strictEqual(byId['C.9.R5'], 'Regulatory and internal policy');
  assert.strictEqual(byId['C.9.R7'], 'Regulatory');
});

test('module ids are the Library\'s and are never renumbered', () => {
  const ids = MODULES.map(m => m.id);
  assert.strictEqual(new Set(ids).size, ids.length);
  const expected = ['TRN-101', 'TRN-102', 'TRN-103', 'TRN-104', 'TRN-105', 'TRN-106',
    'TRN-001', 'TRN-002', 'TRN-003', 'TRN-004', 'TRN-005', 'TRN-006', 'TRN-007', 'TRN-008',
    ...Array.from({ length: 20 }, (_, i) => `TRN-2${String(i + 1).padStart(2, '0')}`),
    'TRN-301', 'TRN-302', 'TRN-303', 'TRN-304', 'TRN-401', 'TRN-402', 'TRN-403', 'TRN-404', 'TRN-405'];
  assert.deepStrictEqual(ids, expected);
});

test('every module phase is a Chapter C phase, and required_for parses', () => {
  const phases = new Set(C.PHASES.map(p => p.id));
  for (const m of MODULES) {
    assert.ok(phases.has(m.phase), `${m.id} ${m.phase}`);
    for (const r of m.requiredFor) assert.ok(['phase', 'determination', 'privilege'].includes(r.kind));
  }
  assert.throws(() => V.parseRequiredFor('gate:G2'), /Unrecognised/);
  assert.throws(() => V.parseRequiredFor('phase:4'), /chapter-scoped/);
});

test('modules hold references, not content: no check questions or answers in source', () => {
  const code = stripComments(fs.readFileSync(path.join(DIR, 'modules.js'), 'utf8'));
  assert.doesNotMatch(code, /\banswer\s*:/);
  assert.doesNotMatch(code, /\bprompt\s*:/);
  assert.doesNotMatch(code, /\bchecks\s*:/);
});

test('manual references come from the Library, or from the SOP table and are marked as derived', () => {
  for (const m of MODULES) {
    if (m.manualRefsBasis === 'DERIVED_FROM_SOP') {
      const fromSops = new Set(m.sopRefs.flatMap(s => SOP_MANUAL_REFS[s]));
      assert.deepStrictEqual(new Set(m.manualRefs), fromSops, m.id);
    }
  }
  assert.strictEqual(MODULES.find(m => m.id === 'TRN-206').manualRefsBasis, 'LIBRARY');
  assert.strictEqual(MODULES.find(m => m.id === 'TRN-209').manualRefsBasis, 'DERIVED_FROM_SOP');
});

// ---- the acceptance test (GFC-WIZ-PROMPT §3) -------------------------------
test('ACCEPTANCE: on first run against manual v2.2, TRN-206, 207 and 208 flag on their sections, and TRN-006 on any change', () => {
  const results = VF.evaluateAll(MODULES, { currentVersion: '2.2' });
  const flagged = results.filter(r => r.status === VF.STATUS.FLAGGED);
  assert.deepStrictEqual(flagged.map(r => r.moduleId).sort(), ['TRN-006', 'TRN-206', 'TRN-207', 'TRN-208']);
  assert.deepStrictEqual(flagged.find(r => r.moduleId === 'TRN-206').hits, ['11.4']);
  assert.deepStrictEqual(flagged.find(r => r.moduleId === 'TRN-207').hits, ['12.4']);
  assert.deepStrictEqual(flagged.find(r => r.moduleId === 'TRN-208').hits, ['12.3']);
  const six = flagged.find(r => r.moduleId === 'TRN-006');
  assert.strictEqual(six.basis, 'OWNER_DECISION_ANY_CHANGE');
  assert.deepStrictEqual(six.hits.slice().sort(), ['11.4', '12.3', '12.4']);
});

test('the seeded change list cites Training Library §2.2 as its source', () => {
  const s = VF.SEEDED_CHANGES[0];
  assert.strictEqual(s.source.source, 'TRAINING_LIBRARY');
  assert.strictEqual(s.source.section, '2.2');
  assert.strictEqual(s.basis, 'STATED_IN_SOURCE');
});

test('a module with no confirmed manual references reads PENDING, never cleared by silence', () => {
  const results = VF.evaluateAll(MODULES, { currentVersion: '2.2' });
  for (const r of results) {
    const m = MODULES.find(x => x.id === r.moduleId);
    if (!m.manualRefs.length && !m.flagsOnAnyManualChange) assert.strictEqual(r.status, VF.STATUS.PENDING, m.id);
  }
});

test('every pending module carries proposed sections: SOP Set 2\'s planned table first, else a draft for the Clinical Director', () => {
  for (const m of MODULES.filter(x => !x.manualRefs.length && !x.flagsOnAnyManualChange)) {
    assert.ok(Array.isArray(m.proposedManualRefs), `${m.id} has no proposed references`);
    assert.ok(['SOP_SET2_PLANNED', 'DRAFT_FOR_CLINICAL_DIRECTOR'].includes(m.proposedBasis), m.id);
  }
  const t210 = MODULES.find(m => m.id === 'TRN-210');
  assert.strictEqual(t210.plannedSop, 'SOP-EMR-01');
  assert.strictEqual(t210.proposedBasis, 'SOP_SET2_PLANNED');
  assert.strictEqual(MODULES.find(m => m.id === 'TRN-220').proposedBasis, 'DRAFT_FOR_CLINICAL_DIRECTOR');
  assert.deepStrictEqual(t210.proposedManualRefs, ['18.1']);
  for (const [sop, p] of Object.entries(SOP_PLANNED)) assert.strictEqual(MODULES.find(m => m.id === p.module).plannedSop, sop);
});

test('a proposed reference never drives the flag until confirmed; a confirmed one does', () => {
  const m = MODULES.find(x => x.id === 'TRN-210');
  const log = [{ document: 'CLINICAL_MANUAL', from: '2.2', to: '2.3', changedSections: ['18.1'] }];
  assert.strictEqual(VF.evaluateModule(m, { currentVersion: '2.3', reviewedAgainst: '2.2', changeLog: log }).status, VF.STATUS.PENDING);
  assert.strictEqual(VF.evaluateModule(m, { currentVersion: '2.3', reviewedAgainst: '2.2', changeLog: log, confirmedManualRefs: ['18.1'] }).status, VF.STATUS.FLAGGED);
});

test('TRN-006 flags on every manual reissue, whatever section changed (owner decision)', () => {
  const m = MODULES.find(x => x.id === 'TRN-006');
  assert.strictEqual(m.flagsOnAnyManualChange, true);
  const log = [{ document: 'CLINICAL_MANUAL', from: '2.2', to: '2.3', changedSections: ['26.3'] }];
  assert.strictEqual(VF.evaluateModule(m, { currentVersion: '2.3', reviewedAgainst: '2.2', changeLog: log }).status, VF.STATUS.FLAGGED);
});

test('a review recorded against the current version clears the flag; an unknown hop does not', () => {
  const m = MODULES.find(x => x.id === 'TRN-207');
  assert.strictEqual(VF.evaluateModule(m, { currentVersion: '2.2', reviewedAgainst: '2.2' }).status, VF.STATUS.CURRENT);
  assert.strictEqual(VF.evaluateModule(m, { currentVersion: '2.3', reviewedAgainst: '2.2' }).status, VF.STATUS.CHANGES_UNKNOWN);
});

test('section references: chapters, sections and single-chapter ranges', () => {
  assert.ok(VF.refCovers('12', '12.3'));
  assert.ok(VF.refCovers('11.1-11.7', '11.4'));
  assert.ok(!VF.refCovers('11.1-11.4', '11.5'));
  assert.ok(!VF.refCovers('12.4', '12.3'));
  assert.ok(VF.refCovers('10.7', '10.7'));
  assert.ok(!VF.refCovers('1', '11.4'));
  assert.throws(() => VF.refCovers('11.1-12.2', '11.4'), /one chapter/);
});

test('fingerprints catch a wording change in one section and ignore a reflow', () => {
  const a = '12 MEDICATION\n12.3 Controlled Substances\nSchedule III through V.\n12.4 Refills\nThree months.';
  const reflow = '12 MEDICATION\n12.3 Controlled Substances\nSchedule III   through V.\n\n12.4 Refills\nThree months.';
  const edited = '12 MEDICATION\n12.3 Controlled Substances\nSchedule III through V.\n12.4 Refills\nTwelve months.';
  const fa = VF.fingerprintSections(a);
  assert.deepStrictEqual(Object.keys(fa).sort(), ['12', '12.3', '12.4']);
  assert.deepStrictEqual(VF.diffFingerprints(fa, VF.fingerprintSections(reflow)), []);
  assert.deepStrictEqual(VF.diffFingerprints(fa, VF.fingerprintSections(edited)), ['12.4']);
});

test('the version is read from a control table, never a filename', () => {
  assert.strictEqual(VF.readControlVersion('| Document number | GFC-CLIN-v2.2 |\n| Version | 2.2 |'), '2.2');
  assert.strictEqual(VF.readControlVersion('GFC_Clinical_Policies_v2.2.docx'), null);
});

test('owner additions: TB, immunizations, driving, self-reporting, pharmacology and telehealth are on the checklist; Hep B is not', () => {
  const added = C.ITEMS.filter(i => i.addedBy).map(i => i.title);
  for (const t of ['Tuberculosis screening', 'Immunization record', "Driver's license and personal auto insurance",
    'Twenty-four hour self-reporting duty acknowledged', 'Annual pharmacology training documented']) assert.ok(added.includes(t), t);
  assert.ok(!C.ITEMS.some(i => /hepatitis/i.test(i.title)));
  assert.strictEqual(C.ITEMS.find(i => i.id === 'C.6.10').ref.section, '16.5');
});

test('every actor the owner confirmed reads OWNER_CONFIRMED; only owner additions are still INFERRED', () => {
  for (const it of C.ITEMS) for (const s of it.steps) {
    if (s.actorBasis === 'INFERRED') assert.ok(it.addedBy, `${it.id} still inferred`);
  }
});

test('every phase and service line has a plain label and number for the screens; the Playbook id stays a reference', () => {
  C.PHASES.forEach((p, i) => {
    assert.strictEqual(p.number, i + 1);
    assert.ok(p.label && p.plainWhen, p.id);
    assert.doesNotMatch(p.label + p.plainWhen, /\bC\.\d/, `${p.id} label shows a Playbook code`);
  });
  for (const d of C.DETERMINATIONS) assert.ok(d.label && !/\bC\.\d/.test(d.label), d.id);
});

test('readiness gates sit under GFC\'s three service lines, never presented as lines of their own', () => {
  assert.deepStrictEqual(C.SERVICE_LINES.map(l => l.label), ['Veteran Exams (IME)', 'In-Home Primary and Psych Care', 'Private Home Care']);
  const by = Object.fromEntries(C.DETERMINATIONS.map(d => [d.id, d.serviceLine]));
  assert.deepStrictEqual(by, { IME: 'VETERAN_EXAMS', PRIVATE_PAY: 'IN_HOME_PRIMARY_PSYCH', INSURED: 'IN_HOME_PRIMARY_PSYCH', BEHAVIORAL: 'IN_HOME_PRIMARY_PSYCH' });
});

test('acknowledged documents link their canonical copies in Policies / Current, never #260\'s duplicates', () => {
  const ids = C.ACKNOWLEDGMENTS.flatMap(a => a.driveFileIds || []);
  assert.ok(ids.includes('1LBCQ-OHx1x6be9TfiXOTg7-O0a3-rwN6'), 'Clinical P&P v2.2');
  assert.ok(!ids.includes('1R9PhvBNaqmebOKKm_i6kPbGd5DK0OAVU'), 'the superseded Clinical P&P v2.0 copy');
  assert.ok(!ids.includes('1ZOdrECrlD1C7k5byIyE77K5XFT7fypz3bEnBbvHV-eU'), 'the Employee Handbook duplicate');
});
