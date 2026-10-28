# Charges are priced from OpenEMR's fee schedule, never a silent $0

_2026-10-28 · owner-directed_

**What changed.** The 6B `POST …/billing` route defaulted a missing fee to $0.00, so every charge the app posted reached Billing Manager at $0. It now prices the line the way the Fee Sheet does: the `prices` row for the code's `codes` id at the patient's price level (`patient_data.pricelevel` → default on the `pricelevel` list → `standard`), times units. A modifier line with no priced modifier row falls back to the base code. The response returns `fee_used`, `fee_source`, `unit_price` and `price_level`, and the level is stored on the billing row.

**Must not undo:**

- **A posted fee still wins.** The app sends none today; prices stay OpenEMR's.
- **A code with no price posts at $0 and says so** (`fee_source: none`). It is not refused, because refusing would block a signed note's charges over a fee-schedule gap.
- **$0 is visible.** The app records each posted line's fee (`postedChargeEntry`), adds a warning at sign and re-post naming the code, and the coding queue shows a banner listing every encounter with a $0 line (code, patient, date, encounter) whatever the filter, plus a chip on the row. **A line whose fee the response did not report is `null`, never treated as $0.**

**Open for the owner:**

1. Redeploy the 6B patch (INSTALL.md, Update 2026-10-28). It carries this and the code catalog change in one controller.
2. **Charges posted before the redeploy are already $0 in Billing Manager and the app cannot see them** (it did not record a fee then). Correct them in Billing Manager.
3. Confirm 99350 and the other billed codes have a price at the `standard` level in OpenEMR's fee schedule.

**Verified:** `test/charge_fee.test.js` runs the real controller in PHP against stubbed `codes`/`prices`/`patient_data` tables: 99350 with no fee → $245.50 at standard; 99350-25 → same price via the base-code fallback; units, the patient's own level and a posted fee also checked. 5 mutations on the PHP each caught. Full suite 2687 pass, 0 fail. **Not proven live:** the real OpenEMR `prices` table and `addBilling` (needs the redeploy).
