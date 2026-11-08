# GFC Payroll, Billing & QuickBooks Build Spec

Nov 8, 2026 · @Bianca Ume

## Overview

GFC replaces Gusto with an in-house payroll and billing module inside the GFC app, with QuickBooks Online as the books. Staff are paid from GFC's PNC business account, and the only recurring software cost is QuickBooks Simple Start ($38/mo).

**Goals**

- Pay staff on time on GFC's own schedule, with no platform submission deadline.
- Enter time once, for every employee. Pay stubs, client invoices and QuickBooks entries all come from that same data.
- Enforce each home care client's daily hour cap and rebalance excess hours after the shift, with a clean audit trail.
- Cut payroll and filing subscription fees to zero.

**How data flows for Caregi****vers**

1. Caregiver shifts are logged in the GFC app (actual date, start, end, client, caregiver).
2. The app checks each client's daily cap and flags excess hours for rebalancing.
3. Payroll runs on actual hours worked. The app calculates taxes, creates pay stubs and builds the payment list for PNC.
4. Invoices run on billed hours (after rebalancing) and are split by payer.
5. Payroll summaries, invoices and contractor payments sync to QuickBooks through its API.
6. PNC transactions import into QuickBooks through the bank feed and match to those entries.

**How data flows for all other W-2 employees (clinicians, admin, exam staff)**

1. The employee clocks in and out in the app, tagging the time as clinical, admin, training, exam or a client visit.
2. Salaried or per-visit staff log visits or exams instead of hours where their pay type calls for it.
3. Admin approves time for the pay period.
4. Payroll runs on approved time. The app calculates taxes, creates pay stubs and adds them to the PNC payment list.
5. The payroll summary syncs to QuickBooks, split by wage account (Home Care or Clinical).

**How data flows for contractors**

1. The contractor submits an invoice in the app with line items and an optional PDF.
2. Admin approves or rejects it with a note.
3. Approved invoices join the next payout list (PNC or Wise).
4. The paid invoice syncs to QuickBooks as Contract Labor and adds to the contractor's 1099 total.

**Phases**

- **Phase 1:** time clock for all W-2 employees, daily caps, rebalancing, payroll engine, pay stubs, contractor invoices, PNC payment list.
- **Phase 2:** invoices from the GFC template, payer split, QuickBooks sync.
- **Phase 3:** tax deposit and filing calendar, quarterly and year-end report exports, optional staff portal for past stubs.

## Users and access

Only Bianca can approve payroll, rebalancing and invoices. Everyone else sees only what their role needs.

| Role | Can do | Cannot do |
| --- | --- | --- |
| Admin (Bianca) | Everything: approve payroll, approve rebalancing, send invoices, edit tax tables, connect QuickBooks |  |
| Scheduler / EA | Log and edit shifts, propose rebalancing | Approve payroll, see SSNs or bank numbers |
| Employee (any W-2 role) | Clock in and out, view own time entries and pay stubs | See other staff or client billing |
| Contractor | Submit invoices, view their status, payments and 1099 info | See payroll data |

- Every approve action records who approved it and when.
- SSNs and bank account numbers are masked for everyone except Admin (last 4 shown).

## Data model

The key design choice: a shift's **worked hours** (what payroll uses) and its **billed allocation** (what invoices use) are stored separately, so rebalancing never touches pay.

