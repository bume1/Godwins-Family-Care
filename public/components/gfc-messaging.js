/* ============================================================================
 * GFC Messaging — a mountable thread component (Session 9)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * MOUNT CONTRACT
 * ─────────────────────────────────────────────────────────────────────────────
 *   Load:   <script src="/components/gfc-messaging.js"></script>
 *   Mount:  window.GFCMessaging.mount('some-element-id', {
 *             userId:        me.id,     // display and bookkeeping only
 *             role:          'client',  // display only; the server decides
 *             scopeClientId: null,      // staff: whose threads to show
 *             authToken:     token,     // what actually authorizes
 *             onUnread:      (n) => {}  // optional badge callback
 *           });
 *   Unmount: window.GFCMessaging.unmount('some-element-id');
 *
 * `userId` and `role` are for RENDERING. Every route below resolves the caller
 * from the TOKEN and applies the visibility rules server-side, so passing
 * someone else's id or a role you do not hold changes nothing you can read. The
 * component hides what you cannot see; the server refuses it. Two independent
 * gates over one rule, which is the same shape Session 6 used for the visit-log
 * schema — hiding a thing client-side is styling, refusing it is the control.
 *
 * No framework. Plain DOM, so it drops into the React portals (React 18 +
 * Babel) without a second copy of React and without a build step, and into the
 * caregiver app the same way. Brand tokens scoped under `.gfcm`.
 *
 * DELIBERATELY NOT BUILT (brief): attachments, read receipts beyond a per-user
 * read mark, typing indicators, realtime push. In-app plus the existing
 * notification queue only.
 * ==========================================================================*/

