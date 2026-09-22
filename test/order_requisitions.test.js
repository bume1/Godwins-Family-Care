// ============================================================================
// Session 4.10 Scope A — referrals, DME, and the requisition they ride on
//
// An order that cannot leave the building is a record of intent. What this file
// pins, because each of these would break quietly and expensively:
//
//   1. `referral` and `dme` are PROVIDER-DIRECT ONLY, and that is safe BY
//      CONSTRUCTION — nothing grants them. An invariant that holds because
//      nothing grants it is exactly the kind a later session breaks by widening
//      an enum, so it is proven rather than assumed.
//   2. Each of the SWO's six elements, missing, refuses the order. One test each.
//   3. A face-to-face encounter older than six months refuses it.
//   4. 42 CFR 424.507 warns and records; under a standing order it checks the
//      AUTHORIZING provider, not the executing nurse.
//   5. The requisition carries the patient identifiers and the order reference
//      ON EVERY PAGE, has no cover sheet, prints Eastern times, and uses no grey.
//   6. 'sent' is reachable only through Mark as faxed, and each send is its own
//      row rather than an overwrite.
//   7. The overdue clock: a lab at day 8 and not at day 6.
//   8. Every fax field is ten digits. A mistyped fax number is a misdirected
//      PHI disclosure.
//   9. THE RETURN FAX NUMBER LIVES IN THE DATABASE. It is seeded only if unset,
//      never overwritten, and appears as a literal in no source file.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// The server is pinned to Eastern in production (server.js line 2). Tests that
// assert a rendered timestamp have to run under the same clock or they are
// asserting the machine, not the code.
process.env.TZ = require('../public/gfc-time').PRACTICE_TIMEZONE;

const orderReq = require('../orderRequisitions');
const roles = require('../clinicalRoles');
const standingOrders = require('../standingOrders');
const clinicalRepo = require('../clinicalRepository');
const pdfGenerator = require('../pdf-generator');
const consentText = require('../public/consent-text');
const { PDFDocument } = require('pdf-lib');
const packetImport = require('../welcomePacketImport');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
// A SOURCE SCAN MUST STRIP COMMENTS BEFORE IT LOOKS, or it matches the prose
// explaining the code rather than the code. Earned three times in this repo.
const CODE = (src) => src.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

const SERVER = read('server.js');
const SERVER_CODE = CODE(SERVER);

// ---- Fixtures -------------------------------------------------------------
const PROVIDER = { id: 'p1', name: 'Bethel Godwins', email: 'b@test.local', role: 'user', clinicalRole: 'provider', licenseLevel: 'FNP-BC', npi: '1234567893' };
const RN = { id: 'rn1', name: 'Ruth Nightingale', email: 'rn@test.local', role: 'user', clinicalRole: 'rn', licenseLevel: 'RN', npi: '1234567893' };
const LCSW = { id: 'lc1', name: 'Lee Carter', email: 'lc@test.local', role: 'user', clinicalRole: 'lcsw' };
const LMSW = { id: 'lm1', name: 'Morgan Shaw', email: 'lm@test.local', role: 'user', clinicalRole: 'lmsw' };

const MEDICARE_CLIENT = {
  id: 'c1', name: 'Juanita Guess', role: 'client', serviceLine: 'IHPC',
  address: { line1: '118 Hickory Log Dr', city: 'Canton', state: 'GA', zip: '30114' },
  phone: '770-555-0111',
  intake: { firstName: 'Juanita', lastName: 'Guess', dob: '1941-03-09', gender: 'female' },
  payer: { type: 'medicare', primaryName: 'Medicare Part B', memberId: '1EG4TE5MK73' }
};
const COMMERCIAL_CLIENT = { ...MEDICARE_CLIENT, id: 'c2', payer: { type: 'commercial', primaryName: 'Aetna', memberId: 'W1' } };

const DX = [{ code: 'E11.9', description: 'Type 2 diabetes mellitus without complications' }];
const AT = '2026-09-22T14:00:00.000Z';   // 10:00 AM in Georgia

const referralInput = (extra = {}) => ({
  orderType: 'referral', specialty: 'Cardiology', receivingPractice: 'Northside Heart',
  receivingFax: '4045550123', reason: 'New onset atrial fibrillation',
  clinicalSummary: 'Please evaluate for rate control and anticoagulation.',
  diagnosisCodes: ['E11.9'], ...extra
});
const dmeInput = (extra = {}) => ({
  orderType: 'dme', itemDescription: 'Group 2 power wheelchair', quantity: 1,
  supplierName: 'Peachtree Medical Supply', supplierFax: '7705550199',
  lengthOfNeed: '99 months', orderDate: '2026-09-22', diagnosisCodes: ['E11.9'], ...extra
});
const build = (fn, input, actor = PROVIDER, client = MEDICARE_CLIENT) => fn({
  id: 'o1', clientId: client.id, puuid: 'pu1', encounterUuid: 'e1',
  input, actor, encounterDiagnoses: DX, client, at: AT
});

// ══════════════════════════════════════════════════════════════════════════
// A1 — provider-direct only, and the construction that makes it so
// ══════════════════════════════════════════════════════════════════════════

test('A1: referral and dme are provider-direct only — nothing grants them to an rn, lcsw or lmsw', () => {
  for (const type of orderReq.DOCUMENT_ORDER_TYPES) {
    // DIRECT: ORDER_DIRECT is provider-only, so the route's own gate refuses.
    for (const user of [RN, LCSW, LMSW]) {
      assert.equal(roles.can(user, roles.CAPABILITIES.ORDER_DIRECT), false,
        `${roles.resolveClinicalRole(user)} must not place a ${type} on their own authority`);
    }
    assert.equal(roles.can(PROVIDER, roles.CAPABILITIES.ORDER_DIRECT), true);

    // UNDER A PROTOCOL: two independent refusals, and both must hold. A protocol
    // cannot NAME the type (STANDING_ORDER_TYPES excludes it) and no role's
    // CREDENTIAL CEILING carries it, so even a mis-authored protocol is refused.
    assert.ok(!roles.STANDING_ORDER_TYPES.includes(type),
      `a standing order must not be able to name ${type} — it is placed on a provider's own authority`);
    for (const role of Object.keys(roles.CREDENTIAL_CEILING)) {
      assert.ok(!roles.CREDENTIAL_CEILING[role].includes(type),
        `${role}'s credential ceiling must not carry ${type}`);
    }
  }
});

test('A1: a standing order naming a referral is refused at execution, with and without a signature', () => {
  // Authoring one is refused outright: permittedOrderTypes filters to
  // STANDING_ORDER_TYPES, so a protocol naming only `referral` has no types left.
  const authored = standingOrders.buildStandingOrder({
    id: 'so1', author: PROVIDER, at: AT,
    input: {
      title: 'Referral protocol', permittedOrderTypes: ['referral'], permittedTests: ['Cardiology'],
      permittedExecutorRoles: ['rn'], indications: ['E11.9'], expiresAt: '2027-09-22T00:00:00.000Z'
    }
  });
  assert.equal(authored.code, 'STANDING_ORDER_NO_TYPES');

  // And a hand-forged protocol row that carries it anyway is refused at
  // EXECUTION, by the credential ceiling — which is the point of checking the
  // ceiling independently of the protocol.
  const forged = {
    id: 'so2', title: 'Forged', version: 1, status: 'active', signedAt: AT,
    permittedOrderTypes: ['referral', 'dme'], permittedTests: ['Cardiology'],
    permittedExecutorRoles: ['rn'], indications: ['E11.9'], patientScope: 'panel',
    effectiveAt: AT, expiresAt: '2027-09-22T00:00:00.000Z',
    authorizingProvider: { userId: 'p1', name: 'Bethel Godwins', npi: '1234567893', credential: 'FNP-BC' }
  };
  for (const type of ['referral', 'dme']) {
    const auth = standingOrders.authorizeExecution({
      standingOrder: forged, actor: RN, orderType: type, tests: ['Cardiology'],
      diagnosisCodes: ['E11.9'], clientId: 'c1', at: AT
    });
    assert.equal(auth.code, 'CREDENTIAL_CEILING', `a forged protocol must not authorise a ${type}`);
  }
});

