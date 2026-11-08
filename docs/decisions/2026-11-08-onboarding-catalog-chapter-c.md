# Onboarding wizard, step 1: the catalog and Chapter C

Owner request, 2026-11-08: build the onboarding wizard as the GFC Onboarding Playbook executed in software (GFC-WIZ-PROMPT v2.0), starting with the data model and Chapter C. The specification lives in Drive. No document in `docs/` governs it.

This step adds the catalog only (`onboarding/`). It does not change the shipped clinician wizard (#260) yet. That rework is the next step.

## Owner decisions, 2026-11-08

- **Onboarding is collaborative, not office-run.** This overrides GFC-WIZ-PROMPT v2.0 §1. The new hire completes and submits her own items. The office completes or verifies the rest.
- **The office can act on every item, including hers.** If she already signed something in Gusto, or already sent her license, the office files it for her and it reads complete on her side, labelled with who filed it. She can still upload her own copy. The rule runs one way only: the office can do both steps of a verified item, and she can never do the second step.
- **Clinicians acknowledge Clinical P&P v2.2 and admins acknowledge Admin P&P v2.3.** Playbook C.11, F.10 and R3.3 say v2.0. The Playbook's figure is kept beside the owner's (`playbookStates`), so the disagreement stays visible until the Playbook is corrected.
- **A module without confirmed manual sections reads "Pending", not "cannot check".** Its sections are drafted for the Clinical Director to confirm. Ten come from SOP Set 2's "Planned" table, and those ten SOPs are still to be written. The other nineteen are our draft. Only confirmed sections drive the flag.
- **TRN-006 (read the whole manual) flags on every manual reissue,** whatever section changed.
- **The Playbook is read from its Drive HTML copy** (`1bjeBX-…`). The PDF's text layer misaligns its table rows. The HTML's tables read cleanly.

- **One Drive folder per role, with a subfolder per person** (`onboarding/staffFolders.js`), created the first time a document is filed for that role:
  - GFC Caregiver Documents (unchanged)
  - GFC Registered Nurse Documents
  - GFC Clinician Documents (Chapters C, D and E share it, because a hybrid clinician has one credentialing record)
  - GFC Non-Clinical Staff Documents
  - GFC Community Care Liaison Documents
  - GFC Student and Extern Documents

  Clinician uploads used to land in the caregiver folder as "Clinician <name>". New ones go to the clinician folder. **Files already in the caregiver folder were not moved.** Moving them is the owner's call.

- **Items kept from #260 that Playbook v3.0 Chapter C does not list (owner, 2026-11-08):** TB screening (Manual §16.5), the immunization record (§16.5), the driver's licence and auto insurance for anyone driving, the 24-hour self-reporting duty (§5.3), annual pharmacology training for prescribers, telehealth licensure in the patient's state (§26.2), and controlled prescribing by telehealth. Each carries `addedBy` and cites the manual, never the Playbook. **The Hepatitis B offer is dropped.**
- **Every actor inferred in the first transcription is confirmed by the owner** (`OWNER_CONFIRMED`). Only actors on the owner's additions still read `INFERRED`.
- **No clinician files were found in "GFC Caregiver Documents"**, so there was nothing to move. Its subfolders are caregivers and test data.

## What a later session must not undo

- **⚠️ #260's RECORDS ARE CARRIED OVER AS EVIDENCE, NEVER AS COMPLETION** (`onboarding/legacy260.js`). Each old item state is shown on the Chapter C item it matches, with who did it and when. It never ticks the new item: three old ticks are not proof that one new step is done. Every #260 item is accounted for and build-enforced: a Chapter C item, a training module, or a stated reason why it has no home in Chapter C.
- **⚠️ ONLY THE OFFICE COMPLETES AN OFFICE STEP; THE OFFICE MAY COMPLETE ANY STEP** (`onboarding/track.js`). A verification needs a source and a date, and never comes before what it verifies. A returned step keeps its history. An acknowledgment counts only at the required version. A service line opens only when its owner confirms every C.8 condition and states the scope.

- **⚠️ STORE THE REFERENCE, NEVER THE CONTENT.** Each item carries a Playbook section, the document's own heading as its title, and the document's own classification phrase. It never carries the requirement text, a check question or an answer. Build-enforced: `modules.js` may not contain `prompt:`, `answer:` or `checks:`, and nothing under `onboarding/` may reference `docs/`.
- **⚠️ CLASSIFICATIONS ARE THE DOCUMENT'S, WITH THE ROW AND THE SOURCE.** An unknown phrase is refused at load time, not guessed. An item with no row in Playbook C.2 says so (`classificationNote`), and is never filled in. Where the Playbook and the manual disagree, the item carries both, each citing its source.
- **⚠️ EVERY ACTOR SAYS WHERE IT CAME FROM.** `STATED` means the Playbook names that role for the work. `INFERRED` means the Playbook describes the work but names nobody, so the actor is our reading. The inferred ones are open for the owner to confirm.
- **⚠️ THE VERSION FLAG NEVER CLEARS A MODULE BY SILENCE.** A module with no confirmed manual sections is `PENDING`. A gap in the change chain is `CHANGES_UNKNOWN`. Neither one means "nothing changed". A drafted section never drives the flag until the Clinical Director confirms it.
- **The change list from v2.1 to v2.2 is seeded from Training Library v1.2 §2.2, and cites it.** The manual has no change log, and the Drive copies have no earlier revision to compare against. Every reissue after this one is fingerprinted section by section, so the change list is computed rather than typed.
- **A document's version is read from its control table, never its filename.** The filenames carry a version that becomes wrong after the first in-place revision.
- **Module ids are the Library's and are never renumbered.** Build-enforced as an exact list.

## Reading the documents from Drive at runtime

- `onboarding/documentText.js` reads a .docx (a zip, unpacked with zlib, so no new dependency) or the Playbook's HTML into lines. Tables become `| a | b |` rows, and italic text, which is how a check question is marked, gets `*` around it.
- `onboarding/sourceParsers.js` reads a document's version from its control table (the Playbook's from its "v3.0" banner). It also reads the manual's section fingerprints, the check questions from SOP Set 1 and the Training Library, and runs **a drift check of the catalog's C.2 classifications against the live Playbook table**.
- **The drift check against the real Drive Playbook found zero differences.**
- `onboarding/sourceLoader.js` caches in memory only, keyed by the file's Drive checksum, so a document revised in place is never served stale.
- **Each manual version's section fingerprints are stored** in `onboarding_manual_versions`. These are hashes, never text, and that is build-enforced. When a new version appears, its changed sections are computed rather than typed.
- **NOT proven from the sandbox:** the .docx reader was built against generated files, never the live Word documents. Run `node scripts/verify_onboarding_sources.js` on the deployment to prove it reads the real files.

