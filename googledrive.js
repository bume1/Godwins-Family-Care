const { google } = require('googleapis');

let connectionSettings = null;
let tokenExpiresAt = null;

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

const SOFT_PILOT_FOLDER_ID = '16Tsa2IJypBBvvoVsLamy5j0DFgVUGLSN';
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

async function uploadSoftPilotChecklist(projectName, clientName, htmlContent) {
  try {
    const clientFolderId = await findOrCreateFolder(clientName, SOFT_PILOT_FOLDER_ID);
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const fileName = `Soft-Pilot-Checklist_${projectName.replace(/[^a-zA-Z0-9]/g, '-')}_${timestamp}.html`;
    
    const result = await uploadHtmlFile(fileName, htmlContent, clientFolderId);
    
    console.log(`✅ Uploaded checklist to Google Drive: ${result.fileName}`);
    return result;
  } catch (error) {
    console.error('Error uploading soft-pilot checklist:', error.message);
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

    // Make file viewable by anyone with link
    await drive.permissions.create({
      fileId: response.data.id,
      requestBody: {
        role: 'reader',
        type: 'anyone'
      }
    });

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

    // Make file viewable by anyone with link
    await drive.permissions.create({
      fileId: response.data.id,
      requestBody: {
        role: 'reader',
        type: 'anyone'
      }
    });

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

module.exports = {
  testConnection,
  findOrCreateFolder,
  uploadHtmlFile,
  uploadSoftPilotChecklist,
  uploadTaskFile,
  deleteFile,
  uploadServiceReportPDF,
  uploadServiceReportAttachment
};