| Table | Purpose | Key fields |
| --- | --- | --- |
| `workers` | W-2 employees and 1099 contractors | id, type (W2/1099), name, address, work\_state, SSN or TIN (encrypted), pay\_rate, pay\_type (hourly/salary/per-visit), W-4 fields, GA G-4 fields, bank routing + account (encrypted), hire\_date, status |
| `clients` | Home care clients | id, name, service\_line, primary\_payer, care\_agreement\_id, rebalance\_approved (bool + date + approver) |
| `client_caps` | Daily hour limits per client and payer | client\_id, payer (family / LTC insurer), max\_hours\_per\_day, max\_hours\_per\_week (optional), effective\_from, effective\_to |
| `bill_rates` | What GFC charges | client\_id, service\_code, rate\_per\_hour, effective\_from |
| `shifts` | Time clock for every W-2 employee (caregivers, clinicians, admin); the source of truth for pay. client\_id is optional; work\_type tags client visit, clinical, admin or training | id, worker\_id, client\_id, service\_date, clock\_in, clock\_out, break\_minutes, worked\_hours, notes, status (logged / approved / locked) |
| `billed_allocations` | Billed hours per day after rebalancing | id, shift\_id, client\_id, bill\_date, hours, payer, source (original / rebalanced), rebalance\_id |
| `rebalances` | Each rebalancing action | id, client\_id, period, moves (from\_date, to\_date, hours), reason, proposed\_by, approved\_by, approved\_at |
| `pay_periods` | Pay calendar | id, start\_date, end\_date, pay\_date, frequency, status |
| `payroll_runs` | One run per pay period | id, pay\_period\_id, status (draft / approved / paid / posted\_to\_qbo), totals, approved\_by |
| `paystub_lines` | Line items per worker per run | run\_id, worker\_id, type (earning / tax / deduction / employer\_tax), code, hours, rate, amount, ytd\_amount |
| `invoices` | Client and payer invoices | id, client\_id, payer, period, status (draft / sent / paid), total, qbo\_invoice\_id, pdf\_url |
| `invoice_lines` | Line items | invoice\_id, bill\_date, service\_code, hours, rate, amount, allocation\_ids |
| `tax_tables` | Yearly federal and GA rates | year, jurisdiction, table\_type, data (JSON), loaded\_at |
| `tax_liabilities` | Taxes owed and their due dates | run\_id, agency (IRS / GA DOR / GA DOL), tax\_type, amount, due\_date, paid\_date, confirmation\_no |
| `qbo_sync_log` | Every QuickBooks call | entity, local\_id, qbo\_id, action, status, error, timestamp |
| `audit_log` | Every change to shifts, rates, runs, invoices | table, record\_id, field, old\_value, new\_value, user, timestamp |

Contractor tables:

| Table | Purpose | Key fields |
| --- | --- | --- |
| `contractor_invoices` | Invoices contractors submit for payout | id, worker\_id, invoice\_no, period\_start, period\_end, total, attachment\_url, status (submitted / approved / rejected / paid), submitted\_at, reviewed\_by, reviewed\_at, review\_note, payment\_confirmation |
| `contractor_invoice_lines` | Line items on a contractor invoice | invoice\_id, service\_date, description, client\_id (optional), qty, unit (hour / visit / exam / flat), rate, amount |

Payer tables (GFC bills multiple LTC carriers, not one):

| Table | Purpose | Key fields |
| --- | --- | --- |
| `payers` | Each LTC insurance carrier or family payer | id, type (LTC carrier / family / other), name, claims attention line, mailing address, claims email, submission method (email / mail / portal), invoice format settings |
| `client_payers` | Links a client to each payer that covers them | client\_id, payer\_id, insured name, policy #, claim #, daily cap, effective\_from, effective\_to, is\_primary |

Tax source table (used by the scheduled rate watcher):

| Table | Purpose | Key fields |
| --- | --- | --- |
| `tax_sources` | Where each jurisdiction publishes its rates | id, jurisdiction (federal / state code), agency, table\_type, source\_url, last\_hash, last\_checked\_at, last\_changed\_at, staged\_table\_id |

## Time clock, daily caps and rebalancing

Rebalancing happens after the shift, moves **billed** hours only, and never changes what a caregiver is paid or the dates they worked.

**Shift capture**

Every W-2 employee clocks in and out in the app, not just caregivers. Client visits are tagged to a client; clinical, admin and training time is tagged by work type. Daily cap checks run only on entries tagged to a home care client.

- Each time entry records the actual work date, clock-in, clock-out and break. `worked_hours` is calculated, not typed.
- On save, the app creates one `billed_allocation` per shift on its actual date (source = original).
- Shifts lock once the payroll run that includes them is approved. Later corrections go in as adjustment entries, never edits to locked rows.

**Cap check (runs on every shift save)**

