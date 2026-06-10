# GFC Caregiver Workspace — Spec v1

Converts the repo's service portal into the caregiver and clinician work area. Caregiver side is built now; clinician side is a placeholder until AWS/OpenEMR is connected. Aligns with the client portal, the matching schema, and the monitoring loop.

---

## 1. Two surfaces under one umbrella
The old "service portal" splits into two front ends:
- **Caregiver app** — mobile, the 4-tab CareSpace skeleton. Where Sitters, PCAs, CNAs, and LPNs work.
- **Clinician / FNP review** — desktop, reuses the service-report review workflow. The "Pending Review" inbox for visit logs and escalations. Placeholder UI now; deepens when OpenEMR connects.

---

## 2. One Caregiver role, license level as an attribute
Not four roles. A single Caregiver role with `licenseLevel`: `sitter | pca | cna | lpn` (same enum as the matching schema). It drives form scope and permissions.

| Level | Scope | Visit documentation |
|---|---|---|
| Sitter / Companion | Presence, safety supervision, companionship | Presence + behavioral observation only |
| PCA | ADLs/IADLs, personal care, med reminders | ADL/IADL checklist + behavioral + reminders |
| CNA | PCA scope + delegated tasks (vitals) | PCA log + vitals |
| LPN | Skilled nursing (wound care, injections, catheter, med administration) | **Skilled visit note** (see §3) |

---

## 3. Visit log — branches by license level
Same tier-driven pattern the intake form already uses. The form renders only the fields the caregiver's level is licensed for.

- Shared header (all levels): client (auto), GPS check-in/out, visit type, auto-timestamp on submit, immutable after submit.
- Sitter: behavioral observation block + general notes.
- PCA / CNA: full task checklist + observation + safety + recommended changes (see §3a). Vitals shown for CNA / competency-verified only.
- **LPN skilled note (built now):** skilled tasks performed (wound care, injections, catheter, med administration), clinical observations, response to treatment. Marked `Pending Review`. **Its backend ties to OpenEMR** — until that connection exists, the skilled note is captured and queued, and routes to OpenEMR on connect. The form ships now; the clinical persistence lands with AWS.

Every submission is immutable. Clinical appends a review note, never edits.

### 3a. PCA / CNA visit log — fields (transferred from the legacy daily note)
Pulled from the existing PCA daily note, scope-filtered. Manual arrival/departure, total-hours, and the signature blocks are **dropped** — EVV/GPS check-in/out and the immutable timestamp confirm the visit instead.

**Task checklist** (grouped; each item has an optional detail note). Generated from the client's authorized care plan.
- *Personal care / ADLs:* bath/shower/wash, toileting, hair care/shampoo, skin care + observe skin, shaving, brush teeth, nails, foot care/soak, lotion rubs, assist dressing, bedpan/commode/urinal/diaper, peri care.
- *Mobility / transfers:* assist wheelchair, assist transfers, turn & reposition, empty drainage bag.
- *Companionship / activity:* reading & companionship, assist walking / physical activity, escort/errand to medical appt.
- *Household / IADLs:* sweep/dust/tidy/vacuum room, clean bathroom, wash dishes, assist laundry, change linens, clean kitchen equipment, grocery shopping.
- *Meals / nutrition:* cook meals (B/L/D), set up meal / feed, offer fluid, observe & record meal/fluid intake, encourage/support diet as ordered.
- *Medication support:* pick up prescriptions, observe / remind to take medication. **Reminder only — no "administered" option for PCA.**
- *Vitals (CNA / competency-verified only):* temperature, blood pressure, vital signs, blood glucose. Hidden for PCA/Sitter unless competency is verified.
- **Excluded — LPN skilled note only:** catheter care, ostomy care, injection/IV, wound wash & redress, feeding tube care, specimen collection. These do not appear on the PCA/CNA form.

**Tasks not performed** — list + reason (free text).

**Standing / special instructions** (acknowledge the active ones, pulled from the care plan): encourage physical activity, encourage interaction, encourage ERS wear, encourage rest, watchful supervision at all times, bowel/bladder reminders, report abuse/neglect, report all falls, socialize & discuss events, report condition/behavior changes, report health changes/ER visits, encourage relaxation for pain, encourage limb elevation, place items within reach before leaving, keep fluid/food within reach, encourage/cue DME use.

**Patient condition observed** (multi-select): alert, quiet, sleepy, talkative, happy, angry, grieving, depressed, pain, hungry, sick, clean.

**Safety concerns** (multi-select): meal consumption, safety in home, poor physical condition, falls, emotional condition, slowness/weakness, frequent illness, abuse/neglect, weight loss. → **Falls and abuse/neglect auto-spawn an incident report (§4-adjacent), not just a checkbox.**

**Recommended changes** — caregiver feedback, routes to the care team for care-plan review.

**Client satisfaction** — satisfied / not satisfied. Kept as a quality signal (the signature it sat next to is dropped).

**Additional notes** — free text.

