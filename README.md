# Thrive 365 Labs — Client Portal Hub

A comprehensive platform for managing clinical laboratory implementations, service operations, and client engagement. The hub integrates launch management, field service reporting, client portals, notification automation, and CRM operations into a unified multi-portal system.

**Current Version**: 3.0.0
**Licensed To**: Thrive 365 Labs
**Perpetual License Granted By**: Bianca G. C. Ume, MD, MBA, MS / OnboardHealth (onboardhealth.live)
**Developer & Technical Support**: Bianca G. C. Ume, MD, MBA, MS (bianca@thrive365labs.com) / Luka - Full-Stack Developer

> **License Notice**: This software is proprietary technology developed and owned by Bianca G. C. Ume, MD, MBA, MS, operating under OnboardHealth. A perpetual, non-transferable license has been granted to Thrive 365 Labs for internal operational use. The underlying codebase, database architecture, and system infrastructure remain the exclusive intellectual property of the licensor. Redistribution, resale, or sublicensing of this software is not permitted without written consent from the licensor.

---

## Table of Contents

1. [Portal Management Overview](#portal-management-overview)
2. [Technical Stack](#technical-stack)
3. [Application Portals](#application-portals)
4. [Usage Guidelines](#usage-guidelines)
5. [Administrator Reference](#administrator-reference)
6. [Backend Access — Security & Structural Needs](#backend-access--security--structural-needs)
7. [Support & Maintenance](#support--maintenance)
8. [Open Source Licenses](#open-source-licenses)

---

## Portal Management Overview

Portal management encompasses the operational responsibilities required to maintain and administer the Thrive 365 Labs Client Portal Hub.

### User & Client Account Management
- Creating, editing, and deactivating user accounts across all roles
- Assigning role-based permissions and portal access flags
- Managing client practice profiles, portal slugs, and access credentials
- Processing password reset requests and first-login flows

### Branding & White-Label Customization
- Configuring client portal branding: name, welcome message, and primary color per client
- Uploading client logos and managing branded portal experiences
- Configuring custom domain settings for client-facing URLs
- Managing Knowledge Hub and Changelog content

### Reporting & Analytics Access
- Reviewing the Activity Log and audit trail via Admin Hub
- Exporting user lists and project data to Excel/CSV
- Monitoring inventory submissions, support ticket volume, and client activity
- Reviewing notification delivery history and automation performance

### Notification & Automation Management
- Enabling/disabling the notification queue and configuring send limits
- Setting automated reminders for overdue tasks, soft pilot submissions, client nudges, and inventory
- Managing client email subscription preferences
- Reviewing notification delivery history

### Resources Required

| Resource | Responsibility |
|----------|---------------|
| **Internal Admin** | Day-to-day user management, client onboarding, portal configuration |
| **Developer (bianca@thrive365labs.com)** | Backend updates, structural changes, integrations, security patches |
| **Replit Hosting** | Billed to Thrive 365 Labs; autoscale deployment managed by Bianca & Dev. |
| **Supabase Hosting** | Future upgrade — billed to Thrive 365 Labs as user database grows to require upgraded database hosting |
| **HubSpot CRM** | Maintained by Thrive team; sync configured by developer |
| **Google Drive** | Document storage; credentials managed via environment secrets |

---

## Technical Stack

| Layer | Technology | Notes |
|-------|------------|-------|
| **Runtime** | Node.js >= 14.0.0 | Hosted on Replit (Node 20) |
| **Backend** | Express.js REST API | Single `server.js` file |
| **Frontend** | React 18 (CDN via unpkg) | In-browser Babel JSX transpilation |
| **Styling** | Tailwind CSS (CDN) | Inline config per portal |
| **Database** | Replit Key-Value Store | No SQL; key-value pairs |
| **Authentication** | JWT + bcryptjs | 24-hour token expiry |
| **PDF Generation** | PDFKit, PDFMake | Service and validation reports |

### External Integrations

| Service | Purpose |
|---------|---------|
| **HubSpot** | CRM integration: deal/company pipeline sync, stage mapping, ticket management |
| **Google Drive** | Document storage for soft-pilot checklists and file hosting |
| **Resend Email** | Automated email notifications, reminders, and subscription management |

### Environment Variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `JWT_SECRET` | **Yes** | Token signing — always set in production |
| `PORT` | No (default: 3000) | Server port |
| `HUBSPOT_PRIVATE_APP_TOKEN` | For HubSpot | HubSpot API access |
| `HUBSPOT_WEBHOOK_SECRET` | Recommended | Webhook request validation |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | For Google Drive | Google service account credentials |
| `REPLIT_CONNECTORS_HOSTNAME` | Auto-set by Replit | Required for HubSpot/GDrive connectors |

> **Security Notice**: All environment variable values are stored in Replit Secrets and are not visible to collaborators. Contact bianca@onboardhealth.live for any credential or secrets management needs.

### Custom Domain Configuration

Configure via **Admin Hub > Settings > Client Portal Domain**.

---

## Application Portals

| Portal | URL | Auth | Purpose |
|--------|-----|------|---------|
| Unified Login | `/login` | No | Central authentication hub |
| Admin Hub | `/admin` | Yes | System administration, user management, automation |
| Launch App | `/launch/home` | Yes | Project implementation tracking and task management |
| Project View | `/launch/:slug` | Yes | Individual project board |
| Client Portal | `/portal/:slug` | Yes | Client-facing progress, inventory, documents, support |
| Service Portal | `/service-portal` | Yes | Field service reports, validation assignments, PDF generation |
| Knowledge Hub | `/knowledge` | Public | Documentation and guides |
| Changelog | `/changelog` | Public | Version history |
| Link Directory | `/directory` | Public | Resource links and quick references |

---

## Usage Guidelines

### User Roles & Permissions

| Role | Access Level |
|------|--------------|
| **Admin** | Full system access, all portals, all projects, user management |
| **Team Member** | Launch App (assigned projects), task management |
| **Client** | Client portal only (assigned practice) |
| **Vendor** | Service portal for assigned clients |

| Permission Flag | Portal Unlocked |
|-----------------|----------------|
| `hasImplementationsAccess` | Launch App (`/launch`) |
| `hasAdminHubAccess` | Admin Hub (`/admin`) |
| `hasServicePortalAccess` | Service Portal (`/service-portal`) |
| `hasClientPortalAdminAccess` | Client portal admin features |

### Portal Feature Overview

#### Unified Login Hub (`/login`)
Single sign-in for all roles; routes to appropriate portal after authentication. Includes forgot password flow, forced password change on first login, role and permission badges, and in-app feedback submission.

#### Launch App — Project Tracker (`/launch`)
Create projects from the 102-task Biolis AU480 CLIA implementation template. Phase-based task board (Phase 0 through Phase 4). Supports task management with owners, due dates, dependencies, subtasks, file attachments, CSV import/export, project cloning, HubSpot CRM sync, and go-live date management.

#### Client Portal (`/portal/:slug`)
- **Home**: Project summary, announcements, quick stats
- **Milestones**: Phase-by-phase task tracking with progress bars
- **Soft Pilot Checklist**: Multi-step form with digital signature capture
- **Inventory**: Weekly submission with batch tracking and history
- **Support**: Ticket submission and history with email notifications
- **Documents**: Client-facing documents by category
- **Validation Progress**: Multi-day validation tracking
- **Portal Admin**: Manage announcements, documents, and portal branding

#### Service Portal (`/service-portal`)
Field service report submission and management, multi-day validation assignments with day-by-day segment logging, vendor assignment tools, and PDF report generation.

#### Admin Hub (`/admin`)
Full system administration: user management, inbox (feedback and password reset requests), notification automation configuration, service and client portal settings, and activity log (last 500 entries).

### Best Practices

**Security**
- Change the default admin password immediately after first login
- Regularly review user access permissions and assigned projects
- New users are prompted to change their password on first login

**Project Management**
- Use the 102-task template as the starting point for new implementations
- Assign task owners by email for clear accountability
- Use draft status while configuring a new project; publish when ready for client visibility

**Client Portals**
- Configure a unique `clientLinkSlug` per client — changing the practice name regenerates the slug and breaks existing portal URLs
- Upload client logos for a branded portal experience
- Review inventory submissions weekly

---

## Administrator Reference

### Initial Admin Login

- **URL**: `/login`
- **Credentials**: Provided separately via secure channel by bianca@onboardhealth.live

> **Security Notice**: Admin credentials must never be stored in shared or version-controlled documents. Contact bianca@onboardhealth.live to receive or reset credentials.

### Key Admin Functions

**User Management**: Create/edit/deactivate accounts, assign roles and permission flags, process password resets, export user lists to Excel.

**Project Management**: Create from the 102-task template, clone existing projects, configure HubSpot stage mapping, manage draft/published status.

**Client Portal Administration**: Configure branding, manage announcements and documents, monitor inventory and support tickets, manage client profiles and portal slugs.

**Notification Automation**: Enable/disable queue, configure send limits and reminder scenarios, review delivery history, manage subscription preferences.

**System Settings**: Custom domain configuration, HubSpot integration, activity log, feedback inbox.

---

## Backend Access — Security & Structural Needs

> **Important**: Backend access is scoped exclusively to operational security and structural maintenance. Core database architecture, API logic, and infrastructure are proprietary and remain exclusively with the licensor. Do not attempt to access, modify, or replicate these components.

### What Thrive 365 Labs Can Access

| Access Type | Scope | How |
|-------------|-------|-----|
| **Replit Collaborator Access** | Frontend UI, branding files, config settings, deployment controls | Via Replit project invite |
| **Environment Variable Names** | Key names for integration reference only | Replit Secrets panel (values not visible) |
| **Deployment Controls** | Restart, redeploy, view logs | Replit dashboard |
| **Admin Hub Activity Log** | Audit trail of system actions | `/admin` portal |

### What Requires Developer Involvement

All of the following require a request to **umebianca@gmail.com / bianca@thrive365labs.com**:

- Changes to database structure or queries
- API integration updates (HubSpot, Google Drive, Resend)
- Environment variable value changes or new secrets
- Infrastructure scaling or hosting changes
- Security patches and dependency updates
- Any changes to core backend logic

---

## Support & Maintenance

**Primary Developer & Technical Support**
Bianca G. C. Ume, MD, MBA, MS
Luka is available as needed per Bianca communication

**How to Request Support**
1. Use the in-app feedback form (from the login hub) for non-urgent issues
2. Email bianca@thrive365labs.com for urgent or structural requests
3. Reference the Knowledge Hub (`/knowledge`) for role-specific documentation

**Hosting**: Replit autoscale deployment (port 5000 internal, 80 external). Hosting costs billed to Thrive 365 Labs.

---

## Open Source Licenses

| Package | License | Purpose |
|---------|---------|---------|
| express | MIT | Web application framework |
| react / react-dom | MIT | User interface library |
| tailwindcss | MIT | CSS utility framework |
| bcryptjs | MIT | Password hashing |
| jsonwebtoken | MIT | JWT authentication |
| axios | MIT | HTTP client |
| cors | MIT | Cross-origin resource sharing |
| body-parser | MIT | Request body parsing |
| multer | MIT | File upload handling |
| uuid | MIT | Unique identifier generation |
| pdfkit / pdfmake | MIT | PDF generation |
| googleapis | Apache-2.0 | Google Drive API integration |
| @hubspot/api-client | Apache-2.0 | HubSpot CRM integration |
| form-data | MIT | Form data handling |

---

## License

**Proprietary Software — Licensed to Thrive 365 Labs**

This software is owned by Bianca G. C. Ume, MD, MBA, MS / OnboardHealth (onboardhealth.live). A perpetual, non-exclusive, non-transferable license has been granted to Thrive 365 Labs for internal operational use. All intellectual property rights remain with the licensor. Unauthorized redistribution, sublicensing, or replication is strictly prohibited.

Licensing inquiries: umebianca@gmail.com

---

*Developed by Bianca Ume/OnboardHealth*
*Licensed to Thrive 365 Labs | Last Updated: March 2026*
