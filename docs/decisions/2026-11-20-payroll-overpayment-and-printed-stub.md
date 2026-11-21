# Payroll: overpayment, amount sent, and a printed stub (2026-11-20)

Owner report: an employee was paid more than her correct net. She wanted the stub to show the correct pay, a copy to hand her, and the extra taken back from her next check.

## What was built
- **Amount sent on Mark Paid** (optional). Stored as `payments[userId].sentCents` only when it differs from net. The stub prints "Amount sent: $X, which is $Y more than this net pay. The difference will be taken from a later paycheck." (or the "less" version).
- **"Overpayment recovered (after tax)" adjustment type.** It lowers NET only. Gross and taxes do not change, because the extra was net money already taxed at nothing. A negative "correction" would wrongly lower taxable wages, so it is the wrong tool for this. It shows on the stub as a "Deductions after tax" table and counts in year to date (`deductionsCents`).
- **Print Stub** on each paid (or approved) person in the payment sheet: `GET /api/payroll/admin/runs/:id/stubs/:userId.pdf`, admin only, drawn from the run as it stands. Refused on a draft or a voided run. Logged as `paystub_printed`.

## How to correct an overpaid run
1. Void the paid run with a note.
2. Draft the same period again (taxes figure from the W-4; nothing typed by hand).
3. Approve it, then Mark Paid with the same receipt and the amount actually sent.
4. Print Stub.
5. On the next run, add "Overpayment recovered (after tax)" for the difference.

QuickBooks: a new run posts as a new journal; an old run already synced must be fixed in QuickBooks by hand.
