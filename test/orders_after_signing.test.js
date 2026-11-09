'use strict';
// New Order from the chart, and an order on a signed visit (owner, 2026-11-09).
//
// "We need to be able to create orders like a standard practice." The chart's
// Orders tab places an order without opening a visit first. It picks an open
// draft, or the most recent SIGNED visit, where the order may use only the
// diagnoses the visit was signed with and is written onto the note as an
// addendum. One submit is one order, and an OpenEMR failure says what it is.
//
// The HTTP half is scripts/verify_new_order.js (real server, real routes).
//
// Mutations each confirmed to fail a test here:
//   M1  the route allows any closed visit without the page asking (afterSigning)
//   M2  the signed-diagnosis filter dropped (record.diagnoses used after signing)
//   M3  the addendum not written after signing
//   M4  refuseIfClosed called unconditionally (after-signing always refused)
//   M5  the replay check removed
//   M6  the submit key not scoped by user
//   M7  the in-flight key never released (finally removed)
//   M8  the generic order failure kept (no emrFailureResponse)
//   M9  the page makes a new key per click instead of per form
//   M10 the encounter form passes the unsaved diagnoses again
//   M11 an older signed visit offered as a target
//   M12 the addendum text carries the clinical summary
//   M13 the submit key reaches the browser
//   M14 a second submit while the first is saving is not refused (caught by
//       the probe's double-click check, scripts/verify_new_order.js)
// One check changes nothing today and is kept on purpose: canPlaceOrders'
// clinical-write test. No role holds an order capability without clinical
// write, so removing it changed no result; it mirrors the route's own gate so
// a capability granted later cannot put the button in front of someone the
// route refuses.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const orderReq = require('../orderRequisitions');
const clinicalRepo = require('../clinicalRepository');

const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const SERVER = strip(fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8'));
const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'clinical.html'), 'utf8');
const routeBody = (src, start) => {
  const a = src.indexOf(start);
  assert.ok(a >= 0, `route moved: ${start}`);
  return src.slice(a, src.indexOf('\n});\n', a) + 5);
};
const fnBody = (src, start, end = '\n    };\n') => {
  const a = src.indexOf(start);
  assert.ok(a >= 0, `moved: ${start}`);
  const b = src.indexOf(end, a);
  assert.ok(b > a, `end moved: ${start}`);
  return src.slice(a, b);
};
const ORDER_ROUTE = routeBody(SERVER, "app.post('/api/clinical/patients/:clientId/encounters/:euuid/orders'");

// ---- the visits an order can go on -----------------------------------------
const rec = (euuid, date, dx, extra = {}) => ({ clientId: 'c1', encounterUuid: euuid, date, reason: `r-${euuid}`, diagnoses: dx.map(code => ({ code, description: code })), ...extra });
const att = (euuid, signedAt, codes) => ({ encounterUuid: euuid, signedAt, signedBy: { name: 'Dr' }, diagnosisCodes: codes });
const WORLD = {
  records: [
    rec('d-old', '2026-10-20', ['I10']),
    rec('d-new', '2026-11-05', ['I10']),
    rec('s-old', '2026-09-01', ['I10']),
    rec('s-new', '2026-11-01', ['I10', 'E11.9']),
    rec('gone', '2026-11-07', ['I10'], { noteStatus: 'voided' }),
    rec('other', '2026-11-08', ['I10'], { clientId: 'c2' })
  ],
  attestations: [att('s-old', '2026-09-01T10:00:00Z', ['I10']), att('s-new', '2026-11-01T10:00:00Z', ['I10'])],
  clientId: 'c1'
};

test('placement: drafts newest first, then ONLY the latest signed visit', () => {
  const p = orderReq.orderPlacementTargets({ ...WORLD, labelFor: (r) => `L-${r.encounterUuid}` });
  assert.deepStrictEqual(p.targets.map(t => t.encounterUuid), ['d-new', 'd-old', 's-new']);
  assert.equal(p.defaultEncounterUuid, 'd-new');
  assert.equal(p.emptyReason, null);
  assert.equal(p.targets[2].afterSigning, true);
  assert.equal(p.targets[0].afterSigning, false);
  assert.equal(p.targets[0].visitLabel, 'L-d-new');
});

test('placement: a deleted visit and another patient\'s visit are never offered', () => {
  const ids = orderReq.orderPlacementTargets(WORLD).targets.map(t => t.encounterUuid);
  assert.ok(!ids.includes('gone'));
  assert.ok(!ids.includes('other'));
  assert.ok(!ids.includes('s-old'), 'an older signed visit is never offered');
});

