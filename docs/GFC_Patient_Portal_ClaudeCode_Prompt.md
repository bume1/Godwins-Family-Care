# Claude Code Prompt: Patient portal, two sessions

**Grounded in the live repo** (`bume1/Godwins-Family-Care`, main @ `c5fc9db`, read 2026-09-29). Line numbers are from that commit. Re-find them by name if the file has moved.
**Model:** Opus for P1 (it changes a 4.3 architecture rule and touches the sign route). Sonnet is fine for P2.

## Why two sessions

The owner asked for one. The honest scope is two, and P1 has to come first because the Health tab is broken today:

- **P1: publish on sign.** Fixes the Health tab, adds notes access, releases results immediately with notification on review, and adds a Latest Visit card with a publish notification.
- **P2: visit requests.** Self-scheduling as requests that staff confirm, plus appointment publishing so patients see upcoming visits.

## Owner decisions (2026-09-29)

1. **Publish on sign** is the fix for patient reads. Patients never read OpenEMR.
2. **Results are visible to the patient as soon as they're filed.** No notification goes out until a clinician acknowledges the result.
3. **Notes access is on.** Signed notes are shown to the patient and POA. This reverses the 4.3 rule that notes are never shown to patients.
4. **Self-scheduling is in.** P2 builds it as requests confirmed by staff (reason below).

## The defect P1 fixes (read this first)

Since Session 5.2, `openemr.forActor(actor)` uses the **acting user's own** OpenEMR token (`emrAuth.getAccessTokenFor`, emrAuth.js:195). A patient, POA or family user has no OpenEMR token, so it throws `EMR_NOT_CONNECTED`. Every patient-facing read below calls `openemr.forActor(req.user)` with a client user:

- `GET /api/gfc/clinical/summary` (server.js:7509): problems, allergies, meds, encounters, appointments. All of them settle as failures and get pushed into `degraded`. The portal then shows "Some sections couldn't load … try again in a few minutes" (portal.html ~6017). That's permanent, and the retry advice is false.
- `GET /api/gfc/clinical/documents` (server.js:~7629) and `/documents/:docId/file` (7688): the OpenEMR document list fails the same way. Care plans and consents still work because they're built app-side.

Confirm this on a test patient before changing anything, and record what you see in the PR. Don't blame the OpenEMR server. This is app-side token logic.

---

## P1: paste into Claude Code

