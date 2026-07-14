# Godwins Family Care — Care Management Platform

Internal operations and care management platform for Godwins Family Care LLC (GFC), a physician- and nurse-practitioner-owned home health agency serving North Atlanta and Cobb County, Georgia.

The platform supports five operational tracks: private home care (PHCP), in-home primary care (PCHP + HBPC clinical), remote patient monitoring (RPM, scaffolded), billing across all lines (Track D), and IME / C&P disability exams under LSGS and Leidos QTC contracts (Track E).

Built HIPAA-compliant from line one. Not a lab platform. Not a marketing site.

---

## Tech stack

- **App:** Express + CDN React (existing repo, converted from a lab-diagnostics predecessor)
- **Auth:** JWT, MFA required for Admin and Clinical roles
- **Data:** Encrypted AWS RDS Postgres for operational PHI, HIPAA Google Workspace Drive for documents and consents, OpenEMR (FHIR R4) as clinical system of record
- **Payments:** Stripe with strict PHI segregation (neutral descriptors, no clinical text)
- **Claims:** Availity clearinghouse (837 out, 835 in) via OpenEMR
- **Eligibility:** Availity API (270/271) called from client profile
- **Hosting:** AWS inside a signed BAA boundary
- **Notifications:** HIPAA Google Workspace Gmail; SMS via Twilio HIPAA for escalations

---

## Repository layout

```
/
├── CLAUDE.md                          # running status, auto-loaded by Claude Code each session
├── README.md                          # you are here
├── docs/
│   ├── GFC_App_Build_v2.md            # master architecture and scope
│   ├── GFC_SESSION_PLAN.md            # session order, status, timeline
│   ├── GFC_Intake_and_Packet_Spec_v1.md
│   ├── GFC_Client_Care_Profile_Schema_v1.md
│   ├── GFC_Caregiver_Profile_Schema_v1.md
│   ├── GFC_Caregiver_Workspace_Spec_v1.md
│   ├── GFC_Matching_Engine_Spec_v1.md
│   ├── GFC_SessionN_ClaudeCode_Prompt.md      # one per session, paste-ready
│   ├── source-forms/                  # reference PHP/GAS implementations to port from
│   └── prototype/                     # visual reference HTML for the UI
├── public/                            # client-facing portal shell
├── server.js                          # Express entry
└── (application code)
```

---

## Where to start

**Business context or scope questions:** read `docs/GFC_App_Build_v2.md` first.

**What's built and what's next:** read `CLAUDE.md` at the repo root.

**Building a specific feature:** find the matching prompt at `docs/GFC_SessionN_ClaudeCode_Prompt.md`, paste into Claude Code.

**Understanding the data model:** `docs/GFC_Client_Care_Profile_Schema_v1.md` and `docs/GFC_Caregiver_Profile_Schema_v1.md`.

---

## Security and compliance

**No real client PHI in dev or test environments** until the app is running inside the AWS BAA boundary (Session 5 — Clinical HIPAA go-live). All work through that point uses synthetic or de-identified data only.

**BAAs on file** with AWS and HIPAA Google Workspace. Stripe is a documented exception, permitted only because PHI is architecturally segregated from Stripe payloads. Twilio HIPAA BAA required before SMS notifications go live.

**Audit log** captures every PHI access, edit, and export with user ID, role, timestamp, and IP. Retention 7 years.

**Not counsel-reviewed yet.** Consent language throughout the intake and packet spec is a working draft. Requires Georgia licensure consultant and legal review before HIPAA-live.

---

## Roles

Eight-role model when fully built out. Six roles are wired today; two (Owner and Billing/Coder) are scaffolded for future activation via a `hasBillingAccess` flag.

- **Owner** (future) — Founder / Executive Director. Full access including billing. Reserved for Bianca.
- **Admin** — operational owner. Sees billing now, until Owner and Billing/Coder roles split.
- **Clinical** — FNP. Charts to OpenEMR, reviews visit logs, sets care plans.
- **Case Manager** — behavioral oversight, escalation triage.
- **Caregiver** — PCA/CNA/LPN/Sitter. Mobile app, tier-branched visit log.
- **Client** — receives care. Portal access after enrollment complete.
- **Family** — read-only portal, gated by signed ROI-family.
- **Billing / Coder** (future) — billing scope only, no clinical read/write.

---

## Leadership

**Bianca G. C. Ume, MD, MBA, MS** — Founder / Executive Director
**Bethel Godwins, RN, MSN, FNP-C** — Founder / Clinical Director

`admin@godwinsfamilycarellc.com` · (404) 913-6705
4300 Paces Ferry Rd SE, Ste 500, Atlanta, GA 30339
