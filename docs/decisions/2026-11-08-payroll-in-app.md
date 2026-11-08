# Payroll in the app, wired into My GFC

_2026-11-08 · owner: "go build steps 1-10" (spec v2, `docs/GFC_Payroll_Billing_QuickBooks_Spec_v2.md`), then "#1 will be linked to our new pay area in our new staff profile area ... nothing duplicated". Setup: `docs/PAYROLL_SETUP.md`._

**Built on My GFC, not beside it.** This branch merges `claude/festive-ritchie-jq91a1` (My GFC, the staff portal), which is not on main yet.
- Each person's pay paperwork, their staff clock, their contractor invoices and their tax forms are `/api/my/*` routes. They are drawn in **My GFC → Hours & Pay** by `public/my-pay.js`, which loads before `my-gfc.js`.
- An approved run writes its stubs into **`staff_paystubs`**, the store My GFC already lists and the Apps Script pay-stub import fills. There is no second stub screen.
- The automations use the **same `PAYROLL_INGEST_KEY`** and `X-GFC-Payroll-Key` header as `scripts/payroll_paystubs.gs`, in the same Apps Script project. One secret.

**What each step built:**

| Step | Built |
| --- | --- |
| 1 | `payroll_profiles` holds the W-4, G-4, I-9 (employee and office sections), W-9, pay method, offer letter, handbook and e-delivery consent. SSN, TIN, routing and account numbers are sealed with AES-256-GCM under `PAYROLL_ENCRYPTION_KEY` (`payrollCrypto.js`). Only the last four are readable. The owner reveals a full number on demand, and each reveal is logged without the value. |
| 2 | Pay is weekly or biweekly, Monday through Sunday, and the overtime week matches. The 2026 federal and Georgia tables ship **staged** and pay nothing until the owner approves them. Federal is Pub 15-T. Georgia is 4.99% from May 11, 2026 under HB 463, using the 2026 G-4 letters A–D. |
| 3 | `payrollEngine.js`: pay comes from caregiver time logs (three-level rate), My Day visit stamps, the staff clock and W-2 IME exams. Overtime is figured at the weighted regular rate. Salary and per-visit pay are supported. |
| 4 | Only the Super Admin approves, and approval refuses anyone missing paperwork or the GA SUTA rate. Approval locks the paid time logs (an edit is refused with `TIME_LOG_PAYROLL_LOCKED`) and writes the stub PDF and the `staff_paystubs` row. The email links to the stub and never states an amount. |
| 5 | A PNC payment sheet: the run is paid only when every worker has a confirmation. |
| 7 | IME fee schedules per entity. An entity with no rates bills nothing (VES is pending; LSGS is a placeholder). An exam bills once, and voiding the invoice frees it. Invoices export as CSV. A 1099 examiner's pay is built from completed exams as a contractor payout. |
| 8 | Contractor invoices: submitted in My GFC, approved or sent back by the owner, then paid with a confirmation. An invoice number is never reused, and each contractor's 1099 total is tracked. |
| 9 | `quickbooks.js`: OAuth tokens are sealed. Each event posts once, using a requestid derived from the event. Failures can be retried. **`assertPhc` is the only door an invoice goes through: no copay, no clinical client.** Journals must balance before they post. |
| 10 | A tax calendar of deposits and filings, with weekend roll-forward and FUTA under $500 carried forward. Quarterly 941, G-7 and DOL-4N figures and year-end W-2 / 1099 figures as CSV. `scripts/payroll_automations.gs` runs the period close, missing-time, payment, tax and QuickBooks jobs plus the tax-source watcher. |

**Must not undo:**
- No automation job approves a run, pays anyone, or turns on a rate (build-enforced).
- A secret is never stored in the clear. With no key set, nothing secret saves.
- An approved run is frozen. A correction goes into the next run.
- QuickBooks never receives anything clinical.

**Verified:**
- `test/payroll.test.js`: 25 tests.
  - Federal withholding matches all six Pub 15-T 2026 biweekly wage-bracket values.
  - Georgia matches both worked examples in the 2026 guide ($27.03 and $0).
- 28 deliberate breaks, each confirmed to fail a test. Two survived the first pass and the tests were tightened: an unbalanced journal, and "paid" with one of two confirmations in.
- Full suite: 3306, 0 failing.
- All pages compile.

**Not proven from here:**
- A live QuickBooks sandbox.
- Drive filing a real stub.
- The Apps Script's triggers.

**Open for the owner:**
1. Set `PAYROLL_ENCRYPTION_KEY`, the GA SUTA rate and the EIN, then approve the 2026 tables.
2. The 1099-NEC threshold ($2,000) is UNCONFIRMED.
3. Official W-2 / 1099 forms and the SSA EFW2 file are not built. The year-end export gives the box figures.
4. VES rates and the PNC timeline.
