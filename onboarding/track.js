// ============================================================================
// THE ONBOARDING TRACK — Chapter C composed from the catalog, plus the stored
// state of what each party has done
// ============================================================================
// PURE. Nothing here reads a store or a clock it was not handed. The routes
// load the record and pass it in; this decides what the record means.
//
// THE CHECKLIST IS DERIVED, NEVER STORED (the rule #260 set, kept). Change
// the hire's inputs and the checklist recomposes; what somebody already did
// stays in the record because it is a fact.
//
// COLLABORATIVE (owner, 2026-11-08). Every item is a sequence of steps, each
// owned by the new hire or an office role:
//   * she may complete only her own steps;
//   * the office may complete ANY step, hers included, and a step the office
//     completes for her is stamped OFFICE_ON_BEHALF with who did it;
//   * a VERIFY step needs the source checked and the date, and cannot come
//     before the step it verifies;
//   * the office can return her step with a reason, which reopens it.
// ============================================================================

'use strict';

const V = require('./vocabulary');
const C = require('./chapterC');
const { MODULES } = require('./modules');
const VF = require('./versionFlags');
const { carryOver } = require('./legacy260');

const { ACTORS, ACTIONS, FILED_BY } = V;
const DAY_MS = 24 * 60 * 60 * 1000;
const isYmd = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
const ymd = (v) => (isYmd(v) ? v : String(v || '').slice(0, 10));
const daysBetween = (a, b) => Math.floor((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / DAY_MS);

const STATUS = Object.freeze({
  NOT_STARTED: 'NOT_STARTED',
  IN_PROGRESS: 'IN_PROGRESS',
  SUBMITTED: 'SUBMITTED',       // her steps are in; the office's are not
  RETURNED: 'RETURNED',         // the office sent her step back, with a reason
  COMPLETE: 'COMPLETE',
  EXPIRED: 'EXPIRED',           // complete, and its interval has passed
  NOT_APPLICABLE: 'NOT_APPLICABLE'
});

// ---- inputs -----------------------------------------------------------------
const SERVICE_LINES = Object.freeze(['IME', 'PRIVATE_PAY', 'INSURED', 'BEHAVIORAL']);

function normalizeInputs(raw) {
  const r = raw || {};
  const arr = (v) => (Array.isArray(v) ? v.map(String).filter(Boolean) : []);
  const serviceLines = Array.from(new Set(arr(r.serviceLines).filter(s => SERVICE_LINES.includes(s))));
  return {
    chapter: 'C',
    serviceLines,
    credentials: arr(r.credentials),                 // e.g. FNP, PMHNP
    payers: arr(r.payers),                           // insured billing is per payer
    controlledSubstances: r.controlledSubstances === true,
    outsideEmployment: r.outsideEmployment === true,
    residenceUnderPhc: r.residenceUnderPhc === true,
    drives: r.drives === true,
    prescribes: r.prescribes === true,
    telehealth: r.telehealth === true,
    startDate: isYmd(r.startDate) ? r.startDate : null
  };
}

// Lanes are what the Training Library filters modules on. Examinations are the
// EXAMS lane; every other service line is patient care.
function lanesOf(inputs) {
  const lanes = [];
  if (inputs.serviceLines.includes('IME')) lanes.push('EXAMS');
  if (inputs.serviceLines.some(s => s !== 'IME')) lanes.push('CLINICAL');
  return lanes;
}

function matchesWhen(when, inputs) {
  if (!when) return true;
  if (when.serviceLines && !when.serviceLines.some(s => inputs.serviceLines.includes(s))) return false;
  if (when.controlledSubstances === true && !inputs.controlledSubstances) return false;
  if (when.outsideEmployment === true && !inputs.outsideEmployment) return false;
  if (when.residenceUnderPhc === true && !inputs.residenceUnderPhc) return false;
  if (when.drives === true && !inputs.drives) return false;
  if (when.prescribes === true && !inputs.prescribes) return false;
  if (when.telehealth === true && !inputs.telehealth) return false;
  return true;
}

function composeChecklist(inputs) {
  const i = normalizeInputs(inputs);
  return C.ITEMS.filter(it => matchesWhen(it.when, i));
}

const findItem = (id) => C.ITEMS.find(it => it.id === String(id || '')) || null;

// ---- one item's state ------------------------------------------------------
// Stored shape, per item id:
//   { steps: { [index]: { at, byId, byName, filedBy, source?, verifiedOn?, note? } },
//     returned: { at, byName, reason, step } | null,
//     notApplicable: { at, byName, reason } | null,
//     acknowledgments: { [ackId]: { version, at, byName, filedBy } },
//     proofFiles: [...], notes: [...] }

function ackStatus(item, state) {
  if (!item.acknowledges) return null;
  const acks = (state && state.acknowledgments) || {};
  return item.acknowledges.map(id => {
    const doc = C.ACKNOWLEDGMENTS.find(a => a.id === id);
    const got = acks[id] || null;
    const current = !!(got && (doc.version === 'Current' || String(got.version) === String(doc.version)));
    return {
      id, title: doc.title, required: doc.version,
      playbookStates: doc.playbookStates || null,
      signed: got ? got.version : null,
      signedAt: got ? got.at : null,
      filedBy: got ? got.filedBy : null,
      current,
      // "signed 2.0, 2.2 required" — a signature on an older version is shown
      // as exactly that, never as complete.
      stale: !!(got && !current)
    };
  });
}

function itemStatus(item, state, today) {
  const st = state || {};
  if (st.notApplicable) return STATUS.NOT_APPLICABLE;
  const steps = st.steps || {};
  // An acknowledgment item is complete when every document is acknowledged at
  // the required version: its ACKNOWLEDGE step is satisfied by the documents,
  // never recorded on its own, so it cannot read done over a stale version.
  const acks = ackStatus(item, st);
  const acksComplete = acks ? acks.every(a => a.current) : true;
  const done = item.steps.map((s, i) => !!steps[i] || !!(acks && s.action === ACTIONS.ACKNOWLEDGE && acksComplete));

  const allDone = done.every(Boolean) && acksComplete;
  if (allDone) {
    if (item.repeats === 'annually') {
      const lastIdx = item.steps.length - 1;
      const last = steps[lastIdx] && ymd(steps[lastIdx].at);
      if (last && today && daysBetween(last, ymd(today)) > 365) return STATUS.EXPIRED;
    }
    return STATUS.COMPLETE;
  }
  if (st.returned) return STATUS.RETURNED;
  const anyDone = done.some(Boolean) || (acks && acks.some(a => a.signed));
  if (!anyDone) return STATUS.NOT_STARTED;
  const herStepsDone = item.steps.every((s, i) => s.actor !== ACTORS.NEW_HIRE || done[i])
    && (acks ? acksComplete : true);
  const officeLeft = item.steps.some((s, i) => s.actor !== ACTORS.NEW_HIRE && !done[i]);
  if (herStepsDone && officeLeft) return STATUS.SUBMITTED;
  return STATUS.IN_PROGRESS;
}

function nextStep(item, state) {
  const steps = (state && state.steps) || {};
  const acks = ackStatus(item, state);
  const acksComplete = acks ? acks.every(a => a.current) : true;
  const i = item.steps.findIndex((s, idx) => !steps[idx] && !(acks && s.action === ACTIONS.ACKNOWLEDGE && acksComplete));
  return i === -1 ? null : Object.assign({ index: i }, item.steps[i]);
}

// ---- recording a step --------------------------------------------------------
function refuse(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/**
 * Records one step and returns the item's new state. Never mutates.
 *
 * `actor` is { id, name, isOffice }. `body` carries what the step needs:
 *   VERIFY — { source, verifiedOn } (what was checked, and when)
 *   any    — { note }
 */
function recordStep(item, state, stepIndex, actor, body, now) {
  if (!item) throw refuse('ITEM_UNKNOWN', 'No such onboarding item.');
  const idx = Number(stepIndex);
  const step = item.steps[idx];
  if (!Number.isInteger(idx) || !step) throw refuse('STEP_UNKNOWN', 'That item has no such step.');
  const st = JSON.parse(JSON.stringify(state || {}));
  if (st.notApplicable) throw refuse('ITEM_NOT_APPLICABLE', 'This item has been marked not applicable.');
  st.steps = st.steps || {};
  if (st.steps[idx]) throw refuse('STEP_ALREADY_DONE', 'That step is already recorded.');
  if (item.acknowledges && step.action === ACTIONS.ACKNOWLEDGE) {
    throw refuse('ACK_PER_DOCUMENT', 'Acknowledge each document at its version instead.');
  }

  const hers = step.actor === ACTORS.NEW_HIRE;
  if (!actor.isOffice && !hers) {
    // She can never complete an office step, a verification above all: her
    // say-so recorded as a verification would put an unchecked fact behind a
    // readiness determination.
    throw refuse('STEP_NOT_YOURS', 'The office completes this step.');
  }
  if (step.action === ACTIONS.VERIFY) {
    if (idx > 0 && !st.steps[idx - 1]) {
      throw refuse('VERIFY_BEFORE_SUBMISSION', 'There is nothing to verify until the step before it is done.');
    }
    const source = String((body && body.source) || '').trim();
    const verifiedOn = String((body && body.verifiedOn) || '').trim();
    if (!source) throw refuse('VERIFY_SOURCE_REQUIRED', 'Name the source you checked.');
    if (!isYmd(verifiedOn)) throw refuse('VERIFY_DATE_REQUIRED', 'Give the date you checked it.');
  }
  st.steps[idx] = {
    at: now,
    byId: String(actor.id),
    byName: actor.name || null,
    filedBy: hers && actor.isOffice ? FILED_BY.OFFICE_ON_BEHALF : FILED_BY.SELF,
    source: step.action === ACTIONS.VERIFY ? String(body.source).trim().slice(0, 300) : undefined,
    verifiedOn: step.action === ACTIONS.VERIFY ? String(body.verifiedOn).trim() : undefined,
    note: body && body.note ? String(body.note).trim().slice(0, 2000) : undefined
  };
  if (hers) st.returned = null;
  return st;
}

/** The office sends her step back, which reopens it. A reason is required. */
function returnStep(item, state, stepIndex, actor, reason, now) {
  if (!actor || !actor.isOffice) throw refuse('RETURN_OFFICE_ONLY', 'Only the office returns a submission.');
  const why = String(reason || '').trim();
  if (!why) throw refuse('RETURN_REASON_REQUIRED', 'Say why it is being returned, so she knows what to fix.');
  const idx = Number(stepIndex);
  const step = item.steps[idx];
  if (!step || step.actor !== ACTORS.NEW_HIRE) throw refuse('RETURN_NOT_HER_STEP', 'Only her own steps can be returned to her.');
  const st = JSON.parse(JSON.stringify(state || {}));
  st.steps = st.steps || {};
  if (!st.steps[idx]) throw refuse('RETURN_NOTHING_SUBMITTED', 'That step has not been submitted.');
  // Kept, not erased: what she sent and why it came back are both history.
  st.history = (st.history || []).concat([{ type: 'returned', step: idx, was: st.steps[idx], at: now, byName: actor.name, reason: why.slice(0, 1000) }]);
  delete st.steps[idx];
  // Any later step that depended on it (a verification) reopens too.
  item.steps.forEach((s, i) => { if (i > idx && st.steps[i] && s.action === ACTIONS.VERIFY) delete st.steps[i]; });
  st.returned = { at: now, byName: actor.name, reason: why.slice(0, 1000), step: idx };
  return st;
}

/** An acknowledgment of one named document, at the version she signed. */
function recordAcknowledgment(item, state, ackId, version, actor, now) {
  if (!item || !item.acknowledges || !item.acknowledges.includes(ackId)) {
    throw refuse('ACK_UNKNOWN', 'That document is not acknowledged on this item.');
  }
  const v = String(version || '').trim();
  if (!v) throw refuse('ACK_VERSION_REQUIRED', 'Record the version that was signed.');
  const st = JSON.parse(JSON.stringify(state || {}));
  st.acknowledgments = st.acknowledgments || {};
  st.acknowledgments[ackId] = {
    version: v, at: now, byId: String(actor.id), byName: actor.name || null,
    filedBy: actor.isOffice ? FILED_BY.OFFICE_ON_BEHALF : FILED_BY.SELF
  };
  return st;
}

// ---- modules ---------------------------------------------------------------
function moduleApplies(m, inputs) {
  const lanes = lanesOf(inputs);
  if (m.lanes.length && !m.lanes.some(l => lanes.includes(l))) return false;
  if (m.credentials.length && !m.credentials.some(c => inputs.credentials.includes(c))) return false;
  return true;
}

/**
 * A module's state for this learner. A module flagged by a manual reissue is
 * not started by a NEW learner until it is reviewed (Training Library §2.2);
 * a learner who already completed it keeps the completion.
 */
function moduleState(m, progress, flag) {
  const p = progress || {};
  const done = !!(p.completedAt && String(p.version || '1') === String(m.version));
  const underReview = !!(flag && flag.status === VF.STATUS.FLAGGED);
  return {
    id: m.id,
    complete: done,
    completedAt: done ? p.completedAt : null,
    // A version bump re-checks anyone who completed the earlier version.
    recheckForNewVersion: !!(p.completedAt && !done),
    available: !done && !underReview,
    underReview: underReview && !done
  };
}

// ---- phases and determinations ---------------------------------------------
function phaseModules(phaseId, inputs) {
  return MODULES.filter(m => moduleApplies(m, inputs)
    && m.requiredFor.some(r => r.kind === 'phase' && r.target === phaseId));
}

function determinationModules(detId, inputs) {
  return MODULES.filter(m => moduleApplies(m, inputs)
    && m.requiredFor.some(r => r.kind === 'determination' && r.target === detId));
}

/**
 * A service line's readiness. ELIGIBLE IS NOT OPENED: a line opens only when
 * the named readiness owner records the determination (C.8). What is listed
 * as outstanding is what the app can see; the C.8 conditions themselves are
 * confirmed by that owner at signing, one by one.
 */
function determinationStatus(det, inputs, record, flags) {
  const opened = (record.determinations || {})[det.id] || null;
  const modules = determinationModules(det.id, inputs);
  const included = (det.includes || []).flatMap(id => determinationModules(id, inputs));
  const all = Array.from(new Map([...modules, ...included].map(m => [m.id, m])).values());
  const outstandingModules = all.filter(m => !moduleState(m, (record.training || {})[m.id], flags[m.id]).complete)
    .map(m => m.id);
  return {
    id: det.id, title: det.title, label: det.label, serviceLine: det.serviceLine,
    serviceLineLabel: (C.SERVICE_LINES.find(l => l.id === det.serviceLine) || {}).label || null, ref: det.ref,
    conditions: det.conditions, perPayer: !!det.perPayer,
    openItem: det.openItem || null,
    requiredModules: all.map(m => m.id),
    outstandingModules,
    eligible: outstandingModules.length === 0,
    opened: opened ? Object.assign({}, opened) : null
  };
}

/** The owner's written determination. Refused while modules are outstanding. */
function openDetermination(detId, inputs, record, body, actor, flags, now) {
  if (!actor || !actor.isOffice) throw refuse('DETERMINATION_OFFICE_ONLY', 'A readiness determination is recorded by its named owner.');
  const det = C.DETERMINATIONS.find(d => d.id === detId);
  if (!det) throw refuse('DETERMINATION_UNKNOWN', 'No such service line.');
  const i = normalizeInputs(inputs);
  if (!i.serviceLines.includes(detId)) throw refuse('DETERMINATION_NOT_IN_SCOPE', 'This service line is not in her scope.');
  const status = determinationStatus(det, i, record, flags || {});
  if (!status.eligible) {
    const e = refuse('DETERMINATION_NOT_READY', 'Training required for this service line is not complete.');
    e.outstanding = status.outstandingModules;
    throw e;
  }
  const b = body || {};
  const confirmed = Array.isArray(b.conditionsConfirmed) ? b.conditionsConfirmed.map(String) : [];
  const missing = det.conditions.filter(c => !confirmed.includes(c));
  if (missing.length) {
    const e = refuse('DETERMINATION_CONDITIONS', 'Every condition is confirmed before the line opens.');
    e.missing = missing;
    throw e;
  }
  const scope = String(b.approvedScope || '').trim();
  if (!scope) throw refuse('DETERMINATION_SCOPE_REQUIRED', 'State the approved scope.');
  if (det.perPayer && !String(b.payer || '').trim()) throw refuse('DETERMINATION_PAYER_REQUIRED', 'Insured billing opens payer by payer. Name the payer.');
  return {
    at: now,
    reviewedBy: { id: String(actor.id), name: actor.name || null },
    conditionsConfirmed: confirmed,
    approvedScope: scope.slice(0, 2000),
    payer: det.perPayer ? String(b.payer).trim() : null,
    // Frozen onto the record, never recomputed: a later change must not
    // rewrite a past decision.
    modulesComplete: status.requiredModules.slice()
  };
}

// ---- the whole picture ------------------------------------------------------
/**
 * `audience` is 'office' or 'new_hire'. The office sees who acts on each step
 * and whether the Playbook stated that actor or we inferred it, and every
 * module's version flag. Her view leaves the internal basis out.
 */
// `legacy` is { items, titles }: a #260 record's item states and the old
// titles. Shown as evidence on the matching item; it never completes one.
function buildTrack({ inputs, record, today, audience = 'new_hire', manualVersion, moduleReviews, legacy } = {}) {
  const i = normalizeInputs(inputs);
  const rec = record || {};
  const carried = carryOver(legacy && legacy.items, legacy && legacy.titles);
  const flags = Object.fromEntries(VF.evaluateAll(MODULES, {
    currentVersion: manualVersion || '2.2', reviews: moduleReviews || {}
  }).map(f => [f.moduleId, f]));
  const office = audience === 'office';

  const items = composeChecklist(i).map(it => {
    const st = (rec.items || {})[it.id] || null;
    const ns = nextStep(it, st);
    const status = itemStatus(it, st, today);
    return {
      id: it.id, phase: it.phase, title: it.title, ref: it.ref,
      status,
      classifications: it.classifications.map(c => ({ phrase: c.phrase, row: c.row, from: c.from, legal: V.isLegalRequirement(c) })),
      classificationNote: it.classificationNote || null,
      steps: it.steps.map((s, idx) => {
        const done = st && st.steps && st.steps[idx];
        const out = {
          index: idx, actor: s.actor, actorLabel: V.ACTOR_LABELS[s.actor], action: s.action,
          hers: s.actor === ACTORS.NEW_HIRE,
          done: !!done,
          at: done ? done.at : null,
          byName: done ? done.byName : null,
          filedBy: done ? done.filedBy : null,
          source: done && done.source ? done.source : null,
          verifiedOn: done && done.verifiedOn ? done.verifiedOn : null
        };
        if (office) out.actorBasis = s.actorBasis;
        return out;
      }),
      next: ns ? { index: ns.index, actor: ns.actor, actorLabel: V.ACTOR_LABELS[ns.actor], hers: ns.actor === ACTORS.NEW_HIRE } : null,
      waitingOnHer: !!(ns && ns.actor === ACTORS.NEW_HIRE && status !== STATUS.COMPLETE && status !== STATUS.NOT_APPLICABLE),
      returned: st && st.returned ? st.returned : null,
      acknowledgments: ackStatus(it, st),
      elements: it.elements
        ? it.elements.filter(e => typeof e === 'string' || matchesWhen(e.when, i)).map(e => (typeof e === 'string' ? { row: e } : { row: e.row, ref: e.ref }))
        : null,
      separateRecord: it.separateRecord || null,
      repeats: it.repeats || null,
      notApplicable: st && st.notApplicable ? st.notApplicable : null,
      carriedOver: carried.byItem[it.id] || []
    };
  });

  const modules = MODULES.filter(m => moduleApplies(m, i)).map(m => {
    const s = moduleState(m, (rec.training || {})[m.id], flags[m.id]);
    const out = {
      id: m.id, title: m.title, phase: m.phase, stage: m.stage, format: m.format,
      minutes: m.minutes, host: m.host, signoff: m.signoff,
      requiredFor: m.requiredFor, sopRefs: m.sopRefs, manualRefs: m.manualRefs,
      unlocksAfter: m.unlocksAfter, ref: m.libraryRef,
      carriedOver: carried.byModule[m.id] || [],
      ...s
    };
    if (office) {
      out.versionFlag = flags[m.id];
      out.proposedManualRefs = m.proposedManualRefs;
      out.proposedBasis = m.proposedBasis;
      out.plannedSop = m.plannedSop;
    }
    return out;
  });

  const phases = C.PHASES.map(p => {
    const its = items.filter(x => x.phase === p.id);
    const mods = phaseModules(p.id, i).map(m => m.id);
    const modsOpen = mods.filter(id => !(modules.find(x => x.id === id) || {}).complete);
    const itemsOpen = its.filter(x => x.status !== STATUS.COMPLETE && x.status !== STATUS.NOT_APPLICABLE).map(x => x.id);
    return {
      id: p.id, number: p.number, label: p.label, plainWhen: p.plainWhen,
      title: p.title, when: p.when, ref: p.ref, separateRecord: p.separateRecord || null,
      items: its.map(x => x.id), requiredModules: mods,
      outstandingItems: itemsOpen, outstandingModules: modsOpen,
      complete: itemsOpen.length === 0 && modsOpen.length === 0 && (its.length > 0 || mods.length > 0)
    };
  });

  const determinations = C.DETERMINATIONS.filter(d => i.serviceLines.includes(d.id))
    .map(d => determinationStatus(d, i, rec, flags));

  const out = {
    chapter: C.CHAPTER, inputs: i, lanes: lanesOf(i),
    phases, items, modules, determinations,
    recurring: C.RECURRING.filter(r => matchesWhen(r.when, i)).map(r => ({
      id: r.id, interval: r.interval, requirement: r.requirement,
      classification: { phrase: r.classification.phrase, legal: V.isLegalRequirement(r.classification) },
      ownerLabels: r.owner.map(o => V.ACTOR_LABELS[o])
    })),
    counts: {
      items: items.length,
      complete: items.filter(x => x.status === STATUS.COMPLETE || x.status === STATUS.NOT_APPLICABLE).length,
      waitingOnHer: items.filter(x => x.waitingOnHer).length,
      returned: items.filter(x => x.status === STATUS.RETURNED).length
    }
  };
  if (office) {
    out.moduleFlags = {
      flagged: Object.values(flags).filter(f => f.status === VF.STATUS.FLAGGED).map(f => f.moduleId),
      pending: Object.values(flags).filter(f => f.status === VF.STATUS.PENDING).map(f => f.moduleId)
    };
    out.legacyUnmapped = carried.unmapped;
  }
  return out;
}

module.exports = {
  STATUS, SERVICE_LINES, normalizeInputs, lanesOf, composeChecklist, findItem,
  itemStatus, nextStep, recordStep, returnStep, recordAcknowledgment,
  moduleApplies, moduleState, determinationStatus, openDetermination, buildTrack
};
