'use strict';
// The staff welcome packet (owner, 2026-11-09): the caregiver welcome packet's
// format for every other role, and every completed packet readable by the
// admin team from User Management.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const express = require('express');
const wp = require('../welcomePacketRepository');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

const SIG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const ANSWERS = { firstName: 'Nia', lastName: 'Provider', mobilePhone: '404-555-0100', email: 'nia@gfc.com',
  homeAddress: '1 Peach St, Atlanta, GA', homeZip: '30301', emergencyName: 'Ola', emergencyRelationship: 'Sister',
  emergencyPhone: '404-555-0101', learningStyles: ['hands_on', 'walkthrough'], contactPreference: ['text'] };

async function mount(as) {
  const store = { caregiver_availability: [] };
  const db = { get: async (k) => (k in store ? JSON.parse(JSON.stringify(store[k])) : null), set: async (k, v) => { store[k] = JSON.parse(JSON.stringify(v)); } };
  const users = {
    np: { id: 'np', name: 'Nia Provider', email: 'nia@gfc.com', role: 'user', accountType: 'provider', clinicalRole: 'provider', hasClinicalAccess: true },
    admin: { id: 'admin', name: 'Office', role: 'admin', accountType: 'admin' },
    cg: { id: 'cg', name: 'Cara Giver', role: 'vendor', accountType: 'caregiver', licenseLevel: 'pca' }
  };
  let who = as;
  const app = express(); app.use(express.json({ limit: '5mb' }));
  app.use(require('../routes/staffPortal')({
    db, logActivity: async () => {}, getUsers: async () => Object.values(users),
    authenticateToken: (req, res, next) => { req.user = users[who]; next(); },
    drive: {}, uuidv4: () => 'u' + Math.random(), detectFileType: () => null, enrollmentSummary: () => ({})
  }));
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (m, p, b) => fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { store, call, as: (w) => { who = w; }, close: () => server.close() };
}

test('the staff packet uses the caregiver packet\'s own About and Emergency fields, plus how you learn and how to reach you', () => {
  const cgAbout = wp.PACKET_SECTIONS.find(s => s.id === 'about').fields;
  const st = wp.STAFF_PACKET_SECTIONS;
  st.find(s => s.id === 'about').fields.forEach(f => assert.ok(cgAbout.includes(f), `${f.id} is the caregiver packet's own field`));
  assert.ok(!st.find(s => s.id === 'about').fields.some(f => f.id === 'dateOfBirth'));
  assert.strictEqual(st.find(s => s.id === 'emergency_contact').fields, wp.PACKET_SECTIONS.find(s => s.id === 'emergency_contact').fields);
  const learning = st.find(s => s.id === 'learning').fields;
  assert.deepStrictEqual(learning.map(f => f.label), ['How do you best absorb new information?', 'Anything else that helps you learn', 'How do you prefer to be contacted?']);
  // No references and no start date (owner).
  const ids = [].concat(...st.map(s => s.fields.map(f => f.id)));
  assert.ok(!ids.some(i => /^references?|startDate|earliestStart/i.test(i)), ids.join(","));
});

