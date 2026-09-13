// ============================================================
// Session 5.2 — per-user OpenEMR auth: build-fail guards
//
//   1. The password grant is GONE: no grant_type=password, no API user env,
//      no shared token state anywhere in the transport, config or server.
//   2. authorization_code + PKCE (S256): the authorize URL carries a
//      challenge, the exchange sends the matching verifier, and state is
//      single-use and bound to the app user who began the flow.
//   3. Tokens are stored ENCRYPTED and are never in the status payload.
//   4. Refresh happens server-side from the user's own refresh token; a
//      refused refresh marks the user disconnected and asks them to sign in
//      again — never falls back to anything shared.
//   5. The transport runs every call under the acting user's token and a
//      user with no token gets EMR_NOT_CONNECTED, not a 500 and not someone
//      else's token.
//   6. The 4.4 service-account attribution clause is retired.
// ============================================================
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dataStore = require('../dataStore');
const { createEmrAuth, EmrAuthError, _internal } = require('../emrAuth');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const KEY = crypto.randomBytes(32).toString('hex');
const CFG = { OPENEMR: { BASE_URL: 'https://emr.example.test/', SITE: 'default', CLIENT_ID: 'cid', CLIENT_SECRET: 'csecret',
  REDIRECT_URI: 'https://app.example.test/oauth/callback', SCOPES: 'openid offline_access api:oemr user/Patient.read user/appointment.read user/appointment.write', TOKEN_ENCRYPTION_KEY: KEY } };

// A fake OpenEMR token + userinfo endpoint that records what it was asked.
const fakeEmr = (opts = {}) => {
  const calls = [];
  const fetch = async (url, init) => {
    const u = String(url);
    if (u.endsWith('/oauth2/default/token')) {
      const form = Object.fromEntries(new URLSearchParams(init.body));
      calls.push({ url: u, form });
      if (opts.refuse && opts.refuse(form)) return { status: 400, json: async () => ({ error: 'invalid_grant', error_description: 'refused' }) };
      const n = calls.length;
      return { status: 200, json: async () => ({ access_token: `AT${n}`, refresh_token: form.grant_type === 'refresh_token' && opts.noRotate ? undefined : `RT${n}`, expires_in: 3600, scope: 'openid offline_access user/Patient.read user/appointment.read user/appointment.write', token_type: 'Bearer' }) };
    }
    if (u.endsWith('/oauth2/default/userinfo')) {
      calls.push({ url: u, auth: init.headers.Authorization });
      return { status: 200, json: async () => ({ sub: 'sub-bethel', preferred_username: 'bgodwins', name: 'Bethel Godwins' }) };
    }
    throw new Error(`unexpected fetch ${u}`);
  };
  return { fetch, calls };
};
const setup = (opts) => {
  const store = dataStore.createStore({ adapter: 'memory', env: { NODE_ENV: 'test' } });
  const emr = fakeEmr(opts);
  let t = Date.parse('2026-09-10T12:00:00.000Z');
  const auth = createEmrAuth({ store, config: CFG, fetch: emr.fetch, now: () => t });
  return { store, emr, auth, tick: (ms) => { t += ms; } };
};

