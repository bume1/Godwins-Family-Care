'use strict';
/**
 * The shared clinical note: one draft per encounter, editable by anyone
 * writing on the chart until it is signed; every save stamped with its editor;
 * the last save never silently winning; carry-forward held for review; the
 * signature — author, clinician addendum, co-signatures — written into the note
 * itself (owner, 2026-09-27).
 *
 * The HTTP half is scripts/verify_note_lifecycle.js, through the real routes.
 * This file pins the pure rules those routes call, and the wiring that makes
 * the routes call them.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { PDFDocument } = require('pdf-lib');

const notes = require('../clinicalNotes');
const pdf = require('../pdf-generator');
const packetImport = require('../welcomePacketImport');

const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

const RN = { id: 'rn_1', name: 'Ruth Nolan', licenseLevel: 'RN', npi: null };
const FNP = { id: 'fnp_1', name: 'Bethel Godwins', licenseLevel: 'FNP', npi: '1234567893' };
const LMSW = { id: 'lmsw_1', name: 'Mara Shaw', licenseLevel: 'LMSW', npi: null };

const rev = (version, who, at, extra = {}) => ({ version, savedBy: who, savedAt: at, action: 'save', ...extra });

// ---- Concurrency ----------------------------------------------------------

test('a save against the current version is accepted', () => {
  const r = notes.checkNoteVersion({ noteVersion: 2 }, 2, rev(2, FNP, '2026-09-27T14:00:00Z'));
  assert.strictEqual(r.ok, true);
});

test('a stale save is refused, naming who saved first and when', () => {
  const r = notes.checkNoteVersion({ noteVersion: 2 }, 1, rev(2, FNP, '2026-09-27T14:00:00Z'));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'NOTE_CHANGED');
  assert.strictEqual(r.lastSavedBy.name, 'Bethel Godwins');
  assert.match(r.error, /Bethel Godwins saved this note/);
  assert.match(r.error, /Your changes are kept on screen/);
});

test('a save with no base version is refused — never treated as "latest wins"', () => {
  for (const base of [undefined, null, '', 'latest']) {
    const r = notes.checkNoteVersion({ noteVersion: 3 }, base, rev(3, RN, '2026-09-27T14:00:00Z'));
    assert.strictEqual(r.ok, false, `base ${JSON.stringify(base)} must not pass`);
  }
});

test('the save route runs the version check before it writes', () => {
  const src = stripComments(SERVER);
  const at = src.indexOf("app.put('/api/clinical/patients/:clientId/encounters/:euuid/note'");
  assert.ok(at > 0, 'the note save route exists');
  const body = src.slice(at, src.indexOf('\napp.', at + 10));
  const check = body.indexOf('checkNoteVersion(');
  const write = body.indexOf("db.set('encounter_billing'") > -1 ? body.indexOf("db.set('encounter_billing'") : body.indexOf('saveBillingRecord(');
  assert.ok(check > 0, 'the save route checks the version');
  assert.ok(write > check, 'and it checks BEFORE it writes');
  assert.match(body, /NOTE_CHANGED|version\.ok/, 'and it acts on the answer');
});

// ---- Revisions: who, when, which sections — never the text -------------

test('a revision records who saved and which sections changed, never the text', () => {
  const before = { kind: 'followup', assessment: 'Stable', plan: 'Same' };
  const after = { kind: 'followup', assessment: 'Improving on standing', plan: 'Same' };
  const changed = notes.changedKeys(before, after);
  assert.deepStrictEqual(changed, ['assessment']);
  const row = notes.buildNoteRevision({
    // The record carries the note, as it does in production — without it a
    // revision that copied the text would pass this test unseen.
    id: 'r1', record: { encounterUuid: 'e1', clientId: 'c1', note: after }, version: 2,
    actor: { id: FNP.id, name: FNP.name, email: 'f@x', role: 'user', licenseLevel: 'FNP' }, clinicalRole: 'provider', changed, action: 'save'
  });
  assert.strictEqual(row.savedBy.id, FNP.id);
  assert.strictEqual(row.savedBy.clinicalRole, 'provider');
  assert.deepStrictEqual(row.sectionsChanged, ['assessment']);
  assert.ok(!JSON.stringify(row).includes('Improving'), 'the revision must not carry the note text');
});

test('contributors are every editor once, in the order they first saved', () => {
  const list = notes.contributorsFrom([
    rev(1, RN, '2026-09-27T13:00:00Z'), rev(2, FNP, '2026-09-27T14:00:00Z'), rev(3, RN, '2026-09-27T15:00:00Z')
  ]);
  assert.deepStrictEqual(list.map(c => c.name), ['Ruth Nolan', 'Bethel Godwins']);
  assert.strictEqual(list[0].saves, 2);
  assert.strictEqual(list[0].lastAt, '2026-09-27T15:00:00Z');
});

// ---- Template sections are derived, never read from a stored field ------

test('completed sections are derived from what the note actually says', () => {
  const note = { kind: 'followup', chiefConcern: 'Fall', subjective: '', assessment: 'Orthostatic', plan: '', sections: { socialHistory: 'Lives alone' }, vitals: {}, hp: {} };
  const done = notes.deriveCompletedSections(note);
  assert.ok(done.includes('chiefComplaint'), 'chief concern answers the chief complaint');
  assert.ok(done.includes('assessment'));
  assert.ok(done.includes('socialHistory'), 'a section with its own box counts when filled');
  assert.ok(!done.includes('plan'), 'an empty field does not count');
  assert.ok(!done.includes('hpi'), 'an empty subjective does not answer the HPI');
});

test('a blank formatted field ("**  **") does not count as written', () => {
  const done = notes.deriveCompletedSections({ kind: 'followup', plan: '**  **', sections: { followUp: '- ' } });
  assert.ok(!done.includes('plan'));
  assert.ok(!done.includes('followUp'));
});

test('an order or a structured risk assessment satisfies its section', () => {
  const done = notes.deriveCompletedSections({ kind: 'followup' }, { ordersRxReferrals: true });
  assert.ok(done.includes('ordersRxReferrals'));
});

test('every sign-readiness call derives the sections — none reads the stored field alone', () => {
  const src = stripComments(SERVER);
  const reads = src.match(/completedSections:\s*[^,\n}]+/g) || [];
  assert.ok(reads.length >= 2, 'the readiness calls pass completedSections');
  const stored = src.match(/completedSections:\s*(ctx\.)?record\.completedSections\b(?!\s*\|\|)/g) || [];
  assert.deepStrictEqual(stored, [], 'a readiness call must not read record.completedSections directly — nothing writes it before signing');
  assert.ok((src.match(/deriveCompletedSections\(/g) || []).length >= 3, 'the sign route, the readiness preview and the note view all derive it');
});

// ---- Carry forward --------------------------------------------------------

const PRIOR = {
  kind: 'hp', chiefConcern: 'Fall', subjective: 'Dizzy', objective: '', assessment: 'Orthostatic', plan: 'Hold diuretic',
  sections: { socialHistory: 'Lives alone' }, vitals: { bpRightSys: '118', hr: '88' },
  hp: { systemsExam: { general: 'Alert' } }, visitDate: '2026-09-20'
};

test('carry-forward copies the whole note except vitals and the visit date', () => {
  const c = notes.carryForwardContent(PRIOR);
  assert.strictEqual(c.assessment, 'Orthostatic');
  assert.strictEqual(c.sections.socialHistory, 'Lives alone');
  assert.deepStrictEqual(c.hp.systemsExam, { general: 'Alert' }, 'exam findings carry (owner decision)');
  assert.deepStrictEqual(c.vitals, {}, 'vitals never carry');
  assert.strictEqual(c.visitDate, undefined, 'the visit date never carries');
  c.hp.systemsExam.general = 'changed';
  assert.strictEqual(PRIOR.hp.systemsExam.general, 'Alert', 'a copy, never a reference to the source note');
});

test('every carried field is held for review until edited or confirmed', () => {
  const content = notes.carryForwardContent(PRIOR);
  const note = { ...content, carriedForward: notes.buildCarriedForward({ fromEncounterUuid: 'e0', fromDate: '2026-09-20', content }) };
  const pending = notes.carriedPending(note);
  assert.ok(pending.includes('assessment') && pending.includes('hp.systemsExam') && pending.includes('sections.socialHistory'));
  assert.ok(!pending.includes('vitals'));

  const edited = { ...note, assessment: 'Improving' };
  assert.ok(!notes.carriedPending(edited).includes('assessment'), 'editing a field clears it');

  const confirmed = { ...note, carriedForward: { ...note.carriedForward, confirmed: ['plan'] } };
  assert.ok(!notes.carriedPending(confirmed).includes('plan'), 'confirming a field clears it');
  assert.ok(notes.carriedPending(confirmed).includes('assessment'), 'and only that field');
});

test('signing is refused while any carried field is unreviewed, and names them', () => {
  const content = notes.carryForwardContent(PRIOR);
  const note = { ...content, kind: 'followup', carriedForward: notes.buildCarriedForward({ fromEncounterUuid: 'e0', content }) };
  const r = notes.checkNoteForSigning(note);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'NOTE_CARRIED_FORWARD_UNREVIEWED');
  assert.match(r.error, /Assessment/);
});

test('a legacy OpenEMR note loses its header, vitals line, history and signature when carried', () => {
  const text = [
    '[GFC CLINICIAN] Ruth Nolan, RN', 'Documented by Ruth Nolan', 'Hold diuretic', 'VITALS — BP 118/70',
    'NOTE HISTORY — every saved draft, its editor and time:', '  v1  Ruth Nolan', '',
    '========================================', 'ELECTRONICALLY SIGNED', 'Signed by Ruth Nolan'
  ].join('\n');
  const out = notes.stripLegacyText(text);
  assert.strictEqual(out, 'Hold diuretic');
});

// ---- Vitals on an older note opened for editing (owner report, 2026-09-28) ----
// A note filed with the old buttons has no app copy; opening it seeds it from
// its OpenEMR text. Its vitals were dropped there, so whoever opened it saw
// blank vitals and their save rewrote the OpenEMR note without them.

const LEGACY_HP = {
  subjective: '[GFC CLINICIAN] Ruth Nolan, RN\n\nFeels steadier this week',
  objective: 'VITALS — BP right arm 130/80; BP left arm 128/—; HR 72; Temp 98.1; RR 16; SpO2 97; Wt —; Ht 66\n\n'
    + 'SYSTEMS EXAM:\nGeneral: Well appearing\nLung Sounds: Clear\n\nHOME-HAZARD INVENTORY:\nGrab Bars: no\nNotes: Loose rug',
  assessment: 'Stable',
  plan: 'Continue current medications\nRN Track assignment: A2 — needs ADL help\nDocumented by Ruth Nolan'
};
const LEGACY_FU = {
  subjective: '[GFC CLINICIAN] Bethel Godwins, FNP\n\nKnee pain',
  objective: 'VITALS — BP 118/70; HR —; Temp —; RR —; SpO2 96; Wt —; Ht —; Pain 3/10\n\nLungs clear',
  assessment: 'OA', plan: 'Ice\nDocumented by Bethel Godwins'
};

test('an older H&P opened for editing keeps its vitals, both arms, and opens as an H&P', () => {
  const n = notes.noteFromLegacyNarrative(LEGACY_HP);
  assert.strictEqual(n.kind, 'hp');
  assert.deepStrictEqual(n.vitals, { bpRightSys: '130', bpRightDia: '80', bpLeftSys: '128', hr: '72', temp: '98.1', rr: '16', spo2: '97', height: '66' });
  assert.deepStrictEqual(n.hp.systemsExam, { general: 'Well appearing', lungSounds: 'Clear' });
  assert.deepStrictEqual(n.hp.homeHazards, { grabBars: 'no', notes: 'Loose rug' });
  assert.deepStrictEqual(n.hp.triage, { track: 'A2', rationale: 'needs ADL help' });
  assert.doesNotMatch(n.objective, /SYSTEMS EXAM|VITALS|Lung Sounds/, 'the exam blocks moved into their boxes, not duplicated in Objective');
  assert.doesNotMatch(n.plan, /RN Track|Documented by/);
  assert.match(n.plan, /Continue current medications/);
});

test('an older follow-up keeps its vitals and stays a follow-up', () => {
  const n = notes.noteFromLegacyNarrative(LEGACY_FU);
  assert.strictEqual(n.kind, 'followup');
  assert.deepStrictEqual(n.vitals, { bpSys: '118', bpDia: '70', spo2: '96', pain: '3' });
  assert.strictEqual(n.objective, 'Lungs clear');
  assert.deepStrictEqual(n.hp, {});
});

test('the initial visit opens as an H&P even when its BP line was left blank', () => {
  const soap = { objective: 'VITALS — BP —/—; HR 70; Temp —; RR —; SpO2 —; Wt —; Ht —', plan: 'x' };
  assert.strictEqual(notes.noteFromLegacyNarrative(soap).kind, 'followup');
  assert.strictEqual(notes.noteFromLegacyNarrative(soap, undefined, { isInitialVisit: true }).kind, 'hp');
});

test('a note with no vitals line reads back as no vitals, not as an error', () => {
  assert.deepStrictEqual(notes.parseLegacyVitals('Lungs clear'), {});
  assert.deepStrictEqual(notes.parseLegacyVitals(''), {});
});

test('a telehealth vitals line from a shared note parses too', () => {
  const line = notes.vitalsLine({ vitals: { bpSys: '120', bpDia: '80', hr: '64' }, visit: { modality: 'telehealth' } });
  assert.deepStrictEqual(notes.parseLegacyVitals(line), { bpSys: '120', bpDia: '80', hr: '64' });
});

test('the server tells the parser which encounter was the initial visit', () => {
  const src = stripComments(SERVER);
  assert.match(src, /noteFromLegacyNarrative\(cur, record\.noteKind, \{ isInitialVisit \}\)/);
});

// ---- Draft vitals in the chart before signing (owner decision, 2026-09-28) ----

const draftRecord = (extra = {}) => ({
  encounterUuid: 'enc_1', date: '2026-09-27', noteStatus: 'draft',
  note: { kind: 'followup', visitDate: '2026-09-27', vitals: { bpSys: '118', bpDia: '70', hr: '72', pain: '3' } }, ...extra
});

test('an unsigned draft\'s vitals become chart rows, each marked draft', () => {
  const rows = notes.draftVitalsRows(draftRecord());
  assert.deepStrictEqual(rows.map(r => r.name), ['Blood pressure', 'Heart rate', 'Pain score']);
  assert.ok(rows.every(r => r.draft === true && r.at === '2026-09-27' && r.encounterUuid === 'enc_1'));
  assert.strictEqual(rows[0].value, '118/70 mmHg');
});

test('an H&P draft shows both arms on one row', () => {
  const rows = notes.draftVitalsRows(draftRecord({ note: { kind: 'hp', vitals: { bpRightSys: '130', bpRightDia: '80', bpLeftSys: '128', bpLeftDia: '78' } } }));
  assert.strictEqual(rows[0].value, 'right 130/80 · left 128/78');
});

test('draft vitals drop out once signed, once written to OpenEMR, or when discarded', () => {
  assert.strictEqual(notes.draftVitalsRows(draftRecord({ noteStatus: 'signed' })).length, 0);
  assert.strictEqual(notes.draftVitalsRows(draftRecord({ noteStatus: 'voided' })).length, 0);
  assert.strictEqual(notes.draftVitalsRows(draftRecord({ vitalsWrittenAt: '2026-09-27T15:00:00Z' })).length, 0);
  assert.strictEqual(notes.draftVitalsRows(draftRecord({ note: { kind: 'followup', vitals: {} } })).length, 0);
  assert.strictEqual(notes.draftVitalsRows({ encounterUuid: 'x', noteStatus: 'draft' }).length, 0);
});

test('an older note\'s unchanged vitals are not sent to OpenEMR a second time at signing', () => {
  const v = { bpSys: '118', bpDia: '70' };
  assert.strictEqual(notes.vitalsNeedRow({ note: { vitals: v }, legacyVitals: { ...v } }), false);
  assert.strictEqual(notes.vitalsNeedRow({ note: { vitals: { ...v, hr: '80' } }, legacyVitals: v }), true, 'changed readings get a new row');
  assert.strictEqual(notes.vitalsNeedRow({ note: { vitals: v } }), true, 'a new-style note writes its row');
  assert.strictEqual(notes.vitalsNeedRow({ note: { vitals: {} } }), false);
});

test('the chart and My Day both read draft vitals, and signing checks the older note\'s readings', () => {
  const src = stripComments(SERVER);
  // (Read raw: the crude comment stripper swallows this stretch of server.js
  // through a "/*" inside a string earlier on.)
  assert.match(SERVER, /\n\s+draftVitals: await draftVitalsFor\(client\.id\)/);
  assert.match(src, /const drafts = await draftVitalsFor\(client\.id\);/);
  assert.match(src, /record\.legacyVitals && !clinicalNotes\.vitalsNeedRow\(record\)/);
  assert.match(src, /if \(lv && Object\.keys\(lv\)\.length\) record\.legacyVitals = lv;/);
});

test('the page labels draft vitals and never decides for itself which ones are drafts', () => {
  const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'clinical.html'), 'utf8');
  assert.match(page, /chart\.draftVitals/);
  assert.match(page, /k\.lastVitals\.draft && <DraftVitalsChip \/>/);
  assert.match(page, /Draft — not yet in OpenEMR/);
});

// ---- Signing rules that moved from save to sign --------------------------

test('an H&P can be SAVED without both arms but not SIGNED without them', () => {
  const s = notes.sanitizeNote({ kind: 'hp', chiefConcern: 'Fall', vitals: { bpRightSys: '118', bpRightDia: '70' } });
  assert.ok(!s.error, 'saving a half-finished H&P is allowed');
  const r = notes.checkNoteForSigning(s.note);
  assert.strictEqual(r.code, 'HP_BP_BOTH_ARMS');
  const both = notes.checkNoteForSigning({ ...s.note, vitals: { ...s.note.vitals, bpLeftSys: '112', bpLeftDia: '68' } });
  assert.strictEqual(both.ok, true);
});

test('the visit picked at the top of the note survives sanitizing', () => {
  const s = notes.sanitizeNote({ kind: 'hp', chiefConcern: 'Fall', visit: { appointmentType: 'pc_new_patient', modality: 'telehealth', location: 'home', extra: 'x' } });
  assert.deepStrictEqual(s.note.visit, { appointmentType: 'pc_new_patient', modality: 'telehealth', location: 'home' });
});

// ---- The signature block ---------------------------------------------------

const AUTHOR_ATT = { signedAt: '2026-09-27T15:00:00Z', signedBy: RN, signedByClinicalRole: 'rn', coSignStatus: 'pending' };

test('an author signature is marked as such and says it is awaiting the clinician addendum', () => {
  const summary = notes.buildSignatureSummary({ attestation: AUTHOR_ATT, record: { coSignStatus: 'pending' } });
  const text = notes.signatureBlockLines(summary).join('\n');
  assert.match(text, /ELECTRONICALLY SIGNED/);
  assert.match(text, /Signed by Ruth Nolan, RN — AUTHOR \(not a billing signature\)/);
  assert.match(text, /AWAITING CLINICIAN ADDENDUM/);
});

test('after the addendum the block names both people and every co-signer', () => {
  const record = {
    coSignStatus: 'cleared', coSignedBy: FNP, coSignedAt: '2026-09-27T16:00:00Z',
    coSignatures: [{ ...LMSW, at: '2026-09-27T17:00:00Z' }, { name: 'Lena Cole', licenseLevel: 'LCSW', at: '2026-09-27T17:30:00Z' }]
  };
  const text = notes.signatureBlockLines(notes.buildSignatureSummary({ attestation: { ...AUTHOR_ATT, coSignStatus: 'cleared' }, record })).join('\n');
  assert.match(text, /Signed by Ruth Nolan, RN — AUTHOR/);
  assert.match(text, /Clinician addendum and billing signature: Bethel Godwins, FNP \(NPI 1234567893\)/);
  assert.match(text, /Co-signed by Mara Shaw, LMSW/);
  assert.match(text, /Co-signed by Lena Cole, LCSW/);
  assert.doesNotMatch(text, /AWAITING/);
});

test('a provider who signs directly is the billing signature, not an author', () => {
  const summary = notes.buildSignatureSummary({ attestation: { signedAt: '2026-09-27T15:00:00Z', signedBy: FNP, signedByClinicalRole: 'provider' }, record: { coSignStatus: 'not_required' } });
  assert.strictEqual(summary.signer.capacity, 'billing');
  assert.doesNotMatch(notes.signatureBlockLines(summary).join('\n'), /AUTHOR/);
});

// ---- The OpenEMR narrative -------------------------------------------------

test('the OpenEMR narrative keeps structure, drops formatting markers, and ends with history then signature', () => {
  const note = { kind: 'followup', chiefConcern: '**Fall** at home', subjective: '## History\n- dizzy for _two days_', assessment: 'Orthostatic', plan: '1. Hold diuretic', sections: {}, vitals: {}, hp: {} };
  const out = notes.composeNarrative({
    note, revisions: [rev(1, RN, '2026-09-27T13:00:00Z')],
    signature: notes.buildSignatureSummary({ attestation: AUTHOR_ATT, record: { coSignStatus: 'pending' } })
  });
  const all = Object.values(out).join('\n');
  assert.match(out.subjective, /Chief concern: Fall at home/);
  assert.match(out.subjective, /HISTORY/);
  assert.match(out.subjective, /• dizzy for two days/);
  assert.doesNotMatch(all, /\*\*|__|_two/);
  const hist = out.plan.indexOf('NOTE HISTORY');
  const sig = out.plan.indexOf('ELECTRONICALLY SIGNED');
  assert.ok(hist > 0 && sig > hist, 'the signature is the last thing in the note');
});

test('a discarded draft says so in words and carries no clinical content', () => {
  const out = notes.composeNarrative({ note: { assessment: 'something clinical' }, voided: { by: RN, at: '2026-09-27T13:00:00Z', reason: 'Wrong patient' } });
  assert.match(out.subjective, /Draft discarded by Ruth Nolan, RN — .* — Wrong patient/);
  assert.doesNotMatch(Object.values(out).join('\n'), /something clinical/);
});

test('signing a legacy note appends the signature once, replacing any earlier block', () => {
  const summary = notes.buildSignatureSummary({ attestation: { signedAt: '2026-09-27T15:00:00Z', signedBy: FNP }, record: {} });
  const once = notes.appendSignatureToLegacyPlan('Hold diuretic', summary);
  const twice = notes.appendSignatureToLegacyPlan(once, summary);
  assert.strictEqual((twice.match(/ELECTRONICALLY SIGNED/g) || []).length, 1);
  assert.match(twice, /^Hold diuretic/);
});

// ---- The signed-note PDF --------------------------------------------------

const pdfText = async (buffer) => {
  const doc = await PDFDocument.load(buffer);
  return (await packetImport.extractRuns(doc)).map(r => r.text).join(' ');
};

test('the signed-note PDF carries the note, the signer and every co-signer', async () => {
  const note = { kind: 'followup', chiefConcern: '**Fall** at home', assessment: 'Orthostatic hypotension', plan: '1. Hold diuretic', sections: {}, vitals: {}, hp: {} };
  const record = { coSignStatus: 'cleared', coSignedBy: FNP, coSignedAt: '2026-09-27T16:00:00Z', coSignatures: [{ ...LMSW, at: '2026-09-27T17:00:00Z' }] };
  const buf = await pdf.generateSignedNotePDF({
    patientName: 'Test Patient', dob: '1948-03-11', visitDate: '2026-09-27', visitLabel: 'Follow-up', encounterId: '101',
    items: notes.noteReadingOrder(note),
    signature: notes.buildSignatureSummary({ attestation: { ...AUTHOR_ATT, coSignStatus: 'cleared' }, record }),
    person: (p) => `${p.name}${p.licenseLevel ? `, ${p.licenseLevel}` : ''}`,
    history: [rev(1, RN, '2026-09-27T13:00:00Z')], addenda: [], voided: null
  });
  assert.strictEqual(buf.slice(0, 5).toString(), '%PDF-');
  const text = (await pdfText(buf)).replace(/\s+/g, ' ');
  assert.match(text, /Orthostatic hypotension/);
  assert.match(text, /ELECTRONICALLY SIGNED/);
  assert.match(text, /Ruth Nolan, RN/);
  assert.match(text, /Bethel Godwins, FNP/);
  assert.match(text, /Mara Shaw, LMSW/);
  assert.doesNotMatch(text, /\*\*Fall/, 'formatting markers never print');
});

test('the PDF signature block is drawn in bold', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'pdf-generator.js'), 'utf8');
  const at = src.indexOf('async function generateSignedNotePDF');
  const body = src.slice(at, src.indexOf('\nasync function', at + 10) > 0 ? src.indexOf('\nasync function', at + 10) : undefined);
  const block = body.slice(body.indexOf("'ELECTRONICALLY SIGNED'") - 200);
  assert.match(block, /font\('Helvetica-Bold'\)[^\n]*\.text\('ELECTRONICALLY SIGNED'/);
  assert.match(block, /for \(const l of lines\)[\s\S]{0,200}font\('Helvetica-Bold'\)/, 'every signature line is bold');
});
