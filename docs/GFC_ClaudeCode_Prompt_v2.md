# CLAUDE CODE BUILD PROMPT
## Godwins Family Care LLC — Internal Operations & Care Management Platform
### Version 1.0 | Phase 1 Scope

---

## PROJECT CONTEXT

You are building a HIPAA-compliant internal operations and care management platform for **Godwins Family Care LLC (GFCLLC)**, a physician (MD) and family nurse practitioner (FNP)-owned personal care agency serving North Atlanta and Cobb County, Georgia.

This platform is being built by revising the core architecture of the **Thrive 365 Labs** app — a lab diagnostics platform that serves as the technical foundation for this build.

**BEFORE WRITING ANY CODE**, you must complete the following two steps:

**Step 1 — Feature Mapping:** Audit the entire Thrive 365 Labs codebase and map every existing feature, database table, and workflow to the features requested in this prompt. Identify what can be directly repurposed, what requires modification, and what is entirely new. Present this mapping clearly before proceeding. Do not rebuild or duplicate features that already exist in the codebase.

**Step 2 — Flag Before Stripping:** Identify all Thrive 365 Labs-specific features (lab diagnostics workflows, specimen tracking, diagnostic validation, lab result delivery, and any lab-specific UI) that need to be removed. Present this list and wait for confirmation before removing anything from the codebase.

We are building for non-medical personal care services and VA/C&P examiner management only at this stage.

The platform serves two distinct operational lines that share infrastructure but have separate workflows:

1. **Personal Care Services (PCS)** — Non-medical in-home care for elderly adults, with FNP-led clinical oversight
2. **VA Compensation & Pension / Medical Disability Examination (C&P / MDE)** — Scheduling, time tracking, and communication management for 1099 NP contractors performing disability exams under Loyal Source Government Services (LSGS) and Leidos QTC Health Services

---

## BRAND GUIDELINES

Apply consistently throughout all UI:

- **Primary Navy:** `#033D50` - stick to using this primarily for banners, header and footer or call-out text against cream banner and text that needs to be highlighted.
- **Gold (light):** `#F5CD85`
- **Gold (dark):** `#c9a44a`
- **Cream (banner):** `#FAF7F2`- stick to using this for primarily banners when the navy is not used. When cream used as banner, use the navy as text color.
- **Heading Font:** Cormorant Garamond (serif)
- **Body Font:** DM Sans (sans-serif)
- **Size:** at least 12 px, needs to be eligible to senior populations and middle aged group.
- **Tone:** Clinical but warm. Professional, not corporate. Never salesy.
- **Logo:** Use the logo attached to this initial prompt request.

---

## PHASE 1 BUILD SCOPE

Build only what is defined below. Do not add features beyond this scope. Flag anything that would require a decision before proceeding.

---

## USER ROLES & PERMISSIONS

Define strict role-based access control (RBAC) from the ground up. Every piece of data in the system must be scoped to a role.

*Note: The agency owner (MD) is the operational owner of the platform and operates as Admin. There is no separate MD system role.*

### Role 1: Admin (Owner)
- Full access to all modules, all clients, all caregivers, all contractors
- Can create/edit/deactivate users of any role
- Access to all reports, audit logs, and scheduling
- Can manage ROI and consent documentation
- Posts monthly schedules for both PCS and VA/C&P lines based on submitted availability

### Role 2: FNP / Examiner / Contractor
*This is a single role serving both operational lines. An FNP may operate in the PCS line, the VA/C&P line, or both.*
- Submit availability at minimum 30 days in advance (Admin uses this to post schedules)
- **PCS line:** Read/review all PCA visit notes and behavioral observation logs; add clinical flags, escalation notes, and care plan updates; cannot edit PCA-submitted notes (append-only); access to family communication portal; can message caregivers, case manager, and admin
- **VA/C&P line:** View their own posted exam schedule (read-only); message admin re: scheduling logistics
- No access to the other line's client records unless explicitly assigned

### Role 3: Case Manager
*Designated behavioral health oversight role (Courtney).*
- Access to PCS behavioral observation logs and escalation flags
- Can receive and respond to behavioral escalation messages from caregivers
- Can append case management notes to client records
- Can communicate with caregivers, FNP, and admin
- No access to VA/C&P module
- No access to scheduling, time tracking, or billing

