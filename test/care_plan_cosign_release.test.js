// A care plan written by somebody who cannot complete it (a care coordinator,
// an LMSW, or the shared admin account with no NPI) has to reach a licensed
// clinician to sign, and once signed it is released to the patient
// (owner, 2026-11-09).
//
//   * An RN co-signs a CLINICAL patient's plan a coordinator, LMSW or no-NPI
//     admin wrote. A clinical plan an RN wrote still needs a provider or LCSW.
//   * An admin signs a care plan as a provider only with an NPI on file.
//   * The Inbox opens a home care client's plan on its own page (no chart),
//     and My Day lists home care plans too.
//   * The co-sign box sits ABOVE the plan, and the patient is emailed when the
//     plan becomes active.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const roles = require('../clinicalRoles');
const inbox = require('../clinicalInbox');
const { createNotifier } = require('../notifications');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
// Line comments only: a block-comment stripper trips over '/*' inside strings
// in server.js. Every assertion below matches a code shape a comment cannot have.
const stripComments = (src) => src.replace(/^\s*\/\/.*$/gm, '');
const SERVER = stripComments(read('server.js'));
const PAGE = read('public/clinical.html');

const RN = { id: 'u-rn', role: 'user', clinicalRole: 'rn' };
const RN2 = { id: 'u-rn2', role: 'user', clinicalRole: 'rn' };
const PROVIDER = { id: 'u-p', role: 'user', clinicalRole: 'provider' };
const LCSW = { id: 'u-l', role: 'user', clinicalRole: 'lcsw' };
const LMSW = { id: 'u-m', role: 'caseManager', clinicalRole: 'lmsw' };
const COORD = { id: 'u-c', role: 'user', isManager: true, clinicalRole: 'coordinator' };
const ADMIN = { id: 'u-a', role: 'admin' };
const ADMIN_NPI = { id: 'u-b', role: 'admin', npi: '1538078357' };
const plan = (authorClinicalRole, authoredById = 'someone') => ({ version: 1, providerCoSignStatus: 'pending', authorClinicalRole, authoredById });

test('an RN co-signs a clinical plan a coordinator, LMSW or no-NPI admin wrote', () => {
  for (const author of ['coordinator', 'lmsw', 'admin']) {
    assert.strictEqual(roles.canCompleteCarePlan(RN, 'IHPC', plan(author)), true, author);
    assert.strictEqual(roles.canCompleteCarePlan(RN, 'BOTH', plan(author)), true, author);
  }
});

test('a clinical plan an RN wrote still needs a provider or an LCSW', () => {
  assert.strictEqual(roles.canCompleteCarePlan(RN2, 'IHPC', plan('rn')), false);
  assert.strictEqual(roles.canCompleteCarePlan(PROVIDER, 'IHPC', plan('rn')), true);
  assert.strictEqual(roles.canCompleteCarePlan(LCSW, 'IHPC', plan('rn')), true);
  // Without the plan, the rule is the author-blind one: an RN completes no clinical plan.
  assert.strictEqual(roles.canCompleteCarePlan(RN, 'IHPC'), false);
});

test('an RN completes any home care plan; unlicensed roles complete none', () => {
  assert.strictEqual(roles.canCompleteCarePlan(RN, 'PHC', plan('coordinator')), true);
  for (const u of [LMSW, COORD]) {
    for (const line of ['PHC', 'IHPC']) assert.strictEqual(roles.canCompleteCarePlan(u, line, plan('coordinator')), false, `${u.clinicalRole} ${line}`);
  }
});

test('an admin signs a care plan as a provider only with an NPI', () => {
  const noNpi = roles.evaluateCarePlanSignature(ADMIN, 'IHPC');
  assert.strictEqual(noNpi.outcome, roles.CARE_PLAN_OUTCOME.PENDING_PROVIDER);
  assert.strictEqual(noNpi.signatureRole, 'authoring');
  assert.strictEqual(noNpi.clinicalRole, 'admin');
  assert.strictEqual(roles.evaluateCarePlanSignature(ADMIN, 'PHC').outcome, roles.CARE_PLAN_OUTCOME.PENDING_PROVIDER);
  assert.strictEqual(roles.evaluateCarePlanSignature(ADMIN_NPI, 'IHPC').outcome, roles.CARE_PLAN_OUTCOME.COMPLETE);
  assert.strictEqual(roles.canCompleteCarePlan(ADMIN, 'IHPC', plan('coordinator')), false, 'a no-NPI admin cannot co-sign either');
  assert.strictEqual(roles.canCompleteCarePlan(ADMIN_NPI, 'IHPC', plan('coordinator')), true);
  // Everywhere else an admin still resolves to provider: the owner keeps her chart.
  assert.strictEqual(roles.resolveClinicalRole(ADMIN), 'provider');
});

