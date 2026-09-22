// test/clinical_note_drafts.test.js — H&P drafts, the three note actions, and
// the facility-assignment screen (2026-09-22).
//
// Two defects are pinned here, and both were invisible from the code alone:
//
//   1. The H&P had ONE button reading "Sign & write to chart" which performed
//      NO attestation. On a clinical record, telling a clinician they signed
//      when they did not is the whole failure — so the labels are asserted.
//   2. `PUT /api/clinical/patients/:clientId/facility` existed with no caller
//      anywhere in the app, so every patient stayed unassigned and every
//      encounter blocked at signing. A route with no screen is a capability
//      that does not exist, and this repo has paid for that shape repeatedly.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const R = require('../clinicalRepository.js');
const ROOT = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const clinicalPage = fs.readFileSync(path.join(ROOT, 'public', 'clinical.html'), 'utf8');
const migration = fs.readFileSync(path.join(ROOT, 'dataMigration.js'), 'utf8');

const fullDraft = () => ({
  chiefConcern: 'Follow-up on wound',
  subjective: 'Patient reports less pain.',
  assessment: 'Healing well.',
  plan: 'Continue dressing changes.',
  vitals: { bpRightSys: '128', bpRightDia: '78', hr: '72' },
  systemsExam: { general: 'Alert', cardiovascular: 'RRR' },
  skinWound: { findings: 'Granulating', woundPresent: 'yes' },
  triage: { track: 'B', rationale: 'Skilled nursing need' },
  confirmedFields: ['allergies', 'medications']
});

// ── sanitizeNoteDraft ────────────────────────────────────────────────────

test('a draft keeps the H&P content it was given', () => {
  const { draft, error } = R.sanitizeNoteDraft(fullDraft());
  assert.ok(!error, error);
  assert.strictEqual(draft.chiefConcern, 'Follow-up on wound');
  assert.strictEqual(draft.assessment, 'Healing well.');
  assert.strictEqual(draft.vitals.bpRightSys, '128');
  assert.strictEqual(draft.systemsExam.cardiovascular, 'RRR');
  assert.strictEqual(draft.triage.track, 'B');
  assert.deepStrictEqual(draft.confirmedFields, ['allergies', 'medications']);
});

// THE point of a draft. buildHpWrites refuses a note without both arms; a
// draft must not, or a clinician cannot save a half-finished assessment —
// which is the exact thing that loses an hour of work to a browser reload.
test('a draft does NOT enforce the both-arms BP rule that filing enforces', () => {
  const oneArm = { chiefConcern: 'x', vitals: { bpRightSys: '120', bpRightDia: '80' } };
  const filed = R.buildHpWrites(oneArm, 'RN');
  assert.strictEqual(filed.code, 'HP_BP_BOTH_ARMS', 'filing must still refuse one arm');
  const drafted = R.sanitizeNoteDraft(oneArm);
  assert.ok(!drafted.error, 'a draft must save with one arm — it is incomplete by definition');
  assert.strictEqual(drafted.draft.vitals.bpRightSys, '120');
});

// The section vocabulary is derived from HP_SECTION_LABELS, not restated. If
// this breaks, a section added to the H&P is silently undraftable.
test('every H&P section the filed note knows about is draftable', () => {
  const sections = ['systemsExam', 'skinWound', 'painAssessment', 'homeHazards', 'triage'];
  for (const s of sections) {
    const { draft, error } = R.sanitizeNoteDraft({ [s]: { probe: 'value' } });
    assert.ok(!error, `${s}: ${error}`);
    assert.strictEqual(draft[s] && draft[s].probe, 'value', `${s} was dropped from the draft`);
  }
});

test('a key the H&P does not define never reaches the stored draft', () => {
  const { draft } = R.sanitizeNoteDraft({ ...fullDraft(), ssn: '123-45-6789', isAdmin: true });
  assert.strictEqual(draft.ssn, undefined, 'an undeclared key must not be stored');
  assert.strictEqual(draft.isAdmin, undefined);
});

test('a nested object inside a section is dropped, never stringified', () => {
  const { draft } = R.sanitizeNoteDraft({ systemsExam: { general: 'Alert', nested: { a: 1 } } });
  assert.strictEqual(draft.systemsExam.general, 'Alert');
  assert.strictEqual(draft.systemsExam.nested, undefined);
  assert.ok(!JSON.stringify(draft).includes('[object Object]'));
});

