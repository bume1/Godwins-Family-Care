// ============================================================
// Sign in with a phone number, hear from us by text (owner, 2026-11-18):
// "for clients like Ms. Dorothy that don't use email, but have a phone
// number, can we make it where a phone number OR email is needed? And that
// those who don't have emails get notifications of updates via text message
// instead? Down to the reset links?"
//
// The pure rules (phoneLogin.js), the REAL messaging router for the text
// outbox and the Quo webhook, and source guards on the server.js wiring.
// ============================================================
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { v4: uuidv4 } = require('uuid');

const config = require('../config');
const messagingRoutes = require('../routes/messaging');
const q = require('../quoSms');
const pl = require('../phoneLogin');
const familyLinks = require('../familyLinks');

const SECRET = Buffer.from('test-signing-secret').toString('base64');
process.env.QUO_API_KEY = 'test-key';
process.env.QUO_WEBHOOK_SECRET = SECRET;
const OFFICE = '+13462455658';

const dorothy = { id: 'c-dot', name: 'Dorothy Lane', role: 'client', email: familyLinks.placeholderEmailFor('client', 'c-dot'),
  loginPhone: '+14045550111', phone: '(404) 555-0111', careTeam: { assignedFNPs: ['fnp-1'] } };
const USERS = () => [
  { id: 'fnp-1', name: 'Bethel Godwins', email: 'fnp@test.local', role: 'user', hasClinicalAccess: true },
  JSON.parse(JSON.stringify(dorothy)),
  { id: 'c-mail', name: 'Ann Mail', role: 'client', email: 'ann@example.com', loginPhone: '+14045550122' },
  { id: 'f-phone', name: 'Kim Lane', role: 'family', email: familyLinks.placeholderEmailFor('family', 'f-phone'),
    loginPhone: '+14045550133', familyLinks: [{ clientId: 'c-dot', isPoa: true }] },
  { id: 'staff-1', name: 'Office', role: 'admin', email: 'office@test.local' }
];

// ---------------------------------------------------------------- pure rules
test('the sign-in box takes an email or a phone number, and a phone matches only a sign-in phone', () => {
  const users = USERS();
  assert.equal(pl.findByIdentifier(users, '(404) 555-0111').id, 'c-dot');
  assert.equal(pl.findByIdentifier(users, '1-404-555-0111').id, 'c-dot');
  assert.equal(pl.findByIdentifier(users, 'ANN@example.com').id, 'c-mail');
  assert.equal(pl.findByIdentifier(users, '404-555-0122').id, 'c-mail', 'an account can have both');
  // A CONTACT phone on a record is never a way in.
  const withContactOnly = [{ id: 'x', role: 'client', email: 'x@example.com', phone: '404-555-0199' }];
  assert.equal(pl.findByIdentifier(withContactOnly, '404-555-0199'), null);
  // Staff never sign in by phone, even if a sign-in phone were stored on them.
  assert.equal(pl.findByIdentifier([{ id: 's', role: 'admin', email: 's@x.com', loginPhone: '+14045550144' }], '4045550144'), null);
  assert.equal(pl.findByIdentifier(users, '555-0111'), null, 'seven digits is not a number we can look up');
  assert.equal(pl.findByIdentifier(users, ''), null);
  // The client-login route narrows by role.
  assert.equal(pl.findByIdentifier(users, '4045550133', { roles: ['client', 'admin'] }), null);
});

test('one phone number, one login; staff keep email', () => {
  const users = USERS();
  assert.equal(pl.checkLoginPhone({ users, raw: '404-555-0111', role: 'client' }).code, 'PHONE_LOGIN_IN_USE');
  assert.equal(pl.checkLoginPhone({ users, raw: '404-555-0111', role: 'client', userId: 'c-dot' }).value, '+14045550111', 'its own number is fine');
  assert.equal(pl.checkLoginPhone({ users, raw: '404-555-0177', role: 'admin' }).code, 'PHONE_LOGIN_ROLE');
  assert.equal(pl.checkLoginPhone({ users, raw: '12345', role: 'family' }).code, 'PHONE_LOGIN_INVALID');
  assert.equal(pl.checkLoginPhone({ users, raw: '', role: 'client' }).value, null, 'blank clears it');
  assert.equal(pl.checkLoginPhone({ users, raw: '(470) 555-0188', role: 'family' }).value, '+14705550188');
});

