# Payroll gets a Portal Hub tile (2026-11-13)

**Owner report:** "I am missing the payroll module?"

**Cause.** `accountTypes.hubAreasFor` never listed Payroll, so neither the Portal Hub nor the staff sidebar showed it. The only ways in were typing `/payroll` or the "Open Payroll" button under My GFC → Hours & Pay.

**Change.** A `payroll` link (`/payroll`) sits in the Billing area, **for the Super Admin only**. That matches its routes, which are all `requireAdmin`. Managers and coordinators still see Billing alone. The Portal Hub gives it its own tile colour.

**Guard.** `test/account_types.test.js`:
- Only the admin gets the tile.
- No other account type gets it.
- Every `/api/payroll/admin` route is still `requireAdmin`, so the tile can never be widened without the routes following.

Two mutations were each confirmed to fail the tests: dropping the tile, and showing it to every office account. Full suite: 3689 pass, 0 fail.
