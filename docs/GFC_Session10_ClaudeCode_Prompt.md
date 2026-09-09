# Session 10 — Claude Code Prompt
## Family portal — PHCP care feed, behavioral flag notifications, ROI-gated

**Prerequisite:** **Session 6 merged** (visit logs must exist to display). Session 9 helpful but not required — Care Update pushes degrade gracefully if absent.
**Model:** Sonnet acceptable.
**Spec:** `docs/GFC_App_Build_v2.md` §1E/§1F (family portal, ROI enforcement) · family care-feed screens in `docs/prototype/phcp-portal-prototype.html`.
**Important:** TEST DATA ONLY.

---

## Scope has narrowed — read this first

Session 4.3 (PR #31) already built the **clinical** half of the family portal: the sharing filter map, family clinical read, POA acting gates, and ROI-family gating. **Do not rebuild any of it.**

This session builds the **PHCP half** — what the family sees about personal-care visits, which did not exist until Session 6 wrote visit logs.

---

## Paste this into Claude Code

```
You are continuing the GFC Care Platform build. Read CLAUDE.md first and honor
its prerequisite gate. Session 6 must be merged. TEST DATA ONLY.

Branch: session/10-family-feed (or harness-assigned)

Read first, in full:
- docs/GFC_Session10_ClaudeCode_Prompt.md — the narrowed scope note above
- The Session 4.3 sharing filter map and family gating — REUSE, do not fork.
  A second visibility mechanism is a defect.
- docs/GFC_App_Build_v2.md §1E, §1F
- Session 6's visit_logs and escalation_events records
- Family care-feed screens in docs/prototype/phcp-portal-prototype.html

ARCHITECTURE
Read-only plus notifications. No family write path in this session beyond what
4.3 already granted a POA. Gating is ROI-family (signed or signed_offline) AND
the client's sharing settings — both already enforced by 4.3's filter map.
Extend that map with the new PHCP fields; do not build a parallel one.

SCOPE

A. The care feed
Chronological view of personal-care activity for the family's linked client:
- Visit summaries from Session 6's visit logs — SUMMARY level only. Date,
  caregiver first name, duration, ADLs completed at a plain-language level.
  Never the caregiver's raw notes, never behavioral observation detail unless
  clinically shared (below).
- Care plan summary (already available via 4.3 — surface it here, do not
  rebuild).
- Upcoming scheduled visits if Session 7 has merged; hide the section entirely
  if not. No placeholder.

B. Behavioral flag notifications
- When a caregiver raises a flag, family are NOT notified by default.
  Escalations are internal.
- A clinician may choose to share a flagged event to the family feed. Only then
  does it appear, rendered as a clinical note with the clinician named — never
  as the caregiver's raw observation.
- Push or in-app notification on share. Ride the existing notification queue.

C. Clinician Care Update pushes
If Session 9 has merged, surface Care Update messages in the feed. If not, skip
the section — do not stub a fake one.

D. Gating and revocation
- ROI-family revoked removes access immediately, mid-session. Prove it.
- Sharing settings changes take effect on next read, not on next login.
- Non-POA family stays read-only. POA capabilities are 4.3's; do not extend
  them here.

DO NOT
- Rebuild anything from 4.3 — filter map, POA gates, clinical read, ROI gating.
- Show caregiver raw notes or unshared behavioral observations to family.
- Notify family of an escalation automatically.
- Add a family write path.
- Enter real PHI.

ACCEPTANCE
- A family user with signed ROI-family sees the care feed for their linked
  client only. Tampering with any id returns 403.
- Raw caregiver notes and unshared behavioral detail are ABSENT from the family
  payload, not hidden in the UI. Prove with a test.
- An escalation is invisible to family until a clinician shares it; once
  shared it renders as a clinician-attributed note and fires a notification.
- Revoking ROI-family removes access immediately.
- The upcoming-visits section is absent when Session 7 has not merged.
- Mobile and desktop layouts both correct.
- Every family read hits the activity log.
- App boots; 3.x, 4.x and Session 6 unaffected.

Update CLAUDE.md AND docs/GFC_SESSION_PLAN.md per the running instruction
(steps 4-7). Open ONE PR titled "Session 10: Family portal — PHCP care feed."
Stop for review.
```
