// One family login for several patients, POA per patient, and moving a
// patient's login to their POA (owner, 2026-10-20). familyLinks.js is pure, so
// most of this runs it directly; the rest guards the readers that must ask it.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const fl = require('../familyLinks');
const quoSms = require('../quoSms');
const notifications = require('../notifications');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');

const MOM = { id: 'mom', role: 'client', name: 'Mae Mom', email: 'mom@x.test' };
const DAD = { id: 'dad', role: 'client', name: 'Dee Dad', email: 'dad@x.test' };
const daughter = () => ({ id: 'd', role: 'family', name: 'Dot', email: 'dot@x.test', phone: '404-555-0101',
  familyLinks: [{ clientId: 'mom', isPoa: true }, { clientId: 'dad', isPoa: false }] });

test('linksOf reads the old single-field shape, so nothing depends on the migration having run', () => {
  const old = { role: 'family', familyOfClientId: 'mom', familyIsPoa: true, familyRelationship: 'Son' };
  assert.deepStrictEqual(fl.linksOf(old).map(l => [l.clientId, l.isPoa, l.relationship]), [['mom', true, 'Son']]);
  assert.deepStrictEqual(fl.linksOf({ role: 'family' }), []);
  assert.deepStrictEqual(fl.linksOf({ role: 'client', familyOfClientId: 'mom' }), [], 'only a family account has links');
  // A POA tick must be literally true; "yes" is not a POA.
  assert.strictEqual(fl.linksOf({ role: 'family', familyLinks: [{ clientId: 'mom', isPoa: 'yes' }] })[0].isPoa, false);
});

test('POA is per patient: POA for Mom does not make anyone POA for Dad', () => {
  const d = daughter();
  assert.strictEqual(fl.isPoaFor(d, 'mom'), true);
  assert.strictEqual(fl.isPoaFor(d, 'dad'), false);
  assert.strictEqual(fl.isFamilyOf(d, 'dad'), true);
  assert.strictEqual(fl.isFamilyOf(d, 'stranger'), false);
});

test('applyLinks is the only writer: it dedupes and keeps the old fields mirroring the first link', () => {
  const u = fl.applyLinks({ role: 'family' }, [{ clientId: 'dad', isPoa: false }, { clientId: 'mom', isPoa: true }, { clientId: 'dad', isPoa: true }, { clientId: '' }]);
  assert.deepStrictEqual(u.familyLinks.map(l => [l.clientId, l.isPoa]), [['dad', false], ['mom', true]]);
  assert.strictEqual(u.familyOfClientId, 'dad');
  assert.strictEqual(u.familyIsPoa, false);
  fl.applyLinks(u, []);
  assert.strictEqual(u.familyOfClientId, null);
  assert.strictEqual(u.familyIsPoa, false);
});

test('familyFor finds the family side of ONE patient, POA filter and inactive accounts included', () => {
  const d = daughter();
  const gone = { ...daughter(), id: 'gone', accountStatus: 'inactive' };
  const users = [MOM, DAD, d, gone];
  assert.deepStrictEqual(fl.familyFor(users, 'mom', { poaOnly: true }).map(f => f.user.id), ['d']);
  assert.deepStrictEqual(fl.familyFor(users, 'dad', { poaOnly: true }), [], 'plain family is not a POA');
  assert.deepStrictEqual(fl.familyFor(users, 'dad').map(f => f.user.id), ['d']);
  assert.deepStrictEqual(fl.familyFor(users, 'mom', { activeOnly: false }).map(f => f.user.id), ['d', 'gone']);
});

