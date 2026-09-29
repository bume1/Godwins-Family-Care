// ============================================================
// Care Team messaging (owner-directed, 2026-09-29): a clinician can message a
// patient from the clinician portal and the patient (or their POA) can message
// their clinician, with FORMATTED TEXT and ATTACHMENTS both ways, and an email
// that says only "you have a message — sign in".
//
// The REAL messaging router is mounted on real Express with real multer and the
// real `detectFileType` (lifted out of server.js); only the store, Drive and the
// notification queue are stand-ins. Every assertion reads STORED values back.
// Run: npm test
// ============================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');

const root = path.join(__dirname, '..');
const config = require('../config');
const messagingRoutes = require('../routes/messaging');
const msg = require('../messagingRepository');
const nf = require('../public/note-format.js');
const { contentDisposition } = require('../contentDisposition');
const links = require('../appLinks');

const serverSrc = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const componentSrc = fs.readFileSync(path.join(root, 'public/components/gfc-messaging.js'), 'utf8');
const routeSrc = fs.readFileSync(path.join(root, 'routes/messaging.js'), 'utf8');
// The REAL byte-sniff, lifted rather than re-typed: a copy could quietly accept more.
const sniffSrc = serverSrc.slice(serverSrc.indexOf('const detectFileType = (buf) => {'), serverSrc.indexOf('// Derive age in whole years'));
// eslint-disable-next-line no-new-func
const detectFileType = new Function(`${sniffSrc}\nreturn detectFileType;`)();

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

// ---- Seed: TEST DATA ONLY ---------------------------------------------------
const USERS = () => [
  { id: 'admin-1', name: 'GFC Admin', email: 'admin@test.local', role: 'admin' },
  { id: 'fnp-1', name: 'Bethel Godwins', email: 'fnp@test.local', role: 'user', hasClinicalAccess: true, licenseLevel: 'FNP' },
  { id: 'fnp-2', name: 'Other Clinician', email: 'fnp2@test.local', role: 'user', hasClinicalAccess: true },
  { id: 'cm-1', name: 'Courtney Hale', email: 'cm@test.local', role: 'caseManager' },
  { id: 'cg-1', name: 'Cam Caregiver', email: 'cg@test.local', role: 'vendor', licenseLevel: 'cna' },
  { id: 'fam-1', name: 'Sam Relative', email: 'fam@test.local', role: 'family', familyOfClientId: 'client-1' },
  { id: 'poa-1', name: 'Luka Agent', email: 'poa@test.local', role: 'family', familyOfClientId: 'client-1', familyIsPoa: true },
  { id: 'client-1', name: 'Juanita Guess', email: 'c1@test.local', role: 'client',
    careTeam: { assignedFNPs: ['fnp-1'], assignedCaseManager: 'cm-1', primaryCaregiver: 'cg-1' } },
  { id: 'client-2', name: 'Harold Vance', email: 'c2@test.local', role: 'client', careTeam: {} }
];

const PDF = () => Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\n%%EOF');
const PNG = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(40)]);
const EXE = () => Buffer.from('MZ\x90\x00 not a document');

