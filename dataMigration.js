// ============================================================================
// dataMigration.js — KV → Postgres migration core (Session 5.1)
//
// The store is enumerated DYNAMICALLY: every key the source holds is walked,
// and every key must match an explicit handler in COLLECTION_REGISTRY. A key
// nobody has claimed FAILS the migration before a single value is copied.
// Sessions 6, 7 and 9 each added collections after the Session 5 brief was
// written; a hardcoded list would have skipped them and left PHI behind in the
// KV store, discovered only after cutover. Refusing is the safe failure.
//
// Idempotent: a value already present and equal at the target is a no-op, so a
// re-run reports zero writes. A value present and DIFFERENT at the target is a
// conflict — reported and NOT overwritten unless the caller passes
// overwrite:true — because the second run of a migration is exactly when
// someone has started writing to the new store and the old copy is stale.
//
// Audit buckets (`audit_log:YYYY-MM-DD`, Session 5.4) are handled specially:
// each row is appended to the target's audit table rather than copied as a
// blob, and a bucket already fully present is skipped by row count.
// ============================================================================

'use strict';

const { _internal: { AUDIT_PREFIX } } = require('./dataStore');

// phi: true means the collection can carry protected health information and
// MUST land inside the boundary. Everything is migrated regardless; the flag
// drives the report and the go/no-go checklist.
const COLLECTION_REGISTRY = Object.freeze([
  // ---- identity, clients, enrollment (users blob carries every client record) ----
  { key: 'users', phi: true, owner: 'core', note: 'every account incl. client profiles, intake, consents, care plan pointer, MFA + EMR link fields' },
  { key: 'password_reset_requests', phi: false, owner: 'core' },
  { key: 'password_reset_links', phi: false, owner: 'core' },
  { pattern: /^auth_session:/, phi: false, owner: '5.3', note: 'server-side sessions (per key)' },
  { pattern: /^mfa_pending:/, phi: false, owner: '5.3', note: 'short-lived MFA challenge state' },
  { pattern: /^emr_user_token:/, phi: false, owner: '5.2', note: 'per-user OpenEMR refresh tokens, encrypted at rest' },
  { pattern: /^emr_oauth_state:/, phi: false, owner: '5.2', note: 'authorization_code state + PKCE verifier, short-lived' },
  // ---- activity + audit ----
  { key: 'activity_log', phi: true, owner: 'core', note: 'capped activity trail (500) — the durable audit_log supersedes it' },
  { pattern: new RegExp(`^${AUDIT_PREFIX}`), phi: true, owner: '5.4', special: 'audit', note: 'append-only audit rows, daily buckets on kv/memory' },
  // ---- client portal (Session 3.x) ----
  { key: 'care_plan_versions', phi: true, owner: '4.1' },
  { key: 'care_plan_cosign_events', phi: true, owner: '3.x' },
  { key: 'consent_events', phi: true, owner: '3.4' },
  { key: 'consent_provider_authorizations', phi: true, owner: '3.4' },
  { key: 'consent_records_categories', phi: true, owner: '3.4' },
  { key: 'visit_logs', phi: true, owner: '3.5/6', note: 'portal display rows' },
  { key: 'gfc_messages', phi: true, owner: '3.5', note: 'interim messages; migrated into message_threads/messages by Session 9, source retained' },
  { key: 'client_document_uploads', phi: true, owner: '4.6+' },
  { key: 'client_document_requests', phi: true, owner: '4.6+' },
  // ---- clinical (Session 4.x) ----
  { key: 'encounter_billing', phi: true, owner: '4.4' },
  { key: 'prescriptions', phi: true, owner: '4.4' },
  { key: 'clinical_orders', phi: true, owner: '4.4' },
  { key: 'encounter_attestations', phi: true, owner: '4.4' },
  { key: 'encounter_addenda', phi: true, owner: '4.4' },
  { key: 'appointment_encounters', phi: true, owner: '4.2', note: 'pointers only' },
  { key: 'clinical_code_usage', phi: false, owner: '4.4', note: 'per-clinician code favorites' },
  { key: 'clinical_settings', phi: false, owner: '4.4' },
  { key: 'gfc_payer_credentialing', phi: false, owner: '4.4' },
  // ---- caregiver app (Session 6) ----
  { key: 'caregiver_visit_logs', phi: true, owner: '6' },
  { key: 'caregiver_visit_log_reviews', phi: true, owner: '6' },
  { key: 'escalation_events', phi: true, owner: '6/9' },
  { key: 'escalation_status_events', phi: true, owner: '6/9' },
  { key: 'incident_reports', phi: true, owner: '6' },
  { key: 'caregiver_broadcasts', phi: false, owner: '6' },
  // ---- scheduling (Session 7) ----
  { key: 'shifts', phi: true, owner: '7' },
  { key: 'shift_requests', phi: true, owner: '7' },
  { key: 'caregiver_availability', phi: false, owner: '7' },
  { key: 'time_logs', phi: true, owner: '7', note: 'GPS clock-in at a client address' },
  { key: 'time_log_edits', phi: true, owner: '7' },
  // ---- messaging (Session 9) ----
  { key: 'message_threads', phi: true, owner: '9' },
  { key: 'messages', phi: true, owner: '9' },
  // ---- notifications + email ----
  { key: 'pending_notifications', phi: true, owner: 'core', note: 'queued email bodies can name a client' },
  { key: 'notification_log', phi: true, owner: 'core' },
  { key: 'notification_settings', phi: false, owner: 'core' },
  { key: 'reminder_settings', phi: false, owner: 'core' },
  { key: 'email_templates', phi: false, owner: 'core' },
  { key: 'announcements', phi: false, owner: 'core' },
  // ---- lab-era, retained (Session 2 strip list keeps the code dormant) ----
  { key: 'projects', phi: false, owner: 'lab', note: 'deactivated tracker' },
  { pattern: /^tasks_/, phi: false, owner: 'lab', note: 'per-project task lists (deactivated tracker)' },
  { key: 'templates', phi: false, owner: 'lab' },
  { key: 'service_reports', phi: true, owner: 'lab', note: 'service-portal reports; may name a client' },
  { key: 'client_documents', phi: true, owner: 'lab/core', note: 'document pointers' },
  { key: 'portal_tickets', phi: true, owner: 'lab' },
  { key: 'portal_submitted_tickets', phi: true, owner: 'lab' },
  { key: 'portal_settings', phi: false, owner: 'lab' },
  { key: 'client_portal_domain', phi: false, owner: 'lab' },
  { key: 'feedback_requests', phi: false, owner: 'lab' },
  { key: 'ticket_polling_config', phi: false, owner: 'lab/hubspot', note: 'dormant HubSpot connector — do not delete' },
  { key: 'hubspot_ticket_config', phi: false, owner: 'lab/hubspot' },
  { key: 'hubspot_stage_mapping', phi: false, owner: 'lab/hubspot' },
  { key: 'changelog', phi: false, owner: 'lab' },
  { key: 'changelog_last_commit_hash', phi: false, owner: 'lab' },
  { pattern: /^migration_/, phi: false, owner: 'core', note: 'one-shot migration markers' }
]);

