# Session 4.8 — Credential-scoped clinical roles and standing orders

**Status:** ready to build
**Owner decisions locked:** RNs and case managers execute under **standing orders**. RN authority is *not* identical to provider authority — same chart visibility, different signing and ordering rights.

---

## 0. Read before writing code

- `server.js` — `requireClinicalRead` / `requireClinicalWrite` (~2219–2237), user create/update (~2448, ~3327), the sign route (~8871), orders (~8773), prescriptions (~8743)
- `patientRead.js` — `canClinicalRead` / `canClinicalWrite`
- `config.js` — `ROLES` (~98), `MFA_REQUIRED_ROLES` (~33)
- `clinicalRepository.js` — `buildOrder` (~1272), care-plan versioning
- `docs/GFC_Clinical_Completeness_Spec_v1.md` §2 item 5, §3, §4
- `docs/GFC_Billing_Segment_App_Integration_Spec.md` §4 — the charge-ready gate, **item 4 in particular**

**The rule this session enforces**, already written in the billing spec and never built: *the rendering provider's certification must match the code billed.*

---

## 1. Today's model, and why it must change

Clinical access is one boolean. `hasClinicalAccess: true` grants read **and** write across prescribing, ordering, coding, and encounter signing. `licenseLevel` exists but is free text displayed beside a name — it gates nothing.

An RN given clinical access today can write a prescription, place a lab order independently, and sign-and-close an encounter carrying an E/M code. All three are outside RN scope, and the app would be producing the record asserting she did them.

---

## 2. Scope A — `clinicalRole` enum

Add `clinicalRole` to the user record. Values:

| Value | Who |
|---|---|
| `provider` | FNP, MD, PA — full clinical authority |
| `rn` | RN, including RN case managers |
| `lcsw` | independently licensed clinical social worker (archetype A9) |
| `lmsw` | master's-level social worker requiring supervision (archetype A10) — **GFC's case managers** |
| `readOnly` | staff **without** a clinical licence |

**Migration must not break a live clinician mid-visit.** Map every existing `hasClinicalAccess: true` user to `provider`, preserving today's behaviour exactly — then print a **boot warning listing each user by name and email** so an admin reassigns the RNs deliberately. Do not silently downgrade anyone; do not leave the reassignment undiscoverable. Record the list in the PR description too.

`hasClinicalAccess` stays as a derived read (`clinicalRole !== null && clinicalRole !== 'readOnly'`) so nothing downstream breaks. Do not delete the field in this session.

MFA already covers these users — they are role `user`, which is in `MFA_REQUIRED_ROLES`. Confirm, don't re-plumb.

### Permission matrix (implement exactly)

| Capability | provider | rn | lcsw | lmsw | readOnly |
|---|---|---|---|---|---|
| Chart read | ✅ | ✅ | ✅ | ✅ | ✅ |
| Vitals write | ✅ | ✅ | ❌ | ❌ | ❌ |
| Nursing assessment / visit note | ✅ | ✅ | ❌ | ❌ | ❌ |
| Psychosocial assessment / BH note | ✅ | ❌ | ✅ | ✅ | ❌ |
| Screening instruments (PHQ-9, GAD-7, SDOH) | ✅ | ✅ | ✅ | ✅ | ❌ |
| Care plan author | ✅ | ✅ | ✅ | ✅ | ❌ |
| Care plan **signature** | ✅ | **service-line branched — §3** | ✅ | ❌ — needs co-sign | ❌ |
| Medication reconciliation (document) | ✅ | ✅ | ❌ | ❌ | ❌ |
| Problem list write | ✅ | ✅ | ❌ | ❌ | ❌ |
| Document upload | ✅ | ✅ | ✅ | ✅ | ❌ |
| Scheduling | ✅ | ✅ | ✅ | ✅ | ❌ |
| Order status advance (sent / resulted) | ✅ | ✅ | ❌ | ❌ | ❌ |
| **Prescriptions** | ✅ | ❌ | ❌ | ❌ | ❌ |
| **Place order — direct** | ✅ | ❌ | ❌ | ❌ | ❌ |
| **Place order — under standing order** | ✅ | ✅ (§4) | ✅ (§4) | ✅ (§4) | ❌ |
| **Select CPT / E/M codes** | ✅ | ❌ | ✅ BH set only | ❌ | ❌ |
| **Sign a billable encounter** | ✅ | ❌ (§3) | ✅ BH set only | ❌ — needs co-sign | ❌ |
| Clinically acknowledge an abnormal result | ✅ | ❌ | ❌ | ❌ | ❌ |

