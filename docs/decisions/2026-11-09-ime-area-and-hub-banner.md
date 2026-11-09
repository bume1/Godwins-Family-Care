# An Independent Medical Examinations area, and the hub's brand banner (2026-11-09)

Owner-directed, follow-up to the staff Portal Hub (PR #272).

## IME area
- **`/ime` is now "Independent Medical Examinations"**, with two tabs:
  - **Exam Day** (`#exam`, the default): the veterans list that used to be the Admin Hub's "Veterans (IME)" page. It has the add form, sign-ins to match, provider reassignment, Mark Seen and Remove. It was ported to the page's plain-DOM style. The routes are unchanged. Check-in matching is office-only on the server, so a provider sees their own list without the matching panel.
  - **Claim Files (AI Review)** (`#files`, `#case=<id>`): the IME record analyzer, unchanged.
- **Each tab asks the server on its own.** A refusal on the analyzer (`/api/ime/meta`) no longer blanks the whole page, so someone allowed on one tab and not the other is told which.
- **On the hub it sits in the Clinical area** for every office type and every clinician type. A manager with no clinical access still gets it, alone, because the office runs exam day.
- **The Admin Hub lost its Veterans page**, its menu entry and its two IME tiles. An old `?view=veterans` style link lands on `/ime#exam`.
- **Not changed:** the Clinical Workspace's own Veterans view (the provider's board). Arrival emails link there.

## Hub banner
- The Portal Hub's banner is now GFC's LinkedIn brand graphic (`public/banners/banner-hub.webp`, rendered from the owner's PDF at 2400px).
- It is shown whole, with nothing laid over it, because it carries its own words. The photo banner and its "Your Portals" overlay are gone.

## Verification
- **Tests:** full suite 3,385 pass, 0 fail. Three new tests are in `test/staff_hub.test.js`; three existing ones were repointed.
- **Browser:** `scripts/verify_staff_hub_render.js` passes 38/38 at 1440 and 390, including the banner image loading, Exam Day listing a veteran and a sign-in to match, and the Claim Files tab.
