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
  const db = { get: async (k) => (store.has(k) ? JSON.parse(JSON.stringify(store.get(k))) : null), set: async (k, v) => { if (opts.failWrite && k === opts.failWrite) throw new Error('write failed'); store.set(k, JSON.parse(JSON.stringify(v))); } };
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
      licenseLevel: u.licenseLevel || null, familyOfClientId: u.familyOfClientId || null, familyIsPoa: u.familyIsPoa || false, careTeam: u.careTeam || null,
      // Production's req.user carries these; a harness without them tests a
      // world with no managers in it.
      isManager: !!u.isManager, accountStatus: u.accountStatus || 'active' };
    next();
  };
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use(messagingRoutes({
    db, config: cfg, logActivity: async (...a) => { activity.push(a); },
    queueNotification: async (type, id, email, name, data, o) => { notices.push({ type, id, email, name, data, o }); return { queued: true }; },
    getUsers, authenticateToken, uuidv4, upload, uploadLimiter: (req, res, next) => next(), googledrive, detectFileType, contentDisposition,
    // THE REAL NOTIFIER, built as server.js builds it. The STAFF half of the
    // message notice moved onto it on 2026-10-12 so the detail rule lives in
    // one place; a harness that left `notify` out would exercise a different
    // function and report staff as never told.
    notify: () => require('../notifications').createNotifier({
      getUsers,
      queueNotification: async (type, id, email, name, data, o) => { notices.push({ type, id, email, name, data, o }); return { queued: true }; },
      getAppBaseUrl: async () => 'https://app.test.local',
      emailTransport: { transportStatus: () => ({ baaCovered: true }) },
      staffRoles: [cfg.ROLES.ADMIN, cfg.ROLES.USER, cfg.ROLES.CASE_MANAGER],
      clientRole: cfg.ROLES.CLIENT,
      familyRole: cfg.ROLES.FAMILY
    })
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
  // Owner, 2026-10-15: anyone on the client's care team starts one.
  assert.deepEqual([...c.initiators].sort(), ['caseManager', 'client', 'clinical', 'vendor'], 'caregivers too (owner, 2026-10-15)');
  assert.ok(msg.MATRIX_ROWS.some(r => r.channel === 'care_team' && r.from === 'clinical' && r.to === 'client'));
  assert.ok(msg.MATRIX_ROWS.some(r => r.channel === 'care_team' && r.from === 'client' && r.to === 'clinical'));
  const client = USERS().find(u => u.id === 'client-1');
  const thread = { id: 't', channel: 'care_team', client_id: 'client-1', participant_ids: ['client-1', 'fnp-1', 'poa-1'] };
  const user = (id) => USERS().find(u => u.id === id);
  const sees = (id, isPoa = false) => msg.threadVisibility(user(id), thread, { client, isPoa }).visible;
  assert.equal(sees('client-1'), true);
  assert.equal(sees('poa-1', true), true, 'a designated POA reads it');
  assert.equal(sees('fnp-1'), true, 'the assigned clinician');
  assert.equal(sees('cm-1'), true, "the patient's case manager is on the care team too");
  assert.equal(sees('admin-1'), true);
  assert.equal(sees('fam-1', false), false, 'non-POA family never reads a clinical conversation');
  assert.equal(sees('cg-1'), false, 'and neither does a caregiver who is not on this thread');
  assert.equal(sees('fnp-2'), false, 'a clinician not on this patient\'s care team');
  assert.equal(sees('client-2'), false, 'another client');
});

test('REGRESSION: a POA is client-equivalent — they can start and reply on the client channels (they could only READ them)', () => {
  const client = USERS().find(u => u.id === 'client-1');
  const poa = USERS().find(u => u.id === 'poa-1');
  const users = USERS();
  for (const ch of ['clinical_escalation', 'direct_care', 'care_team']) {
    const thread = { id: 't', channel: ch, client_id: 'client-1', participant_ids: ['client-1', 'fnp-1', 'poa-1'] };
    assert.equal(msg.canPostToThread(poa, thread, { client, isPoa: true }).allowed, true, `${ch}: a POA can reply`);
    assert.equal(msg.channelAvailability(ch, { user: poa, client, users, isPoa: true }).available, true, `${ch}: a POA can start`);
  }
  // Care Coordination is retired (owner, 2026-10-15): nobody starts one, a POA included.
  assert.equal(msg.channelAvailability('care_coordination', { user: poa, client, users, isPoa: true }).code, 'CHANNEL_RETIRED');
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
    assert.deepEqual([...thread.participant_ids].sort(), ['cg-1', 'client-1', 'cm-1', 'fnp-1', 'poa-1'], 'the patient, their POA and the whole care team (case manager and caregiver included, owner 2026-10-15), not other family');
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
    // The patient's POA reads it; non-POA family cannot. The caregiver is on the
    // care team now (owner, 2026-10-15), so a whole-team message reaches them.
    assert.equal((await h.call('poa-1', 'GET', `/api/messaging/threads/${thread.id}`)).status, 200);
    assert.equal((await h.call('fam-1', 'GET', `/api/messaging/threads/${thread.id}`)).status, 403);
    assert.equal((await h.call('cg-1', 'GET', `/api/messaging/threads/${thread.id}`)).status, 200);
    assert.deepEqual((await h.call('fam-1', 'GET', '/api/messaging/threads')).data.threads.map(t => t.channel), [], 'and it is not in their list');
  } finally { h.close(); }
});

