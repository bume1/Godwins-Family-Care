'use strict';
// Care Courses training for caregivers (owner, 2026-11-09): the 40-hour PCA
// collection and the 8-hour annual collection, proven by a certificate per
// course. No direct link to a single course exists, so each links its
// collection page.

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const CC = require('../onboarding/caregiverCourses');
const T = require('../onboarding/track');
const wp = require('../welcomePacketRepository');

const cert = (at) => ({ files: [{ id: 'f' + Math.random() }], at });
const allOf = (id, at) => Object.fromEntries(CC.COLLECTIONS[id].courses.map(c => [c.id, cert(at)]));

test('the catalog matches the Care Courses collection pages: 36 courses / 40 hours, 7 courses / 8 hours', () => {
  const sum = (id) => CC.COLLECTIONS[id].courses.reduce((s, c) => s + c.hours, 0);
  assert.strictEqual(CC.COLLECTIONS.PCA_40.courses.length, 36);
  assert.strictEqual(sum('PCA_40'), 40);
  assert.strictEqual(CC.COLLECTIONS.ANNUAL_8.courses.length, 7);
  assert.strictEqual(sum('ANNUAL_8'), 8);
  assert.match(CC.COLLECTIONS.PCA_40.url, /^https:\/\/www\.care-courses\.com\/collections\/georgia-personal-care-assistant-40-hours-initial-training$/);
  assert.match(CC.COLLECTIONS.ANNUAL_8.url, /^https:\/\/www\.care-courses\.com\/collections\/georgia-personal-care-assistant-annual-training$/);
  const ids = [].concat(...Object.values(CC.COLLECTIONS).map(c => c.courses.map(x => x.id)));
  assert.strictEqual(new Set(ids).size, ids.length);
});

test('progress counts hours from certificates; a returned certificate does not count', () => {
  const certs = { 'PCA-13': cert('2026-11-01T10:00:00Z'), 'PCA-01': Object.assign(cert('2026-11-01T10:00:00Z'), { returned: { reason: 'blurry' } }) };
  const p = CC.progress('PCA_40', certs, 'initial');
  assert.strictEqual(p.hoursDone, 2);
  assert.strictEqual(p.coursesDone, 1);
  assert.strictEqual(p.complete, false);
});

test('twenty hours marks ready for clients; all 36 completes the forty-hour item', () => {
  const rows = wp.buildChecklist({}, [], {}, []);
  const twenty = {};
  let h = 0;
  for (const c of CC.COLLECTIONS.PCA_40.courses) { if (h >= 20) break; twenty[c.id] = cert('2026-11-02T10:00:00Z'); h += c.hours; }
  // The supervisor's step is recorded, so only the missing certificates can hold it open.
  const t1 = T.buildTrack({ inputs: { chapter: 'A', fortyHourRoute: true }, record: { courseCerts: { PCA_40: { initial: twenty } }, items: { 'A.6.07': { steps: { 0: { at: '2026-11-05' } } } } }, today: '2026-11-09', packetRows: rows });
  assert.strictEqual(t1.trainingCourses.find(c => c.id === 'PCA_40').readyForClients, true);
  assert.notStrictEqual(t1.items.find(i => i.id === 'A.6.07').status, 'COMPLETE');
  const rec = { courseCerts: { PCA_40: { initial: allOf('PCA_40', '2026-11-05T10:00:00Z') } }, items: { 'A.6.07': { steps: { 0: { at: '2026-11-05' } } } } };
  const t2 = T.buildTrack({ inputs: { chapter: 'A', fortyHourRoute: true }, record: rec, today: '2026-11-09', packetRows: rows });
  assert.strictEqual(t2.items.find(i => i.id === 'A.6.07').status, 'COMPLETE');
});

test('every caregiver sees the annual collection; only the forty-hour route sees the PCA program', () => {
  const ids = (inputs) => T.buildTrack({ inputs: Object.assign({ chapter: 'A' }, inputs), record: {}, today: '2026-11-09' }).trainingCourses.map(c => c.id);
  assert.deepStrictEqual(ids({}), ['GFC_CORE', 'ANNUAL_8']);
  assert.deepStrictEqual(ids({ fortyHourRoute: true }), ['GFC_CORE', 'PCA_40', 'ANNUAL_8']);
  // A PCA, CNA or HHA certificate (or nursing) means no forty-hour program,
  // even with the box ticked: she does the remaining training only.
  assert.deepStrictEqual(ids({ fortyHourRoute: true, holdsCareCertificate: true }), ['GFC_CORE', 'ANNUAL_8']);
  assert.deepStrictEqual(ids({ fortyHourRoute: true, caregiverClass: 'NURSING' }), ['GFC_CORE', 'ANNUAL_8']);
  assert.ok(!T.composeChecklist({ chapter: 'A', fortyHourRoute: true, holdsCareCertificate: true }).some(i => i.id === 'A.6.07'));
  assert.deepStrictEqual(T.buildTrack({ inputs: { chapter: 'C' }, record: {} }).trainingCourses, []);
});