1. Sum billed hours for that client on that date, per payer.
2. Compare to `client_caps.max_hours_per_day` for that payer.
3. If over, flag the excess on the client's rebalancing queue with the hours and date.

**Rebalancing screen**

- Shows the client's billing period as a calendar: billed hours per day, the cap, and room left on each day.
- Excess hours appear as a tray. The app suggests the nearest days in the same period with room. The admin can accept the suggestions or drag hours to another day.
- On approve, the app writes a `rebalances` record and new `billed_allocations` (source = rebalanced). Original allocations stay in the history.
- Invoices for that period regenerate automatically.

**Rules the app enforces**

- Rebalancing only runs for clients with `rebalance_approved = true` (family approval on file, with date and approver).
- Hours can only move within the same billing period. They cannot move to a date before the client's start date or after the period ends.
- Total billed hours for the period must equal total worked hours. Nothing is added or lost.
- **LTC insurer payer:** each insurer invoice bills up to the daily cap on its actual service date and prints the actual clock-in and clock-out from the shift. Minutes over the cap go to an Unbilled Over-Cap hold for that client (no invoice for now). The admin can later release held minutes to a family invoice or write them off.
- **Family payer:** rebalanced hours are allowed as agreed with the family.
- Payroll always uses `shifts.worked_hours` on `shifts.service_date`. Rebalancing has no effect on pay stubs, overtime or tax math.

## Payroll engine

The engine calculates every W-2 paycheck from approved shifts and the current year's tax tables, then produces stub lines, tax liabilities and a payment list. All rates live in `tax_tables` and are never hard-coded.

**Gross pay**

- Hourly: approved `worked_hours` × `pay_rate`.
- Overtime: hours over 40 in a workweek (Sunday to Saturday unless set otherwise) at 1.5× the regular rate. Home care aides employed by an agency are owed overtime.
- Salary and per-visit pay types supported for clinicians.
- One-off earnings (bonus, mileage reimbursement) entered as separate lines. Reimbursements are non-taxable.

**Employee withholding**

| Tax | Method | Source |
| --- | --- | --- |
| Federal income tax | Percentage method using the worker's W-4 entries | IRS Publication 15-T, loaded each January |
| Social Security | 6.2% up to the yearly wage base, tracked with YTD wages | IRS yearly figures |
| Medicare | 1.45%, plus 0.9% additional on wages over $200,000 YTD | IRS |
| Georgia income tax | GA withholding method using the worker's G-4 entries | Georgia DOR Employer's Tax Guide, loaded each January |

**Employer taxes (shown on the run summary, not on the stub)**

| Tax | Rate | Notes |
| --- | --- | --- |
| Social Security match | 6.2% | Same wage base as employee |
| Medicare match | 1.45% |  |
| FUTA | 0.6% on the first $7,000 per worker per year | Assumes full GA SUTA credit |
| Georgia SUTA | GFC's assigned rate on the GA taxable wage base | Rate and base from GA DOL notice, editable in settings |

**Contractors (1099)**

- No withholding. Contractors are paid only from an approved contractor invoice (see Contractor invoices below).
- The app tracks YTD totals per contractor for 1099-NEC.
- International contractors are paid through Wise. The app records the payment and stores their W-8BEN instead of a W-9.

**Run steps**

1. Pull approved shifts for the pay period.
2. Calculate gross, then each tax, then net, rounding each line to the cent.
3. Write `paystub_lines` with current and YTD amounts.
4. Write `tax_liabilities` with due dates from GFC's deposit schedule.
5. Show a review screen with every worker's gross, taxes, net and the total cash needed.
6. Admin approves. Shifts lock, stubs generate, payment list builds.

**Accuracy checks**

- Unit tests against the worked examples in Publication 15-T and the GA tax guide for each new year's tables.
- A run cannot be approved if any worker is missing a W-4, G-4 or bank details (unless paid by check).

**Contractor invoices**

