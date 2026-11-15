# Attach a document to sign on any onboarding item

**Date:** 2026-11-10 · **Owner-directed:** "upload files for view and signature to onboarding items"

## What it does
- **The office attaches it:** "Attach Document to Sign" in the office side panel of any item that has a step for the person. Choose a PDF, and Sign or Acknowledge.
  - It goes to **that person only** (owner choice).
  - It is the same send as Documents to Sign (`staff_document_sends`), linked to her item as `rec.items[id].document`.
- **She signs it:** she signs from the item, or from My Documents.
  - Attaching it records any office step before hers (e.g. "Executive Director issues" the offer letter). Signing completes her first step on the item, and the signed copy (the original plus a signature page) is filed to her Documents and attached to the item.
  - Mark Done is refused on that step (`DOCUMENT_SIGN_ROUTE`).
- **Policy items** that complete through their own acknowledgment list (C.5.04 and similar) still do. The signed document is filed alongside.
- **Fixed on the way:** a signed copy on an item now opens. Item files that point at her Documents row are read from that row's Drive file, which fixes custom tasks too.

## General trainings reported missing
On a real server with the memory store, people created through the admin API were started through the office route:
- a caregiver
- a manager
- a provider
- a liaison

All four showed all six general trainings, in their own Training tab and in the office's view of them. Not reproduced. A screenshot of the live view where they're missing is needed.

## Verified
- `test/onboarding_item_documents.test.js` (3 tests, both routers on one store): attach, Mark Done refused, sign, step complete, the copy opens as 2 pages, another person untouched, a document sent to someone else refused, office-only.
- 6 of 6 mutations caught.
- Full suite 3670, 0 failing.
- Chromium: the office side panel shows the button and form.
