// clinicalResults.js — Session 4.10, Scope C
//
// WHY. Before this session "resulted" was a status label a human clicked. No
// value was stored, there was no inbox, and `acknowledgeAbnormalResult` had
// existed as a capability since Session 4.8 WITH NO ROUTE BEHIND IT — a
// permission nothing could exercise, which is the same class of inert field the
// competency ceiling was.
//
// With results arriving by fax to one person's phone, the two realistic harms
// are an ABNORMAL RESULT NOBODY WITH AUTHORITY EVER SAW, and A RESULT THAT NEVER
// ARRIVED THAT NOBODY NOTICED WAS MISSING. The inbox addresses the first; the
// overdue list (orderRequisitions.js) addresses the second. Neither is a report
// — both are worklists that empty.
//
// STRUCTURED VALUES AND LOINC ARE OUT OF SCOPE. The PDF is the record; the
// INTERPRETATION FLAG drives the routing. That is a deliberate boundary: a
// half-parsed lab value is worse than an unparsed PDF, because somebody trends
// it.

'use strict';

const roles = require('./clinicalRoles');

// ---- The interpretation flag -------------------------------------------
// Three values, because three different things happen. `critical` pages
// somebody; `abnormal` requires a follow-up note saying what is being done;
// `normal` is acknowledged by any provider so the inbox can actually empty.
const INTERPRETATIONS = Object.freeze(['normal', 'abnormal', 'critical']);
const INTERPRETATION_LABELS = Object.freeze({
  normal: 'Normal', abnormal: 'Abnormal', critical: 'Critical'
});
// Which interpretations need the ACKNOWLEDGE_ABNORMAL_RESULT capability, and a
// follow-up note with them.
const CLINICAL_JUDGEMENT_INTERPRETATIONS = Object.freeze(['abnormal', 'critical']);
const needsClinicalJudgement = (i) => CLINICAL_JUDGEMENT_INTERPRETATIONS.includes(String(i || ''));

// Where a received document files in the chart, by what it is. NOT Google
// Drive: Drive is not configured, and a record RECEIVED FOR CARE belongs in the
// chart by the document-routing rule in the OpenEMR setup guide.
const CATEGORY_BY_ORDER_TYPE = Object.freeze({
  lab: '/Lab Report',
  imaging: '/Imaging',
  procedure: '/Lab Report',
  referral: '/Consult',
  dme: '/Orders'
});
// An inbound document that matches no order — a hospital discharge summary, a
// result from an outside provider. It is still a received record.
const UNMATCHED_CATEGORY = '/Medical Record';
const categoryFor = (orderType) => CATEGORY_BY_ORDER_TYPE[String(orderType || '')] || UNMATCHED_CATEGORY;

// ---- Escalation and overdue clocks ------------------------------------
// Owner-confirmed. Named constants: the numbers are a clinical policy decision
// and changing one must be a one-line edit, not a hunt through a handler.
const ABNORMAL_ESCALATION_BUSINESS_DAYS = 2;
const CRITICAL_ESCALATION_HOURS = 4;
const HOUR_MS = 3600000;

// BUSINESS days, not calendar days, and that is the whole reason this function
// exists rather than a multiplication. An abnormal result attached on a Friday
// afternoon is not two days old on Sunday: nobody was in the office, and an
// escalation that fires over a weekend teaches people to ignore escalations.
// Saturday and Sunday are skipped. Public holidays are NOT modelled — that
// needs a calendar the app does not have, and treating one holiday as a working
// day errs toward escalating slightly early, which is the safe direction.
const businessDaysBetween = (fromIso, toIso) => {
  const a = new Date(fromIso);
  const b = new Date(toIso);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime()) || b <= a) return 0;
  let count = 0;
  // Walk in whole 24h steps from the attach instant. Each step that lands on a
  // weekday in the PRACTICE zone counts — the server is pinned to Eastern, so
  // getDay() here is Georgia's day.
  const cursor = new Date(a.getTime());
  while (cursor.getTime() + 86400000 <= b.getTime()) {
    cursor.setTime(cursor.getTime() + 86400000);
    const day = cursor.getDay();
    if (day !== 0 && day !== 6) count++;
  }
  return count;
};

