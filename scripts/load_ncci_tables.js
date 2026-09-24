#!/usr/bin/env node
// ============================================================================
// scripts/load_ncci_tables.js — quarterly NCCI/MUE reference-data loader
//
// Feeds the sign-time bundling gate (clinicalRepository.js `checkNcciBundling`,
// wired into `checkSignReadiness`). Without this having run at least once, the
// gate reports NCCI_DATA_STALE and refuses every sign — deliberately: a stale
// bundling check that passes everything is worse than an honest refusal.
//
//   node scripts/load_ncci_tables.js
//   node scripts/load_ncci_tables.js --quarter=2026Q4
//   node scripts/load_ncci_tables.js --ptp-dir=/path/to/downloaded/zips
//
// WHERE THIS DATA LIVES, AND WHY IT IS NOT A SQL TABLE. This app's production
// data store (dataStore.js) is whole-collection JSON blobs under one Postgres
// table (app_kv), the same shape `gfc_payer_credentialing` already uses —
// there is no generic mechanism in this codebase for an arbitrary new
// relational table, and the dev/test adapters (kv, memory) have no SQL layer
// at all. So `gfc_ncci_ptp_edits`, `gfc_ncci_mue` and `gfc_ncci_source_version`
// are KV collections, written with the app's own db.get/db.set, registered in
// dataMigration.js's COLLECTION_REGISTRY exactly like every other collection
// in this app. The field names and semantics match what a SQL schema for this
// data would hold; only the storage mechanism differs.
//
// THE TWO SOURCE FILES ARE NOT SYMMETRIC.
//   MUE  — a plain, unauthenticated URL. Fetched here, automatically, every run.
//   PTP  — routes through an AMA license click-through on cms.gov, because the
//          file lists actual CPT codes. A script cannot accept that agreement.
//          A HUMAN downloads the four "Practitioner PTP Edits" ZIP files
//          (split by code range) and places them in scripts/ncci_source/ptp/
//          (or points --ptp-dir / NCCI_PTP_SOURCE_DIR at wherever they put
//          them). If they are not found there, this script says exactly that
//          and names the CMS page — it does not try to work around the gate,
//          and it does not fail silently.
//
// FILTERED ON LOAD, NEVER STORED WHOLE. The four PTP ZIPs total on the order
// of 2.7 million rows; GFC bills on the order of dozens of codes. This app
// keeps no authoritative list of its own of "every code GFC bills" — the
// clinical code-search notice says so explicitly ("The app keeps no code list
// of its own"), and OpenEMR's own fee schedule cannot be read headlessly
// (Session 5.2: per-clinician OAuth only, no service account). So the
// practical, zero-live-dependency universe used here is the UNION of the
// practice's own admin-curated favorites (clinical_settings), every
// clinician's actual prior code selections (clinical_code_usage), and every
// code that has ever actually been billed (encounter_billing) — the real,
// locally-derivable ground truth of what GFC bills, rather than a guessed
// static list. A PTP row is kept if EITHER of its two codes is in that
// universe; the MUE table is filtered the same way for consistency.
//
// IDEMPOTENT BY CONSTRUCTION. Each write REPLACES the whole collection (the
// blob model has no per-row accumulation), so there is no "duplicate quarter"
// to guard against the way an append-only table would need to. Re-running
// against the same quarter's files reloads the same data.
//
// TEXT, NOT EXCEL. Each CMS zip contains both a .txt and an .xlsx rendition of
// the same table. The .txt is parsed — no new dependency for reading Excel's
// binary format, consistent with this repo's own dependency-free ZIP writer.
// `unzip` (already relied on elsewhere in this repo) reads the archive.
//
// PARSED BY SHAPE, NOT BY POSITION. CMS's own published column order is
// documented (Column 1 code, Column 2 code, effective date, deletion date,
// modifier indicator, rationale for PTP; code, MUE value, MAI for MUE), but
// this script does not trust a fixed field INDEX for the two facts that
// matter (the codes, and the single 0/1/9 modifier indicator) — it finds them
// by what they look like. A CMS quarter that adds or drops a column changes
// nothing here; a row that does not look like data is skipped rather than
// guessed at.
// ============================================================================
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);

const clinicalRepo = require(path.join(__dirname, '..', 'clinicalRepository'));

