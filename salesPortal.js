// ============================================================================
// salesPortal.js — THE SALES PORTAL, MOVED IN FROM THE WEBSITE (owner, 2026-11-23)
// ============================================================================
// The Sales Portal used to be a password-protected WordPress page on the public
// website, which was down for most of November 2026. Owner: "lets get the
// original onto the app first. Then we need to address related scripts." So
// every section below is the website's portal AS IT STOOD (the 2026-10-08
// template in Drive), ported as-is. Refinements come after, in their own PR.
//
// WHAT CHANGED IN THE PORT, and nothing else did:
//   1. The shared team password is gone. Staff sign-in and the `sales` module
//      (accountTypes.js) decide who gets in.
//   2. Every `?gfc_doc=X` link points at /sales#X inside the app.
//   3. The decks and the brochure the scripts send people to were served from
//      the old website. They live here now (sales-portal/files), behind the
//      same sign-in, never in public/.
//   4. The email library (?gfc_doc=emails) was PHP. It is rebuilt here in Node,
//      reading the same Notion feed. The feed URL carries a shared token, so it
//      is read server-side only and never reaches a browser.
//
// HOW A PAGE IS AUTHORIZED. This app signs in with a Bearer token, which a
// plain page load or an <iframe src> cannot carry. So /api/sales/portal hands
// the signed-in person a short "ticket": a JWT naming their session. Every
// /sales/doc and /sales/files request checks that ticket AND that the session
// behind it is still live (sessions.check), so signing out, the idle timeout
// or a revoked session closes the portal too. A ticket only opens the Sales
// Portal; it is useless anywhere else in the app.
//
// Not PHI: marketing and outreach material, no client records.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');

const ROOT = path.join(__dirname, 'sales-portal');

const SOURCE = Object.freeze({
  from: 'Website Sales Portal template (template-gfc-sales-portal-2026-10-08.php, Drive)',
  portedAt: '2026-11-23'
});

// The order is the website's own nav order.
const DOCS = Object.freeze([
  { id: 'home', title: 'Home' },
  { id: 'start', title: 'Start Here' },
  { id: 'playbook', title: 'Playbook' },
  { id: 'script', title: 'Script' },
  { id: 'paysheet', title: 'Pay Sheet' },
  { id: 'map', title: 'Targeting Map' },
  { id: 'tasks', title: 'Task Board' },
  { id: 'emails', title: 'Emails' }
]);
const DOC_IDS = new Set(DOCS.map(d => d.id));

// The website paths the scripts linked to, and where each lives now.
const FILES = Object.freeze({
  'gfcfacilitydeck.html': { type: 'text/html; charset=utf-8', was: '/gfcfacilitydeck.html' },
  'gfcfamilydeckv2.html': { type: 'text/html; charset=utf-8', was: '/gfcfamilydeckv2.html' },
  'gfcltcdeckv2.html': { type: 'text/html; charset=utf-8', was: '/gfcltcdeckv2.html' },
  'gfcsocialservicesdeck.html': { type: 'text/html; charset=utf-8', was: '/gfcsocialservicesdeck.html' },
  // The brochure is marketing material handed to people outside GFC (it rides
  // in the facility follow-up emails), so it is PUBLIC: no login, no ticket.
  // A ticketed link pasted into an email would leak the session ticket and
  // stop working for the person who received it.
  'gfc-brochure.pdf': { type: 'application/pdf', was: 'https://godwinsfamilycarellc.com/wp-content/uploads/2026/05/Brochures_v7051126.pdf', publicPath: '/brochure.pdf' }
});

const OLD_SITE = /^https?:\/\/(www\.)?godwinsfamilycarellc\.com(\/|$)/i;

// ---- Tickets ---------------------------------------------------------------
const TICKET_PURPOSE = 'sales_portal';
const TICKET_TTL = '12h'; // the session behind it is checked on every use

function issueTicket(secret, user) {
  return jwt.sign({ p: TICKET_PURPOSE, uid: user.id, sid: user.sid }, secret, { expiresIn: TICKET_TTL });
}

// → { ok:true, uid, sid } | { ok:false }
function readTicket(secret, ticket) {
  if (!ticket || typeof ticket !== 'string') return { ok: false };
  try {
    const t = jwt.verify(ticket, secret);
    if (t.p !== TICKET_PURPOSE || !t.uid || !t.sid) return { ok: false };
    return { ok: true, uid: t.uid, sid: t.sid };
  } catch (e) { return { ok: false }; }
}

