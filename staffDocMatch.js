'use strict';
// ============================================================================
// staffDocMatch.js — what a staff document IS, read two ways (owner, 2026-11-15)
// ============================================================================
// "Smart matches and AI scans to confirm, to ensure it's 100% correct." A
// paper W-9 the office uploads should count as the W-9 Pay Setup asks for.
// Before it does, the document is read twice, independently:
//
//   SMART MATCH  the words printed on it (the PDF's text, or OCR inside this
//                container for a photo or a fax), against fixed titles the
//                government prints on each form. Deterministic, auditable, and
//                it cannot invent anything: it either finds the title or not.
//   AI SCAN      Gemini on Vertex, under the Google Cloud BAA (modelEngine.js),
//                classifying the document into a CLOSED list of kinds. When
//                the model boundary is not satisfied the scan says "not run",
//                and "not run" is never read as agreement.
//
// NEITHER READ FULFILS ANYTHING. A person in the office confirms the kind and
// types what the form says (routes/payroll.js, "Mark On File"). The reads are
// a check on that person: they say "both checks agree this is a W-9", or
// "you filed this as a W-4, but it reads as a W-9". Two independent reads and
// a human confirming is what makes it certain; no reader is 100% alone.
//
// PURE apart from textOf(), which opens the file. Nothing here stores, logs or
// sends anything; the AI call is handed in (aiRead), so this module never
// reaches the model itself.
// ============================================================================

// The kinds a staff document can be matched to, and the requirement each meets.
// `form` is the Pay Setup form it can be put on file for (routes/payroll.js).
const KINDS = Object.freeze({
  w9: { label: 'Form W-9', form: 'w9' },
  w4: { label: 'Form W-4', form: 'w4' },
  g4: { label: 'Georgia Form G-4', form: 'g4' },
  state_cert: { label: 'State withholding certificate', form: 'state-cert' },
  i9: { label: 'Form I-9', form: 'i9' },
  w8ben: { label: 'Form W-8BEN', form: 'w8ben' },
  ssn_card: { label: 'Social Security card', form: null },
  id_document: { label: 'Photo ID', form: null },
  work_authorization: { label: 'Work authorization document', form: null },
  direct_deposit: { label: 'Direct deposit form', form: null }
});
const KIND_KEYS = Object.freeze(Object.keys(KINDS));

// Fixed titles, as printed. Each needs its form's own words, not just a
// number: "W-9" alone appears in other forms' instructions ("give us a W-9"),
// and an I-9 instruction sheet names List A documents. Order matters: the
// most specific titles are tried first.
const MARKERS = [
  { kind: 'w8ben', all: [/W-?8\s*BEN\b/i, /Certificate of Foreign Status of Beneficial Owner/i] },
  { kind: 'w9', all: [/\bW-?9\b/i, /Request for Taxpayer\s+Identification Number/i] },
  // Georgia's G-4 and the I-9 before the W-4: a G-4 page can mention the W-4.
  { kind: 'g4', all: [/\bG-?4\b/i, /State of Georgia|Georgia Department of Revenue/i, /Withholding/i] },
  { kind: 'i9', all: [/\bI-?9\b/i, /Employment Eligibility Verification/i] },
  { kind: 'w4', all: [/\bW-?4\b/i, /Employee\W{0,2}s\W{0,2} Withholding (?:Allowance )?Certificate/i] },
  { kind: 'state_cert', all: [/Withholding (?:Exemption |Allowance )?Certificate/i, /State of|Department of (?:Revenue|Taxation)/i] },
  { kind: 'ssn_card', all: [/Social Security/i, /This number has been established for/i] },
  { kind: 'work_authorization', all: [/Employment Authorization/i, /United States of America/i] },
  { kind: 'direct_deposit', all: [/Direct Deposit/i, /Routing (?:Number|No\.?)|ABA/i] },
  { kind: 'id_document', all: [/Driver\W{0,2}s? Licen[sc]e|Identification Card|\bID Card\b/i, /\bDOB\b|Date of Birth|Exp(?:ires|\.)?\b/i] }
];

const squash = (s) => String(s || '').replace(/\s+/g, ' ');

/** The smart match: { kind, evidence } from the printed words, or null. */
function smartMatch(text) {
  const t = squash(text);
  if (!t.trim()) return null;
  for (const m of MARKERS) {
    const hits = m.all.map(re => (t.match(re) || [])[0]);
    if (hits.every(Boolean)) {
      return { kind: m.kind, evidence: `Reads "${hits.join('" and "').slice(0, 160)}"` };
    }
  }
  return null;
}

