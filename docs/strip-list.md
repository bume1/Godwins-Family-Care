# Strip List — GFC Repo Cleanup Checklist

**Purpose:** This is an approval checklist for a future session. Nothing listed here has been deleted yet.
Bianca reviews and checks off each item before any removal is executed.

**How to use:** Work through each area with a developer. Check a box (`- [x]`) only when you've confirmed
that item should be removed. Leave items unchecked or move them to "Uncertain" if you want to keep or
investigate further. Items marked "REUSE" appear in the Uncertain section per §8 of `GFC_App_Build_v2.md`.

**Source of truth:** `docs/GFC_App_Build_v2.md` §7 (strip) and §8 (reuse).
**No code was modified during this analysis.**

---

## 1. CLIA task template

The 102-task Biolis AU480 CLIA equipment-installation template file and its default phase/stage constants.

- [ ] **File:** `/template-biolis-au480-clia.json` — 102-task default template (28 KB); entirely lab-specific.
- [ ] **File:** `/zipFile.zip` — appears to be a backup/export archive; inspect before deleting (may contain lab data).
- [ ] **config.js lines 82–122:** `STANDARD_PHASES` object (10 lab phases: "CLIA & Hiring", "Inventory Forecasting & Procurement", "Virtual Soft Pilot & Prep", "Training & Full Validation", etc.) and `PHASE_ORDER` array and `LEGACY_STAGE_TO_PHASE` migration map — all lab-specific phase names.
- [ ] **config.js lines 83–94:** Exported `STANDARD_PHASES` and `PHASE_ORDER` constants.
- [ ] **config.js lines 97–122:** Exported `LEGACY_STAGE_TO_PHASE` map.
- [ ] **public/app.js lines 5–47:** `STANDARD_PHASES` and `PHASE_ORDER` constants duplicated in the frontend (identical lab phase names).
- [ ] **public/app.js lines 2602–2613:** `phaseNames` lookup object (maps lab phase keys to full lab phase names).
- [ ] **DB key:** `templates` — stores user-created project templates (all currently CLIA/lab templates). Confirm empty or GFC templates exist before dropping.
- [ ] **DB key:** `tasks_{projectId}` — task data keyed per project; lab-specific task content (all 102 CLIA tasks). No drop needed if projects are reset; note for data migration.

---

## 2. Inventory module

Weekly lab-supply inventory submission, reporting, CSV import/export, and admin aggregate reports.

### Backend routes (`server.js`)

- [ ] `GET  /api/inventory/custom-items/:slug` — line 6781
- [ ] `POST /api/inventory/custom-items/:slug` — line 6794
- [ ] `DELETE /api/inventory/custom-items/:slug/:itemId` — line 6814
- [ ] `GET  /api/inventory/template` — line 6829
- [ ] `PUT  /api/inventory/template` — line 6838
- [ ] `GET  /api/inventory/submissions/:slug` — line 6851
- [ ] `GET  /api/inventory/export/:slug` — line 6866
- [ ] `GET  /api/inventory/import-template` — line 6924 (returns CSV download of Biolis reagent template)
- [ ] `GET  /api/inventory/export-all` — line 6958
- [ ] `GET  /api/inventory/latest/:slug` — line 7033
- [ ] `POST /api/inventory/submit` — line 7061
- [ ] `DELETE /api/inventory/submissions` — line 7119
- [ ] `GET  /api/inventory/report/:slug` — line 7168
- [ ] `GET  /api/inventory/report-all` — line 7339

### DB keys

- [ ] `inventory_template` — admin-configured standard inventory item list (Biolis reagents/supplies).
- [ ] `inventory_submissions_{slug}` — per-client weekly inventory submissions.
- [ ] `inventory_custom_{slug}` — per-client custom inventory item additions.

### Config/constants

- [ ] **config.js lines 136–141:** `DEFAULT_INVENTORY_ITEMS` constant — hardcoded Biolis lab reagents (Ancillary Supplies, Calibrators, Controls, Reagents); exported at line 243.
- [ ] **config.js line 31:** `INVENTORY_EXPIRY_WARNING_DAYS` config constant.
- [ ] **config.js line 162:** `INVENTORY_REMINDER_DAYS` automated reminder constant.
- [ ] **config.js line 198:** `inventoryExpiryWarningDays` in `getPublicConfig()` output.

