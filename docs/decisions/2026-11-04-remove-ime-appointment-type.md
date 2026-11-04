# The IME appointment type is removed from clinical scheduling (2026-11-04)

Follow-up to `2026-11-04-ime-forward-schedule.md`, which found the `ime_exam`
appointment type and deliberately left it rather than deleting it as a drive-by.
This is that change.

**Why it had to go (owner, 2026-11-04):** the IME / C&P line stays **separate
from clinical scheduling and billing** — "IME payments will be billed and made to
providers different than standard claims." A vendor pays GFC and GFC pays the
examining provider; that is not a Medicare claim and must not travel through the
clinical billing path. IME scheduling lives in `veteranRoster.js` and the
`veteran_roster` collection, and a veteran is deliberately not a client and not
an OpenEMR patient (2026-10-30).

## ⚠️ IT WAS NOT A DEAD DECLARATION. IT WAS A LIVE, SELECTABLE ROUTE INTO BILLING

The earlier note recorded it as a dead declaration, on the strength of a
whole-word grep of `server.js`, `public/clinical.html` and `clinicalNotes.js`
returning zero hits. **That grep was right and the conclusion was too kind.**
Nothing names `ime_exam` as a literal; it reached the screen **generically**,
through the data flow, and it worked:

- `server.js` serves `SERVICES` and `APPOINTMENT_TYPES` to the clinical page.
- The visit-type picker in `public/clinical.html` renders **one `<optgroup>` per
  service** and fills it from `APPOINTMENT_TYPES` filtered on
  `t.service === svc.key && t.canDocument !== false`.
- `canDocumentType('ime_exam', 'provider')` answered **`{ ok: true }`** — checked
  by running it, not by reading it.

So every provider saw a selectable **"IME / C&P → Exam"** option, and choosing it
opened the H&P screen (`noteForm: 'hp'`) and produced an OpenEMR encounter bound
for coding and billing-submit — the one place this work is not supposed to go.
**Verify the behaviour, not the artifact**, pointed at a previous session's own
finding: a grep for a key cannot see a config consumed by iteration.

## What changed

- **`ime_exam` is gone** from `APPOINTMENT_TYPES` (12 types → 11).
- **The `'ime'` service is gone** from `SERVICES` (4 → 3). **Removing it was not
  optional.** With the type gone and the service left behind, the picker renders
  an **empty "IME / C&P" optgroup** — a heading with nothing under it. The two
  halves had to go together.
- **A comment on `SERVICES` says where IME scheduling actually lives and what
  re-adding either half would re-open.** That comment is the real value of this
  change; the deletion is the easy part.

## What a later session must not undo

- **Neither half comes back.** A new guard asserts the absence as a *route*, not
  as a missing key: `typeByKey` is null, `canBookType` answers
  `UNKNOWN_APPOINTMENT_TYPE`, `canDocumentType` refuses, `typesForService('ime')`
  is empty, no service is keyed `ime` — **and no type may carry
  `specialty: 'ime_examiner'`, `neverMedicare: true` or `service: 'ime'`**, which
  existed only to describe an IME. A bare null check would be satisfied by a
  renamed type that still books.
- **Every declared service must have at least one type, and every type's service
  must be declared.** New, both directions. The first is what makes "remove a
  type and leave its service" fail the build instead of shipping an empty
  optgroup; the second catches a type in a group that never renders.

## Kept on purpose, and said out loud

- **The eight IME note sections stay declared in `SECTIONS`** (`examRequest`,
  `identityVerification`, `recordsReviewed`, `history`, `examination`, `dbqForms`,
  `medicalOpinion`, `reportAttachment`). They are now unused — and **eight other
  sections were already unused before this change** (`reasonForVisit`,
  `intervalHistory`, `medicationReview`, `focusedExam`, `ordersRx`,
  `callParticipants`, `ccmConsent`, `planMedChanges`), so there is no reverse
  guard and nothing fails. They are correct work that Track E will want when IME
  documentation is built in its own lane; deleting them would throw it away.
