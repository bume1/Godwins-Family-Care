# The email library: every notice's wording, editable in place (owner-directed, 2026-11-09)

Owner: *"please update our email template library in-full so we can easily edit ANY email"*, then *"we need to address all the emails and have an easily editable template area."* Asked how much control they wanted, they chose **all copy editable in-app**, with live data as named placeholders and the built-in wording as the fallback. Scope is email; the Quo text channel was explicitly left out.

## What was there

The Templates screen in the Admin hub held **8 rows, and 6 were retired Thrive365 Labs code**: service reports, analyzer installs, go-live reminders, with `thrive365labs.live` example links. Only `welcome_email` and `announcement` drove a real GFC email. Six further template ids were referenced by the sending code with no stored default at all, so the scanner skipped them in silence (`server.js:1500`). Its variable pools were lab vocabulary throughout: technicians, reagent kits, completion percentages.

Meanwhile the app sends roughly **70 distinct emails**, and the wording of the other ~68 was a string literal inside a JavaScript file.

## The one design decision everything follows from

**The editable unit is the pieces the house template already takes** (subject, headline, an ordered list of paragraphs, a callout and its label, the button label) and **never HTML**.

That is not a simplification, it is what keeps three guarantees free:

1. `emailTemplates.renderGfcEmail` escapes every value it is handed, in both halves, so an admin's wording cannot inject markup. Proven by rendering a real email with `<script>` in a value and reading both halves back, not by reading the validator.
2. The house chrome stays in `emailTemplates.js`, the only file in the repo allowed to contain email markup. `test/email_branding.test.js` **discovers** senders rather than listing them, so that rule already covers files that did not exist when it was written.
3. `safeUrl()` still owns every link.

The old store held a `body` and an `htmlBody`, and that shape is exactly what let five emails opt out of the house style. If the ask ever becomes "let me paste the email in", the answer is the per-paragraph editor.

## How it is put together

- **`emailCopy.js`** is pure: no database, no markup, no require of the template. It holds the built-in wording, the declared placeholders and every rule. `resolve()` is synchronous, which is what will let the ~40 call sites that bypass the notifier use it later without inheriting the notifier's dependencies.
- **Defaults live in code, overrides live in a sparse store.** `email_copy_overrides` holds only the fields somebody changed, so "reset to the built-in" is a **delete** and no built-in is ever copied anywhere it can rot. That is the opposite of the lab library, which seeded its defaults into the store and then drifted from the code that sent them.
- **An override is applied field by field** over the built-in, so an admin who changed only the subject keeps every later improvement to the body.
- **A broken override falls back to the built-in for the WHOLE variant**, never field by field. A subject and a body from two different generations of the wording is worse than either alone.
- **`copyId` is deliberately not the notification `type`.** Three cases in this app prove they cannot be one thing: one builder sends `phc_document_accepted` and `phc_document_rejected` with different copy; `visitReminder` and `videoReminder` both send `visit_reminder` with different wording; `shift_assigned` goes out from three places with three different sentences. `type` owns dedupe and the cooldown. `copyId` owns wording.
- **One choke point.** `send()` in `notifications.js` resolves the copy and then renders exactly as before, so migrating a notice is a matter of handing it a `copyId` and its values.
- **The overrides are read through a 30-second cache**, because `send()` runs once per recipient and a notice to the whole office would otherwise read the store once per person.

## The rules that must not be undone

- **A placeholder can be declared PHI-bearing, and the brief wording cannot use one.** Refused on save with a message saying *why* ("this is the wording that sends when our email is not covered by a BAA"), and refused again at send time if one is stored anyway. This is the most important rule in the feature and it is cheap, because the registry already knows which notices have two wordings.
- **The destination is not editable.** The button's label is; its URL is not, because `appLinks.js` owns destinations and a link edited into an email is the `/admin-hub` 404 in prose. The editor shows the destination as read-only text beside the label, so wording and destination are seen together.
- **Recipients are not editable, and the schema has no field for them.** A smuggled `recipients` or `ctaUrl` is refused by name.
- **Nothing is refused silently.** An unknown field, a misspelt placeholder, markup, a too-long field: each names the problem and lists what is valid instead. A silent drop is how somebody types a correction, sees "saved", and finds the old wording still going out.
- **Preview and test send take the draft and write nothing.** The old template screen **saved before previewing**, so half-finished wording went live and then sent. That is fixed, and the probe proves the store is untouched by a preview.
- **Preview goes through the same `resolve` and the same renderer as a real send**, so it cannot disagree with what arrives.
- **The audit records which fields changed, never the words.** An audit trail of email copy would be a second copy of whatever was typed into it.

