// scripts/lib/probe_emr_auth.js — how a LIVE probe gets an OpenEMR token now
// that the password grant is gone (Session 5.2).
//
// The app never holds a shared token, so a probe runs as a real OpenEMR user:
//   1. node scripts/emr_login.js        → prints the authorize URL, takes the
//      pasted redirect, exchanges the code, prints the tokens ONCE
//   2. OPENEMR_PROBE_ACCESS_TOKEN=… OPENEMR_PROBE_EMR_USERNAME=… node scripts/verify_*.js
// This helper installs a token provider that answers with that token. It is
// for scripts only — server.js never requires it (build-enforced).
'use strict';
module.exports.installProbeToken = (openemr) => {
  const accessToken = process.env.OPENEMR_PROBE_ACCESS_TOKEN;
  const username = process.env.OPENEMR_PROBE_EMR_USERNAME || 'probe';
  if (!accessToken) {
    console.error('OPENEMR_PROBE_ACCESS_TOKEN is required: obtain one with `node scripts/emr_login.js` (authorization_code as a real OpenEMR user).');
    process.exit(2);
  }
  const provider = async () => ({ accessToken, emrUser: { username, name: username, sub: null }, scopes: [] });
  provider.invalidate = async () => {};
  provider.statusFor = async () => ({ connected: true, emrUser: { username } });
  openemr.setTokenProvider(provider);
};
