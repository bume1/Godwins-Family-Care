# Announcements get the clinical note's formatting, and one place to post them (owner-directed, 2026-11-15)

Owner: *"please ensure announcements use the same rich text ability as the clinical notes segment of app. bolded, italcizied, indention etc"* — and, asked which of the two boards: *"both, first lets move client announcements into myGFC so we can share announcements with internal team as we can and then a section to send announcements to clients"*, with the formatting required on screen **and in email**.

Two answers settled the shape: **admins only** post to clients, and **the six clinical shapes suffice**, so `note-format.js` is reused untouched and the medical-record path is not disturbed.

## ⚠️ A correction about my own previous change

Last session I reported three fixes to the client announcement board. **Two landed in dead code.** `ClientPortalPage` in `public/admin-hub.html` appears once in that file — its own declaration — and nothing renders it. The renamed heading, the sentence saying it emails every client, and the "emailed N of M" line were all on a screen nobody could open. The live composer was `AdminAnnouncementsPage` in `public/portal.html`.

What did land was the server-side count fix, which was proven over HTTP at the time. Both orphaned lines are ported onto the live screen by this change, so the work finally arrives.

The lesson is this session's own: I compiled the page and never asked whether the component was reachable. **The probe now checks that the editor is mounted on the real page, not merely defined.**

## The editor is one copy

`FormattedField` lived inside `public/clinical.html`, so a second screen meant a second copy. It is now `public/components/formatted-field.jsx`, holding the editor, the read-only `FormattedView`, and the CSS the six shapes need because Tailwind's reset strips list markers and heading sizes.

Behaviour-preserving by construction: the JSX is the clinical version unchanged, and `requiredNote` defaults to the clinical wording so none of the nine call sites in the workspace needed touching. `claim-shared.jsx` now reads the one `FormattedView` rather than declaring a second copy, and `billing.html` loads the new file before it — a load-order mistake there is an undefined read at render, not a test failure, so every consumer's order is checked.

`test/react_input_focus.test.js` gained this file **and learned about `contentEditable`**, which it could not see before. That matters most here: a remount re-runs the load effect and rewrites `innerHTML` mid-typing, so the caret dies. Proven load-bearing — with the original pattern the nesting mutation is missed; with the widened one it is caught.

## The email

`emailTemplates.js` could not render this markup: its own escaper, no parser, so asterisks would have arrived as asterisks. It now walks `noteFormat.renderTree` with a local `treeToEmailHtml` that escapes every text node and emits **inline** styles, because a mail client loads no stylesheet and Outlook mangles a list with no explicit padding. The text half goes through `toPlainText` — the same converter that writes a note into OpenEMR — so a text-only client reads capitals and `• ` rather than markers. All email markup stays in the one file allowed to hold it.

## The rule that protects what came before

An older announcement is plain text that may contain `_`, `*` or `- `, and formatting it would rewrite what somebody posted. So markup is **opt-in by an exact flag**, the messaging precedent verbatim (`=== 'markup' ? 'markup' : 'plain'`), and a body without it never touches the formatter. Both boards share the one `bodyFormatOf`, so they cannot drift.

The proof is that the tests pinning the 2026-11-10 plain reading stayed green with **no assertion changed**. The source-pin on `buildQueuedEmail` also still matches, because the markup arm was added beside that line rather than editing it.

A fallback matters too: if the component fails to load, the composer degrades to a plain box, and `WRITES_MARKUP` ensures that box's text is stored as plain rather than claimed as markup.

## One place to post

My GFC → Announcements is now one screen with two sections, each stating who it reaches: **the team** (`/api/caregiver/broadcasts`) and **clients** (`/api/announcements`). The existing routes are reused — a third announcement store is how two screens start disagreeing about what was posted. The portal's old admin screen is a pointer, so a bookmark still lands somewhere that explains where it went.

**⚠️ The two gates are different taxonomies and the UI must not drift from the server.** `profile.isAdmin` is the admin *team* (admin, manager, coordinator); `requireClientPortalAdmin` is the Super Admin alone. A manager shown the client composer would be refused on submit, so `/api/my/profile` now carries a separate `canPostToClients` and the section reads that. Admin-only is what the route already did, so nobody loses access.

