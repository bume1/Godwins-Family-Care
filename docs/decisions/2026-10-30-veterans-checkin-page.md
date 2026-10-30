# Veteran check-in page at /veterans (owner, 2026-10-30)

**Why:** the first IME day at the Savannah clinic had a chaotic intake. Vendors do not let GFC contact veterans before the exam, so the clinic needs a self sign-in on an iPad.

**What was built**
- `GET /veterans` serves `public/veterans.html`: the main homepage's look (gfc-auth.css), then "Are you a US Veteran here for your Independent Medical Exam or Medical Disability Exam?" and a Sign In button. A small link still reaches `/login`.
- The form takes first name, last name, and a 10-digit phone. Thank-you screen: "Thank you for signing in. We will call you back shortly."
- Kiosk rules: the thank-you screen resets to the start after 12 seconds, a half-filled form after 90 seconds idle, and every field is cleared and autocomplete off, so the next veteran never sees the last one's details.
- `POST /api/veterans/check-in` is public, rate-limited per hashed address (30/hour), honeypot-guarded, stores a row in `veteran_checkins` (registered, PHI), audits under the new `/api/veterans` PHI prefix, and logs `veteran_checked_in`.
- **Interim notice:** an email to the office inbox (`ROI_ADMIN_EMAIL`) marked `{ phi: true }`. The name is in the body, never the subject.

**Not built yet (next step):** routing the arrival to the ASSIGNED provider by text and email. There is no record yet of which veteran is assigned to which provider, so nothing can route it today.

**Banner:** `public/banners/banner-veterans.jpg` is a copy of the current portal photo until the owner sends the veterans photo; replace that one file.
