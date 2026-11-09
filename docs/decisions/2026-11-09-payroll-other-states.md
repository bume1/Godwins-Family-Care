# Payroll in more than one state: Georgia first, Texas ships

**Date:** 2026-11-09
**Owner-directed:** "needs to include tx and other states"; then "Pay them in the app"; then "needs to be GA first then tx that ships".

## What was built
- **Georgia is unchanged and first.** It keeps its own G-4 formula, `gaSutaRatePct`, G-7, DOL-4N and G-1003. Every list puts federal first, then Georgia, then the other states: tax tables, settings, the run screen and the watch list.
- **Every other state shares one setup.**
  - The state gets an approved table with `incomeTax`, `method`, the method's figures and `sutaWageBaseCents`. The methods are `none`, `flat` and `brackets`.
  - GFC's own rate, account number, withholding ID and schedule for that state go in `settings.states[ST]`.
  - The person's `workState` is any state code.
  - If the state taxes wages, the person signs a generic state certificate (filing status, allowances and extra).
- **Texas ships staged:** `TX_2026 = { incomeTax: false, method: 'none', sutaWageBaseCents: 900000, newEmployerSutaRatePct: 2.7 }`. The wage base is Texas Labor Code 201.082. A new employer pays 2.7% or the industry average, whichever is higher, so GFC's real rate comes from the TWC notice and is set in Settings.

## How a non-Georgia worker is handled

**Paycheck.** `taxes.georgia` is 0 and `taxes.state` is that state's withholding. `employer.gaSuta` is 0, and `employer.stateSuta` and `sutaState` are set. Run totals keep a `byState` breakdown.

**Who gets blocked.** The run blocks a person by name until their state's table is approved. If the state taxes wages, it also blocks them until their certificate is signed. `stateRatesMissing` lists any state that has no rate set.

**G-4.** The G-4 is asked only of Georgia workers.

**Deposits.** Other-state unemployment is due quarterly on the last day of the month after the quarter. For Texas this goes to the TWC on the C-3. Other-state withholding follows the schedule set in Settings, and the run says so when that schedule is not set yet.

**Quarterly forms.** The 941 counts everyone. The DOL-4N and G-7 count Georgia workers only. `otherStates` gives each other state its own wage, taxable and excess figures, using that state's wage base.

**W-2.** Boxes 15 to 17 show the person's state. A state with no income tax, such as Texas, leaves the row blank. Georgia's G-1003 counts Georgia W-2s only.

**QuickBooks.** Two new accounts, Other State Withholding and Other State SUTA, and each journal line names the state.

**Gusto import.** A Texas line's employer Texas unemployment becomes `stateSuta`. The person's work state is recorded, so they are paid in the app once Texas is set up.

## Must not undo
- A person is never taxed as Georgian because their state is unknown or not set up. They are blocked, by name.
- Another state's wages never reach Georgia's DOL-4N, G-7 or G-1003.

## Verified
- 10 tests and 17 mutations, all caught. Two survived at first: the Texas fixture paid too little to show Georgia tax wrongly applied, and the missing-rate case had Georgia's rate set. Both were tightened.
- Full suite: 0 failing.

## Open for the owner
- Approve the Texas table.
- Enter GFC's Texas rate and TWC account number.
- Create the two QuickBooks accounts.

## Every state's official pages (added the same day)
- `payrollStateSources.js` is data only. It covers all 50 states and DC: whether the state taxes wages, its official withholding and unemployment pages, and its other payroll programs (paid leave, disability, local income tax).
- **How it was compiled.** It was built 2026-11-09 by fetching each page. `verified: false` marks the pages whose site blocked the sandbox.
- **Five non-.gov domains.** Five official agencies are not on .gov domains: FL, LA, MN, ND and WV.
- **The watch list now covers every state.** `sourcesFor` serves federal, then Georgia, then each work state's pages from this file, so Texas is watched (TWC "Your 2026 Tax Rates").
- **Texas figures confirmed on TWC's own pages:**
  - the $9,000 wage base
  - 2026 rates from 0.32% to 6.32%
  - a 2026 entry-level rate of 2.70%
- **New guard.** A state with a program withheld from pay is blocked by name until the app handles that program. Examples: WA PFML and WA Cares, CA SDI, PA local EIT. Without this, the person would be paid short. Texas and Georgia have none.
- Reference only, not shipped as tables: the agent's 2026 wage bases and new-employer rates for the other states are in its working notes. Each state's table is staged from its own source when GFC first hires there.
