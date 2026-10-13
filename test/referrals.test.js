// ============================================================================
// Referrals to the care team or to a saved outside provider (owner, 2026-10-12)
//
// What this file pins:
//   1. Scope of practice decides who refers where. Any licensed role refers
//      within the team; a provider or an LCSW refers out; an LMSW does not.
//      DME stays provider-direct only.
//   2. Case managers and counselors are LMSW; a clinical social worker is LCSW.
//      Case managers stored as readOnly move to lmsw ONCE.
//   3. An LCSW adds a mental health (F) diagnosis to the problem list and
//      nothing else; an LMSW adds none.
//   4. An internal referral is never faxed, never filed to OpenEMR, and only
//      the colleague it went to accepts or completes it, with a note.
//   5. The colleague joins the care team without displacing anyone, and a
//      supporting case manager is in messaging scope.
//   6. A saved provider is never changed by placing a referral; editing its
//      fax needs a reason; duplicates are caught by fax.
//   7. Cancelling an order needs a reason.
// ============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const roles = require('../clinicalRoles');
const orderReq = require('../orderRequisitions');
const clinicalRepo = require('../clinicalRepository');
const dir = require('../referralDirectory');
const inbox = require('../clinicalInbox');
const msg = require('../messagingRepository');

const root = path.join(__dirname, '..');
const SERVER = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const PAGE = fs.readFileSync(path.join(root, 'public', 'clinical.html'), 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
const PAGE_CODE = stripComments(PAGE);
const sliceBetween = (src, a, b) => {
  const i = src.indexOf(a);
  assert.ok(i !== -1, `anchor not found: ${a}`);
  const j = src.indexOf(b, i + a.length);
  assert.ok(j !== -1, `end anchor not found after ${a}: ${b}`);
  return src.slice(i, j);
};

const PROVIDER = { id: 'p1', name: 'Bethel Godwins', role: 'user', clinicalRole: 'provider', npi: '1902310568' };
const RN = { id: 'rn1', name: 'Rita Nurse', role: 'user', clinicalRole: 'rn' };
const LCSW = { id: 'lc1', name: 'Lee Carter', role: 'user', clinicalRole: 'lcsw' };
const LMSW_COUNSELOR = { id: 'lm1', name: 'Morgan Shaw', role: 'user', clinicalRole: 'lmsw' };
const CASE_MANAGER = { id: 'cm1', name: 'Courtney Hale', role: 'caseManager', clinicalRole: 'lmsw' };
const READ_ONLY = { id: 'ro1', name: 'Casey Reed', role: 'caseManager', clinicalRole: 'readOnly' };
const DX = [{ code: 'F32.9', description: 'Depression' }, { code: 'E11.9', description: 'Type 2 diabetes' }];
const AT = '2026-10-12T15:00:00.000Z';

const internalReferral = (extra = {}, assignee = { id: 'cm1', name: 'Courtney Hale', clinicalRole: 'lmsw', roleLabel: 'Case management' }) =>
  orderReq.buildReferral({
    id: 'o1', clientId: 'c1', encounterUuid: 'e1', actor: PROVIDER, encounterDiagnoses: DX, at: AT, assignee,
    input: { destination: 'internal', reason: 'Housing instability', clinicalSummary: 'Can you connect her with housing support?', diagnosisCodes: ['F32.9'], ...extra }
  });

// ── 1. Who refers where ──────────────────────────────────────────────────────

test('any licensed role refers within the team; only a provider or an LCSW refers out', () => {
  for (const u of [PROVIDER, RN, LCSW, LMSW_COUNSELOR, CASE_MANAGER]) {
    assert.equal(roles.canRefer(u, 'internal'), true, `${u.clinicalRole} refers within the team`);
  }
  assert.equal(roles.canRefer(PROVIDER, 'external'), true);
  assert.equal(roles.canRefer(LCSW, 'external'), true, 'an LCSW practises independently and refers out');
  assert.equal(roles.canRefer(RN, 'external'), false);
  assert.equal(roles.canRefer(LMSW_COUNSELOR, 'external'), false, 'an LMSW refers within the team');
  assert.equal(roles.canRefer(CASE_MANAGER, 'external'), false);
  assert.equal(roles.canRefer(READ_ONLY, 'internal'), false, 'read-only staff refer nobody');
  assert.equal(roles.canRefer(PROVIDER, 'sideways'), false, 'an unknown destination is refused');
  assert.match(roles.referralRefusal(LMSW_COUNSELOR, 'external').error, /provider or an LCSW/);
});

test('DME and test orders are still provider-direct only, and a referral is never a protocol type', () => {
  for (const u of [RN, LCSW, LMSW_COUNSELOR, CASE_MANAGER]) {
    assert.equal(roles.can(u, roles.CAPABILITIES.ORDER_DIRECT), false, `${u.clinicalRole} has no direct ordering`);
  }
  assert.ok(!roles.STANDING_ORDER_TYPES.includes('referral'));
  assert.ok(!roles.STANDING_ORDER_TYPES.includes('dme'));
  // The route refuses a referral that names a protocol, BEFORE the patient is loaded.
  const route = sliceBetween(SERVER, "app.post('/api/clinical/patients/:clientId/encounters/:euuid/orders'", 'const ctx = await loadEncounterContext(req, res);');
  // The CONDITION, not just the code's text: a refusal switched off with
  // `if (false)` still contains the string (that is how this line first
  // survived its mutation check).
  assert.match(route, /if \(isReferralOrder\) \{\s*if \(String\(placing\.standingOrderId \|\| ''\)\.trim\(\)\) \{\s*return res\.status\(400\)\.json\(\{[^}]*code: 'REFERRAL_NOT_UNDER_PROTOCOL' \}\);/);
  assert.match(route, /if \(!clinicalRoles\.canRefer\(req\.user, referralDestination\)\)/);
});

test('working an order through: an RN or provider on anything, social work on a referral only', () => {
  const lab = { orderType: 'lab' };
  const referral = { orderType: 'referral' };
  const dme = { orderType: 'dme' };
  assert.equal(roles.canCoordinateOrder(RN, lab), true);
  assert.equal(roles.canCoordinateOrder(LMSW_COUNSELOR, referral), true, 'service coordination is LMSW scope');
  assert.equal(roles.canCoordinateOrder(LCSW, referral), true);
  assert.equal(roles.canCoordinateOrder(LMSW_COUNSELOR, lab), false, 'a lab stays with the RN and the provider');
  assert.equal(roles.canCoordinateOrder(LCSW, dme), false);
  assert.equal(roles.canCoordinateOrder(READ_ONLY, referral), false);
  assert.equal(roles.canCoordinateOrder(PROVIDER, null), false);
  // The routes ask it per order, after loading the order.
  for (const r of ['sent', 'scheduled', 'result']) {
    const route = sliceBetween(SERVER, `app.post('/api/clinical/orders/:orderId/${r}'`, 'catch (error)');
    assert.match(route, /refuseUnlessCoordinator\(req, res, (order|found\.order)\)/, `${r} checks the order`);
  }
  const status = sliceBetween(SERVER, "app.post('/api/clinical/orders/:orderId/status'", 'catch (error)');
  assert.match(status, /requireOrderCoordinator/);
  assert.match(status, /refuseUnlessCoordinator\(req, res, rows\[idx\]\)/);
});

// ── 2. Case managers are LMSW ────────────────────────────────────────────────

test('labels say who is who', () => {
  assert.match(roles.CLINICAL_ROLE_LABELS.lmsw, /case manager \/ counselor/);
  assert.match(roles.CLINICAL_ROLE_LABELS.lcsw, /clinical social worker/);
});

test('a case manager stored as readOnly moves to lmsw once, and a later deliberate readOnly stands', () => {
  const users = [
    { id: 'a', role: 'caseManager', clinicalRole: 'readOnly', name: 'A' },
    { id: 'b', role: 'user', clinicalRole: 'readOnly', name: 'B' },
    { id: 'c', role: 'caseManager', clinicalRole: 'lmsw', name: 'C' },
    { id: 'd', role: 'client', name: 'D' }
  ];
  const first = roles.applyCaseManagerLmswMigration(users, AT);
  const by = (list, id) => list.find(u => u.id === id);
  assert.deepEqual(first.changed.map(c => c.id), ['a']);
  assert.equal(by(first.users, 'a').clinicalRole, 'lmsw');
  assert.equal(by(first.users, 'a').hasClinicalAccess, true);
  assert.equal(by(first.users, 'a').caseManagerLmswMigration.version, roles.CASE_MANAGER_LMSW_MARKER);
  assert.equal(by(first.users, 'b').clinicalRole, 'readOnly', 'only case managers move');
  // An admin later sets A back to readOnly on purpose; the next boot leaves it.
  const adminSet = first.users.map(u => u.id === 'a' ? { ...u, clinicalRole: 'readOnly' } : u);
  const second = roles.applyCaseManagerLmswMigration(adminSet, AT);
  assert.equal(second.changed.length, 0);
  assert.equal(by(second.users, 'a').clinicalRole, 'readOnly');
  // The boot calls it.
  assert.match(SERVER, /clinicalRoles\.applyCaseManagerLmswMigration\(next\)/);
});

// ── 3. An LCSW diagnoses mental health conditions ────────────────────────────

test('an LCSW adds an F code to the problem list and nothing else; an LMSW adds none', () => {
  assert.equal(roles.isBehavioralHealthDiagnosis('F32.9'), true);
  assert.equal(roles.isBehavioralHealthDiagnosis('ICD10:F41.1'), true);
  assert.equal(roles.isBehavioralHealthDiagnosis('E11.9'), false);
  assert.equal(roles.isBehavioralHealthDiagnosis(''), false);
  assert.equal(roles.canAddProblem(LCSW, 'F41.1'), true);
  assert.equal(roles.canAddProblem(LCSW, 'E11.9'), false);
  assert.equal(roles.canAddProblem(LCSW, ''), false, 'an uncoded problem is not a mental health diagnosis');
  assert.equal(roles.canAddProblem(LMSW_COUNSELOR, 'F41.1'), false);
  assert.equal(roles.canAddProblem(RN, 'E11.9'), true);
  assert.match(roles.problemRefusal(LCSW, 'E11.9').error, /E11\.9 is not a mental health diagnosis/);
  // Allergies stay an RN's or a provider's: the LCSW has no general problem-list capability.
  assert.equal(roles.can(LCSW, roles.CAPABILITIES.PROBLEM_LIST_WRITE), false);
  const route = sliceBetween(SERVER, "app.post('/api/clinical/patients/:clientId/problems'", 'catch (error)');
  assert.match(route, /if \(!clinicalRoles\.canAddProblem\(req\.user, icd10\)\)/);
  const allergies = sliceBetween(SERVER, "app.post('/api/clinical/patients/:clientId/allergies'", 'async (req, res)');
  assert.match(allergies, /requireCapability\(clinicalRoles\.CAPABILITIES\.PROBLEM_LIST_WRITE\)/);
});

// ── 4. The internal referral ─────────────────────────────────────────────────

test('an internal referral needs a colleague, a reason and a question, and no fax', () => {
  const ok = internalReferral();
  assert.ok(ok.order, JSON.stringify(ok));
  const r = ok.order.referral;
  assert.equal(r.destination, 'internal');
  assert.equal(r.assignedTo.id, 'cm1');
  assert.equal(r.receivingFax, null);
  assert.equal(r.specialty, 'Case management', 'what it is for defaults to their discipline');
  assert.equal(ok.order.transmission, 'internal');
  assert.equal(internalReferral({}, null).code, 'REFERRAL_NO_ASSIGNEE');
  assert.equal(internalReferral({}, { id: 'p1', name: 'Bethel Godwins' }).code, 'REFERRAL_SELF', 'no referring a patient to yourself');
  assert.equal(internalReferral({ reason: '' }).code, 'REFERRAL_NO_REASON');
  assert.equal(internalReferral({ clinicalSummary: '' }).code, 'REFERRAL_NO_SUMMARY');
  assert.equal(internalReferral({ diagnosisCodes: [] }).code, 'ORDER_NO_DIAGNOSIS', 'still anchored to an encounter diagnosis');
});

test('an internal referral is never faxed, scheduled, re-addressed, or filed to OpenEMR', () => {
  const order = internalReferral().order;
  assert.equal(orderReq.isInternalReferral(order), true);
  assert.equal(orderReq.applySend({ order, actor: PROVIDER, input: { channel: 'doximity' } }).code, 'ORDER_INTERNAL_REFERRAL');
  assert.equal(orderReq.applyReferralScheduled({ order, actor: PROVIDER, appointmentDate: '2026-10-20' }).code, 'ORDER_INTERNAL_REFERRAL');
  assert.equal(orderReq.applyDestinationEdit({ order, actor: PROVIDER, input: { receivingFax: '4045550123' } }).code, 'ORDER_NO_DESTINATION');
  const route = sliceBetween(SERVER, "app.post('/api/clinical/patients/:clientId/encounters/:euuid/orders'", 'catch (error)');
  const skip = route.indexOf('if (internalReferral) {');
  const post = route.indexOf('ctx.emr.postOrder(');
  assert.ok(skip !== -1 && post !== -1 && skip < post, 'the internal check comes before the OpenEMR write');
  assert.match(route.slice(skip, post), /\} else if \(!providerId\) \{/, 'and the OpenEMR write sits in its else branch');
  const req = sliceBetween(SERVER, "app.get('/api/clinical/orders/:orderId/requisition.pdf'", 'catch (error)');
  assert.match(req, /if \(orderReq\.isInternalReferral\(order\)\)/, 'no requisition for an internal referral');
});

test('only the colleague it went to accepts or completes it, and completing needs a note', () => {
  const order = internalReferral().order;
  const CM = { id: 'cm1', name: 'Courtney Hale' };
  assert.equal(orderReq.applyInternalAccept({ order, actor: PROVIDER }).code, 'REFERRAL_NOT_YOURS');
  assert.equal(orderReq.applyInternalAccept({ order, actor: PROVIDER }).status, 403);
  const accepted = orderReq.applyInternalAccept({ order, actor: CM, at: AT }).order;
  assert.equal(accepted.status, 'accepted');
  assert.equal(accepted.referral.acceptedBy.id, 'cm1');
  assert.equal(orderReq.applyInternalAccept({ order: accepted, actor: CM }).code, 'ORDER_BAD_TRANSITION', 'not accepted twice');
  assert.equal(orderReq.applyInternalComplete({ order: accepted, actor: CM, note: '  ' }).code, 'REFERRAL_COMPLETE_NO_NOTE');
  assert.equal(orderReq.applyInternalComplete({ order: accepted, actor: RN, note: 'done' }).code, 'REFERRAL_NOT_YOURS');
  const done = orderReq.applyInternalComplete({ order: accepted, actor: CM, note: 'Referred to the county housing program; intake booked.', at: AT }).order;
  assert.equal(done.status, 'completed');
  assert.equal(done.referral.completionNote, 'Referred to the county housing program; intake booked.');
  assert.equal(done.referral.completedBy.name, 'Courtney Hale');
  // Completing straight from "ordered" also stamps acceptance, so it never reads as skipped.
  const direct = orderReq.applyInternalComplete({ order, actor: CM, note: 'Seen today', at: AT }).order;
  assert.equal(direct.status, 'completed');
  assert.equal(direct.referral.acceptedAt, AT);
  // An outside referral is not accepted this way.
  const outside = orderReq.buildReferral({
    id: 'o2', clientId: 'c1', encounterUuid: 'e1', actor: PROVIDER, encounterDiagnoses: DX,
    input: { specialty: 'Psychiatry', receivingFax: '4045550123', reason: 'Med management', clinicalSummary: 'Q', diagnosisCodes: ['F32.9'] }
  }).order;
  assert.equal(orderReq.applyInternalAccept({ order: outside, actor: CM }).code, 'ORDER_NOT_INTERNAL_REFERRAL');
});

test('accepted and completed are never set from the generic status route; cancelling needs a reason', () => {
  const order = internalReferral().order;
  assert.deepEqual(clinicalRepo.transitionsFor(order), orderReq.INTERNAL_REFERRAL_TRANSITIONS);
  assert.equal(clinicalRepo.advanceOrderStatus(order, 'accepted', PROVIDER).code, 'ORDER_STATUS_NEEDS_EVIDENCE');
  assert.equal(clinicalRepo.advanceOrderStatus(order, 'completed', PROVIDER).code, 'ORDER_STATUS_NEEDS_EVIDENCE');
  assert.equal(clinicalRepo.advanceOrderStatus(order, 'cancelled', PROVIDER, '   ').code, 'ORDER_CANCEL_REASON_REQUIRED');
  const c = clinicalRepo.advanceOrderStatus(order, 'cancelled', PROVIDER, 'Patient declined', AT).order;
  assert.equal(c.status, 'cancelled');
  assert.equal(c.cancelReason, 'Patient declined');
  assert.equal(c.cancelledAt, AT);
  assert.equal(c.statusHistory.slice(-1)[0].note, 'Patient declined');
});

test('the email to the colleague carries no patient: its builder takes no arguments', () => {
  assert.equal(orderReq.buildInternalReferralNotice.length, 0);
  const n = orderReq.buildInternalReferralNotice();
  assert.match(n.body, /no patient or clinical detail/);
  const after = sliceBetween(SERVER, 'async function afterReferralPlaced(', '\n}\n');
  assert.match(after, /queueNotification\('internal_referral_assigned'/);
  assert.match(after, /ctaUrl: appLinks\.PATHS\.CLINICAL_INBOX/);
  assert.doesNotMatch(after.slice(after.indexOf("queueNotification('internal_referral_assigned'"), after.indexOf('relatedEntityId')), /client\.name|order\.referral|reason|clinicalSummary/,
    'nothing about the patient or the referral rides in the email');
});

// ── 5. The care team follows the referral ───────────────────────────────────

test('the colleague joins the care team without displacing anyone', () => {
  const clinician = orderReq.careTeamWithAssignee({ assignedFNPs: ['p1'] }, { id: 'lc1', role: 'user' });
  assert.deepEqual(clinician.careTeam.assignedFNPs, ['p1', 'lc1']);
  assert.equal(clinician.slot, 'clinician');
  const empty = orderReq.careTeamWithAssignee({ assignedFNPs: [] }, { id: 'cm1', role: 'caseManager' });
  assert.equal(empty.careTeam.assignedCaseManager, 'cm1');
  const held = orderReq.careTeamWithAssignee({ assignedCaseManager: 'cm0' }, { id: 'cm1', role: 'caseManager' });
  assert.equal(held.careTeam.assignedCaseManager, 'cm0', 'the existing case manager is never replaced');
  assert.deepEqual(held.careTeam.supportingCaseManagers, ['cm1']);
  const already = orderReq.careTeamWithAssignee({ assignedFNPs: ['lc1'] }, { id: 'lc1', role: 'user' });
  assert.equal(already.added, false);
  assert.equal(orderReq.isOnCareTeam({ supportingCaseManagers: ['cm1'] }, 'cm1'), true);
});

test('a supporting case manager is in messaging scope, while routing stays on the assigned one', () => {
  const client = { id: 'c1', careTeam: { assignedCaseManager: 'cm0', supportingCaseManagers: ['cm1'] } };
  const cm1 = { id: 'cm1', role: 'caseManager' };
  const stranger = { id: 'cm9', role: 'caseManager' };
  assert.equal(msg.clientInScope(cm1, client), true);
  assert.equal(msg.clientInScope(stranger, client), false, 'nobody else is widened');
  const thread = { channel: 'care_coordination', client_id: 'c1', participant_ids: [] };
  assert.equal(msg.threadVisibility(cm1, thread, { client }).visible, true);
  assert.equal(msg.threadVisibility(stranger, thread, { client }).visible, false);
  assert.equal(msg.assignedCaseManagerId(client), 'cm0', 'escalations still route to the assigned case manager');
});

// ── 6. The clinical inbox ────────────────────────────────────────────────────

test('the inbox shows a referral as waiting on the colleague, actionable only by them', () => {
  const order = { ...internalReferral().order, createdAt: AT };
  const mine = inbox.buildInbox({ viewer: { id: 'cm1', role: 'caseManager', clinicalRole: 'lmsw' }, orders: [order], patientNames: { c1: 'Juanita Guess' } });
  const item = mine.items.find(i => i.kind === inbox.KINDS.INTERNAL_REFERRAL);
  assert.ok(item);
  assert.equal(item.actionable, true);
  assert.equal(item.waitingOn, 'you');
  assert.equal(item.status, 'ordered');
  assert.match(item.detail, /From Bethel Godwins: Housing instability/);
  const other = inbox.buildInbox({ viewer: PROVIDER, orders: [order] }).items.find(i => i.kind === inbox.KINDS.INTERNAL_REFERRAL);
  assert.equal(other.actionable, false);
  assert.equal(other.waitingOn, 'Courtney Hale');
  const done = { ...order, status: 'completed' };
  assert.equal(inbox.buildInbox({ viewer: { id: 'cm1' }, orders: [done] }).items.length, 0, 'a completed referral leaves the inbox');
  const outside = { ...order, referral: { ...order.referral, destination: 'external' } };
  assert.equal(inbox.buildInbox({ viewer: { id: 'cm1' }, orders: [outside] }).items.length, 0);
});

// ── 7. The saved provider list ───────────────────────────────────────────────

test('a saved provider needs a name and a valid fax', () => {
  assert.equal(dir.buildProviderEntry({ id: 'x', input: { fax: '4045550123' } }).code, 'REFERRAL_PROVIDER_NO_NAME');
  assert.equal(dir.buildProviderEntry({ id: 'x', input: { practice: 'Atlanta Cardiology', fax: '555' } }).code, 'REFERRAL_PROVIDER_BAD_FAX');
  const e = dir.buildProviderEntry({ id: 'x', at: AT, actor: PROVIDER, input: { practice: 'Atlanta Cardiology', fax: '1 (404) 555-0123', specialty: 'Cardiology' } }).entry;
  assert.equal(e.fax, '4045550123');
  assert.equal(e.createdBy.name, 'Bethel Godwins');
  assert.equal(e.active, true);
});

test('editing a saved fax needs a reason and is kept in history; stray keys are refused', () => {
  const e = dir.buildProviderEntry({ id: 'x', at: AT, input: { practice: 'Atlanta Cardiology', fax: '4045550123' } }).entry;
  assert.equal(dir.applyProviderEdit({ entry: e, actor: PROVIDER, input: { fax: '4045550199' } }).code, 'REFERRAL_PROVIDER_REASON_REQUIRED');
  const edited = dir.applyProviderEdit({ entry: e, actor: PROVIDER, at: AT, input: { fax: '4045550199', changeReason: 'Practice confirmed a new referral fax' } });
  assert.equal(edited.entry.fax, '4045550199');
  assert.equal(edited.faxChanged, true);
  assert.deepEqual(edited.entry.history[0].changes[0], { field: 'fax', label: 'Fax', from: '4045550123', to: '4045550199' });
  assert.equal(edited.entry.history[0].reason, 'Practice confirmed a new referral fax');
  assert.ok(dir.applyProviderEdit({ entry: e, actor: PROVIDER, input: { phone: '4045551000' } }).entry, 'a phone change needs no reason');
  assert.equal(dir.applyProviderEdit({ entry: e, actor: PROVIDER, input: { clientId: 'c1' } }).code, 'REFERRAL_PROVIDER_FIELD_UNKNOWN');
  assert.equal(dir.applyProviderEdit({ entry: e, actor: PROVIDER, input: { practice: 'Atlanta Cardiology' } }).code, 'REFERRAL_PROVIDER_NO_CHANGE');
});

test('placing a referral to a saved provider never changes the saved entry', () => {
  const saved = { id: 'sp1', name: 'Dr Patel', practice: 'Atlanta Cardiology', specialty: 'Cardiology', fax: '4045550123', phone: '4045551000', active: true };
  const typedOver = orderReq.buildReferral({
    id: 'o3', clientId: 'c1', encounterUuid: 'e1', actor: PROVIDER, encounterDiagnoses: DX, provider: saved,
    input: { destination: 'external', referralProviderId: 'sp1', receivingFax: '4045550777', reason: 'Chest pain', clinicalSummary: 'Q', diagnosisCodes: ['E11.9'] }
  }).order;
  assert.equal(typedOver.referral.receivingFax, '4045550777', 'what was typed for this referral wins');
  assert.equal(typedOver.referral.receivingPractice, 'Atlanta Cardiology', 'blanks come from the saved entry');
  assert.equal(typedOver.referral.specialty, 'Cardiology');
  assert.equal(typedOver.referral.referralProviderId, 'sp1');
  assert.equal(saved.fax, '4045550123', 'the saved entry is untouched');
  // And the after-save step only bumps its use, never its fields.
  const used = dir.markUsed(saved, AT);
  assert.equal(used.fax, '4045550123');
  assert.equal(used.useCount, 1);
});

test('duplicates are caught by fax, and the list is seeded once from past referrals', () => {
  const rows = [
    { id: 'a', practice: 'Atlanta Cardiology', name: null, fax: '4045550123', active: true },
    { id: 'b', practice: 'Old Place', fax: '4045550999', active: false }
  ];
  assert.deepEqual(dir.findByFax(rows, '(404) 555-0123').map(e => e.id), ['a']);
  assert.deepEqual(dir.findByFax(rows, '4045550999'), [], 'a removed entry is not a match');
  assert.equal(dir.sameEntry(rows[0], { practice: 'atlanta cardiology', fax: '4045550123' }), true);
  assert.equal(dir.sameEntry(rows[0], { practice: 'Atlanta Cardiology', name: 'Dr Patel', fax: '4045550123' }), false, 'a second doctor at one practice is a different entry');
  let n = 0;
  const makeId = () => `s${++n}`;
  const orders = [
    { orderType: 'referral', createdAt: '2026-09-01', referral: { receivingPractice: 'Northside Heart', specialty: 'Cardiology', receivingFax: '4045550123' } },
    { orderType: 'referral', createdAt: '2026-09-02', referral: { receivingPractice: 'Northside Heart', receivingFax: '4045550123' } },
    { orderType: 'referral', createdAt: '2026-09-03', referral: { receivingPractice: 'Peachtree Neuro', receivingFax: '6785550100' } },
    { orderType: 'referral', referral: { destination: 'internal', assignedTo: { id: 'cm1' } } },
    { orderType: 'referral', referral: { agencyPending: true, receivingFax: null } },
    { orderType: 'lab', tests: ['CBC'] }
  ];
  const first = dir.seedFromOrders({ entries: [], orders, makeId });
  assert.deepEqual(first.added.map(e => e.fax), ['4045550123', '6785550100'], 'one per fax; internal, faxless and labs skipped');
  const again = dir.seedFromOrders({ entries: first.entries, orders, makeId });
  assert.equal(again.added.length, 0, 'idempotent');
  const listed = dir.listForForm([...first.entries, { id: 'z', practice: 'Gone', fax: '4045550000', active: false }]);
  assert.ok(!listed.some(e => e.id === 'z'), 'removed entries are not offered');
  assert.equal(listed[0].faxFormatted, '(678) 555-0100', 'most recently used first');
});

test('the provider list collection is registered and not PHI', () => {
  const { COLLECTION_REGISTRY } = require('../dataMigration');
  const row = COLLECTION_REGISTRY.find(r => r.key === 'referral_providers');
  assert.ok(row);
  assert.equal(row.phi, false);
});

// ── 8. The after-save step, run rather than read ────────────────────────────

const liftAfterReferral = () => {
  const src = sliceBetween(SERVER, 'async function afterReferralPlaced(', '\n}\n') + '\n}\n';
  // eslint-disable-next-line no-new-func
  return (deps) => new Function(...Object.keys(deps), `${src}; return afterReferralPlaced;`)(...Object.values(deps));
};
const fakeWorld = ({ users = [], providers = [], orders = [] } = {}) => {
  const store = { users, referral_providers: providers, clinical_orders: orders };
  const notices = [];
  const deps = {
    getUsers: async () => store.users,
    loadRows: async (k) => store[k] || [],
    db: { set: async (k, v) => { store[k] = v; } },
    invalidateUsersCache: () => {},
    logActivity: async () => {},
    queueNotification: async (...args) => { notices.push(args); },
    orderReq, referralDirectory: dir,
    appLinks: require('../appLinks'),
    actorFromReq: (req) => req.user,
    uuidv4: (() => { let i = 0; return () => `id${++i}`; })()
  };
  return { store, notices, run: liftAfterReferral()(deps) };
};

test('internal: the colleague joins the care team and is emailed, once', async () => {
  const client = { id: 'c1', role: 'client', careTeam: { assignedCaseManager: 'cm0', assignedFNPs: ['p1'] } };
  const cm = { id: 'cm1', role: 'caseManager', name: 'Courtney Hale', email: 'ch@x.test' };
  const w = fakeWorld({ users: [client, cm] });
  const order = internalReferral().order;
  const warnings = [];
  const out = await w.run({ req: { user: PROVIDER, body: {} }, order, client, assigneeUser: cm, savedProvider: null, warnings });
  assert.equal(out.careTeamAdded, true);
  const stored = w.store.users.find(u => u.id === 'c1');
  assert.equal(stored.careTeam.assignedCaseManager, 'cm0');
  assert.deepEqual(stored.careTeam.supportingCaseManagers, ['cm1']);
  assert.equal(w.notices.length, 1);
  assert.equal(w.notices[0][0], 'internal_referral_assigned');
  assert.equal(w.notices[0][2], 'ch@x.test');
  assert.equal(w.notices[0][4].ctaUrl, '/clinical#inbox');
  assert.deepEqual(warnings, []);
});

test('external: a new provider is saved when asked, a fax twin is not, and a saved one is only bumped', async () => {
  const outside = (fax, extra = {}) => orderReq.buildReferral({
    id: 'o9', clientId: 'c1', encounterUuid: 'e1', actor: PROVIDER, encounterDiagnoses: DX,
    input: { specialty: 'Psychiatry', receivingPractice: 'Midtown Psych', receivingFax: fax, reason: 'R', clinicalSummary: 'Q', diagnosisCodes: ['F32.9'], ...extra }
  }).order;
  // New and asked to save.
  const o1 = outside('4045550123');
  const w1 = fakeWorld({ orders: [o1] });
  const out1 = await w1.run({ req: { user: PROVIDER, body: { saveProvider: true } }, order: o1, client: { id: 'c1' }, warnings: [] });
  assert.equal(w1.store.referral_providers.length, 1);
  assert.equal(w1.store.referral_providers[0].practice, 'Midtown Psych');
  assert.equal(w1.store.referral_providers[0].useCount, 1);
  assert.equal(w1.store.clinical_orders[0].referral.referralProviderId, out1.referralProviderId, 'the order is linked to the entry');
  // Not asked to save: nothing written.
  const w2 = fakeWorld({ orders: [o1] });
  await w2.run({ req: { user: PROVIDER, body: {} }, order: o1, client: { id: 'c1' }, warnings: [] });
  assert.equal(w2.store.referral_providers.length, 0);
  // A different name on a fax already saved: warned, not duplicated.
  const twin = { id: 'sp1', practice: 'Other Practice', fax: '4045550123', active: true };
  const w3 = fakeWorld({ providers: [twin], orders: [o1] });
  const warnings3 = [];
  await w3.run({ req: { user: PROVIDER, body: { saveProvider: true } }, order: o1, client: { id: 'c1' }, warnings: warnings3 });
  assert.equal(w3.store.referral_providers.length, 1);
  assert.match(warnings3[0], /already uses that fax/);
  // Saved provider used: bumped, fields unchanged.
  const w4 = fakeWorld({ providers: [{ ...twin }], orders: [o1] });
  await w4.run({ req: { user: PROVIDER, body: {} }, order: o1, client: { id: 'c1' }, savedProvider: twin, warnings: [] });
  assert.equal(w4.store.referral_providers[0].useCount, 1);
  assert.equal(w4.store.referral_providers[0].practice, 'Other Practice');
});

// ── 9. The page draws what the server answers ───────────────────────────────

test('the page offers accept, complete and cancel only where the server says so', () => {
  const view = sliceBetween(SERVER, 'const orderForViewer = (o, user) => {', '\n};\n');
  assert.match(view, /acceptOrComplete: !!to && !!user && String\(to\.id\) === String\(user\.id\)/);
  assert.match(view, /coordinate: !internal && clinicalRoles\.canCoordinateOrder\(user, o\)/);
  assert.match(view, /cancel: clinicalRoles\.canCoordinateOrder\(user, o\) &&/);
  assert.match(PAGE_CODE, /const mine = !!\(order\.can && order\.can\.acceptOrComplete\);/);
  assert.match(PAGE_CODE, /if \(!\(order\.can && order\.can\.cancel\) \|\| !onCancel\) return null;/);
  assert.match(PAGE_CODE, /disabled=\{busy \|\| !reason\.trim\(\)\}/, 'Confirm Cancel waits for a reason');
  assert.match(PAGE_CODE, /disabled=\{busy \|\| !note\.trim\(\)\}/, 'Complete Referral waits for a note');
  // Concise, Title Case button labels.
  for (const label of ['Cancel Order', 'Confirm Cancel', 'Keep Order', 'Accept', 'Mark Complete', 'Complete Referral', 'Send Referral', 'Edit Saved Provider', 'Save Provider', 'Use Saved Provider', '+ New Provider']) {
    assert.ok(PAGE_CODE.includes(label), `the page carries the "${label}" control`);
  }
  assert.ok(!PAGE_CODE.includes('mark {(ORDER_LABEL[n] || n).toLowerCase()}'), 'the old lowercase "mark cancelled" chip is gone');
});

test('the Refer to list is served, never decided in the page', () => {
  const route = sliceBetween(SERVER, "app.get('/api/clinical/patients/:clientId/referral-targets'", 'catch (error)');
  assert.match(route, /requireClinicalRead/);
  assert.match(route, /clinicalRoles\.isReferralTarget\(u\) && String\(u\.id\) !== String\(req\.user\.id\)/);
  assert.match(route, /canReferExternal: clinicalRoles\.canRefer\(req\.user, orderReq\.EXTERNAL\)/);
  assert.match(PAGE_CODE, /const team = \(targets && targets\.canReferInternal && targets\.internal\) \|\| \[\];/);
  assert.match(PAGE_CODE, /const saved = \(targets && targets\.canReferExternal && targets\.external\) \|\| \[\];/);
  assert.match(PAGE_CODE, /\{canExternal && <option value="new">\+ New Provider<\/option>\}/);
  // A referral target must be active and licensed; an office admin account is skipped.
  assert.equal(roles.isReferralTarget({ id: 'x', role: 'user', clinicalRole: 'lmsw', accountStatus: 'inactive' }), false);
  assert.equal(roles.isReferralTarget({ id: 'x', role: 'caseManager', clinicalRole: 'readOnly' }), false);
  assert.equal(roles.isReferralTarget({ id: 'x', role: 'admin' }), false);
  assert.equal(roles.isReferralTarget({ id: 'x', role: 'admin', npi: '1902310568' }), true);
  assert.equal(roles.isReferralTarget(CASE_MANAGER), true);
  assert.equal(roles.isReferralTarget({ id: 'x', role: 'client' }), false);
});