### Role 4: PCA / Caregiver (W-2 employee)
- Access only to their assigned clients
- View available open shifts and self-select (pending admin approval)
- Accept or decline admin-assigned shifts
- Submit availability at minimum 30 days in advance
- Clock in / clock out per confirmed shift (GPS-tagged timestamp)
- Submit visit notes and behavioral observation logs after each shift
- View their own schedule and assigned care plans
- Can message: assigned clients, admin, and case manager (for behavioral escalations)
- Can view their own communications with clients in the family portal
- Cannot see provider-to-family or provider-to-client communications
- Cannot see other caregivers' clients or notes
- Cannot see rates, billing, or internal operational data

### Role 5: Client / Authorized Client Contact (PCS)
- Access only to their own care record
- Request shifts via client portal
- View their own visit summaries and care plan summary
- Can message via client portal:
  - Their assigned caregiver (only when a caregiver is actively assigned — messaging is disabled if no caregiver is assigned)
  - Admin (always available)
  - FNP (for clinical escalation — flagged and tracked with response status)
  - Case Manager (for behavioral or care concerns)
- Must have signed ROI on file before family portal is activated

### Role 6: Family / Authorized Contact (PCS)
- Read-only access to their loved one's care record
- Receive push notifications or in-app alerts when a behavioral flag is raised
- Must have signed ROI (Release of Information) on file before access is granted — system enforces this, no workaround
- Can view: visit summaries, care plan summary, and their own communications with the client and caregiver
- Can message via family portal:
  - Their loved one's assigned caregiver (only when caregiver is actively assigned)
  - Admin (always available)
  - FNP (for clinical questions or escalation — flagged and tracked)
- Cannot view provider-to-client or provider-to-family communications unless FNP explicitly shares
- Cannot submit or edit any documentation

---

## MODULE 1: PERSONAL CARE SERVICES (PCS)

### 1A. Client Profile
*Note: A finalized client profile template will be provided separately and reviewed for alignment with this spec before integration. For Phase 1 build, use a **placeholder form** with the fields listed below. Do not build a permanent form — build the data model to be fully flexible so the final template slots in without rearchitecting.*

**Placeholder fields (to be replaced by final template):**
- Full name, DOB, address, emergency contact
- Care needs summary (free text — labeled "Care Notes," not a clinical field)
- All current medications (name, dosage, frequency, prescribing provider) — also reflected in Care Plan
- Assigned care tier: Tier 1 (Essential ADL), Tier 2 (Comprehensive), or Tier 3 (Behavioral Support & Cognitive Wellness)
- Assigned primary caregiver and backup caregiver
- Consent and ROI status (signed / pending / expired) — displayed as a status badge
- Active care plan (see 1C)
- Visit history (all past visit notes, sorted by date)
- Behavioral observation history (sorted by date, filterable by flag level)
- Family contact portal access status

### 1B. PCA Visit Log
*Note: A finalized PCA visit log HTML form will be provided separately and reviewed for alignment with this spec before integration. For Phase 1 build, use a **placeholder form** with the fields listed below. Do not build a permanent form — build the submission workflow and data model to accommodate the final form when provided. Every submission must be automatically timestamped at the moment of submission. The form is completed by the PCA at the end of every visit.*

Design for speed — a PCA should complete this in under 3 minutes on a mobile device.

**Placeholder fields (to be replaced by final form):**
- Client name (auto-populated from assignment)
- Visit date, check-in time, check-out time (auto-populated from GPS check-in, editable)
- Visit type: Scheduled / Backup coverage / Emergency coverage
- Care tier delivered (auto-populated, overridable if scope changed)

**ADL/IADL Completion Checklist** (checkbox format, care tier drives which appear):
- Bathing / Grooming / Dressing / Toileting / Transfers / Feeding
- Meal preparation / Light housekeeping / Medication reminder given / Transportation / Errands
- Cognitive activity completed (Tier 3 only)

**Behavioral Observation** (required for Tier 3, optional for Tiers 1-2):
- Mood: Calm / Anxious / Agitated / Withdrawn / Other (free text)
- Appetite: Normal / Reduced / Refused / Other
- Sleep (reported by client or observed): Normal / Restless / Reported poor sleep
- Mobility: Normal / Decreased / Fall risk noted
- Cognition: Baseline / Mild confusion / Increased confusion / Disoriented
- Notable behavioral events: free text field (labeled "Behavioral Observations")
- Flag level: None / Monitor / Alert Clinical Team / Escalate Now

