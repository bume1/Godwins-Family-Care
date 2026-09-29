// ============================================================================
// Updating where an order goes (owner, 2026-09-29)
//
// A referral or written order is placed by the clinician; WHO receives it is
// usually confirmed afterwards by the office or social work. What this file pins:
//
//   1. The edit reaches DESTINATION fields and nothing else. A body naming a
//      clinical field is refused BY NAME, never silently dropped.
//   2. A case manager holds this one door and stays read-only everywhere else.
//   3. A fax number changed after the order was faxed needs a reason, raises a
//      re-send flag, and leaves the earlier send exactly as it was.
//   4. Completed and cancelled orders cannot have their destination rewritten.
//   5. The route is not behind requireClinicalWrite (which would shut a case
//      manager out) and does not restate the rules the module owns.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const orderReq = require('../orderRequisitions');
const roles = require('../clinicalRoles');

const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'clinical.html'), 'utf8');

const ACTOR = { id: 'u-np', name: 'Bethel Godwins', licenseLevel: 'FNP-BC', npi: '1902310568' };
const CM = { id: 'u-cm', name: 'Courtney Hale', role: 'caseManager', clinicalRole: 'readOnly' };
const DX = [{ code: 'E11.9', description: 'Type 2 diabetes' }];

const referral = (extra = {}) => orderReq.buildReferral({
  id: 'o1', clientId: 'c1', encounterUuid: 'e1', actor: ACTOR, encounterDiagnoses: DX,
  input: {
    specialty: 'Home health', receivingPractice: 'TBD', receivingFax: '4045550123',
    reason: 'Skilled nursing and PT', clinicalSummary: 'Can she start care this week?',
    diagnosisCodes: ['E11.9'], ...extra
  }
}).order;
const dme = () => orderReq.buildDmeOrder({
  id: 'o2', clientId: 'c1', encounterUuid: 'e1', actor: ACTOR, encounterDiagnoses: DX,
  client: { name: 'Juanita Guess', payer: { memberId: '1EG4TE5MK73' } },
  input: {
    itemDescription: 'Rolling walker', quantity: 1, supplierName: 'Acme Medical', supplierFax: '4045550100',
    lengthOfNeed: '99 months', diagnosisCodes: ['E11.9']
  }
}).order;
const lab = () => ({ id: 'o3', orderType: 'lab', status: 'ordered', tests: ['CBC'], sends: [] });

// ── The pure module ─────────────────────────────────────────────────────────

test('a referral destination is updated, and only the keys sent change', () => {
  const o = referral();
  const r = orderReq.applyDestinationEdit({ order: o, actor: CM, input: { receivingPractice: 'Kindred at Home', receivingProvider: 'Intake desk' } });
  assert.ok(r.order, JSON.stringify(r));
  assert.equal(r.order.referral.receivingPractice, 'Kindred at Home');
  assert.equal(r.order.referral.receivingProvider, 'Intake desk');
  assert.equal(r.order.referral.receivingFax, '4045550123', 'an absent key is left alone');
  assert.deepEqual(r.changes.map(c => c.field), ['receivingPractice', 'receivingProvider']);
  assert.equal(r.changes[0].from, 'TBD');
});

test('the source order is never mutated', () => {
  const o = referral();
  const snap = JSON.stringify(o);
  orderReq.applyDestinationEdit({ order: o, actor: CM, input: { receivingPractice: 'Kindred' } });
  assert.equal(JSON.stringify(o), snap);
});

test('CLINICAL FIELDS ARE REFUSED BY NAME, and nothing is written', () => {
  const o = referral();
  for (const key of ['clinicalSummary', 'reason', 'specialty', 'diagnosisCodes', 'status', 'orderingClinician', 'priorAuthRequired', 'sends']) {
    const r = orderReq.applyDestinationEdit({ order: o, actor: CM, input: { receivingPractice: 'Kindred', [key]: 'x' } });
    assert.equal(r.code, 'ORDER_DESTINATION_FIELD_NOT_EDITABLE', `${key} must be refused`);
    assert.ok(r.error.includes(key), 'the refusal names the field');
    assert.equal(r.order, undefined);
  }
});

