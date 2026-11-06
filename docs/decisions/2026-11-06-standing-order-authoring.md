# A provider can author a standing order

**Owner, 2026-11-06:** *"Fix all."* This is the one that was not a missing
button — it was a dead feature.

## What was wrong

Session 4.8 built the mechanism that lets an **RN, LCSW or LMSW place an order
under a provider's standing authority**, with a credential ceiling so a
mis-authored protocol cannot authorise out-of-scope work. Five routes serve it.
**Four had no caller at all:**

| Route | Had a screen? |
|---|---|
| `GET /api/clinical/standing-orders?executable=true` | yes — fills the order and screening pickers |
| `POST /api/clinical/standing-orders` | **no** |
| `GET /api/clinical/standing-orders/:id` | **no** |
| `POST /api/clinical/standing-orders/:id/revise` | **no** |
| `POST /api/clinical/standing-orders/:id/status` | **no** |

So **nobody could write a protocol**, and the whole mechanism rests on one
existing. It has never been usable. An RN could be handed the capability and
find no protocol to act under; a provider could not create one, could not
retire an expired one, and could not revise one.

## Why the orphan-route guard missed it

`routeCallers` compares **paths, not methods**. The page calls
`GET /api/clinical/standing-orders?executable=true`, so the POST at the same
path read as wired. Recorded in `METHOD_LEVEL_GAPS` in
`test/no_orphan_routes.test.js` (PR #250), where it was found.

## The screen

A **Protocols** view in the clinical workspace: list, detail with version
lineage, authoring form, revise, activate, retire.

- **Visible to anyone with clinical read.** An RN wants to know which protocols
  exist and what they permit. Every WRITE control is drawn from the **served**
  `canAuthor`, computed from the same capability the route enforces, so the page
  decides no credential question itself. Someone who cannot author is **told
  why, in the server's own words**, rather than left hunting for a button.
- **Every option is served** — order types, executor roles, role labels,
  patient scopes. `buildStandingOrder` silently *drops* anything outside its own
  lists, so an option invented in the page would read as accepted and
  authorise nothing. The form names none of them.
- **A revision starts from the version it supersedes.** Retyping a protocol to
  change its expiry is how a test goes missing from the permitted list with
  nobody noticing. The form says plainly that saving creates version n+1 and
  retires the current one, because that is not obvious from a button marked
  Revise.
- **Retire, never delete.** An order executed under v2 references v2 forever.
  There is no delete control and a test asserts there is not.
- **An expired protocol is told to revise, not activate** — the server refuses
  activating an expired one (`STANDING_ORDER_EXPIRED`), so offering the button
  would hand out a refusal.
- **Activating unsigned is refused before the request**, with the thing they
  can do instead ("save it as a draft"). The server refuses it too; the client
  check is a courtesy, not the control.
- **A signature is kept on a draft**, so activating later does not mean signing
  again.
- **A provider is not an executor option**, because a provider needs no
  protocol, and the form says so. It also says that naming a role cannot widen
  that role's own licence ceiling.
- Blank lines in the tests and indications boxes are dropped before sending —
  the server refuses an empty list by name, so sending blanks would surface as
  a confusing refusal rather than a dropped row.

## Verification

- **10 tests, 12 of 12 mutations each confirmed to fail one**: the view never
  rendered, the nav entry removed, the create helper never called (the original
  defect), the page deciding the credential itself, order types hardcoded,
  unsigned activation allowed through, a revision starting blank, the revision
  warning removed, a delete control added, the expired explanation removed,
  blank list entries sent, and the server ceasing to serve the vocabulary.
- **`scripts/verify_protocols_render.js` — 38/38 in real Chromium**, run twice:
  once as a provider and once as an RN, so the capability gating is proven in
  both directions rather than asserted once. It also checks **the request body**:
  the order type and executor role travel as codes not labels, blank test lines
  are dropped, indications are split and trimmed, and an unsigned draft sends
  no signature key.
- **Three of my own probe mistakes, each fixed rather than worked around.**
  (1) It set `unified_token`, but the page reads `admin_token` and
  `admin_user` — so it was asserting against the LOGIN screen, and one
  assertion passed vacuously. (2) It located the chip buttons by accessible
  name; `.chip` renders uppercase and CSS text-transform changes that name.
  (3) It clicked "Protocols" to go back and hit the SIDEBAR item of the same
  name. Each would have left a green probe proving nothing.
- esbuild compiles the page's 678k JSX block — which proves the JSX parses and
  **not** that `Field`, `fmtDate`, `fmtTs`, `SignaturePad` and `AccessContext`
  all resolve. Five identifiers from four places; only the browser shows that.
- Full suite **3070 passing, 0 failing, 1 skipped**.

## Merge-order note

`METHOD_LEVEL_GAPS` in PR #250 says a provider cannot author a standing order.
Once **both** PRs are on main that sentence is out of date — the entry should be
removed. #250's own tests will not catch it: they assert the route still exists
and that its PATH reads as called, both of which stay true. This is written here
because nothing else will say it.

## Not proven from this sandbox

A protocol written, signed, activated and then EXECUTED end to end. Executing
one resolves an OpenEMR patient and files a `procedure_order`, and no EMR is
reachable from here. The authoring half is proven; the execution half rests on
Session 4.8's own tests, which were written when nothing could reach it.