```
Branch: session/portal-p1-publish-on-sign

Read first, in full:
- patientReadRepository.js (all 326 lines). AUDIENCES, SHARING_DEFAULTS (33),
  FILTER_MAP (56), CLINICIAN_ONLY_FIELDS (75) and the build-fail test that
  asserts none of them appear in FILTER_MAP, sectionsFor (135),
  buildVisitSummary (190). THE AUDIENCE AND SHARING RULES STAY EXACTLY AS
  THEY ARE. This session changes where rows COME FROM, not who may see them.
- test/patient_clinical_read.test.js. You'll change one of its rules on
  purpose (Scope C). Don't delete tests to make room.
- server.js:7482 resolvePatientClinicalContext, 7488 logPatientClinicalRead,
  7509-7625 the summary route, ~7629 and 7688 the document routes.
- server.js:12343 the /sign route: attestation persisted, then
  postEncounterCharges (10057). Read postEncounterCharges' comment: a charge
  failure never voids a signature. Publishing follows the SAME soft-fail rule.
- server.js:12501 /encounters/:euuid/co-sign (LMSW → provider/LCSW addendum,
  record.coSignStatus 'pending') and 10930 /co-signatures. Find out which one
  finalizes a pending encounter.
- server.js:14156 /encounters/:euuid/addenda.
- clinicalResults.js (buildResult 121, applyAcknowledgement 200) and
  server.js:12163 POST results (the upload has the bytes in hand here),
  12237 acknowledge.
- notifications.js header: who may be emailed (client + POA only, never
  non-POA family) and how much a message may say given the live transport.
  Every notice in this session goes through it. No new mail path.
- public/portal.html ~6000-6060 (Health tab, sharing settings) and ~6303
  (tabs). public/clinical.html:5413 (the patientSummary field and the "never
  shown to patients" line, which changes in Scope C).

===============================================================================
SCOPE A: THE PUBLISH PIPE
===============================================================================

A1. NEW PURE MODULE patientPublish.js. No I/O, like patientReadRepository.
    buildPublishedChart({ problems, allergies, medications, vitals, at, by,
    sourceEncounterUuid }) and buildPublishedVisit({ encounterUuid, encounter,
    record, attestation, prescriptions, orders, notes, addenda, hold, at, by }).
    Reuse the existing summarize*/summarize*ForPatient mappers and
    buildVisitSummary. Don't write a second mapper for any of them.
    STORE AT FULL LEVEL, FILTER AT READ TIME. Published rows hold the
    full-curated shape. sectionsFor + filterRows still run on every read, so
    a sharing change takes effect immediately with no republish.

A2. COLLECTIONS: patient_published_chart (one row per client, latest wins,
    keep prior versions in a history array capped at 20) and
    patient_published_visits (one row per encounter). Add both to
    dataMigration.js's collection registry with phi: true.

A3. PUBLISH AT SIGN. In /sign, AFTER the attestation is persisted and after
    postEncounterCharges, call publishEncounterToPortal(ctx, attestation).
    It reads problems, allergies, meds and the signed narrative note(s) with
    ctx.emr, the SIGNING CLINICIAN's live session. SOFT-FAIL: a publish
    error never voids the signature. It sets record.portalPublished = false,
    record.portalPublishError, and pushes a warning, exactly like charges.
    - Encounter pending co-sign (coSignStatus 'pending'): DON'T publish at
      sign. Publish from the route that clears the pending state.
    - Addendum on a published encounter: republish that visit's row with the
      addendum appended (addenda are part of the signed record).
    - POST .../encounters/:euuid/publish: clinician-triggered republish
      (requireClinicalWrite). Idempotent. It's the retry button.
    - POST .../patients/:clientId/portal/refresh-chart: republish the chart
      row (problems/allergies/meds) outside a visit. Button on the patient
      chart header.

A4. REWIRE THE PATIENT READS. /api/gfc/clinical/summary reads ONLY
    patient_published_chart + patient_published_visits (+ published results,
    Scope B). It must not construct openemr.forActor at all. Replace
    `degraded` with `publishedAt` + `publishedFromVisitDate`. The UI shows
    "Updated after your visit on <date>". Empty state: "Your care team will
    share your health summary after your first visit." Remove the "try again
    in a few minutes" copy.
    /api/gfc/clinical/documents and /file: serve app-held items only (care
    plans, consents, uploads, published result copies). OpenEMR-only documents
    aren't listed for patients in P1. Say so in the PR.
    BUILD-ENFORCED: a static test fails if any route under /api/gfc/ calls
    openemr.forActor(. Patients never read OpenEMR.

===============================================================================
SCOPE B: RESULTS, VISIBLE ON FILING, NOTIFIED ON REVIEW
===============================================================================

B1. At POST results (12163) the route holds the file bytes. Store a
    patient-release copy in the SAME storage client_document_uploads uses
    (read the code and reuse its helper), private, never an anyone-link.
    On the result row add: patientCopy { storageRef, fileName, mimeType },
    releasedToPatientAt = the filing time, patientNotifiedAt = null,
    patientNote = null.
B2. WHAT THE PATIENT SEES: order/test label, result date, performing lab, the
    PDF, and a status line: "Not yet reviewed by your care team" until
    acknowledged, then "Reviewed by <clinician> on <date>" plus patientNote
    if there is one. NEVER the internal `summary` (it's inbox shorthand) and
    NEVER the app's interpretation flag. Add both to CLINICIAN_ONLY_FIELDS.
    The lab's own report carries the lab's flags, and that's the record.
B3. NO NOTIFICATION AT FILING. At acknowledge (12237), add an optional
    `patientNote` (plain language, 500 chars) to applyAcknowledgement's
    input. After a successful acknowledgement, send ONE notice through
    notifications.js ("A test result has been reviewed by your care team",
    PHI-minimal per the transport rule) and set patientNotifiedAt. Exactly
    once. Re-acknowledging is already refused.
B4. SHARING: new SHARING_DEFAULTS key `results: false` for non-POA family,
    added to the portal sharing screen next to medications.
B5. Critical results: the existing clinician paging is unchanged. The patient
    may see a critical PDF before the clinician calls. That's the owner's
    chosen policy, and the "Not yet reviewed" line is what makes it honest.

===============================================================================
SCOPE C: NOTES ACCESS (reverses the 4.3 "never shown" rule on purpose)
===============================================================================

C1. Published visit rows carry `note`: the signed narrative note(s) exactly
    as signed (subjective, objective, assessment, plan, or however the
    appointment type's sections render), plus addenda, each with author and
    signed time. NEVER the "[GFC STRUCTURED RECORD" note (billing plumbing):
    filter it the same way the /sign route's hasNote check does (12343 area).
    Unsigned drafts never publish.
C2. AUDIENCE: patient and POA get `note`. Non-POA family get it only when
    sharing.visitSummaries === 'full'.
C3. HOLD, PER NOTE, AT SIGN: an optional "Hold this note from the portal"
    control on the sign dialog, with a REQUIRED reason from a fixed list:
    'risk_of_harm' (substantial risk of harm to the patient or another
    person) or 'patient_request'. It's stored on the attestation, logged, and
    shown on the clinician's chart. A held note publishes the visit summary
    WITHOUT `note`, and the portal shows "Your clinician's note for this visit
    is available on request." Releasing a hold later = a republish.
    HIPAA psychotherapy notes (separate process notes kept apart from the
    record) never publish. If the psych workflow has such a note type, find
    it and exclude it by type. If it doesn't, say so in the PR.
C4. THE RULE CHANGE: CLINICIAN_ONLY_FIELDS keeps subjective/objective/
    assessment/plan/narrativeNotes as forbidden in EVERY section EXCEPT a
    new FILTER_MAP 'note' section. Change the build-fail test to assert
    exactly that, rather than deleting it. Update the "never shown to
    patients" copy at clinical.html:5413 and the header comment in
    patientReadRepository.js to the new rule, with the date and the owner
    decision.

===============================================================================
SCOPE D: LATEST VISIT CARD + PUBLISH NOTICE
===============================================================================

D1. Portal Home: a "Latest visit" card from the newest published visit: date
    and clinician, what we worked on (record.patientSummary, or
    diagnosesAddressed if blank), medication changes (sent prescriptions
    only: exclude pending and not_sent if the iPrescribe fields exist, and
    treat legacy transmission 'none' as recorded), tests ordered, follow-up,
    and links to the full summary and the note. Large type, and one-tap
    "Message the care team". Families and POAs are the main users. Design
    for them.
D2. ON PUBLISH, one notice through notifications.js: "Your visit summary
    from <date> is ready", PHI-minimal per transport. Not on republish
    unless the note or summary text actually changed.

===============================================================================
SCOPE E: TESTS, MUTATION-CHECKED
===============================================================================

test/patient_publish.test.js, style of test/patient_clinical_read.test.js.
Minimum:
 1. Static: no /api/gfc/ route calls openemr.forActor(.
 2. Summary served entirely from published rows with a client user that has
    NO OpenEMR token. No `degraded`.
 3. Publish failure at sign → signature persists, warning present,
    portalPublished false. Republish route fixes it.
 4. Pending co-sign → nothing published at sign. Published at co-sign.
 5. Addendum → republished note includes it.
 6. Structured-record note never appears in any payload.
 7. Held note → summary published, `note` absent for every audience, reason
    required (400 without it).
 8. Non-POA family: `note` only at visitSummaries 'full'. Results only when
    sharing.results is true.
 9. Results: visible at filing. Zero notices at filing. Exactly one notice
    on acknowledge. `summary` and `interpretation` never in a patient payload.
10. Sharing change takes effect on the next read with no republish.
MUTATIONS (each must turn a test red; report which caught it): put
forActor(req.user) back in the summary route; publish before the attestation
persists; drop the hold check; send the result notice at filing; remove the
structured-record filter.

CONSTRAINTS
- No OpenEMR access for patient, POA or family users, ever. No system client.
- Don't loosen AUDIENCES, sectionsFor or the ROI/consent gates.
- No PHI in notification bodies beyond what notifications.js allows for the
  live transport.
- Every patient read still goes through logPatientClinicalRead.
- Report the suite figure and the five mutation results.
```

