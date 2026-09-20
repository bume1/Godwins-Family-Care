// Live probe — drives the REAL Express routes over HTTP and reads stored values
// back, never a status code alone.
//
//   DATA_STORE=memory MFA_ENFORCE=false JWT_SECRET=probe PORT=3199 node server.js
//   GFC_PROBE_BASE=http://localhost:3199 node scripts/verify_enrollment_admin_edit.js
//
// Covers the owner-directed changes of 2026-09-16 (a client can be added with
// the agreed rate deliberately skipped; the enrollment WORKFLOW is admin-only)
// and of 2026-09-18 (an admin OR A CLINICIAN may edit the submission itself,
// and every part of it saves — the mirror, the ROI provider list, the payer
// summary and the re-signature flag included).
const BASE = process.env.GFC_PROBE_BASE || 'http://localhost:3199';
const ADMIN_EMAIL = process.env.GFC_PROBE_ADMIN || 'admin@godwinsfamilycarellc.com';
const ADMIN_PW = process.env.GFC_PROBE_PW || 'gfcforever2026';

let pass = 0, fail = 0;
const ok = (cond, what, detail) => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${detail ? ` — ${detail}` : ''}`); }
};
const eq = (a, b, what) => ok(a === b, what, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

const call = async (method, path, token, body) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, body: json };
};

(async () => {
  const login = await call('POST', '/api/auth/login', null, { email: ADMIN_EMAIL, password: ADMIN_PW });
  const admin = login.body && login.body.token;
  if (!admin) { console.error('Could not sign in as admin:', login.status, login.body); process.exit(1); }
  const uniq = Date.now();

  console.log('\nA. Adding a client with the rate deliberately skipped');
  // EXACTLY what the Add-User form posts when both rate boxes are untouched.
  const skipped = await call('POST', '/api/users', admin, {
    name: 'Probe SkippedRate', email: `probe.skip.${uniq}@example.com`, password: 'Temp12345!',
    role: 'client', practiceName: 'Probe SkippedRate', phone: '4045550001',
    rateAgreement: { hourlyRate: '', dailyMinimumHours: '' }, sendWelcomeEmail: false
  });
  eq(skipped.status, 200, 'a blank rate no longer refuses the client');
  const skippedId = skipped.body && skipped.body.id;
  ok(!!skippedId, 'the client was created');

  console.log('\nB. A half-filled rate is still refused, and says which half');
  const half = await call('POST', '/api/users', admin, {
    name: 'Probe HalfRate', email: `probe.half.${uniq}@example.com`, password: 'Temp12345!',
    role: 'client', practiceName: 'Probe HalfRate',
    rateAgreement: { hourlyRate: '32', dailyMinimumHours: '' }, sendWelcomeEmail: false
  });
  eq(half.status, 400, 'one number without the other is refused');
  eq(half.body && half.body.code, 'RATE_INVALID', 'with its own code');
  ok(/dailyMinimumHours/.test((half.body && half.body.error) || ''),
    'the message names the missing half', half.body && half.body.error);

  console.log('\nC. A real rate still stores');
  const rated = await call('POST', '/api/users', admin, {
    name: 'Probe Rated', email: `probe.rated.${uniq}@example.com`, password: 'Temp12345!',
    role: 'client', practiceName: 'Probe Rated',
    rateAgreement: { hourlyRate: '32', dailyMinimumHours: '4' }, sendWelcomeEmail: false
  });
  eq(rated.status, 200, 'a supplied rate is accepted');
  const ratedDetail = await call('GET', `/api/gfc/admin/enrollment/${rated.body.id}`, admin);
  eq(ratedDetail.body.client.rateAgreement.hourlyRate, 32, 'stored, read back');
  eq(ratedDetail.body.client.rateSet, true, 'and the consents are presentable');

  console.log('\nD. Admin edits the client details');
  const before = await call('GET', `/api/gfc/admin/enrollment/${skippedId}`, admin);
  eq(before.body.client.dob, null, 'starts with no date of birth');
  const saved = await call('PUT', `/api/gfc/admin/enrollment/${skippedId}/details`, admin, {
    dob: '1948-03-11', gender: 'Female', primaryLanguage: 'English', phone: '4045550001',
    primaryContact: { name: 'Dana Guess', relationship: 'Daughter', phone: '4045550002', email: 'dana@example.com' }
  });
  eq(saved.status, 200, 'the edit is accepted');
  const after = await call('GET', `/api/gfc/admin/enrollment/${skippedId}`, admin);
  eq(after.body.client.dob, '1948-03-11', 'date of birth stored, read back');
  ok(after.body.client.age >= 77, 'age derived server-side', `age=${after.body.client.age}`);
  eq(after.body.client.intake.gender, 'Female', 'gender stored');
  eq(after.body.client.intake.primaryContact.relationship, 'Daughter', 'primary contact stored');
  ok(!saved.body.changed.includes('email'), 'an unchanged field is not reported as changed');

  console.log('\nE. A refusal writes nothing');
  const badDob = await call('PUT', `/api/gfc/admin/enrollment/${skippedId}/details`, admin, { dob: '2099-01-01' });
  eq(badDob.status, 400, 'a future date of birth is refused');
  eq(badDob.body.code, 'INTAKE_INVALID', 'with field-level detail');
  ok(!!(badDob.body.fieldErrors || {}).dob, 'naming the field');
  const stillOk = await call('GET', `/api/gfc/admin/enrollment/${skippedId}`, admin);
  eq(stillOk.body.client.dob, '1948-03-11', 'the stored date is untouched by the refusal');

  const taken = await call('PUT', `/api/gfc/admin/enrollment/${skippedId}/details`, admin,
    { email: `probe.rated.${uniq}@example.com` });
  eq(taken.status, 400, "another account's email is refused");
  eq(taken.body.code, 'EMAIL_TAKEN', 'with its own code');

  console.log('\nF. Correcting a value a SIGNED consent prints flags re-signature');
  // Sign one consent as this client, then move their date of birth.
  const clientLogin = await call('POST', '/api/auth/login', null,
    { email: `probe.skip.${uniq}@example.com`, password: 'Temp12345!' });
  const flagged = await (async () => {
    // roiProvider renders the clientIdentity block, which prints the date of
    // birth — and unlike the service agreement it needs no rate, so it is
    // presentable for this deliberately rate-less client.
    const t = clientLogin.body && clientLogin.body.token;
    if (!t) return { skipped: true };
    const sig = await call('POST', '/api/gfc/consents', t,
      { type: 'roiProvider', typedName: 'Probe SkippedRate', acknowledged: true });
    if (sig.status !== 200) console.log(`  --   sign returned ${sig.status}: ${JSON.stringify(sig.body)}`);
    const sign = await call('GET', `/api/gfc/admin/enrollment/${skippedId}`, admin);
    const signedNow = (sign.body.client.consents || []).filter(c => c.satisfied).map(c => c.type);
    const move = await call('PUT', `/api/gfc/admin/enrollment/${skippedId}/details`, admin, { dob: '1948-03-12' });
    return { signedNow, move };
  })();
  if (flagged.skipped) {
    console.log('  --   client login unavailable, re-signature check skipped');
  } else if (!flagged.signedNow.length) {
    console.log('  --   no consent could be signed in this environment, re-signature check skipped');
  } else {
    ok(flagged.move.status === 200, 'the correction is still allowed');
    ok((flagged.move.body.consentsNeedingResignature || []).length > 0,
      'and the signed consent it changes is flagged', JSON.stringify(flagged.move.body.consentsNeedingResignature));
    const flaggedDetail = await call('GET', `/api/gfc/admin/enrollment/${skippedId}`, admin);
    eq((flaggedDetail.body.client.consentActionRequired || {}).reason, 'client_details_changed',
      'the flag is on the record for the page to show');
  }

  console.log('\nG. A clinician reads the page, EDITS the submission, and is still refused the workflow');
  const cEmail = `probe.clin.${uniq}@example.com`;
  const clin = await call('POST', '/api/users', admin, {
    name: 'Probe Clinician', email: cEmail, password: 'Temp12345!', role: 'user',
    hasClinicalAccess: true, sendWelcomeEmail: false
  });
  eq(clin.status, 200, 'clinician created');
  const cLogin = await call('POST', '/api/auth/login', null, { email: cEmail, password: 'Temp12345!' });
  const ct = cLogin.body && cLogin.body.token;
  if (!ct) {
    console.log('  --   clinician login unavailable (MFA?), role checks skipped');
  } else {
    const read = await call('GET', `/api/gfc/admin/enrollment/${skippedId}`, ct);
    eq(read.status, 200, 'the clinician can still READ the enrollment detail');
    eq(read.body.client.canEdit, true, 'and the page is TOLD they may edit');
    const list = await call('GET', '/api/gfc/admin/enrollment/list', ct);
    eq(list.status, 200, 'and the list');

    // The correction itself — the whole point of the change.
    const byClinician = await call('PUT', `/api/gfc/admin/enrollment/${skippedId}/details`, ct, {
      allergies: 'Penicillin, latex',
      medicalTeam: { pcpName: 'Dr Adeyemi', preferredPharmacy: 'CVS Main St', preferredHospital: 'Wellstar Cobb' }
    });
    eq(byClinician.status, 200, 'the clinician CAN correct the submission');
    const afterClin = await call('GET', `/api/gfc/admin/enrollment/${skippedId}`, admin);
    eq(afterClin.body.client.intake.allergies, 'Penicillin, latex', 'the allergy is stored, read back');
    eq(afterClin.body.client.intake.medicalTeam.preferredPharmacy, 'CVS Main St', 'the pharmacy too');

    // Still not theirs: the decisions about the file.
    for (const [method, path, what] of [
      ['POST', `/api/gfc/admin/enrollment/${skippedId}/review`, 'mark reviewed'],
      ['POST', `/api/gfc/admin/enrollment/${skippedId}/follow-up`, 'request follow-up'],
      ['PUT',  `/api/gfc/admin/enrollment/${skippedId}/service-line`, 'change service line'],
      ['POST', `/api/gfc/admin/enrollment/${skippedId}/documents/request`, 'request documents'],
      ['POST', `/api/gfc/admin/enrollment/${skippedId}/documents/remind`, 'send a reminder'],
      ['POST', `/api/gfc/admin/enrollment/${skippedId}/approve`, 'approve enrollment']
    ]) {
      const r = await call(method, path, ct, { items: [], line: 'BOTH' });
      eq(r.status, 403, `the clinician is still refused: ${what}`);
    }
  }

  console.log('\nH. A case manager reads and is refused the edit, and the refusal writes nothing');
  const mEmail = `probe.cm.${uniq}@example.com`;
  const cm = await call('POST', '/api/users', admin, {
    name: 'Probe CaseManager', email: mEmail, password: 'Temp12345!', role: 'caseManager',
    sendWelcomeEmail: false
  });
  eq(cm.status, 200, 'case manager created');
  const mLogin = await call('POST', '/api/auth/login', null, { email: mEmail, password: 'Temp12345!' });
  const mt = mLogin.body && mLogin.body.token;
  if (!mt) {
    console.log('  --   case-manager login unavailable (MFA?), checks skipped');
  } else {
    const read = await call('GET', `/api/gfc/admin/enrollment/${skippedId}`, mt);
    eq(read.status, 200, 'the case manager keeps their scoped READ');
    eq(read.body.client.canEdit, false, 'and the page is told they may not edit');
    const refused = await call('PUT', `/api/gfc/admin/enrollment/${skippedId}/details`, mt, { allergies: 'WRONG' });
    eq(refused.status, 403, 'the edit is refused');
    eq(refused.body.code, 'ENROLLMENT_EDITOR_ONLY', 'with its own code');
    const untouched = await call('GET', `/api/gfc/admin/enrollment/${skippedId}`, admin);
    ok(untouched.body.client.intake.allergies !== 'WRONG', 'and nothing was written');
  }

  console.log('\nI. The whole submission saves, and every derived copy follows it');
  const full = await call('PUT', `/api/gfc/admin/enrollment/${skippedId}/details`, admin, {
    address: { line1: '18 Paces Ferry Rd', line2: 'Apt 4', city: 'Vinings', state: 'GA', zip: '30339' },
    crisisNotify: 'Dana Guess',
    advanceDirective: { status: 'Yes — DNR in place' },
    medicalTeam: { pcpName: 'Dr Osei', pcpPhone: '4045550111', preferredPharmacy: 'Walgreens Paces' },
    medications: [
      { name: '  Lisinopril ', dose: '10mg', frequency: 'daily', smuggled: 'dropped' },
      { name: '', dose: '' },
      { name: 'Metformin', route: 'oral' }
    ],
    emergencyContacts: [{ name: 'Ada Nwosu', relationship: 'Daughter', phone: '4045550100' }, {}],
    payerType: 'LTC insurance',
    insuranceIds: [{ carrier: 'Aetna', memberId: 'W1234', group: 'G9' }],
    ltc: { carrier: 'Genworth', policyNum: 'LTC-77' }
  });
  eq(full.status, 200, 'the whole submission is accepted');
  const d = (await call('GET', `/api/gfc/admin/enrollment/${skippedId}`, admin)).body.client;
  eq(d.intake.address.city, 'Vinings', 'address stored, read back');
  eq(d.intake.crisisNotify, 'Dana Guess', 'the notify-first contact stored');
  eq(d.intake.advanceDirective.status, 'Yes — DNR in place', 'the directive status stored');
  eq(d.intake.medicalTeam.pcpName, 'Dr Osei', 'the PCP correction stored');
  eq(d.medications.length, 2, 'the empty medication row was dropped');
  eq(d.medications[0].name, 'Lisinopril', 'and the rest trimmed');
  ok(d.medications[0].smuggled === undefined, 'a key outside the allow-list never landed');
  eq(d.intake.emergencyContacts.length, 1, 'the empty emergency contact was dropped');
  eq(d.intake.emergencyContacts[0].name, 'Ada Nwosu', 'the real one stored');
  // The billing summary on the client record, not just the wizard's own fields.
  ok(!!d.payer, 'the payer summary exists');
  eq((d.payer.insuranceIds || [])[0].carrier, 'Aetna', 'the carrier reached the billing copy');
  eq((d.payer.ltc || {}).policyNum, 'LTC-77', 'and the LTC policy number');
  // The checklist is derived, so a filled-in field leaves the missing list.
  ok(!(d.missing.fields || []).includes('Address'), 'the checklist no longer calls the address missing');
  ok(!(d.missing.fields || []).includes('Preferred pharmacy'), 'nor the pharmacy');

  console.log('\nJ. A corrected PCP rebuilds the ROI provider list the client is offered');
  // Read it through the route the Transfer-of-Care form itself calls, as that
  // client — asserting against a projection that omits the field would let an
  // empty list pass for "the old one is gone".
  const roiToken = clientLogin.body && clientLogin.body.token;
  if (!roiToken) {
    console.log('  --   client login unavailable, ROI check skipped');
  } else {
    const roi = await call('GET', '/api/gfc/transfer-roi', roiToken);
    eq(roi.status, 200, 'the Transfer-of-Care prefill reads');
    const names = (roi.body.priorProviders || []).map(p => String(p.name || ''));
    ok(names.length > 0, 'the list is not empty — an empty one proves nothing either way',
      JSON.stringify(names));
    ok(names.some(n => /Osei/.test(n)), 'the corrected PCP is what the form now offers', JSON.stringify(names));
    ok(!names.some(n => /Adeyemi/.test(n)), 'and the one it replaced is gone', JSON.stringify(names));
  }

  console.log('\nK. THE WHOLE SUBMISSION is editable, not the corner the page displays');
  // Owner, 2026-09-20: "make sure the entire enrollment editable by admin and
  // clinicians essentially." The wizard's other steps — the care situation, the
  // schedule, function and safety, caregiver matching — had no staff writer at
  // all until now.
  const fieldMap = require('../public/intake-fields');
  const wide = await call('PUT', `/api/gfc/admin/enrollment/${skippedId}/details`, admin, {
    situation: { mainReason: 'Discharged Tuesday, daughter cannot cover mornings',
                 adlLevel: 'A lot of help', cognitionLevel: 'Moderate' },
    schedule: { startDate: '2026-10-05', hoursPerWeek: '20', urgency: 'Within a week' },
    homebound: 'Leaves with assistance',
    conditions: ['Diabetes', 'Stroke / TIA'],
    helpNeeded: ['Meal preparation', 'Medication reminders'],
    adl: { bathing: 'Needs physical assistance', ambulation: 'Uses walker / cane' },
    fallRisk: 'High',
    homeSafetyFlags: ['Stairs required', 'Pets in home'],
    matching: { genderPreference: 'Female preferred', personality: ['Warm and chatty'] },
    medicare: { id: '1EG4-TE5-MK73', type: 'Part A & B' },
    auth911: 'Yes — authorized'
  });
  eq(wide.status, 200, 'a whole-submission edit is accepted');
  const w = await call('GET', `/api/gfc/admin/enrollment/${skippedId}`, admin);
  const wi = w.body.client.intake;
  eq(wi.situation.mainReason, 'Discharged Tuesday, daughter cannot cover mornings', 'STORED: the care situation');
  eq(wi.schedule.urgency, 'Within a week', 'STORED: the schedule step');
  eq(wi.homebound, 'Leaves with assistance', 'STORED: the homebound answer');
  eq(wi.fallRisk, 'High', 'STORED: function and safety');
  eq(wi.adl.bathing, 'Needs physical assistance', 'STORED: a nested ADL level');
  eq(wi.matching.genderPreference, 'Female preferred', 'STORED: a caregiver-matching preference');
  eq(wi.medicare.id, '1EG4-TE5-MK73', 'STORED: the Medicare block');
  eq(JSON.stringify(wi.conditions), JSON.stringify(['Diabetes', 'Stroke / TIA']),
    'STORED: a checkbox group as an array');
  eq(JSON.stringify(wi.homeSafetyFlags), JSON.stringify(['Stairs required', 'Pets in home']),
    'STORED: and a second one');
  eq(JSON.stringify(wi.matching.personality), JSON.stringify(['Warm and chatty']),
    'STORED: a checkbox group nested inside a block');
  // The earlier sections were not collateral damage.
  eq(wi.medicalTeam.pcpName, 'Dr Osei', 'the medical team from the earlier edit is untouched');

  console.log('\nL. What the editor REFUSES, and says so rather than swallowing');
  const invented = await call('PUT', `/api/gfc/admin/enrollment/${skippedId}/details`, admin,
    { fallRisk: 'Catastrophic' });
  eq(invented.status, 400, 'an answer that was never on the list is refused');
  eq(invented.body.code, 'INTAKE_OPTION_INVALID', 'with its own code');
  ok((invented.body.fieldErrors || {}).fallRisk, 'and the field is named', JSON.stringify(invented.body.fieldErrors));
  const untouched = await call('GET', `/api/gfc/admin/enrollment/${skippedId}`, admin);
  eq(untouched.body.client.intake.fallRisk, 'High', 'STORED: and the real answer is still there');

  const typed = await call('PUT', `/api/gfc/admin/enrollment/${skippedId}/details`, admin,
    { primaryContact: { relationship: 'Great-niece' }, gender: 'Female' });
  eq(typed.status, 200, 'an OPEN select takes what staff actually heard on the phone');
  const t2 = await call('GET', `/api/gfc/admin/enrollment/${skippedId}`, admin);
  eq(t2.body.client.intake.primaryContact.relationship, 'Great-niece',
    'STORED: a relationship the wizard never offered');

  const emptied = await call('PUT', `/api/gfc/admin/enrollment/${skippedId}/details`, admin,
    { conditions: [] });
  eq(emptied.status, 200, 'clearing a checkbox group is allowed');
  const t3 = await call('GET', `/api/gfc/admin/enrollment/${skippedId}`, admin);
  eq(JSON.stringify(t3.body.client.intake.conditions), '[]',
    'STORED: "none of these" is a real answer, not an absent one');
  eq(t3.body.client.intake.fallRisk, 'High', 'and one field did not blank another');

  // Every path the map declares must actually be writable. A declared field
  // that silently does nothing is a question somebody answers and loses.
  const everything = {};
  fieldMap.VALUE_FIELDS.forEach(f => {
    if (f.path === 'dob' || f.path.startsWith('address.')) return;   // set above, and date-validated
    if (f.type === 'multi') { everything[f.path] = fieldMap.optionsFor(f).slice(0, 1); return; }
    if (f.type === 'select') { everything[f.path] = fieldMap.optionsFor(f)[0]; return; }
    if (f.type === 'number') { everything[f.path] = '4'; return; }
    if (f.type === 'date') { everything[f.path] = '2026-02-02'; return; }
    everything[f.path] = `probe-${f.path}`;
  });
  const all = await call('PUT', `/api/gfc/admin/enrollment/${skippedId}/details`, admin, everything);
  eq(all.status, 200, 'every declared field posts together', JSON.stringify(all.body).slice(0, 300));
  const readAll = await call('GET', `/api/gfc/admin/enrollment/${skippedId}`, admin);
  const at = (o, path) => path.split('.').reduce((x, k) => (x === null || x === undefined ? undefined : x[k]), o);
  const lost = fieldMap.VALUE_FIELDS
    .filter(f => f.path !== 'dob' && !f.path.startsWith('address.'))
    .filter(f => at(readAll.body.client.intake, f.path) === undefined)
    .map(f => f.path);
  ok(lost.length === 0, `every declared field reached the record (${fieldMap.VALUE_FIELDS.length} of them)`,
    `lost: ${lost.join(', ')}`);

  console.log(`\n${pass}/${pass + fail} assertions passed${fail ? ` — ${fail} FAILED` : ''}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('probe error:', e); process.exit(1); });
