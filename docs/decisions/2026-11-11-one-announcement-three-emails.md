# One announcement sent everybody three emails (owner report, 2026-11-11)

Owner: *"people were sent 3 emails when the announcement was released. Why? Can we fixed"*

## The cause

`processNotificationQueue` in `server.js` was a read-modify-write across a network call:

```js
const queue = await db.get('pending_notifications');               // READ
const pending = queue.filter(n => n.status === 'pending' && ...);  // SELECT
...
const batchResult = await sendBatchEmails(emailPayloads);          // SEND — seconds, with retries
queue[idx].status = 'sent';                                        // MARK — only now
```

**Nothing claimed the rows between SELECT and MARK.** For the entire duration of a send, a second run read those same rows as `pending` and sent them again. Two overlapping runs, two emails; three, three.

It had three doors and **no lock** — the boot timer, the 15-minute interval, and the admin hub's **Process Queue** button, which was a bare `onClick` with no in-flight guard. Mail does not arrive for up to 15 minutes, which is exactly what invites pressing that button again, so the design encouraged the bug.

## What was ruled out first, so the fix is aimed correctly

- **Not three senders.** Only two queue an announcement: `routes/caregiver.js` (`staff_announcement`, staff) and `server.js` (`announcement`, clients). Different audiences, different types; nobody receives both.
- **Not three queued rows.** `queueNotification` dedupes on type + recipient + `relatedEntityId` while a row is pending, and again against `notification_log` for a 20-hour cooldown. A second row for the same person and announcement is refused. **So one row was sent three times**, which points at the drain and nowhere else.
- **Not multiple processes.** `npm start` is a bare `node server.js`; no cluster, no pm2, no replicas.

## The fix

1. **An in-process lock** (`queueDraining`), released in a `finally` so a throw cannot wedge the queue shut.
2. **The rows are CLAIMED before the network call** — written as `sending` with a `claimedAt` and persisted *before* `sendBatchEmails`, so a concurrent run's `status === 'pending'` filter no longer selects them. This is the part that would also hold across processes, which a flag cannot.
3. **A stale claim is reclaimed** after 15 minutes, or a crash mid-send would strand a row forever. **The trade is stated, not hidden:** reclaiming risks one duplicate after a crash; never reclaiming guarantees permanent loss, and for a password reset silence is the worse failure.
4. **The Process Queue button is disabled while it runs** and reads "Sending…".

### ⚠️ The trap, which would have destroyed the rows the fix protects

The archive step kept `remaining = queue.filter(n => n.status === 'pending')`, so **any row in another state was silently deleted** on the next drain. Adding `sending` without widening that filter would have thrown away exactly the notifications being claimed. `remaining` now keeps everything not archived — which also fixes a live loss that predates this change: a `held` row was being discarded the same way.

## A bug I introduced, found by running it rather than reading it

The failure branch bumped `retryCount` but never reset the status, because before the claim existed the row was still `pending` and nothing needed saying. With the claim, a failed send left the row stuck at `sending` until the 15-minute sweep — **turning every transient failure into a 15-minute delay.** The branch now returns the row to `pending` and clears the claim.

**None of my first six tests caught it, because every one used a send that succeeded.** It surfaced only when the probe ran against this sandbox, which has no mail transport, and the queue came back `{"sending": 6}` with `retryCount: 1`. Two tests now cover the failure path.

## Verified

- `test/notification_queue_concurrency.test.js` — **8 tests**, running the real `processNotificationQueue` lifted out of `server.js` against fakes, with both slice anchors asserted.
- **The headline test genuinely races**: it starts three drains without awaiting the first, against a fake mailer that resolves on a deferred promise. A test that awaited the first call would pass against the broken code and prove nothing.
- **It reproduces the owner's symptom exactly.** With both fixes reverted — the original code — it reports `{"a@gfc.test":3,"b@gfc.test":3}`. With the fix, one each.
- **8 of 8 mutations caught:** the claim moved back after the send, the lock removed, the archive filter narrowed, the reclaim dropped, the reclaim widened to ignore its window, the lock released outside `finally`, both fixes reverted together, and the failure branch not releasing the claim.
- Full suite **3769, 0 failing** (1 skipped, pre-existing). `public/admin-hub.html` compiles.

### NOT proven, stated plainly

**The no-duplicate behaviour was not demonstrated over real HTTP**, and the probe refuses to claim it was. This sandbox has no mail transport, so every send fails instantly; three concurrent `POST /api/admin/notifications/process` calls therefore ran **sequentially** — the boot log shows zero "already running" refusals — and a race that never happened proves nothing about preventing one. The probe asserts its preconditions and **aborts rather than reporting a vacuous pass** on an empty result.

What the live run did prove: the routes answer, rows no longer strand at `sending` after a failed send, and the retry-then-archive lifecycle still works.

## Open for the owner

1. **Confirm the diagnosis from your side if you want it:** Admin hub → Notifications → History should show the *same* entry three times for that announcement. Three *different* entries would overturn this and mean the dedupe failed instead.
2. **The deeper shape is unchanged.** Every collection is one blob read and written whole, so any two writers racing can still lose each other's work. `CLAUDE.md` already records row-level tables as a later refactor; this change fixes the queue's own claim within that model rather than changing it.
