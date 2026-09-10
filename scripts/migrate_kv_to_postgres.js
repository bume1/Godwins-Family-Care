#!/usr/bin/env node
// ============================================================================
// scripts/migrate_kv_to_postgres.js — one-time, idempotent KV → Postgres
// migration (Session 5.1). Re-running is a no-op.
//
//   node scripts/migrate_kv_to_postgres.js --dry-run
//   node scripts/migrate_kv_to_postgres.js
//   node scripts/migrate_kv_to_postgres.js --verify-only
//   node scripts/migrate_kv_to_postgres.js --from-file scripts/kv_snapshot.json
//   node scripts/migrate_kv_to_postgres.js --ignore some_stray_key,other_key
//   node scripts/migrate_kv_to_postgres.js --overwrite   (replace differing target values — only on a first cutover, never after writes have started at the target)
//
// Source: the Replit KV store (REPLIT_DB_URL) or a JSON snapshot from
// scripts/export_kv_snapshot.js. Target: DATABASE_URL (encrypted RDS Postgres).
// Every key in the source must match a handler in dataMigration.js
// COLLECTION_REGISTRY; an unhandled key REFUSES the whole run before any copy.
// The report (per-collection row counts, PHI flag, action, verify result) is
// written to scripts/migrate_kv_to_postgres.<timestamp>.json.
// ============================================================================
'use strict';
const fs = require('fs');
const path = require('path');
const dataStore = require('../dataStore');
const { migrateStore, verifyStores, UnhandledCollectionError } = require('../dataMigration');

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };

(async () => {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is required (the Postgres target).'); process.exit(2); }
  const ignore = (opt('--ignore') || '').split(',').map(s => s.trim()).filter(Boolean);
  const fromFile = opt('--from-file');

  let source;
  if (fromFile) {
    source = dataStore.createStore({ adapter: 'memory', env: { ...process.env, NODE_ENV: 'development' } });
    const snap = JSON.parse(fs.readFileSync(path.resolve(fromFile), 'utf8'));
    for (const [k, v] of Object.entries(snap.data || snap)) await source.set(k, v);
    console.log(`Source: snapshot ${fromFile} (${Object.keys(snap.data || snap).length} keys)`);
  } else {
    if (!process.env.REPLIT_DB_URL) { console.error('REPLIT_DB_URL is required unless --from-file is given.'); process.exit(2); }
    source = dataStore.createStore({ adapter: 'kv', env: { ...process.env, NODE_ENV: 'development' } });
    console.log('Source: Replit KV');
  }
  const target = dataStore.createStore({ adapter: 'postgres', env: process.env });
  await target.ready();
  console.log('Target: Postgres (schema ensured)');

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = path.join(__dirname, `migrate_kv_to_postgres.${stamp}.json`);
  try {
    if (flag('--verify-only')) {
      const v = await verifyStores(source, target, { ignore });
      fs.writeFileSync(reportPath, JSON.stringify(v, null, 2));
      console.log(`VERIFY: ${v.matched}/${v.checked} matched, ${v.missing.length} missing, ${v.mismatches.length} mismatched → ${reportPath}`);
      process.exit(v.ok ? 0 : 1);
    }
    const report = await migrateStore(source, target, { dryRun: flag('--dry-run'), overwrite: flag('--overwrite'), ignore, log: (l) => console.log('  ' + l) });
    const verify = flag('--dry-run') ? null : await verifyStores(source, target, { ignore });
    report.postVerify = verify;
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    const phi = report.collections.filter(c => c.phi).length;
    console.log(`\n${report.dryRun ? 'DRY RUN' : 'DONE'}: ${report.totalKeys} keys (${phi} PHI collections) — copied ${report.counts.copied}, unchanged ${report.counts.unchanged}, conflicts ${report.counts.conflicts}, audit rows appended ${report.counts.auditRowsAppended}`);
    if (report.ignored.length) console.log(`IGNORED (deliberately left behind): ${report.ignored.join(', ')}`);
    if (verify) console.log(`VERIFY: ${verify.matched}/${verify.checked} matched${verify.ok ? '' : ` — ${verify.missing.length} missing, ${verify.mismatches.length} mismatched`}`);
    console.log(`Report: ${reportPath}`);
    if (report.counts.conflicts) console.log('CONFLICTS: target already holds a different value for the keys marked conflict. Nothing was overwritten. Re-run with --overwrite ONLY if the target has not yet been written to by the app.');
    process.exit(report.ok && (!verify || verify.ok) ? 0 : 1);
  } catch (err) {
    if (err instanceof UnhandledCollectionError) { console.error(`\n${err.message}`); process.exit(3); }
    console.error('Migration failed:', err.message); process.exit(1);
  } finally {
    await target.close().catch(() => {});
  }
})();
