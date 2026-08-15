// ============================================================
// GODWINS FAMILY CARE — Transfer-of-Care Provider ROI repository
// Session 3.4
//
// Data model for the Transfer-of-Care ROI (multi-provider record release).
// One signing event → one parent `consent_events` row, one
// `consent_provider_authorizations` child per authorized provider, and one
// `consent_records_categories` row per checked record category.
//
// Stored in the Replit KV store as three flat arrays (one key per collection),
// each row carrying a stable `id`/foreign key so the shape maps cleanly onto
// AWS RDS tables in a later Track 0 migration. No per-record keys — collections
// follow the existing `db.get('users')` array idiom in server.js.
//
// 42 CFR PART 2 (non-negotiable): the four specially-protected categories
// (mental health, substance use, HIV/AIDS, genetic testing) are NEVER
// releasable unless `includes_protected_info === true` on the specific
// consent_event. That rule is enforced here at the data-access layer via the
// PURE function `getRequestableRecordCategories`, which both server.js and the
// unit tests import. If this function is ever changed to leak protected
// categories, the test suite fails the build (see test/roi_protected_categories.test.js).
//
// TEST DATA ONLY until HIPAA-live.
// ============================================================

const crypto = require('crypto');

// KV collection keys (one array each — future RDS tables).
const KEY_EVENTS       = 'consent_events';
const KEY_PROVIDER_AUTH = 'consent_provider_authorizations';
const KEY_CATEGORIES   = 'consent_records_categories';

// The nine standard, non-protected record categories (Section 4 checkboxes).
const RECORD_CATEGORIES = Object.freeze([
  'hp', 'lab', 'diag', 'imaging', 'meds', 'discharge', 'allergies', 'immune', 'other'
]);

// The four 42 CFR Part 2 / specially-protected categories. These are gated
// behind the single event-level `includes_protected_info` opt-in and are NOT
// among the standard checkboxes.
const PROTECTED_CATEGORIES = Object.freeze([
  'mental_health', 'substance_use', 'hiv_aids', 'genetic_testing'
]);

// Consent event source provenance.
const SOURCE = Object.freeze({
  ONLINE_FORM:  'portal_online_form',
  UPLOAD:       'portal_upload',
  LEGACY_IMPORT:'legacy_import'
});

// ------------------------------------------------------------------
// PURE 42 CFR Part 2 gate — the single enforcement point.
//
// "What records can we ask this provider for?" Returns the releasable set of
// categories for a consent event. Protected categories are excluded unless the
// event's opt-in is EXACTLY boolean true. This is defense-in-depth: even if a
// protected category is somehow present in the stored category rows, it is
// stripped from the result when the opt-in is not true.
//
// @param {Object} consentEvent  - must carry `includes_protected_info`
// @param {Array}  categoryRows  - rows from consent_records_categories ({category})
// @returns {string[]} releasable category keys
// ------------------------------------------------------------------
function getRequestableRecordCategories(consentEvent, categoryRows) {
  const includeProtected = !!consentEvent && consentEvent.includes_protected_info === true;

  const requested = (Array.isArray(categoryRows) ? categoryRows : [])
    .map(r => (r && r.category != null ? String(r.category) : ''))
    .filter(Boolean);

  // Standard categories that were actually checked, protected ones stripped out.
  const releasable = requested.filter(c => !PROTECTED_CATEGORIES.includes(c));

  // Only when the specific event opted in do the protected categories become
  // releasable — and never otherwise, regardless of the input rows.
  if (includeProtected) {
    for (const pc of PROTECTED_CATEGORIES) {
      if (!releasable.includes(pc)) releasable.push(pc);
    }
  }
  return releasable;
}

// Convenience predicate used by callers and tests.
function isProtectedCategory(category) {
  return PROTECTED_CATEGORIES.includes(String(category));
}

