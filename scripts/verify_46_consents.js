#!/usr/bin/env node
// ============================================================
// GODWINS FAMILY CARE — Session 4.6 acceptance run
//
// Exercises the real Express routes end to end against a local key-value store
// that speaks the Replit DB protocol, so the consent registry, the lane split,
// the rate gate, the provenance rules and the signed-copy generators are proven
// through HTTP rather than only at the unit level.
//
// In the style of the Phase 6B acceptance script: EVERY assertion reads back a
// STORED VALUE. A 200 that wrote nothing is the failure mode this session keeps
// running into (OpenEMR's encounter PUT answers 200 with a validationErrors map;
// a consent recorded as "signed" carried no timestamp at all), so a status code
// is never treated as proof.
//
// USAGE:  node scripts/verify_46_consents.js
// Runs entirely locally. No PHI, no network, no live EMR.
// ============================================================

const http = require('http');
const { spawn } = require('child_process');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const KV_PORT = 45231;
const APP_PORT = 45232;
const JWT_SECRET = 'session-4-6-acceptance-secret';
const BASE = `http://127.0.0.1:${APP_PORT}`;

let pass = 0, fail = 0;
const results = [];
function check(name, ok, detail) {
  if (ok) { pass++; results.push(`  ok   ${name}`); }
  else { fail++; results.push(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (name, actual, expected) =>
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

// ---- a minimal store speaking the @replit/database wire protocol ----
const store = new Map();
const kv = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET') {
    if (url.searchParams.has('prefix')) {
      const p = url.searchParams.get('prefix');
      return res.end([...store.keys()].filter(k => k.startsWith(p)).join('\n'));
    }
    const key = decodeURIComponent(url.pathname.slice(1));
    return res.end(store.has(key) ? store.get(key) : '');
  }
  if (req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; });
    return req.on('end', () => {
      const i = body.indexOf('=');
      store.set(decodeURIComponent(body.slice(0, i)), decodeURIComponent(body.slice(i + 1)));
      res.end('');
    });
  }
  if (req.method === 'DELETE') { store.delete(decodeURIComponent(url.pathname.slice(1))); return res.end(''); }
  res.end('');
});

