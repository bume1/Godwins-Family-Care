// ============================================================================
// dataStore.js — THE data-access module (Session 5.1)
//
// Every read and write of the app's operational data goes through the store
// this module builds. It exposes the same surface the app has used since the
// lab era — get / set / delete / list on whole-collection blobs — so the ~800
// existing call sites are unchanged, plus an APPEND-ONLY audit surface that
// Session 5.4 needs and a blob cannot give (a blob is rewritten whole on every
// write; an audit log that is rewritten whole is an audit log that truncates).
//
// Three adapters, selected by DATA_STORE:
//   kv        the Replit key/value store. DEV ONLY. Outside the BAA boundary.
//   postgres  encrypted RDS Postgres inside the AWS BAA boundary. PRODUCTION.
//   memory    an in-process Map. Tests and probes.
//
// PRODUCTION REFUSES TO BOOT ON ANYTHING BUT POSTGRES. assertProductionSafe()
// throws, with the reason spelled out, when NODE_ENV=production and the
// resolved adapter is not postgres or DATABASE_URL is absent. The dev path
// stays, but it cannot be reached by accident.
//
// This is the ONLY file that may require @replit/database — build-enforced in
// test/data_layer.test.js.
// ============================================================================

'use strict';

const ADAPTERS = Object.freeze(['kv', 'postgres', 'memory']);

// ---- Adapter selection ------------------------------------------------------
const resolveAdapterName = (env = process.env) => {
  const explicit = String(env.DATA_STORE || '').trim().toLowerCase();
  if (explicit) {
    if (!ADAPTERS.includes(explicit)) {
      throw new Error(`DATA_STORE must be one of ${ADAPTERS.join(', ')} (got "${explicit}")`);
    }
    return explicit;
  }
  // Unset: production means Postgres, everything else keeps the dev default.
  return env.NODE_ENV === 'production' ? 'postgres' : 'kv';
};

// The startup assertion the brief asks for. Called by createStore() and again
// by server.js at boot so the refusal is visible in the process log, not only
// as a thrown stack.
const assertProductionSafe = (env = process.env, adapterName = resolveAdapterName(env)) => {
  if (env.NODE_ENV !== 'production') return { ok: true, adapter: adapterName, production: false };
  if (adapterName !== 'postgres') {
    throw new Error(
      `REFUSING TO BOOT: NODE_ENV=production with DATA_STORE=${adapterName}. ` +
      'Production PHI lives in encrypted RDS Postgres inside the AWS BAA boundary, never in the Replit KV store or in memory. ' +
      'Set DATA_STORE=postgres and DATABASE_URL (see docs/GFC_Session5_Cutover_Runbook.md).');
  }
  if (!String(env.DATABASE_URL || '').trim()) {
    throw new Error('REFUSING TO BOOT: NODE_ENV=production with DATA_STORE=postgres but DATABASE_URL is not set.');
  }
  return { ok: true, adapter: adapterName, production: true };
};

// ---- Shared helpers ---------------------------------------------------------
// The KV client JSON round-trips every value (undefined properties dropped,
// Dates become strings). The other adapters do the same so a value reads back
// identically whichever store it came from.
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const dayBucket = (iso) => `audit_log:${String(iso).slice(0, 10)}`;
const AUDIT_PREFIX = 'audit_log:';

// ---- Memory adapter ---------------------------------------------------------
const memoryAdapter = () => {
  const map = new Map();
  return {
    name: 'memory',
    async ready() {},
    async get(key) { return map.has(key) ? clone(map.get(key)) : null; },
    async set(key, value) { map.set(key, clone(value === undefined ? null : value)); },
    async delete(key) { map.delete(key); },
    async list(prefix = '') { return [...map.keys()].filter(k => k.startsWith(prefix)).sort(); },
    async close() {},
    _map: map
  };
};

