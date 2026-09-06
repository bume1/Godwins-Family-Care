# OpenEMR patches

Local patches applied to the GFC OpenEMR instance, recorded per Master Setup
Guide v4 Phase 6B: *"Record it: file paths, diff, date, OpenEMR version. A later
image pull silently reverts it, so the monthly routine re-applies and re-tests
the patch after every compose pull."*

| Patch | Base | Date | Status | What it adds |
|---|---|---|---|---|
| `8.4.0-p1` | `openemr/openemr:8.4.0` | 2026-09-06 | Written, not yet installed | Fee-sheet charge write, procedure order write, code search |

## 8.4.0-p1

**Why.** OpenEMR 8.4 still ships no REST route for a fee-sheet charge or for
creating a procedure order, though both exist on its own screens. Without them
the app cannot make a signed encounter land in Billing Manager, which is the
whole point of sign-and-close. The owner's 2026-09-05 decision was to keep write
capability rather than trade it for deep-linking.

**What it touches — two files, one of them new.**

| File | Change |
|---|---|
| `src/RestControllers/GfcChargeRestController.php` | **New file.** Wraps `BillingUtilities::addBilling()` (the exact function the Fee Sheet calls) and the `procedure_order` / `procedure_order_code` inserts the Procedure Order form makes. No billing logic written from scratch. |
| `apis/routes/_rest_routes_standard.inc.php` | Registration lines only: one `require_once`, one `use`, seven route entries. No existing route or controller is modified. |

**Routes added.**

```
POST   /api/patient/{pid}/encounter/{eid}/billing
GET    /api/patient/{pid}/encounter/{eid}/billing
DELETE /api/patient/{pid}/encounter/{eid}/billing/{id}
POST   /api/patient/{pid}/encounter/{eid}/order
GET    /api/patient/{pid}/encounter/{eid}/order
PUT    /api/patient/{pid}/encounter/{eid}/order/{orderId}
GET    /api/codes?type=ICD10&search=…
```

Keyed by **numeric pid and encounter id**, matching `soap_note` and `vital` on
this instance. Uuids are silently coerced to 0 by the standard API — the defect
that orphaned every 4.1 note at patient zero.

**Scope decision, verified in 8.4 source.** These routes introduce **no new
OAuth scope**, so the registered v3 client needs no re-registration:

- Standard `/api/` routes are gated by `RestConfig::request_authorization_check()`
  (an ACL check). `RestConfig::scope_check()` exists but is not called from the
  standard route dispatcher.
- The API scope list is a hardcoded array in
  `ServerScopeListEntity::apiScopes()`. A new scope name would mean editing that
  list *and* registering a fourth client.
- `user/procedure.write` does not exist on 8.4 at all (confirmed against the
  live server's advertised scope list), so the guide's own fallback applies.

The ACL used is `encounters` / `coding_a` — the same one the Fee Sheet and the
diagnosis screens use, which matches the guide's "clinicians get Fee Sheet write,
not financial visibility."

**Safety notes.**

- `addBilling()` calls `die()` when the referenced encounter does not exist,
  which would emit a bare HTML page instead of a response. The controller
  pre-validates the encounter and returns a 400 instead.
- A charge is voided with `activity = 0`, never a hard delete, and a charge that
  is already billed refuses to void.
- `justify` (the diagnosis pointers the X12 generator reads) is written in the
  format `ICD10|E11.9:ICD10|I10:` — verified against `Claim::diagIndexArray()`,
  which splits on `:` then on `|` and strips the type label.

**How it is installed.** As a derived image, `gfc/openemr:8.4.0-p1`, built from
the stock image plus these two files. See `8.4.0-p1/INSTALL.md`. A plain
`docker compose pull` silently reverts the patch, so the monthly routine
(control C-10) rebuilds and re-tests it.

**Upstreaming.** These are gaps other OpenEMR users hit too. Once the patch has
been stable for a month, offer it upstream — that removes the monthly re-apply
(Appendix D).
