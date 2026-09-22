// test/clinical_inbox.test.js — the clinical inbox (2026-09-22).
//
// Session 4.8 left four pending states and Session 6 a fifth, and NOTHING on
// screen ever showed one of them. These tests pin the two rules the surface
// rests on:
//
//   1. Every row says WHO it is waiting on, and "you" only when the viewer can
//      actually act. An inbox that offers a button the route then refuses is
//      worse than no inbox.
//   2. No credential rule is restated here. Whether a viewer may co-sign is
//      asked of clinicalRoles, so a role narrowed there narrows the inbox too.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const inbox = require('../clinicalInbox.js');
const ROOT = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const page = fs.readFileSync(path.join(ROOT, 'public', 'clinical.html'), 'utf8');

const NOW = '2026-09-22T12:00:00.000Z';
const provider = { id: 'p1', role: 'user', clinicalRole: 'provider' };
const rn = { id: 'rn1', role: 'user', clinicalRole: 'rn' };
const lcsw = { id: 'l1', role: 'user', clinicalRole: 'lcsw' };
const readOnly = { id: 'cm1', role: 'caseManager', clinicalRole: 'readOnly' };

const world = (over = {}) => ({
  encounterRecords: [{
    encounterUuid: 'e1', clientId: 'c1', coSignStatus: 'pending',
    updatedAt: '2026-09-20T10:00:00Z', diagnoses: [{ code: 'E11.9' }], services: [{ code: '99348' }]
  }],
  attestations: [{ encounterUuid: 'e1', signedAt: '2026-09-20T10:00:00Z', signedBy: { id: 'lmsw1', name: 'Mara Shaw' } }],
  orders: [{
    id: 'o1', clientId: 'c1', executedBy: { id: 'rn1', name: 'Ruth Nolan' },
    createdAt: '2026-09-15T09:00:00Z',
    coSign: { coSignStatus: 'pending', coSignDueAt: '2026-09-18T09:00:00Z' }
  }],
  carePlanClients: [{
    id: 'c3', name: 'Ada Boyd',
    carePlan: { version: 2, providerCoSignStatus: 'pending', authoredById: 'rn1', authoredAt: '2026-09-19T08:00:00Z' }
  }],
  visitLogs: [{ id: 'v1', clientId: 'c1', status: 'pending_review', submittedAt: '2026-09-21T15:00:00Z', caregiverName: 'Joy A.' }],
  patientNames: new Map([['c1', 'Test PatientOne'], ['c3', 'Ada Boyd']]),
  now: NOW, ...over
});
const kinds = (r) => r.items.map(i => i.kind);
const byKind = (r, k) => r.items.find(i => i.kind === k);

// ── the five states are surfaced at all ──────────────────────────────────

test('every pending state 4.8 and 6 created is surfaced', () => {
  const r = inbox.buildInbox({ viewer: provider, ...world() });
  for (const k of ['encounter_co_sign', 'order_co_sign', 'care_plan_co_sign', 'visit_log_review']) {
    assert.ok(kinds(r).includes(k), `${k} is not surfaced — it stays an inert field`);
  }
});

test('an encounter filed but never signed is surfaced to the clinician who documented it', () => {
  const r = inbox.buildInbox({
    viewer: provider,
    ...world({
      encounterRecords: [{ encounterUuid: 'e9', clientId: 'c1', updatedAt: '2026-09-22T09:00:00Z', diagnoses: [], services: [], renderingProvider: { id: 'p1' } }],
      attestations: [], orders: [], carePlanClients: [], visitLogs: []
    })
  });
  const it = byKind(r, 'encounter_unsigned');
  assert.ok(it, 'a filed-but-unsigned encounter must appear');
  assert.strictEqual(it.actionable, true, 'it is the documenting clinician\'s to sign');
  assert.strictEqual(it.waitingOn, 'you');
});

test('a signed encounter is NOT in the inbox', () => {
  const r = inbox.buildInbox({
    viewer: provider,
    ...world({
      encounterRecords: [{ encounterUuid: 'e1', clientId: 'c1', updatedAt: '2026-09-20T10:00:00Z', diagnoses: [], services: [] }],
      attestations: [{ encounterUuid: 'e1', signedAt: '2026-09-20T11:00:00Z', signedBy: { id: 'p1' } }],
      orders: [], carePlanClients: [], visitLogs: []
    })
  });
  assert.strictEqual(r.items.length, 0, 'a signed encounter is finished work, not an inbox item');
});

test('an empty world produces an empty inbox, not an error', () => {
  const r = inbox.buildInbox({ viewer: provider, now: NOW });
  assert.deepStrictEqual(r.items, []);
  assert.strictEqual(r.counts.total, 0);
  assert.strictEqual(r.counts.actionable, 0);
});

// ── who it is waiting on ─────────────────────────────────────────────────

test('a row waiting on someone else never reads as waiting on you', () => {
  // An RN cannot co-sign an encounter. The rule lives in clinicalRoles; the
  // inbox must reflect it rather than carry a second copy.
  const r = inbox.buildInbox({ viewer: rn, ...world() });
  const enc = byKind(r, 'encounter_co_sign');
  assert.strictEqual(enc.actionable, false, 'an RN cannot co-sign an encounter');
  assert.notStrictEqual(enc.waitingOn, 'you');
  assert.match(enc.waitingOn, /LCSW|provider/i, 'it must name who it IS waiting on');
});

test('an LCSW can co-sign an LMSW encounter, so it reads as waiting on them', () => {
  const r = inbox.buildInbox({ viewer: lcsw, ...world() });
  const enc = byKind(r, 'encounter_co_sign');
  assert.strictEqual(enc.actionable, true);
  assert.strictEqual(enc.waitingOn, 'you');
});

