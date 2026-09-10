// ============================================================================
// emrAuth.js — per-user OpenEMR authorization (Session 5.2)
//
// Replaces the dev-window password grant. Each clinician signs in to OpenEMR
// AS THEMSELVES through OAuth2 authorization_code + PKCE (S256); the app holds
// their refresh token server-side, encrypted at rest, and mints access tokens
// from it. The browser never sees an OpenEMR token: the only thing it carries
// is the redirect to OpenEMR's own login page and back.
//
// Why this is the attribution fix and not a convenience: every clinical write
// now reaches OpenEMR under the acting clinician's own OpenEMR user, so the
// EMR's audit log, note author and encounter provider name the person who did
// the work — the chain the shadow-data audit found broken at all three joints.
//
// State rows:
//   emr_oauth_state:<state>   { userId, verifier, redirectUri, createdAt, expiresAt }   single-use, 10 min
//   emr_user_token:<userId>   { userId, refreshToken*, accessToken*, expiresAt, scopes, emrUser, connectedAt, ... }
// * encrypted with AES-256-GCM under EMR_TOKEN_ENCRYPTION_KEY (32 bytes,
//   hex or base64). Production refuses to boot without it (config.js).
// ============================================================================

'use strict';
const crypto = require('crypto');

const STATE_TTL_MS = 10 * 60 * 1000;
const REFRESH_MARGIN_MS = 60 * 1000;
const STATE_PREFIX = 'emr_oauth_state:';
const TOKEN_PREFIX = 'emr_user_token:';

class EmrAuthError extends Error {
  constructor(message, code, status = 409, extra) {
    super(message); this.name = 'EmrAuthError'; this.code = code; this.status = status; Object.assign(this, extra || {});
  }
}

// ---- Encryption at rest ------------------------------------------------------
const parseKey = (raw) => {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (/^[0-9a-fA-F]{64}$/.test(s)) return Buffer.from(s, 'hex');
  const b = Buffer.from(s, 'base64');
  if (b.length === 32) return b;
  throw new Error('EMR_TOKEN_ENCRYPTION_KEY must be 32 bytes, as 64 hex chars or base64');
};
const encrypt = (key, plain) => {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return `v1.${iv.toString('base64')}.${c.getAuthTag().toString('base64')}.${enc.toString('base64')}`;
};
const decrypt = (key, packed) => {
  const [v, iv, tag, enc] = String(packed || '').split('.');
  if (v !== 'v1') throw new Error('unrecognised token ciphertext');
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(enc, 'base64')), d.final()]).toString('utf8');
};

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const pkcePair = () => {
  const verifier = b64url(crypto.randomBytes(48));               // 64 chars, within 43–128
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
};

