#!/usr/bin/env node
// ============================================================
// GODWINS FAMILY CARE — one-time legacy Transfer-of-Care ROI importer
// Session 3.4
//
// Reads the legacy "Assessments & Intakes" Google Sheet, and for every row with
// a populated "Provider ROI URL" creates a matching consent_event
// (source=legacy_import, status signed) in the new KV data model, copies the
// PDF into the same Drive folder the new system uses, and creates
// consent_provider_authorizations rows where the legacy data supports it.
//
// Idempotent: re-running does NOT duplicate consent_events. Dedupe key is a
// sha256 of (client_id + signed_at + file hash) stored as `dedupe_hash` on the
// event. Rows already imported are skipped.
//
// Does NOT delete or modify anything in Drive or the Google Sheet — the legacy
// system keeps working through the parallel-run window.
//
// USAGE:
//   ROI_LEGACY_SHEET_ID=<id> REPLIT_DB_URL=<url> node scripts/import_legacy_transfer_rois.js [--dry-run]
//
// Requires the Google connector (REPLIT_CONNECTORS_HOSTNAME) for sheet reads +
// Drive copies. Without it the script reports that it cannot reach Google and
// exits without writing. TEST DATA ONLY until HIPAA-live.
// ============================================================

const path = require('path');
const Database = require('@replit/database');
const config = require('../config');
const googledrive = require('../googledrive');
const roiRepo = require('../roiRepository');

const DRY_RUN = process.argv.includes('--dry-run');

const db = new Database();
const roiStore = roiRepo.createRepository(db);

function log(...args) { console.log('[roi-import]', ...args); }

// Resolve a legacy sheet row's token/key to a client_id in the KV `users`
// collection. Legacy rows are keyed by an intake token in column A; portal
// clients may carry that token as `legacyIntakeToken`. Falls back to slug/id.
async function resolveClientId(users, token) {
  if (!token) return null;
  const byToken = users.find(u => u.legacyIntakeToken === token);
  if (byToken) return byToken.id;
  const bySlug = users.find(u => u.slug === token || u.id === token);
  return bySlug ? bySlug.id : null;
}

