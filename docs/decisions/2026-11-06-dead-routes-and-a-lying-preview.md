# Five dead routes, and two previews that showed the wrong email

**Date:** 2026-11-06
**Branch:** `claude/dead-email-routes`
**Owner ask:** "Fix all" — the remaining capabilities with a route and no UI.

## What was wrong

Three findings, all from the same cause: a fix written in a place that never runs.

### 1. Five email-template routes were registered twice, and the second copy never ran

Express matches registrations in order. `server.js` carried the whole
email-template block **twice** — `GET /api/admin/email-templates`, `GET` and
`PUT` of `:id`, `:id/reset` and `:id/preview` — about 480 lines apart. The
later block had never executed once.

It was not harmless. Somebody wrote that second block as an improvement: a
tighter `requireAdmin` gate, and **the welcome-email preview fix from PR #81.**
None of it took effect. So:

> **An admin previewing the welcome email saw the generic house wrapper, while
> the person receiving it got the credentials table.** The one email that
> carries somebody's sign-in details was the one the preview got wrong.

The *live* block is better in every other respect — it has the `/pools` route,
it strips computed pool fields before persisting, and it writes an activity-log
entry on an update, none of which the dead copy did. So the dead block is
deleted and its **one** genuine improvement is ported into the live preview.

### 2. The notification preview showed unbranded plain text for most notices

Since PR #90 branding belongs to the **drain**: a notice queued with only a
`body` is wrapped in the house template by `buildQueuedEmail` on its way out.
`GET /api/admin/notifications/preview/:id` read `templateData.htmlBody` and
fell back to a bare `<pre>`. So for every one of those notices — the shift
notices, both caregiver escalations, message-received, the admin custom send —
**the preview showed something the recipient would never see.**

It also interpolated the stored body into HTML unescaped and served it
same-origin.

Both are fixed by one line: the route calls the drain's own `buildQueuedEmail`.
The two cannot disagree by construction, and `emailTemplates` escapes
everything it renders.

### 3. Two routes had no caller at all

`GET /api/admin/notifications/preview/:id` and `POST /api/admin/test-email`.
The admin hub had a preview modal, but it built the preview **in the page**
with the same wrong fallback and never called the route.

## What was built

- The five dead routes are **deleted**, with a comment in their place saying
  what was there and why it never ran.
- The live preview gets the welcome email's own builder, matching the
  `test-send` route beside it and the real send.
- The notification preview route runs `buildQueuedEmail` and sets `nosniff`.
- The admin hub's preview modal now **fetches that route** instead of guessing,
  and says so plainly when the read fails rather than showing an empty email.
  The iframe keeps `sandbox="allow-same-origin"` with no `allow-scripts`.
- A **Send a test email** card on the Notifications overview (Super Admin, to
  match the route). It reports what the transport said and never more: *accepted
  for delivery*, not *delivered*.
- `test/no_duplicate_routes.test.js` fails the build if any path is ever
  registered twice again, in `server.js` or any `routes/*.js`.

## Decisions a later session must not undo

- **The live email-template block keeps `requireAdminHubAccess`.** The dead
  copy carried `requireAdmin`, and tightening the live gate would lock out
  anyone holding `hasAdminHubAccess` who is not a Super Admin. That is the
  owner's call, not a side effect of removing dead code. Flagged below.
- **The preview must call `buildQueuedEmail`, not read `templateData.htmlBody`.**
  A test asserts both the route and the drain call it, so they cannot drift.
- **The test-email card says "Accepted for delivery", never "Sent".** The
  transport can only report that it accepted the message.

## Verified

- **6 unit tests**; **17 of 17 mutations each confirmed to fail one** — a
  duplicate route reintroduced, the welcome-email fix reverted, `/pools`
  removed, the update route no longer stripping computed fields or logging,
  the preview route back to reading `htmlBody`, `nosniff` dropped, the modal
  building the preview in the page or calling a different route, a failed
  preview reading as an empty email, the iframe allowed to run scripts, the
  test-email card ungated or uncalled, the card claiming delivery, a failed
  send hiding its reason, the route widened, and the drain no longer using
  `buildQueuedEmail`.
- **`scripts/verify_notification_preview.js` — 11/11 over real HTTP** against a
  booted server: the welcome preview carries its credentials table, another
  template gets the house wrapper, an unknown notification is a 404 rather than
  a blank page, the preview is refused unauthenticated, and the live
  email-template routes still answer and are still enriched after the deletion.
  **Mutation-checked:** reverting the welcome-email fix fails it.
- Full suite **3066, 0 failing** (1 skipped, pre-existing). The page compiles;
  the app boots and all three routes answer 401 unauthenticated.

## Two things worth keeping

1. **A comment was read as code for the fourth time this session.** My own
   iframe test scanned a 900-character window for `allow-scripts` — and my own
   comment beside the iframe says "without allow-scripts", so it reported the
   iframe unsafe while it was correct. It reads the attribute now.
2. **A probe assertion that passed on a branch that tested nothing.** The
   "another template still renders the house wrapper" check asked for
   `task_reminder`, which does not exist, and fell through to an `else` that
   passed unconditionally. It uses a real template id now.

## Open for the owner

- **The email-template routes are still `requireAdminHubAccess`, not
  `requireAdmin`.** Somebody once intended to tighten them. Say the word and
  it is a one-word change per route.
- Nothing is live until the container is rebuilt on the EC2 box.