test('a DME supplier is editable, and its written-order content is not', () => {
  const o = dme();
  const r = orderReq.applyDestinationEdit({ order: o, actor: CM, input: { supplierName: 'Better Medical', supplierFax: '(770) 555-0111' } });
  assert.equal(r.order.dme.supplierName, 'Better Medical');
  assert.equal(r.order.dme.supplierFax, '7705550111', 'stored as bare ten digits');
  assert.equal(r.order.dme.itemDescription, 'Rolling walker');
  const bad = orderReq.applyDestinationEdit({ order: o, actor: CM, input: { quantity: 4 } });
  assert.equal(bad.code, 'ORDER_DESTINATION_FIELD_NOT_EDITABLE');
});

test('an order type with no destination (a lab) cannot be edited here', () => {
  const r = orderReq.applyDestinationEdit({ order: lab(), actor: CM, input: { receivingFax: '4045550123' } });
  assert.equal(r.code, 'ORDER_NO_DESTINATION');
  assert.equal(r.status, 400);
});

test('a completed, cancelled or missing order is refused', () => {
  for (const status of ['completed', 'cancelled', 'resulted']) {
    const r = orderReq.applyDestinationEdit({ order: { ...referral(), status }, actor: CM, input: { receivingPractice: 'X' } });
    assert.equal(r.code, 'ORDER_DESTINATION_LOCKED', status);
    assert.equal(r.status, 409);
  }
  assert.equal(orderReq.applyDestinationEdit({ order: null, actor: CM, input: {} }).status, 404);
});

test('every fax is ten digits, and the required fields cannot be blanked', () => {
  const o = referral();
  assert.equal(orderReq.applyDestinationEdit({ order: o, actor: CM, input: { receivingFax: '404555012' } }).code, 'REFERRAL_BAD_FAX');
  assert.equal(orderReq.applyDestinationEdit({ order: o, actor: CM, input: { receivingFax: '' } }).code, 'REFERRAL_BAD_FAX');
  assert.equal(orderReq.applyDestinationEdit({ order: dme(), actor: CM, input: { supplierFax: '12' } }).code, 'DME_BAD_SUPPLIER_FAX');
  assert.equal(orderReq.applyDestinationEdit({ order: dme(), actor: CM, input: { supplierName: '   ' } }).code, 'DME_NO_SUPPLIER');
});

test('an optional field can be cleared with a blank value', () => {
  const o = referral({ receivingProvider: 'Dr Patel', receivingPhone: '4045550199' });
  const r = orderReq.applyDestinationEdit({ order: o, actor: CM, input: { receivingProvider: '' } });
  assert.equal(r.order.referral.receivingProvider, null);
  assert.equal(r.order.referral.receivingPhone, '4045550199');
});

test('sending nothing new is refused rather than answering saved', () => {
  const o = referral();
  const r = orderReq.applyDestinationEdit({ order: o, actor: CM, input: { receivingFax: '(404) 555-0123' } });
  assert.equal(r.code, 'ORDER_DESTINATION_NO_CHANGE');
  assert.equal(orderReq.applyDestinationEdit({ order: o, actor: CM, input: {} }).code, 'ORDER_DESTINATION_NO_CHANGE');
});

test('every change is recorded, append-only, with who and when', () => {
  const o = referral();
  const a = orderReq.applyDestinationEdit({ order: o, actor: CM, at: '2026-09-29T15:00:00.000Z', input: { receivingPractice: 'Kindred' } });
  const b = orderReq.applyDestinationEdit({ order: a.order, actor: { ...CM, name: 'Second Person' }, at: '2026-09-30T15:00:00.000Z', input: { receivingProvider: 'Intake' } });
  assert.equal(b.order.destinationHistory.length, 2);
  assert.equal(b.order.destinationHistory[0].by.name, 'Courtney Hale');
  assert.equal(b.order.destinationHistory[0].at, '2026-09-29T15:00:00.000Z');
  assert.equal(b.order.destinationHistory[1].by.name, 'Second Person');
  assert.equal(b.order.destinationHistory[0].changes[0].from, 'TBD');
  assert.equal(b.order.destinationHistory[0].changes[0].to, 'Kindred');
});

