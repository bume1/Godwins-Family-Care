# Each pay schedule's first Monday is set on Settings

**Date:** 2026-11-13 · **Owner-directed** (live setup: "confirm the first Monday of each pay schedule")

## What changed
- Payroll → Settings now has **First Monday of a pay period** on each schedule card. The server already accepted it (`schedules[key].anchor`, Monday only); the screen had no field, so a biweekly cycle a week off from GFC's real one could not be fixed.
- The page sends the date only when it was changed. An unchanged date is left off, so a frequency change still moves the start to the next period by itself.
- `docs/PAYROLL_SETUP.md` §2 and §4 updated for the two schedules and the trimmed Pay Setup list.

## Verified
- A real weekly caregiver run was pushed through the shipped routes and its pay stub PDF rendered and read back. Figures checked: 42 h at $18 = $756, 2 h overtime premium $18, gross $774, Social Security $47.99, Medicare $11.22, net $639.60. SSN shows last four only. The email carries no amounts.
- New test: a non-Monday is refused, the biweekly weeks move, the other schedule is untouched.
