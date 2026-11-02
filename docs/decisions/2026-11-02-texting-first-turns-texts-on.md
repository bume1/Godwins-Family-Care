# A patient who texts the Care Team line gets replies by text (owner, 2026-11-02)

**Report:** patient texts showed up in the app, but replies sent from the app never reached their text thread on the Care Coordination line (346).

**Found in Quo:** a patient texted 346 three times between Oct 30 and Nov 2, and the app had sent nothing from 346. The veteran texts from 404 went out fine, so the Quo key and sending both worked.

**Cause:** Care Team replies are texted only to someone with `smsOptIn.enabled`, which before this change only the portal's text switch could set. A patient who simply texts us never did that, so every reply stayed portal and email only.

**Change**
- New `quoSms.optInFromIncomingText()`. A matched incoming text on the Care Team line turns texts on for that person, with `changedBy: 'texted the care team'`.
- Someone who ever turned texts off, by STOP or in the portal, is never turned back on this way.
- The first reply still carries "Reply STOP to stop texts."

**Main line (404)**
- Unchanged. Patient texts to 404 stay in Quo's main-line inbox and don't enter Care Team threads, matching "main line is for admin and manager".

**Verified**
- 2 new unit tests.
- `verify_quo_sms` 21/21. A patient who never opted in texts in, the clinician replies, and the reply is texted to their number from the Care Team line.
- Mutations caught: the opt-in step removed, and STOP ignored.
- Full suite 2690, 0 failing.
