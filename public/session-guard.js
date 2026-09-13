// ============================================================================
// session-guard.js — idle logout + sign-out-on-revocation (Session 5.3)
//
// The SERVER enforces the 15-minute idle limit (sessionStore.js); this script
// is what lets a person see it happen instead of meeting a 403 on their next
// click. Included on every signed-in page:
//   - tracks activity (pointer, keys, touch, scroll, and every authenticated
//     fetch) and, at the idle limit, posts /api/auth/logout, clears the stored
//     tokens and returns to /login?reason=idle; a banner warns one minute out
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
  let last = Date.now(); let warned = null; let done = false;

  const clearTokens = () => { TOKEN_KEYS.forEach(k => { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }); try { sessionStorage.clear(); } catch (e) { /* ignore */ } };
  const signOut = async (reason, { callServer = true } = {}) => {
    if (done) return; done = true;
    const token = ['unified_token', 'admin_token', 'portal_token'].map(k => { try { return localStorage.getItem(k); } catch (e) { return null; } }).find(Boolean);
    if (callServer && token) { try { await fetch('/api/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${token}` } }); } catch (e) { /* the server-side idle rule catches it anyway */ } }
    clearTokens();
    window.location.replace(`/login?reason=${encodeURIComponent(reason)}`);
  };
  const touch = () => { last = Date.now(); if (warned) { warned.remove(); warned = null; } };
  ['pointerdown', 'keydown', 'touchstart', 'scroll', 'mousemove'].forEach(ev => window.addEventListener(ev, touch, { passive: true }));

  const showWarning = (secondsLeft) => {
    if (warned) return;
    warned = document.createElement('div');
    warned.setAttribute('role', 'alert');
    warned.style.cssText = 'position:fixed;left:50%;bottom:18px;transform:translateX(-50%);background:#033D50;color:#fff;padding:10px 16px;border-radius:10px;font:13px/1.4 "DM Sans",system-ui,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.3);z-index:9998;display:flex;gap:12px;align-items:center';
    const text = document.createElement('span'); text.textContent = `You will be signed out in about ${secondsLeft}s for inactivity.`;
    const btn = document.createElement('button'); btn.textContent = 'Stay signed in'; btn.style.cssText = 'background:#F5CD85;color:#033D50;border:none;border-radius:6px;padding:6px 10px;font-weight:600;cursor:pointer';
    btn.addEventListener('click', touch);
    warned.append(text, btn); document.body.appendChild(warned);
  };
  setInterval(() => {
    if (!anyToken()) return;
    const idle = Date.now() - last;
    if (idle >= IDLE_MS) return signOut('idle');
    if (idle >= IDLE_MS - WARN_MS) showWarning(Math.max(1, Math.round((IDLE_MS - idle) / 1000)));
  }, 5000);

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
          if (data && AUTH_CODES.includes(data.code)) signOut(data.code.toLowerCase().replace('auth_', ''), { callServer: false });
        } catch (e) { /* not JSON */ }
      }
    }
    return res;
  };
})();
