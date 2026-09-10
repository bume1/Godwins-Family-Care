# GFC Care Platform — Session 5 Cutover Runbook and HIPAA Go-Live Acceptance
_Written 2026-09-10 with the Session 5 build. Owner: Bianca. Status: **CODE MERGED ≠ GO-LIVE.** Real PHI enters the system only after §8 passes on the live boundary and the owner says so._

This document is the committed cutover plan the Session 5 brief asked for: deploy into the AWS boundary, migrate the store, flip DNS, decommission Replit, disable the OpenEMR password grant, verify, with a written way back and an explicit go/no-go before DNS moves. It also lists every owner and OpenEMR action the build cannot do from a sandbox, so nothing is assumed done.

---

## 0. What the code now enforces (built in Session 5, all under `npm test`)

| Control | Mechanism | Where | Proof |
|---|---|---|---|
| PHI store inside the boundary | One data module, three adapters (`kv` dev / `postgres` production / `memory` tests); **production refuses to boot on anything but Postgres** | `dataStore.js`, `server.js` boot | `test/data_layer.test.js`; `scripts/verify_session5.js` §1 |
| Migration cannot leave data behind | Source keys are enumerated dynamically; an unclaimed collection **refuses the whole run before any copy**; idempotent; read-back verified | `dataMigration.js`, `scripts/migrate_kv_to_postgres.js` | throwaway-collection test; re-run = 0 writes |
| Clinicians act as themselves in OpenEMR | authorization_code + PKCE per user; server-held refresh tokens encrypted at rest; **no password grant, no shared token anywhere** | `emrAuth.js`, `openemr.js`, `/api/emr/connect`, `/oauth/callback` | `test/emr_auth.test.js`; live: `scripts/verify_emr_authcode.js` (owner-run) |
| MFA for admin / clinical / case manager | TOTP (RFC 6238) enrolment at first login, recovery codes shown once, replay refused, 5 attempts per challenge; `MFA_ENFORCE=false` refused in production | `mfa.js`, `finishLogin` in `server.js`, `public/mfa-step.js` | `test/mfa_sessions.test.js`; probe §3 |
| 15-minute inactivity logout | Server-side session rows; idle → revoked on next request; client guard warns and signs out | `sessionStore.js`, `public/session-guard.js` | probe §4 (real 1-minute wait) |
| Logout and revocation actually invalidate a token | Every JWT names a session; logout / password change / admin reset / deactivation revoke server-side | `authenticateToken` in `server.js` | probe §4 |
| Every PHI access is a durable audit row | Append-only `audit_log` (table on Postgres), PHI-prefix middleware on every request, `logActivity()` writes it first; hashed IP, request id, actingFor for a POA | `auditLog.js` | `test/audit_log.test.js` (every `/api` route is audited or explicitly allowlisted); probe §6 |
| No PHI in process logs | `console.*` scrubbed (emails, phones, SSN, labelled DOB, tokens, secrets); login failures and boot no longer print identifiers | `logScrubber.js` | `test/audit_log.test.js`; probe §7 |

Two things the code deliberately does **not** claim: that the boundary exists (that is §1–§3 below) and that a real clinician's OpenEMR sign-in has been exercised (the sandbox cannot drive OpenEMR's login page; §9 step 3 is yours).

---

## 1. Preflight — confirm before scheduling the cutover

Each line is either **done** or the cutover does not start. None of these were verifiable from the build sandbox.

| # | Item | How to confirm | Status |
|---|---|---|---|
| P1 | AWS in-boundary host for the app (ECS Fargate, Beanstalk or EC2 in the BAA account) with an ALB terminating TLS 1.2+ on `app.godwinsfamilycarellc.com`, and AWS Secrets Manager holding every secret in §3 | The `Dockerfile` in the repo builds and runs there with `NODE_ENV=production`; `https://app.…/healthz` answers `{ok:true, store:"postgres", production:true}` | ☐ owner |
| P2 | Encrypted RDS Postgres (KMS at rest, `rds.force_ssl=1`, automated backups on, backup window **off clinic hours**, deletion protection on) reachable only from the app's security group | `psql "$DATABASE_URL"` from the app host; `SHOW ssl;` returns on | ☐ owner |
| P3 | BAAs executed and on file: **AWS** (recorded done in the Master Setup Guide C-7), **Google Workspace** (Drive + Gmail hold consents and signed PDFs) | Signed copies filed | ☐ owner |
| P4 | OpenEMR: a per-user account for **each clinician** (Guide 8.4, MFA enrolled), the OAuth client carries the app's redirect URI, and the password-grant global can be switched off | `scripts/verify_emr_authcode.js` completes as one clinician (§9 step 3) | ☐ owner |
| P5 | MFA approach decided | **Decided by this build: built-in TOTP** (any authenticator app), no IdP. Widen `MFA_REQUIRED_ROLES` if clients/caregivers should be gated too | ✅ decided, ☐ owner to confirm |
| P6 | Restore drill done once (Guide C-11): newest RDS snapshot restored to a scratch instance, opened, deleted | Dated note | ☐ owner |
| P7 | Secrets rotated before go-live (Guide C-9): DB master, OpenEMR DB, OpenEMR admin, **JWT_SECRET** (rotating it signs everyone out, which is the point), new `EMR_TOKEN_ENCRYPTION_KEY` | Secrets Manager versions dated | ☐ owner |

