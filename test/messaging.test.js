// ============================================================================
// Session 9 — messaging: the channel matrix and role-based visibility
//
// The rules under test are the ones that decide who can read a conversation
// about a patient. Every one is asserted from the repository's own functions,
// not by parsing a route, except the handful of BUILD-ENFORCED invariants at
// the bottom that exist to stop a future session quietly undoing a control.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const msg = require('../messagingRepository');

// ---- Fixtures — TEST DATA ONLY ---------------------------------------------
const CLIENT = {
  id: 'client-1', name: 'Margaret Whitfield (TEST DATA)', role: 'client',
  careTeam: { assignedFNPs: ['fnp-1'], assignedCaseManager: 'cm-1', primaryCaregiver: 'cg-1', backupCaregiver: null }
};
const OTHER_CLIENT = { id: 'client-2', name: 'Harold Vance (TEST DATA)', role: 'client', careTeam: {} };
const USERS = [
  { id: 'admin-1', name: 'GFC Admin', role: 'admin' },
  { id: 'fnp-1', name: 'Bethel Godwins', role: 'user', hasClinicalAccess: true },
  { id: 'cm-1', name: 'Courtney Hale', role: 'caseManager' },
  { id: 'cg-1', name: 'Cam CNA', role: 'vendor', licenseLevel: 'cna', accountStatus: 'active' },
  { id: 'cg-2', name: 'Pat PCA', role: 'vendor', licenseLevel: 'pca', accountStatus: 'active' },
  { id: 'fam-1', name: 'Ada Vance', role: 'family', familyOfClientId: 'client-1' },
  CLIENT, OTHER_CLIENT
];
const u = (id) => USERS.find(x => x.id === id);
const thread = (extra = {}) => ({
  id: 't-1', channel: 'support', client_id: 'client-1', participant_ids: ['client-1', 'admin-1'],
  status: 'open', ...extra
});

// ============================================================================
// 1. The channel matrix
// ============================================================================

test('every row of the brief\'s matrix resolves to a channel covering both ends', () => {
  // The brief lists eleven FROM→TO rows; the owner added four on 2026-09-13
  // (client↔case manager both ways, clinician→client, case manager→caregiver).
  // The module stores ten channels, because several rows are one conversation
  // read from either end. This is the test that makes that collapse safe: lose
  // a row and it fails.
  assert.strictEqual(msg.MATRIX_ROWS.length, 15, 'eleven from the brief, four from the owner');
  const brief = msg.MATRIX_ROWS.slice(0, 11);
  assert.ok(brief.every(r => msg.channelById(r.channel)), 'the brief\'s own eleven still resolve');
  for (const row of msg.MATRIX_ROWS) {
    const c = msg.channelById(row.channel);
    assert.ok(c, `${row.from}→${row.to} has no channel`);
    assert.strictEqual(c.label, row.label, `${row.channel} label must match the brief`);
    assert.ok(c.initiators.includes(row.from), `${row.from} must be able to open ${row.channel}`);
    if (row.to !== '*') {
      assert.ok(c.participants.includes(row.to), `${row.to} must be a participant of ${row.channel}`);
    }
  }
});

test('SAFETY: no channel exists that the brief did not ask for', () => {
  const fromMatrix = new Set(msg.MATRIX_ROWS.map(r => r.channel));
  const extra = msg.CHANNEL_IDS.filter(id => !fromMatrix.has(id));
  assert.deepStrictEqual(extra, [], `channels not in the matrix: ${extra.join(', ')}`);
});

test('a role is offered only the channels it may open', () => {
  const ids = (user) => msg.channelsFor({ user, client: CLIENT, users: USERS }).map(c => c.id).sort();
  assert.deepStrictEqual(ids(u('client-1')), ['care_coordination', 'clinical_escalation', 'direct_care', 'support']);
  assert.deepStrictEqual(ids(u('cg-1')), ['behavioral_escalation', 'direct_care', 'family_portal', 'operations']);
  assert.deepStrictEqual(ids(u('fam-1')), ['family_portal', 'support']);
  assert.deepStrictEqual(ids(u('fnp-1')), ['care_update', 'clinical_escalation', 'clinical_oversight']);
  // A case manager had NO channel at all: they could receive a behavioral
  // escalation and start nothing, so they could not reach the client whose care
  // they coordinate. Owner rule 2026-09-13.
  assert.deepStrictEqual(ids(u('cm-1')), ['behavioral_escalation', 'care_coordination']);
});

test('OWNER RULE: admin opens every channel, and a lab-era manager counts as admin', () => {
  // "admin / manager should be able to message anyone." There is no distinct
  // GFC manager role — `isManager` is a lab-era flag that collapses to admin
  // everywhere else in the app, so it collapses here too rather than inventing
  // a role the role model does not have.
  const ids = (user) => msg.channelsFor({ user, client: CLIENT, users: USERS }).map(c => c.id).sort();
  assert.deepStrictEqual(ids(u('admin-1')), [...msg.CHANNEL_IDS].sort());
  const manager = { id: 'mgr-1', name: 'Ops Manager', role: 'user', isManager: true };
  assert.deepStrictEqual(ids(manager), [...msg.CHANNEL_IDS].sort());
});

