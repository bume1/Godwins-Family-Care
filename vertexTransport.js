// vertexTransport.js — the ONE Gemini client, wired to modelEngine.js's
// transport contract and nowhere else (2026-10-12).
//
// modelEngine.js already refuses to invoke a model at all unless the Vertex
// settings are present, the location is "us", the model is a released one,
// ZDR is affirmative, the credential is a federated one rather than a key,
// and the daily Google-side checks have passed — this module does not
// re-check any of that, and must not: its only job is to not UNDERMINE it.
// Every value it needs is PASSED IN. It never reads process.env, so there is
// no path by which it can disagree with the module that made the decision.
//
// NO STORED CREDENTIAL. google-auth-library's default chain resolves the
// Workload Identity Federation config the container is given, so the identity
// this runs as is the EC2 role federated into Google — never a key file this
// module could leak.
//
// THINGS DELIBERATELY NEVER USED, each of which would break the retention
// promise or send data somewhere it was not meant to go: tools of any kind
// (Search or Maps grounding, code execution, URL context), the Interactions
// API, request-response logging, cached content, and Live sessions. A test
// fails the build if a tool is passed.
//
// It is REQUIRED at boot (server.js loads it to build the transport) but NEVER
// CALLED unless the boundary is satisfied, so a server with no Vertex setup
// boots exactly as it did before this file existed — the require just has to
// resolve.
'use strict';

const crypto = require('crypto');
const { GoogleGenAI, Type } = require('@google/genai');
const { GoogleAuth } = require('google-auth-library');
const { Storage } = require('@google-cloud/storage');
const { PDFDocument } = require('pdf-lib');

// Vertex's own ceiling on a single inline/stored file part. A PDF over this is
// split by page range rather than refused — a hospital packet is routinely
// bigger than this, and refusing it would mean the one document most worth
// reading is the one that cannot be.
const MAX_FILE_BYTES = 20 * 1024 * 1024;
// Pages per part when a PDF has to be split. Conservative on purpose: a part
// that still exceeds the ceiling is split again.
const SPLIT_PAGE_STEP = 40;

// What the model is told, per purpose. Constants, in this file, so the
// instruction that shaped an answer is readable beside the call that sent it.
//
// Every one of these says the same three things in its own words, because they
// are the three §10.3 makes non-negotiable: use only what you were given, cite
// it, and do not prescribe or diagnose.
const SYSTEM_INSTRUCTIONS = Object.freeze({
  chart_review: [
    'You are assisting a licensed clinician who is reviewing one patient\'s complete record.',
    'Use ONLY the sources provided in this request. Never use outside knowledge about this patient, and never infer a fact that is not in the sources.',
    'Every finding and every timeline entry MUST cite the sourceId it came from, and for a document also the page, quoting the exact words you relied on.',
    'Do NOT recommend medications, doses, orders, tests or billing codes, and do NOT offer a diagnosis. That is the clinician\'s decision and yours is not a clinical judgement.',
    'What you are for: flagging care gaps, inconsistencies between sources, safety concerns, abnormal results that appear unaddressed, and follow-ups that appear missed — each for the clinician to verify at its source.',
    'Anything headed "UNSIGNED DRAFT" is not part of the record. Treat it as unverified and say so if you rely on it.',
    'List everything you could not read in notReviewed. An omission you report is useful; one you hide is dangerous.'
  ].join(' '),
  chart_review_merge: [
    'You are merging the findings of several passes over ONE patient\'s record into a single review.',
    'Combine duplicates that describe the same issue, and KEEP EVERY CITATION from each version you merged — a merged finding that loses a citation becomes unverifiable.',
    'Do not introduce any finding that is not present in the passes you were given, and do not soften or strengthen a priority.',
    'Preserve every notReviewed entry from every pass.'
  ].join(' '),
  records_extraction: [
    'You are reading outside medical records for a licensed clinician so they can reconcile them against this patient\'s chart.',
    'Report ONLY what is printed in the documents provided. Every item MUST cite its sourceId, page, and the exact words you read it from.',
    'Where the chart sections provided already contain the same item, set matchesChart true; where they do not, set it false. If you cannot tell, treat it as not matching.',
    'Do NOT provide ICD-10, CPT or any other code, do NOT recommend a medication or dose, and do NOT diagnose.',
    'List anything you could not read in unreadable.'
  ].join(' '),
  document_extraction: 'Read the attached document and return ONLY the fields you can actually see printed on it. Leave a field out entirely rather than guess — an omitted field is reviewed as blank, a wrong one is reviewed as if it were true. Never infer a value from context.',
  document_classification: 'Read the attached document and classify it using only what is printed on it.',
  dictation_to_note: 'Turn the attached dictation into a structured note. Use only what was dictated; never add a finding, a plan or a value that was not said.'
});

