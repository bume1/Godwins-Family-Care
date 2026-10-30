# Two text lines: Care Team (346) 245-5658, office main line (404) 913-6705 (owner, 2026-10-30)

Owner: "we need care team to text from 3462455658 - main line should be from admin, manager".

**What changed**
- **`quoSms.js` names two lines:**
  - `careTeamNumber()`: `QUO_CARE_TEAM_NUMBER`, else the older `QUO_FROM_NUMBER`, else `+13462455658`.
  - `officeNumber()`: `QUO_OFFICE_NUMBER`, else `ORG.phone`.
  - `sendText` now requires `from` and refuses without it (`SMS_NO_FROM_LINE`), so no text picks a line by default.
  - `fromNumber()` stays as an alias of the Care Team line.
- **Care Team texts send from 346, whoever in the thread wrote them** (an admin or manager answering in a Care Team thread included). If they went out from 404, the patient's reply would land on 404 and miss the thread.
- **Reply texts are only taken into a thread when they arrive on 346.**
- **The patient portal's "texts come from" number is 346.**
- **Office notices send from the main line.** Today that is the veteran arrival text to the provider. Nothing else in the app texts from admin or manager yet; when it is built, it uses `officeNumber()`.
- **Call logging to the chart accepts calls on either GFC line.**

**Verified**
- Unit tests repointed, plus three new ones.
- 3 mutations caught: Care Team on 404, the veteran text on 346, and replies accepted on any line.
- Probes:
  - `verify_veterans` 26/26
  - `verify_quo_sms` 16/16
  - `verify_chart_communications` 52/52, after its reply fixture moved to 346
- Full suite 2686, 0 failing.

**Owner setup (Quo side)**
- The 346 number must be on the same Quo account as `QUO_API_KEY`.
- Quo's webhook must cover the 346 line, or patient replies never reach the app.