test('A2: buildOrder still requires tests and refuses a document order BY NAME', () => {
  // The builder was not contorted into taking neither a test list nor a payload.
  const noTests = clinicalRepo.buildOrder({ id: 'o', encounterUuid: 'e', actor: PROVIDER, encounterDiagnoses: DX, input: { orderType: 'lab', diagnosisCodes: ['E11.9'] } });
  assert.equal(noTests.code, 'ORDER_NO_TESTS');
  for (const type of ['referral', 'dme']) {
    const wrong = clinicalRepo.buildOrder({ id: 'o', encounterUuid: 'e', actor: PROVIDER, encounterDiagnoses: DX, input: { orderType: type, tests: ['x'], diagnosisCodes: ['E11.9'] } });
    assert.equal(wrong.code, 'ORDER_WRONG_BUILDER', 'refused by name, not dropped as an unknown type');
  }
});

test('A2/A3: a referral shares the order envelope and anchors to an encounter diagnosis', () => {
  assert.equal(build(orderReq.buildReferral, referralInput({ diagnosisCodes: [] })).code, 'ORDER_NO_DIAGNOSIS');
  assert.equal(build(orderReq.buildReferral, referralInput({ diagnosisCodes: ['J45.909'] })).code, 'ORDER_DX_UNKNOWN');
  const { order } = build(orderReq.buildReferral, referralInput());
  // The shared envelope: every consumer of an order reads these.
  assert.equal(order.orderType, 'referral');
  assert.equal(order.encounterUuid, 'e1');
  assert.equal(order.status, 'ordered');
  assert.equal(order.orderingClinician.npi, '1234567893');
  assert.deepEqual(order.diagnosisCodes, ['E11.9']);
  assert.deepEqual(order.sends, []);
  assert.match(order.orderReference, /^GFC-ORD-[34679ACDEFGHJKMNPQRTUVWXY]{6}$/);
  // `tests` carries the specialty so the board, the audit row and the OpenEMR
  // procedure_order copy do not read a referral as an order for nothing.
  assert.deepEqual(order.tests, ['Cardiology']);
});

test('A3: a referral requires a specialty, a reason, a clinical question and a real fax number', () => {
  assert.equal(build(orderReq.buildReferral, referralInput({ specialty: '' })).code, 'REFERRAL_NO_SPECIALTY');
  assert.equal(build(orderReq.buildReferral, referralInput({ reason: '' })).code, 'REFERRAL_NO_REASON');
  assert.equal(build(orderReq.buildReferral, referralInput({ clinicalSummary: '' })).code, 'REFERRAL_NO_SUMMARY');
  assert.equal(build(orderReq.buildReferral, referralInput({ receivingFax: '' })).code, 'REFERRAL_BAD_FAX');
  assert.equal(build(orderReq.buildReferral, referralInput({ receivingFax: '404555012' })).code, 'REFERRAL_BAD_FAX');
});

test('A3: a referral has its OWN lifecycle — scheduled exists, resulted does not', () => {
  const t = orderReq.REFERRAL_TRANSITIONS;
  assert.deepEqual(t.ordered, ['sent', 'cancelled']);
  assert.ok(t.sent.includes('scheduled'), 'a referral is scheduled by the specialist\'s office');
  assert.ok(t.sent.includes('completed'));
  assert.ok(!t.sent.includes('resulted'), 'a referral completes with a consult note; it is not "resulted"');
  assert.deepEqual(t.completed, []);
  assert.deepEqual(t.cancelled, []);
  // And the repository resolves the right map per order, rather than every
  // consumer assuming the lab one.
  assert.deepEqual(clinicalRepo.transitionsFor({ orderType: 'referral' }), t);
  assert.deepEqual(clinicalRepo.transitionsFor({ orderType: 'lab' }), clinicalRepo.ORDER_TRANSITIONS);
});

test('A3: a prior-authorization flag is a FLAG, so it can be chased and printed', () => {
  const { order } = build(orderReq.buildReferral, referralInput({ priorAuthRequired: true, priorAuthNumber: 'PA-1' }));
  assert.equal(order.referral.priorAuthRequired, true);
  assert.equal(order.referral.priorAuthNumber, 'PA-1');
  const { order: none } = build(orderReq.buildReferral, referralInput());
  assert.equal(none.referral.priorAuthRequired, false);
  assert.equal(none.referral.priorAuthNumber, null);
});

// ══════════════════════════════════════════════════════════════════════════
// A4 — the Standard Written Order: one refusal per missing element
// ══════════════════════════════════════════════════════════════════════════

test('A4: the SWO has six elements and every one of them is named', () => {
  assert.equal(orderReq.SWO_ELEMENTS.length, 6);
  assert.deepEqual(orderReq.SWO_ELEMENTS.map(e => e.key),
    ['beneficiary', 'orderDate', 'itemDescription', 'quantity', 'practitioner', 'signature']);
});

test('A4 element 1: no beneficiary name AND no MBI refuses the order', () => {
  const nameless = { ...MEDICARE_CLIENT, name: '', intake: { dob: '1941-03-09' }, payer: {} };
  const out = build(orderReq.buildDmeOrder, dmeInput(), PROVIDER, nameless);
  assert.equal(out.code, 'DME_SWO_NO_BENEFICIARY');
  // An MBI ALONE satisfies element 1 — it is "name OR MBI".
  const mbiOnly = { ...nameless, payer: { type: 'medicare', memberId: '1EG4TE5MK73' } };
  assert.ok(build(orderReq.buildDmeOrder, dmeInput(), PROVIDER, mbiOnly).order, 'an MBI alone satisfies element 1');
});

test('A4 element 2: the order date is required and defaults to today, never to nothing', () => {
  const { order } = build(orderReq.buildDmeOrder, dmeInput({ orderDate: 'not-a-date' }));
  assert.equal(order.dme.orderDate, '2026-09-22', 'an unparseable date falls back to the order instant, in Eastern');
  assert.ok(orderReq.SWO_ELEMENTS.find(e => e.key === 'orderDate'));
});

test('A4 element 3: no item description refuses the order', () => {
  assert.equal(build(orderReq.buildDmeOrder, dmeInput({ itemDescription: '' })).code, 'DME_SWO_NO_ITEM');
});

test('A4 element 4: a missing, zero or non-numeric quantity refuses the order', () => {
  for (const q of ['', 0, -1, 'two', null]) {
    assert.equal(build(orderReq.buildDmeOrder, dmeInput({ quantity: q })).code, 'DME_SWO_NO_QUANTITY', `quantity ${JSON.stringify(q)}`);
  }
});

test('A4 element 5: a practitioner with neither a name nor an NPI refuses the order', () => {
  const anon = { id: 'x', clinicalRole: 'provider' };
  assert.equal(build(orderReq.buildDmeOrder, dmeInput(), anon).code, 'DME_SWO_NO_PRACTITIONER');
});

