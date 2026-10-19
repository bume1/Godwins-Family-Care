# Every clinical staff member attaches to the chart; a coordinator or the admin approves (2026-10-16)

Owner request: "please allow for all clinical staff to attach documents to the patient chart. The care coordinator and admin only, though, approve."

## What was decided (must not undo)

- **Attach: every clinical staff member.** That is anyone with a clinical role, read-only included, plus the admin and managers (`clinicalRoles.canFileChartDocuments`). Caregivers, clients and family are not clinical staff and are refused.
- **Approve: a care coordinator or the admin, and nobody else** (`clinicalRoles.canApproveChartDocuments`). "Care coordinator" means the `coordinator` clinical role. That includes a manager whose chart access is set to "View and edit charts", because that setting stores the same role.
  - **Plain managers lost approval.** Since 2026-10-15 a plain manager could accept or reject a document through the enrollment-manager gate. The review route now has its own gate, `requireDocumentApprover`.
- **A document attached by anyone else waits.** It is stored with `status: 'received'` and `awaitingApproval: true`. The chart shows it with an "Awaiting Approval" tag.
- **It stays out of OpenEMR until approved.** `attemptEmrFiling` refuses it (`AWAITING_APPROVAL`), so neither opening the chart nor the link-time catch-up can push it early.
- **Approving files it to OpenEMR** using the approver's own sign-in. If the approver has no OpenEMR sign-in, it waits for the next clinician's, the same as any upload.
- **A coordinator's or the admin's own attachment needs no second approval.** It lands accepted.
- **Approving or rejecting a staff attachment never emails the client.** It is the office's own paperwork. A client's own upload is still reviewed and notified exactly as before.
- **The screens ask the server who may approve.** The chart reads `access.canApproveDocuments` from `/api/clinical/status`. The enrollment page reads `access.canApprove` from the document list. Neither page decides for itself.
- The chart's upload card no longer says the patient sees every filing. Staff filings have been hidden from patients until shared since 2026-09-29.

## Verified

- `scripts/verify_document_routing.js` passes 69/69 through the real routes, 12 checks of them new:
  - an RN attaches, and the document waits and is held out of OpenEMR;
  - the chart shows it as awaiting approval;
  - opening the chart does not file it;
  - the RN and a plain manager are refused approval;
  - a coordinator approves it, and it reaches OpenEMR;
  - a coordinator's own attachment is accepted on arrival;
  - a caregiver is refused.
- 4 mutations caught: everyone auto-approved; a pending document reaching OpenEMR; a manager able to approve; approval not filing.
- Four existing guards were repointed rather than deleted: the filing gate, two workflow-gate route lists, and the access block.
- Full suite: 2,536 tests, 0 failing. Both pages compile.
- Not rendered in a browser.
