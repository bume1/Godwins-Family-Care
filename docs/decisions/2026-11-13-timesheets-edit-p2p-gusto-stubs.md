# Timesheets you can edit, P2P payroll, and Gusto stubs line for line

Owner-directed, 2026-11-13.

## Timesheets: view, approve and edit in one place

- Payroll → Timesheets lists each person's shifts for the pay period with clock-in and clock-out (Georgia time), the client, and any earlier correction with its reason.
- **The Super Admin edits a shift there directly**, with a reason. It goes through the same one writer a Time Logs correction uses (`applyTimeLogEdit`), so the edit trail and the payroll lock are unchanged.
- **Managers and care coordinators** (the Staff Scheduling module) open the same screen with Timesheets only. Their edit is a time adjustment request the Super Admin approves, the existing queue. The overview tells them `timesheetsOnly` and carries no pay figures; every other payroll route still refuses them.
- **Employees** get "Request a Change" on each of their own shifts in My GFC (`POST /api/my/time-logs/:id/adjustment-requests`). Someone else's log reads as not found; paid hours are locked.
- Everyone sees the same pending change: the employee's card, the managers' view and the Super Admin's, who approves or declines it on the line.
- Visit times from a clinician's note are not edited here; they are corrected on the visit.
- The Timesheets tab exports the period's hours CSV.
- `raiseAdjustment` is now the one place a request is created, for both doors.

## P2P

The Super Admin chooses on each draft how the payroll is sent: Direct deposit or P2P from GFC's Cash App (`settings.p2pAccount`, default `$GodwinsFamilyCare`), with a per-person override. **Employees never choose Cash App.** A P2P person needs no bank details on file. The pay stub says "P2P by Cash App from $GodwinsFamilyCare".

## Gusto stubs

- Every earning column Gusto exports (`<Name> (Hours/Amount/Rate)`) is its own stub line with hours and rate. "Regular" reads "Hours worked"; wages Gusto recorded as history without hours read "Wages (recorded in Gusto without hours)".
- If Gusto's lines do not add up to its gross, the gross is one line and a warning names the pay date.
- Stubs show the hourly rate on an hours line, and drop the state income tax line for a state with none (Texas) when nothing was withheld.
- Checked against a real 13-period Gusto journal (not committed): every gross, tax, employer tax and net matched Gusto's per-employee totals to the cent, with no warnings.