// ---- Rewriting a page so every link stays inside the app ------------------
const q = (s) => encodeURIComponent(s);

// Lets every page (and the map and task board nested inside Home) count as
// activity for the app's idle timer, which runs in the /sales page around it.
const ACTIVITY_SHIM = '<script>(function(){var t=0;function a(){var n=Date.now();if(n-t<4000)return;t=n;try{window.top.dispatchEvent(new Event("pointerdown"));}catch(e){}}["pointerdown","keydown","scroll","touchstart"].forEach(function(e){window.addEventListener(e,a,{passive:true});});})();</script>';

function rewrite(html, ticket, opts) {
  const base = String((opts && opts.baseUrl) || '').replace(/\/+$/, '');
  const T = q(ticket);
  const doc = (id, extra) => `/sales/doc/${id}?${extra ? extra + '&' : ''}ticket=${T}`;
  let out = String(html);

  // The website's own "Log out" (it ended the shared-password session). In the
  // app it signs the person out of the app.
  out = out.replace(/href="\?logout=1"/g, 'href="#" onclick="try{window.top.gfcSalesSignOut();}catch(e){}return false;"');

  // Pages embedded inside other pages load directly, with the ticket.
  out = out.replace(/(src|data-src)="\?gfc_doc=([a-z]+)"/g, (m, a, id) => `${a}="${doc(id)}"`);
  out = out.replace(/'\?gfc_doc=map&gfc_embed=1'/g, `'${doc('map', 'gfc_embed=1')}'`);

  // Links between sections open the section in the app's Sales Portal.
  out = out.replace(/href="\?gfc_doc=([a-z]+)"/g, (m, id) => `href="/sales#${id}" target="_top"`);
  out = out.replace(/href="\?"/g, 'href="/sales#home" target="_top"');
  out = out.replace(/window\.top\.location\.href='\?gfc_doc=map'/g, "window.top.location.href='/sales#map'");
  out = out.replace(/window\.open\('\?gfc_doc=map','_blank'\)/g, "window.open('/sales#map','_blank')");

  // The map used to treat ANY frame as the small home-page embed. Inside the
  // app every section sits in a frame, so only the explicit flag counts now.
  out = out.replace("var IS_EMBED = /[?&]gfc_embed=1/.test(location.search) || window.self!==window.top;",
    'var IS_EMBED = /[?&]gfc_embed=1/.test(location.search);');

  // Decks and the brochure, moved off the old website.
  for (const [name, f] of Object.entries(FILES)) {
    const was = f.was.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const to = f.publicPath ? `${base}${f.publicPath}` : `/sales/files/${name}?ticket=${T}`;
    out = out.replace(new RegExp(`href="${was}"`, 'g'), `href="${to}"`);
  }

  out = out.replace(/<\/body>/i, ACTIVITY_SHIM + '</body>');
  return out;
}

function readDoc(id) {
  if (!DOC_IDS.has(id) || id === 'emails') return null;
  return fs.readFileSync(path.join(ROOT, 'docs', `${id}.html`), 'utf8');
}

function renderDoc(id, ticket, opts) {
  const html = readDoc(id);
  return html == null ? null : rewrite(html, ticket, opts);
}

function filePath(name) {
  return Object.prototype.hasOwnProperty.call(FILES, name) ? path.join(ROOT, 'files', name) : null;
}

