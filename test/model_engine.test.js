// test/model_engine.test.js — the one place a model is called.
//
// `GFC_Clinical_Completeness_Spec_v1.md` §10.3 is normative. Every rule it
// sets is pinned here, because the failure mode of getting one wrong is PHI
// leaving the BAA boundary — which is not a bug you find later by reading logs.
//
// Repointed 2026-10-12: Bedrock is gone and Gemini on Vertex AI is the only
// model. The rules did not change; what satisfies them did.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const M = require('../modelEngine.js');
const fs = require('fs');
const path = require('path');

const WIF = path.join(__dirname, 'fixtures', 'wif_external_account.json');
const STATIC_KEY = path.join(__dirname, 'fixtures', 'static_service_account_key.json');

const GOOD_ENV = {
  VERTEX_PROJECT_ID: 'gfc-clinical-ai',
  VERTEX_LOCATION: 'us',
  VERTEX_MODEL_ID: 'gemini-3.5-flash',
  VERTEX_STAGING_BUCKET: 'gfc-clinical-ai-staging',
  VERTEX_ZERO_DATA_RETENTION: 'true',
  GOOGLE_APPLICATION_CREDENTIALS: WIF
};
const SCHEMA = { fields: { memberId: { type: 'string', required: true }, payer: { type: 'string' } } };

// The daily Google-side checks are part of the boundary, so a test that wants
// a working engine has to satisfy them the way production does.
const PASSING_CHECKS = async () => ({ ok: true, failures: [] });
const engineWithChecks = async (opts) => {
  const engine = M.createEngine({ liveChecks: PASSING_CHECKS, ...opts });
  await engine.runLiveChecks();
  return engine;
};
// `status()` is pure, so its check state is passed in directly.
const FRESH = () => ({ at: new Date().toISOString(), ok: true, failures: [] });

// ── the stop conditions ───────────────────────────────────────────────────

test('zero data retention is a STOP condition, not a warning', async () => {
  const engine = await engineWithChecks({
    env: { ...GOOD_ENV, VERTEX_ZERO_DATA_RETENTION: 'false' },
    transport: async () => ({ memberId: 'X' })
  });
  await assert.rejects(
    () => engine.invoke({ purpose: M.PURPOSES.DOCUMENT_EXTRACTION, input: 'x', schema: SCHEMA }),
    (e) => e.code === 'MODEL_BOUNDARY_REFUSED' && /not affirmative/i.test(e.blockers.join(' ')),
    'ZDR off must refuse the call outright'
  );
});

test('the location must be "us" — "global" routes wherever Google has capacity', async () => {
  const st = M.status({ ...GOOD_ENV, VERTEX_LOCATION: 'global' }, FRESH());
  assert.strictEqual(st.configured, false);
  assert.match(st.blockers.join(' '), /VERTEX_LOCATION is "global"/);
  // And it refuses in the engine, not just in the status read.
  const engine = await engineWithChecks({
    env: { ...GOOD_ENV, VERTEX_LOCATION: 'global' },
    transport: async () => ({ memberId: 'X' })
  });
  await assert.rejects(
    () => engine.invoke({ purpose: M.PURPOSES.CHART_REVIEW, input: 'x', schema: SCHEMA }),
    (e) => e.code === 'MODEL_BOUNDARY_REFUSED'
  );
});

test('a preview or experimental model never sees patient data', async () => {
  for (const id of ['gemini-3.5-pro-preview-05-20', 'gemini-exp-1234', 'gemini-2.0-experimental']) {
    const st = M.status({ ...GOOD_ENV, VERTEX_MODEL_ID: id }, FRESH());
    assert.strictEqual(st.configured, false, `${id} must be refused`);
    assert.match(st.blockers.join(' '), /preview or experimental/);
  }
  // A released name that merely CONTAINS one of those letters is fine —
  // refusing "gemini-3.5-flash-expanded" would be a guard that cannot tell a
  // model from a substring.
  assert.strictEqual(M.status(GOOD_ENV, FRESH()).configured, true);
});

test('a static service-account key is refused, not used', async () => {
  const st = M.status({ ...GOOD_ENV, GOOGLE_APPLICATION_CREDENTIALS: STATIC_KEY }, FRESH());
  assert.strictEqual(st.configured, false);
  assert.strictEqual(st.usesStaticKeys, true);
  assert.match(st.blockers.join(' '), /static service-account key/);
  // The file's CONTENTS must never reach the status payload — that is the
  // leak this check exists to prevent in the first place.
  const blob = JSON.stringify(st);
  assert.ok(!/BEGIN PRIVATE KEY/.test(blob), 'the key must not be echoed');
  assert.ok(!/gserviceaccount\.com/.test(blob), 'nor the service account address');
});

