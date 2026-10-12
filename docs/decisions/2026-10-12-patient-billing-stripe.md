# Patient billing: copays and home care hours, paid on Stripe

**Date:** 2026-10-12 · **Owner-directed** ("bill copays and then home care hour payments, so both")
This is the first B-series build (B2 patient payment + the start of B3 PHC invoicing).
It doubles as the short architecture note the session plan asks for before billing work.

## How it works
- **Statements live in the app** (`patient_invoices`, PHI, registered). Rules in
  `patientBilling.js`; routes in `server.js` under `/api/gfc/billing` (patient) and
  `/api/gfc/admin/billing` (office). Webhook: `/api/webhooks/stripe`.
- **Copay:** a FIXED dollar amount the office sets per patient on the client's Billing
  card (the plan's stated copay). When billing submits a signed visit, a copay
  statement is created OPEN and the patient is told. A re-submit never bills twice.
  **No copay set = nothing collected at the visit.**
- **Home care:** the office picks dates; completed, clocked caregiver visits × the
  agreed hourly rate, one line per Georgia day, raised to the agreed daily minimum.
  Created as a DRAFT, checked, then sent.
- **Paying:** the patient (or POA) presses Pay; the app opens a Stripe Checkout page;
  Stripe's signed webhook marks it paid. The office can record a check, cash or other
  payment. Statuses: draft → open → paid, or void with a reason. Paid and void are final.

## Must not undo
- **The app never works a copay out from a charge.** For Medicare the patient's share
  is 20% of the allowed amount and only the insurer's payment report knows it
  (`GFC_Billing_Segment_App_Integration_Spec.md` §6). Collect only a plan's fixed copay.
- **Stripe never sees PHI.** It gets "Godwins Family Care · Invoice GFC-INV-XXXXXX",
  an amount in cents and our internal invoice id. No name, email, date of service or
  description of care. `stripeSafe()` refuses anything else; build-enforced and
  probe-checked against every captured Stripe call.
- **Only a signed webhook for the exact amount marks a statement paid online.** Staff
  cannot record a "stripe" payment by hand. Retries are idempotent.
- **Plain family never see billing**; the client and a designated POA do.
- Statement emails say a statement is ready, never the amount or the service.

## Setup (owner)
1. Create a Stripe account (any; no healthcare plan or BAA is needed under this segregation).
2. Set `STRIPE_SECRET_KEY` (use the `sk_test_` key first) and add a webhook endpoint
   `https://<app>/api/webhooks/stripe` for `checkout.session.completed` and
   `checkout.session.async_payment_succeeded`; set its signing secret as `STRIPE_WEBHOOK_SECRET`.
3. Until both are set, statements still work and patients are told to call to pay.

## Open for the owner
- What "Financial assistance" should open (the screen points to messaging the office).
- Saved cards / autopay: not built. Each payment goes through Checkout.
- Reconciling copays against the insurer's payment report (ERA) is not built.

## Verified
`test/patient_billing.test.js` (7); `scripts/verify_patient_billing.js` 25/25 through
the real routes with Stripe faked; adding an email to the Stripe payload is caught by
both. Full suite 2091/0. Not proven: a live Stripe account.
