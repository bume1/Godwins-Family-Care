# Session 3 — Claude Code Prompt
## Client portal conversion + gated enrollment intake

**Prerequisite:** Session 2 merged (lab features stripped, tracker deactivated).
**Status:** 3.1 (portal + gate) and 3.2 (intake + consents) built on dev. **3.3 (staff enrollment-submissions view) is NOT complete** — still to do. Source form is `docs/source-forms/template-gfc-intake-3.php` (current version).
**Model:** Opus. This is the largest session yet — it touches the portal, routing, and a new multi-step flow.
**Important:** Build on dev with TEST DATA ONLY. The app is not on AWS/RDS yet (that's Track 0), so **no real client PHI** until HIPAA-live.

---

## Paste this into Claude Code

```
You are continuing the GFC Care Platform build on this repository. Sessions 1 and 2 are merged. Stack unchanged: Express (server.js), CDN React, Replit KV, JWT.

Read first, in full:
- docs/GFC_App_Build_v2.md (§4 roles, §5 PHCP build, §5.2 gate, §5.3 intake, §5.4 data model)
- docs/GFC_Intake_and_Packet_Spec_v1.md (the field-level intake + consent detail — source of truth for the form)
- docs/GFC_Client_Care_Profile_Schema_v1.md (the client data model)
- docs/source-forms/template-gfc-intake-3.php (the EXISTING intake form — port it, do not rebuild from scratch)
- docs/prototype/client-prototype-full.html (the visual build target) and docs/design-system/colors_and_type.css (tokens)

Build on the existing stack with TEST DATA ONLY. Do NOT migrate hosting or the data layer, and do NOT enter real PHI — AWS/RDS is a separate later track. Branch: session/03-client-portal.

Open the work as TWO PRs so it stays reviewable:

— PR 1: Client portal conversion + the gate —
A. Convert public/portal.html into the GFC client portal, matching docs/prototype/client-prototype-full.html and the design-system tokens (navy #033D50, gold #C9A44A buttons / #F5CD85 highlights, cream #FAF7F2, Cormorant + DM Sans; white on navy, never grey):
   - Repurpose the kept MilestonesPage into "Care plan summary + upcoming/recent visits."
   - Repurpose SupportPage into structured Messaging (client ↔ caregiver/admin/clinical).
   - Repurpose FilesPage into "Documents & signed consents" (use the existing Google Drive integration).
   - Dashboard home per the prototype (greeting, care-plan card with caregiver + tier, upcoming visits, quick tiles).
B. The enrollment gate (enforced at the API layer, default-deny — not just hidden UI):
   - Read the client's enrollmentStatus ("intake_pending" | "intake_complete" | "enrolled") added in Session 1.
   - If intake_pending: the portal renders ONLY the intake flow; every other client API route returns 403.
   - Family role: gate access on the client's ROI-family consent = signed. No override.
   - When intake + the required consents are complete, flip intake_pending → intake_complete and unlock the portal.

— PR 2: Gated enrollment intake (Stage 2) —
C. Port the enrollment intake from docs/source-forms/template-gfc-intake-3.php into the portal as a React multi-step flow, triggered by the gate (replace the form's token mechanism with the logged-in client's enrollmentStatus). Apply the revisions in GFC_Intake_and_Packet_Spec_v1.md:
   - Branched consent set (§4.2): HIPAA NPP acknowledgment; ROI split into ROI-family and ROI-provider; Service Agreement (rewritten per §4.1 — covers both service lines); Patient Bill of Rights & Self-Determination; emergency-treatment + financial-responsibility; crisis protocol (911/988); monitoring opt-in (inactive). PHC-only: financial agreement + PCA scope acknowledgment. IHPC-only: consent to treat, assignment of benefits, practice NPP. Branch on the client's service path.
   - E-signature per consent: typed name + acknowledgment checkbox + server timestamp; store a consent STATUS PER TYPE on the client record (the gate reads ROI-family).
   - Data-shape fixes: structured medication rows (name/dose/route/frequency/prescribing provider/pharmacy); collect DOB once and derive age; capture full insurance IDs / Medicaid #.
   - Submit writes to the app data store via a structured model that can later swap to AWS RDS. TEST DATA ONLY.
   - Note in code/comments: the rewritten consent language is a working draft pending counsel/licensure review before HIPAA-live.

Stage 1 (the public assessment) stays as the existing marketing form for now — do not rebuild it. This session is the in-portal Stage 2 enrollment + the gate.

DO NOT
- Enter or store real client PHI (dev/test data only until HIPAA-live).
- Touch the deactivated project tracker, the kept service-report scaffold, the matching engine, or any clinician/OpenEMR work — later sessions.
- Migrate hosting or the data layer.

ACCEPTANCE
- A client with enrollmentStatus=intake_pending sees only the intake flow; any other client API route returns 403.
- Completing intake and signing the required consents flips the status and unlocks the portal (care plan, visits, documents, messages).
- A family user without a signed ROI-family is denied the family portal at the API layer.
- Consent statuses are stored per type; medications are structured rows; DOB is collected once; insurance IDs captured.
- The portal visually matches docs/prototype/client-prototype-full.html and uses the design-system tokens.
- App still boots; admin, user, client, and vendor logins are unaffected.

Open PR 1, stop for review, then PR 2. Title them "Session 3.1: Client portal + gate" and "Session 3.2: Gated enrollment intake." STOP after each and wait for review. Do not start Session 4.
```

---

## After this lands
Session 4 is the caregiver app (the 4-tab mobile workspace, tier-branched visit log, escalation), built against `docs/prototype/caregiver-app-prototype.html` and the caregiver workspace spec.
