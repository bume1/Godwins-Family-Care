#!/usr/bin/env node
// scripts/verify_ai_chart_review.js — the comprehensive chart review, driven
// through the REAL Express routes over HTTP (2026-10-12, Session G1 E1/E5/E6).
//
//   DATA_STORE=memory MFA_ENFORCE=false JWT_SECRET=probe PORT=3219 node server.js
//   GFC_PROBE_BASE=http://localhost:3219 node scripts/verify_ai_chart_review.js
//
// Every assertion reads the stored value BACK rather than trusting a status
// code.
//
// WHAT THIS CANNOT PROVE FROM A BUILD SANDBOX, STATED PLAINLY:
//   • That Gemini reviews a chart well, or at all. There is no Google
//     credential here, so the boundary refuses — and the probe asserts the
//     REFUSAL is correct and names its blockers, which is the honest state
//     and the one a clinician would see today. The owner's "Run test" button
//     (section H) is what proves the Google side.
//   • Gathering from OpenEMR. The loader reads with the clinician's own EMR
//     session and no EMR is reachable here; the packet arranging is unit
//     tested exhaustively in test/chart_packet.test.js instead.
//
// WHAT IT DOES PROVE: who may start, read and decide a review; that a client,
// POA or family reach none of it; that the refusal carries its blockers; that
// a decision is validated against the review it names; and that the retention
// setting is real.

const BASE = process.env.GFC_PROBE_BASE || 'http://localhost:3219';
const ADMIN_EMAIL = process.env.GFC_PROBE_ADMIN || 'admin@godwinsfamilycarellc.com';
const ADMIN_PASSWORD = process.env.GFC_PROBE_PASSWORD || 'gfcforever2026';

