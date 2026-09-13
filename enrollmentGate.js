// ============================================================================
// THE ENROLLMENT GATE ON SCHEDULING (owner decision, 2026-09-13)
// ============================================================================
// Until now `enrolled` was a decoration. `intake_complete` already unlocked the
// client portal, so approval changed nothing a client or a staff member could
// observe, and NOTHING checked enrollment before work was scheduled against a
// person: a client sitting at intake_pending with zero consents on file could
// have shifts posted against them and a caregiver clocked in on their doorstep.
//
// This module is the rule, in one place, because there are two scheduling
// systems by design — PHCP shifts live in the app store, clinical appointments
// live in OpenEMR — and a gate written twice is a gate that disagrees with
// itself. Both call in here.
//
// WHAT IT GATES: creating new work against a client. Posting a shift, requesting
// one, booking a clinical appointment. It deliberately does NOT gate a caregiver
// finishing work already in flight — clocking out of a shift that is underway,
// a visit log for a visit that happened. Care that was given gets documented
// whatever the paperwork says; refusing the record would lose the visit and
// leave the caregiver unpaid without un-giving the care.
//
// THE OVERRIDE. An administrator may schedule over this refusal with a reason.
// An urgent start is a real situation, and a gate with no documented way
// through is one that gets worked around in ways nobody can audit. So the
// bypass exists, it is admin-only, the reason is required, and it is stamped on
// the row it created. A silent override would be indistinguishable from an
// enrolled client the following week, which is exactly what it must not be.
//
// Pure functions over a client record — no I/O, no request context — so the
// routes, the tests and the probe all read the same rule.
// ============================================================================

'use strict';

// The one status that permits scheduling. Named rather than inlined so the
// answer to "what unlocks scheduling" has exactly one place to be read.
const SCHEDULABLE_STATUS = 'enrolled';

const statusOf = (client) => (client && client.enrollmentStatus) || 'intake_pending';

const displayName = (client) =>
  (client && (client.name || client.practiceName)) || 'This client';

/**
 * May work be scheduled against this client right now?
 * → { allowed, status, code, message }
 *
 * A refusal names WHICH state the client is in and what closes it, because
 * "not enrolled" is two different situations with two different next actions:
 * one is waiting on the client, the other is waiting on staff.
 */
function schedulingEligibility(client) {
  if (!client) {
    return {
      allowed: false, status: null, code: 'CLIENT_NOT_FOUND',
      message: 'No client record was found for this request.'
    };
  }
  const status = statusOf(client);
  if (status === SCHEDULABLE_STATUS) {
    return { allowed: true, status, code: null, message: null };
  }
  const who = displayName(client);
  if (status === 'intake_complete') {
    return {
      allowed: false, status, code: 'CLIENT_NOT_ENROLLED',
      message: `${who} has finished intake but their enrollment has not been approved yet. An administrator approves it in the enrollment view, then care can be scheduled.`
    };
  }
  return {
    allowed: false, status, code: 'CLIENT_NOT_ENROLLED',
    message: `${who} has not completed enrollment. Their intake and required consents have to be on file before care can be scheduled.`
  };
}

/**
 * Resolve an override request against the acting user.
 * → { applied, refusal }  — `refusal` is { code, message } when the override
 *   was asked for but may not be granted, and null otherwise.
 *
 * Two things can go wrong and they are different facts. A non-admin asking to
 * override is a permission answer; an admin asking without a reason is a
 * completeness answer. Collapsing them into one message would leave an admin
 * who simply forgot the reason believing they lack the right.
 */
function resolveSchedulingOverride(user, { override, overrideReason }, isAdmin) {
  if (!override) return { applied: false, refusal: null };
  if (!isAdmin) {
    return {
      applied: false,
      refusal: {
        code: 'OVERRIDE_ADMIN_ONLY',
        message: 'Only an administrator can schedule care for a client who is not enrolled.'
      }
    };
  }
  const reason = String(overrideReason || '').trim();
  if (!reason) {
    return {
      applied: false,
      refusal: {
        code: 'OVERRIDE_REASON_REQUIRED',
        message: 'Scheduling for a client who is not enrolled needs a reason. Say why this cannot wait for enrollment.'
      }
    };
  }
  return {
    applied: true,
    refusal: null,
    stamp: {
      reason: reason.slice(0, 1000),
      byId: (user && user.id) || null,
      byName: (user && (user.name || user.email)) || null,
      at: new Date().toISOString()
    }
  };
}

/**
 * The whole decision in one call, for a route that has the client and the body.
 * → { ok: true, override }  |  { ok: false, status, code, message }
 *
 * `status` is the HTTP status the caller should answer with: 409 for a client
 * who is simply not enrolled yet (a state that will change), 400 for a
 * malformed override, 403 for one the actor may not make.
 */
function checkSchedulingAllowed(client, body, user, isAdmin) {
  const eligibility = schedulingEligibility(client);
  if (eligibility.allowed) return { ok: true, override: null };
  if (eligibility.code === 'CLIENT_NOT_FOUND') {
    return { ok: false, status: 404, code: eligibility.code, message: eligibility.message };
  }

  const o = resolveSchedulingOverride(user, body || {}, isAdmin);
  if (o.refusal) {
    return {
      ok: false,
      status: o.refusal.code === 'OVERRIDE_ADMIN_ONLY' ? 403 : 400,
      code: o.refusal.code,
      message: o.refusal.message
    };
  }
  if (o.applied) {
    // What was overridden is frozen onto the stamp. Reading the client's
    // status later would report where they got to since, not what was true
    // when somebody decided to go ahead anyway.
    return { ok: true, override: { ...o.stamp, enrollmentStatus: eligibility.status } };
  }
  return {
    ok: false, status: 409, code: eligibility.code, message: eligibility.message,
    enrollmentStatus: eligibility.status,
    // Named so the UI can offer the override instead of leaving an admin to
    // find out from the API that one exists.
    overridable: !!isAdmin
  };
}

module.exports = {
  SCHEDULABLE_STATUS,
  schedulingEligibility,
  resolveSchedulingOverride,
  checkSchedulingAllowed
};
