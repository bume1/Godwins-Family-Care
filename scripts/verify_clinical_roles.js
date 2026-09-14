#!/usr/bin/env node
// ============================================================================
// VERIFY: credential-scoped clinical roles and standing orders (Session 4.8)
// ============================================================================
// Run against a RUNNING app:
//   DATA_STORE=memory MFA_ENFORCE=false JWT_SECRET=probe PORT=3199 node server.js
//   GFC_PROBE_BASE=http://localhost:3199 node scripts/verify_clinical_roles.js
//
// Every assertion reads the STORED ROW back through the API, never a status
// code. A 200 that wrote nothing is the trap this repo has been caught by six
// times on the OpenEMR side, and a permission gate is exactly the kind of thing
// that looks fine from the caller's seat while doing nothing at all.
//
// WHAT THIS PROBE CAN AND CANNOT PROVE, stated plainly:
//   • It DOES prove, over real HTTP: the role round-trip, the derived
//     hasClinicalAccess, the served capability matrix, the prescribing refusal
//     (a middleware gate, so it fires before any EMR call), the whole standing
//     order lifecycle, the executable filter, and the credential ceiling as the
//     API reports it.
//   • It does NOT prove order execution or encounter signing end to end: both
//     resolve an OpenEMR patient first, and no EMR is reachable from a build
//     sandbox. Those paths are PURE functions (standingOrders.authorizeExecution,
//     clinicalRoles.evaluateEncounterSignature) and are covered exhaustively and
//     mutation-checked in test/clinical_roles.test.js. Run the probe against the
//     deployment, where an EMR-linked patient exists, to close that half.

const BASE = process.env.GFC_PROBE_BASE || 'http://localhost:3199';
const ADMIN_EMAIL = process.env.GFC_PROBE_ADMIN || 'admin@godwinsfamilycarellc.com';
const ADMIN_PASSWORD = process.env.GFC_PROBE_PASSWORD || 'gfcforever2026';