// The route refuses a self-issued co-signature (CO_SIGN_SELF). If the inbox
// offered it anyway, it would be handing out a button the server rejects.
test('the clinician who signed never sees their own hold as actionable', () => {
  const selfSigner = { id: 'lmsw1', role: 'user', clinicalRole: 'lcsw' }; // could co-sign, but signed it
  const r = inbox.buildInbox({ viewer: selfSigner, ...world() });
  const enc = byKind(r, 'encounter_co_sign');
  assert.strictEqual(enc.actionable, false, 'a co-signature cannot be self-issued');
});

test('the clinician who executed an order cannot co-sign their own execution', () => {
  const rnWhoCanCoSign = { id: 'rn1', role: 'user', clinicalRole: 'provider' }; // same id as executedBy
  const r = inbox.buildInbox({ viewer: rnWhoCanCoSign, ...world() });
  const ord = byKind(r, 'order_co_sign');
  assert.strictEqual(ord.actionable, false);
});

test('the RN who authored a care plan does not co-sign it herself', () => {
  const authorAsProvider = { id: 'rn1', role: 'user', clinicalRole: 'provider' };
  const r = inbox.buildInbox({ viewer: authorAsProvider, ...world() });
  const cp = byKind(r, 'care_plan_co_sign');
  assert.strictEqual(cp.actionable, false);
});

test('a readOnly case manager sees the queue but can act on nothing', () => {
  const r = inbox.buildInbox({ viewer: readOnly, ...world() });
  assert.ok(r.items.length > 0, 'a case manager still sees what their clients are waiting on');
  assert.strictEqual(r.counts.actionable, 0, 'readOnly is chart access without a licence');
  assert.ok(r.items.every(i => i.waitingOn !== 'you'));
});

// ── ordering and the one real deadline ───────────────────────────────────

test('an overdue co-sign sorts above everything else', () => {
  const r = inbox.buildInbox({ viewer: provider, ...world() });
  assert.strictEqual(r.items[0].kind, 'order_co_sign');
  assert.strictEqual(r.items[0].overdue, true);
  assert.strictEqual(r.counts.overdue, 1);
});

test('a co-sign still inside its window is not overdue', () => {
  const r = inbox.buildInbox({
    viewer: provider,
    ...world({ orders: [{ id: 'o2', clientId: 'c1', createdAt: '2026-09-21T09:00:00Z', coSign: { coSignStatus: 'pending', coSignDueAt: '2026-09-30T09:00:00Z' } }] })
  });
  assert.strictEqual(byKind(r, 'order_co_sign').overdue, false);
  assert.strictEqual(r.counts.overdue, 0);
});

test('an order with no due date is never reported overdue', () => {
  assert.strictEqual(inbox.isOverdue(null, NOW), false);
  assert.strictEqual(inbox.isOverdue('not a date', NOW), false);
});

test('within one overdue state the oldest is first — it has waited longest', () => {
  const r = inbox.buildInbox({
    viewer: provider,
    ...world({
      encounterRecords: [
        { encounterUuid: 'new', clientId: 'c1', coSignStatus: 'pending', updatedAt: '2026-09-21T10:00:00Z', diagnoses: [], services: [] },
        { encounterUuid: 'old', clientId: 'c1', coSignStatus: 'pending', updatedAt: '2026-09-01T10:00:00Z', diagnoses: [], services: [] }
      ],
      attestations: [], orders: [], carePlanClients: [], visitLogs: []
    })
  });
  assert.strictEqual(r.items[0].id, 'old');
});

// ── build enforcement ────────────────────────────────────────────────────

test('the inbox never restates a credential rule — it asks clinicalRoles', () => {
  const src = fs.readFileSync(path.join(ROOT, 'clinicalInbox.js'), 'utf8');
  assert.ok(src.includes("require('./clinicalRoles')"), 'it must ask the one module that answers this');
  for (const role of ['lcsw', 'lmsw', 'provider', 'readOnly']) {
    assert.ok(!new RegExp(`===\\s*['"]${role}['"]`).test(src),
      `clinicalInbox.js compares against the ${role} role directly — that is a second copy of the matrix`);
  }
});

test('the inbox route is a READ, so a case manager can reach it', () => {
  const line = (server.match(/app\.get\('\/api\/clinical\/inbox'[^\n]*/) || [])[0];
  assert.ok(line, 'the inbox route is missing');
  assert.ok(line.includes('requireClinicalRead'),
    'the inbox is a read; what a viewer may ACT on is decided per item');
});

test('the inbox is actually reachable from the workspace', () => {
  assert.ok(page.includes("inbox: () => authedFetch('/api/clinical/inbox')"), 'the api helper is missing');
  assert.ok(page.includes('<InboxView'), 'a route with no screen is a capability that does not exist');
  assert.ok(/view === 'inbox'/.test(page), 'there must be a way to switch to it');
});

test('the inbox screen renders the server\'s own verdict, never its own', () => {
  const view = page.slice(page.indexOf('const InboxView = ('));
  const body = view.slice(0, view.indexOf('const SummaryTab = ('));
  assert.ok(body.includes('i.actionable'), 'the row must use the server\'s actionable flag');
  assert.ok(body.includes('i.waitingOn'), 'and name who it is waiting on');
  assert.ok(!/clinicalRole|capabilit/i.test(body),
    'the screen must not decide a credential question itself');
});

test('an inbox with nothing for you says so rather than showing an empty list', () => {
  const view = page.slice(page.indexOf('const InboxView = ('));
  const body = view.slice(0, view.indexOf('const SummaryTab = ('));
  assert.ok(/Nothing is waiting on you/.test(body),
    'an empty state must be a sentence, not a blank panel');
});