test('BEFORE ANY SEND, a fax change needs no reason and raises no flag', () => {
  const r = orderReq.applyDestinationEdit({ order: referral(), actor: CM, input: { receivingFax: '7705550111' } });
  assert.ok(r.order);
  assert.equal(r.order.resendNeeded, false);
  assert.equal(r.resendNeeded, false);
});

test('AFTER A SEND, a fax change needs a reason, raises the re-send flag, and leaves the earlier send alone', () => {
  const sent = orderReq.applySend({ order: referral(), actor: ACTOR, input: { channel: 'doximity' } }).order;
  const noReason = orderReq.applyDestinationEdit({ order: sent, actor: CM, input: { receivingFax: '7705550111' } });
  assert.equal(noReason.code, 'ORDER_DESTINATION_REASON_REQUIRED');
  const r = orderReq.applyDestinationEdit({ order: sent, actor: CM, input: { receivingFax: '7705550111', changeReason: 'Agency confirmed a different intake fax' } });
  assert.equal(r.order.resendNeeded, true);
  assert.equal(r.order.sends.length, 1);
  assert.equal(r.order.sends[0].recipientFax, '4045550123', 'the first send is a disclosure that happened; it is not rewritten');
  assert.equal(r.order.status, 'sent');
  assert.equal(r.order.destinationHistory[0].reason, 'Agency confirmed a different intake fax');
});

test('a name-only change after a send needs no reason and raises no flag', () => {
  const sent = orderReq.applySend({ order: referral(), actor: ACTOR, input: { channel: 'doximity' } }).order;
  const r = orderReq.applyDestinationEdit({ order: sent, actor: CM, input: { receivingPractice: 'Kindred at Home' } });
  assert.ok(r.order);
  assert.equal(r.order.resendNeeded, false);
});

test('recording the re-send clears the flag, and it goes to the NEW number', () => {
  const sent = orderReq.applySend({ order: referral(), actor: ACTOR, input: { channel: 'doximity' } }).order;
  const moved = orderReq.applyDestinationEdit({ order: sent, actor: CM, input: { receivingFax: '7705550111', changeReason: 'new fax' } }).order;
  assert.equal(moved.resendNeeded, true);
  const again = orderReq.applySend({ order: moved, actor: ACTOR, input: { channel: 'doximity' } });
  assert.equal(again.order.resendNeeded, false);
  assert.equal(again.order.sends.length, 2);
  assert.equal(again.order.sends[1].recipientFax, '7705550111');
});

test('the form fields are served from the same table the validator reads', () => {
  const served = orderReq.destinationFormFields();
  assert.deepEqual(Object.keys(served).sort(), Object.keys(orderReq.DESTINATION_FIELDS).sort());
  assert.ok(served.referral.find(f => f.key === 'receivingFax').fax);
  assert.ok(served.dme.find(f => f.key === 'supplierName').required);
});

// ── Who may ─────────────────────────────────────────────────────────────────

test('who may update a destination', () => {
  const yes = [
    { role: 'admin' },
    { role: 'caseManager' },
    { role: 'user', isManager: true },
    { role: 'user', clinicalRole: 'provider' },
    { role: 'user', clinicalRole: 'rn' },
    { role: 'user', clinicalRole: 'lcsw' },
    { role: 'caseManager', clinicalRole: 'lmsw' }
  ];
  for (const u of yes) assert.equal(roles.canEditOrderDestination(u), true, JSON.stringify(u));
  const no = [
    null, undefined,
    { role: 'client' }, { role: 'family' }, { role: 'vendor', licenseLevel: 'CNA' },
    { role: 'user' }, { role: 'user', clinicalRole: 'readOnly' },
    { role: 'caseManager', accountStatus: 'inactive' },
    { role: 'admin', accountStatus: 'inactive' }
  ];
  for (const u of no) assert.equal(roles.canEditOrderDestination(u), false, JSON.stringify(u));
});

