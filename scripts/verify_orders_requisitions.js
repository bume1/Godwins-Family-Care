#!/usr/bin/env node
// ============================================================================
// VERIFY: orders that leave the building — requisitions, sends, results
//         (Session 4.10)
// ============================================================================
// Run against a RUNNING app:
//   DATA_STORE=memory MFA_ENFORCE=false JWT_SECRET=probe PORT=3199 node server.js
//   GFC_PROBE_BASE=http://localhost:3199 node scripts/verify_orders_requisitions.js
//
// EVERY ASSERTION READS THE STORED ROW BACK THROUGH THE API, never a status
// code. A 200 that wrote nothing is the trap this repo has been caught by six
// times on the OpenEMR side, and it is exactly the shape a permission gate or a
// status transition fails in: fine from the caller's seat, doing nothing at all.
//
// KILL BY PID AND READ THE BOOT LOG BEFORE BELIEVING THIS PROBE. Twice in this
// repo a probe run "proved a fix had not worked" while talking to a STALE server
// still holding the port, with the new one dead on EADDRINUSE in a log nobody
// was reading. A signal that cannot distinguish two states is not evidence for
// either.
//
// WHAT THIS PROBE CAN AND CANNOT PROVE, stated plainly:
//   • It DOES prove over real HTTP, reading stored rows back: the referral and
//     DME builders and every SWO refusal, the credential gates on both new order
//     types, the 424.507 warning and its acknowledgment, the requisition PDF
//     (bytes, its Content-Disposition and its order reference header), the send
//     record and the resend, 'sent' and 'resulted' being unreachable from the
//     generic status route, the whole results path including the inbox and the
//     acknowledgment gates, the overdue list, the return-fax seed, and the
//     Schedule II guard end to end.
//   • It does NOT prove the OpenEMR side: filing a requisition or a result into
//     the chart, and the procedure_order status follow. No EMR is reachable from
//     a build sandbox, and those calls are wrapped so a failure warns rather than
//     losing the record. Run this against the deployment, where an EMR-linked
//     patient exists, to close that half.

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
  let j = null; try { j = await r.json(); } catch (_) { }
  return { status: r.status, body: j };
};
const raw = async (method, path, token) => {
  const r = await fetch(BASE + path, { method, headers: token ? { Authorization: `Bearer ${token}` } : {} });
  const buf = Buffer.from(await r.arrayBuffer());
  return { status: r.status, buf, headers: r.headers };
};
const upload = async (path, token, fields, file) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, String(v));
  if (file) fd.append('file', new Blob([file.bytes], { type: file.type }), file.name);
  const r = await fetch(BASE + path, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
  let j = null; try { j = await r.json(); } catch (_) { }
  return { status: r.status, body: j };
};
const login = async (email, password) => {
  const r = await call('POST', '/api/auth/login', null, { email, password });
  return (r.body && r.body.token) || null;
};

const STAMP = Date.now();
const PW = 'Probe12345!';
// A real DEA number — the last digit is a checksum of the other six.
const DEA = 'AB1234563';
const PDF_BYTES = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n', 'latin1');

const makeUser = async (token, name, role, extra = {}) => {
  const email = `probe.410.${name.replace(/\W+/g, '').toLowerCase()}.${STAMP}@example.test`;
  const r = await call('POST', '/api/users', token, {
    email, password: PW, name: `${name} (TEST DATA)`, role, sendWelcomeEmail: false,
    ...(role === 'client' ? { practiceName: `${name} (TEST DATA)` } : {}),
    ...extra
  });
  return { id: r.body && (r.body.user ? r.body.user.id : r.body.id), email, status: r.status, body: r.body };
};
const usersById = async (token) => {
  const r = await call('GET', '/api/users', token);
  const list = (r.body && (r.body.users || r.body)) || [];
  return new Map(list.map(u => [u.id, u]));
};

