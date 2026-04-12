# Plan: Dynamic Email Templates in Admin Notifications

## Context

The Notifications page in the admin hub already has: Overview, Queue, History, and Settings tabs. The queue system (`pending_notifications`, `notification_log`) and Resend integration (`email.js`) are fully functional. There are **9 email types** with hard-coded subject/body strings inline in `scanAndQueueNotifications()` (server.js lines 367-600) and the announcement sender (lines 3512-3580).

**Branch:** `claude/dynamic-email-templates-MAsnv` based on `claude/ensure-workflow-execution-RsHiY`

## Goal

Replace hard-coded email content with **database-stored, admin-editable templates** using `{{variable}}` placeholders, with a "Templates" tab in the existing Notifications page.

---

## Step 1: Backend — Template Data Model, Defaults & Rendering Helper

**File:** `server.js`

Add a `getEmailTemplates()` helper that reads from DB key `email_templates`, and if empty, seeds it with 9 default templates matching the current hard-coded content:

| Template ID | Name | Category | Variables |
|---|---|---|---|
| `service_report_signature` | Service Report — Signature Request | automated | `{{facilityName}}`, `{{technicianName}}`, `{{reportDate}}` |
| `service_report_review` | Service Report — Admin Review | automated | `{{facilityName}}`, `{{technicianName}}`, `{{reportAge}}` |
| `task_deadline` | Task Deadline Warning | automated | `{{taskTitle}}`, `{{projectName}}`, `{{phase}}`, `{{dueDate}}`, `{{timeframe}}` |
| `task_overdue` | Task Overdue — Owner | automated | `{{taskTitle}}`, `{{projectName}}`, `{{phase}}`, `{{dueDate}}`, `{{daysOverdue}}` |
| `task_overdue_escalation` | Task Overdue — Admin Escalation | automated | `{{taskTitle}}`, `{{projectName}}`, `{{ownerName}}`, `{{dueDate}}`, `{{daysOverdue}}` |
| `inventory_reminder` | Inventory Reminder | automated | `{{practiceName}}`, `{{daysSince}}` |
| `milestone_reached` | Milestone Reached | automated | `{{projectName}}`, `{{percentage}}`, `{{completedTasks}}`, `{{totalTasks}}` |
| `golive_reminder` | Go-Live Reminder | automated | `{{projectName}}`, `{{goLiveDate}}`, `{{daysUntil}}`, `{{percentage}}` |
| `announcement` | New Announcement | announcement | `{{title}}`, `{{content}}`, `{{priorityTag}}`, `{{attachmentUrl}}`, `{{attachmentName}}` |

**Template data model:**
```js
{
  id: "service_report_signature",     // matches notification type
  name: "Service Report — Signature Request",
  category: "automated",              // "automated" | "announcement"
  subject: "Action needed: Service report for {{facilityName}} awaits your signature",
  body: "A service report from {{technicianName}} on {{reportDate}} requires your signature. Please review and sign at your earliest convenience.",
  htmlBody: null,                     // null = use base wrapper around body
  variables: [
    { key: "facilityName", label: "Facility Name", example: "Valley Medical" },
    { key: "technicianName", label: "Technician Name", example: "John Smith" },
    { key: "reportDate", label: "Report Date", example: "02/17/2026" }
  ],
  isDefault: true,                    // flips to false once admin edits
  updatedAt: null,
  updatedBy: null
}
```

**`renderTemplate()` helper:**
```js
function renderTemplate(templateStr, variables) {
  return templateStr.replace(/\{\{(\w+)\}\}/g, (match, key) =>
    variables[key] !== undefined ? String(variables[key]) : match
  );
}
```

**Base HTML email wrapper** — a reusable branded layout stored as a constant (not a DB template), used when a template has no custom `htmlBody`. Contains:
- Thrive 365 Labs branded header (blue gradient `#045E9F`)
- Content area where rendered body is injected
- Footer with "You are receiving this because..." text

## Step 2: Backend — CRUD API Endpoints

