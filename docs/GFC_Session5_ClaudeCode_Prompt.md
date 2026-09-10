# Session 5 — Claude Code Prompt
## Clinical HIPAA go-live: AWS boundary migration · per-user auth + MFA · durable audit · BAAs

**This is THE gate.** No real patient PHI — clinical or PHC — may enter the system until this session lands **and its live acceptance passes on the real boundary**. Every prior session correctly assumed TEST DATA ONLY; this is the session that changes that.
**Model:** Opus.
**Spec:** `GFC_App_Build_v2.md` §2 (architecture/boundary), §9 (HIPAA hardening), §Session 5; `GFC_SESSION_PLAN.md` §Session 5; `CLAUDE.md` (locked decisions, environment reminders).

**Honesty note (read this first).** Unlike the feature sessions, a large part of Session 5 is **infrastructure and legal work the build sandbox cannot perform or prove** — provisioning AWS hosting, executing BAAs, moving the deployment, creating per-user OpenEMR accounts. The **code** is buildable and unit-testable here; the **boundary and cutover** are owner-run against the real environment. Do not mark go-live "done" from the sandbox, and do not fake any infra step as complete. Where a step is owner/ops, say so and stop.

**Deferred to Session 12 by owner decision 2026-09-09** (its natural home — Session 12 is the audit-log UI and final HIPAA/BAA review): breach-notification / security-incident procedures per §164.308(a)(6), and the 7-year PHI retention + disposal policy. Both belong to the compliance close-out, not the boundary migration.

**This may be split into sub-PRs (5.1–5.5)** for reviewability, exactly as Session 4 was. One PR is acceptable if each part's acceptance is met and the diff stays reviewable.

---

## Paste this into Claude Code