test('who gets update texts: a phone sign-in with no inbox, active, who has not said STOP', () => {
  const [, dot, ann, kim] = USERS();
  assert.ok(pl.mayTextNotices(dot));
  assert.ok(pl.mayTextNotices(kim));
  assert.ok(!pl.mayTextNotices(ann), 'has an inbox: email rules apply');
  assert.ok(!pl.mayTextNotices({ ...dot, accountStatus: 'inactive' }));
  assert.ok(!pl.mayTextNotices({ ...dot, smsOptIn: { enabled: false, changedBy: 'text STOP' } }), 'STOP is honoured');
  assert.ok(!pl.mayTextNotices({ ...dot, loginPhone: undefined }), 'a placeholder with no phone sign-in hears nothing');
});

test('where a reset link goes: what was typed decides, and only to the number on the account', () => {
  const [, dot, ann] = USERS();
  assert.equal(pl.resetChannel(dot, '404-555-0111'), 'sms');
  assert.equal(pl.resetChannel(dot, undefined), 'sms', 'the office sends to the phone when there is no email');
  assert.equal(pl.resetChannel(dot, 'someone@example.com'), null);
  assert.equal(pl.resetChannel(ann, 'ann@example.com'), 'email');
  assert.equal(pl.resetChannel(ann, '404-555-0122'), 'sms');
  assert.equal(pl.resetChannel(ann, undefined), 'email', 'email first when the account has one');
  assert.equal(pl.resetChannel(ann, '404-555-0999'), null, 'never to a number someone types');
  assert.equal(pl.resetChannel({ ...dot, accountStatus: 'inactive' }, '404-555-0111'), null);
});

test('the texts say nothing about anyone\'s health, and a STOP line comes with the first', () => {
  const n = pl.noticeText({ portalUrl: 'https://app.test/portal', first: true });
  assert.match(n, /^Godwins Family Care: You have a new update in your portal/);
  assert.match(n, /Reply STOP/);
  assert.doesNotMatch(pl.noticeText({ portalUrl: 'u', first: false }), /STOP/);
  assert.match(pl.resetText({ url: 'https://app.test/password-reset-abc', purpose: 'self_service' }), /expires in 1 hour: https:\/\/app\.test\/password-reset-abc/);
  assert.match(pl.resetText({ url: 'u', purpose: 'admin' }), /24 hours/);
  assert.doesNotMatch(pl.passwordChangedText({ officePhone: '(404) 913-6705' }), /https?:/);
  assert.equal(pl.portalLinkFor('/portal#messages', 'https://app.test/'), 'https://app.test/portal#messages');
  assert.equal(pl.portalLinkFor('https://app.test/portal?for=c1', 'https://x'), 'https://app.test/portal?for=c1');
  assert.equal(pl.portalLinkFor(null, 'https://app.test'), 'https://app.test/portal');
});

test('a reply texted from a sign-in phone is recognised as that person', () => {
  const users = USERS();
  assert.deepEqual(q.matchPhone('4045550111', users).map(h => [h.user.id, h.isPoa]), [['c-dot', false]]);
  assert.deepEqual(q.matchPhone('4045550133', users).map(h => [h.user.id, h.client.id, h.isPoa]), [['f-phone', 'c-dot', true]]);
});

