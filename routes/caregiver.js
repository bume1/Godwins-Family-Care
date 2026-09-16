// ============================================================================
// Caregiver app routes (Session 6)
// Spec: docs/GFC_Caregiver_Workspace_Spec_v1.md §3 visit log, §4 escalation,
//       §5 RBAC, §6 submission loop, §7 tabs
//
// Mounted from server.js with ONE require + ONE app.use (parallel-build
// protocol — Sessions 7 and 9 each add their own single line to the same two
// places). Everything this module needs is injected, so server.js keeps no
// caregiver-specific state and this file stays unit-testable.
//
// PHCP data is app-side. This module does NOT touch OpenEMR — two scheduling
// and two documentation systems exist by design: clinical → OpenEMR (4.x),
// PHCP → app. Do not couple them.
//
// KV collections owned here (keyed for the RDS migration, same convention as
// roiRepository.js — snake_case rows, id + *_id foreign keys, append-only):
//   caregiver_visit_logs         one immutable row per submitted visit log
//   caregiver_visit_log_reviews  append-only clinician review notes
//   escalation_events            one row per raised concern
//   escalation_status_events     append-only status trail (never mutated)
//   incident_reports             falls / abuse-neglect, separate by design
//   caregiver_broadcasts         admin broadcasts read by the Feed tab
// It also APPENDS a display row to the existing `visit_logs` collection, which
// is what the client portal (and Session 10's family feed) already read —
// spec §6's fan-out, using the plumbing that exists rather than a parallel one.
// ============================================================================

const express = require('express');
const links = require('../appLinks');   // where each person actually goes
const cg = require('../caregiverRepository');
const wp = require('../welcomePacketRepository');
const onboardingGate = require('../caregiverOnboardingGate');
// The office contact block. ORG in public/consent-text.js is the single source
// of the practice's own contact details — it is what prints into executed
// consent documents — so the caregiver help card reads it rather than keeping a
// second copy that can drift from the one a client has in writing.
const { ORG } = require('../public/consent-text');
const { contentDisposition } = require('../contentDisposition');

