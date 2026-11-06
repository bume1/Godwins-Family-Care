# The audit log finally has a screen

**Date:** 2026-11-06
**Branch:** `claude/audit-log-viewer`
**Owner ask:** "Fix all" — the remaining capabilities with a route and no UI.

## What was wrong

Session 5.4 (PR #72) built the durable, append-only `audit_log` and wrote its
own route comment:

> *"Session 12 builds the UI; this is the verification surface for go-live
> acceptance: every PHI access must be here."*

Session 12 never ran. So `GET /api/admin/audit-log` has been live for fourteen
months with nothing calling it, which means **an accounting of disclosures
under 45 CFR 164.528 was something nobody at GFC could produce from a screen.**
The data was all there. The way to read it was a hand-written API call.

Same class of gap as the facility-assignment route, `acknowledgeAbnormalResult`
and the MFA reset before each got a button: *a route with no UI is a capability
nobody has.*

## What was built

`public/audit.html`, served at `/audit`, linked from the Admin Hub's quick
actions. A separate page rather than an edit to the 220KB hub — the same call
`/scheduling` and `/caregivers` made.

Filters are exactly the ones the route already accepts: from, to, staff user
id, patient uuid, row count. Rows show when, who, what action, the request verb
and path, the patient and the entity, with the recorded detail behind a toggle.

## Decisions a later session must not undo

- **⚠️ THERE IS NO "LOAD MORE", AND THAT IS DELIBERATE.** `readAudit` is
  `ORDER BY id DESC LIMIT n` with **no offset**, in both adapters. A full page
  is the NEWEST n in the window and the older rows are simply not returned. A
  paging button would re-fetch the same rows and quietly imply there is nothing
  older. So a page filled to the cap carries a banner saying it is the newest n
  in the window, that **narrowing the dates** is how to reach older entries, and
  that **raising the row count only moves the cap**. A test asserts `readAudit`
  still has no `OFFSET`: if a later session adds one, that test fails and the
  page needs real paging, because the banner becomes a lie at that moment.

- **READS ONLY, AND NOTHING COULD MAKE IT OTHERWISE.** One request helper, no
  method, so it can only GET. Build-enforced two ways: the page issues no write
  verb, and **no POST/PUT/PATCH/DELETE route exists anywhere on the audit path**
  — scanned across the whole of `server.js`, not one handler. Append-only is the
  entire value of an audit log.

- **SUPER ADMIN ONLY, BECAUSE THE ROUTE IS.** The hub tile is gated on
  `user?.role === 'admin'`, computed from the user the server sent, and the
  gate must be the thing immediately before the link. A tile that answers 403 is
  worse than no tile. A refused read says *"The audit log is the Super Admin's.
  Your account cannot read it"* — never an empty table, which would read as
  nothing having happened.

- **THE ZONE COMES FROM `gfc-time.js`, NEVER A LITERAL.** Build-enforced: the
  page contains no `America/New_York`. Seconds are the one thing this page adds
  to `fmtDateTime` (which stops at the minute), because a burst of requests
  inside one minute is exactly what an auditor is reading. **If `gfc-time.js`
  did not load, the page says the times are NOT Eastern** rather than printing
  the viewer's own clock under that word — the app must not claim a state it
  cannot observe.

- **A `datetime-local` BOX HAS NO ZONE, AND SENDING IT RAW WOULD BE FIVE HOURS
  WRONG.** The from/to values are resolved through `instantFromZoned`, so
  "from 9am" means 14:00Z in November and 13:00Z in October. Measured, never a
  constant offset. Proven across the daylight-saving boundary in both a unit
  test and the browser probe, which reads the resolved value **off the real
  request** rather than off the input box.

- **AN EMPTY RESULT IS NOT A DIAGNOSIS.** "No entries match these filters. That
  is not the same as nothing having happened." And the patient box says it wants
  an **OpenEMR patient uuid**, so nobody types "Juanita", gets nothing, and
  reads it as "no one opened her record."

- **AN IMPERSONATED ACTION DECLARES ITSELF.** A row written under "View as"
  reads as the viewed person unless something says otherwise, so it carries a
  red *via &lt;admin&gt;* chip. That is the row an auditor most needs to see as
  such.

- **THE ACTION IS SHOWN AS STORED** (`emr_read`, `care_plan_cosign`), not
  translated. There is no served vocabulary of action names, a label map here
  would be a second copy that drifts, and a label invented for an action this
  page does not recognise would be a guess. The stored string is also what
  matches a server log line.

## Verified

- **12 unit tests** in `test/audit_log_viewer.test.js`; **24 of 24 mutations
  each confirmed to fail one** — the route removed, the Bearer header inlining a
  `localStorage` read, `getToken` repointed at the retired key, the page issuing
  a write, a delete route added to the audit path, the read widened off
  `requireAdmin`, the zone restated as a literal, the Eastern label claimed with
  no clock loaded, each of the two zone labels hardcoded, `gfc-time.js` dropped,
  the date filter sent zoneless, **the ISO-vs-milliseconds bug I shipped**, the
  offset assumed constant, a Load more button, an offset parameter, the cap
  warning never firing and always firing, the warning losing its instruction and
  implying a bigger limit reaches further back, the empty state reporting
  nothing having happened, the patient hint dropped, the tile's gate removed,
  and the append-only line removed.
- **`scripts/verify_audit_render.js` — 29/29 in Chromium** against the real
  page and real row shapes. **Mutation-checked itself: 7 of 9**, and the two
  survivors are recorded below rather than claimed as catches.
- Full suite **3073, 0 failing** (1 skipped, pre-existing). The page compiles;
  the app boots, `/audit` serves 200 and the API answers 401 unauthenticated.

## Three things worth keeping

1. **A real bug the test caught before the browser did.** `instantFromZoned`
   returns an **ISO string**, not milliseconds. I measured it with
   `Number.isFinite`, which is false for a string, so every date filter fell
   through to the raw zoneless value — the exact five-hour error the helper
   exists to prevent. It looked right and did nothing.

2. **`requireAdminHubAccess` CONTAINS the string `requireAdmin`.** My gate
   assertion matched the wrong one and survived the mutation that widens the
   route. Fixed by matching the trailing comma. *An assertion that cannot
   distinguish two states proves nothing* — again.

3. **TWO ZONE GUARDS, AND EITHER ALONE IS ENOUGH — recorded, not claimed.**
   Dropping the explicit `timeZone` changes nothing while
   `installDefaultTimeZone()` is loaded; dropping the shim changes nothing while
   the zone is explicit. Only removing **both** renders UTC under the word
   Eastern. Both are kept and the page comment says which does the work, so a
   later simplification does not remove the load-bearing one believing the other
   covers it. Same shape as `contentDisposition.js`'s CR/LF note. The probe also
   **skips rather than passes** when run in Eastern, where the check could not
   distinguish the two states at all.

## Open for the owner

- Nothing is live until the container is rebuilt on the EC2 box.
- The page reads the log; it does not export it. If a disclosure accounting has
  to leave the building as a document, a CSV download is a small follow-up.
