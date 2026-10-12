# The staff "new message" email put a client's name in the subject line

**Date:** 2026-10-12
**Branch:** `claude/staff-message-notice-phi`
**Owner-directed:** yes — follow-on to the patient email revision (PR #170), split onto its
own branch at the owner's instruction.

## What was wrong

`routes/messaging.js` built the staff-side notice by hand, inline, and sent it through
`queueNotification` directly rather than through `notifications.js`. Three defects, all of
them live:

1. **The subject line was `"<channel label> — <client name>"`** — so an email sitting in a
   clinician's inbox read **`Clinical Escalation — Ada Bell`**. A client's name next to the
   words "clinical escalation" is PHI in a subject line, visible on a lock screen, in a
   notification preview, and in any mail client's thread list.
2. **It was never marked `{ phi: true }`**, so `transportAllowsDetail()` was never consulted
   and the name went out whatever the transport was. The whole point of that flag is that
   PHI-bearing mail is **refused** on a transport outside the BAA rather than downgraded —
   this notice opted itself out of that protection by not declaring itself.
3. **"<Name> sent you a message about <Name>."** On a thread the client wrote themselves —
   which is most of them — the body named the same person twice. Found by rendering the
   notice through the real notifier, not by reading the source.

## What it does now

`notifications.staffMessageWaiting()` owns it, beside the other seventeen notices, so it
inherits the house template, the unsubscribe honour, the duplicate-suppression key and the
transport-aware detail rule rather than restating any of them.

- **Inside the BAA:** subject `Clinical Escalation — Ada Bell`, body *"Ada Bell sent you a
  message."* — the staff member needs to know which client and which conversation or the
  notice is not actionable. Marked `phi: true`, which is what makes that allowed.
- **Outside the BAA:** subject `A new message is waiting`, body *"Someone sent you a message
  about a client. … For privacy we do not name the client or the conversation in email."*
  No name, no channel. Marked `phi: false`, because there is nothing in it to protect.
- **The message body is never in the email, on either path.** A notification that carries
  the message carries PHI into an inbox; one that says a message is waiting does not.
- **When the sender *is* the client**, it reads "Ada Bell sent you a message." rather than
  naming them twice.
- **The CTA resolves per recipient** (`links.messagesFor(u)`). Messaging mounts on four
  surfaces — portal, caregiver app, clinician workspace, admin hub — so a single hardcoded
  destination sends three roles out of five to the wrong screen. That rule was already
  settled on 2026-09-16; this keeps it.

**The patient side of this route is unchanged in substance and was fixed in PR #170** — it
no longer gates its wording on the `care_team` channel, so a reply on any client-reachable
channel reads as a message rather than falling through to the staff copy.

## Build-enforced

- `routes/messaging.js` may not re-derive the transport rule itself (N9) — it asks the
  notifier, which reads `emailTransport.transportStatus().baaCovered` at send time.
- A **missing notifier is loud, not silent**: the lazy getter logs
  `'[MSG] no notifier injected — staff were NOT told a message is waiting'`. The notifier is
  built far below where routers are registered in `server.js`, so it is injected as
  `notify: () => notify` rather than directly, and a harness that forgets it would otherwise
  silently test a path where nobody is ever emailed.

## Verified

- `test/staff_message_notice.test.js` — 8 tests (S1–S8), mounting the **shipped router** with
  the **real notifier** on both transports and reading the queued row back. Not a source scan.
- `test/care_team_messaging.test.js` and `scripts/verify_messaging.js` now inject the
  notifier. Both previously omitted it, which is the third time in this repo that **a harness
  missing what production supplies exercised a different function**.
- **9 of 9 mutations caught** — the unconditional client name restored, the PHI marking
  dropped, the uncovered body naming the client anyway, the duplicate-name guard removed, the
  message body carried into the email, the CTA collapsed to one surface, a missing notifier
  made silent again, `server.js` ceasing to inject, and the router re-deriving the transport
  rule.
- Full suite **2266, 0 failing** (1 skipped, pre-existing).
- `scripts/verify_messaging.js` 92 pass / 2 fail — **both failures confirmed pre-existing** by
  running the probe against `origin/main` in a worktree, not assumed.

## Not proven from here

That a real send on the live Workspace transport carries the covered wording. `scripts/verify_email_transport.js`
has still never been run on the deployment — it remains the only thing that proves Google
accepts and delivers, as distinct from the app building the message correctly.