const findHandler = (key, registry = COLLECTION_REGISTRY) =>
  registry.find(h => (h.key !== undefined ? h.key === key : h.pattern.test(key))) || null;

// Classify every key in the source. Returns { handled, unhandled } — the
// caller refuses to proceed when unhandled is non-empty.
const classifyKeys = (keys, { registry = COLLECTION_REGISTRY, ignore = [] } = {}) => {
  const handled = []; const unhandled = []; const ignored = [];
  for (const key of keys) {
    if (ignore.includes(key)) { ignored.push(key); continue; }
    const h = findHandler(key, registry);
    if (h) handled.push({ key, handler: h }); else unhandled.push(key);
  }
  return { handled, unhandled, ignored };
};

const deepEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const rowCount = (v) => (Array.isArray(v) ? v.length : (v && typeof v === 'object' ? Object.keys(v).length : 1));

class UnhandledCollectionError extends Error {
  constructor(keys) {
    super(`MIGRATION REFUSED: ${keys.length} collection(s) in the source have no handler in COLLECTION_REGISTRY: ${keys.join(', ')}. ` +
      'Add an explicit handler (dataMigration.js) — or pass them in `ignore` to record a deliberate decision to leave them behind. Nothing was copied.');
    this.name = 'UnhandledCollectionError';
    this.keys = keys;
  }
}

