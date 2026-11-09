# Branding pass: the My GFC look on the remaining pages

**Date:** 2026-11-09 · **Owner-directed**

## What changed
- **The shared theme (`public/css/gfc-theme.css`) now covers Audit Log, IME, Messages and Account,** alongside Home Care Oversight and Scheduling. The page title lines up with the content under it (`--page-w`, 1180px by default; the Audit Log keeps its 1320px table). Tabs on every themed page are white pills with gold for the selected one.
- **White sidebars on Clinical and Onboarding** (owner: "all white"). Navy text, the full-color logo, gold for the selected item, and a warm edge on the right. Billing has no sidebar; its second navy bar under the staff bar is now a plain title with the same pill tabs.
- **Clients & Patients** moved from a grey page to the cream one.
- **Password Reset and the no-login Upload Link** (the two public pages still on the old look) now use a white header with the full-color logo, the cream page and warm-edged cards. Signup already matched.
- **A full-color heart mark** (`public/brand/logo-mark-color-transparent.png`, cropped from the full-color logo) replaces the pale watermark mark as every page's browser-tab icon and in the staff bar's Portal Hub tile. The old file was grey on transparent, so it read as a smudge.

## Must not undo
- Load `gfc-theme.css` **after** a page's own `<style>`, or the page's older rules win.
- `logo-mark-transparent.png` is a watermark. Never use it as an icon on white.

## Verified
- 5 tests in `test/branding.test.js`, 7 of 7 mutations caught.
- Full suite green; every edited page compiles.
- Rendered in Chromium at 1440 and 390: Audit Log, IME, Messages, Home Care Oversight, Onboarding, Password Reset and Upload Link through stubs; Clinical and Billing through `verify_billing_render.js` (21/21); the client record through `verify_care_records_render.js` (28/28); Audit 29/29, Account 33/33, Tasks 12/12, Protocols 38/38, Referrals 31/31, Staff hub 38/38.
- `verify_billing_render.js` was failing on main before this pass: its "Patients" button locator also matched "Clients & Patients" after that rename. It now targets the button's title exactly.