**⚠️ The client email stopped rendering its own HTML.** It built `htmlBody` eagerly, and `buildQueuedEmail` short-circuits on `if (t.htmlBody) return` — so a client announcement never reached the house template's own reading and never saw a `format` at all. The pieces go to the queue now and the drain renders them. That is what lets a formatted client announcement arrive formatted, and it closes the last email that could opt out of the house style with hand-written HTML. The dead `annHtml` plumbing is removed, and **the template screen now says the HTML box is not used** rather than ignoring it silently.

## ⚠️ A guard of mine had been vacuous since my own last change

`test/email_branding.test.js`'s announcement test sliced from the send site to `if (result) queued++`. **I changed that line on 2026-11-10**, so `indexOf` returned −1, the slice ran to the end of the file — **1.4 million characters instead of about 1,500** — and every assertion in it passed on strings found elsewhere in `server.js`. It stayed green and guarded nothing.

Repointed, with the fix aimed at the class rather than the instance: **both anchors must exist and the slice is size-checked**, so a stale anchor fails loudly instead of going quiet. Mutation-checked — reintroducing the stale anchor now fails the test.

*A bounded scan is a guard that works on the code it was written against* — the fourth time in this repo, and this time I broke it myself.

## Verified

- `test/announcement_formatting.test.js` — **18 tests, 11 of 11 mutations caught**, including the allow-list widened to anything truthy, the escaper disabled, lists losing their inline styles, the text half sending raw markup, the Feed payload dropping the format, and the fallback box claiming markup.
- `test/email_branding.test.js` repointed — **3 of 3 mutations caught**, among them the stale anchor.
- **Two of my own tests passed for the wrong reason first and are recorded rather than quietly fixed:** they searched the *whole* email for `<img>` and `<strong>`, which the house chrome carries in its wordmark and signature. They read the body now, through a helper that asserts it found one. A third scanned a comment that explains why no `htmlBody` is sent — comments are stripped before that scan.
- **A mutation of mine was a HARNESS ERROR, not a catch:** nesting the component without re-indenting its body ends the guard's body-walk on the first line, which is not what real nesting looks like.
- `scripts/verify_client_announcements.js` *(new)* — **16/16 over real HTTP.** This board had **no tests of any kind** before: nothing in `test/` would have failed if its four routes were renamed or deleted. It reads back what would be **delivered**, asserts its own preconditions, and aborts rather than report a vacuous pass.
- `scripts/verify_announcements_render.js` — **13/13 in Chromium**, now typing into the real editor, clicking the real Bold button, and asserting the browser posts `**Shifts change**` as markup, plus that the editor's stylesheet travels with it now the CSS has left `clinical.html`.
- `scripts/verify_soap_note_render.js` **23/23** and `scripts/verify_portal_render.js` clean across every audience, with no page errors.
- Full suite **3865, 0 failing** (1 skipped, pre-existing).

## Open for the owner

1. **A stored custom HTML body for the announcement template is now ignored.** Nothing ships one by default and the migration cleared the legacy chrome, so in practice this is likely empty — but if you had written one, say so and I will find another way to honour it.
2. **Two findings in the board that moved, neither caused by this change.** `GET /api/announcements` has no admin gate and `family` falls into its sees-everything branch, so a family login reads announcements aimed at specific other clients. And `GET /api/client-portal/data` returns ten announcements with no targeting filter at all — nothing reads that property today, so it is invisible, but the unfiltered list is on the wire.
3. **Editing a client announcement still sends no email**, and neither editing nor deleting one writes an activity log entry.
4. **`accountTypes.js` still points the `clientPortalAdmin` tile at `/portal`.** With the composer moved, that tile's destination is stale; it is a lab-era locked module and worth retiring rather than repointing.
5. **A second three-line `FormattedView` no longer exists**, but `public/caregiver.html` still has its own hand-rolled `**bold**`-only renderer for attestation bodies. Not touched here; it is a candidate for the shared one.
