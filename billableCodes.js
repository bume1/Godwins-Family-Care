'use strict';
// gfc_billable_codes: the CPT4/HCPCS codes GFC can bill, mirrored from
// OpenEMR's `codes` table (owner, 2026-11-04). A list of
// { code, source, updatedAt }.
//
// Why it exists: scripts/load_ncci_tables.js filters CMS's NCCI files down to
// GFC's codes. Its universe used to be only favorites, prior selections and
// billed history, which in September came to eight home-visit codes, so the
// loaded tables covered eight codes. This list is the fourth source and the
// one that says what GFC *can* bill, not only what it already has.
//
// OpenEMR stays the source of truth. Nothing reads OpenEMR headlessly (no
// service account), so this is kept in step by hand: seeded once from the
// owner's export, then `node scripts/billable_codes.js` adds, removes, or
// copies from the catalog the app cached (codeCatalog.js) after an admin
// refresh. It is not what the app offers clinicians; that is still the live
// catalog. It only decides which NCCI rows are loaded.

const fs = require('fs');
const path = require('path');

const KV_KEY = 'gfc_billable_codes';
const SEED_FILE = path.join(__dirname, 'scripts', 'data', 'gfc_billable_codes_seed.json');
const SOURCES = Object.freeze(['openemr_seed', 'openemr_catalog', 'manual']);
const CODE_RE = /^(\d{4}[0-9A-Z]|[A-V]\d{4})$/;

const normalizeCode = (c) => {
  const s = String(c == null ? '' : c).trim().toUpperCase();
  return CODE_RE.test(s) ? s : null;
};

// One row per code, sorted, bad shapes dropped. The newest row for a code wins.
const normalizeList = (rows) => {
  const byCode = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    const code = normalizeCode(r && r.code);
    if (!code) continue;
    const prev = byCode.get(code);
    const row = { code, source: SOURCES.includes(r.source) ? r.source : 'manual', updatedAt: String(r.updatedAt || '') };
    if (!prev || row.updatedAt >= prev.updatedAt) byCode.set(code, row);
  }
  return [...byCode.values()].sort((a, b) => a.code.localeCompare(b.code));
};

const readSeedCodes = (file = SEED_FILE) => {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  return (data.codes || []).map(normalizeCode).filter(Boolean);
};

// Rows for a set of codes from one source, stamped now.
const rowsFor = (codes, source, at = new Date().toISOString()) =>
  normalizeList((codes || []).map(code => ({ code, source, updatedAt: at })));

// Merge new rows into the stored list (adds and re-stamps, never removes).
const mergeInto = (stored, incoming) => normalizeList([...(stored || []), ...(incoming || [])]);
const removeFrom = (stored, codes) => {
  const drop = new Set((codes || []).map(normalizeCode).filter(Boolean));
  return normalizeList((stored || []).filter(r => !drop.has(String(r.code).toUpperCase())));
};

// Every code in the catalog the app cached from OpenEMR, active AND inactive:
// a code switched off in OpenEMR can still sit on an older claim.
const codesFromCatalog = (catalog) => {
  if (!catalog || !Array.isArray(catalog.codes)) return [];
  return [...catalog.codes, ...(catalog.inactive || [])].map(e => normalizeCode(e && e.code)).filter(Boolean);
};

// The boot seed: writes the seed only when the collection has NEVER been set.
// An empty list somebody saved on purpose stays empty, and the NCCI loader
// then stops and says so.
const seedIfMissing = async (db, { file = SEED_FILE, now = new Date().toISOString() } = {}) => {
  const existing = await db.get(KV_KEY);
  if (existing != null) return { seeded: false, count: Array.isArray(existing) ? existing.length : 0 };
  const rows = rowsFor(readSeedCodes(file), 'openemr_seed', now);
  await db.set(KV_KEY, rows);
  return { seeded: true, count: rows.length };
};

module.exports = {
  KV_KEY, SEED_FILE, SOURCES, normalizeCode, normalizeList, readSeedCodes, rowsFor,
  mergeInto, removeFrom, codesFromCatalog, seedIfMissing
};
