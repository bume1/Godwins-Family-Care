// ============================================================
// GODWINS FAMILY CARE — Provider ROI Upload Handler
// Backend for template-gfc-roi-upload.php
//
// Deploy as a NEW standalone Apps Script Web App:
//   Execute as: Me
//   Who has access: Anyone (even anonymous)
//
// After deploying, paste the Web App URL into the PHP template
// where it says PASTE_YOUR_ROI_GAS_WEB_APP_URL_HERE.
// ============================================================

var ROI_SPREADSHEET_ID = '1r5DaCU6gMIoY62DvZ-fWSs_RKsMgb94_K5h8f24TWPU';
var ROI_TAB_NAME       = 'Assessments & Intakes';
var ROI_NOTIFY_EMAIL   = 'admin@godwinsfamilycarellc.com';
var ROI_FOLDER_NAME    = 'GFC Provider ROI Uploads';


// ── doPost: called server-to-server from WordPress PHP ───────
function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return jsonOut({ success: false, message: 'No data received.' });
    }
    var data = JSON.parse(e.postData.contents);

    if (data.action === 'uploadROI') {
      return jsonOut(uploadROIFile(data));
    }
    if (data.action === 'generateROIPDF') {
      return jsonOut(generateROIPDF(data));
    }
    return jsonOut({ success: false, message: 'Unknown action.' });

  } catch (err) {
    return jsonOut({ success: false, message: err.message });
  }
}


// ── doGet: health-check only ──────────────────────────────────
function doGet(e) {
  return ContentService
    .createTextOutput('GFC ROI Upload handler — active.')
    .setMimeType(ContentService.MimeType.TEXT);
}


// ── PATH A: File upload ───────────────────────────────────────
function uploadROIFile(params) {
  try {
    var token    = params.token;
    var fileName = params.fileName;
    var base64   = params.fileData;
    var mime     = params.mimeType || 'application/octet-stream';

    if (!token || !fileName || !base64) {
      return { success: false, message: 'Missing required fields.' };
    }
    var clientInfo = getClientForToken(token);
    if (!clientInfo) {
      return { success: false, message: 'Invalid or expired token.' };
    }

    var bytes  = Utilities.base64Decode(base64);
    var blob   = Utilities.newBlob(bytes, mime, fileName);
    var folder = getROIFolder();
    var file   = folder.createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    var fileUrl = file.getUrl();

    logROIToSheet(token, fileName, fileUrl);

    try {
      MailApp.sendEmail({
        to:          ROI_NOTIFY_EMAIL,
        subject:     'Provider ROI Received — ' + clientInfo.name,
        htmlBody:    buildAdminEmail(clientInfo.name, token, fileName, fileUrl),
        attachments: [file.getBlob()]
      });
    } catch(e) {}

    (clientInfo.notifyEmails || []).forEach(function(email) {
      try {
        MailApp.sendEmail({
          to:       email,
          subject:  'We received your authorization form — Godwins Family Care',
          htmlBody: buildPatientEmail(clientInfo.name)
        });
      } catch(e) {}
    });

    return { success: true };

  } catch (err) {
    return { success: false, message: err.message };
  }
}


// ── Logo helper: fetch PNG from Drive, embed as data URI for PDF rendering ──
// Using Drive (not an external URL) so GAS always has access.
var LOGO_DRIVE_FILE_ID = '1I_2gw9kogn5VkwWkFqTux7FQHgLhvhpa';

function getLogoDataUri() {
  try {
    var blob = DriveApp.getFileById(LOGO_DRIVE_FILE_ID).getBlob();
    return 'data:image/png;base64,' + Utilities.base64Encode(blob.getBytes());
  } catch(e) {
    return '';
  }
}


