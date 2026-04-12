const { Client } = require('@hubspot/api-client');
const axios = require('axios');
const FormData = require('form-data');

// HubSpot association type IDs (HUBSPOT_DEFINED category)
const ASSOCIATION_TYPES = Object.freeze({
  COMPANY_TO_NOTE: 190,
  DEAL_TO_NOTE: 214,
  DEAL_TO_TASK: 216,
  NOTE_TO_TICKET: 18,
  TICKET_TO_COMPANY: 26,
  TICKET_TO_CONTACT: 16,
  TICKET_TO_DEAL: 28,
});

let connectionSettings = null;
let tokenExpiresAt = null;

async function getAccessToken() {
  // Check if we have a valid cached token (with 60-second buffer before expiry)
  if (connectionSettings && tokenExpiresAt && (tokenExpiresAt - Date.now() > 60000)) {
    const cachedToken = connectionSettings?.settings?.access_token || 
                        connectionSettings?.settings?.oauth?.credentials?.access_token;
    if (cachedToken) {
      return cachedToken;
    }
  }
  
  // Clear cache and fetch fresh token
  connectionSettings = null;
  tokenExpiresAt = null;
  
  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  if (!hostname) {
    throw new Error('HubSpot connector not configured - REPLIT_CONNECTORS_HOSTNAME not found');
  }
  
  const xReplitToken = process.env.REPL_IDENTITY 
    ? 'repl ' + process.env.REPL_IDENTITY 
    : process.env.WEB_REPL_RENEWAL 
    ? 'depl ' + process.env.WEB_REPL_RENEWAL 
    : null;

  if (!xReplitToken) {
    throw new Error('HubSpot connector authentication not available');
  }

  try {
    const response = await fetch(
      'https://' + hostname + '/api/v2/connection?include_secrets=true&connector_names=hubspot',
      {
        headers: {
          'Accept': 'application/json',
          'X_REPLIT_TOKEN': xReplitToken
        }
      }
    );
    
    if (!response.ok) {
      throw new Error('Failed to fetch HubSpot connection settings');
    }
    
    const data = await response.json();
    connectionSettings = data.items?.[0];
  } catch (error) {
    throw new Error('Failed to connect to HubSpot: ' + error.message);
  }

  if (!connectionSettings) {
    throw new Error('HubSpot connector not configured');
  }

  const accessToken = connectionSettings?.settings?.access_token || 
                      connectionSettings?.settings?.oauth?.credentials?.access_token;

  if (!accessToken) {
    throw new Error('HubSpot not connected - no access token found');
  }
  
  // Store expiration time from the connection settings
  const expiresAt = connectionSettings?.settings?.expires_at || 
                    connectionSettings?.settings?.oauth?.credentials?.expires_at;
  if (expiresAt) {
    tokenExpiresAt = new Date(expiresAt).getTime();
  } else {
    // Default to 25 minutes from now if no expiry provided (HubSpot tokens last 30 min)
    tokenExpiresAt = Date.now() + (25 * 60 * 1000);
  }
  
  return accessToken;
}

async function getHubSpotClient() {
  const accessToken = await getAccessToken();
  return new Client({ accessToken });
}

async function getPipelines() {
  try {
    const client = await getHubSpotClient();
    const response = await client.crm.pipelines.pipelinesApi.getAll('deals');
    return response.results.map(pipeline => ({
      id: pipeline.id,
      label: pipeline.label,
      stages: pipeline.stages.map(stage => ({
        id: stage.id,
        label: stage.label,
        displayOrder: stage.displayOrder
      })).sort((a, b) => a.displayOrder - b.displayOrder)
    }));
  } catch (error) {
    console.error('Error fetching HubSpot pipelines:', error.message);
    throw error;
  }
}

async function getRecord(recordId) {
  try {
    const client = await getHubSpotClient();
    const response = await client.crm.deals.basicApi.getById(recordId, ['dealname', 'dealstage', 'pipeline', 'amount']);
    return response;
  } catch (error) {
    console.error('Error fetching record:', error.message);
    throw error;
  }
}

async function updateRecordStage(recordId, stageId, pipelineId = null) {
  try {
    const client = await getHubSpotClient();
    const properties = { dealstage: stageId };
    if (pipelineId) {
      properties.pipeline = pipelineId;
    }
    
    console.log(`📤 Updating HubSpot record ${recordId} with properties:`, JSON.stringify(properties));
    
    const response = await client.crm.deals.basicApi.update(recordId, { properties });
    
    console.log(`✅ HubSpot record ${recordId} updated - Response stage: ${response.properties?.dealstage}`);
    return response;
  } catch (error) {
    console.error('Error updating record stage:', error.message);
    if (error.body) {
      console.error('HubSpot API error details:', JSON.stringify(error.body));
    }
    throw error;
  }
}

async function logRecordActivity(recordId, activityType, details) {
  try {
    const client = await getHubSpotClient();
    
    const noteBody = `[Project Tracker] ${activityType}\n\n${details}`;
    
    const noteObj = {
      properties: {
        hs_timestamp: Date.now().toString(),
        hs_note_body: noteBody
      },
      associations: [
        {
          to: { id: recordId },
          types: [
            {
              associationCategory: 'HUBSPOT_DEFINED',
              associationTypeId: ASSOCIATION_TYPES.DEAL_TO_NOTE
            }
          ]
        }
      ]
    };

    const noteResponse = await client.crm.objects.notes.basicApi.create(noteObj);

    console.log(`✅ HubSpot activity logged for record ${recordId}: ${activityType}`);
    return noteResponse;
  } catch (error) {
    console.error('Error logging record activity:', error.message);
    if (error.body) {
      console.error('HubSpot API error details:', JSON.stringify(error.body));
    }
    throw error;
  }
}

