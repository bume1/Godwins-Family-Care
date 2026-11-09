# The Portal Hub is the staff front door (2026-11-09)

Owner-directed. Key staff areas were scattered across modules with no clear breakdown. For example, caregivers are managed in the PHCP module while User Management and Enrollment live elsewhere.

## What changed

- **The hub is grouped by area, declared once.** `accountTypes.hubAreasFor(u)` is the one list. Both the hub (`login.html`) and the new staff bar read it, and `hubTilesFor` is now the same list flattened. `login.html` lost its own copy of the rules (`fallbackTiles`).
  - A saved login from before areas existed paints nothing until `GET /api/staff/hub` answers. It never guesses.
- **The areas are:**
  - **My GFC** (owner: "I like My GFC") — My GFC, plus Messages for managers and coordinators.
  - **People**, meaning our team — User Management (opened at `?group=staff`), Staff Onboarding, Caregiver Management and Caregiver Scheduling. The caregiver modules sit here "for now", per the owner.
  - **Clients**, meaning who we serve — Enrollment, and Client & Family Accounts (User Management opened at `?group=clients`).
  - **Clinical**.
  - **Billing**.
  - **Admin & Compliance** (Super Admin only) — Admin Hub, Audit Log (new on the hub), Service Portal, Client Portal Admin.
  - An area with no link for an account is left out.
- **Every internal staff member lands on the hub**, clinicians included (owner choice). Provider, RN, LCSW and LMSW / case manager used to land on `/clinical`.
  - Their hub is My GFC + Clinical, so this is one extra click each morning. Watch whether they mind.
  - Unchanged: caregivers (`/caregiver`), liaisons (`/my`), clients and family.
- **There is a shared staff bar** (`public/staff-nav.js`). It is plain DOM, the same pattern as `session-guard.js`, and sits on ten staff pages:
  - It shows a Portal Hub link, the area you are in, and an "All areas" menu.
  - It draws only for accounts whose landing is the hub, so caregivers, clients and family never see it.
  - It holds no role rules of its own.
  - It is **not on the Service Portal**: that page's fixed sidebar would cover the bar, and it is a legacy, Super Admin-only tool.
- **User Management has a Staff / Clients filter**, read from `?group=`.
- **The Admin Hub wears the My GFC frame.** It loads `/my-gfc.js` and renders inside `MyGFC.Shell`:
  - It gets the same sidebar, the phone menu along the bottom, the banner, and "Hi, Name".
  - `Shell` gained a `tag` prop (default "My GFC") so the sidebar can read "Admin Hub".
  - The old Tailwind sidebar is deleted. The Client Portal link moved to the hub and bar (Admin & Compliance).
  - The dashboard's stats and quick actions are now My GFC-style tiles. Its cross-module quick links are gone; the hub and the bar do that job now, so there is no third launcher.
  - The hub's own tiles stay, including the Super Admin-gated Audit Log tile.
- **`/api/staff`** is in `NON_PHI_PREFIXES`. It returns which screens an account can open, which is not PHI.
- **Fixed on the way:** the hub's "Your Portals" banner heading was dark on dark and could not be read.

## Not done (Phase 2, owner to order)

- **Caregivers:** one caregiver record in Caregiver Management. Pay, competencies and payroll docs move off the user form.
- **Clients:** one client record in Enrollment.
- **Duplicates:** remove the duplicate feed composer, and pick one home for Veterans.
- **Documents:** one documents view per person type.
- **Counts:** "waiting on you" counts on the hub areas.

## Verification

- **Tests:** `test/staff_hub.test.js` (7). Five account-type tests and four others were repointed, not deleted. Full suite: 3,382 pass, 0 fail.
- **Mutation checks:** 7 of 8 mutations caught. The survivor drops the "hide an empty area" filter, and no current account can produce an empty area, so it is a defensive no-op today.
- **Browser:** `scripts/verify_staff_hub_render.js` passes 24/24 in Chromium at 1440 and 390. It checks the hub's areas, the bar on Scheduling, and the Admin Hub in the frame, with no page errors.
