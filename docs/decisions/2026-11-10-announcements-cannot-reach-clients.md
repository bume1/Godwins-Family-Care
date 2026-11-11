# A client can never receive a staff announcement, and now that is guarded (owner question, 2026-11-10)

Owner: *"If I send an announcement via the my gfc area, will it email the contacts appropriately? I dont want any extra wiring that sends to clients accidentally."*

**The answer is yes it emails, and no it cannot reach a client.** Nothing needed fixing for safety. What this change adds is the guard that keeps it true, plus two honesty fixes on the *other* announcement board.

## My own mistake first, because it is the reason this took four attempts

I told the owner three times that the My GFC Announcements screen was not in this repository, and that I had searched 129 branches for it. It was on `main`. The timeline, measured from `git reflog` rather than recalled:

| when (UTC) | what |
|---|---|
| **2026-11-09 18:39** | my last fetch of *all* refs — `origin/main` pinned at `79d33b9` |
| **2026-11-10 14:35** | `e9aa432` authored, adding `staffAnnouncements.js` and the My GFC section |
| **2026-11-10 17:27** | merged to `main` as **PR #292** |
| **2026-11-10 21:57** | I finally refetched, after the third correction |

`git merge-base --is-ancestor e9aa432 79d33b9` answers **no**, so the feature genuinely was not in anything I could see. My search was accurate about data roughly 27 hours old.

**The 129 is the finding, not the staleness.** That number is what made me confident, and it was worth nothing: every one of those refs was frozen at the same 18:39 fetch, so I searched one snapshot from 129 angles and counted it as 129 pieces of evidence. And `e9aa432` is reachable only from `origin/main` (its source branch was merged and cleaned up), so the single ref that could ever have shown me this was the one that was stale. The breadth was decorative.

**Three layers, and only the first is fixed by refetching.**

1. The ref was stale.
2. I turned "my search found nothing" into "it does not exist", with no positive control on the search and no date on the evidence. **An absence claim needs proof the instrument could have found the thing.**
3. When the owner corrected me, I treated it as a misunderstanding to re-explain rather than as evidence my premise was wrong. They were looking at the running product; I was looking at a cache. I ranked the cache higher, twice more.

**This failure class is already in `CLAUDE.md` twelve times** — *an empty result is not a diagnosis*, *a 404 is not proof a file is missing*, *a 401 is not proof a route exists*, *a signal that cannot distinguish two states is not evidence for either*, and at line 30, four days before this, ***a grep bounded to one file is not a search***, recorded about me reporting a route as uncalled when it was called from `admin-hub.html:2102`. So the cause is not ignorance of the rule. It is that the rule is written as a rule about **code** and I did not apply it to **a claim made to the owner**. The rule that was missing: before claiming something is absent, run the same search for something known to be present — if the control does not come back, the instrument is broken rather than the codebase. And date the evidence out loud, because "not on `main` as of my fetch yesterday at 18:39" invites a refetch where "not on `main`" invites agreement.

*A stale checkout answers confidently and wrongly, and nothing about the answer reveals which it is.*

## Why a client cannot receive one

`POST /api/caregiver/broadcasts` is the only way to post (`routes/staffPortal.js` says so in its own comment). Its recipient filter ends in `announcements.visibleTo(row, accountTypes.accountTypeOf(u), u.id)`, and `visibleTo` opens with:

```js
if (!row || row.active === false || !STAFF_TYPES.includes(type)) return false;
```

So **a client is excluded by the account type on their record, not by which boxes were ticked.** Ticking "Everyone on the team" cannot reach one. Two further layers sit above it: the composer offers only staff roles, and `parseAudience` refuses a named recipient who is not staff (`AUDIENCE_PERSON_UNKNOWN`).

It sends through `queueNotification`, so it inherits the unsubscribe check, the dedupe, the retry and the delivery record — unlike the twelve raw `sendEmail` calls the 2026-11-09 audit flagged. The poster is excluded from their own announcement, and the route's `emailed` count already reads `!q.skipped`.

**Proven over real HTTP against a running app**, not by reading: an all-staff post with an active client on the roster queued 2 notices, both to staff accounts, with the client's address absent and the poster's absent; naming that client directly answered `400 AUDIENCE_PERSON_UNKNOWN`.

