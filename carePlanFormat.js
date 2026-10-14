// ============================================================
// The care plan format (owner-directed, 2026-10-14)
//
// Pure functions only. clinicalRepository.buildCarePlanVersion delegates here.
// Source: docs/decisions/2026-10-14-care-plan-format.md and the owner's
// "GFC Care Plan Format" document.
//
// Eight blocks:
//   1 problems        problemItems       (text, optional chart problem id, prognosis, expected outcome)
//   2 goals           goalItems          (statement, measure, baseline, target, date, priority, status)
//   3 interventions   interventions      (what, for which goals, who, how often, type)
//   4 medications     medicationManagement (who manages them day to day, concerns, pharmacy)
//   5 outside care    outsideCare        (external care team, community services)
//   6 schedule        eachVisit, visitFrequency, visitDays, visitTimes, duration (unchanged)
//   7 escalation      escalation         (when to call GFC, when to call 911, who to call, after hours)
//   8 review          review             (cadence, next review date)
//
// Two things on purpose:
//   - `problems` and `goals` stay as plain string lists, DERIVED from the
//     structured items at build time. Every older reader (the portal, the
//     signed PDF, the pre-visit packet, the patient publish) reads those, and
//     a plan written before this change has nothing else.
//   - A goal's STATUS is updated without writing a new version
//     (applyGoalStatus). A new version needs new signatures; a status change
//     must not send a family back to re-sign.
// ============================================================

const crypto = require('crypto');

const GOAL_STATUSES = Object.freeze(['not_started', 'in_progress', 'met', 'not_met', 'deferred']);
const GOAL_STATUS_LABELS = Object.freeze({
  not_started: 'Not started', in_progress: 'In progress', met: 'Met', not_met: 'Not met', deferred: 'Deferred'
});
const PRIORITIES = Object.freeze(['high', 'medium', 'low']);
const RESPONSIBLE = Object.freeze(['gfc_clinician', 'gfc_caregiver', 'family', 'patient', 'outside_agency']);
const RESPONSIBLE_LABELS = Object.freeze({
  gfc_clinician: 'GFC clinician', gfc_caregiver: 'GFC caregiver', family: 'Family',
  patient: 'Patient', outside_agency: 'Outside agency'
});
const FREQUENCIES = Object.freeze(['daily', 'each_visit', 'weekly', 'as_needed', 'one_time', 'ongoing']);
const FREQUENCY_LABELS = Object.freeze({
  daily: 'Daily', each_visit: 'Each visit', weekly: 'Weekly', as_needed: 'As needed', one_time: 'One time', ongoing: 'Ongoing'
});
const INTERVENTION_TYPES = Object.freeze(['clinical', 'medication', 'caregiver_task', 'education', 'equipment', 'referral']);
const INTERVENTION_TYPE_LABELS = Object.freeze({
  clinical: 'Clinical', medication: 'Medication', caregiver_task: 'Caregiver task',
  education: 'Education', equipment: 'Equipment', referral: 'Referral'
});
const MED_MANAGED_BY = Object.freeze(['patient', 'family', 'caregiver', 'pharmacy_pack', 'clinician']);
const MED_MANAGED_BY_LABELS = Object.freeze({
  patient: 'The patient', family: 'Family', caregiver: 'Caregiver (reminders)',
  pharmacy_pack: 'Pharmacy blister pack', clinician: 'GFC clinician'
});
const SERVICE_STATUSES = Object.freeze(['active', 'pending', 'referred', 'declined', 'ended']);
const REVIEW_CADENCES = Object.freeze(['30_days', '60_days', '90_days', '6_months', '12_months']);
const REVIEW_CADENCE_LABELS = Object.freeze({
  '30_days': 'Every 30 days', '60_days': 'Every 60 days', '90_days': 'Every 90 days',
  '6_months': 'Every 6 months', '12_months': 'Every 12 months'
});

