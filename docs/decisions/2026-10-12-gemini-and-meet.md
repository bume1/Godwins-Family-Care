# Gemini on Vertex AI, and Google Meet telehealth

_Owner decisions, 2026-10-12. Recorded from `GFC_Gemini_AI_Reviewer_ClaudeCode_Spec.md` v2 section 1, verbatim — this file is the decision record those sessions are built against._

**Build status.** Session G1 sections A–C (Bedrock removed; the engine moved to Vertex; the Gemini transport) are built. Sections D–H and session T1 are not yet built; nothing claims otherwise.

---

## 1. Owner decisions (record in docs/decisions/2026-10-12-gemini-and-meet.md)

1. **Gemini on Vertex AI is the only model.** Bedrock is removed from the code, the dependencies and the rules. §10.3 of GFC_Clinical_Completeness_Spec_v1.md now reads: Gemini on Vertex AI under the Google Cloud BAA, through modelEngine.js, and no other model API. AI.1, CONSENT_REGISTRY_v2 and the Offline Intake spec carry the old Bedrock-only line; this decision supersedes it everywhere. Speech for dictation (AI.1, not built) is decided when it's built.
2. **US only, released models only.** Gemini runs on the `us` location, never `global`. Preview or experimental models never see patient data. Default model: `gemini-3.5-flash` (GA, supported to at least May 2027). The model is one setting, so a Pro model can replace it once Google releases one as GA.
3. **Zero data retention is proven, not just claimed.** Data caching is off (checked live every day), the abuse-monitoring exception is granted, and no grounding, search or stored-session feature is ever used. Documents staged in Cloud Storage for a review are deleted right after the call, with a 1-day lifecycle rule as a backstop.
4. **No static Google keys for Gemini.** The app reaches Google Cloud through Workload Identity Federation, using the EC2 server's own AWS role. The existing Drive and Gmail service account key is never used for Gemini.
5. **Comprehensive review.** The review reads everything the requesting clinician can already read for that patient, with no time window, no count caps and no document cap. That includes behavioral health notes, risk assessments, caregiver logs, care-team messages the clinician can see, and records received under 42 CFR Part 2 consent (used here for treatment). The only exclusions are other patients' data and non-clinical artifacts (signature images, IP hashes, prices). When a chart is larger than one model call can hold, the app splits it into passes and merges the results. Nothing is silently dropped: anything the model couldn't read is listed.
6. **Records extraction is approved now,** though §10.4 deferred it until volume justified it.
7. **Who can run it:** licensed clinicians (the clinical write roles). Read-only staff can't.
8. **Review outputs aren't part of the medical record.** They're kept 180 days for audit, then purged.
9. **§10.3 and §10.4 otherwise stand.** The AI proposes and never saves on its own. Everything shows as unverified until a clinician acts on it. No drafting of prescriptions or orders, no drug interaction checking, no code or E/M selection.
10. **Telehealth runs on Google Meet under the Workspace BAA.** The app creates a private Meet room per telehealth visit. Recording, transcription and Gemini note-taking are off for these rooms. Patients knock and the clinician admits them. Meet opens in its own tab or app; Google doesn't allow it to be embedded inside another site.
11. **Join links reach patients two ways:** the portal's Join button, and a one-tap link in the reminder email. That link is a single-visit token that works only from 15 minutes before the visit to 60 minutes after, and it opens the Meet room. It carries no patient details.


---

## Why the deterministic reader stays

The template and OCR reader (`documentTemplates.js`, `documentOcr.js`) is **not** a stopgap and was not removed when Gemini became reachable. For a form the office receives a hundred times — the same referring practice's face sheet, the same carrier's insurance card — a declared label beats a model: it is cheaper, auditable, reproducible, and it cannot invent a member ID. The model earns its place on the documents nobody has seen before, which is the smaller pile. The model path takes precedence where the boundary is satisfied; the template reader is the fallback when it is refused.

## Why the daily checks are part of the boundary, not a diagnostic beside it

`VERTEX_ZERO_DATA_RETENTION` is a *claim about an account*, and the account is what has to be true. Data caching and the staging bucket's retention are settings somebody can change in the console at any time, so a check that passed yesterday is not evidence about today. `modelEngine.status()` therefore treats a check older than 24 hours as a blocker in its own right, and a failed check carries Google's own reason through rather than replacing it. A check that could not be run is never read as a pass.
