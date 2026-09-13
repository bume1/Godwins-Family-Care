// ============================================================
// Session 5.1 — data layer into the boundary: build-fail guards
//
//   1. ONE construction site: only dataStore.js may require @replit/database;
//      server.js and routes/ never touch it.
//   2. The three adapters share one contract (get/set/delete/list + audit),
//      proven against memory AND a real Postgres dialect (pg-mem in the
//      sandbox; DATABASE_URL when present).
//   3. Production refuses to boot on the KV or memory adapter, and on
//      Postgres without DATABASE_URL.
//   4. The migration enumerates the source DYNAMICALLY and REFUSES an
//      unhandled collection — a throwaway key makes it stop, copying nothing.
//   5. The migration is idempotent (re-run = zero writes), verifies by
//      read-back, and moves audit buckets into the audit table.
//   6. Every collection literal in the codebase has a registry handler, so a
//      session that adds a store without claiming it fails the build here,
//      not after cutover.
// ============================================================
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const dataStore = require('../dataStore');
const { COLLECTION_REGISTRY, findHandler, classifyKeys, migrateStore, verifyStores, UnhandledCollectionError } = require('../dataMigration');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const listJs = (dir) => fs.readdirSync(path.join(root, dir)).filter(f => f.endsWith('.js')).map(f => path.join(dir, f));

const pgMemStore = () => {
  const { newDb } = require('pg-mem');
  const { Pool } = newDb().adapters.createPg();
  return dataStore.createStore({ adapter: 'postgres', pgPool: new Pool(), env: { NODE_ENV: 'test' } });
};
const mem = () => dataStore.createStore({ adapter: 'memory', env: { NODE_ENV: 'test' } });

