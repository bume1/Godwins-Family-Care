# Session 4.11 — Claude Code Prompt
## Visit reminders the day before, and a "Who" line a patient understands

**Prerequisite:** Session 5 merged (per-clinician OpenEMR auth, notification queue, Workspace transport).
**Status:** Ready to run. Small, self-contained.
**Model:** Opus.

**Purpose.** Two gaps in what a patient receives about a clinical visit:
1. **No reminder.** A patient gets one email when the visit is booked and nothing after. For a home-visit practice, a forgotten visit is a wasted drive and a lost slot.
2. **The "Who" line assumes the patient knows who is coming.** `clinicianNameForProviderId` renders `name, licenseLevel` — "Bethel Godwins, FNP" when the field is filled, a bare name when it is empty, and never says in plain words what the person is. A patient opening the door should know a nurse practitioner is coming.

Out of scope, deliberately: a first-visit preparation email, and notifying facility contacts. Both are owner-deferred.

**The architectural constraint — read this before designing anything.** Since Session 5.2, OpenEMR access is authorization_code + PKCE **per clinician**. The password grant and the service account are gone, and there is no system-to-system client. **A background job cannot read the OpenEMR calendar.** Do not add a client_credentials client, a stored clinician token, or any service identity to get around this — that reverses a HIPAA-gate decision and is out of scope.

So the reminder is **captured at write time**. When the app books, reschedules or cancels a visit, it already holds every fact the reminder needs. Record the reminder in the app's own store at that moment, and let the existing notification scanner send it. OpenEMR is never read to send a reminder.

The consequence, stated plainly so it lands in CLAUDE.md: **a visit created or moved directly in OpenEMR's calendar, rather than through the app, gets no reminder, and a visit moved there after booking keeps a reminder for the old time.** The operating rule is that clinical visits are booked and changed through the app.

---

## Paste this into Claude Code

