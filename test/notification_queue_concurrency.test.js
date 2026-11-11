'use strict';

// ⚠️ ONE ANNOUNCEMENT, THREE EMAILS (owner report, 2026-11-10).
//
// `processNotificationQueue` read the pending rows, awaited `sendBatchEmails`,
// and only THEN marked them sent. For the whole duration of that network call
// a second run selected the same rows and sent them again. Three overlapping
// runs — the boot timer, the 15-minute interval, and an admin pressing
// "Process Queue" because nothing had arrived yet — meant three emails.
//
// These tests run the REAL function, lifted out of server.js (requiring it
// boots a server), against fakes. The concurrency test deliberately does NOT
// await the first call before starting the second: a test that awaited it
// would pass against the broken code and prove nothing.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

// Lift the declarations this function needs, anchored at both ends and loud if
// either anchor moves — a guard that silently grabs the wrong slice proves
// nothing (house rule, bought twice in this repo).
function liftDrain() {
  const start = SRC.indexOf('let queueDraining = false;');
  const endAnchor = '[QUEUE] Processing error:';
  const endIdx = SRC.indexOf(endAnchor, start);
  assert.ok(start > -1, 'anchor "let queueDraining" moved — fix this test, do not delete it');
  assert.ok(endIdx > start, 'anchor "[QUEUE] Processing error:" moved');
  const close = SRC.indexOf('\n};', endIdx);
  assert.ok(close > endIdx, 'could not find the end of processNotificationQueue');
  return SRC.slice(start, close + 3);
}

function harness({ sendDelayMs = 20, rows, failSends = false } = {}) {
  const store = { pending_notifications: JSON.parse(JSON.stringify(rows)), notification_log: [] };
  const db = {
    get: async (k) => (k in store ? JSON.parse(JSON.stringify(store[k])) : null),
    set: async (k, v) => { store[k] = JSON.parse(JSON.stringify(v)); }
  };
  const sent = [];
  let inFlight = 0, maxInFlight = 0;
  const sendBatchEmails = async (payloads) => {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise(r => setTimeout(r, sendDelayMs));
    if (!failSends) payloads.forEach(p => sent.push(p.to));
    inFlight--;
    return { results: payloads.map(() => failSends ? ({ success: false, error: 'no transport' }) : ({ success: true })) };
  };
  const config = { NOTIFICATION_DAILY_SEND_LIMIT: 1000, NOTIFICATION_LOG_MAX_ENTRIES: 500, NOTIFICATION_MAX_RETRIES: 3 };
  const buildQueuedEmail = (t) => ({ text: t.body || '', html: `<p>${t.body || ''}</p>` });
  const getAppBaseUrl = async () => 'https://app.example.test';
  const mk = new Function('db', 'config', 'sendBatchEmails', 'buildQueuedEmail', 'getAppBaseUrl',
    `${liftDrain()}; return processNotificationQueue;`);
  return { run: mk(db, config, sendBatchEmails, buildQueuedEmail, getAppBaseUrl), sent, store, maxInFlight: () => maxInFlight };
}

const row = (id, email, extra = {}) => Object.assign({
  id, type: 'staff_announcement', recipientUserId: id, recipientEmail: email,
  recipientName: email, channel: 'email', triggerDate: new Date(Date.now() - 1000).toISOString(),
  status: 'pending', retryCount: 0, maxRetries: 3, relatedEntityId: 'ann-1',
  relatedEntityType: 'announcement', templateData: { subject: 'News', body: 'Hello' },
  sentAt: null, createdAt: new Date().toISOString()
}, extra);

test('THE BUG: three overlapping drains send each person exactly one email', async () => {
  const h = harness({ rows: [row('n1', 'a@gfc.test'), row('n2', 'b@gfc.test')] });
  // Not awaited in turn — that is the point. This is the real race.
  const runs = [h.run(), h.run(), h.run()];
  await Promise.all(runs);
  const counts = h.sent.reduce((m, e) => (m[e] = (m[e] || 0) + 1, m), {});
  assert.deepStrictEqual(counts, { 'a@gfc.test': 1, 'b@gfc.test': 1 },
    `each recipient must be emailed once; got ${JSON.stringify(counts)}`);
  assert.strictEqual(h.sent.length, 2, 'two recipients, two emails in total');
});

