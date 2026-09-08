// Session 4.5 preflight — 8.4 alignment guards.
//
// Everything asserted here was verified against the LIVE instance on
// 2026-09-06 and then pinned as a test, because each one failed silently in
// production: a 404 that means "empty" rendered as a red error, a document
// upload keyed by the wrong id stopped filing PDFs with the failure swallowed,
// and a narrowed OAuth token showed as a healthy green "OpenEMR connected".
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const openemrSrc = fs.readFileSync(path.join(root, 'openemr.js'), 'utf8');

// ---- Scope list: the patched routes are unreachable without these ----
test('config requests the five Phase 6B scopes', () => {
  const scopes = require(path.join(root, 'config.js')).OPENEMR.SCOPES.split(/\s+/);
  for (const s of ['user/billing.read', 'user/billing.write', 'user/order.read',
    'user/order.write', 'user/codes.read']) {
    assert.ok(scopes.includes(s), `missing ${s} — the 6B routes 401 "Unauthorized" without it`);
  }
  // A token is the intersection of requested and registered, so requesting
  // fewer than the v4 client holds silently re-creates the stale-client bug.
  assert.strictEqual(scopes.length, 54, 'scope list must match the v4 client (54)');
});

test('prescription scopes are requested (8.4 native Rx write)', () => {
  const scopes = require(path.join(root, 'config.js')).OPENEMR.SCOPES.split(/\s+/);
  assert.ok(scopes.includes('user/prescription.write'));
  // 8.4 does not define this one; requesting it is harmless but recording the
  // fact stops a future session re-litigating it (orders go via the 6B route).
  assert.ok(!scopes.includes('user/procedure.write'), 'user/procedure.write does not exist on 8.4');
});

// ---- The document route is keyed by NUMERIC pid on 8.4 ----
test('uploadPatientDocument resolves a numeric pid before posting', () => {
  const fn = openemrSrc.slice(openemrSrc.indexOf('async uploadPatientDocument'));
  const body = fn.slice(0, fn.indexOf('\n    }'));
  assert.match(body, /const pid = await resolvePid\(puuid\)/,
    'must resolve the numeric pid — 8.4 answers 400 {"pid":["Invalid pid"]} for a uuid');
  assert.match(body, /patient\/\$\{pid\}\/document/, 'the path must carry the numeric pid');
  assert.doesNotMatch(body, /patient\/\$\{encodeURIComponent\(puuid\)\}\/document/,
    'the uuid-keyed path is the 7.0.4 shape and 400s on 8.4');
});

// ---- 404 means "empty", not "broken" ----
test('list reads that answer 404-when-empty return an empty array', () => {
  for (const fnName of ['getPatientAppointmentRows', 'getMedicationRows']) {
    const fn = openemrSrc.slice(openemrSrc.indexOf(`async ${fnName}`));
    const body = fn.slice(0, fn.indexOf('\n    }'));
    assert.match(body, /if \(res\.status === 404\) return \[\]/,
      `${fnName} must treat 404 as an empty list — verified live: a patient with no ` +
      'appointments answers 404 with an empty body, and without this the tab shows a red error');
  }
});

// ---- The status probe must name a scope shortfall ----
test('getStatus reports the scope shortfall by capability, not just connectivity', () => {
  const g = openemrSrc.slice(openemrSrc.indexOf('const getStatus'));
  for (const key of ['missingScopes', 'requestedScopeCount', 'nativeWriteScopes', 'billingRouteScopes']) {
    assert.match(g, new RegExp(key), `getStatus must surface ${key}`);
  }
  // The whole point: a narrowed token still connects, so `connected` alone
  // cannot be the signal.
  assert.match(g, /user\/billing\.write/, 'the billing-route check must name the 6B scopes');
});

test('the workspace renders a stale-client banner keyed to those capabilities', () => {
  const html = fs.readFileSync(path.join(root, 'public', 'clinical.html'), 'utf8');
  assert.match(html, /billingRouteScopes === false \|\| emrStatus\.nativeWriteScopes === false/,
    'the banner must fire on either shortfall');
  assert.match(html, /OpenEMR client is out of date for 8\.4/);
});

// ---- Things 4.5 must NOT do (guardrails from the session prompt) ----
test('the patient-facing care-plan PDF is never served from OpenEMR Documents', () => {
  // DocumentReference still 403s at the ACL layer; the Drive reference stands.
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const route = server.slice(server.indexOf("'/api/gfc/clinical/care-plan.pdf'"));
  const block = route.slice(0, 4000);
  assert.doesNotMatch(block, /getDocumentReferences|uploadPatientDocument/,
    'the patient download must come from client.carePlanDocs via Drive');
});

