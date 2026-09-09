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
const cg = require('../caregiverRepository');

module.exports = function createCaregiverRoutes(deps) {
  const {
    db, config, logActivity, queueNotification, getUsers, authenticateToken, uuidv4
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
  const requireReviewStaff = (req, res, next) => {
    const u = req.user;
    if (u.role === ROLES.ADMIN || u.hasClinicalAccess || u.role === ROLES.CASE_MANAGER) return next();
    return res.status(403).json({ error: 'Clinical or administrative access required.', code: 'REVIEW_STAFF_ONLY' });
  };

  const requireAdmin = (req, res, next) => {
    if (req.user.role === ROLES.ADMIN) return next();
    return res.status(403).json({ error: 'Administrator access required.', code: 'ADMIN_ONLY' });
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

  // ==========================================================================
  // GET /api/caregiver/me — identity, license level, competencies, and the
  // tier-branched schema. The form renders from exactly this.
  // ==========================================================================
  router.get('/api/caregiver/me', authenticateToken, requireCaregiver, async (req, res) => {
    try {
      const caregiver = await freshCaregiver(req);
      if (!caregiver) return res.status(404).json({ error: 'Account not found.' });
      const clients = await assignedClientsFor(caregiver);
      const schema = cg.visitLogSchemaFor(caregiver);
      res.json({
        id: caregiver.id,
        name: caregiver.name,
        licenseLevel: schema.level,
        licenseLabel: schema.levelLabel,
        competencies: schema.competencies,
        competencyLabels: cg.COMPETENCY_LABELS,
        assignedClientCount: clients.length,
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
  router.get('/api/caregiver/clients', authenticateToken, requireCaregiver, async (req, res) => {
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
  router.get('/api/caregiver/clients/:clientId', authenticateToken, requireCaregiver, async (req, res) => {
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
  router.get('/api/caregiver/visit-log/schema', authenticateToken, requireCaregiver, async (req, res) => {
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
        shift_id: body.shiftId ? String(body.shiftId).slice(0, 120) : null,
        status: schema.submitStatus,        // lpn → pending_review
        skilled_note: !!schema.skilledNote,
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
        pendingReview: schema.submitStatus === 'pending_review'
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
        message: schema.submitStatus === 'pending_review'
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
          ctaUrl: '/clinical',
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
  router.post('/api/caregiver/escalations', authenticateToken, requireCaregiver, async (req, res) => {
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
            ctaUrl: '/caregiver', ctaLabel: 'Open the caregiver app'
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
  router.get('/api/caregiver/feed', authenticateToken, requireCaregiver, async (req, res) => {
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

  return router;
};
