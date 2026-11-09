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

1. Go to script.google.com, signed in as the admin account, and create a new project named **GFC Payroll**.
2. Replace the starter code with `scripts/payroll_automations.gs`.
3. **Project Settings:** set the time zone to **America/New_York**, then add two script properties:
   - `GFC_APP_URL` = `https://app.godwinsfamilycarellc.com`
   - `GFC_PAYROLL_KEY` = the same value as `PAYROLL_INGEST_KEY` in the app's environment
4. In the editor, pick **installPayrollTriggers** and press Run. Approve the permissions Google asks for. Running it again is safe, and it removes the old rev 1 reminder trigger.
5. On the **Triggers** page (clock icon), set each trigger's failure notification to **Notify me immediately**, so a broken job is never silent.

**`scripts/payroll_paystubs.gs` is optional.** Pay stubs from an in-app run are made by the app and need no script. That file is only for stubs from a payroll run done somewhere else (for example, a period you ran before switching). If you need it, add it as a second file in the same project; it uses the same two properties.

What it does on its own:

| Job | When | What happens |
| --- | --- | --- |
| Period close | Daily 7 AM | The day after a pay period ends, the app drafts the run and emails you a review link. |
| Missing time | Daily 6 PM | Anyone clocked in for over 12 hours gets a reminder. |
| Payment reminder | Daily 8 AM | Approved runs past their send-by date remind you to send PNC payments. |
| Tax reminders | Daily 9 AM | Deposits and filings due within your lead time. |
| QuickBooks sync | Nightly 2 AM | Retries anything that failed to post. |
| W-2 / 1099 build | Jan 2 | The year's W-2s and 1099s are built and you are emailed what is ready and what is missing. Nothing is released. |
| W-2 / 1099 reminders | Jan 20 | Anyone who has not opened an electronic form gets one reminder; you hear about paper copies not yet mailed, or forms not released. |
| Tax source watch | Weekly (daily in Dec and Jan) | When an IRS or Georgia source changes, you get an email to review and stage new rates. |

**None of these approves, pays or switches on anything.** Those stay your clicks in the app.

## 6. QuickBooks Online (private home care and payroll only)

1. At developer.intuit.com create an app with the **Accounting** scope. Add the redirect URI from step 1. Copy the keys into the server settings.
2. In QuickBooks, create these accounts first. The app names any that are missing.
   - PNC Business Checking (Bank)
   - Payroll Clearing
   - Payroll Liabilities: Federal Withholding, FICA, GA Withholding, FUTA, GA SUTA, Other State Withholding and Other State SUTA (each an Other Current Liability). The last two carry Texas and any later state; each journal line names the state.
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

## 9. Year end: W-2s and 1099s (Payroll → Year End)

**Once, before January:** fill in **Employer Details for Tax Forms** on the Year End tab. You need the Georgia withholding number (it prints in box 15) and, for the SSA, your Business Services Online user ID and a contact.

**Each person:** My GFC → Hours & Pay → Pay Setup now has **Legal name and mailing address**, exactly as on their Social Security card. Release refuses anyone missing it and names them.

**In January:**
1. Finish every run with a pay date in the year (paid, not just approved).
2. Press **Release Forms**. The figures freeze. Each person sees theirs in My GFC. Anyone who agreed to electronic forms is emailed a link (never the form). Everyone else is listed for paper.
3. Print each paper form with **Print**, mail it, then press **Mark Mailed**.
4. Download the **Filing Sheet** and key the W-2s into **SSA W-2 Online** (Business Services Online) and the 1099-NECs into the **IRS IRIS Taxpayer Portal**. File Georgia's **G-1003** on the Georgia Tax Center with the totals shown.
5. Delete the filing sheet from your computer once filed. It carries full SSNs.

**Why there is no upload file for 2026 yet:** SSA and the IRS both changed their 2026 layouts (overtime goes in W-2 box 12, code TT, and the 1099-NEC gained boxes 1b to 1d). Those layouts could not be confirmed when this was built, so the app will not guess at them. The upload buttons switch on once a year's layout is added. For a handful of forms, keying them in is quick.

**Deadline:** W-2s and 1099-NECs go to people by January 31 and are filed with SSA, the IRS and Georgia by the same date (the next business day when it falls on a weekend; February 1, 2027 for tax year 2026).

**Box 12 TT** is the overtime premium (the "half" of time-and-a-half) the app already pays. Employees may deduct it on their own return. Georgia asks for it on 2026 W-2s too.

**1099-NEC** goes to each contractor paid **$2,000 or more** in the year (up from $600, for payments after 2025).

## 10. Bringing past pay over from Gusto (Payroll → Runs → Import Past Pay From Gusto)

1. In Gusto: **Reports → Payroll Journal**, this year, export CSV.
2. In the app, choose the file and press **Preview**. It shows each matched person, their pay dates and total, anyone it could not match, and anyone who works outside Georgia.
3. Press **Import**. Each matched person gets their past pay stubs in My GFC (no emails go out). Their year-to-date counts toward this year's Social Security, FUTA and Georgia unemployment limits. Hours already in the app for those pay periods are locked, so an app run never pays them again.

Good to know:
- People are matched to accounts by name. Someone with no account, or two accounts with the same name, is listed and skipped. Fix the account, then import again. Re-importing the same file replaces the same pay dates; it never doubles them.
- Gusto's corrections (a reversal plus a new line) are netted; a pay date that nets to nothing is dropped.
- Gusto made the tax deposits for its pay dates, so they never appear as deposits the app says you owe.
- The file itself is not kept anywhere.
- **Anyone who works outside Georgia** (for example, a Texas address) is blocked from app runs. The app withholds Georgia tax only, so keep paying them outside the app until their state is added.

## 11. Other states (Georgia first, then Texas)

Georgia is the main state and works exactly as before. Texas ships as the second state. Any other state is added the same way when you hire there.

**To pay someone who works in Texas:**
1. **Payroll → Tax Tables:** approve the staged **Texas 2026** table. Texas has no state income tax; the table carries Texas unemployment on the first $9,000 of each person's wages.
2. **Payroll → Settings → Other states:** enter GFC's Texas unemployment rate from the TWC notice, and the TWC account number.
3. **Payroll → People:** set them to **Works in: Texas**. (The Gusto import sets this for you from their Gusto work address.)

They are then paid in the app with no Georgia tax and no G-4. Their Texas unemployment shows on the Taxes calendar, due to the Texas Workforce Commission the last day of the month after each quarter. Their W-2 has no state wages in boxes 15 to 17, and they are left off Georgia's DOL-4N and G-1003. Mark the Texas new hire report from their People row.

**Another state later:** stage that state's table under Tax Tables (choose the state, paste its figures, approve), set GFC's rate and account under Settings → Other states, and set the person's work state. If the state taxes wages, the person signs that state's withholding certificate in My GFC → Pay Setup before they can be paid. Until all of that is done, the run names what is missing and does not pay them.

**QuickBooks:** create **Payroll Liabilities: Other State Withholding** and **Payroll Liabilities: Other State SUTA**. Each journal line names the state.