// The engine's schema vocabulary translated into Google's. Kept mechanical on
// purpose: modelEngine.js validates the answer against the SAME schema
// afterwards, so this is a reliability measure that makes a well-shaped answer
// likely, never the safety boundary that makes a wrong one harmless.
const TYPES = { string: Type.STRING, number: Type.NUMBER, boolean: Type.BOOLEAN, array: Type.ARRAY, object: Type.OBJECT };
const responseSchemaFor = (schema) => {
  const build = (fields) => {
    const properties = {};
    const required = [];
    for (const [key, def] of Object.entries(fields || {})) {
      const prop = { type: TYPES[def.type] || Type.STRING };
      if (Array.isArray(def.enum) && def.enum.length) prop.enum = def.enum.map(String);
      if (def.type === 'string' && def.maxLength) prop.maxLength = String(def.maxLength);
      if (def.type === 'array') prop.items = { type: Type.OBJECT, ...build(def.items) };
      if (def.type === 'object') Object.assign(prop, build(def.items));
      if (def.description) prop.description = def.description;
      properties[key] = prop;
      if (def.required) required.push(key);
    }
    return required.length ? { properties, required } : { properties };
  };
  return { type: Type.OBJECT, ...build(schema && schema.fields) };
};

// ── the one user turn ──────────────────────────────────────────────────────
// A text part carrying the chart sections, then one labelled part per
// document. The label is sent as its own text part immediately before the
// file so a citation can name the document it belongs to — a file with no
// label beside it is a file the model can read and cannot cite.
const sectionText = (sections) => (sections || []).map(s => {
  const head = `SOURCE ${s.sourceId} | ${s.kind || ''} | ${s.date || ''} | ${s.title || ''}`;
  return `${head}\n${typeof s.text === 'string' ? s.text : JSON.stringify(s.value ?? '', null, 1)}`;
}).join('\n\n');

// ── staging ───────────────────────────────────────────────────────────────
// A document is handed to Vertex by reference, so it has to sit somewhere
// Google can read for the duration of one call. THE OBJECT NAME IS RANDOM AND
// CARRIES NOTHING: no patient name, no client id, no document id, no original
// filename. An object name appears in Google's own logs and in any error, and
// a name that identifies a patient is a disclosure in a place nobody is
// watching. The 1-day lifecycle rule on the bucket is the backstop; the
// `finally` below is the actual deletion.
const stagedName = () => `stage/${crypto.randomBytes(24).toString('hex')}`;

// Split a PDF too large for one part into page ranges. Each part becomes its
// own source id — "doc:<id>#p3-42" — so a citation still names exactly which
// pages were read.
const splitPdf = async (bytes, sourceId) => {
  const src = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const total = src.getPageCount();
  const parts = [];
  for (let from = 0; from < total; from += SPLIT_PAGE_STEP) {
    const to = Math.min(from + SPLIT_PAGE_STEP, total);
    const out = await PDFDocument.create();
    const pages = await out.copyPages(src, Array.from({ length: to - from }, (_, i) => from + i));
    pages.forEach(p => out.addPage(p));
    parts.push({
      sourceId: `${sourceId}#p${from + 1}-${to}`,
      mimeType: 'application/pdf',
      bytes: Buffer.from(await out.save())
    });
  }
  return parts;
};

// Every document, split if it has to be, then uploaded. Returns the parts to
// send plus the staged object handles to delete afterwards.
const stageDocuments = async (bucketRef, documents) => {
  const staged = [];
  const parts = [];
  for (const doc of documents || []) {
    let pieces = [{ sourceId: doc.sourceId, mimeType: doc.mimeType, bytes: doc.bytes }];
    if (doc.bytes && doc.bytes.length > MAX_FILE_BYTES && doc.mimeType === 'application/pdf') {
      pieces = await splitPdf(doc.bytes, doc.sourceId);
    }
    for (const piece of pieces) {
      const name = stagedName();
      const file = bucketRef.file(name);
      await file.save(piece.bytes, { contentType: piece.mimeType, resumable: false });
      staged.push(file);
      parts.push({
        sourceId: piece.sourceId,
        label: `SOURCE ${piece.sourceId} | document | ${doc.title || ''}`,
        fileUri: `gs://${bucketRef.name}/${name}`,
        mimeType: piece.mimeType
      });
    }
  }
  return { staged, parts };
};

