# Tax forms are filled beside the official form

**Date:** 2026-11-14 · **Owner-directed** ("people still need to see the full picture of what they are filling out … the pdf to the left and the empty fields to the right") · Branch `claude/stoic-feynman-ozygr7`

## What changed
- In Pay Setup, Start or Update on the W-4, G-4, state certificate, I-9, W-9 or W-8BEN opens a full-screen workspace: the official government form on the left (every page), the same questions on the right. SSN, address, pay method and the rest keep the inline card.
- The form redraws with the answers so far half a second after each change, and the box being filled is outlined and scrolled into view. On a phone the form sits above the questions with a Hide/Show Form toggle.
- `POST /api/my/pay-setup/preview/:form` draws the preview; `GET …/preview/:form/fields` gives the box positions from the blank form.
- pdf.js 3.11.174 (cdnjs, pinned) is loaded only when a form is opened. If it cannot load, the preview shows in the browser's own PDF viewer.
- The workspace is drawn on the page body (a portal) with the `.mygfc` root class, so the app's header and bottom menu never sit over it.

## Must not undo
- **A preview is never a signed form:** no signature or e-signature line, a "PREVIEW · NOT SIGNED" mark on every page plus a line in words at the top, and secret numbers (SSN, TIN, A-Number, I-94) as their last four only.
- **A preview writes nothing:** no profile change, no Drive copy, no activity row, and the answers are never logged. It needs the legal address first, like signing.
- `payrollProfiles.previewValue` builds the same shape the strict normalizers save, leniently (a refused value is left blank). A test holds it equal to the strict result for complete answers, so the one fill code serves both.
- `govForms.FIELD_MAP` names the PDF fields per app answer key. A test checks every name is a real field on the template and every key is a `name=""` on an input in `my-pay.js`.

## Deviations from the plan
- The fills keep their own field names; the map and the fills are tied by tests rather than by the fills reading the map, which would have meant rewriting every fill.

## Verified
`test/form_preview.test.js` (4 tests through the real routes), `gov_forms` unchanged, one guard in `module_access` repointed. Removing the preview mark fails a test. Rendered in Chromium at 1440px and phone width with the box outlined. Full suite passing.
