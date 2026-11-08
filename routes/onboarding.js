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
const C = require('../onboarding/chapterC');
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
const MAX_BYTES = 15 * 1024 * 1024;

module.exports = function createOnboardingRoutes(deps) {
  const { db, config, logActivity, getUsers, authenticateToken, drive, detectFileType, uuidv4 } = deps;
  const router = express.Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES } });
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
  const requireStaff = (req, res, next) => (req.user && (req.user.hasClinicalAccess || isOffice(req.user)) ? next()
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

  // The manual version and change log, read from Drive. A Drive failure never
  // blocks onboarding: the version flag falls back to the seeded change list
  // and the office is told the manual could not be read.
  async function manual() {
    try { return await loader.manualState(); } catch (e) { return { ok: false, reason: e.message, changeLog: VF.SEEDED_CHANGES.slice() }; }
  }

  async function buildFor(rec, audience) {
    const m = await manual();
    const track = T.buildTrack({
      inputs: rec.inputs, record: rec, today: today(), audience,
      manualVersion: m.ok ? m.currentVersion : '2.2',
      moduleReviews: await reviews(),
      legacy: await legacyFor(rec.userId)
    });
    // Acknowledged documents link their canonical Drive copy.
    track.items.forEach(it => {
      (it.acknowledgments || []).forEach(a => {
        const doc = C.ACKNOWLEDGMENTS.find(d => d.id === a.id);
        a.links = (doc.driveFileIds || []).map(id => `https://drive.google.com/file/d/${id}/view`);
      });
      // Files: our own ids only. A Drive id never leaves the server.
      const st = (rec.items || {})[it.id] || {};
      it.files = (st.files || []).map(f => ({ id: f.id, name: f.name, uploadedAt: f.uploadedAt, uploadedByName: f.uploadedByName, filedBy: f.filedBy }));
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
    const item = T.findItem(req.params.itemId);
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
    const item = T.findItem(req.params.itemId);
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
    const item = T.findItem(req.params.itemId);
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
    const item = T.findItem(req.params.itemId);
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
    const item = T.findItem(req.params.itemId);
    if (!item) return res.status(404).json({ error: 'Unknown item.', code: 'ITEM_UNKNOWN' });
    if (!req.file) return res.status(400).json({ error: 'Choose a file.', code: 'NO_FILE' });
    const prepared = staffDocs.prepareStaffDocument({
      buffer: req.file.buffer, fileName: req.file.originalname, detectFileType,
      maxBytes: (config && config.MAX_FILE_SIZE) || MAX_BYTES, keyPrefix: item.id
    });
    if (!prepared.ok) return res.status(prepared.status).json({ error: prepared.error, code: prepared.code });
    let stored;
    try {
      stored = await drive.uploadStaffDocumentFile(staffFolders.folderForChapter('C'),
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

  async function doDownload(req, res, rec) {
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
    const item = T.findItem(req.params.itemId);
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
    const doc = C.ACKNOWLEDGMENTS.find(d => d.id === req.params.ackId);
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
    const people = rows.map(rec => {
      const t = T.buildTrack({ inputs: rec.inputs, record: rec, today: today(), audience: 'office', manualVersion: m.ok ? m.currentVersion : '2.2', moduleReviews: revs });
      const u = users.find(x => String(x.id) === String(rec.userId)) || {};
      const current = t.phases.find(p => !p.complete) || null;
      const next = t.items.find(i => i.status !== T.STATUS.COMPLETE && i.status !== T.STATUS.NOT_APPLICABLE && i.next) || null;
      return {
        userId: rec.userId, name: rec.userName || u.name, credential: u.prescriberCredential || u.licenseLevel || null,
        relationship: rec.inputs.relationship || 'W2', chapter: 'C', startDate: rec.inputs.startDate || null,
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
    const notStarted = users.filter(u => u.hasClinicalAccess && u.accountStatus !== 'inactive' && !rows.some(r => String(r.userId) === String(u.id)))
      .map(u => ({ userId: u.id, name: u.name || u.email }));
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
      serviceLines: C.SERVICE_LINES, determinations: C.DETERMINATIONS.map(d => ({ id: d.id, label: d.label, serviceLine: d.serviceLine }))
    });
  });

  async function personRecord(req, res, { create = false } = {}) {
    const rows = await all();
    let rec = find(rows, req.params.userId);
    if (!rec && create) {
      const u = (await getUsers()).find(x => String(x.id) === String(req.params.userId));
      if (!u) { res.status(404).json({ error: 'No such person.', code: 'PERSON_UNKNOWN' }); return null; }
      rec = { id: uuidv4(), userId: String(u.id), userName: u.name || u.email, createdAt: nowIso(), inputs: T.normalizeInputs({}), items: {}, training: {}, determinations: {} };
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
    rec.inputs = Object.assign(T.normalizeInputs(req.body || {}), { relationship: 'W2' });
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
    const item = T.findItem(req.params.itemId);
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
    const item = T.findItem(req.params.itemId);
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
    const doc = C.ACKNOWLEDGMENTS.find(d => d.id === req.params.ackId);
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
