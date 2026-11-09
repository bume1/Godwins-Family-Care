'use strict';
// Care records live with the client (owner, 2026-11-09): a client's visit
// logs, concerns and incidents on their record; incidents get a lifecycle and
// an Incident Log; Caregiver Management becomes Home Care Oversight, a list of
// what is waiting; Enrollment is renamed Clients & Patients.
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const at = require('../accountTypes');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

const ADMIN = { id: 'a1', name: 'Office Admin', role: 'admin', accountType: 'admin' };
const MANAGER = { id: 'm1', name: 'Morgan Manager', role: 'user', accountType: 'manager', isManager: true };
const RN = { id: 'r1', name: 'Rae Nurse', role: 'user', accountType: 'rn', clinicalRole: 'rn', hasClinicalAccess: true };
const CG = { id: 'cg1', name: 'Cara Giver', role: 'vendor', accountType: 'caregiver', licenseLevel: 'cna' };
const CLIENT = { id: 'c1', name: 'Ada Bell', role: 'client' };
const OTHER = { id: 'c2', name: 'Bo Other', role: 'client' };
const FAMILY = { id: 'f1', name: 'Fay Bell', role: 'family', familyOfClientId: 'c1' };

function seed() {
  return {
    caregiver_visit_logs: [
      { id: 'v1', client_id: 'c1', caregiver_id: 'cg1', caregiver_name: 'Cara Giver', visit_type: 'pca', visit_date: '2026-11-07', status: 'submitted', submitted_at: '2026-11-07T18:00:00Z' },
      { id: 'v2', client_id: 'c2', caregiver_id: 'cg1', caregiver_name: 'Cara Giver', visit_type: 'pca', visit_date: '2026-11-07', status: 'submitted', submitted_at: '2026-11-07T19:00:00Z' }
    ],
    caregiver_visit_log_reviews: [{ id: 'rv1', visit_log_id: 'v1', note: 'All clear.', by_name: 'Rae Nurse', at: '2026-11-08' }],
    escalation_events: [
      { id: 'e1', client_id: 'c1', client_name: 'Ada Bell', caregiver_id: 'cg1', concern_type: 'clinical', status: 'raised', raised_at: '2026-11-05T15:00:00Z', visibility: ['r1'] },
      { id: 'e2', client_id: 'c2', client_name: 'Bo Other', caregiver_id: 'cg1', concern_type: 'behavioral', status: 'raised', raised_at: '2026-11-05T16:00:00Z', visibility: ['r1'] }
    ],
    escalation_status_events: [{ escalation_id: 'e1', status: 'received', at: '2026-11-05T15:01:00Z', by_name: 'system' }],
    incident_reports: [
      { id: 'i1', client_id: 'c1', caregiver_id: 'cg1', caregiver_name: 'Cara Giver', kind: 'falls', label: 'Falls', detail: 'Slipped in the bathroom.', status: 'open', reported_at: '2026-11-07T18:00:00Z' },
      { id: 'i2', client_id: 'c2', caregiver_id: 'cg1', caregiver_name: 'Cara Giver', kind: 'falls', label: 'Falls', status: 'open', reported_at: '2026-11-07T19:00:00Z' }
    ]
  };
}

async function mount(t, as, store = seed()) {
  const db = { get: async (k) => (k in store ? JSON.parse(JSON.stringify(store[k])) : null), set: async (k, v) => { store[k] = JSON.parse(JSON.stringify(v)); } };
  const activity = [];
  let ids = 0;
  const app = express();
  app.use(express.json());
  app.use(require('../routes/caregiver')({
    db, config, logActivity: async (...a) => { activity.push(a); }, queueNotification: async () => {},
    getUsers: async () => [ADMIN, MANAGER, RN, CG, CLIENT, OTHER, FAMILY], invalidateUsersCache: () => {},
    authenticateToken: (req, _res, next) => { req.user = as; next(); },
    uuidv4: () => `id${++ids}`, drive: {}, detectFileType: () => null
  }));
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, data: await r.json().catch(() => null) };
  };
  return { store, activity, call };
}

