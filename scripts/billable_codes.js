#!/usr/bin/env node
// scripts/billable_codes.js — keep gfc_billable_codes in step with OpenEMR.
//
// The list of codes GFC can bill, which decides which NCCI rows
// scripts/load_ncci_tables.js keeps. OpenEMR is the source of truth and
// cannot be read headlessly (no service account), so this is updated by hand
// until one exists.
//
//   node scripts/billable_codes.js list
//   node scripts/billable_codes.js seed              # the owner's 2026-11-04 export; only if empty
//   node scripts/billable_codes.js seed --replace    # replace the whole list with the seed
//   node scripts/billable_codes.js add 99211 G0511   # codes entered in OpenEMR since
//   node scripts/billable_codes.js remove 99211      # a code deleted from OpenEMR
//   node scripts/billable_codes.js from-catalog      # add every code in the catalog the app cached
//
// `from-catalog` reads openemr_code_catalog, which an admin fills by pressing
// Refresh Catalog in the admin hub (that read runs as the admin). It adds and
// never removes, so a code a clinician billed is not dropped by a short read.
// After any change, re-run scripts/load_ncci_tables.js.
'use strict';

const path = require('path');
const B = require(path.join(__dirname, '..', 'billableCodes'));

async function main(argv, opts = {}) {
  const db = opts.db || require(path.join(__dirname, '..', 'dataStore')).createStore();
  const log = opts.log || console.log;
  const [cmd, ...rest] = argv;
  const flags = rest.filter(a => a.startsWith('--'));
  const args = rest.filter(a => !a.startsWith('--'));
  const stored = (await db.get(B.KV_KEY)) || [];
  const now = new Date().toISOString();
  const save = async (rows, what) => {
    await db.set(B.KV_KEY, rows);
    log(`${what}. gfc_billable_codes now holds ${rows.length} code(s). Re-run scripts/load_ncci_tables.js to apply it.`);
    return { ok: true, count: rows.length };
  };

  if (cmd === 'list') {
    log(`gfc_billable_codes: ${stored.length} code(s)`);
    for (const r of stored) log(`  ${r.code.padEnd(6)} ${r.source.padEnd(16)} ${r.updatedAt}`);
    return { ok: true, count: stored.length };
  }
  if (cmd === 'seed') {
    if (stored.length && !flags.includes('--replace')) {
      log(`gfc_billable_codes already holds ${stored.length} code(s); nothing changed. Use --replace to overwrite it with the seed.`);
      return { ok: false, count: stored.length };
    }
    return save(B.rowsFor(B.readSeedCodes(), 'openemr_seed', now), `Seeded from ${path.relative(process.cwd(), B.SEED_FILE)}`);
  }
  if (cmd === 'add' || cmd === 'remove') {
    const codes = args.map(B.normalizeCode);
    const bad = args.filter((a, i) => !codes[i]);
    if (!args.length || bad.length) {
      log(bad.length ? `Not a CPT or HCPCS code: ${bad.join(', ')}. Nothing changed.` : `Name at least one code to ${cmd}.`);
      return { ok: false, count: stored.length };
    }
    return cmd === 'add'
      ? save(B.mergeInto(stored, B.rowsFor(codes, 'manual', now)), `Added ${codes.join(', ')}`)
      : save(B.removeFrom(stored, codes), `Removed ${codes.join(', ')}`);
  }
  if (cmd === 'from-catalog') {
    const catalog = await db.get('openemr_code_catalog');
    const codes = B.codesFromCatalog(catalog);
    if (!codes.length) {
      log('The app has no cached OpenEMR catalog. An admin presses Refresh Catalog in the admin hub first. Nothing changed.');
      return { ok: false, count: stored.length };
    }
    const before = new Set(stored.map(r => r.code));
    const added = codes.filter(c => !before.has(c));
    return save(B.mergeInto(stored, B.rowsFor(codes, 'openemr_catalog', now)),
      `Copied ${codes.length} code(s) from the catalog fetched ${catalog.fetchedAt}; ${added.length} new${added.length ? ` (${added.join(', ')})` : ''}`);
  }
  log('Usage: node scripts/billable_codes.js list | seed [--replace] | add CODE... | remove CODE... | from-catalog');
  return { ok: false, count: stored.length };
}

module.exports = { main };

if (require.main === module) {
  main(process.argv.slice(2))
    .then(r => process.exit(r.ok ? 0 : 1))
    .catch(e => { console.error('billable_codes failed:', e.message); process.exit(1); });
}