test('only external_account is accepted, and an unreadable file is its own blocker', () => {
  const missing = M.status({ ...GOOD_ENV, GOOGLE_APPLICATION_CREDENTIALS: '/no/such/file.json' }, FRESH());
  assert.match(missing.blockers.join(' '), /does not point at a readable JSON file/);
  assert.strictEqual(M.status(GOOD_ENV, FRESH()).credentialType, 'external_account');
});

test('the daily Google-side checks are part of the boundary: stale refuses, failed refuses with the reason', async () => {
  // Never run.
  assert.match(M.status(GOOD_ENV, null).blockers.join(' '), /have not passed in the last 24 hours/);
  // Run, but too long ago.
  const old = { at: new Date(Date.now() - (M.CHECK_TTL_MS + 60000)).toISOString(), ok: true, failures: [] };
  assert.match(M.status(GOOD_ENV, old).blockers.join(' '), /have not passed in the last 24 hours/);
  // Run, fresh, but failed — the reason is carried through, not replaced.
  const failed = { at: new Date().toISOString(), ok: false, failures: ['Gemini data caching is NOT disabled for this project'] };
  const st = M.status(GOOD_ENV, failed);
  assert.strictEqual(st.configured, false);
  assert.match(st.blockers.join(' '), /caching is NOT disabled/);

  // And the engine refuses on a failed check even with every setting right.
  const engine = M.createEngine({
    env: GOOD_ENV,
    liveChecks: async () => ({ ok: false, failures: ['the staging bucket has no lifecycle rule deleting objects at 1 day or less'] }),
    transport: async () => ({ memberId: 'X' })
  });
  await engine.runLiveChecks();
  await assert.rejects(
    () => engine.invoke({ purpose: M.PURPOSES.CHART_REVIEW, input: 'x', schema: SCHEMA }),
    (e) => e.code === 'MODEL_BOUNDARY_REFUSED' && /lifecycle rule/.test(e.blockers.join(' '))
  );
});

test('a check routine that throws is a blocker, and its reason is scrubbed', async () => {
  const engine = M.createEngine({
    env: GOOD_ENV,
    liveChecks: async () => { throw new Error('bucket gfc-staging denied for jane@example.com'); }
  });
  const r = await engine.runLiveChecks();
  assert.strictEqual(r.ok, false);
  assert.ok(!/jane@example\.com/.test(r.failures.join(' ')), 'an address in a Google error must not survive into the blocker');
});

test('with no check routine wired at all, the boundary cannot be proven', async () => {
  const engine = M.createEngine({ env: GOOD_ENV });
  const r = await engine.runLiveChecks();
  assert.strictEqual(r.ok, false);
  assert.match(r.failures.join(' '), /no Google-side check routine is wired/);
});

test('EVERY blocker is listed, not just the first', () => {
  const st = M.status({
    VERTEX_LOCATION: 'global',
    VERTEX_MODEL_ID: 'gemini-preview-1',
    VERTEX_ZERO_DATA_RETENTION: 'no',
    GOOGLE_APPLICATION_CREDENTIALS: STATIC_KEY
  }, null);
  assert.strictEqual(st.configured, false);
  const joined = st.blockers.join(' | ');
  // Two missing settings, plus ZDR, location, model, credential and checks.
  assert.match(joined, /VERTEX_PROJECT_ID is not set/);
  assert.match(joined, /VERTEX_STAGING_BUCKET is not set/);
  assert.match(joined, /not affirmative/);
  assert.match(joined, /VERTEX_LOCATION is "global"/);
  assert.match(joined, /preview or experimental/);
  assert.match(joined, /static service-account key/);
  assert.match(joined, /last 24 hours/);
  assert.ok(st.blockers.length >= 7, `expected every blocker, got ${st.blockers.length}`);
});

test('a missing setting is reported once, not twice by two different rules', () => {
  // VERTEX_LOCATION absent must read as "not set", never also as 'is ""'.
  const st = M.status({ ...GOOD_ENV, VERTEX_LOCATION: '' }, FRESH());
  const locationBlockers = st.blockers.filter(b => /VERTEX_LOCATION/.test(b));
  assert.strictEqual(locationBlockers.length, 1, locationBlockers.join(' | '));
  assert.match(locationBlockers[0], /is not set/);
});

// ── the schema is checked BEFORE the PHI moves ────────────────────────────

