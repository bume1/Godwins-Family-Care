# Private Home Care invoices from approved hours, in the owner's invoice layout

_2026-11-08 · owner-directed: "I do want that generate invoice button to work with the hours or the payroll export that's already in the app. Or the version that will be imported." Spec: `docs/GFC_Payroll_Billing_QuickBooks_Spec_v2.md` §4 (build step 6). The owner sent two real LTC carrier invoices as the pattern; they are not committed (public repo, a client's policy numbers)._

**What changed.**

- **Generate Invoices** on `/billing` → Home Care Invoices. The hours come from one of two places:
  - the app's completed shifts (the same rows as the payroll export), or
  - an imported file in that export's format. The billing export's column names are read too. There is no separate template.
- **`phcInvoices.js`** (pure) decides every invoice:
  - LTC carriers get **one invoice per client per date of service**.
  - Families get **one invoice for the period**. The card starts on the last finished two-week period, Monday through the second Sunday.
  - Hours are billed **as worked**: no cap, nothing held, nothing moved.
  - The client's agreed **daily minimum is its own line**, so each shift line stays what was worked.
- **Money is figured from minutes, never from rounded hours.** For example, 292 min at $30/hr is $146.00, not 4.87 × 30 = $146.10.
  - The older one-client home care statement (`patientBilling.homeCareLines`) was rounding hours first. It now uses minutes too.
- **Invoice numbers keep the carrier style** (owner, 2026-11-08): `GFC-{initials}-{YYMMDD}`. A family invoice uses its period's last day.
  - When that number is taken, the next one gets `-2`, `-3`.
  - Voided numbers stay taken, so a number is never reused.
  - Each invoice still has its own `GFC-INV-XXXXXX` reference, and that is all Stripe ever sees.
- **The PDF** (`pdfGenerator.generatePhcInvoicePDF`) follows the sample section for section:
  - cream header band with the logo and INVOICE
  - FROM, from the one `ORG` block
  - BILL TO, with Insured / Policy # / Claim # for a carrier
  - SERVICE DETAILS, one block per shift, ending with "Billed duration 4.87 hrs (4 hr 52 min)"
  - the navy line table, Subtotal, Sales tax (0%), TOTAL DUE
  - PAYMENT and the footer
  - A long family invoice pages cleanly, with the table header repeated.
- **Who is billed.**
  - The office keeps a list of LTC carriers (`billing_payers`, Settings → LTC Carriers).
  - Each client has a Bill To: a carrier from that list, with the insured, policy # and claim #, or a family name and address.
  - The policy the client gave at enrollment is offered as a starting point, never filled in on its own.
  - The Bill To is **copied onto each invoice**, so editing a payer later changes no invoice already made.
- **A carrier's invoice is the carrier's.**
  - It never shows on the patient's portal and cannot be paid online.
  - Sending it is **Mark Sent**: the office sends the PDF to the carrier, and the patient is not emailed.
  - Family invoices are announced through the existing PHI-free statement email.

**Must not undo:**
- An import with any bad row imports nothing. Every bad row is named with its line number.
- A name shared by two people is refused, never guessed.
- When the Hours column disagrees with Clock In to Clock Out, the row is refused. The invoice prints both, so they cannot say two different things.
- A shift is never billed twice. Shifts are tracked by caregiver + client + clock-in minute, so the same shift coming from the app and from a file counts as one. A voided invoice frees its shifts.
  - Statements from the older route have no shift tracking. Any shift inside one of their date ranges counts as already billed.
- Clinical-only (IHPC) clients are never invoiced here.
- Each hours file used is kept (`invoice_hour_imports`, PHI) with the ids of the invoices made from it.

**Verified.**
- `test/phc_invoices.test.js`: 24 tests.
- 19 deliberate breaks, each confirmed to fail a test. One survived at first (an overnight shift typed without its end date); a test was added and it now fails.
- `scripts/verify_phc_invoices.js`: **24/24 over real HTTP**, reading stored rows and the served PDF back.
- `verify_patient_billing.js` 25/25 and `verify_billing_render.js` 21/21, both unchanged.
- Full suite: 3252 tests, 0 failing after two guards caught my own slips (a fax literal in a test, a non-literal Content-Disposition argument).
- The PDF was rendered and compared side by side with the owner's sample.

**Not built yet (later build steps):**
- Payroll approval and lock (step 4). Today "approved hours" means completed shifts; once runs are approved, invoices will read only approved runs.
- Emailing a carrier invoice from the app.
- The QuickBooks sync.

**Open for the owner:**
1. Add your LTC carriers under Billing → Settings, and set each private home care client's Bill To.
2. Rebuild the container on the EC2 box. Nothing here is live until then.
