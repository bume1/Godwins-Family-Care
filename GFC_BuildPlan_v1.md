# GFC Build Plan v1
## Godwins Family Care LLC — Care Management Platform
### Chunked session plan for Claude Code (Sonnet)

This document is the master build plan. Each "Session" below is a self-contained unit of work you hand to a fresh Claude Code chat. Session 0 is written out in full, ready to paste. The rest are outlined so you can direct which one to expand next.

---

## Fixes applied to v2 spec

These resolve gaps and ambiguities in `GFC_ClaudeCode_Prompt_v2.md`. Every session below assumes these are in force.

1. **Module 1F added.** Your v2 referenced ROI enforcement in Confirmation #7 but had no 1F section. Added as *ROI & Consent Management* (see Session 3).
2. **Minimum font size raised.** Body 14px minimum, PCA mobile views 16px. Your 12px floor does not meet WCAG AA for the senior audience.
3. **Gold usage restricted.** Gold (`#F5CD85` and `#c9a44a`) reserved for accents, buttons, and icon fills. Never body text on cream. Contrast fails.
4. **Auto-logout + draft save.** 15-min inactivity auto-logout stays. PCA visit log auto-saves a draft to IndexedDB every 30 seconds so a long visit survives a timeout.
5. **Offline sync conflict rules.** Per-user idempotency keys on every submission. Last-write-wins within a user. No cross-user merges. Submissions replay on reconnect.
6. **GPS geofencing at clock-in.** Default 150m radius around client address, configurable per client. Clock-ins outside radius flag to admin but do not block (caregiver may be transporting).
7. **MFA locked.** TOTP (Google Authenticator, Authy, 1Password) primary. SMS fallback through Twilio HIPAA. Required for Admin and Clinical roles.
8. **Data retention.** 7-year PHI retention minimum. Soft-delete with a 90-day recovery window. Hard-delete emits an audit event.
9. **Audit log UI.** Admin-only "Audit Trail" view, filterable by user, action, date range. Your v2 logged everything but surfaced nothing.
10. **Tech stack locked.** Next.js 14 (app router), PostgreSQL 15, Prisma, NextAuth.js, AWS RDS + S3, Twilio (HIPAA BAA), Resend (email), Sentry with PII scrubbing middleware. Mobile is a PWA for v1. Native deferred.
11. **Role 2 renamed "Clinical".** Single role with two operational contexts (PCS, VA). UI stops juggling "FNP / Examiner / Contractor" as one label.
12. **Build order reordered.** Auth + shared data models land before any feature module. Original v2 put Client Profile (#3) ahead of schema lock.

---

## Brand reference

| Token | Value | Usage |
|---|---|---|
| Navy | `#033D50` | Primary. Headers, footers, callouts, body text on cream |
| Cream | `#FAF7F2` | Banner and card backgrounds when navy is not used |
| Gold light | `#F5CD85` | Button fills, accent lines, icon highlights |
| Gold dark | `#c9a44a` | Hover states, secondary accents |
| Heading font | Cormorant Garamond | Serif, weight 500 and 600 |
| Body font | DM Sans | Sans-serif, weight 400 and 500 |
| Min body size | 14px desktop, 16px PCA mobile | Enforce in Tailwind config |

Logo: navy and gold interlocked-rings mark with "Godwins Family Care LLC" wordmark. Assets live in `/public/brand/`. Required variants: full logo (horizontal), mark only (square for favicon and PWA icon), monochrome navy, monochrome cream for navy backgrounds.

Tone: Clinical but warm. Professional, not corporate. Never salesy.

---

## Repo and branch strategy

- One repo forked from Thrive 365 Labs. Rename to `gfc-care-platform`.
- `main` is protected. No direct commits.
- Each session below runs on a feature branch: `session/<NN>-<short-name>` (e.g. `session/01-foundation`).
- Session ends with a PR opened against `main`. Claude Code does not merge. You review and merge.
- Migrations are per-session and additive. No session rewrites prior migrations.
- Every PR must include: migration diff, new tests, audit log coverage for any new PHI access path, Lighthouse mobile score screenshot for PCA-facing views.

---

## Session 0 — Audit, Strip, and Architecture Lock

**Status:** Paste this whole block into a fresh Claude Code (Sonnet) chat at the root of the forked `gfc-care-platform` repo. No code is written in this session. Output is four documents and your approval to proceed.

### Prompt to paste

```
You are starting Phase 1 of a HIPAA-compliant care management platform for Godwins Family Care LLC, built by revising the Thrive 365 Labs codebase. Read `GFC_ClaudeCode_Prompt_v2.md` and `GFC_BuildPlan_v1.md` in full before doing anything else. The build plan supersedes the prompt where they conflict.

Do not write application code in this session. Do not modify or delete Thrive 365 Labs files. Your entire output is four documents committed to a new branch `session/00-audit`:

1. `docs/feature-map.md`
   For every feature, table, and workflow in the Thrive 365 Labs codebase, list:
   - Name and file path(s)
   - One-line description
   - Status: REUSE (fits GFC as-is), MODIFY (fits with changes — specify what), STRIP (lab-specific, remove), UNCLEAR (flag for Bianca)
   - For MODIFY rows, one line on the change required.

2. `docs/strip-list.md`
   Every file, table, route, and UI component flagged STRIP in the feature map. Grouped by: lab diagnostics workflows, specimen tracking, diagnostic validation, lab result delivery, lab-specific UI. Include a checkbox per item. Do NOT delete anything yet. Wait for Bianca's sign-off on this list in a separate session.

3. `docs/data-model.md`
   A proposed PostgreSQL schema for GFC Phase 1. Must cover: users (with 6-role enum), clients, caregivers, contractors, shifts, availability, time_logs, visit_logs, behavioral_observations, care_plans (versioned), medications, consents (ROI types), messages (with channel enum), escalations, monitoring_events (scaffold only), audit_log. Use UUID primary keys. Include soft-delete columns (deleted_at) on all PHI tables. Every foreign key to a PHI table must be ON DELETE RESTRICT.

4. `docs/tech-decisions.md`
   Confirm the stack in `GFC_BuildPlan_v1.md` is compatible with the current Thrive 365 Labs codebase. If the existing stack differs (e.g. different framework, different ORM), flag it clearly and propose either a migration plan or a stack-compatibility decision for Bianca. Do not start any migration in this session.

After committing these four docs, open a PR against main titled "Session 0: Audit + Architecture Lock" with a summary listing every UNCLEAR item from the feature map as open questions for Bianca.

Success criteria for this session:
- All four docs exist and are complete
- PR is open
- No code in `src/`, `app/`, or any application directory is modified
- No database migrations are created
- The PR body lists every UNCLEAR item as a question

Stop and wait for Bianca's review. Do not proceed to Session 1.
```

---

## Session 1 — Foundation (Auth, RBAC, HIPAA baseline)

**Prerequisites:** Session 0 merged. Strip list approved. UNCLEAR items resolved.
**Branch:** `session/01-foundation`

**Deliverables:**
- NextAuth configured with email + password, TOTP MFA required for Admin and Clinical roles, SMS fallback via Twilio.
- PostgreSQL schema from `docs/data-model.md` migrated. Prisma client generated.
- Six-role enum wired end to end: Admin, Clinical, CaseManager, Caregiver, Client, Family.
- RBAC middleware at the API layer (not just UI). Every route declares required roles. Default-deny.
- Audit log middleware. Every request touching PHI writes to `audit_log` with user_id, role, action, resource, timestamp, IP.
- 15-minute inactivity auto-logout.
- Password policy: 12-char minimum, complexity enforced, breach check against HIBP.
- Encryption at rest (AWS RDS KMS). TLS 1.2 minimum enforced at load balancer.
- PII scrubber middleware for Sentry. No PHI leaves the boundary.

**Acceptance:**
- A new user of every role can log in, hit a protected route, and be denied routes outside their role.
- Admin log in triggers MFA. Non-Admin/Clinical log in does not require MFA.
- Audit log table has entries for every authenticated request.
- Auto-logout fires at 15 min idle with a 60-sec warning toast.
- Integration tests cover RBAC denial for each role pairing.

**Do not do:** Build any feature module. Build any UI beyond login, MFA enrollment, and a stub dashboard per role.

---

## Session 2 — Brand Theme and App Shell

**Prerequisites:** Session 1 merged.
**Branch:** `session/02-shell`

**Deliverables:**
- Tailwind config with brand tokens (navy, cream, gold light, gold dark, Cormorant, DM Sans, font-size scale starting at 14px).
- Global layout: navy header with logo and user menu, cream content area, footer with nav version.
- Responsive shell: desktop layout for Admin and Clinical, mobile-first layout for Caregiver and Client.
- Logo assets placed in `/public/brand/` with all variants listed in the brand reference.
- Accessibility baseline: focus rings, skip-to-content link, semantic landmarks, WCAG AA contrast verified on all brand pairings.

**Acceptance:** Storybook (or equivalent component catalog) shows header, footer, button primary, button secondary, input, card, and banner components at mobile and desktop breakpoints. All pass axe-core automated checks.

**Do not do:** Build feature screens. This session is chrome only.

---

## Session 3 — Client Profile + ROI & Consent (Modules 1A + 1F)

**Prerequisites:** Session 2 merged. Final client profile template from Bianca (optional — placeholder build proceeds without it).
**Branch:** `session/03-client-profile`

**Deliverables:**
- Client record CRUD (Admin + Clinical create, edit; Caregiver read-only on assigned clients).
- Placeholder fields per v2 spec (name, DOB, address, emergency contact, care tier, primary + backup caregiver, care notes, medications).
- Consent subrecord: service agreement, ROI family, ROI provider, continuous monitoring consent (not activated).
- PDF upload to S3 with server-side encryption. File is never stored in the database.
- Consent status badge on client record: Signed / Pending / Expired.
- Family portal access flag is a derived boolean: `true` if ROI family is Signed, else `false`. Route-level guard enforces this.
- Warning banner on client records with any incomplete consent. Visible to Admin and Clinical only.

**Acceptance:** Creating a client with no consent renders the warning banner. Uploading a signed ROI-family PDF flips the badge to Signed and unlocks the family portal gate. Attempting to access the family portal before the flag flips returns 403 at the API layer.

**Do not do:** Build the family portal UI. That is Session 9. Build the care plan. That is Session 8.

---

## Session 4 — PCA Visit Log + Offline PWA (Module 1B)

**Prerequisites:** Session 3 merged. Final PCA visit log HTML form from Bianca (optional — placeholder build proceeds without it).
**Branch:** `session/04-visit-log`

**Deliverables:**
- PWA manifest + service worker registered.
- Placeholder visit log form with all v2 fields (ADL/IADL checklist tier-driven, behavioral observation block tier-driven, flag level, notes, auto-timestamp on submit).
- IndexedDB offline queue. Form submittable offline. Auto-save draft every 30 seconds. Submissions replay on reconnect with idempotency keys.
- GPS-tagged check-in and check-out. Geofence validation against client address with 150m default radius. Out-of-radius clock-ins submit but flag to admin.
- Escalation logic: "Alert Clinical Team" emits in-app notification. "Escalate Now" triggers push + SMS to Clinical and Admin and requires free-text description before submission is allowed.
- Submitted visit notes are immutable. Clinical can append a review note (separate record, timestamped, role-labeled).

**Acceptance:** A PCA in airplane mode can complete and submit a visit log. Reconnecting syncs the submission without duplication. Submitting with flag "Escalate Now" without a description is blocked client-side and server-side. A second submission attempt with the same idempotency key is a no-op.

**Do not do:** Build the Clinical review dashboard. That is Session 6.

---

## Session 5 — Scheduling, Availability, and Time Tracking (Modules 1G + 1H)

**Prerequisites:** Session 4 merged.
**Branch:** `session/05-scheduling`

**Deliverables:**
- Availability submission form (Caregiver and Clinical). 30-day minimum advance window enforced server-side.
- Admin shift posting UI. Open shifts visible to eligible caregivers.
- Client shift request flow (from Client portal stub).
- Bidirectional matching: Pathway A (caregiver self-select, admin approves), Pathway B (admin assigns, caregiver accepts/declines).
- Shift status lifecycle: Open → Claimed/Assigned → Confirmed → In Progress → Completed.
- Clock in / clock out with GPS. Late clock-in and early clock-out flagged.
- CSV export of time logs for payroll. Admin-only.
- Admin edit of time logs with mandatory reason note. Every edit writes to audit log.

**Acceptance:** A caregiver with availability submitted 30 days out can see and claim a matching open shift. Admin approval advances the status. Clock in outside the shift start window flags the entry. CSV export schema matches payroll processor requirements (Bianca to confirm column list before build).

**Do not do:** Build VA scheduling. That module has no time tracking and lives in Session 10.

---

## Session 6 — Clinical Review Dashboard (Module 1D)

**Prerequisites:** Session 4 merged (visit logs exist).
**Branch:** `session/06-clinical-dashboard`

**Deliverables:**
- Flag inbox: all visit notes flagged "Alert Clinical Team" or "Escalate Now", sortable and filterable.
- Visit log browser: chronological view of any client's history.
- Append clinical note to any visit log (never edits the original).
- Mark escalation Reviewed with optional action note.
- Weekly behavioral summary report per client, auto-generated from observation fields.

**Acceptance:** Clinical user sees every flagged note across assigned clients. Escalation status transitions Received → Reviewed → Action Taken are logged. Weekly summary renders for any client with ≥ 1 visit log in the period.

---

## Session 7 — Communication Module (Module 1I)

**Prerequisites:** Session 3 merged (client records and role assignments exist).
**Branch:** `session/07-messaging`

**Deliverables:**
- Structured messaging (not freeform chat). Every message has sender role, recipient role, channel label, timestamp, thread.
- Channel matrix per v2 spec table (Client↔Caregiver, Client↔Admin, Client↔Clinical, Caregiver↔Admin, Caregiver↔CaseManager behavioral, Clinical↔Caregiver, Clinical↔Family care update, Admin broadcast, Family↔Caregiver, Family↔Admin).
- Visibility rules enforced at query layer: caregivers cannot see provider-to-family threads, family cannot see clinical notes, case manager sees only behavioral escalations, etc.
- Behavioral escalation messages to case manager flagged as escalation events (same event store as visit-log escalations).
- Clinical escalation messages from client flagged with response status.

**Acceptance:** A message from Client to Clinical labeled "Clinical Escalation" appears in the Clinical flag inbox. A family user querying messages receives only threads they are a party to. Role denial returns 403 at API layer, not a filtered empty list.

---

## Session 8 — Care Plan with Medications (Module 1C)

**Prerequisites:** Session 3 merged.
**Branch:** `session/08-care-plan`

**Deliverables:**
- Care plan CRUD with version control. Every update creates a new version; prior versions are archived and viewable.
- Medication list on care plan must match medications on client profile. Server-side validation.
- Role-scoped view: PCA sees read-only, relevant sections only (no clinical notes). Family sees summary only.
- Medication details hidden from family unless Clinical explicitly approves sharing on the record.

**Acceptance:** Editing a care plan bumps the version number. Old version viewable. Medication mismatch between profile and care plan blocks save with a specific error.

---

## Session 9 — Family Portal (Module 1E)

**Prerequisites:** Sessions 3, 6, 7, 8 merged.
**Branch:** `session/09-family-portal`

**Deliverables:**
- Family-scoped dashboard: visit summaries, care plan summary, behavioral flag notifications (only if Clinical approved sharing).
- Clinical can push a family update from the Clinical dashboard. Logged with timestamp and role.
- ROI family enforcement at route level. Revoking ROI revokes access immediately.
- Family portal is read-only + notification for Phase 1. No reply.
- Push notifications on behavioral flag shared with family.

**Acceptance:** Revoking ROI family on a client record immediately returns 403 on any family portal route for that client's family users. Re-signing restores access.

---

## Session 10 — VA / C&P Module (Modules 2A–2D)

**Prerequisites:** Session 1 merged.
**Branch:** `session/10-va-module`

**Deliverables:**
- Contractor profile (name, NPI, license, 1099 status, assigned exam categories, pay tier, active flag).
- Availability submission (30-day minimum advance).
- Admin-managed exam schedule. Contractors see their own schedule only, read-only.
- Unified admin calendar across all contractors.
- iCal and Google Calendar export.
- Admin ↔ Contractor subject-threaded messaging. No PHI permitted (enforce via UI warning and a PHI-term detector that flags but does not block).

**Acceptance:** Contractor logging in sees only their own schedule. iCal export opens in Apple Calendar and Google Calendar. VA contractor has no data access to any PCS client record.

---

## Session 11 — Monitoring Scaffold (Phase 2 prep)

**Prerequisites:** Session 1 merged.
**Branch:** `session/11-monitoring-scaffold`

**Deliverables:**
- `monitoring_events` table with columns per v2 spec.
- `POST /api/monitoring/event` accepts payloads and writes to the table. No processing.
- Consent field on client record: monitoring opt-in (inactive).
- "Monitoring" tab in Admin and Clinical nav, labeled "Coming Soon".

**Acceptance:** API accepts a test payload and writes a row. UI tab is present and non-functional.

---

## Session 12 — Audit Log UI + HIPAA Hardening Pass

**Prerequisites:** All prior sessions merged.
**Branch:** `session/12-hardening`

**Deliverables:**
- Admin-only Audit Trail view: filterable by user, role, action, resource, date range.
- Security event alerting: unauthorized access attempts flagged to Admin immediately (in-app + email).
- BAA-service inventory document listing every third-party that touches PHI (AWS, Twilio, Resend, Sentry) with BAA status per vendor.
- Retention job: soft-delete records past 7-year window queued for Admin review, not auto-purged.
- Penetration testing prep checklist committed under `docs/security/`.

**Acceptance:** Admin can search audit log and export filtered results as CSV. A simulated unauthorized access attempt produces an alert in < 60 seconds. BAA inventory is complete and accurate.

---

## How to use this doc

Open a new Claude Code chat, paste the Session 0 prompt exactly as written, let it run. When that PR lands and is merged, come back here and tell me which session to expand next. I'll hand you a ready-to-paste prompt for that session in the same format as Session 0.

If anything in the v2 spec changes before you reach a given session, update that session's deliverables in this file first. The doc is the source of truth for every session after 0.
