# Clinician onboarding, credentialing and privileging

Owner request, 2026-11-05/06: *"I need us to create a version of this welcome packet wizard for our clinicians… I need this to be built and available in two hours CLEAN. So need to be thorough."*

Built from three owner-authored documents, all three treated as normative:
`GFC_Clinical_Onboarding_Playbook_v1.md` (items and gates),
`GFC_NP_Training_Library_v1.md` (modules), and
`GFC_Wizard_Resource_Map_v1.md` (documents and Drive links), plus
`GFC_Clinical_SOPs_Set1_v1.docx` for the check questions.

## What this is, and how it differs from the caregiver packet

The caregiver welcome packet is a fixed nine-section form plus a PDF reader. **This
is not that.** The clinician track's centrepiece is a **composition engine**: four
inputs → the item library → a checklist, rebuilt every time the inputs change. The
playbook says so in as many words, and it is why almost none of the caregiver
packet's PDF machinery carried over — there is no single printed clinician packet to
scan, each of the 118 items is its own proof document with its own owner and expiry.

What did carry over: the derived-never-stored checklist, the served-catalog rule (the
page names no vocabulary of its own), the gate shape, the override-with-a-reason, and
the Drive document store.

## Things a later session must not undo

- **⚠️ NOTHING IS STORED BUT THE INPUTS AND THE ITEM STATES.** No checklist is ever
  persisted. Tick a lane and that lane's items appear; untick it and its OPEN items
  disappear while COMPLETED ones stay in the record, because what somebody actually
  did is a fact and un-ticking a box does not undo it. Proven both ways in the probe.
- **⚠️ A GATE HAS NO SECOND LIST OF ITS REQUIREMENTS.** A gate's requirements ARE every
  applicable item whose `gates` names it. Writing them out twice is how a gate and a
  checklist start disagreeing about what is outstanding. Build-enforced: a gate may
  declare `requiresGates` and `appliesWhen`, never `requiresItems`.
- **⚠️ ELIGIBLE IS NOT OPENED.** A gate becomes eligible when its requirements are met;
  it is OPENED when a person signs it, which stores who signed, what had cleared and
  the approved scope. The playbook calls that record the credentialing committee
  decision, so "requirements met" must never be treated as "approved to work". What
  cleared is **frozen onto the event**, not recomputed, or an item expiring later
  would rewrite a past decision.
- **⚠️ A GATE THE INPUTS DO NOT CALL FOR IS ABSENT, NOT OPEN.** Without `appliesWhen`, a
  gate with no applicable items reads "every requirement met" and comes back eligible
  on an empty list — an NP was briefly shown the physician's own G-MD as eligible with
  nothing behind it. This is also what keeps a future executive assistant from ever
  seeing a Board or protocol gate.
- **⚠️ G2 DEPENDS ON A DIFFERENT PERSON'S G-MD.** The one cross-person gate in the app.
  Supervision is a **link between people**, not a field: the supervisor must be
  somebody whose own track carries the physician role, refused by name otherwise
  (`SUPERVISOR_NOT_PHYSICIAN`), or the parent gate could never open and nobody would
  know why. When his gate is not open, hers names him.
- **⚠️ THE APP VERIFIES NOTHING, AND MUST NEVER PRETEND TO.** No connection to Nursys,
  NPPES, NPDB, OIG, SAM, CAQH, PECOS, the DEA or any board. Every verified item stores
  WHO checked it, against WHICH source, on WHAT date, with the dated proof attached; a
  `verifiedAt` older than the item's cadence is what reopens it. Build-enforced: no
  module may `fetch` or name a verification host as a request. This is the fax
  requisition rule (*the app generates, a person transmits*) applied to credentialing.
- **⚠️ A CLINICIAN CANNOT VERIFY HER OWN LICENCE.** Her own route marks an item
  SUBMITTED, never COMPLETE, on anything with a primary source — recording her say-so
  as a verification would put an unchecked fact behind a gate. Office items are refused
  to her by name (`ITEM_NOT_YOURS`), and credentialing is gated on admin-or-manager
  rather than clinical write, so a provider can never sign their own gate open.
