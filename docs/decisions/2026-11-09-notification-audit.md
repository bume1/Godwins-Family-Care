# Every email this app sends, and the 74 places it sends nothing (owner-directed, 2026-11-09)

Owner: *"please update our email template library in-full so we can easily edit ANY email. Infact, audit our emails as of current to ensure notifications go out for key updates or changes."*

This file is the audit half. It is the reference for "what email does GFC send, to whom, and when", and for the gaps. The editable template library is a separate, larger piece and is planned but not built here; the owner's instruction was gaps first, because an email that never sends is worse than an email you cannot edit yet.

**Method.** Every notice was found by reading its call site and then rendering it through the real notifier, never by reading copy. That is how the defects below surfaced: three of them pass every test in the repo.

---

## 1. What exists today

Mail leaves this app through three layers.

| Layer | Where | What it guarantees |
|---|---|---|
| `queueNotification` | `server.js:629` | eligibility (no address, placeholder login, inactive account, unsubscribed), dedupe on type + email + entity, a sent-cooldown, retry, and a delivery record |
| `createNotifier` | `notifications.js` | 38 notice builders, one `send()` choke point, the house template, the recipient rules, and the detailed/vague PHI split |
| `sendEmail` | `email.js:390` | a raw send that bypasses all of the above. **12 live call sites** |

Timers: the queue drains every 15 minutes, the notice scanner runs every 30, to-do reminders every 60 seconds (each to-do at its own minute), and the onboarding sweep rides the scanner.

### Patient and client facing (20)

Visits: booked, rescheduled, cancelled, the day-before reminder, the video join nudge. Portal: visit summary ready, a result reviewed, a new care-team message. Documents and enrollment: a document accepted, a document rejected (with the reason), documents requested, a document reminder, an enrollment follow-up, enrollment approved (two versions, clean and overridden), the enrollment-complete receipt. Caregiver visits: confirmed, rescheduled, and a bulk variant. Billing: a new statement.

A designated POA receives all of them. Non-POA family receive none.

### Caregiver (16)

Shift assigned (direct and batch), shift time changed (four subject variants), shift cancelled in bulk, a visit ended by the office, a change request approved or declined, a shift confirmed, a time adjustment decided, an escalation update, a paystub ready, a tax form ready, a tax form reminder, e-delivery consent withdrawn, an open clock. Plus **the welcome-packet notice, which had never sent** (see §2).

### Clinical and office (22)

A caregiver escalation, a critical result waiting, an internal referral assigned, a staff message waiting, four to-do notices, a care plan co-signed, six staff onboarding and credentialing notices, an enrollment change requested and decided, a time adjustment requested, a shift claimed or declined, a change request raised, three payroll automation warnings to the owner, a client document uploaded, a consent signed, the welcome email, and the admin test email.

---

## 2. Fixed in this change: the ten that were not judgment calls

In each of these the app either states on screen that somebody will be emailed, or refuses to let a person proceed without typing an explanation and then shows that explanation to nobody.

### ⚠️ A notice that had never sent once, and a test that agreed with it

`routes/welcomePacket.js` called `queueNotification` with a **single object** where the signature is positional (`type, userId, email, name, templateData, options`). The object landed in `type`, the recipient address was never set, `recipientMayBeEmailed` refused it, and a refusal is logged as a skip rather than an error. So a caregiver finishing their welcome packet notified nobody, every time, in silence. The comment above the call promised the house template and an unsubscribe honour.

**There was a test.** It asserted `h.notifications.some(n => n.type === 'caregiver_packet_submitted')`, and the harness's fake queue was `async (n) => notifications.push(n)` — a single-argument fake, which is exactly the shape the buggy call used. The fake and the bug agreed with each other, so the test went green on a notice that could never deliver. The harness now builds the **real** notifier and the assertion reads a recipient address back. *A harness that does not match what production supplies exercises a different function* — the fourth time this repo has paid for it.

A build guard now fails if any route in the tree calls `queueNotification` with an object.

### The required reason that reached nobody, five times

