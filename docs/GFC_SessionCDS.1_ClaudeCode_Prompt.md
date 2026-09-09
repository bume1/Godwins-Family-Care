# Session CDS.1 — Claude Code Prompt
## Clinical reminders (hybrid): care-plan-derived now, OpenEMR CDR route later — provider + patient views

**Prerequisite:** Honor `CLAUDE.md`'s prerequisite gate. Phase 1 (care-plan-derived reminders) may be **built and verified against TEST DATA now** — it needs no OpenEMR write and no new boundary. Phase 2 (native OpenEMR Clinical Decision Rules) is **spec + patch-source + preflight only** in this session; it is not installed/proven live unless its prerequisites are all confirmed (see Scope E). **Nothing here ships to a real patient before Session 5 (HIPAA go-live).**
**Model:** Opus.
**Spec:** `GFC_Clinical_Completeness_Spec_v1.md` (reminders are clinical decision support — CDS). This prompt is the working spec until a §-number is assigned there.
**Important:** TEST DATA ONLY until Session 5. Clinical reminder *rules* are CDS — clinician-authored or mirrored from OpenEMR, **never invented in code**.

**Why this is queued, not urgent:** it is additive and does not block the release path (4.5 native writes → live preflight → Session 5). Build Phase 1 when the release path allows; Phase 2's live install waits on the same OpenEMR config (ICD-10 load, CDR rules configured, credential swap) that 4.5 waits on.

---

## Paste this into Claude Code

