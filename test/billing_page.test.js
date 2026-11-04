'use strict';
// The billing page as billing's own place (owner, 2026-11-04):
//   1. billingConnection.js judges each link from a signed note to OpenEMR's
//      Billing Manager, and a link it could not read is never a pass.
//   2. OpenEMR's sign-in can return to the billing page, from an allow-list.
//   3. The claim is worked on /billing, and the encounter keeps ONE coding
//      area (the clinician's) and ONE sign card.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { buildBillingConnection, STATES } = require('../billingConnection');
const dataStore = require('../dataStore');
const { createEmrAuth } = require('../emrAuth');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const server = read('server.js');
const billing = read('public/billing.html');
const clinical = read('public/clinical.html');
const shared = read('public/components/claim-shared.jsx');

// ---- 1. the connection check ------------------------------------------------
const GOOD = {
  emr: { configured: true, reachable: true, connected: true, emrUser: { username: 'mgr' }, billingRouteScopes: true },
  payer: { billing_npi_used: '1538078357', billing_provider_name: 'GFC' },
  facilityInfo: { facilityListKnown: true, billingFacility: { id: '3', name: 'Vinings', fieldsRead: true, npi: '1538078357', ein: '12-3456789', taxonomy: '207Q00000X' } },
  catalog: { loaded: true, stale: false, fetchedAt: '2026-11-04T10:00:00Z' },
  ncci: { ncciSourceVersion: { ptp: { quarter: '2026Q4' }, mue: { quarter: '2026Q4' } } }
};
const stateOf = (r, key) => (r.checks.find(c => c.key === key) || {}).state;

test('everything read and right is ready; the clearinghouse is stated, never claimed', () => {
  const r = buildBillingConnection(GOOD);
  assert.equal(r.ready, true);
  for (const k of ['emr_signin', 'emr_scopes', 'billing_npi', 'billing_facility', 'code_catalog', 'ncci']) assert.equal(stateOf(r, k), STATES.OK, k);
  assert.equal(stateOf(r, 'clearinghouse'), STATES.OUTSIDE, 'the app cannot see the clearinghouse, so it never reads ok');
  assert.match(r.checks.find(c => c.key === 'clearinghouse').detail, /Billing Manager/);
});

test('not signed in to OpenEMR blocks, and says so', () => {
  const r = buildBillingConnection({ ...GOOD, emr: { configured: true, reachable: true, connected: false } });
  assert.equal(stateOf(r, 'emr_signin'), STATES.BLOCKED);
  assert.equal(r.ready, false);
  assert.equal(r.checks.some(c => c.key === 'emr_scopes'), false, 'no scope verdict about a token that does not exist');
});

test('a check that could not run is UNKNOWN, and unknown is never ready', () => {
  const unreachable = buildBillingConnection({ ...GOOD, emr: { configured: true, reachable: false, error: 'timeout' } });
  assert.equal(stateOf(unreachable, 'emr_signin'), STATES.UNKNOWN);
  assert.equal(unreachable.ready, false);
  const noList = buildBillingConnection({ ...GOOD, facilityInfo: { facilityListKnown: false } });
  assert.equal(stateOf(noList, 'billing_facility'), STATES.UNKNOWN);
  assert.equal(noList.ready, false);
  const scopesUnsaid = buildBillingConnection({ ...GOOD, emr: { ...GOOD.emr, billingRouteScopes: undefined } });
  assert.equal(stateOf(scopesUnsaid, 'emr_scopes'), STATES.UNKNOWN);
  assert.equal(buildBillingConnection({ ...GOOD, catalog: null }).ready, false);
  assert.equal(buildBillingConnection({ ...GOOD, ncci: null }).ready, false);
});

test('each missing billing-facility field is named, so the fix in OpenEMR is exact', () => {
  const r = buildBillingConnection({ ...GOOD, facilityInfo: { facilityListKnown: true, billingFacility: { ...GOOD.facilityInfo.billingFacility, ein: '', taxonomy: null } } });
  const c = r.checks.find(x => x.key === 'billing_facility');
  assert.equal(c.state, STATES.BLOCKED);
  assert.match(c.detail, /federal EIN, taxonomy/);
  assert.doesNotMatch(c.detail, /no NPI/);
});

test('a narrowed token, an unset NPI and unloaded NCCI tables each block', () => {
  assert.equal(stateOf(buildBillingConnection({ ...GOOD, emr: { ...GOOD.emr, billingRouteScopes: false } }), 'emr_scopes'), STATES.BLOCKED);
  assert.equal(stateOf(buildBillingConnection({ ...GOOD, payer: { billing_npi_used: null } }), 'billing_npi'), STATES.BLOCKED);
  const n = buildBillingConnection({ ...GOOD, ncci: { ncciSourceVersion: { ptp: { quarter: 'UNLOADED' }, mue: { quarter: '2026Q4' } } } });
  assert.equal(stateOf(n, 'ncci'), STATES.BLOCKED);
  assert.match(n.checks.find(c => c.key === 'ncci').detail, /PTP/);
});