- **⚠️ PRIVILEGES CAN BE NARROWER THAN THE PROTOCOL AGREEMENT, NEVER BROADER.** Granting
  something the agreement does not carry is refused by name, not silently ignored. A
  narrowing requires a reason. Joint injections are **listed and withheld by default**
  (the playbook's own rule): a privilege absent from the list reads as an oversight,
  one listed and withheld is a decision somebody made. Nothing parses the agreement —
  a person records its allowances, because a wrong guess here grants something no
  physician agreed to.
- **⚠️ ENFORCEMENT OF PRIVILEGES IS DELIBERATELY NOT WIRED.** `capabilityMap()` returns
  the capabilities a list implies, and `clinicalRoles.can()` is the single function all
  28 capability checks funnel through, so switching it on is one intersection in one
  place. **It is left off pending one owner decision** (below). Build-enforced that
  `clinicalRoles.js` does not read the privilege list yet, and the reason is recorded
  in `clinicianPrivileges.js` so a later session does not read it as an oversight.
- **⚠️ NO EXISTING CLINICIAN LOSES ANYTHING.** A clinician with no onboarding record is
  listed on the roster as "not set up" — never as "nothing done" — and nothing about
  their access changes. The banner names them, the same shape as 4.8's role-confirmation
  banner, because a console line is not where an admin works.
- **A SIGNATURE RECORDS THE SERVER'S VERSION, NOT THE BROWSER'S.** A page that could
  post its own version label could stamp a signature onto text nobody saw. Staleness
  is judged on the **version label alone**, never Drive's modified time: a typo fix
  changes the modified time, and re-prompting a whole team over a comma is how
  signature prompts start being clicked through without reading. The modified time is
  still recorded, because it says which exact text she saw.
- **A DOCUMENT THAT WILL NOT OPEN NEVER BLOCKS THE WIZARD.** It reads "Ask Bianca or
  Kate for access" and is flagged for the office. A policy document nobody has shared
  yet is an access problem, and stopping onboarding over it would strand her on a
  screen she cannot pass. A document with **no link at all** is declared and
  unavailable rather than omitted — hiding the row hides the gap.
- **NO CONTRACTOR IS NAMED IN THE ITEM LIBRARY.** The contractor is a field on the
  inputs; its requirements attach to that field and its documents carry a `contractor`
  tag. Build-enforced, so nobody reads another contractor's handbook.
- **EVERY CHECK QUESTION IS COPIED FROM A WRITTEN SOP.** 38 questions from the eight
  SOPs in Set 1, each carrying its manual reference. Build-enforced that a question
  without one fails the build. **24 modules carry no questions yet and are FLAGGED as
  a gap**, never as modules that happen to be easy. Checks run as *think, then reveal,
  self-scored*: the SOPs give a scenario, the right answer and its manual reference but
  no wrong answers, and writing plausible wrong answers to clinical questions is not
  something to do without the Clinical Director reading them. `options` is honoured the
  day real distractors are written.
- **A MISSED CHECK-BACK CLEARS THE COMPLETION.** That is the retention mechanism, not a
  score to file away. Check-backs fall on day 3, 10, 30 and 90 from completion.
- **GUSTO IS STILL THE SYSTEM OF RECORD for payroll paperwork and nothing transmits to
  it.** Build-enforced across the items, the routes and the page.
- **THE PAGE NAMES NO VOCABULARY OF ITS OWN.** Every role, relationship, lane, add-on,
  item, module, document and privilege is served by `/api/clinician-onboarding/meta`,
  which also answers **who is asking** — `/api/gfc/me` is the client and family surface
  and refuses every other role, and reading the role out of the browser's stored login
  would mean one narrowed this morning keeps its buttons until the next sign-in.
- **CLINICIAN-ONBOARDING ROUTES ARE PHI-AUDITED.** The collections are registered
  `phi: false` (employment and credentialing data about staff, not patient data) but a
  credentialing file carries an NPDB report, a DEA registration, immunization and TB
  results and a home address, so every request writes a durable audit row.
- **TWO SIGNATURE ROUTES ARE BLOCKED WHILE ACTING AS SOMEBODY ELSE** (`impersonation.js`):
  signing an onboarding document, and co-signing a privilege list. Caught by the
  existing build guard, which is what that guard is for.

## What it covers

118 items across 20 blocks · 8 gates (one per payer for billing) · 41 training modules
in 5 phases · 22 documents with their Drive links · 37 privileges in 10 categories ·
the recurring compliance schedule, which starts only once the first gate is open.

New files: `clinicianOnboarding.js` (vocabulary), `clinicianItems.js` (the library),
`clinicianTrack.js` (composition and gates, the one entry point), `clinicianTraining.js`,
`clinicianResources.js`, `clinicianPrivileges.js`, `routes/clinicianOnboarding.js`,
`public/clinician-onboarding.html` served at `/onboarding`.

## How it was verified

- **51 unit tests** in `test/clinician_onboarding.test.js`.
- **64 live assertions** in `scripts/verify_clinician_onboarding.js`, through the real
  HTTP routes, every one reading a stored value back rather than checking a status code.
- **17 render checks** in `scripts/verify_clinician_onboarding_render.js`, driving the
  real page in Chromium as a clinician (1440px and 390px) and as the office.
- **33 of 33 mutations confirmed to fail a test** — 23 against the unit file, 10 against
  the probe (the route behaviours, which a source scan cannot prove are reached).
- Full suite **3112 passing, 0 failing** (1 skipped, pre-existing).

**Three things the verification caught that reading could not:**

1. **An NP was shown the physician's own gate as eligible**, because a gate with no
   applicable items has every requirement met. Fixed with `appliesWhen`.
2. **An office account landed on its own empty track**, with the roster one click away
   and nothing saying so. Found by rendering the page as an admin. No source test could
   have caught it.
3. **Two of my own assertions could not distinguish the states they were testing** — a
   module's `status !== 'complete'` also matches `'redo'`, and comparing two counts
   passes when both are zero. Both strengthened rather than recorded as catches. A third
   guard was line-based and could not tell a route whose middleware wrapped onto the
   next line from an ungated one; it reads structurally now, and is mutation-checked.

**And one harness failure worth keeping:** the first probe mutation sweep reported
0 of 10 caught. `pkill -f "PORT=NNNN"` matches nothing, because PORT is an env var and
never appears in argv, so every probe ran against an unmutated server. The sweep kills
by PID on a port of its own now. *This is the third time this repo has paid for that
exact trap* (Session 4.8 twice). A sweep that catches nothing is a broken harness
before it is ten real gaps.

## Open for the owner

1. **⚠️ THE ONE DECISION THAT BLOCKS PRIVILEGE ENFORCEMENT.** A clinician with no
   privilege list would be refused on the day it is switched on, and every existing
   clinician is in that position. The recommendation on the record: **default open for
   anyone already working, closed for anyone added afterwards**, with the banner naming
   who still needs a list signed. It is one intersection in `clinicalRoles.can()` once
   you say yes — an access-control decision, not a build detail.
2. **⚠️ THE PROTOCOL AGREEMENT TEMPLATE** (playbook §3.5 item 1) is still not written in
   the privilege categories. Until it is, somebody maps its allowances by hand on the
   privileges screen. The mapping works; it is one more place a person has to be careful.
3. **What happens to the NPs when the physician's paperwork lapses.** As built, his gate
   recloses and their G2 stops being eligible, and the screen names him. Nothing already
   recorded is undone. Say if you want them actively notified.
4. **Drive sharing, from the resource map's own open list:** share `06 People /
   Onboarding Library` and `01 Company / Current` with Godwins Family Care as Viewer;
   switch the new README off anyone-with-the-link; convert the Clinical P&P to a Google
   Doc; **upload Clinical SOPs Set 1 and fill in RES-09's link** (it is the only required
   document with no link, and CLIN-16 depends on it).
5. **24 training modules need their check questions written.** The admin Training tab
   lists exactly which. The eight SOPs in Set 1 supplied 38 questions; the rest follow
   as the SOPs are written.
6. **Internal owner roles are not yet mapped to people** (playbook §3.5 item 5). Items
   carry an owner role — Credentialing Owner, Clinical Director, Executive Director,
   Supervising Physician — and the screen shows the role. Mapping roles to names is a
   settings screen that does not exist yet.
7. **The Manual says "Supervising Physician" and the playbook now matches it.** The
   earlier draft's correction to "Delegating Physician" for Georgia was dropped in
   v1.0, so the app uses Supervising Physician throughout. If Georgia wording matters,
   it is one label change in `clinicianOnboarding.js` and the Manual.
8. **Nothing is live until the container is rebuilt.** `git pull` alone changes nothing.

## Merging main in (same day)

Main moved eighteen screens' worth between branching and the PR, and this repo
has **no CI at all** (no `.github/workflows`), so merging it in and running the
suite locally is the only check there is. It caught one real thing:

**The new orphan-route guard (`test/no_orphan_routes.test.js`, PR #250) failed on
`GET /api/clinician-onboarding/admin/:userId/events`** — the credentialing
history route had no screen calling it. That is the exact defect this repo keeps
paying for (the facility-assignment route, `acknowledgeAbnormalResult`, the MFA
reset button), and the guard's own words are right: a capability nobody can
reach is not shipped. **Wired to a History tab on the office detail view rather
than allowlisted**, because the append-only record of who signed a gate open and
what had cleared is precisely what an auditor asks for, and it was unreadable.

After the merge: suite **3201 passing, 0 failing** (1 skipped), HTTP probe 64/64,
render probe 17/17.

## No item assumes the reader's gender (same day)

Screenshotting the clinician's own view found wording nothing else would have:
**"Malpractice cover confirmed for HER actual scope", shown to that clinician on
her own screen, about herself.** 26 strings in all. The playbook is written about
one named clinician, so the wording arrived gendered — but these items are
generic: the same row is read by the clinician it is about, by the office, and
by the physician, whose own track uses the same library.

All rewritten to they/them, and **build-enforced**: no `title`, `detail`, `proof`
or `requiresWhen` in the item library, the training library or the privilege list
may carry a gendered pronoun.

The guard immediately earned itself. My own first sweep was a case-SENSITIVE
grep, so it fixed 18 strings and silently missed 8 that began with a capital
"She", "Her" or "He". The guard named the first one, and a case-insensitive
sweep found the rest. *A search that cannot see half the matches is not evidence
that the rest are clean.*