// ── PATH B: Online form → generate one PDF per provider ──────
function generateROIPDF(params) {
  try {
    var token = params.token;
    if (!token) return { success: false, message: 'Missing token.' };

    var clientInfo = getClientForToken(token);
    if (!clientInfo) return { success: false, message: 'Invalid or expired token.' };

    var providers = params.providers;
    if (!Array.isArray(providers) || providers.length === 0) {
      return { success: false, message: 'No providers listed.' };
    }

    var folder      = getROIFolder();
    var logoDataUri = getLogoDataUri(); // fetch once, reuse across all provider PDFs
    var fileBlobs   = []; // Drive file blobs for email attachment
    var fileUrls    = [];
    var fileNames   = [];
    var dateStr     = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd');
    var clientClean = clientInfo.name.replace(/\s+/g, '_');

    providers.forEach(function(provider, idx) {
      var providerClean = (provider.name || 'Provider')
        .replace(/[^a-zA-Z0-9 ]/g, '').replace(/\s+/g, '_').substring(0, 30);
      var suffix = providers.length > 1 ? '_' + (idx + 1) : '';
      var docTitle = 'ROI_' + clientClean + '_' + providerClean + '_' + dateStr + suffix;

      // Build a merged param object for this provider
      var p = {
        token:             params.token,
        patientName:       params.patientName,
        patientDOB:        params.patientDOB,
        patientAddress:    params.patientAddress,
        patientPhone:      params.patientPhone,
        providerName:      provider.name    || '',
        providerDept:      provider.dept    || '',
        providerAddress:   provider.address || '',
        providerPhone:     provider.phone   || '',
        providerFax:       provider.fax     || '',
        recHP:             params.recHP,
        recLab:            params.recLab,
        recDiag:           params.recDiag,
        recImaging:        params.recImaging,
        recMeds:           params.recMeds,
        recDischarge:      params.recDischarge,
        recAllergies:      params.recAllergies,
        recImmune:         params.recImmune,
        recOther:          params.recOther,
        recOtherText:      params.recOtherText,
        recProtected:      params.recProtected,
        purposeTreatment:  params.purposeTreatment,
        purposeOther:      params.purposeOther,
        purposeOtherText:  params.purposeOtherText,
        expDate:           params.expDate,
        expEvent:          params.expEvent,
        sigImage:          params.sigImage || '',
        sigDate:           params.sigDate,
        sigPrintedName:    params.sigPrintedName,
        sigRelationship:   params.sigRelationship
      };

      var html    = renderROIHtml(p, logoDataUri);
      var pdfBlob = Utilities.newBlob(html, MimeType.HTML, docTitle + '.html')
        .getAs(MimeType.PDF)
        .setName(docTitle + '.pdf');

      var file = folder.createFile(pdfBlob);
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      fileUrls.push(file.getUrl());
      fileNames.push(docTitle + '.pdf');
      fileBlobs.push(file.getBlob()); // fresh blob from saved file — safe to attach
    });

    logROIToSheet(token, fileNames.join(' | '), fileUrls.join(' | '));

    // Admin gets all PDFs attached in one email
    try {
      var providerCount = providers.length;
      MailApp.sendEmail({
        to:          ROI_NOTIFY_EMAIL,
        subject:     'Provider ROI Submitted — ' + clientInfo.name
                       + (providerCount > 1 ? ' (' + providerCount + ' authorizations)' : ''),
        htmlBody:    buildAdminEmail(clientInfo.name, token, fileNames, fileUrls),
        attachments: fileBlobs
      });
    } catch(e) {}

    // Patient / submitter get one confirmation (no PDF attached)
    (clientInfo.notifyEmails || []).forEach(function(email) {
      try {
        MailApp.sendEmail({
          to:       email,
          subject:  'We received your authorization form — Godwins Family Care',
          htmlBody: buildPatientEmail(clientInfo.name)
        });
      } catch(e) {}
    });

    return { success: true };

  } catch (err) {
    return { success: false, message: err.message };
  }
}