test('OWNER RULE: a staff member who can SEE a thread can ANSWER it', () => {
  // The reported defect: an administrator opened a Direct thread, read every
  // word, and was told "Admins do not post in Direct". Visibility is already
  // the stricter control, so it decides posting for staff.
  for (const ch of msg.CHANNEL_IDS) {
    const t = thread({ channel: ch, participant_ids: ['client-1', 'cg-1'] });
    const r = msg.canPostToThread(u('admin-1'), t, { client: CLIENT });
    assert.strictEqual(r.allowed, true, `an admin must be able to reply in ${ch} (got ${r.code})`);
  }
  // A clinician on this client's team can answer a Direct thread they can see.
  const direct = thread({ channel: 'direct_care', participant_ids: ['client-1', 'cg-1'] });
  assert.strictEqual(msg.canPostToThread(u('fnp-1'), direct, { client: CLIENT }).allowed, true);
  // And it does NOT hand posting to a non-staff role the channel excludes.
  const oversight = thread({ channel: 'clinical_oversight', participant_ids: ['fnp-1', 'cg-1'] });
  assert.strictEqual(msg.canPostToThread(u('fam-1'), oversight, { client: CLIENT }).allowed, false);
});

test('actorRole reads a clinician from the FLAG, not a role string', () => {
  // A clinician is `user` + hasClinicalAccess. Reading req.user.role alone
  // would file every clinician as a generic user and give them nothing.
  assert.strictEqual(msg.actorRole(u('fnp-1')), 'clinical');
  assert.strictEqual(msg.actorRole(u('cg-1')), 'vendor');
  assert.strictEqual(msg.actorRole(u('cm-1')), 'caseManager');
  assert.strictEqual(msg.actorRole({ role: 'user' }), null, 'a plain user has no messaging role');
});

// ============================================================================
// 2. Client ↔ caregiver turns on and off with the assignment
// ============================================================================

test('SAFETY: with no caregiver assigned the channel is DISABLED WITH A REASON, not hidden', () => {
  const orphan = { id: 'client-3', name: 'No Caregiver', careTeam: {} };
  const a = msg.channelAvailability('direct_care', { user: u('client-1'), client: orphan, users: USERS });
  assert.strictEqual(a.available, false);
  assert.strictEqual(a.code, 'NO_CAREGIVER_ASSIGNED');
  assert.match(a.reason, /no caregiver is assigned/i);

  // And it is still LISTED, so the person can read why rather than hunt for a
  // button that is not there.
  const listed = msg.channelsFor({ user: u('client-1'), client: orphan, users: USERS });
  assert.ok(listed.some(c => c.id === 'direct_care'), 'the channel is listed even when unavailable');
});

test('assigning a caregiver enables it, and deactivating them disables it again', () => {
  const on = msg.channelAvailability('direct_care', { user: u('client-1'), client: CLIENT, users: USERS });
  assert.strictEqual(on.available, true);

  const inactive = USERS.map(x => x.id === 'cg-1' ? { ...x, accountStatus: 'inactive' } : x);
  const off = msg.channelAvailability('direct_care', { user: u('client-1'), client: CLIENT, users: inactive });
  assert.strictEqual(off.available, false, 'a deactivated caregiver is not somebody on the other end');
});

test('a missing clinician or case manager does NOT block the escalation — it says where it went', () => {
  // Refusing to let someone raise a clinical concern because nobody is
  // assigned is the worst possible failure mode. Session 6 settled this for
  // visit-log escalations; messaging follows it.
  const bare = { id: 'client-4', name: 'Unassigned', careTeam: { primaryCaregiver: 'cg-1' } };
  const clin = msg.channelAvailability('clinical_escalation', { user: u('client-1'), client: bare, users: USERS });
  assert.strictEqual(clin.available, true, 'still sendable');
  assert.strictEqual(clin.code, 'NO_CLINICIAN_ASSIGNED');
  assert.match(clin.reason, /goes to the office/i);

  const beh = msg.channelAvailability('behavioral_escalation', { user: u('cg-1'), client: bare, users: USERS });
  assert.strictEqual(beh.available, true);
  assert.strictEqual(beh.code, 'NO_CASE_MANAGER_ASSIGNED');
});

// ============================================================================
// 3. Visibility — the rules that keep a conversation where it belongs
// ============================================================================

test('SAFETY: a caregiver cannot read a clinician-to-family thread about their OWN client', () => {
  // Being assigned to the client is necessary and NOT sufficient. This is the
  // acceptance criterion the brief names by hand.
  const careUpdate = thread({ id: 't-cu', channel: 'care_update', participant_ids: ['fnp-1', 'fam-1'] });
  const seen = msg.threadVisibility(u('cg-1'), careUpdate, { client: CLIENT });
  assert.strictEqual(seen.visible, false);
  assert.strictEqual(seen.code, 'THREAD_NOT_YOURS');
});

test('SAFETY: a caregiver cannot read a clinician-to-client thread either', () => {
  const clinical = thread({ id: 't-ce', channel: 'clinical_escalation', participant_ids: ['client-1', 'fnp-1'] });
  assert.strictEqual(msg.threadVisibility(u('cg-1'), clinical, { client: CLIENT }).visible, false);
});

