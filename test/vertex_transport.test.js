// test/vertex_transport.test.js — the one Gemini client (2026-10-12).
//
// modelEngine.js decides WHETHER a call may happen; this file only places it.
// So what is pinned here is that it places the call the way the boundary
// assumed it would: no tools, JSON out, documents staged under names that
// identify nobody, and every staged object deleted afterwards — including
// when the call failed, which is the path nobody exercises by hand.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const T = require('../vertexTransport.js');
const { PDFDocument } = require('pdf-lib');

const SCHEMA = { fields: { summary: { type: 'string', required: true } } };

// A fake Cloud Storage bucket that records what was saved and deleted.
const fakeStorage = () => {
  const saved = [];
  const deleted = [];
  const api = {
    bucket: (name) => ({
      name,
      file: (objectName) => ({
        name: objectName,
        save: async (bytes, opts) => { saved.push({ objectName, bytes, opts }); },
        delete: async () => { deleted.push(objectName); }
      })
    })
  };
  return { api, saved, deleted };
};

const fakeClient = (respond) => {
  const calls = [];
  return {
    calls,
    get: () => ({
      models: {
        generateContent: async (req) => { calls.push(req); return respond(req); },
        countTokens: async (req) => { calls.push(req); return { totalTokens: 4242 }; }
      }
    })
  };
};

const okResponse = (obj = { summary: 'fine' }) => ({
  candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(obj) }] } }],
  usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20 }
});

const run = async ({ respond = () => okResponse(), input }) => {
  const store = fakeStorage();
  const client = fakeClient(respond);
  const transport = T.createTransport({ getClient: client.get, getStorage: () => store.api });
  const result = await transport({
    purpose: 'chart_review', input, schema: SCHEMA,
    project: 'gfc-clinical-ai', location: 'us', modelId: 'gemini-3.5-flash',
    bucket: 'gfc-staging'
  });
  return { result, store, client };
};

// ── the request the boundary assumed ──────────────────────────────────────

test('no tools are passed, ever — grounding, search and code execution would all leave the boundary', async () => {
  const { client } = await run({ input: { sections: [{ sourceId: 'emr:problems', text: 'HTN' }] } });
  const req = client.calls[0];
  assert.ok(!('tools' in req), 'a tools key must not be present at all');
  assert.ok(!('tools' in (req.config || {})), 'nor inside config');
  const blob = JSON.stringify(req);
  for (const forbidden of ['googleSearch', 'googleMaps', 'codeExecution', 'urlContext', 'cachedContent']) {
    assert.ok(!blob.includes(forbidden), `${forbidden} must never appear in a request`);
  }
});

test('JSON out, against the schema, at a low temperature', async () => {
  const { client } = await run({ input: { sections: [{ sourceId: 'a', text: 'x' }] } });
  const cfg = client.calls[0].config;
  assert.strictEqual(cfg.responseMimeType, 'application/json');
  assert.strictEqual(cfg.responseSchema.type, 'OBJECT');
  assert.deepStrictEqual(cfg.responseSchema.required, ['summary']);
  assert.strictEqual(cfg.temperature, 0.1);
  assert.match(cfg.systemInstruction, /ONLY the sources provided/);
});

test('the system instruction forbids prescribing and demands citations — §10.3, per purpose', () => {
  assert.match(T.SYSTEM_INSTRUCTIONS.chart_review, /MUST cite/);
  assert.match(T.SYSTEM_INSTRUCTIONS.chart_review, /Do NOT recommend medications/);
  assert.match(T.SYSTEM_INSTRUCTIONS.chart_review, /do NOT offer a diagnosis/i);
  assert.match(T.SYSTEM_INSTRUCTIONS.records_extraction, /Do NOT provide ICD-10/);
  assert.match(T.SYSTEM_INSTRUCTIONS.chart_review_merge, /KEEP EVERY CITATION/);
});

test('each section is headed with its own sourceId so a finding can cite it', () => {
  const text = T.sectionText([
    { sourceId: 'enc:abc', kind: 'encounter', date: '2026-02-01', title: 'Home visit', text: 'note body' },
    { sourceId: 'emr:allergies', kind: 'allergies', title: 'Allergies', text: 'penicillin' }
  ]);
  assert.match(text, /SOURCE enc:abc \| encounter \| 2026-02-01 \| Home visit/);
  assert.match(text, /SOURCE emr:allergies \|/);
});