test('a case manager gains NOTHING else: still read-only, still no order status, send or result', () => {
  const cm = { role: 'caseManager', clinicalRole: 'readOnly' };
  assert.equal(roles.canClinicalWrite(cm), false);
  assert.equal(roles.can(cm, roles.CAPABILITIES.ORDER_STATUS_ADVANCE), false);
  assert.equal(roles.can(cm, roles.CAPABILITIES.ORDER_DIRECT), false);
  assert.equal(roles.canSubmitBilling(cm), false);
});

// ── The route, run rather than read ─────────────────────────────────────────

const liftRoute = () => {
  const start = SERVER.indexOf('const requireOrderDestinationEditor');
  const end = SERVER.indexOf("// ── POST …/orders/:orderId/scheduled");
  assert.ok(start > 0 && end > start, 'the route block must be findable');
  const src = SERVER.slice(start, end);
  const routes = {};
  const app = { put: (p, ...h) => { routes[p] = h; } };
  const audit = [];
  const state = { rows: [], client: { id: 'c1' } };
  const fn = new Function('app', 'authenticateToken', 'clinicalRoles', 'orderReq', 'loadOrderForActor', 'db', 'logActivity', 'actorFromReq',
    `${src}; return { requireOrderDestinationEditor };`);
  const built = fn(
    app, 'AUTH', roles, orderReq,
    async (id, res) => {
      const idx = state.rows.findIndex(o => o.id === id);
      if (idx === -1) { res.status(404).json({ error: 'Order not found', code: 'ORDER_NOT_FOUND' }); return null; }
      return { rows: state.rows, idx, order: state.rows[idx], client: state.client };
    },
    { set: async (k, v) => { state.saved = { k, v }; } },
    async (...a) => { audit.push(a); },
    (req) => ({ id: req.user.id, name: req.user.name, role: req.user.role, clinicalRole: roles.resolveClinicalRole(req.user) })
  );
  return { routes, audit, state, ...built };
};
const mkRes = () => {
  const r = { code: 200, body: null };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
};
const PATH = '/api/clinical/orders/:orderId/destination';

test('THE ROUTE: a case manager updates the destination and the stored row follows', async () => {
  const h = liftRoute();
  h.state.rows.push(referral());
  const [auth, gate, handler] = h.routes[PATH];
  assert.equal(auth, 'AUTH');
  const req = { params: { orderId: 'o1' }, body: { receivingPractice: 'Kindred at Home', receivingFax: '7705550111' }, user: { ...CM } };
  const gateRes = mkRes(); let passed = false;
  gate(req, gateRes, () => { passed = true; });
  assert.ok(passed, 'the case manager passes the gate');
  const res = mkRes();
  await handler(req, res);
  assert.equal(res.code, 200, JSON.stringify(res.body));
  assert.equal(h.state.saved.k, 'clinical_orders');
  assert.equal(h.state.saved.v[0].referral.receivingPractice, 'Kindred at Home');
  assert.equal(h.state.saved.v[0].referral.receivingFax, '7705550111');
  assert.equal(h.state.saved.v[0].destinationHistory[0].by.name, 'Courtney Hale');
  assert.equal(h.audit.length, 1);
  assert.equal(h.audit[0][2], 'order_destination_updated');
  assert.deepEqual(h.audit[0][5].fields, ['receivingPractice', 'receivingFax']);
  assert.equal(h.audit[0][5].faxTo, '7705550111');
});

test('THE ROUTE: the audit row carries no clinical content', async () => {
  const h = liftRoute();
  h.state.rows.push(referral());
  const [, , handler] = h.routes[PATH];
  await handler({ params: { orderId: 'o1' }, body: { receivingPractice: 'Kindred' }, user: { ...CM } }, mkRes());
  const blob = JSON.stringify(h.audit);
  assert.ok(!/Can she start care|Skilled nursing|E11\.9/.test(blob), blob);
});

