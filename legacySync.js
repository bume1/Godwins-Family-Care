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

// ── Admin email (mirror of buildAdminEmail in gfc_roi_upload.gs) ──
// fileNames/fileUrls may be arrays (multi-provider) or single strings.
function buildAdminEmailHtml(clientName, tokenOrKey, fileNames, fileUrls) {
  const names = Array.isArray(fileNames) ? fileNames : [fileNames];
  const urls = Array.isArray(fileUrls) ? fileUrls : [fileUrls];

  let fileLines = '';
  names.forEach((name, i) => {
    const url = urls[i] || '';
    fileLines += `<p style="font-size:14px;color:#3a4a52;line-height:1.6;margin:0 0 6px;">`
      + `<strong>${names.length > 1 ? 'File ' + (i + 1) + ':' : 'File:'}</strong> ${esc(name)}`
      + (url ? ` &nbsp;<a href="${esc(url)}" style="color:#033D50;font-size:13px;">View in Drive</a>` : '')
      + `</p>`;
  });

  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#FAF7F2;font-family:Arial,sans-serif;">`
    + `<div style="max-width:600px;margin:32px auto;">`
    + `<div style="background:#033D50;padding:28px 40px;border-radius:8px 8px 0 0;">`
    + `<span style="color:#fff;font-family:Georgia,serif;font-size:18px;">Godwins Family Care</span>`
    + `</div><div style="background:#F5CD85;height:4px;"></div>`
    + `<div style="background:#fff;padding:40px;border-radius:0 0 8px 8px;">`
    + `<h1 style="font-family:Georgia,serif;font-size:20px;color:#033D50;margin:0 0 16px;">Provider ROI Received</h1>`
    + `<p style="font-size:14px;color:#3a4a52;line-height:1.75;margin:0 0 12px;">A completed authorization was received for <strong>${esc(clientName)}</strong>.`
    + (names.length > 1 ? ` <strong>${names.length} PDFs attached</strong> — one per provider.` : ` PDF attached.`)
    + `</p>`
    + `<p style="font-size:14px;color:#3a4a52;line-height:1.75;margin:0 0 4px;"><strong>Reference:</strong> ${esc(tokenOrKey)}</p>`
    + fileLines
    + `<p style="font-size:13px;color:#8a9aa2;margin-top:20px;">Drive links have also been written to the intake sheet (parallel run).</p>`
    + `</div><div style="text-align:center;padding:20px;font-size:11px;color:#8a9aa2;">Godwins Family Care LLC &nbsp;·&nbsp; (404) 913-6705</div>`
    + `</div></body></html>`;
}

// ── Patient confirmation email (mirror of buildPatientEmail; no PDF attached) ──
function buildPatientEmailHtml(patientName) {
  const first = (patientName || '').split(' ')[0] || 'there';
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#FAF7F2;font-family:Arial,sans-serif;">`
    + `<div style="max-width:600px;margin:32px auto;">`
    + `<div style="background:#033D50;padding:28px 40px;border-radius:8px 8px 0 0;">`
    + `<span style="color:#fff;font-family:Georgia,serif;font-size:18px;">Godwins Family Care</span>`
    + `</div><div style="background:#F5CD85;height:4px;"></div>`
    + `<div style="background:#fff;padding:40px;border-radius:0 0 8px 8px;">`
    + `<h1 style="font-family:Georgia,serif;font-size:20px;color:#033D50;margin:0 0 20px;">We received your form.</h1>`
    + `<p style="font-size:14px;color:#3a4a52;line-height:1.8;margin:0 0 14px;">Hi ${esc(first)},</p>`
    + `<p style="font-size:14px;color:#3a4a52;line-height:1.8;margin:0 0 14px;">Your signed Authorization to Obtain Medical Records was received. Our care team will use it to request your records from your provider and will be in touch with next steps.</p>`
    + `<p style="font-size:14px;color:#3a4a52;line-height:1.8;margin:0 0 24px;">Please don't hesitate to reach out with any questions.</p>`
    + `<p style="font-size:14px;color:#3a4a52;line-height:1.8;margin:0;">Warmly,<br><strong>Godwins Family Care</strong><br>`
    + `<a href="tel:4049136705" style="color:#033D50;">(404) 913-6705</a> &nbsp;·&nbsp; <a href="mailto:info@godwinsfamilycarellc.com" style="color:#033D50;">info@godwinsfamilycarellc.com</a></p>`
    + `</div><div style="text-align:center;padding:20px;font-size:11px;color:#8a9aa2;">Godwins Family Care LLC &nbsp;·&nbsp; 4300 Paces Ferry Rd SE, Ste 500, Atlanta, GA 30339</div>`
    + `</div></body></html>`;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

module.exports = {
  logRoiToSheet,
  buildAdminEmailHtml,
  buildPatientEmailHtml
};