test('an empty payload and a non-object are both refused with a code', () => {
  assert.strictEqual(R.sanitizeNoteDraft({}).code, 'DRAFT_EMPTY');
  assert.strictEqual(R.sanitizeNoteDraft(null).code, 'DRAFT_EMPTY');
  assert.strictEqual(R.sanitizeNoteDraft('a string').code, 'DRAFT_EMPTY');
  assert.strictEqual(R.sanitizeNoteDraft([1, 2]).code, 'DRAFT_EMPTY');
});

test('an oversized draft is refused rather than stored', () => {
  const huge = { subjective: 'x'.repeat(400000), assessment: 'y'.repeat(400000) };
  const r = R.sanitizeNoteDraft(huge);
  // Each field is capped first; if the total still blows the budget it is refused.
  if (r.error) assert.strictEqual(r.code, 'DRAFT_TOO_LARGE');
  else assert.ok(JSON.stringify(r.draft).length <= 200000);
});

// ── the key that keeps two clinicians apart ──────────────────────────────

// Bianca on-site and Bethel virtual, same patient, same day, is the NORMAL
// case here. A draft keyed on the patient alone would have each of them
// overwriting the other's assessment with no warning.
test('a draft id carries the clinician as well as the patient', () => {
  const a = R.noteDraftId('client-1', 'clinician-a');
  const b = R.noteDraftId('client-1', 'clinician-b');
  assert.notStrictEqual(a, b, 'two clinicians on one patient must not share a draft');
  assert.ok(a.includes('client-1') && a.includes('clinician-a'));
  assert.strictEqual(R.noteDraftId('client-1', 'clinician-a'), a, 'the id must be stable');
});

test('a draft row records who wrote it and keeps its original createdAt', () => {
  const actor = { id: 'u1', name: 'Bianca Ume' };
  const first = R.buildNoteDraft({ clientId: 'c1', actor, draft: { plan: 'v1' }, at: '2026-09-22T10:00:00.000Z' });
  assert.strictEqual(first.clinicianId, 'u1');
  assert.strictEqual(first.clientId, 'c1');
  assert.strictEqual(first.createdAt, '2026-09-22T10:00:00.000Z');
  const second = R.buildNoteDraft({ clientId: 'c1', actor, draft: { plan: 'v2' }, at: '2026-09-22T11:00:00.000Z', existing: first });
  assert.strictEqual(second.createdAt, first.createdAt, 'resaving must not reset createdAt');
  assert.strictEqual(second.updatedAt, '2026-09-22T11:00:00.000Z');
  assert.strictEqual(second.id, first.id, 'resaving must replace, never add a second row');
});

// ── build enforcement: the server ────────────────────────────────────────

test('the draft collection is registered as PHI, or the migration guard fails the build', () => {
  assert.match(migration, /key:\s*'clinical_note_drafts'[^}]*phi:\s*true/,
    'clinical_note_drafts must be claimed in COLLECTION_REGISTRY and marked PHI');
});

test('filing the note clears the draft that produced it', () => {
  // A draft that survives filing resurrects a stale half-note over a real one
  // the next time the clinician opens the patient.
  const visitRoute = server.slice(server.indexOf("app.post('/api/clinical/patients/:clientId/visit'"));
  const body = visitRoute.slice(0, visitRoute.indexOf('clinical_hp_documented'));
  assert.ok(body.includes('clearNoteDraft('),
    'the visit route must clear the draft before it reports the note documented');
});

test('all three draft routes require the capability that documents a note', () => {
  for (const verb of ['get', 'put', 'delete']) {
    const re = new RegExp(`app\\.${verb}\\('/api/clinical/patients/:clientId/visit/draft'[^\\n]*`);
    const line = (server.match(re) || [])[0];
    assert.ok(line, `the ${verb.toUpperCase()} draft route is missing`);
    assert.ok(line.includes('CAPABILITIES.NURSING_NOTE'),
      `${verb.toUpperCase()} draft must gate on NURSING_NOTE, not the middleware alone`);
  }
});