test('placement: a signed visit offers only the diagnoses it was signed with', () => {
  const t = orderReq.orderPlacementTargets(WORLD).targets.find(x => x.encounterUuid === 's-new');
  assert.deepStrictEqual(t.diagnoses.map(d => d.code), ['I10']);
  // A visit signed before attestations named their codes keeps the record's list.
  assert.deepStrictEqual(orderReq.signedDiagnoses({ diagnoses: [{ code: 'I10' }, { code: 'E11.9' }] }, { signedAt: 'x' }).map(d => d.code), ['I10', 'E11.9']);
});

test('placement: no visit at all says so; with only signed visits the latest is the default', () => {
  assert.deepStrictEqual(orderReq.orderPlacementTargets({ records: [], attestations: [], clientId: 'c1' }),
    { targets: [], defaultEncounterUuid: null, emptyReason: 'NO_VISITS' });
  const onlySigned = orderReq.orderPlacementTargets({ ...WORLD, records: WORLD.records.filter(r => r.encounterUuid.startsWith('s-')) });
  assert.equal(onlySigned.defaultEncounterUuid, 's-new');
});

test('after-signing gate: the latest signed visit passes, anything else is refused by name', () => {
  const { targets } = orderReq.orderPlacementTargets(WORLD);
  assert.equal(orderReq.afterSigningGate({ targets, encounterUuid: 's-new' }).ok, true);
  for (const e of ['s-old', 'd-new', 'gone']) {
    const g = orderReq.afterSigningGate({ targets, encounterUuid: e });
    assert.equal(g.ok, false);
    assert.equal(g.code, 'ORDER_AFTER_SIGNING_NOT_LATEST');
  }
});

// ---- the addendum -----------------------------------------------------------
test('the addendum says what was ordered and never the clinical text (it reaches the portal)', () => {
  const SECRET = 'PHI-SENTINEL-DO-NOT-PRINT';
  const cases = [
    { orderType: 'lab', priority: 'stat', tests: ['CBC', 'CMP'], diagnosisCodes: ['I10'], orderReference: 'GFC-ORD-AAAA', notes: SECRET, reason: SECRET, clinicalSummary: SECRET },
    { orderType: 'referral', diagnosisCodes: ['F32.9'], orderReference: 'GFC-ORD-BBBB', referral: { specialty: 'Cardiology', destination: 'external', receivingPractice: 'Heart Co', reason: SECRET, clinicalSummary: SECRET } },
    { orderType: 'referral', diagnosisCodes: ['F32.9'], referral: { specialty: 'Social work', destination: 'internal', reason: SECRET } },
    { orderType: 'dme', diagnosisCodes: ['M17.0'], dme: { itemDescription: 'Walker', quantity: 1, justification: SECRET } }
  ];
  const texts = cases.map(o => orderReq.buildOrderAddendumText(o));
  assert.match(texts[0], /Order added after signing: Lab \(stat\) — CBC, CMP\. Linked dx: I10\. Reference GFC-ORD-AAAA\./);
  assert.match(texts[1], /Referral added after signing: Cardiology\./);
  assert.match(texts[2], /Referral added after signing: Social work, to the care team\./);
  assert.match(texts[3], /Written order added after signing: Walker ×1\./);
  for (const t of texts) assert.ok(!t.includes(SECRET), t);
  assert.match(orderReq.buildOrderAddendumText(cases[0], { standingOrderRef: { title: 'Diabetes labs', version: 3 } }), /standing order "Diabetes labs" v3/);
});

test('buildAddendum records what wrote it, and an ordinary addendum is unchanged', () => {
  const plain = clinicalRepo.buildAddendum({ id: 'a1', encounterUuid: 'e1', clientId: 'c1', text: 'Called back', actor: { id: 'u', name: 'N' }, at: 'T' });
  assert.ok(!('source' in plain.addendum));
  const fromOrder = clinicalRepo.buildAddendum({ id: 'a2', encounterUuid: 'e1', clientId: 'c1', text: 'Order added after signing: X', actor: { id: 'u' }, source: { kind: 'order', orderId: 'o1' } });
  assert.deepStrictEqual(fromOrder.addendum.source, { kind: 'order', orderId: 'o1' });
});

