const { google } = require('googleapis');
const config = require('./config');

let connectionSettings = null;
let tokenExpiresAt = null;

// PHI files must not be world-readable. By default we do NOT grant "anyone with
// link" access — files inherit their (private, BAA-scoped) folder's permissions.
// The legacy Apps Script shared PHI via anyone-link; that is re-enabled only when
// DRIVE_ALLOW_ANYONE_LINK is explicitly true (non-PHI contexts only).
async function maybeGrantAnyoneLink(drive, fileId) {
  if (!config.DRIVE_ALLOW_ANYONE_LINK) return;
  await drive.permissions.create({
    fileId,
    requestBody: { role: 'reader', type: 'anyone' }
  });
}

async function getAccessToken() {
  if (connectionSettings && tokenExpiresAt && (tokenExpiresAt - Date.now() > 60000)) {
    const cachedToken = connectionSettings?.settings?.access_token || 
                        connectionSettings?.settings?.oauth?.credentials?.access_token;
    if (cachedToken) {
      return cachedToken;
    }
  }
  
  connectionSettings = null;
  tokenExpiresAt = null;
  
  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  if (!hostname) {
    throw new Error('Google Drive connector not configured - REPLIT_CONNECTORS_HOSTNAME not found');
  }
  
  const xReplitToken = process.env.REPL_IDENTITY 
    ? 'repl ' + process.env.REPL_IDENTITY 
    : process.env.WEB_REPL_RENEWAL 
    ? 'depl ' + process.env.WEB_REPL_RENEWAL 
    : null;

  if (!xReplitToken) {
    throw new Error('Google Drive connector authentication not available');
  }

  try {
    const response = await fetch(
      'https://' + hostname + '/api/v2/connection?include_secrets=true&connector_names=google-drive',
      {
        headers: {
          'Accept': 'application/json',
          'X_REPLIT_TOKEN': xReplitToken
        }
      }
    );
    
    if (!response.ok) {
      throw new Error('Failed to fetch Google Drive connection settings');
    }
    
    const data = await response.json();
    connectionSettings = data.items?.[0];
  } catch (error) {
    throw new Error('Failed to connect to Google Drive: ' + error.message);
  }

  if (!connectionSettings) {
    throw new Error('Google Drive connector not configured');
  }

  const accessToken = connectionSettings?.settings?.access_token || 
                      connectionSettings?.settings?.oauth?.credentials?.access_token;

  if (!accessToken) {
    throw new Error('Google Drive not connected - no access token found');
  }
  
  const expiresAt = connectionSettings?.settings?.expires_at || 
                    connectionSettings?.settings?.oauth?.credentials?.expires_at;
  if (expiresAt) {
    tokenExpiresAt = new Date(expiresAt).getTime();
  } else {
    tokenExpiresAt = Date.now() + (50 * 60 * 1000);
  }
  
  return accessToken;
}

async function getDriveClient() {
  const accessToken = await getAccessToken();
  const oauth2Client = new google.auth.OAuth2();
  oauth2Client.setCredentials({ access_token: accessToken });
  return google.drive({ version: 'v3', auth: oauth2Client });
}

// Sheets client over the same OAuth token — used by the Transfer-of-Care ROI
// parallel-run logger and the legacy importer (Session 3.4).
async function getSheetsClient() {
  const accessToken = await getAccessToken();
  const oauth2Client = new google.auth.OAuth2();
  oauth2Client.setCredentials({ access_token: accessToken });
  return google.sheets({ version: 'v4', auth: oauth2Client });
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

async function findOrCreateFolder(folderName, parentFolderId = null) {
  try {
    const drive = await getDriveClient();
    
    let query = `name='${folderName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
    if (parentFolderId) {
      query += ` and '${parentFolderId}' in parents`;
    }
    
    const searchResponse = await drive.files.list({
      q: query,
      fields: 'files(id, name)',
      spaces: 'drive'
    });
    
    if (searchResponse.data.files && searchResponse.data.files.length > 0) {
      return searchResponse.data.files[0].id;
    }
    
    const fileMetadata = {
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder'
    };
    if (parentFolderId) {
      fileMetadata.parents = [parentFolderId];
    }
    
    const createResponse = await drive.files.create({
      resource: fileMetadata,
      fields: 'id'
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
    });
    
    // Make file viewable by anyone with link
    await drive.permissions.create({
      fileId: response.data.id,
      requestBody: {
        role: 'reader',
        type: 'anyone'
      }
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
    await drive.files.delete({ fileId: fileId });
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
      fields: 'id, name, webViewLink, webContentLink'
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
      fields: 'id, name, webViewLink, webContentLink, thumbnailLink'
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

module.exports = {
  testConnection,
  findOrCreateFolder,
  uploadHtmlFile,
  uploadTaskFile,
  deleteFile,
  uploadServiceReportPDF,
  uploadServiceReportAttachment,
  uploadProviderROIFile,
  uploadOfflinePacketFile,
  getSheetsClient,
  getDriveClient
};
