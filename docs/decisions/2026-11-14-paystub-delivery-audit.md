# Pay stub delivery audit

**Date:** 2026-11-14 · **Owner-directed** ("double check that paystubs would be available, staff notified, able to download the correct, branded stub") · Branch `claude/stoic-feynman-ozygr7`

## How it works (traced end to end)
1. Approving a payroll calls `writeStubs`. For each person paid it draws the PDF (`generatePayStubPDF`), files it in their Drive folder, writes a row to `staff_paystubs` (the store My GFC lists) and queues a `paystub_ready` email.
2. The email is link-only: no amount, links to `/caregiver#hours` or `/my#hours`, branded by the queue drain.
3. My GFC → Hours & Pay lists the person's own stubs (`GET /api/my/paystubs`); **Open** downloads the PDF (`GET /api/my/paystubs/:id/file`), audited as `paystub_read`. Another person's stub is a 404.
4. The PDF carries the GFC logo, employer name, address and EIN, the masked SSN, work state, earnings with year to date, taxes, totals, the payment line and the support contact.

## What was wrong, and fixed
- **A Cash App (P2P) payment printed as direct deposit.** The run's per-person channel never reached the PDF, so a person sent by P2P with a bank on file read "Direct deposit to account ending …", and one without read "Payment method not set". The earlier test drew the PDF directly with `payMethod: 'p2p'`, which no caller passes. The stub now uses the run's channel.
- **A Drive failure left an employee an email for a stub they could not open.** The row was written with no file and no Open button. A stub from an app payroll is now drawn again from its run when the Drive copy is missing or unreadable (`router.stubPdfForRow`, wired to My GFC through `regeneratePayStub`).
- **Year to date on a redrawn stub** counts only runs paid on or before that stub's payday, so an old stub never shows a later payday's totals.
- **"Paid" before payday.** My GFC shows "Payday Nov 13" until that date in Georgia, then "Paid Nov 13". The email now names the payday in words.

## Left as is
- The email goes at approval, which can be a few days before payday. It says the stub is ready, never that money was sent.
- Stubs from the Gusto import send no email (by design). Stubs filed by the payroll Apps Script are refused when Drive fails, so they never exist without a file.
- A redrawn stub reads the person's current bank last four and SSN last four; the filed Drive copy is the record when it exists.

## Verified
`test/paystub_delivery.test.js` drives approval through the real payroll routes and downloads through the real My GFC route: stub rows, the link-only email, branded PDF text read back, P2P wording, Drive-failure redraw, other person's stub refused, year to date stable after a later run. Each fix removed in turn fails a test. Full suite 3736 pass, 0 fail.