// ---- one submit, one order --------------------------------------------------
test('the submit key is scoped to the person and the visit, and blank means none', () => {
  assert.equal(orderReq.orderIdempotencyKey('u1', 'e1', ''), null);
  assert.equal(orderReq.orderIdempotencyKey('u1', 'e1', '   '), null);
  assert.equal(orderReq.orderIdempotencyKey('', 'e1', 'k'), null);
  assert.notEqual(orderReq.orderIdempotencyKey('u1', 'e1', 'k'), orderReq.orderIdempotencyKey('u2', 'e1', 'k'));
  assert.notEqual(orderReq.orderIdempotencyKey('u1', 'e1', 'k'), orderReq.orderIdempotencyKey('u1', 'e2', 'k'));
  assert.ok(orderReq.orderIdempotencyKey('u1', 'e1', 'x'.repeat(500)).length <= 'u1:e1:'.length + 120);
});

test('the submit key never reaches a browser, and file storage ids still do not', () => {
  const out = orderReq.publicOrder({ id: 'o', idempotencyKey: 'u:e:k', orderFiles: [{ id: 'f', driveFileId: 'SECRET' }] });
  assert.ok(!('idempotencyKey' in out));
  assert.ok(!JSON.stringify(out).includes('SECRET'));
  assert.equal(orderReq.publicOrder(null), null);
});

// ---- failures that say what they are ---------------------------------------
test('an OpenEMR failure keeps its own code; anything else is left to the caller', () => {
  const lapsed = Object.assign(new Error('Sign in to OpenEMR'), { code: 'EMR_NOT_CONNECTED', status: 409 });
  assert.deepStrictEqual(clinicalRepo.emrFailureResponse(lapsed), { status: 409, body: { error: 'Sign in to OpenEMR', code: 'EMR_NOT_CONNECTED' } });
  const off = Object.assign(new Error('not configured'), { code: 'EMR_NOT_CONFIGURED', status: 503 });
  assert.equal(clinicalRepo.emrFailureResponse(off).status, 503);
  const bare = Object.assign(new Error('boom'), { name: 'OpenEmrError' });
  assert.equal(clinicalRepo.emrFailureResponse(bare).body.code, 'EMR_REQUEST_FAILED');
  assert.equal(clinicalRepo.emrFailureResponse(new Error('a bug')), null);
});