// ------------------------------------------------------------------
// 45 CFR 164.508 required-element validation.
//
// The right-to-revoke and redisclosure statements are static, verbatim text
// rendered into every generated PDF (see pdf-generator.js AUTH_RIGHTS_TEXT /
// AUTH_REDISCLOSURE_TEXT), so those two elements are structurally always
// present. The elements that can actually be missing from a submission are
// validated here. Returns { ok, errors } where errors is a field→message map.
// ------------------------------------------------------------------
function validateAuthorizationElements(payload) {
  const errors = {};
  const p = payload || {};

  // Description of information: at least one checked category (standard OR the
  // protected opt-in with its own categories).
  const categories = Array.isArray(p.categories) ? p.categories.filter(Boolean) : [];
  if (categories.length === 0) {
    errors.categories = 'Select at least one type of record to request.';
  }

  // Purpose of disclosure.
  const purposeTreatment = p.purpose_treatment !== false;
  const purposeOther = (p.purpose_other_text || '').trim();
  if (!purposeTreatment && !purposeOther) {
    errors.purpose = 'A purpose of disclosure is required.';
  }

  // Expiration: a date, an event, or the implicit one-year default is always
  // applied downstream, so this element is present as long as we can compute a
  // date. We only flag a malformed explicit date.
  if (p.expiration_date && !isParseableDate(p.expiration_date)) {
    errors.expiration_date = 'Expiration date is not a valid date.';
  }

  // Signature image (canvas capture) must be non-empty.
  if (!isNonEmptySignature(p.signature_image_b64)) {
    errors.signature_image_b64 = 'A drawn signature is required.';
  }

  // Printed name.
  if (!(p.printed_name || '').trim()) {
    errors.printed_name = 'Printed name is required.';
  }

  // Date signed.
  if (!p.signed_at || !isParseableDate(p.signed_at)) {
    errors.signed_at = 'A valid signature date is required.';
  }

  return { ok: Object.keys(errors).length === 0, errors };
}

function isParseableDate(v) {
  if (!v) return false;
  const t = Date.parse(v);
  return !Number.isNaN(t);
}

// A canvas signature arrives as a data URI ("data:image/png;base64,....").
// Treat anything shorter than a token threshold, or a blank data URI, as empty.
function isNonEmptySignature(sig) {
  if (typeof sig !== 'string') return false;
  const s = sig.trim();
  if (!s) return false;
  if (!s.startsWith('data:image')) return false;
  const comma = s.indexOf(',');
  const payload = comma >= 0 ? s.slice(comma + 1) : '';
  return payload.length > 100; // a real drawn stroke encodes to well over this
}

// Hash a raw IP so we retain proof-of-signing provenance without storing the
// raw address (matches the `signer_ip_hash` field name in the schema).
function hashIp(rawIp, salt) {
  if (!rawIp) return null;
  const h = crypto.createHash('sha256');
  h.update(String(salt || '') + '|' + String(rawIp));
  return h.digest('hex');
}

// Deterministic content hash used by the idempotent legacy importer to dedupe
// a (client_id + signed_at + file) tuple.
function contentHash(parts) {
  const h = crypto.createHash('sha256');
  h.update((Array.isArray(parts) ? parts : [parts]).map(x => String(x == null ? '' : x)).join('|'));
  return h.digest('hex');
}

function uuid() {
  return crypto.randomUUID();
}

