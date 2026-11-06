# A route nobody calls fails the build

**Owner, 2026-11-05:** *"then we need to adddress this issue of routes with no ui"* → *"Fix all"*

## The defect class

Five times this repo has shipped a live, gated, tested route that no screen
called, so the capability silently did not exist:

| Route | Found |
|---|---|
| `PUT /api/clinical/patients/:clientId/facility` | Session 4.9 — every signature blocked, because nothing assigned a facility |
| `POST /api/users/:userId/mfa/reset` | 2026-09-27 — the break-glass for a lost phone |
| `acknowledgeAbnormalResult` | Session 4.10 — a capability with no route, then a route with no screen |
| `PUT /api/veterans/roster/:id` | 2026-11-05 (#248) — an exam could never be given a time |
| the provider picker flag | 2026-11-05 (#249) — a coordinator could open the booking form and never save it |

Each time, route tests proved the endpoint worked and page tests proved the
component rendered. **Nothing asserted the two were connected**, so every
signal in the repo read green while the feature did not exist.

## The guard

`routeCallers.js` collects every `/api/` route from `server.js` and `routes/`,
collects every API path the front end builds, and answers whether anything
calls it. `test/no_orphan_routes.test.js` fails the build on a route that is
neither called nor named in `NOT_UI_CALLED` with a written reason.

**Four shapes a path reaches a page in, all read**, because a shape it cannot
read is a false "nobody calls this", and a false alarm is how a guard gets
switched off:

1. A literal or template: `` `/api/clinical/patients/${id}/appointments` ``
2. A **conditional query string with nested backticks**:
   `` `/api/clinical/patients${q ? `?q=${enc(q)}` : ''}` `` — reading this with
   a naive `/\$\{[^}]*\}/` stops at the first `}` and mangles the rest. That
   one bug reported `/api/clinical/patients`, called four times, as an orphan.
3. **Concatenation**: `'/api/ime/cases/' + enc(id) + '/documents'` — how
   `ime.html` and `caregiver-schedule.js` build every path. Read by a
   character-level walk, not a regex, because `enc(a, b)` carries its own
   commas and quotes and a regex ends the chain on the first one.
4. A **helper-built base**: `const visit = (id,e) => \`/api/…\`` then
   `` `${visit(a,b)}/charges` ``.

Plus a **dynamic trailing segment**: `'/api/scheduling/shifts/' + id + '/' + act`
is a real caller of clock-in, clock-out, approve and the rest. Permissive on
purpose — the question is whether ANYTHING calls the route.

## Four tests, not one

- a route with no caller and no reason fails the build;
- **the allow-list cannot rot**: an entry whose route is gone, or which has
  since gained a caller, fails. Otherwise the list becomes a place to hide
  things;
- every entry carries a reason of real length, and no route appears twice;
- **the work list cannot rot either**: a screen that lands must leave
  `KNOWN_MISSING_SCREENS`.

## What it does NOT do, stated so nobody trusts it for more

It proves a path **appears** in a page, never that the control is reachable or
that the condition around it is ever true. **The care-coordinator defect of the
previous day would have passed it**: the route was called, behind a flag that
was false for that role. That class needs a browser probe, which is a separate
and more expensive piece.

## The result: 536 routes, 34 explained, 21 owed

**34 routes legitimately have no screen** and are now documented as such:
5 webhooks, 2 email-click links, 8 reachable only through a URL the server
hands the page (verified line by line), 2 retired 410 routes, 12 dormant
lab-era HubSpot routes, 4 one-off operator tools, 3 superseded login surfaces,
and 2 vestigial reads.

**The 12 HubSpot routes get no screen AND no deletion.** CLAUDE.md carries a
standing instruction: *"Do not delete — dormant lab HubSpot connector…
intentionally retained but inactive… Do not remove it in any session."* They
are listed to say that is deliberate rather than forgotten.

**21 routes are capabilities nobody can perform.** They are listed in
`KNOWN_MISSING_SCREENS` and are the work this guard was written to scope.

## Verification

- **6 tests, 9 of 9 mutations each confirmed to fail one**: a brand-new orphan
  route added, an allow-list entry losing its reason, a duplicate entry, the
  allow-list keeping a route that has since been wired, **the matcher going
  vacuously permissive**, the nested-brace bug reintroduced, concat-chain
  reading dropped, the dynamic-segment rule dropped, and helper-base expansion
  dropped.
- **The guard caught one of my own mistakes while being written**: my work list
  carried `POST /api/clinical/patients/:clientId/allergies`, which is wired
  through a generic `add(key, path, body)` dispatch helper. Confirmed by
  reading `clinical.html:915` before removing it.
- **An earlier version of the matcher was worse than useless and the fix is
  recorded**: walking characters and skipping to the end of each concat chain
  swallowed nested literals, taking the orphan count to 274 and flagging all
  three known-fixed routes. The two passes now run independently and never
  skip ahead.
- Calibration test: the matcher must see a caller for all five historically
  fixed routes plus the concat and dynamic-action shapes. If it calls any of
  them uncalled it is too strict to be trusted.
- Full suite **3066 passing, 0 failing, 1 skipped**.

## Open for the owner

- **The three superseded login routes** (`/api/auth/admin-login`,
  `client-login`, `service-login`) and `/api/config`. Every page posts to
  `/api/auth/login` only. These are delete candidates, not missing screens, and
  deleting a live auth endpoint is a decision rather than a cleanup. Allow-listed
  as pending that call.
