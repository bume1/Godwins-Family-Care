# A provider is invited to a visit, on their own email, with no patient on it

**Date:** 2026-11-05
**Owner decision:** providers get a calendar invite at their personal email when a visit is booked in the app — and, asked directly, that the invite carries **no PHI** and the identifying detail stays on the clinical calendar.

## The gap

The app has mirrored app-booked clinical visits onto the shared clinical
calendar since 2026-10-12, and that event has **no attendees**. So nothing was
ever sent to anybody: a clinician saw the visit only if that whole calendar had
been shared with them in Google, and never on their own phone's calendar.

Most GFC clinicians hold personal Gmail accounts rather than Workspace ones,
which is the whole reason this is an invitation rather than a calendar share.

## ⚠️ Why there are two events and not one

**The Workspace BAA covers `@godwinsfamilycarellc.com`. It does not cover a
personal `@gmail.com`.** The clinical calendar's event carries the patient's
name and, for a home visit, their home address. Making a clinician an attendee
of *that* event would put a patient's name and where they live into a mailbox
outside the agreement — a disclosure, not a formatting choice. Google has no
way to show one attendee a different body.

So a visit now has **two events on two calendars**:

| | Clinical calendar | Invite calendar |
|---|---|---|
| Setting | `GOOGLE_CLINICAL_CALENDAR_ID` | `GOOGLE_PROVIDER_INVITE_CALENDAR_ID` |
| Carries | Patient name, home address, clinician | Time, visit type, "open the app" |
| Attendees | None | The clinician, at their own address |
| Covered by the BAA | Yes | Does not need to be |

The invite reads:

> **GFC Follow-up** · 9:00–9:45
> Home visit
> Open the Godwins Family Care app for the patient, the address and the chart.
> This invite deliberately carries no patient details.

Same rule the patient message notice already follows: say something is waiting,
never carry it.

## The rules, and why each one

- **`buildInvite` IS HANDED ONLY WHAT IT MAY SHOW.** It takes a narrow input —
  no patient name, no address, no client id — so there is nothing in scope for
  a later edit to leak. Not "we remembered to leave them out" but "they are
  not there to leave in", the same reasoning as the critical-result notice
  builder, which takes no arguments at all. Build-enforced on the function's
  **stripped** source and on its output.
- **INVITES ARE OFF UNTIL THEY HAVE THEIR OWN CALENDAR.** Defaulting them onto
  the clinical calendar would put a second row on every visit for everyone who
  reads it — a change nobody asked for. Unset means no invites, and the boot
  log says which setting is missing.
- **`sendUpdates: 'all'` IS WHAT ACTUALLY INVITES ANYBODY.** Without it Google
  creates the event and tells nobody, which looks identical to working. It is
  on the create, the move and the withdrawal.
- **A RESCHEDULE MOVES THE SAME INVITE; A CANCELLATION WITHDRAWS IT.** The
  tombstone swap changes the eid, so the invite is re-keyed on the new one or
  the clinician keeps a slot nobody is attending. Deleting quietly would leave
  them driving to a visit their phone still shows.
- **A BAD OR MISSING ADDRESS SENDS NOTHING** rather than a broken invite: an
  address Google refuses fails the whole insert.
- **THE GUEST CANNOT EDIT IT.** The visit is booked in the app and a guest edit
  here would never reach OpenEMR.
- **ONE FUNCTION DOES BOTH HALVES** (`mirrorVisitToGoogle`), so a route cannot
  write the full event and forget the invite. Build-enforced that there is
  exactly one invite writer and that the invite call is passed none of the
  patient facts.
- **BEST-EFFORT, as the mirror already is.** A Google failure never undoes a
  visit that is already on OpenEMR's calendar.

## Verification

- **12 tests** in `test/google_calendar.test.js` (7 new), **14 of 14 mutations
  each confirmed to fail one** — the patient name or the address put on the
  invite, the attendee dropped, `sendUpdates` dropped on each of the three
  calls, a bad email accepted, invites defaulted onto the clinical calendar,
  the invite written to the clinical calendar, a reschedule orphaning the old
  invite, one shared map for both events, the server no longer inviting, the
  server passing the patient facts, and cancelling no longer withdrawing.
- **ONE OF MY OWN GUARDS FAILED A CORRECT FUNCTION AND WAS REWRITTEN.** The
  scope check matched the word "address" inside the invite's own description
  text ("open the app for the patient, the address and the chart") — the
  comment-and-prose-as-code trap this repo has paid for several times. It now
  strips comments and string literals first, and asserts the stripped slice is
  still the real function so it cannot pass vacuously.
- Boot log read back in both states: with no invite calendar it says
  `Provider invites: OFF — GOOGLE_PROVIDER_INVITE_CALENDAR_ID is not set`.
- Full suite **3040 passing, 0 failing, 1 skipped**.
- `google_calendar_invites` registered in `dataMigration.js`.

**NOT proven from a sandbox:** that Google accepts the invite and delivers it.
`configured` means the settings parse, which is a different fact. Only a real
booking against the live calendar shows the invitation arriving.

## Open for the owner

1. **Create a second Google calendar for invites** (e.g. "GFC Provider
   Invites"), share it with the impersonated account as an editor, and set
   `GOOGLE_PROVIDER_INVITE_CALENDAR_ID`. Until then invites stay off and
   nothing else changes.
2. **A clinician is invited at the email on their user record.** For a provider
   whose login is their personal Gmail that is already right; check anyone whose
   record carries an address they do not read.
3. **If providers ever get licensed Workspace accounts**, the invite can carry
   the patient and the address like the clinical event does, and the two events
   could collapse back into one. That is a deliberate later decision, not a
   default.

## Deliberately NOT built

- **Attendees on the clinical calendar's own event** — that is the disclosure
  this design exists to avoid.
- **Reading the clinician's RSVP back into the app.** Accepting or declining in
  Google changes nothing here; the visit is booked in the app.