The pattern is already written down twice in `notifications.js`. It was fixed for client documents and for onboarding returns and left unfixed elsewhere.

| Route | What it demands | Who now hears |
|---|---|---|
| `routes/caregiver.js` document review | a reason on rejection | the caregiver, with the reason in a labelled panel |
| `routes/onboarding.js` certificate return | `RETURN_REASON_REQUIRED` | the staff member, through the existing `staffOnboardingReturned` rather than a second notice |
| `server.js` client document removal | `docRules.checkRemoval` | the client and POA, **only where the patient could see the document** |
| `routes/payroll.js` contractor invoice reject | a note *"so they can resubmit"* | the contractor, plus a notice when they are paid |
| `routes/caregiver.js` incident close | a follow-up note | the caregiver who filed it |

The caregiver document route's own comment has always read *"the caregiver is told what it was."* It was not.

### The four promises the screen makes

| The app says | Who now hears |
|---|---|
| *"An administrator will reach out to you shortly"* | every active admin. Previously a `console.log` was the only signal, which made self-service reset a dead end |
| *"Our office will review your account and email you when it is ready"* | the office |
| *"We will confirm it and email them their sign-in details"* | the office. The approval leg already emailed; nothing said there was anything to approve |
| a bug report, stored behind an admin-only screen | every active admin, with the report itself only on a covered transport |

### Decisions inside these ten, worth not undoing

- **A removal notice goes only to a document the patient could actually see** (`docRules.patientCanSee` on the row before removal). An office-filed document nobody shared would be news of a file they never knew existed.
- **Approving a contractor invoice sends nothing.** It is an internal step on the way to payment, and the payment is the news. One builder sends two types, the way `documentReviewed` does.
- **A paid invoice carries no amount and no bank reference.** The pay screen holds both.
- **The incident subject never names a client**, covered transport or not, because a subject shows in places the body does not. The follow-up note and the kind of incident ride only where the transport can carry them.
- **A password-reset requester may be a patient**, so their name and address are treated as PHI rather than assumed to be a staff address. Same for a self sign-up.
- **Employment data is not PHI.** The caregiver packet and document notices send detail on any transport, which is the same call the staff onboarding notices made and for the same reason.
- **A second return of the same document is a second email.** The dedupe key carries a monotonic tick, not a bare `Date.now()`: two returns inside one millisecond shared a key and the second was swallowed. Found by a test, and the same weakness in `staffOnboardingReturned` was fixed with it.
- **One definition of who counts as an admin.** `adminRecipients` was inlined in `enrollmentChangeRequested`; three more notices needed it, and two copies is how the two start disagreeing.
- **The notifier reaches three more routers as a getter**, because it is built far below their mount in `server.js`. A missing notifier is loud and never throws: a notice must not undo a review somebody has already recorded.

---

## 3. Also fixed: the twelve where somebody was blocked and not told

Every one of these had a suitable notice built beside it and no wire to the event.

| # | What happens | Who hears now | Note |
|---|---|---|---|
| G18 | **A future shift is cancelled** | the caregiver **and** the client and POA | the largest gap in the app. Bulk-remove emails; single-cancel does not. The holder is told only if the shift was already in progress |
| G19 | A caregiver's claim is declined | the caregiver who claimed it | `shift_change_declined` is the right shape |
| G20 | A client or POA requests coverage | the office | the admin queue is poll-only |
| G2 | A care plan is authored and waits on a client co-signature | the client and POA, and the provider who must sign | `phc_care_plan_cosigned` covers only the reverse direction |
| G3 | A care plan is provider co-signed | the authoring clinician, who is blocked on it | |
| G7 | An internal referral is accepted or completed | the referring clinician | the response says they "can read your note on the order", i.e. find out by looking |
| G9 | An **abnormal** result is filed | the ordering clinician | only `critical` pages anybody. Patient silence here is deliberate; clinician silence looks unintended |
| G16 | A Stripe payment succeeds | the patient (a receipt) and the office | the only billing mail is the statement when it opens |
| G37 | Clinical (IHPC) enrollment is activated | the patient and the care team | the PHC arm emails; this one does not |
| G47/49/50 | An admin resets MFA, deactivates an account, or changes a role or clinical authority | the person | `sendPasswordChangedEmail` is the precedent for exactly this |
| G23 | An admin creates or edits a time log | the caregiver whose hours changed | the approval path emails; the direct edit does not |
| G31 | A document is shared to a patient's portal | the client and POA | they are never told it is there |