// What a plan must carry before it can be saved, by service line. One table,
// so changing a requirement is a one-line edit. Home care needs the service
// side; a medical patient needs the clinical side as well (the Medicare
// comprehensive care plan elements). BOTH is the union.
const REQUIREMENTS = Object.freeze({
  PHC: Object.freeze(['problems', 'goals', 'eachVisit', 'visitFrequency', 'escalation', 'review']),
  IHPC: Object.freeze(['problems', 'goals', 'problemDetail', 'goalMeasures', 'interventions', 'medicationManagement', 'escalation', 'review']),
  BOTH: Object.freeze(['problems', 'goals', 'problemDetail', 'goalMeasures', 'interventions', 'medicationManagement', 'eachVisit', 'visitFrequency', 'escalation', 'review'])
});
const REQUIREMENT_LABELS = Object.freeze({
  problems: 'at least one problem',
  goals: 'at least one goal',
  problemDetail: 'a prognosis and an expected outcome for every problem',
  goalMeasures: 'a measure and a target for every goal',
  interventions: 'at least one intervention',
  medicationManagement: 'who manages the medications day to day',
  eachVisit: 'at least one task for each visit',
  visitFrequency: 'a visit frequency',
  escalation: 'at least one "call GFC when" sign',
  review: 'a review cadence and a next review date'
});

const lineKey = (serviceLine) => {
  const s = String(serviceLine || '').toUpperCase();
  return REQUIREMENTS[s] ? s : null;
};

const str = (v, max = 300) => String(v == null ? '' : v).trim().slice(0, max);
const strList = (v, maxLen = 300, maxItems = 40) =>
  Array.isArray(v) ? v.map(x => str(x, maxLen)).filter(Boolean).slice(0, maxItems) : [];
const oneOf = (v, list) => (list.includes(v) ? v : null);
const isoDate = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);
const newId = (prefix) => `${prefix}-${crypto.randomBytes(5).toString('hex')}`;
// An id the browser sent back is kept only if it is shaped like one we made,
// so a stray value never becomes a goal's identity.
const keepId = (v, prefix) => (typeof v === 'string' && new RegExp(`^${prefix}-[a-z0-9]{4,24}$`).test(v) ? v : null);
const asObject = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

// ---- 1 · Problems --------------------------------------------------------
// A string is a problem with only its text (every plan written before this).
const normalizeProblems = (input) => {
  const rows = Array.isArray(input.problemItems) ? input.problemItems : (Array.isArray(input.problems) ? input.problems : []);
  const out = [];
  for (const row of rows.slice(0, 40)) {
    const r = typeof row === 'string' ? { text: row } : asObject(row);
    const text = str(r.text, 300);
    if (!text) continue;
    out.push({
      id: keepId(r.id, 'p') || newId('p'),
      text,
      chartProblemId: str(r.chartProblemId, 120) || null,
      prognosis: str(r.prognosis, 500),
      expectedOutcome: str(r.expectedOutcome, 500)
    });
  }
  return out;
};

// ---- 2 · Goals ----------------------------------------------------------
// Status is carried from the plan being replaced when the goal id matches, so
// writing a new version never resets progress. A status chosen while writing
// the version is stamped with the author.
const normalizeGoals = (input, problemIds, previousGoals, author) => {
  const rows = Array.isArray(input.goalItems) ? input.goalItems : (Array.isArray(input.goals) ? input.goals : []);
  const prevById = new Map((previousGoals || []).filter(g => g && g.id).map(g => [g.id, g]));
  const out = [];
  for (const row of rows.slice(0, 40)) {
    const r = typeof row === 'string' ? { statement: row } : asObject(row);
    const statement = str(r.statement, 300);
    if (!statement) continue;
    const id = keepId(r.id, 'g') || newId('g');
    const prev = prevById.get(id) || null;
    const carried = prev ? oneOf(prev.status, GOAL_STATUSES) : null;
    const asked = oneOf(r.status, GOAL_STATUSES);
    const status = asked || carried || 'not_started';
    const changed = status !== (carried || 'not_started') || (!prev && asked);
    out.push({
      id,
      problemId: problemIds.has(r.problemId) ? r.problemId : null,
      statement,
      measure: str(r.measure, 200),
      baseline: str(r.baseline, 120),
      target: str(r.target, 120),
      targetDate: isoDate(r.targetDate),
      priority: oneOf(r.priority, PRIORITIES) || 'medium',
      patientStated: r.patientStated === true,
      status,
      statusBy: changed ? (author.name || null) : (prev ? prev.statusBy || null : null),
      statusAt: changed ? author.at : (prev ? prev.statusAt || null : null),
      statusNote: changed ? str(r.statusNote, 500) : (prev ? prev.statusNote || '' : '')
    });
  }
  return out;
};