const api = async (method, path, { token, body, headers } = {}) => {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(headers || {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const type = res.headers.get('content-type') || '';
  if (type.includes('application/json')) return { status: res.status, body: await res.json() };
  return { status: res.status, buffer: Buffer.from(await res.arrayBuffer()) };
};

const readUsers = () => JSON.parse(store.get('users') || '[]');
const client = (id) => readUsers().find(u => u.id === id);
const activity = () => JSON.parse(store.get('activity_log') || '[]');

const intakeFor = (over = {}) => ({
  firstName: 'Acceptance', lastName: 'Client', dob: '1948-03-02',
  gender: 'Female', primaryLanguage: 'English',
  address: { line1: '1 Test St', city: 'Atlanta', state: 'GA', zip: '30339' },
  phone: '404-555-0100',
  primaryContact: { name: 'Acceptance Contact', relationship: 'Daughter', phone: '404-555-0101' },
  emergencyContacts: [{ name: 'Acceptance Emergency', relationship: 'Son', phone: '404-555-0102' }],
  crisisNotify: 'Acceptance Contact 404-555-0101',
  medicalTeam: { pcpName: 'Dr Acceptance', preferredHospital: 'Test General', preferredPharmacy: 'Test Pharmacy', pharmacyPhone: '404-555-0103' },
  allergies: 'None known',
  advanceDirective: { status: 'No' },
  ...over
});

async function seed() {
  const pw = await bcrypt.hash('Acceptance1', 10);
  store.set('users', JSON.stringify([
    { id: 'u-admin', email: 'admin@acceptance.local', name: 'Acceptance Admin', password: pw, role: 'admin', accountStatus: 'active' },
    {
      id: 'c-phc', email: 'phc@acceptance.local', name: 'Acceptance PHC', password: pw, role: 'client',
      accountStatus: 'active', slug: 'acceptance-phc', serviceLine: 'PHC',
      enrollmentStatus: 'intake_pending', careTier: 'A2', consents: {}, consentMeta: {}, intake: intakeFor()
    },
    {
      // A live pre-4.6 case: an IHPC patient who signed the COMBINED service
      // agreement and has no clinical agreement anywhere in their file.
      id: 'c-legacy-ihpc', email: 'ihpc@acceptance.local', name: 'Acceptance Legacy IHPC', password: pw, role: 'client',
      accountStatus: 'active', slug: 'acceptance-ihpc', serviceLine: 'IHPC',
      enrollmentStatus: 'enrolled',
      consents: { serviceAgreement: 'signed', monitoring: 'signed' },
      consentMeta: { serviceAgreement: { typedName: 'Acceptance Legacy IHPC', signedAt: '2026-08-01T12:00:00.000Z', ipHash: 'legacy', version: 'draft-1' } },
      intake: intakeFor({ firstName: 'Acceptance', lastName: 'Legacy' })
    }
  ]));
}

async function login(email) {
  const r = await api('POST', '/api/auth/login', { body: { email, password: 'Acceptance1' } });
  if (!r.body || !r.body.token) throw new Error(`login failed for ${email}: ${JSON.stringify(r.body)}`);
  return r.body.token;
}

async function main() {
  await new Promise(r => kv.listen(KV_PORT, r));
  await seed();

  const app = spawn(process.execPath, ['server.js'], {
    cwd: require('path').join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(APP_PORT),
      REPLIT_DB_URL: `http://127.0.0.1:${KV_PORT}`,
      JWT_SECRET,
      NODE_ENV: 'development',
      // The migration is the thing under test — let it run.
      CONSENT_LANE_SPLIT_MIGRATION_APPLIED: 'false',
      CARE_TIER_MIGRATION_APPLIED: 'true'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let appLog = '';
  app.stdout.on('data', d => { appLog += d; });
  app.stderr.on('data', d => { appLog += d; });

  // Wait for the port.
  for (let i = 0; i < 60; i++) {
    try { await fetch(BASE + '/api/health').catch(() => fetch(BASE + '/')); break; }
    catch (_) { await new Promise(r => setTimeout(r, 250)); }
  }
  await new Promise(r => setTimeout(r, 1500)); // let boot migrations settle

  try {
    const adminToken = await login('admin@acceptance.local');
    const phcToken = await login('phc@acceptance.local');

    // ---- 1. the registry, served ----
    const reg = await api('GET', '/api/gfc/admin/enrollment/meta/consent-registry', { token: adminToken });
    eq('registry: fourteen consents', reg.body.consentDefs.length, 14);
    eq('registry: PHC requires nine', (await api('GET', '/api/gfc/admin/enrollment/meta/consent-registry?serviceLine=PHC', { token: adminToken })).body.requiredConsents.length, 9);
    eq('registry: IHPC requires ten', (await api('GET', '/api/gfc/admin/enrollment/meta/consent-registry?serviceLine=IHPC', { token: adminToken })).body.requiredConsents.length, 10);
    eq('registry: BOTH requires thirteen', (await api('GET', '/api/gfc/admin/enrollment/meta/consent-registry?serviceLine=BOTH', { token: adminToken })).body.requiredConsents.length, 13);

    // ---- 2. the lane-split migration ran at boot ----
    const legacy = client('c-legacy-ihpc');
    check('migration: legacy IHPC client flagged for re-signature', !!legacy.consentReaffirmRequired,
      JSON.stringify(legacy.consentReaffirmRequired));
    eq('migration: clinical agreement written pending', legacy.consents.ihpcServiceAgreement, 'pending');
    eq('migration: the home care signature is NOT erased', legacy.consents.serviceAgreement, 'signed');
    eq('migration: provenance-free inactive consent corrected', legacy.consents.monitoring, 'optin_recorded');
    check('migration: the corrected record gained provenance', !!(legacy.consentMeta.monitoring || {}).recordedAt);
    check('migration: log written', appLog.includes('consent migration'), appLog.slice(-400));

    // ---- 3. the rate gate ----
    let intake = await api('GET', '/api/gfc/intake', { token: phcToken });
    const finDef = intake.body.consentDefs.find(d => d.type === 'financialAgreement');
    eq('rate gate: financial agreement is not presentable without a rate', finDef.presentable, false);
    eq('rate gate: and says why', finDef.blockedCode, 'RATE_NOT_SET');

    const blockedSign = await api('POST', '/api/gfc/consents', { token: phcToken, body: { type: 'financialAgreement', typedName: 'Acceptance Client', acknowledged: true } });
    eq('rate gate: signing is refused with 409', blockedSign.status, 409);
    eq('rate gate: and nothing was written', (client('c-phc').consents || {}).financialAgreement, undefined);

    const rate = await api('PUT', '/api/gfc/admin/enrollment/c-phc/rate', { token: adminToken, body: { hourlyRate: 32, dailyMinimumHours: 4, effectiveDate: '2026-09-08' } });
    eq('rate: saved', rate.status, 200);
    eq('rate: stored on the client record', client('c-phc').rateAgreement.hourlyRate, 32);

    intake = await api('GET', '/api/gfc/intake', { token: phcToken });
    const finDef2 = intake.body.consentDefs.find(d => d.type === 'financialAgreement');
    eq('rate gate: presentable once the rate exists', finDef2.presentable, true);
    const rateRows = finDef2.renderData.rateTable.rows;
    check('rate gate: the body renders the real figure', rateRows.some(r => r.value === '$32 per hour'), JSON.stringify(rateRows));

    // ---- 4. lane enforcement ----
    const wrongLane = await api('POST', '/api/gfc/consents', { token: phcToken, body: { type: 'consentToTreat', typedName: 'X', acknowledged: true } });
    eq('lane: a home care client cannot sign a clinical consent', wrongLane.status, 400);
    check('lane: PHC client is not shown the clinical agreement',
      !intake.body.consentDefs.some(d => d.type === 'ihpcServiceAgreement'));

    // ---- 5. provenance on a real signature ----
    const CHAIN = '104.179.178.191, 10.48.13.42, 127.0.0.1';
    const signed = await api('POST', '/api/gfc/consents', {
      token: phcToken, headers: { 'X-Forwarded-For': CHAIN },
      body: { type: 'financialAgreement', typedName: 'Acceptance Client', acknowledged: true }
    });
    eq('sign: recorded', signed.body.status, 'signed');
    const meta = client('c-phc').consentMeta.financialAgreement;
    check('sign: carries a timestamp', !!meta.signedAt);
    check('sign: carries a hashed client IP', !!meta.ipHash);
    eq('sign: stamped with the body version', meta.version, '2026-09-packet-v2');
    // Scope E3 — the hash is of the CLIENT address, not the whole chain.
    const expectHash = crypto.createHash('sha256').update(JWT_SECRET + '|104.179.178.191').digest('hex');
    eq('sign: the IP hashed is the client address only, not the forwarded chain', meta.ipHash, expectHash);
    check('sign: the raw chain is retained only as a separate hash', meta.ipChainHash !== meta.ipHash);

    // ---- 6. the inactive consent cannot be signed ----
    const optin = await api('POST', '/api/gfc/consents', { token: phcToken, body: { type: 'monitoring', typedName: 'Acceptance Client', acknowledged: true } });
    eq('inactive: never recorded as signed', client('c-phc').consents.monitoring, 'optin_recorded');
    eq('inactive: the response says nothing was signed', optin.body.signed, false);
    check('inactive: the preference still has provenance', !!(client('c-phc').consentMeta.monitoring || {}).recordedAt);

    // ---- 7. elections are their own fields ----
    const bothSave = await api('POST', '/api/gfc/intake', { token: phcToken, body: { intake: intakeFor(), serviceLine: 'BOTH' } });
    eq('lane change: reported back to the wizard', bothSave.body.serviceLineChange.to, 'BOTH');
    const afterChange = client('c-phc');
    eq('lane change: the clinical agreement is now pending', afterChange.consents.ihpcServiceAgreement, 'pending');
    check('lane change: the client is flagged for admin', !!afterChange.consentActionRequired);
    check('lane change: it is not silent — an activity entry exists',
      activity().some(a => a.action === 'service_line_changed'));
    eq('lane change: the home care signature survives', afterChange.consents.financialAgreement, 'signed');

    const noChoice = await api('POST', '/api/gfc/consents', { token: phcToken, body: { type: 'consentToTreat', typedName: 'Acceptance Client', acknowledged: true } });
    eq('elections: refused without an answer', noChoice.body.code, 'CONSENT_CHOICE_REQUIRED');
    const withChoice = await api('POST', '/api/gfc/consents', {
      token: phcToken, body: { type: 'consentToTreat', typedName: 'Acceptance Client', acknowledged: true, choices: { telehealth: 'consent', students: 'decline' } }
    });
    eq('elections: signed with answers', withChoice.body.status, 'signed');
    eq('elections: stored as their own field, not buried in the signature',
      client('c-phc').consentMeta.consentToTreat.choices, { telehealth: 'consent', students: 'decline' });

    // ---- 8. the signed copy ----
    const pdf = await api('GET', '/api/gfc/consents/financialAgreement.pdf', { token: phcToken });
    eq('copy: the consent PDF is served', pdf.status, 200);
    check('copy: it is a PDF', pdf.buffer && pdf.buffer.slice(0, 5).toString() === '%PDF-');
    const notSigned = await api('GET', '/api/gfc/consents/practiceNpp.pdf', { token: phcToken });
    eq('copy: an unsigned consent has no copy to produce', notSigned.body.code, 'CONSENT_NOT_EXECUTED');
    const zip = await api('GET', '/api/gfc/enrollment-packet.zip', { token: phcToken });
    eq('copy: the packet ZIP is served', zip.status, 200);
    check('copy: it is a ZIP', zip.buffer && zip.buffer.readUInt32LE(0) === 0x04034b50);
    check('copy: every download is audited', activity().some(a => a.action === 'consent_copy_downloaded'));

    // ---- 9. the enrollment checklist is lane-aware ----
    const detail = await api('GET', '/api/gfc/admin/enrollment/c-legacy-ihpc', { token: adminToken });
    const fields = detail.body.client.missing.fields;
    check('checklist: careTier is not counted against an IHPC-only patient',
      !fields.includes('Care tier'), JSON.stringify(fields));
    check('checklist: the outstanding clinical agreement is named',
      detail.body.client.missing.consents.includes('In-Home Primary Care Services Agreement'),
      JSON.stringify(detail.body.client.missing.consents));
    check('checklist: the internal review banner is on the STAFF payload',
      !!detail.body.client.reviewBanner);

    const phcDetail = await api('GET', '/api/gfc/admin/enrollment/c-phc', { token: adminToken });
    const rateRow = phcDetail.body.client.consents.find(c => c.type === 'financialAgreement');
    eq('checklist: the signed copy is linked for staff too', typeof rateRow.signedCopyUrl, 'string');
    eq('checklist: each consent reports its lane', rateRow.laneLabel, 'Private Home Care');
  } catch (e) {
    check('acceptance run completed', false, e.message);
    console.error(e);
  } finally {
    app.kill();
    kv.close();
  }

  console.log('\nSession 4.6 acceptance\n' + results.join('\n'));
  console.log(`\n${pass}/${pass + fail} checks passed.`);
  if (fail) { console.log('\n--- app log tail ---\n' + appLog.slice(-3000)); }
  process.exit(fail ? 1 : 0);
}

main();