test('the FHIR bundle dedupe is still in place (8.4 still returns encounters twice)', () => {
  assert.match(openemrSrc, /const bundleResources = \(bundle\) => \{[\s\S]*?seen\.has\(key\)/,
    'verified live 2026-09-06: 28 rows for 14 encounters');
});

// ---- An expired session must send the user to login, not paint red text ----
test('auth failures carry codes a client can act on, distinct from permission 403s', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  for (const c of ['AUTH_MISSING', 'AUTH_EXPIRED', 'AUTH_INVALID', 'AUTH_INACTIVE']) {
    assert.ok(server.includes(c), `authenticateToken must emit ${c}`);
  }
  // A permission denial is a signed-in user being told no — it must NOT carry
  // an auth code, or the client would log them out for asking.
  const readOnly = server.slice(server.indexOf('CLINICAL_READ_ONLY') - 200, server.indexOf('CLINICAL_READ_ONLY') + 60);
  assert.doesNotMatch(readOnly, /AUTH_(EXPIRED|INVALID|MISSING|INACTIVE)/,
    'CLINICAL_READ_ONLY must stay distinguishable from an auth failure');
});

test('the client treats an auth-coded 403 as session expiry', () => {
  const html = fs.readFileSync(path.join(root, 'public', 'clinical.html'), 'utf8');
  assert.match(html, /AUTH_MISSING'?,\s*'AUTH_EXPIRED'?,\s*'AUTH_INVALID'?,\s*'AUTH_INACTIVE'/,
    'handleResponse must key on the auth codes — the server answers a bad JWT with 403, not 401');
  assert.match(html, /isAuthFailure/);
});

test('an unknown EMR status is not painted as a failed one', () => {
  const html = fs.readFileSync(path.join(root, 'public', 'clinical.html'), 'utf8');
  assert.match(html, /emrStatus === null \? 'bg-stone-300'/,
    'a status that has not answered yet must read neutral, not red');
});

// ---- Scope B: the charge payload must never swap CPT and ICD ----
// Phase 6B's second defect was introduced by the fix for its first: a loop
// reused the variable holding the CPT, so the charge billed the diagnosis. It
// returned 201 and looked right in Billing Manager. Pin the separation.
const R = require('../clinicalRepository.js');
const CHARGE_REC = {
  diagnoses: [{ code: 'E11.9' }, { code: 'I10' }],
  services: [{ code: '99348', codeType: 'CPT4', description: 'Home visit' },
             { code: 'G0180', codeType: 'HCPCS', description: 'Cert' }]
};

test('buildChargePayloads bills the service code, never a diagnosis', () => {
  const p = R.buildChargePayloads(CHARGE_REC, { providerId: 5 });
  assert.equal(p.length, 2, 'one line per service');
  assert.deepEqual(p.map(x => x.code), ['99348', 'G0180']);
  assert.deepEqual(p.map(x => x.code_type), ['CPT4', 'HCPCS']);
  for (const line of p) {
    const dx = line.diagnoses.map(d => d.code);
    assert.deepEqual(dx, ['E11.9', 'I10'], 'diagnoses are the ICD codes');
    assert.ok(!dx.includes(line.code), 'the billed code must never appear as its own diagnosis');
    assert.ok(!dx.some(c => ['99348', 'G0180'].includes(c)), 'no service code may leak into diagnoses');
    assert.ok(line.diagnoses.every(d => d.code_type === 'ICD10'));
  }
});

test('a service linked to specific diagnoses bills only those', () => {
  const rec = { ...CHARGE_REC, services: [{ code: '99348', codeType: 'CPT4', linkedDiagnoses: ['I10'] }] };
  const [line] = R.buildChargePayloads(rec, { providerId: 5 });
  assert.deepEqual(line.diagnoses.map(d => d.code), ['I10']);
  assert.equal(line.code, '99348');
});

test('billing_facility is never on a charge payload', () => {
  // addBilling() has no such parameter and the billing table no such column;
  // it belongs on form_encounter. Build-enforced so nobody "helpfully" adds it.
  for (const line of R.buildChargePayloads(CHARGE_REC, { providerId: 5 })) {
    assert.ok(!('billing_facility' in line), 'billing_facility must stay off the charge');
  }
  const src = fs.readFileSync(path.join(root, 'clinicalRepository.js'), 'utf8');
  const fn = src.slice(src.indexOf('const buildChargePayloads'), src.indexOf('const ORDER_STATUS_TO_EMR'));
  assert.doesNotMatch(fn, /billing_facility\s*:/, 'no billing_facility key in the charge builder');
});

test('order status maps app vocabulary to OpenEMR vocabulary', () => {
  assert.equal(R.orderStatusToEmr('ordered'), 'pending');
  assert.equal(R.orderStatusToEmr('sent'), 'routed');
  assert.equal(R.orderStatusToEmr('resulted'), 'complete');
  assert.equal(R.orderStatusToEmr('cancelled'), 'canceled');
  assert.equal(R.orderStatusToEmr('nonsense'), 'pending', 'unknown falls back to the safe start state');
});

test('charges post at sign-and-close with the signing clinician as rendering provider', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const sign = server.slice(server.indexOf("encounters/:euuid/sign'"), server.indexOf("encounters/:euuid/sign'") + 6000);
  assert.match(sign, /buildChargePayloads/, 'sign-and-close must post charges');
  assert.match(sign, /attestation\.signedBy && attestation\.signedBy\.openEmrProviderId/,
    'rendering provider is the signing clinician');
  assert.match(sign, /billing_npi_used/, 'billing provider stays the config value');
  // A charge failure must never void a signature that already succeeded.
  assert.match(sign, /chargesPosted = false/);
});