// ---- 3 · Interventions ---------------------------------------------------
const normalizeInterventions = (input, goalIds) => {
  const rows = Array.isArray(input.interventions) ? input.interventions : [];
  const out = [];
  for (const row of rows.slice(0, 60)) {
    const r = asObject(row);
    const description = str(r.description, 300);
    if (!description) continue;
    out.push({
      id: keepId(r.id, 'i') || newId('i'),
      goalIds: (Array.isArray(r.goalIds) ? r.goalIds : []).filter(g => goalIds.has(g)),
      description,
      responsible: oneOf(r.responsible, RESPONSIBLE) || 'gfc_clinician',
      responsibleName: str(r.responsibleName, 120),
      frequency: oneOf(r.frequency, FREQUENCIES) || 'ongoing',
      type: oneOf(r.type, INTERVENTION_TYPES) || 'clinical'
    });
  }
  return out;
};

// ---- 4 · Medication management -------------------------------------------
// The medication LIST stays in the chart and the app's reconciled list. When
// it was last reconciled is read from the client record, never typed here.
const normalizeMedicationManagement = (input) => {
  const m = asObject(input.medicationManagement);
  return {
    managedBy: oneOf(m.managedBy, MED_MANAGED_BY),
    adherenceConcerns: str(m.adherenceConcerns, 1000),
    pharmacy: str(m.pharmacy, 200)
  };
};

// ---- 5 · Outside the practice --------------------------------------------
const normalizeOutsideCare = (input) => {
  const o = asObject(input.outsideCare);
  const team = (Array.isArray(o.externalTeam) ? o.externalTeam : []).slice(0, 30).map(asObject)
    .map(r => ({
      name: str(r.name, 120), role: str(r.role, 120), organization: str(r.organization, 160),
      phone: str(r.phone, 40), handles: str(r.handles, 300), lastContact: isoDate(r.lastContact)
    }))
    .filter(r => r.name || r.organization);
  const services = (Array.isArray(o.communityServices) ? o.communityServices : []).slice(0, 30).map(asObject)
    .map(r => ({ name: str(r.name, 160), status: oneOf(r.status, SERVICE_STATUSES) || 'active', notes: str(r.notes, 300) }))
    .filter(r => r.name);
  return { externalTeam: team, communityServices: services };
};

// ---- 7 · Safety and escalation -------------------------------------------
// Code status is read from the client record at display time, not typed here.
const normalizeEscalation = (input) => {
  const e = asObject(input.escalation);
  return {
    callGfcWhen: strList(e.callGfcWhen, 200, 20),
    call911When: strList(e.call911When, 200, 20),
    callOrder: strList(e.callOrder, 200, 10),
    afterHours: str(e.afterHours, 300),
    hospitalPreference: str(e.hospitalPreference, 200)
  };
};

// ---- 8 · Review ----------------------------------------------------------
const normalizeReview = (input) => {
  const r = asObject(input.review);
  return { cadence: oneOf(r.cadence, REVIEW_CADENCES), nextReviewDate: isoDate(r.nextReviewDate) };
};

