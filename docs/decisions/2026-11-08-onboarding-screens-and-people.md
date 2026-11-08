# Onboarding screens, the People block, and #260 retired

Owner, 2026-11-08: build the screens from the clinician dashboard as the visual model, with no further mockups. Onboarding goes on the Portal Hub, inside a new **People** block that also holds User Management, shaped like Private Home Care.

## What changed

- **`/onboarding` is one page with two views.**
  - **Office:** the command center, with whose turn it is, the pipeline, each person's six-phase board, the item drawer, the credentialing record, readiness, training, activity and setup.
  - **The new hire:** a phone-first wizard with Home, Milestones, Training and Documents.
  - The server decides which view to show (`/api/onboarding/me` → `viewer.isOffice`), never the browser's stored role.
- **New routes at `/api/onboarding/*`** (`routes/onboarding.js`) over the `onboarding/` engine. Her door resolves her from the session, and no `/me` route takes a user id.
- **People block on the Portal Hub** (`accountTypes.hubTilesFor`):
  - User Management opens `/admin?view=users`.
  - Staff Onboarding opens `/onboarding`, for admin and managers only, which matches the route gate.
  - User Management left the Super Admin's Admin Hub menu, and still shows while it's the page being viewed.
  - Managers and coordinators get People in place of their separate User Management tile.
- **GFC's three service lines group the readiness gates.**
  - Veteran Exams (IME).
  - In-Home Primary and Psych Care: private pay, insurance billing (payer by payer) and psych care.
  - Private Home Care, which belongs to caregivers and nurses and so has no clinician gate.
- **#260 is retired.** Removed:
  - its route file, page and test file
  - both of its verify scripts
  - `clinicianTrack.js`, `clinicianTraining.js`, `clinicianResources.js` and `clinicianPrivileges.js`

  `clinicianItems.js` and `clinicianOnboarding.js` stay, because the carry-over reads their titles. #260's records in `clinician_onboarding` are read, never written.

## What a later session must not undo

- **⚠️ NO PLAYBOOK CODE ON A SCREEN.** Phases show "Phase 1 · Pre-Hire Screening". Build-enforced in `test/onboarding_page.test.js`.
- **⚠️ "WAITING ON YOU" ONLY ON HER OWN SCREEN.** The office reads her first name.
- **⚠️ HER "WAITING ON YOU" LIST FOLLOWS THE PHASES.** It shows her current phase, plus Credentialing once she reaches the offer, because the Playbook starts it on the day she signs.
- **⚠️ SHE ACKNOWLEDGES AT THE VERSION THE SERVER STATES.** The office may file an older signed copy at the version printed on it, and it then reads stale.
- **⚠️ ACKNOWLEDGED DOCUMENTS LINK THEIR CANONICAL COPIES IN POLICIES / CURRENT.** #260 linked duplicates in another folder, including a superseded Clinical P&P v2.0 (`1R9P…`).
- **Every route is spelled out in full in the page (`PATHS`),** so the orphan-route guard can see it. Spaced re-checks were left out because they have no screen yet.
- **A Drive file id never reaches the browser.** Files open through the app.

## Verified

- `test/onboarding_routes.test.js`: 11 HTTP tests through the real router.
- `test/onboarding_page.test.js`: 5 build guards.
- The account-type and People tests.
- Full suite: 3232 passing, 0 failing.
- Rendered in Chromium as the office at 1440px and the clinician at 390px: no page errors, and no Playbook code in the text.

## Open for the owner

1. **Stray copies in Drive:**
   - #260's duplicate policy files in folder `1e6hBmu…` should be removed under Admin P&P §17.2.
   - The Regulatory Compliance Reference is still in Policies / Current, and the prompt says to withdraw it.
2. **The Private Home Care P&P in Drive is v3.1;** the Playbook names v3.0. This matters when Chapters A and B are built.
3. **Spaced re-checks** (days 3, 10, 30, 90) need their screen before they come back.
4. **#260's privilege list** has no equivalent in Playbook v3.0, which records an approved scope per service line instead. It was retired with #260.
