# Office reset link: text or email, the office picks

**Date:** 2026-11-18 · **Owner report:** Dorothy signs in by phone and has an email on file; Account Recovery offered only "Email Reset Link".

- Account Recovery showed **Text Reset Link** only when the person had a sign-in phone AND no real email. With both, only Email showed, and the server emailed.
- Now: a sign-in phone always gets **Text Reset Link**; a real email gets **Email Reset Link**; with both, both buttons show.
- `POST /api/admin/reset-user-password/:userId` takes `channel: 'sms' | 'email'`. A channel the account cannot take is refused (`RESET_CHANNEL_UNAVAILABLE`) **before** the current password is stopped. No channel keeps the old default (email when there is one).
- Self-service Forgot password is unchanged: typing the phone number texts the link.
- Tests: `test/reset_link_channel.test.js`; one assertion in `admin_account_recovery.test.js` repointed.
