# A care coordinator can book appointments

**Owner report, 2026-11-05:** *"can my care coordinator schedule appointment for patients and their providers? how?"*

The answer was no, and the reason was a second copy of a rule.

## What was wrong

`resolveProviderScope` (`server.js`) has given a care coordinator the whole
practice's calendar since the role was added on 2026-10-14. The screen never
found out.

The booking form drew its provider dropdown from a flag the providers route
served as **`isAdmin`**, and that flag was a hand-written list of roles:

```js
isAdmin: req.user.role === config.ROLES.ADMIN || req.user.role === config.ROLES.CASE_MANAGER
```

So when the coordinator was added to the enforcer, nobody thought to touch
something called `isAdmin`. The result for a Care Coordinator:

- **Add Visit** / **New Appointment** rendered (they hold `canDocument`),
- the Provider field was a disabled box reading `Provider —`,
- `myProviderId` is null for them, so nothing filled it in,
- saving answered **400 `APPT_NO_PROVIDER`**.

They could open the booking form and never save it. The calendar's provider
filter was behind the same flag, so they also saw one provider's day instead of
the practice's.

**Nothing had ever tested `resolveProviderScope`** — not one assertion in the
repo. That is how the two halves drifted apart without a failing build.

## The fix

The flag is now **asked of the enforcer** rather than restated:

```js
canPickProvider: resolveProviderScope(req.user, null).all === true
```

`.all` is true exactly when the route will accept any provider id, so the
screen cannot disagree with it again. A clinician mapped to their own OpenEMR
provider reads `locked`; one mapped to none reads an error. Both come back
false, which is the safe direction.

`isAdmin` is **removed, not kept alongside** — two names for one idea is how
this happened. A browser holding the old page reads `undefined`, which is
falsy, so it degrades to a missing picker until refresh rather than to a wrong
booking.

The page renames its local to `allCalendars` and both controls read the served
flag. The booking form's `canPickProvider` reads it too.

## What did NOT change

- **A coordinator still cannot sign.** `canWrite` stays false; `scheduling` is
  a capability, not a licence. Verified, not assumed.
- **A clinician is still locked to their own calendar** and still refused
  another's with `PROVIDER_SCOPE`.
- **Read-only staff still book nothing.**
- **The enrollment-gate override stays admin-only.** A coordinator booking
  against a client whose consents are not on file is refused, as it should be.
- `canWrite` inside `ScheduleView` is a local alias for `useCanDocument()`, so
  the New Appointment button already worked for a coordinator. Misleading name,
  correct behaviour; left alone rather than renamed in a fix branch.

## Verification

- **5 tests** in `test/coordinator_scheduling.test.js`, the first coverage
  `resolveProviderScope` has ever had. It is **lifted out of `server.js` and
  run**, not read.
- **14 of 15 mutations each confirmed to fail one**: the coordinator dropped
  from the enforcer (the shipped bug), the served flag restated as a role list,
  `isAdmin` reintroduced, a locked clinician given the unified view, an unmapped
  clinician falling through to everybody's calendar, another provider's calendar
  no longer refused, the page back to the old flag (twice), the page deciding it
  from the role itself, each render site detached from the flag, an empty
  `providerId` accepted at the boundary, the coordinator losing `scheduling`,
  the coordinator losing the documenter gate, and `scheduling` handed to
  read-only staff.
- **One mutation is a behavioural no-op and is recorded as one, not claimed as
  a catch**: relaxing `=== true` to a truthy read changes nothing, because
  `all` is only ever true or absent, JSON drops an absent key, and the page
  coerces with `!!`. A code comment now says which line is load-bearing.
- **A guard of mine proved nothing on its first run and was fixed**: the JSX
  compile check extracted the *first* `type="text/babel"` block, which is the
  empty `src=` tag on line 139, and compiled 0 characters happily. It now takes
  the largest block and asserts it is over 100,000 characters first.
- Full suite **3061 passing, 0 failing, 1 skipped**. `verify_clinical_roles.js`
  **57/57** over real HTTP. The app boots (the forward reference inside the
  handler is safe, confirmed by booting rather than by reasoning). The page's
  658k-character JSX block compiles.
- **Proven over real HTTP for a Care Coordinator account**: signs in, served
  `canDocument:true`, `canWrite:false`, and `scheduling`.

## Not proven from this sandbox

The `/api/clinical/providers` payload itself. The route needs OpenEMR and
answers `503 EMR_NOT_CONFIGURED` here, so the served flag is covered by the
lifted-function test rather than by a live response. A real booking end to end
needs the deployed instance.
