# Onboarding wizard, step 1: the catalog and Chapter C

Owner request, 2026-11-08: build the onboarding wizard as the GFC Onboarding Playbook executed in software (GFC-WIZ-PROMPT v2.0), starting with the data model and Chapter C. The specification lives in Drive. No document in `docs/` governs it.

This step adds the catalog only (`onboarding/`). It does not change the shipped clinician wizard (#260) yet. That rework is the next step.

## Owner decisions, 2026-11-08

- **Onboarding is collaborative, not office-run.** This overrides GFC-WIZ-PROMPT v2.0 §1. The new hire completes and submits her own items. The office completes or verifies the rest.
- **The office can act on every item, including hers.** If she already signed something in Gusto, or already sent her license, the office files it for her and it reads complete on her side, labelled with who filed it. She can still upload her own copy. The rule runs one way only: the office can do both steps of a verified item, and she can never do the second step.
- **Clinicians acknowledge Clinical P&P v2.2 and admins acknowledge Admin P&P v2.3.** Playbook C.11, F.10 and R3.3 say v2.0. The Playbook's figure is kept beside the owner's (`playbookStates`), so the disagreement stays visible until the Playbook is corrected.
- **The Playbook is read from its Drive HTML copy** (`1bjeBX-…`). The PDF's text layer misaligns its table rows. The HTML's tables read cleanly.

## What a later session must not undo

- **⚠️ STORE THE REFERENCE, NEVER THE CONTENT.** Each item carries a Playbook section, the document's own heading as its title, and the document's own classification phrase. It never carries the requirement text, a check question or an answer. Build-enforced: `modules.js` may not contain `prompt:`, `answer:` or `checks:`, and nothing under `onboarding/` may reference `docs/`.
- **⚠️ CLASSIFICATIONS ARE THE DOCUMENT'S, WITH THE ROW AND THE SOURCE.** An unknown phrase is refused at load time, not guessed. An item with no row in Playbook C.2 says so (`classificationNote`), and is never filled in. Where the Playbook and the manual disagree, the item carries both, each citing its source.
- **⚠️ EVERY ACTOR SAYS WHERE IT CAME FROM.** `STATED` means the Playbook names that role for the work. `INFERRED` means the Playbook describes the work but names nobody, so the actor is our reading. The inferred ones are open for the owner to confirm.
- **⚠️ THE VERSION FLAG NEVER CLEARS A MODULE BY SILENCE.** A module with no manual references is `CANNOT_ASSESS`. A gap in the change chain is `CHANGES_UNKNOWN`. Neither one means "nothing changed".
- **The change list from v2.1 to v2.2 is seeded from Training Library v1.2 §2.2, and cites it.** The manual has no change log, and the Drive copies have no earlier revision to compare against. Every reissue after this one is fingerprinted section by section, so the change list is computed rather than typed.
- **A document's version is read from its control table, never its filename.** The filenames carry a version that becomes wrong after the first in-place revision.
- **Module ids are the Library's and are never renumbered.** Build-enforced as an exact list.

## Verified

- `test/onboarding_catalog.test.js`: 22 tests. 8 of 8 mutations were confirmed to fail a test. One first-draft mutation was a no-op in behaviour (the chain's final line already returns unknown) and was replaced rather than counted.
- **Acceptance test: on a first run against v2.2, exactly TRN-206 (11.4), TRN-207 (12.4) and TRN-208 (12.3) flag.**
- The fingerprinter, run against the real v2.2 manual text, finds 170 numbered sections and reads version 2.2 from the control table.
- Full suite: 3249 passing, 0 failing, 1 skipped (pre-existing). The 76 failures seen first were a sandbox without `node_modules`.

## Found in the sources, open for the owner

1. **Playbook C.2 classifies the Schedule I/II prohibition as Statutory. Manual §1.6 classifies it as Statutory and regulatory.** Item C.6.05 carries both.
2. **29 of 43 Chapter C modules cannot be checked when the manual changes,** because the Library lists no manual sections for them and the SOP table doesn't map them either. TRN-006 (read the whole manual) is among them. Its flagging is the owner's call, not an inference.
3. **TRN-106 is required for "Focused review",** which is not one of the Library's three `required_for` forms.
4. **The Playbook is in Drive twice (HTML and PDF).** Admin P&P §17.2 allows one canonical copy.
5. **The Playbook should be corrected to name Clinical P&P v2.2 and Admin P&P v2.3.**
6. **Admin P&P v2.3's cover says effective Nov 7, but its version record says Nov 8.** §17.2 names "06 People / Onboarding Library" and "06 People / Training", while the build prompt names "06 People / Onboarding / Training".
7. **The inferred actors in `onboarding/chapterC.js` need confirming.**

## Next

Rework #260 onto this catalog rather than building a second wizard:
- Phases C.4 to C.9 replace its G1 to G4 gates. The Training Library v1.2 removed that gate structure at Playbook v3.0.
- `required_for` replaces `feedsGate`.
- The Gusto wording goes. Playbook R3.5 says the app is the system of record.
- Check questions are read from the SOP and Library documents in Drive.
- Then Chapters A and F.
