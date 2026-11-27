# Invoice runs can be voided until they are sent

_2026-11-27 · owner-directed: "we need to be able to null approved invoice runs. anything can be null until approved AND sent."_

**What changed.**
- **Void Run** on an approved run (Billing → Home Care Invoices → a run). It voids every invoice in the run. Shown only while nothing in the run has been sent.
- **Void** per client in the run's Send list, for a client whose invoices are not sent yet. This is the way out when some clients in a run are already sent.
- Both need a reason. Each voided invoice keeps who, when and why (`voidedAt`, `voidedBy`, `voidReason`), and the activity log records `billing_run_voided` or `billing_run_client_voided`.
- A run whose invoices are all void becomes **VOID** (chip, banner with who/when/why). This also happens when the last one is voided one at a time under Statements.
- After any void, the run's total, client count and sent count are recomputed from its live invoices, so the run list stays true.
- Voided invoices drop out of the send list, the combined PDF and Send All. Their shifts are free again (`phcInvoices.invoicedKeys` already skips void), so a new run over the same dates bills them.
- Draft runs are unchanged: **Delete Draft**, since nothing has been invoiced.

**Must not undo.**
- **A sent home care invoice cannot be voided** (`INVOICE_ALREADY_SENT`, in `patientBilling.transition`, so the run route and Statements both obey it). Paid counts as sent. A mistake on a sent invoice is corrected with a credit line on a later run.
- A run with any client sent cannot be voided whole (`RUN_ALREADY_SENT`, naming the invoices). Unsent clients can still be voided one at a time.
- Copay statements keep the older rule (a sent one can still be voided). The owner's rule was given for invoice runs; say if copays should follow it too.

**Verified.**
- `test/invoice_runs.test.js` +4 tests, `test/patient_billing.test.js` repointed (its reason-required check used a sent home care invoice, which now refuses earlier) plus a sent-copay case.
- Mutations: removing the sent check in `voidPlan` and in `transition` each fail a unit test. Removing the roll-up to VOID is caught by the probe, not the unit tests.
- `scripts/verify_invoice_runs.js` **58/58** over real HTTP (16 new): reason required, sent run and sent client refused, sent invoice refused under Statements, one client voided with totals and PDF following, a new run re-bills those hours, a whole run voided, voiding twice refused, a void run sends nothing.
- `verify_phc_invoices.js` 24/24, `verify_patient_billing.js` 25/25. Full suite 4059 pass; the 2 failures are timesheet tests that fail identically on `main`.
- `billing.html` JSX compiles. Not rendered in a browser this pass.

**Open for the owner.** Rebuild the container on the EC2 box; nothing here is live until then.