// ── ROI HTML renderer (matches GFC_ROI_Obtain_Records.html) ──
function renderROIHtml(d, logoDataUri) {
  var today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'MMMM d, yyyy');

  function v(val) {
    return String(val || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }
  function chk(val) { return val ? '&#9745;' : '&#9744;'; }

  return '<!DOCTYPE html><html><head><meta charset="utf-8">'
    + '<style>'
    + 'body{margin:0;padding:36px 52px;font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;font-size:13px;}'
    + '.top{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px;}'
    + '.top img{width:140px;height:auto;}'
    + '.org{text-align:right;}.org .name{font-weight:bold;color:#033D50;font-size:14px;}'
    + '.org .meta{color:#666;font-size:10px;line-height:1.5;margin-top:2px;}'
    + '.rule{height:2px;background:#C9A44A;margin:10px 0 16px;}'
    + 'h1{font-family:Georgia,serif;color:#033D50;font-size:26px;margin:0 0 4px;}'
    + '.sub{color:#666;font-style:italic;font-size:11px;margin-bottom:12px;}'
    + '.intro{font-size:12px;line-height:1.55;margin:0 0 12px;}'
    + '.sec{background:#033D50;color:#fff;font-size:10px;font-weight:bold;letter-spacing:.06em;padding:5px 10px;margin:14px 0 10px;}'
    + '.sec b{color:#F5CD85;margin-right:8px;}'
    + '.row{display:flex;gap:16px;flex-wrap:wrap;margin-bottom:6px;}'
    + '.f{flex:1 1 200px;}.f.sm{flex:0 0 150px;}'
    + '.f label{display:block;font-size:9px;color:#666;margin-bottom:2px;}'
    + '.f .val{border-bottom:1px solid #bbb;padding:3px 2px;font-size:12.5px;min-height:22px;}'
    + '.to{background:#FAF7F2;border:1px solid #ccc;border-radius:3px;padding:10px 12px;}'
    + '.to .nm{font-weight:bold;color:#033D50;font-size:13px;}'
    + '.to .ad{font-size:11.5px;margin-top:2px;}'
    + '.chks{display:grid;grid-template-columns:1fr 1fr;gap:6px 20px;margin:4px 0;}'
    + '.ck{font-size:12px;}'
    + '.note{font-size:10px;color:#666;font-style:italic;line-height:1.5;margin:6px 0;}'
    + '.rights{font-size:11px;line-height:1.6;}'
    + '.discl{background:#FAF7F2;border:1px solid #C9A44A;border-radius:3px;padding:8px 12px;font-size:9.5px;color:#666;font-style:italic;line-height:1.5;margin-top:14px;}'
    + '.foot{color:#888;font-size:8.5px;font-style:italic;margin-top:10px;}'
    + '</style></head><body>'

    // Header
    + '<div class="top">'
    + (logoDataUri ? '<img src="' + logoDataUri + '" alt="Godwins Family Care">' : '<div style="font-size:13px;font-weight:bold;color:#033D50;">Godwins Family Care LLC</div>')
    + '<div class="org"><div class="name">Godwins Family Care LLC</div>'
    + '<div class="meta">4300 Paces Ferry Rd SE, Ste 500, Atlanta, GA 30339<br>Tel 404-913-6705 &nbsp; Fax 678-692-7445</div></div>'
    + '</div><div class="rule"></div>'

    // Title
    + '<h1>Authorization to Obtain Medical Records</h1>'
    + '<div class="sub">HIPAA authorization for Godwins Family Care LLC to request and receive protected health information.</div>'
    + '<p class="intro">I authorize the provider or facility named below to release the medical records described to <strong>Godwins Family Care LLC</strong>, for the purpose of my treatment, care coordination, and care planning.</p>'

    // Section 1: Patient
    + '<div class="sec"><b>1</b>PATIENT (WHOSE RECORDS)</div>'
    + '<div class="row">'
    + '<div class="f"><label>Patient full name</label><div class="val">' + v(d.patientName) + '</div></div>'
    + '<div class="f sm"><label>Date of birth</label><div class="val">' + v(d.patientDOB) + '</div></div>'
    + '</div><div class="row">'
    + '<div class="f"><label>Address</label><div class="val">' + v(d.patientAddress) + '</div></div>'
    + '<div class="f sm"><label>Phone</label><div class="val">' + v(d.patientPhone) + '</div></div>'
    + '</div>'

    // Section 2: Release From
    + '<div class="sec"><b>2</b>RELEASE RECORDS FROM (PROVIDER OR FACILITY)</div>'
    + '<div class="row">'
    + '<div class="f"><label>Provider / facility name</label><div class="val">' + v(d.providerName) + '</div></div>'
    + '<div class="f"><label>Department (e.g. Medical Records)</label><div class="val">' + v(d.providerDept) + '</div></div>'
    + '</div>'
    + '<div class="row"><div class="f"><label>Address</label><div class="val">' + v(d.providerAddress) + '</div></div></div>'
    + '<div class="row">'
    + '<div class="f"><label>Phone</label><div class="val">' + v(d.providerPhone) + '</div></div>'
    + '<div class="f"><label>Fax</label><div class="val">' + v(d.providerFax) + '</div></div>'
    + '</div>'
    + '<div class="note">For more than one provider, attach a list or complete an additional copy of this form.</div>'

    // Section 3: Release To
    + '<div class="sec"><b>3</b>RELEASE RECORDS TO</div>'
    + '<div class="to"><div class="nm">Godwins Family Care LLC</div>'
    + '<div class="ad">4300 Paces Ferry Rd SE, Ste 500, Atlanta, GA 30339 &nbsp;&nbsp; Tel 404-913-6705 &nbsp;&nbsp; Fax 678-692-7445</div></div>'

    // Section 4: Information Authorized
    + '<div class="sec"><b>4</b>INFORMATION AUTHORIZED FOR RELEASE</div>'
    + '<div class="chks">'
    + '<div class="ck">' + chk(d.recHP)       + ' History &amp; physical / progress notes</div>'
    + '<div class="ck">' + chk(d.recLab)      + ' Lab and pathology results</div>'
    + '<div class="ck">' + chk(d.recDiag)     + ' Problem &amp; diagnosis list</div>'
    + '<div class="ck">' + chk(d.recImaging)  + ' Imaging / radiology reports</div>'
    + '<div class="ck">' + chk(d.recMeds)     + ' Current medication list</div>'
    + '<div class="ck">' + chk(d.recDischarge)+ ' Discharge summaries</div>'
    + '<div class="ck">' + chk(d.recAllergies)+ ' Allergies</div>'
    + '<div class="ck">' + chk(d.recImmune)   + ' Immunization records</div>'
    + '<div class="ck">' + chk(d.recOther)    + ' Other: ' + v(d.recOtherText) + '</div>'
    + '</div>'
    + '<div class="note"><strong>Specially protected information.</strong> Records of mental health, substance use treatment, HIV/AIDS, or genetic testing are released ONLY if specifically authorized here:</div>'
    + '<div class="ck">' + chk(d.recProtected) + ' Yes, include specially protected information listed above</div>'

    // Section 5: Purpose
    + '<div class="sec"><b>5</b>PURPOSE OF DISCLOSURE</div>'
    + '<div class="ck">' + chk(d.purposeTreatment !== false && d.purposeTreatment !== 'false') + ' Treatment, care coordination, and care planning</div>'
    + (d.purposeOther ? '<div class="ck" style="margin-top:5px;">' + chk(true) + ' Other: ' + v(d.purposeOtherText) + '</div>' : '')

    // Section 6: Expiration
    + '<div class="sec"><b>6</b>EXPIRATION</div>'
    + '<p class="intro" style="margin-bottom:6px;">Unless revoked sooner, this authorization expires <strong>one year</strong> from the date signed, or on the earlier of:</p>'
    + '<div class="row">'
    + '<div class="f"><label>Expiration date (optional)</label><div class="val">' + v(d.expDate) + '</div></div>'
    + '<div class="f"><label>Expiration event (optional)</label><div class="val">' + v(d.expEvent) + '</div></div>'
    + '</div>'

    // Section 7: Rights
    + '<div class="sec"><b>7</b>YOUR RIGHTS</div>'
    + '<p class="rights">I understand that: (1) I may revoke this authorization at any time by writing to Godwins Family Care LLC, except to the extent action has already been taken in reliance on it; (2) treatment, payment, enrollment, and eligibility for benefits may not be conditioned on signing, except where the law allows; (3) information disclosed under this authorization may be re-disclosed by the recipient and may no longer be protected by federal privacy law; and (4) I am entitled to a copy of this signed authorization.</p>'

    // Section 8: Signature
    + '<div class="sec"><b>8</b>SIGNATURE</div>'
    + '<div class="row">'
    + '<div class="f"><label>Signature of patient or personal representative</label>'
    + '<div class="val">'
    + (d.sigImage ? '<img src="' + d.sigImage + '" style="max-height:52px;max-width:260px;display:block;">' : '<span style="font-style:italic;font-size:15px;">' + v(d.sigPrintedName || '') + '</span>')
    + '</div></div>'
    + '<div class="f sm"><label>Date</label><div class="val">' + v(d.sigDate || today) + '</div></div>'
    + '</div><div class="row">'
    + '<div class="f"><label>Printed name</label><div class="val">' + v(d.sigPrintedName) + '</div></div>'
    + '<div class="f"><label>If representative, relationship / authority</label><div class="val">' + v(d.sigRelationship) + '</div></div>'
    + '</div>'

    + '<div class="foot">Godwins Family Care LLC &nbsp;·&nbsp; Authorization to Obtain Medical Records &nbsp;·&nbsp; Submitted ' + today + '</div>'
    + '</body></html>';
}


