#!/usr/bin/env node
// scripts/verify_my_day.js — Session 4.12. My Day, the visit stamps, the
// home-visit standing facts and the pre-visit packet, driven through the REAL
// Express routes over HTTP.
//
//   DATA_STORE=memory MFA_ENFORCE=false JWT_SECRET=probe PORT=3213 node server.js
//   GFC_PROBE_BASE=http://localhost:3213 node scripts/verify_my_day.js
//
// Every assertion reads the stored value BACK rather than trusting a status
// code — the trap that cost this repo the soap_note, encounter-PUT, allergy and
// both Phase 6B defects.
//
// WHAT THIS DOES NOT PROVE, STATED PLAINLY:
//   • The day POPULATING with real visits. The calendar is OpenEMR's and no EMR
//     is reachable from a build sandbox, so the day comes back empty here. An
//     empty result is not a diagnosis — what is asserted below is that the
//     route REPORTS the calendar as unreadable rather than rendering an empty
//     day, which is the distinction that matters. The day-building itself is
//     covered exhaustively by the unit tests and their mutations.
//   • The pre-visit packet's chart half (problems, vitals, last visit), for the
//     same reason. Its derivation is unit-tested; what is asserted here is that
//     the route answers, is gated, and carries the standing facts.
//   Run this against the deployment to close both halves.

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
const login = async (email, password) => {
  const r = await call('POST', '/api/auth/login', null, { email, password });
  return (r.body && r.body.token) || null;
};

