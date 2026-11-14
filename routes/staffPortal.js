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
const { SOURCES } = require('../onboarding/sources');
const attestations = require('../caregiverAttestations');
const wp = require('../welcomePacketRepository');
const welcomePacketPdf = require('../welcomePacketPdf');
const DS = require('../staffDocumentSends');
const signedDocument = require('../onboarding/signedDocument');
const staffDocs = require('../staffDocuments');
const announcements = require('../staffAnnouncements');

const FOLDERS = 'staff_portal_folders';
const STAFF_TYPES = Object.freeze(['admin', 'manager', 'coordinator', 'provider', 'rn', 'lcsw', 'lmsw', 'caregiver', 'liaison']);
const TYPE_LABELS = Object.freeze({
  admin: 'Administrator', manager: 'Manager', coordinator: 'Care Coordinator', provider: 'Clinician',
  rn: 'Registered Nurse', lcsw: 'Clinical Social Worker', lmsw: 'Social Worker', caregiver: 'Caregiver',
  liaison: 'Community Care Liaison'
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

/**
 * The LIVE policy library (owner, 2026-11-08): each policy a person works
 * under, always the canonical copy in Policies / Current, which is the one
 * the office updates in place. Signed copies live in My Documents; this is
 * where the current text is read. Clinicians get the Clinical P&P, the admin
 * team the Administrative P&P, field staff the Field Addendum.
 */
function policiesFor(type) {
  const field = CLINICIAN_TYPES.includes(type) || type === 'caregiver';
  const out = [];
  for (const a of ACKNOWLEDGMENTS) {
    if (!a.driveFileIds.length) continue;
    if (a.id === 'CLINICAL_MANUAL' && !CLINICIAN_TYPES.includes(type)) continue;
    if (a.id === 'FIELD_ADDENDUM' && !field) continue;
    out.push({ id: a.id, title: a.title, version: a.version, fileId: a.driveFileIds[0] });
  }
  // The private home care line works under the PHC P&P: its nurses and
  // caregivers (Playbook B.5).
  if (type === 'rn' || type === 'caregiver') {
    const h = SOURCES.PHC_MANUAL;
    out.push({ id: 'PHC_MANUAL', title: h.title, version: h.transcribedFromVersion, fileId: h.driveFileId });
  }
  if (ADMIN_TEAM_TYPES.includes(type)) {
    const m = SOURCES.ADMIN_MANUAL;
    out.push({ id: 'ADMIN_MANUAL', title: m.title, version: m.transcribedFromVersion, fileId: m.driveFileId });
  }
  return out;
}

// The Drive folder a person's own files (headshot, pay stubs) land in: the
// same per-role folders onboarding uploads already use.
function roleFolderFor(type) {
  if (type === 'caregiver') return staffFolders.folderForChapter('A');
  if (type === 'rn') return staffFolders.folderForChapter('B');
  if (CLINICIAN_TYPES.includes(type)) return staffFolders.folderForChapter('C');
  if (type === 'liaison') return staffFolders.folderForChapter('G');
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
  const { db, logActivity, authenticateToken, drive, uuidv4, getUsers, detectFileType, enrollmentSummary } = deps;
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

  // ---- the staff welcome packet (owner, 2026-11-09) ---------------------------
  // The caregiver welcome packet's format for every other role: the same
  // sections code, the same sanitizer, the same sign step and the same signed
  // PDF. Its own store, so caregiver code that reads welcome_packets never
  // meets a staff row. Availability is step 3: the shared availability form.
  const STAFF_PACKETS = 'staff_welcome_packets';
  const staffPacketFor = async (userId) => ((await db.get(STAFF_PACKETS)) || []).find(p => p && String(p.user_id) === String(userId)) || null;
  const saveStaffPacket = async (packet) => {
    const rows = (await db.get(STAFF_PACKETS)) || [];
    const i = rows.findIndex(r => r && String(r.user_id) === String(packet.user_id));
    packet.updated_at = nowIso();
    if (i === -1) rows.push(packet); else rows[i] = packet;
    await db.set(STAFF_PACKETS, rows);
  };
  const availabilityFor = async (userId) => {
    const rows = ((await db.get('caregiver_availability')) || []).filter(r => r && String(r.caregiver_id) === String(userId))
      .sort((a, b) => String(b.submitted_at).localeCompare(String(a.submitted_at)));
    const cur = rows[0] || null;
    return cur ? { effectiveFrom: cur.effective_from, windows: cur.windows || [], blackoutDates: cur.blackout_dates || [], note: cur.note || null, submittedAt: cur.submitted_at } : null;
  };
  const DAY = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };
  const availabilityLines = (a) => (!a ? ['No availability on file.'] : [`From ${a.effectiveFrom}`]
    .concat((a.windows || []).map(x => `${DAY[x.day] || x.day} ${x.start}–${x.end}`))
    .concat(a.note ? [`Note: ${a.note}`] : []));
  const staffPacketPdf = async (packet, user) => welcomePacketPdf.generateSignedWelcomePacketPDF(packet, user, [], {
    sections: wp.STAFF_PACKET_SECTIONS, title: 'COMPLETED STAFF WELCOME PACKET',
    extraSections: [{ number: 3, title: 'Availability', lines: availabilityLines(await availabilityFor(user.id)) }]
  });
  const requireNotCaregiver = (req, res, next) => (audienceOf(req.user) === 'caregiver'
    ? res.status(409).json({ error: 'Caregivers fill in the welcome packet in the caregiver app.', code: 'WELCOME_CAREGIVER_PACKET' }) : next());

  router.get('/api/my/welcome-packet', authenticateToken, requireStaff, requireNotCaregiver, async (req, res) => {
    const p = await staffPacketFor(req.user.id);
    return res.json({
      version: wp.STAFF_PACKET_VERSION, sections: wp.STAFF_PACKET_SECTIONS, signNote: wp.STAFF_SIGN_NOTE,
      status: p ? p.status : 'not_started', data: (p && p.data) || { email: req.user.email || '' },
      signedAt: p ? p.signed_at || null : null, availabilityOnFile: !!(await availabilityFor(req.user.id)),
      missing: wp.missingProfileFields((p && p.data) || {}, wp.STAFF_PACKET_SECTIONS)
    });
  });
  // Saved a step at a time and MERGED, the caregiver packet's rule.
  router.put('/api/my/welcome-packet', authenticateToken, requireStaff, requireNotCaregiver, async (req, res) => {
    const p = (await staffPacketFor(req.user.id)) || { id: uuidv4(), user_id: req.user.id, status: 'in_progress', data: {}, created_at: nowIso() };
    if (p.status === 'submitted') return res.status(409).json({ error: 'Your packet is signed. Contact the office to change anything on it.', code: 'PACKET_SIGNED' });
    const { clean, dropped } = wp.sanitizePacket(req.body && req.body.data, wp.STAFF_PACKET_SECTIONS);
    p.data = Object.assign({}, p.data, clean);
    p.status = 'in_progress';
    await saveStaffPacket(p);
    return res.json({ saved: true, data: p.data, dropped, missing: wp.missingProfileFields(p.data, wp.STAFF_PACKET_SECTIONS) });
  });
  router.post('/api/my/welcome-packet/submit', authenticateToken, requireStaff, requireNotCaregiver, async (req, res) => {
    const p = (await staffPacketFor(req.user.id)) || { id: uuidv4(), user_id: req.user.id, status: 'in_progress', data: {}, created_at: nowIso() };
    if (p.status === 'submitted') return res.status(409).json({ error: 'Your packet is already signed.', code: 'PACKET_SIGNED' });
    const { data, signaturePng, printedName } = req.body || {};
    if (data) p.data = Object.assign({}, p.data, wp.sanitizePacket(data, wp.STAFF_PACKET_SECTIONS).clean);
    const missing = wp.missingProfileFields(p.data, wp.STAFF_PACKET_SECTIONS);
    if (!(await availabilityFor(req.user.id))) missing.push({ id: 'availability', label: 'Your availability', section: 'availability', sectionTitle: 'Availability' });
    if (missing.length) return res.status(400).json({ error: 'Some answers are still needed before you can sign.', code: 'PACKET_INCOMPLETE', missing });
    const sig = String(signaturePng || '');
    if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(sig)) return res.status(400).json({ error: 'Please sign in the box before submitting.', code: 'SIGNATURE_REQUIRED' });
    if (sig.length > 400000) return res.status(413).json({ error: 'That signature is too large to store.', code: 'SIGNATURE_TOO_LARGE' });
    const printed = String(printedName || '').trim();
    if (!printed) return res.status(400).json({ error: 'Type your name as it should appear on the packet.', code: 'PRINTED_NAME_REQUIRED' });
    Object.assign(p, { signature_png: sig, printed_name: printed.slice(0, 160), signed_at: nowIso(), status: 'submitted', version: wp.STAFF_PACKET_VERSION });
    await saveStaffPacket(p);
    await logActivity(req.user.id, req.user.name, 'staff_welcome_packet_submitted', 'staff_welcome_packet', p.id, { version: p.version });
    return res.json({ submitted: true, signedAt: p.signed_at });
  });
  router.get('/api/my/welcome-packet/signed.pdf', authenticateToken, requireStaff, requireNotCaregiver, async (req, res) => {
    const p = await staffPacketFor(req.user.id);
    if (!p || p.status !== 'submitted') return res.status(404).json({ error: 'No signed packet is on file.', code: 'PACKET_NOT_SIGNED' });
    const u = (await getUsers()).find(x => String(x.id) === String(req.user.id)) || req.user;
    const buf = await staffPacketPdf(p, u);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', contentDisposition('attachment', `GFC_Welcome_Packet_${u.name || u.id}.pdf`));
    return res.send(buf);
  });

  // ---- the admin team reads anyone's completed welcome packet ------------------
  // Caregivers' and everyone else's, from User Management (owner, 2026-11-09).
  router.get('/api/my/admin/welcome/:userId', authenticateToken, requireAdmin, async (req, res) => {
    const u = (await getUsers()).find(x => String(x.id) === String(req.params.userId) && audienceOf(x));
    if (!u) return res.status(404).json({ error: 'No such staff member.', code: 'STAFF_UNKNOWN' });
    if (audienceOf(u) === 'caregiver') {
      const cp = ((await db.get('welcome_packets')) || []).find(p => p && String(p.caregiver_id) === String(u.id)) || null;
      return res.json({ kind: 'caregiver', status: cp ? cp.status : 'not_started', signedAt: cp ? cp.signed_at || null : null,
        sections: wp.PACKET_SECTIONS, data: (cp && cp.data) || {} });
    }
    const p = await staffPacketFor(u.id);
    return res.json({ kind: 'staff', status: p ? p.status : 'not_started', signedAt: p ? p.signed_at || null : null,
      sections: wp.STAFF_PACKET_SECTIONS, data: (p && p.data) || {}, availability: await availabilityFor(u.id) });
  });
  router.get('/api/my/admin/welcome/:userId/signed.pdf', authenticateToken, requireAdmin, async (req, res) => {
    const u = (await getUsers()).find(x => String(x.id) === String(req.params.userId) && audienceOf(x));
    if (!u) return res.status(404).json({ error: 'No such staff member.', code: 'STAFF_UNKNOWN' });
    let buf;
    if (audienceOf(u) === 'caregiver') {
      const cp = ((await db.get('welcome_packets')) || []).find(p => p && String(p.caregiver_id) === String(u.id));
      if (!cp || cp.status !== 'submitted') return res.status(404).json({ error: 'No signed packet is on file.', code: 'PACKET_NOT_SIGNED' });
      const docs = ((await db.get('caregiver_documents')) || []).filter(r => r && String(r.caregiver_id) === String(u.id));
      const atts = ((await db.get('caregiver_attestations')) || []).filter(r => r && String(r.caregiver_id) === String(u.id));
      buf = await welcomePacketPdf.generateSignedWelcomePacketPDF(cp, u, wp.buildChecklist(cp.data, docs, cp.office, atts));
    } else {
      const p = await staffPacketFor(u.id);
      if (!p || p.status !== 'submitted') return res.status(404).json({ error: 'No signed packet is on file.', code: 'PACKET_NOT_SIGNED' });
      buf = await staffPacketPdf(p, u);
    }
    await logActivity(req.user.id, req.user.name, 'welcome_packet_read', 'welcome_packet', u.id, {});
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', contentDisposition('attachment', `GFC_Welcome_Packet_${u.name || u.id}.pdf`));
    return res.send(buf);
  });

  // ---- who I am ------------------------------------------------------------
  router.get('/api/my/profile', authenticateToken, requireStaff, async (req, res) => {
    const type = audienceOf(req.user);
    return res.json({
      id: req.user.id, name: req.user.name || req.user.email, email: req.user.email || null,
      type, typeLabel: TYPE_LABELS[type],
      isAdmin: isAdminTeam(req.user),
      isCaregiver: type === 'caregiver',
      isLiaison: type === 'liaison',
      employmentType: req.user.employmentType || null,
      isClinician: ['provider', 'rn', 'lcsw', 'lmsw'].includes(type) || !!req.user.hasClinicalAccess,
      // Caregivers have their welcome packet; everyone else this short form.
      welcomeDone: type === 'caregiver' ? true : ((await staffPacketFor(req.user.id)) || {}).status === 'submitted'
    });
  });


  // ---- a liaison's clients ------------------------------------------------------
  // Owner, 2026-11-08: a Community Care Liaison sees the clients assigned to
  // them when their account is set up, and for each only the enrollment
  // summary: status, how complete, and what is still needed. Never the intake
  // answers, the chart or anything clinical. Assignment is the same
  // `assignedClients` list a caregiver's uses, matched by id or (older rows) name.
  const requireLiaison = (req, res, next) => (audienceOf(req.user) === 'liaison' ? next()
    : res.status(403).json({ error: 'My Clients is for community care liaisons.', code: 'LIAISON_ONLY' }));
  const assignedTo = (u, client) => {
    const list = (u.assignedClients || []).map(String);
    return list.includes(String(client.id)) || (client.name && list.includes(String(client.name)));
  };
  router.get('/api/my/clients', authenticateToken, requireLiaison, async (req, res) => {
    const mine = (await getUsers()).filter(u => u.role === 'client' && assignedTo(req.user, u));
    const clients = mine.map(c => enrollmentSummary(c)).sort((a, b) => String(a.name).localeCompare(String(b.name)));
    await logActivity(req.user.id, req.user.name, 'liaison_clients_read', 'client', null, { count: clients.length });
    return res.json({ clients });
  });

  // ---- policies (live) ----------------------------------------------------------
  // Each policy with whether this person has signed the CURRENT version, so a
  // policy update shows as "new version" until they acknowledge it.
  router.get('/api/my/policies', authenticateToken, requireStaff, async (req, res) => {
    const rec = ((await db.get('onboarding_records')) || []).find(r => String(r.userId) === String(req.user.id));
    const acks = {};
    for (const st of Object.values((rec && rec.items) || {})) Object.assign(acks, (st && st.acknowledgments) || {});
    const policies = policiesFor(audienceOf(req.user)).map(p => {
      const a = acks[p.id];
      return { id: p.id, title: p.title, version: p.version,
        url: viewUrl(p.fileId), previewUrl: `https://drive.google.com/file/d/${p.fileId}/preview`,
        signed: a ? { version: a.version, at: a.at, current: String(a.version) === String(p.version) } : null };
    });
    return res.json({ policies });
  });

  // ---- my documents ----------------------------------------------------------
  // Two kinds, one screen (owner, 2026-11-08: what is signed at onboarding
  // must not stay inside onboarding, which is for tracking):
  //   files   — everything filed under this person, by them or the office
  //   signed  — what they signed: policy acknowledgments at a version, and a
  //             caregiver's welcome packet and in-app attestations
  // Our ids only; never a Drive id.
  // Everything on file for one staff member: their uploaded documents and
  // every policy, packet and attestation they signed. ONE function, read by
  // the person's own My GFC and by the office's view of their staff record
  // (owner, 2026-11-09), so the two can never show different files.
  // The official tax forms they signed in Pay Setup (owner, 2026-11-14). Each
  // opens as the filled government form, built from what they entered. On the
  // Staff Record they are listed for the Super Admin only: they carry the SSN.
  const TAX_FORM_TITLES = { w4: 'Form W-4 (federal withholding)', g4: 'Georgia Form G-4', state: 'State withholding certificate', i9: 'Form I-9', w9: 'Form W-9', w8ben: 'Form W-8BEN' };
  const taxFormsFor = async (me) => {
    const p = (((await db.get('payroll_profiles')) || {})[me]) || null;
    if (!p) return [];
    const at = { w4: p.w4, g4: p.g4, state: p.stateCert, i9: p.i9 && p.i9.section1, w9: p.w9, w8ben: p.w8ben };
    return Object.entries(at).filter(([, v]) => v && v.signedAt)
      .map(([k, v]) => ({ id: `taxform:${k}`, title: TAX_FORM_TITLES[k], signedAt: v.signedAt, pdf: 'taxform', form: k }));
  };
  const documentsFor = async (person, { taxForms = true } = {}) => {
    const me = String(person.id);
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
    if (audienceOf(person) === 'caregiver') {
      const packet = ((await db.get('welcome_packets')) || []).find(p => p && String(p.caregiver_id) === me);
      if (packet && packet.signed_at) {
        signed.push({ id: 'packet', title: 'Caregiver welcome packet', signedAt: packet.signed_at, pdf: 'packet' });
      }
      for (const a of ((await db.get('caregiver_attestations')) || []).filter(x => x && String(x.caregiver_id) === me && x.signed_at)) {
        signed.push({ id: `attestation:${a.kind}`, title: attestations.titleFor(a.kind) || String(a.kind).replace(/_/g, ' '), version: attestations.versionLabel(a.version), signedAt: a.signed_at, pdf: 'attestation', kind: a.kind });
      }
    }
    if (taxForms) signed.push(...await taxFormsFor(me));
    signed.sort((x, y) => String(y.signedAt).localeCompare(String(x.signedAt)));
    return { documents: files, signed };
  };

  router.get('/api/my/documents', authenticateToken, requireStaff, async (req, res) => {
    return res.json(await documentsFor(req.user));
  });

  // The office's read of one staff member's documents, for their record in
  // User Management. The admin team only (admin, manager, care coordinator);
  // a client or family account is not staff and reads as unknown. Files open
  // through GET /api/caregiver/documents/:id/file, which is the office's too.
  router.get('/api/my/admin/people/:userId/documents', authenticateToken, requireAdmin, async (req, res) => {
    const person = (await getUsers()).find(u => String(u.id) === String(req.params.userId) && audienceOf(u));
    if (!person) return res.status(404).json({ error: 'No such staff member.', code: 'STAFF_UNKNOWN' });
    await logActivity(req.user.id, req.user.name || req.user.email, 'staff_record_documents_read', 'user', person.id, {});
    return res.json(await documentsFor(person, { taxForms: req.user.role === 'admin' }));
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
  // ---- announcements (owner, 2026-11-10) ----------------------------------------
  // Office news and upgrade notes for every staff member, read from the same
  // `caregiver_broadcasts` rows the caregiver Feed reads, through the same
  // audience rule (staffAnnouncements.visibleTo). Posting and retiring stay on
  // POST /api/caregiver/broadcasts, so there is one way to post.
  const READS = 'staff_announcement_reads';
  router.get('/api/my/announcements', authenticateToken, requireStaff, async (req, res) => {
    const rows = (await db.get('caregiver_broadcasts')) || [];
    const reads = (await db.get(READS)) || [];
    return res.json({ announcements: announcements.forViewer(rows, reads, req.user, audienceOf(req.user)) });
  });
  // Always the signed-in person's own receipt: there is no user id to pass.
  router.post('/api/my/announcements/:id/reviewed', authenticateToken, requireStaff, async (req, res) => {
    const rows = (await db.get('caregiver_broadcasts')) || [];
    const row = rows.find(r => r && r.id === req.params.id);
    if (!row || !announcements.visibleTo(row, audienceOf(req.user), req.user.id)) {
      return res.status(404).json({ error: 'No such announcement.', code: 'ANNOUNCEMENT_NOT_FOUND' });
    }
    const reads = (await db.get(READS)) || [];
    const had = reads.find(r => r && r.announcement_id === row.id && String(r.user_id) === String(req.user.id));
    if (had) return res.json({ reviewedAt: had.reviewed_at });
    const rec = { id: uuidv4(), announcement_id: row.id, user_id: req.user.id, user_name: req.user.name || req.user.email, reviewed_at: nowIso() };
    reads.push(rec);
    await db.set(READS, reads);
    await logActivity(req.user.id, rec.user_name, 'announcement_reviewed', 'broadcast', row.id, {});
    return res.json({ reviewedAt: rec.reviewed_at });
  });
  router.get('/api/my/admin/announcements', authenticateToken, requireAdmin, async (req, res) => {
    const rows = (await db.get('caregiver_broadcasts')) || [];
    const reads = (await db.get(READS)) || [];
    const people = (await getUsers())
      .filter(u => audienceOf(u) && u.accountStatus !== 'inactive')
      .map(u => ({ id: u.id, name: u.name || u.email, type: audienceOf(u) }));
    return res.json({
      announcements: announcements.report(rows, reads, people),
      roles: announcements.STAFF_TYPES.map(t => ({ value: t, label: TYPE_LABELS[t] })),
      people: people.map(p => ({ id: p.id, name: p.name, typeLabel: TYPE_LABELS[p.type] })).sort((a, b) => String(a.name).localeCompare(String(b.name)))
    });
  });

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
  // One person's headshot and bio, for their User Management form (admin team).
  router.get('/api/my/admin/bios/:userId', authenticateToken, requireAdmin, async (req, res) => {
    const u = (await getUsers()).find(x => String(x.id) === String(req.params.userId) && audienceOf(x));
    if (!u) return res.status(404).json({ error: 'No such staff member.', code: 'STAFF_UNKNOWN' });
    return res.json(Object.assign({ id: u.id, name: u.name || u.email, typeLabel: TYPE_LABELS[audienceOf(u)] }, publicBio((await profiles())[u.id])));
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

  // ---- DOCUMENTS TO REVIEW OR SIGN (owner, 2026-11-09) -----------------------
  // The office sends its own PDF to one person or to everyone of a type, at any
  // time. The recipient opens it here and acknowledges or signs it alone. The
  // signed copy is stored in Drive and filed to their Documents, where they and
  // the admin team can open it. An onboarding task can carry one of these.
  const SENDS = 'staff_document_sends';
  const SIGNINGS = 'staff_document_signings';
  const DOC_MAX = (() => { try { return require('../config').STAFF_DOCUMENT_MAX_SIZE || 25 * 1024 * 1024; } catch (_) { return 25 * 1024 * 1024; } })();
  const docUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: DOC_MAX } });
  const sends = async () => (await db.get(SENDS)) || [];
  const signings = async () => (await db.get(SIGNINGS)) || [];
  const hashIp = (req) => crypto.createHash('sha256').update(`gfc-sign:${req.ip || ''}`).digest('hex').slice(0, 24);
  const chapterOf = async (userId) => {
    const r = ((await db.get('onboarding_records')) || []).find(x => String(x.userId) === String(userId));
    return (r && r.inputs && r.inputs.chapter) || null;
  };
  const personOf = async (u) => ({ userId: String(u.id), name: u.name || u.email, audience: audienceOf(u), chapter: await chapterOf(u.id) });
  const staffPeople = async () => {
    const recs = (await db.get('onboarding_records')) || [];
    return (await getUsers()).filter(u => audienceOf(u) && u.accountStatus !== 'inactive').map(u => {
      const r = recs.find(x => String(x.userId) === String(u.id));
      return { userId: String(u.id), name: u.name || u.email, audience: audienceOf(u), chapter: (r && r.inputs && r.inputs.chapter) || null };
    });
  };
  const sendView = (s, people, rows) => ({
    id: s.id, title: s.title, note: s.note || null, action: s.action, fileName: s.fileName, scope: s.scope,
    createdAt: s.createdAt, createdByName: s.createdByName, recipients: DS.recipients(s, people, rows)
  });

  // The office: send, list (with who has and hasn't), withdraw.
  router.post('/api/my/admin/document-sends', authenticateToken, requireAdmin, docUpload.single('file'), async (req, res) => {
    const b = req.body || {};
    const title = String(b.title || '').trim().slice(0, 200);
    if (!title) return res.status(400).json({ error: 'Give the document a name.', code: 'DOC_TITLE_REQUIRED' });
    if (!DS.ACTIONS.includes(b.action)) return res.status(400).json({ error: 'Choose whether they acknowledge it or sign it.', code: 'DOC_ACTION_REQUIRED' });
    if (!req.file) return res.status(400).json({ error: 'Attach the PDF to send.', code: 'NO_FILE' });
    const type = detectFileType ? detectFileType(req.file.buffer) : null;
    if (type !== 'application/pdf' && !String(req.file.buffer.slice(0, 5)).startsWith('%PDF')) {
      return res.status(400).json({ error: 'Send a PDF, so it can be signed and filed as one document.', code: 'DOC_NOT_PDF' });
    }
    let scopeRaw = b.scope; try { if (typeof scopeRaw === 'string') scopeRaw = JSON.parse(scopeRaw); } catch (_) { scopeRaw = null; }
    const users = await getUsers();
    const chapters = Object.keys(require('../onboarding/track').CHAPTERS);
    const scope = DS.scopeFrom(scopeRaw, { staffTypes: STAFF_TYPES, chapters, userExists: (id) => users.some(u => String(u.id) === id && audienceOf(u)) });
    if (!scope) return res.status(400).json({ error: 'Choose who receives it: one staff member, or everyone of a type.', code: 'DOC_SCOPE_REQUIRED' });
    const prepared = staffDocs.prepareStaffDocument({ buffer: req.file.buffer, fileName: req.file.originalname, detectFileType, maxBytes: DOC_MAX, keyPrefix: 'sent' });
    if (!prepared.ok) return res.status(prepared.status).json({ error: prepared.error, code: prepared.code });
    let stored;
    try {
      stored = await drive.uploadStaffDocumentFile('GFC Documents to Sign', 'Sent', prepared.safeName, req.file.buffer, 'application/pdf');
    } catch (err) {
      return res.status(502).json({ error: 'We could not store that document. Please try again.', code: 'FILE_STORAGE_UNAVAILABLE',
        detail: drive.describeDriveError ? drive.describeDriveError(err).reason : null });
    }
    const row = { id: `send_${uuidv4().replace(/-/g, '').slice(0, 12)}`, title, note: String(b.note || '').trim().slice(0, 1000) || null,
      action: b.action, fileName: String(req.file.originalname || prepared.safeName).slice(0, 200), driveFileId: stored.fileId || stored.id || null,
      sha256: signedDocument.sha256(req.file.buffer), scope, createdById: String(req.user.id), createdByName: req.user.name || req.user.email,
      createdAt: nowIso(), removedAt: null };
    const all = await sends(); all.push(row); await db.set(SENDS, all);
    await logActivity(req.user.id, req.user.name || req.user.email, 'document_sent', 'staff_document', row.id, { scope, action: row.action });
    return res.json({ ok: true, send: sendView(row, await staffPeople(), await signings()) });
  });
  router.get('/api/my/admin/document-sends', authenticateToken, requireAdmin, async (req, res) => {
    const people = await staffPeople(); const rows = await signings();
    let list = (await sends()).filter(s => !s.removedAt).map(s => sendView(s, people, rows));
    if (req.query.userId) list = list.filter(s => s.recipients.some(r => r.userId === String(req.query.userId)));
    return res.json({ sends: list, types: STAFF_TYPES.map(t => ({ id: t, label: TYPE_LABELS[t] })) });
  });
  router.delete('/api/my/admin/document-sends/:id', authenticateToken, requireAdmin, async (req, res) => {
    const all = await sends(); const s = all.find(x => x.id === req.params.id && !x.removedAt);
    if (!s) return res.status(404).json({ error: 'No such document.', code: 'DOC_UNKNOWN' });
    // Withdrawn from whoever has not done it yet; signed copies stay filed.
    Object.assign(s, { removedAt: nowIso(), removedByName: req.user.name || req.user.email });
    await db.set(SENDS, all);
    await logActivity(req.user.id, req.user.name || req.user.email, 'document_withdrawn', 'staff_document', s.id, {});
    return res.json({ ok: true });
  });

  // The recipient: what is waiting on them, open it, acknowledge or sign it.
  router.get('/api/my/document-sends', authenticateToken, requireStaff, async (req, res) => {
    return res.json(DS.forPerson(await sends(), await signings(), await personOf(req.user)));
  });
  // The original, for a recipient or the admin team. Through the app, audited.
  router.get('/api/my/document-sends/:id/file', authenticateToken, requireStaff, async (req, res) => {
    const s = (await sends()).find(x => x.id === req.params.id);
    if (!s || (!isAdminTeam(req.user) && !DS.reaches(s, await personOf(req.user)))) return res.status(404).json({ error: 'No such document.', code: 'DOC_UNKNOWN' });
    try {
      const buf = await drive.downloadFileBuffer(s.driveFileId);
      await logActivity(req.user.id, req.user.name || req.user.email, 'document_opened', 'staff_document', s.id, {});
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', contentDisposition('inline', s.fileName || 'document.pdf'));
      return res.send(buf);
    } catch (err) {
      return res.status(502).json({ error: 'That document could not be opened just now.', code: 'FILE_STORAGE_UNAVAILABLE' });
    }
  });
  router.post('/api/my/document-sends/:id/sign', authenticateToken, requireStaff, async (req, res) => {
    const s = (await sends()).find(x => x.id === req.params.id);
    const me = await personOf(req.user);
    if (!s || !DS.reaches(s, me)) return res.status(404).json({ error: 'No such document.', code: 'DOC_UNKNOWN' });
    const rows = await signings();
    if (DS.signingFor(rows, s.id, me.userId)) return res.status(409).json({ error: s.action === 'sign' ? 'You have already signed this document.' : 'You have already acknowledged this document.', code: 'DOC_ALREADY_DONE' });
    const b = req.body || {};
    const printedName = String(b.printedName || '').trim().slice(0, 160);
    if (!printedName) return res.status(400).json({ error: 'Type your full name.', code: 'NAME_REQUIRED' });
    if (s.action === 'acknowledge' && b.acknowledged !== true) return res.status(400).json({ error: 'Tick the box to confirm you have read it.', code: 'ACK_REQUIRED' });
    const sig = String(b.signaturePng || '');
    if (s.action === 'sign') {
      if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(sig)) return res.status(400).json({ error: 'Please sign in the box.', code: 'SIGNATURE_REQUIRED' });
      if (sig.length > 400000) return res.status(413).json({ error: 'That signature is too large to store.', code: 'SIGNATURE_TOO_LARGE' });
    }
    let original;
    try { original = await drive.downloadFileBuffer(s.driveFileId); } catch (err) {
      return res.status(502).json({ error: 'That document could not be opened just now. Please try again.', code: 'FILE_STORAGE_UNAVAILABLE' });
    }
    // The document they were shown must be the one the office sent.
    if (s.sha256 && signedDocument.sha256(original) !== s.sha256) return res.status(409).json({ error: 'This document changed after it was sent. Ask the office to send it again.', code: 'DOC_CHANGED' });
    const signedAt = nowIso();
    const ipHash = hashIp(req);
    const built = await signedDocument.buildSignedCopy(original, {
      action: s.action, title: s.title, printedName, email: req.user.email, signedAt, ipHash,
      signedAtLabel: new Date(signedAt).toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'long', timeStyle: 'short' }) + ' Eastern',
      signaturePng: s.action === 'sign' ? sig : null
    });
    const fileName = `${s.title} - ${s.action === 'sign' ? 'signed' : 'acknowledged'} ${signedAt.slice(0, 10)}.pdf`.replace(/[\\/:*?"<>|]/g, '-');
    let stored;
    try {
      // Stored in Drive with their other staff paperwork.
      stored = await drive.uploadStaffDocumentFile(staffFolders.folderForChapter(me.chapter || 'C'), staffFolders.personFolderName(me.name, me.userId), fileName, built.bytes, 'application/pdf');
    } catch (err) {
      return res.status(502).json({ error: 'We could not file your signed copy. Please try again.', code: 'FILE_STORAGE_UNAVAILABLE' });
    }
    // Filed to their Documents: they and the admin team see it there.
    const documentId = `cgdoc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const docs = (await db.get('caregiver_documents')) || [];
    docs.push(staffDocs.buildStaffDocumentRow({
      id: documentId, ownerId: me.userId, ownerName: me.name, kind: 'signed_document', fileName, storedName: fileName,
      mime: 'application/pdf', sizeBytes: built.bytes.length, driveFileId: stored.fileId || stored.id || null, driveUrl: null,
      note: `${s.action === 'sign' ? 'Signed' : 'Acknowledged'}: ${s.title}`, status: 'accepted',
      uploadedById: req.user.id, uploadedByName: printedName, uploadedByOffice: false,
      extra: { document_send_id: s.id }
    }));
    await db.set('caregiver_documents', docs);
    rows.push({ id: uuidv4(), sendId: s.id, userId: me.userId, action: s.action, printedName, signedAt, ipHash, documentId, originalSha256: built.originalSha256 });
    await db.set(SIGNINGS, rows);
    // An onboarding task that carries this document is done when it is.
    await completeOnboardingTasks(s, me, req.user, signedAt, documentId);
    await logActivity(req.user.id, req.user.name || req.user.email, s.action === 'sign' ? 'document_signed' : 'document_acknowledged', 'staff_document', s.id, { documentId });
    return res.json({ ok: true, documentId });
  });

  async function completeOnboardingTasks(send, me, user, at, documentId) {
    const tasks = ((await db.get('onboarding_custom_tasks')) || []).filter(t => !t.removedAt && t.documentSendId === send.id);
    const recs = (await db.get('onboarding_records')) || [];
    const rec = recs.find(r => String(r.userId) === me.userId);
    if (!rec) return;
    const T = require('../onboarding/track');
    rec.items = rec.items || {};
    // Any of her own items this document was attached to (2026-11-10): her
    // first step is done, and the signed copy sits on the item.
    for (const [itemId, st] of Object.entries(rec.items)) {
      if (!st || !st.document || st.document.sendId !== send.id) continue;
      const def = T.findItem(itemId);
      if (!def) continue;
      const idx = def.steps.findIndex(s => s.actor === 'NEW_HIRE');
      if (idx < 0 || (st.steps && st.steps[idx])) continue;
      try {
        Object.assign(st, T.recordStep(def, st, idx, { id: user.id, name: user.name || user.email, isOffice: false }, {}, at));
      } catch (_) { /* the signing stands; the step can be recorded by hand */ }
      st.files = (st.files || []).concat([{ id: uuidv4(), name: `${send.title} (${send.action === 'sign' ? 'signed' : 'acknowledged'})`,
        documentId, uploadedAt: at, uploadedById: user.id, uploadedByName: user.name || user.email, filedBy: 'SELF' }]);
    }
    if (!tasks.length) { rec.updatedAt = nowIso(); await db.set('onboarding_records', recs); return; }
    const mine = T.customItemsFor(tasks, rec.inputs, rec.userId);
    for (const item of mine) {
      const st = rec.items[item.id] || {};
      if (st.steps && st.steps[0]) continue;
      try {
        rec.items[item.id] = Object.assign(st, T.recordStep(item, st, 0, { id: user.id, name: user.name || user.email, isOffice: false }, {}, at, { viaDocument: true }));
        rec.items[item.id].files = (rec.items[item.id].files || []).concat([{ id: uuidv4(), name: `${send.title} (${send.action === 'sign' ? 'signed' : 'acknowledged'})`,
          documentId, uploadedAt: at, uploadedById: user.id, uploadedByName: user.name || user.email, filedBy: 'SELF' }]);
      } catch (_) { /* the signing stands; the task can be recorded by hand */ }
    }
    rec.updatedAt = nowIso();
    await db.set('onboarding_records', recs);
  }

  return router;
};

module.exports.canSee = canSee;
module.exports.validateStub = validateStub;
module.exports.policiesFor = policiesFor;
module.exports.roleFolderFor = roleFolderFor;
module.exports.folderIdFrom = folderIdFrom;
module.exports.STAFF_TYPES = STAFF_TYPES;
