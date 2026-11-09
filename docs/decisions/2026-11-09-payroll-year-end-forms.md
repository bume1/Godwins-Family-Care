# Payroll year end: W-2 and 1099-NEC, and one staff clock

**Date:** 2026-11-09 · **Owner-directed:** "yes to both" (build the official W-2/1099 forms; confirm the $2,000 threshold), then merge.

## What was built

- **Employee copies, to IRS Pub 1141 §2.3.** W-2 Copies B, C and 2 plus the Notice to Employee (with the EITC notice). The SSN is truncated (`XXX-XX-1234`). The PDF builder **refuses a full SSN**, so it never receives one. There is no logo, only the employer's name, which is all Pub 1141 allows on an employee copy.
- **1099-NEC Copy B and Copy 2, to Pub 1179 and the Rev. December 2026 form.** It includes the new boxes 1a to 1d, shows "Federal income tax withheld" in bold, and uses OMB No. 1545-0116. The TIN is truncated.
- **Box 12 code TT (new for 2026)** is the qualified overtime, meaning only the premium half. The engine's `overtime` earnings line is already exactly that, so `payrollCalendar.yearEnd` sums it. That function is the **one** source of year-end figures; a duplicate written in this change was removed.
- **Release freezes the figures** into `payroll_year_end`:
  - The frozen row keeps the last four digits only.
  - Each person opens their own form in My GFC, and the first open is recorded.
  - Anyone who consented to e-delivery is emailed a link, never figures.
  - Everyone else goes on a paper list, with Print and Mark Mailed.
  - Release is refused in these cases: before the year is over, while any run with that year's pay date is draft or unpaid, while employer details are missing, or while a person is missing an address, SSN or W-9 (each person is named). A second release is refused, because a change after release is a corrected form (W-2c or a corrected 1099).
- **E-delivery consent now shows the Pub 1141 §2.4 disclosures**, served by the server. Consent records their version, and a stale version is refused. A withdrawal is confirmed in writing with its effective date.
- **Filing sheet:** every box, full SSNs and TINs, decrypted per request, never stored, admin only. Each download is logged with counts only. Use it to key forms into SSA W-2 Online and the IRIS portal.
- **G-1003 totals** are shown for the Georgia Tax Center.
- **Reminders (Apps Script, Jan 20 to Feb 15):**
  - Anyone who has not opened an electronic form is reminded once.
  - The owner is told about paper forms not yet mailed, and about forms not released.

## Must not undo

- **No guessed layouts on a federal filing.** `efw2File` and `irisNecCsv` refuse any tax year missing from `EFW2_LAYOUT_YEARS` / `IRIS_NEC_LAYOUT_YEARS`; today both lists hold 2025 only.
  - Tax year 2026 changes both layouts. SSA's RW record gains the TT/TP fields and the IRIS columns gain boxes 1b to 1d. Neither 2026 layout could be fetched from the sandbox (ssa.gov returns 403).
  - Add 2026 only from the real spec at https://www.ssa.gov/employer/efw/26efw2.pdf, then check the output in AccuWage Online.
- **An employee or recipient copy is never handed a full number.** It is build-enforced: the PDF function throws.
- **The released row is the record.** Forms always render from the frozen row and never from today's profile.

## Also in this branch (merge with main)

- **One staff clock.** Main added W-2 staff clocking on the shared clock (`time_logs` rows with no shift and no client). Payroll now pays those rows at the payroll profile's hourly rate. Salaried staff are skipped, because the salary covers them. Payroll's own `staff_time_entries` clock and its `/api/my/clock` routes were removed.
- **One W-2/1099 source.** It is `user.employmentType`, set in User Management. The payroll profile follows it, and the payroll page shows it read-only and refuses a conflicting change with `EMPLOYMENT_TYPE_ON_USER`. A caregiver is always W-2.
- **$2,000 1099-NEC threshold: CONFIRMED.** Sources are P.L. 119-21 and the Instructions for Forms 1099-MISC and 1099-NEC (Rev. December 2026). A staged, unapproved shipped table picks up the corrected note at boot; an approved table is never rewritten.

## Verified

- 13 year-end tests. Of these, 17 of 17 mutations were caught.
- 3 tests for the clock and employment-type alignment. Of these, 8 of 8 mutations were caught.
- The PDFs were rendered and read back as images.
- Full suite: 0 failing.

## Open for the owner

- Fill in the Georgia withholding number, the SSA BSO user ID and a contact under Year End.
- Ask every employee to complete **Legal name and mailing address**.
- Before January, someone with a normal browser should check whether SSA's 2026 EFW2 spec is final. If it is, the upload file can be added. Otherwise, key the forms in from the filing sheet.