test('a document is sent as a labelled part followed by its file, so the citation has a name', async () => {
  const { client, store } = await run({
    input: {
      sections: [{ sourceId: 'emr:problems', text: 'HTN' }],
      documents: [{ sourceId: 'doc:77', title: 'Cardiology consult', mimeType: 'application/pdf', bytes: Buffer.from('%PDF-1.4 tiny') }]
    }
  });
  const parts = client.calls[0].contents[0].parts;
  const labelIdx = parts.findIndex(p => p.text && p.text.includes('SOURCE doc:77'));
  assert.ok(labelIdx >= 0, 'the document must carry a labelled source');
  assert.ok(parts[labelIdx + 1].fileData, 'the file must follow its own label');
  assert.match(parts[labelIdx + 1].fileData.fileUri, /^gs:\/\/gfc-staging\/stage\//);
  assert.strictEqual(store.saved.length, 1);
});

test('a staged object name identifies NOBODY — it appears in Google logs and in errors', async () => {
  const { store } = await run({
    input: {
      documents: [{
        sourceId: 'doc:77', title: 'Guess, Juanita — face sheet',
        mimeType: 'application/pdf', bytes: Buffer.from('%PDF-1.4 x'),
        clientId: 'client_123', fileName: 'Juanita_Guess_facesheet.pdf'
      }]
    }
  });
  const name = store.saved[0].objectName;
  for (const leak of ['Juanita', 'Guess', 'client_123', 'facesheet', 'doc:77', '77']) {
    assert.ok(!name.includes(leak), `"${leak}" must not appear in the staged object name (${name})`);
  }
  assert.match(name, /^stage\/[0-9a-f]{48}$/, 'a random name and nothing else');
});

test('two staged names never collide', () => {
  const names = new Set(Array.from({ length: 500 }, () => T.stagedName()));
  assert.strictEqual(names.size, 500);
});

// ── staging is cleaned up on BOTH paths ───────────────────────────────────

test('a staged object is deleted after SUCCESS', async () => {
  const { store } = await run({
    input: { documents: [{ sourceId: 'doc:1', mimeType: 'application/pdf', bytes: Buffer.from('%PDF-1.4 a') }] }
  });
  assert.strictEqual(store.saved.length, 1);
  assert.deepStrictEqual(store.deleted, [store.saved[0].objectName], 'staged, then removed');
});

test('a staged object is deleted after FAILURE — the path nobody exercises by hand', async () => {
  const store = fakeStorage();
  const client = fakeClient(() => { throw new Error('Vertex 503'); });
  const transport = T.createTransport({ getClient: client.get, getStorage: () => store.api });
  await assert.rejects(() => transport({
    purpose: 'chart_review',
    input: { documents: [{ sourceId: 'doc:1', mimeType: 'application/pdf', bytes: Buffer.from('%PDF-1.4 a') }] },
    schema: SCHEMA, project: 'p', location: 'us', modelId: 'm', bucket: 'b'
  }));
  assert.strictEqual(store.saved.length, 1, 'it was staged');
  assert.deepStrictEqual(store.deleted, [store.saved[0].objectName],
    'PHI left in a bucket because the call failed is the failure this guards');
});

test('an object is deleted even when the answer was unparseable', async () => {
  const store = fakeStorage();
  const client = fakeClient(() => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'not json' }] } }] }));
  const transport = T.createTransport({ getClient: client.get, getStorage: () => store.api });
  await assert.rejects(() => transport({
    purpose: 'chart_review',
    input: { documents: [{ sourceId: 'doc:1', mimeType: 'application/pdf', bytes: Buffer.from('%PDF-1.4 a') }] },
    schema: SCHEMA, project: 'p', location: 'us', modelId: 'm', bucket: 'b'
  }));
  assert.strictEqual(store.deleted.length, 1);
});

// ── a PDF too big for one part ────────────────────────────────────────────

test('an oversized PDF is split by page range, and each part cites its own pages', async () => {
  const doc = await PDFDocument.create();
  for (let i = 0; i < 95; i++) doc.addPage([200, 200]);
  const bytes = Buffer.from(await doc.save());
  const parts = await T.splitPdf(bytes, 'doc:big');
  assert.strictEqual(parts.length, 3, '95 pages at 40 per part');
  assert.deepStrictEqual(parts.map(p => p.sourceId), ['doc:big#p1-40', 'doc:big#p41-80', 'doc:big#p81-95']);
  // Every page is accounted for exactly once — a split that loses pages is a
  // review that silently did not read them.
  let total = 0;
  for (const p of parts) total += (await PDFDocument.load(p.bytes)).getPageCount();
  assert.strictEqual(total, 95);
});

// ── reading the answer honestly ───────────────────────────────────────────

test('a finishReason that is not STOP is named, because each has a different remedy', () => {
  for (const [reason, expect] of [['SAFETY', /safety filter/], ['RECITATION', /reciting/], ['MAX_TOKENS', /cut off/], ['OTHER', /unspecified/]]) {
    assert.throws(
      () => T.parseResponse({ candidates: [{ finishReason: reason, content: { parts: [{ text: '{}' }] } }] }),
      (e) => expect.test(e.message) && e.code === `MODEL_FINISH_${reason}`,
      `${reason} must be named`
    );
  }
});

