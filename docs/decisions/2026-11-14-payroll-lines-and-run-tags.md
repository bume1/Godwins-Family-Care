# Added pay lines are visible everywhere; the runs list says how a run was sent and paid

**Date:** 2026-11-14 · **Owner-directed** · Branch `claude/stoic-feynman-ozygr7`

## What changed
- **A bonus, reimbursement or correction shows as its own line.** On a draft, each line added by hand is listed under the person with its note and a **Remove** button (draft only; `DELETE /api/payroll/admin/runs/:id/adjustments/:adjId`). The register CSV gained Regular Pay, Overtime Pay, Salary, Visit and Exam Pay, Bonus and Correction columns, an **Added Lines** column naming each line with its note, and a **Taxes Entered By Hand** column. The pay stub already printed each line with its note; a test now reads it back.
- **Taxes entered by hand warn when gross moves.** The gross they were entered against is kept; adding or removing a line afterwards shows "Gross changed from $X since these taxes were entered". The app never rewrites hand-entered taxes.
- **The runs list tells the truth at a glance.** A run sent by Cash App carries a **P2P** tag (or "P2P · 1 of 3"). An approved run shows how many payments are marked paid. A run reads **Paid** only once every payment is marked on the Payment Sheet, which is unchanged. The confirmation prompt now names Cash App.

## Verified
`test/paystub_delivery.test.js`: bonus in the CSV columns and Added Lines, on the stub with its note, a mistaken line removed, an approved run's lines locked, the gross-changed flag, and the P2P / marked-paid counts through Paid. Full suite 3740 pass, 0 fail. Rendered in Chromium.
