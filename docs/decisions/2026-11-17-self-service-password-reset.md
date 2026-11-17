# Self-service password reset (2026-11-17)

Owner report: when a password reset request comes in and an admin handles it, the person never receives a password, and it may not work at all. Owner ask: make it automatic, so the admin does not do the reset by hand.

## What was wrong

- **"Forgot password" filed a request in the admin Inbox, and the Inbox's "Reset Password" button did nothing useful.** It marked the request completed. It did not change the password and did not email the person, so they heard nothing back. The only working route was a separate one from the user form.
- **The older admin reset paths store a temporary password in plain text** for 24 hours (`password_reset_links`), so a link can show it. The typed-password and bulk paths still do this; see open items.

## What was decided (must not undo)

- **"Forgot password" now emails the person a one-time link to choose their own password.** No admin step and no temporary password. `passwordSetLinks.js` holds the rules; the link's page is `/password-reset-<token>`.
- **Only a SHA-256 fingerprint of the link is stored** (`password_set_links`, registered). A copy of the database holds no working link.
- **The link works once and expires in 1 hour** (24 hours when an admin sends it). A newer link replaces older unused ones, and each refusal is named: expired, used, replaced or invalid.
- **At most 3 self-service links per person per hour.** Over the limit, the reply is the same and nothing is sent.
- **The reply is always the same sentence**, whether or not the email has an account, so the form can't be used to find out who does.
- **Asking for a link changes nothing.** Only using it sets the password. So a stranger who types someone's email cannot lock them out.
- **Using the link** sets the password to the app's usual rules (8 or more characters, with an uppercase letter, a lowercase letter and a number). It also:
  - signs the person out everywhere;
  - closes any request still waiting in the Inbox for them;
  - removes any older temporary-password link;
  - sends the usual "your password was changed" email.
  - **MFA is untouched**: they still need their authenticator code to sign in.
- **An account that cannot receive a link still reaches the office.** That means a switched-off account, or a placeholder login with no inbox. It gets the same generic reply, and the office gets the existing "password reset requested" notice and an Inbox item.
- **The Inbox button is now "Email Reset Link".** It emails that person a link and says so, or says why it can't (account switched off, no inbox).
- **The user form's "Email Reset Link" button sends the same kind of link** instead of a temporary password.
  - As its card already says, the person's current password stops working straight away.
  - It still does not sign them out; that stays the separate "Sign Out Everywhere" button (2026-11-06).

## Verified

- `scripts/verify_password_reset.js`: 28/28 through the real routes, with email captured and links read back out of the messages.
- `test/password_set_links.test.js` added; two older tests repointed: the on-screen promise ("we have sent a link") and the admin reset route.
- 6 mutations caught: no link sent, link stored in plain text, link reusable, no hourly limit, Inbox button sending nothing, weak password accepted.
- Full suite: 3,944 tests, 0 failing. The three edited pages compile.
- Not rendered in a browser; real email delivery not proven from the sandbox.

## Open for the owner

- **Typing a password on the user form still creates a temporary password** and emails a link that shows it; it is held in plain text for 24 hours. **Bulk reset** does the same. Both could move to "choose your own" links too. That is a separate decision, because it changes what admins do today.