// ── Token lookup ──────────────────────────────────────────────
// Reads from the shared intake spreadsheet using the updated schema:
//   'Client First Name' / 'Client Last Name' → patient name
//   'Client Email'    → patient's own email (send ROI confirmation here)
//   'Submitter Email' → POA/family email (also send confirmation here)
// Both emails receive the confirmation; neither gets the PDF attached.
function getClientForToken(token) {
  if (!token) return null;
  try {
    var ss      = SpreadsheetApp.openById(ROI_SPREADSHEET_ID);
    var sheet   = ss.getSheetByName(ROI_TAB_NAME);
    if (!sheet) return null;
    var values  = sheet.getDataRange().getValues();
    var headers = values[0];
    var fnIdx           = headers.indexOf('Client First Name');
    var lnIdx           = headers.indexOf('Client Last Name');
    var clientEmailIdx  = headers.indexOf('Client Email');
    var submitterEmailIdx = headers.indexOf('Submitter Email');
    // Fallback for pre-migration rows: Contact Email held the POA email
    var contactEmailIdx = headers.indexOf('Contact Email');
    for (var i = 1; i < values.length; i++) {
      if (values[i][0] === token) {
        var first = fnIdx >= 0 ? (values[i][fnIdx] || '') : '';
        var last  = lnIdx >= 0 ? (values[i][lnIdx] || '') : '';
        var name  = (first + ' ' + last).trim() || 'Patient';
        var clientEmail    = clientEmailIdx    >= 0 ? String(values[i][clientEmailIdx]    || '').trim() : '';
        var submitterEmail = submitterEmailIdx >= 0 ? String(values[i][submitterEmailIdx] || '').trim() : '';
        // Fall back to Contact Email if Submitter Email column doesn't exist yet
        if (!submitterEmail && contactEmailIdx >= 0) {
          submitterEmail = String(values[i][contactEmailIdx] || '').trim();
        }
        // Build unique list of emails to notify
        var notifyEmails = [];
        if (clientEmail) notifyEmails.push(clientEmail);
        if (submitterEmail && notifyEmails.indexOf(submitterEmail) < 0) notifyEmails.push(submitterEmail);
        return { name: name, notifyEmails: notifyEmails, rowIndex: i };
      }
    }
    return null;
  } catch(e) { return null; }
}


