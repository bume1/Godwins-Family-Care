'use strict';
// Every onboarding item says what it is (owner, 2026-11-09), and the Playbook
// link and the description's provenance are the office's alone.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const T = require('../onboarding/track');
const DESC = require('../onboarding/descriptions');

const allItems = () => {
  const seen = new Map();
  for (const ch of Object.values(T.CHAPTERS)) for (const it of ch.ITEMS) seen.set(it.id, it);
  return [...seen.values()];
};

test('every item in every chapter has a description, and no description names an unknown item', () => {
  const ids = new Set(allItems().map(i => i.id).concat('WELCOME'));
  for (const id of ids) {
    const d = DESC.descriptionFor(id);
    assert.ok(d && d.text && d.text.length > 20, `no description for ${id}`);
    assert.ok(DESC.SOURCES.includes(d.source), `${id} source ${d && d.source}`);
  }
  for (const id of Object.keys(DESC.DESCRIPTIONS)) assert.ok(ids.has(id), `description for unknown item ${id}`);
});

test('the owner\'s own example reads exactly as the Playbook wrote it', () => {
  assert.deepStrictEqual(DESC.descriptionFor('C.4.01'), { source: 'PLAYBOOK',
    text: 'Verify Georgia registered nurse licensure and advanced practice authorization, and search the Composite Medical Board record for any current or prior nurse protocol agreement and the physician named on it. A restricted, suspended, surrendered, or non-renewed license ends the process.' });
  for (const id of ['A.6.08', 'C.5.06', 'C.6.10', 'D.6.04', 'F.CC.01']) assert.strictEqual(DESC.descriptionFor(id).source, 'DRAFTED', id);
});

test('the track carries the description to everyone, and its source to the office only', () => {
  const office = T.buildTrack({ inputs: { chapter: 'C' }, record: {}, today: '2026-11-09', audience: 'office' });
  const mine = T.buildTrack({ inputs: { chapter: 'C' }, record: {}, today: '2026-11-09' });
  const o = office.items.find(i => i.id === 'C.4.01'); const m = mine.items.find(i => i.id === 'C.4.01');
  assert.strictEqual(o.description, m.description);
  assert.ok(m.description.startsWith('Verify Georgia'));
  assert.strictEqual(o.descriptionSource, 'PLAYBOOK');
  assert.strictEqual(m.descriptionSource, undefined);
});

test('the Playbook link goes to the office only', () => {
  const route = fs.readFileSync(path.join(__dirname, '..', 'routes', 'onboarding.js'), 'utf8');
  assert.match(route, /it\.sourceUrl = audience === 'office' && it\.ref && it\.ref\.source \? driveViewUrl\(it\.ref\.source\) : null;/);
  const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'onboarding.html'), 'utf8');
  assert.match(page, /\{office && item\.sourceUrl && <div/);
  assert.match(page, /\{item\.description && <p className="desc"/, 'the side panel shows it');
  assert.match(page, /i\.description && <div className="meta"/, 'the list row shows it');
});

test('over the real routes: staff never receive the Playbook link; the office does', async () => {
  const express = require('express');
  const VF = require('../onboarding/versionFlags');
  const store = {};
  const db = { get: async (k) => (k in store ? JSON.parse(JSON.stringify(store[k])) : null), set: async (k, v) => { store[k] = JSON.parse(JSON.stringify(v)); } };
  const USERS = { admin: { id: 'admin', name: 'Office', role: 'admin' }, np: { id: 'np', name: 'Nia', role: 'user', accountType: 'provider', clinicalRole: 'provider', hasClinicalAccess: true } };
  const app = express(); app.use(express.json());
  app.use(require('../routes/onboarding')({ db, config: {}, logActivity: async () => {}, getUsers: async () => Object.values(USERS),
    authenticateToken: (req, res, next) => { req.user = USERS[req.headers['x-as']]; next(); }, drive: {}, detectFileType: () => null, uuidv4: () => Math.random().toString(36).slice(2),
    sourceLoader: { manualState: async () => ({ ok: true, currentVersion: '2.2', changeLog: VF.SEEDED_CHANGES.slice() }), checks: async () => ({ ok: true, sops: {}, library: {} }) } }));
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (as, m, p, b) => fetch(base + p, { method: m, headers: { 'x-as': as, 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }).then(r => r.json());
  try {
    await call('admin', 'PUT', '/api/onboarding/admin/people/np/inputs', { chapter: 'C' });
    const mine = (await call('np', 'GET', '/api/onboarding/me')).track.items;
    const office = (await call('admin', 'GET', '/api/onboarding/admin/people/np')).track.items;
    assert.ok(mine.every(i => !i.sourceUrl), 'a staff member got a Playbook link');
    assert.ok(office.some(i => i.sourceUrl), 'the office lost its Playbook link');
    assert.ok(mine.find(i => i.id === 'C.4.01').description.startsWith('Verify Georgia'));
  } finally { server.close(); }
});
