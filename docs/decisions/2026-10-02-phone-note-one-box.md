# A phone call note is one open box (owner, 2026-10-02)

**Ask:** call notes should be one open note space. No Subjective, Assessment or Plan split, and no hidden Objective or vitals.

**Change:**
- `pc_phone_ccm` now has one section, `callNote` ("Call note"), and it is required. The earlier phone sections (who was on the call, interval history, assessment, plan, minutes) are no longer on the template.
- On a phone call, the Visit tab, the encounter editor and the unscheduled-visit form show only that box. They save no chief concern, SOAP parts or vitals. The unscheduled-visit form also hides "Start from a previous note" for a call.
- The minutes spent go in the note text. Billing reads them there until the CCM integration lands.

**Verified:**
- `test/appointment_types.test.js` and `test/unscheduled_visit_type.test.js` were updated. 4 of 4 mutations were caught.
- The notes probe passes 146/146; section 15 saves, edits and signs a one-box call note.
- Full suite: 1950 tests, 0 failing.
- The page compiles.
