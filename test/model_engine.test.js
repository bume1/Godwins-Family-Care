// test/model_engine.test.js — the one place a model is called.
//
// `GFC_Clinical_Completeness_Spec_v1.md` §10.3 is normative. Every rule it
// sets is pinned here, because the failure mode of getting one wrong is PHI
// leaving the BAA boundary — which is not a bug you find later by reading logs.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const M = require('../modelEngine.js');
const fs = require('fs');
const path = require('path');

const GOOD_ENV = {
  BEDROCK_REGION: 'us-east-1',
  BEDROCK_MODEL_ID: 'anthropic.claude',
  BEDROCK_ZERO_DATA_RETENTION: 'true'
};
const SCHEMA = { fields: { memberId: { type: 'string', required: true }, payer: { type: 'string' } } };

// ── the stop condition ────────────────────────────────────────────────────

test('zero data retention is a STOP condition, not a warning', async () => {
  const engine = M.createEngine({
    env: { ...GOOD_ENV, BEDROCK_ZERO_DATA_RETENTION: 'false' },
    transport: async () => ({ memberId: 'X' })
  });
  await assert.rejects(
    () => engine.invoke({ purpose: M.PURPOSES.DOCUMENT_EXTRACTION, input: 'x', schema: SCHEMA }),
    (e) => e.code === 'MODEL_BOUNDARY_REFUSED' && /not affirmative/i.test(e.blockers.join(' ')),
    'ZDR off must refuse the call outright'
  );
});

test('an unset boundary refuses before the input is touched', async () => {
  let transportCalled = false;
  const engine = M.createEngine({ env: {}, transport: async () => { transportCalled = true; return {}; } });
  await assert.rejects(() => engine.invoke({ purpose: M.PURPOSES.DOCUMENT_EXTRACTION, input: 'PHI here', schema: SCHEMA }));
  assert.strictEqual(transportCalled, false, 'nothing may be sent when the boundary is unsatisfied');
});

