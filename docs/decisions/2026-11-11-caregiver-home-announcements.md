# Caregivers see new announcements on Home

**Date:** 2026-11-11 · **Owner-directed** ("no banner or notification of announcement on home page of MyGFC" for caregivers)

## What changed
- Other staff's My GFC Home shows "New: <title>" with a Read It button for each announcement they haven't reviewed. The caregiver app's Home showed nothing; announcements appeared only in the Feed tab.
- Caregiver Home now shows one slim banner (owner: "a simple banner"): "New announcement: <title>", or "N new announcements" when there are several. Tapping it opens the Feed, and it goes once they tap "I've Reviewed This."
- It reads `/api/my/announcements`, the same list other staff's Home reads. The caregiver Feed is closed until the welcome packet is finished, so building the card from the Feed would show nothing for a caregiver still in their packet.

## Also fixed
`test/staff_onboarding_notices.test.js` S8 set a credential to expire "14 days out" using the UTC date. After 7pm Eastern that's already tomorrow, and the app counts days in Georgia, so the test failed every evening. It now uses Georgia's date.

## Verified
- Test added; full suite green.
- Chromium on a real server: the card shows, Read It opens the Feed, and after review the card is gone.
