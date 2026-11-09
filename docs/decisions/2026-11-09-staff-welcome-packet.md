# Staff welcome packet, and every completed packet in User Management

**Date:** 2026-11-09 · **Owner-directed**

## What changed
- **Every non-caregiver role now has a welcome packet**, in exactly the caregiver packet's format: the same field renderer, signature pad, step cards, progress bar, sign step and signed PDF. It lives in My GFC → Welcome Packet, with a Home prompt until it is signed.
- **The steps:**
  1. About You: the caregiver packet's own fields, minus date of birth.
  2. Emergency Contact.
  3. Your Availability: the shared availability form, so it lands in their scheduling area and can be updated later under Hours & Pay → My Availability.
  4. How You Learn and How to Reach You.
- **No references and no start date** (owner: references are already checked, the start date does not matter here).
- **The admin team sees any completed packet, caregivers' included,** on the User Management edit form: status, signed date, an Open Completed Packet download, and the answers. `GET /api/my/admin/welcome/:userId` and `.../signed.pdf`, `requireAdmin`, each read audited.
- **Availability is open to every staff type** (admin, manager, coordinator, clinicians, liaison), not only caregivers and clinicians. For a liaison, submitting it records their own step on G.3.01.

## Must not undo
- **One packet UI.** `public/welcome-packet-ui.js` holds `PacketField` and `SignaturePad`; the caregiver app and My GFC both read them. A second copy is how the two packets drift. Build-enforced.
- **Staff packets live in their own collection** (`staff_welcome_packets`, not PHI), so caregiver code never meets a staff row. A caregiver asking for the staff packet gets 409 `WELCOME_CAREGIVER_PACKET`.
- **A signed packet takes no edits** (409 `PACKET_SIGNED`), and signing needs availability on file plus a drawn signature. Signing is blocked while viewing as someone else.

## Found on the way
- **The admin hub's `bg-primary` / `text-primary` were colorless in about nineteen places.** The Tailwind `primary` palette had numbered shades only, so the bare name produced nothing (white text on white). It now has `DEFAULT: '#033D50'`, the brand navy, the same as `primary-500`.

## Verified
- 6 tests in `test/staff_welcome_packet.test.js`, 6 of 6 mutations caught.
- One existing test repointed: a coordinator can now post their own availability.
- Full suite 3394, 0 failing.
- Rendered in Chromium: the staff wizard walked end to end at 1280 and 390, signed and stored; the admin card for a staff member, a caregiver and a not-started liaison, with the PDF downloading for both packet kinds; the caregiver app's own packet unchanged.
