// modelEngine.js — the ONE place a model is called (2026-09-22; moved to
// Gemini on Vertex AI 2026-10-12 by owner decision).
//
// `GFC_Clinical_Completeness_Spec_v1.md` §10.3 is normative, not advisory, and
// every rule it sets is enforced here rather than described:
//
//   • Inside the BAA boundary only — Gemini on Vertex AI under the Google
//     Cloud BAA, reached through Workload Identity Federation, and no other
//     model API. Bedrock was removed on 2026-10-12: it is not a fallback, it
//     is gone, and a guard in test/model_engine.test.js fails the build if it
//     or a second Gemini call site comes back.
//   • ZERO DATA RETENTION configured explicitly AND PROVEN LIVE. §10.3 makes
//     this a STOP condition, so this module REFUSES TO RUN without it rather
//     than warning — and "configured" is not enough on its own, because the
//     setting is a claim about an account and the account is what has to be
//     true. The daily live checks (B3) are what make it a fact.
//   • Propose, never commit. Nothing returned here reaches a record on its own.
//   • Unverified until touched.
//   • One audit entry per invocation — INCLUDING ONE THAT FAILED, because the
//     PHI was sent either way and an invocation nobody recorded is one nobody
//     can account for.
//   • No PHI in logs, prompts or error traces that leave the boundary.
//
// WHY ONE ENGINE AND NOT TWO. Session AI.1 (dictation → note), document
// extraction, and the comprehensive chart review are the same shape: take an
// input, return a structured object against a schema, for a named purpose. Two
// engines means two places the boundary rules are implemented, and the second
// one is where they get implemented slightly differently — which for a rule
// whose failure mode is PHI leaving the boundary is not a risk worth taking.
// §10.3's own wording is "applies to EVERY AI feature".
//
// `configured` MEANS THE SETTINGS PARSE AND THE DAILY CHECKS PASSED. It is
// still not a promise that the next call succeeds; only a call proves that,
// and this module never claims the first is the second. That distinction is
// the one that let a narrowed OAuth token sit behind a green "OpenEMR
// connected" for weeks.
'use strict';

const fs = require('fs');

// Every purpose a model may be invoked for is declared. An undeclared purpose
// is refused — a feature added next session does not silently inherit a
// boundary-crossing capability because somebody passed a new string.
const PURPOSES = Object.freeze({
  DICTATION_TO_NOTE: 'dictation_to_note',
  DOCUMENT_EXTRACTION: 'document_extraction',
  DOCUMENT_CLASSIFICATION: 'document_classification',
  CHART_REVIEW: 'chart_review',
  CHART_REVIEW_MERGE: 'chart_review_merge',
  RECORDS_EXTRACTION: 'records_extraction'
});

// What a caller does with what came back. This is the evaluation signal §10.3
// asks for, and it is the only honest measure of whether a feature helps.
const OUTCOMES = Object.freeze({
  ACCEPTED: 'accepted',
  EDITED: 'edited',
  DISCARDED: 'discarded'
});

// How an invocation ENDED, which is a different question from what a person
// then did with it. A failed call still sent the PHI, so it still gets a row.
const RESULTS = Object.freeze({
  OK: 'ok',
  CALL_FAILED: 'call_failed',
  OUTPUT_INVALID: 'output_invalid'
});

const REQUIRED_SETTINGS = Object.freeze([
  { key: 'VERTEX_PROJECT_ID', why: 'which Google Cloud project the call is billed and logged to — it must be the one the Google Cloud BAA was accepted for' },
  { key: 'VERTEX_LOCATION', why: 'which region processes the data; it must be "us", never "global", so processing stays in the United States' },
  { key: 'VERTEX_MODEL_ID', why: 'the exact model id, so what ran is recorded rather than inferred' },
  { key: 'VERTEX_STAGING_BUCKET', why: 'where a document is staged for the duration of one call; it must be a US bucket that deletes its objects within a day' },
  { key: 'VERTEX_ZERO_DATA_RETENTION', why: 'ZDR must be explicitly confirmed — §10.3 makes this a stop condition, not a preference' },
  { key: 'GOOGLE_APPLICATION_CREDENTIALS', why: 'the Workload Identity Federation config the server federates with; a static service-account key is refused, not used' }
]);