test('a caregiver reads their own threads and nobody else\'s', () => {
  const mine = thread({ id: 't-d', channel: 'direct_care', participant_ids: ['client-1', 'cg-1'] });
  assert.strictEqual(msg.threadVisibility(u('cg-1'), mine, { client: CLIENT }).visible, true);
  assert.strictEqual(msg.threadVisibility(u('cg-2'), mine, { client: CLIENT }).visible, false,
    'another caregiver on the same client is still not a party');
});

test('OWNER RULE: a case manager is scoped to the clients assigned to THEM', () => {
  // "from case manager permission down, would be scoped to them only seeing
  // patients assigned to them." The scope is the CLIENT, not the channel: on
  // their own client they read every conversation, whether or not anyone named
  // them on it, which is consistent with the 08/2026 decision giving them
  // scoped clinical read. cm-1 is CLIENT's case manager; client-2 has none.
  for (const ch of msg.CHANNEL_IDS) {
    const t = thread({ id: `t-${ch}`, channel: ch, participant_ids: ['fnp-1', 'cg-1'] });
    assert.strictEqual(msg.threadVisibility(u('cm-1'), t, { client: CLIENT }).visible, true,
      `their own client's ${ch} thread is theirs to read`);
  }
  // Another case manager's client is refused on every channel.
  const other = { ...CLIENT, id: 'client-3', careTeam: { assignedCaseManager: 'cm-2' } };
  for (const ch of msg.CHANNEL_IDS) {
    const t = thread({ id: `x-${ch}`, channel: ch, client_id: 'client-3', participant_ids: ['fnp-1', 'cg-1'] });
    const r = msg.threadVisibility(u('cm-1'), t, { client: other });
    assert.strictEqual(r.visible, false, `a case manager must not read ${ch} for a client who is not theirs`);
    assert.strictEqual(r.code, 'CASE_MANAGER_SCOPE');
  }
});

test('SAFETY: a behavioral concern on a client with NO case manager still reaches one', () => {
  // The carve-out, and the reason the brief made behavioral role-based in the
  // first place. Scoping strictly by assignment would leave a concern raised
  // before anyone was assigned readable by no case manager at all.
  const unassigned = { id: 'client-4', name: 'Unassigned (TEST DATA)', role: 'client', careTeam: {} };
  const t = thread({ id: 't-u', channel: 'behavioral_escalation', client_id: 'client-4', participant_ids: ['cg-1'] });
  assert.strictEqual(msg.threadVisibility(u('cm-1'), t, { client: unassigned }).visible, true);
  // It is the ESCALATION that is carved out, not the client: everything else
  // about a client who is not theirs stays refused.
  const direct = thread({ id: 't-u2', channel: 'direct_care', client_id: 'client-4', participant_ids: ['cg-1'] });
  assert.strictEqual(msg.threadVisibility(u('cm-1'), direct, { client: unassigned }).visible, false);
});

test('OWNER RULE: the client reaches everyone on their care team, case manager included', () => {
  // "client can message anyone who is assigned to them as part of their care
  // team." The brief had no client↔case-manager row at all.
  const ids = msg.channelsFor({ user: u('client-1'), client: CLIENT, users: USERS }).map(c => c.id);
  assert.ok(ids.includes('care_coordination'), 'a client can open Care Coordination');
  assert.ok(ids.includes('direct_care'), 'and still reach their caregiver');
  assert.ok(ids.includes('clinical_escalation'), 'and still reach their clinician');
  const t = thread({ channel: 'care_coordination', participant_ids: ['client-1', 'cm-1'] });
  assert.strictEqual(msg.threadVisibility(u('client-1'), t, { client: CLIENT }).visible, true);
  assert.strictEqual(msg.canPostToThread(u('client-1'), t, { client: CLIENT }).allowed, true);
  // And it stays a client↔case-manager conversation: a caregiver is not in it.
  assert.strictEqual(msg.threadVisibility(u('cg-1'), t, { client: CLIENT }).visible, false);
});

test('OWNER RULE: clientInScope decides which clients each role may message about', () => {
  const other = { id: 'client-9', name: 'Not mine (TEST DATA)', role: 'client', careTeam: {} };
  assert.strictEqual(msg.clientInScope(u('admin-1'), other), true, 'admin reaches every client');
  assert.strictEqual(msg.clientInScope(u('cm-1'), CLIENT), true);
  assert.strictEqual(msg.clientInScope(u('cm-1'), other), false);
  assert.strictEqual(msg.clientInScope(u('fnp-1'), CLIENT), true);
  assert.strictEqual(msg.clientInScope(u('fnp-1'), other), false);
  assert.strictEqual(msg.clientInScope(u('cg-1'), CLIENT), true);
  assert.strictEqual(msg.clientInScope(u('cg-1'), other), false);
  assert.strictEqual(msg.clientInScope(u('client-1'), CLIENT), true);
  assert.strictEqual(msg.clientInScope(u('client-1'), other), false, 'a client reaches only their own record');
  assert.strictEqual(msg.clientInScope(u('fam-1'), other), false);
  // A role this does not name reaches nobody, rather than everybody.
  assert.strictEqual(msg.clientInScope({ id: 'x', role: 'nonsense' }, CLIENT), false);
});