## Verified

- `test/onboarding_catalog.test.js`: 25 tests. 11 of 11 mutations were confirmed to fail a test. One first-draft mutation was a no-op in behaviour (the chain's final line already returns unknown) and was replaced rather than counted.
- **Acceptance test: on a first run against v2.2, TRN-206 (11.4), TRN-207 (12.4) and TRN-208 (12.3) flag on their sections, and TRN-006 flags on any change.**
- The fingerprinter, run against the real v2.2 manual text, finds 170 numbered sections and reads version 2.2 from the control table.
- Full suite: 3249 passing, 0 failing, 1 skipped (pre-existing). The 76 failures seen first were a sandbox without `node_modules`.

## Found in the sources, open for the owner

1. **Playbook C.2 classifies the Schedule I/II prohibition as Statutory. Manual §1.6 classifies it as Statutory and regulatory.** Item C.6.05 carries both.
2. **29 Chapter C modules read Pending until the Clinical Director confirms their drafted manual sections** (`onboarding/modules.js`, `SOP_PLANNED` and `DRAFT_MANUAL_REFS`). Ten wait on SOPs not yet written: SOP-PAT-01, SOP-TH-01, SOP-BH-01, SOP-BH-02, SOP-CM-01, SOP-TOC-01, SOP-BIL-01, SOP-RPT-01, SOP-INC-01 and SOP-EMR-01.
3. **TRN-106 is required for "Focused review",** which is not one of the Library's three `required_for` forms.
4. **The Playbook is in Drive twice (HTML and PDF).** Admin P&P §17.2 allows one canonical copy.
5. **The Playbook should be corrected to name Clinical P&P v2.2 and Admin P&P v2.3.**
6. **Admin P&P v2.3's cover says effective Nov 7, but its version record says Nov 8.** §17.2 names "06 People / Onboarding Library" and "06 People / Training", while the build prompt names "06 People / Onboarding / Training".
7. **The inferred actors in `onboarding/chapterC.js` need confirming.**
8. **The Playbook should be revised to list the owner's additions** (below), so the document and the app agree again.

## Next

Rework #260 onto this catalog rather than building a second wizard:
- Phases C.4 to C.9 replace its G1 to G4 gates. The Training Library v1.2 removed that gate structure at Playbook v3.0.
- `required_for` replaces `feedsGate`.
- The Gusto wording goes. Playbook R3.5 says the app is the system of record.
- Check questions are read from the SOP and Library documents in Drive.
- Then Chapters A and F.