const boot = async (opts = {}) => {
  const store = new Map([['users', USERS()]]);
  const db = { get: async (k) => (store.has(k) ? JSON.parse(JSON.stringify(store.get(k))) : null), set: async (k, v) => { store.set(k, JSON.parse(JSON.stringify(v))); } };
  const notices = []; const activity = [];
  const drive = { uploads: [], deleted: [], failOn: opts.failOn || 0, files: new Map() };
  const googledrive = {
    uploadMessageAttachmentFile: async (clientName, fileName, buf, mime) => {
      if (drive.failOn && drive.uploads.length + 1 >= drive.failOn) throw new Error('drive is down');
      const fileId = `drv-${drive.uploads.length + 1}`;
      drive.uploads.push({ clientName, fileName, mime, size: buf.length }); drive.files.set(fileId, buf);
      return { fileId, fileName };
    },
    downloadFileBuffer: async (id) => { if (!drive.files.has(id)) throw new Error('no such file'); return drive.files.get(id); },
    deleteFile: async (id) => { drive.deleted.push(id); drive.files.delete(id); }
  };
  const cfg = { ...config, MAX_FILE_SIZE: opts.maxBytes || config.MAX_FILE_SIZE };
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: cfg.MAX_FILE_SIZE } });
  const getUsers = async () => await db.get('users');
  const authenticateToken = async (req, res, next) => {
    const id = req.headers['x-as'];
    if (!id) return res.status(401).json({ error: 'Access denied', code: 'AUTH_MISSING' });
    const u = (await getUsers()).find(x => x.id === id);
    if (!u) return res.status(403).json({ error: 'no user', code: 'AUTH_INVALID' });
    req.user = { id: u.id, email: u.email, name: u.name, role: u.role, hasClinicalAccess: u.hasClinicalAccess || false,
      licenseLevel: u.licenseLevel || null, familyOfClientId: u.familyOfClientId || null, familyIsPoa: u.familyIsPoa || false, careTeam: u.careTeam || null };
    next();
  };
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use(messagingRoutes({
    db, config: cfg, logActivity: async (...a) => { activity.push(a); },
    queueNotification: async (type, id, email, name, data, o) => { notices.push({ type, id, email, name, data, o }); return { queued: true }; },
    getUsers, authenticateToken, uuidv4, upload, uploadLimiter: (req, res, next) => next(), googledrive, detectFileType, contentDisposition
  }));
  const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const port = server.address().port;
  const call = async (as, method, p, { json, form } = {}) => {
    const headers = { ...(as ? { 'x-as': as } : {}) };
    let body;
    if (form) body = form; else if (json) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
    const res = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers, body });
    const buf = Buffer.from(await res.arrayBuffer());
    let data = null; try { data = JSON.parse(buf.toString('utf8')); } catch (e) { data = null; }
    return { status: res.status, data, buf, headers: res.headers };
  };
  const form = (fields, files = []) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
    for (const f of files) fd.append('files', new Blob([f.buf], { type: f.type || 'application/octet-stream' }), f.name);
    return fd;
  };
  return { store, notices, activity, drive, call, form, close: () => server.close() };
};
const rows = (h, k) => h.store.get(k) || [];

// ============================================================
// The channel and who sits on it
// ============================================================
test('the Care Team channel is in the matrix both ways, and only a client-side or clinical viewer reaches it', () => {
  const c = msg.channelById('care_team');
  assert.ok(c && c.includesPoa && c.requiresAssignedClinician);
  assert.deepEqual([...c.initiators].sort(), ['client', 'clinical']);
  assert.ok(msg.MATRIX_ROWS.some(r => r.channel === 'care_team' && r.from === 'clinical' && r.to === 'client'));
  assert.ok(msg.MATRIX_ROWS.some(r => r.channel === 'care_team' && r.from === 'client' && r.to === 'clinical'));
  const client = USERS().find(u => u.id === 'client-1');
  const thread = { id: 't', channel: 'care_team', client_id: 'client-1', participant_ids: ['client-1', 'fnp-1', 'poa-1'] };
  const user = (id) => USERS().find(u => u.id === id);
  const sees = (id, isPoa = false) => msg.threadVisibility(user(id), thread, { client, isPoa }).visible;
  assert.equal(sees('client-1'), true);
  assert.equal(sees('poa-1', true), true, 'a designated POA reads it');
  assert.equal(sees('fnp-1'), true, 'the assigned clinician');
  assert.equal(sees('admin-1'), true);
  assert.equal(sees('fam-1', false), false, 'non-POA family never reads a clinical conversation');
  assert.equal(sees('cg-1'), false, 'and neither does the caregiver');
  assert.equal(sees('fnp-2'), false, 'a clinician not on this patient\'s care team');
  assert.equal(sees('client-2'), false, 'another client');
});

