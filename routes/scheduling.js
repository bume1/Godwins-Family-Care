// ============================================================================
// PHCP scheduling routes (Session 7)
// Spec: docs/GFC_App_Build_v2.md §5, §5.4 · docs/GFC_Session7_ClaudeCode_Prompt.md
//
// Mounted from server.js with ONE require + ONE app.use (parallel-build
// protocol). Dependencies are injected, so server.js keeps no scheduling state
// and this module stays unit-testable and probe-drivable.
//
// PHCP scheduling lives ENTIRELY in the app store. It does not touch OpenEMR —
// clinical appointments (Session 4.2) stay there. Two scheduling systems by
// design; build-enforced in test/scheduling.test.js.
//
// KV collections owned here (snake_case rows, id + *_id keys, keyed for the
// RDS migration — same convention as roiRepository.js and Session 6):
//   caregiver_availability  one row per submission, append-only history
//   shifts                  the shift and its lifecycle timestamps
//   time_logs               one row per clock-in, closed by the clock-out
//   time_log_edits          append-only before/after trail for admin edits
//   shift_requests          client-initiated requests, Pathway A's entry point
// ============================================================================

const express = require('express');
const sched = require('../schedulingRepository');
const cg = require('../caregiverRepository');

module.exports = function createSchedulingRoutes(deps) {
  const { db, config, logActivity, queueNotification, getUsers, authenticateToken, uuidv4 } = deps;
  const router = express.Router();

  const ROLES = config.ROLES;
  const nowIso = () => new Date().toISOString();
  const readRows = async (key) => (await db.get(key)) || [];

  // ---- Guards -------------------------------------------------------------
  const requireAdmin = (req, res, next) => {
    if (req.user.role === ROLES.ADMIN) return next();
    return res.status(403).json({ error: 'Administrator access required.', code: 'ADMIN_ONLY' });
  };

  // Who may submit availability and hold a shift: caregivers, and clinicians
  // (the brief says "caregivers and clinicians submit availability").
  const isSchedulable = (u) => cg.isCaregiver(u) || !!(u && u.hasClinicalAccess);

  const requireSchedulable = (req, res, next) => {
    if (isSchedulable(req.user)) return next();
    if (req.user.role === ROLES.VENDOR) {
      return res.status(403).json({
        error: 'No license level is on file for this account. An administrator sets it before scheduling opens.',
        code: 'CAREGIVER_NO_LICENSE_LEVEL'
      });
    }
    return res.status(403).json({ error: 'Caregiver or clinical access required.', code: 'SCHEDULING_STAFF_ONLY' });
  };

  // Admin sees the whole board; a caregiver sees only their own rows. This is
  // the line every read below is measured against.
  const isAdmin = (u) => u.role === ROLES.ADMIN;

  const freshUser = async (id) => {
    const users = await getUsers();
    return users.find(u => u.id === id) || null;
  };

  const loadClient = async (clientId) => {
    const users = await getUsers();
    return users.find(u => u.id === clientId && u.role === ROLES.CLIENT) || null;
  };

  // ==========================================================================
  // Page shell — admin scheduling UI. Every /api/scheduling route it calls
  // enforces its own access, the same pattern /clinical and /caregiver use.
  // ==========================================================================
  router.get('/scheduling', (req, res) => {
    res.sendFile(require('path').join(__dirname, '..', 'public', 'scheduling.html'));
  });

  // ==========================================================================
  // AVAILABILITY
  // ==========================================================================

  // POST /api/scheduling/availability — the 30-day rule is enforced HERE, so a
  // direct API call is refused exactly as the form is.
  router.post('/api/scheduling/availability', authenticateToken, requireSchedulable, async (req, res) => {
    try {
      const { valid, errors, clean } = sched.validateAvailability(req.body);
      if (!valid) {
        const lead = errors.find(e => e.code === 'AVAILABILITY_LEAD_TIME');
        return res.status(400).json({
          error: lead ? lead.message : 'Some of that availability needs correcting.',
          code: lead ? 'AVAILABILITY_LEAD_TIME' : 'AVAILABILITY_INVALID',
          errors
        });
      }

      const rows = await readRows('caregiver_availability');
      const row = {
        id: uuidv4(),
        caregiver_id: req.user.id,
        caregiver_name: req.user.name || req.user.email,
        license_level: req.user.licenseLevel || null,
        effective_from: clean.effectiveFrom,
        windows: clean.windows,
        blackout_dates: clean.blackoutDates,
        note: clean.note,
        // Append-only: a resubmission is a NEW row, so what someone said in
        // August is still readable in October. `status` marks which one admin
        // schedules from.
        status: 'submitted',
        submitted_at: nowIso(),
        reviewed_at: null,
        reviewed_by_name: null
      };
      rows.push(row);
      await db.set('caregiver_availability', rows);

      await logActivity(req.user.id, row.caregiver_name, 'availability_submitted', 'availability', row.id,
        { role: req.user.role, effectiveFrom: row.effective_from, windows: row.windows.length });

      res.json({ availability: publicAvailability(row) });
    } catch (error) {
      console.error('Availability submit error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // GET /api/scheduling/availability — own rows; admin sees everyone's.
  router.get('/api/scheduling/availability', authenticateToken, async (req, res) => {
    try {
      if (!isAdmin(req.user) && !isSchedulable(req.user)) {
        return res.status(403).json({ error: 'Caregiver or clinical access required.', code: 'SCHEDULING_STAFF_ONLY' });
      }
      const rows = await readRows('caregiver_availability');
      let mine = isAdmin(req.user) ? rows : rows.filter(r => r && r.caregiver_id === req.user.id);
      if (isAdmin(req.user) && req.query.caregiverId) {
        mine = mine.filter(r => r.caregiver_id === String(req.query.caregiverId));
      }
      mine = mine.slice().sort((a, b) => String(b.submitted_at || '').localeCompare(String(a.submitted_at || '')));
      res.json({ availability: mine.slice(0, 200).map(publicAvailability) });
    } catch (error) {
      console.error('Availability list error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // POST /api/scheduling/availability/:id/review — admin marks it reviewed.
  router.post('/api/scheduling/availability/:id/review', authenticateToken, requireAdmin, async (req, res) => {
    try {
      const rows = await readRows('caregiver_availability');
      const idx = rows.findIndex(r => r && r.id === req.params.id);
      if (idx === -1) return res.status(404).json({ error: 'Availability not found.', code: 'AVAILABILITY_NOT_FOUND' });
      rows[idx].status = 'reviewed';
      rows[idx].reviewed_at = nowIso();
      rows[idx].reviewed_by_name = req.user.name || req.user.email;
      await db.set('caregiver_availability', rows);
      await logActivity(req.user.id, rows[idx].reviewed_by_name, 'availability_reviewed', 'availability', req.params.id, {});
      res.json({ availability: publicAvailability(rows[idx]) });
    } catch (error) {
      console.error('Availability review error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // ==========================================================================
  // SHIFT REQUESTS — a client (or their POA/family) asks for coverage.
  // Pathway A begins here: request → admin posts an open shift → claim.
  // ==========================================================================
  router.post('/api/scheduling/shift-requests', authenticateToken, async (req, res) => {
    try {
      const body = req.body || {};
      // A client requests for themselves; family/POA for their linked client;
      // admin on anyone's behalf. Nobody requests for a stranger.
      let clientId = null;
      if (req.user.role === ROLES.CLIENT) clientId = req.user.id;
      else if (req.user.role === ROLES.FAMILY) clientId = req.user.familyOfClientId || null;
      else if (isAdmin(req.user)) clientId = body.clientId || null;
      else return res.status(403).json({ error: 'Only a client, their family, or an administrator can request a shift.', code: 'REQUEST_NOT_PERMITTED' });

      if (!clientId) return res.status(400).json({ error: 'No client on file for this request.', code: 'CLIENT_REQUIRED' });
      const client = await loadClient(clientId);
      if (!client) return res.status(404).json({ error: 'Client not found.', code: 'CLIENT_NOT_FOUND' });

      if (!sched.isIsoDate(body.date)) {
        return res.status(400).json({ error: 'Give the date you need care, as YYYY-MM-DD.', code: 'DATE_INVALID' });
      }
      if (!sched.isTime(body.start) || !sched.isTime(body.end)) {
        return res.status(400).json({ error: 'Give a start and end time (HH:MM).', code: 'TIME_INVALID' });
      }

      const rows = await readRows('shift_requests');
      const row = {
        id: uuidv4(),
        client_id: client.id,
        client_name: client.name,
        requested_by: req.user.id,
        requested_by_name: req.user.name || req.user.email,
        requested_by_role: req.user.role,
        date: body.date,
        start: body.start,
        end: body.end,
        care_needs: String(body.careNeeds || '').trim().slice(0, 2000),
        status: 'requested',
        requested_at: nowIso(),
        resolved_at: null,
        shift_id: null
      };
      rows.push(row);
      await db.set('shift_requests', rows);
      await logActivity(req.user.id, row.requested_by_name, 'shift_requested', 'shift_request', row.id,
        { clientId: client.id, date: row.date });

      res.json({ shiftRequest: row });
    } catch (error) {
      console.error('Shift request error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // GET /api/scheduling/shift-requests — admin sees all; a client sees theirs.
  router.get('/api/scheduling/shift-requests', authenticateToken, async (req, res) => {
    try {
      const rows = await readRows('shift_requests');
      let mine;
      if (isAdmin(req.user)) mine = rows;
      else if (req.user.role === ROLES.CLIENT) mine = rows.filter(r => r && r.client_id === req.user.id);
      else if (req.user.role === ROLES.FAMILY) mine = rows.filter(r => r && r.client_id === req.user.familyOfClientId);
      else return res.status(403).json({ error: 'Access denied.', code: 'REQUEST_READ_DENIED' });
      mine = mine.slice().sort((a, b) => String(b.requested_at || '').localeCompare(String(a.requested_at || '')));
      res.json({ shiftRequests: mine.slice(0, 200) });
    } catch (error) {
      console.error('Shift request list error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // ==========================================================================
  // SHIFTS
  // ==========================================================================

  // POST /api/scheduling/shifts — admin posts a shift, optionally from a client
  // request (which the post then resolves), and optionally straight to a named
  // caregiver via `assignToCaregiverId`.
  //
  // Posting to one caregiver is Pathway B's entry point in ONE step rather than
  // post-then-assign. It lands the shift at `assigned`, NOT `confirmed`: the
  // caregiver still accepts or declines, and a decline returns it to the open
  // pool. Admin schedules the work; the caregiver still agrees to it.
  //
  // Eligibility and overlap are checked BEFORE anything is written, so a
  // refused direct post leaves no orphan open shift behind.
  router.post('/api/scheduling/shifts', authenticateToken, requireAdmin, async (req, res) => {
    try {
      const { valid, errors, clean } = sched.validateShift(req.body);
      if (!valid) return res.status(400).json({ error: 'Some shift details need correcting.', code: 'SHIFT_INVALID', errors });

      const client = await loadClient(clean.clientId);
      if (!client) return res.status(404).json({ error: 'Client not found.', code: 'CLIENT_NOT_FOUND' });

      const assignToId = String((req.body || {}).assignToCaregiverId || '').trim();
      let assignee = null;
      if (assignToId) {
        assignee = await freshUser(assignToId);
        if (!assignee || !isSchedulable(assignee)) {
          return res.status(400).json({ error: 'Pick a caregiver with a license level on file.', code: 'CAREGIVER_INVALID' });
        }
      }

      const rows = await readRows('shifts');
      const row = {
        id: uuidv4(),
        client_id: client.id,
        client_name: client.name,
        caregiver_id: null,
        caregiver_name: null,
        start: clean.start,
        end: clean.end,
        required_license_level: clean.requiredLicenseLevel,
        pool_visibility: clean.poolVisibility,
        care_tier: clean.careTier || client.careTier || null,
        notes: clean.notes,
        status: 'open',
        created_by: req.user.id,
        created_by_name: req.user.name || req.user.email,
        created_at: nowIso(),
        claimed_at: null, assigned_at: null, confirmed_at: null,
        started_at: null, completed_at: null, cancelled_at: null, reopened_at: null
      };

      if (assignee) {
        if (!sched.isEligibleForShift(assignee, row, client)) {
          return res.status(409).json({
            error: `${assignee.name} cannot take that shift.`, code: 'SHIFT_NOT_ELIGIBLE',
            reason: sched.eligibilityReason(assignee, row, client)
          });
        }
        const conflict = sched.findShiftConflict(rows, assignee.id, row);
        if (conflict) {
          return res.status(409).json({
            error: `${assignee.name} already holds an overlapping shift.`, code: 'SHIFT_CONFLICT',
            conflict: { id: conflict.id, start: conflict.start, end: conflict.end, clientName: conflict.client_name }
          });
        }
        row.status = 'assigned';
        row.assigned_at = nowIso();
        row.caregiver_id = assignee.id;
        row.caregiver_name = assignee.name;
      }

      rows.push(row);
      await db.set('shifts', rows);

      // Resolve the originating request, if this post answers one.
      if (req.body.shiftRequestId) {
        const requests = await readRows('shift_requests');
        const ri = requests.findIndex(r => r && r.id === req.body.shiftRequestId);
        if (ri !== -1 && sched.canTransitionRequest(requests[ri].status, 'posted')) {
          requests[ri].status = 'posted';
          requests[ri].resolved_at = nowIso();
          requests[ri].shift_id = row.id;
          await db.set('shift_requests', requests);
        }
      }

      await logActivity(req.user.id, row.created_by_name, 'shift_posted', 'shift', row.id,
        {
          clientId: client.id, start: row.start,
          requiredLicenseLevel: row.required_license_level,
          openToAllLevels: sched.isOpenToAllLevels(row),
          assignedTo: assignee ? assignee.id : null
        });

      if (assignee) {
        await logActivity(req.user.id, row.created_by_name, 'shift_assigned', 'shift', row.id,
          { clientId: client.id, caregiverId: assignee.id, postedDirectly: true });
        if (assignee.email) {
          await queueNotification('shift_assigned', assignee.id, assignee.email, assignee.name,
            {
              subject: `New shift offered — ${row.client_name}`,
              body: `You have been offered the ${new Date(row.start).toLocaleString('en-US')} shift for ${row.client_name}. Accept or decline it in your schedule.`,
              ctaUrl: '/caregiver', ctaLabel: 'Open the caregiver app'
            },
            { relatedEntityId: row.id, relatedEntityType: 'shift', createdBy: req.user.id });
        }
      }

      res.json({
        shift: publicShift(row),
        message: assignee
          ? `Shift offered to ${assignee.name}. It is theirs once they accept; a decline puts it back in the open pool.`
          : (sched.isOpenToAllLevels(row)
            ? 'Shift posted to the open pool, open to all license levels.'
            : `Shift posted to the open pool — ${sched.shiftLevelLabel(row)}.`)
      });
    } catch (error) {
      console.error('Shift post error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // GET /api/scheduling/shifts — the master calendar for admin; for a caregiver,
  // ONLY their own shifts. A caregiver cannot read another caregiver's shifts.
  router.get('/api/scheduling/shifts', authenticateToken, async (req, res) => {
    try {
      if (!isAdmin(req.user) && !isSchedulable(req.user)) {
        return res.status(403).json({ error: 'Caregiver or clinical access required.', code: 'SCHEDULING_STAFF_ONLY' });
      }
      const rows = await readRows('shifts');
      let mine = isAdmin(req.user) ? rows : rows.filter(r => r && r.caregiver_id === req.user.id);
      if (req.query.status) mine = mine.filter(r => r.status === String(req.query.status));
      if (req.query.from) mine = mine.filter(r => String(r.start) >= String(req.query.from));
      if (req.query.to) mine = mine.filter(r => String(r.start) <= String(req.query.to));
      if (isAdmin(req.user) && req.query.clientId) mine = mine.filter(r => r.client_id === String(req.query.clientId));
      mine = mine.slice().sort((a, b) => String(a.start).localeCompare(String(b.start)));
      res.json({ shifts: mine.slice(0, 500).map(publicShift) });
    } catch (error) {
      console.error('Shift list error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // GET /api/scheduling/shifts/open — the open pool, filtered to what THIS
  // caregiver is eligible for. Ineligible shifts are not returned at all.
  router.get('/api/scheduling/shifts/open', authenticateToken, requireSchedulable, async (req, res) => {
    try {
      const me = await freshUser(req.user.id);
      const users = await getUsers();
      const clientsById = new Map(users.filter(u => u.role === ROLES.CLIENT).map(u => [u.id, u]));
      const rows = await readRows('shifts');
      const open = rows
        .filter(r => r && r.status === 'open')
        .filter(r => sched.isEligibleForShift(me, r, clientsById.get(r.client_id)))
        .sort((a, b) => String(a.start).localeCompare(String(b.start)));
      res.json({ shifts: open.slice(0, 200).map(publicShift) });
    } catch (error) {
      console.error('Open pool error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // Shared by every lifecycle route. Loads the shift, checks the transition is
  // legal, and REFUSES with a specific code rather than coercing.
  const moveShift = async ({ shiftId, to, actor, guard }) => {
    const rows = await readRows('shifts');
    const idx = rows.findIndex(r => r && r.id === shiftId);
    if (idx === -1) return { error: { status: 404, body: { error: 'Shift not found.', code: 'SHIFT_NOT_FOUND' } } };
    const shift = rows[idx];

    if (guard) {
      const refusal = await guard(shift);
      if (refusal) return { error: refusal };
    }

    const refusal = sched.transitionRefusal(shift.status, to);
    if (refusal) {
      return { error: { status: 409, body: { ...refusal, from: shift.status, to } } };
    }

    shift.status = to;
    const stamp = sched.SHIFT_STATUS_TIMESTAMP[to];
    if (stamp) shift[stamp] = nowIso();
    rows[idx] = shift;
    await db.set('shifts', rows);
    await logActivity(actor.id, actor.name || actor.email, `shift_${to}`, 'shift', shift.id,
      { role: actor.role, clientId: shift.client_id, caregiverId: shift.caregiver_id, from: refusal ? null : to });
    return { shift, rows };
  };

  // --- Pathway A: caregiver claims. A CLAIM DOES NOT CONFIRM THE SHIFT. ---
  router.post('/api/scheduling/shifts/:id/claim', authenticateToken, requireSchedulable, async (req, res) => {
    try {
      const me = await freshUser(req.user.id);
      const shiftsAll = await readRows('shifts');
      const target = shiftsAll.find(r => r && r.id === req.params.id);
      if (!target) return res.status(404).json({ error: 'Shift not found.', code: 'SHIFT_NOT_FOUND' });

      const client = await loadClient(target.client_id);
      if (!sched.isEligibleForShift(me, target, client)) {
        return res.status(403).json({
          error: 'That shift is not open to you.', code: 'SHIFT_NOT_ELIGIBLE',
          reason: sched.eligibilityReason(me, target, client)
        });
      }
      const conflict = sched.findShiftConflict(shiftsAll, me.id, target);
      if (conflict) {
        return res.status(409).json({
          error: 'You already hold a shift that overlaps this one.', code: 'SHIFT_CONFLICT',
          conflict: { id: conflict.id, start: conflict.start, end: conflict.end, clientName: conflict.client_name }
        });
      }

      const result = await moveShift({ shiftId: req.params.id, to: 'claimed', actor: req.user });
      if (result.error) return res.status(result.error.status).json(result.error.body);

      const rows = result.rows;
      const idx = rows.findIndex(r => r.id === req.params.id);
      rows[idx].caregiver_id = me.id;
      rows[idx].caregiver_name = me.name;
      await db.set('shifts', rows);

      // Admin decides. The caregiver is told plainly that it is not yet theirs.
      for (const admin of (await getUsers()).filter(u => u.role === ROLES.ADMIN && u.email)) {
        await queueNotification('shift_claimed', admin.id, admin.email, admin.name,
          {
            subject: `Shift claim awaiting approval — ${rows[idx].client_name}`,
            body: `${me.name} claimed the ${new Date(rows[idx].start).toLocaleString('en-US')} shift for ${rows[idx].client_name}. Approve or decline it in Scheduling.`,
            ctaUrl: '/scheduling', ctaLabel: 'Open scheduling'
          },
          { relatedEntityId: rows[idx].id, relatedEntityType: 'shift', createdBy: me.id });
      }

      res.json({
        shift: publicShift(rows[idx]),
        message: 'Claim submitted. An administrator approves it before the shift is yours.'
      });
    } catch (error) {
      console.error('Shift claim error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // Admin approves a claim → confirmed. Both parties notified.
  router.post('/api/scheduling/shifts/:id/approve', authenticateToken, requireAdmin, async (req, res) => {
    try {
      const result = await moveShift({
        shiftId: req.params.id, to: 'confirmed', actor: req.user,
        guard: (shift) => shift.status !== 'claimed'
          ? { status: 409, body: { error: 'Only a claimed shift is approved. Use assign for a direct booking.', code: 'SHIFT_NOT_CLAIMED', from: shift.status } }
          : null
      });
      if (result.error) return res.status(result.error.status).json(result.error.body);
      await notifyConfirmed(result.shift, req.user);
      res.json({ shift: publicShift(result.shift) });
    } catch (error) {
      console.error('Shift approve error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // Admin declines a claim → back to the open pool, caregiver cleared.
  router.post('/api/scheduling/shifts/:id/decline-claim', authenticateToken, requireAdmin, async (req, res) => {
    try {
      const result = await moveShift({
        shiftId: req.params.id, to: 'open', actor: req.user,
        guard: (shift) => shift.status !== 'claimed'
          ? { status: 409, body: { error: 'That shift is not awaiting a claim decision.', code: 'SHIFT_NOT_CLAIMED', from: shift.status } }
          : null
      });
      if (result.error) return res.status(result.error.status).json(result.error.body);
      await releaseCaregiver(result.rows, req.params.id, String((req.body || {}).reason || '').trim());
      res.json({ shift: publicShift((await readRows('shifts')).find(r => r.id === req.params.id)) });
    } catch (error) {
      console.error('Shift decline-claim error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // --- Pathway B: admin assigns directly; the caregiver accepts or declines ---
  router.post('/api/scheduling/shifts/:id/assign', authenticateToken, requireAdmin, async (req, res) => {
    try {
      const caregiverId = String((req.body || {}).caregiverId || '');
      const caregiver = await freshUser(caregiverId);
      if (!caregiver || !isSchedulable(caregiver)) {
        return res.status(400).json({ error: 'Pick a caregiver with a license level on file.', code: 'CAREGIVER_INVALID' });
      }

      const shiftsAll = await readRows('shifts');
      const target = shiftsAll.find(r => r && r.id === req.params.id);
      if (!target) return res.status(404).json({ error: 'Shift not found.', code: 'SHIFT_NOT_FOUND' });

      const client = await loadClient(target.client_id);
      if (!sched.isEligibleForShift(caregiver, target, client)) {
        return res.status(409).json({
          error: `${caregiver.name} cannot take that shift.`, code: 'SHIFT_NOT_ELIGIBLE',
          reason: sched.eligibilityReason(caregiver, target, client)
        });
      }
      const conflict = sched.findShiftConflict(shiftsAll, caregiver.id, target);
      if (conflict) {
        return res.status(409).json({
          error: `${caregiver.name} already holds an overlapping shift.`, code: 'SHIFT_CONFLICT',
          conflict: { id: conflict.id, start: conflict.start, end: conflict.end, clientName: conflict.client_name }
        });
      }

      const result = await moveShift({ shiftId: req.params.id, to: 'assigned', actor: req.user });
      if (result.error) return res.status(result.error.status).json(result.error.body);

      const rows = result.rows;
      const idx = rows.findIndex(r => r.id === req.params.id);
      rows[idx].caregiver_id = caregiver.id;
      rows[idx].caregiver_name = caregiver.name;
      await db.set('shifts', rows);

      if (caregiver.email) {
        await queueNotification('shift_assigned', caregiver.id, caregiver.email, caregiver.name,
          {
            subject: `New shift offered — ${rows[idx].client_name}`,
            body: `You have been offered the ${new Date(rows[idx].start).toLocaleString('en-US')} shift for ${rows[idx].client_name}. Accept or decline it in your schedule.`,
            ctaUrl: '/caregiver', ctaLabel: 'Open the caregiver app'
          },
          { relatedEntityId: rows[idx].id, relatedEntityType: 'shift', createdBy: req.user.id });
      }

      res.json({ shift: publicShift(rows[idx]) });
    } catch (error) {
      console.error('Shift assign error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // Caregiver accepts an assignment → confirmed.
  router.post('/api/scheduling/shifts/:id/accept', authenticateToken, requireSchedulable, async (req, res) => {
    try {
      const result = await moveShift({
        shiftId: req.params.id, to: 'confirmed', actor: req.user,
        guard: (shift) => {
          if (shift.caregiver_id !== req.user.id) {
            return { status: 403, body: { error: 'That shift is not yours.', code: 'SHIFT_NOT_YOURS' } };
          }
          if (shift.status !== 'assigned') {
            return { status: 409, body: { error: 'That shift is not awaiting your acceptance.', code: 'SHIFT_NOT_ASSIGNED', from: shift.status } };
          }
          return null;
        }
      });
      if (result.error) return res.status(result.error.status).json(result.error.body);
      await notifyConfirmed(result.shift, req.user);
      res.json({ shift: publicShift(result.shift) });
    } catch (error) {
      console.error('Shift accept error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // Caregiver declines an assignment → the shift RETURNS TO THE OPEN POOL.
  router.post('/api/scheduling/shifts/:id/decline', authenticateToken, requireSchedulable, async (req, res) => {
    try {
      const result = await moveShift({
        shiftId: req.params.id, to: 'open', actor: req.user,
        guard: (shift) => {
          if (shift.caregiver_id !== req.user.id) {
            return { status: 403, body: { error: 'That shift is not yours.', code: 'SHIFT_NOT_YOURS' } };
          }
          if (shift.status !== 'assigned') {
            return { status: 409, body: { error: 'Only an offered shift can be declined.', code: 'SHIFT_NOT_ASSIGNED', from: shift.status } };
          }
          return null;
        }
      });
      if (result.error) return res.status(result.error.status).json(result.error.body);
      await releaseCaregiver(result.rows, req.params.id, String((req.body || {}).reason || '').trim());

      for (const admin of (await getUsers()).filter(u => u.role === ROLES.ADMIN && u.email)) {
        await queueNotification('shift_declined', admin.id, admin.email, admin.name,
          {
            subject: `Shift declined — back in the open pool`,
            body: `${req.user.name} declined the ${new Date(result.shift.start).toLocaleString('en-US')} shift for ${result.shift.client_name}. It is open again.`,
            ctaUrl: '/scheduling', ctaLabel: 'Open scheduling'
          },
          { relatedEntityId: `${result.shift.id}:declined`, relatedEntityType: 'shift', createdBy: req.user.id });
      }

      res.json({ shift: publicShift((await readRows('shifts')).find(r => r.id === req.params.id)) });
    } catch (error) {
      console.error('Shift decline error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // Admin cancels a shift.
  router.post('/api/scheduling/shifts/:id/cancel', authenticateToken, requireAdmin, async (req, res) => {
    try {
      const reason = String((req.body || {}).reason || '').trim();
      if (!reason) return res.status(400).json({ error: 'Say why the shift is cancelled.', code: 'CANCEL_REASON_REQUIRED' });
      const result = await moveShift({ shiftId: req.params.id, to: 'cancelled', actor: req.user });
      if (result.error) return res.status(result.error.status).json(result.error.body);
      const rows = await readRows('shifts');
      const idx = rows.findIndex(r => r.id === req.params.id);
      rows[idx].cancel_reason = reason.slice(0, 1000);
      await db.set('shifts', rows);
      res.json({ shift: publicShift(rows[idx]) });
    } catch (error) {
      console.error('Shift cancel error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  });

  const releaseCaregiver = async (rowsIn, shiftId, reason) => {
    const rows = rowsIn || await readRows('shifts');
    const idx = rows.findIndex(r => r && r.id === shiftId);
    if (idx === -1) return;
    // The person is cleared, but WHO let it go is kept — otherwise a shift that
    // bounced three times looks the same as one nobody ever touched.
    rows[idx].released_from_id = rows[idx].caregiver_id;
    rows[idx].released_from_name = rows[idx].caregiver_name;
    rows[idx].released_reason = reason ? reason.slice(0, 1000) : null;
    rows[idx].caregiver_id = null;
    rows[idx].caregiver_name = null;
    await db.set('shifts', rows);
  };

  // Both parties are told on confirmation — the caregiver and the client.
  const notifyConfirmed = async (shift, actor) => {
    const users = await getUsers();
    const when = new Date(shift.start).toLocaleString('en-US');
    const caregiver = users.find(u => u.id === shift.caregiver_id);
    if (caregiver && caregiver.email) {
      await queueNotification('shift_confirmed', caregiver.id, caregiver.email, caregiver.name,
        {
          subject: `Shift confirmed — ${shift.client_name}`,
          body: `Your ${when} shift for ${shift.client_name} is confirmed.`,
          ctaUrl: '/caregiver', ctaLabel: 'Open the caregiver app'
        },
        { relatedEntityId: `${shift.id}:confirmed`, relatedEntityType: 'shift', createdBy: actor.id });
    }
    const client = users.find(u => u.id === shift.client_id);
    if (client && client.email) {
      await queueNotification('shift_confirmed_client', client.id, client.email, client.name,
        {
          subject: 'Your care visit is confirmed',
          body: `${shift.caregiver_name || 'A caregiver'} is confirmed for ${when}.`,
          ctaUrl: '/portal', ctaLabel: 'Open your portal'
        },
        { relatedEntityId: `${shift.id}:confirmed-client`, relatedEntityType: 'shift', createdBy: actor.id });
    }
  };

  // ==========================================================================
  // TIME TRACKING
  // ==========================================================================

  // POST /api/scheduling/shifts/:id/clock-in — only on a CONFIRMED shift.
  // An out-of-geofence clock-in SUCCEEDS and is flagged; it is never blocked.
  router.post('/api/scheduling/shifts/:id/clock-in', authenticateToken, requireSchedulable, async (req, res) => {
    try {
      const rows = await readRows('shifts');
      const idx = rows.findIndex(r => r && r.id === req.params.id);
      if (idx === -1) return res.status(404).json({ error: 'Shift not found.', code: 'SHIFT_NOT_FOUND' });
      const shift = rows[idx];

      if (shift.caregiver_id !== req.user.id) {
        return res.status(403).json({ error: 'That shift is not yours.', code: 'SHIFT_NOT_YOURS' });
      }
      if (shift.status !== 'confirmed') {
        return res.status(409).json({
          error: shift.status === 'in_progress'
            ? 'You are already clocked in for that shift.'
            : 'You can only clock in on a confirmed shift.',
          code: shift.status === 'in_progress' ? 'ALREADY_CLOCKED_IN' : 'SHIFT_NOT_CONFIRMED',
          from: shift.status
        });
      }

      const client = await loadClient(shift.client_id);
      const at = nowIso();
      const gps = normalizeGps((req.body || {}).gps);
      const { flags, geo } = sched.clockInFlags({ shift, client, gps, at });

      const logs = await readRows('time_logs');
      const row = {
        id: uuidv4(),
        shift_id: shift.id,
        client_id: shift.client_id,
        client_name: shift.client_name,
        caregiver_id: req.user.id,
        caregiver_name: req.user.name || req.user.email,
        license_level: req.user.licenseLevel || null,
        scheduled_start: shift.start,
        scheduled_end: shift.end,
        clock_in_at: at,
        clock_in_gps: gps,
        clock_in_geofence: geo,
        clock_out_at: null,
        clock_out_gps: null,
        clock_out_geofence: null,
        total_minutes: null,
        flags,
        edited: false,
        edit_reason: null,
        created_at: at
      };
      logs.push(row);
      await db.set('time_logs', logs);

      shift.status = 'in_progress';
      shift.started_at = at;
      rows[idx] = shift;
      await db.set('shifts', rows);

      await logActivity(req.user.id, row.caregiver_name, 'clock_in', 'time_log', row.id,
        { shiftId: shift.id, clientId: shift.client_id, flags, geofence: geo.verdict, distanceMeters: geo.distance });

      res.json({
        timeLog: publicTimeLog(row),
        shift: publicShift(shift),
        // The caregiver is told plainly when something was flagged. A silent
        // flag is an admin surprise later and a caregiver who cannot explain it.
        flagged: flags.length > 0,
        message: flags.includes('outside_geofence')
          ? `Clocked in. You are ${geo.distance}m from the client's address, so this is flagged for the office — no action needed if you are out with the client.`
          : 'Clocked in.'
      });
    } catch (error) {
      console.error('Clock-in error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  });

  router.post('/api/scheduling/shifts/:id/clock-out', authenticateToken, requireSchedulable, async (req, res) => {
    try {
      const rows = await readRows('shifts');
      const idx = rows.findIndex(r => r && r.id === req.params.id);
      if (idx === -1) return res.status(404).json({ error: 'Shift not found.', code: 'SHIFT_NOT_FOUND' });
      const shift = rows[idx];

      if (shift.caregiver_id !== req.user.id) {
        return res.status(403).json({ error: 'That shift is not yours.', code: 'SHIFT_NOT_YOURS' });
      }
      if (shift.status !== 'in_progress') {
        return res.status(409).json({ error: 'You are not clocked in on that shift.', code: 'SHIFT_NOT_IN_PROGRESS', from: shift.status });
      }

      const logs = await readRows('time_logs');
      const li = logs.findIndex(l => l && l.shift_id === shift.id && !l.clock_out_at);
      if (li === -1) return res.status(409).json({ error: 'No open clock-in for that shift.', code: 'NO_OPEN_TIME_LOG' });

      const client = await loadClient(shift.client_id);
      const at = nowIso();
      const gps = normalizeGps((req.body || {}).gps);
      const { flags, geo } = sched.clockOutFlags({ shift, client, gps, at });

      const log = logs[li];
      log.clock_out_at = at;
      log.clock_out_gps = gps;
      log.clock_out_geofence = geo;
      log.total_minutes = sched.totalMinutes(log.clock_in_at, at);
      log.flags = Array.from(new Set((log.flags || []).concat(flags)));
      logs[li] = log;
      await db.set('time_logs', logs);

      shift.status = 'completed';
      shift.completed_at = at;
      rows[idx] = shift;
      await db.set('shifts', rows);

      await logActivity(req.user.id, log.caregiver_name, 'clock_out', 'time_log', log.id,
        { shiftId: shift.id, clientId: shift.client_id, totalMinutes: log.total_minutes, flags: log.flags });

      res.json({ timeLog: publicTimeLog(log), shift: publicShift(shift), flagged: log.flags.length > 0 });
    } catch (error) {
      console.error('Clock-out error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // GET /api/scheduling/time-logs — a caregiver sees THEIR OWN history only.
  router.get('/api/scheduling/time-logs', authenticateToken, async (req, res) => {
    try {
      if (!isAdmin(req.user) && !isSchedulable(req.user)) {
        return res.status(403).json({ error: 'Caregiver or clinical access required.', code: 'SCHEDULING_STAFF_ONLY' });
      }
      const logs = await readRows('time_logs');
      let mine = isAdmin(req.user) ? logs : logs.filter(l => l && l.caregiver_id === req.user.id);
      if (isAdmin(req.user) && req.query.caregiverId) mine = mine.filter(l => l.caregiver_id === String(req.query.caregiverId));
      if (req.query.from) mine = mine.filter(l => String(l.clock_in_at) >= String(req.query.from));
      if (req.query.to) mine = mine.filter(l => String(l.clock_in_at) <= `${req.query.to}T23:59:59.999Z`);
      if (req.query.flagged === 'true') mine = mine.filter(l => (l.flags || []).length > 0);
      mine = mine.slice().sort((a, b) => String(b.clock_in_at).localeCompare(String(a.clock_in_at)));

      const totals = mine.reduce((acc, l) => acc + (l.total_minutes || 0), 0);
      res.json({
        timeLogs: mine.slice(0, 500).map(publicTimeLog),
        totalMinutes: totals,
        totalHours: sched.minutesToHours(totals)
      });
    } catch (error) {
      console.error('Time-log list error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // PUT /api/scheduling/time-logs/:id — admin correction. A REASON IS
  // MANDATORY, and the before/after goes to the activity log. There is no path
  // that edits a time log without leaving that trail.
  router.put('/api/scheduling/time-logs/:id', authenticateToken, requireAdmin, async (req, res) => {
    try {
      const body = req.body || {};
      const reason = String(body.reason || '').trim();
      if (!reason) {
        return res.status(400).json({ error: 'A time-log edit needs a reason.', code: 'EDIT_REASON_REQUIRED' });
      }

      const logs = await readRows('time_logs');
      const idx = logs.findIndex(l => l && l.id === req.params.id);
      if (idx === -1) return res.status(404).json({ error: 'Time log not found.', code: 'TIME_LOG_NOT_FOUND' });
      const log = logs[idx];

      const before = { clockInAt: log.clock_in_at, clockOutAt: log.clock_out_at, totalMinutes: log.total_minutes };
      const nextIn = body.clockInAt !== undefined ? isoOrNull(body.clockInAt) : log.clock_in_at;
      const nextOut = body.clockOutAt !== undefined ? isoOrNull(body.clockOutAt) : log.clock_out_at;
      if (body.clockInAt !== undefined && !nextIn) {
        return res.status(400).json({ error: 'That clock-in time is not a valid timestamp.', code: 'CLOCK_IN_INVALID' });
      }
      if (body.clockOutAt !== undefined && body.clockOutAt !== null && !nextOut) {
        return res.status(400).json({ error: 'That clock-out time is not a valid timestamp.', code: 'CLOCK_OUT_INVALID' });
      }
      if (nextIn && nextOut && new Date(nextOut).getTime() < new Date(nextIn).getTime()) {
        return res.status(400).json({ error: 'The clock-out is before the clock-in.', code: 'CLOCK_OUT_BEFORE_IN' });
      }

      log.clock_in_at = nextIn;
      log.clock_out_at = nextOut;
      log.total_minutes = sched.totalMinutes(nextIn, nextOut);
      log.edited = true;
      log.edit_reason = reason.slice(0, 1000);
      log.edited_by = req.user.id;
      log.edited_by_name = req.user.name || req.user.email;
      log.edited_at = nowIso();
      log.flags = Array.from(new Set((log.flags || []).concat('admin_edited')));
      logs[idx] = log;
      await db.set('time_logs', logs);

      const after = { clockInAt: log.clock_in_at, clockOutAt: log.clock_out_at, totalMinutes: log.total_minutes };

      // Append-only edit trail alongside the activity entry, so the sequence of
      // corrections survives even if the log row is corrected again.
      const edits = await readRows('time_log_edits');
      edits.push({
        id: uuidv4(), time_log_id: log.id, before, after, reason: log.edit_reason,
        by: req.user.id, by_name: log.edited_by_name, at: log.edited_at
      });
      await db.set('time_log_edits', edits);

      await logActivity(req.user.id, log.edited_by_name, 'time_log_edited', 'time_log', log.id,
        { reason: log.edit_reason, before, after, caregiverId: log.caregiver_id, shiftId: log.shift_id });

      res.json({ timeLog: publicTimeLog(log), before, after });
    } catch (error) {
      console.error('Time-log edit error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // GET /api/scheduling/payroll.csv — admin only, date range.
  router.get('/api/scheduling/payroll.csv', authenticateToken, requireAdmin, async (req, res) => {
    try {
      const from = String(req.query.from || '');
      const to = String(req.query.to || '');
      if (!sched.isIsoDate(from) || !sched.isIsoDate(to)) {
        return res.status(400).json({ error: 'Give a from and to date (YYYY-MM-DD).', code: 'DATE_RANGE_REQUIRED' });
      }
      if (to < from) return res.status(400).json({ error: 'The end date is before the start date.', code: 'DATE_RANGE_INVERTED' });

      const logs = (await readRows('time_logs')).filter(l => {
        const d = String(l.clock_in_at || '').slice(0, 10);
        return d >= from && d <= to;
      }).sort((a, b) => String(a.clock_in_at).localeCompare(String(b.clock_in_at)));

      const rows = logs.map(l => {
        const shiftDate = String(l.clock_in_at || '').slice(0, 10);
        const period = sched.payPeriodFor(shiftDate) || { start: '', end: '' };
        return {
          caregiverName: l.caregiver_name,
          licenseLevel: l.license_level ? cg.LICENSE_LABELS[l.license_level] || l.license_level : '',
          clientName: l.client_name,
          shiftDate,
          scheduledStart: l.scheduled_start,
          scheduledEnd: l.scheduled_end,
          clockInAt: l.clock_in_at,
          clockOutAt: l.clock_out_at || '',
          hours: sched.minutesToHours(l.total_minutes),
          flags: (l.flags || []).join(' '),
          edited: l.edited ? 'yes' : '',
          editReason: l.edit_reason || '',
          payPeriodStart: period.start,
          payPeriodEnd: period.end
        };
      });

      await logActivity(req.user.id, req.user.name || req.user.email, 'payroll_csv_exported', 'time_log', null,
        { from, to, rows: rows.length });

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="gfc_payroll_${from}_to_${to}.csv"`);
      res.send(sched.toPayrollCsv(rows));
    } catch (error) {
      console.error('Payroll CSV error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // GET /api/scheduling/caregivers — admin picker: who can hold a shift.
  router.get('/api/scheduling/caregivers', authenticateToken, requireAdmin, async (req, res) => {
    try {
      const users = await getUsers();
      res.json({
        caregivers: users.filter(isSchedulable).map(u => ({
          id: u.id, name: u.name,
          licenseLevel: cg.normalizeLevel(u.licenseLevel),
          licenseLabel: cg.LICENSE_LABELS[cg.normalizeLevel(u.licenseLevel)] || null,
          accountStatus: u.accountStatus || 'active',
          isClinician: !!u.hasClinicalAccess
        })),
        clients: users.filter(u => u.role === ROLES.CLIENT).map(u => ({
          id: u.id, name: u.name, careTier: u.careTier || null,
          geofenceRadiusMeters: sched.geofenceRadiusFor(u),
          hasCoordinates: !!sched.clientCoords(u)
        }))
      });
    } catch (error) {
      console.error('Scheduling roster error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // ---- Shapers ------------------------------------------------------------
  const publicAvailability = (r) => ({
    id: r.id, caregiverId: r.caregiver_id, caregiverName: r.caregiver_name,
    licenseLevel: r.license_level, effectiveFrom: r.effective_from,
    windows: r.windows, blackoutDates: r.blackout_dates, note: r.note,
    status: r.status, submittedAt: r.submitted_at,
    reviewedAt: r.reviewed_at, reviewedByName: r.reviewed_by_name
  });

  const publicShift = (r) => r && ({
    id: r.id, clientId: r.client_id, clientName: r.client_name,
    caregiverId: r.caregiver_id, caregiverName: r.caregiver_name,
    start: r.start, end: r.end,
    requiredLicenseLevel: r.required_license_level,
    // Stated, never inferred from a falsy field: a shift open to every level
    // says so in both UIs rather than simply omitting a "needs CNA" line.
    openToAllLevels: sched.isOpenToAllLevels(r),
    levelRequirementLabel: sched.shiftLevelLabel(r),
    poolVisibility: r.pool_visibility, careTier: r.care_tier, notes: r.notes,
    status: r.status,
    createdByName: r.created_by_name, createdAt: r.created_at,
    claimedAt: r.claimed_at, assignedAt: r.assigned_at, confirmedAt: r.confirmed_at,
    startedAt: r.started_at, completedAt: r.completed_at,
    cancelledAt: r.cancelled_at, cancelReason: r.cancel_reason || null,
    reopenedAt: r.reopened_at,
    releasedFromName: r.released_from_name || null, releasedReason: r.released_reason || null
  });

  const publicTimeLog = (l) => ({
    id: l.id, shiftId: l.shift_id, clientName: l.client_name,
    caregiverId: l.caregiver_id, caregiverName: l.caregiver_name,
    scheduledStart: l.scheduled_start, scheduledEnd: l.scheduled_end,
    clockInAt: l.clock_in_at, clockOutAt: l.clock_out_at,
    clockInGeofence: l.clock_in_geofence, clockOutGeofence: l.clock_out_geofence,
    totalMinutes: l.total_minutes, totalHours: sched.minutesToHours(l.total_minutes),
    flags: l.flags || [],
    edited: !!l.edited, editReason: l.edit_reason || null,
    editedByName: l.edited_by_name || null, editedAt: l.edited_at || null
  });

  const normalizeGps = (gps) => {
    if (!gps || typeof gps !== 'object') return null;
    const lat = Number(gps.lat), lng = Number(gps.lng);
    if (!isFinite(lat) || !isFinite(lng)) return null;
    const accuracy = Number(gps.accuracy);
    return { lat, lng, accuracy: isFinite(accuracy) ? Math.round(accuracy) : null };
  };

  const isoOrNull = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d.toISOString();
  };

  return router;
};
