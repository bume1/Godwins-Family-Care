// clinicalInbox.js — "what is waiting on a clinician", in one place.
//
// Session 4.8 created four states that nothing on screen ever showed, and
// Session 6 created a fifth. An encounter an LMSW signed sits with its charge
// held; a standing-order execution sits with a co-sign DUE DATE running; an
// IHPC care plan sits pending a provider's signature; a caregiver's skilled
// note sits `pending_review`; and since 2026-09-22 a filed H&P sits documented
// but unsigned, because filing stopped pretending to sign.
//
// A pending state nothing surfaces is a field left inert — the trap this repo
// has paid for with the competency ceiling, the caregiver feed and the two
// missing admin screens. This module is the surface.
//
// TWO RULES SHAPE EVERYTHING HERE:
//
//   1. Every item says WHO it is waiting on. "4 pending" that does not say
//      whether it is waiting on you or on someone else is a number nobody can
//      act on — the rule the scheduling dashboard set on 2026-09-13.
//   2. No credential rule is restated. Whether a viewer may co-sign is asked
//      of `clinicalRoles`, which is the one place that answers it. A second
//      copy of "who may co-sign" is how the inbox starts offering an action
//      the route then refuses.
'use strict';
const clinicalRoles = require('./clinicalRoles');

const KINDS = Object.freeze({
  ENCOUNTER_CO_SIGN: 'encounter_co_sign',
  ORDER_CO_SIGN: 'order_co_sign',
  CARE_PLAN_CO_SIGN: 'care_plan_co_sign',
  VISIT_LOG_REVIEW: 'visit_log_review',
  ENCOUNTER_UNSIGNED: 'encounter_unsigned'
});

const KIND_LABELS = Object.freeze({
  [KINDS.ENCOUNTER_CO_SIGN]: 'Encounter awaiting co-signature',
  [KINDS.ORDER_CO_SIGN]: 'Order awaiting co-signature',
  [KINDS.CARE_PLAN_CO_SIGN]: 'Care plan awaiting provider signature',
  [KINDS.VISIT_LOG_REVIEW]: 'Caregiver note awaiting review',
  [KINDS.ENCOUNTER_UNSIGNED]: 'Encounter documented but not signed'
});

const iso = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

// A due date that has passed is the one thing in here with a deadline of its
// own. Everything else is ordered by age.
const isOverdue = (dueAt, now) => {
  const d = iso(dueAt); if (!d) return false;
  return new Date(d).getTime() < new Date(now).getTime();
};

// Who a viewer is, for the purpose of this list only. Resolved once so every
// item asks the same question of the same answer.
const viewerAbilities = (viewer) => ({
  id: (viewer && viewer.id) || null,
  canCoSignEncounter: clinicalRoles.canCoSignEncounter(viewer),
  canCoSignCarePlan: clinicalRoles.canCoSignCarePlan(viewer),
  canReviewNotes: clinicalRoles.can(viewer, clinicalRoles.CAPABILITIES.NURSING_NOTE),
  canSignBillable: clinicalRoles.can(viewer, clinicalRoles.CAPABILITIES.SIGN_BILLABLE_ENCOUNTER)
});

// A co-signature cannot be self-issued — the route refuses it (CO_SIGN_SELF).
// So the person who signed never sees their own hold as actionable, or the
// inbox offers a button the server will reject.
const notSelf = (v, signerId) => !!v.id && !!signerId && String(v.id) !== String(signerId);

const item = (o) => ({
  kind: o.kind,
  label: KIND_LABELS[o.kind],
  id: String(o.id),
  clientId: o.clientId != null ? String(o.clientId) : null,
  patientName: o.patientName || null,
  encounterUuid: o.encounterUuid || null,
  at: iso(o.at),
  dueAt: iso(o.dueAt) || null,
  overdue: !!o.overdue,
  actionable: !!o.actionable,
  waitingOn: o.waitingOn,
  detail: o.detail || null
});

