#!/usr/bin/env node
// scripts/verify_note_drafts.js — H&P drafts and the facility assignment,
// driven through the REAL Express routes over HTTP (2026-09-22).
//
//   DATA_STORE=memory MFA_ENFORCE=false JWT_SECRET=probe PORT=3212 node server.js
//   GFC_PROBE_BASE=http://localhost:3212 node scripts/verify_note_drafts.js
//
// Every assertion reads the stored value BACK rather than trusting a status
// code — the trap that cost this repo the soap_note, encounter-PUT, allergy
// and both Phase 6B defects.
//
// What this does NOT prove, stated plainly:
//   • Filing a note to the chart, and the draft being cleared by it. Filing
//     resolves an OpenEMR patient first and no EMR is reachable from a build
//     sandbox. That the visit route calls clearNoteDraft BEFORE it reports the
//     note documented is build-enforced in test/clinical_note_drafts.test.js.
//   • The facility PICKER against real OpenEMR facilities — the list route
//     reads the live EMR. The assignment refusals below need no EMR.
//   Run this against the deployment to close both halves.

const BASE = process.env.GFC_PROBE_BASE || 'http://localhost:3212';
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
const makeUser = async (token, name, role, clinicalRole, extra) => {
  const slug = String(name).toLowerCase().replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '');
  const email = `draft.${slug}.${clinicalRole || role}.${STAMP}@example.test`;
  const r = await call('POST', '/api/users', token, {
    email, password: PW, name: `${name} (TEST DATA)`, role, clinicalRole,
    ...(role === 'client' ? { practiceName: `${name} (TEST DATA)` } : {}),
    licenseLevel: { provider: 'FNP', rn: 'RN' }[clinicalRole] || undefined,
    sendWelcomeEmail: false, ...(extra || {})
  });
  return { id: r.body && (r.body.user ? r.body.user.id : r.body.id), email, status: r.status, body: r.body };
};

