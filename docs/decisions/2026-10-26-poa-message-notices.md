# A POA is told about, and can open, every message the patient is on

Owner, 2026-10-26: "double check POAs are receiving portal message notifications, as they should."

- **What was checked:** the real server, every conversation type a patient can be on, for one patient with no login of their own and one with their own, with the same POA on both.
- **Found:** a POA was emailed only on Care Team, Care Update and admin messages. On **Clinical Escalation, Direct (patient and caregiver) and Support** the POA was not told. For a patient with no login (placeholder email) nobody on the patient side was told at all. And when the office picked specific recipients and picked the patient, the POA could not open it.
- **Rule now:** wherever the patient is on a conversation, their designated POAs are too, read fresh. `notifyThread` adds the POAs whenever the patient is a recipient; `threadVisibility` lets a POA read a chosen-audience thread when the patient is on it. A message the office sent to staff only stays theirs; plain family are unchanged.
- **Owner decision:** this includes **Support**, which was made one-to-one on 2026-10-15. A POA now sees the patient's Support threads; other family still do not. The 10-15 test was updated to say so.
- Verified: new `scripts/verify_poa_message_notices.js` 10/10 (each POA email carries that patient's link, the POA can open it, nothing goes to a placeholder); removing the fix fails 6 of them. `test/family_links.test.js`, messaging and care-team suites, `verify_messaging` 95/95, full suite green.
