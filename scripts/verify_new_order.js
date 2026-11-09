#!/usr/bin/env node
/**
 * New Order from the chart — HTTP round trip (2026-11-09).
 *
 * Owner: "we need to be able to create orders like a standard practice." The
 * chart's Orders tab places an order without opening a visit first: it picks
 * an open draft, or the most recent SIGNED visit, where the order uses only
 * the diagnoses that visit was signed with and is written onto the note as an
 * addendum. Plus: one order per submit key, and OpenEMR failures that say
 * what they are.
 *
 * Drives the REAL server and the REAL routes, and reads the STORED rows back.
 * Stubbed: the KV store and the OpenEMR transport. Encounters are seeded as
 * the app's own records (a draft, two signed visits, a deleted one), because
 * signing one end to end is the note probe's job, not this one's.
 *
 *   node scripts/verify_new_order.js
 */
process.env.PORT = process.env.PORT || '4613';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'new-order-verification-secret';
process.env.MFA_ENFORCE = 'false';
process.env.DATA_STORE = 'kv';

const path = require('path');
const Module = require('module');
const bcrypt = require('bcryptjs');

const STORE = new Map();
class MemDb {
  async get(k) { return STORE.has(k) ? JSON.parse(JSON.stringify(STORE.get(k))) : null; }
  async set(k, v) { STORE.set(k, JSON.parse(JSON.stringify(v))); return true; }
  async delete(k) { STORE.delete(k); return true; }
  async list(p) { return [...STORE.keys()].filter(k => !p || k.startsWith(p)); }
  async empty() { STORE.clear(); return true; }
}
const realResolve = Module._resolveFilename;
Module._resolveFilename = function (r, ...rest) {
  if (r === '@replit/database') return '__memdb__';
  return realResolve.call(this, r, ...rest);
};
require.cache['__memdb__'] = { id: '__memdb__', filename: '__memdb__', loaded: true, exports: MemDb };
const rows = (k) => STORE.get(k) || [];

// ---- a fake OpenEMR ---------------------------------------------------------
const EMR = { seq: 500, orders: [], charges: [], documents: [], soap: new Map() };
const openemr = require(path.join(__dirname, '..', 'openemr.js'));
openemr.isConfigured = () => true;
openemr.forActor = () => new Proxy({}, {
  get(_t, prop) {
    switch (prop) {
      // An encounter the app has never seen is read from OpenEMR with the
      // clinician's own sign-in. Here that sign-in has lapsed.
      case 'getEncounterRow': return async () => {
        const e = new Error('Sign in to OpenEMR to continue.'); e.code = 'EMR_NOT_CONNECTED'; e.status = 409; throw e;
      };
      // A slow filing, so a double click lands while the first save is running.
      case 'postOrder': return async (puuid, euuid, payload) => { await new Promise(r => setTimeout(r, 300)); const id = String(++EMR.seq); EMR.orders.push({ id, euuid, payload }); return { procedure_order_id: id }; };
      case 'postCharge': return async (puuid, euuid, p) => { EMR.charges.push({ euuid, ...p }); return { id: String(++EMR.seq) }; };
      case 'addSoapNote': return async (puuid, euuid, note) => { const sid = String(++EMR.seq); EMR.soap.set(sid, { id: sid, euuid, ...note }); return { sid }; };
      case 'updateSoapNote': return async (puuid, euuid, sid, note) => { EMR.soap.set(String(sid), { id: String(sid), euuid, ...note }); return {}; };
      case 'getSoapNote': return async (puuid, euuid, sid) => EMR.soap.get(String(sid)) || null;
      case 'uploadPatientDocument': return async (puuid, fileName, buffer) => { EMR.documents.push({ fileName, bytes: buffer.length }); return true; };
      default:
        if (/^get/.test(String(prop))) return async () => [];
        return async () => { throw new Error(`openemr.${String(prop)} not stubbed`); };
    }
  }
});

// ---- the world -------------------------------------------------------------
const config = require(path.join(__dirname, '..', 'config.js'));
const BASE = `http://127.0.0.1:${process.env.PORT}`;
const PW = 'Probe12345!';
let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { pass++; console.log(`  ✅ ${n}`); } else { fail++; console.log(`  ❌ ${n}${d !== undefined ? ` — ${typeof d === 'string' ? d : JSON.stringify(d).slice(0, 400)}` : ''}`); } };
const call = async (m, u, t, b) => {
  const r = await fetch(`${BASE}${u}`, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: `Bearer ${t}` } : {}) }, body: b ? JSON.stringify(b) : undefined });
  let j = null; try { j = await r.json(); } catch (_) {}
  return { status: r.status, body: j };
};
const login = async (email) => { const r = await call('POST', '/api/auth/login', null, { email, password: PW }); return r.body && r.body.token; };

