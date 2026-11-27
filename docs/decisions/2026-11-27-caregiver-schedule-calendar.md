# A caregiver's Schedule is a calendar (2026-11-27)

**Owner request:** "Ensure caregivers see the same calendar view (scoped to their shifts) in their schedule view in My GFC. Right now, their shifts come up as a list. They should be able to see all the shifts (confirmed vs. completed vs. open). They should not be able to see cancelled shifts."

## What changed

- **`public/components/caregiver-schedule.js`.** The My schedule tab opens on a month calendar in the same shape and colours as the scheduling board's Master calendar. A Calendar / List switch keeps the old list one tap away. Tapping a day opens a panel of that day's shifts with the same controls each shift already had elsewhere (Clock in and Ask to change on a confirmed shift, Accept and Decline on an offer, Claim on an open shift). The rows are built by one function per kind (`scheduleRow`, `offerRow`, `openRow`), shared by the calendar, the list and the Offers and Open shifts tabs, so they cannot drift apart.
- **What the calendar shows:** confirmed, in progress, completed, offered to you (`assigned`), claimed and awaiting approval, and open shifts the caregiver can claim. Each kind has its own colour and a label in words in the day panel. The legend doubles as a filter.
- **Open shifts on the calendar are the claimable ones only.** The open pool the server returns is already filtered to what this caregiver may see; a shift their licence does not cover still appears greyed out, with its reason, on the Open shifts tab. On a calendar it would read as work they could pick up.
- **Cancelled shifts are never shown to a caregiver.** `GET /api/scheduling/shifts` now leaves cancelled rows out for anyone who is not a schedule manager, and the component refuses to render one as a second lock. The office board is unchanged. Time logs are their own read, so hours are unaffected.
- **The caregiver's 500-row cap now drops the oldest shifts, not the newest.** The list was sorted oldest first and cut at 500, which on a long history would have dropped the upcoming shifts a calendar exists to show. The office board keeps its existing order (it has the same latent issue, left alone here).
- **Days are bucketed by the date in Georgia**, through `GFC_TIME.zonedParts`, the same as the board.
- **On a phone** each day shows coloured bars with a short time ("9a", "2:30p"); names live in the day panel. No horizontal scroll at 390px.

## Privacy

No new data reaches a caregiver. The calendar reads the same two routes the screen already read (their own shifts, and the open pool), and shows the same fields.

## Verified

- `test/caregiver_calendar.test.js` renders the real component against a stub DOM and fetch: calendar is the default; each kind appears; a cancelled shift never renders even if one is sent; an unclaimable open shift stays off; the route filters cancelled for non-managers. Four mutations, each caught.
- Two existing guards were repointed, not loosened: the visit-log scan reads the whole handler (anchored at the next route) instead of a 2400-character window, and the offer-ask scan reads `offerRow`.
- Rendered in Chromium at 390px and 1200px; navigation, day selection, the legend filter and the list switch clicked through with no page errors.
- 330 tests across the scheduling files, 0 failing.