const buildInbox = ({
  viewer, encounterRecords, attestations, orders, carePlanClients, visitLogs, patientNames, now
} = {}) => {
  const at = iso(now) || new Date().toISOString();
  const v = viewerAbilities(viewer);
  const nameOf = (clientId) => (patientNames && patientNames.get
    ? (patientNames.get(String(clientId)) || null)
    : ((patientNames || {})[String(clientId)] || null));
  const attByUuid = new Map((attestations || []).map(a => [String(a.encounterUuid), a]));
  const items = [];

  // 1. An encounter an LMSW signed: documented and attested, charge HELD until
  //    an LCSW or provider co-signs. The hold is the point — 4.8 chose holding
  //    over posting and reversing.
  for (const r of (encounterRecords || [])) {
    if (!r || r.coSignStatus !== 'pending') continue;
    const att = attByUuid.get(String(r.encounterUuid)) || null;
    const signerId = att && att.signedBy ? att.signedBy.id : null;
    const signerName = att && att.signedBy ? att.signedBy.name : null;
    items.push(item({
      kind: KINDS.ENCOUNTER_CO_SIGN,
      id: r.encounterUuid, clientId: r.clientId, patientName: nameOf(r.clientId),
      encounterUuid: r.encounterUuid,
      at: (att && att.signedAt) || r.updatedAt || r.date,
      actionable: v.canCoSignEncounter && notSelf(v, signerId),
      waitingOn: v.canCoSignEncounter && notSelf(v, signerId) ? 'you' : 'an LCSW or a provider',
      detail: signerName ? `Signed by ${signerName}; the charge is held until it is co-signed.` : 'The charge is held until it is co-signed.'
    }));
  }

  // 2. A standing-order execution. The ONLY item here with a deadline of its
  //    own, so an overdue one sorts to the top.
  for (const o of (orders || [])) {
    const cs = o && o.coSign;
    if (!cs || cs.coSignStatus !== 'pending') continue;
    const executedById = o.executedBy && o.executedBy.id;
    const canAct = v.canCoSignEncounter && notSelf(v, executedById);
    items.push(item({
      kind: KINDS.ORDER_CO_SIGN,
      id: o.id, clientId: o.clientId, patientName: nameOf(o.clientId),
      encounterUuid: o.encounterUuid || null,
      at: o.createdAt || o.at, dueAt: cs.coSignDueAt || null,
      overdue: isOverdue(cs.coSignDueAt, at),
      actionable: canAct,
      waitingOn: canAct ? 'you' : 'the authorizing provider',
      detail: o.executedBy && o.executedBy.name
        ? `Executed by ${o.executedBy.name} under a standing order.`
        : 'Executed under a standing order.'
    }));
  }

  // 3. An IHPC care plan an RN authored. The RN's signature is the AUTHORING
  //    signature; a provider's completes it.
  for (const c of (carePlanClients || [])) {
    const plan = c && c.carePlan;
    if (!plan || plan.providerCoSignStatus !== 'pending') continue;
    const authorId = plan.authoredById || (plan.authoredBy && plan.authoredBy.id) || null;
    const canAct = v.canCoSignCarePlan && notSelf(v, authorId);
    items.push(item({
      kind: KINDS.CARE_PLAN_CO_SIGN,
      id: `${c.id}:v${plan.version || 1}`, clientId: c.id, patientName: c.name || nameOf(c.id),
      at: plan.authoredAt || plan.updatedAt || null,
      actionable: canAct,
      waitingOn: canAct ? 'you' : 'a provider',
      detail: plan.providerCoSignReason || `Version ${plan.version || 1} is authored and waiting on a provider's signature.`
    }));
  }

  // 4. A caregiver's skilled note. Session 6 routes it to a clinician BECAUSE
  //    the work was performed under licensed oversight — so the review has to
  //    actually happen, which means somebody has to be able to see it.
  for (const l of (visitLogs || [])) {
    if (!l || l.status !== 'pending_review') continue;
    items.push(item({
      kind: KINDS.VISIT_LOG_REVIEW,
      id: l.id, clientId: l.clientId, patientName: nameOf(l.clientId),
      at: l.submittedAt || l.at || l.createdAt,
      actionable: v.canReviewNotes,
      waitingOn: v.canReviewNotes ? 'you' : 'a clinician',
      detail: l.caregiverName ? `Submitted by ${l.caregiverName}.` : 'A skilled task was documented.'
    }));
  }

  // 5. Filed but unsigned. New on 2026-09-22: filing an H&P stopped claiming
  //    to sign, so a clinician needs to see what she has left open. Only the
  //    clinician who documented it is told it is hers — an unsigned encounter
  //    is not a queue the whole practice works.
  for (const r of (encounterRecords || [])) {
    if (!r) continue;
    if (r.coSignStatus === 'pending') continue;          // already listed above
    if (attByUuid.has(String(r.encounterUuid))) continue; // signed
    const renderedById = r.renderingProvider && r.renderingProvider.id;
    const isMine = !!v.id && !!renderedById && String(v.id) === String(renderedById);
    items.push(item({
      kind: KINDS.ENCOUNTER_UNSIGNED,
      id: r.encounterUuid, clientId: r.clientId, patientName: nameOf(r.clientId),
      encounterUuid: r.encounterUuid,
      at: r.updatedAt || r.date,
      actionable: isMine && v.canSignBillable,
      waitingOn: isMine ? 'you' : 'the documenting clinician',
      detail: `${(r.diagnoses || []).length} diagnosis code(s), ${(r.services || []).length} service code(s) recorded.`
    }));
  }

  // Overdue first, then oldest first: the thing that has been waiting longest
  // is the thing most likely to have been forgotten.
  items.sort((a, b) => {
    if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
    const ta = a.at ? new Date(a.at).getTime() : 0;
    const tb = b.at ? new Date(b.at).getTime() : 0;
    return ta - tb;
  });

  const counts = { total: items.length, actionable: items.filter(i => i.actionable).length, overdue: items.filter(i => i.overdue).length };
  for (const k of Object.values(KINDS)) counts[k] = items.filter(i => i.kind === k).length;
  return { items, counts };
};

module.exports = { KINDS, KIND_LABELS, buildInbox, viewerAbilities, isOverdue };
