# Two admin hub pages crashed on names that did not exist where they were used

Owner report, 2026-11-04, with screenshots: the Dashboard and User Management both showed "This page could not be shown".

- **Dashboard:** the AI setup panel called `gfcTime.fmtDateTime`. The time module is `window.GFC_TIME`. It only crashed once the daily Google checks had a timestamp, which is why it appeared as soon as the Google setup went live. The chart's "Earlier reviews" list had the same bug and would have crashed the first time a clinician had a past AI review. Both are fixed.
- **User Management:** the pending pay-change list (`financialPending`) was declared in `InboxPage` and read by `UsersPage`. The state and its loader now live in `UsersPage`.
- **Guard:** `test/admin_hub_undefined_names.test.js` fails if any page uses `gfcTime.` or if the pay-change state leaves `UsersPage`. Mutation-checked.
- **Swept:** every page's script was checked for undefined names with ESLint `no-undef`. The only other hit is `ServiceReportDetail` in the dormant lab-era branch of `portal.html`, which GFC clients do not reach. It was left alone.
- **Verified:** full suite 2,909 passing and 0 failing. Both pages compile. **Live only after the container is rebuilt on the server.**
