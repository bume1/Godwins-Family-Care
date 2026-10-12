# Every email a patient receives, revised (owner-directed, 2026-10-12)

Owner: *"Lets revisit email notifications that go to patients as of current, what is the list. and the templates? We need to revise"* — then *"Revise all."*

**Seventeen notices reach a patient.** They were inventoried by rendering each one through the real notifier, never by reading the source: a defect in an email is only visible in the delivered message. Six things were wrong, and all six are fixed.

## The list, for the next session that asks

Enrollment and documents (7): welcome · documents needed · document reminder · document accepted · document rejected · enrollment follow-up · enrollment approved.
Clinical visits (7): booked · rescheduled · cancelled · day-before reminder · video join nudge · visit summary ready · result reviewed.
Caregiver visits (2): confirmed · rescheduled (plus a bulk variant for several at once).
Messaging (1): a new care-team message.

A designated POA gets all of them. Non-POA family get none.

## What was wrong, and what must not be undone

- **A REMINDER SUBJECT READ "tomorrow at Wednesday, October 14 at 9:00 AM".** `when` is the whole date and time; dropping it after a sentence that has already said "at" is not a sentence. Both reminders now take a separate **`timeOfDay`** ("9:00 AM"), derived by `visitReminders.timeOfDayFor` from the row's **own** `visitDate` and `startTime` — no second snapshot and no calendar read, which is what keeps a background send possible under per-clinician auth. **With no clock time to hand the subject names NO time** rather than printing the long form; the When line carries it in full either way. The video nudge was worse, since it fires half an hour out.
- **AN OVERRIDDEN APPROVAL CONTRADICTED ITSELF IN TWO ADJACENT PARAGRAPHS** — "approved and complete, everything we needed is on file", then "a few items are still outstanding". The first was untrue. An override and a clean approval are different news, so they are **different emails** (different subject, different opening) rather than one with a caveat stapled on.
- **A REASON ARRIVED UNLABELLED.** The callout gets its visual separation from a cream panel and a gold rule; the TEXT half has no panel, so "The photo is too blurry to read the expiry date." landed as a bare paragraph reading as though it had wandered in. `renderGfcEmail` takes **`calloutLabel`** now and renders it in both halves: *Why we need it again* · *Why it was cancelled* · *What we need* · *What still needs you*.
- **TWO "RESCHEDULED" NOTICES WERE NEARLY THE SAME SUBJECT.** "Your visit has moved to …" (the clinician) and "Your care visit has been rescheduled" (the caregiver shift) told a client a visit had changed and left them to guess which. They are **"your clinician visit"** and **"your caregiver visit"** now, and that distinction is load-bearing rather than cosmetic.
- **THE TWO CAREGIVER-VISIT NOTICES WERE HAND-ROLLED IN `routes/scheduling.js`:** one bare sentence each, no headline, no When line, and **sent to the client only**. Beside the fourteen in `notifications.js` they read as though a different company had sent them, and a POA managing someone's care was never told their caregiver visit had moved. They are `notify.caregiverVisitConfirmed` / `notify.caregiverVisitMoved` now, so the recipient rules, the unsubscribe honour, the house template and the transport-detail rule come from one place. **The bulk variant (several visits at once) keeps its own shape** — it is about a set, not one visit — and only its wording was brought into line.
- **`notify` REACHES THE SCHEDULING ROUTER AS A GETTER**, because the notifier is built far below where the router is registered and would otherwise be in its temporal dead zone. **A missing notifier is LOUD** (`console.error`, named) and never throws: these notices are best-effort and must not undo a shift edit, but a wiring slip that quietly stops telling clients their visit moved is the exact class of failure this repo keeps paying for. Build-enforced both ways.
- **The welcome email's TEXT half was still the lab-era wording** while its HTML half has gone through the house template since PR #81 — two halves of one email disagreeing. Aligned. Its claim that the reader will be asked to choose a password was **checked against the code** (`requirePasswordChange` is set at creation and gated in `login.html`) rather than assumed, and is true.

## A seventh, found by the owner asking whether a patient is emailed when we message them