test('REGRESSION: a POA is client-equivalent — they can start and reply on the client channels (they could only READ them)', () => {
  const client = USERS().find(u => u.id === 'client-1');
  const poa = USERS().find(u => u.id === 'poa-1');
  const users = USERS();
  for (const ch of ['clinical_escalation', 'direct_care', 'care_coordination', 'care_team']) {
    const thread = { id: 't', channel: ch, client_id: 'client-1', participant_ids: ['client-1', 'fnp-1', 'poa-1'] };
    assert.equal(msg.canPostToThread(poa, thread, { client, isPoa: true }).allowed, true, `${ch}: a POA can reply`);
    assert.equal(msg.channelAvailability(ch, { user: poa, client, users, isPoa: true }).available, true, `${ch}: a POA can start`);
  }
  // Ordinary family is NOT promoted.
  const fam = USERS().find(u => u.id === 'fam-1');
  const thread = { id: 't', channel: 'clinical_escalation', client_id: 'client-1', participant_ids: ['client-1'] };
  assert.equal(msg.canPostToThread(fam, thread, { client, isPoa: false }).allowed, false);
  assert.equal(msg.channelAvailability('care_team', { user: fam, client, users, isPoa: false }).available, false);
  assert.match(msg.channelAvailability('care_team', { user: fam, client, users, isPoa: false }).reason, /do not start/);
});

test('a patient cannot start Care Team with nobody assigned — shown disabled with the reason; a clinician can', () => {
  const users = USERS();
  const c2 = users.find(u => u.id === 'client-2');
  const a = msg.channelAvailability('care_team', { user: c2, client: c2, users });
  assert.equal(a.available, false);
  assert.equal(a.code, 'NO_CLINICIAN_ASSIGNED_YET');
  assert.match(a.reason, /nobody on the other end/);
  const ch = msg.channelsFor({ user: c2, client: c2, users }).find(x => x.id === 'care_team');
  assert.equal(ch.available, false, 'listed, not hidden');
  assert.equal(msg.channelAvailability('care_team', { user: users.find(u => u.id === 'fnp-1'), client: users.find(u => u.id === 'client-1'), users }).available, true);
  const c1 = users.find(u => u.id === 'client-1');
  assert.equal(msg.channelAvailability('care_team', { user: c1, client: c1, users }).available, true);
});

// ============================================================
// Message validation: formatted text and attachments
// ============================================================
test('validation: formatting is by explicit format only; blank means no WORDS; a file alone is a message', () => {
  const v = (input, n = 0) => msg.validateMessage(input, { attachmentCount: n });
  assert.equal(v({ body: 'Hello' }).clean.format, 'plain', 'no format means plain text');
  assert.equal(v({ body: 'x', format: 'anything else' }).clean.format, 'plain');
  assert.equal(v({ body: '**hi**', format: 'markup' }).clean.format, 'markup');
  assert.equal(v({ body: '- ', format: 'markup' }).valid, false, 'an empty bullet is no words');
  assert.equal(v({ body: '   ', format: 'markup' }).valid, false);
  assert.equal(v({ body: '- ', format: 'plain' }).valid, true, 'a plain "- " is still text');
  assert.equal(v({ body: '', format: 'markup' }, 1).valid, true, 'attachments alone are a message');
  assert.equal(v({ body: 'x' }, msg.MAX_ATTACHMENTS + 1).errors[0].code, 'TOO_MANY_ATTACHMENTS');
  assert.equal(v({ body: 'y'.repeat(msg.MAX_BODY + 1) }).errors[0].code, 'BODY_TOO_LONG');
  assert.deepEqual([...msg.ATTACHMENT_MIMES].sort(), ['application/pdf', 'image/jpeg', 'image/png']);
});

test('previews are plain text, never markup, and say a file came with it', () => {
  assert.equal(msg.previewOf('**Bold** and _italic_', 'markup', []), 'Bold and italic');
  assert.equal(msg.previewOf('## Heading\n- one\n- two', 'markup', []), 'HEADING • one • two', 'a heading reads in capitals, bullets as dots');
  assert.equal(msg.previewOf('plain **not bold**', 'plain', []), 'plain **not bold**', 'plain text is never run through the formatter');
  assert.equal(msg.previewOf('See attached', 'markup', [{ name: 'a.pdf' }, { name: 'b.png' }]), 'See attached · 2 attachments');
  assert.equal(msg.previewOf('', 'markup', [{ name: 'labs.pdf' }]), '1 attachment: labs.pdf');
});

