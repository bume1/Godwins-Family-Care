# Staff know when a document is waiting on them

**Date:** 2026-11-13 · **Owner report:** "documents sent for signature don't appear in the staff portal for their awareness ... the banner still shows that nothing is waiting for them when there is."

## What was wrong
- **The routing was fine.** `staffDocumentSends.forPerson` and `GET /api/my/document-sends` returned the document to the right people.
- **Nothing told the person about it.** It sat in My Documents → Waiting on You, which only someone who opened that tab would see.
  - Home said nothing.
  - The caregiver onboarding card read "Nothing is waiting on you", or "Everything on your checklist is in" for a cleared caregiver.
  - No email went out.

## What changed
- **`useStaffData` (public/my-gfc.js) loads what is waiting** and exposes it as `waitingDocs`.
  - Signing reloads it, so the banner clears at once.
- **One Home banner, `MyGFC.DocsWaitingBanner`, on My GFC and the caregiver app:**
  - it reads "Document to sign: {title}", or "N documents waiting on you"
  - clicking it opens My Documents
- **The menu shows the number waiting** on My Documents. On a caregiver's phone, the number shows on More.
- **The caregiver onboarding card counts waiting documents as "waiting on you".** It never says nothing is waiting while a document is.
- **An email goes out when a document is sent** (`notifications.staffDocumentSent`).
  - It reaches each person the send covers at that moment.
  - It names the document and links to their own Documents (`appLinks.documentsFor`): `/caregiver#documents` for caregivers, `/my#documents` for everyone else.
  - The file is never attached.
  - Someone added to a type later sees the document on Home.
  - This answers the "no email" item left open on 2026-11-09.

## Verified
- `test/document_sends_awareness.test.js`: 5 tests through the real router and the real notifier.
- 8 mutations, all caught. One survived the first pass, and the test now checks that the list loads when the page opens.
- Full suite passing.
- Chromium on a real server: a document sent to caregivers and managers showed the banner on both Homes, the menu showed a count, and clicking the banner opened Waiting on You.
