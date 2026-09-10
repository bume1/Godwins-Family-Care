#!/usr/bin/env node
// ============================================================================
// scripts/verify_emr_authcode.js — LIVE acceptance for Session 5.2, run by a
// person with an OpenEMR login (the build sandbox cannot drive OpenEMR's login
// page, and must not hold anyone's OpenEMR password).
//
//   OPENEMR_BASE_URL=… OPENEMR_CLIENT_ID=… OPENEMR_CLIENT_SECRET=… \
//   OPENEMR_REDIRECT_URI=https://app.godwinsfamilycarellc.com/oauth/callback \
//   EMR_TOKEN_ENCRYPTION_KEY=<64 hex> node scripts/verify_emr_authcode.js
//
// What it proves, asserting STORED VALUES read back, never status codes:
//   1. authorization_code + PKCE completes against the live instance and
//      returns a refresh token (offline_access honoured)
//   2. userinfo names the OpenEMR user you signed in as
//   3. a TEST-DATA soap note written through the app transport reads back
//      with `user` = that OpenEMR username — attribution is native, not a
//      stamp in the note text
//   4. a refresh mints a new access token from YOUR refresh token
//   5. the password grant is refused by the server (owner turned the global
//      off) — reported, not asserted, because it is an OpenEMR setting
// TEST DATA ONLY: writes one soap note to TEST PatientOne's first encounter.
// ============================================================================
'use strict';
const readline = require('readline');
const config = require('../config');
const dataStore = require('../dataStore');
const { createEmrAuth } = require('../emrAuth');
const openemr = require('../openemr');
const TEST_PUUID = process.env.OPENEMR_TEST_PUUID || 'a284d5c2-670e-4a62-aa95-2d1aa629003c';
let pass = 0, fail = 0;
const ok = (c, l, x) => { c ? (pass++, console.log('  PASS  ' + l)) : (fail++, console.log('  FAIL  ' + l + (x !== undefined ? ' :: ' + JSON.stringify(x).slice(0, 300) : ''))); };
const ask = (q) => new Promise(r => { const rl = readline.createInterface({ input: process.stdin, output: process.stdout }); rl.question(q, a => { rl.close(); r(a); }); });
(async () => {
  const store = dataStore.createStore({ adapter: 'memory', env: { NODE_ENV: 'development' } });
  const auth = createEmrAuth({ store, config });
  const missing = auth.missingConfig();
  if (missing.length) { console.error(`Missing env: ${missing.join(', ')}`); process.exit(2); }
  const actor = { id: 'live-probe', name: 'Session 5.2 live probe', role: 'admin' };
  const provider = (a) => auth.getAccessTokenFor(a.id);
  provider.invalidate = (a) => auth.invalidateAccessToken(a.id);
  provider.statusFor = (a) => auth.statusFor(a.id);
  openemr.setTokenProvider(provider);

  const { url, state } = await auth.beginAuthorization(actor);
  console.log('\n1. Open this URL, sign in to OpenEMR AS YOURSELF, approve the scopes:\n\n' + url + '\n');
  const pasted = await ask('2. Paste the full redirected URL (it will start with the redirect URI): ');
  const q = new URLSearchParams(pasted.includes('?') ? pasted.slice(pasted.indexOf('?') + 1) : pasted);
  ok(q.get('state') === state, 'redirect carries the state this run issued (CSRF binding)');
  const result = await auth.completeAuthorization({ state: q.get('state'), code: q.get('code'), error: q.get('error'), errorDescription: q.get('error_description') });
  ok(result.hasRefreshToken, 'refresh token granted (offline_access)');
  ok(!!(result.emrUser && result.emrUser.username), 'userinfo names the OpenEMR user', result.emrUser);
  const username = result.emrUser && result.emrUser.username;
  console.log(`   signed in as OpenEMR user "${username}" — ${result.scopes.length} scopes`);
  const st = await auth.statusFor(actor.id);
  ok(st.connected && st.missingScopes.length === 0, `status: connected, no missing scopes`, st.missingScopes);

  const emr = openemr.forActor(actor);
  const encs = await emr.getEncounters(TEST_PUUID);
  ok(encs.length > 0, 'TEST PatientOne encounter list reads under the user token');
  const euuid = encs[0].id;
  const stamp = new Date().toISOString();
  const note = { subjective: `(TEST DATA) Session 5.2 authorization_code attribution probe ${stamp}`, objective: 'Probe only — no examination.', assessment: 'Probe only.', plan: 'Delete after review.' };
  const written = await emr.addSoapNote(TEST_PUUID, euuid, note);
  const sid = written && (written.sid || written.id);
  ok(!!sid, 'soap note write returned a sid', written);
  const back = sid ? await emr.getSoapNote(TEST_PUUID, euuid, sid) : null;
  const row = Array.isArray(back) ? back[0] : back;
  ok(row && String(row.subjective || '').includes(stamp), 'STORED: the note reads back by sid');
  ok(row && username && String(row.user || '') === String(username), `STORED: form row user = "${username}" (native attribution, not a stamp)`, row && { user: row.user, groupname: row.groupname });

  await auth.invalidateAccessToken(actor.id);
  const t2 = await auth.getAccessTokenFor(actor.id);
  ok(!!t2.accessToken, 'refresh from the stored refresh token minted a new access token');

  // Password grant should now be OFF (owner action 9.1 step 4). Report only.
  try {
    const res = await fetch(`${config.OPENEMR.BASE_URL.replace(/\/+$/, '')}/oauth2/${config.OPENEMR.SITE || 'default'}/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'password', client_id: config.OPENEMR.CLIENT_ID, client_secret: 'x', user_role: 'users', username: 'nobody', password: 'nobody', scope: 'openid' }).toString()
    });
    const body = await res.json().catch(() => ({}));
    const off = res.status === 400 && /unsupported_grant_type|grant type is not enabled|unauthorized_client/i.test(JSON.stringify(body));
    console.log(`  ${off ? 'INFO ' : 'WARN '} password grant ${off ? 'is DISABLED on the server (good)' : `still answers HTTP ${res.status} ${JSON.stringify(body).slice(0, 120)} — turn "Enable OAuth2 Password Grant" OFF (Master Setup Guide 9.1 step 4)`}`);
  } catch (e) { console.log(`  INFO  password-grant check skipped: ${e.message}`); }

  console.log(`\n${pass}/${pass + fail} checks passed.`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