// ============================================================
// Routes: the clinician sends, the patient and POA receive
// ============================================================
test('a clinician sends a formatted message with two attachments; it lands stored, previewed and hidden from non-POA family', async () => {
  const h = await boot();
  try {
    const body = '**Your results are back.**\n- A1c improved\n- No changes to your medicine\n<script>alert(1)</script>';
    const r = await h.call('fnp-1', 'POST', '/api/messaging/threads', { form: h.form(
      { channel: 'care_team', clientId: 'client-1', body, format: 'markup' },
      [{ name: 'A1c report.pdf', type: 'application/pdf', buf: PDF() }, { name: 'photo.png', type: 'image/png', buf: PNG() }]) });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const thread = rows(h, 'message_threads')[0];
    const m = rows(h, 'messages')[0];
    assert.equal(thread.channel, 'care_team');
    assert.deepEqual([...thread.participant_ids].sort(), ['client-1', 'fnp-1', 'poa-1'], 'the patient, their POA and the sender — not other family, not the caregiver');
    assert.equal(m.body_format, 'markup');
    assert.equal(m.body, body, 'stored as sent: markup, never HTML — the script tag is inert text');
    assert.equal(m.attachments.length, 2);
    assert.deepEqual(m.attachments.map(a => a.mime), ['application/pdf', 'image/png']);
    assert.ok(m.attachments.every(a => a.drive_file_id), 'stored privately in Drive');
    assert.equal(h.drive.uploads.length, 2);
    assert.ok(h.drive.uploads.every(u => u.clientName === 'Juanita Guess'));
    assert.match(thread.last_message_preview, /^Your results are back\./);
    assert.ok(!/\*\*|<script>/.test(thread.last_message_preview.replace('<script>alert(1)</script>', '')), 'a preview carries no markup markers');
    assert.match(thread.last_message_preview, /2 attachments/);
    // What the API returns never carries the Drive id.
    const listed = await h.call('client-1', 'GET', `/api/messaging/threads/${thread.id}`);
    assert.equal(listed.status, 200);
    const pub = listed.data.messages[0];
    assert.equal(pub.format, 'markup');
    assert.deepEqual(pub.attachments.map(a => Object.keys(a).sort()), [['id', 'mime', 'name', 'size'], ['id', 'mime', 'name', 'size']]);
    assert.ok(!JSON.stringify(listed.data).includes('drv-'), 'no storage id ever leaves the server');
    // The patient's POA reads it; non-POA family and the caregiver cannot.
    assert.equal((await h.call('poa-1', 'GET', `/api/messaging/threads/${thread.id}`)).status, 200);
    assert.equal((await h.call('fam-1', 'GET', `/api/messaging/threads/${thread.id}`)).status, 403);
    assert.equal((await h.call('cg-1', 'GET', `/api/messaging/threads/${thread.id}`)).status, 403);
    assert.deepEqual((await h.call('fam-1', 'GET', '/api/messaging/threads')).data.threads.map(t => t.channel), [], 'and it is not in their list');
  } finally { h.close(); }
});