1. The contractor logs into the app and submits an invoice: period, line items (date, description, client if any, qty, unit, rate) and an optional PDF of their own invoice.
2. The app checks the math, flags lines with no matching visit or exam on the schedule, and flags any invoice number already used by that contractor.
3. Admin approves, rejects with a note, or edits a line with the change logged. Rejected invoices go back to the contractor to fix and resubmit.
4. Approved invoices join the next payout list (PNC for US contractors, Wise for international). Status moves to paid when the confirmation number is entered.
5. Each paid invoice posts to QuickBooks as a Purchase against Contract Labor and adds to the contractor's 1099-NEC total.

## Pay stubs and invoices

Both documents are generated as branded PDFs from one shared HTML template system, based on GFC's existing home care invoice template (to be added to the repo as `templates/invoice-base.html`).

**Shared template rules**

- GFC brand colors: header #033D50, accent bar #F5CD85, body background #FAF7F2, headings Georgia serif, body Arial.
- GFC logo, legal name, address, phone and EIN in the header.
- Rendered to PDF with headless Chrome (Puppeteer) for print-accurate output.
- Each PDF is stored, linked to its record, and regenerated whenever its source data changes (stubs only until the run is locked).

**Pay stub contents**

| Section | Fields |
| --- | --- |
| Header | GFC name, address, EIN, pay period, pay date, stub number |
| Employee | Name, last 4 of SSN, work state, pay rate |
| Earnings | Each line: type, hours, rate, current amount, YTD amount |
| Taxes withheld | Federal income tax, Social Security, Medicare, Georgia income tax, each with current and YTD |
| Deductions | Any other deductions, current and YTD |
| Totals | Gross, total taxes, total deductions, net pay, current and YTD |
| Payment | Method and last 4 of the deposit account |

- Delivery: emailed to the worker from admin@godwinsfamilycarellc.com and saved to the worker's record.

**Invoice contents (home care line)**

| Section | Fields |
| --- | --- |
| Header | GFC details, invoice number, invoice date, due date, billing period |
| Bill to | Payer name and address (family or LTC insurer), client name, policy or claim number if insurer |
| Lines | Bill date, service description, caregiver initials, hours, rate, amount |
| Totals | Subtotal, prior balance, payments received, amount due |
| Payment | How to pay, remit address, terms |