```
You are continuing the GFC Care Platform build. Stack: Express (server.js),
CDN React, dataStore (kv dev / postgres prod), notification queue + trigger
scanner, OpenEMR 8.4 with per-clinician auth only. TEST DATA ONLY until
HIPAA-live.

Branch: session/04.11-visit-reminders

Read first, in full:
- CLAUDE.md (running status; the mutation-check rule; "every time is Eastern")
- notifications.js: clientSideRecipients, send, sendToClientSide,
  visitFields, appointmentBooked (~329), appointmentRescheduled (~412),
  appointmentCancelled (~478)
- server.js: formatVisitWhen (~8422), clinicianNameForProviderId (~8430),
  VISIT_PLACE_LABEL (~8441), the booking route (~8620–8680) and the
  reschedule and cancel routes that call appointmentRescheduled /
  appointmentCancelled — note that reschedule uses a tombstone swap, so the
  eid may CHANGE on a move
- server.js: scanAndQueueNotifications and processNotificationQueue
  (~18575–18600) — the reminder rides the existing scanner, no new timer
- emailTemplates.js: renderGfcEmail, ORG (use ORG.phone — never a literal)

===============================================================================
SCOPE A — THE DAY-BEFORE REMINDER
===============================================================================

A1. STORE. New collection `visit_reminders`, one row per scheduled visit:
      id, clientId, eid, visitDate, startTime, when (the formatted string),
      clinician (the formatted Who from Scope B), place,
      sendAt (ISO instant), status: 'scheduled'|'sent'|'void',
      voidReason, createdAt, sentAt
    Snapshot the display strings at write time. The reminder must not need
    OpenEMR to render.

A2. WHEN IT SENDS. At REMINDER_SEND_HOUR_ET (named constant, default 9) on
    the calendar day BEFORE the visit, Eastern. A Monday visit is reminded
    Sunday at 9 AM ET.
    If sendAt is already in the past at booking time (booked yesterday
    evening for tomorrow morning, booked the same day), DO NOT create a
    reminder. The booking email just went out; a second email minutes later
    is noise.

A3. WIRE IT TO THE THREE WRITES.
    - Booking route: after the appointment row exists and appointmentBooked
      is queued, create the reminder. Best-effort, exactly like the booking
      notice: a failure to schedule a reminder never undoes an appointment.
    - Reschedule: VOID the reminder for the old eid (voidReason
      'rescheduled') and create one for the new eid and new time, applying
      A2 again. The tombstone swap can change the eid — key the void on the
      OLD eid, the create on the NEW one.
    - Cancel: VOID it (voidReason 'cancelled').
    - A no-show sends nothing, before or after (existing rule).

A4. SEND. In scanAndQueueNotifications, pick up rows with
    status 'scheduled' and sendAt <= now, and send through the SAME
    sendToClientSide path as the booking notice, so the recipient rules
    (client + POA family users), the unsubscribe honour, the house template
    and the transport-aware detail rule all apply unchanged.
    Mark the row 'sent' only after the queue accepts it.
    relatedEntityId `${eid}:reminder` so the queue's duplicate check makes a
    second scan a no-op even if marking 'sent' failed.
    A row found with sendAt more than 12 hours past (the server was down
    over the send window) is voided with voidReason 'missed_window', NOT sent
    late. A reminder that arrives after the visit is worse than none.

A5. COPY. Detailed version (transport allows PHI):
      subject:   "Reminder: your visit tomorrow at {time}"
      headline:  "See you tomorrow"
      paragraphs:
        "Your visit is tomorrow. The details are below and in your portal."
        "If you need to change it, please call the office at {ORG.phone}
         as soon as you can."
      fields: When / Who / Where, via visitFields
    Vague version (transport does not allow PHI):
      subject:   "You have a visit coming up"
      paragraphs:
        "Your visit is coming up tomorrow. The details are in your secure
         portal."
        "For privacy we do not put visit details in email."
    BOTH first paragraphs MUST begin with the words "Your visit".
    sendToClientSide rewrites /^Your visit/ to "{Name}'s visit" for a POA.
    A paragraph that starts any other way tells a POA "your visit" about
    somebody else's appointment. Test it.

===============================================================================
SCOPE B — A "WHO" LINE A PATIENT UNDERSTANDS
===============================================================================

B1. One shared formatter, visitClinicianLabel(user), used by booking,
    reschedule, cancel AND the reminder. Output:
      "Bethel Godwins, FNP — your nurse practitioner"
    Credential: prefer a structured prescriberCredential if the user record
    has one (Session 4.10 adds it); else licenseLevel.
    Plain-English role, from the credential, case-insensitive:
      NP, FNP, PMHNP, AGNP, ANP, APRN, and any "-NP"/"-BC"/"-C" NP form
        -> "your nurse practitioner"
      MD, DO   -> "your physician"
      PA, PA-C -> "your physician assistant"
      RN       -> "your nurse"
      LCSW, LMSW -> "your social worker"
    Unrecognised or blank credential -> the name alone, with no role phrase.
    Never guess a role.

B2. A BLANK CREDENTIAL IS A DATA GAP, AND IT SHOULD BE VISIBLE. Any user with
    an openEmrProviderId and no credential gets an amber line in Admin hub ->
    User Management ("Patients see this clinician's name with no title"),
    the same pattern as the 4.8 role-confirmation banner. Saving the record
    with a credential clears it.

===============================================================================
NON-GOALS
===============================================================================
- A first-visit preparation email. Owner-deferred.
- Notifying facility staff or any non-portal contact. Owner-deferred.
- SMS. Email only.
- Any system-level OpenEMR access, client_credentials client, or stored
  clinician token. See the constraint above.
- Reminders for PHCP caregiver shifts.

===============================================================================
VERIFICATION
===============================================================================
1. Booking a visit 3 days out creates one reminder with sendAt = 9:00 AM ET
   the day before. Booking one for tomorrow at 8 AM, at 7 PM today, creates
   none.
2. Reschedule voids the old eid's reminder and creates one on the new eid at
   the new time. Cancel voids it. Assert on the stored rows, read back.
3. The scanner sends a due reminder once; a second scan sends nothing; a
   reminder voided between booking and sendAt never sends.
4. A reminder more than 12 hours past due is voided 'missed_window', not sent.
5. POA recipient gets "{Name}'s visit is tomorrow", the client gets "Your
   visit is tomorrow". Mutation-check: change the first word of the copy and
   the test must fail.
6. Vague version sends when the transport is not PHI-covered, with no date,
   name or place anywhere in subject or body.
7. visitClinicianLabel for FNP, PMHNP-BC, MD, PA-C, LCSW, blank, and "Doula"
   (unrecognised -> name only).
8. Times rendered in Eastern with the server clock set to UTC in the test.
9. Report the suite figure for THIS PR.
```

---

## Owner decision

**Reminder send time** is written as 9:00 AM Eastern the day before the visit. Change the constant if you want it earlier or later.

## Operating rule this creates

Book and change clinical visits **through the app**, not directly in OpenEMR's calendar. A visit made or moved in OpenEMR won't get a reminder, or will keep one for the old time.
