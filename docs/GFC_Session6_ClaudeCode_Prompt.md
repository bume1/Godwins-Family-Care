# Session 6 — Claude Code Prompt
## Caregiver app (PHCP) — 4-tab mobile workspace, tier-branched visit log, escalation

**Prerequisite:** Sessions 3.x and 4.x merged. Independent of Sessions 7 and 9 — **all three run in parallel.**
**Model:** Opus.
**Spec:** `docs/GFC_Caregiver_Workspace_Spec_v1.md` (normative) · `docs/GFC_Caregiver_Profile_Schema_v1.md` · `docs/GFC_App_Build_v2.md` §5.5.
**Build target:** `docs/prototype/caregiver-app-prototype.html`.
**Important:** TEST DATA ONLY.

---

## PARALLEL BUILD PROTOCOL — read before writing any code

Sessions 6, 7 and 9 are running at the same time. Conflicts are avoided by **file ownership**, not by luck.

**You own, exclusively:** `public/caregiver.html` (new), `caregiverRepository.js` (new), `routes/caregiver.js` (new), `test/caregiver_app.test.js` (new).

**You must NOT create or edit:** anything owned by Session 7 (shifts, availability, time logs) or Session 9 (messages). If you need them, use the mount points below.

**Shared files — touch minimally, one line each:** `server.js` (a single `require` + `app.use` to register your route module) and `config.js` (append your enums; do not reorder existing keys). Three sessions will each add one line to these. Keep your change to exactly that so the merge is trivial.

**Mount points you must leave for others.** In the More tab, render two named, self-contained placeholder panels:
- `<div id="gfc-mount-schedule">` — Session 7 fills this. Show "Schedule — coming with scheduling" as a disabled, labeled affordance. No fake interactivity.
- `<div id="gfc-mount-messaging">` — Session 9 fills this. Same treatment.

Document the expected contract for each in a comment: the mount id, the props/data each component will receive, and where the caregiver's own id comes from. A follow-up session wires them; you do not.

---

## Paste this into Claude Code

