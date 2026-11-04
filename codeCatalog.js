'use strict';
// The billable code catalog, owned by OpenEMR (owner rule, 2026-10-28).
//
// OpenEMR's `codes` table is the single source of truth for which CPT4 and
// HCPCS codes this practice bills. The app keeps NO list of its own: it reads
// the table through the Phase 6B route's ?catalog=1 mode, caches the answer in
// app_kv under `openemr_code_catalog`, and offers a service code only when the
// cached catalog says it exists and is active.
//
// Three rules shape everything below:
//
//   1. NEVER A HARDCODED FALLBACK. If OpenEMR cannot be reached, the cached
//      catalog is served and the admin hub says how old it is. If there is no
//      cached catalog at all, nothing is offered from the app's side; the
//      clinician still gets OpenEMR's own live search.
//
//   2. NEVER A SILENT STALE CATALOG. Every status answer carries fetchedAt,
//      whether it is stale, and the last failed attempt with OpenEMR's reason.
//
//   3. A REFRESH NEEDS A REAL PERSON'S SESSION. Since Session 5.2 every
//      OpenEMR read runs as the person asking, and there is no system login.
//      So "refresh daily" means: the first signed-in staff request after the
//      catalog turns 24 hours old refreshes it with that person's session,
//      in the background. An admin can also refresh on demand. Nothing here
//      may add a service identity to get around that.
//
// Rule lists that map codes to roles (clinicalRoles.js) are POLICY, not
// catalog, and stay in source. They are checked against the catalog after
// every refresh and at boot; a code in one that is missing or inactive in
// OpenEMR is logged by code and file, and fails /healthz.

const clinicalRoles = require('./clinicalRoles');

const KV_KEY = 'openemr_code_catalog';
const CATALOG_TYPES = Object.freeze(['CPT4', 'HCPCS']);
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;
// How long a failed background refresh waits before another request may try
// again, so an OpenEMR outage does not turn every request into a retry.
const RETRY_AFTER_MS = 15 * 60 * 1000;

// The policy lists checked against the catalog. Each names its file so the
// error says where to look.
const RULE_LISTS = Object.freeze([
  { file: 'clinicalRoles.js', list: 'BEHAVIORAL_HEALTH_SERVICE_CODES', codes: clinicalRoles.BEHAVIORAL_HEALTH_SERVICE_CODES }
]);

const upper = (v) => String(v == null ? '' : v).trim().toUpperCase();

// One OpenEMR row → { code, modifier, shortLabel, longLabel, codeType }.
// A row with no code or a type outside the catalog is dropped (null).
const normalizeEntry = (row) => {
  if (!row || typeof row !== 'object') return null;
  const code = upper(row.code);
  const codeType = upper(row.code_type || row.codeType);
  if (!code || !CATALOG_TYPES.includes(codeType)) return null;
  const longLabel = String(row.code_text || row.longLabel || '').trim();
  const shortLabel = String(row.code_text_short || row.shortLabel || '').trim() || longLabel;
  return { code, modifier: upper(row.modifier), shortLabel, longLabel, codeType };
};
const isActiveRow = (row) => Number(row && row.active) === 1;

// Raw rows → the cached record. Active rows become the catalog; inactive rows
// are kept by code only, so a rule-list check can say "inactive" rather than
// "missing" — switched off in OpenEMR and never entered are different fixes.
const buildCatalog = (rows, now = new Date()) => {
  const codes = []; const seen = new Set();
  const inactive = []; const seenInactive = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    const e = normalizeEntry(row);
    if (!e) continue;
    const key = `${e.codeType}|${e.code}|${e.modifier}`;
    if (isActiveRow(row)) {
      if (!seen.has(key)) { seen.add(key); codes.push(e); }
    } else if (!seenInactive.has(key)) {
      seenInactive.add(key); inactive.push({ code: e.code, modifier: e.modifier, codeType: e.codeType });
    }
  }
  codes.sort((a, b) => a.codeType.localeCompare(b.codeType) || a.code.localeCompare(b.code) || a.modifier.localeCompare(b.modifier));
  return { fetchedAt: new Date(now).toISOString(), codes, inactive };
};

const isLoaded = (catalog) => !!(catalog && catalog.fetchedAt && Array.isArray(catalog.codes));
const isStale = (catalog, now = Date.now()) =>
  !isLoaded(catalog) || (new Date(now).getTime() - new Date(catalog.fetchedAt).getTime()) > STALE_AFTER_MS;

// 'active' | 'inactive' | 'missing', at the CODE level (any modifier).
const lookupCode = (catalog, code) => {
  const c = upper(code);
  if (!isLoaded(catalog) || !c) return 'missing';
  if (catalog.codes.some(e => e.code === c)) return 'active';
  if ((catalog.inactive || []).some(e => e.code === c)) return 'inactive';
  return 'missing';
};

// Offered to a clinician: active in OpenEMR AND not one this practice keeps
// out of view (clinicalRoles.NOT_OFFERED_SERVICE_CODES, out of scope for GFC).
const isOffered = (catalog, code) =>
  lookupCode(catalog, code) === 'active' && !clinicalRoles.isNotOfferedServiceCode(code);
const entryFor = (catalog, code) => {
  const c = upper(code);
  return isLoaded(catalog) ? (catalog.codes.find(e => e.code === c && !e.modifier) || catalog.codes.find(e => e.code === c) || null) : null;
};
// Every offerable entry, one per code (the plain row preferred over a
// modifier variant), for a picker.
const offeredEntries = (catalog) => {
  if (!isLoaded(catalog)) return [];
  const out = []; const seen = new Set();
  for (const e of catalog.codes) {
    if (seen.has(e.code) || clinicalRoles.isNotOfferedServiceCode(e.code)) continue;
    seen.add(e.code);
    out.push(entryFor(catalog, e.code));
  }
  return out;
};