// ---- Replit KV adapter (dev only) --------------------------------------------
const kvAdapter = (client) => {
  // Lazily required so a Postgres-only deployment never loads the Replit client.
  const Database = client ? null : require('@replit/database');
  const db = client || new Database();
  return {
    name: 'kv',
    async ready() {},
    async get(key) { return db.get(key); },
    async set(key, value) { await db.set(key, value); },
    async delete(key) { await db.delete(key); },
    async list(prefix = '') { return (await db.list(prefix)).slice().sort(); },
    async close() {}
  };
};

// ---- Postgres adapter (production) ------------------------------------------
// One table of whole-collection blobs (app_kv) so the existing call surface is
// preserved exactly, plus a real append-only audit_log table. Row-level tables
// for the hot collections are a later refactor; the boundary move is this one.
const SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS app_kv (
     key text PRIMARY KEY,
     value jsonb NOT NULL,
     updated_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS audit_log (
     id bigserial PRIMARY KEY,
     ts timestamptz NOT NULL,
     actor_id text,
     action text,
     entity_type text,
     entity_id text,
     patient_id text,
     row jsonb NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS audit_log_ts_idx ON audit_log (ts)`,
  `CREATE INDEX IF NOT EXISTS audit_log_patient_idx ON audit_log (patient_id)`,
  `CREATE INDEX IF NOT EXISTS audit_log_actor_idx ON audit_log (actor_id)`
];

const buildPgSsl = (env) => {
  const mode = String(env.DATABASE_SSL || (env.NODE_ENV === 'production' ? 'verify-full' : 'disable')).toLowerCase();
  if (mode === 'disable' || mode === 'off' || mode === 'false') return false;
  const ssl = { rejectUnauthorized: mode !== 'require' };
  if (env.DATABASE_SSL_CA) ssl.ca = require('fs').readFileSync(env.DATABASE_SSL_CA, 'utf8');
  return ssl;
};

const postgresAdapter = ({ pool, env = process.env } = {}) => {
  let pgPool = pool;
  if (!pgPool) {
    const { Pool } = require('pg');
    pgPool = new Pool({
      connectionString: env.DATABASE_URL,
      ssl: buildPgSsl(env),
      max: parseInt(env.DATABASE_POOL_MAX || '10', 10)
    });
  }
  let readyPromise = null;
  const ready = () => {
    if (!readyPromise) {
      readyPromise = (async () => { for (const sql of SCHEMA_SQL) await pgPool.query(sql); })();
    }
    return readyPromise;
  };
  const UPSERT = 'INSERT INTO app_kv (key, value, updated_at) VALUES ($1, $2::jsonb, now()) ' +
    'ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()';
  return {
    name: 'postgres',
    ready,
    async get(key) {
      await ready();
      const r = await pgPool.query('SELECT value FROM app_kv WHERE key = $1', [key]);
      if (!r.rows.length) return null;
      const v = r.rows[0].value;
      return v === undefined ? null : v;
    },
    async set(key, value) {
      await ready();
      await pgPool.query(UPSERT, [key, JSON.stringify(value === undefined ? null : value)]);
    },
    async delete(key) {
      await ready();
      await pgPool.query('DELETE FROM app_kv WHERE key = $1', [key]);
    },
    async list(prefix = '') {
      await ready();
      // substr() rather than LIKE so a prefix carrying `_` or `%` (tasks_…)
      // is matched literally without dialect-specific escaping.
      const p = String(prefix || '');
      const r = await pgPool.query('SELECT key FROM app_kv WHERE substring(key from 1 for $2::int) = $1 ORDER BY key', [p, p.length]);
      return r.rows.map(x => x.key);
    },
    async appendAudit(row) {
      await ready();
      await pgPool.query(
        'INSERT INTO audit_log (ts, actor_id, action, entity_type, entity_id, patient_id, row) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)',
        [row.timestamp, row.userId || null, row.action || null, row.entityType || null,
          row.entityId == null ? null : String(row.entityId), row.patientId == null ? null : String(row.patientId), JSON.stringify(row)]);
    },
    async readAudit({ since, until, userId, patientId, limit = 200 } = {}) {
      await ready();
      const where = []; const params = [];
      if (since) { params.push(since); where.push(`ts >= $${params.length}`); }
      if (until) { params.push(until); where.push(`ts <= $${params.length}`); }
      if (userId) { params.push(userId); where.push(`actor_id = $${params.length}`); }
      if (patientId) { params.push(String(patientId)); where.push(`patient_id = $${params.length}`); }
      params.push(Math.max(1, Math.min(5000, limit)));
      const sql = `SELECT id, row FROM audit_log${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT $${params.length}`;
      const r = await pgPool.query(sql, params);
      return r.rows.map(x => ({ ...x.row, auditId: String(x.id) }));
    },
    async countAudit() {
      await ready();
      const r = await pgPool.query('SELECT count(*)::text AS n FROM audit_log');
      return parseInt(r.rows[0].n, 10);
    },
    async close() { await pgPool.end(); },
    _pool: pgPool
  };
};

// ---- Blob-bucket audit (kv + memory) ------------------------------------------
// One blob per UTC day. Appending never rewrites more than a day; nothing is
// ever truncated. The Postgres adapter replaces this with a real table and the
// migration script moves every bucket row into it (handler `audit_log:*`).
const bucketAudit = (adapter) => ({
  async appendAudit(row) {
    const key = dayBucket(row.timestamp);
    const rows = (await adapter.get(key)) || [];
    rows.push(row);
    await adapter.set(key, rows);
  },
  async readAudit({ since, until, userId, patientId, limit = 200 } = {}) {
    const keys = (await adapter.list(AUDIT_PREFIX)).sort().reverse();
    const out = [];
    for (const key of keys) {
      const day = key.slice(AUDIT_PREFIX.length);
      if (since && day < String(since).slice(0, 10)) continue;
      if (until && day > String(until).slice(0, 10)) continue;
      const rows = ((await adapter.get(key)) || []).slice().reverse();
      for (const row of rows) {
        if (since && row.timestamp < since) continue;
        if (until && row.timestamp > until) continue;
        if (userId && row.userId !== userId) continue;
        if (patientId && String(row.patientId) !== String(patientId)) continue;
        out.push(row);
        if (out.length >= limit) return out;
      }
    }
    return out;
  },
  async countAudit() {
    let n = 0;
    for (const key of await adapter.list(AUDIT_PREFIX)) n += ((await adapter.get(key)) || []).length;
    return n;
  }
});

// ---- Store factory ------------------------------------------------------------
const createStore = (opts = {}) => {
  const env = opts.env || process.env;
  const name = opts.adapter || resolveAdapterName(env);
  assertProductionSafe(env, name);
  let adapter;
  if (name === 'memory') adapter = memoryAdapter();
  else if (name === 'kv') adapter = kvAdapter(opts.kvClient);
  else if (name === 'postgres') adapter = postgresAdapter({ pool: opts.pgPool, env });
  else throw new Error(`Unknown data store adapter "${name}"`);
  const audit = adapter.appendAudit ? adapter : bucketAudit(adapter);
  const store = {
    adapter: name,
    ready: () => adapter.ready(),
    get: (key) => adapter.get(key),
    set: async (key, value) => { await adapter.set(key, value); return store; },
    delete: async (key) => { await adapter.delete(key); return store; },
    list: (prefix) => adapter.list(prefix || ''),
    // Append-only audit surface (5.4). Never a blob rewrite on Postgres.
    appendAudit: (row) => audit.appendAudit(row),
    readAudit: (q) => audit.readAudit(q),
    countAudit: () => audit.countAudit(),
    // Every key/value pair, for the migration and the rollback snapshot.
    snapshot: async () => {
      const out = {};
      for (const key of await adapter.list('')) out[key] = await adapter.get(key);
      return out;
    },
    close: () => adapter.close(),
    _adapter: adapter
  };
  return store;
};

module.exports = {
  ADAPTERS,
  resolveAdapterName,
  assertProductionSafe,
  createStore,
  // exported for the migration + tests
  _internal: { memoryAdapter, kvAdapter, postgresAdapter, bucketAudit, dayBucket, AUDIT_PREFIX, SCHEMA_SQL, buildPgSsl }
};
