# CLAUDE.md - AI Assistant Guide

> Comprehensive reference for AI assistants working on the Thrive 365 Labs Implementation App.
> Last updated: February 2026

---

## Project Overview

**Thrive 365 Labs Web App** is a full-stack clinical laboratory project management platform built for managing complex equipment installations (Biolis AU480 CLIA labs). It features a multi-portal architecture with role-based access, HubSpot CRM integration, Google Drive connectivity, and a 102-task template system.

**Current version**: 3.0.0
**License**: Proprietary - Thrive 365 Labs

---

## Tech Stack

| Layer | Technology | Notes |
|-------|------------|-------|
| **Runtime** | Node.js >= 14.0.0 | Runs on Replit with Node 20 |
| **Backend** | Express.js 4.18.2 | Single `server.js` file (~5,800 lines) |
| **Frontend** | React 18 (CDN) | Loaded via unpkg, Babel transpiles JSX in-browser |
| **Styling** | Tailwind CSS (CDN) | Configured inline in each HTML file |
| **Database** | Replit Database | Key-value store, no SQL |
| **Auth** | JWT + bcryptjs | 24-hour token expiration, 10-round salt |
| **PDF** | PDFKit + PDFMake | Service and validation reports |
| **Integrations** | HubSpot, Google Drive | OAuth via Replit connectors |
| **Deployment** | Replit autoscale | Port 5000 internal, 80 external |

**No TypeScript. No build step. No test framework. No state management library.**

---

## Directory Structure

```
/
├── server.js                          # Express API server (ALL backend routes)
├── hubspot.js                         # HubSpot connector module
├── googledrive.js                     # Google Drive connector module
├── pdf-generator.js                   # PDF generation for reports
├── changelog-generator.js             # Auto-generate changelog from git
├── package.json                       # Dependencies (node server.js start)
├── template-biolis-au480-clia.json    # 102-task default template (28KB)
├── .replit                            # Replit deployment config
├── README.md                          # Project documentation
├── CLAUDE.md                          # This file
├── public/                            # All frontend files
│   ├── index.html                     # Root HTML (redirects to login)
│   ├── login.html                     # Unified login portal hub
│   ├── app.js                         # Main React app (~7,760 lines)
│   ├── admin-hub.html                 # Admin dashboard portal
│   ├── portal.html                    # Client portal (~3,750 lines)
│   ├── service-portal.html            # Service engineer portal
│   ├── knowledge.html                 # Knowledge hub / docs
│   ├── changelog.html                 # Changelog viewer
│   ├── link-directory.html            # Resource links directory
│   ├── client.html                    # Legacy client view
│   ├── changelog.md                   # Markdown changelog content
│   └── banners/                       # Portal banner images
└── attached_assets/                   # Static assets
```

### Key Files to Know

| File | Lines | What it does |
|------|-------|-------------|
| `server.js` | ~5,800 | ALL backend: routes, auth middleware, DB operations, integrations |
| `public/app.js` | ~7,760 | Main React app: projects, tasks, templates, reporting |
| `public/portal.html` | ~3,750 | Client portal: milestones, inventory, support, documents |
| `public/login.html` | ~700 | Unified login hub that routes users to correct portal |
| `public/admin-hub.html` | ~1,500 | Admin dashboard: users, stats, feedback, settings |
| `public/service-portal.html` | ~2,500 | Service reports, validation reports, PDF generation |
| `hubspot.js` | ~80 | HubSpot token management via Replit connectors |
| `googledrive.js` | ~120 | Google Drive file operations |
| `pdf-generator.js` | ~500 | PDF document generation |

---

## Portal Architecture & Routing

| Portal | Route | Auth Required | Roles |
|--------|-------|--------------|-------|
| Unified Login | `/login` | No | All |
| Admin Hub | `/admin` | Yes | admin, hasAdminHubAccess |
| Launch App | `/launch/home` | Yes | admin, user (with hasImplementationsAccess) |
| Project View | `/launch/:slug` | Yes | admin, user (assigned) |
| Client Portal | `/portal/:slug` | Yes | client (assigned) |
| Service Portal | `/service-portal` | Yes | admin, vendor, hasServicePortalAccess |
| Knowledge Hub | `/knowledge` | No | Public |
| Changelog | `/changelog` | No | Public |
| Link Directory | `/directory` | No | Public |