### Frontend — `public/portal.html`

- [ ] `InventoryPage` component — lines 1797–2449 (full weekly inventory management UI).
- [ ] `ReportsPage` component — lines 2212–2450 (inventory reports for client).
- [ ] `AdminReportsPage` component — lines 2451–2633 (aggregate inventory reports for admin).
- [ ] `SubmissionHistoryPage` component — lines 2634–3112 (inventory submission history view).
- [ ] `Sidebar` component (lines 302–518): `inventoryExpanded` state and "Inventory" nav section (lines 303, 382–401) with sub-items for Inventory, Reports, and Submission History.
- [ ] `HomePage` component (lines 519–675): "Inventory" quick-link card (line 656).
- [ ] `MilestonesPage` component (lines 989–1796): Phase name lookup table that includes "Phase 4: Inventory Forecasting & Procurement" (line 1036) — review and update when phases are redesigned.

### Frontend — `public/admin-hub.html`

- [ ] `ServicePortalPage` component (lines 1873–3004): inventory report section within it — `getInventoryReports`, `getInventoryTemplate`, `updateInventoryTemplate` API calls (lines 266–280); inventory reporting state (`validationReports`, `validationFormData`) and inventory tab within service portal admin view.

### Notification email templates (`server.js` lines 900–911)

- [ ] Email template `inventory_reminder` — lines 900–912 (automated weekly inventory reminder email).
- [ ] **config.js / server.js:** `inventory_reminder` notification type in `NOTIFICATION_COOLDOWN_HOURS` and notification scanner.

---

## 3. Validation reports

Multi-day analyzer validation workflow: daily log, on-site/off-site segments, signature, PDF generation, client progress view.

### Backend routes (`server.js`)

- [ ] `GET  /api/service-reports/active-validations` — line 9390 (validation-specific sub-type)
- [ ] `POST /api/service-reports/start-validation` — line 10520
- [ ] `PUT  /api/service-reports/:id/complete-validation` — line 10726
- [ ] `PUT  /api/service-reports/:id/save-day-progress` — line 10666
- [ ] `PUT  /api/service-reports/:id/complete-onsite` — line 11115
- [ ] `PUT  /api/service-reports/:id/offsite-segment` — line 11199
- [ ] `PUT  /api/service-reports/:id/submit-validation` — line 11260 (includes PDF upload)
- [ ] `GET  /api/client-portal/validation-progress` — line 10905 (client-facing validation status)
- [ ] `GET  /api/projects/:projectId/active-validations` — line 11014
- [ ] `POST /api/validation-reports` — line 11473
- [ ] `GET  /api/validation-reports` — line 11575
- [ ] `GET  /api/validation-reports/:id` — line 11620
- [ ] `PUT  /api/validation-reports/:id` — line 11644

### DB keys

- [ ] `validation_reports` — standalone validation report records.
- [ ] `service_reports` — note: service reports key also stores validation-type service reports (serviceType === 'Validations'); must strip validation sub-records when this key is cleaned.

### Frontend — `public/portal.html`

- [ ] `MilestonesPage` — `ValidationProgressCard` inner component (lines 1148–1389): full multi-day analyzer validation status card shown to client.
- [ ] `MilestonesPage` — `getValidationProgress` API call and `validationProgress` state (lines 994–1028).
- [ ] `MilestonesPage` — Phase 8 "Training & Full Validation" phase name (line 1040).
- [ ] `FilesPage` component (lines 3925–4472): service report signing UI embedded in Files — `ServiceReportDetail` (lines 3198–3488) and `SignaturePad` (lines 3113–3197) used for signing validation reports.
- [ ] `SignaturePad` component — lines 3113–3197 (used for both service and validation report signing; only needed if service reports also stripped).
- [ ] `ServiceReportDetail` component — lines 3198–3488 (client-facing service/validation report detail with signature).