test('an unparseable answer never quotes the answer back — it may contain the chart', () => {
  assert.throws(
    () => T.parseResponse({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'Jane Doe DOB 3/18/1948 has...' }] } }] }),
    (e) => !/Jane Doe/.test(e.message) && !/1948/.test(e.message) && /did not return the JSON/.test(e.message)
  );
});

test('token usage is read back so a call can be audited with its size', async () => {
  const { result } = await run({ input: { sections: [{ sourceId: 'a', text: 'x' }] } });
  assert.deepStrictEqual(result.usage, { inputTokens: 100, outputTokens: 20 });
  assert.deepStrictEqual(result.value, { summary: 'fine' });
});

test('countTokens is available to the planner without generating anything', async () => {
  const client = fakeClient(() => okResponse());
  const count = T.createCountTokens({ getClient: client.get });
  assert.strictEqual(await count({ contents: [{ role: 'user', parts: [{ text: 'x' }] }], project: 'p', location: 'us', modelId: 'm' }), 4242);
});

test('nothing to send is refused here rather than sent as an empty turn', () => {
  assert.throws(() => T.buildContents({ input: {}, documentParts: [] }), /nothing to send/);
});

// ── the live checks ───────────────────────────────────────────────────────

test('caching on, or a bucket that is public or never expires, each fails the check by name', async () => {
  const bucketMeta = (over) => ({
    location: 'US',
    iamConfiguration: { publicAccessPrevention: 'enforced', uniformBucketLevelAccess: { enabled: true } },
    lifecycle: { rule: [{ action: { type: 'Delete' }, condition: { age: 1 } }] },
    ...over
  });
  const mk = (cacheDisabled, over) => T.createLiveChecks({
    getStorage: () => ({ bucket: () => ({ exists: async () => [true], getMetadata: async () => [bucketMeta(over)] }) }),
    getAuth: () => ({ getClient: async () => ({ request: async () => ({ data: { disableCache: cacheDisabled } }) }) })
  });

  assert.deepStrictEqual(await mk(true, {})({ projectId: 'p', location: 'us', bucket: 'b' }), { ok: true, failures: [] });

  const caching = await mk(false, {})({ projectId: 'p', location: 'us', bucket: 'b' });
  assert.strictEqual(caching.ok, false);
  assert.match(caching.failures.join(' '), /caching is NOT disabled/);

  const eu = await mk(true, { location: 'EU' })({ projectId: 'p', location: 'us', bucket: 'b' });
  assert.match(eu.failures.join(' '), /not a US location/);

  const open = await mk(true, { iamConfiguration: { publicAccessPrevention: 'inherited', uniformBucketLevelAccess: { enabled: true } } })({ projectId: 'p', location: 'us', bucket: 'b' });
  assert.match(open.failures.join(' '), /public access prevention/);

  const noUbla = await mk(true, { iamConfiguration: { publicAccessPrevention: 'enforced', uniformBucketLevelAccess: { enabled: false } } })({ projectId: 'p', location: 'us', bucket: 'b' });
  assert.match(noUbla.failures.join(' '), /uniform bucket-level access/);

  const keeps = await mk(true, { lifecycle: { rule: [{ action: { type: 'Delete' }, condition: { age: 30 } }] } })({ projectId: 'p', location: 'us', bucket: 'b' });
  assert.match(keeps.failures.join(' '), /lifecycle rule deleting objects at 1 day or less/);

  const none = await mk(true, { lifecycle: {} })({ projectId: 'p', location: 'us', bucket: 'b' });
  assert.match(none.failures.join(' '), /no lifecycle rule/);
});

test('a missing bucket, and an unreachable Google, are each a failure rather than a pass', async () => {
  const absent = T.createLiveChecks({
    getStorage: () => ({ bucket: () => ({ exists: async () => [false] }) }),
    getAuth: () => ({ getClient: async () => ({ request: async () => ({ data: { disableCache: true } }) }) })
  });
  assert.match((await absent({ projectId: 'p', location: 'us', bucket: 'gone' })).failures.join(' '), /does not exist/);

  const broken = T.createLiveChecks({
    getStorage: () => ({ bucket: () => ({ exists: async () => { throw new Error('nope'); } }) }),
    getAuth: () => ({ getClient: async () => { throw new Error('no credentials'); } })
  });
  const r = await broken({ projectId: 'p', location: 'us', bucket: 'b' });
  assert.strictEqual(r.ok, false, 'an unreachable check is never read as a pass');
  assert.strictEqual(r.failures.length, 2, 'both checks report their own failure');
});
