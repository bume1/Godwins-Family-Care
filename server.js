const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const Database = require('@replit/database');
const bodyParser = require('body-parser');
const fs = require('fs').promises;
const path = require('path');
const multer = require('multer');
const hubspot = require('./hubspot');
const googledrive = require('./googledrive');
const pdfGenerator = require('./pdf-generator');
const changelogGenerator = require('./changelog-generator');
const config = require('./config');
const { sendEmail, sendBulkEmail, sendBatchEmails } = require('./email');
const roiRepo = require('./roiRepository');           // Transfer-of-Care ROI data model (Session 3.4)
const legacySync = require('./legacySync');            // ROI parallel-run legacy sync (Session 3.4)

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.MAX_FILE_SIZE }
});

// Concurrent upload limiter to prevent memory exhaustion (Gotcha #12)
// Files are memory-only; limit concurrent uploads to prevent OOM
const MAX_CONCURRENT_UPLOADS = config.MAX_CONCURRENT_UPLOADS;
let _activeUploads = 0;

const uploadLimiter = (req, res, next) => {
  if (_activeUploads >= MAX_CONCURRENT_UPLOADS) {
    return res.status(503).json({ error: 'Server busy processing uploads. Please try again in a moment.' });
  }
  _activeUploads++;
  res.on('finish', () => { _activeUploads--; });
  res.on('close', () => { _activeUploads--; });
  next();
};

const app = express();
const db = new Database();
// Transfer-of-Care ROI repository (Session 3.4) — three KV collections
// (consent_events / consent_provider_authorizations / consent_records_categories)
// bound to the same db, keyed for a later RDS migration.
const roiStore = roiRepo.createRepository(db);
const PORT = config.PORT;

// HubSpot ticket polling timer reference
let hubspotPollingTimer = null;
const JWT_SECRET = config.JWT_SECRET;
const HUBSPOT_STAGE_CACHE_TTL = config.HUBSPOT_STAGE_CACHE_TTL;
const HUBSPOT_POLL_MIN_SECONDS = config.HUBSPOT_POLL_MIN_SECONDS;
const HUBSPOT_POLL_MAX_SECONDS = config.HUBSPOT_POLL_MAX_SECONDS;

// Startup security warnings
if (!process.env.JWT_SECRET) {
  console.warn('⚠️  WARNING: JWT_SECRET environment variable not set. Using weak default secret.');
  console.warn('   This is a SECURITY RISK in production. Set JWT_SECRET to a strong random value.');
}

app.use(cors());
app.use(bodyParser.json({ limit: config.BODY_PARSER_LIMIT }));

// Static file options with no-cache headers for development
const staticOptions = {
  etag: false,
  lastModified: false,
  setHeaders: (res) => {
    Object.entries(config.NO_CACHE_HEADERS).forEach(([k, v]) => res.set(k, v));
  }
};

// Disable caching to prevent stale content issues
app.use((req, res, next) => {
  Object.entries(config.NO_CACHE_HEADERS).forEach(([k, v]) => res.set(k, v));
  next();
});

// ============== ROOT ROUTE - UNIFIED LOGIN ==============
// Root serves the unified login page (MUST be before static middleware)
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/login.html');
});

// Serve static files for the main app path
// Note: index: false prevents serving index.html automatically for directory requests
app.use('/launch', express.static('public', { ...staticOptions, index: false })); // tracker deactivated (Session 2): assets served, index page disabled
// Legacy root paths with trailing slash - redirect before static middleware intercepts
app.get('/thrive365labsLAUNCH/', (req, res) => {
  res.redirect(301, '/launch');
});
app.get('/thrive365labslaunch/', (req, res) => {
  res.redirect(301, '/launch');
});
// Legacy paths - keep for backward compatibility
app.use('/thrive365labsLAUNCH', express.static('public', { ...staticOptions, index: false }));
app.use('/thrive365labslaunch', express.static('public', { ...staticOptions, index: false }));
app.use(express.static('public', { ...staticOptions, index: false }));
// NOTE: Authenticated /uploads static middleware is registered after authenticateToken is defined (see below)

// ============== LAUNCH ROUTES (Implementations Portal) ==============
// DEACTIVATED (Session 2): the launch/implementations tracker is not used by GFC.
// Routes are retained but redirect to /login; public/app.js and tracker code remain
// intact for future repurposing. Re-enable by restoring res.sendFile(index.html).
app.get('/launch', (req, res) => {
  res.redirect('/login');
});
app.get('/launch/login', (req, res) => {
  res.redirect('/login');
});
app.get('/launch/home', (req, res) => {
  res.redirect('/login');
});

// Legacy routes - redirect to new /launch paths
app.get('/thrive365labsLAUNCH', (req, res) => {
  res.redirect(301, '/launch');
});
app.get('/thrive365labslaunch', (req, res) => {
  res.redirect(301, '/launch');
});
// Note: Specific sub-routes (login, home, :slug, :slug-internal) are defined at the end of the file

// Initialize admin user on startup
(async () => {
  try {
    let users = await db.get('users') || [];
    let changed = false;

    // Ensure the GFC default admin exists
    if (!users.find(u => u.email === config.DEFAULT_ADMIN.EMAIL)) {
      const hashedPassword = await bcrypt.hash(config.DEFAULT_ADMIN.PASSWORD, config.BCRYPT_SALT_ROUNDS);
      users.push({
        id: uuidv4(),
        email: config.DEFAULT_ADMIN.EMAIL,
        name: config.DEFAULT_ADMIN.NAME,
        password: hashedPassword,
        role: config.ROLES.ADMIN,
        createdAt: new Date().toISOString()
      });
      changed = true;
      console.log(`✅ Admin user created: ${config.DEFAULT_ADMIN.EMAIL}`);
    }

    // One-time cleanup: remove the legacy Thrive admin — but only once the GFC
    // admin is confirmed present, so we can never end up with zero admins.
    const LEGACY_ADMIN_EMAIL = 'bianca@thrive365labs.live';
    const hasGfcAdmin = users.some(u => u.email === config.DEFAULT_ADMIN.EMAIL && u.role === config.ROLES.ADMIN);
    if (hasGfcAdmin && users.some(u => u.email === LEGACY_ADMIN_EMAIL)) {
      users = users.filter(u => u.email !== LEGACY_ADMIN_EMAIL);
      changed = true;
      console.log(`🗑️  Removed legacy admin: ${LEGACY_ADMIN_EMAIL}`);
    }

    if (changed) {
      await db.set('users', users);
      invalidateUsersCache();
    }
  } catch (err) {
    console.error('Error initializing admin user:', err);
  }
})();

// Helper functions

// Short-lived user cache to reduce DB reads on every authenticated request (Gotcha #6)
// 5-second TTL ensures permission changes take effect within seconds while reducing O(n) lookups
let _usersCache = { data: null, lastRefresh: 0 };
const USERS_CACHE_TTL = config.USERS_CACHE_TTL;

const getUsers = async () => {
  const now = Date.now();
  if (_usersCache.data && (now - _usersCache.lastRefresh < USERS_CACHE_TTL)) {
    return _usersCache.data;
  }
  const users = (await db.get('users')) || [];
  _usersCache = { data: users, lastRefresh: now };
  return users;
};

// Invalidate user cache after writes (called after db.set('users', ...))
const invalidateUsersCache = () => {
  _usersCache = { data: null, lastRefresh: 0 };
};
// Run legacy migration once at startup instead of on every read (Gotcha #15)
let _projectsMigrated = false;

const migrateProjects = async () => {
  if (_projectsMigrated) return;
  const projects = (await db.get('projects')) || [];
  let needsSave = false;
  for (const project of projects) {
    if (project.hubspotDealId && !project.hubspotRecordId) {
      project.hubspotRecordId = project.hubspotDealId;
      delete project.hubspotDealId;
      needsSave = true;
    }
  }
  if (needsSave) {
    await db.set('projects', projects);
    console.log('Migrated hubspotDealId -> hubspotRecordId for legacy projects');
  }
  _projectsMigrated = true;
};

// Run migration immediately on startup
migrateProjects().catch(err => console.error('Project migration error:', err));

const getProjects = async () => (await db.get('projects')) || [];
// Get raw tasks for mutation - use this when you need to modify and save back
const getRawTasks = async (projectId) => {
  return (await db.get(`tasks_${projectId}`)) || [];
};

// Safe next ID generator - handles mixed numeric/UUID task IDs without NaN
const getNextNumericId = (items) => {
  if (!items || items.length === 0) return 1;
  const numericIds = items.map(t => typeof t.id === 'number' ? t.id : parseInt(t.id, 10)).filter(id => !isNaN(id));
  return numericIds.length > 0 ? Math.max(...numericIds) + 1 : items.length + 1;
};

// Get normalized tasks for display - use this for read-only operations
const getTasks = async (projectId) => {
  const tasks = await getRawTasks(projectId);
  
  // Return tasks with normalized defaults for display (read-only normalization, no save)
  return tasks.map(task => ({
    ...task,
    tags: task.tags || [],
    description: task.description || '',
    subtasks: (task.subtasks || []).map(st => ({
      ...st,
      completed: st.completed !== undefined ? st.completed : false,
      notApplicable: st.notApplicable !== undefined ? st.notApplicable : false,
      status: st.status || (st.completed ? 'Completed' : (st.notApplicable ? 'N/A' : 'Pending'))
    }))
  }));
};

// Activity logging helper
const ACTIVITY_LOG_MAX = config.ACTIVITY_LOG_MAX_ENTRIES;

const logActivity = async (userId, userName, action, entityType, entityId, details, projectId = null) => {
  try {
    const activities = (await db.get('activity_log')) || [];
    const activity = {
      id: uuidv4(),
      userId,
      userName,
      action,
      entityType,
      entityId,
      details,
      projectId,
      timestamp: new Date().toISOString()
    };
    activities.unshift(activity);
    // Keep only last ACTIVITY_LOG_MAX activities to prevent unbounded growth
    if (activities.length > ACTIVITY_LOG_MAX) {
      const droppedCount = activities.length - ACTIVITY_LOG_MAX;
      console.warn(`Activity log exceeded ${ACTIVITY_LOG_MAX} entries, dropping ${droppedCount} oldest entries`);
      activities.length = ACTIVITY_LOG_MAX;
    }
    await db.set('activity_log', activities);
  } catch (err) {
    console.error('Failed to log activity:', err);
  }
};

// ============================================================
// NOTIFICATION QUEUE SYSTEM (Feature 1)
// ============================================================

// Create a notification queue entry
const queueNotification = async (type, recipientUserId, recipientEmail, recipientName, templateData, options = {}) => {
  try {
    const queue = (await db.get('pending_notifications')) || [];
    // Dedup: skip if identical pending or held notification exists
    const isDuplicate = queue.some(n =>
      n.type === type &&
      n.recipientEmail === recipientEmail &&
      n.relatedEntityId === (options.relatedEntityId || null) &&
      (n.status === 'pending' || n.status === 'held')
    );
    if (isDuplicate) return null;

    // Dedup: skip if the same notification was sent within the cooldown window.
    // This prevents repeat-send storms after the pending queue drains and the
    // scanner re-queues the same trigger (e.g. a task that is still overdue).
    const cooldownHours = (config.NOTIFICATION_COOLDOWN_HOURS && config.NOTIFICATION_COOLDOWN_HOURS[type]) ?? 20;
    const cooldownCutoff = new Date(Date.now() - cooldownHours * 3600 * 1000).toISOString();
    const log = (await db.get('notification_log')) || [];
    const recentlySent = log.some(n =>
      n.type === type &&
      n.recipientEmail === recipientEmail &&
      n.relatedEntityId === (options.relatedEntityId || null) &&
      n.status === 'sent' &&
      n.sentAt && n.sentAt >= cooldownCutoff
    );
    if (recentlySent) return null;

    const notification = {
      id: uuidv4(),
      type,
      recipientUserId,
      recipientEmail,
      recipientName,
      channel: 'email',
      triggerDate: options.triggerDate || new Date().toISOString(),
      status: options.status || 'pending',
      retryCount: 0,
      maxRetries: config.NOTIFICATION_MAX_RETRIES,
      relatedEntityId: options.relatedEntityId || null,
      relatedEntityType: options.relatedEntityType || null,
      relatedProjectId: options.relatedProjectId || null,
      templateData: {
        subject: templateData.subject,
        body: templateData.body,
        htmlBody: templateData.htmlBody || null,
        ctaUrl: templateData.ctaUrl || null,
        ctaLabel: templateData.ctaLabel || null
      },
      sentAt: null,
      failedAt: null,
      failureReason: null,
      createdAt: new Date().toISOString(),
      createdBy: options.createdBy || 'system'
    };
    queue.push(notification);
    await db.set('pending_notifications', queue);
    return notification;
  } catch (err) {
    console.error('Failed to queue notification:', err);
    return null;
  }
};

// Process the notification queue — sends pending notifications whose triggerDate has passed
const processNotificationQueue = async () => {
  try {
    const settings = (await db.get('notification_settings')) || { enabled: true };
    if (!settings.enabled) return;

    const queue = (await db.get('pending_notifications')) || [];
    const now = new Date();
    const pending = queue.filter(n => n.status === 'pending' && new Date(n.triggerDate) <= now);

    if (pending.length === 0) return;

    // Daily send limit check
    const log = (await db.get('notification_log')) || [];
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const sentToday = log.filter(n => n.sentAt && n.sentAt >= todayStart).length;
    const remainingBudget = config.NOTIFICATION_DAILY_SEND_LIMIT - sentToday;
    if (remainingBudget <= 0) {
      console.warn('[QUEUE] Daily send limit reached, skipping processing');
      return;
    }

    const toProcess = pending.slice(0, Math.min(pending.length, remainingBudget));
    let sentCount = 0;
    let failCount = 0;

    const emailPayloads = [];
    const queueIndices = [];
    for (const notification of toProcess) {
      const idx = queue.findIndex(n => n.id === notification.id);
      if (idx === -1) continue;
      emailPayloads.push({
        to: notification.recipientEmail,
        subject: notification.templateData.subject,
        text: notification.templateData.body,
        html: notification.templateData.htmlBody
      });
      queueIndices.push(idx);
    }

    if (emailPayloads.length > 0) {
      const batchResult = await sendBatchEmails(emailPayloads);

      batchResult.results.forEach((result, i) => {
        const idx = queueIndices[i];
        if (idx === undefined) return;
        if (result.success) {
          queue[idx].status = 'sent';
          queue[idx].sentAt = new Date().toISOString();
          sentCount++;
        } else {
          queue[idx].retryCount = (queue[idx].retryCount || 0) + 1;
          queue[idx].failedAt = new Date().toISOString();
          queue[idx].failureReason = result.error;
          if (queue[idx].retryCount >= queue[idx].maxRetries) {
            queue[idx].status = 'failed';
          }
          failCount++;
        }
      });
    }

    // Move sent/failed/cancelled notifications to log archive
    const completed = queue.filter(n => n.status === 'sent' || n.status === 'failed' || n.status === 'cancelled');
    const remaining = queue.filter(n => n.status === 'pending');
    if (completed.length > 0) {
      log.unshift(...completed);
      if (log.length > config.NOTIFICATION_LOG_MAX_ENTRIES) {
        log.length = config.NOTIFICATION_LOG_MAX_ENTRIES;
      }
      await db.set('notification_log', log);
    }
    await db.set('pending_notifications', remaining);

    if (sentCount > 0 || failCount > 0) {
      console.log(`[QUEUE] Processed: ${sentCount} sent, ${failCount} failed, ${remaining.length} remaining`);
    }
  } catch (err) {
    console.error('[QUEUE] Processing error:', err);
  }
};

// Cancel all pending task/project notifications for a project when it transitions
// to 'paused' or 'completed'. Service report notifications are intentionally excluded —
// those are standalone documents that remain relevant regardless of project status.
const cancelProjectNotifications = async (projectId, taskIds) => {
  try {
    const queue = (await db.get('pending_notifications')) || [];
    const taskIdSet = new Set(taskIds.map(String));

    const toCancel = [];
    const remaining = [];
    for (const n of queue) {
      const isProjectNotification =
        n.relatedEntityType === 'project' && n.relatedEntityId === projectId;
      const isTaskNotification =
        n.relatedEntityType === 'task' && taskIdSet.has(String(n.relatedEntityId));

      if (isProjectNotification || isTaskNotification) {
        toCancel.push({ ...n, status: 'cancelled', cancelledAt: new Date().toISOString(), cancelReason: 'project_status_change' });
      } else {
        remaining.push(n);
      }
    }

    if (toCancel.length === 0) return;

    await db.set('pending_notifications', remaining);

    const log = (await db.get('notification_log')) || [];
    log.unshift(...toCancel);
    if (log.length > config.NOTIFICATION_LOG_MAX_ENTRIES) {
      log.length = config.NOTIFICATION_LOG_MAX_ENTRIES;
    }
    await db.set('notification_log', log);

    console.log(`[NOTIFICATIONS] Cancelled ${toCancel.length} pending notification(s) for project ${projectId}`);
  } catch (err) {
    console.error('[NOTIFICATIONS] Error cancelling project notifications:', err);
  }
};

// ============================================================
// EMAIL TEMPLATE SYSTEM — Dynamic, admin-editable templates
// ============================================================

// Base HTML email wrapper used when a template has no custom htmlBody
const BASE_HTML_EMAIL_WRAPPER = `
<div style="font-family: Inter, -apple-system, sans-serif; width: 100%; max-width: 600px; margin: 0 auto; background: #f8fafc;">
  <div style="background-color: #ffffff; padding: 20px 16px 16px; border-radius: 8px 8px 0 0; text-align: center; border-bottom: 3px solid #045E9F;">
    <img src="{{appUrl}}/thrive365-logo-email.png" alt="Thrive 365 Labs" style="height: 44px; max-width: 220px; width: 100%; display: block; margin: 0 auto;" />
  </div>
  <div style="background: #ffffff; padding: 24px 16px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px;">
    <div style="color: #374151; line-height: 1.7; font-size: 15px; white-space: pre-wrap; word-break: break-word;">{{content}}</div>
    {{ctaBlock}}
    <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 28px 0 16px;" />
    <p style="color: #9ca3af; font-size: 12px; margin: 0;">You are receiving this because you have an account with Thrive 365 Labs.</p>
    {{unsubscribeBlock}}
  </div>
</div>`;

// Branded HTML for the welcome email (has credential table — not a standard wrapper)
const WELCOME_HTML_BODY = `<div style="font-family: Inter, -apple-system, sans-serif; width: 100%; max-width: 600px; margin: 0 auto; background: #f8fafc;">
  <div style="background-color: #ffffff; padding: 20px 16px 16px; border-radius: 8px 8px 0 0; text-align: center; border-bottom: 3px solid #045E9F;">
    <img src="{{appUrl}}/thrive365-logo-email.png" alt="Thrive 365 Labs" style="height: 44px; max-width: 220px; width: 100%; display: block; margin: 0 auto;" />
  </div>
  <div style="background: #ffffff; padding: 24px 16px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px;">
    <h2 style="color: #00205A; margin-top: 0; font-size: 20px;">Welcome to Thrive 365 Labs, {{recipientName}}!</h2>
    <p style="color: #374151; line-height: 1.7; font-size: 15px;">Your account has been created. Use the credentials below to log in for the first time. You will be prompted to set a new password after your first login.</p>
    <div style="background: #f1f5f9; border: 1px solid #cbd5e1; border-radius: 8px; padding: 16px; margin: 24px 0;">
      <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
        <tr>
          <td style="color: #64748b; padding: 6px 0; width: 140px; font-weight: 500; vertical-align: top;">Username / Email</td>
          <td style="color: #0f172a; padding: 6px 0; font-weight: 600; word-break: break-all;">{{recipientEmail}}</td>
        </tr>
        <tr>
          <td style="color: #64748b; padding: 6px 0; font-weight: 500; vertical-align: top;">Temporary Password</td>
          <td style="color: #0f172a; padding: 6px 0; font-weight: 600; font-family: monospace; letter-spacing: 0.05em; word-break: break-all;">{{temporaryPassword}}</td>
        </tr>
      </table>
    </div>
    <p style="margin-top: 20px;">
      <a href="{{loginUrl}}" style="display: inline-block; background: #045E9F; color: #ffffff; padding: 12px 20px; border-radius: 6px; text-decoration: none; font-weight: 600; font-size: 14px;">Log In Now</a>
    </p>
    <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 28px 0 16px;" />
    <p style="color: #9ca3af; font-size: 12px; margin: 0;">If you did not expect this email, please contact your Thrive 365 Labs administrator.</p>
  </div>
</div>`;

// Render a template string by replacing {{variable}} placeholders with values
function renderTemplate(templateStr, variables) {
  if (!templateStr) return '';
  return templateStr.replace(/\{\{(\w+)\}\}/g, (match, key) =>
    variables[key] !== undefined ? String(variables[key]) : match
  );
}

// Build HTML email body: use custom htmlBody if provided, otherwise wrap plain body in base layout
function buildHtmlEmail(body, htmlBody, ctaUrl, ctaLabel, unsubscribeUrl, baseUrl) {
  if (htmlBody) return htmlBody;
  const ctaBlock = (ctaUrl && ctaLabel)
    ? `<p style="margin-top: 20px;"><a href="${ctaUrl}" style="display: inline-block; background: #045E9F; color: #ffffff; padding: 10px 24px; border-radius: 6px; text-decoration: none; font-weight: 500; font-size: 14px;">${ctaLabel}</a></p>`
    : '';
  const unsubscribeBlock = unsubscribeUrl
    ? `<p style="color: #9ca3af; font-size: 11px; margin: 6px 0 0;"><a href="${unsubscribeUrl}" style="color: #9ca3af; text-decoration: underline;">Unsubscribe from these emails</a></p>`
    : '';
  return renderTemplate(BASE_HTML_EMAIL_WRAPPER, { content: body, ctaBlock, unsubscribeBlock, appUrl: baseUrl || 'https://godwinsfamilycarellc.com' });
}

// ============================================================
// VARIABLE POOLS — Grouped sets of template variables by domain
// ============================================================

const VARIABLE_POOLS = {
  account: {
    label: 'Account',
    variables: [
      { key: 'temporaryPassword', label: 'Temporary Password', example: 'Welcome2026!' },
      { key: 'loginUrl', label: 'Login URL', example: 'https://thrive365labs.live/login' }
    ]
  },
  service_report: {
    label: 'Service Report',
    variables: [
      { key: 'facilityName', label: 'Facility Name', example: 'Valley Medical' },
      { key: 'technicianName', label: 'Technician Name', example: 'John Smith' },
      { key: 'reportDate', label: 'Report Date', example: '02/17/2026' },
      { key: 'serviceType', label: 'Service Type', example: 'Installation' },
      { key: 'reportStatus', label: 'Report Status', example: 'signature_needed' },
      { key: 'reportAge', label: 'Days Since Created', example: '5' },
      { key: 'reportLink', label: 'Direct Report Link', example: 'https://thrive365labs.live/service-portal?report=abc-123' },
      { key: 'portalLink', label: 'Client Portal Link', example: 'https://thrive365labs.live/portal/valley-medical' }
    ]
  },
  task: {
    label: 'Task',
    variables: [
      { key: 'taskTitle', label: 'Task Title', example: 'Install AU480 Analyzer' },
      { key: 'phase', label: 'Phase', example: 'Phase 2' },
      { key: 'dueDate', label: 'Due Date', example: '03/15/2026' },
      { key: 'timeframe', label: 'Timeframe', example: 'in 3 days' },
      { key: 'daysOverdue', label: 'Days Overdue', example: '5' },
      { key: 'ownerName', label: 'Task Owner', example: 'Jane Doe' },
      { key: 'taskLink', label: 'Direct Task Link', example: 'https://thrive365labs.live/launch/valley-medical?task=42' },
      { key: 'subtaskTitle', label: 'Subtask Title', example: 'Order reagent kits' },
      { key: 'parentTaskTitle', label: 'Parent Task Title', example: 'Install AU480 Analyzer' }
    ]
  },
  project: {
    label: 'Project',
    variables: [
      { key: 'projectName', label: 'Project Name', example: 'Valley Medical Launch' },
      { key: 'goLiveDate', label: 'Go-Live Date', example: '04/01/2026' },
      { key: 'daysUntil', label: 'Days Until Go-Live', example: '7' },
      { key: 'percentage', label: 'Completion %', example: '75' },
      { key: 'completedTasks', label: 'Completed Tasks', example: '76' },
      { key: 'totalTasks', label: 'Total Tasks', example: '102' },
      { key: 'projectLink', label: 'Project Link', example: 'https://thrive365labs.live/launch/valley-medical' }
    ]
  },
  announcement: {
    label: 'Announcement',
    variables: [
      { key: 'title', label: 'Announcement Title', example: 'System Maintenance Scheduled' },
      { key: 'content', label: 'Announcement Content', example: 'We will be performing system maintenance this weekend.' },
      { key: 'priorityTag', label: 'Priority Tag', example: '[PRIORITY] ' },
      { key: 'priorityBanner', label: 'Priority Banner HTML', example: '' },
      { key: 'attachmentUrl', label: 'Attachment URL', example: '' },
      { key: 'attachmentName', label: 'Attachment Name', example: '' },
      { key: 'attachmentLine', label: 'Attachment Text Line', example: '' },
      { key: 'attachmentBlock', label: 'Attachment HTML Block', example: '' }
    ]
  },
  recipient: {
    label: 'Recipient',
    variables: [
      { key: 'recipientName', label: 'Recipient Name', example: 'Jane Doe' },
      { key: 'recipientEmail', label: 'Recipient Email', example: 'jane@valleymedical.com' }
    ]
  },
  system: {
    label: 'System',
    variables: [
      { key: 'appUrl', label: 'App Base URL', example: 'https://thrive365labs.live' },
      { key: 'currentDate', label: 'Current Date', example: '02/17/2026' },
      { key: 'companyName', label: 'Company Name', example: 'Thrive 365 Labs' }
    ]
  }
};

// Maps each template ID to the pools whose variables it can use
const TEMPLATE_POOL_MAPPING = {
  service_report_signature: ['service_report', 'recipient', 'system'],
  service_report_review:    ['service_report', 'recipient', 'system'],
  task_deadline:            ['task', 'project', 'recipient', 'system'],
  task_overdue:             ['task', 'project', 'recipient', 'system'],
  task_overdue_escalation:  ['task', 'project', 'recipient', 'system'],
  milestone_reached:        ['project', 'recipient', 'system'],
  golive_reminder:          ['project', 'recipient', 'system'],
  announcement:             ['announcement', 'recipient', 'system'],
  welcome_email:            ['account', 'recipient', 'system'],
  task_attachment:           ['task', 'project', 'recipient', 'system'],
  subtask_deadline:          ['task', 'project', 'recipient', 'system'],
  subtask_overdue:           ['task', 'project', 'recipient', 'system'],
  subtask_overdue_escalation:['task', 'project', 'recipient', 'system'],
  task_assignment:           ['task', 'project', 'recipient', 'system']
};

// Compute the merged variables array for a template from its pools
function getPoolVariablesForTemplate(templateId) {
  const poolNames = TEMPLATE_POOL_MAPPING[templateId] || [];
  const vars = [];
  const seen = new Set();
  for (const poolName of poolNames) {
    const pool = VARIABLE_POOLS[poolName];
    if (!pool) continue;
    for (const v of pool.variables) {
      if (!seen.has(v.key)) {
        vars.push({ ...v, pool: poolName });
        seen.add(v.key);
      }
    }
  }
  return vars;
}

// Compute pool groupings (with labels) for a template — used by the admin UI
function getPoolGroupsForTemplate(templateId) {
  const poolNames = TEMPLATE_POOL_MAPPING[templateId] || [];
  return poolNames
    .filter(name => VARIABLE_POOLS[name])
    .map(name => ({
      pool: name,
      label: VARIABLE_POOLS[name].label,
      variables: VARIABLE_POOLS[name].variables.map(v => ({ ...v }))
    }));
}

// ============================================================
// POOL RESOLVER FUNCTIONS — Build variable values from entity data
// ============================================================

async function getAppBaseUrl() {
  const domain = await db.get('client_portal_domain');
  if (domain) return `https://${domain}`;
  return 'https://godwinsfamilycarellc.com';
}

function resolveSystemVars(appBaseUrl) {
  return {
    appUrl: appBaseUrl,
    currentDate: new Date().toLocaleDateString(),
    companyName: 'Thrive 365 Labs'
  };
}

function resolveRecipientVars(user) {
  return {
    recipientName: user.name || '',
    recipientEmail: user.email || ''
  };
}

function resolveServiceReportVars(report, appBaseUrl) {
  return {
    facilityName: report.clientFacilityName || 'your facility',
    technicianName: report.technicianName || 'your technician',
    reportDate: new Date(report.createdAt).toLocaleDateString(),
    serviceType: report.serviceType || '',
    reportStatus: report.status || '',
    reportLink: `${appBaseUrl}/service-portal?report=${report.id}`,
    portalLink: report.clientSlug ? `${appBaseUrl}/portal/${report.clientSlug}` : appBaseUrl
  };
}

function resolveTaskVars(task, project, appBaseUrl) {
  const dueDate = task.dueDate ? new Date(task.dueDate) : null;
  const now = new Date();
  const daysUntilDue = dueDate ? Math.floor((dueDate - now) / (1000 * 60 * 60 * 24)) : null;
  const owner = task.owner || '';
  return {
    taskTitle: task.taskTitle || '',
    phase: task.phase || '',
    dueDate: dueDate ? dueDate.toLocaleDateString() : '',
    timeframe: daysUntilDue !== null
      ? (daysUntilDue === 0 ? 'today' : daysUntilDue === 1 ? 'tomorrow' : daysUntilDue > 0 ? `in ${daysUntilDue} days` : `${Math.abs(daysUntilDue)} days ago`)
      : '',
    daysOverdue: (daysUntilDue !== null && daysUntilDue < 0) ? String(Math.abs(daysUntilDue)) : '0',
    ownerName: owner,
    taskLink: project && project.clientLinkSlug
      ? `${appBaseUrl}/launch/${project.clientLinkSlug}-internal#task-${task.id}`
      : appBaseUrl
  };
}

function resolveSubtaskVars(subtask, parentTask, project, appBaseUrl) {
  const dueDate = subtask.dueDate ? new Date(subtask.dueDate) : null;
  const now = new Date();
  const daysUntilDue = dueDate ? Math.floor((dueDate - now) / (1000 * 60 * 60 * 24)) : null;
  const owner = subtask.owner || '';
  return {
    taskTitle: subtask.title || '',
    subtaskTitle: subtask.title || '',
    parentTaskTitle: parentTask.taskTitle || '',
    phase: parentTask.phase || '',
    dueDate: dueDate ? dueDate.toLocaleDateString() : '',
    timeframe: daysUntilDue !== null
      ? (daysUntilDue === 0 ? 'today' : daysUntilDue === 1 ? 'tomorrow' : daysUntilDue > 0 ? `in ${daysUntilDue} days` : `${Math.abs(daysUntilDue)} days ago`)
      : '',
    daysOverdue: (daysUntilDue !== null && daysUntilDue < 0) ? String(Math.abs(daysUntilDue)) : '0',
    ownerName: owner,
    taskLink: project && project.clientLinkSlug
      ? `${appBaseUrl}/launch/${project.clientLinkSlug}-internal#task-${parentTask.id}`
      : appBaseUrl
  };
}

function resolveProjectVars(project, tasks, appBaseUrl) {
  const completedCount = tasks ? tasks.filter(t => t.completed).length : 0;
  const totalCount = tasks ? tasks.length : 0;
  const pct = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;
  const goLive = project.goLiveDate ? new Date(project.goLiveDate) : null;
  const daysUntil = goLive ? Math.floor((goLive - new Date()) / (1000 * 60 * 60 * 24)) : null;
  return {
    projectName: project.name || '',
    goLiveDate: goLive ? goLive.toLocaleDateString() : '',
    daysUntil: daysUntil !== null ? String(daysUntil) : '',
    percentage: String(pct),
    completedTasks: String(completedCount),
    totalTasks: String(totalCount),
    projectLink: project.clientLinkSlug
      ? `${appBaseUrl}/launch/${project.clientLinkSlug}`
      : appBaseUrl
  };
}

// Build a full variable map for a template from its pools and entity data
function buildTemplateVars(pools, recipientUser, appBaseUrl) {
  let vars = {};
  for (const [poolName, poolVars] of Object.entries(pools)) {
    vars = { ...vars, ...poolVars };
  }
  if (recipientUser) vars = { ...vars, ...resolveRecipientVars(recipientUser) };
  vars = { ...vars, ...resolveSystemVars(appBaseUrl) };
  return vars;
}

// Default email templates — seeded on first access, admin can edit via UI
async function sendAssignmentNotification(ownerEmail, task, subtask, project, triggeringUserId) {
  try {
    if (!ownerEmail) return;
    const allUsers = await getUsers();
    const ownerUser = allUsers.find(u => u.email === ownerEmail);
    if (!ownerUser || ownerUser.emailUnsubscribed) return;
    if (ownerUser.id === triggeringUserId) return;

    const isHeld = project && project.publishedStatus === 'draft';

    const appBaseUrl = await getAppBaseUrl();
    const templates = await getEmailTemplates();
    const template = getTemplateById(templates, 'task_assignment');

    const isSubtask = !!subtask;
    const taskTitle = isSubtask ? (subtask.title || '') : (task.taskTitle || '');
    const dueDate = isSubtask ? subtask.dueDate : task.dueDate;
    const dueDateFormatted = dueDate ? new Date(dueDate).toLocaleDateString() : 'Not set';
    const taskLink = project && project.clientLinkSlug
      ? (ownerUser.role === 'client' && ownerUser.slug
          ? `${appBaseUrl}/portal/${ownerUser.slug}#task-${task.id}`
          : `${appBaseUrl}/launch/${project.clientLinkSlug}-internal#task-${task.id}`)
      : appBaseUrl;

    const taskVars = {
      taskTitle,
      subtaskTitle: isSubtask ? (subtask.title || '') : '',
      parentTaskTitle: isSubtask ? (task.taskTitle || '') : '',
      phase: task.phase || '',
      dueDate: dueDateFormatted,
      taskLink,
      ownerName: ownerEmail,
      timeframe: '',
      daysOverdue: '0'
    };
    const projVars = {
      projectName: project.name || project.clientName || '',
      projectLink: project.clientLinkSlug ? `${appBaseUrl}/launch/${project.clientLinkSlug}` : appBaseUrl
    };

    const allVars = buildTemplateVars({ task: taskVars, project: projVars }, ownerUser, appBaseUrl);

    const subject = renderTemplate(template.subject, allVars);
    const body = renderTemplate(template.body, allVars);
    const renderedHtml = template.htmlBody
      ? renderTemplate(template.htmlBody, allVars)
      : null;
    const htmlBody = buildHtmlEmail(body, renderedHtml, taskLink, 'View Task', null, appBaseUrl);
    const entityId = isSubtask ? `${task.id}-${subtask.id}` : String(task.id);

    await queueNotification('task_assignment', ownerUser.id, ownerUser.email, ownerUser.name || ownerUser.email, {
      subject, body, htmlBody, ctaUrl: taskLink, ctaLabel: 'View Task'
    }, {
      relatedEntityId: entityId,
      relatedEntityType: isSubtask ? 'subtask' : 'task',
      createdBy: triggeringUserId || 'system',
      ...(isHeld ? { status: 'held', relatedProjectId: project.id } : {})
    });
  } catch (err) {
    console.error('Failed to send assignment notification:', err);
  }
}

const DEFAULT_EMAIL_TEMPLATES = [
  {
    id: 'task_overdue_escalation',
    name: 'Task Overdue — Admin Escalation',
    category: 'automated',
    subject: 'ESCALATION: Task {{daysOverdue}}d overdue — {{taskTitle}} ({{projectName}})',
    body: '"{{taskTitle}}" assigned to {{ownerName}} in project "{{projectName}}" is {{daysOverdue}} days overdue. Due date: {{dueDate}}.',
    htmlBody: null,
    variables: [
      { key: 'taskTitle', label: 'Task Title', example: 'Install AU480 Analyzer' },
      { key: 'projectName', label: 'Project Name', example: 'Valley Medical Launch' },
      { key: 'ownerName', label: 'Owner Name', example: 'Jane Doe' },
      { key: 'dueDate', label: 'Due Date', example: '03/01/2026' },
      { key: 'daysOverdue', label: 'Days Overdue', example: '10' }
    ],
    isDefault: true, updatedAt: null, updatedBy: null
  },
  {
    id: 'announcement',
    name: 'New Announcement',
    category: 'announcement',
    subject: '{{priorityTag}}New Announcement: {{title}}',
    body: '{{priorityTag}}{{title}}\n\n{{content}}{{attachmentLine}}',
    htmlBody: `<div style="font-family: Inter, -apple-system, sans-serif; width: 100%; max-width: 600px; margin: 0 auto;">
  <div style="background-color: #ffffff; padding: 20px 16px 16px; border-radius: 8px 8px 0 0; text-align: center; border-bottom: 3px solid #045E9F;">
    <img src="{{appUrl}}/thrive365-logo-email.png" alt="Thrive 365 Labs" style="height: 44px; max-width: 220px; width: 100%; display: block; margin: 0 auto;" />
  </div>
  <div style="background: #ffffff; padding: 24px 16px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px;">
    {{priorityBanner}}
    <h2 style="color: #00205A; margin-top: 0;">{{title}}</h2>
    <div style="color: #374151; line-height: 1.6; white-space: pre-wrap; word-break: break-word;">{{content}}</div>
    {{attachmentBlock}}
    <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;" />
    <p style="color: #9ca3af; font-size: 12px; margin: 0;">You are receiving this because you have a client portal account with Thrive 365 Labs.</p>
  </div>
</div>`,
    variables: [
      { key: 'title', label: 'Announcement Title', example: 'System Maintenance Scheduled' },
      { key: 'content', label: 'Announcement Content', example: 'We will be performing system maintenance this weekend.' },
      { key: 'priorityTag', label: 'Priority Tag', example: '[PRIORITY] ' },
      { key: 'priorityBanner', label: 'Priority Banner HTML', example: '' },
      { key: 'attachmentUrl', label: 'Attachment URL', example: '' },
      { key: 'attachmentName', label: 'Attachment Name', example: '' },
      { key: 'attachmentLine', label: 'Attachment Text Line', example: '' },
      { key: 'attachmentBlock', label: 'Attachment HTML Block', example: '<p style="margin-top: 16px;"><a href="#" style="color: #045E9F; font-weight: 500;">📎 View Attachment</a></p>' }
    ],
    isDefault: true, updatedAt: null, updatedBy: null
  },
  {
    id: 'welcome_email',
    name: 'Welcome Email — New User',
    category: 'automated',
    subject: 'Welcome to Thrive 365 Labs — Your Account is Ready',
    body: 'Welcome, {{recipientName}}!\n\nYour account has been created. Use the details below to log in for the first time. You will be prompted to set a new password after your first login.\n\nUsername / Email: {{recipientEmail}}\nTemporary Password: {{temporaryPassword}}\n\nLog in here: {{loginUrl}}\n\nThrive 365 Labs',
    htmlBody: null,
    isDefault: true, updatedAt: null, updatedBy: null
  },
  {
    id: 'task_attachment',
    name: 'Task Attachment — New Document',
    category: 'automated',
    subject: 'New Document Added: {{taskName}}',
    body: 'A new file "{{fileName}}" has been added to the task "{{taskName}}" in your project "{{projectName}}".\n\nView it in your portal:\n{{portalLink}}\n\nThrive 365 Labs',
    htmlBody: null,
    variables: [
      { key: 'taskName', label: 'Task Name', example: 'Install AU480 Analyzer' },
      { key: 'fileName', label: 'File Name', example: 'setup-guide.pdf' },
      { key: 'projectName', label: 'Project Name', example: 'Valley Medical Launch' },
      { key: 'portalLink', label: 'Portal Link', example: 'https://thrive365labs.live/portal/valley-medical#task-42' }
    ],
    isDefault: true, updatedAt: null, updatedBy: null
  },
  {
    id: 'subtask_deadline',
    name: 'Subtask Deadline Warning',
    category: 'automated',
    subject: 'Subtask due {{timeframe}}: {{subtaskTitle}} — {{projectName}}',
    body: 'The subtask "{{subtaskTitle}}" under "{{parentTaskTitle}}" in {{phase}} is due {{dueDate}}. Project: {{projectName}}.',
    htmlBody: null,
    variables: [
      { key: 'subtaskTitle', label: 'Subtask Title', example: 'Order reagent kits' },
      { key: 'parentTaskTitle', label: 'Parent Task Title', example: 'Install AU480 Analyzer' },
      { key: 'projectName', label: 'Project Name', example: 'Valley Medical Launch' },
      { key: 'phase', label: 'Phase', example: 'Phase 2' },
      { key: 'dueDate', label: 'Due Date', example: '03/15/2026' },
      { key: 'timeframe', label: 'Timeframe', example: 'in 3 days' }
    ],
    isDefault: true, updatedAt: null, updatedBy: null
  },
  {
    id: 'subtask_overdue',
    name: 'Subtask Overdue — Owner',
    category: 'automated',
    subject: 'OVERDUE ({{daysOverdue}}d): {{subtaskTitle}} — {{projectName}}',
    body: 'The subtask "{{subtaskTitle}}" under "{{parentTaskTitle}}" in {{phase}} was due {{dueDate}} and is now {{daysOverdue}} day(s) overdue. Project: {{projectName}}.',
    htmlBody: null,
    variables: [
      { key: 'subtaskTitle', label: 'Subtask Title', example: 'Order reagent kits' },
      { key: 'parentTaskTitle', label: 'Parent Task Title', example: 'Install AU480 Analyzer' },
      { key: 'projectName', label: 'Project Name', example: 'Valley Medical Launch' },
      { key: 'phase', label: 'Phase', example: 'Phase 2' },
      { key: 'dueDate', label: 'Due Date', example: '03/01/2026' },
      { key: 'daysOverdue', label: 'Days Overdue', example: '5' }
    ],
    isDefault: true, updatedAt: null, updatedBy: null
  },
  {
    id: 'subtask_overdue_escalation',
    name: 'Subtask Overdue — Admin Escalation',
    category: 'automated',
    subject: 'ESCALATION: Subtask {{daysOverdue}}d overdue — {{subtaskTitle}} ({{projectName}})',
    body: 'The subtask "{{subtaskTitle}}" under "{{parentTaskTitle}}" assigned to {{ownerName}} in project "{{projectName}}" is {{daysOverdue}} days overdue. Due date: {{dueDate}}.',
    htmlBody: null,
    variables: [
      { key: 'subtaskTitle', label: 'Subtask Title', example: 'Order reagent kits' },
      { key: 'parentTaskTitle', label: 'Parent Task Title', example: 'Install AU480 Analyzer' },
      { key: 'projectName', label: 'Project Name', example: 'Valley Medical Launch' },
      { key: 'ownerName', label: 'Owner Name', example: 'Jane Doe' },
      { key: 'dueDate', label: 'Due Date', example: '03/01/2026' },
      { key: 'daysOverdue', label: 'Days Overdue', example: '10' }
    ],
    isDefault: true, updatedAt: null, updatedBy: null
  },
  {
    id: 'task_assignment',
    name: 'Task Assignment — New Assignment',
    category: 'automated',
    subject: 'New Task Assigned: {{taskTitle}} — {{projectName}}',
    body: 'You have been assigned to "{{taskTitle}}" in project "{{projectName}}".\n\nPhase: {{phase}}\nDue Date: {{dueDate}}\n\nView it here: {{taskLink}}\n\nThrive 365 Labs',
    htmlBody: null,
    variables: [
      { key: 'taskTitle', label: 'Task Title', example: 'Install AU480 Analyzer' },
      { key: 'projectName', label: 'Project Name', example: 'Valley Medical Launch' },
      { key: 'phase', label: 'Phase', example: 'Phase 2' },
      { key: 'dueDate', label: 'Due Date', example: '03/15/2026' },
      { key: 'taskLink', label: 'Direct Task Link', example: 'https://thrive365labs.live/launch/valley-medical?task=42' }
    ],
    isDefault: true, updatedAt: null, updatedBy: null
  }
];

// Get email templates from DB; seed defaults on first access
async function getEmailTemplates() {
  let templates = await db.get('email_templates');
  if (!templates || !Array.isArray(templates) || templates.length === 0) {
    templates = DEFAULT_EMAIL_TEMPLATES.map(t => ({ ...t }));
    await db.set('email_templates', templates);
  }
  // Ensure any new default templates are added (forward-compatible)
  const existingIds = new Set(templates.map(t => t.id));
  let added = false;
  for (const def of DEFAULT_EMAIL_TEMPLATES) {
    if (!existingIds.has(def.id)) {
      templates.push({ ...def });
      added = true;
    }
  }
  if (added) await db.set('email_templates', templates);

  // Enrich each template with pool-derived variables and pool groups
  for (const t of templates) {
    t.variables = getPoolVariablesForTemplate(t.id);
    t.poolGroups = getPoolGroupsForTemplate(t.id);
    t.pools = TEMPLATE_POOL_MAPPING[t.id] || [];
  }
  return templates;
}

// Get a single template by ID with fallback to default
function getTemplateById(templates, id) {
  return templates.find(t => t.id === id) || DEFAULT_EMAIL_TEMPLATES.find(t => t.id === id);
}

function getLoginUrlForRole(role, slug, appBaseUrl) {
  if (role === 'client' && slug) return `${appBaseUrl}/portal/${slug}`;
  if (role === 'admin') return `${appBaseUrl}/admin`;
  return `${appBaseUrl}/login`;
}

async function sendWelcomeEmail(user, plainPassword) {
  try {
    const appBaseUrl = await getAppBaseUrl();
    const loginUrl = getLoginUrlForRole(user.role, user.slug, appBaseUrl);
    const templates = await getEmailTemplates();
    const tpl = getTemplateById(templates, 'welcome_email');
    const vars = {
      recipientName: user.name,
      recipientEmail: user.email,
      temporaryPassword: plainPassword,
      loginUrl,
      appUrl: appBaseUrl,
      currentDate: new Date().toLocaleDateString(),
      companyName: 'Thrive 365 Labs'
    };
    const subject = renderTemplate(tpl.subject, vars);
    const body = renderTemplate(tpl.body, vars);
    const htmlBody = tpl.htmlBody
      ? renderTemplate(tpl.htmlBody, vars)
      : renderTemplate(WELCOME_HTML_BODY, vars);
    const notification = await queueNotification(
      'welcome_email',
      user.id, user.email, user.name,
      { subject, body, htmlBody },
      { relatedEntityId: user.id, relatedEntityType: 'user', createdBy: 'system' }
    );
    if (!notification) console.error('Welcome email failed to queue for', user.email);
    return notification ? { success: true, queued: true } : { success: false, error: 'Failed to queue' };
  } catch (err) {
    console.error('sendWelcomeEmail error:', err);
    return { success: false, error: err.message };
  }
}

// ============================================================
// NOTIFICATION TRIGGER SCANNER (Feature 2)
// ============================================================

const scanAndQueueNotifications = async () => {
  try {
    const reminderSettings = (await db.get('reminder_settings')) || { enabled: true, scenarios: {} };
    if (!reminderSettings.enabled) return;
    const scenarios = reminderSettings.scenarios || {};
    const users = await getUsers();
    const now = new Date();
    const appBaseUrl = await getAppBaseUrl();

    // Load editable email templates
    const emailTemplates = await getEmailTemplates();
    const tpl = (id) => getTemplateById(emailTemplates, id);

    // Helper: render a template with pool-resolved vars and queue the notification
    const renderAndQueue = async (templateId, recipientUser, allVars, ctaLabel, ctaUrl, entityId, entityType) => {
      const t = tpl(templateId);
      if (!t) return; // template removed (e.g. lab default deleted); skip until a GFC template is created
      const renderedSubject = renderTemplate(t.subject, allVars);
      const renderedBody = renderTemplate(t.body, allVars);
      // Generate a long-lived unsubscribe token for this recipient
      const unsubToken = jwt.sign({ userId: recipientUser.id, purpose: 'email_unsubscribe' }, JWT_SECRET, { expiresIn: '365d' });
      const unsubscribeUrl = `${appBaseUrl}/api/unsubscribe?token=${unsubToken}`;
      const renderedHtml = buildHtmlEmail(
        renderedBody,
        t.htmlBody ? renderTemplate(t.htmlBody, allVars) : null,
        ctaUrl, ctaLabel, unsubscribeUrl, appBaseUrl
      );
      await queueNotification(
        templateId,
        recipientUser.id, recipientUser.email, recipientUser.name,
        { subject: renderedSubject, body: renderedBody, htmlBody: renderedHtml, ctaUrl, ctaLabel },
        { relatedEntityId: entityId, relatedEntityType: entityType, createdBy: 'system' }
      );
    };

    // --- Scenario A: Service Report Follow-Ups ---
    if (!scenarios.serviceReportFollowups || scenarios.serviceReportFollowups.enabled !== false) {
      const followupDays = (scenarios.serviceReportFollowups && scenarios.serviceReportFollowups.reminderAfterDays) || config.SERVICE_REPORT_FOLLOWUP_DAYS;
      const serviceReports = (await db.get('service_reports')) || [];
      for (const report of serviceReports) {
        const reportAge = Math.floor((now - new Date(report.createdAt)) / (1000 * 60 * 60 * 24));
        if (reportAge < followupDays) continue;

        const srVars = resolveServiceReportVars(report, appBaseUrl);
        // Also include reportAge for review templates
        srVars.reportAge = String(reportAge);

        // Missing client signature
        if (report.status === 'signature_needed' || (!report.customerSignature && report.status !== 'submitted')) {
          const clientUsers = users.filter(u => u.role === config.ROLES.CLIENT && u.slug === report.clientSlug && u.email && u.accountStatus !== 'inactive' && !u.emailUnsubscribed);
          for (const client of clientUsers) {
            const allVars = buildTemplateVars({ service_report: srVars }, client, appBaseUrl);
            const ctaUrl = srVars.portalLink;
            await renderAndQueue('service_report_signature', client, allVars, 'Review & Sign', ctaUrl, report.id, 'service_report');
          }
        }

        // Not reviewed by admin
        if (report.status && report.status !== 'submitted' && !report.adminReviewedAt) {
          const admins = users.filter(u => u.role === config.ROLES.ADMIN && u.email && u.accountStatus !== 'inactive' && !u.emailUnsubscribed);
          for (const admin of admins) {
            const allVars = buildTemplateVars({ service_report: srVars }, admin, appBaseUrl);
            const ctaUrl = srVars.reportLink;
            await renderAndQueue('service_report_review', admin, allVars, 'Review Report', ctaUrl, report.id, 'service_report');
          }
        }
      }
    }

    // --- Scenario B: Task Deadline Notifications ---
    if (!scenarios.taskDeadlines || scenarios.taskDeadlines.enabled !== false) {
      const daysBefore = (scenarios.taskDeadlines && scenarios.taskDeadlines.daysBefore) || config.TASK_DEADLINE_DAYS_BEFORE;
      const escalationDays = (scenarios.taskDeadlines && scenarios.taskDeadlines.overdueEscalationDays) || config.TASK_OVERDUE_ESCALATION_DAYS;
      const projects = await getProjects();
      const activeProjects = projects.filter(p => p.status === 'active');

      for (const project of activeProjects) {
        const tasks = await getTasks(project.id);
        const projVars = resolveProjectVars(project, tasks, appBaseUrl);

        for (const task of tasks) {
          if (task.completed || !task.dueDate || !task.owner) continue;
          const dueDate = new Date(task.dueDate);
          const daysUntilDue = Math.floor((dueDate - now) / (1000 * 60 * 60 * 24));

          const owner = users.find(u => u.email === task.owner);
          if (!owner || owner.emailUnsubscribed) continue;

          const taskVars = resolveTaskVars(task, project, appBaseUrl);
          const ctaUrl = taskVars.taskLink;

          // Approaching deadline
          if (daysUntilDue >= 0 && daysBefore.includes(daysUntilDue)) {
            const allVars = buildTemplateVars({ task: taskVars, project: projVars }, owner, appBaseUrl);
            await renderAndQueue('task_deadline', owner, allVars, 'View Task', ctaUrl, task.id?.toString(), 'task');
          }

          // Overdue
          if (daysUntilDue < 0) {
            const allVars = buildTemplateVars({ task: taskVars, project: projVars }, owner, appBaseUrl);
            await renderAndQueue('task_overdue', owner, allVars, 'View Task', ctaUrl, task.id?.toString(), 'task');

            // Escalate to admin after threshold
            const daysOverdue = Math.abs(daysUntilDue);
            if (daysOverdue >= escalationDays) {
              const admins = users.filter(u => u.role === config.ROLES.ADMIN && u.email && u.accountStatus !== 'inactive' && !u.emailUnsubscribed);
              for (const admin of admins) {
                const escVars = buildTemplateVars({ task: { ...taskVars, ownerName: owner.name }, project: projVars }, admin, appBaseUrl);
                await renderAndQueue('task_overdue_escalation', admin, escVars, 'View Project', projVars.projectLink, task.id?.toString(), 'task');
              }
            }
          }

          for (const subtask of (task.subtasks || [])) {
            if (subtask.completed || subtask.notApplicable || !subtask.dueDate || !subtask.owner) continue;
            const stDueDate = new Date(subtask.dueDate);
            const stDaysUntilDue = Math.floor((stDueDate - now) / (1000 * 60 * 60 * 24));

            const stOwner = users.find(u => u.email === subtask.owner);
            if (!stOwner || stOwner.emailUnsubscribed) continue;

            const stVars = resolveSubtaskVars(subtask, task, project, appBaseUrl);
            const stCtaUrl = stVars.taskLink;
            const stEntityId = `${task.id}-${subtask.id}`;

            if (stDaysUntilDue >= 0 && daysBefore.includes(stDaysUntilDue)) {
              const allVars = buildTemplateVars({ task: stVars, project: projVars }, stOwner, appBaseUrl);
              await renderAndQueue('subtask_deadline', stOwner, allVars, 'View Task', stCtaUrl, stEntityId, 'subtask');
            }

            if (stDaysUntilDue < 0) {
              const allVars = buildTemplateVars({ task: stVars, project: projVars }, stOwner, appBaseUrl);
              await renderAndQueue('subtask_overdue', stOwner, allVars, 'View Task', stCtaUrl, stEntityId, 'subtask');

              const stDaysOverdue = Math.abs(stDaysUntilDue);
              if (stDaysOverdue >= escalationDays) {
                const admins = users.filter(u => u.role === config.ROLES.ADMIN && u.email && u.accountStatus !== 'inactive' && !u.emailUnsubscribed);
                for (const admin of admins) {
                  const escVars = buildTemplateVars({ task: { ...stVars, ownerName: stOwner.name }, project: projVars }, admin, appBaseUrl);
                  await renderAndQueue('subtask_overdue_escalation', admin, escVars, 'View Project', projVars.projectLink, stEntityId, 'subtask');
                }
              }
            }
          }
        }
      }
    }

    // --- Scenario D: Implementation Milestone Reminders ---
    if (!scenarios.milestoneReminders || scenarios.milestoneReminders.enabled !== false) {
      const thresholds = (scenarios.milestoneReminders && scenarios.milestoneReminders.milestoneThresholds) || config.MILESTONE_THRESHOLDS;
      const goLiveDaysBefore = (scenarios.milestoneReminders && scenarios.milestoneReminders.goLiveDaysBefore) || config.GOLIVE_REMINDER_DAYS_BEFORE;
      const projects = await getProjects();

      for (const project of projects.filter(p => p.status === 'active')) {
        const tasks = await getTasks(project.id);
        if (tasks.length === 0) continue;

        const projVars = resolveProjectVars(project, tasks, appBaseUrl);
        const completedCount = tasks.filter(t => t.completed).length;
        const pct = Math.round((completedCount / tasks.length) * 100);
        const lastNotified = project.lastMilestoneNotified || 0;

        // Check if we've crossed a new threshold
        for (const threshold of thresholds) {
          if (pct >= threshold && lastNotified < threshold) {
            const projectClients = users.filter(u =>
              u.role === config.ROLES.CLIENT && u.email && u.accountStatus !== 'inactive' && !u.emailUnsubscribed &&
              (u.assignedProjects || []).includes(project.id)
            );
            for (const client of projectClients) {
              const allVars = buildTemplateVars({ project: projVars }, client, appBaseUrl);
              await renderAndQueue('milestone_reached', client, allVars, 'View Progress', projVars.projectLink, project.id, 'project');
            }

            // Update project milestone tracker
            const allProjects = await getProjects();
            const pIdx = allProjects.findIndex(p => p.id === project.id);
            if (pIdx !== -1) {
              allProjects[pIdx].lastMilestoneNotified = threshold;
              await db.set('projects', allProjects);
            }
            break; // Only notify for the highest crossed threshold
          }
        }

        // Go-live date reminders
        if (project.goLiveDate) {
          const goLive = new Date(project.goLiveDate);
          const daysUntilGoLive = Math.floor((goLive - now) / (1000 * 60 * 60 * 24));
          if (daysUntilGoLive >= 0 && goLiveDaysBefore.includes(daysUntilGoLive)) {
            const projectClients = users.filter(u =>
              u.role === config.ROLES.CLIENT && u.email && u.accountStatus !== 'inactive' && !u.emailUnsubscribed &&
              (u.assignedProjects || []).includes(project.id)
            );
            const teamMembers = users.filter(u =>
              (u.role === config.ROLES.USER || u.role === config.ROLES.ADMIN) && u.email && u.accountStatus !== 'inactive' && !u.emailUnsubscribed &&
              (u.assignedProjects || []).includes(project.id)
            );
            for (const user of [...projectClients, ...teamMembers]) {
              const allVars = buildTemplateVars({ project: projVars }, user, appBaseUrl);
              await renderAndQueue('golive_reminder', user, allVars, 'View Project', projVars.projectLink, project.id, 'project');
            }
          }
        }
      }
    }

    console.log('[SCANNER] Notification trigger scan completed');
  } catch (err) {
    console.error('[SCANNER] Error scanning for notifications:', err);
  }
};

// Generate a URL-friendly slug from client name
const generateClientSlug = (clientName, existingSlugs = []) => {
  let slug = clientName
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim();
  
  if (!slug) slug = 'client';
  
  let finalSlug = slug;
  let counter = 1;
  while (existingSlugs.includes(finalSlug)) {
    finalSlug = `${slug}-${counter}`;
    counter++;
  }
  return finalSlug;
};

// Load template from JSON file
async function loadTemplate() {
  try {
    const data = await fs.readFile(path.join(__dirname, 'template-biolis-au480-clia.json'), 'utf8');
    return JSON.parse(data);
  } catch (err) {
    console.error('Error loading template:', err);
    return [];
  }
}

// ===== HubSpot Ticket Polling Engine =====
// Polls HubSpot for tickets in target stages and creates service reports
// Workaround for when HubSpot webhooks are not available

function getDefaultPollingConfig() {
  return {
    enabled: true,
    intervalSeconds: config.HUBSPOT_POLL_INTERVAL_SECONDS,
    startedAt: new Date().toISOString(),
    lastPollTime: null,
    processedTicketIds: [],
    targetStages: config.HUBSPOT_TARGET_STAGES,
    resolvedStageIds: [],
    stageIdsCachedAt: null,
    filter: {
      mode: 'property',       // 'keyword' | 'property' | 'all'
      subjectKeyword: '[SR]', // For keyword mode: only tickets with this in subject
      propertyName: 'create_service_report', // For property mode: HubSpot custom property name
      propertyValue: 'true'   // For property mode: expected value
    },
    stats: {
      totalPolls: 0,
      totalReportsCreated: 0,
      lastSuccessfulPoll: null,
      lastError: null,
      lastErrorTime: null
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

async function pollHubSpotTickets() {
  try {
    const config = await db.get('ticket_polling_config');
    if (!config || !config.enabled) return;

    console.log('[HubSpot Poll] Starting poll cycle...');

    // Resolve stage IDs from labels if not cached or cache is stale (refresh every hour)
    const cacheAge = config.stageIdsCachedAt
      ? Date.now() - new Date(config.stageIdsCachedAt).getTime()
      : Infinity;

    if (!config.resolvedStageIds || !config.resolvedStageIds.length || cacheAge > HUBSPOT_STAGE_CACHE_TTL) {
      try {
        const pipelines = await hubspot.getTicketPipelines();
        const targetLabels = config.targetStages.map(s => s.toLowerCase());
        const stageIds = [];
        for (const pipeline of pipelines) {
          for (const stage of pipeline.stages) {
            if (targetLabels.some(t => stage.label.toLowerCase().includes(t))) {
              stageIds.push(stage.id);
            }
          }
        }
        config.resolvedStageIds = stageIds;
        config.stageIdsCachedAt = new Date().toISOString();
        await db.set('ticket_polling_config', config);
        console.log(`[HubSpot Poll] Resolved ${stageIds.length} target stage ID(s).`);
      } catch (pipelineErr) {
        console.error('[HubSpot Poll] Failed to resolve stage IDs:', pipelineErr.message);
        config.stats.lastError = 'Failed to resolve stage IDs: ' + pipelineErr.message;
        config.stats.lastErrorTime = new Date().toISOString();
        await db.set('ticket_polling_config', config);
        return;
      }
    }

    if (!config.resolvedStageIds.length) {
      console.log('[HubSpot Poll] No target stage IDs resolved. Check targetStages config.');
      return;
    }

    // Use lastPollTime if available, otherwise startedAt (first poll = fresh start)
    const sinceTime = config.lastPollTime || config.startedAt;

    // Include custom property in search if using property filter mode
    const additionalProps = [];
    if (config.filter.mode === 'property' && config.filter.propertyName) {
      additionalProps.push(config.filter.propertyName);
    }

    // Search HubSpot for tickets in target stages modified since last poll
    let candidates;
    try {
      candidates = await hubspot.searchTicketsByStage(
        config.resolvedStageIds,
        sinceTime,
        additionalProps
      );
    } catch (searchErr) {
      console.error('[HubSpot Poll] Search failed:', searchErr.message);
      config.stats.lastError = 'Search failed: ' + searchErr.message;
      config.stats.lastErrorTime = new Date().toISOString();
      config.stats.totalPolls++;
      await db.set('ticket_polling_config', config);
      return;
    }

    if (!candidates.length) {
      config.lastPollTime = new Date().toISOString();
      config.stats.totalPolls++;
      config.stats.lastSuccessfulPoll = new Date().toISOString();
      config.stats.lastError = null;
      await db.set('ticket_polling_config', config);
      return;
    }

    console.log(`[HubSpot Poll] Found ${candidates.length} candidate ticket(s).`);

    // Filter out already-processed tickets
    const processedIds = new Set(config.processedTicketIds || []);
    let filteredCandidates = candidates.filter(t => !processedIds.has(String(t.id)));

    // Apply the configured filter mode
    if (config.filter.mode === 'keyword') {
      const keyword = (config.filter.subjectKeyword || '').toLowerCase();
      if (keyword) {
        filteredCandidates = filteredCandidates.filter(t => {
          const subject = (t.properties?.subject || '').toLowerCase();
          return subject.includes(keyword);
        });
      }
    } else if (config.filter.mode === 'property') {
      const propName = config.filter.propertyName;
      const propValue = (config.filter.propertyValue || '').toLowerCase();
      if (propName && propValue) {
        filteredCandidates = filteredCandidates.filter(t => {
          const val = (t.properties?.[propName] || '').toLowerCase();
          return val === propValue;
        });
      }
    }
    // mode === 'all' means no additional filtering

    if (!filteredCandidates.length) {
      config.lastPollTime = new Date().toISOString();
      config.stats.totalPolls++;
      config.stats.lastSuccessfulPoll = new Date().toISOString();
      config.stats.lastError = null;
      await db.set('ticket_polling_config', config);
      return;
    }

    console.log(`[HubSpot Poll] ${filteredCandidates.length} ticket(s) passed filter. Processing...`);

    // Load existing service reports and users for duplicate check and owner mapping
    const serviceReports = (await db.get('service_reports')) || [];
    const existingTicketIds = new Set(
      serviceReports.map(r => String(r.hubspotTicketNumber)).filter(Boolean)
    );
    const users = (await db.get('users')) || [];

    let reportsCreated = 0;

    for (const candidate of filteredCandidates) {
      const ticketId = String(candidate.id);

      // Skip if service report already exists for this ticket
      if (existingTicketIds.has(ticketId)) {
        console.log(`[HubSpot Poll] Service report already exists for ticket ${ticketId}, skipping.`);
        processedIds.add(ticketId);
        continue;
      }

      // Fetch full ticket details (company, contact, notes)
      let ticket;
      try {
        ticket = await hubspot.getTicketById(ticketId);
      } catch (fetchErr) {
        console.error(`[HubSpot Poll] Failed to fetch ticket ${ticketId}:`, fetchErr.message);
        continue;
      }

      // Map HubSpot owner to internal user
      const { id: assignedToId, name: assignedToName } = await resolveHubSpotOwnerToUser(ticket.ownerId, users);

      if (!assignedToId) {
        console.log(`[HubSpot Poll] No internal user match for ticket ${ticketId} (owner ${ticket.ownerId}). Skipping.`);
        processedIds.add(ticketId);
        continue;
      }

      // Map service type from issue category
      const issueCategoryLower = (ticket.issueCategory || '').toLowerCase();
      const serviceType = config.SERVICE_TYPE_MAP[issueCategoryLower] || '';

      // Create the service report
      const clientSlugResolved = await resolveClientSlug(ticket.companyName, ticket.companyId);
      const newReport = buildServiceReportFromTicket(ticket, assignedToId, assignedToName, serviceType, clientSlugResolved, 'polling');

      serviceReports.push(newReport);
      existingTicketIds.add(ticketId);
      processedIds.add(ticketId);
      reportsCreated++;

      console.log(`[HubSpot Poll] Created service report ${newReport.id} from ticket ${ticketId} -> ${assignedToName}`);

      // Log activity
      try {
        await logActivity(
          'system',
          'HubSpot Polling',
          'service_report_auto_assigned',
          'service_report',
          newReport.id,
          {
            ticketId,
            assignedTo: assignedToName,
            clientName: ticket.companyName,
            source: 'polling'
          }
        );
      } catch (logErr) {
        console.log('[HubSpot Poll] Could not log activity:', logErr.message);
      }
    }

    // Persist all new service reports
    if (reportsCreated > 0) {
      await db.set('service_reports', serviceReports);
    }

    // Update polling config state
    config.processedTicketIds = Array.from(processedIds);
    // Trim to last 500 IDs to prevent unbounded growth
    if (config.processedTicketIds.length > 500) {
      config.processedTicketIds = config.processedTicketIds.slice(-500);
    }
    config.lastPollTime = new Date().toISOString();
    config.stats.totalPolls++;
    config.stats.totalReportsCreated += reportsCreated;
    config.stats.lastSuccessfulPoll = new Date().toISOString();
    config.stats.lastError = null;
    config.stats.lastErrorTime = null;
    await db.set('ticket_polling_config', config);

    console.log(`[HubSpot Poll] Cycle complete. Created ${reportsCreated} report(s).`);
  } catch (error) {
    console.error('[HubSpot Poll] Unexpected error:', error.message);
    try {
      const config = await db.get('ticket_polling_config');
      if (config) {
        config.stats.lastError = error.message;
        config.stats.lastErrorTime = new Date().toISOString();
        config.stats.totalPolls++;
        await db.set('ticket_polling_config', config);
      }
    } catch (dbErr) {
      console.error('[HubSpot Poll] Could not persist error state:', dbErr.message);
    }
  }
}

async function initializeTicketPolling() {
  try {
    let config = await db.get('ticket_polling_config');
    if (!config) {
      config = getDefaultPollingConfig();
      await db.set('ticket_polling_config', config);
      console.log('[HubSpot Poll] Initialized default config (enabled, 60s, property filter "create_service_report")');
    }

    if (config.enabled) {
      const interval = (config.intervalSeconds || 60) * 1000;
      hubspotPollingTimer = setInterval(pollHubSpotTickets, interval);
      console.log(`[HubSpot Poll] Polling started (every ${config.intervalSeconds || 60}s, filter: ${config.filter?.mode || 'keyword'})`);
    } else {
      console.log('[HubSpot Poll] Polling is disabled in config.');
    }
  } catch (err) {
    console.error('[HubSpot Poll] Failed to initialize:', err.message);
  }
}

// Cascade update: propagate name changes to all related data stores
// Called when a user's name or practiceName changes
async function cascadeUserNameUpdate(userId, oldName, newName, oldPracticeName, newPracticeName) {
  const changes = [];

  // Update service reports
  try {
    const serviceReports = (await db.get('service_reports')) || [];
    let srUpdated = false;
    serviceReports.forEach(r => {
      // Update technician name references
      if (oldName && newName && oldName !== newName) {
        if (r.technicianName === oldName) { r.technicianName = newName; srUpdated = true; }
        if (r.serviceProviderName === oldName) { r.serviceProviderName = newName; srUpdated = true; }
        if (r.assignedToName === oldName) { r.assignedToName = newName; srUpdated = true; }
        if (r.assignedByName === oldName) { r.assignedByName = newName; srUpdated = true; }
        if (r.technicianId === userId && r.technicianName !== newName) { r.technicianName = newName; srUpdated = true; }
        if (r.assignedToId === userId && r.assignedToName !== newName) { r.assignedToName = newName; srUpdated = true; }
      }
      // Update client facility name references
      if (oldPracticeName && newPracticeName && oldPracticeName !== newPracticeName) {
        if (r.clientFacilityName === oldPracticeName) { r.clientFacilityName = newPracticeName; srUpdated = true; }
      }
    });
    if (srUpdated) {
      await db.set('service_reports', serviceReports);
      changes.push('service_reports');
    }
  } catch (err) {
    console.error('Cascade update service_reports error:', err.message);
  }

  // Update client_documents titles that reference the old name
  if (oldPracticeName && newPracticeName && oldPracticeName !== newPracticeName) {
    try {
      const clientDocuments = (await db.get('client_documents')) || [];
      let docsUpdated = false;
      clientDocuments.forEach(d => {
        if (d.title && d.title.includes(oldPracticeName)) {
          d.title = d.title.replace(oldPracticeName, newPracticeName);
          docsUpdated = true;
        }
        if (d.description && d.description.includes(oldPracticeName)) {
          d.description = d.description.replace(oldPracticeName, newPracticeName);
          docsUpdated = true;
        }
      });
      if (docsUpdated) {
        await db.set('client_documents', clientDocuments);
        changes.push('client_documents');
      }
    } catch (err) {
      console.error('Cascade update client_documents error:', err.message);
    }
  }

  // Update project clientName references
  if (oldPracticeName && newPracticeName && oldPracticeName !== newPracticeName) {
    try {
      const projects = await getProjects();
      let projUpdated = false;
      projects.forEach(p => {
        if (p.clientName === oldPracticeName) {
          p.clientName = newPracticeName;
          projUpdated = true;
        }
      });
      if (projUpdated) {
        await db.set('projects', projects);
        changes.push('projects');
      }
    } catch (err) {
      console.error('Cascade update projects error:', err.message);
    }
  }

  // Update vendor assignedClients display names if this is a client user
  if (oldPracticeName && newPracticeName && oldPracticeName !== newPracticeName) {
    try {
      const users = await getUsers();
      let usersUpdated = false;
      users.forEach(u => {
        if (u.role === config.ROLES.VENDOR && Array.isArray(u.assignedClients)) {
          // assignedClients stores client user IDs, but update any cached display names
          if (u.assignedClientNames && Array.isArray(u.assignedClientNames)) {
            const idx = u.assignedClientNames.indexOf(oldPracticeName);
            if (idx !== -1) { u.assignedClientNames[idx] = newPracticeName; usersUpdated = true; }
          }
        }
      });
      if (usersUpdated) {
        await db.set('users', users);
        invalidateUsersCache();
        changes.push('users (vendor assignedClientNames)');
      }
    } catch (err) {
      console.error('Cascade update vendor assignedClients error:', err.message);
    }
  }

  // Update announcements that reference the old name
  if (oldName && newName && oldName !== newName) {
    try {
      const announcements = (await db.get('announcements')) || [];
      let annUpdated = false;
      announcements.forEach(a => {
        if (a.createdByName === oldName) { a.createdByName = newName; annUpdated = true; }
      });
      if (annUpdated) {
        await db.set('announcements', announcements);
        changes.push('announcements');
      }
    } catch (err) {
      console.error('Cascade update announcements error:', err.message);
    }
  }

  if (changes.length > 0) {
    console.log(`🔄 Cascade name update for user ${userId}: updated ${changes.join(', ')}`);
  }
}

// Cascade slug change: migrate per-slug keys and update references when a client's slug changes
async function cascadeSlugChange(userId, oldSlug, newSlug) {
  if (!oldSlug || !newSlug || oldSlug === newSlug) return;
  const changes = [];

  // Update client_documents slug references
  try {
    const clientDocs = (await db.get('client_documents')) || [];
    let docsUpdated = false;
    clientDocs.forEach(d => {
      if (d.slug === oldSlug) { d.slug = newSlug; docsUpdated = true; }
    });
    if (docsUpdated) {
      await db.set('client_documents', clientDocs);
      changes.push('client_documents');
    }
  } catch (err) { console.error('Cascade slug client_documents error:', err.message); }

  // Update service_reports clientSlug references
  try {
    const serviceReports = (await db.get('service_reports')) || [];
    let srUpdated = false;
    serviceReports.forEach(r => {
      if (r.clientSlug === oldSlug) { r.clientSlug = newSlug; srUpdated = true; }
    });
    if (srUpdated) {
      await db.set('service_reports', serviceReports);
      changes.push('service_reports');
    }
  } catch (err) { console.error('Cascade slug service_reports error:', err.message); }

  // Update project clientLinkSlug references and track previous slugs
  try {
    const projects = await getProjects();
    let projUpdated = false;
    projects.forEach(p => {
      if (p.clientLinkSlug === oldSlug) {
        if (!Array.isArray(p.previousSlugs)) p.previousSlugs = [];
        p.previousSlugs.push(oldSlug);
        p.clientLinkSlug = newSlug;
        projUpdated = true;
      }
    });
    if (projUpdated) {
      await db.set('projects', projects);
      changes.push('projects');
    }
  } catch (err) { console.error('Cascade slug projects error:', err.message); }

  if (changes.length > 0) {
    console.log(`🔄 Cascade slug change for user ${userId}: ${oldSlug} → ${newSlug}, updated ${changes.join(', ')}`);
  }
}

// ---- Entity Resolvers ----
// Resolve current display names from entity IDs at read time
// This ensures data always reflects current state, not stale snapshots

async function resolveUserName(userId) {
  if (!userId || userId === 'system') return userId === 'system' ? 'System' : 'Unknown';
  const users = await getUsers();
  const user = users.find(u => u.id === userId);
  return user ? user.name : 'Unknown User';
}

async function resolveClientData(clientIdOrSlug) {
  const users = await getUsers();
  const client = users.find(u =>
    (u.id === clientIdOrSlug || u.slug === clientIdOrSlug) && u.role === config.ROLES.CLIENT
  );
  if (!client) return null;
  return {
    id: client.id,
    name: client.name,
    practiceName: client.practiceName,
    slug: client.slug,
    email: client.email,
    logo: client.logo
  };
}

// Enrich a service report with current entity names at read time
async function enrichServiceReport(report) {
  const enriched = { ...report };
  if (report.assignedToId) {
    const name = await resolveUserName(report.assignedToId);
    if (name !== 'Unknown User') enriched.assignedToName = name;
  }
  if (report.technicianId) {
    const name = await resolveUserName(report.technicianId);
    if (name !== 'Unknown User') enriched.technicianName = name;
  }
  if (report.assignedById) {
    const name = await resolveUserName(report.assignedById);
    if (name !== 'Unknown User') enriched.assignedByName = name;
  }
  return enriched;
}

// Auth middleware (accepts token from header or query param for downloads)
const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  let token = authHeader && authHeader.split(' ')[1];
  // Also accept token from query param (for file downloads)
  if (!token && req.query.token) {
    token = req.query.token;
  }
  if (!token) return res.status(401).json({ error: 'Access denied' });
  jwt.verify(token, JWT_SECRET, async (err, tokenUser) => {
    if (err) return res.status(403).json({ error: 'Invalid token' });
    try {
      // Fetch fresh user data from database to get current role and permissions
      const users = await getUsers();
      const freshUser = users.find(u => u.id === tokenUser.id);
      if (!freshUser) return res.status(403).json({ error: 'User not found' });
      // Block inactive accounts
      if (freshUser.accountStatus === 'inactive') return res.status(403).json({ error: 'Account is inactive. Please contact an administrator.' });
      // Use fresh data for all user properties to ensure permission changes take effect immediately
      // Determine if user is a manager (has limited admin access)
      const isManager = freshUser.isManager || false;

      req.user = {
        id: freshUser.id,
        email: freshUser.email,
        name: freshUser.name,
        role: freshUser.role, // admin (super admin), user, client, vendor
        assignedProjects: freshUser.assignedProjects || [],
        projectAccessLevels: freshUser.projectAccessLevels || {},
        // Manager flag - provides limited admin access (client portal admin + service portal in admin hub)
        isManager: isManager,
        // Granular permission flags
        hasServicePortalAccess: freshUser.hasServicePortalAccess || false,
        hasAdminHubAccess: freshUser.hasAdminHubAccess || false,
        hasImplementationsAccess: freshUser.hasImplementationsAccess || false,
        // Managers automatically get client portal admin access
        hasClientPortalAdminAccess: freshUser.hasClientPortalAdminAccess || isManager || false,
        // Vendor-specific: clients they can service
        assignedClients: freshUser.assignedClients || [],
        // Client-specific fields
        isNewClient: freshUser.isNewClient || false,
        slug: freshUser.slug || null,
        practiceName: freshUser.practiceName || null,
        // GFC client/family enrollment + consent fields (drive the portal gate)
        enrollmentStatus: freshUser.enrollmentStatus || null,
        serviceLine: freshUser.serviceLine || null,
        consents: freshUser.consents || {},
        careTeam: freshUser.careTeam || null,
        // Family role: the client whose record this family member is authorized to view
        familyOfClientId: freshUser.familyOfClientId || (freshUser.role === config.ROLES.FAMILY ? (freshUser.assignedClients || [])[0] : null) || null
      };
      next();
    } catch (error) {
      console.error('Auth middleware error:', error);
      res.status(500).json({ error: 'Authentication error' });
    }
  });
};

// Authorization helper to check project access
const canAccessProject = (user, projectId) => {
  if (user.role === config.ROLES.ADMIN) return true;
  return (user.assignedProjects || []).includes(projectId);
};

// Authorization helper to check write access to a project
const canWriteProject = (user, projectId) => {
  if (user.role === config.ROLES.ADMIN) return true;
  if (!(user.assignedProjects || []).includes(projectId)) return false;
  const level = (user.projectAccessLevels || {})[projectId];
  return level === 'write' || level === 'admin';
};

// Generate a unique slug for client users
const generateClientUserSlug = async (practiceName) => {
  const users = await getUsers();
  const existingSlugs = users.filter(u => u.slug).map(u => u.slug);
  return generateClientSlug(practiceName, existingSlugs);
};

// Resolve a clientFacilityName to its matching client slug
// Uses bidirectional matching to handle name variations
const resolveClientSlug = async (clientFacilityName, hubspotCompanyId, existingUsers) => {
  if (!clientFacilityName && !hubspotCompanyId) return '';
  const users = existingUsers || await getUsers();
  const clientUsers = users.filter(u => u.role === config.ROLES.CLIENT && u.slug);
  const facilityLower = (clientFacilityName || '').toLowerCase().trim();

  // 1. Match by hubspotCompanyId (most reliable)
  if (hubspotCompanyId) {
    const match = clientUsers.find(u => u.hubspotCompanyId && String(u.hubspotCompanyId) === String(hubspotCompanyId));
    if (match) return match.slug;
  }

  // 2. Exact name match on practiceName
  const exactMatch = clientUsers.find(u => (u.practiceName || '').toLowerCase().trim() === facilityLower);
  if (exactMatch) return exactMatch.slug;

  // 3. Bidirectional includes match
  if (facilityLower) {
    const includesMatch = clientUsers.find(u => {
      const practice = (u.practiceName || '').toLowerCase().trim();
      return practice && (practice.includes(facilityLower) || facilityLower.includes(practice));
    });
    if (includesMatch) return includesMatch.slug;
  }

  return '';
};

// Map a HubSpot owner ID to an internal user with service portal access
async function resolveHubSpotOwnerToUser(ownerId, users) {
  if (!ownerId) return { id: null, name: null };

  try {
    const owners = await hubspot.getOwners();
    const hubspotOwner = owners.find(o => String(o.id) === String(ownerId));

    if (!hubspotOwner) return { id: null, name: null };

    // Try email match first
    if (hubspotOwner.email) {
      const userByEmail = users.find(u =>
        u.email && u.email.toLowerCase() === hubspotOwner.email.toLowerCase() &&
        (u.role === config.ROLES.VENDOR || u.role === config.ROLES.ADMIN || u.hasServicePortalAccess)
      );
      if (userByEmail) return { id: userByEmail.id, name: userByEmail.name };
    }

    // Fall back to name match
    if (hubspotOwner.firstName && hubspotOwner.lastName) {
      const fullName = `${hubspotOwner.firstName} ${hubspotOwner.lastName}`;
      const userByName = users.find(u =>
        u.name && u.name.toLowerCase() === fullName.toLowerCase() &&
        (u.role === config.ROLES.VENDOR || u.role === config.ROLES.ADMIN || u.hasServicePortalAccess)
      );
      if (userByName) return { id: userByName.id, name: userByName.name };
    }
  } catch (err) {
    console.log(`Could not match HubSpot owner ${ownerId}:`, err.message);
  }

  return { id: null, name: null };
}

// Build a service report object from a HubSpot ticket
// Used by both the polling engine and webhook handler
function buildServiceReportFromTicket(ticket, assignedToId, assignedToName, serviceType, clientSlug, source) {
  let managerNotes = '';
  if (ticket.description) {
    managerNotes += `**Ticket Description:**\n${ticket.description}\n\n`;
  }
  if (ticket.notes && ticket.notes.length > 0) {
    managerNotes += `**Ticket Notes:**\n`;
    ticket.notes.forEach((note) => {
      const timestamp = note.timestamp ? new Date(parseInt(note.timestamp)).toLocaleString() : '';
      managerNotes += `\n[${timestamp}]\n${note.body}\n`;
      if (note.attachmentIds) {
        managerNotes += `(Attachments: ${note.attachmentIds})\n`;
      }
    });
  }

  return {
    id: uuidv4(),
    status: 'assigned',
    assignedToId,
    assignedToName,
    assignedById: 'system',
    assignedByName: source === 'polling' ? 'HubSpot Polling' : 'HubSpot Automation',
    assignedAt: new Date().toISOString(),
    clientFacilityName: ticket.companyName || '',
    clientSlug: clientSlug,
    customerName: ticket.submittedBy || '',
    serviceProviderName: assignedToName,
    address: '',
    serviceType,
    analyzerModel: '',
    analyzerSerialNumber: ticket.serialNumber || '',
    hubspotTicketNumber: String(ticket.id),
    hubspotCompanyId: ticket.companyId || '',
    hubspotDealId: '',
    serviceCompletionDate: new Date().toISOString().split('T')[0],
    managerNotes: managerNotes.trim(),
    photos: [],
    clientFiles: [],
    technicianId: null,
    technicianName: null,
    descriptionOfWork: '',
    materialsUsed: '',
    solution: '',
    outstandingIssues: '',
    validationResults: '',
    validationStartDate: '',
    validationEndDate: '',
    trainingProvided: '',
    testProcedures: '',
    recommendations: '',
    analyzersValidated: [],
    customerSignature: null,
    customerSignatureDate: null,
    technicianSignature: null,
    technicianSignatureDate: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    createdViaWebhook: true,
    ...(source === 'polling' ? { createdViaPolling: true } : {})
  };
}

// Super Admin access - full system access (role === 'admin')
const requireAdmin = (req, res, next) => {
  if (req.user.role !== config.ROLES.ADMIN) {
    return res.status(403).json({ error: 'Super Admin access required' });
  }
  next();
};

// Alias for clarity - Super Admin only routes
const requireSuperAdmin = requireAdmin;

// Require Admin Hub access (super admins, managers, or users with hasAdminHubAccess)
// Note: Managers can access Admin Hub but only Service Portal section (UI handles section visibility)
const requireAdminHubAccess = (req, res, next) => {
  if (req.user.role === config.ROLES.ADMIN || req.user.isManager || req.user.hasAdminHubAccess) {
    return next();
  }
  return res.status(403).json({ error: 'Admin Hub access required' });
};

// Require Super Admin for sensitive Admin Hub operations (Inbox, User Management)
const requireAdminHubFullAccess = (req, res, next) => {
  if (req.user.role === config.ROLES.ADMIN) {
    return next();
  }
  return res.status(403).json({ error: 'Super Admin access required for this operation' });
};

// Require Implementations App access
const requireImplementationsAccess = (req, res, next) => {
  if (req.user.role === config.ROLES.ADMIN || req.user.hasImplementationsAccess ||
      (req.user.assignedProjects && req.user.assignedProjects.length > 0)) {
    return next();
  }
  return res.status(403).json({ error: 'Implementations App access required' });
};

// Require Client Portal Admin access (super admins, managers, or users with hasClientPortalAdminAccess)
const requireClientPortalAdmin = (req, res, next) => {
  if (req.user.role === config.ROLES.ADMIN || req.user.isManager || req.user.hasClientPortalAdminAccess) {
    return next();
  }
  return res.status(403).json({ error: 'Client Portal admin access required' });
};

// ============== GFC ENROLLMENT GATE ==============
// Resolve the underlying client record a request operates on.
//   - client role  → the client themselves
//   - family role  → the client they are an authorized contact for (familyOfClientId)
// Returns the full fresh user record (not the trimmed req.user), or null.
const resolveGfcClientRecord = async (reqUser) => {
  const users = await getUsers();
  if (reqUser.role === config.ROLES.CLIENT) {
    return users.find(u => u.id === reqUser.id) || null;
  }
  if (reqUser.role === config.ROLES.FAMILY) {
    const clientId = reqUser.familyOfClientId;
    if (!clientId) return null;
    return users.find(u => u.id === clientId && u.role === config.ROLES.CLIENT) || null;
  }
  return null;
};

// The enrollment gate — enforced at the API layer, default-deny.
// Protects every client-portal data route EXCEPT the intake/consent flow itself.
//   - client  + enrollmentStatus 'intake_pending'  → 403 INTAKE_REQUIRED (portal shows only intake)
//   - client  + intake_complete | enrolled         → allowed
//   - family  + linked client's consents.roiFamily 'signed' → allowed, else 403 ROI_FAMILY_REQUIRED
//   - admin / manager / clinical / case manager     → allowed (staff oversight)
// Anything not explicitly allowed is denied.
const requireEnrolledClient = async (req, res, next) => {
  try {
    const role = req.user.role;

    // Staff oversight roles are not subject to the client enrollment gate.
    if (role === config.ROLES.ADMIN || role === config.ROLES.USER ||
        role === config.ROLES.CASE_MANAGER || req.user.isManager ||
        req.user.hasClientPortalAdminAccess) {
      return next();
    }

    if (role === config.ROLES.CLIENT) {
      const status = req.user.enrollmentStatus || 'intake_pending';
      if (status === 'intake_pending') {
        return res.status(403).json({
          error: 'Enrollment is not complete. Finish intake and required consents to unlock your portal.',
          code: 'INTAKE_REQUIRED'
        });
      }
      // intake_complete or enrolled → portal unlocked
      return next();
    }

    if (role === config.ROLES.FAMILY) {
      const client = await resolveGfcClientRecord(req.user);
      if (!client) {
        return res.status(403).json({ error: 'No authorized client on file for this account.', code: 'NO_CLIENT_LINK' });
      }
      const roiFamily = (client.consents || {}).roiFamily;
      // Accept signed OR signed_offline (paper-signed ROI is equally valid — Scope B1).
      if (!isConsentSatisfied(roiFamily)) {
        return res.status(403).json({
          error: 'Family access is locked until the Release of Information (family) consent is signed. No override.',
          code: 'ROI_FAMILY_REQUIRED'
        });
      }
      return next();
    }

    // Default-deny: any other role has no business on client-portal routes.
    return res.status(403).json({ error: 'Access denied' });
  } catch (error) {
    console.error('Enrollment gate error:', error);
    return res.status(500).json({ error: 'Authorization error' });
  }
};

// Intake-scoped access — only the client themselves runs Stage 2 enrollment,
// regardless of enrollmentStatus (this is what the gate sends them to). Family
// and staff never submit a client's intake. Default-deny.
const requireClientForIntake = (req, res, next) => {
  if (req.user.role === config.ROLES.CLIENT) return next();
  return res.status(403).json({ error: 'Only the client can complete enrollment intake.' });
};

// ============== GFC ENROLLMENT INTAKE (Stage 2) — consent definitions ==============
// Branched consent set per GFC_Intake_and_Packet_Spec_v1.md §4.2.
// NOTE: the rewritten consent language below is a WORKING DRAFT, pending
// counsel / Georgia licensure review before HIPAA-live. Do not treat as final.
// Each consent status is one of: signed | signed_offline | pending | na.
// A requirement is SATISFIED by either `signed` (e-signed in-app) or
// `signed_offline` (signed on paper, offline onboarding — Scope B1). See
// isConsentSatisfied() — the enrollment gate treats the two identically.
const GFC_CONSENT_DEFS = [
  // Both service lines
  { type: 'npp',                scope: 'both', required: true,  title: 'HIPAA Notice of Privacy Practices' },
  { type: 'roiFamily',          scope: 'both', required: true,  title: 'Release of Information — Family' },
  { type: 'roiProvider',        scope: 'both', required: true,  title: 'Release of Information — Providers' },
  { type: 'serviceAgreement',   scope: 'both', required: true,  title: 'Service Agreement' },
  { type: 'billOfRights',       scope: 'both', required: true,  title: 'Patient Bill of Rights & Self-Determination' },
  { type: 'emergencyFinancial', scope: 'both', required: true,  title: 'Emergency Treatment & Financial Responsibility' },
  { type: 'crisisProtocol',     scope: 'both', required: true,  title: 'Emergency & Crisis Protocol (911/988)' },
  { type: 'monitoring',         scope: 'both', required: false, title: 'Continuous Monitoring Opt-In', inactive: true },
  // Private Home Care only
  { type: 'financialAgreement', scope: 'phc',  required: true,  title: 'Financial Agreement (rates, billing, cancellation)' },
  { type: 'pcaScope',           scope: 'phc',  required: true,  title: 'Personal Care Aide Scope Acknowledgment' },
  // In-Home Primary Care only
  { type: 'consentToTreat',     scope: 'ihpc', required: true,  title: 'Consent to Medical Treatment' },
  { type: 'assignmentOfBenefits', scope: 'ihpc', required: true, title: 'Assignment of Medicare / Insurance Benefits' },
  { type: 'practiceNpp',        scope: 'ihpc', required: true,  title: 'Medical Practice Notice of Privacy Practices' }
];

// Which consent definitions apply to a given service line.
const consentDefsForServiceLine = (serviceLine) => {
  const line = (serviceLine || 'PHC').toUpperCase();
  return GFC_CONSENT_DEFS.filter(d => {
    if (d.scope === 'both') return true;
    if (d.scope === 'phc') return line === 'PHC' || line === 'BOTH';
    if (d.scope === 'ihpc') return line === 'IHPC' || line === 'BOTH';
    return false;
  });
};
const requiredConsentTypes = (serviceLine) =>
  consentDefsForServiceLine(serviceLine).filter(d => d.required).map(d => d.type);

// Consent status vocabulary (Session 3.3, Scope B1):
//   signed         — e-signed in-app during Stage-2 intake
//   signed_offline — signed on paper before the app existed (offline onboarding);
//                    satisfies the enrollment gate identically to `signed`, kept
//                    distinct only so the audit trail preserves how it was captured
//   pending        — required but not yet satisfied
//   na             — not applicable / opted out (inactive consents)
// Both `signed` and `signed_offline` satisfy every enrollment requirement.
const CONSENT_SATISFIED_STATUSES = ['signed', 'signed_offline'];
const isConsentSatisfied = (status) => CONSENT_SATISFIED_STATUSES.includes(status);

// Uploads require authentication - registered here after authenticateToken is defined
app.use('/uploads', authenticateToken, express.static('uploads', staticOptions));
// Fallback: serve from public/uploads for files saved before path fix
app.use('/uploads', authenticateToken, express.static('public/uploads', staticOptions));

// ============== AUTH ROUTES ==============
app.post('/api/auth/signup', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { email, password, name } = req.body;
    if (!email || !password || !name) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }
    // Validate password strength (min 8 chars, at least one uppercase, one lowercase, one number)
    if (password.length < config.MIN_PASSWORD_LENGTH) {
      return res.status(400).json({ error: `Password must be at least ${config.MIN_PASSWORD_LENGTH} characters long` });
    }
    if (!config.PASSWORD_REGEX.test(password)) {
      return res.status(400).json({ error: 'Password must contain at least one uppercase letter, one lowercase letter, and one number' });
    }
    const users = await getUsers();
    if (users.find(u => u.email?.toLowerCase() === email.toLowerCase())) {
      return res.status(400).json({ error: 'User already exists' });
    }
    const hashedPassword = await bcrypt.hash(password, config.BCRYPT_SALT_ROUNDS);
    users.push({
      id: uuidv4(),
      email: email.toLowerCase().trim(),
      name,
      password: hashedPassword,
      role: config.ROLES.USER,
      createdAt: new Date().toISOString()
    });
    await db.set('users', users);
    invalidateUsersCache();
    res.json({ message: 'Account created successfully' });
  } catch (error) {
    console.error('Signup error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin create user endpoint (Super Admin or Manager for client users only)
app.post('/api/users', authenticateToken, async (req, res) => {
  try {
    // Super Admin can create any user type, Managers can only create client users
    const isSuperAdmin = req.user.role === config.ROLES.ADMIN;
    const isCurrentUserManager = req.user.isManager || false;

    if (!isSuperAdmin && !isCurrentUserManager) {
      return res.status(403).json({ error: 'Admin or Manager access required' });
    }
    const {
      email, password, name, role, practiceName, isNewClient, assignedProjects, logo,
      hasServicePortalAccess, hasAdminHubAccess, hasImplementationsAccess, hasClientPortalAdminAccess,
      isManager, assignedClients, hubspotCompanyId, hubspotDealId, hubspotContactId, projectAccessLevels,
      existingPortalSlug, phone, sendWelcomeEmail: shouldSendWelcome = true,
      licenseLevel, hasClinicalAccess, enrollmentStatus, careTeam, familyOfClientId
    } = req.body;

    // Managers can only create client users
    if (isCurrentUserManager && !isSuperAdmin && role !== config.ROLES.CLIENT) {
      return res.status(403).json({ error: 'Managers can only create client users' });
    }

    if (!email || !password || !name) {
      return res.status(400).json({ error: 'Email, password, and name are required' });
    }
    const users = await getUsers();
    if (users.find(u => u.email === email)) {
      return res.status(400).json({ error: 'User already exists with this email' });
    }
    const hashedPassword = await bcrypt.hash(password, config.BCRYPT_SALT_ROUNDS);
    const newUser = {
      id: uuidv4(),
      email,
      name,
      password: hashedPassword,
      role: role || config.ROLES.USER, // admin (super admin), user, client, vendor
      // Manager flag - provides limited admin access
      isManager: isManager || false,
      // Permission flags
      hasServicePortalAccess: hasServicePortalAccess || false,
      hasAdminHubAccess: hasAdminHubAccess || false,
      hasImplementationsAccess: hasImplementationsAccess || false,
      hasClientPortalAdminAccess: hasClientPortalAdminAccess || false,
      // GFC extended fields
      hasClinicalAccess: hasClinicalAccess || false,
      licenseLevel: licenseLevel || null,
      createdAt: new Date().toISOString(),
      // Account status — active accounts receive notifications, inactive do not
      accountStatus: 'active',
      // Email subscription — false means user has unsubscribed from automated emails
      emailUnsubscribed: false,
      // Contact
      phone: phone || '',
      // Notification preferences
      notificationPreferences: {
        emailReminders: true,
        overdueReminders: true,
        milestoneNotifications: true
      },
      // Force new users to change their password on first login
      requirePasswordChange: true,
      lastPasswordReset: new Date().toISOString()
    };

    // Client-specific fields
    if (role === config.ROLES.CLIENT) {
      // GFC client enrollment & care team defaults
      newUser.enrollmentStatus = enrollmentStatus || 'intake_pending';
      newUser.careTeam = careTeam || { assignedFNPs: [], assignedCaseManager: null, primaryCaregiver: null, backupCaregiver: null };
      // If adding user to an existing portal, inherit slug and practice settings
      if (existingPortalSlug) {
        const existingClient = users.find(u => u.role === config.ROLES.CLIENT && u.slug === existingPortalSlug);
        if (!existingClient) {
          return res.status(400).json({ error: 'Existing portal not found' });
        }
        newUser.practiceName = practiceName || existingClient.practiceName;
        newUser.slug = existingPortalSlug;
        newUser.isNewClient = false;
        newUser.assignedProjects = assignedProjects || existingClient.assignedProjects || [];
        newUser.projectAccessLevels = projectAccessLevels || existingClient.projectAccessLevels || {};
        newUser.logo = logo || existingClient.logo || '';
        newUser.hubspotCompanyId = hubspotCompanyId || existingClient.hubspotCompanyId || '';
        newUser.hubspotDealId = hubspotDealId || existingClient.hubspotDealId || '';
        newUser.hubspotContactId = hubspotContactId || existingClient.hubspotContactId || '';
      } else {
        if (!practiceName) {
          return res.status(400).json({ error: 'Practice name is required for client accounts' });
        }
        newUser.practiceName = practiceName;
        newUser.isNewClient = isNewClient || false;
        newUser.slug = await generateClientUserSlug(practiceName);
        newUser.assignedProjects = assignedProjects || [];
        newUser.projectAccessLevels = projectAccessLevels || {};
        if (logo) newUser.logo = logo;
        if (hubspotCompanyId) newUser.hubspotCompanyId = hubspotCompanyId;
        if (hubspotDealId) newUser.hubspotDealId = hubspotDealId;
        if (hubspotContactId) newUser.hubspotContactId = hubspotContactId;
        // Record when HubSpot IDs are first linked — used to prevent retroactive ticket display
        if (hubspotCompanyId || hubspotDealId || hubspotContactId) {
          newUser.hubspotLinkedAt = new Date().toISOString();
        }
      }
    }

    // Vendor-specific fields
    if (role === config.ROLES.VENDOR) {
      newUser.assignedClients = assignedClients || [];
      // Vendors automatically get service portal access
      newUser.hasServicePortalAccess = true;
    }

    // Family / authorized contact: the client (user id) this account is linked
    // to — drives the ROI-family portal gate (resolveGfcClientRecord).
    if (role === config.ROLES.FAMILY && familyOfClientId !== undefined) {
      newUser.familyOfClientId = familyOfClientId || null;
    }

    // User/team member fields
    if (role === config.ROLES.USER) {
      newUser.assignedProjects = assignedProjects || [];
      newUser.projectAccessLevels = projectAccessLevels || {};
    }

    users.push(newUser);
    await db.set('users', users);
    invalidateUsersCache();

    // Send welcome email with login credentials (fire-and-forget, non-blocking)
    if (shouldSendWelcome !== false) {
      sendWelcomeEmail(newUser, password).catch(err =>
        console.error('Welcome email error (non-fatal):', err)
      );
    }

    res.json({
      id: newUser.id,
      email: newUser.email,
      name: newUser.name,
      role: newUser.role,
      isManager: newUser.isManager,
      hasServicePortalAccess: newUser.hasServicePortalAccess,
      hasAdminHubAccess: newUser.hasAdminHubAccess,
      hasImplementationsAccess: newUser.hasImplementationsAccess,
      hasClientPortalAdminAccess: newUser.hasClientPortalAdminAccess,
      practiceName: newUser.practiceName,
      isNewClient: newUser.isNewClient,
      slug: newUser.slug,
      assignedProjects: newUser.assignedProjects,
      projectAccessLevels: newUser.projectAccessLevels,
      assignedClients: newUser.assignedClients,
      logo: newUser.logo || '',
      createdAt: newUser.createdAt
    });
  } catch (error) {
    console.error('Admin create user error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get existing client portals (unique slugs) for adding users to existing portals
app.get('/api/client-portals', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== config.ROLES.ADMIN && !req.user.isManager) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    const users = await getUsers();
    const clientUsers = users.filter(u => u.role === config.ROLES.CLIENT && u.slug);
    // Group by slug to get unique portals with member count
    const portalMap = {};
    for (const u of clientUsers) {
      if (!portalMap[u.slug]) {
        portalMap[u.slug] = {
          slug: u.slug,
          practiceName: u.practiceName,
          logo: u.logo || '',
          hubspotCompanyId: u.hubspotCompanyId || '',
          memberCount: 0,
          members: []
        };
      }
      portalMap[u.slug].memberCount++;
      portalMap[u.slug].members.push({ id: u.id, name: u.name, email: u.email });
    }
    res.json(Object.values(portalMap));
  } catch (error) {
    console.error('Error fetching client portals:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ===== Public Config Endpoint =====
// Returns non-sensitive configuration values for frontend portals
// No authentication required - provides brand, phases, statuses, service types
app.get('/api/config', (req, res) => {
  res.json(config.getPublicConfig());
});

// One-time bootstrap: re-run the admin seed on demand without a server restart.
// Secured by a token that must match the JWT_SECRET env var so it can't be
// triggered by an anonymous caller. Remove this route after the GFC admin is
// confirmed working (it is intentionally not behind authenticateToken since
// the whole point is to recover from a locked-out state).
app.post('/api/bootstrap-admin', async (req, res) => {
  try {
    const { token } = req.body;
    if (!token || token !== process.env.JWT_SECRET) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    let users = await db.get('users') || [];
    let changed = false;

    if (!users.find(u => u.email === config.DEFAULT_ADMIN.EMAIL)) {
      const hashedPassword = await bcrypt.hash(config.DEFAULT_ADMIN.PASSWORD, config.BCRYPT_SALT_ROUNDS);
      users.push({
        id: uuidv4(),
        email: config.DEFAULT_ADMIN.EMAIL,
        name: config.DEFAULT_ADMIN.NAME,
        password: hashedPassword,
        role: config.ROLES.ADMIN,
        createdAt: new Date().toISOString()
      });
      changed = true;
    }

    const LEGACY_ADMIN_EMAIL = 'bianca@thrive365labs.live';
    const hasGfcAdmin = users.some(u => u.email === config.DEFAULT_ADMIN.EMAIL && u.role === config.ROLES.ADMIN);
    if (hasGfcAdmin && users.some(u => u.email === LEGACY_ADMIN_EMAIL)) {
      users = users.filter(u => u.email !== LEGACY_ADMIN_EMAIL);
      changed = true;
    }

    if (changed) {
      await db.set('users', users);
      invalidateUsersCache();
    }

    const admins = users.filter(u => u.role === config.ROLES.ADMIN).map(u => u.email);
    res.json({ ok: true, changed, admins });
  } catch (err) {
    console.error('Bootstrap error:', err);
    res.status(500).json({ error: 'Bootstrap failed' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Missing credentials' });
    }
    const users = await getUsers();
    const user = users.find(u => u.email?.toLowerCase() === email.toLowerCase());
    if (!user) {
      console.log('Login failed: User not found for email:', email);
      return res.status(400).json({ error: 'Invalid credentials' });
    }
    const passwordMatch = await bcrypt.compare(password, user.password);
    if (!passwordMatch) {
      console.log('Login failed: Password mismatch for:', email);
      return res.status(400).json({ error: 'Invalid credentials' });
    }
    // Block inactive accounts from logging in
    if (user.accountStatus === 'inactive') {
      return res.status(403).json({ error: 'Account is inactive. Please contact an administrator.' });
    }
    const token = jwt.sign(
      { id: user.id, email: user.email, name: user.name, role: user.role },
      JWT_SECRET,
      { expiresIn: config.JWT_EXPIRY }
    );
    const isManager = user.isManager || false;
    const userResponse = {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      // Manager flag - provides limited admin access
      isManager: isManager,
      // Include permission flags for all users
      hasServicePortalAccess: user.hasServicePortalAccess || false,
      hasAdminHubAccess: user.hasAdminHubAccess || false,
      hasImplementationsAccess: user.hasImplementationsAccess || false,
      // Managers automatically get client portal admin access
      hasClientPortalAdminAccess: user.hasClientPortalAdminAccess || isManager || false,
      assignedProjects: user.assignedProjects || [],
      assignedClients: user.assignedClients || [],
      // Password reset flag
      requirePasswordChange: user.requirePasswordChange || false
    };
    // Include client-specific fields
    if (user.role === config.ROLES.CLIENT) {
      userResponse.practiceName = user.practiceName;
      userResponse.isNewClient = user.isNewClient;
      // Auto-generate slug if client doesn't have one
      if (!user.slug) {
        const existingSlugs = users.filter(u => u.slug).map(u => u.slug);
        const generatedSlug = generateClientSlug(user.practiceName || user.name || user.email.split('@')[0], existingSlugs);
        // Update user in database with new slug
        const userIndex = users.findIndex(u => u.id === user.id);
        if (userIndex !== -1) {
          users[userIndex].slug = generatedSlug;
          await db.set('users', users);
    invalidateUsersCache();
        }
        userResponse.slug = generatedSlug;
      } else {
        userResponse.slug = user.slug;
      }
    }
    // Include project access levels for team members
    if (user.role === config.ROLES.USER) {
      userResponse.projectAccessLevels = user.projectAccessLevels || {};
    }
    res.json({ token, user: userResponse });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Client portal login endpoint (supports admin, manager, and client access)
app.post('/api/auth/client-login', async (req, res) => {
  try {
    const { email, password, slug } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Missing credentials' });
    }
    const users = await getUsers();
    // Allow clients, admins (super admin), and managers to log into the portal
    const user = users.find(u => u.email?.toLowerCase() === email.toLowerCase() && (u.role === config.ROLES.CLIENT || u.role === config.ROLES.ADMIN || u.isManager));
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(400).json({ error: 'Invalid credentials' });
    }
    // Block inactive accounts from logging in
    if (user.accountStatus === 'inactive') {
      return res.status(403).json({ error: 'Account is inactive. Please contact an administrator.' });
    }
    // For clients, optionally verify slug matches if provided
    if (user.role === config.ROLES.CLIENT && slug && user.slug !== slug) {
      return res.status(400).json({ error: 'Invalid portal access' });
    }
    const token = jwt.sign(
      { id: user.id, email: user.email, name: user.name, role: user.role },
      JWT_SECRET,
      { expiresIn: config.JWT_EXPIRY }
    );
    const isManager = user.isManager || false;
    // Admin and Manager get 'admin' slug for portal admin access
    const effectiveSlug = (user.role === config.ROLES.ADMIN || isManager) ? 'admin' : user.slug;
    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        isManager: isManager,
        hasClientPortalAdminAccess: user.hasClientPortalAdminAccess || isManager || user.role === config.ROLES.ADMIN,
        practiceName: user.practiceName,
        isNewClient: user.isNewClient,
        slug: effectiveSlug,
        logo: user.logo || '',
        assignedProjects: user.assignedProjects || []
      }
    });
  } catch (error) {
    console.error('Client login error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============== PASSWORD RESET REQUESTS (Admin-managed) ==============
app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }
    const users = await getUsers();
    const user = users.find(u => u.email?.toLowerCase() === email.toLowerCase());
    if (!user) {
      return res.json({ message: 'Your request has been submitted. An administrator will reach out to you shortly to help reset your password.' });
    }

    // Store password reset request for admin to handle
    const resetRequests = await db.get('password_reset_requests') || [];

    // Check if there's already a pending request for this user
    const existingIdx = resetRequests.findIndex(r => r.email?.toLowerCase() === email.toLowerCase() && r.status === 'pending');
    if (existingIdx !== -1) {
      return res.json({ message: 'Your request has been submitted. An administrator will reach out to you shortly to help reset your password.' });
    }
    
    resetRequests.push({
      id: uuidv4(),
      userId: user.id,
      email: user.email,
      name: user.name,
      requestedAt: new Date().toISOString(),
      status: 'pending'
    });
    await db.set('password_reset_requests', resetRequests);
    
    console.log(`Password reset requested for ${email} - Admin action required`);
    res.json({ message: 'Your request has been submitted. An administrator will reach out to you shortly to help reset your password.' });
  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Public endpoint: look up a password reset link token (no auth required)
app.get('/api/auth/password-reset-link/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const links = (await db.get('password_reset_links')) || [];
    const link = links.find(l => l.token === token);
    if (!link) return res.status(404).json({ error: 'Invalid or expired reset link.' });
    if (new Date(link.expiresAt) < new Date()) return res.status(410).json({ error: 'This reset link has expired. Please contact your administrator.' });
    const users = await getUsers();
    const user = users.find(u => u.id === link.userId);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    res.json({ name: user.name, email: user.email, tempPassword: link.tempPassword });
  } catch (error) {
    console.error('Password reset link lookup error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============== EMAIL UNSUBSCRIBE / RESUBSCRIBE (public, token-based) ==============

function renderUnsubscribePageHtml(message, isSuccess) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Email Preferences - Thrive 365 Labs</title>
  <style>
    body { font-family: Inter, -apple-system, sans-serif; background: #f8fafc; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .card { background: #fff; border-radius: 10px; border: 1px solid #e5e7eb; padding: 40px 32px; max-width: 460px; width: 100%; text-align: center; box-shadow: 0 2px 8px rgba(0,0,0,0.06); }
    .logo { height: 40px; margin-bottom: 24px; }
    .icon { font-size: 40px; margin-bottom: 12px; }
    h2 { color: #00205A; margin: 0 0 12px; font-size: 20px; }
    p { color: #6b7280; line-height: 1.6; margin: 0 0 20px; }
    a.btn { display: inline-block; background: #045E9F; color: #fff; padding: 10px 24px; border-radius: 6px; text-decoration: none; font-weight: 500; font-size: 14px; }
    a.link { color: #045E9F; text-decoration: underline; font-size: 13px; }
  </style>
</head>
<body>
  <div class="card">
    <img class="logo" src="/thrive365-logo.webp" alt="Thrive 365 Labs" />
    <div class="icon">${isSuccess ? '✅' : '❌'}</div>
    <h2>Email Preferences</h2>
    <p>${message}</p>
    <a class="btn" href="/">Return to App</a>
  </div>
</body>
</html>`;
}

// Unsubscribe from automated emails (clicked from email link — no login required)
app.get('/api/unsubscribe', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).send(renderUnsubscribePageHtml('Invalid unsubscribe link. No token provided.', false));
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.purpose !== 'email_unsubscribe') throw new Error('Invalid token purpose');

    const users = await getUsers();
    const idx = users.findIndex(u => u.id === decoded.userId);
    if (idx === -1) return res.status(404).send(renderUnsubscribePageHtml('User not found.', false));

    users[idx].emailUnsubscribed = true;
    await db.set('users', users);

    // Generate a resubscribe token (same token works for both directions)
    const resubToken = jwt.sign({ userId: decoded.userId, purpose: 'email_unsubscribe' }, JWT_SECRET, { expiresIn: '365d' });
    const resubUrl = `/api/resubscribe?token=${encodeURIComponent(resubToken)}`;

    res.send(renderUnsubscribePageHtml(
      `You have been unsubscribed from automated emails. You will no longer receive task reminders, milestone updates, or other automated notifications.<br/><br/><a class="link" href="${resubUrl}">Changed your mind? Resubscribe</a>`,
      true
    ));
  } catch (err) {
    res.status(400).send(renderUnsubscribePageHtml('This unsubscribe link is invalid or has expired. Please contact your administrator if you need to update your email preferences.', false));
  }
});

// Resubscribe to automated emails
app.get('/api/resubscribe', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).send(renderUnsubscribePageHtml('Invalid resubscribe link. No token provided.', false));
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.purpose !== 'email_unsubscribe') throw new Error('Invalid token purpose');

    const users = await getUsers();
    const idx = users.findIndex(u => u.id === decoded.userId);
    if (idx === -1) return res.status(404).send(renderUnsubscribePageHtml('User not found.', false));

    users[idx].emailUnsubscribed = false;
    await db.set('users', users);

    res.send(renderUnsubscribePageHtml(
      'You have been resubscribed to automated emails. You will now receive task reminders, milestone updates, and other automated notifications.',
      true
    ));
  } catch (err) {
    res.status(400).send(renderUnsubscribePageHtml('This resubscribe link is invalid or has expired. Please contact your administrator if you need to update your email preferences.', false));
  }
});

// Get pending password reset requests (Admin only)
app.get('/api/admin/password-reset-requests', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const resetRequests = await db.get('password_reset_requests') || [];
    res.json(resetRequests.filter(r => r.status === 'pending'));
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Mark password reset request as handled (Admin only)
app.put('/api/admin/password-reset-requests/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const resetRequests = await db.get('password_reset_requests') || [];
    const idx = resetRequests.findIndex(r => r.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Request not found' });
    
    resetRequests[idx].status = status || 'completed';
    resetRequests[idx].handledAt = new Date().toISOString();
    resetRequests[idx].handledBy = req.user.email;
    await db.set('password_reset_requests', resetRequests);
    
    res.json({ message: 'Request updated' });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete/dismiss password reset request (Admin only)
app.delete('/api/admin/password-reset-requests/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const resetRequests = await db.get('password_reset_requests') || [];
    const filteredRequests = resetRequests.filter(r => r.id !== id);

    if (filteredRequests.length === resetRequests.length) {
      return res.status(404).json({ error: 'Request not found' });
    }

    await db.set('password_reset_requests', filteredRequests);
    res.json({ message: 'Request dismissed' });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Submit feedback/bug report (authenticated users)
app.post('/api/feedback', authenticateToken, async (req, res) => {
  try {
    const { type, subject, description, userEmail, userName } = req.body;
    const feedbackRequests = (await db.get('feedback_requests')) || [];

    const newFeedback = {
      id: Date.now().toString(),
      type,
      subject,
      description,
      userEmail: userEmail || req.user.email,
      userName: userName || req.user.name,
      status: 'open',
      createdAt: new Date().toISOString()
    };

    feedbackRequests.unshift(newFeedback);
    await db.set('feedback_requests', feedbackRequests);

    res.json({ message: 'Feedback submitted successfully', id: newFeedback.id });
  } catch (error) {
    console.error('Feedback submission error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get all feedback (Admin only)
app.get('/api/admin/feedback', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const feedbackRequests = (await db.get('feedback_requests')) || [];
    res.json(feedbackRequests);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Update feedback status (Admin only)
app.put('/api/admin/feedback/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, adminNote } = req.body;
    const feedbackRequests = (await db.get('feedback_requests')) || [];
    const idx = feedbackRequests.findIndex(f => f.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Feedback not found' });

    feedbackRequests[idx].status = status || feedbackRequests[idx].status;
    if (adminNote) feedbackRequests[idx].adminNote = adminNote;
    feedbackRequests[idx].updatedAt = new Date().toISOString();
    feedbackRequests[idx].updatedBy = req.user.email;
    await db.set('feedback_requests', feedbackRequests);

    res.json({ message: 'Feedback updated' });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Get activity log (Admin only)
app.get('/api/admin/activity-log', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { limit = 100, projectId } = req.query;
    let activities = (await db.get('activity_log')) || [];
    
    // Filter by project if specified
    if (projectId) {
      activities = activities.filter(a => a.projectId === projectId);
    }
    
    // Limit results
    activities = activities.slice(0, parseInt(limit));
    
    res.json(activities);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ============== USER MANAGEMENT (Super Admin, Manager, and Client Portal Admin) ==============
app.get('/api/users', authenticateToken, async (req, res) => {
  // Allow super admins, managers, and client portal admins to view users
  if (req.user.role !== config.ROLES.ADMIN && !req.user.isManager && !req.user.hasClientPortalAdminAccess) {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    const users = await getUsers();
    const safeUsers = users.map(u => ({
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      accountStatus: u.accountStatus || 'active',
      emailUnsubscribed: u.emailUnsubscribed || false,
      createdAt: u.createdAt,
      // Manager flag
      isManager: u.isManager || false,
      // Permission flags
      hasServicePortalAccess: u.hasServicePortalAccess || false,
      hasAdminHubAccess: u.hasAdminHubAccess || false,
      hasImplementationsAccess: u.hasImplementationsAccess || false,
      hasClientPortalAdminAccess: u.hasClientPortalAdminAccess || false,
      // Team member fields
      assignedProjects: u.assignedProjects || [],
      projectAccessLevels: u.projectAccessLevels || {},
      // Vendor-specific fields
      assignedClients: u.assignedClients || [],
      // Client-specific fields
      practiceName: u.practiceName || null,
      isNewClient: u.isNewClient || false,
      slug: u.slug || null,
      logo: u.logo || '',
      // HubSpot record IDs for client-level uploads
      hubspotCompanyId: u.hubspotCompanyId || '',
      hubspotDealId: u.hubspotDealId || '',
      hubspotContactId: u.hubspotContactId || ''
    }));
    res.json(safeUsers);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/users/:userId', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const {
      name, email, role, password, assignedProjects, projectAccessLevels,
      practiceName, isNewClient, logo, hubspotCompanyId, hubspotDealId, hubspotContactId,
      hasServicePortalAccess, hasAdminHubAccess, hasImplementationsAccess, hasClientPortalAdminAccess,
      isManager, assignedClients, phone, accountStatus, emailUnsubscribed,
      licenseLevel, hasClinicalAccess, enrollmentStatus, careTeam, familyOfClientId
    } = req.body;
    const users = await getUsers();
    const idx = users.findIndex(u => u.id === userId);
    if (idx === -1) return res.status(404).json({ error: 'User not found' });

    if (phone !== undefined) users[idx].phone = phone;
    if (emailUnsubscribed !== undefined) users[idx].emailUnsubscribed = emailUnsubscribed;
    if (accountStatus !== undefined) {
      // Prevent deactivating admin accounts (super admin lockout protection)
      if (accountStatus === 'inactive' && users[idx].role === 'admin') {
        return res.status(403).json({ error: 'Admin accounts cannot be deactivated. Remove admin role first if you need to deactivate this account.' });
      }
      users[idx].accountStatus = accountStatus;
    }

    // Capture old values before update for cascade propagation
    const oldName = users[idx].name;
    const oldPracticeName = users[idx].practiceName;

    if (name) users[idx].name = name;
    if (email) users[idx].email = email;
    if (role) users[idx].role = role;
    let passwordWasReset = false;
    if (password) {
      users[idx].password = await bcrypt.hash(password, config.BCRYPT_SALT_ROUNDS);
      users[idx].requirePasswordChange = true;
      users[idx].lastPasswordReset = new Date().toISOString();
      passwordWasReset = true;
    }
    if (assignedProjects !== undefined) users[idx].assignedProjects = assignedProjects;
    if (projectAccessLevels !== undefined) users[idx].projectAccessLevels = projectAccessLevels;

    // Manager flag - provides limited admin access
    if (isManager !== undefined) users[idx].isManager = isManager;

    // Permission flags
    if (hasServicePortalAccess !== undefined) users[idx].hasServicePortalAccess = hasServicePortalAccess;
    if (hasAdminHubAccess !== undefined) users[idx].hasAdminHubAccess = hasAdminHubAccess;
    if (hasImplementationsAccess !== undefined) users[idx].hasImplementationsAccess = hasImplementationsAccess;
    if (hasClientPortalAdminAccess !== undefined) users[idx].hasClientPortalAdminAccess = hasClientPortalAdminAccess;

    // GFC extended fields
    if (licenseLevel !== undefined) users[idx].licenseLevel = licenseLevel;
    if (hasClinicalAccess !== undefined) users[idx].hasClinicalAccess = hasClinicalAccess;
    if (enrollmentStatus !== undefined) users[idx].enrollmentStatus = enrollmentStatus;
    if (careTeam !== undefined) users[idx].careTeam = careTeam;
    // Family / authorized contact → linked client (user id); drives the
    // ROI-family portal gate (resolveGfcClientRecord).
    if (familyOfClientId !== undefined) users[idx].familyOfClientId = familyOfClientId || null;

    // Account active status (no separate isActive - handled by accountStatus above)

    // Vendor-specific: assigned clients
    if (assignedClients !== undefined) users[idx].assignedClients = assignedClients;

    // Client-specific fields
    if (practiceName !== undefined) {
      users[idx].practiceName = practiceName;
      // Regenerate slug if practice name changes and user is a client
      if (users[idx].role === config.ROLES.CLIENT && practiceName) {
        const oldSlug = users[idx].slug;
        const existingSlugs = users.filter((u, i) => i !== idx && u.slug).map(u => u.slug);
        const newSlug = generateClientSlug(practiceName, existingSlugs);
        if (oldSlug && oldSlug !== newSlug) {
          // Preserve old slug for redirect lookups so existing portal URLs keep working
          if (!users[idx].previousSlugs) users[idx].previousSlugs = [];
          if (!users[idx].previousSlugs.includes(oldSlug)) {
            users[idx].previousSlugs.push(oldSlug);
          }
        }
        users[idx].slug = newSlug;
      }
    }
    if (isNewClient !== undefined) users[idx].isNewClient = isNewClient;
    if (logo !== undefined) users[idx].logo = logo;

    // HubSpot record IDs for client-level uploads
    const hadHubSpotIdsAdmin = users[idx].hubspotCompanyId || users[idx].hubspotDealId || users[idx].hubspotContactId;
    if (hubspotCompanyId !== undefined) users[idx].hubspotCompanyId = hubspotCompanyId;
    if (hubspotDealId !== undefined) users[idx].hubspotDealId = hubspotDealId;
    if (hubspotContactId !== undefined) users[idx].hubspotContactId = hubspotContactId;
    // Record when HubSpot IDs are linked for the first time (prevents retroactive ticket display)
    if (!hadHubSpotIdsAdmin && (users[idx].hubspotCompanyId || users[idx].hubspotDealId || users[idx].hubspotContactId)) {
      users[idx].hubspotLinkedAt = new Date().toISOString();
    }

    await db.set('users', users);
    invalidateUsersCache();

    // If password was reset by admin, email the user a secure reset link
    if (passwordWasReset) {
      (async () => {
        try {
          const token = await createPasswordResetLink(users[idx], password);
          await sendPasswordResetEmail(users[idx], token);
        } catch (err) {
          console.error('Password reset email error (user edit):', err);
        }
      })();
    }

    // Cascade name changes to all related data stores (non-blocking)
    const newName = users[idx].name;
    const newPracticeName = users[idx].practiceName;
    if ((oldName && newName && oldName !== newName) || (oldPracticeName && newPracticeName && oldPracticeName !== newPracticeName)) {
      cascadeUserNameUpdate(userId, oldName, newName, oldPracticeName, newPracticeName).catch(err => {
        console.error('Cascade update error (non-blocking):', err.message);
      });
    }

    // Cascade slug changes (migrate per-slug keys, update references)
    const currentSlug = users[idx].slug;
    const oldSlugForCascade = users[idx].previousSlugs && users[idx].previousSlugs.length > 0
      ? users[idx].previousSlugs[users[idx].previousSlugs.length - 1] : null;
    if (oldSlugForCascade && currentSlug && oldSlugForCascade !== currentSlug) {
      cascadeSlugChange(userId, oldSlugForCascade, currentSlug).catch(err => {
        console.error('Cascade slug change error (non-blocking):', err.message);
      });
    }

    res.json({
      id: users[idx].id,
      email: users[idx].email,
      name: users[idx].name,
      role: users[idx].role,
      accountStatus: users[idx].accountStatus || 'active',
      isManager: users[idx].isManager || false,
      hasServicePortalAccess: users[idx].hasServicePortalAccess || false,
      hasAdminHubAccess: users[idx].hasAdminHubAccess || false,
      hasImplementationsAccess: users[idx].hasImplementationsAccess || false,
      hasClientPortalAdminAccess: users[idx].hasClientPortalAdminAccess || false,
      assignedProjects: users[idx].assignedProjects || [],
      projectAccessLevels: users[idx].projectAccessLevels || {},
      assignedClients: users[idx].assignedClients || [],
      practiceName: users[idx].practiceName || null,
      isNewClient: users[idx].isNewClient || false,
      slug: users[idx].slug || null,
      logo: users[idx].logo || '',
      hubspotCompanyId: users[idx].hubspotCompanyId || '',
      hubspotDealId: users[idx].hubspotDealId || '',
      hubspotContactId: users[idx].hubspotContactId || ''
    });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/users/:userId', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const users = await getUsers();
    if (userId === req.user.id) {
      return res.status(400).json({ error: 'Cannot delete your own account' });
    }
    const filtered = users.filter(u => u.id !== userId);
    await db.set('users', filtered);
    invalidateUsersCache();
    res.json({ message: 'User deleted' });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ============== CLIENT DETAILS (Manager-restricted) ==============
// This endpoint allows Managers and Client Portal Admins to update ONLY client details
// without access to sensitive fields like role, permissions, or passwords.
// Changes sync with the main user record visible in Admin Hub User Management.
app.put('/api/client-portal/clients/:clientId', authenticateToken, requireClientPortalAdmin, async (req, res) => {
  try {
    const { clientId } = req.params;
    const { practiceName, logo, hubspotCompanyId, hubspotDealId, hubspotContactId, accountStatus } = req.body;

    const users = await getUsers();
    const idx = users.findIndex(u => u.id === clientId);

    if (idx === -1) {
      return res.status(404).json({ error: 'Client not found' });
    }

    // Only allow editing client users
    if (users[idx].role !== config.ROLES.CLIENT) {
      return res.status(403).json({ error: 'Can only edit client users through this endpoint' });
    }

    // Capture old values for cascade update
    const oldName = users[idx].name;
    const oldPracticeName = users[idx].practiceName;

    // Update only allowed client details fields
    if (practiceName !== undefined) {
      users[idx].practiceName = practiceName;
      // Regenerate slug if practice name changes
      if (practiceName) {
        const oldSlug = users[idx].slug;
        const existingSlugs = users.filter((u, i) => i !== idx && u.slug).map(u => u.slug);
        const newSlug = generateClientSlug(practiceName, existingSlugs);
        if (oldSlug && oldSlug !== newSlug) {
          if (!users[idx].previousSlugs) users[idx].previousSlugs = [];
          if (!users[idx].previousSlugs.includes(oldSlug)) {
            users[idx].previousSlugs.push(oldSlug);
          }
        }
        users[idx].slug = newSlug;
      }
    }
    if (logo !== undefined) users[idx].logo = logo;
    const hadHubSpotIdsPortal = users[idx].hubspotCompanyId || users[idx].hubspotDealId || users[idx].hubspotContactId;
    if (hubspotCompanyId !== undefined) users[idx].hubspotCompanyId = hubspotCompanyId;
    if (hubspotDealId !== undefined) users[idx].hubspotDealId = hubspotDealId;
    if (hubspotContactId !== undefined) users[idx].hubspotContactId = hubspotContactId;
    // Record when HubSpot IDs are linked for the first time (prevents retroactive ticket display)
    if (!hadHubSpotIdsPortal && (users[idx].hubspotCompanyId || users[idx].hubspotDealId || users[idx].hubspotContactId)) {
      users[idx].hubspotLinkedAt = new Date().toISOString();
    }
    if (accountStatus !== undefined) users[idx].accountStatus = accountStatus;

    // Track modification
    users[idx].updatedAt = new Date().toISOString();
    users[idx].updatedBy = req.user.id;

    await db.set('users', users);
    invalidateUsersCache();

    // Cascade name changes to all related data stores (non-blocking)
    const newPracticeName = users[idx].practiceName;
    if (oldPracticeName && newPracticeName && oldPracticeName !== newPracticeName) {
      cascadeUserNameUpdate(clientId, oldName, oldName, oldPracticeName, newPracticeName).catch(err => {
        console.error('Cascade update error (non-blocking):', err.message);
      });
    }

    // Cascade slug changes (migrate per-slug keys, update references)
    const currentSlug = users[idx].slug;
    const oldSlugForCascade = users[idx].previousSlugs && users[idx].previousSlugs.length > 0
      ? users[idx].previousSlugs[users[idx].previousSlugs.length - 1] : null;
    if (oldSlugForCascade && currentSlug && oldSlugForCascade !== currentSlug) {
      cascadeSlugChange(clientId, oldSlugForCascade, currentSlug).catch(err => {
        console.error('Cascade slug change error (non-blocking):', err.message);
      });
    }

    // Log the activity
    await logActivity(
      req.user.id,
      req.user.name,
      'update_client_details',
      'user',
      clientId,
      `Updated client details for ${users[idx].name} (${users[idx].practiceName || 'No practice name'})`
    );

    res.json({
      id: users[idx].id,
      name: users[idx].name,
      email: users[idx].email,
      practiceName: users[idx].practiceName || null,
      slug: users[idx].slug || null,
      logo: users[idx].logo || '',
      hubspotCompanyId: users[idx].hubspotCompanyId || '',
      hubspotDealId: users[idx].hubspotDealId || '',
      hubspotContactId: users[idx].hubspotContactId || '',
      updatedAt: users[idx].updatedAt
    });
  } catch (error) {
    console.error('Error updating client details:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============== TEAM MEMBERS (for owner selection) ==============
app.get('/api/team-members', authenticateToken, async (req, res) => {
  try {
    const { projectId } = req.query;
    const users = await getUsers();

    // Include admins, team members, and client users (clients can be assigned to tasks)
    let filteredUsers = users.filter(u =>
      u.role === config.ROLES.ADMIN ||
      u.role === config.ROLES.USER ||
      u.role === config.ROLES.CLIENT
    );
    if (projectId) {
      // Filter to users assigned to that project (admins always included)
      filteredUsers = filteredUsers.filter(u =>
        u.role === config.ROLES.ADMIN ||
        (u.assignedProjects && u.assignedProjects.includes(projectId))
      );

      // Retroactive support: also include any client users who are already
      // assigned as task owners in this project, even if not in assignedProjects
      const tasks = await getRawTasks(projectId);
      const ownerEmails = new Set();
      tasks.forEach(t => {
        if (t.owner) ownerEmails.add(t.owner);
        if (t.secondaryOwner) ownerEmails.add(t.secondaryOwner);
        (t.subtasks || []).forEach(st => { if (st.owner) ownerEmails.add(st.owner); });
      });
      const alreadyIncluded = new Set(filteredUsers.map(u => u.email));
      const retroClients = users.filter(u =>
        u.role === config.ROLES.CLIENT &&
        ownerEmails.has(u.email) &&
        !alreadyIncluded.has(u.email)
      );
      filteredUsers = [...filteredUsers, ...retroClients];
    }

    const teamMembers = filteredUsers.map(u => ({
      email: u.email,
      name: u.name,
      role: u.role
    }));
    res.json(teamMembers);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ============== SUBTASKS ==============
app.post('/api/projects/:projectId/tasks/:taskId/subtasks', authenticateToken, async (req, res) => {
  try {
    const { projectId, taskId } = req.params;
    
    // Check project access
    if (!canAccessProject(req.user, projectId)) {
      return res.status(403).json({ error: 'Access denied to this project' });
    }
    
    const { title, owner, dueDate, showToClient } = req.body;
    if (!title) return res.status(400).json({ error: 'Subtask title is required' });
    
    // Use raw tasks for mutation to prevent normalization drift
    const tasks = await getRawTasks(projectId);
    const idx = tasks.findIndex(t => t.id === parseInt(taskId) || String(t.id) === String(taskId));
    if (idx === -1) return res.status(404).json({ error: 'Task not found' });
    
    // Inherit showToClient from parent task if not explicitly provided
    const parentShowToClient = tasks[idx].showToClient || false;
    const subtask = {
      id: uuidv4(),
      title,
      owner: owner || '',
      dueDate: dueDate || '',
      showToClient: showToClient !== undefined ? showToClient : parentShowToClient,
      completed: false,
      createdAt: new Date().toISOString(),
      createdBy: req.user.id
    };
    
    if (!tasks[idx].subtasks) tasks[idx].subtasks = [];
    tasks[idx].subtasks.push(subtask);
    await db.set(`tasks_${projectId}`, tasks);

    if (subtask.owner) {
      const project = (await getProjects()).find(p => String(p.id) === String(projectId));
      if (project) {
        sendAssignmentNotification(subtask.owner, tasks[idx], subtask, project, req.user.id);
      }
    }
    
    res.json(subtask);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/projects/:projectId/tasks/:taskId/subtasks/:subtaskId', authenticateToken, async (req, res) => {
  try {
    const { projectId, taskId, subtaskId } = req.params;
    
    // Check project access
    if (!canAccessProject(req.user, projectId)) {
      return res.status(403).json({ error: 'Access denied to this project' });
    }
    
    const { title, owner, dueDate, completed, notApplicable, showToClient } = req.body;
    
    // Use raw tasks for mutation to prevent normalization drift
    const tasks = await getRawTasks(projectId);
    const taskIdx = tasks.findIndex(t => t.id === parseInt(taskId) || String(t.id) === String(taskId));
    if (taskIdx === -1) return res.status(404).json({ error: 'Task not found' });
    
    if (!tasks[taskIdx].subtasks) return res.status(404).json({ error: 'Subtask not found' });
    // Support both numeric and string subtask IDs for backward compatibility
    const subtaskIdx = tasks[taskIdx].subtasks.findIndex(s => String(s.id) === String(subtaskId));
    if (subtaskIdx === -1) return res.status(404).json({ error: 'Subtask not found' });
    
    const previousSubtaskOwner = tasks[taskIdx].subtasks[subtaskIdx].owner;
    if (title !== undefined) tasks[taskIdx].subtasks[subtaskIdx].title = title;
    if (owner !== undefined) tasks[taskIdx].subtasks[subtaskIdx].owner = owner;
    if (dueDate !== undefined) tasks[taskIdx].subtasks[subtaskIdx].dueDate = dueDate;
    if (completed !== undefined) tasks[taskIdx].subtasks[subtaskIdx].completed = completed;
    if (notApplicable !== undefined) tasks[taskIdx].subtasks[subtaskIdx].notApplicable = notApplicable;
    if (showToClient !== undefined) tasks[taskIdx].subtasks[subtaskIdx].showToClient = showToClient;
    
    // Also update status field for consistency
    if (completed !== undefined || notApplicable !== undefined) {
      if (notApplicable) {
        tasks[taskIdx].subtasks[subtaskIdx].status = 'N/A';
      } else if (completed) {
        tasks[taskIdx].subtasks[subtaskIdx].status = 'Complete';
        tasks[taskIdx].subtasks[subtaskIdx].completedAt = new Date().toISOString();
      } else {
        tasks[taskIdx].subtasks[subtaskIdx].status = 'Pending';
        tasks[taskIdx].subtasks[subtaskIdx].completedAt = null;
      }
    }
    
    await db.set(`tasks_${projectId}`, tasks);

    if (owner !== undefined && owner !== previousSubtaskOwner && owner) {
      const project = (await getProjects()).find(p => String(p.id) === String(projectId));
      if (project) {
        sendAssignmentNotification(owner, tasks[taskIdx], tasks[taskIdx].subtasks[subtaskIdx], project, req.user.id);
      }
    }

    res.json(tasks[taskIdx].subtasks[subtaskIdx]);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/projects/:projectId/tasks/:taskId/subtasks/:subtaskId', authenticateToken, async (req, res) => {
  try {
    const { projectId, taskId, subtaskId } = req.params;
    
    // Check project access
    if (!canAccessProject(req.user, projectId)) {
      return res.status(403).json({ error: 'Access denied to this project' });
    }
    
    // Use raw tasks for mutation to prevent normalization drift
    const tasks = await getRawTasks(projectId);
    const taskIdx = tasks.findIndex(t => t.id === parseInt(taskId) || String(t.id) === String(taskId));
    if (taskIdx === -1) return res.status(404).json({ error: 'Task not found' });
    
    if (!tasks[taskIdx].subtasks) return res.status(404).json({ error: 'Subtask not found' });
    // Support both numeric and string subtask IDs for backward compatibility
    tasks[taskIdx].subtasks = tasks[taskIdx].subtasks.filter(s => String(s.id) !== String(subtaskId));
    
    await db.set(`tasks_${projectId}`, tasks);
    res.json({ message: 'Subtask deleted' });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ============== BULK TASK UPDATES ==============
app.put('/api/projects/:projectId/tasks/bulk-update', authenticateToken, async (req, res) => {
  try {
    const { projectId } = req.params;

    // Check project write access
    if (!canWriteProject(req.user, projectId)) {
      return res.status(403).json({ error: 'Write access required for this project' });
    }
    
    const { taskIds, completed } = req.body;
    
    if (!taskIds || !Array.isArray(taskIds)) {
      return res.status(400).json({ error: 'taskIds array is required' });
    }
    if (typeof completed !== 'boolean') {
      return res.status(400).json({ error: 'completed boolean is required' });
    }
    
    // Use raw tasks for mutation to prevent normalization drift
    const tasks = await getRawTasks(projectId);
    const updatedTasks = [];
    
    const skippedTasks = [];
    for (const taskId of taskIds) {
      const idx = tasks.findIndex(t => t.id === parseInt(taskId) || String(t.id) === String(taskId));
      if (idx !== -1) {
        // Check subtask completion before marking complete (same rule as single-task update)
        if (completed && !tasks[idx].completed) {
          const subtasks = tasks[idx].subtasks || [];
          const incompleteSubtasks = subtasks.filter(s => {
            const isComplete = s.completed || s.status === 'Complete' || s.status === 'completed';
            const isNA = s.notApplicable || s.status === 'N/A' || s.status === 'not_applicable';
            return !isComplete && !isNA;
          });
          if (incompleteSubtasks.length > 0) {
            skippedTasks.push({ id: taskId, title: tasks[idx].taskTitle, reason: 'has incomplete subtasks' });
            continue;
          }
        }
        tasks[idx].completed = completed;
        if (completed) {
          tasks[idx].dateCompleted = new Date().toISOString();
        } else {
          tasks[idx].dateCompleted = null;
        }
        updatedTasks.push(tasks[idx]);
      }
    }
    
    await db.set(`tasks_${projectId}`, tasks);

    // Fire-and-forget HubSpot sync for each newly completed task (mirrors single-task endpoint)
    if (completed) {
      for (const task of updatedTasks) {
        createHubSpotTask(projectId, task, req.user.name);
        checkPhaseCompletion(projectId, tasks, task);
      }
    }

    const response = { message: `${updatedTasks.length} tasks updated`, updatedTasks };
    if (skippedTasks.length > 0) {
      response.skipped = skippedTasks;
      response.message += `, ${skippedTasks.length} skipped (incomplete subtasks)`;
    }
    res.json(response);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ============== BULK TASK EDIT (fields) ==============
app.put('/api/projects/:projectId/tasks/bulk-edit', authenticateToken, async (req, res) => {
  try {
    const { projectId } = req.params;

    if (!canWriteProject(req.user, projectId)) {
      return res.status(403).json({ error: 'Write access required for this project' });
    }

    const { taskIds, updates } = req.body;

    if (!taskIds || !Array.isArray(taskIds) || taskIds.length === 0) {
      return res.status(400).json({ error: 'taskIds array is required' });
    }
    if (!updates || typeof updates !== 'object') {
      return res.status(400).json({ error: 'updates object is required' });
    }

    const allowedFields = ['owner', 'secondaryOwner', 'dueDate', 'phase', 'showToClient', 'tags'];
    const fieldsToUpdate = {};
    for (const field of allowedFields) {
      if (updates[field] !== undefined) {
        fieldsToUpdate[field] = updates[field];
      }
    }

    if (Object.keys(fieldsToUpdate).length === 0) {
      return res.status(400).json({ error: 'No valid fields provided in updates' });
    }

    const tasks = await getRawTasks(projectId);
    let updatedCount = 0;

    for (const taskId of taskIds) {
      const idx = tasks.findIndex(t => t.id === parseInt(taskId) || String(t.id) === String(taskId));
      if (idx !== -1) {
        for (const [field, value] of Object.entries(fieldsToUpdate)) {
          tasks[idx][field] = value;
        }
        updatedCount++;
      }
    }

    await db.set(`tasks_${projectId}`, tasks);

    res.json({ message: `${updatedCount} tasks updated`, updatedCount });
  } catch (error) {
    console.error('Bulk edit error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============== BULK TASK DELETE ==============
app.post('/api/projects/:projectId/tasks/bulk-delete', authenticateToken, async (req, res) => {
  try {
    const { projectId } = req.params;

    // Check project write access
    if (!canWriteProject(req.user, projectId)) {
      return res.status(403).json({ error: 'Write access required for this project' });
    }
    
    const { taskIds } = req.body;
    
    if (!taskIds || !Array.isArray(taskIds)) {
      return res.status(400).json({ error: 'taskIds array is required' });
    }
    
    // Use raw tasks for mutation to prevent normalization drift
    const tasks = await getRawTasks(projectId);
    const taskIdsSet = new Set(taskIds.map(id => String(id)));
    
    // Check permissions - partial success: delete what user has access to, skip the rest
    const isAdmin = req.user.role === config.ROLES.ADMIN;

    const tasksToDelete = tasks.filter(t => taskIdsSet.has(String(t.id)));
    const deletableIds = new Set();
    const skippedTasks = [];

    for (const task of tasksToDelete) {
      if (!isAdmin && task.createdBy && task.createdBy !== req.user.id) {
        skippedTasks.push({ id: task.id, title: task.taskTitle, reason: 'created by another user' });
      } else {
        deletableIds.add(String(task.id));
      }
    }

    // Clean up dependency references pointing to deleted tasks
    const remainingTasks = tasks.filter(t => !deletableIds.has(String(t.id)));
    for (const t of remainingTasks) {
      if (Array.isArray(t.dependencies)) {
        t.dependencies = t.dependencies.filter(depId => !deletableIds.has(String(depId)));
      }
    }

    await db.set(`tasks_${projectId}`, remainingTasks);
    const response = { message: `${deletableIds.size} tasks deleted` };
    if (skippedTasks.length > 0) {
      response.skipped = skippedTasks;
      response.message += `, ${skippedTasks.length} skipped (no permission)`;
    }
    res.json(response);
  } catch (error) {
    console.error('Bulk delete error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============== TASK NOTES ==============
app.post('/api/projects/:projectId/tasks/:taskId/notes', authenticateToken, async (req, res) => {
  try {
    const { projectId, taskId } = req.params;
    
    // Check project access
    if (!canAccessProject(req.user, projectId)) {
      return res.status(403).json({ error: 'Access denied to this project' });
    }
    
    const { content } = req.body;
    if (!content) return res.status(400).json({ error: 'Note content is required' });
    
    // Use raw tasks for mutation to prevent normalization drift
    const tasks = await getRawTasks(projectId);
    const idx = tasks.findIndex(t => t.id === parseInt(taskId) || String(t.id) === String(taskId));
    if (idx === -1) return res.status(404).json({ error: 'Task not found' });
    
    const note = {
      id: uuidv4(),
      content,
      author: req.user.name,
      authorId: req.user.id,
      createdAt: new Date().toISOString()
    };
    
    if (!tasks[idx].notes) tasks[idx].notes = [];
    const noteIndex = tasks[idx].notes.length;
    tasks[idx].notes.push(note);
    await db.set(`tasks_${projectId}`, tasks);
    
    // Sync note to HubSpot (async, non-blocking) and store HubSpot ID
    const projects = await db.get('projects') || [];
    const project = projects.find(p => p.id === projectId);
    if (project && project.hubspotRecordId && hubspot.isValidRecordId(project.hubspotRecordId)) {
      const task = tasks[idx];
      hubspot.syncTaskNoteToRecord(project.hubspotRecordId, {
        taskTitle: task.taskTitle || task.clientFacingName || 'Unknown Task',
        phase: task.phase || 'N/A',
        stage: task.stage || 'N/A',
        noteContent: content,
        author: req.user.name,
        timestamp: note.createdAt,
        projectName: project.clientName || project.name || 'Unknown Project'
      }).then(async (result) => {
        // Store HubSpot note ID for future updates
        if (result && result.id) {
          try {
            const updatedTasks = await getRawTasks(projectId);
            if (updatedTasks[idx] && updatedTasks[idx].notes && updatedTasks[idx].notes[noteIndex]) {
              updatedTasks[idx].notes[noteIndex].hubspotNoteId = result.id;
              updatedTasks[idx].notes[noteIndex].hubspotSyncedAt = new Date().toISOString();
              await db.set(`tasks_${projectId}`, updatedTasks);
            }
          } catch (err) {
            console.error('Failed to save HubSpot note ID:', err.message);
          }
        }
      }).catch(err => console.error('HubSpot note sync failed:', err.message));
    }
    
    res.json(note);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Update a note (author only)
app.put('/api/projects/:projectId/tasks/:taskId/notes/:noteId', authenticateToken, async (req, res) => {
  try {
    const { projectId, taskId, noteId } = req.params;
    
    if (!canAccessProject(req.user, projectId)) {
      return res.status(403).json({ error: 'Access denied to this project' });
    }
    
    const { content } = req.body;
    if (!content) return res.status(400).json({ error: 'Note content is required' });
    
    // Use raw tasks for mutation to prevent normalization drift
    const tasks = await getRawTasks(projectId);
    const taskIdx = tasks.findIndex(t => t.id === parseInt(taskId) || String(t.id) === String(taskId));
    if (taskIdx === -1) return res.status(404).json({ error: 'Task not found' });
    
    const noteIdx = (tasks[taskIdx].notes || []).findIndex(n => n.id === noteId);
    if (noteIdx === -1) return res.status(404).json({ error: 'Note not found' });
    
    const note = tasks[taskIdx].notes[noteIdx];
    
    // Only the author or an admin can edit the note
    if (note.authorId !== req.user.id && req.user.role !== config.ROLES.ADMIN) {
      return res.status(403).json({ error: 'You can only edit your own notes' });
    }
    
    tasks[taskIdx].notes[noteIdx].content = content;
    tasks[taskIdx].notes[noteIdx].editedAt = new Date().toISOString();
    await db.set(`tasks_${projectId}`, tasks);
    
    // Sync updated note to HubSpot if it has a HubSpot ID
    const existingNoteId = tasks[taskIdx].notes[noteIdx].hubspotNoteId;
    if (existingNoteId) {
      const projects = await db.get('projects') || [];
      const project = projects.find(p => p.id === projectId);
      if (project && project.hubspotRecordId && hubspot.isValidRecordId(project.hubspotRecordId)) {
        const task = tasks[taskIdx];
        hubspot.syncTaskNoteToRecord(project.hubspotRecordId, {
          taskTitle: task.taskTitle || task.clientFacingName || 'Unknown Task',
          phase: task.phase || 'N/A',
          stage: task.stage || 'N/A',
          noteContent: content,
          author: note.author || req.user.name,
          timestamp: note.createdAt,
          projectName: project.clientName || project.name || 'Unknown Project'
        }, existingNoteId).catch(err => console.error('HubSpot note update failed:', err.message));
      }
    }
    
    res.json(tasks[taskIdx].notes[noteIdx]);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete a note (author only)
app.delete('/api/projects/:projectId/tasks/:taskId/notes/:noteId', authenticateToken, async (req, res) => {
  try {
    const { projectId, taskId, noteId } = req.params;
    
    if (!canAccessProject(req.user, projectId)) {
      return res.status(403).json({ error: 'Access denied to this project' });
    }
    
    // Use raw tasks for mutation to prevent normalization drift
    const tasks = await getRawTasks(projectId);
    const taskIdx = tasks.findIndex(t => t.id === parseInt(taskId) || String(t.id) === String(taskId));
    if (taskIdx === -1) return res.status(404).json({ error: 'Task not found' });
    
    const noteIdx = (tasks[taskIdx].notes || []).findIndex(n => n.id === noteId);
    if (noteIdx === -1) return res.status(404).json({ error: 'Note not found' });
    
    const note = tasks[taskIdx].notes[noteIdx];
    
    // Only the author or an admin can delete the note
    if (note.authorId !== req.user.id && req.user.role !== config.ROLES.ADMIN) {
      return res.status(403).json({ error: 'You can only delete your own notes' });
    }
    
    tasks[taskIdx].notes.splice(noteIdx, 1);
    await db.set(`tasks_${projectId}`, tasks);
    
    res.json({ message: 'Note deleted' });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ============== TASK FILE ATTACHMENTS ==============
const ALLOWED_FILE_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
  'text/csv'
];

// Upload file to task (admin only)
app.post('/api/projects/:projectId/tasks/:taskId/files', authenticateToken, requireAdmin, uploadLimiter, upload.single('file'), async (req, res) => {
  try {
    
    const { projectId, taskId } = req.params;
    
    if (!canAccessProject(req.user, projectId)) {
      return res.status(403).json({ error: 'Access denied to this project' });
    }
    
    if (!req.file) {
      return res.status(400).json({ error: 'No file provided' });
    }
    
    // Validate file type
    if (!ALLOWED_FILE_TYPES.includes(req.file.mimetype)) {
      return res.status(400).json({ error: 'File type not allowed. Allowed: PDF, images, Word, Excel, text files.' });
    }
    
    // Get project info for folder naming
    const projects = await getProjects();
    const project = projects.find(p => p.id === projectId);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }
    
    // Get task
    const tasks = await getRawTasks(projectId);
    const taskIdx = tasks.findIndex(t => t.id === parseInt(taskId) || String(t.id) === String(taskId));
    if (taskIdx === -1) {
      return res.status(404).json({ error: 'Task not found' });
    }
    
    // Upload to Google Drive
    const driveResult = await googledrive.uploadTaskFile(
      project.name || project.clientName,
      project.clientName || project.name,
      req.file.originalname,
      req.file.buffer,
      req.file.mimetype
    );
    
    // Create file entry
    const fileEntry = {
      id: uuidv4(),
      name: req.file.originalname,
      driveFileId: driveResult.fileId,
      url: driveResult.webViewLink,
      downloadUrl: driveResult.webContentLink,
      thumbnailUrl: driveResult.thumbnailLink,
      mimeType: req.file.mimetype,
      size: req.file.size,
      uploadedBy: req.user.name,
      uploadedById: req.user.id,
      uploadedAt: new Date().toISOString()
    };
    
    // Initialize files array if needed
    if (!tasks[taskIdx].files) {
      tasks[taskIdx].files = [];
    }
    
    tasks[taskIdx].files.push(fileEntry);
    await db.set(`tasks_${projectId}`, tasks);
    
    if (tasks[taskIdx].showToClient) {
      try {
        const appBaseUrl = `${req.protocol}://${req.get('host')}`;
        const slug = project.slug || project.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
        const portalLink = `${appBaseUrl}/portal/${slug}#task-${taskId}`;
        const allUsers = await getUsers();
        const clientUsers = allUsers.filter(u => u.role === 'client' && u.assignedProjects && u.assignedProjects.includes(projectId));
        const templates = await getEmailTemplates();
        const tpl = getTemplateById(templates, 'task_attachment');
        for (const client of clientUsers) {
          const vars = {
            taskName: tasks[taskIdx].taskTitle || tasks[taskIdx].clientName || tasks[taskIdx].name || 'Task',
            fileName: fileEntry.name,
            projectName: project.name || project.clientName,
            portalLink,
            recipientName: client.name || client.email,
            recipientEmail: client.email,
            appUrl: appBaseUrl
          };
          const subject = renderTemplate(tpl.subject, vars);
          const body = renderTemplate(tpl.body, vars);
          const htmlBody = buildHtmlEmail(body, null, portalLink, 'View in Portal', null, appBaseUrl);
          await queueNotification('task_attachment', client.id, client.email, client.name || client.email, {
            subject,
            body,
            htmlBody,
            ctaUrl: portalLink,
            ctaLabel: 'View in Portal'
          }, {
            relatedEntityId: taskId,
            relatedEntityType: 'task',
            createdBy: req.user.id
          });
        }
      } catch (notifErr) {
        console.error('Failed to queue task attachment notifications:', notifErr);
      }
    }
    
    res.json({ message: 'File uploaded successfully', file: fileEntry });
  } catch (error) {
    console.error('Task file upload error:', error);
    res.status(500).json({ error: error.message || 'Failed to upload file' });
  }
});

// Delete file from task (admin only)
app.delete('/api/projects/:projectId/tasks/:taskId/files/:fileId', authenticateToken, requireAdmin, async (req, res) => {
  try {
    
    const { projectId, taskId, fileId } = req.params;
    
    if (!canAccessProject(req.user, projectId)) {
      return res.status(403).json({ error: 'Access denied to this project' });
    }
    
    const tasks = await getRawTasks(projectId);
    const taskIdx = tasks.findIndex(t => t.id === parseInt(taskId) || String(t.id) === String(taskId));
    if (taskIdx === -1) {
      return res.status(404).json({ error: 'Task not found' });
    }
    
    const files = tasks[taskIdx].files || [];
    const fileIdx = files.findIndex(f => f.id === fileId);
    if (fileIdx === -1) {
      return res.status(404).json({ error: 'File not found' });
    }
    
    const file = files[fileIdx];
    
    // Delete from Google Drive
    try {
      await googledrive.deleteFile(file.driveFileId);
    } catch (driveError) {
      console.error('Failed to delete from Drive:', driveError.message);
      // Continue with removal from task even if Drive delete fails
    }
    
    tasks[taskIdx].files.splice(fileIdx, 1);
    await db.set(`tasks_${projectId}`, tasks);
    
    res.json({ message: 'File deleted successfully' });
  } catch (error) {
    console.error('Task file delete error:', error);
    res.status(500).json({ error: 'Failed to delete file' });
  }
});

// ============== PROJECT ROUTES ==============
app.get('/api/projects', authenticateToken, async (req, res) => {
  try {
    let projects = await getProjects();
    const templates = await db.get('templates') || [];
    
    // Filter projects based on user access (admins see all, users see assigned only)
    const isAdmin = req.user.role === config.ROLES.ADMIN;
    if (!isAdmin) {
      const userAssignedProjects = req.user.assignedProjects || [];
      // Include assigned projects and any projects the user created
      projects = projects.filter(p => userAssignedProjects.includes(p.id) || p.createdBy === req.user.id);
    }

    // Draft projects are only visible to the user who created them — applies to ALL users including admins
    projects = projects.filter(p => {
      const pubStatus = p.publishedStatus || 'published';
      if (pubStatus === 'published') return true;
      return p.createdBy === req.user.id;
    });
    
    const projectsWithDetails = await Promise.all(projects.map(async (project) => {
      const template = templates.find(t => t.id === project.template);
      const tasks = await getTasks(project.id);
      
      // Calculate task completion progress
      const totalTasks = tasks.length;
      const completedTasks = tasks.filter(t => t.completed).length;
      const progressPercent = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;
      
      // Calculate launch duration for completed projects
      let launchDurationWeeks = null;
      if (project.status === 'completed') {
        const contractTask = tasks.find(t => 
          t.taskTitle && t.taskTitle.toLowerCase().includes('contract signed')
        );
        const goLiveTask = tasks.find(t => 
          t.taskTitle && t.taskTitle.toLowerCase().includes('first live patient samples')
        );
        
        if (contractTask?.dateCompleted && goLiveTask?.dateCompleted) {
          const contractDate = new Date(contractTask.dateCompleted);
          const goLiveDate = new Date(goLiveTask.dateCompleted);
          const diffMs = goLiveDate - contractDate;
          launchDurationWeeks = Math.round(diffMs / (7 * 24 * 60 * 60 * 1000));
        }
      }
      
      // Find training/validation week dates from all tasks in Training/Validation stage
      let trainingStartDate = null;
      let trainingEndDate = null;
      let trainingStartTaskId = null;
      
      // Get all tasks in the Training/Validation stage (case-insensitive match)
      const trainingTasks = tasks.filter(t => 
        t.stage && t.stage.toLowerCase().includes('training')
      );
      
      // Find tasks with due dates and sort them
      const tasksWithDueDates = trainingTasks
        .filter(t => t.dueDate)
        .sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));
      
      if (tasksWithDueDates.length > 0) {
        // Earliest due date becomes training start
        trainingStartDate = tasksWithDueDates[0].dueDate;
        trainingStartTaskId = tasksWithDueDates[0].id;
        
        // Latest due date becomes training end
        trainingEndDate = tasksWithDueDates[tasksWithDueDates.length - 1].dueDate;
      }
      
      // Find go-live task ID for calendar navigation
      const goLiveTask = tasks.find(t => 
        t.taskTitle && t.taskTitle.toLowerCase().includes('first live patient samples')
      );
      const goLiveTaskId = goLiveTask ? goLiveTask.id : null;
      
      return {
        ...project,
        templateName: template ? template.name : project.template,
        launchDurationWeeks,
        totalTasks,
        completedTasks,
        progressPercent,
        trainingStartDate,
        trainingEndDate,
        trainingStartTaskId,
        goLiveTaskId
      };
    }));
    
    res.json(projectsWithDetails);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/projects', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { name, clientName, projectManager, hubspotRecordId, hubspotRecordType, hubspotDealStage, hubspotPipelineId, template } = req.body;
    if (!name || !clientName) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    const projects = await getProjects();
    const existingSlugs = projects.map(p => p.clientLinkSlug).filter(Boolean);
    const clientLinkSlug = generateClientSlug(clientName, existingSlugs);
    const newProject = {
      id: uuidv4(),
      name,
      clientName,
      projectManager: projectManager || '',
      hubspotRecordId: hubspotRecordId || '',
      hubspotRecordType: hubspotRecordType || 'companies',
      hubspotDealStage: hubspotDealStage || '',
      hubspotCompanyId: '',
      hubspotContactId: '',
      template: template || 'biolis-au480-clia',
      status: 'active',
      publishedStatus: 'draft',
      clientLinkId: uuidv4(),
      clientLinkSlug: clientLinkSlug,
      createdAt: new Date().toISOString(),
      createdBy: req.user.id
    };
    projects.push(newProject);
    await db.set('projects', projects);

    // Sync deal stage to HubSpot on project creation
    let hubspotSyncStatus = null;
    if (hubspotRecordId && hubspotDealStage) {
      try {
        await hubspot.updateRecordStage(hubspotRecordId, hubspotDealStage, hubspotPipelineId || null);
        hubspotSyncStatus = 'synced';
        console.log(`✅ HubSpot stage synced on project creation: record ${hubspotRecordId} -> stage ${hubspotDealStage}`);
      } catch (hsError) {
        hubspotSyncStatus = 'failed';
        console.error('⚠️ HubSpot sync failed during project creation (project still created):', hsError.message);
      }
    }

    // Load and apply selected template (empty if none selected)
    let templateTasks = [];
    if (template) {
      const templates = await db.get('templates') || [];
      const selectedTemplate = templates.find(t => t.id === template);
      if (selectedTemplate) {
        // Normalize template tasks for the new project
        // Always reset all completion status to start fresh
        templateTasks = (selectedTemplate.tasks || []).map(task => ({
          ...task,
          // Reset any project-specific fields
          completed: false,
          dateCompleted: null,
          notes: [],
          // Reset all subtasks to pending status
          subtasks: (task.subtasks || []).map(st => ({
            ...st,
            completed: false,
            notApplicable: false,
            status: 'Pending',
            completedAt: null
          }))
        }));
      }
    }
    await db.set(`tasks_${newProject.id}`, templateTasks);

    const templates = await db.get('templates') || [];
    const templateRecord = templates.find(t => t.id === newProject.template);
    newProject.templateName = templateRecord ? templateRecord.name : newProject.template;

    res.json({ ...newProject, hubspotSyncStatus });
  } catch (error) {
    console.error('Create project error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/projects/:id', authenticateToken, async (req, res) => {
  try {
    const projects = await getProjects();
    const project = projects.find(p => p.id === req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    
    // Check project access
    if (!canAccessProject(req.user, req.params.id)) {
      return res.status(403).json({ error: 'Access denied to this project' });
    }

    // Draft projects are only visible to the user who created them — applies to ALL users
    const pubStatus = project.publishedStatus || 'published';
    if (pubStatus === 'draft' && project.createdBy !== req.user.id) {
      return res.status(403).json({ error: 'This project is in draft mode' });
    }
    
    const templates = await db.get('templates') || [];
    const template = templates.find(t => t.id === project.template);
    project.templateName = template ? template.name : project.template;
    
    res.json(project);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/projects/:id', authenticateToken, async (req, res) => {
  try {
    // Check project write access
    if (!canWriteProject(req.user, req.params.id)) {
      return res.status(403).json({ error: 'Write access required for this project' });
    }

    const projects = await getProjects();
    const idx = projects.findIndex(p => p.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Project not found' });

    // Validate project status against allowed values
    if (req.body.status !== undefined) {
      if (!config.PROJECT_STATUSES.includes(req.body.status)) {
        return res.status(400).json({ error: `Invalid status. Must be one of: ${config.PROJECT_STATUSES.join(', ')}` });
      }
    }

    // Validate publishedStatus — only admins or project-level admins (managers) may change it
    if (req.body.publishedStatus !== undefined) {
      const isAdminUser = req.user.role === config.ROLES.ADMIN;
      const isProjectAdmin = (req.user.projectAccessLevels || {})[req.params.id] === 'admin';
      if (!isAdminUser && !isProjectAdmin) {
        return res.status(403).json({ error: 'Admin or project manager access required to change published status' });
      }
      if (!['draft', 'published'].includes(req.body.publishedStatus)) {
        return res.status(400).json({ error: 'Invalid publishedStatus. Must be draft or published' });
      }
    }

    // Validate name and clientName are not empty if provided
    if (req.body.name !== undefined && !String(req.body.name).trim()) {
      return res.status(400).json({ error: 'Project name cannot be empty' });
    }
    if (req.body.clientName !== undefined && !String(req.body.clientName).trim()) {
      return res.status(400).json({ error: 'Client name cannot be empty' });
    }

    const allowedFields = ['name', 'clientName', 'projectManager', 'hubspotRecordId', 'hubspotRecordType', 'status', 'publishedStatus', 'clientPortalDomain', 'goLiveDate'];
    
    // Capture old values before the update loop
    const oldPublishedStatus = projects[idx].publishedStatus || 'draft';
    const oldClientName = projects[idx].clientName;
    const newClientName = req.body.clientName;
    const oldStatus = projects[idx].status;
    
    allowedFields.forEach(field => {
      if (req.body[field] !== undefined) {
        let value = req.body[field];
        if (field === 'goLiveDate' && value) {
          const d = new Date(value);
          if (!isNaN(d.getTime())) {
            value = d.toISOString().split('T')[0];
          } else {
            value = '';
          }
        }
        projects[idx][field] = value;
      }
    });
    
    // Regenerate clientLinkSlug when clientName changes
    if (newClientName && newClientName !== oldClientName) {
      const oldProjectSlug = projects[idx].clientLinkSlug;
      const existingSlugs = projects
        .filter(p => p.id !== projects[idx].id)
        .map(p => p.clientLinkSlug)
        .filter(Boolean);
      const newProjectSlug = generateClientSlug(newClientName, existingSlugs);
      if (oldProjectSlug && oldProjectSlug !== newProjectSlug) {
        // Preserve old slug for redirect lookups so existing URLs keep working
        if (!projects[idx].previousSlugs) projects[idx].previousSlugs = [];
        if (!projects[idx].previousSlugs.includes(oldProjectSlug)) {
          projects[idx].previousSlugs.push(oldProjectSlug);
        }
      }
      projects[idx].clientLinkSlug = newProjectSlug;
    }
    
    await db.set('projects', projects);

    // Release held notifications when project is published (draft → published)
    const newPublishedStatus = req.body.publishedStatus;
    if (newPublishedStatus === 'published' && oldPublishedStatus === 'draft') {
      (async () => {
        try {
          const queue = (await db.get('pending_notifications')) || [];
          let released = 0;
          queue.forEach(n => {
            if (n.status === 'held' && n.relatedProjectId === projects[idx].id) {
              n.status = 'pending';
              released++;
            }
          });
          if (released > 0) {
            await db.set('pending_notifications', queue);
            console.log(`📬 Released ${released} held notification(s) for project "${projects[idx].name}" on publish`);
          }
        } catch (err) {
          console.error('Failed to release held notifications on publish:', err.message);
        }
      })();
    }

    // Re-hold pending task_assignment notifications when project moves back to draft (published → draft)
    if (newPublishedStatus === 'draft' && oldPublishedStatus === 'published') {
      (async () => {
        try {
          const queue = (await db.get('pending_notifications')) || [];
          let reheld = 0;
          queue.forEach(n => {
            if (n.status === 'pending' && n.relatedProjectId === projects[idx].id && n.type === 'task_assignment') {
              n.status = 'held';
              reheld++;
            }
          });
          if (reheld > 0) {
            await db.set('pending_notifications', queue);
            console.log(`🔒 Re-held ${reheld} notification(s) for project "${projects[idx].name}" moved back to draft`);
          }
        } catch (err) {
          console.error('Failed to re-hold notifications on unpublish:', err.message);
        }
      })();
    }

    // Cancel pending task/project notifications when a project is paused or completed.
    // Runs non-blocking so the response is not delayed.
    const newStatus = req.body.status;
    if (newStatus !== undefined && newStatus !== oldStatus && ['paused', 'completed'].includes(newStatus)) {
      getRawTasks(req.params.id).then(projectTasks => {
        const taskIds = (projectTasks || []).map(t => String(t.id));
        return cancelProjectNotifications(req.params.id, taskIds);
      }).catch(err => console.error('[NOTIFICATIONS] Failed to cancel project notifications on status change:', err));
    }

    // Cascade clientName changes to service/validation reports (non-blocking)
    if (newClientName && newClientName !== oldClientName) {
      (async () => {
        try {
          const serviceReports = (await db.get('service_reports')) || [];
          let srUpdated = false;
          serviceReports.forEach(r => {
            if (r.clientFacilityName === oldClientName) {
              r.clientFacilityName = newClientName;
              srUpdated = true;
            }
          });
          if (srUpdated) await db.set('service_reports', serviceReports);

          console.log(`🔄 Cascade project clientName update: "${oldClientName}" → "${newClientName}"`);
        } catch (err) {
          console.error('Cascade project clientName update error:', err.message);
        }
      })();
    }

    res.json(projects[idx]);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/projects/:id', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== config.ROLES.ADMIN) {
      return res.status(403).json({ error: 'Only admins can delete projects' });
    }
    
    const projects = await getProjects();
    const idx = projects.findIndex(p => p.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Project not found' });
    
    const projectId = req.params.id;
    projects.splice(idx, 1);
    await db.set('projects', projects);
    
    // Also delete the project's tasks
    await db.delete(`tasks_${projectId}`);

    // Cancel any held notifications for this project
    const notifQueue = (await db.get('pending_notifications')) || [];
    const cleanedQueue = notifQueue.filter(n => !(n.status === 'held' && n.relatedProjectId === projectId));
    if (cleanedQueue.length !== notifQueue.length) {
      await db.set('pending_notifications', cleanedQueue);
    }

    res.json({ message: 'Project deleted successfully' });
  } catch (error) {
    console.error('Delete project error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Clone/Duplicate a project
app.post('/api/projects/:id/clone', authenticateToken, requireAdmin, async (req, res) => {
  try {
    // Check project access
    if (!canAccessProject(req.user, req.params.id)) {
      return res.status(403).json({ error: 'Access denied to this project' });
    }
    
    const projects = await getProjects();
    const originalProject = projects.find(p => p.id === req.params.id);
    if (!originalProject) return res.status(404).json({ error: 'Project not found' });
    
    const { name, clientName } = req.body;
    const newProjectId = uuidv4();
    const existingSlugs = projects.map(p => p.clientLinkSlug).filter(Boolean);
    
    // Use provided clientName for slug, or derive from new project name, or fallback to original + '-copy'
    const newClientName = clientName || name || `${originalProject.clientName} (Copy)`;
    
    const newProject = {
      ...originalProject,
      id: newProjectId,
      name: name || `${originalProject.name} (Copy)`,
      clientName: newClientName,
      status: 'active',
      publishedStatus: 'draft',
      clientLinkId: uuidv4(),
      clientLinkSlug: generateClientSlug(newClientName, existingSlugs),
      hubspotRecordId: '',
      lastHubSpotSync: null,
      createdAt: new Date().toISOString()
    };
    
    projects.push(newProject);
    await db.set('projects', projects);
    
    // Clone the tasks - clear state, files, HubSpot refs, and reset ownership
    const originalTasks = await getTasks(req.params.id);
    const clonedTasks = originalTasks.map(task => ({
      ...task,
      completed: false,
      dateCompleted: '',
      notes: [],
      files: [],
      createdBy: req.user.id,
      hubspotTaskId: undefined,
      hubspotSyncedAt: undefined,
      subtasks: (task.subtasks || []).map(st => ({
        ...st,
        completed: false,
        notApplicable: false,
        status: 'Pending',
        completedAt: null
      }))
    }));
    await db.set(`tasks_${newProjectId}`, clonedTasks);
    
    res.json(newProject);
  } catch (error) {
    console.error('Clone project error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============== TASK ROUTES ==============
app.get('/api/projects/:id/tasks', authenticateToken, async (req, res) => {
  try {
    // Check project access
    if (!canAccessProject(req.user, req.params.id)) {
      return res.status(403).json({ error: 'Access denied to this project' });
    }
    
    const tasks = await getTasks(req.params.id);
    res.json(tasks);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/projects/:id/tasks', authenticateToken, async (req, res) => {
  try {
    // Check project write access
    if (!canWriteProject(req.user, req.params.id)) {
      return res.status(403).json({ error: 'Write access required for this project' });
    }

    const { taskTitle, owner, dueDate, phase, stage, showToClient, clientName, description, notes, dependencies } = req.body;
    if (!taskTitle || !String(taskTitle).trim()) {
      return res.status(400).json({ error: 'Task title is required' });
    }
    const projectId = req.params.id;
    // Use raw tasks for mutation to prevent normalization drift
    const tasks = await getRawTasks(projectId);
    const newTask = {
      id: getNextNumericId(tasks),
      phase: phase || 'Phase 1',
      stage: stage || '',
      taskTitle,
      owner: owner || '',
      dueDate: dueDate || '',
      startDate: '',
      dateCompleted: '',
      duration: 0,
      completed: false,
      showToClient: showToClient || false,
      clientName: clientName || '',
      description: description || '',
      notes: notes || [],
      dependencies: dependencies || [],
      createdBy: req.user.id,
      createdAt: new Date().toISOString()
    };
    tasks.push(newTask);
    await db.set(`tasks_${projectId}`, tasks);

    if (newTask.owner) {
      const project = (await getProjects()).find(p => String(p.id) === String(projectId));
      if (project) {
        sendAssignmentNotification(newTask.owner, newTask, null, project, req.user.id);
      }
    }

    res.json(newTask);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/projects/:projectId/tasks/:taskId', authenticateToken, async (req, res) => {
  try {
    const { projectId, taskId } = req.params;
    
    // Check project write access
    if (!canWriteProject(req.user, projectId)) {
      return res.status(403).json({ error: 'Write access required for this project' });
    }

    const updates = req.body;
    // Use raw tasks for mutation to prevent normalization drift
    const tasks = await getRawTasks(projectId);
    const idx = tasks.findIndex(t => t.id === parseInt(taskId) || String(t.id) === String(taskId));
    if (idx === -1) return res.status(404).json({ error: 'Task not found' });
    
    const task = tasks[idx];
    const isAdmin = req.user.role === config.ROLES.ADMIN;
    const isCreator = task.createdBy === req.user.id;
    const isTemplateTask = !task.createdBy;

    // Non-admins can only edit tasks they created (or template tasks for limited fields)
    if (!isAdmin) {
      // For template tasks (no createdBy), non-admins can only toggle completion and add notes
      if (isTemplateTask) {
        const allowedFields = ['completed', 'dateCompleted', 'notes'];
        Object.keys(updates).forEach(key => {
          if (!allowedFields.includes(key)) {
            delete updates[key];
          }
        });
      } else if (!isCreator) {
        // Non-admins cannot edit tasks they didn't create (except completion status)
        const allowedFields = ['completed', 'dateCompleted', 'notes'];
        Object.keys(updates).forEach(key => {
          if (!allowedFields.includes(key)) {
            delete updates[key];
          }
        });
      }
      
      // Non-admins cannot modify showToClient, clientName, or owner
      delete updates.showToClient;
      delete updates.clientName;
      delete updates.owner;
    }

    // Whitelist allowed fields to prevent overwriting protected fields (id, createdBy, files, subtasks, hubspotTaskId, etc.)
    const taskUpdateAllowedFields = [
      'taskTitle', 'owner', 'secondaryOwner', 'dueDate', 'startDate', 'phase', 'stage',
      'completed', 'dateCompleted', 'description', 'showToClient', 'clientName',
      'dependencies', 'tags', 'notes', 'duration'
    ];
    const sanitizedUpdates = {};
    for (const key of taskUpdateAllowedFields) {
      if (updates[key] !== undefined) {
        sanitizedUpdates[key] = updates[key];
      }
    }

    const previousOwner = task.owner;
    const wasCompleted = task.completed;

    // Server-side validation: Check for incomplete subtasks before allowing completion
    if (sanitizedUpdates.completed && !task.completed) {
      const subtasks = task.subtasks || [];
      // Check for both new format (completed boolean) and old format (status string)
      const incompleteSubtasks = subtasks.filter(s => {
        const isComplete = s.completed || s.status === 'Complete' || s.status === 'completed';
        const isNotApplicable = s.notApplicable || s.status === 'N/A' || s.status === 'not_applicable';
        return !isComplete && !isNotApplicable;
      });
      if (incompleteSubtasks.length > 0) {
        return res.status(400).json({
          error: 'Cannot complete task with pending subtasks',
          incompleteSubtasks: incompleteSubtasks.map(s => s.title)
        });
      }
    }

    // Auto-set dateCompleted when marking task as completed (server-side guarantee)
    if (sanitizedUpdates.completed && !task.completed && !sanitizedUpdates.dateCompleted) {
      sanitizedUpdates.dateCompleted = new Date().toISOString();
    }
    // Clear dateCompleted when un-completing a task
    if (sanitizedUpdates.completed === false && task.completed) {
      sanitizedUpdates.dateCompleted = '';
    }

    tasks[idx] = { ...tasks[idx], ...sanitizedUpdates };
    await db.set(`tasks_${projectId}`, tasks);
    
    // Log activity for task updates
    const actionType = !wasCompleted && tasks[idx].completed ? 'completed' : 
                       wasCompleted && !tasks[idx].completed ? 'reopened' : 'updated';
    logActivity(
      req.user.id,
      req.user.name,
      actionType,
      'task',
      taskId,
      { taskTitle: tasks[idx].taskTitle, phase: tasks[idx].phase, stage: tasks[idx].stage },
      projectId
    );
    
    if (!wasCompleted && tasks[idx].completed) {
      const completedTask = tasks[idx];
      
      // Create HubSpot task instead of logging an activity note
      createHubSpotTask(projectId, completedTask, req.user.name);

      // Check for phase completion
      checkPhaseCompletion(projectId, tasks, completedTask);
    }

    if (sanitizedUpdates.owner && sanitizedUpdates.owner !== previousOwner) {
      const project = (await getProjects()).find(p => String(p.id) === String(projectId));
      if (project) {
        sendAssignmentNotification(sanitizedUpdates.owner, tasks[idx], null, project, req.user.id);
      }
    }
    
    res.json(tasks[idx]);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/projects/:projectId/tasks/:taskId', authenticateToken, async (req, res) => {
  try {
    const { projectId, taskId } = req.params;

    // Check project write access (delete is a write operation)
    if (!canWriteProject(req.user, projectId)) {
      return res.status(403).json({ error: 'Write access required for this project' });
    }
    
    // Use raw tasks for mutation to prevent normalization drift
    const tasks = await getRawTasks(projectId);
    const task = tasks.find(t => t.id === parseInt(taskId) || String(t.id) === String(taskId));
    
    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }
    
    const isAdmin = req.user.role === config.ROLES.ADMIN;
    const isCreator = task.createdBy && task.createdBy === req.user.id;
    const isTemplateTask = !task.createdBy;
    
    if (!isAdmin && (isTemplateTask || !isCreator)) {
      return res.status(403).json({ error: 'You can only delete tasks you created' });
    }
    
    const deletedId = String(taskId);
    const filtered = tasks.filter(t => String(t.id) !== deletedId);
    // Clean up dependency references to the deleted task
    for (const t of filtered) {
      if (Array.isArray(t.dependencies)) {
        t.dependencies = t.dependencies.filter(depId => String(depId) !== deletedId);
      }
    }
    await db.set(`tasks_${projectId}`, filtered);
    res.json({ message: 'Task deleted' });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Reorder task (move up or down within same stage)
app.post('/api/projects/:projectId/tasks/:taskId/reorder', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { projectId, taskId } = req.params;
    const { direction } = req.body; // 'up' or 'down'
    
    if (!direction || !['up', 'down'].includes(direction)) {
      return res.status(400).json({ error: 'Direction must be "up" or "down"' });
    }
    
    // Use raw tasks for mutation to prevent normalization drift
    const tasks = await getRawTasks(projectId);
    
    // Normalize task ID comparison
    const normalizeId = (id) => typeof id === 'string' ? id : String(id);
    const targetTaskId = normalizeId(taskId);
    
    const taskIndex = tasks.findIndex(t => normalizeId(t.id) === targetTaskId);
    
    if (taskIndex === -1) {
      return res.status(404).json({ error: 'Task not found' });
    }
    
    const task = tasks[taskIndex];
    
    // Get tasks in the same stage with their global indices
    const stageTasks = tasks
      .map((t, idx) => ({ task: t, globalIdx: idx, originalIdx: idx }))
      .filter(item => item.task.phase === task.phase && item.task.stage === task.stage);
    
    // Sort by existing stageOrder first (preserve user-defined ordering), fallback to array order
    stageTasks.sort((a, b) => {
      const aOrder = a.task.stageOrder !== undefined ? a.task.stageOrder : a.originalIdx + 1000;
      const bOrder = b.task.stageOrder !== undefined ? b.task.stageOrder : b.originalIdx + 1000;
      return aOrder - bOrder;
    });
    
    // Normalize stageOrder to sequential values (1, 2, 3, ...) preserving the sorted order
    stageTasks.forEach((item, idx) => {
      tasks[item.globalIdx].stageOrder = idx + 1;
    });
    
    // Now find the task's position in the sorted/normalized stage array
    const positionInStage = stageTasks.findIndex(item => normalizeId(item.task.id) === targetTaskId);
    
    if (positionInStage === -1) {
      return res.status(404).json({ error: 'Task not found in stage' });
    }
    
    // Determine swap target position
    let swapPosition;
    if (direction === 'up' && positionInStage > 0) {
      swapPosition = positionInStage - 1;
    } else if (direction === 'down' && positionInStage < stageTasks.length - 1) {
      swapPosition = positionInStage + 1;
    } else {
      return res.status(400).json({ error: 'Cannot move further in that direction', tasks });
    }
    
    // Swap stageOrder values between the two tasks
    const currentGlobalIdx = stageTasks[positionInStage].globalIdx;
    const swapGlobalIdx = stageTasks[swapPosition].globalIdx;
    
    tasks[currentGlobalIdx].stageOrder = swapPosition + 1;
    tasks[swapGlobalIdx].stageOrder = positionInStage + 1;
    
    await db.set(`tasks_${projectId}`, tasks);
    res.json({ message: 'Task reordered', tasks });
  } catch (error) {
    console.error('Reorder task error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============== CLIENT VIEW (Legacy - Redirect to /launch) ==============
app.get('/client/:linkId', async (req, res) => {
  // Redirect legacy /client/:linkId URLs to new /launch/:slug format
  res.redirect(301, `/launch/${req.params.linkId}`);
});

app.get('/api/client/:linkId', async (req, res) => {
  try {
    const projects = await getProjects();
    const project = projects.find(p => p.clientLinkSlug === req.params.linkId || p.clientLinkId === req.params.linkId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const allTasks = await getTasks(project.id);
    const clientTasks = allTasks.filter(t => t.showToClient);

    // Calculate overall progress from ALL tasks (matches admin dashboard)
    const totalAllTasks = allTasks.length;
    const completedAllTasks = allTasks.filter(t => t.completed).length;
    const overallProgressPercent = totalAllTasks > 0 ? Math.round((completedAllTasks / totalAllTasks) * 100) : 0;

    const users = await getUsers();
    const tasksWithOwnerNames = clientTasks.map(task => ({
      ...task,
      ownerDisplayName: task.owner
        ? (users.find(u => u.email === task.owner)?.name || task.owner)
        : null
    }));

    res.json({
      project: {
        name: project.name,
        clientName: project.clientName,
        goLiveDate: project.goLiveDate,
        overallProgressPercent
      },
      tasks: tasksWithOwnerNames
    });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ============== ANNOUNCEMENTS ==============
// Get announcements (auth required; clients see only their targeted announcements)
app.get('/api/announcements', authenticateToken, async (req, res) => {
  try {
    const announcements = (await db.get('announcements')) || [];
    // Sort by date, newest first
    announcements.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    // Non-client roles (admin, user, vendor) see all announcements
    if (req.user.role !== 'client') {
      return res.json(announcements);
    }

    // Client role: only show announcements targeted to their slug or to all clients
    const userSlug = req.user.slug;
    const visible = announcements.filter(a =>
      a.targetAll === true ||
      (Array.isArray(a.targetClients) && a.targetClients.includes(userSlug))
    );
    res.json(visible);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Create announcement (admin, managers, client portal admins)
app.post('/api/announcements', authenticateToken, requireClientPortalAdmin, async (req, res) => {
  try {
    const { title, content, type, priority, pinned, targetAll, targetClients, attachmentUrl, attachmentName } = req.body;
    if (!title || !content) {
      return res.status(400).json({ error: 'Title and content are required' });
    }
    const announcements = (await db.get('announcements')) || [];
    const newAnnouncement = {
      id: uuidv4(),
      title,
      content,
      type: type || 'info', // info, warning, success
      priority: priority || false,
      pinned: pinned || false,
      targetAll: targetAll !== false,
      targetClients: targetClients || [],
      attachmentUrl: attachmentUrl || '',
      attachmentName: attachmentName || '',
      createdAt: new Date().toISOString(),
      createdBy: req.user.name,
      createdById: req.user.id
    };
    announcements.unshift(newAnnouncement);
    // Keep only last 50 announcements
    if (announcements.length > 50) announcements.length = 50;
    await db.set('announcements', announcements);
    res.json(newAnnouncement);

    // Queue email notifications for targeted client users (async, non-blocking)
    try {
      const users = await getUsers();
      const clientUsers = users.filter(u => u.role === config.ROLES.CLIENT && u.email && u.accountStatus !== 'inactive');
      let recipients;
      if (newAnnouncement.targetAll) {
        recipients = clientUsers;
      } else {
        const targetSlugs = new Set(newAnnouncement.targetClients);
        recipients = clientUsers.filter(u => u.slug && targetSlugs.has(u.slug));
      }
      if (recipients.length > 0) {
        // Load editable announcement template
        const annTemplates = await getEmailTemplates();
        const annTpl = getTemplateById(annTemplates, 'announcement');
        const appBaseUrl = await getAppBaseUrl();
        const baseVars = {
          title: newAnnouncement.title,
          content: newAnnouncement.content,
          appUrl: appBaseUrl,
          priorityTag: newAnnouncement.priority ? '[PRIORITY] ' : '',
          priorityBanner: newAnnouncement.priority ? '<p style="color: #dc2626; font-weight: 600; margin-bottom: 8px;">⚠️ This is a priority announcement</p>' : '',
          attachmentUrl: newAnnouncement.attachmentUrl || '',
          attachmentName: newAnnouncement.attachmentName || 'View Attachment',
          attachmentLine: newAnnouncement.attachmentUrl ? '\n\nAttachment: ' + newAnnouncement.attachmentUrl : '',
          attachmentBlock: newAnnouncement.attachmentUrl ? `<p style="margin-top: 16px;"><a href="${newAnnouncement.attachmentUrl}" style="color: #045E9F; font-weight: 500;">📎 ${newAnnouncement.attachmentName || 'View Attachment'}</a></p>` : ''
        };
        // Safeguard: always include full announcement content even if admin edited {{content}} out of template
        let annBody = annTpl.body || '';
        let annHtml = annTpl.htmlBody || '';
        if (!annBody.includes('{{content}}')) annBody += '\n\n{{content}}';
        if (annHtml && !annHtml.includes('{{content}}')) {
          annHtml = annHtml.replace(/<hr/, '<div style="color: #374151; line-height: 1.6; white-space: pre-wrap;">{{content}}</div><hr');
        }

        // Queue one notification per recipient with recipient-specific rendered content
        let queued = 0;
        for (const user of recipients) {
          const vars = { ...baseVars, recipientName: user.name || user.email, recipientEmail: user.email };
          const subject = renderTemplate(annTpl.subject, vars);
          const textBody = renderTemplate(annBody, vars);
          const htmlBody = annHtml ? renderTemplate(annHtml, vars) : buildHtmlEmail(textBody, null);
          const result = await queueNotification(
            'announcement', user.id, user.email, user.name || user.email,
            { subject, body: textBody, htmlBody },
            { relatedEntityId: newAnnouncement.id, relatedEntityType: 'announcement', createdBy: req.user.id }
          );
          if (result) queued++;
        }

        console.log(`[ANNOUNCEMENTS] Queued ${queued}/${recipients.length} notifications for: ${newAnnouncement.title}`);

        // Save queue stats on announcement record
        try {
          const current = (await db.get('announcements')) || [];
          const idx = current.findIndex(a => a.id === newAnnouncement.id);
          if (idx !== -1) {
            current[idx].emailQueued = { queued, total: recipients.length, queuedAt: new Date().toISOString() };
            await db.set('announcements', current);
          }
        } catch (dbErr) {
          console.error('Failed to save email queue stats:', dbErr);
        }

        await logActivity(req.user.id, req.user.name, 'announcement_queued', 'announcement', newAnnouncement.id,
          { title: newAnnouncement.title, emailsQueued: queued, totalRecipients: recipients.length });
      }
    } catch (emailError) {
      console.error('Announcement email notification error:', emailError);
    }
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Update announcement (admin, managers, client portal admins)
app.put('/api/announcements/:id', authenticateToken, requireClientPortalAdmin, async (req, res) => {
  try {
    const { title, content, type, priority, pinned, targetAll, targetClients, attachmentUrl, attachmentName } = req.body;
    const announcements = (await db.get('announcements')) || [];
    const idx = announcements.findIndex(a => a.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Announcement not found' });

    if (title) announcements[idx].title = title;
    if (content) announcements[idx].content = content;
    if (type) announcements[idx].type = type;
    if (priority !== undefined) announcements[idx].priority = priority;
    if (pinned !== undefined) announcements[idx].pinned = pinned;
    if (targetAll !== undefined) announcements[idx].targetAll = targetAll;
    if (targetClients !== undefined) announcements[idx].targetClients = targetClients;
    if (attachmentUrl !== undefined) announcements[idx].attachmentUrl = attachmentUrl;
    if (attachmentName !== undefined) announcements[idx].attachmentName = attachmentName;
    announcements[idx].updatedAt = new Date().toISOString();
    announcements[idx].updatedBy = req.user.name;

    await db.set('announcements', announcements);
    res.json(announcements[idx]);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete announcement (admin, managers, client portal admins)
app.delete('/api/announcements/:id', authenticateToken, requireClientPortalAdmin, async (req, res) => {
  try {
    const announcements = (await db.get('announcements')) || [];
    const filtered = announcements.filter(a => a.id !== req.params.id);
    await db.set('announcements', filtered);
    res.json({ message: 'Announcement deleted' });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Reset test data (admin only) - clears announcements
app.delete('/api/admin/reset-test-data', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { resetSubmissions, resetAnnouncements } = req.body || { resetSubmissions: true, resetAnnouncements: true };
    const results = {};

    if (resetAnnouncements !== false) {
      const oldAnnouncements = (await db.get('announcements')) || [];
      await db.set('announcements', []);
      results.announcementsCleared = oldAnnouncements.length;
    }

    console.log(`[ADMIN] Test data reset by ${req.user.email}:`, results);
    res.json({
      message: 'Test data reset successfully',
      ...results
    });
  } catch (error) {
    console.error('Error resetting test data:', error);
    res.status(500).json({ error: 'Failed to reset test data' });
  }
});

// ============== CLIENT PORTAL API (Authenticated Clients) ==============
// Get client portal data for authenticated client
app.get('/api/client-portal/data', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== config.ROLES.CLIENT) {
      return res.status(403).json({ error: 'Client access required' });
    }
    
    const projects = await getProjects();
    const users = await getUsers();
    const announcements = (await db.get('announcements')) || [];
    const activities = (await db.get('activity_log')) || [];
    
    // Get client's assigned projects (exclude unpublished/draft and completed)
    const clientProjects = projects.filter(p => 
      (req.user.assignedProjects || []).includes(p.id) &&
      (p.publishedStatus || 'published') === 'published' &&
      p.status !== 'Complete' && p.status !== 'Completed'
    );
    
    // Get tasks for each project (only client-visible ones)
    const projectsWithTasks = await Promise.all(clientProjects.map(async (project) => {
      const allTasks = await getTasks(project.id);
      const clientTasks = allTasks.filter(t => t.showToClient).map(task => ({
        ...task,
        ownerDisplayName: task.owner
          ? (users.find(u => u.email === task.owner)?.name || task.owner)
          : null
      }));

      // Calculate overall progress from ALL tasks (matches admin dashboard)
      const totalAllTasks = allTasks.length;
      const completedAllTasks = allTasks.filter(t => t.completed).length;
      const overallProgressPercent = totalAllTasks > 0 ? Math.round((completedAllTasks / totalAllTasks) * 100) : 0;

      return {
        id: project.id,
        name: project.name,
        clientName: project.clientName,
        status: project.status,
        goLiveDate: project.goLiveDate,
        hubspotRecordId: project.hubspotRecordId || null,
        hubspotRecordType: project.hubspotRecordType || 'companies',
        overallProgressPercent,
        tasks: clientTasks
      };
    }));
    
    // Filter activities to client-safe events
    // Include project-based activities AND client-specific activities
    const clientSlug = req.user.slug || '';
    const clientActivities = activities
      .filter(a => {
        // Project-based activities for assigned projects
        if ((req.user.assignedProjects || []).includes(a.projectId) &&
            ['task_completed', 'stage_completed', 'phase_completed', 'phase8_auto_updated'].includes(a.action)) {
          return true;
        }
        // Client-specific activities (by userId, slug match, or clientName match for service reports)
        const clientName = req.user.practiceName || req.user.name || '';
        const matchesClient = a.userId === req.user.id ||
          (clientSlug && (a.details?.slug === clientSlug || a.details?.clientSlug === clientSlug)) ||
          (clientName && a.details?.clientName && a.details.clientName.toLowerCase() === clientName.toLowerCase());
        if (matchesClient) {
          if (['hubspot_file_upload', 'support_ticket_submitted',
               'document_added', 'service_report_client_signed', 'service_report_created',
               'service_report_completed', 'service_report_pending_signature',
               'form_submitted'].includes(a.action)) {
            return true;
          }
        }
        // Documents shared with all clients
        if (a.action === 'document_added' && !a.details?.slug) {
          return true;
        }
        return false;
      })
      .slice(0, 20);
    
    const clientUser = users.find(u => u.id === req.user.id);
    
    res.json({
      user: {
        name: req.user.name,
        practiceName: clientUser?.practiceName || req.user.practiceName,
        isNewClient: clientUser?.isNewClient || req.user.isNewClient,
        logo: clientUser?.logo || '',
        assignedProjects: req.user.assignedProjects || [],
        hubspotCompanyId: clientUser?.hubspotCompanyId || '',
        hubspotDealId: clientUser?.hubspotDealId || '',
        hubspotContactId: clientUser?.hubspotContactId || ''
      },
      projects: projectsWithTasks,
      announcements: announcements.slice(0, 10),
      activities: clientActivities
    });
  } catch (error) {
    console.error('Client portal data error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============== GFC CLIENT PORTAL (Private Home Care) ==============
// Session 3 — TEST DATA ONLY. No real PHI until HIPAA-live (AWS/RDS track).
// Care-plan / visit / message records here are dev fixtures; the structured
// shapes mirror the v1 client schema so they can later swap to AWS RDS.

// Care-tier vocabulary — Track A/B per Intake & Packet Spec v1.1 §3.2.
// Track A (Personal Care) runs A1–A4; Track B is skilled nursing. Tier /
// Triage Level language is retired.
const CARE_TIER_LABELS = {
  'A1': 'A1 · Essential ADL',
  'A2': 'A2 · Comprehensive ADL & IADL',
  'A3': 'A3 · IADL-Forward Support',
  'A4': 'A4 · Behavioral Support & Cognitive Wellness',
  'B': 'Track B · Skilled Nursing'
};

// Map legacy 1/2/3 care-tier codes onto the Track A/B enum so stored records
// resolve without re-keying (spec v1.1 §3.2): Tier 1 / Level I → A1,
// Tier 2 / Level II → A2, Tier 3 / Level III → A4. A3 is new and has no
// legacy equivalent; any skilled-nursing designation is Track B.
const LEGACY_CARE_TIER_MAP = { '1': 'A1', '2': 'A2', '3': 'A4' };

// Resolve any stored careTier (legacy numeric or Track A/B code) to its
// canonical Track code, or null if unset/unrecognized.
const normalizeCareTier = (careTier) => {
  if (!careTier) return null;
  const code = String(careTier).toUpperCase();
  return LEGACY_CARE_TIER_MAP[code] || (CARE_TIER_LABELS[code] ? code : null);
};

// Display label for a stored careTier value (legacy or Track A/B).
const careTierLabelFor = (careTier) => {
  const code = normalizeCareTier(careTier);
  return code ? CARE_TIER_LABELS[code] : null;
};

// One-shot data migration (Session 3.3, Scope C). Read-normalization above lets
// old records resolve on the fly, but per the intake spec v1.1 §3.2 and PR #8's
// note we also rewrite the STORED value once so every record persists a Track A/B
// code. Legacy mapping: 1 → A1, 2 → A2, 3 → A4 (A3 is new, no legacy equivalent).
// Gated by CARE_TIER_MIGRATION_APPLIED (default false/unset) so it runs exactly
// once; records with an unexpected value are logged and left untouched (no loss).
const CARE_TIER_LEGACY_KEYS = Object.keys(LEGACY_CARE_TIER_MAP);           // ['1','2','3']
const CARE_TIER_KNOWN_VALUES = CARE_TIER_LEGACY_KEYS.concat(Object.keys(CARE_TIER_LABELS)); // + A1..A4,B
async function migrateCareTierEnum() {
  if (String(process.env.CARE_TIER_MIGRATION_APPLIED).toLowerCase() === 'true') {
    return { skipped: true };
  }
  const users = await getUsers();
  let rewritten = 0;
  const unexpected = [];
  users.forEach(u => {
    if (u.role !== config.ROLES.CLIENT || u.careTier == null || u.careTier === '') return;
    const raw = String(u.careTier);
    if (CARE_TIER_LEGACY_KEYS.includes(raw)) {
      u.careTier = LEGACY_CARE_TIER_MAP[raw];
      rewritten++;
    } else if (!CARE_TIER_KNOWN_VALUES.includes(raw.toUpperCase()) && !CARE_TIER_KNOWN_VALUES.includes(raw)) {
      unexpected.push({ id: u.id, careTier: u.careTier });
    }
    // Already-canonical Track A/B codes need no rewrite.
  });
  if (rewritten > 0) {
    await db.set('users', users);
    invalidateUsersCache();
  }
  unexpected.forEach(r => console.warn(`⚠️  Care-tier migration: client ${r.id} has unexpected careTier "${r.careTier}" — left untouched`));
  console.log(`🔧 Care-tier migration: rewrote ${rewritten} legacy careTier value(s) to Track A/B; ${unexpected.length} unexpected left untouched.`);
  console.log('   ↳ Migration complete. Set CARE_TIER_MIGRATION_APPLIED=true in your env so this does not re-run.');
  return { skipped: false, rewritten, unexpected: unexpected.length };
}

// Build a display-ready snapshot of the gate-relevant enrollment state.
const buildEnrollmentSnapshot = (client) => {
  const consents = client.consents || {};
  return {
    enrollmentStatus: client.enrollmentStatus || 'intake_pending',
    serviceLine: client.serviceLine || null,
    careTier: normalizeCareTier(client.careTier),
    careTierLabel: careTierLabelFor(client.careTier),
    consents,
    // Convenience flags the UI/gate can read directly
    roiFamilySigned: isConsentSatisfied(consents.roiFamily),
    monitoringOptIn: client.monitoringOptIn || false,
    // Non-PHI follow-up request from staff (Scope A "Request follow-up"), if any.
    followUp: client.enrollmentFollowUp || null
  };
};

// Resolve the authoritative current care-plan version for a client — the real
// per-patient plan's version when present, else null (no plan on file yet; real
// plans are RN-authored in Session 4 and carry their own version starting at 1).
// Used by both the care-plan GET and the co-sign route so they agree.
// Session 3.5: the prototype-derived sample plan (and its v0 sentinel) is gone —
// a client with no real plan gets `carePlan: null` and a portal empty state,
// never sample content, and can never co-sign a non-existent plan.
const resolveCarePlanVersion = (client) =>
  (client && client.carePlan && typeof client.carePlan === 'object' && client.carePlan.version != null)
    ? client.carePlan.version : null;

const gfcGreetingName = (client) => (client.preferredName || client.name || 'there').split(' ')[0];

// Display initials for a person name ("Jane D." → "JD").
const nameInitials = (name) => String(name || '')
  .split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || 'GF';

// Build the client's REAL care plan for portal display, or null when none is on
// file. Tier/label always come from the client record; co-signature state is
// keyed to the plan's actual version (versions retained).
const buildClientCarePlan = (client) => {
  const plan = (client.carePlan && typeof client.carePlan === 'object') ? client.carePlan : null;
  if (!plan) return null;
  const carePlan = {
    ...plan,
    careTier: normalizeCareTier(client.careTier),
    careTierLabel: careTierLabelFor(client.careTier)
  };
  const coSign = (client.carePlanCoSign || {})[`v${plan.version}`];
  carePlan.coSignedAt = coSign ? coSign.at : null;
  return carePlan;
};

// Visits for a client from the visit_logs KV collection (spec v2 §5.4). Nothing
// writes visit_logs until the scheduling/visit-log sessions land, so this is
// empty for now — the portal renders branded empty states, never sample visits.
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const visitDisplayRow = (v) => {
  const when = v.scheduledAt || v.date || null;
  const d = when ? new Date(when) : null;
  const valid = d && !isNaN(d.getTime());
  const today = valid && d.toDateString() === new Date().toDateString();
  return {
    id: v.id,
    day: valid ? (today ? 'Today' : DAY_NAMES[d.getDay()]) : (v.day || ''),
    time: v.time || (valid ? d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : ''),
    type: v.type || 'Visit',
    with: v.caregiverName || v.with || 'Your care team',
    duration: v.duration || null,
    highlight: !!v.highlight,
    completed: v.status === 'completed'
  };
};
const getClientVisits = async (client) => {
  const rows = ((await db.get('visit_logs')) || []).filter(v => v && v.client_id === client.id);
  const now = Date.now();
  const ts = (v) => { const d = new Date(v.scheduledAt || v.date || 0); return isNaN(d.getTime()) ? 0 : d.getTime(); };
  const upcoming = rows.filter(v => v.status !== 'completed' && ts(v) >= now)
    .sort((a, b) => ts(a) - ts(b)).slice(0, 10).map(visitDisplayRow);
  const recent = rows.filter(v => v.status === 'completed' || ts(v) < now)
    .sort((a, b) => ts(b) - ts(a)).slice(0, 10).map(visitDisplayRow);
  return { upcoming, recent };
};

// Messages for a client from the gfc_messages KV collection, scoped to the
// logged-in user's client record. Structured channels (admin/caregiver/clinical);
// the full channel matrix is Session 9 — today the client can read their real
// thread and send a basic message to admin (persisted). Never sample content.
const GFC_MESSAGE_CHANNELS = ['caregiver', 'clinical', 'admin'];
const getClientMessages = async (client) => {
  const rows = ((await db.get('gfc_messages')) || []).filter(m => m && m.client_id === client.id);
  rows.sort((a, b) => new Date(b.sentAt || 0) - new Date(a.sentAt || 0));
  return {
    channels: GFC_MESSAGE_CHANNELS,
    messages: rows.slice(0, 100).map(m => ({
      id: m.id,
      channel: m.channel || 'admin',
      direction: m.direction || 'out',           // 'in' = staff → client, 'out' = client → staff
      from: m.fromName || 'You',
      fromRole: m.fromRole || null,
      initials: nameInitials(m.fromName),
      body: m.body,
      sentAt: m.sentAt,
      unread: m.direction === 'in' && !m.readAt
    }))
  };
};

// /api/gfc/me — NOT gated. The portal calls this first to decide whether to
// render the intake flow (gate) or the unlocked portal.
app.get('/api/gfc/me', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== config.ROLES.CLIENT && req.user.role !== config.ROLES.FAMILY) {
      return res.status(403).json({ error: 'Client or family access required' });
    }
    const client = await resolveGfcClientRecord(req.user);
    if (!client) {
      return res.status(404).json({ error: 'No client record on file' });
    }
    const snapshot = buildEnrollmentSnapshot(client);
    res.json({
      role: req.user.role,
      isFamily: req.user.role === config.ROLES.FAMILY,
      name: req.user.name,
      clientName: client.preferredName || client.name,
      slug: client.slug || null,
      ...snapshot
    });
  } catch (error) {
    console.error('GFC me error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// /api/gfc/care-plan — gated. The client's REAL care plan (or null + empty
// state), their real visits, and tier from the client record. No sample data.
app.get('/api/gfc/care-plan', authenticateToken, requireEnrolledClient, async (req, res) => {
  try {
    const client = await resolveGfcClientRecord(req.user);
    if (!client) return res.status(404).json({ error: 'No client record on file' });
    const visits = await getClientVisits(client);
    res.json({
      greetingName: gfcGreetingName(client),
      carePlan: buildClientCarePlan(client),
      careTier: normalizeCareTier(client.careTier),
      careTierLabel: careTierLabelFor(client.careTier),
      upcomingVisits: visits.upcoming,
      recentVisits: visits.recent
    });
  } catch (error) {
    console.error('GFC care-plan error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// /api/gfc/visits — gated. Upcoming + recent visits from visit_logs.
app.get('/api/gfc/visits', authenticateToken, requireEnrolledClient, async (req, res) => {
  try {
    const client = await resolveGfcClientRecord(req.user);
    if (!client) return res.status(404).json({ error: 'No client record on file' });
    res.json(await getClientVisits(client));
  } catch (error) {
    console.error('GFC visits error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// /api/gfc/messages — gated. Real messages scoped to the client from the
// gfc_messages store (structured channels; full channel matrix is Session 9).
app.get('/api/gfc/messages', authenticateToken, requireEnrolledClient, async (req, res) => {
  try {
    const client = await resolveGfcClientRecord(req.user);
    if (!client) return res.status(404).json({ error: 'No client record on file' });
    res.json(await getClientMessages(client));
  } catch (error) {
    console.error('GFC messages error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/gfc/messages — gated, client only (family is read-only). Basic
// client→admin message send, persisted to the gfc_messages store. Minimal by
// design: routing/replies/notifications arrive with the Session 9 module.
app.post('/api/gfc/messages', authenticateToken, requireEnrolledClient, async (req, res) => {
  try {
    if (req.user.role !== config.ROLES.CLIENT) {
      return res.status(403).json({ error: 'Only the client may send messages' });
    }
    const body = req.body && typeof req.body.body === 'string' ? req.body.body.trim() : '';
    if (!body) return res.status(400).json({ error: 'Message text is required' });
    if (body.length > 4000) return res.status(413).json({ error: 'Message is too long (4000 characters max)' });
    const client = await resolveGfcClientRecord(req.user);
    if (!client) return res.status(404).json({ error: 'No client record on file' });

    const messages = (await db.get('gfc_messages')) || [];
    const message = {
      id: uuidv4(),
      client_id: client.id,
      channel: 'admin',
      direction: 'out',
      fromName: client.preferredName || client.name || 'Client',
      fromRole: 'Client',
      body,
      sentAt: new Date().toISOString(),
      readAt: null
    };
    messages.push(message);
    await db.set('gfc_messages', messages);
    await logActivity(req.user.id, req.user.name || req.user.email, 'gfc_message_sent', 'message', message.id, { channel: 'admin' });
    res.json({ message: 'Message sent', sent: { id: message.id, sentAt: message.sentAt } });
  } catch (error) {
    console.error('GFC message send error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// /api/gfc/documents — gated. Signed consents + client documents (Drive-backed).
app.get('/api/gfc/documents', authenticateToken, requireEnrolledClient, async (req, res) => {
  try {
    const client = await resolveGfcClientRecord(req.user);
    if (!client) return res.status(404).json({ error: 'No client record on file' });

    const consents = client.consents || {};
    const consentLabels = {
      npp: 'HIPAA Notice of Privacy Practices',
      roiFamily: 'Release of Information — Family',
      roiProvider: 'Release of Information — Provider',
      roiTransfer: 'Transfer-of-Care Authorization (record release)',
      serviceAgreement: 'Service Agreement',
      billOfRights: 'Patient Bill of Rights & Self-Determination',
      emergencyFinancial: 'Emergency Treatment & Financial Responsibility',
      crisisProtocol: 'Emergency & Crisis Protocol (911/988)',
      monitoring: 'Continuous Monitoring Opt-In',
      financialAgreement: 'Financial Agreement (PHC)',
      pcaScope: 'Personal Care Aide Scope Acknowledgment (PHC)',
      consentToTreat: 'Consent to Medical Treatment (IHPC)',
      assignmentOfBenefits: 'Assignment of Benefits (IHPC)',
      practiceNpp: 'Practice Notice of Privacy Practices (IHPC)'
    };
    const signedConsents = Object.keys(consents)
      .filter(k => consents[k] && consents[k] !== 'na')
      .map(k => ({
        key: k,
        label: consentLabels[k] || k,
        status: consents[k],
        signedAt: (client.consentMeta && client.consentMeta[k] && client.consentMeta[k].signedAt) || null,
        signerName: (client.consentMeta && client.consentMeta[k] && client.consentMeta[k].typedName) || null
      }));

    // Documents shared with this client via the existing client-documents store (Drive-backed).
    const allDocs = (await db.get('client_documents')) || [];
    const clientDocs = allDocs.filter(d => !d.slug || d.slug === client.slug);

    // The signed Enrollment Packet — served on demand (and persisted to Drive when configured).
    const hasSignedConsents = signedConsents.length > 0;
    const enrollmentPacket = hasSignedConsents ? {
      title: 'Signed enrollment packet',
      description: 'Your intake summary and signed consents',
      // Prefer the Drive copy if we persisted one; otherwise the on-demand PDF endpoint.
      url: (client.enrollmentPacket && client.enrollmentPacket.url) || '/api/gfc/enrollment-packet.pdf',
      generated: true
    } : null;

    res.json({ signedConsents, documents: clientDocs, enrollmentPacket });
  } catch (error) {
    console.error('GFC documents error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/gfc/enrollment-packet.pdf — stream the signed enrollment packet (intake
// summary + signed consents). Gated; accepts the ?token= param for downloads.
app.get('/api/gfc/enrollment-packet.pdf', authenticateToken, requireEnrolledClient, async (req, res) => {
  try {
    const client = await resolveGfcClientRecord(req.user);
    if (!client) return res.status(404).json({ error: 'No client record on file' });
    const pdf = await pdfGenerator.generateEnrollmentPacketPDF(client);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="enrollment-packet-${client.slug || client.id}.pdf"`);
    res.send(pdf);
  } catch (error) {
    console.error('GFC enrollment packet PDF error:', error);
    res.status(500).json({ error: 'Failed to generate enrollment packet' });
  }
});

// POST /api/gfc/intake/upload — attach an intake document (advance directive,
// insurance card, discharge paperwork) to HIPAA Google Drive. Client-only; runs
// during intake (before the enrollment gate), so it uses requireClientForIntake.
// Base64 upload, same contract as the ROI scan upload.
app.post('/api/gfc/intake/upload', authenticateToken, requireClientForIntake, async (req, res) => {
  try {
    const { fileName, fileDataB64 } = req.body || {};
    if (!fileName || !fileDataB64) return res.status(400).json({ error: 'fileName and fileDataB64 are required' });
    let buffer;
    try {
      const b64 = fileDataB64.startsWith('data:') ? fileDataB64.slice(fileDataB64.indexOf(',') + 1) : fileDataB64;
      buffer = Buffer.from(b64, 'base64');
    } catch (e) { return res.status(400).json({ error: 'File data is not valid base64.' }); }
    if (buffer.length > config.MAX_FILE_SIZE) return res.status(400).json({ error: 'File exceeds 10 MB limit.' });
    // Authoritative type check by content, not the client-declared mimeType.
    const sniffedType = detectFileType(buffer);
    if (!sniffedType) return res.status(400).json({ error: 'Only PDF, JPG, and PNG files are accepted.' });

    const { users, idx } = await loadClientForMutation(req.user.id);
    if (idx === -1) return res.status(404).json({ error: 'Client record not found' });
    const client = users[idx];

    // Write to Drive (best-effort; non-fatal in dev when Drive isn't configured).
    let driveUrl = null;
    const safeName = `intake_${(client.slug || client.id)}_${Date.now()}_${String(fileName).replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    try {
      const result = await googledrive.uploadServiceReportAttachment(client.name || 'Client', safeName, buffer, sniffedType);
      driveUrl = (result && (result.webViewLink || result.webContentLink)) || null;
    } catch (e) { console.error('[INTAKE] upload to Drive failed (non-fatal):', e.message); }

    // Record the upload reference on the client record (never the bytes).
    const uploadRef = { name: fileName, storedName: safeName, url: driveUrl, uploadedAt: new Date().toISOString() };
    client.intakeUploads = [...(client.intakeUploads || []), uploadRef];
    users[idx] = client;
    await db.set('users', users);
    invalidateUsersCache();
    await logActivity(req.user.id, req.user.name || req.user.email, 'intake_document_uploaded', 'client', client.id, { fileName });

    res.json({ message: 'Document uploaded', name: fileName, url: driveUrl });
  } catch (error) {
    console.error('GFC intake upload error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/gfc/care-plan/cosign — the client electronically co-signs the current
// RN-authored care-plan version. Versions are retained: we store one co-signature
// record per version key (v<version>) so a re-authored plan requires a fresh
// co-signature. Enrolled-only (the care plan is post-enrollment).
app.post('/api/gfc/care-plan/cosign', authenticateToken, requireEnrolledClient, async (req, res) => {
  try {
    const version = req.body && req.body.version;
    if (version == null) return res.status(400).json({ error: 'version is required' });
    // Drawn signature (canvas PNG data URL) — same mechanism as the provider ROI;
    // the co-signature is the legal artifact of agreement, so it is required.
    const signatureImageB64 = req.body && req.body.signatureImageB64;
    if (typeof signatureImageB64 !== 'string' || !/^data:image\/png;base64,/.test(signatureImageB64)) {
      return res.status(400).json({ error: 'A drawn signature is required' });
    }
    if (signatureImageB64.length > 600 * 1024) {
      return res.status(413).json({ error: 'Signature image is too large' });
    }
    const client = await resolveGfcClientRecord(req.user);
    if (!client) return res.status(404).json({ error: 'No client record on file' });
    // Family (read-only) may not co-sign — only the client.
    if (req.user.role !== config.ROLES.CLIENT) return res.status(403).json({ error: 'Only the client may co-sign the care plan' });

    // No real plan on file → nothing to co-sign (the sample-plan path is gone;
    // Session 3.5). The UI hides the pad in this state, so this is a backstop.
    const currentVersion = resolveCarePlanVersion(client);
    if (currentVersion == null) {
      return res.status(409).json({ error: 'No care plan is on file yet — there is nothing to co-sign.', code: 'NO_CARE_PLAN' });
    }
    // The co-signature must bind to the CURRENT plan version. If the client's UI
    // is showing a stale version (plan re-authored since load), refuse so they
    // re-review the current version before signing.
    if (String(version) !== String(currentVersion)) {
      return res.status(409).json({
        error: 'This care plan has been updated. Please review the current version before co-signing.',
        code: 'CARE_PLAN_VERSION_MISMATCH', currentVersion
      });
    }

    const { users, idx } = await loadClientForMutation(req.user.id);
    if (idx === -1) return res.status(404).json({ error: 'Client record not found' });
    const at = new Date().toISOString();
    const ipHash = roiRepo.hashIp(req.headers['x-forwarded-for'] || req.socket?.remoteAddress, JWT_SECRET);
    const signerName = users[idx].preferredName || users[idx].name || 'Client';

    // Append-only co-signature history — the legal artifact (incl. the signature
    // image) lives in a side collection, never overwritten, and kept OUT of the
    // hot-path `users` blob that every authenticated request loads.
    const coSignEvents = (await db.get('care_plan_cosign_events')) || [];
    coSignEvents.push({ id: uuidv4(), client_id: client.id, version: currentVersion, at, name: signerName, ipHash, signatureImage: signatureImageB64 });
    await db.set('care_plan_cosign_events', coSignEvents);

    // Lightweight "latest co-sign per version" pointer on the client (NO image)
    // drives the care-plan GET's coSignedAt.
    users[idx].carePlanCoSign = {
      ...(users[idx].carePlanCoSign || {}),
      [`v${currentVersion}`]: { at, name: signerName, ipHash }
    };
    await db.set('users', users);
    invalidateUsersCache();
    await logActivity(req.user.id, req.user.name || req.user.email, 'care_plan_cosigned', 'care_plan', `v${currentVersion}`, {});
    res.json({ message: 'Care plan co-signed', version: currentVersion, coSignedAt: at });
  } catch (error) {
    console.error('GFC care-plan cosign error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============== GFC ENROLLMENT INTAKE (Stage 2) ==============
// The gate sends an intake_pending client here. These routes are NOT behind the
// enrollment gate (requireEnrolledClient would block a pending client) — instead
// requireClientForIntake scopes them to the client themselves.
// TEST DATA ONLY. No real PHI until HIPAA-live (AWS/RDS track).

// Content-sniff an uploaded file by magic bytes, so validation can't be bypassed
// by omitting/faking the client-declared mimeType. Returns the canonical mime or
// null when the bytes are not one of the accepted types (PDF / JPEG / PNG).
const detectFileType = (buf) => {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return null;
  if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return 'application/pdf';   // %PDF
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png';         // \x89PNG
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';                            // JPEG SOI
  return null;
};

// Derive age in whole years from a YYYY-MM-DD DOB (single source of truth — §3).
const deriveAge = (dob) => {
  if (!dob) return null;
  const d = new Date(dob);
  if (isNaN(d)) return null;
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
  return age >= 0 && age < 130 ? age : null;
};

// Normalize a priorProviders array to the client schema shape (§ Client Care
// Profile Schema). Feeds the Transfer-of-Care ROI prefill (Session 3.4).
const normalizePriorProviders = (arr, defaultAddedFrom) => {
  if (!Array.isArray(arr)) return [];
  return arr
    .map(p => p || {})
    .filter(p => (p.name || '').trim())
    .map(p => ({
      name: (p.name || '').trim(),
      dept: (p.dept || '').trim(),
      address: (p.address || '').trim(),
      phone: (p.phone || '').trim(),
      fax: (p.fax || '').trim(),
      roleLabel: ['pcp', 'specialist', 'hospital', 'other'].includes(p.roleLabel) ? p.roleLabel : 'other',
      addedFrom: ['intake_prefill', 'manual', 'roi_form'].includes(p.addedFrom) ? p.addedFrom : (defaultAddedFrom || 'manual'),
      createdAt: p.createdAt || new Date().toISOString()
    }));
};

// Derive prior-provider entries from the intake wizard's Medical-team fields
// (PCP name/practice/phone, up to 2 specialists, preferred hospital) — mirrors
// the legacy WordPress intake's field set (PCP Name, PCP Practice, PCP Phone,
// Specialist 1[+Phone], Specialist 2, Preferred Hospital), which is how the
// legacy ROI form's prefillForm() built its provider list.
const deriveProvidersFromMedicalTeam = (medicalTeam) => {
  const mt = medicalTeam || {};
  const out = [];
  const pcpName = (mt.pcpName || '').trim();
  const pcpPractice = (mt.pcpPractice || '').trim();
  const pcpPhone = (mt.pcpPhone || '').trim();
  if (pcpName || pcpPractice) {
    out.push({ name: pcpName || pcpPractice, dept: (pcpName && pcpPractice) ? pcpPractice : '', phone: pcpPhone, roleLabel: 'pcp' });
  }
  const spec1Name = (mt.specialist1Name || '').trim();
  if (spec1Name) out.push({ name: spec1Name, phone: (mt.specialist1Phone || '').trim(), roleLabel: 'specialist' });
  const spec2Name = (mt.specialist2Name || '').trim();
  if (spec2Name) out.push({ name: spec2Name, phone: '', roleLabel: 'specialist' }); // phone not captured in intake — patient fills in on the ROI form
  const hospital = (mt.preferredHospital || '').trim();
  if (hospital) out.push({ name: hospital, roleLabel: 'hospital' });
  return out;
};

// ── Intake → schema enum normalization ─────────────────────────────
// The wizard captures human-readable option strings; the matching (Session 8)
// and billing (Track D) engines compare on the schema's canonical enum CODES.
// These tables translate the wizard labels to codes when mirroring onto the
// client profile. For CLOSED enums an unmapped label is dropped (never stored
// as a label); the open-ended `conditions` enum falls back to a deterministic
// slug so every diagnosis persists as a code. The raw labels remain untouched
// in the intake blob for form round-trip/display.
const ENUM = {
  gender: { 'Female': 'female', 'Male': 'male', 'Non-binary': 'nonbinary', 'Prefer not to say': null },
  conditions: {
    "Dementia / Alzheimer's": 'dementia', "Parkinson's disease": 'parkinsons', 'Stroke / TIA': 'post_stroke',
    'COPD / respiratory': 'copd', 'Heart failure / cardiac': 'cardiac', 'Diabetes': 'diabetes'
  },
  skilledTasks: {
    'Wound care': 'wound_care', 'Injections': 'injections', 'Catheter care': 'catheter', 'Ostomy care': 'ostomy',
    'Tube feeding': 'g_tube', 'Oxygen management': 'oxygen', 'Suctioning': 'suctioning', 'Tracheostomy care': 'trach',
    'Blood glucose monitoring': 'blood_glucose', 'Medication administration': 'med_administration'
  },
  adlLevel: { 'Independent': 'independent', 'Needs verbal cues': 'cues', 'Needs physical assistance': 'assist', 'Fully dependent': 'dependent' },
  adlToileting: { 'Independent': 'independent', 'Needs verbal cues': 'cues', 'Needs physical assistance': 'assist', 'Incontinent — needs full care': 'dependent' },
  adlTransfers: { 'Independent': 'independent', 'Standby assist': 'cues', 'Hands-on assist': 'assist', 'Two-person assist / mechanical lift': 'dependent' },
  adlAmbulation: { 'Independent': 'independent', 'Uses walker / cane': 'cues', 'Needs physical assistance': 'assist', 'Wheelchair — self-propels': 'assist', 'Wheelchair — pushed': 'dependent', 'Bed-bound': 'dependent' },
  fallRisk: { 'Low': 'low', 'Moderate': 'moderate', 'High': 'high' },
  cognitiveStatus: { 'Intact': 'intact', 'Mild impairment': 'mild', 'Moderate dementia': 'moderate', 'Severe dementia': 'severe', 'Mental health diagnosis affecting cognition': null },
  dementiaStage: { 'Early / mild': 'early', 'Moderate': 'moderate', 'Late / severe': 'late', 'Unknown / undiagnosed': 'undiagnosed' },
  behavioral: { 'Wandering': 'wandering', 'Agitation / aggression': 'aggression', 'Sundowning': 'sundowning', 'Resistance to care': 'resistance_to_care', 'Self-harm risk': 'self_harm_risk' },
  homeSafety: { 'Smokers in home': 'smokers', 'Pets in home': 'pets', 'Firearms in home': 'firearms', 'Hoarding or clutter': 'hoarding', 'Pest issues': 'pests', 'Stairs required': 'stairs', 'Oxygen tanks': 'oxygen_tanks' },
  temperament: { 'Quiet and reserved': 'quiet', 'Warm and chatty': 'warm', 'Likes structure and routine': 'likes_routine', 'Prefers independence': 'prefers_independence', 'Can get anxious': 'anxious', 'Resistant to care': 'resistant_to_care' },
  advanceDirective: { 'Yes — DNR in place': 'dnr', 'Yes — advance directive / living will': 'living_will', 'Yes — healthcare proxy / POA': 'healthcare_poa', 'No': 'none', 'Unknown': 'unknown' },
  twoPersonAssist: { 'No': 'no', 'Sometimes': 'sometimes', 'Yes routinely': 'routinely' },
  // 'Dual eligible' = Medicare + Medicaid → combination; 'Commercial' has no schema
  // code (the granular commercial block on payer still captures the detail).
  payerType: { 'Private pay': 'private_pay', 'LTC insurance': 'ltc_insurance', 'Medicaid waiver': 'medicaid_waiver', 'VA': 'va', 'Medicare Part B': 'medicare_b', 'Dual eligible': 'combination', 'Commercial': null, 'Combination': 'combination' },
  transferNeed: { 'Independent': 'independent', 'Standby': 'standby', 'One-person assist': 'one_person', 'Two-person assist': 'two_person', 'Mechanical lift': 'mechanical_lift' }
};
// Each ADL sub-field uses its own option list → its own map.
const ADL_MAP_BY_KEY = { bathing: 'adlLevel', dressing: 'adlLevel', grooming: 'adlLevel', eating: 'adlLevel', toileting: 'adlToileting', transfers: 'adlTransfers', ambulation: 'adlAmbulation' };

const slugCode = (s) => String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
// Scalar label → enum code; undefined when unmapped/null so the caller skips it.
const codeFrom = (mapName, label) => {
  if (label == null || label === '') return undefined;
  const m = ENUM[mapName] || {};
  return Object.prototype.hasOwnProperty.call(m, label) ? (m[label] || undefined) : undefined;
};
// Array of labels → array of codes, dropping unmapped/null (closed enums).
const codesFrom = (mapName, labels) => {
  if (!Array.isArray(labels)) return undefined;
  const m = ENUM[mapName] || {};
  return labels.map(l => m[l]).filter(Boolean);
};
// conditions is open-ended: explicit code when known, else a deterministic slug.
const normalizeConditions = (labels) => Array.isArray(labels)
  ? labels.map(l => (ENUM.conditions[l] || slugCode(l))).filter(Boolean)
  : undefined;
// Per-ADL normalization: map each sub-field's level to its code (drop unmapped).
const normalizeAdl = (adl) => {
  if (!adl || typeof adl !== 'object') return undefined;
  const out = {};
  for (const [k, v] of Object.entries(adl)) {
    const code = ADL_MAP_BY_KEY[k] ? codeFrom(ADL_MAP_BY_KEY[k], v) : undefined;
    if (code) out[k] = code;
  }
  return out;
};
// genderPreference → schema object { value: female|male|none, strength }.
// Test 'female' first — the substring "male" also matches inside "female".
const parseGenderPref = (s) => {
  if (!s || typeof s !== 'string') return undefined;
  return { value: /female/i.test(s) ? 'female' : /male/i.test(s) ? 'male' : 'none', strength: /strong/i.test(s) ? 'strong' : 'preferred' };
};
// interests → array of tags (schema shape) from the wizard's free-text field.
const tokenizeInterests = (v) => {
  if (Array.isArray(v)) return v.map(x => String(x).trim()).filter(Boolean);
  if (typeof v === 'string') return v.split(/[,\n;]+/).map(s => s.trim()).filter(Boolean);
  return undefined;
};

// Map the structured intake into the v1 Client Care Profile schema shape on the
// client record, so the matching/billing engines read normalized fields off the
// profile rather than the raw intake blob. Only sets a field when the intake
// actually carries it, so partial/draft saves don't wipe existing profile data.
const mirrorIntakeToClientProfile = (client, intake, meds, priorProviders) => {
  const set = (k, v) => { if (v !== undefined) client[k] = v; };
  const nonEmptyArr = (v) => Array.isArray(v) ? v : undefined;

  if (intake.dob) set('dob', intake.dob);
  if (Array.isArray(meds)) set('medications', meds);
  set('priorProviders', priorProviders);

  // Identity / demographics
  if (intake.clientFirst || intake.clientLast) {
    const full = `${intake.clientFirst || ''} ${intake.clientLast || ''}`.trim();
    if (full) set('legalName', full);
  }
  set('preferredName', intake.preferredName || client.preferredName);
  set('gender', codeFrom('gender', intake.gender));            // → female|male|nonbinary
  set('primaryLanguage', intake.primaryLanguage);

  // Clinical context (light — full clinical → OpenEMR). Coded diagnoses/tasks
  // are normalized to schema enum codes so Session 8 matching compares exactly.
  set('conditions', normalizeConditions(intake.conditions));   // coded diagnoses (matching)
  set('allergies', intake.allergies);
  if (intake.advanceDirective) {
    // Normalize the directive status enum; keep the rest of the object as-is.
    const adCode = codeFrom('advanceDirective', intake.advanceDirective.status);
    set('advanceDirective', adCode ? { ...intake.advanceDirective, status: adCode } : intake.advanceDirective);
  }
  if (intake.medicalTeam) set('medicalTeam', intake.medicalTeam);
  // ROI-family sharing detail (legacy intake parity): named authorized recipients
  // + any sharing restrictions the family specified for the family-ROI consent.
  if (intake.roiFamilyDetail && typeof intake.roiFamilyDetail === 'object') {
    set('roiFamilyAuthorization', {
      authorizedRecipients: (intake.roiFamilyDetail.authorized || '').trim(),
      restrictions: (intake.roiFamilyDetail.restrictions || '').trim()
    });
  }

  // Function / safety (hard filters for matching) — all normalized to codes.
  set('adl', normalizeAdl(intake.adl));
  set('homeSafetyFlags', codesFrom('homeSafety', intake.homeSafetyFlags));
  set('behavioralFlags', codesFrom('behavioral', intake.behavioralFlags));
  set('skilledTasksNeeded', codesFrom('skilledTasks', intake.skilledTasksNeeded));
  set('fallRisk', codeFrom('fallRisk', intake.fallRisk));
  set('cognitiveStatus', codeFrom('cognitiveStatus', intake.cognitiveStatus));
  set('dementiaStage', codeFrom('dementiaStage', intake.dementiaStage));
  set('twoPersonAssistRequired', codeFrom('twoPersonAssist', intake.twoPersonAssist));
  set('transferNeed', codeFrom('transferNeed', intake.transferNeed));  // → liftCapacity hard filter
  if (intake.schedule && typeof intake.schedule === 'object') set('schedule', intake.schedule);

  // Caregiver-matching preferences
  const m = intake.matching || {};
  set('temperament', codesFrom('temperament', m.personality));
  set('genderPreference', parseGenderPref(m.genderPreference));  // → { value, strength }
  if (m.languagePreference) set('languagePreference', m.languagePreference);
  if (m.caregiverExperience) set('caregiverExperienceRequired', m.caregiverExperience);
  set('interests', tokenizeInterests(m.interests));              // → string[] tags

  // Payer — billing. Prefer an explicit payer object; otherwise assemble a
  // normalized summary from the structured payer blocks the wizard captured.
  if (intake.payer) {
    set('payer', intake.payer);
  } else if (intake.payerType || intake.insuranceTypes || intake.medicare || intake.medicaid || intake.commercial || intake.ltc) {
    client.payer = {
      ...(client.payer || {}),
      type: codeFrom('payerType', intake.payerType) || (client.payer && client.payer.type) || null,
      insuranceTypes: nonEmptyArr(intake.insuranceTypes) || (client.payer && client.payer.insuranceTypes) || [],
      medicare: intake.medicare || (client.payer && client.payer.medicare) || {},
      medicaid: intake.medicaid || (client.payer && client.payer.medicaid) || {},
      commercial: intake.commercial || (client.payer && client.payer.commercial) || {},
      ltc: intake.ltc || (client.payer && client.payer.ltc) || {},
      insuranceIds: Array.isArray(intake.insuranceIds) ? intake.insuranceIds.filter(x => x && (x.carrier || x.memberId)) : ((client.payer && client.payer.insuranceIds) || []),
      ssnLast4: intake.ssnLast4 || (client.payer && client.payer.ssnLast4) || null,
      paymentMethod: intake.paymentMethod || (client.payer && client.payer.paymentMethod) || null,
      billingContact: intake.billingContact || (client.payer && client.payer.billingContact) || null
    };
  }
};

// Helper to load the fresh client user record + its index for mutation.
const loadClientForMutation = async (userId) => {
  const users = await getUsers();
  const idx = users.findIndex(u => u.id === userId && u.role === config.ROLES.CLIENT);
  return { users, idx };
};

// GET /api/gfc/intake — return the saved intake draft + consent state so the
// flow can resume, plus the branched consent definitions for the service line.
app.get('/api/gfc/intake', authenticateToken, requireClientForIntake, async (req, res) => {
  try {
    const users = await getUsers();
    const client = users.find(u => u.id === req.user.id) || {};
    const serviceLine = client.serviceLine || (client.intake && client.intake.serviceLine) || 'PHC';
    res.json({
      enrollmentStatus: client.enrollmentStatus || 'intake_pending',
      serviceLine,
      intake: client.intake || {},
      consents: client.consents || {},
      consentMeta: client.consentMeta || {},
      consentDefs: consentDefsForServiceLine(serviceLine),
      requiredConsents: requiredConsentTypes(serviceLine)
    });
  } catch (error) {
    console.error('GFC get intake error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/gfc/intake — save/merge the intake data (draft-friendly).
// Structured per the v1 client schema so it can later swap to AWS RDS.
app.post('/api/gfc/intake', authenticateToken, requireClientForIntake, async (req, res) => {
  try {
    const { intake, serviceLine } = req.body || {};
    if (!intake || typeof intake !== 'object') {
      return res.status(400).json({ error: 'intake object is required' });
    }
    const { users, idx } = await loadClientForMutation(req.user.id);
    if (idx === -1) return res.status(404).json({ error: 'Client record not found' });

    // Normalize structured medication rows (name/dose/route/frequency/prescriber/pharmacy).
    const meds = Array.isArray(intake.medications) ? intake.medications
      .filter(m => m && (m.name || '').trim())
      .map(m => ({
        name: (m.name || '').trim(),
        dose: (m.dose || '').trim(),
        route: (m.route || '').trim(),
        frequency: (m.frequency || '').trim(),
        prescriber: (m.prescriber || '').trim(),
        pharmacy: (m.pharmacy || '').trim()
      })) : [];

    // DOB collected once → derive age (never stored as a separate input, §3/§4).
    const dob = intake.dob || (users[idx].intake && users[idx].intake.dob) || null;

    // Prior providers feed the Transfer-of-Care ROI form (Session 3.4), derived
    // from the intake wizard's Medical-team fields (PCP, up to 2 specialists,
    // preferred hospital) — same source fields the legacy WordPress form used
    // to seed its ROI provider list. Entries added manually or from a signed
    // ROI (addedFrom 'manual' | 'roi_form') are preserved untouched; the
    // 'intake_prefill' entries are recomputed fresh from the current
    // medical-team fields on every save so edits stay in sync.
    const existingProviders = Array.isArray(users[idx].priorProviders) ? users[idx].priorProviders : [];
    const preservedProviders = existingProviders.filter(p => p.addedFrom === 'manual' || p.addedFrom === 'roi_form');
    const explicitPrefill = Array.isArray(intake.priorProviders) ? normalizePriorProviders(intake.priorProviders, 'intake_prefill') : [];
    const derivedPrefill = deriveProvidersFromMedicalTeam(intake.medicalTeam).map(p => ({ ...p, addedFrom: 'intake_prefill' }));
    const seenNames = new Set(preservedProviders.map(p => (p.name || '').toLowerCase()));
    const mergedPrefill = [];
    [...explicitPrefill, ...derivedPrefill].forEach(p => {
      const key = (p.name || '').toLowerCase();
      if (!key || seenNames.has(key)) return;
      seenNames.add(key);
      mergedPrefill.push(p);
    });
    const priorProviders = normalizePriorProviders([...preservedProviders, ...mergedPrefill], 'intake_prefill');

    const merged = {
      ...(users[idx].intake || {}),
      ...intake,
      medications: meds,
      priorProviders,
      dob,
      age: deriveAge(dob),
      updatedAt: new Date().toISOString()
    };
    users[idx].intake = merged;
    if (serviceLine) users[idx].serviceLine = serviceLine;
    // ── Schema mirror ──────────────────────────────────────────────
    // The intake wizard captures every legacy WordPress field in its native
    // structure; here we map the matching/billing-relevant pieces up onto the
    // client profile in the v1 Client Care Profile schema shape, so the future
    // matching (Session 8) and billing (Track D) engines read them directly off
    // the client record instead of digging through the raw intake blob.
    mirrorIntakeToClientProfile(users[idx], merged, meds, priorProviders);

    await db.set('users', users);
    invalidateUsersCache();
    res.json({ message: 'Intake saved', intake: merged, age: merged.age });
  } catch (error) {
    console.error('GFC save intake error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/gfc/consents — e-sign a single consent (typed name + ack checkbox).
// Stores a consent STATUS PER TYPE + server timestamp + IP (§4.3). The portal
// gate reads consents.roiFamily.
app.post('/api/gfc/consents', authenticateToken, requireClientForIntake, async (req, res) => {
  try {
    const { type, typedName, acknowledged, optOut } = req.body || {};
    if (!type) return res.status(400).json({ error: 'consent type is required' });

    const { users, idx } = await loadClientForMutation(req.user.id);
    if (idx === -1) return res.status(404).json({ error: 'Client record not found' });

    const serviceLine = users[idx].serviceLine || 'PHC';
    const def = consentDefsForServiceLine(serviceLine).find(d => d.type === type);
    if (!def) return res.status(400).json({ error: `Consent "${type}" does not apply to this service line` });

    // The monitoring opt-in is inactive (Track C) — record the choice, do not require a signature.
    if (def.inactive) {
      users[idx].consents = { ...(users[idx].consents || {}), [type]: optOut ? 'na' : 'signed' };
      users[idx].monitoringOptIn = !optOut;
    } else {
      if (!typedName || !typedName.trim()) return res.status(400).json({ error: 'Typed signature name is required' });
      if (!acknowledged) return res.status(400).json({ error: 'You must check the acknowledgment box to sign' });
      users[idx].consents = { ...(users[idx].consents || {}), [type]: 'signed' };
      users[idx].consentMeta = {
        ...(users[idx].consentMeta || {}),
        [type]: {
          typedName: typedName.trim(),
          acknowledged: true,
          signedAt: new Date().toISOString(),
          // Store only a salted hash of the signer IP (consistent with the ROI /
          // care-plan paths) — never the raw address, which is retained PII.
          ipHash: roiRepo.hashIp(req.headers['x-forwarded-for'] || req.socket?.remoteAddress, JWT_SECRET),
          // Working-draft consent text version — bump when language is revised.
          version: 'draft-1'
        }
      };
    }

    await db.set('users', users);
    invalidateUsersCache();
    await logActivity(req.user.id, req.user.name || req.user.email, 'consent_signed', 'consent', type, { serviceLine });
    res.json({ message: 'Consent recorded', type, status: users[idx].consents[type] });
  } catch (error) {
    console.error('GFC consent error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Confirmation email on enrollment — NON-PHI by design. Per the compliance
// decision, we never email clinical detail or signed-consent content; the email
// is only a receipt that directs the client to the portal, where the signed
// documents live (Documents tab). Safe to send pre-BAA.
async function sendEnrollmentConfirmation(client, portalUrl, extraRecipient) {
  const to = [client.email, extraRecipient].filter(Boolean);
  if (!to.length) return;
  const firstName = (client.preferredName || client.name || 'there').split(' ')[0];
  const subject = 'Your Godwins Family Care enrollment is complete';
  const text = `Hi ${firstName},\n\nWe've received your enrollment with Godwins Family Care. Your care plan, signed consents, and documents are now available in your secure portal.\n\nView them here: ${portalUrl}\n\nFor your privacy, we don't include any health or consent details in email — everything lives in your portal.\n\n— Godwins Family Care`;
  const htmlBody = `<div style="font-family:'DM Sans',Arial,sans-serif;color:#1B2A33;max-width:520px">
    <h2 style="color:#033D50;font-weight:600">Enrollment complete</h2>
    <p>Hi ${firstName},</p>
    <p>We've received your enrollment with <strong>Godwins Family Care</strong>. Your care plan, signed consents, and documents are now available in your secure portal.</p>
    <p><a href="${portalUrl}" style="display:inline-block;background:#C9A44A;color:#033D50;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:10px">Open your portal</a></p>
    <p style="font-size:13px;color:#4F6470">For your privacy, we don't include any health or consent details in email — everything lives in your portal.</p>
    <p style="font-size:13px;color:#4F6470">— Godwins Family Care</p>
  </div>`;
  try {
    await sendEmail(to, subject, text, { htmlBody });
  } catch (e) {
    console.error('Enrollment confirmation email failed (non-fatal):', e.message);
  }
}

// Best-effort: render the Enrollment Packet PDF and persist it to HIPAA Google
// Drive so it's referenced from the Documents tab. No-op (and non-fatal) when
// Drive isn't configured in dev — the packet is still served on demand via
// GET /api/gfc/enrollment-packet.pdf.
async function persistEnrollmentPacketToDrive(client) {
  try {
    const ok = await googledrive.testConnection().then(r => r && r.success).catch(() => false);
    if (!ok) return null;
    const pdf = await pdfGenerator.generateEnrollmentPacketPDF(client);
    const fileName = `Enrollment-Packet-${(client.slug || client.id)}-${Date.now()}.pdf`;
    const result = await googledrive.uploadServiceReportPDF(client.name || 'Client', fileName, pdf);
    return result && (result.webViewLink || result.url) ? { driveFileId: result.id || null, url: result.webViewLink || result.url, generatedAt: new Date().toISOString() } : null;
  } catch (e) {
    console.error('Enrollment packet Drive persist failed (non-fatal):', e.message);
    return null;
  }
}

// POST /api/gfc/intake/submit — validate required consents + intake, then flip
// intake_pending → intake_complete and unlock the portal.
app.post('/api/gfc/intake/submit', authenticateToken, requireClientForIntake, async (req, res) => {
  try {
    const { users, idx } = await loadClientForMutation(req.user.id);
    if (idx === -1) return res.status(404).json({ error: 'Client record not found' });

    const client = users[idx];
    const serviceLine = client.serviceLine || 'PHC';
    const consents = client.consents || {};

    // Required consents for the service line must all be satisfied
    // (signed in-app OR signed_offline — Scope B1).
    const required = requiredConsentTypes(serviceLine);
    const missingConsents = required.filter(t => !isConsentSatisfied(consents[t]));
    if (missingConsents.length) {
      return res.status(400).json({
        error: 'Required consents are not all signed yet.',
        code: 'CONSENTS_INCOMPLETE',
        missingConsents
      });
    }

    // Minimal required intake fields (DOB once + a primary contact).
    const intake = client.intake || {};
    const missingFields = [];
    if (!intake.dob) missingFields.push('dob');
    if (!(intake.primaryContact && intake.primaryContact.name)) missingFields.push('primaryContact.name');
    if (missingFields.length) {
      return res.status(400).json({ error: 'Required intake details are missing.', code: 'INTAKE_INCOMPLETE', missingFields });
    }

    // Flip the gate. (Already-complete/enrolled stays as-is.)
    if (client.enrollmentStatus === 'intake_pending' || !client.enrollmentStatus) {
      client.enrollmentStatus = 'intake_complete';
    }
    client.intake = { ...intake, submittedAt: new Date().toISOString(), age: deriveAge(intake.dob) };
    users[idx] = client;
    await db.set('users', users);
    invalidateUsersCache();
    await logActivity(req.user.id, req.user.name || req.user.email, 'intake_completed', 'enrollment', client.id, { serviceLine });

    // Fire-and-forget side effects (non-blocking, non-PHI email + best-effort Drive copy).
    const portalUrl = `${req.protocol}://${req.get('host')}/portal/${client.slug || ''}`;
    sendEnrollmentConfirmation(client, portalUrl, intake.primaryContact && intake.primaryContact.email)
      .catch(e => console.error('Confirmation email error (non-fatal):', e.message));
    persistEnrollmentPacketToDrive(client).then(async (ref) => {
      if (!ref) return;
      try {
        const fresh = await getUsers();
        const i = fresh.findIndex(u => u.id === client.id);
        if (i !== -1) { fresh[i].enrollmentPacket = ref; await db.set('users', fresh); invalidateUsersCache(); }
      } catch (e) { console.error('Packet ref save failed (non-fatal):', e.message); }
    }).catch(() => {});

    res.json({ message: 'Enrollment complete', enrollmentStatus: client.enrollmentStatus });
  } catch (error) {
    console.error('GFC intake submit error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============== GFC STAFF ENROLLMENT-SUBMISSIONS VIEW (Session 3.3, Scope A) ==============
// Staff area for reviewing Stage-2 intake submissions. Role-gated at the API
// layer (default-deny) — not just in the UI. Admin + clinical (user) + case
// manager can view and review; Approve enrollment and Add offline-onboarded
// patient are admin-only (enforced with requireAdmin on those two routes).
// TEST DATA ONLY. No real PHI until HIPAA-live.

const ENROLLMENT_STAFF_ROLES = [config.ROLES.ADMIN, config.ROLES.USER, config.ROLES.CASE_MANAGER];
const requireEnrollmentStaff = (req, res, next) => {
  const role = req.user.role;
  if (ENROLLMENT_STAFF_ROLES.includes(role) || req.user.isManager || req.user.hasClientPortalAdminAccess) {
    return next();
  }
  return res.status(403).json({ error: 'Staff access required for the enrollment view.', code: 'ENROLLMENT_STAFF_ONLY' });
};

// Required structured intake fields for a complete submission (intake spec §2A).
// Each reads from client.intake first, then falls back to the mirrored top-level
// client fields the intake flow copies up.
const ENROLLMENT_REQUIRED_FIELDS = [
  { key: 'name',             label: 'Name',              present: (c, i) => !!(c.name || (i.firstName && i.lastName)) },
  { key: 'dob',              label: 'Date of birth',     present: (c, i) => !!(i.dob || c.dob) },
  { key: 'gender',           label: 'Gender',            present: (c, i) => !!i.gender },
  { key: 'address',          label: 'Address',           present: (c, i) => !!(i.address && (i.address.line1 || i.address.city)) },
  { key: 'phone',            label: 'Phone',             present: (c, i) => !!(i.phone || c.phone) },
  { key: 'primaryLanguage',  label: 'Primary language',  present: (c, i) => !!i.primaryLanguage },
  { key: 'serviceLine',      label: 'Service line',      present: (c, i) => !!(c.serviceLine || i.serviceLine) },
  { key: 'careTier',         label: 'Care tier',         present: (c) => !!normalizeCareTier(c.careTier) },
  { key: 'primaryContact',   label: 'Primary contact',   present: (c, i) => !!(i.primaryContact && i.primaryContact.name) },
  { key: 'emergencyContact', label: 'Emergency contact', present: (c, i) => Array.isArray(i.emergencyContacts) && i.emergencyContacts.some(e => e && e.name) }
];

// Intake completion = (required consents satisfied + required fields present) / total.
const computeEnrollmentCompletion = (client) => {
  const serviceLine = client.serviceLine || (client.intake && client.intake.serviceLine) || 'PHC';
  const intake = client.intake || {};
  const consents = client.consents || {};
  const requiredConsents = requiredConsentTypes(serviceLine);
  const safe = (fn) => { try { return !!fn(); } catch { return false; } };

  const missingConsents = requiredConsents.filter(t => !isConsentSatisfied(consents[t]));
  const missingFields = ENROLLMENT_REQUIRED_FIELDS.filter(f => !safe(() => f.present(client, intake)));
  const total = requiredConsents.length + ENROLLMENT_REQUIRED_FIELDS.length;
  const satisfied = total - missingConsents.length - missingFields.length;
  return {
    total, satisfied,
    pct: total ? Math.round((satisfied / total) * 100) : 0,
    missingConsents,
    missingFieldKeys: missingFields.map(f => f.key),
    missingConsentLabels: missingConsents.map(t => (GFC_CONSENT_DEFS.find(x => x.type === t) || {}).title || t),
    missingFieldLabels: missingFields.map(f => f.label)
  };
};

// Coarse review state used by the list filter chips.
//   enrolled | needs_followup | ready_for_review | intake_pending
const enrollmentReviewState = (client) => {
  const status = client.enrollmentStatus || 'intake_pending';
  if (status === 'enrolled') return 'enrolled';
  if (client.reviewStatus === 'needs_followup') return 'needs_followup';
  if (status === 'intake_complete') return 'ready_for_review';
  return 'intake_pending';
};

const enrollmentDisplayName = (client) => {
  const i = client.intake || {};
  return client.name || [i.firstName, i.lastName].filter(Boolean).join(' ') || client.email || 'Unnamed client';
};

const enrollmentListRow = (client) => {
  const comp = computeEnrollmentCompletion(client);
  const i = client.intake || {};
  const rawSource = client.source || 'in_app';
  return {
    id: client.id,
    name: enrollmentDisplayName(client),
    dob: i.dob || client.dob || null,
    serviceLine: client.serviceLine || i.serviceLine || null,
    careTier: normalizeCareTier(client.careTier),
    careTierLabel: careTierLabelFor(client.careTier),
    enrollmentStatus: client.enrollmentStatus || 'intake_pending',
    reviewState: enrollmentReviewState(client),
    completionPct: comp.pct,
    completion: { satisfied: comp.satisfied, total: comp.total },
    submittedAt: i.submittedAt || null,
    source: /offline/i.test(rawSource) ? 'offline' : 'in_app',
    sourceRaw: rawSource,
    reviewedAt: (client.enrollmentReview && client.enrollmentReview.reviewedAt) || null,
    needsFollowUp: client.reviewStatus === 'needs_followup'
  };
};

const enrollmentDetail = (client) => {
  const serviceLine = client.serviceLine || (client.intake && client.intake.serviceLine) || 'PHC';
  const intake = client.intake || {};
  const consents = client.consents || {};
  const consentMeta = client.consentMeta || {};
  const defs = consentDefsForServiceLine(serviceLine);
  const comp = computeEnrollmentCompletion(client);
  return {
    ...enrollmentListRow(client),
    email: client.email || null,
    serviceLineResolved: serviceLine,
    age: intake.age != null ? intake.age : deriveAge(intake.dob || client.dob),
    intake,
    consents: defs.map(d => {
      const status = consents[d.type] || 'pending';
      return {
        type: d.type, title: d.title, required: !!d.required, inactive: !!d.inactive,
        status,
        satisfied: isConsentSatisfied(status),
        // Provenance badge for the detail view (in_app | signed_offline).
        provenance: status === 'signed_offline' ? 'signed_offline' : (status === 'signed' ? 'in_app' : null),
        signedAt: (consentMeta[d.type] && consentMeta[d.type].signedAt) || null,
        meta: consentMeta[d.type] || null
      };
    }),
    medications: Array.isArray(intake.medications) ? intake.medications : (Array.isArray(client.medications) ? client.medications : []),
    payer: intake.payer || client.payer || null,
    careTeam: client.careTeam || null,
    files: {
      advanceDirective: intake.advanceDirectiveUrl || null,
      insuranceCard: intake.insuranceCardUrl || null,
      offlinePacketUrls: Array.isArray(client.offlinePacketDriveUrls) ? client.offlinePacketDriveUrls : [],
      enrollmentPacket: client.enrollmentPacket || null
    },
    review: client.enrollmentReview || null,
    followUp: client.enrollmentFollowUp || null,
    missing: { consents: comp.missingConsentLabels, fields: comp.missingFieldLabels }
  };
};

// GET /api/gfc/admin/enrollment/list — paginated, filterable, searchable.
app.get('/api/gfc/admin/enrollment/list', authenticateToken, requireEnrollmentStaff, async (req, res) => {
  try {
    const users = await getUsers();
    let clients = users.filter(u => u.role === config.ROLES.CLIENT);

    // Search first (name or DOB), so the chip counts reflect the search scope.
    const query = String(req.query.q || '').trim().toLowerCase();
    if (query) {
      clients = clients.filter(c => {
        const i = c.intake || {};
        const name = enrollmentDisplayName(c).toLowerCase();
        const dob = String(i.dob || c.dob || '').toLowerCase();
        return name.includes(query) || dob.includes(query);
      });
    }

    // Chip counts across the searched set.
    const counts = { all: clients.length, intake_pending: 0, ready_for_review: 0, enrolled: 0, needs_followup: 0 };
    clients.forEach(c => { counts[enrollmentReviewState(c)]++; });

    // Apply the active filter chip.
    const f = String(req.query.filter || 'all').toLowerCase();
    const filterMap = { pending: 'intake_pending', intake_pending: 'intake_pending', ready: 'ready_for_review', ready_for_review: 'ready_for_review', enrolled: 'enrolled', followup: 'needs_followup', needs_followup: 'needs_followup' };
    if (filterMap[f]) clients = clients.filter(c => enrollmentReviewState(c) === filterMap[f]);

    let rows = clients.map(enrollmentListRow);

    // Sort.
    const s = String(req.query.sort || 'submitted_desc').toLowerCase();
    rows.sort((a, b) => {
      if (s === 'name') return (a.name || '').localeCompare(b.name || '');
      if (s === 'service_line' || s === 'serviceline') return (a.serviceLine || '').localeCompare(b.serviceLine || '') || (a.name || '').localeCompare(b.name || '');
      const av = a.submittedAt || '', bv = b.submittedAt || '';
      if (!av && !bv) return (a.name || '').localeCompare(b.name || '');
      if (!av) return 1;
      if (!bv) return -1;
      return s === 'submitted_asc' ? av.localeCompare(bv) : bv.localeCompare(av);
    });

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 25));
    const total = rows.length;
    const start = (page - 1) * pageSize;
    res.json({
      clients: rows.slice(start, start + pageSize),
      page, pageSize, total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
      counts
    });
  } catch (error) {
    console.error('GFC enrollment list error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/gfc/admin/enrollment/:clientId — full submission detail.
app.get('/api/gfc/admin/enrollment/:clientId', authenticateToken, requireEnrollmentStaff, async (req, res) => {
  try {
    const users = await getUsers();
    const client = users.find(u => u.id === req.params.clientId && u.role === config.ROLES.CLIENT);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    res.json({ client: enrollmentDetail(client) });
  } catch (error) {
    console.error('GFC enrollment detail error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/gfc/admin/enrollment/:clientId/review — record a review (no state change).
app.post('/api/gfc/admin/enrollment/:clientId/review', authenticateToken, requireEnrollmentStaff, async (req, res) => {
  try {
    const users = await getUsers();
    const idx = users.findIndex(u => u.id === req.params.clientId && u.role === config.ROLES.CLIENT);
    if (idx === -1) return res.status(404).json({ error: 'Client not found' });
    users[idx].enrollmentReview = {
      reviewedAt: new Date().toISOString(),
      reviewerId: req.user.id,
      reviewerName: req.user.name || req.user.email
    };
    await db.set('users', users);
    invalidateUsersCache();
    await logActivity(req.user.id, req.user.name || req.user.email, 'enrollment_reviewed', 'enrollment', users[idx].id, {});
    res.json({ message: 'Marked as reviewed', review: users[idx].enrollmentReview });
  } catch (error) {
    console.error('GFC enrollment review error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Non-PHI follow-up notice — lists ONLY the outstanding item labels, never any
// clinical or consent content. Safe to email pre-BAA (mirrors the enrollment
// confirmation pattern).
async function sendFollowUpNotification(client, itemLabels) {
  try {
    const to = [client.email, (client.intake && client.intake.primaryContact && client.intake.primaryContact.email)].filter(Boolean);
    if (!to.length) return;
    const firstName = enrollmentDisplayName(client).split(' ')[0];
    const list = (itemLabels || []).map(l => `• ${l}`).join('\n');
    const subject = 'Action needed to complete your Godwins Family Care enrollment';
    const text = `Hi ${firstName},\n\nA few items still need your attention before we can finish your enrollment:\n\n${list}\n\nPlease sign in to your secure portal to complete them. For your privacy, no health details are included in this email.\n\n— Godwins Family Care`;
    await sendEmail(to, subject, text, {});
  } catch (e) {
    console.error('Follow-up notification failed (non-fatal):', e.message);
  }
}

// POST /api/gfc/admin/enrollment/:clientId/follow-up — request patient action.
// body: { items: [key1, key2, ...] }  (keys are consent types or field keys)
app.post('/api/gfc/admin/enrollment/:clientId/follow-up', authenticateToken, requireEnrollmentStaff, async (req, res) => {
  try {
    const { items } = req.body || {};
    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ error: 'At least one follow-up item is required.' });
    }
    const users = await getUsers();
    const idx = users.findIndex(u => u.id === req.params.clientId && u.role === config.ROLES.CLIENT);
    if (idx === -1) return res.status(404).json({ error: 'Client not found' });
    const client = users[idx];

    // Resolve item keys to friendly, non-PHI labels (consent titles / field labels).
    const labelFor = (key) => {
      const consent = GFC_CONSENT_DEFS.find(d => d.type === key);
      if (consent) return consent.title;
      const field = ENROLLMENT_REQUIRED_FIELDS.find(fd => fd.key === key);
      if (field) return field.label;
      return key;
    };
    const itemLabels = items.map(labelFor);

    client.reviewStatus = 'needs_followup';
    client.enrollmentFollowUp = {
      items,
      itemLabels,
      requestedAt: new Date().toISOString(),
      requestedById: req.user.id,
      requestedByName: req.user.name || req.user.email
    };
    users[idx] = client;
    await db.set('users', users);
    invalidateUsersCache();
    await logActivity(req.user.id, req.user.name || req.user.email, 'enrollment_follow_up_requested', 'enrollment', client.id, { items });
    sendFollowUpNotification(client, itemLabels).catch(() => {});
    res.json({ message: 'Follow-up requested', followUp: client.enrollmentFollowUp });
  } catch (error) {
    console.error('GFC enrollment follow-up error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/gfc/admin/enrollment/:clientId/approve — flip to enrolled (admin only).
// Blocks with 409 + specific missing items if any required consent/field is absent.
app.post('/api/gfc/admin/enrollment/:clientId/approve', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const users = await getUsers();
    const idx = users.findIndex(u => u.id === req.params.clientId && u.role === config.ROLES.CLIENT);
    if (idx === -1) return res.status(404).json({ error: 'Client not found' });
    const client = users[idx];

    const comp = computeEnrollmentCompletion(client);
    if (comp.missingConsentLabels.length || comp.missingFieldLabels.length) {
      return res.status(409).json({
        error: 'Cannot approve — required items are missing.',
        code: 'ENROLLMENT_INCOMPLETE',
        missingConsents: comp.missingConsentLabels,
        missingFields: comp.missingFieldLabels
      });
    }

    client.enrollmentStatus = 'enrolled';
    if (client.reviewStatus === 'needs_followup') client.reviewStatus = null;
    client.enrollmentApproval = {
      approvedAt: new Date().toISOString(),
      approvedById: req.user.id,
      approvedByName: req.user.name || req.user.email
    };
    users[idx] = client;
    await db.set('users', users);
    invalidateUsersCache();
    await logActivity(req.user.id, req.user.name || req.user.email, 'enrollment_approved', 'enrollment', client.id, {});
    res.json({ message: 'Enrollment approved', enrollmentStatus: client.enrollmentStatus });
  } catch (error) {
    console.error('GFC enrollment approve error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/gfc/admin/enrollment/offline — Add offline-onboarded patient (admin
// only, Scope B2). Multipart: `files` (paper-packet scans) + `payload` (JSON of
// the structured entry + consent checklist). Creates a client with
// source=legacy_offline and enrollmentStatus=intake_complete.
app.post('/api/gfc/admin/enrollment/offline', authenticateToken, requireAdmin, uploadLimiter, upload.array('files', 20), async (req, res) => {
  try {
    let payload = {};
    try { payload = req.body && req.body.payload ? JSON.parse(req.body.payload) : (req.body || {}); }
    catch (e) { return res.status(400).json({ error: 'Invalid payload JSON' }); }

    const d = payload || {};
    if (!d.firstName || !d.lastName) return res.status(400).json({ error: 'firstName and lastName are required' });
    if (!d.dob) return res.status(400).json({ error: 'dob is required' });
    const serviceLine = (d.serviceLine || 'PHC').toUpperCase();
    const careTier = normalizeCareTier(d.careTier);

    const users = await getUsers();

    // Optional real portal login; otherwise a placeholder account (no usable login).
    let email = (d.email || '').toLowerCase().trim();
    if (email && users.find(u => u.email && u.email.toLowerCase() === email)) {
      return res.status(400).json({ error: 'A user already exists with this email' });
    }
    const clientId = uuidv4();
    if (!email) email = `offline+${clientId}@placeholder.local`;
    const randomPw = uuidv4() + uuidv4();
    const hashedPassword = await bcrypt.hash(randomPw, config.BCRYPT_SALT_ROUNDS);

    // Upload paper-packet scans to Drive (best-effort — no-op if Drive unconfigured in dev).
    const offlinePacketDriveUrls = [];
    const driveOk = await googledrive.testConnection().then(r => r && r.connected).catch(() => false);
    if (driveOk && Array.isArray(req.files)) {
      for (const file of req.files) {
        try {
          const result = await googledrive.uploadOfflinePacketFile(
            `${d.firstName} ${d.lastName}`.trim(), file.originalname, file.buffer, file.mimetype
          );
          const url = result && (result.webViewLink || result.webContentLink);
          if (url) offlinePacketDriveUrls.push(url);
        } catch (e) {
          console.error('Offline packet upload failed (non-fatal):', e.message);
        }
      }
    }

    // Consent checklist → statuses. checklist: { [type]: { status, signedAt } }
    const checklist = d.consents || {};
    const applicable = consentDefsForServiceLine(serviceLine);
    const consents = {};
    const consentMeta = {};
    const nowIso = new Date().toISOString();
    applicable.forEach(def => {
      const entry = checklist[def.type] || {};
      const choice = entry.status || 'pending'; // signed_offline | pending | na
      if (choice === 'signed_offline') {
        consents[def.type] = 'signed_offline';
        consentMeta[def.type] = { signedAt: entry.signedAt || nowIso, provenance: 'signed_offline', recordedBy: req.user.id, recordedAt: nowIso };
      } else if (choice === 'na') {
        consents[def.type] = 'na';
      } else {
        consents[def.type] = 'pending';
      }
    });

    const meds = Array.isArray(d.medications) ? d.medications.filter(m => m && (m.name || '').trim()).map(m => ({
      name: (m.name || '').trim(), dose: (m.dose || '').trim(), route: (m.route || '').trim(),
      frequency: (m.frequency || '').trim(), prescriber: (m.prescriber || '').trim(), pharmacy: (m.pharmacy || '').trim()
    })) : [];

    const intake = {
      firstName: d.firstName, lastName: d.lastName, preferredName: d.preferredName || '',
      dob: d.dob, age: deriveAge(d.dob), gender: d.gender || '',
      address: d.address || { line1: '', city: '', state: 'GA', zip: '' },
      phone: d.phone || '', primaryLanguage: d.primaryLanguage || '', livesWith: d.livesWith || '',
      serviceLine, careTier,
      primaryContact: d.primaryContact || {},
      emergencyContacts: Array.isArray(d.emergencyContacts) ? d.emergencyContacts : [],
      allergies: d.allergies || '',
      medications: meds,
      payer: d.payer || {},
      submittedAt: nowIso,
      source: 'legacy_offline'
    };

    const newClient = {
      id: clientId,
      email,
      name: `${d.firstName} ${d.lastName}`.trim(),
      preferredName: d.preferredName || '',
      password: hashedPassword,
      role: config.ROLES.CLIENT,
      source: 'legacy_offline',
      enrollmentStatus: 'intake_complete',
      serviceLine,
      careTier,
      dob: d.dob,
      phone: d.phone || '',
      medications: meds,
      payer: d.payer || {},
      consents,
      consentMeta,
      offlinePacketDriveUrls,
      careTeam: d.careTeam || { assignedFNPs: [], assignedCaseManager: null, primaryCaregiver: null, backupCaregiver: null },
      intake,
      accountStatus: 'active',
      requirePasswordChange: true,
      hasPortalLogin: !!d.email,
      createdAt: nowIso
    };
    users.push(newClient);
    await db.set('users', users);
    invalidateUsersCache();

    // Audit trail — one entry for creation, plus one per signed-offline consent.
    await logActivity(req.user.id, req.user.name || req.user.email, 'offline_patient_created', 'enrollment', clientId, {
      source: 'legacy_offline', serviceLine, careTier, packetFiles: offlinePacketDriveUrls.length
    });
    for (const [type, status] of Object.entries(consents)) {
      if (status === 'signed_offline') {
        await logActivity(req.user.id, req.user.name || req.user.email, 'consent_recorded_offline', 'consent', type, { clientId, signedAt: consentMeta[type] && consentMeta[type].signedAt });
      }
    }

    res.json({ message: 'Offline patient created', clientId, offlinePacketDriveUrls, enrollmentStatus: newClient.enrollmentStatus });
  } catch (error) {
    console.error('GFC offline onboarding error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============== TRANSFER-OF-CARE PROVIDER ROI (Session 3.4) ==============
// A fifth ROI type: client authorization for GFC to request medical records
// from one or more prior providers. One signing event → one consent_event, one
// consent_provider_authorizations row per provider, one consent_records_categories
// row per checked category, and one generated PDF per provider. This ROI does
// NOT gate the portal (unlike roiFamily). 42 CFR Part 2 protected categories are
// gated at the data-access layer (roiRepository.getRequestableRecordCategories).
// Runs in parallel with the legacy WordPress + GAS system (PARALLEL_LEGACY_SYNC).
// TEST DATA ONLY until HIPAA-live.

// Shared side-effect dispatcher: legacy sheet log + admin email (PDFs attached)
// + patient/submitter confirmation (no PDFs). All best-effort and non-fatal;
// gated by config.PARALLEL_LEGACY_SYNC. NEVER attaches PHI to patient email.
async function dispatchRoiNotifications({ client, event, fileNames, fileUrls, pdfAttachments, submitterEmail }) {
  if (!config.PARALLEL_LEGACY_SYNC) return;
  const clientName = client.preferredName || client.name || 'Client';
  // Sheet key: the client's legacy intake token if present, else a stable portal key.
  const sheetKey = client.legacyIntakeToken || client.slug || client.id;
  try {
    await legacySync.logRoiToSheet(
      config.ROI_LEGACY_SHEET_ID, config.ROI_LEGACY_SHEET_TAB, sheetKey,
      Array.isArray(fileNames) ? fileNames.join(' | ') : fileNames,
      Array.isArray(fileUrls) ? fileUrls.join(' | ') : fileUrls
    );
  } catch (e) { console.error('[ROI] legacy sheet log failed (non-fatal):', e.message); }

  // Admin email — one message, all generated PDFs attached (internal recipient).
  try {
    const adminHtml = legacySync.buildAdminEmailHtml(clientName, sheetKey, fileNames, fileUrls);
    const providerCount = Array.isArray(fileNames) ? fileNames.length : 1;
    // Keep the patient name OUT of the subject line (subjects are the most
    // widely-logged/previewed part of an email and the mailer is not yet on a
    // BAA — see the Resend→Workspace/SES migration item). The name and PDFs
    // remain in the internal-only body/attachments.
    await sendEmail(
      config.ROI_ADMIN_EMAIL,
      `Provider ROI Submitted${providerCount > 1 ? ` (${providerCount} authorizations)` : ''}`,
      `A Transfer-of-Care authorization was received for ${clientName}. See attached PDF(s).`,
      { htmlBody: adminHtml, attachments: (pdfAttachments || []) }
    );
  } catch (e) { console.error('[ROI] admin email failed (non-fatal):', e.message); }

  // Patient + submitter confirmation — plain receipt, NEVER any PDF/PHI.
  try {
    const recipients = [client.email, submitterEmail, (client.intake && client.intake.primaryContact && client.intake.primaryContact.email)]
      .filter(Boolean)
      .filter((v, i, a) => a.indexOf(v) === i);
    if (recipients.length) {
      await sendEmail(
        recipients,
        'We received your authorization form — Godwins Family Care',
        `Hi,\n\nYour signed Authorization to Obtain Medical Records was received. Our care team will use it to request your records and will be in touch with next steps.\n\n— Godwins Family Care`,
        { htmlBody: legacySync.buildPatientEmailHtml(clientName) }
      );
    }
  } catch (e) { console.error('[ROI] patient email failed (non-fatal):', e.message); }
}

// GET /api/gfc/transfer-roi — prefill data for the flow: patient identity from
// intake, prior-provider cards, prior signed events (summary), category catalog.
app.get('/api/gfc/transfer-roi', authenticateToken, requireClientForIntake, async (req, res) => {
  try {
    const client = await resolveGfcClientRecord(req.user);
    if (!client) return res.status(404).json({ error: 'No client record on file' });
    const intake = client.intake || {};
    const pc = intake.primaryContact || {};
    const patient = {
      patientName: client.preferredName || client.name || `${intake.firstName || ''} ${intake.lastName || ''}`.trim(),
      patientDOB: intake.dob || '',
      patientAddress: intake.address || client.address || '',
      patientPhone: intake.phone || pc.phone || ''
    };
    const events = (await roiStore.listConsentEventsByClient(client.id)).map(e => ({
      id: e.id, signed_at: e.signed_at, source: e.source,
      includes_protected_info: e.includes_protected_info, revoked_at: e.revoked_at
    }));
    res.json({
      patient,
      priorProviders: Array.isArray(client.priorProviders) ? client.priorProviders : (intake.priorProviders || []),
      status: (client.consents || {}).roiTransfer || 'pending',
      events,
      recordCategories: roiRepo.RECORD_CATEGORIES,
      categoryLabels: pdfGenerator.ROI_CATEGORY_LABELS
    });
  } catch (error) {
    console.error('GFC transfer-roi get error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/gfc/prior-providers — edit the client's prior-provider list
// independently of any ROI signing event (§ Client Care Profile Schema).
app.put('/api/gfc/prior-providers', authenticateToken, requireClientForIntake, async (req, res) => {
  try {
    const { priorProviders } = req.body || {};
    if (!Array.isArray(priorProviders)) return res.status(400).json({ error: 'priorProviders array is required' });
    const { users, idx } = await loadClientForMutation(req.user.id);
    if (idx === -1) return res.status(404).json({ error: 'Client record not found' });
    const normalized = normalizePriorProviders(priorProviders, 'manual');
    users[idx].priorProviders = normalized;
    users[idx].intake = { ...(users[idx].intake || {}), priorProviders: normalized };
    await db.set('users', users);
    invalidateUsersCache();
    res.json({ message: 'Prior providers saved', priorProviders: normalized });
  } catch (error) {
    console.error('GFC prior-providers save error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/gfc/transfer-roi/upload — Screen 2A: client uploads an already-signed
// scan. Creates a consent_event (source=portal_upload) with NO provider auth rows
// (admin classifies the scan later), writes the file to Drive, updates the
// rollup status, and runs the parallel legacy sync.
app.post('/api/gfc/transfer-roi/upload', authenticateToken, requireClientForIntake, async (req, res) => {
  try {
    const { fileName, fileDataB64 } = req.body || {};
    if (!fileName || !fileDataB64) return res.status(400).json({ error: 'fileName and fileDataB64 are required' });
    let buffer;
    try {
      const b64 = fileDataB64.startsWith('data:') ? fileDataB64.slice(fileDataB64.indexOf(',') + 1) : fileDataB64;
      buffer = Buffer.from(b64, 'base64');
    } catch (e) { return res.status(400).json({ error: 'File data is not valid base64.' }); }
    if (buffer.length > config.MAX_FILE_SIZE) return res.status(400).json({ error: 'File exceeds 10 MB limit.' });
    // Authoritative type check by content, not the client-declared mimeType.
    const sniffedType = detectFileType(buffer);
    if (!sniffedType) return res.status(400).json({ error: 'Only PDF, JPG, and PNG files are accepted.' });

    const { users, idx } = await loadClientForMutation(req.user.id);
    if (idx === -1) return res.status(404).json({ error: 'Client record not found' });
    const client = users[idx];

    const ipHash = roiRepo.hashIp(req.headers['x-forwarded-for'] || req.socket?.remoteAddress, JWT_SECRET);
    const event = await roiStore.insertConsentEvent({
      client_id: client.id,
      printed_name: client.preferredName || client.name || 'Client',
      signer_ip_hash: ipHash,
      includes_protected_info: false, // unknown from a scan; classified later
      source: roiRepo.SOURCE.UPLOAD
    });

    // Write the uploaded scan to Drive (best-effort; non-fatal in dev).
    let driveUrl = null, storedName = fileName;
    try {
      const safeName = `ROI_upload_${(client.slug || client.id)}_${Date.now()}_${String(fileName).replace(/[^a-zA-Z0-9._-]/g, '_')}`;
      const result = await googledrive.uploadProviderROIFile(config.ROI_DRIVE_FOLDER_NAME, safeName, buffer, sniffedType);
      driveUrl = result && (result.webViewLink || result.webContentLink) || null;
      storedName = safeName;
    } catch (e) { console.error('[ROI] upload to Drive failed (non-fatal):', e.message); }

    // Rollup status on the client profile.
    client.consents = { ...(client.consents || {}), roiTransfer: 'signed' };
    users[idx] = client;
    await db.set('users', users);
    invalidateUsersCache();
    await logActivity(req.user.id, req.user.name || req.user.email, 'roi_transfer_uploaded', 'consent_event', event.id, { source: 'portal_upload' });

    // Parallel legacy sync (no PDF attachment — this is the client's own scan).
    dispatchRoiNotifications({ client, event, fileNames: storedName, fileUrls: driveUrl || '', pdfAttachments: [] })
      .catch(e => console.error('[ROI] dispatch failed (non-fatal):', e.message));

    res.json({ message: 'Authorization uploaded', eventId: event.id, driveUrl });
  } catch (error) {
    console.error('GFC transfer-roi upload error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/gfc/transfer-roi/submit — Screen 2B: the online form. One signing
// event authorizes multiple providers; one PDF is generated per provider.
// Validates the 45 CFR 164.508 required elements server-side before saving.
app.post('/api/gfc/transfer-roi/submit', authenticateToken, requireClientForIntake, async (req, res) => {
  try {
    const b = req.body || {};
    const providers = Array.isArray(b.providers)
      ? b.providers.filter(p => p && (p.name || p.provider_name || '').trim())
      : [];
    if (providers.length === 0) return res.status(400).json({ error: 'Add at least one provider before submitting.', field: 'providers' });

    // Collect checked standard categories (+ Other text).
    const cat = b.categories || {};
    const checkedCategories = roiRepo.RECORD_CATEGORIES.filter(k => cat[k]);
    const signedAt = new Date().toISOString();

    // Server-side 45 CFR 164.508 element validation.
    const validation = roiRepo.validateAuthorizationElements({
      categories: checkedCategories,
      purpose_treatment: b.purposeTreatment !== false,
      purpose_other_text: b.purposeOtherText,
      expiration_date: b.expDate,
      signature_image_b64: b.signatureImageB64,
      printed_name: b.printedName,
      signed_at: signedAt
    });
    if (!validation.ok) {
      return res.status(400).json({ error: 'Some required fields are missing or invalid.', code: 'ROI_508_INCOMPLETE', fieldErrors: validation.errors });
    }

    const { users, idx } = await loadClientForMutation(req.user.id);
    if (idx === -1) return res.status(404).json({ error: 'Client record not found' });
    const client = users[idx];

    const ipHash = roiRepo.hashIp(req.headers['x-forwarded-for'] || req.socket?.remoteAddress, JWT_SECRET);

    // Parent consent_event. includes_protected_info defaults FALSE and is only
    // true when the client explicitly opted in (42 CFR Part 2).
    const event = await roiStore.insertConsentEvent({
      client_id: client.id,
      signed_at: signedAt,
      signature_image_b64: b.signatureImageB64,
      printed_name: b.printedName,
      relationship_authority: b.relationship,
      signer_ip_hash: ipHash,
      expiration_date: b.expDate || null,
      expiration_event: b.expEvent || null,
      purpose_treatment: b.purposeTreatment !== false,
      purpose_other_text: b.purposeOtherText,
      includes_protected_info: b.includesProtected === true,
      source: roiRepo.SOURCE.ONLINE_FORM
    });

    // Category rows (one per checked category).
    await roiStore.insertRecordCategories(event.id, checkedCategories, cat.otherText);

    // Provider authorization rows (one per provider card).
    const providerInputs = providers.map(p => ({
      provider_name: p.name || p.provider_name, dept: p.dept, address: p.address, phone: p.phone, fax: p.fax
    }));
    const authRows = await roiStore.insertProviderAuthorizations(event.id, providerInputs);

    // Generate one PDF per provider, upload to Drive, record the URL.
    const lastName = (client.name || client.preferredName || 'Client').trim().split(/\s+/).pop() || 'Client';
    const dateStr = signedAt.slice(0, 10).replace(/-/g, '');
    const fileNames = [], fileUrls = [], pdfAttachments = [];
    for (let i = 0; i < authRows.length; i++) {
      const row = authRows[i];
      const provClean = (row.provider_name || 'Provider').replace(/[^a-zA-Z0-9 ]/g, '').replace(/\s+/g, '_').substring(0, 30);
      const seq = authRows.length > 1 ? `_${i + 1}` : '';
      const fileName = `ROI_${lastName}_${provClean}_${dateStr}${seq}.pdf`;
      let pdfBuffer = null;
      try {
        pdfBuffer = await pdfGenerator.generateProviderROIPDF({
          patientName: b.patientName, patientDOB: b.patientDOB, patientAddress: b.patientAddress, patientPhone: b.patientPhone,
          provider: { name: row.provider_name, dept: row.dept, address: row.address, phone: row.phone, fax: row.fax },
          categories: { ...cat },
          includesProtected: event.includes_protected_info,
          purposeTreatment: event.purpose_treatment,
          purposeOther: !!b.purposeOther, purposeOtherText: b.purposeOtherText,
          expDate: b.expDate, expEvent: b.expEvent,
          signatureImageB64: b.signatureImageB64, signedDate: new Date(signedAt).toLocaleDateString('en-US'),
          printedName: b.printedName, relationship: b.relationship
        });
      } catch (e) { console.error('[ROI] PDF generation failed for provider:', row.provider_name, e.message); }

      let driveUrl = null;
      if (pdfBuffer) {
        pdfAttachments.push({ filename: fileName, content: pdfBuffer });
        try {
          const result = await googledrive.uploadProviderROIFile(config.ROI_DRIVE_FOLDER_NAME, fileName, pdfBuffer, 'application/pdf');
          driveUrl = result && (result.webViewLink || result.webContentLink) || null;
        } catch (e) { console.error('[ROI] provider PDF Drive upload failed (non-fatal):', e.message); }
      }
      await roiStore.updateProviderAuthorizationPdf(row.id, { driveUrl, fileName });
      fileNames.push(fileName);
      fileUrls.push(driveUrl || '');
    }

    // Merge any new providers into the client's prior-provider list (roi_form).
    const merged = normalizePriorProviders([
      ...(Array.isArray(client.priorProviders) ? client.priorProviders : []),
      ...providerInputs.map(p => ({ name: p.provider_name, dept: p.dept, address: p.address, phone: p.phone, fax: p.fax, addedFrom: 'roi_form' }))
    ], 'roi_form');
    // De-dupe by name (keep first occurrence).
    const seen = new Set();
    client.priorProviders = merged.filter(p => { const k = p.name.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
    client.intake = { ...(client.intake || {}), priorProviders: client.priorProviders };

    // Rollup status.
    client.consents = { ...(client.consents || {}), roiTransfer: 'signed' };
    users[idx] = client;
    await db.set('users', users);
    invalidateUsersCache();
    await logActivity(req.user.id, req.user.name || req.user.email, 'roi_transfer_signed', 'consent_event', event.id, {
      source: 'portal_online_form', providerCount: authRows.length, includesProtected: event.includes_protected_info
    });

    // Parallel legacy sync: sheet + admin email (PDFs attached) + confirmations.
    dispatchRoiNotifications({ client, event, fileNames, fileUrls, pdfAttachments, submitterEmail: b.submitterEmail })
      .catch(e => console.error('[ROI] dispatch failed (non-fatal):', e.message));

    res.json({ message: 'Authorization submitted', eventId: event.id, providerCount: authRows.length, files: fileNames });
  } catch (error) {
    console.error('GFC transfer-roi submit error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get portal settings (admin configurable HubSpot embeds)
app.get('/api/portal-settings', async (req, res) => {
  try {
    const settings = (await db.get('portal_settings')) || {
      filesFormEmbed: '',
      supportUrl: 'https://thrive365labs-49020024.hs-sites.com/support',
      supportFormId: '089d904f-4acb-4ff7-8c61-53ee99e12345',
      hubspotPortalId: '49020024'
    };
    res.json(settings);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Update portal settings (admin only)
app.put('/api/portal-settings', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { filesFormEmbed, supportUrl, supportFormId, hubspotPortalId } = req.body;
    const settings = {
      filesFormEmbed: filesFormEmbed || '',
      supportUrl: supportUrl || 'https://thrive365labs-49020024.hs-sites.com/support',
      supportFormId: supportFormId || '089d904f-4acb-4ff7-8c61-53ee99e12345',
      hubspotPortalId: hubspotPortalId || '49020024',
      updatedAt: new Date().toISOString(),
      updatedBy: req.user.name
    };
    await db.set('portal_settings', settings);
    res.json(settings);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ============== CLIENT DOCUMENTS ==============
// Get documents for a specific client (by slug or for all if admin)
app.get('/api/client-documents', authenticateToken, async (req, res) => {
  try {
    const documents = (await db.get('client_documents')) || [];

    if (req.user.role === config.ROLES.CLIENT) {
      // Clients see documents for their slug OR documents shared with all clients
      const clientDocs = documents.filter(d =>
        d.active && (d.slug === req.user.slug || d.shareWithAll === true)
      );
      return res.json(clientDocs);
    }

    // Admins see all documents
    res.json(documents);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Get documents for a specific slug (client portal)
app.get('/api/client-documents/:slug', authenticateToken, async (req, res) => {
  try {
    // Clients can only access their own slug's documents
    if (req.user.role === config.ROLES.CLIENT && req.user.slug !== req.params.slug) {
      return res.status(403).json({ error: 'Access denied' });
    }
    const documents = (await db.get('client_documents')) || [];
    // Include documents for specific slug OR documents shared with all clients
    const clientDocs = documents.filter(d =>
      d.active && (d.slug === req.params.slug || d.shareWithAll === true)
    );

    // Enrich service report docs with their current status
    const serviceReportIds = clientDocs.filter(d => d.serviceReportId).map(d => d.serviceReportId);
    if (serviceReportIds.length > 0) {
      const serviceReports = (await db.get('service_reports')) || [];
      clientDocs.forEach(doc => {
        if (doc.serviceReportId) {
          const report = serviceReports.find(r => r.id === doc.serviceReportId);
          if (report) {
            doc.reportStatus = report.status;
          }
        }
      });
    }

    res.json(clientDocs);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Add a document for a client (admin only)
app.post('/api/client-documents', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { slug, title, description, url, category, shareWithAll } = req.body;
    // slug is not required if shareWithAll is true
    if (!title || !url) {
      return res.status(400).json({ error: 'Missing required fields (title, url)' });
    }
    if (!shareWithAll && !slug) {
      return res.status(400).json({ error: 'Either slug or shareWithAll must be provided' });
    }

    const documents = (await db.get('client_documents')) || [];
    const newDoc = {
      id: require('uuid').v4(),
      slug: shareWithAll ? null : slug,
      title,
      description: description || '',
      url,
      category: category || 'General',
      shareWithAll: shareWithAll || false,
      active: true,
      createdAt: new Date().toISOString(),
      createdBy: req.user.name
    };

    documents.push(newDoc);
    await db.set('client_documents', documents);

    // Log activity
    await logActivity(null, req.user.name, 'document_added', 'client_document', newDoc.id, {
      documentTitle: title,
      slug: shareWithAll ? null : slug,
      clientSlug: shareWithAll ? 'ALL CLIENTS' : slug
    });

    res.json(newDoc);
  } catch (error) {
    console.error('Add document error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update a document (admin only)
app.put('/api/client-documents/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const documents = (await db.get('client_documents')) || [];
    const idx = documents.findIndex(d => d.id === req.params.id);
    if (idx === -1) {
      return res.status(404).json({ error: 'Document not found' });
    }

    const { title, description, url, category, active, shareWithAll, slug } = req.body;
    documents[idx] = {
      ...documents[idx],
      title: title || documents[idx].title,
      description: description !== undefined ? description : documents[idx].description,
      url: url || documents[idx].url,
      category: category || documents[idx].category,
      active: active !== undefined ? active : documents[idx].active,
      shareWithAll: shareWithAll !== undefined ? shareWithAll : documents[idx].shareWithAll,
      slug: shareWithAll ? null : (slug !== undefined ? slug : documents[idx].slug),
      updatedAt: new Date().toISOString(),
      updatedBy: req.user.name
    };

    await db.set('client_documents', documents);
    res.json(documents[idx]);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete a document (admin only) - by ID only
app.delete('/api/client-documents/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const documents = (await db.get('client_documents')) || [];
    const filtered = documents.filter(d => d.id !== req.params.id);
    await db.set('client_documents', filtered);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete a document (admin only) - by slug and docId (for admin portal)
app.delete('/api/client-documents/:slug/:docId', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const documents = (await db.get('client_documents')) || [];
    const filtered = documents.filter(d => d.id !== req.params.docId);
    await db.set('client_documents', filtered);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Upload file as client document (admin only) - stores file and creates document entry
// Use slug="all" to upload to all clients (shareWithAll)
app.post('/api/client-documents/:slug/upload', authenticateToken, requireAdmin, uploadLimiter, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file provided' });
    }

    const { title, description, category } = req.body;
    const slugParam = req.params.slug;
    const isAllClients = slugParam === 'all';

    // Create a unique filename
    const ext = require('path').extname(req.file.originalname);
    const uniqueName = `${uuidv4()}${ext}`;
    const uploadsDir = require('path').join(__dirname, 'uploads', 'documents');

    // Ensure uploads directory exists
    const fs = require('fs');
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }

    // Save the file
    const filePath = require('path').join(uploadsDir, uniqueName);
    fs.writeFileSync(filePath, req.file.buffer);

    // Create the document entry with a URL pointing to the file
    const documents = (await db.get('client_documents')) || [];
    const newDoc = {
      id: uuidv4(),
      slug: isAllClients ? null : slugParam,
      shareWithAll: isAllClients,
      title: title || req.file.originalname,
      description: description || '',
      category: category || 'General',
      url: `/uploads/documents/${uniqueName}`,
      originalFilename: req.file.originalname,
      isUploadedFile: true,
      active: true,
      createdAt: new Date().toISOString(),
      createdBy: req.user.name
    };

    documents.push(newDoc);
    await db.set('client_documents', documents);

    // Log activity
    await logActivity(null, req.user.name, 'document_added', 'client_document', newDoc.id, {
      documentTitle: newDoc.title,
      slug: isAllClients ? null : slugParam,
      clientSlug: isAllClients ? 'ALL CLIENTS' : slugParam
    });

    res.json(newDoc);
  } catch (error) {
    console.error('Document upload error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============== HUBSPOT FILE UPLOAD ==============
// Upload file to HubSpot and attach to a deal record (admin only)
app.post('/api/hubspot/upload-to-deal', authenticateToken, requireAdmin, uploadLimiter, upload.single('file'), async (req, res) => {
  try {
    const { dealId, noteText, category } = req.body;
    
    if (!req.file) {
      return res.status(400).json({ error: 'No file provided' });
    }
    
    if (!dealId) {
      return res.status(400).json({ error: 'Deal ID is required' });
    }
    
    const fileName = req.file.originalname;
    const fileContent = req.file.buffer.toString('base64');
    const contentType = req.file.mimetype;
    
    const customNote = noteText || `File uploaded: ${fileName}${category ? ` (Category: ${category})` : ''}`;
    const recordType = req.body.recordType || 'companies';
    
    const result = await hubspot.uploadFileAndAttachToRecord(
      dealId,
      fileContent,
      fileName,
      customNote,
      { isBase64: true, recordType: recordType }
    );
    
    const activityLog = (await db.get('activity_log')) || [];
    activityLog.unshift({
      id: uuidv4(),
      action: 'file_uploaded_hubspot',
      dealId: dealId,
      fileName: fileName,
      category: category || 'General',
      timestamp: new Date().toISOString(),
      user: req.user.name,
      details: `File "${fileName}" uploaded to HubSpot deal ${dealId}`
    });
    if (activityLog.length > config.ACTIVITY_LOG_MAX_ENTRIES) activityLog.length = config.ACTIVITY_LOG_MAX_ENTRIES;
    await db.set('activity_log', activityLog);
    
    res.json({ 
      success: true, 
      fileId: result.fileId,
      noteId: result.noteId,
      message: `File "${fileName}" uploaded and attached to deal`
    });
  } catch (error) {
    console.error('HubSpot file upload error:', error);
    res.status(500).json({ error: error.message || 'Failed to upload file to HubSpot' });
  }
});

// Get HubSpot deal info for file upload targeting (admin only)
app.get('/api/hubspot/deals', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const projects = await getProjects();
    const dealsWithHubSpot = projects
      .filter(p => p.hubspotRecordId)
      .map(p => ({
        projectId: p.id,
        projectName: p.name,
        clientName: p.clientName,
        hubspotRecordId: p.hubspotRecordId,
        hubspotRecordType: p.hubspotRecordType || 'companies'
      }));
    res.json(dealsWithHubSpot);
  } catch (error) {
    console.error('Error fetching HubSpot deals:', error);
    res.status(500).json({ error: 'Failed to fetch deals' });
  }
});

// ============== CLIENT HUBSPOT FILE UPLOAD ==============
// Client uploads file to their account's HubSpot records (Company, Deal, Contact)
app.post('/api/client/hubspot/upload', authenticateToken, uploadLimiter, upload.single('file'), async (req, res) => {
  try {
    // Only clients can use this endpoint
    if (req.user.role !== config.ROLES.CLIENT) {
      return res.status(403).json({ error: 'Client access required' });
    }
    
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    
    const { noteText, category } = req.body;
    
    // Get fresh user data with HubSpot IDs
    const users = await getUsers();
    const clientUser = users.find(u => u.id === req.user.id);
    
    if (!clientUser) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const hubspotCompanyId = clientUser.hubspotCompanyId || '';
    const hubspotDealId = clientUser.hubspotDealId || '';
    const hubspotContactId = clientUser.hubspotContactId || '';
    
    // Check if at least one HubSpot ID is configured
    if (!hubspotCompanyId && !hubspotDealId && !hubspotContactId) {
      return res.status(400).json({ error: 'Your account is not linked to HubSpot. Please contact your administrator.' });
    }
    
    const fileName = req.file.originalname;
    const fileBuffer = req.file.buffer;
    
    // Convert buffer to base64
    const fileContent = fileBuffer.toString('base64');
    
    // Build note text with category
    let fullNoteText = category ? `[${category}] ` : '';
    fullNoteText += noteText || `File uploaded by ${req.user.name}`;
    
    // Upload to all configured HubSpot records
    const uploadResults = [];
    let primaryResult = null;
    
    // Upload to Company
    if (hubspotCompanyId) {
      try {
        const result = await hubspot.uploadFileAndAttachToRecord(
          hubspotCompanyId,
          fileContent,
          fileName,
          fullNoteText,
          { isBase64: true, recordType: 'companies', notePrefix: '[Client Portal]' }
        );
        uploadResults.push({ type: 'company', id: hubspotCompanyId, ...result });
        if (!primaryResult) primaryResult = result;
      } catch (err) {
        console.error('Error uploading to HubSpot Company:', err.message);
      }
    }
    
    // Upload to Deal
    if (hubspotDealId) {
      try {
        const result = await hubspot.uploadFileAndAttachToRecord(
          hubspotDealId,
          fileContent,
          fileName,
          fullNoteText,
          { isBase64: true, recordType: 'deals', notePrefix: '[Client Portal]' }
        );
        uploadResults.push({ type: 'deal', id: hubspotDealId, ...result });
        if (!primaryResult) primaryResult = result;
      } catch (err) {
        console.error('Error uploading to HubSpot Deal:', err.message);
      }
    }
    
    // Upload to Contact
    if (hubspotContactId) {
      try {
        const result = await hubspot.uploadFileAndAttachToRecord(
          hubspotContactId,
          fileContent,
          fileName,
          fullNoteText,
          { isBase64: true, recordType: 'contacts', notePrefix: '[Client Portal]' }
        );
        uploadResults.push({ type: 'contact', id: hubspotContactId, ...result });
        if (!primaryResult) primaryResult = result;
      } catch (err) {
        console.error('Error uploading to HubSpot Contact:', err.message);
      }
    }
    
    if (uploadResults.length === 0) {
      return res.status(500).json({ error: 'Failed to upload to any HubSpot records' });
    }
    
    // Save document record for visibility in both portals
    const documents = (await db.get('client_documents')) || [];
    const docId = require('uuid').v4();
    const newDoc = {
      id: docId,
      slug: req.user.slug,
      title: fileName,
      description: noteText || '',
      category: category || 'HubSpot Upload',
      active: true,
      uploadedBy: 'client',
      uploadedByName: req.user.name,
      uploadedByEmail: req.user.email,
      hubspotFileId: primaryResult.fileId,
      hubspotNoteId: primaryResult.noteId,
      hubspotFileUrl: primaryResult.fileUrl || null,
      hubspotRecords: uploadResults.map(r => ({ type: r.type, recordId: r.id })),
      createdAt: new Date().toISOString()
    };
    documents.push(newDoc);
    await db.set('client_documents', documents);
    
    // Log activity
    const activityLog = (await db.get('activity_log')) || [];
    activityLog.unshift({
      id: require('uuid').v4(),
      action: 'hubspot_file_upload',
      entityType: 'client_file',
      entityId: primaryResult.fileId,
      userId: req.user.id,
      slug: req.user.slug,
      userName: req.user.name,
      details: fileName,
      timestamp: new Date().toISOString()
    });
    if (activityLog.length > config.ACTIVITY_LOG_MAX_ENTRIES) activityLog.length = config.ACTIVITY_LOG_MAX_ENTRIES;
    await db.set('activity_log', activityLog);
    
    const recordTypes = uploadResults.map(r => r.type).join(', ');
    res.json({ 
      success: true, 
      fileId: primaryResult.fileId,
      noteId: primaryResult.noteId,
      documentId: docId,
      uploadedTo: uploadResults,
      message: `File "${fileName}" uploaded to ${recordTypes}`
    });
  } catch (error) {
    console.error('Client HubSpot file upload error:', error);
    res.status(500).json({ error: error.message || 'Failed to upload file' });
  }
});

// ============== CLIENT HUBSPOT TICKETS ==============

// HubSpot webhook validation middleware
const HUBSPOT_WEBHOOK_SECRET = process.env.HUBSPOT_WEBHOOK_SECRET;

if (!HUBSPOT_WEBHOOK_SECRET) {
  console.warn('⚠️  WARNING: HUBSPOT_WEBHOOK_SECRET not set. Webhook endpoints will accept ALL requests without validation.');
  console.warn('   Set HUBSPOT_WEBHOOK_SECRET to enable webhook authentication.');
}

function validateHubSpotWebhook(req, res, next) {
  if (HUBSPOT_WEBHOOK_SECRET) {
    const providedSecret = req.headers['x-hubspot-webhook-secret'] || req.query.secret;
    if (providedSecret !== HUBSPOT_WEBHOOK_SECRET) {
      console.warn('HubSpot webhook rejected: invalid secret');
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }
  next();
}

// Webhook endpoint for HubSpot to register portal-created tickets
// HubSpot workflow should call this when a ticket is created from the portal form
app.post('/api/webhook/hubspot/ticket-created', validateHubSpotWebhook, async (req, res) => {
  try {
    const { ticketId, contactEmail, companyId, subject } = req.body;

    if (!ticketId) {
      return res.status(400).json({ error: 'ticketId is required' });
    }

    // Get or create portal_tickets collection
    const portalTickets = (await db.get('portal_tickets')) || [];

    // Check if already registered
    if (portalTickets.find(t => t.ticketId === ticketId)) {
      return res.json({ message: 'Ticket already registered', ticketId });
    }

    // Add the ticket to portal tracking
    portalTickets.push({
      ticketId: String(ticketId),
      contactEmail: contactEmail || '',
      companyId: companyId || '',
      subject: subject || '',
      registeredAt: new Date().toISOString()
    });

    // Keep only last 1000 portal tickets
    if (portalTickets.length > 1000) portalTickets.length = 1000;

    await db.set('portal_tickets', portalTickets);
    console.log(`🎫 Portal ticket registered: ${ticketId} for ${contactEmail || companyId}`);

    res.json({ success: true, ticketId, message: 'Ticket registered for portal display' });
  } catch (error) {
    console.error('Error registering portal ticket:', error);
    res.status(500).json({ error: 'Failed to register ticket' });
  }
});

// Webhook endpoint for HubSpot ticket stage changes
// HubSpot workflow should trigger this when ticket moves to "Assigned" or "Vendor Escalation" stage
app.post('/api/webhook/hubspot/ticket-stage-change', validateHubSpotWebhook, async (req, res) => {
  try {
    const { ticketId, stageId, stageName } = req.body;

    if (!ticketId) {
      return res.status(400).json({ error: 'ticketId is required' });
    }

    console.log(`🎫 Ticket stage change webhook: ${ticketId} -> ${stageName || stageId}`);

    // Check if the stage is one we should process
    const targetStages = ['assigned', 'vendor escalation', 'vendor_escalation'];
    const stageNameLower = (stageName || '').toLowerCase();
    const shouldProcess = targetStages.some(stage => stageNameLower.includes(stage));

    if (!shouldProcess) {
      return res.json({
        message: 'Stage not configured for auto-assignment',
        ticketId,
        stageName
      });
    }

    // Fetch the ticket from HubSpot
    let ticket;
    try {
      ticket = await hubspot.getTicketById(ticketId);
    } catch (err) {
      console.error(`Failed to fetch ticket ${ticketId}:`, err.message);
      return res.status(404).json({
        error: 'Ticket not found in HubSpot',
        ticketId,
        details: err.message
      });
    }

    // Check if service report already exists for this ticket
    const serviceReports = (await db.get('service_reports')) || [];
    const existingReport = serviceReports.find(r =>
      r.hubspotTicketNumber === ticketId || r.hubspotTicketNumber === String(ticketId)
    );

    if (existingReport) {
      console.log(`Service report already exists for ticket ${ticketId}`);
      return res.json({
        message: 'Service report already exists for this ticket',
        ticketId,
        reportId: existingReport.id
      });
    }

    // Map HubSpot owner ID to internal user
    const users = (await db.get('users')) || [];
    const { id: assignedToId, name: assignedToName } = await resolveHubSpotOwnerToUser(ticket.ownerId, users);

    // If no assignee found, we cannot auto-create the service report
    if (!assignedToId) {
      console.log(`Cannot auto-create service report: No internal user found for HubSpot owner ${ticket.ownerId}`);
      return res.json({
        message: 'Ticket owner not matched to internal user - manual assignment required',
        ticketId,
        hubspotOwnerId: ticket.ownerId,
        requiresManualAssignment: true
      });
    }

    // Map Service Type from Issue Category
    const issueCategoryLower = (ticket.issueCategory || '').toLowerCase();
    const serviceType = config.SERVICE_TYPE_MAP[issueCategoryLower] || '';

    // Create the service report
    const webhookClientSlug = await resolveClientSlug(ticket.companyName, ticket.companyId);
    const newReport = buildServiceReportFromTicket(ticket, assignedToId, assignedToName, serviceType, webhookClientSlug, 'webhook');

    serviceReports.push(newReport);
    await db.set('service_reports', serviceReports);

    console.log(`✅ Auto-created service report ${newReport.id} from ticket ${ticketId}`);

    // Log activity (skip if system user doesn't exist)
    try {
      await logActivity(
        'system',
        'HubSpot Automation',
        'service_report_auto_assigned',
        'service_report',
        newReport.id,
        {
          ticketId,
          assignedTo: assignedToName,
          clientName: ticket.companyName
        }
      );
    } catch (logErr) {
      console.log('Could not log activity:', logErr.message);
    }

    res.json({
      success: true,
      message: 'Service report auto-created from ticket',
      ticketId,
      reportId: newReport.id,
      assignedTo: assignedToName
    });
  } catch (error) {
    console.error('Error processing ticket stage change webhook:', error);
    res.status(500).json({
      error: 'Failed to process webhook',
      details: error.message
    });
  }
});

// Admin endpoint to view/manage portal tickets
app.get('/api/admin/portal-tickets', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const portalTickets = (await db.get('portal_tickets')) || [];
    res.json({ tickets: portalTickets, count: portalTickets.length });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch portal tickets' });
  }
});

// Admin endpoint to clear portal tickets (for testing)
app.delete('/api/admin/portal-tickets', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const old = (await db.get('portal_tickets')) || [];
    await db.set('portal_tickets', []);
    res.json({ message: 'Portal tickets cleared', cleared: old.length });
  } catch (error) {
    res.status(500).json({ error: 'Failed to clear portal tickets' });
  }
});

// ===== Client Submit-Ticket Endpoint =====

// Client submits a support ticket via the native portal form.
// Stores locally in portal_submitted_tickets and optionally creates a HubSpot ticket
// tagged as External so it surfaces via GET /api/client/hubspot/tickets.
app.post('/api/client/submit-ticket', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== config.ROLES.CLIENT) {
      return res.status(403).json({ error: 'Client access required' });
    }

    const { subject, description, priority, submittedBy, issueCategory } = req.body;
    if (!subject || !subject.trim()) return res.status(400).json({ error: 'Subject is required' });

    const users = await getUsers();
    const clientUser = users.find(u => u.id === req.user.id);
    if (!clientUser) return res.status(404).json({ error: 'User not found' });

    const now = new Date().toISOString();
    const ticketRecord = {
      id: uuidv4(),
      clientSlug: clientUser.slug || '',
      clientId: clientUser.id,
      clientName: clientUser.name || clientUser.email,
      subject: subject.trim(),
      description: (description || '').trim(),
      priority: priority || 'Low',
      submittedBy: (submittedBy || '').trim(),
      issueCategory: (issueCategory || '').trim(),
      status: 'Open',
      submittedAt: now,
      source: 'client_submitted',
      hubspotTicketId: null
    };

    // Attempt to create HubSpot ticket
    if (process.env.HUBSPOT_PRIVATE_APP_TOKEN) {
      try {
        const companyId = clientUser.hubspotCompanyId || null;
        const contactId = clientUser.hubspotContactId || null;
        const dealId = clientUser.hubspotDealId || null;
        const ticketConfig = (await db.get('hubspot_ticket_config')) || {};
        const result = await hubspot.createTicket(
          {
            subject: ticketRecord.subject,
            description: ticketRecord.description,
            priority: ticketRecord.priority,
            submittedBy: ticketRecord.submittedBy,
            issueCategory: ticketRecord.issueCategory,
            pipelineId: ticketConfig.pipelineId || '0',
            stageId: ticketConfig.newStageId || '1'
          },
          companyId,
          contactId,
          dealId
        );
        ticketRecord.hubspotTicketId = result.ticketId;
        console.log(`🎫 HubSpot ticket created: ${result.ticketId} for ${clientUser.email}`);
      } catch (hsErr) {
        console.warn(`⚠️ HubSpot ticket creation failed (storing locally only): ${hsErr.message}`);
      }
    }

    const submitted = (await db.get('portal_submitted_tickets')) || [];
    submitted.unshift(ticketRecord);
    await db.set('portal_submitted_tickets', submitted);

    await logActivity(req.user.id, req.user.name || req.user.email, 'support_ticket_submitted', 'ticket', ticketRecord.id, { subject: ticketRecord.subject });

    res.json({ success: true, ticket: ticketRecord });
  } catch (error) {
    console.error('Error submitting client ticket:', error);
    res.status(500).json({ error: 'Failed to submit ticket' });
  }
});

// ===== HubSpot Ticket Pipeline Config =====

app.get('/api/admin/ticket-config', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const config = (await db.get('hubspot_ticket_config')) || {};
    res.json(config);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch ticket config' });
  }
});

app.put('/api/admin/ticket-config', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { pipelineId, newStageId } = req.body;
    const config = (await db.get('hubspot_ticket_config')) || {};
    if (pipelineId !== undefined) config.pipelineId = pipelineId;
    if (newStageId !== undefined) config.newStageId = newStageId;
    await db.set('hubspot_ticket_config', config);
    res.json({ success: true, config });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update ticket config' });
  }
});

// ===== HubSpot Ticket Polling Admin Endpoints =====

// Get polling configuration
app.get('/api/admin/ticket-polling/config', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const config = (await db.get('ticket_polling_config')) || getDefaultPollingConfig();
    res.json(config);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch polling config' });
  }
});

// Update polling configuration
app.put('/api/admin/ticket-polling/config', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const config = (await db.get('ticket_polling_config')) || getDefaultPollingConfig();
    const updates = req.body;

    // Update allowed fields
    if (updates.enabled !== undefined) config.enabled = Boolean(updates.enabled);
    if (updates.intervalSeconds !== undefined) {
      config.intervalSeconds = Math.max(HUBSPOT_POLL_MIN_SECONDS, Math.min(HUBSPOT_POLL_MAX_SECONDS, Number(updates.intervalSeconds)));
    }
    if (updates.targetStages) config.targetStages = updates.targetStages;

    // Update filter settings
    if (updates.filter) {
      if (updates.filter.mode && ['keyword', 'property', 'all'].includes(updates.filter.mode)) {
        config.filter.mode = updates.filter.mode;
      }
      if (updates.filter.subjectKeyword !== undefined) {
        config.filter.subjectKeyword = String(updates.filter.subjectKeyword);
      }
      if (updates.filter.propertyName !== undefined) {
        config.filter.propertyName = String(updates.filter.propertyName);
      }
      if (updates.filter.propertyValue !== undefined) {
        config.filter.propertyValue = String(updates.filter.propertyValue);
      }
    }

    // Clear resolved stage IDs if target stages changed (force re-resolution)
    if (updates.targetStages) {
      config.resolvedStageIds = [];
      config.stageIdsCachedAt = null;
    }

    config.updatedAt = new Date().toISOString();
    await db.set('ticket_polling_config', config);

    // Restart polling timer with new settings
    if (hubspotPollingTimer) {
      clearInterval(hubspotPollingTimer);
      hubspotPollingTimer = null;
    }
    if (config.enabled) {
      hubspotPollingTimer = setInterval(pollHubSpotTickets, config.intervalSeconds * 1000);
    }

    res.json({ success: true, config });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update polling config', details: error.message });
  }
});

// Get polling status summary
app.get('/api/admin/ticket-polling/status', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const config = await db.get('ticket_polling_config');
    res.json({
      enabled: config?.enabled || false,
      running: !!hubspotPollingTimer,
      intervalSeconds: config?.intervalSeconds || 60,
      filterMode: config?.filter?.mode || 'keyword',
      filterDetail: config?.filter?.mode === 'keyword'
        ? `Subject contains "${config?.filter?.subjectKeyword || '[SR]'}"`
        : config?.filter?.mode === 'property'
        ? `${config?.filter?.propertyName} = ${config?.filter?.propertyValue}`
        : 'All tickets (no filter)',
      lastPollTime: config?.lastPollTime || null,
      startedAt: config?.startedAt || null,
      processedTicketCount: config?.processedTicketIds?.length || 0,
      resolvedStageIds: config?.resolvedStageIds || [],
      stats: config?.stats || {}
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch polling status' });
  }
});

// Manually trigger a poll cycle
app.post('/api/admin/ticket-polling/trigger', authenticateToken, requireAdmin, async (req, res) => {
  try {
    await pollHubSpotTickets();
    const config = await db.get('ticket_polling_config');
    res.json({
      success: true,
      message: 'Poll cycle completed',
      lastPollTime: config?.lastPollTime,
      stats: config?.stats
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to trigger poll', details: error.message });
  }
});

// Reset polling state (clear processed tickets, reset stats)
app.post('/api/admin/ticket-polling/reset', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const config = (await db.get('ticket_polling_config')) || getDefaultPollingConfig();
    config.processedTicketIds = [];
    config.resolvedStageIds = [];
    config.stageIdsCachedAt = null;
    config.startedAt = new Date().toISOString();
    config.lastPollTime = null;
    config.stats = {
      totalPolls: 0,
      totalReportsCreated: 0,
      lastSuccessfulPoll: null,
      lastError: null,
      lastErrorTime: null
    };
    config.updatedAt = new Date().toISOString();
    await db.set('ticket_polling_config', config);
    res.json({ success: true, message: 'Polling state reset', config });
  } catch (error) {
    res.status(500).json({ error: 'Failed to reset polling state' });
  }
});

// Fetch support tickets for the logged-in client.
// Merges three sources: HubSpot External tickets, client-submitted tickets, and admin-released tickets.
// Attaches matching service reports to each ticket.
app.get('/api/client/hubspot/tickets', authenticateToken, async (req, res) => {
  try {
    // Only clients can use this endpoint
    if (req.user.role !== config.ROLES.CLIENT) {
      return res.status(403).json({ error: 'Client access required' });
    }

    // Get fresh user data with HubSpot IDs
    const users = await getUsers();
    const clientUser = users.find(u => u.id === req.user.id);

    if (!clientUser) {
      return res.status(404).json({ error: 'User not found' });
    }

    const hubspotCompanyId = clientUser.hubspotCompanyId || '';
    const hubspotContactId = clientUser.hubspotContactId || '';
    const hubspotDealId = clientUser.hubspotDealId || '';

    // Fetch assigned projects — used for the retroactive cutoff date fallback.
    const allProjects = await getProjects();
    const assignedProjects = allProjects.filter(p =>
      (clientUser.assignedProjects || []).includes(p.id)
    );

    // Determine the cutoff date to prevent retroactive ticket display.
    // Tickets created before this date are hidden.
    // Priority: hubspotLinkedAt (set when IDs were first linked) > earliest assigned project createdAt > no cutoff
    let ticketCutoffDate = clientUser.hubspotLinkedAt ? new Date(clientUser.hubspotLinkedAt) : null;
    if (!ticketCutoffDate && assignedProjects.length > 0) {
      ticketCutoffDate = assignedProjects.reduce((earliest, p) => {
        const d = new Date(p.createdAt);
        return !earliest || d < earliest ? d : earliest;
      }, null);
    }

    console.log(`🎫 Ticket fetch for user ${clientUser.username || clientUser.email}:`);
    console.log(`   - Company ID: "${hubspotCompanyId}"`);
    console.log(`   - Contact ID: "${hubspotContactId}"`);
    console.log(`   - Deal ID: "${hubspotDealId}"`);
    console.log(`   - Cutoff date: ${ticketCutoffDate ? ticketCutoffDate.toISOString() : 'none (show all)'}`);

    if (!hubspotCompanyId && !hubspotContactId && !hubspotDealId) {
      console.log(`🎫 No HubSpot IDs configured for ${clientUser.username || clientUser.email}`);
      return res.json({ tickets: [], message: 'No HubSpot account linked' });
    }

    let tickets = [];

    // 1. Fetch by company ID — primary source. Each practice should have its own
    //    HubSpot company record so this scopes correctly to that practice's tickets.
    if (hubspotCompanyId) {
      try {
        const companyTickets = await hubspot.getTicketsForCompany(hubspotCompanyId);
        tickets = [...companyTickets];
        console.log(`📋 Fetched ${companyTickets.length} tickets for company ${hubspotCompanyId}`);
      } catch (err) {
        console.error('Error fetching company tickets:', err.message);
      }
    }

    // 2. Fetch by deal ID and merge (deduplicated).
    if (hubspotDealId && hubspot.getTicketsForDeal) {
      try {
        const dealTickets = await hubspot.getTicketsForDeal(hubspotDealId);
        const existingIds = new Set(tickets.map(t => t.id));
        const newTickets = dealTickets.filter(t => !existingIds.has(t.id));
        tickets = [...tickets, ...newTickets];
        console.log(`📋 Fetched ${dealTickets.length} tickets for deal ${hubspotDealId} (${newTickets.length} new)`);
      } catch (err) {
        console.error('Error fetching deal tickets:', err.message);
      }
    }

    // 3. Fetch by contact ID and merge (deduplicated).
    if (hubspotContactId) {
      try {
        const contactTickets = await hubspot.getTicketsForContact(hubspotContactId);
        const existingIds = new Set(tickets.map(t => t.id));
        const newTickets = contactTickets.filter(t => !existingIds.has(t.id));
        tickets = [...tickets, ...newTickets];
        console.log(`📋 Fetched ${contactTickets.length} tickets for contact ${hubspotContactId} (${newTickets.length} new)`);
      } catch (err) {
        console.error('Error fetching contact tickets:', err.message);
      }
    }

    // Apply retroactive cutoff: hide tickets created before the client was linked.
    // This prevents historical tickets from flooding the support view on first link.
    if (ticketCutoffDate) {
      const beforeCutoff = tickets.length;
      tickets = tickets.filter(t => !t.createdAt || new Date(t.createdAt) >= ticketCutoffDate);
      console.log(`📅 Retroactive filter: ${beforeCutoff} -> ${tickets.length} tickets (cutoff: ${ticketCutoffDate.toISOString()})`);
    }

    // Filter HubSpot tickets to only those marked External (client-visible)
    const beforeFilter = tickets.length;
    tickets = tickets.filter(t => {
      const typeVal = (t.ticketType || '').toLowerCase().trim();
      return typeVal === 'external';
    });
    console.log(`🎫 Filtered ${beforeFilter} -> ${tickets.length} external/client-facing HubSpot tickets`);

    // Fetch service reports to link to tickets
    const serviceReports = (await db.get('service_reports')) || [];

    // Map HubSpot tickets to simplified format
    const mapHubSpotTicket = (t) => {
      const stageLower = (t.stage || '').toLowerCase();
      const status = (stageLower.includes('closed') || t.closedAt) ? 'Closed' : 'Open';
      const linkedReport = serviceReports.find(r => {
        const reportTicketId = String(r.hubspotTicketId || r.hubspotTicketNumber || '');
        return reportTicketId && reportTicketId === String(t.id);
      });
      return {
        id: t.id,
        subject: t.subject,
        description: t.content || '',
        status,
        createdAt: t.createdAt,
        closedAt: t.closedAt || null,
        priority: t.priority,
        source: 'hubspot',
        serviceReport: linkedReport ? {
          id: linkedReport.id,
          serviceType: linkedReport.serviceType,
          technicianName: linkedReport.technicianName || linkedReport.serviceProviderName,
          completedAt: linkedReport.serviceCompletionDate || linkedReport.createdAt,
          description: linkedReport.descriptionOfWork || linkedReport.validationResults || '',
          pdfUrl: linkedReport.pdfUrl || null,
          driveFileId: linkedReport.driveFileId || null
        } : null
      };
    };

    const mappedHubSpot = tickets.map(mapHubSpotTicket);

    // Merge client-submitted tickets (from portal form)
    const clientSlug = clientUser.slug || '';
    const allSubmitted = (await db.get('portal_submitted_tickets')) || [];
    const submittedForClient = allSubmitted.filter(t => t.clientId === clientUser.id || (clientSlug && t.clientSlug === clientSlug));
    // Deduplicate: if a submitted ticket already has a HubSpot ID that appears in mappedHubSpot, skip the local copy
    const hsIds = new Set(mappedHubSpot.map(t => String(t.id)));
    const mappedSubmitted = submittedForClient
      .filter(t => !t.hubspotTicketId || !hsIds.has(String(t.hubspotTicketId)))
      .map(t => ({
        id: t.id,
        subject: t.subject,
        description: t.description || '',
        status: t.status || 'Open',
        createdAt: t.submittedAt,
        closedAt: null,
        priority: t.priority || 'Low',
        source: 'client_submitted',
        serviceReport: null
      }));

    const mappedTickets = [...mappedHubSpot, ...mappedSubmitted];

    // Sort by creation date, newest first
    mappedTickets.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    console.log(`🎫 Total tickets for ${clientUser.username || clientUser.email}: ${mappedHubSpot.length} HubSpot + ${mappedSubmitted.length} submitted = ${mappedTickets.length}`);
    res.json({ tickets: mappedTickets, count: mappedTickets.length });
  } catch (error) {
    console.error('Error fetching client tickets:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch tickets' });
  }
});

// Get service reports for clients (Service History)
app.get('/api/client/service-reports', authenticateToken, async (req, res) => {
  try {
    // Only clients can use this endpoint
    if (req.user.role !== config.ROLES.CLIENT) {
      return res.status(403).json({ error: 'Client access required' });
    }

    // Get fresh user data with HubSpot IDs
    const users = await getUsers();
    const clientUser = users.find(u => u.id === req.user.id);

    if (!clientUser) {
      return res.status(404).json({ error: 'User not found' });
    }

    const hubspotCompanyId = clientUser.hubspotCompanyId || '';
    const clientSlug = clientUser.slug || '';
    const practiceName = clientUser.practiceName || '';
    const userName = clientUser.name || '';

    // Build list of names to match against (practiceName and name separately)
    const clientNames = [practiceName, userName]
      .map(n => n.toLowerCase().trim())
      .filter(Boolean);
    // Deduplicate
    const uniqueClientNames = [...new Set(clientNames)];

    console.log(`📋 Service reports fetch for ${clientUser.email}:`);
    console.log(`   - Company ID: "${hubspotCompanyId}"`);
    console.log(`   - Slug: "${clientSlug}"`);
    console.log(`   - Practice: "${practiceName}"`);
    console.log(`   - Name: "${userName}"`);
    console.log(`   - Match names: ${JSON.stringify(uniqueClientNames)}`);

    // Fetch all service reports
    const serviceReports = (await db.get('service_reports')) || [];

    // Also fetch client_documents to cross-reference by slug
    // (documents linked to service reports are reliably matched by slug)
    const clientDocuments = (await db.get('client_documents')) || [];
    const slugLinkedReportIds = new Set(
      clientDocuments
        .filter(d => d.active && d.serviceReportId && (d.slug === clientSlug || d.shareWithAll))
        .map(d => d.serviceReportId)
    );

    // Filter reports for this client by:
    // 1. Matching hubspotCompanyId
    // 2. Or bidirectional name matching (practiceName or user name vs clientFacilityName)
    // 3. Or cross-referenced via client_documents linked to this client's slug
    const clientReports = serviceReports.filter(report => {
      // Primary: match by clientSlug (most reliable)
      if (clientSlug && report.clientSlug && report.clientSlug === clientSlug) {
        return true;
      }
      // Match by hubspotCompanyId
      if (hubspotCompanyId && report.hubspotCompanyId === hubspotCompanyId) {
        return true;
      }
      // Match by slug cross-reference via client_documents
      if (slugLinkedReportIds.has(report.id)) {
        return true;
      }
      // Fallback: exact case-insensitive match by any of the client's names
      const reportClient = (report.clientFacilityName || '').toLowerCase().trim();
      if (reportClient && uniqueClientNames.some(name => reportClient === name)) {
        return true;
      }
      return false;
    });

    // Sort: signature_needed first, then assigned (scheduled), then by date (newest first)
    clientReports.sort((a, b) => {
      const statusOrder = { 'signature_needed': 0, 'assigned': 1 };
      const aOrder = statusOrder[a.status] ?? 2;
      const bOrder = statusOrder[b.status] ?? 2;
      if (aOrder !== bOrder) return aOrder - bOrder;
      return new Date(b.createdAt) - new Date(a.createdAt);
    });

    console.log(`📋 Found ${clientReports.length}/${serviceReports.length} service reports for ${clientUser.email} (slug-linked: ${slugLinkedReportIds.size})`);
    if (clientReports.length === 0 && serviceReports.length > 0) {
      console.log(`   ⚠️ No matches. Report facility names: ${serviceReports.slice(0, 5).map(r => `"${r.clientFacilityName}"`).join(', ')}`);
    }

    // Map to a format for the frontend with full details for report viewing and signing
    const reports = clientReports.map(r => {
      const isAssigned = r.status === 'assigned';
      return {
        id: r.id,
        subject: `${r.serviceType || 'Service Report'} - ${r.clientFacilityName}`,
        serviceType: r.serviceType || '',
        technicianName: isAssigned ? (r.assignedToName || 'Scheduled') : (r.technicianName || r.serviceProviderName || ''),
        ticketNumber: r.hubspotTicketId || r.hubspotTicketNumber || null,
        createdAt: r.createdAt,
        completedAt: isAssigned ? null : (r.serviceCompletionDate || r.completedAt || r.createdAt),
        status: r.status === 'signature_needed' ? 'Signature Needed' : r.status === 'assigned' ? 'Scheduled' : 'Completed',
        rawStatus: r.status,
        // Full report details for client viewing (limited for assigned reports)
        clientFacilityName: r.clientFacilityName || '',
        customerName: r.customerName || '',
        address: r.address || '',
        analyzerModel: r.analyzerModel || '',
        analyzerSerialNumber: isAssigned ? '' : (r.analyzerSerialNumber || ''),
        serviceCompletionDate: isAssigned ? '' : (r.serviceCompletionDate || ''),
        descriptionOfWork: isAssigned ? '' : (r.descriptionOfWork || ''),
        materialsUsed: isAssigned ? '' : (r.materialsUsed || ''),
        solution: isAssigned ? '' : (r.solution || ''),
        outstandingIssues: isAssigned ? '' : (r.outstandingIssues || ''),
        recommendations: isAssigned ? '' : (r.recommendations || ''),
        // Validation-specific fields
        validationResults: isAssigned ? '' : (r.validationResults || ''),
        validationStartDate: isAssigned ? '' : (r.validationStartDate || ''),
        validationEndDate: isAssigned ? '' : (r.validationEndDate || ''),
        testProcedures: isAssigned ? '' : (r.testProcedures || ''),
        trainingProvided: isAssigned ? '' : (r.trainingProvided || ''),
        // Signature info
        customerSignature: isAssigned ? null : (r.customerSignature || null),
        customerSignatureDate: isAssigned ? null : (r.customerSignatureDate || null),
        technicianSignature: isAssigned ? null : (r.technicianSignature || null),
        technicianSignatureDate: isAssigned ? null : (r.technicianSignatureDate || null),
        pdfUrl: isAssigned ? null : (r.pdfUrl || null),
        driveFileId: isAssigned ? null : (r.driveFileId || null),
        // Scheduled visit info for assigned reports
        scheduledDate: isAssigned ? (r.serviceCompletionDate || null) : null,
        assignedToName: isAssigned ? (r.assignedToName || '') : null
      };
    });

    const pendingSignatureCount = reports.filter(r => r.rawStatus === 'signature_needed').length;

    res.json({ reports, count: reports.length, pendingSignatureCount });
  } catch (error) {
    console.error('Error fetching client service reports:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch service reports' });
  }
});

// Get a single service report by ID (client access via slug-based document matching)
app.get('/api/client/service-reports/:id', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'client') {
      return res.status(403).json({ error: 'Client access required' });
    }

    const reportId = req.params.id;
    const clientSlug = req.user.slug;
    if (!clientSlug) {
      return res.status(400).json({ error: 'Client slug not found' });
    }

    // Verify client owns this report via client_documents (slug-based, reliable)
    const clientDocs = (await db.get('client_documents')) || [];
    const matchingDoc = clientDocs.find(d => d.slug === clientSlug && d.serviceReportId === reportId);
    if (!matchingDoc) {
      return res.status(404).json({ error: 'Service report not found' });
    }

    // Fetch the actual service report
    const serviceReports = (await db.get('service_reports')) || [];
    const report = serviceReports.find(r => r.id === reportId);
    if (!report) {
      return res.status(404).json({ error: 'Service report not found' });
    }

    res.json(report);
  } catch (error) {
    console.error('Error fetching single service report:', error);
    res.status(500).json({ error: 'Failed to fetch service report' });
  }
});

// Client signs a service report that is pending their signature
app.put('/api/client/service-reports/:id/sign', authenticateToken, async (req, res) => {
  try {
    // Only clients can use this endpoint
    if (req.user.role !== config.ROLES.CLIENT) {
      return res.status(403).json({ error: 'Client access required' });
    }

    const { customerSignature, customerSignatureDate } = req.body;

    if (!customerSignature || !customerSignature.startsWith('data:image')) {
      return res.status(400).json({ error: 'A valid signature is required' });
    }

    // Get fresh user data for matching
    const users = await getUsers();
    const clientUser = users.find(u => u.id === req.user.id);
    if (!clientUser) {
      return res.status(404).json({ error: 'User not found' });
    }

    const hubspotCompanyId = clientUser.hubspotCompanyId || '';
    const clientSlug = clientUser.slug || '';
    const practiceName = clientUser.practiceName || '';
    const userName = clientUser.name || '';

    // Build list of names to match against
    const clientNames = [practiceName, userName]
      .map(n => n.toLowerCase().trim())
      .filter(Boolean);
    const uniqueClientNames = [...new Set(clientNames)];

    const serviceReports = (await db.get('service_reports')) || [];
    const reportIndex = serviceReports.findIndex(r => r.id === req.params.id);

    if (reportIndex === -1) {
      return res.status(404).json({ error: 'Report not found' });
    }

    const report = serviceReports[reportIndex];

    // Verify this report belongs to the client
    let isClientReport = false;
    if (clientSlug && report.clientSlug && report.clientSlug === clientSlug) {
      isClientReport = true;
    }
    if (!isClientReport && hubspotCompanyId && report.hubspotCompanyId === hubspotCompanyId) {
      isClientReport = true;
    }
    if (!isClientReport) {
      // Check slug cross-reference via client_documents
      const clientDocuments = (await db.get('client_documents')) || [];
      const slugLinked = clientDocuments.some(d => d.active && d.serviceReportId === report.id && (d.slug === clientSlug || d.shareWithAll));
      if (slugLinked) isClientReport = true;
    }
    if (!isClientReport) {
      const reportClient = (report.clientFacilityName || '').toLowerCase().trim();
      if (reportClient && uniqueClientNames.some(name => reportClient === name)) {
        isClientReport = true;
      }
    }

    if (!isClientReport) {
      return res.status(403).json({ error: 'Not authorized to sign this report' });
    }

    // Verify report is in signature_needed status
    if (report.status !== 'signature_needed') {
      return res.status(400).json({ error: `Report is not awaiting signature (current status: ${report.status})` });
    }

    // Apply the customer signature and mark as fully complete
    serviceReports[reportIndex] = {
      ...report,
      status: 'submitted',
      customerSignature,
      customerSignatureDate: customerSignatureDate || new Date().toISOString().split('T')[0],
      customerSignedFromPortal: true,
      customerSignedAt: new Date().toISOString(),
      customerSignedBy: clientUser.name || clientUser.email,
      submittedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    await db.set('service_reports', serviceReports);

    const signedReport = serviceReports[reportIndex];

    console.log(`✅ Client ${clientUser.name || clientUser.email} signed service report ${signedReport.id} from portal`);

    // Log activity
    try {
      await logActivity(
        req.user.id,
        clientUser.name || clientUser.email,
        'service_report_client_signed',
        'service_report',
        signedReport.id,
        { clientName: signedReport.clientFacilityName, serviceType: signedReport.serviceType, signedFrom: 'client_portal' }
      );
    } catch (logErr) {
      console.log('Could not log activity:', logErr.message);
    }

    // Now that the report is fully signed, upload PDF to HubSpot
    if (signedReport.hubspotCompanyId && hubspot.isValidRecordId(signedReport.hubspotCompanyId)) {
      try {
        const reportDate = new Date(signedReport.serviceCompletionDate || signedReport.createdAt).toLocaleDateString();
        console.log(`📄 Generating PDF for client-signed service report: ${signedReport.clientFacilityName}`);
        const pdfBuffer = await pdfGenerator.generateServiceReportPDF(signedReport, signedReport.technicianName);

        const fileName = `Service_Report_${signedReport.clientFacilityName.replace(/[^a-zA-Z0-9]/g, '_')}_${reportDate.replace(/\//g, '-')}.pdf`;
        const noteText = `Service Report Completed (Client Signed via Portal)\n\nClient: ${signedReport.clientFacilityName}\nService Type: ${signedReport.serviceType}\nTechnician: ${signedReport.technicianName}\nSigned by: ${clientUser.name || clientUser.email}\nTicket #: ${signedReport.hubspotTicketNumber || 'N/A'}`;

        const uploadResult = await hubspot.uploadFileAndAttachToRecord(
          signedReport.hubspotCompanyId,
          pdfBuffer.toString('base64'),
          fileName,
          noteText,
          {
            recordType: 'companies',
            folderPath: '/service-reports',
            notePrefix: '[Service Portal]',
            isBase64: true
          }
        );

        serviceReports[reportIndex].hubspotFileId = uploadResult.fileId;
        serviceReports[reportIndex].hubspotNoteId = uploadResult.noteId;
        await db.set('service_reports', serviceReports);

        console.log(`✅ Client-signed service report PDF uploaded to HubSpot for company ${signedReport.hubspotCompanyId}`);
      } catch (hubspotError) {
        console.error('HubSpot upload error (non-blocking):', hubspotError.message);
      }
    }

    // Re-upload signed PDF to Google Drive if original was uploaded
    if (signedReport.driveFileId) {
      try {
        const reportDate = new Date(signedReport.serviceCompletionDate || signedReport.createdAt).toLocaleDateString();
        console.log(`📄 Re-uploading signed PDF to Google Drive for: ${signedReport.clientFacilityName}`);
        const pdfBuffer = await pdfGenerator.generateServiceReportPDF(signedReport, signedReport.technicianName || signedReport.serviceProviderName || 'N/A');
        const driveReportDate = reportDate.replace(/\//g, '-');
        const driveFileName = `Service_Report_${signedReport.clientFacilityName.replace(/[^a-zA-Z0-9]/g, '_')}_${driveReportDate}_SIGNED.pdf`;

        // Delete old Drive file and upload new signed version
        try { await googledrive.deleteFile(signedReport.driveFileId); } catch (e) { /* ignore */ }
        const driveResult = await googledrive.uploadFile(pdfBuffer, driveFileName, 'application/pdf');
        serviceReports[reportIndex].driveFileId = driveResult.fileId;
        serviceReports[reportIndex].driveWebViewLink = driveResult.webViewLink;
        serviceReports[reportIndex].driveWebContentLink = driveResult.webContentLink;
        await db.set('service_reports', serviceReports);
        console.log(`✅ Signed PDF re-uploaded to Google Drive: ${driveFileName}`);
      } catch (driveError) {
        console.error('Google Drive re-upload error (non-blocking):', driveError.message);
      }
    }

    // Update linked client_documents entry to reflect signed status
    try {
      const clientDocuments = (await db.get('client_documents')) || [];
      let docsUpdated = false;
      clientDocuments.forEach(doc => {
        if (doc.serviceReportId === signedReport.id) {
          const reportDate = new Date(signedReport.serviceCompletionDate || signedReport.createdAt).toLocaleDateString('en-US', { year: 'numeric', month: 'numeric', day: 'numeric' });
          doc.title = `${signedReport.serviceType === 'Validations' ? 'Validation' : 'Service'} Report - ${reportDate} (Signed)`;
          doc.updatedAt = new Date().toISOString();
          docsUpdated = true;
        }
      });
      if (docsUpdated) {
        await db.set('client_documents', clientDocuments);
      }
    } catch (docErr) {
      console.error('Client documents update error (non-blocking):', docErr.message);
    }

    res.json({
      success: true,
      message: 'Service report signed successfully',
      reportId: signedReport.id
    });
  } catch (error) {
    console.error('Error signing service report:', error);
    res.status(500).json({ error: 'Failed to sign service report' });
  }
});

// Download service report PDF for clients
// Generates the PDF on-the-fly from stored report data
app.get('/api/client/service-reports/:id/pdf', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== config.ROLES.CLIENT && req.user.role !== config.ROLES.ADMIN) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const serviceReports = (await db.get('service_reports')) || [];
    const report = serviceReports.find(r => r.id === req.params.id);

    if (!report) {
      return res.status(404).json({ error: 'Report not found' });
    }

    // Allow clients to preview unsigned reports (inline only), block attachment download
    const isPreviewOnly = req.user.role === 'client' && report.status === 'signature_needed';

    // For clients, verify the report belongs to them
    if (req.user.role === config.ROLES.CLIENT) {
      const users = await getUsers();
      const clientUser = users.find(u => u.id === req.user.id);
      if (!clientUser) {
        return res.status(404).json({ error: 'User not found' });
      }

      const hubspotCompanyId = clientUser.hubspotCompanyId || '';
      const clientSlug = clientUser.slug || '';
      const practiceName = clientUser.practiceName || '';
      const userName = clientUser.name || '';
      const reportClient = (report.clientFacilityName || '').toLowerCase().trim();

      // Build list of names to match against
      const clientNames = [practiceName, userName]
        .map(n => n.toLowerCase().trim())
        .filter(Boolean);
      const uniqueClientNames = [...new Set(clientNames)];

      // Also check slug cross-reference via client_documents
      const clientDocuments = (await db.get('client_documents')) || [];
      const slugLinked = clientDocuments.some(d => d.active && d.serviceReportId === report.id && (d.slug === clientSlug || d.shareWithAll));

      const isMatch = (hubspotCompanyId && report.hubspotCompanyId === hubspotCompanyId) ||
                      slugLinked ||
                      (clientSlug && report.clientSlug && report.clientSlug === clientSlug) ||
                      (reportClient && uniqueClientNames.some(name => reportClient === name));

      if (!isMatch) {
        return res.status(403).json({ error: 'Not authorized to access this report' });
      }
    }

    // If report has a Google Drive download link and is NOT preview-only, try it first
    // but verify the link is reachable — if 404, fall through to on-the-fly generation
    if (report.driveWebContentLink && !isPreviewOnly) {
      try {
        const driveController = new AbortController();
        const driveTimer = setTimeout(() => driveController.abort(), 5000);
        const driveCheck = await fetch(report.driveWebContentLink, { method: 'HEAD', redirect: 'follow', signal: driveController.signal }).finally(() => clearTimeout(driveTimer));
        if (driveCheck.ok || driveCheck.status === 302 || driveCheck.status === 301) {
          return res.redirect(report.driveWebContentLink);
        }
        console.log(`Google Drive link returned ${driveCheck.status} for report ${report.id}, falling back to PDF generation`);
      } catch (driveErr) {
        console.log(`Google Drive link unreachable for report ${report.id}, falling back to PDF generation`);
      }
    }

    // Generate PDF and merge any attached documents (e.g. validation report document)
    // For preview-only (unsigned) reports, skip attachment merging to keep response fast
    const pdfBuffer = isPreviewOnly
      ? await pdfGenerator.generateServiceReportPDF(report, report.technicianName || report.serviceProviderName || 'N/A')
      : await pdfGenerator.generateServiceReportWithAttachments(report, report.technicianName || report.serviceProviderName || 'N/A');

    const reportDate = new Date(report.serviceCompletionDate || report.createdAt || Date.now()).toLocaleDateString().replace(/\//g, '-');
    const fileName = `Service_Report_${(report.clientFacilityName || 'Report').replace(/[^a-zA-Z0-9]/g, '_')}_${reportDate}.pdf`;

    // Preview-only (unsigned) = always inline; token-based open = inline; otherwise attachment
    const disposition = (isPreviewOnly || req.query.token) ? 'inline' : 'attachment';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `${disposition}; filename="${fileName}"`);
    res.setHeader('Content-Length', pdfBuffer.length);
    res.send(pdfBuffer);
  } catch (error) {
    console.error('Error generating service report PDF:', error);
    res.status(500).json({ error: 'Failed to generate PDF' });
  }
});

// Get HubSpot file download URL for clients
app.get('/api/client/hubspot/file/:fileId', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== config.ROLES.CLIENT) {
      return res.status(403).json({ error: 'Client access required' });
    }

    const { fileId } = req.params;
    const privateAppToken = process.env.HUBSPOT_PRIVATE_APP_TOKEN;

    if (!privateAppToken) {
      return res.status(500).json({ error: 'HubSpot not configured' });
    }

    const axios = require('axios');

    // Get file details from HubSpot
    const fileResponse = await axios.get(
      `https://api.hubapi.com/files/v3/files/${fileId}`,
      {
        headers: {
          'Authorization': `Bearer ${privateAppToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const fileData = fileResponse.data;

    // Get signed download URL
    const signedUrlResponse = await axios.get(
      `https://api.hubapi.com/files/v3/files/${fileId}/signed-url`,
      {
        headers: {
          'Authorization': `Bearer ${privateAppToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    res.json({
      fileName: fileData.name,
      fileType: fileData.type,
      downloadUrl: signedUrlResponse.data.url,
      size: fileData.size
    });
  } catch (error) {
    console.error('Error getting HubSpot file:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to get file' });
  }
});

// ============== HUBSPOT WEBHOOKS ==============

app.post('/api/webhooks/hubspot', validateHubSpotWebhook, async (req, res) => {
  try {
    const payload = req.body;
    console.log('HubSpot webhook received');
    
    const formType = payload.formType || payload.properties?.hs_form_id || payload.formId || 'unknown';
    const submittedAt = new Date().toISOString();
    const portalId = payload.portalId || '';
    
    const activityLog = (await db.get('activity_log')) || [];
    activityLog.unshift({
      id: require('uuid').v4(),
      action: 'form_submitted',
      formType: formType,
      portalId: portalId,
      timestamp: submittedAt,
      details: `HubSpot form submission received`,
      source: 'hubspot_webhook'
    });
    
    if (activityLog.length > config.ACTIVITY_LOG_MAX_ENTRIES) activityLog.length = config.ACTIVITY_LOG_MAX_ENTRIES;
    await db.set('activity_log', activityLog);
    
    res.json({ success: true, message: 'Webhook received' });
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// ============== HUBSPOT INTEGRATION ==============
app.get('/api/hubspot/test', authenticateToken, async (req, res) => {
  try {
    const result = await hubspot.testConnection();
    res.json(result);
  } catch (error) {
    res.status(500).json({ connected: false, error: error.message });
  }
});

app.get('/api/hubspot/pipelines', authenticateToken, async (req, res) => {
  try {
    const pipelines = await hubspot.getPipelines();
    res.json(pipelines);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/hubspot/record/:recordId', authenticateToken, async (req, res) => {
  try {
    const deal = await hubspot.getRecord(req.params.recordId);
    res.json(deal);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/hubspot/stage-mapping', authenticateToken, async (req, res) => {
  try {
    const mapping = await db.get('hubspot_stage_mapping') || {};
    res.json(mapping);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/hubspot/stage-mapping', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { mapping, pipelineId } = req.body;
    await db.set('hubspot_stage_mapping', { pipelineId, phases: mapping });
    res.json({ message: 'Stage mapping saved' });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Manual HubSpot sync for projects where record ID was added after creation
app.post('/api/projects/:id/hubspot-sync', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== config.ROLES.ADMIN) {
      return res.status(403).json({ error: 'Only admins can trigger manual sync' });
    }
    
    const projects = await getProjects();
    const project = projects.find(p => p.id === req.params.id);
    
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }
    
    if (!project.hubspotRecordId || !hubspot.isValidRecordId(project.hubspotRecordId)) {
      return res.status(400).json({ error: 'Project does not have a valid HubSpot Record ID configured. The ID should be a numeric value.' });
    }
    
    // Use raw tasks for mutation to prevent normalization drift
    let tasks = await getRawTasks(project.id);
    const completedTasks = tasks.filter(t => t.completed);
    
    // Collect all notes from all tasks with their task reference
    const allNotes = [];
    for (const task of tasks) {
      if (task.notes && Array.isArray(task.notes)) {
        for (let i = 0; i < task.notes.length; i++) {
          const note = task.notes[i];
          allNotes.push({
            ...note,
            taskId: task.id,
            noteIndex: i,
            taskTitle: task.taskTitle,
            phase: task.phase,
            stage: task.stage
          });
        }
      }
    }
    
    const hasTasksToSync = completedTasks.length > 0;
    const hasNotesToSync = allNotes.length > 0;
    
    if (!hasTasksToSync && !hasNotesToSync) {
      return res.json({ message: 'No completed tasks or notes to sync', syncedTasks: 0, syncedNotes: 0 });
    }
    
    let syncedTaskCount = 0;
    let updatedTaskCount = 0;
    let skippedTaskCount = 0;
    let syncedNoteCount = 0;
    let updatedNoteCount = 0;
    let skippedNotes = 0;
    let tasksModified = false;
    
    // Sync each completed task
    for (const task of completedTasks) {
      try {
        // Check if task already has a HubSpot ID
        const existingTaskId = task.hubspotTaskId;
        
        // Build task subject and body
        const taskSubject = `[Project Tracker] ${task.taskTitle}`;
        let taskBody = `Phase: ${task.phase}`;
        if (task.stage) {
          taskBody += `\nStage: ${task.stage}`;
        }
        taskBody += `\nCompleted by: Manual Sync`;
        taskBody += `\nCompleted: ${task.dateCompleted || new Date().toISOString()}`;
        
        if (task.notes && task.notes.length > 0) {
          taskBody += `\n\n--- Task Notes ---`;
          task.notes.forEach(note => {
            const noteDate = new Date(note.createdAt || note.timestamp);
            const noteText = note.text || note.content || note.body || '';
            taskBody += `\n[${note.author || note.createdBy || 'Unknown'} - ${noteDate.toLocaleDateString()} ${noteDate.toLocaleTimeString()}]: ${noteText}`;
          });
        }
        
        // Get owner ID if available
        let ownerId = null;
        if (task.owner) {
          const ownerValue = task.owner.trim();
          if (ownerValue.includes('@')) {
            ownerId = await hubspot.findOwnerByEmail(ownerValue);
          } else {
            const nameParts = ownerValue.split(/\s+/);
            if (nameParts.length >= 2) {
              ownerId = await hubspot.findOwnerByName(nameParts[0], nameParts.slice(1).join(' '));
            }
          }
        }
        
        const result = await hubspot.createOrUpdateTask(
          project.hubspotRecordId,
          taskSubject,
          taskBody,
          ownerId,
          existingTaskId
        );
        
        // Store the HubSpot task ID if newly created
        if (result && result.id && !existingTaskId) {
          const taskIdx = tasks.findIndex(t => t.id === task.id);
          if (taskIdx !== -1) {
            tasks[taskIdx].hubspotTaskId = result.id;
            tasks[taskIdx].hubspotSyncedAt = new Date().toISOString();
            tasksModified = true;
          }
          syncedTaskCount++;
        } else if (result && result.updated) {
          updatedTaskCount++;
        }
      } catch (err) {
        console.error(`Failed to sync task ${task.id}:`, err.message);
      }
    }
    
    // Sync all notes
    for (const note of allNotes) {
      try {
        const noteText = note.text || note.content || note.body || note.noteContent || '';
        if (!noteText) {
          console.log(`Skipping note with empty content for task "${note.taskTitle}" (note id: ${note.id || 'unknown'})`);
          skippedNotes++;
          continue;
        }
        
        // Check if note already has a HubSpot ID
        const existingNoteId = note.hubspotNoteId;
        
        const result = await hubspot.syncTaskNoteToRecord(
          project.hubspotRecordId,
          {
            taskTitle: note.taskTitle,
            phase: note.phase,
            stage: note.stage,
            noteContent: noteText,
            author: note.author || note.createdBy || 'Unknown',
            timestamp: note.createdAt || note.timestamp || new Date().toISOString(),
            projectName: project.name
          },
          existingNoteId
        );
        
        // Store the HubSpot note ID if newly created
        if (result && result.id && !existingNoteId) {
          const taskIdx = tasks.findIndex(t => t.id === note.taskId);
          if (taskIdx !== -1 && tasks[taskIdx].notes && tasks[taskIdx].notes[note.noteIndex]) {
            tasks[taskIdx].notes[note.noteIndex].hubspotNoteId = result.id;
            tasks[taskIdx].notes[note.noteIndex].hubspotSyncedAt = new Date().toISOString();
            tasksModified = true;
          }
          syncedNoteCount++;
        } else if (result && result.updated) {
          updatedNoteCount++;
        }
      } catch (err) {
        console.error(`Failed to sync note:`, err.message);
      }
    }
    
    // Save updated tasks with HubSpot IDs
    if (tasksModified) {
      await db.set(`tasks_${project.id}`, tasks);
    }
    
    // Update project with sync timestamp
    const projectIdx = projects.findIndex(p => p.id === project.id);
    if (projectIdx !== -1) {
      projects[projectIdx].lastHubSpotSync = new Date().toISOString();
      await db.set('projects', projects);
    }
    
    // Build summary message
    let messageParts = [];
    if (syncedTaskCount > 0) messageParts.push(`${syncedTaskCount} new tasks`);
    if (updatedTaskCount > 0) messageParts.push(`${updatedTaskCount} updated tasks`);
    if (syncedNoteCount > 0) messageParts.push(`${syncedNoteCount} new notes`);
    if (updatedNoteCount > 0) messageParts.push(`${updatedNoteCount} updated notes`);
    
    let message = messageParts.length > 0 
      ? `Successfully synced to HubSpot: ${messageParts.join(', ')}`
      : 'All items already synced to HubSpot';
    
    if (skippedNotes > 0) {
      message += ` (${skippedNotes} notes skipped due to empty content)`;
    }
    
    res.json({ 
      message,
      syncedTasks: syncedTaskCount,
      updatedTasks: updatedTaskCount,
      totalTasks: completedTasks.length,
      syncedNotes: syncedNoteCount,
      updatedNotes: updatedNoteCount,
      totalNotes: allNotes.length,
      skippedNotes
    });
  } catch (error) {
    console.error('Manual HubSpot sync error:', error);
    res.status(500).json({ error: 'Failed to sync to HubSpot' });
  }
});

// ============== DATE NORMALIZATION ==============
const normalizeDate = (dateStr) => {
  if (!dateStr || typeof dateStr !== 'string') return '';
  dateStr = dateStr.trim();
  if (!dateStr) return '';
  
  // Already in YYYY-MM-DD format
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr;
  
  // Handle MM/DD/YYYY or M/D/YYYY or MM/DD/YY or M/D/YY
  const slashMatch = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (slashMatch) {
    let [, month, day, year] = slashMatch;
    month = month.padStart(2, '0');
    day = day.padStart(2, '0');
    if (year.length === 2) {
      // Use current year as reference: if 2-digit year would be >10 years in the future, assume 1900s
      // This is future-proof unlike a fixed threshold (Gotcha #14)
      const currentCentury = Math.floor(new Date().getFullYear() / 100) * 100;
      const currentYearTwoDigit = new Date().getFullYear() % 100;
      const twoDigitYear = parseInt(year);
      year = twoDigitYear <= (currentYearTwoDigit + 10) ? String(currentCentury + twoDigitYear) : String(currentCentury - 100 + twoDigitYear);
    }
    return `${year}-${month}-${day}`;
  }
  
  // Return as-is if format not recognized
  return dateStr;
};

// ============== FIX CLIENT NAMES (Admin utility) ==============
app.post('/api/projects/:id/fix-client-names', authenticateToken, requireAdmin, async (req, res) => {
  try {
    // Use raw tasks for mutation to prevent normalization drift
    const tasks = await getRawTasks(req.params.id);
    let fixedCount = 0;
    
    tasks.forEach(task => {
      if (task.showToClient && (!task.clientName || task.clientName.trim() === '')) {
        task.clientName = task.taskTitle;
        fixedCount++;
      }
    });
    
    if (fixedCount > 0) {
      await db.set(`tasks_${req.params.id}`, tasks);
    }
    
    res.json({ message: `Fixed ${fixedCount} task client names`, fixedCount });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ============== NORMALIZE ALL PROJECT DATA (Admin utility) ==============
app.post('/api/admin/normalize-all-data', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const projects = await getProjects();
    const stats = {
      projectsProcessed: 0,
      subtasksNormalized: 0,
      slugsRegenerated: 0,
      tasksNormalized: 0
    };
    
    // Collect existing slugs for uniqueness check
    const existingSlugs = new Set();
    
    for (const project of projects) {
      stats.projectsProcessed++;
      
      // Regenerate clientLinkSlug if needed
      if (project.clientName && (!project.clientLinkSlug || project.clientLinkSlug === '')) {
        const newSlug = generateClientSlug(project.clientName, [...existingSlugs]);
        project.clientLinkSlug = newSlug;
        stats.slugsRegenerated++;
      }
      
      if (project.clientLinkSlug) {
        existingSlugs.add(project.clientLinkSlug);
      }
      
      // Normalize tasks and subtasks - use raw tasks for mutation
      const tasks = await getRawTasks(project.id);
      let tasksChanged = false;
      
      for (const task of tasks) {
        // Ensure task has proper ID type (always convert to number for consistency)
        if (typeof task.id === 'string' && !isNaN(parseInt(task.id))) {
          task.id = parseInt(task.id);
          tasksChanged = true;
          stats.tasksNormalized++;
        }
        
        // Normalize subtasks
        if (task.subtasks && task.subtasks.length > 0) {
          for (const subtask of task.subtasks) {
            // Ensure subtask has all required fields
            if (subtask.completed === undefined) {
              subtask.completed = false;
              tasksChanged = true;
              stats.subtasksNormalized++;
            }
            if (subtask.notApplicable === undefined) {
              subtask.notApplicable = false;
              tasksChanged = true;
              stats.subtasksNormalized++;
            }
            if (!subtask.status) {
              if (subtask.notApplicable) {
                subtask.status = 'N/A';
              } else if (subtask.completed) {
                subtask.status = 'Complete';
              } else {
                subtask.status = 'Pending';
              }
              tasksChanged = true;
              stats.subtasksNormalized++;
            }
          }
        }
      }
      
      if (tasksChanged) {
        await db.set(`tasks_${project.id}`, tasks);
      }
    }
    
    // Save updated projects
    await db.set('projects', projects);
    
    res.json({ 
      message: 'Data normalization complete', 
      stats 
    });
  } catch (error) {
    console.error('Data normalization error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============== REGENERATE PROJECT SLUG (Admin utility) ==============
app.post('/api/projects/:id/regenerate-slug', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const projects = await getProjects();
    const idx = projects.findIndex(p => p.id === req.params.id);
    
    if (idx === -1) {
      return res.status(404).json({ error: 'Project not found' });
    }
    
    const existingSlugs = projects
      .filter(p => p.id !== req.params.id)
      .map(p => p.clientLinkSlug)
      .filter(Boolean);
    
    const newSlug = generateClientSlug(projects[idx].clientName, existingSlugs);
    projects[idx].clientLinkSlug = newSlug;
    
    await db.set('projects', projects);
    
    res.json({ 
      message: 'Slug regenerated successfully', 
      clientLinkSlug: newSlug 
    });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ============== CLIENT PORTAL DOMAIN SETTINGS ==============
app.get('/api/settings/client-portal-domain', authenticateToken, async (req, res) => {
  try {
    const domain = await db.get('client_portal_domain') || '';
    res.json({ domain });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/settings/client-portal-domain', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { domain } = req.body;
    // Remove trailing slash if present
    const cleanDomain = domain ? domain.replace(/\/+$/, '') : '';
    await db.set('client_portal_domain', cleanDomain);
    res.json({ message: 'Client portal domain saved', domain: cleanDomain });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

async function checkAndUpdateHubSpotDealStage(projectId) {
  try {
    const projects = await getProjects();
    const project = projects.find(p => p.id === projectId);
    if (!project || !project.hubspotRecordId || !hubspot.isValidRecordId(project.hubspotRecordId)) {
      console.log('📋 HubSpot sync skipped: No project or invalid Record ID');
      return;
    }

    const tasks = await getTasks(projectId);
    const mapping = await db.get('hubspot_stage_mapping');
    if (!mapping || !mapping.phases) {
      console.log('📋 HubSpot sync skipped: No stage mapping configured');
      return;
    }

    console.log('📋 Checking phase completion for HubSpot sync...');
    console.log('📋 Stage mapping:', JSON.stringify(mapping));

    const phases = ['Phase 0', ...config.PHASE_ORDER];
    
    for (let i = phases.length - 1; i >= 0; i--) {
      const phase = phases[i];
      const phaseTasks = tasks.filter(t => t.phase === phase);
      if (phaseTasks.length === 0) continue;
      
      const completedCount = phaseTasks.filter(t => t.completed).length;
      const allCompleted = phaseTasks.every(t => t.completed);
      
      console.log(`📋 ${phase}: ${completedCount}/${phaseTasks.length} tasks completed`);
      
      if (allCompleted && mapping.phases[phase]) {
        const stageId = mapping.phases[phase];
        console.log(`📤 Syncing to HubSpot: ${phase} -> Stage ID: ${stageId}, Pipeline: ${mapping.pipelineId}`);
        
        await hubspot.updateRecordStage(project.hubspotRecordId, stageId, mapping.pipelineId);
        
        const idx = projects.findIndex(p => p.id === projectId);
        if (idx !== -1) {
          projects[idx].hubspotDealStage = stageId;
          projects[idx].lastHubSpotSync = new Date().toISOString();
          await db.set('projects', projects);
        }
        
        console.log(`✅ HubSpot record ${project.hubspotRecordId} moved to stage for ${phase}`);
        break;
      }
    }
  } catch (error) {
    console.error('Error syncing HubSpot deal stage:', error.message);
  }
}

async function logHubSpotActivity(projectId, activityType, details) {
  try {
    const projects = await getProjects();
    const project = projects.find(p => p.id === projectId);
    if (!project || !project.hubspotRecordId || !hubspot.isValidRecordId(project.hubspotRecordId)) return;
    
    await hubspot.logRecordActivity(project.hubspotRecordId, activityType, details);
  } catch (error) {
    console.error('Error logging HubSpot activity:', error.message);
  }
}

async function createHubSpotTask(projectId, task, completedByName) {
  try {
    const projects = await getProjects();
    const project = projects.find(p => p.id === projectId);
    if (!project || !project.hubspotRecordId || !hubspot.isValidRecordId(project.hubspotRecordId)) return;
    
    // Build task subject
    const taskSubject = `[Project Tracker] ${task.taskTitle}`;
    
    // Build task body with all details including notes
    let taskBody = `Phase: ${task.phase}`;
    if (task.stage) {
      taskBody += `\nStage: ${task.stage}`;
    }
    taskBody += `\nCompleted by: ${completedByName}`;
    taskBody += `\nCompleted: ${task.dateCompleted || new Date().toISOString()}`;
    
    // Include all task notes
    if (task.notes && task.notes.length > 0) {
      taskBody += `\n\n--- Task Notes ---`;
      task.notes.forEach(note => {
        const noteDate = new Date(note.createdAt);
        const noteText = note.text || note.content || note.body || '';
        taskBody += `\n[${note.author || note.createdBy || 'Unknown'} - ${noteDate.toLocaleDateString()} ${noteDate.toLocaleTimeString()}]: ${noteText}`;
      });
    }
    
    // Try to find owner in HubSpot by email (preferred) or name
    let ownerId = null;
    if (task.owner) {
      const ownerValue = task.owner.trim();
      
      // Check if owner is an email address
      if (ownerValue.includes('@')) {
        ownerId = await hubspot.findOwnerByEmail(ownerValue);
      } else {
        // Fall back to name matching
        const nameParts = ownerValue.split(/\s+/);
        if (nameParts.length >= 2) {
          const firstName = nameParts[0];
          const lastName = nameParts.slice(1).join(' ');
          ownerId = await hubspot.findOwnerByName(firstName, lastName);
          if (ownerId) {
            console.log(`📋 Found HubSpot owner by name "${task.owner}": ${ownerId}`);
          }
        }
      }
    }
    
    // Check if task already has a HubSpot ID (use update) or create new
    const existingTaskId = task.hubspotTaskId;
    const result = await hubspot.createOrUpdateTask(project.hubspotRecordId, taskSubject, taskBody, ownerId, existingTaskId);
    
    // Store HubSpot task ID if newly created
    if (result && result.id && !existingTaskId) {
      try {
        // Use raw tasks for mutation to prevent normalization drift
        const tasks = await getRawTasks(projectId);
        const taskIdx = tasks.findIndex(t => t.id === task.id || String(t.id) === String(task.id));
        if (taskIdx !== -1) {
          tasks[taskIdx].hubspotTaskId = result.id;
          tasks[taskIdx].hubspotSyncedAt = new Date().toISOString();
          await db.set(`tasks_${projectId}`, tasks);
          console.log(`📋 Stored HubSpot task ID ${result.id} for task "${task.taskTitle}"`);
        }
      } catch (err) {
        console.error('Failed to save HubSpot task ID:', err.message);
      }
    }
    
    return result;
  } catch (error) {
    console.error('Error creating HubSpot task:', error.message);
  }
}

async function checkPhaseCompletion(projectId, tasks, completedTask) {
  try {
    const projects = await getProjects();
    const project = projects.find(p => p.id === projectId);
    if (!project || !project.hubspotRecordId || !hubspot.isValidRecordId(project.hubspotRecordId)) {
      console.log('📋 HubSpot sync skipped: No project or invalid Record ID');
      return;
    }

    const phase = completedTask.phase;

    // Check if entire phase is completed
    const phaseTasks = tasks.filter(t => t.phase === phase);
    const phaseCompleted = phaseTasks.length > 0 && phaseTasks.every(t => t.completed);

    if (phaseCompleted) {
      console.log(`📤 ${phase} completed - Building HubSpot notification`);

      // Build phase completion note reflecting this board's actual task organization.
      // Tasks with a non-empty clientName act as section headers; tasks following them
      // with an empty clientName fall under that section. This mirrors each board's
      // unique phase/task structure rather than any hardcoded grouping.
      let phaseDetails = `${phase} is now complete! ✓`;
      phaseDetails += `\n\nAll ${phaseTasks.length} tasks completed.`;

      for (const task of phaseTasks) {
        if (task.clientName && task.clientName.trim()) {
          // Section header — starts a named group
          phaseDetails += `\n\n━━ ${task.clientName.trim()} ━━`;
        }

        phaseDetails += `\n  ✓ ${task.taskTitle}`;
        if (task.owner) phaseDetails += `\n    Owner: ${task.owner}`;
        if (task.dateCompleted) {
          const d = new Date(task.dateCompleted);
          phaseDetails += `\n    Completed: ${d.toLocaleDateString()} at ${d.toLocaleTimeString()}`;
        }
        if (task.notes && task.notes.length > 0) {
          task.notes.forEach(note => {
            const nd = new Date(note.createdAt);
            const noteText = note.text || note.content || note.body || '';
            phaseDetails += `\n    ↳ [${note.author || note.createdBy || 'Unknown'} - ${nd.toLocaleDateString()}]: ${noteText}`;
          });
        }
      }

      await hubspot.logRecordActivity(project.hubspotRecordId, `${phase} Completed`, phaseDetails);

      // Update deal pipeline stage if a mapping is configured for this phase
      const mapping = await db.get('hubspot_stage_mapping');
      if (mapping && mapping.phases && mapping.phases[phase]) {
        const stageId = mapping.phases[phase];
        console.log(`📤 ${phase} completed - Syncing to HubSpot pipeline stage: ${stageId}`);
        await hubspot.updateRecordStage(project.hubspotRecordId, stageId, mapping.pipelineId);

        const idx = projects.findIndex(p => p.id === projectId);
        if (idx !== -1) {
          projects[idx].hubspotDealStage = stageId;
          projects[idx].lastHubSpotSync = new Date().toISOString();
          await db.set('projects', projects);
        }

        console.log(`✅ HubSpot record ${project.hubspotRecordId} moved to pipeline stage for ${phase}`);
      } else {
        console.log(`📋 ${phase} completed - no pipeline stage mapping configured`);
      }
    }
  } catch (error) {
    console.error('Error in phase completion check:', error.message);
  }
}

// Auto-update Phase 8 tasks when validation events occur
// Matches service report client to project, then marks relevant Phase 8 tasks complete
async function autoUpdatePhase8Tasks(reportData, eventType, technicianName) {
  try {
    const projects = await getProjects();
    const clientFacility = (reportData.clientFacilityName || '').toLowerCase();
    const reportCompanyId = reportData.hubspotCompanyId || '';

    // Find matching project by HubSpot company ID or client name
    const project = projects.find(p => {
      if (reportCompanyId && p.hubspotRecordId && String(p.hubspotRecordId) === String(reportCompanyId)) return true;
      if (reportCompanyId && p.hubspotCompanyId && String(p.hubspotCompanyId) === String(reportCompanyId)) return true;
      if (clientFacility && p.clientName?.toLowerCase() === clientFacility) return true;
      if (clientFacility && p.name?.toLowerCase().includes(clientFacility)) return true;
      return false;
    });

    if (!project) {
      console.log(`⚠️ Phase 8 auto-update: No matching project for "${reportData.clientFacilityName}"`);
      return;
    }

    const tasks = await getRawTasks(project.id);
    const phase8Tasks = tasks.filter(t => t.phase === 'Phase 8');
    if (phase8Tasks.length === 0) {
      console.log(`⚠️ Phase 8 auto-update: No Phase 8 tasks in project ${project.id}`);
      return;
    }

    let tasksUpdated = 0;
    const now = new Date().toISOString();

    // Task title patterns to match for each event type
    // Uses lowercase includes() for flexible matching across different template versions
    const markComplete = (task) => {
      if (!task.completed) {
        task.completed = true;
        task.dateCompleted = now;
        tasksUpdated++;
      }
    };

    if (eventType === 'validation_started') {
      // When validation starts: mark setup/prep tasks complete
      phase8Tasks.forEach(task => {
        const title = (task.taskTitle || '').toLowerCase();
        if (title.includes('training & validation') ||
            title.includes('review install sop') ||
            title.includes('begin validation') ||
            title.includes('setup reagents') ||
            title.includes('setup cals') ||
            title.includes('setup qcs')) {
          markComplete(task);
        }
      });
    } else if (eventType === 'validation_completed') {
      // When validation completes: mark ALL Phase 8 tasks complete
      // This covers all study tasks (intraprecision, interprecision, linearity, etc.)
      phase8Tasks.forEach(task => {
        markComplete(task);
      });
    }

    if (tasksUpdated > 0) {
      await db.set(`tasks_${project.id}`, tasks);

      await logActivity(
        'system',
        'System',
        'phase8_auto_updated',
        'project',
        project.id,
        {
          event: eventType,
          tasksCompleted: tasksUpdated,
          clientName: reportData.clientFacilityName,
          technician: technicianName
        }
      );

      console.log(`✅ Phase 8 auto-update: ${tasksUpdated} tasks marked complete in project "${project.name}" (${eventType})`);

      // Trigger phase completion check for HubSpot sync
      const updatedTasks = await getTasks(project.id);
      const lastCompleted = updatedTasks.find(t => t.phase === 'Phase 8' && t.completed);
      if (lastCompleted) {
        await checkPhaseCompletion(project.id, updatedTasks, lastCompleted);
      }
    }

    return { projectId: project.id, projectName: project.name, tasksUpdated };
  } catch (error) {
    console.error('Phase 8 auto-update error (non-blocking):', error.message);
  }
}

// ============== REPORTING ==============
app.get('/api/reporting', authenticateToken, async (req, res) => {
  try {
    const projects = await getProjects();
    const reportingData = [];
    
    for (const project of projects) {
      const tasks = await getTasks(project.id);
      
      // Find contract signed task and first live patient samples task
      const contractTask = tasks.find(t => 
        t.taskTitle && t.taskTitle.toLowerCase().includes('contract signed')
      );
      const goLiveTask = tasks.find(t => 
        t.taskTitle && t.taskTitle.toLowerCase().includes('first live patient samples')
      );
      
      let launchDurationWeeks = null;
      if (contractTask?.dateCompleted && goLiveTask?.dateCompleted) {
        const contractDate = new Date(contractTask.dateCompleted);
        const goLiveDate = new Date(goLiveTask.dateCompleted);
        const diffMs = goLiveDate - contractDate;
        launchDurationWeeks = Math.round(diffMs / (7 * 24 * 60 * 60 * 1000));
      }
      
      const totalTasks = tasks.length;
      const completedTasks = tasks.filter(t => t.completed).length;
      
      reportingData.push({
        id: project.id,
        name: project.name,
        clientName: project.clientName,
        status: project.status || 'active',
        totalTasks,
        completedTasks,
        progressPercent: totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0,
        contractSignedDate: contractTask?.dateCompleted || null,
        goLiveDate: goLiveTask?.dateCompleted || null,
        launchDurationWeeks
      });
    }
    
    res.json(reportingData);
  } catch (error) {
    console.error('Error generating reporting data:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============== EXPORT ==============
const escapeCSV = (value) => {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
};

const PHASE_NAMES = {
  'Phase 1': 'Phase 1: Contract & Initial Setup',
  'Phase 2': 'Phase 2: Financials, CLIA & Hiring',
  'Phase 3': 'Phase 3: Tech Infrastructure & LIS Integration',
  'Phase 4': 'Phase 4: Inventory Forecasting & Procurement',
  'Phase 5': 'Phase 5: Supply Orders & Logistics',
  'Phase 6': 'Phase 6: Onboarding & Welcome Calls',
  'Phase 7': 'Phase 7: Virtual Soft Pilot & Prep',
  'Phase 8': 'Phase 8: Training & Full Validation',
  'Phase 9': 'Phase 9: Go-Live',
  'Phase 10': 'Phase 10: Post-Launch Support & Optimization'
};

app.get('/api/projects/:id/export', authenticateToken, async (req, res) => {
  try {
    // Check project access
    if (!canAccessProject(req.user, req.params.id)) {
      return res.status(403).json({ error: 'Access denied to this project' });
    }

    const projects = await getProjects();
    const project = projects.find(p => p.id === req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const tasks = await getTasks(req.params.id);

    const headers = ['id', 'phase', 'stage', 'taskTitle', 'isSubtask', 'parentTaskId', 'subtaskStatus', 'owner', 'startDate', 'dueDate', 'showToClient', 'clientName', 'completed', 'dateCompleted', 'tags', 'dependencies', 'notes'];

    const rows = [];
    tasks.forEach(t => {
      const fullPhase = PHASE_NAMES[t.phase] || t.phase || '';
      // Parent task row
      rows.push([
        t.id,
        fullPhase,
        t.stage || '',
        t.taskTitle || '',
        'false',
        '',
        '',
        t.owner || '',
        t.startDate || '',
        t.dueDate || '',
        t.showToClient ? 'true' : 'false',
        t.clientName || '',
        t.completed ? 'true' : 'false',
        t.dateCompleted || '',
        Array.isArray(t.tags) ? t.tags.join(';') : '',
        Array.isArray(t.dependencies) ? t.dependencies.join(';') : '',
        Array.isArray(t.notes) ? t.notes.map(n => n.content || n.text || '').join(' | ') : ''
      ].map(escapeCSV));
      // Subtask rows
      if (Array.isArray(t.subtasks)) {
        t.subtasks.forEach(st => {
          rows.push([
            st.id,
            fullPhase,
            t.stage || '',
            st.title || '',
            'true',
            t.id,
            st.status || (st.completed ? 'Completed' : (st.notApplicable ? 'N/A' : 'Pending')),
            st.owner || '',
            '',
            st.dueDate || '',
            st.showToClient ? 'true' : 'false',
            '',
            st.completed ? 'true' : 'false',
            '',
            '',
            '',
            ''
          ].map(escapeCSV));
        });
      }
    });

    const csv = [headers.join(','), ...rows.map(row => row.join(','))].join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${project.name.replace(/[^a-zA-Z0-9]/g, '_')}.csv"`);
    res.send(csv);
  } catch (error) {
    console.error('Export error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Template Management (Admin only)
app.get('/api/templates', authenticateToken, async (req, res) => {
  try {
    let templates = await db.get('templates') || [];
    
    // If no templates in DB, load the default one from file
    if (templates.length === 0) {
      const defaultTemplate = await loadTemplate();
      templates = [{
        id: 'biolis-au480-clia',
        name: 'Biolis AU480 with CLIA Upgrade',
        description: '102-task template for laboratory equipment installations',
        tasks: defaultTemplate,
        createdAt: new Date().toISOString(),
        isDefault: true
      }];
      await db.set('templates', templates);
    }
    
    // Return templates without full task lists (just metadata)
    const templateMeta = templates.map(t => ({
      id: t.id,
      name: t.name,
      description: t.description,
      taskCount: Array.isArray(t.tasks) ? t.tasks.length : 0,
      createdAt: t.createdAt,
      isDefault: t.isDefault
    }));
    
    res.json(templateMeta);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/templates/:id', authenticateToken, async (req, res) => {
  try {
    const templates = await db.get('templates') || [];
    const template = templates.find(t => t.id === req.params.id);
    
    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }
    
    res.json(template);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/templates/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const templates = await db.get('templates') || [];
    const idx = templates.findIndex(t => t.id === req.params.id);
    
    if (idx === -1) {
      return res.status(404).json({ error: 'Template not found' });
    }
    
    const { name, description, tasks } = req.body;
    
    if (name) templates[idx].name = name;
    if (description) templates[idx].description = description;
    if (tasks) templates[idx].tasks = tasks;
    templates[idx].updatedAt = new Date().toISOString();
    
    await db.set('templates', templates);
    res.json(templates[idx]);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/templates', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const templates = await db.get('templates') || [];
    const { name, description, tasks } = req.body;
    
    if (!name || !tasks || !Array.isArray(tasks) || tasks.length === 0) {
      return res.status(400).json({ error: 'Name and tasks are required (tasks must be a non-empty array)' });
    }
    
    const newTemplate = {
      id: uuidv4(),
      name,
      description: description || '',
      tasks,
      createdAt: new Date().toISOString(),
      isDefault: false
    };
    
    templates.push(newTemplate);
    await db.set('templates', templates);
    res.status(201).json(newTemplate);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Clone/Duplicate a template
app.post('/api/templates/:id/clone', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const templates = await db.get('templates') || [];
    const originalTemplate = templates.find(t => t.id === req.params.id);
    
    if (!originalTemplate) {
      return res.status(404).json({ error: 'Template not found' });
    }
    
    const { name } = req.body;
    
    const newTemplate = {
      id: uuidv4(),
      name: name || `${originalTemplate.name} (Copy)`,
      description: originalTemplate.description || '',
      tasks: originalTemplate.tasks.map(task => ({ ...task })),
      createdAt: new Date().toISOString(),
      isDefault: false
    };
    
    templates.push(newTemplate);
    await db.set('templates', templates);
    res.status(201).json(newTemplate);
  } catch (error) {
    console.error('Clone template error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Import CSV tasks to a template
app.post('/api/templates/:id/import-csv', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const templates = await db.get('templates') || [];
    const template = templates.find(t => t.id === req.params.id);
    
    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }
    
    const { csvData } = req.body;
    if (!csvData || !Array.isArray(csvData)) {
      return res.status(400).json({ error: 'CSV data is required' });
    }
    
    // Generate new IDs for imported tasks and create ID mapping
    const maxId = getNextNumericId(template.tasks) - 1;
    const idMapping = {};
    
    const newTasks = csvData.map((row, index) => {
      const taskTitle = row.taskTitle || row.title || row.task || '';
      const showToClient = ['true', 'yes', '1'].includes(String(row.showToClient || '').toLowerCase());
      const completed = ['true', 'yes', '1'].includes(String(row.completed || '').toLowerCase());
      const newId = maxId + index + 1;
      
      // Store mapping from original ID to new ID
      if (row.id) {
        idMapping[String(row.id).trim()] = newId;
      }
      
      return {
        id: newId,
        phase: row.phase || 'Phase 1',
        stage: row.stage || '',
        taskTitle: taskTitle,
        clientName: showToClient ? (row.clientName || taskTitle) : '',
        owner: row.owner || '',
        startDate: normalizeDate(row.startDate),
        dueDate: normalizeDate(row.dueDate),
        dateCompleted: completed ? (normalizeDate(row.dateCompleted) || new Date().toISOString().split('T')[0]) : '',
        duration: parseInt(row.duration) || 0,
        completed: completed,
        showToClient: showToClient,
        rawDependencies: row.dependencies || ''
      };
    }).filter(t => t.taskTitle);
    
    // Remap dependencies using the ID mapping
    newTasks.forEach(task => {
      if (task.rawDependencies) {
        const depStrings = String(task.rawDependencies).split(',').map(d => d.trim()).filter(d => d);
        task.dependencies = depStrings.map(depId => {
          if (idMapping[depId]) {
            return idMapping[depId];
          }
          const numId = parseInt(depId);
          if (!isNaN(numId)) {
            const existingTask = template.tasks.find(t => t.id === numId);
            if (existingTask) return numId;
            if (idMapping[depId]) return idMapping[depId];
          }
          return null;
        }).filter(d => d !== null);
      } else {
        task.dependencies = [];
      }
      delete task.rawDependencies;
    });
    
    template.tasks = [...template.tasks, ...newTasks];
    template.updatedAt = new Date().toISOString();
    
    await db.set('templates', templates);
    res.json({ message: `Imported ${newTasks.length} tasks`, template });
  } catch (error) {
    console.error('Import CSV to template error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Import CSV tasks to a project
app.post('/api/projects/:id/import-csv', authenticateToken, async (req, res) => {
  try {
    // Check project access
    if (!canAccessProject(req.user, req.params.id)) {
      return res.status(403).json({ error: 'Access denied to this project' });
    }
    
    const projects = await getProjects();
    const project = projects.find(p => p.id === req.params.id);
    
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }
    
    const { csvData } = req.body;
    if (!csvData || !Array.isArray(csvData)) {
      return res.status(400).json({ error: 'CSV data is required' });
    }
    
    // Use raw tasks for mutation to prevent normalization drift
    const tasks = await getRawTasks(req.params.id);
    const maxId = getNextNumericId(tasks) - 1;
    
    // Separate parent tasks and subtasks
    const parentRows = csvData.filter(row => {
      const isSubtask = String(row.isSubtask || '').toLowerCase();
      return isSubtask !== 'true' && isSubtask !== 'yes' && isSubtask !== '1';
    });
    const subtaskRows = csvData.filter(row => {
      const isSubtask = String(row.isSubtask || '').toLowerCase();
      return isSubtask === 'true' || isSubtask === 'yes' || isSubtask === '1';
    });
    
    // Create ID mapping from original CSV IDs to new IDs
    const idMapping = {};
    
    // Create parent tasks first (with temporary dependencies as strings)
    const newTasks = parentRows.map((row, index) => {
      const taskTitle = row.taskTitle || row.title || row.task || '';
      const showToClient = ['true', 'yes', '1'].includes(String(row.showToClient || '').toLowerCase());
      const completed = ['true', 'yes', '1'].includes(String(row.completed || '').toLowerCase());
      const newId = maxId + index + 1;
      
      // Store mapping from original ID to new ID (if original ID exists)
      if (row.id) {
        idMapping[String(row.id).trim()] = newId;
      }
      // Also map by row index for position-based references
      idMapping[`row_${index}`] = newId;
      
      return {
        id: newId,
        originalId: row.id ? String(row.id).trim() : null,
        phase: row.phase || 'Phase 1',
        stage: row.stage || '',
        taskTitle: taskTitle,
        clientName: showToClient ? (row.clientName || taskTitle) : '',
        owner: row.owner || '',
        startDate: normalizeDate(row.startDate),
        dueDate: normalizeDate(row.dueDate),
        dateCompleted: completed ? (normalizeDate(row.dateCompleted) || new Date().toISOString().split('T')[0]) : '',
        duration: parseInt(row.duration) || 0,
        completed: completed,
        showToClient: showToClient,
        rawDependencies: row.dependencies || '',
        dependencies: [],
        notes: [],
        subtasks: [],
        createdBy: req.user.id,
        createdAt: new Date().toISOString()
      };
    }).filter(t => t.taskTitle);
    
    // Now remap dependencies using the ID mapping
    newTasks.forEach(task => {
      if (task.rawDependencies) {
        const depStrings = String(task.rawDependencies).split(',').map(d => d.trim()).filter(d => d);
        task.dependencies = depStrings.map(depId => {
          // First try direct mapping
          if (idMapping[depId]) {
            return idMapping[depId];
          }
          // Then try parsing as number and finding in existing tasks
          const numId = parseInt(depId);
          if (!isNaN(numId)) {
            // Check if it's an existing task ID
            const existingTask = tasks.find(t => t.id === numId);
            if (existingTask) {
              return numId;
            }
            // Check if it matches any new task's original ID
            const mappedId = idMapping[depId];
            if (mappedId) {
              return mappedId;
            }
          }
          return null;
        }).filter(d => d !== null);
      }
      delete task.rawDependencies;
      delete task.originalId;
    });
    
    // Add subtasks to their parent tasks
    let subtasksAdded = 0;
    const allTasks = [...tasks, ...newTasks];
    
    for (const row of subtaskRows) {
      const parentIdStr = String(row.parentTaskId || '').trim();
      if (!parentIdStr) continue;
      
      // Try to find parent using the ID mapping first, then direct lookup
      let parentTask = null;
      if (idMapping[parentIdStr]) {
        parentTask = allTasks.find(t => t.id === idMapping[parentIdStr]);
      }
      if (!parentTask) {
        const numId = parseInt(parentIdStr);
        if (!isNaN(numId)) {
          parentTask = allTasks.find(t => t.id === numId);
        }
      }
      
      if (parentTask) {
        if (!parentTask.subtasks) parentTask.subtasks = [];
        parentTask.subtasks.push({
          id: Date.now() + Math.random(),
          title: row.taskTitle || row.title || row.task || '',
          owner: row.owner || '',
          dueDate: normalizeDate(row.dueDate) || '',
          status: row.subtaskStatus || 'Pending',
          completed: ['true', 'yes', '1', 'complete', 'completed'].includes(String(row.subtaskStatus || row.completed || '').toLowerCase()),
          notApplicable: ['n/a', 'na', 'not_applicable', 'not applicable'].includes(String(row.subtaskStatus || '').toLowerCase())
        });
        subtasksAdded++;
      }
    }
    
    await db.set(`tasks_${req.params.id}`, allTasks);
    
    const message = subtasksAdded > 0 
      ? `Imported ${newTasks.length} tasks and ${subtasksAdded} subtasks`
      : `Imported ${newTasks.length} tasks`;
    res.json({ message, tasks: newTasks });
  } catch (error) {
    console.error('Import CSV to project error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/templates/:id/set-default', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const templates = await db.get('templates') || [];
    const template = templates.find(t => t.id === req.params.id);
    
    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }
    
    // Remove default from all templates, then set this one as default
    templates.forEach(t => {
      t.isDefault = (t.id === req.params.id);
    });
    
    await db.set('templates', templates);
    res.json({ message: `"${template.name}" is now the default template` });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/templates/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const templates = await db.get('templates') || [];
    const template = templates.find(t => t.id === req.params.id);
    
    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }
    
    if (template.isDefault) {
      return res.status(400).json({ error: 'Cannot delete default template' });
    }
    
    const filtered = templates.filter(t => t.id !== req.params.id);
    await db.set('templates', filtered);
    res.json({ message: 'Template deleted' });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ============== LAUNCH PORTAL SLUG ROUTES ==============
// Internal project tracker: /launch/{slug}-internal (authenticated team access)
app.get('/launch/:slug-internal', async (req, res) => {
  res.redirect('/login'); // tracker deactivated (Session 2)
});

// Public client launch board: /launch/{slug} (no auth required)
app.get('/launch/:slug', async (req, res) => {
  res.redirect('/login'); // tracker deactivated (Session 2)
});

// ============== LEGACY LAUNCH ROUTES (Redirects) ==============
// Redirect old /thrive365labslaunch paths to new /launch paths
app.get('/thrive365labslaunch/login', (req, res) => {
  res.redirect(301, '/launch/login');
});
app.get('/thrive365labsLAUNCH/login', (req, res) => {
  res.redirect(301, '/launch/login');
});
app.get('/thrive365labslaunch/home', (req, res) => {
  res.redirect(301, '/launch/home');
});
app.get('/thrive365labsLAUNCH/home', (req, res) => {
  res.redirect(301, '/launch/home');
});
app.get('/thrive365labslaunch/:slug-internal', async (req, res) => {
  res.redirect(301, `/launch/${req.params.slug}-internal`);
});
app.get('/thrive365labsLAUNCH/:slug-internal', async (req, res) => {
  res.redirect(301, `/launch/${req.params.slug}-internal`);
});
app.get('/thrive365labsLAUNCH/:slug', async (req, res) => {
  res.redirect(301, `/launch/${req.params.slug}`);
});
app.get('/thrive365labslaunch/:slug', async (req, res) => {
  res.redirect(301, `/launch/${req.params.slug}`);
});

// ============== SERVICE PORTAL ROUTES ==============

// Service portal login - restricted to users with hasServicePortalAccess or admins
app.post('/api/auth/service-login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Missing credentials' });
    }
    const users = await getUsers();
    const user = users.find(u => u.email?.toLowerCase() === email.toLowerCase());
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(400).json({ error: 'Invalid credentials' });
    }
    // Block inactive accounts from logging in
    if (user.accountStatus === 'inactive') {
      return res.status(403).json({ error: 'Account is inactive. Please contact an administrator.' });
    }

    // Check if user has service portal access
    if (user.role !== config.ROLES.ADMIN && !user.hasServicePortalAccess) {
      return res.status(403).json({ error: 'Access denied. You do not have Service Portal access. Please contact an administrator.' });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, name: user.name, role: user.role, hasServicePortalAccess: user.hasServicePortalAccess },
      JWT_SECRET,
      { expiresIn: config.JWT_EXPIRY }
    );
    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        hasServicePortalAccess: user.hasServicePortalAccess || user.role === config.ROLES.ADMIN
      }
    });
  } catch (error) {
    console.error('Service login error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Middleware to check service portal access
const requireServiceAccess = (req, res, next) => {
  // Super Admins always have access
  if (req.user.role === config.ROLES.ADMIN) return next();
  // Managers have access to service portal (part of their Admin Hub access)
  if (req.user.isManager) return next();
  // Vendors always have service portal access
  if (req.user.role === config.ROLES.VENDOR) return next();
  // Users with explicit service portal access
  if (req.user.hasServicePortalAccess) return next();
  return res.status(403).json({ error: 'Service portal access required' });
};

// Get service portal data
app.get('/api/service-portal/data', authenticateToken, requireServiceAccess, async (req, res) => {
  try {
    const serviceReports = (await db.get('service_reports')) || [];
    const isAdminOrManager = req.user.role === config.ROLES.ADMIN || (req.user.isManager && req.user.hasServicePortalAccess);
    let userReports;

    if (isAdminOrManager) {
      // Super Admins and Managers with Service Portal access see all reports
      userReports = serviceReports;
    } else if (req.user.role === config.ROLES.VENDOR) {
      // Vendors see their own reports + reports assigned to them + reports for their assigned clients
      const assignedClients = req.user.assignedClients || [];
      userReports = serviceReports.filter(r =>
        r.technicianId === req.user.id ||
        r.assignedToId === req.user.id ||
        assignedClients.includes(r.clientFacilityName)
      );
    } else {
      // Regular users with service access see their own reports + reports assigned to them
      userReports = serviceReports.filter(r =>
        r.technicianId === req.user.id ||
        r.assignedToId === req.user.id
      );
    }

    // For admin stats: count open (assigned) and closed (submitted) across ALL reports
    const openCount = serviceReports.filter(r => r.status === 'assigned').length;
    const closedCount = serviceReports.filter(r => r.status === 'submitted').length;

    // Exclude assigned reports from recentReports since they're tracked separately in assignedReports
    // This prevents double-counting in the "My Reports" counter
    userReports = userReports.filter(r => r.status !== 'assigned');

    // Sort by date descending
    userReports.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    res.json({
      recentReports: userReports.slice(0, 10),
      totalReports: userReports.length,
      // Admin-specific stats for dashboard
      isAdminView: isAdminOrManager,
      allReportsCount: serviceReports.length,
      openCount,
      closedCount
    });
  } catch (error) {
    console.error('Service portal data error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get clients list for service portal
app.get('/api/service-portal/clients', authenticateToken, requireServiceAccess, async (req, res) => {
  try {
    const projects = await getProjects();
    const users = await getUsers();

    // Get unique clients from projects
    const clientMap = new Map();

    projects.forEach(project => {
      if (project.clientName && !clientMap.has(project.clientName)) {
        clientMap.set(project.clientName, {
          name: project.clientName,
          clientName: project.clientName,
          address: project.clientAddress || '',
          projectId: project.id,
          hubspotCompanyId: project.hubspotCompanyId || null,
          hubspotRecordId: project.hubspotRecordId || null
        });
      }
    });

    // Also add client users (with HubSpot IDs)
    users.filter(u => u.role === config.ROLES.CLIENT).forEach(user => {
      if (user.practiceName) {
        // If client already exists from project, merge HubSpot IDs
        if (clientMap.has(user.practiceName)) {
          const existing = clientMap.get(user.practiceName);
          if (!existing.hubspotCompanyId && user.hubspotCompanyId) {
            existing.hubspotCompanyId = user.hubspotCompanyId;
          }
        } else {
          clientMap.set(user.practiceName, {
            name: user.practiceName,
            clientName: user.practiceName,
            address: '',
            userId: user.id,
            hubspotCompanyId: user.hubspotCompanyId || null
          });
        }
      }
    });

    let clientList = Array.from(clientMap.values());

    // Vendors only see their assigned clients
    if (req.user.role === config.ROLES.VENDOR) {
      const assignedClients = req.user.assignedClients || [];
      clientList = clientList.filter(c => assignedClients.includes(c.name) || assignedClients.includes(c.clientName));
    }

    res.json(clientList);
  } catch (error) {
    console.error('Get clients error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Create service report
app.post('/api/service-reports', authenticateToken, requireServiceAccess, async (req, res) => {
  try {
    const reportData = req.body;
    const serviceReports = (await db.get('service_reports')) || [];

    // Resolve clientSlug if not already provided
    const resolvedSlug = reportData.clientSlug || await resolveClientSlug(reportData.clientFacilityName, reportData.hubspotCompanyId);

    // Determine status based on customer signature (same logic as /complete endpoint)
    // A blank canvas toDataURL() is ~6000 chars; require > 7000 to ensure actual drawing content
    const hasCustomerSignature = reportData.customerSignature && typeof reportData.customerSignature === 'string'
      && reportData.customerSignature.startsWith('data:image') && reportData.customerSignature.length > 7000;
    const reportStatus = hasCustomerSignature ? 'submitted' : 'signature_needed';

    const newReport = {
      id: uuidv4(),
      ...reportData,
      status: reportStatus,
      clientSlug: resolvedSlug,
      technicianId: req.user.id,
      technicianName: req.user.name,
      createdAt: new Date().toISOString(),
      submittedAt: hasCustomerSignature ? new Date().toISOString() : null,
      updatedAt: new Date().toISOString()
    };

    serviceReports.push(newReport);
    await db.set('service_reports', serviceReports);

    // Log activity
    await logActivity(
      req.user.id,
      req.user.name,
      'service_report_created',
      'service_report',
      newReport.id,
      { clientName: reportData.clientFacilityName, serviceType: reportData.serviceType }
    );

    // Upload to HubSpot if company ID is available
    if (reportData.hubspotCompanyId && hubspot.isValidRecordId(reportData.hubspotCompanyId)) {
      try {
        const reportDate = new Date(reportData.serviceCompletionDate || newReport.createdAt).toLocaleDateString();

        // Generate PDF service report
        console.log(`📄 Generating PDF for service report: ${reportData.clientFacilityName}`);
        const pdfBuffer = await pdfGenerator.generateServiceReportPDF({ ...reportData, id: newReport.id }, req.user.name);

        const fileName = `Service_Report_${reportData.clientFacilityName.replace(/[^a-zA-Z0-9]/g, '_')}_${reportDate.replace(/\//g, '-')}.pdf`;
        const noteText = `Service Report Submitted\n\nClient: ${reportData.clientFacilityName}\nService Type: ${reportData.serviceType}\nTechnician: ${reportData.serviceProviderName || req.user.name}\nTicket #: ${reportData.hubspotTicketNumber || 'N/A'}`;

        const uploadResult = await hubspot.uploadFileAndAttachToRecord(
          reportData.hubspotCompanyId,
          pdfBuffer.toString('base64'),
          fileName,
          noteText,
          {
            recordType: 'companies',
            folderPath: '/service-reports',
            notePrefix: '[Service Portal]',
            isBase64: true
          }
        );

        // Store HubSpot reference in the report
        newReport.hubspotFileId = uploadResult.fileId;
        newReport.hubspotNoteId = uploadResult.noteId;
        await db.set('service_reports', serviceReports);

        console.log(`✅ Service report PDF uploaded to HubSpot for company ${reportData.hubspotCompanyId}`);

        // Create HubSpot ticket with service report attached (for ALL service types)
        try {
          const ticketResult = await hubspot.createTicketWithFile(
            {
              subject: `Service Report: ${reportData.clientFacilityName} - ${reportData.serviceType}`,
              content: `Service Report Submitted\n\nClient: ${reportData.clientFacilityName}\nService Type: ${reportData.serviceType}\nTechnician: ${reportData.serviceProviderName || req.user.name}\nDate: ${reportDate}\n\nDescription: ${reportData.descriptionOfWork || reportData.validationResults || 'See attached report'}`,
              priority: 'LOW',
              isBase64: true
            },
            pdfBuffer.toString('base64'),
            fileName,
            reportData.hubspotCompanyId
          );

          newReport.hubspotTicketId = ticketResult.ticketId;
          newReport.hubspotTicketFileId = ticketResult.fileId;
          await db.set('service_reports', serviceReports);
          console.log(`✅ HubSpot ticket created for service report: ${ticketResult.ticketId}`);
        } catch (ticketError) {
          console.error('HubSpot ticket creation error (non-blocking):', ticketError.message);
        }
      } catch (hubspotError) {
        console.error('HubSpot upload error (non-blocking):', hubspotError.message);
        // Don't fail the request if HubSpot upload fails
      }
    }

    // Also upload to Deal record if hubspotDealId is available
    if (reportData.hubspotDealId && hubspot.isValidRecordId(reportData.hubspotDealId)) {
      try {
        const reportDate = new Date(reportData.serviceCompletionDate || newReport.createdAt).toLocaleDateString();
        const fileName = `Service_Report_${reportData.clientFacilityName.replace(/[^a-zA-Z0-9]/g, '_')}_${reportDate.replace(/\//g, '-')}.pdf`;
        const noteText = `Service Report Submitted\n\nClient: ${reportData.clientFacilityName}\nService Type: ${reportData.serviceType}\nTechnician: ${reportData.serviceProviderName || req.user.name}`;

        // Generate PDF for deal upload
        const pdfBufferForDeal = await pdfGenerator.generateServiceReportPDF({ ...reportData, id: newReport.id }, req.user.name);

        await hubspot.uploadFileAndAttachToRecord(
          reportData.hubspotDealId,
          pdfBufferForDeal.toString('base64'),
          fileName,
          noteText,
          {
            recordType: 'deals',
            folderPath: '/service-reports',
            notePrefix: '[Service Portal]',
            isBase64: true
          }
        );
        console.log(`✅ Service report PDF uploaded to HubSpot deal ${reportData.hubspotDealId}`);
      } catch (dealError) {
        console.error('HubSpot deal upload error (non-blocking):', dealError.message);
      }
    }

    // Upload PDF to Google Drive
    try {
      const reportDate = new Date(reportData.serviceCompletionDate || newReport.createdAt).toLocaleDateString();
      const driveFileName = `Service_Report_${reportData.clientFacilityName.replace(/[^a-zA-Z0-9]/g, '_')}_${reportDate.replace(/\//g, '-')}.pdf`;
      const drivePdfBuffer = await pdfGenerator.generateServiceReportPDF({ ...reportData, id: newReport.id }, req.user.name);

      const driveResult = await googledrive.uploadServiceReportPDF(
        reportData.clientFacilityName || 'Unknown Client',
        driveFileName,
        drivePdfBuffer
      );

      newReport.driveFileId = driveResult.fileId;
      newReport.driveWebViewLink = driveResult.webViewLink;
      newReport.driveWebContentLink = driveResult.webContentLink;
      await db.set('service_reports', serviceReports);

      console.log(`✅ Service report PDF uploaded to Google Drive: ${driveResult.fileName}`);
    } catch (driveError) {
      console.error('Google Drive upload error (non-blocking):', driveError.message);
    }

    // Auto-add service reports to client's Files section under "Service Reports" category
    try {
      const users = (await db.get('users')) || [];
      const clientFacility = (reportData.clientFacilityName || '').toLowerCase();
      const reportCompanyId = reportData.hubspotCompanyId || '';

      // Match client by hubspotCompanyId (most reliable), then by name/practiceName fallback
      const client = users.find(u => {
        if (u.role !== config.ROLES.CLIENT) return false;
        if (reportCompanyId && u.hubspotCompanyId && String(u.hubspotCompanyId) === String(reportCompanyId)) return true;
        if (clientFacility && u.practiceName?.toLowerCase() === clientFacility) return true;
        if (clientFacility && u.name?.toLowerCase() === clientFacility) return true;
        if (clientFacility && u.clientName?.toLowerCase() === clientFacility) return true;
        if (clientFacility && u.companyName?.toLowerCase() === clientFacility) return true;
        return false;
      });

      if (client && client.slug) {
        const clientDocuments = (await db.get('client_documents')) || [];
        const reportDate = new Date(reportData.serviceCompletionDate || newReport.createdAt).toLocaleDateString();
        const reportTypeName = reportData.serviceType === 'Validations' ? 'Validation Report' : 'Service Report';

        const newDocument = {
          id: uuidv4(),
          slug: client.slug,
          title: `${reportTypeName} - ${reportDate}`,
          description: `${reportData.serviceType} - ${reportData.serviceProviderName || req.user.name}`,
          category: 'Service Reports',
          serviceReportId: newReport.id,
          serviceType: reportData.serviceType,
          driveWebViewLink: newReport.driveWebViewLink || null,
          driveWebContentLink: newReport.driveWebContentLink || null,
          createdAt: new Date().toISOString(),
          uploadedBy: 'system',
          uploadedByName: 'Thrive 365 Labs',
          active: true
        };

        clientDocuments.push(newDocument);
        await db.set('client_documents', clientDocuments);

        console.log(`✅ Service report auto-added to client files for ${client.slug}`);
      } else {
        console.log(`⚠️ No matching client found for service report auto-upload: "${reportData.clientFacilityName}" (companyId: ${reportCompanyId})`);
      }
    } catch (clientDocError) {
      console.error('Client document auto-upload error (non-blocking):', clientDocError.message);
    }

    res.json(newReport);
  } catch (error) {
    console.error('Create service report error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get service reports with filtering
app.get('/api/service-reports', authenticateToken, requireServiceAccess, async (req, res) => {
  try {
    let serviceReports = (await db.get('service_reports')) || [];

    // For non-admin/manager users, compute the set of client facility names where they
    // have an active (status === 'assigned') assignment BEFORE query filters narrow the
    // list.  This grants access to the full report history for any client they are
    // currently visiting.  Access is automatically revoked once they submit — status
    // leaves 'assigned' — so no separate admin lever is required.
    let pendingClientFacilityNames = new Set();
    if (req.user.role !== config.ROLES.ADMIN && !req.user.isManager) {
      serviceReports.forEach(r => {
        if (String(r.assignedToId || '') === String(req.user.id) && r.status === 'assigned' && r.clientFacilityName) {
          pendingClientFacilityNames.add(r.clientFacilityName);
        }
      });
    }

    // Apply filters
    const { client, dateFrom, dateTo, search, technicianId } = req.query;

    if (client) {
      serviceReports = serviceReports.filter(r =>
        r.clientFacilityName?.toLowerCase().includes(client.toLowerCase())
      );
    }

    if (dateFrom) {
      serviceReports = serviceReports.filter(r =>
        new Date(r.serviceCompletionDate || r.plannedVisitDate || r.createdAt) >= new Date(dateFrom)
      );
    }

    if (dateTo) {
      serviceReports = serviceReports.filter(r =>
        new Date(r.serviceCompletionDate || r.plannedVisitDate || r.createdAt) <= new Date(dateTo)
      );
    }

    if (search) {
      const searchLower = search.toLowerCase();
      serviceReports = serviceReports.filter(r =>
        r.clientFacilityName?.toLowerCase().includes(searchLower) ||
        r.serviceType?.toLowerCase().includes(searchLower) ||
        r.hubspotTicketNumber?.toLowerCase().includes(searchLower) ||
        r.analyzerModel?.toLowerCase().includes(searchLower)
      );
    }

    if (technicianId) {
      serviceReports = serviceReports.filter(r => r.technicianId === technicianId);
    }

    // Scope non-admins/non-managers to: their own submitted reports, any report
    // directly assigned to them, and all historical reports for any client where they
    // currently hold an active assignment.  The third condition collapses automatically
    // once they submit (pendingClientFacilityNames will no longer contain that client).
    if (req.user.role !== config.ROLES.ADMIN && !req.user.isManager) {
      serviceReports = serviceReports.filter(r =>
        r.technicianId === req.user.id ||
        String(r.assignedToId || '') === String(req.user.id) ||
        (r.clientFacilityName && pendingClientFacilityNames.has(r.clientFacilityName))
      );
    }

    // Sort by date descending
    serviceReports.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    res.json(serviceReports);
  } catch (error) {
    console.error('Get service reports error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get assigned service reports for the current technician/vendor
// IMPORTANT: This route must come BEFORE /:id to avoid "assigned" being treated as an ID
app.get('/api/service-reports/assigned', authenticateToken, requireServiceAccess, async (req, res) => {
  try {
    const serviceReports = (await db.get('service_reports')) || [];

    // Filter reports assigned to this user that haven't been submitted yet
    // Convert both IDs to strings to ensure proper comparison regardless of type
    const userIdString = String(req.user.id);
    let assignedReports = serviceReports.filter(r => {
      const reportAssignedId = String(r.assignedToId || '');
      return reportAssignedId === userIdString && r.status === 'assigned';
    });

    // NOTE: Client filtering removed - vendors should see ALL reports assigned to them
    // The act of assigning a report to a vendor implicitly grants access to that client
    // No additional client filtering needed

    // Sort by assignment date (most recent first)
    assignedReports.sort((a, b) => new Date(b.assignedAt) - new Date(a.assignedAt));

    res.json(assignedReports);
  } catch (error) {
    console.error('Get assigned service reports error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Download service report PDF (service portal users)
app.get('/api/service-reports/:id/pdf', authenticateToken, requireServiceAccess, async (req, res) => {
  try {
    const serviceReports = (await db.get('service_reports')) || [];
    const report = serviceReports.find(r => r.id === req.params.id);

    if (!report) {
      return res.status(404).json({ error: 'Report not found' });
    }

    // Generate PDF and merge any attached documents (e.g. validation report document)
    const pdfBuffer = await pdfGenerator.generateServiceReportWithAttachments(report, report.technicianName || report.serviceProviderName || 'N/A');

    const reportDate = new Date(report.serviceCompletionDate || report.createdAt || Date.now()).toLocaleDateString().replace(/\//g, '-');
    const fileName = `Service_Report_${(report.clientFacilityName || 'Report').replace(/[^a-zA-Z0-9]/g, '_')}_${reportDate}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Length', pdfBuffer.length);
    res.send(pdfBuffer);
  } catch (error) {
    console.error('Error generating service report PDF:', error);
    res.status(500).json({ error: 'Failed to generate PDF' });
  }
});

// Get single service report
app.get('/api/service-reports/:id', authenticateToken, requireServiceAccess, async (req, res) => {
  try {
    const serviceReports = (await db.get('service_reports')) || [];
    const report = serviceReports.find(r => r.id === req.params.id);

    if (!report) {
      return res.status(404).json({ error: 'Report not found' });
    }

    // Non-admins/managers can access a report if:
    // - they created it or were directly assigned to it, OR
    // - they have an active (status === 'assigned') assignment for the same client
    //   facility name (grants history access during the visit; revoked on submission)
    if (req.user.role !== config.ROLES.ADMIN && !req.user.isManager) {
      const isOwnReport =
        report.technicianId === req.user.id ||
        String(report.assignedToId || '') === String(req.user.id);

      if (!isOwnReport) {
        const hasPendingAssignment = report.clientFacilityName && serviceReports.some(r =>
          String(r.assignedToId || '') === String(req.user.id) &&
          r.status === 'assigned' &&
          r.clientFacilityName === report.clientFacilityName
        );
        if (!hasPendingAssignment) {
          return res.status(403).json({ error: 'Access denied' });
        }
      }
    }

    res.json(report);
  } catch (error) {
    console.error('Get service report error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update service report
app.put('/api/service-reports/:id', authenticateToken, requireServiceAccess, async (req, res) => {
  try {
    const serviceReports = (await db.get('service_reports')) || [];
    const reportIndex = serviceReports.findIndex(r => r.id === req.params.id);

    if (reportIndex === -1) {
      return res.status(404).json({ error: 'Report not found' });
    }

    const existingReport = serviceReports[reportIndex];

    // Only allow editing own reports unless admin or manager
    // Convert to strings for reliable comparison
    const isTechnician = String(existingReport.technicianId || '') === String(req.user.id);
    const isAssigned = String(existingReport.assignedToId || '') === String(req.user.id);
    const isManagerUser = req.user.isManager;
    if (req.user.role !== config.ROLES.ADMIN && !isManagerUser && !isTechnician && !isAssigned) {
      console.log(`Edit authorization failed: technicianId="${existingReport.technicianId}" and assignedToId="${existingReport.assignedToId}" don't match userId="${req.user.id}"`);
      return res.status(403).json({ error: 'Not authorized to edit this report' });
    }

    // Managers cannot edit Validations-type reports once the technician has saved day 1 log data
    if (isManagerUser && req.user.role !== config.ROLES.ADMIN) {
      const isValidationType = existingReport.serviceType === 'Validations';
      const hasDay1Data = Array.isArray(existingReport.validationSegments) && existingReport.validationSegments.length > 0;
      const technicianStarted = ['validation_in_progress', 'onsite_submitted', 'signature_needed', 'submitted'].includes(existingReport.status);
      if (isValidationType && (hasDay1Data || technicianStarted)) {
        return res.status(403).json({ error: 'Managers cannot edit validation reports after the technician has started logging data.' });
      }
    }

    // Check 30-minute edit window for submitted reports (admins and managers can always edit)
    if (req.user.role !== config.ROLES.ADMIN && !isManagerUser && existingReport.submittedAt) {
      const submittedTime = new Date(existingReport.submittedAt);
      const currentTime = new Date();
      const minutesElapsed = (currentTime - submittedTime) / (1000 * 60);

      if (minutesElapsed > config.SERVICE_REPORT_EDIT_WINDOW_MINUTES) {
        return res.status(403).json({
          error: `Edit window has expired. Reports can only be edited within ${config.SERVICE_REPORT_EDIT_WINDOW_MINUTES} minutes of submission.`,
          minutesElapsed: Math.floor(minutesElapsed)
        });
      }
    }

    // Whitelist allowed fields for service report updates
    const serviceReportAllowedFields = [
      'clientSlug', 'clientName', 'visitDate', 'visitType', 'status',
      'equipmentType', 'serialNumber', 'modelNumber', 'location',
      'issueDescription', 'workPerformed', 'partsUsed', 'recommendations',
      'followUpRequired', 'followUpDate', 'followUpNotes',
      'technicianNotes', 'clientSignature', 'technicianSignature',
      'photos', 'attachments', 'readings', 'testResults',
      'clientFacilityName', 'customerName', 'address', 'analyzerModel',
      'analyzerSerialNumber', 'serviceType', 'descriptionOfWork',
      'materialsUsed', 'solution', 'outstandingIssues',
      'serviceCompletionDate', 'serviceProviderName',
      'customerSignature', 'customerSignatureDate',
      'customerFirstName', 'customerLastName',
      'technicianFirstName', 'technicianLastName',
      'technicianSignatureDate',
      'validationStartDate', 'validationEndDate', 'expectedDays',
      'validationResults', 'trainingProvided'
    ];
    const sanitizedReportUpdates = {};
    for (const key of serviceReportAllowedFields) {
      if (req.body[key] !== undefined) {
        sanitizedReportUpdates[key] = req.body[key];
      }
    }

    serviceReports[reportIndex] = {
      ...existingReport,
      ...sanitizedReportUpdates,
      updatedAt: new Date().toISOString()
    };

    await db.set('service_reports', serviceReports);
    res.json(serviceReports[reportIndex]);
  } catch (error) {
    console.error('Update service report error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete service report (admin, or manager who assigned the report)
app.delete('/api/service-reports/:id', authenticateToken, async (req, res) => {
  try {
    const isSuperAdmin = req.user.role === config.ROLES.ADMIN;
    const isManager = req.user.isManager && req.user.hasServicePortalAccess;

    if (!isSuperAdmin && !isManager) {
      return res.status(403).json({ error: 'Access denied' });
    }

    let serviceReports = (await db.get('service_reports')) || [];
    const report = serviceReports.find(r => r.id === req.params.id);

    if (!report) {
      return res.status(404).json({ error: 'Report not found' });
    }

    // Managers can only delete reports they assigned
    if (!isSuperAdmin && String(report.assignedById) !== String(req.user.id)) {
      return res.status(403).json({ error: 'You can only delete reports you assigned' });
    }

    // Managers cannot delete Validations-type reports once the technician has saved day 1 log data
    if (!isSuperAdmin && isManager) {
      const isValidationType = report.serviceType === 'Validations';
      const hasDay1Data = Array.isArray(report.validationSegments) && report.validationSegments.length > 0;
      const technicianStarted = ['validation_in_progress', 'onsite_submitted', 'signature_needed', 'submitted'].includes(report.status);
      if (isValidationType && (hasDay1Data || technicianStarted)) {
        return res.status(403).json({ error: 'Managers cannot delete validation reports after the technician has started logging data.' });
      }
    }

    serviceReports = serviceReports.filter(r => r.id !== req.params.id);
    await db.set('service_reports', serviceReports);

    res.json({ message: 'Report deleted successfully' });
  } catch (error) {
    console.error('Delete service report error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Batch delete service reports (Super Admin can delete any, Service Technicians can delete their own)
app.delete('/api/service-reports', authenticateToken, async (req, res) => {
  try {
    const { reportIds } = req.body;
    const isSuperAdmin = req.user.role === config.ROLES.ADMIN;
    const isManager = req.user.isManager && req.user.hasServicePortalAccess;
    const isServiceTechnician = (req.user.role === config.ROLES.VENDOR || req.user.hasServicePortalAccess) && !isManager;

    // Only Super Admins, Managers, and Service Technicians can delete
    if (!isSuperAdmin && !isManager && !isServiceTechnician) {
      return res.status(403).json({ error: 'Access denied. Only Super Admins, Managers, and Service Technicians can delete reports.' });
    }

    if (!reportIds || !Array.isArray(reportIds) || reportIds.length === 0) {
      return res.status(400).json({ error: 'reportIds array is required' });
    }

    let serviceReports = (await db.get('service_reports')) || [];
    const idsToDelete = new Set(reportIds);
    const initialCount = serviceReports.length;

    // Scope deletion based on role
    if (!isSuperAdmin) {
      const reportsToDelete = serviceReports.filter(r => idsToDelete.has(r.id));
      if (isManager) {
        // Managers can only delete reports they assigned
        const unauthorized = reportsToDelete.filter(r => String(r.assignedById) !== String(req.user.id));
        if (unauthorized.length > 0) {
          return res.status(403).json({ error: 'You can only delete reports you assigned.' });
        }
        // Managers cannot delete Validations-type reports once the technician has saved day 1 log data
        const protectedReports = reportsToDelete.filter(r => {
          const isValidationType = r.serviceType === 'Validations';
          const hasDay1Data = Array.isArray(r.validationSegments) && r.validationSegments.length > 0;
          const technicianStarted = ['validation_in_progress', 'onsite_submitted', 'signature_needed', 'submitted'].includes(r.status);
          return isValidationType && (hasDay1Data || technicianStarted);
        });
        if (protectedReports.length > 0) {
          return res.status(403).json({ error: 'Managers cannot delete validation reports after the technician has started logging data.' });
        }
      } else {
        // Technicians can only delete their own reports
        const unauthorized = reportsToDelete.filter(r => r.technicianId !== req.user.id);
        if (unauthorized.length > 0) {
          return res.status(403).json({ error: 'You can only delete your own reports.' });
        }
      }
    }

    serviceReports = serviceReports.filter(r => !idsToDelete.has(r.id));
    const deletedCount = initialCount - serviceReports.length;

    await db.set('service_reports', serviceReports);

    await logActivity(
      req.user.id || null,
      req.user.name || req.user.email,
      'service_reports_deleted',
      'service_reports',
      null,
      { deletedCount, reportIds }
    );

    res.json({ success: true, deletedCount });
  } catch (error) {
    console.error('Batch delete service reports error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============== SERVICE REPORT ASSIGNMENTS (Manager/Admin assigns to Technician/Vendor) ==============

// Fetch HubSpot ticket and map to service report fields
app.get('/api/hubspot/ticket/:ticketId/map-to-service-report', authenticateToken, async (req, res) => {
  try {
    // Only admins and managers with service portal access can use this endpoint
    if (req.user.role !== config.ROLES.ADMIN && !(req.user.isManager && req.user.hasServicePortalAccess)) {
      return res.status(403).json({ error: 'Only admins and managers can import from HubSpot' });
    }

    const ticketId = req.params.ticketId;

    // Fetch ticket from HubSpot
    const ticket = await hubspot.getTicketById(ticketId);

    // Map HubSpot owner ID to internal user
    const users = (await db.get('users')) || [];
    const { id: assignedToId, name: assignedToName } = await resolveHubSpotOwnerToUser(ticket.ownerId, users);

    // Map Service Type from Issue Category
    const issueCategoryLower = (ticket.issueCategory || '').toLowerCase();
    const serviceType = config.SERVICE_TYPE_MAP[issueCategoryLower] || '';

    // Build a temporary report to extract managerNotes
    const tempReport = buildServiceReportFromTicket(ticket, assignedToId, assignedToName, serviceType, '', 'webhook');

    // Build the mapped service report data
    const mappedData = {
      // HubSpot ticket info
      ticketId: ticket.id,
      ticketSubject: ticket.subject,
      ticketStage: ticket.stage,

      // Mapped fields for service report
      assignedToId: assignedToId,
      assignedToName: assignedToName,
      clientFacilityName: ticket.companyName || '',
      customerName: ticket.submittedBy || '',
      serviceType: serviceType,
      analyzerSerialNumber: ticket.serialNumber || '',
      hubspotTicketNumber: ticket.id,
      hubspotCompanyId: ticket.companyId || '',
      managerNotes: tempReport.managerNotes,
      plannedVisitDate: '', // Manager sets the planned visit date

      // Additional info
      hubspotOwnerNotMatched: ticket.ownerId && !assignedToId,
      hubspotOwnerId: ticket.ownerId
    };

    res.json(mappedData);
  } catch (error) {
    console.error('Error mapping HubSpot ticket to service report:', error);
    res.status(500).json({
      error: 'Failed to fetch ticket from HubSpot',
      details: error.message
    });
  }
});

// Create and assign service report to technician/vendor (admin/manager with service access only)
app.post('/api/service-reports/assign', authenticateToken, async (req, res) => {
  try {
    // Only admins and managers with service portal access can assign service reports
    if (req.user.role !== config.ROLES.ADMIN && !(req.user.isManager && req.user.hasServicePortalAccess)) {
      return res.status(403).json({ error: 'Only admins and managers can assign service reports' });
    }

    const {
      assignedToId,
      clientFacilityName,
      customerName,
      address,
      serviceType,
      analyzerModel,
      analyzerSerialNumber,
      hubspotTicketNumber,
      hubspotCompanyId,
      hubspotDealId,
      managerNotes,
      photos,
      clientFiles,
      plannedVisitDate,
      serviceCompletionDate,
      validationStartDate,
      validationEndDate,
      expectedDays
    } = req.body;

    if (!assignedToId || !clientFacilityName) {
      return res.status(400).json({ error: 'Assigned technician and client facility name are required' });
    }

    // Parallelize DB reads for performance
    const [users, serviceReports] = await Promise.all([
      db.get('users').then(u => u || []),
      db.get('service_reports').then(r => r || [])
    ]);

    // Verify the assigned user exists and has service access
    const assignedUser = users.find(u => String(u.id) === String(assignedToId));

    if (!assignedUser) {
      return res.status(400).json({ error: 'Assigned user not found' });
    }
    if (assignedUser.role !== config.ROLES.VENDOR && assignedUser.role !== config.ROLES.ADMIN && !assignedUser.hasServicePortalAccess) {
      return res.status(400).json({ error: 'Assigned user does not have service portal access' });
    }

    // Resolve clientSlug (pass existing users to avoid redundant DB read)
    const assignClientSlug = await resolveClientSlug(clientFacilityName, hubspotCompanyId, users);
    const newReport = {
      id: uuidv4(),
      // Assignment info
      status: 'assigned',
      assignedToId,
      assignedToName: assignedUser.name,
      assignedById: req.user.id,
      assignedByName: req.user.name,
      assignedAt: new Date().toISOString(),
      // Pre-filled info by manager
      clientFacilityName,
      clientSlug: assignClientSlug,
      customerName: customerName || '',
      serviceProviderName: assignedUser.name,
      address: address || '',
      serviceType: serviceType || '',
      analyzerModel: analyzerModel || '',
      analyzerSerialNumber: analyzerSerialNumber || '',
      hubspotTicketNumber: hubspotTicketNumber || '',
      hubspotCompanyId: hubspotCompanyId || '',
      hubspotDealId: hubspotDealId || '',
      plannedVisitDate: plannedVisitDate || serviceCompletionDate || '', // Scheduled/planned visit date (set by manager)
      serviceCompletionDate: '', // Blank until service is actually completed
      // Manager-only fields
      managerNotes: managerNotes || '',
      photos: photos || [], // Array of { id, url, name, uploadedAt }
      clientFiles: clientFiles || [], // Array of { id, url, name, uploadedAt }
      // Validation dates (set by manager, adjustable by technician)
      validationStartDate: validationStartDate || '',
      validationEndDate: validationEndDate || '',
      expectedDays: expectedDays ? parseInt(expectedDays) : null,
      // Technician fields (to be filled when completing)
      technicianId: null,
      technicianName: null,
      descriptionOfWork: '',
      materialsUsed: '',
      solution: '',
      outstandingIssues: '',
      validationResults: '',
      trainingProvided: '',
      testProcedures: '',
      recommendations: '',
      analyzersValidated: [],
      customerSignature: null,
      customerSignatureDate: null,
      technicianSignature: null,
      technicianSignatureDate: null,
      // Metadata
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    serviceReports.push(newReport);
    await db.set('service_reports', serviceReports);

    // Send response immediately, log activity in background
    res.json(newReport);

    // Non-blocking activity log
    logActivity(
      req.user.id,
      req.user.name,
      'service_report_assigned',
      'service_report',
      newReport.id,
      { clientName: clientFacilityName, assignedTo: assignedUser.name }
    ).catch(err => console.error('Activity log error:', err));
  } catch (error) {
    console.error('Assign service report error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Complete an assigned service report (technician/vendor submits their portion)
app.put('/api/service-reports/:id/complete', authenticateToken, requireServiceAccess, async (req, res) => {
  try {
    const serviceReports = (await db.get('service_reports')) || [];
    const reportIndex = serviceReports.findIndex(r => r.id === req.params.id);

    if (reportIndex === -1) {
      return res.status(404).json({ error: 'Report not found' });
    }

    const existingReport = serviceReports[reportIndex];

    // Only the assigned technician can complete the report
    // Convert to strings for reliable comparison
    const isAssignedToUser = String(existingReport.assignedToId) === String(req.user.id);
    if (!isAssignedToUser && req.user.role !== config.ROLES.ADMIN) {
      console.log(`Authorization failed: assignedToId="${existingReport.assignedToId}" !== userId="${req.user.id}"`);
      return res.status(403).json({ error: 'Not authorized to complete this report' });
    }

    // Verify it's an assigned report
    if (existingReport.status !== 'assigned') {
      return res.status(400).json({ error: 'This report is not in assigned status' });
    }

    const {
      descriptionOfWork,
      materialsUsed,
      solution,
      outstandingIssues,
      validationResults,
      validationStartDate,
      validationEndDate,
      trainingProvided,
      testProcedures,
      recommendations,
      analyzersValidated,
      customerSignature,
      customerSignatureDate,
      customerFirstName,
      customerLastName,
      technicianSignature,
      technicianSignatureDate,
      technicianFirstName,
      technicianLastName,
      serviceCompletionDate,
      analyzerSerialNumber
    } = req.body;

    // Determine status based on whether customer signed on-site
    // If customer signature is provided (data URL), report is fully complete ('submitted')
    // If no customer signature, report needs client portal signing ('signature_needed')
    // A blank canvas toDataURL() is ~6000 chars; require > 7000 to ensure actual drawing content
    const hasCustomerSignature = customerSignature && typeof customerSignature === 'string'
      && customerSignature.startsWith('data:image') && customerSignature.length > 7000;
    const completionStatus = hasCustomerSignature ? 'submitted' : 'signature_needed';

    // Update the report with technician-provided info
    serviceReports[reportIndex] = {
      ...existingReport,
      status: completionStatus,
      technicianId: req.user.id,
      technicianName: req.user.name,
      // Technician-editable fields
      descriptionOfWork: descriptionOfWork || existingReport.descriptionOfWork,
      materialsUsed: materialsUsed || existingReport.materialsUsed,
      solution: solution || existingReport.solution,
      outstandingIssues: outstandingIssues || existingReport.outstandingIssues,
      validationResults: validationResults || existingReport.validationResults,
      validationStartDate: validationStartDate || existingReport.validationStartDate,
      validationEndDate: validationEndDate || existingReport.validationEndDate,
      trainingProvided: trainingProvided || existingReport.trainingProvided,
      testProcedures: testProcedures || existingReport.testProcedures,
      recommendations: recommendations || existingReport.recommendations,
      analyzersValidated: analyzersValidated || existingReport.analyzersValidated,
      customerSignature: customerSignature || existingReport.customerSignature,
      customerSignatureDate: customerSignatureDate || existingReport.customerSignatureDate,
      customerFirstName: customerFirstName || existingReport.customerFirstName,
      customerLastName: customerLastName || existingReport.customerLastName,
      technicianSignature: technicianSignature || existingReport.technicianSignature,
      technicianSignatureDate: technicianSignatureDate || existingReport.technicianSignatureDate,
      technicianFirstName: technicianFirstName || existingReport.technicianFirstName,
      technicianLastName: technicianLastName || existingReport.technicianLastName,
      serviceCompletionDate: serviceCompletionDate || existingReport.serviceCompletionDate || new Date().toISOString().split('T')[0],
      analyzerSerialNumber: analyzerSerialNumber || existingReport.analyzerSerialNumber,
      serviceProviderName: req.user.name,
      completedAt: new Date().toISOString(),
      submittedAt: hasCustomerSignature ? new Date().toISOString() : null,
      updatedAt: new Date().toISOString()
    };

    await db.set('service_reports', serviceReports);

    const completedReport = serviceReports[reportIndex];

    // Log activity
    await logActivity(
      req.user.id,
      req.user.name,
      hasCustomerSignature ? 'service_report_completed' : 'service_report_pending_signature',
      'service_report',
      completedReport.id,
      { clientName: completedReport.clientFacilityName, serviceType: completedReport.serviceType, status: completionStatus }
    );

    // Upload to HubSpot if company ID is available and report is fully complete
    // For signature_needed reports, upload happens after client signs
    if (hasCustomerSignature && completedReport.hubspotCompanyId && hubspot.isValidRecordId(completedReport.hubspotCompanyId)) {
      try {
        const reportDate = new Date(completedReport.serviceCompletionDate || completedReport.createdAt).toLocaleDateString();
        console.log(`📄 Generating PDF for completed assigned service report: ${completedReport.clientFacilityName}`);
        const pdfBuffer = await pdfGenerator.generateServiceReportPDF(completedReport, req.user.name);

        const fileName = `Service_Report_${completedReport.clientFacilityName.replace(/[^a-zA-Z0-9]/g, '_')}_${reportDate.replace(/\//g, '-')}.pdf`;
        const noteText = `Service Report Completed\n\nClient: ${completedReport.clientFacilityName}\nService Type: ${completedReport.serviceType}\nTechnician: ${req.user.name}\nTicket #: ${completedReport.hubspotTicketNumber || 'N/A'}`;

        const uploadResult = await hubspot.uploadFileAndAttachToRecord(
          completedReport.hubspotCompanyId,
          pdfBuffer.toString('base64'),
          fileName,
          noteText,
          {
            recordType: 'companies',
            folderPath: '/service-reports',
            notePrefix: '[Service Portal]',
            isBase64: true
          }
        );

        serviceReports[reportIndex].hubspotFileId = uploadResult.fileId;
        serviceReports[reportIndex].hubspotNoteId = uploadResult.noteId;
        await db.set('service_reports', serviceReports);

        console.log(`✅ Completed service report PDF uploaded to HubSpot for company ${completedReport.hubspotCompanyId}`);
      } catch (hubspotError) {
        console.error('HubSpot upload error (non-blocking):', hubspotError.message);
      }
    }

    // Upload PDF to Google Drive
    try {
      const driveReportDate = new Date(completedReport.serviceCompletionDate || completedReport.createdAt).toLocaleDateString();
      const driveFileName = `Service_Report_${completedReport.clientFacilityName.replace(/[^a-zA-Z0-9]/g, '_')}_${driveReportDate.replace(/\//g, '-')}.pdf`;
      const drivePdfBuffer = await pdfGenerator.generateServiceReportPDF(completedReport, req.user.name);

      const driveResult = await googledrive.uploadServiceReportPDF(
        completedReport.clientFacilityName || 'Unknown Client',
        driveFileName,
        drivePdfBuffer
      );

      serviceReports[reportIndex].driveFileId = driveResult.fileId;
      serviceReports[reportIndex].driveWebViewLink = driveResult.webViewLink;
      serviceReports[reportIndex].driveWebContentLink = driveResult.webContentLink;
      await db.set('service_reports', serviceReports);

      console.log(`✅ Completed service report PDF uploaded to Google Drive: ${driveResult.fileName}`);
    } catch (driveError) {
      console.error('Google Drive upload error (non-blocking):', driveError.message);
    }

    // Auto-add completed assigned report to client's Files section under "Service Reports" category
    try {
      const users = (await db.get('users')) || [];
      const clientFacility = (completedReport.clientFacilityName || '').toLowerCase();
      const reportCompanyId = completedReport.hubspotCompanyId || '';

      const client = users.find(u => {
        if (u.role !== config.ROLES.CLIENT) return false;
        if (reportCompanyId && u.hubspotCompanyId && String(u.hubspotCompanyId) === String(reportCompanyId)) return true;
        if (clientFacility && u.practiceName?.toLowerCase() === clientFacility) return true;
        if (clientFacility && u.name?.toLowerCase() === clientFacility) return true;
        if (clientFacility && u.clientName?.toLowerCase() === clientFacility) return true;
        if (clientFacility && u.companyName?.toLowerCase() === clientFacility) return true;
        return false;
      });

      if (client && client.slug) {
        const clientDocuments = (await db.get('client_documents')) || [];
        // Avoid duplicates if report was already added during creation
        const alreadyAdded = clientDocuments.some(d => d.serviceReportId === completedReport.id);
        if (!alreadyAdded) {
          const reportDate = new Date(completedReport.serviceCompletionDate || completedReport.createdAt).toLocaleDateString();
          const reportTypeName = completedReport.serviceType === 'Validations' ? 'Validation Report' : 'Service Report';

          clientDocuments.push({
            id: uuidv4(),
            slug: client.slug,
            title: `${reportTypeName} - ${reportDate}`,
            description: `${completedReport.serviceType} - ${completedReport.technicianName || req.user.name}`,
            category: 'Service Reports',
            serviceReportId: completedReport.id,
            serviceType: completedReport.serviceType,
            driveWebViewLink: serviceReports[reportIndex].driveWebViewLink || null,
            driveWebContentLink: serviceReports[reportIndex].driveWebContentLink || null,
            createdAt: new Date().toISOString(),
            uploadedBy: 'system',
            uploadedByName: 'Thrive 365 Labs',
            active: true
          });
          await db.set('client_documents', clientDocuments);
          console.log(`✅ Completed assigned report auto-added to client files for ${client.slug}`);
        }
      }
    } catch (clientDocError) {
      console.error('Client document auto-upload error (non-blocking):', clientDocError.message);
    }

    res.json(serviceReports[reportIndex]);
  } catch (error) {
    console.error('Complete service report error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Upload photos to service report (admin/manager with service access only)
app.post('/api/service-reports/:id/photos', authenticateToken, upload.array('photos', 10), async (req, res) => {
  try {
    // Only admins and managers with service portal access can upload photos
    if (req.user.role !== config.ROLES.ADMIN && !(req.user.isManager && req.user.hasServicePortalAccess)) {
      return res.status(403).json({ error: 'Only admins and managers can upload photos' });
    }

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No photos provided' });
    }

    const serviceReports = (await db.get('service_reports')) || [];
    const reportIndex = serviceReports.findIndex(r => r.id === req.params.id);

    if (reportIndex === -1) {
      return res.status(404).json({ error: 'Report not found' });
    }

    const report = serviceReports[reportIndex];
    const photos = report.photos || [];
    const clientName = report.clientFacilityName || 'Unknown Client';
    const reportId = req.params.id;

    // Prepare metadata and keep buffers in memory for background Drive upload
    const pendingUploads = req.files.map(file => {
      const fileId = uuidv4();
      const ext = path.extname(file.originalname) || '.jpg';
      return {
        meta: {
          id: fileId,
          name: file.originalname,
          mimeType: file.mimetype || 'image/jpeg',
          url: null,
          driveStatus: 'pending',
          uploadedAt: new Date().toISOString(),
          uploadedBy: req.user.name
        },
        buffer: file.buffer,
        fileName: `${fileId}${ext}`
      };
    });

    // Save metadata to DB immediately (no blocking on Drive)
    pendingUploads.forEach(u => photos.push(u.meta));
    serviceReports[reportIndex].photos = photos;
    serviceReports[reportIndex].updatedAt = new Date().toISOString();
    await db.set('service_reports', serviceReports);

    // Respond immediately so the frontend is not blocked
    res.json({ photos: serviceReports[reportIndex].photos });

    // Upload to Drive in background (fire-and-forget)
    (async () => {
      for (const { meta, buffer, fileName } of pendingUploads) {
        try {
          const driveResult = await googledrive.uploadServiceReportAttachment(
            clientName, fileName, buffer, meta.mimeType
          );
          const reports = (await db.get('service_reports')) || [];
          const rIdx = reports.findIndex(r => r.id === reportId);
          if (rIdx !== -1) {
            const pIdx = (reports[rIdx].photos || []).findIndex(p => p.id === meta.id);
            if (pIdx !== -1) {
              Object.assign(reports[rIdx].photos[pIdx], {
                url: driveResult.webContentLink,
                webViewLink: driveResult.webViewLink,
                thumbnailLink: driveResult.thumbnailLink,
                driveFileId: driveResult.fileId,
                driveStatus: 'uploaded'
              });
              await db.set('service_reports', reports);
            }
          }
        } catch (driveErr) {
          console.error('Background Drive photo upload failed:', driveErr.message);
          try {
            const reports = (await db.get('service_reports')) || [];
            const rIdx = reports.findIndex(r => r.id === reportId);
            if (rIdx !== -1) {
              const pIdx = (reports[rIdx].photos || []).findIndex(p => p.id === meta.id);
              if (pIdx !== -1) {
                reports[rIdx].photos[pIdx].driveStatus = 'failed';
                reports[rIdx].photos[pIdx].uploadError = driveErr.message;
                await db.set('service_reports', reports);
              }
            }
          } catch (dbErr) {
            console.error('Failed to update photo status after Drive error:', dbErr.message);
          }
        }
      }
    })();
  } catch (error) {
    console.error('Upload photos error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Upload client files to service report (admin/manager with service access only)
app.post('/api/service-reports/:id/files', authenticateToken, upload.array('files', 10), async (req, res) => {
  try {
    // Only admins and managers with service portal access can upload client files
    if (req.user.role !== config.ROLES.ADMIN && !(req.user.isManager && req.user.hasServicePortalAccess)) {
      return res.status(403).json({ error: 'Only admins and managers can upload client files' });
    }

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files provided' });
    }

    const serviceReports = (await db.get('service_reports')) || [];
    const reportIndex = serviceReports.findIndex(r => r.id === req.params.id);

    if (reportIndex === -1) {
      return res.status(404).json({ error: 'Report not found' });
    }

    const report = serviceReports[reportIndex];
    const clientFiles = report.clientFiles || [];
    const clientName = report.clientFacilityName || 'Unknown Client';
    const reportId = req.params.id;

    // Prepare metadata and keep buffers in memory for background Drive upload
    const pendingUploads = req.files.map(file => {
      const fileId = uuidv4();
      const ext = path.extname(file.originalname) || '';
      return {
        meta: {
          id: fileId,
          name: file.originalname,
          mimeType: file.mimetype || 'application/octet-stream',
          url: null,
          driveStatus: 'pending',
          uploadedAt: new Date().toISOString(),
          uploadedBy: req.user.name
        },
        buffer: file.buffer,
        fileName: `${fileId}${ext}`
      };
    });

    // Save metadata to DB immediately (no blocking on Drive)
    pendingUploads.forEach(u => clientFiles.push(u.meta));
    serviceReports[reportIndex].clientFiles = clientFiles;
    serviceReports[reportIndex].updatedAt = new Date().toISOString();
    await db.set('service_reports', serviceReports);

    // Respond immediately so the frontend is not blocked
    res.json({ clientFiles: serviceReports[reportIndex].clientFiles });

    // Upload to Drive in background (fire-and-forget)
    (async () => {
      for (const { meta, buffer, fileName } of pendingUploads) {
        try {
          const driveResult = await googledrive.uploadServiceReportAttachment(
            clientName, fileName, buffer, meta.mimeType
          );
          const reports = (await db.get('service_reports')) || [];
          const rIdx = reports.findIndex(r => r.id === reportId);
          if (rIdx !== -1) {
            const fIdx = (reports[rIdx].clientFiles || []).findIndex(f => f.id === meta.id);
            if (fIdx !== -1) {
              Object.assign(reports[rIdx].clientFiles[fIdx], {
                url: driveResult.webContentLink,
                webViewLink: driveResult.webViewLink,
                driveFileId: driveResult.fileId,
                driveStatus: 'uploaded'
              });
              await db.set('service_reports', reports);
            }
          }
        } catch (driveErr) {
          console.error('Background Drive file upload failed:', driveErr.message);
          try {
            const reports = (await db.get('service_reports')) || [];
            const rIdx = reports.findIndex(r => r.id === reportId);
            if (rIdx !== -1) {
              const fIdx = (reports[rIdx].clientFiles || []).findIndex(f => f.id === meta.id);
              if (fIdx !== -1) {
                reports[rIdx].clientFiles[fIdx].driveStatus = 'failed';
                reports[rIdx].clientFiles[fIdx].uploadError = driveErr.message;
                await db.set('service_reports', reports);
              }
            }
          } catch (dbErr) {
            console.error('Failed to update file status after Drive error:', dbErr.message);
          }
        }
      }
    })();
  } catch (error) {
    console.error('Upload client files error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Upload technician photos to assigned service report (assigned technician only)
app.post('/api/service-reports/:id/technician-photos', authenticateToken, requireServiceAccess, upload.array('photos', 10), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No photos provided' });
    }

    const serviceReports = (await db.get('service_reports')) || [];
    const reportIndex = serviceReports.findIndex(r => r.id === req.params.id);

    if (reportIndex === -1) {
      return res.status(404).json({ error: 'Report not found' });
    }

    const report = serviceReports[reportIndex];

    // Only the assigned technician or admin can upload technician photos
    const isAssignedToUser = String(report.assignedToId) === String(req.user.id);
    if (!isAssignedToUser && req.user.role !== config.ROLES.ADMIN) {
      return res.status(403).json({ error: 'Not authorized to upload photos to this report' });
    }

    const technicianPhotos = report.technicianPhotos || [];
    const clientName = report.clientFacilityName || 'Unknown Client';

    for (const file of req.files) {
      const fileId = uuidv4();
      const ext = path.extname(file.originalname) || '.jpg';
      const fileName = `tech_${fileId}${ext}`;

      try {
        const driveResult = await googledrive.uploadServiceReportAttachment(
          clientName, fileName, file.buffer, file.mimetype || 'image/jpeg'
        );

        technicianPhotos.push({
          id: fileId,
          name: file.originalname,
          url: driveResult.webContentLink,
          webViewLink: driveResult.webViewLink,
          thumbnailLink: driveResult.thumbnailLink,
          driveFileId: driveResult.fileId,
          uploadedAt: new Date().toISOString(),
          uploadedBy: req.user.name
        });
      } catch (driveErr) {
        console.error('Google Drive technician photo upload failed, skipping:', driveErr.message);
        technicianPhotos.push({
          id: fileId,
          name: file.originalname,
          url: null,
          uploadError: driveErr.message,
          uploadedAt: new Date().toISOString(),
          uploadedBy: req.user.name
        });
      }
    }

    serviceReports[reportIndex].technicianPhotos = technicianPhotos;
    serviceReports[reportIndex].updatedAt = new Date().toISOString();
    await db.set('service_reports', serviceReports);

    res.json({ technicianPhotos: serviceReports[reportIndex].technicianPhotos });
  } catch (error) {
    console.error('Upload technician photos error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Upload technician files to assigned service report (assigned technician only)
app.post('/api/service-reports/:id/technician-files', authenticateToken, requireServiceAccess, upload.array('files', 10), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files provided' });
    }

    const serviceReports = (await db.get('service_reports')) || [];
    const reportIndex = serviceReports.findIndex(r => r.id === req.params.id);

    if (reportIndex === -1) {
      return res.status(404).json({ error: 'Report not found' });
    }

    const report = serviceReports[reportIndex];

    // Only the assigned technician or admin can upload technician files
    const isAssignedToUser = String(report.assignedToId) === String(req.user.id);
    if (!isAssignedToUser && req.user.role !== config.ROLES.ADMIN) {
      return res.status(403).json({ error: 'Not authorized to upload files to this report' });
    }

    const technicianFiles = report.technicianFiles || [];
    const clientName = report.clientFacilityName || 'Unknown Client';

    for (const file of req.files) {
      const fileId = uuidv4();
      const ext = path.extname(file.originalname) || '';
      const fileName = `tech_${fileId}${ext}`;

      try {
        const driveResult = await googledrive.uploadServiceReportAttachment(
          clientName, fileName, file.buffer, file.mimetype || 'application/octet-stream'
        );

        technicianFiles.push({
          id: fileId,
          name: file.originalname,
          url: driveResult.webContentLink,
          webViewLink: driveResult.webViewLink,
          driveFileId: driveResult.fileId,
          uploadedAt: new Date().toISOString(),
          uploadedBy: req.user.name
        });
      } catch (driveErr) {
        console.error('Google Drive technician file upload failed, skipping:', driveErr.message);
        technicianFiles.push({
          id: fileId,
          name: file.originalname,
          url: null,
          uploadError: driveErr.message,
          uploadedAt: new Date().toISOString(),
          uploadedBy: req.user.name
        });
      }
    }

    serviceReports[reportIndex].technicianFiles = technicianFiles;
    serviceReports[reportIndex].updatedAt = new Date().toISOString();
    await db.set('service_reports', serviceReports);

    res.json({ technicianFiles: serviceReports[reportIndex].technicianFiles });
  } catch (error) {
    console.error('Upload technician files error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete photo from service report (admin/manager with service access only)
app.delete('/api/service-reports/:id/photos/:photoId', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== config.ROLES.ADMIN && !(req.user.isManager && req.user.hasServicePortalAccess)) {
      return res.status(403).json({ error: 'Only admins and managers can delete photos' });
    }

    const serviceReports = (await db.get('service_reports')) || [];
    const reportIndex = serviceReports.findIndex(r => r.id === req.params.id);

    if (reportIndex === -1) {
      return res.status(404).json({ error: 'Report not found' });
    }

    const report = serviceReports[reportIndex];
    const photo = (report.photos || []).find(p => p.id === req.params.photoId);

    if (photo) {
      // Delete file from Google Drive (or local disk for legacy uploads)
      try {
        if (photo.driveFileId) {
          await googledrive.deleteFile(photo.driveFileId);
        } else if (photo.url && photo.url.startsWith('/uploads/')) {
          const filePath = path.join(__dirname, photo.url);
          await fs.unlink(filePath);
        }
      } catch (e) { /* file may not exist */ }
    }

    serviceReports[reportIndex].photos = (report.photos || []).filter(p => p.id !== req.params.photoId);
    serviceReports[reportIndex].updatedAt = new Date().toISOString();
    await db.set('service_reports', serviceReports);

    res.json({ success: true });
  } catch (error) {
    console.error('Delete photo error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete client file from service report (admin/manager with service access only)
app.delete('/api/service-reports/:id/files/:fileId', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== config.ROLES.ADMIN && !(req.user.isManager && req.user.hasServicePortalAccess)) {
      return res.status(403).json({ error: 'Only admins and managers can delete files' });
    }

    const serviceReports = (await db.get('service_reports')) || [];
    const reportIndex = serviceReports.findIndex(r => r.id === req.params.id);

    if (reportIndex === -1) {
      return res.status(404).json({ error: 'Report not found' });
    }

    const report = serviceReports[reportIndex];
    const file = (report.clientFiles || []).find(f => f.id === req.params.fileId);

    if (file) {
      // Delete file from Google Drive (or local disk for legacy uploads)
      try {
        if (file.driveFileId) {
          await googledrive.deleteFile(file.driveFileId);
        } else if (file.url && file.url.startsWith('/uploads/')) {
          const filePath = path.join(__dirname, file.url);
          await fs.unlink(filePath);
        }
      } catch (e) { /* file may not exist */ }
    }

    serviceReports[reportIndex].clientFiles = (report.clientFiles || []).filter(f => f.id !== req.params.fileId);
    serviceReports[reportIndex].updatedAt = new Date().toISOString();
    await db.set('service_reports', serviceReports);

    res.json({ success: true });
  } catch (error) {
    console.error('Delete client file error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update manager notes on service report (admin/manager with service access only)
app.put('/api/service-reports/:id/manager-notes', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== config.ROLES.ADMIN && !(req.user.isManager && req.user.hasServicePortalAccess)) {
      return res.status(403).json({ error: 'Only admins and managers can update manager notes' });
    }

    const { managerNotes } = req.body;

    const serviceReports = (await db.get('service_reports')) || [];
    const reportIndex = serviceReports.findIndex(r => r.id === req.params.id);

    if (reportIndex === -1) {
      return res.status(404).json({ error: 'Report not found' });
    }

    serviceReports[reportIndex].managerNotes = managerNotes || '';
    serviceReports[reportIndex].updatedAt = new Date().toISOString();
    await db.set('service_reports', serviceReports);

    res.json(serviceReports[reportIndex]);
  } catch (error) {
    console.error('Update manager notes error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get service portal technicians/vendors for assignment dropdown
app.get('/api/service-portal/technicians', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== config.ROLES.ADMIN && !(req.user.isManager && req.user.hasServicePortalAccess)) {
      return res.status(403).json({ error: 'Only admins and managers can access technician list' });
    }

    const users = (await db.get('users')) || [];

    // Filter users with service portal access, excluding admins and managers
    const technicians = users.filter(u =>
      (u.role === config.ROLES.VENDOR || u.hasServicePortalAccess) &&
      u.role !== config.ROLES.ADMIN &&
      !u.isManager
    ).map(u => ({
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      assignedClients: u.assignedClients || []
    }));

    res.json(technicians);
  } catch (error) {
    console.error('Get technicians error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Service portal HTML route
app.get('/service-portal', (req, res) => {
  res.sendFile(__dirname + '/public/service-portal.html');
});

// Changelog route
app.get('/changelog', (req, res) => {
  res.sendFile(__dirname + '/public/changelog.html');
});

// Password reset link page (public)
app.get('/password-reset-:token', (req, res) => {
  res.sendFile(__dirname + '/public/password-reset.html');
});

// ============== CHANGELOG API ==============

// Get all changelog entries (public, sorted by version descending)
app.get('/api/changelog', async (req, res) => {
  try {
    const changelog = (await db.get('changelog')) || [];
    // Sort by semver descending (newest first)
    changelog.sort((a, b) => {
      return changelogGenerator.compareVersions(b.version, a.version);
    });
    res.json(changelog);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ============== PASSWORD MANAGEMENT ==============

// Generate cryptographically random temp password
function generateTempPassword(user) {
  const crypto = require('crypto');
  const randomPart = crypto.randomBytes(4).toString('hex');
  return `Temp${randomPart}!`;
}

// Store a password reset link token in the DB and return the token
async function createPasswordResetLink(user, plainPassword) {
  const crypto = require('crypto');
  const token = crypto.randomBytes(20).toString('hex');
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const links = (await db.get('password_reset_links')) || [];
  // Remove any existing links for this user
  const filtered = links.filter(l => l.userId !== user.id);
  filtered.push({ token, userId: user.id, tempPassword: plainPassword, createdAt: new Date().toISOString(), expiresAt });
  await db.set('password_reset_links', filtered);
  return token;
}

// Send the password reset email with the secure link
async function sendPasswordResetEmail(user, token) {
  const resetUrl = `${await getAppBaseUrl()}/password-reset-${token}`;
  const htmlBody = `
    <div style="font-family: Inter, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <div style="background: #045E9F; padding: 24px; border-radius: 8px 8px 0 0; text-align: center;">
        <h1 style="color: white; margin: 0; font-size: 22px; font-weight: 700;">Thrive 365 Labs</h1>
      </div>
      <div style="background: #f9fafb; padding: 32px; border-radius: 0 0 8px 8px; border: 1px solid #e5e7eb; border-top: none;">
        <p style="color: #374151; font-size: 16px; margin-top: 0;">Hi ${user.name},</p>
        <p style="color: #374151; font-size: 16px;">Your password has been reset by an administrator. Click the button below to view your temporary credentials.</p>
        <p style="color: #374151; font-size: 16px;">You will be required to create a new password when you log in.</p>
        <div style="text-align: center; margin: 32px 0;">
          <a href="${resetUrl}" style="background: #045E9F; color: white; padding: 14px 28px; border-radius: 6px; text-decoration: none; font-size: 16px; font-weight: 600; display: inline-block;">View My Temporary Password</a>
        </div>
        <p style="color: #6b7280; font-size: 13px; margin-bottom: 0;">This link expires in 24 hours. If you did not expect this reset, please contact your administrator immediately.</p>
      </div>
    </div>`;
  const plainText = `Hi ${user.name},\n\nYour password has been reset by an administrator.\n\nClick the link below to view your temporary credentials and log in:\n${resetUrl}\n\nThis link expires in 24 hours.`;
  return sendEmail(user.email, 'Your Thrive 365 Labs Password Has Been Reset', plainText, { htmlBody });
}

// Bulk password reset for all users (admin only)
app.post('/api/admin/bulk-password-reset', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { userType, specificUserIds } = req.body; // userType: 'all' | 'clients' | 'users' | 'specific'

    const users = await getUsers();
    const results = {
      total: 0,
      reset: [],
      skipped: []
    };

    for (let i = 0; i < users.length; i++) {
      const user = users[i];

      // Skip admin users from bulk reset
      if (user.role === config.ROLES.ADMIN) {
        results.skipped.push({ email: user.email, reason: 'Admin accounts excluded' });
        continue;
      }

      // Filter by userType
      if (userType === 'clients' && user.role !== config.ROLES.CLIENT) {
        continue;
      }
      if (userType === 'users' && user.role === config.ROLES.CLIENT) {
        continue;
      }
      if (userType === 'specific' && (!specificUserIds || !specificUserIds.includes(user.id))) {
        continue;
      }

      // Generate temp password
      const tempPassword = generateTempPassword(user);
      const hashedPassword = await bcrypt.hash(tempPassword, config.BCRYPT_SALT_ROUNDS);

      // Update user
      users[i].password = hashedPassword;
      users[i].requirePasswordChange = true;
      users[i].lastPasswordReset = new Date().toISOString();

      results.reset.push({
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        _plainPassword: tempPassword // kept in-memory only to send email; not returned to client
      });
      results.total++;
    }

    await db.set('users', users);
    invalidateUsersCache();

    // Send reset emails for all affected users (non-blocking)
    (async () => {
      for (const entry of results.reset) {
        const fullUser = users.find(u => u.id === entry.id);
        if (fullUser) {
          try {
            const token = await createPasswordResetLink(fullUser, entry._plainPassword);
            await sendPasswordResetEmail(fullUser, token);
          } catch (err) {
            console.error(`Bulk reset email error for ${entry.email}:`, err);
          }
        }
      }
    })();

    // Log activity
    await logActivity(
      req.user.id,
      req.user.name,
      'bulk_password_reset',
      'users',
      null,
      { userType, resetCount: results.total }
    );

    // Strip internal plain password field before sending response
    const safeResults = {
      ...results,
      reset: results.reset.map(({ _plainPassword, ...r }) => r)
    };

    res.json({
      message: `Successfully reset passwords for ${results.total} users. Reset links have been emailed to each user.`,
      total: results.total, // Include at top level for backward compatibility
      results: safeResults
    });
  } catch (error) {
    console.error('Bulk password reset error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Reset single user password (admin only)
app.post('/api/admin/reset-user-password/:userId', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const { customPassword } = req.body;

    const users = await getUsers();
    const userIndex = users.findIndex(u => u.id === userId);

    if (userIndex === -1) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = users[userIndex];

    // Use custom password or generate temp password
    const newPassword = customPassword || generateTempPassword(user);
    const hashedPassword = await bcrypt.hash(newPassword, config.BCRYPT_SALT_ROUNDS);

    users[userIndex].password = hashedPassword;
    users[userIndex].requirePasswordChange = true; // Always require change regardless of temp or custom
    users[userIndex].lastPasswordReset = new Date().toISOString();

    await db.set('users', users);
    invalidateUsersCache();

    // Create secure reset link and email it to the user
    const token = await createPasswordResetLink(user, newPassword);
    sendPasswordResetEmail(user, token).catch(err => console.error('Password reset email error:', err));

    res.json({
      message: 'Password reset successfully. A reset link has been emailed to the user.',
      requirePasswordChange: true
    });
  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Test email endpoint (admin only) - remove after validating Resend setup
app.post('/api/admin/test-email', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { to, subject, body } = req.body;
    const result = await sendEmail(
      to || req.user.email,
      subject || 'Test notification from Thrive 365 Labs',
      body || 'This is a test email from your notification system. If you received this, Resend is working.'
    );
    res.json(result);
  } catch (error) {
    console.error('Test email error:', error);
    res.status(500).json({ error: 'Failed to send test email' });
  }
});

// ============================================================
// NOTIFICATION QUEUE MANAGEMENT ENDPOINTS (Feature 1)
// ============================================================

// View pending notifications queue
app.get('/api/admin/notifications/queue', authenticateToken, requireAdminHubAccess, async (req, res) => {
  try {
    const queue = (await db.get('pending_notifications')) || [];
    const { type, status } = req.query;
    let filtered = queue;
    if (type) filtered = filtered.filter(n => n.type === type);
    if (status) filtered = filtered.filter(n => n.status === status);
    filtered.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json(filtered);
  } catch (error) {
    console.error('Get notification queue error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// View sent/failed notification history (log archive)
app.get('/api/admin/notifications/log', authenticateToken, requireAdminHubAccess, async (req, res) => {
  try {
    const log = (await db.get('notification_log')) || [];
    const { type, status, limit } = req.query;
    let filtered = log;
    if (type) filtered = filtered.filter(n => n.type === type);
    if (status) filtered = filtered.filter(n => n.status === status);
    if (limit) filtered = filtered.slice(0, parseInt(limit));
    res.json(filtered);
  } catch (error) {
    console.error('Get notification log error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Cancel a pending notification
app.post('/api/admin/notifications/cancel/:id', authenticateToken, requireAdminHubAccess, async (req, res) => {
  try {
    const queue = (await db.get('pending_notifications')) || [];
    const idx = queue.findIndex(n => n.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Notification not found' });
    if (queue[idx].status !== 'pending') return res.status(400).json({ error: 'Only pending notifications can be cancelled' });
    queue[idx].status = 'cancelled';
    await db.set('pending_notifications', queue);
    res.json({ message: 'Notification cancelled' });
  } catch (error) {
    console.error('Cancel notification error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Bulk cancel/delete notifications from queue (admin only)
app.post('/api/admin/notifications/bulk-delete', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'ids array is required' });
    }
    const queue = (await db.get('pending_notifications')) || [];
    const idSet = new Set(ids);
    const remaining = queue.filter(n => !idSet.has(n.id));
    const removedCount = queue.length - remaining.length;
    await db.set('pending_notifications', remaining);
    await logActivity(req.user.id, req.user.name, 'bulk_deleted', 'notifications', null, { count: removedCount });
    res.json({ message: `${removedCount} notification(s) removed`, removedCount });
  } catch (error) {
    console.error('Bulk delete notifications error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Retry a failed notification (move from log back to queue)
app.post('/api/admin/notifications/retry/:id', authenticateToken, requireAdminHubAccess, async (req, res) => {
  try {
    const log = (await db.get('notification_log')) || [];
    const idx = log.findIndex(n => n.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Notification not found in log' });
    if (log[idx].status !== 'failed') return res.status(400).json({ error: 'Only failed notifications can be retried' });

    const notification = log.splice(idx, 1)[0];
    notification.status = 'pending';
    notification.retryCount = 0;
    notification.failedAt = null;
    notification.failureReason = null;
    notification.triggerDate = new Date().toISOString();

    const queue = (await db.get('pending_notifications')) || [];
    queue.push(notification);
    await db.set('pending_notifications', queue);
    await db.set('notification_log', log);
    res.json({ message: 'Notification re-queued for retry' });
  } catch (error) {
    console.error('Retry notification error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Preview rendered email HTML for a notification in queue or log
app.get('/api/admin/notifications/preview/:id', authenticateToken, requireAdminHubAccess, async (req, res) => {
  try {
    const queue = (await db.get('pending_notifications')) || [];
    let notification = queue.find(n => n.id === req.params.id);
    if (!notification) {
      const log = (await db.get('notification_log')) || [];
      notification = log.find(n => n.id === req.params.id);
    }
    if (!notification) return res.status(404).json({ error: 'Notification not found' });
    const html = notification.templateData?.htmlBody
      || `<html><body style="font-family:sans-serif;padding:20px"><pre style="white-space:pre-wrap">${notification.templateData?.body || '(no content)'}</pre></body></html>`;
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (error) {
    console.error('Preview notification error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Queue stats — pending count, sent today, failure rate
app.get('/api/admin/notifications/stats', authenticateToken, requireAdminHubAccess, async (req, res) => {
  try {
    const queue = (await db.get('pending_notifications')) || [];
    const log = (await db.get('notification_log')) || [];
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const sentToday = log.filter(n => n.status === 'sent' && n.sentAt >= todayStart).length;
    const failedToday = log.filter(n => n.status === 'failed' && n.failedAt >= todayStart).length;
    const pendingCount = queue.filter(n => n.status === 'pending').length;
    const totalSent = log.filter(n => n.status === 'sent').length;
    const totalFailed = log.filter(n => n.status === 'failed').length;
    const failureRate = (totalSent + totalFailed) > 0 ? Math.round((totalFailed / (totalSent + totalFailed)) * 100) : 0;

    // Group pending by type
    const pendingByType = {};
    queue.filter(n => n.status === 'pending').forEach(n => {
      pendingByType[n.type] = (pendingByType[n.type] || 0) + 1;
    });

    res.json({
      pending: pendingCount,
      pendingByType,
      sentToday,
      failedToday,
      dailyLimit: config.NOTIFICATION_DAILY_SEND_LIMIT,
      totalSent,
      totalFailed,
      failureRate,
      logSize: log.length
    });
  } catch (error) {
    console.error('Notification stats error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================
// AD-HOC EMAIL ENDPOINTS (Feature 1)
// ============================================================

// Queue an ad-hoc email to selected users
app.post('/api/email/send', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { to, subject, message, projectId } = req.body;
    if (!to || !Array.isArray(to) || to.length === 0) return res.status(400).json({ error: 'Recipients (to) array is required' });
    if (!subject || !message) return res.status(400).json({ error: 'Subject and message are required' });

    const users = await getUsers();
    const queued = [];
    for (const email of to) {
      const user = users.find(u => u.email === email);
      const notification = await queueNotification(
        'custom_email',
        user ? user.id : null,
        email,
        user ? user.name : email,
        { subject, body: message },
        { relatedEntityId: projectId || null, relatedEntityType: projectId ? 'project' : null, createdBy: req.user.id }
      );
      if (notification) queued.push(notification.id);
    }

    await logActivity(req.user.id, req.user.name, 'email_queued', 'email', null, {
      recipientCount: queued.length, subject
    });

    res.json({ message: `${queued.length} email(s) queued for delivery`, queued: queued.length });
  } catch (error) {
    console.error('Send email error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Queue a project progress summary email
app.post('/api/email/send-progress-update/:projectId', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const projects = await getProjects();
    const project = projects.find(p => p.id === req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const tasks = await getTasks(project.id);
    const totalTasks = tasks.length;
    const completedTasks = tasks.filter(t => t.completed).length;
    const pct = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

    // Find phases with completion stats
    const phaseStats = {};
    tasks.forEach(t => {
      if (!phaseStats[t.phase]) phaseStats[t.phase] = { total: 0, done: 0 };
      phaseStats[t.phase].total++;
      if (t.completed) phaseStats[t.phase].done++;
    });
    const phaseBreakdown = Object.entries(phaseStats)
      .map(([phase, s]) => `  ${phase}: ${s.done}/${s.total} tasks complete`)
      .join('\n');

    const subject = `Progress Update: ${project.name} — ${pct}% Complete`;
    const body = `Project: ${project.name}\nOverall Progress: ${completedTasks}/${totalTasks} tasks complete (${pct}%)\n\nPhase Breakdown:\n${phaseBreakdown}\n\n${project.goLiveDate ? `Go-Live Date: ${new Date(project.goLiveDate).toLocaleDateString()}` : ''}`;

    // Find client users for this project
    const users = await getUsers();
    const recipients = req.body.to || users
      .filter(u => u.role === config.ROLES.CLIENT && (u.assignedProjects || []).includes(project.id) && u.email && u.accountStatus !== 'inactive')
      .map(u => u.email);

    const queued = [];
    for (const email of recipients) {
      const user = users.find(u => u.email === email);
      const notification = await queueNotification(
        'custom_email',
        user ? user.id : null, email, user ? user.name : email,
        { subject, body },
        { relatedEntityId: project.id, relatedEntityType: 'project', createdBy: req.user.id }
      );
      if (notification) queued.push(notification.id);
    }

    res.json({ message: `Progress update queued for ${queued.length} recipient(s)`, queued: queued.length, progress: { pct, completedTasks, totalTasks } });
  } catch (error) {
    console.error('Send progress update error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// View sent email history (filtered from notification log)
app.get('/api/email/history', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const log = (await db.get('notification_log')) || [];
    const { projectId, limit } = req.query;
    let emails = log.filter(n => n.status === 'sent');
    if (projectId) emails = emails.filter(n => n.relatedEntityId === projectId);
    if (limit) emails = emails.slice(0, parseInt(limit));
    res.json(emails);
  } catch (error) {
    console.error('Email history error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================
// NOTIFICATION SETTINGS ENDPOINTS (Feature 1)
// ============================================================

// Get notification settings
app.get('/api/admin/notification-settings', authenticateToken, requireAdminHubAccess, async (req, res) => {
  try {
    const settings = (await db.get('notification_settings')) || {
      enabled: true,
      checkIntervalMinutes: config.NOTIFICATION_CHECK_INTERVAL_MINUTES,
      maxRetriesDefault: config.NOTIFICATION_MAX_RETRIES,
      dailySendLimit: config.NOTIFICATION_DAILY_SEND_LIMIT,
      enabledChannels: ['email']
    };
    res.json(settings);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Update notification settings
app.put('/api/admin/notification-settings', authenticateToken, requireAdminHubAccess, async (req, res) => {
  try {
    const current = (await db.get('notification_settings')) || {};
    const updated = { ...current, ...req.body, updatedAt: new Date().toISOString(), updatedBy: req.user.name };
    await db.set('notification_settings', updated);
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================
// EMAIL TEMPLATE MANAGEMENT ENDPOINTS
// ============================================================

// List all email templates
app.get('/api/admin/email-templates', authenticateToken, requireAdminHubAccess, async (req, res) => {
  try {
    const templates = await getEmailTemplates();
    res.json(templates);
  } catch (error) {
    console.error('Get email templates error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get all variable pool definitions (for admin reference / future custom templates)
app.get('/api/admin/email-templates/pools', authenticateToken, requireAdminHubAccess, async (req, res) => {
  try {
    res.json({ pools: VARIABLE_POOLS, templateMapping: TEMPLATE_POOL_MAPPING });
  } catch (error) {
    console.error('Get variable pools error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get a single email template by ID
app.get('/api/admin/email-templates/:id', authenticateToken, requireAdminHubAccess, async (req, res) => {
  try {
    const templates = await getEmailTemplates();
    const template = templates.find(t => t.id === req.params.id);
    if (!template) return res.status(404).json({ error: 'Template not found' });
    res.json(template);
  } catch (error) {
    console.error('Get email template error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update an email template (subject, body, htmlBody)
app.put('/api/admin/email-templates/:id', authenticateToken, requireAdminHubAccess, async (req, res) => {
  try {
    const templates = await getEmailTemplates();
    const idx = templates.findIndex(t => t.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Template not found' });

    const { subject, body, htmlBody } = req.body;
    if (subject !== undefined) templates[idx].subject = subject;
    if (body !== undefined) templates[idx].body = body;
    if (htmlBody !== undefined) templates[idx].htmlBody = htmlBody;
    templates[idx].isDefault = false;
    templates[idx].updatedAt = new Date().toISOString();
    templates[idx].updatedBy = req.user.name;

    // Strip computed pool fields before persisting
    const toSave = templates.map(t => {
      const { variables, poolGroups, pools, ...rest } = t;
      return rest;
    });
    await db.set('email_templates', toSave);
    await logActivity(req.user.id, req.user.name, 'updated', 'email_template', req.params.id, { templateName: templates[idx].name });
    res.json(templates[idx]);
  } catch (error) {
    console.error('Update email template error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Reset an email template to its shipped default
app.post('/api/admin/email-templates/:id/reset', authenticateToken, requireAdminHubAccess, async (req, res) => {
  try {
    const templates = await getEmailTemplates();
    const idx = templates.findIndex(t => t.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Template not found' });

    const defaultTpl = DEFAULT_EMAIL_TEMPLATES.find(t => t.id === req.params.id);
    if (!defaultTpl) return res.status(404).json({ error: 'No default found for this template' });

    templates[idx] = { ...defaultTpl, updatedAt: new Date().toISOString(), updatedBy: req.user.name };
    // Strip computed pool fields before persisting
    const toSave = templates.map(t => {
      const { variables, poolGroups, pools, ...rest } = t;
      return rest;
    });
    await db.set('email_templates', toSave);
    // Re-enrich for response
    templates[idx].variables = getPoolVariablesForTemplate(req.params.id);
    templates[idx].poolGroups = getPoolGroupsForTemplate(req.params.id);
    templates[idx].pools = TEMPLATE_POOL_MAPPING[req.params.id] || [];
    await logActivity(req.user.id, req.user.name, 'reset', 'email_template', req.params.id, { templateName: templates[idx].name });
    res.json(templates[idx]);
  } catch (error) {
    console.error('Reset email template error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Preview an email template rendered with example data
app.post('/api/admin/email-templates/:id/preview', authenticateToken, requireAdminHubAccess, async (req, res) => {
  try {
    const templates = await getEmailTemplates();
    const template = templates.find(t => t.id === req.params.id);
    if (!template) return res.status(404).json({ error: 'Template not found' });

    // Build example variables from the template's variable definitions
    const exampleVars = {};
    (template.variables || []).forEach(v => { exampleVars[v.key] = v.example || `[${v.label}]`; });
    // Allow caller to override with custom preview data
    const vars = { ...exampleVars, ...(req.body.variables || {}) };

    // Override URL vars with dynamic values so preview reflects the configured domain
    const appBaseUrl = await getAppBaseUrl();
    vars.appUrl   = appBaseUrl;
    vars.loginUrl = `${appBaseUrl}/login`;

    const renderedSubject = renderTemplate(template.subject, vars);
    const renderedBody = renderTemplate(template.body, vars);
    const renderedHtml = template.htmlBody
      ? renderTemplate(template.htmlBody, vars)
      : buildHtmlEmail(renderedBody, null, appBaseUrl, 'View in App', null, appBaseUrl);

    res.json({ subject: renderedSubject, body: renderedBody, html: renderedHtml });
  } catch (error) {
    console.error('Preview email template error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Send a test email using a template (to the requesting admin's own email)
app.post('/api/admin/email-templates/:id/test-send', authenticateToken, requireAdminHubAccess, async (req, res) => {
  try {
    const templates = await getEmailTemplates();
    const tpl = getTemplateById(templates, req.params.id);
    if (!tpl) return res.status(404).json({ error: 'Template not found' });
    const appBaseUrl = await getAppBaseUrl();
    const vars = {};
    getPoolVariablesForTemplate(tpl.id).forEach(v => { vars[v.key] = v.example || `[${v.label}]`; });
    vars.recipientName = req.user.name;
    vars.recipientEmail = req.user.email;
    vars.appUrl = appBaseUrl;
    vars.loginUrl = `${appBaseUrl}/login`;
    const subject = `[TEST] ${renderTemplate(tpl.subject, vars)}`;
    const body = renderTemplate(tpl.body, vars);
    const htmlSrc = tpl.id === 'welcome_email'
      ? renderTemplate(WELCOME_HTML_BODY, vars)
      : buildHtmlEmail(body, tpl.htmlBody ? renderTemplate(tpl.htmlBody, vars) : null, null, null, null, appBaseUrl);
    const result = await sendEmail(req.user.email, subject, body, { htmlBody: htmlSrc });
    if (!result.success) return res.status(500).json({ error: result.error || 'Send failed' });
    res.json({ message: `Test email sent to ${req.user.email}` });
  } catch (error) {
    console.error('Test send email template error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================
// REMINDER SETTINGS & TRIGGER ENDPOINTS (Feature 2)
// ============================================================

// Get reminder settings
app.get('/api/admin/reminder-settings', authenticateToken, requireAdminHubAccess, async (req, res) => {
  try {
    const settings = (await db.get('reminder_settings')) || {
      enabled: true,
      scanIntervalMinutes: config.NOTIFICATION_SCAN_INTERVAL_MINUTES,
      scenarios: {
        serviceReportFollowups: { enabled: true, reminderAfterDays: config.SERVICE_REPORT_FOLLOWUP_DAYS },
        taskDeadlines: { enabled: true, daysBefore: config.TASK_DEADLINE_DAYS_BEFORE, overdueEscalationDays: config.TASK_OVERDUE_ESCALATION_DAYS },
        milestoneReminders: { enabled: true, milestoneThresholds: config.MILESTONE_THRESHOLDS, goLiveDaysBefore: config.GOLIVE_REMINDER_DAYS_BEFORE }
      }
    };
    res.json(settings);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Update reminder settings
app.put('/api/admin/reminder-settings', authenticateToken, requireAdminHubAccess, async (req, res) => {
  try {
    const current = (await db.get('reminder_settings')) || {};
    const updated = { ...current, ...req.body, updatedAt: new Date().toISOString(), updatedBy: req.user.name };
    await db.set('reminder_settings', updated);
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Manually trigger a notification scan (admin)
app.post('/api/admin/reminders/trigger', authenticateToken, requireAdminHubAccess, async (req, res) => {
  try {
    await scanAndQueueNotifications();
    const queue = (await db.get('pending_notifications')) || [];
    const pendingCount = queue.filter(n => n.status === 'pending').length;
    res.json({ message: 'Notification scan completed', pendingNotifications: pendingCount });
  } catch (error) {
    console.error('Manual scan trigger error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Manually trigger queue processing (admin)
app.post('/api/admin/notifications/process', authenticateToken, requireAdminHubAccess, async (req, res) => {
  try {
    await processNotificationQueue();
    const queue = (await db.get('pending_notifications')) || [];
    const pendingCount = queue.filter(n => n.status === 'pending').length;
    res.json({ message: 'Queue processing completed', remainingPending: pendingCount });
  } catch (error) {
    console.error('Manual queue process error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update user notification preferences
app.put('/api/users/:userId/notification-preferences', authenticateToken, async (req, res) => {
  try {
    // Users can update their own prefs, admins can update anyone's
    if (req.user.id !== req.params.userId && req.user.role !== config.ROLES.ADMIN) {
      return res.status(403).json({ error: 'Access denied' });
    }
    const users = await getUsers();
    const idx = users.findIndex(u => u.id === req.params.userId);
    if (idx === -1) return res.status(404).json({ error: 'User not found' });

    users[idx].notificationPreferences = {
      ...(users[idx].notificationPreferences || {}),
      ...req.body
    };
    await db.set('users', users);
    invalidateUsersCache();
    res.json({ message: 'Notification preferences updated', notificationPreferences: users[idx].notificationPreferences });
  } catch (error) {
    console.error('Update notification preferences error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Change password (authenticated user)
app.post('/api/auth/change-password', authenticateToken, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!newPassword || newPassword.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters' });
    }

    const users = await getUsers();
    const userIndex = users.findIndex(u => u.id === req.user.id);

    if (userIndex === -1) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = users[userIndex];

    // If not a forced password change, verify current password
    if (!user.requirePasswordChange) {
      if (!currentPassword) {
        return res.status(400).json({ error: 'Current password is required' });
      }
      const passwordMatch = await bcrypt.compare(currentPassword, user.password);
      if (!passwordMatch) {
        return res.status(400).json({ error: 'Current password is incorrect' });
      }
    }

    // Hash and save new password
    const hashedPassword = await bcrypt.hash(newPassword, config.BCRYPT_SALT_ROUNDS);
    users[userIndex].password = hashedPassword;
    users[userIndex].requirePasswordChange = false;
    users[userIndex].lastPasswordChange = new Date().toISOString();

    await db.set('users', users);
    invalidateUsersCache();

    res.json({ message: 'Password changed successfully' });
  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============== ADMIN HUB ROUTES ==============

// Admin hub HTML route
app.get('/admin', (req, res) => {
  res.sendFile(__dirname + '/public/admin-hub.html');
});

// Staff enrollment-submissions view (Session 3.3, Scope A). Page is served to
// any logged-in staff; the API routes it calls enforce role access.
app.get('/admin/enrollment', (req, res) => {
  res.sendFile(__dirname + '/public/admin-enrollment.html');
});

// Admin hub login endpoint (same as regular admin login)
app.post('/api/auth/admin-login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Missing credentials' });
    }
    const users = await getUsers();
    const user = users.find(u => u.email?.toLowerCase() === email.toLowerCase() && (u.role === config.ROLES.ADMIN || u.hasAdminHubAccess));
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(400).json({ error: 'Invalid credentials' });
    }
    // Block inactive accounts from logging in
    if (user.accountStatus === 'inactive') {
      return res.status(403).json({ error: 'Account is inactive. Please contact an administrator.' });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, name: user.name, role: user.role },
      JWT_SECRET,
      { expiresIn: config.JWT_EXPIRY }
    );
    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role
      }
    });
  } catch (error) {
    console.error('Admin login error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin hub dashboard data
app.get('/api/admin-hub/dashboard', authenticateToken, requireAdminHubAccess, async (req, res) => {
  try {
    const users = await getUsers();
    const projects = await getProjects();
    const serviceReports = (await db.get('service_reports')) || [];

    // Get all open tickets across the app (feedback requests + password reset requests)
    const feedbackRequests = (await db.get('feedback_requests')) || [];
    const openFeedback = feedbackRequests.filter(f => f.status !== 'resolved').length;
    const passwordResetRequests = (await db.get('password_reset_requests')) || [];
    const pendingPasswordResets = passwordResetRequests.filter(r => r.status === 'pending').length;
    const totalOpenTickets = openFeedback + pendingPasswordResets;

    // Calculate statistics
    const stats = {
      totalUsers: users.length,
      // adminUsers kept for backward compatibility (super admins)
      adminUsers: users.filter(u => u.role === config.ROLES.ADMIN).length,
      superAdminUsers: users.filter(u => u.role === config.ROLES.ADMIN).length,
      managerUsers: users.filter(u => u.isManager).length,
      clientUsers: users.filter(u => u.role === config.ROLES.CLIENT).length,
      servicePortalUsers: users.filter(u => u.hasServicePortalAccess || u.role === config.ROLES.VENDOR).length,
      totalProjects: projects.length,
      activeProjects: projects.filter(p => p.status !== 'completed').length,
      totalServiceReports: serviceReports.length,
      recentServiceReports: serviceReports.slice(0, 5),
      openTickets: totalOpenTickets
    };

    res.json(stats);
  } catch (error) {
    console.error('Admin hub dashboard error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============== UNIFIED LOGIN ==============
// Unified login portal for all user types
app.get('/login', (req, res) => {
  res.sendFile(__dirname + '/public/login.html');
});

// ============== AUTHENTICATED CLIENT PORTAL ROUTES ==============
// Central client portal login: /portal
app.get('/portal', (req, res) => {
  res.sendFile(__dirname + '/public/portal.html');
});

// Helper to find client user by slug (checks current slug first, then previousSlugs for redirects)
const findClientBySlugOrRedirect = async (slug, res) => {
  const users = await getUsers();
  // Check current slug first
  const currentMatch = users.find(u => u.role === config.ROLES.CLIENT && u.slug === slug);
  if (currentMatch) return { user: currentMatch, redirect: false };
  // Check previousSlugs for redirect (slug was changed, old URL still in use)
  const previousMatch = users.find(u => u.role === config.ROLES.CLIENT && Array.isArray(u.previousSlugs) && u.previousSlugs.includes(slug));
  if (previousMatch) return { user: previousMatch, redirect: true, newSlug: previousMatch.slug };
  return null;
};

// Client portal login page: /portal/:slug/login
app.get('/portal/:slug/login', async (req, res) => {
  const result = await findClientBySlugOrRedirect(req.params.slug, res);
  if (!result) return res.status(404).send('Portal not found');
  if (result.redirect) return res.redirect(302, `/portal/${result.newSlug}/login`);
  res.sendFile(__dirname + '/public/portal.html');
});

// Client portal pages: /portal/:slug, /portal/:slug/*
app.get('/portal/:slug', async (req, res) => {
  // Allow 'admin' slug for admin portal access
  if (req.params.slug === 'admin') {
    return res.sendFile(__dirname + '/public/portal.html');
  }
  const result = await findClientBySlugOrRedirect(req.params.slug, res);
  if (!result) return res.status(404).send('Portal not found');
  if (result.redirect) return res.redirect(302, `/portal/${result.newSlug}`);
  res.sendFile(__dirname + '/public/portal.html');
});

app.get('/portal/:slug/*', async (req, res) => {
  // Allow 'admin' slug for admin portal access
  if (req.params.slug === 'admin') {
    return res.sendFile(__dirname + '/public/portal.html');
  }
  const result = await findClientBySlugOrRedirect(req.params.slug, res);
  if (!result) return res.status(404).send('Portal not found');
  if (result.redirect) {
    const remainingPath = req.params[0] || '';
    return res.redirect(302, `/portal/${result.newSlug}/${remainingPath}`);
  }
  res.sendFile(__dirname + '/public/portal.html');
});

// In-memory cache for project slug lookups (avoids DB hit on every root-level request)
let _projectSlugCache = { slugs: new Set(), previousSlugs: new Map(), lastRefresh: 0 };
const PROJECT_SLUG_CACHE_TTL = config.PROJECT_SLUG_CACHE_TTL;

const refreshProjectSlugCache = async () => {
  const now = Date.now();
  if (now - _projectSlugCache.lastRefresh < PROJECT_SLUG_CACHE_TTL) return;
  const projects = await getProjects();
  const slugs = new Set();
  const previousSlugsMap = new Map();
  for (const p of projects) {
    if (p.clientLinkSlug) slugs.add(p.clientLinkSlug);
    if (Array.isArray(p.previousSlugs)) {
      for (const oldSlug of p.previousSlugs) {
        previousSlugsMap.set(oldSlug, p.clientLinkSlug);
      }
    }
  }
  _projectSlugCache = { slugs, previousSlugs: previousSlugsMap, lastRefresh: now };
};

// ============================================================
// EMAIL TEMPLATE MANAGEMENT ENDPOINTS
// ============================================================

// List all templates (enriched with pool groups and variables)
app.get('/api/admin/email-templates', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const templates = await getEmailTemplates();
    const enriched = templates.map(t => ({
      ...t,
      poolGroups: getPoolGroupsForTemplate(t.id),
      variables: getPoolVariablesForTemplate(t.id)
    }));
    res.json(enriched);
  } catch (error) {
    console.error('Get email templates error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get a single template by ID
app.get('/api/admin/email-templates/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const templates = await getEmailTemplates();
    const tpl = getTemplateById(templates, req.params.id);
    if (!tpl) return res.status(404).json({ error: 'Template not found' });
    res.json({ ...tpl, poolGroups: getPoolGroupsForTemplate(tpl.id), variables: getPoolVariablesForTemplate(tpl.id) });
  } catch (error) {
    console.error('Get email template error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update a template's subject/body/htmlBody
app.put('/api/admin/email-templates/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const templates = await getEmailTemplates();
    const idx = templates.findIndex(t => t.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Template not found' });
    const { subject, body, htmlBody } = req.body;
    if (!subject || !body) return res.status(400).json({ error: 'subject and body are required' });
    templates[idx] = {
      ...templates[idx],
      subject,
      body,
      htmlBody: htmlBody || null,
      isDefault: false,
      updatedAt: new Date().toISOString(),
      updatedBy: req.user.name
    };
    await db.set('email_templates', templates);
    res.json(templates[idx]);
  } catch (error) {
    console.error('Update email template error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Reset a template to its default
app.post('/api/admin/email-templates/:id/reset', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const def = DEFAULT_EMAIL_TEMPLATES.find(t => t.id === req.params.id);
    if (!def) return res.status(404).json({ error: 'Template not found' });
    const templates = await getEmailTemplates();
    const idx = templates.findIndex(t => t.id === req.params.id);
    const reset = { ...def, updatedAt: null, updatedBy: null, isDefault: true };
    if (idx !== -1) templates[idx] = reset; else templates.push(reset);
    await db.set('email_templates', templates);
    res.json({ ...reset, poolGroups: getPoolGroupsForTemplate(reset.id), variables: getPoolVariablesForTemplate(reset.id) });
  } catch (error) {
    console.error('Reset email template error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Preview a template with example variable values
app.post('/api/admin/email-templates/:id/preview', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const templates = await getEmailTemplates();
    const tpl = getTemplateById(templates, req.params.id);
    if (!tpl) return res.status(404).json({ error: 'Template not found' });
    // Build example vars from pool definitions
    const vars = {};
    getPoolVariablesForTemplate(tpl.id).forEach(v => { vars[v.key] = v.example || `[${v.label}]`; });

    // Override URL vars with dynamic values so preview reflects the configured domain
    const appBaseUrl = await getAppBaseUrl();
    vars.appUrl   = appBaseUrl;
    vars.loginUrl = `${appBaseUrl}/login`;

    const subject = renderTemplate(tpl.subject, vars);
    const body = renderTemplate(tpl.body, vars);
    const htmlSrc = tpl.id === 'welcome_email'
      ? renderTemplate(WELCOME_HTML_BODY, vars)
      : buildHtmlEmail(body, tpl.htmlBody ? renderTemplate(tpl.htmlBody, vars) : null, appBaseUrl, 'View in App', null, appBaseUrl);
    res.json({ subject, body, html: htmlSrc });
  } catch (error) {
    console.error('Preview email template error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Legacy root-level route - redirect old project slugs to /launch
app.get('/:slug', async (req, res, next) => {
  // Skip if it looks like a file request or known route
  if (req.params.slug.includes('.') || ['api', 'client', 'favicon.ico', 'launch', 'thrive365labsLAUNCH', 'thrive365labslaunch', 'portal', 'admin', 'service-portal', 'login'].includes(req.params.slug)) {
    return next();
  }

  // Use cached slug lookup to avoid DB hit on every root-level request
  await refreshProjectSlugCache();
  const slug = req.params.slug;

  if (_projectSlugCache.slugs.has(slug)) {
    // Use 302 (temporary) instead of 301 (permanent) to avoid browser caching issues
    res.redirect(302, `/launch/${slug}`);
  } else if (_projectSlugCache.previousSlugs.has(slug)) {
    // Redirect old slug to current slug
    res.redirect(302, `/launch/${_projectSlugCache.previousSlugs.get(slug)}`);
  } else {
    next();
  }
});

// Global error handling middleware (Gotcha #11)
// Must be defined after all routes - Express identifies error handlers by 4-argument signature
app.use((err, req, res, next) => {
  console.error('Unhandled route error:', err.stack || err.message || err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'An unexpected error occurred' });
});

// Process-level error handlers to prevent crashes from unhandled async errors
process.on('uncaughtException', (err) => {
  console.error('FATAL: Uncaught exception:', err.stack || err.message || err);
  // In production, graceful shutdown is preferred; for now, log and continue
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled promise rejection:', reason);
});

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`🔐 Admin login: ${config.DEFAULT_ADMIN.EMAIL} / ${config.DEFAULT_ADMIN.PASSWORD}`);

  // Safety net: reactivate any admin accounts that are inactive (prevent lockout)
  (async () => {
    try {
      const users = await getUsers();
      let reactivated = false;
      users.forEach(u => {
        if (u.role === 'admin' && u.accountStatus === 'inactive') {
          u.accountStatus = 'active';
          reactivated = true;
          console.log(`🔓 Reactivated locked-out admin account: ${u.email}`);
        }
      });
      if (reactivated) {
        await db.set('users', users);
        invalidateUsersCache();
      }
    } catch (err) {
      console.error('Admin lockout recovery failed:', err.message);
    }
  })();

  // Fix service report documents missing active flag
  (async () => {
    try {
      const docs = (await db.get('client_documents')) || [];
      let fixed = 0;
      docs.forEach(d => {
        if (d.serviceReportId && d.active === undefined) {
          d.active = true;
          fixed++;
        }
      });
      if (fixed > 0) {
        await db.set('client_documents', docs);
        console.log(`🔧 Fixed ${fixed} service report document(s) missing active flag`);
      }
    } catch (err) {
      console.error('Service report doc fix failed:', err.message);
    }
  })();

  // One-shot care-tier enum migration (Session 3.3, Scope C).
  // Gated by CARE_TIER_MIGRATION_APPLIED — safe/idempotent to leave in place.
  (async () => {
    try {
      await migrateCareTierEnum();
    } catch (err) {
      console.error('Care-tier migration failed (non-fatal):', err.message);
    }
  })();

  // Start HubSpot ticket polling (webhook workaround)
  initializeTicketPolling();

  // Start notification queue processor (Feature 1)
  const queueInterval = config.NOTIFICATION_CHECK_INTERVAL_MINUTES * 60 * 1000;
  setInterval(processNotificationQueue, queueInterval);
  console.log(`📧 Notification queue processor started (every ${config.NOTIFICATION_CHECK_INTERVAL_MINUTES}m)`);

  // Start notification trigger scanner (Feature 2)
  const scanInterval = config.NOTIFICATION_SCAN_INTERVAL_MINUTES * 60 * 1000;
  setInterval(scanAndQueueNotifications, scanInterval);
  console.log(`🔍 Notification trigger scanner started (every ${config.NOTIFICATION_SCAN_INTERVAL_MINUTES}m)`);

  // Run both processors immediately on startup (staggered to avoid concurrent DB writes)
  // This ensures any queued notifications are sent quickly after a restart instead of waiting
  // up to 15 minutes for the first setInterval tick.
  setTimeout(processNotificationQueue, 5000);
  setTimeout(scanAndQueueNotifications, 8000);
  console.log('⚡ Notification processors will run immediately at startup (5s / 8s)');

  // Re-hold any pending task_assignment notifications that belong to draft projects
  // (handles notifications queued before this draft-hold feature was introduced)
  (async () => {
    try {
      const queue = (await db.get('pending_notifications')) || [];
      const allProjects = await getProjects();
      const draftProjectIds = new Set(
        allProjects.filter(p => (p.publishedStatus || 'draft') === 'draft').map(p => p.id)
      );
      let held = 0;
      queue.forEach(n => {
        if (n.status === 'pending' && n.type === 'task_assignment' && n.relatedProjectId && draftProjectIds.has(n.relatedProjectId)) {
          n.status = 'held';
          held++;
        }
      });
      if (held > 0) {
        await db.set('pending_notifications', queue);
        console.log(`🔒 Startup: retroactively held ${held} pending notification(s) for draft projects`);
      }
    } catch (err) {
      console.error('Startup: failed to retroactively hold draft notifications:', err.message);
    }
  })();

  // One-time migrations for service reports
  (async () => {
    try {
      const serviceReports = (await db.get('service_reports')) || [];
      let reportsUpdated = false;

      // Migration 1: Add signer names to NANI service report
      const naniReportId = '26a15b8d-fc8b-4687-8316-46764c8bcdc1';
      const naniIdx = serviceReports.findIndex(r => r.id === naniReportId);
      if (naniIdx !== -1 && !serviceReports[naniIdx].customerFirstName) {
        serviceReports[naniIdx].customerFirstName = 'Terra';
        serviceReports[naniIdx].customerLastName = 'Hearn';
        serviceReports[naniIdx].technicianFirstName = 'Jeff';
        serviceReports[naniIdx].technicianLastName = 'Gray';
        reportsUpdated = true;
        console.log('✅ Migration: Added signer names to NANI service report');
      }

      // Migration 2: Clean up broken local filesystem photo/file URLs across ALL reports
      // Photos stored at /uploads/ are lost on Replit restart (ephemeral filesystem)
      // Mark them so the UI shows "unavailable" instead of broken images
      for (let i = 0; i < serviceReports.length; i++) {
        const report = serviceReports[i];
        if (report.photos) {
          for (let j = 0; j < report.photos.length; j++) {
            const photo = report.photos[j];
            if (photo.url && photo.url.startsWith('/uploads/') && !photo.driveFileId) {
              // Local file URL - these files are lost on Replit restart
              // Clear the URL so the UI shows "unavailable"
              report.photos[j].url = null;
              report.photos[j].lostLocalUrl = photo.url;
              reportsUpdated = true;
            }
          }
        }
        if (report.clientFiles) {
          for (let j = 0; j < report.clientFiles.length; j++) {
            const file = report.clientFiles[j];
            if (file.url && file.url.startsWith('/uploads/') && !file.driveFileId) {
              file.url = null;
              file.lostLocalUrl = file.url;
              reportsUpdated = true;
            }
          }
        }
      }

      if (reportsUpdated) {
        await db.set('service_reports', serviceReports);
        console.log('✅ Migration: Cleaned up broken local file URLs in service reports');
      }

      // Migration 3: Add NANI report to client documents if not already there
      if (naniIdx !== -1) {
        const clientDocuments = (await db.get('client_documents')) || [];
        const alreadyAdded = clientDocuments.some(d => d.serviceReportId === naniReportId);
        if (!alreadyAdded) {
          const users = (await db.get('users')) || [];
          const report = serviceReports[naniIdx];
          const clientFacility = (report.clientFacilityName || '').toLowerCase();
          const reportCompanyId = report.hubspotCompanyId || '';

          const client = users.find(u => {
            if (u.role !== config.ROLES.CLIENT) return false;
            if (reportCompanyId && u.hubspotCompanyId && String(u.hubspotCompanyId) === String(reportCompanyId)) return true;
            if (clientFacility && u.practiceName?.toLowerCase().includes('nani')) return true;
            if (clientFacility && u.practiceName?.toLowerCase().includes('indiana kidney')) return true;
            if (clientFacility && u.name?.toLowerCase().includes('nani')) return true;
            return false;
          });

          if (client && client.slug) {
            const reportDate = new Date(report.serviceCompletionDate || report.createdAt).toLocaleDateString();
            clientDocuments.push({
              id: uuidv4(),
              slug: client.slug,
              title: `Service Report - ${reportDate}`,
              description: `${report.serviceType} - ${report.serviceProviderName || report.technicianName || 'Jeff Gray'}`,
              category: 'Service Reports',
              serviceReportId: naniReportId,
              serviceType: report.serviceType,
              driveWebViewLink: report.driveWebViewLink || null,
              driveWebContentLink: report.driveWebContentLink || null,
              createdAt: new Date().toISOString(),
              uploadedBy: 'system',
              uploadedByName: 'Thrive 365 Labs',
              active: true
            });
            await db.set('client_documents', clientDocuments);
            console.log(`✅ Migration: Added NANI service report to client files for slug "${client.slug}"`);
          } else {
            console.log('⚠️ Migration: Could not find NANI client user to add service report to files');
          }
        }
      }

      // Migration 4: Fix service report client documents missing 'active' field
      // This ensures all service reports added to client files are visible in the portal
      const clientDocs = (await db.get('client_documents')) || [];
      let docsUpdated = false;
      for (let i = 0; i < clientDocs.length; i++) {
        if (clientDocs[i].serviceReportId && clientDocs[i].active !== true) {
          clientDocs[i].active = true;
          docsUpdated = true;
        }
      }
      if (docsUpdated) {
        await db.set('client_documents', clientDocs);
        console.log('✅ Migration: Fixed service report documents missing active field');
      }

      // Migration 5: Fix report 973c316c - was marked 'submitted' without valid customer signature
      // Caused by blank canvas toDataURL() passing the data:image check
      const fixReportId = '973c316c-7b88-4de5-881c-fb340d69e092';
      const fixIdx = serviceReports.findIndex(r => r.id === fixReportId);
      if (fixIdx !== -1 && serviceReports[fixIdx].status === 'submitted') {
        const sig = serviceReports[fixIdx].customerSignature;
        const hasRealSignature = sig && typeof sig === 'string' && sig.startsWith('data:image') && sig.length > 7000;
        if (!hasRealSignature) {
          serviceReports[fixIdx].status = 'signature_needed';
          serviceReports[fixIdx].customerSignature = null;
          serviceReports[fixIdx].customerSignatureDate = null;
          serviceReports[fixIdx].submittedAt = null;
          serviceReports[fixIdx].updatedAt = new Date().toISOString();
          await db.set('service_reports', serviceReports);
          console.log('✅ Migration: Fixed report 973c316c status to signature_needed (blank canvas signature)');
        }
      }
      // Migration 6: Backfill clientSlug on existing service reports
      // Resolves the name-mismatch problem by linking reports to client slugs
      const reportsNeedingSlug = serviceReports.filter(r => !r.clientSlug && r.clientFacilityName);
      if (reportsNeedingSlug.length > 0) {
        const allUsers = (await db.get('users')) || [];
        const clientUsers = allUsers.filter(u => u.role === config.ROLES.CLIENT && u.slug);
        let slugsAdded = 0;
        for (const report of reportsNeedingSlug) {
          const facilityLower = (report.clientFacilityName || '').toLowerCase().trim();
          let matchedSlug = '';
          // Match by hubspotCompanyId
          if (report.hubspotCompanyId) {
            const match = clientUsers.find(u => u.hubspotCompanyId && String(u.hubspotCompanyId) === String(report.hubspotCompanyId));
            if (match) matchedSlug = match.slug;
          }
          // Exact name match
          if (!matchedSlug) {
            const exact = clientUsers.find(u => (u.practiceName || '').toLowerCase().trim() === facilityLower);
            if (exact) matchedSlug = exact.slug;
          }
          // Bidirectional includes
          if (!matchedSlug && facilityLower) {
            const incl = clientUsers.find(u => {
              const p = (u.practiceName || '').toLowerCase().trim();
              return p && (p.includes(facilityLower) || facilityLower.includes(p));
            });
            if (incl) matchedSlug = incl.slug;
          }
          if (matchedSlug) {
            const idx = serviceReports.findIndex(r => r.id === report.id);
            if (idx !== -1) { serviceReports[idx].clientSlug = matchedSlug; slugsAdded++; }
          }
        }
        if (slugsAdded > 0) {
          await db.set('service_reports', serviceReports);
          console.log(`✅ Migration: Backfilled clientSlug on ${slugsAdded}/${reportsNeedingSlug.length} service reports`);
        }
      }

    } catch (e) {
      console.error('Migration error (non-blocking):', e.message);
    }
  })();

  // One-time migration: Normalize all project task boards to template structure
  // Fixes broken stage/category breakdowns by setting all stages to "Tasks"
  // and re-mapping phases to match the canonical template where possible
  (async () => {
    try {
      const migrationKey = 'migration_tasks_normalized_v1';
      const alreadyRun = await db.get(migrationKey);
      if (alreadyRun) return;

      console.log('🔄 Migration: Normalizing project task boards to template structure...');

      // Load the template to build title -> phase lookup
      const templatePath = require('path').join(__dirname, 'template-biolis-au480-clia.json');
      const templateRaw = await fs.readFile(templatePath, 'utf8');
      const templateTasks = JSON.parse(templateRaw);

      // Build normalized title -> phase mapping for fuzzy matching
      const titleToPhase = {};
      templateTasks.forEach(t => {
        const normalizedTitle = t.taskTitle.trim().toLowerCase();
        titleToPhase[normalizedTitle] = t.phase;
      });

      // Use centralized mappings for legacy stage-to-phase migration
      const oldStageToPhase = config.LEGACY_STAGE_TO_PHASE;
      const validPhases = new Set(config.PHASE_ORDER);

      const projects = await getProjects();
      let totalFixedStages = 0;
      let totalFixedPhases = 0;
      let projectsUpdated = 0;

      for (const project of projects) {
        // Skip NANI projects - their board is already correct
        const projectName = (project.name || '').toLowerCase();
        const clientName = (project.clientName || '').toLowerCase();
        if (projectName.includes('nani') || clientName.includes('nani') || clientName.includes('indiana kidney')) {
          continue;
        }

        const tasks = await getRawTasks(project.id);
        if (!tasks || tasks.length === 0) continue;

        let modified = false;

        for (let i = 0; i < tasks.length; i++) {
          const task = tasks[i];

          // Fix stage: normalize everything to "Tasks"
          if (task.stage && task.stage !== 'Tasks') {
            // Before overwriting, check if stage was being used as a phase hint
            const oldStage = (task.stage || '').trim().toLowerCase();
            if (!validPhases.has(task.phase) && oldStageToPhase[oldStage]) {
              tasks[i].phase = oldStageToPhase[oldStage];
              totalFixedPhases++;
            }
            tasks[i].stage = 'Tasks';
            totalFixedStages++;
            modified = true;
          }

          // Fix phase: try to match task title to template
          const normalizedTitle = (task.taskTitle || '').trim().toLowerCase();
          if (normalizedTitle && titleToPhase[normalizedTitle]) {
            const correctPhase = titleToPhase[normalizedTitle];
            if (task.phase !== correctPhase) {
              tasks[i].phase = correctPhase;
              totalFixedPhases++;
              modified = true;
            }
          }

          // Ensure phase is valid (Phase 1 through Phase 10)
          if (!validPhases.has(task.phase)) {
            // Try to extract phase number from non-standard format
            const phaseMatch = (task.phase || '').match(/phase\s*(\d+)/i);
            if (phaseMatch && parseInt(phaseMatch[1]) >= 1 && parseInt(phaseMatch[1]) <= 10) {
              tasks[i].phase = `Phase ${phaseMatch[1]}`;
              totalFixedPhases++;
              modified = true;
            } else {
              // Try mapping from old stage-like phase names
              const lowerPhase = (task.phase || '').trim().toLowerCase();
              if (oldStageToPhase[lowerPhase]) {
                tasks[i].phase = oldStageToPhase[lowerPhase];
                totalFixedPhases++;
                modified = true;
              } else {
                // Default unrecognized phases to Phase 1
                tasks[i].phase = 'Phase 1';
                totalFixedPhases++;
                modified = true;
              }
            }
          }
        }

        if (modified) {
          await db.set(`tasks_${project.id}`, tasks);
          projectsUpdated++;
        }
      }

      await db.set(migrationKey, { ranAt: new Date().toISOString(), projectsUpdated, totalFixedStages, totalFixedPhases });
      console.log(`✅ Migration: Normalized ${totalFixedStages} stages and ${totalFixedPhases} phases across ${projectsUpdated} projects`);
    } catch (e) {
      console.error('Task normalization migration error (non-blocking):', e.message);
    }
  })();

  // Auto-generate changelog from git commits on startup
  changelogGenerator.autoUpdateChangelog(db);

});
