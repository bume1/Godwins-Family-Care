# The messaging matrix, closed out

Owner, 2026-10-15: "to quickly close out this messaging workflow", then: "include caregivers in care team messages. Allow the clinician or individual creating the care team note to choose who from the care team they'd like to share the respective updates with."

## The matrix (`messagingRepository.CHANNELS`, `MATRIX_ROWS`)

| Conversation | Who is on it | Who starts it |
|---|---|---|
| Direct | client, caregiver, **admin** | client, caregiver, admin |
| Support | client, family, admin, **plus whoever started it** | **any team member**, client, family |
| Clinical Escalation | client, assigned clinicians, **every case manager, supporting case manager and care coordinator on the care team** | client, clinician |
| Behavioral Escalation | caregiver, case manager(s) | caregiver, case manager |
| Clinical Oversight | clinician, caregiver | clinician only |
| Care Update | clinicians, **case managers / coordinators**, family, client | clinician, **case manager**, coordinator |
| Care Team | client, POA, and the care team members **the sender chooses** (clinicians, case managers, coordinators, **caregivers**) | client, clinician, case manager, coordinator, caregiver |
| Family Portal | family, caregiver, client | family, caregiver |
| Admin Broadcast | anyone | admin |
| ~~Operations~~ | retired: Support houses it | nobody |
| ~~Care Coordination~~ | retired: Care Team covers it | nobody |

Admin sees, joins and starts every type. A manager and a care coordinator message as the office (2026-10-15 account types), so they do too.

## Must not undo

- **Retired is not deleted.** Operations and Care Coordination stay in `CHANNELS` with `retired: true` and no initiators, so threads people already had stay readable and answerable. Nobody, admin included, starts a new one (`CHANNEL_RETIRED`), and they are never offered.
- **"The whole clinical team" is `caseManagerIds`**: the assigned case manager, supporting case managers and care coordinators. `participantsFor` now adds all of them wherever a channel names case managers, so they are emailed too.
- **Care Team recipients are chosen from one list**, `careTeamMembers(client, users)`: assigned clinicians, case managers and coordinators, and the primary and backup caregivers, active only, never the sender. The composer's checklist is that list (served on the channel as `recipients`) and the route checks the choice against the same list. Someone not on the care team is refused by name (`RECIPIENT_NOT_ON_CARE_TEAM`); an empty choice is refused (`RECIPIENTS_REQUIRED`); nothing is written on a refusal.
- **The patient and their POA are always on a Care Team message.** It is their conversation. The choice covers the care team only.
- **A message sent to fewer than the whole care team is marked `audience_chosen`, and then only the people on it read it**, even staff whose care-team scope would otherwise show them everything about that client (`NOT_ON_THIS_MESSAGE`). Admin still sees it. Choosing everyone is the same as the whole team and is not marked.
- A page that sends no choice (an older page) gets the whole care team, as before.

## Verified

- 10 new tests in `test/care_team_messaging.test.js` through the real messaging router, plus repointed matrix and channel-offer tests in `test/messaging.test.js` and one in `test/notifications.test.js` (Care Coordination swapped for Care Update). 10 of 10 deliberate breaks caught: the restricted-visibility check removed, caregivers dropped from Support starters, case managers narrowed to the assigned one, admin dropped from Direct, case managers dropped from Care Update starters, retired channels offered again or startable again, a stranger accepted as a recipient, the audience flag never set, caregivers dropped from the care team list.
- Full suite 2520, 0 failing. `scripts/verify_messaging.js` updated for the new matrix: 95/95 through the real routes.
- The composer driven in headless Chromium: the checklist renders the served care team ticked; unticking the case manager sends `recipientIds: ["cg-1"]` only; no page errors.

## Open for the owner

1. **Admin is on every Direct and Support thread, so every admin is emailed on every message there.** With one admin that is you. Say if Direct should only be visible to admin rather than emailing.
2. **A caregiver's Support message reaches the client and their family**, because Support's people are client, family and admin. If a caregiver needs a private line to the office about a client, that is a different conversation type.
3. **Should a Care Team sender be able to leave the patient off?** Today the patient and POA are always on it.

## Revised the same day (owner, 2026-10-15)

"Support from admin... any team member to admin and managers and then vice versa. Only admin can see every type. Managers can only see the support messages really and admin broadcasts. Admin should see direct threads without being emailed, support can receive email. Care team should be able to leave the patient off if needed." Then: "client and family / POA can also send messages to the office via support. Ensure this is the case across the board for caregivers."

- **Managers are their own messaging role (`ROLE.MANAGER`), not admin.** `isUnrestricted` is admin only. A manager sees every Support thread and every Admin Broadcast, and otherwise only threads they are on. They start Support only. A care coordinator on a patient's care team also holds the clinical team's channels for that patient (`rolesFor` adds the case-manager slot), so they still see clinical escalations and make care updates there.
- **Support is the line to the office (admins and managers).**
  - A client, family member or POA starts it: the client side and the office are on it.
  - A team member starts it: **that team member and the office only**, never the client or family. Marked `audience_chosen`, so clinicians and case managers in scope do not see it either.
  - The office starts it: they choose who from the patient, their family and the care team (`audienceFor`).
  - **No client needed for a team member** (`client_id: null`), so a caregiver with no assigned client reaches the office. Every patient-facing channel still needs a client (`NO_CLIENT`).
- **Direct:** admin is no longer a participant. Admin sees every Direct thread and can reply, but is never emailed about one, even after joining.
- **Care Team:** the patient and POA are now choices like everyone else and can be left off. A message without them is unreadable to them (`NOT_ON_THIS_MESSAGE`), and a POA is not added fresh to a chosen-audience thread.
- **Messages page for managers and coordinators** (`/messages`, hub tile, `appLinks.messagesFor`), since the Admin Hub inbox is admin-only.
- **Verified:** 9 more route tests, 9 of 9 deliberate breaks caught, the same-day tests rewritten to the revised rules; full suite 2525, 0 failing; `verify_messaging.js` 95/95; `verify_account_types.js` 59/59; the Messages page rendered in Chromium as a manager.

Open: nothing new. The earlier items about admin emails, caregiver Support and leaving the patient off Care Team are answered above.