test('a purpose with no usable schema sends NOTHING — the check runs before the transport', async () => {
  let sent = false;
  const engine = await engineWithChecks({
    env: GOOD_ENV,
    transport: async () => { sent = true; return { memberId: 'X' }; }
  });
  for (const bad of [undefined, null, {}, { fields: {} }, { fields: { a: { type: 'wat' } } }]) {
    await assert.rejects(
      () => engine.invoke({ purpose: M.PURPOSES.DOCUMENT_EXTRACTION, input: 'SSN 123-45-6789', schema: bad }),
      (e) => e.code === 'MODEL_SCHEMA_INVALID',
      `schema ${JSON.stringify(bad)} must be refused before sending`
    );
  }
  assert.strictEqual(sent, false, 'the PHI must not cross the boundary to discover the schema was unusable');
});

// ── validation is an allow-list at EVERY level ────────────────────────────

test('undeclared keys are dropped at every level, not just the top one', () => {
  const schema = {
    fields: {
      summary: { type: 'string' },
      findings: {
        type: 'array',
        items: {
          statement: { type: 'string' },
          priority: { type: 'string', enum: ['info', 'urgent'] },
          citations: { type: 'array', items: { sourceId: { type: 'string', required: true } } }
        }
      },
      meta: { type: 'object', items: { pass: { type: 'number' } } }
    }
  };
  const r = M.validateAgainstSchema({
    summary: 'ok',
    sneaky: 'top level',
    findings: [{
      statement: 's', priority: 'urgent', smuggled: 'nested',
      citations: [{ sourceId: 'enc:1', alsoSmuggled: 'deeper' }]
    }],
    meta: { pass: 1, hidden: 'x' }
  }, schema);
  assert.ok(!r.error, r.error);
  assert.deepStrictEqual(Object.keys(r.value).sort(), ['findings', 'meta', 'summary']);
  assert.deepStrictEqual(Object.keys(r.value.findings[0]).sort(), ['citations', 'priority', 'statement']);
  assert.deepStrictEqual(Object.keys(r.value.findings[0].citations[0]), ['sourceId']);
  assert.deepStrictEqual(Object.keys(r.value.meta), ['pass']);
});

test('booleans, maxLength, maxItems and nested required are all enforced', () => {
  const schema = {
    fields: {
      matchesChart: { type: 'boolean', required: true },
      note: { type: 'string', maxLength: 5 },
      rows: { type: 'array', maxItems: 2, items: { a: { type: 'string', required: true } } }
    }
  };
  assert.match(M.validateAgainstSchema({ matchesChart: 'yes' }, schema).error, /must be true or false/);
  assert.ok(!M.validateAgainstSchema({ matchesChart: false }, schema).error, 'false is a value, not an absence');
  assert.match(M.validateAgainstSchema({ matchesChart: true, note: 'far too long' }, schema).error, /longer than the 5/);
  assert.match(M.validateAgainstSchema({ matchesChart: true, rows: [{ a: '1' }, { a: '2' }, { a: '3' }] }, schema).error, /more than the 2/);
  assert.match(M.validateAgainstSchema({ matchesChart: true, rows: [{ b: 'x' }] }, schema).error, /rows\[0\]\.a is required/);
});

// ── audit: every invocation, including the ones that failed ──────────────

test('the audit entry records what ran, never what was in it', async () => {
  const entries = [];
  const engine = await engineWithChecks({
    env: GOOD_ENV,
    transport: async () => ({ value: { memberId: 'A123' }, usage: { inputTokens: 1200, outputTokens: 80 } }),
    logActivity: async (id, name, action, type, patientId, meta) => entries.push({ action, patientId, meta })
  });
  await engine.invoke({
    purpose: M.PURPOSES.CHART_REVIEW, input: 'SSN 123-45-6789', schema: SCHEMA,
    actor: { id: 'u1', name: 'B. Ume' }, patientId: 'p1', pass: 2, sourceIds: ['enc:abc', 'doc:9']
  });
  assert.strictEqual(entries.length, 1, 'one entry per invocation');
  const blob = JSON.stringify(entries[0].meta);
  assert.ok(!/123-45-6789/.test(blob), 'the input must not reach the audit log');
  assert.ok(!/A123/.test(blob), 'nor the output');
  // What it MUST carry: who, on whose record, what ran, how big, how it ended.
  assert.strictEqual(entries[0].patientId, 'p1');
  assert.match(blob, /chart_review/);
  assert.match(blob, /gemini-3\.5-flash/);
  assert.strictEqual(entries[0].meta.location, 'us');
  assert.strictEqual(entries[0].meta.inputTokens, 1200);
  assert.strictEqual(entries[0].meta.outputTokens, 80);
  assert.strictEqual(entries[0].meta.pass, 2);
  assert.strictEqual(entries[0].meta.result, 'ok');
  // Source IDS only — a section's contents are exactly what must not be here.
  assert.deepStrictEqual(entries[0].meta.sourceIds, ['enc:abc', 'doc:9']);
});