### Legacy Redirects (301 permanent)

- `/thrive365labsLAUNCH/*` -> `/launch/*`
- `/thrive365labslaunch/*` -> `/launch/*`
- `/:slug` -> `/launch/:slug` (if slug matches a project)

---

## Authentication & Authorization

### Roles

| Role | Access |
|------|--------|
| `admin` | Full system access, all projects, all portals |
| `user` | Team member, assigned projects only |
| `client` | Client portal only, assigned projects |
| `vendor` | Service portal, assigned clients |

### Permission Flags (boolean, per-user)

```
hasServicePortalAccess      - Can access /service-portal
hasAdminHubAccess           - Can access /admin
hasImplementationsAccess    - Can access /launch
hasClientPortalAdminAccess  - Can admin client portal features
```

### Per-Project Access

```javascript
assignedProjects: [projectId, ...]
projectAccessLevels: { projectId: 'read' | 'write' | 'admin' }
assignedClients: [clientId, ...]  // vendor role only
```

### Token Flow

1. Login endpoint returns JWT (24h expiry)
2. Token sent as `Authorization: Bearer {token}` header
3. OR as `?token={token}` query param (file downloads only)
4. `authenticateToken` middleware verifies and fetches **fresh user data** on every request
5. Authorization middleware checks role/permissions after authentication

### Key Auth Endpoints

```
POST /api/auth/login          - Main login
POST /api/auth/client-login   - Client portal login
POST /api/auth/admin-login    - Admin hub login
POST /api/auth/service-login  - Service portal login
POST /api/auth/change-password - Password change
POST /api/auth/forgot-password - Request password reset
```

---

## Database Structure (Replit Key-Value Store)

| Key Pattern | Type | Contents |
|-------------|------|----------|
| `users` | Array | All user accounts |
| `projects` | Array | All projects |
| `tasks_{projectId}` | Array | Tasks for a specific project |
| `templates` | Array | Project templates |
| `announcements` | Array | Client-facing announcements |
| `activity_log` | Array | Audit trail (max 500 entries) |
| `password_reset_requests` | Array | Pending password resets |
| `feedback_requests` | Array | Bug reports/feedback |
| `client_documents` | Array | Client-facing documents |
| `service_reports` | Array | Service field reports |
| `validation_reports` | Array | Validation test reports |
| `inventory_template` | Object | Standard inventory items |
| `inventory_submissions_{slug}` | Array | Weekly inventory updates |
| `inventory_custom_{slug}` | Array | Client-specific inventory items |
| `hubspot_stage_mapping` | Object | Pipeline stage mappings |
| `portal_settings` | Object | Admin-configurable settings |
| `client_portal_domain` | String | Custom domain for portals |

### Database Access Pattern

```javascript
// Read (always provide fallback)
const items = (await db.get('key')) || [];

// Write (fetch, modify, save back)
const items = (await db.get('key')) || [];
items.push(newItem);
await db.set('key', items);
```

---

## Code Conventions

### Naming

- **Variables/functions**: `camelCase`
- **React components**: `PascalCase`
- **Database keys**: `snake_case` with `${variable}` interpolation
- **Handlers**: `handle{Action}` (e.g., `handleCreate`, `handleLogin`)
- **Data loaders**: `load{Entity}` (e.g., `loadProjects`)
- **Booleans**: `is{Condition}` or `has{Permission}`

### Frontend Patterns

- All portals follow same HTML template: CDN imports + inline Tailwind config + `<script type="text/babel">`
- React components use functional style with hooks (useState, useEffect, useMemo)
- API calls go through centralized `api` object (100+ methods in app.js)
- State management is local (useState only), no Redux/Zustand/Context providers
- Error display uses `alert()` throughout
- Token stored in `localStorage` with keys: `token`, `user`, `unified_token`, `portal_token`, etc.

