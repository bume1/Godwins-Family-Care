'use strict';
// An orders-only visit, and a diagnosis picked inside the order form
// (owner, 2026-11-22: "like a standard practice").
//
// When no visit fits, the chart opens a short ORDERS-ONLY visit for today: the
// app's record with `ordersOnly: true` and no note, over a plain OpenEMR
// encounter. One per patient per Georgia day, never asked to be signed while it
// has no note. On a draft visit, a diagnosis picked in the order form is ADDED
// to the visit with the order, never a replacement; a signed visit takes none.
//
// The HTTP half is scripts/verify_new_order.js sections 6 and 7.
//
// Mutations each confirmed to fail a test here or the probe:
//   M1 the inbox lists an orders-only visit as unsigned
//   M2 the merge replaces the list instead of appending
//   M3 an added diagnosis takes the primary
//   M4 a signed visit accepts a new diagnosis
//   M5 the open coding queue lists an orders-only visit
//   M6 a second request the same day opens a second visit
//   M7 the route opens a visit for someone who may not place orders
//   M8 the order form sends every picked code, even one deselected
//   M9 the merged list replaced by only the picked codes
//   M10 the exemption kept after a note is written on the visit
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const clinicalRepo = require('../clinicalRepository');
const orderReq = require('../orderRequisitions');
const inbox = require('../clinicalInbox');

const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const SERVER = strip(fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8'));
const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'clinical.html'), 'utf8');
const routeBody = (start) => {
  const a = SERVER.indexOf(start);
  assert.ok(a >= 0, `route moved: ${start}`);
  return SERVER.slice(a, SERVER.indexOf('\n});\n', a) + 5);
};
const fnBody = (src, start, end) => {
  const a = src.indexOf(start);
  assert.ok(a >= 0, `moved: ${start}`);
  const b = src.indexOf(end, a);
  assert.ok(b > a, `end moved: ${start}`);
  return src.slice(a, b);
};

// ---- the merge --------------------------------------------------------------
test('a picked diagnosis is appended, deduped, and never takes the primary', () => {
  const existing = [{ code: 'I10', description: 'HTN', source: 'manual', primary: true }];
  const m = clinicalRepo.mergeOrderDiagnoses(existing, [{ code: 'E11.9', description: 'T2DM', primary: true }, { code: 'I10' }]);
  assert.deepStrictEqual(m.diagnoses.map(d => d.code), ['I10', 'E11.9']);
  assert.equal(m.diagnoses[0].primary, true);
  assert.equal(m.diagnoses[1].primary, false);
  assert.deepStrictEqual(m.added, ['E11.9']);
  assert.equal(m.diagnoses[0].description, 'HTN', 'the existing entry is kept as it was');
});

test('on an older visit whose codes carry no primary flag, the visit\'s own first code becomes primary, not the picked one', () => {
  const m = clinicalRepo.mergeOrderDiagnoses([{ code: 'I10' }], [{ code: 'E11.9', primary: true }]);
  assert.equal(m.diagnoses[0].code, 'I10');
  assert.equal(m.diagnoses[0].primary, true);
  assert.equal(m.diagnoses[1].primary, false);
});

test('on an empty visit the first picked diagnosis becomes the primary', () => {
  const m = clinicalRepo.mergeOrderDiagnoses([], [{ code: 'R05.9', description: 'Cough' }]);
  assert.equal(m.diagnoses[0].code, 'R05.9');
  assert.equal(m.diagnoses[0].primary, true);
});

test('a malformed code or a 21st diagnosis is refused by name', () => {
  assert.equal(clinicalRepo.mergeOrderDiagnoses([], [{ code: 'NOTACODE' }]).code, 'DX_BAD_CODE');
  const twenty = Array.from({ length: 20 }, (_, i) => ({ code: `Z${String(i).padStart(2, '0')}.0` }));
  assert.equal(clinicalRepo.mergeOrderDiagnoses(twenty, [{ code: 'R05.9' }]).code, 'DX_TOO_MANY');
});

// ---- it never asks to be signed --------------------------------------------
const provider = { id: 'p1', role: 'user', clinicalRole: 'provider', hasClinicalAccess: true };
const unsignedKinds = (records) => inbox.buildInbox({
  viewer: provider, encounterRecords: records, attestations: [], orders: [], carePlanClients: [], visitLogs: []
}).items.filter(i => i.kind === 'encounter_unsigned').map(i => i.encounterUuid);

test('an orders-only visit with no note is not an unsigned note; once it has a note it is', () => {
  const base = { clientId: 'c1', updatedAt: '2026-11-22T10:00:00Z', diagnoses: [], services: [], renderingProvider: { id: 'p1' } };
  assert.deepStrictEqual(unsignedKinds([{ ...base, encounterUuid: 'oo', ordersOnly: true }]), []);
  assert.deepStrictEqual(unsignedKinds([{ ...base, encounterUuid: 'oo', ordersOnly: true, note: { assessment: 'x' } }]), ['oo']);
  assert.deepStrictEqual(unsignedKinds([{ ...base, encounterUuid: 'v' }]), ['v'], 'an ordinary unsigned visit still shows');
});

test('the visit picker marks an orders-only visit', () => {
  const p = orderReq.orderPlacementTargets({
    records: [{ clientId: 'c1', encounterUuid: 'oo', date: '2026-11-22', ordersOnly: true, diagnoses: [] }],
    attestations: [], clientId: 'c1', labelFor: (r) => (r.ordersOnly ? 'Orders only' : null)
  });
  assert.equal(p.targets[0].ordersOnly, true);
  assert.equal(p.targets[0].visitLabel, 'Orders only');
});