test('a FAILED call still writes its audit row — the PHI was sent either way', async () => {
  const entries = [];
  const engine = await engineWithChecks({
    env: GOOD_ENV,
    transport: async () => { throw new Error('Vertex 503 for patient 1948-03-18'); },
    logActivity: async (id, n, action, t, p, meta) => entries.push({ action, meta })
  });
  await assert.rejects(
    () => engine.invoke({ purpose: M.PURPOSES.CHART_REVIEW, input: 'x', schema: SCHEMA, patientId: 'p1' }),
    (e) => e.code === 'MODEL_CALL_FAILED'
  );
  assert.strictEqual(entries.length, 1, 'a failed invocation is still an invocation');
  assert.strictEqual(entries[0].meta.result, 'call_failed');
  assert.ok(!/1948-03-18/.test(JSON.stringify(entries[0].meta)), 'no date out of the provider error');
});

test('an INVALID output writes its own audit row, distinguishable from a failure', async () => {
  const entries = [];
  const engine = await engineWithChecks({
    env: GOOD_ENV,
    transport: async () => ({ value: { payer: 'Aetna' }, usage: { inputTokens: 10, outputTokens: 2 } }),
    logActivity: async (id, n, action, t, p, meta) => entries.push({ action, meta })
  });
  await assert.rejects(
    () => engine.invoke({ purpose: M.PURPOSES.DOCUMENT_EXTRACTION, input: 'x', schema: SCHEMA }),
    (e) => e.code === 'MODEL_OUTPUT_INVALID'
  );
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].meta.result, 'output_invalid');
  assert.ok(!/Aetna/.test(JSON.stringify(entries[0].meta)), 'not even the rejected output');
});

test('the provider message never carries the prompt back out', async () => {
  const engine = await engineWithChecks({
    env: GOOD_ENV,
    transport: async () => { throw new Error('failed on "Jane Doe, DOB 3/18/1948, MBI 1EG4TE5MK73, jane@example.com, 555-123-4567"'); }
  });
  await assert.rejects(
    () => engine.invoke({ purpose: M.PURPOSES.DOCUMENT_EXTRACTION, input: 'x', schema: SCHEMA }),
    (e) => {
      assert.ok(!/jane@example\.com/.test(e.message), 'no email');
      assert.ok(!/555-123-4567/.test(e.message), 'no phone number');
      assert.ok(!/3\/18\/1948/.test(e.message), 'no written date of birth');
      assert.ok(!/1EG4TE5MK73/.test(e.message), 'no MBI');
      return e.code === 'MODEL_CALL_FAILED';
    }
  );
});

test('the scrubber covers the identifiers that actually appear on these documents', () => {
  const s = M.scrubForLog('DOB 3/18/48 and 12/31/1948, MBI 1EG4TE5MK73, SSN 123-45-6789, a@b.co, 555-123-4567, 2026-01-02');
  for (const leak of ['3/18/48', '12/31/1948', '1EG4TE5MK73', '123-45-6789', 'a@b.co', '555-123-4567', '2026-01-02']) {
    assert.ok(!s.includes(leak), `${leak} survived scrubbing: ${s}`);
  }
});

test('the accept / edit / discard signal is recorded, because otherwise it does not exist', async () => {
  const entries = [];
  const engine = await engineWithChecks({
    env: GOOD_ENV, transport: async () => ({ memberId: 'A' }),
    logActivity: async (id, n, action, t, p, meta) => entries.push({ action, meta })
  });
  const r = await engine.invoke({ purpose: M.PURPOSES.DOCUMENT_EXTRACTION, input: 'x', schema: SCHEMA });
  assert.strictEqual(entries[0].meta.outcome, null, 'the outcome is not known at invocation and is not guessed');
  await engine.recordOutcome({ invocationId: r.invocationId, outcome: M.OUTCOMES.EDITED, actor: { id: 'u1' } });
  const closed = entries.find(e => e.action === 'model_outcome');
  assert.ok(closed, 'the loop must be closable');
  assert.strictEqual(closed.meta.outcome, 'edited');
  assert.strictEqual(closed.meta.invocationId, r.invocationId);
  await assert.rejects(() => engine.recordOutcome({ invocationId: r.invocationId, outcome: 'great', actor: {} }));
});

