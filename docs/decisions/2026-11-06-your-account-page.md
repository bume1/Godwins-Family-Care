# Your own account: the page five routes were waiting for

**Date:** 2026-11-06
**Branch:** `claude/account-security`
**Owner ask:** "Fix all" — the remaining capabilities with a route and no UI.

## What was wrong

Five things a signed-in person could only do by calling an API by hand:

| Route | What it does | Who could reach it |
|---|---|---|
| `GET /api/auth/mfa/status` | their two-factor state and how many backup codes are left | nobody |
| `POST /api/auth/mfa/recovery-codes/regenerate` | a fresh set of backup codes | nobody |
| `GET /api/auth/sessions` | every device holding a live sign-in for their account | nobody |
| `POST /api/emr/disconnect` | clear their own OpenEMR sign-in | nobody |
| `POST /api/auth/change-password` | change their password | **only** through `login.html`'s FORCED change |

So somebody who simply wanted to change their password could not. Somebody who
lost their phone could not see how many backup codes they had left, let alone
make new ones. Nobody could see that their account was signed in on a device
they no longer owned.

## What was built

`public/account.html`, served at `/account`, linked from **all four** signed-in
surfaces: the Admin Hub sidebar, the clinical workspace's Settings, the client
portal's Settings, and the caregiver app's More tab. Every role has an account,
so it is one page rather than four copies — and linking it everywhere is the
point: a screen nobody can reach is a screen that does not exist.

Cards: who you are · Password · Two-step sign-in · Where you are signed in ·
Your OpenEMR sign-in (clinical only) · Email from GFC.

## Decisions a later session must not undo

- **⚠️ NO TOGGLE FOR `notificationPreferences`, AND THAT IS THE POINT.**
  `PUT /api/users/:userId/notification-preferences` writes three keys —
  `emailReminders`, `overdueReminders`, `milestoneNotifications` — and
  **nothing in this repo reads any of them.** Verified across every `.js`,
  `.jsx`, `.html`, `.mjs` and `.cjs` in the tree: the only occurrences are the
  default values written at account creation. A switch for them would be a
  setting somebody turns off and is then emailed anyway — the inert-field trap
  this repo keeps paying for. A test pins the exact baseline, so **the day a
  reader appears, that test fails and the page should grow the toggles it
  currently refuses to fake.** What the app really honours is
  `emailUnsubscribed` and `accountStatus`, checked by `queueNotification` at
  the choke point, so those are what the email card reports.

- **NO "SIGN OUT THIS DEVICE" BUTTON, BECAUSE NO ROUTE DOES THAT.**
  `POST /api/auth/logout` revokes the current session; the per-user revoke is
  `requireAdmin`. The page says so plainly and names the control that genuinely
  works: changing the password revokes every other session server-side. A
  button that answers 403 is worse than no button, and a sentence that tells
  you what does work is better than either.

- **THE OPENEMR CARD IS DRAWN ONLY WHEN THE SERVER SAYS SO.**
  `GET /api/clinical/status` is `requireClinicalRead`, so a 403 *is* the answer
  that this person has no OpenEMR sign-in to manage. The page asks rather than
  deciding a credential question for itself — the 4.8 rule. A caregiver never
  sees the card.

- **TWO-STEP ENROLMENT IS NOT OFFERED HERE**, because there is no self-service
  enrol route: it happens inside the login flow. The card says where, rather
  than carrying a button that goes nowhere.

- **REGENERATING BACKUP CODES NEEDS A LIVE AUTHENTICATOR CODE**, which the
  server already requires: somebody holding a stolen session must not be able
  to mint themselves a permanent way in. The page sends it, will not offer the
  button without one, and says the new set is shown **once**.

- **THE PAGE TAKES ITS IDENTITY FROM THE SERVER, NEVER FROM `localStorage`.**
  `GET /api/auth/mfa/status` now also carries `account` — the caller's own id,
  name, email, role, email-subscription state and last password change. It is
  bound to `req.user.id` and takes no parameter. The page reads **tokens** out
  of storage and nothing else; a stale stored user object is indistinguishable
  from a good one until somebody acts on the wrong account (PR #113).

- **A DEVICE NAME IS A READING OF THE USER AGENT, AND IS LABELLED AS ONE.**
  An unrecognised agent reads "Unknown device", never an invented one —
  guessing a tidy name is how somebody decides a session is theirs when it is
  not. Edge and Opera both carry `Chrome/`, so they are checked first.

- **THE CLOCK COMES FROM `gfc-time.js`, never a literal** (build-enforced).

## Verified

- **12 unit tests**; **26 of 26 mutations each confirmed to fail one** — the
  route removed, each of the four links removed, identity taken from
  `localStorage`, a Bearer header inlining a storage read, the status route
  given a user parameter or stripped of the account, the clinical read skipped
  or its refusal ignored, the OpenEMR card drawn unconditionally, a per-device
  sign-out added, the two honest sentences about sessions removed, the live
  code dropped from the regenerate, the button offered with no code, the
  once-only warning dropped, the enrolment sentence changed, a
  notification-preferences toggle added, an email write added, the email state
  hidden, the zone restated, an invented device name, Edge reported as Chrome,
  and the device-name caveat dropped.
- **`scripts/verify_account_render.js` — 32/32 in Chromium**, driving three
  people: a clinician with two-step on and OpenEMR connected, a caregiver, and
  a coordinator nearly out of backup codes and unsubscribed. It asserts what
  the page **sends**, not only what it shows. **Itself mutation-checked, 11 of
  11** — the OpenEMR card drawn for everyone, the live code dropped, a revoked
  session listed as live, the device count including the current one, the zone
  and its shim both dropped, mismatched passwords sent anyway, the server's
  message swallowed, the code form shown to somebody not enrolled, the
  low-codes warning silenced, the success message stripped of what it did to
  the other devices, and disconnect pointed at the admin route.
- Full suite **3074, 0 failing** (1 skipped, pre-existing). Every touched page
  compiles; the app boots, `/account` serves 200 and both account routes
  answer 401 unauthenticated.

## Three things worth keeping

1. **The comment-stripping helper several of my tests use is fooled by a `/*`
   inside a string or a regex literal** and swallows everything to the next
   `*/`. Run it over `server.js` and `emailReminders` disappears, which made
   the tree scan report zero hits and pass vacuously. The scan now reads raw
   source with an exact baseline, and the page's own stripped block asserts it
   survived. That is the fifth variant of the comment-as-code trap in this
   repo.

2. **A multi-part mutation whose second half was a no-op read as a survivor.**
   Dropping the Eastern shim AND the explicit zone should render UTC, and it
   reported SURVIVED — because the find string for the second half had four
   leading spaces the real line does not. The shim alone was dropped, and the
   explicit zone correctly covered it. Re-run with each part asserted to have
   changed the file: CAUGHT. *A no-op replace and a surviving mutation are
   indistinguishable unless the harness checks.*

3. **My own link test matched the bare path `/account`**, which my own comments
   on those pages also contain — so deleting every link still passed. Fixed to
   match the link markup. Third time this session that an assertion could not
   distinguish two states.

## Open for the owner

- **`PUT /api/users/:userId/notification-preferences` is a dead route.** It
  writes three values nothing consults. Either wire them into
  `queueNotification` beside `emailUnsubscribed`, or delete the route. Until
  one of those happens the page deliberately shows no switch for them.
- **There is no self-service way to sign out one device.** The page says so.
  If you want one, it is a small route (`POST /api/auth/sessions/:id/revoke`,
  bound to `req.user.id`) and a button; say the word.
- Nothing is live until the container is rebuilt on the EC2 box.