// ── the request ───────────────────────────────────────────────────────────
const buildContents = ({ input, documentParts }) => {
  const parts = [];
  const text = [
    input && input.instruction ? String(input.instruction) : null,
    input && input.focus ? `The clinician asked you to pay particular attention to: ${String(input.focus)}` : null,
    sectionText(input && input.sections)
  ].filter(Boolean).join('\n\n');
  if (text) parts.push({ text });
  for (const d of documentParts || []) {
    parts.push({ text: d.label });
    parts.push({ fileData: { fileUri: d.fileUri, mimeType: d.mimeType } });
  }
  // A dictation or a single document handed over as raw bytes, the shape the
  // existing enrollment extraction uses.
  if (input && input.bytes && input.bytes.length) {
    parts.push({ inlineData: { mimeType: input.mimeType || 'application/pdf', data: Buffer.from(input.bytes).toString('base64') } });
  }
  if (!parts.length) throw new Error('There was nothing to send.');
  return [{ role: 'user', parts }];
};

// A finishReason that is not STOP is a different failure with a different
// remedy, so each is named rather than collapsed into "the model failed".
const FINISH_MESSAGES = {
  SAFETY: 'the model stopped on a safety filter',
  RECITATION: 'the model stopped because the answer was reciting source material',
  MAX_TOKENS: 'the answer was cut off at the output limit',
  BLOCKLIST: 'the model stopped on a blocked-term filter',
  PROHIBITED_CONTENT: 'the model stopped on a prohibited-content filter',
  SPII: 'the model stopped because it detected sensitive personal information',
  OTHER: 'the model stopped for an unspecified reason'
};

const parseResponse = (response) => {
  const candidate = response && Array.isArray(response.candidates) ? response.candidates[0] : null;
  if (!candidate) throw new Error('The model returned no answer.');
  const finish = String(candidate.finishReason || 'STOP').toUpperCase();
  if (finish !== 'STOP' && finish !== 'FINISH_REASON_UNSPECIFIED') {
    const err = new Error(FINISH_MESSAGES[finish] || `the model stopped: ${finish}`);
    err.code = `MODEL_FINISH_${finish}`;
    throw err;
  }
  const parts = (candidate.content && candidate.content.parts) || [];
  const text = parts.map(p => (p && typeof p.text === 'string' ? p.text : '')).join('').trim();
  if (!text) throw new Error('The model returned an empty answer.');
  try {
    return JSON.parse(text);
  } catch (e) {
    // The text is the model's answer and may quote the chart, so it is NEVER
    // included in the error.
    throw new Error('The model did not return the JSON it was asked for.');
  }
};

const usageOf = (response) => {
  const u = (response && response.usageMetadata) || {};
  return {
    inputTokens: typeof u.promptTokenCount === 'number' ? u.promptTokenCount : null,
    outputTokens: typeof u.candidatesTokenCount === 'number' ? u.candidatesTokenCount : null
  };
};

// ── clients ───────────────────────────────────────────────────────────────
// Keyed by project+location: nothing talks to Google until the first real
// call, and a different location gets its own client rather than silently
// reusing one built for somewhere else.
//
// `enterprise: true` is the flag the pinned @google/genai (2.28.0) documents
// as "recommended instead" of the older `vertexai: true`. Both select the same
// Vertex / Gemini Enterprise Agent Platform service; passing both with
// different values is an error, so only this one is passed.
const clients = new Map();
const clientFor = (project, location) => {
  const key = `${project}::${location}`;
  if (!clients.has(key)) clients.set(key, new GoogleGenAI({ enterprise: true, project, location }));
  return clients.get(key);
};

const storages = new Map();
const storageFor = (project) => {
  if (!storages.has(project)) storages.set(project, new Storage({ projectId: project }));
  return storages.get(project);
};