// The only location patient data may be processed in. 'global' routes to
// wherever Google has capacity, which is the one thing a US-only commitment
// cannot allow.
const REQUIRED_LOCATION = 'us';

// A model whose name says preview, exp or experimental never sees patient
// data: those are not covered by the same support and deprecation promises,
// and can change under us without notice.
const UNRELEASED = /(^|[-_.])(preview|exp|experimental)([-_.]|$)/i;

// How long a live check stands before it has to be re-proven. The checks are
// cheap and the thing they prove is an account setting somebody could change
// in the console at any time, so a day is the longest it is honest to trust.
const CHECK_TTL_MS = 24 * 60 * 60 * 1000;

const truthy = (v) => v === true || ['1', 'true', 'yes', 'on'].includes(String(v || '').trim().toLowerCase());

// Is the credentials file a federated config, or a static key wearing one's
// clothes? §10.3 requires federation, and a key file on disk is exactly what
// it excludes. ONLY THE `type` FIELD IS READ, and the file's contents never
// reach a log, an error or a status payload — a credentials file that ends up
// in a diagnostic is the leak this check exists to prevent.
const credentialKind = (p) => {
  const file = String(p || '').trim();
  if (!file) return { kind: null, note: null };
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    // WHY the file could not be read is deliberately not echoed: the message
    // can carry the path, and on some failures the content.
    return { kind: null, note: 'unreadable' };
  }
  const type = parsed && typeof parsed.type === 'string' ? parsed.type : null;
  return { kind: type, note: null };
};

// Names EVERY missing piece, not the first — the pattern `driveStatus()`
// settled, because a setup that reports one blocker at a time takes as many
// restarts as there are blockers.
//
// `checkState` is the in-memory result of the daily live checks (B3). It is
// passed in rather than read from anywhere, so this function stays pure and a
// test can pin every combination of settings and check state.
const status = (env, checkState) => {
  const e = env || process.env || {};
  const missing = [];
  for (const s of REQUIRED_SETTINGS) {
    if (!String(e[s.key] || '').trim()) missing.push(s);
  }
  const named = (key) => missing.some(m => m.key === key);
  const blockers = missing.map(m => `${m.key} is not set — ${m.why}`);

  const zdr = truthy(e.VERTEX_ZERO_DATA_RETENTION);
  if (!named('VERTEX_ZERO_DATA_RETENTION') && !zdr) {
    blockers.push('VERTEX_ZERO_DATA_RETENTION is set but not affirmative — ZDR must be explicitly ON, and this refuses to run until it is');
  }

  const location = String(e.VERTEX_LOCATION || '').trim().toLowerCase();
  if (!named('VERTEX_LOCATION') && location !== REQUIRED_LOCATION) {
    blockers.push(`VERTEX_LOCATION is "${location}" — patient data is processed in "${REQUIRED_LOCATION}" only, never "global" or another region`);
  }

  const modelId = String(e.VERTEX_MODEL_ID || '').trim();
  if (!named('VERTEX_MODEL_ID') && UNRELEASED.test(modelId)) {
    blockers.push(`VERTEX_MODEL_ID is "${modelId}", which names a preview or experimental model — only released models see patient data`);
  }

  const creds = named('GOOGLE_APPLICATION_CREDENTIALS')
    ? { kind: null, note: null }
    : credentialKind(e.GOOGLE_APPLICATION_CREDENTIALS);
  if (!named('GOOGLE_APPLICATION_CREDENTIALS')) {
    if (creds.note === 'unreadable') {
      blockers.push('GOOGLE_APPLICATION_CREDENTIALS does not point at a readable JSON file — the Workload Identity Federation config must be mounted into the container');
    } else if (creds.kind === 'service_account') {
      blockers.push('GOOGLE_APPLICATION_CREDENTIALS is a static service-account key — §10.3 requires Workload Identity Federation, so a key file is refused rather than used');
    } else if (creds.kind !== 'external_account') {
      blockers.push(`GOOGLE_APPLICATION_CREDENTIALS is a "${creds.kind || 'unknown'}" credential — only "external_account" (Workload Identity Federation) is accepted`);
    }
  }

  // THE LIVE CHECKS ARE PART OF THE BOUNDARY, not a diagnostic beside it.
  // Caching off and the staging bucket's shape are account settings, and an
  // account setting that was true yesterday is a claim about today.
  const check = checkState || null;
  const checkedAt = check && check.at ? Date.parse(check.at) : NaN;
  const stale = !check || Number.isNaN(checkedAt) || (Date.now() - checkedAt) > CHECK_TTL_MS;
  if (stale) {
    blockers.push('the daily Google-side checks (data caching off, staging bucket shape) have not passed in the last 24 hours — nothing is sent until they do');
  } else if (!check.ok) {
    for (const f of (check.failures || ['a Google-side check failed'])) blockers.push(f);
  }

  return {
    // The settings parse, nothing is contradictory, and the daily checks
    // passed. NOT a promise the next call succeeds.
    configured: blockers.length === 0,
    zeroDataRetention: zdr,
    projectId: String(e.VERTEX_PROJECT_ID || '') || null,
    location: location || null,
    modelId: modelId || null,
    stagingBucket: String(e.VERTEX_STAGING_BUCKET || '') || null,
    // The KIND of credential, never the credential.
    credentialType: creds.kind || null,
    usesStaticKeys: creds.kind === 'service_account',
    checks: check
      ? { at: check.at, ok: !!check.ok, stale, failures: check.failures || [] }
      : { at: null, ok: false, stale: true, failures: [] },
    blockers,
    // Said plainly so no session mistakes one for the other.
    proof: 'configured means these settings parse AND the daily Google-side checks passed. Only a live invocation proves Google accepts this identity for this model.'
  };
};