// The boxes the office copies from a paper form (owner, 2026-11-15: "pre-fill;
// office checks"). The AI scan reads them so the office checks rather than
// types. NONE IS A SECRET NUMBER: no SSN, TIN, A-number, passport or bank
// number is ever asked for or kept; the person enters those in My GFC. This
// list is also the allow-list: any other key the model returns is dropped.
const PREFILL_FIELDS = Object.freeze({
  name: 'string', businessName: 'string', taxClass: 'string', tinType: 'string',
  filingStatus: 'string', multipleJobs: 'boolean', dependentsAmount: 'string', otherIncome: 'string',
  deductions: 'string', extraWithholding: 'string', exempt: 'boolean',
  allowances: 'string', dependentAllowances: 'string', additionalAllowances: 'string',
  citizenship: 'string', firstDay: 'string', signedName: 'string', signedOn: 'string'
});
// Anything that looks like a secret number is refused even in an allowed box.
const SECRET_LIKE = /\d{3}\D?\d{2}\D?\d{4}|\d{2}-?\d{7}|\b[A-Z]?\d{8,}\b/i;

// What the AI scan is asked for. A closed list, so it can only name a kind
// this app knows, or "other", plus the printed boxes above.
const AI_SCHEMA = Object.freeze({
  fields: {
    kind: { type: 'string', enum: [...KIND_KEYS, 'other'] },
    confidence: { type: 'number' },
    nameOnForm: { type: 'string' },
    formRevision: { type: 'string' },
    fields: {
      type: 'object',
      items: Object.fromEntries(Object.entries(PREFILL_FIELDS).map(([k, t]) => [k, { type: t }])),
      description: 'Copy only what is printed or handwritten in these boxes, exactly as written. Leave a box out if it is blank or unreadable. Never return a Social Security number, taxpayer ID, EIN, A-number, passport, document or bank number.'
    }
  }
});

/** Only the allowed, non-secret boxes, trimmed. */
function cleanFields(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, t] of Object.entries(PREFILL_FIELDS)) {
    const v = raw[k];
    if (t === 'boolean' && typeof v === 'boolean') out[k] = v;
    else if (t === 'string' && (typeof v === 'string' || typeof v === 'number')) {
      const s = String(v).trim().slice(0, 160);
      if (s && !SECRET_LIKE.test(s)) out[k] = s;
    }
  }
  // Dates as the form fields take them.
  for (const k of ['signedOn', 'firstDay']) if (out[k] && !/^\d{4}-\d{2}-\d{2}$/.test(out[k])) {
    const m = out[k].match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
    if (m) out[k] = `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`; else delete out[k];
  }
  return out;
}

/**
 * The AI scan. `aiRead({ purpose, input, schema })` is the model engine's
 * invoke, handed in. Returns { status: 'ok', kind, confidence, nameOnForm } or
 * { status: 'not_run', reason }. A refusal, a failure or an answer outside the
 * list is "not run" with the reason, never a guess.
 */
async function aiScan({ bytes, mimeType, aiRead }) {
  if (typeof aiRead !== 'function') return { status: 'not_run', reason: 'The AI check is not connected.' };
  try {
    const r = await aiRead({ input: { mimeType, bytes }, schema: AI_SCHEMA });
    const out = (r && (r.proposal || r.output || r)) || {};
    const kind = KIND_KEYS.includes(out.kind) ? out.kind : out.kind === 'other' ? 'other' : null;
    if (!kind) return { status: 'not_run', reason: 'The AI check gave no usable answer.' };
    const confidence = typeof out.confidence === 'number' && out.confidence >= 0 && out.confidence <= 1 ? out.confidence : null;
    return { status: 'ok', kind, confidence, nameOnForm: typeof out.nameOnForm === 'string' ? out.nameOnForm.slice(0, 120) : null, fields: cleanFields(out.fields) };
  } catch (e) {
    const reason = e && e.code === 'MODEL_BOUNDARY_REFUSED' ? 'The AI check is not switched on yet (Vertex setup).' : `The AI check could not run: ${(e && e.message) || 'unknown error'}`;
    return { status: 'not_run', reason: String(reason).slice(0, 200) };
  }
}