// The practice service list a clinician sees: the admin's favorites where
// set, else the catalog itself, and in both cases only codes the catalog holds
// active and GFC offers.
const practiceServices = (favorites, catalog) => {
  const favs = Array.isArray(favorites) ? favorites : [];
  if (favs.length) {
    return favs.filter(f => f && isOffered(catalog, f.code)).map(f => {
      const e = entryFor(catalog, f.code);
      return { ...f, label: f.label || (e ? e.shortLabel || e.longLabel : '') };
    });
  }
  return offeredEntries(catalog).map(e => ({ code: e.code, codeType: e.codeType, label: e.shortLabel || e.longLabel }));
};

// A code in a rule list that OpenEMR does not hold active, named by code,
// list and file.
const validateRuleLists = (catalog, lists = RULE_LISTS) => {
  if (!isLoaded(catalog)) return [];
  const problems = [];
  for (const l of lists) {
    for (const code of l.codes || []) {
      const state = lookupCode(catalog, code);
      if (state !== 'active') problems.push({ code: upper(code), state, list: l.list, file: l.file });
    }
  }
  return problems;
};
const describeProblem = (p) =>
  `Code ${p.code} in ${p.list} (${p.file}) is ${p.state === 'inactive' ? 'inactive' : 'missing'} in the OpenEMR code catalog.`;

// What the admin hub and /healthz read. `ok` is false when the catalog has
// never loaded or a rule list names a code OpenEMR does not hold active.
// Stale alone is reported loudly but does not fail the check: the cached
// catalog is still served, and the banner says how old it is.
const status = (record, now = Date.now()) => {
  const loaded = isLoaded(record);
  const problems = validateRuleLists(record);
  const ageMs = loaded ? new Date(now).getTime() - new Date(record.fetchedAt).getTime() : null;
  return {
    ok: loaded && problems.length === 0,
    loaded,
    fetchedAt: loaded ? record.fetchedAt : null,
    stale: isStale(record, now),
    ageHours: ageMs == null ? null : Math.round(ageMs / 36e5 * 10) / 10,
    activeCount: loaded ? record.codes.length : 0,
    inactiveCount: loaded ? (record.inactive || []).length : 0,
    lastAttempt: (record && record.lastAttempt) || null,
    problems: problems.map(p => ({ ...p, message: describeProblem(p) }))
  };
};

// The cache and the refresh. `openemr` is the module (forActor), `db` the store.
const createCodeCatalog = ({ db, openemr, log = console, now = () => Date.now() } = {}) => {
  let inFlight = null;
  const load = async () => (await db.get(KV_KEY)) || null;

  const logProblems = (record) => {
    for (const p of validateRuleLists(record)) log.error(`[code-catalog] ${describeProblem(p)}`);
  };

  // Fetch, replace the cache, validate. A failure keeps the cached catalog
  // and records the attempt with OpenEMR's reason; it is never swallowed.
  const refresh = async (actor, { trigger = 'manual' } = {}) => {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const prev = await load();
      const at = new Date(now()).toISOString();
      const by = actor ? { id: actor.id || null, name: actor.name || null } : null;
      try {
        const rows = await openemr.forActor(actor).listCodeCatalog();
        const built = buildCatalog(rows, now());
        // An empty answer never replaces a real catalog: a practice with codes
        // entered does not lose them all at once, and treating that as true
        // would make every code look missing.
        if (!built.codes.length && isLoaded(prev) && prev.codes.length) {
          const error = 'OpenEMR returned no active CPT4 or HCPCS codes. The cached catalog was kept.';
          await db.set(KV_KEY, { ...prev, lastAttempt: { at, ok: false, error, trigger, by } });
          log.error(`[code-catalog] ${error}`);
          return { ok: false, error, status: status(await load(), now()) };
        }
        const record = { ...built, lastAttempt: { at, ok: true, error: null, trigger, by } };
        await db.set(KV_KEY, record);
        logProblems(record);
        return { ok: true, status: status(record, now()) };
      } catch (e) {
        const error = String((e && e.message) || e).slice(0, 300);
        await db.set(KV_KEY, { ...(prev || {}), lastAttempt: { at, ok: false, error, code: (e && e.code) || null, trigger, by } });
        log.error(`[code-catalog] refresh failed (${trigger}): ${error}`);
        return { ok: false, error, status: status(await load(), now()) };
      }
    })();
    try { return await inFlight; } finally { inFlight = null; }
  };

  // The daily refresh: called from staff requests, never awaited by them.
  const refreshIfStale = async (actor) => {
    if (!actor || inFlight) return false;
    const record = await load();
    if (!isStale(record, now())) return false;
    const last = record && record.lastAttempt;
    if (last && !last.ok && (now() - new Date(last.at).getTime()) < RETRY_AFTER_MS) return false;
    refresh(actor, { trigger: 'daily' }).catch(() => {});
    return true;
  };

  return { load, refresh, refreshIfStale, status: async () => status(await load(), now()), logProblems };
};

module.exports = {
  KV_KEY, CATALOG_TYPES, STALE_AFTER_MS, RETRY_AFTER_MS, RULE_LISTS,
  normalizeEntry, buildCatalog, isLoaded, isStale, lookupCode, isOffered, entryFor, offeredEntries, practiceServices,
  validateRuleLists, describeProblem, status, createCodeCatalog
};