test('a draft is read back only by its own author', () => {
  const get = server.slice(server.indexOf("app.get('/api/clinical/patients/:clientId/visit/draft'"));
  const body = get.slice(0, get.indexOf('app.put('));
  assert.ok(body.includes('noteDraftId(client.id, req.user.id)'),
    'the read must key on the CALLER, or one clinician reads another\'s unfinished note');
});

test('the activity trail records that a draft was saved, never its content', () => {
  const put = server.slice(server.indexOf("app.put('/api/clinical/patients/:clientId/visit/draft'"));
  const body = put.slice(0, put.indexOf("app.delete('"));
  const log = (body.match(/logActivity\([^;]*\);/s) || [''])[0];
  assert.ok(log.includes('clinical_note_draft_saved'));
  assert.ok(!/draft\b/.test(log.replace('clinical_note_draft_saved', '')),
    'an audit entry must not carry a copy of the assessment');
});

// ── build enforcement: the screens ───────────────────────────────────────

// The defect this replaces: one button reading "Sign & write to chart" that
// performed no attestation at all.
test('no H&P action claims to sign, because none of them signs', () => {
  const hp = clinicalPage.slice(clinicalPage.indexOf('const HpTab = ('));
  const actions = hp.slice(0, hp.indexOf('const MedRecTab'));
  assert.ok(!/Sign & write to chart/.test(actions),
    'the H&P button must not say "Sign" — filing a note is not attesting to it');
  assert.ok(actions.includes('Save draft'), 'the simple save is missing');
  assert.ok(actions.includes('Save & file note to chart'), 'the file-to-chart action is missing');
  // Scoped to the message filing actually produces, NOT to the whole tab: the
  // explainer paragraph also contains "not signed", so a looser assertion here
  // passed even with the success message stripped. Caught by mutation.
  const fileFn = actions.slice(actions.indexOf('const file = (thenGo)'));
  const fileBody = fileFn.slice(0, fileFn.indexOf('const painFields'));
  assert.ok(/NOT signed yet/.test(fileBody),
    'the message shown after filing must say the note is not yet signed');
});

test('the three note actions all exist and do three different things', () => {
  const hp = clinicalPage.slice(clinicalPage.indexOf('const HpTab = ('));
  const actions = hp.slice(0, hp.indexOf('const MedRecTab'));
  assert.ok(actions.includes('api.saveDraft('), 'Save draft must call the draft route');
  assert.ok(actions.includes('api.visit('), 'filing must call the visit route');
  assert.ok(actions.includes('onGoToEncounter('),
    'the third action must lead to where signing actually happens');
});

// The reason this whole session started: a route with no screen.
test('the facility assignment route is actually called from a page', () => {
  assert.match(server, /app\.put\('\/api\/clinical\/patients\/:clientId\/facility'/,
    'the facility route must exist');
  assert.ok(clinicalPage.includes('assignFacility'),
    'a route with no caller is a capability that does not exist — this blocked every signature');
  assert.ok(clinicalPage.includes('<FacilityCard'), 'the facility card must be rendered');
});

test('the facility picker is admin-only on screen, matching the route', () => {
  const card = clinicalPage.slice(clinicalPage.indexOf('const FacilityCard = ('));
  const body = card.slice(0, card.indexOf('const SummaryTab = ('));
  assert.ok(body.includes('isAdmin ?'),
    'a non-admin must see the state, not a control the server would 403');
  const route = server.slice(server.indexOf("app.put('/api/clinical/patients/:clientId/facility'"));
  assert.ok(route.slice(0, 200).includes('requireAdmin'), 'the route itself must stay admin-only');
});

test('an unassigned patient is told plainly that it blocks signing', () => {
  const card = clinicalPage.slice(clinicalPage.indexOf('const FacilityCard = ('));
  const body = card.slice(0, card.indexOf('const SummaryTab = ('));
  assert.ok(/cannot be signed/i.test(body),
    'the card must name the consequence, not just show an empty field');
  // Assigned-but-no-POS is a different problem with a different fix, and the
  // fix is not on this screen. Telling someone to set it here would send them
  // looking for a control that does not exist.
  assert.ok(/Administration → Facilities/.test(body),
    'a missing POS must point at OpenEMR, where it is actually set');
});
