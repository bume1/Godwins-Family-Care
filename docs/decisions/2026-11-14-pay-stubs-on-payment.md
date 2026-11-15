# Pay stubs go out when each payment is marked paid, with the receipt, filed in Finance

**Date:** 2026-11-14 · **Owner-directed** ("the paystub should only be generated after the payroll runs AND is marked paid … so full receipt information can be included"; "saved in our financial folder in google drive NOT caregiver documents") · Branch `claude/stoic-feynman-ozygr7`

## What changed
- **Approving a payroll issues no stubs and emails nobody.** The hours still lock at approval.
- **Marking a person paid** on the Payment Sheet records the receipt number with how the money was sent (Cash App, or direct deposit with the account's last four as it was that day). Then that person's stub is drawn, filed and emailed: "Your pay for payday … has been sent, and your pay stub is ready." The stub's payment line ends "· Receipt <number> · sent <date>" for direct deposit and Cash App alike. The person's own Cash App or phone never prints; only GFC's sending account does.
- **Filed in Finance, never the person's role documents.** `googledrive.uploadPayStubFile` files under `<folder>/Pay Stubs/<year>/Payday <date>/Pay stub <date> - <name>.pdf`. The folder is Payroll → Settings → "Pay stub folder in Drive" (paste the link; kept as its id). Left blank, it finds 07 Finance → Payroll under the app's Drive root.
- **A stub reads as issued.** The SSN last four, bank last four, method and work state are kept on the stub row (`snap`) and the payment comes from the run, so a stub redrawn later never picks up an address, SSN or bank changed afterwards. Year to date counts only paydays on or before its own.
- **Earlier stubs.** A stub written before this change (no `final`) is drawn from its run when opened, so it shows the receipt at once. **Redo Pay Stubs** on an approved or paid run files every paid person's stub again, with receipts, in the Finance folder, and emails nobody.

## Must not undo
- The stub is issued from the payment, not the approval. A test fails if approval writes a stub, if the receipt is dropped, or if a redraw stops using the issued snapshot.

## Verified
`test/paystub_delivery.test.js` (7 tests through the real routes), one guard in `payroll.test.js` repointed. Three mutations each caught. Full suite 3745 pass, 0 fail. Stub rendered and checked.
