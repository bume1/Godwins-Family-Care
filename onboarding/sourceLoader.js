// ============================================================================
// LOADING THE SOURCE DOCUMENTS FROM DRIVE, at runtime
// ============================================================================
// Reads a source document from its canonical Drive copy and returns its lines
// and version. Never throws to a caller that renders: a document that cannot
// be read is reported with the reason, never rendered as empty, because an
// empty list of check questions would read as a module with nothing to ask.
//
// CACHE. In memory only, keyed by the file's Drive checksum. A document
// revised in place gets a new checksum, so a revision is never served stale,
// and nothing about a document's text outlives the process (Admin P&P §17.2:
// no stored copy).
//
// MANUAL VERSIONS. Each manual version the app reads has its section
// fingerprints stored (hashes, not text). When a new version appears and the
// previous one is on record, the changed sections are COMPUTED, and appended
// to the change log the version flag reads. The seeded v2.1 to v2.2 entry
// (Training Library §2.2) stays first.
// ============================================================================

'use strict';

const { SOURCES } = require('./sources');
const D = require('./documentText');
const P = require('./sourceParsers');
const VF = require('./versionFlags');

const VERSIONS_COLLECTION = 'onboarding_manual_versions';

function createSourceLoader({ drive, db, now = () => new Date().toISOString() }) {
  const cache = new Map(); // fileId -> { key, lines, version }

  async function load(key) {
    const src = SOURCES[key];
    if (!src) return { ok: false, key, code: 'SOURCE_UNKNOWN', reason: `Unknown source ${key}` };
    let fp;
    try {
      fp = await drive.getFileFingerprint(src.driveFileId);
    } catch (err) {
      return { ok: false, key, code: 'SOURCE_UNREACHABLE', reason: describe(err) };
    }
    const cacheKey = fp.md5Checksum || `${fp.modifiedTime}:${fp.version}`;
    const hit = cache.get(src.driveFileId);
    if (hit && hit.cacheKey === cacheKey) return Object.assign({ ok: true, cached: true }, hit.value);
    let buf;
    try {
      buf = await drive.downloadFileBuffer(src.driveFileId);
    } catch (err) {
      return { ok: false, key, code: 'SOURCE_UNREADABLE', reason: describe(err) };
    }
    let lines;
    try {
      lines = D.toLines(buf, fp.mimeType || src.mimeType);
    } catch (err) {
      return { ok: false, key, code: err.code || 'SOURCE_UNPARSEABLE', reason: err.message };
    }
    const version = P.documentVersion(lines, { banner: key === 'PLAYBOOK' });
    const value = {
      key, fileId: src.driveFileId, version, lines,
      readAt: now(), modifiedTime: fp.modifiedTime,
      // The catalog was transcribed from one version. A different version in
      // Drive is surfaced to the office, never silently trusted.
      transcribedFromVersion: src.transcribedFromVersion,
      versionDiffers: !!(version && version !== src.transcribedFromVersion)
    };
    cache.set(src.driveFileId, { cacheKey, value });
    return Object.assign({ ok: true, cached: false }, value);
  }

  function describe(err) {
    return drive && drive.describeDriveError ? drive.describeDriveError(err).reason : (err && err.message) || 'Unknown error';
  }

  /**
   * The current manual version and the change log the version flag reads.
   * Records this version's fingerprints the first time it is seen.
   */
  async function manualState() {
    const m = await load('CLINICAL_MANUAL');
    if (!m.ok) return { ok: false, code: m.code, reason: m.reason, changeLog: VF.SEEDED_CHANGES.slice() };
    if (!m.version) {
      return { ok: false, code: 'MANUAL_VERSION_UNREADABLE', reason: 'The manual\'s control table did not give a version.', changeLog: VF.SEEDED_CHANGES.slice() };
    }
    const fingerprints = P.manualFingerprint(m.lines);
    const rows = (await db.get(VERSIONS_COLLECTION)) || [];
    if (!rows.some(r => r.version === m.version)) {
      const prior = rows.length ? rows[rows.length - 1] : null;
      const row = { version: m.version, fingerprints, seenAt: now() };
      if (prior) {
        row.changeFrom = {
          document: 'CLINICAL_MANUAL', from: prior.version, to: m.version,
          changedSections: VF.diffFingerprints(prior.fingerprints, fingerprints),
          basis: 'COMPUTED_FROM_FINGERPRINTS'
        };
      }
      rows.push(row);
      await db.set(VERSIONS_COLLECTION, rows);
    }
    const computed = rows.filter(r => r.changeFrom).map(r => r.changeFrom);
    // The seeded entry covers 2.1 -> 2.2; a computed entry for the same hop
    // (impossible today, since no 2.1 copy exists) would not replace it.
    const changeLog = VF.SEEDED_CHANGES.concat(
      computed.filter(c => !VF.SEEDED_CHANGES.some(s => s.from === c.from && s.to === c.to)));
    return { ok: true, currentVersion: m.version, changeLog, versionDiffers: m.versionDiffers };
  }

  /** Check questions for every SOP and every Library module, read live. */
  async function checks() {
    const [sops, lib] = await Promise.all([load('CLINICAL_SOPS_SET1'), load('TRAINING_LIBRARY')]);
    return {
      ok: sops.ok && lib.ok,
      sops: sops.ok ? P.sopChecks(sops.lines) : null,
      library: lib.ok ? P.libraryChecks(lib.lines) : null,
      errors: [sops, lib].filter(x => !x.ok).map(x => ({ key: x.key, code: x.code, reason: x.reason })),
      versions: { CLINICAL_SOPS_SET1: sops.version || null, TRAINING_LIBRARY: lib.version || null }
    };
  }

  return { load, manualState, checks, _cache: cache };
}

module.exports = { createSourceLoader, VERSIONS_COLLECTION };
