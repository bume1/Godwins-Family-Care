const { google } = require('googleapis');
const config = require('./config');

// ── AUTH ─────────────────────────────────────────────────────────────────────
// Drive authenticates with the SAME Google service account the mailer uses
// (`GOOGLE_SERVICE_ACCOUNT_KEY`), with the Drive scope added to the existing
// domain-wide delegation grant. One credential, one Admin-console screen, two
// scopes.
//
// THIS REPLACED A REPLIT CONNECTOR. The old getAccessToken() read
// REPLIT_CONNECTORS_HOSTNAME and REPL_IDENTITY and called Replit's connector
// API for a token. On AWS those variables do not exist, so it threw on its
// first line and took every Drive write with it — client uploads, care plans,
// ROI PDFs, consents, offline packet scans. The platform is AWS (owner
// directive, 2026-09-13), so the Replit path is deleted rather than kept as a
// fallback: a branch that can never run is not a fallback, it is a place for a
// future session to be misled about what is supported.
//
// DELEGATION IMPERSONATES A REAL USER, exactly as Gmail does. A bare service
// account has no Drive storage quota of its own in Workspace, so it cannot own
// files; it acts AS a licensed user and the files live in that user's Drive.
// GOOGLE_DRIVE_IMPERSONATE names that user and falls back to GMAIL_SEND_AS,
// because in practice it is the same account and asking for it twice is how
// the two drift.

const DRIVE_SCOPES = ['https://www.googleapis.com/auth/drive'];

// PHI files must not be world-readable. By default we do NOT grant "anyone with
// link" access — files inherit their (private, BAA-scoped) folder's permissions.
// The legacy Apps Script shared PHI via anyone-link; that is re-enabled only when
// DRIVE_ALLOW_ANYONE_LINK is explicitly true (non-PHI contexts only).
//
// RESTORED 2026-09-13: the service-account rewrite deleted this by replacing a
// range that happened to contain it, and `node --check` passed because a syntax
// check is not a reference check — the same trap that lost `ShiftCard` in
// Session 9. Six call sites referenced a function that no longer existed.
async function maybeGrantAnyoneLink(drive, fileId) {
  if (!config.DRIVE_ALLOW_ANYONE_LINK) return;
  await drive.permissions.create({
    fileId,
    requestBody: { role: 'reader', type: 'anyone' },
    ...ALL_DRIVES
  });
}

// Shared-drive calls need these flags on EVERY request or the API answers
// "File not found" for a folder that plainly exists. They are harmless on My
// Drive, so they are set unconditionally rather than behind a config branch
// that would have to be remembered at each of the call sites below.
const ALL_DRIVES = { supportsAllDrives: true };
const ALL_DRIVES_LIST = { supportsAllDrives: true, includeItemsFromAllDrives: true };

let _drive = null;
let _driveOverride = null;

// Tests drive a fake client rather than the network. Exported at the bottom.
function _setDriveClientForTests(client) {
  _driveOverride = client;
  _drive = null;
}

// The service-account key, read the same way the mailer reads it — including
// the newline repair, because a PEM that has been through a hosting panel or a
// CI variable arrives with its backslash-n intact and the JWT library then
// fails with an opaque complaint about the key format.
function loadServiceAccount() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!raw || !String(raw).trim()) return null;
  try {
    const text = String(raw).trim().startsWith('{')
      ? String(raw)
      : Buffer.from(String(raw).trim(), 'base64').toString('utf8');
    const parsed = JSON.parse(text);
    if (!parsed.client_email || !parsed.private_key) return null;
    if (parsed.private_key.includes('\\n')) {
      parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
    }
    return parsed;
  } catch (e) {
    console.error('[DRIVE] GOOGLE_SERVICE_ACCOUNT_KEY is set but could not be parsed:', e.message);
    return null;
  }
}

/**
 * Is Drive actually usable, and if not, exactly why?
 *
 * Every field here is observable. The app must never report Drive as working
 * on the strength of a variable being set — that is the same trap as the
 * narrowed OAuth token that survived the 8.4 upgrade behind a green
 * "OpenEMR connected". `configured` means the credential parses and an
 * impersonation subject exists; only `verify_drive_access.js` proves Google
 * accepts it.
 */
