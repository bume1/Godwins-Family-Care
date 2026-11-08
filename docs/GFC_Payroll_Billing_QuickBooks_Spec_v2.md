# GFC Payroll, Billing & QuickBooks Spec, v2

Nov 8, 2026 · owner: Bianca Ume · replaces the build parts of `GFC_Payroll_Billing_QuickBooks_Spec_v1.md`

v1 is kept as the original request. v2 is what gets built. It holds the owner's answers to the v1 review (2026-11-08), and it reuses what the app already has instead of rebuilding it. Items still open are marked **OPEN**.

## 1. Scope by service line

| Service line | What the app does | QuickBooks |
| --- | --- | --- |
| **Private Home Care (PHC)** | Invoices from approved payroll hours, statements, Stripe online pay | **Yes.** PHC invoices, payments, payroll and contractor pay sync |
| **In-Home Primary & Psych Care (IHPC)** | Claims workspace on `/billing` (built, PR #242): scrub, submit, release. OpenEMR's Billing Manager sends to Availity | **No.** No clinical client, claim or payment is ever sent to QuickBooks |
| **IME / C&P exams** | Fee schedule per contracting entity, an invoice per completed exam, payment tracking, examiner pay | Payroll and contractor pay only (no patient data) |

Psych is part of IHPC: one billing process, different codes.

Medicaid waiver, VA and Medicare B as **home care** payers: later.

## 2. Decisions from the review

1. **QuickBooks gets PHC only.** It never receives clinical clients or claims. PHC customers in QuickBooks: **OPEN item (a)** below.
2. **No rebalancing.** Hours are never moved between days. Invoices are generated from the **final approved payroll hours**. That source is either the app's own approved hours, or an **uploaded hours file** (CSV) when the hours were kept outside the app. The upload is checked, previewed and approved before any invoice is made from it.
3. **Over-cap insurer minutes are held**, never moved and never billed automatically. The admin releases them to a family invoice or writes them off, with a reason.
4. **No change to how caregivers clock in and out**, or how clocked hours become billed hours. Drive time between clients is not added to pay (owner decision 2026-11-08, made knowing the wage-law note in the review).
5. **The client's daily minimum stays exactly as it is.** The v1 rule "billed hours must equal worked hours" is deleted.
6. **No daily-cap enforcement at clock-in.** No midnight split.
7. **People are the app's existing user records.** Payroll fields are added to them, with no separate "workers" list. The W-2 / 1099 / both relationship already recorded at clinician onboarding is the one source.
8. **Hours come from the existing time logs** (caregiver GPS clock-in and out). Clinician visit time comes from the start and end stamps on My Day. Non-visit staff time (admin, training) gets a simple clock.
9. **Pay rates keep their three levels:** shift → per client → base.
10. **Invoices build on the existing statements** (`patient_invoices`) and **Stripe** online pay.
11. **Invoice numbers are sequential and never reused** (`GFC-000123`). Client initials and the service date appear on the PDF only, never in the number. Stripe sees only the number and the amount.
12. **LTC carriers get one invoice per client per service date**, their current format. **Families get one invoice per billing period** (period: **OPEN (c)**).
13. **Gusto's onboarding paperwork moves into the app** with Phase 1: W-4, G-4, I-9, direct deposit, offer letter and handbook acknowledgement, and electronic-delivery consent. Without these, payroll cannot run.
14. **Scheduled jobs run inside the app**, not Google Apps Script. The tax-rate watcher: see **OPEN (d)**.
15. **PDFs use the app's existing PDF builder**, styled to the GFC invoice template. No Puppeteer.
16. **Pay stubs and W-2/1099s are link-only.** The email says the document is ready, never attaches it, and carries no amounts. Workers see their stubs in the caregiver app (or their account page) from Phase 1.
17. **Only the owner approves** payroll runs, pay rates, write-offs and the release of held minutes. Managers and coordinators keep reviewing claims and statements, as today.
18. Pay period and overtime week line up: **OPEN (e)**.

## 3. Pay frequency

A setting: **weekly or biweekly**, plus the period start day. Federal (Pub 15-T) and Georgia withholding use the per-period figure for the chosen frequency, so changing the setting changes the withholding math with no other edit. A change applies from the next period that has not started yet. It never applies to a run already drafted.

## 4. Hours → invoice (PHC)

1. A payroll period closes. The owner approves the hours. These are the app's own time logs, or an uploaded hours file.
2. **Uploaded file format** (CSV, one row per shift): caregiver, client, service date, clock in, clock out, break minutes, payer. Every row is checked: known caregiver and client, real dates, out after in. Every bad row is named, and nothing is imported until all rows pass. The approved file is kept with the run.
3. Invoices are drafted from those hours:
   - per day for LTC carriers, billed up to the carrier's daily benefit, with the rest held (item 3)
   - per period for families, with the agreed daily minimum applied (item 5)
4. Drafts are reviewed, then sent. Amount = billed minutes × rate ÷ 60, rounded to the cent. Hours show to two decimals plus "X hr Y min".

## 5. IME billing

- **A fee schedule per contracting entity:** LSGS, Leidos QTC, VES.
  - **VES:** the owner sends the rate sheet.
  - **LSGS:** placeholder until the owner uploads its rates.
- An exam marked report-submitted becomes a billable line at that entity's rate for that exam type. Lines are invoiced to the entity, and payment is recorded against the invoice.
- "Payment is biweekly for exams": **OPEN (f)**.
- Examiner pay (1099 per exam, or W-2 for a "both" clinician) comes from the same completed exams.

## 6. Kept from v1 unchanged

These v1 sections stand as written, adjusted only by section 2:

- payroll engine (withholding, employer taxes, overtime over 40 hours in the workweek)
- contractor invoices
- PNC payment sheet and confirmations
- QuickBooks chart of accounts and sync, PHC only
- tax calendar and reminders
- year-end W-2 / 1099-NEC with e-delivery consent
- security and audit
- the parallel run before retiring Gusto

## 7. OPEN, for the owner

- **(a)** PHC customers in QuickBooks: Intuit signs no HIPAA agreement. Real names, or an account number with the name kept in the app?
- **(b)** Do LTC carriers' daily benefit limits still apply on their invoices (bill up to the limit, hold the rest)? That is how decisions 3 and 6 fit together.
- **(c)** Family billing period: weekly, biweekly or monthly?
- **(d)** Tax-rate watcher: inside the app, with the guide showing where to approve new rates (recommended)? Or keep Google Apps Script for that one job?
- **(e)** Line up the pay period start with the overtime week start (default Sunday)?
- **(f)** "Payment is biweekly for exams": are examiners paid biweekly, or do VES and LSGS pay GFC biweekly?
- **(g)** IHPC after a claim is sent: insurance payments, denials and what the patient owes. Keep that in OpenEMR's Billing Manager, or build a payments and denials list on `/billing`?
- **(h)** A sample of the hours file you would upload (for example a Gusto or spreadsheet export), so the import matches it.
- **(i)** PNC payment timeline: the owner will update.

## 8. Build order

| # | Build | Done when |
| --- | --- | --- |
| 1 | Payroll fields on user records, encrypted SSN/TIN and bank, onboarding paperwork (W-4, G-4, I-9, direct deposit, consent) | Fields unreadable in the database without the key; a run refuses a worker missing W-4/G-4/bank |
| 2 | Pay settings (frequency, period, OT week), tax tables and loader | Pub 15-T and GA guide worked examples match to the cent, weekly and biweekly |
| 3 | Payroll run from time logs + clinician stamps + staff clock, OT | Draft run shows gross, each tax, net and cash needed |
| 4 | Owner approval, lock, link-only stubs | Approved run locks its hours; stubs show current and YTD |
| 5 | PNC payment sheet + confirmations | Run is paid only when every worker has a confirmation |
| 6 | PHC invoices from approved hours or an uploaded file; held minutes | Sequential numbers; carrier per-day, family per-period; held minutes never billed without release |
| 7 | IME fee schedules, exam invoices, examiner pay | A report-submitted exam bills at its entity's rate once |
| 8 | Contractor invoice portal | Submit, approve, pay, 1099 total |
| 9 | QuickBooks (sandbox, then live), PHC only | Each event posts once; no clinical data ever sent |
| 10 | Tax calendar, reminders, quarterly and year-end exports | 941, G-7, DOL-4N figures tie to the runs |
