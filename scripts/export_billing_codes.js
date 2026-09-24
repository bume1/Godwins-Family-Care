#!/usr/bin/env node
// ============================================================================
// scripts/export_billing_codes.js — the CPT/HCPCS codes and modifiers GFC
// actually bills, for hand-entry into OpenEMR's fee schedule.
//
// WHY THIS EXISTS. OpenEMR ships no CPT table at all (AMA copyright — see
// scripts/load_ncci_tables.js's header for the same constraint) and this app
// keeps no code list of its own either (the clinical code-search notice says
// so explicitly: "The app keeps no code list of its own"). So "our codes"
// has never lived in one place — it is scattered across three collections
// this script already knows how to read, because scripts/load_ncci_tables.js
// derives the identical "GFC's code universe" from the same three sources
// for a different purpose (filtering the NCCI reference tables). This script
// is that derivation, but reported for a HUMAN doing fee-schedule data entry
// rather than filtered for a machine check — so it also surfaces labels and
// the modifiers actually used, which the NCCI loader has no reason to keep.
//
// THE THREE SOURCES, AND WHY ALL THREE MATTER:
//   - clinical_settings.serviceCodeFavorites — the practice's own curated
//     list (admin-set; seeded with the home-visit E/M range GFC bills).
//     These carry a LABEL even before anyone has ever billed them.
//   - clinical_code_usage — every clinician's own prior CPT4/HCPCS
//     selections (ICD10 rows are filtered out; this is a fee schedule, not
//     a diagnosis list).
//   - encounter_billing — every service line ever actually attested on a
//     signed encounter. This is the only source with MODIFIERS on it, read
//     through modifiersForCharge()'s stored shape (svc.modifiers), never a
//     raw field guess — that exact mismatch (svc.modifier vs modifiers) cost
//     this repo a live billing defect on 2026-09-23.
//
// A code appearing in only one source is still reported — a favorite nobody
// has billed yet, or a code a clinician typed once, still belongs in the fee
// schedule before the day someone tries to charge it and cannot.
//
//   node scripts/export_billing_codes.js
//   node scripts/export_billing_codes.js --csv=billing_codes.csv
// ============================================================================
'use strict';

const fs = require('fs');
const path = require('path');

const CODE_TYPES = Object.freeze(['CPT4', 'HCPCS']);

// Pure aggregation — no I/O, so it can be tested without a store. Takes the
// raw rows exactly as the three collections store them and returns one row
// per distinct code, sorted by code.
const aggregateBillingCodes = ({ favorites, usageRows, billingRows } = {}) => {
  const byCode = new Map(); // code -> { code, codeType, label, sources:Set, timesBilled, modifiers:Set }
  const get = (code, codeType) => {
    if (!byCode.has(code)) {
      byCode.set(code, { code, codeType, label: '', sources: new Set(), timesBilled: 0, modifiers: new Set() });
    }
    return byCode.get(code);
  };

  for (const f of Array.isArray(favorites) ? favorites : []) {
    if (!f || !f.code || !CODE_TYPES.includes(f.codeType)) continue;
    const row = get(f.code, f.codeType);
    row.sources.add('favorite');
    if (f.label && !row.label) row.label = String(f.label);
  }

  for (const u of Array.isArray(usageRows) ? usageRows : []) {
    if (!u || !u.code || !CODE_TYPES.includes(u.set)) continue; // ICD10 rows live in the same collection — excluded
    const row = get(u.code, u.set);
    row.sources.add('clinician usage');
    if (u.description && !row.label) row.label = String(u.description);
  }

  for (const rec of Array.isArray(billingRows) ? billingRows : []) {
    for (const svc of Array.isArray(rec && rec.services) ? rec.services : []) {
      if (!svc || !svc.code) continue;
      const codeType = svc.codeType === 'HCPCS' ? 'HCPCS' : 'CPT4';
      const row = get(svc.code, codeType);
      row.sources.add('billed');
      row.timesBilled += 1;
      if ((svc.description || svc.label) && !row.label) row.label = String(svc.description || svc.label);
      for (const m of Array.isArray(svc.modifiers) ? svc.modifiers : []) {
        const v = String(m || '').trim().toUpperCase();
        if (/^[A-Z0-9]{2}$/.test(v)) row.modifiers.add(v);
      }
    }
  }

  return [...byCode.values()]
    .map(r => ({
      code: r.code,
      codeType: r.codeType,
      label: r.label,
      sources: [...r.sources].sort().join('; '),
      timesBilled: r.timesBilled,
      modifiers: [...r.modifiers].sort().join(', ')
    }))
    .sort((a, b) => a.code.localeCompare(b.code));
};

const toCsv = (rows) => {
  const esc = (v) => {
    const s = String(v == null ? '' : v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = ['Code', 'Type', 'Label', 'Sources', 'Times Billed', 'Modifiers Seen'];
  const lines = [header.join(',')];
  for (const r of rows) lines.push([r.code, r.codeType, r.label, r.sources, r.timesBilled, r.modifiers].map(esc).join(','));
  return lines.join('\r\n') + '\r\n';
};

async function main(opts = {}) {
  const dataStore = require(path.join(__dirname, '..', 'dataStore'));
  const db = opts.db || dataStore.createStore();

  const [settings, usageRows, billingRows] = await Promise.all([
    db.get('clinical_settings'),
    db.get('clinical_code_usage'),
    db.get('encounter_billing')
  ]);
  const favorites = (settings && Array.isArray(settings.serviceCodeFavorites) && settings.serviceCodeFavorites.length)
    ? settings.serviceCodeFavorites
    : require(path.join(__dirname, '..', 'clinicalRepository')).DEFAULT_SERVICE_CODE_FAVORITES;

  const rows = aggregateBillingCodes({ favorites, usageRows: usageRows || [], billingRows: billingRows || [] });

  console.log(`\nGFC billing codes — ${rows.length} distinct code(s) across favorites, clinician usage and billed encounters.\n`);
  console.log('Code   Type   Billed  Modifiers        Label');
  console.log('-----  -----  ------  ---------------  -----------------------------');
  for (const r of rows) {
    console.log(
      `${r.code.padEnd(6)} ${r.codeType.padEnd(6)} ${String(r.timesBilled).padEnd(6)}  ${(r.modifiers || '—').padEnd(16)} ${r.label || '(no label on file)'}`
    );
  }
  console.log('\nNo AMA descriptors are printed here — those are copyrighted and live in OpenEMR\'s own fee schedule.');
  console.log('This list is what to hand-enter (or confirm is already entered) there.\n');

  if (opts.csvPath) {
    fs.writeFileSync(opts.csvPath, toCsv(rows));
    console.log(`Wrote ${opts.csvPath}`);
  }

  return rows;
}

module.exports = { main, aggregateBillingCodes, toCsv, CODE_TYPES };

if (require.main === module) {
  const args = process.argv.slice(2);
  const csvArg = args.find(a => a.startsWith('--csv='));
  main({ csvPath: csvArg ? csvArg.slice('--csv='.length) : null })
    .then(() => process.exit(0))
    .catch((err) => { console.error('\nexport_billing_codes failed:', err.message); process.exit(1); });
}
