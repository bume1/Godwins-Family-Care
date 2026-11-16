# Document Links: the app follows the Drive file the Super Admin chooses (2026-11-16)

**Owner:** Drive's Manage versions "isn't working, it's too many manual steps. Simply upload the new version and replace the links in the app ... not hardcoded; in the field I can also swap out links."

## What changed
- **Training Library → Document Links** lists every SOP set, manual, policy and guide the app opens, with Open, **Change Link** and **Use Default**. Paste any Drive link (or a bare file id). The office sees the list; only the Super Admin changes it (`DOC_LINK_SUPER_ADMIN`). Every change is logged (`document_link_changed`, before and after ids).
- **One change moves every place the document opens:** training cards and their material links, the "Ties to" policy links, the staff Policies list, the policy signing screen (its PDF is drawn from the file), the Staff Pay Guide on every Pay Setup step, and the live SOP reads.
  - `onboarding/sources.js`: `driveFileId` is a getter (override, else the default written there). `PAY_GUIDE.url` likewise.
  - Policy lists in every chapter go through `linkAll` / `linkedAck`: a policy with its own file is keyed `policy:<id>`; a policy whose file is a source document follows that source.
  - Training links seeded before a change are re-resolved on every read (`DEFAULT_SOURCE_BY_LINK` in `trainingMaterial.js`), since the stored row holds the url current when it was seeded.
- Stored in `document_links` (registered, not PHI), applied at boot and after each change.
- Admin SOP Sets 5 and 6 added to the list. Set 1's default now points at the v2.0 file uploaded as a new file in Current (`1QYhVaYr5lawntGbBPZKyFCtNfUCwVQqs`); the old v1.2 file was moved to Trash, with a copy in Superseded.

## Not changed
- A signed copy already filed keeps the text that was signed. Changing a policy's link changes what is offered next, never a past signature.

## Verification
- `test/document_links.test.js`: 5 tests through the real router (link shapes, one change reaching source, training link and policy, store + apply + reset, refusals with nothing stored, applied at boot). Two pinned tests repointed at the new Set 1 id. Suite 3,930, 0 failing.
- Rendered in Chromium: the list, Change Link, Save Link and the confirmation, no page errors.

## Must not undo
- No document link is written as a literal outside `onboarding/sources.js` and the chapter policy lists, and those are defaults only.