// ---- 1. password grant gone ----
test('no password grant, API user, or shared token state remains in the transport, config, or server', () => {
  for (const f of ['openemr.js', 'config.js', 'server.js', 'emrAuth.js']) {
    const src = read(f);
    assert.doesNotMatch(src, /grant_type:\s*['"]password['"]/, `${f} still requests the password grant`);
    assert.doesNotMatch(src, /OPENEMR_API_USERNAME|OPENEMR_API_PASSWORD|API_USERNAME|API_PASSWORD/, `${f} still reads the dev-window API user`);
  }
  const o = read('openemr.js');
  assert.doesNotMatch(o, /passwordGrant|tokenState|authInFlight/, 'shared token state must be gone from openemr.js');
  assert.match(o, /setTokenProvider/, 'the transport takes an injected per-user token provider');
  assert.doesNotMatch(read('server.js'), /probe_emr_auth|installProbeToken/, 'the probe token helper is for scripts only');
  assert.match(read('server.js'), /openemr\.setTokenProvider\(emrTokenProvider\)/);
  assert.match(read('server.js'), /openemr\.getStatus\(req\.user\)/, 'status is per user');
});
test('every rawRequest in the transport carries the actor, so no call can run without a user token', () => {
  const o = read('openemr.js');
  const calls = o.match(/rawRequest\(\{[^}]*?method/gs) || [];
  assert.ok(calls.length >= 20, `expected many rawRequest calls, found ${calls.length}`);
  for (const c of calls) assert.match(c, /actor/, `rawRequest without actor: ${c.slice(0, 60)}`);
});

// ---- 2. PKCE + state ----
test('beginAuthorization builds an S256 PKCE authorize URL and stores single-use state bound to the user', async () => {
  const { store, auth } = setup();
  const { url, state } = await auth.beginAuthorization({ id: 'u-bethel' });
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, 'https://emr.example.test/oauth2/default/authorize');
  assert.equal(u.searchParams.get('response_type'), 'code');
  assert.equal(u.searchParams.get('client_id'), 'cid');
  assert.equal(u.searchParams.get('redirect_uri'), CFG.OPENEMR.REDIRECT_URI);
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(u.searchParams.get('state'), state);
  assert.match(u.searchParams.get('scope'), /offline_access/, 'offline_access is what earns a refresh token');
  const row = await store.get(`emr_oauth_state:${state}`);
  assert.equal(row.userId, 'u-bethel');
  const expected = crypto.createHash('sha256').update(row.verifier).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.equal(u.searchParams.get('code_challenge'), expected, 'challenge is the SHA-256 of the stored verifier');
});
test('completeAuthorization exchanges the code with the verifier, stores tokens encrypted, records the OpenEMR user, and burns the state', async () => {
  const { store, emr, auth } = setup();
  const { state } = await auth.beginAuthorization({ id: 'u-bethel' });
  const verifier = (await store.get(`emr_oauth_state:${state}`)).verifier;
  const result = await auth.completeAuthorization({ state, code: 'CODE1' });
  const exchange = emr.calls.find(c => c.form && c.form.grant_type === 'authorization_code');
  assert.deepEqual(exchange.form, { grant_type: 'authorization_code', client_id: 'cid', client_secret: 'csecret', redirect_uri: CFG.OPENEMR.REDIRECT_URI, code: 'CODE1', code_verifier: verifier });
  assert.equal(result.userId, 'u-bethel');
  assert.deepEqual(result.emrUser, { sub: 'sub-bethel', username: 'bgodwins', name: 'Bethel Godwins', email: null });
  assert.equal(result.hasRefreshToken, true);
  assert.equal(await store.get(`emr_oauth_state:${state}`), null, 'state is single-use');
  const row = await store.get('emr_user_token:u-bethel');
  assert.ok(row.accessToken.startsWith('v1.') && row.refreshToken.startsWith('v1.'), 'ciphertext, not plaintext');
  assert.ok(!JSON.stringify(row).includes('AT1') && !JSON.stringify(row).includes('RT1'), 'no plaintext token in the store');
  assert.equal(_internal.decrypt(Buffer.from(KEY, 'hex'), row.refreshToken), 'RT1');
  await assert.rejects(auth.completeAuthorization({ state, code: 'CODE1' }), (e) => e.code === 'EMR_AUTH_STATE_UNKNOWN', 'replaying the callback is refused');
});
test('an expired state, a denied authorization, and a refused exchange each fail with their own code and store nothing', async () => {
  const { store, auth, tick } = setup({ refuse: (f) => f.code === 'BAD' });
  const { state } = await auth.beginAuthorization({ id: 'u1' });
  tick(11 * 60 * 1000);
  await assert.rejects(auth.completeAuthorization({ state, code: 'x' }), (e) => e.code === 'EMR_AUTH_STATE_EXPIRED');
  await assert.rejects(auth.completeAuthorization({ state: 'zzz', code: 'x', error: 'access_denied' }), (e) => e.code === 'EMR_AUTH_DENIED');
  const s2 = (await auth.beginAuthorization({ id: 'u1' })).state;
  await assert.rejects(auth.completeAuthorization({ state: s2, code: 'BAD' }), (e) => e.code === 'EMR_AUTH_EXCHANGE_FAILED');
  assert.equal(await store.get('emr_user_token:u1'), null);
});

// ---- 3./4. tokens per user, refresh, disconnect ----
test('getAccessTokenFor returns the user\'s own token, refreshes from their refresh token when expired, and never crosses users', async () => {
  const { emr, auth, tick } = setup();
  const s1 = (await auth.beginAuthorization({ id: 'u1' })).state; await auth.completeAuthorization({ state: s1, code: 'c1' });
  const s2 = (await auth.beginAuthorization({ id: 'u2' })).state; await auth.completeAuthorization({ state: s2, code: 'c2' });
  const t1 = await auth.getAccessTokenFor('u1'); const t2 = await auth.getAccessTokenFor('u2');
  assert.notEqual(t1.accessToken, t2.accessToken);
  assert.equal(t1.emrUser.username, 'bgodwins');
  const refreshesBefore = emr.calls.filter(c => c.form && c.form.grant_type === 'refresh_token').length;
  tick(3600 * 1000);                                     // past expiry
  const t1b = await auth.getAccessTokenFor('u1');
  const refreshes = emr.calls.filter(c => c.form && c.form.grant_type === 'refresh_token');
  assert.equal(refreshes.length, refreshesBefore + 1);
  assert.equal(refreshes[refreshes.length - 1].form.refresh_token, 'RT1', 'u1 refreshed with u1\'s refresh token');
  assert.notEqual(t1b.accessToken, t1.accessToken);
  await assert.rejects(auth.getAccessTokenFor('nobody'), (e) => e instanceof EmrAuthError && e.code === 'EMR_NOT_CONNECTED' && e.status === 409);
});
test('concurrent expired calls share ONE refresh', async () => {
  const { emr, auth, tick } = setup();
  const s = (await auth.beginAuthorization({ id: 'u1' })).state; await auth.completeAuthorization({ state: s, code: 'c' });
  tick(3600 * 1000);
  await Promise.all([auth.getAccessTokenFor('u1'), auth.getAccessTokenFor('u1'), auth.getAccessTokenFor('u1')]);
  assert.equal(emr.calls.filter(c => c.form && c.form.grant_type === 'refresh_token').length, 1);
});
test('a refused refresh disconnects the user with EMR_RECONNECT_REQUIRED; disconnect forgets tokens; status never carries a token', async () => {
  const { store, auth, tick } = setup({ refuse: (f) => f.grant_type === 'refresh_token' });
  const s = (await auth.beginAuthorization({ id: 'u1' })).state; await auth.completeAuthorization({ state: s, code: 'c' });
  tick(3600 * 1000);
  await assert.rejects(auth.getAccessTokenFor('u1'), (e) => e.code === 'EMR_RECONNECT_REQUIRED');
  const st = await auth.statusFor('u1');
  assert.equal(st.connected, false); assert.match(st.disconnectReason, /refresh refused/);
  assert.equal(st.emrUser.username, 'bgodwins', 'who it WAS is kept for the banner');
  await assert.rejects(auth.getAccessTokenFor('u1'), (e) => e.code === 'EMR_RECONNECT_REQUIRED');
  const { auth: a2, store: st2 } = setup();
  const s2 = (await a2.beginAuthorization({ id: 'u9' })).state; await a2.completeAuthorization({ state: s2, code: 'c' });
  const status = await a2.statusFor('u9');
  assert.equal(status.connected, true); assert.equal(status.appointmentScopes, true); assert.equal(status.grantedScopeCount, 5);
  assert.deepEqual(status.missingScopes, [], 'api:oemr is never echoed and must not read as missing');
  assert.ok(!JSON.stringify(status).match(/AT\d|RT\d|v1\./), 'no token material in status');
  assert.equal(await a2.disconnect('u9'), true);
  assert.equal((await a2.statusFor('u9')).connected, false);
  await assert.rejects(a2.getAccessTokenFor('u9'), (e) => e.code === 'EMR_RECONNECT_REQUIRED');
  const row = await st2.get('emr_user_token:u9'); assert.equal(row.refreshToken, null); assert.equal(row.accessToken, null);
});
test('the encryption key is required, 32 bytes, and a store row cannot be read with a different key', () => {
  assert.equal(_internal.parseKey(''), null);
  assert.throws(() => _internal.parseKey('too-short'), /32 bytes/);
  const k1 = Buffer.from(KEY, 'hex'); const k2 = crypto.randomBytes(32);
  const c = _internal.encrypt(k1, 'secret');
  assert.equal(_internal.decrypt(k1, c), 'secret');
  assert.throws(() => _internal.decrypt(k2, c));
  const store = dataStore.createStore({ adapter: 'memory', env: { NODE_ENV: 'test' } });
  const auth = createEmrAuth({ store, config: { OPENEMR: { ...CFG.OPENEMR, TOKEN_ENCRYPTION_KEY: '' } }, fetch: async () => { throw new Error('no'); } });
  assert.deepEqual(auth.missingConfig(), ['EMR_TOKEN_ENCRYPTION_KEY']);
});

// ---- 5. transport: per-user token, EMR_NOT_CONNECTED ----
test('the transport asks the provider for the ACTING user\'s token on every call and surfaces EMR_NOT_CONNECTED', async () => {
  process.env.OPENEMR_BASE_URL = process.env.OPENEMR_BASE_URL || 'https://emr.example.test';
  process.env.OPENEMR_CLIENT_ID = process.env.OPENEMR_CLIENT_ID || 'cid';
  process.env.OPENEMR_CLIENT_SECRET = process.env.OPENEMR_CLIENT_SECRET || 'cs';
  process.env.OPENEMR_REDIRECT_URI = process.env.OPENEMR_REDIRECT_URI || 'https://app.example.test/oauth/callback';
  process.env.EMR_TOKEN_ENCRYPTION_KEY = process.env.EMR_TOKEN_ENCRYPTION_KEY || KEY;
  delete require.cache[require.resolve('../config')]; delete require.cache[require.resolve('../openemr')];
  const openemr = require('../openemr');
  const asked = [];
  const provider = async (actor) => {
    asked.push(actor && actor.id);
    if (actor.id === 'ghost') throw Object.assign(new Error('Connect your OpenEMR account'), { code: 'EMR_NOT_CONNECTED', status: 409 });
    return { accessToken: `token-for-${actor.id}`, emrUser: { username: actor.id }, scopes: [] };
  };
  provider.invalidate = async () => {};
  openemr.setTokenProvider(provider);
  const realFetch = global.fetch; const seen = [];
  global.fetch = async (url, init) => { seen.push(init.headers.Authorization); return { status: 200, text: async () => JSON.stringify({ resourceType: 'Bundle', entry: [] }) }; };
  try {
    await openemr.forActor({ id: 'bethel' }).searchPatients({});
    await openemr.forActor({ id: 'thanmayie' }).searchPatients({});
    assert.deepEqual(seen, ['Bearer token-for-bethel', 'Bearer token-for-thanmayie']);
    await assert.rejects(openemr.forActor({ id: 'ghost' }).searchPatients({}), (e) => e.name === 'OpenEmrError' && e.code === 'EMR_NOT_CONNECTED' && e.status === 409);
    assert.deepEqual(asked, ['bethel', 'thanmayie', 'ghost']);
  } finally { global.fetch = realFetch; }
});

// ---- 6. attribution interim retired ----
test('the note header no longer claims a service-account write, and the constant is gone', () => {
  const R = require('../clinicalRepository');
  const h = R.buildAttributionHeader({ name: 'Bethel Godwins', licenseLevel: 'FNP', npi: '1902310568' }, 'gfc-app-api');
  assert.doesNotMatch(h, /service account/);
  assert.match(h, /Bethel Godwins, FNP \(NPI 1902310568\)/, 'the author line stays');
  assert.doesNotMatch(read('server.js'), /OPENEMR_SERVICE_ACCOUNT/);
  assert.doesNotMatch(read('clinicalRepository.js'), /attributed to service account/);
});
