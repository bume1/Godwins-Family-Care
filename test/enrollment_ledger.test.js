// test/enrollment_ledger.test.js — the enrollment requirements ledger.
//
// This is the spine the document-extraction work sits on, so the properties
// pinned here are safety properties, not conveniences:
//
//   • An extracted value NEVER counts as satisfied. It waits for a person.
//   • An extraction never overwrites a verified or patient-entered value.
//   • A signature against superseded wording does NOT satisfy the requirement.
//   • An offline signature DOES satisfy it — not making someone redo work they
//     already did is the entire point of reconciling.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const L = require('../enrollmentLedger.js');
const fs = require('fs');
const path = require('path');

const CONSENTS = [{ type: 'npp', title: 'Notice of Privacy Practices', required: true, bodyVersion: 'v2' }];
const DOCS = [{ kind: 'photoId', label: 'Photo ID', required: true }];
const FIELDS = [{ key: 'pharmacy', label: 'Pharmacy', present: (c) => !!(c.intake || {}).pharmacy }];

const build = (over = {}) => L.buildLedger({
  consents: CONSENTS, documents: DOCS, dataFields: FIELDS,
  client: { id: 'c1', intake: {}, consents: {}, ...(over.client || {}) },
  uploads: over.uploads || [], requests: over.requests || [],
  now: '2026-09-22T12:00:00.000Z'
});
const row = (led, key) => led.byKey[key];

// ── the safety property the whole feature rests on ────────────────────────

test('an extracted value is NEVER satisfied, however confident the model was', () => {
  const led = build({ client: { ledgerProposals: { pharmacy: { docId: 'd9', value: 'CVS Main St', confidence: 0.99 } } } });
  const r = row(led, 'pharmacy');
  assert.strictEqual(r.status, L.STATUS.MISSING, 'a proposal is not a value');
  assert.strictEqual(L.isSatisfied(r), false);
  assert.strictEqual(r.confidence, 0.99, 'the confidence is kept, so a reviewer can triage');
  assert.match(String(r.evidence), /^uploaded_doc:d9$/, 'and the document that proposed it is named');
  assert.ok(/needs checking/i.test(r.reason || ''), 'the row must say why it does not count yet');
});

test('a proposal keeps the ledger unsatisfied rather than quietly completing it', () => {
  const led = build({
    client: {
      intake: {}, consents: { npp: { status: 'signed', bodyVersion: 'v2' } },
      ledgerProposals: { pharmacy: { docId: 'd9', value: 'CVS', confidence: 1 } }
    },
    uploads: [{ id: 'u1', clientId: 'c1', kind: 'photoId', status: 'accepted', source: 'staff' }]
  });
  assert.strictEqual(led.satisfied, false, 'a model must not be able to complete an enrollment');
  assert.strictEqual(led.counts.awaitingReview, 1, 'and the waiting-on-a-human count must show it');
});

// ── provenance precedence (spec §4.4) ─────────────────────────────────────

test('an extraction never overwrites a verified or patient-entered value', () => {
  const extracted = { source: 'uploaded_doc:d1', value: 'WRONG' };
  for (const held of ['staff_verified', 'patient_portal']) {
    const r = L.reconcileValue({ existing: { source: held, value: 'RIGHT' }, incoming: extracted });
    assert.strictEqual(r.winner.value, 'RIGHT', `${held} must beat an extraction`);
    assert.strictEqual(r.changed, false);
  }
});

test('staff verification outranks a patient-entered value', () => {
  const r = L.reconcileValue({
    existing: { source: 'patient_portal', value: 'old' },
    incoming: { source: 'staff_verified', value: 'corrected' }
  });
  assert.strictEqual(r.winner.value, 'corrected');
  assert.strictEqual(r.changed, true);
});

test('an extraction fills a genuinely empty slot, and says so', () => {
  const r = L.reconcileValue({ existing: null, incoming: { source: 'uploaded_doc:d1', value: 'new' } });
  assert.strictEqual(r.winner.value, 'new');
  assert.strictEqual(r.changed, true);
});

test('a tie goes to what is already on file, never to the newcomer', () => {
  const r = L.reconcileValue({
    existing: { source: 'patient_portal', value: 'first' },
    incoming: { source: 'patient_portal', value: 'second' }
  });
  assert.strictEqual(r.winner.value, 'first');
  assert.strictEqual(r.changed, false);
});

// ── version override (spec §4.2) ──────────────────────────────────────────

test('a signature against superseded wording does not satisfy the requirement', () => {
  const led = build({ client: { consents: { npp: { status: 'signed', bodyVersion: 'draft-1' } } } });
  const r = row(led, 'npp');
  assert.strictEqual(r.status, L.STATUS.MISSING);
  assert.strictEqual(r.supersededVersion, 'draft-1');
  // "You never signed this" and "you signed an older version" are different
  // sentences, and only one of them is true.
  assert.match(r.reason, /draft-1/);
  assert.match(r.reason, /v2/);
});

test('a signature at the current version does satisfy it', () => {
  const led = build({ client: { consents: { npp: { status: 'signed', bodyVersion: 'v2' } } } });
  assert.strictEqual(L.isSatisfied(row(led, 'npp')), true);
});

test('an on-file signature with no recorded version is not assumed current', () => {
  const led = build({ client: { consents: { npp: { status: 'signed_offline' } } } });
  const r = row(led, 'npp');
  assert.strictEqual(r.status, L.STATUS.MISSING, 'unknown version cannot be matched to the required one');
  assert.ok(/does not record which version/i.test(r.reason));
});

