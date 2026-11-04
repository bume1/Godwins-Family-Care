# The NCCI loader's code universe: gfc_billable_codes

_2026-11-04 · owner-directed_

**What was wrong.** `scripts/load_ncci_tables.js` keeps only CMS rows that touch a GFC code. Its universe was favorites + prior selections + billed history, which in September came to the eight home-visit codes, so the MUE table held 8 rows and PTP only home-visit pairs. Nothing reported it.

**What changed.**
- New KV collection `gfc_billable_codes` (`billableCodes.js`), registered in `COLLECTION_REGISTRY`, not PHI: `[{ code, source, updatedAt }]`, the CPT4/HCPCS codes GFC can bill, mirrored by hand from OpenEMR's `codes` table.
- Seeded from the owner's 2026-11-04 export of all 91 active and inactive codes (`scripts/data/gfc_billable_codes_seed.json`). The app seeds it on boot **only if it has never been set**; an empty list saved on purpose stays empty.
- The loader unions it with the existing sources (favorites, prior selections, billed history, plus the cached OpenEMR catalog). **The old sources stay**: a code someone billed belongs in the universe even if nobody added it to the list.
- **An empty `gfc_billable_codes` stops the loader** before it fetches or writes anything, with the command to fix it.
- End-of-run summary: rows seen and kept per source file, the quarter, the universe by source, GFC codes matched, universe codes that matched nothing (listed), codes with no MUE row, and the diff against the prior load.
- `node scripts/billable_codes.js list | add | remove | from-catalog | seed [--replace]` keeps the list in step with OpenEMR until a service account exists (documented in `scripts/README.md`). `from-catalog` copies the catalog an admin cached with Refresh Catalog, and adds without ever removing.
- Unchanged: the NCCI check logic, the sign and billing gates, OpenEMR.

**Against CMS's real 2026 Q4 MUE file (run by hand, 2026-11-04):** 15,212 rows seen; **87 of the 91 codes kept**, up from 8. The 4 with no MUE row (G0568, G0569, G0570, G2211) are genuinely absent from CMS's file, confirmed by searching it.

**Open for the owner:**
1. Re-run the loader on the server after deploying: `node scripts/load_ncci_tables.js`. PTP needs the four Q4 practitioner zips in `scripts/ncci_source/ptp/`.
2. H0031, H0032, H0034 and H0038 are on the LCSW billing list in `clinicalRoles.js` but not in OpenEMR's 91. `/healthz/code-catalog` will flag them. Enter them in OpenEMR or tell us to drop them.
3. After any code change in OpenEMR's fee schedule, update the list (`from-catalog` after Refresh Catalog is easiest) and re-run the loader.

**Verified:** `test/billable_codes.test.js` 10 tests (the MUE-coverage test runs the real loader and real `unzip` on a CMS-shaped file), `test/ncci_load.test.js` updated to seed the list; 8 mutations each caught. Full suite 2756 pass, 0 fail. App boot seeds 91 codes.