// Which requirements a plan does not meet for its service line. An unknown
// line (or none) is held only to the original minimum: a problem and a goal.
const missingRequirements = (plan, serviceLine) => {
  const reqs = REQUIREMENTS[lineKey(serviceLine)] || ['problems', 'goals'];
  const missing = [];
  for (const key of reqs) {
    let ok = true;
    if (key === 'problems') ok = plan.problemItems.length > 0;
    else if (key === 'goals') ok = plan.goalItems.length > 0;
    else if (key === 'problemDetail') ok = plan.problemItems.every(p => p.prognosis && p.expectedOutcome);
    else if (key === 'goalMeasures') ok = plan.goalItems.every(g => g.measure && g.target);
    else if (key === 'interventions') ok = plan.interventions.length > 0;
    else if (key === 'medicationManagement') ok = !!plan.medicationManagement.managedBy;
    else if (key === 'eachVisit') ok = plan.eachVisit.length > 0;
    else if (key === 'visitFrequency') ok = !!plan.visitFrequency;
    else if (key === 'escalation') ok = plan.escalation.callGfcWhen.length > 0;
    else if (key === 'review') ok = !!(plan.review.cadence && plan.review.nextReviewDate);
    if (!ok) missing.push(key);
  }
  return missing;
};

// Tasks a home care aide may not be able to record. Advice, never a refusal:
// whether a particular caregiver can do the task depends on their licence and
// their sign-offs, which the visit log decides per caregiver. Below LPN a
// caregiver gives medication REMINDERS, and measurements need a sign-off.
const CAREGIVER_SCOPE_WORDS = [
  [/\b(administer|give|inject|insulin|injection|fill(ing)? (the )?(pill|med)|pill organi[sz]er|draw up)\b/i,
    'Below LPN a caregiver gives medication reminders only. Filling organizers or giving medication needs a licensed person.'],
  [/\b(blood pressure|\bbp\b|vitals?|weigh(t|ing)?|glucose|blood sugar|pulse|oxygen|o2 sat)\b/i,
    'Measurements only appear on a caregiver’s visit log once they are signed off for that task.'],
  [/\b(wound|dressing|catheter|trach|suction|ostomy|tube feed)\b/i,
    'This is a skilled task. A caregiver records it only with a sign-off, and it goes to a clinician for review.']
];
const scopeWarnings = (plan) => {
  const warnings = [];
  const seen = new Set();
  const check = (text, where) => {
    for (const [re, why] of CAREGIVER_SCOPE_WORDS) {
      if (re.test(text) && !seen.has(`${where}|${why}`)) {
        seen.add(`${where}|${why}`);
        warnings.push({ where, text, warning: why });
      }
    }
  };
  for (const t of plan.eachVisit || []) check(t, 'Each visit');
  for (const i of plan.interventions || []) {
    if (i.responsible === 'gfc_caregiver') check(i.description, 'Intervention');
    if (i.responsible === 'gfc_caregiver' && (i.type === 'medication' || i.type === 'clinical') && !seen.has(`type|${i.id}`)) {
      seen.add(`type|${i.id}`);
      warnings.push({ where: 'Intervention', text: i.description, warning: `A ${INTERVENTION_TYPE_LABELS[i.type].toLowerCase()} intervention is assigned to a caregiver. Check it is within their licence.` });
    }
  }
  if (plan.medicationManagement && plan.medicationManagement.managedBy === 'caregiver') {
    warnings.push({ where: 'Medications', text: 'Managed by caregiver', warning: 'A caregiver below LPN can remind, not manage or administer. Say who fills the organizer.' });
  }
  return warnings;
};

// Build the structured blocks of a new version. `previousPlan` supplies goal
// status to carry forward.
const buildStructuredBlocks = (previousPlan, input, author) => {
  const problemItems = normalizeProblems(input);
  const problemIds = new Set(problemItems.map(p => p.id));
  const previousGoals = previousPlan && Array.isArray(previousPlan.goalItems) ? previousPlan.goalItems : [];
  const goalItems = normalizeGoals(input, problemIds, previousGoals, author);
  const goalIds = new Set(goalItems.map(g => g.id));
  return {
    problemItems,
    goalItems,
    interventions: normalizeInterventions(input, goalIds),
    medicationManagement: normalizeMedicationManagement(input),
    outsideCare: normalizeOutsideCare(input),
    escalation: normalizeEscalation(input),
    review: normalizeReview(input)
  };
};

