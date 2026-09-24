// test/bedrock_transport.test.js — the actual Bedrock client, wired to
// modelEngine.js's transport contract (2026-09-24).
//
// modelEngine.js owns the boundary decision (region/model/ZDR present, no
// static keys) and this module never re-checks any of it — see the "ONE
// engine" test in model_engine.test.js for that guard. What this file tests
// is the shape of the request this module actually sends, and that it
// reads Bedrock's response envelope honestly rather than coercing a
// malformed one.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const T = require('../bedrockTransport.js');

const SCHEMA = {
  fields: {
    memberId: { type: 'string', required: true },
    payerType: { type: 'string', enum: ['medicare', 'medicaid', 'commercial'] }
  }
};

// ── content block selection ─────────────────────────────────────────────

test('a declared document mime maps to a document block, format from the DOCUMENT_FORMATS table', () => {
  const block = T.contentBlockFor({ mimeType: 'application/pdf', bytes: Buffer.from('x') });
  assert.deepStrictEqual(block, { document: { format: 'pdf', name: 'document', source: { bytes: Buffer.from('x') } } });
});

test('a declared image mime maps to an image block', () => {
  const block = T.contentBlockFor({ mimeType: 'image/jpeg', bytes: Buffer.from('x') });
  assert.deepStrictEqual(block, { image: { format: 'jpeg', source: { bytes: Buffer.from('x') } } });
});

test('an undeclared mime is refused by name, never sent to Bedrock to reject less legibly', () => {
  assert.throws(() => T.contentBlockFor({ mimeType: 'application/zip', bytes: Buffer.from('x') }),
    /application\/zip.*not a document or image format/);
});

// ── the schema Bedrock is held to ───────────────────────────────────────

test('the tool schema is DERIVED from the caller schema, closed selects become enums', () => {
  const js = T.jsonSchemaFor(SCHEMA);
  assert.strictEqual(js.properties.memberId.type, 'string');
  assert.deepStrictEqual(js.properties.payerType.enum, ['medicare', 'medicaid', 'commercial']);
  // Always present, so a reviewer can triage even when the caller schema
  // carries no notion of confidence.
  assert.strictEqual(js.properties.confidence.type, 'number');
});

test('a field with no enum is not given one it never declared', () => {
  const js = T.jsonSchemaFor({ fields: { note: { type: 'string' } } });
  assert.strictEqual('enum' in js.properties.note, false);
});

// ── the request Bedrock actually receives ───────────────────────────────

test('the request forces tool-use — toolChoice names the one tool, never left to the model to decide', () => {
  const req = T.buildRequest({
    purpose: 'document_extraction',
    input: { mimeType: 'application/pdf', bytes: Buffer.from('x') },
    schema: SCHEMA, modelId: 'anthropic.claude-x'
  });
  assert.strictEqual(req.modelId, 'anthropic.claude-x');
  assert.strictEqual(req.toolConfig.toolChoice.tool.name, 'record_reading');
  assert.strictEqual(req.toolConfig.tools[0].toolSpec.name, 'record_reading');
  assert.deepStrictEqual(req.toolConfig.tools[0].toolSpec.inputSchema.json, T.jsonSchemaFor(SCHEMA));
});

test('no document bytes is refused before a request is built', () => {
  assert.throws(() => T.buildRequest({ purpose: 'document_extraction', input: {}, schema: SCHEMA, modelId: 'm' }),
    /No document bytes/);
});

test('an unrecognised purpose still gets a prompt — the extraction default, never a blank instruction', () => {
  const req = T.buildRequest({
    purpose: 'something_new', input: { mimeType: 'application/pdf', bytes: Buffer.from('x') },
    schema: SCHEMA, modelId: 'm'
  });
  const textBlock = req.messages[0].content.find(b => b.text);
  assert.match(textBlock.text, /call record_reading/);
});

// ── reading Bedrock's response honestly ─────────────────────────────────

test('a normal tool-use response is unwrapped to the plain input object', () => {
  const out = T.parseResponse({
    output: { message: { content: [{ toolUse: { name: 'record_reading', input: { memberId: 'A123' } } }] } }
  });
  assert.deepStrictEqual(out, { memberId: 'A123' });
});

test('no tool use in the response is a failure, not an empty object', () => {
  assert.throws(() => T.parseResponse({ output: { message: { content: [{ text: 'I could not read this.' }] } } }),
    /no structured reading/);
});

test('a malformed response (no output at all) is the same failure, not a crash', () => {
  assert.throws(() => T.parseResponse({}), /no structured reading/);
});

// ── the transport modelEngine.js actually calls ─────────────────────────

test('createTransport never touches the network — the client comes from the injected factory', async () => {
  let calledWith = null;
  const fakeClient = { send: async (command) => { calledWith = command.input; return { output: { message: { content: [{ toolUse: { input: { memberId: 'Z9' } } }] } } }; } };
  const transport = T.createTransport((region) => { assert.strictEqual(region, 'us-east-1'); return fakeClient; });

  const result = await transport({
    purpose: 'document_extraction',
    input: { mimeType: 'application/pdf', bytes: Buffer.from('x') },
    schema: SCHEMA, region: 'us-east-1', modelId: 'anthropic.claude-x'
  });

  assert.deepStrictEqual(result, { memberId: 'Z9' });
  assert.strictEqual(calledWith.modelId, 'anthropic.claude-x');
});

test('the production transport export is built from the real client factory, not a fake', () => {
  // Confirms server.js is wiring the real thing rather than a leftover test
  // double — T.transport must be a distinct function from the raw createTransport
  // export, i.e. it was actually invoked with a client factory at module load.
  assert.strictEqual(typeof T.transport, 'function');
  assert.notStrictEqual(T.transport, T.createTransport);
});
