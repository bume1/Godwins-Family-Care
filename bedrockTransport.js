// bedrockTransport.js — the ONE Bedrock client, wired to modelEngine.js's
// transport contract and nowhere else (2026-09-24).
//
// modelEngine.js already refuses to invoke a model at all unless
// BEDROCK_REGION, BEDROCK_MODEL_ID and BEDROCK_ZERO_DATA_RETENTION are set
// and no static AWS keys are present — this module does not re-check any of
// that, and must not: its only job is to not UNDERMINE it, which means it
// never accepts or passes explicit credentials. The AWS SDK's default
// credential provider chain is the only door, so the identity this runs as
// is whatever IAM role the container itself was given — never a key pair
// this file could leak.
//
// It is REQUIRED at boot (server.js loads it to build the transport) but
// NEVER CALLED unless the boundary settings above are satisfied, so a
// server with no AWS role and no Bedrock settings boots exactly as it did
// before this file existed — the require just has to resolve.
'use strict';

const { BedrockRuntimeClient, ConverseCommand } = require('@aws-sdk/client-bedrock-runtime');

// Lazy and region-keyed: nothing here talks to AWS until the first real
// invocation, and a region change (there is exactly one in practice, but
// nothing stops a later multi-region setup) gets its own client rather than
// silently reusing one built for somewhere else.
const clients = new Map();
const clientFor = (region) => {
  if (!clients.has(region)) clients.set(region, new BedrockRuntimeClient({ region }));
  return clients.get(region);
};

// What Bedrock's Converse API will read out of a document block, keyed off
// the mime type the upload already carries. A mime type not in either map is
// refused by name rather than sent and left for Bedrock to reject less
// legibly.
const DOCUMENT_FORMATS = Object.freeze({
  'application/pdf': 'pdf',
  'text/csv': 'csv',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'text/html': 'html',
  'text/plain': 'txt',
  'text/markdown': 'md'
});
const IMAGE_FORMATS = Object.freeze({
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/gif': 'gif',
  'image/webp': 'webp'
});

// A purpose-specific instruction. Kept short and structural on purpose — the
// schema (below) is what actually constrains the shape of the answer, and a
// long persuasive prompt is not a substitute for that constraint.
const PROMPTS = Object.freeze({
  document_extraction: 'Read the attached document and call record_reading with only the fields you can actually see printed on it. Leave a field out entirely rather than guess — an omitted field is reviewed as blank, a wrong one is reviewed as if it were true.',
  document_classification: 'Read the attached document and call record_reading to classify it.',
  dictation_to_note: 'Turn the attached dictation into a structured note by calling record_reading.'
});

// Bedrock's tool-use forces a structured response shaped exactly like the
// caller's schema, rather than free text a model happened to format as
// JSON — modelEngine.js still validates the result against the same schema
// afterward, so this is a reliability measure, not the safety boundary.
const jsonSchemaFor = (schema) => {
  const properties = {};
  const fields = (schema && schema.fields) || {};
  for (const [key, def] of Object.entries(fields)) {
    const prop = { type: def.type === 'number' ? 'number' : 'string' };
    if (Array.isArray(def.enum) && def.enum.length) prop.enum = def.enum;
    properties[key] = prop;
  }
  properties.confidence = { type: 'number', description: 'Overall confidence in this reading, 0 to 1.' };
  return { type: 'object', properties };
};

// The content block Bedrock reads the document out of. A mime type in
// neither map is refused HERE, by name, rather than sent to Bedrock and left
// for it to reject less legibly.
const contentBlockFor = ({ mimeType, bytes }) => {
  const mime = mimeType || '';
  if (DOCUMENT_FORMATS[mime]) return { document: { format: DOCUMENT_FORMATS[mime], name: 'document', source: { bytes } } };
  if (IMAGE_FORMATS[mime]) return { image: { format: IMAGE_FORMATS[mime], source: { bytes } } };
  throw new Error(`"${mime}" is not a document or image format this reads.`);
};

// The Converse request body, as a plain object — pure and independently
// testable, so a schema/prompt/tool-shape mistake shows up without a live
// AWS call.
const buildRequest = ({ purpose, input, schema, modelId }) => {
  const bytes = input && input.bytes;
  if (!bytes || !bytes.length) throw new Error('No document bytes to read.');
  const contentBlock = contentBlockFor({ mimeType: input && input.mimeType, bytes });
  return {
    modelId,
    messages: [{ role: 'user', content: [contentBlock, { text: PROMPTS[purpose] || PROMPTS.document_extraction }] }],
    toolConfig: {
      tools: [{
        toolSpec: {
          name: 'record_reading',
          description: 'Record what was read out of the document.',
          inputSchema: { json: jsonSchemaFor(schema) }
        }
      }],
      toolChoice: { tool: { name: 'record_reading' } }
    }
  };
};

// Bedrock hands the structured answer back as a tool-use content block.
// Anything else — no tool use, a malformed one — is a failure, not a value
// to coerce; modelEngine.js's own schema validation runs on whatever this
// returns, so this only has to unwrap the envelope honestly.
const parseResponse = (response) => {
  const content = response && response.output && response.output.message && response.output.message.content;
  const toolUse = Array.isArray(content) ? content.find(b => b && b.toolUse) : null;
  if (!toolUse || !toolUse.toolUse || typeof toolUse.toolUse.input !== 'object') {
    throw new Error('The model returned no structured reading.');
  }
  return toolUse.toolUse.input;
};

// Builds the transport function modelEngine.js calls, off whatever client
// factory it is given. Production wires `clientFor` (the real, lazy AWS SDK
// client); a test wires a fake one and never touches the network — the same
// dependency-injection shape modelEngine.js itself uses to stay testable.
const createTransport = (getClient) => async ({ purpose, input, schema, region, modelId }) => {
  const request = buildRequest({ purpose, input, schema, modelId });
  const response = await getClient(region).send(new ConverseCommand(request));
  return parseResponse(response);
};

module.exports = {
  transport: createTransport(clientFor),
  createTransport,
  buildRequest, parseResponse, contentBlockFor, jsonSchemaFor,
  DOCUMENT_FORMATS, IMAGE_FORMATS
};
