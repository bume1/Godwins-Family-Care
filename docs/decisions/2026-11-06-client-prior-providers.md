# A client can edit their own provider list

**Owner, 2026-11-06:** *"Fix all"* — the first of the 21 capabilities
`test/no_orphan_routes.test.js` scoped. Client-facing first, because a patient
cannot ask a colleague why a button is missing.

## The gap

`PUT /api/gfc/prior-providers` has existed since Session 3.4. The notes say
`priorProviders` is *"normalized at intake and **editable independently**;
prefills the ROI form."* **Nothing ever called it.**

The portal's own comment said `priorProviders` was *"owned by the
Transfer-of-Care ROI, which has its own multi-provider editor"* — but that
editor is the **signing** flow. A client could correct a provider's fax only by
signing a release, and could not maintain the list at all. A changed doctor, or
a fax typed wrong at intake, had no client-side fix.

## ⚠️ The trap, which is the whole of this change

`resolvePriorProviders` rebuilds every `intake_prefill` entry from the medical
team on each intake save and preserves only `manual` and `roi_form`. So a row
sent back carrying its original `addedFrom` is **silently discarded the next
time anyone saves intake** — the client's correction disappears with no error.

So the editor sends `addedFrom` **per row, conditionally**:

- a row the client **changed** goes WITHOUT it, and the route stamps `manual`,
  which makes the correction durable;
- a row they **did not touch** keeps its own, so an intake-derived entry still
  follows the medical team as designed.

Sending it for everything makes every edit fragile. Sending it for nothing
freezes entries that should still sync. Whitespace alone is not a change, or a
stray space would quietly stop an entry syncing.

## The rest of the decisions

- **It is not `SelectField`.** That component stores the LABEL as the value,
  and the server coerces an unknown `roleLabel` to `'other'` — the role would
  be silently lost. The role select sends the code; the label is only read.
- **Saving says what it does not do**, twice: it updates the list, it does not
  request records and it does not authorize anything. A provider with a release
  already in force carries its own note that correcting details does not
  re-send it, because that is the reasonable thing to assume otherwise.
- **A nameless row is dropped client-side too.** The server filters it either
  way; dropping it here means the list on screen is the list that was saved,
  and the form says so rather than letting a row vanish.
- **A blank fax does not block saving.** A list entry with no fax is a normal
  state; the fax matters when a release is actually sent, where the existing
  rule already refuses it. A malformed fax is refused before the request.
- **The save reads back what was STORED**, never what was typed, and moves the
  change-detection baseline with it — otherwise the next edit is compared
  against stale values.

## Verification

- **9 tests**, with the change detector **lifted out of the page and run**
  rather than read, because that function is where a lost correction comes from.
- **12 of 12 mutations each confirmed to fail one**: `addedFrom` echoed
  unconditionally (the silent-loss bug), the detector narrowed to the name only,
  a new row treated as unchanged, nameless rows no longer dropped, a blank fax
  blocking the save, the baseline not moved after saving, the role option
  sending the label, each of the two assurances removed, the entry card no
  longer opening the editor, the card losing its label, and the response ignored
  in favour of what was typed.
- **`scripts/verify_prior_providers_render.js` — 19/19 in real Chromium**, and
  it asserts **the request body**, not the screen: the changed row arrives with
  no `addedFrom`, the untouched intake row keeps `intake_prefill`, the untouched
  manual row keeps `manual`, and `roleLabel` travels as the code. That is the
  trap above, proven end to end rather than reasoned about.
- **One probe assertion of mine failed a correct form and was fixed**: it
  matched provider names against `innerText`, and a prefilled field's value is
  not page text. It reads the input values now.
- `scripts/verify_portal_render.js` still passes with zero page errors on every
  audience. Full suite **3069 passing, 0 failing, 1 skipped**. The page's 475k
  JSX block compiles.

## Not built, and why

**`PUT /api/client/service-reports/:id/sign` is NOT a GFC capability and got no
screen.** It belongs to the lab-era Service Portal workflow — `technicianName`,
`clientFacilityName`, a HubSpot PDF upload, created behind
`requireServiceAccess`, which CLAUDE.md records as the retired lab surface.
GFC's equivalent is the caregiver visit log, already built. Building a
signature pad for it would be building a screen for a workflow GFC does not
run. It should move to the allow-list as lab-era, alongside the HubSpot block.