### Frontend — `public/service-portal.html`

- [ ] `DailyLogSection` component — lines 3371–3554 (multi-day validation daily log form).
- [ ] `ViewValidationPage` component — lines 3555–3705 (view completed validation).
- [ ] `CompleteAssignmentPage` component — lines 3706–4266 (complete validation on-site/off-site flow).
- [ ] `ContinueValidationPage` component — lines 5039–5526 (resume multi-day validation).
- [ ] `AssignedReportsPage` (lines 3237–3370): validation tracking within assigned reports view.

### Frontend — `public/app.js`

- [ ] `Reporting` component (lines 7525–7909): validation metrics section — `validationData` state, `getValidationMetrics()`, analyzer counts, validation status breakdown (lines 7527–7587).

### `pdf-generator.js`

- [ ] `generateValidationReportPDF()` function — lines 546–782 (multi-day validation PDF; entirely lab-specific).
- [ ] `generateServiceReportWithAttachments()` function — lines 824–887 (merges service/validation PDFs with attachments).
- [ ] Helper `drawAnalyzersTable()` — lines 513–540 (renders "Analyzers Validated" table in PDF).

### Notification email templates (`server.js`)

- [ ] Email template `service_report_signature` — lines 824–837 (signature-request notification for lab service/validation reports).
- [ ] Email template `service_report_review` — lines 838–899 (admin review notification).

---

## 4. Service field reports

Field service visit reports: creation, assignment to technicians, photo/file upload, PDF generation, HubSpot ticket mapping.

### Backend routes (`server.js`)

- [ ] `GET  /api/service-portal/data` — line 8971
- [ ] `GET  /api/service-portal/clients` — line 9023
- [ ] `GET  /api/service-portal/technicians` — line 11442
- [ ] `POST /api/service-reports` — line 9081
- [ ] `GET  /api/service-reports` — line 9286
- [ ] `GET  /api/service-reports/assigned` — line 9363
- [ ] `GET  /api/service-reports/:id/pdf` — line 9416
- [ ] `GET  /api/service-reports/:id` — line 9442
- [ ] `PUT  /api/service-reports/:id` — line 9480
- [ ] `DELETE /api/service-reports/:id` — line 9566
- [ ] `DELETE /api/service-reports` (bulk) — line 9608
- [ ] `POST /api/service-reports/assign` — line 9738
- [ ] `PUT  /api/service-reports/:id/complete` — line 9862
- [ ] `POST /api/service-reports/:id/photos` — line 10077
- [ ] `POST /api/service-reports/:id/files` — line 10176
- [ ] `POST /api/service-reports/:id/technician-photos` — line 10274
- [ ] `POST /api/service-reports/:id/technician-files` — line 10343
- [ ] `DELETE /api/service-reports/:id/photos/:photoId` — line 10411
- [ ] `DELETE /api/service-reports/:id/files/:fileId` — line 10451
- [ ] `PUT  /api/service-reports/:id/manager-notes` — line 10491
- [ ] `GET  /api/client/service-reports` — line 6244 (client-facing view of their service reports)
- [ ] `GET  /api/client/service-reports/:id` — line 6383
- [ ] `PUT  /api/client/service-reports/:id/sign` — line 6417
- [ ] `GET  /api/client/service-reports/:id/pdf` — line 6607
- [ ] `GET  /api/hubspot/ticket/:ticketId/map-to-service-report` — line 9680

### DB key

- [ ] `service_reports` — all service field reports (includes both standard service and validation sub-type records).

### `requireServiceAccess` middleware

- [ ] `const requireServiceAccess` — lines 8958–8968 in `server.js`. Remove after all service-report routes are removed.

### Frontend file — `public/service-portal.html` (entire file, 5,843 lines)

