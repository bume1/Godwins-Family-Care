# Policies are signed from the onboarding task, not uploaded

**Date:** 2026-11-18 · **Owner:** "for documents like policies, instead of it asking to upload signed versions... pull up the document for signature right there in that task area in onboarding, connected to the button in the documents area."

## How it works
- **Staff** see an **Open and Sign** (or **Open and Acknowledge**) button for each policy on the task.
- **One signing, both places.** The task button uses the same signing screen and route as My GFC → Policies (`/api/my/policy-docs/:id/sign`). Signing in either place ticks both, and the task says so.
- **The office** sees "They sign each one in the app…" instead of being asked to upload a signed copy.
- **Paper is the exception, tucked away:**
  - "Signed on paper instead?" for the upload
  - "Signed on paper?" on each policy, to file it
- **Caregivers:** the handbook, privacy and code-of-conduct forms on A.5.03 are signed in the welcome packet. The task shows a **Sign in Welcome Packet** button that goes there.
  - Each packet row now carries `signs`, from `track.packetEvidence`.
  - For other staff, the staff welcome row shows **Open Welcome Packet**, which goes to `/my#welcome`.

## Verified
- A test in `test/onboarding_reorganize.test.js`.
- Full suite passing.
- Chromium:
  - a clinician's Policy acknowledgments on a phone, with Open and Sign on each policy
  - the office view, with paper filing tucked away
