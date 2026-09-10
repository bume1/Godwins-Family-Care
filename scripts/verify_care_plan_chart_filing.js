#!/usr/bin/env node
/**
 * The plan of care and the chart — HTTP round trip.
 *
 * THE RULE (owner, 2026-09-09): the plan of care lives in the app. It reaches
 * the patient's OpenEMR document record only when the client is a CLINICAL
 * patient — enrolled that way, or toggled onto it later.
 *
 * The half that was broken is "later". Filing happened at author time and again
 * at co-sign, and both are over by the time a home care client adds medical
 * care. This proves the backfill: a home care client with a signed plan, then
 * made a patient, ends up with that plan in their chart — and that a client who
 * stays on home care never does.
 *
 * Runs the REAL server and the REAL routes. Stubbed: the KV store, Drive, and
 * the OpenEMR transport (not reachable from a build sandbox). Every assertion
 * reads back what was actually recorded, never a status code.
 *
 *   node scripts/verify_care_plan_chart_filing.js
 */
process.env.PORT = process.env.PORT || '4601';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'care-plan-chart-verification-secret';

const path = require('path');
const Module = require('module');

const STORE = new Map();
class MemDb {
  async get(k) { return STORE.has(k) ? JSON.parse(JSON.stringify(STORE.get(k))) : null; }
  async set(k, v) { STORE.set(k, JSON.parse(JSON.stringify(v))); return true; }
  async delete(k) { STORE.delete(k); return true; }
  async list(prefix) { return [...STORE.keys()].filter(k => !prefix || k.startsWith(prefix)); }
  async empty() { STORE.clear(); return true; }
}
const realResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === '@replit/database') return '__memdb__';
  return realResolve.call(this, request, ...rest);
};
require.cache['__memdb__'] = { id: '__memdb__', filename: '__memdb__', loaded: true, exports: MemDb };

// Drive: unavailable, so every PDF is rebuilt from the app's own records —
// which is also the harder path and the one worth proving.
const gdrive = require(path.join(__dirname, '..', 'googledrive.js'));
gdrive.downloadFileBuffer = async () => { throw new Error('no Drive in this sandbox'); };
gdrive.uploadCarePlanFile = async () => { throw new Error('no Drive in this sandbox'); };

// OpenEMR: record every document upload instead of performing one.
const CHART = [];
const openemr = require(path.join(__dirname, '..', 'openemr.js'));
openemr.isConfigured = () => true;
const realForActor = openemr.forActor;
openemr.forActor = (actor) => {
  const client = { ...(realForActor ? {} : {}) };
  return new Proxy(client, {
    get(_t, prop) {
      if (prop === 'uploadPatientDocument') {
        return async (puuid, fileName, buffer, mimeType, categoryPath) => {
          CHART.push({ puuid, fileName, bytes: buffer.length, mimeType, categoryPath });
          return { id: `doc_${CHART.length}` };
        };
      }
      if (prop === 'getPatient') return async (id) => ({ id });
      return async () => { throw new Error(`openemr.${String(prop)} not stubbed`); };
    }
  });
};

const jwt = require('jsonwebtoken');
const config = require(path.join(__dirname, '..', 'config.js'));

const BASE = `http://127.0.0.1:${process.env.PORT}`;
let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
};
const tok = (u) => jwt.sign({ id: u.id, email: u.email, name: u.name, role: u.role }, process.env.JWT_SECRET, { expiresIn: '1h' });
const call = async (method, url, token, body) => {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: Object.assign({ Authorization: `Bearer ${token}` }, body ? { 'Content-Type': 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined
  });
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, body: ct.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
};

const PLAN = {
  version: 1, problems: [{ text: 'Fall risk' }], goals: ['Remain safe at home'],
  tasks: ['Assist with bathing'], frequency: '3x weekly', effectiveDate: '2026-09-01'
};
const mkClient = (over) => Object.assign({
  role: config.ROLES.CLIENT, enrollmentStatus: 'enrolled', consents: { consentToTreat: 'signed' },
  consentMeta: {}, intake: { dob: '1948-03-11' }, careTier: 'A2',
  carePlan: { ...PLAN, rnSignedAt: '2026-09-02T10:00:00.000Z', rnName: 'Bethel Godwins RN' },
  carePlanCoSign: { v1: { at: '2026-09-03T12:00:00.000Z', name: 'Client' } }
}, over);

const HOME_ONLY = mkClient({ id: 'c_home', email: 'home@test', name: 'Home Only', slug: 'home-only', serviceLine: 'PHC' });
const TOGGLED   = mkClient({ id: 'c_toggle', email: 'toggle@test', name: 'Toggle Later', slug: 'toggle-later', serviceLine: 'PHC', openEmrPatientId: 'uuid-toggle' });
const UNLINKED  = mkClient({ id: 'c_unlinked', email: 'unlinked@test', name: 'Not Linked Yet', slug: 'not-linked', serviceLine: 'BOTH' });
const STAFF = { id: 'staff_1', role: config.ROLES.ADMIN, email: 'staff@test', name: 'Verification Staff' };