function driveStatus() {
  const sa = loadServiceAccount();
  const impersonate = String(
    process.env.GOOGLE_DRIVE_IMPERSONATE || process.env.GMAIL_SEND_AS || ''
  ).trim();

  const blockers = [];
  if (!sa) blockers.push('GOOGLE_SERVICE_ACCOUNT_KEY is not set (or is not valid JSON)');
  if (!impersonate) blockers.push('GOOGLE_DRIVE_IMPERSONATE is not set (and GMAIL_SEND_AS is not set to fall back on)');

  return {
    configured: blockers.length === 0,
    serviceAccount: sa ? sa.client_email : null,
    impersonating: impersonate || null,
    rootFolderId: String(process.env.GOOGLE_DRIVE_FOLDER_ID || '').trim() || null,
    blockers,
    reason: blockers.length ? blockers.join('; ') : null
  };
}

// Thrown when Drive is not configured, so callers can tell "not set up" from
// "Google refused". Every upload route already turns a throw here into a 502
// that says the file was NOT stored, which is the behaviour to preserve: a row
// pointing at a file that does not exist is worse than a refused upload.
class DriveNotConfiguredError extends Error {
  constructor(reason) {
    super(`Google Drive is not configured: ${reason}`);
    this.name = 'DriveNotConfiguredError';
    this.code = 'DRIVE_NOT_CONFIGURED';
  }
}

function buildDriveAuth() {
  const sa = loadServiceAccount();
  const status = driveStatus();
  if (!status.configured) throw new DriveNotConfiguredError(status.reason);
  return new google.auth.JWT({
    email: sa.client_email,
    key: sa.private_key,
    scopes: DRIVE_SCOPES,
    subject: status.impersonating   // domain-wide delegation acts AS this user
  });
}

async function getDriveClient() {
  if (_driveOverride) return _driveOverride;
  if (_drive) return _drive;
  _drive = google.drive({ version: 'v3', auth: buildDriveAuth() });
  return _drive;
}

// Sheets over the SAME credential — used by the Transfer-of-Care ROI
// parallel-run logger and the legacy importer (Session 3.4). It needs the
// spreadsheets scope added to the delegation grant alongside Drive; without it
// only the parallel-run Sheet logging fails, never a document upload.
async function getSheetsClient() {
  const sa = loadServiceAccount();
  const status = driveStatus();
  if (!status.configured) throw new DriveNotConfiguredError(status.reason);
  const auth = new google.auth.JWT({
    email: sa.client_email,
    key: sa.private_key,
    scopes: [...DRIVE_SCOPES, 'https://www.googleapis.com/auth/spreadsheets'],
    subject: status.impersonating
  });
  return google.sheets({ version: 'v4', auth });
}

async function testConnection() {
  try {
    const drive = await getDriveClient();
    const response = await drive.about.get({ fields: 'user' });
    return { connected: true, user: response.data.user?.emailAddress };
  } catch (error) {
    return { connected: false, error: error.message };
  }
}

