// ============================================================================
// CLINICIAN ONBOARDING ROUTES
// The wizard a clinician works through, and the roster the office works from.
// ============================================================================
// TWO DOORS, ONE STORE. `/me` is hers and resolves the clinician FROM THE
// SESSION — there is no userId parameter on any `/me` route, so nobody can read
// or write somebody else's track through it, which is the rule every caregiver
// route already follows. `/admin` is the office's and takes the userId in the
// path.
//
// WHAT SHE OWES AND WHAT WE OWE ARE DIFFERENT WRITES. She marks her own items
// SUBMITTED; only the office marks one COMPLETE on a verified source, with the
// source and the date stored. A clinician cannot verify her own licence, so the
// route refuses it by name rather than quietly recording it.
// ============================================================================

'use strict';

const express = require('express');
const multer = require('multer');
const T = require('../clinicianTrack');
const TR = require('../clinicianTraining');
const RES = require('../clinicianResources');
const PRV = require('../clinicianPrivileges');
// The one place a Content-Disposition header is built. A macOS screenshot
// filename carries a narrow no-break space, which res.setHeader throws on.
const { contentDisposition } = require('../contentDisposition');
// ONE declaration of what a valid staff document upload is, shared with the
// caregiver document route. See staffDocuments.js for why the launch board's
// own task-file upload is deliberately not folded in.
const staffDocs = require('../staffDocuments');

const MAX_PROOF_BYTES = 15 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_PROOF_BYTES } });

const COLLECTION = 'clinician_onboarding';
const EVENTS = 'clinician_onboarding_events';

