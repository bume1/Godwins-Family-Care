'use strict';
// Owner, 2026-11-08: onboarding uploads accept 25 MB, not 15 (or the app-wide
// 10 that the shared check had been quietly applying behind the 15 MB door).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const express = require('express');
const config = require('../config');
const staffDocs = require('../staffDocuments');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

const MB = 1024 * 1024;
const pdf = (bytes) => Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(bytes - 9, 0x20)]);
const detect = (b) => (b.slice(0, 4).toString() === '%PDF' ? 'application/pdf' : null);

test('the staff document ceiling is 25 MB and patient uploads stay at their own limit', () => {
  assert.strictEqual(config.STAFF_DOCUMENT_MAX_SIZE, 25 * MB);
  assert.ok(config.MAX_FILE_SIZE < config.STAFF_DOCUMENT_MAX_SIZE);
});

test('a 20 MB onboarding document passes the shared check at the staff ceiling; 26 MB is refused naming 25 MB', () => {
  const ok = staffDocs.prepareStaffDocument({ buffer: pdf(20 * MB), fileName: 'license.pdf', detectFileType: detect, maxBytes: config.STAFF_DOCUMENT_MAX_SIZE, keyPrefix: 'x' });
  assert.strictEqual(ok.ok, true);
  const big = staffDocs.prepareStaffDocument({ buffer: pdf(26 * MB), fileName: 'license.pdf', detectFileType: detect, maxBytes: config.STAFF_DOCUMENT_MAX_SIZE, keyPrefix: 'x' });
  assert.strictEqual(big.code, 'DOC_TOO_LARGE');
  assert.match(big.error, /25 MB/);
});

test('every onboarding door reads the staff ceiling', () => {
  const onb = read('routes/onboarding.js');
  assert.match(onb, /const STAFF_MAX = \(config && config\.STAFF_DOCUMENT_MAX_SIZE\) \|\| MAX_BYTES;/);
  assert.match(onb, /limits: \{ fileSize: STAFF_MAX \}/);
  assert.match(onb, /maxBytes: STAFF_MAX, keyPrefix: item\.id/);
  assert.doesNotMatch(onb, /maxBytes: \(config && config\.MAX_FILE_SIZE\)/);
  assert.match(read('routes/caregiver.js'), /maxBytes: config\.STAFF_DOCUMENT_MAX_SIZE \|\| config\.MAX_FILE_SIZE/);
  assert.match(read('routes/welcomePacket.js'), /const maxPacket = config\.STAFF_DOCUMENT_MAX_SIZE \|\| config\.MAX_FILE_SIZE;/);
  const cg = read('public/caregiver.html');
  assert.doesNotMatch(cg, /10 \* 1024 \* 1024/);
  assert.strictEqual((cg.match(/25 \* 1024 \* 1024/g) || []).length, 3);
});

test('an oversized onboarding upload answers 400 naming the limit, not a 500', async () => {
  const VF = require('../onboarding/versionFlags');
  const user = { id: 'a1', name: 'Office', role: 'admin' };
  const app = express();
  app.use(require('../routes/onboarding')({
    db: { get: async () => null, set: async () => {} }, config: Object.assign({}, config, { STAFF_DOCUMENT_MAX_SIZE: 1024 }),
    logActivity: async () => {}, getUsers: async () => [user],
    authenticateToken: (req, res, next) => { req.user = user; next(); },
    drive: {}, detectFileType: detect, uuidv4: () => 'u',
    sourceLoader: { manualState: async () => ({ ok: true, currentVersion: '2.2', changeLog: VF.SEEDED_CHANGES.slice() }), checks: async () => ({ ok: true, sops: {}, library: {} }) }
  }));
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  try {
    const fd = new FormData();
    fd.append('file', new Blob([pdf(4096)], { type: 'application/pdf' }), 'big.pdf');
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/onboarding/me/items/C.4.01/files`, { method: 'POST', body: fd });
    assert.strictEqual(res.status, 400);
    const body = await res.json();
    assert.strictEqual(body.code, 'DOC_TOO_LARGE');
  } finally { server.close(); }
});