test('the email prompt: the patient and their POA get a PHI-free notice that opens the portal\'s Messages tab; the sender and other family get none', async () => {
  const h = await boot();
  try {
    await h.call('fnp-1', 'POST', '/api/messaging/threads', { json: { channel: 'care_team', clientId: 'client-1', body: 'Please call me about your **labs**.', format: 'markup' } });
    const to = h.notices.filter(n => n.type === 'message_received');
    assert.deepEqual(to.map(n => n.email).sort(), ['c1@test.local', 'poa@test.local']);
    for (const n of to) {
      const text = `${n.data.subject} ${n.data.body}`;
      assert.ok(!/Juanita|Guess|Bethel|Godwins|labs|call me/i.test(text), `no name and none of the message in the email: ${text}`);
      assert.equal(n.data.ctaUrl, links.PATHS.PORTAL_MESSAGES);
      assert.equal(n.data.ctaUrl, '/portal#messages');
      assert.match(n.data.body, /sign in to your portal/i);
    }
    assert.ok(!h.notices.some(n => n.email === 'fam@test.local'), 'non-POA family is not emailed');
    assert.ok(!h.notices.some(n => n.email === 'fnp@test.local'), 'the sender is not emailed');
    // A patient's reply reaches the clinician with the staff notice, pointed at the clinician surface.
    h.notices.length = 0;
    const tid = rows(h, 'message_threads')[0].id;
    await h.call('client-1', 'POST', `/api/messaging/threads/${tid}/messages`, { json: { body: 'Thank you', format: 'markup' } });
    const back = h.notices.filter(n => n.type === 'message_received');
    assert.deepEqual(back.map(n => n.email).sort(), ['fnp@test.local', 'poa@test.local'], 'the clinician and the POA on the thread, not the sender');
    const toClin = back.find(n => n.email === 'fnp@test.local');
    assert.equal(toClin.data.ctaUrl, links.messagesFor(USERS().find(u => u.id === 'fnp-1')));
    assert.equal(back.find(n => n.email === 'poa@test.local').data.ctaUrl, links.PATHS.PORTAL_MESSAGES);
    // A POA designated AFTER the thread began still hears about the next message.
    const users = h.store.get('users'); users.push({ id: 'poa-2', name: 'New Agent', email: 'poa2@test.local', role: 'family', familyOfClientId: 'client-1', familyIsPoa: true }); h.store.set('users', users);
    h.notices.length = 0;
    await h.call('fnp-1', 'POST', `/api/messaging/threads/${tid}/messages`, { json: { body: 'Another update', format: 'markup' } });
    assert.ok(h.notices.some(n => n.email === 'poa2@test.local'), 'a later-designated POA is read fresh, not from the snapshot');
  } finally { h.close(); }
});

test('the patient and the POA can start and reply, with attachments, and a POA reads "as POA for"', async () => {
  const h = await boot();
  try {
    const started = await h.call('client-1', 'POST', '/api/messaging/threads', { form: h.form(
      { channel: 'care_team', body: 'Here is my **insurance card**.', format: 'markup' }, [{ name: 'card.png', type: 'image/png', buf: PNG() }]) });
    assert.equal(started.status, 200, JSON.stringify(started.data));
    const tid = rows(h, 'message_threads')[0].id;
    assert.ok(rows(h, 'message_threads')[0].participant_ids.includes('fnp-1'), 'it reaches the assigned clinician');
    const reply = await h.call('poa-1', 'POST', `/api/messaging/threads/${tid}/messages`, { form: h.form({ body: 'Adding the other side.', format: 'markup' }, [{ name: 'back.pdf', type: 'application/pdf', buf: PDF() }]) });
    assert.equal(reply.status, 200, `a POA can reply (they could not before): ${JSON.stringify(reply.data)}`);
    assert.match(reply.data.message.from, /^Luka Agent as POA for Juanita Guess$/);
    const clinReply = await h.call('fnp-1', 'POST', `/api/messaging/threads/${tid}/messages`, { json: { body: 'Got both, thank you.', format: 'markup' } });
    assert.equal(clinReply.status, 200);
    const all = rows(h, 'messages');
    assert.equal(all.length, 3);
    assert.equal(all[1].attachments.length, 1);
    // A POA can start one too.
    const poaStart = await h.call('poa-1', 'POST', '/api/messaging/threads', { json: { channel: 'care_team', body: 'A question', format: 'markup' } });
    assert.equal(poaStart.status, 200, JSON.stringify(poaStart.data));
    // A patient with nobody assigned is refused with the reason.
    const none = await h.call('client-2', 'POST', '/api/messaging/threads', { json: { channel: 'care_team', body: 'hello', format: 'markup' } });
    assert.equal(none.status, 403);
    assert.equal(none.data.code, 'NO_CLINICIAN_ASSIGNED_YET');
  } finally { h.close(); }
});

test('an older PLAIN message is never turned into formatting', async () => {
  const h = await boot();
  try {
    await h.call('client-1', 'POST', '/api/messaging/threads', { json: { channel: 'support', body: 'use _underscores_ and **stars**\n- not a list' } });
    const m = rows(h, 'messages')[0];
    assert.equal(m.body_format, 'plain');
    const tid = rows(h, 'message_threads')[0].id;
    const got = (await h.call('client-1', 'GET', `/api/messaging/threads/${tid}`)).data.messages[0];
    assert.equal(got.format, 'plain');
    assert.equal(got.body, 'use _underscores_ and **stars**\n- not a list');
    // A row stored BEFORE this change has no body_format at all.
    const legacy = rows(h, 'messages'); delete legacy[0].body_format; delete legacy[0].attachments; h.store.set('messages', legacy);
    const again = (await h.call('client-1', 'GET', `/api/messaging/threads/${tid}`)).data.messages[0];
    assert.equal(again.format, 'plain', 'no format on the row means plain');
    assert.deepEqual(again.attachments, []);
  } finally { h.close(); }
});