// ── inert until wired, and honest about it ────────────────────────────────

test('with no transport it refuses and says Vertex is not connected', async () => {
  const engine = await engineWithChecks({ env: GOOD_ENV });
  await assert.rejects(
    () => engine.invoke({ purpose: M.PURPOSES.DOCUMENT_EXTRACTION, input: 'x', schema: SCHEMA }),
    (e) => e.code === 'MODEL_BOUNDARY_REFUSED' && /Vertex AI is not connected/i.test(e.blockers.join(' '))
  );
});

test('an undeclared purpose is refused', async () => {
  const engine = await engineWithChecks({ env: GOOD_ENV, transport: async () => ({ memberId: 'A' }) });
  await assert.rejects(
    () => engine.invoke({ purpose: 'exfiltrate', input: 'x', schema: SCHEMA }),
    (e) => e.code === 'MODEL_BOUNDARY_REFUSED'
  );
});

test('a boundary refusal is its own error type, not catchable as an ordinary failure', async () => {
  const engine = M.createEngine({ env: {} });
  await engine.invoke({ purpose: M.PURPOSES.DOCUMENT_EXTRACTION, input: 'x', schema: SCHEMA })
    .then(() => assert.fail('should have refused'))
    .catch(e => {
      assert.ok(e instanceof M.BoundaryRefusal, 'a caller must not retry into the boundary by catching broadly');
      assert.ok(Array.isArray(e.blockers) && e.blockers.length);
    });
});

// ── one engine, one provider ──────────────────────────────────────────────

test('there is ONE engine — §10.3 applies to every AI feature', () => {
  const root = path.join(__dirname, '..');
  const src = fs.readFileSync(path.join(root, 'modelEngine.js'), 'utf8');
  // Every AI feature routes through here.
  assert.match(src, /DICTATION_TO_NOTE/);
  assert.match(src, /DOCUMENT_EXTRACTION/);
  assert.match(src, /CHART_REVIEW/);
  assert.match(src, /RECORDS_EXTRACTION/);

  // `vertexTransport.js` is the one exception, and it is the exception
  // modelEngine.js itself names: the Gemini client is built in exactly one
  // place. It is allowed to touch the SDK for exactly that reason — building
  // the client and placing the call — and nothing else. Any OTHER file
  // touching a model provider is what this guards against: a second call site
  // where the boundary rules drift.
  //
  // BOTH directions are scanned (A2): a second Gemini call site, and Bedrock
  // coming back. Comments are stripped first — a source scan that cannot tell
  // live code from PROSE ABOUT that code proves nothing, and these files'
  // headers name the very things they do not do.
  const stripComments = (s) => s
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const exempt = new Set(['modelEngine.js', 'vertexTransport.js']);
  const GEMINI = /@google\/genai|generateContent|aiplatform\.googleapis/;
  const BEDROCK = /BedrockRuntime|invokeModel|anthropic\.claude|bedrock/i;

  const offenders = fs.readdirSync(root)
    .filter(f => f.endsWith('.js') && !exempt.has(f))
    .filter(f => {
      const code = stripComments(fs.readFileSync(path.join(root, f), 'utf8'));
      return GEMINI.test(code) || BEDROCK.test(code);
    });
  assert.deepStrictEqual(offenders, [],
    'a second call site is a second place the boundary rules get implemented slightly differently');

  // Bedrock is REMOVED, not disabled — a branch that can never run is a place
  // for a later session to be misled about what is supported.
  assert.ok(!fs.existsSync(path.join(root, 'bedrockTransport.js')), 'bedrockTransport.js must be gone');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.ok(!Object.keys(pkg.dependencies || {}).some(d => /bedrock/i.test(d)), 'the Bedrock dependency must be gone');
  assert.ok(!BEDROCK.test(stripComments(fs.readFileSync(path.join(root, 'server.js'), 'utf8'))), 'no Bedrock wiring in server.js');

  // The exception earns its keep only if it stays a bare transport — the
  // moment it re-implements a boundary check of its own it IS the second place
  // the guard existed to prevent, just inside the exempted file.
  const transportCode = stripComments(fs.readFileSync(path.join(root, 'vertexTransport.js'), 'utf8'));
  assert.doesNotMatch(transportCode, /VERTEX_ZERO_DATA_RETENTION|VERTEX_MODEL_ID|VERTEX_PROJECT_ID|process\.env/,
    'vertexTransport.js must not read settings or re-implement the boundary check — modelEngine.js alone decides whether a call is allowed');
});