test('family read the caregiver and office channels, plus a Care Update pushed to them', () => {
  const ok = ['family_portal', 'support', 'admin_direct'];
  for (const ch of ok) {
    const t = thread({ channel: ch, participant_ids: ['fam-1', 'cg-1', 'admin-1'] });
    assert.strictEqual(msg.threadVisibility(u('fam-1'), t, { client: CLIENT }).visible, true, ch);
  }
  // The one clinical channel family reach, and only because a clinician sent it.
  const push = thread({ channel: 'care_update', participant_ids: ['fnp-1', 'fam-1'] });
  assert.strictEqual(msg.threadVisibility(u('fam-1'), push, { client: CLIENT }).visible, true);

  for (const ch of ['clinical_escalation', 'clinical_oversight', 'behavioral_escalation', 'operations', 'direct_care']) {
    const t = thread({ channel: ch, participant_ids: ['fam-1'] });
    assert.strictEqual(msg.threadVisibility(u('fam-1'), t, { client: CLIENT }).visible, false, `family must not read ${ch}`);
  }
});

test('SAFETY: a Care Update is readable by family and NOT repliable — it is an update', () => {
  const push = thread({ channel: 'care_update', participant_ids: ['fnp-1', 'fam-1'] });
  const post = msg.canPostToThread(u('fam-1'), push, { client: CLIENT });
  assert.strictEqual(post.allowed, false);
  assert.strictEqual(post.code, 'CHANNEL_READ_ONLY');
  assert.match(post.reason, /Support/, 'and it says where to reply instead');
  assert.strictEqual(msg.canPostToThread(u('fnp-1'), push, { client: CLIENT }).allowed, true);
});

test('a POA reads what the CLIENT reads; non-POA family do not', () => {
  const clinical = thread({ channel: 'clinical_escalation', participant_ids: ['client-1', 'fnp-1'] });
  assert.strictEqual(msg.threadVisibility(u('fam-1'), clinical, { client: CLIENT, isPoa: true }).visible, true);
  assert.strictEqual(msg.threadVisibility(u('fam-1'), clinical, { client: CLIENT, isPoa: false }).visible, false);
});

test('SAFETY: nobody reads another client\'s thread, whatever their role on their own', () => {
  // THE ROUTES PASS THE THREAD'S CLIENT, not the viewer's. The version of this
  // test that shipped passed `{ client: CLIENT }` — the VIEWER's — so it
  // exercised a comparison production never made, and the leak below sat behind
  // a green assertion. Every case here is called the way `openThread()` and the
  // list route call it: the client that OWNS the thread.
  const other = thread({ client_id: 'client-2', participant_ids: ['client-2', 'admin-1'] });
  for (const id of ['client-1', 'fam-1']) {
    const r = msg.threadVisibility(u(id), other, { client: OTHER_CLIENT });
    assert.strictEqual(r.visible, false, `${id} must not read client-2's thread`);
    assert.strictEqual(r.code, 'THREAD_NOT_YOURS');
  }
});

test('SECURITY REGRESSION (2026-09-13): a client could read and REPLY TO every other client\'s thread', () => {
  // Found in production from a screenshot: two unrelated clients in one Direct
  // thread, each able to post. The guard read `client && thread.client_id !==
  // client.id`, and `client` was the THREAD's client — so it compared a thread
  // to itself, was always false, and never once refused. Every client-reachable
  // channel was open to every client.
  for (const channel of ['direct_care', 'support', 'clinical_escalation', 'admin_direct', 'care_update', 'family_portal']) {
    const theirs = thread({ channel, client_id: 'client-1', participant_ids: ['client-1', 'cg-1'] });
    const intruder = u('client-2');
    const seen = msg.threadVisibility(intruder, theirs, { client: CLIENT });
    assert.strictEqual(seen.visible, false, `client-2 must not READ a ${channel} thread of client-1`);
    const post = msg.canPostToThread(intruder, theirs, { client: CLIENT });
    assert.strictEqual(post.allowed, false, `client-2 must not POST into a ${channel} thread of client-1`);
  }
  // And the client's own thread still works, or the fix is just a new outage.
  const mine = thread({ channel: 'direct_care', client_id: 'client-1', participant_ids: ['client-1', 'cg-1'] });
  assert.strictEqual(msg.threadVisibility(u('client-1'), mine, { client: CLIENT }).visible, true);
});

test('SAFETY: the viewer\'s own client is resolved from the VIEWER, and fails closed', () => {
  // The whole fix rests on this one function, so it is asserted directly rather
  // than only through its callers.
  assert.strictEqual(msg.ownClientId(u('client-1')), 'client-1', 'a client IS their client record');
  assert.strictEqual(msg.ownClientId(u('fam-1')), 'client-1', 'family resolve through familyOfClientId');
  assert.strictEqual(msg.ownClientId(u('admin-1')), null, 'staff have no own-client');
  assert.strictEqual(msg.ownClientId({ role: 'family' }), null, 'an unlinked family member reaches nobody');
  assert.strictEqual(msg.ownClientId(null), null);
  // A family user with no link must be refused, not admitted by a null match.
  const orphan = { id: 'fam-9', role: 'family' };
  const t = thread({ channel: 'support', client_id: 'client-1' });
  assert.strictEqual(msg.threadVisibility(orphan, t, { client: CLIENT }).visible, false);
});

