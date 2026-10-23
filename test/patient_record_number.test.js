// The patient's OpenEMR record number (MRN) reaches the app record and the
// banner. Before this, buildPatientBanner read client.openEmrRecordNumber and
// nothing ever wrote it, so every chart showed no MRN.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const repo = require('../clinicalRepository');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const stripComments = (s) => s.replace(/^[ \t]*\/\/.*$/gm, '');

test('recordNumberOf prefers pubpid, falls back to pid, never invents one', () => {
  assert.strictEqual(repo.recordNumberOf({ pid: 7, pubpid: 'GFC-0042' }), 'GFC-0042');
  assert.strictEqual(repo.recordNumberOf({ pid: 7, pubpid: '  ' }), '7');
  assert.strictEqual(repo.recordNumberOf({ pid: 7, pubpid: null }), '7');
  assert.strictEqual(repo.recordNumberOf({ pid: 0, pubpid: '' }), null);
  assert.strictEqual(repo.recordNumberOf({}), null);
  assert.strictEqual(repo.recordNumberOf(null), null);
});

test('the banner shows the stored record number', () => {
  const b = repo.buildPatientBanner({
    client: { id: 'c1', name: 'Test', openEmrPatientId: 'u1', openEmrRecordNumber: '12' },
    linked: true, emrAllergies: null, facility: null, lastVisitAt: null, today: '2026-10-23'
  });
  assert.strictEqual(b.mrn, '12');
});

test('openemr exposes getRecordNumber from the standard patient row', () => {
  const src = stripComments(read('openemr.js'));
  const m = src.match(/async getRecordNumber\(puuid\) \{([\s\S]*?)\n    \},/);
  assert.ok(m, 'getRecordNumber missing');
  assert.match(m[1], /apiUrl\(`patient\/\$\{encodeURIComponent\(puuid\)\}`\)/);
  assert.match(m[1], /pubpid: r \? r\.pubpid/, "must return the row's pubpid");
  assert.match(m[1], /logEmrAccess/);
});

test('the record number is written at link, read on chart open, and cleared on relink', () => {
  const src = stripComments(read('server.js'));
  const helper = src.match(/const ensureRecordNumber = async \(client, actor\) => \{([\s\S]*?)\n\};/);
  assert.ok(helper, 'ensureRecordNumber missing');
  assert.match(helper[1], /openEmrRecordNumberFor === client\.openEmrPatientId/, 'must key the cache to the linked uuid');
  assert.match(helper[1], /users\[idx\]\.openEmrRecordNumber = mrn/, 'must persist to the record');
  assert.match(helper[1], /catch/, 'must never fail the chart');
  assert.match(src, /users\[idx\]\.openEmrRecordNumberFor !== puuid\) \{\s*delete users\[idx\]\.openEmrRecordNumber;/, 'relink must drop the old number');
  assert.match(src, /\n    const openEmrRecordNumber = await ensureRecordNumber\(users\[idx\], req\.user\);/, 'link must read it');
  assert.match(src, /\n    await ensureRecordNumber\(client, req\.user\);\n    const banner = clinicalRepo\.buildPatientBanner\(/, 'chart must read it before the banner');
  assert.match(src, /\n      await ensureRecordNumber\(client, req\.user\);\n      banner = clinicalRepo\.buildPatientBanner\(/, 'pre-visit packet must read it before the banner');
});

test('the patient list carries the MRN only for a linked patient', () => {
  const src = stripComments(read('server.js'));
  assert.match(src, /mrn: \(u\.openEmrPatientId && u\.openEmrRecordNumber\) \|\| null/);
});
