// ============================================================
// buildConsentEvent date-safety — importer crash guard (audit P0#1)
//
// The legacy ROI importer previously routed a synthetic, non-date string
// (`legacy:<token>`) through `signed_at`. buildConsentEvent parses signed_at to
// materialize the mandatory one-year expiration; an unparseable value produced
// `new Date(NaN).toISOString()` → RangeError, crashing the importer on the first
// real row. These tests lock in that:
//   1. an unparseable signed_at never throws and yields a valid expiration, and
//   2. a real signed_at still computes the correct one-year expiration.
//
// Run: npm test
// ============================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRepository } = require('../roiRepository');

// Minimal in-memory KV that satisfies the repository's get/set contract.
function memDb() {
  const store = new Map();
  return {
    get: async (k) => (store.has(k) ? store.get(k) : null),
    set: async (k, v) => { store.set(k, v); },
  };
}

test('unparseable signed_at does not throw and yields a valid expiration', async () => {
  const repo = createRepository(memDb());
  let event;
  await assert.doesNotReject(async () => {
    event = await repo.insertConsentEvent({
      client_id: 'c1',
      signed_at: 'legacy:some-token', // the exact shape the old importer passed
      source: 'legacy_import',
    });
  });
  // signed_at falls back to a real ISO timestamp…
  assert.ok(!isNaN(new Date(event.signed_at).getTime()), 'signed_at must be a parseable date');
  // …and the one-year expiration is a valid YYYY-MM-DD, never "Invalid Date".
  assert.match(event.expiration_date, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(!isNaN(new Date(event.expiration_date).getTime()));
});

test('a real signed_at computes expiration exactly one year later', async () => {
  const repo = createRepository(memDb());
  const event = await repo.insertConsentEvent({
    client_id: 'c1',
    signed_at: '2026-03-15T12:00:00.000Z',
    source: 'online_form',
  });
  assert.equal(event.signed_at, '2026-03-15T12:00:00.000Z');
  assert.equal(event.expiration_date, '2027-03-15');
});

test('an explicit expiration_date always wins over the one-year default', async () => {
  const repo = createRepository(memDb());
  const event = await repo.insertConsentEvent({
    client_id: 'c1',
    signed_at: 'legacy:tok',
    expiration_date: '2030-01-01',
    source: 'legacy_import',
  });
  assert.equal(event.expiration_date, '2030-01-01');
});