// ---------------------------------------------------------------- the router
const sign = (raw, ts = Date.now()) => {
  const mac = crypto.createHmac('sha256', Buffer.from(SECRET, 'base64')).update(Buffer.concat([Buffer.from(ts + '.'), Buffer.from(raw)])).digest('base64');
  return `hmac;1;${ts};${mac}`;
};
const boot = async (opts = {}) => {
  const store = new Map([['users', opts.users || USERS()]]);
  const db = { get: async (k) => (store.has(k) ? JSON.parse(JSON.stringify(store.get(k))) : null), set: async (k, v) => { store.set(k, JSON.parse(JSON.stringify(v))); } };
  const notices = []; const texts = [];
  const smsClient = { sendText: async ({ to, content }) => { if (opts.quoDown) throw new Error('quo down'); texts.push({ to, content }); return { id: 'QM' + texts.length }; } };
  const getUsers = async () => await db.get('users');
  const authenticateToken = async (req, res, next) => {
    const u = (await getUsers()).find(x => x.id === req.headers['x-as']);
    if (!u) return res.status(401).json({ code: 'AUTH_MISSING' });
    req.user = { id: u.id, email: u.email, name: u.name, role: u.role, hasClinicalAccess: !!u.hasClinicalAccess, accountStatus: 'active' };
    next();
  };
  const app = express();
  app.use('/api/webhooks/quo', express.raw({ type: '*/*' }));
  app.use(express.json());
  const router = messagingRoutes({
    db, config, logActivity: async () => {},
    queueNotification: async (type, id, email) => { notices.push({ type, id, email }); return { queued: true }; },
    getUsers, authenticateToken, uuidv4, smsClient, getAppBaseUrl: async () => 'https://app.test.local',
    notify: () => ({ staffMessageWaiting: async () => {} })
  });
  app.use(router);
  const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (as, method, p, json) => {
    const res = await fetch(base + p, { method, headers: { 'x-as': as || '', 'Content-Type': 'application/json' }, body: json ? JSON.stringify(json) : undefined });
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  const hook = async (evt) => {
    const raw = JSON.stringify(evt);
    const res = await fetch(base + '/api/webhooks/quo', { method: 'POST', headers: { 'Content-Type': 'application/json', 'openphone-signature': sign(raw) }, body: raw });
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  return { store, notices, texts, router, call, hook, close: () => server.close() };
};
const rows = (h, k) => h.store.get(k) || [];

test('an update notice is queued as a PHI-free text to the sign-in phone, one at a time', async () => {
  const h = await boot();
  try {
    const user = USERS()[1];
    const id1 = await h.router.sms.queueNoticeText({ user, portalUrl: 'https://app.test.local/portal' });
    const id2 = await h.router.sms.queueNoticeText({ user, portalUrl: 'https://app.test.local/portal' });
    const box = rows(h, 'sms_outbox');
    const row = box[0];
    assert.equal(row.kind, 'notice');
    assert.equal(row.to, '+14045550111');
    assert.match(row.content, /You have a new update in your portal/);
    assert.match(row.content, /Reply STOP/, 'first text offers STOP');
    // Sent now, or held for 8am Eastern depending on when this runs. A second
    // notice while the first is still WAITING collapses into it.
    if (row.status === 'waiting') { assert.equal(id2, id1); assert.equal(box.length, 1); }
    else {
      assert.equal(row.status, 'sent');
      assert.equal(box.length, 2);
      assert.doesNotMatch(box[1].content, /STOP/, 'STOP is offered on the first text only');
    }
    // Someone with an inbox is never texted this way.
    assert.equal(await h.router.sms.queueNoticeText({ user: USERS()[2], portalUrl: 'u' }), null);
  } finally { h.close(); }
});

test('a notice queued before a STOP never goes', async () => {
  const h = await boot();
  try {
    const user = USERS()[1];
    const box = [{ id: 'r1', kind: 'notice', to: user.loginPhone, user_id: user.id, content: 'x', status: 'waiting', send_after: new Date(0).toISOString(), attempts: 0, created_at: new Date().toISOString() }];
    h.store.set('sms_outbox', box);
    h.store.set('users', USERS().map(u => u.id === user.id ? { ...u, smsOptIn: { enabled: false, changedBy: 'text STOP' } } : u));
    await h.router.sms.sendOutboxRow('r1');
    assert.equal(rows(h, 'sms_outbox')[0].status, 'cancelled');
    assert.equal(h.texts.length, 0);
  } finally { h.close(); }
});

test('a reset text is sent at once and its words (the link) are never stored', async () => {
  const h = await boot();
  try {
    const user = USERS()[1];
    const content = pl.resetText({ url: 'https://app.test.local/password-reset-' + 'a'.repeat(64), purpose: 'self_service' });
    const r = await h.router.sms.sendAccountText({ user, to: user.loginPhone, content, kind: 'password_link' });
    assert.equal(r.ok, true);
    assert.equal(h.texts.length, 1);
    assert.equal(h.texts[0].to, '+14045550111');
    assert.match(h.texts[0].content, /password-reset-a{64}/);
    const stored = JSON.stringify(rows(h, 'sms_outbox'));
    assert.ok(!stored.includes('password-reset-'), 'the link never reaches the database');
    const row = rows(h, 'sms_outbox')[0];
    assert.equal(row.status, 'sent');
    assert.equal(row.content, '');
    assert.ok(/^[0-9a-f]{64}$/.test(row.content_sha));

    // Quo's webhook for that same send must be recognised as ours, never
    // written into a Care Team thread as "a reply typed in the Quo app".
    const evt = { type: 'message.delivered', createdAt: new Date().toISOString(),
      data: { object: { id: 'AC-other-id', object: 'message', from: OFFICE, to: [user.loginPhone], direction: 'outgoing', body: content, media: [], userId: 'US1', createdAt: new Date().toISOString() } } };
    const res = await h.hook(evt);
    assert.equal(res.status, 200);
    assert.ok(!rows(h, 'messages').some(m => String(m.body || '').includes('password-reset-')), 'the link is never recorded in a thread');
  } finally { h.close(); }
});

test('a reset text that Quo refuses is reported, not assumed', async () => {
  const h = await boot({ quoDown: true });
  try {
    const user = USERS()[1];
    const r = await h.router.sms.sendAccountText({ user, to: user.loginPhone, content: 'x', kind: 'password_link' });
    assert.equal(r.ok, false);
    assert.equal(rows(h, 'sms_outbox')[0].status, 'failed');
  } finally { h.close(); }
});

test('a Care Team message reaches a patient who signs in by phone (it used to skip anyone without an inbox)', async () => {
  const h = await boot();
  try {
    const r = await h.call('fnp-1', 'POST', '/api/messaging/threads', { channel: 'care_team', clientId: 'c-dot', body: 'See you Tuesday.' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    await new Promise(res => setTimeout(res, 50));
    // Handed to the queue, which turns it into a text (server.js textInPlaceOfEmail).
    assert.ok(h.notices.some(n => n.type === 'message_received' && n.id === 'c-dot'), JSON.stringify(h.notices));
    assert.ok(h.notices.some(n => n.type === 'message_received' && n.id === 'f-phone'), 'their POA who signs in by phone too');
  } finally { h.close(); }
});

// ---------------------------------------------------------------- server.js wiring
const SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const strip = (s) => s.replace(/^\s*\/\/.*$/gm, '');
const between = (a, b) => { const i = SRC.indexOf(a); assert.ok(i !== -1, a); return strip(SRC.slice(i, SRC.indexOf(b, i + a.length))); };

test('server: both sign-in routes look a person up by email OR phone', () => {
  assert.match(between("app.post('/api/auth/login'", "app.post('/api/auth/client-login'"), /phoneLogin\.findByIdentifier\(users, email\)/);
  assert.match(between("app.post('/api/auth/client-login'", '// ============== SELF SIGN-UP'), /phoneLogin\.findByIdentifier\(users, email, \{ roles:/);
});

test('server: every notice checks for a phone sign-in BEFORE the email skip', () => {
  const body = between('const queueNotification = async', '\n};\n');
  const t = body.indexOf('textInPlaceOfEmail(');
  const e = body.indexOf('recipientMayBeEmailed(');
  assert.ok(t !== -1 && e !== -1 && t < e);
  const helper = between('const textInPlaceOfEmail = async', '\n};\n');
  assert.match(helper, /phoneLogin\.mayTextNotices\(user\)/);
  // Only a link reaches the text; the email's own wording never does.
  assert.match(helper, /queueNoticeText\(\{ user, portalUrl \}\)/);
  assert.doesNotMatch(helper, /templateData\.body|htmlBody/);
});

test('server: a texted reset link goes through the unstored send, keeps the token rules, and falls back to the office', () => {
  const issue = between('async function issuePasswordSetLink', '\n}\n');
  assert.match(issue, /passwordSetLinks\.buildLink/);
  assert.match(issue, /sms\.sendAccountText\(/);
  assert.doesNotMatch(issue, /queueNoticeText|sms_outbox/, 'never the stored outbox');
  const forgot = between("app.post('/api/auth/forgot-password'", "app.post('/api/auth/reset-password'");
  assert.match(forgot, /phoneLogin\.findByIdentifier\(users, typed\)/);
  assert.match(forgot, /overSelfServiceLimit/, 'the 3-per-hour limit still applies to texts');
  assert.match(forgot, /if \(!issued\.ok\)[\s\S]*fileForOffice\('text_failed'\)/);
});

test('server: a new phone sign-in is welcomed with a link to choose a password, never a password', () => {
  const welcome = between('async function sendPhoneWelcome', '\n}\n');
  assert.match(welcome, /purpose: 'admin'/);
  assert.doesNotMatch(welcome, /tempPassword|generateTempPassword/);
  const create = between("app.post('/api/users'", "app.get('/api/client-portals'");
  assert.match(create, /phoneLogin\.checkLoginPhone\(\{ users, raw: loginPhone, role \}\)/);
  assert.match(create, /sendPhoneWelcome\(newUser\)/);
});
