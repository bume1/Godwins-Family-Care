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

---

## Addendum, same day — the front door, and what she is never shown

Owner, after reading her own screens: *"I do want to make sure the wizard is as
clean as the home care version i.e. the welcome banner and branding etc. and
make sure they don't see tags or labeling they shouldn't like 'questions not
written yet'"* — then, on a screenshot: *"it should only include Thanmayie
contact information and title/role. Not this POS, diagnosis code etc."*

### A welcome, not a form

`OnboardingHero` is the caregiver welcome packet's `PacketHero`, same mechanism
and the same CSS block: photo on navy under a navy gradient, gold rule,
Cormorant headline, greeted by first name. **The two front doors into this
company should not look like two different companies**, and a test asserts the
selectors still match the ones in `caregiver.html` rather than having drifted.

**THE PHOTO IS ONE FILE**, `/banners/banner-clinician.jpg`. Replacing it
changes the hero and no code moves; a missing file leaves navy and a readable
headline rather than a broken page. It ships as a **placeholder** copy of the
caregiver banner, recorded as such in `public/banners/README.md` — the intended
photo is a nurse practitioner on a home visit.

It renders on **her own view only**, in both of its states — including day one,
before the office has built her track, which is exactly when somebody needs
welcoming. The office looking at somebody else's record is doing credentialing
work, not being welcomed, and a test asserts `OfficeDetail` never draws it.

A real cosmetic bug went with it: `header.top` reuses the shared `.wrap`, which
carries 72px of bottom padding for the page body, so the navy bar rendered 72px
taller than its own content. **The CSS reads perfectly well; only looking at it
shows the band of dead colour.**

### ⚠️ WHAT A CLINICIAN READING HER OWN SCREEN IS NEVER SENT

Not secrets — the office's own working notes, which on her screen read as
somebody else's admin tool in the middle of her onboarding:

| field | what it is |
|---|---|
| `proof`, `verify`, `alsoVerify` | what evidence the office files, and the primary source it is checked against |
| `ownerRole`, `ownerRoleLabel` | the internal role that owns it — "Credentialing Owner" tells her nothing she can act on |
| `gates` | raw gate codes. `Blocks G0` is a sentence about our data model |
| `checksMissing`, `feedsGate` | **OUR** content gap: a module whose check questions are not written yet, plus the backlog count |

**FILTERED ON THE SERVER, NOT HIDDEN IN THE PAGE** (`forClinician`), the same
read-time rule `patientPublish.js` follows. A field she is never sent cannot be
rendered by a pill a later session adds. The page guards on the audience too —
two layers, so a field restored to her payload still does not render.

**It is a DENY list on purpose.** A field added to an item next session reaches
her by default and is dropped only deliberately. An allow list would silently
hide new work from the person doing it, and that failure is invisible: she
simply never sees the item's instructions.

**`assemble` decides, so a call site cannot forget**, and `audience` defaults to
`'clinician'` — the narrower one. A route added later that forgets to say shows
the office slightly too little, which somebody notices and fixes, rather than
showing a clinician the credentialing file, which nobody notices at all.

The deep copy is load-bearing: `rows`, `byPhase[].modules` and `upNext` are the
**same objects** in the builders' output, so stripping one in place would strip
the others by accident — and a guard resting on that aliasing is a guard a
refactor is free to break.

### THREE MORE SENTENCES WRITTEN ABOUT HER, SHOWN TO HER

Same class as the gendered-pronoun sweep earlier the same day, and all three
found by **reading the rendered screen**, never by reading source:

- `opens: 'Their app and EHR accounts'` → `'App and EHR accounts'`
- `'No supervising physician is linked to this clinician yet.'` → `'...linked yet.'`
- CORE-03's `detail` was our reasoning about why the employment and contractor
  agreements are kept apart. True, not secret, **not an instruction**. It moved
  into a code comment; the detail now says it is its own signature.

Each string is written to work in **either** audience rather than branched: a
branch is two strings that drift, and only one of them gets re-read. Gate
prerequisites are the exception and are sent both ways — `blockedByGates` for
the office, `blockedByGateTitles` for her, so she reads "Waiting on App and EHR
access first" where the office reads `G0`.

### ⚠️ NO CHART DATA ON THIS SCREEN, AND THE OLD GUARD WAS WRONG IN KIND

The render probe asserted `!/place of service|patient/i` **after carving out
"Patient visits"** — the G2 gate's own title. The welcome copy ("get you seeing
patients") was about to need a second carve-out. **A guard that needs a growing
exception list is testing the wrong thing.** It now matches the vocabulary of a
patient RECORD — place of service, POS, MRN, DOB, date of birth, diagnosis,
ICD, CPT, chief complaint — which is the actual risk, names which words it
found, and was mutation-checked by injecting a chart line into the page.

