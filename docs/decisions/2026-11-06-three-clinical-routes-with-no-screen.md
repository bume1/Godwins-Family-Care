# Three clinical routes nobody could reach

**Date:** 2026-11-06
**Branch:** `claude/clinical-orphan-reads`
**Owner ask:** "Fix all" — the remaining capabilities with a route and no UI.

| Route | What it answers | Callers before this |
|---|---|---|
| `GET …/care-plan/goals/:goalId/history` | every status this goal has ever carried | none |
| `GET …/encounters/:euuid/documents` | what this visit still needs on file | none |
| `PUT …/encounters/:euuid/billing-facility` | who bills this visit | none |

Each was built, tested and left with no caller, so each was a capability
nobody had.

## 1. A goal showed only its latest status

The goal row renders `statusAt`, `statusBy` and `statusNote` — the last change
and nothing before it. So a goal **met in September and lost again in October
reads as though it had only ever been one thing.** The route has returned the
whole trail since the status feature shipped.

There is now a **History** control on each goal beside **Update Status**. It is
a **read** (`requireClinicalRead`), so a case manager gets it while the status
control stays a writer's. Three states, kept apart: loading, no change yet
recorded, and *the history could not be read — that is not the same as this
goal never having changed.*

## 2. A visit's document requirements were recorded and invisible

An appointment type can declare the documents its visits require — a face
sheet, a discharge summary, a referral letter — and the route answers with the
full list, what is filed, and what is outstanding. **Nothing showed it**, so a
clinician finished a visit with no way to see that a document was still owed.

A **Visit Documents** card now sits in the encounter, read-only: filing is its
own route with its own gate. Every label, hint and kind comes from the server,
so the page **names no document kind of its own** and cannot drift from the
catalog that decides them. Files open through the app's own audited url, never
a Drive link. "This visit type asks for none", "no visit type is set" and "the
list could not be read" are three different sentences.

## 3. Nothing showed who bills a visit, let alone changed it

`form_encounter.billing_facility` is the business entity on the claim. The
2026-09-09 split separated it from `facility_id` (where care happened), which
for a home-visit practice are almost never the same record. The override route
has existed since Session 4.5, and **the current value was not even served to
any page** — so the only way to correct a visit billed to the wrong entity was
in OpenEMR by hand.

`billingFacilityId` is now on the encounter detail, inside the same `canBill`
gate as the rest of the place-of-service block, and a **Billing facility** row
sits under Place of Service on the billing page.

## Decisions a later session must not undo

- **Who bills stays billing's, and the clinical workspace gets no door onto
  it.** A clinician never sees a place of service (owner, 2026-09-29) and this
  is the same question. Build-enforced: `clinical.html` may not mention
  `billing-facility`.
- **The facility list is read from OpenEMR and never named in the page.** A
  list that cannot be read says so — an empty picker and "OpenEMR has no
  facilities" are different facts.
- **A facility OpenEMR does not flag as a billing location is shown and
  labelled, not hidden.** Hiding it makes a wrong flag in OpenEMR look like a
  missing record, which is the Hickory Log service-location lesson pointed at
  billing. Build-enforced that the picker does not filter the list.
- **The Change control is offered only while the visit is still billing's to
  change**, because the route refuses a closed encounter.
- **Goal history is a read and is not behind the write gate.**

## Verified

- **12 unit tests**; **22 of 22 mutations each confirmed to fail one** — the
  history helper removed, the control unrendered or put behind the write gate,
  a failed history read reading as no changes, the empty-trail sentence
  dropped, the history route widened, the documents card unrendered, the card
  naming a kind itself or dropping the server's hint, a failed documents read
  reading as nothing needed, a visit with no type not distinguished, a
  document link bypassing the audited route, the billing facility unserved or
  escaping the billing-only gate, the billing page unable to set it, the
  control unrendered, the clinical workspace growing a second door, an
  unreadable facility list shown as empty, the picker filtering or
  unlabelling non-billing facilities, the control offered on a closed visit,
  and the route no longer refusing one.
- Full suite **3072, 0 failing** (1 skipped, pre-existing). Both pages compile;
  the app boots, `/clinical` and `/billing` serve, and all four routes answer
  401 unauthenticated.

## One thing worth keeping

**A guard broke on its own slice boundary, for the third time in this repo.**
`clinical_workspace_412` F5 slices the encounter drawer from
`const EncounterLookups = (` to `const EncounterPanel = (` and asserts the
drawer calls no API of its own — a sound rule. My new card landed between
those two anchors, so a correct card read as a drawer defect. Fixed by moving
the card out of that window **and** repointing the guard at the component it
is actually about, anchored at both ends and loud if either moves. The
repointed guard is mutation-checked: an `api.` call added to the drawer still
fails it.

## Open for the owner

- Nothing is live until the container is rebuilt on the EC2 box.
