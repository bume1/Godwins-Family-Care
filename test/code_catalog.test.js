// ============================================================
// OpenEMR owns the billing code catalog (owner rule, 2026-10-28).
//
// OpenEMR's `codes` table is the single source of truth for CPT4 and HCPCS.
// The app caches it (codeCatalog.js, app_kv `openemr_code_catalog`) and
// offers a service code only while that catalog holds it active. These tests
// pin: the loader's shape, the stale and failed states (never silent, never a
// hardcoded fallback), the rule-list check by code and file, and that no code
// list, 99343, 99999 or the out-of-scope G-codes come back into app source.
// Run: npm test
// ============================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const C = require('../codeCatalog');
const roles = require('../clinicalRoles');
const dataStore = require('../dataStore');

const ROOT = path.join(__dirname, '..');
const NOW = Date.parse('2026-10-28T15:00:00Z');
const row = (code, code_type = 'CPT4', active = 1, extra = {}) =>
  ({ code, code_type, active, modifier: '', code_text: `${code} long`, code_text_short: `${code} short`, ...extra });
// Every rule-list code active, plus the home-visit set the practice enters.
const fullRows = () => [
  ...['99341', '99342', '99344', '99345', '99347', '99348', '99349', '99350'].map(c => row(c)),
  ...roles.BEHAVIORAL_HEALTH_SERVICE_CODES.map(c => row(c, /^\d/.test(c) ? 'CPT4' : 'HCPCS'))
];
const silentLog = { error: () => {} };
const fakeEmr = (impl) => ({ forActor: () => ({ listCodeCatalog: impl }) });

// ---- shape ----
test('an OpenEMR row normalizes to { code, modifier, shortLabel, longLabel, codeType }', () => {
  assert.deepEqual(C.normalizeEntry(row('99348', 'CPT4', 1, { modifier: '25' })),
    { code: '99348', modifier: '25', shortLabel: '99348 short', longLabel: '99348 long', codeType: 'CPT4' });
  assert.equal(C.normalizeEntry(row('99348', 'ICD10')), null, 'ICD10 is not part of the billing catalog');
  assert.equal(C.normalizeEntry({ code: '', code_type: 'CPT4' }), null);
  assert.equal(C.normalizeEntry(row('99348', 'CPT4', 1, { code_text_short: '' })).shortLabel, '99348 long', 'short label falls back to the long one');
});

test('the catalog keeps active rows only, and remembers inactive ones by code', () => {
  const cat = C.buildCatalog([row('99348'), row('99348'), row('99347', 'CPT4', 0), row('G0506', 'HCPCS')], NOW);
  assert.deepEqual(cat.codes.map(c => c.code), ['99348', 'G0506']);
  assert.equal(cat.fetchedAt, new Date(NOW).toISOString());
  assert.equal(C.lookupCode(cat, '99348'), 'active');
  assert.equal(C.lookupCode(cat, '99347'), 'inactive');
  assert.equal(C.lookupCode(cat, '99350'), 'missing');
});

test('staleness is 24 hours, and an unloaded catalog is always stale', () => {
  const cat = C.buildCatalog([row('99348')], NOW);
  assert.equal(C.isStale(cat, NOW + 23 * 36e5), false);
  assert.equal(C.isStale(cat, NOW + 25 * 36e5), true);
  assert.equal(C.isStale(null, NOW), true);
});

// ---- rule lists ----
test('a rule-list code missing or inactive in OpenEMR is named by code and file, and fails the check', () => {
  const rows = fullRows().filter(r => r.code !== '90791');
  rows.push(row('90791', 'CPT4', 0));
  const cat = C.buildCatalog(rows.filter(r => r.code !== 'H0031'), NOW);
  const st = C.status(cat, NOW);
  assert.equal(st.ok, false);
  const byCode = Object.fromEntries(st.problems.map(p => [p.code, p]));
  assert.equal(byCode['90791'].state, 'inactive');
  assert.equal(byCode.H0031.state, 'missing');
  assert.equal(byCode.H0031.file, 'clinicalRoles.js');
  assert.match(byCode.H0031.message, /H0031.*BEHAVIORAL_HEALTH_SERVICE_CODES.*clinicalRoles\.js.*missing/);
  assert.equal(C.status(C.buildCatalog(fullRows(), NOW), NOW).ok, true, 'all present and active passes');
});

