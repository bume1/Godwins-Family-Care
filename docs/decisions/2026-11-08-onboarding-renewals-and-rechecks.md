# Clinician onboarding: renewals, recurring duties, spaced re-checks, and quizzes off

Owner, 2026-11-08: make sure the NP/clinician onboarding is fully built, including spaced re-checks and expiring credentials. Hold the training quiz questions until the SOPs behind them are written.

## What changed

- **Training check questions are OFF for staff by default.** The server stops sending them, so the page has nothing to show.
  - The office turns them on from the Training Library with "Show training check questions to staff". The setting is stored in `onboarding_settings`.
  - The office still sees them.
- **Expiring credentials** (`onboarding/renewals.js`):
  - Six items carry an expiration date: license or authorization, DEA registration, malpractice policy, TB screening, driver's license or auto insurance, and a license in another state.
  - **The Playbook does not list these item by item. They were chosen as the documents that carry an expiration date**, and the office screen says so.
  - An item warns 60 days before its date. A completed item reads "Renewal Due" once the date passes.
  - Either she or the office records the date.
  - "Start Renewal" opens the item again for the new document. The earlier steps move into `history` and are never deleted, so a renewed document goes through verification like the first one.
- **Recurring duties** (the C.9 schedule) each have a next-due date, counted from the last time the duty was recorded done or from the start date. Only the office records one. "Within thirty days of discovery" reads "When It Happens" and has no schedule.
- **Spaced re-checks** (Training Library TRN-406):
  - A knowledge module (video, reading, in-app) comes back at days 3, 10, 30 and 90 after it was completed. Live reviews, observed skills and shadow shifts do not.
  - A re-check never opens early and is never recorded twice.
  - While check questions are off, a re-check is "I Reviewed This Again".
- **Screens:**
  - Each person has a **Renewals** tab, with a count on it.
  - The office overview has a "Renewals Due" stat.
  - Her Home shows "Renewals Coming Up" and "Refreshers Due".
  - Her Training tab shows the refreshers.
- The onboarding page's navy sidebar now runs the full height of a long page.

## Verified

- `test/onboarding_renewals.test.js`: 5 tests, covering the pure rules and the routes over HTTP.
- Five mutations, each caught:
  - the warning window
  - history kept across renewals (this one survived at first, and the test was tightened)
  - a re-check opening early
  - re-checks applying to every format
  - the recurring count ignoring the last time a duty was done
- Full suite passes, and the page renders in Chromium.

## Open for the owner

- Confirm the six expiring items, and whether BLS/CPR, immunizations or the protocol agreement should expire too.
- The 60-day warning is one constant (`SOON_DAYS`).
