// ============================================================
// Session 5.4 — durable audit_log + scrubbed logs: build-fail guards
//
//   1. Every /api route registered anywhere (server.js and routes/) is
//      either under a PHI prefix — so the PHI-access middleware records it —
//      or in the explicit NON-PHI allowlist. A new route in neither fails
//      the build.
//   2. The middleware is registered before any route, logActivity() writes
//      the durable row FIRST, and the auth middleware binds the user into
//      the request context.
//   3. Functionally: a request under a PHI prefix lands a `phi_access` row
//      with user, role, patientId, resource, method, status, hashed IP and
//      request id; a non-PHI request lands none; a refused (403) request is
//      still recorded; a POA read carries actingFor.
//   4. Scrubbing: emails, phones, SSNs, labelled DOBs, bearer tokens, JWTs
//      and password/secret pairs never reach the console; the scrubber is
//      installed on line 1 of server.js; no console call logs req.body.
// ============================================================
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const dataStore = require('../dataStore');
const { createAuditLog, isPhiPath, PHI_PREFIXES, NON_PHI_PREFIXES } = require('../auditLog');
const scrubber = require('../logScrubber');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const serverSrc = read('server.js');
const routeFiles = fs.readdirSync(path.join(root, 'routes')).map(f => `routes/${f}`);

