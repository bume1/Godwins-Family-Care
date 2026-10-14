# A social worker set up as a clinician account can be a client's case manager (owner report, 2026-10-14)

"Courtney can't see Juanita's name" in messaging.

- **Cause:** messaging scope reads the account type. A Case Manager account reaches the clients where it is the Assigned Case Manager. A clinician account (role `user`, here with an LMSW/LCSW clinical role) reached only the clients that list it under Assigned FNPs, and the Assigned Case Manager picker on the client's record offered Case Manager accounts only. So a social worker set up as a clinician account could never be made a client's case manager, and never saw the client.
- **Fix:** a clinician account that is the client's assigned (or supporting) case manager now has that client in scope for the client picker, the thread list and single-thread reads (`clientInScope`, `threadVisibility`). The picker also lists LMSW/LCSW clinician accounts, marked with their role.
- **Unchanged:** a clinician who holds neither slot still reaches nobody, and a Case Manager account behaves exactly as before.
- **Verified:** `test/case_manager_scope.test.js` (3 tests; 2 fail without the fix). Full suite 2404, 0 failing. admin-hub compiles.
- **If it still fails after deploy, it's data, not code:** open Juanita's record and check that Assigned Case Manager is set to Courtney. If her account is a clinician account, check that it carries the LMSW or LCSW clinical role.