test('normalizeLinksInput refuses a non-patient, a duplicate, and keeps who added an existing link', () => {
  const users = [MOM, DAD, { id: 'staff', role: 'admin' }];
  assert.strictEqual(fl.normalizeLinksInput([{ clientId: 'staff' }], { users }).code, 'FAMILY_LINK_NOT_A_CLIENT');
  assert.strictEqual(fl.normalizeLinksInput([{ clientId: 'mom' }, { clientId: 'mom' }], { users }).code, 'FAMILY_LINK_DUPLICATE');
  assert.strictEqual(fl.normalizeLinksInput('mom', { users }).code, 'FAMILY_LINKS_INVALID');
  assert.strictEqual(fl.normalizeLinksInput([{ clientId: 'mom', isPoa: 'yes' }], { users }).links[0].isPoa, false, 'a POA tick must be literally true');
  const prev = [{ clientId: 'mom', isPoa: false, addedAt: '2026-01-01', addedBy: 'a1', via: 'invite' }];
  const r = fl.normalizeLinksInput([{ clientId: 'mom', isPoa: true }, { clientId: 'dad' }, { clientId: '' }], { users, actorId: 'a2', previous: prev, now: () => 'NOW' });
  assert.deepStrictEqual(r.links.map(l => [l.clientId, l.isPoa, l.addedBy, l.via]), [['mom', true, 'a1', 'invite'], ['dad', false, 'a2', 'admin']]);
});

test('resolveActive: one link is active, several need a choice, a stale pick is ignored, a stale tab is caught', () => {
  const one = { role: 'family', familyLinks: [{ clientId: 'mom', isPoa: true }] };
  assert.strictEqual(fl.resolveActive({ user: one }).link.clientId, 'mom');
  const d = daughter();
  const none = fl.resolveActive({ user: d });
  assert.strictEqual(none.link, null);
  assert.strictEqual(none.needsChoice, true);
  assert.strictEqual(fl.resolveActive({ user: d, sessionActiveId: 'dad' }).link.clientId, 'dad');
  const stale = fl.resolveActive({ user: d, sessionActiveId: 'removed' });
  assert.strictEqual(stale.link, null, 'a patient no longer linked is never honoured');
  assert.strictEqual(stale.needsChoice, true);
  assert.strictEqual(fl.resolveActive({ user: d, sessionActiveId: 'dad', headerId: 'mom' }).mismatch, true);
  assert.strictEqual(fl.resolveActive({ user: d, sessionActiveId: 'dad', headerId: 'dad' }).mismatch, false);
  assert.strictEqual(fl.resolveActive({ user: d, sessionActiveId: 'dad' }).mismatch, false, 'no header is not a mismatch');
});

test('cutover, move: the POA gets the email, the password hash and MFA; the patient gets a placeholder', () => {
  const client = { id: 'gran', role: 'client', name: 'Gail', email: 'hal@x.test', password: 'HASH', mfa: { secret: 's' }, requirePasswordChange: false };
  const p = fl.planPoaCutover({ client, newFamily: { id: 'hal', name: 'Hal' }, clientPlaceholderEmail: 'client+gran@placeholder.local', clientPasswordHash: 'NEW', actorId: 'admin' });
  assert.ok(!p.error, p.error);
  assert.strictEqual(p.familyIsNew, true);
  assert.strictEqual(p.familyPatch.email, 'hal@x.test');
  assert.strictEqual(p.familyPatch.password, 'HASH');
  assert.deepStrictEqual(p.familyPatch.mfa, { secret: 's' });
  assert.deepStrictEqual(p.familyPatch.familyLinks.map(l => [l.clientId, l.isPoa, l.via]), [['gran', true, 'poa_cutover']]);
  assert.strictEqual(p.clientPatch.email, 'client+gran@placeholder.local');
  assert.strictEqual(p.clientPatch.password, 'NEW');
  assert.strictEqual(p.clientPatch.mfa, null);
});

