// ============================================================
// Care Team messages by text through Quo (owner, 2026-10-15): "I want the
// messages bi directional", and "make sure both patient and POA phone numbers
// are recognized as being connected to the patient".
//
// The REAL messaging router on real Express; only the store, the notification
// queue and the Quo client are stand-ins. Webhooks are signed exactly as Quo
// signs them. Every assertion reads stored values back.
// ============================================================
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const express = require('express');
const { v4: uuidv4 } = require('uuid');

const config = require('../config');
const messagingRoutes = require('../routes/messaging');
const q = require('../quoSms');

const SECRET = Buffer.from('test-signing-secret').toString('base64');
process.env.QUO_API_KEY = 'test-key';
process.env.QUO_WEBHOOK_SECRET = SECRET;
delete process.env.QUO_FROM_NUMBER;
const OFFICE = '+14049136705';

const USERS = () => [
  { id: 'admin-1', name: 'GFC Admin', email: 'admin@test.local', role: 'admin' },
  { id: 'fnp-1', name: 'Bethel Godwins', email: 'fnp@test.local', role: 'user', hasClinicalAccess: true },
  { id: 'client-1', name: 'Juanita Guess', email: 'c1@test.local', role: 'client', intake: { phone: '404-555-0100' },
    smsOptIn: { enabled: true, optedInAt: '2026-10-01T00:00:00Z' }, careTeam: { assignedFNPs: ['fnp-1'] } },
  { id: 'poa-1', name: 'Luka Agent', email: 'poa@test.local', role: 'family', familyOfClientId: 'client-1', familyIsPoa: true,
    phone: '(404) 555-0200', smsOptIn: { enabled: true, optedInAt: '2026-10-01T00:00:00Z' } },
  { id: 'fam-1', name: 'Sam Relative', email: 'fam@test.local', role: 'family', familyOfClientId: 'client-1', phone: '404-555-0300' },
  { id: 'client-2', name: 'Harold Vance', email: 'c2@test.local', role: 'client', intake: { phone: '404-555-0400' }, careTeam: { assignedFNPs: ['fnp-1'] } },
  { id: 'client-3', name: 'Mae Vance', email: 'c3@test.local', role: 'client', intake: { phone: '404-555-0400' }, careTeam: { assignedFNPs: ['fnp-1'] } }
];

const sign = (raw, ts = Date.now()) => {
  const mac = crypto.createHmac('sha256', Buffer.from(SECRET, 'base64')).update(Buffer.concat([Buffer.from(ts + '.'), Buffer.from(raw)])).digest('base64');
  return `hmac;1;${ts};${mac}`;
};
const incoming = (from, body, id = 'AC' + uuidv4().slice(0, 8)) => ({ type: 'message.received', createdAt: new Date().toISOString(),
  data: { object: { id, object: 'message', from, to: [OFFICE], direction: 'incoming', body, media: [], createdAt: new Date().toISOString() } } });
const outgoing = (to, body, id = 'AC' + uuidv4().slice(0, 8)) => ({ type: 'message.delivered', createdAt: new Date().toISOString(),
  data: { object: { id, object: 'message', from: OFFICE, to: [to], direction: 'outgoing', body, media: [], userId: 'US1', createdAt: new Date().toISOString() } } });