// ---- the route, build-enforced ---------------------------------------------
test('route: a signed visit takes an order only when the page asks, and only the latest', () => {
  assert.match(ORDER_ROUTE, /const afterSigning = ctx\.closed && placing\.afterSigning === true;/);
  assert.match(ORDER_ROUTE, /if \(!afterSigning && refuseIfClosed\(ctx, res\)\) return;/);
  assert.match(ORDER_ROUTE, /if \(afterSigning\) \{\s*const gate = orderReq\.afterSigningGate\(/);
  assert.match(ORDER_ROUTE, /encounterDiagnoses: afterSigning \? orderReq\.signedDiagnoses\(ctx\.record, ctx\.attestation\) : ctx\.record\.diagnoses/);
  assert.match(ORDER_ROUTE, /NOTE_VOIDED/);
});

test('route: an order after signing writes its addendum through the ONE addendum writer', () => {
  assert.match(ORDER_ROUTE, /if \(orderAddendum\) \{\s*await recordEncounterAddendum\(ctx, orderAddendum/);
  assert.match(ORDER_ROUTE, /built\.order\.afterSigning = \{ addendumId: orderAddendum\.id/);
  const addendaRoute = routeBody(SERVER, "app.post('/api/clinical/patients/:clientId/encounters/:euuid/addenda'");
  assert.match(addendaRoute, /await recordEncounterAddendum\(ctx, built\.addendum/);
  // Two writers exist on purpose: the shared one, and the billable CLINICIAN
  // addendum (co-sign), which carries its own billing and rendering-provider
  // steps. A third is how an addendum stops reaching the PDF or the portal.
  const writes = SERVER.match(/db\.set\('encounter_addenda'/g) || [];
  assert.equal(writes.length, 2, 'only the shared writer and the clinician addendum store an addendum');
  const coSign = routeBody(SERVER, "app.post('/api/clinical/patients/:clientId/encounters/:euuid/co-sign'");
  assert.ok(coSign.includes("db.set('encounter_addenda'"), 'the second writer is the clinician addendum');
  const helper = SERVER.slice(SERVER.indexOf('const recordEncounterAddendum = async'));
  assert.ok(helper.slice(0, helper.indexOf('\n};\n')).includes("db.set('encounter_addenda'"));
});

test('route: a replayed key returns the first order, a second in flight is refused, and the key is always released', () => {
  assert.match(ORDER_ROUTE, /orderReq\.orderIdempotencyKey\(req\.user\.id, ctx\.encounterUuid, placing\.idempotencyKey\)/);
  assert.match(ORDER_ROUTE, /o\.idempotencyKey === submitKey && o\.clientId === ctx\.client\.id/);
  assert.match(ORDER_ROUTE, /duplicate: true/);
  assert.match(ORDER_ROUTE, /ORDER_IN_FLIGHT/);
  assert.match(ORDER_ROUTE, /finally \{\s*if \(inFlightKey\) orderSubmitsInFlight\.delete\(inFlightKey\);\s*\}/);
  assert.match(ORDER_ROUTE, /if \(submitKey\) built\.order\.idempotencyKey = submitKey;/);
});

test('route: a failure answers with a code, never the old bare 502', () => {
  assert.match(ORDER_ROUTE, /clinicalRepo\.emrFailureResponse\(error\) \|\|/);
  assert.match(ORDER_ROUTE, /ORDER_SAVE_FAILED/);
  assert.ok(!/res\.status\(502\)\.json\(\{ error: `Order save failed/.test(ORDER_ROUTE));
  const ctxFn = SERVER.slice(SERVER.indexOf('const loadEncounterContext = async'), SERVER.indexOf('const postEncounterCharges'));
  assert.match(ctxFn, /clinicalRepo\.emrFailureResponse\(e\)/);
  assert.match(ctxFn, /'CLIENT_NOT_FOUND'/);
});

test('the orders list serves where an order can go and whether this viewer may place one', () => {
  const list = routeBody(SERVER, "app.get('/api/clinical/patients/:clientId/orders'");
  assert.match(list, /placement: await/);
  assert.match(list, /canPlace: canPlaceOrders\(req\.user\)/);
  assert.match(list, /await orderPlacementFor\(client\)/);
});

// ---- the page ---------------------------------------------------------------
test('page: the Orders, Referrals and Imaging places each offer New Order', () => {
  assert.match(PAGE, /const NewOrderPanel = \(\{ patient, placement, presetType, onPlaced \}\) => \{/);
  const browser = fnBody(PAGE, 'const OrderBrowser = (');
  assert.match(browser, /<NewOrderPanel patient=\{patient\} placement=\{data && data\.placement\} presetType=\{presetType\}/);
  assert.match(PAGE, /keep=\{o => o\.orderType === 'referral'\} presetType="referral"/);
  assert.match(PAGE, /<NewOrderPanel patient=\{patient\} placement=\{data && data\.placement\} presetType="imaging"/);
  assert.ok(!/Orders are placed from inside an encounter/.test(PAGE), 'the old dead-end text is gone');
});

test('page: the panel shows only what the server allows, names the visit, and asks for after-signing only on a signed visit', () => {
  const panel = fnBody(PAGE, 'const NewOrderPanel = (');
  assert.match(panel, /if \(!placement \|\| !placement\.canPlace\) return null;/);
  assert.match(panel, /<Field label="Add To Visit">/);
  assert.match(panel, /'New Referral' : 'New Order'/);
  assert.match(panel, /\.\.\.\(chosen\.afterSigning \? \{ afterSigning: true \} : \{\}\)/);
  assert.match(panel, /diagnoses=\{chosen\.diagnoses \|\| \[\]\} diagnosesLocked=\{!!chosen\.afterSigning\}/);
});

test('page: one key per form, sent with every save from it', () => {
  const form = fnBody(PAGE, 'const OrderForm = (');
  assert.match(form, /const submitKeyRef = useRef\(newSubmitKey\(\)\);/);
  assert.match(form, /idempotencyKey: submitKeyRef\.current/);
  assert.ok(!/idempotencyKey: newSubmitKey\(\)/.test(form), 'a key made per click defeats the check');
});

test('page: the visit\'s order form links only SAVED diagnoses and says when coding is unsaved', () => {
  assert.match(PAGE, /<OrderForm clientId=\{patient\.id\} diagnoses=\{d\.record\.diagnoses \|\| \[\]\}/);
  assert.match(PAGE, /Save the coding first\. Diagnoses added since the last save/);
});
