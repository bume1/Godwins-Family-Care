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
 *   Staff mode (2026-11-08): `staffOnly: true` shows only the time clock and
 *   My hours, for W-2 staff without shifts. My GFC mounts it that way.
 *   `onlyTabs: ['availability']` shows just the availability form; the
 *   clinical Schedule view mounts it that way for clinicians.
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
 *   · My schedule            — a month calendar of my shifts (confirmed, in
 *                              progress, completed, offered, claimed) plus the
 *                              open shifts I can claim. Never a cancelled one.
 *                              A List view keeps confirmed shifts, next first.
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
  // FALLBACKS ONLY. The real floors are served on the availability list
  // (`rules.leadDays` / `rules.changeLeadDays`) and stored on state, because a
  // number printed here beside a rule the server owns is a number that drifts —
  // this file said 30 for a month after the server moved. These are what shows
  // if that read fails, and they are deliberately the STRICTER pair: a screen
  // that guesses low would invite a submission the server then refuses.
  var LEAD_DAYS = 14;                    // mirrors AVAILABILITY_LEAD_DAYS
  var CHANGE_LEAD_DAYS = 1;              // mirrors AVAILABILITY_CHANGE_LEAD_DAYS

  // Which floor applies to THIS caregiver: changing availability already on
  // file is the short-notice case. Asked of what the server sent back, the same
  // question the route asks of the store, so the form offers exactly the dates
  // the route will accept.
  function leadDaysFor(state) {
    var r = (state && state.availabilityRules) || {};
    var first = typeof r.leadDays === 'number' ? r.leadDays : LEAD_DAYS;
    var change = typeof r.changeLeadDays === 'number' ? r.changeLeadDays : CHANGE_LEAD_DAYS;
    return (state && state.availability && state.availability.length) ? change : first;
  }
  // Mirrors CLOCK_IN_WINDOW_MINUTES. The SERVER is what enforces it; this only
  // decides whether the button is offered, so the two disagreeing costs a
  // clear refusal rather than an unenforced rule.
  var CLOCK_IN_WINDOW_MINUTES = 120;
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
    '.gfcs .gpay{font-size:14px;font-weight:600;color:var(--navy);margin-top:3px}',
    '.gfcs .gblocked{opacity:.55}',
    '.gfcs .gwhy{font-size:13px;color:var(--mut);font-style:italic;margin-top:5px}',
    '.gfcs .gask{margin-top:10px;padding:12px;border-radius:10px;background:var(--cream,#faf7f0);border:1px solid rgba(0,0,0,.08)}',
    '.gfcs .gempty{text-align:center;padding:22px 12px;color:var(--mut);font-size:15px}',
    '.gfcs .gerr{background:#fdeeee;border:1px solid #e7bcbc;color:#7d2020;border-radius:9px;padding:11px;font-size:15px;margin-bottom:10px}',
    '.gfcs .gok{background:#f2f8f6;border:1px solid #b8ddd0;color:#0d5744;border-radius:9px;padding:11px;font-size:15px;margin-bottom:10px}',
    '.gfcs label{display:block;font-size:12px;letter-spacing:.5px;text-transform:uppercase;color:var(--mut);font-weight:600;margin-bottom:5px}',
    '.gfcs input,.gfcs select,.gfcs textarea{width:100%;border:1px solid #ddd3c0;border-radius:9px;padding:11px;font-size:16px;font-family:inherit;background:#fff;color:var(--ink)}',
    '.gfcs .gfield{margin-bottom:11px}',
    // minmax(0, …) lets the time boxes shrink on a phone: with plain fr
    // columns their built-in minimum width pushed this row, and with it the
    // whole My GFC page, past the screen edge (owner report, 2026-11-15).
    '.gfcs .g3{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(0,1fr) minmax(0,1fr) auto;gap:8px;align-items:end;margin-bottom:8px}',
    '.gfcs .g3 > *{min-width:0;max-width:100%;box-sizing:border-box}',
    '@media(max-width:430px){.gfcs .g3{grid-template-columns:repeat(3,minmax(0,1fr))}.gfcs .g3 .gbtn{grid-column:1/-1}}',
    '.gfcs .gtabs{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px}',
    '.gfcs .gtab{border:1.5px solid #d8cdb8;background:#fff;border-radius:20px;padding:8px 14px;font-size:15px;color:var(--navy);cursor:pointer;font-family:inherit}',
    '.gfcs .gtab.on{background:var(--navy);border-color:var(--navy);color:var(--gold)}',
    // The month grid (2026-11-27). Colours match the office's scheduling
    // board, so a status reads the same on both sides.
    '.gfcs .gviews{display:inline-flex;border:1.5px solid #d8cdb8;border-radius:10px;overflow:hidden;margin-bottom:10px}',
    '.gfcs .gview{border:0;background:#fff;padding:7px 14px;font-size:14px;font-weight:600;color:var(--navy);cursor:pointer;font-family:inherit}',
    '.gfcs .gview.on{background:var(--navy);color:var(--gold)}',
    '.gfcs .gsm{padding:6px 11px;font-size:14px}',
    '.gfcs .gcalhdr{display:flex;align-items:center;gap:8px;margin-bottom:4px}',
    '.gfcs .gcaltitle{flex:1 1 auto;margin:0;text-align:center}',
    '.gfcs .gcal{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:3px}',
    '.gfcs .gcal.ghead{margin-bottom:3px}',
    '.gfcs .gdow{font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:#8a8378;text-align:center}',
    '.gfcs .gcell{min-height:84px;min-width:0;border:1px solid #e9e3d8;border-radius:8px;padding:3px;background:#fff;overflow:hidden;text-align:left;font-family:inherit;cursor:pointer;display:flex;flex-direction:column;gap:2px;color:inherit}',
    '.gfcs .gcell.blank{background:transparent;border-color:transparent;cursor:default}',
    '.gfcs .gcell.today{border-color:var(--goldd);box-shadow:inset 0 0 0 1px var(--goldd)}',
    '.gfcs .gcell.picked{border-color:var(--navy);box-shadow:inset 0 0 0 2px var(--navy)}',
    '.gfcs .gdate{font-size:11px;color:#8a8378}',
    '.gfcs .gshift{display:block;border-radius:4px;font-size:11px;line-height:1.3;padding:2px 4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.gfcs .gwho{opacity:.8}',
    '.gfcs .gshift.open{background:#fff;color:#6d675d;border:1px dashed #b9ae99}',
    // An offer waits on the CAREGIVER, a claim on the office: same family of
    // colour, but the offer carries a solid edge so the two read apart.
    '.gfcs .gshift.claimed,.gfcs .gshift.offered{background:#fdf3dd;color:#8a6a1e}',
    '.gfcs .gshift.offered{border:1px solid #d9a93f}',
    '.gfcs .gshort{display:none}',
    '.gfcs .gshift.confirmed{background:#eef3f0;color:var(--green)}',
    '.gfcs .gshift.in_progress{background:var(--navy);color:var(--gold)}',
    '.gfcs .gshift.completed{background:#e7edf0;color:var(--navy)}',
    '.gfcs .glegend{display:flex;gap:6px 12px;flex-wrap:wrap;margin-top:10px}',
    '.gfcs .gkey{border:0;background:none;padding:2px 0;font-size:12.5px;color:var(--mut);cursor:pointer;font-family:inherit;display:inline-flex;align-items:center;gap:5px}',
    '.gfcs .gkey.off{opacity:.4;text-decoration:line-through}',
    '.gfcs .gdot{display:inline-block;width:10px;height:10px;border-radius:2px}',
    '.gfcs .gdot.open{background:#fff;border:1px dashed #b9ae99}',
    '.gfcs .gdot.claimed{background:#fdf3dd;border:1px solid #e3cf9e}',
    '.gfcs .gdot.offered{background:#fdf3dd;border:1px solid #d9a93f}',
    '.gfcs .gdot.confirmed{background:#eef3f0;border:1px solid var(--green)}',
    '.gfcs .gdot.in_progress{background:var(--navy)}',
    '.gfcs .gdot.completed{background:#e7edf0;border:1px solid #b9c7cf}',
    '.gfcs .gchip.gk-offered,.gfcs .gchip.gk-claimed{background:#fdf3dd;color:#8a6a1e}',
    '.gfcs .gchip.gk-completed{background:#e7edf0;color:var(--navy)}',
    '.gfcs .gchip.gk-open{background:#fff;color:#6d675d;border:1px dashed #b9ae99}',
    // On a phone a day is too narrow for names: each shift becomes a coloured
    // bar with its start time, and the day panel below carries the detail.
    '@media(max-width:560px){.gfcs .gcell{min-height:58px;padding:2px}.gfcs .gwho,.gfcs .gfull{display:none}.gfcs .gshort{display:inline}.gfcs .gshift{font-size:10px;padding:1px 2px;text-align:center}.gfcs .gdate{font-size:10px}}'

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
  // Eastern, always — a caregiver who travels sees the shift in the time the
  // office means by it, not the time where their phone happens to be.
  var T = (typeof window !== 'undefined' && window.GFC_TIME) || null;
  function fmtWhen(iso) {
    return T ? T.fmtDayTime(iso) : '';
  }
  function fmtRange(a, b) {
    var end = new Date(b);
    if (!T || isNaN(end.getTime())) return fmtWhen(a);
    return fmtWhen(a) + ' – ' + T.fmtTime(end);
  }
  // A STORED "HH:MM" -> "9:00 AM". An availability window is the wall-clock
  // string typed into an `<input type="time">`: no date, no zone, so it cannot
  // go through fmtTime (which takes an instant). The input keeps HH:MM, which
  // is what the element requires; only the read-back line is 12-hour.
  function fmtClock(hhmm) {
    return T ? T.fmtClock(hhmm) : String(hhmm === null || hhmm === undefined ? '' : hhmm);
  }
  // A bare calendar date ("2026-12-01") read at midday UTC so it lands on the
  // same day in Eastern.
  function fmtPlainDate(ymd) {
    var v = String(ymd || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || !T) return v;
    return T.fmtDate(v + 'T12:00:00Z');
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

    // STAFF MODE (owner, 2026-11-08): W-2 staff without shifts use this same
    // clock. They have no shifts, offers or availability, so they get the
    // clock and their hours, and nothing else.
    // `onlyTabs` (2026-11-08): a host that needs only part of this screen,
    // such as the clinical Schedule view's Availability, names the tabs.
    var tabs = state.onlyTabs ? state.onlyTabs.map(function (id) {
      return { id: id, label: ({ clock: 'Time clock', time: 'My hours', availability: 'Availability' })[id] || id };
    }) : state.staffOnly ? [
      // Staff shifts by role (owner, 2026-11-09): the shifts the office
      // assigns them, to accept and clock in on, beside the plain clock.
      { id: 'clock', label: 'Time clock' },
      { id: 'schedule', label: 'My shifts' },
      { id: 'offers', label: 'Offers' + (state.offers.length ? ' (' + state.offers.length + ')' : '') },
      { id: 'time', label: 'My hours' }
    ] : [
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
    else if (state.tab === 'clock') html += renderStaffClock(state);
    else if (state.tab === 'schedule') html += renderSchedule(state);
    else if (state.tab === 'offers') html += renderOffers(state);
    else if (state.tab === 'open') html += renderOpen(state);
    else if (state.tab === 'availability') html += renderAvailability(state);
    else html += renderTime(state);

    html += '</div>';
    root.innerHTML = html;
    bind(state, root);
  }

  // One confirmed or in-progress shift, with its clock and change controls.
  // Shared by the list and by the calendar's day panel, so the two can never
  // offer different buttons for the same shift.
  function scheduleRow(state, s) {
      var running = s.status === 'in_progress';
      // The clock-in window opens two hours before the start. Shown as a
      // disabled button with the time on it rather than an enabled one that
      // fails: the server refuses either way, but a caregiver standing in
      // someone's kitchen should be able to read WHEN, not just be told no.
      var opens = new Date(new Date(s.start).getTime() - CLOCK_IN_WINDOW_MINUTES * 60000);
      var tooEarly = !running && !isNaN(opens.getTime()) && Date.now() < opens.getTime();
      return '<div class="grow" style="display:block">' +
        '<div class="gwhen">' + esc(fmtRange(s.start, s.end)) + '</div>' +
        '<div class="gmu">' + esc(s.staffRole ? (s.staffRoleLabel + ' shift' + (s.clientName ? ' · visit: ' + s.clientName : ' · office')) : (s.clientName || '')) + (s.careTier ? ' · ' + esc(s.careTier) : '') + '</div>' +
        '<div class="gmu"><span class="gchip ' + (running ? 'on' : 'ok') + '">' + esc(titleize(s.status)) + '</span></div>' +
        (tooEarly
          ? '<div class="gmu">Clock in opens at ' + esc(T ? T.fmtTime(opens) : '') + '.</div>'
          : '') +
        // The visit log comes before the clock stops, so the running shift
        // says which step it is on instead of offering a Clock out the server
        // will refuse. `visitLogFiled` is read from the shift the server sent;
        // when it is missing we say nothing rather than guess either way.
        (running && s.visitLogFiled === false
          ? '<div class="gmu">The visit log is not filed yet.</div>'
          : '') +
        // An ask already waiting on the office is shown as a STATE, not as a
        // second button: asking twice is refused server-side, and a caregiver
        // who cannot see that they already asked will ask again.
        (state.asking === s.id ? askForm(s) : '') +
        (s.openChangeRequest
          ? '<div class="gmu"><span class="gchip">' +
              (s.openChangeRequest.kind === 'drop'
                ? 'Asked to hand this back' : 'Asked to change the time') +
            '</span> — waiting on the office.</div>'
          : '') +
        '<div class="gbtns">' +
          (running
            ? (s.visitLogFiled === false
              ? '<button class="gbtn gold" data-act="visit-log" data-id="' + s.id + '">File the visit log</button>'
              : '<button class="gbtn danger" data-act="clock-out" data-id="' + s.id + '">Clock out</button>')
            : '<button class="gbtn gold" data-act="clock-in" data-id="' + s.id + '"' +
              (tooEarly ? ' disabled' : '') + '>Clock in</button>') +
          // Offered only where the SERVER says it can be asked about. Where it
          // cannot, the reason is printed — including the office number when
          // the shift is inside the notice window, because there is still a
          // real problem to solve and a dead end is how a control gets worked
          // around.
          (!running && s.changeRequestable && !s.openChangeRequest
            ? '<button class="gbtn ghost" data-act="ask-change" data-id="' + esc(s.id) + '">Ask to change</button>'
            : '') +
          (!running && s.openChangeRequest
            ? '<button class="gbtn ghost" data-act="withdraw-change" data-id="' +
                esc(s.openChangeRequest.id) + '">Withdraw the request</button>'
            : '') +
        '</div>' +
        (!running && !s.changeRequestable && !s.openChangeRequest && s.changeRequestBlockedReason
          ? '<div class="gwhy">' + esc(s.changeRequestBlockedReason) + '</div>'
          : '') +
      '</div>';
  }

  // THE SCHEDULE IS A CALENDAR (owner, 2026-11-27): "caregivers see the same
  // calendar view (scoped to their shifts)". The month grid matches the one
  // the office uses on the scheduling board; List keeps the old view.
  function renderSchedule(state) {
    var view = state.schedView === 'list' ? 'list' : 'calendar';
    var html = '<div class="gviews">' +
      '<button class="gview' + (view === 'calendar' ? ' on' : '') + '" data-act="cal-view" data-view="calendar">Calendar</button>' +
      '<button class="gview' + (view === 'list' ? ' on' : '') + '" data-act="cal-view" data-view="list">List</button>' +
      '</div>';
    return html + (view === 'calendar' ? renderCalendar(state) : renderScheduleList(state));
  }

  function renderScheduleList(state) {
    var rows = state.mine.filter(function (s) {
      return s.status === 'confirmed' || s.status === 'in_progress';
    });
    if (!rows.length) return '<div class="gempty">No confirmed shifts yet.</div>' + renderMyRequests(state);
    return '<div class="gcard"><h3>My schedule</h3>' + rows.map(function (s) {
      return scheduleRow(state, s);
    }).join('') + '</div>' + renderMyRequests(state);
  }

  // What the calendar shows, and how each status is named. CANCELLED IS NOT
  // HERE (owner, 2026-11-27): a caregiver never sees a cancelled shift. The
  // server already leaves them out of a caregiver's list; this is the second
  // lock, so a cancelled row that somehow arrives still never renders.
  //
  // `open` is the open pool as the server filtered it for this caregiver, and
  // only the shifts they can actually claim. One their licence does not cover
  // stays greyed on the Open shifts tab with its reason; on a calendar it
  // would only read as work they could pick up.
  var CAL_KINDS = [
    { id: 'confirmed', label: 'Confirmed' },
    { id: 'in_progress', label: 'In progress' },
    { id: 'completed', label: 'Completed' },
    { id: 'offered', label: 'Offered to you' },
    { id: 'claimed', label: 'Claimed, awaiting approval' },
    { id: 'open', label: 'Open, you can claim' }
  ];
  function calKind(s, fromPool) {
    if (!s || s.status === 'cancelled') return null;
    if (fromPool) return s.status === 'open' && s.claimable !== false ? 'open' : null;
    if (s.status === 'assigned') return 'offered';
    if (s.status === 'claimed' || s.status === 'confirmed' || s.status === 'in_progress' || s.status === 'completed') return s.status;
    return null;
  }
  function calEntries(state) {
    var out = [];
    var seen = {};
    (state.mine || []).forEach(function (s) {
      var k = calKind(s, false);
      if (k) { out.push({ shift: s, kind: k }); seen[s.id] = true; }
    });
    (state.open || []).forEach(function (s) {
      var k = calKind(s, true);
      if (k && !seen[s.id]) out.push({ shift: s, kind: k });
    });
    return out;
  }
  // Bucketed by the day it is IN GEORGIA, never the phone's own date: an 8pm
  // shift must not file under tomorrow for a phone set to another zone. The
  // scheduling board buckets the same way.
  function dayKey(iso) {
    var p = T && T.zonedParts ? T.zonedParts(iso) : null;
    return p ? p.isoDate : '';
  }
  function minutesOf(iso) {
    var p = T && T.zonedParts ? T.zonedParts(iso) : null;
    return p ? p.minutesOfDay : 0;
  }
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  function pad2(n) { return String(n).padStart(2, '0'); }
  // "9a", "2:30p": a phone's day cell is too narrow for "9:00 AM".
  function shortTime(iso) {
    var p = T && T.zonedParts ? T.zonedParts(iso) : null;
    if (!p) return '';
    var h = p.hour % 12 || 12;
    return h + (p.minute ? ':' + pad2(p.minute) : '') + (p.hour < 12 ? 'a' : 'p');
  }
  function todayParts() {
    var p = T && T.zonedParts ? T.zonedParts(new Date().toISOString()) : null;
    if (p) return { year: p.year, month: p.month - 1, key: p.isoDate };
    var d = new Date();
    return { year: d.getFullYear(), month: d.getMonth(), key: d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) };
  }
  function calCursor(state) {
    if (!state.cal) {
      var t = todayParts();
      state.cal = { year: t.year, month: t.month, day: t.key, hidden: {} };
    }
    return state.cal;
  }

  function renderCalendar(state) {
    var cal = calCursor(state);
    var today = todayParts();
    var entries = calEntries(state).filter(function (e) { return !cal.hidden[e.kind]; });
    var byDay = {};
    entries.forEach(function (e) {
      var k = dayKey(e.shift.start);
      if (!k) return;
      (byDay[k] = byDay[k] || []).push(e);
    });
    Object.keys(byDay).forEach(function (k) {
      byDay[k].sort(function (a, b) { return minutesOf(a.shift.start) - minutesOf(b.shift.start); });
    });

    var monthKey = cal.year + '-' + pad2(cal.month + 1);
    var inMonth = entries.filter(function (e) { return dayKey(e.shift.start).slice(0, 7) === monthKey; }).length;
    var lead = new Date(Date.UTC(cal.year, cal.month, 1)).getUTCDay();
    var days = new Date(Date.UTC(cal.year, cal.month + 1, 0)).getUTCDate();
    var cells = [];
    var n;
    for (n = 0; n < lead; n++) cells.push(null);
    for (n = 1; n <= days; n++) cells.push(n);
    while (cells.length % 7 !== 0) cells.push(null);

    var html = '<div class="gcard">' +
      '<div class="gcalhdr">' +
        '<button class="gbtn ghost gsm" data-act="cal-prev" aria-label="Previous month">\u2039</button>' +
        '<h3 class="gcaltitle">' + esc(MONTHS[cal.month] + ' ' + cal.year) + '</h3>' +
        '<button class="gbtn ghost gsm" data-act="cal-next" aria-label="Next month">\u203A</button>' +
        '<button class="gbtn ghost gsm" data-act="cal-today">Today</button>' +
      '</div>' +
      '<p class="gmu" style="margin:0 0 8px">' + (inMonth
        ? inMonth + ' shift' + (inMonth > 1 ? 's' : '') + ' this month. Every time is Eastern. Tap a day to see its shifts.'
        : 'No shifts this month.') + '</p>' +
      '<div class="gcal ghead">' + DOW.map(function (d) { return '<div class="gdow">' + d + '</div>'; }).join('') + '</div>' +
      '<div class="gcal">';
    cells.forEach(function (d, i) {
      if (d === null) { html += '<div class="gcell blank"></div>'; return; }
      var key = cal.year + '-' + pad2(cal.month + 1) + '-' + pad2(d);
      var list = byDay[key] || [];
      html += '<button class="gcell' + (key === today.key ? ' today' : '') + (key === cal.day ? ' picked' : '') +
        '" data-act="cal-day" data-day="' + key + '" aria-label="' + esc(MONTHS[cal.month] + ' ' + d + ', ' + list.length + ' shift' + (list.length === 1 ? '' : 's')) + '">' +
        '<span class="gdate">' + d + '</span>' +
        list.map(function (e) {
          return '<span class="gshift ' + e.kind + '">' +
            '<b class="gfull">' + esc(T ? T.fmtTime(e.shift.start) : '') + '</b>' +
            '<b class="gshort">' + esc(shortTime(e.shift.start)) + '</b>' +
            '<span class="gwho"> ' + esc(e.shift.clientName || (e.shift.staffRoleLabel ? e.shift.staffRoleLabel : '')) + '</span>' +
          '</span>';
        }).join('') +
      '</button>';
    });
    html += '</div>' +
      '<div class="glegend">' + CAL_KINDS.map(function (k) {
        return '<button class="gkey' + (cal.hidden[k.id] ? ' off' : '') + '" data-act="cal-filter" data-kind="' + k.id + '" aria-pressed="' + (cal.hidden[k.id] ? 'false' : 'true') + '">' +
          '<i class="gdot ' + k.id + '"></i>' + esc(k.label) + '</button>';
      }).join('') + '</div>' +
    '</div>';

    // The chosen day, with the same controls the list and the other tabs
    // offer for each shift: clock in on a confirmed one, accept an offer,
    // claim an open one. One set of buttons, built by the same functions.
    var picked = byDay[cal.day] || [];
    html += '<div class="gcard"><h3>' + esc(cal.day ? fmtPlainDate(cal.day) : 'Pick a day') + '</h3>' +
      (picked.length ? picked.map(function (e) { return calDetailRow(state, e); }).join('')
        : '<div class="gmu">Nothing on this day.</div>') +
    '</div>';
    return html + renderMyRequests(state);
  }

  function calDetailRow(state, e) {
    var s = e.shift;
    var label = '';
    for (var i = 0; i < CAL_KINDS.length; i++) if (CAL_KINDS[i].id === e.kind) label = CAL_KINDS[i].label;
    var tag = '<div class="gmu"><span class="gchip gk-' + e.kind + '">' + esc(label) + '</span></div>';
    if (e.kind === 'confirmed' || e.kind === 'in_progress') return scheduleRow(state, s);
    if (e.kind === 'offered') return offerRow(state, s, tag);
    if (e.kind === 'open') return openRow(s, tag);
    // Completed, or a claim waiting on the office: nothing to do but read it.
    return '<div class="grow" style="display:block">' +
      '<div class="gwhen">' + esc(fmtRange(s.start, s.end)) + '</div>' +
      '<div class="gmu">' + esc(whoLine(s)) + '</div>' + tag +
      (e.kind === 'claimed' ? '<div class="gmu">The office confirms it before it is yours.</div>' : '') +
    '</div>';
  }

  function whoLine(s) {
    return s.staffRole ? (s.staffRoleLabel + ' shift' + (s.clientName ? ' · visit: ' + s.clientName : ' · office')) : (s.clientName || '');
  }

  // WHERE AN ANSWER IS READ. A declined request carries the office's reason,
  // and a caregiver told only "no" asks again or stops telling us at all — the
  // same rule the rejected document upload follows. Withdrawn and approved
  // rows fall off after their shift has passed; a pending one always shows.
  function renderMyRequests(state) {
    var rows = (state.changeRequests || []).filter(function (r) {
      if (r.status === 'pending') return true;
      return r.decidedAt && (Date.now() - new Date(r.decidedAt).getTime()) < 21 * 86400000;
    });
    if (!rows.length) return '';
    return '<div class="gcard"><h3>My requests</h3>' + rows.map(function (r) {
      var label = r.kind === 'drop' ? 'Asked to hand back' : 'Asked to change the time';
      var chip = r.status === 'approved' ? 'ok' : (r.status === 'declined' ? 'warn' : '');
      return '<div class="grow" style="display:block">' +
        '<div class="gwhen">' + esc(fmtRange(r.shiftStart, r.shiftEnd)) + '</div>' +
        '<div class="gmu">' + esc(r.clientName || '') + ' · ' + esc(label) + '</div>' +
        (r.kind === 'time_change' && r.proposedStart
          ? '<div class="gmu">You asked for ' + esc(fmtRange(r.proposedStart, r.proposedEnd)) + '</div>'
          : '') +
        '<div class="gmu"><span class="gchip ' + chip + '">' + esc(titleize(r.status)) + '</span>' +
          (r.decidedByName ? ' by ' + esc(r.decidedByName) : '') + '</div>' +
        (r.decisionNote
          ? '<div class="gwhy">' + esc(r.decisionNote) + '</div>'
          : '') +
      '</div>';
    }).join('') + '</div>';
  }

  // The ask form. Two kinds, and the time boxes only exist for the one that
  // needs them — a "I cannot work this" form asking for a new start time is a
  // form nobody can answer.
  function askForm(s) {
    var local = function (iso) {
      // Pre-filled with the shift's OWN time in Georgia, so a caregiver
      // adjusting by an hour edits rather than retypes.
      if (!T || !T.zonedParts) return '';
      var p = T.zonedParts(new Date(iso));
      if (!p) return '';
      var pad = function (n) { return String(n).padStart(2, '0'); };
      return p.year + '-' + pad(p.month) + '-' + pad(p.day) + 'T' + pad(p.hour) + ':' + pad(p.minute);
    };
    // Rendered from the kinds the SERVER named for this shift. An offer takes a
    // time change only — handing an offer back is Decline, which is already on
    // the row — so the page must not restate the list and drift from the
    // validator that refuses what it offers.
    var kinds = s.changeRequestKinds && s.changeRequestKinds.length
      ? s.changeRequestKinds : ['time_change'];
    var LABELS = {
      time_change: 'A different time for this shift',
      drop: 'I cannot work this shift'
    };
    var offer = s.status === 'assigned';
    return '<div class="gask">' +
      (kinds.length > 1
        ? '<div class="gfield"><label>What are you asking for?</label>' +
            '<select id="gfcs-cr-kind" data-cr-kind="1">' +
              kinds.map(function (k) {
                return '<option value="' + esc(k) + '">' + esc(LABELS[k] || k) + '</option>';
              }).join('') +
            '</select></div>'
        : '<input type="hidden" id="gfcs-cr-kind" value="' + esc(kinds[0]) + '">') +
      '<div id="gfcs-cr-times">' +
        '<div class="gfield"><label>New start</label>' +
          '<input type="datetime-local" id="gfcs-cr-start" value="' + esc(local(s.start)) + '"></div>' +
        '<div class="gfield"><label>New end</label>' +
          '<input type="datetime-local" id="gfcs-cr-end" value="' + esc(local(s.end)) + '"></div>' +
      '</div>' +
      '<div class="gfield"><label>Why? The office needs a sentence.</label>' +
        '<textarea id="gfcs-cr-reason" rows="2" placeholder="School run — I can start two hours later."></textarea></div>' +
      // ASKING IS AGREEING, and the form has to say so before they send it.
      // The office confirms the shift onto their schedule on approval, so a
      // caregiver who meant "only if" must know that before they ask.
      '<p class="gmu">' + (offer
        ? 'Nothing changes until the office answers. If they approve the new time, the shift becomes yours at that time and goes on your schedule — so only ask if you will work it. If they say no, the original offer still stands and you can accept or decline it.'
        : 'Nothing changes until the office answers. Keep the shift until they do.') + '</p>' +
      '<div class="gbtns">' +
        '<button class="gbtn gold" data-act="send-ask" data-id="' + esc(s.id) + '">Send the request</button>' +
        '<button class="gbtn ghost" data-act="cancel-ask">Cancel</button>' +
      '</div>' +
    '</div>';
  }

  // `tag` is the calendar's status chip; the Offers tab passes none.
  function offerRow(state, s, tag) {
      return '<div class="grow" style="display:block">' +
        '<div class="gwhen">' + esc(fmtRange(s.start, s.end)) + '</div>' +
        (tag || '') +
        '<div class="gmu">' + esc(s.staffRole ? (s.staffRoleLabel + ' shift' + (s.clientName ? ' · visit: ' + s.clientName : ' · office')) : (s.clientName || '')) + '</div>' +
        (s.notes ? '<div class="gmu">' + esc(s.notes) + '</div>' : '') +
        // An offer at the wrong time is where a change is cheapest to ask
        // about: the alternative is declining outright, and then the office
        // has lost the caregiver AND still has the shift.
        (s.openChangeRequest
          ? '<div class="gmu"><span class="gchip">Asked to change the time</span> — waiting on the office.</div>'
          : '') +
        (state.asking === s.id ? askForm(s) : '') +
        '<div class="gbtns">' +
          '<button class="gbtn" data-act="accept" data-id="' + s.id + '">Accept</button>' +
          '<button class="gbtn ghost" data-act="decline" data-id="' + s.id + '">Decline</button>' +
          (s.changeRequestable && !s.openChangeRequest
            ? '<button class="gbtn ghost" data-act="ask-change" data-id="' + esc(s.id) + '">Ask for a different time</button>'
            : '') +
          (s.openChangeRequest
            ? '<button class="gbtn ghost" data-act="withdraw-change" data-id="' +
                esc(s.openChangeRequest.id) + '">Withdraw</button>'
            : '') +
        '</div>' +
        (!s.changeRequestable && !s.openChangeRequest && s.changeRequestBlockedReason
          ? '<div class="gwhy">' + esc(s.changeRequestBlockedReason) + '</div>'
          : '') +
      '</div>';
  }

  function renderOffers(state) {
    if (!state.offers.length) return '<div class="gempty">No shifts are waiting on your answer.</div>';
    return '<div class="gcard"><h3>Offered to you</h3>' + state.offers.map(function (s) {
      return offerRow(state, s);
    }).join('') + '</div>';
  }

  // The whole open board (owner rule, 2026-09-13). A shift this caregiver's
  // licence does not cover is shown GREYED OUT with the reason, not hidden —
  // seeing the board is how someone learns what work exists and which
  // credential would open it. The server decides `claimable`; this only
  // renders it, and the claim route re-checks independently, so a greyed row
  // that somehow got clicked is still refused server-side.
  //
  // `claimable !== false` is deliberate: an older cached response with no such
  // field renders as claimable and is refused at the API, which is the same
  // outcome as today. Reading a missing field as "not claimable" would grey out
  // the entire board on a stale payload.
  function openRow(s, tag) {
        var can = s.claimable !== false;
        return '<div class="grow' + (can ? '' : ' gblocked') + '" style="display:block">' +
          '<div class="gwhen">' + esc(fmtRange(s.start, s.end)) + '</div>' +
          (tag || '') +
          '<div class="gmu">' + esc(s.staffRole ? (s.staffRoleLabel + ' shift' + (s.clientName ? ' · visit: ' + s.clientName : ' · office')) : (s.clientName || '')) +
            (s.levelRequirementLabel ? ' · ' + esc(s.levelRequirementLabel) : '') + '</div>' +
          // Only a rate POSTED on the shift by an admin — identical for everyone
          // eligible, so it says nothing about any other caregiver's pay. A
          // caregiver deciding whether to pick up a shift is entitled to know
          // what it pays.
          (typeof s.payRate === 'number'
            ? '<div class="gpay">$' + s.payRate.toFixed(2) + ' / hour</div>' : '') +
          (s.notes ? '<div class="gmu">' + esc(s.notes) + '</div>' : '') +
          (can ? '' : '<div class="gwhy">Not available to you — ' + esc(s.ineligibleReason || 'your licence level does not meet this shift\'s requirement') + '</div>') +
          '<div class="gbtns"><button class="gbtn gold" data-act="claim" data-id="' + esc(s.id) + '"' +
            (can ? '' : ' disabled aria-disabled="true"') + '>Claim</button></div>' +
        '</div>';
  }

  function renderOpen(state) {
    if (!state.open.length) return '<div class="gempty">No open shifts right now.</div>';
    var takeable = state.open.filter(function (s) { return s.claimable !== false; }).length;
    return '<div class="gcard"><h3>Open shifts</h3>' +
      '<p class="gmu" style="margin-bottom:8px">Claiming submits the shift for approval. The office confirms it before it is yours.' +
        (takeable < state.open.length
          ? ' Shifts you are not credentialed for are shown greyed out.'
          : '') + '</p>' +
      state.open.map(function (s) { return openRow(s); }).join('') + '</div>';
  }

  function renderAvailability(state) {
    var lead = leadDaysFor(state);
    var changing = !!(state.availability && state.availability.length);
    var earliest = new Date(Date.now() + lead * 86400000).toISOString().slice(0, 10);
    var html = '<div class="gcard"><h3>' + (changing ? 'Change your availability' : 'Submit availability') + '</h3>' +
      '<p class="gmu" style="margin-bottom:10px">' +
      (changing
        // Somebody updating what they already told us is telling us their life
        // changed. Leading with the 14-day rule here reads as a refusal of the
        // thing they came to do.
        ? 'You can change this at short notice — the earliest it can start is ' + esc(earliest) + '. ' +
          'Your new answer replaces the one before it; the office works from your most recent one. ' +
          // A clinician (availability-only mount) has visits, not shifts.
          (state.onlyTabs
            ? '<strong>Visits already booked do not change.</strong> Reschedule those from the calendar.'
            : '<strong>Shifts you have already accepted do not change.</strong> To move or hand back one of those, ' +
              'use Request a change on the shift itself.')
        : 'Availability is submitted at least ' + lead +
          ' days ahead, so the office can build the schedule around it. The earliest you can start is ' + esc(earliest) + '. ' +
          'Submitting again replaces what you have now — the office works from your most recent one.') +
      '</p>' +
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
        // Who, when and what, on every row (owner report, 2026-11-20): the
        // list used to show only a start date and the hours, so a submission
        // carried no name, no submitted time, no note and no days off.
        return '<div class="grow" style="display:block">' +
          '<div class="gwhen">' + (a.caregiverName ? esc(a.caregiverName) + ' · ' : '') +
            'Starts ' + esc(fmtPlainDate(a.effectiveFrom)) + '</div>' +
          '<div class="gmu">' + ((a.windows || []).length ? a.windows.map(function (w) {
            return esc(w.day + ' ' + fmtClock(w.start) + '–' + fmtClock(w.end));
          }).join(' · ') : 'No days or hours given') + '</div>' +
          '<div class="gmu">Submitted ' + (a.submittedAt ? esc(fmtWhen(a.submittedAt)) : 'date not recorded') +
            (a.reviewedAt ? ' · Reviewed by ' + esc(a.reviewedByName || 'the office') : '') + '</div>' +
          (a.note ? '<div class="gmu">Note: ' + esc(a.note) + '</div>' : '') +
          ((a.blackoutDates || []).length
            ? '<div class="gmu">Unavailable: ' + esc(a.blackoutDates.map(fmtPlainDate).join(', ')) + '</div>'
            : '') +
          // Recorded by the office rather than typed by the caregiver. Said
          // plainly, because a caregiver reading back hours they did not enter
          // has to know where they came from to correct a mishearing.
          (a.enteredOnBehalf
            ? '<div class="gmu">Recorded for you by ' + esc(a.enteredByName || 'the office') +
              (a.entryNote ? ' — ' + esc(a.entryNote) : '') + '</div>'
            : '') +
          '<div class="gmu"><span class="gchip' + (a.status === 'reviewed' ? ' ok' : '') + '">' + esc(titleize(a.status)) + '</span>' +
            // Which one is actually in force. Submitting again does not erase
            // what you said before — it supersedes it — and without saying so
            // a caregiver cannot tell whether their update took.
            (a.current
              ? ' <span class="gchip ok">In force</span>'
              : ' <span class="gchip">Superseded</span>') +
          '</div>' +
        '</div>';
      }).join('') + '</div>';
    }
    return html;
  }

  // A W-2 staff member's clock: in or out, no shift. The open row is the one
  // with no shift and no clock-out.
  function renderStaffClock(state) {
    var open = null;
    for (var i = 0; i < state.timeLogs.length; i++) {
      var l = state.timeLogs[i];
      if (l && !l.shiftId && !l.clockOutAt) { open = l; break; }
    }
    return '<div class="gcard"><h3>Time clock</h3>' +
      (open
        ? '<p class="gmu" style="margin-bottom:10px">Clocked in since ' + esc(fmtWhen(open.clockInAt)) + '.</p>' +
          '<div class="gbtns"><button class="gbtn danger" data-act="staff-clock-out" data-id="staff">Clock out</button></div>'
        : '<p class="gmu" style="margin-bottom:10px">You are clocked out.</p>' +
          '<div class="gbtns"><button class="gbtn gold" data-act="staff-clock-in" data-id="staff">Clock in</button></div>') +
      '<p class="gmu" style="margin-top:10px">Forgot to clock in or out? Tell the office. They correct it with a reason.</p>' +
      '</div>';
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

    var kindSel = root.querySelector('[data-cr-kind]');
    if (kindSel) {
      kindSel.addEventListener('change', function () {
        var times = root.querySelector('#gfcs-cr-times');
        if (times) times.style.display = kindSel.value === 'drop' ? 'none' : '';
      });
    }

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
        if (act === 'visit-log') {
          // Same destination the refused clock-out sends them to; reaching it
          // from the button means the caregiver never has to be told no first.
          var pending = null;
          for (var j = 0; j < state.mine.length; j++) {
            if (state.mine[j] && state.mine[j].id === id) { pending = state.mine[j]; break; }
          }
          if (state.onVisitLogRequired) state.onVisitLogRequired(pending || { id: id });
          return;
        }
        // Calendar controls. Handled before the shift actions below, which
        // disable the button and post to the server.
        if (act === 'cal-view') { state.schedView = btn.getAttribute('data-view'); return render(state); }
        if (act === 'cal-prev' || act === 'cal-next' || act === 'cal-today') {
          var c = calCursor(state);
          var t = todayParts();
          if (act === 'cal-today') { c.year = t.year; c.month = t.month; }
          else {
            var m = c.month + (act === 'cal-next' ? 1 : -1);
            c.year += Math.floor(m / 12); c.month = ((m % 12) + 12) % 12;
          }
          var mk = c.year + '-' + pad2(c.month + 1);
          c.day = t.key.slice(0, 7) === mk ? t.key : mk + '-01';
          return render(state);
        }
        if (act === 'cal-day') { calCursor(state).day = btn.getAttribute('data-day'); state.asking = null; return render(state); }
        if (act === 'cal-filter') {
          var hid = calCursor(state).hidden; var kd = btn.getAttribute('data-kind');
          hid[kd] = !hid[kd];
          return render(state);
        }
        if (act === 'ask-change') { state.asking = id; state.error = ''; state.notice = ''; return render(state); }
        if (act === 'cancel-ask') { state.asking = null; return render(state); }
        if (act === 'send-ask') { btn.disabled = true; return sendChangeRequest(state, root, id); }
        if (act === 'withdraw-change') {
          btn.disabled = true;
          return api(state, '/api/scheduling/change-requests/' + id + '/withdraw', { method: 'POST' })
            .then(function () { state.notice = 'Request withdrawn.'; return refresh(state); })
            .catch(function (err) { state.error = err.message; render(state); });
        }
        btn.disabled = true;
        if (act === 'staff-clock-in' || act === 'staff-clock-out') return staffClock(state, act === 'staff-clock-in' ? 'clock-in' : 'clock-out');
        act === 'clock-in' || act === 'clock-out'
          ? clock(state, id, act)
          : shiftAction(state, id, act);
      });
    });
  }

  // Asking is a REQUEST, and the wording says so: nothing moves until the
  // office answers. A caregiver who believes the shift already changed is the
  // failure mode here, so neither the form nor the confirmation ever implies it.
  function sendChangeRequest(state, root, shiftId) {
    var kindEl = root.querySelector('#gfcs-cr-kind');
    var kind = kindEl ? kindEl.value : 'time_change';
    var reasonEl = root.querySelector('#gfcs-cr-reason');
    var startEl = root.querySelector('#gfcs-cr-start');
    var endEl = root.querySelector('#gfcs-cr-end');
    var body = { kind: kind, reason: reasonEl ? reasonEl.value : '' };
    if (kind === 'time_change') {
      // Built from the LOCAL datetime boxes through the shared clock, so a
      // caregiver picking 1pm gets 1pm in Georgia whatever their device says.
      body.proposedStart = startEl && startEl.value ? localToIso(startEl.value) : null;
      body.proposedEnd = endEl && endEl.value ? localToIso(endEl.value) : null;
    }
    state.error = ''; state.notice = '';
    api(state, '/api/scheduling/shifts/' + shiftId + '/change-request', { method: 'POST', body: body })
      .then(function (r) {
        state.asking = null;
        state.notice = (r && r.message) || 'Sent. The office will let you know.';
        return refresh(state);
      })
      .catch(function (err) {
        // The server's own sentence — including the office number when the
        // shift is inside the notice window.
        state.error = err.message;
        render(state);
      });
  }

  // A `datetime-local` value is wall-clock with no zone. Reading it with
  // `new Date()` uses the DEVICE's zone, so a caregiver travelling, or a phone
  // set wrong, would ask for a different hour than the one they typed. Every
  // time in this app is Eastern, so it is resolved through the shared clock.
  function localToIso(v) {
    var m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(String(v || ''));
    if (!m) return null;
    if (T && T.instantFromZoned) return T.instantFromZoned(m[1], m[2]);
    return null;
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

  function staffClock(state, act) {
    state.error = ''; state.notice = '';
    var path = act === 'clock-in' ? '/api/scheduling/staff-clock/clock-in' : '/api/scheduling/staff-clock/clock-out';
    return api(state, path, { method: 'POST', body: {} })
      .then(function (res) { state.notice = (res && res.message) || 'Done.'; return refresh(state); })
      .catch(function (err) { state.error = err.message; render(state); });
  }

  // ---- Data ---------------------------------------------------------------
  function refresh(state) {
    if (state.onlyTabs && state.onlyTabs.indexOf('availability') !== -1 && state.onlyTabs.length === 1) {
      return api(state, '/api/scheduling/availability').catch(function () { return { availability: [] }; }).then(function (r) {
        state.availability = r.availability || [];
        state.availabilityRules = r.rules || null;
        state.loading = false;
        render(state);
      });
    }
    if (state.staffOnly) {
      return Promise.all([
        api(state, '/api/scheduling/time-logs').catch(function () { return { timeLogs: [] }; }),
        api(state, '/api/scheduling/shifts').catch(function () { return { shifts: [] }; }),
        api(state, '/api/scheduling/change-requests').catch(function () { return { requests: [] }; })
      ]).then(function (r) {
        state.timeLogs = r[0].timeLogs || [];
        state.totalHours = r[0].totalHours;
        state.mine = r[1].shifts || [];
        state.offers = state.mine.filter(function (s) { return s.status === 'assigned'; });
        state.changeRequests = (r[2] && r[2].requests) || [];
        state.loading = false;
        render(state);
      });
    }
    return Promise.all([
      api(state, '/api/scheduling/shifts').catch(function () { return { shifts: [] }; }),
      api(state, '/api/scheduling/shifts/open').catch(function () { return { shifts: [] }; }),
      api(state, '/api/scheduling/availability').catch(function () { return { availability: [] }; }),
      api(state, '/api/scheduling/time-logs').catch(function () { return { timeLogs: [] }; }),
      api(state, '/api/scheduling/change-requests').catch(function () { return { requests: [] }; })
    ]).then(function (r) {
      var mine = r[0].shifts || [];
      state.mine = mine;
      state.offers = mine.filter(function (s) { return s.status === 'assigned'; });
      state.open = r[1].shifts || [];
      state.availability = r[2].availability || [];
      state.availabilityRules = r[2].rules || null;
      state.timeLogs = r[3].timeLogs || [];
      state.totalHours = r[3].totalHours;
      state.changeRequests = (r[4] && r[4].requests) || [];
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

    var earliest = new Date(Date.now() + leadDaysFor(state) * 86400000).toISOString().slice(0, 10);
    var state = {
      elementId: elementId,
      caregiverId: options.caregiverId || null,
      authToken: options.authToken,
      onChange: options.onChange || null,
      // Fired when a clock-out is refused because that shift has no visit log
      // yet. The log form belongs to the host page, so the shift is handed back
      // rather than this component trying to render a form it does not own.
      onVisitLogRequired: options.onVisitLogRequired || null,
      staffOnly: !!options.staffOnly,
      onlyTabs: Array.isArray(options.onlyTabs) && options.onlyTabs.length ? options.onlyTabs.slice() : null,
      tab: options.initialTab || (Array.isArray(options.onlyTabs) && options.onlyTabs.length ? options.onlyTabs[0] : options.staffOnly ? 'clock' : 'schedule'),
      loading: true,
      error: '', notice: '',
      mine: [], offers: [], open: [], availability: [], availabilityRules: null, timeLogs: [], totalHours: null,
      asking: null, changeRequests: [],
      // The Schedule tab opens on the calendar; List is the old view.
      schedView: 'calendar', cal: null,
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
