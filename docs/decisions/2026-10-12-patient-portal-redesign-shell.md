# Patient portal redesign, part 1: shell, Home, Test Results

**Date:** 2026-10-12 · **Owner-directed** (13 patient UI mockups sent 2026-10-12)

## What changed
- The unlocked patient portal has a new shell that follows the owner's mockups: a
  sidebar from 1024px up, and on a phone a top bar (menu, logo, bell) plus a bottom
  menu of **Home · Care · Appts · Records · More**. One `NAV` list drives the
  sidebar, the bottom menu and the More menu, so the three cannot disagree.
- New Home: time-of-day greeting, four tiles (Appointments, Messages, Test Results
  or Documents, My Care Plan), the next visit as a date-block card, the next two
  visits under it, the Latest visit card, recent messages, care team cards and
  recent activity.
- New screens: **Test Results** (filters All · Lab · Imaging · Other, shown only
  when something is under them), **Settings** (sharing + sign out), **More**.
- The gate, intake and record-release flows are unchanged.

## Must not undo
- **Brand stays the design system's** (owner, 2026-10-12: sent the existing logo).
  The mockups' different logo, darker navy and tagline were not adopted.
- **Results still say "Reviewed by" / "Not yet reviewed", never an app "Normal".**
  `ResultRow` is reused as-is. Result values, ranges and trends (mockup 13) are the
  next piece and are not built.
- **A result carries `kind` = its order type** (`lab`, `imaging`, …) or `outside`,
  never a raw value from the order row. `kind` was added to the result allow-list
  in `patientReadRepository.FILTER_MAP`; T4 pins the list, R1 tests the value.
- **Home shows both kinds of visit.** The mockup has one big appointment card; the
  next two visits are listed under it with their Clinical / Caregiver label, so a
  caregiver visit tomorrow never hides a clinical visit later in the week.
- Home reads message threads from `/api/messaging/threads` (unread count, previews).
  The Messages tab still loads through the shared component.
- No number is invented for a tile. A failed load says so; an empty one says
  "None scheduled" / "No new messages", never a bare 0.

## Verified
- Full suite 2045 pass, 0 fail. `scripts/verify_portal_render.js` 21/21 in Chromium
  across seven audiences (probe updated for the new menu labels and a results check).
- Mutations: `kind` dropped from the allow-list (T4, R1 fail); `kind` copied raw from
  the order row (R1 fails).

## Added in later commits on the same branch
- **Banner photo** (owner-supplied): sits behind the top of Home and fades into
  the page. Phone crop puts open sky behind the greeting and the building on the
  right (owner feedback, twice).
- **My Care Plan tabs** (Overview · Goals · Care Team · Documents). Service cards
  only for services the client is enrolled in: Home Care (PHC/BOTH), Primary Care
  (IHPC/BOTH), Care Coordination (a case manager is assigned). No Behavioral
  Health card: nothing on the record says a client is enrolled in it. Goals have
  no progress bars: nothing tracks progress. The signature pad moved to Documents.
- **One visit row** (date block + Clinical/Caregiver label) on Home, Care, calendar.
- **Messages: Conversations · Ask a Question.** The shared component gained two
  optional settings (`startCompose`, `hostStartsMessages`); other surfaces unchanged.
  `care_team_messaging` guard counts the new draft reset and pins its rule.
- **Family & Caregivers with invites** (`familyInvites.js`, collection
  `family_invites`, PHI, registered). Patient or POA invites; an ADMIN approves on
  the enrollment record, which creates a plain family account and emails sign-in.
  **Approving never makes a POA**; a patient saying so prompts staff to get the
  document. Probe `scripts/verify_family_invites.js`.
- **Profile** (`portalProfile.js`, `GET /api/gfc/profile`, client or POA only):
  contact details and insurance on file, **member IDs to the last four only**.

- **One sign-in page for everyone** (owner, 2026-10-12): `/login` restyled from
  mockup 1 for every role; the portal's own sign-in box redirects there.
  "Remember me" keeps the EMAIL only.
- **Self sign-up** (`/signup`, `signupRequests.js`, collection `signup_requests`,
  PHI). A request, never an account: email confirmed first (token hashed), an
  ADMIN approves as a new client / links as family of a client on file / declines
  with a reason. Approved clients start at `intake_pending`; a loved one's record
  has no login and the signer gets a family login, never POA. Sign-in reveals a
  pending request only to its password. Public routes are `/api/auth/self-signup`
  because `/api/auth/signup` is an old lab-tracker admin route. The rate limit is
  per hashed address from X-Forwarded-For, so it is a speed bump, not a wall.
  Probe `scripts/verify_self_signup.js`.

## Not built yet (owner-approved order)
1. (Redesign part 1 is complete.)
2. Test result values, ranges and trends.
3. Patient booking. 4. Video visits on Google Meet. 5. Billing and payments.

## Owner answers (2026-10-12), and what is still open
- Photo: supplied and in use. Staff headshots: still to come (initials until then).
- Results: values are read from the lab PDF with Gemini and trended; any high/low
  flag comes from the lab's own report. **Open:** Gemini must run through Vertex AI
  (BAA-covered), not the Gemini API; confirm it replaces the planned Bedrock reader;
  confirm whether a person checks values before a patient sees them.
- Booking: clinicians set availability in the app; a clinician or care coordinator
  confirms, which writes to OpenEMR; the clinical Google Calendar mirrors visits the
  app books (not ones made directly in OpenEMR).
- Video: Google Meet, created with the calendar event.
- Billing: no Stripe account yet; any Stripe account works if no PHI reaches it.
  **Open:** what creates a bill, and what "Financial assistance" opens.
