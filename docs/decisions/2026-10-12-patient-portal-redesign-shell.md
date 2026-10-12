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

## Not built yet (owner-approved order)
1. Rest of the redesign: My Care Plan tabs, Appointments restyle, Messages "Ask a
   Question", Family & Caregivers (invite, staff confirm), Profile + insurance on
   file, sign-in and sign-up (pending until staff approve).
2. Test result values, ranges and trends.
3. Patient booking. 4. Video visits on Google Meet. 5. Billing and payments.

## Open for the owner
- The house photo for the banner (desktop shows a beige stand-in) and staff headshots.
- Where result values come from (staff entry, a lab feed, or the PDF).
- Booking: clinician working hours in the app, or request-and-confirm.
- Billing: Stripe account, what creates a bill, what "Financial assistance" opens.