test('the route is billing\'s, reads every link with the caller\'s own session, and survives a failed read', () => {
  const at = server.indexOf("app.get('/api/clinical/billing/connection', authenticateToken, requireBilling,");
  assert.ok(at > 0, 'behind requireBilling');
  const body = server.slice(at, server.indexOf('\napp.', at + 10));
  assert.match(body, /openemr\.getStatus\(req\.user\)/, 'the sign-in checked is the CALLER\'s');
  assert.match(body, /const settle = \(p\) => p\.then\(v => v, \(\) => null\);/, 'one failed read leaves the rest of the answer');
  assert.match(body, /billingConnection\.buildBillingConnection\(/);
});

// ---- 2. the sign-in comes back to the billing page --------------------------
const KEY = crypto.randomBytes(32).toString('hex');
const CFG = { OPENEMR: { BASE_URL: 'https://emr.example.test/', SITE: 'default', CLIENT_ID: 'cid', CLIENT_SECRET: 's',
  REDIRECT_URI: 'https://app.example.test/oauth/callback', SCOPES: 'openid offline_access', TOKEN_ENCRYPTION_KEY: KEY } };
const authFor = (status = 200) => {
  const store = dataStore.createStore({ adapter: 'memory', env: { NODE_ENV: 'test' } });
  authFor.lastStore = store;
  let t = Date.parse('2026-11-04T12:00:00.000Z');
  const fetch = async (url) => (String(url).endsWith('/token')
    ? { status, json: async () => (status === 200 ? { access_token: 'AT', refresh_token: 'RT', expires_in: 3600, scope: 'openid' } : { error: 'invalid_grant' }) }
    : { status: 200, json: async () => ({ sub: 's', preferred_username: 'mgr' }) });
  return { auth: createEmrAuth({ store, config: CFG, fetch, now: () => t }), tick: (ms) => { t += ms; } };
};

test('a sign-in started on the billing page lands back on it', async () => {
  const { auth } = authFor();
  const { state } = await auth.beginAuthorization({ id: 'u1' }, { returnTo: 'billing' });
  const r = await auth.completeAuthorization({ state, code: 'C' });
  assert.equal(r.returnTo, '/billing');
});

test('the landing page is an allow-list: anything else is the clinical workspace', async () => {
  for (const asked of [undefined, 'clinical', 'https://evil.example', '//evil.example', '/admin']) {
    const { auth } = authFor();
    const { state } = await auth.beginAuthorization({ id: 'u1' }, { returnTo: asked });
    assert.equal((await auth.completeAuthorization({ state, code: 'C' })).returnTo, '/clinical', String(asked));
  }
});

test('the state row stores only an allowed page, checked again on the way back', async () => {
  // Two checks on purpose: what begins the flow stores an allowed page, and
  // the callback maps the stored value through the same list, so a row
  // written some other way still cannot redirect anywhere else.
  const { auth } = authFor();
  const { state } = await auth.beginAuthorization({ id: 'u1' }, { returnTo: 'https://evil.example' });
  const row = await authFor.lastStore.get(`emr_oauth_state:${state}`);
  assert.equal(row.returnTo, '/clinical');
  await authFor.lastStore.set(`emr_oauth_state:${state}`, { ...row, returnTo: 'https://evil.example' });
  assert.equal((await auth.completeAuthorization({ state, code: 'C' })).returnTo, '/clinical');
});

test('a failed exchange still returns to where it began, so the error is shown there', async () => {
  const { auth } = authFor(400);
  const { state } = await auth.beginAuthorization({ id: 'u1' }, { returnTo: 'billing' });
  await assert.rejects(auth.completeAuthorization({ state, code: 'C' }), (e) => e.code === 'EMR_AUTH_EXCHANGE_FAILED' && e.returnTo === '/billing');
});

test('the callback redirects to the state row\'s page, never to one named in the request', () => {
  const at = server.indexOf("app.get('/oauth/callback'");
  const body = server.slice(at, server.indexOf('\napp.', at + 10));
  assert.match(body, /back\(\{ emr: 'connected' \}, result\.returnTo\)/);
  assert.match(body, /back\(\{ emr: 'error', reason: err\.code \|\| 'EMR_AUTH_FAILED' \}, err\.returnTo\)/);
  assert.doesNotMatch(body, /req\.query\.(return|next|redirect)/, 'nothing from the query string picks the landing page');
  assert.match(server, /beginAuthorization\(req\.user, \{ returnTo: req\.query\.return === 'billing' \? 'billing' : 'clinical' \}\)/);
});

// ---- 3. the claim is worked on /billing --------------------------------------
test('the billing page checks the OpenEMR connection and signs in to come back to itself', () => {
  assert.match(billing, /connection: \(\) => call\('\/api\/clinical\/billing\/connection'\)/);
  assert.match(billing, /emrConnect: \(\) => call\('\/api\/emr\/connect\?return=billing'\)/);
  assert.match(billing, /<ConnectionCard refreshKey=\{refreshKey\} \/>/);
});

test('a claim reads top to bottom in the order it is worked: scrub, codes, level, place of service, submit, posted lines, note', () => {
  const view = billing.slice(billing.indexOf('const ClaimDetail = ('), billing.indexOf('const ClaimsView = ('));
  const order = ['<Section id="scrub"', '<Section id="codes"', '<Section id="level"', '<Section id="pos"', '<Section id="submit"', '<Section id="charges"', '<Section id="note"'];
  let last = -1;
  for (const o of order) { const i = view.indexOf(o); assert.ok(i > last, `${o} in order`); last = i; }
  assert.match(view, /<ClaimScrubPanel patientId=\{clientId\} euuid=\{euuid\}[^>]*onGoTo=\{goTo\}/, 'each finding links to its fix');
  assert.match(view, /<SvcEditor services=\{services\}[^>]*readOnly=\{!ba\.canEditCoding\}/, 'codes editable only while billing may edit them, as the server says');
  assert.match(view, /diagnoses: rec\.diagnoses \|\| \[\]/, 'billing saves the clinician\'s diagnoses unchanged');
});

test('the lines OpenEMR holds are read back from OpenEMR, and void needs a reason', () => {
  assert.match(billing, /charges: \(id, euuid\) => call\(`\$\{visit\(id, euuid\)\}\/charges`\)/);
  const lines = billing.slice(billing.indexOf('const ChargeLines = ('), billing.indexOf('const Section = ('));
  assert.match(lines, /window\.prompt\(`Why void/);
  assert.match(lines, /if \(reason && reason\.trim\(\)\) act/);
});

test('a finding links only where its field is fixed, and an unknown field gets no link', () => {
  const src = billing.slice(billing.indexOf('const SECTION_FOR_FIELD = ['), billing.indexOf('const CONNECTION_ICON'));
  // eslint-disable-next-line no-new-func
  const { SECTION_FOR_FIELD } = new Function(`${src.slice(0, src.indexOf('const FixLink'))}; return { SECTION_FOR_FIELD };`)();
  const where = (f) => (SECTION_FOR_FIELD.find(([re]) => re.test(f)) || [])[1] || null;
  assert.equal(where('lines[0].dxLinks'), 'codes');
  assert.equal(where('encounter.posCode'), 'pos');
  assert.equal(where('billingFacility.ein'), 'connection');
  assert.equal(where('emDerivation'), 'level');
  assert.equal(where('something.new'), null);
  assert.match(billing, /if \(!hit \|\| !onGoTo\) return null;/, 'and FixLink draws nothing for it');
});

test('the queue serves billing\'s history (released, no charge) to billing only', () => {
  const q = server.slice(server.indexOf("app.get('/api/clinical/encounters/queue'"));
  const body = q.slice(0, q.indexOf('\napp.'));
  assert.match(body, /'released', 'no_charge', 'open', 'all'\]\.includes/);
  assert.match(body, /const released = canBill \?/);
  assert.match(body, /const noCharge = canBill \?/);
});

test('the encounter has ONE coding area and no billing tools', () => {
  const panel = clinical.slice(clinical.indexOf('const EncounterPanel = ('), clinical.indexOf('const EncountersTab = ('));
  for (const c of ['<ClaimScrubPanel', '<BillingLevelPanel', '<CodeHelperPanel', 'api.billingSubmit', 'Submit to Billing']) {
    assert.ok(!panel.includes(c), `${c} is on the billing page, not the encounter`);
  }
  assert.equal(panel.split('<SvcEditor ').length - 1, 1, 'one service editor');
  assert.equal(panel.split('<DxEditor ').length - 1, 1, 'one diagnosis editor');
  assert.match(panel, /const codingLocked = closed \? !na\.canAddClinicianAddendum : !canWrite;/, 'after signing, only the clinician addendum reopens coding');
  assert.doesNotMatch(panel, /billerEditing/);
  assert.match(panel, /href=\{billingClaimHref\(patient\.id, euuid\)\}><i className="ti ti-receipt" \/>Open in Billing<\/a>/);
});

test('both pages load the one shared copy of the note view and the service editor', () => {
  for (const [name, page] of [['clinical', clinical], ['billing', billing]]) {
    assert.match(page, /<script type="text\/babel" src="\/components\/claim-shared\.jsx"><\/script>/, name);
    assert.match(page, /= window\.GFC_CLAIM_SHARED;/, name);
    assert.doesNotMatch(page, /const SvcEditor = \(/, `${name} keeps no copy of its own`);
    assert.doesNotMatch(page, /const SignedNoteView = \(/, `${name} keeps no copy of its own`);
  }
  assert.match(shared, /window\.GFC_CLAIM_SHARED = \{/);
  assert.match(shared, /deps\.codeSearch\(\{ set, q, clientId/, 'the search goes through the page\'s own API call');
  assert.ok(billing.indexOf('/note-format.js') < billing.indexOf('claim-shared.jsx'), 'the note formatter loads first');
});