---

## P2: paste into Claude Code (after P1 merges)

**Why requests and not instant booking.** Two rules already in the repo decide this:
- OpenEMR is the only availability authority, and the app keeps no second appointment ledger (server.js:~9061).
- Patients can't touch OpenEMR (P1).

So a patient can't read open slots or write a booking. Home visits are also routed geographically by My Day, so instant home-visit booking would wreck routing. Requests that staff confirm is also how most home-based practices run it. Picking real open slots is a later phase that needs a published-availability design.

```
Branch: session/portal-p2-visit-requests

Read first: server.js ~9061 (CLINICAL SCHEDULING header: no second ledger,
tombstone swap), the POST appointments route (~9455-9530: enrollment gate,
live conflict check), openemr.js createAppointmentRow / swapAppointment,
appointmentTypes.js, notifications.js, P1's patientPublish.js, portal.html
Home/Care tabs.

A. VISIT REQUESTS (a request is not an appointment, so no second ledger)
   - appointmentTypes.js: add `patientRequestable: boolean` per type. Default
     true only for follow-up, annual wellness and telehealth follow-up. Admin
     editable. Psych intake and new-patient visits stay staff-only.
   - visit_requests collection. The patient or POA creates:
     { kind: 'new'|'reschedule'|'cancel', appointmentType, modality
     (home|telehealth), up to 3 preferred { date, window: morning|afternoon|
     evening }, reason (optional, 300 chars), targetEid for
     reschedule/cancel }. Non-POA family can't request (read-only
     audience). Max 3 open requests per client.
   - Run enrollmentGate.checkSchedulingAllowed at request time for a clear
     message. The server still re-checks at booking.
   - Staff queue (requireCapability SCHEDULING): newest first, with an age
     badge. "Book" opens the EXISTING booking form prefilled and posts to the
     EXISTING appointments route, so the conflict check, enrollment gate and
     facility/POS resolution are all untouched. On success: request →
     scheduled, linked to the eid. "Decline" needs a reason. Reschedule and
     cancel use the existing swap/cancel paths.
   - Notices via notifications.js: staff on a new request; patient/POA on
     scheduled or declined. PHI-minimal per transport.

B. APPOINTMENT PUBLISH
   - Whenever the app creates, swaps or cancels an appointment (the staff
     session is live), write patient_published_appointments for that client:
     upcoming only, FILTER_MAP.appointment shape.
   - The portal's upcoming visits and the Latest Visit card's "next visit"
     read from it. Nothing patient-facing reads the OpenEMR calendar.
   - An appointment created outside the app won't show. Say so in the PR,
     and add "Refresh patient appointments" to the P1 refresh-chart route.

C. PORTAL UI: "Request a visit" on Home and on each upcoming visit
   (Reschedule / Cancel). Request status list: Requested → Scheduled /
   Declined (with reason).

TESTS: non-POA family refused; the 4th open request refused; booking goes
through the existing route (static check that no new createAppointmentRow
call site exists); publish on create/swap/cancel; no /api/gfc/ route reads
the OpenEMR calendar. Mutation: bypass the enrollment gate at booking → a
test fails.
```

---

## Deliberately later
- **True slot picking** (patient picks a real open time). Needs a published-availability design that doesn't become a second ledger.
- **Bill pay and statements.** Waits on the billing track.
- **Facility-staff access** (for example, Hickory Log's nurse supervisor for her residents). Needs its own audience and a legal basis, like the ROI rules.
- **Pre-visit questionnaires** (PHQ-9, GAD-7 before psych visits).