/**
 * The two reads side by side.
 *   agree      both named the same kind
 *   disagree   they named different kinds
 *   one_read   only one of them could say (the other found nothing or did not run)
 *   unknown    neither could say
 * `filedAs` is the kind the document was filed under. A read that names a
 * different kind sets `filedAsDiffers`, so the office sees it before using it.
 */
function verdict(smart, ai, filedAs) {
  const a = smart && smart.kind ? smart.kind : null;
  const b = ai && ai.status === 'ok' && ai.kind !== 'other' ? ai.kind : null;
  let v;
  if (a && b) v = a === b ? 'agree' : 'disagree';
  else if (a || b) v = 'one_read';
  else v = 'unknown';
  const readsAs = v === 'agree' || v === 'one_read' ? (a || b) : null;
  return { verdict: v, readsAs, filedAsDiffers: !!(readsAs && filedAs && readsAs !== filedAs) || (v === 'disagree' && !!filedAs && (a !== filedAs || b !== filedAs)) };
}

// What the office reads beside the document.
function summary(m, filedAs) {
  if (!m) return null;
  const label = (k) => (KINDS[k] && KINDS[k].label) || k;
  const aiNote = m.ai && m.ai.status === 'not_run' ? ` AI check not run: ${m.ai.reason}` : '';
  if (m.verdict === 'agree') return `Reads as ${label(m.readsAs)}. Both checks agree.${m.filedAsDiffers ? ` It was filed as ${label(filedAs)}.` : ''}`;
  if (m.verdict === 'disagree') return `The checks disagree: the printed title reads as ${label(m.smart.kind)}, the AI check as ${label(m.ai.kind)}. Look at the document before using it.`;
  if (m.verdict === 'one_read') return `Reads as ${label(m.readsAs)} (${m.smart && m.smart.kind ? 'printed title' : 'AI check'} only).${aiNote}${m.filedAsDiffers ? ` It was filed as ${label(filedAs)}.` : ''}`;
  return `Could not tell what this document is.${aiNote}`;
}

/**
 * Read one stored document. `textOf` and `aiRead` are handed in so tests run
 * without a PDF library, OCR or a model. Returns the record kept on the row:
 * { smart, ai, verdict, readsAs, filedAsDiffers, text: 'text'|'ocr'|'none', at }.
 */
async function matchDocument({ bytes, mimeType, filedAs, textOf, aiRead, at }) {
  let read = { text: '', source: 'none' };
  try { read = (await textOf({ bytes, mimeType })) || read; } catch (e) { read = { text: '', source: 'none', notice: e.message }; }
  const smart = smartMatch(read.text);
  const ai = await aiScan({ bytes, mimeType, aiRead });
  const v = verdict(smart, ai, filedAs);
  return { smart, ai, ...v, text: read.source || 'none', at };
}

/**
 * The words in a stored file: the PDF's own text, else OCR (in this
 * container). Uses the readers the client documents already use.
 */
async function textOf({ bytes, mimeType, createWorker }) {
  const packet = require('./welcomePacketImport');
  const ocr = require('./documentOcr');
  let runs = [];
  if (!ocr.isImageMime(mimeType)) {
    try {
      const { PDFDocument } = require('pdf-lib');
      const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
      runs = await packet.extractRuns(pdf);
    } catch (e) { runs = []; }
  }
  if (runs.length) return { text: runs.map(r => r.text).join(' '), source: 'text' };
  try {
    // Tesseract reports a broken image by throwing inside its worker, which is
    // an uncaught exception unless an error handler is given. A read that runs
    // after the upload has been answered must never take the server down, so
    // the handler swallows it and the read rejects as "could not read".
    const make = createWorker || ((lang, oem, opts) => require('tesseract.js').createWorker(lang, oem, { ...(opts || {}), errorHandler: () => {} }));
    const r = await ocr.ocrDocumentRuns({ bytes, mimeType, createWorker: make });
    if (r.runs && r.runs.length) return { text: r.runs.map(x => x.text).join(' '), source: 'ocr' };
    return { text: '', source: 'none', notice: r.notice || null };
  } catch (e) {
    return { text: '', source: 'none', notice: e.message };
  }
}

module.exports = { KINDS, KIND_KEYS, MARKERS, AI_SCHEMA, PREFILL_FIELDS, cleanFields, smartMatch, aiScan, verdict, summary, matchDocument, textOf };