async function testConnection() {
  try {
    const client = await getHubSpotClient();
    const response = await client.crm.pipelines.pipelinesApi.getAll('deals');
    return { connected: true, pipelineCount: response.results.length };
  } catch (error) {
    return { connected: false, error: error.message };
  }
}

async function getOwners() {
  try {
    const client = await getHubSpotClient();
    const response = await client.crm.owners.ownersApi.getPage();
    return response.results || [];
  } catch (error) {
    console.error('Error fetching HubSpot owners:', error.message);
    return [];
  }
}

async function findOwnerByName(firstName, lastName) {
  try {
    const owners = await getOwners();
    const match = owners.find(owner => {
      const ownerFirst = (owner.firstName || '').toLowerCase().trim();
      const ownerLast = (owner.lastName || '').toLowerCase().trim();
      return ownerFirst === firstName.toLowerCase().trim() && 
             ownerLast === lastName.toLowerCase().trim();
    });
    return match ? match.id : null;
  } catch (error) {
    console.error('Error finding owner by name:', error.message);
    return null;
  }
}

async function findOwnerByEmail(email) {
  try {
    const owners = await getOwners();
    const normalizedEmail = email.toLowerCase().trim();
    const match = owners.find(owner => {
      const ownerEmail = (owner.email || '').toLowerCase().trim();
      return ownerEmail === normalizedEmail;
    });
    if (match) {
      console.log(`📧 Found HubSpot owner by email "${email}": ${match.id}`);
    }
    return match ? match.id : null;
  } catch (error) {
    console.error('Error finding owner by email:', error.message);
    return null;
  }
}

async function uploadFileAndAttachToRecord(recordId, fileContent, fileName, customNote = null, options = {}) {
  const recordType = options.recordType || 'companies';
  
  if (!recordId) {
    throw new Error('Record ID is required for file upload');
  }
  if (!fileContent) {
    throw new Error('File content is required');
  }
  if (!fileName) {
    throw new Error('File name is required');
  }
  
  const privateAppToken = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
  if (!privateAppToken) {
    throw new Error('HubSpot Private App token not configured. File uploads require HUBSPOT_PRIVATE_APP_TOKEN environment variable.');
  }
  
  try {
    const privateAppClient = new Client({ accessToken: privateAppToken });
    
    const formData = new FormData();
    
    const isBase64 = options.isBase64 || (typeof fileContent === 'string' && /^[A-Za-z0-9+/=]+$/.test(fileContent.slice(0, 100)));
    const fileBuffer = isBase64 ? Buffer.from(fileContent, 'base64') : Buffer.from(fileContent, 'utf8');
    
    const ext = fileName.split('.').pop().toLowerCase();
    const mimeTypes = {
      'pdf': 'application/pdf',
      'doc': 'application/msword',
      'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'xls': 'application/vnd.ms-excel',
      'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'png': 'image/png',
      'jpg': 'image/jpeg',
      'jpeg': 'image/jpeg',
      'gif': 'image/gif',
      'html': 'text/html',
      'txt': 'text/plain',
      'csv': 'text/csv'
    };
    const contentType = mimeTypes[ext] || 'application/octet-stream';
    
    formData.append('file', fileBuffer, {
      filename: fileName,
      contentType: contentType
    });
    
    const folderPath = options.folderPath || '/client-uploads';
    formData.append('folderPath', folderPath);
    formData.append('options', JSON.stringify({ 
      access: 'PRIVATE',
      overwrite: false,
      duplicateValidationStrategy: 'NONE',
      duplicateValidationScope: 'ENTIRE_PORTAL'
    }));
    
    console.log(`📤 Uploading file to HubSpot: ${fileName} (${fileBuffer.length} bytes, ${contentType})`);
    const uploadResponse = await axios.post(
      'https://api.hubapi.com/files/v3/files',
      formData,
      {
        headers: {
          'Authorization': `Bearer ${privateAppToken}`,
          ...formData.getHeaders()
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity
      }
    );
    
    console.log(`📤 HubSpot response status: ${uploadResponse.status}`);
    
    const fileData = uploadResponse.data;
    console.log(`✅ File uploaded to HubSpot: ${fileData.id}`);
    
    const notePrefix = options.notePrefix || '[Project Tracker]';
    const noteBody = customNote 
      ? `${notePrefix} ${customNote}\n\nFile: ${fileName}\nFile ID: ${fileData.id}\nFile URL: ${fileData.url || 'Available in HubSpot Files'}`
      : `${notePrefix} Soft-Pilot Checklist Submitted\n\nA signed soft-pilot checklist has been submitted for this deal.\n\nFile: ${fileName}\nFile ID: ${fileData.id}\nFile URL: ${fileData.url || 'Available in HubSpot Files'}`;
    
    const cleanRecordId = recordId.toString().replace(/\D/g, '');
    console.log(`📤 Creating note for ${recordType}: ${cleanRecordId}`);
    
    const noteProperties = {
      hs_timestamp: Date.now().toString(),
      hs_note_body: noteBody,
      hs_attachment_ids: fileData.id.toString()
    };
    
    const noteResponse = await privateAppClient.crm.objects.notes.basicApi.create({
      properties: noteProperties
    });
    
    console.log(`✅ Note created: ${noteResponse.id}`);
    
    try {
      const associationTypeId = recordType === 'companies' ? ASSOCIATION_TYPES.COMPANY_TO_NOTE : ASSOCIATION_TYPES.DEAL_TO_NOTE;
      
      await axios.put(
        `https://api.hubapi.com/crm/v4/objects/notes/${noteResponse.id}/associations/${recordType}/${cleanRecordId}`,
        [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: associationTypeId }],
        {
          headers: {
            'Authorization': `Bearer ${privateAppToken}`,
            'Content-Type': 'application/json'
          }
        }
      );
      console.log(`✅ Note associated with ${recordType} ${cleanRecordId}`);
    } catch (assocError) {
      console.error(`Failed to associate note with ${recordType}:`, assocError.response?.data || assocError.message);
    }
    
    return { fileId: fileData.id, noteId: noteResponse.id, fileUrl: fileData.url || null };
  } catch (error) {
    if (error.response) {
      console.error('Error uploading file to HubSpot:', error.response.status, error.response.data);
      const errorMessage = typeof error.response.data === 'object' 
        ? JSON.stringify(error.response.data) 
        : error.response.data;
      throw new Error(`HubSpot file upload failed (${error.response.status}): ${errorMessage}`);
    }
    console.error('Error uploading file to HubSpot:', error.message);
    throw error;
  }
}

