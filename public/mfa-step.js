// ============================================================================
// mfa-step.js — the MFA step of every login (Session 5.3). Plain DOM, no
// framework, so the same file serves the unified login, the client portal,
// the admin hub, the enrollment view and the service portal.
//
//   window.GFC_MFA.complete(loginResponse) → Promise<finalResponse>
//
// Pass it whatever /api/auth/login returned. If the response already carries a
// token it resolves immediately with it. If it carries an MFA challenge it
// shows the enrolment (QR + code) or verification (code / recovery code)
// panel, posts to /api/auth/mfa/verify, shows recovery codes ONCE when they
// are issued, and resolves with the verify response ({ token, user, ... }).
// Cancelling resolves with { error: 'Sign-in cancelled' } so the caller's
// existing error path handles it.
// ============================================================================
(function () {
  const css = `
  .gfc-mfa-backdrop{position:fixed;inset:0;background:rgba(3,61,80,.55);display:flex;align-items:center;justify-content:center;z-index:9999;font-family:'DM Sans',system-ui,sans-serif;padding:16px}
  .gfc-mfa-card{background:#fff;border-radius:14px;max-width:440px;width:100%;padding:26px 26px 22px;box-shadow:0 20px 60px rgba(0,0,0,.25);color:#1f2a30}
  .gfc-mfa-card h2{margin:0 0 6px;font-size:19px;color:#033D50}
  .gfc-mfa-card p{margin:0 0 12px;font-size:13.5px;line-height:1.45;color:#3f4b52}
  .gfc-mfa-card img{display:block;margin:6px auto 10px;width:200px;height:200px;border:1px solid #e5e7eb;border-radius:8px}
  .gfc-mfa-card code{font-family:ui-monospace,Menlo,monospace;font-size:12.5px;background:#f3f4f6;padding:2px 6px;border-radius:4px;word-break:break-all}
  .gfc-mfa-card input{width:100%;box-sizing:border-box;font-size:20px;letter-spacing:.25em;text-align:center;padding:10px;border:1px solid #cbd5e1;border-radius:8px;margin:8px 0}
  .gfc-mfa-card .row{display:flex;gap:8px;justify-content:flex-end;margin-top:10px}
  .gfc-mfa-card button{font:inherit;font-weight:600;padding:9px 16px;border-radius:8px;border:1px solid #033D50;cursor:pointer}
  .gfc-mfa-card button.primary{background:#033D50;color:#fff}
  .gfc-mfa-card button.secondary{background:#fff;color:#033D50}
  .gfc-mfa-card .err{color:#b91c1c;font-size:13px;min-height:18px;margin:2px 0 0}
  .gfc-mfa-card .link{background:none;border:none;color:#033D50;text-decoration:underline;padding:0;font-weight:500;font-size:12.5px}
  .gfc-mfa-codes{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:10px 0;font-family:ui-monospace,Menlo,monospace;font-size:14px}
  .gfc-mfa-codes span{background:#f8f5ec;border:1px solid #F5CD85;border-radius:6px;padding:6px 8px;text-align:center}`;
  const ensureStyle = () => { if (!document.getElementById('gfc-mfa-style')) { const s = document.createElement('style'); s.id = 'gfc-mfa-style'; s.textContent = css; document.head.appendChild(s); } };
  const el = (tag, attrs, ...kids) => { const n = document.createElement(tag); Object.entries(attrs || {}).forEach(([k, v]) => { if (k === 'class') n.className = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v); }); kids.forEach(k => n.append(k)); return n; };

  const post = async (body) => {
    const r = await fetch('/api/auth/mfa/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    let data = null; try { data = await r.json(); } catch (e) { data = { error: `HTTP ${r.status}` }; }
    return data;
  };

  const showRecoveryCodes = (codes) => new Promise((resolve) => {
    const grid = el('div', { class: 'gfc-mfa-codes' }, ...codes.map(c => el('span', {}, c)));
    let acknowledged = false;
    const card = el('div', { class: 'gfc-mfa-card' },
      el('h2', {}, 'Save your recovery codes'),
      el('p', {}, 'These are shown once. Each works one time if you lose your phone. Store them somewhere safe and separate from your password.'),
      grid,
      el('div', { class: 'row' },
        el('button', { class: 'secondary', onclick: () => { navigator.clipboard && navigator.clipboard.writeText(codes.join('\n')).catch(() => {}); } }, 'Copy'),
        el('button', { class: 'primary', onclick: () => { acknowledged = true; back.remove(); resolve(); } }, 'I saved these')));
    const back = el('div', { class: 'gfc-mfa-backdrop' }, card);
    document.body.appendChild(back);
    void acknowledged;
  });

  const challengePanel = (resp) => new Promise((resolve) => {
    ensureStyle();
    const enroll = !!resp.mfaEnrollmentRequired;
    let useRecovery = false;
    const input = el('input', { type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', placeholder: '000000', maxlength: '14', 'aria-label': 'Verification code' });
    const err = el('div', { class: 'err' });
    const submit = el('button', { class: 'primary', type: 'submit' }, enroll ? 'Turn on and sign in' : 'Verify');
    const cancel = el('button', { class: 'secondary', type: 'button', onclick: () => { back.remove(); resolve({ error: 'Sign-in cancelled' }); } }, 'Cancel');
    const toggle = el('button', { class: 'link', type: 'button' }, 'Use a recovery code instead');
    toggle.addEventListener('click', () => { useRecovery = !useRecovery; input.value = ''; input.placeholder = useRecovery ? 'xxxx-xxxx-xxxx' : '000000'; input.setAttribute('inputmode', useRecovery ? 'text' : 'numeric'); toggle.textContent = useRecovery ? 'Use my authenticator app instead' : 'Use a recovery code instead'; input.focus(); });
    const form = el('form', { onsubmit: async (e) => {
      e.preventDefault(); err.textContent = ''; submit.disabled = true;
      const data = await post({ challenge: resp.challenge, code: input.value.trim() });
      submit.disabled = false;
      if (data && data.token) {
        back.remove();
        if (Array.isArray(data.recoveryCodes) && data.recoveryCodes.length) await showRecoveryCodes(data.recoveryCodes);
        return resolve(data);
      }
      err.textContent = (data && data.error) || 'Could not verify the code.';
      if (data && (data.code === 'MFA_CHALLENGE_EXPIRED' || data.code === 'MFA_TOO_MANY_ATTEMPTS')) { submit.disabled = true; setTimeout(() => { back.remove(); resolve({ error: data.error }); }, 1800); }
      input.select();
    } },
      enroll ? el('div', {},
        el('p', {}, 'Your role requires two-step sign-in. Scan this code with an authenticator app (Google Authenticator, Microsoft Authenticator, Authy or 1Password), then enter the 6-digit code it shows.'),
        el('img', { src: resp.qrDataUrl, alt: 'Authenticator enrolment QR code' }),
        el('p', {}, 'Cannot scan? Enter this key by hand: ', el('code', {}, resp.secret)))
      : el('p', {}, `Enter the 6-digit code from your authenticator app${resp.user && resp.user.email ? ` for ${resp.user.email}` : ''}.`),
      input, err,
      enroll ? el('span', {}) : toggle,
      el('div', { class: 'row' }, cancel, submit));
    const card = el('div', { class: 'gfc-mfa-card' }, el('h2', {}, enroll ? 'Set up two-step sign-in' : 'Two-step sign-in'), form);
    const back = el('div', { class: 'gfc-mfa-backdrop' }, card);
    document.body.appendChild(back);
    setTimeout(() => input.focus(), 50);
  });

  window.GFC_MFA = {
    complete: async (resp) => {
      if (!resp || resp.error || resp.token) return resp;
      if (resp.mfaRequired || resp.mfaEnrollmentRequired) return challengePanel(resp);
      return resp;
    }
  };
})();
