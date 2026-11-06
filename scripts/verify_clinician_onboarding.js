#!/usr/bin/env node
// ============================================================================
// Clinician onboarding — live probe, through the REAL HTTP routes.
// ============================================================================
// Every assertion reads a STORED value back out of a response rather than
// checking a status code. That is the rule this repo learned the hard way five
// times over: OpenEMR answers 200 with a validation map and writes nothing, so
// a 200 is not evidence that anything was saved.
//
//   MFA_ENFORCE=false DATA_STORE=memory JWT_SECRET=x PORT=3277 node server.js
//   node scripts/verify_clinician_onboarding.js
// ============================================================================
'use strict';

const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:3277';
const ADMIN_EMAIL = process.env.DEFAULT_ADMIN_EMAIL || 'admin@godwinsfamilycarellc.com';
const ADMIN_PASSWORD = process.env.DEFAULT_ADMIN_PASSWORD || 'gfcforever2026';

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`); }
};
const eq = (name, got, want) => ok(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

async function call(method, path, { token, body, raw } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' },
      token ? { Authorization: `Bearer ${token}` } : {}),
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let data = null;
  try { data = await res.json(); } catch (e) { /* no body */ }
  return raw ? { status: res.status, data } : data;
}

(async () => {
  console.log('\nA · sign in and read the vocabulary');
  const login = await call('POST', '/api/auth/login', { body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
  const token = login && (login.token || (login.data && login.data.token));
  ok('admin signs in', !!token, JSON.stringify(login).slice(0, 200));
  if (!token) { console.log('\ncannot continue without a token\n'); process.exit(1); }

  const meta = await call('GET', '/api/clinician-onboarding/meta', { token });
  eq('meta serves 3 roles', (meta.roles || []).length, 3);
  eq('meta serves 3 relationships', (meta.relationships || []).length, 3);
  eq('meta serves 8 add-ons', (meta.addons || []).length, 8);
  ok('meta names the viewer as office', meta.viewer && meta.viewer.isOffice === true);
  ok('meta carries the privilege categories', (meta.privilegeCategories || []).length === 10);

  console.log('\nB · the roster names clinicians with no track, and changes nothing about them');
  const seedStamp = Date.now();
  const untracked = await call('POST', '/api/users', { token, body: {
    name: 'Probe Untracked', email: `probe.untracked.${seedStamp}@example.com`,
    password: 'ProbePass123!', role: 'user', accountType: 'provider', hasClinicalAccess: true
  } });
  const untrackedUser = (untracked && (untracked.user || untracked)) || null;
  ok('a clinician exists with no onboarding track', !!(untrackedUser && untrackedUser.id));
  const roster = await call('GET', '/api/clinician-onboarding/admin/roster', { token });
  ok('roster returns clinicians', Array.isArray(roster.clinicians));
  const noTrack = roster.clinicians.filter(c => !c.hasRecord);
  // Asserted by NAME and on a non-empty list. Comparing two counts passes when
  // both are zero, which is no evidence about either.
  ok('they are listed, not hidden', noTrack.length > 0, `${noTrack.length} without a record`);
  ok('and the banner names them', roster.withoutTrack.includes('Probe Untracked'),
    JSON.stringify(roster.withoutTrack));
  ok('reported as "not set up" rather than "nothing done"',
    noTrack.every(c => c.counts === null));

  console.log('\nC · create a physician and an NP');
  const mk = async (name, email) => {
    const r = await call('POST', '/api/users', { token, body: {
      name, email, password: 'ProbePass123!', role: 'user',
      accountType: 'provider', hasClinicalAccess: true
    }, raw: true });
    return (r.data && (r.data.user || r.data)) || null;
  };
  const stamp = Date.now();
  const doc = await mk('Probe Physician', `probe.md.${stamp}@example.com`);
  const np = await mk('Probe NP', `probe.np.${stamp}@example.com`);
  ok('physician account created', !!(doc && doc.id), JSON.stringify(doc).slice(0, 160));
  ok('NP account created', !!(np && np.id));
  if (!doc || !np) { console.log('\ncannot continue without both accounts\n'); process.exit(1); }

  console.log('\nD · the four inputs build the checklist');
  let npTrack = await call('PUT', `/api/clinician-onboarding/admin/${np.id}/inputs`, {
    token, body: { roles: ['NP'], relationship: 'HYBRID', lanes: ['CLINICAL', 'EXAMS'],
      addons: ['FNP', 'PMHNP', 'PRESCRIBES', 'CONTROLLED', 'TELEHEALTH', 'INSURED_BILLING'],
      contractors: ['VES'], payers: [{ id: 'medicare', name: 'Original Medicare' }] }
  });
  ok('track is defined', npTrack.track.defined.defined === true);
  const n1 = npTrack.track.counts.total;
  ok(`checklist built (${n1} items)`, n1 > 80);
  ok('gates are only the ones her inputs call for',
    JSON.stringify(Object.keys(npTrack.track.gates)) === JSON.stringify(['G0', 'G1', 'G2', 'G3', 'G4', 'G5']),
    Object.keys(npTrack.track.gates).join(','));
  ok('an item appears exactly once',
    new Set(npTrack.track.rows.map(r => r.id)).size === npTrack.track.rows.length);

  console.log('\nE · unticking a lane shrinks the list; completed work stays');
  await call('PUT', `/api/clinician-onboarding/admin/${np.id}/items/CLIN-09`, {
    token, body: { status: 'complete', verifiedAt: '2026-11-01', source: 'AHA eCard lookup' }
  });
  let shrunk = await call('PUT', `/api/clinician-onboarding/admin/${np.id}/inputs`, {
    token, body: { lanes: ['CLINICAL'] }
  });
  ok('exam items are gone', shrunk.track.counts.total < n1, `${shrunk.track.counts.total} vs ${n1}`);
  ok('the exams gate is gone with them', !shrunk.track.gates.G1);
  const bls = shrunk.track.rows.find(r => r.id === 'CLIN-09');
  eq('the completed item is still complete', bls && bls.status, 'complete');
  eq('and still carries who checked it, and where', bls && bls.verifiedBy, 'GFC Admin');
  npTrack = await call('PUT', `/api/clinician-onboarding/admin/${np.id}/inputs`, {
    token, body: { lanes: ['CLINICAL', 'EXAMS'] }
  });
  ok('re-ticking the lane brings its items back', npTrack.track.counts.total === n1);

  console.log('\nF · a verification must name its source and its date');
  let r = await call('PUT', `/api/clinician-onboarding/admin/${np.id}/items/NP-01`, {
    token, body: { status: 'complete' }, raw: true
  });
  eq('no date is refused', r.data && r.data.code, 'VERIFY_DATE_REQUIRED');
  r = await call('PUT', `/api/clinician-onboarding/admin/${np.id}/items/NP-01`, {
    token, body: { status: 'complete', verifiedAt: '2026-11-05' }, raw: true
  });
  eq('no source is refused', r.data && r.data.code, 'VERIFY_SOURCE_REQUIRED');
  const after = await call('PUT', `/api/clinician-onboarding/admin/${np.id}/items/NP-01`, {
    token, body: { status: 'complete', verifiedAt: '2026-11-05', source: 'Nursys' }
  });
  const np01 = after.track.rows.find(x => x.id === 'NP-01');
  eq('with both, it stores the date', np01.verifiedAt, '2026-11-05');
  ok('and reopens on its own cadence', !!np01.dueAt, `dueAt=${np01.dueAt}`);

  console.log('\nG · "not needed" needs a reason');
  r = await call('PUT', `/api/clinician-onboarding/admin/${np.id}/items/CLIN-14`, {
    token, body: { status: 'not_applicable' }, raw: true
  });
  eq('refused with no reason', r.data && r.data.code, 'ITEM_NA_REASON_REQUIRED');

  console.log('\nH · a gate is signed open, and eligibility alone does not open it');
  r = await call('POST', `/api/clinician-onboarding/admin/${np.id}/gates/G2/open`, {
    token, body: {}, raw: true
  });
  eq('an ineligible gate is refused', r.data && r.data.code, 'GATE_NOT_ELIGIBLE');
  ok('and the refusal names what is outstanding', (r.data.blockedBy || []).length > 0);
  ok('including the supervising physician', !!r.data.waitingOnSupervisor,
    JSON.stringify(r.data.waitingOnSupervisor));

  console.log('\nI · the physician gate is a DIFFERENT person’s gate');
  await call('PUT', `/api/clinician-onboarding/admin/${doc.id}/inputs`, {
    token, body: { roles: ['MD_DELEGATING', 'MD_DIRECTOR'], relationship: '1099' }
  });
  const link = await call('PUT', `/api/clinician-onboarding/admin/${np.id}/inputs`, {
    token, body: { supervisorUserId: String(doc.id) }, raw: true
  });
  ok('the NP can be linked to a physician', link.status === 200, JSON.stringify(link.data).slice(0, 160));
  const linked = link.data;
  ok('and G2 now names him by name',
    linked.track.gates.G2.waitingOnSupervisor
      && /Probe Physician/.test(linked.track.gates.G2.waitingOnSupervisor.reason),
    JSON.stringify(linked.track.gates.G2.waitingOnSupervisor));
  const bad = await call('PUT', `/api/clinician-onboarding/admin/${np.id}/inputs`, {
    token, body: { supervisorUserId: String(np.id) }, raw: true
  });
  eq('somebody who is not a physician is refused as supervisor',
    bad.data && bad.data.code, 'SUPERVISOR_NOT_PHYSICIAN');

  console.log('\nJ · privileges can be narrowed, never widened');
  r = await call('POST', `/api/clinician-onboarding/admin/${np.id}/privileges/generate`, {
    token, body: { allowances: [] }, raw: true
  });
  eq('no allowances is refused', r.data && r.data.code, 'ALLOWANCES_REQUIRED');
  r = await call('POST', `/api/clinician-onboarding/admin/${np.id}/privileges/generate`, {
    token, body: { allowances: ['asmt_hp'] }, raw: true
  });
  eq('no agreement version is refused', r.data && r.data.code, 'AGREEMENT_VERSION_REQUIRED');
  const gen = await call('POST', `/api/clinician-onboarding/admin/${np.id}/privileges/generate`, {
    token, body: { allowances: ['asmt_hp', 'dx_labs', 'rx_noncontrolled', 'proc_wound'],
      agreementVersion: '2026-11 executed' }
  });
  eq('the list generates at full agreement scope', gen.privileges.counts.granted, 4);
  ok('and marks everything else as not in the agreement', gen.privileges.counts.notInAgreement > 20);
  r = await call('PUT', `/api/clinician-onboarding/admin/${np.id}/privileges/proc_joint_injection`, {
    token, body: { status: 'granted' }, raw: true
  });
  eq('granting beyond the agreement is refused by name',
    r.data && r.data.code, 'PRIVILEGE_NOT_IN_AGREEMENT');
  r = await call('PUT', `/api/clinician-onboarding/admin/${np.id}/privileges/dx_labs`, {
    token, body: { status: 'narrowed' }, raw: true
  });
  eq('narrowing with no reason is refused', r.data && r.data.code, 'PRIVILEGE_REASON_REQUIRED');
  const narrowed = await call('PUT', `/api/clinician-onboarding/admin/${np.id}/privileges/dx_labs`, {
    token, body: { status: 'narrowed', reason: 'No lab courier in her county yet' }
  });
  const dxl = narrowed.privileges.rows.find(x => x.id === 'dx_labs');
  eq('narrowing stores its reason', dxl.reason, 'No lab courier in her county yet');
  eq('and the count moves', narrowed.privileges.counts.granted, 3);

  console.log('\nK · documents: signed against the SERVER’s version');
  const npLogin = await call('POST', '/api/auth/login', {
    body: { email: `probe.np.${stamp}@example.com`, password: 'ProbePass123!' }
  });
  const npToken = npLogin && (npLogin.token || (npLogin.data && npLogin.data.token));
  ok('the NP can sign in', !!npToken);
  if (npToken) {
    const mine = await call('GET', '/api/clinician-onboarding/me', { token: npToken });
    ok('she sees her own track', mine.track.counts.total === n1);
    ok('with her own items marked as hers', mine.track.rows.some(x => x.waitingOnYou === true));
    const signed = await call('POST', '/api/clinician-onboarding/me/resources/RES-05/sign', {
      token: npToken, body: { typedName: 'Probe NP', version: 'v0.0-forged' }
    });
    const res05 = signed.resources.rows.find(x => x.id === 'RES-05');
    eq('the stored version is the server’s, not the browser’s', res05.signedVersion, 'v2.0');
    ok('and the signature is recorded', !!res05.signedAt);
    eq('a stale signature is not reported as stale when it matches', res05.stale, false);

    const noAcc = await call('POST', '/api/clinician-onboarding/me/resources/RES-09/no-access', { token: npToken });
    const res09 = noAcc.resources.rows.find(x => x.id === 'RES-09');
    ok('an unreachable document is flagged, not a blocker', res09.available === false);

    console.log('\nL · she cannot verify her own licence');
    r = await call('PUT', '/api/clinician-onboarding/me/items/NP-02', {
      token: npToken, body: {}, raw: true
    });
    eq('an office item is refused to her', r.data && r.data.code, 'ITEM_NOT_YOURS');
    const sub = await call('PUT', '/api/clinician-onboarding/me/items/CLIN-01', {
      token: npToken, body: { note: 'uploaded' }
    });
    const c01 = sub.track.rows.find(x => x.id === 'CLIN-01');
    eq('her own item completes', c01.status, 'complete');
    const sub2 = await call('PUT', '/api/clinician-onboarding/me/items/CLIN-03', {
      token: npToken, body: {}
    });
    const c03 = sub2.track.rows.find(x => x.id === 'CLIN-03');
    eq('one the office verifies waits on the office', c03.status, 'submitted');
    eq('and says so', c03.waitingOn, 'gfc');

    console.log('\nM · she cannot reach the office half');
    r = await call('GET', '/api/clinician-onboarding/admin/roster', { token: npToken, raw: true });
    eq('the roster is refused', r.data && r.data.code, 'ONBOARDING_OFFICE_ONLY');
    r = await call('POST', `/api/clinician-onboarding/admin/${np.id}/gates/G0/open`, {
      token: npToken, body: {}, raw: true
    });
    eq('she cannot sign her own gate open', r.data && r.data.code, 'ONBOARDING_OFFICE_ONLY');

    console.log('\nN · training: a miss sends her back to the module');
    const done = await call('PUT', '/api/clinician-onboarding/me/training/TRN-003', {
      token: npToken, body: { answers: [
        { prompt: 'q1', correct: true }, { prompt: 'q2', correct: true }, { prompt: 'q3', correct: false }
      ] }
    });
    const m3 = done.training.rows.find(x => x.id === 'TRN-003');
    eq('the module completes', m3.status, 'complete');
    eq('with a score', m3.score, 67);
    ok('and schedules four check-backs', m3.rechecks.length === 4, JSON.stringify(m3.rechecks.map(x => x.day)));
    const missed = await call('POST', '/api/clinician-onboarding/me/training/TRN-003/recheck', {
      token: npToken, body: { day: 3, correct: false }
    });
    const m3b = missed.training.rows.find(x => x.id === 'TRN-003');
    // Asserted on completedAt, not on status: a module that KEEPS its completion
    // while carrying a failed check reads 'redo', which is also not 'complete',
    // so a status check cannot tell the two apart and proves nothing.
    eq('a missed check-back clears the completion', m3b.completedAt, null);
    ok('so the module is back on her list', m3b.status !== 'complete', `status=${m3b.status}`);
  }

  console.log('\nO · the audit trail');
  const ev = await call('GET', `/api/clinician-onboarding/admin/${np.id}/events`, { token });
  ok('events were appended', (ev.events || []).length > 0, `${(ev.events || []).length} events`);
  ok('an inputs change is recorded', ev.events.some(e => e.type === 'inputs_changed'));
  ok('a verification is recorded with its source',
    ev.events.some(e => e.type === 'item_recorded' && e.source === 'Nursys'));
  ok('a privilege decision is recorded', ev.events.some(e => e.type === 'privilege_decided'));
  ok('no event carries a signature image or a password',
    !/signaturePng|password/i.test(JSON.stringify(ev.events)));

  // ==========================================================================
  // P · WHAT HER OWN SCREEN IS SENT
  //
  // The page guards on the audience, but a guard in a page is one rule and the
  // server is another; the day they disagree an internal flag renders. So this
  // asserts the FIELDS, over real HTTP, on both views of the same record —
  // because a scan of the page cannot prove what the route withheld.
  // ==========================================================================
  console.log('\nP · what her own screen is sent');
  if (npToken) {
    const hers = await call('GET', '/api/clinician-onboarding/me', { token: npToken });
    const ours = await call('GET', `/api/clinician-onboarding/admin/${np.id}`, { token });

    const HIDDEN = ['proof', 'verify', 'alsoVerify', 'ownerRole', 'ownerRoleLabel', 'gates'];
    const herRow = (hers.track.rows || []).find(r => r.id === 'CLIN-10') || {};
    const ourRow = (ours.track.rows || []).find(r => r.id === 'CLIN-10') || {};
    ok('the same item is on both views', !!herRow.title && herRow.title === ourRow.title,
      `${herRow.title || '(missing)'}`);
    HIDDEN.forEach(f => {
      ok(`she is not sent "${f}"`, !(f in herRow), `got ${JSON.stringify(herRow[f])}`);
      ok(`the office still is sent "${f}"`, f in ourRow,
        'stripping her view must not narrow credentialing');
    });

    // The item's TITLE and what to do about it are hers. Only the office's own
    // working notes go; the work itself must still read.
    ok('her row still carries what the item is', !!herRow.title && 'status' in herRow);
    ok('and who it is waiting on', 'waitingOn' in herRow && 'waitingOnYou' in herRow);

    const herMod = (hers.training.rows || [])[0] || {};
    const ourMod = (ours.training.rows || [])[0] || {};
    ['checksMissing', 'feedsGate'].forEach(f => {
      ok(`she is not sent module "${f}"`, !(f in herMod));
      ok(`the office still is sent module "${f}"`, f in ourMod);
    });
    ok('nor the count of modules whose questions we have not written',
      !('checksMissing' in (hers.training.counts || {})));
    ok('while the office keeps that backlog figure',
      'checksMissing' in (ours.training.counts || {}),
      JSON.stringify(ours.training.counts));

    // byPhase and upNext are the same objects as rows in the builder's own
    // output. Asserting only `rows` would pass while two other paths leaked.
    const everyHerMod = []
      .concat(hers.training.rows || [], hers.training.upNext || [])
      .concat(...(hers.training.byPhase || []).map(ph => ph.modules || []));
    ok(`every module on every path she reads is clean (${everyHerMod.length} checked)`,
      everyHerMod.length > 40 && everyHerMod.every(m => !('checksMissing' in m) && !('feedsGate' in m)));

    const everyHerRow = (hers.track.rows || [])
      .concat(...Object.values(hers.track.gates || {}).map(g => g.blockedBy || []));
    ok(`and every row on every path she reads (${everyHerRow.length} checked)`,
      everyHerRow.length > 80 && everyHerRow.every(r => !HIDDEN.some(f => f in r)));

    // Gate prerequisites in words, not codes.
    const g2 = hers.track.gates.G2 || {};
    ok('a gate she cannot open yet names its prerequisites in words',
      (g2.blockedByGateTitles || []).length > 0 &&
      !(g2.blockedByGateTitles || []).some(t => /^G[\dM_]/.test(t)),
      JSON.stringify(g2.blockedByGateTitles));
    ok('no gate tells her what it opens in the third person',
      !Object.values(hers.track.gates).some(g => /\b(their|her|his|she|he)\b/i.test(g.opens || '')));
  }

  // ==========================================================================
  // Q · HER DOCUMENTS AND NOTES, END TO END
  //
  // The point of the shared row is that the office finds one person's
  // paperwork in ONE place. Only a real upload through the real route, read
  // back through the caregiver document list the User Management card calls,
  // can show that — a source scan cannot.
  // ==========================================================================
  console.log('\nQ · her documents and notes');
  if (npToken) {
    // A 1x1 PNG, so the byte-typing has something real to type.
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64');
    const fd = new FormData();
    fd.append('file', new Blob([png], { type: 'image/png' }), 'licence-scan.png');
    const up = await fetch(`${BASE}/api/clinician-onboarding/me/items/NP-01/proof`, {
      method: 'POST', headers: { Authorization: `Bearer ${npToken}` }, body: fd
    });
    const upBody = await up.json().catch(() => ({}));

    // DRIVE IS NOT REACHABLE FROM A SANDBOX, and a Drive failure REFUSING the
    // upload is the designed behaviour — a row pointing at a file that does
    // not exist would tick a credentialing item with no proof behind it. So a
    // 502 here is the control working, not a defect, and calling it a failure
    // would be a false alarm every time this runs without Google. The stored
    // row is proven instead by `test/clinician_onboarding.test.js`, which
    // mounts this same router with a fake Drive and reads the row back.
    const driveOff = up.status === 502 && upBody.code === 'PROOF_STORAGE_UNAVAILABLE';
    if (driveOff) {
      console.log('  --   Drive is not configured here, so the document half cannot run.');
      console.log('       A refused upload IS the rule: nothing is recorded without the file.');
      ok('and nothing was recorded for the refused upload',
        !((await call('GET', '/api/clinician-onboarding/me', { token: npToken }))
          .track.rows.find(r => r.id === 'NP-01').proofFiles || []).length);
    } else {
      ok('she can attach a file to a checklist item', up.status === 200,
        `${up.status} ${JSON.stringify(upBody).slice(0, 160)}`);
    }

    const row = up.status === 200
      ? (upBody.track.rows || []).find(r => r.id === 'NP-01') : null;
    if (!driveOff) {
    const file = row && (row.proofFiles || [])[0];
    ok('the item carries the file', !!file, JSON.stringify(row && row.proofFiles));
    ok('and points at the shared document row', !!(file && file.documentId),
      'without this the wizard and User Management open different things');

    // THE ACTUAL ASK: does it show up where the office manages the person?
    const docs = await call('GET', `/api/caregiver/documents?caregiverId=${np.id}`, { token });
    const list = docs.documents || docs.docs || [];
    const mine = list.filter(d => d.kind === 'clinician_onboarding');
    ok('it is in the documents list User Management reads', mine.length === 1,
      `${list.length} rows, ${mine.length} clinician`);
    ok('named by the checklist item it answers',
      !!(mine[0] && /^Onboarding: /.test(mine[0].note || '')), mine[0] && mine[0].note);
    ok('with her own filename kept', !!(mine[0] && mine[0].fileName === 'licence-scan.png'),
      mine[0] && mine[0].fileName);
    ok('and a readable label rather than a raw slug',
      !!(mine[0] && mine[0].kindLabel && mine[0].kindLabel !== 'clinician_onboarding'),
      mine[0] && mine[0].kindLabel);
    ok('it reads as waiting on the office, since a licence is verified',
      !!(mine[0] && mine[0].status === 'received'), mine[0] && mine[0].status);

    // Both readers open the SAME bytes.
    if (file) {
      const hers = await fetch(`${BASE}/api/clinician-onboarding/me/items/NP-01/proof/${file.id}`,
        { headers: { Authorization: `Bearer ${npToken}` } });
      const herBytes = Buffer.from(await hers.arrayBuffer());
      ok('she can open what she sent', hers.status === 200 && herBytes.length === png.length,
        `${hers.status}, ${herBytes.length} bytes`);
      ok('and the bytes are the ones she uploaded', herBytes.equals(png));

      const theirs = await fetch(`${BASE}/api/caregiver/documents/${file.documentId}/file`,
        { headers: { Authorization: `Bearer ${token}` } });
      const theirBytes = Buffer.from(await theirs.arrayBuffer());
      ok('the office opens the same file from User Management',
        theirs.status === 200 && theirBytes.equals(png), `${theirs.status}`);

      // Hers is her own, with no id to widen; another clinician's is refused
      // by the route reading from the session rather than the URL.
      const stranger = await fetch(
        `${BASE}/api/clinician-onboarding/me/items/NP-01/proof/not-a-real-file`,
        { headers: { Authorization: `Bearer ${npToken}` } });
      ok('a file id that is not hers is 404, not somebody else\'s document',
        stranger.status === 404, String(stranger.status));
    }

    }

    // NOTES, both ways, on one item. These need no storage, so they run
    // whatever Drive is doing.
    const n1 = await call('POST', '/api/clinician-onboarding/me/items/NP-01/notes',
      { token: npToken, body: { text: 'Board says four to six weeks.' } });
    const n2 = await call('POST', `/api/clinician-onboarding/admin/${np.id}/items/NP-01/notes`,
      { token, body: { text: 'Noted, we will not chase you on it.' } });

    const afterOffice = (n2.track.rows || []).find(r => r.id === 'NP-01');
    ok('her note survives the office writing one', (afterOffice.notes || []).length === 2,
      JSON.stringify((afterOffice.notes || []).map(x => x.text)));
    ok('the office note did not overwrite hers',
      (afterOffice.notes || [])[0].text === 'Board says four to six weeks.');
    ok('each note says which side wrote it',
      afterOffice.notes[0].fromOffice === false && afterOffice.notes[1].fromOffice === true);
    ok('and who, by name', !!afterOffice.notes[0].byName && !!afterOffice.notes[1].byName);

    const herView = await call('GET', '/api/clinician-onboarding/me', { token: npToken });
    const herRow = (herView.track.rows || []).find(r => r.id === 'NP-01');
    ok('she reads what the office wrote to her', (herRow.notes || []).length === 2,
      JSON.stringify((herRow.notes || []).map(x => x.text)));

    const empty = await call('POST', '/api/clinician-onboarding/me/items/NP-01/notes',
      { token: npToken, body: { text: '   ' } });
    ok('an empty note is refused rather than stored', empty.status === 400 || empty.code === 'NOTE_EMPTY',
      JSON.stringify(empty).slice(0, 120));

    // A document to complete outside the app must say where it goes back.
    const external = (herView.resources.byStep || [])
      .flatMap(s => s.resources || [])
      .filter(r => r.action === 'COMPLETE_EXTERNAL' || r.action === 'UPLOAD_CERTIFICATE');
    ok(`a document to send back names its checklist item (${external.length} checked)`,
      external.length > 0 && external.every(r => r.uploadItem && r.uploadItem.title),
      JSON.stringify(external.map(r => [r.id, r.uploadItem && r.uploadItem.id])));
  }

  console.log(`\n${pass}/${pass + fail} checks passed${fail ? ` — ${fail} FAILED` : ''}\n`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('\nprobe crashed:', e.message, '\n'); process.exit(1); });