test('a clinician reads threads for a client they are assigned to, and not others', () => {
  const t = thread({ channel: 'clinical_oversight', participant_ids: ['fnp-1', 'cg-1'] });
  assert.strictEqual(msg.threadVisibility(u('fnp-1'), t, { client: CLIENT }).visible, true);
  const notMine = { ...t, client_id: 'client-2', participant_ids: ['fnp-2', 'cg-1'] };
  const r = msg.threadVisibility(u('fnp-1'), notMine, { client: OTHER_CLIENT });
  assert.strictEqual(r.visible, false);
  assert.strictEqual(r.code, 'CLINICAL_NOT_ASSIGNED');
});

test('admin sees everything — the one role for which that is the right answer', () => {
  for (const ch of msg.CHANNEL_IDS) {
    assert.strictEqual(msg.threadVisibility(u('admin-1'), thread({ channel: ch }), { client: CLIENT }).visible, true, ch);
  }
});

test('a closed thread refuses new messages', () => {
  const closed = thread({ channel: 'support', status: 'closed', participant_ids: ['client-1', 'admin-1'] });
  const r = msg.canPostToThread(u('client-1'), closed, { client: CLIENT });
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.code, 'THREAD_CLOSED');
});

// ============================================================================
// 4. POA attribution
// ============================================================================

test('SAFETY: a POA message is displayed as "<POA> as POA for <client>", never as the client', () => {
  const id = msg.senderIdentity(u('fam-1'), { client: CLIENT, isPoa: true });
  assert.strictEqual(id.displayName, 'Ada Vance as POA for Margaret Whitfield (TEST DATA)');
  assert.strictEqual(id.fromRole, 'POA');
  assert.strictEqual(id.actingFor, 'client-1');
  assert.ok(!id.displayName.startsWith('Margaret'), 'the client must never be presented as the author');

  const plain = msg.senderIdentity(u('client-1'), { client: CLIENT, isPoa: false });
  assert.strictEqual(plain.displayName, 'Margaret Whitfield (TEST DATA)');
  assert.strictEqual(plain.actingFor, null);
});

// ============================================================================
// 5. Clinical escalation response status
// ============================================================================

test('the response status is forward-only, and closed is terminal', () => {
  assert.ok(msg.canTransitionResponse('awaiting_response', 'acknowledged'));
  assert.ok(msg.canTransitionResponse('acknowledged', 'responded'));
  assert.ok(!msg.canTransitionResponse('responded', 'acknowledged'), 'never walks backwards');
  assert.ok(!msg.canTransitionResponse('closed', 'responded'));
  assert.strictEqual(msg.responseRefusal('closed', 'responded').code, 'ESCALATION_CLOSED');
  assert.strictEqual(msg.responseRefusal('awaiting_response', 'banana').code, 'UNKNOWN_RESPONSE_STATUS');
  assert.strictEqual(msg.responseRefusal('awaiting_response', 'acknowledged'), null);
});

// ============================================================================
// 6. Message validation and unread
// ============================================================================

test('an empty message is refused and a long one is refused by length, not truncated silently', () => {
  assert.strictEqual(msg.validateMessage({ body: '   ' }).valid, false);
  const long = msg.validateMessage({ body: 'x'.repeat(4001) });
  assert.strictEqual(long.valid, false);
  assert.strictEqual(long.errors[0].code, 'BODY_TOO_LONG');
  assert.match(long.errors[0].message, /4001/, 'it says how long the message actually was');
});

test('unread is derived per user, never a stored counter', () => {
  const rows = [
    { from_user_id: 'admin-1', read_by: [] },
    { from_user_id: 'admin-1', read_by: ['client-1'] },
    { from_user_id: 'client-1', read_by: [] }
  ];
  assert.strictEqual(msg.unreadCount(rows, 'client-1'), 1, 'own messages never count as unread');
  assert.strictEqual(msg.unreadCount(rows, 'admin-1'), 1);
});

// ============================================================================
// 7. Build-enforced invariants
// ============================================================================

const routeSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'messaging.js'), 'utf8');
const repoSrc = fs.readFileSync(path.join(__dirname, '..', 'messagingRepository.js'), 'utf8');
const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const componentSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'components', 'gfc-messaging.js'), 'utf8');

test('SAFETY: visibility is enforced at the QUERY layer, on every thread route', () => {
  // The list and the single read must go through the SAME function. A list
  // built one way and a read gated another is how a thread ends up visible in
  // one place and refused in the other.
  const listIdx = routeSrc.indexOf("router.get('/api/messaging/threads'");
  const list = routeSrc.slice(listIdx, routeSrc.indexOf("router.get('/api/messaging/threads/:id'"));
  assert.ok(/threadVisibility/.test(list), 'the list filters through threadVisibility');

  assert.ok(/const openThread = async/.test(routeSrc), 'single-thread access goes through one helper');
  const opener = routeSrc.slice(routeSrc.indexOf('const openThread = async'), routeSrc.indexOf('const participantsFor'));
  assert.ok(/threadVisibility/.test(opener) && /status: 403/.test(opener),
    'and it answers 403, not an empty list');
  assert.ok(/status: 404/.test(opener), 'a thread that does not exist is 404, which is a different fact');
});