// ---- the route, build-enforced ---------------------------------------------
const OO_ROUTE = routeBody("app.post('/api/clinical/patients/:clientId/encounters/orders-only'");
test('route: only someone who may place orders opens one, and one per patient per day', () => {
  assert.match(OO_ROUTE, /requireClinicalWrite/);
  assert.match(OO_ROUTE, /if \(!canPlaceOrders\(req\.user\)\)/);
  assert.match(OO_ROUTE, /const existing = todaysOrdersOnlyVisit\(rows0, attestations, client\.id, today\);\s*if \(existing\) \{/);
  assert.match(OO_ROUTE, /record\.ordersOnly = true;/);
  assert.match(OO_ROUTE, /await createAppEncounter\(/);
  assert.match(OO_ROUTE, /clinicalRepo\.emrFailureResponse\(error\)/);
  // Only an orders-only visit with NO NOTE is exempt; once somebody writes a
  // note on it, it is a visit to sign and code like any other.
  assert.match(SERVER, /const isOpenOrdersOnly = \(r\) => !!r && r\.ordersOnly === true && !r\.note &&/);
  const helper = fnBody(SERVER, 'const todaysOrdersOnlyVisit', '|| null;');
  assert.match(helper, /isOpenOrdersOnly\(r\)/);
  assert.match(helper, /String\(r\.date \|\| ''\)\.slice\(0, 10\) === today/);
});

test('one helper opens every app encounter: the note route and the orders-only route', () => {
  const notes = routeBody("app.post('/api/clinical/patients/:clientId/notes'");
  assert.match(notes, /await createAppEncounter\(\{/);
  assert.ok(!/emr\.createEncounter\(/.test(notes), 'the note route no longer opens its own encounter');
  assert.ok(!/emr\.createEncounter\(/.test(OO_ROUTE));
});

test('route: a picked diagnosis is merged, never replaced, and a signed visit takes none', () => {
  const order = routeBody("app.post('/api/clinical/patients/:clientId/encounters/:euuid/orders'");
  assert.match(order, /if \(addDiagnoses\.length\) \{\s*if \(afterSigning\) \{/);
  assert.match(order, /clinicalRepo\.mergeOrderDiagnoses\(ctx\.record\.diagnoses, addDiagnoses\)/);
  assert.ok(!/applyCoding\(/.test(order), 'the coding PUT\'s replace is not reused');
  assert.match(order, /diagnosesAddedToVisit: addedDiagnosisCodes/);
});

test('the open coding queue leaves orders-only visits out; All still lists them', () => {
  const q = routeBody("app.get('/api/clinical/encounters/queue'");
  assert.match(q, /const ordersOnly = new Set\(records\.filter\(isOpenOrdersOnly\)/);
  assert.match(q, /filter === 'open' \? \(\(r\.state !== 'signed' && !ordersOnly\.has\(String\(r\.encounterUuid\)\)\) \|\| awaiting\(r\)\)/);
  assert.match(q, /filter === 'all' \? true/);
});

test('the orders list tells the page whether it may open one, and which one is today\'s', () => {
  const list = routeBody("app.get('/api/clinical/patients/:clientId/orders'");
  assert.match(list, /canCreateOrdersOnly: canPlaceOrders\(req\.user\) && !!client\.openEmrPatientId/);
  assert.match(list, /todaysOrdersOnly:/);
  assert.match(list, /canAddDiagnoses:/);
});

// ---- the page ---------------------------------------------------------------
test('page: Add To Visit offers a new orders-only visit while none is open today', () => {
  const panel = fnBody(PAGE, 'const NewOrderPanel = (', '\n    };\n');
  assert.match(panel, /const canOpenOrdersOnly = !!placement\.canCreateOrdersOnly && !placement\.todaysOrdersOnly;/);
  assert.match(panel, /<option value=\{NEW_ORDERS_ONLY\}>\+ New Orders-Only Visit \(Today\)<\/option>/);
  assert.match(panel, /api\.createOrdersOnlyVisit\(patient\.id\)/);
  assert.match(panel, /Open Orders-Only Visit/);
  assert.match(panel, /canAddDx=\{!!placement\.canAddDiagnoses && !chosen\.afterSigning\}/);
});

test('page: the order form picks a diagnosis and sends only the picked ones still selected', () => {
  const form = fnBody(PAGE, 'const OrderForm = (', '\n    };\n');
  assert.match(form, /<CodePicker set="ICD10"/);
  assert.match(form, /\+ Add Diagnosis/);
  assert.match(form, /const adding = newDx\.filter\(n => isNewDx\(n\.code\) && f\.diagnosisCodes\.includes\(n\.code\)\);/);
  assert.match(form, /\.\.\.\(adding\.length \? \{ addDiagnoses: adding \} : \{\}\)/);
  assert.match(form, /canAddDx && !diagnosesLocked/);
});

test('page: inside a visit, a diagnosis is picked in the order form only while the coding is saved', () => {
  assert.match(PAGE, /<OrderForm clientId=\{patient\.id\} diagnoses=\{d\.record\.diagnoses \|\| \[\]\}[^>]*\n\s*canAddDx=\{!dirty\}/);
});