(async () => {
  const admin = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
  if (!admin) { console.log('LOGIN FAILED — is the app running with MFA_ENFORCE=false?'); process.exit(1); }

  // A clinical-line client to document against.
  const patient = await makeUser(admin, 'Draft Probe Patient', 'client');
  if (!patient.id) { console.log('Could not create the probe patient:', patient.body); process.exit(1); }
  // The service line has its own route on purpose — it recomputes the consent
  // set — so the probe uses it rather than writing the field directly.
  const lined = await call('PUT', `/api/gfc/admin/enrollment/${patient.id}/service-line`, admin, { serviceLine: 'IHPC' });
  if (lined.status !== 200) { console.log('Could not put the probe patient on the clinical line:', lined.status, lined.body); process.exit(1); }

  const onSite = await makeUser(admin, 'Bianca Ume', 'user', 'provider');
  const virtual = await makeUser(admin, 'Bethel Godwins', 'user', 'provider');
  const onSiteTok = await login(onSite.email, PW);
  const virtualTok = await login(virtual.email, PW);
  if (!onSiteTok || !virtualTok) { console.log('Clinician login failed'); process.exit(1); }

  // ---- 1. A draft survives, and it is documentation in progress ----------
  console.log('\n--- 1. a half-written note saves and reads back ---');
  const half = {
    chiefConcern: 'Wound check',
    subjective: 'Reports less pain overnight.',
    // ONE arm only. Filing would refuse this; a draft must not.
    vitals: { bpRightSys: '128', bpRightDia: '78' },
    systemsExam: { general: 'Alert and oriented' },
    triage: { track: 'B' }
  };
  const saved = await call('PUT', `/api/clinical/patients/${patient.id}/visit/draft`, onSiteTok, { draft: half });
  ok('a one-armed, half-finished assessment SAVES as a draft', saved.status === 200, saved.body);

  const readBack = await call('GET', `/api/clinical/patients/${patient.id}/visit/draft`, onSiteTok);
  const d = (readBack.body && readBack.body.draft) || {};
  ok('  the chief concern reads back', d.chiefConcern === 'Wound check', d.chiefConcern);
  ok('  the narrative reads back', d.subjective === 'Reports less pain overnight.', d.subjective);
  ok('  the single-arm vitals read back', d.vitals && d.vitals.bpRightSys === '128', d.vitals);
  ok('  the exam section reads back', d.systemsExam && d.systemsExam.general === 'Alert and oriented', d.systemsExam);
  ok('  the triage track reads back', d.triage && d.triage.track === 'B', d.triage);
  ok('  an updatedAt is reported so the screen can say when it saved',
    !!(readBack.body && readBack.body.updatedAt), readBack.body && readBack.body.updatedAt);

  // ---- 2. Two clinicians, one patient, one day --------------------------
  // The real scenario this was built for: an on-site assessment and a virtual
  // one running at the same time. A patient-keyed draft would lose one of them.
  console.log('\n--- 2. two clinicians on one patient do not overwrite each other ---');
  const vSaved = await call('PUT', `/api/clinical/patients/${patient.id}/visit/draft`, virtualTok, {
    draft: { chiefConcern: 'Virtual assessment', subjective: 'Telehealth review.' }
  });
  ok('the virtual clinician saves her own draft', vSaved.status === 200, vSaved.body);

  const onSiteAgain = await call('GET', `/api/clinical/patients/${patient.id}/visit/draft`, onSiteTok);
  const vRead = await call('GET', `/api/clinical/patients/${patient.id}/visit/draft`, virtualTok);
  ok('  the on-site draft is UNTOUCHED by the virtual one',
    onSiteAgain.body.draft.chiefConcern === 'Wound check', onSiteAgain.body.draft.chiefConcern);
  ok('  the virtual clinician reads HER OWN draft, not the on-site one',
    vRead.body.draft.chiefConcern === 'Virtual assessment', vRead.body.draft.chiefConcern);

  // ---- 3. Resaving replaces; it does not stack --------------------------
  console.log('\n--- 3. resaving replaces the draft rather than stacking rows ---');
  await call('PUT', `/api/clinical/patients/${patient.id}/visit/draft`, onSiteTok, {
    draft: { ...half, assessment: 'Healing, no infection.' }
  });
  const third = await call('GET', `/api/clinical/patients/${patient.id}/visit/draft`, onSiteTok);
  ok('the newest content wins', third.body.draft.assessment === 'Healing, no infection.', third.body.draft.assessment);
  ok('  and the earlier content is still there where it was not changed',
    third.body.draft.chiefConcern === 'Wound check', third.body.draft.chiefConcern);

  // ---- 4. The allow-list holds at the route -----------------------------
  console.log('\n--- 4. a key the H&P does not define never reaches the store ---');
  await call('PUT', `/api/clinical/patients/${patient.id}/visit/draft`, onSiteTok, {
    draft: { chiefConcern: 'Scoped', ssn: '123-45-6789', role: 'admin' }
  });
  const scoped = await call('GET', `/api/clinical/patients/${patient.id}/visit/draft`, onSiteTok);
  ok('an undeclared field is absent from the stored draft',
    scoped.body.draft.ssn === undefined && scoped.body.draft.role === undefined, scoped.body.draft);
  ok('  while the declared field survives', scoped.body.draft.chiefConcern === 'Scoped');

  const empty = await call('PUT', `/api/clinical/patients/${patient.id}/visit/draft`, onSiteTok, { draft: {} });
  ok('an empty draft is refused with its own code', empty.status === 400 && empty.body.code === 'DRAFT_EMPTY', empty.body);

  // ---- 5. Discard --------------------------------------------------------
  console.log('\n--- 5. discarding removes only your own draft ---');
  const disc = await call('DELETE', `/api/clinical/patients/${patient.id}/visit/draft`, onSiteTok);
  ok('the on-site clinician discards hers', disc.status === 200 && disc.body.discarded === true, disc.body);
  const goneUs = await call('GET', `/api/clinical/patients/${patient.id}/visit/draft`, onSiteTok);
  ok('  and it is gone', goneUs.body.draft === null, goneUs.body.draft);
  const stillThem = await call('GET', `/api/clinical/patients/${patient.id}/visit/draft`, virtualTok);
  ok('  while the OTHER clinician\'s draft is untouched',
    stillThem.body.draft && stillThem.body.draft.chiefConcern === 'Virtual assessment', stillThem.body.draft);
  const again = await call('DELETE', `/api/clinical/patients/${patient.id}/visit/draft`, onSiteTok);
  ok('discarding twice is a no-op, not an error', again.status === 200 && again.body.discarded === false, again.body);

  // ---- 6. Who may touch a draft at all ----------------------------------
  console.log('\n--- 6. a role that cannot document cannot draft ---');
  const cm = await makeUser(admin, 'Casey Reed', 'caseManager', 'readOnly');
  const cmTok = await login(cm.email, PW);
  if (cmTok) {
    const cmRead = await call('GET', `/api/clinical/patients/${patient.id}/visit/draft`, cmTok);
    ok('a readOnly case manager is refused the draft read', cmRead.status === 403, cmRead.status);
    const cmWrite = await call('PUT', `/api/clinical/patients/${patient.id}/visit/draft`, cmTok, { draft: { plan: 'x' } });
    ok('  and the draft write', cmWrite.status === 403, cmWrite.status);
  } else { ok('case manager login (skipped — could not sign in)', false); }

  // ---- 7. Facility assignment is admin's, and it says what it blocks -----
  console.log('\n--- 7. facility assignment is admin-only ---');
  const clinFac = await call('PUT', `/api/clinical/patients/${patient.id}/facility`, onSiteTok, { facilityId: '5' });
  ok('a clinician cannot assign a place of service', clinFac.status === 403, clinFac.status);
  const badFac = await call('PUT', `/api/clinical/patients/${patient.id}/facility`, admin, { facilityId: 'not-a-number' });
  ok('a non-numeric facility id is refused with its own code',
    badFac.status === 400 && badFac.body.code === 'BAD_FACILITY', badFac.body);

  console.log(`\n${pass}/${pass + fail} assertions passed${fail ? ` — ${fail} FAILED` : ''}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('Probe crashed:', e.message); process.exit(1); });