test('cutover never merges two passwords, and refuses what it cannot do', () => {
  const client = { id: 'gran', role: 'client', name: 'Gail', email: 'hal@x.test', password: 'HASH' };
  const base = { client, clientPlaceholderEmail: 'client+gran@placeholder.local', clientPasswordHash: 'NEW' };
  const withLogin = { id: 'f', role: 'family', email: 'f@x.test', password: 'THEIRS' };
  assert.strictEqual(fl.planPoaCutover({ ...base, target: withLogin }).code, 'POA_CUTOVER_TARGET_HAS_LOGIN');
  assert.strictEqual(fl.planPoaCutover({ ...base, target: { id: 's', role: 'admin', email: 'family+x@placeholder.local' } }).code, 'POA_CUTOVER_TARGET_NOT_FAMILY');
  assert.strictEqual(fl.planPoaCutover({ ...base }).code, 'POA_CUTOVER_NAME_REQUIRED');
  assert.strictEqual(fl.planPoaCutover({ ...base, client: { ...client, email: 'client+gran@placeholder.local' }, newFamily: { name: 'Hal' } }).code, 'POA_CUTOVER_NOTHING_TO_MOVE');
  // A placeholder family account (no login of its own) may take it.
  const empty = { id: 'e', role: 'family', email: 'family+e@placeholder.local', familyLinks: [{ clientId: 'mom', isPoa: false }] };
  const ok = fl.planPoaCutover({ ...base, target: empty });
  assert.strictEqual(ok.familyIsNew, false);
  assert.strictEqual(ok.familyPatch.email, 'hal@x.test');
  assert.deepStrictEqual(ok.familyPatch.familyLinks.map(l => l.clientId).sort(), ['gran', 'mom'], 'existing links are kept');
});

test('cutover, link_existing: the POA keeps their own login and gains the patient; the patient login retires', () => {
  const client = { id: 'aunt', role: 'client', name: 'Ada', email: 'old@x.test', password: 'HASH' };
  const target = { id: 'f', role: 'family', email: 'f@x.test', password: 'THEIRS', familyLinks: [{ clientId: 'mom', isPoa: true }] };
  const p = fl.planPoaCutover({ client, target, mode: 'link_existing', clientPlaceholderEmail: 'client+aunt@placeholder.local', clientPasswordHash: 'NEW' });
  assert.ok(!p.error, p.error);
  assert.ok(!('email' in p.familyPatch) && !('password' in p.familyPatch), 'their own login is never touched');
  assert.strictEqual(p.familyPatch.familyLinks.find(l => l.clientId === 'aunt').isPoa, true);
  assert.strictEqual(p.clientPatch.email, 'client+aunt@placeholder.local');
  assert.strictEqual(fl.planPoaCutover({ client, target: { ...target, email: 'family+f@placeholder.local' }, mode: 'link_existing', clientPlaceholderEmail: 'p', clientPasswordHash: 'h' }).code, 'POA_CUTOVER_TARGET_HAS_NO_LOGIN');
});

test('the possible-POA list only suggests, and says why', () => {
  assert.deepStrictEqual(fl.possiblePoaLoginReasons(MOM), []);
  assert.strictEqual(fl.possiblePoaLoginReasons({ ...MOM, intake: { legalDocs: ['Healthcare POA activated'] } }).length, 1);
  assert.strictEqual(fl.possiblePoaLoginReasons({ ...MOM, intake: { legalDocs: ['Financial POA activated'] } }).length, 0, 'a financial POA does not handle health care');
  assert.strictEqual(fl.possiblePoaLoginReasons({ ...MOM, consentMeta: { npp: { typedName: 'Hal Husband' } } }).length, 1);
  assert.strictEqual(fl.possiblePoaLoginReasons({ ...MOM, consentMeta: { npp: { typedName: 'mae  MOM' } } }).length, 0, 'the patient’s own name, written differently, is not a sign');
  assert.strictEqual(fl.possiblePoaLoginReasons({ ...MOM, intake: { primaryContact: { email: 'MOM@x.test' } } }).length, 1);
  assert.deepStrictEqual(fl.possiblePoaLoginReasons({ ...MOM, email: 'client+m@placeholder.local', intake: { decisionMaker: { name: 'X' } } }), [], 'a placeholder has no login to move');
});

