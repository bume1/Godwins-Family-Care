# Availability is editable after submission

**Owner report, 2026-10-27:** *"allow for availability to be able to be edited
after submission please. currently our care coordinator nor can the client edit
availability after submission. Caregivers cannot edit more than 3 days after
originally submission."*

## What was actually true

Established by driving the real routes before changing anything.

| Attempt | Before |
|---|---|
| Caregiver **resubmits** availability 45 days out | ✅ worked — append-only update |
| Caregiver changes availability for **next week** | ❌ `400 AVAILABILITY_LEAD_TIME` |
| Caregiver changes availability for **tomorrow** | ❌ `400` |
| **Care coordinator** submits or edits | ❌ `403 SCHEDULING_STAFF_ONLY` |
| **Admin** or **manager** submits or edits | ❌ `403` |
| **Client** submits | ❌ `403` |
| Any edit/delete route for an existing row | none — append-only by design |

Three corrections to the report, all checked rather than assumed:

1. **There was no 3-day rule anywhere.** The number was **30** —
   `AVAILABILITY_LEAD_DAYS`. A caregiver could already update their availability
   (append-only means a resubmission *is* the edit, and the newest row is
   flagged in force) but only for dates a month or more out, so changing next
   week was refused. That is what was experienced as "cannot edit".
2. **Staff could not touch availability at all** — not the coordinator, not an
   admin, not a manager. An admin could only mark a submission *reviewed*.
3. **Clients have no availability record** and never did; it is a caregiver
   concept. Owner confirmed: caregivers only, leave clients out.

## What changed

