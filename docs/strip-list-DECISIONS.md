# Strip-List Decisions — FINAL (Bianca, 2026-06-10)

Execute alongside `docs/strip-list.md`. **This doc overrides the strip-list wherever they differ.**

## STRIP (remove the feature; fix all references so nothing dangles)
- **§1:** `template-biolis-au480-clia.json` and `zipFile.zip`. Leave `STANDARD_PHASES`/`PHASE_ORDER` for now (the tracker is repurposed later).
- **§2 Inventory module** — all (routes, DB keys, config constants, portal Inventory components, admin inventory section).
- **§3 Validation reports** — the analyzer-validation-specific workflow only: multi-day daily log, view/continue/complete-validation flows, validation routes, `validation_reports` DB key, `generateValidationReportPDF()` + `drawAnalyzersTable()`. **Keep** the shared signing infra (`SignaturePad`, `ServiceReportDetail`) that service reports use.
- **§5 Soft-pilot checklist** — all, including `SoftPilotChecklist` in `app.js` and `uploadSoftPilotChecklist()` in `googledrive.js`.
- **§6 Knowledge hub (lab)** — all.
- **§8 link-directory** — `link-directory.html` + the `/directory` route. (Changelog is KEPT, see below.)
- **Lab HubSpot** — strip the ticket/deal/service-report-mapping functions and their routes. Keep `hubspot.js` connector dormant (`getAccessToken`, `getHubSpotClient`, `testConnection`, `getOwners`). We use Notion for now.
- **Notification templates** — delete the seeded lab templates: `inventory_reminder`, `service_report_signature`, `service_report_review`, `milestone_reached`, `golive_reminder`, `task_deadline`, `task_overdue`. Keep the notification system and the admin template-creation/editing ability; GFC templates get recreated later.

## DEACTIVATE (do NOT delete)
- **§7 Project/launch tracker** — disable the `/launch` routes and hide its nav entry. Keep `app.js` and all tracker code intact for repurposing into client-launch management later.

## KEEP (retain; rebrand only)
- **§4 Service field reports — KEEP the whole feature.** Routes, permissions (`requireServiceAccess`), client-portal connections (`/api/client/service-reports*`), PDF functions, and components. This is the scaffold for GFC visit reports and the FNP review inbox. Keep `service-portal.html`.
- **`pdf-generator.js`** — keep (service reports use it; repurpose for care plans/consents).
- **`googledrive.js`** — keep core + the service-report upload funcs; strip only `uploadSoftPilotChecklist()`.
- **File upload/download capability** — keep.
- **Notification system** — keep (minus the seeded lab templates above).
- **Portals** — `admin-hub.html`, `service-portal.html`, `portal.html`, `login.html`, `password-reset.html`, `index.html` — keep, rebrand/revise.
- **Changelog (§8)** — keep `changelog.html`, `changelog.md`, `changelog-generator.js`, `/changelog`, `changelog` DB key; rebrand to the GFC change log.
- **`debug-db.js`** — keep (dev tooling, may repurpose).

## Brand cleanups (do during this pass)
- `config.js`: `BRAND.COMPANY_NAME` → `"Godwins Family Care"`; `DEFAULT_ADMIN.EMAIL` → `support@godwinsfamilycarellc.com`; remove inventory/validation-specific constants as those features go.
- `email.js`: `EMAIL_FROM_ADDRESS` → `no-reply@godwinsfamilycarellc.com`; `FROM_NAME` → `"Godwins Family Care"`.
- All contact emails → `support@godwinsfamilycarellc.com`.