test('the inbox lets an RN act on a coordinator’s clinical plan, and says when there is no chart', () => {
  const build = (viewer) => inbox.buildInbox({
    viewer, encounterRecords: [], attestations: [], orders: [], visitLogs: [], now: '2026-11-09T12:00:00Z',
    carePlanClients: [
      { id: 'c-ihpc', name: 'Cleo', serviceLine: 'IHPC', carePlan: plan('coordinator') },
      { id: 'c-rn', name: 'Rae', serviceLine: 'IHPC', carePlan: plan('rn', 'u-rn') },
      { id: 'c-phc', name: 'Hal', serviceLine: 'PHC', carePlan: plan('coordinator') }
    ]
  });
  const items = (build(RN2).items || []).filter(i => i.kind === 'care_plan_co_sign');
  const by = Object.fromEntries(items.map(i => [i.clientId, i]));
  assert.strictEqual(by['c-ihpc'].actionable, true);
  assert.strictEqual(by['c-ihpc'].noChart, false);
  assert.strictEqual(by['c-rn'].actionable, false, 'another RN cannot clear an RN-authored clinical plan');
  assert.strictEqual(by['c-phc'].actionable, true);
  assert.strictEqual(by['c-phc'].noChart, true, 'a home care client has no chart');
  const author = (build(RN).items || []).find(i => i.clientId === 'c-rn');
  assert.strictEqual(author.actionable, false, 'nobody co-signs their own plan');
});

test('the server asks one question for who may co-sign, and passes the plan', () => {
  assert.match(SERVER, /canCoSign: [\s\S]{0,200}clinicalRoles\.canCompleteCarePlan\(req\.user, client\.serviceLine, client\.carePlan\)/);
  const i = SERVER.indexOf("app.post('/api/clinical/patients/:clientId/care-plan/provider-cosign'");
  const route = SERVER.slice(i, SERVER.indexOf('app.post(', i + 10));
  assert.match(route, /if \(!clinicalRoles\.canCompleteCarePlan\(req\.user, client\.serviceLine, plan\)\)/);
  assert.match(read('clinicalInbox.js'), /canCompleteCarePlan\(viewer, c\.serviceLine, plan\)/);
});

test('My Day lists home care plans waiting on a co-signature, not only clinical ones', () => {
  const i = SERVER.indexOf("app.get('/api/clinical/digest'");
  const route = SERVER.slice(i, SERVER.indexOf('app.', i + 10));
  assert.match(route, /carePlanClients: clients,/);
  assert.doesNotMatch(route, /carePlanClients: clients\.filter/);
});

test('the patient is told when the plan becomes active, at both moments', () => {
  const save = SERVER.slice(SERVER.indexOf("app.post('/api/clinical/patients/:clientId/care-plan',"));
  const saveRoute = save.slice(0, save.indexOf('app.post(', 10));
  assert.match(saveRoute, /if \(!pendingProviderCoSign\) \{\s*await notify\.carePlanReady\(/);
  const i = SERVER.indexOf("app.post('/api/clinical/patients/:clientId/care-plan/provider-cosign'");
  const co = SERVER.slice(i, SERVER.indexOf('app.post(', i + 10));
  assert.match(co, /if \(!\(client\.carePlanCoSign \|\| \{\}\)\[`v\$\{plan\.version\}`\]\) \{\s*await notify\.carePlanReady\(/);
});

test('the ready notice reaches the client and a POA by name, and carries no plan content', async () => {
  const CLIENT = { id: 'c1', role: 'client', name: 'Ada Bell', email: 'ada@example.com', slug: 'ada' };
  const POA = { id: 'f1', role: 'family', name: 'Joe Bell', email: 'joe@example.com', familyOfClientId: 'c1', familyIsPoa: true };
  const FAMILY = { id: 'f2', role: 'family', name: 'Kim Bell', email: 'kim@example.com', familyOfClientId: 'c1' };
  const queued = [];
  const notifier = createNotifier({
    getUsers: async () => [CLIENT, POA, FAMILY],
    queueNotification: async (type, userId, email, name, content, opts) => { queued.push({ type, email, ...content, ...opts }); return { id: 'n' }; },
    getAppBaseUrl: async () => 'https://app.godwinsfamilycarellc.com',
    emailTransport: { transportStatus: () => ({ baaCovered: true }) },
    staffRoles: ['admin'], clientRole: 'client', familyRole: 'family'
  });
  const r = await notifier.carePlanReady({ clientId: 'c1', version: 2, actorId: 'u-rn' });
  assert.strictEqual(r.notified, 2);
  assert.deepStrictEqual(queued.map(q => q.email).sort(), ['ada@example.com', 'joe@example.com']);
  const poa = queued.find(q => q.email === 'joe@example.com');
  assert.match(poa.htmlBody, /Ada Bell(&#39;|&#x27;|')s care plan is ready/, 'a POA is told whose plan it is');
  const own = queued.find(q => q.email === 'ada@example.com');
  assert.match(own.htmlBody, /Your care plan is ready/);
  assert.strictEqual(own.relatedEntityId, 'c1:careplan:v2:ready');
});

test('the co-sign box sits above the plan, and a home care plan opens on its own page', () => {
  const i = PAGE.indexOf('const CarePlanTab = ');
  const tab = PAGE.slice(i, PAGE.indexOf('const StandaloneCarePlan', i));
  const sign = tab.indexOf("'Co-Sign Plan'");
  const view = tab.indexOf('<CarePlanView ');
  assert.ok(sign > 0 && view > 0 && sign < view, 'the signature comes before the plan, not below the fold');
  assert.match(PAGE, /i\.kind === 'care_plan_co_sign' && i\.noChart\) \{ window\.location\.href = `\/clinical\?carePlan=\$\{encodeURIComponent\(i\.clientId\)\}`/);
});
