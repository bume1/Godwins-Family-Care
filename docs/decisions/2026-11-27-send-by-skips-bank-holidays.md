# The Payment Sheet's send-by date skips bank holidays, with a switch

**Date:** 2026-11-27 · **Owner direction:** "send by date need to skip holidays (add an option to switch this on or off)"

## Why

For the Friday, November 27, 2026 payday, the Payment Sheet read "Send by Nov 26, 2026". That day was Thanksgiving, when PNC processes no ACH. The send-by date stepped back over weekends only.

## What changed

- **The holiday calendar.** `payrollTax.bankHolidays(year)` and `bankHolidayOn(date)` give the Federal Reserve holidays: New Year's Day, Martin Luther King Jr. Day, Washington's Birthday, Memorial Day, Juneteenth, Independence Day, Labor Day, Columbus Day, Veterans Day, Thanksgiving and Christmas.
  - A fixed holiday on a Sunday is observed the Monday after.
  - One on a Saturday is not moved, because the Federal Reserve is open the Friday before.
- **The send-by date.** `sendByDate(payDate, { skipBankHolidays, detail })` steps back over weekends always, and over bank holidays when the setting is on. With `detail` it also returns which holidays it stepped over.
  - A caller that passes no settings keeps the old weekends-only behavior.
- **The switch.** Payroll → Settings has "Skip bank holidays in the send-by date". It is on by default (`skipBankHolidays: true`) and takes only on or off.
- **Where it shows.**
  - The Payment Sheet reads, for example, "Send by Nov 25, 2026 (skips Thanksgiving Day, Nov 26, 2026)".
  - The morning payment reminder uses the same date.
- **Not changed.** The tax-reminder lead time still counts weekends only. Tax due dates follow `payrollCalendar.js`, which already says it does not model holidays.

## Verification

- `test/payroll_bank_holidays.test.js`, 5 tests:
  - the calendar, including Sunday and Saturday holidays;
  - the send-by date with the setting on, off and absent;
  - the setting's validation;
  - the Payment Sheet over the real route, with the switch turned off;
  - the page.
- A mutation that ignores holidays fails 2 of them.
- Full suite: 4,049 tests; the only 2 failures (`test/payroll.test.js` timesheets 36 and 38) fail identically on `main` and are date-dependent fixtures, unrelated to this change.