**Escalation Logic:**
- If PCA selects "Alert Clinical Team": Automatic in-app notification sent to FNP/MD role
- If PCA selects "Escalate Now": Push notification + SMS to FNP/MD + Admin. Requires a mandatory free-text description before submission.
- Escalation events are logged with timestamp and status (Received / Reviewed / Action Taken)

**General Visit Notes:** Free text field. Labeled "Notes from today's visit." Character limit: 1000.

**Submission:** PCA taps submit. Note is timestamped. PCA cannot edit after submission. Clinical team can append a clinical review note.

### 1C. Care Plan
*Note: A finalized care plan template will be provided separately and reviewed for alignment with this spec before integration. For Phase 1 build, use a **placeholder form** with the fields listed below. Build the data model with version control support so the final template slots in cleanly.*

**Placeholder fields (to be replaced by final template):**
- Care goals
- Scheduled visit days/times
- Assigned tasks per visit
- Behavioral protocols (Tier 3 clients)
- Escalation contacts
- Safety plan notes
- **Medications:** Full medication list — name, dosage, frequency, prescribing provider, pharmacy. Must match medications entered in client profile.
- Version controlled — every update creates a new version, old versions archived and viewable
- Care plan visible to PCA (read-only, relevant sections only — not clinical notes)
- Care plan visible to Family via portal (summary view only, not clinical notes or medication details unless FNP approves)

### 1D. Clinical Review Dashboard (FNP/MD)
- Inbox view: All visit notes flagged as "Alert Clinical Team" or "Escalate Now"
- Full visit log review: Browse any client's visit history chronologically
- Append clinical notes to any visit log (timestamped, role-labeled)
- Update care plan in response to patterns
- Mark escalation events as Reviewed with optional action note
- Report: Weekly behavioral summary per client (auto-generated from observation fields)

### 1E. Family Communication Portal
- Activated only after ROI is on file (system enforces this — no workaround)
- Family can view: Visit summaries, care plan summary, behavioral flag notifications (if FNP approves sharing)
- FNP/Admin can push a family update directly from the clinical review dashboard
- All family communications are logged with timestamp and sender role
- Family cannot message back through the portal in Phase 1 (read-only + notification only)

### 1G. Scheduling & Shift Management (PCS Only)

**Availability Submission:**
- All caregivers and FNPs submit their availability at minimum 30 days in advance
- Availability submission is a structured form (days of week, time windows, blackout dates)
- Admin reviews submitted availability and posts confirmed schedules

**Shift Posting:**
- Admin posts open shifts based on submitted availability and client needs
- Open shifts are visible to all active caregivers in the PCS module

**Bidirectional Shift Matching — Two Pathways:**

*Pathway A — Caregiver Self-Select:*
1. Client submits a shift request from their portal (date, time window, care needs)
2. Open shift is posted and visible to eligible caregivers
3. Caregiver self-selects the shift
4. Admin reviews and approves or declines the match
5. Caregiver and client are both notified of confirmation

*Pathway B — Admin Assignment:*
1. Admin proactively assigns a confirmed shift to a specific caregiver
2. Caregiver receives notification and can accept or decline
3. If declined, shift returns to open pool
4. Client is notified once assignment is confirmed

**Shift Status Lifecycle:** Open → Claimed/Assigned → Confirmed → In Progress → Completed

### 1H. Time Tracking (PCS Only)

- Once a shift is confirmed, caregiver can clock in via the app at shift start (GPS-tagged)
- Caregiver clocks out at shift end (GPS-tagged)
- Late clock-ins and early clock-outs are flagged to admin
- Total hours calculated automatically per shift and per pay period
- Time logs are exportable (CSV) for payroll processing
- Admin can edit time logs with a reason note (audit-logged)
- Caregivers can view their own time history only

### 1I. Communication Management (PCS — Bidirectional)

All communications are stored in the database with timestamps, sender role, and recipient role. This is a structured messaging system, not a general chat.

**Communication Channels:**