// ── offline satisfies — the whole point of reconciling ────────────────────

test('a consent signed on paper satisfies the requirement without a re-sign', () => {
  const led = build({
    client: { consents: { npp: { status: 'signed_offline', bodyVersion: 'v2', scanUploadId: 'doc_7', recordedByName: 'B. Ume' } } }
  });
  const r = row(led, 'npp');
  assert.strictEqual(r.status, L.STATUS.ON_FILE_OFFLINE);
  assert.strictEqual(L.isSatisfied(r), true);
  assert.strictEqual(r.evidence, 'doc_7', 'a claim of on-file must name the evidence behind it');
  assert.strictEqual(r.verifiedBy, 'B. Ume');
});

test('a requested document is outstanding — asking is not receiving', () => {
  const led = build({ requests: [{ id: 'r1', clientId: 'c1', kind: 'photoId', status: 'open' }] });
  const r = row(led, 'photoId');
  assert.strictEqual(r.status, L.STATUS.REQUESTED);
  assert.strictEqual(L.isOutstanding(r), true);
});

test('an accepted document is its own evidence', () => {
  const led = build({ uploads: [{ id: 'u5', clientId: 'c1', kind: 'photoId', status: 'accepted', source: 'staff', reviewedByName: 'B. Ume' }] });
  const r = row(led, 'photoId');
  assert.strictEqual(L.isSatisfied(r), true);
  assert.strictEqual(r.evidence, 'uploaded_doc:u5');
});

test('a rejected document does not satisfy, and does not read as received', () => {
  const led = build({ uploads: [{ id: 'u6', clientId: 'c1', kind: 'photoId', status: 'rejected', source: 'client' }] });
  assert.strictEqual(L.isSatisfied(row(led, 'photoId')), false);
});

// ── the gate generalises (spec §3.1) ──────────────────────────────────────

test('the gate is "every required row satisfied", by any provenance', () => {
  const led = build({
    client: {
      intake: { pharmacy: 'CVS' },
      consents: { npp: { status: 'signed_offline', bodyVersion: 'v2', scanUploadId: 'd1' } }
    },
    uploads: [{ id: 'u1', clientId: 'c1', kind: 'photoId', status: 'accepted', source: 'client' }]
  });
  assert.strictEqual(led.satisfied, true, 'offline + in-app + captured together satisfy it');
  assert.strictEqual(led.counts.outstanding, 0);
});

test('a row that does not apply is satisfied without being done', () => {
  const r = { kind: L.KIND.DOCUMENT, status: L.STATUS.NA, required: true };
  assert.strictEqual(L.isSatisfied(r), true);
  assert.strictEqual(L.isOutstanding(r), false);
});

test('one client\'s uploads never satisfy another client\'s row', () => {
  const led = build({ uploads: [{ id: 'u1', clientId: 'SOMEONE_ELSE', kind: 'photoId', status: 'accepted' }] });
  assert.strictEqual(L.isSatisfied(row(led, 'photoId')), false);
});

test('a data field only counts when CAPTURED — no other status will do', () => {
  // Caught by mutation: the tests only ever produced `captured` or `missing`
  // data rows, so `status === CAPTURED` and `status !== MISSING` agreed on
  // every case and the difference was invisible. It is not a hypothetical —
  // a data row is `requested` whenever we have asked the patient for it, and
  // under the loose form the gate would open while we were still waiting.
  for (const status of [L.STATUS.REQUESTED, L.STATUS.ON_FILE_OFFLINE, L.STATUS.IN_APP]) {
    assert.strictEqual(
      L.isSatisfied({ kind: L.KIND.DATA, status, required: true }), false,
      `a data field at "${status}" is not a captured value`
    );
  }
  assert.strictEqual(L.isSatisfied({ kind: L.KIND.DATA, status: L.STATUS.CAPTURED }), true);
  // And the reverse asymmetry is deliberate: a DOCUMENT at on_file_offline IS
  // satisfied. Data has to be read and checked; a document is its own evidence.
  assert.strictEqual(L.isSatisfied({ kind: L.KIND.DOCUMENT, status: L.STATUS.ON_FILE_OFFLINE }), true);
});

// ── build enforcement ─────────────────────────────────────────────────────

test('the ledger restates no requirement vocabulary of its own', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'enrollmentLedger.js'), 'utf8');
  // The consent set, document catalog and required-field list each have one
  // owner already. A fourth copy here is how the ledger starts chasing a
  // consent the registry retired.
  assert.ok(!/require\(.*consentRegistry/.test(src), 'requirements are passed in, not imported and re-filtered');
  for (const leaked of ['photoId', 'insuranceCard', 'serviceAgreement', 'roiFamily']) {
    assert.ok(!new RegExp(`['"\`]${leaked}['"\`]`).test(src),
      `${leaked} is named in the ledger — that is a second copy of a vocabulary that already has an owner`);
  }
});

test('the spec this implements is on main, not stranded on a branch again', () => {
  const spec = path.join(__dirname, '..', 'docs', 'GFC_Offline_Intake_Reconciliation_Spec_v1.md');
  assert.ok(fs.existsSync(spec), 'the reconciliation spec must be in the repo');
  const text = fs.readFileSync(spec, 'utf8');
  // It was written in the Replit era and its compliance posture is inverted
  // now. A reader who acts on §0 as written would build outside the boundary.
  assert.ok(/SUPERSEDED/.test(text), 'the stale compliance posture must be marked');
  assert.ok(/§10\.3/.test(text), 'and must point at the rules that actually bind');
});