test('A4 element 6: no NPI refuses the order AT CREATION, not at print time', () => {
  // Refusing at PDF time would mean a finalized DME order that can never be
  // sent — a document a supplier cannot bill against, discovered after the fact.
  const noNpi = { ...PROVIDER, npi: null };
  const out = build(orderReq.buildDmeOrder, dmeInput(), noNpi);
  assert.equal(out.code, 'DME_SWO_NO_SIGNATURE');
  assert.match(out.error, /NPI/);
});

test('A4: a face-to-face encounter outside the six months before the order date is refused', () => {
  // The window is measured in CALENDAR MONTHS, not 180 days — that is how the
  // rule reads, and a February order would otherwise be judged differently from
  // an August one.
  assert.equal(orderReq.f2fWindowStart('2026-09-22'), '2026-03-22');
  assert.equal(orderReq.F2F_MONTHS, 6);

  const inWindow = build(orderReq.buildDmeOrder, dmeInput({ requiresF2F: true, faceToFaceDate: '2026-04-01' }));
  assert.ok(inWindow.order, 'April is inside the window for a September order');
  assert.equal(inWindow.order.dme.faceToFaceEncounterUuid, 'e1', 'linked to the encounter it came from');

  const tooOld = build(orderReq.buildDmeOrder, dmeInput({ requiresF2F: true, faceToFaceDate: '2026-03-01' }));
  assert.equal(tooOld.code, 'DME_F2F_OUT_OF_WINDOW');
  assert.equal(tooOld.windowStart, '2026-03-22');

  // In the FUTURE is refused too: an encounter that has not happened cannot
  // support an order placed today.
  assert.equal(build(orderReq.buildDmeOrder, dmeInput({ requiresF2F: true, faceToFaceDate: '2026-10-01' })).code, 'DME_F2F_OUT_OF_WINDOW');
  // And the flag without a date is refused rather than quietly ignored.
  assert.equal(build(orderReq.buildDmeOrder, dmeInput({ requiresF2F: true })).code, 'DME_NO_F2F_DATE');
});

