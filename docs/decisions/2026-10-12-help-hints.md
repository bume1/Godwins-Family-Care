# Help notes become a "?" bubble for everyone but super admin

Owner, 2026-10-12. The small "how this works" notes under key buttons in the clinical workspace were always on screen.

- **Super admin (`role === 'admin'`) still sees every note in full**, where it was.
- **Everyone else sees a small "?" bubble** beside the buttons. Hover, keyboard focus or a tap shows the same words in a dark tooltip. The tooltip is fixed-position and kept inside the window, so it works at the edge of a card and on a phone.
- One component, `Hint` in `public/clinical.html`. The words live in one place either way.
- Converted: Save Draft / Sign & Submit notes (H&P, encounter, new note), Copy Previous Note, care-plan Sign & Save, med reconciliation save, reschedule, scan a document, order file attach, link an OpenEMR patient, dictation, "Due" on My Day, the facility card, DME order guidance, the encounter quick-open note, coding notes, the standing-order note, the requisition workflow note, and the billing submit note.
- **Kept visible on purpose:** notes that explain why a control is missing (read-only reconciliation, "prescribing is a provider's", "service codes are added by billing"), status and loading lines, warnings and errors. Hiding those leaves people looking for a button that isn't there.
- Scope is the clinical workspace only. Other pages were not changed.
- Guard: `test/help_hints.test.js` (3 tests; two mutations confirmed to fail it).
