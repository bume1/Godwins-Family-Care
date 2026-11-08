// ============================================================================
// MY GFC — the staff portal's own routes
// ============================================================================
// Owner, 2026-11-08: staff get their own portal, the counterpart of the
// patient portal, housing their onboarding, documents (including what they
// signed), shared Drive folders, hours and pay stubs, and their headshot and bio. Onboarding itself is served by
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
const crypto = require('crypto');
const multer = require('multer');
const { ACKNOWLEDGMENTS, ITEMS } = require('../onboarding/chapterC');
const staffFolders = require('../onboarding/staffFolders');
const attestations = require('../caregiverAttestations');

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
// The admin team: administrators, managers and care coordinators (owner,
// 2026-11-08). They manage shared folders and read the team's website bios.
const ADMIN_TEAM_TYPES = Object.freeze(['admin', 'manager', 'coordinator']);
const viewUrl = (id) => `https://drive.google.com/file/d/${id}/view`;
const ACK_BY_ID = Object.fromEntries(ACKNOWLEDGMENTS.map(a => [a.id, a]));
const ITEM_BY_ID = Object.fromEntries(ITEMS.map(i => [i.id, i]));

// The Drive folder a person's own files (headshot, pay stubs) land in: the
// same per-role folders onboarding uploads already use.
function roleFolderFor(type) {
  if (type === 'caregiver') return staffFolders.folderForChapter('A');
  if (type === 'rn') return staffFolders.folderForChapter('B');
  if (CLINICIAN_TYPES.includes(type)) return staffFolders.folderForChapter('C');
  return staffFolders.folderForChapter('F');
}

const BIO_MAX = 3000;
const PAYSTUBS = 'staff_paystubs';
const PROFILES = 'staff_profiles';
const isIsoDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !Number.isNaN(Date.parse(v));
const money = (v) => (v === undefined || v === null || v === '' ? null : (Number.isFinite(Number(v)) ? Math.round(Number(v) * 100) / 100 : NaN));

/**
 * One pay stub row from the payroll Apps Script, checked. Returns
 * { ok, row } or { ok:false, reason }. The person is matched by EMAIL, the one
 * identifier both the payroll sheet and the app hold.
 */
function validateStub(raw) {
  const r = raw || {};
  const email = String(r.email || '').trim().toLowerCase();
  if (!email) return { ok: false, reason: 'No email on the row.' };
  for (const k of ['payDate', 'periodStart', 'periodEnd']) {
    if (!isIsoDate(r[k])) return { ok: false, reason: `${k} must be YYYY-MM-DD.` };
  }
  if (r.periodEnd < r.periodStart) return { ok: false, reason: 'The period ends before it starts.' };
  const gross = money(r.gross); const net = money(r.net); const hours = money(r.hours);
  if (gross === null || Number.isNaN(gross) || net === null || Number.isNaN(net)) return { ok: false, reason: 'gross and net must be numbers.' };
  if (Number.isNaN(hours)) return { ok: false, reason: 'hours must be a number.' };
  const pdfBase64 = r.pdfBase64 ? String(r.pdfBase64) : null;
  const driveFileId = r.driveFileId ? String(r.driveFileId).trim() : null;
  if (driveFileId && !/^[A-Za-z0-9_-]{10,}$/.test(driveFileId)) return { ok: false, reason: 'driveFileId is not a Drive file id.' };
  return { ok: true, row: {
    email, payDate: r.payDate, periodStart: r.periodStart, periodEnd: r.periodEnd,
    gross, net, hours,
    reference: r.reference ? String(r.reference).trim().slice(0, 80) : null,
    pdfBase64, driveFileId
  } };
}

// May this person see this assigned folder? By account type or by name.
function canSee(folder, u) {
  const type = audienceOf(u);
  if (!type) return false;
  if ((folder.userIds || []).map(String).includes(String(u.id))) return true;
  return (folder.types || []).includes(type);
}