## The guard, which is the only thing that was missing

`accountTypes.js` carries `ACCOUNT_TYPES[].staff` (nine `true` today). `staffAnnouncements.js` hand-writes `STAFF_TYPES` (the same nine). **They agreed, and nothing checked that they would keep agreeing.** Two lists for one idea drift, and the drift is silent in both directions.

The new test in `test/staff_announcements.test.js` **derives one from the other** rather than restating either, in the sweep style of `test/email_copy.test.js`, so a tenth role is covered the day it lands. It asserts three things, and the third is not implied by the first two:

1. `STAFF_TYPES` equals the `staff: true` values.
2. No `staff: false` type appears in `STAFF_TYPES`.
3. **`visibleTo` actually refuses each non-staff type** on an all-staff row.

Point 2 exists because equality alone would still hold if somebody flipped `client` to `staff: true` in *both* files. **Mutation-checked all three ways and each was caught:** a tenth staff role added to `accountTypes.js` only; `client` promoted in both files at once; and the `STAFF_TYPES` check deleted from `visibleTo`.

The drift **fails closed today** — a new staff role would silently receive nothing rather than a client receiving something — which is why this is a guard rather than a fix.

## Two honesty fixes on the client announcement board

Separate feature, separate screen, and it *cannot* cross over either: `POST /api/announcements` filters `u.role === config.ROLES.CLIENT`, so it only ever reaches clients and never staff. But:

- **Its form said "Create New Announcement" and named nobody.** It emails every active client, and `targetAll: targetAll !== false` means an omitted field is *everyone*. The heading now reads **Post a Client Announcement** and says in words that it goes to every client and never to the team, with a link to the staff board.
- **The count overstated, every time.** `queueNotification` answers a **truthy** `{ skipped: true, reason }` for somebody unsubscribed, deactivated or holding a placeholder login, and the loop did `if (result) queued++`. It now reads `!result.skipped` and counts the skips separately, because *"5 of 6, 1 unsubscribed"* is the sentence somebody needs. Measured on a seeded roster: `{queued: 5, skipped: 1, total: 6}` where it previously would have claimed 6 of 6 — and the stored `skipped: 1` is itself the proof the old branch counted that person as sent.
- **The figure was stored and shown on no screen at all.** Each posted announcement now carries "emailed N of M clients", with the skip count when there is one.

## One real merge decision, recorded rather than resolved by picking a side

Bringing `main` into the email-library branch conflicted in the care-plan provider co-sign route: both sides add a notification at the same point. They are not alternatives — **mine tells the authoring RN their plan was co-signed, main's tells the client it is ready to sign.** Both now fire, each keeping its own guard (never the signer themselves; never a client who has already signed that version). Taking either side alone would have silently dropped somebody who was waiting.

The merge also tripped my own staleness guard in `test/email_copy.test.js`: `care_plan_ready` arrived from `main` and was neither editable nor on `NOT_YET_EDITABLE`, so the build failed until it was claimed. That is the guard working as designed, and the reason it was written before the registry was populated.

## Verified

- Full suite **3757, 0 failing** (1 skipped, pre-existing)
- 3 of 3 mutations on the new guard caught; both touched files confirmed restored afterwards
- `public/admin-hub.html` compiles through the repo's own Babel
- App boots; `scripts/verify_notification_audit.js` **31 passed, 0 failed, 16 skipped** and `scripts/verify_email_library.js` **29 passed, 0 failed** against it
- The client-exclusion claim and the corrected count were each driven over real HTTP and read back from the stored row, never inferred from a status code

## Open for the owner

1. **The five-minute check, if you want it from your side.** Post a one-line announcement from My GFC with a single role ticked, wait 15 minutes for the queue to drain, then open Admin hub → Notifications → History and filter to announcements. Every recipient address is listed; only the staff you ticked should appear.
2. **Two announcement boards is the real awkwardness, and it is a product question, not a bug.** The Admin hub's own Announcements tab is already just a pointer to My GFC, but the Client Portal Management one is a live second composer with a similar name. Say the word and the client board can be folded into one screen with an explicit "who gets this" choice.
3. **Nothing here touched the audit's remaining 52 gaps** or the ~42 notices still holding their wording as literals.
