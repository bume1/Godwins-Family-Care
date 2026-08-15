# Drift Report — Session 3.5 Reconciliation
_Audit date: 2026-08-15 · per `docs/GFC_Session3.5_ClaudeCode_Prompt.md`_

Method: booted the app against a local KV harness, created fresh test users for every role
(client `intake_pending`, client `enrolled` with **zero** data, family unlinked/linked, admin),
walked every view in a real browser at 393px and 1280px, and grepped the codebase for
fixture markers, static arrays, and canned endpoint JSON. Both service-line branches
(PHC / IHPC / both) were exercised through the intake path step.

Severity: **FIX-NOW** = mechanical, fixed in this PR. **DECISION** = needs Bianca.
**NOTE** = intentional per an existing decision, recorded for completeness.

---

## 1. Fixture data (prototype content rendered as live data)

| # | View / endpoint | Issue | Severity | Status |
|---|---|---|---|---|
| F1 | `GET /api/gfc/care-plan` → portal Home + Care Plan | `buildGfcTestData` (server.js) returned a prototype **sample care plan** — "Joelle T., LPN-track", "Bethel N., FNP", "Courtney W.", garden-walk goals, Mon/Wed/Fri schedule — for every enrolled client with no real `client.carePlan`. A fresh client with zero data saw a fully-populated plan. | FIX-NOW | ✅ FIXED — endpoint now returns only the client's real `carePlan` (or `null`); portal renders a branded "being prepared" empty state; care team resolves from the client's own `careTeam` record |
| F2 | `GET /api/gfc/care-plan` + `/api/gfc/visits` → Home, Care Plan | Fixture visits ("Today 2:00 PM · Joelle T.", "Adaeze R." etc.) rendered as the client's schedule. | FIX-NOW | ✅ FIXED — visits now read from the `visit_logs` KV collection scoped to the client (empty until scheduling/visit sessions write them); branded "No visits scheduled yet" empty states |
| F3 | `GET /api/gfc/messages` → Messages | Known 3.1 fixture stub: three canned threads ("grip socks", "Welcome…") with a fake unread badge on the Home tile. | FIX-NOW | ✅ FIXED — real `gfc_messages` KV store scoped to the logged-in client; basic client→admin send persists (`POST /api/gfc/messages`); family stays read-only; branded empty state |
| F4 | Care Plan → co-signature pad | The drawn-signature co-sign pad rendered against the **sample** plan (v0 sentinel) — a client could legally sign a document containing prototype content. | FIX-NOW | ✅ FIXED — co-sign UI renders only when a real plan exists; the cosign route refuses the v0 sentinel (`NO_CARE_PLAN`) |
| F5 | Home dashboard hero | "Joelle arrives at 2:00 PM" subtitle + caregiver avatar derived from fixture plan. | FIX-NOW | ✅ FIXED — derives from real primary caregiver + next real visit; neutral copy otherwise |
| — | `GET /api/gfc/documents` | Audited: already real (consents from the client record, `client_documents`, enrollment packet). No fixture content. | — | no change needed |

## 2. Dead or decorative UI

| # | View | Issue | Severity | Status |
|---|---|---|---|---|
| D1 | Admin Hub sidebar | "Implementations" external-app entry opens the **deactivated** launch tracker (redirects to /login). Strip-list decision §7 (2026-06-10) said hide this nav entry. | FIX-NOW | ✅ FIXED — entry removed (tracker code retained per decision) |
| D2 | Client-portal admin dashboard | "Launch App" quick action → `/launch` → redirect to /login. | FIX-NOW | ✅ FIXED — removed |
| D3 | Care Plan → "Request a visit" button | Fires a JS `alert()` ("opens in a later session"). | FIX-NOW | ✅ FIXED — replaced with a disabled, labeled "Visit requests — coming with scheduling" affordance (no fake interactivity) |
| — | Gate "Monitoring" locked chip | Monitoring is an explicit Coming-Soon scaffold per spec (Track C). | NOTE | intentional, no change |
| — | `public/client.html` (+ `app.js` tracker code, lab phase names in portal.html/client.html) | Legacy Thrive365 launch-tracker assets still served statically, but all routes to them are deactivated (redirect to /login) and no GFC view links to them. Retained intentionally per strip-list §7 for future repurposing. | NOTE | intentional, no change |

