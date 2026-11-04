# Billing as its own page, one coding area, and a quieter clinical workspace

_2026-11-04 · owner-directed: "Billing needs to be its own page, wired into the billing area we are optimizing in the app. Then note we have two coding areas in the encounter chart as of now that needs to be resolved to one. And I agree with all other fixes mentioned … ensure our billing area is properly connected to open EMR, as the claims pushed to open EMR will be pushing to our clearing house once setup."_

**What was wrong.**
- Billing worked a claim inside the clinician's chart: 15 tabs, the banner and the AI review, then down to a Billing card under the note.
- A signed encounter had two coding areas: Diagnoses & Services on the Coding step, and the Billing card's E/M level, code helper and claim scrub further down.
- It also had two places to sign: each note editor carried its own sign box, as well as the encounter's Sign card.
- A visit could be started five ways, and three different buttons were all called "Start Visit".
- The sidebar had 13 items, and old OpenEMR setup warnings sat over every clinician's screen.

**What changed.**

- **The claims workspace is the Claims tab of `/billing`.** Billing's stages are listed beside the open claim. The claim reads top to bottom in the order it is worked:
  - **Before This Claim Goes** (the claim scrub, used as the to-do list; each finding links to the section that fixes it)
  - Codes
  - E/M Level
  - Place of Service
  - Submit to Billing (or No Charge, or the admin's insurance override)
  - **Charge Lines in OpenEMR** (read back from OpenEMR, with void and re-post)
  - the Signed Note
- **The billing page uses the same routes as before.** It calls the existing `requireBilling` routes and adds no server rule of its own. Settings (billing NPI, practice favorites) moved there from the Coding queue.
- **"Is billing connected to OpenEMR?" has an answer.** `billingConnection.js` (pure) and `GET /api/clinical/billing/connection` (`requireBilling`) check each link the app can see:
  - the caller's own OpenEMR sign-in
  - the billing scopes on that token
  - the billing NPI
  - the billing facility's NPI, EIN and taxonomy in OpenEMR
  - the code catalog
  - the NCCI tables
  - Each check reads `ok`, `blocked` or `unknown`. **Unknown is never a pass.**
  - The clearinghouse reads `outside`: it is wired to OpenEMR's Billing Manager, which the app cannot see, so it is stated and never claimed.
- **OpenEMR's sign-in can return to the billing page.** `beginAuthorization(user, { returnTo })` stores an allow-listed page (`/clinical` or `/billing`) on the state row. The callback maps it through the same list again. Nothing in the query string picks the landing page.
- **The queue has billing's history.** `released` (ready for Billing Manager) and `no_charge` filters, for billing only.
- **One coding area on the encounter.**
  - Diagnoses & Services is the clinician's before signing. After a clinician signs, only the clinician addendum reopens it.
  - Billing's service codes, the level, the code helper and the scrub are on `/billing`.
  - A signed encounter shows a Billing pointer with **Open in Billing** (`/billing?client=…&encounter=…#claims`), for billing only.
- **One sign card.** `SignNotePanel` is deleted. The note editors' Sign & Submit saves, then opens the encounter's Sign card. Visit Facts and Modifier Reasons sit just above the Sign card.
- **One way to start a visit.**
  - The banner's **New Visit** opens the visit screen. When it was not opened from an appointment, the screen asks which appointment the visit is for, or "unscheduled".
  - The Document a Visit popup (`FollowUpModal`) is deleted. Its Follow-up default moved onto the visit screen: once the initial visit is done, Follow-up is preselected, so a follow-up never saves as an H&P.
  - My Day's Start Visit records the start time **and** opens the note. The pre-visit card's button is now **Open Chart**.
- **One step at a time at every width.** The step rail shows on laptops too. Every step stays **mounted** and only the current one shows, so a note half-typed on Visit survives a look at Coding.
- **Fewer places.**
  - Chart: Encounters and Appointments are one **Visits** tab. Imaging and Referrals are filters on **Orders**.
  - Sidebar: Results and Overdue are Inbox tabs, and Coding is a **Billing** link drawn only for billing.
  - The old names (`#results`, `#overdue`, `#queue`, tab `encounters`/`appts`/`imaging`/`referrals`) are aliases, so no link strands.
- **Setup warnings** (outdated OAuth client, no billing NPI) moved to Settings, admin only.
- **Shared, not copied.** `public/components/claim-shared.jsx` holds the signed-note view, the signature, the code search and the service-line editor. Both pages load it as `<script type="text/babel" src>`.

**Must not undo:**
- The clearinghouse is never reported as connected by the app. A check it could not run is `unknown`, never `ok`.
- The OAuth landing page comes only from the allow-list in `emrAuth.js`, checked on the way in and on the way back.
- No billing control returns to the encounter. Billing saves the clinician's diagnoses unchanged (the server refuses a change with `DX_LOCKED_AFTER_SIGN`).
- Encounter steps hide; they do not unmount.

**Verified.**
- `test/billing_page.test.js`, 18 tests.
- 28 existing guards repointed at the new shape, not deleted. The popup's rules now guard the visit screen.
- 15 deliberate breaks, each confirmed to fail a test. Two did not fail at first and the tests were tightened: the allow-list check on the stored state row, and FixLink's no-link case. One break was badly written by me (a component nested on a single line); written properly, it fails a test.
- Full suite 3026 pass, 0 fail, after merging main (PR #241: its "Suggested, review" tag on pre-filled lines now shows in the shared service editor, so billing sees it). All three pages compile.
- Probes:
  - New `scripts/verify_billing_render.js`, **21/21 in Chromium**: the connection card, a claim worked end to end, the Settings tab, the clinical sidebar for billing and for a clinician, and the encounter's Open in Billing link.
  - `verify_soap_note_render.js` **23/23** (updated for New Visit and the steps).
  - `verify_referrals_render.js` **31/31** (Referrals is now an Orders filter).
  - `verify_note_lifecycle.js` **262/262** over real HTTP, including the Released list and the connection route.
- **Not proven from here:** a real OpenEMR answering the connection checks, and a clearinghouse.

**Open for the owner:**
1. **Set up the clearinghouse in OpenEMR** (Availity under Administration → Practice → X12 Partners), then generate claims from Billing Manager **only for claims released on the billing page.**
2. **Each person who bills signs in to OpenEMR from the billing page once.** Charges post under the login of whoever presses Submit.
3. Fill in the billing facility's NPI, federal EIN and taxonomy in OpenEMR, then press Sync Facilities. The connection card names whichever is missing.
4. Rebuild the container on the EC2 box. Nothing here is live until then.
