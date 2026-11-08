// ============================================================================
// MY GFC — the staff portal's own routes
// ============================================================================
// Owner, 2026-11-08: staff get their own portal, the counterpart of the
// patient portal, housing their onboarding, documents, policies, training,
// shared Drive folders, hours and account. Onboarding itself is served by
// routes/onboarding.js (`/api/onboarding/me`); this file adds what the portal
// needs beyond it.
//
// SHARED FOLDERS. An admin assigns Google Drive folders to account types (all
// clinicians, the admin team ...) or to named people (Ms. Godwins). A person
// browses only folders assigned to them and what is inside them, and a file
// OPENS IN DRIVE under their own Google sign-in, so Google's own sharing is
// still the gate on every file. The app never streams a shared file's bytes:
// it would make the service account's access everyone's access.
// ============================================================================

'use strict';

const express = require('express');
const accountTypes = require('../accountTypes');
const { contentDisposition } = require('../contentDisposition');
const { ACKNOWLEDGMENTS } = require('../onboarding/chapterC');
const { SOURCES } = require('../onboarding/sources');

const FOLDERS = 'staff_portal_folders';
const STAFF_TYPES = Object.freeze(['admin', 'manager', 'coordinator', 'provider', 'rn', 'lcsw', 'lmsw', 'caregiver']);
const TYPE_LABELS = Object.freeze({
  admin: 'Administrator', manager: 'Manager', coordinator: 'Care Coordinator', provider: 'Clinician',
  rn: 'Registered Nurse', lcsw: 'Clinical Social Worker', lmsw: 'Social Worker', caregiver: 'Caregiver'
});
const FOLDER_MIME = 'application/vnd.google-apps.folder';
// A Drive folder link or a bare id. Ids are long base64url strings.
const folderIdFrom = (v) => {
  const s = String(v || '').trim();
  const m = s.match(/\/folders\/([A-Za-z0-9_-]{10,})/) || s.match(/[?&]id=([A-Za-z0-9_-]{10,})/) || s.match(/^([A-Za-z0-9_-]{10,})$/);
  return m ? m[1] : null;
};

function audienceOf(u) {
  const type = accountTypes.accountTypeOf(u);
  return STAFF_TYPES.includes(type) ? type : null;
}

const CLINICIAN_TYPES = Object.freeze(['provider', 'rn', 'lcsw', 'lmsw']);
const OFFICE_TYPES = Object.freeze(['admin', 'manager', 'coordinator']);
const viewUrl = (id) => `https://drive.google.com/file/d/${id}/view`;

/**
 * The policies a person works under, each linking its CANONICAL copy in
 * Policies / Current (Admin P&P §17.2). Clinicians read the Clinical P&P,
 * the office reads the Administrative P&P (owner, 2026-11-08). Links only:
 * the file opens in Drive under the person's own Google sign-in.
 */
function policiesFor(type) {
  const field = CLINICIAN_TYPES.includes(type) || type === 'caregiver';
  const out = [];
  for (const a of ACKNOWLEDGMENTS) {
    if (!a.driveFileIds.length) continue;
    if (a.id === 'CLINICAL_MANUAL' && !CLINICIAN_TYPES.includes(type)) continue;
    if (a.id === 'FIELD_ADDENDUM' && !field) continue;
    out.push({ id: a.id, title: a.title, version: a.version, links: a.driveFileIds.map(viewUrl) });
  }
  if (OFFICE_TYPES.includes(type)) {
    const m = SOURCES.ADMIN_MANUAL;
    out.push({ id: 'ADMIN_MANUAL', title: m.title, version: m.transcribedFromVersion, links: [viewUrl(m.driveFileId)] });
  }
  return out;
}

// May this person see this assigned folder? By account type or by name.
function canSee(folder, u) {
  const type = audienceOf(u);
  if (!type) return false;
  if ((folder.userIds || []).map(String).includes(String(u.id))) return true;
  return (folder.types || []).includes(type);
}

