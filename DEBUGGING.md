# Debugging Guide for Thrive 365 Labs Implementation App

## Table of Contents
1. [Quick Start Debugging](#quick-start-debugging)
2. [Server-Side Debugging](#server-side-debugging)
3. [Frontend Debugging](#frontend-debugging)
4. [Database Debugging](#database-debugging)
5. [API Debugging](#api-debugging)
6. [Common Issues](#common-issues)
7. [Debug Tools](#debug-tools)
8. [Logging Best Practices](#logging-best-practices)

---

## Quick Start Debugging

### Enable Debug Mode

Add to your environment or run with DEBUG flag:
```bash
DEBUG=* node server.js
```

### Check Server Logs
The server logs all important operations including:
- Authentication attempts
- Database operations
- API requests
- File uploads
- HubSpot/Google Drive integrations

Look for console logs in the format:
```
[ENDPOINT] Operation: Details
```

---

## Server-Side Debugging

### 1. Enable Detailed Logging

The server uses `console.log()` and `console.error()` extensively. Key areas to monitor:

**Authentication Issues:**
```javascript
// Check in server.js around line 660+
console.log('Login attempt:', { email, role });
console.error('Login failed:', error);
```

**Database Operations:**
```javascript
// Check database reads/writes
const data = await db.get('key');
console.log('DB Read:', key, data);
```

**Service Reports:**
```javascript
// Photo uploads (line 5872+)
console.log('Uploading photos:', req.files.length);
console.log('Photo saved:', fileName, uploadDir);
```

### 2. Add Custom Debug Points

Insert logging at critical points:

```javascript
// Example: Debug task updates
app.put('/api/tasks/:id', async (req, res) => {
  console.log('=== TASK UPDATE DEBUG ===');
  console.log('Task ID:', req.params.id);
  console.log('User:', req.user.email, req.user.role);
  console.log('Updates:', req.body);
  console.log('========================');

  // ... rest of endpoint
});
```

### 3. Database State Inspection

Create a debug endpoint (admin only):

```javascript
// Add to server.js
app.get('/api/debug/db/:key', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin only' });
  }

  try {
    const data = await db.get(req.params.key);
    res.json({
      key: req.params.key,
      data,
      type: typeof data,
      length: Array.isArray(data) ? data.length : 'N/A'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
```

### 4. File System Debugging

Check if uploads directory exists and files are being saved:

```bash
# Check uploads directory
ls -la uploads/service-photos/
ls -la uploads/service-files/
ls -la uploads/documents/

# Check file permissions
stat uploads/service-photos/[filename]

# Watch for new files in real-time
watch -n 2 'ls -lt uploads/service-photos/ | head -10'
```

---

## Frontend Debugging

### 1. Browser Console Logs

The frontend includes detailed console logging in key areas:

**App.js (Main Dashboard):**
- Project loading: "Loading projects:", "Projects loaded:", "Error loading projects"
- Task updates: "Updating task:", "Task updated successfully"
- Phase collapse: State changes for `collapsedPhases`

**Service Portal (service-portal.html):**
- Line 2085+: Report counts and filtering
- Assigned reports: "Checking report:", "Report matches filters:"
- Photo uploads: FormData contents before API calls

**Admin Hub (admin-hub.html):**
- User management operations
- Vendor assignments
- Service report assignments

### 2. Network Tab Inspection

Open Chrome DevTools → Network tab:

**Check API Calls:**
1. Filter by "XHR" to see API requests
2. Look for failed requests (red status codes)
3. Inspect request/response payloads
4. Check headers for authentication tokens

**Common API Endpoints to Monitor:**
- `GET /api/projects` - Project data
- `PUT /api/tasks/:id` - Task updates
- `GET /api/service-reports` - Service reports
- `POST /api/service-reports/:id/photos` - Photo uploads
- `GET /api/vendors` - Vendor list

### 3. State Debugging

Use React DevTools or add debug helpers:

```javascript
// In app.js, add temporary debugging
useEffect(() => {
  console.log('State Update:', {
    projects: projects.length,
    tasks: tasks.length,
    collapsedPhases,
    viewType,
    selectedProject: project?.id
  });
}, [projects, tasks, collapsedPhases, viewType, project]);
```

### 4. Local Storage Inspection

Check browser local storage for:
- `token` - JWT authentication token
- `user` - User data
- Other cached data

```javascript
// Console commands
localStorage.getItem('token')
localStorage.getItem('user')
```

---

## Database Debugging

### Database Structure

The app uses Replit Database (key-value store). Key collections:

```javascript
// Main collections
'users'              // User accounts
'projects'           // Implementation projects
'tasks'              // Project tasks
'service_reports'    // Service reports
'validation_reports' // Validation reports
'vendors'            // External vendors
'announcements'      // System announcements
'inventory_activity' // Inventory tracking
'changelog'          // Version history
'knowledge_hub'      // Knowledge base articles
```

### Debug Database Contents

```javascript
// In Node.js REPL or debug endpoint
const Database = require('@replit/database');
const db = new Database();

// List all keys
const keys = await db.list();
console.log('Database keys:', keys);

// Get specific collection
const users = await db.get('users');
console.log('Users:', users);

// Count items
const serviceReports = await db.get('service_reports');
console.log('Total service reports:', serviceReports?.length || 0);

// Find specific item
const report = serviceReports.find(r => r.id === 'some-id');
console.log('Report:', report);
```

### Database Backup/Export

```javascript
// Export all data for debugging
app.get('/api/debug/export', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin only' });
  }

  try {
    const keys = ['users', 'projects', 'tasks', 'service_reports', 'vendors'];
    const export_data = {};

    for (const key of keys) {
      export_data[key] = await db.get(key);
    }

    res.json(export_data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
```

---

## API Debugging

### 1. Test API Endpoints with curl

```bash
# Login and get token
TOKEN=$(curl -X POST http://localhost:3000/api/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@example.com","password":"password"}' \
  | jq -r '.token')

# Test authenticated endpoint
curl http://localhost:3000/api/projects \
  -H "Authorization: Bearer $TOKEN"

# Test service report creation
curl -X POST http://localhost:3000/api/service-reports \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"clientFacilityName":"Test Facility",...}'
```

### 2. Test File Uploads

```bash
# Upload service report photo
curl -X POST http://localhost:3000/api/service-reports/[REPORT_ID]/photos \
  -H "Authorization: Bearer $TOKEN" \
  -F "photos=@/path/to/photo.jpg"

# Verify file is accessible
curl http://localhost:3000/uploads/service-photos/[FILENAME]
```

### 3. API Response Logging

Add middleware to log all API requests:

```javascript
// Add to server.js before routes
app.use('/api', (req, res, next) => {
  const start = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`[API] ${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
  });

  next();
});
```

---

## Common Issues

### Issue 1: Photos Not Displaying

**Symptoms:** Service report photos show broken image icons

**Diagnosis:**
1. Check browser Network tab for 404 errors on photo URLs
2. Verify photo URL in database: `GET /api/service-reports/[ID]`
3. Check if file exists on disk: `ls uploads/service-photos/`

**Solution:**
- Files should be saved to `uploads/service-photos/` (not `public/uploads/`)
- Server serves them at `/uploads/service-photos/` via `express.static`
- **Fixed in v2.7.5** - commit 2ebb222

### Issue 2: Authentication Failures

**Symptoms:** "Invalid token" or 401/403 errors

**Diagnosis:**
```javascript
// Check token validity
const jwt = require('jsonwebtoken');
const token = 'your-token-here';
try {
  const decoded = jwt.verify(token, process.env.JWT_SECRET || 'thrive365-secret-change-in-production');
  console.log('Token valid:', decoded);
} catch (error) {
  console.error('Token invalid:', error.message);
}
```

**Solution:**
- Check JWT_SECRET environment variable matches
- Verify token is being sent in Authorization header
- Check token expiration (default: 24 hours)

### Issue 3: Task Updates Not Saving

**Symptoms:** Task changes revert after page reload

**Diagnosis:**
1. Check browser console for errors
2. Verify API call succeeds in Network tab
3. Check database state: `db.get('tasks')`

**Solution:**
- Ensure user has edit permissions
- Check task ID matches exactly (string vs number)
- Verify project access level

### Issue 4: HubSpot Integration Errors

**Symptoms:** "HubSpot API error" messages

**Diagnosis:**
```javascript
// Test HubSpot connection
const hubspot = require('./hubspot');
hubspot.testConnection()
  .then(() => console.log('HubSpot connected'))
  .catch(err => console.error('HubSpot error:', err));
```

**Solution:**
- Verify HUBSPOT_ACCESS_TOKEN environment variable
- Check HubSpot API rate limits
- Ensure HubSpot object IDs are valid

### Issue 5: Replit Database Connection

**Symptoms:** "Database error" or timeout errors

**Diagnosis:**
```javascript
// Test database connection
const db = new Database();
db.set('test', 'value')
  .then(() => db.get('test'))
  .then(val => console.log('DB working:', val))
  .catch(err => console.error('DB error:', err));
```

**Solution:**
- Check Replit Database is active
- Verify no rate limiting
- Consider adding retry logic for transient errors

---

## Debug Tools

### 1. Database Inspector Script

Create `debug-db.js`:

```javascript
const Database = require('@replit/database');
const db = new Database();

async function inspect(key) {
  console.log(`\n=== Inspecting: ${key} ===`);
  const data = await db.get(key);

  if (!data) {
    console.log('No data found');
    return;
  }

  if (Array.isArray(data)) {
    console.log(`Type: Array, Length: ${data.length}`);
    if (data.length > 0) {
      console.log('First item:', JSON.stringify(data[0], null, 2));
      console.log('Last item:', JSON.stringify(data[data.length - 1], null, 2));
    }
  } else if (typeof data === 'object') {
    console.log('Type: Object');
    console.log('Keys:', Object.keys(data));
    console.log('Data:', JSON.stringify(data, null, 2));
  } else {
    console.log('Type:', typeof data);
    console.log('Value:', data);
  }
}

async function main() {
  const keys = process.argv.slice(2);

  if (keys.length === 0) {
    console.log('Usage: node debug-db.js <key1> [key2] ...');
    console.log('\nAvailable keys:');
    const allKeys = await db.list();
    allKeys.forEach(key => console.log(`  - ${key}`));
    return;
  }

  for (const key of keys) {
    await inspect(key);
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
```

**Usage:**
```bash
node debug-db.js service_reports
node debug-db.js users projects tasks
```

### 2. Health Check Endpoint

Add to server.js:

```javascript
app.get('/api/health', async (req, res) => {
  const health = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    checks: {}
  };

  // Check database
  try {
    await db.get('users');
    health.checks.database = 'ok';
  } catch (error) {
    health.checks.database = 'error: ' + error.message;
    health.status = 'degraded';
  }

  // Check file system
  try {
    await fs.access('uploads/service-photos');
    health.checks.uploads = 'ok';
  } catch (error) {
    health.checks.uploads = 'error: ' + error.message;
    health.status = 'degraded';
  }

  res.json(health);
});
```

**Usage:**
```bash
curl http://localhost:3000/api/health
```

### 3. Request Logger Middleware

```javascript
// Add detailed request logging
app.use('/api', (req, res, next) => {
  console.log('\n=== API Request ===');
  console.log('Time:', new Date().toISOString());
  console.log('Method:', req.method);
  console.log('Path:', req.path);
  console.log('Query:', req.query);
  console.log('Body:', JSON.stringify(req.body, null, 2));
  console.log('User:', req.user?.email || 'Not authenticated');
  console.log('==================\n');
  next();
});
```

---

## Logging Best Practices

### 1. Structured Logging

Use consistent log formats:

```javascript
// Good - structured
console.log('[SERVICE_REPORTS] Upload started', {
  reportId: report.id,
  userId: req.user.id,
  fileCount: req.files.length
});

// Bad - unstructured
console.log('uploading files to report');
```

### 2. Log Levels

Implement log levels:

```javascript
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const levels = { debug: 0, info: 1, warn: 2, error: 3 };

function log(level, message, data) {
  if (levels[level] >= levels[LOG_LEVEL]) {
    console.log(`[${level.toUpperCase()}] ${message}`, data || '');
  }
}

// Usage
log('debug', 'Processing task update', { taskId: 123 });
log('info', 'Task updated successfully');
log('warn', 'Deprecated API endpoint used');
log('error', 'Failed to save task', { error: err.message });
```

### 3. Sensitive Data Handling

Never log sensitive information:

```javascript
// Good - redacted
console.log('User login:', {
  email: user.email,
  password: '[REDACTED]'
});

// Bad - exposes password
console.log('User login:', {
  email: user.email,
  password: user.password
});
```

### 4. Error Context

Always log error context:

```javascript
try {
  await updateTask(taskId, updates);
} catch (error) {
  console.error('Task update failed', {
    taskId,
    updates,
    error: error.message,
    stack: error.stack
  });
  throw error;
}
```

---

## Performance Debugging

### 1. Slow Endpoint Detection

```javascript
// Track slow endpoints
app.use((req, res, next) => {
  const start = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - start;
    if (duration > 1000) { // Warn if > 1 second
      console.warn(`[SLOW] ${req.method} ${req.path} took ${duration}ms`);
    }
  });

  next();
});
```

### 2. Memory Leak Detection

```javascript
// Monitor memory usage
setInterval(() => {
  const usage = process.memoryUsage();
  console.log('Memory:', {
    rss: Math.round(usage.rss / 1024 / 1024) + 'MB',
    heapUsed: Math.round(usage.heapUsed / 1024 / 1024) + 'MB',
    heapTotal: Math.round(usage.heapTotal / 1024 / 1024) + 'MB'
  });
}, 60000); // Every minute
```

---

## Production Debugging

### 1. Error Tracking

Consider implementing error tracking:

```javascript
// Centralized error handler
app.use((err, req, res, next) => {
  console.error('[ERROR]', {
    message: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
    user: req.user?.email
  });

  // Send to error tracking service (e.g., Sentry)
  // sentry.captureException(err);

  res.status(500).json({
    error: 'Internal server error',
    requestId: req.id // Add request ID middleware
  });
});
```

### 2. Debug Mode Toggle

```javascript
const DEBUG = process.env.DEBUG === 'true';

if (DEBUG) {
  // Enable verbose logging
  // Disable caching
  // Add debug endpoints
}
```

---

## Quick Reference

### Essential Debug Commands

```bash
# Server logs
tail -f logs/server.log

# Database inspection
node debug-db.js service_reports

# API health check
curl http://localhost:3000/api/health

# Check file uploads
ls -lt uploads/service-photos/ | head

# Network debugging
tcpdump -i any -A -s 0 port 3000

# Process monitoring
ps aux | grep node
```

### Useful Browser Console Commands

```javascript
// Get current user
JSON.parse(localStorage.getItem('user'))

// Check auth token
localStorage.getItem('token')

// Clear cache and reload
location.reload(true)

// Log all fetch requests
window.fetch = new Proxy(window.fetch, {
  apply(target, thisArg, args) {
    console.log('Fetch:', args);
    return target.apply(thisArg, args);
  }
});
```

---

## Getting Help

If you're still stuck:

1. Check the [CHANGELOG](/changelog) for recent fixes
2. Review server logs for error messages
3. Test with curl to isolate frontend vs backend issues
4. Check browser console for JavaScript errors
5. Verify environment variables are set correctly
6. Create a minimal reproduction case
7. Document steps to reproduce the issue

---

**Last Updated:** February 17, 2026 (v3.0.0)