// ---- quarter arithmetic -----------------------------------------------------
const QUARTER_START_MONTH = [0, 3, 6, 9]; // Jan, Apr, Jul, Oct (0-indexed)
// CMS posts the UPCOMING quarter's files roughly a month ahead of its
// effective date (2026 Q4 files, effective Oct 1, were posted Sept 2) — so
// within 45 days of a quarter boundary the quarter worth loading is the NEXT
// one, not the one currently in effect. This is a computed default, always
// printed, and always overridable with --quarter=YYYYQN when it guesses wrong.
const computeTargetQuarter = (now = new Date()) => {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const qIdx = QUARTER_START_MONTH.filter(m => m <= month).length - 1;
  const nextIdx = (qIdx + 1) % 4;
  const nextYear = nextIdx === 0 ? year + 1 : year;
  const nextStart = Date.UTC(nextYear, QUARTER_START_MONTH[nextIdx], 1);
  const daysToNext = (nextStart - now.getTime()) / 86400000;
  return daysToNext <= 45 ? { year: nextYear, quarter: nextIdx + 1 } : { year, quarter: qIdx + 1 };
};
const quarterLabel = ({ year, quarter }) => `${year}Q${quarter}`;
const parseQuarterArg = (s) => {
  const m = /^(\d{4})Q([1-4])$/i.exec(String(s || '').trim());
  if (!m) throw new Error(`--quarter must look like 2026Q4, got "${s}"`);
  return { year: Number(m[1]), quarter: Number(m[2]) };
};
const mueUrl = ({ year, quarter }) => `https://www.cms.gov/files/zip/medicare-ncci-${year}-q${quarter}-practitioner-services-mue-table.zip`;

// ---- field-shape parsing, not fixed-position parsing ------------------------
const isCodeShaped = (f) => !!clinicalRepo.classifyServiceCode(f);
const MI_RE = /^[019]$/;
const NUMERIC_RE = /^\d+$/;
const MAI_RE = /^[123]$/;

const splitFields = (line) => {
  const clean = (arr) => arr.map(s => s.trim().replace(/^"|"$/g, '')).filter(Boolean);
  const tab = clean(line.split('\t'));
  if (tab.length >= 3) return tab;
  const comma = clean(line.split(','));
  if (comma.length >= 3) return comma;
  return clean(line.split(/\s{2,}/));
};

// null for a line that is not a data row (a header, a page break, a blank
// separator) — CMS's text files are not perfectly uniform across quarters,
// and a row that does not look like data is skipped rather than guessed at.
const parsePtpLine = (line) => {
  const fields = splitFields(line);
  const codes = fields.filter(isCodeShaped);
  if (codes.length < 2) return null;
  const miField = fields.find(f => MI_RE.test(f));
  if (!miField) return null;
  return { column1Code: codes[0].toUpperCase(), column2Code: codes[1].toUpperCase(), modifierIndicator: Number(miField) };
};
const parseMueLine = (line) => {
  const fields = splitFields(line);
  const code = fields.find(isCodeShaped);
  if (!code) return null;
  // A 5-digit CPT code (e.g. "99213") is itself all-digits, so it must be
  // excluded here or it gets picked up as its own MUE value — caught by
  // test/ncci_load.test.js before this ever touched a real file.
  const numeric = fields.filter(f => f !== code && NUMERIC_RE.test(f));
  if (!numeric.length) return null;
  const mueValue = Number(numeric[0]);
  const mai = (numeric[1] && MAI_RE.test(numeric[1])) ? numeric[1] : null;
  return { code: code.toUpperCase(), mueValue, mai };
};

// ---- GFC's own code universe, derived, never a hand-kept list --------------
const deriveGfcCodeUniverse = ({ serviceCodeFavorites, codeUsage, encounterBillingRows }) => {
  const codes = new Set();
  for (const f of (serviceCodeFavorites || [])) if (f && f.code) codes.add(String(f.code).toUpperCase());
  for (const u of (codeUsage || [])) if (u && u.code && u.set !== 'ICD10') codes.add(String(u.code).toUpperCase());
  for (const rec of (encounterBillingRows || [])) {
    for (const s of ((rec && rec.services) || [])) if (s && s.code) codes.add(String(s.code).toUpperCase());
  }
  return codes;
};