```
You are continuing the GFC Care Platform build. Read CLAUDE.md first and honor
its prerequisite gate. Sessions 7 and 9 are running IN PARALLEL with you — read
the PARALLEL BUILD PROTOCOL in docs/GFC_Session6_ClaudeCode_Prompt.md and obey
the file-ownership rules exactly. TEST DATA ONLY.

Branch: session/06-caregiver-app (or harness-assigned)

Read first, in full:
- docs/GFC_Session6_ClaudeCode_Prompt.md — the parallel build protocol
- docs/GFC_Caregiver_Workspace_Spec_v1.md — NORMATIVE. §3 visit log branching,
  §4 escalation, §5 RBAC, §6 submission loop, §7 tab structure
- docs/GFC_Caregiver_Profile_Schema_v1.md — licenseLevel and competencies
- docs/GFC_App_Build_v2.md §5.5
- docs/prototype/caregiver-app-prototype.html — visual target (reference art,
  never a data source)
- docs/source-forms/gfc-visit-log.html — the legacy daily note the PCA/CNA log
  is transferred from; preserve field names and required flags
- The 3.5 offline queue pattern (visit-log buffering) — REUSE it, do not build
  a second queue

ARCHITECTURE
PHCP data is app-side (RDS-bound schema, Replit KV today). This session does NOT
touch OpenEMR. Two scheduling and two documentation systems exist by design:
clinical → OpenEMR (Sessions 4.x), PHCP → app. Do not couple them.

SCOPE

A. The 4-tab mobile shell (public/caregiver.html)
Per spec §7, desktop-responsive but mobile-first:
- Home: today's shift summary, GPS clock-in affordance (Session 7 owns the
  action — render the state, mount point for the control), "Submit visit log",
  "Flag a concern", care-tier summary for the assigned client.
- Feed: admin broadcasts + escalation alerts, read-only.
- Clients: assigned patient(s), read-only care plan and behavioral protocols
  (relevant sections only — never clinical notes), message entry point
  (mount point).
- More: visit logs, time history (mount), schedule (mount), availability
  (mount), open-shift pool (mount), help.
Brand tokens: navy #033D50, gold #F5CD85, cream #FAF7F2, Cormorant + DM Sans.
Minimum 16px body text on caregiver mobile views.

B. Tier-branched visit log (spec §3) — the core of this session
ONE form that branches on the caregiver's licenseLevel. Skilled fields never
appear for a level that may not perform them.
- Sitter (§3b): presence + behavioral observation subset.
- PCA (§3a): full ADL/IADL checklist, medication REMINDER only (never
  administration), behavioral observation, general notes.
- CNA (§3c): PCA set plus competency-gated vitals, blood glucose, intake/output.
  Gate each on the caregiver's recorded competencies — a CNA without the
  competency does not see the field.
- LPN: skilled nursing note. Built now, saved as Pending Review, and routed to
  the clinician review inbox. It does NOT write to OpenEMR in this session.
- Every submission auto-timestamped; immutable after submit; clinician appends
  a review note rather than editing.
- Offline-submittable, syncing on reconnect with per-user idempotency keys.

C. Escalation (spec §4) — two or three taps, auto-routed
- Persistent "Flag a concern" on Home, plus the flag field inside a visit log.
- Caregiver picks concern type only: Clinical / Behavioral / Safety-urgent.
  Severity is derived from type. Safety-urgent REQUIRES a one-line description
  before submit.
- Auto-route from the patient's careTeam (client schema): Clinical → assigned
  FNPs; Behavioral → case manager; Safety-urgent → FNPs + case manager + admin.
  Admin always has visibility, paged only on urgent.
- Confirmation names the humans notified ("Sent to Courtney, case manager, and
  Bethel, FNP"). That visibility is the point — do not replace it with a generic
  toast.
- Status lifecycle, timestamped and immutable: Raised → Received (auto) →
  Acknowledged (recipient action) → Action taken / Resolved (+ note). The
  caregiver sees the status move.
- Ride the existing notification queue and activity log; do not build new ones.

D. Submission loop (spec §6)
A submitted visit log fans out to: the family monitoring feed (Session 10 will
consume it — write the record, do not build that view), the clinician review
inbox, and escalation_events when flagged. Incidents (falls, abuse/neglect)
spawn a SEPARATE incident report record, not a checkbox on the visit log.

E. RBAC (spec §5)
Caregivers see only their assigned clients. No rates, no billing, no other
caregivers' notes, no provider-to-family communications. Enforce at the API
layer, not the UI.

DO NOT
- Create or edit anything for shifts, availability, time logs (Session 7) or
  messages (Session 9). Use the mount points.
- Write to OpenEMR. PHCP is app-side.
- Build the family-facing feed view (Session 10) or the matching engine
  (Session 8).
- Build a second offline queue — reuse 3.5's.
- Let a PCA or Sitter form surface any skilled task field.
- Enter real PHI.

ACCEPTANCE
- A caregiver with licenseLevel sitter/pca/cna/lpn sees the correct visit-log
  variant. Prove all four with tests; assert skilled fields are ABSENT (not
  hidden) from the PCA and Sitter payloads.
- A CNA without a recorded competency does not receive that field.
- Submitting in airplane mode buffers and syncs on reconnect without duplication.
- A submitted log is immutable; a clinician review note appends.
- Flagging Clinical notifies the assigned FNPs and nobody else; Safety-urgent
  notifies FNPs + case manager + admin and is refused without a description.
- The confirmation names the actual recipients.
- Escalation status advances through all four states with timestamps.
- An incident creates a separate incident record.
- Caregiver API routes 403 for every other role; a caregiver cannot read a
  client they are not assigned to.
- Both mount points render as disabled labeled panels with the documented
  contract in comments.
- App boots; Sessions 3.x and 4.x unaffected.

Update CLAUDE.md AND docs/GFC_SESSION_PLAN.md per the running instruction
(steps 4-7). Open ONE PR titled "Session 6: Caregiver app — visit log +
escalation." State in the PR that mount points for Sessions 7 and 9 are stubbed.
Stop for review.
```

---

## After this lands
A short wiring session mounts Session 7's schedule component and Session 9's messaging component into the two mount points. Then Session 10 (family feed) can consume the visit-log records this session writes.