// migrateStore(source, target, opts) → report
//   source/target: stores from dataStore.createStore()
//   opts.dryRun    classify + diff, write nothing
//   opts.overwrite replace a differing target value (default: report conflict, leave target)
//   opts.ignore    keys deliberately left behind (recorded in the report)
const migrateStore = async (source, target, opts = {}) => {
  const { dryRun = false, overwrite = false, ignore = [], registry = COLLECTION_REGISTRY, log = () => {} } = opts;
  const keys = await source.list('');
  const { handled, unhandled, ignored } = classifyKeys(keys, { registry, ignore });
  if (unhandled.length) throw new UnhandledCollectionError(unhandled);

  const report = {
    startedAt: new Date().toISOString(), dryRun, sourceAdapter: source.adapter, targetAdapter: target.adapter,
    totalKeys: keys.length, ignored, collections: [], counts: { copied: 0, unchanged: 0, conflicts: 0, auditRowsAppended: 0, auditRowsSkipped: 0 },
    verify: { checked: 0, mismatches: [] }
  };

  for (const { key, handler } of handled) {
    const value = await source.get(key);
    const entry = { key, phi: !!handler.phi, owner: handler.owner, rows: rowCount(value), action: null };
    if (handler.special === 'audit') {
      // Rows go into the audit table; already-present rows are skipped by
      // (timestamp,id) so a re-run appends nothing.
      const rows = Array.isArray(value) ? value : [];
      const day = key.slice(AUDIT_PREFIX.length);
      const existing = await target.readAudit({ since: `${day}T00:00:00.000Z`, until: `${day}T23:59:59.999Z`, limit: 5000 });
      const have = new Set(existing.map(r => `${r.timestamp}|${r.id}`));
      let appended = 0; let skipped = 0;
      for (const row of rows) {
        if (have.has(`${row.timestamp}|${row.id}`)) { skipped++; continue; }
        if (!dryRun) await target.appendAudit(row);
        appended++;
      }
      report.counts.auditRowsAppended += appended; report.counts.auditRowsSkipped += skipped;
      entry.action = appended ? 'appended' : 'unchanged'; entry.appended = appended; entry.skipped = skipped;
      report.collections.push(entry); log(`${entry.action.padEnd(9)} ${key} (${appended} appended, ${skipped} present)`);
      continue;
    }
    const current = await target.get(key);
    if (current !== null && deepEqual(current, value)) {
      entry.action = 'unchanged'; report.counts.unchanged++;
    } else if (current !== null && !overwrite) {
      entry.action = 'conflict'; report.counts.conflicts++;
      entry.targetRows = rowCount(current);
    } else {
      entry.action = current === null ? 'copied' : 'overwritten';
      if (!dryRun) {
        await target.set(key, value);
        // Verify pass: read back and compare, never trust the write.
        const back = await target.get(key);
        report.verify.checked++;
        if (!deepEqual(back, value)) report.verify.mismatches.push(key);
      }
      report.counts.copied++;
    }
    report.collections.push(entry);
    log(`${entry.action.padEnd(9)} ${key} (${entry.rows} rows${entry.phi ? ', PHI' : ''})`);
  }
  report.finishedAt = new Date().toISOString();
  report.ok = report.verify.mismatches.length === 0 && report.counts.conflicts === 0;
  return report;
};

// Compare source and target key by key without writing. Used by the go/no-go
// step of the runbook: every source key must read back identical from the
// target (audit buckets compare by row count).
const verifyStores = async (source, target, { ignore = [] } = {}) => {
  const keys = (await source.list('')).filter(k => !ignore.includes(k));
  const result = { checked: 0, matched: 0, mismatches: [], missing: [] };
  for (const key of keys) {
    result.checked++;
    const a = await source.get(key);
    if (key.startsWith(AUDIT_PREFIX)) {
      const day = key.slice(AUDIT_PREFIX.length);
      const rows = await target.readAudit({ since: `${day}T00:00:00.000Z`, until: `${day}T23:59:59.999Z`, limit: 5000 });
      const want = new Set((Array.isArray(a) ? a : []).map(r => `${r.timestamp}|${r.id}`));
      const have = new Set(rows.map(r => `${r.timestamp}|${r.id}`));
      const absent = [...want].filter(x => !have.has(x));
      if (absent.length) result.mismatches.push({ key, reason: `${absent.length} audit rows absent at target` }); else result.matched++;
      continue;
    }
    const b = await target.get(key);
    if (b === null && a !== null) { result.missing.push(key); continue; }
    if (deepEqual(a, b)) result.matched++; else result.mismatches.push({ key, reason: 'value differs' });
  }
  result.ok = result.mismatches.length === 0 && result.missing.length === 0;
  return result;
};

module.exports = { COLLECTION_REGISTRY, findHandler, classifyKeys, migrateStore, verifyStores, UnhandledCollectionError };
