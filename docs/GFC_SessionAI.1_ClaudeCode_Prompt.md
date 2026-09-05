# Session AI.1 — Claude Code Prompt
## Dictation → structured note (H&P + SOAP), with ICD-10 proposal

**Prerequisite:** OpenEMR 8.4 upgrade complete · Session 4.5 (native writes) merged · Session 4.3 merged · at least two weeks of real clinical visits documented so the note structure is informed by actual use.
**Model:** Opus.
**Spec:** `GFC_Clinical_Completeness_Spec_v1.md` §10 — normative, especially §10.3 boundaries.
**Important:** TEST DATA ONLY until Session 5 HIPAA go-live. Real dictation audio is PHI.

**Do not run this before the main build needs are done.** It is deliberately queued behind the release work.

---

## Paste this into Claude Code

```
You are continuing the GFC Care Platform build. Read CLAUDE.md first and
honor its prerequisite gate. TEST DATA ONLY.

Branch: session/ai.1-dictation-note (or harness-assigned)

Read first, in full:
- docs/GFC_Clinical_Completeness_Spec_v1.md §10 — AI scope and boundaries.
  §10.3 is NORMATIVE, not advisory.
- CLAUDE.md — current state, prerequisite gate
- docs/GFC_Intake_and_Packet_Spec_v1.md §2C — the H&P field set
- The 4.4 follow-up SOAP form and 4.1 H&P form in public/clinical.html
- openemr.js, clinicalRepository.js — existing write paths and the
  intake pre-fill "unverified until confirmed" pattern from 4.1
  (confirmedFields on the visit stamp). Reuse that pattern; do not
  invent a second one.

PREFLIGHT — stop and report if any fails
1. Confirm AWS Bedrock is reachable from the app's environment with an IAM
   role (not keys in env), and that the account's Bedrock configuration has
   ZERO DATA RETENTION explicitly set. If ZDR is not confirmed, STOP —
   this is a HIPAA boundary condition, not a preference.
2. Confirm AWS Transcribe Medical is enabled and reachable, and that its
   output bucket is inside the BAA boundary with encryption at rest.
3. Confirm an S3 bucket exists for audio, inside the boundary, with a
   lifecycle rule that deletes objects after transcription completes.
4. Report the exact model id and region you intend to use for Bedrock.

ARCHITECTURE
Audio → Transcribe Medical → transcript → Claude on Bedrock → structured
draft mapped to the EXISTING note form fields. The model never writes to
OpenEMR. It returns a proposal; the clinician edits and submits through the
already-built 4.1/4.4 save paths.

Build the engine once, generically: a server-side module that takes
(input, output schema, purpose) and returns a validated structured object,
with audit logging and boundary enforcement built in. Both features in this
session use it, and later features should too. Do not scatter model calls
through route handlers.

SCOPE

A. Audio capture and transcription
- Record from the clinician workspace on desktop and mobile.
- Offline-tolerant: if connectivity is poor (home visits), buffer locally
  and upload when it returns. Reuse the visit-log offline queue pattern
  from Session 3.5 — do not build a second queue.
- Upload to the in-boundary S3 bucket, submit a Transcribe Medical job,
  poll for completion, retrieve the transcript.
- DELETE the audio object once the transcript is stored. Audio is PHI and
  has no reason to persist.
- Surface job state in the UI: recording, uploading, transcribing, ready.
  Never block the clinician on a job — they can keep working and come back.

B. Structured note drafting
- The open encounter's visit type selects the target structure:
  * Initial visit → H&P per intake spec §2C (vitals incl. BP both arms,
    systems exam, skin/wound with measurements, PAINAD-style pain score,
    home-hazard inventory, RN triage/Track assignment)
  * Follow-up → the 4.4 SOAP structure (subjective, objective, assessment,
    plan)
- Output is a structured object keyed to the form's existing fields, NOT a
  block of prose dropped into one textarea.
- Vitals spoken aloud populate the vitals fields, and the both-arms BP rule
  from 4.1 still applies server-side.
- Anything the transcript does not support is left EMPTY. The model must
  not infer, complete, or normalize findings that were not said. An empty
  field is correct; a plausible invention is a patient-safety defect.

C. ICD-10 proposal (same pass)
- While drafting the assessment, propose candidate ICD-10 codes for the
  conditions addressed.
- EVERY candidate is validated against OpenEMR's loaded code set before it
  is shown. A code that does not resolve there is discarded silently, not
  displayed with a warning.
- Proposals feed the existing 4.4 diagnosis picker as pre-selected
  candidates, alongside the T1 problem-list carry-forward and T2
  per-clinician favorites already built. Do not replace those; add a third
  source.
- The clinician confirms every code. Nothing is auto-attached to the
  encounter.

D. Unverified-until-touched (normative, §10.3)
- Every AI-drafted section and every proposed code renders visibly
  unverified until the clinician has edited or explicitly confirmed it.
  Reuse 4.1's confirmedFields pattern.
- Sign-and-close is BLOCKED while any AI-drafted section remains
  unconfirmed. Specific error code: SIGN_UNCONFIRMED_AI_CONTENT.
- Rationale to preserve in code comments: a fluent wrong sentence reads as
  plausibly as a correct one. Visual marking is what forces review.

E. Audit
- One logActivity() entry per model invocation: user, role, patientId,
  feature, model id, and the outcome — accepted / edited / discarded.
- The accept-edit-discard signal is how this feature gets evaluated later.
  Make it queryable.
- No PHI in logs, prompt traces, or error messages that leave the boundary.

DO NOT
- Send any PHI outside the AWS BAA boundary. No third-party model APIs.
- Build CPT or E/M level suggestion. Time-based E/M is a lookup table and
  belongs elsewhere; MDM-complexity inference is deferred pending billing-
  consultant review of the prompt itself (spec §10.2).
- Draft, suggest, or auto-complete prescriptions or orders. Fully human.
- Build drug-interaction checking. That is regulated clinical decision
  support and must come from a drug database, not a language model.
- Build inbound-document classification, results extraction, or the
  clinical inbox. Deferred until document volume justifies it (spec §10.4).
- Auto-save, auto-sign, or auto-select anything.
- Persist audio after transcription.

ACCEPTANCE
- Preflight documented in the PR: Bedrock reachable via IAM role, ZDR
  confirmed, Transcribe Medical reachable, audio bucket in-boundary with a
  delete lifecycle.
- A dictated follow-up visit produces a SOAP draft populating the correct
  fields; a dictated initial visit produces an H&P draft. Prove both.
- A transcript that omits a finding leaves that field EMPTY. Write a test
  with a deliberately sparse transcript and assert no invented content.
- Proposed ICD-10 codes appear as candidates in the existing picker; a code
  not in OpenEMR's loaded set never surfaces. Prove with a test.
- Sign-and-close is refused while AI content is unconfirmed, with
  SIGN_UNCONFIRMED_AI_CONTENT. Confirming every section allows the sign.
- Audio object is deleted after transcription. Prove it.
- Every model call appears in logActivity() with its outcome.
- Offline: recording in airplane mode buffers and uploads on reconnect
  without duplication.
- App boots; Sessions 3.x, 4.x flows unaffected.

Update CLAUDE.md and docs/GFC_SESSION_PLAN.md per the running instruction,
including the step-7 post-merge backfill. Open ONE PR titled "Session AI.1:
Dictation to structured note + ICD-10 proposal." Stop for review.
```

---

## After this lands
Evaluate against the accept/edit/discard log before building anything further. If the drafts are consistently edited in the same places, fix the prompt or the form structure before adding features. Candidates for later, in the spec's order: time-based E/M band display (not AI), care-plan drafting from H&P problems, referral letter drafting, transfer-of-care summary from inbound records, plain-language patient visit summary.
