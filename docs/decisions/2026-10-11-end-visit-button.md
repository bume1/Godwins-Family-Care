# My Day had no way to stop the billing clock (2026-10-11, owner question)

**Problem:** the owner asked where the start-the-clock buttons were for billing. The server has accepted a fourth timing event (`end` → `endedAt`) since Session 4.12, alongside `en_route`/`arrive`/`start`, and `myDay.js`'s `billableMinutes` is built strictly from `startedAt` → `endedAt` with no fallback to the schedule (owner rule, 2026-09-23). But My Day's `DayVisitRow` only ever wired three of the four stamps — **En route**, **Arrive**, **Start visit** — to `onStamp`. There was no "End visit" button anywhere in the app.

Consequence: because `endedAt` could never be set from the UI, `billableMinutes`/the time statement stayed `null` for every visit regardless of how it actually went — there was no way to stop a clock that had, in fact, started.

**Fix:**
- Added an **End visit** button to `DayVisitRow` (`public/clinical.html`), shown when `v.state === 'in_progress'` — the state `deriveVisitState` (`myDay.js`) already produces once `startedAt` is set and nothing has signed yet. It calls the same `onStamp(v, 'end')` → `api.stampVisit` → `POST /api/clinical/visits/:eid/timing` path the other three stamps use; no server change needed, the route and its correction/reason handling were already there.
- The per-visit timing line now also shows `Ended {time}` once recorded (it already carried `endedAt` in the row's `timing` object; it just wasn't displayed).

**Verified:**
- `test/clinical_workspace_412.test.js` gained one test asserting the button exists, is gated on `in_progress` (not loose elsewhere in the row), and calls `onStamp(v, 'end')`. Mutation-checked by deleting the button block — the test failed with the expected message, then passed again once restored.
- Full suite: 2002 tests, 2 pre-existing failures unrelated to this change (confirmed by running the same suite against an unmodified checkout — `EVERY link the app can email resolves to a real page`, and `test/bedrock_transport.test.js` as a whole file, which also reports a nested consent-rendering subtest failure), 1 skipped.
- The page's babel block was extracted and run through esbuild's JSX transform — compiles clean.
- Not rendered in a browser this pass.