```
You are continuing the GFC Care Platform build. Read CLAUDE.md first and
honor its prerequisite gate. TEST DATA ONLY.

Branch: session/cds.1-clinical-reminders (or harness-assigned)

Read first, in full:
- CLAUDE.md — current state, prerequisite gate, the release path (4.5,
  Session 5) this sits behind.
- patientReadRepository.js — the 4.3 sharing model you MUST reuse:
  SHARING_DEFAULTS, FILTER_MAP, CLINICIAN_ONLY_FIELDS, filterFor/filterRows,
  AUDIENCES, VISIT_LEVELS. The build-fail test asserts CLINICIAN_ONLY_FIELDS
  never appear in a patient payload — extend that same guarantee to reminders.
- clinicalRepository.js — the care-plan shape you derive from: goals,
  eachVisit (tasks), visitFrequency, visitDays, visitTimes, duration,
  effectiveDate, targetDate, chargePlanNote; plus care_plan_versions and the
  co-sign records. The 4.1 "unverified until confirmed" (confirmedFields)
  pattern.
- public/clinical.html — the existing top-of-chart banner pattern (the
  "Billing provider NPI not configured" strip) and the tab structure; this is
  the UI pattern reminders reuse.
- public/portal.html — the 4.3 patient Health tab (visit summaries,
  meds, vitals, sharing card); the reminders card lives here.
- openemr.js — the chart reads (getProblems/getAllergies/
  getMedicationRequests/getEncounters/getPatientAppointmentRows). Phase 2 adds
  one read here.
- docs/openemr-patches/8.4.0-p1/ — the bounded-route wrapper pattern (INSTALL.md,
  gfc-add-scopes.php, acceptance.js). Phase 2's OpenEMR route follows this
  exactly; do not invent a second patch mechanism.

ARCHITECTURE (normative)
- ONE reminder object, TWO renderings. A single server-side reminders module
  computes/reads reminders once and returns a typed list. The provider chart
  and the patient portal both read that one source; they never compute their
  own. Do not scatter reminder logic through route handlers or the frontend.
- Reminder object shape (source-agnostic so Phase 2 merges cleanly):
    { id, source: 'care_plan' | 'visit_cadence' | 'openemr_cdr',
      kind,                    // machine key, e.g. 'care_plan_task_overdue'
      status: 'due' | 'overdue' | 'soon',
      dueDate | null,
      providerText,            // actionable, clinician-facing
      patientText | null,      // plain-language, patient-safe, or null = provider-only
      providerOnly: bool,      // true => never leaves the clinician surface
      sharingKey,              // maps to the 4.3 sharing level that gates patientText
      link }                   // where the provider acts (care plan / schedule)
- Reminders are CDS. Phase 1 derives ONLY from clinician-authored data (the
  care plan the RN wrote, the visit record). Phase 2 MIRRORS OpenEMR's
  configured CDR output. NEVER invent a clinical threshold in code (no "A1c is
  due every 3 months" hardcoded — that rule belongs to the clinician in the
  care plan, or to OpenEMR's rule engine).
- Read-only and additive. Phase 1 writes nothing to OpenEMR. A reminder is
  never auto-resolved: it clears only when the underlying thing is done
  (the visit documented, the plan updated). "Dismiss" is per-session UI, not
  resolution.

PREFLIGHT — report, do not block on it for Phase 1
1. Confirm the 4.3 sharing module (patientReadRepository) is present and its
   CLINICIAN_ONLY_FIELDS build-fail test runs. Reminders reuse it.
2. Confirm a test client with a care plan (>=1 task with a targetDate) and a
   test client with no care plan both exist, for the acceptance cases.
3. For Phase 2 only: report whether (a) ICD-10 is loaded, (b) CDR rules are
   configured in OpenEMR, (c) the credential/scope swap is live, (d) the live
   instance is reachable. If ANY is false, deliver Phase 2 as patch-source +
   preflight and STOP there — exactly as Session 4.5 did. Do not install.

SCOPE — PHASE 1 (build now: care-plan-derived, GFC-owned, no OpenEMR patch)

A. Reminders engine (server-side module, e.g. remindersRepository.js)
   - deriveReminders(client, { carePlan, encounters, appointments }) -> [reminder].
   - Care-plan TASK reminders: for each eachVisit task with a cadence
     (visitFrequency) and/or targetDate/effectiveDate, compute due/overdue/soon
     against "now". Overdue = targetDate passed with no satisfying visit since.
   - Care-plan REVIEW reminder: plan version age vs a review interval that is
     a stored, clinician-set value (surface a default but flag it as a setting,
     do not hardcode a medical interval as fact).
   - VISIT-CADENCE reminder: if the last documented encounter is older than the
     plan's visit frequency AND no future appointment is scheduled -> "visit due".
   - Derive ONLY from what the records actually say. No data => no reminder.
     An empty list is correct; an invented reminder is a patient-safety defect.

B. Provider surface (public/clinical.html)
   - A reminders banner strip at the top of the chart (reuse the Billing-NPI
     banner pattern), severity-colored (overdue > due > soon), each linking to
     the relevant action (Care Plan / Schedule tabs).
   - A "Reminders" panel/section listing all of them with providerText.
   - Optional: surface on chart-open, dismissible for the session. Dismiss !=
     resolve; the reminder returns on next load until the underlying thing is done.

C. Patient surface (public/portal.html Health tab)
   - A "What's coming up / reminders" card showing ONLY patientText, and only
     for reminders whose sharingKey passes the client's sharing level (reuse
     4.3 FILTER_MAP / SHARING_DEFAULTS). providerOnly reminders NEVER appear.
   - Plain-language, non-alarming, "we'll take care of this at your visit"
     framing. Never an instruction to self-treat or self-medicate.
   - POA/family see it under the same 4.3 audience + ROI-family gates already
     in place; nothing new is exposed to them.

D. Audit
   - logActivity() on every reminder render that touches a patient: user, role,
     audience, patientId (OpenEMR uuid), the reminder kinds shown. No PHI in any
     log/trace that leaves the boundary.

SCOPE — PHASE 2 (spec + patch-source + preflight only, unless prereqs confirmed)

E. OpenEMR native CDR reminders (source of truth for screening/immunization/lab)
   - Add a bounded OpenEMR route following docs/openemr-patches/8.4.0-p1
     EXACTLY (rename the route map aside, merge GFC routes on top; register the
     OAuth scope the route path derives; ACL-gate per Master Setup Guide §8.5).
     Route returns OpenEMR's computed clinical reminders for a patient.
   - openemr.js gets one read method that maps CDR output into the SAME reminder
     object shape (source:'openemr_cdr'), so both surfaces stay source-agnostic.
   - Do NOT install or prove live in this session unless PREFLIGHT 3 (a-d) all
     pass. Otherwise: commit the patch source + an acceptance.js + a preflight
     doc, mark it "not installed", and STOP. Report exactly what is missing.

DO NOT
- Invent clinical rules or thresholds. Rules come from the care plan (clinician)
  or OpenEMR CDR (clinician). No hardcoded medical intervals.
- Build drug-interaction / allergy-contraindication checking. That is regulated
  CDS and must come from a drug database, not this code (same boundary the AI.1
  prompt draws).
- Show any patient a providerOnly reminder or any clinician-internal text.
  Everything patient-facing routes through the 4.3 filter.
- Send reminders OUT (SMS/email/push). Outbound patient reminders are the
  Session 9 messaging module. This session is in-app display only.
- Auto-resolve, auto-act, or auto-schedule anything from a reminder.
- Write anything to OpenEMR in Phase 1.

ACCEPTANCE
- A care plan with an overdue task: the provider chart shows an "overdue"
  reminder banner; the patient Health tab shows the safe patientText IF the
  client's sharing allows, and shows nothing if it does not. Prove both.
- A providerOnly reminder never appears in any patient / family / POA payload.
  Add a build-fail test in the spirit of the CLINICIAN_ONLY_FIELDS test.
- A client with no care plan and no visits: zero reminders, branded empty state,
  no invented content. Test with a deliberately empty client.
- Dismiss in the provider UI hides for the session; the reminder returns on
  reload (dismiss != resolve). Documenting the underlying visit / updating the
  plan is what clears it.
- Every patient-facing reminder render appears in logActivity() with its kinds
  and audience.
- Phase 2: patch source + acceptance.js + preflight committed; NOT installed
  unless all four prereqs pass; the CDR read maps into the shared reminder shape.
- App boots; Sessions 3.x / 4.x flows unaffected; esbuild JSX compile of the
  edited pages; unit tests pass.

Update CLAUDE.md and docs/GFC_SESSION_PLAN.md per the running instruction,
including the step-7 post-merge backfill. Open ONE PR titled "Session CDS.1:
Clinical reminders (care-plan-derived + OpenEMR CDR scaffold)." Stop for review.
```

---

## After this lands
Evaluate Phase 1 against real use before wiring Phase 2 live: do the care-plan-derived reminders actually match what clinicians expect to be nudged about? If clinicians are configuring the same nudges twice (once in the care plan, once in OpenEMR CDR), consolidate. Phase 2 goes live only after ICD-10 is loaded and CDR rules are configured in OpenEMR — otherwise most native reminders won't fire. Candidates for later, once real: outbound patient reminders (folds into the Session 9 messaging channel matrix), and an admin/clinician UI to author reminder cadences on the care plan directly.