// ---- diffing against whatever was loaded before ----------------------------
const diffPtp = (oldRows, newRows) => {
  const key = (e) => `${e.column1Code}|${e.column2Code}`;
  const o = new Map((oldRows || []).map(e => [key(e), e]));
  const n = new Map((newRows || []).map(e => [key(e), e]));
  const added = [...n.keys()].filter(k => !o.has(k)).length;
  const removed = [...o.keys()].filter(k => !n.has(k)).length;
  const indicatorChanged = [...n.keys()].filter(k => o.has(k) && o.get(k).modifierIndicator !== n.get(k).modifierIndicator).length;
  return { added, removed, indicatorChanged };
};
const diffMue = (oldByCode, newByCode) => {
  const o = oldByCode || {}; const n = newByCode || {};
  const added = Object.keys(n).filter(c => !(c in o)).length;
  const removed = Object.keys(o).filter(c => !(c in n)).length;
  const valueChanged = Object.keys(n).filter(c => (c in o) && (o[c].mueValue !== n[c].mueValue || o[c].mai !== n[c].mai)).length;
  return { added, removed, valueChanged };
};

// ---- reading a zip's .txt member(s) without ever writing extracted files ---
const listZipEntries = async (zipPath) => {
  const { stdout } = await execFileP('unzip', ['-Z1', zipPath]);
  return stdout.split('\n').map(s => s.trim()).filter(Boolean);
};
const readZipEntryText = async (zipPath, entryName) => {
  const { stdout } = await execFileP('unzip', ['-p', zipPath, entryName], { maxBuffer: 1024 * 1024 * 256, encoding: 'utf8' });
  return stdout;
};
const extractTextLines = async (zipPath) => {
  const entries = await listZipEntries(zipPath);
  const textEntries = entries.filter(e => /\.txt$/i.test(e));
  if (!textEntries.length) throw new Error(`no .txt file inside ${path.basename(zipPath)} (found: ${entries.join(', ') || 'nothing'})`);
  let lines = [];
  for (const entry of textEntries) lines = lines.concat((await readZipEntryText(zipPath, entry)).split(/\r?\n/));
  return lines;
};

const fetchZipBuffer = async (url) => {
  const axios = require('axios');
  const res = await axios.get(url, { responseType: 'arraybuffer', maxRedirects: 5, timeout: 60000 });
  return Buffer.from(res.data);
};

const PTP_SOURCE_PAGE = 'https://www.cms.gov/medicare/coding-billing/national-correct-coding-initiative-ncci-edits/medicare-ncci-procedure-procedure-ptp-edits';
const DEFAULT_PTP_DIR = path.join(__dirname, 'ncci_source', 'ptp');