// ---- the client's care history -------------------------------------------------
test('a client\'s record carries only that client\'s visit logs, concerns and incidents', async (t) => {
  const h = await mount(t, MANAGER);
  const r = await h.call('GET', '/api/caregiver/clients/c1/care-history');
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.data.visitLogs.map(v => v.id), ['v1']);
  assert.deepStrictEqual(r.data.escalations.map(e => e.id), ['e1'],
    'all of THIS client\'s concerns, even one this manager was not notified on');
  assert.deepStrictEqual(r.data.incidents.map(i => i.id), ['i1']);
  assert.strictEqual(r.data.visitLogs[0].reviews[0].note, 'All clear.');
  assert.strictEqual(r.data.escalations[0].trail.length, 1);
  assert.strictEqual(r.data.incidents[0].client_name, 'Ada Bell');
  assert.strictEqual((await h.call('GET', '/api/caregiver/clients/cg1/care-history')).status, 404, 'a caregiver id is not a client');
});

test('care history is refused to a caregiver, a client and a family member', async (t) => {
  for (const who of [CG, CLIENT, FAMILY]) {
    const h = await mount(t, who);
    assert.strictEqual((await h.call('GET', '/api/caregiver/clients/c1/care-history')).status, 403, who.name);
  }
  const h = await mount(t, RN);
  assert.strictEqual((await h.call('GET', '/api/caregiver/clients/c1/care-history')).status, 200, 'licensed clinical staff read it');
});

// ---- incidents get a lifecycle ---------------------------------------------------
test('closing an incident needs a follow-up note, writes the trail, and is final', async (t) => {
  const h = await mount(t, MANAGER);
  const none = await h.call('POST', '/api/caregiver/incidents/i1/close', { note: '  ' });
  assert.strictEqual(none.status, 400);
  assert.strictEqual(none.data.code, 'INCIDENT_NOTE_REQUIRED');
  assert.strictEqual(h.store.incident_reports[0].status, 'open', 'a refusal writes nothing');

  const half = await h.call('POST', '/api/caregiver/incidents/i1/close', { note: 'Seen by RN.', stateReport: { reference: 'X1' } });
  assert.strictEqual(half.status, 400);
  assert.strictEqual(half.data.code, 'STATE_REPORT_INCOMPLETE', 'a state report names its date and agency');

  const ok = await h.call('POST', '/api/caregiver/incidents/i1/close', { note: 'Seen by RN; family told.', stateReport: { reportedAt: '2026-11-08', agency: 'GA HFRD', reference: 'R-9' } });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.data.incident.status, 'closed');
  assert.strictEqual(ok.data.incident.trail[0].note, 'Seen by RN; family told.');
  assert.deepStrictEqual(ok.data.incident.trail[0].stateReport, { reportedAt: '2026-11-08', agency: 'GA HFRD', reference: 'R-9' });
  assert.strictEqual(h.store.incident_events.length, 1);
  const logged = h.activity.find(a => a[2] === 'incident_closed');
  assert.ok(logged && logged[5].stateReported === true);
  assert.ok(!JSON.stringify(logged).includes('family told'), 'the activity log never copies the note');

  const again = await h.call('POST', '/api/caregiver/incidents/i1/close', { note: 'Again.' });
  assert.strictEqual(again.status, 409);
  assert.strictEqual(again.data.code, 'INCIDENT_CLOSED');
  assert.strictEqual(h.store.incident_events.length, 1, 'a closed incident gains nothing');

  const open = await h.call('GET', '/api/caregiver/incidents?status=open');
  assert.deepStrictEqual(open.data.incidents.map(i => i.id), ['i2']);
  const closed = await h.call('GET', '/api/caregiver/incidents?status=closed');
  assert.deepStrictEqual(closed.data.incidents.map(i => i.id), ['i1']);
});

