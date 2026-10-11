// screenings.js — recording a screening result on an encounter (owner, 2026-10-11)
//
// A social worker's standing-order work is mostly screening: PHQ-9, GAD-7, a
// social-needs (SDOH) screen. Until now there was nowhere to record one. The
// standing-order machinery permitted a `screening` order type, and
// `buildOrder` refused it, so a screening protocol could be signed and never
// executed.
//
// A screening is not an order. Nothing is sent anywhere and nothing comes
// back: it is administered and scored in the same visit. So it is its own
// record on the encounter, and a standing order (when one is named) is the
// authority it was given under, exactly as for an order.
//
// ⚠️ THE INSTRUMENTS THEMSELVES ARE OPENEMR'S (owner, 2026-09-23: "OpenEMR
// already has these templates so I don't want to recreate but add"). This
// module records the TOTAL and what it means. It does not rebuild the
// questions. The one item it asks for separately is PHQ-9 item 9, because a
// positive answer there is a safety question that cannot wait for someone to
// open the template.

const INSTRUMENTS = Object.freeze({
  phq2: {
    key: 'phq2', label: 'PHQ-2', min: 0, max: 6,
    // A score of 3 or more is a positive screen, followed by a PHQ-9.
    bands: [{ upTo: 2, label: 'Negative' }, { upTo: 6, label: 'Positive: complete a PHQ-9' }],
    positiveFrom: 3
  },
  phq9: {
    key: 'phq9', label: 'PHQ-9', min: 0, max: 27,
    bands: [
      { upTo: 4, label: 'Minimal' }, { upTo: 9, label: 'Mild' }, { upTo: 14, label: 'Moderate' },
      { upTo: 19, label: 'Moderately severe' }, { upTo: 27, label: 'Severe' }
    ],
    positiveFrom: 10,
    asksItem9: true
  },
  gad7: {
    key: 'gad7', label: 'GAD-7', min: 0, max: 21,
    bands: [{ upTo: 4, label: 'Minimal' }, { upTo: 9, label: 'Mild' }, { upTo: 14, label: 'Moderate' }, { upTo: 21, label: 'Severe' }],
    positiveFrom: 10
  },
  sdoh: {
    key: 'sdoh', label: 'Social needs (SDOH)', min: null, max: null,
    // No score: a list of the needs the client named. Any need is positive.
    needs: ['food', 'housing', 'transportation', 'utilities', 'safety', 'caregiving', 'financial', 'isolation']
  }
});
const INSTRUMENT_KEYS = Object.freeze(Object.keys(INSTRUMENTS));
const NEED_LABELS = Object.freeze({
  food: 'Food', housing: 'Housing', transportation: 'Transportation', utilities: 'Utilities',
  safety: 'Personal safety', caregiving: 'Caregiver support', financial: 'Money / bills', isolation: 'Loneliness / isolation'
});

const bandFor = (inst, score) => {
  const b = (inst.bands || []).find(x => score <= x.upTo);
  return b ? b.label : null;
};

const toInt = (v) => {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const n = Number(v);
  return Number.isInteger(n) ? n : NaN;
};

// The input → a stored row, or a refusal. Pure.
const buildScreening = ({ id, clientId, encounterUuid, input, actor, at, standingOrderRef, authorizedBy }) => {
  const i = input || {};
  const inst = INSTRUMENTS[String(i.instrument || '').trim()];
  if (!inst) return { error: `Choose a screening: ${INSTRUMENT_KEYS.map(k => INSTRUMENTS[k].label).join(', ')}`, code: 'SCREENING_BAD_INSTRUMENT' };
  const row = {
    id, clientId, encounterUuid: String(encounterUuid),
    instrument: inst.key, label: inst.label,
    score: null, interpretation: null, positive: false, needs: [], item9: null,
    notes: String(i.notes || '').trim().slice(0, 2000),
    recordedBy: actor ? { id: actor.id, name: actor.name || null, clinicalRole: actor.clinicalRole || null, licenseLevel: actor.licenseLevel || null } : null,
    authority: standingOrderRef ? 'standing_order' : 'direct',
    standingOrder: standingOrderRef || null,
    authorizedBy: authorizedBy || null,
    at: at || new Date().toISOString()
  };
  if (inst.key === 'sdoh') {
    const raw = Array.isArray(i.needs) ? i.needs.map(x => String(x).trim()) : [];
    const unknown = raw.filter(n => !inst.needs.includes(n));
    if (unknown.length) return { error: `${unknown.join(', ')} is not a need on this screen. Choose from: ${inst.needs.map(n => NEED_LABELS[n]).join(', ')}.`, code: 'SCREENING_BAD_NEED' };
    row.needs = Array.from(new Set(raw));
    row.positive = row.needs.length > 0;
    row.interpretation = row.positive ? `Needs named: ${row.needs.map(n => NEED_LABELS[n]).join(', ')}` : 'No needs named';
    return { screening: row };
  }
  const score = toInt(i.score);
  if (score === null) return { error: `Enter the ${inst.label} total score.`, code: 'SCREENING_NO_SCORE' };
  if (Number.isNaN(score) || score < inst.min || score > inst.max) {
    return { error: `A ${inst.label} total is a whole number from ${inst.min} to ${inst.max}.`, code: 'SCREENING_BAD_SCORE' };
  }
  row.score = score;
  row.interpretation = bandFor(inst, score);
  row.positive = score >= inst.positiveFrom;
  if (inst.asksItem9) {
    // Item 9 (thoughts of being better off dead or of self-harm) is answered
    // 0–3. It is REQUIRED: a PHQ-9 recorded without it would let a positive
    // answer pass unseen.
    const item9 = toInt(i.item9);
    if (item9 === null) return { error: 'Enter the answer to PHQ-9 item 9 (thoughts of self-harm), 0 to 3.', code: 'SCREENING_ITEM9_REQUIRED' };
    if (Number.isNaN(item9) || item9 < 0 || item9 > 3) return { error: 'PHQ-9 item 9 is answered 0 to 3.', code: 'SCREENING_BAD_ITEM9' };
    if (item9 > score) return { error: 'Item 9 cannot be more than the total score.', code: 'SCREENING_BAD_ITEM9' };
    row.item9 = item9;
  }
  return { screening: row };
};

// Whether this result needs a risk assessment before the visit is closed.
// Item 9 above 0 is the one answer that must never wait.
const needsRiskAssessment = (row) => !!(row && row.instrument === 'phq9' && Number(row.item9) > 0);

// One line per result, for the note in OpenEMR and the encounter view.
const describe = (row) => {
  if (!row) return '';
  if (row.instrument === 'sdoh') return `${row.label}: ${row.interpretation}`;
  const parts = [`${row.label} ${row.score}/${INSTRUMENTS[row.instrument].max} (${row.interpretation})`];
  if (row.item9 != null) parts.push(`item 9: ${row.item9}`);
  return parts.join(', ');
};

// The catalog served to the page, so it never restates the ranges.
const catalog = () => INSTRUMENT_KEYS.map(k => {
  const inst = INSTRUMENTS[k];
  return {
    key: inst.key, label: inst.label, min: inst.min, max: inst.max, asksItem9: !!inst.asksItem9,
    needs: inst.needs ? inst.needs.map(n => ({ key: n, label: NEED_LABELS[n] })) : null
  };
});

module.exports = { INSTRUMENTS, INSTRUMENT_KEYS, NEED_LABELS, buildScreening, needsRiskAssessment, describe, catalog };
