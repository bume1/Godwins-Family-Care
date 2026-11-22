# The offer letter is the first onboarding step, for all staff

**Date:** 2026-11-19 · **Owner-directed** · Branch `claude/new-session-tk5fp9`

## What the owner asked
"I want to be able to send offer letters to employees I am hiring ... add a step to the onboarding process for all staff and that is viewing and signing their offer letter document ... a seamless transition for them into the myGFC area and then other areas of the app." Also: "make sure the offer letter shows like our doc viewer has been built! branding should be in alignment with the mygfc area."

Owner answers:
- The new hire gets one email link. They set a password, then sign.
- Until it is signed, the offer is the only screen.
- They may decline, with a note.
- All staff, caregivers included.

## What was wrong
- An offer could only reach someone once they were an active user and their onboarding was open.
- The offer sat in Phase 2, behind pre-hire screening.
- A new hire's first contact was a temporary-password email.
- Caregivers could not sign an offer in the app at all: A.5.01 had no new-hire step, so the attach button never showed.
- The office was never told when anything was signed.

## What was built
- **The office sends the offer.**
  - **New Hire** on Staff Onboarding makes the account (random password nobody sees, no welcome email) and sends the PDF in one step.
  - For anyone already on file, the **Offer Letter** card on their onboarding page sends it.
  - The card shows Sent, Signed or Declined with their note, plus **Resend Link** and **Send New Version**.
- **Sending reuses what exists** (`routes/staffOffers.js`).
  - The PDF becomes an ordinary document send to one person (`staff_document_sends`, flagged `offer: true`).
  - It is attached to the chapter's offer item by `attachToItem`, which is now the one function the existing attach route also calls. The Executive Director step is recorded.
  - The onboarding record is opened if needed, without the "your onboarding is ready" email.
- **Offer item by chapter:**
  - A.5.01 (caregiver)
  - B.5.01 (registered nurse)
  - C.5.01 (clinician, and E, which reuses it)
  - F.5.01 (admin team, and G, which reuses it)
  - D.4.02 (the contractor agreement)
  - R1.1.01 (the physician agreement)
  - None for H, the student placement.
- **A.5.01 gained a new-hire SIGN step**, so caregivers sign in the app. The welcome packet's offer upload stays as the paper backup.
- **One email, one button.**
  - "Your offer from Godwins Family Care" carries a `passwordSetLinks` link with the new `offer` purpose: 7 days, one use, only its fingerprint stored.
  - It is sent straight out, never queued, because it carries a sign-in link.
  - Using it sets the password and signs them in through `finishLogin`, so a role that needs MFA still gets its step. They land on `/offer`.
  - Other link purposes are unchanged and still send people to sign in.
- **`/offer` is My GFC's front door.**
  - It uses My GFC's Shell, header banner, cards and fonts. Shell gained `hideHub` and `hello`.
  - It shows the offer, the office's note, **Review and Sign** and **Decline Offer**, and what happens next.
  - The offer opens in the same viewer every document is signed in (`GFCDocSign.SignWorkspace`), and signs through the existing sign route.
- **The gate is on the server** (`authenticateToken`).
  - While an offer is pending, every API call except sign-in/out, `/api/my/offer*` and the offer document's own file/preview/sign answers 409 `OFFER_PENDING`.
  - `session-guard.js` sends any page that gets that answer to `/offer`.
  - Sign-in lands on `/offer` ahead of the welcome packet, and ahead of the hub button.
  - "View as" is exempt.
- **On signing:**
  - The offer reads `signed`, the item's step and signed copy are recorded as before, and the office is emailed (`staffOfferSigned`).
  - The person goes on to `/my#welcome`, or `/caregiver` for caregivers.
  - A caregiver's signed copy is filed as kind `offer_letter`, so welcome packet item 16 reads complete.
- **Declining:**
  - The note (500 characters) is kept on the offer and emailed to the office (`staffOfferDeclined`), never written to the activity log.
  - The account is switched off and sessions revoked, and the send is withdrawn.
  - **Send New Version** switches the account back on and emails a new link.
- **Nobody already working is affected.**
  - No `offer` field means no gate.
  - Once someone has signed an offer (`everSigned`), a later new version (new terms, promotion) goes to My Documents like any document and never locks them out.

## Verified
- `test/staff_offers.test.js`: 16 tests.
- **9 deliberate breaks, all caught:**
  - the gate removed
  - the gate blocking the offer routes
  - decline leaving the account active
  - another document settling the offer
  - a 1-hour offer link
  - existing staff gated
  - the caregiver offer unsignable
  - the welcome packet outranking the offer
  - the sign route not settling it
- `scripts/verify_offer_flow.js`: **55/55** through the real routes, with Drive and email held in memory.
  - It covers an RN, a caregiver and a decliner end to end, including the signed copy, the onboarding item, office notices, the activity log and a new version after signing.
- Rendered in Chromium at phone and laptop width, with a sample letter: the email, set password, the offer page, the viewer, signing, signed, decline, declined, the three office card states and New Hire.
- Full suite: 4,023 tests, 0 failing (1 skipped). `scripts/verify_password_reset.js` still 28/28. All edited pages compile.
- **One real bug caught by the suite, not the probe:** the caregiver offer-letter filing change first landed in the policy signing route too, where it threw. It is now in the document sign route only, and a test pins it there.

## Not proven from the sandbox
- Real email delivery. As always, it is proven by the first real send.

## Open for the owner
- New Hire lets a manager or care coordinator create caregiver accounts only, the same rule as the user form. Staff of other types are created by the Super Admin.
- The decline note is plain text to the office. If a decline should also notify someone else (HR, the hiring manager), say who.
