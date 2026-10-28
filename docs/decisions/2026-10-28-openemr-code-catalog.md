# OpenEMR owns the billing code catalog

_2026-10-28 · owner-directed_

**What changed.** The app no longer keeps any CPT/HCPCS list of its own. It reads OpenEMR's `codes` table (CPT4 and HCPCS) through a new `?catalog=1` mode on the 6B `GET /api/codes` route, normalizes each row to `{ code, modifier, shortLabel, longLabel, codeType }`, and caches it in app_kv under `openemr_code_catalog` with `fetchedAt` (`codeCatalog.js`). A service code is offered, and can be newly saved on an encounter, only while that catalog holds it active.

**Must not undo:**

- **No hardcoded fallback.** OpenEMR unreachable → the cached catalog is served and the admin hub banner says how old it is and why the last refresh failed. No cache at all → nothing is offered from the app's side; OpenEMR's own live search rows marked active still are. An empty answer from OpenEMR never replaces a real catalog.
- **A refresh needs a real person's session (Session 5.2: no system login).** "Daily" means: the first staff request after the cache turns 24 hours old refreshes it in the background with that person's OpenEMR sign-in (code search, the admin hub). An admin can refresh on demand (admin hub → Refresh Catalog, `POST /api/admin/code-catalog/refresh`). A failed background attempt waits 15 minutes before another.
- **Rule lists stay in source and are checked against the catalog** at boot and after every refresh (`codeCatalog.RULE_LISTS`, today `BEHAVIORAL_HEALTH_SERVICE_CODES` in `clinicalRoles.js`). A missing or inactive code is logged by code and file and fails `GET /healthz/code-catalog` (503). **`/healthz` itself stays 200** and carries the check as `checks.codeCatalog`: it is the load balancer's probe, and loading the catalog needs someone signed in, so failing it on a fresh deploy would take the app offline with nobody able to fix it.
- **Saving:** a service code added on a coding save is refused if it is not active in the catalog (`SVC_NOT_IN_CATALOG`), if no catalog is cached (`CODE_CATALOG_UNAVAILABLE`), or if GFC never offers it (`SVC_NOT_OFFERED`). Codes already on an encounter are left alone so older visits still re-save.
- **Removed:** `DEFAULT_SERVICE_CODE_FAVORITES` (practice favorites are admin-set or empty; with none set, the picker offers the catalog itself). 99343 is gone from all non-test source, and 99999 was not present as a code. **G0177, G0409, G0410** left the LCSW list and sit in `clinicalRoles.NOT_OFFERED_SERVICE_CODES`, filtered from every picker and refused on save even if OpenEMR holds them.
- **No price or fee logic changed.** The catalog route returns no fee.

**Open for the owner:**

1. **Redeploy the 6B patch** (`INSTALL.md`, "Update 2026-10-28"). Until then the catalog cannot load and the banner says so.
2. **Expect the health check to flag the LCSW codes** if they are not entered in OpenEMR's fee schedule. Enter and activate them, or tell us to trim the list.
3. **99343 is kept out by OpenEMR, not by the app.** If someone activates it in OpenEMR's fee schedule, the app will offer it. Confirm it is inactive or absent there.
4. An admin needs to press Refresh Catalog once after the redeploy.

**Verified:** `test/code_catalog.test.js` 21 tests, 11 mutations each confirmed to fail one (one test first passed for the wrong reason and was tightened). Full suite 2680 pass, 0 fail. Both edited pages compile; the app boots, `/healthz` 200 with the check, `/healthz/code-catalog` 503 with nothing cached, admin routes 401 unauthenticated. **Not proven from here:** a live catalog read against OpenEMR (needs the redeployed patch and a signed-in admin).