module.exports = function createStaffPortalRoutes(deps) {
  const { db, logActivity, authenticateToken, drive, uuidv4, getUsers } = deps;
  const router = express.Router();
  const nowIso = () => new Date().toISOString();

  const requireStaff = (req, res, next) => (audienceOf(req.user) ? next()
    : res.status(403).json({ error: 'My GFC is the staff portal.', code: 'STAFF_PORTAL_STAFF_ONLY' }));
  const requireAdmin = (req, res, next) => (req.user && req.user.role === 'admin' ? next()
    : res.status(403).json({ error: 'Only an administrator manages shared folders.', code: 'STAFF_PORTAL_ADMIN_ONLY' }));
  const folders = async () => (await db.get(FOLDERS)) || [];

  // ---- who I am ------------------------------------------------------------
  router.get('/api/my/profile', authenticateToken, requireStaff, async (req, res) => {
    const type = audienceOf(req.user);
    return res.json({
      id: req.user.id, name: req.user.name || req.user.email, email: req.user.email || null,
      type, typeLabel: TYPE_LABELS[type],
      isAdmin: req.user.role === 'admin',
      isCaregiver: type === 'caregiver',
      isClinician: ['provider', 'rn', 'lcsw', 'lmsw'].includes(type) || !!req.user.hasClinicalAccess
    });
  });

  router.get('/api/my/policies', authenticateToken, requireStaff, async (req, res) => {
    return res.json({ policies: policiesFor(audienceOf(req.user)) });
  });

  // ---- my documents ----------------------------------------------------------
  // Everything filed under this person, by them or by the office, in the one
  // store User Management also reads. Our ids only; never a Drive id.
  router.get('/api/my/documents', authenticateToken, requireStaff, async (req, res) => {
    const rows = ((await db.get('caregiver_documents')) || [])
      .filter(r => String(r.caregiver_id) === String(req.user.id) && !r.deleted_at)
      .sort((a, b) => String(b.uploaded_at).localeCompare(String(a.uploaded_at)))
      .map(r => ({
        id: r.id, kind: r.kind, fileName: r.file_name, note: r.note || null, status: r.status,
        uploadedAt: r.uploaded_at, filedByOffice: !!r.uploaded_by_office, uploadedByName: r.uploaded_by_name || null,
        reviewNote: r.status === 'rejected' ? (r.review_note || null) : null
      }));
    return res.json({ documents: rows });
  });
  router.get('/api/my/documents/:id/file', authenticateToken, requireStaff, async (req, res) => {
    const row = ((await db.get('caregiver_documents')) || []).find(r => r.id === req.params.id);
    // Another person's document reads as absent, never as forbidden: a 403
    // would confirm it exists.
    if (!row || String(row.caregiver_id) !== String(req.user.id) || row.deleted_at) {
      return res.status(404).json({ error: 'No such document.', code: 'DOCUMENT_UNKNOWN' });
    }
    try {
      const buf = await drive.downloadFileBuffer(row.drive_file_id);
      await logActivity(req.user.id, req.user.name, 'staff_portal_document_read', 'caregiver_document', row.id, {});
      res.setHeader('Content-Type', row.mime_type || 'application/octet-stream');
      res.setHeader('Content-Disposition', contentDisposition('inline', row.file_name || 'document'));
      return res.send(buf);
    } catch (e) {
      return res.status(502).json({ error: 'That document could not be opened.', code: 'DOCUMENT_UNREADABLE',
        detail: drive.describeDriveError ? drive.describeDriveError(e).reason : null });
    }
  });

  // ---- shared folders --------------------------------------------------------
  router.get('/api/my/folders', authenticateToken, requireStaff, async (req, res) => {
    const mine = (await folders()).filter(f => canSee(f, req.user))
      .map(f => ({ id: f.id, label: f.label, description: f.description || null }));
    return res.json({ folders: mine });
  });

  /**
   * One level of an assigned folder. `path` is the chain of subfolder ids from
   * the assigned folder down; each step is checked to be a child of the one
   * above it, so a person can never browse outside a folder assigned to them
   * by passing an id.
   */
  router.get('/api/my/folders/:id/items', authenticateToken, requireStaff, async (req, res) => {
    const f = (await folders()).find(x => x.id === req.params.id);
    if (!f || !canSee(f, req.user)) return res.status(404).json({ error: 'No such folder.', code: 'FOLDER_UNKNOWN' });
    const path = String(req.query.path || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 12);
    try {
      let current = f.folderId;
      const crumbs = [];
      for (const step of path) {
        const children = await drive.listFolderChildren(current);
        const hit = children.find(c => c.id === step && c.isFolder);
        if (!hit) return res.status(404).json({ error: 'That folder is not inside this shared folder.', code: 'FOLDER_OUTSIDE_SCOPE' });
        crumbs.push({ id: hit.id, name: hit.name });
        current = hit.id;
      }
      const items = await drive.listFolderChildren(current);
      await logActivity(req.user.id, req.user.name, 'staff_portal_folder_read', 'staff_folder', f.id, { depth: path.length });
      return res.json({ folder: { id: f.id, label: f.label }, crumbs,
        items: items.map(i => ({ id: i.id, name: i.name, isFolder: i.isFolder, modifiedTime: i.modifiedTime, url: i.isFolder ? null : i.webViewLink })) });
    } catch (e) {
      return res.status(502).json({ error: 'Drive did not return that folder.', code: 'FOLDER_UNREADABLE',
        detail: drive.describeDriveError ? drive.describeDriveError(e).reason : null });
    }
  });

  // ---- managing shared folders (admin) ----------------------------------------
  router.get('/api/my/admin/folders', authenticateToken, requireAdmin, async (req, res) => {
    const users = (await getUsers()).filter(u => audienceOf(u)).map(u => ({ id: u.id, name: u.name || u.email, type: audienceOf(u) }));
    return res.json({ folders: await folders(), types: STAFF_TYPES.map(t => ({ id: t, label: TYPE_LABELS[t] })), people: users });
  });
  router.post('/api/my/admin/folders', authenticateToken, requireAdmin, async (req, res) => {
    const b = req.body || {};
    const folderId = folderIdFrom(b.link);
    if (!folderId) return res.status(400).json({ error: 'Paste the Drive folder link.', code: 'FOLDER_LINK_INVALID' });
    const label = String(b.label || '').trim().slice(0, 120);
    if (!label) return res.status(400).json({ error: 'Give the folder a name people will recognize.', code: 'FOLDER_LABEL_REQUIRED' });
    const types = (Array.isArray(b.types) ? b.types : []).filter(t => STAFF_TYPES.includes(t));
    const userIds = (Array.isArray(b.userIds) ? b.userIds : []).map(String).filter(Boolean);
    if (!types.length && !userIds.length) return res.status(400).json({ error: 'Choose who sees it: a role or a person.', code: 'FOLDER_AUDIENCE_REQUIRED' });
    // Check it is a real folder the service account can read, so a typo never
    // becomes a tile that fails for everyone.
    try {
      const fp = await drive.getFileFingerprint(folderId);
      if (fp.mimeType !== FOLDER_MIME) return res.status(400).json({ error: 'That link is a file, not a folder.', code: 'FOLDER_NOT_A_FOLDER' });
    } catch (e) {
      return res.status(400).json({ error: 'The app cannot open that folder. Share it with the GFC admin account first.', code: 'FOLDER_UNREACHABLE',
        detail: drive.describeDriveError ? drive.describeDriveError(e).reason : null });
    }
    const rows = await folders();
    const row = { id: uuidv4(), folderId, label, description: String(b.description || '').trim().slice(0, 300) || null,
      types, userIds, createdAt: nowIso(), createdByName: req.user.name || req.user.email };
    rows.push(row);
    await db.set(FOLDERS, rows);
    await logActivity(req.user.id, req.user.name, 'staff_portal_folder_added', 'staff_folder', row.id, { label, types, people: userIds.length });
    return res.json({ ok: true, folder: row });
  });
  router.delete('/api/my/admin/folders/:id', authenticateToken, requireAdmin, async (req, res) => {
    const rows = await folders();
    const i = rows.findIndex(x => x.id === req.params.id);
    if (i === -1) return res.status(404).json({ error: 'No such folder.', code: 'FOLDER_UNKNOWN' });
    const [gone] = rows.splice(i, 1);
    await db.set(FOLDERS, rows);
    await logActivity(req.user.id, req.user.name, 'staff_portal_folder_removed', 'staff_folder', gone.id, { label: gone.label });
    return res.json({ ok: true });
  });

  return router;
};

module.exports.canSee = canSee;
module.exports.policiesFor = policiesFor;
module.exports.folderIdFrom = folderIdFrom;
module.exports.STAFF_TYPES = STAFF_TYPES;