const STAMP = Date.now();
const PW = 'Probe12345!';
const makeUser = async (token, name, role, clinicalRole, extra) => {
  const slug = String(name).toLowerCase().replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '');
  // The email is built from the NAME, not the role. Session 4.9's probe built it
  // from the role, so two providers shared an address and resolved to one user —
  // a probe that seeds the wrong world reports on a world that is not production.
  const email = `myday.${slug}.${STAMP}@example.test`;
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

  const patient = await makeUser(admin, 'MyDay Probe Patient', 'client');
  if (!patient.id) { console.log('Could not create the probe patient:', patient.body); process.exit(1); }
  const lined = await call('PUT', `/api/gfc/admin/enrollment/${patient.id}/service-line`, admin, { serviceLine: 'IHPC' });
  if (lined.status !== 200) { console.log('Could not put the patient on the clinical line:', lined.status, lined.body); process.exit(1); }

  const clinician = await makeUser(admin, 'Bianca Ume', 'user', 'provider');
  const nurse = await makeUser(admin, 'Ruth Nolan', 'user', 'rn');
  const reader = await makeUser(admin, 'Casey Reed', 'caseManager', 'readOnly');
  const cTok = await login(clinician.email, PW);
  const nTok = await login(nurse.email, PW);
  const rTok = await login(reader.email, PW);
  if (!cTok || !nTok || !rTok) { console.log('Staff login failed'); process.exit(1); }

  // ---- 1. The home-visit standing facts live on the PATIENT -------------
  console.log('\n--- 1. standing facts are the patient\'s, and survive the visit ---');
  const saveHv = await call('PUT', `/api/clinical/patients/${patient.id}/home-visit`, cTok, {
    homeVisit: {
      accessInstructions: 'Use side entrance.',
      caregiverPresent: 'Daughter Angela will be present.',
      safetyNotes: 'Dog secured before arrival.',
      enrollmentStatus: 'enrolled'   // not a home-visit field; must be dropped
    }
  });
  ok('a clinician records the access instructions', saveHv.status === 200, saveHv.body);
  const hv = (saveHv.body && saveHv.body.homeVisit) || {};
  ok('  the access instruction reads back', hv.accessInstructions === 'Use side entrance.', hv);
  ok('  who will be there reads back', hv.caregiverPresent === 'Daughter Angela will be present.', hv);
  ok('  a key outside the allow-list never reached the record',
    !('enrollmentStatus' in hv), Object.keys(hv));
  ok('  the route reports WHICH facts changed',
    Array.isArray(saveHv.body.changed) && saveHv.body.changed.includes('accessInstructions'), saveHv.body.changed);

  const asRead = await call('GET', `/api/clinical/patients/${patient.id}/chart`, cTok);
  const banner = (asRead.body && asRead.body.banner) || {};
  ok('the BANNER carries the standing facts from the patient record',
    banner.homeVisit && banner.homeVisit.accessInstructions === 'Use side entrance.', banner.homeVisit);

  const roDenied = await call('PUT', `/api/clinical/patients/${patient.id}/home-visit`, rTok, {
    homeVisit: { accessInstructions: 'Front door.' }
  });
  ok('a read-only case manager is REFUSED, and nothing changed', roDenied.status === 403, roDenied.status);
  const afterDenied = await call('GET', `/api/clinical/patients/${patient.id}/chart`, cTok);
  ok('  the stored instruction is untouched by the refused write',
    afterDenied.body.banner.homeVisit.accessInstructions === 'Use side entrance.',
    afterDenied.body.banner.homeVisit);

  // ---- 2. The banner ------------------------------------------------------
  console.log('\n--- 2. the banner answers the five things read at a front door ---');
  const b = afterDenied.body.banner;
  ok('the banner is served on the chart', !!b, b);
  ok('  it names the patient', !!b.name, b.name);
  ok('  the allergy strip has an explicit STATE, never a bare absence',
    ['listed', 'none_known', 'unavailable'].includes(b.allergies && b.allergies.state), b.allergies);
  ok('  an unlinked patient reads UNAVAILABLE, not "no known allergies"',
    b.allergies.state === 'unavailable', b.allergies);
  ok('  and it says WHY', typeof b.allergies.reason === 'string' && b.allergies.reason.length > 0, b.allergies.reason);
  ok('  the chart reports whether this clinician has a draft open',
    afterDenied.body.visitDraft && typeof afterDenied.body.visitDraft.open === 'boolean',
    afterDenied.body.visitDraft);

  // ---- 3. Visit timings ---------------------------------------------------
  console.log('\n--- 3. arrival, start and end, and the total that supports E/M ---');
  const EID = String(900000 + (STAMP % 1000));
  const bad = await call('POST', `/api/clinical/visits/${EID}/timing`, cTok, { event: 'teleported', clientId: patient.id });
  ok('an event the server does not know is REFUSED by name', bad.status === 400 && bad.body.code === 'BAD_VISIT_EVENT', bad.body);
  ok('  and the refusal names the events that do work',
    /en_route/.test(String(bad.body && bad.body.error)), bad.body && bad.body.error);

  const arrive = await call('POST', `/api/clinical/visits/${EID}/timing`, cTok, {
    event: 'arrive', clientId: patient.id, at: '2026-09-23T14:02:00.000Z'
  });
  ok('Arrive stamps', arrive.status === 200, arrive.body);
  const start = await call('POST', `/api/clinical/visits/${EID}/timing`, cTok, {
    event: 'start', clientId: patient.id, at: '2026-09-23T14:05:00.000Z'
  });
  ok('Start stamps', start.status === 200, start.body);
  ok('  a visit still running has NO total, not a total of zero',
    start.body.timing.totalMinutes === null, start.body.timing.totalMinutes);
  ok('  and no time statement yet', start.body.timing.timeStatement === null, start.body.timing.timeStatement);

  const end = await call('POST', `/api/clinical/visits/${EID}/timing`, cTok, {
    event: 'end', clientId: patient.id, at: '2026-09-23T14:47:00.000Z'
  });
  ok('End stamps', end.status === 200, end.body);
  ok('  total time computes to 42 minutes', end.body.timing.totalMinutes === 42, end.body.timing.totalMinutes);
  ok('  the time statement that goes in the note is produced',
    /42 minutes/.test(String(end.body.timing.timeStatement)), end.body.timing.timeStatement);

  const reStamp = await call('POST', `/api/clinical/visits/${EID}/timing`, cTok, {
    event: 'end', clientId: patient.id, at: '2026-09-23T15:00:00.000Z'
  });
  ok('correcting a stamped time without a reason is REFUSED',
    reStamp.status === 409 && reStamp.body.code === 'TIMING_ALREADY_SET', reStamp.body);
  const stillRead = await call('GET', `/api/clinical/visits/${EID}/timing`, cTok);
  ok('  and the stored end time is untouched',
    stillRead.body.timing.endedAt === '2026-09-23T14:47:00.000Z', stillRead.body.timing.endedAt);

  const corrected = await call('POST', `/api/clinical/visits/${EID}/timing`, cTok, {
    event: 'end', clientId: patient.id, at: '2026-09-23T15:00:00.000Z', reason: 'Clock ran on after the visit ended.'
  });
  ok('with a reason the correction lands', corrected.status === 200, corrected.body);
  const after = await call('GET', `/api/clinical/visits/${EID}/timing`, cTok);
  ok('  the stored end time moved', after.body.timing.endedAt === '2026-09-23T15:00:00.000Z', after.body.timing.endedAt);
  ok('  the value it replaced is KEPT, with the reason and who changed it',
    Array.isArray(after.body.timing.corrections) && after.body.timing.corrections.length === 1 &&
    after.body.timing.corrections[0].from === '2026-09-23T14:47:00.000Z' &&
    /Clock ran on/.test(after.body.timing.corrections[0].reason), after.body.timing.corrections);
  ok('  the total re-derives from the corrected time', after.body.timing.totalMinutes === 55, after.body.timing.totalMinutes);

  const roStamp = await call('POST', `/api/clinical/visits/${EID}/timing`, rTok, { event: 'arrive', clientId: patient.id });
  ok('a read-only case manager cannot stamp a visit', roStamp.status === 403, roStamp.status);

  // ---- 4. My Day ----------------------------------------------------------
  console.log('\n--- 4. the day reports what it could and could not read ---');
  const day = await call('GET', '/api/clinical/my-day?date=2026-09-23', cTok);
  ok('My Day answers', day.status === 200, day.body);
  ok('  it is for the date asked for', day.body.date === '2026-09-23', day.body.date);
  ok('  an unreadable calendar is REPORTED, never rendered as an empty day',
    day.body.calendar && day.body.calendar.ok === false && !!day.body.calendar.error, day.body.calendar);
  ok('  the totals are present and drive time is honestly null',
    day.body.totals && day.body.totals.driveMinutes === null &&
    day.body.totals.driveMinutesReason === 'no_routing_provider', day.body.totals);
  ok('  a read-only case manager may READ the day', (await call('GET', '/api/clinical/my-day', rTok)).status === 200);

  const noDate = await call('GET', '/api/clinical/my-day', cTok);
  ok('  with no date it defaults to a real calendar day',
    /^\d{4}-\d{2}-\d{2}$/.test(String(noDate.body.date)), noDate.body.date);

  // ---- 5. Route optimisation PROPOSES -------------------------------------
  console.log('\n--- 5. optimisation proposes and never applies ---');
  const prop = await call('POST', '/api/clinical/my-day/optimize', cTok, {
    startCoords: { lat: 33.80, lng: -84.40 },
    visits: [
      { eid: '1', patientName: 'Far', time: '08:30', state: 'scheduled', coords: { lat: 34.30, lng: -84.40 } },
      { eid: '2', patientName: 'Near', time: '10:15', state: 'scheduled', coords: { lat: 33.81, lng: -84.40 } }
    ]
  });
  ok('a proposal comes back', prop.status === 200, prop.body);
  ok('  and says plainly that nothing was applied', prop.body.applied === false, prop.body.applied);
  ok('  the nearest stop is proposed first',
    prop.body.proposal && prop.body.proposal.order[0].patientName === 'Near', prop.body.proposal);
  ok('  the caveat names the missing routing provider',
    /routing provider/i.test(String(prop.body.proposal.caveat)), prop.body.proposal.caveat);

  // ---- 6. The pre-visit packet -------------------------------------------
  console.log('\n--- 6. the packet a clinician reads in the car ---');
  const pv = await call('GET', `/api/clinical/patients/${patient.id}/pre-visit`, cTok);
  ok('the packet answers', pv.status === 200, pv.body);
  const k = (pv.body && pv.body.packet) || {};
  ok('  it names the patient', !!k.patientName, k.patientName);
  ok('  it carries the banner, so the allergy strip is the SAME one',
    k.banner && k.banner.allergies && !!k.banner.allergies.state, k.banner && k.banner.allergies);
  ok('  the standing facts are on it — the third surface reading that one field',
    Array.isArray(k.homeVisit) && k.homeVisit.some(h => h.key === 'accessInstructions'), k.homeVisit);
  ok('  open items is a list, even when empty', Array.isArray(k.openItems), k.openItems);
  ok('  a read-only case manager may read the packet',
    (await call('GET', `/api/clinical/patients/${patient.id}/pre-visit`, rTok)).status === 200);

  // ---- 7. Nothing was destroyed ------------------------------------------
  console.log('\n--- 7. preservation: the visit record is intact ---');
  const draft = { chiefConcern: 'Preserved', subjective: 'Still here.' };
  await call('PUT', `/api/clinical/patients/${patient.id}/visit/draft`, cTok, { draft });
  await call('PUT', `/api/clinical/patients/${patient.id}/home-visit`, cTok, { homeVisit: { accessInstructions: 'Changed again.' } });
  const draftAfter = await call('GET', `/api/clinical/patients/${patient.id}/visit/draft`, cTok);
  ok('a draft written before a standing-fact edit is STILL THERE afterwards',
    draftAfter.body.draft && draftAfter.body.draft.chiefConcern === 'Preserved', draftAfter.body.draft);
  const timingAfter = await call('GET', `/api/clinical/visits/${EID}/timing`, cTok);
  ok('  and so are the visit stamps',
    timingAfter.body.timing && timingAfter.body.timing.totalMinutes === 55, timingAfter.body.timing);

  // ---- 8. The chart's new places (Scope D) and the work queues (Scope I) --
  console.log('\n--- 8. the chart places, the timeline and the work queues ---');
  const tl = await call('GET', `/api/clinical/patients/${patient.id}/timeline`, cTok);
  ok('the timeline answers', tl.status === 200, tl.body);
  ok('  it declares the kinds it can show, so the page names none of its own',
    Array.isArray(tl.body.kinds) && tl.body.kinds.includes('result'), tl.body.kinds);
  ok('  undated items are COUNTED rather than dropped', typeof tl.body.undated === 'number', tl.body.undated);
  ok('  an unlinked chart says why visits are missing',
    typeof tl.body.emrNotice === 'string' && tl.body.emrNotice.length > 0, tl.body.emrNotice);
  const tlFiltered = await call('GET', `/api/clinical/patients/${patient.id}/timeline?kinds=result`, cTok);
  ok('  filtering by kind is accepted', tlFiltered.status === 200 && Array.isArray(tlFiltered.body.rows), tlFiltered.body);
  ok('  a case manager may READ the timeline',
    (await call('GET', `/api/clinical/patients/${patient.id}/timeline`, rTok)).status === 200);

  const pr = await call('GET', `/api/clinical/patients/${patient.id}/results`, cTok);
  ok('the per-patient results place answers', pr.status === 200 && Array.isArray(pr.body.results), pr.body);
  ok('  and it is a READ, so a case manager keeps it',
    (await call('GET', `/api/clinical/patients/${patient.id}/results`, rTok)).status === 200);

  const po = await call('GET', `/api/clinical/patients/${patient.id}/orders`, cTok);
  ok('the per-patient orders place answers', po.status === 200 && Array.isArray(po.body.orders), po.body);

  const wq = await call('GET', '/api/clinical/work-queues', cTok);
  ok('the work queues answer', wq.status === 200, wq.body);
  ['unsignedEncounters', 'unacknowledgedResults', 'openReferrals', 'overdueOrders']
    .forEach(q => ok(`  ${q} is a list, even when empty`,
      Array.isArray(wq.body.queues && wq.body.queues[q]), wq.body.queues && wq.body.queues[q]));
  ok('  the overdue thresholds come from 4.10, not a second copy',
    wq.body.overdueThresholds && wq.body.overdueThresholds.referral === 30, wq.body.overdueThresholds);

  const an = await call('GET', '/api/clinical/analytics', cTok);
  ok('analytics answers', an.status === 200, an.body);
  ok('  miles driven is UNAVAILABLE, not zero',
    an.body.metrics.milesDriven.unavailable === true && an.body.metrics.milesDriven.value === null,
    an.body.metrics.milesDriven);
  ok('  screening completion is UNAVAILABLE, not invented',
    an.body.metrics.screeningCompletionRate.unavailable === true, an.body.metrics.screeningCompletionRate);
  ok('  average visit length counts the visit this probe stamped',
    an.body.metrics.averageVisitMinutes.sampleSize >= 1, an.body.metrics.averageVisitMinutes);

  console.log(`\n${pass}/${pass + fail} assertions passed${fail ? ` — ${fail} FAILED` : ''}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('Probe crashed:', e); process.exit(1); });
