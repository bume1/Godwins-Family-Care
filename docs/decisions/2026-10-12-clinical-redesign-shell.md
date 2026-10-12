# Clinical workspace redesign, part 1: shell, My Day, Patients

**Date:** 2026-10-12 · **Owner-directed** (12 clinician UI mockups sent 2026-10-12)

## What changed
- **Shell.** Laptops get a navy sidebar with gold active items and count badges on Inbox and Results. Phones get a top bar plus a bottom bar of **My Day · Patients · Inbox · Messages · More**. One `NAV_VIEWS` list drives the sidebar, the bottom bar and the More page.
- **Every view kept.** The sidebar's main group is My Day · Patients · Inbox · Results · Messages · Reports (Reports is Analytics). Schedule, Coding, Overdue and Tasks sit under **Work**. Settings is at the foot.
- **Patients is its own page.** It's a table on a laptop and cards on a phone, replacing the old left column. That removes the collapsible panel and the phone overlay.
- **Messages in the sidebar.** This is the shared component mounted without a client, so it has its own client picker.
- **Settings.** The OpenEMR sign-in, the enrollment link and sign-out live here now, instead of crowding the top bar.
- **My Day, two panes.** On the left, the schedule with Schedule · Due Nearby · Map tabs. On the right, **Visit Details** with Pre-Visit · Chart · Directions tabs, built from the same pre-visit read as the full packet. The visit buttons (En route, Arrive, Start, End, Start video visit, Navigate) moved into that pane with every gate unchanged. The panes sit side by side from 1280px; below that the list and the details take turns.
- **Restyled to the portal's v2 look:** `.card`, `.btn`, `.inp`, `.chip`, `.lblu` and `.tabbtn`, with Tailwind's `stone` greys remapped to the brand's warm greys. Screens not yet rebuilt pick up the new look with no JSX change.

## Must not undo
- **Nothing invented.**
  - The Patients table shows only what `/api/clinical/patients` serves. There are no last-visit or next-visit columns, because those need an OpenEMR read per patient.
  - Visit Details shows no medication count, because the pre-visit packet carries none.
  - A failed Inbox or Results read shows no badge rather than a guessed number.
- **The brand stays the design system's:** the full logo in white on the sidebar and in colour on the phone. The mockup photos are not used; avatars are initials.
- **"Place of Service" is not shown to clinicians** (a mockup asked for it on New Encounter; that screen is part 3 and will say "Visit location").
- **`css/gfc-tokens.css` is NOT linked.** Its global 18px body and large h1–h4 would break the dense clinical screens.

## Not built (mockups ask for them)
- Lab values, reference ranges, High/Low flags and trends. The app stores the result document and its review state, not values.
- Favorites and "My Panel": nothing records which patients belong to which clinician's panel. Recent is a per-browser list.

## Verified
- Full suite 2257 pass, 0 fail.
- Four guards in `test/clinical_workspace_412.test.js` were repointed, not deleted. They now protect the same rules: every view declared once, every view reachable on a laptop and a phone, and the content column never collapsing to zero width. Four mutations each fail one: a view with no group, More listing the wrong views, the content track losing `minmax(0, …)`, and a view dropped from the list.
- The page compiles (esbuild). It was rendered in Chromium with real Tailwind at 390, 1024, 1440 and 1920px, as a provider and as a read-only viewer. My Day, Patients, a chart, Inbox, Settings and More all rendered with no page errors and no horizontal overflow.

## Next (as written before Parts 2 and 3)
- Part 2: the chart (header, tab strip, Overview grid, Results table without values, phone chart menu).
- Part 3: Inbox and Results restyle, the phone visit checklist, New Encounter on a phone, Care Plan, Messages tabs.

## Part 2: the patient chart (same branch, same PR)
- **Header:**
  - A large initials avatar and a serif name. Status (Active / Enrolling) and care-type chips. DOB (age), sex, MRN and MBI on one line.
  - Message, Start visit / Resume draft, and a More menu holding Refresh portal chart and the address/contacts/insurance details.
  - The allergy strip stays under the header on every tab. Start visit and Refresh stay write-gated, and Facility & POS stays billing-only.
- **Tabs:** the gold-underline strip on a laptop. On a phone, a "Sections" tap-through list built from the same `tabs` array (mockup 9).
- **Overview:** eight cards (Demographics, Active Problems, Current Medications, Allergies, Latest Vitals, Care Plan, Last Encounter, Coverage).
  - Each card reads only what the chart read already returns, plus the care-plan read `CarePlanTab` already makes.
  - A card with no rows says why: not linked, not enabled yet, a failed read, or nothing on file.
  - Latest Vitals shows a dash for any vital it did not read. The unit is the reading's own, never one the page assumes.
- **Results tab:** a table of Date · Test · Flag · Status · Reviewed by, with filters by kind and status. **No value, reference range or trend column**: the app stores none. The Flag is the interpretation recorded on filing, or "Not set".
- **Verified:**
  - Full suite passes, including `test/clinical_redesign.test.js` (6 tests). Six mutations each fail one: a dash invented for a missing vital, the oldest reading winning, a value column added, Start visit ungated, the phone menu not switching tabs, and an unset flag read as Normal.
  - Rendered in Chromium at 1440 and 390 (Overview, Results, the phone section menu): no page errors, no sideways scroll.
  - Babel now notes the page script is over 500KB. It's informational, not an error.

## Part 3: work screens, wiring and button labels (same branch, same PR)
- **Inbox (mockup 7):** All · Co-Sign · Orders · Other filters by item kind. Who may act stays the server's `actionable`.
  - **Wiring fix:** "Open Care Plan" used to open the chart's Overview. It now opens the Care Plan tab.
- **Results inbox (mockup 8):** grouped Critical, then Needs Review. Each row opens to the unchanged acknowledgement controls plus an Open Chart button that lands on the patient's Results tab. No result values are shown.
- **Visit checklist (mockup 6):** each Key Information line in Visit Details opens its chart section (Problems, Allergies, Orders, Referrals, Results, Care Plan).
- **Care Plan (mockups 11 and 12):** problems, goals, a collapsible Tasks list and Visit Schedule. Goals are a list, not checkboxes, because nothing records a goal as met. Writing a new version sits behind a "Write Version N" button.
- **Messages (mockup 12):** Patient / Care Team tabs on the chart.
  - The server marks each thread and channel `withPatient` (`messagingRepository.withPatient`, read from the channel's own participants). The shared component takes an optional `audience` option and only filters on that mark.
  - No channel list is restated on the page.
- **Chart tabs** wrap to a second row instead of scrolling the open tab out of sight.
- **Button labels (owner rule, 2026-10-12):** every button is short and Title Case, with small joining words in lower case. Sentences and status chips stay in sentence case.
  - Applied across `clinical.html`, `portal.html`, `admin-hub.html`, `admin-enrollment.html`, `caregiver.html`, `scheduling.html`, `caregivers.html`, `login.html`, `upload-link.html` and the messaging component.
  - A guard in `test/clinical_redesign.test.js` fails the build on any sentence-case or over-five-word button in the clinical app. It covers the clinical page only; the other pages were fixed by hand this pass.
  - Seven older tests that matched the old wording were repointed to the new labels, keeping the rule each one protects.
- **Verified:** full suite 2267 pass, 0 fail. Five mutations each fail a new guard (care-plan routing dropped, Results opens the chart without a tab, a checklist line unwired, the messaging filter ignored, a sentence-case label). Every edited page compiles. Rendered in Chromium (Inbox, Results, Care Plan, Messages, phone My Day and Inbox) with no page errors and no sideways scroll.