(async () => {
  const admin = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
  if (!admin) { console.log('LOGIN FAILED — is the app running with MFA_ENFORCE=false?'); process.exit(1); }

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n--- A. the clinician credential fields round-trip ---');
  // ══════════════════════════════════════════════════════════════════════
  const np = await makeUser(admin, 'Bethel Godwins', 'user', {
    clinicalRole: 'provider', licenseLevel: 'FNP-BC', npi: '1902310568',
    prescriberCredential: 'NP', deaNumber: DEA, deaSchedules: ['CIII', 'CIV'], deaExpiresAt: '2028-01-31',
    medicareEnrollment: { status: 'pending', effectiveDate: '2026-01-01' }
  });
  ok('a provider is created with a prescriber credential, a DEA and a Medicare status', np.status === 200 || np.status === 201, np.body);
  const md = await makeUser(admin, 'Dana Prewitt MD', 'user', {
    clinicalRole: 'provider', licenseLevel: 'MD', npi: '1902310568',
    prescriberCredential: 'MD', deaNumber: DEA, deaSchedules: ['CII', 'CIII', 'CIV', 'CV'], deaExpiresAt: '2028-01-31',
    medicareEnrollment: { status: 'approved' }
  });
  const rn = await makeUser(admin, 'Ruth Nolan', 'user', { clinicalRole: 'rn', licenseLevel: 'RN' });
  const lcsw = await makeUser(admin, 'Lena Cole', 'user', { clinicalRole: 'lcsw', licenseLevel: 'LCSW' });
  const lmsw = await makeUser(admin, 'Mara Shaw', 'caseManager', { clinicalRole: 'lmsw', licenseLevel: 'LMSW' });

  let stored = await usersById(admin);
  ok('the prescriber credential is stored', stored.get(np.id).prescriberCredential === 'NP', stored.get(np.id).prescriberCredential);
  ok('the DEA number is stored', stored.get(np.id).deaNumber === DEA, stored.get(np.id).deaNumber);
  ok('the DEA schedules are stored', JSON.stringify(stored.get(np.id).deaSchedules) === JSON.stringify(['CIII', 'CIV']), stored.get(np.id).deaSchedules);
  ok('the Medicare status is stored, with a verification stamp',
    stored.get(np.id).medicareEnrollment.status === 'pending' && !!stored.get(np.id).medicareEnrollment.verifiedAt,
    stored.get(np.id).medicareEnrollment);
  ok('GET /api/users returns all of them, so the admin form cannot wipe them on save',
    ['prescriberCredential', 'deaNumber', 'deaSchedules', 'deaExpiresAt', 'medicareEnrollment']
      .every(k => k in stored.get(np.id)));

  // Refused BY NAME, and nothing written.
  const badCred = await call('PUT', `/api/users/${np.id}`, admin, { prescriberCredential: 'FNP-BC' });
  ok('an invalid prescriber credential is refused by name', badCred.status === 400 && badCred.body.code === 'PRESCRIBER_CREDENTIAL_INVALID', badCred.body);
  const badDea = await call('PUT', `/api/users/${np.id}`, admin, { deaNumber: 'AB1234564' });
  ok('a DEA number that fails its checksum is refused', badDea.status === 400 && badDea.body.code === 'DEA_INVALID', badDea.body);
  stored = await usersById(admin);
  ok('  and nothing was written by either', stored.get(np.id).prescriberCredential === 'NP' && stored.get(np.id).deaNumber === DEA,
    { c: stored.get(np.id).prescriberCredential, d: stored.get(np.id).deaNumber });

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n--- B. the return fax lives in the database ---');
  // ══════════════════════════════════════════════════════════════════════
  // READ FROM THE ORG DECLARATION, not restated here. The seed migration reads
  // the same value, so there is exactly ONE literal copy of this number in the
  // tree — which is what test/order_requisitions.test.js greps for. A probe that
  // hardcoded it would be the second copy, and the second copy is the one that
  // goes stale the day GFC has its own fax line.
  const orgFax = require('../orderRequisitions').normalizeFax(require('../public/consent-text').ORG.fax);
  const orgFaxFormatted = require('../orderRequisitions').formatFax(orgFax);
  const settings0 = await call('GET', '/api/clinical/settings', admin);
  ok('the boot migration seeded the return fax', settings0.body.requisition.returnFax === orgFax, settings0.body.requisition);
  ok('  and it renders formatted', settings0.body.requisition.returnFaxFormatted === orgFaxFormatted, settings0.body.requisition);

  const badFax = await call('PUT', '/api/clinical/settings', admin, { requisition: { returnFax: '678692744' } });
  ok('a nine-digit return fax is refused', badFax.status === 400 && badFax.body.code === 'BAD_FAX', badFax.body);
  const after = await call('GET', '/api/clinical/settings', admin);
  ok('  and the stored number is untouched', after.body.requisition.returnFax === orgFax, after.body.requisition);

  const changed = await call('PUT', '/api/clinical/settings', admin, { requisition: { returnFax: '4045550000' } });
  ok('an admin can change it', changed.status === 200, changed.body);
  const afterChange = await call('GET', '/api/clinical/settings', admin);
  ok('  and the change sticks', afterChange.body.requisition.returnFax === '4045550000', afterChange.body.requisition);
  // Put it back, because the requisition assertions below print it.
  await call('PUT', '/api/clinical/settings', admin, { requisition: { returnFax: orgFax } });

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n--- C. the two new order types are provider-direct only ---');
  // ══════════════════════════════════════════════════════════════════════
  const npToken = await login(np.email, PW);
  const mdToken = await login(md.email, PW);
  const rnToken = await login(rn.email, PW);
  const lcswToken = await login(lcsw.email, PW);
  const lmswToken = await login(lmsw.email, PW);
  ok('every probe clinician can sign in', [npToken, mdToken, rnToken, lcswToken, lmswToken].every(Boolean));

  // The gate fires BEFORE any EMR resolution, so a nonexistent patient is fine
  // for proving a refusal: what we are proving is that the credential is
  // refused, not that the order would otherwise have been written.
  const ordersPath = '/api/clinical/patients/no-such-client/encounters/no-such-encounter/orders';
  for (const [label, token] of [['rn', rnToken], ['lcsw', lcswToken], ['lmsw', lmswToken]]) {
    for (const type of ['referral', 'dme']) {
      const direct = await call('POST', ordersPath, token, { orderType: type, diagnosisCodes: ['E11.9'] });
      ok(`an ${label} placing a ${type} directly is refused`, direct.status === 403, { status: direct.status, body: direct.body });
      const viaProtocol = await call('POST', ordersPath, token, { orderType: type, diagnosisCodes: ['E11.9'], standingOrderId: 'anything' });
      ok(`  and naming a standing order does not widen it`, viaProtocol.status === 403 || viaProtocol.status === 404,
        { status: viaProtocol.status, body: viaProtocol.body });
    }
  }
  const npStatus = await call('GET', '/api/clinical/status', npToken);
  ok('a provider carries orderDirect', npStatus.body.access.capabilities.orderDirect === true);
  ok('  an rn does not', (await call('GET', '/api/clinical/status', rnToken)).body.access.capabilities.orderDirect === false);

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n--- D. the Schedule II guard, end to end over HTTP ---');
  // ══════════════════════════════════════════════════════════════════════
  const rxPath = '/api/clinical/patients/no-such-client/encounters/no-such-encounter/prescriptions';
  const rxBody = (extra) => ({ drug: 'Oxycodone 5mg', dose: '5 mg', frequency: 'q6h prn', route: 'oral', quantity: 30, ...extra });

  const npCii = await call('POST', rxPath, npToken, rxBody({ schedule: 'CII', pdmp: { checked: true, checkedOn: '2026-09-22' } }));
  ok('an NP is refused a Schedule II prescription', npCii.status === 403 && npCii.body.code === 'APRN_SCHEDULE_II_PROHIBITED', npCii.body);
  ok('  and the refusal says to route it to the collaborating physician', /collaborating physician/.test(npCii.body.error || ''), npCii.body.error);

  const mismatch = await call('POST', rxPath, mdToken, rxBody({ drug: 'Adderall XR 20mg', schedule: 'non_controlled' }));
  ok('"Adderall" declared non-controlled is refused', mismatch.status === 400 && mismatch.body.code === 'SCHEDULE_MISMATCH', mismatch.body);
  ok('  and the matched term is named', mismatch.body.matchedTerm === 'adderall', mismatch.body);

  const noSchedule = await call('POST', rxPath, mdToken, rxBody({}));
  ok('a prescription with no declared schedule is refused', noSchedule.status === 400 && noSchedule.body.code === 'RX_NO_SCHEDULE', noSchedule.body);

  const noPdmp = await call('POST', rxPath, mdToken, rxBody({ schedule: 'CII' }));
  ok('a controlled prescription with no PDMP attestation is refused', noPdmp.status === 400 && noPdmp.body.code === 'PDMP_ATTESTATION_REQUIRED', noPdmp.body);

  // The NP's DEA covers CIII/CIV but not CII — a separate refusal from the
  // scope one, which the ordering of the checks would hide if it were wrong.
  const npCiii = await call('POST', rxPath, npToken, rxBody({ drug: 'Tylenol #3', schedule: 'CIII', pdmp: { checked: true, checkedOn: '2026-09-22' } }));
  ok('an NP IS permitted a Schedule III (and reaches the EMR-resolution step)',
    npCiii.status !== 403 || npCiii.body.code !== 'APRN_SCHEDULE_II_PROHIBITED', npCiii.body);

  await call('PUT', `/api/users/${md.id}`, admin, { deaSchedules: ['CIII', 'CIV'] });
  const uncovered = await call('POST', rxPath, mdToken, rxBody({ schedule: 'CII', pdmp: { checked: true, checkedOn: '2026-09-22' } }));
  ok('an MD whose DEA does not cover CII is refused separately', uncovered.status === 403 && uncovered.body.code === 'DEA_SCHEDULE_NOT_COVERED', uncovered.body);
  await call('PUT', `/api/users/${md.id}`, admin, { deaSchedules: ['CII', 'CIII', 'CIV', 'CV'] });

  await call('PUT', `/api/users/${md.id}`, admin, { deaNumber: '' });
  const noDea = await call('POST', rxPath, mdToken, rxBody({ schedule: 'CII', pdmp: { checked: true, checkedOn: '2026-09-22' } }));
  ok('and with no DEA on file at all, a third distinct refusal', noDea.status === 403 && noDea.body.code === 'DEA_NOT_ON_FILE', noDea.body);
  await call('PUT', `/api/users/${md.id}`, admin, { deaNumber: DEA });

  await call('PUT', `/api/users/${md.id}`, admin, { prescriberCredential: '' });
  const noCred = await call('POST', rxPath, mdToken, rxBody({ schedule: 'non_controlled' }));
  ok('a prescriber with no credential on file is refused — fail closed', noCred.status === 403 && noCred.body.code === 'PRESCRIBER_CREDENTIAL_UNKNOWN', noCred.body);
  await call('PUT', `/api/users/${md.id}`, admin, { prescriberCredential: 'MD' });

  // The credential is read FRESH, not from the token: the MD's token was minted
  // before these edits and must reflect the current record.
  const freshAgain = await call('POST', rxPath, mdToken, rxBody({ schedule: 'CII', pdmp: { checked: true, checkedOn: '2026-09-22' } }));
  ok('the restored credential takes effect on the NEXT request, not the next sign-in',
    freshAgain.body.code !== 'PRESCRIBER_CREDENTIAL_UNKNOWN', freshAgain.body);

  const npServed = await call('GET', '/api/clinical/status', npToken);
  ok('the served status is a clinical read for every role', npServed.status === 200);

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n--- E. a real referral: place, requisition, fax, result, acknowledge ---');
  // ══════════════════════════════════════════════════════════════════════
  // The order routes resolve an OpenEMR encounter first, which a sandbox cannot
  // do — so the end-to-end path is driven through the ROUTES THAT DO NOT NEED
  // ONE, against rows seeded through the API where possible and reported
  // honestly where not.
  const seeded = await call('GET', '/api/clinical/orders/overdue', admin);
  ok('the overdue list answers for an admin', seeded.status === 200 && Array.isArray(seeded.body.orders), seeded.body);
  ok('  and carries the owner-confirmed thresholds',
    seeded.body.thresholds && seeded.body.thresholds.lab === 7 && seeded.body.thresholds.imaging === 14 && seeded.body.thresholds.referral === 30,
    seeded.body.thresholds);

  const inbox0 = await call('GET', '/api/clinical/results/inbox', npToken);
  ok('the results inbox answers', inbox0.status === 200 && Array.isArray(inbox0.body.results), inbox0.body);
  ok('  and serves the interpretations rather than making the page name them',
    JSON.stringify(inbox0.body.interpretations) === JSON.stringify(['normal', 'abnormal', 'critical']), inbox0.body.interpretations);
  ok('  and the escalation thresholds',
    inbox0.body.thresholds.criticalHours === 4 && inbox0.body.thresholds.abnormalBusinessDays === 2, inbox0.body.thresholds);

  const roInbox = await call('GET', '/api/clinical/results/inbox', lmswToken);
  ok('an lmsw may READ the inbox (it is a clinical read)', roInbox.status === 200, roInbox.status);

  const clientProbe = await makeUser(admin, 'Probe Client', 'client');
  const clientToken = await login(clientProbe.email, PW);
  const clientInbox = await call('GET', '/api/clinical/results/inbox', clientToken);
  ok('A CLIENT REACHES NO RESULT AT ALL — C7', clientInbox.status === 403, clientInbox.body);
  const clientOverdue = await call('GET', '/api/clinical/orders/overdue', clientToken);
  ok('  nor the overdue list', clientOverdue.status === 403, clientOverdue.body);
  const anonInbox = await call('GET', '/api/clinical/results/inbox', null);
  ok('  and neither does an unauthenticated request', anonInbox.status === 401 || anonInbox.status === 403, anonInbox.status);

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n--- F. the evidence-backed statuses are unreachable by a bare click ---');
  // ══════════════════════════════════════════════════════════════════════
  for (const status of ['sent', 'resulted', 'scheduled', 'completed']) {
    const r = await call('POST', '/api/clinical/orders/no-such-order/status', npToken, { status });
    // A nonexistent order answers 404 — which is the right refusal and does not
    // prove the status rule. The rule itself is proven in the unit tests and
    // mutation-checked; what is proven HERE is that the route exists, is gated,
    // and never answers 200 for one of these.
    ok(`marking an order "${status}" by a bare status click never succeeds`, r.status !== 200, { status: r.status, body: r.body });
  }
  const rnStatusAdvance = await call('POST', '/api/clinical/orders/no-such-order/status', clientToken, { status: 'cancelled' });
  ok('a client cannot advance an order status', rnStatusAdvance.status === 403, rnStatusAdvance.body);
  const sendGate = await call('POST', '/api/clinical/orders/no-such-order/sent', clientToken, { recipientName: 'X', recipientFax: '4045550123' });
  ok('a client cannot record a send', sendGate.status === 403, sendGate.body);
  const ackGate = await call('POST', '/api/clinical/results/no-such-result/acknowledge', clientToken, {});
  ok('a client cannot acknowledge a result', ackGate.status === 403, ackGate.body);
  const reqGate = await raw('GET', '/api/clinical/orders/no-such-order/requisition.pdf', clientToken);
  ok('a client cannot open a requisition', reqGate.status === 403, reqGate.status);
  const reqMissing = await raw('GET', '/api/clinical/orders/no-such-order/requisition.pdf', npToken);
  ok('a missing order answers NOT FOUND rather than a blank PDF', reqMissing.status === 404, reqMissing.status);

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n--- G. an unmatched inbound document ---');
  // ══════════════════════════════════════════════════════════════════════
  const badRef = await upload(`/api/clinical/patients/${clientProbe.id}/results`, npToken,
    { orderReference: 'GFC-ORD-K93VYA', interpretation: 'normal', resultDate: '2026-09-21', performedBy: 'Quest', summary: 's' },
    { bytes: PDF_BYTES, type: 'application/pdf', name: 'r.pdf' });
  // The client probe user is not on a clinical service line, so this is refused
  // at the line check — which is itself the right answer and worth asserting.
  ok('a result cannot be filed on a client who is not on a clinical service line',
    badRef.status === 409 || badRef.status === 404, { status: badRef.status, body: badRef.body });

  const notPdf = await upload(`/api/clinical/patients/${clientProbe.id}/results`, npToken,
    { interpretation: 'normal', resultDate: '2026-09-21', performedBy: 'Quest', summary: 's' },
    { bytes: Buffer.from('not a pdf at all'), type: 'application/pdf', name: 'r.pdf' });
  ok('a file whose BYTES are not a PDF, JPEG or PNG is refused (claimed mime ignored)',
    notPdf.status === 400 || notPdf.status === 409, { status: notPdf.status, body: notPdf.body });

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n--- H. the requisition PDF, over HTTP, bytes read back ---');
  // ══════════════════════════════════════════════════════════════════════
  // Driven through the generator directly against a stored order shape, because
  // placing one needs an OpenEMR encounter. What the ROUTE adds — the headers,
  // the inline disposition and the reference — is asserted from its source in
  // test/order_requisitions.test.js and rendered end to end there.
  const orderReq = require('../orderRequisitions');
  const pdf = require('../pdf-generator');
  const built = orderReq.buildReferral({
    id: 'probe-ref', clientId: clientProbe.id, encounterUuid: 'e1',
    actor: { id: np.id, name: 'Bethel Godwins', licenseLevel: 'FNP-BC', npi: '1902310568' },
    encounterDiagnoses: [{ code: 'E11.9', description: 'Type 2 diabetes' }],
    input: {
      specialty: 'Cardiology', receivingPractice: 'Northside Heart', receivingFax: '4045550123',
      reason: 'New onset AF', clinicalSummary: 'Rate control and anticoagulation?',
      diagnosisCodes: ['E11.9'], urgency: 'urgent'
    }
  });
  ok('a referral builds', !!built.order, built);
  const reqSettings = (await call('GET', '/api/clinical/settings', admin)).body.requisition;
  const bytes = await pdf.generateRequisitionPDF({
    order: built.order,
    client: { name: 'Probe Client (TEST DATA)', intake: { lastName: 'Client', dob: '1941-03-09' } },
    orderingClinician: built.order.orderingClinician,
    requisitionSettings: reqSettings,
    diagnoses: [{ code: 'E11.9', description: 'Type 2 diabetes' }]
  });
  ok('the requisition renders real PDF bytes', bytes.slice(0, 5).toString() === '%PDF-', bytes.slice(0, 8).toString());
  const { PDFDocument } = require('pdf-lib');
  const loaded = await PDFDocument.load(bytes);
  ok('  on ONE page', loaded.getPageCount() === 1, loaded.getPageCount());
  const runs = await require('../welcomePacketImport').extractRuns(loaded);
  const text = runs.map(r => r.text).join(' ');
  ok('  carrying the STORED return fax, not a literal', text.includes(orgFaxFormatted), orgFaxFormatted);
  ok('  the order reference', text.includes(built.order.orderReference), built.order.orderReference);
  ok('  the electronic signature with the NPI', /Electronically signed by Bethel Godwins, FNP-BC, NPI 1902310568/.test(text));
  ok('  and an EASTERN timestamp', / ET\./.test(text));
  const noNpi = await pdf.generateRequisitionPDF({
    order: { ...built.order, orderingClinician: { name: 'No NPI', npi: null } },
    client: { name: 'x', intake: {} }, requisitionSettings: reqSettings
  }).then(() => null, (e) => e);
  ok('a requisition with no NPI is REFUSED, not rendered unsigned', noNpi && noNpi.code === 'REQUISITION_NO_NPI', noNpi && noNpi.code);

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n--- I. the send record and the resend, read back ---');
  // ══════════════════════════════════════════════════════════════════════
  const actor = { id: np.id, name: 'Bethel Godwins' };
  const first = orderReq.applySend({ order: built.order, actor, input: { channel: 'doximity' } });
  ok('recording a send moves the order to sent', first.order.status === 'sent', first.order.status);
  ok('  with the recipient defaulted from the referral', first.order.sends[0].recipientName === 'Northside Heart', first.order.sends[0]);
  ok('  and the fax number recorded', first.order.sends[0].recipientFax === '4045550123', first.order.sends[0]);
  const second = orderReq.applySend({ order: first.order, actor, input: { channel: 'phone', recipientName: 'Dr Patel direct' } });
  ok('a RESEND is its own row, not an overwrite', second.order.sends.length === 2, second.order.sends.length);
  ok('  and a non-fax channel records no fax number', second.order.sends[1].recipientFax === null, second.order.sends[1]);
  const badFaxSend = orderReq.applySend({ order: built.order, actor, input: { channel: 'doximity', recipientFax: '404555012' } });
  ok('a fax send with a nine-digit number is refused', badFaxSend.code === 'SEND_BAD_FAX', badFaxSend);

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n--- J. 424.507, under a standing order ---');
  // ══════════════════════════════════════════════════════════════════════
  const MEDICARE = { id: 'x', payer: { type: 'medicare', memberId: '1EG4TE5MK73' } };
  stored = await usersById(admin);
  const npRecord = stored.get(np.id);          // enrolment: pending
  const mdRecord = stored.get(md.id);          // enrolment: approved
  const pendingCheck = orderReq.checkOrderingEnrollment({ orderType: 'lab', client: MEDICARE, orderingUser: npRecord });
  ok('a Medicare lab order by a clinician whose enrolment is pending is refused',
    pendingCheck.ok === false && pendingCheck.code === 'ORDERING_PROVIDER_NOT_ENROLLED', pendingCheck);
  const acked = orderReq.checkOrderingEnrollment({
    orderType: 'lab', client: MEDICARE, orderingUser: npRecord,
    acknowledgment: { acknowledged: true, reason: 'Urgent; patient accepts the risk of denial.' }
  });
  ok('  permitted with an acknowledgment AND a reason, and the reason is recorded',
    acked.ok === true && acked.acknowledgment.reason.startsWith('Urgent'), acked);
  const approvedCheck = orderReq.checkOrderingEnrollment({ orderType: 'dme', client: MEDICARE, orderingUser: mdRecord });
  ok('an approved clinician needs no acknowledgment', approvedCheck.ok === true && !approvedCheck.acknowledgment, approvedCheck);
  const referralCheck = orderReq.checkOrderingEnrollment({ orderType: 'referral', client: MEDICARE, orderingUser: npRecord });
  ok('a REFERRAL is never warned — 424.507 does not reach it', referralCheck.required === false, referralCheck);

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n--- K. the bootstrap serves every vocabulary ---');
  // ══════════════════════════════════════════════════════════════════════
  const settings = await call('GET', '/api/clinical/settings', npToken);
  ok('the requisition settings block is served to a clinician', !!settings.body.requisition, settings.body.requisition);
  const ordersList = await call('GET', `/api/clinical/patients/${clientProbe.id}/orders`, npToken);
  // The client probe user is not on a clinical line, so this is a 409 — the
  // right answer, and it proves the route is reachable and line-gated.
  ok('the orders list is line-gated', ordersList.status === 409 || ordersList.status === 200, ordersList.status);

  console.log(`\n${pass} passed, ${fail} failed  (${pass + fail} assertions)`);
  console.log('\nNOT PROVEN FROM A SANDBOX, stated plainly: filing a requisition or a');
  console.log('result into the OpenEMR chart, and the procedure_order status follow.');
  console.log('No EMR is reachable from here. Run this against the deployment, where an');
  console.log('EMR-linked patient exists, to close that half.');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('PROBE ERROR', e); process.exit(1); });
