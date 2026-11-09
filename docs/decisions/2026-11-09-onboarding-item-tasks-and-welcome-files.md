# Onboarding: tasks as sub-bullets, and welcome-wizard files on their items

**Date:** 2026-11-09 · **Owner-directed**

- **Tasks under each item.** In both the admin Checklist and the staff member's Milestones, each item lists, without a click:
  - each step and who does it, with a done mark ("✓ Cara sends", "○ Payroll and Finance Officer verifies"; staff read "You send")
  - the documents to sign
  - what is checked
  - the files on record
  - course hours where the item is a course collection
  
  Clicking the item still opens the side panel to act. Home's short "Waiting on You" list stays compact.
- **One step wording.** `stepWho` and `stepVerb` are shared by the panel and the list. A `YOU_WORD` table gives the second person ("You send", "You verify"), never "You sends".
- **No "welcome packet" section in the list (owner).** Instead, what a caregiver sent or signed in the welcome wizard shows by itself on the item it belongs to, as files:
  - her uploads of the item's packet kinds, excluding rejected ones
  - the forms she signed in the app
  
  Ids are `packet:<doc id>` and `form:<kind>`. They also appear in the onboarding Documents tab. My GFC → My Documents already listed them.
- **Opening those files.** They open through the item's file route. Only her own files, of a kind that item names, are reachable that way. Uploads come from Drive; signed forms render through `welcomePacketPdf.generateSignedAttestationPDF`, the same renderer the welcome packet uses. Every open is audited.

## Verified
- 3 tests, including a route test against a memory store, with 6 of 6 mutations caught.
- Full suite passes.
- Rendered in Chromium: admin at 1440, staff at 390.
