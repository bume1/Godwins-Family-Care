// ============================================================================
// THE SHARED STAFF BAR (owner, 2026-11-09)
// ============================================================================
// One thin bar across the top of every staff page: back to the Portal Hub, the
// area you are in, and an "All areas" menu to jump anywhere else you can open.
// Each page keeps its own sidebar and tabs; this only ties them together.
//
// Plain DOM, no framework, the same shape as session-guard.js, so it works on
// the React pages and the plain ones alike. It decides nothing about access:
// the areas come from GET /api/staff/hub (accountTypes.hubAreasFor), the same
// list the Portal Hub draws. An account with no areas (a client, a family
// contact) gets no bar at all. Every class starts with `gfc-sn-` so a page's
// own styles cannot reach it, and it cannot reach theirs. It draws only for
// accounts that land on the Portal Hub, which is every internal staff member.
// ============================================================================
(function () {
  if (window.GFC_STAFF_NAV) return;
  var HUB = '/login?hub=1';

  function token() {
    try {
      return localStorage.getItem('admin_token') || localStorage.getItem('unified_token') || localStorage.getItem('portal_token');
    } catch (e) { return null; }
  }

  // Which area is this page? The link whose path AND query match wins, then
  // the one whose path alone matches, so /admin?view=users&group=clients
  // reads as Clients while plain /admin reads as Admin & Compliance.
  function currentArea(areas, loc) {
    var here = loc.pathname.replace(/\/+$/, '') || '/';
    // A link with its own query (/admin?view=users) only claims the page when
    // the query matches; plain /admin belongs to the link with no query.
    var exact = null, byPath = null, under = null;
    areas.forEach(function (a) {
      (a.links || []).forEach(function (l) {
        var u;
        try { u = new URL(l.path, loc.origin); } catch (e) { return; }
        var p = u.pathname.replace(/\/+$/, '') || '/';
        if (p === here && u.search && u.search === loc.search && !exact) exact = a;
        if (p === here && !u.search && !byPath) byPath = a;
        if (here.startsWith(p + '/') && !u.search && !under) under = a;
      });
    });
    return exact || byPath || under || null;
  }

  var CSS = '' +
    '.gfc-sn{position:relative;z-index:60;background:#033D50;color:#fff;font-family:"DM Sans",system-ui,sans-serif;font-size:14px;line-height:1.3}' +
    '.gfc-sn *{box-sizing:border-box}' +
    '.gfc-sn-in{display:flex;align-items:center;gap:10px;padding:7px 14px;min-height:44px}' +
    '.gfc-sn a,.gfc-sn button{font:inherit;color:#fff;text-decoration:none;background:none;border:0;cursor:pointer;margin:0;width:auto}' +
    '.gfc-sn-hub{display:inline-flex;align-items:center;gap:8px;font-weight:700;padding:6px 10px;border-radius:9px}' +
    '.gfc-sn-hub:hover,.gfc-sn-menu:hover{background:rgba(255,255,255,.12)}' +
    // The full-color heart mark (cropped from the full-color logo), on a
    // white tile. The older logo-mark files are pale watermarks.
    '.gfc-sn-hub .gfc-sn-mark{display:inline-block;height:24px;width:24px;border-radius:6px;background:#fff url(/brand/logo-mark-color-transparent.png) center/18px no-repeat}' +
    '.gfc-sn-here{color:#E9D9A8;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}' +
    '.gfc-sn-sp{flex:1}' +
    '.gfc-sn-menu{display:inline-flex;align-items:center;gap:6px;font-weight:600;padding:6px 10px;border-radius:9px;border:1px solid rgba(255,255,255,.3)!important}' +
    '.gfc-sn-panel{position:absolute;right:10px;top:100%;margin-top:4px;width:min(360px,calc(100vw - 20px));max-height:calc(100vh - 70px);overflow:auto;background:#fff;color:#1a2a32;border:1px solid #ECE4D6;border-radius:14px;box-shadow:0 12px 32px -10px rgba(3,61,80,.35);padding:10px}' +
    '.gfc-sn-panel[hidden]{display:none}' +
    '.gfc-sn-panel h3{margin:10px 8px 4px;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#9A7430;font-weight:700}' +
    '.gfc-sn-panel a{display:block;color:#033D50;padding:8px 10px;border-radius:9px;font-weight:600}' +
    '.gfc-sn-panel a:hover{background:#F6EFE2}' +
    '.gfc-sn-panel a.gfc-sn-on{background:#C9A44A;color:#fff}' +
    '@media (max-width:520px){.gfc-sn-hubt{display:none}}' +
    '@media print{.gfc-sn{display:none}}';

  function el(tag, attrs, text) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    if (text) n.textContent = text;
    return n;
  }

  function render(areas) {
    if (!areas || !areas.length || document.querySelector('.gfc-sn')) return;
    if (!document.getElementById('gfc-sn-styles')) {
      var st = el('style', { id: 'gfc-sn-styles' }); st.textContent = CSS; document.head.appendChild(st);
    }
    var here = currentArea(areas, window.location);
    var bar = el('nav', { 'class': 'gfc-sn', 'aria-label': 'Staff areas' });
    var inner = el('div', { 'class': 'gfc-sn-in' });
    var hub = el('a', { 'class': 'gfc-sn-hub', href: HUB });
    hub.appendChild(el('span', { 'class': 'gfc-sn-mark', 'aria-hidden': 'true' }));
    hub.appendChild(el('span', { 'class': 'gfc-sn-hubt' }, 'Portal Hub'));
    hub.setAttribute('aria-label', 'Portal Hub');
    inner.appendChild(hub);
    if (here) inner.appendChild(el('span', { 'class': 'gfc-sn-here' }, here.name));
    inner.appendChild(el('span', { 'class': 'gfc-sn-sp' }));
    var btn = el('button', { 'class': 'gfc-sn-menu', type: 'button', 'aria-expanded': 'false', 'aria-controls': 'gfc-sn-panel' }, 'All areas ▾');
    inner.appendChild(btn);
    var panel = el('div', { 'class': 'gfc-sn-panel', id: 'gfc-sn-panel', hidden: '' });
    var herePath = window.location.pathname + window.location.search;
    areas.forEach(function (a) {
      panel.appendChild(el('h3', {}, a.name));
      (a.links || []).forEach(function (l) {
        var link = el('a', { href: l.path }, l.name);
        if (l.path === herePath || (l.path === window.location.pathname && !window.location.search)) link.className = 'gfc-sn-on';
        panel.appendChild(link);
      });
    });
    bar.appendChild(inner);
    bar.appendChild(panel);
    var close = function () { panel.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      panel.hidden = !panel.hidden;
      btn.setAttribute('aria-expanded', panel.hidden ? 'false' : 'true');
    });
    document.addEventListener('click', function (e) { if (!bar.contains(e.target)) close(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
    document.body.insertBefore(bar, document.body.firstChild);
  }

  function load() {
    var t = token();
    if (!t) return;
    fetch('/api/staff/hub', { headers: { Authorization: 'Bearer ' + t } })
      .then(function (r) { return r.ok ? r.json() : null; })
      // Staff land on the hub (landing null). A caregiver, liaison, client or
      // family member lands somewhere of their own and gets no bar.
      .then(function (d) { if (d && d.landing === null && Array.isArray(d.areas)) render(d.areas); })
      .catch(function () { /* no bar is better than a broken one */ });
  }

  window.GFC_STAFF_NAV = { currentArea: currentArea, reload: function () { var b = document.querySelector('.gfc-sn'); if (b) b.remove(); load(); } };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', load);
  else load();
})();