test('a catalog that never loaded fails the check; a stale one is reported but still served', () => {
  const never = C.status(null, NOW);
  assert.equal(never.ok, false);
  assert.equal(never.loaded, false);
  const old = C.status(C.buildCatalog(fullRows(), NOW), NOW + 48 * 36e5);
  assert.equal(old.ok, true);
  assert.equal(old.stale, true);
  assert.equal(old.ageHours, 48);
});

test('the BH rule list is registered for validation', () => {
  assert.ok(C.RULE_LISTS.some(l => l.file === 'clinicalRoles.js' && l.codes === roles.BEHAVIORAL_HEALTH_SERVICE_CODES));
});

// ---- the loader ----
test('a refresh caches the catalog in app_kv with fetchedAt', async () => {
  const db = dataStore.createStore({ adapter: 'memory' });
  const svc = C.createCodeCatalog({ db, openemr: fakeEmr(async () => fullRows()), log: silentLog, now: () => NOW });
  const out = await svc.refresh({ id: 'u1', name: 'Admin' });
  assert.equal(out.ok, true);
  const stored = await db.get(C.KV_KEY);
  assert.equal(stored.fetchedAt, new Date(NOW).toISOString());
  assert.ok(stored.codes.find(c => c.code === '99348'));
  assert.equal(stored.lastAttempt.ok, true);
});

test('OpenEMR unreachable: the cached catalog is kept and the failure is recorded, never silent', async () => {
  const db = dataStore.createStore({ adapter: 'memory' });
  await db.set(C.KV_KEY, C.buildCatalog(fullRows(), NOW - 30 * 36e5));
  const svc = C.createCodeCatalog({ db, openemr: fakeEmr(async () => { throw new Error('connect ECONNREFUSED'); }), log: silentLog, now: () => NOW });
  const out = await svc.refresh({ id: 'u1' });
  assert.equal(out.ok, false);
  assert.match(out.error, /ECONNREFUSED/);
  const st = await svc.status();
  assert.equal(st.loaded, true, 'the old catalog is still served');
  assert.equal(st.stale, true);
  assert.equal(st.lastAttempt.ok, false);
  assert.match(st.lastAttempt.error, /ECONNREFUSED/);
});

test('an empty answer never replaces a real catalog', async () => {
  const db = dataStore.createStore({ adapter: 'memory' });
  await db.set(C.KV_KEY, C.buildCatalog(fullRows(), NOW - 30 * 36e5));
  const svc = C.createCodeCatalog({ db, openemr: fakeEmr(async () => []), log: silentLog, now: () => NOW });
  const out = await svc.refresh({ id: 'u1' });
  assert.equal(out.ok, false);
  assert.ok((await db.get(C.KV_KEY)).codes.length > 0);
});