```
You are continuing the GFC Care Platform build. Read CLAUDE.md first and
honor its prerequisite gate. Until this session's LIVE acceptance passes,
still TEST DATA ONLY.

Branch: session/5-hipaa-go-live (or harness-assigned)

Read first, in full:
- CLAUDE.md — locked decisions ("Data hosting for PHI: AWS inside the BAA
  boundary. Never Replit"), environment reminders, the security finding
  (OpenEMR password grant does not validate client_secret), and the
  status of 4.x/6/7.
- GFC_App_Build_v2.md §2 (boundary diagram), §9 (HIPAA hardening: MFA,
  15-min inactivity logout, audit on every view), §Session 5.
- server.js — how the data store is used TODAY: `const db = new
  Database()` from `@replit/database` at server.js:51, called directly
  (db.get/set/list) throughout. There is NO abstraction yet — 5.1 adds it.
- openemr.js — the token flow: `passwordGrant()` is primary,
  refresh_token supported but obtained via the password grant; there is no
  authorization_code flow. 5.2 replaces this.
- patientReadRepository.js, and every `logActivity()` call — 5.4 makes the
  audit durable. config.js JWT_SECRET fail-fast; the 3-audit hardening
  (DRIVE_ALLOW_ANYONE_LINK gate, IP hashing) already in place.
- docs/OPENEMR_SERVER_DEFECTS_2026-08.md — the password-grant secret
  finding and the superseded/duplicate OAuth clients to disable.

PREFLIGHT — confirm with the owner; STOP and report if any is not ready.
Build the code parts against test config regardless, but do not claim
go-live, do not migrate real data, until ALL are true:
1. AWS in-boundary hosting target exists (Beanstalk/ECS/EC2 in the BAA
   account) with TLS + a secrets manager; the app can deploy to it.
2. Encrypted RDS Postgres is provisioned in-boundary for the app's
   operational data.
3. BAAs executed and on file: AWS, and Google Workspace (Drive/Gmail hold
   consents + signed PDFs). No real PHI moves without these.
4. OpenEMR: a per-user account exists for each clinician; a confidential
   OAuth client with a registered redirect URI for authorization_code; and
   the password-grant global can be disabled.
5. MFA approach decided (built-in TOTP vs an IdP).

OWNER / OPS ACTIONS (not code — list them in the PR so nothing is assumed
done): provision the in-boundary host + RDS + secrets manager + TLS/domain;
execute the AWS + Google Workspace BAAs; create per-user OpenEMR accounts,
register the redirect URI, and DISABLE the password-grant global; DELETE the
superseded/secret-less OAuth clients (v2/v3 + the SQNsx… duplicate); set the
billing NPI + each clinician NPI; load ICD-10-CM; move the RDS/EBS backup
windows off clinic hours; rotate JWT_SECRET and all secrets into the secrets
manager.

SCOPE — build in this order.

5.1 DATA LAYER INTO THE BOUNDARY
- Introduce ONE data-access module: the same get/set/list/delete surface the
  app uses today, with two adapters — the existing Replit KV (dev only) and a
  new encrypted-RDS Postgres adapter — selected by env. Route every direct
  `db.*` call through it; no route handler touches @replit/database directly.
- One-time, idempotent migration script: KV → Postgres, with per-collection
  row counts and a verify pass (re-run is a no-op).
- **ENUMERATE COLLECTIONS DYNAMICALLY FROM THE STORE — do not hardcode a list.**
  Sessions 6, 7, 9 and 10 landed after this prompt was written and added
  collections (shifts, availability, time_logs, the restructured messages,
  visit_logs, escalation_events, incident reports, and more). A hardcoded list
  will silently skip them and leave data behind in KV, discovered only after
  cutover. Walk the store, and **FAIL LOUDLY** on any collection without an
  explicit handler rather than skipping it. The known PHI-bearing set includes
  users/clients, care_plan_versions, care_plan_cosign_events, consent_events +
  provider_authorizations + records_categories, messages, visit_logs,
  escalation_events, shifts, availability, time_logs, encounter_billing,
  prescriptions, clinical_orders, appointment_encounters, activity/audit — but
  treat that as a floor, not the list.
- **Refuse to boot on the KV adapter in production.** A startup assertion:
  if the environment is production and the adapter is KV, exit with a clear
  error. The dev path stays, but it cannot be reached by accident.
- Documents/consents stay in Google Drive under the Workspace BAA — not moved
  into the DB. Acceptance: the FULL existing test suite passes against the
  Postgres adapter; the migration round-trips a complete dev dataset.

5.2 OPENEMR AUTH → authorization_code + PER-USER
- Replace the password grant with authorization_code + refresh_token; each
  clinician authenticates as THEMSELVES. Server-held tokens only; the browser
  never sees them. Remove the password-grant path.
- Clinical writes now attribute to the acting clinician in OpenEMR — retire
  the 4.4 name/NPI-stamp interim (attribution becomes native). Acceptance: a
  clinician write shows that clinician as the OpenEMR user; no password grant
  remains; a secret-less/old client can no longer authenticate.

5.3 APP AUTH HARDENING — MFA + SESSION CONTROLS
- MFA for admin, clinical, and case-manager logins (TOTP enroll + verify +
  recovery codes, or the chosen IdP). 
- 15-minute inactivity logout, and SERVER-SIDE session revocation — JWTs are
  stateless today, so add a session/revocation store so logout and idle
  actually invalidate a token. Acceptance: an admin/clinical login requires
  MFA; an idle session expires; a revoked session is denied on the next request.

5.4 DURABLE audit_log + SCRUBBED LOGS
- A persistent, append-only `audit_log` in RDS capturing every PHI access
  (user, role, patientId, resource, action, timestamp, hashed IP), backing or
  replacing `logActivity()`. Build-enforce that every patient-data route writes
  it (a parse-server.js test in the spirit of the 4.3 CLINICIAN_ONLY_FIELDS
  guard). PII-scrubbed application logs: no PHI in any stdout/error/trace that
  leaves the boundary. Acceptance: every clinical read/write and patient-portal
  read appears in audit_log; a scrub test asserts no PHI in emitted logs.

5.5 CUTOVER RUNBOOK + GO-LIVE ACCEPTANCE
- A committed cutover runbook: deploy to the AWS host, run the 5.1 migration,
  flip DNS, DECOMMISSION the Replit deployment, disable the OpenEMR password
  grant, verify. Plus a go-live acceptance checklist mapped to the HIPAA
  Security Rule (access control §164.312(a), audit §164.312(b), person/entity
  auth §164.312(d), transmission security §164.312(e), and BAAs §164.308(b)).
- **ROLLBACK, written before cutover is attempted.** An RDS snapshot and an EBS
  snapshot taken immediately before the migration runs; a documented path back
  to the pre-cutover state; and an explicit go/no-go decision point after the
  migration verify pass and before DNS flips. Cutover without a written way
  back is not a cutover, it is a bet.
- **MFA break-glass, documented.** Bianca is currently the only human with full
  access to both the app and OpenEMR. Record the recovery-code location and the
  second-account path so a lost phone does not lock the practice out of its own
  record system. This is a runbook entry, not code.
- DO NOT enable real patients until that checklist passes ON THE LIVE BOUNDARY.

DO NOT
- Move or accept any real PHI before the BAAs and the boundary are confirmed.
- Leave the OpenEMR password grant enabled, or any superseded/secret-less
  OAuth client enabled.
- Emit PHI to any log/trace/error that leaves the boundary.
- Claim go-live, or that any infra/BAA step is done, from the build sandbox.
- Break Sessions 3.x / 4.x / 6 / 7 flows. Keep the KV adapter working for dev.

ACCEPTANCE (overall)
- Every prior test green against the Postgres adapter; migration verified.
- authorization_code + per-user attribution proven (against test OpenEMR),
  password grant removed.
- MFA + idle logout + revocation proven.
- audit_log populated on every PHI access, with a build-fail guard; scrub test
  passes.
- Cutover runbook + HIPAA acceptance checklist + rollback path + MFA
  break-glass committed.
- The migration enumerates collections dynamically and fails loudly on an
  unhandled one. Prove it: add a throwaway collection and assert the migration
  refuses rather than skipping.
- The app refuses to boot on the KV adapter with a production environment.
- App boots; dev (KV) path unaffected. Nothing touches real PHI until the owner
  runs the live acceptance.

Update CLAUDE.md and docs/GFC_SESSION_PLAN.md per the running instruction,
including the step-7 post-merge backfill. Open the PR(s) titled "Session 5:
Clinical HIPAA go-live (…part…)". Stop for review after each part.
```

---

## After this lands
The first real patient goes live **only after the go-live acceptance checklist passes on the live boundary** — that is the moment "TEST DATA ONLY" is lifted, and it is an owner decision, not a merge. Then: **Session 12** (audit-log UI + final HIPAA/BAA review) closes the compliance loop, and the queued side tracks that needed the boundary unblock — **AI.1** (dictation → note; its Bedrock/Transcribe/S3 preflight is satisfied by this session's boundary) and **CDS.1 Phase 1** (clinical reminders). Nothing that writes real PHI should run before this session's acceptance passes.