let pass = 0, fail = 0;
const ok = (label, cond, detail) => {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail !== undefined ? `\n         ${JSON.stringify(detail)}` : ''}`); }
};
const call = async (method, path, token, body) => {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  let j = null; try { j = await r.json(); } catch (_) {}
  return { status: r.status, body: j };
};
const login = async (email, password) => {
  const r = await call('POST', '/api/auth/login', null, { email, password });
  return (r.body && r.body.token) || null;
};

const STAMP = Date.now();
const PW = 'Probe12345!';
const makeUser = async (token, name, role, clinicalRole) => {
  const email = `probe.${clinicalRole || 'none'}.${STAMP}@example.test`;
  const r = await call('POST', '/api/users', token, {
    email, password: PW, name: `${name} (TEST DATA)`, role, clinicalRole,
    // A client user needs a practice name — it generates the portal slug, and
    // the create is refused without one.
    ...(role === 'client' ? { practiceName: `${name} (TEST DATA)` } : {}),
    npi: clinicalRole === 'provider' ? '1902310568' : undefined,
    licenseLevel: { provider: 'FNP', rn: 'RN', lcsw: 'LCSW', lmsw: 'LMSW' }[clinicalRole] || undefined,
    sendWelcomeEmail: false
  });
  const id = r.body && (r.body.user ? r.body.user.id : r.body.id);
  return { id, email, status: r.status, body: r.body };
};

(async () => {
  const admin = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
  if (!admin) { console.log('LOGIN FAILED — is the app running with MFA_ENFORCE=false?'); process.exit(1); }

  // ---- 1. The role is stored, and the boolean follows it -----------------
  console.log('\n--- 1. clinicalRole is stored, hasClinicalAccess is derived ---');
  const rn = await makeUser(admin, 'Ruth Nolan', 'user', 'rn');
  const provider = await makeUser(admin, 'Bethel Godwins', 'user', 'provider');
  const lcsw = await makeUser(admin, 'Lena Cole', 'user', 'lcsw');
  const lmsw = await makeUser(admin, 'Mara Shaw', 'caseManager', 'lmsw');
  const readOnly = await makeUser(admin, 'Casey Reed', 'caseManager', 'readOnly');

  const usersNow = await call('GET', '/api/users', admin);
  const all = usersNow.body.users || usersNow.body || [];
  const stored = (id) => all.find(u => u.id === id) || {};
  ok('an rn is stored as clinicalRole rn', stored(rn.id).clinicalRole === 'rn', stored(rn.id).clinicalRole);
  ok('  and hasClinicalAccess is derived TRUE from it', stored(rn.id).hasClinicalAccess === true, stored(rn.id).hasClinicalAccess);
  ok('a readOnly role is stored', stored(readOnly.id).clinicalRole === 'readOnly', stored(readOnly.id).clinicalRole);
  ok('  and derives hasClinicalAccess FALSE — it is chart access without a licence',
    stored(readOnly.id).hasClinicalAccess === false, stored(readOnly.id).hasClinicalAccess);
  ok('GET /api/users returns clinicalRole, so the form cannot wipe it on save',
    all.every(u => 'clinicalRole' in u));

  // An unrecognised role is REFUSED, never silently dropped: dropping it leaves
  // an admin believing they narrowed someone when they did not.
  const bad = await call('PUT', `/api/users/${rn.id}`, admin, { clinicalRole: 'wizard' });
  ok('an unrecognised clinicalRole is refused', bad.status === 400 && bad.body.code === 'CLINICAL_ROLE_INVALID', bad.body);
  const afterBad = await call('GET', '/api/users', admin);
  const rnAfter = (afterBad.body.users || afterBad.body || []).find(u => u.id === rn.id);
  ok('  and nothing was written', rnAfter.clinicalRole === 'rn', rnAfter.clinicalRole);

  // ---- 2. The capability matrix the API enforces is what it serves -------
  console.log('\n--- 2. the served capability matrix ---');
  const rnToken = await login(rn.email, PW);
  const providerToken = await login(provider.email, PW);
  const lcswToken = await login(lcsw.email, PW);
  const lmswToken = await login(lmsw.email, PW);
  const roToken = await login(readOnly.email, PW);
  ok('every probe user can sign in', [rnToken, providerToken, lcswToken, lmswToken, roToken].every(Boolean));

  const statusFor = async (t) => (await call('GET', '/api/clinical/status', t)).body;
  const rnStatus = await statusFor(rnToken);
  const provStatus = await statusFor(providerToken);
  const roStatus = await statusFor(roToken);
  ok('an rn is reported as clinicalRole rn', rnStatus.access.clinicalRole === 'rn', rnStatus.access);
  ok('  with prescribe FALSE', rnStatus.access.capabilities.prescribe === false);
  ok('  with orderDirect FALSE', rnStatus.access.capabilities.orderDirect === false);
  ok('  with orderStanding TRUE', rnStatus.access.capabilities.orderStanding === true);
  ok('  with selectServiceCodes FALSE', rnStatus.access.capabilities.selectServiceCodes === false);
  ok('  and nursingNote TRUE — an RN documents her own visit', rnStatus.access.capabilities.nursingNote === true);
  ok('a provider carries all four', ['prescribe', 'orderDirect', 'selectServiceCodes', 'signBillableEncounter']
    .every(c => provStatus.access.capabilities[c] === true), provStatus.access.capabilities);
  ok('a readOnly role reads and writes nothing', roStatus.access.canWrite === false && roStatus.access.capabilities.chartRead === true, roStatus.access);
  ok('the credential ceiling is reported per role: rn gets all four order types',
    (rnStatus.access.credentialCeiling || []).length === 4, rnStatus.access.credentialCeiling);
  const lmswStatus = await statusFor(lmswToken);
  ok('  and an lmsw gets screening only',
    JSON.stringify(lmswStatus.access.credentialCeiling) === JSON.stringify(['screening']), lmswStatus.access.credentialCeiling);

  // ---- 3. Prescribing — the gate fires before any EMR call ---------------
  console.log('\n--- 3. prescribing is a provider\'s ---');
  const rxPath = '/api/clinical/patients/no-such-client/encounters/no-such-encounter/prescriptions';
  const rnRx = await call('POST', rxPath, rnToken, { drug: 'Lisinopril', dose: '10mg' });
  ok('an rn calling the prescriptions endpoint gets 403', rnRx.status === 403, rnRx.status);
  ok('  with a CREDENTIAL code, not a generic refusal', rnRx.body.code === 'CLINICAL_CREDENTIAL', rnRx.body);
  ok('  naming the credential the work needs', /provider/i.test(rnRx.body.error || ''), rnRx.body.error);
  const lmswRx = await call('POST', rxPath, lmswToken, {});
  ok('an lmsw is refused too', lmswRx.status === 403 && lmswRx.body.code === 'CLINICAL_CREDENTIAL', lmswRx.body);
  const provRx = await call('POST', rxPath, providerToken, {});
  ok('a provider passes the CREDENTIAL gate and fails on the patient instead',
    provRx.status !== 403 || provRx.body.code !== 'CLINICAL_CREDENTIAL', provRx.body);

  // ---- 4. Standing orders — the whole document lifecycle -----------------
  console.log('\n--- 4. standing orders: author, activate, execute-scope, revise, expire ---');
  const future = new Date(Date.now() + 365 * 86400000).toISOString();
  const SIG = 'data:image/png;base64,iVBORw0KGgo=';
  const protocol = {
    title: `Depression screening (TEST DATA ${STAMP})`,
    permittedOrderTypes: ['screening'], permittedTests: ['PHQ-9', 'GAD-7'],
    permittedExecutorRoles: ['lmsw', 'lcsw'], indications: ['F32.9'],
    expiresAt: future, status: 'active', signatureImage: SIG
  };

  const rnAuthor = await call('POST', '/api/clinical/standing-orders', rnToken, protocol);
  ok('only a provider may author a standing order (rn refused)',
    rnAuthor.status === 403 && rnAuthor.body.code === 'CLINICAL_CREDENTIAL', rnAuthor.body);

  const noExpiry = await call('POST', '/api/clinical/standing-orders', providerToken, { ...protocol, expiresAt: undefined });
  ok('a protocol with no expiry is refused at creation',
    noExpiry.status === 400 && noExpiry.body.code === 'STANDING_ORDER_NO_EXPIRY', noExpiry.body);
  const noExecutors = await call('POST', '/api/clinical/standing-orders', providerToken, { ...protocol, permittedExecutorRoles: [] });
  ok('a protocol naming no executor role is refused',
    noExecutors.status === 400 && noExecutors.body.code === 'STANDING_ORDER_NO_EXECUTORS', noExecutors.body);
  const unsigned = await call('POST', '/api/clinical/standing-orders', providerToken, { ...protocol, signatureImage: null });
  ok('an unsigned protocol cannot be activated',
    unsigned.status === 400 && unsigned.body.code === 'STANDING_ORDER_UNSIGNED', unsigned.body);

  const made = await call('POST', '/api/clinical/standing-orders', providerToken, protocol);
  ok('a provider authors and activates one', made.status === 200 && made.body.standingOrder, made.body);
  const soId = made.body.standingOrder && made.body.standingOrder.id;
  ok('  stored at version 1', made.body.standingOrder.version === 1);
  ok('  with the authorizing provider recorded',
    made.body.standingOrder.authorizingProvider.userId === provider.id, made.body.standingOrder.authorizingProvider);
  ok('  and the signature IMAGE never leaves the server',
    !('signatureImage' in made.body.standingOrder) && made.body.standingOrder.signed === true,
    Object.keys(made.body.standingOrder));

  // Read it back — the stored row, not the create response.
  const readBack = await call('GET', `/api/clinical/standing-orders/${soId}`, providerToken);
  ok('the stored protocol reads back with its permitted tests',
    JSON.stringify((readBack.body.standingOrder || {}).permittedTests) === JSON.stringify(['PHQ-9', 'GAD-7']),
    readBack.body.standingOrder && readBack.body.standingOrder.permittedTests);
  ok('  and reads as active', (readBack.body.standingOrder || {}).effectiveStatus === 'active');
  ok('  with no signature image on the read either', !('signatureImage' in (readBack.body.standingOrder || {})));

  // A mis-authored protocol is FLAGGED at authoring — still refused at
  // execution, because the ceiling is the control and a warning is not.
  const misAuthored = await call('POST', '/api/clinical/standing-orders', providerToken, {
    ...protocol, title: `CBC protocol (TEST DATA ${STAMP})`, permittedOrderTypes: ['lab'],
    permittedTests: ['CBC'], permittedExecutorRoles: ['lmsw'], indications: ['E11.9']
  });
  ok('a protocol naming an lmsw for a LAB is created but FLAGGED',
    misAuthored.status === 200 && (misAuthored.body.warnings || []).length > 0, misAuthored.body.warnings);
  ok('  and the flag says a signed protocol cannot extend a licence',
    /cannot extend a licence/i.test((misAuthored.body.warnings || []).join(' ')), misAuthored.body.warnings);

  // ---- 5. "What may I actually act on" ------------------------------------
  console.log('\n--- 5. the executable filter and the credential ceiling ---');
  const lmswList = await call('GET', '/api/clinical/standing-orders?executable=true', lmswToken);
  const rows = (lmswList.body && lmswList.body.standingOrders) || [];
  const screening = rows.find(o => o.id === soId);
  const labProto = rows.find(o => o.id === (misAuthored.body.standingOrder || {}).id);
  ok('the screening protocol is executable by the lmsw', screening && screening.executableByMe === true, screening && screening.notExecutableReason);
  ok('  offering exactly the screening type', screening && JSON.stringify(screening.executableOrderTypes) === JSON.stringify(['screening']),
    screening && screening.executableOrderTypes);
  ok('THE MIS-AUTHORED LAB PROTOCOL IS LISTED BUT NOT EXECUTABLE', labProto && labProto.executableByMe === false, labProto);
  ok('  and it says why — the licence, not the protocol',
    labProto && /licence permits screening/i.test(labProto.notExecutableReason || ''), labProto && labProto.notExecutableReason);
  ok('  it is LISTED rather than hidden: a hidden row reads as "no protocol exists"', !!labProto);

  const rnList = await call('GET', '/api/clinical/standing-orders?executable=true', rnToken);
  const rnScreening = ((rnList.body && rnList.body.standingOrders) || []).find(o => o.id === soId);
  ok('an rn whose licence covers screening is still refused a protocol that does not name them',
    rnScreening && rnScreening.executableByMe === false, rnScreening && rnScreening.notExecutableReason);
  ok('  and the reason is the protocol, not the ceiling',
    rnScreening && /authorises lmsw, lcsw/i.test(rnScreening.notExecutableReason || ''), rnScreening && rnScreening.notExecutableReason);

  // ---- 6. Versions are immutable -----------------------------------------
  console.log('\n--- 6. a revision is a new row; v1 is retired, never rewritten ---');
  const revised = await call('POST', `/api/clinical/standing-orders/${soId}/revise`, providerToken, {
    ...protocol, permittedTests: ['PHQ-9']   // GAD-7 dropped in v2
  });
  ok('the revision is version 2', revised.body.standingOrder && revised.body.standingOrder.version === 2, revised.body);
  const v2Id = revised.body.standingOrder && revised.body.standingOrder.id;
  ok('  a NEW row, not the old id', v2Id && v2Id !== soId);
  const v1After = await call('GET', `/api/clinical/standing-orders/${soId}`, providerToken);
  ok('v1 still exists and still lists GAD-7 — the row was never rewritten',
    JSON.stringify(v1After.body.standingOrder.permittedTests) === JSON.stringify(['PHQ-9', 'GAD-7']),
    v1After.body.standingOrder.permittedTests);
  ok('  and is retired, so nothing new executes under it', v1After.body.standingOrder.status === 'retired', v1After.body.standingOrder.status);
  ok('  pointing at what superseded it', v1After.body.standingOrder.supersededByVersionId === v2Id);
  const lineage = await call('GET', `/api/clinical/standing-orders/${v2Id}`, providerToken);
  ok('the lineage lists both versions', (lineage.body.versions || []).length === 2, lineage.body.versions);

  // ---- 7. Retiring ---------------------------------------------------------
  console.log('\n--- 7. status changes ---');
  const rnRetire = await call('POST', `/api/clinical/standing-orders/${v2Id}/status`, rnToken, { status: 'retired' });
  ok('an rn cannot retire a protocol', rnRetire.status === 403, rnRetire.body);
  const retired = await call('POST', `/api/clinical/standing-orders/${v2Id}/status`, providerToken, { status: 'retired' });
  ok('a provider can', retired.status === 200 && retired.body.standingOrder.status === 'retired', retired.body);
  const afterRetire = await call('GET', '/api/clinical/standing-orders?executable=true', lmswToken);
  ok('  and a retired protocol drops out of the executable list',
    !((afterRetire.body.standingOrders || []).some(o => o.id === v2Id)));

  // ---- 8. The 4.3 split did not regress ----------------------------------
  console.log('\n--- 8. the case-manager read/write split is unchanged ---');
  const roRead = await call('GET', '/api/clinical/patients', roToken);
  ok('a readOnly case manager still READS the patient list', roRead.status === 200, roRead.status);
  const roWrite = await call('POST', '/api/clinical/patients/nobody/problems', roToken, { title: 'x' });
  ok('  and is refused a write with the 4.3 code', roWrite.status === 403 && roWrite.body.code === 'CLINICAL_READ_ONLY', roWrite.body);
  const clientProbe = await makeUser(admin, 'Probe Client', 'client', undefined);
  const clientToken = await login(clientProbe.email, PW);
  ok('  the client probe user can sign in (so the next check is about the ROLE)', !!clientToken);
  const clientRead = await call('GET', '/api/clinical/patients', clientToken);
  ok('a client reaches no chart at all', clientRead.status === 403 && clientRead.body.code === 'CLINICAL_ONLY', clientRead.body);
  const anon = await call('GET', '/api/clinical/patients', null);
  ok('and an unauthenticated request never reaches one either', anon.status === 401 || anon.status === 403, anon.status);

  console.log(`\n${pass} passed, ${fail} failed  (${pass + fail} assertions)`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('PROBE ERROR', e); process.exit(1); });