- **The `imeRecords` and `imeExamRequest` document kinds stay** in
  `GFC_EXPECTED_DOCUMENTS`, `documentTemplates.js` and `documentExtraction.js`.
  A document kind creates no encounter and reaches no claim, so it carries none
  of the risk the appointment type did — and **a filed row carries its kind, so
  dropping one would show a document we hold as missing** (the rule the welcome
  packet's `license_insurance` already bought). Whether they should go is the
  owner's call, not a drive-by. **Open for the owner** below.
- **`test/appointment_types.test.js` had a reverse guard that would have broken
  silently**, asserting those two kinds are referenced by some type's intake.
  Narrowing the loop quietly would have left the catalog unguarded, so their new
  status is now asserted outright: still real catalog kinds, still not
  outstanding, and **requested by no appointment type**.

## Found on the way, NOT fixed

**A PA can book no in-person clinical visit.** A PA is on exactly three types —
`pc_phone_ccm`, `sw_psychosocial` and `sw_follow_up` — so the IME exam was the
only in-person visit a PA could book, and the comment that used to sit in the
psych test ("a PA may do primary care and an IME but not psych") **was wrong about
primary care as well.** Found because my replacement assertion
`canBookType('pc_follow_up', { prescriberCredential: 'PA' })` failed; the code was
right and my test was wrong. The current credential config is now asserted so a
change to it is deliberate. **Whether a PA belongs on the primary-care visit types
is the owner's call and nothing here changes it.**

## Verified

- **Full suite 2909, 0 failing** (1 skipped, pre-existing). Baseline on this
  branch before the change was **2908, 0 failing**; the extra test is the new
  absence guard.
- **8 of 8 mutations each confirmed to turn a test red** — the type and the
  service both restored, the type restored alone, the service restored alone, an
  existing type given `specialty: 'ime_examiner'`, an existing type marked
  `neverMedicare`, a type naming an undeclared service, a type requesting the IME
  document kinds again, and **an unrelated empty service added**, which isolates
  the service-coverage loop from the IME-specific asserts (without it, the loop
  and the `ime` assert fire together and neither is proven alone).
- **The harness fails a mutation whose find string did not actually change the
  file, and it earned that on this run:** two of my first eight anchors were
  wrong — one comment line misquoted, one `specialty: null` anchor that did not
  exist — and both were reported as HARNESS ERROR rather than counted as catches.
  A no-op replace and a surviving mutation are otherwise indistinguishable.
- **One mutation of mine was mis-designed and was replaced rather than recorded as
  a catch:** it neutered the *test's* own coverage loop and then checked the suite
  still passed, which tells you nothing. A test-side mutation has to be paired
  with a code-side break; M8 above is that pairing.
- **`scripts/verify_veterans.js` 36/36** and **`scripts/verify_note_lifecycle.js`
  248 passed / 0 failed**, both through the real HTTP routes.
- **`scripts/verify_soap_note_render.js` 23/23** in real Chromium — the probe that
  maps `SERVICES` into the page catalog, so the picker is proven to render with
  three services and no empty group.
- `appointmentTypes.js` and `server.js` syntax-check; `public/clinical.html`'s JSX
  compiles under esbuild.
- **The environment lesson re-bought, again:** the container had **no
  `node_modules`**, and the suite would have reported dozens of
  `MODULE_NOT_FOUND` failures that say nothing about the code. `npm install`
  first, then a **green baseline before touching anything** — which is also what
  made "2908 → 2909" a meaningful number rather than a hopeful one.

## Open for the owner

1. **Should `imeRecords` and `imeExamRequest` stay as document kinds at all?**
   They are VISIT-scoped, so filing one needs an encounter, and under decision B
   an IME never has one — a veteran is not a client. They are therefore
   unreachable for their stated purpose, not merely unrequested. Kept here
   because a filed row carries its kind and this sandbox cannot see production
   data. Say the word and they come out of `server.js`,
   `documentTemplates.js`, `documentExtraction.js` and the mirror together.
2. **Should a PA be on the primary-care visit types?** See "Found on the way".
