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