const boot = async (opts = {}) => {
  const store = new Map([['users', opts.users || USERS()]]);
  const db = { get: async (k) => (store.has(k) ? JSON.parse(JSON.stringify(store.get(k))) : null), set: async (k, v) => { store.set(k, JSON.parse(JSON.stringify(v))); } };
  const notices = []; const texts = []; const activity = [];
  const smsClient = { sendText: async ({ to, content }) => { if (opts.quoDown) throw new Error('quo down'); texts.push({ to, content }); return { id: 'QM' + texts.length }; } };
  const getUsers = async () => await db.get('users');
  const authenticateToken = async (req, res, next) => {
    const u = (await getUsers()).find(x => x.id === req.headers['x-as']);
    if (!u) return res.status(401).json({ code: 'AUTH_MISSING' });
    req.user = { id: u.id, email: u.email, name: u.name, role: u.role, hasClinicalAccess: !!u.hasClinicalAccess,
      familyOfClientId: u.familyOfClientId || null, familyIsPoa: !!u.familyIsPoa, isManager: !!u.isManager, accountStatus: 'active' };
    next();
  };
  const app = express();
  app.use('/api/webhooks/quo', express.raw({ type: '*/*' }));
  app.use(express.json());
  const router = messagingRoutes({
    db, config, logActivity: async (...a) => { activity.push(a); },
    queueNotification: async (type, id, email) => { notices.push({ type, id, email }); return { queued: true }; },
    getUsers, authenticateToken, uuidv4, smsClient, getAppBaseUrl: async () => 'https://app.test.local',
    notify: () => ({ staffMessageWaiting: async ({ user }) => { notices.push({ type: 'staff', id: user.id }); } })
  });
  app.use(router);
  const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (as, method, p, json) => {
    const res = await fetch(base + p, { method, headers: { 'x-as': as || '', 'Content-Type': 'application/json' }, body: json ? JSON.stringify(json) : undefined });
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  const hook = async (evt, { badSig = false, ts } = {}) => {
    const raw = JSON.stringify(evt);
    const res = await fetch(base + '/api/webhooks/quo', { method: 'POST', headers: { 'Content-Type': 'application/json', 'openphone-signature': badSig ? sign(raw + 'x', ts) : sign(raw, ts) }, body: raw });
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  return { store, notices, texts, activity, call, hook, router, close: () => server.close() };
};
const stored = (h, k) => h.store.get(k) || [];

test('pure: phone numbers, keywords, quiet hours, wording', () => {
  assert.equal(q.toE164('(404) 913-6705'), '+14049136705');
  assert.equal(q.toE164('1-404-913-6705'), '+14049136705');
  assert.equal(q.toE164('555-0100'), null);
  assert.equal(q.keyword(' Stop. '), 'stop');
  assert.equal(q.keyword('please stop the evening visits'), null);
  assert.equal(q.quietUntil(new Date('2026-10-15T16:00:00Z')), null);            // noon Eastern
  assert.equal(q.quietUntil(new Date('2026-10-15T02:00:00Z')), '2026-10-15T12:00:00.000Z');   // 10pm → 8am EDT
  assert.equal(q.quietUntil(new Date('2026-12-15T10:00:00Z')), '2026-12-15T13:00:00.000Z');   // 5am EST → 8am EST
  const t = q.outgoingText({ senderName: 'Bethel', body: '**Take** it with food', format: 'markup', attachmentCount: 2, portalUrl: 'https://x/portal#messages', first: true });
  assert.match(t, /from Bethel:\nTake it with food/);
  assert.match(t, /2 files are waiting in your portal/);
  assert.match(t, /Reply STOP/);
  assert.doesNotMatch(q.outgoingText({ body: 'x', portalUrl: 'u', first: false }), /STOP/);
});

test('pure: the signature is checked against the exact bytes and the clock', () => {
  const raw = '{"a":1}';
  assert.ok(q.verifySignature(Buffer.from(raw), sign(raw), SECRET));
  assert.ok(!q.verifySignature(Buffer.from(raw + ' '), sign(raw), SECRET));
  assert.ok(!q.verifySignature(Buffer.from(raw), sign(raw, Date.now() - 60 * 60 * 1000), SECRET));
  assert.ok(!q.verifySignature(Buffer.from(raw), undefined, SECRET));
});

test('pure: the patient AND their POA are recognised as the patient; plain family are not', () => {
  const users = USERS();
  const p = q.matchPhone('+14045550100', users);
  assert.deepEqual(p.map(h => [h.user.id, h.client.id, h.isPoa]), [['client-1', 'client-1', false]]);
  const poa = q.matchPhone('4045550200', users);
  assert.deepEqual(poa.map(h => [h.user.id, h.client.id, h.isPoa]), [['poa-1', 'client-1', true]]);
  assert.equal(q.matchPhone('4045550300', users).length, 0);
});

test('a clinician message is texted to the patient and the POA who turned texts on', async () => {
  const h = await boot();
  try {
    const r = await h.call('fnp-1', 'POST', '/api/messaging/threads', { channel: 'care_team', clientId: 'client-1', body: 'Your labs look good.' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    await new Promise(res => setTimeout(res, 50));
    const box = stored(h, 'sms_outbox');
    const toNow = box.filter(x => x.status === 'sent').map(x => x.to).sort();
    const waiting = box.filter(x => x.status === 'waiting').map(x => x.to).sort();
    // Depending on the hour this test runs, a text is sent or held for 8am.
    assert.deepEqual([...toNow, ...waiting].sort(), ['+14045550100', '+14045550200']);
    for (const t of h.texts) assert.match(t.content, /Your labs look good\./);
    // Plain family is never texted.
    assert.ok(!box.some(x => x.user_id === 'fam-1'));
  } finally { h.close(); }
});

test('nobody is texted who has not turned texts on, or on another channel', async () => {
  const users = USERS().map(u => (u.id === 'client-1' || u.id === 'poa-1') ? { ...u, smsOptIn: null } : u);
  const h = await boot({ users });
  try {
    await h.call('fnp-1', 'POST', '/api/messaging/threads', { channel: 'care_team', clientId: 'client-1', body: 'hello' });
    assert.equal(stored(h, 'sms_outbox').length, 0);
  } finally { h.close(); }
  const h2 = await boot();
  try {
    // The office writing to the patient on Support: emailed, never texted.
    const r = await h2.call('admin-1', 'POST', '/api/messaging/threads', { channel: 'support', clientId: 'client-1', recipientIds: ['client-1'], body: 'billing question' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.ok(h2.notices.some(n => n.id === 'client-1'), 'the patient is still emailed');
    assert.equal(stored(h2, 'sms_outbox').length, 0);
  } finally { h2.close(); }
});

test('a text from the patient lands in their Care Team thread as them', async () => {
  const h = await boot();
  try {
    const t = await h.call('fnp-1', 'POST', '/api/messaging/threads', { channel: 'care_team', clientId: 'client-1', body: 'How are you feeling?' });
    const r = await h.hook(incoming('+14045550100', 'Much better today'));
    assert.equal(r.data.outcome, 'recorded', JSON.stringify(r.data));
    const m = stored(h, 'messages').find(x => x.body === 'Much better today');
    assert.ok(m);
    assert.equal(m.thread_id, t.data.thread.id);
    assert.equal(m.from_user_id, 'client-1');
    assert.equal(m.via, 'sms');
    // The clinician is told, and reads it in the thread.
    assert.ok(h.notices.some(n => n.type === 'staff' && n.id === 'fnp-1'));
    const read = await h.call('fnp-1', 'GET', `/api/messaging/threads/${t.data.thread.id}`);
    assert.ok(read.data.messages.some(x => x.body === 'Much better today' && x.via === 'sms'));
  } finally { h.close(); }
});

test('a text from the POA lands in the patient\'s thread, attributed to the POA', async () => {
  const h = await boot();
  try {
    const r = await h.hook(incoming('(404) 555-0200', 'She slept well'));
    assert.equal(r.data.outcome, 'recorded', JSON.stringify(r.data));
    const m = stored(h, 'messages').find(x => x.body === 'She slept well');
    assert.equal(m.client_id, 'client-1');
    assert.equal(m.from_user_id, 'poa-1');
    assert.equal(m.from_role, 'POA');
    assert.match(m.display_name, /as POA for Juanita Guess/);
    const th = stored(h, 'message_threads').find(x => x.id === m.thread_id);
    assert.equal(th.channel, 'care_team');
  } finally { h.close(); }
});

test('unknown and shared numbers are never guessed; a retried webhook is recorded once', async () => {
  const h = await boot();
  try {
    assert.equal((await h.hook(incoming('+17705550999', 'who is this'))).data.outcome, 'unknown_number');
    assert.equal((await h.hook(incoming('+14045550400', 'hi'))).data.outcome, 'ambiguous_number');
    const evt = incoming('+14045550100', 'once only', 'ACdup');
    await h.hook(evt); const again = await h.hook(evt);
    assert.equal(again.data.outcome, 'duplicate');
    assert.equal(stored(h, 'messages').filter(x => x.body === 'once only').length, 1);
    assert.equal(stored(h, 'messages').filter(x => x.body === 'who is this' || x.body === 'hi').length, 0);
  } finally { h.close(); }
});

test('an unsigned or badly signed webhook is refused and writes nothing', async () => {
  const h = await boot();
  try {
    const r = await h.hook(incoming('+14045550100', 'forged'), { badSig: true });
    assert.equal(r.status, 401);
    assert.equal(stored(h, 'messages').length, 0);
  } finally { h.close(); }
});

test('STOP turns texts off for that person; START turns them back on', async () => {
  const h = await boot();
  try {
    await h.hook(incoming('+14045550200', 'STOP'));
    let poa = stored(h, 'users').find(u => u.id === 'poa-1');
    assert.equal(poa.smsOptIn.enabled, false);
    assert.equal(stored(h, 'messages').length, 0, 'STOP is not a message');
    await h.call('fnp-1', 'POST', '/api/messaging/threads', { channel: 'care_team', clientId: 'client-1', body: 'update' });
    assert.ok(!stored(h, 'sms_outbox').some(x => x.user_id === 'poa-1'));
    await h.hook(incoming('+14045550200', 'start'));
    poa = stored(h, 'users').find(u => u.id === 'poa-1');
    assert.equal(poa.smsOptIn.enabled, true);
  } finally { h.close(); }
});

test('a reply typed in the Quo app is recorded once; our own send is not recorded twice', async () => {
  const h = await boot();
  try {
    const t = await h.call('fnp-1', 'POST', '/api/messaging/threads', { channel: 'care_team', clientId: 'client-1', body: 'Check your BP tonight.' });
    // Our own send, echoed back by Quo.
    const sent = stored(h, 'sms_outbox').find(x => x.status === 'sent' && x.to === '+14045550100');
    if (sent) assert.equal((await h.hook(outgoing('+14045550100', sent.content, sent.quo_message_id))).data.outcome, 'own_send');
    // Office staff answer in the Quo app.
    const r = await h.hook(outgoing('+14045550100', 'We moved your visit to 2pm.'));
    assert.equal(r.data.outcome, 'recorded_office_text');
    const m = stored(h, 'messages').find(x => x.body === 'We moved your visit to 2pm.');
    assert.equal(m.thread_id, t.data.thread.id);
    assert.match(m.display_name, /GFC office \(by text/);
    // The patient already has it, so they are not texted it again.
    assert.ok(!stored(h, 'sms_outbox').some(x => x.message_id === m.id));
    assert.ok(h.notices.some(n => n.type === 'staff' && n.id === 'fnp-1'));
  } finally { h.close(); }
});

test('a failed send is retried and then gives up; a turned-off switch cancels a waiting text', async () => {
  const h = await boot({ quoDown: true });
  try {
    await h.call('fnp-1', 'POST', '/api/messaging/threads', { channel: 'care_team', clientId: 'client-1', body: 'x' });
    const box = stored(h, 'sms_outbox');
    assert.ok(box.every(r => r.status === 'retry' || r.status === 'waiting'));
    // Make every row due and drain until it gives up.
    for (let i = 0; i < 6; i++) {
      const rows = stored(h, 'sms_outbox').map(r => ({ ...r, send_after: '2000-01-01T00:00:00Z' }));
      h.store.set('sms_outbox', rows);
      await h.router.sms.drainSmsOutbox();
    }
    assert.ok(stored(h, 'sms_outbox').every(r => r.status === 'failed'));
    // A waiting text for someone who then turned texts off never goes.
    const users = stored(h, 'users').map(u => u.id === 'client-1' ? { ...u, smsOptIn: { enabled: false } } : u);
    h.store.set('users', users);
    h.store.set('sms_outbox', [{ id: 'w1', to: '+14045550100', user_id: 'client-1', content: 'x', status: 'waiting', send_after: '2000-01-01T00:00:00Z', attempts: 0 }]);
    await h.router.sms.drainSmsOutbox();
    assert.equal(stored(h, 'sms_outbox')[0].status, 'cancelled');
  } finally { h.close(); }
});
