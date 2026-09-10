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
  // The brief lists eleven FROM→TO rows; the module stores nine channels,
  // because several rows are one conversation read from either end. This is
  // the test that makes that collapse safe: lose a row and it fails.
  assert.strictEqual(msg.MATRIX_ROWS.length, 11, 'the brief has eleven rows');
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
  assert.deepStrictEqual(ids(u('client-1')), ['clinical_escalation', 'direct_care', 'support']);
  assert.deepStrictEqual(ids(u('cg-1')), ['behavioral_escalation', 'direct_care', 'family_portal', 'operations']);
  assert.deepStrictEqual(ids(u('fam-1')), ['family_portal', 'support']);
  assert.deepStrictEqual(ids(u('fnp-1')), ['care_update', 'clinical_oversight']);
  // Admin opens Operations too — the matrix's "Admin | Anyone" row reaches a
  // caregiver, and Operations is the caregiver↔office channel.
  assert.deepStrictEqual(ids(u('admin-1')), ['admin_direct', 'operations', 'support']);
  assert.deepStrictEqual(ids(u('cm-1')), [], 'a case manager receives behavioral escalations; they do not open channels');
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

test('SAFETY: a case manager sees behavioral escalations and 403s on clinical notes', () => {
  const behavioral = thread({ id: 't-b', channel: 'behavioral_escalation', participant_ids: ['cg-1'] });
  const seen = msg.threadVisibility(u('cm-1'), behavioral, { client: CLIENT });
  assert.strictEqual(seen.visible, true, 'theirs by role, even without being named on the row');

  for (const ch of ['clinical_oversight', 'clinical_escalation', 'care_update', 'family_portal']) {
    const t = thread({ id: `t-${ch}`, channel: ch, participant_ids: ['fnp-1', 'cg-1'] });
    const r = msg.threadVisibility(u('cm-1'), t, { client: CLIENT });
    assert.strictEqual(r.visible, false, `a case manager must not read ${ch}`);
    assert.strictEqual(r.code, 'CASE_MANAGER_SCOPE');
  }
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
  const other = thread({ client_id: 'client-2', participant_ids: ['client-2', 'admin-1'] });
  for (const id of ['client-1', 'fam-1']) {
    assert.strictEqual(msg.threadVisibility(u(id), other, { client: CLIENT }).visible, false, id);
  }
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
