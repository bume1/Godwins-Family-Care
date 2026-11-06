// ============================================================================
// THE TRACK: inputs -> checklist -> gates
// Part 1 of GFC_Clinical_Onboarding_Playbook_v1.md, as code.
// ============================================================================
// This is the one entry point. It re-exports the vocabulary (clinicianOnboarding.js)
// and the item library (clinicianItems.js) so a caller requires one module.
//
// NOTHING HERE IS STORED. A person's record holds their four inputs and the
// state of individual items; the checklist and every gate are recomputed on each
// read. That is the playbook's own rule and it is what makes ticking a lane
// correct rather than a migration.
//
// ELIGIBLE IS NOT OPENED, and the difference is the audit trail. A gate becomes
// ELIGIBLE when its requirements are met. It is OPENED when a person records the
// opening, which stores who signed it, what had cleared and the approved scope.
// The playbook calls that record the credentialing committee decision, so the app
// must not quietly treat "requirements met" as "approved to work" — a human
// signs the gate open, and what unlocks the workspace is the signature.
// ============================================================================

'use strict';

const O = require('./clinicianOnboarding');
const { ITEM_LIBRARY, BLOCK_ORDER, BLOCK_TITLES } = require('./clinicianItems');

const DAY_MS = 24 * 60 * 60 * 1000;
const arr = (v) => (Array.isArray(v) ? v.filter(x => x !== null && x !== undefined && x !== '') : []);
const uniq = (v) => Array.from(new Set(v));
const isYmd = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));

// ---- INPUTS ---------------------------------------------------------------
/**
 * Read a stored record's inputs back into a clean shape, dropping anything the
 * vocabulary does not declare. An unknown value is DROPPED rather than kept:
 * a role nobody has defined would otherwise silently generate no items while
 * looking like a configured track.
 *
 * `field` and `driving` narrow two CLIN items. They default from the lanes
 * (anyone with a lane enters homes or clinics; a clinical lane means driving to
 * patients) and can be set explicitly, because an exams-only clinician who
 * never drives should not be chased for auto insurance.
 */
function normalizeInputs(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const roles = uniq(arr(r.roles).map(String).filter(v => O.ALL_ROLES.includes(v)));
  const relationship = O.ALL_RELATIONSHIPS.includes(String(r.relationship || ''))
    ? String(r.relationship) : null;
  // Lanes are NPs only (playbook 1.1). A physician has no lane, so lanes set on
  // a physician-only record are dropped rather than generating lane items.
  const isNp = roles.includes(O.ROLES.NP);
  const lanes = isNp
    ? uniq(arr(r.lanes).map(String).filter(v => O.ALL_LANES.includes(v)))
    : [];
  const addons = uniq(arr(r.addons).map(String).filter(v => O.ALL_ADDONS.includes(v)));
  const reservedRoles = uniq(arr(r.roles).map(String).filter(v => O.RESERVED_ROLES.includes(v)));
  return {
    roles, relationship, lanes, addons, reservedRoles,
    // The contractor is a FIELD, never a name in the item library (playbook 2.9).
    contractors: uniq(arr(r.contractors).map(v => String(v).trim()).filter(Boolean)),
    payers: arr(r.payers).map(p => ({
      id: String((p && p.id) || '').trim(),
      name: String((p && p.name) || '').trim()
    })).filter(p => p.id && p.name),
    field: typeof r.field === 'boolean' ? r.field : lanes.length > 0,
    driving: typeof r.driving === 'boolean' ? r.driving : lanes.includes(O.LANES.CLINICAL),
    supervisorUserId: r.supervisorUserId ? String(r.supervisorUserId) : null
  };
}

/** Which family this person's roles put them in, and so which gates exist. */
function familyOf(inputs) {
  const i = normalizeInputs(inputs);
  for (const role of i.roles) {
    const fam = O.FAMILY_OF_ROLE[role];
    if (fam) return fam;
  }
  return null;
}

/**
 * Is there a track to build at all?
 *
 * A role with no block yet (RN, LMSW, a coordinator) reads "Track not yet
 * defined" and the wizard does not error — the playbook names this case
 * explicitly, because half the org chart is in it today.
 */
function trackDefined(inputs) {
  const i = normalizeInputs(inputs);
  if (!i.roles.length) {
    return { defined: false, reason: i.reservedRoles.length ? 'role_reserved' : 'no_role',
      message: i.reservedRoles.length
        ? 'Track not yet defined for this role.'
        : 'No clinical role set yet.' };
  }
  if (!i.relationship) {
    return { defined: false, reason: 'no_relationship',
      message: 'Set whether they are an employee, a contractor, or both.' };
  }
  return { defined: true, reason: null, message: null };
}

