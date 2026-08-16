# Session 3.5 — Claude Code Prompt
## Reconciliation: fixture data removal + live wiring + responsive desktop pass

**Prerequisite:** Sessions 3.1–3.4 merged (or 3.4 at minimum in review).
**Status:** Ready to run.
**Model:** Opus.
**Purpose:** Close the gap between the live app and the build docs before Session 4. Bianca's walkthrough found the unlocked portal still showing prototype/fixture example views instead of live patient data, and no desktop layout for portal views. This session finds ALL such drift, fixes the mechanical items, and reports anything needing a product decision.

---

## Paste this into Claude Code

```
You are continuing the GFC Care Platform build. Sessions 3.1 through 3.4 are
merged (verify; if 3.4 is still in review, proceed against its branch merged
into a working branch). Stack: Express (server.js), CDN React, Replit KV, JWT.
TEST DATA ONLY until HIPAA-live.

Branch: session/03.5-reconciliation

Read first, in full:
- CLAUDE.md (repo root — running status)
- docs/GFC_App_Build_v2.md (§5 PHCP build, §5.2 gate, §5.4 data model)
- docs/GFC_Intake_and_Packet_Spec_v1.md
- docs/GFC_Client_Care_Profile_Schema_v1.md
- docs/prototype/client-prototype-full.html and
  docs/prototype/phcp-portal-prototype.html (visual targets — but note: the
  prototypes are REFERENCE ART, not data sources. Any prototype content
  hard-coded into the live app as displayed data is a bug this session
  removes.)

THIS IS A RECONCILIATION SESSION. Two deliverables: a drift report, and a PR
fixing every mechanical item. Work in this order.

===============================================================================
PHASE 1 — DRIFT AUDIT (read-only, ~an hour of your effort)
===============================================================================

Walk every client-facing and staff-facing view in the app as each role. For
each screen, record in docs/DRIFT_REPORT_<date>.md:

1. FIXTURE DATA: any place the UI renders hard-coded, sample, placeholder, or
   prototype-derived content instead of data from the KV store for the
   logged-in user. Known suspect: GET /api/gfc/messages returns a fixture stub
   from Session 3.1. Find ALL others — grep for hard-coded names (e.g.
   "Margaret", "Joelle"), static arrays feeding UI lists, endpoints returning
   canned JSON, and any component rendering content that does not originate
   from the client record, visit logs, care plans, consents, or messages
   store.

2. DEAD OR DECORATIVE UI: buttons, tiles, and nav items that render but have
   no working backend (excluding items explicitly scaffolded as "Coming Soon"
   per spec, e.g. Monitoring).

3. RESPONSIVE GAPS: every portal view at desktop width (>=1024px). The client
   portal and staff views must be fully usable on desktop, not a stretched
   mobile column. Per v2: admin/staff views are desktop-first; client portal
   must work well on BOTH mobile and desktop.

4. SPEC MISMATCHES: anything else where the live behavior contradicts
   docs/GFC_App_Build_v2.md or the intake spec (gate behavior, consent
   statuses, role visibility, enum values).

Severity per item: FIX-NOW (mechanical, no product decision needed) or
DECISION (needs Bianca). Do not fix anything yet.

===============================================================================
PHASE 2 — FIX EVERY FIX-NOW ITEM
===============================================================================

A. Fixture data removal + live wiring
- Every view listed in Phase 1 item 1 gets wired to real data for the
  logged-in user from the KV store: care plan from the client record, visits
  from visit_logs, documents from the client's Drive references, messages
  from the messages store, consents from the consent records.
- Empty states: where a client has no data yet, render a proper branded empty
  state ("No visits yet" etc.), NEVER sample content.
- Replace the /api/gfc/messages fixture with a real messages store read
  (message send can remain minimal — full channel matrix is Session 9 — but
  what renders must be real data scoped to the user, and a basic
  client→admin message send must persist).
- Delete all prototype-derived hard-coded content from production views.

B. Responsive desktop pass
- Client portal: at >=1024px use a proper desktop layout — persistent side
  navigation instead of bottom tabs, two-column content where the prototype
  implies it, max-width containers, readable line lengths. Brand tokens
  unchanged.
- Staff/admin views (enrollment view from 3.3, admin hub): verify
  desktop-first; fix any mobile-only artifacts.
- Keep mobile behavior intact. Test both breakpoints on every changed view.

C. Small spec mismatches from Phase 1 item 4 that are mechanical (wrong
   label, wrong enum value surfaced, missing role guard on a UI element whose
   API guard exists) — fix them.

===============================================================================
PHASE 3 — REPORT
===============================================================================

Finalize docs/DRIFT_REPORT_<date>.md:
- Table of every item found: view, issue, severity, status (FIXED in this PR /
  DECISION pending with a one-line question for Bianca).
- The DECISION items must be a short list Bianca can answer in minutes.

Update CLAUDE.md per its running instruction (status table: add row "3.5
Reconciliation ✅", recent-decisions bullet, current focus → Session 4).

DO NOT
- Add new features. This session only aligns existing build with existing
  docs.
- Touch OpenEMR/FHIR (Session 4), billing (B-series), or the matching engine.
- Modify the prototypes.
- Enter real PHI. Test data only.

ACCEPTANCE
- Grep for prototype sample names in production views returns zero hits.
- A fresh test client with no data sees branded empty states everywhere, no
  sample content.
- A test client with seeded data sees THEIR data on every portal view.
- Client portal renders a real desktop layout at 1280px and unchanged mobile
  layout at 393px.
- Every FIX-NOW item in the drift report is fixed; every DECISION item has a
  one-line question.
- App boots; all logins work; 3.1–3.4 acceptance behaviors still pass.

Open ONE PR titled "Session 3.5: Reconciliation — live data wiring + desktop
pass." Include the drift report. Stop for review. Do not start Session 4.
```

---

## After this lands
Answer the DECISION items from the drift report (should take minutes), then Session 4 (clinical + OpenEMR) starts with a clean, spec-aligned base.