module.exports = function createStaffPortalRoutes(deps) {
  const { db, logActivity, authenticateToken, drive, uuidv4, getUsers, detectFileType } = deps;
  const payrollKey = () => deps.payrollIngestKey !== undefined ? deps.payrollIngestKey : process.env.PAYROLL_INGEST_KEY;
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });
  const router = express.Router();
  const nowIso = () => new Date().toISOString();

  const requireStaff = (req, res, next) => (audienceOf(req.user) ? next()
    : res.status(403).json({ error: 'My GFC is the staff portal.', code: 'STAFF_PORTAL_STAFF_ONLY' }));
  const isAdminTeam = (u) => ADMIN_TEAM_TYPES.includes(audienceOf(u));
  const requireAdmin = (req, res, next) => (isAdminTeam(req.user) ? next()
    : res.status(403).json({ error: 'Only the admin team manages this.', code: 'STAFF_PORTAL_ADMIN_ONLY' }));
  const folders = async () => (await db.get(FOLDERS)) || [];

  // ---- who I am ------------------------------------------------------------
  router.get('/api/my/profile', authenticateToken, requireStaff, async (req, res) => {
    const type = audienceOf(req.user);
    return res.json({
      id: req.user.id, name: req.user.name || req.user.email, email: req.user.email || null,
      type, typeLabel: TYPE_LABELS[type],
      isAdmin: isAdminTeam(req.user),
      isCaregiver: type === 'caregiver',
      isClinician: ['provider', 'rn', 'lcsw', 'lmsw'].includes(type) || !!req.user.hasClinicalAccess
    });
  });

  // ---- my documents ----------------------------------------------------------
  // Two kinds, one screen (owner, 2026-11-08: what is signed at onboarding
  // must not stay inside onboarding, which is for tracking):
  //   files   — everything filed under this person, by them or the office
  //   signed  — what they signed: policy acknowledgments at a version, and a
  //             caregiver's welcome packet and in-app attestations
  // Our ids only; never a Drive id.
  router.get('/api/my/documents', authenticateToken, requireStaff, async (req, res) => {
    const me = String(req.user.id);
    const files = ((await db.get('caregiver_documents')) || [])
      .filter(r => String(r.caregiver_id) === me && !r.deleted_at)
      .sort((a, b) => String(b.uploaded_at).localeCompare(String(a.uploaded_at)))
      .map(r => ({
        id: r.id, kind: r.kind, fileName: r.file_name, note: r.note || null, status: r.status,
        itemTitle: r.onboarding_item_id && ITEM_BY_ID[r.onboarding_item_id] ? ITEM_BY_ID[r.onboarding_item_id].title : null,
        uploadedAt: r.uploaded_at, filedByOffice: !!r.uploaded_by_office, uploadedByName: r.uploaded_by_name || null,
        reviewNote: r.status === 'rejected' ? (r.review_note || null) : null
      }));

    const signed = [];
    const rec = ((await db.get('onboarding_records')) || []).find(r => String(r.userId) === me);
    for (const st of Object.values((rec && rec.items) || {})) {
      for (const [ackId, a] of Object.entries((st && st.acknowledgments) || {})) {
        const def = ACK_BY_ID[ackId];
        if (!def || !a) continue;
        signed.push({ id: `ack:${ackId}`, title: def.title, version: a.version, signedAt: a.at,
          filedByOffice: a.filedBy === 'OFFICE_ON_BEHALF', filedByName: a.byName || null,
          current: String(a.version) === String(def.version), links: def.driveFileIds.map(viewUrl) });
      }
    }
    if (audienceOf(req.user) === 'caregiver') {
      const packet = ((await db.get('welcome_packets')) || []).find(p => p && String(p.caregiver_id) === me);
      if (packet && packet.signed_at) {
        signed.push({ id: 'packet', title: 'Caregiver welcome packet', signedAt: packet.signed_at, pdf: 'packet' });
      }
      for (const a of ((await db.get('caregiver_attestations')) || []).filter(x => x && String(x.caregiver_id) === me && x.signed_at)) {
        signed.push({ id: `attestation:${a.kind}`, title: attestations.titleFor(a.kind) || String(a.kind).replace(/_/g, ' '), version: a.version, signedAt: a.signed_at, pdf: 'attestation', kind: a.kind });
      }
    }
    signed.sort((x, y) => String(y.signedAt).localeCompare(String(x.signedAt)));
    return res.json({ documents: files, signed });
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

  // ---- pay stubs ---------------------------------------------------------------
  // The payroll provider runs payroll; the owner's Google Apps Script turns
  // its results into one row per person per pay date and POSTs them here
  // (owner, 2026-11-08). Server to server, so there is no user session: the
  // script proves itself with PAYROLL_INGEST_KEY in a header. Unset key = the
  // door is shut, never open.
  router.post('/api/payroll/paystubs', async (req, res) => {
    const key = payrollKey();
    if (!key) return res.status(503).json({ error: 'Pay stub import is not switched on. Set PAYROLL_INGEST_KEY.', code: 'PAYROLL_INGEST_NOT_CONFIGURED' });
    const given = Buffer.from(String(req.get('X-GFC-Payroll-Key') || ''));
    const want = Buffer.from(String(key));
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
      return res.status(401).json({ error: 'Wrong payroll key.', code: 'PAYROLL_KEY_INVALID' });
    }
    const rows = Array.isArray(req.body && req.body.stubs) ? req.body.stubs : null;
    if (!rows || !rows.length) return res.status(400).json({ error: 'Send { stubs: [...] }.', code: 'PAYROLL_NO_STUBS' });
    if (rows.length > 500) return res.status(400).json({ error: 'At most 500 stubs per call.', code: 'PAYROLL_TOO_MANY' });

    const people = (await getUsers()).filter(u => audienceOf(u));
    const byEmail = new Map(people.map(u => [String(u.email || '').trim().toLowerCase(), u]));
    const stubs = (await db.get(PAYSTUBS)) || [];
    const report = { stored: 0, updated: 0, skipped: [] };
    for (let i = 0; i < rows.length; i++) {
      const v = validateStub(rows[i]);
      if (!v.ok) { report.skipped.push({ row: i, email: rows[i] && rows[i].email || null, reason: v.reason }); continue; }
      const r = v.row;
      const person = byEmail.get(r.email);
      if (!person) { report.skipped.push({ row: i, email: r.email, reason: 'No staff account has that email.' }); continue; }
      let pdfFileId = r.driveFileId;
      if (r.pdfBase64) {
        const buf = Buffer.from(r.pdfBase64, 'base64');
        if (!buf.length || buf.slice(0, 5).toString() !== '%PDF-') { report.skipped.push({ row: i, email: r.email, reason: 'pdfBase64 is not a PDF.' }); continue; }
        try {
          const stored = await drive.uploadStaffDocumentFile(roleFolderFor(audienceOf(person)), staffFolders.personFolderName(person.name, person.id),
            `Pay stub ${r.payDate}.pdf`, buf, 'application/pdf');
          pdfFileId = stored.fileId || stored.id || null;
        } catch (e) {
          report.skipped.push({ row: i, email: r.email, reason: 'The PDF could not be stored in Drive.' }); continue;
        }
      }
      // One stub per person per pay date and reference: a re-run of the
      // script replaces, never doubles.
      const keyOf = (x) => `${x.userId}|${x.payDate}|${x.reference || ''}`;
      const row = { id: uuidv4(), userId: String(person.id), payDate: r.payDate, periodStart: r.periodStart, periodEnd: r.periodEnd,
        gross: r.gross, net: r.net, hours: r.hours, reference: r.reference, driveFileId: pdfFileId || null, importedAt: nowIso() };
      const at = stubs.findIndex(x => keyOf(x) === keyOf(row));
      if (at === -1) { stubs.push(row); report.stored++; } else { row.id = stubs[at].id; stubs[at] = row; report.updated++; }
    }
    await db.set(PAYSTUBS, stubs);
    await logActivity(null, 'Payroll import', 'paystubs_imported', 'staff_paystubs', null, { stored: report.stored, updated: report.updated, skipped: report.skipped.length });
    return res.json(Object.assign({ ok: true }, report));
  });

  router.get('/api/my/paystubs', authenticateToken, requireStaff, async (req, res) => {
    const mine = ((await db.get(PAYSTUBS)) || []).filter(x => String(x.userId) === String(req.user.id))
      .sort((a, b) => String(b.payDate).localeCompare(String(a.payDate)))
      .map(x => ({ id: x.id, payDate: x.payDate, periodStart: x.periodStart, periodEnd: x.periodEnd,
        gross: x.gross, net: x.net, hours: x.hours, hasPdf: !!x.driveFileId }));
    return res.json({ paystubs: mine });
  });
  router.get('/api/my/paystubs/:id/file', authenticateToken, requireStaff, async (req, res) => {
    const x = ((await db.get(PAYSTUBS)) || []).find(r => r.id === req.params.id);
    if (!x || String(x.userId) !== String(req.user.id) || !x.driveFileId) return res.status(404).json({ error: 'No such pay stub.', code: 'PAYSTUB_UNKNOWN' });
    try {
      const buf = await drive.downloadFileBuffer(x.driveFileId);
      await logActivity(req.user.id, req.user.name, 'paystub_read', 'staff_paystubs', x.id, {});
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', contentDisposition('inline', `Pay stub ${x.payDate}.pdf`));
      return res.send(buf);
    } catch (e) {
      return res.status(502).json({ error: 'That pay stub could not be opened.', code: 'PAYSTUB_UNREADABLE' });
    }
  });

  // ---- headshot and website bio ------------------------------------------------
  // Each person keeps their own; the admin team reads them for the website.
  const profiles = async () => (await db.get(PROFILES)) || {};
  const publicBio = (p) => ({ title: (p && p.title) || '', bio: (p && p.bio) || '', hasHeadshot: !!(p && p.headshotFileId), updatedAt: (p && p.updatedAt) || null });

  router.get('/api/my/bio', authenticateToken, requireStaff, async (req, res) => res.json(publicBio((await profiles())[req.user.id])));
  router.put('/api/my/bio', authenticateToken, requireStaff, async (req, res) => {
    const b = req.body || {};
    const bio = String(b.bio || '').trim();
    if (bio.length > BIO_MAX) return res.status(400).json({ error: `Keep the bio under ${BIO_MAX} characters.`, code: 'BIO_TOO_LONG' });
    const all = await profiles();
    all[req.user.id] = Object.assign({}, all[req.user.id], { title: String(b.title || '').trim().slice(0, 120), bio, updatedAt: nowIso() });
    await db.set(PROFILES, all);
    await logActivity(req.user.id, req.user.name, 'staff_bio_updated', 'staff_profile', req.user.id, {});
    return res.json(publicBio(all[req.user.id]));
  });
  router.post('/api/my/bio/headshot', authenticateToken, requireStaff, upload.single('file'), async (req, res) => {
    if (!req.file || !req.file.buffer.length) return res.status(400).json({ error: 'Choose a photo.', code: 'NO_FILE' });
    const mime = detectFileType ? detectFileType(req.file.buffer) : null;
    if (!['image/jpeg', 'image/png'].includes(mime)) return res.status(400).json({ error: 'Use a JPG or PNG photo.', code: 'HEADSHOT_TYPE' });
    let stored;
    try {
      stored = await drive.uploadStaffDocumentFile(roleFolderFor(audienceOf(req.user)), staffFolders.personFolderName(req.user.name, req.user.id),
        `Headshot.${mime === 'image/png' ? 'png' : 'jpg'}`, req.file.buffer, mime);
    } catch (e) {
      return res.status(502).json({ error: 'We could not store that photo. Please try again.', code: 'FILE_STORAGE_UNAVAILABLE' });
    }
    const all = await profiles();
    all[req.user.id] = Object.assign({}, all[req.user.id], { headshotFileId: stored.fileId || stored.id, headshotMime: mime, updatedAt: nowIso() });
    await db.set(PROFILES, all);
    await logActivity(req.user.id, req.user.name, 'staff_headshot_updated', 'staff_profile', req.user.id, {});
    return res.json(publicBio(all[req.user.id]));
  });
  const sendHeadshot = async (res, p, name) => {
    if (!p || !p.headshotFileId) return res.status(404).json({ error: 'No headshot yet.', code: 'HEADSHOT_NONE' });
    try {
      const buf = await drive.downloadFileBuffer(p.headshotFileId);
      res.setHeader('Content-Type', p.headshotMime || 'image/jpeg');
      res.setHeader('Content-Disposition', contentDisposition('inline', `${name || 'Headshot'}.${p.headshotMime === 'image/png' ? 'png' : 'jpg'}`));
      return res.send(buf);
    } catch (e) {
      return res.status(502).json({ error: 'That photo could not be opened.', code: 'HEADSHOT_UNREADABLE' });
    }
  };
  router.get('/api/my/bio/headshot', authenticateToken, requireStaff, async (req, res) => sendHeadshot(res, (await profiles())[req.user.id], req.user.name));
  router.get('/api/my/admin/bios', authenticateToken, requireAdmin, async (req, res) => {
    const all = await profiles();
    const team = (await getUsers()).filter(u => audienceOf(u)).map(u => Object.assign({ id: u.id, name: u.name || u.email, type: audienceOf(u), typeLabel: TYPE_LABELS[audienceOf(u)] }, publicBio(all[u.id])));
    return res.json({ team });
  });
  router.get('/api/my/admin/bios/:userId/headshot', authenticateToken, requireAdmin, async (req, res) => {
    const u = (await getUsers()).find(x => String(x.id) === String(req.params.userId) && audienceOf(x));
    if (!u) return res.status(404).json({ error: 'No such staff member.', code: 'STAFF_UNKNOWN' });
    return sendHeadshot(res, (await profiles())[u.id], u.name);
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
module.exports.validateStub = validateStub;
module.exports.roleFolderFor = roleFolderFor;
module.exports.folderIdFrom = folderIdFrom;
module.exports.STAFF_TYPES = STAFF_TYPES;
