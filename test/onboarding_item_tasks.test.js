'use strict';
// Owner, 2026-11-09: each onboarding item lists its tasks as sub-bullets, and
// what a caregiver sent or signed in the welcome wizard shows on the item it
// belongs to, without a separate "welcome packet" list.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const express = require('express');
const T = require('../onboarding/track');
const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'onboarding.html'), 'utf8');

async function mount() {
  const VF = require('../onboarding/versionFlags');
  const store = {
    onboarding_records: [{ id: 'r1', userId: 'cg1', userName: 'Cara Giver', inputs: T.normalizeInputs({ chapter: 'A' }), items: {}, training: {}, determinations: {} }],
    welcome_packets: [{ caregiver_id: 'cg1', data: {}, office: {} }],
    caregiver_documents: [
      { id: 'd1', caregiver_id: 'cg1', kind: 'tb_test', status: 'accepted', file_name: 'tb.pdf', drive_file_id: 'drv1', mime_type: 'application/pdf', uploaded_at: '2026-11-01' },
      { id: 'd2', caregiver_id: 'cg1', kind: 'drug_screen', status: 'rejected', file_name: 'blurry.jpg', drive_file_id: 'drv2', uploaded_at: '2026-11-02' },
      { id: 'd3', caregiver_id: 'other', kind: 'tb_test', status: 'accepted', file_name: 'theirs.pdf', drive_file_id: 'drv3', uploaded_at: '2026-11-02' }
    ],
    caregiver_attestations: [{ id: 'a1', caregiver_id: 'cg1', kind: 'registry_attestation', version: 'x', signed_at: '2026-11-03T10:00:00Z', signature: null, answers: {} }]
  };
  const db = { get: async (k) => (k in store ? JSON.parse(JSON.stringify(store[k])) : null), set: async (k, v) => { store[k] = JSON.parse(JSON.stringify(v)); } };
  const office = { id: 'a1', name: 'Office', role: 'admin' };
  const cg = { id: 'cg1', name: 'Cara Giver', role: 'vendor', accountType: 'caregiver', licenseLevel: 'pca' };
  const fetched = [];
  const app = express(); app.use(express.json());
  app.use(require('../routes/onboarding')({
    db, config: require('../config'), logActivity: async () => {}, getUsers: async () => [office, cg],
    authenticateToken: (req, res, next) => { req.user = office; next(); },
    drive: { downloadFileBuffer: async (id) => { fetched.push(id); return Buffer.from('%PDF-1.4'); } },
    detectFileType: () => 'application/pdf', uuidv4: () => 'u' + Math.random(),
    sourceLoader: { manualState: async () => ({ ok: true, currentVersion: '2.2', changeLog: VF.SEEDED_CHANGES.slice() }), checks: async () => ({ ok: true, sops: {}, library: {} }) }
  }));
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => server.close(), fetched };
}

test('her welcome-wizard upload and signed form show on the item they belong to, and open from it', async () => {
  const h = await mount();
  try {
    const t = (await (await fetch(`${h.base}/api/onboarding/admin/people/cg1`)).json()).track;
    const tb = t.items.find(i => i.id === 'A.6.03');
    assert.deepStrictEqual(tb.files.map(f => [f.id, f.name]), [['packet:d1', 'tb.pdf']]);
    // A rejected upload is not evidence and is not listed.
    assert.strictEqual(t.items.find(i => i.id === 'A.6.04').files.length, 0);
    const consents = t.items.find(i => i.id === 'A.5.04');
    assert.ok(consents.files.some(f => f.id === 'form:registry_attestation' && /\(signed\)$/.test(f.name)));
    // Opens through the item.
    const r1 = await fetch(`${h.base}/api/onboarding/admin/people/cg1/items/A.6.03/files/packet:d1`);
    assert.strictEqual(r1.status, 200);
    assert.deepStrictEqual(h.fetched, ['drv1']);
    const r2 = await fetch(`${h.base}/api/onboarding/admin/people/cg1/items/A.5.04/files/form:registry_attestation`);
    assert.strictEqual(r2.status, 200);
    assert.strictEqual(r2.headers.get('content-type'), 'application/pdf');
    // Someone else's document, or one of hers through the wrong item, is not reachable.
    assert.strictEqual((await fetch(`${h.base}/api/onboarding/admin/people/cg1/items/A.6.03/files/packet:d3`)).status, 404);
    assert.strictEqual((await fetch(`${h.base}/api/onboarding/admin/people/cg1/items/A.6.04/files/packet:d1`)).status, 404);
  } finally { h.close(); }
});

test('the list shows each item\'s tasks as sub-bullets, in both views, with one step wording', () => {
  assert.match(page, /^const ItemTasks = \(\{ item, subjectName, viewerIsSubject, office \}\) => \{/m);
  assert.match(page, /<ItemTasks item=\{i\} subjectName=\{String\(t\.person\.name \|\| ''\)\.split\(' '\)\[0\]\} viewerIsSubject=\{false\} office \/>/);
  assert.match(page, /\{its\.map\(i => <ItemRow key=\{i\.id\} i=\{i\} onOpen=\{setOpenItem\} expanded \/>\)\}/);
  // The side panel and the list say who does a step the same way.
  assert.match(page, /<b>\{stepWho\(s, subject, viewerIsSubject\)\}<\/b> \{stepVerb\(s, viewerIsSubject\)\}/);
  assert.match(page, /\{stepWho\(s, subjectName, viewerIsSubject\)\} \{stepVerb\(s, viewerIsSubject\)\}/);
  // Owner: no separate "welcome packet" section in the list.
  const tasks = page.slice(page.indexOf('const ItemTasks'), page.indexOf('const ItemRow'));
  assert.doesNotMatch(tasks, /welcome packet|item\.packet/i);
  // Home's short list stays compact.
  assert.doesNotMatch(page, /mine\.slice\(0, 6\)\.map\(i => <ItemRow key=\{i\.id\} i=\{i\} onOpen=\{setOpenItem\} expanded/);
});

test('the staff member reads "You send", never "You sends"', () => {
  const src = page.slice(page.indexOf('const stepWho'), page.indexOf('const stepVerb'));
  const words = page.slice(page.indexOf('const YOU_WORD'), page.indexOf('const stepVerb'));
  assert.ok(src.length > 0);
  // eslint-disable-next-line no-new-func
  const YOU_WORD = new Function(`${words}; return YOU_WORD;`)();
  ['SUBMIT', 'SIGN', 'ACKNOWLEDGE', 'COMPLETE', 'VERIFY', 'RECORD', 'PROVISION', 'EXECUTE', 'OBSERVE'].forEach(k => assert.ok(YOU_WORD[k], k));
  assert.strictEqual(YOU_WORD.SUBMIT, 'send');
  assert.strictEqual(YOU_WORD.VERIFY, 'verify');
});