// The structured items for a plan written before this change, read-only.
// Nothing is written back: a v1 string goal becomes an object only when a
// clinician writes the next version.
const structuredView = (plan) => {
  if (!plan || typeof plan !== 'object') return null;
  if (Array.isArray(plan.goalItems)) return plan;
  return {
    ...plan,
    problemItems: (plan.problems || []).map((text, i) => ({ id: null, text: String(text), chartProblemId: null, prognosis: '', expectedOutcome: '', legacyIndex: i })),
    goalItems: (plan.goals || []).map((statement, i) => ({
      id: null, problemId: null, statement: String(statement), measure: '', baseline: '', target: '', targetDate: null,
      priority: 'medium', patientStated: false, status: null, statusBy: null, statusAt: null, statusNote: '', legacyIndex: i
    })),
    interventions: [],
    medicationManagement: { managedBy: null, adherenceConcerns: '', pharmacy: '' },
    outsideCare: { externalTeam: [], communityServices: [] },
    escalation: { callGfcWhen: [], call911When: [], callOrder: [], afterHours: '', hospitalPreference: '' },
    review: { cadence: null, nextReviewDate: null },
    legacyFormat: true
  };
};

// Update one goal's status on the CURRENT plan without a new version.
// Returns { plan, event } or { error, code }.
const applyGoalStatus = (plan, goalId, { status, note }, actor, at) => {
  if (!plan || !Array.isArray(plan.goalItems)) {
    return { error: 'This care plan was written before goals had a status. Write a new version to track goal status.', code: 'CARE_PLAN_LEGACY_GOALS' };
  }
  const next = oneOf(status, GOAL_STATUSES);
  if (!next) return { error: `Status must be one of: ${GOAL_STATUSES.join(', ')}`, code: 'GOAL_STATUS_INVALID' };
  const idx = plan.goalItems.findIndex(g => g && g.id === goalId);
  if (idx === -1) return { error: 'No such goal on the current care plan', code: 'GOAL_NOT_FOUND' };
  const goal = plan.goalItems[idx];
  const cleanNote = str(note, 500);
  if (goal.status === next && !cleanNote) return { error: 'The goal already has that status', code: 'GOAL_STATUS_UNCHANGED' };
  const updated = { ...goal, status: next, statusBy: actor.name || null, statusAt: at, statusNote: cleanNote };
  const goalItems = plan.goalItems.slice();
  goalItems[idx] = updated;
  return {
    plan: { ...plan, goalItems },
    event: {
      planVersion: plan.version, goalId, previous: goal.status || null, status: next,
      note: cleanNote, byId: actor.id || null, byName: actor.name || null, at
    }
  };
};

// What the client and their care team see of the parts that are read from the
// client record rather than typed into the plan.
const CODE_STATUS_FROM_INTAKE = Object.freeze({
  'Yes — DNR in place': 'DNR on file',
  'Yes — advance directive / living will': 'Advance directive / living will on file',
  'Yes — healthcare proxy / POA': 'Healthcare proxy / POA on file',
  'No': 'Full code (no DNR on file)',
  'Unknown': 'Not known — confirm with the family'
});
const derivedFromClient = (client) => {
  const intake = (client && client.intake) || {};
  const ad = (intake.advanceDirective && intake.advanceDirective.status) || null;
  const team = intake.medicalTeam || {};
  const medRec = (client && client.medRecLast) || null;
  return {
    codeStatus: ad ? (CODE_STATUS_FROM_INTAKE[ad] || String(ad)) : null,
    medicationsReconciled: medRec ? { at: medRec.at || null, byName: medRec.byName || null } : null,
    // Starting values for a NEW plan; once a version is written, the plan's
    // own values are used.
    suggested: {
      pharmacy: [team.preferredPharmacy, team.pharmacyPhone].filter(Boolean).join(' · '),
      hospitalPreference: team.preferredHospital || '',
      externalTeam: [
        team.pcpName ? { name: team.pcpName, role: 'Primary care', organization: team.pcpPractice || '', phone: team.pcpPhone || '' } : null,
        team.specialist1Name ? { name: team.specialist1Name, role: 'Specialist', organization: '', phone: team.specialist1Phone || '' } : null,
        team.specialist2Name ? { name: team.specialist2Name, role: 'Specialist', organization: '', phone: '' } : null
      ].filter(Boolean)
    }
  };
};