`readOnly` preserves the existing case-manager behaviour and its audit line. Do not regress it.

**LMSW billing rule, from the billing spec archetypes:** an A10 LMSW bills nothing independently. An LMSW encounter carrying any service code is created `pendingCoSign` and is not billable until an `lcsw` or `provider` co-signs it. An A9 LCSW cannot bill E/M — only the behavioural-health code set.

---

## 3. Scope B — split the sign action

`POST /api/clinical/patients/:clientId/encounters/:euuid/sign` is currently one gate.

**Gate on what is being attested, not only on who is asking:**

- An encounter carrying **any CPT/service code** → `provider` only. An RN attempting it gets a 403 naming the reason: the encounter carries a billable service code.
- An encounter with **no service codes** (nursing documentation) → `rn` or `provider` may sign, and the signature records the signer's credential.

**Care-plan signature branches on `serviceLine`:**
- Track A / PHC → RN signature satisfies the care plan
- IHPC / clinical → provider signature required; an RN signature is recorded as the authoring signature and leaves the plan **pending provider co-signature**

Both signature types embed the signer's name, credential, NPI where present, timestamp and IP, per Intake Spec §4.3.

---

## 4. Scope C — standing orders

A standing order is a **clinical document**, not a permission flag. Model it like the care plan, which is already versioned — reuse that pattern.

### The record

```
standing_orders: {
  id, title,
  authorizingProvider: { userId, name, npi, credential },
  version, supersedesVersionId,
  status: 'draft' | 'active' | 'expired' | 'retired',
  permittedOrderTypes: ['lab' | 'imaging' | 'procedure' | 'screening'],
  permittedTests: [ ... ],            // explicit; no free text at execution
  permittedExecutorRoles: ['rn' | 'lcsw' | 'lmsw'],  // WHO may act on this protocol
  indications: [ ICD-10 codes ],
  patientScope: 'panel' | 'named',
  namedClientIds: [ ... ],            // when scope = named
  requiresCoSign: bool,
  coSignWithinDays: int | null,
  effectiveAt, expiresAt,
  signedAt, signatureImage,
  createdAt, updatedAt
}
```

### Rules — enforce server-side, not in the UI

1. **Only a `provider` may author, sign, or revise** a standing order.
2. **Unsigned, expired, or non-active standing orders cannot be executed.** Hard refusal with a reason code.
3. **Versions are immutable.** An order executed under v2 references v2 forever, even after v3 supersedes it. Same discipline as care-plan versions.
4. **Execution cannot exceed the protocol.** Tests come from `permittedTests` by selection. An RN cannot type a test that is not on the list — the endpoint rejects anything not in the set, even if the UI would have prevented it.
5. **`expiresAt` is required.** A standing order with no expiry is refused at creation. Annual review is the norm; the exact interval is an owner/consultant decision recorded in `CLAUDE.md`, not assumed here.
6. **`permittedExecutorRoles` is required and cannot be empty.** The authoring provider names which credentials may act on this protocol.

### The credential ceiling — enforce independently of the protocol

A standing order **grants** authority; it cannot **create** authority a licence does not carry. Enforce a hard ceiling per role, checked separately from `permittedExecutorRoles`:

| Role | May ever execute |
|---|---|
| `rn` | `lab`, `imaging`, `procedure`, `screening` |
| `lcsw` | `screening` only |
| `lmsw` | `screening` only |

So a protocol that lists `lmsw` under `permittedExecutorRoles` and permits a CBC is **refused at execution**, and ideally flagged at authoring. The check is: role ∈ `permittedExecutorRoles` **AND** every requested order type ∈ that role's ceiling. A mis-authored protocol must not be able to authorise out-of-scope work — the provider's signature on a document is not a licence extension.

`screening` covers instrument administration — PHQ-9, GAD-7, SDOH, fall-risk, cognitive screens. It is the order type GFC's LMSW case managers will actually work under.

### Execution

Extend the existing order path rather than adding a parallel one. On `POST .../encounters/:euuid/orders`, accept an optional `standingOrderId`.

When present:

- Caller's `clinicalRole` must appear in `permittedExecutorRoles` **and** every requested order type must be within that role's credential ceiling
- `order.authority = 'standing_order'`
- `order.standingOrder = { id, version, title }`
- **`order.orderingClinician` = the authorizing provider from the standing order** — legally the order is under their authority, not the nurse's
- `order.executedBy` = the acting user (name, credential, userId)
- The existing diagnosis-linkage rule still applies; additionally, at least one linked diagnosis must appear in the standing order's `indications`
- If `requiresCoSign`, the order is created with `coSignStatus: 'pending'` and a due date

