// ============================================================================
// STAFF ONBOARDING ROUTES — the wizard she works through and the office's
// command center, over the Playbook v3.0 catalog (onboarding/)
// ============================================================================
// TWO DOORS, ONE STORE. `/me` is hers and resolves her FROM THE SESSION; no
// `/me` route takes a userId, so nobody reads or writes another person's
// onboarding through it. `/admin` is the office's and names the person.
//
// COLLABORATIVE (owner, 2026-11-08). She completes her own steps; the office
// completes or verifies the rest, and may complete any step, filing hers on
// her behalf. The rules live in onboarding/track.js; this file only loads the
// record, calls them and saves.
//
// Replaces #260's /api/clinician-onboarding routes. #260's records are read,
// never written, and shown as evidence (onboarding/legacy260.js).
// ============================================================================

'use strict';

const express = require('express');
const multer = require('multer');
const T = require('../onboarding/track');
const RN = require('../onboarding/renewals');
const accountTypes = require('../accountTypes');

// Who is onboarded on which chapter. Clinicians on C; the admin team on F;
// the liaison on G, which carries F's screening and paperwork (owner, 2026-11-08). The office can change it in Setup.
const ONBOARDED_TYPES = Object.freeze(['admin', 'manager', 'coordinator', 'provider', 'rn', 'lcsw', 'lmsw', 'liaison', 'caregiver']);
const defaultChapterFor = (u) => {
  const t = accountTypes.accountTypeOf(u);
  if (t === 'rn') return 'B';   // the registered nurse chapter (owner, 2026-11-08)
  if (t === 'liaison') return 'G';
  // Caregivers: Chapter A, read through their welcome packet.
  if (t === 'caregiver') return 'A';
  // A contracted NP or PA (1099) is Chapter D, never C: running a contractor
  // through the employee chapter is what D.2 warns converts the classification.
  // A physician (MD or DO) is the delegating physician: Reference R1, Georgia.
  if (t === 'provider' && u && ['MD', 'DO'].includes(u.prescriberCredential)) return 'R1';
  if (t === 'provider' && u && u.employmentType === '1099') return 'D';
  // Employed AND contracted: the full W-2 chapter plus the exam contract (E).
  if (t === 'provider' && u && u.employmentType === 'HYBRID') return 'E';
  return (['provider', 'lcsw', 'lmsw'].includes(t) || (u && u.hasClinicalAccess && !u.isManager)) ? 'C' : 'F';
};
const CHAPTER_CHOICES = Object.freeze([
  { id: 'A', label: 'Caregiver, employed (companion, PCA or licensed nursing)' },
  { id: 'B', label: 'Registered nurse, employed (private home care)' },
  { id: 'C', label: 'Clinician (NP, MD, PA), employed' },
  { id: 'D', label: 'Clinician (NP, PA), contracted only (1099)' },
  { id: 'E', label: 'Clinician, hybrid: employed (W-2) and contracted for exams (1099)' },
  { id: 'F', label: 'Admin team and non-clinical staff (office, clinical operations, care coordination)' },
  { id: 'G', label: 'Community Care Liaison (remote business development)' },
  { id: 'H', label: 'Student or extern on an educational placement (unpaid)' },
  { id: 'R1', label: 'Supervising (delegating) physician, Georgia' }
]);
const C = require('../onboarding/chapterC');
const wpRepo = require('../welcomePacketRepository');
const welcomePacketPdf = require('../welcomePacketPdf');
const attestations = require('../caregiverAttestations');
const CC = require('../onboarding/caregiverCourses');
const { MODULES, findModule } = require('../onboarding/modules');
const VF = require('../onboarding/versionFlags');
const P = require('../onboarding/sourceParsers');
const { driveViewUrl } = require('../onboarding/sources');
const staffFolders = require('../onboarding/staffFolders');
const { createSourceLoader } = require('../onboarding/sourceLoader');
const { contentDisposition } = require('../contentDisposition');
const staffDocs = require('../staffDocuments');

const RECORDS = 'onboarding_records';
const EVENTS = 'onboarding_events';
const REVIEWS = 'onboarding_module_reviews';
const LEGACY = 'clinician_onboarding';
// Fallback only; the live ceiling is config.STAFF_DOCUMENT_MAX_SIZE (25 MB).
const MAX_BYTES = 25 * 1024 * 1024;

