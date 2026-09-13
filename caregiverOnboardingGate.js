// ============================================================================
// THE CAREGIVER ONBOARDING GATE (owner decision, 2026-09-13)
// ============================================================================
// A caregiver account used to be usable the moment somebody set a password on
// it. The welcome packet was a PDF that travelled by email, so whether it had
// ever been filled in was a thing you found out by looking in an inbox.
//
// TWO GATES, and they are different questions:
//
//   APP ACCESS — has the caregiver done THEIR part? The eight profile sections,
//   their emergency contact, their signature. It is the first thing they see
//   after setting their password and there is nothing else in the app until it
//   is done. It deliberately does NOT include the uploads: the app is where the
//   uploading happens, so gating access on them would lock a caregiver out of
//   the screen they need. Nor does it include anything the office does — that
//   would lock someone out for days over work that is not theirs.
//
//   SHIFT CLEARANCE — is this caregiver cleared to be in a client's home?
//   Georgia requires it, so this is what stands between them and claiming a
//   shift: the required documents accepted, and the office's own checks done.
//
// It is the client enrollment gate's rule pointed at the other side of the
// relationship: gate COMMITTING care, never asking about it, and never the
// paperwork for work already in flight. A caregiver who is mid-shift clocks out
// and files their visit log whatever their checklist says — refusing that would
// lose the record of care that was given and the pay for giving it.
//
// THE OVERRIDE is the client gate's, verbatim in shape: admin-only, a reason is
// required, and the reason plus the state it overrode are frozen onto the row
// it created. An urgent start is a real situation, and a gate with no
// documented way through is one that gets worked around off the record.
//
// Pure functions over plain records — no I/O, no request context.
// ============================================================================

'use strict';

const wp = require('./welcomePacketRepository');

// The one packet status that opens the app. Named rather than inlined so
// "what unlocks the caregiver app" has exactly one place to be read.
const APP_ACCESS_STATUS = 'submitted';

const nameOf = (caregiver) => (caregiver && (caregiver.name || caregiver.email)) || 'This caregiver';

/**
 * May this caregiver use the app yet?
 * → { allowed, status, code, message }
 *
 * A refusal names which of the two states they are in, because "not started"
 * and "half finished" are different sentences to read on a phone: one is an
 * invitation and the other is a resumption.
 */
function appAccessEligibility(packet) {
  const status = (packet && packet.status) || 'not_started';
  if (status === APP_ACCESS_STATUS) {
    return { allowed: true, status, code: null, message: null };
  }
  if (status === 'in_progress') {
    return {
      allowed: false, status, code: 'WELCOME_PACKET_INCOMPLETE',
      message: 'Your welcome packet is saved but not finished. Pick up where you left off to open the app.'
    };
  }
  return {
    allowed: false, status, code: 'WELCOME_PACKET_REQUIRED',
    message: 'Welcome. Complete your welcome packet to open the app.'
  };
}

/**
 * What is still outstanding before this caregiver can be scheduled.
 * → [{ item, title, source, reason }]
 *
 * Split by WHO it is waiting on, because a caregiver staring at a list that
 * mixes "photograph your TB result" with "we have not run your orientation
 * yet" cannot tell which half is theirs to act on.
 */
function outstandingForClearance(checklist) {
  const rows = Array.isArray(checklist) ? checklist : [];
  return rows
    .filter(r => r.required && r.status !== 'complete')
    .map(r => ({
      item: r.item,
      title: r.title,
      source: r.source,
      status: r.status,
      // 'you' and 'us' rather than a role name: this sentence is read by both
      // a caregiver on a phone and an administrator on the scheduling board.
      waitingOn: r.source === 'office' ? 'us' : 'you'
    }));
}

/**
 * May work be assigned to this caregiver right now?
 * → { allowed, code, message, outstanding }
 */