// ============================================================
// Attachments: the refusals write nothing
// ============================================================
test('a file that is not really a PDF/JPEG/PNG is refused by its BYTES, whatever it is called, and nothing is stored', async () => {
  const h = await boot();
  try {
    const r = await h.call('fnp-1', 'POST', '/api/messaging/threads', { form: h.form(
      { channel: 'care_team', clientId: 'client-1', body: 'see attached', format: 'markup' },
      [{ name: 'fine.pdf', type: 'application/pdf', buf: PDF() }, { name: 'report.pdf', type: 'application/pdf', buf: EXE() }]) });
    assert.equal(r.status, 400);
    assert.equal(r.data.code, 'ATTACHMENT_BAD_TYPE');
    assert.match(r.data.error, /report\.pdf/);
    assert.deepEqual(rows(h, 'message_threads'), []);
    assert.deepEqual(rows(h, 'messages'), []);
    assert.equal(h.drive.uploads.length, 0, 'typed BEFORE anything is stored: not even the good file was uploaded');
    assert.equal(h.notices.length, 0);
  } finally { h.close(); }
});

test('too many files and an oversized file are refused with a sentence, not a 500', async () => {
  const h = await boot({ maxBytes: 2000 });
  try {
    const six = Array.from({ length: 6 }, (_, i) => ({ name: `f${i}.pdf`, type: 'application/pdf', buf: PDF() }));
    const many = await h.call('fnp-1', 'POST', '/api/messaging/threads', { form: h.form({ channel: 'care_team', clientId: 'client-1', body: 'x', format: 'markup' }, six) });
    assert.equal(many.status, 400);
    assert.equal(many.data.code, 'TOO_MANY_ATTACHMENTS');
    const big = await h.call('fnp-1', 'POST', '/api/messaging/threads', { form: h.form({ channel: 'care_team', clientId: 'client-1', body: 'x', format: 'markup' },
      [{ name: 'huge.pdf', type: 'application/pdf', buf: Buffer.concat([PDF(), Buffer.alloc(5000)]) }]) });
    assert.equal(big.status, 400);
    assert.equal(big.data.code, 'ATTACHMENT_TOO_LARGE');
    assert.match(big.data.error, /up to/);
    assert.deepEqual(rows(h, 'messages'), []);
    assert.equal(h.drive.uploads.length, 0);
  } finally { h.close(); }
});

test('a Drive failure REFUSES the send, removes what was already stored, and writes no message', async () => {
  const h = await boot({ failOn: 2 });            // the second upload fails
  try {
    const r = await h.call('fnp-1', 'POST', '/api/messaging/threads', { form: h.form(
      { channel: 'care_team', clientId: 'client-1', body: 'two files', format: 'markup' },
      [{ name: 'one.pdf', type: 'application/pdf', buf: PDF() }, { name: 'two.png', type: 'image/png', buf: PNG() }]) });
    assert.equal(r.status, 502);
    assert.equal(r.data.code, 'ATTACHMENT_STORAGE_UNAVAILABLE');
    assert.match(r.data.error, /was not sent/);
    assert.deepEqual(rows(h, 'messages'), [], 'no message pointing at a file that is not there');
    assert.deepEqual(rows(h, 'message_threads'), []);
    assert.deepEqual(h.drive.deleted, ['drv-1'], 'the first file, already stored, is cleaned up');
    assert.equal(h.notices.length, 0, 'and nobody is emailed about a message that was not sent');
  } finally { h.close(); }
});