test('texts: a POA for two patients matches each, and a number is never matched for plain family', () => {
  const d = daughter();
  const hits = quoSms.matchPhone('+14045550101', [MOM, DAD, d]);
  assert.deepStrictEqual(hits.map(h => [h.user.id, h.client.id, h.isPoa]), [['d', 'mom', true]], 'POA for Mom only; plain family for Dad');
  d.familyLinks[1].isPoa = true;
  assert.deepStrictEqual(quoSms.matchPhone('+14045550101', [MOM, DAD, d]).map(h => h.client.id).sort(), ['dad', 'mom']);
});

test('emails: the POA of THAT patient hears about it, and their button names the patient', async () => {
  const d = daughter();
  const sent = [];
  const n = notifications.createNotifier({
    getUsers: async () => [{ ...MOM, slug: 'mae' }, { ...DAD, slug: 'dee' }, d],
    getAppBaseUrl: async () => 'https://app.test',
    emailTransport: { transportStatus: () => ({ baaCovered: true }) },
    queueNotification: async (type, userId, email, name, tpl) => { sent.push({ userId, cta: tpl.ctaUrl, body: tpl.body }); return { id: 'q' }; },
    staffRoles: ['admin'], clientRole: 'client', familyRole: 'family'
  });
  await n.documentReviewed({ clientId: 'mom', decision: 'accepted', label: 'ID', uploadId: 'u', actorId: 'a' });
  assert.deepStrictEqual(sent.map(s => s.userId).sort(), ['d', 'mom']);
  assert.strictEqual(sent.find(s => s.userId === 'd').cta, 'https://app.test/portal?for=mom');
  assert.strictEqual(sent.find(s => s.userId === 'mom').cta, 'https://app.test/portal/mae');
  sent.length = 0;
  await n.documentReviewed({ clientId: 'dad', decision: 'accepted', label: 'ID', uploadId: 'u', actorId: 'a' });
  assert.deepStrictEqual(sent.map(s => s.userId), ['dad'], 'plain family for Dad is not emailed');
});

test('build guard: no background reader decides family access from the stored mirror fields', () => {
  // The mirror fields describe the FIRST link only. A reader that scans users
  // with them misses every other patient. Request-scoped reads of req.user
  // (where authenticateToken set the active patient) are fine.
  const files = ['notifications.js', 'quoSms.js', 'messagingRepository.js', 'routes/messaging.js', 'chartCommunications.js', 'familyInvites.js'];
  for (const f of files) {
    const src = strip(read(f));
    assert.doesNotMatch(src, /u\.familyOfClientId\s*===|\.familyOfClientId\s*===\s*client|fresh\.familyIsPoa|u\.familyIsPoa\s*&&/, `${f} reads the mirror fields for access`);
  }
  const server = strip(read('server.js'));
  assert.doesNotMatch(server, /users\.filter\([^)]*familyOfClientId/, 'server.js scans users by the single linked-client field');
  assert.match(read('routes/messaging.js'), /familyLinks\.isPoaFor\(fresh, client\.id\)/, 'messaging asks POA of THIS client');
});

test('build guard: the active patient comes from the session row and a stale tab answers 409', () => {
  const server = read('server.js');
  assert.match(server, /familyLinks\.resolveActive\(\{ user: freshUser, sessionActiveId: sess\.row\.activeClientId, headerId: req\.headers\['x-gfc-client'\] \}\)/);
  assert.match(server, /code: 'ACTIVE_CLIENT_CHANGED'/);
  assert.match(server, /code: 'CLIENT_CHOICE_REQUIRED'/);
  // Neither is an AUTH_ code: nobody is signed out for choosing or switching.
  assert.doesNotMatch(server, /AUTH_[A-Z_]*CLIENT/);
  const portal = read('public/portal.html');
  assert.match(portal, /headers\.set\('X-GFC-Client', window\.GFC_ACTIVE_CLIENT\)/);
  assert.match(portal, /body\.code === 'ACTIVE_CLIENT_CHANGED'/);
});