const staff = (id, name, clinicalRole, extra = {}) => ({
  id, name: `${name} (TEST DATA)`, email: `${id}@example.test`, role: 'user', clinicalRole,
  hasClinicalAccess: clinicalRole !== 'readOnly', npi: clinicalRole === 'provider' ? '1234567893' : null,
  openEmrProviderId: clinicalRole === 'provider' ? '7' : null, accountStatus: 'active', ...extra
});
const FNP = staff('fnp_1', 'Bethel Godwins', 'provider', { prescriberCredential: 'NP' });
const FNP2 = staff('fnp_2', 'Second Provider', 'provider');
const RN = staff('rn_1', 'Ruth Nolan', 'rn');
const VIEW = { id: 'view_1', name: 'Vera Hill (TEST DATA)', email: 'view_1@example.test', role: 'user', isManager: true, hasClinicalAccess: false,
  clinicalRole: 'readOnly', accountType: 'manager', managerClinicalAccess: 'view', accountStatus: 'active' };
const PATIENT = {
  id: 'c_order', role: config.ROLES.CLIENT, email: 'c_order@example.test', name: 'Order Probe Patient (TEST DATA)',
  slug: 'order-probe', serviceLine: 'IHPC', enrollmentStatus: 'enrolled', openEmrPatientId: 'uuid-order-patient',
  openEmrFacilityId: '5', intake: { dob: '1948-03-11' }
};
const BARE = { ...PATIENT, id: 'c_bare', email: 'c_bare@example.test', slug: 'order-bare', openEmrPatientId: 'uuid-bare' };

const visit = { appointmentType: 'pc_follow_up', modality: 'in_person', location: 'home' };
const billing = (euuid, date, dx, extra = {}) => ({
  id: `b-${euuid}`, clientId: PATIENT.id, puuid: PATIENT.openEmrPatientId, encounterUuid: euuid, encounterEid: euuid.replace(/\D/g, ''),
  reason: `Visit ${euuid}`, date, visit, diagnoses: dx.map(code => ({ code, description: `${code} (TEST)` })),
  services: [{ code: '99349', dxLinks: [dx[0]] }], renderingProvider: { id: FNP.id, name: FNP.name },
  codingStatus: 'coded', narrativeNoteSid: null, structuredNoteSid: null, createdAt: `${date}T15:00:00Z`, updatedAt: `${date}T15:00:00Z`, ...extra
});
const attest = (euuid, signedAt, codes) => ({
  id: `att-${euuid}`, clientId: PATIENT.id, encounterUuid: euuid, signedAt,
  signedBy: { id: FNP.id, name: FNP.name }, diagnosisCodes: codes, serviceCodes: ['99349']
});

