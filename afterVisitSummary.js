'use strict';
// ============================================================================
// After-visit summary (owner, 2026-09-29)
//
// ONE assembler for the paper copy a patient keeps, a family member is handed
// or a facility files in the resident's chart. The staff download and the
// patient download both come through `assemble()`, and the portal's visit card
// reads the same visit summary it starts from, so the three cannot disagree.
//
// What it carries (a standard after-visit summary): the visit date and who was
// seen, what we did in plain words, what was addressed, the medication CHANGES
// (started, refilled, changed, stopped) and the full current list, allergies,
// what was ordered, the follow-up instructions, the next visit, how to reach
// GFC (including after hours) and when to call 911.
//
// What it never carries: a diagnosis code, a service code, an NPI, a fax
// number, an order reference, the clinical note, or anything billing.
//
// Patients have no OpenEMR identity, so a patient download cannot read the
// chart. The chart-derived parts (current medications, allergies, next visit)
// are SNAPSHOTTED at signing, when a clinician's login can read them, and are
// refreshed whenever staff download it. Each part says where it came from, and
// a part that could not be read says so rather than printing "none".
// ============================================================================

const RX_CHANGE_TAG = { new: 'STARTED', refill: 'REFILLED', change: 'CHANGED' };
const MED_CHANGE_TAG = { started: 'STARTED', stopped: 'STOPPED', changed: 'CHANGED' };

const EMERGENCY_TEXT =
  'Call 911 right away for chest pain or pressure, trouble breathing, a face that droops, ' +
  'an arm or leg that is suddenly weak or numb, trouble speaking, fainting or not waking up, ' +
  'a seizure, a bad fall or head injury, heavy bleeding that will not stop, sudden confusion, ' +
  'or thoughts of hurting yourself or someone else. Do not wait for a call back from us.';

const clean = (v) => String(v == null ? '' : v).trim();
const normName = (v) => clean(v).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// "Take 1 tablet by mouth twice daily" out of the pieces a prescription carries.
const rxDetail = (r) => [clean(r.dose), clean(r.route), clean(r.frequency), clean(r.instructions)].filter(Boolean).join(' · ');