function isValidRecordId(recordId) {
  if (!recordId) return false;
  const cleanId = String(recordId).trim();
  return /^\d+$/.test(cleanId) && cleanId.length > 0;
}

async function syncTaskNoteToRecord(recordId, noteData, existingNoteId = null) {
  if (!isValidRecordId(recordId)) {
    console.log(`📋 Note sync skipped: Invalid Record ID "${recordId}"`);
    return null;
  }
  
  try {
    const client = await getHubSpotClient();
    
    const { taskTitle, phase, stage, noteContent, author, timestamp, projectName } = noteData;
    
    const formattedDate = new Date(timestamp).toLocaleString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    });
    
    const noteBody = `[Project Tracker] Task Note Added

Project: ${projectName || 'N/A'}
Phase: ${phase || 'N/A'}
Stage: ${stage || 'N/A'}
Task: ${taskTitle || 'N/A'}

Note by ${author} on ${formattedDate}:
${noteContent}`;
    
    const properties = {
      hs_timestamp: Date.now().toString(),
      hs_note_body: noteBody
    };
    
    // If we have an existing note ID, update it instead of creating
    if (existingNoteId) {
      try {
        const response = await client.crm.objects.notes.basicApi.update(existingNoteId, { properties });
        console.log(`✅ HubSpot note updated for task "${taskTitle}" (ID: ${existingNoteId})`);
        return { ...response, updated: true };
      } catch (updateError) {
        // If update fails (note deleted in HubSpot), fall through to create
        if (updateError.code === 404 || updateError.statusCode === 404) {
          console.log(`⚠️ HubSpot note ${existingNoteId} not found, creating new one`);
        } else {
          throw updateError;
        }
      }
    }
    
    // Create new note with association
    const noteObj = {
      properties,
      associations: [
        {
          to: { id: recordId.toString() },
          types: [
            {
              associationCategory: 'HUBSPOT_DEFINED',
              associationTypeId: ASSOCIATION_TYPES.DEAL_TO_NOTE
            }
          ]
        }
      ]
    };

    const noteResponse = await client.crm.objects.notes.basicApi.create(noteObj);
    console.log(`✅ HubSpot note created for task "${taskTitle}" (ID: ${noteResponse.id})`);
    return { ...noteResponse, created: true };
  } catch (error) {
    console.error('Error syncing note to HubSpot:', error.message);
    if (error.body) {
      console.error('HubSpot API error details:', JSON.stringify(error.body));
    }
    return null;
  }
}

async function createOrUpdateTask(dealId, taskSubject, taskBody, ownerId = null, existingTaskId = null) {
  try {
    const client = await getHubSpotClient();
    
    const properties = {
      hs_timestamp: new Date().toISOString(),
      hs_task_subject: taskSubject,
      hs_task_body: taskBody,
      hs_task_status: 'COMPLETED',
      hs_task_priority: 'MEDIUM',
      hs_task_type: 'TODO'
    };
    
    if (ownerId) {
      properties.hubspot_owner_id = ownerId;
    }
    
    // If we have an existing task ID, update it instead of creating
    if (existingTaskId) {
      try {
        const response = await client.crm.objects.basicApi.update('tasks', existingTaskId, { properties });
        console.log(`✅ HubSpot task updated: ${taskSubject} (ID: ${existingTaskId})`);
        return { ...response, updated: true };
      } catch (updateError) {
        // If update fails (task deleted in HubSpot), fall through to create
        if (updateError.code === 404 || updateError.statusCode === 404) {
          console.log(`⚠️ HubSpot task ${existingTaskId} not found, creating new one`);
        } else {
          throw updateError;
        }
      }
    }
    
    // Create new task with association
    const taskInput = {
      properties,
      associations: [
        {
          to: { id: dealId },
          types: [
            {
              associationCategory: 'HUBSPOT_DEFINED',
              associationTypeId: ASSOCIATION_TYPES.DEAL_TO_TASK
            }
          ]
        }
      ]
    };
    
    const response = await client.crm.objects.basicApi.create('tasks', taskInput);
    console.log(`✅ HubSpot task created: ${taskSubject} (ID: ${response.id})`);
    return { ...response, created: true };
  } catch (error) {
    console.error('Error creating/updating HubSpot task:', error.message);
    if (error.body) {
      console.error('HubSpot API error details:', JSON.stringify(error.body));
    }
    throw error;
  }
}

async function getTicketPipelines() {
  try {
    const client = await getHubSpotClient();
    const response = await client.crm.pipelines.pipelinesApi.getAll('tickets');
    return response.results.map(pipeline => ({
      id: pipeline.id,
      label: pipeline.label,
      stages: pipeline.stages.map(stage => ({
        id: stage.id,
        label: stage.label,
        displayOrder: stage.displayOrder
      })).sort((a, b) => a.displayOrder - b.displayOrder)
    }));
  } catch (error) {
    console.error('Error fetching HubSpot ticket pipelines:', error.message);
    throw error;
  }
}