// ---- 1. one construction site ----
test('only dataStore.js requires @replit/database', () => {
  const offenders = [...listJs('.'), ...listJs('routes'), ...listJs('scripts')]
    .filter(f => !f.endsWith('dataStore.js'))
    .filter(f => /require\(\s*['"]@replit\/database['"]\s*\)/.test(read(f)));
  assert.deepEqual(offenders, [], `direct @replit/database require outside dataStore.js: ${offenders.join(', ')}`);
});
test('server.js constructs the store exactly once, through dataStore, after the production assertion', () => {
  const src = read('server.js');
  assert.equal((src.match(/dataStore\.createStore\(/g) || []).length, 1);
  assert.match(src, /dataStore\.assertProductionSafe\(\)/);
  assert.ok(src.indexOf('dataStore.assertProductionSafe()') < src.indexOf('dataStore.createStore('), 'assert before construct');
  assert.doesNotMatch(src, /new Database\(/);
});

// ---- 2. one contract, three adapters ----
for (const [name, make] of [['memory', mem], ['postgres(pg-mem)', pgMemStore]]) {
  test(`${name}: get/set/delete/list round-trip with KV semantics`, async () => {
    const s = make();
    assert.equal(await s.get('nope'), null, 'missing key is null, never undefined');
    await s.set('users', [{ id: 'u1', name: "O'Brien", nested: { a: [1, 2, { b: null }] }, dropped: undefined }]);
    const back = await s.get('users');
    assert.deepEqual(back, [{ id: 'u1', name: "O'Brien", nested: { a: [1, 2, { b: null }] } }], 'JSON round-trip, undefined dropped');
    await s.set('tasks_p1', [1]); await s.set('tasks_p2', [2]); await s.set('templates', {});
    assert.deepEqual(await s.list('tasks_'), ['tasks_p1', 'tasks_p2']);
    assert.deepEqual(await s.list(''), ['tasks_p1', 'tasks_p2', 'templates', 'users']);
    await s.delete('tasks_p1');
    assert.deepEqual(await s.list('tasks_'), ['tasks_p2']);
    assert.equal(await s.get('tasks_p1'), null);
    // a value that mutates after set does not mutate the store
    const v = [{ x: 1 }]; await s.set('m', v); v[0].x = 2;
    assert.deepEqual(await s.get('m'), [{ x: 1 }]);
    await s.close();
  });
  test(`${name}: audit surface is append-only and filterable`, async () => {
    const s = make();
    const t0 = '2026-09-10T10:00:00.000Z';
    await s.appendAudit({ id: 'a1', timestamp: t0, userId: 'u1', action: 'phi_access', patientId: 'c1', entityType: 'client', entityId: 'c1' });
    await s.appendAudit({ id: 'a2', timestamp: '2026-09-10T10:01:00.000Z', userId: 'u2', action: 'emr_read', patientId: 'c2', entityType: 'openemr:Patient', entityId: 'c2' });
    await s.appendAudit({ id: 'a3', timestamp: '2026-09-11T09:00:00.000Z', userId: 'u1', action: 'phi_access', patientId: 'c1', entityType: 'client', entityId: 'c1' });
    assert.equal(await s.countAudit(), 3);
    const all = await s.readAudit({});
    assert.deepEqual(all.map(r => r.id), ['a3', 'a2', 'a1'], 'newest first');
    assert.deepEqual((await s.readAudit({ userId: 'u1' })).map(r => r.id), ['a3', 'a1']);
    assert.deepEqual((await s.readAudit({ patientId: 'c2' })).map(r => r.id), ['a2']);
    assert.deepEqual((await s.readAudit({ since: '2026-09-11T00:00:00.000Z' })).map(r => r.id), ['a3']);
    assert.deepEqual((await s.readAudit({ limit: 1 })).map(r => r.id), ['a3']);
    await s.close();
  });
}
test('a real DATABASE_URL, when present, passes the same contract', { skip: !process.env.DATABASE_URL && 'DATABASE_URL not set' }, async () => {
  const s = dataStore.createStore({ adapter: 'postgres', env: { ...process.env, NODE_ENV: 'test' } });
  const key = `__contract_probe_${Date.now()}`;
  await s.set(key, { ok: true }); assert.deepEqual(await s.get(key), { ok: true }); await s.delete(key); assert.equal(await s.get(key), null);
  await s.close();
});

// ---- 3. production refusal ----
test('production refuses the KV adapter, the memory adapter, and Postgres without DATABASE_URL', () => {
  assert.throws(() => dataStore.assertProductionSafe({ NODE_ENV: 'production', DATA_STORE: 'kv' }), /REFUSING TO BOOT.*DATA_STORE=kv/);
  assert.throws(() => dataStore.assertProductionSafe({ NODE_ENV: 'production', DATA_STORE: 'memory' }), /REFUSING TO BOOT.*DATA_STORE=memory/);
  assert.throws(() => dataStore.assertProductionSafe({ NODE_ENV: 'production', DATA_STORE: 'postgres' }), /DATABASE_URL is not set/);
  assert.throws(() => dataStore.createStore({ env: { NODE_ENV: 'production', DATA_STORE: 'kv' } }), /REFUSING TO BOOT/);
  assert.deepEqual(dataStore.assertProductionSafe({ NODE_ENV: 'production', DATA_STORE: 'postgres', DATABASE_URL: 'postgres://x' }), { ok: true, adapter: 'postgres', production: true });
  // unset DATA_STORE in production resolves to postgres — the dev default cannot leak in
  assert.equal(dataStore.resolveAdapterName({ NODE_ENV: 'production' }), 'postgres');
  assert.equal(dataStore.resolveAdapterName({}), 'kv');
  assert.throws(() => dataStore.resolveAdapterName({ DATA_STORE: 'sqlite' }), /DATA_STORE must be one of/);
});
test('production SSL defaults to verify-full; dev can disable', () => {
  const { buildPgSsl } = dataStore._internal;
  assert.deepEqual(buildPgSsl({ NODE_ENV: 'production' }), { rejectUnauthorized: true });
  assert.deepEqual(buildPgSsl({ NODE_ENV: 'production', DATABASE_SSL: 'require' }), { rejectUnauthorized: false });
  assert.equal(buildPgSsl({ NODE_ENV: 'development' }), false);
});

// ---- 4./5. migration: dynamic enumeration, refusal, idempotence, verify ----
const seed = async (s) => {
  await s.set('users', [{ id: 'c1', role: 'client', name: 'Test PatientOne' }]);
  await s.set('shifts', [{ id: 's1', client_id: 'c1' }]);
  await s.set('tasks_p1', [{ id: 1 }]);
  await s.set('migration_tasks_normalized_v1', { ranAt: 'x' });
  await s.set('auth_session:abc', { id: 'abc', userId: 'u1' });
  await s.appendAudit({ id: 'a1', timestamp: '2026-09-10T10:00:00.000Z', userId: 'u1', action: 'phi_access', patientId: 'c1' });
  await s.appendAudit({ id: 'a2', timestamp: '2026-09-10T10:05:00.000Z', userId: 'u1', action: 'phi_access', patientId: 'c1' });
};
test('a throwaway collection makes the migration REFUSE, and nothing is copied', async () => {
  const src = mem(); const dst = pgMemStore();
  await seed(src);
  await src.set('throwaway_collection_nobody_claimed', [{ phi: 'would be left behind' }]);
  await assert.rejects(migrateStore(src, dst), (e) => e instanceof UnhandledCollectionError && e.keys.includes('throwaway_collection_nobody_claimed'));
  assert.deepEqual(await dst.list(''), [], 'refused BEFORE any copy');
  assert.equal(await dst.countAudit(), 0);
  // an explicit ignore is a recorded decision, not a skip
  const report = await migrateStore(src, dst, { ignore: ['throwaway_collection_nobody_claimed'] });
  assert.deepEqual(report.ignored, ['throwaway_collection_nobody_claimed']);
  assert.equal(await dst.get('throwaway_collection_nobody_claimed'), null);
  await dst.close();
});
test('migration copies every handled key, verifies by read-back, moves audit rows, and a re-run is a no-op', async () => {
  const src = mem(); const dst = pgMemStore();
  await seed(src);
  const r1 = await migrateStore(src, dst);
  assert.equal(r1.ok, true);
  assert.equal(r1.counts.copied, 5, 'users, shifts, tasks_p1, migration marker, session');
  assert.equal(r1.counts.auditRowsAppended, 2);
  assert.equal(r1.verify.checked, 5); assert.deepEqual(r1.verify.mismatches, []);
  assert.ok(r1.collections.find(c => c.key === 'users').phi, 'users flagged PHI');
  assert.equal(r1.collections.find(c => c.key === 'shifts').rows, 1);
  assert.deepEqual(await dst.get('users'), [{ id: 'c1', role: 'client', name: 'Test PatientOne' }]);
  assert.equal(await dst.countAudit(), 2);
  assert.equal(await dst.get('audit_log:2026-09-10'), null, 'audit buckets become table rows, not blobs');
  const v = await verifyStores(src, dst); assert.equal(v.ok, true); assert.equal(v.matched, 6);
  const r2 = await migrateStore(src, dst);
  assert.equal(r2.counts.copied, 0); assert.equal(r2.counts.unchanged, 5); assert.equal(r2.counts.auditRowsAppended, 0); assert.equal(r2.counts.auditRowsSkipped, 2);
  assert.equal(await dst.countAudit(), 2, 're-run appended nothing');
  await dst.close();
});
test('a differing target value is a CONFLICT, left alone unless overwrite is explicit', async () => {
  const src = mem(); const dst = mem();
  await src.set('users', [{ id: 'c1', name: 'new' }]); await dst.set('users', [{ id: 'c1', name: 'old' }]);
  const r = await migrateStore(src, dst);
  assert.equal(r.counts.conflicts, 1); assert.equal(r.ok, false);
  assert.deepEqual(await dst.get('users'), [{ id: 'c1', name: 'old' }]);
  const r2 = await migrateStore(src, dst, { overwrite: true });
  assert.equal(r2.counts.copied, 1); assert.deepEqual(await dst.get('users'), [{ id: 'c1', name: 'new' }]);
});
test('dry run classifies and diffs but writes nothing', async () => {
  const src = mem(); const dst = mem(); await seed(src);
  const r = await migrateStore(src, dst, { dryRun: true });
  assert.equal(r.dryRun, true); assert.equal(r.counts.copied, 5);
  assert.deepEqual(await dst.list(''), []);
});

// ---- 6. every collection literal in the codebase is claimed ----
test('every collection key literal in server.js, routes/, repositories and scripts has a registry handler', () => {
  const files = [...listJs('.'), ...listJs('routes'), ...listJs('scripts')].filter(f => !/\.test\.js$/.test(f) && !f.endsWith('dataMigration.js'));
  const literal = /\b(?:db\.(?:get|set|delete)|readRows|loadRows|read|write|store\.set)\(\s*['"]([a-zA-Z0-9_:]+)['"]/g;
  const keys = new Set();
  for (const f of files) {
    const src = read(f);
    let m; while ((m = literal.exec(src))) keys.add(m[1]);
  }
  assert.ok(keys.size >= 40, `expected the codebase to name at least 40 collections, found ${keys.size}`);
  const unclaimed = [...keys].filter(k => !findHandler(k));
  assert.deepEqual(unclaimed, [], `collection(s) with no COLLECTION_REGISTRY handler: ${unclaimed.join(', ')}`);
});
test('the registry names the PHI floor the brief lists', () => {
  for (const k of ['users', 'care_plan_versions', 'care_plan_cosign_events', 'consent_events', 'consent_provider_authorizations',
    'consent_records_categories', 'messages', 'visit_logs', 'escalation_events', 'shifts', 'caregiver_availability', 'time_logs',
    'encounter_billing', 'prescriptions', 'clinical_orders', 'appointment_encounters', 'activity_log', 'audit_log:2026-09-10']) {
    const h = findHandler(k); assert.ok(h, `${k} unhandled`);
    if (k !== 'caregiver_availability') assert.equal(h.phi, true, `${k} should be flagged PHI`);
  }
  assert.equal(classifyKeys(['users', 'zzz']).unhandled[0], 'zzz');
  assert.ok(COLLECTION_REGISTRY.every(h => (h.key !== undefined) !== (h.pattern !== undefined)), 'each handler is a key OR a pattern');
});

// ---- 7. first boot against a server with no application database ----
// RDS is provisioned with "Initial database name" blank (guide 6C.2), so the
// first connection to `/gfc` fails with 3D000. The adapter must create the
// database on that error alone, then run the schema; a pre-created database
// must work identically; any other connection error must surface untouched.
test('a missing application database is created on first boot, then the schema runs', async () => {
  const { postgresAdapter } = dataStore._internal;
  const url = 'postgres://appadmin:pw@gfc-app-db.example.rds.amazonaws.com:5432/gfc?sslmode=verify-full';
  const log = [];
  let dbExists = false;
  const fakePool = (connStr) => ({
    connStr,
    async query(sql) {
      const dbName = new URL(connStr).pathname.slice(1);
      log.push(`${dbName}: ${sql.split(/\s+/).slice(0, 3).join(' ')}`);
      if (dbName === 'gfc' && !dbExists) { const e = new Error('database "gfc" does not exist'); e.code = '3D000'; throw e; }
      if (/^CREATE DATABASE/.test(sql)) { dbExists = true; return { rows: [] }; }
      return { rows: [] };
    },
    async end() { log.push(`${new URL(connStr).pathname.slice(1)}: end`); }
  });
  const adapter = postgresAdapter({ env: { DATABASE_URL: url, NODE_ENV: 'test' }, createPool: fakePool });
  await adapter.ready();
  assert.deepEqual(log.slice(0, 3), ['gfc: SELECT 1', 'postgres: CREATE DATABASE "gfc"', 'postgres: end'], 'created via the maintenance database, then disconnected');
  assert.ok(log.filter(l => l.startsWith('gfc: CREATE')).length >= 2, 'schema ran on the new database');
  // idempotent: a second ready() is a no-op, and a pre-existing database skips creation
  const before = log.length; await adapter.ready(); assert.equal(log.length, before);
  const log2 = []; dbExists = true;
  const a2 = postgresAdapter({ env: { DATABASE_URL: url, NODE_ENV: 'test' }, createPool: (c) => ({ async query(sql) { log2.push(sql.slice(0, 15)); return { rows: [] }; }, async end() {} }) });
  await a2.ready();
  assert.ok(!log2.some(l => /^CREATE DATABASE/.test(l)), 'a pre-created database is left alone');
});
test('any connection error other than "database does not exist" surfaces untouched', async () => {
  const { postgresAdapter, databaseNameFromUrl, maintenanceUrl } = dataStore._internal;
  const url = 'postgres://appadmin:pw@host:5432/gfc';
  const created = [];
  const a = postgresAdapter({ env: { DATABASE_URL: url, NODE_ENV: 'test' }, createPool: () => ({ async query(sql) { if (/^CREATE DATABASE/.test(sql)) created.push(sql); const e = new Error('password authentication failed'); e.code = '28P01'; throw e; }, async end() {} }) });
  await assert.rejects(a.ready(), /password authentication failed/);
  assert.deepEqual(created, [], 'no CREATE DATABASE on an auth failure');
  assert.equal(databaseNameFromUrl(url), 'gfc');
  assert.equal(maintenanceUrl('postgres://u:p@h:5432/gfc?sslmode=verify-full'), 'postgres://u:p@h:5432/postgres?sslmode=verify-full');
  assert.equal(databaseNameFromUrl('not a url'), null);
});