### Decisions inside these twelve, worth not undoing

- **A cancelled shift has two audiences and two rules.** The person who held it is told whatever the date, because it is their work and their pay. The **client is told only about a visit still to come**, since "your visit is cancelled" is false about one that already happened. The office's reason reaches the caregiver and **never the client**: it can name staffing, illness or a payment question. The client's notice offers to arrange cover instead.
- **The client's cancellation opens with "Your caregiver visit"** so the POA rewrite reaches it. That rewrite matches the opening words and the alternation is ordered, which has already caused one real bug. Any reworded opening has to stay on the right side of it, and the editable-copy work replaces the mechanism entirely.
- **A declined claim says it is nothing against them.** A decline that reads as a judgement stops people putting their hand up.
- **The time-log notice is deliberately NOT inside `applyTimeLogEdit`.** That shared writer is also the path an approved adjustment request comes through, and that path already emails. Putting it in the writer would send two emails for one correction. Two call sites, build-enforced.
- **A declined claim reads the claimant before the release**, which clears the person. Reading it afterwards would leave nobody to tell, and a test pins the order.
- **An abnormal result pages the ordering clinician and is handed no patient, no value and no interpretation** — the same shape as the critical notice, because a builder that cannot be given a patient cannot leak one. A test asserts the exact argument set.
- **The abnormal notice takes a PATH and builds its own absolute link.** The filing route is lifted out of `server.js` and run by `test/patient_publish.test.js`, where `getAppBaseUrl` is not in scope. The path crosses the boundary; the URL is built in the notifier.
- **The care-plan provider set is resolved in `server.js`**, never in the notifier, which must not restate the clinical role vocabulary.
- **Nobody is told about their own action.** Not the provider who co-signed, not the clinician who accepted their own referral, not an admin editing their own account.
- **Access changes read a snapshot taken before the write.** A shallow read afterwards compares the row to itself, which is the aliasing trap this repo has paid for before.
- **Unsharing a document is silent.** There is nothing for the patient to do about it.
- **An unknown kind of access change, and any referral step that is not accepted or completed, send nothing.** Neither invents wording for a state nobody designed.

### One deliberate omission inside this tier

The audit noted that a Stripe payment tells neither the patient nor the office. The **patient receipt is built**; the office notice is not. Payments are visible on the billing screen, which the office works daily, and an email per payment is the kind of traffic that teaches people to stop reading email. Say the word if you want it.

---

## 4. Not fixed here, and recommended against: the remaining fifty-two

Real gaps, but wiring them all would create mail that trains people to ignore mail. Listed so the decision is yours, grouped by area, with the recommendation.

**Orders (6).** An order placed (non-referral), sent or status-advanced, cancelled, a destination set, an order co-signed, a standing order authored or revised. *Recommend: only the standing-order revision, because a nurse working under a protocol that changed should be told.*

**Encounters and billing (5).** A note voided, coding changed after signing, a claim released or blocked, billing submitted with no charge, an invoice voided or a payment recorded by hand. *Recommend: the voided note and the hand-recorded payment.*

**Scheduling (2).** Availability submitted, availability reviewed. *Recommend: the review, because the caregiver is waiting on it.*

**Incidents and visit logs (2).** An incident filed that does not also route as an escalation, a skilled note landing at `pending_review`. *Recommend both: the first is a reportable event that can currently reach nobody.*

**Documents (3).** A caregiver document uploaded or hard-deleted, a client document moved to a caregiver's file. *Recommend the deletion only.*

**Onboarding (9).** Files and certificates uploaded (only step-shaped submissions notify today), module sign-off recorded for somebody, SOP and training-library changes, a module reviewed against the manual, determinations, recurring duties, not-applicable, expiry, renew, and custom tasks added or removed. *Recommend the file uploads, so the office is not waiting on a screen; the rest reach the person in the daily digest.*

