# One family login for several patients, POA per patient, and moving shared logins to the POA

Owner, 2026-10-20: "patients with spouses or family members who handle the patient's healthcare can access their portal as the patient … some patients may need to be added with the same POA email." And: "currently, POAs have been signing in as the patient." And: "make sure all notifications work correctly with this change too."

## The problem

- POAs had been signing in **with the patient's own account**. So every consent signature, care-plan co-sign and message they made is recorded as the **patient's**, skipping the "<POA> as POA for <patient>" path the app already has.
- A family account named **one** patient (`familyOfClientId`), so a daughter who is POA for both parents could not cover both with one login. That is what "same email" was reaching for.
- **Duplicate emails were NOT allowed, on purpose.** Sign-in and forgot-password find a person by email and take the first match, so a second account on the same address could never sign in.

## What was decided

- **`familyLinks` on the family user:** `[{ clientId, isPoa, relationship, addedAt, addedBy, via }]`. **POA is per patient** — POA for Mom does not make anyone POA for Dad. `familyLinks.js` is the one pure module; `applyLinks` is the only writer.
- **The old `familyOfClientId` / `familyIsPoa` fields stay as mirrors of the FIRST link** for older scripts. **Never use them for access in a background reader** (an email, a text, a recipient list): ask `familyLinks.familyFor(users, clientId)` / `isPoaFor(user, clientId)`. Build-enforced in `test/family_links.test.js`.
- **The patient in use is chosen per sign-in and kept on the session row** (`sessionStore.setActiveClient`). `authenticateToken` copies that link onto `req.user.familyOfClientId` / `familyIsPoa`, so every request-scoped reader (the gate, patient reads, audit, messaging, scheduling) works unchanged.
  - One link → that patient. Several and none chosen → `needsClientChoice`; gated routes answer **403 `CLIENT_CHOICE_REQUIRED`** (a permission code, never an `AUTH_` one, so nobody is signed out).
  - A removed patient is never honoured; the person falls back to the picker, or to their only remaining patient.
  - The portal sends **`X-GFC-Client`** on every call. If another tab switched patient, the server answers **409 `ACTIVE_CLIENT_CHANGED`** and the page reloads instead of reading or writing the wrong record.
- **A patient with no email:** the Add User form has a "No email" tick for a client. The server makes `client+<id>@placeholder.local` with a random password and sends no welcome email, the same as offline onboarding.
- **Email uniqueness is case-blind on create AND edit.** The user edit route had no uniqueness check at all — an admin could save a second account onto an address in use. Fixed (409 `EMAIL_IN_USE`, checked before anything is written).
- **Moving a shared login to the POA** — `POST /api/gfc/admin/clients/:clientId/poa-cutover`, Super Admin only, the admin types the patient's name to confirm.
  - `move`: a new family account (or an existing one with no login of its own) takes the patient's **email, password hash and MFA**, with a POA link. The patient gets a placeholder login. **The POA signs in exactly as before**; from then on what they do reads as them.
  - `link_existing`: the POA already has their own login. It gains a POA link and the patient's login retires.
  - **Passwords are never merged.** A target with its own real login is refused (`POA_CUTOVER_TARGET_HAS_LOGIN`).
  - The patient's sessions end and any open password reset for them is cancelled.
  - **History is not rewritten.** Past signatures and messages keep what was recorded. `client.poaCutover` notes the date, and the activity row records the move without the email address.
  - **Finding them is a person's call.** A "Login used by POA" flag on the client form, and an advisory list (`GET /api/gfc/admin/clients/possible-poa-logins`) built from a healthcare POA on the intake, a consent typed under a different name, or a login email that is the primary contact's. Nothing is ever moved automatically.
- **Invites:** inviting someone who already has a family account for another patient now **links** them on approval (with a PHI-free "another portal was added to your sign-in" email) instead of refusing. Approval still never grants POA.

## Notifications (owner: "make sure all notifications work correctly")

- **Who:** every patient notice (`notifications.js` — visits, reminders, documents, results, care plan, enrollment), statement emails, care-team message emails and texts, and message thread participants now find the family side through `familyFor`, so a POA hears about the patients they are POA for and no others.
- **Where the button goes:** a POA's button names the patient, `/portal?for=<record id>` (`#messages` for messages). The portal switches to that patient on arrival. The id is an opaque record id, not a name. The patient's own button is unchanged. If the person is signed out, the choice waits in the browser tab through sign-in.
- **Texts:** a POA for two patients texting from one phone used to be refused as an unclear number. A reply now goes to the patient whose conversation we last texted that person about, within a week. Two *different* people on one number are still never guessed between.
- **Video join links** are per person and per visit already; unchanged.

## Verified

- `test/family_links.test.js` (16) plus repointed guards in `care_team_messaging` and `user_edit_password`. **12 mutations, all caught** (one survived first — a POA tick sent as text — and a test was added).
- `scripts/verify_family_multi_patient.js` **51/51** through the real server: picker, POA on Mom vs plain family on Dad, unlinked patient refused, stale tab 409, link removed, a real notice reaching the right POA with the right link, no-email client, cutover (same email and password sign the POA in, as POA), link_existing, permissions.
- `scripts/verify_portal_render.js` in Chromium with two new audiences (picker, POA with two patients); every API call carried the patient header; no page errors.
- Existing probes still pass: family invites 32/32, messaging 95/95, texts 16/16, self sign-up 33/33, profile 23/23, chart calls 41/41, billing 25/25. Full suite green.
- `verify_telehealth_visits.js` shows 76/83 **with and without this change** — its own test data puts the room's closing time before its opening time at this hour of the day. Not touched here.

## Open for the owner

1. **Pick out the patient logins your POAs have been using**, then use "Move this login to the POA…" on each. The possible-logins panel in User Management is a starting point.
2. **Past entries made with a shared login still read as the patient.** Decide whether any signed consents should be re-signed by the POA in their own name.
3. Unread messages show for the patient on screen only; a POA does not see another patient's unread count until they switch. Emails still tell them.
4. Admin Hub changes compile but were not clicked through in a browser here.
