# Invoice runs: approved hours become invoices, the way payroll runs work

**Date:** 2026-11-15 · **Owner-directed** · Branch `claude/invoice-runs`

## What the owner asked
- When a caregiver's hours for a pay period are approved, those hours show in billing and its export, with the hours billed and the rate.
- An invoice "run" like the payroll runner, producing invoices in the layout of the invoice set last sent to a client's LTC carrier.
- Manual hours changes and added lines, built like payroll's.
- An Excel upload of billing hours feeding the same generator.
- Sending: email a carrier's invoices to its claims address, and a family's to the Bill To email plus the client and POA.
- Some carriers pay against a daily maximum and need one invoice per day; others don't.

## What was built
- **`invoiceRuns.js` (pure).** It decides:
  - which hours are approved;
  - edits and added lines;
  - the send plan;
  - the combined PDF's file name.
- **What counts as approved.** A shift is billable once its caregiver's timesheet approved **those exact minutes**, or once payroll has paid it.
  - Approving a timesheet now stores the hour items it covers (`office.hours`, from `payrollTimesheets.approvedHours`).
  - A time log corrected afterwards reads "Changed since approved" and is not billed.
  - An approval made before this change covers its caregiver's whole period.
  - Shifts still waiting are **listed, never billed quietly**. "Bill Them Anyway" takes a reason that is kept on the run.
  - Hours from an uploaded file are the office's own figures and count as approved.
- **Runs (`billing_runs`).** Draft first.
  - Change a shift's billed hours, with a reason. The clocked hours stay on record and the line keeps `editedFrom`.
  - Leave a shift off, with a reason.
  - Add a line, with a reason: hours at the client's rate, or a fixed amount (a negative amount is a credit). It must be dated inside the run.
  - Rebuild From Hours and Delete Draft.
  - Two drafts never cover the same days.
  - A draft is recomputed every time it is read.
  - **Approve** makes the invoices as drafts on Statements, carrying `runId`. It refuses an invoice of $0 or less.
- **Per day or per period.** Each carrier has a setting, `invoiceMode`:
  - **Bill each day**: one invoice per date of service, for a daily maximum. This is the default, and the behavior until now.
  - **One invoice for the whole period.**
  - A family is always billed once for the period.
  - The PDF prints the service period on a period carrier invoice.
- **One PDF per client per run.** `pdf-lib` merges that client's invoices in date order into `GFC_Invoices-<Client>_<from>_to_<to>.pdf`.
- **Send.** Mail goes from the office mailbox with the office (`ROI_ADMIN_EMAIL`) also on the To line, because the mailer has no Cc.
  - **Carrier:** the PDF goes to its claims email with `phi: true`, so it sends only on the covered transport.
  - **Family:** the PDF goes to the Bill To email. The client and POA get the usual "new statement" notice with no amount, and nobody is emailed twice.
  - **Missing claims email:** a carrier with none is blocked by name.
  - **Failed email:** the invoices stay drafts and nothing is marked sent.
  - **Mark Sent:** for invoices mailed or faxed by hand.
- **The one-step "Generate Invoices" route is retired.** It billed every completed shift whether or not the timesheet was approved. Runs are now the one way invoices are made, and `scripts/verify_phc_invoices.js` was ported to them.
- **Client Hours Export (`billing.csv`).** Four columns are added at the end, so imports mapped by column position keep working:
  - Client Rate
  - Billed Amount (worked out from minutes)
  - Timesheet
  - Invoice
- **Spreadsheets.**
  - The Billing page reads an .xlsx in the browser with SheetJS, raw: a date is a day number, a time a fraction of a day. No time zone touches it.
  - The importer reads Excel day numbers and fractions, 24-hour times, times with seconds, two-digit years, and hand-kept headers (Date, Start, End, Total Hours).
  - The Hours column must still agree with the times.
  - A blank template downloads from the page.
- **Credits print correctly:** "-$20.00", not "$-20.00", on the PDF, on the portal and on the page.

## Verification
- `test/invoice_runs.test.js`: 20 tests, with 4 mutations caught.
- Two older tests were repointed and none deleted:
  - the drafting moved into `phcDraftFrom`;
  - "Date" alone is now a known header.
- Full suite: 3,867 passed, 0 failed.
- `scripts/verify_invoice_runs.js`: 42/42 against a real server.
  - Hours waiting, then approved and billed.
  - Per day versus per period.
  - An edit (with a reason), a shift left off, and a credit line.
  - Approve, then the merged PDF.
  - A send whose email fails leaves the invoices as drafts.
  - Mark Sent.
  - The export columns.
  - An Excel-style upload.
- `scripts/verify_phc_invoices.js`: 24/24.
- Rendered in Chromium (list, draft and approved views, no page errors). The merged PDFs were read back page by page.

## Not proven from the sandbox
- That Google delivers the carrier email with its attachment. The send path stops on any failure, and only a live send proves it.

## Open for the owner
- Every carrier needs its **claims email** and **how it is billed** set under Billing, then Settings. Carriers already on the list read as "Bill each day" until changed.
- No Cc in the mailer, so the office address appears on the To line beside the carrier.