test('the daily refresh fires only when stale, and waits after a failure', async () => {
  const db = dataStore.createStore({ adapter: 'memory' });
  let calls = 0;
  const svc = C.createCodeCatalog({ db, openemr: fakeEmr(async () => { calls++; return fullRows(); }), log: silentLog, now: () => NOW });
  await db.set(C.KV_KEY, C.buildCatalog(fullRows(), NOW - 2 * 36e5));
  assert.equal(await svc.refreshIfStale({ id: 'u1' }), false, 'fresh: no call');
  await db.set(C.KV_KEY, { ...C.buildCatalog(fullRows(), NOW - 30 * 36e5), lastAttempt: { at: new Date(NOW - 60e3).toISOString(), ok: false, error: 'x' } });
  assert.equal(await svc.refreshIfStale({ id: 'u1' }), false, 'a failure a minute ago: wait');
  await db.set(C.KV_KEY, C.buildCatalog(fullRows(), NOW - 30 * 36e5));
  assert.equal(await svc.refreshIfStale({ id: 'u1' }), true);
  await new Promise(r => setImmediate(r));
  assert.equal(calls, 1);
  await db.set(C.KV_KEY, C.buildCatalog(fullRows(), NOW - 30 * 36e5));
  assert.equal(await svc.refreshIfStale(null), false, 'stale, but no person, no refresh: there is no system login');
  await new Promise(r => setImmediate(r));
  assert.equal(calls, 1);
});

// ---- what can be offered ----
test('every code the app can offer exists and is active in the OpenEMR catalog', () => {
  const cat = C.buildCatalog([...fullRows(), row('99343', 'CPT4', 0), row('99999', 'CPT4', 0)], NOW);
  const offered = [
    ...C.offeredEntries(cat).map(e => e.code),
    ...C.practiceServices([], cat).map(e => e.code),
    ...C.practiceServices([{ code: '99348' }, { code: '99351' }, { code: '99343' }], cat).map(e => e.code)
  ];
  assert.ok(offered.length > 0);
  for (const code of offered) assert.equal(C.lookupCode(cat, code), 'active', `${code} is offered but not active in OpenEMR`);
  assert.deepEqual(C.practiceServices([{ code: '99348' }, { code: '99351' }], cat).map(e => e.code), ['99348'], 'a favorite OpenEMR does not hold is dropped');
  assert.deepEqual(C.practiceServices([{ code: '99348' }], null), [], 'no catalog, nothing from the app\'s side');
});

test('99343 can never be selected: it is not offered and not an active code', () => {
  for (const cat of [C.buildCatalog(fullRows(), NOW), C.buildCatalog([...fullRows(), row('99343', 'CPT4', 0)], NOW), null]) {
    assert.equal(C.isOffered(cat, '99343'), false);
    assert.ok(!C.offeredEntries(cat).some(e => e.code === '99343'));
    assert.ok(!C.practiceServices([{ code: '99343' }], cat).length);
  }
});

test('G0177, G0409 and G0410 are never offered, even if OpenEMR holds them active', () => {
  const cat = C.buildCatalog([...fullRows(), row('G0177', 'HCPCS'), row('G0409', 'HCPCS'), row('G0410', 'HCPCS')], NOW);
  for (const code of ['G0177', 'G0409', 'G0410']) {
    assert.equal(C.isOffered(cat, code), false);
    assert.ok(!C.offeredEntries(cat).some(e => e.code === code));
    assert.ok(!roles.BEHAVIORAL_HEALTH_SERVICE_CODES.includes(code), `${code} must not be billable by an LCSW`);
  }
  const lcsw = { role: 'user', hasClinicalAccess: true, clinicalRole: 'lcsw' };
  assert.deepEqual(roles.disallowedServiceCodesFor(lcsw, [{ code: 'G0409' }]), ['G0409']);
});

