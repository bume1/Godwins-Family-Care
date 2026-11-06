# Account recovery gains its last two buttons

**Owner, 2026-11-06:** *"Fix all"* — the second batch of the 21 capabilities
`test/no_orphan_routes.test.js` scoped.

## The gap

Two Session 5 routes shipped with no control anywhere:

- `POST /api/admin/reset-user-password/:userId`
- `POST /api/users/:userId/sessions/revoke`

Same class, and the same card, as the MFA reset and the OpenEMR disconnect that
got their first UI on 2026-09-27.

## Why BOTH exist, which is the decision that mattered

The Edit User form already has a password field, so a reset button looks
redundant. It is not — the two do different things:

| | password field (`PUT /api/users/:id` with `resetPassword`) | the unwired route |
|---|---|---|
| sets the password | the admin types it | generated, never returned |
| how the person learns it | the admin tells them, out of band | a secure link, emailed |
| sessions | **revoked** | not touched |

The typed-password path ends with an admin reading a password down a phone,
which is how a password ends up in a text message. The emailed link is the
right action when you cannot speak to the person, and it had no button.

So the copy has to be exact about three things, and each is pinned by a test:
the admin **is not shown** the new password, the person's **current password
stops working**, and for the sessions button the password **is unchanged** —
without that last line "sign out everywhere" reads as "lock the account", and
a lost device is left holding a working password.

## Signing yourself out

`revokeAllForUser` is called with no `exceptSid`, so an admin doing this to
their own record ends the session they are clicking from. That is a legitimate
thing to want with a lost phone, and being surprised by it is not — so the card
and the dialog both say so when the target is the signed-in admin.

That needed the current user, which `UsersPage` did not receive. It is
**threaded as a prop** from the two render sites, not read out of
`localStorage`: PR #113 was an inline `localStorage` read that missed, and an
inline read that misses is indistinguishable from one that hits until somebody
is surprised. A test asserts both render sites pass it, because a prop missing
from one site makes the warning silently never fire.

A zero count reads as "they had no active sessions", never as a failure —
`revokeAllForUser` returns a number and 0 is a real answer.

## Three existing guards were REPOINTED, not deleted

Threading the prop changed the `UsersPage` signature and both render-site
strings, which three guards pinned literally. Every rule they protect still
holds, so each now pins the rule rather than the exact tag, and all three were
**mutation-checked to confirm they still catch what they were written for**:
View as staying the Super Admin's, office-only users never getting
`isSuperAdmin={true}`, and `financialPending` staying declared inside
`UsersPage` (the PR #225 crash).

**One of them was slicing garbage.** `phc_access.test.js` anchored on
`'const UsersPage = ({ token, isSuperAdmin }) => {'`; once the signature grew,
that `indexOf` returned −1 and every assertion after it ran against a nonsense
slice. It failed loudly here by luck. It now anchors on the declaration alone
and **asserts the anchor was found and the slice is a plausible size**.

## A pre-existing gap found by mutating, and closed

There are **two** View as controls — one on the user row, one on the Edit
form — and `impersonation.test.js` only ever covered the row. Dropping the
Edit-form card's `isSuperAdmin && editingUser.role !== 'admin'` gate failed
nothing, which would have let an admin impersonate another admin from that
card. Found because a mutation of mine "survived" and turned out to have hit
the control the guard does not cover. One assertion added, mutation-checked.

## Verification

- **9 tests, 12 of 12 mutations each confirmed to fail one**: each button
  detached from its handler, the copy implying the admin learns the password,
  "password is unchanged" dropped, the self-signout warning removed from the
  card and from the dialog, a render site dropping the prop, the current user
  read from `localStorage`, a zero count reported as plain success, the server
  refusal swallowed, the confirmation dropped, and the busy flag dropped.
- **Two of my own mutations survived the first pass and the TEST was fixed**,
  not the catch claimed: a 1400-character window from one handler reached into
  the next and matched **its** error handling. Each handler is now bounded at
  the following declaration, with both ends anchored and a check that the slice
  did not swallow its neighbour — the bounded-scan trap, in a test of mine.
- Tests assert the server still behaves as the copy claims: the route creates a
  link, emails it, returns no password, and revokes nothing; the revoke route
  touches no password.
- Full suite **3069 passing, 0 failing, 1 skipped**. The page's 350k JSX block
  compiles.

## Not proven from this sandbox

That the reset email is delivered. `sendPasswordResetEmail` goes through the
live transport, which no sandbox can observe — `scripts/verify_email_transport.js`
on the deployment is what proves that half, and it has still never been run.
