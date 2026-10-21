# Quo webhook: several signing keys, and a clearer refusal

**Date:** 2026-10-21 · Found while the owner tested the `call.completed` webhook.

- **What happened:** the test answered `503 SMS_NOT_CONFIGURED` ("Texting is not set up."). The request reached the app, but `QUO_WEBHOOK_SECRET` was not in the running container's environment. The fix is setup, not code: save the secret, then restart the container.
- **Several keys:** Quo gives each webhook its own signing key, and calls, messages, summaries and transcripts can be separate webhooks. `QUO_WEBHOOK_SECRET` now takes **several keys separated by commas**, and a request is accepted when it checks against any one of them (`quoSms.webhookSecrets`, `verifyAnySignature`).
- **Clearer refusals:** the 503 now names the missing setting. A bad signature returns `QUO_BAD_SIGNATURE` and says the key does not match.
- **Verified:** a new test in `test/quo_sms.test.js` (both keys verify, a wrong key does not, and an empty setting reads as off). `verify_quo_sms` 16/16, `verify_chart_communications` 52/52, full suite 0 failing.