test('a staff member saves, is held to availability and the required answers, signs, and downloads the packet', async () => {
  const h = await mount('np');
  try {
    let r = await (await h.call('GET', '/api/my/welcome-packet')).json();
    assert.strictEqual(r.status, 'not_started');
    assert.strictEqual(r.data.email, 'nia@gfc.com');
    r = await (await h.call('PUT', '/api/my/welcome-packet', { data: Object.assign({}, ANSWERS, { learningStyles: ['made_up'] }) })).json();
    assert.ok(r.dropped.includes('learningStyles'), 'an option the packet does not offer is refused');
    let s = await h.call('POST', '/api/my/welcome-packet/submit', { data: ANSWERS, signaturePng: SIG, printedName: 'Nia Provider' });
    assert.strictEqual(s.status, 400);
    assert.ok((await s.json()).missing.some(m => m.id === 'availability'), 'availability is required');
    h.store.caregiver_availability.push({ id: 'a', caregiver_id: 'np', effective_from: '2026-12-01', windows: [{ day: 'Mon', start: '09:00', end: '17:00' }], submitted_at: '2026-11-09' });
    s = await h.call('POST', '/api/my/welcome-packet/submit', { data: ANSWERS, signaturePng: SIG, printedName: 'Nia Provider' });
    assert.strictEqual(s.status, 200, await s.clone().text());
    assert.strictEqual((await h.call('PUT', '/api/my/welcome-packet', { data: ANSWERS })).status, 409, 'a signed packet does not take edits');
    const pdf = await h.call('GET', '/api/my/welcome-packet/signed.pdf');
    assert.strictEqual(pdf.status, 200);
    assert.strictEqual(Buffer.from(await pdf.arrayBuffer()).slice(0, 4).toString(), '%PDF');
    // The admin team reads it, with the signed PDF.
    h.as('admin');
    const a = await (await h.call('GET', '/api/my/admin/welcome/np')).json();
    assert.strictEqual(a.kind, 'staff');
    assert.strictEqual(a.status, 'submitted');
    assert.strictEqual(a.data.contactPreference[0], 'text');
    assert.ok(a.availability);
    assert.strictEqual((await h.call('GET', '/api/my/admin/welcome/np/signed.pdf')).status, 200);
  } finally { h.close(); }
});

test('a caregiver is sent to their own packet; the admin team still opens a caregiver\'s completed packet', async () => {
  const h = await mount('cg');
  try {
    assert.strictEqual((await h.call('GET', '/api/my/welcome-packet')).status, 409);
    h.store.welcome_packets = [{ caregiver_id: 'cg', status: 'submitted', signed_at: '2026-11-05T10:00:00Z', data: { firstName: 'Cara' }, office: {}, signature_png: SIG, printed_name: 'Cara Giver' }];
    h.as('admin');
    const a = await (await h.call('GET', '/api/my/admin/welcome/cg')).json();
    assert.strictEqual(a.kind, 'caregiver');
    assert.strictEqual(a.status, 'submitted');
    const pdf = await h.call('GET', '/api/my/admin/welcome/cg/signed.pdf');
    assert.strictEqual(pdf.status, 200);
    // Only the admin team.
    h.as('np');
    assert.strictEqual((await h.call('GET', '/api/my/admin/welcome/cg')).status, 403);
  } finally { h.close(); }
});

test('one packet UI: the caregiver app and My GFC share the field renderer and signature pad', () => {
  const ui = read('public/welcome-packet-ui.js');
  assert.match(ui, /^const PacketField = \(\{ field, value, onChange, imported \}\) => \{/m);
  assert.match(ui, /^const SignaturePad = \(\{ onChange \}\) => \{/m);
  assert.match(ui, /window\.GFCWelcomePacketUI = \{ PacketField, SignaturePad, StaffWelcomePacket, downloadPdf \};/);
  const cg = read('public/caregiver.html');
  assert.match(cg, /const \{ PacketField, SignaturePad \} = window\.GFCWelcomePacketUI;/);
  assert.doesNotMatch(cg, /^const (PacketField|SignaturePad) = \(/m, 'the caregiver app keeps no copy of its own');
  assert.match(cg, /<script type="text\/babel" src="\/welcome-packet-ui\.js"><\/script>/);
  assert.match(read('public/my.html'), /<script type="text\/babel" src="\/welcome-packet-ui\.js"><\/script>/);
  assert.match(read('public/my-gfc.js'), /<UI\.StaffWelcomePacket /);
  const hub = read('public/admin-hub.html');
  assert.match(hub, /<WelcomePacketSection token=\{token\} userId=\{editingUser\.id\} userName=\{editingUser\.name\} \/>/);
});

test('signing the staff packet is blocked while viewing as someone else', () => {
  assert.match(read('impersonation.js'), /\/\^\\\/api\\\/my\\\/welcome-packet\\\/submit\$\//);
});

test('the admin hub\'s bare primary color has a shade, so bg-primary and text-primary are not colorless', () => {
  assert.match(read('public/admin-hub.html'), /primary: \{ DEFAULT: '#033D50',/);
});
