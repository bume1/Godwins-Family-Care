# Veteran roster and arrival routing to the assigned provider (owner, 2026-10-30)

Follows `2026-10-30-veterans-checkin-page.md`. The vendor gives GFC each veteran's first name, last name and date of birth, and the clinic assigns a provider.

**Owner answers:**
- The iPad sign-in asks for date of birth.
- Phone stays required; email is optional.
- Admins and providers both add veterans, and a provider only to their own list.
- Each veteran has an exam date, and a sign-in only matches that day's list.

**Built**
- **`veteranRoster.js`** holds the rules: input checks, name folding (the patient-link guard's rules) and the matcher.
  - The matcher tries first + last + DOB first. If nothing fits, it tries last + DOB, but only when exactly one veteran fits (a nickname).
  - Two possible matches is `ambiguous` and goes to the office. It never guesses.
  - Only today's (Georgia date) expected or arrived rows are candidates.
- **New `veteran_roster` collection** (PHI, registered). Statuses are expected → arrived → seen, or no show. Removing keeps a tombstone.
- **Routes under `/api/veterans`:**
  - roster: list, add, edit, remove and status
  - sign-ins for the day and match by hand (office only)
  - the public check-in, which now takes DOB and an optional email
- **On a match:** the roster row goes to arrived with the phone and email the veteran gave, and the provider is told by both channels:
  - **Email:** marked PHI, nothing identifying in the subject, with a link to `/clinical#veterans`.
  - **Text:** sent through Quo, with no name in it.
  - What went out is recorded on the sign-in. A failed send never fails the sign-in.
- **Unmatched or ambiguous:** the office is emailed, and the sign-in waits under "Sign-ins to match" in the admin hub.
- **Screens:**
  - Admin hub: "Veterans (IME)" beside User Management, open to admins and managers.
  - Clinical workspace: a "Veterans" view under Work. Providers see their own list; admins see all. It refreshes every 30 seconds.
  - iPad form: DOB as MM / DD / YYYY boxes, plus optional email.
- **Who can do what:**
  - "Provider" means anyone who can write clinically.
  - Admin and manager count as the office.
  - Caregivers, and anyone signed out, are refused.

**Verified**
- 10 unit tests, with 5 mutations each caught.
- `scripts/verify_veterans.js`: 25/25 through the real routes, with Quo and the mailer stubbed.
- Full suite 2683, 0 failing.
- The three screens rendered in Chromium with no page errors.

**Owner setup still needed**
- A mobile number and email on each provider's user record. With no number, the provider gets the email only, and the screens say so.
- `QUO_API_KEY` on the deployment.
- A container rebuild.

## Addendum: a confirmation text to the veteran (owner, 2026-10-30)
- **When:** every iPad sign-in, after the screen has answered, so the iPad never waits on it.
- **Line:** sent from the office main line (`quoSms.officeNumber()`).
- **Wording:**
  - Matched: "Thanks for checking in at Godwins Family Care. Your provider has been notified and will call you shortly."
  - Unmatched or ambiguous: "...Our team has your details and will call you shortly." It never claims a provider was told when none was.
- **Record:** the outcome is stored on the sign-in (`veteranText`). A failed text never affects the sign-in.
- **Not repeated:** matching a sign-in by hand later does not text the veteran again.
- **Verified:**
  - 2 new tests
  - 2 mutations caught: the text sent from the Care Team line, and the "notified" wording sent on an unmatched sign-in
  - probe 28/28
  - suite 2688, 0 failing