// Medication changes AT THIS VISIT: prescriptions written on the encounter, plus
// reconciliation decisions recorded against it (or, when none carries an
// encounter, made on the visit's own date). Stopped medicines come only from
// the reconciliation log, which is the one place a stop is recorded.
const buildMedicationChanges = ({ prescriptions, medChanges }) => {
  const out = [];
  for (const r of prescriptions || []) {
    if (!r) continue;
    out.push({ tag: RX_CHANGE_TAG[r.kind] || 'STARTED', text: clean(r.drug) || 'Medication', detail: rxDetail(r) || null });
  }
  const seen = new Set(out.map(o => `${o.tag}|${normName(o.text)}`));
  for (const c of medChanges || []) {
    if (!c || !MED_CHANGE_TAG[c.action]) continue;
    const tag = MED_CHANGE_TAG[c.action];
    const key = `${tag}|${normName(c.name)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const detail = c.action === 'changed' && c.previous
      ? `now ${[c.dose, c.frequency].filter(Boolean).join(' ')}${[c.previous.dose, c.previous.frequency].filter(Boolean).length ? ` (was ${[c.previous.dose, c.previous.frequency].filter(Boolean).join(' ')})` : ''}`
      : ([clean(c.dose), clean(c.route), clean(c.frequency)].filter(Boolean).join(' · ') || null);
    out.push({ tag, text: clean(c.name) || 'Medication', detail: c.action === 'stopped' ? (detail ? `${detail} — stop taking this` : 'stop taking this') : detail });
  }
  return out;
};

// Which reconciliation rows belong to this visit.
const changesForVisit = (rows, { clientId, encounterUuid, visitDate }) => (rows || []).filter(c => c && c.clientId === clientId && (
  (c.encounterUuid && String(c.encounterUuid) === String(encounterUuid)) ||
  (!c.encounterUuid && visitDate && c.day === visitDate)
));

// A current-medication row for the page: bold name, then how to take it.
const currentMedRows = (snapshot, fallbackMeds) => {
  const snap = snapshot && snapshot.medications;
  if (snap && snap.source !== 'unavailable' && Array.isArray(snap.rows)) {
    return { available: true, source: snap.source, current: snap.rows.map(r => ({ text: r.name, detail: r.detail || null })) };
  }
  const app = (fallbackMeds || []).filter(m => m && clean(m.name));
  if (app.length) {
    return { available: true, source: 'app', current: app.map(m => ({ text: clean(m.name), detail: [clean(m.dose), clean(m.route), clean(m.frequency)].filter(Boolean).join(' · ') || null })) };
  }
  return { available: false, source: 'unavailable', current: [] };
};

// Allergies: the chart's list, else what was reported at intake (labelled as
// such), else "could not be read". Never "no known allergies" out of a failure.
const allergyRows = (snapshot, intakeText) => {
  const snap = snapshot && snapshot.allergies;
  if (snap && snap.source === 'chart' && Array.isArray(snap.rows)) return snap.rows.map(r => (typeof r === 'string' ? { text: r } : r));
  const intake = clean(intakeText || (snap && snap.intakeText));
  if (intake) return [{ text: intake, detail: 'as reported when you enrolled' }];
  return null;
};

const contactLines = (org) => {
  const lines = [`Call Godwins Family Care at ${org.phone} for questions, a medication problem or a new symptom.`];
  if (org.afterHoursPhone && org.afterHoursPhone !== org.phone) lines.push(`After hours, call ${org.afterHoursPhone} to reach our on-call clinician.`);
  else lines.push(`After hours, the same number (${org.phone}) reaches our on-call clinician.`);
  lines.push('If it is urgent and you cannot reach us, call 911 or go to the emergency department.');
  return lines;
};

const nextVisitBlock = (snapshot) => {
  const nv = snapshot && snapshot.nextVisit;
  if (!nv || nv.state !== 'found') return null;
  return { when: nv.when, who: nv.who ? `With ${nv.who}` : null, where: nv.where || null };
};

// `sections` is the viewer's sharing verdict (patient / POA = full; family per
// the client's settings). A section a family member may not see is left out,
// never printed as empty.
const assemble = ({ client, record, visit, prescriptions, medChanges, snapshot, org, sections, dob, preparedLabel, visitDateLabel, fallbackMeds, intakeAllergies }) => {
  const see = (k) => !sections || (sections[k] && sections[k] !== 'none');
  const rec = record || {};
  const medsSnapshot = currentMedRows(snapshot, fallbackMeds);
  const changes = buildMedicationChanges({ prescriptions, medChanges });
  return {
    patientName: (client && (client.name || client.preferredName)) || '',
    dob: dob || null,
    visitDateLabel,
    providerLabel: (visit && visit.provider) || 'Your care team',
    visitReason: (visit && visit.reason) || null,
    whatWeDid: clean(rec.patientSummary) || (visit && visit.diagnosesAddressed && visit.diagnosesAddressed.length
      ? `This visit addressed: ${visit.diagnosesAddressed.join(', ')}.` : null),
    diagnoses: (visit && visit.diagnosesAddressed) || [],
    medications: see('medications')
      ? { available: medsSnapshot.available || changes.length > 0, changes, current: medsSnapshot.current, source: medsSnapshot.source }
      : { available: true, changes, current: [], hiddenCurrent: true },
    allergies: see('allergies') ? allergyRows(snapshot, intakeAllergies) : undefined,
    orders: ((visit && visit.testsOrdered) || []).map(t => ({
      tag: t.type, text: (t.tests && t.tests.length ? t.tests.join(', ') : t.type), detail: [t.where ? `with ${t.where}` : null, t.status].filter(Boolean).join(' — ')
    })),
    followUp: clean(rec.followUpInstructions) || null,
    nextVisit: see('appointments') ? nextVisitBlock(snapshot) : null,
    nextVisitAsOf: snapshot && snapshot.nextVisit && snapshot.nextVisit.asOfLabel ? snapshot.nextVisit.asOfLabel : null,
    contactLines: contactLines(org),
    emergencyText: EMERGENCY_TEXT,
    preparedLabel
  };
};

module.exports = {
  RX_CHANGE_TAG, MED_CHANGE_TAG, EMERGENCY_TEXT,
  buildMedicationChanges, changesForVisit, currentMedRows, allergyRows, contactLines, nextVisitBlock, assemble
};
