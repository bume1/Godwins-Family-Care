# Session 1 — Claude Code Prompt
## Repo prep · rebrand · role model (non-destructive foundation)

**Model:** run this one on **Opus** (it touches auth, roles, and the user model). Later UI sessions can be Sonnet.

---

## Before you start — upload the docs (your only manual step)
Upload these six files from `~/Desktop/GFCLLC/` into a **`docs/`** folder in the repo (GitHub web upload, or however you add files). Claude Code reads the repo, so they need to live there:
- `GFC_App_Build_v2.md`
- `GFC_Intake_and_Packet_Spec_v1.md`
- `GFC_Matching_Engine_Spec_v1.md`
- `GFC_Caregiver_Profile_Schema_v1.md`
- `GFC_Client_Care_Profile_Schema_v1.md`
- `GFC_Caregiver_Workspace_Spec_v1.md`

The two superseded files (`GFC_ClaudeCode_Prompt_v2.md`, `GFC_BuildPlan_v1.md`) are already in the repo — leave them; the session archives them for you (deliverable 0).

---

## Paste this into Claude Code

```
You are starting the GFC Care Platform build by revising THIS repository (formerly the Thrive 365 Labs app). The stack is Express (server.js), React loaded via CDN with no build step, the Replit key-value store, and JWT auth. Do not change the stack in this session.

Read these first, in full:
- docs/GFC_App_Build_v2.md   ← master plan, source of truth
- docs/GFC_Caregiver_Workspace_Spec_v1.md
- docs/GFC_Client_Care_Profile_Schema_v1.md
- docs/GFC_Caregiver_Profile_Schema_v1.md
The two files in docs/archive/ are SUPERSEDED — ignore them where they conflict with the v2 guide.

This session is NON-DESTRUCTIVE foundation only. No feature modules, no code deletions. Branch: session/01-foundation.

DELIVERABLES

0. Archive the superseded planning docs: move GFC_ClaudeCode_Prompt_v2.md and GFC_BuildPlan_v1.md into docs/archive/ and add a one-line header to the top of each: "SUPERSEDED by docs/GFC_App_Build_v2.md — retained for reference only." Confirm the six new docs are present in docs/ before proceeding; if any are missing, stop and tell Bianca which.

1. Rebrand Thrive 365 Labs → Godwins Family Care across public/*.html:
   - Tokens: navy #033D50, gold #F5CD85, gold-dark #c9a44a, cream #FAF7F2.
   - Fonts: Cormorant Garamond for headings, DM Sans for body.
   - Replace logo, wordmark, page <title>s, and meta. Update the login hub, client portal, admin hub, and service portal.
   - Centralize the brand tokens where the structure allows. Keep ALL existing functionality intact.

2. Extend the role model (ADDITIVE — remove no existing behavior):
   - Add roles: caseManager, family. Document the repurpose mapping in a code comment and in docs: vendor → Caregiver, user → Clinical.
   - Add user fields: licenseLevel ("sitter"|"pca"|"cna"|"lpn") for caregivers; hasClinicalAccess (bool) for clinical/FNP.
   - Add client fields: enrollmentStatus ("intake_pending"|"intake_complete"|"enrolled"); careTeam { assignedFNPs:[], assignedCaseManager, primaryCaregiver, backupCaregiver }.
   - Update the admin-hub user-management UI so an admin can view and set the new roles and fields.

3. Produce docs/strip-list.md (ANALYSIS ONLY — delete nothing):
   - Enumerate every lab-specific file, route, DB key, and UI component: the 102-task CLIA template (template-biolis-au480-clia.json), inventory module, validation reports, service field reports, soft-pilot checklist, and lab-specific knowledge-hub content.
   - Group by area, one checkbox per item. This list is for Bianca to approve in a later session before anything is removed.

ACCEPTANCE
- App still boots; existing logins for admin, user, client, and vendor all work unchanged.
- GFC brand (navy/gold/cream, Cormorant + DM Sans, logo) is visible across login, client portal, admin hub, and service portal.
- The new roles and fields exist in the user and client models and are settable from the admin hub.
- docs/strip-list.md exists and is complete; nothing in src/app has been deleted.

DO NOT
- Delete any lab feature yet (strip list only).
- Build the client portal conversion, intake/enrollment, caregiver app, matching engine, or clinical/OpenEMR work — those are later sessions.
- Migrate hosting or the data layer (Replit → AWS). That runs in parallel as infra, not in this session.
- Touch PHI handling or consents.

When done, open a PR titled "Session 1: Repo prep, rebrand, role model" with a summary of changes and a list of any UNCLEAR items as questions for Bianca. Then STOP and wait for review. Do not start Session 2.
```

---

## Why this is Session 1
It's the safe foundation: it rebrands and extends the data model (both additive and reversible) and produces the strip list without deleting anything. The destructive lab-stripping waits for your sign-off on `strip-list.md` in Session 2, and feature build (client portal, caregiver app, intake) follows after that.