### 3b. Sitter visit log — fields (subset of §3a)
Sitters provide companionship and safety supervision only. The log shows: "presence confirmed / client safe," the companionship & activity group, fluids offered (observe only), patient condition observed, safety concerns, tasks not performed, recommended changes, notes.
**Excluded:** all personal-care ADLs (bathing, toileting, peri, dressing), transfers, household chores beyond light tidying, medication support, vitals, and every skilled task.

### 3c. CNA visit log — additions over PCA
Everything on the PCA log (§3a) plus, under verified competency/delegation: full vitals (BP, temperature, pulse, respirations, O2, weight), blood glucose, intake/output recording, and positioning/turn schedule.
**Still excluded:** LPN skilled tasks (catheter, ostomy, injection/IV, wound redress, feeding tube, specimen).

---

## 4. Escalation workflow
Designed to be 2–3 taps and to auto-route, so the caregiver never has to know who to notify.

**Entry points:** a persistent "Flag a concern" button on Home (not just inside a visit log), plus the flag field within a visit log.

**Caregiver picks two things, in plain language:**
1. Concern type: `Clinical` / `Behavioral` / `Safety — urgent`
2. (Auto-set severity by type; "urgent" requires a one-line description)

**Auto-routing (reads the patient's care team, §5):**

| Concern type | Notifies | Channels |
|---|---|---|
| Clinical | Assigned FNP(s) | in-app + push |
| Behavioral | Case Manager | in-app + push |
| Safety — urgent | Assigned FNP(s) + Case Manager + Admin | in-app + push + SMS |

Admin always has visibility; is paged only on urgent.

**Status lifecycle (tracked, timestamped, immutable trail):**
`Raised → Received (auto) → Acknowledged (recipient taps) → Action taken / Resolved (+ note)`

The caregiver sees the status move, so they know it was seen. Confirmation shows who was notified by name ("Sent to Courtney, case manager, and Bethel, FNP"). That visibility is what makes it feel reliable.

**Where it lands:** the FNP/Case Manager desktop inbox; the activity/escalation log; and, only if clinical chooses to share, the family monitoring feed (as a flagged note). Escalations are internal by default.

Reuse: the repo's notification queue (`pending_notifications`) + Resend + activity log already exist; escalations ride on them.

---

## 5. Permissions / RBAC mapping

**Current repo roles → GFC:**

| GFC role | Repo role | Scope re: caregiver / provider / patient |
|---|---|---|
| Admin (Owner/MD) | `admin` | Everything. Manages all assignments and permissions. |
| Clinical / FNP | `user` (+ `hasClinicalAccess`) | Their caseload only. Reviews/appends visit logs, receives clinical escalations. |
| Caregiver | `vendor` (already has `assignedClients`) | Assigned patients only. Read-only care plan, submit visit logs, raise escalations. No rates, no other caregivers, no clinical notes. |
| Case Manager | **new role** | Behavioral escalations + case notes. No scheduling, billing, or clinical notes. |
| Patient / Client | `client` | Own record only. Gated by `enrollmentStatus`. |
| Family | **new role** | Read-only, ROI-gated. |

The repo's `vendor.assignedClients` already models caregiver→patient scoping, which is most of the way there. Caregiver sees a patient only if assigned; FNP sees a patient only if on the caseload; patient sees only their own record.

**The gap to close (do this):** there is no patient → care-team link today. Escalation routing and provider access both need to know *which* FNP(s) and case manager are tied to a patient. Add a `careTeam` to the client record: `assignedFNPs[]`, `assignedCaseManager`, `primaryCaregiver`, `backupCaregiver`. Both escalation routing and access scoping read from it.

**Admin area:** all of this is manageable in the existing admin-hub user-management pattern (role, permission flags, `assignedClients`/caseload arrays). Extended with the two new roles, `caregiver.licenseLevel`, and the patient `careTeam`. So yes, the whole permission breakdown stays admin-managed for the entire app.

---

## 6. The submission loop
A submitted visit log fans out to three audiences from one entry:
1. **Family monitoring feed** — the "Today" timeline (prototyped).
2. **FNP "Pending Review" inbox** — desktop review surface.
3. **Escalation events** — to clinical or case manager, if flagged.

Same data, three audiences. This is what wires the caregiver app to the client and family portals.

---

## 7. Tab structure (caregiver mobile)
- **Home:** today's shift, GPS clock-in, submit visit log, "Flag a concern," care-tier summary.
- **Feed:** admin broadcasts + escalation alerts, read-only.
- **Clients:** assigned patient(s), read-only care plan + behavioral protocols, message.
- **More:** visit logs, time history, schedule, availability, open-shift pool, help.

---

## 8. Reuse from the repo
Service-report form + signature + status workflow → visit log. `signature_needed` → `Pending Review`. Multi-day validation segments → repeated visit entries per shift. Notification queue + activity log → escalations. Admin-hub user management → role/assignment/permission control.

## 9. Additions needed
`client.careTeam` (assignedFNPs, assignedCaseManager, primary/backup caregiver); `caregiver.licenseLevel` (already in schema); `escalation_events` table; `Case Manager` and `Family` roles; `hasClinicalAccess` flag. LPN skilled-note persistence → OpenEMR (deferred to AWS connect).