## One real leak the registry sweep found

The sweep "no vague wording uses a PHI placeholder" failed on first run, on code nobody had touched: the **vague wording of both client document notices named the patient**. A POA on a transport outside the BAA received *"A document for Ada Bell was received and accepted"*, and *"One of the documents for Ada Bell needs to be sent again."* That is precisely what the appointment notices avoid, and it had been live since those notices were written. The name is gone from both; a POA with several patients signs in to see which one.

Found by a sweep over the whole registry, not by reading, which is the argument for having the sweep at all.

## Migration state, written down rather than guessed at

**10 notices are editable now**, covering the clinical visit notices, both client document notices, a returned caregiver document, a cancelled shift, a waiting password reset, a reported problem and a submitted welcome packet.

The rest keep their literals and are listed in `NOT_YET_EDITABLE` in `test/email_copy.test.js`, **with the list checked for rot in both directions**: a type that is neither editable nor on the list fails the build, and an entry that *has become* editable has to come off. That guard was written before the registry was populated, because it is the one thing that stops the new library repeating the old one's exact failure of six dead rows and six ids skipped in silence.

A notice that keeps its literals simply does not appear on the editing screen, which is honest. A half-migrated registry row would be a screen that does nothing.

## Verified

- `test/email_copy.test.js`: **25 tests, 13 of 13 mutations caught.** Four of them are sweeps over the whole registry, discovered rather than listed: every placeholder used is declared, every declared placeholder is used, no vague wording carries PHI, and every registry id is reachable from a real call site.
- **The migration is behaviour-preserving and the existing tests are the proof.** `test/notifications.test.js` already asserted the exact subject and every paragraph of each notice in both wordings, so it was the regression harness: full suite **3664, 0 failing**, with no assertion changed to accommodate the move.
- `scripts/verify_email_library.js`: **29 passed, 0 failed** over real HTTP, including the one that matters. An edit saved on the screen is read back out of the notification queue as the subject and body that would be delivered, still in the house template. Every refusal is followed by a read of the store to prove nothing was written.
- Two of my own guards were wrong on first run and both are recorded rather than quietly fixed. A test put the markup in a value the body does not render, so it proved nothing about escaping. And the staleness check read notice types as literals, which reported the four composed `account_*` types as gone; that was a false positive in my guard, not a stale list.
- The POA attribution is proven against a **reworded** sentence, which is the point of replacing the regex: the old mechanism matched the opening words and would have stopped working silently the first time an admin moved them.

## Open for the owner

1. **Volume of the library.** Ten notices are editable. The remaining notices in `notifications.js` are a mechanical migration of the same shape and are next; the ~40 call sites in `routes/scheduling.js`, `routes/payroll.js` and `server.js` that build their own strings come after that, and need the notification queue to learn the structured shape first.
2. **⚠️ The one real risk this feature adds is a policy risk, not a technical one.** The PHI refusal catches the obvious leak. It cannot catch somebody writing "your HIV test result is ready" with no placeholder at all, in the brief wording that sends on an uncovered transport. The Brief editor carries a visible notice saying what that wording is for, and every edit is logged with which fields changed. Worth saying plainly rather than burying.
3. **Security and legally load-bearing emails are editable, with a warning**, because the ask was any email. That covers password-changed, the ROI receipts and the consent receipt once they are migrated. Say the word and I will lock them instead.
4. **The lab-era store is still there**, under the library on the same screen. Retiring it means deleting 6 dead rows, 6 phantom ids, the lab variable pools and `renderTemplate`, plus a store migration. Two libraries side by side is acceptable staging and a bad end state.
5. **Texts will diverge.** Once a visit reminder's email is edited, the matching Quo text keeps the old wording. Out of scope by choice; worth a later pass.