### Backend Patterns

- All routes defined inline in `server.js` (no router files)
- Middleware chain: `authenticateToken` -> role check -> handler
- Errors return `{ error: "message" }` with appropriate HTTP status
- Activity logging via `logActivity()` helper
- ID generation uses `uuid` package
- Fresh user data fetched on every authenticated request

### API Response Format

```javascript
// Success
{ data: {...} }  // or { message: "..." }

// Error
{ error: "description" }

// HTTP codes: 400 (bad input), 401 (no token), 403 (forbidden), 404 (not found), 500 (server error)
```

### Brand/Styling

- Primary color: `#045E9F` (blue)
- Accent color: `#00205A` (dark navy)
- Font: Inter (with Open Sans fallback)
- Icons: Heroicons v2 (1.75 stroke weight)
- Glass-card effects with Tailwind CSS

---

## Gotchas and Pitfalls

This section documents known tricky behavior, edge cases, and common mistakes.

### 1. Task ID Type Coercion

Tasks can have numeric OR string IDs depending on whether they were created from templates or via the UI. **Always normalize IDs to strings when comparing.**

```javascript
// WRONG - will miss matches
tasks.findIndex(t => t.id === taskId);

// RIGHT
const normalizeId = (id) => typeof id === 'string' ? id : String(id);
tasks.findIndex(t => normalizeId(t.id) === String(taskId));
```

The `getRawTasks()` function returns tasks without normalization (for mutation), while `getTasks()` normalizes on read. Use `getRawTasks()` when you need to modify and save back to prevent "normalization drift."

### 2. Multiple localStorage Token Keys

Different portals store tokens under different keys. The app checks them in priority order:

```
token             - Main app (app.js)
unified_token     - Set by login hub (login.html)
admin_token       - Set by admin login
portal_token      - Set by client portal login
```

When debugging auth issues, check ALL of these keys. The login hub (`login.html`) sets up to 6 key-value pairs simultaneously.

### 3. Activity Log Silently Truncates at 500 Entries

```javascript
if (activities.length > 500) activities.length = 500;
```

Old activity entries are permanently deleted when the 500-entry limit is exceeded. There is no archive mechanism.

### 4. Slug Changes Break Client Portal URLs

When a client's `practiceName` changes, the slug is regenerated:

```javascript
if (practiceName !== user.practiceName) {
  users[idx].slug = generateClientSlug(practiceName, existingSlugs);
}
```

This **breaks existing client portal URLs** (`/portal/{old-slug}`). The old slug is not preserved or redirected.

### 5. Root-Level Catch-All Route

The `/:slug` route at the bottom of server.js performs a **database lookup on every root-level request** to check if the slug matches a project:

```javascript
app.get('/:slug', async (req, res, next) => {
  const projects = await getProjects(); // DB call on every unmatched route!
  const project = projects.find(p => p.clientLinkSlug === req.params.slug);
  if (project) res.redirect(301, `/launch/${req.params.slug}`);
  else next();
});
```

This is a performance concern and also issues 301 (permanent) redirects that browsers cache aggressively.

### 6. Fresh User Lookup on Every Request

`authenticateToken` fetches the full users array and does a linear search on every authenticated request:

```javascript
const users = await getUsers();
const freshUser = users.find(u => u.id === tokenUser.id);
```

This ensures permission changes take effect immediately, but is O(n) per request. With many users, this becomes a bottleneck.

### 7. HubSpot Token Caching is In-Memory Only

The HubSpot connector caches tokens in-memory with a 60-second refresh buffer. **Tokens are lost on server restart**, requiring a new OAuth handshake. If `REPLIT_CONNECTORS_HOSTNAME` is not set, all HubSpot operations fail silently.

### 8. JWT Secret Has a Weak Default

```javascript
const JWT_SECRET = process.env.JWT_SECRET || 'thrive365-secret-change-in-production';
```

