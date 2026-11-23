# 2026-11-23 — The website's Sales Portal moves into the app

**Owner request (Dr. Bianca Ume, 2026-11-23):** the public website is down, so the Sales Portal moves into the app as-is, behind the staff login, so the Community Care Liaison has one place to work.

## What was built
- `/sales` is a thin frame. Each section is the website's own page, served by `GET /sales/doc/:id` from `sales-portal/docs/` and shown unchanged: Home, Start Here, Playbook, Script, Pay Sheet, Targeting Map, Task Board, Emails.
- **Source copy:** the Oct 8 Drive copy, not the uploaded `template-gfc-sales-portal-PATCHED-2026-10-01.php`. Oct 8 is newer: map column filters and a Beds column, scoreboard date fixes and the "What counts" legend, the rewritten PCH/IL scripts, the Start Here glossary, and payer-lane wording. The Oct 1 copy's payer-lanes image was removed in Oct 8 and is not carried.
- **Every link stays in the app.** `salesPortal.rewrite()` turns `?gfc_doc=X` into `/sales#X`, the website's "Log out" into an app sign-out, and deck/brochure links into `/sales/files/:name`. The four decks and the brochure (Outside + Inside merged) ship in the image; `.dockerignore` gains `!sales-portal/files/*.pdf`. A test fails if any page still links to the old site.
- **Who has it (no one else's access changed):** the new `sales` module in a new `growth` area, on by default for the Community Care Liaison and managers; the Super Admin has every module. A coordinator gets it only as a grant. Everyone else is refused (`SALES_PORTAL_ONLY`).
- **Frames can't carry a Bearer token**, so `GET /api/sales/portal` issues a 12-hour ticket naming the user and session. Each `/sales/doc` and `/sales/files` request re-checks that the session is live, the account is active, the offer is signed and the sales module is still held. Signing out kills the ticket at once. A small script in each page tells the app's idle timer about activity inside the frame.
- **The shared password `saleswinner2026` is retired.** The staff login is the gate.
- **Emails** read the Notion "Email Templates" feed server-side. `GFC_TEMPLATE_FEED_URL` carries a token and never reaches the browser; the Notion copy is cleaned to the old `wp_kses` rules. Cached five minutes, last good copy kept for 24 hours.

## Out of date, flagged and NOT changed (port is as-is)
- The Playbook names Rippling for payroll. Gusto is the system of record.
- The Playbook says "Never share the password." There is no shared password now.
- The social services deck cites an article URL on the website that is down.
- The Apps Script backends (map, task board, scoreboard) are called exactly as before, with their token in page JS. Fine behind login; worth moving server-side when the related scripts are worked on.

## Owner actions before it works fully
- Set `GFC_TEMPLATE_FEED_URL` on the EC2 box (value from `showTemplateFeedUrl()` in the sequence engine Apps Script), then rebuild. Until then Emails says "Not connected yet".

## Plan (not built) for the rest of the website
1. Inventory every page and script on the site and sort each into public marketing, staff-only, or retired.
2. Staff-only pages follow this pattern: their own area module, served from the repo, links rewritten, Apps Script calls moved behind app routes so tokens leave the browser.
3. Public marketing pages stay a separate static site (or a public route group with no login), never mixed into staff routes.
4. Forms that fed Sheets/Notion (intake, ROI) already have in-app versions; retire the site copies once traffic is confirmed moved.

## Verified
- `test/sales_portal.test.js` 7/7; full suite 4048/4051, the 2 failures are the payroll timesheet tests that fail on main too.
- Real server, real liaison login, every section rendered in Chromium with no page errors. Coordinator refused (403). Ticket refused after sign-out (401). Brochure served as PDF.
- Not proven from the sandbox: the live Apps Script and Leaflet/CDN calls (the sandbox blocks them; the map fell back to its built-in copy).