(async () => {
  STORE.set('users', [HOME_ONLY, TOGGLED, UNLINKED, STAFF]);
  STORE.set('care_plan_versions', [HOME_ONLY, TOGGLED, UNLINKED].map(c => ({
    id: `v_${c.id}`, client_id: c.id, version: 1, plan: PLAN,
    rnSignature: { name: 'Bethel Godwins RN', at: '2026-09-02T10:00:00.000Z' }, createdAt: '2026-09-02T10:00:00.000Z'
  })));
  STORE.set('care_plan_cosign_events', [HOME_ONLY, TOGGLED, UNLINKED].map(c => ({
    id: `e_${c.id}`, client_id: c.id, version: 1, at: '2026-09-03T12:00:00.000Z', name: 'Client', signerRole: 'client'
  })));

  require(path.join(__dirname, '..', 'server.js'));
  await new Promise(r => setTimeout(r, 2500));
  const st = tok(STAFF);

  console.log('\n── A home care client\'s plan stays in the app ──');
  let r = await call('PUT', `/api/gfc/admin/enrollment/${HOME_ONLY.id}/service-line`, st, { serviceLine: 'PHC' });
  check('no change is a no-op', r.status === 200, JSON.stringify(r.body).slice(0, 160));
  check('nothing was filed to any chart', CHART.length === 0, JSON.stringify(CHART));

  console.log('\n── Toggling a linked client onto medical care files the plan ──');
  const before = CHART.length;
  r = await call('PUT', `/api/gfc/admin/enrollment/${TOGGLED.id}/service-line`, st, { serviceLine: 'BOTH' });
  check('the line change succeeded', r.status === 200, JSON.stringify(r.body).slice(0, 200));
  check('and it reports the filing', r.body.carePlanFiling && r.body.carePlanFiling.filed === true, JSON.stringify(r.body.carePlanFiling));
  check('exactly one document reached the chart', CHART.length === before + 1, String(CHART.length));
  const filed = CHART[CHART.length - 1] || {};
  check('against the right patient', filed.puuid === 'uuid-toggle', filed.puuid);
  check('into the medical record folder', filed.categoryPath === '/Medical Record', filed.categoryPath);
  check('as a real PDF, not an empty file', filed.mimeType === 'application/pdf' && filed.bytes > 800, `${filed.mimeType} ${filed.bytes}`);
  check('named as the signed plan it is', /^CarePlan_Later_v1_signed_\d{8}\.pdf$/.test(filed.fileName || ''), filed.fileName);
  check('rebuilt from the app records, Drive being unavailable', r.body.carePlanFiling.source === 'regenerated', r.body.carePlanFiling.source);

  console.log('\n── It is recorded on the client, and never filed twice ──');
  r = await call('GET', `/api/gfc/admin/enrollment/${TOGGLED.id}`, st);
  const users = await new MemDb().get('users');
  const stored = (users.find(u => u.id === TOGGLED.id).carePlanDocs || {}).v1 || {};
  check('the filing is stamped on the client record', !!(stored.chartFiled && stored.chartFiled.emrDocumented), JSON.stringify(stored));
  check('with what triggered it', stored.chartFiled.trigger === 'service_line_changed', stored.chartFiled && stored.chartFiled.trigger);
  const afterFirst = CHART.length;
  r = await call('PUT', `/api/gfc/admin/enrollment/${TOGGLED.id}/service-line`, st, { serviceLine: 'IHPC' });
  check('a second line change does not re-file it', CHART.length === afterFirst, `${afterFirst} → ${CHART.length}`);
  check('and says why', r.body.carePlanFiling && r.body.carePlanFiling.reason === 'ALREADY_FILED', JSON.stringify(r.body.carePlanFiling));

  console.log('\n── A clinical client with no chart yet files on linking ──');
  const beforeLink = CHART.length;
  r = await call('PUT', `/api/gfc/admin/enrollment/${UNLINKED.id}/service-line`, st, { serviceLine: 'IHPC' });
  check('the toggle alone files nothing — there is no chart', CHART.length === beforeLink, String(CHART.length));
  check('and names that as the reason', r.body.carePlanFiling && r.body.carePlanFiling.reason === 'NOT_LINKED', JSON.stringify(r.body.carePlanFiling));

  r = await call('POST', `/api/clinical/patients/${UNLINKED.id}/link`, st, { openEmrPatientId: 'uuid-linked' });
  check('linking succeeded', r.status === 200, JSON.stringify(r.body).slice(0, 200));
  check('and the plan reaches the chart at that moment', CHART.length === beforeLink + 1, String(CHART.length));
  check('reported on the link response', r.body.carePlanFiling && r.body.carePlanFiling.filed === true, JSON.stringify(r.body.carePlanFiling));
  const linkFiled = CHART[CHART.length - 1] || {};
  check('against the newly linked chart', linkFiled.puuid === 'uuid-linked', linkFiled.puuid);

  console.log('\n── The home care client is still untouched ──');
  const homeUser = (await new MemDb().get('users')).find(u => u.id === HOME_ONLY.id);
  check('no chart filing recorded', !((homeUser.carePlanDocs || {}).v1 || {}).chartFiled);
  check('and their plan is still on their record', !!homeUser.carePlan && homeUser.carePlan.version === 1);
  check('nothing of theirs ever reached a chart', !CHART.some(d => /Only/.test(d.fileName || '')), JSON.stringify(CHART.map(d => d.fileName)));

  console.log('\n── The audit trail ──');
  const log = (await new MemDb().get('activity_log')) || [];
  const filings = log.filter(e => e.action === 'care_plan_filed_to_chart');
  check('every filing is audited', filings.length === 2, String(filings.length));
  check('with the trigger recorded', filings.every(f => f.details && f.details.trigger), JSON.stringify(filings.map(f => f.details && f.details.trigger)));

  console.log(`\n${pass}/${pass + fail} checks passed.`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
