# Enrollment moved into People

Owner, 2026-11-09: move the enrollment area into the People module.

## What changed

- **Enrollment is no longer a top-level Portal Hub tile.** It is a child of **People**, alongside User Management and Staff Onboarding, in `accountTypes.js`'s `peopleTile()`.
- **Visibility is unchanged.** Enrollment used to be a standalone tile shown to admin, manager and coordinator. Those are exactly the three account types that reach `peopleTile()`, so moving it there changes nothing about who can open it — only where it sits.
- **The page and its route are untouched.** `/admin/enrollment` (`public/admin-enrollment.html`) and every `/api/gfc/admin/enrollment/*` route are exactly as they were; this is a navigation change only.
- **`public/login.html`'s `fallbackTiles()`** — the client-side fallback used when a login response carries no `hubTiles` array (a user record saved before tiles existed) — was carrying its own copy of the same tile shape. Repointed the same way, so a fallback hub does not disagree with a server-sent one.
- **Billing stays its own top-level tile.** It is a money module, not a people one; the owner's 2026-10-15 reasoning for splitting it out of Clinical still applies, and nothing here touches it.

## Why Enrollment, specifically

Enrollment is how a client becomes a person this system tracks — the same job User Management does for every other account type and Staff Onboarding does for a new hire. It belongs beside them rather than beside Billing, which is a different kind of module (money, not people).

## What a later session must not undo

- **Enrollment's visibility rule is "whoever reaches `peopleTile()`."** Don't gate it independently inside `peopleTile()` the way Staff Onboarding is gated (`u.role === 'admin' || u.isManager === true`) — that condition exists for Staff Onboarding specifically; Enrollment should stay unconditional for the three types that already see People at all.
- **`login.html`'s fallback must keep matching `accountTypes.hubTilesFor`.** It is a second, deliberate copy (owner, 2026-10-15 era) for records with no stored `hubTiles`, not a place to invent a different shape.

## Verified

- `test/account_types.test.js`: updated the three tests that asserted Enrollment as a top-level tile id, to assert it is now `people.children` instead, and that it is absent from the top level. Added an explicit assertion that `tile('enrollment')` is `undefined` at the top level.
- Full suite: 3356 passing, 0 failing (1 skipped, pre-existing — the skip predates this change).
- Server booted (`DATA_STORE=memory`), `/login` and `/admin/enrollment` both answered 200.
- Verified by direct call: `hubTilesFor(fieldsFor('admin'|'manager'|'coordinator'))` no longer carries an `enrollment` id at the top level; `people.children` carries `['users', 'enrollment', 'onboarding']` (onboarding dropped for non-admin/non-manager viewers of People, as before — though in practice every type that reaches People today satisfies that condition).

## Not proven here

- Not rendered in a browser this pass — this is a data-shape change consumed by `login.html`'s existing render loop (`shown.map(...)`), which was already exercised for the People tile's other two children.