// ---- Factory -----------------------------------------------------------------
// deps: { store, config, fetch?, now?, logger? }
//   config.OPENEMR: BASE_URL, SITE, CLIENT_ID, CLIENT_SECRET, REDIRECT_URI, SCOPES, TOKEN_ENCRYPTION_KEY
const createEmrAuth = (deps) => {
  const { store, config } = deps;
  const fetchImpl = deps.fetch || globalThis.fetch;
  const now = deps.now || (() => Date.now());
  const O = config.OPENEMR;
  const base = () => String(O.BASE_URL || '').replace(/\/+$/, '');
  const site = () => O.SITE || 'default';
  const authorizeUrl = () => `${base()}/oauth2/${site()}/authorize`;
  const tokenUrl = () => `${base()}/oauth2/${site()}/token`;
  const userinfoUrl = () => `${base()}/oauth2/${site()}/userinfo`;

  let keyCache;
  const key = () => {
    if (keyCache !== undefined) return keyCache;
    keyCache = parseKey(O.TOKEN_ENCRYPTION_KEY);
    if (!keyCache) throw new EmrAuthError('EMR_TOKEN_ENCRYPTION_KEY is not set — per-user OpenEMR tokens cannot be stored', 'EMR_TOKEN_KEY_MISSING', 503);
    return keyCache;
  };

  const missingConfig = () => [
    ['OPENEMR_BASE_URL', O.BASE_URL], ['OPENEMR_CLIENT_ID', O.CLIENT_ID], ['OPENEMR_CLIENT_SECRET', O.CLIENT_SECRET],
    ['OPENEMR_REDIRECT_URI', O.REDIRECT_URI], ['EMR_TOKEN_ENCRYPTION_KEY', O.TOKEN_ENCRYPTION_KEY]
  ].filter(([, v]) => !String(v || '').trim()).map(([n]) => n);

  const scopeList = () => String(O.SCOPES || '').split(/\s+/).filter(Boolean);

  // ---- 1. Begin: build the authorize URL, remember state + verifier ----
  const beginAuthorization = async (user) => {
    const missing = missingConfig();
    if (missing.length) throw new EmrAuthError(`OpenEMR is not configured: ${missing.join(', ')}`, 'EMR_NOT_CONFIGURED', 503, { missing });
    if (!user || !user.id) throw new EmrAuthError('A signed-in app user is required', 'EMR_AUTH_NO_USER', 401);
    const state = b64url(crypto.randomBytes(32));
    const { verifier, challenge } = pkcePair();
    const createdAt = new Date(now()).toISOString();
    await store.set(`${STATE_PREFIX}${state}`, {
      userId: user.id, verifier, redirectUri: O.REDIRECT_URI, createdAt,
      expiresAt: new Date(now() + STATE_TTL_MS).toISOString()
    });
    const q = new URLSearchParams({
      response_type: 'code', client_id: O.CLIENT_ID, redirect_uri: O.REDIRECT_URI,
      scope: scopeList().join(' '), state, code_challenge: challenge, code_challenge_method: 'S256'
    });
    return { url: `${authorizeUrl()}?${q.toString()}`, state };
  };

  const postForm = async (url, form) => {
    const res = await fetchImpl(url, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(), signal: AbortSignal.timeout(20000)
    });
    let data = null; try { data = await res.json(); } catch { /* non-JSON */ }
    return { status: res.status, data };
  };

  const fetchUserinfo = async (accessToken) => {
    try {
      const res = await fetchImpl(userinfoUrl(), { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(15000) });
      if (res.status !== 200) return null;
      const u = await res.json();
      // OpenEMR's userinfo carries sub plus, for the `profile` scope, name
      // fields; `preferred_username` is the OpenEMR login when present.
      return { sub: u.sub || null, username: u.preferred_username || u.username || null, name: u.name || [u.given_name, u.family_name].filter(Boolean).join(' ') || null, email: u.email || null };
    } catch { return null; }
  };

  const storeTokens = async (userId, data, prior) => {
    const k = key();
    const scopes = String(data.scope || (prior && prior.scopes && prior.scopes.join(' ')) || '').split(/\s+/).filter(Boolean);
    const expiresAt = new Date(now() + Math.max(120, Number(data.expires_in) || 3600) * 1000).toISOString();
    const row = {
      userId,
      accessToken: encrypt(k, data.access_token),
      refreshToken: data.refresh_token ? encrypt(k, data.refresh_token) : (prior && prior.refreshToken) || null,
      expiresAt, scopes,
      emrUser: (prior && prior.emrUser) || null,
      connectedAt: (prior && prior.connectedAt) || new Date(now()).toISOString(),
      lastRefreshedAt: new Date(now()).toISOString(),
      disconnectedAt: null, disconnectReason: null
    };
    await store.set(`${TOKEN_PREFIX}${userId}`, row);
    return row;
  };

  // ---- 2. Complete: the redirect back. State is single-use and bound to the user ----
  const completeAuthorization = async ({ state, code, error, errorDescription }) => {
    if (error) throw new EmrAuthError(`OpenEMR refused the authorization: ${error}${errorDescription ? ` (${errorDescription})` : ''}`, 'EMR_AUTH_DENIED', 400);
    if (!state || !code) throw new EmrAuthError('The callback carried no state or code', 'EMR_AUTH_BAD_CALLBACK', 400);
    const stateKey = `${STATE_PREFIX}${state}`;
    const pending = await store.get(stateKey);
    if (pending) await store.delete(stateKey);                   // single use, deleted before the exchange
    if (!pending) throw new EmrAuthError('Unknown or already-used authorization state', 'EMR_AUTH_STATE_UNKNOWN', 400);
    if (new Date(pending.expiresAt).getTime() < now()) throw new EmrAuthError('The authorization request expired — start again', 'EMR_AUTH_STATE_EXPIRED', 400);
    const { status, data } = await postForm(tokenUrl(), {
      grant_type: 'authorization_code', client_id: O.CLIENT_ID, client_secret: O.CLIENT_SECRET,
      redirect_uri: pending.redirectUri, code, code_verifier: pending.verifier
    });
    if (status !== 200 || !data || !data.access_token) {
      const hint = data && (data.error_description || data.error);
      throw new EmrAuthError(`OpenEMR token exchange failed (HTTP ${status}${hint ? `: ${hint}` : ''})`, 'EMR_AUTH_EXCHANGE_FAILED', 502);
    }
    const emrUser = await fetchUserinfo(data.access_token);
    const row = await storeTokens(pending.userId, data, { emrUser });
    if (emrUser) { row.emrUser = emrUser; await store.set(`${TOKEN_PREFIX}${pending.userId}`, row); }
    return { userId: pending.userId, emrUser, scopes: row.scopes, expiresAt: row.expiresAt, hasRefreshToken: !!row.refreshToken };
  };

  // ---- 3. Use: a live access token for this app user ----
  const inFlight = new Map();
  const markDisconnected = async (userId, row, reason) => {
    await store.set(`${TOKEN_PREFIX}${userId}`, { ...row, accessToken: null, refreshToken: null, disconnectedAt: new Date(now()).toISOString(), disconnectReason: reason });
  };
  const refresh = async (userId, row) => {
    const k = key();
    const { status, data } = await postForm(tokenUrl(), {
      grant_type: 'refresh_token', client_id: O.CLIENT_ID, client_secret: O.CLIENT_SECRET, refresh_token: decrypt(k, row.refreshToken)
    });
    if (status !== 200 || !data || !data.access_token) {
      const hint = data && (data.error_description || data.error);
      // A refused refresh means the grant is gone (revoked in OpenEMR, expired,
      // password changed). The clinician must sign in to OpenEMR again; nothing
      // the app can do silently, and it must not fall back to anything shared.
      await markDisconnected(userId, row, `refresh refused (HTTP ${status}${hint ? `: ${hint}` : ''})`);
      throw new EmrAuthError('Your OpenEMR sign-in has lapsed. Connect your OpenEMR account again.', 'EMR_RECONNECT_REQUIRED', 409);
    }
    return storeTokens(userId, data, row);
  };
  const getAccessTokenFor = async (userId) => {
    if (!userId) throw new EmrAuthError('No app user to act as', 'EMR_AUTH_NO_USER', 401);
    const row = await store.get(`${TOKEN_PREFIX}${userId}`);
    if (!row || (!row.accessToken && !row.refreshToken)) {
      throw new EmrAuthError('Connect your OpenEMR account to open charts.', row && row.disconnectReason ? 'EMR_RECONNECT_REQUIRED' : 'EMR_NOT_CONNECTED', 409);
    }
    const k = key();
    if (row.accessToken && new Date(row.expiresAt).getTime() - REFRESH_MARGIN_MS > now()) {
      return { accessToken: decrypt(k, row.accessToken), emrUser: row.emrUser, scopes: row.scopes };
    }
    if (!row.refreshToken) {
      await markDisconnected(userId, row, 'access token expired and no refresh token was granted (offline_access scope missing?)');
      throw new EmrAuthError('Your OpenEMR sign-in has expired. Connect your OpenEMR account again.', 'EMR_RECONNECT_REQUIRED', 409);
    }
    if (!inFlight.has(userId)) {
      inFlight.set(userId, refresh(userId, row).finally(() => inFlight.delete(userId)));
    }
    const fresh = await inFlight.get(userId);
    return { accessToken: decrypt(k, fresh.accessToken), emrUser: fresh.emrUser, scopes: fresh.scopes };
  };
  // After a 401 from OpenEMR: forget the access token so the next call refreshes.
  const invalidateAccessToken = async (userId) => {
    const row = await store.get(`${TOKEN_PREFIX}${userId}`);
    if (row && row.accessToken) await store.set(`${TOKEN_PREFIX}${userId}`, { ...row, accessToken: null, expiresAt: new Date(0).toISOString() });
  };
  const disconnect = async (userId) => {
    const row = await store.get(`${TOKEN_PREFIX}${userId}`);
    if (row) await markDisconnected(userId, row, 'disconnected by the user');
    return !!row;
  };

  // What the workspace shows. Never a token value.
  const NOT_ECHOED = new Set(['api:oemr', 'api:fhir']);
  const statusFor = async (userId) => {
    const row = userId ? await store.get(`${TOKEN_PREFIX}${userId}`) : null;
    const connected = !!(row && (row.accessToken || row.refreshToken));
    const granted = (row && row.scopes) || [];
    const requested = scopeList();
    const has = (...names) => names.every(n => granted.includes(n));
    return {
      connected,
      emrUser: (row && row.emrUser) || null,
      connectedAt: (row && row.connectedAt) || null,
      lastRefreshedAt: (row && row.lastRefreshedAt) || null,
      expiresAt: (row && row.expiresAt) || null,
      disconnectReason: (row && row.disconnectReason) || null,
      grantedScopeCount: granted.length,
      requestedScopeCount: requested.length,
      missingScopes: connected ? requested.filter(sc => !granted.includes(sc) && !NOT_ECHOED.has(sc)) : [],
      appointmentScopes: connected ? has('user/appointment.read', 'user/appointment.write') : null,
      nativeWriteScopes: connected ? has('user/prescription.read', 'user/prescription.write') : null,
      billingRouteScopes: connected ? has('user/billing.read', 'user/billing.write', 'user/order.read', 'user/order.write', 'user/codes.read') : null
    };
  };

  // Housekeeping: expired state rows (a user who never came back).
  const sweepExpiredState = async () => {
    let n = 0;
    for (const k of await store.list(STATE_PREFIX)) {
      const row = await store.get(k);
      if (!row || new Date(row.expiresAt).getTime() < now()) { await store.delete(k); n++; }
    }
    return n;
  };

  return { beginAuthorization, completeAuthorization, getAccessTokenFor, invalidateAccessToken, disconnect, statusFor, missingConfig, sweepExpiredState,
    _internal: { encrypt, decrypt, parseKey, pkcePair, STATE_PREFIX, TOKEN_PREFIX } };
};

module.exports = { createEmrAuth, EmrAuthError, _internal: { encrypt, decrypt, parseKey, pkcePair, b64url, STATE_PREFIX, TOKEN_PREFIX, STATE_TTL_MS } };