async function main() {
  const sheetId = config.ROI_LEGACY_SHEET_ID;
  if (!sheetId) {
    log('No ROI_LEGACY_SHEET_ID configured — nothing to import. Set it and re-run.');
    process.exit(0);
  }

  let sheets;
  try {
    sheets = await googledrive.getSheetsClient();
  } catch (e) {
    log('Cannot reach Google Sheets (connector not configured):', e.message);
    log('This script must run inside the Google-connected boundary. Aborting without writes.');
    process.exit(1);
  }

  const tab = config.ROI_LEGACY_SHEET_TAB;
  let values;
  try {
    const resp = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: tab });
    values = resp.data.values || [];
  } catch (e) {
    log('Failed to read sheet:', e.message);
    process.exit(1);
  }
  if (values.length < 2) { log('Sheet has no data rows.'); process.exit(0); }

  const headers = values[0];
  const tokenCol = 0; // column A = token
  const urlCol = headers.indexOf('Provider ROI URL');
  const fileCol = headers.indexOf('Provider ROI File');
  const fnCol = headers.indexOf('Client First Name');
  const lnCol = headers.indexOf('Client Last Name');
  if (urlCol < 0) { log('No "Provider ROI URL" column found — nothing to import.'); process.exit(0); }

  const users = (await db.get('users')) || [];

  let created = 0, skipped = 0, unmatched = 0;
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const url = (row[urlCol] || '').trim();
    if (!url) continue; // only rows with a provider ROI on file

    const token = (row[tokenCol] || '').trim();
    const fileField = (row[fileCol] || '').trim();
    // A row may hold multiple pipe-joined URLs/files (multi-provider legacy submit).
    const urls = url.split('|').map(s => s.trim()).filter(Boolean);
    const files = fileField.split('|').map(s => s.trim()).filter(Boolean);

    const clientId = await resolveClientId(users, token);
    if (!clientId) { unmatched++; log(`row ${i + 1}: no client match for token "${token}" — skipping`); continue; }

    // signed_at: legacy sheet has no explicit ROI timestamp; use a stable
    // synthetic derived from the row so the dedupe hash is deterministic.
    const signedAt = `legacy:${token}`;
    const dedupeHash = roiRepo.contentHash([clientId, signedAt, urls.join('|'), files.join('|')]);

    const existing = await roiStore.findEventByDedupeHash(dedupeHash);
    if (existing) { skipped++; continue; }

    const first = fnCol >= 0 ? (row[fnCol] || '') : '';
    const last = lnCol >= 0 ? (row[lnCol] || '') : '';
    const printedName = `${first} ${last}`.trim() || 'Legacy Import';

    if (DRY_RUN) { log(`row ${i + 1}: WOULD import event for client ${clientId} (${urls.length} url(s))`); created++; continue; }

    // Create the legacy consent_event.
    const event = await roiStore.insertConsentEvent({
      client_id: clientId,
      signed_at: signedAt,
      printed_name: printedName,
      includes_protected_info: false, // unknown from legacy; conservative default
      source: roiRepo.SOURCE.LEGACY_IMPORT
    });
    // Persist the dedupe hash for idempotency.
    const events = await db.get('consent_events');
    const ei = events.findIndex(e => e.id === event.id);
    if (ei >= 0) { events[ei].dedupe_hash = dedupeHash; await db.set('consent_events', events); }

    // Provider authorization rows: one per URL when the file names carry a
    // provider (structured legacy submit). A single scan/upload with no
    // structured provider data → zero rows (admin classifies later).
    const providerRows = [];
    for (let u = 0; u < urls.length; u++) {
      const fname = files[u] || '';
      // Legacy generated PDFs are named ROI_<Client>_<Provider>_<date>[_seq].pdf.
      const m = fname.match(/^ROI_[^_]+_(.+?)_\d{8}(?:_\d+)?\.pdf$/i);
      const providerName = m ? m[1].replace(/_/g, ' ') : '';
      if (providerName) {
        providerRows.push({ provider_name: providerName, generated_pdf_drive_url: urls[u], file_name: fname });
      }
    }
    if (providerRows.length) {
      await roiStore.insertProviderAuthorizations(event.id, providerRows);
    }

    // Copy each PDF into the ROI Drive folder (idempotent: skip if already there).
    for (let u = 0; u < urls.length; u++) {
      try {
        await copyDrivePdfIfNeeded(urls[u], files[u] || `legacy_${token}_${u + 1}.pdf`);
      } catch (e) {
        log(`row ${i + 1}: Drive copy skipped (${e.message})`);
      }
    }

    // Roll up the client status.
    const ui = users.findIndex(x => x.id === clientId);
    if (ui >= 0) {
      users[ui].consents = { ...(users[ui].consents || {}), roiTransfer: 'signed' };
    }

    created++;
    log(`row ${i + 1}: imported event ${event.id} (${providerRows.length} provider row(s))`);
  }

  if (!DRY_RUN) { await db.set('users', users); }

  log(`Done. created=${created} skipped(existing)=${skipped} unmatched=${unmatched}${DRY_RUN ? ' (dry run — no writes)' : ''}`);
  process.exit(0);
}

// Copy a Drive file (by shareable URL) into the ROI folder if a file of the same
// name isn't already present there. Best-effort; never modifies the source.
async function copyDrivePdfIfNeeded(sourceUrl, fileName) {
  const drive = await getDrive();
  const folderId = await googledrive.findOrCreateFolder(config.ROI_DRIVE_FOLDER_NAME, null);
  // Already present at destination?
  const existing = await drive.files.list({
    q: `name='${String(fileName).replace(/'/g, "\\'")}' and '${folderId}' in parents and trashed=false`,
    fields: 'files(id,name)'
  });
  if (existing.data.files && existing.data.files.length) return; // idempotent skip

  const sourceId = extractDriveId(sourceUrl);
  if (!sourceId) throw new Error('cannot parse source Drive id');
  await drive.files.copy({ fileId: sourceId, requestBody: { name: fileName, parents: [folderId] } });
}

async function getDrive() {
  return googledrive.getDriveClient();
}

function extractDriveId(url) {
  if (!url) return null;
  const m = String(url).match(/[-\w]{25,}/);
  return m ? m[0] : null;
}

main().catch(e => { console.error('[roi-import] fatal:', e); process.exit(1); });