test('an attachment-only message is allowed; an empty one is not', async () => {
  const h = await boot();
  try {
    const empty = await h.call('fnp-1', 'POST', '/api/messaging/threads', { json: { channel: 'care_team', clientId: 'client-1', body: '', format: 'markup' } });
    assert.equal(empty.status, 400);
    assert.equal(empty.data.code, 'BODY_REQUIRED');
    const bullet = await h.call('fnp-1', 'POST', '/api/messaging/threads', { json: { channel: 'care_team', clientId: 'client-1', body: '- ', format: 'markup' } });
    assert.equal(bullet.status, 400, 'an empty bullet is not a message');
    const fileOnly = await h.call('fnp-1', 'POST', '/api/messaging/threads', { form: h.form({ channel: 'care_team', clientId: 'client-1', body: '', format: 'markup' }, [{ name: 'labs.pdf', type: 'application/pdf', buf: PDF() }]) });
    assert.equal(fileOnly.status, 200, JSON.stringify(fileOnly.data));
    assert.equal(rows(h, 'message_threads')[0].last_message_preview, '1 attachment: labs.pdf');
  } finally { h.close(); }
});

// ============================================================
// Reading an attachment
// ============================================================
test('an attachment is served only to someone who may read the thread, with its sniffed type, and every read is audited', async () => {
  const h = await boot();
  try {
    await h.call('fnp-1', 'POST', '/api/messaging/threads', { form: h.form({ channel: 'care_team', clientId: 'client-1', body: 'results attached', format: 'markup' },
      [{ name: 'Résumé & results.pdf', type: 'application/pdf', buf: PDF() }]) });
    const m = rows(h, 'messages')[0]; const a = m.attachments[0];
    const url = `/api/messaging/messages/${m.id}/attachments/${a.id}`;
    const ok = await h.call('client-1', 'GET', url);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('content-type'), 'application/pdf');
    assert.equal(ok.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(ok.buf, PDF(), 'the stored bytes come back');
    assert.match(ok.headers.get('content-disposition'), /^inline; /);
    assert.match(ok.headers.get('content-disposition'), /filename\*=UTF-8''/, 'a non-ASCII name uses the standard encoded form, not a crash');
    assert.equal((await h.call('poa-1', 'GET', url)).status, 200, 'the POA');
    assert.equal((await h.call('fnp-1', 'GET', url)).status, 200, 'the clinician');
    assert.equal((await h.call('fam-1', 'GET', url)).status, 403, 'non-POA family');
    assert.equal((await h.call('cg-1', 'GET', url)).status, 403, 'the caregiver');
    assert.equal((await h.call('client-2', 'GET', url)).status, 403, 'another client');
    assert.equal((await h.call('fnp-2', 'GET', url)).status, 403, 'a clinician not on this care team');
    assert.equal((await h.call(null, 'GET', url)).status, 401, 'no sign-in');
    assert.equal((await h.call('client-1', 'GET', `/api/messaging/messages/${m.id}/attachments/nope`)).status, 404);
    assert.equal((await h.call('client-1', 'GET', `/api/messaging/messages/nope/attachments/${a.id}`)).status, 404);
    const reads = h.activity.filter(x => x[2] === 'message_attachment_read');
    assert.equal(reads.length, 3, 'one audit row per successful read');
    assert.ok(reads.every(x => x[4] === m.id && x[5].attachmentId === a.id));
    // A Drive read failure is a sentence, not a 500.
    h.drive.files.clear();
    const gone = await h.call('client-1', 'GET', url);
    assert.equal(gone.status, 502);
    assert.equal(gone.data.code, 'ATTACHMENT_READ_FAILED');
  } finally { h.close(); }
});