### Verified

61 tests in the file (3212 in the suite, 0 failing); **17 of 17 mutations each
confirmed to fail a test**, 0 harness errors — the strip disabled, the default
audience widened, each hidden field restored, the deep copy removed, the gap
pill put back on her card, every office-only row unguarded, gate codes shown to
her, the third-person wording restored, the gate titles dropped, the hero
removed from her day-one state and added over somebody else's credentialing.
The HTTP probe gained section P, **89/89**, which asserts the fields over real
HTTP on both views of one record (85 modules and 179 rows on every path she
reads) — because a scan of the page cannot prove what the route withheld. Render
probe **38/38** at 1440 and 390, measuring the hero's own bounding rect rather
than reading its CSS.

---

## Second addendum — her documents, and notes either side can send

Owner: *"I want files she uploads to this area as an employee to show up in the
user management client record like how it is for other caregiver records. Can
she attach files or upload files to checklist items? What about update notes,
can she or admin see and send these? For the google drive ones requiring
signature she can download and sign digitally then reupload."*

Four questions. The honest answers before this change were: yes but it never
worked, no, sort of and badly, and no.

### ⚠️ EVERY FILE UPLOAD WAS REFUSED, AND HAD BEEN SINCE THE ROUTE SHIPPED

`detectFileType` returns a **MIME STRING** (`'image/png'`). The proof route read
`sniffed.ext` — `undefined` on a string — so `ext` was always null and every
single upload came back `PROOF_TYPE_UNSUPPORTED`. **The attach-a-file
capability had never once worked.** No source scan could show it; it showed
itself the first time a real PNG went through the real route. *Verify the
behaviour, not the artifact*, again.

### ONE STORE, TWO DOORS

Her proof upload now writes the same `caregiver_documents` row a caregiver's
upload writes, so **the office has one place to look for one person's
paperwork** instead of having to know which door a file came through. The row
carries `clinician_item_id` and a note naming the item (`Onboarding: Nursing
licence — Georgia`), or all thirty of her uploads read "Clinician onboarding
document" and each has to be opened to find out what it is. Its status
**mirrors the item's** rather than inventing a second rule: anything verified
against a primary source lands `received`, so it still reads as waiting on the
office.

**The documents card in User Management sat inside the vendor-only block**, so
a clinician's paperwork was reachable from nowhere on that screen. It now
renders for a caregiver **or** anyone with clinical access, and shows the note.

### A COUNT IS NOT A DOCUMENT

The checklist showed "2 files attached" as plain text with nothing to click —
the office could see that something had been sent and could not read it. **A
capability nobody can reach is not shipped.** Both sides open the file now, and
both go through a route that audits: hers by her own session (no userId in the
path, so there is nothing to widen), the office's through the shared row. A
**plain `<a href>` carries no Authorization header**, so it is fetched with the
token and handed over as a blob — and a PHI-adjacent document's URL has no
business in browser history.

`proofFiles` is an allow-list projection and **`driveFileId` is deliberately
not on it**; `documentId` is, because it is our own row id and the office needs
it to open the file.

### NOTES WERE ONE FIELD THAT SILENTLY CLOBBERED

There was a single `note` string per item. She wrote into it; the office wrote
into it; **whoever saved last overwrote the other with no sign**, and it only
rendered once the item was done. It could never have been the back-and-forth it
looked like. Notes are **append-only** now, each stamped with who wrote it,
when, and which side they are — one handler behind two gates, because a note
that reads differently depending on who sent it is two features. The audit row
records **that** a note was written, never what it said.

### A DOCUMENT TO COMPLETE OUTSIDE THE APP NOW SAYS WHERE IT GOES BACK

The 15 signature documents are **typed-name attestations in the app**, which is
the stronger record: version-stamped from the server's own copy, timestamped,
and impossible to backdate. Download-sign-reupload is deliberately not built
for those. But `COMPLETE_EXTERNAL` resources genuinely do need a file back, and
the list offered no input at all — a dead end. Each now points at the checklist
item that owns it, rather than growing a **second upload path with its own copy
of the byte-typing, the size ceiling and the Drive failure rule**. Two copies of
"what a valid upload is" is how one door starts accepting what the other
refuses. A test fails if a resource needs a file back and no item can take one.

### ⚠️ THE COMMENT STRIPPER WAS EATING CODE

`test`'s own `stripComments` read the `/*` in
`accept="image/*,application/pdf"` as a comment opener and **silently deleted
1,666 characters of real JSX** from `admin-hub.html`, so an assertion about
code inside that window could never pass however correct the code was. A
scanner that loses code proves as little as one that reads a comment as code.
A real opener never follows a letter or digit, so those are hidden from the
comment pass and put back after — and that is now its own test.

