/* ============================================================================
 * GFC Caregiver Schedule — a mountable component (Session 7)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * MOUNT CONTRACT
 * ─────────────────────────────────────────────────────────────────────────────
 * This file is SHIPPED UNMOUNTED, on purpose. Session 6 owns
 * `public/caregiver.html` and renders `<div id="gfc-mount-schedule">` as a
 * disabled placeholder. A follow-up wiring session — not this one — mounts this
 * component into it once both PRs have merged. Nothing in the repository calls
 * `mount()` today, and `test/scheduling.test.js` fails the build if that
 * changes without the wiring session doing it deliberately.
 *
 *   Load:   <script src="/components/caregiver-schedule.js"></script>
 *   Mount:  window.GFCCaregiverSchedule.mount('gfc-mount-schedule', {
 *             caregiverId: me.id,      // from GET /api/caregiver/me → `id`
 *             authToken:   token,      // the bearer token the host page holds
 *             onChange:    (summary) => {}   // optional; fires after any
 *                                            // action that changes the board
 *           });
 *   Unmount: window.GFCCaregiverSchedule.unmount('gfc-mount-schedule');
 *
 * `caregiverId` is passed for display and for the host page's own bookkeeping.
 * It is NOT what authorizes anything: every route below resolves the caregiver
 * from the token server-side, so a caller who passes someone else's id still
 * reads only their own shifts and their own time history. Do not read the id
 * from localStorage — the token is the authority.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IT RENDERS
 * ─────────────────────────────────────────────────────────────────────────────
 *   · My schedule            — confirmed and in-progress shifts, next first
 *   · Offers                 — shifts assigned to me: accept or decline
 *   · Open shifts            — the pool, already filtered server-side to what
 *                              my license level and assignment allow. Claim
 *                              submits for admin approval; it does not confirm.
 *   · Clock in / out         — only on a confirmed shift, GPS captured. An
 *                              out-of-geofence clock-in SUCCEEDS and is flagged.
 *   · Availability           — submit days, windows and blackout dates. The
 *                              30-day rule is enforced server-side; the form
 *                              mirrors it so the refusal is not a surprise.
 *   · My time history        — my own rows only, with hours and any flags.
 *
 * No framework. Plain DOM, so it drops into Session 6's React page (which uses
 * React 18 + Babel) without a second copy of React and without a build step.
 * Styling uses the GFC brand tokens and inherits the host page's font stack.
 * ==========================================================================*/

