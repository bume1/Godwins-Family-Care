# Unscheduled visits can pick a visit type (2026-10-02, owner report)

**Problem:** "Document unscheduled visit" (Appointments tab) and "Document follow-up visit" (Encounters tab) open `FollowUpModal`, a fixed follow-up form with no visit-type dropdown. The Phone Call / Care Management note, or any other type, could not be started from them.

**Fix:**
- The form now has **Visit type** and **How the visit happened** selects. Both come from the same served catalog the Visit tab uses (`GET …/place-of-service`), so the page lists no types of its own.
- A type only offers the modalities it allows. Phone appears only for a phone-only type.
- The chosen visit is saved on the note (`note.visit`). The encounter then opens with that type's template sections.
- A phone call hides vitals and Objective, sends no vitals, and has no location.
- Leaving the type blank keeps the old behaviour: a plain follow-up.
- The form title is now "Document a visit".

**Verified:**
- `test/unscheduled_visit_type.test.js` has 4 tests, and 4 of 4 mutations were caught.
- Full suite: 1950 tests, 0 failing.
- The page compiles.
- Not rendered in a browser this pass.