| From | To | Channel Label |
|------|-----|--------------|
| Client | Caregiver | Direct |
| Client | Admin | Support |
| Client | FNP | Clinical Escalation |
| Caregiver | Assigned Client | Direct |
| Caregiver | Admin | Operations |
| Caregiver | Case Manager (Courtney) | Behavioral Escalation |
| FNP | Caregiver | Clinical Oversight |
| FNP | Family | Care Update |
| Admin | Anyone | Admin Broadcast or Direct |
| Family | Caregiver | Family Portal |
| Family | Admin | Support |

**Visibility Rules:**
- Caregivers in family portal: Can see only their own communications with the client. Cannot see FNP-to-family or FNP-to-client communications.
- Family members: Can see only their communications with caregiver and admin. Cannot see provider communications unless FNP explicitly pushes a family update.
- Case Manager: Can see all behavioral escalation threads. Cannot see FNP clinical notes or family portal.
- FNP: Can see all communication threads relevant to their assigned clients. Can push updates to family portal.
- Admin: Full visibility across all channels.

**Escalation Messaging:**
- "Behavioral Escalation" messages to Case Manager are flagged and tracked as escalation events (same as behavioral observation flags from visit logs)
- "Clinical Escalation" messages from client to FNP are flagged and tracked with response status
- Each client has a consent record with the following tracked items:
  - Service Agreement: Signed / Pending
  - ROI — Family communication: Signed / Pending / Not applicable
  - ROI — Provider communication: Signed / Pending
  - Continuous monitoring consent (for future Phase 2 audio/video): Not yet activated
- Admin can upload signed PDF consent documents
- System displays a warning banner on any client record with incomplete consent
- Consent status visible to Clinical Team and Admin only

---

## MODULE 2: VA / C&P EXAMINER MANAGEMENT

This module is operationally separate from personal care. VA/C&P contractors do not interact with PCS client data. Scheduling in this module is minimal — admin posts schedules based on FNP/examiner 30-day advance availability submissions. There is no shift request workflow, no time tracking, and no clock in/out in this module.

### 2A. Contractor Profile
- Full name, NPI, license number, state(s) licensed
- 1099 contractor status confirmed
- Assigned exam categories (from LSGS or Leidos QTC)
- Pay rate tier (Level 1–5 per LSGS tiered DBQ-count structure, or per-exam category per Leidos QTC)
- Active / Inactive status

### 2B. Availability Submission
- FNP/Examiner submits availability at minimum 30 days in advance
- Structured form: days available, time windows, blackout dates
- Admin reviews and posts confirmed exam schedule based on submitted availability

### 2C. Exam Schedule (Admin-Managed, Read-Only for Contractors)
- Admin creates and posts the monthly exam schedule
- Contractors see only their own posted schedule (read-only)
- Admin sees all contractor schedules in a unified calendar view
- Schedule can be exported to iCal / Google Calendar
- Fields per appointment: Date, time, exam type, veteran reference ID (anonymized), location or telehealth flag, contracting entity (LSGS or Leidos QTC)

### 2D. Messaging (Admin ↔ Contractor)
- Direct messaging between Admin and each contractor
- Subject-threaded (not a general chat)
- Topics: Scheduling changes, credentialing follow-ups, invoice questions, general logistics
- HIPAA-compliant — no veteran PHI transmitted through this channel
- All messages logged and timestamped

---

## MONITORING MODULE (Phase 1 Foundation Only)

Do not build out full monitoring in Phase 1. Build the infrastructure scaffold so it can be activated in Phase 2 without rearchitecting.

### What to build now:
- A "Monitoring" tab visible only to Admin and Clinical Team — currently labeled "Coming Soon"
- A consent field in the client record for monitoring opt-in (inactive, but present)
- Data model: Create a `monitoring_events` table with fields for `client_id`, `timestamp`, `event_type` (motion / audio_alert / video_clip_reference), `reviewed_by`, `notes` — even if nothing writes to it yet
- API endpoint stub: `POST /api/monitoring/event` — accept but queue/log without processing
- When Phase 2 activates: real-time activity detection (motion sensor / audio triggers), optional video stream view for clinical team (consent-gated, HIPAA-compliant storage), wearable device data integration

---

## HIPAA & SECURITY REQUIREMENTS (Non-Negotiable)

These must be implemented from the start, not added later.

