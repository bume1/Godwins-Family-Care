// ============================================================================
// session-guard.js — idle logout + sign-out-on-revocation (Session 5.3)
// + the activity heartbeat that keeps a genuinely active session alive
// (owner report, 2026-09-23: "boots me to login if beyond 15 min" — on SAVE,
// with no warning first).
//
// The SERVER enforces the 15-minute idle limit (sessionStore.js), and it
// judges idleness by ITS OWN clock: `lastSeenAt` only moves when an
// authenticated REQUEST reaches it. This script's own clock judges idleness
// by pointer/key/touch/scroll events. Those two clocks did not agree: someone
// filling out a long form — typing, nothing to save yet — resets THIS
// script's clock on every keystroke and never shows the warning, while the
// server's `lastSeenAt` sits untouched because no request has gone out. The
// two clocks disagree in exactly the wrong direction: the person who is
// unmistakably present gets no warning and, the moment they finally click
// Save, is handed AUTH_IDLE and thrown to the login screen with the form
// gone — the discrepancy IS the bug, not a coincidence.
//
// The fix is not a longer timeout — 15 minutes of TRUE idleness is the
// HIPAA-driven rule and stays exactly as short. It is that local activity
// now periodically tells the server "this session is not idle" the same way
// a real request would, so the server's clock and the person's actual
// presence agree. `/api/auth/heartbeat` does nothing but pass through
// `authenticateToken`, which is what touches `lastSeenAt` on the real
// session row — this file is the ONE place included on every signed-in
// page, so the fix reaches every form in the app without touching any of
// them individually.
//
// Included on every signed-in page:
//   - tracks activity (pointer, keys, touch, scroll, and every authenticated
//     fetch) and, at the idle limit, posts /api/auth/logout, clears the stored
//     tokens and returns to /login?reason=idle; a banner warns one minute out
//   - while there has been recent activity, pings the heartbeat at most once
//     per touch-throttle window so the SERVER session stays alive for exactly
//     as long as the person genuinely is — never while truly idle, since the
//     ping only fires off the same activity clock the local warning uses
//   - watches fetch responses for the auth-family codes the server sends
//     (AUTH_IDLE, AUTH_REVOKED, AUTH_EXPIRED, AUTH_INVALID, AUTH_MFA_REQUIRED,
//     AUTH_INACTIVE) and signs out the same way, so a revoked session cannot
//     keep rendering stale PHI from memory
// Idle minutes come from data-idle-minutes on the script tag (default 15).
// ============================================================================
(function () {
  const script = document.currentScript;
  const IDLE_MIN = Number((script && script.getAttribute('data-idle-minutes')) || 15);
  const IDLE_MS = IDLE_MIN * 60 * 1000;
  const WARN_MS = 60 * 1000;
  const TOKEN_KEYS = ['unified_token', 'admin_token', 'portal_token', 'unified_user', 'admin_user', 'portal_user'];
  const AUTH_CODES = ['AUTH_IDLE', 'AUTH_REVOKED', 'AUTH_EXPIRED', 'AUTH_INVALID', 'AUTH_MFA_REQUIRED', 'AUTH_INACTIVE'];
  const anyToken = () => TOKEN_KEYS.slice(0, 3).some(k => { try { return !!localStorage.getItem(k); } catch (e) { return false; } });
  const getStoredToken = () => ['unified_token', 'admin_token', 'portal_token'].map(k => { try { return localStorage.getItem(k); } catch (e) { return null; } }).find(Boolean);
  let last = Date.now(); let warned = null; let done = false;

  const clearTokens = () => { TOKEN_KEYS.forEach(k => { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }); try { sessionStorage.clear(); } catch (e) { /* ignore */ } };
  const signOut = async (reason, { callServer = true, why = null } = {}) => {
    if (done) return; done = true;
    const token = getStoredToken();
    if (callServer && token) { try { await fetch('/api/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${token}` } }); } catch (e) { /* the server-side idle rule catches it anyway */ } }
    clearTokens();
    window.location.replace(`/login?reason=${encodeURIComponent(reason)}${why ? `&why=${encodeURIComponent(why)}` : ''}`);
  };
  const touch = () => { last = Date.now(); if (warned) { warned.remove(); warned = null; } };
  ['pointerdown', 'keydown', 'touchstart', 'scroll', 'mousemove'].forEach(ev => window.addEventListener(ev, touch, { passive: true }));

  // Keeps the SERVER's session alive for as long as this clock says the
  // person is present. `sessions.js`'s own touch is throttled to once a
  // minute, so pinging any more often than that would be wasted requests —
  // HEARTBEAT_MS matches it. This never fires once the person has crossed
  // into the warning window: at that point they are genuinely idle by this
  // script's own definition, and the 15-minute rule is meant to catch them.
  const HEARTBEAT_MS = 60 * 1000;
  let lastHeartbeat = 0;
  const sendHeartbeat = () => {
    const token = getStoredToken();
    if (!token) return;
    lastHeartbeat = Date.now();
    fetch('/api/auth/heartbeat', { headers: { Authorization: `Bearer ${token}` } }).catch(() => { /* a missed beat is not fatal — the next one tries again */ });
  };

  const showWarning = (secondsLeft) => {
    if (warned) return;
    warned = document.createElement('div');
    warned.setAttribute('role', 'alert');
    warned.style.cssText = 'position:fixed;left:50%;bottom:18px;transform:translateX(-50%);background:#033D50;color:#fff;padding:10px 16px;border-radius:10px;font:13px/1.4 "DM Sans",system-ui,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.3);z-index:9998;display:flex;gap:12px;align-items:center';
    const text = document.createElement('span'); text.textContent = `You will be signed out in about ${secondsLeft}s for inactivity.`;
    const btn = document.createElement('button'); btn.textContent = 'Stay signed in'; btn.style.cssText = 'background:#F5CD85;color:#033D50;border:none;border-radius:6px;padding:6px 10px;font-weight:600;cursor:pointer';
    // touch() alone only resets THIS script's clock — the explicit click is
    // exactly the moment to also tell the server directly, rather than
    // waiting for the next 5-second tick to notice and beat the throttle.
    btn.addEventListener('click', () => { touch(); sendHeartbeat(); });
    warned.append(text, btn); document.body.appendChild(warned);
  };
  setInterval(() => {
    if (!anyToken()) return;
    const idle = Date.now() - last;
    if (idle >= IDLE_MS) return signOut('idle');
    if (idle >= IDLE_MS - WARN_MS) { showWarning(Math.max(1, Math.round((IDLE_MS - idle) / 1000))); return; }
    // Genuinely active (below the warning window) — keep the server's own
    // idle clock in agreement with this one, throttled to the same window
    // the server itself uses so this adds one request a minute at most.
    if (Date.now() - lastHeartbeat >= HEARTBEAT_MS) sendHeartbeat();
  }, 5000);

  // A page with no stored token still sends the header — `Bearer ${getToken()}`
  // with nothing in localStorage goes out as the literal string "Bearer null".
  // The server cannot tell that from a forged token, so it answers the same
  // AUTH_INVALID a genuinely bad session gets, and the person lands on
  // `?reason=invalid` reading that their session went wrong when the truth is
  // that this browser never had one. That ambiguity is what made a sign-out on
  // one screen look like a second bug on the next.
  const MISSING = ['null', 'undefined', ''];
  const bearerIsMissing = (auth) => {
    const m = /^Bearer\s*(.*)$/i.exec(String(auth || ''));
    return !!m && MISSING.includes(m[1].trim());
  };

  // Auth-family responses → sign out. Only responses to requests that carried
  // a bearer token are considered, so a public page is never bounced.
  const realFetch = window.fetch;
  window.fetch = async function (input, init) {
    const headers = (init && init.headers) || {};
    const auth = headers.Authorization || headers.authorization || (typeof Headers !== 'undefined' && headers instanceof Headers ? headers.get('Authorization') : null);
    const res = await realFetch.apply(this, arguments);
    if (auth) {
      touch();
      if (res.status === 401 || res.status === 403) {
        try {
          const data = await res.clone().json();
          if (data && AUTH_CODES.includes(data.code)) {
            // `detail` names WHICH of the server's several routes to this code
            // fired, and it rides into the URL so the next person reads the
            // cause off the address bar instead of guessing. It is a fixed
            // vocabulary of layer names — never a value, never a token.
            const why = typeof data.detail === 'string' && /^[a-z_]{1,40}$/.test(data.detail) ? data.detail : null;
            // What the BROWSER sent outranks what the server guessed from it:
            // the server saw an unverifiable token either way, but only this
            // side knows there was never a credential to send.
            signOut(data.code.toLowerCase().replace('auth_', ''), {
              callServer: false,
              why: bearerIsMissing(auth) ? 'no_token_in_browser' : why
            });
          }
        } catch (e) { /* not JSON */ }
      }
    }
    return res;
  };
})();
