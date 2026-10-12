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

## Next (owner picks)
- Part 2: the chart (header, tab strip, Overview grid, Results table without values, phone chart menu).
- Part 3: Inbox and Results restyle, the phone visit checklist, New Encounter on a phone, Care Plan, Messages tabs.