// What the patient and their POA see of the structured blocks (the portal's
// full level). Plain language and labels only. Prognosis and adherence
// concerns are clinician notes and stay out; so does every internal id.
// A plan written before the format yields empty lists.
const patientProjection = (plan) => {
  if (!plan || !Array.isArray(plan.goalItems)) {
    return { goalProgress: [], interventionList: [], escalationPlan: null, nextReviewDate: null, outsideTeam: [], communityServices: [], medicationHandling: null };
  }
  const goalText = new Map(plan.goalItems.map(g => [g.id, g.statement]));
  const esc = plan.escalation || {};
  const mm = plan.medicationManagement || {};
  const oc = plan.outsideCare || {};
  return {
    goalProgress: plan.goalItems.map(g => ({
      statement: g.statement, measure: g.measure || null, baseline: g.baseline || null, target: g.target || null,
      targetDate: g.targetDate || null, patientStated: !!g.patientStated,
      status: g.status || null, statusLabel: GOAL_STATUS_LABELS[g.status] || null, statusAt: g.statusAt || null
    })),
    interventionList: (plan.interventions || []).map(i => ({
      description: i.description,
      who: RESPONSIBLE_LABELS[i.responsible] + (i.responsibleName ? ` (${i.responsibleName})` : ''),
      howOften: FREQUENCY_LABELS[i.frequency] || null,
      forGoals: (i.goalIds || []).map(id => goalText.get(id)).filter(Boolean)
    })),
    escalationPlan: {
      callGfcWhen: esc.callGfcWhen || [], call911When: esc.call911When || [], callOrder: esc.callOrder || [],
      afterHours: esc.afterHours || null, hospitalPreference: esc.hospitalPreference || null
    },
    nextReviewDate: (plan.review && plan.review.nextReviewDate) || null,
    outsideTeam: (oc.externalTeam || []).map(t => ({ name: t.name, role: t.role, organization: t.organization, phone: t.phone, handles: t.handles })),
    communityServices: (oc.communityServices || []).map(c => ({ name: c.name, status: c.status })),
    medicationHandling: mm.managedBy ? { managedBy: MED_MANAGED_BY_LABELS[mm.managedBy], pharmacy: mm.pharmacy || null } : null
  };
};

// What a caregiver sees: their tasks, the schedule, the interventions assigned
// to a GFC caregiver, and the escalation block. No problems, no goals'
// clinical measures, no medication notes (caregiverRepository's allow-list).
const caregiverProjection = (plan) => {
  if (!plan || typeof plan !== 'object') return {};
  // The real keys first; the short ones only if a record carries them.
  const pick = (real, short) => (plan[real] !== undefined && plan[real] !== '' ? plan[real] : plan[short]);
  return {
    tasks: pick('eachVisit', 'tasks') || [],
    frequency: pick('visitFrequency', 'frequency') || null,
    days: pick('visitDays', 'days') || [],
    times: pick('visitTimes', 'times') || null,
    caregiverInterventions: (plan.interventions || []).filter(i => i.responsible === 'gfc_caregiver')
      .map(i => ({ description: i.description, howOften: FREQUENCY_LABELS[i.frequency] || null })),
    escalation: plan.escalation ? {
      callGfcWhen: plan.escalation.callGfcWhen || [], call911When: plan.escalation.call911When || [],
      callOrder: plan.escalation.callOrder || [], afterHours: plan.escalation.afterHours || null
    } : null
  };
};

