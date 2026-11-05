# A veteran on the board can be edited

**Date:** 2026-11-05
**Owner report:** *"the veterans exam additions don't include a time still tho so they show in a calendar slot?"*

## What was actually wrong

Two separate things, and only one of them was a defect.

**The time field exists.** `Start time` and `Length (minutes)` have been on the
Add Veteran form since the slot work merged. A deployment that does not show
them has not been rebuilt — the container serves the image, not the tree.

**But an exam could never be edited afterwards, and that is a real gap.**
`PUT /api/veterans/roster/:id` has shipped since the roster did and **nothing
in the app ever called it** — grepped the page: POST to add, GET to list, POST
to set a status, DELETE to remove, and no PUT anywhere. So a veteran added
without a time could never be given one, and an exam that moved could not be
moved: remove and re-add was the only route, which throws away the row, its
creator, its arrival and its history to change one field.

This is the same class of gap as the facility-assignment route, the MFA reset
and `acknowledgeAbnormalResult`: **a live route with no screen.** The rule this
repo keeps re-learning is that an owner item is only open for the owner once
there is somewhere to do it.

## What was built

An **Edit** button on every roster row, opening the **same form that adds**,
prefilled, saving through the PUT route that was already there.

## The rules, and why each one

- **ONE FORM FOR ADD AND EDIT.** The server validates both through the same
  `normalizeRosterInput` and refuses a double-booked slot on both doors, so a
  second form here would be a second idea of what a booking is.
- **THE DAY PICKER DOES NOT TOUCH THE ROW BEING EDITED.** The add form follows
  the board's date; the edit form must not, or moving the board to another day
  silently rewrites the date of the exam open in front of you.
- **CLEARING A TIME SAYS WHAT IT DOES.** From the form it looks like blanking a
  box; it takes the exam off the clinical calendar and withdraws the
  provider's invitation. The warning appears only when a timed exam is being
  cleared.
- **ONE FORM ON SCREEN.** Opening Add closes an edit and the reverse, or two
  headings claim the same inputs.
- **SAVING AN EDIT CLOSES THE FORM; SAVING AN ADD KEEPS THE DATE, PROVIDER AND
  LENGTH** for the next veteran. An exam day is a run of the same-shaped
  bookings; an edit has no next one.
- **THE SERVER WAS ALREADY RIGHT** and is left alone: the edit re-validates,
  re-checks the slot clash excluding itself, re-mirrors to the calendar, and
  still refuses a provider editing somebody else's veteran. All four are now
  pinned by tests, because none of them was exercised while nothing called the
  route.

## Verification

- **37 tests** (2 new), **9 of 10 mutations each confirmed to fail one** — the
  edit route uncalled again, the day picker overwriting the edited row, the
  clearing warning removed, Add and an edit open together, the Edit button
  unlabelled, an edit skipping validation, an edit double-booking a provider,
  a moved exam left on the calendar, and a provider editing another's veteran.
- **ONE MUTATION IS A BEHAVIOURAL NO-OP AND IS RECORDED AS SUCH RATHER THAN
  CLAIMED AS A CATCH.** Replacing the form's `useState` initializer with
  `blank` changes nothing observable: the effect keyed on `editing.id` fills
  the form on mount either way. **Proven in a browser, not reasoned about** —
  the render probe asserts the surname field is prefilled and passes with the
  mutation applied. The code now says which line is load-bearing so a later
  simplification does not remove the effect believing the initializer covers
  it.
- **TWO OF MY OWN ASSERTIONS WERE TOO LOOSE AND WERE FIXED.** One matched the
  prefill string in two places and so could not tell the initializer from the
  effect. The other asserted the Edit button's `onClick` and missed a mutation
  that emptied its **label** — an onClick with no label is an invisible
  control. A probe assertion was also rewritten: it sliced body text and could
  not distinguish the form's heading from the page's always-present "Add
  Veteran" button, so it failed a correct form.
- `scripts/verify_veterans_render.js` **40/40** in real Chromium (6 new): the
  form opens on the right veteran, is prefilled, is cancellable, sends a PUT
  with the new time, closes on save, and is closed by opening Add.
- Full suite **3057 passing, 0 failing, 1 skipped**; `verify_veterans.js` 54/54.

## Open for the owner

**An exam with no time still gets no calendar event**, and that is deliberate —
it shows on the Veterans board as "No set time" and sorts last on My Day, but
nothing places it at a guessed hour. Give an exam a time and it appears on the
clinical calendar; that is now editable after the fact.