test('a second drain entering mid-send is refused rather than sending again', async () => {
  const h = harness({ sendDelayMs: 40, rows: [row('n1', 'a@gfc.test')] });
  const first = h.run();
  await new Promise(r => setTimeout(r, 5)); // first is now inside sendBatchEmails
  const second = await h.run();
  await first;
  assert.deepStrictEqual(second, { skipped: 'already_draining' }, 'the overlapping run says why it did nothing');
  assert.strictEqual(h.sent.length, 1, 'still one email');
});

test('rows are CLAIMED before the network call, not after it', async () => {
  const h = harness({ sendDelayMs: 40, rows: [row('n1', 'a@gfc.test')] });
  const p = h.run();
  await new Promise(r => setTimeout(r, 10)); // mid-send
  const mid = h.store.pending_notifications;
  assert.strictEqual(mid.length, 1, 'the row is still in the store while sending');
  assert.strictEqual(mid[0].status, 'sending', 'it reads `sending` DURING the send, which is what makes it unselectable');
  assert.ok(mid[0].claimedAt, 'and it records when it was claimed');
  await p;
});

test('a claimed row is never silently deleted from the store', async () => {
  // The archive step used to keep only `pending`, so any other status was
  // dropped. Introducing `sending` without widening it would have destroyed
  // the very rows the claim protects.
  const h = harness({ rows: [row('n1', 'a@gfc.test'), row('n2', 'b@gfc.test', { status: 'held' })] });
  await h.run();
  const left = h.store.pending_notifications;
  assert.ok(left.some(n => n.id === 'n2'), 'a held row survives the drain — it used to be deleted');
  assert.strictEqual(h.sent.length, 1, 'and a held row is not sent');
});

test('a claim left behind by a crashed run is reclaimed, a fresh one is not', async () => {
  const stale = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  const fresh = new Date().toISOString();
  const h = harness({ rows: [
    row('n1', 'stale@gfc.test', { status: 'sending', claimedAt: stale }),
    row('n2', 'fresh@gfc.test', { status: 'sending', claimedAt: fresh })
  ] });
  await h.run();
  assert.deepStrictEqual(h.sent, ['stale@gfc.test'], 'only the abandoned claim is retried');
  assert.ok(h.store.pending_notifications.some(n => n.id === 'n2'), 'the live claim is left alone, not dropped');
});

test('a thrown error releases the lock instead of wedging the queue shut', async () => {
  const h = harness({ rows: [row('n1', 'a@gfc.test')] });
  h.store.pending_notifications = null; // make the first run throw on .filter
  await h.run().catch(() => {});
  h.store.pending_notifications = [row('n2', 'b@gfc.test')];
  await h.run();
  assert.deepStrictEqual(h.sent, ['b@gfc.test'], 'the next drain still runs');
});

test('a FAILED send releases the claim so the next drain retries it', async () => {
  // My first version of the claim did not, so a transient failure stranded the
  // row at `sending` until the 15-minute sweep — a 15-minute delay on every
  // retry. Caught by running the probe against a sandbox with no mail
  // transport; none of the tests above covered the failure path at all.
  const h = harness({ failSends: true, rows: [row('n1', 'a@gfc.test')] });
  await h.run();
  const after = h.store.pending_notifications;
  assert.strictEqual(after.length, 1, 'the row is kept');
  assert.strictEqual(after[0].status, 'pending', 'and is selectable again immediately, not stuck at `sending`');
  assert.strictEqual(after[0].claimedAt, null, 'the claim is cleared');
  assert.strictEqual(after[0].retryCount, 1, 'the retry is still counted');
});

test('a send that fails past maxRetries is marked failed, not retried forever', async () => {
  const h = harness({ failSends: true, rows: [row('n1', 'a@gfc.test', { retryCount: 2, maxRetries: 3 })] });
  await h.run();
  assert.ok(!h.store.pending_notifications.some(n => n.id === 'n1'), 'it leaves the pending store');
  assert.strictEqual(h.store.notification_log[0].status, 'failed', 'and is archived as failed');
});