- **Encryption at rest:** AES-256 for all stored data including uploaded documents
- **Encryption in transit:** TLS 1.2 minimum for all API calls and data transmission
- **Role-based access control:** Enforced at the API layer, not just the UI
- **Audit logs:** Every PHI access, edit, and export logged with user ID, role, timestamp, and IP
- **Session management:** Auto-logout after 15 minutes of inactivity
- **Password policy:** Minimum 12 characters, MFA required for Admin and Clinical Team roles
- **Data hosting:** AWS (HIPAA-eligible) or equivalent — flag if architecture decision differs
- **BAA readiness:** Document all third-party services that touch PHI so a Business Associate Agreement can be executed
- **No PHI in URLs or logs:** Enforce this at routing and logging layer
- **Breach notification scaffold:** Log all security events. Flag any unauthorized access attempt to Admin immediately.

---

## TECHNICAL NOTES

- **Mobile-first design:** PCAs will use this on phones. All PCA-facing views must work cleanly on iOS and Android
- **Offline support for visit notes:** PCAs may be in areas with poor connectivity. Visit log form must be submittable offline and sync when connection restores
- **Admin dashboard:** Desktop-optimized. Clinical review and scheduling are Admin/FNP tasks done at a desk.
- **Database:** Use a relational model (PostgreSQL preferred) — behavioral observations and care notes need structured querying
- **File storage:** Uploaded documents (consent forms, care plans) stored in encrypted object storage (S3 or equivalent), not in the database
- **Notifications:** In-app, push (mobile), and SMS for escalation events. Email for lower-priority alerts.
- **No third-party analytics tools that touch PHI** (no Google Analytics on authenticated pages, no Meta Pixel anywhere)

---

## WHAT TO BUILD FIRST (Suggested Order)

1. **Feature mapping audit** — Map Thrive 365 Labs codebase to this spec before writing any new code
2. Authentication system with RBAC (all 6 roles)
3. Client profile with medication fields (Module 1A — template to be provided)
4. PCA Visit Log with offline support and auto-timestamp (Module 1B — form to be provided)
5. Scheduling, shift workflow, and time tracking (Modules 1G, 1H)
6. Communication management — bidirectional messaging with role-based visibility (Module 1I)
7. Clinical Review Dashboard — flag inbox + note append (Module 1D)
8. VA Contractor Profile + Availability Submission (Modules 2A, 2B)
9. VA Exam Schedule — admin-managed, read-only for contractors (Module 2C)
10. VA Messaging (Module 2D)
11. Care Plan with medications (Module 1C)
12. Family Portal + ROI enforcement (Modules 1E, 1F)
13. Monitoring scaffold (Phase 2 prep)
14. Audit logs, security hardening, and HIPAA review pass

---

## CONFIRMATION REQUIRED BEFORE PROCEEDING

Before writing any code, confirm understanding of the following by restating it back:

1. Complete a feature mapping audit of the Thrive 365 Labs codebase before building or stripping anything. Flag all lab-specific features to be removed and wait for confirmation.
2. Two separate operational modules (PCS and VA/C&P) sharing infrastructure but with no data crossover between caregivers and contractors.
3. Scheduling and time tracking live in PCS only. VA/C&P module has admin-posted schedules only — no time tracking, no shift requests.
4. Bidirectional shift matching workflow in PCS: caregivers can self-select open shifts (admin approves) OR admin can assign shifts to caregivers (caregiver accepts/declines).
5. All caregivers and FNPs/examiners submit availability at minimum 30 days in advance.
6. Communication is bidirectional and stored in the database. Role-based visibility is strictly enforced — caregivers cannot see provider communications, families cannot see clinical notes.
7. Family portal is gated by ROI — system must enforce this, not rely on user memory.
8. PCA notes are immutable after submission — FNP appends, does not edit.
9. Modules 1A, 1B, and 1C use placeholder forms for Phase 1. Final templates will be reviewed for alignment with this spec before integration. Data models must be flexible enough to accommodate final templates without rearchitecting.
10. Care plan must include full medication list.
11. Monitoring module is scaffolded but not activated in Phase 1.
12. HIPAA compliance is an architectural requirement from line one, not a later addition.
13. Mobile-first for PCA and client-facing views, desktop-optimized for Admin and FNP-facing views.
14. No billing, EVV, or Medicaid features.

Flag any ambiguities or missing decisions before building begins.

---

*Godwins Family Care LLC — Internal Use Only*
*Platform: GFC Care Management System v1.0*