// ── Sheet logger ──────────────────────────────────────────────
function logROIToSheet(token, fileName, fileUrl) {
  try {
    var ss      = SpreadsheetApp.openById(ROI_SPREADSHEET_ID);
    var sheet   = ss.getSheetByName(ROI_TAB_NAME);
    if (!sheet) return;
    var values  = sheet.getDataRange().getValues();
    var headers = values[0];
    var urlColIdx  = headers.indexOf('Provider ROI URL');
    var fileColIdx = headers.indexOf('Provider ROI File');
    if (urlColIdx < 0) {
      urlColIdx = headers.length;
      sheet.getRange(1, urlColIdx + 1).setValue('Provider ROI URL');
    }
    if (fileColIdx < 0) {
      fileColIdx = urlColIdx + 1;
      sheet.getRange(1, fileColIdx + 1).setValue('Provider ROI File');
    }
    for (var i = 1; i < values.length; i++) {
      if (values[i][0] === token) {
        sheet.getRange(i + 1, urlColIdx  + 1).setValue(fileUrl);
        sheet.getRange(i + 1, fileColIdx + 1).setValue(fileName);
        break;
      }
    }
  } catch(e) {}
}


// ── Drive folder ──────────────────────────────────────────────
function getROIFolder() {
  var folders = DriveApp.getFoldersByName(ROI_FOLDER_NAME);
  if (folders.hasNext()) return folders.next();
  return DriveApp.createFolder(ROI_FOLDER_NAME);
}