test('THE ROUTE: a clinical field is refused with 400 and the stored row is untouched', async () => {
  const h = liftRoute();
  h.state.rows.push(referral());
  const [, , handler] = h.routes[PATH];
  const res = mkRes();
  await handler({ params: { orderId: 'o1' }, body: { clinicalSummary: 'rewritten' }, user: { ...CM } }, res);
  assert.equal(res.code, 400);
  assert.equal(res.body.code, 'ORDER_DESTINATION_FIELD_NOT_EDITABLE');
  assert.equal(h.state.saved, undefined, 'nothing was written');
  assert.equal(h.state.rows[0].referral.clinicalSummary, 'Can she start care this week?');
});

test('THE ROUTE: a fax change on a sent order is refused until a reason is given', async () => {
  const h = liftRoute();
  h.state.rows.push(orderReq.applySend({ order: referral(), actor: ACTOR, input: { channel: 'doximity' } }).order);
  const [, , handler] = h.routes[PATH];
  const res = mkRes();
  await handler({ params: { orderId: 'o1' }, body: { receivingFax: '7705550111' }, user: { ...CM } }, res);
  assert.equal(res.code, 400);
  assert.equal(res.body.code, 'ORDER_DESTINATION_REASON_REQUIRED');
  const ok = mkRes();
  await handler({ params: { orderId: 'o1' }, body: { receivingFax: '7705550111', changeReason: 'confirmed' }, user: { ...CM } }, ok);
  assert.equal(ok.code, 200);
  assert.equal(ok.body.resendNeeded, true);
  assert.match(ok.body.message, /record another send/i);
});

test('THE ROUTE: a missing order is 404, a lab is 400', async () => {
  const h = liftRoute();
  h.state.rows.push(lab());
  const [, , handler] = h.routes[PATH];
  const missing = mkRes();
  await handler({ params: { orderId: 'nope' }, body: {}, user: { ...CM } }, missing);
  assert.equal(missing.code, 404);
  const l = mkRes();
  await handler({ params: { orderId: 'o3' }, body: { receivingFax: '4045550123' }, user: { ...CM } }, l);
  assert.equal(l.code, 400);
  assert.equal(l.body.code, 'ORDER_NO_DESTINATION');
});

test('THE GATE: clients, family, caregivers and anonymous callers are refused', () => {
  const h = liftRoute();
  const [, gate] = h.routes[PATH];
  for (const user of [{ role: 'client' }, { role: 'family' }, { role: 'vendor', licenseLevel: 'CNA' }, { role: 'user' }, { role: 'caseManager', accountStatus: 'inactive' }]) {
    const res = mkRes(); let passed = false;
    gate({ user }, res, () => { passed = true; });
    assert.equal(passed, false, JSON.stringify(user));
    assert.equal(res.code, 403);
    assert.equal(res.body.code, 'ORDER_DESTINATION_ONLY');
  }
});

// ── Wiring, guarded against drift ───────────────────────────────────────────

test('the route is behind its own gate, NOT requireClinicalWrite, which would shut a case manager out', () => {
  const line = SERVER.split('\n').find(l => l.startsWith("app.put('/api/clinical/orders/:orderId/destination'"));
  assert.ok(line, 'the route must exist');
  assert.match(line, /authenticateToken, requireOrderDestinationEditor,/);
  assert.doesNotMatch(line, /requireClinicalWrite|requireClinicalRead/);
});