module.exports = function createClinicianOnboardingRoutes(deps) {
  const {
    db, config, logActivity, getUsers, authenticateToken, drive, detectFileType, hashIp, uuidv4
  } = deps;
  const router = express.Router();
  const nowIso = () => new Date().toISOString();
  const trim = (v, n = 2000) => String(v === undefined || v === null ? '' : v).trim().slice(0, n);

  // ---- who may do what ----------------------------------------------------
  // An admin or a manager runs credentialing. Deliberately NOT the clinical
  // write gate: credentialing is office work, and a provider must not be able to
  // verify their own licence or sign their own gate open.
  const isOffice = (u) => !!u && (u.role === 'admin' || u.isManager === true);
  const requireOffice = (req, res, next) => {
    if (isOffice(req.user)) return next();
    return res.status(403).json({
      error: 'Credentialing is handled by the office.', code: 'ONBOARDING_OFFICE_ONLY'
    });
  };
  // Her own wizard. Any clinical account reaches it; a record is created on
  // first read so she is never looking at a page that cannot save.
  const requireClinician = (req, res, next) => {
    if (req.user && (req.user.hasClinicalAccess || isOffice(req.user))) return next();
    return res.status(403).json({
      error: 'This is the clinician onboarding area.', code: 'ONBOARDING_NOT_CLINICAL'
    });
  };

  // ---- store --------------------------------------------------------------
  const allRecords = async () => (await db.get(COLLECTION)) || [];
  const saveRecords = async (rows) => { await db.set(COLLECTION, rows); };

  const blankRecord = (user) => ({
    id: uuidv4(), userId: String(user.id), userName: user.name || user.email || null,
    createdAt: nowIso(), updatedAt: nowIso(),
    inputs: { roles: [], relationship: null, lanes: [], addons: [], contractors: [], payers: [] },
    items: {}, payerItems: {}, signatures: {}, training: {},
    gates: {}, payerGates: {}, privileges: null, accessFailures: {}
  });

  const findRecord = (rows, userId) => rows.find(r => String(r.userId) === String(userId)) || null;

  async function recordFor(user, { create = true } = {}) {
    const rows = await allRecords();
    let rec = findRecord(rows, user.id);
    if (!rec && create) {
      rec = blankRecord(user);
      rows.push(rec);
      await saveRecords(rows);
    }
    return rec;
  }

  // The physician's own evaluated track, because G2 depends on a DIFFERENT
  // PERSON'S G-MD. This is the one cross-person gate in the app, so it is
  // resolved here rather than guessed at by the screen.
  async function supervisorFor(rec, rows, users) {
    const supId = rec && rec.inputs && rec.inputs.supervisorUserId;
    if (!supId) return null;
    const supRec = findRecord(rows, supId);
    const supUser = (users || []).find(u => String(u.id) === String(supId)) || null;
    if (!supRec) {
      return { name: supUser ? (supUser.name || supUser.email) : null, gates: {} };
    }
    return {
      userId: supId,
      name: supUser ? (supUser.name || supUser.email) : supRec.userName,
      gates: T.gateStatus({ inputs: supRec.inputs, record: supRec })
    };
  }

  async function appendEvent(row) {
    const rows = (await db.get(EVENTS)) || [];
    rows.push(Object.assign({ id: uuidv4(), at: nowIso() }, row));
    await db.set(EVENTS, rows);
  }

  /**
   * WHAT A CLINICIAN READING HER OWN SCREEN IS NOT SHOWN.
   *
   * Every one of these is credentialing-file vocabulary. They are not secrets
   * — she could ask and we would tell her — they are simply the office's own
   * working notes, and a screen that shows them reads as somebody else's
   * admin tool rather than as her own onboarding:
   *
   *   proof / verify   what evidence the office files and where it is checked
   *   ownerRoleLabel   the internal role that owns the item, "Credentialing
   *                    Owner" and the like. She needs "you" or "the office".
   *   gates/feedsGate  raw gate codes (G0, G2). Titles are sent instead.
   *   checksMissing    OUR content gap — a module whose check questions are
   *                    not written yet. Telling her that is telling her about
   *                    a job of ours in the middle of a job of hers.
   *
   * FILTERED HERE, NOT HIDDEN IN THE PAGE. The page and the server would be
   * two rules, and the day they disagree is the day an internal flag renders.
   * A field she is never sent cannot be rendered by a pill a later session
   * adds — the same reason patientPublish.js filters at read time.
   *
   * It is a DENY LIST on purpose, so a field added to an item next session
   * reaches her by default and is dropped only deliberately. The alternative
   * — an allow list — silently hides new work from the person doing it, and
   * the failure is invisible: she just never sees the item's instructions.
   */
  const CLINICIAN_HIDDEN_ITEM_FIELDS = [
    'proof', 'verify', 'alsoVerify', 'ownerRole', 'ownerRoleLabel', 'gates'
  ];
  const CLINICIAN_HIDDEN_MODULE_FIELDS = ['checksMissing', 'feedsGate'];

  const stripFields = (obj, fields) => {
    if (!obj || typeof obj !== 'object') return obj;
    const out = Object.assign({}, obj);
    fields.forEach(f => { delete out[f]; });
    return out;
  };
  const stripEach = (arr, fields) =>
    Array.isArray(arr) ? arr.map(r => stripFields(r, fields)) : arr;

  function forClinician(payload) {
    // Deep-copied first: `rows`, `byPhase[].modules` and `upNext` are the same
    // objects in the builders' own output, so stripping one in place would
    // strip the others by accident — and relying on that is relying on an
    // aliasing detail a later refactor is free to change.
    const p = JSON.parse(JSON.stringify(payload));

    if (p.track) {
      p.track.rows = stripEach(p.track.rows, CLINICIAN_HIDDEN_ITEM_FIELDS);
      // A gate's own code stays: it is the React key and the route parameter.
      // What goes is the code list of the gates it waits on, which the page
      // renders as titles instead -- "Waiting on G0 and G_MD first" is a
      // sentence about our data model.
      Object.values(p.track.gates || {}).forEach(g => {
        g.blockedBy = stripEach(g.blockedBy, CLINICIAN_HIDDEN_ITEM_FIELDS);
      });
      (p.track.payerGates || []).forEach(pg => {
        pg.blockedBy = stripEach(pg.blockedBy, CLINICIAN_HIDDEN_ITEM_FIELDS);
      });
    }

    if (p.training) {
      p.training.rows = stripEach(p.training.rows, CLINICIAN_HIDDEN_MODULE_FIELDS);
      p.training.upNext = stripEach(p.training.upNext, CLINICIAN_HIDDEN_MODULE_FIELDS);
      (p.training.byPhase || []).forEach(ph => {
        ph.modules = stripEach(ph.modules, CLINICIAN_HIDDEN_MODULE_FIELDS);
      });
      // The COUNT of modules whose questions are not written is the office's
      // own backlog figure. It has no place in her progress numbers.
      if (p.training.counts) delete p.training.counts.checksMissing;
    }

    if (p.ongoing) {
      p.ongoing.items = stripEach(p.ongoing.items, CLINICIAN_HIDDEN_ITEM_FIELDS);
    }
    return p;
  }

  // ---- the whole picture for one person -----------------------------------
  //
  // `audience` DEFAULTS TO 'clinician', the narrower of the two, so a route
  // added later that forgets to say shows the office slightly less than it
  // should — which somebody notices and fixes — rather than showing a
  // clinician the credentialing file, which nobody notices at all.
  async function assemble(rec, { viewer, users, rows, audience = 'clinician' }) {
    const supervisor = await supervisorFor(rec, rows, users);
    const track = T.buildTrack({
      inputs: rec.inputs, record: rec, supervisor, viewer
    });
    const training = TR.buildTraining({ inputs: track.inputs, progress: rec.training });
    const resources = RES.buildResources({
      inputs: track.inputs, signatures: rec.signatures, accessFailures: rec.accessFailures
    });
    // WHERE A DOCUMENT GOES BACK. A few resources are "complete it outside the
    // app, then upload it" — and the document list had no file input at all,
    // so that read as a dead end. The upload door already exists on the
    // checklist item that owns the resource, so each one is pointed at its
    // item rather than growing a SECOND upload path with its own copy of the
    // byte-typing, the size ceiling and the Drive failure rule. Two copies of
    // "what a valid upload is" is how one door starts accepting what the other
    // refuses — the rule the client document exchange settled.
    (resources.byStep || []).forEach(step => {
      (step.resources || []).forEach(r => {
        const owner = T.ITEM_LIBRARY.find(it => (it.resources || []).includes(r.id));
        r.uploadItem = owner ? { id: owner.id, title: owner.title } : null;
      });
    });

    const privileges = PRV.buildPrivileges({
      inputs: track.inputs, list: rec.privileges,
      agreementVersion: rec.privileges && rec.privileges.agreement
        ? rec.privileges.agreement.version : null
    });
    const payload = {
      userId: rec.userId, userName: rec.userName,
      updatedAt: rec.updatedAt,
      track, training, resources, privileges,
      ongoing: T.ongoingSchedule({ inputs: rec.inputs, record: rec }),
      supervisor: supervisor ? {
        userId: supervisor.userId || null, name: supervisor.name,
        physicianReady: !!(supervisor.gates && supervisor.gates.G_MD && supervisor.gates.G_MD.opened)
      } : null
    };
    return audience === 'office' ? payload : forClinician(payload);
  }

  // ---- META: the vocabulary, served ---------------------------------------
  // The page names no role, relationship, lane, add-on, item, module, resource
  // or privilege of its own. A screen that restates the vocabulary drifts from
  // the validator that refuses an answer it did not offer — build-enforced.
  router.get('/api/clinician-onboarding/meta', authenticateToken, requireClinician, (req, res) => {
    res.json({
      // Who is asking, answered by the SERVER. `/api/gfc/me` is the client and
      // family surface and refuses every other role, so the page cannot learn
      // this from there — and reading it out of the browser's stored login would
      // mean a role narrowed this morning keeps its buttons until the next
      // sign-in, which is the trap req.user.clinicalRole was fixed for in 4.8.
      viewer: {
        id: String(req.user.id),
        name: req.user.name || req.user.email,
        isOffice: isOffice(req.user),
        hasClinicalAccess: !!req.user.hasClinicalAccess
      },
      roles: T.ALL_ROLES.map(v => ({ value: v, label: T.ROLE_LABELS[v] })),
      relationships: T.ALL_RELATIONSHIPS.map(v => ({ value: v, label: T.RELATIONSHIP_LABELS[v] })),
      lanes: T.ALL_LANES.map(v => ({ value: v, label: T.LANE_LABELS[v] })),
      addons: T.ALL_ADDONS.map(v => ({ value: v, label: T.ADDON_LABELS[v] })),
      reservedRoles: T.RESERVED_ROLES,
      gates: T.GATES, gatesByFamily: T.GATES_BY_FAMILY,
      owners: T.OWNER_LABELS, ownerRoles: T.OWNER_ROLE_LABELS,
      cadences: T.CADENCES, verifySources: T.VERIFY_SOURCES,
      blockTitles: T.BLOCK_TITLES, blockOrder: T.BLOCK_ORDER,
      itemStatuses: T.ITEM_STATUSES,
      resourceActions: RES.ACTION_LABELS, resourceSteps: RES.STEP_TITLES,
      trainingPhases: TR.PHASE_TITLES, trainingPhaseWhen: TR.PHASE_WHEN,
      trainingFormats: TR.FORMAT_LABELS, trainingSignoffs: TR.SIGNOFF_LABELS,
      privilegeCategories: PRV.CATEGORIES, privilegeStatuses: PRV.STATUS,
      focusedReview: PRV.FOCUSED_REVIEW,
      withheldDocuments: RES.WITHHELD
    });
  });

  // ---- HER OWN WIZARD -----------------------------------------------------
  router.get('/api/clinician-onboarding/me', authenticateToken, requireClinician, async (req, res) => {
    try {
      const rec = await recordFor(req.user);
      const rows = await allRecords();
      const users = await getUsers();
      res.json(await assemble(rec, { viewer: req.user, users, rows }));
    } catch (e) {
      console.error('clinician onboarding me:', e.message);
      res.status(500).json({ error: 'Could not load your onboarding.', code: 'ONBOARDING_READ_FAILED' });
    }
  });

  /**
   * She marks one of her own items done.
   *
   * SUBMITTED, never COMPLETE, on anything the office verifies against a
   * primary source. She cannot verify her own licence, and recording her say-so
   * as a verification would put an unchecked fact behind a gate.
   */
  router.put('/api/clinician-onboarding/me/items/:itemId', authenticateToken, requireClinician,
    async (req, res) => {
      try {
        const item = T.findItem(req.params.itemId);
        if (!item) return res.status(404).json({ error: 'Unknown item.', code: 'ITEM_UNKNOWN' });
        const rows = await allRecords();
        let rec = findRecord(rows, req.user.id);
        if (!rec) { rec = blankRecord(req.user); rows.push(rec); }
        if (!T.itemApplies(item, rec.inputs)) {
          return res.status(409).json({
            error: 'That item is not on your checklist.', code: 'ITEM_NOT_ON_TRACK'
          });
        }
        if (item.owner !== T.OWNERS.CLINICIAN && item.owner !== T.OWNERS.SELF_PACED) {
          return res.status(403).json({
            error: `${item.title} is ours to complete, not yours. It will show as done once the office records it.`,
            code: 'ITEM_NOT_YOURS'
          });
        }
        const prev = rec.items[item.id] || {};
        // Verified items wait on the office. Everything else she owns outright.
        const needsOfficeCheck = item.action === T.ACTIONS.VERIFY || !!item.verify;
        rec.items[item.id] = Object.assign({}, prev, {
          status: needsOfficeCheck ? 'submitted' : 'complete',
          at: nowIso(),
          completedAt: needsOfficeCheck ? null : nowIso(),
          by: req.user.id, byName: req.user.name || req.user.email,
          note: req.body && req.body.note !== undefined ? trim(req.body.note) : (prev.note || null),
          expiresAt: req.body && req.body.expiresAt ? trim(req.body.expiresAt, 10) : (prev.expiresAt || null)
        });
        rec.updatedAt = nowIso();
        await saveRecords(rows);
        await logActivity('clinician_onboarding_item_submitted', req.user.id,
          { itemId: item.id, byRole: 'clinician' });
        const users = await getUsers();
        res.json(await assemble(rec, { viewer: req.user, users, rows }));
      } catch (e) {
        console.error('clinician item submit:', e.message);
        res.status(500).json({ error: 'Could not save that.', code: 'ITEM_SAVE_FAILED' });
      }
    });

  /** Proof for one of her items. Bytes go to Drive; the row holds a pointer. */
  router.post('/api/clinician-onboarding/me/items/:itemId/proof', authenticateToken,
    requireClinician, upload.single('file'), async (req, res) => {
      try {
        const item = T.findItem(req.params.itemId);
        if (!item) return res.status(404).json({ error: 'Unknown item.', code: 'ITEM_UNKNOWN' });
        if (!req.file) return res.status(400).json({ error: 'Choose a file.', code: 'NO_FILE' });
        // ONE COPY of "what a valid staff document upload is", shared with
        // the caregiver document route. This block used to be its own — and
        // it read `.ext` off a function that returns a mime STRING, so every
        // upload was refused from the day it shipped. Two copies drift, and
        // the drift is silent in both directions.
        const prepared = staffDocs.prepareStaffDocument({
          buffer: req.file.buffer,
          fileName: req.file.originalname,
          detectFileType,
          maxBytes: (config && config.MAX_FILE_SIZE) || MAX_PROOF_BYTES,
          keyPrefix: item.id
        });
        if (!prepared.ok) {
          return res.status(prepared.status).json({ error: prepared.error, code: prepared.code });
        }
        const name = prepared.safeName;

        const rows = await allRecords();
        let rec = findRecord(rows, req.user.id);
        if (!rec) { rec = blankRecord(req.user); rows.push(rec); }

        // A storage failure REFUSES the upload. A row pointing at a file that
        // does not exist would tick a credentialing item with no proof behind it.
        let stored;
        try {
          stored = await drive.uploadCaregiverDocumentFile(
            `Clinician ${rec.userName || rec.userId}`, name, req.file.buffer,
            prepared.mime);
        } catch (err) {
          return res.status(502).json({
            error: 'We could not store that file. Please try again.',
            code: 'PROOF_STORAGE_UNAVAILABLE',
            detail: drive.describeDriveError ? drive.describeDriveError(err).reason : null
          });
        }
        const needsOfficeCheck = item.action === T.ACTIONS.VERIFY || !!item.verify;

        // ONE STORE, TWO DOORS. The file also becomes a row in
        // `caregiver_documents`, which is what User Management's documents card
        // already reads — so a clinician's paperwork sits beside a caregiver's
        // on the same screen instead of only inside the onboarding wizard. The
        // office should not have to know which door a document came through to
        // find it, and a second store is how one of them goes unread.
        //
        // The row's status MIRRORS the item's rather than inventing a second
        // rule: anything the office verifies against a primary source lands
        // `received` so it still reads as waiting on them.
        const docId = `cgdoc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const docRows = (await db.get('caregiver_documents')) || [];
        docRows.push(staffDocs.buildStaffDocumentRow({
          id: docId,
          ownerId: req.user.id,
          ownerName: req.user.name || req.user.email,
          kind: 'clinician_onboarding',
          fileName: req.file.originalname || name,
          storedName: name,
          mime: prepared.mime,
          sizeBytes: req.file.buffer.length,
          driveFileId: stored.id || stored.fileId || null,
          driveUrl: stored.webViewLink || null,
          // WHICH item it answers. Without this every one of her uploads reads
          // "Clinician onboarding document" and the office has to open each one
          // to find out what it is.
          note: `Onboarding: ${item.title}`,
          // The row's status MIRRORS the item's rather than inventing a second
          // rule: anything verified against a primary source still reads as
          // waiting on the office.
          status: needsOfficeCheck ? 'received' : 'accepted',
          uploadedById: req.user.id,
          uploadedByName: req.user.name || req.user.email,
          uploadedByOffice: isOffice(req.user),
          extra: { clinician_item_id: item.id }
        }));
        await db.set('caregiver_documents', docRows);

        const prev = rec.items[item.id] || {};
        const files = (prev.proofFiles || []).concat([{
          id: uuidv4(), name: req.file.originalname ? trim(req.file.originalname, 200) : name,
          driveFileId: stored.id || stored.fileId || null,
          // The shared row, so the wizard and User Management open one file.
          documentId: docId,
          mime: prepared.mime, uploadedAt: nowIso(),
          uploadedBy: req.user.id, uploadedByName: req.user.name || req.user.email
        }]);
        rec.items[item.id] = Object.assign({}, prev, {
          proofFiles: files,
          status: prev.status === 'complete' ? 'complete' : (needsOfficeCheck ? 'submitted' : 'complete'),
          completedAt: prev.completedAt || (needsOfficeCheck ? null : nowIso()),
          at: nowIso(), by: req.user.id, byName: req.user.name || req.user.email
        });
        rec.updatedAt = nowIso();
        await saveRecords(rows);
        await logActivity('clinician_onboarding_proof_uploaded', req.user.id, { itemId: item.id });
        const users = await getUsers();
        res.json(await assemble(rec, { viewer: req.user, users, rows }));
      } catch (e) {
        console.error('clinician proof upload:', e.message);
        res.status(500).json({ error: 'Could not store that file.', code: 'PROOF_FAILED' });
      }
    });

  /**
   * SHE OPENS A FILE SHE SENT IN.
   *
   * Her own, by her own session — there is no userId to pass, so there is
   * nothing to widen. The office opens the same file through the caregiver
   * document route, because the upload writes one shared row: two readers,
   * one file, never two copies that can disagree about what was sent.
   *
   * Through the app, never a Drive link, so every read is audited.
   */
  router.get('/api/clinician-onboarding/me/items/:itemId/proof/:fileId',
    authenticateToken, requireClinician, async (req, res) => {
      try {
        const rows = await allRecords();
        const rec = findRecord(rows, req.user.id);
        const entry = rec && rec.items ? rec.items[req.params.itemId] : null;
        const file = entry && Array.isArray(entry.proofFiles)
          ? entry.proofFiles.find(f => String(f.id) === String(req.params.fileId))
          : null;
        if (!file) return res.status(404).json({ error: 'No such file.', code: 'PROOF_NOT_FOUND' });
        // A row with no stored file is a different fact from Google refusing
        // one, and asking Google about `undefined` answers "File not found",
        // which reads as an outage.
        if (!file.driveFileId) {
          return res.status(404).json({
            error: 'No stored file is attached to that record.', code: 'PROOF_FILE_MISSING'
          });
        }
        let buf;
        try {
          buf = await drive.downloadFileBuffer(file.driveFileId);
        } catch (e) {
          const d = drive.describeDriveError ? drive.describeDriveError(e) : { reason: e.message };
          console.error('[CLINICIAN ONBOARDING] Drive read failed:', d.reason);
          return res.status(502).json({
            error: 'That file could not be retrieved right now. The office has been told.',
            code: 'PROOF_STORAGE_UNAVAILABLE'
          });
        }
        await logActivity('clinician_onboarding_proof_read', req.user.id, {
          itemId: req.params.itemId, fileId: req.params.fileId
        });
        res.setHeader('Content-Type', file.mime || 'application/octet-stream');
        res.setHeader('Content-Disposition', contentDisposition('inline', file.name || 'document'));
        res.send(buf);
      } catch (e) {
        console.error('clinician proof read:', e.message);
        res.status(500).json({ error: 'Could not open that file.', code: 'PROOF_READ_FAILED' });
      }
    });

  /**
   * A NOTE ON AN ITEM, FROM EITHER SIDE.
   *
   * Append-only, each one stamped with who wrote it and when. The old single
   * `note` field was written by her AND by the office, so whoever saved last
   * silently overwrote the other, and it only rendered once the item was done
   * — it could never have been the back-and-forth it looked like.
   *
   * One handler, two gates: she writes on her own record (no userId to pass),
   * the office writes on anyone's. The same shape either way, because a note
   * that reads differently depending on who sent it is two features.
   */
  const addNote = async (req, res, { userId, fromOffice }) => {
    try {
      const item = T.findItem(req.params.itemId);
      if (!item) return res.status(404).json({ error: 'Unknown item.', code: 'ITEM_UNKNOWN' });
      const text = trim(req.body && req.body.text, 2000);
      if (!text) return res.status(400).json({ error: 'Write something first.', code: 'NOTE_EMPTY' });

      const rows = await allRecords();
      const users = await getUsers();
      let rec = findRecord(rows, userId);
      if (!rec) {
        const user = (users || []).find(u => String(u.id) === String(userId));
        if (!user) return res.status(404).json({ error: 'No such person.', code: 'USER_UNKNOWN' });
        rec = blankRecord(user);
        rows.push(rec);
      }
      const prev = rec.items[item.id] || {};
      rec.items[item.id] = Object.assign({}, prev, {
        notes: (prev.notes || []).concat([{
          id: uuidv4(), text, at: nowIso(),
          by: req.user.id, byName: req.user.name || req.user.email,
          fromOffice: !!fromOffice
        }])
      });
      rec.updatedAt = nowIso();
      await saveRecords(rows);
      // THAT a note was written, never what it said. An audit trail is not a
      // second copy of the conversation.
      await appendEvent({
        type: 'note_added', userId: String(userId), itemId: item.id,
        byId: req.user.id, byName: req.user.name || req.user.email, fromOffice: !!fromOffice
      });
      await logActivity('clinician_onboarding_note_added', req.user.id, {
        itemId: item.id, onUserId: String(userId), fromOffice: !!fromOffice
      });
      res.json(await assemble(rec, {
        viewer: req.user, users, rows, audience: fromOffice ? 'office' : 'clinician'
      }));
    } catch (e) {
      console.error('clinician onboarding note:', e.message);
      res.status(500).json({ error: 'Could not save that note.', code: 'NOTE_FAILED' });
    }
  };

  router.post('/api/clinician-onboarding/me/items/:itemId/notes', authenticateToken,
    requireClinician, (req, res) => addNote(req, res, { userId: req.user.id, fromOffice: false }));

  router.post('/api/clinician-onboarding/admin/:userId/items/:itemId/notes', authenticateToken,
    requireOffice, (req, res) => addNote(req, res, { userId: req.params.userId, fromOffice: true }));

  /**
   * She signs a document.
   *
   * THE SIGNATURE RECORDS THE VERSION IT WAS SIGNED AGAINST, from the SERVER's
   * copy of the resource record — never from the browser. A page that could post
   * its own version label could stamp a signature onto text nobody saw.
   */
  router.post('/api/clinician-onboarding/me/resources/:resId/sign', authenticateToken,
    requireClinician, async (req, res) => {
      try {
        const resource = RES.findResource(req.params.resId);
        if (!resource) return res.status(404).json({ error: 'Unknown document.', code: 'RESOURCE_UNKNOWN' });
        const rows = await allRecords();
        let rec = findRecord(rows, req.user.id);
        if (!rec) { rec = blankRecord(req.user); rows.push(rec); }
        if (!RES.resourceApplies(resource, T.normalizeInputs(rec.inputs))) {
          return res.status(409).json({
            error: 'That document is not part of your onboarding.', code: 'RESOURCE_NOT_ON_TRACK'
          });
        }
        const signable = [RES.ACTIONS.SIGN, RES.ACTIONS.ACKNOWLEDGE, RES.ACTIONS.ATTEST_WITH_CHECKS];
        if (!signable.includes(resource.action)) {
          return res.status(409).json({
            error: `${resource.title} is for reading, not signing.`, code: 'RESOURCE_NOT_SIGNABLE'
          });
        }
        const typedName = trim(req.body && req.body.typedName, 120);
        if (!typedName) {
          return res.status(400).json({ error: 'Type your full name to sign.', code: 'SIGNATURE_NAME_REQUIRED' });
        }
        rec.signatures[resource.id] = {
          at: nowIso(),
          // The server's version, not the browser's.
          version: resource.version || null,
          driveModifiedTime: trim(req.body && req.body.driveModifiedTime, 40) || null,
          typedName, by: req.user.id,
          ipHash: hashIp ? hashIp(req) : null
        };
        // A signature on a document that IS a playbook item completes that item.
        if (resource.playbookItem) {
          const item = T.findItem(resource.playbookItem);
          if (item && T.itemApplies(item, rec.inputs)) {
            const prev = rec.items[item.id] || {};
            const allSigned = RES.RESOURCES
              .filter(r => r.playbookItem === item.id && RES.resourceApplies(r, T.normalizeInputs(rec.inputs)))
              .every(r => !signable.includes(r.action) || rec.signatures[r.id]);
            if (allSigned) {
              rec.items[item.id] = Object.assign({}, prev, {
                status: 'complete', at: nowIso(), completedAt: nowIso(),
                by: req.user.id, byName: req.user.name || req.user.email
              });
            }
          }
        }
        rec.updatedAt = nowIso();
        await saveRecords(rows);
        await logActivity('clinician_onboarding_document_signed', req.user.id,
          { resourceId: resource.id, version: resource.version });
        const users = await getUsers();
        res.json(await assemble(rec, { viewer: req.user, users, rows }));
      } catch (e) {
        console.error('clinician sign:', e.message);
        res.status(500).json({ error: 'Could not record that signature.', code: 'SIGN_FAILED' });
      }
    });

  /** A document that will not open. Flagged, never a blocker (resource rule 6). */
  router.post('/api/clinician-onboarding/me/resources/:resId/no-access', authenticateToken,
    requireClinician, async (req, res) => {
      const resource = RES.findResource(req.params.resId);
      if (!resource) return res.status(404).json({ error: 'Unknown document.', code: 'RESOURCE_UNKNOWN' });
      const rows = await allRecords();
      let rec = findRecord(rows, req.user.id);
      if (!rec) { rec = blankRecord(req.user); rows.push(rec); }
      rec.accessFailures[resource.id] = { at: nowIso(), by: req.user.id };
      rec.updatedAt = nowIso();
      await saveRecords(rows);
      await logActivity('clinician_onboarding_document_unreachable', req.user.id,
        { resourceId: resource.id });
      const users = await getUsers();
      res.json(await assemble(rec, { viewer: req.user, users, rows }));
    });

  /** She finishes a training module. */
  router.put('/api/clinician-onboarding/me/training/:moduleId', authenticateToken,
    requireClinician, async (req, res) => {
      try {
        const mod = TR.MODULE_LIBRARY.find(m => m.id === req.params.moduleId);
        if (!mod) return res.status(404).json({ error: 'Unknown module.', code: 'MODULE_UNKNOWN' });
        const rows = await allRecords();
        let rec = findRecord(rows, req.user.id);
        if (!rec) { rec = blankRecord(req.user); rows.push(rec); }
        if (!TR.moduleApplies(mod, T.normalizeInputs(rec.inputs))) {
          return res.status(409).json({
            error: 'That module is not part of your training.', code: 'MODULE_NOT_ON_TRACK'
          });
        }
        const st = TR.moduleStatus(mod, rec.training, null);
        if (st.locked) {
          return res.status(409).json({
            error: 'Finish the module before this one first.', code: 'MODULE_LOCKED'
          });
        }
        const prev = rec.training[mod.id] || {};
        const answers = (req.body && Array.isArray(req.body.answers)) ? req.body.answers : [];
        const correct = answers.filter(a => a && a.correct === true).length;
        rec.training[mod.id] = Object.assign({}, prev, {
          completedAt: nowIso(),
          score: answers.length ? Math.round((correct / answers.length) * 100) : null,
          answers: answers.map(a => ({
            prompt: trim(a && a.prompt, 400), correct: !!(a && a.correct)
          })),
          rechecks: prev.rechecks || {}
        });
        rec.updatedAt = nowIso();
        await saveRecords(rows);
        await logActivity('clinician_training_module_completed', req.user.id,
          { moduleId: mod.id, score: rec.training[mod.id].score });
        const users = await getUsers();
        res.json(await assemble(rec, { viewer: req.user, users, rows }));
      } catch (e) {
        console.error('clinician training:', e.message);
        res.status(500).json({ error: 'Could not save that.', code: 'MODULE_SAVE_FAILED' });
      }
    });

  /**
   * A spaced re-check answered.
   *
   * A WRONG ANSWER SENDS HER BACK TO THE MODULE — that is the retention
   * mechanism (training library §1.4), not a score to file away, so it clears
   * the module's completion rather than merely recording a miss.
   */
  router.post('/api/clinician-onboarding/me/training/:moduleId/recheck', authenticateToken,
    requireClinician, async (req, res) => {
      const mod = TR.MODULE_LIBRARY.find(m => m.id === req.params.moduleId);
      if (!mod) return res.status(404).json({ error: 'Unknown module.', code: 'MODULE_UNKNOWN' });
      const day = String((req.body && req.body.day) || '');
      if (!TR.DEFAULT_RECHECK_DAYS.map(String).includes(day)) {
        return res.status(400).json({ error: 'Unknown re-check.', code: 'RECHECK_UNKNOWN' });
      }
      const rows = await allRecords();
      let rec = findRecord(rows, req.user.id);
      if (!rec) { rec = blankRecord(req.user); rows.push(rec); }
      const prev = rec.training[mod.id] || {};
      const correct = !!(req.body && req.body.correct);
      rec.training[mod.id] = Object.assign({}, prev, {
        rechecks: Object.assign({}, prev.rechecks || {}, {
          [day]: { at: nowIso(), correct }
        }),
        // Back to the module on a miss.
        completedAt: correct ? prev.completedAt : null
      });
      rec.updatedAt = nowIso();
      await saveRecords(rows);
      await logActivity('clinician_training_recheck', req.user.id,
        { moduleId: mod.id, day, correct });
      const users = await getUsers();
      res.json(await assemble(rec, { viewer: req.user, users, rows }));
    });

  // ---- THE OFFICE ---------------------------------------------------------
  /** The roster: everyone with a clinical account, and where each one stands. */
  router.get('/api/clinician-onboarding/admin/roster', authenticateToken, requireOffice,
    async (req, res) => {
      try {
        const users = await getUsers();
        const rows = await allRecords();
        const clinicians = users.filter(u => u.hasClinicalAccess === true
          && u.accountStatus !== 'inactive');
        const out = [];
        for (const u of clinicians) {
          const rec = findRecord(rows, u.id);
          if (!rec) {
            // No record means no track has been set up, and NOTHING about this
            // person's access changes because of it. Named rather than silently
            // treated as "nothing done": these are the clinicians already
            // working, and the office needs to see them to set their inputs.
            out.push({
              userId: String(u.id), userName: u.name || u.email,
              hasRecord: false, trackDefined: false,
              message: 'No onboarding track set up yet.',
              counts: null, gates: [], waitingOnUs: 0, waitingOnThem: 0, expired: 0
            });
            continue;
          }
          const supervisor = await supervisorFor(rec, rows, users);
          const track = T.buildTrack({ inputs: rec.inputs, record: rec, supervisor });
          out.push({
            userId: String(u.id), userName: u.name || u.email,
            hasRecord: true,
            trackDefined: track.defined.defined,
            trackMessage: track.defined.message,
            inputs: track.inputs,
            counts: track.counts,
            gates: Object.values(track.gates).map(g => ({
              id: g.id, label: g.label, eligible: g.eligible, opened: g.opened,
              blocked: g.blockedBy.length + g.blockedByGates.length
                + (g.waitingOnSupervisor ? 1 : 0)
            })),
            waitingOnUs: track.counts.waitingOnGfc,
            waitingOnThem: track.counts.waitingOnClinician,
            expired: track.counts.expired,
            privilegesReview: PRV.buildPrivileges({
              inputs: track.inputs, list: rec.privileges
            }).review
          });
        }
        res.json({
          clinicians: out,
          // The banner: who is working with no track set up. Same shape as 4.8's
          // role-confirmation banner, for the same reason — a console line is
          // not where an admin works.
          withoutTrack: out.filter(c => !c.hasRecord).map(c => c.userName)
        });
      } catch (e) {
        console.error('clinician roster:', e.message);
        res.status(500).json({ error: 'Could not load the roster.', code: 'ROSTER_FAILED' });
      }
    });

  router.get('/api/clinician-onboarding/admin/:userId', authenticateToken, requireOffice,
    async (req, res) => {
      try {
        const users = await getUsers();
        const user = users.find(u => String(u.id) === String(req.params.userId));
        if (!user) return res.status(404).json({ error: 'No such user.', code: 'USER_NOT_FOUND' });
        const rec = await recordFor(user);
        const rows = await allRecords();
        res.json(Object.assign(await assemble(rec, { viewer: req.user, users, rows, audience: 'office' }), {
          // Candidate supervisors: anyone whose own track carries the physician
          // role. Never a free-text name, so the parent gate always resolves.
          supervisorCandidates: rows
            .filter(r => (r.inputs.roles || []).includes(T.ROLES.MD_DELEGATING))
            .map(r => ({ userId: r.userId, name: r.userName }))
        }));
      } catch (e) {
        console.error('clinician detail:', e.message);
        res.status(500).json({ error: 'Could not load that clinician.', code: 'DETAIL_FAILED' });
      }
    });

  /**
   * The four inputs. This is the whole configuration of a track.
   *
   * Changing one RECOMPUTES the checklist; it never migrates anything. Open
   * items from a removed lane disappear and COMPLETED ones stay in the record,
   * because what somebody actually did is a fact and un-ticking a box does not
   * undo it.
   */
  router.put('/api/clinician-onboarding/admin/:userId/inputs', authenticateToken, requireOffice,
    async (req, res) => {
      try {
        const users = await getUsers();
        const user = users.find(u => String(u.id) === String(req.params.userId));
        if (!user) return res.status(404).json({ error: 'No such user.', code: 'USER_NOT_FOUND' });
        const rows = await allRecords();
        let rec = findRecord(rows, user.id);
        if (!rec) { rec = blankRecord(user); rows.push(rec); }
        const before = T.normalizeInputs(rec.inputs);
        const next = T.normalizeInputs(Object.assign({}, rec.inputs, req.body || {}));
        // A supervisor must be somebody whose own track carries the physician
        // role, or the parent gate can never open and nobody would know why.
        if (next.supervisorUserId) {
          const supRec = findRecord(rows, next.supervisorUserId);
          const ok = supRec && (supRec.inputs.roles || []).includes(T.ROLES.MD_DELEGATING);
          if (!ok) {
            return res.status(409).json({
              error: 'That person is not set up as a supervising physician, so the physician gate could never open for this clinician.',
              code: 'SUPERVISOR_NOT_PHYSICIAN'
            });
          }
        }
        rec.inputs = next;
        rec.updatedAt = nowIso();
        await saveRecords(rows);
        await appendEvent({
          type: 'inputs_changed', userId: String(user.id),
          by: req.user.id, byName: req.user.name || req.user.email,
          before, after: next
        });
        await logActivity('clinician_onboarding_inputs_changed', req.user.id,
          { targetUserId: String(user.id) });
        res.json(await assemble(rec, { viewer: req.user, users, rows, audience: 'office' }));
      } catch (e) {
        console.error('clinician inputs:', e.message);
        res.status(500).json({ error: 'Could not save those settings.', code: 'INPUTS_FAILED' });
      }
    });

  /**
   * The office records or verifies an item.
   *
   * A VERIFIED ITEM MUST NAME ITS SOURCE AND ITS DATE. That is the whole of what
   * this app does about verification: it never checks Nursys or the OIG list
   * itself, so the record of who looked, where, and when IS the credential.
   */
  router.put('/api/clinician-onboarding/admin/:userId/items/:itemId', authenticateToken,
    requireOffice, async (req, res) => {
      try {
        const users = await getUsers();
        const user = users.find(u => String(u.id) === String(req.params.userId));
        if (!user) return res.status(404).json({ error: 'No such user.', code: 'USER_NOT_FOUND' });
        const item = T.findItem(req.params.itemId);
        if (!item) return res.status(404).json({ error: 'Unknown item.', code: 'ITEM_UNKNOWN' });
        const rows = await allRecords();
        let rec = findRecord(rows, user.id);
        if (!rec) { rec = blankRecord(user); rows.push(rec); }
        if (!T.itemApplies(item, rec.inputs)) {
          return res.status(409).json({
            error: 'That item is not on this clinician’s checklist.', code: 'ITEM_NOT_ON_TRACK'
          });
        }
        const status = String((req.body && req.body.status) || '');
        const allowed = ['not_started', 'in_progress', 'submitted', 'complete', 'not_applicable'];
        if (!allowed.includes(status)) {
          return res.status(400).json({ error: 'Unknown status.', code: 'ITEM_STATUS_INVALID' });
        }
        const verifiedAt = trim(req.body && req.body.verifiedAt, 10);
        const source = trim(req.body && req.body.source, 60);
        if (status === 'complete' && (item.verify || item.action === T.ACTIONS.VERIFY)) {
          if (!verifiedAt || !/^\d{4}-\d{2}-\d{2}$/.test(verifiedAt)) {
            return res.status(400).json({
              error: `Record the date you checked ${item.title}. A verification with no date cannot be relied on later.`,
              code: 'VERIFY_DATE_REQUIRED'
            });
          }
          if (!source) {
            return res.status(400).json({
              error: `Name the source you checked ${item.title} against.`,
              code: 'VERIFY_SOURCE_REQUIRED'
            });
          }
        }
        if (status === 'not_applicable' && !trim(req.body && req.body.note)) {
          return res.status(400).json({
            error: 'Say why this item does not apply.', code: 'ITEM_NA_REASON_REQUIRED'
          });
        }
        const prev = rec.items[item.id] || {};
        rec.items[item.id] = Object.assign({}, prev, {
          status, at: nowIso(),
          completedAt: status === 'complete' ? (verifiedAt || nowIso()) : null,
          verifiedAt: status === 'complete' ? (verifiedAt || null) : null,
          verifiedBy: status === 'complete' ? req.user.id : null,
          verifiedByName: status === 'complete' ? (req.user.name || req.user.email) : null,
          source: source || prev.source || null,
          note: req.body && req.body.note !== undefined ? trim(req.body.note) : (prev.note || null),
          expiresAt: req.body && req.body.expiresAt
            ? trim(req.body.expiresAt, 10) : (prev.expiresAt || null)
        });
        rec.updatedAt = nowIso();
        await saveRecords(rows);
        await appendEvent({
          type: 'item_recorded', userId: String(user.id), itemId: item.id, status,
          source: source || null, verifiedAt: verifiedAt || null,
          by: req.user.id, byName: req.user.name || req.user.email
        });
        await logActivity('clinician_onboarding_item_recorded', req.user.id,
          { targetUserId: String(user.id), itemId: item.id, status });
        res.json(await assemble(rec, { viewer: req.user, users, rows, audience: 'office' }));
      } catch (e) {
        console.error('clinician item record:', e.message);
        res.status(500).json({ error: 'Could not save that.', code: 'ITEM_RECORD_FAILED' });
      }
    });

  /**
   * A gate is SIGNED OPEN by a person.
   *
   * "Gate opening is a recorded event: who signed it, what cleared, the approved
   * scope, and the date. That record is the credentialing committee decision and
   * the audit trail." So eligibility is not opening: a human signs, and what
   * cleared is frozen onto the event rather than recomputed later, because
   * recomputing it would rewrite the decision every time an item expires.
   */
  router.post('/api/clinician-onboarding/admin/:userId/gates/:gateId/open', authenticateToken,
    requireOffice, async (req, res) => {
      try {
        const users = await getUsers();
        const user = users.find(u => String(u.id) === String(req.params.userId));
        if (!user) return res.status(404).json({ error: 'No such user.', code: 'USER_NOT_FOUND' });
        const gateId = String(req.params.gateId);
        if (!T.GATES[gateId]) return res.status(404).json({ error: 'Unknown gate.', code: 'GATE_UNKNOWN' });
        const rows = await allRecords();
        let rec = findRecord(rows, user.id);
        if (!rec) { rec = blankRecord(user); rows.push(rec); }
        const supervisor = await supervisorFor(rec, rows, users);
        const gates = T.gateStatus({ inputs: rec.inputs, record: rec, supervisor });
        const g = gates[gateId];
        if (!g) {
          return res.status(409).json({
            error: 'That gate does not apply to this clinician.', code: 'GATE_NOT_APPLICABLE'
          });
        }
        if (g.opened) {
          return res.status(409).json({ error: 'That gate is already open.', code: 'GATE_ALREADY_OPEN' });
        }
        if (!g.eligible) {
          return res.status(409).json({
            error: `${g.title} is not ready to open yet.`, code: 'GATE_NOT_ELIGIBLE',
            blockedBy: g.blockedBy, blockedByGates: g.blockedByGates,
            waitingOnSupervisor: g.waitingOnSupervisor
          });
        }
        const cleared = T.composeChecklist(rec.inputs)
          .filter(it => (it.gates || []).includes(gateId))
          .map(it => ({
            id: it.id, title: it.title,
            verifiedAt: (rec.items[it.id] || {}).verifiedAt || null,
            source: (rec.items[it.id] || {}).source || null
          }));
        rec.gates[gateId] = {
          openedAt: nowIso(), openedBy: req.user.id,
          openedByName: req.user.name || req.user.email,
          scope: trim(req.body && req.body.scope, 2000) || null,
          cleared
        };
        rec.updatedAt = nowIso();
        await saveRecords(rows);
        await appendEvent({
          type: 'gate_opened', userId: String(user.id), gateId,
          by: req.user.id, byName: req.user.name || req.user.email,
          scope: rec.gates[gateId].scope, cleared
        });
        await logActivity('clinician_gate_opened', req.user.id,
          { targetUserId: String(user.id), gateId });
        res.json(await assemble(rec, { viewer: req.user, users, rows, audience: 'office' }));
      } catch (e) {
        console.error('gate open:', e.message);
        res.status(500).json({ error: 'Could not open that gate.', code: 'GATE_OPEN_FAILED' });
      }
    });

  /** One payer at a time (G5). She can bill Medicare while a plan is pending. */
  router.post('/api/clinician-onboarding/admin/:userId/payer-gates/:payerId/open',
    authenticateToken, requireOffice, async (req, res) => {
      const users = await getUsers();
      const user = users.find(u => String(u.id) === String(req.params.userId));
      if (!user) return res.status(404).json({ error: 'No such user.', code: 'USER_NOT_FOUND' });
      const rows = await allRecords();
      let rec = findRecord(rows, user.id);
      if (!rec) { rec = blankRecord(user); rows.push(rec); }
      const supervisor = await supervisorFor(rec, rows, users);
      const pg = T.payerGates({ inputs: rec.inputs, record: rec, supervisor })
        .find(p => p.payerId === String(req.params.payerId));
      if (!pg) return res.status(404).json({ error: 'Unknown payer.', code: 'PAYER_UNKNOWN' });
      if (!pg.eligible) {
        return res.status(409).json({
          error: `Billing ${pg.payerName} is not ready yet.`, code: 'PAYER_GATE_NOT_ELIGIBLE',
          blockedBy: pg.blockedBy, blockedByGates: pg.blockedByGates
        });
      }
      rec.payerGates[pg.payerId] = {
        openedAt: nowIso(), openedBy: req.user.id,
        openedByName: req.user.name || req.user.email,
        effectiveDate: trim(req.body && req.body.effectiveDate, 10) || null
      };
      rec.updatedAt = nowIso();
      await saveRecords(rows);
      await appendEvent({
        type: 'payer_gate_opened', userId: String(user.id), payerId: pg.payerId,
        by: req.user.id, byName: req.user.name || req.user.email
      });
      await logActivity('clinician_payer_gate_opened', req.user.id,
        { targetUserId: String(user.id), payerId: pg.payerId });
      res.json(await assemble(rec, { viewer: req.user, users, rows, audience: 'office' }));
    });

  // ---- PRIVILEGING --------------------------------------------------------
  /** Step 1 and 2: record the agreement's allowances, generate the list. */
  router.post('/api/clinician-onboarding/admin/:userId/privileges/generate', authenticateToken,
    requireOffice, async (req, res) => {
      const users = await getUsers();
      const user = users.find(u => String(u.id) === String(req.params.userId));
      if (!user) return res.status(404).json({ error: 'No such user.', code: 'USER_NOT_FOUND' });
      const rows = await allRecords();
      let rec = findRecord(rows, user.id);
      if (!rec) { rec = blankRecord(user); rows.push(rec); }
      const allowances = Array.isArray(req.body && req.body.allowances) ? req.body.allowances : [];
      if (!allowances.length) {
        return res.status(400).json({
          error: 'Record what the protocol agreement allows before generating a privilege list. The app never guesses what an agreement permits.',
          code: 'ALLOWANCES_REQUIRED'
        });
      }
      const version = trim(req.body && req.body.agreementVersion, 60);
      if (!version) {
        return res.status(400).json({
          error: 'Name the version of the protocol agreement this was mapped from.',
          code: 'AGREEMENT_VERSION_REQUIRED'
        });
      }
      rec.privileges = PRV.generateList({
        inputs: T.normalizeInputs(rec.inputs), allowances,
        agreement: {
          version, mappedAt: nowIso(),
          mappedBy: req.user.id, mappedByName: req.user.name || req.user.email
        }
      });
      rec.updatedAt = nowIso();
      await saveRecords(rows);
      await appendEvent({
        type: 'privileges_generated', userId: String(user.id), agreementVersion: version,
        by: req.user.id, byName: req.user.name || req.user.email
      });
      await logActivity('clinician_privileges_generated', req.user.id,
        { targetUserId: String(user.id) });
      res.json(await assemble(rec, { viewer: req.user, users, rows, audience: 'office' }));
    });

  /** Step 3: narrow one privilege, with a reason. Never widen. */
  router.put('/api/clinician-onboarding/admin/:userId/privileges/:privilegeId', authenticateToken,
    requireOffice, async (req, res) => {
      const users = await getUsers();
      const user = users.find(u => String(u.id) === String(req.params.userId));
      if (!user) return res.status(404).json({ error: 'No such user.', code: 'USER_NOT_FOUND' });
      const rows = await allRecords();
      const rec = findRecord(rows, user.id);
      if (!rec || !rec.privileges) {
        return res.status(409).json({
          error: 'Generate the privilege list first.', code: 'PRIVILEGES_NOT_GENERATED'
        });
      }
      if (rec.privileges.coSignedAt) {
        return res.status(409).json({
          error: 'This list is co-signed. Changing a privilege now needs a fresh review.',
          code: 'PRIVILEGES_CO_SIGNED'
        });
      }
      const out = PRV.applyDecision(rec.privileges, {
        privilegeId: req.params.privilegeId,
        status: String((req.body && req.body.status) || ''),
        reason: req.body && req.body.reason,
        by: req.user.id, byName: req.user.name || req.user.email
      });
      if (!out.ok) return res.status(409).json({ error: out.error, code: out.code });
      rec.privileges = Object.assign({}, out.list, {
        reviewedAt: nowIso(), reviewedBy: req.user.name || req.user.email
      });
      rec.updatedAt = nowIso();
      await saveRecords(rows);
      await appendEvent({
        type: 'privilege_decided', userId: String(user.id),
        privilegeId: req.params.privilegeId, status: req.body && req.body.status,
        by: req.user.id, byName: req.user.name || req.user.email
      });
      await logActivity('clinician_privilege_decided', req.user.id,
        { targetUserId: String(user.id), privilegeId: req.params.privilegeId });
      res.json(await assemble(rec, { viewer: req.user, users, rows, audience: 'office' }));
    });

  /** Step 4: the supervising physician co-signs. Never self-issued. */
  router.post('/api/clinician-onboarding/admin/:userId/privileges/co-sign', authenticateToken,
    requireOffice, async (req, res) => {
      const users = await getUsers();
      const user = users.find(u => String(u.id) === String(req.params.userId));
      if (!user) return res.status(404).json({ error: 'No such user.', code: 'USER_NOT_FOUND' });
      if (String(user.id) === String(req.user.id)) {
        return res.status(409).json({
          error: 'A privilege list cannot be co-signed by the clinician it belongs to.',
          code: 'PRIVILEGES_CO_SIGN_SELF'
        });
      }
      const rows = await allRecords();
      const rec = findRecord(rows, user.id);
      if (!rec || !rec.privileges) {
        return res.status(409).json({
          error: 'Generate the privilege list first.', code: 'PRIVILEGES_NOT_GENERATED'
        });
      }
      if (!rec.privileges.reviewedAt) {
        return res.status(409).json({
          error: 'The Clinical Director reviews the list before it is co-signed.',
          code: 'PRIVILEGES_NOT_REVIEWED'
        });
      }
      const typedName = trim(req.body && req.body.typedName, 120);
      if (!typedName) {
        return res.status(400).json({ error: 'Type your full name to co-sign.', code: 'SIGNATURE_NAME_REQUIRED' });
      }
      rec.privileges = Object.assign({}, rec.privileges, {
        coSignedAt: nowIso(), coSignedBy: typedName,
        coSignedByUserId: req.user.id
      });
      rec.updatedAt = nowIso();
      await saveRecords(rows);
      await appendEvent({
        type: 'privileges_co_signed', userId: String(user.id),
        by: req.user.id, byName: typedName
      });
      await logActivity('clinician_privileges_co_signed', req.user.id,
        { targetUserId: String(user.id) });
      res.json(await assemble(rec, { viewer: req.user, users, rows, audience: 'office' }));
    });

  /** The append-only trail for one clinician: every gate, every verification. */
  router.get('/api/clinician-onboarding/admin/:userId/events', authenticateToken, requireOffice,
    async (req, res) => {
      const rows = (await db.get(EVENTS)) || [];
      res.json({
        events: rows.filter(e => String(e.userId) === String(req.params.userId))
          .sort((a, b) => String(b.at).localeCompare(String(a.at)))
      });
    });

  return router;
};
