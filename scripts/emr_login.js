#!/usr/bin/env node
// scripts/emr_login.js — obtain a per-user OpenEMR token from a terminal
// (Session 5.2), for the live probe scripts and for the go-live acceptance.
//
//   OPENEMR_BASE_URL=… OPENEMR_CLIENT_ID=… OPENEMR_CLIENT_SECRET=… \
//   OPENEMR_REDIRECT_URI=https://app.godwinsfamilycarellc.com/oauth/callback \
//   EMR_TOKEN_ENCRYPTION_KEY=<any 32 bytes hex> node scripts/emr_login.js
//
// 1. It prints an authorize URL. Open it in a browser and sign in to OpenEMR
//    as YOURSELF (MFA and all). OpenEMR redirects to the registered callback.
// 2. Paste the full redirected URL (or just `code=…&state=…`) back here.
// 3. It exchanges the code (PKCE) and prints the access token, its expiry and
//    the OpenEMR user it belongs to. Nothing is written to disk.
// The token is a live credential for YOUR OpenEMR account — treat it like a
// password, export it into the probe's environment, and let it expire.
'use strict';
const readline = require('readline');
const config = require('../config');
const dataStore = require('../dataStore');
const { createEmrAuth } = require('../emrAuth');
(async () => {
  const store = dataStore.createStore({ adapter: 'memory', env: { NODE_ENV: 'development' } });
  const auth = createEmrAuth({ store, config });
  const missing = auth.missingConfig();
  if (missing.length) { console.error(`Missing env: ${missing.join(', ')}`); process.exit(2); }
  const { url, state } = await auth.beginAuthorization({ id: 'terminal' });
  console.log('\nOpen this URL and sign in to OpenEMR as yourself:\n\n' + url + '\n');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const pasted = await new Promise(r => rl.question('Paste the redirected URL here: ', r)); rl.close();
  const q = new URLSearchParams(pasted.includes('?') ? pasted.slice(pasted.indexOf('?') + 1) : pasted);
  if (q.get('state') !== state) { console.error('State mismatch — the pasted redirect is not from this run.'); process.exit(1); }
  const result = await auth.completeAuthorization({ state: q.get('state'), code: q.get('code'), error: q.get('error'), errorDescription: q.get('error_description') });
  const { accessToken } = await auth.getAccessTokenFor('terminal');
  console.log(`\nSigned in as OpenEMR user: ${result.emrUser ? `${result.emrUser.username || '?'} (${result.emrUser.name || 'no name'})` : 'unknown (userinfo unavailable)'}`);
  console.log(`Scopes granted: ${result.scopes.length}   refresh token: ${result.hasRefreshToken ? 'yes' : 'NO — offline_access missing'}   expires: ${result.expiresAt}`);
  console.log(`\nexport OPENEMR_PROBE_ACCESS_TOKEN='${accessToken}'`);
  console.log(`export OPENEMR_PROBE_EMR_USERNAME='${(result.emrUser && result.emrUser.username) || ''}'\n`);
})().catch(e => { console.error(e.message); process.exit(1); });