// A folder name in a query is user-influenced in one place (the client's own
// name, used as a per-client folder), and an apostrophe would otherwise
// terminate the quoted string and change the query. O'Brien is a name, not a
// syntax error.
function escapeDriveQueryValue(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function findOrCreateFolder(folderName, parentFolderId = null) {
  try {
    const drive = await getDriveClient();

    // With no explicit parent, nest under the configured root when there is
    // one. That is what puts every GFC file inside ONE folder (or one Shared
    // Drive) that can be shared with the service account once, instead of
    // scattering top-level folders through the impersonated user's Drive.
    const parent = parentFolderId || (String(process.env.GOOGLE_DRIVE_FOLDER_ID || '').trim() || null);

    let query = `name='${escapeDriveQueryValue(folderName)}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
    if (parent) {
      query += ` and '${escapeDriveQueryValue(parent)}' in parents`;
    }

    const searchResponse = await drive.files.list({
      q: query,
      fields: 'files(id, name)',
      spaces: 'drive',
      ...ALL_DRIVES_LIST
    });
    
    if (searchResponse.data.files && searchResponse.data.files.length > 0) {
      return searchResponse.data.files[0].id;
    }
    
    const fileMetadata = {
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder'
    };
    if (parent) {
      fileMetadata.parents = [parent];
    }
    
    const createResponse = await drive.files.create({
      resource: fileMetadata,
      fields: 'id',
      ...ALL_DRIVES
    });
    
    return createResponse.data.id;
  } catch (error) {
    console.error('Error finding/creating folder:', error.message);
    throw error;
  }
}

async function uploadHtmlFile(fileName, htmlContent, folderId = null) {
  try {
    const drive = await getDriveClient();
    const { Readable } = require('stream');
    
    const fileMetadata = {
      name: fileName
    };
    if (folderId) {
      fileMetadata.parents = [folderId];
    }
    
    const media = {
      mimeType: 'text/html',
      body: Readable.from([htmlContent])
    };
    
    const response = await drive.files.create({
      resource: fileMetadata,
      media: media,
      fields: 'id, name, webViewLink'
    ,
      ...ALL_DRIVES
    });
    
    return {
      fileId: response.data.id,
      fileName: response.data.name,
      webViewLink: response.data.webViewLink
    };
  } catch (error) {
    console.error('Error uploading file to Google Drive:', error.message);
    throw error;
  }
}

const TASK_FILES_FOLDER_ID = '16Tsa2IJypBBvvoVsLamy5j0DFgVUGLSN'; // Same parent folder for now

async function uploadTaskFile(projectName, clientName, fileName, fileBuffer, mimeType) {
  try {
    const drive = await getDriveClient();
    const { Readable } = require('stream');
    
    // Create or find client folder
    const clientFolderId = await findOrCreateFolder(clientName, TASK_FILES_FOLDER_ID);
    // Create or find project subfolder
    const projectFolderId = await findOrCreateFolder(projectName, clientFolderId);
    // Create or find "Task Files" subfolder
    const taskFilesFolderId = await findOrCreateFolder('Task Files', projectFolderId);
    
    const fileMetadata = {
      name: fileName,
      parents: [taskFilesFolderId]
    };
    
    const media = {
      mimeType: mimeType,
      body: Readable.from([fileBuffer])
    };
    
    const response = await drive.files.create({
      resource: fileMetadata,
      media: media,
      fields: 'id, name, webViewLink, webContentLink, thumbnailLink, size'
    ,
      ...ALL_DRIVES
    });
    
    // Make file viewable by anyone with link
    await drive.permissions.create({
      fileId: response.data.id,
      requestBody: {
        role: 'reader',
        type: 'anyone'
      },
                                     ...ALL_DRIVES
                                   });
    
    console.log(`✅ Uploaded task file to Google Drive: ${response.data.name}`);
    
    return {
      fileId: response.data.id,
      fileName: response.data.name,
      webViewLink: response.data.webViewLink,
      webContentLink: response.data.webContentLink,
      thumbnailLink: response.data.thumbnailLink,
      size: response.data.size
    };
  } catch (error) {
    console.error('Error uploading task file to Google Drive:', error.message);
    throw error;
  }
}

async function deleteFile(fileId) {
  try {
    const drive = await getDriveClient();
    await drive.files.delete({ fileId: fileId,
                               ...ALL_DRIVES
                             });
    console.log(`✅ Deleted file from Google Drive: ${fileId}`);
    return true;
  } catch (error) {
    console.error('Error deleting file from Google Drive:', error.message);
    throw error;
  }
}

const SERVICE_REPORTS_FOLDER_ID = '1QUAflJXWcUHc6XRCmj-LPPsdZeDwAm2J';

async function uploadServiceReportPDF(clientName, fileName, pdfBuffer) {
  try {
    const drive = await getDriveClient();
    const { Readable } = require('stream');

    // Create or find client subfolder inside the service reports folder
    const clientFolderId = await findOrCreateFolder(clientName, SERVICE_REPORTS_FOLDER_ID);

    const fileMetadata = {
      name: fileName,
      parents: [clientFolderId]
    };

    const media = {
      mimeType: 'application/pdf',
      body: Readable.from([pdfBuffer])
    };

    const response = await drive.files.create({
      resource: fileMetadata,
      media: media,
      fields: 'id, name, webViewLink, webContentLink'
    ,
      ...ALL_DRIVES
    });

    // PHI: no anyone-link grant unless explicitly enabled (see maybeGrantAnyoneLink).
    await maybeGrantAnyoneLink(drive, response.data.id);

    console.log(`✅ Uploaded service report PDF to Google Drive: ${response.data.name}`);

    return {
      fileId: response.data.id,
      fileName: response.data.name,
      webViewLink: response.data.webViewLink,
      webContentLink: response.data.webContentLink
    };
  } catch (error) {
    console.error('Error uploading service report PDF to Google Drive:', error.message);
    throw error;
  }
}

async function uploadServiceReportAttachment(clientName, fileName, fileBuffer, mimeType) {
  try {
    const drive = await getDriveClient();
    const { Readable } = require('stream');

    // Create or find client subfolder inside the service reports folder
    const clientFolderId = await findOrCreateFolder(clientName, SERVICE_REPORTS_FOLDER_ID);
    // Create or find "Attachments" subfolder
    const attachmentsFolderId = await findOrCreateFolder('Attachments', clientFolderId);

    const fileMetadata = {
      name: fileName,
      parents: [attachmentsFolderId]
    };

    const media = {
      mimeType: mimeType || 'application/octet-stream',
      body: Readable.from([fileBuffer])
    };

    const response = await drive.files.create({
      resource: fileMetadata,
      media: media,
      fields: 'id, name, webViewLink, webContentLink, thumbnailLink'
    ,
      ...ALL_DRIVES
    });

    // PHI: no anyone-link grant unless explicitly enabled (see maybeGrantAnyoneLink).
    await maybeGrantAnyoneLink(drive, response.data.id);

    console.log(`✅ Uploaded service report attachment to Google Drive: ${response.data.name}`);

    return {
      fileId: response.data.id,
      fileName: response.data.name,
      webViewLink: response.data.webViewLink,
      webContentLink: response.data.webContentLink,
      thumbnailLink: response.data.thumbnailLink
    };
  } catch (error) {
    console.error('Error uploading service report attachment to Google Drive:', error.message);
    throw error;
  }
}

// ── Transfer-of-Care Provider ROI (Session 3.4) ──────────────
// Writes generated ROI PDFs and uploaded scans into the same named Drive folder
// the legacy Google Apps Script handler used ("GFC Provider ROI Uploads"), so
// the parallel run keeps populating Drive. Returns a shareable webViewLink.
async function uploadProviderROIFile(folderName, fileName, fileBuffer, mimeType) {
  try {
    const drive = await getDriveClient();
    const { Readable } = require('stream');

    // Root-level named folder (no parent), matching ROI_FOLDER_NAME in gfc_roi_upload.gs.
    const folderId = await findOrCreateFolder(folderName || 'GFC Provider ROI Uploads', null);

    const response = await drive.files.create({
      resource: { name: fileName, parents: [folderId] },
      media: { mimeType: mimeType || 'application/pdf', body: Readable.from([fileBuffer]) },
      fields: 'id, name, webViewLink, webContentLink',
      ...ALL_DRIVES
    });

    // PHI (provider-facing ROI): no anyone-link grant unless explicitly enabled.
    // The legacy handler shared these via anyone-link; that is now gated off by
    // default (see maybeGrantAnyoneLink / DRIVE_ALLOW_ANYONE_LINK).
    await maybeGrantAnyoneLink(drive, response.data.id);

    console.log(`✅ Uploaded provider ROI to Google Drive: ${response.data.name}`);
    return {
      fileId: response.data.id,
      fileName: response.data.name,
      webViewLink: response.data.webViewLink,
      webContentLink: response.data.webContentLink
    };
  } catch (error) {
    console.error('Error uploading provider ROI to Google Drive:', error.message);
    throw error;
  }
}

// ── Offline patient onboarding — paper packet scans (Session 3.3, Scope B) ──
// Uploaded when staff use "Add offline-onboarded patient" for the 7 legacy
// paper-packet clients. Per-client subfolder inside a root-level named folder.
async function uploadOfflinePacketFile(clientName, fileName, fileBuffer, mimeType) {
  try {
    const drive = await getDriveClient();
    const { Readable } = require('stream');

    const rootFolderId = await findOrCreateFolder('GFC Offline Intake Packets', null);
    const clientFolderId = await findOrCreateFolder(clientName || 'Unnamed Client', rootFolderId);

    const response = await drive.files.create({
      resource: { name: fileName, parents: [clientFolderId] },
      media: { mimeType: mimeType || 'application/octet-stream', body: Readable.from([fileBuffer]) },
      fields: 'id, name, webViewLink, webContentLink, thumbnailLink',
      ...ALL_DRIVES
    });

    // PHI (paper intake packet scan): no anyone-link grant unless explicitly enabled.
    await maybeGrantAnyoneLink(drive, response.data.id);

    console.log(`✅ Uploaded offline intake packet to Google Drive: ${response.data.name}`);
    return {
      fileId: response.data.id,
      fileName: response.data.name,
      webViewLink: response.data.webViewLink,
      webContentLink: response.data.webContentLink,
      thumbnailLink: response.data.thumbnailLink
    };
  } catch (error) {
    console.error('Error uploading offline intake packet to Google Drive:', error.message);
    throw error;
  }
}

// Care-plan PDFs (Session 4.1): authored + signed versions, one folder per
// client under "GFC Care Plans". PHI — no anyone-link grant (same gate as the
// other PHI uploads).
async function uploadCarePlanFile(clientName, fileName, pdfBuffer) {
  try {
    const drive = await getDriveClient();
    const { Readable } = require('stream');

    const rootFolderId = await findOrCreateFolder('GFC Care Plans', null);
    const clientFolderId = await findOrCreateFolder(clientName || 'Unnamed Client', rootFolderId);

    const response = await drive.files.create({
      resource: { name: fileName, parents: [clientFolderId] },
      media: { mimeType: 'application/pdf', body: Readable.from([pdfBuffer]) },
      fields: 'id, name, webViewLink, webContentLink',
      ...ALL_DRIVES
    });

    await maybeGrantAnyoneLink(drive, response.data.id);

    console.log(`✅ Uploaded care-plan PDF to Google Drive: ${response.data.name}`);
    return {
      fileId: response.data.id,
      fileName: response.data.name,
      webViewLink: response.data.webViewLink,
      webContentLink: response.data.webContentLink
    };
  } catch (error) {
    console.error('Error uploading care-plan PDF to Google Drive:', error.message);
    throw error;
  }
}

// Client-supplied documents (the two-way exchange): a photo ID, an insurance
// card, a POA document, records from a prior provider. One folder per client
// under "GFC Client Documents". PHI — no anyone-link grant, and the caller
// downloads through the app so access is authenticated and audited.
async function uploadClientDocumentFile(clientName, fileName, fileBuffer, mimeType) {
  const drive = await getDriveClient();
  const { Readable } = require('stream');

  const rootFolderId = await findOrCreateFolder('GFC Client Documents', null);
  const clientFolderId = await findOrCreateFolder(clientName || 'Unnamed Client', rootFolderId);

  const response = await drive.files.create({
    resource: { name: fileName, parents: [clientFolderId] },
    media: { mimeType: mimeType || 'application/octet-stream', body: Readable.from([fileBuffer]) },
    fields: 'id, name, webViewLink, webContentLink',
    ...ALL_DRIVES
  });

  await maybeGrantAnyoneLink(drive, response.data.id);

  console.log(`✅ Uploaded client document to Google Drive: ${response.data.name}`);
  return {
    fileId: response.data.id,
    fileName: response.data.name,
    webViewLink: response.data.webViewLink,
    webContentLink: response.data.webContentLink
  };
}

// A caregiver's own paperwork — a physical timesheet photographed at the end of
// a shift, a certificate, a signed visit note. Filed under the CAREGIVER, not
// the client: it is employment paperwork, and a timesheet routinely covers
// several clients, so putting it in one client's folder would file it wrong and
// widen who can see it.
async function uploadCaregiverDocumentFile(caregiverName, fileName, fileBuffer, mimeType) {
  const drive = await getDriveClient();
  const { Readable } = require('stream');

  const rootFolderId = await findOrCreateFolder('GFC Caregiver Documents', null);
  const caregiverFolderId = await findOrCreateFolder(caregiverName || 'Unnamed Caregiver', rootFolderId);

  const response = await drive.files.create({
    resource: { name: fileName, parents: [caregiverFolderId] },
    media: { mimeType: mimeType || 'application/octet-stream', body: Readable.from([fileBuffer]) },
    fields: 'id, name, webViewLink, webContentLink',
    ...ALL_DRIVES
  });

  await maybeGrantAnyoneLink(drive, response.data.id);

  console.log(`✅ Uploaded caregiver document to Google Drive: ${response.data.name}`);
  return {
    fileId: response.data.id,
    fileName: response.data.name,
    webViewLink: response.data.webViewLink,
    webContentLink: response.data.webContentLink
  };
}

// Read a stored file's bytes back (Session 4.3: the patient's signed
// care-plan PDF is served from the Drive reference on client.carePlanDocs,
// never from OpenEMR Documents). The service token reads it; the file stays
// private (no anyone-link needed).
async function downloadFileBuffer(fileId) {
  const drive = await getDriveClient();
  const res = await drive.files.get({ fileId, alt: 'media',
                                      ...ALL_DRIVES
                                    }, { responseType: 'arraybuffer' });
  return Buffer.from(res.data);
}

module.exports = {
  downloadFileBuffer,
  testConnection,
  findOrCreateFolder,
  uploadHtmlFile,
  uploadTaskFile,
  deleteFile,
  uploadServiceReportPDF,
  uploadServiceReportAttachment,
  uploadProviderROIFile,
  uploadOfflinePacketFile,
  uploadCarePlanFile,
  uploadClientDocumentFile,
  uploadCaregiverDocumentFile,
  getSheetsClient,
  getDriveClient,
  // Observability + the not-configured signal, so a caller can tell "Drive is
  // not set up" from "Google refused this file".
  driveStatus,
  DriveNotConfiguredError,
  // exported for tests
  loadServiceAccount,
  escapeDriveQueryValue,
  _setDriveClientForTests
};