- [ ] `LoginPage` component — lines 353–448 (service portal login).
- [ ] `Sidebar` component — lines 449–568.
- [ ] `HomePage` component — lines 569–929 (service portal home dashboard).
- [ ] `SignaturePad` component — lines 930–1029.
- [ ] `NewReportPage` component — lines 1030–1939 (create new service report form).
- [ ] `ReportsPage` component — lines 1940–2369 (list/search service reports).
- [ ] `ViewReportPage` component — lines 2370–2906 (view service report detail).
- [ ] `EditReportPage` component — lines 2907–3236.
- [ ] `AssignedReportsPage` component — lines 3237–3370.
- [ ] `AssignReportPage` component — lines 4267–5038 (assign report to technician; includes vendor user creation).
- [ ] `App` root component — lines 5527–end.
- [ ] Route `GET /service-portal` (serves the file) — server.js line 11690.

### Frontend — `public/admin-hub.html`

- [ ] `ServicePortalPage` component — lines 1873–3004 (admin hub view of service reports + validation reports + inventory reports).
- [ ] Sidebar nav item `service_portal` — line 458 (`{ id: 'service_portal', label: 'Service Portal', ... }`).
- [ ] `renderPage` case `'service_portal'` — line 4489.

### Frontend — `public/portal.html`

- [ ] `ServiceReportDetail` component — lines 3198–3488 (client-facing service/validation report detail).
- [ ] `SignaturePad` component — lines 3113–3197.
- [ ] `FilesPage` component (lines 3925–4472): service-report highlight/linking logic (`highlightServiceReportId` prop, service report tab within Files).
- [ ] `SupportPage` component (lines 3489–3924): "Service Reports" sub-tab within Support (part of the existing customer support section).

### `pdf-generator.js`

- [ ] `generateServiceReportPDF()` function — lines 85–438 (lab service visit PDF; entirely lab-specific).
- [ ] `fetchReportPhotos()` helper — lines 67–80.
- [ ] `drawFieldRow()` helper — lines 471–487.
- [ ] `drawFieldTable()` helper — lines 488–512.
- [ ] Entire `pdf-generator.js` file — all exported functions (`generateServiceReportPDF`, `generateValidationReportPDF`, `generateServiceReportWithAttachments`) are lab-specific. File should be replaced with a GFC-specific PDF module for care plans and consents (see §8 of master plan).

### `googledrive.js` — lab-specific functions

- [ ] `uploadServiceReportPDF()` function — lines 253–297.
- [ ] `uploadServiceReportAttachment()` function — lines 300–348.

---

## 5. Soft-pilot checklist

Client-facing soft-pilot readiness checklist (submitted from portal, uploaded to Google Drive, logged in HubSpot).

### Backend routes (`server.js`)

- [ ] `GET  /api/client-portal/soft-pilot` — line 4964
- [ ] `PUT  /api/client-portal/soft-pilot` — line 5011
- [ ] `POST /api/client-portal/soft-pilot/submit` — line 5057
- [ ] `POST /api/projects/:id/soft-pilot-checklist` — line 7511 (admin-side submission from project tracker)

### Data stored in project record (no separate DB key)

- [ ] **Project field `softPilotResponses`** — stored inside the `projects` array record; lab-specific field.
- [ ] **Project field `softPilotChecklistSubmitted`** — stored inside `projects` record.

### Frontend — `public/app.js`

- [ ] `SoftPilotChecklist` component — lines 3069–3423 (full checklist form with PDF HTML generation, signature fields).
- [ ] `ProjectTracker`: `showSoftPilotChecklist` state and button to open checklist — lines 3456–3457, 3504+ (look for "Soft Pilot" button in the tracker toolbar).

### Frontend — `public/portal.html`

- [ ] `SoftPilotForm` component — lines 676–988 (client-facing soft pilot form modal).
- [ ] `MilestonesPage`: soft pilot status fetching and Phase 7 banner (lines 997–1028, 1426–1453).
- [ ] `FilesPage`: soft pilot status in files page (lines 3937–3944, 4290–4318, 4448).
- [ ] Portal `App` component: `softPilotBanner` state and banner UI (lines 5901, 5970, 6066–6090).

### `googledrive.js`

- [ ] `uploadSoftPilotChecklist()` function — lines 234–252.

---

## 6. Knowledge hub (lab content)

The lab-specific knowledge base with guides and articles about lab processes.

