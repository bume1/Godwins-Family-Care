// modelEngine.js — the ONE place a model is called (2026-09-22).
//
// `GFC_Clinical_Completeness_Spec_v1.md` §10.3 is normative, not advisory, and
// every rule it sets is enforced here rather than described:
//
//   • Inside the BAA boundary only — Claude on Amazon Bedrock, IAM role, never
//     keys in the environment.
//   • ZERO DATA RETENTION configured explicitly. §10.3 makes this a STOP
//     condition, so this module REFUSES TO RUN without it rather than warning.
//   • Propose, never commit. Nothing returned here reaches a record on its own.
//   • Unverified until touched.
//   • One audit entry per invocation, carrying whether the output was
//     accepted, edited or discarded.
//   • No PHI in logs, prompts or error traces that leave the boundary.
//
// WHY ONE ENGINE AND NOT TWO. Session AI.1 (dictation → note) and the document
// extraction the owner asked for on 2026-09-22 are the same shape: take an
// input, return a structured object against a schema, for a named purpose. Two
// engines means two places the boundary rules are implemented, and the second
// one is where they get implemented slightly differently — which for a rule
// whose failure mode is PHI leaving the boundary is not a risk worth taking.
// §10.3's own wording is "applies to EVERY AI feature".
//
// IT IS DELIBERATELY INERT UNTIL CONFIGURED. Nothing here is wired to Bedrock
// yet, and `status()` names every missing piece rather than the first — the
// pattern `driveStatus()` settled, because a setup that reports one blocker at
// a time takes as many restarts as there are blockers. `configured` means the
// settings parse, which is a DIFFERENT FACT from AWS accepting them; only a
// live call proves the second, and this module never claims the first is the
// second. That distinction is the one that let a narrowed OAuth token sit
// behind a green "OpenEMR connected" for weeks.
'use strict';

// Every purpose a model may be invoked for is declared. An undeclared purpose
// is refused — a feature added next session does not silently inherit a
// boundary-crossing capability because somebody passed a new string.
const PURPOSES = Object.freeze({
  DICTATION_TO_NOTE: 'dictation_to_note',
  DOCUMENT_EXTRACTION: 'document_extraction',
  DOCUMENT_CLASSIFICATION: 'document_classification'
});

// What a caller does with what came back. This is the evaluation signal §10.3
// asks for, and it is the only honest measure of whether a feature helps.
const OUTCOMES = Object.freeze({
  ACCEPTED: 'accepted',
  EDITED: 'edited',
  DISCARDED: 'discarded'
});

const REQUIRED_SETTINGS = Object.freeze([
  { key: 'BEDROCK_REGION', why: 'which AWS region the model is invoked in — it must be one the BAA covers' },
  { key: 'BEDROCK_MODEL_ID', why: 'the exact model id, so what ran is recorded rather than inferred' },
  { key: 'BEDROCK_ZERO_DATA_RETENTION', why: 'ZDR must be explicitly confirmed — §10.3 makes this a stop condition, not a preference' }
]);

const truthy = (v) => v === true || ['1', 'true', 'yes', 'on'].includes(String(v || '').trim().toLowerCase());