test('the gate reads the one predicate, and the route does not write a destination itself', () => {
  const start = SERVER.indexOf('const requireOrderDestinationEditor');
  const block = SERVER.slice(start, SERVER.indexOf("// ── POST …/orders/:orderId/scheduled"));
  assert.match(block, /clinicalRoles\.canEditOrderDestination\(req\.user\)/);
  assert.match(block, /orderReq\.applyDestinationEdit\(/);
  assert.doesNotMatch(block, /\.receivingFax\s*=|\.supplierFax\s*=|\.referral\s*=|\.dme\s*=|normalizeFax/, 'the rules live in the module');
});

test('the page draws its form from the served field list and asks the server who may edit', () => {
  assert.match(PAGE, /destinationFields\[order\.orderType\]/);
  assert.match(PAGE, /useCanEditOrderDestination/);
  assert.match(PAGE, /access\.canEditOrderDestination/);
  assert.doesNotMatch(PAGE, /label:\s*['"]Receiving practice['"]/, 'the page must not restate the field list');
  assert.match(PAGE, /\/api\/clinical\/orders\/\$\{orderId\}\/destination/);
});

test('the status route serves the flag from the same predicate', () => {
  assert.match(SERVER, /canEditOrderDestination: clinicalRoles\.canEditOrderDestination\(req\.user\)/);
});

test('no other order write is opened to a case manager', () => {
  for (const p of ["orders/:orderId/sent'", "orders/:orderId/scheduled'", "orders/:orderId/status'", "orders/:orderId/result'"]) {
    const i = SERVER.indexOf(`app.post('/api/clinical/${p}`);
    assert.ok(i > 0, p);
    assert.match(SERVER.slice(i, i + 220), /requireClinicalWrite/, `${p} must stay behind requireClinicalWrite`);
  }
});

// ── Placing an order before the agency is known (owner, 2026-09-29) ─────────
// Home health is the case: the agency is confirmed after the order is placed,
// by the office. A referral can be recorded with NO fax when the clinician says
// so on purpose; nothing can be sent until the agency and fax are added.

const pendingRef = (extra = {}) => orderReq.buildReferral({
  id: 'op', clientId: 'c1', encounterUuid: 'e1', actor: ACTOR, encounterDiagnoses: DX,
  input: {
    specialty: 'Home health', reason: 'Skilled nursing and PT', clinicalSummary: 'Homebound, repeated falls.',
    diagnosisCodes: ['E11.9'], agencyPending: true, ...extra
  }
});

test('AGENCY PENDING: a referral can be placed with no fax when the flag is ticked', () => {
  const r = pendingRef();
  assert.ok(r.order, JSON.stringify(r));
  assert.equal(r.order.referral.receivingFax, null);
  assert.equal(r.order.referral.agencyPending, true);
  assert.equal(orderReq.isAgencyPending(r.order), true);
});

test('AGENCY PENDING: no flag and no fax is still refused exactly as before', () => {
  const r = pendingRef({ agencyPending: false });
  assert.equal(r.code, 'REFERRAL_BAD_FAX');
  assert.match(r.error, /Agency not confirmed yet/);
});

test('AGENCY PENDING: the flag never lets a mistyped fax through', () => {
  const r = pendingRef({ receivingFax: '404555012' });
  assert.equal(r.code, 'REFERRAL_BAD_FAX', 'a typed fax is validated whether or not the flag is set');
});

test('AGENCY PENDING: a valid fax typed alongside the flag means it is not pending', () => {
  const r = pendingRef({ receivingFax: '4045550123' });
  assert.equal(r.order.referral.agencyPending, false);
  assert.equal(r.order.referral.receivingFax, '4045550123');
  assert.equal(orderReq.isAgencyPending(r.order), false);
});

test('AGENCY PENDING: only a referral can be pending, and a DME order still needs its supplier fax', () => {
  assert.equal(orderReq.isAgencyPending({ orderType: 'dme', dme: { agencyPending: true } }), false);
  const built = orderReq.buildDmeOrder({
    id: 'o9', clientId: 'c1', encounterUuid: 'e1', actor: ACTOR, encounterDiagnoses: DX,
    client: { name: 'Juanita Guess' },
    input: { itemDescription: 'Walker', quantity: 1, supplierName: 'Acme', lengthOfNeed: '99 months', diagnosisCodes: ['E11.9'], agencyPending: true }
  });
  assert.equal(built.code, 'DME_BAD_SUPPLIER_FAX');
});

test('AGENCY PENDING: nothing can be faxed until the agency is added', () => {
  const o = pendingRef().order;
  const r = orderReq.applySend({ order: o, actor: ACTOR, input: { channel: 'doximity' } });
  assert.equal(r.code, 'ORDER_AGENCY_PENDING');
  assert.equal(r.status, 409);
  assert.equal(r.order, undefined);
  const noChannel = orderReq.applySend({ order: o, actor: ACTOR, input: {} });
  assert.equal(noChannel.code, 'ORDER_AGENCY_PENDING', 'the default channel is a fax');
});

test('AGENCY PENDING: the office can save the practice first, and it stays pending', () => {
  const o = pendingRef().order;
  const r = orderReq.applyDestinationEdit({ order: o, actor: CM, input: { receivingPractice: 'Kindred at Home', receivingFax: '' } });
  assert.ok(r.order, JSON.stringify(r));
  assert.equal(r.order.referral.receivingPractice, 'Kindred at Home');
  assert.equal(r.order.referral.agencyPending, true);
  assert.deepEqual(r.changes.map(c => c.field), ['receivingPractice']);
});

test('AGENCY PENDING: adding a valid fax confirms the agency, needs no reason, and unlocks sending to that number', () => {
  const o = pendingRef().order;
  const r = orderReq.applyDestinationEdit({ order: o, actor: CM, input: { receivingPractice: 'Kindred at Home', receivingFax: '(770) 555-0111' } });
  assert.ok(r.order, JSON.stringify(r));
  assert.equal(r.order.referral.receivingFax, '7705550111');
  assert.equal(r.order.referral.agencyPending, false);
  assert.equal(r.order.resendNeeded, false, 'nothing was sent, so there is nothing to re-send');
  const sent = orderReq.applySend({ order: r.order, actor: ACTOR, input: { channel: 'doximity' } });
  assert.ok(sent.order, JSON.stringify(sent));
  assert.equal(sent.order.sends[0].recipientFax, '7705550111');
  assert.equal(sent.order.sends[0].recipientName, 'Kindred at Home');
});

test('AGENCY PENDING: a wrong fax on a pending order is still refused, and a blank-only save is no change', () => {
  const o = pendingRef().order;
  assert.equal(orderReq.applyDestinationEdit({ order: o, actor: CM, input: { receivingFax: '12345' } }).code, 'REFERRAL_BAD_FAX');
  assert.equal(orderReq.applyDestinationEdit({ order: o, actor: CM, input: { receivingFax: '' } }).code, 'ORDER_DESTINATION_NO_CHANGE');
});

test('AGENCY PENDING: a NON-pending order still cannot have its fax blanked', () => {
  const r = orderReq.applyDestinationEdit({ order: referral(), actor: CM, input: { receivingFax: '' } });
  assert.equal(r.code, 'REFERRAL_BAD_FAX');
});

test('AGENCY PENDING (route): the case manager fills in a pending order and the stored row follows', async () => {
  const h = liftRoute();
  h.state.rows.push(pendingRef().order);
  const [, , handler] = h.routes[PATH];
  const res = mkRes();
  await handler({ params: { orderId: 'op' }, body: { receivingPractice: 'Kindred', receivingFax: '7705550111' }, user: { ...CM } }, res);
  assert.equal(res.code, 200, JSON.stringify(res.body));
  assert.equal(h.state.saved.v[0].referral.agencyPending, false);
  assert.equal(h.state.saved.v[0].referral.receivingFax, '7705550111');
});

test('AGENCY PENDING (wiring): requisition refused while pending, waiting list served, page shows it', () => {
  const start = SERVER.indexOf("app.get('/api/clinical/orders/:orderId/requisition.pdf'");
  const reqRoute = SERVER.slice(start, start + 1500);
  assert.match(reqRoute, /orderReq\.isAgencyPending\(order\)/);
  assert.match(reqRoute, /ORDER_AGENCY_PENDING/);
  const od = SERVER.indexOf("app.get('/api/clinical/orders/overdue'");
  assert.match(SERVER.slice(od, od + 2500), /agencyPending: waiting/);
  assert.match(PAGE, /Agency not confirmed yet/);
  assert.match(PAGE, /Needs agency/);
  assert.match(PAGE, /Waiting on an agency/);
  assert.match(PAGE, /\{!agencyPending && <a className="chip[^>]*href=\{api\.requisitionUrl/, 'the requisition link is hidden while pending');
});