// ---- What the patient may see (owner, 2026-10-14) ----------------------
// A care plan reaches the patient, their POA and family only once a licensed
// clinician's signature has made it active: an RN (or provider/LCSW) for a
// home care plan, a provider or LCSW for a clinical patient's. That is exactly
// "not waiting on a co-signature" (clinicalRoles.evaluateCarePlanSignature
// decides who completes a plan). A plan written before the co-signature step
// existed carries no status and was signed by a clinician, so it is active.
const isPlanActive = (plan, versionRow = null) => {
  if (!plan || typeof plan !== 'object') return false;
  if (plan.providerCoSignStatus !== 'pending') return true;
  // A version row keeps the status as it was when written ('pending'); the
  // co-signature added later is what shows it became active.
  return !!(versionRow && versionRow.providerSignature && versionRow.providerSignature.signatureImage);
};

// The plan the patient side may see: the current one when it is active,
// otherwise the newest earlier version that was, so a family keeps the
// instructions they had while an update waits on a clinician. Null when no
// version has ever been active. `isCurrent` tells the portal whether the plan
// shown is the one that can be co-signed.
const patientVisiblePlan = (current, versionRows = []) => {
  if (!current || typeof current !== 'object') return null;
  if (isPlanActive(current)) return { plan: current, version: current.version, isCurrent: true, newerInReview: false };
  const earlier = (versionRows || [])
    .filter(r => r && r.plan && Number(r.version) < Number(current.version) && isPlanActive(r.plan, r))
    .sort((a, b) => Number(b.version) - Number(a.version))[0];
  if (!earlier) return null;
  return { plan: earlier.plan, version: earlier.version, isCurrent: false, newerInReview: true };
};

// The option lists the page draws from, served so the page restates none.
const vocabulary = () => ({
  goalStatuses: GOAL_STATUSES.map(v => ({ value: v, label: GOAL_STATUS_LABELS[v] })),
  priorities: PRIORITIES.map(v => ({ value: v, label: v[0].toUpperCase() + v.slice(1) })),
  responsible: RESPONSIBLE.map(v => ({ value: v, label: RESPONSIBLE_LABELS[v] })),
  frequencies: FREQUENCIES.map(v => ({ value: v, label: FREQUENCY_LABELS[v] })),
  interventionTypes: INTERVENTION_TYPES.map(v => ({ value: v, label: INTERVENTION_TYPE_LABELS[v] })),
  medManagedBy: MED_MANAGED_BY.map(v => ({ value: v, label: MED_MANAGED_BY_LABELS[v] })),
  serviceStatuses: SERVICE_STATUSES.map(v => ({ value: v, label: v[0].toUpperCase() + v.slice(1) })),
  reviewCadences: REVIEW_CADENCES.map(v => ({ value: v, label: REVIEW_CADENCE_LABELS[v] })),
  requirements: Object.fromEntries(Object.entries(REQUIREMENTS).map(([k, v]) => [k, v.map(key => ({ key, label: REQUIREMENT_LABELS[key] }))]))
});

module.exports = {
  GOAL_STATUSES, GOAL_STATUS_LABELS, PRIORITIES, RESPONSIBLE, RESPONSIBLE_LABELS, FREQUENCIES, FREQUENCY_LABELS,
  INTERVENTION_TYPES, INTERVENTION_TYPE_LABELS, MED_MANAGED_BY, MED_MANAGED_BY_LABELS, SERVICE_STATUSES,
  REVIEW_CADENCES, REVIEW_CADENCE_LABELS, REQUIREMENTS, REQUIREMENT_LABELS,
  buildStructuredBlocks, missingRequirements, scopeWarnings, structuredView, applyGoalStatus,
  derivedFromClient, vocabulary, patientProjection, caregiverProjection, isPlanActive, patientVisiblePlan
};