async function main(opts = {}) {
  const dataStore = require(path.join(__dirname, '..', 'dataStore'));
  const db = opts.db || dataStore.createStore();

  const target = opts.quarter ? parseQuarterArg(opts.quarter) : computeTargetQuarter();
  const label = quarterLabel(target);
  console.log(`\nNCCI/MUE loader — targeting ${label} (say --quarter=YYYYQN if that is wrong)\n`);

  const clinicalSettings = (await db.get('clinical_settings')) || {};
  const favorites = (Array.isArray(clinicalSettings.serviceCodeFavorites) && clinicalSettings.serviceCodeFavorites.length)
    ? clinicalSettings.serviceCodeFavorites : clinicalRepo.DEFAULT_SERVICE_CODE_FAVORITES;
  const codeUsage = (await db.get('clinical_code_usage')) || [];
  const encounterBillingRows = (await db.get('encounter_billing')) || [];
  const codeSet = deriveGfcCodeUniverse({ serviceCodeFavorites: favorites, codeUsage, encounterBillingRows });
  console.log(`GFC's code universe (practice favorites + clinician usage history + billed history): ${codeSet.size} distinct code(s).`);
  if (!codeSet.size) console.log('WARNING: no codes found anywhere in this store — every PTP/MUE row will be filtered out until at least one code has been favorited or billed.');

  const nowIso = new Date().toISOString();
  const summary = { quarter: label, mue: { ok: false }, ptp: { ok: false } };

  // ---- MUE: direct fetch, no human step ----
  try {
    const url = mueUrl(target);
    console.log(`\nFetching MUE table:\n  ${url}`);
    const zipBuf = opts.fetchMueZip ? await opts.fetchMueZip(url) : await fetchZipBuffer(url);
    const tmpZip = path.join(os.tmpdir(), `gfc-ncci-mue-${process.pid}-${Date.now()}.zip`);
    fs.writeFileSync(tmpZip, zipBuf);
    let lines;
    try { lines = await extractTextLines(tmpZip); } finally { fs.unlinkSync(tmpZip); }
    const rawRows = lines.map(parseMueLine).filter(Boolean);
    const kept = rawRows.filter(r => codeSet.has(r.code));
    const byCode = {};
    for (const r of kept) byCode[r.code] = { mueValue: r.mueValue, mai: r.mai };
    const priorMue = (await db.get('gfc_ncci_mue')) || {};
    const diff = diffMue(priorMue, byCode);
    await db.set('gfc_ncci_mue', byCode);
    const v1 = (await db.get('gfc_ncci_source_version')) || {};
    await db.set('gfc_ncci_source_version', { ...v1, mue: { quarter: label, loadedAt: nowIso } });
    summary.mue = { ok: true, rawRowsSeen: rawRows.length, rowsKept: Object.keys(byCode).length, ...diff };
    console.log(`MUE: ${rawRows.length} row(s) parsed, ${Object.keys(byCode).length} kept for GFC's codes.`);
    console.log(`  vs prior load — added ${diff.added}, removed ${diff.removed}, value/MAI changed ${diff.valueChanged}.`);
  } catch (err) {
    summary.mue = { ok: false, error: err.message };
    console.error(`MUE load FAILED: ${err.message}`);
  }

  // ---- PTP: human-downloaded, AMA license-gated ----
  const ptpDir = opts.ptpDir || process.env.NCCI_PTP_SOURCE_DIR || DEFAULT_PTP_DIR;
  let ptpZips = [];
  try { ptpZips = fs.readdirSync(ptpDir).filter(f => /\.zip$/i.test(f)).sort().map(f => path.join(ptpDir, f)); } catch { ptpZips = []; }
  if (!ptpZips.length) {
    summary.ptp = { ok: false, error: 'not_found' };
    console.error(
      `\nPTP load SKIPPED: no .zip files found in ${ptpDir}.\n` +
      'The Practitioner PTP Edits sit behind an AMA license click-through and cannot be fetched by a script.\n' +
      'A human downloads the four "Practitioner PTP Edits" ZIP files (split by code range — confirm the\n' +
      'names say "Practitioner," not "Outpatient Hospital" or "DME") from:\n' +
      `  ${PTP_SOURCE_PAGE}\n` +
      `and places them in ${ptpDir}, then re-runs this script.`
    );
  } else {
    try {
      console.log(`\nFound ${ptpZips.length} local PTP zip(s):`);
      ptpZips.forEach(z => console.log(`  ${path.basename(z)}`));
      let rawRows = [];
      for (const zipPath of ptpZips) rawRows = rawRows.concat((await extractTextLines(zipPath)).map(parsePtpLine).filter(Boolean));
      const kept = rawRows.filter(r => codeSet.has(r.column1Code) || codeSet.has(r.column2Code));
      const priorPtp = (await db.get('gfc_ncci_ptp_edits')) || [];
      const diff = diffPtp(priorPtp, kept);
      await db.set('gfc_ncci_ptp_edits', kept);
      const v2 = (await db.get('gfc_ncci_source_version')) || {};
      await db.set('gfc_ncci_source_version', { ...v2, ptp: { quarter: label, loadedAt: nowIso } });
      summary.ptp = { ok: true, rawRowsSeen: rawRows.length, rowsKept: kept.length, ...diff };
      console.log(`PTP: ${rawRows.length} row(s) parsed across ${ptpZips.length} file(s), ${kept.length} kept for GFC's codes.`);
      console.log(`  vs prior load — added ${diff.added}, removed ${diff.removed}, indicator changed ${diff.indicatorChanged}.`);
    } catch (err) {
      summary.ptp = { ok: false, error: err.message };
      console.error(`PTP load FAILED: ${err.message}`);
    }
  }

  console.log(`\n================  ${label} — MUE ${summary.mue.ok ? 'loaded' : 'FAILED'}, PTP ${summary.ptp.ok ? 'loaded' : 'FAILED'}  ================\n`);
  return summary;
}

module.exports = {
  main, computeTargetQuarter, quarterLabel, parseQuarterArg, mueUrl,
  parsePtpLine, parseMueLine, splitFields, isCodeShaped,
  deriveGfcCodeUniverse, diffPtp, diffMue, extractTextLines,
  PTP_SOURCE_PAGE, DEFAULT_PTP_DIR
};

if (require.main === module) {
  const args = process.argv.slice(2);
  const opt = (name) => { const m = args.find(a => a.startsWith(`--${name}=`)); return m ? m.slice(name.length + 3) : null; };
  main({ quarter: opt('quarter'), ptpDir: opt('ptp-dir') })
    .then((summary) => process.exit(summary.mue.ok && summary.ptp.ok ? 0 : 1))
    .catch((err) => { console.error('\nload_ncci_tables failed:', err.message); process.exit(1); });
}