They are, and **four of the five channels a patient can be on sent them the STAFF notice.** Driven through the real router: a patient on Support, Clinical Escalation, Admin Direct or Care Coordination got a subject reading **"Clinical Escalation — Ada Bell"** and a body telling Ada that somebody had *"sent you a message about Ada Bell"*. Three things wrong and the channel name was only one: it talks about the reader in the third person, it puts their name and the nature of the conversation in a subject line anyone glancing at the inbox can read, and **it was not marked as PHI**, so it would send on a transport outside the BAA.

The patient-facing wording had been wired to `care_team` alone. It now covers **every client and family recipient on every channel**, names no channel and no sender, and lands them on Messages rather than the portal home. One test drives the shipped router across all five channels; three mutations each confirmed to fail it.

**Still open, and it is the staff half of the same notice:** a staff recipient's message email carries `"<channel> — <client name>"` in the subject and is **not** marked `phi`, where every other staff notice in `notifications.js` gates its detail on the live transport (`phi: detail`). That is an inconsistency worth closing, and it changes what staff receive rather than what a patient does, so it was not changed here.

## One real bug the verification found, which reading could not

`sendToClientSide` rewrites a leading "Your visit" to "<client>'s visit" so a POA is told whose visit it is. That is **ordered alternation**, and with `visit` leading, the new "Your caregiver visit" **never matched** — a POA read "Your caregiver visit has moved" about a visit that was not theirs. The longer phrases come first now. Found by rendering the POA's copy; every test passed either way until one was written for it. The confirmed notice also opened with the caregiver's NAME, so the rewrite had nothing to reach; it opens with the phrase instead.

## Verified

- **14 new tests** (13 in `test/notifications.test.js`, every one **rendering the notice** and reading the delivered body back; one in `test/shift_editing.test.js` driving the real route). **23 mutations, each confirmed to fail one.**
- **Two of my own mutations did not fail a test on the first pass, and both are recorded rather than waved through.** Reverting the welcome email's TEXT half survived, because nothing had ever asserted it — the guard that now exists checks both halves carry the same sentences and the same credentials. And disabling the caregiver-confirm notice outright survived, because the only thing covering it was `scripts/verify_scheduling.js`, which is **not part of `npm test`** — *a notice nothing asserts is a notice that can be switched off in a refactor and nobody finds out.* A behavioural test now drives the accept route and reads the client's email back.
- **One mutation was a harness error, not a catch:** its find string was a variable name I had renamed an hour earlier. The harness reports a replace that changes nothing as an error precisely so a no-op cannot be mistaken for a surviving mutation.
- **Three existing tests failed and each was handled on its merits.** Two had pinned the old behaviour and were **repointed, not patched to pass**: `visit_reminders` A5 asserted the broken subject verbatim (*the assertion encoded the defect*, the same shape as the 14:00Z availability fixture on 2026-09-16), and `patient_publish` 9e asserted the POA rewrite's exact **regex source**, so widening it failed a test about a rule that had not changed — it now RUNS the rewrite over every permitted opening phrase, which is stricter. The third caught a **real** break: `shift_editing`'s harness did not inject `notify`, so the client notice silently vanished. The harness builds the real notifier now — *a harness that omits what production supplies exercises a different function*.
- Full suite **2250, 0 failing** (1 skipped, pre-existing). `scripts/verify_scheduling.js` **251/251** through the real HTTP routes, which is where the confirm notice is proven end to end. The app boots and `/scheduling`, `/portal` and `/healthz` all serve.

## Open for the owner

- **The welcome email carries a temporary password in plaintext.** This pass revised its wording and deliberately did **not** change how the credential is delivered: a set-your-own-password link would reuse the token flow `password-reset.html` already has, but it changes how everyone signs in for the first time and is a decision rather than a copy edit. Worth doing; say the word.
- **The caregiver-visit notices now also reach a designated POA.** That is new, and it follows from the 08/2026 rule that a POA is client-equivalent. Say if a POA should not hear about caregiver visits.
- **A booked visit now says "a reminder will reach you the day before."** True for every visit the app books; a visit created straight in OpenEMR's calendar gets no reminder (the operating rule Session 4.11 recorded), so that sentence would be wrong for one of those.
