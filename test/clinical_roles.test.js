// test/clinical_roles.test.js — Session 4.8
//
// Credential-scoped clinical roles and standing orders.
//
// Every acceptance test in the §6 brief is here. The behavioural half runs the
// real functions; the route half parses server.js, which is this repo's
// established pattern for routes that live in server.js and cannot be required
// without booting a server.
//
// MUTATION-CHECKED. Each guard below was confirmed to FAIL when the rule it
// guards is put back the old way — the house rule this repo has now paid for
// five times: a test whose assertion cannot distinguish the two states proves
// nothing, and looking correct is not the same as failing when it should.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const roles = require('../clinicalRoles');
const so = require('../standingOrders');

const root = path.join(__dirname, '..');
const serverSrc = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

const PROVIDER = { id: 'p1', name: 'Bethel Godwins', role: 'user', clinicalRole: 'provider', licenseLevel: 'FNP', npi: '1902310568' };
const RN = { id: 'n1', name: 'Ruth Nolan', role: 'user', clinicalRole: 'rn', licenseLevel: 'RN' };
const LCSW = { id: 'l1', name: 'Lena Cole', role: 'user', clinicalRole: 'lcsw', licenseLevel: 'LCSW' };
const LMSW = { id: 'm1', name: 'Mara Shaw', role: 'caseManager', clinicalRole: 'lmsw', licenseLevel: 'LMSW' };
const READ_ONLY = { id: 'r1', name: 'Casey Reed', role: 'caseManager', clinicalRole: 'readOnly' };
const ADMIN = { id: 'a1', name: 'Owner', role: 'admin' };
const CLIENT = { id: 'c1', name: 'A Client', role: 'client' };

// ---- 1. The permission matrix, implemented exactly ----------------------

test('the capability matrix matches the brief cell for cell', () => {
  const C = roles.CAPABILITIES;
  const cell = (u, cap) => roles.can(u, cap);

  // Chart read — everyone with a clinical role, readOnly included.
  for (const u of [PROVIDER, RN, LCSW, LMSW, READ_ONLY]) assert.equal(cell(u, C.CHART_READ), true, `${u.clinicalRole} chart read`);
  assert.equal(cell(CLIENT, C.CHART_READ), false, 'a client has no clinical role at all');

  // Vitals / nursing note / med rec / problem list — provider + RN.
  for (const cap of [C.VITALS_WRITE, C.NURSING_NOTE, C.MED_REC, C.PROBLEM_LIST_WRITE]) {
    assert.equal(cell(PROVIDER, cap), true, cap); assert.equal(cell(RN, cap), true, cap);
    assert.equal(cell(LCSW, cap), false, cap); assert.equal(cell(LMSW, cap), false, cap);
    assert.equal(cell(READ_ONLY, cap), false, cap);
  }
  // Behavioural note — provider + LCSW + LMSW, never the RN.
  assert.equal(cell(PROVIDER, C.BEHAVIORAL_NOTE), true);
  assert.equal(cell(RN, C.BEHAVIORAL_NOTE), false);
  assert.equal(cell(LCSW, C.BEHAVIORAL_NOTE), true);
  assert.equal(cell(LMSW, C.BEHAVIORAL_NOTE), true);
  // Screening, care-plan author, document upload, scheduling — all four licensed.
  for (const cap of [C.SCREENING_INSTRUMENT, C.CARE_PLAN_AUTHOR, C.DOCUMENT_UPLOAD, C.SCHEDULING]) {
    for (const u of [PROVIDER, RN, LCSW, LMSW]) assert.equal(cell(u, cap), true, `${u.clinicalRole} ${cap}`);
    assert.equal(cell(READ_ONLY, cap), false, cap);
  }
  // Order status advance — provider + RN.
  assert.equal(cell(RN, C.ORDER_STATUS_ADVANCE), true);
  assert.equal(cell(LCSW, C.ORDER_STATUS_ADVANCE), false);
  // The four that are the point of this session.
  for (const cap of [C.PRESCRIBE, C.ORDER_DIRECT, C.ACKNOWLEDGE_ABNORMAL_RESULT, C.AUTHOR_STANDING_ORDER]) {
    assert.equal(cell(PROVIDER, cap), true, cap);
    for (const u of [RN, LCSW, LMSW, READ_ONLY]) assert.equal(cell(u, cap), false, `${u.clinicalRole} must not ${cap}`);
  }
  // Under a standing order, the three non-provider licensed roles may order.
  for (const u of [PROVIDER, RN, LCSW, LMSW]) assert.equal(cell(u, C.ORDER_STANDING), true);
  assert.equal(cell(READ_ONLY, C.ORDER_STANDING), false);
  // CPT selection + billable signing: provider, and LCSW for the BH set only
  // (the set itself is checked separately, below).
  assert.equal(cell(PROVIDER, C.SELECT_SERVICE_CODES), true);
  assert.equal(cell(LCSW, C.SELECT_SERVICE_CODES), true);
  assert.equal(cell(RN, C.SELECT_SERVICE_CODES), false);
  assert.equal(cell(LMSW, C.SELECT_SERVICE_CODES), false);
});

test('the matrix is an ALLOW-LIST — a capability nobody was granted is refused for everyone', () => {
  for (const u of [PROVIDER, RN, LCSW, LMSW, READ_ONLY, ADMIN]) {
    assert.equal(roles.can(u, 'someCapabilityAddedNextSession'), false);
  }
});