// ------------------------------------------------------------------
// Repository factory — binds the CRUD surface to a KV `db` instance so the
// pure functions above can be unit-tested without any storage. server.js calls
// `createRepository(db)` once at boot.
// ------------------------------------------------------------------
function createRepository(db) {
  const read = async (key) => (await db.get(key)) || [];
  const write = (key, arr) => db.set(key, arr);

  // Build a normalized consent_event row from raw input. Applies the defaults
  // the schema mandates: purpose_treatment default true, includes_protected_info
  // default FALSE, revoked_at null, and a computed one-year expiration when none
  // is supplied.
  function buildConsentEvent(input) {
    // signed_at must be a parseable date — the one-year expiration default is
    // computed from it. Guard against a caller passing an unparseable string
    // (e.g. a synthetic dedupe token): fall back to now rather than throwing a
    // RangeError when materializing the expiration.
    const rawSigned = input.signed_at || new Date().toISOString();
    const parsed = new Date(rawSigned);
    const now = isNaN(parsed.getTime()) ? new Date().toISOString() : rawSigned;
    const oneYear = new Date(new Date(now).getTime());
    oneYear.setFullYear(oneYear.getFullYear() + 1);
    return {
      id: input.id || uuid(),
      client_id: input.client_id || null,
      event_type: 'roi_transfer',
      signed_at: now,
      signature_image_b64: input.signature_image_b64 || '',
      printed_name: (input.printed_name || '').trim(),
      relationship_authority: (input.relationship_authority || '').trim(),
      signer_ip_hash: input.signer_ip_hash || null,
      // Explicit expiration wins; otherwise the implicit one-year default is
      // materialized so 45 CFR 164.508's expiration element is always present.
      expiration_date: input.expiration_date || oneYear.toISOString().slice(0, 10),
      expiration_event: input.expiration_event || null,
      purpose_treatment: input.purpose_treatment !== false,
      purpose_other_text: (input.purpose_other_text || '').trim() || null,
      // 42 CFR Part 2 opt-in — defaults FALSE, only true when explicitly true.
      includes_protected_info: input.includes_protected_info === true,
      revoked_at: input.revoked_at || null, // no revocation UI this session (schema-ready)
      source: input.source || SOURCE.ONLINE_FORM,
      created_at: input.created_at || now
    };
  }

  async function insertConsentEvent(input) {
    const row = buildConsentEvent(input);
    const events = await read(KEY_EVENTS);
    events.push(row);
    await write(KEY_EVENTS, events);
    return row;
  }

  async function getConsentEvent(id) {
    const events = await read(KEY_EVENTS);
    return events.find(e => e.id === id) || null;
  }

  async function listConsentEventsByClient(clientId) {
    const events = await read(KEY_EVENTS);
    return events.filter(e => e.client_id === clientId);
  }

  async function insertProviderAuthorizations(consentEventId, providers) {
    const rows = await read(KEY_PROVIDER_AUTH);
    const created = (providers || []).map(p => ({
      id: uuid(),
      consent_event_id: consentEventId,
      provider_name: (p.provider_name || p.name || '').trim(),
      dept: (p.dept || '').trim(),
      address: (p.address || '').trim(),
      phone: (p.phone || '').trim(),
      fax: (p.fax || '').trim(),
      generated_pdf_drive_url: p.generated_pdf_drive_url || null,
      generated_pdf_s3_key: null, // populated by Track 0 migration later
      file_name: p.file_name || null
    }));
    rows.push(...created);
    await write(KEY_PROVIDER_AUTH, rows);
    return created;
  }

  async function updateProviderAuthorizationPdf(authId, { driveUrl, fileName }) {
    const rows = await read(KEY_PROVIDER_AUTH);
    const idx = rows.findIndex(r => r.id === authId);
    if (idx === -1) return null;
    if (driveUrl !== undefined) rows[idx].generated_pdf_drive_url = driveUrl;
    if (fileName !== undefined) rows[idx].file_name = fileName;
    await write(KEY_PROVIDER_AUTH, rows);
    return rows[idx];
  }

  async function listProviderAuthorizations(consentEventId) {
    const rows = await read(KEY_PROVIDER_AUTH);
    return rows.filter(r => r.consent_event_id === consentEventId);
  }

  async function insertRecordCategories(consentEventId, categories, otherText) {
    const rows = await read(KEY_CATEGORIES);
    const created = (categories || []).map(cat => ({
      consent_event_id: consentEventId,
      category: String(cat),
      other_text: (String(cat) === 'other' && otherText) ? String(otherText).trim() : null
    }));
    rows.push(...created);
    await write(KEY_CATEGORIES, rows);
    return created;
  }

  async function listRecordCategories(consentEventId) {
    const rows = await read(KEY_CATEGORIES);
    return rows.filter(r => r.consent_event_id === consentEventId);
  }

  // The data-access enforcement point callers use: load the event + its stored
  // category rows and return only what 42 CFR Part 2 allows us to request.
  async function getRequestableCategoriesForEvent(consentEventId) {
    const event = await getConsentEvent(consentEventId);
    if (!event) return [];
    const rows = await listRecordCategories(consentEventId);
    return getRequestableRecordCategories(event, rows);
  }

  // Idempotency helper for the legacy importer: has an equivalent event
  // (same client + signed_at + file hash) already been imported?
  async function findEventByDedupeHash(dedupeHash) {
    const events = await read(KEY_EVENTS);
    return events.find(e => e.dedupe_hash === dedupeHash) || null;
  }

  return {
    KEY_EVENTS, KEY_PROVIDER_AUTH, KEY_CATEGORIES,
    buildConsentEvent,
    insertConsentEvent,
    getConsentEvent,
    listConsentEventsByClient,
    insertProviderAuthorizations,
    updateProviderAuthorizationPdf,
    listProviderAuthorizations,
    insertRecordCategories,
    listRecordCategories,
    getRequestableCategoriesForEvent,
    findEventByDedupeHash
  };
}

module.exports = {
  // Pure, storage-free surface (imported by tests):
  RECORD_CATEGORIES,
  PROTECTED_CATEGORIES,
  SOURCE,
  getRequestableRecordCategories,
  isProtectedCategory,
  validateAuthorizationElements,
  hashIp,
  contentHash,
  // Storage-bound surface:
  createRepository
};