module.exports = function createCaregiverRoutes(deps) {
  const {
    db, config, logActivity, queueNotification, getUsers, authenticateToken, uuidv4,
    // Document upload (2026-09-13). Injected rather than required here so this
    // module keeps no I/O of its own and the tests can drive a fake Drive.
    drive, detectFileType
  } = deps;
  const router = express.Router();

  const ROLES = config.ROLES;
  const nowIso = () => new Date().toISOString();
  const readRows = async (key) => (await db.get(key)) || [];

  // ---- Guards -------------------------------------------------------------
  // Enforced at the API layer, never only in the UI (spec §5).

  // A caregiver is the `vendor` role WITH a license level. A lab-era vendor
  // with no licenseLevel is not a caregiver and gets no caregiver surface.
  const requireCaregiver = (req, res, next) => {
    if (cg.isCaregiver(req.user)) return next();
    if (req.user.role === ROLES.VENDOR) {
      return res.status(403).json({
        error: 'No license level is on file for this account. An administrator sets it before the caregiver app opens.',
        code: 'CAREGIVER_NO_LICENSE_LEVEL'
      });
    }
    return res.status(403).json({ error: 'Caregiver access required.', code: 'CAREGIVER_ONLY' });
  };

  // Staff who review caregiver work: admin, clinical (FNP/RN), case manager.
  // The predicate is separate from the guard because some routes serve BOTH
  // audiences off one path (a caregiver sees their own rows, staff see all),
  // and those must not answer a different question than the guard does.
  const isReviewStaff = (u) =>
    !!u && (u.role === ROLES.ADMIN || u.hasClinicalAccess || u.role === ROLES.CASE_MANAGER);

  const requireReviewStaff = (req, res, next) => {
    if (isReviewStaff(req.user)) return next();
    return res.status(403).json({ error: 'Clinical or administrative access required.', code: 'REVIEW_STAFF_ONLY' });
  };

  const requireAdmin = (req, res, next) => {
    if (req.user.role === ROLES.ADMIN) return next();
    return res.status(403).json({ error: 'Administrator access required.', code: 'ADMIN_ONLY' });
  };

  // Caregiver documents serve two audiences from one route: a caregiver reads
  // their OWN rows, an admin reads everyone's. This gates the door; which rows
  // you get is decided per row inside, because that needs the row.
  const requireCaregiverOrAdmin = (req, res, next) => {
    if (req.user.role === ROLES.ADMIN || cg.isCaregiver(req.user)) return next();
    return res.status(403).json({ error: 'Caregiver or administrator access required.', code: 'CAREGIVER_ONLY' });
  };

  // ---- THE WELCOME PACKET GATE (2026-09-13) -------------------------------
  // A caregiver who has not completed their welcome packet has no app yet. The
  // packet screen is the whole app until it is signed.
  //
  // WHAT IS DELIBERATELY NOT BEHIND IT, and each for its own reason:
  //   /api/caregiver/me          the shell reads it to know to show the wizard
  //   /api/caregiver/documents*  the uploading happens there, so gating it
  //                              would lock someone out of the screen they
  //                              were sent to
  //   the welcome packet routes  gating the packet on the packet
  //   visit logs                 work already in flight is documented and paid
  //                              whatever the paperwork says
  const requireOnboarded = async (req, res, next) => {
    try {
      const packets = (await db.get('welcome_packets')) || [];
      const packet = packets.find(r => r && r.caregiver_id === req.user.id) || null;
      const access = onboardingGate.appAccessEligibility(packet);
      if (access.allowed) return next();
      return res.status(403).json({ error: access.message, code: access.code, packetStatus: access.status });
    } catch (error) {
      console.error('Welcome packet gate error:', error);
      return res.status(500).json({ error: 'Authorization error' });
    }
  };

  // Resolve the caregiver's FULL user record. req.user is the trimmed token
  // view and does not carry skilledCompetencies, which the tier gate needs.
  const freshCaregiver = async (req) => {
    const users = await getUsers();
    return users.find(u => u.id === req.user.id) || null;
  };

  // The one place a caregiver → client lookup happens. Returns the client
  // record or an error code; never returns a client the caregiver is not
  // assigned to, and does not distinguish "not assigned" from "no such client"
  // in a way that would let a caregiver enumerate the roster.
  const loadAssignedClient = async (caregiver, clientId) => {
    const users = await getUsers();
    const client = users.find(u => u.id === clientId && u.role === ROLES.CLIENT);
    if (!client) return { error: 'CLIENT_NOT_ASSIGNED' };
    if (!cg.isAssignedToCaregiver(caregiver, client)) return { error: 'CLIENT_NOT_ASSIGNED' };
    return { client, users };
  };

  const assignedClientsFor = async (caregiver) => {
    const users = await getUsers();
    return users.filter(u => u.role === ROLES.CLIENT && cg.isAssignedToCaregiver(caregiver, u));
  };

  // ==========================================================================
  // Page shell. Every /api/caregiver/* route it calls enforces its own access,
  // the same pattern /clinical and /admin/enrollment already use.
  // ==========================================================================
  router.get('/caregiver', (req, res) => {
    res.sendFile(require('path').join(__dirname, '..', 'public', 'caregiver.html'));
  });

  // The STAFF side of the same space: the escalation queue, the visit-log
  // review queue, incidents and caregiver documents. Every route it calls
  // enforces its own access, the same pattern /caregiver and /scheduling use.
  router.get('/caregivers', (req, res) => {
    res.sendFile(require('path').join(__dirname, '..', 'public', 'caregivers.html'));
  });

  // ==========================================================================
  // GET /api/caregiver/me — identity, license level, competencies, and the
  // tier-branched schema. The form renders from exactly this.
  // ==========================================================================
  router.get('/api/caregiver/me', authenticateToken, requireCaregiver, async (req, res) => {
    try {
      const caregiver = await freshCaregiver(req);
      if (!caregiver) return res.status(404).json({ error: 'Account not found.' });
      // The packet gate is read BEFORE the assigned clients, because a
      // caregiver who has not signed their packet has no business being handed
      // a client list even to count.
      const packets = (await db.get('welcome_packets')) || [];
      const packet = packets.find(r => r && r.caregiver_id === caregiver.id) || null;
      const documents = ((await db.get('caregiver_documents')) || [])
        .filter(r => r && r.caregiver_id === caregiver.id);
      // The four signable forms tick their own items. Read here too, or a
      // caregiver who signed them is told on their own Home screen that they
      // are outstanding.
      const attestations = ((await db.get('caregiver_attestations')) || [])
        .filter(r => r && r.caregiver_id === caregiver.id);
      const checklist = wp.buildChecklist((packet || {}).data, documents, (packet || {}).office, attestations);
      const onboarding = onboardingGate.onboardingSummary(caregiver, packet, checklist);

      const clients = onboarding.appAccess ? await assignedClientsFor(caregiver) : [];
      const schema = cg.visitLogSchemaFor(caregiver);
      res.json({
        id: caregiver.id,
        name: caregiver.name,
        // The shell renders the packet and nothing else while this is false.
        // The API refuses those routes too — the screen is the courtesy, the
        // route is the control.
        onboarding,
        checklist,
        licenseLevel: schema.level,
        licenseLabel: schema.levelLabel,
        competencies: schema.competencies,
        competencyLabels: cg.COMPETENCY_LABELS,
        assignedClientCount: clients.length,
        office: { phone: ORG.phone, email: ORG.email },
        schema
      });
    } catch (error) {
      console.error('Caregiver me error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // ==========================================================================
  // GET /api/caregiver/clients — assigned patients only (spec §5).
  // ==========================================================================
  router.get('/api/caregiver/clients', authenticateToken, requireCaregiver, requireOnboarded, async (req, res) => {
    try {
      const caregiver = await freshCaregiver(req);
      const clients = await assignedClientsFor(caregiver);
      res.json({ clients: clients.map(cg.caregiverClientView) });
    } catch (error) {
      console.error('Caregiver clients error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // GET /api/caregiver/clients/:clientId — read-only care plan + behavioral
  // protocols, filtered by the allow-list in caregiverRepository.
  router.get('/api/caregiver/clients/:clientId', authenticateToken, requireCaregiver, requireOnboarded, async (req, res) => {
    try {
      const caregiver = await freshCaregiver(req);
      const { client, error } = await loadAssignedClient(caregiver, req.params.clientId);
      if (error) return res.status(403).json({ error: 'You are not assigned to this client.', code: error });
      await logActivity(caregiver.id, caregiver.name, 'caregiver_client_read', 'client', client.id,
        { role: 'caregiver', licenseLevel: caregiver.licenseLevel, resource: 'care_plan' });
      res.json({
        client: cg.caregiverClientView(client),
        schema: cg.visitLogSchemaFor(caregiver, client)
      });
    } catch (error) {
      console.error('Caregiver client read error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // ==========================================================================
  // GET /api/caregiver/visit-log/schema?clientId= — the tier-branched form.
  // Narrowed to the client's authorized care plan when one is on file.
  // ==========================================================================
  router.get('/api/caregiver/visit-log/schema', authenticateToken, requireCaregiver, requireOnboarded, async (req, res) => {
    try {
      const caregiver = await freshCaregiver(req);
      let client = null;
      if (req.query.clientId) {
        const found = await loadAssignedClient(caregiver, String(req.query.clientId));
        if (found.error) return res.status(403).json({ error: 'You are not assigned to this client.', code: found.error });
        client = found.client;
      }
      res.json({ schema: cg.visitLogSchemaFor(caregiver, client) });
    } catch (error) {
      console.error('Caregiver schema error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // ==========================================================================
  // POST /api/caregiver/visit-logs — submit. Auto-timestamped, immutable.
  //
  // Idempotent on a per-user key so an offline queue can retry a submission
  // without creating a second visit. Returns the ORIGINAL row on a replay, so
  // a caregiver who reconnects twice sees one log, not two.
  // ==========================================================================
  router.post('/api/caregiver/visit-logs', authenticateToken, requireCaregiver, async (req, res) => {
    try {
      const caregiver = await freshCaregiver(req);
      const body = req.body || {};

      const scopedKey = cg.idempotencyKeyFor(caregiver.id, body.idempotencyKey);
      if (!scopedKey) {
        return res.status(400).json({
          error: 'A submission key is required so an offline retry cannot file the visit twice.',
          code: 'IDEMPOTENCY_KEY_REQUIRED'
        });
      }

      const logs = await readRows('caregiver_visit_logs');
      const replay = logs.find(r => r && r.idempotency_key === scopedKey);
      if (replay) {
        return res.json({ visitLog: publicVisitLog(replay), duplicate: true, message: 'Already filed.' });
      }

      const found = await loadAssignedClient(caregiver, String(body.clientId || ''));
      if (found.error) return res.status(403).json({ error: 'You are not assigned to this client.', code: found.error });
      const { client, users } = found;

      const schema = cg.visitLogSchemaFor(caregiver, client);
      if (!schema.valid) {
        return res.status(403).json({ error: 'No license level is on file for this account.', code: 'CAREGIVER_NO_LICENSE_LEVEL' });
      }

      // A shift id is no longer just a marker — clocking out is refused until a
      // log carrying it exists (Session 7's clock-out gate). So it has to be a
      // real shift, THIS caregiver's, and for the same client the log names;
      // otherwise a log could be attached to someone else's shift and satisfy
      // a gate that was never theirs to satisfy.
      const rawShiftId = body.shiftId ? String(body.shiftId) : '';
      let attachedShiftId = null;
      if (rawShiftId) {
        const shift = (await readRows('shifts')).find(s => s && String(s.id) === rawShiftId);
        if (!shift) {
          return res.status(404).json({ error: 'That shift does not exist.', code: 'SHIFT_NOT_FOUND' });
        }
        if (shift.caregiver_id !== caregiver.id) {
          return res.status(403).json({ error: 'That shift is not yours.', code: 'SHIFT_NOT_YOURS' });
        }
        if (String(shift.client_id) !== String(client.id)) {
          return res.status(409).json({
            error: 'That shift is for a different client than this log names.',
            code: 'SHIFT_CLIENT_MISMATCH'
          });
        }
        attachedShiftId = rawShiftId.slice(0, 120);
      } else {
        // No shift id came with the form. A caregiver who is CLOCKED IN on this
        // client right now is documenting that visit whichever screen they
        // started from, so the shift is attached here rather than left off.
        // Without this, a log filed from anywhere but the clock-out prompt
        // carries no shift and the clock-out gate tells the caregiver to file
        // the log they just filed — which is the kind of dead end that gets a
        // safety control worked around instead of followed.
        const openShift = (await readRows('shifts')).find(s =>
          s && s.status === 'in_progress' &&
          s.caregiver_id === caregiver.id &&
          String(s.client_id) === String(client.id));
        if (openShift) attachedShiftId = String(openShift.id).slice(0, 120);
      }

      // The control: anything the schema did not offer is dropped, not stored.
      const { clean, rejected } = cg.sanitizeVisitLogSubmission(schema, body);

      const visitId = uuidv4();
      const submittedAt = nowIso();
      const row = {
        id: visitId,
        client_id: client.id,
        caregiver_id: caregiver.id,
        caregiver_name: caregiver.name,
        license_level: schema.level,
        idempotency_key: scopedKey,
        // The visit as documented. Auto-timestamped; the legacy form's manual
        // arrival/departure, total-hours and signature blocks are dropped —
        // EVV/GPS check-in/out (Session 7) and this timestamp confirm the
        // visit instead (spec §3a).
        visit_date: normalizeDate(body.visitDate) || submittedAt.slice(0, 10),
        visit_type: clean.visitType,
        tasks: clean.tasks,
        measurements: clean.measurements,
        narratives: clean.narratives,
        standing_instructions_acknowledged: clean.standingInstructionsAcknowledged,
        patient_condition: clean.patientCondition,
        safety_concerns: clean.safetyConcerns,
        satisfaction: clean.satisfaction,
        // Session 7 owns the clock; we record whatever marker it has already
        // written, and never invent one.
        shift_id: attachedShiftId,
        // An LPN's note always goes for review; so does ANY note that records a
        // skilled task, whoever wrote it (owner rule 2026-09-13 — a competency
        // can now be held below LPN, and the clinician's review is the licensed
        // oversight that rule depends on). Read off the SANITIZED payload, so a
        // task the schema dropped cannot trigger it.
        status: (schema.submitStatus === 'pending_review' || cg.skilledContentPresent(clean))
          ? 'pending_review' : 'submitted',
        skilled_note: !!schema.skilledNote || cg.skilledContentPresent(clean),
        submitted_at: submittedAt,
        // Immutability is a property of the data, not a UI state: there is no
        // update route for this collection, and the review trail lives in its
        // own append-only collection.
        immutable: true,
        submitted_offline: body.submittedOffline === true,
        client_submitted_at: normalizeIso(body.clientSubmittedAt)
      };

      logs.push(row);
      await db.set('caregiver_visit_logs', logs);

      // ---- Submission loop (spec §6) — one entry, three audiences ----------

      // 1. Family monitoring feed / client portal. `visit_logs` is the
      //    collection the portal already reads; Session 10 builds the view.
      const displayRows = await readRows('visit_logs');
      displayRows.push({
        id: visitId,
        client_id: client.id,
        source: 'caregiver_visit_log',
        caregiverName: caregiver.name,
        type: clean.visitType,
        date: row.visit_date,
        scheduledAt: submittedAt,
        status: 'completed',
        licenseLevel: schema.level,
        pendingReview: row.status === 'pending_review'
      });
      await db.set('visit_logs', displayRows);

      // 2. Clinician review inbox. An LPN skilled note is Pending Review by
      //    definition; a flagged log needs eyes too.
      const incidents = cg.incidentsFromSubmission(clean);
      const escalation = await maybeRaiseFromVisitLog({ body, caregiver, client, users, visitId });

      // 3. Incident reports — separate records, never a checkbox (spec §3a).
      const incidentRows = [];
      if (incidents.length) {
        const all = await readRows('incident_reports');
        for (const inc of incidents) {
          const incRow = {
            id: uuidv4(),
            visit_log_id: visitId,
            client_id: client.id,
            caregiver_id: caregiver.id,
            caregiver_name: caregiver.name,
            kind: inc.kind,
            label: inc.label,
            detail: (clean.narratives || {}).safetyConcernDetails || '',
            status: 'open',
            reported_at: submittedAt
          };
          all.push(incRow);
          incidentRows.push(incRow);
        }
        await db.set('incident_reports', all);
      }

      await logActivity(caregiver.id, caregiver.name, 'caregiver_visit_log_submitted', 'visit_log', visitId, {
        role: 'caregiver', licenseLevel: schema.level, clientId: client.id,
        status: row.status, incidents: incidentRows.length,
        escalationId: escalation ? escalation.id : null,
        rejectedFields: rejected.length ? rejected : undefined,
        submittedOffline: row.submitted_offline
      });

      // A field the schema did not offer was posted. Not an error to the
      // caregiver (their form could not have shown it), but it is audited —
      // a PCA client posting a skilled task id is worth knowing about.
      if (rejected.length) {
        console.warn(`Visit log ${visitId}: dropped ${rejected.length} out-of-scope field(s):`, rejected.join(', '));
      }

      res.json({
        visitLog: publicVisitLog(row),
        duplicate: false,
        incidents: incidentRows.map(r => ({ id: r.id, kind: r.kind, label: r.label })),
        escalation: escalation ? { id: escalation.id, confirmation: escalation.confirmation, notified: escalation.notified } : null,
        message: row.status === 'pending_review'
          ? 'Filed. Your skilled note is with the clinician for review.'
          : 'Visit log filed.'
      });
    } catch (error) {
      console.error('Caregiver visit-log submit error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // GET /api/caregiver/visit-logs — a caregiver reads their OWN logs; review
  // staff read the queue. A caregiver never sees another caregiver's notes.
  router.get('/api/caregiver/visit-logs', authenticateToken, async (req, res) => {
    try {
      const u = req.user;
      const staff = u.role === ROLES.ADMIN || u.hasClinicalAccess || u.role === ROLES.CASE_MANAGER;
      if (!staff && !cg.isCaregiver(u)) {
        return res.status(403).json({ error: 'Caregiver access required.', code: 'CAREGIVER_ONLY' });
      }
      const logs = await readRows('caregiver_visit_logs');
      const reviews = await readRows('caregiver_visit_log_reviews');
      let rows = staff ? logs : logs.filter(r => r && r.caregiver_id === u.id);
      if (staff && req.query.status) rows = rows.filter(r => r.status === String(req.query.status));
      if (req.query.clientId) rows = rows.filter(r => r.client_id === String(req.query.clientId));
      rows = rows.slice().sort((a, b) => String(b.submitted_at || '').localeCompare(String(a.submitted_at || '')));
      res.json({
        visitLogs: rows.slice(0, 200).map(r => ({
          ...publicVisitLog(r),
          reviews: reviews.filter(v => v && v.visit_log_id === r.id)
            .map(v => ({ id: v.id, note: v.note, byName: v.by_name, at: v.at }))
        }))
      });
    } catch (error) {
      console.error('Caregiver visit-log list error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // POST /api/caregiver/visit-logs/:id/review-note — the clinician APPENDS.
  // There is deliberately no route that edits a submitted log. Corrections are
  // additive and carry their own author and timestamp, the same rule the
  // clinical encounter addenda follow (4.4 §3).
  router.post('/api/caregiver/visit-logs/:id/review-note', authenticateToken, requireReviewStaff, async (req, res) => {
    try {
      const note = String((req.body || {}).note || '').trim();
      if (!note) return res.status(400).json({ error: 'A review note is required.', code: 'REVIEW_NOTE_REQUIRED' });

      const logs = await readRows('caregiver_visit_logs');
      const idx = logs.findIndex(r => r && r.id === req.params.id);
      if (idx === -1) return res.status(404).json({ error: 'Visit log not found.', code: 'VISIT_LOG_NOT_FOUND' });

      const reviews = await readRows('caregiver_visit_log_reviews');
      const row = {
        id: uuidv4(),
        visit_log_id: req.params.id,
        client_id: logs[idx].client_id,
        note: note.slice(0, 4000),
        by: req.user.id,
        by_name: req.user.name || req.user.email,
        by_role: req.user.role,
        at: nowIso()
      };
      reviews.push(row);
      await db.set('caregiver_visit_log_reviews', reviews);

      // The documented content is untouched; only the review STATE moves.
      if (logs[idx].status === 'pending_review') {
        logs[idx].status = 'reviewed';
        logs[idx].reviewed_at = row.at;
        logs[idx].reviewed_by_name = row.by_name;
        await db.set('caregiver_visit_logs', logs);
      }

      await logActivity(req.user.id, row.by_name, 'caregiver_visit_log_reviewed', 'visit_log', req.params.id,
        { role: req.user.role, clientId: logs[idx].client_id });

      res.json({ review: { id: row.id, note: row.note, byName: row.by_name, at: row.at }, status: logs[idx].status });
    } catch (error) {
      console.error('Caregiver review-note error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // ==========================================================================
  // Escalation (spec §4)
  // ==========================================================================

  // Shared by the standalone "Flag a concern" button and the flag field inside
  // a visit log, so both produce the same record and the same routing.
  async function raiseEscalation({ caregiver, client, users, concernType, description, visitLogId }) {
    const routing = cg.routeEscalation({ concernType, client, users });
    if (!routing.valid) return { error: 'INVALID_CONCERN_TYPE' };

    const text = String(description || '').trim();
    // A safety-urgent page with no description is a siren with no address.
    if (routing.requiresDescription && !text) {
      return { error: 'DESCRIPTION_REQUIRED' };
    }

    const at = nowIso();
    const id = uuidv4();
    const row = {
      id,
      client_id: client.id,
      client_name: client.name,
      caregiver_id: caregiver.id,
      caregiver_name: caregiver.name,
      visit_log_id: visitLogId || null,
      concern_type: routing.concernType,
      severity: routing.severity,
      channels: routing.channels,
      description: text.slice(0, 2000),
      notified: routing.notify.map(r => ({ id: r.id, name: r.name, role: r.role, reason: r.reason })),
      visibility: routing.visibility.map(r => r.id),
      fallback_to_admin: routing.fallbackToAdmin,
      status: 'received',   // raised → received is automatic and instant
      raised_at: at,
      received_at: at,
      acknowledged_at: null,
      resolved_at: null
    };

    const events = await readRows('escalation_events');
    events.push(row);
    await db.set('escalation_events', events);

    // The immutable trail lives in its own append-only collection: a status
    // entry is written once and never rewritten, so "who saw this and when"
    // survives any later change to the event row.
    await appendEscalationStatus(id, 'raised', caregiver.id, caregiver.name, '', at);
    await appendEscalationStatus(id, 'received', null, 'system', 'Routed automatically.', at);

    // Rides the existing notification queue + activity log. No new queue.
    for (const r of routing.notify) {
      if (!r.email) continue;
      await queueNotification(
        'caregiver_escalation',
        r.id, r.email, r.name,
        {
          subject: `${routing.label} concern — ${client.name}`,
          body: `${caregiver.name} raised a ${routing.label.toLowerCase()} concern for ${client.name}.\n\n${text || '(no description)'}\n\nStatus: Received. Acknowledge it in the workspace so ${caregiver.name} can see it was seen.`,
          ctaUrl: links.PATHS.CLINICAL,
          ctaLabel: 'Open the workspace'
        },
        { relatedEntityId: id, relatedEntityType: 'escalation', createdBy: caregiver.id }
      );
    }

    await logActivity(caregiver.id, caregiver.name, 'escalation_raised', 'escalation', id, {
      role: 'caregiver', clientId: client.id, concernType: routing.concernType,
      severity: routing.severity, notified: row.notified.map(n => n.name), fallbackToAdmin: routing.fallbackToAdmin
    });

    return { row, confirmation: cg.escalationConfirmation(routing), notified: row.notified, routing };
  }

  async function appendEscalationStatus(escalationId, status, byId, byName, note, at) {
    const rows = await readRows('escalation_status_events');
    rows.push({
      id: uuidv4(),
      escalation_id: escalationId,
      status,
      note: String(note || '').slice(0, 2000),
      by: byId || null,
      by_name: byName || 'system',
      at: at || nowIso()
    });
    await db.set('escalation_status_events', rows);
  }

  // The flag field inside a visit log routes exactly like the button does.
  async function maybeRaiseFromVisitLog({ body, caregiver, client, users, visitId }) {
    const type = cg.normalizeConcernType(body.flagConcernType);
    if (!type) return null;
    const result = await raiseEscalation({
      caregiver, client, users,
      concernType: type,
      description: body.flagDescription,
      visitLogId: visitId
    });
    if (result.error) {
      // The visit log itself stands — a rejected flag never voids documented
      // care. It is reported instead, so the caregiver can re-raise it.
      console.warn(`Visit log ${visitId}: flag not raised (${result.error})`);
      return null;
    }
    return { id: result.row.id, confirmation: result.confirmation, notified: result.notified };
  }

  // POST /api/caregiver/escalations — the persistent "Flag a concern" button.
  router.post('/api/caregiver/escalations', authenticateToken, requireCaregiver, requireOnboarded, async (req, res) => {
    try {
      const caregiver = await freshCaregiver(req);
      const body = req.body || {};
      const found = await loadAssignedClient(caregiver, String(body.clientId || ''));
      if (found.error) return res.status(403).json({ error: 'You are not assigned to this client.', code: found.error });

      const result = await raiseEscalation({
        caregiver, client: found.client, users: found.users,
        concernType: body.concernType, description: body.description, visitLogId: null
      });

      if (result.error === 'INVALID_CONCERN_TYPE') {
        return res.status(400).json({ error: 'Choose a concern type.', code: 'INVALID_CONCERN_TYPE', concernTypes: cg.CONCERN_TYPES });
      }
      if (result.error === 'DESCRIPTION_REQUIRED') {
        return res.status(400).json({
          error: 'An urgent safety concern needs one line describing what is happening.',
          code: 'DESCRIPTION_REQUIRED'
        });
      }

      res.json({
        escalation: publicEscalation(result.row),
        confirmation: result.confirmation,
        notified: result.notified
      });
    } catch (error) {
      console.error('Escalation raise error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // GET /api/caregiver/escalations — the caregiver sees the ones they raised
  // (so they watch the status move); staff see the ones routed to them.
  router.get('/api/caregiver/escalations', authenticateToken, async (req, res) => {
    try {
      const u = req.user;
      const isStaff = u.role === ROLES.ADMIN || u.hasClinicalAccess || u.role === ROLES.CASE_MANAGER;
      if (!isStaff && !cg.isCaregiver(u)) {
        return res.status(403).json({ error: 'Caregiver access required.', code: 'CAREGIVER_ONLY' });
      }
      const events = await readRows('escalation_events');
      const trail = await readRows('escalation_status_events');
      const mine = events.filter(e => {
        if (!e) return false;
        if (cg.isCaregiver(u) && e.caregiver_id === u.id) return true;
        if (u.role === ROLES.ADMIN) return true;                       // admin always has visibility
        return isStaff && Array.isArray(e.visibility) && e.visibility.includes(u.id);
      });
      mine.sort((a, b) => String(b.raised_at || '').localeCompare(String(a.raised_at || '')));
      res.json({
        escalations: mine.slice(0, 200).map(e => ({
          ...publicEscalation(e),
          trail: trail.filter(t => t && t.escalation_id === e.id)
            .sort((a, b) => String(a.at).localeCompare(String(b.at)))
            .map(t => ({ status: t.status, at: t.at, byName: t.by_name, note: t.note }))
        }))
      });
    } catch (error) {
      console.error('Escalation list error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // POST /api/caregiver/escalations/:id/status — the recipient advances it.
  // received → acknowledged → action_taken → resolved, forward only, each step
  // timestamped and appended. The caregiver watches it move.
  router.post('/api/caregiver/escalations/:id/status', authenticateToken, requireReviewStaff, async (req, res) => {
    try {
      const to = String((req.body || {}).status || '').trim();
      const note = String((req.body || {}).note || '').trim();

      const events = await readRows('escalation_events');
      const idx = events.findIndex(e => e && e.id === req.params.id);
      if (idx === -1) return res.status(404).json({ error: 'Escalation not found.', code: 'ESCALATION_NOT_FOUND' });
      const event = events[idx];

      // A recipient acts on it, or an admin (who always has visibility).
      const isRecipient = Array.isArray(event.visibility) && event.visibility.includes(req.user.id);
      if (!isRecipient && req.user.role !== ROLES.ADMIN) {
        return res.status(403).json({ error: 'This concern was not routed to you.', code: 'ESCALATION_NOT_ROUTED_TO_YOU' });
      }

      if (!cg.ESCALATION_STATUSES.includes(to)) {
        return res.status(400).json({ error: 'Unknown status.', code: 'INVALID_STATUS', statuses: cg.ESCALATION_STATUSES });
      }
      if (!cg.canAdvanceEscalation(event.status, to)) {
        return res.status(409).json({
          error: `A ${event.status} concern cannot move to ${to}.`,
          code: 'INVALID_STATUS_TRANSITION', from: event.status
        });
      }
      if (cg.ESCALATION_NOTE_REQUIRED.includes(to) && !note) {
        return res.status(400).json({ error: 'Say what was done.', code: 'STATUS_NOTE_REQUIRED' });
      }

      const at = nowIso();
      event.status = to;
      if (to === 'acknowledged') event.acknowledged_at = at;
      if (to === 'action_taken') event.action_taken_at = at;
      if (to === 'resolved') event.resolved_at = at;
      events[idx] = event;
      await db.set('escalation_events', events);

      await appendEscalationStatus(event.id, to, req.user.id, req.user.name || req.user.email, note, at);
      await logActivity(req.user.id, req.user.name || req.user.email, 'escalation_status_changed', 'escalation', event.id,
        { role: req.user.role, clientId: event.client_id, status: to });

      // Tell the caregiver it moved, on the queue that already exists.
      const users = await getUsers();
      const raiser = users.find(u => u.id === event.caregiver_id);
      if (raiser && raiser.email) {
        await queueNotification(
          'caregiver_escalation_update',
          raiser.id, raiser.email, raiser.name,
          {
            subject: `Your concern for ${event.client_name} — ${to.replace(/_/g, ' ')}`,
            body: `${req.user.name || req.user.email} marked your ${event.concern_type.replace(/_/g, ' ')} concern "${to.replace(/_/g, ' ')}".${note ? `\n\n${note}` : ''}`,
            ctaUrl: links.PATHS.CAREGIVER_APP, ctaLabel: 'Open the caregiver app'
          },
          { relatedEntityId: `${event.id}:${to}`, relatedEntityType: 'escalation', createdBy: req.user.id }
        );
      }

      res.json({ escalation: publicEscalation(event) });
    } catch (error) {
      console.error('Escalation status error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // ==========================================================================
  // Feed — admin broadcasts + this caregiver's escalation alerts, read-only.
  // ==========================================================================
  router.get('/api/caregiver/feed', authenticateToken, requireCaregiver, requireOnboarded, async (req, res) => {
    try {
      const broadcasts = await readRows('caregiver_broadcasts');
      const events = await readRows('escalation_events');
      const mine = events.filter(e => e && e.caregiver_id === req.user.id);
      const items = broadcasts
        .filter(b => b && b.active !== false)
        .map(b => ({ id: b.id, kind: 'broadcast', title: b.title, body: b.body, at: b.posted_at, byName: b.posted_by_name }))
        .concat(mine.map(e => ({
          id: e.id, kind: 'escalation', title: `${e.concern_type.replace(/_/g, ' ')} concern — ${e.client_name}`,
          body: `Status: ${String(e.status).replace(/_/g, ' ')}. ${cg.describeRecipients(e.notified) === 'no one — this concern could not be routed' ? '' : `Sent to ${cg.describeRecipients(e.notified)}.`}`.trim(),
          at: e.raised_at, status: e.status
        })));
      items.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
      res.json({ items: items.slice(0, 100) });
    } catch (error) {
      console.error('Caregiver feed error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // POST /api/caregiver/broadcasts — admin posts to the Feed.
  router.post('/api/caregiver/broadcasts', authenticateToken, requireAdmin, async (req, res) => {
    try {
      const { title, body } = req.body || {};
      if (!String(title || '').trim()) return res.status(400).json({ error: 'A title is required.', code: 'TITLE_REQUIRED' });
      const rows = await readRows('caregiver_broadcasts');
      const row = {
        id: uuidv4(),
        title: String(title).trim().slice(0, 200),
        body: String(body || '').trim().slice(0, 4000),
        active: true,
        posted_at: nowIso(),
        posted_by: req.user.id,
        posted_by_name: req.user.name || req.user.email
      };
      rows.push(row);
      await db.set('caregiver_broadcasts', rows);
      await logActivity(req.user.id, row.posted_by_name, 'caregiver_broadcast_posted', 'broadcast', row.id, { title: row.title });
      res.json({ broadcast: row });
    } catch (error) {
      console.error('Broadcast error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // ==========================================================================
  // GET /api/caregiver/incidents — staff only. Falls and abuse/neglect.
  // ==========================================================================
  router.get('/api/caregiver/incidents', authenticateToken, requireReviewStaff, async (req, res) => {
    try {
      const rows = await readRows('incident_reports');
      rows.sort((a, b) => String(b.reported_at || '').localeCompare(String(a.reported_at || '')));
      res.json({ incidents: rows.slice(0, 200) });
    } catch (error) {
      console.error('Incident list error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // GET /api/caregiver/admin/competencies — the catalog an admin picks from.
  // The vocabulary lives in caregiverRepository.js and is served rather than
  // restated in the browser: a second copy in a page is the thing that drifts,
  // and a drifting competency list decides what a CNA may document.
  router.get('/api/caregiver/admin/competencies', authenticateToken, requireAdmin, (req, res) => {
    res.json({
      competencies: cg.COMPETENCIES.map(task => ({ task, label: cg.COMPETENCY_LABELS[task] || task }))
    });
  });

  // ==========================================================================
  // PUT /api/caregiver/admin/caregivers/:userId/competencies — admin records a
  // caregiver's verified competencies. Lives here rather than in the admin-hub
  // user form because the parallel-build protocol keeps this session inside its
  // own files; a later wiring session can surface it in the hub UI.
  // ==========================================================================
  router.put('/api/caregiver/admin/caregivers/:userId/competencies', authenticateToken, requireAdmin, async (req, res) => {
    try {
      const incoming = (req.body || {}).skilledCompetencies;
      if (!Array.isArray(incoming)) {
        return res.status(400).json({ error: 'skilledCompetencies must be an array.', code: 'INVALID_COMPETENCIES' });
      }
      const unknown = incoming.map(e => String((e && e.task) || e || '')).filter(t => !cg.COMPETENCIES.includes(t));
      if (unknown.length) {
        return res.status(400).json({ error: `Unknown competency: ${unknown.join(', ')}`, code: 'UNKNOWN_COMPETENCY', competencies: cg.COMPETENCIES });
      }
      const users = await getUsers();
      const idx = users.findIndex(u => u.id === req.params.userId);
      if (idx === -1) return res.status(404).json({ error: 'User not found.' });

      users[idx].skilledCompetencies = incoming.map(e => ({
        task: String(e.task).trim(),
        verified: e.verified === true,
        expiry: e.expiry || null,
        verifiedBy: req.user.id,
        verifiedAt: nowIso()
      }));
      await db.set('users', users);
      if (typeof deps.invalidateUsersCache === 'function') deps.invalidateUsersCache();

      await logActivity(req.user.id, req.user.name || req.user.email, 'caregiver_competencies_set', 'user', req.params.userId,
        { competencies: users[idx].skilledCompetencies.filter(c => c.verified).map(c => c.task) });

      res.json({
        userId: req.params.userId,
        skilledCompetencies: users[idx].skilledCompetencies,
        verified: cg.verifiedCompetencies(users[idx])
      });
    } catch (error) {
      console.error('Competencies error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // ---- Shapers ------------------------------------------------------------
  const publicVisitLog = (r) => ({
    id: r.id,
    clientId: r.client_id,
    caregiverId: r.caregiver_id,
    caregiverName: r.caregiver_name,
    licenseLevel: r.license_level,
    visitDate: r.visit_date,
    visitType: r.visit_type,
    tasks: r.tasks,
    measurements: r.measurements,
    narratives: r.narratives,
    standingInstructionsAcknowledged: r.standing_instructions_acknowledged,
    patientCondition: r.patient_condition,
    safetyConcerns: r.safety_concerns,
    satisfaction: r.satisfaction,
    status: r.status,
    skilledNote: r.skilled_note,
    submittedAt: r.submitted_at,
    submittedOffline: r.submitted_offline,
    reviewedAt: r.reviewed_at || null,
    reviewedByName: r.reviewed_by_name || null,
    immutable: true
  });

  const publicEscalation = (e) => ({
    id: e.id,
    clientId: e.client_id,
    clientName: e.client_name,
    caregiverName: e.caregiver_name,
    visitLogId: e.visit_log_id,
    concernType: e.concern_type,
    severity: e.severity,
    channels: e.channels,
    description: e.description,
    notified: e.notified,
    fallbackToAdmin: e.fallback_to_admin,
    status: e.status,
    raisedAt: e.raised_at,
    receivedAt: e.received_at,
    acknowledgedAt: e.acknowledged_at,
    actionTakenAt: e.action_taken_at || null,
    resolvedAt: e.resolved_at
  });

  const normalizeDate = (v) => {
    if (!v) return null;
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  };
  const normalizeIso = (v) => {
    if (!v) return null;
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d.toISOString();
  };


  // ==========================================================================
  // CAREGIVER DOCUMENTS (2026-09-13, owner request)
  // ==========================================================================
  // "Caregivers need to upload documents (like physical timesheets) when
  // needed." Until now the caregiver app had no upload of any kind, so a paper
  // timesheet had no way into the system and went by text message or not at all.
  //
  // Filed under the CAREGIVER, never a client. A timesheet routinely covers
  // several clients in one week, so filing it against one of them would both
  // file it wrong and put it where that client's care team can read it. Only
  // rows the caregiver sends themselves, plus admin, are readable.
  //
  // POINTERS ONLY in the store. The bytes live in Drive under the BAA, the same
  // rule the client document exchange follows.

  // What a caregiver may send. An open list would let an upload land in a
  // bucket nobody reads; these are the things the office actually chases.
  // `needsPeriod` travels WITH the kind rather than being a list of kind names
  // in the page: the form asks for a pay period only where one means something.
  // Keeping that decision here is the same rule as the catalog itself — a page
  // that names kinds is a page that drifts from the validator that refuses them.
  // `needsPeriod` travels WITH the kind rather than being a list of kind names
  // in the page: the form asks for a pay period only where one means something.
  // Keeping that decision here is the same rule as the catalog itself — a page
  // that names kinds is a page that drifts from the validator that refuses them.
  //
  // `payroll: true` marks the onboarding paperwork (2026-09-13, owner request).
  // GUSTO IS THE SYSTEM OF RECORD for these — the caregiver submits them there,
  // and what the app holds is the office's copy. Nothing here transmits to
  // Gusto and no screen may imply it does, or someone will believe their W9 is
  // filed because they uploaded it here.
  const BASE_DOC_KINDS = [
    { kind: 'timesheet',     label: 'Timesheet',                 needsPeriod: true,  payroll: false },
    { kind: 'visit_note',    label: 'Signed visit note',         needsPeriod: false, payroll: false },
    { kind: 'mileage',       label: 'Mileage or expense log',    needsPeriod: true,  payroll: false },
    { kind: 'certification', label: 'Certification or licence',  needsPeriod: false, payroll: false },
    { kind: 'id_document',   label: 'Photo ID',                  needsPeriod: false, payroll: true },
    { kind: 'paystub',       label: 'Paystub',                   needsPeriod: true,  payroll: true },
    { kind: 'w9',            label: 'W-9',                       needsPeriod: false, payroll: true },
    { kind: 'other',         label: 'Something else',            needsPeriod: false, payroll: false }
  ];

  // The welcome packet's own document items join this list rather than living
  // on a second one (2026-09-13). One catalog means a kind cannot appear on the
  // onboarding checklist and be refused by the upload route that has to accept
  // it — and the checklist reads the same `kind` values the store holds, so an
  // item ticks itself off the moment the office accepts the file.
  //
  // `id_document` and `certification` ALREADY EXIST above and are deliberately
  // reused rather than duplicated: a photo ID is a photo ID, and two buckets
  // for one document is how the office ends up chasing a file it already has.
  const CAREGIVER_DOC_KINDS = [
    ...BASE_DOC_KINDS,
    ...wp.PACKET_DOCUMENT_KINDS
      .filter(k => !BASE_DOC_KINDS.some(b => b.kind === k.kind))
      .map(k => ({
        kind: k.kind, label: k.label, needsPeriod: false, payroll: false,
        onboarding: true, item: k.item, group: k.group, source: k.source
      })),
    // The returned packet itself. Not a checklist item — it is the thing the
    // checklist was read out of — but it is kept, because the extraction is a
    // convenience and the document they actually sent is the record.
    { kind: 'welcome_packet', label: 'Completed welcome packet', needsPeriod: false, payroll: false, onboarding: true }
  ];

  router.get('/api/caregiver/documents/kinds', authenticateToken, requireCaregiverOrAdmin, (req, res) => {
    // SERVED, not restated in the page — the same rule the competency catalog
    // follows, so the list cannot drift between the form and the validator.
    res.json({ kinds: CAREGIVER_DOC_KINDS });
  });

  router.post('/api/caregiver/documents', authenticateToken, requireCaregiverOrAdmin, async (req, res) => {
    try {
      const { kind, fileName, fileDataB64, note, periodStart, periodEnd, shiftId, caregiverId } = req.body || {};
      if (!kind || !fileName || !fileDataB64) {
        return res.status(400).json({ error: 'kind, fileName and fileDataB64 are required', code: 'DOC_FIELDS_REQUIRED' });
      }
      if (!CAREGIVER_DOC_KINDS.some(k => k.kind === kind)) {
        return res.status(400).json({ error: 'Unknown document type', code: 'DOC_KIND_UNKNOWN' });
      }

      let buffer;
      try {
        const b64 = String(fileDataB64).startsWith('data:')
          ? String(fileDataB64).slice(String(fileDataB64).indexOf(',') + 1)
          : String(fileDataB64);
        buffer = Buffer.from(b64, 'base64');
      } catch (e) {
        return res.status(400).json({ error: 'File data is not valid base64.', code: 'DOC_NOT_BASE64' });
      }
      if (!buffer.length) return res.status(400).json({ error: 'File is empty.', code: 'DOC_EMPTY' });
      if (buffer.length > config.MAX_FILE_SIZE) {
        return res.status(400).json({ error: 'File exceeds 10 MB limit.', code: 'DOC_TOO_LARGE' });
      }
      // Typed by its BYTES, never by what the caller claimed — a declared mime
      // is caller-controlled and this is the only thing standing between the
      // Drive folder and an arbitrary file.
      const sniffedType = detectFileType(buffer);
      if (!sniffedType) {
        return res.status(400).json({ error: 'Only PDF, JPG, and PNG files are accepted.', code: 'DOC_TYPE_REJECTED' });
      }

      // WHOSE document this is. An admin files onboarding paperwork on a
      // caregiver's behalf and must NAME them — inferring it would file a W9
      // against whoever happened to be signed in. A caregiver can only ever
      // file their own: passing someone else's id does not widen anything,
      // the same rule the list route follows.
      const isAdmin = req.user.role === ROLES.ADMIN;
      let me;
      if (isAdmin) {
        if (!caregiverId) {
          return res.status(400).json({ error: 'Say which caregiver this belongs to.', code: 'CAREGIVER_ID_REQUIRED' });
        }
        const users = await getUsers();
        me = users.find(u => u.id === caregiverId && cg.isCaregiver(u)) || null;
      } else {
        me = await freshCaregiver(req);
      }
      if (!me) return res.status(404).json({ error: 'Caregiver record not found.', code: 'CAREGIVER_NOT_FOUND' });

      const safeName = `${kind}_${me.id}_${Date.now()}_${String(fileName).replace(/[^a-zA-Z0-9._-]/g, '_')}`;
      let stored;
      try {
        stored = await drive.uploadCaregiverDocumentFile(me.name || 'Caregiver', safeName, buffer, sniffedType);
      } catch (e) {
        // A Drive failure FAILS the upload. Recording the row anyway would show
        // the caregiver a filed timesheet pointing at nothing and leave payroll
        // waiting on a file that was never stored — the silent-success trap this
        // codebase has now hit six times in OpenEMR, pointed at someone's pay.
        const d = drive.describeDriveError ? drive.describeDriveError(e) : { reason: e.message, hint: null };
        console.error('[CAREGIVER DOCS] Drive upload failed:', d.reason, '| hint:', d.hint || 'none');
        return res.status(502).json({
          error: isAdmin
            ? `Google refused that upload: ${d.reason}`
            : 'We could not store that file. Please try again, or send it to the office.',
          code: 'DOCUMENT_STORAGE_UNAVAILABLE',
          ...(isAdmin ? { reason: d.reason, hint: d.hint, setup: 'docs/DRIVE_ACCESS_SETUP.md' } : {})
        });
      }

      const rows = (await db.get('caregiver_documents')) || [];
      const row = {
        id: `cgdoc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        caregiver_id: me.id,
        caregiver_name: me.name || null,
        kind,
        file_name: String(fileName).slice(0, 200),
        stored_name: safeName,
        mime_type: sniffedType,
        size_bytes: buffer.length,
        drive_file_id: stored.fileId,
        drive_url: stored.webViewLink || null,
        note: String(note || '').trim().slice(0, 1000),
        // A timesheet is FOR a period, and payroll needs to know which one.
        period_start: normalizeDate(periodStart),
        period_end: normalizeDate(periodEnd),
        shift_id: shiftId ? String(shiftId) : null,
        // ANYTHING THE OFFICE FILES IS ACCEPTED. It did not arrive needing
        // review — the office is the reviewer, and it was looking at the
        // document when it filed it.
        //
        // OWNER, 2026-09-14: this used to check `payroll`, so an office-filed
        // TB test or CPR card landed 'received' and sat reading "With the
        // office" forever, waiting on a review nobody was ever going to do.
        // The checklist item never ticked, so the office chased a caregiver
        // for a document the office had itself uploaded. A safety net with a
        // dead end in it is the shape this repo keeps paying for.
        status: isAdmin ? 'accepted' : 'received',
        uploaded_at: new Date().toISOString(),
        // "The caregiver sent this" and "the office filed it for them" are
        // different facts, and for a W9 the difference is the whole point.
        uploaded_by_id: req.user.id,
        uploaded_by_name: req.user.name || req.user.email || null,
        uploaded_by_office: isAdmin,
        reviewed_at: null, reviewed_by_name: null, review_note: null
      };
      rows.push(row);
      await db.set('caregiver_documents', rows);

      // The activity log records THAT a document arrived, never its contents.
      await logActivity(req.user.id, req.user.name || req.user.email, 'caregiver_document_uploaded', 'caregiver_document', row.id,
        { kind, caregiverId: me.id, filedByOffice: isAdmin, periodStart: row.period_start, periodEnd: row.period_end });

      res.json({ message: 'Document received', document: publicCaregiverDoc(row) });
    } catch (error) {
      console.error('Caregiver document upload error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // A caregiver reads only their OWN documents. Admin reads everyone's and may
  // filter to one caregiver; the filter is admin-only, so a caregiver cannot
  // widen their view by passing someone else's id.
  router.get('/api/caregiver/documents', authenticateToken, requireCaregiverOrAdmin, async (req, res) => {
    try {
      const isAdmin = req.user.role === ROLES.ADMIN;
      const rows = (await db.get('caregiver_documents')) || [];
      const wanted = isAdmin ? (req.query.caregiverId || null) : req.user.id;
      const mine = rows
        .filter(r => r && (!wanted || r.caregiver_id === wanted))
        .sort((a, b) => String(b.uploaded_at).localeCompare(String(a.uploaded_at)));
      res.json({ documents: mine.map(publicCaregiverDoc) });
    } catch (error) {
      console.error('Caregiver document list error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // The bytes, read back through the app so every read is audited and no file
  // is ever link-shared. A caregiver may open only their own.
  router.get('/api/caregiver/documents/:id/file', authenticateToken, requireCaregiverOrAdmin, async (req, res) => {
    try {
      const isAdmin = req.user.role === ROLES.ADMIN;
      const rows = (await db.get('caregiver_documents')) || [];
      const row = rows.find(r => r && r.id === req.params.id);
      if (!row) return res.status(404).json({ error: 'Document not found', code: 'DOC_NOT_FOUND' });
      if (!isAdmin && row.caregiver_id !== req.user.id) {
        return res.status(403).json({ error: 'That document belongs to someone else.', code: 'DOC_NOT_YOURS' });
      }
      // A row with no stored file is a DIFFERENT fact from Google refusing one,
      // and asking Google about `undefined` answers "File not found", which
      // reads as a storage outage. Say which it is.
      if (!row.drive_file_id) {
        return res.status(404).json({
          error: 'No stored file is attached to that record.', code: 'DOC_FILE_MISSING'
        });
      }

      let buf;
      try {
        buf = await drive.downloadFileBuffer(row.drive_file_id);
      } catch (e) {
        // ONE generic sentence could not distinguish a missing Drive scope from
        // a file in a Shared Drive nobody was added to — which is exactly the
        // state this codebase spent a day guessing at. An ADMIN gets Google's
        // actual reason and the setup step that fixes it; a caregiver does not,
        // because those messages carry file ids and account addresses and there
        // is nothing a caregiver can do with either.
        const d = drive.describeDriveError ? drive.describeDriveError(e) : { reason: e.message, hint: null };
        console.error('[CAREGIVER DOCS] Drive read failed:', d.reason, '| file:', row.drive_file_id, '| hint:', d.hint || 'none');
        return res.status(502).json({
          error: isAdmin
            ? `Google refused that file: ${d.reason}`
            : 'That file could not be retrieved right now. The office has been told.',
          code: 'DOCUMENT_STORAGE_UNAVAILABLE',
          ...(isAdmin ? { reason: d.reason, hint: d.hint, setup: 'docs/DRIVE_ACCESS_SETUP.md' } : {})
        });
      }
      await logActivity(req.user.id, req.user.name || req.user.email, 'caregiver_document_read', 'caregiver_document', row.id,
        { kind: row.kind, owner: row.caregiver_id });
      res.setHeader('Content-Type', row.mime_type || 'application/octet-stream');
      res.setHeader('Content-Disposition', contentDisposition('inline', row.file_name));
      res.send(buf);
    } catch (error) {
      console.error('Caregiver document read error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // Admin marks a document reviewed (or sends it back). A rejection REQUIRES a
  // reason and the caregiver is told what it was — a caregiver told only "not
  // accepted" re-sends the same blurry photo, which is the exact failure the
  // client-side document rejection was written to prevent.
  router.post('/api/caregiver/documents/:id/review', authenticateToken, requireAdmin, async (req, res) => {
    try {
      const { decision, reason } = req.body || {};
      if (!['accepted', 'rejected'].includes(decision)) {
        return res.status(400).json({ error: 'decision must be accepted or rejected', code: 'DECISION_INVALID' });
      }
      if (decision === 'rejected' && !String(reason || '').trim()) {
        return res.status(400).json({ error: 'Say why it is being sent back, so it can be fixed.', code: 'REVIEW_REASON_REQUIRED' });
      }
      const rows = (await db.get('caregiver_documents')) || [];
      const i = rows.findIndex(r => r && r.id === req.params.id);
      if (i === -1) return res.status(404).json({ error: 'Document not found', code: 'DOC_NOT_FOUND' });

      rows[i] = {
        ...rows[i],
        status: decision,
        reviewed_at: new Date().toISOString(),
        reviewed_by_name: req.user.name || req.user.email,
        review_note: String(reason || '').trim().slice(0, 1000) || null
      };
      await db.set('caregiver_documents', rows);
      await logActivity(req.user.id, req.user.name || req.user.email, 'caregiver_document_reviewed', 'caregiver_document', rows[i].id,
        { decision, caregiverId: rows[i].caregiver_id });

      res.json({ message: `Document ${decision}`, document: publicCaregiverDoc(rows[i]) });
    } catch (error) {
      console.error('Caregiver document review error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // Remove a document. Admin only, and the Drive file goes with the row — a
  // superseded W9 has no value and a stale copy of someone's photo ID is the
  // worse thing to leave lying around. This is payroll paperwork, not a
  // clinical record, so the append-only rule that governs visit logs does not
  // apply and a real delete is the honest behaviour.
  router.delete('/api/caregiver/documents/:id', authenticateToken, requireAdmin, async (req, res) => {
    try {
      const rows = (await db.get('caregiver_documents')) || [];
      const i = rows.findIndex(r => r && r.id === req.params.id);
      if (i === -1) return res.status(404).json({ error: 'Document not found', code: 'DOC_NOT_FOUND' });
      const row = rows[i];

      // The row goes whatever Drive says. A Drive failure here leaves an
      // orphaned file, which is untidy; keeping the row would leave a listing
      // that opens nothing, which is worse — and the admin already decided it
      // should be gone.
      try {
        if (row.drive_file_id) await drive.deleteFile(row.drive_file_id);
      } catch (e) {
        console.error('[CAREGIVER DOCS] Drive delete failed, removing the row anyway:', e.message);
      }

      rows.splice(i, 1);
      await db.set('caregiver_documents', rows);
      await logActivity(req.user.id, req.user.name || req.user.email, 'caregiver_document_deleted', 'caregiver_document', row.id,
        { kind: row.kind, caregiverId: row.caregiver_id });
      res.json({ message: 'Document removed' });
    } catch (error) {
      console.error('Caregiver document delete error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // The Drive id and stored name never reach a client of this API — they are
  // storage plumbing, and the file is read back through the route above.
  const publicCaregiverDoc = (r) => ({
    id: r.id,
    caregiverId: r.caregiver_id,
    caregiverName: r.caregiver_name,
    kind: r.kind,
    kindLabel: (CAREGIVER_DOC_KINDS.find(k => k.kind === r.kind) || {}).label || r.kind,
    fileName: r.file_name,
    sizeBytes: r.size_bytes,
    note: r.note || null,
    periodStart: r.period_start, periodEnd: r.period_end,
    shiftId: r.shift_id || null,
    status: r.status,
    uploadedAt: r.uploaded_at,
    uploadedByName: r.uploaded_by_name || null,
    uploadedByOffice: !!r.uploaded_by_office,
    // Onboarding paperwork joins the welcome packet's checklist, so the
    // caregiver's own list can say which item a file ticked off.
    onboarding: !!(CAREGIVER_DOC_KINDS.find(k => k.kind === r.kind) || {}).onboarding
      || !!(CAREGIVER_DOC_KINDS.find(k => k.kind === r.kind) || {}).payroll,
    payroll: !!(CAREGIVER_DOC_KINDS.find(k => k.kind === r.kind) || {}).payroll,
    reviewedAt: r.reviewed_at, reviewedByName: r.reviewed_by_name, reviewNote: r.review_note
  });

  return router;
};