// ── the transport ─────────────────────────────────────────────────────────
const createTransport = ({ getClient = clientFor, getStorage = storageFor } = {}) =>
  async ({ purpose, input, schema, project, location, modelId, bucket }) => {
    const bucketRef = getStorage(project).bucket(bucket);
    let staged = [];
    try {
      const prepared = (input && input.documents && input.documents.length)
        ? await stageDocuments(bucketRef, input.documents)
        : { staged: [], parts: [] };
      staged = prepared.staged;
      const contents = buildContents({ input, documentParts: prepared.parts });

      const response = await getClient(project, location).models.generateContent({
        model: modelId,
        contents,
        config: {
          systemInstruction: SYSTEM_INSTRUCTIONS[purpose] || SYSTEM_INSTRUCTIONS.document_extraction,
          responseMimeType: 'application/json',
          responseSchema: responseSchemaFor(schema),
          // Low, not zero: this is a reading task and a deterministic-looking
          // sampler is not the same thing as a correct answer.
          temperature: 0.1,
          maxOutputTokens: (input && input.maxOutputTokens) || undefined
          // NO `tools` KEY, EVER. See the header.
        }
      });
      const value = parseResponse(response);
      const usage = usageOf(response);
      return { value, usage };
    } catch (e) {
      // The usage is attached where the SDK gave us one, so a failed call can
      // still be audited with its size (B7).
      if (e && !e.usage) e.usage = null;
      throw e;
    } finally {
      // DELETED AFTER SUCCESS **AND** AFTER FAILURE. A staged document left
      // behind on a failure is PHI sitting in a bucket, and the failure path
      // is precisely the one nobody tests by hand. The lifecycle rule is a
      // backstop for a crash, not the plan.
      await Promise.allSettled(staged.map(f => f.delete({ ignoreNotFound: true })));
    }
  };

// Token counting for the packet planner (C4). Same client, no generation.
const createCountTokens = ({ getClient = clientFor } = {}) =>
  async ({ contents, project, location, modelId }) => {
    const r = await getClient(project, location).models.countTokens({ model: modelId, contents });
    return (r && typeof r.totalTokens === 'number') ? r.totalTokens : null;
  };

// ── the daily boundary checks (modelEngine B3) ────────────────────────────
// These live here, beside the generation call, because they are questions
// about the same Google project this file talks to. modelEngine.js decides
// what a failure MEANS; this only reports what Google said.
//
// Neither check is a nice-to-have. Caching on means prompts — patient data —
// are held by Google for hours. A staging bucket that is public, or that never
// deletes, means a document outlives the call it was staged for.
const US_LOCATIONS = new Set(['US', 'US-CENTRAL1', 'US-EAST1', 'US-EAST4', 'US-EAST5', 'US-SOUTH1', 'US-WEST1', 'US-WEST2', 'US-WEST3', 'US-WEST4']);

const createLiveChecks = ({ getStorage = storageFor, getAuth } = {}) =>
  async ({ projectId, location, bucket }) => {
    const failures = [];

    // (a) Data caching must be off for the project.
    try {
      const auth = getAuth
        ? getAuth()
        : new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
      const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/cacheConfig`;
      const client = await auth.getClient();
      const res = await client.request({ url });
      const disabled = res && res.data && res.data.disableCache === true;
      if (!disabled) {
        failures.push('Gemini data caching is NOT disabled for this project — prompts would be retained, so nothing is sent until cacheConfig reports disableCache: true');
      }
    } catch (e) {
      failures.push('the Gemini cacheConfig check could not be completed, so data caching cannot be confirmed off');
    }

    // (b) The staging bucket must exist, be US, be private, and expire fast.
    try {
      const b = getStorage(projectId).bucket(bucket);
      const [exists] = await b.exists();
      if (!exists) {
        failures.push(`the staging bucket "${bucket}" does not exist`);
      } else {
        const [meta] = await b.getMetadata();
        const loc = String(meta.location || '').toUpperCase();
        if (!US_LOCATIONS.has(loc)) failures.push(`the staging bucket is in "${loc}", which is not a US location`);
        const pap = meta.iamConfiguration && meta.iamConfiguration.publicAccessPrevention;
        if (pap !== 'enforced') failures.push('the staging bucket does not have public access prevention enforced');
        const ubla = meta.iamConfiguration && meta.iamConfiguration.uniformBucketLevelAccess;
        if (!(ubla && ubla.enabled)) failures.push('the staging bucket does not have uniform bucket-level access enabled');
        const rules = (meta.lifecycle && meta.lifecycle.rule) || [];
        const expires = rules.some(r =>
          r && r.action && r.action.type === 'Delete' &&
          r.condition && typeof r.condition.age === 'number' && r.condition.age <= 1);
        if (!expires) failures.push('the staging bucket has no lifecycle rule deleting objects at 1 day or less');
      }
    } catch (e) {
      failures.push('the staging bucket could not be inspected, so its retention and access settings cannot be confirmed');
    }

    return { ok: failures.length === 0, failures };
  };

module.exports = {
  transport: createTransport(),
  countTokens: createCountTokens(),
  liveChecks: createLiveChecks(),
  createTransport, createCountTokens, createLiveChecks,
  responseSchemaFor, buildContents, parseResponse, usageOf, sectionText,
  splitPdf, stageDocuments, stagedName,
  SYSTEM_INSTRUCTIONS, MAX_FILE_BYTES, SPLIT_PAGE_STEP, FINISH_MESSAGES
};
