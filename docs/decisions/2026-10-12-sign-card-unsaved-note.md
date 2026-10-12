# Sign & Submit no longer lists sections you've typed but not saved (2026-10-12)

**Owner report:** with a screenshot of the encounter's Sign & Submit card, "same here". It read "Cannot sign: this Follow-up note still needs Subjective, Medication Reconciliation, Assessment / Diagnoses, Plan, Follow-up, MDM or Total Time statement. Save your coding changes first."

**Cause:**
- On a laptop the encounter is one page: the note editor and the Sign & Submit card sit together.
- The card reads the sign check for the **saved** note. Anything typed and not yet saved was listed as missing, and the card's button stayed disabled.
- The server's section check was correct: Subjective, Assessment and Plan map to the fields the SOAP editor saves.
- The "Save your coding changes first" part is the coding flag bug fixed earlier on this branch.

**Decided:**
- **Both note editors report their state up** (`useNoteDirty` in `public/clinical.html`): whether the note on screen differs from the one last loaded or saved, plus a way to save it. "Unsaved" means typed and not saved, compared with the form as loaded.
- **While the note is unsaved, the card stops listing sections.** It says "Your note has unsaved changes. Save it to check what signing still needs." and offers **Save Note**. Saving reloads the encounter, so the card then shows the real sign check.
- The card's Sign & Submit, and the Clinician Addendum, stay disabled while the note is unsaved. The note editor's own Sign & Submit still saves first and then signs.
- Nothing on the server changed.

**Verified:**
- 3 new tests in `test/clinical_redesign.test.js`, with the real hook lifted from the page and run. 5 of 5 mutations were caught.
- `scripts/verify_soap_note_render.js` gained section H (a saved follow-up encounter in Chromium: type, see "unsaved", Save Note, the check returns). It now runs **20/20**. Its labels were repointed to the Title Case buttons ("Start Visit", "Visit Type", "Save Draft"), because it had been failing since the label sweep.
- Showing the stale list while the note is unsaved fails H2.
- Full suite: 0 failing. The page compiles.
