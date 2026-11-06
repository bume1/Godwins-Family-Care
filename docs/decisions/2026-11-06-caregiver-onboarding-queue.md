# The office can mark its own onboarding items

**Owner, 2026-11-06:** *"Fix all."* Like the standing orders, this is not a
missing button — it is a gate nobody could open.

## What was wrong

Shift clearance needs the caregiver's documents accepted **and the office's own
four checks done**: fingerprinting, orientation, app-and-clock-in training, and
the skills check. **All four are required.** The only route that sets them —
`PUT /api/caregiver/admin/welcome-packets/:caregiverId/office-item` — had no
screen, and neither did the queue beside it.

So **no caregiver could be cleared for a shift the normal way.** Every
assignment had to go through the admin override, with a reason, stamped on the
shift — or not be made at all. The override exists for a compliance exception
and had become the only door.

## The screen

An **Onboarding** tab on `/caregivers`, the admin supervision page where
escalations, visit logs, incidents and documents already live.

- **It defaults to what is OURS to act on.** A queue that mixes "we have not
  run their orientation" with "they have not photographed their TB result"
  cannot be worked, and only the first half is settable here. The filter can be
  unticked, and an empty filtered list says so rather than reading as "no
  caregivers".
- **The statuses and the item titles are SERVED.** The route refuses a status
  outside its own list (`OFFICE_STATUS_UNKNOWN`), so an option invented in the
  page would be refused on save — or render an empty dropdown and look broken.
- **Sent by `kind`, not by item number.** The checklist row carries both: `item`
  is the printed packet's number (6, 21, 22, 23) and `kind` is what the route
  validates. The first version of the queue served the number, which would have
  been refused on every save. Caught before it shipped and pinned by a test.
- **Clearance is reported in the gate's own words**, and read back from the
  save's response, which recomputes it. Marking the last item is the moment a
  caregiver becomes schedulable, and that is the thing the office is waiting to
  hear, so it is said in that moment rather than left to a reload.
- **The caregiver's own outstanding items are named**, so the office knows why
  someone is still not cleared after our four are done.
- **The queue carries no PHI.** Counts and onboarding state. The packet holds a
  date of birth, a home address and a signature image; none of it belongs on a
  list, and a test asserts none of it is served.

## ⚠️ A pre-existing probe failure, diagnosed and fixed

`scripts/verify_welcome_packet.js` has reported **38/42 since 2026-09-16** and
nobody noticed. Its clearance section accepts every document and ticks every
office item, then asserts the caregiver is cleared — and clearance was
unreachable, because **PR #99 added four forms the caregiver signs in the app**
(background check authorization, registry attestation, physical ability,
mandatory reporter) and the probe never signed them.

So the last four checks were red for seven weeks, which teaches whoever runs it
to ignore the output. **This is the THIRD time this probe has been gutted by a
gate added after it was written** — the enrollment gate did it at section B in
September, the clearance gate at section F.

It signs them now, with the elections read from the real `choicesFor`, so an
added question or a renamed option is satisfied automatically rather than
quietly stopping the run again. And it **asserts the seeding worked** before
relying on it: a fixture that does not clear the gate reports on a world that
is not production.

**43/43.** It proves, for the first time since September, that a caregiver can
go from nothing to claiming a shift **with no override on it, because none was
needed** — which is exactly what this screen exists to make true.

## Verification

- **9 tests, 13 of 13 mutations each confirmed to fail one**: the tab rendering
  nothing, the tab removed, the PUT never sent, statuses hardcoded, the server
  serving the item number instead of the kind, statuses no longer served,
  clearance read from stale state, the "now cleared" message removed, the
  gate's sentence replaced by the page's own, an empty filtered list reading as
  no caregivers, the caregiver's own items hidden, the office rows no longer
  served, an office item ceasing to be required, and office items ceasing to
  block clearance.
- **One mutation of mine was a harness no-op and is recorded as one**: inserting
  `required: false` before the existing `required: true` in the same object
  literal leaves the later key winning. Redone against the real line.
- **A test of mine failed on a comment.** The PHI scan matched the route's own
  comment saying it serves no address. Comments are stripped before that scan
  now. Sixth time this repo has paid for a scan that cannot tell code from
  prose about it.
- **Four CSS classes I invented were replaced with the page's own.** `pill`,
  `warn`, `lnk` and `muted` are not in this stylesheet; the screen would have
  rendered unstyled. Found by listing the stylesheet rather than assuming.
- Full suite **3069 passing, 0 failing, 1 skipped**. The page compiles.

## Not proven from this sandbox

A real caregiver cleared on the deployment. The probe runs the shipped routes
against an in-memory store with the same contract, which is how every scheduling
probe in this repo works.
