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

## Update, same day: every kind of patient (owner)

The screen covered home care only. The owner asked that it screen primary care
and psychiatric patients too, and patients seen in our clinics or by video, not
only homebound ones.

- "What kind of care" is now pick-all: Home care, Primary care, Mental health /
  psychiatry, Not sure yet. Primary care or psychiatry asks where they want to
  be seen (at home, at one of our clinics, by video, no preference).
- Coverage is in the family's words (Original Medicare, Medicare Advantage,
  Medigap, Medicaid, dual, Medicaid waiver for home care, employer or private
  insurance, Marketplace, TRICARE, VA, long-term care insurance, paying
  privately, no insurance, not sure) plus an optional plan name. Each answer
  maps onto the intake's insuranceTypes at load, checked; TRICARE, no insurance
  and not sure map to none and stay on the lead.
- These three lists live in assessmentRequests.js and the page reads them from
  GET /api/assessment/options, so the form cannot offer what the server refuses.
- Two-person assist is only asked when home care is on the table.
- New fit flags: home care with no payer that covers it (Medicare and health
  plans do not), medical care with no insurance named, and bed-bound but asking
  for clinic visits. Bed-bound for a house call is not flagged.
- Primary care and psychiatry both convert to the clinical line (IHPC); with
  home care, BOTH.