### Backend routes (`server.js`)

- [ ] `GET  /knowledge` (page route, serves `knowledge.html`) — line 11695
- [ ] `GET  /api/knowledge/guides` — line 11743
- [ ] `GET  /api/knowledge/guides/:guideId` — line 11755
- [ ] `POST /api/knowledge/guides` — line 11774
- [ ] `PUT  /api/knowledge/guides/:guideId` — line 11818
- [ ] `DELETE /api/knowledge/guides/:guideId` — line 11845
- [ ] `POST /api/knowledge/guides/:guideId/articles` — line 11861
- [ ] `PUT  /api/knowledge/guides/:guideId/articles/:articleId` — line 11892
- [ ] `DELETE /api/knowledge/guides/:guideId/articles/:articleId` — line 11918
- [ ] `PUT  /api/knowledge/guides/:guideId/reorder` — line 11940
- [ ] `GET  /api/knowledge/needs-seed` — line 11966
- [ ] `POST /api/knowledge/seed` — line 11977
- [ ] `GET  /api/knowledge/v2/sections` — line 12103
- [ ] `GET  /api/knowledge/v2/sections/:sectionKey` — line 12116
- [ ] `GET  /api/knowledge/v2/search` — line 12133
- [ ] `GET  /api/knowledge/v2/needs-seed` — line 12191
- [ ] `POST /api/knowledge/v2/seed` — line 12202
- [ ] `POST /api/knowledge/v2/sections` — line 12245
- [ ] `PUT  /api/knowledge/v2/sections/:sectionId` — line 12278
- [ ] `DELETE /api/knowledge/v2/sections/:sectionId` — line 12302
- [ ] `POST /api/knowledge/v2/sections/:sectionId/features` — line 12318
- [ ] `PUT  /api/knowledge/v2/sections/:sectionId/features/:featureId` — line 12353
- [ ] `DELETE /api/knowledge/v2/sections/:sectionId/features/:featureId` — line 12383

### DB keys

- [ ] `knowledge_guides` — v1 knowledge guide records (lab-specific articles).
- [ ] `knowledge_guides_v2` — v2 knowledge sections/features records.

### Frontend files

- [ ] **File:** `public/knowledge.html` (4,312 lines) — entire lab knowledge hub UI.
- [ ] Sidebar link in `public/portal.html` line 483: "Knowledge" nav item that navigates to `/knowledge`.

### `public/admin-hub.html`

- [ ] `KnowledgeHubPage` component — lines 3382–3735 (admin management of knowledge guides).
- [ ] Sidebar nav item `knowledge_hub` — line 460 (`{ id: 'knowledge_hub', label: 'Knowledge Hub', ... }`).
- [ ] `renderPage` case `'knowledge_hub'` — line 4490.

---

## 7. Project/task tracker — defer decision

Per `GFC_App_Build_v2.md` §7: "The launch/project-task tracker is not needed for PHCP; defer or strip."
This section contains the entire implementations portal (`/launch`) and its backend. **Do not remove until
Bianca decides whether to repurpose or remove.** Checking a box here means "confirmed: defer to later
decision" or "confirmed: remove."

### Frontend files

- [ ] **File:** `public/app.js` (8,584 lines) — entire implementations React app; contains `ProjectList`, `ProjectTracker`, `TemplateManagement`, `HubSpotSettings`, `Reporting`, `SoftPilotChecklist`, `PortalSettings`, `AnnouncementsManager`, `ClientDocumentsManager`, `TimelineView`, `CalendarView` components.
- [ ] **File:** `public/index.html` — serves the launch app; root HTML shell.
- [ ] **File:** `public/client.html` (932 lines) — legacy per-project public client launch board view served at `/launch/:slug`.

### Backend routes — page/file serving (`server.js`)

- [ ] `GET /launch` (serves index.html) — line 98
- [ ] `GET /launch/login` — line 101
- [ ] `GET /launch/home` — line 104
- [ ] `GET /launch/:slug-internal` — line 8852
- [ ] `GET /launch/:slug` (serves client.html) — line 8865
- [ ] Legacy redirects `GET /thrive365labsLAUNCH/*` and `/thrive365labslaunch/*` — lines 84–92, 109–116, 8887–8908

