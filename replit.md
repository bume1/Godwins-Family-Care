# Godwins Family Care — Care Management Platform

> **Note (2026-08):** this file previously described the Thrive 365 Labs launch
> tracker this repo was converted from. That description was three sessions
> stale; the authoritative running status is **`CLAUDE.md`** (repo root), which
> is updated at the end of every build session. This file now carries only the
> Replit-environment facts.

## Overview

Internal operations and care management platform for Godwins Family Care LLC
(GFC), a physician- and nurse-practitioner-owned home health agency serving
North Atlanta and Cobb County, Georgia. Five tracks: Private Home Care (PHCP),
In-Home Primary Care (clinical, OpenEMR-backed), RPM (scaffold), Billing
(Track D), and IME / C&P exams (Track E).

See `README.md` for the architecture overview and `docs/` for the spec
documents (source of truth where code and spec disagree).

## Replit environment

- **Runtime:** Node 20, `npm start` → `server.js` (Express), port 5000.
- **Data:** Replit Database (KV) — **interim only**. TEST DATA ONLY until
  HIPAA-live; PHI moves to encrypted AWS RDS inside the BAA boundary
  (see `docs/GFC_App_Build_v2.md` §2 and CLAUDE.md environment reminders).
- **Frontend:** CDN React 18 + Babel standalone + Tailwind CDN, served from
  `public/` (portal.html, admin-hub.html, service-portal.html, login.html).
- **Documents/consents/email:** HIPAA Google Workspace (Drive + Gmail) under
  existing BAA.
- **Dormant lab code (do not delete):** the launch tracker (`app.js`,
  `/launch` routes → redirect to /login) and the HubSpot connector
  (`hubspot.js`) are intentionally retained but deactivated. See CLAUDE.md
  "Do not delete" note and `docs/strip-list-DECISIONS.md` §7.

## User Preferences

Preferred communication style: Simple, everyday language.
