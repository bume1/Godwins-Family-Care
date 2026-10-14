# Saving a user no longer resets their password by accident (owner report, 2026-10-14)

Owner report: updating a case manager's details in User Management reset their password and emailed them a reset link.

- **Cause.** The Edit User form always showed a Password box with no autofill protection. A browser fills a saved password into any password box it finds, so an ordinary save carried a password the admin never typed, and `PUT /api/users/:userId` treated any password in the body as a reset: new hash, every session revoked, reset email sent.
- **Server (the real control).** `PUT /api/users/:userId` now resets only when the body carries `password` AND `resetPassword: true`. A password without the flag changes nothing and the response says `passwordIgnored: true`; `passwordReset` says whether a reset happened. Other callers sending a stray password (a spread user record, a script) are covered the same way.
- **Screen.** On an edit there is no password box until the admin ticks "Set a new password for this user", which starts unticked on every edit and after every save. The note under it says plainly whether saving will reset the password. Both password boxes carry `autoComplete="new-password"` and the email box `autoComplete="off"`, so the browser does not fill saved sign-ins into a person's record. The "Reset Password" button on a reset request sends `resetPassword: true`. The form no longer logs the outgoing payload to the browser console (it included the password).
- **Must not undo:** `test/user_edit_password.test.js` pins all four. Three mutations confirmed to fail it: the server back to `if (password)`, the form sending a password without the tick, and the autofill guard dropped.
- **Verified:** full suite 2345 pass, 0 fail; admin hub compiles.
- **Open for the owner:** the case manager whose password was reset needs the new password from the reset email, or an admin can set one deliberately with the new tick box. Not live until the container is rebuilt.