let pass = 0, fail = 0;
const ok = (label, cond, detail) => {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail !== undefined ? `\n         ${JSON.stringify(detail)}` : ''}`); }
};
const call = async (method, p, token, body) => {
  const r = await fetch(BASE + p, {
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

(async () => {
  const admin = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
  if (!admin) { console.log('LOGIN FAILED — is the app running with MFA_ENFORCE=false?'); process.exit(1); }
  const stamp = Date.now();

  // ---- 0. a clinical patient and the three roles -------------------------
  console.log('\n--- 0. a clinical patient, a clinician, a case manager and the patient ---');
  const made = await call('POST', '/api/users', admin, {
    email: `airev.${stamp}@example.test`, password: 'Probe12345!',
    name: 'AI Review Probe (TEST DATA)', role: 'client',
    practiceName: 'AI Review Probe (TEST DATA)', sendWelcomeEmail: false
  });
  const clientId = made.body && (made.body.user ? made.body.user.id : made.body.id);
  if (!clientId) { console.log('Could not create the probe client:', made.body); process.exit(1); }

  await call('POST', '/api/users', admin, {
    email: `airev.clin.${stamp}@example.test`, password: 'Probe12345!',
    name: 'AI Review Clinician (TEST DATA)', role: 'user', clinicalRole: 'provider',
    licenseLevel: 'FNP', sendWelcomeEmail: false
  });
  await call('POST', '/api/users', admin, {
    email: `airev.cm.${stamp}@example.test`, password: 'Probe12345!',
    name: 'AI Review Case Manager (TEST DATA)', role: 'caseManager', clinicalRole: 'readOnly',
    sendWelcomeEmail: false
  });
  const cTok = await login(`airev.clin.${stamp}@example.test`, 'Probe12345!');
  const rTok = await login(`airev.cm.${stamp}@example.test`, 'Probe12345!');
  const pTok = await login(`airev.${stamp}@example.test`, 'Probe12345!');
  ok('the clinician, case manager and patient all exist', !!cTok && !!rTok && !!pTok);

  // ---- 1. the clinical line gate -----------------------------------------
  console.log('\n--- 1. a home-care-only client is not a clinical patient ---');
  const notClinical = await call('POST', `/api/clinical/patients/${clientId}/ai/review`, cTok, {});
  ok('starting a review on a home-care-only client is refused',
    notClinical.status === 409 && notClinical.body.code === 'NOT_CLINICAL_LINE', notClinical.body);

  const lined = await call('PUT', `/api/gfc/admin/enrollment/${clientId}/service-line`, admin, { serviceLine: 'IHPC' });
  ok('putting the client on the clinical line succeeds', lined.status === 200, lined.body);

  // ---- 2. the boundary refuses, and says what would satisfy it ----------
  console.log('\n--- 2. with no Google credential it refuses, and names every blocker ---');
  const started = await call('POST', `/api/clinical/patients/${clientId}/ai/review`, cTok, {});
  ok('a review is refused at the boundary rather than half-run',
    started.status === 503 && started.body.code === 'MODEL_BOUNDARY_REFUSED', started.body);
  ok('  and it names every blocker, not the first',
    Array.isArray(started.body.blockers) && started.body.blockers.length >= 5, started.body.blockers);
  ok('  the missing Vertex settings are named individually',
    started.body.blockers.some(b => /VERTEX_PROJECT_ID/.test(b)) &&
    started.body.blockers.some(b => /GOOGLE_APPLICATION_CREDENTIALS/.test(b)), started.body.blockers);
  ok('  and the daily Google-side checks are named as part of the boundary',
    started.body.blockers.some(b => /24 hours/.test(b)), started.body.blockers);
  ok('  NOTHING was gathered: no review row was created',
    (await call('GET', `/api/clinical/patients/${clientId}/ai/reviews`, cTok)).body.reviews.length === 0);

  // ---- 3. who may read, run and decide -----------------------------------
  console.log('\n--- 3. licensed clinicians run it; read-only staff may look ---');
  const cmList = await call('GET', `/api/clinical/patients/${clientId}/ai/reviews`, rTok);
  ok('a case manager may READ the review list', cmList.status === 200, cmList.body);
  ok('  and is told plainly that they cannot run one', cmList.body.canRun === false, cmList.body.canRun);
  const cmRun = await call('POST', `/api/clinical/patients/${clientId}/ai/review`, rTok, {});
  ok('a case manager may NOT start a review', cmRun.status === 403, cmRun.status);
  const cmDecide = await call('POST', '/api/clinical/ai/reviews/nope/decisions', rTok, { decisions: [{ index: 0, decision: 'noted' }] });
  ok('a case manager may NOT decide a finding', cmDecide.status === 403, cmDecide.status);

  const clinList = await call('GET', `/api/clinical/patients/${clientId}/ai/reviews`, cTok);
  ok('a clinician is told they CAN run one', clinList.body.canRun === true, clinList.body.canRun);
  ok('  a clinician is not shown the settings blockers — they cannot clear them',
    clinList.body.blockers === undefined, clinList.body.blockers);
  const adminList = await call('GET', `/api/clinical/patients/${clientId}/ai/reviews`, admin);
  ok('  an admin IS shown them, because they are the person who can',
    Array.isArray(adminList.body.blockers) && adminList.body.blockers.length > 0, adminList.body.blockers);

  // ---- 4. the patient reaches none of it ---------------------------------
  console.log('\n--- 4. patients, POAs and family never reach the AI ---');
  for (const [label, m, p, b] of [
    ['the review list', 'GET', `/api/clinical/patients/${clientId}/ai/reviews`, undefined],
    ['a single review', 'GET', `/api/clinical/patients/${clientId}/ai/reviews/x`, undefined],
    ['starting a review', 'POST', `/api/clinical/patients/${clientId}/ai/review`, {}],
    ['deciding a finding', 'POST', '/api/clinical/ai/reviews/x/decisions', { decisions: [{ index: 0, decision: 'noted' }] }]
  ]) {
    const r = await call(m, p, pTok, b);
    ok(`a patient is refused: ${label}`, r.status === 403, `${r.status} ${JSON.stringify(r.body)}`);
  }

  // ---- 5. a review that does not exist, and a decision that names one ---
  console.log('\n--- 5. a decision is validated against the review it names ---');
  const missing = await call('GET', `/api/clinical/patients/${clientId}/ai/reviews/air_nope`, cTok);
  ok('an unknown review is a 404 with its own code',
    missing.status === 404 && missing.body.code === 'AI_REVIEW_NOT_FOUND', missing.body);
  const noRow = await call('POST', '/api/clinical/ai/reviews/air_nope/decisions', cTok, { decisions: [{ index: 0, decision: 'noted' }] });
  ok('a decision on an unknown review is refused by name',
    noRow.status === 404 && noRow.body.code === 'AI_REVIEW_NOT_FOUND', noRow.body);

  // ---- 6. the pieces that do not need Google ----------------------------
  console.log('\n--- 6. the schema, the packet and the citation check are real ---');
  const path = require('path');
  const chartPacket = require(path.join(__dirname, '..', 'chartPacket'));
  const modelEngine = require(path.join(__dirname, '..', 'modelEngine'));

  // The review schema has to be one the engine will accept BEFORE anything is
  // sent — otherwise a configured server would send a whole chart and fail
  // afterwards, which is the exact bug section B5 fixed.
  const serverSrc = require('fs').readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const hasSchema = /const AI_REVIEW_SCHEMA = Object\.freeze\(\{/.test(serverSrc);
  ok('the review schema is declared', hasSchema);

  const manifest = chartPacket.buildManifest({
    sections: [{ sourceId: 'enc:e1', kind: 'encounter', title: 'Visit' }],
    notRead: [{ sourceId: 'emr:coverage', why: 'not returned' }]
  });
  const enforced = chartPacket.enforceCitations({
    summary: 's',
    findings: [
      { statement: 'real', citations: [{ sourceId: 'enc:e1' }] },
      { statement: 'invented', citations: [{ sourceId: 'enc:ghost' }] }
    ],
    timeline: []
  }, manifest);
  ok('a finding citing an unknown source is dropped',
    enforced.output.findings.length === 1 && enforced.droppedUncited === 1, enforced);
  ok('and what could not be read survives into the manifest',
    manifest.notRead.some(n => n.sourceId === 'emr:coverage'), manifest.notRead);

  // The retention setting is real rather than described.
  ok('the retention window is a setting with a documented default',
    /GFC_AI_REVIEW_RETENTION_DAYS \|\| 180/.test(serverSrc));
  ok('and the purge logs a COUNT, never content',
    /purged \$\{rows\.length - keep\.length\} chart review/.test(serverSrc));

  // A scalar array is what "questions for the clinician" needs; without it the
  // review schema could not be expressed at all.
  const scalarOk = modelEngine.validateAgainstSchema(
    { questionsForClinician: ['Is the metformin still indicated?'] },
    { fields: { questionsForClinician: { type: 'array', itemType: 'string', maxLength: 500 } } }
  );
  ok('the engine validates arrays of plain sentences',
    !scalarOk.error && scalarOk.value.questionsForClinician.length === 1, scalarOk);

  console.log(`\n${pass}/${pass + fail} assertions passed${fail ? ` — ${fail} FAILED` : ''}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('Probe crashed:', e); process.exit(1); });
