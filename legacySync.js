// ============================================================
// GODWINS FAMILY CARE — Transfer-of-Care ROI legacy parallel-run sync
// Session 3.4
//
// During the transition off the WordPress + Google Apps Script system, every
// Transfer-of-Care consent_event created in the portal ALSO mirrors the legacy
// behavior of gfc_roi_upload.gs:
//   • a log row in the "Assessments & Intakes" Google Sheet
//     (columns "Provider ROI URL" / "Provider ROI File"),
//   • an admin email (buildAdminEmail equivalent) with the PDFs attached,
//   • a patient/submitter confirmation email (buildPatientEmail equivalent).
//
// All of this is gated by config.PARALLEL_LEGACY_SYNC (default true); Track 0
// flips it false at cutover. Everything here is BEST-EFFORT and non-fatal: when
// the Google connector is not configured (e.g. dev, or the AWS boundary), the
// sheet write throws and is swallowed — the portal's own KV record is the
// source of truth regardless.
//
// Do NOT delete or modify existing sheet data beyond writing the two ROI
// columns on the matching/appended row. TEST DATA ONLY until HIPAA-live.
// ============================================================

const googledrive = require('./googledrive');

// ── Google Sheet logger (mirror of logROIToSheet in gfc_roi_upload.gs) ──
// Finds the row whose first column equals `key`; writes the two ROI columns.
// If no matching row exists (portal client not in the legacy intake sheet),
// appends a new row keyed by `key`. Returns { ok, appended } or { ok:false }.
async function logRoiToSheet(sheetId, tabName, key, fileName, fileUrl) {
  if (!sheetId) return { ok: false, skipped: 'no ROI_LEGACY_SHEET_ID configured' };
  try {
    const sheets = await googledrive.getSheetsClient();
    const range = `${tabName}`;
    const resp = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range });
    const values = resp.data.values || [];
    if (values.length === 0) return { ok: false, skipped: 'empty sheet' };

    const headers = values[0];
    let urlCol = headers.indexOf('Provider ROI URL');
    let fileCol = headers.indexOf('Provider ROI File');

    // Create the two columns if the legacy sheet doesn't have them yet.
    const headerUpdates = [];
    if (urlCol < 0) { urlCol = headers.length; headers[urlCol] = 'Provider ROI URL'; headerUpdates.push(true); }
    if (fileCol < 0) { fileCol = headers.length; headers[fileCol] = 'Provider ROI File'; headerUpdates.push(true); }
    if (headerUpdates.length) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range: `${tabName}!A1`,
        valueInputOption: 'RAW',
        requestBody: { values: [headers] }
      });
    }

    // Find the row whose column A matches the key.
    let rowIndex = -1;
    for (let i = 1; i < values.length; i++) {
      if (values[i][0] === key) { rowIndex = i; break; }
    }

    if (rowIndex >= 0) {
      // Update the two ROI cells in place.
      const a1 = (colIdx, rowIdx) => `${tabName}!${columnLetter(colIdx)}${rowIdx + 1}`;
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: sheetId,
        requestBody: {
          valueInputOption: 'RAW',
          data: [
            { range: a1(urlCol, rowIndex), values: [[fileUrl]] },
            { range: a1(fileCol, rowIndex), values: [[fileName]] }
          ]
        }
      });
      return { ok: true, appended: false };
    }

    // No matching row — append a new one (parallel log capture).
    const newRow = [];
    newRow[0] = key;
    newRow[urlCol] = fileUrl;
    newRow[fileCol] = fileName;
    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: `${tabName}!A1`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [newRow] }
    });
    return { ok: true, appended: true };
  } catch (err) {
    console.error('[ROI legacy sheet] non-fatal:', err.message);
    return { ok: false, error: err.message };
  }
}

function columnLetter(idx) {
  let s = '';
  let n = idx;
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return s;
}

// Both of these used to hand-roll their own HTML. They were close to the house
// style by eye and wrong in the details — a text wordmark instead of the logo,
// no signature block, and the patient one printed info@ while every other
// email the app sends says support@. They render through `emailTemplates` now,
// like everything else. Do not reintroduce markup here; the build fails on it.
const { renderGfcEmail } = require('./emailTemplates');

// ── Admin email (mirror of buildAdminEmail in gfc_roi_upload.gs) ──
// fileNames/fileUrls may be arrays (multi-provider) or single strings.
// Internal, so it may name the client; the patient-facing one below may not
// carry anything a person did not already know about themselves.
function buildAdminEmailHtml(clientName, tokenOrKey, fileNames, fileUrls) {
  const names = Array.isArray(fileNames) ? fileNames : [fileNames];
  const urls = Array.isArray(fileUrls) ? fileUrls : [fileUrls];

  const fields = [{ label: 'Reference', value: tokenOrKey, mono: true }];
  names.forEach((name, i) => {
    if (!name) return;
    fields.push({ label: names.length > 1 ? `File ${i + 1}` : 'File', value: name });
  });

  // One Drive link becomes the button; several are listed in the prose, since
  // a template has one call to action and picking a file arbitrarily is worse
  // than naming them all.
  const links = urls.filter(Boolean);
  const paragraphs = [
    `A completed authorization was received for ${clientName}.` +
      (names.length > 1 ? ` ${names.length} PDFs are attached, one per provider.` : ' The PDF is attached.')
  ];
  if (links.length > 1) paragraphs.push(`Drive copies: ${links.join('  ·  ')}`);
  paragraphs.push('Drive links have also been written to the intake sheet (parallel run).');

  return renderGfcEmail({
    greeting: null,
    headline: 'Provider ROI received',
    paragraphs,
    fields,
    ctaUrl: links.length === 1 ? links[0] : null,
    ctaLabel: links.length === 1 ? 'View in Drive' : null
  }).html;
}

// ── Patient confirmation email (mirror of buildPatientEmail; no PDF attached) ──
function buildPatientEmailHtml(patientName) {
  const first = (patientName || '').split(' ')[0] || null;
  return renderGfcEmail({
    greeting: first,
    headline: 'We received your form',
    paragraphs: [
      'Your signed Authorization to Obtain Medical Records was received. Our care team will use it to request your records from your provider and will be in touch with next steps.',
      'Please reach out any time if you have questions.'
    ]
  }).html;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

module.exports = {
  logRoiToSheet,
  buildAdminEmailHtml,
  buildPatientEmailHtml
};