// A boundary refusal is its own error type, so a caller cannot catch it
// alongside an ordinary failure and retry into the boundary.
class BoundaryRefusal extends Error {
  constructor(message, blockers) {
    super(message);
    this.name = 'BoundaryRefusal';
    this.code = 'MODEL_BOUNDARY_REFUSED';
    this.blockers = blockers || [];
  }
}

// PHI must not reach a log line, a prompt echo or an error trace. Session 5.5
// scrubs `console.*` process-wide; this is the second layer, because an error
// object handed back to a caller does not go through console at all.
const SCRUBBED = '[redacted]';
// A Medicare Beneficiary Identifier, position by position — the same shape
// `documentTemplates.RULES.mbi` reads, kept here as a scrubbing pattern
// because an MBI in an error message is as much a leak as one in a log.
// C = a letter excluding S, L, O, I, B, Z. N = a digit. A = either.
const MBI = /\b[0-9][ACDEFGHJKMNPQRTUVWXY][0-9ACDEFGHJKMNPQRTUVWXY][0-9][ACDEFGHJKMNPQRTUVWXY][0-9ACDEFGHJKMNPQRTUVWXY][0-9][ACDEFGHJKMNPQRTUVWXY][ACDEFGHJKMNPQRTUVWXY][0-9][0-9]\b/g;
const scrubForLog = (value) => {
  if (value === null || value === undefined) return value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    return value
      .replace(/\b[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, SCRUBBED)
      .replace(/\b\d{3}-\d{2}-\d{4}\b/g, SCRUBBED)
      .replace(/\b\d{4}-\d{2}-\d{2}\b/g, SCRUBBED)
      // A date written the way a person writes one. MM/DD/YYYY and M/D/YY
      // both appear on every document this app reads, and a date of birth is
      // the identifier most likely to be echoed back in a provider's error.
      .replace(/\b\d{1,2}\/\d{1,2}\/(?:\d{4}|\d{2})\b/g, SCRUBBED)
      .replace(MBI, SCRUBBED)
      .replace(/\b(?:\+?1[-. ]?)?\(?\d{3}\)?[-. ]?\d{3}[-. ]?\d{4}\b/g, SCRUBBED);
  }
  if (Array.isArray(value)) return value.map(scrubForLog);
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrubForLog(v);
    return out;
  }
  return SCRUBBED;
};

