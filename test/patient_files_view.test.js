'use strict';
// The patient's Documents screen lists each document once (owner, 2026-10-12),
// and patient uploads wait for a clinician's OpenEMR sign-in to file.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const PF = require('../public/patient-files');

const docs = {
  enrollmentPacket: { url: '/api/gfc/enrollment-packet.pdf' },
  consentPacketZip: { url: '/api/gfc/enrollment-packet.zip' },
  signedConsents: [
    { key: 'npp', label: 'Notice of Privacy Practices', status: 'signed', signedAt: '2026-10-01', copyUrl: '/api/gfc/consents/npp.pdf' },
    { key: 'serviceAgreement', label: 'Service Agreement', status: 'signed_offline', signedAt: '2026-09-01', copyUrl: '/api/gfc/consents/serviceAgreement.pdf' }
  ],
  checklist: [
    { kind: 'insuranceCard', label: 'Insurance card', status: 'received', required: true,
      files: [{ id: 'u1', fileName: 'card.jpg', status: 'received', source: 'client', url: '/api/gfc/documents/uploads/u1/file', uploadedAt: '2026-10-02' }] },
    { kind: 'photoId', label: 'Photo ID', status: 'missing', required: true,
      files: [{ id: 'u2', fileName: 'blurry.jpg', status: 'rejected', rejectionReason: 'Too blurry', source: 'client' }] },
    { kind: 'poa', label: 'Power of attorney', status: 'missing', required: false, files: [] }
  ],
  documents: []
};
const clinicalDocs = [
  { id: 'consent:npp', title: 'Notice of Privacy Practices', openable: true },
  { id: 'consent:serviceAgreement', title: 'Service Agreement', openable: true },
  { id: 'upload:u1', title: 'card.jpg', category: 'You sent this', openable: true },
  { id: 'upload:u9', title: 'discharge.pdf', category: 'From your care team', openable: true },
  { id: 'careplan:2', title: 'Plan of care, version 2', openable: true, date: '2026-10-03' },
  { id: 'result:r1', title: 'CBC', openable: true }
];

test('F1: every consent and every upload is listed once', () => {
  const { items } = PF.buildPatientFiles({ docs, clinicalDocs });
  const ids = items.map(i => i.id);
  assert.strictEqual(new Set(ids).size, ids.length, 'no id twice');
  assert.strictEqual(items.filter(i => /Privacy/.test(i.title)).length, 1);
  assert.strictEqual(items.filter(i => i.id === 'upload:u1').length, 1);
  assert.ok(ids.includes('upload:u9'), 'a shared staff filing outside the checklist is still listed');
});

test('F2: the packet is one row with the ZIP as its second link', () => {
  const { items } = PF.buildPatientFiles({ docs, clinicalDocs });
  assert.strictEqual(items.filter(i => /packet/i.test(i.title)).length, 1);
  const p = items.find(i => i.id === 'packet');
  assert.ok(p.extra && p.extra.open.type === 'zip');
  assert.strictEqual(items[0].id, 'packet', 'pinned first');
});

test('F3: a rejected upload is not a file on record; it stays on the needed item', () => {
  const { items } = PF.buildPatientFiles({ docs, clinicalDocs });
  assert.ok(!items.some(i => i.id === 'upload:u2'));
  const { needed, optional } = PF.neededFrom(docs.checklist);
  assert.deepStrictEqual(needed.map(r => r.kind), ['photoId']);
  assert.deepStrictEqual(optional.map(r => r.kind), ['poa']);
});

test('F4: groups are named and only shown when something is in them', () => {
  const { items, groups } = PF.buildPatientFiles({ docs, clinicalDocs });
  assert.deepStrictEqual(groups.map(g => g.key), ['forms', 'plans', 'results', 'sent', 'team']);
  assert.strictEqual(items.find(i => i.id === 'upload:u1').group, 'sent');
  assert.strictEqual(items.find(i => i.id === 'result:r1').group, 'results');
  const plain = PF.buildPatientFiles({ docs: { checklist: [] }, clinicalDocs: null });
  assert.deepStrictEqual(plain.groups, []);
});

test('F5: the portal draws its list from the shared module, not from its own sections', () => {
  const src = fs.readFileSync(path.join(__dirname, '../public/portal.html'), 'utf8');
  assert.ok(src.includes('<script src="/patient-files.js"></script>'));
  const at = src.indexOf('const GfcDocuments'); const comp = src.slice(at, src.indexOf('Session 4.3 — My Health', at));
  assert.ok(comp.includes('PF.buildPatientFiles('));
  assert.ok(!/Signed consents<\/p>|Your clinical record<\/p>/.test(comp), 'old duplicate sections are gone');
});

test('E1: an upload by someone with no OpenEMR sign-in waits, and a clinician files it', () => {
  const src = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const fn = src.slice(src.indexOf('const attemptEmrFiling'), src.indexOf('const markEmrFilingWaiting'));
  const check = fn.indexOf('emrAuth.statusFor(actor.id)');
  assert.ok(check > 0 && check < fn.indexOf('downloadFileBuffer'), 'the sign-in is checked before anything is read or sent');
  assert.match(fn, /\n\s+if \(!actorConnected\) \{\s*await markEmrFilingWaiting\(row\.id\);\s*return \{ filed: false, reason: 'WAITING_FOR_CLINICIAN' \};/);
  const chart = src.slice(src.indexOf("app.get('/api/clinical/patients/:clientId/chart'"));
  assert.ok(/\n\s+fileWaitingUploads\(client\.id, req\.user\);/.test(chart.slice(0, chart.indexOf('const puuid'))), 'opening the chart files what is waiting');
  const review = src.slice(src.indexOf("app.post('/api/gfc/admin/enrollment/:clientId/documents/:uploadId/review'"));
  assert.ok(/if \(decision === 'accepted'\) fileWaitingUploads\(/.test(review.slice(0, 4000)), 'accepting a document files it');
  const helper = src.slice(src.indexOf('const fileWaitingUploads'), src.indexOf('// The catch-up pass'));
  assert.ok(helper.includes('clinicalRoles.canClinicalWrite(user)'), 'a read-only viewer files nothing');
});

test('E2: the chart marks an upload that is waiting to file', () => {
  const repo = require('../clinicalRepository');
  const rows = repo.buildChartDocumentIndex({
    client: { id: 'c1' },
    clientUploads: [{ id: 'u1', clientId: 'c1', status: 'received', fileName: 'a.pdf', emrFilingWaitingSince: '2026-10-12' }]
  });
  assert.strictEqual(rows[0].emrWaiting, true);
  assert.strictEqual(rows[0].inChart, false);
});
