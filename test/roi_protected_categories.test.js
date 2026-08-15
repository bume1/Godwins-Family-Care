// ============================================================
// 42 CFR Part 2 enforcement — build-fail guard (Session 3.4)
//
// These tests assert the single non-negotiable invariant of the
// Transfer-of-Care ROI: the four specially-protected categories (mental
// health, substance use, HIV/AIDS, genetic testing) are NEVER releasable
// unless `includes_protected_info === true` on the specific consent event.
//
// The rule is enforced at the data-access layer by the PURE function
// `getRequestableRecordCategories` in roiRepository.js. If anyone changes that
// function so protected categories leak without the opt-in — including trying
// to "bypass" it by stuffing a protected category into the stored category
// rows — one of these tests fails and `npm test` (and therefore the build)
// fails.
//
// Run: npm test
// ============================================================

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getRequestableRecordCategories,
  PROTECTED_CATEGORIES,
  RECORD_CATEGORIES,
  validateAuthorizationElements,
  createRepository
} = require('../roiRepository');

const STANDARD_ROWS = RECORD_CATEGORIES.map(c => ({ category: c }));

test('opt-in defaults FALSE: no protected category is releasable', () => {
  const event = { includes_protected_info: false };
  const releasable = getRequestableRecordCategories(event, STANDARD_ROWS);
  for (const pc of PROTECTED_CATEGORIES) {
    assert.ok(!releasable.includes(pc), `protected category "${pc}" must NOT be releasable when opt-in is false`);
  }
  // ...but the standard checked categories still come through.
  assert.deepEqual(releasable.sort(), RECORD_CATEGORIES.slice().sort());
});

test('missing/undefined opt-in is treated as FALSE', () => {
  for (const event of [{}, { includes_protected_info: undefined }, { includes_protected_info: null }, null]) {
    const releasable = getRequestableRecordCategories(event, STANDARD_ROWS);
    for (const pc of PROTECTED_CATEGORIES) {
      assert.ok(!releasable.includes(pc), `opt-in ${JSON.stringify(event)} must not release "${pc}"`);
    }
  }
});

test('truthy-but-not-true opt-in values do NOT unlock protected categories', () => {
  // Guards against a sloppy `if (event.includes_protected_info)` check.
  for (const truthy of [1, 'true', 'yes', {}, [], 'false']) {
    const event = { includes_protected_info: truthy };
    const releasable = getRequestableRecordCategories(event, STANDARD_ROWS);
    for (const pc of PROTECTED_CATEGORIES) {
      assert.ok(!releasable.includes(pc), `opt-in value ${JSON.stringify(truthy)} must not release "${pc}"`);
    }
  }
});

test('BYPASS ATTEMPT: protected categories injected into the rows are stripped when opt-in is false', () => {
  // Simulates an attacker/bug trying to sneak protected categories in through
  // the stored category rows without the event-level opt-in.
  const rows = [...STANDARD_ROWS, ...PROTECTED_CATEGORIES.map(c => ({ category: c }))];
  const event = { includes_protected_info: false };
  const releasable = getRequestableRecordCategories(event, rows);
  for (const pc of PROTECTED_CATEGORIES) {
    assert.ok(!releasable.includes(pc), `injected protected category "${pc}" must be stripped`);
  }
});

test('opt-in === true releases the protected categories', () => {
  const event = { includes_protected_info: true };
  const releasable = getRequestableRecordCategories(event, STANDARD_ROWS);
  for (const pc of PROTECTED_CATEGORIES) {
    assert.ok(releasable.includes(pc), `protected category "${pc}" must be releasable when opt-in is true`);
  }
});