// Is the SCHEMA itself usable? Asked BEFORE anything is sent (B5).
//
// THE BUG THIS FIXES: a purpose declared with no schema sent the PHI first and
// failed afterwards, because the output check ran after the transport. A
// request that was never going to be accepted must not cross the boundary to
// find that out.
const validateSchemaShape = (schema, where = 'schema') => {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return `${where} is required — an unvalidated model output is not a result`;
  }
  const fields = schema.fields;
  if (!fields || typeof fields !== 'object' || Array.isArray(fields) || !Object.keys(fields).length) {
    return `${where} declares no fields — nothing would be read out of the answer`;
  }
  for (const [key, def] of Object.entries(fields)) {
    if (!def || typeof def !== 'object') return `${where}.${key} has no definition`;
    const type = def.type;
    if (!['string', 'number', 'boolean', 'array', 'object'].includes(type)) {
      return `${where}.${key} has an unsupported type "${type}"`;
    }
    // An array is either rows (a field map in `items`) or scalars
    // (`itemType`). BOTH are needed: a review's findings are rows, and its
    // "questions for the clinician" and "what I could not read" are plain
    // strings — expressing those as single-key rows would put a wrapper
    // object in front of every sentence a clinician reads.
    if (type === 'array' && ['string', 'number', 'boolean'].includes(def.itemType)) continue;
    if (type === 'array' || type === 'object') {
      const nested = validateSchemaShape(def.items ? { fields: def.items } : null, `${where}.${key}.items`);
      if (nested) return nested;
    }
  }
  return null;
};

// Validate what came back against the schema the caller asked for. A model
// returning something shaped wrong is a failure, not a value to coerce — a
// coerced field is a wrong field that reads as plausibly as a right one.
//
// UNDECLARED KEYS ARE DROPPED AT EVERY LEVEL, not just the top one. The schema
// is an allow-list, the same rule the intake fields and the draft payload
// follow, and an allow-list that stops being one inside a nested object is a
// way for a model to put something in a record that nobody declared.
const validateAgainstSchema = (value, schema, where = '') => {
  const shapeProblem = validateSchemaShape(schema, where || 'schema');
  if (shapeProblem) return { error: shapeProblem };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: 'Model returned no object' };
  const fields = schema.fields;
  const out = {};
  const problems = [];
  const at = (key) => (where ? `${where}.${key}` : key);

  for (const [key, def] of Object.entries(fields)) {
    const raw = value[key];
    const absent = raw === undefined || raw === null || raw === ''
      || (def.type === 'array' && Array.isArray(raw) && !raw.length);
    if (absent) {
      if (def.required) problems.push(`${at(key)} is required and was not returned`);
      continue;
    }
    if (def.type === 'string') {
      if (typeof raw !== 'string') { problems.push(`${at(key)} must be a string`); continue; }
      if (def.maxLength && raw.length > def.maxLength) {
        problems.push(`${at(key)} is longer than the ${def.maxLength} characters declared`);
        continue;
      }
    }
    if (def.type === 'number' && typeof raw !== 'number') { problems.push(`${at(key)} must be a number`); continue; }
    if (def.type === 'boolean' && typeof raw !== 'boolean') { problems.push(`${at(key)} must be true or false`); continue; }
    if (def.enum && !def.enum.includes(raw)) { problems.push(`${at(key)} is not one of the permitted values`); continue; }

    if (def.type === 'array') {
      if (!Array.isArray(raw)) { problems.push(`${at(key)} must be a list`); continue; }
      if (def.maxItems && raw.length > def.maxItems) {
        problems.push(`${at(key)} returned more than the ${def.maxItems} items declared`);
        continue;
      }
      const rows = [];
      let bad = null;
      const scalar = ['string', 'number', 'boolean'].includes(def.itemType) ? def.itemType : null;
      raw.forEach((row, i) => {
        if (bad) return;
        if (scalar) {
          // A scalar of the wrong type is dropped rather than coerced: a
          // number where a sentence belongs is not a sentence.
          if (typeof row !== scalar) { bad = `${at(key)}[${i}] must be a ${scalar}`; return; }
          if (scalar === 'string') {
            const trimmed = row.trim();
            if (!trimmed) return;
            if (def.maxLength && trimmed.length > def.maxLength) { bad = `${at(key)}[${i}] is longer than the ${def.maxLength} characters declared`; return; }
            rows.push(trimmed);
            return;
          }
          rows.push(row);
          return;
        }
        const checked = validateAgainstSchema(row, { fields: def.items }, `${at(key)}[${i}]`);
        if (checked.error) { bad = checked.error; return; }
        rows.push(checked.value);
      });
      if (bad) { problems.push(bad); continue; }
      if (def.minItems && rows.length < def.minItems) {
        problems.push(`${at(key)} returned fewer than the ${def.minItems} items required`);
        continue;
      }
      out[key] = rows;
      continue;
    }

    if (def.type === 'object') {
      const checked = validateAgainstSchema(raw, { fields: def.items }, at(key));
      if (checked.error) { problems.push(checked.error); continue; }
      out[key] = checked.value;
      continue;
    }

    out[key] = raw;
  }
  return problems.length ? { error: problems.join('; ') } : { value: out };
};

