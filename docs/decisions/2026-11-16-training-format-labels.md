# A training's format label says what is actually attached

**Date:** 2026-11-16 · **Owner direction:** "Fix the video vs in app vs etc etc"

## The problem

The format line on each training ("Video · 15 min") showed the catalog's planned format, not what is attached.
- 24 trainings said **Video**; only three have a video attached. The rest teach from a written SOP or a document.
- TRN-004 said **In the App** when its material is four documents to read.
- The page had a rule to correct "Video" to "Read". It worked only where the page received the material, so the new staff Training Library and the office library still printed the plan.

## The rule

One function, `trainingMaterial.shownFormat(format, material)`, decided on the server. Every screen prints its answer: her own Training tab, the staff Training Library and the office Training Library.

- **Video, In the App, Read, GFC Training** describe what you get, so they follow the material:
  - a video link or video file reads **Video**;
  - an SOP, document, link or other file reads **Read**;
  - both read **Video and Reading**.
- **Video and Observed** becomes **Read and Observed** when there is no video.
- **Live Session, Observed, Shadowing, Outside Training** describe how the training is done, not what is attached, so they keep their label.
- **Nothing attached yet:** the planned format shows with "(planned)", for example "Video (planned)".

## Result on the catalog as seeded

- 17 trainings change from Video to Read: TRN-001, 003, 005, 008, 105, 202, 205 to 209 and others with an SOP behind them.
- TRN-004 changes from In the App to Read.
- TRN-203 changes to Read and Observed.
- TRN-503 changes to Video and Reading.
- TRN-501 and TRN-502 stay Video.
- Eleven empty trainings read "Video (planned)".

## Verification

- `test/training_format_labels.test.js`: 3 tests on the rule and the seeded catalog.
- `test/staff_training_library.test.js` checks all three routes serve the same label.
- `test/sop_format.test.js` now pins that the page prints the server's label.
- A mutation that returns the catalog format fails 4 tests.
- Full suite: 3,937 tests, 0 failing.
- Read back from the rendered page in Chromium.