test('repository getRequestableCategoriesForEvent enforces the same gate through storage', async () => {
  // In-memory KV stub matching the @replit/database get/set surface.
  const store = new Map();
  const db = {
    get: async (k) => store.get(k),
    set: async (k, v) => { store.set(k, v); }
  };
  const repo = createRepository(db);

  // Two events for one client: one WITHOUT the opt-in, one WITH.
  const evtNo = await repo.insertConsentEvent({ client_id: 'c1', printed_name: 'Test', includes_protected_info: false });
  const evtYes = await repo.insertConsentEvent({ client_id: 'c1', printed_name: 'Test', includes_protected_info: true });

  // Both events get the same category rows, INCLUDING a protected one on the
  // no-opt-in event (defense-in-depth at the query layer).
  await repo.insertRecordCategories(evtNo.id, ['hp', 'meds', 'mental_health']);
  await repo.insertRecordCategories(evtYes.id, ['hp', 'meds']);

  const releasableNo = await repo.getRequestableCategoriesForEvent(evtNo.id);
  assert.ok(!releasableNo.includes('mental_health'), 'no-opt-in event must not release mental_health even if a row exists');
  assert.deepEqual(releasableNo.sort(), ['hp', 'meds'].sort());

  const releasableYes = await repo.getRequestableCategoriesForEvent(evtYes.id);
  for (const pc of PROTECTED_CATEGORIES) {
    assert.ok(releasableYes.includes(pc), `opt-in event must release "${pc}"`);
  }
});

test('buildConsentEvent applies the mandated defaults', () => {
  const store = new Map();
  const db = { get: async (k) => store.get(k), set: async (k, v) => { store.set(k, v); } };
  const repo = createRepository(db);
  const row = repo.buildConsentEvent({ client_id: 'c1', printed_name: 'Jane Doe', signed_at: '2026-07-14T00:00:00.000Z' });
  assert.equal(row.includes_protected_info, false, 'protected opt-in must default false');
  assert.equal(row.purpose_treatment, true, 'purpose_treatment must default true');
  assert.equal(row.revoked_at, null, 'revoked_at must default null');
  assert.equal(row.event_type, 'roi_transfer');
  assert.equal(row.expiration_date, '2027-07-14', 'one-year default expiration must be materialized');
});

const { contentHash } = require('../roiRepository');

test('legacy-import dedupe hash is deterministic and idempotent', async () => {
  // The importer keys idempotency on sha256(client_id + signed_at + files).
  const h1 = contentHash(['c1', 'legacy:tok1', 'urlA|urlB', 'fA|fB']);
  const h2 = contentHash(['c1', 'legacy:tok1', 'urlA|urlB', 'fA|fB']);
  assert.equal(h1, h2, 'same inputs → same hash');
  assert.notEqual(h1, contentHash(['c2', 'legacy:tok1', 'urlA|urlB', 'fA|fB']), 'different client → different hash');

  const store = new Map();
  const db = { get: async (k) => store.get(k), set: async (k, v) => { store.set(k, v); } };
  const repo = createRepository(db);
  // First import: create + stamp dedupe hash.
  const evt = await repo.insertConsentEvent({ client_id: 'c1', source: 'legacy_import' });
  const events = await db.get('consent_events');
  events[0].dedupe_hash = h1;
  await db.set('consent_events', events);
  // Re-run: the importer would find the existing event and skip.
  const found = await repo.findEventByDedupeHash(h1);
  assert.ok(found && found.id === evt.id, 're-run finds the already-imported event → no duplicate');
  assert.equal(await repo.findEventByDedupeHash('nonexistent'), null);
});

test('validateAuthorizationElements enforces 45 CFR 164.508 required elements', () => {
  const goodSig = 'data:image/png;base64,' + 'A'.repeat(200);
  const base = {
    categories: ['hp'],
    purpose_treatment: true,
    signature_image_b64: goodSig,
    printed_name: 'Jane Doe',
    signed_at: '2026-07-14T00:00:00.000Z'
  };
  assert.equal(validateAuthorizationElements(base).ok, true);

  // Missing category description.
  assert.equal(validateAuthorizationElements({ ...base, categories: [] }).ok, false);
  // Empty signature.
  assert.equal(validateAuthorizationElements({ ...base, signature_image_b64: '' }).ok, false);
  // A typed-name-only fake (not a data URI) is rejected — canvas capture required.
  assert.equal(validateAuthorizationElements({ ...base, signature_image_b64: 'Jane Doe' }).ok, false);
  // Missing printed name.
  assert.equal(validateAuthorizationElements({ ...base, printed_name: '  ' }).ok, false);
  // No purpose at all.
  assert.equal(validateAuthorizationElements({ ...base, purpose_treatment: false, purpose_other_text: '' }).ok, false);
});