// ---- The email library (was PHP, reads the Notion feed) -------------------
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Copy is authored in Notion by the GFC team. Same allow-list the WordPress
// page used (wp_kses): the inline styles the engine's branded blocks rely on,
// and nothing executable.
const ALLOWED_TAGS = new Set(['a', 'p', 'br', 'strong', 'b', 'em', 'i', 'u', 'span', 'div', 'ul', 'ol', 'li',
  'table', 'thead', 'tbody', 'tr', 'td', 'th', 'img', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote']);
const ALLOWED_ATTRS = new Set(['style', 'class', 'href', 'target', 'rel', 'src', 'alt', 'width', 'height', 'align',
  'valign', 'colspan', 'rowspan', 'cellpadding', 'cellspacing', 'border', 'bgcolor']);

function cleanAttrs(raw) {
  const out = [];
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  while ((m = re.exec(raw))) {
    const name = m[1].toLowerCase();
    if (!ALLOWED_ATTRS.has(name)) continue;
    let v = m[2] != null ? m[2] : m[3] != null ? m[3] : m[4] != null ? m[4] : '';
    const decoded = v.replace(/&#x?[0-9a-f]+;?|&[a-z]+;/gi, '').replace(/[\s\u0000-\u001f]/g, '').toLowerCase();
    if ((name === 'href' || name === 'src') && !/^(https?:|mailto:|tel:|#|\/)/.test(decoded)) continue;
    if (name === 'style' && /expression|url\s*\(|javascript:/i.test(v)) continue;
    out.push(` ${name}="${esc(v.replace(/&quot;/g, '"').replace(/&amp;/g, '&'))}"`);
  }
  return out.join('');
}

function sanitize(html) {
  let s = String(html == null ? '' : html);
  // Drop whole elements whose content must never render.
  s = s.replace(/<(script|style|iframe|object|embed|noscript|template|svg|math)\b[\s\S]*?<\/\1\s*>/gi, '');
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  return s.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g, (m, tag, attrs) => {
    const t = tag.toLowerCase();
    if (!ALLOWED_TAGS.has(t)) return '';
    if (m[1] === '/') return `</${t}>`;
    return `<${t}${cleanAttrs(attrs)}${/\/\s*$/.test(attrs) ? ' /' : ''}>`;
  });
}

// WordPress's wpautop, the part the copy needs: blank lines make paragraphs,
// single newlines make <br>. Text that is already block HTML is left alone.
function autop(text) {
  const s = String(text == null ? '' : text).replace(/\r\n?/g, '\n').trim();
  if (!s) return '';
  if (/^\s*<(p|div|table|ul|ol|h[1-6]|blockquote)\b/i.test(s)) return s;
  return s.split(/\n\s*\n/).map(p => `<p>${p.replace(/\n/g, '<br>\n')}</p>`).join('\n');
}

const ROLE = {
  ED: ['ed', 'Executive Director'],
  DON: ['don', 'Director of Nursing'],
  WELLNESS: ['well', 'Wellness / Activities'],
  DEFAULT: ['def', 'No title known']
};
const roleOf = (r) => ROLE[String(r || '').toUpperCase()] || ['def', 'All roles'];

// The feed URL is `https://script.google.com/.../exec?templates=1&t=<token>`.
function feedParts(raw) {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    const token = u.searchParams.get('t');
    if (!token) return null;
    return { base: `${u.origin}${u.pathname}`, token };
  } catch (e) { return null; }
}

function createFeed({ feedUrl, fetchImpl = (...a) => fetch(...a), now = () => Date.now() } = {}) {
  const cache = new Map(); // status → { at, data }
  const lastGood = new Map();
  const FRESH_MS = 5 * 60 * 1000;
  const STALE_MS = 24 * 60 * 60 * 1000;
  const parts = () => feedParts(typeof feedUrl === 'function' ? feedUrl() : feedUrl);

  async function templates(status = 'Active') {
    const hit = cache.get(status);
    if (hit && now() - hit.at < FRESH_MS) return hit.data;
    const p = parts();
    if (!p) return { error: 'not_configured', templates: [] };
    const fallback = (code) => {
      const g = lastGood.get(status);
      if (g && now() - g.at < STALE_MS) return { ...g.data, stale: true };
      return { error: code, templates: [] };
    };
    let data;
    try {
      const u = new URL(p.base);
      u.searchParams.set('templates', '1'); u.searchParams.set('t', p.token); u.searchParams.set('status', status);
      const res = await fetchImpl(u.toString(), { redirect: 'follow', signal: AbortSignal.timeout(20000) });
      if (!res.ok) return fallback('unreachable');
      data = await res.json();
    } catch (e) { return fallback('unreachable'); }
    if (!data || !Array.isArray(data.templates)) return fallback('bad_response');
    cache.set(status, { at: now(), data });
    lastGood.set(status, { at: now(), data });
    return data;
  }

  async function preview(id) {
    const row = String(id || '').replace(/[^a-f0-9-]/gi, '');
    const p = parts();
    const msg = (t) => `<p style="font-family:system-ui,sans-serif;padding:24px">${t}</p>`;
    if (!row || !p) return msg('Preview unavailable. The template feed is not configured.');
    try {
      const u = new URL(p.base);
      u.searchParams.set('tpl', row); u.searchParams.set('t', p.token);
      const res = await fetchImpl(u.toString(), { redirect: 'follow', signal: AbortSignal.timeout(20000) });
      if (!res.ok) return msg('Could not load this preview. Try again in a moment.');
      return await res.text();
    } catch (e) { return msg('Could not load this preview. Try again in a moment.'); }
  }

  return { templates, preview };
}

function ago(iso, nowMs = Date.now()) {
  const t = Date.parse(iso);
  if (isNaN(t)) return '';
  const mins = Math.max(1, Math.round((nowMs - t) / 60000));
  if (mins < 60) return `${mins} min${mins === 1 ? '' : 's'}`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'}`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? '' : 's'}`;
}

function renderEmails(feed, ticket) {
  const shell = fs.readFileSync(path.join(ROOT, 'docs', 'emails.html'), 'utf8');
  const templates = Array.isArray(feed.templates) ? feed.templates : [];
  const err = feed.error || '';
  const uniq = (k) => Array.from(new Set(templates.map(t => t[k]).filter(Boolean))).sort();

  const live = err ? '' : `<span class="live${feed.stale ? ' stale' : ''}">${feed.stale
    ? 'Showing last known copy. The engine did not respond just now.'
    : 'Live from Notion &middot; refreshed every 5 minutes'}</span>`;

  let body;
  if (err === 'not_configured') {
    body = `<div class="note"><h3>Not connected yet</h3>
      <p>This section is ready but has nowhere to read from. Set <code>GFC_TEMPLATE_FEED_URL</code> in the app's environment on the server, then restart the app.</p>
      <p>Get the value by running <code>showTemplateFeedUrl()</code> in the sequence engine Apps Script project. It carries a shared token, so keep it out of email and chat.</p></div>`;
  } else if (err) {
    body = `<div class="note"><h3>Could not reach the engine</h3>
      <p>The template feed did not respond and there is no cached copy to fall back on. Reload in a minute. If it keeps failing, the Apps Script web app may need redeploying after a code change.</p></div>`;
  } else if (!templates.length) {
    body = `<div class="note"><h3>No active templates</h3>
      <p>The engine answered but every template row is still at Draft. Set a row's <strong>Status</strong> to <strong>Active</strong> in Notion and it appears here within five minutes.</p></div>`;
  } else {
    const opts = (vals) => ['<option value="">All</option>'].concat(vals.map(v => `<option value="${esc(v)}">${esc(v)}</option>`)).join('');
    const cards = templates.map(t => {
      const [rc, rl] = roleOf(t.role);
      const rn = t.rendered || {};
      const draft = t.status && t.status !== 'Active';
      const blk = (k, cls) => rn[k] ? `<div class="${cls}">${sanitize(autop(rn[k]))}</div>` : '';
      return `<article class="mail" data-campaign="${esc(t.campaign || '')}" data-facility="${esc(t.facility || '')}">
      <div class="mtop">
        <span class="pill ${rc}">${esc(rl)}</span>
        ${draft ? `<span class="pill draft">${esc(t.status)}</span>` : ''}
        <span class="who">${esc(t.facility || 'Any facility')}</span>
        <div class="mact">
          ${t.timesSent ? `<span class="stat">Sent ${parseInt(t.timesSent, 10) || 0}&times;</span>` : ''}
          <button type="button" class="mini prev" data-id="${esc(t.id)}" data-name="${esc(t.name)}">Preview email</button>
        </div>
      </div>
      <div class="mbody">
        <span class="lbl">Subject</span>
        <p class="subj">${esc(t.subject || '')}</p>
        ${t.headline ? `<h3 class="mh">${esc(t.headline)}</h3>` : ''}
        ${blk('opener', 'blk')}${blk('intro', 'blk')}${blk('valueProp', 'blk')}${blk('cta', 'cta')}
        <p class="sigline">The booking link, signature and footer are added automatically and are identical on every email. Open the preview to see the full message.</p>
      </div>
    </article>`;
    }).join('\n');
    body = `<div class="filters">
      <label for="fCamp">Email</label><select id="fCamp">${opts(uniq('campaign'))}</select>
      <label for="fFac">Facility</label><select id="fFac">${opts(uniq('facility'))}</select>
      <span class="count" id="tplCount">${templates.length} templates</span>
    </div>\n${cards}`;
  }

  const html = shell
    .replace('<!--LIVE-->', live)
    .replace('<!--BODY-->', body)
    .replace('<!--READ-->', feed.generatedAt ? `Copy read ${esc(ago(feed.generatedAt))} ago` : '')
    .replace('<!--PREVIEW_BASE-->', `/sales/doc/emails/preview?ticket=${q(ticket)}&id=`);
  return rewrite(html, ticket);
}

function portal() {
  return { source: SOURCE, docs: DOCS };
}

module.exports = {
  portal, DOCS, FILES, SOURCE, OLD_SITE, ROOT,
  issueTicket, readTicket, rewrite, renderDoc, readDoc, filePath,
  createFeed, renderEmails, sanitize, autop
};