async function getTicketsForCompany(companyId) {
  if (!companyId || !isValidRecordId(companyId)) {
    console.log(`📋 Ticket fetch skipped: Invalid Company ID "${companyId}"`);
    return [];
  }

  const privateAppToken = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
  if (!privateAppToken) {
    throw new Error('HubSpot Private App token not configured');
  }

  try {


    // First get ticket IDs associated with the company
    const assocResponse = await axios.get(
      `https://api.hubapi.com/crm/v4/objects/companies/${companyId}/associations/tickets`,
      {
        headers: {
          'Authorization': `Bearer ${privateAppToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const ticketIds = assocResponse.data?.results?.map(r => r.toObjectId) || [];

    if (ticketIds.length === 0) {
      console.log(`📋 No tickets found for company ${companyId}`);
      return [];
    }

    console.log(`📋 Found ${ticketIds.length} tickets for company ${companyId}`);

    // Fetch ticket details with pipeline info
    const ticketsResponse = await axios.post(
      'https://api.hubapi.com/crm/v3/objects/tickets/batch/read',
      {
        inputs: ticketIds.map(id => ({ id })),
        properties: ['subject', 'content', 'hs_pipeline', 'hs_pipeline_stage', 'hs_ticket_priority', 'createdate', 'hs_lastmodifieddate', 'closed_date', 'hs_resolution', 'hs_object_source', 'hs_object_source_label', 'internal_vs_external_ticket']
      },
      {
        headers: {
          'Authorization': `Bearer ${privateAppToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    // Get pipeline info for stage labels (optional - may fail without tickets scope)
    let stageMap = {};
    try {
      const pipelines = await getTicketPipelines();
      pipelines.forEach(p => {
        p.stages.forEach(s => {
          stageMap[s.id] = { label: s.label, pipelineName: p.label };
        });
      });
    } catch (pipelineErr) {
      console.log('📋 Could not fetch pipeline info, using raw stage IDs');
    }

    const tickets = await Promise.all(ticketsResponse.data?.results?.map(async ticket => {
      const props = ticket.properties;
      const stageInfo = stageMap[props.hs_pipeline_stage] || {};

      // Fetch attachments (notes with files) for this ticket
      let attachments = [];
      try {
        const notesResponse = await axios.get(
          `https://api.hubapi.com/crm/v4/objects/tickets/${ticket.id}/associations/notes`,
          {
            headers: {
              'Authorization': `Bearer ${privateAppToken}`,
              'Content-Type': 'application/json'
            }
          }
        );

        const noteIds = notesResponse.data?.results?.map(r => r.toObjectId) || [];
        if (noteIds.length > 0) {
          const notesDetailResponse = await axios.post(
            'https://api.hubapi.com/crm/v3/objects/notes/batch/read',
            {
              inputs: noteIds.map(id => ({ id })),
              properties: ['hs_note_body', 'hs_attachment_ids', 'hs_timestamp']
            },
            {
              headers: {
                'Authorization': `Bearer ${privateAppToken}`,
                'Content-Type': 'application/json'
              }
            }
          );

          // Extract attachments from notes
          for (const note of notesDetailResponse.data?.results || []) {
            if (note.properties.hs_attachment_ids) {
              const fileIds = note.properties.hs_attachment_ids.split(';');
              for (const fileId of fileIds) {
                if (fileId.trim()) {
                  attachments.push({
                    fileId: fileId.trim(),
                    noteBody: note.properties.hs_note_body || '',
                    timestamp: note.properties.hs_timestamp
                  });
                }
              }
            }
          }
        }
      } catch (attachErr) {
        console.log(`Could not fetch attachments for ticket ${ticket.id}:`, attachErr.message);
      }

      return {
        id: ticket.id,
        subject: props.subject || 'No Subject',
        content: props.content || '',
        pipeline: stageInfo.pipelineName || props.hs_pipeline || 'Support',
        stage: stageInfo.label || props.hs_pipeline_stage || 'Unknown',
        stageId: props.hs_pipeline_stage,
        priority: props.hs_ticket_priority || 'MEDIUM',
        createdAt: props.createdate,
        updatedAt: props.hs_lastmodifieddate,
        closedAt: props.closed_date,
        resolution: props.hs_resolution || '',
        attachments: attachments,
        source: props.hs_object_source || '',
        sourceLabel: props.hs_object_source_label || '',
        ticketType: props.internal_vs_external_ticket || ''
      };
    }) || []);

    // Sort by creation date, newest first
    tickets.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    return tickets;
  } catch (error) {
    console.error('Error fetching tickets for company:', error.response?.data || error.message);
    throw error;
  }
}

async function getTicketsForContact(contactId) {
  if (!contactId || !isValidRecordId(contactId)) {
    console.log(`📋 Ticket fetch skipped: Invalid Contact ID "${contactId}"`);
    return [];
  }

  const privateAppToken = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
  if (!privateAppToken) {
    throw new Error('HubSpot Private App token not configured');
  }

  try {


    // Get ticket IDs associated with the contact
    const assocResponse = await axios.get(
      `https://api.hubapi.com/crm/v4/objects/contacts/${contactId}/associations/tickets`,
      {
        headers: {
          'Authorization': `Bearer ${privateAppToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const ticketIds = assocResponse.data?.results?.map(r => r.toObjectId) || [];

    if (ticketIds.length === 0) {
      console.log(`📋 No tickets found for contact ${contactId}`);
      return [];
    }

    console.log(`📋 Found ${ticketIds.length} tickets for contact ${contactId}`);

    // Fetch ticket details
    const ticketsResponse = await axios.post(
      'https://api.hubapi.com/crm/v3/objects/tickets/batch/read',
      {
        inputs: ticketIds.map(id => ({ id })),
        properties: ['subject', 'content', 'hs_pipeline', 'hs_pipeline_stage', 'hs_ticket_priority', 'createdate', 'hs_lastmodifieddate', 'closed_date', 'hs_resolution', 'hs_object_source', 'hs_object_source_label', 'internal_vs_external_ticket']
      },
      {
        headers: {
          'Authorization': `Bearer ${privateAppToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    // Get pipeline info for stage labels (optional - may fail without tickets scope)
    let stageMap = {};
    try {
      const pipelines = await getTicketPipelines();
      pipelines.forEach(p => {
        p.stages.forEach(s => {
          stageMap[s.id] = { label: s.label, pipelineName: p.label };
        });
      });
    } catch (pipelineErr) {
      console.log('📋 Could not fetch pipeline info, using raw stage IDs');
    }

    const tickets = await Promise.all(ticketsResponse.data?.results?.map(async ticket => {
      const props = ticket.properties;
      const stageInfo = stageMap[props.hs_pipeline_stage] || {};

      // Fetch attachments (notes with files) for this ticket
      let attachments = [];
      try {
        const notesResponse = await axios.get(
          `https://api.hubapi.com/crm/v4/objects/tickets/${ticket.id}/associations/notes`,
          {
            headers: {
              'Authorization': `Bearer ${privateAppToken}`,
              'Content-Type': 'application/json'
            }
          }
        );

        const noteIds = notesResponse.data?.results?.map(r => r.toObjectId) || [];
        if (noteIds.length > 0) {
          const notesDetailResponse = await axios.post(
            'https://api.hubapi.com/crm/v3/objects/notes/batch/read',
            {
              inputs: noteIds.map(id => ({ id })),
              properties: ['hs_note_body', 'hs_attachment_ids', 'hs_timestamp']
            },
            {
              headers: {
                'Authorization': `Bearer ${privateAppToken}`,
                'Content-Type': 'application/json'
              }
            }
          );

          for (const note of notesDetailResponse.data?.results || []) {
            if (note.properties.hs_attachment_ids) {
              const fileIds = note.properties.hs_attachment_ids.split(';');
              for (const fileId of fileIds) {
                if (fileId.trim()) {
                  attachments.push({
                    fileId: fileId.trim(),
                    noteBody: note.properties.hs_note_body || '',
                    timestamp: note.properties.hs_timestamp
                  });
                }
              }
            }
          }
        }
      } catch (attachErr) {
        console.log(`Could not fetch attachments for ticket ${ticket.id}:`, attachErr.message);
      }

      return {
        id: ticket.id,
        subject: props.subject || 'No Subject',
        content: props.content || '',
        pipeline: stageInfo.pipelineName || props.hs_pipeline || 'Support',
        stage: stageInfo.label || props.hs_pipeline_stage || 'Unknown',
        stageId: props.hs_pipeline_stage,
        priority: props.hs_ticket_priority || 'MEDIUM',
        createdAt: props.createdate,
        updatedAt: props.hs_lastmodifieddate,
        closedAt: props.closed_date,
        attachments: attachments,
        source: props.hs_object_source || '',
        sourceLabel: props.hs_object_source_label || '',
        ticketType: props.internal_vs_external_ticket || ''
      };
    }) || []);

    tickets.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    return tickets;
  } catch (error) {
    console.error('Error fetching tickets for contact:', error.response?.data || error.message);
    throw error;
  }
}

async function getTicketsForDeal(dealId) {
  if (!dealId || !isValidRecordId(dealId)) {
    console.log(`📋 Ticket fetch skipped: Invalid Deal ID "${dealId}"`);
    return [];
  }

  const privateAppToken = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
  if (!privateAppToken) {
    throw new Error('HubSpot Private App token not configured');
  }

  try {


    // Get ticket IDs associated with the deal
    const assocResponse = await axios.get(
      `https://api.hubapi.com/crm/v4/objects/deals/${dealId}/associations/tickets`,
      {
        headers: {
          'Authorization': `Bearer ${privateAppToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const ticketIds = assocResponse.data?.results?.map(r => r.toObjectId) || [];

    if (ticketIds.length === 0) {
      console.log(`📋 No tickets found for deal ${dealId}`);
      return [];
    }

    console.log(`📋 Found ${ticketIds.length} tickets for deal ${dealId}`);

    // Fetch ticket details
    const ticketsResponse = await axios.post(
      'https://api.hubapi.com/crm/v3/objects/tickets/batch/read',
      {
        inputs: ticketIds.map(id => ({ id })),
        properties: ['subject', 'content', 'hs_pipeline', 'hs_pipeline_stage', 'hs_ticket_priority', 'createdate', 'hs_lastmodifieddate', 'closed_date', 'hs_resolution', 'hs_object_source', 'hs_object_source_label', 'internal_vs_external_ticket']
      },
      {
        headers: {
          'Authorization': `Bearer ${privateAppToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    // Get pipeline info for stage labels (optional - may fail without tickets scope)
    let stageMap = {};
    try {
      const pipelines = await getTicketPipelines();
      pipelines.forEach(p => {
        p.stages.forEach(s => {
          stageMap[s.id] = { label: s.label, pipelineName: p.label };
        });
      });
    } catch (pipelineErr) {
      console.log('📋 Could not fetch pipeline info, using raw stage IDs');
    }

    const tickets = await Promise.all(ticketsResponse.data?.results?.map(async ticket => {
      const props = ticket.properties;
      const stageInfo = stageMap[props.hs_pipeline_stage] || {};

      // Fetch attachments (notes with files) for this ticket
      let attachments = [];
      try {
        const notesResponse = await axios.get(
          `https://api.hubapi.com/crm/v4/objects/tickets/${ticket.id}/associations/notes`,
          {
            headers: {
              'Authorization': `Bearer ${privateAppToken}`,
              'Content-Type': 'application/json'
            }
          }
        );

        const noteIds = notesResponse.data?.results?.map(r => r.toObjectId) || [];
        if (noteIds.length > 0) {
          const notesDetailResponse = await axios.post(
            'https://api.hubapi.com/crm/v3/objects/notes/batch/read',
            {
              inputs: noteIds.map(id => ({ id })),
              properties: ['hs_note_body', 'hs_attachment_ids', 'hs_timestamp']
            },
            {
              headers: {
                'Authorization': `Bearer ${privateAppToken}`,
                'Content-Type': 'application/json'
              }
            }
          );

          notesDetailResponse.data?.results?.forEach(note => {
            if (note.properties.hs_attachment_ids) {
              const fileIds = note.properties.hs_attachment_ids.split(';').filter(id => id);
              fileIds.forEach(fileId => {
                attachments.push({ fileId, noteBody: note.properties.hs_note_body });
              });
            }
          });
        }
      } catch (noteErr) {
        console.log(`📋 Could not fetch attachments for ticket ${ticket.id}`);
      }

      return {
        id: ticket.id,
        subject: props.subject || 'No Subject',
        content: props.content || '',
        stage: stageInfo.label || props.hs_pipeline_stage || 'Unknown',
        pipeline: stageInfo.pipelineName || props.hs_pipeline || 'Default',
        priority: props.hs_ticket_priority || 'Normal',
        createdAt: props.createdate,
        updatedAt: props.hs_lastmodifieddate,
        closedAt: props.closed_date,
        attachments: attachments,
        source: props.hs_object_source || '',
        sourceLabel: props.hs_object_source_label || '',
        ticketType: props.internal_vs_external_ticket || ''
      };
    }) || []);

    tickets.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    return tickets;
  } catch (error) {
    console.error('Error fetching tickets for deal:', error.response?.data || error.message);
    throw error;
  }
}

async function createTicketWithFile(ticketData, fileContent, fileName, companyId = null) {
  const privateAppToken = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
  if (!privateAppToken) {
    throw new Error('HubSpot Private App token not configured');
  }

  try {



    // 1. Upload the file first
    const formData = new FormData();
    const isBase64 = ticketData.isBase64 || false;
    const fileBuffer = isBase64 ? Buffer.from(fileContent, 'base64') : Buffer.from(fileContent, 'utf8');

    const ext = fileName.split('.').pop().toLowerCase();
    const mimeTypes = {
      'pdf': 'application/pdf',
      'html': 'text/html',
      'doc': 'application/msword',
      'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'txt': 'text/plain'
    };
    const contentType = mimeTypes[ext] || 'application/octet-stream';

    formData.append('file', fileBuffer, { filename: fileName, contentType: contentType });
    formData.append('folderPath', '/service-reports');
    formData.append('options', JSON.stringify({
      access: 'PRIVATE',
      overwrite: false,
      duplicateValidationStrategy: 'NONE',
      duplicateValidationScope: 'ENTIRE_PORTAL'
    }));

    console.log(`📤 Uploading file for ticket: ${fileName}`);

    const uploadResponse = await axios.post(
      'https://api.hubapi.com/files/v3/files',
      formData,
      {
        headers: {
          'Authorization': `Bearer ${privateAppToken}`,
          ...formData.getHeaders()
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity
      }
    );

    const fileId = uploadResponse.data.id;
    console.log(`✅ File uploaded: ${fileId}`);

    // 2. Create the ticket
    const ticketProperties = {
      subject: ticketData.subject || 'Service Report',
      content: ticketData.content || 'Service report attached',
      hs_pipeline: ticketData.pipelineId || '0', // Default pipeline
      hs_pipeline_stage: ticketData.stageId || '1', // First stage
      hs_ticket_priority: ticketData.priority || 'LOW'
    };

    const ticketInput = { properties: ticketProperties };

    // Add associations if company ID provided
    if (companyId && isValidRecordId(companyId)) {
      ticketInput.associations = [{
        to: { id: companyId },
        types: [{
          associationCategory: 'HUBSPOT_DEFINED',
          associationTypeId: ASSOCIATION_TYPES.TICKET_TO_COMPANY
        }]
      }];
    }

    const ticketResponse = await axios.post(
      'https://api.hubapi.com/crm/v3/objects/tickets',
      ticketInput,
      {
        headers: {
          'Authorization': `Bearer ${privateAppToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const ticketId = ticketResponse.data.id;
    console.log(`✅ Ticket created: ${ticketId}`);

    // 3. Create a note with the file attachment and associate with ticket
    const noteProperties = {
      hs_timestamp: Date.now().toString(),
      hs_note_body: `Service Report Attached\n\nFile: ${fileName}`,
      hs_attachment_ids: fileId.toString()
    };

    const noteResponse = await axios.post(
      'https://api.hubapi.com/crm/v3/objects/notes',
      { properties: noteProperties },
      {
        headers: {
          'Authorization': `Bearer ${privateAppToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const noteId = noteResponse.data.id;

    // Associate note with ticket
    await axios.put(
      `https://api.hubapi.com/crm/v4/objects/notes/${noteId}/associations/tickets/${ticketId}`,
      [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: ASSOCIATION_TYPES.NOTE_TO_TICKET }],
      {
        headers: {
          'Authorization': `Bearer ${privateAppToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log(`✅ Note ${noteId} associated with ticket ${ticketId}`);

    return {
      ticketId,
      fileId,
      noteId,
      ticketUrl: `https://app.hubspot.com/contacts/tickets/${ticketId}`
    };
  } catch (error) {
    console.error('Error creating ticket with file:', error.response?.data || error.message);
    throw error;
  }
}

/**
 * Fetches a single HubSpot ticket by ID with all properties and associations needed for Service Report integration
 * @param {string} ticketId - HubSpot ticket ID
 * @returns {object} Ticket data with properties, company, contact, and notes
 */
async function getTicketById(ticketId) {
  if (!ticketId || !isValidRecordId(ticketId)) {
    throw new Error(`Invalid ticket ID: ${ticketId}`);
  }

  const privateAppToken = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
  if (!privateAppToken) {
    throw new Error('HubSpot Private App token not configured');
  }

  try {


    // Fetch ticket with all required properties
    const ticketResponse = await axios.get(
      `https://api.hubapi.com/crm/v3/objects/tickets/${ticketId}`,
      {
        params: {
          properties: [
            'subject',
            'content',
            'hs_pipeline',
            'hs_pipeline_stage',
            'hs_ticket_priority',
            'createdate',
            'hs_lastmodifieddate',
            'hubspot_owner_id',
            'issue_category',      // Custom property
            'serial_number',       // Custom property
            'submitted_by'         // Custom property
          ].join(','),
          associations: 'company,contact,deal'
        },
        headers: {
          'Authorization': `Bearer ${privateAppToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const ticket = ticketResponse.data;
    const props = ticket.properties;

    // Get associated company (name + address)
    let companyId = null;
    let companyName = null;
    let companyAddress = '';
    const companyAssoc = ticket.associations?.companies?.results?.[0];
    if (companyAssoc) {
      companyId = companyAssoc.id;
      try {
        const companyResponse = await axios.get(
          `https://api.hubapi.com/crm/v3/objects/companies/${companyId}`,
          {
            params: { properties: 'name,address,city,state,zip' },
            headers: {
              'Authorization': `Bearer ${privateAppToken}`,
              'Content-Type': 'application/json'
            }
          }
        );
        const cp = companyResponse.data.properties;
        companyName = cp.name || null;
        const parts = [cp.address, cp.city, cp.state, cp.zip].filter(Boolean);
        companyAddress = parts.join(', ');
      } catch (err) {
        console.log(`Could not fetch company details for ${companyId}:`, err.message);
      }
    }

    // Get associated deal (first deal linked to the ticket)
    let dealId = null;
    const dealAssoc = ticket.associations?.deals?.results?.[0];
    if (dealAssoc) {
      dealId = dealAssoc.id;
    }

    // Get associated contact (primary contact)
    let contactId = null;
    let contactName = null;
    const contactAssoc = ticket.associations?.contacts?.results?.[0];
    if (contactAssoc) {
      contactId = contactAssoc.id;
      try {
        const contactResponse = await axios.get(
          `https://api.hubapi.com/crm/v3/objects/contacts/${contactId}`,
          {
            params: { properties: 'firstname,lastname' },
            headers: {
              'Authorization': `Bearer ${privateAppToken}`,
              'Content-Type': 'application/json'
            }
          }
        );
        const firstName = contactResponse.data.properties.firstname || '';
        const lastName = contactResponse.data.properties.lastname || '';
        contactName = `${firstName} ${lastName}`.trim();
      } catch (err) {
        console.log(`Could not fetch contact name for ${contactId}:`, err.message);
      }
    }

    // Fetch all notes attached to this ticket
    let notes = [];
    try {
      const notesResponse = await axios.get(
        `https://api.hubapi.com/crm/v4/objects/tickets/${ticketId}/associations/notes`,
        {
          headers: {
            'Authorization': `Bearer ${privateAppToken}`,
            'Content-Type': 'application/json'
          }
        }
      );

      const noteIds = notesResponse.data?.results?.map(r => r.toObjectId) || [];
      if (noteIds.length > 0) {
        const notesDetailResponse = await axios.post(
          'https://api.hubapi.com/crm/v3/objects/notes/batch/read',
          {
            inputs: noteIds.map(id => ({ id })),
            properties: ['hs_note_body', 'hs_attachment_ids', 'hs_timestamp']
          },
          {
            headers: {
              'Authorization': `Bearer ${privateAppToken}`,
              'Content-Type': 'application/json'
            }
          }
        );

        notes = notesDetailResponse.data?.results?.map(note => ({
          id: note.id,
          body: note.properties.hs_note_body || '',
          attachmentIds: note.properties.hs_attachment_ids || '',
          timestamp: note.properties.hs_timestamp
        })) || [];
      }
    } catch (notesErr) {
      console.log(`Could not fetch notes for ticket ${ticketId}:`, notesErr.message);
    }

    // Get pipeline stage info
    let stageLabel = 'Unknown';
    try {
      const pipelines = await getTicketPipelines();
      for (const pipeline of pipelines) {
        const stage = pipeline.stages.find(s => s.id === props.hs_pipeline_stage);
        if (stage) {
          stageLabel = stage.label;
          break;
        }
      }
    } catch (err) {
      console.log('Could not fetch pipeline info:', err.message);
    }

    return {
      id: ticket.id,
      subject: props.subject || '',
      description: props.content || '',
      pipeline: props.hs_pipeline,
      stage: stageLabel,
      stageId: props.hs_pipeline_stage,
      priority: props.hs_ticket_priority || 'MEDIUM',
      createdAt: props.createdate,
      updatedAt: props.hs_lastmodifieddate,
      ownerId: props.hubspot_owner_id || null,
      issueCategory: props.issue_category || '',
      serialNumber: props.serial_number || '',
      submittedBy: props.submitted_by || contactName || '',
      companyId: companyId,
      companyName: companyName,
      address: companyAddress,
      dealId: dealId,
      contactId: contactId,
      contactName: contactName,
      notes: notes
    };
  } catch (error) {
    console.error('Error fetching ticket by ID:', error.response?.data || error.message);
    throw error;
  }
}

/**
 * Search for tickets in specific pipeline stages, optionally filtered by modification date.
 * Uses HubSpot CRM Search API with the Private App token.
 * @param {string[]} stageIds - Array of pipeline stage IDs to search for
 * @param {string|null} modifiedAfter - ISO timestamp - only return tickets modified after this time
 * @param {string[]} additionalProperties - Extra property names to include in results
 * @param {number} limit - Maximum results to return (default 100)
 * @returns {object[]} Array of raw ticket objects from HubSpot search API
 */
async function searchTicketsByStage(stageIds, modifiedAfter = null, additionalProperties = [], limit = 100) {
  const privateAppToken = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
  if (!privateAppToken) {
    throw new Error('HubSpot Private App token not configured');
  }

  if (!stageIds || stageIds.length === 0) {
    return [];
  }

  // Build filters - ANDed within a single filter group
  const filters = [
    {
      propertyName: 'hs_pipeline_stage',
      operator: 'IN',
      values: stageIds
    }
  ];

  // Add time filter to only get recently modified tickets
  if (modifiedAfter) {
    filters.push({
      propertyName: 'hs_lastmodifieddate',
      operator: 'GTE',
      value: String(new Date(modifiedAfter).getTime())
    });
  }

  // Standard properties + any additional ones requested (e.g. custom trigger property)
  const properties = [
    'subject',
    'content',
    'hs_pipeline',
    'hs_pipeline_stage',
    'hs_ticket_priority',
    'createdate',
    'hs_lastmodifieddate',
    'hubspot_owner_id',
    'issue_category',
    'serial_number',
    'submitted_by',
    ...additionalProperties
  ];

  try {
    const response = await axios.post(
      'https://api.hubapi.com/crm/v3/objects/tickets/search',
      {
        filterGroups: [{ filters }],
        properties: [...new Set(properties)], // deduplicate
        sorts: [{ propertyName: 'hs_lastmodifieddate', direction: 'DESCENDING' }],
        limit
      },
      {
        headers: {
          'Authorization': `Bearer ${privateAppToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    return response.data?.results || [];
  } catch (error) {
    console.error('Error searching tickets by stage:', error.response?.data || error.message);
    throw error;
  }
}

// Create a plain support ticket (no file attachment).
// Sets internal_vs_external_ticket = 'External' so the ticket is visible
// through the client portal filter (GET /api/client/hubspot/tickets).
async function createTicket(ticketData, companyId = null, contactId = null, dealId = null) {
  const privateAppToken = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
  if (!privateAppToken) throw new Error('HubSpot Private App token not configured');

  const priorityMap = { 'Low': 'LOW', 'Medium': 'MEDIUM', 'High': 'HIGH' };
  const ticketProperties = {
    subject: ticketData.subject || 'Support Request',
    content: ticketData.description || '',
    hs_pipeline: ticketData.pipelineId || '0',
    hs_pipeline_stage: ticketData.stageId || '1',
    hs_ticket_priority: priorityMap[ticketData.priority] || 'LOW'
  };

  if (ticketData.issueCategory) ticketProperties.issue_category = ticketData.issueCategory;
  if (ticketData.submittedBy) ticketProperties.submitted_by = ticketData.submittedBy;

  const ticketInput = { properties: ticketProperties };

  const associations = [];
  if (companyId && isValidRecordId(companyId)) {
    associations.push({
      to: { id: companyId },
      types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: ASSOCIATION_TYPES.TICKET_TO_COMPANY }]
    });
  }
  if (contactId && isValidRecordId(contactId)) {
    associations.push({
      to: { id: contactId },
      types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: ASSOCIATION_TYPES.TICKET_TO_CONTACT }]
    });
  }
  if (dealId && isValidRecordId(dealId)) {
    associations.push({
      to: { id: dealId },
      types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: ASSOCIATION_TYPES.TICKET_TO_DEAL }]
    });
  }
  if (associations.length > 0) ticketInput.associations = associations;

  try {
    const response = await axios.post(
      'https://api.hubapi.com/crm/v3/objects/tickets',
      ticketInput,
      { headers: { 'Authorization': `Bearer ${privateAppToken}`, 'Content-Type': 'application/json' } }
    );
    return { ticketId: response.data.id };
  } catch (err) {
    const detail = err.response?.data?.message || err.response?.data || err.message;
    console.error('HubSpot createTicket error detail:', JSON.stringify(detail));
    throw new Error(`HubSpot ticket creation failed: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
  }
}

module.exports = {
  getHubSpotClient,
  getPipelines,
  findOwnerByEmail,
  getRecord,
  updateRecordStage,
  logRecordActivity,
  testConnection,
  getOwners,
  findOwnerByName,
  createOrUpdateTask,
  uploadFileAndAttachToRecord,
  syncTaskNoteToRecord,
  isValidRecordId,
  getTicketPipelines,
  getTicketsForCompany,
  getTicketsForContact,
  getTicketsForDeal,
  createTicket,
  createTicketWithFile,
  getTicketById,
  searchTicketsByStage
};
