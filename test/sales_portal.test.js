// The Sales Portal (owner, 2026-11-23): the website's portal moved into the
// app as-is, under the staff login.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const at = require('../accountTypes');
const sp = require('../salesPortal');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const SECRET = 'test-secret';

test('who has the Sales Portal: Super Admin, managers and the Community Care Liaison', () => {
  for (const t of ['admin', 'manager', 'liaison']) assert.ok(at.hasModule(at.fieldsFor(t), 'sales'), t);
  // Nobody else gained it; a coordinator gets it only as a grant.
  for (const t of ['coordinator', 'provider', 'rn', 'lcsw', 'lmsw', 'client', 'family']) assert.ok(!at.hasModule(at.fieldsFor(t), 'sales'), t);
  assert.ok(!at.hasModule({ ...at.fieldsFor('caregiver'), licenseLevel: 'cna' }, 'sales'));
  assert.ok(at.hasModule({ ...at.fieldsFor('coordinator'), moduleAccess: { granted: ['sales'], removed: [] } }, 'sales'));
  assert.ok(!at.hasModule({ ...at.fieldsFor('liaison'), moduleAccess: { granted: [], removed: ['sales'] } }, 'sales'));
  assert.ok(at.GRANTABLE_MODULES.includes('sales'));
});

test('the routes are gated: the API on the Sales module, the pages on a live-session ticket', () => {
  const src = read('server.js');
  assert.match(src, /app\.get\('\/api\/sales\/portal', authenticateToken, requireSalesPortal,/);
  assert.match(src, /accountTypes\.hasModule\(req\.user, 'sales'\)/);
  assert.match(src, /app\.get\('\/sales', \(req, res\) => \{\s*res\.sendFile\(__dirname \+ '\/public\/sales\.html'\);/);
  for (const r of ["'/sales/doc/emails/preview'", "'/sales/doc/:id'", "'/sales/files/:name'"]) {
    assert.match(src, new RegExp(`app\\.get\\(${r.replace(/[/:.]/g, '\\$&')}, requireSalesTicket,`), r);
  }
  // The ticket is only good while the session behind it is.
  const gate = src.slice(src.indexOf('const requireSalesTicket'), src.indexOf('const salesEmailFeed'));
  assert.match(gate, /sessions\.check\(t\.sid\)/);
  assert.match(gate, /accountTypes\.hasModule\(user, 'sales'\)/);
  assert.match(gate, /accountStatus === 'inactive'/);
  assert.ok(require('../auditLog').NON_PHI_PREFIXES.includes('/api/sales'));
});

test('a ticket opens only the Sales Portal and names the session', () => {
  const t = sp.issueTicket(SECRET, { id: 'u1', sid: 's1' });
  assert.deepStrictEqual(sp.readTicket(SECRET, t), { ok: true, uid: 'u1', sid: 's1' });
  assert.ok(!sp.readTicket('other-secret', t).ok);
  assert.ok(!sp.readTicket(SECRET, '').ok);
  // An ordinary app token is not a ticket.
  const jwt = require('jsonwebtoken');
  assert.ok(!sp.readTicket(SECRET, jwt.sign({ id: 'u1', sid: 's1' }, SECRET)).ok);
});

test('every section of the website portal is here', () => {
  assert.deepStrictEqual(sp.DOCS.map(d => d.id), ['home', 'start', 'playbook', 'script', 'paysheet', 'map', 'tasks', 'emails']);
  for (const d of sp.DOCS) assert.ok(fs.existsSync(path.join(sp.ROOT, 'docs', `${d.id}.html`)), d.id);
  for (const f of Object.keys(sp.FILES)) assert.ok(fs.existsSync(path.join(sp.ROOT, 'files', f)), f);
  assert.strictEqual(sp.renderDoc('nope', 'x'), null);
  assert.strictEqual(sp.filePath('../server.js'), null);
});

test('no page links to the old website or its password gate once ported', () => {
  const T = 'TICKET';
  const pages = sp.DOCS.filter(d => d.id !== 'emails').map(d => [d.id, sp.renderDoc(d.id, T)]);
  pages.push(['emails', sp.renderEmails({ templates: [] }, T)]);
  for (const [id, html] of pages) {
    assert.ok(!/\?gfc_doc=/.test(html), `${id}: website section link left`);
    assert.ok(!/\?logout=1/.test(html), `${id}: website log-out left`);
    assert.ok(!/<\?php/.test(html), `${id}: PHP left`);
    for (const [name, f] of Object.entries(sp.FILES)) assert.ok(!html.includes(`href="${f.was}"`), `${id}: ${name} still on the website`);
    for (const m of html.matchAll(/(?:href|src)=["']([^"']+)["']/g)) assert.ok(!sp.OLD_SITE.test(m[1]), `${id}: ${m[1]}`);
    assert.ok(html.includes('window.top.dispatchEvent'), `${id}: activity does not reach the idle timer`);
  }
  // In the app every section sits in a frame; only the flag makes the map small.
  assert.ok(!sp.renderDoc('map', T).includes('|| window.self!==window.top;'));
  assert.ok(sp.renderDoc('home', T).includes(`/sales/doc/map?gfc_embed=1&ticket=${T}`));
  assert.ok(sp.OLD_SITE.test('https://godwinsfamilycarellc.com/sales'));
  assert.ok(!sp.OLD_SITE.test('https://app.godwinsfamilycarellc.com/sales'));
});

test('the email library: Notion copy is cleaned, the feed token never reaches the page', async () => {
  const calls = [];
  const feed = sp.createFeed({
    feedUrl: 'https://script.google.com/macros/s/X/exec?templates=1&t=SECRETTOKEN',
    fetchImpl: async (url) => { calls.push(url); return { ok: true, json: async () => ({ generatedAt: new Date().toISOString(), templates: [
      { id: 'abc-1', name: 'Intro <b>', role: 'ED', campaign: 'Intro', facility: 'ALF', status: 'Active', subject: 'Hi <script>x</script>',
        rendered: { opener: 'Hello\n\nThere<script>alert(1)</script>', cta: '<a href="javascript:alert(1)" onclick="x()">Book</a> <a href="https://calendar.google.com/x">ok</a>' } }
    ] }) }; }
  });
  const data = await feed.templates();
  const html = sp.renderEmails(data, 'TICKET');
  assert.ok(!html.includes('SECRETTOKEN'));
  assert.ok(!/<script>alert|javascript:|onclick="x/.test(html));
  assert.ok(html.includes('Hi &lt;script&gt;'));
  assert.ok(html.includes('href="https://calendar.google.com/x"'));
  assert.ok(html.includes('<p>Hello</p>'));
  assert.ok(html.includes('/sales/doc/emails/preview?ticket=TICKET&id='));
  await feed.templates();
  assert.strictEqual(calls.length, 1, 'cached for five minutes');
  const notSet = sp.renderEmails(await sp.createFeed({ feedUrl: '' }).templates(), 'T');
  assert.ok(notSet.includes('GFC_TEMPLATE_FEED_URL'));
});

test('the page is only a frame around the sections the server sends', () => {
  const page = read('public/sales.html');
  assert.match(page, /fetch\('\/api\/sales\/portal'/);
  assert.match(page, /'\/sales\/doc\/' \+ id \+ '\?ticket='/);
  assert.match(page, /<script src="\/staff-nav\.js"><\/script>/);
  assert.match(page, /<script src="\/session-guard\.js"><\/script>/);
  assert.match(page, /window\.gfcSalesSignOut/);
  // The decks and brochure ship in the image; .dockerignore drops PDFs by default.
  assert.match(read('.dockerignore'), /^!sales-portal\/files\/\*\.pdf$/m);
});