When absent: current behaviour, `provider` only, `authority = 'direct'`.

**Every order must be anchored to an encounter.** For between-visit standing-order work where no encounter is open, create a nursing/administrative encounter of a defined type rather than allowing a patient-scoped floating order. An order with no encounter has no clinical context and nothing to bill or audit against.

### Audit

Every execution writes: standing order id **and version**, authorizing provider, executing user and credential, tests, diagnoses, patient. A standing order's whole defensibility is the ability to reconstruct who acted under whose authority, under which version, on what date.

---

## 5. Case managers

**GFC's case managers are LMSW** (owner, 2026-09-13). They get `clinicalRole: 'lmsw'` — not `readOnly`, and not a separate path.

What that means in practice:

- They work under standing orders authored and signed by the FNP or an MD, limited to `screening`-type protocols by the credential ceiling
- They author psychosocial assessments and care plans, and may author a care plan but not complete its signature alone
- Any encounter they document that carries a service code is created `pendingCoSign` and is not billable until an `lcsw` or `provider` co-signs — A10 bills nothing independently
- They never place a direct order, never prescribe, never select an E/M code

An **RN** case manager, if one is hired, gets `clinicalRole: 'rn'` instead.

**Unlicensed staff get `readOnly` and cannot execute standing orders.** If the owner later wants that, it is a licensure decision recorded explicitly in `CLAUDE.md` before it is built — this session's default refuses it.

---

## 6. Acceptance tests

- An `rn` calling the prescriptions endpoint gets 403 with a credential reason
- An `rn` placing a **direct** order gets 403; the same order with a valid `standingOrderId` succeeds
- An `lmsw` executing a `screening` protocol that names `lmsw` succeeds
- An `lmsw` executing a **lab** protocol that (wrongly) names `lmsw` is **refused by the credential ceiling** — this is the test that proves a mis-authored protocol cannot extend a licence
- An `lmsw` encounter carrying a service code is `pendingCoSign` and not billable; an `lcsw` co-sign clears it
- An `lcsw` selecting an E/M code is refused; the behavioural-health set is permitted
- An order executed under a standing order records the **authorizing provider** as ordering clinician and the RN as `executedBy`
- A test not in `permittedTests` is refused even when posted directly to the API
- An expired standing order refuses execution
- Revising a standing order to v3 leaves orders executed under v2 pointing at v2
- An `rn` signing an encounter with a CPT code gets 403; the same RN signing a nursing note with no service code succeeds
- A Track A care plan signed by an RN is complete; an IHPC care plan signed by an RN is **pending provider co-signature**
- Existing `hasClinicalAccess` users migrate to `provider` with no behaviour change, and the boot warning lists them
- `readOnly` case-manager behaviour and its audit line are unchanged

---

## 7. Out of scope

Results review and the clinical inbox (pending co-signs will queue there when it is built — leave the field, not the UI). Drug interaction checking. Behavioral-role permissions beyond the enum scaffold. E-prescribing.

---

## 8. Deployment

Production is AWS and holds real patient records. Nothing deploys automatically:

```
cd /opt/gfc/app
sudo git pull
sudo docker compose up -d --build
```

**Read the boot warning after deploying.** It names every user auto-mapped to `provider`. Reassign the RNs before they next work.

---

## 9. Update `CLAUDE.md` before opening the PR

Record under Recent decisions:
- `clinicalRole` replaces the clinical boolean; certification now gates prescribing, direct ordering, CPT selection and billable-encounter signing
- Roles are `provider` · `rn` · `lcsw` · `lmsw` · `readOnly`. **GFC's case managers are LMSW** (owner, 2026-09-13)
- RNs and LMSW case managers act under signed, versioned, expiring standing orders; the authorizing provider is the ordering clinician of record
- A standing order grants authority but cannot create it: a **credential ceiling** is enforced independently of the protocol, so `lcsw`/`lmsw` can execute `screening` only, regardless of what a protocol names
- LMSW encounters carrying a service code are `pendingCoSign` until an LCSW or provider co-signs — A10 bills nothing independently; A9 LCSW bills the BH set, never E/M
- Care-plan signature branches on service line: RN signs Track A; IHPC requires provider co-signature
- Unlicensed staff are `readOnly` and cannot execute standing orders absent an explicit recorded owner decision