// ---- the server uses it ----
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
test('the service-code search offers only through the catalog', () => {
  const branch = SERVER.slice(SERVER.indexOf("app.get('/api/clinical/codes/search'"), SERVER.indexOf("app.get('/api/clinical/patients/:clientId/dx-candidates'"));
  const svc = branch.slice(branch.indexOf('} else {'));
  assert.match(svc, /codeCatalogService\.load\(\)/);
  assert.match(svc, /codeCatalog\.isOffered\(catalog, code\)/);
  // every push in the service branch goes through offer(), except OpenEMR's
  // own live rows when no catalog is cached, which must be active
  assert.match(svc, /const offer = \(r\) => \{ if \(offered\(r\.code\)\) push\(/);
  const pushes = svc.slice(0, svc.indexOf('res.json(')).match(/\bpush\(/g) || [];
  assert.equal(pushes.length, 2, 'offer() and the no-catalog live-row path are the only two pushes');
  assert.match(svc, /Number\(r\.active\) === 1 && !clinicalRoles\.isNotOfferedServiceCode/);
});

test('saving a service code checks it against the catalog', () => {
  const route = SERVER.slice(SERVER.indexOf("app.put('/api/clinical/patients/:clientId/encounters/:euuid/coding'"));
  const body = route.slice(0, route.indexOf('\napp.'));
  assert.match(body, /SVC_NOT_IN_CATALOG/);
  assert.match(body, /CODE_CATALOG_UNAVAILABLE/);
  assert.match(body, /SVC_NOT_OFFERED/);
  assert.match(body, /codeCatalog\.isOffered\(catalog, c\)/);
});

test('/healthz carries the catalog check without failing the load balancer; /healthz/code-catalog fails', () => {
  assert.match(SERVER, /app\.get\('\/healthz', async[\s\S]{0,300}checks: \{ codeCatalog: await codeCatalogHealth\(\) \}/);
  assert.match(SERVER, /app\.get\('\/healthz\/code-catalog'[\s\S]{0,200}res\.status\(c\.ok \? 200 : 503\)/);
});

test('the catalog collection is registered for migration', () => {
  const { COLLECTION_REGISTRY } = require('../dataMigration');
  assert.ok(COLLECTION_REGISTRY.some(e => e.key === C.KV_KEY));
});

// ---- nothing hardcoded comes back ----
// Non-test app source: every .js/.html/.php outside node_modules, test/, the
// probe scripts (scripts/verify_*, the 6B acceptance.js) and docs prose.
const sourceFiles = () => {
  const out = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      const rel = path.relative(ROOT, p);
      if (ent.isDirectory()) {
        if (['node_modules', '.git', 'test', 'attached_assets', 'vendor'].includes(ent.name)) continue;
        if (rel === 'docs' ) { walk(path.join(p, 'openemr-patches')); continue; }
        walk(p);
      } else if (/\.(js|html|php)$/.test(ent.name) && !/^scripts[\\/]verify_/.test(rel) && ent.name !== 'acceptance.js') {
        out.push(rel);
      }
    }
  };
  walk(ROOT);
  return out;
};
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');

test('99343 appears nowhere in non-test source', () => {
  for (const f of sourceFiles()) {
    assert.ok(!fs.readFileSync(path.join(ROOT, f), 'utf8').includes('99343'), `${f} mentions 99343, a deleted CPT code`);
  }
});

test('99999 is not used as a code anywhere in non-test source', () => {
  for (const f of sourceFiles()) {
    assert.ok(!/['"`]99999['"`]/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')), `${f} carries 99999 as a code`);
  }
});

test('G0177, G0409 and G0410 appear in no page a clinician loads', () => {
  for (const f of sourceFiles().filter(f => f.startsWith('public'))) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const code of ['G0177', 'G0409', 'G0410']) assert.ok(!src.includes(code), `${f} shows ${code}`);
  }
});

test('no CPT/HCPCS code list lives in app source outside the clinicalRoles.js rule lists', () => {
  const allowed = new Set(['clinicalRoles.js']);
  const codeLit = /['"`](\d{4}[0-9A-Z]|[A-V]\d{4})['"`]/g;
  for (const f of sourceFiles()) {
    if (allowed.has(f)) continue;
    const src = stripComments(fs.readFileSync(path.join(ROOT, f), 'utf8'));
    const hits = [...src.matchAll(codeLit)].map(m => m[1]).filter(c => /^(9\d{4}|[A-V]\d{4}|\d{4}[A-Z])$/.test(c));
    assert.deepEqual(hits, [], `${f} carries service-code literals: ${hits.join(', ')}`);
  }
});