// ── REPOINTED IN SESSION 4.10, NOT DELETED ────────────────────────────────
// 4.8 wrote this as "results review has no route yet, so nothing can grant it
// by accident": the capability existed with nothing behind it, and the test
// failed the build if a route appeared without a gate. 4.10 built that route.
//
// The rule it protected — THE CAPABILITY IS WHAT DECIDES WHO CLINICALLY
// ACKNOWLEDGES A RESULT — has not gone away, so the assertion turns around and
// pins it from the other side. A protection that quietly disappears with the
// code it happened to point at is a protection lost.
test('the results route acknowledges through ACKNOWLEDGE_ABNORMAL_RESULT, never a role check of its own', () => {
  const results = require('../clinicalResults');
  // The decision lives in clinicalResults.canAcknowledge and it asks the
  // capability matrix — it does not compare a clinicalRole string itself.
  assert.ok(/ACKNOWLEDGE_ABNORMAL_RESULT/.test(fs.readFileSync(path.join(__dirname, '..', 'clinicalResults.js'), 'utf8')),
    'the acknowledge decision must go through the capability, not a hand-rolled role list');
  // An abnormal or critical result needs the capability; nobody without it may
  // clinically acknowledge one, whatever else their credential carries.
  for (const interpretation of ['abnormal', 'critical']) {
    assert.equal(results.canAcknowledge(PROVIDER, interpretation), true);
    assert.equal(results.canAcknowledge(RN, interpretation), false);
    assert.equal(results.canAcknowledge(LCSW, interpretation), false);
    assert.equal(results.canAcknowledge(LMSW, interpretation), false);
    assert.equal(results.canAcknowledge(READ_ONLY, interpretation), false);
    assert.equal(results.canAcknowledge(null, interpretation), false);
  }
  // A NORMAL result is acknowledged by anyone licensed to write in the chart —
  // gating it on the provider capability too would leave an inbox nobody but a
  // provider could ever empty, and an inbox that does not empty is one nobody
  // reads. `readOnly` is still refused: it is not a licence.
  assert.equal(results.canAcknowledge(RN, 'normal'), true);
  assert.equal(results.canAcknowledge(READ_ONLY, 'normal'), false);
  // And the server route still runs that decision rather than restating it.
  assert.ok(/clinicalResults\.applyAcknowledgement/.test(serverSrc),
    'the acknowledge route must delegate to applyAcknowledgement');
});

// ---- 2. Acceptance: prescribing and direct ordering ---------------------

test('an rn calling the prescriptions endpoint gets 403 with a credential reason', () => {
  assert.equal(roles.can(RN, roles.CAPABILITIES.PRESCRIBE), false);
  const refusal = roles.refusalFor(RN, roles.CAPABILITIES.PRESCRIBE);
  assert.equal(refusal.code, 'CLINICAL_CREDENTIAL');
  assert.match(refusal.error, /provider/i, 'the refusal names the credential, not just "forbidden"');
  assert.equal(refusal.clinicalRole, 'rn');
  // ...and the route carries the gate.
  const line = serverSrc.split('\n').find(l => l.includes("encounters/:euuid/prescriptions'") && l.startsWith('app.'));
  assert.match(line, /requireCapability\(clinicalRoles\.CAPABILITIES\.PRESCRIBE\)/,
    'the prescriptions route must gate on PRESCRIBE');
});