### Backend routes — projects API (`server.js`)

- [ ] `GET  /api/projects` — line 3840
- [ ] `POST /api/projects` — line 3937
- [ ] `GET  /api/projects/:id` — line 4018
- [ ] `PUT  /api/projects/:id` — line 4045
- [ ] `DELETE /api/projects/:id` — line 4216
- [ ] `POST /api/projects/:id/clone` — line 4248
- [ ] `GET  /api/projects/:id/tasks` — line 4312
- [ ] `POST /api/projects/:id/tasks` — line 4326
- [ ] `PUT  /api/projects/:projectId/tasks/:taskId` — line 4375
- [ ] `DELETE /api/projects/:projectId/tasks/:taskId` — line 4502
- [ ] `POST /api/projects/:projectId/tasks/:taskId/reorder` — line 4543
- [ ] `POST /api/projects/:projectId/tasks/:taskId/subtasks` — line 3207
- [ ] `PUT  /api/projects/:projectId/tasks/:taskId/subtasks/:subtaskId` — line 3254
- [ ] `DELETE /api/projects/:projectId/tasks/:taskId/subtasks/:subtaskId` — line 3311
- [ ] `PUT  /api/projects/:projectId/tasks/bulk-update` — line 3337
- [ ] `PUT  /api/projects/:projectId/tasks/bulk-edit` — line 3408
- [ ] `POST /api/projects/:projectId/tasks/bulk-delete` — line 3460
- [ ] `POST /api/projects/:projectId/tasks/:taskId/notes` — line 3516
- [ ] `PUT  /api/projects/:projectId/tasks/:taskId/notes/:noteId` — line 3583
- [ ] `DELETE /api/projects/:projectId/tasks/:taskId/notes/:noteId` — line 3639
- [ ] `POST /api/projects/:projectId/tasks/:taskId/files` — line 3687
- [ ] `DELETE /api/projects/:projectId/tasks/:taskId/files/:fileId` — line 3798
- [ ] `POST /api/projects/:id/soft-pilot-checklist` — line 7511 (also in §5)
- [ ] `POST /api/projects/:id/hubspot-sync` — line 7597
- [ ] `POST /api/projects/:id/fix-client-names` — line 7832
- [ ] `POST /api/projects/:id/regenerate-slug` — line 7943
- [ ] `GET  /api/projects/:id/export` — line 8374
- [ ] `POST /api/projects/:id/import-csv` — line 8658
- [ ] `GET  /api/reporting` — line 8303

### Backend routes — templates API (`server.js`)

- [ ] `GET  /api/templates` — line 8449
- [ ] `GET  /api/templates/:id` — line 8483
- [ ] `PUT  /api/templates/:id` — line 8498
- [ ] `POST /api/templates` — line 8521
- [ ] `POST /api/templates/:id/clone` — line 8548
- [ ] `POST /api/templates/:id/import-csv` — line 8578
- [ ] `PUT  /api/templates/:id/set-default` — line 8808
- [ ] `DELETE /api/templates/:id` — line 8829

### DB keys

- [ ] `projects` — all project records (lab client installations).
- [ ] `tasks_{projectId}` — per-project task arrays.
- [ ] `templates` — user-created project templates.

### Notification email templates that are project/tracker specific

- [ ] Email template `task_deadline` — server.js line ~820 (task deadline reminders; lab project tasks).
- [ ] Email template `task_overdue` — server.js line ~820.
- [ ] Email template `milestone_reached` — lines 913–927 (project milestone %; lab-specific milestone concept).
- [ ] Email template `golive_reminder` — lines 928–942 (go-live date reminders; lab CLIA concept).
- [ ] **config.js lines 160–165, 170–178:** `TASK_DEADLINE_DAYS_BEFORE`, `TASK_OVERDUE_ESCALATION_DAYS`, `MILESTONE_THRESHOLDS`, `GOLIVE_REMINDER_DAYS_BEFORE`, and corresponding `NOTIFICATION_COOLDOWN_HOURS` entries.

