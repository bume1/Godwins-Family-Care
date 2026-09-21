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
const links = require('../appLinks');   // where each person actually goes
const time = require('../public/gfc-time');   // every time shown is Eastern
const { contentDisposition } = require('../contentDisposition');
const sched = require('../schedulingRepository');
const wpRepo = require('../welcomePacketRepository');
const onboardingGate = require('../caregiverOnboardingGate');
const cg = require('../caregiverRepository');
const gate = require('../enrollmentGate');
// The office number. ORG in public/consent-text.js is the single source — it is
// what prints into executed consent documents, so a refusal that tells a
// caregiver to call cannot give a different number from the paperwork.
const { ORG } = require('../public/consent-text');

module.exports = function createSchedulingRoutes(deps) {
  const { db, config, logActivity, queueNotification, getUsers, authenticateToken, uuidv4 } = deps;
  const router = express.Router();

  const ROLES = config.ROLES;

  // ---- THE CAREGIVER CLEARANCE GATE (2026-09-13) --------------------------
  // Georgia requires a caregiver to be fully cleared before working in a
  // client's home, so committing one to a shift checks it. The rule lives in
  // caregiverOnboardingGate.js — this is the only place scheduling reads it,
  // and it reads it rather than restating it, for the same reason the client
  // enrollment gate is one module: a gate written twice disagrees with itself.
  //
  // IT GATES COMMITTING A CAREGIVER, never finishing work already in flight.
  // Clock-in and clock-out are deliberately untouched: care that was given gets
  // documented and paid whatever the paperwork says.
  const clearanceStateFor = async (caregiver) => {
    const packets = (await db.get('welcome_packets')) || [];
    const packet = packets.find(r => r && r.caregiver_id === caregiver.id) || null;
    const documents = ((await db.get('caregiver_documents')) || [])
      .filter(r => r && r.caregiver_id === caregiver.id);
    // The signable forms count toward shift clearance like every other item.
    // Omitting them here would refuse a caregiver who is genuinely cleared.
    const attestations = ((await db.get('caregiver_attestations')) || [])
      .filter(r => r && r.caregiver_id === caregiver.id);
    const checklist = wpRepo.buildChecklist((packet || {}).data, documents, (packet || {}).office, attestations);
    return { packet, checklist };
  };

  const checkCaregiverCleared = async (caregiver, req) => {
    const { packet, checklist } = await clearanceStateFor(caregiver);
    return onboardingGate.checkClearanceAllowed(
      caregiver, packet, checklist, req.body || {}, req.user, req.user.role === ROLES.ADMIN);
  };

  const nowIso = () => new Date().toISOString();
  const readRows = async (key) => (await db.get(key)) || [];

  // ---- Guards -------------------------------------------------------------
  const requireAdmin = (req, res, next) => {
    if (req.user.role === ROLES.ADMIN) return next();
    return res.status(403).json({ error: 'Administrator access required.', code: 'ADMIN_ONLY' });
  };

  // WHO RUNS THE BOARD (owner instruction, 2026-09-20): "editable by admin and
  // manager". Scheduling had been admin-only throughout, and the 2026-09-13
  // dashboard entry left the manager question open for the owner precisely
  // here. This is that question answered, so `isManager` now means something on
  // this surface rather than collapsing silently into admin.
  //
  // It covers THE WORK OF SCHEDULING — posting, editing, assigning, approving a
  // claim, cancelling, and reading the board to do any of it. It deliberately
  // does NOT cover three things that are admin's alone:
  //   the money      — payroll and billing exports, manual hours, time-log
  //                    corrections: those are payroll attestations, not shifts;
  //   the client record — the location/geofence write edits a client, and a
  //                    scheduling role has no business in a client's address;
  //   the overrides  — scheduling a client who is not enrolled, or a caregiver
  //                    who is not cleared, is a compliance decision, not a
  //                    scheduling one.
  // A manager who tries one is refused by the route, not merely by a hidden
  // button, and every one of those lines is build-enforced.
  const isScheduleManager = (u) => !!u && (u.role === ROLES.ADMIN || !!u.isManager);

  const requireScheduleManager = (req, res, next) => {
    if (isScheduleManager(req.user)) return next();
    return res.status(403).json({
      error: 'An administrator or a manager schedules shifts.', code: 'SCHEDULE_MANAGER_ONLY'
    });
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

  // The street address as one line, so the location form shows WHICH house the
  // coordinates are meant to match. Read-only here: the address itself is
  // captured at intake and this session does not own it.
  const addressLine = (u) => {
    const a = (u && u.address) || {};
    return [a.line1 || a.street || '', a.city || '', a.state || '', a.zip || '']
      .map(v => String(v).trim()).filter(Boolean).join(', ');
  };

  const loadClient = async (clientId) => {
    const users = await getUsers();
    return users.find(u => u.id === clientId && u.role === ROLES.CLIENT) || null;
  };

  // Nothing may be scheduled against a client who is not enrolled. The rule
  // lives in enrollmentGate.js because clinical appointments enforce the same
  // one from server.js, and two copies would drift.
  //
  // Returns the override stamp (or null) when scheduling may proceed, and
  // `false` after it has already answered the response. A caller that forgets
  // to check gets a thrown response rather than a silent pass — the helper
  // never returns undefined.
  const gateScheduling = (req, res, client) => {
    const verdict = gate.checkSchedulingAllowed(client, req.body || {}, req.user, isAdmin(req.user));
    if (verdict.ok) return verdict.override;
    res.status(verdict.status).json({
      error: verdict.message, code: verdict.code,
      enrollmentStatus: verdict.enrollmentStatus, overridable: verdict.overridable
    });
    return false;
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
      if (!isScheduleManager(req.user) && !isSchedulable(req.user)) {
        return res.status(403).json({ error: 'Caregiver or clinical access required.', code: 'SCHEDULING_STAFF_ONLY' });
      }
      const rows = await readRows('caregiver_availability');
      let mine = isScheduleManager(req.user) ? rows : rows.filter(r => r && r.caregiver_id === req.user.id);
      if (isScheduleManager(req.user) && req.query.caregiverId) {
        mine = mine.filter(r => r.caregiver_id === String(req.query.caregiverId));
      }
      mine = mine.slice().sort((a, b) => String(b.submitted_at || '').localeCompare(String(a.submitted_at || '')));

      // WHICH SUBMISSION IS IN FORCE, answered once, on the server. Availability
      // is append-only — "updating" it is a new row, which is right, because
      // what somebody said in August must still be readable in October. But a
      // caregiver looking at a growing list of identical-looking rows cannot
      // tell whether their change took, and an office reading the same list
      // could schedule from a superseded one. The newest submission per
      // caregiver is the current one; deriving that on each screen separately
      // is how the two start disagreeing about the same roster.
      const newestPerCaregiver = new Map();
      for (const r of mine) {
        const key = String(r.caregiver_id);
        if (!newestPerCaregiver.has(key)) newestPerCaregiver.set(key, r.id);
      }
      res.json({
        availability: mine.slice(0, 200).map(r => ({
          ...publicAvailability(r),
          current: newestPerCaregiver.get(String(r.caregiver_id)) === r.id
        }))
      });
    } catch (error) {
      console.error('Availability list error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // POST /api/scheduling/availability/:id/review — admin marks it reviewed.
  router.post('/api/scheduling/availability/:id/review', authenticateToken, requireScheduleManager, async (req, res) => {
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
      else if (isScheduleManager(req.user)) clientId = body.clientId || null;
      else return res.status(403).json({ error: 'Only a client, their family, or an administrator can request a shift.', code: 'REQUEST_NOT_PERMITTED' });

      if (!clientId) return res.status(400).json({ error: 'No client on file for this request.', code: 'CLIENT_REQUIRED' });
      const client = await loadClient(clientId);
      if (!client) return res.status(404).json({ error: 'Client not found.', code: 'CLIENT_NOT_FOUND' });

      // DELIBERATELY NOT GATED (owner decision, 2026-09-13). A family calling to
      // ask for care before the paperwork is finished is the normal way this
      // starts, not an edge case — refusing the ask would turn the gate into a
      // reason people phone instead, and then there is no record at all.
      //
      // The gate belongs on COMMITTING care (posting or assigning a shift), which
      // is where an admin decides. So the ask is free and the client's enrollment
      // state rides on the row instead, where whoever works the queue sees it
      // before they act on it rather than discovering it at post time.
      const requestEligibility = gate.schedulingEligibility(client);

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
        shift_id: null,
        // Captured at request time, and kept: what the admin working this queue
        // needs to know is whether enrollment was outstanding when the family
        // asked, which is also the thing that will have moved by the time
        // anybody looks. `client_enrollment_ok` is the answer, not the raw
        // status, so the queue reads one field rather than re-deriving a rule.
        client_enrollment_status: requestEligibility.status,
        client_enrollment_ok: requestEligibility.allowed,
        client_enrollment_note: requestEligibility.allowed ? null : requestEligibility.message
      };
      rows.push(row);
      await db.set('shift_requests', rows);
      await logActivity(req.user.id, row.requested_by_name, 'shift_requested', 'shift_request', row.id,
        { clientId: client.id, date: row.date, enrollmentStatus: row.client_enrollment_status });

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
      if (isScheduleManager(req.user)) mine = rows;
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
  router.post('/api/scheduling/shifts', authenticateToken, requireScheduleManager, async (req, res) => {
    try {
      const { valid, errors, clean } = sched.validateShift(req.body);
      if (!valid) return res.status(400).json({ error: 'Some shift details need correcting.', code: 'SHIFT_INVALID', errors });

      const client = await loadClient(clean.clientId);
      if (!client) return res.status(404).json({ error: 'Client not found.', code: 'CLIENT_NOT_FOUND' });

      const shiftOverride = gateScheduling(req, res, client);
      if (shiftOverride === false) return;

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
        // The rate an admin set when RELEASING this shift (owner request,
        // 2026-09-13). Optional: left null, each caregiver's own per-client or
        // base rate applies at payroll time. Set, it overrides both — which is
        // how a hard-to-fill shift gets paid more without editing anyone's
        // standing rate. Normalized through caregiverRepository, so an
        // unusable value lands as null rather than as a shift that pays zero.
        pay_rate: cg.normalizePayRate((req.body || {}).payRate),
        status: 'open',
        created_by: req.user.id,
        created_by_name: req.user.name || req.user.email,
        created_at: nowIso(),
        claimed_at: null, assigned_at: null, confirmed_at: null,
        started_at: null, completed_at: null, cancelled_at: null, reopened_at: null,
        // Present only when an admin scheduled over the enrollment gate. It
        // rides on the shift itself so the override is visible wherever the
        // work is, not only in an activity log nobody opens.
        enrollment_override: shiftOverride
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
          assignedTo: assignee ? assignee.id : null,
          enrollmentOverride: shiftOverride
            ? { reason: shiftOverride.reason, enrollmentStatus: shiftOverride.enrollmentStatus }
            : null
        });

      if (assignee) {
        await logActivity(req.user.id, row.created_by_name, 'shift_assigned', 'shift', row.id,
          { clientId: client.id, caregiverId: assignee.id, postedDirectly: true });
        if (assignee.email) {
          await queueNotification('shift_assigned', assignee.id, assignee.email, assignee.name,
            {
              subject: `New shift offered — ${row.client_name}`,
              body: `You have been offered the ${time.fmtDateTime(row.start)} shift for ${row.client_name}. Accept or decline it in your schedule.`,
              ctaUrl: links.shiftFor(), ctaLabel: 'View the shift'
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

  // PUT /api/scheduling/shifts/:id — correct a shift that is already posted.
  //
  // Owner instruction, 2026-09-20: "make the schedules and shifts editable by
  // admin and manager after posting. Previous shifts too when we need to update
  // the time." Until now the only way to move a shift was to cancel it and post
  // another, which throws away the claim, the assignment and the caregiver's
  // acceptance in order to fix a typo — and leaves a cancelled tombstone
  // implying the visit was called off when it was not.
  //
  // A PAST shift is editable on purpose; correcting last Tuesday is the stated
  // reason this exists. What is refused is a shift that was CANCELLED, which
  // did not happen and has nothing on it to correct.
  // ---- ONE writer for a shift's time --------------------------------------
  // Both doors onto changing a shift come through here: an admin or manager
  // typing a correction (PUT below), and a manager APPROVING a caregiver's
  // change request. They are the same act and they must obey the same rules —
  // the holder's eligibility, the overlap check, the time log following the
  // shift, the derived flags being re-derived, and who gets told.
  //
  // Restating any of that in the approve route is how the two start
  // disagreeing about one value, which is the failure this repo keeps paying
  // for. `actor` is whoever made the DECISION, so an approved request emails
  // in the office's name, which is accurate: the office moved the shift.
  //
  // Returns { shift, changes, logsTouched, message } or { error: { status, body } }.
  // `context` lets the caller say WHY the shift is moving, so the one email
  // this function sends can be accurate. It never changes what is written —
  // only the sentence the caregiver reads.
  async function applyShiftEdit({ shiftId, body, actor, context }) {
    const ERR = (status, errBody) => ({ error: { status, body: errBody } });
    const rows = await readRows('shifts');
    const idx = rows.findIndex(r => r && r.id === shiftId);
    if (idx === -1) return ERR(404, { error: 'Shift not found.', code: 'SHIFT_NOT_FOUND' });
    // A SNAPSHOT, not a reference to the live row. `rows[idx]` is mutated in
    // place a few lines down, so `const before = rows[idx]` aliases it: every
    // "the previous time was …" line would print the NEW time, and the audit
    // log's before/after pair would read identical. A shallow copy is enough
    // — every value compared here is a primitive — but it has to be a copy.
    // Same class as the enrollment editor's shallow before/after (PR #103),
    // and it hid behind a test that asserted the PHRASE rather than the value.
    const before = { ...rows[idx] };

    if (!sched.canEditShift(before)) {
      return ERR(409, {
        error: 'A cancelled shift cannot be edited. Post a new one.',
        code: 'SHIFT_NOT_EDITABLE', status: before.status
      });
    }

    const { valid, errors, clean, changes } = sched.validateShiftEdit(before, body);
    if (!valid) return ERR(400, { error: 'Some shift details need correcting.', code: 'SHIFT_INVALID', errors });
    if (changes.length === 0) {
      return { shift: publicShift(before), changes: [], logsTouched: 0, message: 'Nothing changed.' };
    }

    // The row as it WILL read, built before anything is written, so every
    // re-check below asks about the shift that is about to exist rather than
    // the one that exists now.
    const after = { ...before };
    changes.forEach(k => { after[sched.SHIFT_EDIT_COLUMN[k]] = clean[k]; });

    // Whoever is holding this shift agreed to a particular piece of work. If
    // the edit takes it outside what they may do — a raised licence
    // requirement, or a narrowing to the care team they are not on — the edit
    // is REFUSED rather than quietly releasing them. Releasing somebody from
    // work they accepted is a decision for a person, not a side effect of
    // correcting a time.
    if (after.caregiver_id) {
      const holder = await freshUser(after.caregiver_id);
      const client = await loadClient(after.client_id);
      if (holder && !sched.isEligibleForShift(holder, after, client)) {
        return ERR(409, {
          error: `${holder.name} could not hold the shift as edited.`,
          code: 'SHIFT_HOLDER_INELIGIBLE',
          reason: sched.eligibilityReason(holder, after, client),
          hint: 'Cancel the shift, or release the caregiver first, then make this change.'
        });
      }
      if (holder && (changes.includes('start') || changes.includes('end'))) {
        const conflict = sched.findShiftConflict(rows, holder.id, after);
        if (conflict) {
          return ERR(409, {
            error: `${holder.name} already holds an overlapping shift at the new time.`,
            code: 'SHIFT_CONFLICT',
            conflict: { id: conflict.id, start: conflict.start, end: conflict.end, clientName: conflict.client_name }
          });
        }
      }
    }

    changes.forEach(k => { rows[idx][sched.SHIFT_EDIT_COLUMN[k]] = clean[k]; });
    rows[idx].edited_at = nowIso();
    rows[idx].edited_by_id = actor.id;
    rows[idx].edited_by_name = actor.name || actor.email;
    rows[idx].edit_count = (Number(rows[idx].edit_count) || 0) + 1;
    await db.set('shifts', rows);

    // THE TIME LOG CARRIES ITS OWN COPY OF THE SCHEDULE, and payroll reads
    // that copy rather than the shift. Leaving it behind means the board and
    // the timesheet disagree about the same visit, which is the failure this
    // repo keeps paying for: two writers, one value. So the log follows —
    // and the flags DERIVED from the schedule are re-derived with it, because
    // a "late clock-in" measured against a time that was wrong is a mark the
    // caregiver did not earn. The geofence verdicts are observations of where
    // somebody stood and are never rewritten. See rederiveScheduleFlags.
    let logsTouched = 0;
    if (changes.includes('start') || changes.includes('end')) {
      const logs = await readRows('time_logs');
      let dirty = false;
      logs.forEach(l => {
        if (!l || String(l.shift_id) !== String(rows[idx].id)) return;
        l.scheduled_start = rows[idx].start;
        l.scheduled_end = rows[idx].end;
        l.flags = sched.rederiveScheduleFlags(l, rows[idx]);
        l.schedule_corrected_at = nowIso();
        l.schedule_corrected_by_name = rows[idx].edited_by_name;
        dirty = true; logsTouched += 1;
      });
      if (dirty) await db.set('time_logs', logs);
    }

    // WHAT changed, never a client's detail. Times and a licence level are
    // operational facts about a shift, so the before/after is recorded; the
    // client is named by id, as every other row in this log names them.
    await logActivity(actor.id, rows[idx].edited_by_name, 'shift_edited', 'shift', rows[idx].id,
      {
        clientId: rows[idx].client_id, fields: changes, status: rows[idx].status,
        before: { start: before.start, end: before.end, requiredLicenseLevel: before.required_license_level },
        after: { start: rows[idx].start, end: rows[idx].end, requiredLicenseLevel: rows[idx].required_license_level },
        timeLogsUpdated: logsTouched, role: actor.role
      });

    // TELLING THE CAREGIVER IS THE POINT OF MOVING A TIME, AND THAT INCLUDES
    // A SHIFT THAT HAS ALREADY HAPPENED (owner instruction, 2026-09-20).
    //
    // An earlier version emailed only about a shift still ahead of us, on the
    // reasoning that a correction to last week is paperwork. That was wrong,
    // and the reason is payroll: the time log's copy of the schedule moves
    // with the shift, so correcting a past visit changes what that
    // caregiver's timesheet says about a day they already worked. Somebody
    // whose pay record changes has to be told it changed.
    //
    // THE TWO CASES NEED DIFFERENT SENTENCES. "Your shift has moved" is an
    // instruction about where to be, and it is nonsense about last Tuesday —
    // a caregiver reading it would think they had missed something. A past
    // shift says the RECORD was corrected and that their clocked hours are
    // untouched, which is the question they will actually have.
    const timeMoved = changes.includes('start') || changes.includes('end');
    const stillAhead = new Date(rows[idx].start).getTime() > Date.now();
    // THREE CASES, THREE SENTENCES, and picking the wrong one is worse than
    // sending nothing. An `assigned` shift is an OFFER the caregiver has not
    // answered — "your shift has moved" tells them they are committed to work
    // they never agreed to, and they would stop looking for the Accept button.
    // A past shift is a record correction, not an instruction about where to
    // be. Only a confirmed future shift has actually moved.
    const isOffer = rows[idx].status === 'assigned';
    // APPROVING A CAREGIVER'S OWN REQUEST IS A DIFFERENT MESSAGE from the
    // office moving a shift unprompted. They asked for this time, so the news
    // is the ANSWER — and when they asked about an offer, asking was their
    // agreement to work it, so the approval confirms it onto their schedule
    // rather than sending it back round for a second acceptance.
    const approvedRequest = !!(context && context.approvedRequest);
    const willConfirm = !!(context && context.willConfirm);
    let notified = [];
    if (timeMoved) {
      const when = time.fmtDateTime(rows[idx].start);
      const holder = rows[idx].caregiver_id ? await freshUser(rows[idx].caregiver_id) : null;
      if (holder && holder.email) {
        await queueNotification('shift_time_changed', holder.id, holder.email, holder.name,
          {
            subject: approvedRequest
              ? `Your shift change was approved — ${rows[idx].client_name}`
              : (isOffer
                ? `Shift offer updated — still needs your answer`
                : (stillAhead
                  ? `Shift time changed — ${rows[idx].client_name}`
                  : `Shift record corrected — ${rows[idx].client_name}`)),
            body: approvedRequest
              ? `The office approved your request. Your shift for ${rows[idx].client_name} is now ${when}–${time.fmtTime(rows[idx].end)}; it was previously ${time.fmtDateTime(before.start)}–${time.fmtTime(before.end)}.`
                + (willConfirm
                  ? ' It is confirmed and on your schedule — you do not need to accept it again.'
                  : '')
              : (isOffer
              ? `The offer for ${rows[idx].client_name} has been updated to ${when}–${time.fmtTime(rows[idx].end)}; it was previously ${time.fmtDateTime(before.start)}–${time.fmtTime(before.end)}. It is still an offer — accept it or decline it in the app. You are not scheduled for it until you accept.`
              : (stillAhead
                ? `Your shift for ${rows[idx].client_name} has moved. It now starts ${when} and ends ${time.fmtTime(rows[idx].end)}. The previous time was ${time.fmtDateTime(before.start)}.`
                : `The record of your shift for ${rows[idx].client_name} has been corrected by ${rows[idx].edited_by_name}. It now reads ${when} to ${time.fmtTime(rows[idx].end)}; it previously read ${time.fmtDateTime(before.start)} to ${time.fmtTime(before.end)}.`
                  + (logsTouched
                    ? ' Your timesheet for that visit has been updated to match. The hours you clocked have not changed.'
                    : ' The hours you clocked have not changed.'))),
            ctaUrl: links.shiftFor(),
            ctaLabel: approvedRequest
              ? 'View your schedule'
              : (isOffer ? 'Answer the offer' : (stillAhead ? 'View the shift' : 'View your schedule'))
          },
          { relatedEntityId: `${rows[idx].id}:edited:${rows[idx].edit_count}`, relatedEntityType: 'shift', createdBy: actor.id });
        notified.push(holder.name);
      }
      // THE CLIENT IS TOLD ONLY ABOUT A VISIT STILL TO COME, and only one
      // they were already promised. "Your visit has been rescheduled" is
      // false about a visit that already happened, and a client has nothing
      // to do about a correction to our own timesheet.
      if (stillAhead && ['confirmed', 'in_progress'].includes(rows[idx].status)) {
        const client = await loadClient(rows[idx].client_id);
        if (client && client.email) {
          await queueNotification('shift_time_changed_client', client.id, client.email, client.name,
            {
              subject: 'Your care visit has been rescheduled',
              body: `Your visit has moved to ${when}. It was previously ${time.fmtDateTime(before.start)}.`,
              ctaUrl: links.PATHS.PORTAL, ctaLabel: 'Open your portal'
            },
            { relatedEntityId: `${rows[idx].id}:edited-client:${rows[idx].edit_count}`, relatedEntityType: 'shift', createdBy: actor.id });
          notified.push(client.name);
        }
      }
    }

    return {
      shift: publicShift(rows[idx]),
      changes,
      logsTouched,
      message: notified.length
        ? `Shift updated. ${notified.join(' and ')} ${notified.length > 1 ? 'have' : 'has'} been told${stillAhead ? ' the time changed' : ' the record was corrected'}.`
        + (logsTouched ? ` ${logsTouched} time log${logsTouched > 1 ? 's' : ''} moved with it.` : '')
        : (timeMoved
          ? `Shift updated.${logsTouched ? ` ${logsTouched} time log${logsTouched > 1 ? 's' : ''} moved with it.` : ''} Nobody was emailed: no caregiver is on this shift.`
          : 'Shift updated.')
    };
  }

  router.put('/api/scheduling/shifts/:id', authenticateToken, requireScheduleManager, async (req, res) => {
    try {
      const result = await applyShiftEdit({ shiftId: req.params.id, body: req.body, actor: req.user });
      if (result.error) return res.status(result.error.status).json(result.error.body);
      res.json({
        shift: result.shift,
        changed: result.changes,
        timeLogsUpdated: result.logsTouched,
        message: result.message
      });
    } catch (error) {
      console.error('Shift edit error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // POST /api/scheduling/shifts/bulk — one standing pattern, many shifts.
  //
  // Owner instruction, 2026-09-20. "Mon, Wed and Fri, 9 to 1, through the end
  // of November" is how home care is actually scheduled, and posting it a row
  // at a time is forty identical form fills.
  //
  // THE TEMPLATE IS ALL-OR-NOTHING; THE OCCURRENCES ARE NOT. A bad client or a
  // bad licence level writes nothing at all — the same rule the single post
  // follows, and the reason a refused post leaves no orphan behind. But one
  // date in forty clashing with a shift the caregiver already holds should not
  // refuse the other thirty-nine: those are reported, skipped, and named.
  router.post('/api/scheduling/shifts/bulk', authenticateToken, requireScheduleManager, async (req, res) => {
    try {
      const body = req.body || {};
      const expanded = sched.expandRecurrence(body);
      if (!expanded.valid) {
        return res.status(400).json({ error: 'Some details need correcting.', code: 'RECURRENCE_INVALID', errors: expanded.errors });
      }

      // The shift fields are validated ONCE, through the same validateShift the
      // single post uses, against the first occurrence. A second copy of "what
      // a valid shift is" is how the two start accepting different things.
      const first = expanded.occurrences[0];
      const template = { ...body, start: first.start, end: first.end };
      const { valid, errors } = sched.validateShift(template);
      if (!valid) return res.status(400).json({ error: 'Some shift details need correcting.', code: 'SHIFT_INVALID', errors });

      const client = await loadClient(body.clientId);
      if (!client) return res.status(404).json({ error: 'Client not found.', code: 'CLIENT_NOT_FOUND' });

      const bulkOverride = gateScheduling(req, res, client);
      if (bulkOverride === false) return;

      const assignToId = String(body.assignToCaregiverId || '').trim();
      let assignee = null;
      if (assignToId) {
        assignee = await freshUser(assignToId);
        if (!assignee || !isSchedulable(assignee)) {
          return res.status(400).json({ error: 'Pick a caregiver with a license level on file.', code: 'CAREGIVER_INVALID' });
        }
      }

      const required = sched.normalizeLicenseRequirement(body.requiredLicenseLevel);
      const visibility = body.poolVisibility || 'all_eligible';
      const payRate = cg.normalizePayRate(body.payRate);
      const notes = String(body.notes || '').trim().slice(0, 2000);
      const careTier = body.careTier ? String(body.careTier).trim().slice(0, 20) : (client.careTier || null);

      const rows = await readRows('shifts');
      const created = [];
      const skipped = [];

      for (const occ of expanded.occurrences) {
        const row = {
          id: uuidv4(),
          client_id: client.id, client_name: client.name,
          caregiver_id: null, caregiver_name: null,
          start: occ.start, end: occ.end,
          required_license_level: required.level,
          pool_visibility: visibility,
          care_tier: careTier,
          notes,
          pay_rate: payRate,
          status: 'open',
          created_by: req.user.id,
          created_by_name: req.user.name || req.user.email,
          created_at: nowIso(),
          // Every row says which batch made it, so a mistaken bulk post can be
          // found and removed as the one thing it was.
          bulk_batch_id: null,
          claimed_at: null, assigned_at: null, confirmed_at: null,
          started_at: null, completed_at: null, cancelled_at: null, reopened_at: null,
          enrollment_override: bulkOverride
        };

        // Clicking Post twice is the commonest way to get two of everything.
        const dup = sched.findDuplicateShift(rows, client.id, row.start, row.end);
        if (dup) { skipped.push({ date: occ.date, start: occ.start, reason: 'A shift already exists for this client at that time.', code: 'DUPLICATE', shiftId: dup.id }); continue; }

        if (assignee) {
          if (!sched.isEligibleForShift(assignee, row, client)) {
            skipped.push({ date: occ.date, start: occ.start, reason: sched.eligibilityReason(assignee, row, client), code: 'NOT_ELIGIBLE' });
            continue;
          }
          const conflict = sched.findShiftConflict(rows, assignee.id, row);
          if (conflict) {
            skipped.push({ date: occ.date, start: occ.start, reason: `${assignee.name} already holds an overlapping shift.`, code: 'CONFLICT' });
            continue;
          }
          row.status = 'assigned';
          row.assigned_at = nowIso();
          row.caregiver_id = assignee.id;
          row.caregiver_name = assignee.name;
        }

        rows.push(row);
        created.push(row);
      }

      if (created.length === 0) {
        return res.status(409).json({
          error: 'None of those shifts could be posted.', code: 'BULK_NOTHING_POSTED',
          created: [], skipped
        });
      }

      const batchId = uuidv4();
      created.forEach(r => { r.bulk_batch_id = batchId; });
      await db.set('shifts', rows);

      await logActivity(req.user.id, req.user.name || req.user.email, 'shifts_bulk_posted', 'shift', batchId,
        {
          clientId: client.id, count: created.length, skipped: skipped.length,
          from: body.startDate, to: body.endDate, days: body.daysOfWeek,
          assignedTo: assignee ? assignee.id : null, role: req.user.role,
          enrollmentOverride: bulkOverride ? { reason: bulkOverride.reason, enrollmentStatus: bulkOverride.enrollmentStatus } : null
        });

      // ONE email for the batch, not forty. A caregiver assigned eighteen
      // shifts does not need eighteen identical messages, and a mailbox full of
      // them is a mailbox nobody reads.
      if (assignee && assignee.email) {
        await queueNotification('shift_assigned', assignee.id, assignee.email, assignee.name,
          {
            subject: `${created.length} new shift${created.length > 1 ? 's' : ''} offered — ${client.name}`,
            body: `You have been offered ${created.length} shift${created.length > 1 ? 's' : ''} for ${client.name}, starting ${time.fmtDateTime(created[0].start)}. Accept or decline each one in your schedule.`,
            ctaUrl: links.shiftFor(), ctaLabel: 'View the shifts'
          },
          { relatedEntityId: batchId, relatedEntityType: 'shift', createdBy: req.user.id });
      }

      res.json({
        batchId,
        created: created.map(publicShift),
        skipped,
        message: `${created.length} shift${created.length > 1 ? 's' : ''} posted${assignee ? ` to ${assignee.name}` : ' to the open pool'}.` +
          (skipped.length ? ` ${skipped.length} skipped — see the list.` : '')
      });
    } catch (error) {
      console.error('Bulk shift post error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // POST /api/scheduling/shifts/bulk-remove — take several shifts off the board
  // in one go, with a reason.
  //
  // REMOVING IS TWO DIFFERENT ACTS and the route does not make the caller guess
  // which. A shift somebody claimed, accepted, worked or was promised is
  // CANCELLED: it leaves its tombstone and its reason, because care that was
  // promised and called off is a fact. A shift still sitting open that nobody
  // ever held is a typo — most often one row of a bulk post aimed at the wrong
  // week — and it is DELETED, because forty tombstones for a mistake nobody
  // saw buries the cancellations that matter. The whole row is written to the
  // activity log first, so a delete is still recoverable from the record.
  router.post('/api/scheduling/shifts/bulk-remove', authenticateToken, requireScheduleManager, async (req, res) => {
    try {
      const body = req.body || {};
      const reason = String(body.reason || '').trim();
      if (!reason) return res.status(400).json({ error: 'Say why these shifts are being removed.', code: 'CANCEL_REASON_REQUIRED' });

      const ids = Array.isArray(body.shiftIds) ? body.shiftIds.map(v => String(v)).filter(Boolean) : [];
      if (ids.length === 0) return res.status(400).json({ error: 'Pick at least one shift.', code: 'NO_SHIFTS_SELECTED' });
      if (ids.length > sched.MAX_BULK_OCCURRENCES) {
        return res.status(400).json({
          error: `Remove at most ${sched.MAX_BULK_OCCURRENCES} shifts at a time.`, code: 'TOO_MANY_SHIFTS'
        });
      }

      const rows = await readRows('shifts');
      const timeLogs = await readRows('time_logs');
      const cancelled = [];
      const deleted = [];
      const refused = [];
      const removeIds = new Set();

      for (const id of ids) {
        const row = rows.find(r => r && r.id === id);
        if (!row) { refused.push({ shiftId: id, reason: 'Shift not found.', code: 'SHIFT_NOT_FOUND' }); continue; }

        if (sched.isNeverHeld(row, timeLogs)) {
          removeIds.add(row.id);
          deleted.push({ shiftId: row.id, start: row.start, end: row.end, clientName: row.client_name });
          await logActivity(req.user.id, req.user.name || req.user.email, 'shift_deleted', 'shift', row.id,
            { clientId: row.client_id, reason, role: req.user.role, row });
          continue;
        }

        if (!sched.canTransitionShift(row.status, 'cancelled')) {
          // The state machine's own wording, not a second sentence written
          // here: "that shift is finished" and "it is under way" are different
          // facts and the person reading the list has to be able to tell them
          // apart.
          const refusal = sched.transitionRefusal(row.status, 'cancelled');
          refused.push({
            shiftId: row.id, start: row.start, clientName: row.client_name,
            reason: (refusal && refusal.message) || `A ${row.status} shift cannot be cancelled.`,
            code: (refusal && refusal.code) || 'SHIFT_TRANSITION_INVALID', status: row.status
          });
          continue;
        }

        row.status = 'cancelled';
        row.cancelled_at = nowIso();
        row.cancel_reason = reason.slice(0, 1000);
        cancelled.push({ shiftId: row.id, start: row.start, end: row.end, clientName: row.client_name, caregiverName: row.caregiver_name });
        await logActivity(req.user.id, req.user.name || req.user.email, 'shift_cancelled', 'shift', row.id,
          { clientId: row.client_id, reason, bulk: true, role: req.user.role });
      }

      if (cancelled.length === 0 && deleted.length === 0) {
        return res.status(409).json({ error: 'Nothing was removed.', code: 'BULK_NOTHING_REMOVED', cancelled: [], deleted: [], refused });
      }

      const kept = rows.filter(r => !removeIds.has(r.id));
      await db.set('shifts', kept);

      // A caregiver who was holding one of these needs to know, and they need
      // ONE message rather than one per shift. A deleted row had nobody on it
      // by definition, so nothing is sent for those.
      const byCaregiver = new Map();
      cancelled.forEach(c => {
        const row = rows.find(r => r.id === c.shiftId);
        if (row && row.caregiver_id) {
          if (!byCaregiver.has(row.caregiver_id)) byCaregiver.set(row.caregiver_id, []);
          byCaregiver.get(row.caregiver_id).push(row);
        }
      });
      for (const [caregiverId, list] of byCaregiver) {
        const holder = await freshUser(caregiverId);
        if (!holder || !holder.email) continue;
        await queueNotification('shift_cancelled', holder.id, holder.email, holder.name,
          {
            subject: `${list.length} shift${list.length > 1 ? 's' : ''} cancelled — ${list[0].client_name}`,
            body: `${list.length} of your shifts for ${list[0].client_name} ${list.length > 1 ? 'have' : 'has'} been cancelled, starting with ${time.fmtDateTime(list[0].start)}. Reason: ${reason}`,
            ctaUrl: links.shiftFor(), ctaLabel: 'View your schedule'
          },
          { relatedEntityId: `${list[0].id}:bulk-cancelled`, relatedEntityType: 'shift', createdBy: req.user.id });
      }

      res.json({
        cancelled, deleted, refused,
        message: [
          cancelled.length ? `${cancelled.length} cancelled` : '',
          deleted.length ? `${deleted.length} removed (never claimed by anyone)` : '',
          refused.length ? `${refused.length} left alone` : ''
        ].filter(Boolean).join(', ') + '.'
      });
    } catch (error) {
      console.error('Bulk shift remove error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // GET /api/scheduling/shifts — the master calendar for admin; for a caregiver,
  // ONLY their own shifts. A caregiver cannot read another caregiver's shifts.
  router.get('/api/scheduling/shifts', authenticateToken, async (req, res) => {
    try {
      if (!isScheduleManager(req.user) && !isSchedulable(req.user)) {
        return res.status(403).json({ error: 'Caregiver or clinical access required.', code: 'SCHEDULING_STAFF_ONLY' });
      }
      const rows = await readRows('shifts');
      let mine = isScheduleManager(req.user) ? rows : rows.filter(r => r && r.caregiver_id === req.user.id);
      if (req.query.status) mine = mine.filter(r => r.status === String(req.query.status));
      if (req.query.from) mine = mine.filter(r => String(r.start) >= String(req.query.from));
      if (req.query.to) mine = mine.filter(r => String(r.start) <= String(req.query.to));
      if (isScheduleManager(req.user) && req.query.clientId) mine = mine.filter(r => r.client_id === String(req.query.clientId));
      mine = mine.slice().sort((a, b) => String(a.start).localeCompare(String(b.start)));

      // Whether the visit log is already filed is a fact the clock-out gate
      // reads, so the schedule reads it too rather than showing a Clock out
      // button that the server is going to refuse. Observed, never assumed:
      // an in-progress shift with no log says so, and a shift that is not
      // running carries null rather than a guess.
      const filedLogs = await readRows('caregiver_visit_logs');
      // Same rule for the change request: the SERVER says whether this shift
      // can be asked about right now, and why not when it cannot. The screen
      // renders that answer instead of computing its own — a button that is
      // going to answer 409 is worse than no button, and a caregiver told
      // "too late" needs the office number, not a disabled control.
      const changeRequests = await readRows('shift_change_requests');
      const page = mine.slice(0, 500).map((r) => {
        const out = publicShift(r);
        out.visitLogFiled = r.status === 'in_progress'
          ? filedLogs.some(v => v && String(v.shift_id) === String(r.id) &&
              String(v.caregiver_id) === String(r.caregiver_id) &&
              String(v.client_id) === String(r.client_id))
          : null;
        const askable = sched.canRequestShiftChange(r);
        out.changeRequestable = askable.ok;
        // The office number rides IN the reason for the one refusal a caregiver
        // can act on today, so the screen has a single string to print and
        // cannot show a different number from the one the consents carry.
        out.changeRequestBlockedReason = askable.ok ? null
          : (askable.code === 'CHANGE_REQUEST_TOO_LATE' && ORG.phone
            ? `${askable.message} ${ORG.phone}`
            : askable.message);
        out.changeRequestBlockedCode = askable.ok ? null : askable.code;
        // Which kinds this shift takes, served rather than restated in the
        // page — an offer takes a time change only, and a form offering
        // "I cannot work this" on an offer would be refused at the API.
        out.changeRequestKinds = askable.ok ? sched.kindsFor(r.status) : [];
        const open = sched.findOpenChangeRequest(changeRequests, r.id);
        out.openChangeRequest = open
          ? { id: open.id, kind: open.kind, status: open.status, requestedAt: open.requested_at }
          : null;
        return out;
      });
      res.json({ shifts: page });
    } catch (error) {
      console.error('Shift list error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // GET /api/scheduling/my-upcoming-shifts — a client sees their OWN assigned
  // care only, never another client's, never the caregiver's other patients,
  // and never the staffing/ops detail (notes, cancel reasons, who posted it)
  // publicShift() carries for staff. A family login sees the same, scoped to
  // the client they are linked to. Locked-in schedule only: 'confirmed' and
  // 'in_progress' — a claim or an admin assignment the caregiver has not yet
  // accepted is not shown, so a client is never told about a visit that could
  // still fall through before anyone confirms it.
  router.get('/api/scheduling/my-upcoming-shifts', authenticateToken, async (req, res) => {
    try {
      let clientId = null;
      if (req.user.role === ROLES.CLIENT) clientId = req.user.id;
      else if (req.user.role === ROLES.FAMILY) clientId = req.user.familyOfClientId;
      else return res.status(403).json({ error: 'Only a client or their family can view this schedule.', code: 'SCHEDULE_READ_DENIED' });
      if (!clientId) return res.json({ shifts: [] });

      const rows = await readRows('shifts');
      const now = nowIso();
      const upcoming = rows
        .filter(r => r && r.client_id === clientId)
        .filter(r => r.status === 'confirmed' || r.status === 'in_progress')
        .filter(r => String(r.end) >= now)
        .sort((a, b) => String(a.start).localeCompare(String(b.start)))
        .slice(0, 50)
        .map(r => ({
          id: r.id,
          caregiverName: r.caregiver_name,
          start: r.start,
          end: r.end,
          status: r.status
        }));
      res.json({ shifts: upcoming });
    } catch (error) {
      console.error('Client upcoming-shifts error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // GET /api/scheduling/shifts/open — the whole open board (owner rule,
  // 2026-09-13). Every caregiver sees every open shift; one their licence does
  // not cover comes back with `claimable: false` and the REASON, and the UI
  // greys it out. Care-team-restricted shifts are still absent — see
  // sched.shiftVisibility() for why those two gates differ.
  //
  // Returning the reason matters as much as returning the row: "you need a CNA
  // sign-off for this" is a thing a caregiver can act on; a greyed row with no
  // explanation is just a locked door. The claim route re-checks
  // isEligibleForShift() independently, so a row shown here is never a row that
  // can be taken here.
  router.get('/api/scheduling/shifts/open', authenticateToken, requireSchedulable, async (req, res) => {
    try {
      const me = await freshUser(req.user.id);
      const users = await getUsers();
      const clientsById = new Map(users.filter(u => u.role === ROLES.CLIENT).map(u => [u.id, u]));
      const rows = await readRows('shifts');
      const open = rows
        .filter(r => r && r.status === 'open')
        .map(r => ({ row: r, vis: sched.shiftVisibility(me, r, clientsById.get(r.client_id)) }))
        .filter(x => x.vis.visible)
        .sort((a, b) => String(a.row.start).localeCompare(String(b.row.start)));
      res.json({
        shifts: open.slice(0, 200).map(x => ({
          ...publicShift(x.row),
          claimable: x.vis.claimable,
          ineligibleReason: x.vis.reason
        }))
      });
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
      // Cleared to work? A caregiver cannot override their own clearance, so
      // this is a plain refusal that names what is outstanding and who each
      // item is waiting on.
      const cleared = await checkCaregiverCleared(me, req);
      if (!cleared.ok) {
        return res.status(cleared.status).json({
          error: cleared.code === 'CAREGIVER_NOT_CLEARED'
            ? 'You are not cleared to work yet. Finish the items on your onboarding checklist and we will get you scheduled.'
            : cleared.message,
          code: cleared.code,
          outstanding: cleared.outstanding || []
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
            body: `${me.name} claimed the ${time.fmtDateTime(rows[idx].start)} shift for ${rows[idx].client_name}. Approve or decline it in Scheduling.`,
            ctaUrl: links.PATHS.SCHEDULING, ctaLabel: 'Open scheduling'
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
  router.post('/api/scheduling/shifts/:id/approve', authenticateToken, requireScheduleManager, async (req, res) => {
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
  router.post('/api/scheduling/shifts/:id/decline-claim', authenticateToken, requireScheduleManager, async (req, res) => {
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
  router.post('/api/scheduling/shifts/:id/assign', authenticateToken, requireScheduleManager, async (req, res) => {
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
      // Cleared to work? An admin MAY go ahead anyway, with a reason, and the
      // reason plus the state it overrode are stamped on the shift — frozen,
      // because recomputing it later would erase the override the moment the
      // missing document was accepted.
      const cleared = await checkCaregiverCleared(caregiver, req);
      if (!cleared.ok) {
        return res.status(cleared.status).json({
          error: cleared.message, code: cleared.code,
          outstanding: cleared.outstanding || [],
          overridable: cleared.overridable
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
      if (cleared.override) rows[idx].clearance_override = cleared.override;
      await db.set('shifts', rows);

      if (caregiver.email) {
        await queueNotification('shift_assigned', caregiver.id, caregiver.email, caregiver.name,
          {
            subject: `New shift offered — ${rows[idx].client_name}`,
            body: `You have been offered the ${time.fmtDateTime(rows[idx].start)} shift for ${rows[idx].client_name}. Accept or decline it in your schedule.`,
            ctaUrl: links.shiftFor(), ctaLabel: 'View the shift'
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
            body: `${req.user.name} declined the ${time.fmtDateTime(result.shift.start)} shift for ${result.shift.client_name}. It is open again.`,
            ctaUrl: links.PATHS.SCHEDULING, ctaLabel: 'Open scheduling'
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
  router.post('/api/scheduling/shifts/:id/cancel', authenticateToken, requireScheduleManager, async (req, res) => {
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

    // A PENDING CHANGE REQUEST ABOUT THIS SHIFT IS NOW UNANSWERABLE. The person
    // who asked is no longer on it — they declined the offer, or the office
    // released them — so approving it would act on somebody else's shift and
    // leaving it pending fills the office queue with questions nobody can act
    // on. `closed` says plainly that nobody decided it; it lapsed.
    const crRows = await readRows('shift_change_requests');
    let closed = false;
    crRows.forEach(r => {
      if (r && r.status === 'pending' && String(r.shift_id) === String(shiftId)) {
        r.status = 'closed';
        r.decided_at = nowIso();
        r.decision_note = 'The shift is no longer assigned to you, so this request lapsed.';
        closed = true;
      }
    });
    if (closed) await db.set('shift_change_requests', crRows);
  };

  // ---- A caregiver asks for a shift to change -------------------------------
  // Owner-directed, 2026-09-21. Until now a caregiver holding a CONFIRMED shift
  // had no route at all: they could decline an offer they had not yet accepted,
  // and after that the only lever was phoning the office. So the ask left no
  // record, and whether somebody asks every week was invisible.
  //
  // THE ASK WRITES NOTHING TO THE SHIFT. It is a request, and a person answers
  // it. Approving runs through `applyShiftEdit` — the same editor a hand-typed
  // correction runs through — so the holder's eligibility, the overlap check,
  // the time log following the shift and the caregiver's email all happen once,
  // in one place, however the change was asked for.
  const publicChangeRequest = (r) => r && ({
    id: r.id,
    shiftId: r.shift_id,
    kind: r.kind,
    status: r.status,
    reason: r.reason,
    clientName: r.client_name,
    caregiverId: r.caregiver_id,
    caregiverName: r.caregiver_name,
    // The shift AS IT WAS when they asked. Kept on the row rather than read
    // back from the shift, because the whole point of showing it is to say
    // what they were looking at — and the shift may have moved since.
    shiftStart: r.shift_start_at_request,
    shiftEnd: r.shift_end_at_request,
    proposedStart: r.proposed_start,
    proposedEnd: r.proposed_end,
    minutesOfNotice: r.minutes_of_notice,
    requestedAt: r.requested_at,
    decidedAt: r.decided_at,
    decidedByName: r.decided_by_name,
    decisionNote: r.decision_note
  });

  // POST …/shifts/:id/change-request — the caregiver holding it asks.
  router.post('/api/scheduling/shifts/:id/change-request', authenticateToken, requireSchedulable, async (req, res) => {
    try {
      const shifts = await readRows('shifts');
      const shift = shifts.find(r => r && r.id === req.params.id);
      if (!shift) return res.status(404).json({ error: 'Shift not found.', code: 'SHIFT_NOT_FOUND' });

      // Only the person holding it. Asking about somebody else's shift is not a
      // thing that has a meaning here.
      if (String(shift.caregiver_id || '') !== String(req.user.id)) {
        return res.status(403).json({ error: 'That shift is not yours.', code: 'SHIFT_NOT_YOURS' });
      }

      // Status and notice, answered by the SAME function the screen asks, so
      // the app never offers a button the server is going to refuse.
      const allowed = sched.canRequestShiftChange(shift);
      if (!allowed.ok) {
        return res.status(409).json({
          error: allowed.message, code: allowed.code,
          minutesOfNotice: allowed.minutesOfNotice,
          requiredMinutes: allowed.requiredMinutes,
          // A DEAD END IS HOW A CONTROL GETS WORKED AROUND. Inside the notice
          // window there is still a real problem to solve today, so the refusal
          // hands over the office number instead of just saying no.
          office: ORG.phone || null
        });
      }

      const { valid, errors, clean } = sched.validateChangeRequest(shift, req.body);
      if (!valid) return res.status(400).json({ error: 'That request needs correcting.', code: 'CHANGE_REQUEST_INVALID', errors });

      const rows = await readRows('shift_change_requests');
      // ONE open request per shift. Tapping Ask twice is the commonest way to
      // get two of everything, and two pending asks about one shift means the
      // office answers the same question twice.
      const open = sched.findOpenChangeRequest(rows, shift.id);
      if (open) {
        return res.status(409).json({
          error: 'You already have a request waiting on the office for this shift.',
          code: 'CHANGE_REQUEST_ALREADY_OPEN', request: publicChangeRequest(open)
        });
      }

      const row = {
        id: uuidv4(),
        shift_id: shift.id,
        client_id: shift.client_id,
        client_name: shift.client_name,
        caregiver_id: req.user.id,
        caregiver_name: req.user.name || req.user.email,
        kind: clean.kind,
        reason: clean.reason,
        proposed_start: clean.proposedStart || null,
        proposed_end: clean.proposedEnd || null,
        // A SNAPSHOT of the shift as it was asked about. If an admin moves the
        // shift before anyone answers, approving must not silently apply an old
        // ask to a different shift — the approve route compares these back.
        shift_start_at_request: shift.start,
        shift_end_at_request: shift.end,
        minutes_of_notice: allowed.minutesOfNotice,
        status: 'pending',
        requested_at: nowIso(),
        decided_at: null,
        decided_by_id: null,
        decided_by_name: null,
        decision_note: null
      };
      rows.push(row);
      await db.set('shift_change_requests', rows);

      await logActivity(req.user.id, row.caregiver_name, 'shift_change_requested', 'shift', shift.id,
        { clientId: shift.client_id, kind: row.kind, minutesOfNotice: row.minutes_of_notice, role: req.user.role });

      const when = time.fmtDateTime(shift.start);
      for (const admin of (await getUsers()).filter(u => u.role === ROLES.ADMIN && u.email)) {
        await queueNotification('shift_change_requested', admin.id, admin.email, admin.name,
          {
            subject: row.kind === 'drop'
              ? `${row.caregiver_name} cannot work a shift — ${row.client_name}`
              : `${row.caregiver_name} asked to move a shift — ${row.client_name}`,
            body: row.kind === 'drop'
              ? `${row.caregiver_name} has asked to hand back the ${when} shift for ${row.client_name}. Their reason: "${row.reason}". Nothing has changed yet — approving it puts the shift back in the open pool.`
              : `${row.caregiver_name} has asked to move the ${when} shift for ${row.client_name} to ${time.fmtDateTime(row.proposed_start)}–${time.fmtTime(row.proposed_end)}. Their reason: "${row.reason}". Nothing has changed yet.`,
            ctaUrl: links.PATHS.SCHEDULING, ctaLabel: 'Open scheduling'
          },
          { relatedEntityId: `${row.id}:requested`, relatedEntityType: 'shift', createdBy: req.user.id });
      }

      res.json({
        request: publicChangeRequest(row),
        message: row.kind === 'drop'
          ? 'Sent. The office will let you know — keep the shift until they do.'
          : 'Sent. The office will let you know — the shift has not moved yet.'
      });
    } catch (error) {
      console.error('Shift change request error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // GET …/change-requests — a caregiver sees their own; a manager sees them all.
  router.get('/api/scheduling/change-requests', authenticateToken, async (req, res) => {
    try {
      if (!isScheduleManager(req.user) && !isSchedulable(req.user)) {
        return res.status(403).json({ error: 'Caregiver or scheduling access required.', code: 'SCHEDULING_STAFF_ONLY' });
      }
      const rows = await readRows('shift_change_requests');
      // A caregiver cannot widen this with a query parameter: the filter is the
      // manager's, and passing somebody else's id still returns your own rows.
      let mine = isScheduleManager(req.user) ? rows : rows.filter(r => r && String(r.caregiver_id) === String(req.user.id));
      if (isScheduleManager(req.user) && req.query.status) {
        mine = mine.filter(r => r && r.status === String(req.query.status));
      }
      mine = mine.slice().sort((a, b) => String(b.requested_at || '').localeCompare(String(a.requested_at || '')));
      res.json({ requests: mine.slice(0, 200).map(publicChangeRequest) });
    } catch (error) {
      console.error('Change request list error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // Shared by approve and decline: find it, and refuse anything already answered.
  const loadPendingRequest = async (id) => {
    const rows = await readRows('shift_change_requests');
    const idx = rows.findIndex(r => r && r.id === id);
    if (idx === -1) return { error: { status: 404, body: { error: 'Request not found.', code: 'CHANGE_REQUEST_NOT_FOUND' } } };
    if (rows[idx].status !== 'pending') {
      return { error: { status: 409, body: {
        error: `That request was already ${rows[idx].status}${rows[idx].decided_by_name ? ` by ${rows[idx].decided_by_name}` : ''}.`,
        code: 'CHANGE_REQUEST_DECIDED', status: rows[idx].status
      } } };
    }
    return { rows, idx, row: rows[idx] };
  };

  // POST …/change-requests/:id/approve — a manager says yes, and it happens.
  router.post('/api/scheduling/change-requests/:id/approve', authenticateToken, requireScheduleManager, async (req, res) => {
    try {
      const found = await loadPendingRequest(req.params.id);
      if (found.error) return res.status(found.error.status).json(found.error.body);
      const { rows, idx, row } = found;

      const shifts = await readRows('shifts');
      const shift = shifts.find(r => r && r.id === row.shift_id);
      if (!shift) return res.status(404).json({ error: 'The shift this request is about no longer exists.', code: 'SHIFT_NOT_FOUND' });

      // THE SHIFT MAY HAVE MOVED SINCE THEY ASKED. Approving a stale ask would
      // apply a caregiver's reasoning about one time to a different one, which
      // is worse than refusing: nobody would know it had happened.
      if (shift.start !== row.shift_start_at_request || shift.end !== row.shift_end_at_request) {
        return res.status(409).json({
          error: 'This shift has changed since the request was made. Ask them to send a fresh request against the new time.',
          code: 'SHIFT_MOVED_SINCE_REQUEST',
          requestedAgainst: { start: row.shift_start_at_request, end: row.shift_end_at_request },
          current: { start: shift.start, end: shift.end }
        });
      }
      // The caregiver must still be the one holding it.
      if (String(shift.caregiver_id || '') !== String(row.caregiver_id)) {
        return res.status(409).json({
          error: `${row.caregiver_name} is no longer on this shift.`,
          code: 'SHIFT_HOLDER_CHANGED'
        });
      }

      // Captured BEFORE the edit: approving a change on an offer leaves it an
      // offer, and the answer to "what happens now" is different in each case.
      const wasOffer = shift.status === 'assigned';

      let applied = null;
      if (row.kind === 'time_change') {
        // ONE writer. Every rule a hand-typed correction obeys, this obeys.
        applied = await applyShiftEdit({
          shiftId: shift.id,
          body: { start: row.proposed_start, end: row.proposed_end },
          actor: req.user,
          context: { approvedRequest: true, willConfirm: wasOffer }
        });
        if (applied.error) {
          // The edit was refused — a conflict, an eligibility problem. The
          // request stays PENDING rather than being marked approved against a
          // change that did not happen.
          return res.status(applied.error.status).json({
            ...applied.error.body,
            code: applied.error.body.code || 'CHANGE_NOT_APPLIED',
            hint: 'The request is still waiting. Resolve this, then approve it again, or decline it.'
          });
        }
      } else {
        // A DROP hands the shift back to the open pool. Same machinery the
        // decline route uses, so a shift released this way is indistinguishable
        // from one released any other way — including keeping WHO let it go.
        const moved = await moveShift({
          shiftId: shift.id, to: 'open', actor: req.user,
          guard: (s) => (s.status === 'confirmed' ? null : {
            status: 409,
            body: { error: `That shift is ${String(s.status).replace(/_/g, ' ')} and cannot be handed back.`, code: 'SHIFT_NOT_RELEASABLE', from: s.status }
          })
        });
        if (moved.error) return res.status(moved.error.status).json(moved.error.body);
        await releaseCaregiver(moved.rows, shift.id, `Handed back with the office's approval: ${row.reason}`);
      }

      // ASKING FOR A TIME IS AGREEING TO WORK IT (owner rule, 2026-09-21).
      // A caregiver only proposes a new time because they would take the shift
      // at that time, so approving it puts the shift on their schedule rather
      // than sending it back round for a second acceptance they have already
      // given in substance. Sending it back would mean the office approves a
      // change and still does not know whether the shift is staffed.
      //
      // Done through the state machine's own transition, so a shift confirmed
      // this way is indistinguishable from one confirmed by Accept — same
      // stamps, same client notification.
      let confirmedNow = false;
      if (wasOffer && row.kind === 'time_change') {
        const conf = await moveShift({
          shiftId: shift.id, to: 'confirmed', actor: req.user,
          guard: (sh) => (sh.status === 'assigned' ? null : {
            status: 409,
            body: { error: `That shift is ${String(sh.status).replace(/_/g, ' ')} and could not be confirmed.`, code: 'SHIFT_NOT_ASSIGNED', from: sh.status }
          })
        });
        if (conf.error) {
          // The time HAS moved — reporting success here would leave an offer
          // sitting at a new time that nobody knows is unconfirmed.
          return res.status(conf.error.status).json({
            ...conf.error.body,
            code: 'CHANGE_APPLIED_NOT_CONFIRMED',
            warning: 'The new time was saved, but the shift could not be confirmed. Confirm or reassign it by hand.'
          });
        }
        confirmedNow = true;
        await notifyConfirmed(conf.shift, req.user);
      }

      rows[idx].status = 'approved';
      rows[idx].decided_at = nowIso();
      rows[idx].decided_by_id = req.user.id;
      rows[idx].decided_by_name = req.user.name || req.user.email;
      rows[idx].decision_note = String((req.body || {}).note || '').trim().slice(0, 1000) || null;
      await db.set('shift_change_requests', rows);

      await logActivity(req.user.id, rows[idx].decided_by_name, 'shift_change_approved', 'shift', shift.id,
        { clientId: shift.client_id, kind: row.kind, requestId: row.id, role: req.user.role });

      // A time change already emailed the caregiver through the shared editor —
      // emailing again here would tell them the same thing twice. A drop did
      // not, so it says so here.
      if (row.kind === 'drop') {
        const holder = await freshUser(row.caregiver_id);
        if (holder && holder.email) {
          await queueNotification('shift_change_approved', holder.id, holder.email, holder.name,
            {
              subject: `You are off the ${time.fmtDateTime(row.shift_start_at_request)} shift`,
              body: `The office has approved handing back your ${time.fmtDateTime(row.shift_start_at_request)} shift for ${row.client_name}. It is open for another caregiver and you are no longer scheduled for it.`,
              ctaUrl: links.shiftFor(), ctaLabel: 'View your schedule'
            },
            { relatedEntityId: `${row.id}:approved`, relatedEntityType: 'shift', createdBy: req.user.id });
        }
      }

      const afterRow = (await readRows('shifts')).find(r => r.id === shift.id);
      res.json({
        request: publicChangeRequest(rows[idx]),
        shift: applied ? applied.shift : publicShift(afterRow),
        // Says plainly whether the shift is now STAFFED, because "Approved" on
        // its own does not tell an office whether to keep chasing it.
        confirmed: confirmedNow,
        message: row.kind === 'drop'
          ? `Approved. The shift is back in the open pool and ${row.caregiver_name} has been told.`
          : (confirmedNow
            ? `Approved. The shift has moved and is confirmed to ${row.caregiver_name} — they asked for that time, so it is on their schedule and needs no further acceptance.`
            : (applied ? applied.message : 'Approved.'))
      });
    } catch (error) {
      console.error('Change request approve error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // POST …/change-requests/:id/decline — a manager says no, and says why.
  router.post('/api/scheduling/change-requests/:id/decline', authenticateToken, requireScheduleManager, async (req, res) => {
    try {
      const note = String((req.body || {}).note || '').trim();
      // A REASON IS REQUIRED. A caregiver told only "no" asks again, or stops
      // asking and just does not turn up — the same rule the rejected document
      // upload follows.
      if (!note) {
        return res.status(400).json({ error: 'Say why, so they know where they stand.', code: 'DECLINE_NOTE_REQUIRED' });
      }
      const found = await loadPendingRequest(req.params.id);
      if (found.error) return res.status(found.error.status).json(found.error.body);
      const { rows, idx, row } = found;

      rows[idx].status = 'declined';
      rows[idx].decided_at = nowIso();
      rows[idx].decided_by_id = req.user.id;
      rows[idx].decided_by_name = req.user.name || req.user.email;
      rows[idx].decision_note = note.slice(0, 1000);
      await db.set('shift_change_requests', rows);

      await logActivity(req.user.id, rows[idx].decided_by_name, 'shift_change_declined', 'shift', row.shift_id,
        { clientId: row.client_id, kind: row.kind, requestId: row.id, role: req.user.role });

      const declinedShift = (await readRows('shifts')).find(r => r && r.id === row.shift_id) || null;
      const holder = await freshUser(row.caregiver_id);
      if (holder && holder.email) {
        await queueNotification('shift_change_declined', holder.id, holder.email, holder.name,
          {
            subject: `Your shift request was not approved — ${row.client_name}`,
            // An OFFER is not "still yours" — they never accepted it, and the
            // thing they need to know is that the original offer stands and is
            // still waiting on their answer.
            body: `The office could not approve your request about the ${time.fmtDateTime(row.shift_start_at_request)} shift for ${row.client_name}. ${rows[idx].decided_by_name} said: "${rows[idx].decision_note}".`
              + (declinedShift && declinedShift.status === 'assigned'
                ? ' The original offer stands — accept it or decline it in the app.'
                : ' The shift is unchanged and still yours.'),
            ctaUrl: links.shiftFor(), ctaLabel: 'View your schedule'
          },
          { relatedEntityId: `${row.id}:declined`, relatedEntityType: 'shift', createdBy: req.user.id });
      }

      res.json({ request: publicChangeRequest(rows[idx]), message: `Declined. ${row.caregiver_name} has been told, with your reason.` });
    } catch (error) {
      console.error('Change request decline error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // POST …/change-requests/:id/withdraw — the caregiver changes their mind.
  // Their own request only: sorting itself out before anyone acts is the best
  // outcome, and it should not need an admin to clear the queue.
  router.post('/api/scheduling/change-requests/:id/withdraw', authenticateToken, requireSchedulable, async (req, res) => {
    try {
      const found = await loadPendingRequest(req.params.id);
      if (found.error) return res.status(found.error.status).json(found.error.body);
      const { rows, idx, row } = found;
      if (String(row.caregiver_id) !== String(req.user.id)) {
        return res.status(403).json({ error: 'That request is not yours.', code: 'REQUEST_NOT_YOURS' });
      }
      rows[idx].status = 'withdrawn';
      rows[idx].decided_at = nowIso();
      rows[idx].decided_by_id = req.user.id;
      rows[idx].decided_by_name = req.user.name || req.user.email;
      await db.set('shift_change_requests', rows);
      await logActivity(req.user.id, rows[idx].decided_by_name, 'shift_change_withdrawn', 'shift', row.shift_id,
        { clientId: row.client_id, kind: row.kind, requestId: row.id, role: req.user.role });
      res.json({ request: publicChangeRequest(rows[idx]), message: 'Withdrawn. The office will not see it any more.' });
    } catch (error) {
      console.error('Change request withdraw error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // Both parties are told on confirmation — the caregiver and the client.
  const notifyConfirmed = async (shift, actor) => {
    const users = await getUsers();
    const when = time.fmtDateTime(shift.start);
    const caregiver = users.find(u => u.id === shift.caregiver_id);
    if (caregiver && caregiver.email) {
      await queueNotification('shift_confirmed', caregiver.id, caregiver.email, caregiver.name,
        {
          subject: `Shift confirmed — ${shift.client_name}`,
          body: `Your ${when} shift for ${shift.client_name} is confirmed.`,
          ctaUrl: links.shiftFor(), ctaLabel: 'View the shift'
        },
        { relatedEntityId: `${shift.id}:confirmed`, relatedEntityType: 'shift', createdBy: actor.id });
    }
    const client = users.find(u => u.id === shift.client_id);
    if (client && client.email) {
      await queueNotification('shift_confirmed_client', client.id, client.email, client.name,
        {
          subject: 'Your care visit is confirmed',
          body: `${shift.caregiver_name || 'A caregiver'} is confirmed for ${when}.`,
          ctaUrl: links.PATHS.PORTAL, ctaLabel: 'Open your portal'
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

      const at = nowIso();

      // Too early to start the clock. Checked before anything is written, so a
      // refusal leaves the shift confirmed and un-started rather than half
      // begun. Unlike the geofence this REFUSES — see the note on
      // CLOCK_IN_WINDOW_MINUTES for why the two differ. Late is never blocked.
      const window = sched.clockInWindow({ shift, at });
      if (!window.allowed) {
        const opens = new Date(window.opensAt);
        return res.status(409).json({
          error: `Too early. You can clock in from ${time.fmtDayTime(opens)}, two hours before the shift starts.`,
          code: 'CLOCK_IN_TOO_EARLY',
          opensAt: window.opensAt,
          minutesEarly: window.minutesEarly
        });
      }

      const client = await loadClient(shift.client_id);
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

      // The visit has to be DOCUMENTED before the clock stops. Checked here,
      // before anything is written, so a refused clock-out leaves the shift
      // exactly as it was — still in progress, its time log still open.
      // Session 6 owns caregiver_visit_logs and already carries shift_id on
      // the row; this is the rule that makes it more than a marker.
      // It has to be THIS caregiver's log for THIS client on THIS shift.
      // Matching the shift id alone would let a log filed by someone else, or
      // for another client, satisfy a gate that was never theirs to satisfy.
      const visitLogs = await readRows('caregiver_visit_logs');
      const documented = visitLogs.some(v =>
        v && String(v.shift_id) === String(shift.id) &&
        String(v.caregiver_id) === String(req.user.id) &&
        String(v.client_id) === String(shift.client_id));
      if (!documented) {
        return res.status(409).json({
          error: 'File the visit log for this visit before you clock out.',
          code: 'VISIT_LOG_REQUIRED',
          shiftId: shift.id,
          clientId: shift.client_id
        });
      }

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
      if (!isScheduleManager(req.user) && !isSchedulable(req.user)) {
        return res.status(403).json({ error: 'Caregiver or clinical access required.', code: 'SCHEDULING_STAFF_ONLY' });
      }
      const logs = await readRows('time_logs');
      let mine = isScheduleManager(req.user) ? logs : logs.filter(l => l && l.caregiver_id === req.user.id);
      if (isScheduleManager(req.user) && req.query.caregiverId) mine = mine.filter(l => l.caregiver_id === String(req.query.caregiverId));
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

  // POST /api/scheduling/time-logs — the office enters hours that were never
  // clocked. A dead phone, a forgotten tap, a visit nobody posted as a shift:
  // without this those hours cannot be paid at all, because every other way
  // into this collection starts at a clock-in on the caregiver's device.
  //
  // A REASON IS MANDATORY, exactly as it is for an edit. These hours are
  // ATTESTED by an administrator rather than observed by the app, so the row
  // says so in three places that already travel everywhere: the manual_entry
  // flag, an unverifiable geofence verdict (never "inside" — the app must not
  // claim a location it did not check), and the entering admin's name.
  router.post('/api/scheduling/time-logs', authenticateToken, requireAdmin, async (req, res) => {
    try {
      const body = req.body || {};
      const reason = String(body.reason || '').trim();
      if (!reason) {
        return res.status(400).json({
          error: 'Say why these hours are being entered by hand.',
          code: 'ENTRY_REASON_REQUIRED'
        });
      }

      const clockInAt = isoOrNull(body.clockInAt);
      const clockOutAt = body.clockOutAt ? isoOrNull(body.clockOutAt) : null;
      if (!clockInAt) return res.status(400).json({ error: 'A valid start time is required.', code: 'CLOCK_IN_INVALID' });
      if (body.clockOutAt && !clockOutAt) {
        return res.status(400).json({ error: 'That end time is not a valid timestamp.', code: 'CLOCK_OUT_INVALID' });
      }
      if (clockOutAt && clockOutAt < clockInAt) {
        return res.status(400).json({ error: 'The end time is before the start time.', code: 'CLOCK_OUT_BEFORE_IN' });
      }

      const users = await getUsers();
      const caregiver = users.find(u => u && u.id === String(body.caregiverId || ''));
      if (!caregiver || !isSchedulable(caregiver)) {
        return res.status(400).json({ error: 'Pick a caregiver.', code: 'CAREGIVER_REQUIRED' });
      }
      const client = await loadClient(String(body.clientId || ''));
      if (!client) return res.status(400).json({ error: 'Pick a client.', code: 'CLIENT_REQUIRED' });

      // Optional: tie it to a real shift. It must be that caregiver's and that
      // client's, or the entry would attach hours to work someone else did.
      let shift = null;
      if (body.shiftId) {
        const shifts = await readRows('shifts');
        shift = shifts.find(s => s && s.id === String(body.shiftId)) || null;
        if (!shift) return res.status(404).json({ error: 'That shift does not exist.', code: 'SHIFT_NOT_FOUND' });
        if (shift.caregiver_id !== caregiver.id) {
          return res.status(409).json({ error: 'That shift belongs to a different caregiver.', code: 'SHIFT_CAREGIVER_MISMATCH' });
        }
        if (String(shift.client_id) !== String(client.id)) {
          return res.status(409).json({ error: 'That shift is for a different client.', code: 'SHIFT_CLIENT_MISMATCH' });
        }
      }

      const at = nowIso();
      const unverified = { verdict: 'unverifiable', reason: 'MANUAL_ENTRY', radius: null, distance: null };
      const row = {
        id: uuidv4(),
        shift_id: shift ? shift.id : null,
        client_id: client.id,
        client_name: client.name,
        caregiver_id: caregiver.id,
        caregiver_name: caregiver.name || caregiver.email,
        license_level: caregiver.licenseLevel || null,
        // Only a real shift carries a schedule. Copying the entered times in
        // here would invent a schedule that never existed and make the payroll
        // export read as though the caregiver worked exactly to plan.
        scheduled_start: shift ? shift.start : null,
        scheduled_end: shift ? shift.end : null,
        clock_in_at: clockInAt,
        clock_in_gps: null,
        clock_in_geofence: unverified,
        clock_out_at: clockOutAt,
        clock_out_gps: null,
        clock_out_geofence: clockOutAt ? unverified : null,
        total_minutes: clockOutAt ? sched.totalMinutes(clockInAt, clockOutAt) : null,
        flags: clockOutAt ? ['manual_entry'] : ['manual_entry', 'no_clock_out'],
        edited: false,
        edit_reason: null,
        entered_manually: true,
        entry_reason: reason,
        entered_by: req.user.id,
        entered_by_name: req.user.name || req.user.email,
        created_at: at
      };

      const logs = await readRows('time_logs');
      logs.push(row);
      await db.set('time_logs', logs);

      // Same append-only trail an edit writes, so "who put these hours in the
      // system, and why" has one answer whether they were typed or corrected.
      const edits = await readRows('time_log_edits');
      edits.push({
        id: uuidv4(),
        time_log_id: row.id,
        kind: 'manual_entry',
        before: null,
        after: { clockInAt: row.clock_in_at, clockOutAt: row.clock_out_at, totalMinutes: row.total_minutes },
        reason,
        by: req.user.id,
        by_name: row.entered_by_name,
        at
      });
      await db.set('time_log_edits', edits);

      await logActivity(req.user.id, row.entered_by_name, 'time_log_entered_manually', 'time_log', row.id, {
        caregiverId: caregiver.id, clientId: client.id, shiftId: row.shift_id,
        clockInAt: row.clock_in_at, clockOutAt: row.clock_out_at, reason
      });

      res.json({ timeLog: publicTimeLog(row), message: 'Hours entered and flagged as a manual entry.' });
    } catch (error) {
      console.error('Manual time-log entry error:', error);
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

      // Resolve each row's pay rate (owner request, 2026-09-13). A pay rate
      // that payroll never reads is a number stored and left inert — the exact
      // trap the competency ceiling was, one week earlier in this same repo.
      const allUsers = await getUsers();
      const usersById = new Map(allUsers.map(u => [u.id, u]));
      const shiftRows = await readRows('shifts');
      const shiftsById = new Map(shiftRows.filter(r => r && r.id).map(r => [r.id, r]));

      const rows = logs.map(l => {
        const shiftDate = String(l.clock_in_at || '').slice(0, 10);
        const period = sched.payPeriodFor(shiftDate) || { start: '', end: '' };
        // Shift rate → this caregiver's rate for this client → their base rate.
        const resolved = cg.resolvePayRate(
          usersById.get(l.caregiver_id),
          l.client_id,
          shiftsById.get(l.shift_id)
        );
        const hoursNum = sched.minutesToHours(l.total_minutes);
        // An unset rate prints EMPTY, never 0.00 — a blank cell is a question
        // for whoever runs payroll; a zero is an answer, and the wrong one.
        // Same for an open shift, where hours is null rather than zero.
        const gross = (resolved.rate !== null && hoursNum !== null && hoursNum !== undefined)
          ? (Math.round(resolved.rate * Number(hoursNum) * 100) / 100).toFixed(2)
          : '';
        return {
          payRate: resolved.rate === null ? '' : resolved.rate.toFixed(2),
          payRateSource: resolved.rate === null ? 'not set' : resolved.source,
          grossPay: gross,
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
          source: l.entered_manually ? 'Manual entry' : 'Clocked',
          enteredBy: l.entered_manually ? (l.entered_by_name || '') : '',
          payPeriodStart: period.start,
          payPeriodEnd: period.end
        };
      });

      await logActivity(req.user.id, req.user.name || req.user.email, 'payroll_csv_exported', 'time_log', null,
        { from, to, rows: rows.length });

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', contentDisposition('attachment', `gfc_payroll_${from}_to_${to}.csv`));
      res.send(sched.toPayrollCsv(rows));
    } catch (error) {
      console.error('Payroll CSV error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // GET /api/scheduling/billing.csv — admin only. What gets INVOICED, which is
  // a different question from what payroll.csv answers: one line per COMPLETED
  // visit, grouped by client. A shift still in progress has no final hours, so
  // it is not billable and is not listed — a half-open visit on an invoice is
  // a credit note waiting to happen.
  router.get('/api/scheduling/billing.csv', authenticateToken, requireAdmin, async (req, res) => {
    try {
      const from = String(req.query.from || '');
      const to = String(req.query.to || '');
      if (!sched.isIsoDate(from) || !sched.isIsoDate(to)) {
        return res.status(400).json({ error: 'Give a from and to date (YYYY-MM-DD).', code: 'DATE_RANGE_REQUIRED' });
      }
      if (to < from) return res.status(400).json({ error: 'The end date is before the start date.', code: 'DATE_RANGE_INVERTED' });
      const onlyClient = req.query.clientId ? String(req.query.clientId) : null;

      const visitLogs = await readRows('caregiver_visit_logs');
      const documentedShiftIds = new Set(visitLogs.filter(v => v && v.shift_id).map(v => String(v.shift_id)));

      const logs = (await readRows('time_logs')).filter(l => {
        if (!l || !l.clock_out_at) return false;          // not finished, not billable
        if (onlyClient && String(l.client_id) !== onlyClient) return false;
        const d = String(l.clock_in_at || '').slice(0, 10);
        return d >= from && d <= to;
      }).sort((a, b) =>
        String(a.client_name || '').localeCompare(String(b.client_name || '')) ||
        String(a.clock_in_at).localeCompare(String(b.clock_in_at)));

      const rows = logs.map(l => ({
        clientName: l.client_name,
        serviceDate: String(l.clock_in_at || '').slice(0, 10),
        caregiverName: l.caregiver_name,
        licenseLevel: l.license_level ? cg.LICENSE_LABELS[l.license_level] || l.license_level : '',
        scheduledStart: l.scheduled_start,
        scheduledEnd: l.scheduled_end,
        clockInAt: l.clock_in_at,
        clockOutAt: l.clock_out_at || '',
        hours: sched.minutesToHours(l.total_minutes),
        // Says what the GPS check could actually establish, never more: an
        // unverifiable clock-in is not the same claim as a verified one, and
        // an invoice should not blur them.
        verification: (l.clock_in_geofence && l.clock_in_geofence.verdict) || 'unverifiable',
        documented: documentedShiftIds.has(String(l.shift_id)) ? 'yes' : 'no'
      }));

      await logActivity(req.user.id, req.user.name || req.user.email, 'billing_csv_exported', 'time_log', null,
        { from, to, clientId: onlyClient, rows: rows.length });

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', contentDisposition('attachment', `gfc_billing_${from}_to_${to}.csv`));
      res.send(sched.toPayrollCsv(rows, sched.BILLING_CSV_COLUMNS));
    } catch (error) {
      console.error('Billing CSV error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // GET /api/scheduling/my-hours.csv — a caregiver's OWN hours, for their own
  // records. Resolved from the token, so there is no id to pass and no other
  // caregiver's rows to reach. The date range is optional here (unlike
  // payroll): this is someone pulling their own timesheet, not a pay run.
  router.get('/api/scheduling/my-hours.csv', authenticateToken, requireSchedulable, async (req, res) => {
    try {
      const from = req.query.from ? String(req.query.from) : '';
      const to = req.query.to ? String(req.query.to) : '';
      if (from && !sched.isIsoDate(from)) return res.status(400).json({ error: 'That start date is not YYYY-MM-DD.', code: 'DATE_INVALID' });
      if (to && !sched.isIsoDate(to)) return res.status(400).json({ error: 'That end date is not YYYY-MM-DD.', code: 'DATE_INVALID' });
      if (from && to && to < from) return res.status(400).json({ error: 'The end date is before the start date.', code: 'DATE_RANGE_INVERTED' });

      const logs = (await readRows('time_logs')).filter(l => {
        if (!l || l.caregiver_id !== req.user.id) return false;
        const d = String(l.clock_in_at || '').slice(0, 10);
        if (from && d < from) return false;
        if (to && d > to) return false;
        return true;
      }).sort((a, b) => String(a.clock_in_at).localeCompare(String(b.clock_in_at)));

      const rows = logs.map(l => ({
        shiftDate: String(l.clock_in_at || '').slice(0, 10),
        clientName: l.client_name,
        scheduledStart: l.scheduled_start,
        scheduledEnd: l.scheduled_end,
        clockInAt: l.clock_in_at,
        clockOutAt: l.clock_out_at || '',
        hours: sched.minutesToHours(l.total_minutes),
        flags: (l.flags || []).join(' '),
        edited: l.edited ? 'yes' : ''
      }));

      await logActivity(req.user.id, req.user.name || req.user.email, 'caregiver_hours_exported', 'time_log', null,
        { from: from || null, to: to || null, rows: rows.length });

      const stamp = `${from || 'all'}_to_${to || 'today'}`;
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', contentDisposition('attachment', `my_hours_${stamp}.csv`));
      res.send(sched.toPayrollCsv(rows, sched.CAREGIVER_HOURS_CSV_COLUMNS));
    } catch (error) {
      console.error('Caregiver hours CSV error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // GET /api/scheduling/summary — the dashboard block (2026-09-13, owner request).
  //
  // One endpoint, one gate. The alternative was the admin hub calling four list
  // routes and doing the arithmetic itself, which would put a second copy of
  // "what counts as needing attention" in a page — and a dashboard that
  // disagrees with the screen it links to is worse than no dashboard.
  //
  // Every number is a THING SOMEONE MUST DO, not a vanity count, and each one
  // names where to go and answer it. Counts only: no client names, no
  // caregiver names, no addresses. A dashboard tile is a glance, and a glance
  // does not need PHI on it.
  router.get('/api/scheduling/summary', authenticateToken, requireScheduleManager, async (req, res) => {
    try {
      const [shifts, logs, users] = await Promise.all([
        readRows('shifts'), readRows('time_logs'), getUsers()
      ]);
      const now = new Date();
      const dayStart = new Date(now); dayStart.setUTCHours(0, 0, 0, 0);
      const dayEnd = new Date(dayStart.getTime() + 86400000);
      const within = (v, a, b) => {
        const t = new Date(v).getTime();
        return isFinite(t) && t >= a.getTime() && t < b.getTime();
      };
      const live = shifts.filter(r => r && r.status);
      const clients = users.filter(u => u.role === ROLES.CLIENT);

      res.json({
        summary: {
          today: live.filter(r => within(r.start, dayStart, dayEnd)
            && ['confirmed', 'in_progress', 'completed'].includes(r.status)).length,
          inProgress: live.filter(r => r.status === 'in_progress').length,
          // Unfilled work: posted and nobody has taken it.
          openUnfilled: live.filter(r => r.status === 'open').length,
          // Pathway A — a caregiver claimed and is WAITING ON AN ADMIN.
          awaitingApproval: live.filter(r => r.status === 'claimed').length,
          // Pathway B — admin assigned and is waiting on the caregiver.
          awaitingAcceptance: live.filter(r => r.status === 'assigned').length,
          // A clock-in or clock-out that did not look right and nobody has
          // corrected. `admin_edited` means someone already dealt with it.
          flaggedTimeLogs: logs.filter(l => l && Array.isArray(l.flags)
            && l.flags.length > 0 && !l.flags.includes('admin_edited')).length,
          // Without coordinates a clock-in there can only ever be unverifiable.
          clientsMissingCoordinates: clients.filter(u => !sched.clientCoords(u)).length,
          clientCount: clients.length
        }
      });
    } catch (error) {
      console.error('Scheduling summary error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // GET /api/scheduling/caregivers — admin picker: who can hold a shift.
  router.get('/api/scheduling/caregivers', authenticateToken, requireScheduleManager, async (req, res) => {
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
          hasCoordinates: !!sched.clientCoords(u),
          coordinates: sched.clientCoords(u),
          addressLine: addressLine(u)
        })),
        // WHAT THIS VIEWER MAY DO, answered by the server on every request.
        // Reading it off the login stored in the browser would mean a role an
        // admin narrowed this morning keeps its buttons until the next sign-in
        // — the trap `req.user.clinicalRole` was fixed for in 4.8. A manager is
        // told which controls are not theirs rather than handed buttons that
        // answer 403.
        access: {
          role: req.user.role,
          isManager: !!req.user.isManager,
          manageSchedule: isScheduleManager(req.user),
          managePay: isAdmin(req.user),
          manageLocations: isAdmin(req.user),
          canOverrideGates: isAdmin(req.user)
        }
      });
    } catch (error) {
      console.error('Scheduling roster error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // PUT /api/scheduling/clients/:clientId/location — admin records the client's
  // address coordinates and, optionally, a geofence radius for that address.
  //
  // This is the missing half of the geofence: the check exists, the data did
  // not, so every clock-in recorded `unverifiable` and there was nowhere in the
  // app to fix that. Admin-only, and it writes ONLY the location fields — a
  // scheduling screen has no business touching the rest of a client record.
  router.put('/api/scheduling/clients/:clientId/location', authenticateToken, requireAdmin, async (req, res) => {
    try {
      const { valid, errors, clean } = sched.validateClientLocation(req.body);
      if (!valid) {
        return res.status(400).json({ error: errors[0].message, code: errors[0].code, errors });
      }

      const users = await getUsers();
      const idx = users.findIndex(u => u.id === req.params.clientId && u.role === ROLES.CLIENT);
      if (idx === -1) return res.status(404).json({ error: 'Client not found.', code: 'CLIENT_NOT_FOUND' });

      const before = sched.clientCoords(users[idx]);
      const address = { ...(users[idx].address && typeof users[idx].address === 'object' ? users[idx].address : {}) };
      if (clean.clearing) {
        delete address.lat;
        delete address.lng;
      } else {
        address.lat = clean.lat;
        address.lng = clean.lng;
      }
      users[idx].address = address;
      if (clean.radiusProvided) {
        if (clean.geofenceRadiusMeters === null) delete users[idx].geofenceRadiusMeters;
        else users[idx].geofenceRadiusMeters = clean.geofenceRadiusMeters;
      }

      await db.set('users', users);
      if (typeof deps.invalidateUsersCache === 'function') deps.invalidateUsersCache();

      // The audit entry records THAT the location changed and by whom, never the
      // coordinates: an activity log is not a second copy of where a patient lives.
      await logActivity(req.user.id, req.user.name || req.user.email, 'client_location_set', 'user', users[idx].id,
        {
          hadCoordinates: !!before,
          hasCoordinates: !!sched.clientCoords(users[idx]),
          cleared: clean.clearing,
          geofenceRadiusMeters: sched.geofenceRadiusFor(users[idx])
        });

      res.json({
        client: {
          id: users[idx].id, name: users[idx].name,
          hasCoordinates: !!sched.clientCoords(users[idx]),
          geofenceRadiusMeters: sched.geofenceRadiusFor(users[idx]),
          coordinates: sched.clientCoords(users[idx])
        },
        message: clean.clearing
          ? 'Coordinates cleared. Clock-ins at this client will record as geofence-unverifiable.'
          : `Saved. Clock-ins at this client are now checked against a ${sched.geofenceRadiusFor(users[idx])}m radius.`
      });
    } catch (error) {
      console.error('Client location error:', error);
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
    // Only the rate POSTED ON THE SHIFT, never anyone's base or per-client rate.
    // A posted rate is identical for everyone eligible to take the shift, so
    // showing it in the open pool leaks nothing about another caregiver's pay —
    // and a caregiver deciding whether to pick up a shift is entitled to know
    // what it pays. The client- and family-facing reader is a separate
    // allow-list (my-upcoming-shifts) and carries no rate at all: what we pay a
    // caregiver is the margin, and the client never sees it.
    payRate: cg.normalizePayRate(r.pay_rate),
    status: r.status,
    createdByName: r.created_by_name, createdAt: r.created_at,
    claimedAt: r.claimed_at, assignedAt: r.assigned_at, confirmedAt: r.confirmed_at,
    startedAt: r.started_at, completedAt: r.completed_at,
    cancelledAt: r.cancelled_at, cancelReason: r.cancel_reason || null,
    reopenedAt: r.reopened_at,
    releasedFromName: r.released_from_name || null, releasedReason: r.released_reason || null,
    // A shift that has been corrected says so on the board. An edit that leaves
    // no trace is the same silent rewrite the append-only rules exist to stop:
    // a caregiver who remembers a different time has to be able to see that the
    // time moved, and who moved it.
    editedAt: r.edited_at || null, editedByName: r.edited_by_name || null,
    editCount: Number(r.edit_count) || 0,
    // Which batch posted it, so a mistaken bulk post can be found as the one
    // thing it was rather than forty unrelated rows.
    bulkBatchId: r.bulk_batch_id || null,
    // An override that lives only in the store is barely better than a silent
    // one. It reaches every reader of the board so the shift itself says the
    // client was not enrolled when it was posted.
    enrollmentOverride: r.enrollment_override || null,
    // Same rule for the caregiver's side of it: an admin who scheduled someone
    // who was not cleared said why, and the board shows it. A stamp only in the
    // store is one nobody reads.
    clearanceOverride: r.clearance_override || null
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
    editedByName: l.edited_by_name || null, editedAt: l.edited_at || null,
    // Attested by the office rather than observed by the app. Surfaced so a
    // reviewer can tell a typed entry from a clocked one without reading flags.
    enteredManually: !!l.entered_manually,
    entryReason: l.entry_reason || null,
    enteredByName: l.entered_by_name || null
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
