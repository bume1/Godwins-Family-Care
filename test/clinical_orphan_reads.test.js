'use strict';
// THREE CLINICAL ROUTES NOBODY COULD REACH.
//
//   GET  .../care-plan/goals/:goalId/history   every status a goal ever had
//   GET  .../encounters/:euuid/documents       what this visit still needs
//   PUT  .../encounters/:euuid/billing-facility  who bills this visit
//
// Each was built, tested and left with no caller, so each was a capability
// nobody had:
//   * a goal showed only its LATEST status, so one met in September and lost
//     in October read as though it had only ever been one thing;
//   * an appointment type could declare the documents its visits require, and
//     the requirement was recorded and invisible;
//   * `billing_facility` is WHO bills a visit — a different question from
//     where care happened since the 2026-09-09 split — and the only way to
//     correct one was in OpenEMR by hand. Its CURRENT value was not even
//     served, so billing could not see what it was about to change.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const server = read('server.js');
const clinical = read('public/clinical.html');
const billing = read('public/billing.html');

const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:\\])\/\/[^\n]*/g, '$1');

// ---- 1. the goal history ------------------------------------------------------

test('a goal\'s whole status trail can be read from the chart', () => {
  assert.match(server, /app\.get\('\/api\/clinical\/patients\/:clientId\/care-plan\/goals\/:goalId\/history', authenticateToken, requireClinicalRead/,
    'the goal history route is gone or no longer a clinical read');
  assert.match(clinical, /goalHistory: \(id, goalId\) => authedFetch\(`\/api\/clinical\/patients\/\$\{id\}\/care-plan\/goals\/\$\{encodeURIComponent\(goalId\)\}\/history`\)/,
    'the page does not call the goal history route');
  assert.match(clinical, /<GoalHistory clientId=\{clientId\} goal=\{g\} vocab=\{vocab\} \/>/,
    'the goal rows do not render the history control');
});

test('the history is a READ, so it is not hidden behind the write gate', () => {
  // The status control is a writer's; seeing what happened is not. A case
  // manager holds scoped clinical READ (4.3) and this is exactly the kind of
  // thing they are reading for.
  const row = clinical.slice(clinical.indexOf('{g.id && !cp.legacyFormat && ('), clinical.indexOf('</li>))}</ul> : <p className="text-stone-400">No goals written.'));
  assert.match(row, /\{canWrite && <GoalStatusControl/,
    'the status control is no longer gated on write');
  const hist = row.slice(row.indexOf('<GoalHistory'));
  assert.doesNotMatch(row.slice(0, row.indexOf('<GoalHistory')).split('\n').pop(), /canWrite &&\s*$/,
    'the history control was put behind the write gate');
  assert.ok(hist.startsWith('<GoalHistory'), 'the history control is conditional on something');
});

test('a failed history read is not reported as a goal that never changed', () => {
  const c = clinical.slice(clinical.indexOf('const GoalHistory ='), clinical.indexOf('const GoalStatusControl ='));
  assert.match(c, /rows === false && .*could not be read/,
    'a failed read is not distinguished');
  assert.match(c, /No status change has been recorded on this goal yet/,
    'an empty trail has no sentence of its own');
  // Three states, and they are different facts.
  assert.match(c, /rows === null/, 'there is no loading state');
});

// ---- 2. the per-visit documents -------------------------------------------------

test('a visit says what it still needs on file', () => {
  assert.match(server, /app\.get\('\/api\/clinical\/patients\/:clientId\/encounters\/:euuid\/documents', authenticateToken, requireClinicalRead/,
    'the per-visit documents route is gone or no longer a clinical read');
  assert.match(clinical, /visitDocuments: \(id, euuid\) => authedFetch\(/,
    'the page does not call the per-visit documents route');
  assert.match(clinical, /<VisitDocumentsCard clientId=\{patient\.id\} euuid=\{euuid\} \/>/,
    'the encounter does not render the visit documents card');
});

test('the card names no document kind of its own', () => {
  // Every label, hint and kind comes from the server's catalog. A page that
  // restates them drifts from the thing that decides them — the rule the
  // competency catalog set and the upload link follows.
  const c = strip(clinical.slice(clinical.indexOf('const VisitDocumentsCard ='), clinical.indexOf('const EncounterPanel =')));
  for (const kind of ['faceSheet', 'dischargeSummary', 'insuranceCard', 'photoId', 'referral', 'physicianOrder']) {
    assert.doesNotMatch(c, new RegExp(kind), `the card names the document kind ${kind} itself`);
  }
  assert.match(c, /\{r\.label\}/, 'the card does not render the label the server sent');
  assert.match(c, /\{r\.hint\}/, 'the card drops the hint the server sent');
});

test('the card tells apart "nothing is asked for" from "the read failed"', () => {
  const c = clinical.slice(clinical.indexOf('const VisitDocumentsCard ='), clinical.indexOf('const EncounterPanel ='));
  assert.match(c, /d === false &&[\s\S]{0,200}could not be read[\s\S]{0,120}not the same as this visit needing nothing/,
    'a failed read reads as a visit that needs nothing');
  assert.match(c, /asks for no documents/, 'a visit type that wants none has no sentence');
  assert.match(c, /No visit type is set on this encounter/,
    'an encounter with no visit type is not distinguished from one that wants nothing');
});

test('a document opens through the app, so the read is audited', () => {
  // The server already returns `/api/gfc/documents/uploads/:id/file`; the page
  // must use it rather than anything Drive-shaped.
  const c = clinical.slice(clinical.indexOf('const VisitDocumentsCard ='), clinical.indexOf('const EncounterPanel ='));
  assert.match(c, /href=\{f\.url\}/, 'the card builds its own link instead of using the audited one');
  assert.doesNotMatch(c, /drive\.google|driveFileId|drive_file_id/i, 'the card reaches for a Drive id');
  const route = server.slice(server.indexOf("app.get('/api/clinical/patients/:clientId/encounters/:euuid/documents'"));
  assert.match(route.slice(0, 2600), /url: `\/api\/gfc\/documents\/uploads\/\$\{u\.id\}\/file`/,
    'the route no longer returns an app-audited url');
});

// ---- 3. who bills this visit -----------------------------------------------------

test('the per-visit billing facility is served, and only to billing', () => {
  // It was never sent to the page at all, so the current value could not be
  // shown. It rides the same `canBill` gate as the rest of the
  // place-of-service block, because a clinician never sees any of it.
  const det = server.slice(server.indexOf('...(canBill ? {\n          facility: emrRow.facility_name'));
  const blk = det.slice(0, det.indexOf('} : {})'));
  assert.match(blk, /billingFacilityId: emrRow\.billing_facility/,
    'the encounter detail does not carry the per-visit billing facility');
  assert.ok(blk.includes('canBill ? {'), 'the billing facility escaped the billing-only gate');
});

test('the billing page can change who bills a visit, and nothing else can', () => {
  assert.match(server, /app\.put\('\/api\/clinical\/patients\/:clientId\/encounters\/:euuid\/billing-facility', authenticateToken, requireBilling/,
    'the billing-facility route is gone or no longer requireBilling');
  assert.match(billing, /setBillingFacility: \(id, euuid, facilityId\) =>/, 'the billing page cannot set it');
  assert.match(billing, /<BillingFacilityRow clientId=\{clientId\} euuid=\{euuid\}/, 'the control is not rendered');
  // The clinical workspace must NOT grow a second door onto it: a place of
  // service and who bills are both billing's, never a clinician's (owner,
  // 2026-09-29).
  assert.doesNotMatch(strip(clinical), /billing-facility/,
    'the clinical workspace now has a billing-facility control, which is billing\'s alone');
});

test('the facility list is read from OpenEMR and an unreadable list says so', () => {
  const c = billing.slice(billing.indexOf('const BillingFacilityRow ='), billing.indexOf('const ClaimDetail ='));
  assert.match(c, /api\.facilities\(\)/, 'the control does not read the facility list from OpenEMR');
  assert.match(c, /rows === false &&[\s\S]{0,200}could not be read/,
    'an unreadable facility list is shown as an empty picker');
  assert.match(c, /not the same as there being no facilities/,
    'the page does not say what an unreadable list means');
  // No facility is named in the page.
  assert.doesNotMatch(strip(c), /Vinings|Buckhead|Hickory/,
    'the control names a facility instead of reading the list');
});

test('a facility OpenEMR does not mark as a billing location is shown, not hidden', () => {
  // Hiding it would make a wrong flag in OpenEMR look like a missing record,
  // which is the Hickory Log service-location lesson pointed at billing.
  const c = billing.slice(billing.indexOf('const BillingFacilityRow ='), billing.indexOf('const ClaimDetail ='));
  assert.match(c, /f\.billingLocation \? '' : ' — not a billing location in OpenEMR'/,
    'the picker either hides non-billing facilities or stops labelling them');
  assert.doesNotMatch(c, /rows\.filter\(/, 'the picker filters the list the server sent');
});

test('the control is only offered while the visit can still be changed', () => {
  // The route refuses a closed encounter (refuseIfClosed), so offering the
  // button afterwards would hand out a control the server rejects.
  const route = server.slice(server.indexOf("app.put('/api/clinical/patients/:clientId/encounters/:euuid/billing-facility'"));
  assert.match(route.slice(0, 400), /refuseIfClosed\(ctx, res\)/,
    'the route no longer refuses a closed encounter');
  assert.match(billing, /canEdit=\{ba\.canSubmit\}/,
    'the control is offered regardless of whether this visit is still billing\'s to change');
});