test("A4: CMS's Required List is NOT embedded — the provider sets the flags", () => {
  const src = CODE(read('orderRequisitions.js'));
  // A HCPCS code list in this module would be a stale copy of a list that
  // changes; the flags are the seam, and the UI links to the live list.
  assert.ok(!/K08\d\d|E13\d\d|requiredList\s*=\s*\[/i.test(src),
    "CMS's Required List must not be embedded in code — it changes");
  const { order } = build(orderReq.buildDmeOrder, dmeInput({ requiresWOPD: true }));
  assert.equal(order.dme.requiresWOPD, true);
  // And the page links to the list rather than deciding for the provider.
  assert.match(read('public/clinical.html'), /cms\.gov[^"']*written-order-prior-delivery/i);
});

test('A4: supplier, supplier fax and length of need are required', () => {
  assert.equal(build(orderReq.buildDmeOrder, dmeInput({ supplierName: '' })).code, 'DME_NO_SUPPLIER');
  assert.equal(build(orderReq.buildDmeOrder, dmeInput({ supplierFax: '' })).code, 'DME_BAD_SUPPLIER_FAX');
  assert.equal(build(orderReq.buildDmeOrder, dmeInput({ supplierFax: '77055501990' })).code, 'DME_BAD_SUPPLIER_FAX');
  assert.equal(build(orderReq.buildDmeOrder, dmeInput({ lengthOfNeed: '' })).code, 'DME_NO_LENGTH_OF_NEED');
});

test('A4: swoGaps names what is missing so the form can be honest before the click', () => {
  assert.deepEqual(orderReq.swoGaps({ dme: {} }).map(g => g.element),
    ['beneficiary', 'orderDate', 'itemDescription', 'quantity', 'practitioner', 'signature']);
  const { order } = build(orderReq.buildDmeOrder, dmeInput());
  assert.deepEqual(orderReq.swoGaps(order), [], 'a complete order has no gaps');
});

// ══════════════════════════════════════════════════════════════════════════
// A5 — 42 CFR 424.507
// ══════════════════════════════════════════════════════════════════════════

const enrolled = (status) => ({ ...PROVIDER, medicareEnrollment: status ? { status } : undefined });

test('A5: a Medicare patient plus an unenrolled ordering clinician refuses without an acknowledgment', () => {
  for (const type of ['lab', 'imaging', 'dme']) {
    const out = orderReq.checkOrderingEnrollment({ orderType: type, client: MEDICARE_CLIENT, orderingUser: enrolled('pending') });
    assert.equal(out.ok, false, type);
    assert.equal(out.code, 'ORDERING_PROVIDER_NOT_ENROLLED');
    assert.match(out.error, /424\.507/);
  }
  // NOT RECORDED is treated exactly like not enrolled. Fail closed: an enrolment
  // nobody has checked is not evidence of one.
  assert.equal(orderReq.checkOrderingEnrollment({ orderType: 'lab', client: MEDICARE_CLIENT, orderingUser: enrolled(null) }).ok, false);
});

test('A5: it is permitted WITH an acknowledgment and a reason, and the acknowledgment is recorded', () => {
  const bare = orderReq.checkOrderingEnrollment({
    orderType: 'lab', client: MEDICARE_CLIENT, orderingUser: enrolled('none'),
    acknowledgment: { acknowledged: true }
  });
  assert.equal(bare.ok, false, 'acknowledged with no reason is not an acknowledgment');

  const ok = orderReq.checkOrderingEnrollment({
    orderType: 'lab', client: MEDICARE_CLIENT, orderingUser: enrolled('none'),
    acknowledgment: { acknowledged: true, reason: 'Urgent; patient will self-pay if denied.' }
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.acknowledgment.reason, 'Urgent; patient will self-pay if denied.');
  assert.equal(ok.acknowledgment.enrollmentStatus, 'none');
  assert.equal(ok.acknowledgment.orderingClinicianId, 'p1');
});

test('A5: approved and opted_out both pass; opted_out is a different arrangement, not a gap', () => {
  assert.equal(orderReq.checkOrderingEnrollment({ orderType: 'dme', client: MEDICARE_CLIENT, orderingUser: enrolled('approved') }).ok, true);
  assert.equal(orderReq.checkOrderingEnrollment({ orderType: 'dme', client: MEDICARE_CLIENT, orderingUser: enrolled('opted_out') }).ok, true);
  assert.deepEqual(orderReq.ENROLLMENT_OK, ['approved', 'opted_out']);
});

test('A5: a commercial patient is never warned, and a REFERRAL is never warned', () => {
  // 424.507 reaches ordered services, not referrals to specialists. Warning on
  // a referral would train clinicians to click past the warning that matters.
  assert.equal(orderReq.checkOrderingEnrollment({ orderType: 'lab', client: COMMERCIAL_CLIENT, orderingUser: enrolled('none') }).required, false);
  assert.equal(orderReq.checkOrderingEnrollment({ orderType: 'referral', client: MEDICARE_CLIENT, orderingUser: enrolled('none') }).required, false);
  assert.ok(!orderReq.ENROLLMENT_GATED_TYPES.includes('referral'));
  // And a payer we cannot read is not assumed to be Medicare: warning everybody
  // makes the warning meaningless.
  assert.equal(orderReq.isMedicarePatient({ payer: {} }), false);
  assert.equal(orderReq.isMedicarePatient({ payer: { type: 'medicare_advantage' } }), true);
  assert.equal(orderReq.isMedicarePatient({ intake: { insurance: { insuranceTypes: ['Medicare Part B'] } } }), true);
});

test('A5: under a standing order the AUTHORIZING provider is checked, not the executing nurse', () => {
  const protocol = {
    id: 'so', title: 'CBC protocol', version: 2, status: 'active', signedAt: AT,
    permittedOrderTypes: ['lab'], permittedTests: ['CBC'], permittedExecutorRoles: ['rn'],
    indications: ['E11.9'], patientScope: 'panel', effectiveAt: AT, expiresAt: '2027-09-22T00:00:00.000Z',
    authorizingProvider: { userId: 'p1', name: 'Bethel Godwins', npi: '1234567893', credential: 'FNP-BC' }
  };
  const auth = standingOrders.authorizeExecution({
    standingOrder: protocol, actor: RN, orderType: 'lab', tests: ['CBC'], diagnosisCodes: ['E11.9'], clientId: 'c1', at: AT
  });
  assert.equal(auth.ok, true);
  // 4.8 files the order under the AUTHORIZING provider, which is what makes the
  // enrolment question answerable about the right person.
  assert.equal(auth.orderingClinician.id, 'p1');
  assert.equal(auth.executedBy.id, 'rn1');

  // THE NURSE IS ENROLLED AND THE PROVIDER IS NOT → refused. If this checked the
  // executor it would pass, and the lab's claim would be denied anyway.
  const providerNotEnrolled = { ...PROVIDER, medicareEnrollment: { status: 'none' } };
  const nurseEnrolled = { ...RN, medicareEnrollment: { status: 'approved' } };
  const byAuthorizer = orderReq.checkOrderingEnrollment({
    orderType: 'lab', client: MEDICARE_CLIENT, orderingUser: providerNotEnrolled
  });
  assert.equal(byAuthorizer.ok, false, "the authorizing provider's enrolment is what counts");
  assert.equal(orderReq.checkOrderingEnrollment({ orderType: 'lab', client: MEDICARE_CLIENT, orderingUser: nurseEnrolled }).ok, true);

  // And the ROUTE resolves the ordering clinician from the ORDER, not from the
  // request's user, which is what makes the above the live behaviour.
  assert.match(SERVER_CODE, /orderingUserId\s*=\s*built\.order\.orderingClinician\s*&&\s*built\.order\.orderingClinician\.id/,
    'the enrolment check must read the order\'s ordering clinician, not req.user');
});

test('A5: the route refuses with 409 and records the acknowledgment on the order', () => {
  assert.match(SERVER_CODE, /code:\s*enroll\.code[\s\S]{0,200}needsReason/);
  assert.match(SERVER_CODE, /built\.order\.medicareEnrollmentAcknowledgment\s*=/);
  assert.match(SERVER_CODE, /medicareEnrollmentAcknowledged:\s*!!built\.order\.medicareEnrollmentAcknowledgment/,
    'the audit row says whether a 424.507 warning was acknowledged');
});

// ══════════════════════════════════════════════════════════════════════════
// A6 — the requisition
// ══════════════════════════════════════════════════════════════════════════

const SETTINGS = orderReq.normalizeRequisitionSettings(
  { returnFax: consentText.ORG.fax, returnFaxLabel: 'Godwins Family Care — clinical' },
  { phone: consentText.ORG.phone });

const renderRequisition = async (order, opts = {}) => {
  const buf = await pdfGenerator.generateRequisitionPDF({
    order, client: MEDICARE_CLIENT, orderingClinician: order.orderingClinician,
    requisitionSettings: SETTINGS, diagnoses: DX, generatedAt: AT, ...opts
  });
  const doc = await PDFDocument.load(buf);
  const runs = await packetImport.extractRuns(doc);
  const byPage = {};
  for (const r of runs) { byPage[r.page] = (byPage[r.page] || []).concat(r.text); }
  return {
    buf, doc, runs,
    pages: Object.keys(byPage).sort((a, b) => a - b).map(k => byPage[k].join(' ')),
    text: runs.map(r => r.text).join(' '),
    // Per page, the runs sorted by vertical position. The extractor's y grows
    // DOWN the page (it reports the drawing coordinate), so the first entries are
    // the top of the sheet and the last are the bottom.
    pageRuns: (p) => runs.filter(r => r.page === p).slice().sort((a, b) => a.y - b.y)
  };
};

const LAB_ORDER = () => clinicalRepo.buildOrder({
  id: 'o-lab', clientId: 'c1', puuid: 'pu1', encounterUuid: 'e1', actor: PROVIDER,
  encounterDiagnoses: DX, at: AT,
  input: { orderType: 'lab', tests: ['CBC with differential', 'Comprehensive metabolic panel'], diagnosisCodes: ['E11.9'], priority: 'stat' }
}).order;

test('A6: the patient identifiers and the order reference appear on EVERY page', async () => {
  // Fax pages separate, get re-stacked and get re-scanned. A page with no
  // identifiers is a page that ends up in the wrong chart, and a page with no
  // reference cannot be matched back to its order.
  for (const order of [LAB_ORDER(), build(orderReq.buildReferral, referralInput()).order,
    build(orderReq.buildDmeOrder, dmeInput({ requiresWOPD: true, requiresF2F: true, faceToFaceDate: '2026-08-01' })).order]) {
    const r = await renderRequisition(order);
    assert.ok(r.pages.length >= 1);
    for (const [i, page] of r.pages.entries()) {
      assert.match(page, /Juanita Guess/, `page ${i + 1} of a ${order.orderType} requisition carries the patient name`);
      assert.match(page, /DOB 1941-03-09/, `page ${i + 1} carries the DOB`);
      assert.match(page, /MBI 1EG4TE5MK73/, `page ${i + 1} carries the MBI`);
      assert.ok(page.includes(order.orderReference), `page ${i + 1} carries ${order.orderReference}`);
      assert.match(page, /Please include this reference when returning results/,
        `page ${i + 1} asks for the reference back — that is how an inbound fax is matched`);

      // TOP **AND** BOTTOM, and counting is the only way to tell. My first draft
      // joined every run on the page and matched once, so dropping the bottom
      // strip entirely still passed — the top copy satisfied it. Two mutations
      // survived on exactly that, which is the house rule pointed at my own test:
      // an assertion that cannot distinguish two states proves nothing.
      const runs = r.pageRuns(i);
      const idLine = runs.filter(x => /Juanita Guess · DOB/.test(x.text));
      assert.equal(idLine.length, 2, `page ${i + 1} carries the identifier line exactly twice — top and bottom`);
      const refRuns = runs.filter(x => x.text.trim() === order.orderReference);
      assert.equal(refRuns.length, 2, `page ${i + 1} carries the reference twice — top and bottom`);

      // And they are genuinely at opposite ends of the sheet, not two copies in
      // one corner. A fax page gets re-stacked and re-scanned; an identifier at
      // only one end is an identifier a torn or cropped page can lose.
      const height = r.doc.getPages()[i].getSize().height;
      const [topId, bottomId] = idLine.slice().sort((a, b) => a.y - b.y);
      assert.ok(topId.y < height * 0.25, `page ${i + 1}: an identifier line near the top (y=${topId.y})`);
      assert.ok(bottomId.y > height * 0.75, `page ${i + 1}: and one near the bottom (y=${bottomId.y})`);
    }
  }
});

test('A6: every requisition targets ONE page, and a multi-page one is numbered', async () => {
  const heavy = build(orderReq.buildDmeOrder, dmeInput({ requiresWOPD: true, requiresF2F: true, faceToFaceDate: '2026-08-01' })).order;
  const { pages } = await renderRequisition(heavy);
  assert.equal(pages.length, 1, 'the heaviest requisition — WOPD plus a face-to-face — still fits one page');
  assert.ok(!pages[0].includes('Page 1 of 1'), 'a single-page requisition says nothing about pagination');

  // A fax that arrives short has to be detectable as short, so the moment there
  // is more than one page every page is numbered.
  const withAttachment = await renderRequisition(heavy, { attachments: [await minimalPdf()] });
  const doc = withAttachment.doc;
  assert.ok(doc.getPageCount() > 1);
  assert.match(withAttachment.pages[0], /Page 1 of \d/);
});

const minimalPdf = async () => {
  const d = await PDFDocument.create();
  d.addPage().drawText('attachment page');
  return Buffer.from(await d.save());
};

test('A6: NO COVER SHEET — Doximity supplies one, and two is noise', async () => {
  const { text, pages } = await renderRequisition(LAB_ORDER());
  assert.ok(!/cover sheet|FAX COVER|Number of pages:|To:\s*From:/i.test(text), 'no cover sheet');
  // The first page is the requisition itself, not a front matter page.
  assert.match(pages[0], /Laboratory Requisition/);
});

test('A6: fax-safe rendering — black ink only, no light greys, no fills behind text', async () => {
  const { buf } = await renderRequisition(LAB_ORDER());
  // VERIFY THE BEHAVIOUR, NOT THE ARTIFACT: read the colour operators out of the
  // content streams rather than grepping the generator for a hex string.
  const raw = buf.toString('latin1');
  const streams = raw.match(/stream[\s\S]*?endstream/g) || [];
  const zlib = require('zlib');
  let ops = '';
  for (const s of streams) {
    const body = s.replace(/^stream\r?\n?/, '').replace(/endstream$/, '');
    try { ops += zlib.inflateSync(Buffer.from(body, 'latin1')).toString('latin1'); }
    catch { ops += body; }
  }
  // BOTH operator forms, because the two libraries emit different ones and a
  // regex for one of them is a test that proves nothing about the other. pdfkit
  // writes `/DeviceRGB cs` + `scn`; pdf-lib (the page stamper) writes `rg`.
  // My first draft looked only for `rg`/`g` and matched ZERO operators against a
  // pdfkit document — the precondition assertion at the end is what caught it.
  const colours = [
    ...[...ops.matchAll(/([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+(?:rg|RG|scn|SCN)\b/g)]
      .map(m => [m[1], m[2], m[3]].map(Number)),
    // A single-component grey: `0 g` is black, `0.5 g` is the grey that drops out.
    ...[...ops.matchAll(/(?:^|[\s>])([\d.]+)\s+(?:g|G)(?:\s|$)/gm)].map(m => [Number(m[1]), Number(m[1]), Number(m[1])])
  ];
  for (const c of colours) {
    const isBlack = c.every(v => v === 0);
    // WHITE is permitted and is not a fill behind text in the sense that
    // matters: the stamper blanks a strip so an attachment's own header cannot
    // collide with the identifiers, and white is paper. Anything BETWEEN black
    // and white is the grey that disappears on a fax.
    const isWhite = c.every(v => v === 1);
    assert.ok(isBlack || isWhite, `ink must be black (white blanking aside); found ${c.join(',')}`);
  }
  assert.ok(colours.length > 0, 'the stream must actually carry colour operators, or this proves nothing');
  assert.ok(colours.some(c => c.every(v => v === 0)), 'and some of it must be black ink');
});

test('A6: the electronic signature names the clinician, their NPI, and an EASTERN time', async () => {
  const { text } = await renderRequisition(build(orderReq.buildDmeOrder, dmeInput()).order);
  // AT is 14:00Z, which is 10:00 AM in Georgia. A requisition stamped in UTC is
  // a requisition dated — and timed — wrong.
  assert.match(text, /Electronically signed by Bethel Godwins, FNP-BC, NPI 1234567893, on 9\/22\/2026, 10:00 AM ET/);
  assert.ok(!/2:00 PM/.test(text), 'the timestamp must not be UTC');
});

test('A6: a requisition is REFUSED when the ordering clinician has no NPI', async () => {
  const order = { ...LAB_ORDER(), orderingClinician: { name: 'Nobody', licenseLevel: 'FNP', npi: null } };
  await assert.rejects(
    () => pdfGenerator.generateRequisitionPDF({ order, client: MEDICARE_CLIENT, requisitionSettings: SETTINGS }),
    (e) => e.code === 'REQUISITION_NO_NPI');
});

test('A6: diagnoses print as CODE PLUS DESCRIPTION, not a bare code', async () => {
  const { text } = await renderRequisition(LAB_ORDER());
  assert.match(text, /E11\.9\s+Type 2 diabetes mellitus without complications/,
    'a bare code makes the lab look it up, and a wrong lookup is a wrong medical-necessity justification');
});

test('A6: an urgent or stat priority prints large; a routine one does not shout', async () => {
  const stat = await renderRequisition(LAB_ORDER());
  assert.match(stat.text, /STAT/);
  const routineOrder = clinicalRepo.buildOrder({
    id: 'o2', clientId: 'c1', encounterUuid: 'e1', actor: PROVIDER, encounterDiagnoses: DX, at: AT,
    input: { orderType: 'lab', tests: ['A1c'], diagnosisCodes: ['E11.9'], priority: 'routine' }
  }).order;
  const routine = await renderRequisition(routineOrder);
  assert.match(routine.text, /ROUTINE/, 'routine is still stated');
  assert.ok(!/^\s*ROUTINE\s*$/m.test(routine.pages[0].split('PATIENT')[0]), 'but not as a banner above the patient block');
});

test('A6: WRITTEN ORDER PRIOR TO DELIVERY prints prominently only when the flag is set', async () => {
  const withWopd = await renderRequisition(build(orderReq.buildDmeOrder, dmeInput({ requiresWOPD: true })).order);
  assert.match(withWopd.text, /WRITTEN ORDER PRIOR TO DELIVERY/);
  const without = await renderRequisition(build(orderReq.buildDmeOrder, dmeInput()).order);
  assert.ok(!/WRITTEN ORDER PRIOR TO DELIVERY/.test(without.text));
});

test('A6: under a standing order the requisition names the authorizing provider AND the executor', async () => {
  const order = {
    ...LAB_ORDER(), authority: 'standing_order',
    standingOrder: { id: 'so', version: 2, title: 'Diabetes monitoring' },
    orderingClinician: { id: 'p1', name: 'Bethel Godwins', licenseLevel: 'FNP-BC', npi: '1234567893' },
    executedBy: { id: 'rn1', name: 'Ruth Nightingale', credential: 'RN' }
  };
  const { text } = await renderRequisition(order, { standingOrder: { title: 'Diabetes monitoring', version: 2 } });
  assert.match(text, /Executed under standing order "Diabetes monitoring" v2 by Ruth Nightingale, RN/);
  // The SIGNATURE is still the authorizing provider's — that is whose authority
  // the order is under.
  assert.match(text, /Electronically signed by Bethel Godwins/);
});

test('A6: "Return results to" prints the STORED fax number, formatted, plus the phone', async () => {
  const { text } = await renderRequisition(LAB_ORDER());
  assert.match(text, /Fax \(678\) 692-7445/);
  assert.match(text, new RegExp(consentText.ORG.phone.replace(/[-.]/g, '[-.]')));
  // An UNSET number says so rather than printing a wrong one.
  const unset = await pdfGenerator.generateRequisitionPDF({
    order: LAB_ORDER(), client: MEDICARE_CLIENT, orderingClinician: PROVIDER,
    requisitionSettings: orderReq.normalizeRequisitionSettings({}, {}), diagnoses: DX, generatedAt: AT
  });
  const runs = await packetImport.extractRuns(await PDFDocument.load(unset));
  assert.match(runs.map(r => r.text).join(' '), /not configured/);
});

test('A7: the filename is clean and goes through contentDisposition', () => {
  const order = build(orderReq.buildDmeOrder, dmeInput()).order;
  assert.equal(orderReq.requisitionFileName(order, MEDICARE_CLIENT),
    `GFC_dme_Guess_20260922_${order.orderReference.replace('GFC-ORD-', '')}.pdf`);
  // A surname with an apostrophe must not reach the header raw — a macOS
  // screenshot filename once 500'd every download in this repo.
  const obrien = { ...MEDICARE_CLIENT, intake: { ...MEDICARE_CLIENT.intake, lastName: "O'Brien" } };
  assert.match(orderReq.requisitionFileName(order, obrien), /GFC_dme_OBrien_/);
  assert.match(SERVER_CODE, /requisition\.pdf[\s\S]{0,4000}contentDisposition\('inline', fileName\)/,
    'the requisition streams through contentDisposition, inline so the share sheet is one tap away');
});

test('A7: the requisition is filed into the chart, and a regeneration files a NEW copy', () => {
  assert.match(SERVER_CODE, /uploadPatientDocument\([\s\S]{0,200}orderReq\.REQUISITION_CATEGORY/,
    'the chart must hold exactly what was sent');
  assert.equal(orderReq.REQUISITION_CATEGORY, '/Orders');
  assert.match(SERVER_CODE, /requisitionCount:\s*\(order\.requisitionCount \|\| 0\) \+ 1/,
    'a regenerated requisition is a new document; the old one is kept');
});

// ══════════════════════════════════════════════════════════════════════════
// A7 — recording the send
// ══════════════════════════════════════════════════════════════════════════

test("A7: 'sent' is unreachable from the generic status route, BY NAME", () => {
  const order = LAB_ORDER();
  for (const status of ['sent', 'resulted', 'scheduled', 'completed']) {
    const out = clinicalRepo.advanceOrderStatus(order, status, PROVIDER);
    assert.equal(out.code, 'ORDER_STATUS_NEEDS_EVIDENCE', status);
    assert.ok(out.error.length > 20, 'the refusal names the route that does carry the evidence');
  }
  // Cancelling carries no evidence to capture, so it stays this route's.
  assert.equal(clinicalRepo.advanceOrderStatus(order, 'cancelled', PROVIDER).order.status, 'cancelled');
});

test('A7: a send record captures the recipient, the number, the channel, who and when', () => {
  const order = build(orderReq.buildReferral, referralInput()).order;
  const out = orderReq.applySend({ order, actor: PROVIDER, at: AT, input: { channel: 'doximity' } });
  assert.equal(out.order.status, 'sent');
  assert.equal(out.order.sends.length, 1);
  const s = out.order.sends[0];
  assert.equal(s.channel, 'doximity');
  assert.equal(s.recipientName, 'Northside Heart', 'defaulted from the referral rather than asked twice');
  assert.equal(s.recipientFax, '4045550123');
  assert.equal(s.sentAt, AT);
  assert.equal(s.sentBy.name, 'Bethel Godwins');
  assert.equal(out.resend, false);
  assert.match(out.order.statusHistory[1].note, /Sent by Doximity fax to Northside Heart at \(404\) 555-0123/);
});

test('A7: an order can be RE-SENT, and each send is its own row — never an overwrite', () => {
  // A referral faxed to the wrong number and then to the right one is TWO
  // disclosures, and only one of them is the one we meant.
  const order = build(orderReq.buildReferral, referralInput()).order;
  const first = orderReq.applySend({ order, actor: PROVIDER, at: AT, input: { recipientFax: '4045550199', recipientName: 'Wrong practice' } }).order;
  const second = orderReq.applySend({ order: first, actor: RN, at: '2026-09-22T15:00:00.000Z', input: {} });
  assert.equal(second.order.sends.length, 2, 'both sends survive');
  assert.equal(second.order.sends[0].recipientFax, '4045550199');
  assert.equal(second.order.sends[1].recipientFax, '4045550123');
  assert.equal(second.resend, true);
  assert.match(second.order.statusHistory[2].note, /^Re-sent/);
  assert.equal(second.order.lastSentAt, '2026-09-22T15:00:00.000Z');
});

test('A7: the channel is an ENUM — the seam for an e-fax integration that is not built', () => {
  assert.deepEqual(orderReq.SEND_CHANNELS, ['doximity', 'efax', 'portal', 'phone', 'hand']);
  assert.equal(orderReq.DEFAULT_SEND_CHANNEL, 'doximity');
  // NO FAX API ANYWHERE. The app generates; a person transmits.
  const src = CODE(read('orderRequisitions.js')) + CODE(read('clinicalResults.js'));
  assert.ok(!/efax\.|faxApi|sendFax\(|twilio|phaxio|srfax/i.test(src),
    'the app must never call a fax API or claim it sent a fax');
  // A non-fax channel needs no fax number; a fax channel refuses a bad one.
  const order = build(orderReq.buildReferral, referralInput()).order;
  const byPhone = orderReq.applySend({ order, actor: PROVIDER, at: AT, input: { channel: 'phone' } });
  assert.equal(byPhone.order.sends[0].recipientFax, null, 'a phone read-over has no fax number to invent');
  assert.equal(orderReq.applySend({ order, actor: PROVIDER, at: AT, input: { channel: 'doximity', recipientFax: '12345' } }).code, 'SEND_BAD_FAX');
});

test('A7: a cancelled or completed order cannot be recorded as faxed', () => {
  const order = build(orderReq.buildReferral, referralInput()).order;
  for (const status of ['cancelled', 'completed', 'resulted']) {
    assert.equal(orderReq.applySend({ order: { ...order, status }, actor: PROVIDER, input: {} }).code, 'ORDER_NOT_SENDABLE', status);
  }
});

test("A7: a referral's appointment date is required to mark it scheduled", () => {
  const sent = orderReq.applySend({ order: build(orderReq.buildReferral, referralInput()).order, actor: PROVIDER, at: AT, input: {} }).order;
  assert.equal(orderReq.applyReferralScheduled({ order: sent, actor: PROVIDER, appointmentDate: '' }).code, 'REFERRAL_NO_APPOINTMENT_DATE');
  const scheduled = orderReq.applyReferralScheduled({ order: sent, actor: PROVIDER, appointmentDate: '2026-10-08', at: AT }).order;
  assert.equal(scheduled.status, 'scheduled');
  assert.equal(scheduled.referral.appointmentDate, '2026-10-08');
  // A lab order has no such state, and asking for one is refused rather than
  // quietly writing a referral field onto it.
  assert.equal(orderReq.applyReferralScheduled({ order: LAB_ORDER(), actor: PROVIDER, appointmentDate: '2026-10-08' }).code, 'ORDER_NOT_REFERRAL');
});

// ══════════════════════════════════════════════════════════════════════════
// A8 — the return fax number lives in the database
// ══════════════════════════════════════════════════════════════════════════

test('A8: the seed writes ONLY IF UNSET, and a second run changes nothing', () => {
  const fresh = orderReq.seedReturnFax({}, consentText.ORG.fax);
  assert.equal(fresh.changed, true);
  assert.equal(fresh.settings.returnFax, '6786927445', 'stored as ten bare digits');

  // A store an ADMIN has already set keeps the admin's value. This is the whole
  // safety of the migration: a boot after a settings edit must not undo it.
  const adminSet = orderReq.seedReturnFax({ returnFax: '4045550000' }, consentText.ORG.fax);
  assert.equal(adminSet.changed, false);
  assert.equal(adminSet.settings.returnFax, '4045550000');
  assert.match(adminSet.reason, /left alone/);

  // Idempotent.
  const again = orderReq.seedReturnFax(fresh.settings, consentText.ORG.fax);
  assert.equal(again.changed, false);
  assert.deepEqual(again.settings, fresh.settings);
});

test('A8: the stored number renders as (678) 692-7445', () => {
  const s = orderReq.normalizeRequisitionSettings({ returnFax: '6786927445' }, {});
  assert.equal(s.returnFax, '6786927445');
  assert.equal(s.returnFaxFormatted, '(678) 692-7445');
  // Unset is NULL and says so — never a fallback literal, because a wrong
  // return number is worse than none.
  assert.equal(orderReq.normalizeRequisitionSettings({}, {}).returnFax, null);
  assert.equal(orderReq.normalizeRequisitionSettings({}, {}).returnFaxFormatted, null);
});

test('A8: THE NUMBER IS IN NO SOURCE FILE — it changes, and that must be a settings edit', () => {
  // The requisition reads it from the DATABASE. The one place the literal is
  // permitted to exist is the ORG identity block in public/consent-text.js,
  // which the seed migration reads FROM — one declaration, not two — and which
  // already prints onto every executed consent.
  //
  // Anything else means a deploy to change a fax number, which is exactly what
  // this test exists to prevent.
  const ALLOWED = new Set([
    'public/consent-text.js',       // the ORG declaration the seed reads from
    'test/order_requisitions.test.js',
    // Pre-existing duplicates of the ORG identity block, flagged as OPEN in
    // CLAUDE.md rather than rewritten here: pdf-generator's ROI_ORG and the
    // portal's ROI footer. They are the consent/ROI documents' org line, not the
    // requisition's return number, and collapsing them is its own change.
    'pdf-generator.js',
    'public/portal.html'
  ]);
  const skipDirs = new Set(['node_modules', '.git', 'docs', 'attached_assets']);
  const offenders = [];
  const walk = (dir, rel = '') => {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!skipDirs.has(e.name)) walk(path.join(dir, e.name), r); continue; }
      if (!/\.(js|json|html|md)$/.test(e.name)) continue;
      if (ALLOWED.has(r)) continue;
      const body = fs.readFileSync(path.join(ROOT, dir, e.name), 'utf8');
      if (/678[-.\s]?692[-.\s]?7445|6786927445/.test(body)) offenders.push(r);
    }
  };
  walk('.');
  assert.deepEqual(offenders, [],
    `the return fax number must not be a literal in: ${offenders.join(', ')} — it lives in requisition_settings`);
  // And the seed genuinely reads the ORG declaration rather than restating it.
  assert.match(SERVER_CODE, /orderReq\.seedReturnFax\(stored, consentText\.ORG\.fax\)/);
});

test('A8: every fax field in this session is a 10-digit US number', () => {
  // A MISTYPED FAX NUMBER IS A MISDIRECTED PHI DISCLOSURE, so nine digits and
  // eleven are both refused rather than guessed at.
  for (const bad of ['678692744', '67869274456', '', null, 'abcdefghij', '0786927445', '1786927445']) {
    assert.equal(orderReq.normalizeFax(bad), null, `refused: ${JSON.stringify(bad)}`);
  }
  // A leading country code is accepted and dropped, because people type it.
  assert.equal(orderReq.normalizeFax('1-678-692-7445'), '6786927445');
  assert.equal(orderReq.normalizeFax('(678) 692-7445'), '6786927445');
  // All four fax fields go through this one function.
  assert.equal(build(orderReq.buildReferral, referralInput({ receivingFax: '678692744' })).code, 'REFERRAL_BAD_FAX');
  assert.equal(build(orderReq.buildDmeOrder, dmeInput({ supplierFax: '67869274456' })).code, 'DME_BAD_SUPPLIER_FAX');
  assert.equal(orderReq.applySend({ order: LAB_ORDER(), actor: PROVIDER, input: { recipientName: 'X', recipientFax: '678692744' } }).code, 'SEND_BAD_FAX');
  assert.match(SERVER_CODE, /orderReq\.normalizeFax\(r\.returnFax\)/, 'the settings route validates the return fax too');
});

// ══════════════════════════════════════════════════════════════════════════
// A9 / C6 — the existing order types, and the overdue clock
// ══════════════════════════════════════════════════════════════════════════

test('A9: lab, imaging and procedure orders get the reference, the send record and the same requisition', async () => {
  for (const type of clinicalRepo.TEST_ORDER_TYPES) {
    const order = clinicalRepo.buildOrder({
      id: `o-${type}`, clientId: 'c1', encounterUuid: 'e1', actor: PROVIDER, encounterDiagnoses: DX, at: AT,
      input: { orderType: type, tests: ['A study'], diagnosisCodes: ['E11.9'] }
    }).order;
    assert.match(order.orderReference, /^GFC-ORD-/);
    assert.deepEqual(order.sends, []);
    const { pages } = await renderRequisition(order);
    assert.ok(pages[0].includes(order.orderReference));
  }
});

test('A9: an order record written before 4.10 still loads and can be sent', () => {
  // The four order records in test data have no orderReference and no sends.
  const legacy = {
    id: 'legacy', clientId: 'c1', orderType: 'lab', tests: ['A1c'], priority: 'routine',
    diagnosisCodes: ['E11.9'], status: 'ordered', statusHistory: [{ status: 'ordered', at: AT }],
    orderingClinician: { id: 'p1', name: 'Bethel Godwins', npi: '1234567893' }, encounterUuid: 'e1'
  };
  const out = orderReq.applySend({ order: legacy, actor: PROVIDER, at: AT, input: { recipientName: 'Quest', recipientFax: '4045550123' } });
  assert.equal(out.order.status, 'sent');
  assert.equal(out.order.sends.length, 1, 'a missing sends array is treated as empty, not as a crash');
  assert.equal(orderReq.overdueAgeDays(out.order, '2026-09-30T14:00:00.000Z'), 8);
});

test('C6: the overdue clock — a lab at day 8 and NOT at day 6', () => {
  assert.deepEqual(orderReq.OVERDUE_DAYS, { lab: 7, imaging: 14, referral: 30, procedure: 14, dme: 14 });
  const sent = orderReq.applySend({ order: LAB_ORDER(), actor: PROVIDER, at: '2026-09-01T14:00:00.000Z', input: { recipientName: 'Quest', recipientFax: '4045550123' } }).order;
  assert.equal(orderReq.isOverdue(sent, '2026-09-07T14:00:00.000Z'), false, 'day 6 is not overdue');
  assert.equal(orderReq.isOverdue(sent, '2026-09-09T14:00:00.000Z'), true, 'day 8 is');
  // An order that has NOT been sent is not overdue — nothing is waiting on the
  // outside world until it has gone.
  assert.equal(orderReq.isOverdue(LAB_ORDER(), '2026-12-01T00:00:00.000Z'), false);
  // A resulted or cancelled order is off the list.
  assert.equal(orderReq.isOverdue({ ...sent, status: 'resulted' }, '2026-12-01T00:00:00.000Z'), false);
  assert.equal(orderReq.isOverdue({ ...sent, status: 'cancelled' }, '2026-12-01T00:00:00.000Z'), false);
  // Each type has its own threshold and they are not collapsed.
  const imaging = { ...sent, orderType: 'imaging' };
  assert.equal(orderReq.isOverdue(imaging, '2026-09-09T14:00:00.000Z'), false, 'imaging waits 14 days');
  assert.equal(orderReq.isOverdue(imaging, '2026-09-16T14:00:00.000Z'), true);
});

test('C6: the clock restarts at the LAST send, not the first', () => {
  // A referral re-faxed to a corrected number has been waiting since THAT fax.
  // Measuring from the first would show a corrected order as overdue on the day
  // it was finally sent properly.
  const first = orderReq.applySend({ order: build(orderReq.buildReferral, referralInput()).order, actor: PROVIDER, at: '2026-08-01T14:00:00.000Z', input: {} }).order;
  const second = orderReq.applySend({ order: first, actor: PROVIDER, at: '2026-09-20T14:00:00.000Z', input: {} }).order;
  assert.equal(orderReq.overdueAgeDays(second, '2026-09-22T14:00:00.000Z'), 2);
  assert.equal(orderReq.isOverdue(second, '2026-09-22T14:00:00.000Z'), false);
});

test('C6: the overdue list carries the recipient and the number, so somebody can call', () => {
  const sent = orderReq.applySend({ order: LAB_ORDER(), actor: PROVIDER, at: '2026-09-01T14:00:00.000Z', input: { recipientName: 'Quest Diagnostics', recipientFax: '4045550123' } }).order;
  const rows = orderReq.buildOverdueList([sent, LAB_ORDER()], '2026-09-20T14:00:00.000Z');
  assert.equal(rows.length, 1, 'an unsent order is not on the list');
  assert.equal(rows[0].recipientName, 'Quest Diagnostics');
  assert.equal(rows[0].recipientFax, '4045550123');
  assert.equal(rows[0].thresholdDays, 7);
  assert.equal(rows[0].orderReference, sent.orderReference);
  // Oldest first — the longest-unanswered order is the one most likely lost.
  const older = orderReq.applySend({ order: { ...LAB_ORDER(), id: 'older' }, actor: PROVIDER, at: '2026-08-01T14:00:00.000Z', input: { recipientName: 'Q', recipientFax: '4045550123' } }).order;
  const both = orderReq.buildOverdueList([sent, older], '2026-09-20T14:00:00.000Z');
  assert.equal(both[0].id, 'older');
});

// ══════════════════════════════════════════════════════════════════════════
// The order reference — the matching mechanism
// ══════════════════════════════════════════════════════════════════════════

test('the order reference excludes every character ambiguous on a fax', () => {
  // Somebody reads this off a poor fax and types it in. 0/O, 1/I/L, 2/Z, 5/S
  // and 8/B are all out, so a misread cannot land on another valid reference.
  for (const c of '01258OILZSB') {
    assert.ok(!orderReq.REF_ALPHABET.includes(c), `${c} is ambiguous on a fax and must not be in the alphabet`);
  }
  for (let i = 0; i < 200; i++) {
    const ref = orderReq.buildOrderReference();
    assert.match(ref, /^GFC-ORD-[34679ACDEFGHJKMNPQRTUVWXY]{6}$/);
    assert.equal(orderReq.parseOrderReference(ref), ref, 'round-trips');
  }
});

test('the reference is parsed tolerantly out of free text, and a non-GFC one is refused', () => {
  assert.equal(orderReq.parseOrderReference('re: GFC-ORD-K93VYA thanks'), 'GFC-ORD-K93VYA');
  assert.equal(orderReq.parseOrderReference('gfcordk93vya'), 'GFC-ORD-K93VYA');
  assert.equal(orderReq.parseOrderReference('GFC ORD K93VYA'), 'GFC-ORD-K93VYA');
  // A reference carrying an excluded character is not one of ours. Returning it
  // anyway would match nothing and read as "no such order" when the real answer
  // is "that is not a GFC reference".
  assert.equal(orderReq.parseOrderReference('GFC-ORD-K93VY0'), null);
  assert.equal(orderReq.parseOrderReference('nothing here'), null);
  assert.equal(orderReq.parseOrderReference(''), null);
});

test('the reference is minted with the ORDER, never at print time', () => {
  // A reference that changes between two printings cannot match anything.
  const order = LAB_ORDER();
  const ref = order.orderReference;
  assert.ok(ref);
  assert.match(CODE(read('clinicalRepository.js')), /orderReference:\s*orderReference \|\| require\('\.\/orderRequisitions'\)\.buildOrderReference\(\)/);
});

// ══════════════════════════════════════════════════════════════════════════
// Build enforcement — the seams a later session would walk through
// ══════════════════════════════════════════════════════════════════════════

test('build: the new collections are claimed in the migration registry', () => {
  const reg = read('dataMigration.js');
  assert.match(reg, /key: 'clinical_results', phi: true/);
  assert.match(reg, /key: 'requisition_settings', phi: false/);
});

test('build: the page names no order vocabulary of its own — all of it is SERVED', () => {
  const page = CODE(read('public/clinical.html'));
  // A form that restates its options drifts from the validator that refuses one
  // it did not offer, silently.
  // NOT ONE channel name appears in the page. The first draft of this session
  // put 'doximity' in three places — a form-state default, a fallback for the
  // picker, and the fax/no-fax split — and this assertion is what found them.
  // Which channels carry a fax number is now declared once in the module and
  // served, so the form cannot disagree with the validator about it.
  assert.ok(!/SEND_CHANNELS|'doximity'|'efax'/.test(page), 'the channel list is served, not restated');
  assert.match(page, /faxChannels \|\| \[\]\)\.includes\(send\.channel\)/, 'the fax split is served too');
  assert.match(SERVER_CODE, /sendChannels:\s*orderReq\.SEND_CHANNELS/);
  assert.match(SERVER_CODE, /documentOrderTypes:\s*orderReq\.DOCUMENT_ORDER_TYPES/);
  assert.match(SERVER_CODE, /referralTransitions:\s*orderReq\.REFERRAL_TRANSITIONS/);
  assert.match(SERVER_CODE, /faxSendChannels:\s*orderReq\.FAX_SEND_CHANNELS/);
  // And the module declares it ONCE: the send builder reads the same list the
  // form is given, so a channel added to one cannot be missing from the other.
  assert.match(CODE(read('orderRequisitions.js')), /if \(FAX_SEND_CHANNELS\.includes\(channel\)\)/);
});

test('build: the requisition route is a clinical READ, and the send is a WRITE', () => {
  // A case manager may open a requisition — they read charts. They may not
  // record that one was faxed, because that is a disclosure record.
  assert.match(SERVER_CODE, /requisition\.pdf', authenticateToken, requireClinicalRead/);
  assert.match(SERVER_CODE, /orders\/:orderId\/sent', authenticateToken, requireClinicalWrite/);
  assert.match(SERVER_CODE, /orders\/overdue', authenticateToken, requireClinicalRead/);
});