test('static AWS keys are refused — §10.3 requires an IAM role', () => {
  const s = M.status({ ...GOOD_ENV, AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE' });
  assert.strictEqual(s.configured, false);
  assert.ok(s.blockers.some(b => /IAM ROLE/i.test(b)), 'the refusal must name the reason');
  assert.strictEqual(s.usesStaticKeys, true);
});

test('status names EVERY missing piece, not the first', () => {
  const s = M.status({});
  assert.strictEqual(s.blockers.length, M.REQUIRED_SETTINGS.length,
    'a setup that reports one blocker at a time takes as many restarts as there are blockers');
  for (const req of M.REQUIRED_SETTINGS) {
    assert.ok(s.blockers.some(b => b.includes(req.key)), `${req.key} must be named`);
  }
});

test('configured is not a claim that AWS accepts anything', () => {
  const s = M.status(GOOD_ENV);
  assert.strictEqual(s.configured, true);
  // The distinction that let a narrowed OAuth token sit behind a green
  // "OpenEMR connected" for weeks. Said in the payload, not just in a comment.
  assert.match(s.proof, /only a live invocation proves/i);
});

// ── propose, never commit ─────────────────────────────────────────────────

test('what comes back is a PROPOSAL and says it is unverified', async () => {
  const engine = M.createEngine({ env: GOOD_ENV, transport: async () => ({ memberId: 'A123', confidence: 0.88 }) });
  const r = await engine.invoke({ purpose: M.PURPOSES.DOCUMENT_EXTRACTION, input: 'x', schema: SCHEMA });
  assert.deepStrictEqual(r.proposal, { memberId: 'A123' });
  assert.strictEqual(r.unverified, true, 'nothing returned here has been verified by anyone');
  assert.strictEqual(r.confidence, 0.88);
  assert.ok(!('value' in r), 'the word is proposal — a "value" reads as settled');
});

test('the engine writes nothing anywhere itself', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'modelEngine.js'), 'utf8');
  assert.ok(!/db\.set\(|\.save\(|writeFile/.test(src),
    'the engine must not persist — a caller puts a proposal in front of a person');
});

// ── the schema is an allow-list ───────────────────────────────────────────

test('a key nobody declared never reaches the caller', async () => {
  const engine = M.createEngine({
    env: GOOD_ENV,
    transport: async () => ({ memberId: 'A1', ssn: '123-45-6789', isAdmin: true })
  });
  const r = await engine.invoke({ purpose: M.PURPOSES.DOCUMENT_EXTRACTION, input: 'x', schema: SCHEMA });
  assert.strictEqual(r.proposal.ssn, undefined, 'an undeclared field must be dropped');
  assert.strictEqual(r.proposal.isAdmin, undefined);
});

test('output of the wrong shape is an error, never coerced', () => {
  // A coerced field is a wrong field that reads as plausibly as a right one —
  // which is exactly what §10.3 means by a fluent wrong sentence.
  assert.ok(M.validateAgainstSchema({ memberId: 42 }, SCHEMA).error, 'a number is not a string');
  assert.ok(M.validateAgainstSchema({}, SCHEMA).error, 'a missing required field is an error');
  assert.ok(M.validateAgainstSchema(null, SCHEMA).error);
  assert.ok(M.validateAgainstSchema({ memberId: 'A' }, null).error, 'an unvalidated output is not a result');
});

test('an enum value outside the declared set is refused', () => {
  const schema = { fields: { kind: { type: 'string', enum: ['card', 'referral'] } } };
  assert.ok(M.validateAgainstSchema({ kind: 'something_else' }, schema).error);
  assert.ok(!M.validateAgainstSchema({ kind: 'card' }, schema).error);
});

// ── purposes are declared, never passed in freely ─────────────────────────

test('an undeclared purpose cannot invoke a model', async () => {
  const engine = M.createEngine({ env: GOOD_ENV, transport: async () => ({ memberId: 'A' }) });
  await assert.rejects(
    () => engine.invoke({ purpose: 'exfiltrate_everything', input: 'x', schema: SCHEMA }),
    (e) => e.code === 'MODEL_BOUNDARY_REFUSED'
  );
});

// ── no PHI in logs, prompts or traces ─────────────────────────────────────

test('a provider error carrying the prompt back is scrubbed before it escapes', async () => {
  const engine = M.createEngine({
    env: GOOD_ENV,
    transport: async () => { throw new Error('rejected input: patient dob 1948-03-02, jane@example.com, 555-123-4567'); }
  });
  await assert.rejects(
    () => engine.invoke({ purpose: M.PURPOSES.DOCUMENT_EXTRACTION, input: 'x', schema: SCHEMA }),
    (e) => {
      assert.ok(!/1948-03-02/.test(e.message), 'a date of birth must not survive into an error');
      assert.ok(!/jane@example\.com/.test(e.message), 'nor an email');
      assert.ok(!/555-123-4567/.test(e.message), 'nor a phone number');
      return e.code === 'MODEL_CALL_FAILED';
    }
  );
});

test('the audit entry records what ran, never what was in it', async () => {
  const entries = [];
  const engine = M.createEngine({
    env: GOOD_ENV,
    transport: async () => ({ memberId: 'A123' }),
    logActivity: async (id, name, action, type, patientId, meta) => entries.push({ action, patientId, meta })
  });
  await engine.invoke({
    purpose: M.PURPOSES.DOCUMENT_EXTRACTION, input: 'SSN 123-45-6789', schema: SCHEMA,
    actor: { id: 'u1', name: 'B. Ume' }, patientId: 'p1'
  });
  assert.strictEqual(entries.length, 1, 'one entry per invocation');
  const blob = JSON.stringify(entries[0].meta);
  assert.ok(!/123-45-6789/.test(blob), 'the input must not reach the audit log');
  assert.ok(!/A123/.test(blob), 'nor the output');
  // What it MUST carry: who, on whose record, what ran (§10.3).
  assert.strictEqual(entries[0].patientId, 'p1');
  assert.match(blob, /document_extraction/);
  assert.match(blob, /anthropic\.claude/);
});

test('the accept / edit / discard signal is recorded, because otherwise it does not exist', async () => {
  const entries = [];
  const engine = M.createEngine({
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

test('with no transport it refuses and says Bedrock is not connected', async () => {
  const engine = M.createEngine({ env: GOOD_ENV });
  await assert.rejects(
    () => engine.invoke({ purpose: M.PURPOSES.DOCUMENT_EXTRACTION, input: 'x', schema: SCHEMA }),
    (e) => e.code === 'MODEL_BOUNDARY_REFUSED' && /not connected/i.test(e.blockers.join(' '))
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

test('there is ONE engine — §10.3 applies to every AI feature', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'modelEngine.js'), 'utf8');
  // Both the dictation feature and document extraction route through here.
  assert.match(src, /DICTATION_TO_NOTE/);
  assert.match(src, /DOCUMENT_EXTRACTION/);
  // And nothing else in the tree may call a model provider directly.
  const root = path.join(__dirname, '..');
  const offenders = fs.readdirSync(root)
    .filter(f => f.endsWith('.js') && f !== 'modelEngine.js')
    .filter(f => /BedrockRuntime|invokeModel|anthropic\.claude/.test(fs.readFileSync(path.join(root, f), 'utf8')));
  assert.deepStrictEqual(offenders, [],
    'a second call site is a second place the boundary rules get implemented slightly differently');
});