const isEscalated = (result, now) => {
  if (!result || result.acknowledgedAt) return false;
  const at = result.receivedAt || result.createdAt;
  if (!at) return false;
  const nowIso = (now && new Date(now).toISOString()) || new Date().toISOString();
  if (result.interpretation === 'critical') {
    return (new Date(nowIso).getTime() - new Date(at).getTime()) >= CRITICAL_ESCALATION_HOURS * HOUR_MS;
  }
  if (result.interpretation === 'abnormal') {
    return businessDaysBetween(at, nowIso) >= ABNORMAL_ESCALATION_BUSINESS_DAYS;
  }
  // A normal result is not escalated to admin. It waits to be acknowledged; it
  // is not an emergency that nobody looked at it yet.
  return false;
};

// ---- Building a result row ---------------------------------------------
const clean = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const isYmd = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !Number.isNaN(new Date(`${v}T12:00:00Z`).getTime());

// WHO THIS RESULT IS FOR. Under a standing order the ordering clinician of
// record is the AUTHORIZING PROVIDER, not the nurse who executed it — Session
// 4.8 already files the order that way, so this reads the order's own
// orderingClinician rather than re-deriving the rule. Re-deriving it is how the
// inbox would start routing a critical result to a nurse who cannot act on it.
const routeToFor = (order) => {
  const oc = (order && order.orderingClinician) || {};
  return {
    userId: oc.id || null,
    name: oc.name || null,
    npi: oc.npi || null,
    // Named so a reader of the row can see WHY it went where it went without
    // opening the order.
    via: order && order.authority === 'standing_order' ? 'authorizing_provider' : 'ordering_clinician',
    standingOrderId: (order && order.standingOrder && order.standingOrder.id) || null
  };
};

const buildResult = ({ id, clientId, puuid, order, input, actor, file, at }) => {
  const i = input || {};
  const interpretation = INTERPRETATIONS.includes(String(i.interpretation || '')) ? String(i.interpretation) : null;
  if (!interpretation) {
    return { error: `An interpretation is required — one of ${INTERPRETATIONS.join(', ')}. It is what decides who this reaches and how fast.`, code: 'RESULT_NO_INTERPRETATION' };
  }
  const resultDate = isYmd(i.resultDate) ? String(i.resultDate) : null;
  if (!resultDate) return { error: 'A result date (YYYY-MM-DD) is required', code: 'RESULT_NO_DATE' };
  const now = at || new Date().toISOString();
  if (resultDate > now.slice(0, 10)) {
    return { error: 'A result date cannot be in the future', code: 'RESULT_DATE_FUTURE' };
  }
  const performedBy = clean(i.performedBy, 160);
  if (!performedBy) {
    return { error: 'The performing lab or facility is required', code: 'RESULT_NO_PERFORMER' };
  }
  const summary = clean(i.summary, 2000);
  if (!summary) {
    return { error: 'A short summary is required — the PDF is the record, but the summary is what the inbox shows', code: 'RESULT_NO_SUMMARY' };
  }
  if (!file || !file.fileName) {
    return { error: 'The result document is required', code: 'RESULT_NO_FILE' };
  }
  return {
    result: {
      id, clientId, puuid: puuid || null,
      orderId: (order && order.id) || null,
      orderType: (order && order.orderType) || null,
      orderReference: (order && order.orderReference) || null,
      encounterUuid: (order && order.encounterUuid) || null,
      interpretation,
      resultDate,
      performedBy,
      summary,
      // What was received, and where it went in the chart. The bytes are never
      // held here — the chart holds them, and this is the pointer plus the
      // provenance of the receipt.
      document: {
        fileName: clean(file.fileName, 200),
        mimeType: clean(file.mimeType, 80) || 'application/pdf',
        byteLength: Number.isInteger(file.byteLength) ? file.byteLength : null,
        emrCategory: categoryFor(order && order.orderType),
        emrFiled: !!file.emrFiled,
        emrError: file.emrError ? clean(file.emrError, 300) : null
      },
      // How it arrived. `doximity_inbox` is today's answer; the enum is the seam.
      receivedVia: ['doximity_inbox', 'efax', 'portal', 'mail', 'hand'].includes(String(i.receivedVia || ''))
        ? String(i.receivedVia) : 'doximity_inbox',
      receivedAt: now,
      receivedBy: { id: (actor && actor.id) || null, name: (actor && actor.name) || null },
      routeTo: routeToFor(order),
      // Unmatched inbound: attached to the PATIENT with no order. It lands in
      // the same inbox for review rather than in a second place nobody opens.
      unmatched: !order,
      acknowledgedAt: null,
      acknowledgedBy: null,
      followUpNote: null,
      escalatedAt: null,
      createdAt: now,
      updatedAt: now
    }
  };
};