---

## 2. Owner / OpenEMR actions — nothing here is code

Grouped by where you do it. The Master Setup Guide v4.1 section is cited where one exists.

**OpenEMR (Guide Part II)**
1. **8.1** Security tab: idle session timeout 900 s, password expiry 90 d, min length 12, lockout after 5. Logging tab: audit logging on, every patient-record subcategory. Save each tab.
2. **8.4** A user per rendering clinician (Bethel `bgodwins`, Thanmayie), Provider + Authorized, NPI, taxonomy, licence, **MFA enrolled the same day**. Record each numeric provider id into the clinician's app user (`openEmrProviderId`, admin hub). Bianca's `bume` account: Administrators, Provider unchecked.
3. **8.4 item 4 / 9.4** Retire `gfc-app-api`: the app no longer authenticates as it. Disable the user after the first clinician has signed in through the app and the probe in §9 passes.
4. **9.1 step 4** Administration → Config → Connectors: **Enable OAuth2 Password Grant → OFF.** Then `scripts/verify_emr_authcode.js` reports the grant disabled.
5. **9.3 step 3** API Clients: **disable** "GFC Care Platform (server) v2" (`dlHHtxPDc1gS…`) and v3 (`EBZL0Xzvw-…`), **delete** the never-enabled `SQNsxClgNw…` duplicate. Keep v4 (`mRVhrg5HB…`, 54 scopes). With `client_secret` unvalidated on the password grant (defects record 2026-09-08), every enabled client is a live credential: this is access control, not tidying.
6. **Redirect URIs.** The v4 client accepts `https://app.godwinsfamilycarellc.com/oauth/callback` (verified 2026-09-10: the authorize endpoint answers 307 to its login page for that pair). For a dev/staging app, register **one more client** with the dev callback (e.g. `https://<dev-host>/oauth/callback`) rather than adding a localhost URI to the production client.
7. **8.3** Hickory Log: tick Service Location if care is delivered there.
8. **10.1** Hand-enter the CPT home-visit E/M set (99341/42/44/45, 99347–50) into the fee schedule; ICD-10-CM is already loaded (2026-09-08).
9. **Billing NPI** (Coding queue → Billing settings) and each clinician's NPI on their app user. Signing is blocked without them by design.

**AWS**
10. Provision P1/P2; put every §3 secret in Secrets Manager under `gfc/app/*`; inject into the task/instance environment (never bake into the image).
11. Move RDS backup and maintenance windows, and the OpenEMR EBS snapshot, **off clinic hours**.
12. CloudWatch log group for the app with a retention set (logs are scrubbed, but keep them inside the account regardless).

**Google Workspace**
13. BAA on file (P3). Drive stays the document store (consents, signed PDFs, uploads) — Session 5 does **not** move documents into RDS, by the brief.

---

## 3. Production environment (what the app reads)