// Names EVERY missing piece, not the first.
const status = (env) => {
  const e = env || process.env || {};
  const missing = [];
  for (const s of REQUIRED_SETTINGS) {
    if (!String(e[s.key] || '').trim()) missing.push(s);
  }
  const zdr = truthy(e.BEDROCK_ZERO_DATA_RETENTION);
  // Credentials in the environment are a boundary problem in themselves: §10.3
  // says IAM role, and a long-lived key pair in env is the thing it excludes.
  const staticKeys = !!(String(e.AWS_ACCESS_KEY_ID || '').trim() || String(e.AWS_SECRET_ACCESS_KEY || '').trim());
  const blockers = missing.map(m => `${m.key} is not set — ${m.why}`);
  if (!missing.some(m => m.key === 'BEDROCK_ZERO_DATA_RETENTION') && !zdr) {
    blockers.push('BEDROCK_ZERO_DATA_RETENTION is set but not affirmative — ZDR must be explicitly ON, and this refuses to run until it is');
  }
  if (staticKeys) {
    blockers.push('AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY are present — §10.3 requires an IAM ROLE, so static keys are refused rather than used');
  }
  return {
    // The settings parse and nothing is contradictory. NOT proof AWS accepts
    // them, and this never claims it is.
    configured: blockers.length === 0,
    zeroDataRetention: zdr,
    region: String(e.BEDROCK_REGION || '') || null,
    modelId: String(e.BEDROCK_MODEL_ID || '') || null,
    usesStaticKeys: staticKeys,
    blockers,
    // Said plainly so no session mistakes one for the other.
    proof: 'configured means these settings parse. Only a live invocation proves AWS accepts them and that ZDR is actually in force on the account.'
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
const scrubForLog = (value) => {
  if (value === null || value === undefined) return value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    return value
      .replace(/\b[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, SCRUBBED)
      .replace(/\b\d{3}-\d{2}-\d{4}\b/g, SCRUBBED)
      .replace(/\b\d{4}-\d{2}-\d{2}\b/g, SCRUBBED)
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

// Validate what came back against the schema the caller asked for. A model
// returning something shaped wrong is a failure, not a value to coerce — a
// coerced field is a wrong field that reads as plausibly as a right one.
const validateAgainstSchema = (value, schema) => {
  if (!schema || typeof schema !== 'object') return { error: 'A schema is required — an unvalidated model output is not a result' };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: 'Model returned no object' };
  const fields = schema.fields || {};
  const out = {};
  const problems = [];
  for (const [key, def] of Object.entries(fields)) {
    const raw = value[key];
    if (raw === undefined || raw === null || raw === '') {
      if (def.required) problems.push(`${key} is required and was not returned`);
      continue;
    }
    if (def.type === 'string' && typeof raw !== 'string') { problems.push(`${key} must be a string`); continue; }
    if (def.type === 'number' && typeof raw !== 'number') { problems.push(`${key} must be a number`); continue; }
    if (def.enum && !def.enum.includes(raw)) { problems.push(`${key} is not one of the permitted values`); continue; }
    out[key] = raw;
  }
  // A key nobody declared never reaches a caller. The schema is an allow-list,
  // the same rule the intake fields and the draft payload follow.
  return problems.length ? { error: problems.join('; ') } : { value: out };
};

// The one entry point.
//
// `invoke` deliberately takes a TRANSPORT rather than constructing one: it
// keeps this module pure and testable, and it means the Bedrock client is
// built in exactly one place when it is wired. Until then there is no
// transport and every call refuses at the boundary, which is the honest state.
const createEngine = ({ env, transport, logActivity, now } = {}) => {
  const read = () => status(env);

  const invoke = async ({ purpose, input, schema, actor, patientId, feature }) => {
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
        'Bedrock is not connected yet — the engine is built and inert until it is.'
      ]);
    }

    const at = (now && now()) || new Date().toISOString();
    let raw;
    try {
      raw = await transport({ purpose, input, schema, region: st.region, modelId: st.modelId });
    } catch (e) {
      // The provider's message may quote the prompt back, and the prompt is
      // PHI. Scrub before it reaches a caller or a log.
      const err = new Error(`Model call failed: ${scrubForLog(String(e && e.message || e))}`);
      err.code = 'MODEL_CALL_FAILED';
      throw err;
    }
    const checked = validateAgainstSchema(raw, schema);
    if (checked.error) {
      const err = new Error(`Model output did not match the requested shape: ${checked.error}`);
      err.code = 'MODEL_OUTPUT_INVALID';
      throw err;
    }

    // One audit row per invocation (§10.3). The OUTCOME is not known yet — the
    // caller reports it when a person acts — so it starts null rather than
    // being guessed at, and `recordOutcome` closes it.
    const invocationId = `mi_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    if (typeof logActivity === 'function') {
      await logActivity(
        actor && actor.id, actor && (actor.name || actor.email),
        'model_invocation', 'model', patientId || null,
        // No input, no output, no prompt. What ran, for whom, on whose record.
        { invocationId, purpose, feature: feature || purpose, modelId: st.modelId, region: st.region, at, outcome: null }
      );
    }

    return {
      invocationId,
      purpose,
      at,
      modelId: st.modelId,
      // A PROPOSAL. The word is the contract: nothing here has been written
      // anywhere, and the caller must put it in front of a person.
      proposal: checked.value,
      // Carried through so a reviewer can triage, never so code can branch on
      // it into an auto-accept — that decision is the owner's, not a default.
      confidence: typeof raw.confidence === 'number' ? raw.confidence : null,
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

  return { status: read, invoke, recordOutcome, PURPOSES, OUTCOMES };
};

module.exports = {
  PURPOSES, OUTCOMES, REQUIRED_SETTINGS,
  status, createEngine, BoundaryRefusal,
  scrubForLog, validateAgainstSchema
};