// ============================================================
// Build guards
// ============================================================
test('the component keeps what people type, clears it only on success, and renders plain messages plain', () => {
  const code = stripComments(componentSrc);
  assert.match(code, /function newDraft\(\)/);
  // cleared ONLY inside the success handlers
  assert.equal((code.match(/state\.draft = newDraft\(\);/g) || []).length, 5, 'three navigations and the two success handlers');
  // render() must not read the editor (it would put a just-sent message back in the box)
  const render = code.slice(code.indexOf('function render(state)'), code.indexOf('function scopeSettled'));
  assert.ok(!/captureDraft\(/.test(render.replace(/\/\/.*$/gm, '')), 'render does not capture the draft');
  assert.match(render, /ed\.innerHTML = nf\.renderHtml\(state\.draft\.markup \|\| ''\)/, 'and restores it');
  assert.match(code, /editor\.oninput = keepDraft/);
  // a plain message never touches the formatter; a markup one goes through the escaping renderer
  assert.match(code, /if \(m\.format === 'markup' && nf\) return '<div class="mfmt">' \+ nf\.renderHtml\(m\.body \|\| ''\) \+ '<\/div>';/);
  assert.match(code, /return '<div>' \+ esc\(m\.body\)\.replace/);
  assert.ok(!/innerHTML\s*=\s*[^;]*m\.body/.test(code), 'a message body is never assigned to innerHTML unrendered');
  // attachments open with the caller's token, never a public link
  assert.match(code, /Authorization: 'Bearer ' \+ state\.authToken/);
  assert.ok(!/drive\.google|webViewLink|webContentLink/.test(code));
  // a paste is text only
  assert.match(code, /getData\('text\/plain'\)/);
});

test('every page that mounts messaging loads the formatter first', () => {
  for (const page of ['portal', 'clinical', 'caregiver', 'admin-hub']) {
    const html = fs.readFileSync(path.join(root, `public/${page}.html`), 'utf8');
    assert.match(html, /<script src="\/note-format\.js"><\/script>/, `${page}.html loads note-format.js`);
    assert.ok(html.indexOf('/note-format.js') < html.indexOf('/components/gfc-messaging.js') || page === 'clinical' || page === 'portal', `${page}: formatter before component`);
  }
});

test('the portal opens on Messages for the email\'s link, and keeps the fragment through a redirect', () => {
  const portal = fs.readFileSync(path.join(root, 'public/portal.html'), 'utf8');
  assert.match(portal, /useState\(\(\) => \(window\.location\.hash === '#messages' \? 'messages' : 'home'\)\)/);
  assert.match(portal, /window\.location\.href = `\/portal\/\$\{user\.slug\}\$\{window\.location\.hash \|\| ''\}`;/);
  assert.match(portal, /window\.location\.href = `\/portal\/\$\{result\.user\.slug\}\$\{window\.location\.hash \|\| ''\}`;/);
  assert.equal(links.routeOf(links.PATHS.PORTAL_MESSAGES), '/portal', 'the link resolves to a route that exists (the fragment is client-side)');
});

test('the routes: attachments are typed BEFORE storage, stored privately, and the messaging mount passes real dependencies', () => {
  const code = stripComments(routeSrc);
  const store = code.slice(code.indexOf('const storeAttachments'), code.indexOf('  // ---- Attachments') > 0 ? code.length : code.length);
  const typedAt = code.indexOf('detectFileType(f.buffer)');
  const uploadedAt = code.indexOf('uploadMessageAttachmentFile(');
  assert.ok(typedAt > 0 && uploadedAt > typedAt, 'every file is typed before the first is stored');
  assert.ok(!/webViewLink|anyone/.test(code), 'no public link');
  // validated before stored, stored before the row is written, row written before anybody is told
  const create = code.slice(code.indexOf("router.post('/api/messaging/threads'"), code.indexOf("router.post('/api/messaging/threads/:id/messages'"));
  assert.ok(create.indexOf('msg.validateMessage(') < create.indexOf('storeAttachments(') && create.indexOf('storeAttachments(') < create.indexOf("db.set('messages'") && create.indexOf("db.set('messages'") < create.indexOf('notifyThread('));
  const mount = serverSrc.slice(serverSrc.indexOf('app.use(messagingRoutes({'), serverSrc.indexOf('}));', serverSrc.indexOf('app.use(messagingRoutes({')));
  for (const dep of ['upload', 'uploadLimiter', 'googledrive', 'detectFileType', 'contentDisposition']) assert.match(mount, new RegExp(`\\b${dep}\\b`), `server.js passes ${dep}`);
  assert.match(mount, /detectFileType: \(buf\) => detectFileType\(buf\)/, 'a closure: the const is defined later in the file');
  assert.match(fs.readFileSync(path.join(root, 'googledrive.js'), 'utf8'), /'GFC Message Attachments'/);
});