// ── Admin email ───────────────────────────────────────────────
// fileNames and fileUrls may be arrays (multi-provider) or single strings.
function buildAdminEmail(clientName, token, fileNames, fileUrls) {
  // Normalize to arrays
  var names = Array.isArray(fileNames) ? fileNames : [fileNames];
  var urls  = Array.isArray(fileUrls)  ? fileUrls  : [fileUrls];

  var fileLines = '';
  names.forEach(function(name, i) {
    var url = urls[i] || '';
    fileLines += '<p style="font-size:14px;color:#3a4a52;line-height:1.6;margin:0 0 6px;">'
      + '<strong>' + (names.length > 1 ? 'File ' + (i + 1) + ':' : 'File:') + '</strong> ' + name
      + (url ? ' &nbsp;<a href="' + url + '" style="color:#033D50;font-size:13px;">View in Drive</a>' : '')
      + '</p>';
  });

  return '<!DOCTYPE html><html><body style="margin:0;padding:0;background:#FAF7F2;font-family:Arial,sans-serif;">'
    + '<div style="max-width:600px;margin:32px auto;">'
    + '<div style="background:#033D50;padding:28px 40px;border-radius:8px 8px 0 0;">'
    + '<img src="https://godwinsfamilycarellc.com/wp-content/uploads/2026/05/logo-full-color-transparent.png" height="44" style="display:block;" alt="Godwins Family Care">'
    + '</div><div style="background:#F5CD85;height:4px;"></div>'
    + '<div style="background:#fff;padding:40px;border-radius:0 0 8px 8px;">'
    + '<h1 style="font-family:Georgia,serif;font-size:20px;color:#033D50;margin:0 0 16px;">Provider ROI Received</h1>'
    + '<p style="font-size:14px;color:#3a4a52;line-height:1.75;margin:0 0 12px;">A completed authorization was received for <strong>' + clientName + '</strong>.'
    + (names.length > 1 ? ' <strong>' + names.length + ' PDFs attached</strong> — one per provider.' : ' PDF attached.')
    + '</p>'
    + '<p style="font-size:14px;color:#3a4a52;line-height:1.75;margin:0 0 4px;"><strong>Token:</strong> ' + token + '</p>'
    + fileLines
    + '<p style="font-size:13px;color:#8a9aa2;margin-top:20px;">Drive links have been written to the intake sheet.</p>'
    + '</div><div style="text-align:center;padding:20px;font-size:11px;color:#8a9aa2;">Godwins Family Care LLC &nbsp;·&nbsp; (404) 913-6705</div>'
    + '</div></body></html>';
}


