# The website's free assessment moves into the app (2026-11-25)

**Owner ask:** move the free assessment (the website's front door) into the app, and save each submission to the app's database instead of the Apps Script → Google Sheet path. Then, same day: "only ask what's absolutely necessary... boom, boom, boom, submit."

## What was built
- **Public page `/assessment`** (`public/assessment.html`). No login. Two screens, mostly one tap per question:
  1. Who is filling it in (the client, or a family member), the client's name, date of birth, street address, city, state and ZIP, and a phone or email. A family member also gives their own name and how they are related.
  2. Care wanted (home care, in-home primary care, both, not sure), how it is paid for (Medicare, Medicare Advantage, Medicaid, dual, VA, commercial, LTC insurance, private pay), the Medicaid waiver if on Medicaid, and three fit questions: how they get around (includes bed-bound), whether moving them takes two people, and memory concerns. "How soon" and a free-text note are optional.
- **`POST /api/assessment`** saves to the new PHI collection `assessment_requests`, with a honeypot and 5 per hour per address. It emails the office a notice (detail level follows the transport rule) and the submitter a confirmation with no health information.
- **Staff queue: Clients → Free Assessments tab.** Open leads first, ordered by urgency then newest. Staff set a status (new, contacted, assessment scheduled, not a fit) and add notes. "Not a fit" needs a note. **Convert to Client** creates a client at `intake_pending` with the intake pre-filled, so the family is not asked twice.
- **Fit flags** (bed-bound, routine or occasional two-person assist, significant memory concerns) are shown on the row as "Check fit". A flag never declines anyone. A family may have a second person in the home, and that is a conversation for the call.

## Rules that must not be undone
- **A submission is a lead, not an account.** Nothing in it can sign in.
- **The answer lists come from `public/intake-fields.js`.** They are never restated. A converted lead's answers are always values the intake accepts.
- **Conversion writes only intake paths the intake declares.** The exceptions are the first/last name pair and provenance markers, which are written the way a self sign-up writes them. This is test-enforced.
- **The audit records a status change and whether a note was added, never the note text.**

## Open for the owner
- Point the website's "Free assessment" button at `https://app.godwinsfamilycarellc.com/assessment`. Then retire the WordPress form and its Apps Script.
- **Automated eligibility checks are not built.** GFC has an Availity Essentials portal account, not API access. Checks stay manual.