## 3. Responsive gaps (>=1024px)

| # | View | Issue | Severity | Status |
|---|---|---|---|---|
| R1 | Client portal (all unlocked views) | At 1280px the portal rendered as a fixed 480px mobile column with bottom tab bar — no desktop layout. | FIX-NOW | ✅ FIXED — at ≥1024px the portal uses a persistent left side-nav (same four destinations), a wide shell with max-width container, two-column content grids where the prototype implies them, readable line lengths; brand tokens unchanged; 393px mobile behavior unchanged |
| R2 | Gate / intake / ROI flows | Same 480px column at desktop. | FIX-NOW | ✅ FIXED — centered container widens (querying ≥1024px) for comfortable desktop form entry; two-column field grids preserved; mobile unchanged |
| R3 | Admin Hub, Client-portal admin, Service Portal, Portal Hub | Verified desktop-first with working mobile hamburger patterns. No mobile-only artifacts found. | — | no change needed |

## 4. Spec mismatches

| # | Area | Issue | Severity | Status |
|---|---|---|---|---|
| S1 | Family → client linkage | v2 §5.2: family portal unlocks on ROI-family. The API gate works, but the admin UI has **no way to link a family user to their client**: the "Assigned Clients" picker is vendor-only and stores client *names*, while the family gate resolves `familyOfClientId` / `assignedClients[0]` against user *ids* — so a family login could never be linked from the UI. | FIX-NOW | ✅ FIXED — user form now shows a "Linked client" selector for the Family role, stored as `familyOfClientId` (client id) |
| S2 | Co-sign against sample version | Care-plan cosign accepted the v0 sample sentinel as a signable version. | FIX-NOW | ✅ FIXED (see F4) |
| S3 | Care-tier label default | Care-plan endpoint defaulted a client with **no** careTier to "A2 · Comprehensive ADL & IADL". | FIX-NOW | ✅ FIXED — tier renders only when actually set on the client record |
| — | Staff enrollment view | The 3.5 prompt references "enrollment view from 3.3" — Session 3.3 is not yet built (prompt-ready only), so there is nothing to audit. | NOTE | out of scope until 3.3 |

## 5. DECISION items for Bianca

Short answers only — nothing blocks Session 4.

1. **Banner photography.** `public/banners/banner-{admin,client,service}.jpg` are still the lab photos (shelving, test tubes, analyzers) and show at the top of the Admin Hub, admin portal view, Portal Hub, and Service Portal. Replacing them needs care-appropriate imagery from you — want to supply photos, or should the banners be swapped to flat brand-navy gradients until you have them?
2. **Client→admin messages, staff side.** Client-sent messages now persist to the `gfc_messages` store, but no staff view reads them until the Session 9 messaging module. Until then, is "admin sees them in the KV store only" acceptable, or do you want a minimal admin-hub inbox tile ahead of Session 9?
3. **`hasImplementationsAccess` flag.** The user-form checkbox for the deactivated tracker still exists (harmless; tracker is retained for repurposing). Keep the checkbox, or hide it until the tracker is repurposed?

## 6. Acceptance verification (this PR)

- Grep for prototype sample names (`Joelle`, `Bethel N.`, `Courtney W.`, `Adaeze`, `Margaret`) in production views/server: **0 hits** outside `docs/prototype/`.
- Fresh enrolled test client with no data: branded empty states on Home, Care Plan, Messages, Documents — no sample content.
- Test client with seeded care plan, visits, and messages sees **their** data on every view.
- Client portal renders desktop layout at 1280px (side nav, no bottom tabs) and the unchanged mobile layout at 393px; zero console errors on every view at both widths.
- 3.1–3.4 behaviors re-verified: gate (client + family), intake flow, consents, care-plan co-sign version guard, transfer-ROI flow, documents/packet.
- `npm test` — all unit tests pass.

_Environment note (harness, not app drift): the portal pages load React/Tailwind/Babel/fonts from public CDNs; these are unreachable from the CI-style sandbox and were served locally for browser verification. Worth revisiting before HIPAA-live (vendored assets = fewer third-party runtime dependencies), but that is a Session 5 hardening item, not 3.5 scope._