test('finishing the year\'s seven certificates records the annual training duty done', () => {
  const rec = { courseCerts: { ANNUAL_8: { 2026: allOf('ANNUAL_8', '2026-10-01T10:00:00Z') } } };
  const r = T.buildTrack({ inputs: { chapter: 'A', startDate: '2025-01-01' }, record: rec, today: '2026-11-09' }).renewals.recurring.find(x => x.id === 'A.10.R4');
  assert.strictEqual(r.lastDoneOn, '2026-10-01');
  assert.strictEqual(r.nextDue, '2027-10-01');
  const partial = { courseCerts: { ANNUAL_8: { 2026: { 'ANN-01': cert('2026-10-01T10:00:00Z') } } } };
  assert.strictEqual(T.buildTrack({ inputs: { chapter: 'A', startDate: '2025-01-01' }, record: partial, today: '2026-11-09' }).renewals.recurring.find(x => x.id === 'A.10.R4').lastDoneOn, null);
});

test('a caregiver uploads a certificate through the route; it lands on her record and in the staff documents', async () => {
  const VF = require('../onboarding/versionFlags');
  const store = { onboarding_records: [{ id: 'r1', userId: 'cg1', userName: 'Cara Giver', inputs: T.normalizeInputs({ chapter: 'A' }), items: {}, training: {}, determinations: {} }] };
  const db = { get: async (k) => (k in store ? JSON.parse(JSON.stringify(store[k])) : null), set: async (k, v) => { store[k] = JSON.parse(JSON.stringify(v)); } };
  const me = { id: 'cg1', name: 'Cara Giver', role: 'vendor', accountType: 'caregiver', licenseLevel: 'pca' };
  const app = express(); app.use(express.json());
  app.use(require('../routes/onboarding')({
    db, config: require('../config'), logActivity: async () => {}, getUsers: async () => [me],
    authenticateToken: (req, res, next) => { req.user = me; next(); },
    drive: { uploadStaffDocumentFile: async () => ({ fileId: 'drive1' }), downloadFileBuffer: async () => Buffer.from('%PDF-1.4') },
    detectFileType: (b) => (b.slice(0, 4).toString() === '%PDF' ? 'application/pdf' : null), uuidv4: () => 'u' + Math.random(),
    sourceLoader: { manualState: async () => ({ ok: true, currentVersion: '2.2', changeLog: VF.SEEDED_CHANGES.slice() }), checks: async () => ({ ok: true, sops: {}, library: {} }) }
  }));
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const me1 = await (await fetch(`${base}/api/onboarding/me`)).json();
    assert.strictEqual(me1.track.chapter.id, 'A');
    const fd = new FormData(); fd.append('file', new Blob([Buffer.from('%PDF-1.4 cert')], { type: 'application/pdf' }), 'cert.pdf');
    const up = await fetch(`${base}/api/onboarding/me/courses/ANNUAL_8/ANN-01/certificate`, { method: 'POST', body: fd });
    assert.strictEqual(up.status, 200);
    const after = await (await fetch(`${base}/api/onboarding/me`)).json();
    const annual = after.track.trainingCourses.find(c => c.id === 'ANNUAL_8');
    assert.strictEqual(annual.coursesDone, 1);
    assert.ok(store.caregiver_documents.some(d => d.kind === 'training_certificate'));
    const bad = await fetch(`${base}/api/onboarding/me/courses/ANNUAL_8/NOPE/certificate`, { method: 'POST', body: fd });
    assert.strictEqual(bad.status, 404);
  } finally { server.close(); }
});

test('every caregiver takes the HIPAA and Introduction to Dementia Care modules, each with its own Care Courses link', () => {
  const core = CC.COLLECTIONS.GFC_CORE.courses;
  assert.deepStrictEqual(core.map(c => c.url), ['https://www.care-courses.com/company/qj5dz/module-detail', 'https://www.care-courses.com/company/q38w4/module-detail']);
  const rows = wp.buildChecklist({}, [], {}, []);
  const none = T.buildTrack({ inputs: { chapter: 'A' }, record: {}, today: '2026-11-09', packetRows: rows }).items.find(i => i.id === 'A.7.04');
  assert.notStrictEqual(none.status, 'COMPLETE');
  const both = T.buildTrack({ inputs: { chapter: 'A' }, record: { courseCerts: { GFC_CORE: { initial: allOf('GFC_CORE', '2026-11-05T10:00:00Z') } } }, today: '2026-11-09', packetRows: rows }).items.find(i => i.id === 'A.7.04');
  assert.strictEqual(both.status, 'COMPLETE');
});

test('the certificate fact comes from the welcome packet, never from the Setup form', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'routes', 'onboarding.js'), 'utf8');
  assert.match(src, /const CARE_CERTIFICATES = \['pca', 'cna', 'hha', 'lpn', 'rn'\];/);
  assert.match(src, /\{ chapter, holdsCareCertificate: false \}/);
  assert.match(src, /inputs: withPacketFacts\(rec\.inputs, pk\)/);
});