// The one entry point.
//
// `invoke` deliberately takes a TRANSPORT rather than constructing one: it
// keeps this module pure and testable, and it means the Vertex client is
// built in exactly one place.
const createEngine = ({ env, transport, liveChecks, logActivity, now } = {}) => {
  // The daily checks' result, held in memory only. It is not persisted on
  // purpose: a restart should re-prove the boundary rather than inherit
  // yesterday's word for it.
  let checkState = null;

  const read = () => status(env, checkState);

  // Run the Google-side checks and remember the answer. Called at boot and
  // every 24 hours by the server; safe to call at any time.
  const runLiveChecks = async () => {
    const at = (now && now()) || new Date().toISOString();
    if (typeof liveChecks !== 'function') {
      checkState = { at, ok: false, failures: ['no Google-side check routine is wired, so the boundary cannot be proven'] };
      return checkState;
    }
    const e = env || process.env || {};
    try {
      const r = await liveChecks({
        projectId: String(e.VERTEX_PROJECT_ID || '').trim(),
        location: String(e.VERTEX_LOCATION || '').trim().toLowerCase(),
        bucket: String(e.VERTEX_STAGING_BUCKET || '').trim()
      });
      const failures = (r && Array.isArray(r.failures)) ? r.failures : [];
      checkState = { at, ok: !!(r && r.ok) && !failures.length, failures };
    } catch (err) {
      // The reason is scrubbed: a Google error can quote a bucket or object
      // name back, and an object name is the one place a document could be
      // identified.
      checkState = { at, ok: false, failures: [`the Google-side checks could not be run: ${scrubForLog(String(err && err.message || err))}`] };
    }
    return checkState;
  };

  const invoke = async ({ purpose, input, schema, actor, patientId, feature, pass, sourceIds }) => {
    const st = read();
    if (!st.configured) {
      // Refused BEFORE the input is touched, so nothing is prepared, held in
      // memory or logged for a call that was never going to be allowed.
      throw new BoundaryRefusal(
        'The model boundary is not satisfied, so nothing was sent.',
        st.blockers
      );
    }
    if (!Object.values(PURPOSES).includes(purpose)) {
      throw new BoundaryRefusal(`"${purpose}" is not a declared model purpose.`, [
        'A feature must declare its purpose here before it can invoke a model.'
      ]);
    }
    if (typeof transport !== 'function') {
      throw new BoundaryRefusal('No model transport is wired.', [
        'Vertex AI is not connected — the engine is built and inert until it is.'
      ]);
    }
    // B5. THE SCHEMA IS CHECKED BEFORE THE PHI MOVES. A purpose with no usable
    // schema is a programming error, and finding it out after the documents
    // have been sent is the wrong order to find it out in.
    const shapeProblem = validateSchemaShape(schema);
    if (shapeProblem) {
      const err = new Error(`Nothing was sent: ${shapeProblem}`);
      err.code = 'MODEL_SCHEMA_INVALID';
      throw err;
    }

    const at = (now && now()) || new Date().toISOString();
    const invocationId = `mi_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // ONE ROW PER INVOCATION, WRITTEN WHATEVER HAPPENS NEXT (B7). The PHI is
    // about to be sent; if the call then fails, the sending still happened and
    // an unrecorded send is one nobody can account for later.
    const audit = async (result, usage) => {
      if (typeof logActivity !== 'function') return;
      await logActivity(
        actor && actor.id, actor && (actor.name || actor.email),
        'model_invocation', 'model', patientId || null,
        {
          // No input, no output, no prompt, no quote. What ran, for whom, on
          // whose record, how big it was, and how it ended.
          invocationId, purpose, feature: feature || purpose,
          modelId: st.modelId, model: st.modelId, location: st.location,
          at, result,
          inputTokens: (usage && usage.inputTokens) ?? null,
          outputTokens: (usage && usage.outputTokens) ?? null,
          pass: pass || null,
          // IDS ONLY. A source id names a section of a chart; its contents
          // are exactly what must not be here.
          sourceIds: Array.isArray(sourceIds) ? sourceIds : null,
          outcome: null
        }
      );
    };

    let raw;
    try {
      raw = await transport({
        purpose, input, schema,
        project: st.projectId, location: st.location,
        modelId: st.modelId, bucket: st.stagingBucket
      });
    } catch (e) {
      await audit(RESULTS.CALL_FAILED, e && e.usage);
      // The provider's message may quote the prompt back, and the prompt is
      // PHI. Scrub before it reaches a caller or a log.
      const err = new Error(`Model call failed: ${scrubForLog(String(e && e.message || e))}`);
      err.code = 'MODEL_CALL_FAILED';
      throw err;
    }

    const value = raw && raw.value !== undefined ? raw.value : raw;
    const usage = (raw && raw.usage) || null;
    const checked = validateAgainstSchema(value, schema);
    if (checked.error) {
      await audit(RESULTS.OUTPUT_INVALID, usage);
      const err = new Error(`Model output did not match the requested shape: ${checked.error}`);
      err.code = 'MODEL_OUTPUT_INVALID';
      throw err;
    }
    await audit(RESULTS.OK, usage);

    return {
      invocationId,
      purpose,
      at,
      modelId: st.modelId,
      location: st.location,
      usage,
      // A PROPOSAL. The word is the contract: nothing here has been written
      // anywhere, and the caller must put it in front of a person.
      proposal: checked.value,
      // Carried through so a reviewer can triage, never so code can branch on
      // it into an auto-accept — that decision is the owner's, not a default.
      confidence: typeof (value && value.confidence) === 'number' ? value.confidence : null,
      unverified: true
    };
  };

  // Closing the loop. §10.3 asks for accept/edit/discard because it is the only
  // honest measure of whether a feature helps, and a signal nobody records is
  // a signal that does not exist.
  const recordOutcome = async ({ invocationId, outcome, actor, patientId }) => {
    if (!Object.values(OUTCOMES).includes(outcome)) {
      throw new Error(`"${outcome}" is not a recognised outcome`);
    }
    if (typeof logActivity === 'function') {
      await logActivity(
        actor && actor.id, actor && (actor.name || actor.email),
        'model_outcome', 'model', patientId || null,
        { invocationId, outcome }
      );
    }
    return { invocationId, outcome };
  };

  return { status: read, invoke, recordOutcome, runLiveChecks, PURPOSES, OUTCOMES, RESULTS };
};

module.exports = {
  PURPOSES, OUTCOMES, RESULTS, REQUIRED_SETTINGS,
  REQUIRED_LOCATION, CHECK_TTL_MS,
  status, createEngine, BoundaryRefusal,
  scrubForLog, validateAgainstSchema, validateSchemaShape
};