### Verified

73 tests in the file; suite **3223, 0 failing**. **23 of 23 mutations caught**
(one survived first — `fromOffice` matched elsewhere in the file, so the
assertion could not distinguish the two states; the test was anchored on the
note object rather than the catch being claimed). Probe **97/97**, render
**38/38**. The document path is **driven with a fake Drive** in the test file —
mounted router, real HTTP, the stored row read back — because Drive is
unreachable from a sandbox; the live probe now reports that half as not
runnable rather than reporting a correct refusal as a failure.

**Not proven here:** a real Google Drive accepting the bytes. Everything
between the browser and Drive is the shipped path.

**A house rule re-bought, twice in one session:** `pkill -f "PORT=3277"` matches
nothing, because PORT is an env var and never appears in argv. Five stale
servers were running and a probe was reading one started before the fix. Kill
by PID.

---

## Third addendum — the owner was right: this was being rebuilt

Owner, watching the document and notes work land: *"so we should not be
building this from scratch tbh"*, then *"in our repo, there was a function for
this in our launch board"*, then *"I just had it hidden for this moment of
needing it to launch new clients, the launch module. Why can't we just use
segments of this for the file upload, front face view vs behind, and so on."*

She is right, and the bug above is the proof. Checked rather than assumed:

### WHAT THE LAUNCH MODULE ALREADY HAD

`POST /api/projects/:projectId/tasks/:taskId/files` — a file attached to a
checklist item, stored in Drive, a pointer appended to the item, rendered as a
paperclip with the filename. **Structurally the same thing**, and it has been
in this repo the whole time. The launch module is **hidden, not dead** — the
owner kept it for launching new clients — so nothing here removes it.

### WHY IT IS NOT LIFTED AS-IS, WITH THE TWO REASONS WRITTEN DOWN

- It validates on **`req.file.mimetype` — the type the uploader CLAIMS** — not
  on the bytes. Fine for a project plan; not for a record that decides whether
  somebody may see patients.
- It hands the browser a **direct Drive link** (`webViewLink`). GFC-era reads
  go back through the app so every one is audited.

Folding them together would have to level the launch board UP to those rules,
which is a decision about the launch module, not a tidy-up. The exclusion and
both reasons are written at the top of `staffDocuments.js`, where the next
person looks, and a test fails if that route disappears or that note does.

### ON "FRONT FACE VS BEHIND"

The launch board does it as two pages over one data set — and **has no
field-level filtering at all**: grep finds no `clientVisible`, no
`internalOnly`, nothing. The public page renders whatever the route sends. The
clinician wizard needs the stronger version, because the office's working notes
must not reach her, which is what `forClinician` does. So the **pattern**
transfers; the mechanism had to be stronger, not reused.

### WHAT WAS ACTUALLY DUPLICATED, AND IS NOW NOT

Not the launch board — the **caregiver document** path, the GFC-era descendant
of that same idea, already shared across three doors. The clinician proof route
had its own copy of the byte-typing, the size ceiling, the Drive upload, the
failure rule and the row shape. **`staffDocuments.js` is now the one copy**,
called by both doors:

- `prepareStaffDocument` — empty, size, byte-typing, safe filename.
- `buildStaffDocumentRow` — one row shape, so the documents card, the download
  route and the review flow read the same fields whichever door a file came
  through.

**The size ceiling is passed in, never a literal there.** The clinician route
had multer's 15 MB while the caregiver route had the app's configured 10 MB —
one door already accepted what the other refused, which is exactly the drift
this collapse exists to end. **The refusal CODE is now the same on both doors
too** (`DOC_TYPE_REJECTED`); prefixing it per door would be two names for one
rule, the duplication moved into the vocabulary.

**`status` stays the caller's judgement, deliberately.** Who may accept a
document on sight is a policy question each door answers for itself — the
office IS the reviewer; a licence is checked against a primary source. The
shape is shared; the judgement is not, and a test fails if the module starts
deciding it.

### Verified

Suite **3227, 0 failing**; probes **97/97** and **38/38**. **9 of 9 mutations
caught**, including either door bypassing the preparer, the preparer trusting
the claimed type, the ceiling becoming a literal, the module deciding status,
and the launch-board route or its exclusion note being removed.

**Two existing guards were REPOINTED, not deleted**, because the rule they
protect moved rather than went away — and the caregiver one got **stricter**:
it now pins that the route delegates, that it hands over the byte sniffer, and
that the shared module never reads a claimed mime type.

**A house rule re-bought a third time in one session:** that last guard read
the word "mimetype" out of the module's own comment explaining why the launch
board is excluded, and failed on the explanation. Strip comments before any
source scan.