If the `JWT_SECRET` environment variable is not set, the fallback is a predictable string. Always verify env vars are configured in production.

### 9. Bulk Operations Have No Atomicity

Bulk task updates and bulk deletes have no transaction support. If the operation fails midway, some tasks are updated and others are not. There is no rollback mechanism.

Additionally, bulk delete checks permissions on ALL tasks before deleting ANY. If the user lacks permission on a single task, the **entire** batch fails.

### 10. Forced Password Change Bypasses Current Password

When `requirePasswordChange` is `true` (set by admin reset or bulk reset), the change-password endpoint does **not** verify the current password. This is intentional for forced resets but must be handled carefully.

### 11. No Global Error Middleware

The app has try-catch blocks in individual routes but **no centralized error handler**. Unhandled async errors in middleware (especially in `authenticateToken`'s JWT callback) could crash the server.

### 12. File Upload is Memory-Only

```javascript
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
```

Files are stored in RAM (10MB limit), not on disk. They must be forwarded to Google Drive or HubSpot immediately. Large concurrent uploads can exhaust server memory. JSON body limit is separately set to 50MB.

### 13. Inventory Data Auto-Wrapping

Non-batch inventory items are silently wrapped:

```javascript
normalized[key] = { batches: [value || {}] };
```

If you pass inventory data not in `{ batches: [...] }` format, it gets auto-wrapped. This can cause confusion when debugging inventory submissions.

### 14. Date Parsing Year Threshold

Two-digit years are handled with a threshold:

```javascript
parseInt(year) > 50 ? '19' + year : '20' + year
```

Years > 50 are assumed 1900s. This will be a problem after 2050.

### 15. `getProjects()` Runs Migration on Every Call

The `getProjects()` helper converts old `hubspotDealId` to `hubspotRecordId` on every read. This is a legacy migration that adds overhead to every project retrieval.

### 16. CSV Import ID Remapping

When importing tasks via CSV, task IDs are remapped and dependencies are re-linked. This is complex logic with edge cases around string/number ID matching. Always test CSV imports with tasks that have dependencies.

### 17. React Anti-Patterns in Frontend

- Array index used as React key in some changelog entries (causes rendering bugs on reorder)
- 35+ useState calls in `ProjectTracker` component instead of useReducer
- No useCallback on event handlers (causes unnecessary child re-renders)
- `setTimeout` closures can capture stale state

### 18. Webhook Validation is Optional

```javascript
if (HUBSPOT_WEBHOOK_SECRET) { /* verify */ }
else { console.warn('HubSpot webhook secret not configured...'); }
```

If `HUBSPOT_WEBHOOK_SECRET` is not set, the webhook endpoint accepts all requests without validation.

---

## Debugging Guide

### Quick Start

```bash
# Start the server
npm start

# Server listens on PORT (default 3000, or env var)
# Access at http://localhost:3000
```

### Server-Side Debugging

#### Check Server Health

```bash
# Watch server output
node server.js

# Test if server responds
curl http://localhost:3000/api/health
```

#### Authentication Debugging

```bash
# 1. Login and get token
TOKEN=$(curl -s -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@example.com","password":"password"}' \
  | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).token))")

# 2. Test authenticated endpoint
curl -s http://localhost:3000/api/projects \
  -H "Authorization: Bearer $TOKEN" | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d)))"

# 3. Decode JWT payload (base64)
echo $TOKEN | cut -d. -f2 | base64 -d 2>/dev/null; echo
```

**Common auth failures:**
- `401 Unauthorized` - No token or malformed header (must be `Bearer {token}`)
- `403 Invalid token` - Token expired (24h) or wrong JWT_SECRET
- `403 User not found` - User deleted after token was issued
- `403 Access denied` - User lacks required role/permission flag

#### Database Debugging

Since there is no `debug-db.js` tool yet, inspect the database via API or add temporary logging:

```bash
# List all users (requires admin token)
curl -s http://localhost:3000/api/users \
  -H "Authorization: Bearer $TOKEN"

# List all projects
curl -s http://localhost:3000/api/projects \
  -H "Authorization: Bearer $TOKEN"

# List tasks for a project
curl -s http://localhost:3000/api/projects/{PROJECT_ID}/tasks \
  -H "Authorization: Bearer $TOKEN"
```

**Temporary database inspection** (add to server.js for debugging, remove after):

```javascript
// Add a temporary debug endpoint
app.get('/api/debug/db-keys', authenticateToken, requireAdmin, async (req, res) => {
  const keys = await db.list();
  res.json(keys);
});

app.get('/api/debug/db/:key', authenticateToken, requireAdmin, async (req, res) => {
  const data = await db.get(req.params.key);
  res.json({ key: req.params.key, type: typeof data, count: Array.isArray(data) ? data.length : null, data });
});
```

#### File Upload Debugging

```bash
# Upload a file to a task
curl -X POST http://localhost:3000/api/projects/{projectId}/tasks/{taskId}/files \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@/path/to/file.pdf"
```

**Common file issues:**
- Files > 10MB are rejected (multer limit)
- Files are stored in memory only, not on disk
- Files must be forwarded to HubSpot or Google Drive
- Check that integration connectors are configured

### Frontend Debugging

#### Browser DevTools

1. **Console tab** - Check for React errors, API failures, unhandled promises
2. **Network tab** - Filter by `Fetch/XHR` to see API calls and responses
3. **Application tab > Local Storage** - Inspect token keys: `token`, `unified_token`, `admin_token`, `portal_token`, `user`, `portal_user`
4. **Sources tab** - In-browser Babel transpilation means source is readable but not sourcemapped

#### Common Frontend Issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| Blank page after login | Wrong token key being read | Check localStorage for correct key per portal |
| Tasks not loading | Token expired | Re-login; check Network tab for 401/403 |
| Client portal 404 | Slug changed | Verify user's `slug` field matches URL |
| Stale data after edit | State not refreshed | Check if `loadProjects()` / `loadTasks()` is called after mutation |
| Phase/stage missing | Task has non-standard phase | Check `STANDARD_PHASES` in app.js lines 5-28 |

#### API Client Object

The frontend `api` object (app.js lines ~101-563) abstracts all API calls. Errors are caught and returned as `{ error: "message" }` instead of throwing. Check return values:

```javascript
const result = await api.updateTask(projectId, taskId, data);
if (result.error) {
  // Handle error - this is NOT an exception
  alert(result.error);
  return;
}
```

### Integration Debugging

#### HubSpot

```bash
# Test HubSpot connection
curl -s http://localhost:3000/api/hubspot/test \
  -H "Authorization: Bearer $TOKEN"

# Get pipelines (verifies API access)
curl -s http://localhost:3000/api/hubspot/pipelines \
  -H "Authorization: Bearer $TOKEN"
```

**HubSpot issues:**
- `REPLIT_CONNECTORS_HOSTNAME` not set -> all operations fail
- Token cached in memory -> lost on restart
- 60-second buffer before expiry -> may still fail if API is slow
- Check if HubSpot connector is enabled in `.replit` config

#### Google Drive

- Requires `GOOGLE_SERVICE_ACCOUNT_KEY` environment variable
- Used primarily for soft-pilot checklist uploads
- Check `googledrive.js` for connection logic

### Database Key Reference for Debugging

When investigating data issues, these are the most common keys to inspect:

```
users                           -> All user accounts (check roles, permissions, slugs)
projects                        -> All projects (check status, clientLinkSlug, hubspotRecordId)
tasks_{projectId}               -> Tasks for a project (check IDs, completed, dependencies)
activity_log                    -> Last 500 actions (check for recent errors)
password_reset_requests         -> Pending resets (check status)
service_reports                 -> Service reports (check clientSlug, status)
inventory_submissions_{slug}    -> Inventory data (check batch format)
```

### Common Debugging Workflows

#### "User can't access a project"

1. Check user's `role` field
2. Check user's `assignedProjects` array - does it contain the project ID?
3. Check `projectAccessLevels` for the specific project
4. Check if the project exists in the `projects` collection
5. Verify token is valid and contains correct user ID

#### "Client portal shows no data"

1. Verify client user has a `slug` field
2. Check that slug matches a project's `clientLinkSlug`
3. Verify project has tasks with `showToClient: true`
4. Check `portal_token` in localStorage is valid

#### "Task changes not saving"

1. Check Network tab for PUT request and response
2. Verify project access level is 'write' or 'admin'
3. Check for task ID type mismatch (string vs number)
4. Look for `getRawTasks` vs `getTasks` confusion in server.js

#### "HubSpot sync not working"

1. Test connection: `GET /api/hubspot/test`
2. Check `hubspot_stage_mapping` is configured
3. Verify project has `hubspotRecordId` and `hubspotRecordType`
4. Check server logs for HubSpot API error responses
5. Verify Replit connector is enabled and authenticated

---

## Development Workflow

### Starting Development

```bash
npm install     # Install dependencies
npm start       # Start server (node server.js)
```

No build step required. Frontend changes take effect on browser refresh (no-cache headers applied).

### Making Backend Changes

1. Edit `server.js` (or module files like `hubspot.js`)
2. Restart the server (`Ctrl+C` then `npm start`)
3. Test with curl or browser

### Making Frontend Changes

1. Edit files in `public/` directory
2. Hard-refresh browser (`Ctrl+Shift+R`) to bypass cache
3. Check browser console for Babel transpilation errors

### Adding a New API Endpoint

Follow the existing pattern in `server.js`:

```javascript
app.post('/api/your-endpoint', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { field1, field2 } = req.body;
    if (!field1) return res.status(400).json({ error: 'field1 is required' });

    // Database operation
    const items = (await db.get('your_key')) || [];
    items.push({ id: uuidv4(), field1, field2, createdAt: new Date().toISOString() });
    await db.set('your_key', items);

    // Activity logging
    await logActivity(req.user.id, req.user.name, 'created', 'your_entity', items[items.length - 1].id, { field1 });

    res.json({ message: 'Created successfully', data: items[items.length - 1] });
  } catch (error) {
    console.error('Error creating item:', error);
    res.status(500).json({ error: 'Failed to create item' });
  }
});
```

### Adding a New Frontend Feature

1. Add the API method to the `api` object in `app.js`
2. Create or update the React component
3. Wire up state with useState/useEffect
4. Follow existing error handling pattern (`if (result.error) { alert(result.error); return; }`)

### Environment Variables Required

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `PORT` | No | 3000 | Server port |
| `JWT_SECRET` | **Yes** | (weak default) | Token signing - MUST set in production |
| `HUBSPOT_PRIVATE_APP_TOKEN` | For HubSpot | None | HubSpot API access |
| `HUBSPOT_WEBHOOK_SECRET` | No | None | Webhook validation (recommended) |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | For GDrive | None | Google Drive credentials (JSON) |
| `REPLIT_CONNECTORS_HOSTNAME` | Auto-set | None | Replit connector URL |
| `REPL_IDENTITY` | Auto-set | None | Replit identity token |

---

## Data Models (Quick Reference)

### User

```javascript
{
  id: "uuid",
  email: "string",
  password: "bcrypt_hash",
  name: "string",
  role: "admin" | "user" | "client" | "vendor",
  hasServicePortalAccess: boolean,
  hasAdminHubAccess: boolean,
  hasImplementationsAccess: boolean,
  hasClientPortalAdminAccess: boolean,
  assignedProjects: ["projectId"],
  projectAccessLevels: { "projectId": "read|write|admin" },
  assignedClients: ["clientId"],         // vendor only
  practiceName: "string",               // client only
  slug: "string",                       // client only, auto-generated
  requirePasswordChange: boolean,
  createdAt: "ISO8601"
}
```

### Project

```javascript
{
  id: "uuid",
  name: "string",
  clientName: "string",
  projectManager: "string",
  status: "active" | "paused" | "completed",
  template: "templateId",
  hubspotRecordId: "string",
  hubspotRecordType: "companies" | "deals",
  clientLinkSlug: "string",
  goLiveDate: "YYYY-MM-DD",
  createdAt: "ISO8601",
  createdBy: "userId"
}
```

### Task

```javascript
{
  id: "numeric_or_uuid",                // WARNING: can be number or string
  phase: "Phase 0" | "Phase 1" | "Phase 2" | "Phase 3" | "Phase 4",
  stage: "string",
  taskTitle: "string",
  showToClient: boolean,
  completed: boolean,
  dateCompleted: "ISO8601",
  owner: "email",
  dueDate: "YYYY-MM-DD",
  startDate: "YYYY-MM-DD",
  dependencies: ["taskId"],
  notes: [{ id, content, createdBy, createdAt }],
  files: [{ id, filename, url, uploadedAt }],
  subtasks: [{ id, title, owner, dueDate, completed, notApplicable, status, showToClient }]
}
```

---

## API Endpoint Summary

90+ endpoints organized by domain. See README.md for the complete API reference table.

**Key endpoint groups:**
- `/api/auth/*` - Authentication (8 endpoints)
- `/api/projects/*` - Project CRUD + clone/export/import (9 endpoints)
- `/api/projects/:id/tasks/*` - Task management (15+ endpoints)
- `/api/templates/*` - Template management (8 endpoints)
- `/api/users/*` - User management (5 endpoints)
- `/api/admin/*` - Admin operations (12+ endpoints)
- `/api/hubspot/*` - HubSpot integration (7 endpoints)
- `/api/client-portal/*` - Client portal data (3 endpoints)
- `/api/announcements/*` - Announcements CRUD (4 endpoints)
- `/api/client-documents/*` - Document management (5 endpoints)
- `/api/service-reports/*` - Service reports (5 endpoints)
- `/api/validation-reports/*` - Validation reports (4 endpoints)
- `/api/inventory/*` - Inventory management (8 endpoints)
- `/api/service-portal/*` - Portal data (2 endpoints)
- `/api/changelog/*` - Changelog management (6 endpoints)

---

## Important Implementation Notes

### When Adding New Portals or Pages

1. Create HTML file in `public/` following existing template structure
2. Include CDN imports (React, ReactDOM, Babel, Tailwind)
3. Add inline Tailwind config with brand colors
4. Add route in `server.js` to serve the file
5. Add link in login hub (`login.html`) if applicable

### When Modifying Authentication

- Changes to user permissions take effect immediately (fresh lookup on every request)
- Token changes require re-login (24h expiry)
- Always use `authenticateToken` middleware as first middleware in chain
- Layer authorization middleware after: `requireAdmin`, `requireAdminHubAccess`, etc.

### When Working with the Database

- Always provide fallback defaults: `(await db.get('key')) || []`
- No transactions - design operations to be idempotent when possible
- Task keys use project ID: `tasks_${projectId}`
- Inventory keys use slug: `inventory_submissions_${slug}`
- Activity log caps at 500 entries automatically

### When Modifying Task Logic

- Always use `getRawTasks()` for mutations, `getTasks()` for reads
- Normalize task IDs to strings for comparisons
- Preserve `showToClient` flag when updating tasks
- Dependencies reference other task IDs - maintain referential integrity
- Subtask status can be `'Pending'`, `'Complete'`, or `'N/A'`

### When Working with CSV Import/Export

- Custom character-by-character parser handles quoted fields
- Header mapping is case-insensitive with whitespace normalization
- Task IDs are remapped on import (new IDs generated)
- Dependencies are re-linked after ID remapping
- Always test with tasks that have cross-dependencies

### When Modifying HubSpot Integration

- Token management is in `hubspot.js`, not `server.js`
- Tokens are cached in-memory only (60s refresh buffer)
- Always check `REPLIT_CONNECTORS_HOSTNAME` is available
- Stage mapping is stored in `hubspot_stage_mapping` DB key
- Sync is idempotent using stored `hubspotRecordId`
