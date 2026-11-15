# Contractors outside the U.S., and invoices as an uploaded file

Owner-directed, 2026-11-13 and 2026-11-14.

## Contractors outside the U.S.

- **Off until the Super Admin turns it on**: Payroll → Settings → Contractors outside the U.S., with the ways to pay them (Wise, international wire; at least one).
- A 1099 contractor answers **Where you live for tax** in My GFC → Pay Setup. In the U.S., they give a W-9 as before. Outside the U.S. (not a U.S. person, working abroad), they sign **IRS Form W-8BEN** instead. The app fills the official form (the IRS file is in `govforms/`) and files it to their Staff Record like the other signed forms.
- Their foreign tax ID and any U.S. SSN or ITIN are **sealed** (`w8benTins`), never sent to a browser. The W-8BEN's digital-signature box is given an empty appearance so the form flattens; the typed signature is drawn on the page.
- **No 1099** for a contractor abroad with a W-8BEN on file: payment for work done outside the U.S. by a foreign person is not U.S.-source income. The Year End page lists them by name and amount, so nothing is silently dropped.
- An **international wire** takes the bank name and country, SWIFT/BIC and the IBAN or account number (sealed; the last four digits show). Only a contractor abroad, where Settings offer it, can choose it.

## Invoices as an uploaded file

- A contractor may upload their own invoice (PDF, Excel .xlsx or CSV, up to 10 MB) with its total, instead of typing lines. If they give lines and a total, the two must agree.
- The file is typed by its bytes and stored in their Staff Record folder in Drive **before** the invoice is recorded. If Drive refuses it, nothing is recorded.
- **Managers and care coordinators review invoices with the Super Admin**: approve, or send back with what to fix. The contractor's email says where to look and never carries the note. **Paying stays the Super Admin's**, as does seeing how a contractor is paid.
- Managers and coordinators without the Payroll module see two tabs on /payroll: Timesheets and Contractors.
