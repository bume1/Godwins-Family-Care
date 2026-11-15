# The office can edit a training's policy line (2026-11-10)

**Owner ask:** "we should be able to also edit training item policies in the library."

## What changed
- Each training's "Ties to" line (document, sections, link) is editable in the Training Library row, beside the next step and office note.
- Stored in the existing `onboarding_training_materials` row as `office.policy`, through the existing `PUT /api/onboarding/admin/library/:moduleId/office` (admin and manager). No new collection, no new route.
- One rule decides what shows, `effectivePolicy` in `routes/onboarding.js`: the office's edit, else what an office-added training was given, else the catalog's (`onboarding/libraryCatalog.js`). Staff cards and the office table both read it, so they cannot disagree.
- "Use the Original" sends `policy: null` and goes back to the catalog line. The library row carries `policyEdited` and `catalogPolicy` so the screen can say what the original is.

## Must not undo
- An absent `policy` keeps the earlier edit. Saving only a note or next step must never wipe it; the screen sends the policy only when it changed.
- The link is https only, a document name is required; a refusal stores nothing.
- Staff see the policy line and nothing else of the office fields.

## Verified
- 1 new route test through the real router, 5 of 5 mutations caught. Full suite 3650, 0 failing.
- Rendered in Chromium at 1280: edited a policy, the table column and the original note updated, no page errors.