(async () => {
  const hash = await bcrypt.hash(PW, 4);
  STORE.set('users', [PATIENT, BARE, FNP, FNP2, RN, VIEW].map(u => ({ ...u, password: hash })));
  STORE.set('gfc_payer_credentialing', { billing_npi_used: '1234567893', billing_provider_name: 'GFC' });
  STORE.set('encounter_billing', [
    billing('enc-draft', '2026-11-05', ['I10']),
    billing('enc-old', '2026-10-01', ['I10']),
    // Signed with I10 only; E11.9 sits on the record (billing's later view)
    // but was not what the clinician attested to.
    billing('enc-latest', '2026-11-01', ['I10', 'E11.9']),
    billing('enc-deleted', '2026-11-07', ['I10'], { noteStatus: 'voided' })
  ]);
  STORE.set('encounter_attestations', [
    attest('enc-old', '2026-10-01T16:00:00Z', ['I10']),
    attest('enc-latest', '2026-11-01T16:00:00Z', ['I10'])
  ]);

  require(path.join(__dirname, '..', 'server.js'));
  await new Promise(r => setTimeout(r, 3000));
  const tok = {};
  for (const [k, u] of Object.entries({ fnp: FNP, fnp2: FNP2, rn: RN, view: VIEW })) tok[k] = await login(u.email);
  if (!tok.fnp || !tok.rn || !tok.view || !tok.fnp2) { console.log('LOGIN FAILED', tok); process.exit(1); }
  const P = `/api/clinical/patients/${PATIENT.id}`;
  const lab = (key, extra = {}) => ({ orderType: 'lab', tests: ['CBC'], priority: 'routine', diagnosisCodes: ['I10'], notes: 'Secret clinical note', idempotencyKey: key, ...extra });
  const billingRow = (e) => rows('encounter_billing').find(r => r.encounterUuid === e);

  console.log('\n── 1. The Orders tab is told where an order can go ──');
  let r = await call('GET', `${P}/orders`, tok.fnp);
  const pl = r.body && r.body.placement;
  check('the orders list carries a placement block', r.status === 200 && !!pl, r.body);
  check('a provider may place orders', pl && pl.canPlace === true);
  check('the draft comes first and is the default', pl && pl.targets[0].encounterUuid === 'enc-draft' && pl.defaultEncounterUuid === 'enc-draft', pl && pl.targets);
  check('only the LATEST signed visit is offered, after the drafts', pl && pl.targets.length === 2 && pl.targets[1].encounterUuid === 'enc-latest' && pl.targets[1].afterSigning === true, pl && pl.targets);
  check('a deleted visit is never offered', pl && !pl.targets.some(t => t.encounterUuid === 'enc-deleted'));
  check('the signed visit offers only the diagnoses it was signed with', pl && JSON.stringify(pl.targets[1].diagnoses.map(d => d.code)) === '["I10"]', pl && pl.targets[1]);
  check('the visit is named by its type', pl && pl.targets[0].visitLabel === 'Follow-up', pl && pl.targets[0]);
  r = await call('GET', `${P}/orders`, tok.view);
  check('a view-only manager reads the list and may not place', r.status === 200 && r.body.placement && r.body.placement.canPlace === false, r.body && r.body.placement);
  r = await call('GET', `${P}/orders`, tok.rn);
  check('an RN may place (a referral to the team, or under a protocol)', r.status === 200 && r.body.placement.canPlace === true && r.body.placement.requireStandingOrder === true);
  r = await call('GET', `/api/clinical/patients/${BARE.id}/orders`, tok.fnp);
  check('a patient with no visit says so', r.status === 200 && r.body.placement.targets.length === 0 && r.body.placement.emptyReason === 'NO_VISITS', r.body && r.body.placement);

  console.log('\n── 2. One submit is one order ──');
  r = await call('POST', `${P}/encounters/enc-draft/orders`, tok.fnp, lab('key-1'));
  check('a lab order on the draft visit is recorded', r.status === 200 && r.body.order && r.body.order.orderType === 'lab', r.body);
  const firstId = r.body && r.body.order && r.body.order.id;
  check('the submit key never reaches the browser', r.body && r.body.order && !('idempotencyKey' in r.body.order));
  r = await call('POST', `${P}/encounters/enc-draft/orders`, tok.fnp, lab('key-1'));
  check('the same submit again returns the same order, marked duplicate', r.status === 200 && r.body.duplicate === true && r.body.order.id === firstId, r.body);
  check('only one order is stored and only one was filed in OpenEMR', rows('clinical_orders').filter(o => o.idempotencyKey && o.idempotencyKey.endsWith(':key-1')).length === 1 && EMR.orders.length === 1);
  r = await call('POST', `${P}/encounters/enc-draft/orders`, tok.fnp2, lab('key-1'));
  check('the same key from someone else is their own order', r.status === 200 && !r.body.duplicate && r.body.order.id !== firstId, r.body);
  const [c1, c2] = await Promise.all([
    call('POST', `${P}/encounters/enc-draft/orders`, tok.fnp, lab('key-dbl')),
    call('POST', `${P}/encounters/enc-draft/orders`, tok.fnp, lab('key-dbl'))
  ]);
  const codes = [c1, c2].map(x => x.status === 200 ? 'ok' : (x.body && x.body.code)).sort();
  check('a double click while the first save runs is refused, not saved twice', JSON.stringify(codes) === '["ORDER_IN_FLIGHT","ok"]', [c1.body, c2.body]);
  check('the double click stored one order', rows('clinical_orders').filter(o => o.idempotencyKey && o.idempotencyKey.endsWith(':key-dbl')).length === 1);
  r = await call('GET', `${P}/orders`, tok.fnp);
  check('the list never carries a submit key', r.status === 200 && !JSON.stringify(r.body.orders).includes('idempotencyKey'));

  console.log('\n── 3. An order on a signed visit is an addendum ──');
  const before = JSON.stringify({ dx: billingRow('enc-latest').diagnoses, svc: billingRow('enc-latest').services });
  r = await call('POST', `${P}/encounters/enc-latest/orders`, tok.fnp, lab('key-2'));
  check('without asking for it, a signed visit still refuses', r.status === 409 && r.body.code === 'ENCOUNTER_CLOSED', r.body);
  r = await call('POST', `${P}/encounters/enc-latest/orders`, tok.fnp, lab('key-3', { diagnosisCodes: ['E11.9'], afterSigning: true }));
  check('a diagnosis the visit was not signed with is refused', r.status === 400 && r.body.code === 'ORDER_DX_NOT_SIGNED', r.body);
  r = await call('POST', `${P}/encounters/enc-latest/orders`, tok.fnp, lab('key-4', { afterSigning: true }));
  check('an order on the latest signed visit is recorded', r.status === 200 && /addendum/.test(r.body.message || ''), r.body);
  const after = r.body && r.body.order;
  const ad = rows('encounter_addenda').filter(a => a.encounterUuid === 'enc-latest');
  check('exactly one addendum was written to that note', ad.length === 1, ad);
  check('the addendum names the order and points back at it', ad[0] && ad[0].source && ad[0].source.orderId === after.id && /CBC/.test(ad[0].text) && ad[0].text.includes(after.orderReference));
  check('the addendum carries no clinical note text (it reaches the portal)', ad[0] && !/Secret clinical note/.test(ad[0].text));
  check('the order is linked to its addendum', after && after.afterSigning && after.afterSigning.addendumId === ad[0].id);
  check('the signed visit\'s coding is untouched and nothing was charged', JSON.stringify({ dx: billingRow('enc-latest').diagnoses, svc: billingRow('enc-latest').services }) === before && EMR.charges.length === 0);
  r = await call('POST', `${P}/encounters/enc-latest/orders`, tok.fnp, lab('key-4', { afterSigning: true }));
  check('a retry returns the same order and writes no second addendum', r.status === 200 && r.body.duplicate === true && rows('encounter_addenda').filter(a => a.encounterUuid === 'enc-latest').length === 1, r.body);
  r = await call('POST', `${P}/encounters/enc-old/orders`, tok.fnp, lab('key-5', { afterSigning: true }));
  check('an OLDER signed visit is refused', r.status === 409 && r.body.code === 'ORDER_AFTER_SIGNING_NOT_LATEST', r.body);
  r = await call('POST', `${P}/encounters/enc-draft/orders`, tok.fnp, lab('key-6', { afterSigning: true }));
  check('asking for after-signing on an open draft is refused', r.status === 409 && r.body.code === 'ENCOUNTER_NOT_CLOSED', r.body);
  r = await call('POST', `${P}/encounters/enc-deleted/orders`, tok.fnp, lab('key-7'));
  check('a deleted visit takes no order', r.status === 409 && r.body.code === 'NOTE_VOIDED', r.body);
  check('none of the refusals stored anything', rows('clinical_orders').length === 4, rows('clinical_orders').length);

  console.log('\n── 4. The Addendum button still writes through the same writer ──');
  r = await call('POST', `${P}/encounters/enc-latest/addenda`, tok.fnp, { text: 'Patient called back; no change to the plan.' });
  check('a hand-written addendum is recorded', r.status === 200 && rows('encounter_addenda').filter(a => a.encounterUuid === 'enc-latest').length === 2, r.body);

  console.log('\n── 5. Failures say what they are ──');
  r = await call('POST', `/api/clinical/patients/nobody/encounters/enc-draft/orders`, tok.fnp, lab('key-8'));
  check('a missing patient answers with a code', r.status === 404 && r.body.code === 'CLIENT_NOT_FOUND', r.body);
  r = await call('POST', `${P}/encounters/enc-unknown/orders`, tok.fnp, lab('key-9'));
  check('a lapsed OpenEMR sign-in answers as itself, not as a server error', r.status === 409 && r.body.code === 'EMR_NOT_CONNECTED', r.body);
  r = await call('POST', `${P}/encounters/enc-draft/orders`, tok.fnp, lab('key-10'));
  check('the key is released after a refusal, so the next submit works', r.status === 200 && !r.body.duplicate, r.body);

  console.log(`\n${pass}/${pass + fail} checks passed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
