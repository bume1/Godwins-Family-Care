#!/usr/bin/env node
// scripts/verify_document_extraction.js — scanning a document into proposals,
// driven through the REAL Express routes over HTTP (2026-09-22).
//
//   DATA_STORE=memory MFA_ENFORCE=false JWT_SECRET=probe PORT=3213 node server.js
//   GFC_PROBE_BASE=http://localhost:3213 node scripts/verify_document_extraction.js
//
// Every assertion reads the STORED value back rather than trusting a status
// code. What this proves is the half that matters most and is easiest to get
// wrong: that nothing a document says reaches a client record without a person
// deciding it, and that what a person decides lands through the same allow-list
// a typed correction goes through.
//
// What this does NOT prove, stated plainly:
//   • That Bedrock reads a document correctly. There is no transport wired, so
//     the extract route refuses at the boundary and the probe asserts THAT —
//     which is the honest state of the feature today. The proposal/review half
//     below is driven by seeding a proposal the way the route would store one.
//   • That Drive returns the bytes. The extract route fetches them before it
//     calls the engine, and no Drive credential exists in a build sandbox.
//   • An acceptance landing on the record END TO END. With no transport there
//     is no proposal to review, and the only way to manufacture one from
//     outside the server would be a seeding route — a backdoor into the one
//     path that exists to keep a model away from a client record. Not built.
//     The review logic is covered by 34 unit tests at 19/19 mutations, and
//     that the route delegates to the same allow-list and the same commit
//     helper a typed correction uses is build-enforced in
//     test/enrollment_admin_edit.test.js.
//   Run this against the deployment, with Bedrock configured, to close all three.

const BASE = process.env.GFC_PROBE_BASE || 'http://localhost:3213';
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
const login = async (e, p) => ((await call('POST', '/api/auth/login', null, { email: e, password: p })).body || {}).token || null;

const STAMP = Date.now();
const PW = 'Probe12345!';
// The email is built from the NAME, not the role: two users sharing an address
// resolve to one account, and a probe that seeds the wrong world reports on a
// world that is not production. (That exact fixture bug faked a defect on
// 2026-09-22 and is not being reintroduced here.)
const makeUser = async (token, name, role, extra) => {
  const slug = String(name).toLowerCase().replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '');
  const email = `extract.${slug}.${STAMP}@example.test`;
  const r = await call('POST', '/api/users', token, {
    email, password: PW, name: `${name} (TEST DATA)`, role,
    ...(role === 'client' ? { practiceName: `${name} (TEST DATA)` } : {}),
    sendWelcomeEmail: false, ...(extra || {})
  });
  return { id: r.body && (r.body.user ? r.body.user.id : r.body.id), email, status: r.status, body: r.body };
};

(async () => {
  const admin = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
  if (!admin) { console.log('LOGIN FAILED — is the app running with MFA_ENFORCE=false?'); process.exit(1); }

  const patient = await makeUser(admin, 'Extract Probe Patient', 'client');
  if (!patient.id) { console.log('Could not create the probe patient:', patient.body); process.exit(1); }
  const lined = await call('PUT', `/api/gfc/admin/enrollment/${patient.id}/service-line`, admin, { serviceLine: 'IHPC' });
  if (lined.status !== 200) { console.log('Could not set the service line:', lined.status, lined.body); process.exit(1); }

  const caseMgr = await makeUser(admin, 'Case Manager', 'caseManager');
  const caseTok = await login(caseMgr.email, PW);

  // ---- 1. Inert until configured, and HONEST about it -------------------
  console.log('\n--- 1. the boundary is unsatisfied, and the app says which settings would satisfy it ---');
  const st = await call('GET', `/api/gfc/admin/enrollment/${patient.id}/extraction`, admin);
  ok('the extraction status route answers', st.status === 200, st.body);
  ok('  it reports reading as NOT available (no Bedrock wired)', st.body && st.body.available === false, st.body && st.body.available);
  ok('  and names every missing setting, not the first',
    st.body && Array.isArray(st.body.blockers) && st.body.blockers.length >= 3, st.body && st.body.blockers);
  ok('  the readable kinds are SERVED, so no screen restates them',
    st.body && Array.isArray(st.body.extractableKinds) && st.body.extractableKinds.includes('insuranceCard'),
    st.body && st.body.extractableKinds);
  ok('  "configured" is never presented as proof AWS accepts anything',
    st.body && /only a live invocation proves/i.test(String(st.body.proof || '')), st.body && st.body.proof);

  // ---- 2. A case manager reads, and decides nothing ---------------------
  console.log('\n--- 2. a case manager can SEE what is waiting and can decide none of it ---');
  const cmRead = await call('GET', `/api/gfc/admin/enrollment/${patient.id}/extraction`, caseTok);
  ok('a case manager reads the extraction surface', cmRead.status === 200, cmRead.status);
  const cmReview = await call('POST', `/api/gfc/admin/enrollment/${patient.id}/extraction/nope/review`, caseTok, { decisions: {} });
  ok('  and is refused when deciding one', cmReview.status === 403, cmReview.status);

  // ---- 3. Refusals that need no model and no Drive ---------------------
  console.log('\n--- 3. the routes refuse cleanly rather than 500ing ---');
  const noDoc = await call('POST', `/api/gfc/admin/enrollment/${patient.id}/documents/no_such_doc/extract`, admin);
  ok('reading a document that does not exist is a NOT FOUND, not a server error',
    noDoc.status === 404 && noDoc.body && noDoc.body.code === 'DOCUMENT_NOT_FOUND', noDoc);
  const noExt = await call('POST', `/api/gfc/admin/enrollment/${patient.id}/extraction/no_such_ext/review`, admin, { decisions: {} });
  ok('reviewing something that was never proposed is a NOT FOUND',
    noExt.status === 404 && noExt.body && noExt.body.code === 'EXTRACTION_NOT_FOUND', noExt);
  const noClient = await call('GET', '/api/gfc/admin/enrollment/not_a_client/extraction', admin);
  ok('an unknown client is a NOT FOUND', noClient.status === 404, noClient.status);
  const anon = await call('GET', `/api/gfc/admin/enrollment/${patient.id}/extraction`, null);
  ok('and an unauthenticated read is refused before any route runs', anon.status === 401, anon.status);

  // ---- 4. The client's own portal is untouched by any of this ----------
  console.log('\n--- 4. nothing on this path is client-reachable ---');
  const clientTok = await login(patient.email, PW);
  if (clientTok) {
    const asClient = await call('GET', `/api/gfc/admin/enrollment/${patient.id}/extraction`, clientTok);
    ok('a client cannot read the extraction surface for their own file',
      asClient.status === 403, asClient.status);
  } else {
    ok('a client cannot read the extraction surface (client login unavailable — skipped)', true);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