### `requireImplementationsAccess` middleware

- [ ] `const requireImplementationsAccess` — server.js lines 2189–2194.

### Catch-all slug redirect (`server.js`)

- [ ] `GET /:slug` route — line 13468 (performs DB lookup on every unmatched route to redirect old project slugs to `/launch/:slug`). Remove when launch routes are removed.

---

## 8. Changelog & link directory

The git-auto-generated changelog viewer and the resource link directory — both Thrive 365 Labs operational tooling.

### Backend (`server.js`)

- [ ] `GET /changelog` (page route, serves changelog.html) — line 12410
- [ ] `GET /api/changelog` — line 12422
- [ ] `GET /directory` (page route, serves link-directory.html) — line 12405

### Frontend files

- [ ] **File:** `public/changelog.html` (453 lines) — changelog viewer UI.
- [ ] **File:** `public/changelog.md` — markdown changelog content.
- [ ] **File:** `public/link-directory.html` (253 lines) — lab resource links directory.

### Support module

- [ ] **File:** `changelog-generator.js` (553 lines) — auto-generates changelog from git commits; called at server startup (server.js line 13880). Entirely lab-operational tooling with no GFC purpose.

### DB key

- [ ] `changelog` — auto-generated changelog entries; lab version history.

### References in `public/app.js`

- [ ] "View Changelog" link in `AuthScreen` — line 1062.
- [ ] "View Changelog" link in `ProjectList` footer — line 2537.

---

## Uncertain / shared — confirm before removing

These items are referenced in §8 ("Reuse") of `GFC_App_Build_v2.md` or have both lab and GFC-applicable
parts. Do not remove without explicit decision.

### HubSpot integration (`hubspot.js` + routes)

- [ ] **UNCERTAIN — §8 says "HubSpot (public marketing leads only, pre-PHI)"**
  `hubspot.js` (1,434 lines) contains ticket management, deal sync, file upload, and service-report mapping functions that are lab-specific. The module as a whole should be reviewed:
  - Lab-specific functions to strip: `uploadFileAndAttachToRecord()`, `syncTaskNoteToRecord()`, `createOrUpdateTask()`, `getTicketPipelines()`, `getTicketsForCompany/Contact/Deal()`, `createTicketWithFile()`, `getTicketById()` — all tied to lab equipment install workflows.
  - May keep (marketing/pre-PHI): `getAccessToken()`, `getHubSpotClient()`, `logRecordActivity()`, `testConnection()`, `getOwners()`.
  - Routes to review: `POST /api/hubspot/upload-to-deal` (line 5416), `GET /api/hubspot/deals` (line 5470), `POST /api/webhook/hubspot/ticket-created` (line 5666), `POST /api/webhook/hubspot/ticket-stage-change` (line 5706), `GET /api/client/hubspot/tickets` (line 6073), `GET /api/client/hubspot/file/:fileId` (line 6695), `POST /api/webhooks/hubspot` (line 6748), `GET /api/hubspot/test` (line 7464), `GET /api/hubspot/pipelines` (line 7473), `GET /api/hubspot/record/:recordId` (line 7482), `GET /api/hubspot/stage-mapping` (line 7491), `PUT /api/hubspot/stage-mapping` (line 7500), `POST /api/projects/:id/hubspot-sync` (line 7597), `GET /api/hubspot/ticket/:ticketId/map-to-service-report` (line 9680).
  - DB keys that may go: `hubspot_stage_mapping` (lab pipeline stages), `hubspot_ticket_config`.

### Google Drive integration (`googledrive.js`)

- [ ] **UNCERTAIN — §8 says "document upload (re-point to Drive)"**
  Three functions are lab-specific (flagged in §4 and §5 above: `uploadSoftPilotChecklist`, `uploadServiceReportPDF`, `uploadServiceReportAttachment`).
  The following functions are reusable for GFC document upload:
  - Keep/repurpose: `testConnection()`, `findOrCreateFolder()`, `uploadHtmlFile()`, `uploadTaskFile()`, `deleteFile()`.
  - Strip: `uploadSoftPilotChecklist()`, `uploadServiceReportPDF()`, `uploadServiceReportAttachment()`.