// ---- COMPOSITION (playbook 1.2) -------------------------------------------
/**
 * Does this item apply to this person?
 *
 * Every key narrows, and an absent key does not. `addonsAll: true` means EVERY
 * listed add-on must be present rather than any of them, which is what the two
 * genuinely compound items need (controlled prescribing BY telehealth; an
 * Alabama controlled certificate).
 */
function itemApplies(item, inputs) {
  const w = item.when || {};
  const i = normalizeInputs(inputs);
  if (w.roles && !w.roles.some(r => i.roles.includes(r))) return false;
  if (w.relationship && !w.relationship.includes(i.relationship)) return false;
  if (w.lanes && !w.lanes.some(l => i.lanes.includes(l))) return false;
  if (w.addons) {
    const hit = w.addonsAll
      ? w.addons.every(a => i.addons.includes(a))
      : w.addons.some(a => i.addons.includes(a));
    if (!hit) return false;
  }
  if (w.field === true && !i.field) return false;
  if (w.driving === true && !i.driving) return false;
  return true;
}

/**
 * The checklist: the union of every applicable block, each item once, in the
 * playbook's own composition order. An item named by two blocks appears once —
 * a hybrid NP gets one licence verification, not two.
 */
function composeChecklist(inputs) {
  const i = normalizeInputs(inputs);
  if (!trackDefined(i).defined) return [];
  const fam = familyOf(i);
  if (fam !== O.FAMILIES.LICENSED_CLINICAL) return [];
  const seen = new Set();
  const out = [];
  for (const item of ITEM_LIBRARY) {
    if (seen.has(item.id)) continue;
    if (!itemApplies(item, i)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out.sort((a, b) => {
    const ba = BLOCK_ORDER.indexOf(a.block), bb = BLOCK_ORDER.indexOf(b.block);
    if (ba !== bb) return ba - bb;
    return a.id.localeCompare(b.id, 'en');
  });
}

const findItem = (id) => ITEM_LIBRARY.find(it => it.id === String(id || '')) || null;

// ---- ITEM STATE -----------------------------------------------------------
const ITEM_STATUSES = Object.freeze({
  NOT_STARTED: 'not_started',
  WAITING: 'waiting',        // a prerequisite item is not done, so this cannot start
  IN_PROGRESS: 'in_progress',
  SUBMITTED: 'submitted',    // their part is done, the office has still to verify
  COMPLETE: 'complete',
  EXPIRED: 'expired',        // was complete; its cadence has elapsed
  NOT_APPLICABLE: 'not_applicable'
});

const todayYmd = (today) => {
  if (isYmd(today)) return today;
  const d = today instanceof Date ? today : new Date();
  // Georgia's date, never the container's. public/gfc-time.js owns the clock
  // rule; this is the same answer for a date-only comparison.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(d);
};

const daysBetween = (fromYmd, toYmd) =>
  Math.floor((Date.parse(`${toYmd}T12:00:00Z`) - Date.parse(`${fromYmd}T12:00:00Z`)) / DAY_MS);

const ymdOf = (iso) => (isYmd(iso) ? iso : String(iso || '').slice(0, 10));

/**
 * When does this item come round again?
 *
 * null means a PERSON decides, never a clock. "On change" and "on revision" are
 * events: inventing a 365-day timer for them would chase paperwork nobody owes,
 * and the reminder that cries wolf is the one people stop reading.
 */
function dueAgain(item, state) {
  const cad = O.CADENCES[item.repeats] || null;
  if (!cad) return null;
  if (cad.usesExpiry) return ymdOf((state && state.expiresAt) || '') || null;
  if (!cad.days) return null;
  const from = ymdOf((state && (state.verifiedAt || state.completedAt || state.at)) || '');
  if (!isYmd(from)) return null;
  const d = new Date(Date.parse(`${from}T12:00:00Z`) + cad.days * DAY_MS);
  return d.toISOString().slice(0, 10);
}

/**
 * The status of one item, derived from its stored state plus the clock.
 *
 * An item whose prerequisite is not done reads WAITING rather than NOT_STARTED,
 * because "you cannot start this yet" and "you have not started this" are
 * different sentences and only one of them is a task.
 */
function itemStatus(item, record, today) {
  const states = (record && record.items) || {};
  const st = states[item.id] || null;
  const now = todayYmd(today);

  // A prerequisite named by another item's `starts`.
  const prereq = ITEM_LIBRARY.filter(o => (o.starts || []).includes(item.id));
  const prereqOpen = prereq.filter(p => {
    const ps = states[p.id];
    return !(ps && ps.status === 'complete');
  });

  if (!st || st.status === 'not_started' || !st.status) {
    const waiting = prereqOpen.length > 0;
    return {
      status: waiting ? ITEM_STATUSES.WAITING : ITEM_STATUSES.NOT_STARTED,
      waitingOn: waiting ? null : item.owner,
      blockedByItems: prereqOpen.map(p => p.id),
      dueAt: null, overdue: false, record: st
    };
  }
  if (st.status === 'not_applicable') {
    return { status: ITEM_STATUSES.NOT_APPLICABLE, waitingOn: null,
      blockedByItems: [], dueAt: null, overdue: false, record: st };
  }
  if (st.status === 'complete') {
    const dueAt = dueAgain(item, st);
    const overdue = !!(dueAt && daysBetween(dueAt, now) > 0);
    return {
      status: overdue ? ITEM_STATUSES.EXPIRED : ITEM_STATUSES.COMPLETE,
      waitingOn: overdue ? item.owner : null,
      blockedByItems: [], dueAt, overdue, record: st
    };
  }
  if (st.status === 'submitted') {
    // Their part is in. Anything needing a primary-source check is now the
    // office's, whoever uploaded the proof.
    return { status: ITEM_STATUSES.SUBMITTED, waitingOn: O.OWNERS.GFC,
      blockedByItems: [], dueAt: null, overdue: false, record: st };
  }
  return { status: ITEM_STATUSES.IN_PROGRESS, waitingOn: item.owner,
    blockedByItems: [], dueAt: null, overdue: false, record: st };
}

const DONE_STATUSES = Object.freeze([ITEM_STATUSES.COMPLETE, ITEM_STATUSES.NOT_APPLICABLE]);

// ---- GATES (playbook 1.5) -------------------------------------------------
/**
 * Every gate for this person, with what is still outstanding on each.
 *
 * A gate's ITEM requirements are not written here: they are every applicable
 * item whose `gates` names it. One list, so the gate and the checklist cannot
 * drift. `supervisor` is the physician's own evaluated track, because G2 depends
 * on a DIFFERENT PERSON's G-MD — the one cross-person gate in the app.
 */
/**
 * Does this gate exist for this person at all?
 *
 * Without this, a gate with no applicable items reads "every requirement met"
 * and comes back eligible on an empty list — an NP was briefly shown the
 * physician's own G-MD as eligible with nothing behind it. A gate the inputs do
 * not call for is absent rather than open, which is also what keeps a future
 * executive assistant from ever seeing a Board or protocol gate.
 */
function gateApplies(gid, inputs) {
  const g = O.GATES[gid];
  if (!g) return false;
  const w = g.appliesWhen || {};
  if (w.never) return false;
  const i = normalizeInputs(inputs);
  if (w.roles && !w.roles.some(r => i.roles.includes(r))) return false;
  if (w.lanes && !w.lanes.some(l => i.lanes.includes(l))) return false;
  if (w.addons && !w.addons.some(a => i.addons.includes(a))) return false;
  return true;
}

function gateStatus({ inputs, record, supervisor, today } = {}) {
  const i = normalizeInputs(inputs);
  const fam = familyOf(i);
  const allowed = (O.GATES_BY_FAMILY[fam] || []).filter(gid => gateApplies(gid, i));
  const checklist = composeChecklist(i);
  const events = (record && record.gates) || {};
  const out = {};

  const statusOf = {};
  checklist.forEach(it => { statusOf[it.id] = itemStatus(it, record, today); });

  // First pass: which gates have their items met, ignoring gate prerequisites.
  const itemsMet = {};
  const blockers = {};
  for (const gid of allowed) {
    const needed = checklist.filter(it => (it.gates || []).includes(gid));
    const open = needed.filter(it => !DONE_STATUSES.includes(statusOf[it.id].status));
    itemsMet[gid] = open.length === 0;
    blockers[gid] = open.map(it => ({
      id: it.id, title: it.title, block: it.block,
      status: statusOf[it.id].status,
      waitingOn: statusOf[it.id].waitingOn,
      ownerRole: it.ownerRole || null
    }));
  }

  // Second pass: fold in gate prerequisites and the supervisor's parent gate.
  for (const gid of allowed) {
    const g = O.GATES[gid];
    const prereqGates = (g.requiresGates || []).filter(p => allowed.includes(p));
    const prereqUnmet = prereqGates.filter(p => !(itemsMet[p] && !gateBlockedBySupervisor(p)));

    let supervisorBlock = null;
    if (g.requiresSupervisorGate) {
      const need = g.requiresSupervisorGate;
      const supOpen = !!(supervisor && supervisor.gates && supervisor.gates[need]
        && supervisor.gates[need].opened);
      if (!supOpen) {
        supervisorBlock = {
          gate: need,
          name: (supervisor && supervisor.name) || null,
          reason: supervisor
            ? `${(supervisor.name || 'The supervising physician')} is not signed off yet.`
            : 'No supervising physician is linked to this clinician yet.'
        };
      }
    }

    const ev = events[gid] || null;
    const eligible = itemsMet[gid] && prereqUnmet.length === 0 && !supervisorBlock;
    out[gid] = {
      id: gid, label: g.label, title: g.title, opens: g.opens,
      reserved: !!g.reserved, parentGate: !!g.parentGate, perPayer: !!g.perPayer,
      eligible,
      // OPENED, not eligible, is what unlocks work. A human signs it.
      opened: !!(ev && ev.openedAt),
      openedAt: ev ? ev.openedAt : null,
      openedBy: ev ? (ev.openedByName || null) : null,
      scope: ev ? (ev.scope || null) : null,
      blockedBy: blockers[gid] || [],
      blockedByGates: prereqUnmet,
      waitingOnSupervisor: supervisorBlock
    };
  }

  function gateBlockedBySupervisor(gid) {
    const g = O.GATES[gid];
    if (!g || !g.requiresSupervisorGate) return false;
    return !(supervisor && supervisor.gates && supervisor.gates[g.requiresSupervisorGate]
      && supervisor.gates[g.requiresSupervisorGate].opened);
  }

  return out;
}

/**
 * G5 is one gate per payer (playbook 1.5), so it is evaluated per payer rather
 * than once. She can be billing Medicare while a commercial plan is still
 * pending, which is the normal case and the reason the gate is split at all.
 */
function payerGates({ inputs, record, supervisor, today } = {}) {
  const i = normalizeInputs(inputs);
  if (!i.addons.includes(O.ADDONS.INSURED_BILLING)) return [];
  const gates = gateStatus({ inputs: i, record, supervisor, today });
  const g2Open = !!(gates.G2 && gates.G2.opened);
  const events = (record && record.payerGates) || {};
  const checklist = composeChecklist(i);
  const statusOf = {};
  checklist.forEach(it => { statusOf[it.id] = itemStatus(it, record, today); });

  return i.payers.map(p => {
    // Medicare carries the 855I and the opt-out check; every other payer
    // carries its own in-network confirmation. INS-01 (CAQH) is shared.
    const needed = checklist.filter(it => {
      if (!(it.gates || []).includes('G5')) return false;
      if (it.payer && it.payer !== p.id) return false;
      return true;
    });
    const perPayerState = ((record && record.payerItems) || {})[p.id] || {};
    const open = needed.filter(it => {
      if (it.perPayer) {
        const st = perPayerState[it.id];
        return !(st && st.status === 'complete');
      }
      return !DONE_STATUSES.includes(statusOf[it.id].status);
    });
    const ev = events[p.id] || null;
    return {
      payerId: p.id, payerName: p.name,
      eligible: g2Open && open.length === 0,
      opened: !!(ev && ev.openedAt),
      openedAt: ev ? ev.openedAt : null,
      openedBy: ev ? (ev.openedByName || null) : null,
      blockedByGates: g2Open ? [] : ['G2'],
      blockedBy: open.map(it => ({ id: it.id, title: it.title, status: 'not_started' }))
    };
  });
}

// ---- THE WHOLE PICTURE ----------------------------------------------------
/**
 * One answer for a screen: the checklist grouped by block, each item's status
 * and who it is waiting on, every gate, and the counts.
 *
 * Every row says WHO it is waiting on, and "you" only when the viewer can
 * actually act — the rule the scheduling dashboard set and the clinical inbox
 * follows: a count that does not name its owner is a number nobody can act on.
 */
function buildTrack({ inputs, record, supervisor, today, viewer } = {}) {
  const i = normalizeInputs(inputs);
  const defined = trackDefined(i);
  const checklist = composeChecklist(i);
  const gates = gateStatus({ inputs: i, record, supervisor, today });
  const viewerIsSubject = !!(viewer && record && viewer.id && record.userId
    && String(viewer.id) === String(record.userId));

  const rows = checklist.map(it => {
    const st = itemStatus(it, record, today);
    return {
      id: it.id, block: it.block, blockTitle: BLOCK_TITLES[it.block] || it.block,
      title: it.title, detail: it.detail || null,
      owner: it.owner, ownerLabel: O.OWNER_LABELS[it.owner] || it.owner,
      ownerRole: it.ownerRole || null,
      ownerRoleLabel: it.ownerRole ? O.OWNER_ROLE_LABELS[it.ownerRole] : null,
      action: it.action, proof: it.proof || null,
      verify: it.verify ? (O.VERIFY_SOURCES[it.verify] || null) : null,
      alsoVerify: (it.alsoVerify || []).map(v => O.VERIFY_SOURCES[v]).filter(Boolean),
      resources: it.resources || [], module: it.module || null,
      gates: it.gates || [], repeats: it.repeats,
      repeatsLabel: (O.CADENCES[it.repeats] || {}).label || it.repeats,
      privileging: !!it.privileging, focusedReview: !!it.focusedReview,
      countersign: it.countersign || null,
      status: st.status, dueAt: st.dueAt, overdue: st.overdue,
      blockedByItems: st.blockedByItems,
      waitingOn: st.waitingOn,
      // "You" only when the viewer is the person who owes it.
      waitingOnYou: st.waitingOn === O.OWNERS.CLINICIAN && viewerIsSubject,
      completedAt: st.record ? (st.record.completedAt || st.record.at || null) : null,
      completedBy: st.record ? (st.record.byName || null) : null,
      verifiedAt: st.record ? (st.record.verifiedAt || null) : null,
      verifiedBy: st.record ? (st.record.verifiedByName || null) : null,
      note: st.record ? (st.record.note || null) : null,
      proofFiles: st.record ? ((st.record.proofFiles || []).map(f => ({
        id: f.id, name: f.name, uploadedAt: f.uploadedAt
      }))) : []
    };
  });

  const mine = rows.filter(r => r.waitingOn === O.OWNERS.CLINICIAN
    && !DONE_STATUSES.includes(r.status));
  const ours = rows.filter(r => (r.waitingOn === O.OWNERS.GFC || r.waitingOn === O.OWNERS.SELF_PACED)
    && !DONE_STATUSES.includes(r.status));
  const outside = rows.filter(r => r.waitingOn === O.OWNERS.OUTSIDE
    && !DONE_STATUSES.includes(r.status));
  const done = rows.filter(r => DONE_STATUSES.includes(r.status));

  return {
    inputs: i, defined,
    family: familyOf(i),
    rows, gates,
    payerGates: payerGates({ inputs: i, record, supervisor, today }),
    counts: {
      total: rows.length, done: done.length,
      waitingOnClinician: mine.length, waitingOnGfc: ours.length,
      waitingOnOutside: outside.length,
      expired: rows.filter(r => r.status === ITEM_STATUSES.EXPIRED).length
    },
    blockTitles: BLOCK_TITLES
  };
}

/**
 * What is due again, and when. Generated once the first gate opens (playbook
 * 3.3) — before that nothing is "overdue", because she has not started.
 */
function ongoingSchedule({ inputs, record, today } = {}) {
  const i = normalizeInputs(inputs);
  const gates = gateStatus({ inputs: i, record, today });
  const anyOpen = Object.values(gates).some(g => g.opened);
  if (!anyOpen) return { active: false, items: [] };
  const now = todayYmd(today);
  const items = composeChecklist(i).map(it => {
    const st = itemStatus(it, record, today);
    if (!st.dueAt) return null;
    const days = daysBetween(now, st.dueAt);
    return {
      id: it.id, title: it.title, owner: it.owner,
      ownerRole: it.ownerRole || null,
      repeats: it.repeats, repeatsLabel: (O.CADENCES[it.repeats] || {}).label || it.repeats,
      dueAt: st.dueAt, daysUntilDue: days, overdue: days < 0
    };
  }).filter(Boolean).sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  return { active: true, items };
}

module.exports = Object.assign({}, O, {
  ITEM_LIBRARY, BLOCK_ORDER, BLOCK_TITLES,
  ITEM_STATUSES, DONE_STATUSES,
  normalizeInputs, familyOf, trackDefined,
  itemApplies, gateApplies, composeChecklist, findItem,
  dueAgain, itemStatus, gateStatus, payerGates,
  buildTrack, ongoingSchedule,
  todayYmd, daysBetween
});