// ---- 1. coverage ----
test('every /api route in server.js and routes/ is under a PHI prefix or in the NON-PHI allowlist', () => {
  const re = /\b(?:app|router)\.(get|post|put|delete|patch)\(\s*['"`](\/api\/[^'"`]+|\/healthz)['"`]/g;
  const paths = new Set();
  for (const f of ['server.js', ...routeFiles]) { const src = read(f); let m; while ((m = re.exec(src))) paths.add(m[2]); }
  assert.ok(paths.size >= 250, `expected the whole route table, found ${paths.size}`);
  const covered = (p) => isPhiPath(p) || NON_PHI_PREFIXES.some(pre => p === pre || p.startsWith(pre + '/'));
  const orphans = [...paths].filter(p => !covered(p));
  assert.deepEqual(orphans, [], `routes that are neither PHI-audited nor allowlisted: ${orphans.join(', ')}`);
  const both = PHI_PREFIXES.filter(p => NON_PHI_PREFIXES.includes(p));
  assert.deepEqual(both, [], 'a prefix cannot be both');
  for (const p of ['/api/gfc', '/api/clinical', '/api/caregiver', '/api/scheduling', '/api/messaging', '/api/emr', '/api/users']) assert.ok(PHI_PREFIXES.includes(p), `${p} must be PHI`);
});
test('no PHI-carrying prefix hides in the allowlist', () => {
  for (const p of NON_PHI_PREFIXES) assert.doesNotMatch(p, /gfc|clinical|caregiver|patient|client|messag|schedul|users/, `${p} looks like PHI`);
});

// ---- 2. wiring ----
test('the audit middleware is registered before every route, logActivity writes the durable row first, and auth binds the user', () => {
  const mwAt = serverSrc.indexOf('app.use(audit.phiAccessMiddleware)');
  const ctxAt = serverSrc.indexOf('app.use(audit.contextMiddleware)');
  const firstRoute = serverSrc.search(/app\.(get|post|put|delete)\('\/api/);
  assert.ok(ctxAt > 0 && mwAt > ctxAt && mwAt < firstRoute, 'context, then PHI middleware, then routes');
  const firstMount = serverSrc.indexOf('app.use(caregiverRoutes(');
  assert.ok(mwAt < firstMount, 'before the Session 6/7/9 routers too');
  const la = serverSrc.slice(serverSrc.indexOf('const logActivity = async'), serverSrc.indexOf('openemr.setActivityLogger(logActivity)'));
  assert.ok(la.indexOf('await audit.record(') < la.indexOf("db.get('activity_log')"), 'durable row before the capped blob');
  assert.match(serverSrc, /audit\.bindUser\(req\.user, req\.session\)/);
  assert.equal(serverSrc.indexOf("require('./logScrubber').install(console)"), serverSrc.indexOf('require('), 'the scrubber is the first require in server.js');
  assert.match(serverSrc, /app\.get\('\/api\/admin\/audit-log', authenticateToken, requireAdmin/);
  assert.match(serverSrc, /app\.get\('\/healthz'/);
});
test('the capped activity_log blob is no longer the record: PHI-access rows go to the audit store, not a 500-entry array', () => {
  assert.match(serverSrc, /ACTIVITY_LOG_MAX/, 'the UI view keeps its cap');
  assert.match(read('auditLog.js'), /store\.appendAudit\(row\)/);
  assert.doesNotMatch(read('auditLog.js'), /\.length = |unshift\(/, 'nothing in the audit module truncates');
});

// ---- 3. functional ----
const boot = async () => {
  const store = dataStore.createStore({ adapter: 'memory', env: { NODE_ENV: 'test' } });
  const audit = createAuditLog({ store, salt: 'salt' });
  const app = express();
  app.use(audit.contextMiddleware);
  app.use(audit.phiAccessMiddleware);
  const auth = (req, res, next) => {
    const who = req.headers['x-who'];
    if (!who) return res.status(401).json({ error: 'no', code: 'AUTH_MISSING' });
    req.user = { id: who, name: `User ${who}`, role: who === 'poa' ? 'family' : 'user', familyIsPoa: who === 'poa', familyOfClientId: who === 'poa' ? 'c-1' : null };
    req.session = { id: 'sid-1' };
    audit.bindUser(req.user, req.session);
    next();
  };
  app.get('/api/clinical/patients/:clientId/chart', auth, (req, res) => res.json({ ok: true }));
  app.get('/api/gfc/me', auth, (req, res) => res.json({ ok: true }));
  app.get('/api/clinical/forbidden', auth, (req, res) => res.status(403).json({ error: 'no', code: 'CLINICAL_ONLY' }));
  app.get('/api/auth/whatever', (req, res) => res.json({ ok: true }));
  app.get('/api/gfc/deep', auth, async (req, res) => { await audit.record({ action: 'nested_read', entityType: 'client', entityId: 'c-9' }); res.json({ ok: true }); });
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (p, headers = {}) => fetch(base + p, { headers });
  const wait = () => new Promise(r => setTimeout(r, 30));
  return { store, audit, get, wait, close: () => new Promise(r => server.close(r)) };
};
test('a PHI request lands a phi_access row with who/what/where/when/from; a non-PHI request lands none', async () => {
  const { store, get, wait, close } = await boot();
  const r = await get('/api/clinical/patients/c-1/chart', { 'x-who': 'u-1', 'x-forwarded-for': '203.0.113.9, 10.0.0.1' });
  assert.equal(r.status, 200); assert.match(r.headers.get('x-request-id'), /^[0-9a-f-]{36}$/);
  await get('/api/auth/whatever'); await wait();
  const rows = await store.readAudit({});
  assert.equal(rows.length, 1, 'exactly one row: the PHI request');
  const row = rows[0];
  assert.equal(row.action, 'phi_access'); assert.equal(row.userId, 'u-1'); assert.equal(row.userName, 'User u-1'); assert.equal(row.role, 'user');
  assert.equal(row.patientId, 'c-1'); assert.equal(row.resource, '/api/clinical/patients/c-1/chart'); assert.equal(row.method, 'GET');
  assert.equal(row.entityId, 'GET /api/clinical/patients/:clientId/chart');
  assert.equal(row.details.status, 200); assert.equal(row.details.sessionId, 'sid-1');
  assert.match(row.ipHash, /^[0-9a-f]{64}$/); assert.ok(!JSON.stringify(row).includes('203.0.113.9'), 'IP is hashed, never stored');
  assert.equal(row.requestId, r.headers.get('x-request-id'));
  assert.match(row.timestamp, /^\d{4}-\d{2}-\d{2}T/);
  await close();
});
test('a refused request is still recorded (an attempt is part of the trail), and an unauthenticated one has no user', async () => {
  const { store, get, wait, close } = await boot();
  await get('/api/clinical/forbidden', { 'x-who': 'u-2' }); await get('/api/gfc/me'); await wait();
  const rows = await store.readAudit({});
  assert.equal(rows.length, 2);
  const forbidden = rows.find(r => r.resource === '/api/clinical/forbidden');
  assert.equal(forbidden.details.status, 403); assert.equal(forbidden.userId, 'u-2');
  const anon = rows.find(r => r.resource === '/api/gfc/me');
  assert.equal(anon.details.status, 401); assert.equal(anon.userId, null);
  await close();
});
test('a POA read carries actingFor, and a logActivity-style record inside a handler inherits the request context', async () => {
  const { store, get, wait, close } = await boot();
  await get('/api/gfc/me', { 'x-who': 'poa' }); await get('/api/gfc/deep', { 'x-who': 'u-3', 'x-forwarded-for': '198.51.100.7' }); await wait();
  const rows = await store.readAudit({});
  const poa = rows.find(r => r.userId === 'poa'); assert.equal(poa.actingFor, 'c-1'); assert.equal(poa.role, 'family');
  const nested = rows.find(r => r.action === 'nested_read');
  assert.equal(nested.userId, 'u-3'); assert.equal(nested.role, 'user'); assert.equal(nested.resource, '/api/gfc/deep'); assert.equal(nested.method, 'GET');
  assert.match(nested.ipHash, /^[0-9a-f]{64}$/); assert.equal(nested.entityId, 'c-9');
  const routeRow = rows.find(r => r.action === 'phi_access' && r.userId === 'u-3');
  assert.equal(nested.requestId, routeRow.requestId, 'same request id ties the two rows together');
  assert.deepEqual((await store.readAudit({ userId: 'u-3' })).map(r => r.action).sort(), ['nested_read', 'phi_access']);
  await close();
});

// ---- 4. scrubbing ----
test('PHI identifiers never reach the console', () => {
  const lines = [];
  const fake = { log: (...a) => lines.push(a.join(' ')), info: (...a) => lines.push(a.join(' ')), warn: (...a) => lines.push(a.join(' ')), error: (...a) => lines.push(a.join(' ')), debug: (...a) => lines.push(a.join(' ')) };
  scrubber.install(fake); scrubber.install(fake);
  fake.log('Login failed for pat.one@example.com from (404) 555-0199');
  fake.error('record', { name: 'Pat One', email: 'pat.one@example.com', phone: '404-555-0199', ssn: '123-45-6789', dob: '1950-02-03', password: 'hunter2' });
  fake.warn('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJpZCI6InUtMSJ9.abcdefghijklmnop refresh_token=RTsecret client_secret: xyz');
  fake.info(new Error('token eyJhbGciOiJIUzI1NiJ9.eyJpZCI6InUtMSJ9.abcdefghijklmnop leaked'));
  fake.log('x'.repeat(5000));
  const out = lines.join('\n');
  for (const leak of ['pat.one@example.com', '555-0199', '123-45-6789', '1950-02-03', 'hunter2', 'eyJhbGciOiJIUzI1NiJ9.eyJpZCI6InUtMSJ9', 'RTsecret', 'xyz']) {
    assert.ok(!out.includes(leak), `leaked: ${leak}\n${out}`);
  }
  assert.match(out, /\[email\]/); assert.match(out, /\[phone\]/); assert.match(out, /\[ssn\]/); assert.match(out, /\[dob\]/); assert.match(out, /\[jwt\]/); assert.match(out, /password=\[redacted\]/);
  assert.match(out, /\[truncated \d+ chars\]/);
  assert.match(scrubber.scrubString('at 2026-09-10T10:00:00.000Z status 200'), /2026-09-10T10:00:00\.000Z/, 'timestamps survive');
});
test('login failures and boot no longer print the email or the admin password, and no console call logs a request body', () => {
  assert.doesNotMatch(serverSrc, /console\.log\('Login failed: [^']*email:', email\)/);
  assert.doesNotMatch(serverSrc, /Password mismatch for:', email/);
  assert.doesNotMatch(serverSrc, /console\.log\(`🔐 Admin login: \$\{config\.DEFAULT_ADMIN\.EMAIL\} \/ \$\{config\.DEFAULT_ADMIN\.PASSWORD\}`\)/);
  assert.doesNotMatch(serverSrc, /DEFAULT_ADMIN\.PASSWORD\}`\)/, 'the admin password is never printed');
  for (const f of ['server.js', ...routeFiles]) {
    assert.doesNotMatch(read(f), /console\.(log|error|warn|info)\([^)]*req\.body/, `${f} logs a request body`);
  }
});