// ---- Acknowledging ----------------------------------------------------
// ANY PROVIDER MAY ACKNOWLEDGE A NORMAL RESULT; abnormal and critical need the
// ACKNOWLEDGE_ABNORMAL_RESULT capability, because those are the ones that carry
// a clinical decision. Gating normal results the same way would leave an inbox
// nobody but a provider can ever empty, and an inbox that does not empty is an
// inbox nobody reads.
const canAcknowledge = (user, interpretation) => {
  if (needsClinicalJudgement(interpretation)) {
    return roles.can(user, roles.CAPABILITIES.ACKNOWLEDGE_ABNORMAL_RESULT);
  }
  // A normal result is acknowledged by anyone licensed to read the chart and
  // write in it — the RN who ordered it under a protocol included.
  return roles.canClinicalWrite(user);
};

const applyAcknowledgement = ({ result, actor, input, at }) => {
  if (!result) return { error: 'Result not found', code: 'RESULT_NOT_FOUND', status: 404 };
  if (result.acknowledgedAt) {
    return {
      error: `This result was already acknowledged ${result.acknowledgedAt} by ${(result.acknowledgedBy && result.acknowledgedBy.name) || 'a clinician'}.`,
      code: 'RESULT_ALREADY_ACKNOWLEDGED', status: 409
    };
  }
  if (!canAcknowledge(actor, result.interpretation)) {
    return {
      error: needsClinicalJudgement(result.interpretation)
        ? `Clinically acknowledging a ${INTERPRETATION_LABELS[result.interpretation].toLowerCase()} result is limited to a provider.`
        : 'Acknowledging a result requires a clinical licence.',
      code: 'CLINICAL_CREDENTIAL', capability: roles.CAPABILITIES.ACKNOWLEDGE_ABNORMAL_RESULT,
      clinicalRole: roles.resolveClinicalRole(actor), status: 403
    };
  }
  const note = clean((input || {}).followUpNote, 4000);
  // A FOLLOW-UP NOTE IS REQUIRED FOR ABNORMAL AND CRITICAL: what are you doing
  // about it. "Acknowledged" on an abnormal result with no plan is a record that
  // somebody saw it, which is not the same as a record that it was handled.
  if (needsClinicalJudgement(result.interpretation) && !note) {
    return {
      error: `A ${INTERPRETATION_LABELS[result.interpretation].toLowerCase()} result needs a follow-up note saying what is being done about it.`,
      code: 'RESULT_NO_FOLLOW_UP', status: 400
    };
  }
  const now = at || new Date().toISOString();
  return {
    result: {
      ...result,
      acknowledgedAt: now,
      acknowledgedBy: {
        id: (actor && actor.id) || null, name: (actor && actor.name) || null,
        clinicalRole: roles.resolveClinicalRole(actor)
      },
      followUpNote: note || null,
      updatedAt: now
    }
  };
};

// ---- The inbox --------------------------------------------------------
// Critical pinned first, then abnormal, then normal; OLDEST FIRST within each,
// because the oldest unanswered result is the one most likely to have been
// forgotten.
const SEVERITY_RANK = Object.freeze({ critical: 0, abnormal: 1, normal: 2 });
const buildInbox = (results, { user, isAdmin, now } = {}) => {
  const rows = (Array.isArray(results) ? results : []).filter(r => r && !r.acknowledgedAt);
  const myId = (user && user.id) || null;
  const visible = rows.filter(r => {
    // An admin sees every unacknowledged result — admin is the escalation
    // target, and a result routed to a clinician who has left has to be
    // reachable by somebody.
    if (isAdmin) return true;
    // An unmatched inbound result is routed to nobody by construction, so it is
    // visible to every clinician: routing it to nobody and showing it to nobody
    // would be a document received and lost.
    if (r.unmatched || !r.routeTo || !r.routeTo.userId) return true;
    if (myId && r.routeTo.userId === myId) return true;
    // Escalated results surface to everyone who can act, not only the person who
    // did not answer them. That is the point of escalating.
    return isEscalated(r, now);
  });
  return visible
    .map(r => ({ ...r, escalated: isEscalated(r, now) }))
    .sort((a, b) =>
      (SEVERITY_RANK[a.interpretation] ?? 9) - (SEVERITY_RANK[b.interpretation] ?? 9) ||
      String(a.receivedAt || a.createdAt).localeCompare(String(b.receivedAt || b.createdAt)));
};

