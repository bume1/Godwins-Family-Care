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
 *             scopeClientId: null,      // staff: whose threads to show. PASSING
 *                                       // one fixes the scope and removes the
 *                                       // picker; leaving it null lets a staff
 *                                       // user choose from the clients they
 *                                       // cover (the server decides which).
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
 * FORMATTED TEXT AND ATTACHMENTS (owner, 2026-09-29). A message is composed in a
 * small rich-text editor (bold, italic, underline, bullets, numbers, heading —
 * the six shapes in /note-format.js, which the host page must load; without it
 * the composer falls back to plain text). What is SENT is that markup, never
 * HTML, and it is rendered by the same escaping renderer, so nothing a person
 * types can become live markup. Up to five PDF/JPEG/PNG files ride along; they
 * are opened through the app with the caller's token, never a public link. The
 * server types every file by its bytes and refuses what it does not recognise,
 * so the checks here are a convenience, not the control.
 *
 * A message written before formatting existed is PLAIN TEXT and is shown as
 * such — it is never run through the formatter.
 *
 * DELIBERATELY NOT BUILT (brief): read receipts beyond a per-user read mark,
 * typing indicators, realtime push. In-app plus the existing notification queue
 * only.
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
    '.gfcm .mdis{opacity:.62}',
    // formatted message text (mirrors the note formatting), the editor, attachments
    '.gfcm .mfmt{font-size:15px;line-height:1.5;word-wrap:break-word}',
    '.gfcm .mfmt ul{list-style:disc;padding-left:1.25rem;margin:2px 0}',
    '.gfcm .mfmt ol{list-style:decimal;padding-left:1.4rem;margin:2px 0}',
    '.gfcm .mfmt h3{font-family:inherit;font-size:15px;font-weight:700;margin:4px 0 2px;color:inherit}',
    '.gfcm .mfmt strong{font-weight:700}.gfcm .mfmt em{font-style:italic}.gfcm .mfmt u{text-decoration:underline}',
    '.gfcm .mfmtbar{display:flex;flex-wrap:wrap;gap:5px;margin:4px 0 6px}',
    '.gfcm .mfmtb{border:1px solid var(--line);background:#fff;border-radius:7px;min-width:34px;height:32px;padding:0 9px;font-size:14px;color:var(--navy);cursor:pointer;font-family:inherit}',
    '.gfcm .mfmtb:hover{background:var(--cream)}',
    '.gfcm .meditor{min-height:96px;border:1px solid #d8cdb8;border-radius:9px;padding:10px 12px;background:#fff;color:var(--ink);outline:none;white-space:pre-wrap}',
    '.gfcm .meditor:focus{border-color:var(--goldd)}',
    '.gfcm .meditor:empty::before{content:attr(data-placeholder);color:#a8a29e}',
    '.gfcm .matts{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}',
    '.gfcm .matt{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--line);background:var(--cream);border-radius:20px;padding:4px 10px;font-size:13px;color:var(--navy);cursor:pointer;font-family:inherit;max-width:100%}',
    '.gfcm .matt .mnm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:220px}',
    '.gfcm .mbub.me .matt{background:rgba(250,247,242,.14);border-color:rgba(245,205,133,.5);color:var(--cream)}',
    '.gfcm .mattx{border:none;background:none;font-size:16px;line-height:1;color:var(--mut);cursor:pointer;padding:0 2px}',
    '.gfcm .mfile{display:inline-block;cursor:pointer}'
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

  var MAX_FILES = 5;
  var MAX_BYTES = 10 * 1024 * 1024;
  var FMT_TOOLS = [
    ['bold', '<b>B</b>', 'Bold'], ['italic', '<i>I</i>', 'Italic'], ['underline', '<u>U</u>', 'Underline'],
    ['insertUnorderedList', '&bull; List', 'Bulleted list'], ['insertOrderedList', '1. List', 'Numbered list'], ['heading', 'H', 'Heading']
  ];
  function NF() { return global.GFC_NOTE_FORMAT || null; }
  function newDraft() { return { markup: '', plain: '', files: [] }; }
  function fmtSize(n) {
    if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
    if (n >= 1024) return Math.round(n / 1024) + ' KB';
    return n + ' B';
  }

  // The body of a message as it should be SHOWN. A message with no format is
  // plain text (esc + line breaks) and never touches the formatter; a markup
  // message goes through the escaping renderer.
  function messageHtml(m) {
    var nf = NF();
    if (m.format === 'markup' && nf) return '<div class="mfmt">' + nf.renderHtml(m.body || '') + '</div>';
    return '<div>' + esc(m.body).replace(/\n/g, '<br>') + '</div>';
  }

  function attachmentsHtml(m) {
    if (!m.attachments || !m.attachments.length) return '';
    return '<div class="matts">' + m.attachments.map(function (a) {
      return '<button type="button" class="matt" data-att="' + esc(m.id) + '|' + esc(a.id) + '" data-att-name="' + esc(a.name) + '" title="Open ' + esc(a.name) + '">' +
        '&#128206; <span class="mnm">' + esc(a.name) + '</span> <span class="mmu">' + esc(fmtSize(a.size || 0)) + '</span></button>';
    }).join('') + '</div>';
  }

  // The composer. `state.draft` is the source of truth, so a re-render (an error,
  // a refresh) never loses what somebody typed — the plain textarea it replaces
  // did, on every failed send.
  function renderEditor(state) {
    var nf = NF();
    var d = state.draft;
    var html = '';
    if (nf) {
      html += '<div class="mfmtbar" role="toolbar" aria-label="Format your message">' + FMT_TOOLS.map(function (t) {
        return '<button type="button" class="mfmtb" data-fmt="' + t[0] + '" title="' + t[2] + '" aria-label="' + t[2] + '">' + t[1] + '</button>';
      }).join('') + '</div>' +
        '<div class="meditor mfmt" data-editor="1" contenteditable="true" role="textbox" aria-multiline="true" aria-label="Message" data-placeholder="Write your message"></div>';
    } else {
      html += '<textarea data-field="body" maxlength="4000">' + esc(d.plain || '') + '</textarea>';
    }
    html += '<div class="matts">' + d.files.map(function (f, i) {
      return '<span class="matt">&#128206; <span class="mnm">' + esc(f.name) + '</span> <span class="mmu">' + esc(fmtSize(f.size)) + '</span>' +
        '<button type="button" class="mattx" data-remove-file="' + i + '" aria-label="Remove ' + esc(f.name) + '">&times;</button></span>';
    }).join('') + '</div>';
    html += '<div class="mbtns" style="align-items:center"><label class="mbtn ghost mfile">Attach a file' +
      '<input type="file" data-files="1" multiple accept="application/pdf,image/jpeg,image/png,.pdf,.jpg,.jpeg,.png" hidden></label>' +
      '<span class="mmu">PDF, JPEG or PNG &middot; up to ' + MAX_FILES + ' files, 10 MB each</span></div>';
    return html;
  }

  // Read the editor (or the fallback textarea) into the draft. Called before
  // every re-render and before every send.
  function captureDraft(state, root) {
    if (!root) return;
    var nf = NF();
    var ed = root.querySelector('[data-editor]');
    if (ed && nf) state.draft.markup = nf.domToMarkup(ed);
    var ta = root.querySelector('[data-field="body"]');
    if (ta) state.draft.plain = ta.value;
  }

  function draftPayload(state, root) {
    captureDraft(state, root);
    var nf = NF();
    if (nf) return { body: state.draft.markup, format: 'markup', blank: nf.isBlank(state.draft.markup) };
    var t = state.draft.plain || '';
    return { body: t, format: 'plain', blank: !t.trim() };
  }

  function apiForm(state, path, form) {
    return fetch(API + path, { method: 'POST', headers: { Authorization: 'Bearer ' + state.authToken }, body: form }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) {
          var err = new Error((data && data.error) || 'Request failed (' + res.status + ')');
          err.code = data && data.code; err.status = res.status; throw err;
        }
        return data;
      });
    });
  }

  // Post JSON when there is no file, multipart when there is.
  function postMessage(state, path, fields, files) {
    if (!files.length) return api(state, path, { method: 'POST', body: fields });
    var form = new FormData();
    Object.keys(fields).forEach(function (k) { if (fields[k] !== undefined && fields[k] !== null) form.append(k, fields[k]); });
    files.forEach(function (f) { form.append('files', f.file, f.name); });
    return apiForm(state, path, form);
  }

  // Attachments are read with the caller's token and handed to the browser as a
  // blob — never a public link. A pop-up opened after an await is blocked on
  // some phones, so a download is the fallback.
  function openAttachment(state, ref, name) {
    var parts = ref.split('|');
    return fetch(API + '/api/messaging/messages/' + encodeURIComponent(parts[0]) + '/attachments/' + encodeURIComponent(parts[1]),
      { headers: { Authorization: 'Bearer ' + state.authToken } }).then(function (res) {
      if (!res.ok) {
        return res.json().catch(function () { return {}; }).then(function (d) { throw new Error((d && d.error) || 'That attachment could not be opened.'); });
      }
      return res.blob();
    }).then(function (blob) {
      var url = URL.createObjectURL(blob);
      if (!window.open(url, '_blank')) {
        var a = document.createElement('a'); a.href = url; a.download = name || 'attachment';
        document.body.appendChild(a); a.click(); a.remove();
      }
      setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
    });
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
    // NOT captured here. Reading the editor at render time would read the OLD
    // editor after a successful send and put the sent message straight back in
    // the box. The draft is kept current by the editor's own input events (see
    // bind) and read explicitly before a send or a file change.
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
    var nf = NF();
    var ed = root.querySelector('[data-editor]');
    if (ed && nf) ed.innerHTML = nf.renderHtml(state.draft.markup || '');
    bind(state, root);
  }

  // Staff message ABOUT a client, so a staff screen with no client named has
  // every channel switched off with "none is selected" — which reads as a
  // broken app rather than as a step not yet taken. The list is the server's
  // (`/api/messaging/clients`), scoped the same way the routes are, so a name
  // shown here can always be opened and one that cannot never appears.
  // Is it settled which client we are talking about? Either the host fixed it,
  // or the user picked one, or there is only one it could be (a client and a
  // family member each cover exactly one, so they are never asked).
  function scopeSettled(state) {
    if (state.fixedScope || state.scopeClientId) return true;
    return !!state.pickerClients && state.pickerClients.length < 2;
  }

  function renderPicker(state) {
    if (state.fixedScope || !state.pickerClients || state.pickerClients.length < 2) return '';
    var opts = ['<option value="">Everyone I can see</option>'].concat(
      state.pickerClients.map(function (c) {
        return '<option value="' + esc(c.id) + '"' +
          (state.scopeClientId === c.id ? ' selected' : '') + '>' + esc(c.name) + '</option>';
      })
    ).join('');
    return '<div class="mcard"><label for="gfcm-client">Client</label>' +
      '<select id="gfcm-client" data-client-pick="1">' + opts + '</select>' +
      (state.scopeClientId ? '' :
        '<div class="mnote">Pick a client to start a new message. Conversations from every client you cover are listed below either way.</div>') +
      '</div>';
  }

  function renderList(state) {
    var openable = state.channels.filter(function (c) { return c.available; });
    var blocked = state.channels.filter(function (c) { return !c.available; });

    var html = renderPicker(state) + '<div class="mcard"><h3>Messages</h3>';
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
    // A channel that is off stays SHOWN with its reason — that is the brief's
    // rule and it is why a client who has no caregiver yet reads "the office
    // assigns one" instead of hunting for a missing button. The only case it is
    // withheld is a staff screen that has not named a client, where every
    // reason would read "none is selected" and say nothing about the client.
    if (blocked.length && scopeSettled(state)) {
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
      '<label>Message</label>' + renderEditor(state) +
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
        messageHtml(m) + attachmentsHtml(m) +
        '<div class="mwhen">' + esc(fmtWhen(m.sentAt)) + '</div>' +
        '</div>';
    }).join('') + '</div>';

    if (state.canPost) {
      html += '<label>Reply</label>' + renderEditor(state) +
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
    var go = function (p) {
      state.error = '';
      state.notice = '';
      return p.catch(function (err) { state.error = err.message; render(state); });
    };

    var pick = root.querySelector('[data-client-pick]');
    if (pick) pick.onchange = function () {
      state.scopeClientId = pick.value || null;
      state.error = '';
      state.loading = true;
      render(state);
      refresh(state).catch(function (err) { state.loading = false; state.error = err.message; render(state); });
    };

    root.querySelectorAll('[data-open]').forEach(function (b) {
      b.onclick = function () { state.draft = newDraft(); go(openThread(state, b.getAttribute('data-open'))); };
    });
    root.querySelectorAll('[data-compose]').forEach(function (b) {
      b.onclick = function () {
        state.composeChannel = b.getAttribute('data-compose');
        state.draft = newDraft();
        state.view = 'compose';
        state.error = '';
        render(state);
      };
    });
    var back = root.querySelector('[data-back]');
    if (back) back.onclick = function () { state.draft = newDraft(); state.view = 'list'; state.error = ''; refresh(state); };

    // ---- The composer ------------------------------------------------------
    var editor = root.querySelector('[data-editor]');
    var runFmt = function (cmd) {
      if (!editor) return;
      editor.focus();
      if (cmd === 'heading') {
        var inHeading = /^h\d$/i.test(String(document.queryCommandValue('formatBlock') || ''));
        document.execCommand('formatBlock', false, inHeading ? 'div' : 'h3');
      } else {
        document.execCommand(cmd, false, null);
      }
    };
    root.querySelectorAll('[data-fmt]').forEach(function (b) {
      // mousedown, not click: a click would take focus (and the selection) off the editor
      b.onmousedown = function (e) { e.preventDefault(); runFmt(b.getAttribute('data-fmt')); };
    });
    // A paste arrives as TEXT: formatting from Word or a web page is not carried
    // over, and the person applies what they mean with the toolbar.
    // Keep the draft current as people type, so a re-render (an error, a refresh)
    // can restore it and a successful send can clear it for good.
    var keepDraft = function () { captureDraft(state, root); };
    if (editor) { editor.oninput = keepDraft; editor.onblur = keepDraft; }
    var plainBox = root.querySelector('[data-field="body"]');
    if (plainBox) plainBox.oninput = keepDraft;
    if (editor) editor.onpaste = function (e) {
      e.preventDefault();
      var text = (e.clipboardData || window.clipboardData).getData('text/plain');
      document.execCommand('insertText', false, text);
    };
    var picker = root.querySelector('[data-files]');
    if (picker) picker.onchange = function () {
      captureDraft(state, root);
      var problems = [];
      Array.prototype.forEach.call(picker.files, function (f) {
        if (state.draft.files.length >= MAX_FILES) problems.push('A message carries up to ' + MAX_FILES + ' attachments.');
        else if (f.size > MAX_BYTES) problems.push(f.name + ' is over 10 MB.');
        else if (!/^(application\/pdf|image\/jpeg|image\/png)$/.test(f.type) && !/\.(pdf|jpe?g|png)$/i.test(f.name)) problems.push(f.name + ' is not a PDF, JPEG or PNG.');
        else state.draft.files.push({ name: f.name, size: f.size, file: f });
      });
      state.error = problems.filter(function (x, i, a) { return a.indexOf(x) === i; }).join(' ');
      render(state);
    };
    root.querySelectorAll('[data-remove-file]').forEach(function (b) {
      b.onclick = function () {
        captureDraft(state, root);
        state.draft.files.splice(Number(b.getAttribute('data-remove-file')), 1);
        render(state);
      };
    });
    root.querySelectorAll('[data-att]').forEach(function (b) {
      b.onclick = function () {
        b.disabled = true;
        openAttachment(state, b.getAttribute('data-att'), b.getAttribute('data-att-name'))
          .catch(function (err) { state.error = err.message; render(state); })
          .then(function () { b.disabled = false; });
      };
    });

    var send = root.querySelector('[data-send]');
    if (send) send.onclick = function () {
      var d = draftPayload(state, root);
      if (d.blank && !state.draft.files.length) { state.error = 'Write a message first.'; render(state); return; }
      send.disabled = true;
      go(postMessage(state, '/api/messaging/threads',
        { channel: state.composeChannel, clientId: state.scopeClientId || undefined, body: d.body, format: d.format }, state.draft.files)
        .then(function (res) {
          state.draft = newDraft();      // cleared ONLY on success: a failed send keeps every word and file
          state.view = 'list';
          state.notice = res.notice || 'Message sent.';
          return refresh(state);
        })).then(function () { send.disabled = false; });
    };

    var reply = root.querySelector('[data-reply]');
    if (reply) reply.onclick = function () {
      var d = draftPayload(state, root);
      if (d.blank && !state.draft.files.length) { state.error = 'Write a message first.'; render(state); return; }
      reply.disabled = true;
      go(postMessage(state, '/api/messaging/threads/' + state.thread.id + '/messages', { body: d.body, format: d.format }, state.draft.files)
        .then(function () { state.draft = newDraft(); return openThread(state, state.thread.id); }))
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
      api(state, '/api/messaging/channels' + q),
      // A picker the caller cannot fail on: if the list cannot be read the
      // panel still renders its threads, with no picker, rather than showing
      // an error over a working inbox.
      state.fixedScope ? Promise.resolve({ clients: [] })
                       : api(state, '/api/messaging/clients').catch(function () { return { clients: [] }; })
    ]).then(function (r) {
      state.threads = r[0].threads || [];
      state.channels = r[1].channels || [];
      state.pickerClients = r[2].clients || [];
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
      // A host that named a client OWNS the scope — the client portal is about
      // one client and must never offer a way to look at another. Only a staff
      // surface that named none gets the picker.
      fixedScope: !!options.scopeClientId,
      pickerClients: [],
      authToken: options.authToken,
      onUnread: options.onUnread || null,
      view: 'list',
      loading: true,
      error: '', notice: '',
      threads: [], channels: [], messages: [],
      thread: null, canPost: false, cannotPostReason: null,
      composeChannel: null,
      draft: newDraft()
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