(function (global) {
  'use strict';

  var API = global.location.origin;
  var instances = Object.create(null);

  var CSS = [
    '.gfcm{--navy:#033D50;--gold:#F5CD85;--goldd:#C9A44A;--cream:#FAF7F2;--ink:#1a2a32;--mut:#41555f;--red:#A32D2D;--green:#0f6e56;--line:#e5ddcb;font-size:16px;line-height:1.5;color:var(--ink)}',
    '.gfcm *{box-sizing:border-box}',
    '.gfcm h3{font-family:"Cormorant Garamond",Georgia,serif;font-size:19px;color:var(--navy);font-weight:600;margin:0 0 8px}',
    '.gfcm .mcard{background:#fff;border:1px solid var(--line);border-radius:12px;padding:14px 15px;margin-bottom:12px}',
    '.gfcm .mrow{display:block;width:100%;text-align:left;background:none;border:none;border-bottom:1px solid #ece6db;padding:12px 0;cursor:pointer;font-family:inherit;font-size:15px}',
    '.gfcm .mrow:last-child{border-bottom:none}',
    '.gfcm .mrow:hover{background:#faf8f3}',
    '.gfcm .mtop{display:flex;justify-content:space-between;gap:10px;align-items:baseline}',
    '.gfcm .mlabel{font-weight:600;color:var(--navy)}',
    '.gfcm .mmu{font-size:14px;color:var(--mut)}',
    '.gfcm .mprev{font-size:14px;color:var(--mut);margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.gfcm .mbadge{background:var(--gold);color:var(--navy);border-radius:11px;padding:1px 8px;font-size:12px;font-weight:700}',
    '.gfcm .mchip{display:inline-block;border-radius:20px;padding:2px 9px;font-size:12px;font-weight:600;background:#eef2f4;color:var(--navy)}',
    '.gfcm .mchip.awaiting_response{background:#fdf0e0;color:#8a5a12}',
    '.gfcm .mchip.acknowledged{background:#e7edf0;color:var(--navy)}',
    '.gfcm .mchip.responded{background:#e3f0ea;color:var(--green)}',
    '.gfcm .mchip.closed{background:#eee;color:#555}',
    '.gfcm .mbub{border-radius:12px;padding:10px 13px;margin-bottom:9px;max-width:88%}',
    '.gfcm .mbub.them{background:#f2eee5;border:1px solid var(--line)}',
    '.gfcm .mbub.me{background:var(--navy);color:var(--cream);margin-left:auto}',
    '.gfcm .mwho{font-size:13px;font-weight:600;margin-bottom:2px}',
    '.gfcm .mbub.them .mwho{color:var(--navy)}',
    '.gfcm .mbub.me .mwho{color:var(--gold)}',
    '.gfcm .mwhen{font-size:12px;opacity:.7;margin-top:3px}',
    '.gfcm .mbtn{border-radius:9px;padding:11px 14px;font-size:15px;font-weight:600;cursor:pointer;font-family:inherit;border:1px solid var(--navy);background:var(--navy);color:var(--cream)}',
    '.gfcm .mbtn.gold{background:var(--gold);border-color:var(--gold);color:var(--navy)}',
    '.gfcm .mbtn.ghost{background:#fff;color:var(--navy)}',
    '.gfcm .mbtn[disabled]{opacity:.5;cursor:not-allowed}',
    '.gfcm .mbtns{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}',
    '.gfcm textarea,.gfcm select,.gfcm input{width:100%;border:1px solid #d8cdb8;border-radius:9px;padding:10px 12px;font-size:16px;font-family:inherit;background:#fff;color:var(--ink)}',
    '.gfcm textarea{min-height:88px;resize:vertical}',
    '.gfcm label{display:block;font-size:13px;font-weight:600;color:var(--navy);margin:9px 0 4px}',
    '.gfcm .mnote{background:var(--cream);border:1.5px dashed var(--goldd);border-radius:10px;padding:11px 12px;margin:9px 0;font-size:14px;color:var(--mut)}',
    '.gfcm .mnote b{color:var(--navy);display:block}',
    '.gfcm .merr{background:#fdeaea;border:1px solid #f0c0c0;color:var(--red);border-radius:9px;padding:10px 12px;font-size:14px;margin-bottom:10px}',
    '.gfcm .mok{background:#e8f2ee;border:1px solid #bfdccf;color:var(--green);border-radius:9px;padding:10px 12px;font-size:14px;margin-bottom:10px}',
    '.gfcm .mempty{text-align:center;color:var(--mut);padding:22px 10px;font-size:15px}',
    '.gfcm .mdis{opacity:.62}'
  ].join('\n');

  function injectCss() {
    if (document.getElementById('gfcm-css')) return;
    var el = document.createElement('style');
    el.id = 'gfcm-css';
    el.textContent = CSS;
    document.head.appendChild(el);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fmtWhen(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var today = new Date();
    var sameDay = d.toDateString() === today.toDateString();
    return sameDay
      ? d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
      : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' · ' +
        d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }

  function api(state, path, opts) {
    opts = opts || {};
    return fetch(API + path, {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + state.authToken },
      body: opts.body ? JSON.stringify(opts.body) : undefined
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) {
          var err = new Error((data && data.error) || 'Request failed (' + res.status + ')');
          err.code = data && data.code;
          err.status = res.status;
          throw err;
        }
        return data;
      });
    });
  }

  // ---- Render --------------------------------------------------------------
  function render(state) {
    var root = document.getElementById(state.elementId);
    if (!root) return;
    root.className = 'gfcm';

    var html = '';
    if (state.error) html += '<div class="merr">' + esc(state.error) + '</div>';
    if (state.notice) html += '<div class="mok">' + esc(state.notice) + '</div>';

    if (state.loading) {
      html += '<div class="mempty">Loading messages…</div>';
    } else if (state.view === 'thread') {
      html += renderThread(state);
    } else if (state.view === 'compose') {
      html += renderCompose(state);
    } else {
      html += renderList(state);
    }
    root.innerHTML = html;
    bind(state, root);
  }

  function renderList(state) {
    var openable = state.channels.filter(function (c) { return c.available; });
    var blocked = state.channels.filter(function (c) { return !c.available; });

    var html = '<div class="mcard"><h3>Messages</h3>';
    if (!state.threads.length) {
      html += '<div class="mempty">No conversations yet.</div>';
    } else {
      html += state.threads.map(function (t) {
        return '<button class="mrow" data-open="' + esc(t.id) + '">' +
          '<div class="mtop"><span class="mlabel">' + esc(t.channelLabel) + '</span>' +
          '<span class="mmu">' + esc(fmtWhen(t.lastMessageAt)) +
          (t.unread ? ' <span class="mbadge">' + t.unread + '</span>' : '') + '</span></div>' +
          '<div class="mmu">' + esc(t.clientName || '') +
          (t.responseStatus ? ' · <span class="mchip ' + esc(t.responseStatus) + '">' +
            esc(t.responseStatus.replace(/_/g, ' ')) + '</span>' : '') + '</div>' +
          '<div class="mprev">' + esc(t.lastMessagePreview) + '</div>' +
          '</button>';
      }).join('');
    }
    html += '</div>';

    if (openable.length) {
      html += '<div class="mcard"><h3>Start a message</h3>' +
        '<div class="mbtns">' + openable.map(function (c) {
          return '<button class="mbtn ghost" data-compose="' + esc(c.id) + '">' + esc(c.label) + '</button>';
        }).join('') + '</div></div>';
    }

    // A channel that is off is SHOWN, disabled, with the reason. Hiding it
    // leaves someone hunting for a button that is not there.
    if (blocked.length) {
      html += '<div class="mcard mdis"><h3>Not available yet</h3>' +
        blocked.map(function (c) {
          return '<div class="mnote"><b>' + esc(c.label) + '</b>' + esc(c.reason || '') + '</div>';
        }).join('') + '</div>';
    }
    return html;
  }

  function renderCompose(state) {
    var c = state.channels.filter(function (x) { return x.id === state.composeChannel; })[0] || {};
    return '<div class="mcard">' +
      '<h3>' + esc(c.label || 'New message') + '</h3>' +
      '<p class="mmu">' + esc(c.blurb || '') + '</p>' +
      (c.code ? '<div class="mnote"><b>Before you send</b>' + esc(c.reason || '') + '</div>' : '') +
      '<label>Message</label><textarea data-field="body" maxlength="4000"></textarea>' +
      '<div class="mbtns">' +
      '<button class="mbtn gold" data-send="1">Send</button>' +
      '<button class="mbtn ghost" data-back="1">Cancel</button>' +
      '</div></div>';
  }

  function renderThread(state) {
    var t = state.thread || {};
    var canMoveStatus = t.responseStatus && (state.role === 'clinical' || state.role === 'admin');
    var html = '<div class="mcard">' +
      '<div class="mbtns" style="margin:0 0 10px"><button class="mbtn ghost" data-back="1">← All messages</button></div>' +
      '<h3>' + esc(t.channelLabel || 'Conversation') + '</h3>' +
      '<div class="mmu">' + esc(t.clientName || '') +
      (t.responseStatus ? ' · <span class="mchip ' + esc(t.responseStatus) + '">' +
        esc(t.responseStatus.replace(/_/g, ' ')) + '</span>' : '') + '</div>';

    html += '<div style="margin-top:12px">' + state.messages.map(function (m) {
      return '<div class="mbub ' + (m.mine ? 'me' : 'them') + '">' +
        '<div class="mwho">' + esc(m.from) + (m.isPoa ? '' : ' · ' + esc(m.fromRoleLabel)) + '</div>' +
        '<div>' + esc(m.body).replace(/\n/g, '<br>') + '</div>' +
        '<div class="mwhen">' + esc(fmtWhen(m.sentAt)) + '</div>' +
        '</div>';
    }).join('') + '</div>';

    if (state.canPost) {
      html += '<label>Reply</label><textarea data-field="body" maxlength="4000"></textarea>' +
        '<div class="mbtns"><button class="mbtn gold" data-reply="1">Send reply</button></div>';
    } else {
      html += '<div class="mnote"><b>You cannot reply here</b>' + esc(state.cannotPostReason || '') + '</div>';
    }

    if (canMoveStatus) {
      html += '<div class="mbtns" style="border-top:1px solid #ece6db;padding-top:10px;margin-top:12px">' +
        ['acknowledged', 'responded', 'closed'].map(function (s) {
          return '<button class="mbtn ghost" data-status="' + s + '">Mark ' + s.replace(/_/g, ' ') + '</button>';
        }).join('') + '</div>';
    }
    return html + '</div>';
  }

  // ---- Bind ----------------------------------------------------------------
  function bind(state, root) {
    var val = function () {
      var el = root.querySelector('[data-field="body"]');
      return el ? el.value : '';
    };
    var go = function (p) {
      state.error = '';
      state.notice = '';
      return p.catch(function (err) { state.error = err.message; render(state); });
    };

    root.querySelectorAll('[data-open]').forEach(function (b) {
      b.onclick = function () { go(openThread(state, b.getAttribute('data-open'))); };
    });
    root.querySelectorAll('[data-compose]').forEach(function (b) {
      b.onclick = function () {
        state.composeChannel = b.getAttribute('data-compose');
        state.view = 'compose';
        state.error = '';
        render(state);
      };
    });
    var back = root.querySelector('[data-back]');
    if (back) back.onclick = function () { state.view = 'list'; state.error = ''; refresh(state); };

    var send = root.querySelector('[data-send]');
    if (send) send.onclick = function () {
      var body = val();
      send.disabled = true;
      go(api(state, '/api/messaging/threads', {
        method: 'POST',
        body: { channel: state.composeChannel, clientId: state.scopeClientId || undefined, body: body }
      }).then(function (res) {
        state.view = 'list';
        state.notice = res.notice || 'Message sent.';
        return refresh(state);
      })).then(function () { send.disabled = false; });
    };

    var reply = root.querySelector('[data-reply]');
    if (reply) reply.onclick = function () {
      var body = val();
      reply.disabled = true;
      go(api(state, '/api/messaging/threads/' + state.thread.id + '/messages', { method: 'POST', body: { body: body } })
        .then(function () { return openThread(state, state.thread.id); }))
        .then(function () { reply.disabled = false; });
    };

    root.querySelectorAll('[data-status]').forEach(function (b) {
      b.onclick = function () {
        go(api(state, '/api/messaging/threads/' + state.thread.id + '/response-status', {
          method: 'POST', body: { status: b.getAttribute('data-status') }
        }).then(function () { return openThread(state, state.thread.id); }));
      };
    });
  }

  // ---- Data ----------------------------------------------------------------
  function openThread(state, id) {
    return api(state, '/api/messaging/threads/' + id).then(function (res) {
      state.thread = res.thread;
      state.messages = res.messages || [];
      state.canPost = !!res.canPost;
      state.cannotPostReason = res.cannotPostReason;
      state.view = 'thread';
      state.loading = false;
      render(state);
      reportUnread(state);
    });
  }

  function refresh(state) {
    var q = state.scopeClientId ? '?clientId=' + encodeURIComponent(state.scopeClientId) : '';
    return Promise.all([
      api(state, '/api/messaging/threads' + q),
      api(state, '/api/messaging/channels' + q)
    ]).then(function (r) {
      state.threads = r[0].threads || [];
      state.channels = r[1].channels || [];
      state.loading = false;
      render(state);
      reportUnread(state);
    });
  }

  function reportUnread(state) {
    if (typeof state.onUnread !== 'function') return;
    var n = state.threads.reduce(function (a, t) { return a + (t.unread || 0); }, 0);
    try { state.onUnread(n); } catch (e) { /* a host callback must not break the panel */ }
  }

  // ---- Public API ----------------------------------------------------------
  function mount(elementId, options) {
    options = options || {};
    if (!elementId) throw new Error('gfc-messaging: an element id is required');
    if (!options.authToken) throw new Error('gfc-messaging: authToken is required');
    injectCss();

    var state = {
      elementId: elementId,
      userId: options.userId || null,
      role: options.role || null,
      scopeClientId: options.scopeClientId || null,
      authToken: options.authToken,
      onUnread: options.onUnread || null,
      view: 'list',
      loading: true,
      error: '', notice: '',
      threads: [], channels: [], messages: [],
      thread: null, canPost: false, cannotPostReason: null,
      composeChannel: null
    };
    instances[elementId] = state;
    render(state);
    refresh(state).catch(function (err) {
      state.loading = false;
      state.error = err.message;
      render(state);
    });
    return {
      refresh: function () { return refresh(state); },
      unmount: function () { unmount(elementId); }
    };
  }

  function unmount(elementId) {
    var root = document.getElementById(elementId);
    if (root) root.innerHTML = '';
    delete instances[elementId];
  }

  global.GFCMessaging = { mount: mount, unmount: unmount };
})(typeof window !== 'undefined' ? window : this);