// What admin needs paging about: unacknowledged past the threshold for its
// interpretation.
const buildEscalations = (results, now) => (Array.isArray(results) ? results : [])
  .filter(r => isEscalated(r, now))
  .map(r => ({
    id: r.id, clientId: r.clientId, interpretation: r.interpretation,
    orderReference: r.orderReference || null, orderId: r.orderId || null,
    receivedAt: r.receivedAt || r.createdAt,
    routeTo: r.routeTo || null,
    thresholdDescription: r.interpretation === 'critical'
      ? `${CRITICAL_ESCALATION_HOURS} hours`
      : `${ABNORMAL_ESCALATION_BUSINESS_DAYS} business days`
  }))
  .sort((a, b) => (SEVERITY_RANK[a.interpretation] ?? 9) - (SEVERITY_RANK[b.interpretation] ?? 9) ||
    String(a.receivedAt).localeCompare(String(b.receivedAt)));

// ---- The critical notice ----------------------------------------------
// NON-PHI WORDING, and that is not a style choice. The notice lands in an inbox
// on somebody's phone: it may never carry the value, the patient's name, or what
// the test was. It says a critical result is waiting and where to go.
//
// Returns the template data the notification queue takes. The DESTINATION comes
// from appLinks at the call site — every URL in every notice goes through that
// module, and a literal here would be the fifth place the answer was given.
const buildCriticalNotice = () => ({
  subject: 'A critical result is waiting for your review',
  heading: 'A critical result is waiting',
  body: 'A result marked critical has been filed and is waiting for your review in the clinician workspace. This message deliberately carries no patient or clinical detail.',
  ctaLabel: 'Open the results inbox'
});

// ---- The order side of a received result ------------------------------
// STATUS FOLLOWS EVIDENCE. Attaching a result moves the order to 'resulted' — a
// referral to 'completed', because a referral is finished when the consult note
// comes back, and there is no 'resulted' in a referral's lifecycle.
//
// 'resulted' is removed from the generic status route in the same session, so an
// order can no longer be marked resulted without a result attached. That pairing
// is the control: either half alone leaves a way to claim a result that does not
// exist.
const resultedStatusFor = (order) => (order && order.orderType === 'referral') ? 'completed' : 'resulted';
const applyResultToOrder = ({ order, result, actor, at }) => {
  if (!order) return { error: 'Order not found', code: 'ORDER_NOT_FOUND', status: 404 };
  if (['cancelled'].includes(String(order.status))) {
    return { error: 'A cancelled order cannot receive a result.', code: 'ORDER_CANCELLED', status: 409 };
  }
  const next = resultedStatusFor(order);
  const now = at || new Date().toISOString();
  return {
    order: {
      ...order,
      status: next,
      resultIds: [...(order.resultIds || []), result.id],
      statusHistory: [...(order.statusHistory || []), {
        status: next, at: now, by: { id: (actor && actor.id) || null, name: (actor && actor.name) || null },
        note: `${INTERPRETATION_LABELS[result.interpretation]} result from ${result.performedBy} filed`
      }],
      updatedAt: now
    }
  };
};

module.exports = {
  INTERPRETATIONS, INTERPRETATION_LABELS, CLINICAL_JUDGEMENT_INTERPRETATIONS, needsClinicalJudgement,
  CATEGORY_BY_ORDER_TYPE, UNMATCHED_CATEGORY, categoryFor,
  ABNORMAL_ESCALATION_BUSINESS_DAYS, CRITICAL_ESCALATION_HOURS,
  businessDaysBetween, isEscalated,
  routeToFor, buildResult,
  canAcknowledge, applyAcknowledgement,
  SEVERITY_RANK, buildInbox, buildEscalations,
  buildCriticalNotice,
  resultedStatusFor, applyResultToOrder
};
