# Thrive 365 Labs Web App

## Overview
Thrive 365 Labs Web App is a multi-project launch tracker designed for managing complex clinical laboratory equipment installations. It automates and streamlines the process from contract signing to go-live, encompassing CLIA certification, equipment procurement, LIS/EMR integration, and staff training. The application features a 102-task template for Biolis AU480 CLIA lab setups, robust admin controls, team member accounts, and embeddable, unauthenticated client portals for external stakeholders to monitor progress. The project aims to significantly enhance efficiency, transparency, and communication in laboratory equipment launches, addressing a critical market need for specialized project management within the clinical laboratory sector.

## User Preferences
Preferred communication style: Simple, everyday language.

## System Architecture

### UI/UX Decisions
- **Branding**: Thrive 365 Labs logo, primary color #045E9F (blue), accent color #00205A (dark navy), Open Sans font.
- **Client Portal**: Authenticated client portal at `/portal/{slug}` with practice-specific logins, offering navigation for Home, Launch Milestones, Inventory (with Weekly Update and Reports & Alerts), Customer Support, and Files. Admins can upload client logos and configure HubSpot embed codes for forms and a customer support URL.
- **Announcements Manager**: Admin tool for client portal announcements.
- **Reporting**: "Launch Reports" page with summary statistics and charts (Launches by Client, Go-Live Timelines).
- **Activity Log**: Admin-only view of system activities.
- **Go-Live Date & Calendar**: Displays `goLiveDate` for projects on cards and client views. An "Implementations Calendar" shows all go-live dates with Month/Year views, including project entries and color-coded statuses.
- **Responsive Design**: Optimized for desktop and mobile with a hamburger menu, collapsible sidebar, and responsive grids.
- **SVG Icon System**: Branded SVG icons used throughout the application.
- **Project Notes Log**: Collapsible side panel showing aggregated notes from all tasks in a project, chronologically ordered, with full context.

### Technical Implementations
- **Backend**: Express.js REST API with JWT authentication and `bcryptjs` for password hashing.
- **Frontend**: React 18 (CDN-loaded), Babel standalone for JSX, and Tailwind CSS (CDN) as a Single-Page Application.
- **Data Storage**: Replit Database (key-value store) for users, projects, tasks, password reset requests, HubSpot mappings, activity logs, client documents, and inventory submissions.
- **Authentication**: JWT-based, role-based access (admin vs. regular user), and admin-managed password resets.
- **Project Access Control**: Admins manage all projects; regular users access assigned projects only.
- **Task Management**: 103-task template system organized by 10 phases (Contract & Initial Setup, Financials/CLIA/Hiring, Tech Infrastructure/LIS, Inventory Forecasting, Supply Orders, Onboarding/Welcome Calls, Virtual Soft Pilot, Training/Validation, Go-Live, Post-Launch Support), email-based owner assignment, subtasks with completion enforcement, bulk operations, and task descriptions. Subtasks support optional due dates and are visible to clients when the parent task is.
- **Phase Structure**: 10 sequential phases based on the QUA Launch Project Timeline (Phase 1-10), with phase-only grouping (no nested stages) for simplified project tracking.
- **Template System**: Project cloning and task template application from JSON; creation of templates from existing launch boards.
- **CSV Import**: Bulk task import for templates and projects.
- **HubSpot Integration**: OAuth-based configuration, stage mapping, automated task/stage completion notes sync, manual sync, and file uploads directly to HubSpot records (Company, Deal, Contact) using a private app token. Automatic note syncing to HubSpot.
- **Reporting**: Launch reports and inventory reports with charts and analytics.
- **Admin Activity Logging**: Logs task completions, reopenings, and updates.
- **Custom Domain & URL**: Support for custom domains for application and client portals.
- **Soft-Pilot Checklist**: Client-facing required form accessible from portal milestones (Phase 7) and Files section. Tasks tagged "softpilot" are included. Admins/managers can edit in the launch board. Generates HTML documents for Google Drive upload and HubSpot linking on submission.
- **Bulk Task Editing**: Bulk select mode supports editing multiple task fields (owner, due date, phase, tags, client visibility) in addition to marking complete/incomplete/delete.
- **Inventory Management System**: Quick Update Table with 79 items, batch tracking, custom items, weekly submissions with history tracking.
- **Client File Uploads**: Clients can upload files directly to their project's HubSpot record.
- **Admin Document Management**: Admins can add documents via cloud link or direct file upload.
- **HubSpot Webhook Integration**: Endpoint for receiving HubSpot form submission notifications.
- **Task Tagging System**: Admins and team members can add tags to tasks for grouping and filtering, with a predefined global tag library.
- **Task Reordering**: Admins can reorder tasks within stages. Tasks are automatically sorted by due date first, then by manual order.
- **Task File Attachments**: Admins can upload files (PDF, images, Word, Excel, text) to tasks, stored in Google Drive. Files are visible to clients when the parent task is client-visible. A paperclip icon (📎) appears next to task names across all views when files are attached. Uploading to client-visible tasks triggers automatic notification emails to assigned clients with deep links to the task.
- **Client Portal Task Anchors**: Email notification links use `#task-{taskId}` anchors to scroll directly to specific tasks in the portal milestones view, auto-expanding the relevant phase.
- **Client Portal Onboarding Files**: Task file attachments from client-visible tasks automatically appear in the "Onboarding Documents" section of the client portal Files page.
- **Timeline Sorting**: Tasks in timeline views are sorted by due date (earliest first), with tasks without due dates appearing last.
- **Data Normalization**: Admin utilities for normalizing subtask data inconsistencies and regenerating slugs.
- **Idempotent HubSpot Sync**: Tasks and notes store HubSpot IDs to prevent duplicates on subsequent syncs.
- **Subtask Notifications**: Subtasks with owners and due dates receive the same deadline warning, overdue, and admin escalation notifications as main tasks. Uses templates `subtask_deadline`, `subtask_overdue`, and `subtask_overdue_escalation`.
- **Task Assignment Notifications**: Automatic email notification when a task or subtask is assigned to someone (on create or owner change). Uses `task_assignment` template. Skips self-assignment (won't notify if you assign to yourself).

### System Design Choices
- **Modularity**: Clear separation of frontend and backend.
- **Scalability**: CDN-based frontend and key-value store for flexible data handling.
- **Security**: JWT for authentication, bcrypt for password hashing.
- **User Experience**: Streamlined workflows, intuitive reporting, and client-facing transparency.

## External Dependencies

### Third-Party Services
- **HubSpot**: CRM integration for deal pipeline, client profiles, and file uploads.
- **Google Drive**: Storage for soft-pilot checklist uploads.
- **Resend**: Email delivery service using Batch API (`resend.batch.send()`) for bulk sends and single API for individual emails.
- **Replit Database**: Primary data persistence.

### NPM Packages
- `express`
- `cors`
- `bcryptjs`
- `jsonwebtoken`
- `uuid`
- `@replit/database`
- `body-parser`
- `googleapis`
- `multer`

### CDN Dependencies (Frontend)
- React 18
- ReactDOM 18
- Babel standalone
- Tailwind CSS

### Environment Variables
- `PORT`
- `JWT_SECRET`
- `HUBSPOT_WEBHOOK_SECRET`
- `HUBSPOT_PRIVATE_APP_TOKEN`