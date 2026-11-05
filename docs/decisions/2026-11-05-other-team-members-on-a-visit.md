# Other clinical team members can be put on a visit

**Date:** 2026-11-05
**Owner:** *"what about when other clinical team members will join? We need the ability to make sure other team members can be added to appointment as scheduled, for example, family meetings."*

Stacked on the provider-invite change and the IME calendar change, which it reuses.

## What this does

A visit can now carry people besides its clinician — a case manager, a social
worker, the coordinator. Each gets the same PHI-free calendar invitation at
their own email. The list is editable from the appointment panel without
rescheduling anything.

## ⚠️ Staff only, and family is a separate open decision

`clinicalRoles.canAttendVisit` admits anyone who may already read the chart: a
clinical role (read-only included, since a case manager attends), an admin or
a manager. **A client, a family member — POA included — or a caregiver is
never on the list.**

A family meeting is *about* family, and the owner's example named team
members. Inviting the patient's daughter is a different question and it has
not been asked yet: her mailbox is not covered by the BAA, and even a PHI-free
invitation sitting on her calendar says that this patient had a care meeting.
Build-enforced until the owner decides.

## The rules, and why each one

- **ONE EVENT, SEVERAL GUESTS**, not one event each. `inviteEmails` folds the
  clinician and the team into a single de-duplicated, case-folded list, so the
  clinician picked twice is invited once.
- **ONE BAD ADDRESS DOES NOT STOP THE REST BEING TOLD.** An unusable address
  is dropped from the list rather than failing the insert; an invitation with
  nobody left on it is refused outright.
- **GUESTS CANNOT SEE EACH OTHER.** Who else attends a patient's care meeting
  is itself something a recipient has no need to learn from an invitation.
- **AN INELIGIBLE ID IS REFUSED BY NAME** (`ATTENDEE_NOT_ELIGIBLE`, with the
  offending ids), never dropped — somebody silently left off a meeting they
  were added to is the failure this guards.
- **⚠️ THE PATIENT SURVIVES AN ATTENDEE CHANGE.** `loadAppointmentForMutation`
  returns no `clientId`, so the obvious `loaded.clientId` would have been
  `undefined` and the mirror would have **patched the clinical event with no
  patient and no address** — stripping the patient off the calendar because
  somebody joined a meeting. The client is resolved from the appointment's
  puuid, the way every other mutation route here does it. Caught by checking
  what that helper returns rather than assuming.
- **A RESCHEDULE CARRIES THE GUEST LIST.** The tombstone swap gives the visit
  a new eid, so the list is moved or the moved visit silently loses everyone.
- **CHANGING THE LIST IS NOT A RESCHEDULE.** A meeting usually gains people
  after it is booked, and rescheduling to add someone would move the visit and
  tell the patient it had moved.
- **APP-SIDE, KEYED BY EID**, the way the Meet room pointer already is:
  OpenEMR's appointment row has nowhere to put a guest list, and packing one
  into `pc_hometext` is the marker trick the location field already shows to
  be fragile.
- **THE ELIGIBLE LIST IS SERVED, NEVER NAMED IN THE PAGE** — a screen with its
  own idea of who may attend drifts from the gate that refuses them. The
  appointment payload carries each attendee's **name and role only**; a staff
  email is not something a screen needs, and its one use is the invitation.
- **A MEMBER WITH NO EMAIL IS SAID SO ON THE PICKER**, rather than letting the
  invitation fail quietly.

## Verification

- **22 tests** in `test/google_calendar.test.js` (5 new), **13 of 13 mutations
  each confirmed to fail one** — the list not de-duplicated or not case-folded,
  one bad address killing the invitation, guests able to see each other, the
  extra attendees dropped from the event, **a patient's family made eligible**,
  an ineligible id silently dropped, **an attendee change stripping the patient
  off the clinical event**, saving no longer inviting, a reschedule losing
  everyone, the page naming its own roles, the picker never rendered, and the
  no-email warning removed.
- **ONE OF MY OWN GUARDS SURVIVED AND WAS REWRITTEN.** It matched the
  refusal's *text*, so wrapping the branch in `if (false)` passed — a source
  scan cannot prove a branch is reached. It now pins the condition itself.
- **TWO OVER-BROAD GUARDS WERE REPOINTED, NOT WIDENED.** A pre-existing one
  matched `[\s\S]{0,1200}` from the mirror to its catch and broke the moment
  the function grew; it anchors on the function now. One of mine forbade
  `attendees:` anywhere in `server.js`, which wrongly caught the appointment
  list being shaped for the screen; it is scoped to the mirror.
- Full suite **3050 passing, 0 failing, 1 skipped**; `verify_veterans.js`
  **54/54**. Both routes boot and answer 401 unauthenticated.
- `appointment_attendees` registered in `dataMigration.js`.

**NOT proven from a sandbox:** that Google notifies a guest when they are
added to, or removed from, an existing event. `sendUpdates: 'all'` on the
patch is what should do it, and only a live calendar shows that it does.

## Open for the owner

1. **Whether a patient's own family may ever be invited.** Staff only until
   then, and that is a deliberate hold, not an oversight.
2. **A team member with no email on their user record cannot be invited** —
   the picker says so beside their name.

## Deliberately NOT built

- **Family or patient attendees** (above).
- **Reading RSVPs back.** Accepting or declining in Google changes nothing
  here; the visit is booked in the app.
- **Attendees on an IME exam.** The exam already invites its assigned
  provider; a second examiner is not a thing the roster models.
