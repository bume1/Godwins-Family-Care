// ============================================================================
// auditLog.js — the durable, append-only audit log (Session 5.4)
//
// Every PHI access writes a row: who (user id, name, role), what (action,
// entity type + id, patient id), where (resource path, method), when (ISO
// timestamp), from where (hashed IP), and on whose behalf (actingFor, for a
// POA). Rows are appended through the data store's audit surface — a real
// table on Postgres, daily buckets on the dev adapters — and are NEVER
// truncated. The lab-era `activity_log` blob keeps its 500-entry cap for the
// admin UI; it is a view, the audit log is the record.
//
// Two ways a row gets written, and both are needed:
//   1. logActivity(...) — every explicit call the app already makes (EMR
//      reads/writes, consent events, escalations, logins, admin actions).
//      server.js routes those through record() as well as the old blob.
//   2. the PHI-prefix middleware — every request under a PHI prefix
//      (/api/gfc, /api/clinical, /api/caregiver, /api/scheduling,
//      /api/messaging, /api/users, /api/emr …) writes a `phi_access` row on
//      completion, whatever the handler did or forgot. Build-enforced in
//      test/audit_log.test.js: every /api route is either under a PHI prefix
//      or in the explicit NON-PHI allowlist.
//
// The request context (AsyncLocalStorage) carries the acting user, role,
// hashed IP and request id so a logActivity() call deep in a helper still
// lands with the right attribution.
// ============================================================================
'use strict';
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');

const als = new AsyncLocalStorage();
const currentContext = () => als.getStore() || null;

// Which parts of the API are PHI. A route that is not under one of these
// prefixes must be in NON_PHI_PREFIXES, or the build fails.
const PHI_PREFIXES = Object.freeze([
  '/api/gfc', '/api/clinical', '/api/caregiver', '/api/scheduling', '/api/messaging', '/api/emr',
  '/api/users', '/api/client', '/api/client-documents', '/api/client-portal', '/api/client-portals',
  '/api/service-reports', '/api/service-portal', '/api/admin', '/api/admin-hub', '/api/hubspot', '/api/projects', '/api/team-members', '/api/reporting'
]);
// Not PHI by construction: auth handshakes (audited by their own events),
// templates/config/announcements, email unsubscribe tokens, bootstrap.
const NON_PHI_PREFIXES = Object.freeze([
  '/api/auth', '/api/bootstrap-admin', '/api/config', '/api/settings', '/api/portal-settings', '/api/templates',
  '/api/announcements', '/api/changelog', '/api/feedback', '/api/email', '/api/unsubscribe', '/api/resubscribe',
  '/api/webhook', '/api/webhooks', '/healthz'
]);
const isPhiPath = (p) => PHI_PREFIXES.some(pre => p === pre || p.startsWith(pre + '/'));

const hashIp = (ip, salt) => (ip ? crypto.createHash('sha256').update(`${salt}:${ip}`).digest('hex') : null);
const clientIp = (req) => {
  const fwd = String((req.headers && req.headers['x-forwarded-for']) || '').split(',')[0].trim();
  return fwd || (req.socket && req.socket.remoteAddress) || req.ip || '';
};
// The patient a request is about, when the route names one. Never a body
// field — a body can say anything; the URL is what the guard checked.
const patientIdFrom = (req) => {
  const p = req.params || {};
  return p.clientId || p.patientId || (req.route && /\/patients\/:id/.test(req.route.path) ? p.id : null) || null;
};

const createAuditLog = ({ store, salt, now = () => new Date() }) => {
  const record = async (entry) => {
    const ctx = currentContext() || {};
    const row = {
      id: entry.id || crypto.randomUUID(),
      timestamp: entry.timestamp || now().toISOString(),
      userId: entry.userId ?? ctx.userId ?? null,
      userName: entry.userName ?? ctx.userName ?? null,
      role: entry.role ?? (entry.details && entry.details.role) ?? ctx.role ?? null,
      action: entry.action,
      entityType: entry.entityType || null,
      entityId: entry.entityId == null ? null : String(entry.entityId),
      patientId: entry.patientId ?? (entry.details && entry.details.patientId) ?? ctx.patientId ?? null,
      actingFor: entry.actingFor ?? (entry.details && entry.details.actingFor) ?? ctx.actingFor ?? null,
      resource: entry.resource ?? (entry.details && entry.details.resource) ?? ctx.resource ?? null,
      method: entry.method ?? ctx.method ?? null,
      ipHash: entry.ipHash ?? ctx.ipHash ?? null,
      requestId: entry.requestId ?? ctx.requestId ?? null,
      details: entry.details == null ? null : entry.details
    };
    await store.appendAudit(row);
    return row;
  };

  // Express middleware #1: request context for everything downstream.
  const contextMiddleware = (req, res, next) => {
    const ctx = { requestId: crypto.randomUUID(), ipHash: hashIp(clientIp(req), salt), method: req.method, resource: req.path, startedAt: Date.now() };
    res.setHeader('X-Request-Id', ctx.requestId);
    als.run(ctx, () => next());
  };
  // Called by the auth middleware once the user is known.
  const bindUser = (user, session) => {
    const ctx = currentContext();
    if (!ctx || !user) return;
    ctx.userId = user.id; ctx.userName = user.name || user.email || null; ctx.role = user.role || null;
    ctx.sessionId = session ? session.id : null;
    if (user.role === 'family' && user.familyIsPoa && user.familyOfClientId) ctx.actingFor = user.familyOfClientId;
  };
  // Express middleware #2: every completed request under a PHI prefix is a
  // row. Written on 'finish' so the status is known; a refused request (401,
  // 403) is recorded too — an attempt is part of the trail.
  const phiAccessMiddleware = (req, res, next) => {
    if (!isPhiPath(req.path)) return next();
    const ctx = currentContext();
    res.on('finish', () => {
      const user = req.user || null;
      Promise.resolve(record({
        action: 'phi_access', entityType: 'route', entityId: `${req.method} ${req.baseUrl || ''}${req.route ? req.route.path : req.path}`,
        userId: user ? user.id : null, userName: user ? (user.name || user.email) : null, role: user ? user.role : null,
        patientId: patientIdFrom(req), resource: `${req.baseUrl || ''}${req.path}`, method: req.method,
        actingFor: user && user.role === 'family' && user.familyIsPoa ? user.familyOfClientId : null,
        details: { status: res.statusCode, durationMs: ctx ? Date.now() - ctx.startedAt : null, sessionId: (req.session && req.session.id) || null }
      })).catch(err => console.error('audit_log write failed:', err.message));
    });
    next();
  };

  return { record, contextMiddleware, phiAccessMiddleware, bindUser, currentContext, isPhiPath, PHI_PREFIXES, NON_PHI_PREFIXES, read: (q) => store.readAudit(q), count: () => store.countAudit() };
};

module.exports = { createAuditLog, currentContext, isPhiPath, PHI_PREFIXES, NON_PHI_PREFIXES, hashIp, _internal: { patientIdFrom, clientIp, als } };