test('the email prompt: the patient and their POA get a PHI-free notice that opens the portal\'s Messages tab; the sender and other family get none', async () => {
  const h = await boot();
  try {
    await h.call('fnp-1', 'POST', '/api/messaging/threads', { json: { channel: 'care_team', clientId: 'client-1', body: 'Please call me about your **labs**.', format: 'markup' } });
    const to = h.notices.filter(n => n.type === 'message_received');
    // The case manager is on the care team (owner, 2026-10-15), so they hear
    // about it too, with the staff notice.
    assert.deepEqual(to.map(n => n.email).sort(), ['c1@test.local', 'cg@test.local', 'cm@test.local', 'poa@test.local']);
    for (const n of to.filter(x => x.email === 'c1@test.local' || x.email === 'poa@test.local')) {
      const text = `${n.data.subject} ${n.data.body}`;
      assert.ok(!/Juanita|Guess|Bethel|Godwins|labs|call me/i.test(text), `no name and none of the message in the email: ${text}`);
      // The patient's link is the plain Messages link. A POA may help several
      // patients (familyLinks.js), so theirs names which one, by record id.
      if (n.email === 'c1@test.local') assert.equal(n.data.ctaUrl, links.PATHS.PORTAL_MESSAGES);
      else assert.equal(n.data.ctaUrl, '/portal?for=client-1#messages');
      assert.equal(links.routeOf(n.data.ctaUrl), '/portal', 'the link resolves to a page that exists');
      assert.match(n.data.body, /sign in to your portal/i);
    }
    assert.ok(!h.notices.some(n => n.email === 'fam@test.local'), 'non-POA family is not emailed');
    assert.ok(!h.notices.some(n => n.email === 'fnp@test.local'), 'the sender is not emailed');
    // A patient's reply reaches the clinician with the staff notice, pointed at the clinician surface.
    h.notices.length = 0;
    const tid = rows(h, 'message_threads')[0].id;
    await h.call('client-1', 'POST', `/api/messaging/threads/${tid}/messages`, { json: { body: 'Thank you', format: 'markup' } });
    const back = h.notices.filter(n => n.type === 'message_received');
    assert.deepEqual(back.map(n => n.email).sort(), ['cg@test.local', 'cm@test.local', 'fnp@test.local', 'poa@test.local'], 'the care team and the POA on the thread, not the sender');
    const toClin = back.find(n => n.email === 'fnp@test.local');
    assert.equal(toClin.data.ctaUrl, links.messagesFor(USERS().find(u => u.id === 'fnp-1')));
    assert.equal(back.find(n => n.email === 'poa@test.local').data.ctaUrl, '/portal?for=client-1#messages');
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
    // A caregiver the sender LEFT OFF cannot open the attachment (owner,
    // 2026-10-15: the sender chooses who on the care team gets it).
    await h.call('fnp-1', 'POST', '/api/messaging/threads', { form: h.form({ channel: 'care_team', clientId: 'client-1', body: 'for the case manager', format: 'markup', recipientIds: JSON.stringify(['cm-1']) },
      [{ name: 'note.pdf', type: 'application/pdf', buf: PDF() }]) });
    const m2 = rows(h, 'messages').find(x => x.body === 'for the case manager');
    assert.equal((await h.call('cg-1', 'GET', `/api/messaging/messages/${m2.id}/attachments/${m2.attachments[0].id}`)).status, 403, 'a caregiver left off');
    assert.equal((await h.call('cm-1', 'GET', `/api/messaging/messages/${m2.id}/attachments/${m2.attachments[0].id}`)).status, 200, 'the one chosen');
    assert.equal((await h.call('client-2', 'GET', url)).status, 403, 'another client');
    assert.equal((await h.call('fnp-2', 'GET', url)).status, 403, 'a clinician not on this care team');
    assert.equal((await h.call(null, 'GET', url)).status, 401, 'no sign-in');
    assert.equal((await h.call('client-1', 'GET', `/api/messaging/messages/${m.id}/attachments/nope`)).status, 404);
    assert.equal((await h.call('client-1', 'GET', `/api/messaging/messages/nope/attachments/${a.id}`)).status, 404);
    const reads = h.activity.filter(x => x[2] === 'message_attachment_read' && x[4] === m.id);
    assert.equal(reads.length, 3, 'one audit row per successful read');
    assert.ok(reads.every(x => x[5].attachmentId === a.id));
    assert.equal(h.activity.filter(x => x[2] === 'message_attachment_read' && x[4] === m2.id).length, 1, 'the chosen reader\'s read is audited too, the refused one is not');
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
  // Four navigations (the fourth is startCompose, 10/2026: opening straight
  // into a new message on a FRESH mount, where there is nothing typed to lose)
  // and the two success handlers. A seventh since 2026-10-14: after a
  // super admin's successful Delete Thread, when the thread no longer exists.
  assert.equal((code.match(/state\.draft = newDraft\(\);/g) || []).length, 7, 'four navigations, the two success handlers and a successful delete');
  const start = code.slice(code.indexOf('var want = options.startCompose;'), code.indexOf('}).catch(function (err) {', code.indexOf('var want = options.startCompose;')));
  assert.match(start, /state\.draft = newDraft\(\);/, 'the startCompose clear is the one on mount');
  assert.match(start, /c\.id === want && c\.available/, 'and it only opens a channel the server lists as available');
  // render() must not read the editor (it would put a just-sent message back in the box)
  const render = code.slice(code.indexOf('function render(state)'), code.indexOf('function scopeSettled'));
  assert.ok(!/captureDraft\(/.test(render.replace(/\/\/.*$/gm, '')), 'render does not capture the draft');
  assert.match(render, /ed\.innerHTML = nf\.renderHtml\(state\.draft\.markup \|\| ''\)/, 'and restores it');
  assert.match(code, /wireRichEditor\(editor, editor\.previousElementSibling, keepDraft\)/);
  assert.match(code, /editor\.oninput = function \(\) \{ autoList\(editor\); keep\(\);/, 'every keystroke keeps the draft');
  // a plain message never touches the formatter; a markup one goes through the escaping renderer
  assert.match(code, /if \(m\.format === 'markup' && nf\) return '<div class="mfmt">' \+ nf\.renderHtml\(m\.body \|\| '', \{ linkify: true \}\) \+ '<\/div>';/);
  assert.match(code, /return '<div>' \+ esc\(m\.body\)\.replace/);
  assert.ok(!/innerHTML\s*=\s*[^;]*m\.body/.test(code), 'a message body is never assigned to innerHTML unrendered');
  // attachments open with the caller's token, never a public link
  assert.match(code, /Authorization: 'Bearer ' \+ state\.authToken/);
  assert.ok(!/drive\.google|webViewLink|webContentLink/.test(code));
  // A paste keeps its formatting since 2026-10-16 (owner); plain text still goes in as text.
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
  // (10/2026: the query is kept too, so Stripe's ?billing=paid survives the redirect.)
  assert.match(portal, /window\.location\.href = `\/portal\/\$\{user\.slug\}\$\{window\.location\.search \|\| ''\}\$\{window\.location\.hash \|\| ''\}`;/);
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
  const mount = serverSrc.slice(serverSrc.indexOf('= messagingRoutes({'), serverSrc.indexOf('});', serverSrc.indexOf('= messagingRoutes({')));
  assert.ok(mount.length > 50, 'the mount was found');
  for (const dep of ['upload', 'uploadLimiter', 'googledrive', 'detectFileType', 'contentDisposition']) assert.match(mount, new RegExp(`\\b${dep}\\b`), `server.js passes ${dep}`);
  assert.match(mount, /detectFileType: \(buf\) => detectFileType\(buf\)/, 'a closure: the const is defined later in the file');
  assert.match(fs.readFileSync(path.join(root, 'googledrive.js'), 'utf8'), /'GFC Message Attachments'/);
});

// ============================================================
// Review findings, fixed and pinned
// ============================================================
test('a POA keeps the Family Portal channel AND gains the client ones', () => {
  const poa = { id: 'p', role: 'family', familyIsPoa: true, familyOfClientId: 'client-1' };
  const ids = msg.channelsFor({ user: poa, client: { id: 'client-1', careTeam: {} }, users: [], isPoa: true }).map(c => c.id);
  assert.ok(ids.includes('family_portal'), 'still a family channel');
  assert.ok(ids.includes('care_team'), 'and now the client one');
  const thread = { id: 't', channel: 'family_portal', client_id: 'client-1', participant_ids: ['p'], status: 'open' };
  const r = msg.canPostToThread(poa, thread, { client: { id: 'client-1' }, isPoa: true });
  assert.equal(r.allowed, true, JSON.stringify(r));
});

test('attachment names: UTF-8 restored, bidi stripped, extension follows the bytes; too many files says so', async () => {
  const h = await boot();
  try {
    const tricky = 'Jos\u00e9 labs\u202Efdp.bat';   // the real name a browser sends: accent, RLO, .bat
    const r = await h.call('fnp-1', 'POST', '/api/messaging/threads', { form: h.form(
      { channel: 'care_team', clientId: 'client-1', body: 'Files', format: 'plain' },
      [{ name: tricky, type: 'application/pdf', buf: PDF() }]) });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const a = rows(h, 'messages')[0].attachments[0];
    assert.ok(a.name.endsWith('.pdf'), `extension follows the sniffed type: ${a.name}`);
    assert.ok(!/[‮]/.test(a.name) && !/\.bat/.test(a.name), a.name);
    assert.ok(a.name.startsWith('José'), `UTF-8 restored: ${a.name}`);
    const many = await h.call('fnp-1', 'POST', '/api/messaging/threads', { form: h.form(
      { channel: 'care_team', clientId: 'client-1', body: 'x', format: 'plain' },
      Array.from({ length: 8 }, (_, i) => ({ name: `f${i}.png`, type: 'image/png', buf: PNG() }))) });
    assert.equal(many.status, 400);
    assert.equal(many.data.code, 'TOO_MANY_ATTACHMENTS');
  } finally { h.close(); }
});

test('a revoked POA is not emailed; the notice does not claim the care team wrote when the patient did', async () => {
  const h = await boot();
  try {
    await h.call('fnp-1', 'POST', '/api/messaging/threads', { json: { channel: 'care_team', clientId: 'client-1', body: 'Hello', format: 'plain' } });
    const tid = rows(h, 'message_threads')[0].id;
    const users = h.store.get('users'); users.find(u => u.id === 'poa-1').familyIsPoa = false; h.store.set('users', users);
    h.notices.length = 0;
    await h.call('fnp-1', 'POST', `/api/messaging/threads/${tid}/messages`, { json: { body: 'Again', format: 'plain' } });
    assert.ok(!h.notices.some(n => n.email === 'poa@test.local'), 'the revoked POA gets nothing');
    assert.ok(h.notices.some(n => n.email === 'c1@test.local' && /from your care team/.test(n.data.subject)));
    h.notices.length = 0;
    const restored = h.store.get('users'); restored.find(u => u.id === 'poa-1').familyIsPoa = true; h.store.set('users', restored);
    await h.call('client-1', 'POST', `/api/messaging/threads/${tid}/messages`, { json: { body: 'Thanks', format: 'plain' } });
    const back = h.notices.filter(n => n.type === 'message_received' && n.email !== 'fnp@test.local');
    assert.ok(back.some(n => n.email === 'poa@test.local'), 'the POA is told about the patient reply');
    assert.ok(back.every(n => !/from your care team/.test(n.data.subject)), 'a patient reply is not "from your care team"');
  } finally { h.close(); }
});

test('a send that fails AFTER its files were stored removes them and writes nothing', async () => {
  const h = await boot({ failWrite: 'messages' });
  try {
    const r = await h.call('fnp-1', 'POST', '/api/messaging/threads', { form: h.form(
      { channel: 'care_team', clientId: 'client-1', body: 'x', format: 'plain' },
      [{ name: 'a.pdf', type: 'application/pdf', buf: PDF() }, { name: 'b.png', type: 'image/png', buf: PNG() }]) });
    assert.equal(r.status, 500);
    assert.equal(h.drive.uploads.length, 2, 'both were stored first');
    assert.equal(h.drive.deleted.length, 2, 'and both removed when the message could not be written');
    assert.equal(rows(h, 'messages').length, 0);
  } finally { h.close(); }
});

// ============================================================
// Owner, 2026-10-14: replies open everywhere a person can read, and only the
// super admin deletes a thread.
// ============================================================
test('a Care Update a clinician sends is answered by the patient, the POA and family; on the staff side only its sender and the super admin answer', async () => {
  // Owner, 2026-10-16: internal notes landed in a patient's Care Update. Only
  // the staff member who sent it answers the patient side there.
  const h = await boot();
  try {
    const r = await h.call('fnp-1', 'POST', '/api/messaging/threads', { json: { channel: 'care_update', clientId: 'client-1', body: 'Labs look good' } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const id = r.data.thread.id;
    assert.equal(rows(h, 'message_threads')[0].staff_responder_id, 'fnp-1', 'the sender answers here');
    for (const who of ['client-1', 'poa-1', 'fam-1', 'fnp-1', 'admin-1']) {
      const open = await h.call(who, 'GET', `/api/messaging/threads/${id}`);
      assert.equal(open.status, 200, who);
      assert.equal(open.data.canPost, true, `${who}: ${open.data.cannotPostReason}`);
      const p = await h.call(who, 'POST', `/api/messaging/threads/${id}/messages`, { json: { body: `Thanks from ${who}` } });
      assert.equal(p.status, 200, `${who}: ${JSON.stringify(p.data)}`);
    }
    // The case manager reads it and is told where team notes go.
    const cmOpen = await h.call('cm-1', 'GET', `/api/messaging/threads/${id}`);
    assert.equal(cmOpen.status, 200, 'the case manager still reads it');
    assert.equal(cmOpen.data.canPost, false);
    assert.equal(cmOpen.data.cannotPostCode, 'PATIENT_THREAD_ONE_RESPONDER');
    assert.match(cmOpen.data.cannotPostReason, /Care Team message without the patient/);
    assert.equal(cmOpen.data.patientFacing, true, 'the page shows the yellow patient badge');
    const cmPost = await h.call('cm-1', 'POST', `/api/messaging/threads/${id}/messages`, { json: { body: 'internal note' } });
    assert.equal(cmPost.status, 403, 'and the server refuses the reply, not only the page');
    assert.equal(rows(h, 'messages').filter(m => m.thread_id === id).length, 6);
    assert.equal((await h.call('cg-1', 'GET', `/api/messaging/threads/${id}`)).status, 403, 'a caregiver still does not read it');
  } finally { h.close(); }
});

test('only the super admin can delete a thread; it leaves every screen and is kept with who, when and why', async () => {
  const h = await boot();
  try {
    const r = await h.call('client-1', 'POST', '/api/messaging/threads', { json: { channel: 'care_team', body: 'Question about my meds' } });
    const id = r.data.thread.id;
    await h.call('fnp-1', 'POST', `/api/messaging/threads/${id}/messages`, { json: { body: 'Happy to help' } });
    // The page is told who may delete; it decides nothing itself.
    assert.equal((await h.call('admin-1', 'GET', `/api/messaging/threads/${id}`)).data.canDelete, true);
    assert.equal((await h.call('fnp-1', 'GET', `/api/messaging/threads/${id}`)).data.canDelete, false);
    for (const who of ['fnp-1', 'cm-1', 'client-1', 'poa-1']) {
      const d = await h.call(who, 'DELETE', `/api/messaging/threads/${id}`, { json: { reason: 'x' } });
      assert.equal(d.status, 403, who);
      assert.equal(d.data.code, 'DELETE_SUPER_ADMIN_ONLY');
    }
    // A manager is not the super admin.
    h.store.get('users').push({ id: 'mgr-1', name: 'Manager', email: 'm@test.local', role: 'user', isManager: true, hasClinicalAccess: true });
    assert.equal((await h.call('mgr-1', 'DELETE', `/api/messaging/threads/${id}`, { json: { reason: 'x' } })).status, 403);
    const noReason = await h.call('admin-1', 'DELETE', `/api/messaging/threads/${id}`, { json: {} });
    assert.equal(noReason.status, 400);
    assert.equal(noReason.data.code, 'DELETE_REASON_REQUIRED');
    assert.ok(rows(h, 'message_threads').some(t => t.id === id), 'a refusal deletes nothing');

    const ok = await h.call('admin-1', 'DELETE', `/api/messaging/threads/${id}`, { json: { reason: 'Sent to the wrong patient' } });
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    assert.equal(ok.data.messageCount, 2);
    assert.ok(!rows(h, 'message_threads').some(t => t.id === id), 'gone from the thread list');
    assert.equal(rows(h, 'messages').filter(m => m.thread_id === id).length, 0, 'its messages are gone from view');
    assert.equal((await h.call('client-1', 'GET', `/api/messaging/threads/${id}`)).status, 404);
    const kept = rows(h, 'deleted_message_threads').find(a => a.thread.id === id);
    assert.ok(kept, 'kept, never erased');
    assert.equal(kept.messages.length, 2);
    assert.equal(kept.deletedById, 'admin-1');
    assert.equal(kept.reason, 'Sent to the wrong patient');
    const audit = h.activity.find(a => a[2] === 'message_thread_deleted');
    assert.ok(audit, 'the deletion is audited');
    assert.ok(!JSON.stringify(audit).includes('Question about my meds') && !JSON.stringify(audit).includes('wrong patient'),
      'the audit row names the thread, never its words');
  } finally { h.close(); }
});

test('the component draws Delete Thread only from the server answer', () => {
  const comp = fs.readFileSync(path.join(__dirname, '..', 'public', 'components', 'gfc-messaging.js'), 'utf8');
  assert.match(comp, /state\.canDelete = !!res\.canDelete;/);
  assert.match(comp, /\(state\.canDelete \? '<button class="mbtn ghost" data-delete-thread="1"/);
  assert.match(comp, /method: 'DELETE', body: \{ reason: reason \}/);
});

// ---- Editing a sent message: super admin only, at any point (owner, 2026-10-14)
test('only the super admin can edit a sent message; the old words are kept with who, when and why', async () => {
  const h = await boot();
  try {
    const r = await h.call('fnp-1', 'POST', '/api/messaging/threads', { json: { channel: 'care_team', clientId: 'client-1', body: 'Your visit is on Tusday at 10.' } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const id = r.data.thread.id;
    const sent = rows(h, 'messages').find(m => m.thread_id === id);
    // The page is told who may edit; it decides nothing itself.
    assert.equal((await h.call('admin-1', 'GET', `/api/messaging/threads/${id}`)).data.canEdit, true);
    assert.equal((await h.call('fnp-1', 'GET', `/api/messaging/threads/${id}`)).data.canEdit, false);
    for (const who of ['fnp-1', 'cm-1', 'client-1', 'poa-1']) {
      const e = await h.call(who, 'PUT', `/api/messaging/messages/${sent.id}`, { json: { body: 'x', reason: 'x' } });
      assert.equal(e.status, 403, who);
      assert.equal(e.data.code, 'EDIT_SUPER_ADMIN_ONLY');
    }
    h.store.get('users').push({ id: 'mgr-2', name: 'Manager', email: 'm2@test.local', role: 'user', isManager: true, hasClinicalAccess: true });
    assert.equal((await h.call('mgr-2', 'PUT', `/api/messaging/messages/${sent.id}`, { json: { body: 'x', reason: 'x' } })).status, 403, 'a manager is not the super admin');
    const noReason = await h.call('admin-1', 'PUT', `/api/messaging/messages/${sent.id}`, { json: { body: 'Your visit is on Tuesday at 10.' } });
    assert.equal(noReason.data.code, 'EDIT_REASON_REQUIRED');
    const blank = await h.call('admin-1', 'PUT', `/api/messaging/messages/${sent.id}`, { json: { body: '   ', reason: 'typo' } });
    assert.equal(blank.data.code, 'BODY_REQUIRED');
    const same = await h.call('admin-1', 'PUT', `/api/messaging/messages/${sent.id}`, { json: { body: 'Your visit is on Tusday at 10.', reason: 'typo' } });
    assert.equal(same.data.code, 'EDIT_NO_CHANGE');
    assert.equal(rows(h, 'messages').find(m => m.id === sent.id).body, 'Your visit is on Tusday at 10.', 'a refusal changes nothing');
    assert.equal((await h.call('admin-1', 'PUT', '/api/messaging/messages/nope', { json: { body: 'x', reason: 'x' } })).status, 404);

    const ok = await h.call('admin-1', 'PUT', `/api/messaging/messages/${sent.id}`, { json: { body: 'Your visit is on Tuesday at 10.', reason: 'Fix a typo' } });
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    assert.equal(ok.data.message.edited, true);
    const stored = rows(h, 'messages').find(m => m.id === sent.id);
    assert.equal(stored.body, 'Your visit is on Tuesday at 10.');
    assert.equal(stored.edits.length, 1);
    assert.equal(stored.edits[0].previousBody, 'Your visit is on Tusday at 10.', 'the old words are kept');
    assert.equal(stored.edits[0].byId, 'admin-1');
    assert.equal(stored.edits[0].reason, 'Fix a typo');
    assert.equal(stored.from_user_id, 'fnp-1', 'the sender does not change');

    // The patient sees the corrected words, marked Edited, and never the old ones.
    const seen = await h.call('client-1', 'GET', `/api/messaging/threads/${id}`);
    const pm = seen.data.messages.find(m => m.id === sent.id);
    assert.equal(pm.body, 'Your visit is on Tuesday at 10.');
    assert.equal(pm.edited, true);
    assert.ok(!JSON.stringify(seen.data).includes('Tusday'), 'the old words never reach the screen');
    assert.ok(!JSON.stringify(seen.data).includes('Fix a typo'), 'nor the reason');
    assert.equal(rows(h, 'message_threads').find(t => t.id === id).last_message_preview, 'Your visit is on Tuesday at 10.', 'the list preview follows');

    const audit = h.activity.find(a => a[2] === 'message_edited');
    assert.ok(audit, 'the edit is audited');
    assert.ok(!JSON.stringify(audit).includes('Tuesday') && !JSON.stringify(audit).includes('typo'), 'the audit row names the message, never its words');
  } finally { h.close(); }
});

test('the component draws Edit only from the server answer and marks edited messages', () => {
  const comp = fs.readFileSync(path.join(__dirname, '..', 'public', 'components', 'gfc-messaging.js'), 'utf8');
  assert.match(comp, /state\.canEdit = !!res\.canEdit;/);
  assert.match(comp, /state\.canEdit && !ed \? ' · <button class="mbtn ghost" data-edit-msg="/);
  assert.match(comp, /\(m\.edited \? ' · Edited' : ''\)/);
  assert.match(comp, /method: 'PUT', body: \{ body: state\.editing\.body, reason: state\.editing\.reason \}/);
});

// ============================================================
// The owner's matrix, 2026-10-15
// ============================================================

test('2026-10-15: the matrix as stated — who is on each conversation and who starts it', () => {
  const ch = (id) => msg.channelById(id);
  assert.deepEqual([...ch('direct_care').participants].sort(), ['client', 'vendor'], 'Direct: client and caregiver; admin sees it but is not on it');
  assert.deepEqual([...ch('direct_care').initiators].sort(), ['admin', 'client', 'vendor']);
  assert.deepEqual([...ch('support').participants].sort(), ['admin', 'client', 'family', 'manager']);
  assert.deepEqual([...ch('support').initiators].sort(), ['admin', 'caseManager', 'client', 'clinical', 'family', 'manager', 'vendor'], 'any team member starts Support, and the office back');
  assert.ok(ch('clinical_escalation').participants.includes('caseManager'), 'the whole clinical team is on a clinical escalation');
  assert.deepEqual([...ch('care_update').initiators].sort(), ['caseManager', 'clinical'], 'case managers (and coordinators on the care team) make care updates');
  assert.ok(ch('care_team').participants.includes('vendor') && ch('care_team').initiators.includes('vendor'), 'caregivers are on the care team');
  assert.deepEqual(ch('clinical_oversight').initiators, ['clinical'], 'clinical oversight is clinician-only');
  assert.equal(ch('operations').retired, true);
  assert.equal(ch('care_coordination').retired, true);
});

test('2026-10-15: only admin sees every type; a manager sees Support, Admin Broadcasts and what they are on', () => {
  const users = USERS();
  const client = users.find(u => u.id === 'client-1');
  const mgr = { id: 'mgr-1', name: 'Mona Manager', role: 'user', isManager: true, clinicalRole: 'readOnly' };
  const sees = (u, channel, party = []) => msg.threadVisibility(u, { id: 't', channel, client_id: 'client-1', participant_ids: party }, { client }).visible;
  for (const ch of ['support', 'admin_direct']) assert.equal(sees(mgr, ch), true, `a manager sees ${ch}`);
  for (const ch of ['direct_care', 'clinical_escalation', 'care_team', 'care_update', 'behavioral_escalation', 'clinical_oversight', 'family_portal']) {
    assert.equal(sees(mgr, ch), false, `a manager does not see ${ch}`);
    assert.equal(sees(users.find(u => u.id === 'admin-1'), ch), true, `admin sees ${ch}`);
  }
  assert.equal(sees(mgr, 'clinical_escalation', ['mgr-1']), true, 'a coordinator put on a thread by the care team reads it');
  assert.deepEqual(msg.channelsFor({ user: mgr, client, users }).map(c => c.id), ['support'], 'a manager starts Support only');
  // A care coordinator on THIS patient's care team holds the clinical team's channels there.
  const cc = { id: 'cc-1', name: 'Cora', role: 'user', isManager: true, clinicalRole: 'coordinator' };
  const withCc = { ...client, careTeam: { ...client.careTeam, careCoordinators: ['cc-1'] } };
  const ccIds = msg.channelsFor({ user: cc, client: withCc, users }).map(c => c.id).sort();
  assert.deepEqual(ccIds, ['behavioral_escalation', 'care_team', 'care_update', 'support']);
  assert.deepEqual(msg.channelsFor({ user: cc, client, users }).map(c => c.id), ['support'], 'not on the care team, only Support');
});

test('2026-10-15: admin sees Direct threads but is not on them and is not emailed', async () => {
  const h = await boot();
  try {
    const r = await h.call('client-1', 'POST', '/api/messaging/threads', { json: { channel: 'direct_care', clientId: 'client-1', body: 'See you Tuesday' } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const t = rows(h, 'message_threads')[0];
    assert.deepEqual([...t.participant_ids].sort(), ['cg-1', 'client-1']);
    assert.equal((await h.call('admin-1', 'GET', `/api/messaging/threads/${t.id}`)).status, 200, 'admin sees it');
    await h.call('admin-1', 'POST', `/api/messaging/threads/${t.id}/messages`, { json: { body: 'Office here' } });
    h.notices.length = 0;
    await h.call('cg-1', 'POST', `/api/messaging/threads/${t.id}/messages`, { json: { body: 'Thanks' } });
    assert.ok(!h.notices.some(n => n.email === 'admin@test.local'), 'admin is not emailed about Direct, even after joining');
    assert.ok(h.notices.some(n => n.email === 'c1@test.local'), 'the client is');
  } finally { h.close(); }
});

test('2026-10-15: a team member\'s Support goes to the office only (Operations is gone)', async () => {
  const h = await boot();
  try {
    const users = h.store.get('users');
    users.push({ id: 'mgr-1', name: 'Mona Manager', email: 'mgr@test.local', role: 'user', isManager: true, clinicalRole: 'readOnly' });
    h.store.set('users', users);
    const ops = await h.call('cg-1', 'POST', '/api/messaging/threads', { json: { channel: 'operations', clientId: 'client-1', body: 'timesheet' } });
    assert.equal(ops.status, 403);
    assert.equal(ops.data.code, 'CHANNEL_RETIRED');
    const r = await h.call('cg-1', 'POST', '/api/messaging/threads', { json: { channel: 'support', clientId: 'client-1', body: 'Running 10 minutes late' } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const t = rows(h, 'message_threads')[0];
    assert.deepEqual([...t.participant_ids].sort(), ['admin-1', 'cg-1', 'mgr-1'], 'the caregiver and the office, never the client or family');
    for (const who of ['cg-1', 'admin-1', 'mgr-1']) assert.equal((await h.call(who, 'GET', `/api/messaging/threads/${t.id}`)).status, 200, `${who} reads it`);
    for (const who of ['client-1', 'fam-1', 'poa-1', 'fnp-1', 'cm-1']) assert.equal((await h.call(who, 'GET', `/api/messaging/threads/${t.id}`)).status, 403, `${who} does not`);
    const emailed = h.notices.filter(n => n.type === 'message_received').map(n => n.email).sort();
    assert.deepEqual(emailed, ['admin@test.local', 'mgr@test.local'], 'Support emails the office');
  } finally { h.close(); }
});

test('2026-10-15: the office starts Support to whoever it chooses', async () => {
  const h = await boot();
  try {
    const users = h.store.get('users');
    users.push({ id: 'mgr-1', name: 'Mona Manager', email: 'mgr@test.local', role: 'user', isManager: true, clinicalRole: 'readOnly' });
    h.store.set('users', users);
    const ch = (await h.call('mgr-1', 'GET', '/api/messaging/channels?clientId=client-1')).data.channels.find(c => c.id === 'support');
    assert.deepEqual(ch.recipients.map(m => m.id), ['client-1', 'fam-1', 'poa-1', 'fnp-1', 'cm-1', 'cg-1'], 'the patient side and the care team');
    const r = await h.call('mgr-1', 'POST', '/api/messaging/threads', { json: { channel: 'support', clientId: 'client-1', body: 'Your new schedule', recipientIds: ['cg-1'] } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const t = rows(h, 'message_threads')[0];
    assert.deepEqual([...t.participant_ids].sort(), ['admin-1', 'cg-1', 'mgr-1']);
    assert.equal((await h.call('client-1', 'GET', `/api/messaging/threads/${t.id}`)).status, 403, 'the client was not chosen');
    assert.equal((await h.call('cg-1', 'GET', `/api/messaging/threads/${t.id}`)).status, 200);
  } finally { h.close(); }
});

test('2026-10-15: Support is one-to-one — a patient\'s goes to the office only, not their family', async () => {
  const h = await boot();
  try {
    const users = h.store.get('users');
    users.push({ id: 'mgr-1', name: 'Mona Manager', email: 'mgr@test.local', role: 'user', isManager: true });
    h.store.set('users', users);
    await h.call('client-1', 'POST', '/api/messaging/threads', { json: { channel: 'support', clientId: 'client-1', body: 'Billing question' } });
    const t = rows(h, 'message_threads')[0];
    assert.deepEqual([...t.participant_ids].sort(), ['admin-1', 'client-1', 'mgr-1']);
    assert.equal(t.audience_chosen, true);
    for (const who of ['fam-1', 'poa-1', 'fnp-1', 'cm-1', 'cg-1']) {
      assert.equal((await h.call(who, 'GET', `/api/messaging/threads/${t.id}`)).status, 403, `${who} does not see the patient's Support`);
    }
    // A clinician's Support tagged with a client is still one-to-one.
    await h.call('fnp-1', 'POST', '/api/messaging/threads', { json: { channel: 'support', clientId: 'client-1', body: 'About her referral' } });
    const t2 = rows(h, 'message_threads')[1];
    assert.equal(t2.client_id, 'client-1', 'filed under the client it is about');
    assert.deepEqual([...t2.participant_ids].sort(), ['admin-1', 'fnp-1', 'mgr-1']);
    for (const who of ['cm-1', 'cg-1', 'client-1', 'poa-1']) {
      assert.equal((await h.call(who, 'GET', `/api/messaging/threads/${t2.id}`)).status, 403, `${who} does not see the clinician's Support`);
    }
    // The office writes to ONE person.
    const two = await h.call('mgr-1', 'POST', '/api/messaging/threads', { json: { channel: 'support', clientId: 'client-1', body: 'x', recipientIds: ['cg-1', 'fnp-1'] } });
    assert.equal(two.status, 400);
    assert.equal(two.data.code, 'SUPPORT_ONE_RECIPIENT');
    // With no client, the office chooses from the team.
    const ch = (await h.call('mgr-1', 'GET', '/api/messaging/channels')).data.channels.find(c => c.id === 'support');
    assert.equal(ch.singleRecipient, true);
    for (const id of ['fnp-1', 'cm-1', 'cg-1']) assert.ok(ch.recipients.some(m => m.id === id), `${id} can be written to`);
    assert.ok(!ch.recipients.some(m => m.id === 'admin-1' || m.id === 'client-1'), 'the office and patients are not on the no-client list');
    const toCg = await h.call('mgr-1', 'POST', '/api/messaging/threads', { json: { channel: 'support', body: 'Can you cover Friday?', recipientIds: ['cg-1'] } });
    assert.equal(toCg.status, 200, JSON.stringify(toCg.data));
    assert.deepEqual([...rows(h, 'message_threads')[2].participant_ids].sort(), ['admin-1', 'cg-1', 'mgr-1']);
  } finally { h.close(); }
});

test('2026-10-15: a clinical escalation reaches the whole clinical team, coordinators and supporting case managers included', async () => {
  const h = await boot();
  try {
    const users = h.store.get('users');
    users.push({ id: 'cm-2', name: 'Supporting CM', email: 'cm2@test.local', role: 'caseManager' });
    users.push({ id: 'cc-1', name: 'Cora Coordinator', email: 'cc@test.local', role: 'user', isManager: true, clinicalRole: 'coordinator' });
    const c1 = users.find(u => u.id === 'client-1');
    c1.careTeam = { ...c1.careTeam, supportingCaseManagers: ['cm-2'], careCoordinators: ['cc-1'] };
    h.store.set('users', users);
    const r = await h.call('client-1', 'POST', '/api/messaging/threads', { json: { channel: 'clinical_escalation', clientId: 'client-1', body: 'New dizziness' } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const t = rows(h, 'message_threads')[0];
    for (const id of ['client-1', 'fnp-1', 'cm-1', 'cm-2', 'cc-1']) assert.ok(t.participant_ids.includes(id), `${id} is on the escalation`);
    assert.ok(!t.participant_ids.includes('cg-1'), 'a caregiver is not');
    assert.equal((await h.call('cc-1', 'GET', `/api/messaging/threads/${t.id}`)).status, 200, 'the coordinator reads it');
    const emailed = h.notices.filter(n => n.type === 'message_received').map(n => n.email);
    for (const e of ['fnp@test.local', 'cm@test.local', 'cm2@test.local', 'cc@test.local']) assert.ok(emailed.includes(e), `${e} is told`);
    // A coordinator on the care team makes a Care Update.
    const cu = await h.call('cc-1', 'POST', '/api/messaging/threads', { json: { channel: 'care_update', clientId: 'client-1', body: 'Home health starts Monday' } });
    assert.equal(cu.status, 200, JSON.stringify(cu.data));
  } finally { h.close(); }
});

test('2026-10-15: a case manager makes a Care Update', async () => {
  const h = await boot();
  try {
    const r = await h.call('cm-1', 'POST', '/api/messaging/threads', { json: { channel: 'care_update', clientId: 'client-1', body: 'Home health starts Monday' } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const ids = rows(h, 'message_threads')[0].participant_ids;
    for (const id of ['cm-1', 'fnp-1', 'fam-1', 'poa-1', 'client-1']) assert.ok(ids.includes(id), id);
  } finally { h.close(); }
});

test('2026-10-15: Care Team offers the patient, their POA and the care team to choose from, never the sender', () => {
  const users = USERS();
  const client = users.find(u => u.id === 'client-1');
  const fnp = users.find(u => u.id === 'fnp-1');
  const ct = msg.channelsFor({ user: fnp, client, users }).find(c => c.id === 'care_team');
  assert.deepEqual(ct.recipients.map(m => [m.id, m.what]), [['client-1', 'Patient'], ['poa-1', 'POA'], ['cm-1', 'Case manager'], ['cg-1', 'Caregiver']]);
  assert.ok(!ct.recipients.some(m => m.id === 'fam-1'), 'non-POA family is never on a Care Team message');
  const cg = users.find(u => u.id === 'cg-1');
  const forCg = msg.channelsFor({ user: cg, client, users }).find(c => c.id === 'care_team');
  assert.ok(forCg && forCg.available, 'a caregiver starts a Care Team message');
  assert.deepEqual(forCg.recipients.map(m => m.id), ['client-1', 'poa-1', 'fnp-1', 'cm-1']);
});

test('2026-10-15: the sender chooses who gets a Care Team message, the patient included; anyone left off cannot read it', async () => {
  const h = await boot();
  try {
    const bad = await h.call('fnp-1', 'POST', '/api/messaging/threads', { json: { channel: 'care_team', clientId: 'client-1', body: 'x', recipientIds: ['fnp-2'] } });
    assert.equal(bad.status, 400);
    assert.equal(bad.data.code, 'RECIPIENT_NOT_ON_CARE_TEAM', 'a clinician not on this care team cannot be added');
    const none = await h.call('fnp-1', 'POST', '/api/messaging/threads', { json: { channel: 'care_team', clientId: 'client-1', body: 'x', recipientIds: [] } });
    assert.equal(none.status, 400);
    assert.equal(none.data.code, 'RECIPIENTS_REQUIRED');
    assert.equal(rows(h, 'message_threads').length, 0, 'nothing is written on a refusal');

    const r = await h.call('fnp-1', 'POST', '/api/messaging/threads', { json: { channel: 'care_team', clientId: 'client-1', body: 'Please check her feet today', recipientIds: ['cg-1'] } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const t = rows(h, 'message_threads')[0];
    assert.deepEqual([...t.participant_ids].sort(), ['cg-1', 'fnp-1'], 'the patient left off, as the sender chose');
    assert.equal(t.audience_chosen, true);
    assert.equal((await h.call('cg-1', 'GET', `/api/messaging/threads/${t.id}`)).status, 200, 'the chosen caregiver reads it');
    for (const who of ['cm-1', 'client-1', 'poa-1']) {
      const x = await h.call(who, 'GET', `/api/messaging/threads/${t.id}`);
      assert.equal(x.status, 403, `${who}, left off, does not`);
    }
    assert.equal((await h.call('admin-1', 'GET', `/api/messaging/threads/${t.id}`)).status, 200, 'admin sees every conversation');
    for (const e of ['cm@test.local', 'c1@test.local', 'poa@test.local']) assert.ok(!h.notices.some(n => n.email === e), `${e} is not emailed`);

    // Choosing everybody is the same as the whole list: no restriction.
    await h.call('fnp-1', 'POST', '/api/messaging/threads', { json: { channel: 'care_team', clientId: 'client-1', body: 'All hands', recipientIds: ['client-1', 'poa-1', 'cg-1', 'cm-1'] } });
    assert.equal(rows(h, 'message_threads')[1].audience_chosen, false);
  } finally { h.close(); }
});

test('2026-10-15: the composer shows the served list as a checklist and sends the choice', () => {
  const comp = fs.readFileSync(path.join(__dirname, '..', 'public', 'components', 'gfc-messaging.js'), 'utf8');
  assert.match(comp, /data-recipient="' \+ esc\(m\.id\) \+ '"/, 'one checkbox per served person');
  assert.match(comp, /recipientIds: list && list\.length \? JSON\.stringify\(picked\) : undefined/, 'the choice is sent with the message');
  assert.match(comp, /Choose at least one person to send this to\./, 'an empty choice is stopped before sending');
  assert.ok(!/careTeam\.|assignedFNPs/.test(comp), 'the page builds no list of its own; it is the server\'s');
});

test('2026-10-15: every caregiver reaches the office through Support, assigned to a client or not', async () => {
  const h = await boot();
  try {
    const users = h.store.get('users');
    users.push({ id: 'cg-9', name: 'New Caregiver', email: 'cg9@test.local', role: 'vendor', licenseLevel: 'pca' });   // no client yet
    users.push({ id: 'mgr-1', name: 'Mona Manager', email: 'mgr@test.local', role: 'user', isManager: true });
    h.store.set('users', users);
    const ch = (await h.call('cg-9', 'GET', '/api/messaging/channels')).data.channels.find(c => c.id === 'support');
    assert.ok(ch && ch.available, 'Support is offered with no client chosen');
    const r = await h.call('cg-9', 'POST', '/api/messaging/threads', { json: { channel: 'support', body: 'Where do I send my timesheet?' } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const t = rows(h, 'message_threads')[0];
    assert.equal(t.client_id, null, 'about no patient');
    assert.deepEqual([...t.participant_ids].sort(), ['admin-1', 'cg-9', 'mgr-1']);
    for (const who of ['cg-9', 'admin-1', 'mgr-1']) assert.equal((await h.call(who, 'GET', `/api/messaging/threads/${t.id}`)).status, 200, `${who} reads it`);
    for (const who of ['cg-1', 'fnp-1', 'cm-1', 'client-1']) assert.equal((await h.call(who, 'GET', `/api/messaging/threads/${t.id}`)).status, 403, `${who} does not`);
    const back = await h.call('mgr-1', 'POST', `/api/messaging/threads/${t.id}/messages`, { json: { body: 'Upload it in the app under Documents.' } });
    assert.equal(back.status, 200, 'the office answers');
    // A patient-facing channel still needs a client.
    const direct = await h.call('cg-9', 'POST', '/api/messaging/threads', { json: { channel: 'behavioral_escalation', body: 'x' } });
    assert.equal(direct.status, 403);
    assert.equal(direct.data.code, 'NO_CLIENT');
  } finally { h.close(); }
});

test('2026-10-15: family and a POA reach the office through Support too', async () => {
  const h = await boot();
  try {
    for (const who of ['fam-1', 'poa-1']) {
      const ch = (await h.call(who, 'GET', '/api/messaging/channels')).data.channels.find(c => c.id === 'support');
      assert.ok(ch && ch.available, `${who} is offered Support`);
      const r = await h.call(who, 'POST', '/api/messaging/threads', { json: { channel: 'support', body: `From ${who}` } });
      assert.equal(r.status, 200, JSON.stringify(r.data));
      const t = rows(h, 'message_threads').find(x => x.started_by === who);
      assert.deepEqual([...t.participant_ids].sort(), ['admin-1', who].sort(), `${who} and the office, nobody else`);
      assert.equal((await h.call('admin-1', 'GET', `/api/messaging/threads/${t.id}`)).status, 200);
    }
  } finally { h.close(); }
});

test('2026-10-15: the composer offers a team member an optional client on Support, and the office a single choice', () => {
  const comp = fs.readFileSync(path.join(__dirname, '..', 'public', 'components', 'gfc-messaging.js'), 'utf8');
  const fn = comp.slice(comp.indexOf('function renderComposeClient'), comp.indexOf('function recipientsOf'));
  assert.match(fn, /if \(c\.id !== 'support' \|\|/, 'the client choice is offered on Support only');
  assert.match(fn, /Not about a client/, 'and "not about a client" is a real choice');
  assert.match(comp, /var one = !!c\.singleRecipient;/);
  assert.match(comp, /'<input type="' \+ \(one \? 'radio' : 'checkbox'\) \+ '"/, 'one person means a radio list');
});

// ============================================================
// Owner, 2026-10-16: after internal notes reached a patient's chat.
// ============================================================
test('2026-10-16: the one-answerer rule is Care Update only — on Care Team every care team member still replies', async () => {
  const h = await boot();
  try {
    const r = await h.call('fnp-1', 'POST', '/api/messaging/threads', { json: { channel: 'care_team', clientId: 'client-1', body: 'Plan for this week' } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const id = r.data.thread.id;
    assert.equal(rows(h, 'message_threads').find(t => t.id === id).staff_responder_id, undefined, 'no answerer is set off Care Update');
    const cm = await h.call('cm-1', 'POST', `/api/messaging/threads/${id}/messages`, { json: { body: 'Noted' } });
    assert.equal(cm.status, 200, JSON.stringify(cm.data));
    // And the rule itself, asked directly: someone else holding the thread
    // only matters on a Care Update.
    const cmUser = { id: 'cm-1', role: 'caseManager' };
    const holder = { id: 'fnp-1', name: 'Bethel Godwins' };
    const client = h.store.get('users').find(u => u.id === 'client-1');
    for (const ch of ['care_team', 'clinical_escalation']) {
      const t = { id: 't', channel: ch, client_id: 'client-1', participant_ids: ['fnp-1', 'cm-1', 'client-1'] };
      assert.notEqual(msg.canPostToThread(cmUser, t, { client, responder: holder }).code, 'PATIENT_THREAD_ONE_RESPONDER', ch);
    }
  } finally { h.close(); }
});

test('2026-10-16: on a Care Update the first staff reply claims it when nobody did; the super admin never claims it', async () => {
  const h = await boot();
  try {
    const r = await h.call('admin-1', 'POST', '/api/messaging/threads', { json: { channel: 'care_update', clientId: 'client-1', body: 'Update from the office' } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const id = r.data.thread.id;
    assert.equal(rows(h, 'message_threads').find(t => t.id === id).staff_responder_id, undefined, 'admin starting it claims nothing');
    assert.equal((await h.call('fnp-1', 'POST', `/api/messaging/threads/${id}/messages`, { json: { body: 'I will follow up' } })).status, 200);
    assert.equal(rows(h, 'message_threads').find(t => t.id === id).staff_responder_id, 'fnp-1');
    const cm = await h.call('cm-1', 'POST', `/api/messaging/threads/${id}/messages`, { json: { body: 'me too' } });
    assert.equal(cm.status, 403);
    assert.equal(cm.data.code, 'PATIENT_THREAD_ONE_RESPONDER');
    assert.equal((await h.call('admin-1', 'POST', `/api/messaging/threads/${id}/messages`, { json: { body: 'admin still answers' } })).status, 200);
  } finally { h.close(); }
});

test('2026-10-16: only the super admin deletes a single message; a reason is required; it is kept with who, when and why', async () => {
  const h = await boot();
  try {
    const r = await h.call('fnp-1', 'POST', '/api/messaging/threads', { json: { channel: 'care_update', clientId: 'client-1', body: 'Labs look good' } });
    const id = r.data.thread.id;
    await h.call('fnp-1', 'POST', `/api/messaging/threads/${id}/messages`, { json: { body: 'INTERNAL: check her insurance' } });
    const wrong = rows(h, 'messages').find(m => m.body === 'INTERNAL: check her insurance');
    assert.equal((await h.call('admin-1', 'GET', `/api/messaging/threads/${id}`)).data.canDeleteMessage, true);
    assert.equal((await h.call('fnp-1', 'GET', `/api/messaging/threads/${id}`)).data.canDeleteMessage, false);
    h.store.get('users').push({ id: 'mgr-1', name: 'Manager', email: 'm@test.local', role: 'user', isManager: true });
    for (const who of ['fnp-1', 'cm-1', 'client-1', 'poa-1', 'mgr-1']) {
      const d = await h.call(who, 'DELETE', `/api/messaging/messages/${wrong.id}`, { json: { reason: 'x' } });
      assert.equal(d.status, 403, who);
    }
    const noReason = await h.call('admin-1', 'DELETE', `/api/messaging/messages/${wrong.id}`, { json: {} });
    assert.equal(noReason.data.code, 'DELETE_REASON_REQUIRED');
    assert.ok(rows(h, 'messages').some(m => m.id === wrong.id), 'a refusal deletes nothing');

    const ok = await h.call('admin-1', 'DELETE', `/api/messaging/messages/${wrong.id}`, { json: { reason: 'Internal note sent to the patient' } });
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    assert.ok(!rows(h, 'messages').some(m => m.id === wrong.id), 'gone from the thread');
    assert.equal(rows(h, 'messages').filter(m => m.thread_id === id).length, 1, 'the other message stays');
    const thread = rows(h, 'message_threads').find(t => t.id === id);
    assert.ok(!/INTERNAL/.test(thread.last_message_preview), 'the preview no longer shows the deleted words');
    const kept = rows(h, 'deleted_messages').find(a => a.message.id === wrong.id);
    assert.ok(kept, 'kept, never erased');
    assert.equal(kept.deletedById, 'admin-1');
    assert.equal(kept.reason, 'Internal note sent to the patient');
    assert.equal(kept.message.body, 'INTERNAL: check her insurance');
    const audit = h.activity.find(a => a[2] === 'message_deleted');
    assert.ok(audit, 'the deletion is audited');
    assert.ok(!JSON.stringify(audit).includes('insurance'), 'the audit row never carries the words');
    const gone = await h.call('admin-1', 'DELETE', `/api/messaging/messages/${wrong.id}`, { json: { reason: 'again' } });
    assert.equal(gone.status, 404);
  } finally { h.close(); }
});

test('2026-10-16: every channel says who it is for and whether the patient sees it; staff get the badge, the patient side does not', async () => {
  for (const [id, c] of Object.entries(msg.CHANNELS)) {
    if (c.retired) continue;   // never offered, so never shown with a descriptor
    assert.ok(msg.CHANNEL_AUDIENCE[id], `${id} has an audience entry`);
    assert.ok(['yes', 'no', 'choose'].includes(msg.CHANNEL_AUDIENCE[id].patientSees), id);
    assert.ok(String(msg.CHANNEL_AUDIENCE[id].note || '').length > 10, `${id} has a descriptor`);
  }
  assert.equal(msg.CHANNEL_AUDIENCE.care_update.patientSees, 'yes');
  assert.equal(msg.CHANNEL_AUDIENCE.clinical_oversight.patientSees, 'no');
  assert.equal(msg.CHANNEL_AUDIENCE.care_team.patientSees, 'choose');
  const h = await boot();
  try {
    const staff = await h.call('fnp-1', 'GET', '/api/messaging/threads?clientId=client-1');
    assert.equal(staff.data.staffView, true);
    const patient = await h.call('client-1', 'GET', '/api/messaging/threads');
    assert.equal(patient.data.staffView, false, 'the patient is never shown a "patient sees this" warning');
  } finally { h.close(); }
});

test('2026-10-16: a Care Team note with the patient left off is NOT patient-facing; with the patient on, it is', async () => {
  const h = await boot();
  try {
    const team = await h.call('fnp-1', 'POST', '/api/messaging/threads', { json: { channel: 'care_team', clientId: 'client-1', body: 'Team only', recipientIds: ['cm-1'] } });
    assert.equal(team.status, 200, JSON.stringify(team.data));
    assert.equal(team.data.thread.patientFacing, false);
    const withPt = await h.call('fnp-1', 'POST', '/api/messaging/threads', { json: { channel: 'care_team', clientId: 'client-1', body: 'With you', recipientIds: ['cm-1', 'client-1'] } });
    assert.equal(withPt.data.thread.patientFacing, true);
    // An older thread with no stored flag: a patient-started one is patient-facing.
    assert.equal(msg.isPatientFacing({ channel: 'care_team', started_by_role: 'client', participant_ids: [] }), true);
    assert.equal(msg.isPatientFacing({ channel: 'clinical_oversight', participant_ids: ['fnp-1', 'cg-1'] }), false);
  } finally { h.close(); }
});

test('2026-10-16: the label on a person is their account type, never the coarse messaging role', () => {
  const L = msg.personLabel;
  assert.equal(L({ role: 'admin' }), 'Admin');
  assert.equal(L({ role: 'user', isManager: true, clinicalRole: 'coordinator' }), 'Care coordinator', 'not "Office"');
  assert.equal(L({ role: 'user', isManager: true, clinicalRole: 'readOnly', accountType: 'manager' }), 'Manager');
  assert.equal(L({ role: 'user', clinicalRole: 'rn', hasClinicalAccess: true }), 'RN', 'not "Clinician"');
  assert.equal(L({ role: 'user', clinicalRole: 'provider', hasClinicalAccess: true }), 'Provider');
  assert.equal(L({ role: 'user', clinicalRole: 'lcsw', hasClinicalAccess: true }), 'LCSW');
  assert.equal(L({ role: 'caseManager', clinicalRole: 'lmsw' }), 'Case manager (LMSW)');
  assert.equal(L({ role: 'family', familyIsPoa: true }), 'POA');
  assert.equal(L({ role: 'family' }), 'Family');
  assert.equal(L({ role: 'vendor' }), 'Caregiver');
  assert.equal(L({ role: 'client' }), 'Patient');
});

test('2026-10-16: "In this conversation" is the thread\'s own participant list, labelled, and every message says what its sender is', async () => {
  const h = await boot();
  try {
    h.store.get('users').push({ id: 'coord-1', name: 'Cora Coordinator', email: 'co@test.local', role: 'user', isManager: true, clinicalRole: 'coordinator' });
    const r = await h.call('fnp-1', 'POST', '/api/messaging/threads', { json: { channel: 'care_team', clientId: 'client-1', body: 'Team only', recipientIds: ['cm-1'] } });
    const id = r.data.thread.id;
    const open = await h.call('cm-1', 'GET', `/api/messaging/threads/${id}`);
    const thread = rows(h, 'message_threads').find(t => t.id === id);
    assert.deepEqual(open.data.people.map(p => p.id).sort(), thread.participant_ids.slice().sort(), 'the list is exactly who is on it');
    assert.ok(!open.data.people.some(p => p.id === 'client-1'), 'the patient was left off, and the list says so');
    assert.equal(open.data.people.find(p => p.id === 'cm-1').you, true);
    assert.equal(open.data.people.find(p => p.id === 'cm-1').label, 'Case manager (LMSW)');
    assert.equal(open.data.messages[0].fromRoleLabel, 'Provider', 'a legacy clinician with no stored role reads as a provider, not "Clinician"');

    // A coordinator's reply reads "Care coordinator", stored on the message.
    const sup = await h.call('fnp-1', 'POST', '/api/messaging/threads', { json: { channel: 'support', body: 'Help with the schedule' } });
    assert.equal(sup.status, 200, JSON.stringify(sup.data));
    const sid = sup.data.thread.id;
    assert.equal((await h.call('coord-1', 'POST', `/api/messaging/threads/${sid}/messages`, { json: { body: 'Looking now' } })).status, 200);
    assert.equal(rows(h, 'messages').find(m => m.body === 'Looking now').from_role_label, 'Care coordinator', 'not "Office"');
    await h.call('admin-1', 'POST', `/api/messaging/threads/${sid}/messages`, { json: { body: 'On it' } });
    assert.equal(rows(h, 'messages').find(m => m.body === 'On it').from_role_label, 'Admin', 'a reply stores its label too');

    // An older message saved before labels were stored reads the sender's account now.
    const old = rows(h, 'messages').find(m => m.body === 'Looking now');
    delete old.from_role_label; old.from_role = 'manager';
    const reread = await h.call('admin-1', 'GET', `/api/messaging/threads/${sid}`);
    assert.equal(reread.data.messages.find(m => m.body === 'Looking now').fromRoleLabel, 'Care coordinator', 'not "Office"');

    // A POA reply keeps "as POA for".
    const cu = await h.call('fnp-1', 'POST', '/api/messaging/threads', { json: { channel: 'care_update', clientId: 'client-1', body: 'Update' } });
    await h.call('poa-1', 'POST', `/api/messaging/threads/${cu.data.thread.id}/messages`, { json: { body: 'Thanks' } });
    assert.equal(rows(h, 'messages').find(m => m.body === 'Thanks').from_role_label, 'POA');
  } finally { h.close(); }
});

test('2026-10-16: the component shows the badge, the descriptors, Delete and the people list only from the server', () => {
  const comp = fs.readFileSync(path.join(__dirname, '..', 'public', 'components', 'gfc-messaging.js'), 'utf8');
  assert.match(comp, /state\.canDeleteMessage = !!res\.canDeleteMessage;/);
  assert.match(comp, /state\.canDeleteMessage && !ed \? ' · <button class="mbtn ghost" data-delete-msg=/);
  assert.match(comp, /state\.people = res\.people \|\| \[\];/);
  assert.match(comp, /In this conversation: /);
  assert.match(comp, /if \(state\.staffView && state\.patientFacing\)/, 'the yellow bar is for staff only');
  assert.match(comp, /c\.audienceNote/, 'start buttons carry their descriptor');
});

test('2026-10-16: the composer keeps pasted formatting, Shift+Enter lines and strikethrough; messages show links; edits are rich', () => {
  const comp = fs.readFileSync(path.join(__dirname, '..', 'public', 'components', 'gfc-messaging.js'), 'utf8');
  const code = stripComments(comp);
  assert.match(code, /var CAPTURE = \{ strike: true, newlines: true \};/);
  assert.match(code, /state\.draft\.markup = nf\.domToMarkup\(ed, CAPTURE\)/, 'the composer reads back with both options');
  assert.match(code, /NF\(\)\.domToMarkup\(eed, CAPTURE\)/, 'and so does the edit box');
  // A paste is parsed inert, reduced to the allowed shapes, then re-rendered by the escaping renderer.
  assert.match(code, /new global\.DOMParser\(\)\.parseFromString\(html, 'text\/html'\)/);
  assert.match(code, /nf\.domToMarkup\(doc\.body, \{ strike: true \}\)/);
  assert.match(code, /document\.execCommand\('insertHTML', false, nf\.renderHtml\(markup\)\)/);
  assert.ok(!/insertHTML', false, html\)/.test(code), 'raw pasted HTML is never inserted');
  assert.match(code, /e\.key === 'Enter' && e\.shiftKey/);
  assert.match(code, /nf\.renderHtml\(m\.body \|\| '', \{ linkify: true \}\)/);
  assert.ok(!/Formatting marks: \*\*bold\*\*/.test(code), 'the edit box no longer shows raw marks');
  assert.match(code, /data-edit-editor="1" contenteditable="true"/);
  for (const t of ['bold', 'italic', 'underline', 'strikeThrough', 'insertUnorderedList', 'insertOrderedList', 'heading', 'clear']) {
    assert.ok(code.includes(`['${t}'`), `toolbar has ${t}`);
  }
});
