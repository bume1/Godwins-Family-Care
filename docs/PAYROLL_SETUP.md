# Payroll, billing and QuickBooks: setup guide

For the owner. Do these steps in order. Nothing goes live until the container on the EC2 box is rebuilt with this code.

## 1. Server settings (AWS Secrets Manager → the app's environment)

| Setting | What it is | Without it |
| --- | --- | --- |
| `PAYROLL_ENCRYPTION_KEY` | 64 hex characters (32 random bytes). It locks SSNs, tax IDs, bank numbers and QuickBooks tokens. Generate one with `openssl rand -hex 32`. Keep a copy somewhere safe: lose it and every stored bank number has to be entered again. | Nobody can save an SSN or bank account. The forms still save. |
| `PAYROLL_INGEST_KEY` | Already used by the pay stub script in My GFC. The automations below use the same key. | Automations and pay stub imports answer 503. |
| `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET` | From your Intuit Developer app (step 5). | QuickBooks cannot connect. |
| `QBO_REDIRECT_URI` | `https://app.godwinsfamilycarellc.com/oauth/quickbooks/callback`. It must match the Intuit app exactly. | |
| `QBO_ENVIRONMENT` | `sandbox` to test first, then `production`. | Defaults to sandbox. |

## 2. In the app: Payroll → Settings

- **Pay frequency.** Weekly runs Monday to Sunday; every two weeks runs Monday through the second Sunday. A change starts with the next period that has not begun, and the withholding follows it automatically.
- **Georgia unemployment rate**, from your GA DOL notice. A new employer is 2.70% (2.64% plus the 0.06% administrative assessment). **No run can be approved until this is set.**
- **Federal deposit schedule** (monthly for most new employers) and **Georgia withholding filing frequency**, from your IRS and Georgia DOR notices.
- **GFC's federal EIN.** It prints on pay stubs.

## 3. In the app: Payroll → Tax Tables

The 2026 federal and Georgia tables ship **staged**. Payroll uses only approved tables.

- Open each table, check it against its source, then press **Approve**.
  - **Federal:** IRS Pub 15-T 2026 and Pub 15. The Social Security wage base is $184,500.
  - **Georgia:** the 2026 Employer's Withholding Tax Guide (revised September 2026). The flat rate is 4.99% from May 11, 2026.
- **One figure to confirm:** the 1099-NEC reporting threshold is entered as **$2,000**, the new law's figure for payments after 2025. Check it before year-end.
- **Georgia's rate changed mid-year.** Any 2026 paychecks run outside the app before May 11 were at 5.19%. The app uses 4.99% for everything it runs.

## 4. Each person: My GFC → Hours & Pay → Pay Setup

Each person completes their own:
- W-4
- G-4
- I-9 Section 1
- SSN
- how they are paid
- the offer letter and handbook acknowledgements
- consent to electronic W-2s

Contractors also complete a W-9.

**You then:**
- set each person's pay type and rate under Payroll → People;
- complete **I-9 Section 2** when you see their documents;
- mark the **Georgia new hire report** filed.

A run refuses anyone missing a W-4, G-4, SSN, I-9 or pay method, and names what is missing.

## 5. Google Apps Script (the automations)

**This is the piece that keeps payroll current without anyone remembering.**

1. Open the Apps Script project that already has `payroll_paystubs.gs`.
2. Add a new file and paste in `scripts/payroll_automations.gs`.
3. **Project Settings:** set the time zone to **America/New_York**. The script properties `GFC_APP_URL` and `GFC_PAYROLL_KEY` are already there from the pay stub script.
4. In the editor, pick **installPayrollTriggers** and press Run. Approve the permissions Google asks for. Running it again is safe.

What it does on its own:

| Job | When | What happens |
| --- | --- | --- |
| Period close | Daily 7 AM | The day after a pay period ends, the app drafts the run and emails you a review link. |
| Missing time | Daily 6 PM | Anyone clocked in for over 12 hours gets a reminder. |
| Payment reminder | Daily 8 AM | Approved runs past their send-by date remind you to send PNC payments. |
| Tax reminders | Daily 9 AM | Deposits and filings due within your lead time. |
| QuickBooks sync | Nightly 2 AM | Retries anything that failed to post. |
| Tax source watch | Weekly (daily in Dec and Jan) | When an IRS or Georgia source changes, you get an email to review and stage new rates. |

**None of these approves, pays or switches on anything.** Those stay your clicks in the app.

## 6. QuickBooks Online (private home care and payroll only)

1. At developer.intuit.com create an app with the **Accounting** scope. Add the redirect URI from step 1. Copy the keys into the server settings.
2. In QuickBooks, create these accounts first. The app names any that are missing.
   - PNC Business Checking (Bank)
   - Payroll Clearing
   - Payroll Liabilities: Federal Withholding, FICA, GA Withholding, FUTA and GA SUTA (each an Other Current Liability)
   - Wages: Home Care, and Wages: Clinical (Expense)
   - Payroll Tax Expense, and Contract Labor (Expense)
   - Income: Private Home Care (Income)
3. Payroll → QuickBooks → **Connect QuickBooks.** Test in sandbox first, then switch `QBO_ENVIRONMENT` to `production` and connect again.

**What posts to QuickBooks:**
- payroll journals
- each net pay
- tax deposits
- contractor payments, with 1099 tracking on
- private home care invoices and their payments

Home care customers carry the client's name and account number. A carrier invoice is posted to the carrier. **No clinical client, claim or copay is ever sent.**

## 7. Paying (PNC)

After you approve a run, open its **Payment Sheet**:
1. Send each payment in the PNC app. The routing and account numbers show when you press "show", and each reveal is logged.
2. Paste the PNC confirmation number next to each person.

The run is paid only when everyone has one.

## 8. Before retiring Gusto

Run one pay period both ways, in Gusto and in the app, and compare every stub line. Retire Gusto only when they match.
