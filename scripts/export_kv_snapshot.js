#!/usr/bin/env node
// scripts/export_kv_snapshot.js — dump every key of the current store to JSON
// (Session 5.1). This is the app-side half of the pre-cutover snapshot in the
// runbook: the RDS snapshot covers the target, this covers the source, so the
// path back to the pre-cutover state exists before the migration runs.
//   node scripts/export_kv_snapshot.js [out.json]     (DATA_STORE selects the source; default kv)
// The file contains PHI (test data until go-live). Keep it inside the boundary
// and delete it once the cutover is verified.
'use strict';
const fs = require('fs');
const path = require('path');
const dataStore = require('../dataStore');
(async () => {
  const out = path.resolve(process.argv[2] || path.join(__dirname, `kv_snapshot.${new Date().toISOString().replace(/[:.]/g, '-')}.json`));
  const store = dataStore.createStore({ env: { ...process.env, NODE_ENV: 'development' } });
  const data = await store.snapshot();
  const keys = Object.keys(data);
  fs.writeFileSync(out, JSON.stringify({ exportedAt: new Date().toISOString(), adapter: store.adapter, keys: keys.length, data }, null, 2));
  console.log(`Exported ${keys.length} keys from ${store.adapter} → ${out}`);
  await store.close();
})().catch(e => { console.error(e.message); process.exit(1); });
