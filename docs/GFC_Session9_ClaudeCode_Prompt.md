# Session 9 — Claude Code Prompt
## Messaging module — full channel matrix with role-based visibility

**Prerequisite:** Sessions 3.x and 4.x merged. Independent of Sessions 6 and 7 — **all three run in parallel.**
**Model:** Opus.
**Spec:** `docs/GFC_App_Build_v2.md` §1I channel matrix and visibility rules (carried from the v2 prompt) · §5.4 data model.
**Important:** TEST DATA ONLY.

---

## PARALLEL BUILD PROTOCOL — read before writing any code

Sessions 6, 7 and 9 run at the same time. Conflicts are avoided by **file ownership**.

**You own, exclusively:** `messagingRepository.js` (new), `routes/messaging.js` (new), `public/components/gfc-messaging.js` (new — the shared thread component), the messaging sections of `public/portal.html`, `public/clinical.html` and `public/admin-hub.html`, `test/messaging.test.js` (new).

**You must NOT create or edit:** `public/caregiver.html` (Session 6 owns it) or anything scheduling (Session 7).

**Shared files — one line each:** `server.js` (single `require` + `app.use`) and `config.js` (append enums only, do not reorder).

**Your caregiver-facing deliverable is the component, not an edit.** Session 6 renders `<div id="gfc-mount-messaging">` as a disabled placeholder. `gfc-messaging.js` must mount into any container given `(elementId, { userId, role, scopeClientId, authToken })`. Mount it in the portals you own; **do not mount it in the caregiver app.** A follow-up session does that.

**Session 3.5 built a minimal client→admin send** into a `gfc_messages` store. You are replacing it. Migrate existing rows rather than dropping them, and remove the interim path in a SEPARATE commit after the new one is proven.

---

## Paste this into Claude Code

```
You are continuing the GFC Care Platform build. Read CLAUDE.md first and honor
its prerequisite gate. Sessions 6 and 7 are running IN PARALLEL — read the
PARALLEL BUILD PROTOCOL in docs/GFC_Session9_ClaudeCode_Prompt.md and obey the
file-ownership rules exactly. TEST DATA ONLY.

Branch: session/09-messaging (or harness-assigned)

Read first, in full:
- docs/GFC_Session9_ClaudeCode_Prompt.md — the parallel build protocol
- docs/GFC_App_Build_v2.md — the §1I channel matrix and visibility rules, §5.4
- docs/GFC_Client_Care_Profile_Schema_v1.md §6 — consents, careTeam,
  familyIsPoa
- The Session 3.5 gfc_messages store and its client→admin send — you replace it
- The Session 4.3 sharing filter map — reuse its pattern; do not fork a second
  visibility mechanism

ARCHITECTURE
This is STRUCTURED messaging, not a general chat. Every message carries sender
role, recipient role, a channel label, a thread, and a timestamp. Visibility is
enforced at the QUERY layer — a user must not be able to request a thread they
are not a party to and receive an empty list; they receive 403. Filtering in the
UI is not enforcement.

SCOPE

A. Channel matrix — build exactly these, no more
| From | To | Channel label |
|---|---|---|
| Client | Caregiver | Direct |
| Client | Admin | Support |
| Client | FNP/Clinical | Clinical Escalation |
| Caregiver | Assigned client | Direct |
| Caregiver | Admin | Operations |
| Caregiver | Case Manager | Behavioral Escalation |
| Clinical | Caregiver | Clinical Oversight |
| Clinical | Family | Care Update |
| Admin | Anyone | Admin Broadcast or Direct |
| Family | Caregiver | Family Portal |
| Family | Admin | Support |

Client↔caregiver messaging is available ONLY while a caregiver is actively
assigned. If no caregiver is assigned, the channel is disabled with a clear
explanation, not hidden.

B. Visibility rules — enforce server-side
- Caregivers: only their own threads with their assigned client. Never
  clinician-to-family or clinician-to-client threads.
- Family: only their own threads with caregiver and admin. Never clinical
  threads unless a clinician explicitly pushes a Care Update.
- POA family (familyIsPoa): client-equivalent messaging on behalf of the
  client. Every POA message records "<POA name> as POA for <client name>" as
  the displayed sender, per the 4.3 pattern.
- Case Manager: all Behavioral Escalation threads. Never clinician notes,
  never the family portal.
- Clinical: all threads for their assigned clients; may push a Care Update to
  family.
- Admin: full visibility.

C. Escalation-flagged messages
- "Behavioral Escalation" to the case manager creates an escalation event in
  the SAME store Session 6 writes to. Coordinate on the record shape: read
  Session 6's branch if it has merged; otherwise define the shape here, state
  it plainly in your PR, and flag that Session 6 may need to align.
- "Clinical Escalation" from a client to a clinician is flagged and tracked
  with a response status.
- Both ride the existing notification queue. Do not build a second one.

D. The shared thread component (public/components/gfc-messaging.js)
Self-contained, mounts into any container with (elementId, { userId, role,
scopeClientId, authToken }). Thread list, thread view, compose, channel label,
disabled state with reason. Mount it in portal.html, clinical.html and
admin-hub.html. DO NOT mount it in caregiver.html.

E. Retire the 3.5 interim — separate commit
Migrate existing gfc_messages rows into the new structure, prove the new path
live, THEN remove the interim send in a second commit. Never both in one.

DO NOT
- Edit public/caregiver.html (Session 6) or anything scheduling (Session 7).
- Mount the component in the caregiver app.
- Build a channel not in the matrix above.
- Filter visibility in the UI instead of the query layer.
- Build attachments, read receipts, typing indicators, or real-time push. Out
  of scope; in-app plus the existing notification queue only.
- Enter real PHI.

ACCEPTANCE
- Every channel in the matrix sends and appears in both parties' threads.
- A caregiver requesting a clinician-to-family thread by id receives 403, not
  an empty list. Prove with a test.
- Client↔caregiver is disabled with an explanation when no caregiver is
  assigned, and enables on assignment.
- A POA message displays "<POA> as POA for <client>" to every recipient.
- A Behavioral Escalation message creates an escalation event; a Clinical
  Escalation carries a response status through its lifecycle.
- Case manager sees behavioral threads and 403s on clinical notes.
- Existing 3.5 messages survive migration and render in the new UI.
- The component mounts in three portals and is absent from the caregiver app.
- Every message write hits the activity log.
- App boots; Sessions 3.x and 4.x unaffected.

Update CLAUDE.md AND docs/GFC_SESSION_PLAN.md per the running instruction
(steps 4-7). Open ONE PR titled "Session 9: Messaging — channel matrix +
role-based visibility." Note the escalation record shape you used and whether
it aligns with Session 6. Stop for review.
```

---

## After this lands
The wiring session mounts `gfc-messaging.js` into Session 6's `gfc-mount-messaging`. Session 10's family feed consumes Care Update pushes from this module.