function shiftClearanceEligibility(caregiver, packet, checklist) {
  const access = appAccessEligibility(packet);
  if (!access.allowed) {
    return {
      allowed: false,
      code: 'CAREGIVER_PACKET_INCOMPLETE',
      message: `${nameOf(caregiver)} has not completed their welcome packet, so they cannot be scheduled yet.`,
      outstanding: []
    };
  }
  const outstanding = outstandingForClearance(checklist);
  if (outstanding.length === 0) {
    return { allowed: true, code: null, message: null, outstanding: [] };
  }
  const theirs = outstanding.filter(o => o.waitingOn === 'you').length;
  const ours = outstanding.length - theirs;
  const parts = [];
  if (theirs) parts.push(`${theirs} waiting on them`);
  if (ours) parts.push(`${ours} waiting on the office`);
  return {
    allowed: false,
    code: 'CAREGIVER_NOT_CLEARED',
    message: `${nameOf(caregiver)} is not cleared to work yet — ${parts.join(', ')}. Georgia requires a caregiver to be fully cleared before working in a client's home.`,
    outstanding
  };
}

/**
 * Resolve an override request against the acting user.
 *
 * Two things can go wrong and they are different facts: a non-admin asking to
 * override is a permission answer, an admin asking without a reason is a
 * completeness answer. Collapsing them would leave an admin who simply forgot
 * the reason believing they lack the right.
 */
function resolveClearanceOverride(user, { override, overrideReason } = {}, isAdmin) {
  if (!override) return { applied: false, refusal: null };
  if (!isAdmin) {
    return {
      applied: false,
      refusal: {
        code: 'OVERRIDE_ADMIN_ONLY',
        message: 'Only an administrator can schedule a caregiver who is not cleared to work.'
      }
    };
  }
  const reason = String(overrideReason || '').trim();
  if (!reason) {
    return {
      applied: false,
      refusal: {
        code: 'OVERRIDE_REASON_REQUIRED',
        message: 'Scheduling a caregiver who is not cleared needs a reason. Say why this cannot wait for their clearance.'
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
 * The whole decision in one call, for a route that has the caregiver and the body.
 * → { ok: true, override }  |  { ok: false, status, code, message, ... }
 */
function checkClearanceAllowed(caregiver, packet, checklist, body, user, isAdmin) {
  const eligibility = shiftClearanceEligibility(caregiver, packet, checklist);
  if (eligibility.allowed) return { ok: true, override: null };

  const o = resolveClearanceOverride(user, body || {}, isAdmin);
  if (o.refusal) {
    return {
      ok: false,
      status: o.refusal.code === 'OVERRIDE_ADMIN_ONLY' ? 403 : 400,
      code: o.refusal.code,
      message: o.refusal.message
    };
  }
  if (o.applied) {
    // WHAT was overridden is frozen onto the stamp. Recomputing it on read
    // would erase the override the moment the missing document was accepted,
    // leaving a clean-looking assignment nobody can tell from a cleared one.
    return {
      ok: true,
      override: {
        ...o.stamp,
        code: eligibility.code,
        outstanding: eligibility.outstanding.map(o2 => ({ item: o2.item, title: o2.title, waitingOn: o2.waitingOn }))
      }
    };
  }
  return {
    ok: false, status: 409, code: eligibility.code, message: eligibility.message,
    outstanding: eligibility.outstanding,
    // Named so the board can offer the override rather than leaving an admin
    // to discover from the API that one exists.
    overridable: !!isAdmin
  };
}

/**
 * The caregiver-facing rollup, for the app shell and the admin queue.
 */
function onboardingSummary(caregiver, packet, checklist) {
  const access = appAccessEligibility(packet);
  const clearance = shiftClearanceEligibility(caregiver, packet, checklist);
  const missingProfile = access.allowed ? [] : wp.missingProfileFields((packet || {}).data || {});
  return {
    packetVersion: (packet && packet.version) || wp.PACKET_VERSION,
    packetStatus: access.status,
    appAccess: access.allowed,
    appAccessCode: access.code,
    appAccessMessage: access.message,
    missingProfile,
    cleared: clearance.allowed,
    clearanceCode: clearance.code,
    clearanceMessage: clearance.message,
    outstanding: clearance.outstanding,
    submittedAt: (packet && packet.signed_at) || null
  };
}

module.exports = {
  APP_ACCESS_STATUS,
  appAccessEligibility,
  outstandingForClearance,
  shiftClearanceEligibility,
  resolveClearanceOverride,
  checkClearanceAllowed,
  onboardingSummary
};