| Variable | Value / source | Required |
|---|---|---|
| `NODE_ENV` | `production` | yes — turns on every refusal below |
| `DATA_STORE` | `postgres` | yes (unset resolves to postgres in production) |
| `DATABASE_URL` | RDS connection string, `sslmode=verify-full` | yes |
| `DATABASE_SSL` / `DATABASE_SSL_CA` | `verify-full` (default) / path to the RDS global CA bundle | recommended |
| `JWT_SECRET` | 64+ random chars, rotated for go-live | yes |
| `EMR_TOKEN_ENCRYPTION_KEY` | 32 bytes as 64 hex (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`) | yes |
| `MFA_ENFORCE` | leave unset (`false` is refused) | — |
| `MFA_REQUIRED_ROLES` | default `admin,user,caseManager` | — |
| `SESSION_IDLE_MINUTES` | default `15` | — |
| `OPENEMR_BASE_URL`, `OPENEMR_SITE` | `https://emr.godwinsfamilycarellc.com`, `default` | yes |
| `OPENEMR_CLIENT_ID`, `OPENEMR_CLIENT_SECRET` | the v4 client | yes |
| `OPENEMR_REDIRECT_URI` | `https://app.godwinsfamilycarellc.com/oauth/callback` (byte-for-byte as registered) | yes |
| `OPENEMR_API_USERNAME` / `_PASSWORD` | **removed — nothing reads them; delete from the store** | — |
| `DEFAULT_ADMIN_*`, `DRIVE_*`, email transport, `GFC_BILLING_NPI_USED` etc. | as today | as today |

The app prints the adapter at boot (`🗄️ Data store: postgres (production, inside the BAA boundary)`) and never prints a secret.

---

## 4. Cutover sequence

**T-7 — rehearsal on dev.** Deploy the image to the dev host with a scratch RDS, run `scripts/export_kv_snapshot.js` on the Replit dev store, run `scripts/migrate_kv_to_postgres.js --from-file <snapshot> --dry-run`, then for real, then `--verify-only`, then `node scripts/verify_session5.js` with `BASE_URL=https://<dev-host>`. Have one clinician complete `scripts/verify_emr_authcode.js` against the dev EMR. Fix anything before touching production.

**T-1 — freeze.** Announce a write freeze window. Confirm §1 and §2 items 1–6 done.

**T-0**
1. **Snapshots first (rollback artefacts).** RDS manual snapshot `gfc-app-precutover-<date>`; EBS snapshot of the OpenEMR box; `node scripts/export_kv_snapshot.js` on the current Replit deployment. **Store the file in S3 in the BAA account with server-side encryption, or on the app host's encrypted volume — never on a laptop or in the repo.**
2. Deploy the image with the §3 environment. `healthz` must answer `store:"postgres", production:true`. If it does not boot, read the log: every refusal names its reason.
3. `node scripts/migrate_kv_to_postgres.js --from-file <snapshot> --dry-run` → the report lists every collection with row counts and the PHI flag. **An `UnhandledCollectionError` stops here**: add the handler to `COLLECTION_REGISTRY` (or record an explicit `--ignore`) and rerun. Nothing has been copied.
4. `node scripts/migrate_kv_to_postgres.js --from-file <snapshot>` → `DONE … VERIFY: n/n matched`. Keep the JSON report with the snapshots.
5. `node scripts/migrate_kv_to_postgres.js --from-file <snapshot> --verify-only` → `ok`. A re-run of step 4 must report `copied 0`.
6. **GO / NO-GO (§5).** Decided here, before DNS. NO-GO → §6 path A, nothing user-facing has changed.
7. Flip DNS for `app.godwinsfamilycarellc.com` to the ALB. TTL was lowered at T-1.
8. **Everyone signs in again.** Every pre-cutover token is dead by design (no session id). Admin, clinical and case-manager users enrol MFA at that first login and are shown recovery codes once. Clinicians click **Sign in to OpenEMR** in the workspace.
9. Run `BASE_URL=https://app.godwinsfamilycarellc.com ADMIN_EMAIL=… ADMIN_PASSWORD=… MFA_SECRET=… node scripts/verify_session5.js` (a dedicated verification admin account, not Bianca's). Run `scripts/verify_emr_authcode.js` as one real clinician.
10. **Decommission Replit.** Stop the deployment; delete its secrets; leave the KV store read-only for 7 days (it is the last copy of pre-cutover data outside the snapshot), then delete it. **The KV store holds TEST DATA ONLY** — every session before this one was test-data-only by rule, so the 7-day window is not a PHI exposure. If real PHI is ever found there it is purged immediately, not on a schedule, and the event is recorded as a security incident. The marketing site stays on Replit — it holds no PHI.
11. OpenEMR: password grant OFF, superseded clients disabled, `gfc-app-api` disabled (§2 items 3–5). Re-run `verify_emr_authcode.js`: it must report the password grant disabled.
12. **PURGE TEST DATA — both systems, before any real patient exists.** Every acceptance run from Session 4.1 through 6B left named test records behind. In OpenEMR: delete TEST PatientOne and every test patient, their encounters, notes, orders and **fee-sheet charges**. In the app: delete the corresponding client records, visit logs, consent events and encounter_billing rows. A test encounter carrying a CPT code is one claim batch away from going out the door — this is a billing-integrity step, not tidying. Record what was purged and by whom.
13. Re-check §8. Record the date and the two probe outputs. **Only then** does TEST DATA ONLY lift, by the owner's decision.

---

## 5. Go / no-go (after step 5, before step 7)

GO requires every line true:
- [ ] `healthz` on the new host: `store:"postgres", production:true`
- [ ] Migration report: `ok:true`, `conflicts:0`, `verify.mismatches:[]`, and every collection flagged PHI in the report is listed (users, care_plan_versions, consent_*, messages, visit_logs, escalation_*, shifts, time_logs, encounter_billing, prescriptions, clinical_orders, appointment_encounters, audit rows)
- [ ] `--verify-only` `ok:true`; a second migration run copied 0
- [ ] `verify_session5.js` against the new host passes (MFA, sessions, idle, audit, EMR handshake)
- [ ] One clinician completed the OpenEMR sign-in on the new host and a TEST note read back with their OpenEMR username
- [ ] RDS + EBS snapshots and the KV export exist and are dated today
- [ ] §1 P1–P7 all done; BAAs on file

Any line false → NO-GO. The old deployment is untouched; nothing to undo.

---

## 6. Rollback — written before cutover is attempted

**A. Before DNS flips (steps 1–6).** Nothing user-facing changed. Leave the Replit deployment running. Drop or keep the new RDS (it holds a copy, nothing new). No data to reconcile.

**B. After DNS flips, within the same day.** Point DNS back at Replit. Every write made on the new host between the flip and the rollback (new visit logs, messages, consents, audit rows) is only in RDS: export them with `DATA_STORE=postgres DATABASE_URL=… node scripts/export_kv_snapshot.js` and hand-reconcile the affected collections into KV before re-opening writes. Sessions and MFA enrolments do not carry back (the pre-5 code has no session store); users sign in with passwords only on the old build.

**C. RDS damaged after cutover.** Restore `gfc-app-precutover-<date>` (or the latest automated snapshot) to a new instance, point `DATABASE_URL` at it, redeploy. This is the drill in P6.

**D. OpenEMR.** Independent of the app: the EBS snapshot from step 1, per the Master Setup Guide Phase 6 procedure.

The decision to roll back is Bianca's; the trigger is any §8 line failing on the live boundary, or a clinician unable to chart.

---

## 7. MFA break-glass

Bianca is today the only person with full access to both the app and OpenEMR. A lost phone must not lock the practice out of its own records.

1. **Second admin account.** Before go-live, create a second super-admin in the app (a named person, not shared) and enrol MFA on it. Its recovery codes go into the practice password manager, separate entry, with the date.
2. **Recovery codes.** Each MFA-required user is shown 10 single-use codes at enrolment. Store yours in the password manager the same day. Regenerate under `/api/auth/mfa/recovery-codes/regenerate` (needs a current code) when fewer than 3 remain (`GET /api/auth/mfa/status` shows the count).
3. **Admin reset path.** An admin resets another user's MFA (`POST /api/users/:id/mfa/reset`, admin hub); the user re-enrols at next login and every session they held is revoked. This is how the second admin rescues the first, and vice versa.
4. **If both admins are locked out**: an operator with RDS access clears the `mfa` field on the admin's row in `app_kv` `users` (`UPDATE app_kv SET value = … WHERE key='users'`) — deliberately manual and audited by the RDS activity log. Document who did it, when, and why in the compliance file.
5. **OpenEMR.** OpenEMR's own MFA (Guide 8.1) has its own recovery; keep the `admin` account's TOTP recovery in the password manager. The app cannot reset it.
6. A break-glass use is a security event: record it in the audit review (Guide C-8) at the next quarterly review.

---

## 8. HIPAA Security Rule acceptance (must pass ON THE LIVE BOUNDARY)

| Requirement | Control | Verified by | Status |
|---|---|---|---|
| §164.312(a)(1) Access control — unique user identification | Per-person app accounts; per-clinician OpenEMR accounts via authorization_code (no shared service login) | `verify_emr_authcode.js`: note row `user` = the clinician's OpenEMR username | code ✅ · live ☐ |
| §164.312(a)(2)(iii) Automatic logoff | 15-minute idle revocation server-side + client guard | `verify_session5.js` §4 (real wait) | code ✅ · live ☐ |
| §164.312(a)(2)(iv) Encryption at rest | RDS KMS; MFA secrets and OpenEMR refresh tokens AES-256-GCM in the row | RDS console shows encryption on; `test/emr_auth.test.js` (ciphertext in store) | code ✅ · infra ☐ |
| §164.312(a)(2)(ii) Emergency access | §7 break-glass | Second admin exists; codes filed | ☐ |
| §164.312(b) Audit controls | `audit_log` table, append-only, every PHI route + every explicit event, hashed IP, request id; OpenEMR audit logging on (8.1) | `/api/admin/audit-log` after the probe; OpenEMR Administration → Logs | code ✅ · live ☐ |
| §164.312(c)(1) Integrity | Append-only audit; immutable visit logs / attestations (Sessions 4.4, 6) | build guards in `test/audit_log.test.js` | code ✅ |
| §164.312(d) Person or entity authentication | Password + TOTP for admin/clinical/case manager; OpenEMR per-user login + OpenEMR MFA | `verify_session5.js` §3 | code ✅ · live ☐ |
| §164.312(e)(1) Transmission security | TLS 1.2+ at the ALB; RDS `verify-full`; OpenEMR HTTPS; no token ever reaches the browser for OpenEMR | ALB listener policy; `DATABASE_SSL` unset/verify-full | infra ☐ |
| §164.308(a)(5)(ii)(C) Log-in monitoring | `login`, `mfa_failed`, `mfa_locked`, `logout`, `sessions_revoked` rows | audit log query | code ✅ |
| §164.308(a)(3)/(4) Workforce clearance + access management | Role model + RBAC at the API layer (Sessions 4.3, 6, 7, 9); exclusion screening (Guide C-1) | existing build guards; C-1 tracker | code ✅ · ops ☐ |
| §164.308(b) Business associate contracts | AWS, Google Workspace on file; Availity before claims | Signed copies | ☐ |
| §164.310 Physical safeguards | AWS data-centre controls under the BAA; no PHI on Replit | Replit decommissioned (§4 step 10) | ☐ |
| §164.308(a)(7) Contingency plan | Snapshots + restore drill (P6, §6) | Dated drill note | ☐ |
| §164.308(a)(1)(ii)(A) **Risk analysis** | A documented assessment of risks to ePHI across the app, OpenEMR, Drive and the vendors. **Not yet written.** This is the single most-cited failure in OCR enforcement — more than encryption, more than audit | Dated risk-analysis document on file | ☐ **owner, before go-live** |
| §164.308(a)(5)(i) **Security awareness training** | Workforce training + a signed acknowledgment. Two people, one afternoon | Dated training record per person | ☐ owner |
| §164.308(a)(7)(ii)(C) **Emergency mode operation** | What a clinician does when the app is unreachable mid-visit — paper fallback and how it re-enters the record. Real for home-based care, not theoretical | Written one-page procedure | ☐ owner |
| §164.312(a)(1) **Accepted risk — `?token=` downloads** | File-download links carry an auth token in the query string. It now names a revocable session, so a leaked URL dies with the session, but the token still lands in browser history and any intermediary log. **Accepted for go-live; review date Session 12** | Named in the risk analysis above | ⚠ accepted |
| §164.308(a)(6) Security incident procedures · §164.316 retention (7 y) and disposal | **Deferred to Session 12 by owner decision 2026-09-09** | — | deferred |

---

## 9. Verification commands

1. `npm test` — 427 tests including every Session 5 build guard.
2. `node scripts/verify_session5.js` — boots the real server on the memory adapter (or `BASE_URL=` for a deployed host) and runs the 38-check acceptance: production refusals, MFA, sessions, idle, EMR handshake, audit rows, scrubbed log.
3. `node scripts/verify_emr_authcode.js` — **run by a person with an OpenEMR login.** Prints the authorize URL, takes the pasted redirect, exchanges the code with PKCE, writes a TEST-DATA note and reads back the OpenEMR `user` on the row. Also reports whether the password grant is still enabled.
4. `node scripts/migrate_kv_to_postgres.js --dry-run | (run) | --verify-only` — the migration and its verify pass; reports written next to the script.
5. `node scripts/emr_login.js` — obtain a per-user token for the other live probes (`scripts/verify_84_transport.js` etc.) now that the password grant is gone; export `OPENEMR_PROBE_ACCESS_TOKEN`.

---

## 10. What Session 5 did not do, and why

- **No infrastructure was provisioned.** The sandbox has no AWS CLI and no standing to create hosts, databases or BAAs; §1–§3 are the owner's, exactly as the brief says.
- **The per-user OpenEMR sign-in was not exercised end to end from the sandbox.** The authorize endpoint was probed live (it accepts the v4 client + the registered redirect and sends the user to OpenEMR's login page), the exchange and refresh are proven against a faithful fake, and the live end-to-end run is `verify_emr_authcode.js`, which needs a human at OpenEMR's login page. Driving that page with stored credentials from a build agent is the wrong side of the line this session is drawing.
- **Documents stay in Google Drive** under the Workspace BAA, per the brief.
- **Row-level tables for the hot collections** (users, shifts, messages) are a later refactor. The Postgres adapter keeps the blob-per-collection shape so ~800 call sites moved without a behaviour change; the audit log is the one collection that became a real table now, because a blob cannot be append-only.
- **The `?token=` download pattern** (auth token in a query string for file downloads) remains; it now names a revocable session, so a leaked URL dies with the session, but the pattern itself is on the Session 12 list.
- **Breach-notification procedure and the 7-year retention/disposal policy** are Session 12 (owner decision 2026-09-09).

---

## Appendix A — Standing up the app on AWS (satisfies P1 and P2)

_Added 2026-09-10. This was the documentation gap: the OpenEMR guide covers OpenEMR, and §1 above treats the app's host and database as prerequisites without saying how to create them. This appendix closes it._

**This is a second, independent stack alongside OpenEMR — not a change to it.** The OpenEMR box, its MySQL database, its security groups and the `emr` DNS record all stay exactly as they are. You are building the app's own set beside them. Same steps you already ran for OpenEMR, different names and a different database engine (the app needs Postgres; OpenEMR runs MySQL, so sharing is not an option).

**Why not run the app on the OpenEMR box:** it is a t3.small already running OpenEMR plus MySQL. Adding a Node process makes both slower, and worse, couples their fate — a restart for one takes the other down with it. Bethel should not lose charting because the app needed a bounce.

**Added cost:** roughly $30–35/month (EC2 ~$15, RDS ~$13, storage and Elastic IP a few dollars).

### A1. Security groups (10 min)

EC2 → Security Groups → Create, twice.

- **`gfc-app-web`** — inbound: HTTPS 443 from Anywhere-IPv4; HTTP 80 from Anywhere-IPv4 (Let's Encrypt's HTTP-01 challenge needs it); SSH 22 from **My IP** only.
- **`gfc-app-db`** — inbound: PostgreSQL 5432, source = the `gfc-app-web` group (start typing the name and select it). **Not Anywhere.** The database is never reachable from the internet.

### A2. RDS Postgres (20 min + ~10 min build)

RDS → Create database → **Standard create** → **PostgreSQL**, latest 16.x.

- Templates: Production · Availability: **Single DB instance**
- Identifier `gfc-app-db` · master username `appadmin` · password → password manager
- Instance: **db.t4g.micro** · Storage 20 GB gp3, autoscaling on, max 100
- Connectivity: do **not** connect to an EC2 compute resource · Public access **No** · security group **`gfc-app-db`**
- Additional configuration: **leave "Initial database name" BLANK** (the app creates its own; pre-creating it makes the first boot fail) · backup retention 30 days · **backup window off clinic hours** · Encryption **enabled** · **Deletion protection on**

Create, then start A3 while it builds. When it reads *Available*, copy the **endpoint** — that is the host part of `DATABASE_URL`.

### A3. The app server (20 min)

EC2 → Launch instance.

- Name `gfc-app` · Ubuntu Server 24.04 LTS (64-bit x86) · **t3.small**
- Key pair: reuse `gfc-emr-key` · Firewall: select existing → **`gfc-app-web`**
- Storage 20 GB gp3 → Advanced → **Encrypted: Yes**

Launch. Then **EC2 → Elastic IPs → Allocate → Associate** with `gfc-app`. Without this the address changes on every restart and the domain breaks.

### A4. DNS (10 min + propagation)

Wherever `godwinsfamilycarellc.com`'s DNS lives — the same place the `emr` record was added.

- Type **A** · Host/Name **`app`** · Value: the Elastic IP · TTL: default (lower it to 300 the day before cutover)

**Verify at dnschecker.org before continuing.** The certificate step in A5 fails if DNS has not propagated.

### A5. Run the app (30 min)

EC2 → Instances → `gfc-app` → **Connect** → **EC2 Instance Connect**. Browser terminal, same as the OpenEMR build. Nothing touches your Mac.

**Install Docker:**
```
sudo apt-get update && sudo apt-get -y upgrade
sudo apt-get -y install docker.io docker-compose-v2 git
sudo systemctl enable --now docker
sudo usermod -aG docker ubuntu && newgrp docker
```

**Get the code:**
```
sudo mkdir -p /opt/gfc && sudo chown ubuntu:ubuntu /opt/gfc && cd /opt/gfc
git clone https://github.com/bume1/Godwins-Family-Care.git app
cd app
```
(Private repo — use a deploy key or a fine-grained PAT with Contents:read.)

**Write the Caddy config.** Caddy is the reverse proxy and it obtains and renews the Let's Encrypt certificate automatically. An AWS load balancer does the same job for about $16/month; at this scale Caddy is the better trade.
```
cat > /opt/gfc/app/Caddyfile <<'EOF'
app.godwinsfamilycarellc.com {
    reverse_proxy app:3000
}
EOF
```

**Write the compose file:**
```
cat > /opt/gfc/app/compose.yaml <<'EOF'
services:
  app:
    build: .
    restart: always
    env_file: /opt/gfc/app.env
    expose: ["3000"]

  caddy:
    image: caddy:2-alpine
    restart: always
    ports: ["80:80", "443:443"]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    depends_on: [app]

volumes:
  caddy_data:
  caddy_config:
EOF
```

**Create the environment file** (values per §3 above). Keep it outside the repo directory so a `git pull` can never touch it:
```
umask 077
cat > /opt/gfc/app.env <<'EOF'
NODE_ENV=production
DATA_STORE=postgres
DATABASE_URL=postgresql://appadmin:<PASSWORD>@<RDS-ENDPOINT>:5432/gfc?sslmode=verify-full
JWT_SECRET=<64+ random chars>
EMR_TOKEN_ENCRYPTION_KEY=<64 hex chars>
OPENEMR_BASE_URL=https://emr.godwinsfamilycarellc.com
OPENEMR_SITE=default
OPENEMR_CLIENT_ID=<v4 client id>
OPENEMR_CLIENT_SECRET=<v4 client secret>
OPENEMR_REDIRECT_URI=https://app.godwinsfamilycarellc.com/oauth/callback
EOF
sudo chown root:root /opt/gfc/app.env && sudo chmod 600 /opt/gfc/app.env
```

Generate the two keys with:
```
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"   # JWT_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"          # EMR_TOKEN_ENCRYPTION_KEY
```

**Secrets note.** §2 item 10 specifies AWS Secrets Manager. A root-owned `600` file on an encrypted volume inside the boundary is a defensible interim and is what these commands do. Secrets Manager with an instance IAM role is the stronger posture and the intended end state — record this as a known deviation with a review date if you go live on the file.

**Launch:**
```
cd /opt/gfc/app
docker compose up -d --build
docker compose logs -f
```

First build takes a few minutes. Watch for the boot line naming the adapter: `🗄️ Data store: postgres (production, inside the BAA boundary)`. **If it refuses to boot, read the message — every refusal names its own reason** (missing `DATABASE_URL`, `MFA_ENFORCE=false`, wrong adapter for production). That is the guard working, not a failure.

Then confirm from your own browser:
```
https://app.godwinsfamilycarellc.com/healthz
```
Expected: `{"ok":true,"store":"postgres","production":true}` with a valid padlock and no warning.

### A6. Operations

- **Monthly patch** (alongside the OpenEMR routine): `cd /opt/gfc/app && git pull && docker compose up -d --build`
- **Backups:** RDS automated backups cover the data. Add an EBS lifecycle snapshot policy for the `gfc-app` volume, daily, 14-day retention — same as the OpenEMR box.
- **Cost alarm:** raise the existing budget from $80 to ~$140 to cover both stacks.
- **CloudWatch:** create a log group for the app with a retention period. Logs are scrubbed, but keep them inside the account regardless.

**When `/healthz` answers correctly, P1 and P2 are satisfied and the cutover sequence in §4 begins.**
