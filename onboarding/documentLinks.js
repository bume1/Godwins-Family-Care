// ============================================================================
// DOCUMENT LINKS — which Drive file each policy, SOP and guide opens (owner,
// 2026-11-16): "simply upload the new version and replace the links in app ...
// not hardcoded, in the field I can also swap out links".
// ============================================================================
// The file ids in sources.js and the chapter policy lists are defaults. A Super
// Admin points any of them at another Drive file from the Training Library's
// Document Links list. The choice is stored in `document_links` and applied
// through sources.setOverrides, so the training cards, the policy list, the
// signing screen, the pay guide and the live SOP reads all follow it.
// ============================================================================

'use strict';

const S = require('./sources');

const COLLECTION = 'document_links';

// A Drive link in any of its usual shapes, or a bare file id.
function parseDriveId(input) {
  const v = String(input || '').trim();
  if (!v) return null;
  const m = v.match(/\/(?:file|document|spreadsheets|presentation)\/d\/([A-Za-z0-9_-]{20,})/) ||
    v.match(/[?&]id=([A-Za-z0-9_-]{20,})/) || v.match(/^([A-Za-z0-9_-]{20,})$/);
  return m ? m[1] : null;
}

const viewUrl = (id) => (id ? `https://drive.google.com/file/d/${id}/view` : null);

// One row per document a person can open: every source document, then every
// policy that carries its own file (a policy whose file is a source document is
// covered by that source's row).
function catalog(acks, stored) {
  const meta = (stored && stored.overrides) || {};
  const rows = Object.values(S.SOURCES).map(src => ({
    key: 'source:' + src.key, title: src.title, docNumber: src.docNumber || null, folder: src.folder || null,
    defaultUrl: viewUrl(src.defaultDriveFileId), url: viewUrl(src.driveFileId)
  }));
  const seen = new Set();
  (acks || []).forEach(a => {
    if (!a || !a.linkKey || !String(a.linkKey).startsWith('policy:') || seen.has(a.id)) return;
    if (!(a.defaultDriveFileIds || []).length) return;
    seen.add(a.id);
    rows.push({ key: a.linkKey, title: a.title, docNumber: null, folder: '01 Company / Policies & Procedures / Current',
      defaultUrl: viewUrl(a.defaultDriveFileIds[0]), url: viewUrl((a.driveFileIds || [])[0]),
      defaultFiles: a.defaultDriveFileIds.length });
  });
  return rows.map(r => Object.assign(r, {
    changed: !!S.overrideFor(r.key),
    changedAt: (meta[r.key] && meta[r.key].at) || null,
    changedByName: (meta[r.key] && meta[r.key].byName) || null
  }));
}

// Apply what is stored. Called at boot and after every change.
function apply(stored) { S.setOverrides((stored && stored.overrides) || {}); }

module.exports = { COLLECTION, parseDriveId, catalog, apply, viewUrl };