module.exports = function createOnboardingRoutes(deps) {
  const { db, config, logActivity, getUsers, authenticateToken, drive, detectFileType, uuidv4 } = deps;
  const router = express.Router();
  const STAFF_MAX = (config && config.STAFF_DOCUMENT_MAX_SIZE) || MAX_BYTES;
  const multerUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: STAFF_MAX } });
  // An oversized file is refused with the limit named, never a bare 500.
  const upload = { single: (field) => (req, res, next) => multerUpload.single(field)(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: `File exceeds the ${Math.round(STAFF_MAX / (1024 * 1024))} MB limit.`, code: 'DOC_TOO_LARGE' });
    return next(err);
  }) };
  const loader = deps.sourceLoader || createSourceLoader({ drive, db });
  const nowIso = () => new Date().toISOString();
  const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const trim = (v, n = 2000) => String(v === undefined || v === null ? '' : v).trim().slice(0, n);

  // ---- who ----------------------------------------------------------------
  // The office is an admin or a manager: a provider must never verify her own
  // licence or sign her own service line open.
  const isOffice = (u) => !!u && (u.role === 'admin' || u.isManager === true);
  const requireOffice = (req, res, next) => (isOffice(req.user) ? next()
    : res.status(403).json({ error: 'This is the office\'s onboarding view.', code: 'ONBOARDING_OFFICE_ONLY' }));
  const requireStaff = (req, res, next) => (req.user && (req.user.hasClinicalAccess || isOffice(req.user) || ONBOARDED_TYPES.includes(accountTypes.accountTypeOf(req.user))) ? next()
    : res.status(403).json({ error: 'Onboarding is for GFC staff.', code: 'ONBOARDING_NOT_STAFF' }));
  const actorOf = (req) => ({ id: req.user.id, name: req.user.name || req.user.email, isOffice: false });
  const officeActorOf = (req) => ({ id: req.user.id, name: req.user.name || req.user.email, isOffice: true });

  // ---- store --------------------------------------------------------------
  const all = async () => (await db.get(RECORDS)) || [];
  const find = (rows, userId) => rows.find(r => String(r.userId) === String(userId)) || null;
  async function save(rec) {
    const rows = await all();
    const i = rows.findIndex(r => String(r.userId) === String(rec.userId));
    rec.updatedAt = nowIso();
    if (i === -1) rows.push(rec); else rows[i] = rec;
    await db.set(RECORDS, rows);
  }
  async function event(row) {
    const rows = (await db.get(EVENTS)) || [];
    rows.push(Object.assign({ id: uuidv4(), at: nowIso() }, row));
    await db.set(EVENTS, rows);
  }
  async function legacyFor(userId) {
    const rows = (await db.get(LEGACY)) || [];
    const r = rows.find(x => String(x.userId) === String(userId));
    if (!r || !r.items) return null;
    let titles = {};
    try { titles = Object.fromEntries(require('../clinicianItems').ITEM_LIBRARY.map(i => [i.id, i.title])); } catch (_) { /* titles are cosmetic */ }
    return { items: r.items, titles };
  }
  async function reviews() { return (await db.get(REVIEWS)) || {}; }

  // Tasks an admin or manager added (owner, 2026-11-09): to one person, or to
  // everyone onboarding under a chapter. Looked up per person, so a task that
  // is not theirs is unknown to their doors.
  const CUSTOM = 'onboarding_custom_tasks';
  const customTasks = async () => (await db.get(CUSTOM)) || [];
  async function itemFor(rec, id) {
    return T.findItem(id) || T.customItemsFor(await customTasks(), rec.inputs, rec.userId).find(it => it.id === String(id)) || null;
  }

  // The manual version and change log, read from Drive. A Drive failure never
  // blocks onboarding: the version flag falls back to the seeded change list
  // and the office is told the manual could not be read.
  async function manual() {
    try { return await loader.manualState(); } catch (e) { return { ok: false, reason: e.message, changeLog: VF.SEEDED_CHANGES.slice() }; }
  }

  // Chapter A reads the caregiver's welcome packet checklist, derived the
  // same way the caregiver app and the scheduling gate derive it. Never
  // stored here: a stored copy goes stale the moment a document is accepted.
  const CARE_CERTIFICATES = ['pca', 'cna', 'hha', 'lpn', 'rn'];
  async function packetFor(rec) {
    if (!rec) return { rows: undefined, certified: false, licenseLevel: null };
    // Every other chapter opens with the staff welcome packet (owner,
    // 2026-11-09): one row, read from the packet My GFC writes. Signed is
    // complete; anything else is still hers to do.
    if (!rec.inputs || rec.inputs.chapter !== 'A') {
      const sp = ((await db.get('staff_welcome_packets')) || []).find(r => r && String(r.user_id) === String(rec.userId)) || null;
      const signed = !!(sp && sp.status === 'submitted');
      return { rows: [{ kind: 'staff_welcome', item: 'WELCOME', title: 'Welcome packet', required: true, source: 'gfc_sign',
        status: signed ? 'complete' : 'missing', signedAt: signed ? (sp.signed_at || null) : null }],
        certified: false, licenseLevel: null };
    }
    const id = String(rec.userId);
    const packet = ((await db.get('welcome_packets')) || []).find(r => r && String(r.caregiver_id) === id) || null;
    const docs = ((await db.get('caregiver_documents')) || []).filter(r => r && String(r.caregiver_id) === id);
    const atts = ((await db.get('caregiver_attestations')) || []).filter(r => r && String(r.caregiver_id) === id);
    const held = ((packet || {}).data || {}).certifications;
    const user = ((await getUsers()) || []).find(x => String(x.id) === id) || {};
    return {
      licenseLevel: user.licenseLevel || null, docs, atts, user,
      rows: wpRepo.buildChecklist((packet || {}).data, docs, (packet || {}).office, atts),
      certified: Array.isArray(held) && held.some(c => CARE_CERTIFICATES.includes(c))
    };
  }
  // The welcome-wizard files behind one Chapter A item: her uploads of the
  // item's packet kinds (a rejected one is not evidence) and the forms she
  // signed. Ids are ours ('packet:<row>', 'form:<kind>'), never a Drive id.
  function welcomeFilesFor(item, pk) {
    const kinds = (item && item.packet) || [];
    if (!kinds.length || !pk || !pk.docs) return [];
    const uploads = pk.docs.filter(d => kinds.includes(d.kind) && !d.deleted_at && d.status !== 'rejected')
      .map(d => ({ id: `packet:${d.id}`, name: d.file_name || 'Document', uploadedAt: d.uploaded_at,
        uploadedByName: d.uploaded_by_name || null, filedBy: d.uploaded_by_office ? 'OFFICE_ON_BEHALF' : 'SELF',
        fromWelcomePacket: true, status: d.status }));
    const forms = (pk.atts || []).filter(a => kinds.includes(a.kind) && a.signed_at)
      .map(a => ({ id: `form:${a.kind}`, name: `${attestations.titleFor(a.kind) || a.kind} (signed)`, uploadedAt: a.signed_at,
        filedBy: 'SELF', fromWelcomePacket: true, status: 'signed' }));
    return uploads.concat(forms);
  }

  // Her inputs with what the packet says about her certificates.
  // Her license level is read from her account, like her certificates from
  // her packet: facts about her, never typed into Setup.
  const withPacketFacts = (inputs, pk) => Object.assign({}, inputs || {}, { holdsCareCertificate: !!(pk && pk.certified), licenseLevel: (pk && pk.licenseLevel) || null });

  async function buildFor(rec, audience) {
    const m = await manual();
    const pk = await packetFor(rec);
    const track = T.buildTrack({
      inputs: withPacketFacts(rec.inputs, pk), record: rec, today: today(), audience,
      manualVersion: m.ok ? m.currentVersion : '2.2',
      moduleReviews: await reviews(),
      legacy: await legacyFor(rec.userId),
      packetRows: pk.rows,
      customTasks: await customTasks()
    });
    // Acknowledged documents link their canonical Drive copy.
    track.items.forEach(it => {
      (it.acknowledgments || []).forEach(a => {
        const doc = T.ALL_ACKS.find(d => d.id === a.id);
        a.links = (doc.driveFileIds || []).map(id => `https://drive.google.com/file/d/${id}/view`);
      });
      // Files: our own ids only. A Drive id never leaves the server.
      const st = (rec.items || {})[it.id] || {};
      it.files = (st.files || []).map(f => ({ id: f.id, name: f.name, uploadedAt: f.uploadedAt, uploadedByName: f.uploadedByName, filedBy: f.filedBy }));
      // Chapter A: what she sent or signed in the welcome wizard shows on the
      // item it belongs to (owner, 2026-11-09), read from the stores the
      // welcome packet writes, never copied. Opened through doDownload.
      if (pk.docs) it.files = it.files.concat(welcomeFilesFor(T.findItem(it.id), pk));
      it.notes = st.notes || [];
      it.sourceUrl = it.ref && it.ref.source ? driveViewUrl(it.ref.source) : null;
    });
    track.person = { userId: rec.userId, name: rec.userName, startDate: rec.inputs && rec.inputs.startDate || null };
    track.manual = { ok: !!m.ok, version: m.ok ? m.currentVersion : null, reason: m.ok ? null : (m.reason || null) };
    return track;
  }

  // CHECK QUESTIONS ARE OFF FOR STAFF until the office switches them on
  // (owner, 2026-11-08: the SOPs behind them are still being written). Off
  // means the server never sends them, not that the page hides them.
  const SETTINGS = 'onboarding_settings';
  const settings = async () => Object.assign({ checkQuestionsForStaff: false }, (await db.get(SETTINGS)) || {});

  // Check questions for the modules she can take now, read live from Drive.
  async function checksFor(track) {
    try {
      const c = await loader.checks();
      const out = {};
      track.modules.filter(m => m.available || m.complete).forEach(m => {
        out[m.id] = P.checksForModule(findModule(m.id), { library: c.library || {}, sops: c.sops || {} });
      });
      return { ok: c.ok, byModule: out, errors: c.errors || [] };
    } catch (e) {
      return { ok: false, byModule: {}, errors: [{ reason: e.message }] };
    }
  }

  // ---- renewals, recurring duties, re-checks (one implementation, two doors) ----
  async function doExpiry(req, res, rec, actor) {
    const item = await itemFor(rec, req.params.itemId);
    if (!item) return res.status(404).json({ error: 'Unknown item.', code: 'ITEM_UNKNOWN' });
    try {
      rec.items = rec.items || {};
      rec.items[item.id] = RN.setExpiry(item.id, rec.items[item.id], String((req.body || {}).expiresOn || ''), actor, nowIso());
      await save(rec);
      await event({ userId: rec.userId, type: 'expiry_set', itemId: item.id, expiresOn: rec.items[item.id].expiresOn, byId: actor.id, byName: actor.name });
      return res.json({ ok: true });
    } catch (e) { return send(res, e); }
  }
  async function doRenew(req, res, rec, actor) {
    const item = await itemFor(rec, req.params.itemId);
    if (!item) return res.status(404).json({ error: 'Unknown item.', code: 'ITEM_UNKNOWN' });
    try {
      rec.items = rec.items || {};
      rec.items[item.id] = RN.startRenewal(item.id, rec.items[item.id], actor, nowIso());
      await save(rec);
      await event({ userId: rec.userId, type: 'renewal_started', itemId: item.id, byId: actor.id, byName: actor.name });
      return res.json({ ok: true });
    } catch (e) { return send(res, e); }
  }
  async function doRecheck(req, res, rec, actor) {
    const m = findModule(req.params.moduleId);
    if (!m) return res.status(404).json({ error: 'Unknown module.', code: 'MODULE_UNKNOWN' });
    try {
      rec.training = rec.training || {};
      rec.training[m.id] = RN.recordRecheck(m, rec.training[m.id], (req.body || {}).day, actor, nowIso(), new Date());
      await save(rec);
      await event({ userId: rec.userId, type: 'recheck', moduleId: m.id, day: Number((req.body || {}).day), byId: actor.id, byName: actor.name });
      return res.json({ ok: true });
    } catch (e) { return send(res, e); }
  }

  // ---- shared write paths (one implementation, two doors) ----------------
  function send(res, err) {
    const status = /NOT_YOURS|OFFICE_ONLY/.test(err.code || '') ? 403 : (err.code ? 409 : 500);
    return res.status(status).json({ error: err.message, code: err.code || 'ONBOARDING_ERROR', outstanding: err.outstanding, missing: err.missing });
  }

  async function doStep(req, res, rec, actor) {
    const item = await itemFor(rec, req.params.itemId);
    if (!item) return res.status(404).json({ error: 'Unknown item.', code: 'ITEM_UNKNOWN' });
    try {
      rec.items = rec.items || {};
      rec.items[item.id] = Object.assign(rec.items[item.id] || {},
        T.recordStep(item, rec.items[item.id], req.params.index, actor, req.body || {}, nowIso()));
      await save(rec);
      await event({ userId: rec.userId, type: 'step', itemId: item.id, step: Number(req.params.index), byId: actor.id, byName: actor.name, onBehalf: actor.isOffice && item.steps[Number(req.params.index)].actor === 'NEW_HIRE' });
      await logActivity(req.user.id, req.user.name, 'onboarding_step', 'onboarding', rec.userId, { itemId: item.id, step: Number(req.params.index) });
      return res.json({ ok: true });
    } catch (e) { return send(res, e); }
  }

  async function doAck(req, res, rec, actor, version) {
    const item = await itemFor(rec, req.params.itemId);
    if (!item) return res.status(404).json({ error: 'Unknown item.', code: 'ITEM_UNKNOWN' });
    try {
      rec.items = rec.items || {};
      rec.items[item.id] = Object.assign(rec.items[item.id] || {},
        T.recordAcknowledgment(item, rec.items[item.id], req.params.ackId, version, actor, nowIso()));
      await save(rec);
      await event({ userId: rec.userId, type: 'acknowledgment', itemId: item.id, ackId: req.params.ackId, version, byId: actor.id, byName: actor.name, onBehalf: actor.isOffice });
      return res.json({ ok: true });
    } catch (e) { return send(res, e); }
  }

  async function doFile(req, res, rec, actor) {
    const item = await itemFor(rec, req.params.itemId);
    if (!item) return res.status(404).json({ error: 'Unknown item.', code: 'ITEM_UNKNOWN' });
    if (!req.file) return res.status(400).json({ error: 'Choose a file.', code: 'NO_FILE' });
    const prepared = staffDocs.prepareStaffDocument({
      buffer: req.file.buffer, fileName: req.file.originalname, detectFileType,
      maxBytes: STAFF_MAX, keyPrefix: item.id
    });
    if (!prepared.ok) return res.status(prepared.status).json({ error: prepared.error, code: prepared.code });
    let stored;
    try {
      stored = await drive.uploadStaffDocumentFile(staffFolders.folderForChapter((rec.inputs && rec.inputs.chapter) || 'C'),
        staffFolders.personFolderName(rec.userName, rec.userId), prepared.safeName, req.file.buffer, prepared.mime);
    } catch (err) {
      // A storage failure REFUSES the upload: a row pointing at nothing would
      // read as sent.
      return res.status(502).json({ error: 'We could not store that file. Please try again.', code: 'FILE_STORAGE_UNAVAILABLE',
        detail: drive.describeDriveError ? drive.describeDriveError(err).reason : null });
    }
    // The same shared row User Management already reads, so one person's
    // paperwork sits in one place whichever door it came through.
    const docId = `cgdoc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const docRows = (await db.get('caregiver_documents')) || [];
    docRows.push(staffDocs.buildStaffDocumentRow({
      id: docId, ownerId: rec.userId, ownerName: rec.userName, kind: 'clinician_onboarding',
      fileName: req.file.originalname || prepared.safeName, storedName: prepared.safeName, mime: prepared.mime,
      sizeBytes: req.file.buffer.length, driveFileId: stored.fileId || stored.id || null, driveUrl: stored.webViewLink || null,
      note: `Onboarding: ${item.title}`, status: 'received',
      uploadedById: req.user.id, uploadedByName: req.user.name || req.user.email, uploadedByOffice: actor.isOffice,
      extra: { onboarding_item_id: item.id }
    }));
    await db.set('caregiver_documents', docRows);

    rec.items = rec.items || {};
    let st = rec.items[item.id] || {};
    st.files = (st.files || []).concat([{
      id: uuidv4(), name: trim(req.file.originalname || prepared.safeName, 200),
      driveFileId: stored.fileId || stored.id || null, documentId: docId, mime: prepared.mime,
      uploadedAt: nowIso(), uploadedById: req.user.id, uploadedByName: req.user.name || req.user.email,
      filedBy: actor.isOffice ? 'OFFICE_ON_BEHALF' : 'SELF'
    }]);
    // A file answers her first open SUBMIT step, so sending the document IS
    // doing the step. Anything after it (a verification) stays open.
    const idx = item.steps.findIndex((s, i) => s.actor === 'NEW_HIRE' && s.action === 'SUBMIT' && !(st.steps || {})[i]);
    if (idx !== -1) {
      try { st = Object.assign(st, T.recordStep(item, st, idx, actor, {}, nowIso())); } catch (_) { /* the file is kept either way */ }
    }
    rec.items[item.id] = st;
    await save(rec);
    await event({ userId: rec.userId, type: 'file', itemId: item.id, byId: actor.id, byName: actor.name, onBehalf: actor.isOffice });
    return res.json({ ok: true });
  }

  // ---- Care Courses certificates (Chapter A, owner 2026-11-09) --------------
  // One certificate per course, stored like every other onboarding file. The
  // cycle is 'initial' for the 40-hour program, the calendar year for the
  // annual training. A certificate is evidence on upload; the office can send
  // one back with a reason, which reopens that course.
  function courseOf(req, res, rec) {
    if (!rec.inputs || rec.inputs.chapter !== 'A') { res.status(409).json({ error: 'Care Courses training is part of caregiver onboarding.', code: 'COURSES_NOT_ON_TRACK' }); return null; }
    const course = CC.findCourse(req.params.collectionId, req.params.courseId);
    if (!course) { res.status(404).json({ error: 'Unknown course.', code: 'COURSE_UNKNOWN' }); return null; }
    const cycle = CC.cycleFor(req.params.collectionId, today());
    return { course, cycle, col: CC.COLLECTIONS[req.params.collectionId] };
  }
  async function doCourseCert(req, res, rec, actor) {
    const c = courseOf(req, res, rec); if (!c) return;
    if (!req.file) return res.status(400).json({ error: 'Choose the certificate file.', code: 'NO_FILE' });
    const prepared = staffDocs.prepareStaffDocument({ buffer: req.file.buffer, fileName: req.file.originalname, detectFileType, maxBytes: STAFF_MAX, keyPrefix: c.course.id });
    if (!prepared.ok) return res.status(prepared.status).json({ error: prepared.error, code: prepared.code });
    let stored;
    try {
      stored = await drive.uploadStaffDocumentFile(staffFolders.folderForChapter('A'),
        staffFolders.personFolderName(rec.userName, rec.userId), prepared.safeName, req.file.buffer, prepared.mime);
    } catch (err) {
      return res.status(502).json({ error: 'We could not store that file. Please try again.', code: 'FILE_STORAGE_UNAVAILABLE',
        detail: drive.describeDriveError ? drive.describeDriveError(err).reason : null });
    }
    const docId = `cgdoc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const docRows = (await db.get('caregiver_documents')) || [];
    docRows.push(staffDocs.buildStaffDocumentRow({
      id: docId, ownerId: rec.userId, ownerName: rec.userName, kind: 'training_certificate',
      fileName: req.file.originalname || prepared.safeName, storedName: prepared.safeName, mime: prepared.mime,
      sizeBytes: req.file.buffer.length, driveFileId: stored.fileId || stored.id || null, driveUrl: stored.webViewLink || null,
      note: `Certificate: ${c.course.title} (${c.col.title}, ${c.cycle})`, status: 'received',
      uploadedById: req.user.id, uploadedByName: req.user.name || req.user.email, uploadedByOffice: actor.isOffice,
      extra: { course_collection: c.col.id, course_id: c.course.id, course_cycle: c.cycle }
    }));
    await db.set('caregiver_documents', docRows);
    rec.courseCerts = rec.courseCerts || {};
    rec.courseCerts[c.col.id] = rec.courseCerts[c.col.id] || {};
    rec.courseCerts[c.col.id][c.cycle] = rec.courseCerts[c.col.id][c.cycle] || {};
    const prev = rec.courseCerts[c.col.id][c.cycle][c.course.id] || {};
    rec.courseCerts[c.col.id][c.cycle][c.course.id] = {
      at: nowIso(), returned: null, history: prev.returned ? (prev.history || []).concat([prev.returned]) : (prev.history || []),
      files: (prev.files || []).concat([{
        id: uuidv4(), name: trim(req.file.originalname || prepared.safeName, 200), driveFileId: stored.fileId || stored.id || null,
        documentId: docId, mime: prepared.mime, uploadedAt: nowIso(), uploadedById: req.user.id,
        uploadedByName: req.user.name || req.user.email, filedBy: actor.isOffice ? 'OFFICE_ON_BEHALF' : 'SELF'
      }])
    };
    await save(rec);
    await event({ userId: rec.userId, type: 'course_certificate', collection: c.col.id, courseId: c.course.id, cycle: c.cycle, byId: actor.id, byName: actor.name, onBehalf: actor.isOffice });
    return res.json({ ok: true });
  }
  async function doCourseDownload(req, res, rec) {
    const byCycle = ((rec.courseCerts || {})[req.params.collectionId]) || {};
    const f = [].concat(...Object.values(byCycle).map(cy => ((cy[req.params.courseId] || {}).files || []))).find(x => x.id === req.params.fileId);
    if (!f) return res.status(404).json({ error: 'No such file.', code: 'FILE_UNKNOWN' });
    try {
      const buf = await drive.downloadFileBuffer(f.driveFileId);
      await logActivity(req.user.id, req.user.name, 'onboarding_file_read', 'onboarding', rec.userId, { courseId: req.params.courseId, fileId: f.id });
      res.setHeader('Content-Type', f.mime || 'application/octet-stream');
      res.setHeader('Content-Disposition', contentDisposition('inline', f.name));
      return res.send(buf);
    } catch (e) {
      return res.status(502).json({ error: 'That file could not be opened.', code: 'FILE_UNREADABLE',
        detail: drive.describeDriveError ? drive.describeDriveError(e).reason : null });
    }
  }

  async function doDownload(req, res, rec) {
    // A welcome-wizard file on a Chapter A item: only one of HER files, of a
    // kind that item names, and nothing else, can be reached this way.
    if (/^(packet|form):/.test(String(req.params.fileId || ''))) {
      const item = await itemFor(rec, req.params.itemId);
      const pk = await packetFor(rec);
      const f = welcomeFilesFor(item, pk).find(x => x.id === req.params.fileId);
      if (!f) return res.status(404).json({ error: 'No such file.', code: 'FILE_UNKNOWN' });
      try {
        let buf; let mime; let name = f.name;
        if (f.id.startsWith('packet:')) {
          const row = pk.docs.find(d => `packet:${d.id}` === f.id);
          if (!row.drive_file_id) return res.status(404).json({ error: 'No stored file is attached to that record.', code: 'DOC_FILE_MISSING' });
          buf = await drive.downloadFileBuffer(row.drive_file_id);
          mime = row.mime_type || 'application/octet-stream';
        } else {
          const kind = f.id.slice('form:'.length);
          const record = pk.atts.find(a => a.kind === kind && a.signed_at);
          buf = await welcomePacketPdf.generateSignedAttestationPDF(record, pk.user);
          mime = 'application/pdf'; name = `${name}.pdf`;
        }
        await logActivity(req.user.id, req.user.name, 'onboarding_file_read', 'onboarding', rec.userId, { itemId: req.params.itemId, fileId: f.id });
        res.setHeader('Content-Type', mime);
        res.setHeader('Content-Disposition', contentDisposition('inline', name));
        return res.send(buf);
      } catch (e) {
        return res.status(502).json({ error: 'That file could not be opened.', code: 'FILE_UNREADABLE',
          detail: drive.describeDriveError ? drive.describeDriveError(e).reason : null });
      }
    }
    const st = (rec.items || {})[req.params.itemId] || {};
    const f = (st.files || []).find(x => x.id === req.params.fileId);
    if (!f) return res.status(404).json({ error: 'No such file.', code: 'FILE_UNKNOWN' });
    try {
      const buf = await drive.downloadFileBuffer(f.driveFileId);
      await logActivity(req.user.id, req.user.name, 'onboarding_file_read', 'onboarding', rec.userId, { itemId: req.params.itemId, fileId: f.id });
      res.setHeader('Content-Type', f.mime || 'application/octet-stream');
      res.setHeader('Content-Disposition', contentDisposition('inline', f.name));
      return res.send(buf);
    } catch (e) {
      return res.status(502).json({ error: 'That file could not be opened.', code: 'FILE_UNREADABLE',
        detail: drive.describeDriveError ? drive.describeDriveError(e).reason : null });
    }
  }

  async function doNote(req, res, rec) {
    const item = await itemFor(rec, req.params.itemId);
    if (!item) return res.status(404).json({ error: 'Unknown item.', code: 'ITEM_UNKNOWN' });
    const text = trim(req.body && req.body.text, 2000);
    if (!text) return res.status(400).json({ error: 'Write a note first.', code: 'NOTE_EMPTY' });
    rec.items = rec.items || {};
    const st = rec.items[item.id] || {};
    st.notes = (st.notes || []).concat([{ id: uuidv4(), at: nowIso(), byName: req.user.name || req.user.email, office: isOffice(req.user), text }]);
    rec.items[item.id] = st;
    await save(rec);
    return res.json({ ok: true });
  }

  // ---- HER DOOR ---------------------------------------------------------------
  async function myRecord(req, res) {
    const rec = find(await all(), req.user.id);
    if (!rec) {
      res.status(404).json({ error: 'The office has not started your onboarding yet.', code: 'ONBOARDING_NOT_STARTED' });
      return null;
    }
    return rec;
  }

  router.get('/api/onboarding/me', authenticateToken, requireStaff, async (req, res) => {
    // WHO IS ASKING, answered by the server: the page draws the office view or
    // her view from this, never from the role stored in the browser.
    const viewer = { id: req.user.id, name: req.user.name || req.user.email, isOffice: isOffice(req.user) };
    const rec = find(await all(), req.user.id);
    if (!rec) return res.json({ viewer, started: false });
    const track = await buildFor(rec, 'new_hire');
    track.checks = (await settings()).checkQuestionsForStaff ? await checksFor(track) : { ok: true, byModule: {}, off: true, errors: [] };
    return res.json({ viewer, started: true, track });
  });
  router.post('/api/onboarding/me/items/:itemId/steps/:index', authenticateToken, requireStaff, async (req, res) => {
    const rec = await myRecord(req, res); if (!rec) return;
    return doStep(req, res, rec, actorOf(req));
  });
  // She acknowledges at the version the SERVER states, never one the page
  // posts: a page that could choose its version could stamp a signature on
  // text nobody showed her.
  router.post('/api/onboarding/me/items/:itemId/acknowledgments/:ackId', authenticateToken, requireStaff, async (req, res) => {
    const rec = await myRecord(req, res); if (!rec) return;
    const doc = T.ALL_ACKS.find(d => d.id === req.params.ackId);
    if (!doc) return res.status(404).json({ error: 'Unknown document.', code: 'ACK_UNKNOWN' });
    return doAck(req, res, rec, actorOf(req), doc.version);
  });
  router.post('/api/onboarding/me/items/:itemId/files', authenticateToken, requireStaff, upload.single('file'), async (req, res) => {
    const rec = await myRecord(req, res); if (!rec) return;
    return doFile(req, res, rec, actorOf(req));
  });
  router.get('/api/onboarding/me/items/:itemId/files/:fileId', authenticateToken, requireStaff, async (req, res) => {
    const rec = await myRecord(req, res); if (!rec) return;
    return doDownload(req, res, rec);
  });
  router.post('/api/onboarding/me/courses/:collectionId/:courseId/certificate', authenticateToken, requireStaff, upload.single('file'), async (req, res) => {
    const rec = await myRecord(req, res); if (!rec) return;
    return doCourseCert(req, res, rec, actorOf(req));
  });
  router.get('/api/onboarding/me/courses/:collectionId/:courseId/certificate/:fileId', authenticateToken, requireStaff, async (req, res) => {
    const rec = await myRecord(req, res); if (!rec) return;
    return doCourseDownload(req, res, rec);
  });
  router.post('/api/onboarding/me/items/:itemId/notes', authenticateToken, requireStaff, async (req, res) => {
    const rec = await myRecord(req, res); if (!rec) return;
    return doNote(req, res, rec);
  });
  // A module she attests to herself. Countersigned, observed and certificate
  // modules are signed off by the office.
  router.post('/api/onboarding/me/modules/:moduleId/complete', authenticateToken, requireStaff, async (req, res) => {
    const rec = await myRecord(req, res); if (!rec) return;
    const m = findModule(req.params.moduleId);
    if (!m) return res.status(404).json({ error: 'Unknown module.', code: 'MODULE_UNKNOWN' });
    if (!['ATTEST', 'NONE'].includes(m.signoff)) return res.status(403).json({ error: 'The office signs this module off.', code: 'MODULE_OFFICE_SIGNOFF' });
    const track = await buildFor(rec, 'new_hire');
    const row = track.modules.find(x => x.id === m.id);
    if (!row) return res.status(409).json({ error: 'This module is not part of your onboarding.', code: 'MODULE_NOT_APPLICABLE' });
    if (row.underReview) return res.status(409).json({ error: 'This module is being updated. It opens again once it is reviewed.', code: 'MODULE_UNDER_REVIEW' });
    const blocked = m.unlocksAfter.filter(id => !(track.modules.find(x => x.id === id) || {}).complete);
    if (blocked.length) return res.status(409).json({ error: 'Finish the modules before this one first.', code: 'MODULE_LOCKED', outstanding: blocked });
    rec.training = rec.training || {};
    rec.training[m.id] = { completedAt: nowIso(), version: m.version, byName: req.user.name || req.user.email, attested: true };
    await save(rec);
    await event({ userId: rec.userId, type: 'module_complete', moduleId: m.id, byId: req.user.id });
    return res.json({ ok: true });
  });
  // She records her own document's expiration date, starts its renewal, and
  // does her own spaced re-checks (Training Library TRN-406).
  router.put('/api/onboarding/me/items/:itemId/expiry', authenticateToken, requireStaff, async (req, res) => {
    const rec = await myRecord(req, res); if (!rec) return;
    return doExpiry(req, res, rec, actorOf(req));
  });
  router.post('/api/onboarding/me/items/:itemId/renew', authenticateToken, requireStaff, async (req, res) => {
    const rec = await myRecord(req, res); if (!rec) return;
    return doRenew(req, res, rec, actorOf(req));
  });
  router.post('/api/onboarding/me/modules/:moduleId/recheck', authenticateToken, requireStaff, async (req, res) => {
    const rec = await myRecord(req, res); if (!rec) return;
    return doRecheck(req, res, rec, actorOf(req));
  });

  // ---- THE OFFICE ------------------------------------------------------------
  router.get('/api/onboarding/admin/overview', authenticateToken, requireOffice, async (req, res) => {
    const rows = await all();
    const users = await getUsers();
    const m = await manual();
    const revs = await reviews();
    const packets = {};
    for (const rec of rows) packets[rec.userId] = await packetFor(rec);
    const custom = await customTasks();
    const people = rows.map(rec => {
      const t = T.buildTrack({ inputs: withPacketFacts(rec.inputs, packets[rec.userId]), record: rec, today: today(), audience: 'office', manualVersion: m.ok ? m.currentVersion : '2.2', moduleReviews: revs, packetRows: packets[rec.userId].rows, customTasks: custom });
      const u = users.find(x => String(x.id) === String(rec.userId)) || {};
      const current = t.phases.find(p => !p.complete) || null;
      const next = t.items.find(i => i.status !== T.STATUS.COMPLETE && i.status !== T.STATUS.NOT_APPLICABLE && i.next) || null;
      return {
        userId: rec.userId, name: rec.userName || u.name, credential: u.prescriberCredential || u.licenseLevel || null,
        relationship: rec.inputs.relationship || ((T.CHAPTERS[rec.inputs.chapter] || {}).CHAPTER || {}).relationship || 'W2', chapter: (rec.inputs && rec.inputs.chapter) || 'C', startDate: rec.inputs.startDate || null,
        progress: t.counts.items ? Math.round((t.counts.complete / t.counts.items) * 100) : 0,
        currentPhase: current ? { number: current.number, label: current.label } : null,
        next: next ? { title: next.title, waitingOnHer: next.next.hers, actorLabel: next.next.actorLabel } : null,
        waitingOnHer: t.counts.waitingOnHer, returned: t.counts.returned,
        waitingOnOffice: t.items.filter(i => i.next && !i.next.hers && i.status !== T.STATUS.COMPLETE && i.status !== T.STATUS.NOT_APPLICABLE).length,
        expired: t.items.filter(i => i.status === T.STATUS.EXPIRED).length,
        renewalsDue: t.counts.renewalsDue, recurringDue: t.counts.recurringDue, rechecksDue: t.counts.rechecksDue,
        updatedAt: rec.updatedAt
      };
    });
    // Clinicians with no onboarding record yet, so nobody is invisible.
    // Everyone onboarded here with no record yet, so nobody is invisible:
    // clinicians, the admin team and liaisons.
    const notStarted = users.filter(u => (u.hasClinicalAccess || ONBOARDED_TYPES.includes(accountTypes.accountTypeOf(u))) && u.accountStatus !== 'inactive' && !rows.some(r => String(r.userId) === String(u.id)))
      .map(u => ({ userId: u.id, name: u.name || u.email, chapter: defaultChapterFor(u) }));
    const flags = VF.evaluateAll(MODULES, { currentVersion: m.ok ? m.currentVersion : '2.2', reviews: revs, changeLog: m.changeLog });
    return res.json({
      people, notStarted,
      counts: {
        active: people.length,
        waitingOnOffice: people.reduce((n, p) => n + p.waitingOnOffice, 0),
        waitingOnStaff: people.reduce((n, p) => n + p.waitingOnHer, 0),
        returned: people.reduce((n, p) => n + p.returned, 0),
        expired: people.reduce((n, p) => n + p.expired, 0),
        renewalsDue: people.reduce((n, p) => n + p.renewalsDue, 0),
        recurringDue: people.reduce((n, p) => n + p.recurringDue, 0),
        modulesFlagged: flags.filter(f => f.status === VF.STATUS.FLAGGED).length
      },
      manual: { ok: !!m.ok, version: m.ok ? m.currentVersion : null, reason: m.ok ? null : m.reason },
      chapters: CHAPTER_CHOICES,
      serviceLines: C.SERVICE_LINES, determinations: C.DETERMINATIONS.map(d => ({ id: d.id, label: d.label, serviceLine: d.serviceLine }))
    });
  });

  // ---- tasks the office adds (owner, 2026-11-09) ---------------------------
  const scopeLabel = (t, users) => (t.scope.userId
    ? `Only ${((users.find(u => String(u.id) === String(t.scope.userId)) || {}).name) || 'one person'}`
    : `Everyone onboarding as ${((CHAPTER_CHOICES.find(c => c.id === t.scope.chapter) || {}).label) || t.scope.chapter}`);
  router.get('/api/onboarding/admin/custom-tasks', authenticateToken, requireOffice, async (req, res) => {
    const users = await getUsers();
    const tasks = (await customTasks()).filter(t => !t.removedAt)
      .map(t => Object.assign({}, t, { scopeLabel: scopeLabel(t, users) }));
    return res.json({ tasks, chapters: CHAPTER_CHOICES });
  });
  router.post('/api/onboarding/admin/custom-tasks', authenticateToken, requireOffice, async (req, res) => {
    const b = req.body || {};
    const title = trim(b.title, 200);
    if (!title) return res.status(400).json({ error: 'Give the task a name.', code: 'TASK_TITLE_REQUIRED' });
    const sc = b.scope || {};
    let scope;
    if (sc.userId) {
      const u = (await getUsers()).find(x => String(x.id) === String(sc.userId));
      const rows = await all();
      if (!u || !(u.hasClinicalAccess || isOffice(u) || ONBOARDED_TYPES.includes(accountTypes.accountTypeOf(u)) || find(rows, u.id))) {
        return res.status(400).json({ error: 'That person is not on staff onboarding.', code: 'TASK_PERSON_UNKNOWN' });
      }
      scope = { userId: String(u.id) };
    } else if (CHAPTER_CHOICES.some(c => c.id === sc.chapter)) {
      scope = { chapter: sc.chapter };
    } else {
      return res.status(400).json({ error: 'Choose who gets this task: one person, or everyone of a type.', code: 'TASK_SCOPE_REQUIRED' });
    }
    const task = { id: `GFC-${uuidv4().replace(/-/g, '').slice(0, 8)}`, title, details: trim(b.details, 2000) || null, scope,
      review: !!b.review, askForFile: !!b.askForFile, createdById: String(req.user.id), createdByName: req.user.name || req.user.email,
      createdAt: nowIso(), removedAt: null };
    const rows = await customTasks(); rows.push(task); await db.set(CUSTOM, rows);
    await event({ userId: scope.userId || null, type: 'custom_task_added', taskId: task.id, scope, byId: req.user.id, byName: req.user.name });
    await logActivity(req.user.id, req.user.name, 'onboarding_task_added', 'onboarding', scope.userId || scope.chapter, { taskId: task.id });
    return res.json({ ok: true, task });
  });
  // Removing takes it off every checklist; the row and what anyone recorded stay.
  router.delete('/api/onboarding/admin/custom-tasks/:taskId', authenticateToken, requireOffice, async (req, res) => {
    const rows = await customTasks();
    const t = rows.find(x => x.id === req.params.taskId && !x.removedAt);
    if (!t) return res.status(404).json({ error: 'No such task.', code: 'TASK_UNKNOWN' });
    t.removedAt = nowIso(); t.removedById = String(req.user.id); t.removedByName = req.user.name || req.user.email;
    await db.set(CUSTOM, rows);
    await event({ userId: t.scope.userId || null, type: 'custom_task_removed', taskId: t.id, byId: req.user.id, byName: req.user.name });
    await logActivity(req.user.id, req.user.name, 'onboarding_task_removed', 'onboarding', t.scope.userId || t.scope.chapter, { taskId: t.id });
    return res.json({ ok: true });
  });

  async function personRecord(req, res, { create = false } = {}) {
    const rows = await all();
    let rec = find(rows, req.params.userId);
    if (!rec && create) {
      const u = (await getUsers()).find(x => String(x.id) === String(req.params.userId));
      if (!u) { res.status(404).json({ error: 'No such person.', code: 'PERSON_UNKNOWN' }); return null; }
      rec = { id: uuidv4(), userId: String(u.id), userName: u.name || u.email, createdAt: nowIso(), inputs: T.normalizeInputs({ chapter: defaultChapterFor(u) }), items: {}, training: {}, determinations: {} };
    }
    if (!rec) { res.status(404).json({ error: 'Onboarding has not been started for this person.', code: 'ONBOARDING_NOT_STARTED' }); return null; }
    return rec;
  }

  router.get('/api/onboarding/admin/people/:userId', authenticateToken, requireOffice, async (req, res) => {
    const rec = await personRecord(req, res); if (!rec) return;
    const track = await buildFor(rec, 'office');
    const events = ((await db.get(EVENTS)) || []).filter(e => String(e.userId) === String(rec.userId)).slice(-100).reverse();
    return res.json({ track, events });
  });
  // Starts onboarding (creates the record) or changes what she will cover.
  router.put('/api/onboarding/admin/people/:userId/inputs', authenticateToken, requireOffice, async (req, res) => {
    const rec = await personRecord(req, res, { create: true }); if (!rec) return;
    const before = rec.inputs;
    // The chapter: what the office chose, else what the record already has,
    // else what the person's account type implies.
    const u = (await getUsers()).find(x => String(x.id) === String(rec.userId));
    const chapter = (req.body && req.body.chapter) || (before && before.chapter) || defaultChapterFor(u);
    rec.inputs = Object.assign(T.normalizeInputs(Object.assign({}, req.body || {}, { chapter, holdsCareCertificate: false, licenseLevel: null })), { relationship: (T.CHAPTERS[chapter] && T.CHAPTERS[chapter].CHAPTER.relationship) || 'W2' });
    await save(rec);
    await event({ userId: rec.userId, type: 'inputs', byId: req.user.id, byName: req.user.name, before, after: rec.inputs });
    return res.json({ ok: true });
  });
  router.post('/api/onboarding/admin/people/:userId/items/:itemId/steps/:index', authenticateToken, requireOffice, async (req, res) => {
    const rec = await personRecord(req, res); if (!rec) return;
    return doStep(req, res, rec, officeActorOf(req));
  });
  router.post('/api/onboarding/admin/people/:userId/items/:itemId/return', authenticateToken, requireOffice, async (req, res) => {
    const rec = await personRecord(req, res); if (!rec) return;
    const item = await itemFor(rec, req.params.itemId);
    if (!item) return res.status(404).json({ error: 'Unknown item.', code: 'ITEM_UNKNOWN' });
    try {
      rec.items[item.id] = Object.assign(rec.items[item.id] || {},
        T.returnStep(item, rec.items[item.id], (req.body || {}).step, officeActorOf(req), (req.body || {}).reason, nowIso()));
      await save(rec);
      await event({ userId: rec.userId, type: 'returned', itemId: item.id, byId: req.user.id, byName: req.user.name });
      return res.json({ ok: true });
    } catch (e) { return send(res, e); }
  });
  router.put('/api/onboarding/admin/people/:userId/items/:itemId/expiry', authenticateToken, requireOffice, async (req, res) => {
    const rec = await personRecord(req, res); if (!rec) return;
    return doExpiry(req, res, rec, officeActorOf(req));
  });
  router.post('/api/onboarding/admin/people/:userId/items/:itemId/renew', authenticateToken, requireOffice, async (req, res) => {
    const rec = await personRecord(req, res); if (!rec) return;
    return doRenew(req, res, rec, officeActorOf(req));
  });
  router.post('/api/onboarding/admin/people/:userId/modules/:moduleId/recheck', authenticateToken, requireOffice, async (req, res) => {
    const rec = await personRecord(req, res); if (!rec) return;
    return doRecheck(req, res, rec, officeActorOf(req));
  });
  // The C.9 recurring duties are the office's to record (credentialing owner,
  // delegating physician, Clinical Director).
  router.post('/api/onboarding/admin/people/:userId/recurring/:recurringId', authenticateToken, requireOffice, async (req, res) => {
    const rec = await personRecord(req, res); if (!rec) return;
    try {
      const next = RN.recordRecurring(req.params.recurringId, rec, String((req.body || {}).doneOn || ''), officeActorOf(req), nowIso());
      rec.recurring = next.recurring;
      await save(rec);
      await event({ userId: rec.userId, type: 'recurring_done', recurringId: req.params.recurringId, doneOn: req.body.doneOn, byId: req.user.id, byName: req.user.name });
      return res.json({ ok: true });
    } catch (e) { return send(res, e); }
  });
  router.post('/api/onboarding/admin/people/:userId/items/:itemId/not-applicable', authenticateToken, requireOffice, async (req, res) => {
    const rec = await personRecord(req, res); if (!rec) return;
    const item = await itemFor(rec, req.params.itemId);
    if (!item) return res.status(404).json({ error: 'Unknown item.', code: 'ITEM_UNKNOWN' });
    const reason = trim(req.body && req.body.reason, 1000);
    if (!reason) return res.status(400).json({ error: 'Say why this does not apply.', code: 'NA_REASON_REQUIRED' });
    rec.items[item.id] = Object.assign(rec.items[item.id] || {}, { notApplicable: { at: nowIso(), byName: req.user.name || req.user.email, reason } });
    await save(rec);
    await event({ userId: rec.userId, type: 'not_applicable', itemId: item.id, byId: req.user.id, reason });
    return res.json({ ok: true });
  });
  // Filed on her behalf: a copy she signed elsewhere (in Gusto, say) at the
  // version printed on it. An older version reads stale, never complete.
  router.post('/api/onboarding/admin/people/:userId/items/:itemId/acknowledgments/:ackId', authenticateToken, requireOffice, async (req, res) => {
    const rec = await personRecord(req, res); if (!rec) return;
    const doc = T.ALL_ACKS.find(d => d.id === req.params.ackId);
    if (!doc) return res.status(404).json({ error: 'Unknown document.', code: 'ACK_UNKNOWN' });
    return doAck(req, res, rec, officeActorOf(req), trim((req.body || {}).version, 20) || doc.version);
  });
  router.post('/api/onboarding/admin/people/:userId/items/:itemId/files', authenticateToken, requireOffice, upload.single('file'), async (req, res) => {
    const rec = await personRecord(req, res); if (!rec) return;
    return doFile(req, res, rec, officeActorOf(req));
  });
  router.get('/api/onboarding/admin/people/:userId/items/:itemId/files/:fileId', authenticateToken, requireOffice, async (req, res) => {
    const rec = await personRecord(req, res); if (!rec) return;
    return doDownload(req, res, rec);
  });
  router.post('/api/onboarding/admin/people/:userId/courses/:collectionId/:courseId/certificate', authenticateToken, requireOffice, upload.single('file'), async (req, res) => {
    const rec = await personRecord(req, res); if (!rec) return;
    return doCourseCert(req, res, rec, officeActorOf(req));
  });
  router.get('/api/onboarding/admin/people/:userId/courses/:collectionId/:courseId/certificate/:fileId', authenticateToken, requireOffice, async (req, res) => {
    const rec = await personRecord(req, res); if (!rec) return;
    return doCourseDownload(req, res, rec);
  });
  // Send a certificate back (wrong course, unreadable): the course reopens.
  router.post('/api/onboarding/admin/people/:userId/courses/:collectionId/:courseId/return', authenticateToken, requireOffice, async (req, res) => {
    const rec = await personRecord(req, res); if (!rec) return;
    const c = courseOf(req, res, rec); if (!c) return;
    const reason = trim((req.body || {}).reason, 500);
    if (!reason) return res.status(400).json({ error: 'Say why it is being sent back.', code: 'RETURN_REASON_REQUIRED' });
    const row = ((((rec.courseCerts || {})[c.col.id] || {})[c.cycle]) || {})[c.course.id];
    if (!row || !(row.files || []).length) return res.status(404).json({ error: 'No certificate on file for this course.', code: 'CERT_NONE' });
    row.returned = { at: nowIso(), byName: req.user.name || req.user.email, reason };
    await save(rec);
    await event({ userId: rec.userId, type: 'course_certificate_returned', collection: c.col.id, courseId: c.course.id, cycle: c.cycle, byId: req.user.id, byName: req.user.name, reason });
    return res.json({ ok: true });
  });
  router.post('/api/onboarding/admin/people/:userId/items/:itemId/notes', authenticateToken, requireOffice, async (req, res) => {
    const rec = await personRecord(req, res); if (!rec) return;
    return doNote(req, res, rec);
  });
  // The office signs a module off (countersign, observed, certificate) or
  // records it for her.
  router.post('/api/onboarding/admin/people/:userId/modules/:moduleId/complete', authenticateToken, requireOffice, async (req, res) => {
    const rec = await personRecord(req, res); if (!rec) return;
    const m = findModule(req.params.moduleId);
    if (!m) return res.status(404).json({ error: 'Unknown module.', code: 'MODULE_UNKNOWN' });
    rec.training = rec.training || {};
    rec.training[m.id] = { completedAt: nowIso(), version: m.version, byName: req.user.name || req.user.email, signedOffByOffice: true, note: trim((req.body || {}).note, 500) || null };
    await save(rec);
    await event({ userId: rec.userId, type: 'module_signoff', moduleId: m.id, byId: req.user.id, byName: req.user.name });
    return res.json({ ok: true });
  });
  router.post('/api/onboarding/admin/people/:userId/determinations/:detId', authenticateToken, requireOffice, async (req, res) => {
    const rec = await personRecord(req, res); if (!rec) return;
    try {
      const m = await manual();
      const flags = Object.fromEntries(VF.evaluateAll(MODULES, { currentVersion: m.ok ? m.currentVersion : '2.2', reviews: await reviews(), changeLog: m.changeLog }).map(f => [f.moduleId, f]));
      const opened = T.openDetermination(req.params.detId, rec.inputs, rec, req.body || {}, officeActorOf(req), flags, nowIso());
      rec.determinations = rec.determinations || {};
      const key = opened.payer ? `${req.params.detId}:${opened.payer}` : req.params.detId;
      rec.determinations[key] = opened;
      await save(rec);
      await event({ userId: rec.userId, type: 'determination', detId: req.params.detId, payer: opened.payer, byId: req.user.id, byName: req.user.name });
      await logActivity(req.user.id, req.user.name, 'onboarding_determination', 'onboarding', rec.userId, { detId: req.params.detId, payer: opened.payer });
      return res.json({ ok: true, opened });
    } catch (e) { return send(res, e); }
  });

  // ---- the training library (office) --------------------------------------
  router.get('/api/onboarding/admin/library', authenticateToken, requireOffice, async (req, res) => {
    const m = await manual();
    const revs = await reviews();
    const flags = Object.fromEntries(VF.evaluateAll(MODULES, { currentVersion: m.ok ? m.currentVersion : '2.2', reviews: revs, changeLog: m.changeLog }).map(f => [f.moduleId, f]));
    return res.json({
      settings: await settings(),
      manual: { ok: !!m.ok, version: m.ok ? m.currentVersion : null, reason: m.ok ? null : m.reason },
      modules: MODULES.map(x => ({
        id: x.id, title: x.title, phase: x.phase, phaseLabel: (C.PHASES.find(p => p.id === x.phase) || {}).label, phaseNumber: (C.PHASES.find(p => p.id === x.phase) || {}).number,
        format: x.format, minutes: x.minutes, host: x.host, signoff: x.signoff,
        manualRefs: x.manualRefs, proposedManualRefs: x.proposedManualRefs, proposedBasis: x.proposedBasis,
        plannedSop: x.plannedSop, flag: flags[x.id], review: revs[x.id] || null
      }))
    });
  });
  router.put('/api/onboarding/admin/settings', authenticateToken, requireOffice, async (req, res) => {
    const next = Object.assign(await settings(), { checkQuestionsForStaff: req.body && req.body.checkQuestionsForStaff === true,
      updatedAt: nowIso(), updatedByName: req.user.name || req.user.email });
    await db.set(SETTINGS, next);
    await logActivity(req.user.id, req.user.name, 'onboarding_settings_changed', 'onboarding_settings', null, { checkQuestionsForStaff: next.checkQuestionsForStaff });
    return res.json(next);
  });
  // The Clinical Director records a review against the current manual, which
  // clears a flag; or confirms a module's drafted manual sections, which makes
  // them drive the flag from then on.
  router.post('/api/onboarding/admin/library/:moduleId/review', authenticateToken, requireOffice, async (req, res) => {
    const m = findModule(req.params.moduleId);
    if (!m) return res.status(404).json({ error: 'Unknown module.', code: 'MODULE_UNKNOWN' });
    const man = await manual();
    if (!man.ok) return res.status(409).json({ error: 'The manual could not be read from Drive, so its version is unknown.', code: 'MANUAL_UNREADABLE' });
    const revs = await reviews();
    const body = req.body || {};
    const entry = Object.assign({}, revs[m.id] || {}, { reviewedAgainst: man.currentVersion, reviewedAt: nowIso(), reviewedByName: req.user.name || req.user.email });
    if (Array.isArray(body.confirmedManualRefs)) {
      const refs = body.confirmedManualRefs.map(String).filter(Boolean);
      try { refs.forEach(r => VF.refCovers(r, '1')); } catch (e) { return res.status(400).json({ error: e.message, code: 'REF_INVALID' }); }
      entry.confirmedManualRefs = refs;
    }
    revs[m.id] = entry;
    await db.set(REVIEWS, revs);
    await logActivity(req.user.id, req.user.name, 'onboarding_module_review', 'onboarding', m.id, { reviewedAgainst: man.currentVersion });
    return res.json({ ok: true, review: entry });
  });

  return router;
};

module.exports.COLLECTIONS = { RECORDS, EVENTS, REVIEWS };
