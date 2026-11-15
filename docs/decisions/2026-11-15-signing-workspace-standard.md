# One signing screen: the document beside the fields (2026-11-15)

**Owner direction.** "Ensure the signing engine is the same as the one used for the financial docs: the visual of the document being signed, the field options beside it." Start with staff Documents to Sign, on its own branch.

## What changed
- **Staff Documents to Sign open full screen.** These are the PDFs the office sends from the admin hub, and staff see them in My GFC → My Documents, the caregiver app and the onboarding drawer.
  - The document is on the left, drawn page by page.
  - The tick box, name and signature are on the right.
  - The screen replaces the old inline box, which had them open the PDF in another tab and come back to sign.
- **The page that signing adds is shown before they sign.** After the document comes the "Electronic Signature Record" page their signing appends. It fills in half a second after they type their name or draw their signature.
  - It is marked **PREVIEW, NOT SIGNED** in words and across the page.
  - It carries no date and no network hash.
  - It comes from the new `POST /api/my/document-sends/:id/preview`, which uses the same gate and the same `buildSignedCopy` as the real signing. It writes nothing.
- **On a phone** the document sits above the fields, with Show or Hide Document.
- **One renderer.** `public/pdf-pages.js` turns a PDF into page images for both this screen and the tax form workspace, so pdf.js is loaded in one place and the two screens cannot drift.

## The standard for every signing surface
1. **Layout:** full screen, drawn on the page body so no header or menu sits over it.
2. **Arrangement:** the document on the left and the fields on the right; on a phone, stacked with the document on top.
3. **Preview:** a live preview of exactly what will be filed, marked not signed. It is built by the same server code that builds the signed copy, so the two cannot differ.
4. **Recording:** nothing is recorded until they press Sign or Acknowledge.
5. **Page images:** come from `pdf-pages.js` only.

**Still to move onto this standard:**
- the staff and caregiver welcome packets;
- the four caregiver forms;
- client consents in enrollment (wording still with counsel);
- the care plan co-signature;
- the Transfer-of-Care release.

The last two keep their drawn signature inside the same layout.

## Must not undo
- The preview route must stay write-free. A test checks that the whole store is unchanged.
- A signed copy must never carry the preview mark. A test reads the filed page back.