### PDF generation (`pdf-generator.js`)

- [ ] **UNCERTAIN — §8 says "PDF generation (repurpose for care plans/consents)"**
  The entire current module is lab-specific (service reports and validation reports). The utility helpers (`fetchWithTimeout`, `fetchPhotoBuffer`) could be reused, but the module should be replaced or heavily rewritten for GFC care plan / consent PDF generation. Suggest replacing rather than stripping.

### `config.js` — shared sections

- [ ] **UNCERTAIN — review before removing:**
  - `SERVICE_REPORT_EDIT_WINDOW_MINUTES` (line 30), `SERVICE_REPORT_STATUSES` (line 80), `SERVICE_TYPE_MAP` (lines 41–56): all lab/service-report specific; remove when service reports are removed.
  - `HUBSPOT_*` constants (lines 34–38): review alongside HubSpot decision.
  - `STANDARD_PHASES` / `PHASE_ORDER` / `LEGACY_STAGE_TO_PHASE` (lines 82–122): replace with GFC care workflow phases.
  - `DEFAULT_ADMIN.EMAIL` = `bianca@thrive365labs.live` (line 183): update to GFC admin email.
  - `BRAND.COMPANY_NAME` = `'Thrive 365 Labs'` (line 126): update to `'Godwin\'s Family Care'`.
  - `EMAIL_FROM_ADDRESS` in `email.js` (line 16–17): `no-reply@thrive365labs.live` and `FROM_NAME = 'Thrive 365 Labs'` — update to GFC domain.

### Notification system (automated reminders)

- [ ] **UNCERTAIN — core infrastructure kept; lab-specific types removed**
  The notification queue and delivery system (`pending_notifications`, `notification_log`, `notification_settings` DB keys; `sendEmail` integration) is reusable GFC infrastructure. Only the lab-specific notification *types* should be removed (see §§2–7 above: `inventory_reminder`, `service_report_signature`, `service_report_review`, `milestone_reached` (lab concept), `golive_reminder`, `task_deadline`, `task_overdue`).

### `public/admin-hub.html` — shared sections

- [ ] **UNCERTAIN — partially lab, partially shared:**
  The admin hub itself (User Management, Inbox/Notifications, Dashboard) is reusable. Only the `ServicePortalPage` (lines 1873–3004) and `KnowledgeHubPage` (lines 3382–3735) sections are lab-specific and flagged above. The rest (Dashboard, Users, Inbox/Notifications pages) should be kept and rebranded.

### `public/portal.html` — shared sections

- [ ] **UNCERTAIN — partially lab, partially reused:**
  Per §5.1 of the master plan, `portal.html` is being converted (not deleted). Only these sections are stripped:
  - "Inventory" and sub-pages (InventoryPage, ReportsPage, AdminReportsPage, SubmissionHistoryPage) — flag for strip (see §2).
  - "Soft-Pilot Checklist" (SoftPilotForm, related state in MilestonesPage and App) — flag for strip (see §5).
  - "Launch Milestones" → converted to "Care plan summary + visit summaries" (do NOT strip the MilestonesPage component; repurpose it).
  - "Customer Support" → converted to Messaging (SupportPage component kept and rebranded).
  - "Files" → kept as Documents & signed consents (FilesPage kept; strip service-report-specific sub-logic).

### `public/login.html`

- [ ] **UNCERTAIN — keep and rebrand:**
  Login hub routes users to correct portal. Lab-specific branding (Thrive 365 logo, colors, text) must be replaced, but the routing logic is reused.

### `public/password-reset.html`

- [ ] **UNCERTAIN — keep:**
  Password reset page is generic; only branding needs updating.

### `debug-db.js`

- [ ] **UNCERTAIN — inspect before removing:**
  File exists at repo root (`/debug-db.js`). Not required in production; assess whether it is imported anywhere, then decide whether to keep for dev tooling or remove.

---

*Analysis completed 2026-06-10. No files were modified during this investigation.*