test('only the caregiver office closes an incident', async (t) => {
  for (const who of [RN, CG]) {
    const h = await mount(t, who);
    assert.strictEqual((await h.call('POST', '/api/caregiver/incidents/i1/close', { note: 'x' })).status, 403, who.name);
    assert.strictEqual(h.store.incident_reports[0].status, 'open');
  }
  const h = await mount(t, ADMIN);
  assert.strictEqual((await h.call('POST', '/api/caregiver/incidents/nope/close', { note: 'x' })).status, 404);
});

test('the incident trail is a registered PHI collection', () => {
  const { COLLECTION_REGISTRY } = require('../dataMigration');
  const row = COLLECTION_REGISTRY.find(r => r.key === 'incident_events');
  assert.ok(row && row.phi === true);
});

// ---- the hub, the pages and the rename --------------------------------------------
test('the Incident Log is on the hub for the Super Admin, managers and coordinators only', () => {
  for (const t of ['admin', 'manager', 'coordinator']) {
    const area = at.hubAreasFor(at.fieldsFor(t)).find(a => a.id === 'adminCompliance');
    assert.ok(area && area.links.some(l => l.id === 'incidents' && l.path === '/incidents'), t);
  }
  assert.deepStrictEqual(at.hubAreasFor(at.fieldsFor('manager')).find(a => a.id === 'adminCompliance').links.map(l => l.id), ['incidents'],
    'a manager gets the Incident Log and nothing else of Admin & Compliance');
  for (const t of ['provider', 'rn', 'lcsw', 'lmsw', 'caregiver', 'client', 'family', 'liaison']) {
    assert.ok(!at.hubTilesFor({ ...at.fieldsFor(t), licenseLevel: 'cna' }).some(l => l.id === 'incidents'), t);
  }
  assert.match(read('routes/caregiver.js'), /router\.get\('\/incidents', \(req, res\) => \{/);
  const page = read('public/incidents.html');
  assert.match(page, /<script src="\/staff-nav\.js"><\/script>/);
  assert.match(page, /'\/api\/caregiver\/incidents\/' \+ encodeURIComponent\(inc\.id\) \+ '\/close'/);
  assert.ok(!/innerHTML/.test(strip(page)), 'nothing a caregiver typed is parsed as HTML');
});

test('Enrollment is renamed Clients & Patients everywhere a person reads it; the address stays', () => {
  const link = at.hubTilesFor(at.fieldsFor('admin')).find(l => l.id === 'enrollment');
  assert.deepStrictEqual([link.name, link.path], ['Clients & Patients', '/admin/enrollment']);
  const page = read('public/admin-enrollment.html');
  assert.match(page, /<title>Godwins Family Care — Clients & Patients<\/title>/);
  assert.ok(!/Enrollment Submissions|Enrollment submissions/.test(page), 'no heading still says Enrollment Submissions');
  const clinical = read('public/clinical.html');
  assert.match(clinical, /tab: 'Clients & Patients'/);
  assert.ok(!/>Open Enrollment</.test(clinical));
  assert.ok(!/<i className="ti ti-[a-z-]+" \/>Enrollment<\/a>/.test(clinical), 'no back link still says Enrollment');
  const oversight = at.hubTilesFor(at.fieldsFor('manager')).find(l => l.id === 'caregiverManagement');
  assert.strictEqual(oversight.name, 'Home Care Oversight');
});

test('the client record shows its Care History from the route that owns it', () => {
  const code = strip(read('public/admin-enrollment.html'));
  assert.match(code, /<Section title="Care History">\s*<CareHistory clientId=\{clientId\} \/>/);
  assert.match(code, /`\/api\/caregiver\/clients\/\$\{encodeURIComponent\(clientId\)\}\/care-history`/);
  assert.match(code, /e\.status === 403 \? 'Care history is for the office and clinical staff\.'/, 'a refusal is a sentence, not an empty history');
  for (const c of ['ChBlock', 'ChVisitLog', 'ChConcern', 'CareHistory']) {
    assert.match(read('public/admin-enrollment.html'), new RegExp(`\\n    const ${c} = `), `${c} at the page's top level`);
  }
});

test('Home Care Oversight opens on one Waiting list, and every row opens its record', () => {
  const code = strip(read('public/caregivers.html'));
  assert.match(code, /const \[tab, setTab\] = useState\('waiting'\);/);
  assert.match(code, /\{ id: 'waiting', label: 'Waiting', n: waitingCount \}/);
  assert.match(code, /const clientHref = \(clientId\) => `\/admin\/enrollment\?client=\$\{encodeURIComponent\(clientId\)\}`;/);
  // Lift the row builder out and run it.
  const a = code.indexOf('const waitingRows = ');
  const b = code.indexOf('const Waiting = ');
  const fn = new Function('titleize', 'recordHref', 'clientHref', `${code.slice(a, b)}; return waitingRows;`)(
    (s) => String(s || ''), (u, s) => `/admin?view=users&person=${u}#${s}`, (c) => `/admin/enrollment?client=${c}`);
  const rows = fn({
    escalations: [{ id: 'e1', status: 'raised', clientId: 'c1', raisedAt: '2026-11-05' }, { id: 'e9', status: 'resolved', clientId: 'c1', raisedAt: '2026-11-01' }],
    pendingLogs: [{ id: 'v1', clientId: 'c1', submittedAt: '2026-11-07' }],
    incidents: [{ id: 'i1', status: 'open', reported_at: '2026-11-06' }, { id: 'i9', status: 'closed', reported_at: '2026-11-02' }],
    documents: [{ id: 'd1', status: 'received', caregiverId: 'cg1', uploadedAt: '2026-11-04' }, { id: 'd9', status: 'accepted', caregiverId: 'cg1' }],
    notCleared: [{ caregiverId: 'cg2', name: 'New Hire' }]
  });
  assert.deepStrictEqual(rows.map(r => r.key), ['d:d1', 'e:e1', 'i:i1', 'v:v1', 'c:cg2'], 'oldest first, only what is waiting, undated last');
  assert.deepStrictEqual(rows.map(r => r.href), ['/admin?view=users&person=cg1#sr-documents', '/admin/enrollment?client=c1',
    '/incidents#i1', '/admin/enrollment?client=c1', '/admin?view=users&person=cg2#sr-onboarding']);
  // The incident tab reads the fields incidents carry (it read `type` and showed a blank client).
  assert.match(code, /<b>\{i\.label \|\| titleize\(i\.kind \|\| 'Incident'\)\} · \{i\.client_name \|\| ''\}<\/b>/);
  assert.match(code, /<span className="t">Home Care Oversight<\/span>/);
});

// ---- the home care pages wear the My GFC look (owner, 2026-11-09) -------------
test('Home Care Oversight and Caregiver Scheduling load the shared theme after their own styles', () => {
  const theme = read('public/css/gfc-theme.css');
  assert.match(theme, /body\{background:#FAF7F2/, 'the My GFC cream, not the older darker cream');
  assert.match(theme, /\.card\{border:1px solid #ECE4D6;border-radius:16px/);
  assert.match(theme, /\.tab\.on\{background:#C9A44A/, 'the selected tab is gold, as in the My GFC menu');
  for (const p of ['public/caregivers.html', 'public/scheduling.html']) {
    const page = read(p);
    const link = page.indexOf('<link rel="stylesheet" href="/css/gfc-theme.css">');
    assert.ok(link > 0, `${p} loads the theme`);
    assert.ok(link > page.lastIndexOf('</style>', page.indexOf('</head>')), `${p}: the theme comes after the page's own styles, so it wins`);
  }
});