test('an rn placing a DIRECT order is refused; the same order under a standing order is not', () => {
  assert.equal(roles.can(RN, roles.CAPABILITIES.ORDER_DIRECT), false);
  assert.equal(roles.can(RN, roles.CAPABILITIES.ORDER_STANDING), true);
  assert.match(roles.refusalFor(RN, roles.CAPABILITIES.ORDER_DIRECT).error, /standing order/i,
    'the refusal points at the route that IS open to them');
  // The route branches on standingOrderId — direct is provider-only, and the
  // standing-order half goes through standingOrders.authorizeExecution.
  const orders = serverSrc.slice(serverSrc.indexOf("encounters/:euuid/orders'"), serverSrc.indexOf("app.post('/api/clinical/orders/:orderId/status'"));
  assert.match(orders, /standingOrders\.authorizeExecution\(/, 'the standing-order branch authorizes through the module');
  assert.match(orders, /CAPABILITIES\.ORDER_DIRECT/, 'the no-protocol branch is provider-only');
});

// ---- 3. Acceptance: the credential ceiling ------------------------------

test('an lmsw executing a screening protocol that names lmsw succeeds', () => {
  const protocol = activeProtocol({ permittedOrderTypes: ['screening'], permittedExecutorRoles: ['lmsw'], permittedTests: ['PHQ-9', 'GAD-7'] });
  const r = so.authorizeExecution({ standingOrder: protocol, actor: LMSW, orderType: 'screening', tests: ['PHQ-9'], diagnosisCodes: ['F32.9'], clientId: 'c1' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.authority, 'standing_order');
});

test('an lmsw executing a LAB protocol that wrongly names lmsw is refused BY THE CEILING', () => {
  // THE test that proves a mis-authored protocol cannot extend a licence. The
  // protocol names lmsw and permits a CBC; the licence does not carry labs.
  const protocol = activeProtocol({ permittedOrderTypes: ['lab'], permittedExecutorRoles: ['lmsw'], permittedTests: ['CBC'] });
  const r = so.authorizeExecution({ standingOrder: protocol, actor: LMSW, orderType: 'lab', tests: ['CBC'], diagnosisCodes: ['F32.9'], clientId: 'c1' });
  assert.ok(r.error, 'a signed protocol is not a licence extension');
  assert.equal(r.code, 'CREDENTIAL_CEILING');
  assert.equal(r.status, 403);
  assert.deepEqual(r.ceiling, ['screening']);
  // The role check PASSED and the ceiling still refused — that independence is
  // the whole point. If the ceiling were folded into permittedExecutorRoles
  // this would have succeeded.
  assert.ok(protocol.permittedExecutorRoles.includes('lmsw'));
});

test('the ceiling is per credential and is checked independently of any protocol', () => {
  assert.deepEqual(roles.ceilingFor('rn').slice().sort(), ['imaging', 'lab', 'procedure', 'screening']);
  assert.deepEqual(roles.ceilingFor('lcsw'), ['screening']);
  assert.deepEqual(roles.ceilingFor('lmsw'), ['screening']);
  assert.deepEqual(roles.ceilingFor('readOnly'), []);
  assert.equal(roles.withinCredentialCeiling('lcsw', ['lab']).ok, false);
  assert.equal(roles.withinCredentialCeiling('rn', ['lab', 'imaging']).ok, true);
  assert.deepEqual(roles.withinCredentialCeiling('lmsw', ['screening', 'procedure']).outside, ['procedure']);
});

// ---- 4. Acceptance: the LMSW billing rule -------------------------------

test('an lmsw encounter carrying a service code is pendingCoSign and not billable', () => {
  const r = roles.evaluateEncounterSignature(LMSW, [{ code: '90834' }]);
  assert.equal(r.outcome, roles.SIGN_OUTCOME.PENDING_CO_SIGN);
  assert.equal(r.billable, false);
  assert.match(r.reason, /does not sign/i);
});

test('an lmsw NEVER completes a signature, even on a plain codeless note (owner switch, 2026-09-24)', () => {
  // "Only FNP, RN, MD is able to sign" — an LMSW's documentation always waits
  // on a co-signer, whether or not anything would ever bill. The old carve-out
  // for a codeless note (ALLOWED, "nothing to hold") is gone.
  const r = roles.evaluateEncounterSignature(LMSW, []);
  assert.equal(r.outcome, roles.SIGN_OUTCOME.PENDING_CO_SIGN);
  assert.equal(r.billable, false);
  assert.equal(r.signatureRole, 'authoring');
  assert.match(r.reason, /does not sign/i);
});

test('an lcsw or provider clears the hold; an lmsw cannot clear their own', () => {
  assert.equal(roles.canCoSignEncounter(LCSW), true);
  assert.equal(roles.canCoSignEncounter(PROVIDER), true);
  assert.equal(roles.canCoSignEncounter(LMSW), false, 'A10 bills nothing independently — including by co-signing itself');
  assert.equal(roles.canCoSignEncounter(RN), false);
  assert.equal(roles.canCoSignEncounter(READ_ONLY), false);
});

test('the charge is HELD at sign and RELEASED at co-sign, in one shared code path', () => {
  const sign = serverSrc.slice(serverSrc.indexOf("encounters/:euuid/sign'"), serverSrc.indexOf("encounters/:euuid/co-sign'"));
  assert.match(sign, /SIGN_OUTCOME\.PENDING_CO_SIGN/, 'the sign route recognises the hold');
  assert.match(sign, /chargeError = 'PENDING_CO_SIGN'/, 'and marks WHY the charge did not post');
  const coSign = serverSrc.slice(serverSrc.indexOf("encounters/:euuid/co-sign'"), serverSrc.indexOf("// ── Standing orders"));
  assert.match(coSign, /postEncounterCharges\(/, 'the co-signature posts the charge');
  assert.match(coSign, /CO_SIGN_SELF/, 'a co-signature that can be self-issued is not a co-signature');
  // Sign and co-sign share ONE charge path — two copies is how one starts
  // double-billing what the other skips. (The re-post route is a deliberate
  // third path: it skips lines already posted, which is its whole job.)
  assert.ok(!/buildChargePayloads\(/.test(sign), 'the sign route must go through the shared helper');
  assert.ok(!/buildChargePayloads\(/.test(coSign), 'and so must the co-sign route');
});

// ---- 5. Acceptance: the code set ----------------------------------------

test('an lcsw selecting an E/M code is refused; the behavioural-health set is permitted', () => {
  assert.deepEqual(roles.disallowedServiceCodesFor(LCSW, [{ code: '90834' }, { code: '96127' }]), [],
    'the BH set is theirs');
  const bad = roles.disallowedServiceCodesFor(LCSW, [{ code: '99348' }]);
  assert.deepEqual(bad, ['99348']);
  assert.match(roles.serviceCodeRefusal(LCSW, bad), /evaluation and management/i,
    'the refusal says WHY, not just that it is not on a list');
  // A provider selects anything; an RN or LMSW selects nothing at all.
  assert.deepEqual(roles.disallowedServiceCodesFor(PROVIDER, [{ code: '99348' }, { code: '90834' }]), []);
  assert.deepEqual(roles.disallowedServiceCodesFor(RN, [{ code: '99348' }]), ['99348']);
  assert.deepEqual(roles.disallowedServiceCodesFor(LMSW, [{ code: '90834' }]), ['90834'],
    'an LMSW selects no service code, BH set included — they bill nothing independently');
});

test('the code set FAILS CLOSED — an unknown code is refused for a narrowed credential', () => {
  // Guessing permissively here puts a claim in Billing Manager signed by
  // someone not certified to render it.
  assert.deepEqual(roles.disallowedServiceCodesFor(LCSW, [{ code: 'ZZ999' }]), ['ZZ999']);
  assert.deepEqual(roles.disallowedServiceCodesFor(LCSW, [{ code: '' }]), [], 'a blank list is not a refusal');
});

test('signing branches on WHAT THE ENCOUNTER CARRIES, not only on who is asking', () => {
  // An rn signing an encounter with a CPT code gets 403; the same rn signing a
  // nursing note with no service code succeeds.
  const billable = roles.evaluateEncounterSignature(RN, [{ code: '99348' }]);
  assert.equal(billable.outcome, roles.SIGN_OUTCOME.REFUSED);
  assert.equal(billable.code, 'SIGN_CREDENTIAL_BILLABLE');
  assert.match(billable.reason, /99348/, 'the refusal names the code that makes it billable');
  const nursing = roles.evaluateEncounterSignature(RN, []);
  assert.equal(nursing.outcome, roles.SIGN_OUTCOME.ALLOWED);
  // An LCSW signs the BH set and is refused an E/M encounter.
  assert.equal(roles.evaluateEncounterSignature(LCSW, [{ code: '90834' }]).outcome, roles.SIGN_OUTCOME.ALLOWED);
  assert.equal(roles.evaluateEncounterSignature(LCSW, [{ code: '99348' }]).code, 'SIGN_CREDENTIAL_CODE_SET');
  // readOnly signs nothing, ever.
  assert.equal(roles.evaluateEncounterSignature(READ_ONLY, []).outcome, roles.SIGN_OUTCOME.REFUSED);
  // The route reads the record's services, not the route's own assumption.
  const sign = serverSrc.slice(serverSrc.indexOf("encounters/:euuid/sign'"), serverSrc.indexOf("encounters/:euuid/co-sign'"));
  assert.match(sign, /evaluateEncounterSignature\(req\.user, ctx\.record\.services/,
    'gate on what is being attested — read off the record');
});

// ---- 6. Acceptance: the care-plan signature branch ----------------------

test('a Track A care plan signed by an rn is complete; an IHPC one is pending provider co-signature', () => {
  const phc = roles.evaluateCarePlanSignature(RN, 'PHC');
  assert.equal(phc.outcome, roles.CARE_PLAN_OUTCOME.COMPLETE);
  assert.equal(phc.signatureRole, 'signing');
  const ihpc = roles.evaluateCarePlanSignature(RN, 'IHPC');
  assert.equal(ihpc.outcome, roles.CARE_PLAN_OUTCOME.PENDING_PROVIDER);
  assert.equal(ihpc.signatureRole, 'authoring', 'the RN signature is RECORDED, as the authoring signature');
  assert.equal(roles.evaluateCarePlanSignature(RN, 'BOTH').outcome, roles.CARE_PLAN_OUTCOME.PENDING_PROVIDER,
    'a dual-lane client is on the clinical line too');
  // A provider completes it on either line; an LMSW never completes one alone.
  assert.equal(roles.evaluateCarePlanSignature(PROVIDER, 'IHPC').outcome, roles.CARE_PLAN_OUTCOME.COMPLETE);
  assert.equal(roles.evaluateCarePlanSignature(LMSW, 'PHC').outcome, roles.CARE_PLAN_OUTCOME.PENDING_PROVIDER);
  assert.equal(roles.evaluateCarePlanSignature(READ_ONLY, 'PHC').outcome, roles.CARE_PLAN_OUTCOME.REFUSED);
  // And the route branches on the CLIENT's service line, not the actor's.
  const route = serverSrc.slice(serverSrc.indexOf("app.post('/api/clinical/patients/:clientId/care-plan'"), serverSrc.indexOf('care-plan/provider-cosign'));
  assert.match(route, /evaluateCarePlanSignature\(req\.user, client\.serviceLine\)/);
  assert.match(route, /providerCoSignStatus/, 'the pending state is stored, not just reported');
});

test('the pending provider co-signature has something that clears it', () => {
  // A field nothing ever clears is a field left inert — the trap this repo
  // named over the competency ceiling a week earlier.
  assert.ok(serverSrc.includes("care-plan/provider-cosign'"), 'the co-sign route exists');
  const route = serverSrc.slice(serverSrc.indexOf("care-plan/provider-cosign'"), serverSrc.indexOf("care-plan/provider-cosign'") + 4000);
  assert.match(route, /CARE_PLAN_NOT_PENDING_PROVIDER/, 'it refuses a plan that is not waiting');
  assert.match(route, /providerSignature/, 'the provider signature is ADDED beside the authoring one');
  assert.doesNotMatch(route, /rnSignature:/, 'the authoring signature is never overwritten');
});

// ---- 7. Standing orders: the document rules (§4) ------------------------

const FUTURE = new Date(Date.now() + 365 * 86400000).toISOString();
const PAST = new Date(Date.now() - 86400000).toISOString();
const SIG = 'data:image/png;base64,AAAA';
const protocolInput = (extra) => ({
  title: 'Depression screening', permittedOrderTypes: ['screening'], permittedTests: ['PHQ-9', 'GAD-7'],
  permittedExecutorRoles: ['lmsw', 'lcsw'], indications: ['F32.9'], expiresAt: FUTURE,
  status: 'active', signatureImage: SIG, ...extra
});
function activeProtocol(extra) {
  const built = so.buildStandingOrder({ id: 'sop-1', input: protocolInput(extra), author: PROVIDER });
  assert.ok(built.standingOrder, built.error);
  return built.standingOrder;
}

test('only a provider may author, sign or revise a standing order', () => {
  for (const u of [RN, LCSW, LMSW, READ_ONLY, CLIENT]) {
    const r = so.buildStandingOrder({ id: 'x', input: protocolInput(), author: u });
    assert.equal(r.code, 'STANDING_ORDER_NOT_PROVIDER', `${u.clinicalRole || 'none'} must not author`);
  }
  assert.ok(so.buildStandingOrder({ id: 'x', input: protocolInput(), author: PROVIDER }).standingOrder);
  // And the routes gate on the same capability, not on a role string.
  for (const p of ["app.post('/api/clinical/standing-orders'", "standing-orders/:id/revise'", "standing-orders/:id/status'"]) {
    const line = serverSrc.split('\n').find(l => l.includes(p));
    assert.match(line, /requireCapability\(clinicalRoles\.CAPABILITIES\.AUTHOR_STANDING_ORDER\)/, p);
  }
});

test('expiresAt is required, and permittedExecutorRoles cannot be empty', () => {
  assert.equal(so.buildStandingOrder({ id: 'x', input: protocolInput({ expiresAt: undefined }), author: PROVIDER }).code, 'STANDING_ORDER_NO_EXPIRY');
  assert.equal(so.buildStandingOrder({ id: 'x', input: protocolInput({ permittedExecutorRoles: [] }), author: PROVIDER }).code, 'STANDING_ORDER_NO_EXECUTORS');
  assert.equal(so.buildStandingOrder({ id: 'x', input: protocolInput({ permittedExecutorRoles: ['provider'] }), author: PROVIDER }).code, 'STANDING_ORDER_NO_EXECUTORS',
    'a provider needs no protocol, so naming one as an executor names nobody');
  assert.equal(so.buildStandingOrder({ id: 'x', input: protocolInput({ permittedTests: [] }), author: PROVIDER }).code, 'STANDING_ORDER_NO_TESTS');
  assert.equal(so.buildStandingOrder({ id: 'x', input: protocolInput({ indications: [] }), author: PROVIDER }).code, 'STANDING_ORDER_NO_INDICATIONS');
  assert.equal(so.buildStandingOrder({ id: 'x', input: protocolInput({ expiresAt: PAST }), author: PROVIDER }).code, 'STANDING_ORDER_BAD_DATES');
});

test('an unsigned protocol cannot be activated, and a draft cannot be executed', () => {
  assert.equal(so.buildStandingOrder({ id: 'x', input: protocolInput({ signatureImage: null }), author: PROVIDER }).code, 'STANDING_ORDER_UNSIGNED');
  const draft = so.buildStandingOrder({ id: 'x', input: protocolInput({ status: 'draft', signatureImage: null }), author: PROVIDER }).standingOrder;
  const r = so.authorizeExecution({ standingOrder: draft, actor: LMSW, orderType: 'screening', tests: ['PHQ-9'], diagnosisCodes: ['F32.9'], clientId: 'c1' });
  assert.equal(r.code, 'STANDING_ORDER_DRAFT');
});

test('an expired standing order refuses execution', () => {
  const p = activeProtocol();
  const after = new Date(new Date(p.expiresAt).getTime() + 86400000).toISOString();
  assert.equal(so.effectiveStatus(p, after), 'expired', 'expiry is DERIVED, so it lapses without a sweep job having run');
  const r = so.authorizeExecution({ standingOrder: p, actor: LMSW, orderType: 'screening', tests: ['PHQ-9'], diagnosisCodes: ['F32.9'], clientId: 'c1', at: after });
  assert.equal(r.code, 'STANDING_ORDER_EXPIRED');
  assert.equal(r.status, 409);
  assert.match(r.error, /revise/i, 'the refusal says what fixes it');
});

test('a test not in permittedTests is refused even when posted directly to the API', () => {
  const p = activeProtocol();
  const r = so.authorizeExecution({ standingOrder: p, actor: LMSW, orderType: 'screening', tests: ['PHQ-9', 'CBC with differential'], diagnosisCodes: ['F32.9'], clientId: 'c1' });
  assert.equal(r.code, 'STANDING_ORDER_TEST_NOT_PERMITTED');
  assert.deepEqual(r.outside, ['CBC with differential']);
  assert.match(r.error, /PHQ-9/, 'and it lists what IS permitted');
});

test('an order under a protocol must link to one of its indications', () => {
  const p = activeProtocol();
  const r = so.authorizeExecution({ standingOrder: p, actor: LMSW, orderType: 'screening', tests: ['PHQ-9'], diagnosisCodes: ['E11.9'], clientId: 'c1' });
  assert.equal(r.code, 'STANDING_ORDER_NO_MATCHING_INDICATION');
  // One match is enough — the existing encounter-diagnosis rule still applies
  // on top, it is not replaced.
  assert.equal(so.authorizeExecution({ standingOrder: p, actor: LMSW, orderType: 'screening', tests: ['PHQ-9'], diagnosisCodes: ['E11.9', 'F32.9'], clientId: 'c1' }).ok, true);
});

test('a named-scope protocol reaches only the clients it names', () => {
  const p = activeProtocol({ patientScope: 'named', namedClientIds: ['c1'] });
  assert.equal(so.authorizeExecution({ standingOrder: p, actor: LMSW, orderType: 'screening', tests: ['PHQ-9'], diagnosisCodes: ['F32.9'], clientId: 'c1' }).ok, true);
  assert.equal(so.authorizeExecution({ standingOrder: p, actor: LMSW, orderType: 'screening', tests: ['PHQ-9'], diagnosisCodes: ['F32.9'], clientId: 'c2' }).code, 'STANDING_ORDER_CLIENT_NOT_IN_SCOPE');
  assert.equal(so.buildStandingOrder({ id: 'x', input: protocolInput({ patientScope: 'named', namedClientIds: [] }), author: PROVIDER }).code, 'STANDING_ORDER_NO_CLIENTS');
});

test('a role the protocol does not name is refused even when its licence would allow the work', () => {
  const p = activeProtocol({ permittedOrderTypes: ['screening'], permittedExecutorRoles: ['lmsw'] });
  // An RN's licence covers screening, but this protocol does not authorise them.
  assert.equal(roles.withinCredentialCeiling('rn', ['screening']).ok, true);
  assert.equal(so.authorizeExecution({ standingOrder: p, actor: RN, orderType: 'screening', tests: ['PHQ-9'], diagnosisCodes: ['F32.9'], clientId: 'c1' }).code,
    'STANDING_ORDER_ROLE_NOT_PERMITTED', 'both checks must pass, not either');
});

test('revising to v3 leaves orders executed under v2 pointing at v2', () => {
  const v1 = activeProtocol();
  const v2 = so.buildStandingOrder({ id: 'sop-2', input: protocolInput({ permittedTests: ['PHQ-9', 'GAD-7', 'SDOH'] }), author: PROVIDER, existing: v1 }).standingOrder;
  const v3 = so.buildStandingOrder({ id: 'sop-3', input: protocolInput({ permittedTests: ['PHQ-9'] }), author: PROVIDER, existing: v2 }).standingOrder;
  assert.equal(v2.version, 2); assert.equal(v3.version, 3);
  assert.equal(v2.supersedesVersionId, v1.id);
  assert.equal(v3.lineageId, v1.id, 'all three share one lineage');
  // An order executed under v2 references v2 FOREVER — the reference is the
  // row that was authorized, not a lookup of "the current version".
  const exec = so.authorizeExecution({ standingOrder: v2, actor: LMSW, orderType: 'screening', tests: ['SDOH'], diagnosisCodes: ['F32.9'], clientId: 'c1' });
  assert.equal(exec.standingOrderRef.version, 2);
  assert.equal(exec.standingOrderRef.id, v2.id);
  // v3 dropped SDOH — and that does not retroactively invalidate the v2 order.
  assert.equal(so.authorizeExecution({ standingOrder: v3, actor: LMSW, orderType: 'screening', tests: ['SDOH'], diagnosisCodes: ['F32.9'], clientId: 'c1' }).code,
    'STANDING_ORDER_TEST_NOT_PERMITTED');
  // The revise route never rewrites the old row — it retires it and appends.
  const route = serverSrc.slice(serverSrc.indexOf("standing-orders/:id/revise'"), serverSrc.indexOf("standing-orders/:id/status'"));
  assert.match(route, /status: 'retired', supersededByVersionId/);
  assert.match(route, /rows\.push\(built\.standingOrder\)/, 'the revision is a NEW row');
});

test('an order executed under a protocol records the AUTHORIZING PROVIDER as ordering clinician and the executor separately', () => {
  const p = activeProtocol();
  const r = so.authorizeExecution({ standingOrder: p, actor: LMSW, orderType: 'screening', tests: ['PHQ-9'], diagnosisCodes: ['F32.9'], clientId: 'c1' });
  assert.equal(r.orderingClinician.id, PROVIDER.id, 'legally the order is under the provider’s authority');
  assert.equal(r.orderingClinician.name, PROVIDER.name);
  assert.equal(r.orderingClinician.npi, PROVIDER.npi);
  assert.equal(r.executedBy.id, LMSW.id, 'and the acting user is recorded as who carried it out');
  assert.equal(r.executedBy.clinicalRole, 'lmsw');
  assert.notEqual(r.orderingClinician.id, r.executedBy.id);
  // The route must not then file it in OpenEMR under the nurse's provider id.
  const orders = serverSrc.slice(serverSrc.indexOf("encounters/:euuid/orders'"), serverSrc.indexOf("app.post('/api/clinical/orders/:orderId/status'"));
  assert.match(orders, /execution\.orderingClinician\.id/, 'the EMR provider follows the ordering clinician of record');
});

test('a co-sign requirement rides on the order, with a due date, and something clears it', () => {
  const p = activeProtocol({ requiresCoSign: true, coSignWithinDays: 7 });
  const r = so.authorizeExecution({ standingOrder: p, actor: LMSW, orderType: 'screening', tests: ['PHQ-9'], diagnosisCodes: ['F32.9'], clientId: 'c1', at: '2026-09-13T00:00:00.000Z' });
  assert.equal(r.coSign.coSignStatus, 'pending');
  assert.equal(r.coSign.coSignDueAt.slice(0, 10), '2026-09-20');
  const order = { id: 'o1', ...r.coSign };
  assert.equal(so.applyOrderCoSign(order, LMSW).code, 'CO_SIGN_CREDENTIAL');
  const cleared = so.applyOrderCoSign(order, LCSW).order;
  assert.equal(cleared.coSignStatus, 'cleared');
  assert.equal(so.applyOrderCoSign(cleared, LCSW).code, 'ORDER_NOT_PENDING_CO_SIGN');
  // Without requiresCoSign there is no pending state to leave hanging.
  const plain = so.authorizeExecution({ standingOrder: activeProtocol(), actor: LMSW, orderType: 'screening', tests: ['PHQ-9'], diagnosisCodes: ['F32.9'], clientId: 'c1' });
  assert.equal(plain.coSign.coSignStatus, 'not_required');
});

test('every execution writes the standing order id AND VERSION, both clinicians, tests, diagnoses and patient', () => {
  const p = activeProtocol();
  const order = { id: 'o1', orderType: 'screening', tests: ['PHQ-9'], diagnosisCodes: ['F32.9'], encounterUuid: 'enc-1', createdAt: '2026-09-13T10:00:00.000Z' };
  const audit = so.buildExecutionAudit({ order, standingOrder: p, actor: LMSW, clientId: 'c1' });
  for (const k of ['standingOrderId', 'standingOrderVersion', 'authorizingProviderId', 'executedByUserId', 'executedByCredential', 'executedByClinicalRole', 'tests', 'diagnoses', 'patientId', 'encounterUuid']) {
    assert.ok(audit[k] !== undefined && audit[k] !== null, `the audit row must carry ${k}`);
  }
  assert.equal(audit.standingOrderVersion, 1);
  assert.equal(audit.authorizingProviderId, PROVIDER.id);
  assert.equal(audit.executedByUserId, LMSW.id);
  // And the route persists it as its own durable row, not only an activity line.
  const orders = serverSrc.slice(serverSrc.indexOf("encounters/:euuid/orders'"), serverSrc.indexOf("app.post('/api/clinical/orders/:orderId/status'"));
  assert.match(orders, /db\.set\('standing_order_executions'/);
});

test('every order is anchored to an encounter — there is no patient-scoped order route', () => {
  const orderRoutes = serverSrc.split('\n')
    .filter(l => /^app\.(post|put)\('\/api\/clinical\/.*orders/.test(l))
    // standing-orders are the PROTOCOL document, not an order against a patient
    .filter(l => !l.includes('/standing-orders'));
  for (const l of orderRoutes) {
    const isExecution = l.includes("encounters/:euuid/orders'");
    const isOnExisting = /orders\/:orderId\//.test(l);
    assert.ok(isExecution || isOnExisting,
      `an order with no encounter has no clinical context and nothing to bill or audit against: ${l.slice(0, 90)}`);
  }
});

// ---- 8. Migration (§2) --------------------------------------------------

test('existing hasClinicalAccess users migrate to provider with no behaviour change', () => {
  const before = [
    { id: '1', name: 'Bethel Godwins', email: 'bethel@x.test', role: 'user', hasClinicalAccess: true },
    { id: '2', name: 'Courtney Hale', email: 'courtney@x.test', role: 'caseManager' },
    { id: '3', name: 'A Client', email: 'client@x.test', role: 'client' },
    { id: '4', name: 'A Caregiver', email: 'cg@x.test', role: 'vendor', licenseLevel: 'CNA' },
    { id: '5', name: 'Owner', email: 'owner@x.test', role: 'admin' }
  ];
  const { users, changed } = roles.applyClinicalRoleMigration(before);
  const by = (id) => users.find(u => u.id === id);
  assert.equal(by('1').clinicalRole, 'provider', 'today’s behaviour, preserved exactly');
  assert.equal(by('1').hasClinicalAccess, true);
  assert.equal(by('2').clinicalRole, 'readOnly', 'a case manager is NOT silently widened to lmsw');
  assert.equal(roles.canClinicalWrite(by('2')), false, 'and gains no clinical write');
  assert.equal(roles.canClinicalRead(by('2')), true, 'while keeping the read they already had');
  assert.equal(by('3').clinicalRole, undefined, 'a client is untouched');
  assert.equal(by('4').clinicalRole, undefined, 'a caregiver is untouched');
  assert.equal(by('5').clinicalRole, 'provider', 'the owner/MD keeps full authority');
  // Nobody is downgraded: every user who could write before still can.
  for (const u of before.filter(x => x.role === 'admin' || x.hasClinicalAccess)) {
    assert.equal(roles.canClinicalWrite(by(u.id)), true, `${u.name} must not lose write`);
  }
  // Named by name AND email, or the reassignment is undiscoverable.
  const warning = roles.buildMigrationWarning(changed);
  assert.match(warning, /Bethel Godwins <bethel@x\.test>/);
  assert.match(warning, /Courtney Hale <courtney@x\.test>/);
  assert.match(warning, /PROVIDER/);
});

test('the migration is idempotent and never overwrites a deliberate assignment', () => {
  const users = [{ id: '1', name: 'Ruth', email: 'r@x.test', role: 'user', hasClinicalAccess: true, clinicalRole: 'rn' }];
  const { users: out, changed } = roles.applyClinicalRoleMigration(users);
  assert.equal(changed.length, 0);
  assert.equal(out[0].clinicalRole, 'rn', 'an admin’s reassignment survives a re-run');
  // Re-running over its own output changes nothing.
  const once = roles.applyClinicalRoleMigration([{ id: '2', name: 'B', email: 'b@x.test', role: 'user', hasClinicalAccess: true }]);
  assert.equal(roles.applyClinicalRoleMigration(once.users).changed.length, 0);
});

test('the boot warning STANDS until an admin has actually reviewed the roles', () => {
  const migrated = roles.applyClinicalRoleMigration([{ id: '1', name: 'Ruth', email: 'r@x.test', role: 'user', hasClinicalAccess: true }]).users;
  assert.equal(migrated[0].clinicalRoleAutoAssigned, true);
  assert.equal(roles.usersPendingRoleReview(migrated).length, 1);
  assert.match(roles.buildPendingReviewWarning(roles.usersPendingRoleReview(migrated)), /Ruth <r@x\.test>/);
  // Setting the role deliberately clears it — a one-off print at migration time
  // is a warning that scrolls past.
  const reviewed = migrated.map(u => ({ ...u, clinicalRoleAutoAssigned: false }));
  assert.equal(roles.usersPendingRoleReview(reviewed).length, 0);
  assert.equal(roles.buildPendingReviewWarning([]), null);
  assert.match(serverSrc, /clinicalRoleAutoAssigned = false/, 'the user PUT clears the marker');
});

test('a user record written before this session still behaves correctly before the migration runs', () => {
  // The derived fallback, so there is no window where the app is wrong.
  assert.equal(roles.resolveClinicalRole({ role: 'user', hasClinicalAccess: true }), 'provider');
  assert.equal(roles.resolveClinicalRole({ role: 'caseManager' }), 'readOnly');
  assert.equal(roles.resolveClinicalRole({ role: 'caseManager', hasClinicalAccess: true }), 'readOnly',
    'the flag never widened a case manager and still does not');
  assert.equal(roles.resolveClinicalRole({ role: 'admin' }), 'provider');
  assert.equal(roles.resolveClinicalRole({ role: 'client' }), null);
  assert.equal(roles.resolveClinicalRole({ role: 'user', hasClinicalAccess: false }), null);
  // An unrecognised stored value falls back rather than granting something.
  assert.equal(roles.resolveClinicalRole({ role: 'user', clinicalRole: 'wizard', hasClinicalAccess: true }), 'provider');
  assert.equal(roles.resolveClinicalRole({ role: 'user', clinicalRole: 'wizard' }), null);
});

test('the clinical ACTOR carries the credential — it is narrower than req.user', () => {
  // Found by the probe, not by a unit test: actorFromReq builds a smaller
  // object than req.user, and standingOrders/clinicalRoles resolve a credential
  // from whatever they are handed. Without clinicalRole on it, every
  // module-level re-check resolved to "no role" and refused a genuine provider.
  // An object that is missing what production supplies exercises a different
  // function — the third time this repo has paid for that shape.
  const actor = serverSrc.slice(serverSrc.indexOf('const actorFromReq = (req) =>'), serverSrc.indexOf('const forEncounter ='));
  assert.match(actor, /clinicalRole: clinicalRoles\.resolveClinicalRole\(req\.user\)/);
  assert.match(actor, /hasClinicalAccess: clinicalRoles\.derivedHasClinicalAccess\(req\.user\)/);
  // And the two modules resolve from the actor, so a narrowed one would refuse.
  const soSrc = fs.readFileSync(path.join(root, 'standingOrders.js'), 'utf8');
  assert.match(soSrc, /roles\.resolveClinicalRole\(actor\)/);
  // The behavioural half: an actor-shaped object must authorise identically.
  const actorShaped = { id: 'p1', name: 'Bethel Godwins', role: 'user', clinicalRole: 'provider', licenseLevel: 'FNP', npi: '1902310568', email: 'b@x.test' };
  assert.ok(so.buildStandingOrder({ id: 'x', input: protocolInput(), author: actorShaped }).standingOrder,
    'an actor object authors exactly as a user object does');
});

// ---- 9. The 4.3 read/write split must not regress -----------------------

test('readOnly case-manager behaviour and its audit line are unchanged', () => {
  assert.equal(roles.canClinicalRead(READ_ONLY), true);
  assert.equal(roles.canClinicalWrite(READ_ONLY), false);
  assert.equal(roles.canClinicalRead({ role: 'caseManager' }), true, 'even before the migration writes the field');
  assert.equal(roles.canClinicalWrite({ role: 'caseManager', hasClinicalAccess: true }), false);
  assert.equal(roles.canClinicalRead(CLIENT), false);
  assert.equal(roles.canClinicalRead({ role: 'family' }), false);
  // The guard still audits them, and still answers with the specific code.
  const mw = serverSrc.slice(serverSrc.indexOf('const requireClinicalRead ='), serverSrc.indexOf('// Require Admin Hub access'));
  assert.match(mw, /case_manager_clinical_read/);
  assert.match(mw, /CLINICAL_READ_ONLY/);
  // patientReadRepository DELEGATES rather than restating — two copies of "who
  // may write a chart" is how one path accepts what the other refuses.
  const pr = fs.readFileSync(path.join(root, 'patientReadRepository.js'), 'utf8');
  assert.match(pr, /const canClinicalWrite = \(u\) => clinicalRoles\.canClinicalWrite\(u\)/);
});

test('hasClinicalAccess is derived, so a stale stored flag cannot widen a narrowed role', () => {
  assert.equal(roles.derivedHasClinicalAccess({ role: 'user', clinicalRole: 'rn' }), true);
  assert.equal(roles.derivedHasClinicalAccess({ role: 'user', clinicalRole: 'readOnly', hasClinicalAccess: true }), false,
    'the enum narrowed them; the old boolean must not undo it');
  assert.equal(roles.derivedHasClinicalAccess({ role: 'client' }), false);
  // req.user derives it on EVERY request, from the FRESH user record.
  assert.match(serverSrc, /clinicalRole: clinicalRoles\.resolveClinicalRole\(freshUser\)/);
  assert.match(serverSrc, /req\.user\.hasClinicalAccess = clinicalRoles\.derivedHasClinicalAccess\(req\.user\)/);
  // The field is NOT deleted this session (the brief says so explicitly).
  assert.ok(serverSrc.includes('hasClinicalAccess'), 'hasClinicalAccess stays as a derived read');
});

test('GET /api/users returns clinicalRole, or the round-tripped form wipes it', () => {
  // The 4.2 bug class, and for a clinical credential a silent widening.
  assert.match(serverSrc, /clinicalRole: clinicalRoles\.resolveClinicalRole\(u\)/);
  const hub = fs.readFileSync(path.join(root, 'public', 'admin-hub.html'), 'utf8');
  assert.match(hub, /clinicalRole: user\.clinicalRole \|\| ''/, 'the form loads it back');
});

test('an unrecognised clinicalRole on the user PUT is REFUSED, never silently dropped', () => {
  // Silently dropping it leaves an admin believing they narrowed someone's
  // authority when they did not — the exact failure this session exists to fix.
  assert.match(serverSrc, /CLINICAL_ROLE_INVALID/);
  assert.match(serverSrc, /clinical_role_set/, 'and the change is audited');
});

// ---- 10. MFA already covers these users (confirm, don't re-plumb) -------

test('clinical users are already in MFA_REQUIRED_ROLES — confirmed, not re-plumbed', () => {
  const cfg = fs.readFileSync(path.join(root, 'config.js'), 'utf8');
  const line = cfg.split('\n').find(l => l.includes('const MFA_REQUIRED_ROLES ='));
  assert.match(line, /admin,user,caseManager/, 'provider/rn/lcsw are role `user`; lmsw case managers are `caseManager`');
  const mfa = fs.readFileSync(path.join(root, 'mfa.js'), 'utf8');
  assert.match(mfa, /hasClinicalAccess/, 'and clinical access gates it too — now derived from the role');
});

// ---- 11. The UI renders from the served vocabulary, never its own copy --

test('the admin form does not restate the role enum', () => {
  const hub = fs.readFileSync(path.join(root, 'public', 'admin-hub.html'), 'utf8');
  const form = hub.slice(hub.indexOf('Clinical role (Session 4.8)'), hub.indexOf('Clinical role (Session 4.8)') + 3000);
  assert.match(form, /clinicalRoleCatalog\.map/, 'options come from GET /api/admin/clinical-roles');
  for (const v of ['lcsw', 'lmsw']) {
    assert.ok(!new RegExp(`value="${v}"`).test(form), `${v} must not be hardcoded as an option`);
  }
  assert.match(serverSrc, /app\.get\('\/api\/admin\/clinical-roles'/);
});

test('the clinical workspace renders from the matrix the API enforces, and re-checks nothing itself', () => {
  const cl = fs.readFileSync(path.join(root, 'public', 'clinical.html'), 'utf8');
  assert.match(cl, /const useCan = \(capability\)/);
  assert.match(cl, /capabilities: \(emrStatus && emrStatus\.access && emrStatus\.access\.capabilities\)/,
    'the matrix comes from the server, not from a second copy in the page');
  assert.match(cl, /canPrescribe = useCan\('prescribe'\)/);
  assert.match(cl, /canOrderDirect = useCan\('orderDirect'\)/);
  assert.match(cl, /canSelectCodes = useCan\('selectServiceCodes'\)/);
  // The page must not decide a credential rule on its own.
  assert.ok(!/clinicalRole === 'provider'/.test(cl), 'no role comparison in the page — ask the matrix');
  assert.ok(!/permittedTests\s*=\s*\[/.test(cl), 'the permitted tests come from the protocol, never a list in the page');
});