**Two floors, because they answer two different questions** (owner: *"make it 2
weeks then let a caregiver change existing availability on short notice"*):

- `AVAILABILITY_LEAD_DAYS = 14` — a **first** submission, which is what admin
  builds a schedule from, so it needs real notice.
- `AVAILABILITY_CHANGE_LEAD_DAYS = 1` — **changing** availability already on
  file. Short notice is not no notice; the floor is still a floor.

Which applies is asked of **the store**, never the caller: a body claiming to be
a change cannot buy itself a nearer date. The refusal names the floor that was
actually applied, because one message for both would send a caregiver changing
next week to read a rule about new submissions and conclude the app is wrong.

**The office can record a change phoned in** (`isAvailabilityRecorder`: admin or
care coordinator). Deliberately **not managers** — the owner chose the
coordinator-and-admin option over the wider one that included them. One
predicate to widen if that changes.

**⚠️ THE COORDINATOR RECORDS IT; THEY DO NOT BECOME ITS AUTHOR.** The row stays
the caregiver's — their id, name and licence level, resolved from the user
record and never from the body — and carries who keyed it in beside that.
"The caregiver said this" and "the office recorded this for them" are different
facts, and the second is what a caregiver needs to see to correct a mishearing.
Both screens say so.

**The read gate was widened too.** A coordinator who can write but not read is
half a door: no way to see what is being corrected, or to check afterwards that
what was keyed in is what the caregiver meant.

## ⚠️ Why short notice is safe here

Changing availability **does not release a shift the caregiver already holds**.
`availabilityCoversShift` has no caller on any route — Session 8's matching
engine is what will use it — so a confirmed shift stays confirmed, and getting
out of a specific one is still the change-request route with its own notice
minimum and the office number when that window has passed. Availability is
forward planning; a shift is a commitment. The caregiver app says this in words,
because somebody must not read a changed rota as having handed a shift back.

**If a later session wires availability into holding or keeping a shift, these
floors have to be revisited at the same time.** The constant block says so.

## The floors are served, not restated

Both screens printed *"at least 30 days"* as a literal beside a server rule they
could not see — and the rule has two values now. `GET /availability` returns
`rules: { leadDays, changeLeadDays }` and `access: { recordForOthers }`; the
pages read them. The caregiver app keeps the stricter pair as a fallback only,
because a screen that guessed low would invite a submission the server refuses.

## A narrow roster, so the screen could exist without widening access

A coordinator is refused `/api/scheduling/caregivers` on purpose: it also
carries the **client roster with geofence coordinates**. Widening it to open an
availability screen would hand over client data nobody asked to share. So
`GET /api/scheduling/availability/caregivers` is an allow-list of three fields —
id, name, licence label. The scheduling page tolerates the 403 on the manager
roster and renders the one tab a coordinator may use.

*An owner item is only open for the owner once there is somewhere to do it* —
the fifth time that correction has been bought here. An API-only door would have
left the coordinator exactly as stuck as before.

## Append-only is unchanged

No edit or delete route was added, and a test fails the build if one appears. A
change is a new row; what somebody said in August must still be readable in
October — which is also what makes a misheard phone call recoverable rather than
destructive.

## Three things the work caught that reading did not

1. **An existing route sweep caught me.** I first gated the write *inside* the
   handler, and `test/scheduling.test.js`'s "every /api/scheduling route carries
   a role guard" reads route **signatures** — so the guard was invisible to it.
   The right fix was to make both gates real middleware
   (`requireAvailabilityWriter`, `requireAvailabilityOffice`), **not** to add an
   exception: that sweep's exception list is for reads that branch by audience,
   and this is a write.
2. **A mutation proved my tests were not enough.** Neutralising the writer
   gate's own branch — so a coordinator falls through to the caregiver path and
   is refused — broke the whole feature with every test still green, because
   they were all source scans or pure functions. Five tests now mount the
   shipped router and post.
3. **A tab strip of one is not a selected tab.** Withholding every other tab
   from a coordinator left the strip showing "Availability" and the body
   rendering nothing, because the page still opened on `calendar`. Found by
   rendering the page, not by reading it.

## Verified

- `test/availability_editable.test.js` — 18 tests (13 guards + 5 driving the
  shipped router over real HTTP). **16 mutations, 16 caught**: both floors
  reverted, the change floor never applied, the default flipped to the loose
  floor, one message for both, managers silently added, the body declaring its
  own floor, the recorder becoming the row's owner, provenance hidden, the
  narrow roster leaking the client list, either gate dropped from its route
  signature, everyone routed through the self path, the page hardcoding 30, and
  both screens dropping what they must say.
- `scripts/verify_scheduling_board_render.js` — **34/34** in Chromium, with a
  new section I that plays a care coordinator: the page loads instead of
  denying, only the Availability tab is offered, the form posts the caregiver it
  was told to, and the served floors appear rather than a hardcoded 30.
- Full suite **2678, 0 failing**; `verify_scheduling.js` 251/251.

### Three existing guards repointed, not deleted

- The 30-day lead-time pair → the two floors, both halves pinned. The rule they
  protected (a floor is enforced in the repository module, so the API refuses
  what the form refuses, and the refusal names it) did not go away.
- The route sweep → taught the two new guard names. The rule is unchanged: every
  route carries one.
- `shift_change_requests.test.js`'s panel slice was anchored on `{tab === …`,
  which this change renamed; **it silently sliced nothing and passed over an
  empty string**. Repointed, and it now asserts its anchors were found.

## Not proven from the sandbox

Nothing here touches OpenEMR, Drive or email, so everything is provable locally
and no deployment probe is owed. What is not proven is a real coordinator
signing in — this is TEST DATA only, as always.

## Open for the owner

- **Managers are excluded** from recording availability, matching the option
  chosen. They run the rest of the board, so say if they should have it too — it
  is one predicate.
- **"Short notice" is one day.** `AVAILABILITY_CHANGE_LEAD_DAYS` is a single
  constant; say if it should be two or three.
- **A coordinator now sees every caregiver's availability**, which they need to
  record a change. That is wider than their usual client-scoped read, and it
  carries no client data — but it is a widening, and worth knowing.