test('build guard: every patient-side notice gives a family member a link to the right patient', () => {
  const notif = read('notifications.js');
  assert.doesNotMatch(notif, /ctaUrl: url, ctaLabel: 'Open your portal'/, 'a client-side notice still sends the bare portal link to a POA');
  assert.match(notif, /\|\| ctaForRecipient\(url, client, actingFor\)/);
  const msgRoutes = read('routes/messaging.js');
  assert.ok((msgRoutes.match(/\?for=\$\{encodeURIComponent\(thread\.client_id\)\}#messages/g) || []).length >= 2, 'message email and text both name the patient');
  assert.match(read('server.js'), /portal\?for=\$\{encodeURIComponent\(clientId\)\}/, 'the statement email names the patient');
});

test('build guard: email stays unique, case-blind, on create AND edit', () => {
  const server = read('server.js');
  const create = server.slice(server.indexOf("app.post('/api/users',"), server.indexOf("app.get('/api/client-portals'"));
  assert.match(create, /u\.email\.toLowerCase\(\) === email\.toLowerCase\(\)/);
  const edit = server.slice(server.indexOf("app.put('/api/users/:userId'"), server.indexOf("app.put('/api/users/:userId'") + 12000);
  assert.match(edit, /code: 'EMAIL_IN_USE'/);
  // The check runs before the first write to the record.
  const firstWrite = edit.search(/users\[idx\]\.\w+ = /);
  assert.ok(firstWrite > 0 && edit.indexOf("code: 'EMAIL_IN_USE'") < firstWrite, 'the uniqueness check must come before anything is written');
});

test('build guard: a patient\u2019s account type cannot be changed, and a clashing email says whose it is', () => {
  const server = read('server.js');
  const edit = server.slice(server.indexOf("app.put('/api/users/:userId'"), server.indexOf("app.put('/api/users/:userId'") + 12000);
  const firstWrite = edit.search(/users\[idx\]\.\w+ = /);
  const lock = edit.indexOf("code: 'PATIENT_TYPE_LOCKED'");
  assert.ok(lock > 0 && lock < firstWrite, 'the patient lock must refuse before anything is written');
  assert.match(edit, /users\[idx\]\.role === config\.ROLES\.CLIENT && wantedRole && wantedRole !== config\.ROLES\.CLIENT/);
  const create = server.slice(server.indexOf("app.post('/api/users',"), server.indexOf("app.get('/api/client-portals'"));
  assert.match(create, /existingUser: \{ id: holder\.id, name: holder\.name \|\| null, kind \}/);
  const hub = read('public/admin-hub.html');
  assert.match(hub, /disabled=\{!!\(editingUser && editingUser\.role === 'client'\)\}/, 'the form locks a patient\u2019s account type too');
  assert.match(hub, /api\.createUserDetailed\(token, formData\)/, 'the create keeps the server\u2019s details so the form can offer the next step');
});

test('build guard: an Admin Hub page error shows a message, never a blank screen', () => {
  const hub = read('public/admin-hub.html');
  assert.match(hub, /class PageErrorBoundary extends React\.Component/);
  assert.match(hub, /<PageErrorBoundary resetKey=\{activePage\}>\{renderPage\(\)\}<\/PageErrorBoundary>/, 'every page is wrapped');
  assert.match(hub, /<PageErrorBoundary quiet>\s*<PossiblePoaLogins/, 'the suggestion panel cannot take User Management down');
});

test('a POA signs in their own name: "<POA> as POA for <patient>"', () => {
  const reg = require('../consentRegistry');
  const req = { headers: { 'x-forwarded-for': '203.0.113.9' }, socket: { remoteAddress: '10.0.0.1' }, ip: '203.0.113.9' };
  const hashIp = (x) => x ? 'h:' + x : null;
  const poa = reg.buildConsentSignature({ type: 'npp', typedName: 'Stephanie Hendricks', req, hashIp,
    signer: { role: 'poa', userId: 'steph', name: 'Stephanie Hendricks', actingFor: 'joe', actingForName: 'Joseph Hendricks' } });
  assert.strictEqual(poa.signedAs, 'Stephanie Hendricks as POA for Joseph Hendricks');
  assert.strictEqual(poa.signerRole, 'poa');
  assert.strictEqual(poa.signedById, 'steph');
  assert.strictEqual(poa.actingFor, 'joe');
  const self = reg.buildConsentSignature({ type: 'npp', typedName: 'Joseph Hendricks', req, hashIp });
  assert.ok(!('signedAs' in self) && !('signerRole' in self), 'the patient signing for themselves carries no POA stamp');
  const pdf = read('pdf-generator.js');
  assert.match(pdf, /sigRow\('Electronically signed by', meta\.signedAs \|\| meta\.typedName/, 'the signed consent PDF names the POA');
  assert.match(pdf, /Signed by \$\{m\.signedAs \|\| m\.typedName/, 'the enrollment packet names the POA');
});

test('build guard: a POA can do the patient’s own tasks, and the routes work on the patient', () => {
  const server = read('server.js');
  const gate = server.slice(server.indexOf('const requireClientForIntake'), server.indexOf('const signerFor'));
  assert.match(gate, /req\.user\.familyIsPoa && req\.user\.familyOfClientId/);
  assert.match(gate, /req\.intakeClientId = req\.user\.familyOfClientId/);
  assert.doesNotMatch(server, /loadClientForMutation\(req\.user\.id\)/, 'an intake route still looks the patient up by the signed-in user');
  assert.match(server, /signer: signerFor\(req, client\)/, 'consents carry the POA');
  // A POA is gated on intake like the patient, never on the family release.
  const enrolled = server.slice(server.indexOf('const requireEnrolledClient'), server.indexOf('const requireEnrolledClient') + 4000);
  assert.ok(enrolled.indexOf('if (req.user.familyIsPoa)') > 0 && enrolled.indexOf('if (req.user.familyIsPoa)') < enrolled.indexOf('ROI_FAMILY_REQUIRED'));
  // No notice goes to a placeholder login.
  assert.match(server, /if \(familyLinks\.isPlaceholderEmail\(recipientEmail\)\) return \{ ok: false/);
  const portal = read('public/portal.html');
  assert.match(portal, /showIntake && \(!isFamily \|\| isPoa\)/);
  assert.match(portal, /\(isFamily && !isPoa\) \? !me\.roiFamilySigned/);
});

test('the record-release receipt: the POA is greeted by their own name and the patient is not told about "your records" by someone else', () => {
  const legacy = require('../legacySync');
  const toPoa = legacy.buildPatientEmailHtml('Stephanie Hendricks', { forSomeoneElse: true });
  assert.match(toPoa, /Stephanie/);
  assert.doesNotMatch(toPoa, /your records/i);
  assert.match(toPoa, /The signed Authorization to Obtain Medical Records was received/);
  const toPatient = legacy.buildPatientEmailHtml('Patrick Bell');
  assert.match(toPatient, /Patrick/);
  assert.match(toPatient, /your records/);
  assert.match(legacy.patientReceiptText('Stephanie Hendricks', { forSomeoneElse: true }), /^Hi Stephanie,/);
});

test('no email is ever sent to a placeholder login', async () => {
  const email = require('../email');
  const r = await email.sendEmail('client+abc@placeholder.local', 'S', 'B');
  assert.strictEqual(r.skipped, true);
  assert.strictEqual(r.reason, 'placeholder address');
  const server = read('server.js');
  const roi = server.slice(server.indexOf('async function dispatchRoiNotifications'), server.indexOf('const roiPatientIdentity'));
  assert.match(roi, /familyLinks\.isPlaceholderEmail\(e\)/, 'the release receipt skips placeholder logins');
  assert.match(roi, /if \(signer && signer\.role === config\.ROLES\.FAMILY\) add\(signer\.email, signer\.name, true\)/, 'the POA who signed hears about it');
  assert.ok((server.match(/signer: req\.user \}\)/g) || []).length >= 2, 'both release routes pass who signed');
});