**File:** `server.js`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/api/admin/email-templates` | admin | List all templates |
| `GET` | `/api/admin/email-templates/:id` | admin | Get single template with variables list |
| `PUT` | `/api/admin/email-templates/:id` | admin | Update subject, body, htmlBody |
| `POST` | `/api/admin/email-templates/:id/reset` | admin | Reset to shipped default |
| `POST` | `/api/admin/email-templates/:id/preview` | admin | Render with example data, return preview HTML+text |
| `POST` | `/api/admin/email-templates/:id/test-send` | admin | Send rendered test email to admin's own address |

All endpoints follow existing patterns: `authenticateToken` + `requireAdmin` middleware, try/catch with `logActivity()`.

## Step 3: Backend — Wire Templates into Notification Scanner

**File:** `server.js` — modify `scanAndQueueNotifications()` (lines 367-600)

At the top of the function, load templates once:
```js
const templates = await getEmailTemplates();
const getTemplate = (id) => templates.find(t => t.id === id);
```

For each notification type, replace the hard-coded `templateData` with:
```js
const tpl = getTemplate('service_report_signature');
const vars = { facilityName: report.clientFacilityName || 'your facility', ... };
const templateData = {
  subject: renderTemplate(tpl.subject, vars),
  body: renderTemplate(tpl.body, vars),
  htmlBody: tpl.htmlBody ? renderTemplate(tpl.htmlBody, vars) : renderTemplate(BASE_HTML_WRAPPER, { content: renderTemplate(tpl.body, vars) })
};
```

Same approach for the announcement email sender (lines 3512-3580) — load the `announcement` template and render with announcement variables instead of the hard-coded HTML.

**Fallback:** If `getEmailTemplates()` fails or a specific template is missing, fall back to the current hard-coded strings (graceful degradation).

## Step 4: Frontend — "Templates" Tab in NotificationsPage

**File:** `public/admin-hub.html` — modify the `NotificationsPage` component (line 3286+)

### 4a. Add "templates" to the tab bar
Add to the existing tab array `['overview', 'queue', 'history', 'settings']` → `['overview', 'queue', 'history', 'templates', 'settings']`

### 4b. Templates list view
When `activeTab === 'templates'`:
- Fetch `GET /api/admin/email-templates` on mount
- Display card grid, each card showing:
  - Category badge (Automated / Announcement)
  - Template name
  - Subject preview (truncated)
  - Last edited timestamp or "Default" badge
  - Edit button

### 4c. Template editor (inline expand or modal)
When user clicks Edit on a template:
- **Subject** text input with `{{variable}}` placeholders visible
- **Body** textarea with `{{variable}}` support
- **Available Variables** sidebar — lists all variables for this template with key, label, example value. Click-to-insert into subject or body cursor position.
- **Live Preview** panel — renders the template with example data in real-time (client-side rendering using the same `{{var}}` replacement)
- **HTML Preview** toggle — shows how the email will look wrapped in the base HTML layout
- **Actions:**
  - "Save" — `PUT /api/admin/email-templates/:id`
  - "Send Test Email" — `POST /api/admin/email-templates/:id/test-send`
  - "Reset to Default" — `POST /api/admin/email-templates/:id/reset` (with confirmation)
  - "Cancel" — discard changes

### 4d. State management
```js
const [templates, setTemplates] = useState([]);
const [editingTemplate, setEditingTemplate] = useState(null);
const [editForm, setEditForm] = useState({ subject: '', body: '', htmlBody: '' });
const [previewData, setPreviewData] = useState(null);
```

## Step 5: Testing

- Use the "Send Test Email" button on each template to verify rendering
- The existing `/api/admin/test-email` endpoint can be used as a baseline
- Preview panel provides instant visual feedback without sending

---

## Files Modified

| File | Changes |
|------|---------|
| `server.js` | `renderTemplate()` helper, `getEmailTemplates()` with default seeding, 6 new CRUD endpoints, modify `scanAndQueueNotifications()` and announcement sender to use templates, `BASE_HTML_WRAPPER` constant |
| `public/admin-hub.html` | Add "Templates" tab to NotificationsPage: template list, editor with variable sidebar, live preview, test send button |

## New Database Key

| Key | Type | Description |
|-----|------|-------------|
| `email_templates` | Array | All editable email template definitions |

## No New Dependencies

Everything uses existing `email.js` (Resend) and database patterns.