(function (global) {
  'use strict';

  var API = global.location.origin;
  var LEAD_DAYS = 30;                    // mirrors AVAILABILITY_LEAD_DAYS
  var instances = Object.create(null);   // elementId → instance state

  // ---- Brand tokens (scoped; the host page keeps its own) -----------------
  var CSS = [
    '.gfcs{--navy:#033D50;--gold:#F5CD85;--goldd:#C9A44A;--cream:#FAF7F2;--ink:#1a2a32;--mut:#41555f;--red:#A32D2D;--green:#0f6e56;--line:#e5ddcb;font-size:16px;line-height:1.5;color:var(--ink)}',
    '.gfcs *{box-sizing:border-box}',
    '.gfcs h3{font-family:"Cormorant Garamond",Georgia,serif;font-size:19px;color:var(--navy);font-weight:600;margin:0 0 8px}',
    '.gfcs .gcard{background:#fff;border:1px solid var(--line);border-radius:12px;padding:14px 15px;margin-bottom:12px}',
    '.gfcs .grow{display:flex;justify-content:space-between;gap:10px;padding:11px 0;border-bottom:1px solid #ece6db}',
    '.gfcs .grow:last-child{border:none}',
    '.gfcs .gwhen{font-weight:600;color:var(--navy)}',
    '.gfcs .gmu{font-size:14px;color:var(--mut)}',
    '.gfcs .gbtn{border-radius:9px;padding:11px 14px;font-size:15px;font-weight:600;cursor:pointer;font-family:inherit;border:1px solid var(--navy);background:var(--navy);color:var(--cream)}',
    '.gfcs .gbtn.gold{background:var(--gold);border-color:var(--gold);color:var(--navy)}',
    '.gfcs .gbtn.ghost{background:#fff;color:var(--navy)}',
    '.gfcs .gbtn.danger{background:#fff;border-color:var(--red);color:var(--red)}',
    '.gfcs .gbtn[disabled]{opacity:.5;cursor:not-allowed}',
    '.gfcs .gbtns{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}',
    '.gfcs .gchip{display:inline-block;border-radius:12px;padding:3px 10px;font-size:12px;font-weight:600;background:#eee8db;color:#8a8378}',
    '.gfcs .gchip.on{background:var(--navy);color:var(--gold)}',
    '.gfcs .gchip.warn{background:#fdeeee;color:var(--red)}',
    '.gfcs .gchip.ok{background:#eef3f0;color:var(--green)}',
    '.gfcs .gempty{text-align:center;padding:22px 12px;color:var(--mut);font-size:15px}',
    '.gfcs .gerr{background:#fdeeee;border:1px solid #e7bcbc;color:#7d2020;border-radius:9px;padding:11px;font-size:15px;margin-bottom:10px}',
    '.gfcs .gok{background:#f2f8f6;border:1px solid #b8ddd0;color:#0d5744;border-radius:9px;padding:11px;font-size:15px;margin-bottom:10px}',
    '.gfcs label{display:block;font-size:12px;letter-spacing:.5px;text-transform:uppercase;color:var(--mut);font-weight:600;margin-bottom:5px}',
    '.gfcs input,.gfcs select,.gfcs textarea{width:100%;border:1px solid #ddd3c0;border-radius:9px;padding:11px;font-size:16px;font-family:inherit;background:#fff;color:var(--ink)}',
    '.gfcs .gfield{margin-bottom:11px}',
    '.gfcs .g3{display:grid;grid-template-columns:1.2fr 1fr 1fr auto;gap:8px;align-items:end;margin-bottom:8px}',
    '.gfcs .gtabs{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px}',
    '.gfcs .gtab{border:1.5px solid #d8cdb8;background:#fff;border-radius:20px;padding:8px 14px;font-size:15px;color:var(--navy);cursor:pointer;font-family:inherit}',
    '.gfcs .gtab.on{background:var(--navy);border-color:var(--navy);color:var(--gold)}'
  ].join('\n');

  function injectCss() {
    if (document.getElementById('gfcs-styles')) return;
    var el = document.createElement('style');
    el.id = 'gfcs-styles';
    el.textContent = CSS;
    document.head.appendChild(el);
  }

  // ---- Fetch helper -------------------------------------------------------
  function api(state, path, opts) {
    opts = opts || {};
    return fetch(API + path, {
      method: opts.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + state.authToken
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined
    }).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (data) {
        if (!res.ok) {
          var err = new Error((data && data.error) || 'Request failed (' + res.status + ')');
          err.code = data && data.code;
          err.status = res.status;
          err.data = data;
          throw err;
        }
        return data;
      });
    });
  }

  // ---- Formatting ---------------------------------------------------------
  function fmtWhen(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) +
      ' · ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }
  function fmtRange(a, b) {
    var end = new Date(b);
    if (isNaN(end.getTime())) return fmtWhen(a);
    return fmtWhen(a) + ' – ' + end.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }
  function titleize(s) { return String(s || '').replace(/_/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); }); }
  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Browser geolocation, best effort. A refusal or a timeout is NOT an error:
  // the clock-in still goes through and the server flags it unverifiable, which
  // is the honest record. Blocking here would mean unpaid work and no visit.
  function currentGps() {
    return new Promise(function (resolve) {
      if (!global.navigator || !global.navigator.geolocation) return resolve(null);
      var done = false;
      var finish = function (v) { if (!done) { done = true; resolve(v); } };
      setTimeout(function () { finish(null); }, 8000);
      global.navigator.geolocation.getCurrentPosition(
        function (pos) {
          finish({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy });
        },
        function () { finish(null); },
        { enableHighAccuracy: true, timeout: 7000, maximumAge: 30000 }
      );
    });
  }

  // ---- Rendering ----------------------------------------------------------
  function render(state) {
    var root = document.getElementById(state.elementId);
    if (!root) return;

    var tabs = [
      { id: 'schedule', label: 'My schedule' },
      { id: 'offers', label: 'Offers' + (state.offers.length ? ' (' + state.offers.length + ')' : '') },
      { id: 'open', label: 'Open shifts' + (state.open.length ? ' (' + state.open.length + ')' : '') },
      { id: 'availability', label: 'Availability' },
      { id: 'time', label: 'My hours' }
    ];

    var html = '<div class="gfcs">';
    if (state.error) html += '<div class="gerr">' + esc(state.error) + '</div>';
    if (state.notice) html += '<div class="gok">' + esc(state.notice) + '</div>';

    html += '<div class="gtabs">';
    tabs.forEach(function (t) {
      html += '<button class="gtab' + (state.tab === t.id ? ' on' : '') + '" data-tab="' + t.id + '">' + esc(t.label) + '</button>';
    });
    html += '</div>';

    if (state.loading) html += '<div class="gempty">Loading…</div>';
    else if (state.tab === 'schedule') html += renderSchedule(state);
    else if (state.tab === 'offers') html += renderOffers(state);
    else if (state.tab === 'open') html += renderOpen(state);
    else if (state.tab === 'availability') html += renderAvailability(state);
    else html += renderTime(state);

    html += '</div>';
    root.innerHTML = html;
    bind(state, root);
  }

  function renderSchedule(state) {
    var rows = state.mine.filter(function (s) {
      return s.status === 'confirmed' || s.status === 'in_progress';
    });
    if (!rows.length) return '<div class="gempty">No confirmed shifts yet.</div>';
    return '<div class="gcard"><h3>My schedule</h3>' + rows.map(function (s) {
      var running = s.status === 'in_progress';
      return '<div class="grow" style="display:block">' +
        '<div class="gwhen">' + esc(fmtRange(s.start, s.end)) + '</div>' +
        '<div class="gmu">' + esc(s.clientName || '') + (s.careTier ? ' · ' + esc(s.careTier) : '') + '</div>' +
        '<div class="gmu"><span class="gchip ' + (running ? 'on' : 'ok') + '">' + esc(titleize(s.status)) + '</span></div>' +
        '<div class="gbtns">' +
          (running
            ? '<button class="gbtn danger" data-act="clock-out" data-id="' + s.id + '">Clock out</button>'
            : '<button class="gbtn gold" data-act="clock-in" data-id="' + s.id + '">Clock in</button>') +
        '</div>' +
      '</div>';
    }).join('') + '</div>';
  }

  function renderOffers(state) {
    if (!state.offers.length) return '<div class="gempty">No shifts are waiting on your answer.</div>';
    return '<div class="gcard"><h3>Offered to you</h3>' + state.offers.map(function (s) {
      return '<div class="grow" style="display:block">' +
        '<div class="gwhen">' + esc(fmtRange(s.start, s.end)) + '</div>' +
        '<div class="gmu">' + esc(s.clientName || '') + '</div>' +
        (s.notes ? '<div class="gmu">' + esc(s.notes) + '</div>' : '') +
        '<div class="gbtns">' +
          '<button class="gbtn" data-act="accept" data-id="' + s.id + '">Accept</button>' +
          '<button class="gbtn ghost" data-act="decline" data-id="' + s.id + '">Decline</button>' +
        '</div>' +
      '</div>';
    }).join('') + '</div>';
  }

  function renderOpen(state) {
    if (!state.open.length) return '<div class="gempty">No open shifts you can take right now.</div>';
    return '<div class="gcard"><h3>Open shifts</h3>' +
      '<p class="gmu" style="margin-bottom:8px">Claiming submits the shift for approval. The office confirms it before it is yours.</p>' +
      state.open.map(function (s) {
        return '<div class="grow" style="display:block">' +
          '<div class="gwhen">' + esc(fmtRange(s.start, s.end)) + '</div>' +
          '<div class="gmu">' + esc(s.clientName || '') +
            (s.levelRequirementLabel ? ' · ' + esc(s.levelRequirementLabel) : '') + '</div>' +
          (s.notes ? '<div class="gmu">' + esc(s.notes) + '</div>' : '') +
          '<div class="gbtns"><button class="gbtn gold" data-act="claim" data-id="' + s.id + '">Claim</button></div>' +
        '</div>';
      }).join('') + '</div>';
  }

  function renderAvailability(state) {
    var earliest = new Date(Date.now() + LEAD_DAYS * 86400000).toISOString().slice(0, 10);
    var html = '<div class="gcard"><h3>Submit availability</h3>' +
      '<p class="gmu" style="margin-bottom:10px">Availability is submitted at least ' + LEAD_DAYS +
      ' days ahead, so the office can build the schedule around it. The earliest you can start is ' + esc(earliest) + '.</p>' +
      '<div class="gfield"><label>Starts from</label>' +
      '<input type="date" id="gfcs-eff" min="' + esc(earliest) + '" value="' + esc(state.draft.effectiveFrom || earliest) + '"></div>';

    html += '<label>Days and times you can work</label>';
    state.draft.windows.forEach(function (w, i) {
      html += '<div class="g3">' +
        '<select data-win="' + i + '" data-k="day">' +
          ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(function (d) {
            return '<option value="' + d + '"' + (w.day === d ? ' selected' : '') + '>' + d + '</option>';
          }).join('') +
        '</select>' +
        '<input type="time" data-win="' + i + '" data-k="start" value="' + esc(w.start) + '">' +
        '<input type="time" data-win="' + i + '" data-k="end" value="' + esc(w.end) + '">' +
        '<button class="gbtn ghost" data-act="rm-win" data-i="' + i + '">Remove</button>' +
      '</div>';
    });
    html += '<div class="gbtns"><button class="gbtn ghost" data-act="add-win">Add a window</button></div>';

    html += '<div class="gfield" style="margin-top:12px"><label>Days you are not available (one date per line)</label>' +
      '<textarea id="gfcs-blackout" rows="3" placeholder="2026-11-26">' + esc((state.draft.blackoutDates || []).join('\n')) + '</textarea></div>';
    html += '<div class="gbtns"><button class="gbtn gold" data-act="submit-availability">Submit availability</button></div>';
    html += '</div>';

    if (state.availability.length) {
      html += '<div class="gcard"><h3>Submitted</h3>' + state.availability.map(function (a) {
        return '<div class="grow" style="display:block">' +
          '<div class="gwhen">From ' + esc(a.effectiveFrom) + '</div>' +
          '<div class="gmu">' + (a.windows || []).map(function (w) {
            return esc(w.day + ' ' + w.start + '–' + w.end);
          }).join(' · ') + '</div>' +
          '<div class="gmu"><span class="gchip' + (a.status === 'reviewed' ? ' ok' : '') + '">' + esc(titleize(a.status)) + '</span></div>' +
        '</div>';
      }).join('') + '</div>';
    }
    return html;
  }

  function renderTime(state) {
    if (!state.timeLogs.length) return '<div class="gempty">No hours logged yet.</div>';
    var hours = state.totalHours === null || state.totalHours === undefined ? '—' : state.totalHours;
    return '<div class="gcard"><h3>My hours</h3>' +
      '<p class="gmu" style="margin-bottom:8px">' + esc(String(hours)) + ' hours logged.</p>' +
      // Their own copy of their own hours. The server resolves the caregiver
      // from the token, so this asks for no id and could not fetch anyone
      // else's rows if it did.
      '<div class="gbtns" style="margin-bottom:10px">' +
        '<button class="gbtn ghost" data-act="download-hours">Download my hours (CSV)</button>' +
      '</div>' +
      state.timeLogs.map(function (l) {
        return '<div class="grow" style="display:block">' +
          '<div class="gwhen">' + esc(fmtWhen(l.clockInAt)) + '</div>' +
          '<div class="gmu">' + esc(l.clientName || '') + ' · ' +
            (l.totalHours === null || l.totalHours === undefined ? 'still open' : esc(l.totalHours) + ' h') + '</div>' +
          ((l.flags || []).length
            ? '<div class="gmu">' + l.flags.map(function (f) {
                return '<span class="gchip warn">' + esc(titleize(f)) + '</span>';
              }).join(' ') + '</div>'
            : '') +
        '</div>';
      }).join('') + '</div>';
  }

  // ---- Events -------------------------------------------------------------
  function bind(state, root) {
    root.querySelectorAll('[data-tab]').forEach(function (b) {
      b.addEventListener('click', function () {
        state.tab = b.getAttribute('data-tab');
        state.error = ''; state.notice = '';
        render(state);
      });
    });

    root.querySelectorAll('[data-win]').forEach(function (input) {
      input.addEventListener('change', function () {
        var i = Number(input.getAttribute('data-win'));
        state.draft.windows[i][input.getAttribute('data-k')] = input.value;
      });
    });

    var eff = root.querySelector('#gfcs-eff');
    if (eff) eff.addEventListener('change', function () { state.draft.effectiveFrom = eff.value; });

    root.querySelectorAll('[data-act]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var act = btn.getAttribute('data-act');
        var id = btn.getAttribute('data-id');
        if (act === 'add-win') {
          state.draft.windows.push({ day: 'Mon', start: '09:00', end: '17:00' });
          return render(state);
        }
        if (act === 'rm-win') {
          state.draft.windows.splice(Number(btn.getAttribute('data-i')), 1);
          return render(state);
        }
        if (act === 'submit-availability') return submitAvailability(state, root);
        if (act === 'download-hours') {
          // A file download, so the token rides as a query param — the same
          // pattern the app's other authenticated downloads use.
          global.location.href = API + '/api/scheduling/my-hours.csv?token=' +
            encodeURIComponent(state.authToken);
          return;
        }
        btn.disabled = true;
        act === 'clock-in' || act === 'clock-out'
          ? clock(state, id, act)
          : shiftAction(state, id, act);
      });
    });
  }

  function submitAvailability(state, root) {
    var textarea = root.querySelector('#gfcs-blackout');
    var blackoutDates = (textarea ? textarea.value : '').split('\n')
      .map(function (s) { return s.trim(); }).filter(Boolean);
    state.draft.blackoutDates = blackoutDates;
    state.error = ''; state.notice = '';

    api(state, '/api/scheduling/availability', {
      method: 'POST',
      body: {
        effectiveFrom: state.draft.effectiveFrom,
        windows: state.draft.windows,
        blackoutDates: blackoutDates
      }
    }).then(function () {
      state.notice = 'Availability submitted.';
      return refresh(state);
    }).catch(function (err) {
      // The 30-day refusal is shown in the server's own words, so the caregiver
      // sees the same rule the API enforces rather than a generic failure.
      state.error = err.message;
      render(state);
    });
  }

  function shiftAction(state, id, act) {
    var path = {
      claim: '/api/scheduling/shifts/' + id + '/claim',
      accept: '/api/scheduling/shifts/' + id + '/accept',
      decline: '/api/scheduling/shifts/' + id + '/decline'
    }[act];
    if (!path) return;
    state.error = ''; state.notice = '';
    api(state, path, { method: 'POST', body: {} }).then(function (res) {
      state.notice = res && res.message ? res.message
        : act === 'accept' ? 'Shift confirmed.'
        : act === 'decline' ? 'Declined. The shift is back in the open pool.'
        : 'Done.';
      return refresh(state);
    }).catch(function (err) { state.error = err.message; render(state); });
  }

  function clock(state, id, act) {
    state.error = ''; state.notice = '';
    currentGps().then(function (gps) {
      return api(state, '/api/scheduling/shifts/' + id + '/' + act, { method: 'POST', body: { gps: gps } });
    }).then(function (res) {
      state.notice = (res && res.message) || (act === 'clock-in' ? 'Clocked in.' : 'Clocked out.');
      return refresh(state);
    }).catch(function (err) {
      // The one refusal with somewhere to go: the shift needs its visit log
      // first. Hand the shift to the host page, which owns the log form,
      // instead of leaving the caregiver reading an error with no next step.
      if (err.code === 'VISIT_LOG_REQUIRED' && state.onVisitLogRequired) {
        var shift = null;
        for (var i = 0; i < state.mine.length; i++) {
          if (state.mine[i] && state.mine[i].id === id) { shift = state.mine[i]; break; }
        }
        state.onVisitLogRequired(shift || { id: id });
        return;
      }
      state.error = err.message;
      render(state);
    });
  }

  // ---- Data ---------------------------------------------------------------
  function refresh(state) {
    return Promise.all([
      api(state, '/api/scheduling/shifts').catch(function () { return { shifts: [] }; }),
      api(state, '/api/scheduling/shifts/open').catch(function () { return { shifts: [] }; }),
      api(state, '/api/scheduling/availability').catch(function () { return { availability: [] }; }),
      api(state, '/api/scheduling/time-logs').catch(function () { return { timeLogs: [] }; })
    ]).then(function (r) {
      var mine = r[0].shifts || [];
      state.mine = mine;
      state.offers = mine.filter(function (s) { return s.status === 'assigned'; });
      state.open = r[1].shifts || [];
      state.availability = r[2].availability || [];
      state.timeLogs = r[3].timeLogs || [];
      state.totalHours = r[3].totalHours;
      state.loading = false;
      render(state);
      if (typeof state.onChange === 'function') {
        state.onChange({
          confirmed: mine.filter(function (s) { return s.status === 'confirmed'; }).length,
          inProgress: mine.filter(function (s) { return s.status === 'in_progress'; }).length,
          offers: state.offers.length,
          openPool: state.open.length
        });
      }
    });
  }

  // ---- Public API ---------------------------------------------------------
  function mount(elementId, options) {
    options = options || {};
    if (!elementId) throw new Error('caregiver-schedule: an element id is required');
    if (!options.authToken) throw new Error('caregiver-schedule: authToken is required');
    injectCss();

    var earliest = new Date(Date.now() + LEAD_DAYS * 86400000).toISOString().slice(0, 10);
    var state = {
      elementId: elementId,
      caregiverId: options.caregiverId || null,
      authToken: options.authToken,
      onChange: options.onChange || null,
      // Fired when a clock-out is refused because that shift has no visit log
      // yet. The log form belongs to the host page, so the shift is handed back
      // rather than this component trying to render a form it does not own.
      onVisitLogRequired: options.onVisitLogRequired || null,
      tab: options.initialTab || 'schedule',
      loading: true,
      error: '', notice: '',
      mine: [], offers: [], open: [], availability: [], timeLogs: [], totalHours: null,
      draft: { effectiveFrom: earliest, windows: [{ day: 'Mon', start: '09:00', end: '17:00' }], blackoutDates: [] }
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

  global.GFCCaregiverSchedule = { mount: mount, unmount: unmount, LEAD_DAYS: LEAD_DAYS };
})(typeof window !== 'undefined' ? window : this);
