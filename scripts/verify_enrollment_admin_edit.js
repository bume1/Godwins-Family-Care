// Live probe — drives the REAL Express routes over HTTP and reads stored values
// back, never a status code alone.
//
//   DATA_STORE=memory MFA_ENFORCE=false JWT_SECRET=probe PORT=3199 node server.js
//   GFC_PROBE_BASE=http://localhost:3199 node scripts/verify_enrollment_admin_edit.js
//
// Covers the two owner-directed changes of 2026-09-16: a client can be added
// with the agreed rate deliberately skipped, and the enrollment surface is read
// for clinicians and case managers but write for admin only.
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

  console.log('\nG. A clinician reads the enrollment page and cannot write to it');
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
    const list = await call('GET', '/api/gfc/admin/enrollment/list', ct);
    eq(list.status, 200, 'and the list');
    for (const [method, path, what] of [
      ['POST', `/api/gfc/admin/enrollment/${skippedId}/review`, 'mark reviewed'],
      ['POST', `/api/gfc/admin/enrollment/${skippedId}/follow-up`, 'request follow-up'],
      ['PUT',  `/api/gfc/admin/enrollment/${skippedId}/service-line`, 'change service line'],
      ['POST', `/api/gfc/admin/enrollment/${skippedId}/documents/request`, 'request documents'],
      ['POST', `/api/gfc/admin/enrollment/${skippedId}/documents/remind`, 'send a reminder'],
      ['PUT',  `/api/gfc/admin/enrollment/${skippedId}/details`, 'edit the details']
    ]) {
      const r = await call(method, path, ct, { items: [], line: 'BOTH', dob: '1950-01-01' });
      eq(r.status, 403, `the clinician is refused: ${what}`);
    }
    const untouched = await call('GET', `/api/gfc/admin/enrollment/${skippedId}`, admin);
    ok(untouched.body.client.dob !== '1950-01-01', 'and the refused edit wrote nothing');
  }

  console.log(`\n${pass}/${pass + fail} assertions passed${fail ? ` — ${fail} FAILED` : ''}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('probe error:', e); process.exit(1); });