// ── Patient confirmation email (no PDF attached) ──────────────
function buildPatientEmail(patientName) {
  var first = (patientName || '').split(' ')[0] || 'there';
  return '<!DOCTYPE html><html><body style="margin:0;padding:0;background:#FAF7F2;font-family:Arial,sans-serif;">'
    + '<div style="max-width:600px;margin:32px auto;">'
    + '<div style="background:#033D50;padding:28px 40px;border-radius:8px 8px 0 0;">'
    + '<img src="https://godwinsfamilycarellc.com/wp-content/uploads/2026/05/logo-full-color-transparent.png" height="44" style="display:block;" alt="Godwins Family Care">'
    + '</div><div style="background:#F5CD85;height:4px;"></div>'
    + '<div style="background:#fff;padding:40px;border-radius:0 0 8px 8px;">'
    + '<h1 style="font-family:Georgia,serif;font-size:20px;color:#033D50;margin:0 0 20px;">We received your form.</h1>'
    + '<p style="font-size:14px;color:#3a4a52;line-height:1.8;margin:0 0 14px;">Hi ' + first + ',</p>'
    + '<p style="font-size:14px;color:#3a4a52;line-height:1.8;margin:0 0 14px;">Your signed Authorization to Obtain Medical Records was received. Our care team will use it to request your records from your provider and will be in touch with next steps.</p>'
    + '<p style="font-size:14px;color:#3a4a52;line-height:1.8;margin:0 0 24px;">Please don\'t hesitate to reach out with any questions.</p>'
    + '<p style="font-size:14px;color:#3a4a52;line-height:1.8;margin:0;">Warmly,<br><strong>Godwins Family Care</strong><br>'
    + '<a href="tel:4049136705" style="color:#033D50;">(404) 913-6705</a> &nbsp;·&nbsp; <a href="mailto:info@godwinsfamilycarellc.com" style="color:#033D50;">info@godwinsfamilycarellc.com</a></p>'
    + '</div><div style="text-align:center;padding:20px;font-size:11px;color:#8a9aa2;">Godwins Family Care LLC &nbsp;·&nbsp; 4300 Paces Ferry Rd SE, Ste 500, Atlanta, GA 30339</div>'
    + '</div></body></html>';
}


// ── JSON response helper ──────────────────────────────────────
function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}


// ── ONE-TIME DATA FIX: run once, then delete ──────────────────
// Fixes Sharon's row (token 5BD7U7bRzFy4).
//
// IMPORTANT: Run migrateSchemaAndAddClientEmail() in the INTAKE GAS first.
// After that migration, Ernest Haney will already be in 'Client First/Last Name'
// and Sharon's email in 'Submitter Email'. This function then sets:
//   - Contact Name  → 'Sharon Vidrine'  (she IS the primary contact/POA)
//   - Contact Email → 'Supervisor@hickorylog.org'  (so she also gets ROI confirmations)
//
// HOW TO RUN: Apps Script editor → select fixSharonRow → click Run.
// Delete this function when done.
function fixSharonRow() {
  var TOKEN  = '5BD7U7bRzFy4';
  var ss     = SpreadsheetApp.openById(ROI_SPREADSHEET_ID);
  var sheet  = ss.getSheetByName(ROI_TAB_NAME);
  var values = sheet.getDataRange().getValues();
  var headers = values[0];

  var colCN = headers.indexOf('Contact Name');   // put Sharon as the primary contact
  var colCE = headers.indexOf('Contact Email');  // her email for ROI notifications

  for (var i = 1; i < values.length; i++) {
    if (values[i][0] !== TOKEN) continue;
    var row = i + 1;
    if (colCN >= 0) sheet.getRange(row, colCN + 1).setValue('Sharon Vidrine');
    if (colCE >= 0) sheet.getRange(row, colCE + 1).setValue('Supervisor@hickorylog.org');
    Logger.log('Sharon row fixed at row ' + row);
    break;
  }
}
