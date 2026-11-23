# Orders-only visits, and picking a diagnosis inside the order form (owner, 2026-11-22)

Owner, following up on New Order from the chart (PR #280): "we need to be able to create orders like a standard practice." Two gaps were left: a patient with no fitting visit still had to Start Visit and write a note first, and a diagnosis had to be saved in the visit's coding before an order could link to it. The owner asked for both.

- **An orders-only visit is a flag, not a visit type.**
  - The app's visit record carries `ordersOnly: true` and has no note. It sits over a plain OpenEMR encounter with reason "Orders only", opened for today.
  - A new appointment type would have changed every type count, picker and place-of-service rule. An orders-only visit bills nothing and has no place of its own, so none of those apply.
- **One per patient per Georgia day.** `POST …/patients/:id/encounters/orders-only` returns today's open one if it exists, rather than stacking another.
  - Who may call it: `requireClinicalWrite` plus `canPlaceOrders`, the same people the New Order button shows for.
  - Refusals: not linked (`EMR_NOT_LINKED`), and a lapsed sign-in answers `EMR_NOT_CONNECTED` as itself.
- **One helper opens every app encounter.** `createAppEncounter` holds the facility, place of service, billing entity and coordinator provider rules. The first Save Draft of a note and the orders-only visit both call it, so the two cannot drift. Build-enforced.
- **It never asks to be signed while it has no note.**
  - The clinical inbox skips it as an unsigned note.
  - The open coding queue leaves it out. It still lists under All.
  - Once somebody writes a note on it, it is a visit like any other. The exemption checks "no note".
  - It never reaches the patient portal, since unsigned visits never do.
- **Add To Visit offers "+ New Orders-Only Visit (Today)"** whenever none is open today, beside the drafts and the latest signed visit. With no visit at all, it is the default. "Open Orders-Only Visit" opens it and selects it.
- **A diagnosis picked in the order form is ADDED to a draft visit with the order, never a replacement.**
  - The shared ICD-10 `CodePicker` sits in the order form, and a picked code shows as a "New" chip. Only picked codes still selected are sent, as `addDiagnoses`.
  - The route merges them with `mergeOrderDiagnoses`: appended, deduped, the existing primary kept. On an older record whose codes carry no primary flag, the visit's own first code becomes primary, not the picked one.
  - The coding PUT is deliberately not reused, because it replaces both lists and rewrites the rendering clinician.
  - The diagnosis lands only if the order does. Nothing is added to the OpenEMR problem list.
- **A signed visit takes no new diagnosis** (`ORDER_DX_NOT_SIGNED`). The message points at opening an orders-only visit instead.
- **Inside a visit,** the order form offers the picker only while the visit's coding has no unsaved changes. Otherwise "Save the coding first" stands.
- **Guards repointed, not dropped:**
  - `clinical_roles`: the order-route shape check allows this route by name, because it opens an encounter and places no order.
  - `care_coordinator`: the provider-id rule is checked in the shared helper.
  - `chart_communications`: the note's date rule is checked in its new form.
- **Verified:**
  - `test/orders_only_visit.test.js`: 14 tests.
  - 10 mutations, each confirmed to fail a test or the probe. One survived its first pass; it was the legacy no-primary case, and a test now covers it.
  - `scripts/verify_new_order.js`: 52/52 through the real routes, sections 6 and 7 new.
  - `scripts/verify_referrals_render.js`: 55/55 in Chromium, section F new.
  - Existing probes still pass: referrals 40, orders 92, roles 57, note lifecycle 262. The note probe passing proves the extracted helper did not change Save Draft.
  - Full suite: 4043 passing, 0 failing.
- **Not proven from the sandbox:** OpenEMR accepting an encounter with no note on it (the same create call the note route makes).
- **Open for the owner:** an orders-only visit stays on the chart as an open draft. It can be deleted with Delete encounter once its orders are cancelled. Say if it should close itself some other way.
