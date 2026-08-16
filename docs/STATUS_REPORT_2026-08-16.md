# GFC Care Platform — Status Audit

**Date:** 2026-08-16
**Auditor:** Claude Code (in-repo verification against merged PRs + code)
**Baseline:** `docs/GFC_SESSION_PLAN.md` (companion: `docs/GFC_App_Build_v2.md`, `CLAUDE.md`)
**Repo state:** `main` @ `f071b3d`
**Trigger:** confirm Session 3.3 ("completed last night") and re-check overall build state.

---

## Headline

**Session 3.3 is BUILT and MERGED — via PR #16** (`Session 3.3: Staff enrollment view + offline onboarding + care-tier migration`, commit `78e6840`, merged `2026-08-16`). Verified in code, not just docs.

**But the planning docs are stale:** both `CLAUDE.md` and `GFC_SESSION_PLAN.md` still describe 3.3 as **"built, unmerged / not yet opened as a PR."** That was true on the 3.3 working branch, but the merge did not re-sync the status. This is exactly the drift the new "never disagree" checklist line (added in PR #14) exists to prevent — it slipped through on the very next merge. **Fix: flip 3.3 to ✅ Done / PR #16 in both files.**

With 3.3 merged, **Session 3 is feature-complete** (3.1, 3.2, 3.3, 3.4, 3.5 all merged). **Session 4 (Clinical + OpenEMR) is the next priority and remains unstarted.**

---

## Session 3.3 — verification (BUILT & MERGED, PR #16)

Every claimed component of `docs/GFC_Session3.3_ClaudeCode_Prompt.md` is present on `main`:

| Component | Evidence |
|---|---|
| Staff enrollment-submissions view (UI) | `public/admin-enrollment.html` (40 KB) |
| Enrollment API, role-gated at the API layer | 5 routes under `/api/gfc/admin/enrollment/*` in `server.js` (`list`, `:clientId`, `review`, `follow-up`, `approve`), guarded by `requireEnrollmentStaff` (×5) / `requireAdmin` |
| Approve-gate integrity | `POST …/approve` is `requireAdmin` and 409s on incomplete enrollment |
| Offline consent status | `signed_offline` (14 refs) routed through a single `isConsentSatisfied()` (7 refs) used by the enrollment gate, family-ROI check, and intake-submit required-consent check |
| Offline onboarding | `POST /api/gfc/admin/enrollment/offline`; Drive upload via `googledrive.uploadOfflinePacketFile` (PHI-safe, no anyone-link grant) |
| Bulk import | `scripts/import_offline_patients.js` (idempotent by `firstName+lastName+dob`) + `scripts/README.md` |
| Care-tier write-side migration | `migrateCareTierEnum()` runs once on boot, gated by `CARE_TIER_MIGRATION_APPLIED`; rewrites legacy `1/2/3 → A1/A2/A4` via `LEGACY_CARE_TIER_MAP`, guards/logs unrecognized values (no data loss) |

The migration mapping (`1→A1, 2→A2, 3→A4`) matches the read-time `normalizeCareTier()` resolution and the schema/App-Build-v2 vocabulary — consistent end to end. (Minor wording nit: `CLAUDE.md` current-focus paraphrases the mapping as "1/2/3 → A1/A2/A3/A4/B," which lists the target enum rather than the actual 3-value mapping; the Recent-decisions bullet states it correctly.)

---

## Session status (verified against code)

| # | Session | Status | Merged PR |
|---|---|---|---|
| 0 | Infra — AWS + OpenEMR + BAAs | 🟡 In progress (ops) | — |
| 1 | Repo prep · rebrand · role model | ✅ Done | #2 (+ #3) |
| 2 | Strip lab features · deactivate tracker · brand cleanup | ✅ Done | #5 (+ #11 validation cleanup) |
| 3.1 | Client portal + enrollment gate | ✅ Done | #6 |
| 3.2 | Gated intake + consents (+ field parity) | ✅ Done | #7 (parity #13) |
| 3.3 | Staff enrollment view + offline onboarding + care-tier migration | ✅ **Done** | **#16** |
| 3.4 | Transfer-of-Care Provider ROI | ✅ Done | #13 |
| 3.5 | Reconciliation — fixture removal, live wiring, desktop pass | ✅ Done | #15 |
| 4 | Clinical portal + OpenEMR (4.1/4.2/4.3) | ⬜ **Next priority — unstarted** | — |
| 5 | Clinical HIPAA go-live | ⬜ Planned (blocked on 4 + infra) | — |
| 6 | Caregiver app | ⬜ Planned (prototype only) | — |
| 7 | Scheduling · availability · time tracking | ⬜ Planned | — |
| 8 | Matching engine | ⬜ Planned (spec only) | — |
| 9 | Messaging module (channel matrix) | ⬜ Planned (client→admin send only, from 3.5) | — |
| 10 | Family portal | ⬜ Planned (ROI gate scaffold only) | — |
| 11 | RPM / Continuous Care | ⬜ Planned | — |
| 12 | Audit log UI + final HIPAA review | ⬜ Planned (`logActivity()` interim only) | — |
| B-series | Billing (Track D) | ⬜ Planned — spec `GFC_Billing_Architecture_Spec_v1.md` still to be written | — |
| E-series | IME / C&P | ⬜ Planned | — |

**Session 4 absence confirmed:** no OpenEMR/FHIR client, clinician workspace, or scheduling in `server.js` (the single `openemr` grep hit is the `openEmrPatientId` field reference, not an integration).

---

## Spec-doc drift

1. **3.3 merge status (correctness — fix now).** `CLAUDE.md` (status row "✅ Built, unmerged"; focus "built this branch, not yet merged"; Recent-decisions "Not yet opened as a PR") and `GFC_SESSION_PLAN.md` (Session 3 row + detail "built — not yet merged") all contradict the merged PR #16. Flip both to Done / PR #16.

2. **careTier vocabulary — RESOLVED (no drift).** Earlier audits flagged the `1/2/3` vs Track A/B split. Now reconciled everywhere: `CARE_TIER_LABELS` (Track A/B) + read-time `normalizeCareTier()` + the one-shot `migrateCareTierEnum()` in code; `GFC_App_Build_v2.md` §12 marked resolved (PR #14); client schema updated. Closed.

3. **`hasBillingAccess` — not a contradiction.** Still absent from `server.js`/`config.js`. `GFC_App_Build_v2.md` §4 describes it as "not built now; scaffolded (future)," which is consistent with code. B-series unstarted. No fix needed (leave as future design).

4. **`GFC_Billing_Architecture_Spec_v1.md` — still missing.** Referenced as the B-series source of truth in `App Build v2` + `CLAUDE.md`; the file does not exist. Unchanged from the prior audit; only matters before a B-session starts.

5. **`audit_log` — still interim.** `CLAUDE.md` environment reminder states "every PHI access writes to `audit_log`"; code provides `logActivity()`, not a dedicated audit store. Sessions 5/12 own the real one. Unchanged.

---

## Recommended actions

1. **Flip 3.3 → ✅ Done / PR #16** in `CLAUDE.md` (status table + current-focus + Recent-decisions "not yet a PR" line) and `GFC_SESSION_PLAN.md` (Session 3 status row + detail). *(Applied alongside this report.)*
2. Re-point `CLAUDE.md` current-focus at **Session 4** as the active next build (Session 3 is now complete).
3. Before starting Session 4, remember `CLAUDE.md`'s prerequisite gate is now satisfied for Session 3 — nothing earlier is pending.
4. (Housekeeping, optional) Correct the current-focus paraphrase of the careTier mapping to `1/2/3 → A1/A2/A4`.

_Method: enumerated merged PRs from git history, then grepped `server.js`, `googledrive.js`, `config.js`, `public/`, and `scripts/` for each session's concrete artifacts. No application code was changed by this audit._