test('SAFETY: every messaging route authenticates and carries a role guard', () => {
  const routes = routeSrc.match(/router\.(get|post|put|delete)\((.|\n)*?\)/g) || [];
  assert.ok(routes.length >= 5, 'the routes exist');
  const decls = routeSrc.match(/router\.(get|post)\('\/api\/messaging[^']*',[^\n]*/g) || [];
  for (const d of decls) {
    assert.ok(d.includes('authenticateToken'), `unauthenticated route: ${d.slice(0, 80)}`);
    assert.ok(/requireMessagingRole|requireAdmin|req\.user\.role/.test(d) || /migrate-interim/.test(d),
      `no role guard: ${d.slice(0, 80)}`);
  }
});

test('the notification carries NO message body — a notification is not a copy of the PHI', () => {
  const notify = routeSrc.slice(routeSrc.indexOf('async function notifyThread'));
  assert.ok(!/message\.body/.test(notify), 'the body must not be emailed out of the app');
  assert.ok(/Open the portal to read it/.test(notify), 'it says a message is waiting instead');
});

test('a behavioral escalation writes to SESSION 6\'s store, in Session 6\'s shape', () => {
  const fn = routeSrc.slice(routeSrc.indexOf('async function raiseBehavioralEscalation'));
  assert.ok(/db\.set\('escalation_events'/.test(fn), 'one escalation store, not a second one');
  assert.ok(/db\.set\('escalation_status_events'/.test(fn), 'and the same append-only trail');
  for (const field of ['concern_type', 'severity', 'notified', 'visibility', 'fallback_to_admin', 'raised_at', 'received_at']) {
    assert.ok(fn.includes(field), `Session 6's shape requires ${field}`);
  }
  assert.ok(/source: 'message'/.test(fn), 'and says which door it came through');
});

test('server.js mounts messaging with exactly one require and one app.use', () => {
  assert.strictEqual((serverSrc.match(/require\('\.\/routes\/messaging'\)/g) || []).length, 1);
  assert.strictEqual((serverSrc.match(/app\.use\(messagingRoutes\(/g) || []).length, 1);
  // Sessions 6 and 7 stay mounted exactly once each.
  assert.strictEqual((serverSrc.match(/app\.use\(caregiverRoutes\(/g) || []).length, 1);
  assert.strictEqual((serverSrc.match(/app\.use\(schedulingRoutes\(/g) || []).length, 1);
});

test('messaging never touches OpenEMR, and never reaches into scheduling', () => {
  assert.ok(!/require\(['"].*openemr/i.test(routeSrc + repoSrc), 'no EMR client');
  assert.ok(!/\bopenemr\s*\.\s*(?!js\b)[a-z]/i.test(routeSrc + repoSrc), 'and no EMR call');
  assert.ok(!/\/api\/scheduling/.test(routeSrc + repoSrc), 'Session 7 owns scheduling');
});

test('the component is mounted in the three portals AND the caregiver app', () => {
  // The brief said not to mount it in the caregiver app because Session 6
  // owned that file during the parallel build. Sessions 6 and 7 have merged,
  // and the owner asked for this session built AND wired, so it is mounted
  // here deliberately — the same call the schedule wiring made.
  const pages = {
    'portal.html': 'gfc-messaging-portal',
    'clinical.html': 'gfc-messaging-clinical',
    'admin-hub.html': 'gfc-messaging-admin',
    'caregiver.html': 'gfc-mount-messaging'
  };
  for (const [page, id] of Object.entries(pages)) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'public', page), 'utf8');
    assert.ok(src.includes('/components/gfc-messaging.js'), `${page} must load the component`);
    assert.ok(/window\.GFCMessaging/.test(src), `${page} must reach the component`);
    assert.ok(/\.mount\(/.test(src), `${page} must mount it`);
    assert.ok(src.includes(id), `${page} must name its mount element (${id})`);
    assert.ok(/\.unmount\(/.test(src), `${page} must unmount on teardown`);
  }
});

test('SAFETY: one element id per page — two mounts over one id is not survivable', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'caregiver.html'), 'utf8');
  assert.strictEqual(src.split('id="gfc-mount-messaging"').length - 1, 1);
  assert.strictEqual((src.match(/lib\.mount\('gfc-mount-messaging'/g) || []).length, 1);
  // Session 7's schedule mount is untouched by this session.
  assert.strictEqual(src.split('id="gfc-mount-schedule"').length - 1, 1);
});

test('the component documents its mount contract and takes the token', () => {
  for (const needle of ['MOUNT CONTRACT', 'authToken', 'scopeClientId', 'GFCMessaging']) {
    assert.ok(componentSrc.includes(needle), `the contract must document: ${needle}`);
  }
  assert.ok(/if \(!options\.authToken\) throw/.test(componentSrc),
    'mounting without a token must fail loudly, not render an empty board that reads as "no messages"');
});

test('the 3.5 interim rows are MIGRATED, and the migration cannot double-run', () => {
  const fn = routeSrc.slice(routeSrc.indexOf('async function migrateInterimMessages'));
  assert.ok(/gfc_messages/.test(fn), 'it reads the interim store');
  assert.ok(/migrated_from/.test(fn), 'and marks each row it carried over');
  assert.ok(/already\.has\(row\.id\)/.test(fn), 'so a second run is a no-op');
  // The interim send is removed in a SEPARATE commit, after this path is
  // proven — so it must still be here in this one.
  assert.ok(/app\.post\('\/api\/gfc\/messages'/.test(serverSrc),
    'the 3.5 send is retired in its own commit, not this one');
});

// ============================================================================
// Build-enforced — the 2026-09-13 owner pass
// ============================================================================

test('BUILD: the routes pass the THREAD\'s client into every visibility call', () => {
  // The leak lived in the gap between what the tests passed and what the routes
  // pass. This pins the routes' side of that contract, so the fix cannot be
  // undone by a future session "simplifying" the argument back.
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'messaging.js'), 'utf8');
  assert.ok(/clientById\(thread\.client_id\)/.test(src), 'openThread resolves the thread\'s own client');
  assert.ok(/clientsById\.get\(t\.client_id\)/.test(src), 'the list resolves each thread\'s own client');
  // …and the repository must therefore NOT trust that argument for the
  // own-client test. If this string comes back, the tautology is back with it.
  const repo = fs.readFileSync(path.join(__dirname, '..', 'messagingRepository.js'), 'utf8');
  assert.ok(!/client && thread\.client_id !== client\.id/.test(repo),
    'the own-client check must never compare a thread to its own client again');
  assert.ok(/ownClientId\(user\)/.test(repo), 'it resolves the viewer\'s own client from the viewer');
});

test('BUILD: a staff member can only message about clients in their scope', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'messaging.js'), 'utf8');
  assert.ok(/CLIENT_NOT_IN_SCOPE/.test(src), 'starting a thread out of scope is refused at creation');
  assert.ok(/\/api\/messaging\/clients/.test(src), 'the picker list exists');
  // The picker and the gate must be the SAME function, or a name can appear in
  // the list and be refused when used.
  const uses = (src.match(/inScope\(req\.user/g) || []).length;
  assert.ok(uses >= 2, `the scope function gates both the list and the write (found ${uses} uses)`);
  assert.ok(/caregiverRepo\.isAssignedToCaregiver/.test(src),
    'caregiver assignment comes from Session 6, not a second copy of the rule');
});

test('BUILD: the admin hub has ONE inbox, with messages inside it', () => {
  const hub = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin-hub.html'), 'utf8');
  const navIds = (hub.match(/\{ id: '(\w+)', label: '[^']*', icon: Icons\.\w+/g) || []).join(' ');
  assert.ok(!/id: 'messages', label: 'Messages'/.test(hub),
    'the separate Messages nav item is gone — it is a tab of the Inbox now');
  assert.ok(/id: 'inbox', label: 'Inbox'/.test(hub), 'the Inbox stays');
  assert.ok(/activeTab === 'messages' && <MessagesPanel/.test(hub), 'Messages renders as an Inbox tab');
  // An old link to `messages` must still land on the messages tab, not fall
  // through to the dashboard.
  assert.ok(/case 'messages': return <InboxPage[^>]*initialTab="messages"/.test(hub),
    'the old route still lands on the messages tab');
});

test('BUILD: the caregiver Feed\'s broadcast half has a screen', () => {
  // It had an API and no UI, so the Feed could only ever read "Nothing new".
  const hub = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin-hub.html'), 'utf8');
  assert.ok(/CaregiverFeedPanel/.test(hub), 'the composer exists');
  assert.ok(/\/api\/caregiver\/broadcasts/.test(hub), 'and posts to the route that feeds it');
  const routes = fs.readFileSync(path.join(__dirname, '..', 'routes', 'caregiver.js'), 'utf8');
  assert.ok(/router\.post\('\/api\/caregiver\/broadcasts', authenticateToken, requireAdmin/.test(routes),
    'and only an admin may post one');
});

test('BUILD: the component asks the server which clients a user may message about', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'components', 'gfc-messaging.js'), 'utf8');
  assert.ok(/\/api\/messaging\/clients/.test(src), 'the picker is server-driven, never a client-side guess');
  assert.ok(/fixedScope/.test(src), 'a host that named a client owns the scope');
  // The client portal is about ONE client and must never offer a way to look
  // at another, so a fixed scope removes the picker entirely.
  assert.ok(/if \(state\.fixedScope \|\| !state\.pickerClients/.test(src),
    'a fixed scope renders no picker at all');
});

// ============================================================================
// The repair script — it cleans up what the leak already wrote
// ============================================================================

test('REPAIR: the script finds exactly the misfiled messages, and nothing else', () => {
  const repair = require('../scripts/repair_cross_client_messages');
  // Bianca's screenshot, as a fixture: Dorothy (client-2) posted into Bianca's
  // (client-1) Direct thread, and the caregiver saw one merged conversation.
  const fixture = {
    users: [
      { id: 'client-1', name: 'Bianca (TEST DATA)', role: 'client' },
      { id: 'client-2', name: 'Dorothy (TEST DATA)', role: 'client' },
      { id: 'fam-1', name: 'Relative (TEST DATA)', role: 'family', familyOfClientId: 'client-1' },
      { id: 'fam-2', name: 'Other relative (TEST DATA)', role: 'family', familyOfClientId: 'client-2' },
      { id: 'fam-9', name: 'Unlinked relative (TEST DATA)', role: 'family' },
      { id: 'cg-1', name: 'Caregiver (TEST DATA)', role: 'vendor' },
      { id: 'admin-1', name: 'GFC Admin', role: 'admin' }
    ],
    threads: [
      { id: 't1', channel: 'direct_care', client_id: 'client-1', created_at: '2026-09-01T00:00:00Z',
        last_message_at: '2026-09-13T11:49:00Z', last_message_preview: 'Test' }
    ],
    messages: [
      { id: 'm1', thread_id: 't1', from_user_id: 'client-1', body: 'Hello', sent_at: '2026-09-13T00:51:00Z' },
      { id: 'm2', thread_id: 't1', from_user_id: 'client-2', body: 'Test',  sent_at: '2026-09-13T11:49:00Z' },
      { id: 'm3', thread_id: 't1', from_user_id: 'cg-1',     body: 'On my way', sent_at: '2026-09-13T09:00:00Z' },
      { id: 'm4', thread_id: 't1', from_user_id: 'admin-1',  body: 'Noted', sent_at: '2026-09-13T10:00:00Z' },
      { id: 'm5', thread_id: 't1', from_user_id: 'fam-1',    body: 'Thank you', sent_at: '2026-09-13T10:30:00Z' },
      { id: 'm6', thread_id: 't1', from_user_id: 'fam-2',    body: 'Wrong thread', sent_at: '2026-09-13T10:45:00Z' },
      { id: 'm7', thread_id: 't1', from_user_id: 'fam-9',    body: 'Unlinked', sent_at: '2026-09-13T10:50:00Z' }
    ]
  };

  const found = repair.findMisfiled(fixture);
  // m2: another CLIENT. m6: another client's FAMILY — the case that proves the
  // family branch is doing work, since without it fam-2 resolves to nobody and
  // is waved through as if they were staff.
  assert.deepStrictEqual(found.map(f => f.message.id).sort(), ['m2', 'm6'],
    'both the other client and the other client\'s family are misfiled');
  const m2 = found.find(f => f.message.id === 'm2');
  assert.strictEqual(m2.senderClientId, 'client-2');
  assert.strictEqual(m2.threadClientId, 'client-1');
  assert.strictEqual(found.find(f => f.message.id === 'm6').senderClientId, 'client-2',
    'a family member is resolved through familyOfClientId, not their own id');
  // Staff post across clients as their job, and the thread's own family member
  // belongs here. Pulling either would be the repair causing its own outage.
  assert.ok(!found.some(f => ['m3', 'm4', 'm5'].includes(f.message.id)),
    'a caregiver, an admin and the thread\'s own family member are never misfiled');
  // An UNLINKED family member is left alone deliberately: they resolve to no
  // client, so there is nothing to say they are in the wrong thread. The fixed
  // visibility rule refuses them at read time; quarantining their words on a
  // guess is not the repair's job.
  assert.ok(!found.some(f => f.message.id === 'm7'), 'an unlinked family member is not guessed at');
});

test('REPAIR: the preview is refreshed, or a quarantined message keeps showing', () => {
  const repair = require('../scripts/repair_cross_client_messages');
  const threads = [{ id: 't1', client_id: 'client-1', created_at: '2026-09-01T00:00:00Z',
    last_message_at: '2026-09-13T11:49:00Z', last_message_preview: 'Test' }];
  const remaining = [{ id: 'm1', thread_id: 't1', body: 'Hello', sent_at: '2026-09-13T00:51:00Z' }];
  const touched = repair.refreshPreviews(threads, remaining);
  assert.strictEqual(touched, 1);
  assert.strictEqual(threads[0].last_message_preview, 'Hello', 'the removed message is gone from the list too');
  assert.strictEqual(threads[0].last_message_at, '2026-09-13T00:51:00Z');
  // A thread emptied entirely falls back to its creation time, not to a
  // timestamp belonging to a message that is no longer there.
  const emptied = [{ id: 't2', client_id: 'c', created_at: '2026-09-01T00:00:00Z', last_message_at: 'x', last_message_preview: 'gone' }];
  repair.refreshPreviews(emptied, []);
  assert.strictEqual(emptied[0].last_message_preview, '');
  assert.strictEqual(emptied[0].last_message_at, '2026-09-01T00:00:00Z');
});

test('REPAIR: the script builds the store the way server.js does', () => {
  // It required `dataStore` and called get/set on it. dataStore exports the
  // FACTORY, not a store, so every call was undefined and the script would have
  // failed on the first line of real work — on the one run that matters, during
  // a PHI incident.
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'repair_cross_client_messages.js'), 'utf8');
  assert.ok(/dataStore\.createStore\(\)/.test(src), 'it builds a store through the factory');
  assert.ok(!/db\.init\(/.test(src), 'there is no init() on the store contract');
  assert.ok(/require\.main === module/.test(src), 'requiring it from a test must not repair anything');
});