- One invoice per client per service date (matches GFC's current LTC carrier invoice format; works for any carrier). Invoice number = GFC-\[client initials\]-\[YYMMDD of service date\], for example GFC-JS-261006. Bill-to block includes Insured name, Policy # and Claim # for insurer payers. Amount is calculated from billed minutes × rate ÷ 60 and rounded to the cent (292 min × $30/hr = $146.00); hours display to 2 decimals plus "X hr Y min".
- Rebalanced lines carry a small marker and a footnote stating the period total is unchanged.
- Invoice numbers are sequential and never reused.

## Paying staff through PNC

For now, staff are paid from the PNC business app. The GFC app produces a ready-to-send payment list so each payroll takes minutes, and a bank file export is built in for later.

**Phase 1: payment list (now)**

- After a run is approved, the app shows a payment sheet: worker, net amount, bank name, routing number, last 4 of the account, and a copy button per field.
- Admin sends each payment in the PNC app, then enters or pastes the PNC confirmation number per worker.
- A run moves to `paid` only when every worker has a confirmation number.
- International contractors are listed separately with their Wise details.

**Phase 2: bank file export (later)**

- The same run can export a NACHA-format ACH file (PPD entries for employees, CCD for business contractors) for upload if PNC enables batch ACH or GFC moves payroll to a bank that accepts uploads.
- Add a CSV export as a fallback for banks that take CSV batch uploads.

**Timing**

- Each pay period stores a target pay date and a send-by date. The app reminds the admin on the send-by date.
- PNC same-day ACH cutoff is 3:00 PM ET where enabled. The send-by default is the business day before the pay date until same-day is confirmed on GFC's account.

## QuickBooks Online integration

The app writes to QuickBooks Online (Simple Start plan) through the QuickBooks Online Accounting API on Intuit's free Builder tier. Writes are unlimited and free, and GFC's read volume is far under the 500,000/month cap.

**Connection**

- Register a private app on the Intuit Developer portal. Build and test against a sandbox company first.
- OAuth 2.0 with the `com.intuit.quickbooks.accounting` scope. Store access and refresh tokens encrypted; refresh the access token before its 1-hour expiry and alert the admin before the refresh token expires.
- Every create call sends a unique `requestid` so a retry never creates a duplicate. Store the returned QuickBooks id on the local record.

**Chart of accounts to set up first**

| Account | Type | Used for |
| --- | --- | --- |
| PNC Business Checking | Bank | Connected to the PNC bank feed |
| Payroll Clearing | Other current liability | Net pay owed between run approval and payment |
| Payroll Liabilities: Federal Withholding | Other current liability | Employee federal income tax withheld |
| Payroll Liabilities: FICA | Other current liability | Employee + employer Social Security and Medicare |
| Payroll Liabilities: GA Withholding | Other current liability | Employee GA income tax withheld |
| Payroll Liabilities: FUTA | Other current liability | Federal unemployment |
| Payroll Liabilities: GA SUTA | Other current liability | Georgia unemployment |
| Wages: Home Care | Expense | Caregiver gross wages |
| Wages: Clinical | Expense | Clinician gross wages |
| Payroll Tax Expense | Expense | Employer share of taxes |
| Contract Labor | Expense | 1099 contractor payments |
| Income: Private Home Care | Income | Home care invoices |
| Income: In-Home Primary Care | Income | Primary care billing |
| Income: Psych Care | Income | Psych billing |
| Income: C&P / IME Exams | Income | Exam contracts |

Simple Start has no class tracking, so service lines are separated by income and wage accounts.

**What syncs**

| Event in the app | QuickBooks object | Entry |
| --- | --- | --- |
| Payroll run approved | JournalEntry | Debit wages (gross) and payroll tax expense (employer taxes). Credit Payroll Clearing (net pay) and each liability account (taxes withheld + employer taxes). |
| Each worker paid (confirmation entered) | Purchase from PNC Checking | Debit Payroll Clearing, one per worker. These match the PNC bank feed lines one to one. |
| Tax deposit made (EFTPS, GA portals) | Purchase from PNC Checking | Debit the matching liability account. Matches the bank feed debit. |
| Contractor paid | Purchase from PNC Checking, vendor = contractor | Debit Contract Labor. Contractors are created as Vendors with 1099 tracking on. |
| Invoice sent | Invoice, customer = payer | Lines use service Items mapped to the right income account. |
| Client payment received | Payment linked to the invoice | Deposited to Undeposited Funds, then matched to the PNC deposit. |

**Reconciliation**

- PNC transactions import through the bank feed. Because the app already created matching entries, the bank feed should show them as matches to confirm, not new items to categorize.
- A monthly check in the app compares: Payroll Clearing balance (should be $0 after all workers are paid), liability balances vs. upcoming tax due dates, and open invoices vs. QuickBooks A/R.
- `qbo_sync_log` shows any failed sync with a retry button.

## Tax deposits, filings and reminders

The app builds GFC's tax calendar from `tax_liabilities` and a settings page, then emails the admin ahead of every due date. The admin pays and files in the government portals and records the confirmation number in the app.

**Settings the admin enters once**

- Federal deposit schedule: monthly or semiweekly (set by the IRS lookback period; most new employers are monthly).
- Georgia withholding filing frequency, as assigned by the Georgia DOR.
- Georgia SUTA rate and taxable wage base, from the GA DOL notice.
- Reminder lead time (default 5 business days).

**Calendar the app generates**

| What | Where | When |
| --- | --- | --- |
| Federal withholding + FICA deposit | EFTPS | Monthly schedule: 15th of the next month. Semiweekly: Wednesday or Friday after payday per IRS rules. |
| GA withholding deposit | Georgia Tax Center | Per GFC's assigned frequency |
| Form 941 (quarterly federal return) | IRS e-file or mail | Last day of the month after each quarter |
| GA G-7 (quarterly withholding return) | Georgia Tax Center | Per GA DOR schedule |
| GA DOL-4N (quarterly unemployment tax and wage report) | GA DOL employer portal | Last day of the month after each quarter |
| FUTA deposit | EFTPS | Quarterly, only when the running liability passes $500 |
| Form 940 (annual FUTA return) | IRS | January 31 |
| W-2s to employees and SSA, plus W-3 | SSA Business Services Online | January 31 |
| GA G-1003 (annual withholding reconciliation) | Georgia Tax Center | January 31 |
| 1099-NEC to contractors and IRS | IRS IRIS portal | January 31 |
| New hire report | Georgia new hire reporting site | Within 10 days of each W-2 hire |
| Load new tax tables | App settings | Early January each year |

**Exports the app produces**

- Quarterly summary with every figure needed for the 941, G-7 and DOL-4N, laid out by form line.
- Year-end W-2 and 1099-NEC data in the format the SSA and IRIS upload tools accept, plus a printable copy per worker.

**Year-end W-2 and 1099 delivery**

1. On January 2, the script builds each W-2 employee's W-2 (Copies B, C and 2) and each contractor's 1099-NEC from the year's locked payroll and paid contractor invoices.
2. The admin reviews a summary and approves.
3. Employees and contractors get an email from admin@ saying their form is ready, with a link to download it after signing in to the app. The form itself is never attached to the email.
4. The app records when each person opens their form. Anyone who hasn't opened it by January 20 gets a reminder, and the admin sees who is still outstanding.
5. The same run produces the SSA upload file for W-2s and W-3, the IRIS upload data for 1099-NECs, and the GA G-1003 totals, all due January 31.

**Electronic delivery consent:** the IRS requires each person to agree to receive their W-2 or 1099 electronically. The app collects this as a checkbox during onboarding and stores the date. Anyone without consent on file gets flagged for a mailed paper copy, and the app prints it ready to mail.

**Form layout:** the app generates official substitute forms, not a GFC-branded design. Employee W-2 copies (B, C and 2) follow IRS Publication 1141 (substitute W-2 and W-3 rules). Contractor 1099-NEC copies follow IRS Publication 1179. No template from GFC is needed. Copy A of the W-2 is never printed: it is filed electronically through SSA Business Services Online in the SSA's EFW2 file format. The IRS copy of the 1099-NEC is filed through IRIS. Each year's form layout and EFW2 spec are checked by the tax rate watcher like any other source.

## Scheduled automation (Google Apps Script)

A Google Apps Script project owned by admin@godwinsfamilycarellc.com runs the schedule. It uses time-driven triggers and calls the GFC app's secured API, so calculations, rate checks and notifications happen on their own.

**Jobs and schedule**

| Job | Runs | What it does |
| --- | --- | --- |
| Tax rate watcher | Weekly (Mondays 6 AM ET), daily Dec 1 to Jan 31 | Checks each source in `tax_sources` (IRS Pub 15-T and wage base pages, GA DOR, GA DOL, plus every state where a worker is set up) for a new version. When a page or PDF changes, it downloads it, stores it, stages the new rates and emails the admin to approve |
| Rate activation | Daily 5 AM ET | Switches staged rates to active on their effective date once approved. Payroll always uses the rate active on the pay date |
| Pay period close | Day after each period ends, 7 AM ET | Pulls approved time and contractor invoices, runs the payroll calculation as a draft, emails the admin a review link with totals and cash needed |
| Missing time check | Daily during the period | Emails employees with missing clock-outs and the admin with unapproved time |
| Payment reminder | Send-by date, 8 AM ET | Reminds the admin to send PNC payments; repeats at noon if any confirmation is missing |
| Tax deposit reminder | Lead time before each due date | Lists each agency, amount and due date from `tax_liabilities`; repeats daily until a confirmation number is entered |
| Filing reminder | Lead time before 941, G-7, DOL-4N, W-2, 1099 dates | Attaches the export for that filing |
| QuickBooks sync check | Nightly | Retries failed syncs and emails the admin if anything still fails |

**Multi-state support**

- `tax_sources` holds one row per jurisdiction: state, agency, source URL, table type and last version seen.
- Adding a worker in a new state prompts the admin to add that state's withholding and unemployment registration numbers. The watcher then starts tracking that state.
- The engine picks each worker's state tables from `workers.work_state`.

**Approval before rates go live**

Governments publish withholding tables as PDFs and web pages, not a live feed, and they change about once a year (a few states change mid-year). The watcher catches every change automatically, then shows the old and new rates side by side. The admin clicks approve and the rates take effect on their date. Nothing changes pay without that click.

## Security and audit trail

The module holds SSNs, bank account numbers and client health-related billing data, so it follows the same standard as the rest of the GFC app's PHI handling.

- **Encryption:** SSN/TIN and bank routing + account numbers encrypted at the field level (AES-256), with keys in AWS KMS or the app's existing secrets store, never in code or the database.
- **Masking:** full values shown only to Admin, only on demand, and each reveal is logged.
- **Never in URLs, logs or emails:** no SSNs, account numbers or tax IDs in query strings, server logs or email bodies. Pay stubs show last 4 only.
- **Audit log:** every create, edit, approve and delete on shifts, rates, caps, rebalances, runs, stubs and invoices writes old value, new value, user and timestamp. Locked records cannot be edited, only adjusted with a new entry.
- **Sessions:** role-based access per the Users table, with auto sign-out after inactivity.
- **Backups:** nightly database backup with 7-year retention for payroll records (IRS requires at least 4 years).

## Build order and acceptance criteria

Build in this order. Each step ships only when its checks pass.

| # | Build | Done when |
| --- | --- | --- |
| 1 | Data model + migrations, encryption, audit log | All tables exist; SSN and bank fields are unreadable in the database without the key; every edit writes an audit row |
| 2 | Workers, clients, caps, rates setup screens | Admin can add a W-2, a contractor and a client with a daily cap and bill rate |
| 3 | Shift logging + cap check | A shift over the cap is flagged with the exact excess hours |
| 4 | Rebalancing screen | Excess hours move to days with room; period total is unchanged; insurer lines never move dates; original allocations stay in history |
| 5 | Tax tables loader + payroll engine | Test cases match Pub 15-T and GA guide examples to the cent; overtime applies over 40 hours/week |
| 6 | Payroll review, approve and lock | Approved run locks its shifts; totals show gross, each tax, net and cash needed |
| 7 | Pay stub PDFs + email | Stub matches the template, shows current and YTD for every line, and emails to the worker |
| 8 | PNC payment sheet + confirmations | Run moves to paid only when every worker has a confirmation number |
| 9 | Invoices from template + payer split | Over-cap insurer hours land on the family invoice; invoice numbers are sequential |
| 10 | QuickBooks connection (sandbox) | OAuth works; tokens refresh on their own; a test journal entry posts |
| 11 | QuickBooks sync for payroll, payments, contractors, invoices | Each event posts once (no duplicates on retry); Payroll Clearing is $0 after all workers are paid |
| 12 | Tax calendar, reminders, quarterly and year-end exports | Reminder emails go out on lead time; 941, G-7 and DOL-4N figures tie to the runs |
| 13 | Switch QuickBooks from sandbox to GFC's live company | One full pay period runs end to end in production |

Time clock for all W-2 roles ships with step 3. The contractor invoice portal (submit, approve, pay, sync) ships with steps 8 and 11.

**Parallel run:** run the first live pay period side by side with a manual calculation (or the last Gusto stub for the same hours) before retiring Gusto.

## Open questions

- [ ] Are all 3 W-2s working in Georgia? Any other state means that state's withholding and unemployment rules get added.
- [ ] Pay frequency: weekly, every two weeks, or twice a month?
- [ ] Workweek start day for overtime (default Sunday)?
- [ ] Billing period for home care invoices: weekly, every two weeks or monthly?
- [ ] Which app and stack: the GFC Node app (`server.js`), and where does clinical billing live today (GFC app or OpenEMR)?
- [ ] Add the home care invoice template file to the repo as `templates/invoice-base.html` (or share the PDF/doc to convert).
- [ ] GFC's federal deposit schedule, GA withholding frequency and GA SUTA rate (from IRS and GA notices).
- [ ] Does PNC enable same-day ACH or batch uploads on GFC's account, and at what fee?
- [ ] Who besides Bianca needs access, and in which role?