**Enrollment (7).** Status set directly on the user record, a checklist step toggled, marked reviewed, offline enrollment recorded, details edited including the client's own email address, a service line actually applied, POA cutover. *Recommend the email change and the POA cutover: both silently change where a person's mail goes.*

**Accounts (5).** A reset request handled or dismissed, sessions revoked, a user deleted (**the only route in this audit with neither a notice nor an activity-log entry**), a self-signup created. *Recommend giving the deletion an audit entry regardless of email.*

**Payroll (8).** Pay schedule changed, pay setup changed with no approval gate, a contractor invoice submitted, a run drafted or adjusted, I-9 and new-hire reporting, tax tables, a paper tax form marked mailed. *Recommend the pay-setup change: money fields on the user record go to the Super Admin for approval, and the same fields on the payroll profile do not.*

**Veterans and IME (4).** Roster add and remove, status changed, every IME case state, case documents. *Recommend the roster change: being given or losing an exam list is silent.*

**Office (1).** Feedback status or admin note updated. *Recommend against.*

---

## 5. One finding that is not a gap

**Twelve emails bypass the queue**, including the statement notice and both enrollment confirmations, which reach patients and POAs: `server.js:4160, 4215, 4244, 17475, 20983, 21005, 21592, 21745, 31154, 31192, 31351, 31828`. Bypassing it means no unsubscribe check, no dedupe, no retry and no delivery record, which are the three consequences this repo already recorded as the reason the document-request notices were moved onto the queue.

**They cannot simply be moved.** `recipientMayBeEmailed` (`server.js:608`) has no exemption for transactional mail, so a password reset or a confirm-your-email moved onto the queue would be silently swallowed for anyone who ever unsubscribed. The fix is to add that exemption explicitly, honouring the placeholder-login and inactive-account checks and skipping only the marketing opt-out, and then move them. Not done here; it changes how security mail is delivered and deserves its own change.

---

## Verified

- `test/notification_audit.test.js`: **58 tests, 34 of 34 mutations caught** (14 on tier 1, 20 on tier 2). Every assertion renders the notice and reads the delivered subject and body back.
- `test/welcome_packet.test.js`: the harness was **repointed, not patched to pass.** It now builds the real notifier, and the assertion reads a recipient address rather than checking the queue was called.
- Full suite **3612, 0 failing** (1 skipped, pre-existing). `test/patient_publish.test.js` was **repointed, not patched to pass**: its "ZERO notices at filing" rule is about the PATIENT, and an abnormal result now pages the CLINICIAN at filing, so the assertions name the patient-facing notices explicitly and a new one proves the clinician paging.
- `scripts/verify_notification_audit.js`: **31 passed, 0 failed, 16 reported as SKIPPED** over real HTTP, and every skip names the test that covers it. The welcome-packet notice is driven end to end — a caregiver submits, the office is emailed, and every row carries a recipient address, which had never once happened. The seven skips need Drive, an EMR encounter or a hashed token this environment cannot present, and each names the test that covers it.
- The probe asserts the PHI gate **in whichever direction the deployment is in**: with no transport configured a sandbox is not BAA-covered, so it proves the free text and the requester's address are ABSENT. Asserting only the detailed case would fail on a correct app; asserting only the vague case would pass on a leak.
- Two of my own guards failed on their first run and both are recorded rather than quietly fixed: a test scanned my own explanatory comment for the word it was forbidding (*strip comments before any source scan*, the house rule pointed at my own test), and the dedupe-key test caught a genuine `Date.now()` collision in code I had just written.

## Open for the owner

1. **The fifty-two in §4**, with a recommendation against each. Pick any you want wired.
2. **The office half of the Stripe receipt**, deliberately left out above.
3. **The queue bypass in §5.**
4. **The editable template library**, which is the other half of the original ask and is a larger piece: roughly 70 emails, of which 8 are editable today and 2 of those drive a live GFC email.
