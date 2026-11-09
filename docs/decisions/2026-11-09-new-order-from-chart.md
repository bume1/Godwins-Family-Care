# New Order from the chart's Orders tab, and orders on a signed visit (owner, 2026-11-09)

Owner: "orders capability is broken? can't access from the orders area as in create new ones. Let's make this orders process more robust," then "we need to be able to create orders like a standard practice."

Nothing was crashing. The chart's Orders tab and its filters were built read-only, and the only way to place an order was Encounters → open an **unsigned** visit → Orders & Rx → + Record Order. Once a patient's visits were all signed, there was no way to place an order at all.

- **+ New Order sits on the Orders tab.** The same button appears on every filter: All, Labs, Equipment, and Imaging (preset to imaging). On Referrals it reads + New Referral and opens on a referral.
  - It reuses the same `OrderForm` and the same route. No new route was added: an order is still anchored to a visit, and `test/clinical_roles.test.js` still holds.
- **The panel picks the visit (Add To Visit).**
  - Open drafts come first, newest first, then the single most recent signed visit.
  - The newest draft is the default.
  - A deleted visit and an older signed visit are never offered.
  - With no visit at all, the panel says to use Start Visit.
- **The server answers which visits are offered, and whether this viewer may place anything at all.** This is `placement` on `GET …/patients/:id/orders`, built from the app's own records with no OpenEMR read. A view-only viewer gets no button.
- **An order on a signed visit (owner rule).**
  - The page must ask for it: `afterSigning: true`. Without that, a signed visit still answers `ENCOUNTER_CLOSED`.
  - It only works on the latest signed visit (`ORDER_AFTER_SIGNING_NOT_LATEST` otherwise).
  - It can only link the diagnoses that visit was signed with (`ORDER_DX_NOT_SIGNED` otherwise).
  - It writes an **addendum** to the note: what was ordered, the linked dx and the order reference. The order carries `afterSigning.addendumId`, and the list shows an "Added After Signing" chip.
  - **The addendum never carries the clinical summary, the reason or the notes**, because addenda republish to the patient portal.
  - Coding, prescriptions and the claim are untouched. Orders are not charges.
- **There is one addendum writer.** `recordEncounterAddendum` handles the row, the structured note, the re-filed signed-note PDF, the portal republish and the activity log. The Addendum button and an order added after signing both call it.
  - The only other writer is the billable clinician addendum (co-sign), which has its own billing steps. That is build-enforced.
- **One submit is one order.** Each form makes a key when it opens and sends it with every save from that form.
  - The server scopes the key to the person and the visit. A repeat returns the first order marked `duplicate`.
  - A second click while the first save is still running gets `ORDER_IN_FLIGHT`.
  - The key is stored on the order and never sent to a browser.
  - The in-flight guard covers one server process. The stored key covers everything after the first save lands.
- **Failures say what they are.**
  - A lapsed OpenEMR sign-in now answers `EMR_NOT_CONNECTED` (409) on every encounter route. Before, an order fell through to a bare 502 "Order save failed".
  - A missing patient answers `CLIENT_NOT_FOUND`; a patient not on the clinical line answers `NOT_CLINICAL_LINE`.
  - Anything else answers `ORDER_SAVE_FAILED`.
- **Unsaved diagnoses.** The visit's own order form now offers only the **saved** diagnoses. While coding is unsaved it says "Save the coding first." Before, it offered unsaved codes the server then refused. The form's linked codes also follow the list when it changes.
- **Verified:**
  - `test/orders_after_signing.test.js`: 19 tests.
  - 14 mutations, each confirmed to fail a test or the probe. One check is a recorded no-op: the clinical-write test in `canPlaceOrders` changes no result for any current role, and is kept to mirror the route's gate.
  - `scripts/verify_new_order.js`: 35/35 through the real routes, including a double click landing while the first save runs.
  - `scripts/verify_referrals_render.js` section E: 46/46 in Chromium.
  - The referrals, orders, roles and note probes still pass (40, 92, 57, 262).
  - `patient_publish` 5b was repointed at the shared writer, not dropped.
  - Full suite 3465, 0 failing.
- **Not proven from the sandbox:** a real OpenEMR accepting the order's `procedure_order` copy. That copy is unchanged and still soft-fails with a warning.
- **Open for the owner:**
  1. A patient with **no visit at all** still needs Start Visit first. A standard EHR would open an "orders only" visit automatically. Say if you want that; it creates an OpenEMR encounter, so it needs the clinician's OpenEMR sign-in.
  2. On a draft visit, a diagnosis is still added through the visit's coding, not inside the order form. Picking a new diagnosis right in the order form is a possible next step.
