# GFC Payroll, Billing & QuickBooks Spec, v2

Nov 8, 2026 · owner: Bianca Ume · replaces the build parts of `GFC_Payroll_Billing_QuickBooks_Spec_v1.md`

v1 is kept as the original request. v2 is what gets built. It holds the owner's answers to the v1 review (two rounds, 2026-11-08), and it reuses what the app already has instead of rebuilding it. Items still open are marked **OPEN**.

## 1. Scope by service line

| Service line | What the app does | QuickBooks |
| --- | --- | --- |
| **Private Home Care (PHC)** | Invoices from approved payroll hours, statements, Stripe online pay | **Yes.** PHC invoices, payments, payroll and contractor pay sync |
| **In-Home Primary & Psych Care (IHPC)** | Claims workspace on `/billing` (built, PR #242): scrub, submit, release. OpenEMR's Billing Manager sends to Availity. **Adds a payments and denials list on `/billing`, read from OpenEMR's Billing Manager** (section 6) | **No.** No clinical client, claim or payment is ever sent to QuickBooks |
| **IME / C&P exams** | Fee schedule per contracting entity, an invoice per completed exam, payment tracking, examiner pay | Payroll and contractor pay only (no patient data) |

Psych is part of IHPC: one billing process, different codes.

Medicaid waiver, VA and Medicare B as **home care** payers: later.

## 2. Decisions from the review

1. **QuickBooks gets PHC only.** It never receives clinical clients or claims. PHC customers in QuickBooks: **OPEN item (a)** below.
2. **No rebalancing.** Hours are never moved between days. Invoices are generated from the **final approved payroll hours**. That source is either the app's own approved hours, or an **uploaded hours file** (CSV) when the hours were kept outside the app. The upload is checked, previewed and approved before any invoice is made from it.
3. **Bill the hours as worked.** No daily limit is applied on any invoice, nothing is held, and nothing is moved (owner, round 2; this replaces "hold over-cap minutes").
4. **No change to how caregivers clock in and out**, or how clocked hours become billed hours. Drive time between clients is not added to pay (owner decision 2026-11-08, made knowing the wage-law note in the review).
5. **The client's daily minimum stays exactly as it is.** The v1 rule "billed hours must equal worked hours" is deleted.
6. **No daily-cap enforcement at clock-in.** No midnight split.
7. **People are the app's existing user records.** Payroll fields are added to them, with no separate "workers" list. The W-2 / 1099 / both relationship already recorded at clinician onboarding is the one source.
8. **Hours come from the existing time logs** (caregiver GPS clock-in and out). Clinician visit time comes from the start and end stamps on My Day. Non-visit staff time (admin, training) gets a simple clock.
9. **Pay rates keep their three levels:** shift → per client → base.
10. **Invoices build on the existing statements** (`patient_invoices`) and **Stripe** online pay.
11. **Invoice numbers are sequential and never reused** (`GFC-000123`). Client initials and the service date appear on the PDF only, never in the number. Stripe sees only the number and the amount.
12. **LTC carriers get one invoice per client per service date**, their current format. **Families are billed every two weeks.**
13. **Gusto's onboarding paperwork moves into the app** with Phase 1: W-4, G-4, I-9, direct deposit, offer letter and handbook acknowledgement, and electronic-delivery consent. Without these, payroll cannot run.
14. **Payroll's scheduled automations run in Google Apps Script** (owner, round 2), alongside the Apps Script projects already tied to the app. They include:
   - the tax-rate watcher
   - pay period close
   - missing-time, payment, tax-deposit and filing reminders
   - the QuickBooks sync check

   Apps Script calls a small set of payroll automation routes in the app with its own key, which can do only those jobs. Rates it finds are staged, and **nothing goes live until the owner approves it in the app**. The setup guide gives Apps Script its own highlighted section.
15. **PDFs use the app's existing PDF builder**, styled to the GFC invoice template. No Puppeteer.
16. **Pay stubs and W-2/1099s are link-only.** The email says the document is ready, never attaches it, and carries no amounts. Workers see their stubs in the caregiver app (or their account page) from Phase 1.
17. **Only the owner approves** payroll runs, pay rates, write-offs and the release of held minutes. Managers and coordinators keep reviewing claims and statements, as today.
18. **Pay periods:** weekly runs Monday to Sunday; biweekly runs Monday through the second Sunday. The overtime workweek is Monday to Sunday to match, so no workweek is split across two pay periods.

## 3. Pay frequency

A setting: **weekly or biweekly**, plus the period start day. Federal (Pub 15-T) and Georgia withholding use the per-period figure for the chosen frequency, so changing the setting changes the withholding math with no other edit. A change applies from the next period that has not started yet. It never applies to a run already drafted.

## 4. Hours → invoice (PHC)

The **Generate Invoice** button on the billing page is fixed and works from:

- **the app's own approved hours**, the same rows as the app's payroll export, or
- **an imported file in that same export format**. No separate template: the import reads exactly what the app exports.

Steps:

1. The import is checked row by row: known caregiver and client, real dates, clock-out after clock-in. Every bad row is named, and nothing is imported until all rows pass. The approved file is kept with the invoices made from it.
2. Invoices are drafted from those hours, **as worked**:
   - per client per service date for LTC carriers
   - every two weeks for families, with the agreed daily minimum applied (item 5)
3. Drafts are reviewed, then sent.

### The invoice layout (owner's samples, 2026-11-08)

The owner sent two real LTC carrier invoices as the pattern to match. They are not committed: this repo is public, and they carry a client's name and policy numbers. The layout, one page:

- **Header band** (cream): GFC logo on the left. **INVOICE** on the right, with Invoice #, Invoice date and Service date under it.
- **FROM:**
  - Godwins Family Care LLC
  - street, city
  - Tel · Fax
  - admin email
  - All from the app's one org block, never typed again.
- **BILL TO:**
  - the payer's name
  - an "Attn:" line
  - mailing address
  - claims email
  - then **Insured:** (client), **Policy #**, **Claim #** for an LTC carrier
- **SERVICE DETAILS:**
  - Client
  - Caregiver, with licence level (e.g. "PCA")
  - Service ("Private home care, personal care assistance")
  - Date of service
  - Shift start (ET), Shift end (ET)
  - **Billed duration "4.87 hrs (4 hr 52 min)"**
- **Line table** (navy header): Description · Hours · Rate · Amount. The description reads "Personal care services · {caregiver} ({level}) · {date}".
- **Totals:**
  - Subtotal
  - Sales tax (0%)
  - **TOTAL DUE**
- **PAYMENT:**
  - Payable to
  - Terms: Due Upon Receipt
  - Questions: email · phone
- **Footer:** "Care That Sees You." with the legal name and phone.

**Money is figured from minutes, never from the rounded hours:**

- 292 min × $30/hr ÷ 60 = $146.00, even though 4.87 × 30 would be $146.10.
- The hours column shows the minutes ÷ 60 to two decimals.

**More than one shift on a date** (two caregivers, or a split visit):

- one Service Details block per shift
- one table line per shift
- the total covers them all

**Family invoices** (every two weeks) use the same design, with one line per shift across the period.

**Payers** (LTC carriers and families) are a list kept in the app. Each client links to theirs, with the insured's name, policy # and claim #. That way Bill To fills itself.

## 5. IME billing

- **A fee schedule per contracting entity:** LSGS, Leidos QTC, VES.
  - **VES:** the owner sends the rate sheet.
  - **LSGS:** placeholder until the owner uploads its rates.
- An exam marked report-submitted becomes a billable line at that entity's rate for that exam type. Lines are invoiced to the entity, and payment is recorded against the invoice.
- **Examiners are paid every two weeks**, from the same completed exams: 1099 per exam, or W-2 for a clinician set up as both.

## 6. IHPC payments and denials

OpenEMR's Billing Manager stays where claims go out and where payments are posted. `/billing` adds a **payments and denials list**, read from OpenEMR and linked to each claim the app released. It shows:

- what was paid, what was denied and why
- what the patient owes
- how old each balance is

Reading this from OpenEMR needs new read routes in the GFC OpenEMR patch (6B). The standard API has no payment or denial read. Nothing about these clients ever goes to QuickBooks.

## 7. Kept from v1 unchanged

These v1 sections stand as written, adjusted only by section 2:

- payroll engine (withholding, employer taxes, overtime over 40 hours in the workweek)
- contractor invoices
- PNC payment sheet and confirmations
- QuickBooks chart of accounts and sync, PHC only
- tax calendar and reminders
- year-end W-2 / 1099-NEC with e-delivery consent
- security and audit
- the parallel run before retiring Gusto

## 8. OPEN, for the owner

- **(a)** PHC customers in QuickBooks: Intuit signs no HIPAA agreement. Real names, or an account number with the name kept in the app? (Only affects the QuickBooks step.)
- **(i)** PNC payment timeline: the owner will update.
- **(k)** Invoice numbers: the samples use the carrier format `GFC-DM-260902` (client initials + service date), but decision 11 says sequential. See the owner's answer.
- VES rate sheet (owner sending); LSGS rates (placeholder until uploaded).

Settled in round 2: (b) no hold, bill as worked; (c) families every two weeks; (d) Apps Script; (e) pay periods; (f) examiners paid every two weeks; (g) payments and denials list in the app; (h) the import matches the app's export.

## 9. Build order

| # | Build | Done when |
| --- | --- | --- |
| 1 | Payroll fields on user records, encrypted SSN/TIN and bank, onboarding paperwork (W-4, G-4, I-9, direct deposit, consent) | Fields unreadable in the database without the key; a run refuses a worker missing W-4/G-4/bank |
| 2 | Pay settings (frequency, period, OT week), tax tables and loader | Pub 15-T and GA guide worked examples match to the cent, weekly and biweekly |
| 3 | Payroll run from time logs + clinician stamps + staff clock, OT | Draft run shows gross, each tax, net and cash needed |
| 4 | Owner approval, lock, link-only stubs | Approved run locks its hours; stubs show current and YTD |
| 5 | PNC payment sheet + confirmations | Run is paid only when every worker has a confirmation |
| 6 | Generate Invoice from approved hours or an imported export file, matching the owner's invoice | Sequential numbers; carrier per service date, family every two weeks; billed as worked; looks like the owner's sample |
| 7 | IME fee schedules, exam invoices, examiner pay | A report-submitted exam bills at its entity's rate once |
| 8 | Contractor invoice portal | Submit, approve, pay, 1099 total |
| 9 | QuickBooks (sandbox, then live), PHC only | Each event posts once; no clinical data ever sent |
| 10 | Tax calendar, reminders, quarterly and year-end exports; Apps Script automations and their setup guide | 941, G-7, DOL-4N figures tie to the runs; each Apps Script job runs with its own limited key |
| 11 | IHPC payments and denials list (OpenEMR read routes) | A paid and a denied claim show on `/billing` with the amounts OpenEMR holds |
