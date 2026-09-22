// controlledSubstances.js — Session 4.10, Scope B
//
// WHY THIS EXISTS. Georgia APRNs may not prescribe Schedule I or II substances.
// Before this session `buildPrescription` took the drug as free text and checked
// nothing, and the PRESCRIBE capability was `provider` — which covers an MD and
// an NP alike, because `clinicalRole` cannot tell them apart and `licenseLevel`
// is free text that gates nothing.
//
// There is no e-prescribing here, so the app is not the prescription. IT IS THE
// CHART SAYING A PRESCRIPTION WAS WRITTEN. That is the same exposure Session 4.8
// closed for RNs: the app producing the record asserting somebody acted outside
// their scope.
//
// ⚠️ THIS LIST IS A BACKSTOP, NOT A FORMULARY, AND IT WILL NEVER BE COMPLETE.
// It exists to catch the realistic failure — "Adderall" declared
// non-controlled, by a clinician who did not think of Adderall as a Schedule II
// drug — not to be the authority on what schedule a drug is in. The DECLARED
// schedule is the clinician's, and this refuses a declaration that contradicts a
// term we are confident about. A drug absent from this list is not thereby
// non-controlled; it is a drug this file does not know, and the declaration
// stands. Adding a drug database is a non-goal (§Non-goals) and would not change
// that reasoning: no list makes the declaration unnecessary.

'use strict';

const SCHEDULES = Object.freeze(['non_controlled', 'CII', 'CIII', 'CIV', 'CV']);
const CONTROLLED_SCHEDULES = Object.freeze(['CII', 'CIII', 'CIV', 'CV']);
const SCHEDULE_LABELS = Object.freeze({
  non_controlled: 'Not a controlled substance',
  CII: 'Schedule II', CIII: 'Schedule III', CIV: 'Schedule IV', CV: 'Schedule V'
});
const isControlled = (schedule) => CONTROLLED_SCHEDULES.includes(String(schedule || ''));

// Prescriber credential. `clinicalRole: 'provider'` is one value for four very
// different prescribing authorities, so the credential is its own structured
// field rather than something parsed out of free text — parsing "FNP-BC, APRN"
// for the word "NP" is how a guard starts passing the wrong people.
const PRESCRIBER_CREDENTIALS = Object.freeze(['MD', 'DO', 'NP', 'PA']);
const PRESCRIBER_CREDENTIAL_LABELS = Object.freeze({
  MD: 'MD — physician', DO: 'DO — physician',
  NP: 'NP / APRN — nurse practitioner', PA: 'PA — physician associate'
});
// Who may not put their name on a Schedule II prescription in Georgia.
const SCHEDULE_II_PROHIBITED_CREDENTIALS = Object.freeze(['NP', 'PA']);

// ---- The Schedule II agents this file is confident about -----------------
// Generic agents and the brand names actually seen in home-based primary care.
// Matched on WORD BOUNDARIES, case-insensitively: a substring match would fire
// "codeine" on "codeine-free" and miss nothing useful in exchange.
//
// CODEINE IS DELIBERATELY SINGLE-AGENT ONLY. Codeine on its own is Schedule II;
// in combination — Tylenol #3, most cough syrups — it is Schedule III or V, and
// flagging those as CII would refuse a legitimate CIII declaration. So the
// combination products are listed separately as NOT-CII terms and checked first.
const CII_TERMS = Object.freeze([
  // stimulants
  'amphetamine', 'amphetamines', 'dextroamphetamine', 'dexamfetamine',
  'lisdexamfetamine', 'methylphenidate', 'dexmethylphenidate',
  'adderall', 'mydayis', 'vyvanse', 'ritalin', 'concerta', 'focalin',
  'metadate', 'methylin', 'quillivant', 'jornay', 'adhansia', 'azstarys',
  'desoxyn', 'zenzedi', 'dexedrine', 'evekeo', 'xelstrym',
  // opioids
  'oxycodone', 'oxycontin', 'roxicodone', 'oxaydo', 'percocet', 'endocet',
  'hydrocodone', 'norco', 'vicodin', 'lortab', 'hysingla', 'zohydro', 'xodol',
  'morphine', 'ms contin', 'msir', 'arymo', 'kadian', 'mitigo', 'duramorph',
  'hydromorphone', 'dilaudid', 'exalgo',
  'fentanyl', 'duragesic', 'actiq', 'subsys', 'abstral', 'fentora', 'lazanda',
  'methadone', 'dolophine', 'methadose',
  'oxymorphone', 'opana',
  'tapentadol', 'nucynta',
  'levorphanol', 'meperidine', 'demerol',
  'secobarbital', 'seconal', 'pentobarbital', 'nembutal',
  'cocaine', 'nabilone'
]);
// Combination or formulation names that CONTAIN a CII term but are not
// Schedule II. Checked first, and the match is removed from consideration, so a
// legitimate CIII/CV declaration is not refused by a substring of its own name.
const NOT_CII_TERMS = Object.freeze([
  'tylenol #3', 'tylenol #4', 'tylenol with codeine', 'acetaminophen with codeine',
  'codeine phosphate and guaifenesin', 'guaifenesin and codeine',
  'promethazine with codeine', 'promethazine and codeine',
  'butalbital and codeine', 'fioricet with codeine', 'fiorinal with codeine',
  'buprenorphine', 'suboxone', 'subutex', 'belbuca', 'butrans',
  'benzonatate'
]);
// Single-agent codeine, checked separately so the combinations above do not
// have to be exhaustive to avoid a false CII flag on one of them.
const CODEINE_SINGLE_AGENT = /(^|[^a-z])codeine\s*(sulfate|phosphate)?\s*(tablet|tab|oral|solution)?\s*$/i;

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Word boundary that also treats a digit or a hyphen as a boundary, because drug
// text is written "Adderall XR 20mg" and "methylphenidate-ER".
const termMatches = (text, term) => new RegExp(`(^|[^a-z])${esc(term)}([^a-z]|$)`, 'i').test(text);

// Returns the matched term, or null. NAMING THE TERM IS THE POINT: a refusal
// that says "this looks controlled" tells a clinician nothing they can act on;
// one that says it matched "Adderall" tells them exactly what to change.
const matchScheduleTwoTerm = (drugText) => {
  const text = ` ${String(drugText || '').toLowerCase().replace(/\s+/g, ' ').trim()} `;
  if (!text.trim()) return null;
  // A known non-CII combination wins outright.
  for (const t of NOT_CII_TERMS) if (text.includes(` ${t} `) || termMatches(text, t)) return null;
  for (const t of CII_TERMS) if (termMatches(text, t)) return t;
  if (CODEINE_SINGLE_AGENT.test(String(drugText || '').trim())) return 'codeine';
  return null;
};

// ---- The DEA registration ----------------------------------------------
// Any controlled schedule requires a DEA number on file, unexpired, covering
// that schedule. All three are separate refusals because they are three
// different jobs: get a registration, renew it, or add a schedule to it.
const DEA_SCHEDULES = Object.freeze(['CII', 'CIII', 'CIV', 'CV']);
// A DEA number is two letters, seven digits. The last digit is a checksum, which
// is validated because a transposed digit produces a syntactically valid number
// belonging to somebody else.
const normalizeDea = (raw) => {
  const s = String(raw == null ? '' : raw).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!/^[A-Z]{2}\d{7}$/.test(s)) return null;
  const d = s.slice(2).split('').map(Number);
  const check = ((d[0] + d[2] + d[4]) + 2 * (d[1] + d[3] + d[5])) % 10;
  return check === d[6] ? s : null;
};
const normalizeDeaSchedules = (raw) => Array.from(new Set(
  (Array.isArray(raw) ? raw : []).map(v => String(v || '').trim().toUpperCase()).filter(v => DEA_SCHEDULES.includes(v))
));
const isYmd = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));

const normalizeDeaRegistration = (user) => {
  const u = user || {};
  return {
    deaNumber: normalizeDea(u.deaNumber),
    deaSchedules: normalizeDeaSchedules(u.deaSchedules),
    deaExpiresAt: isYmd(u.deaExpiresAt) ? String(u.deaExpiresAt) : null
  };
};

// `today` is a YYYY-MM-DD string in the PRACTICE timezone. It is passed in
// rather than read here, because a registration that expires today should be
// judged by the date in Georgia, not by UTC — which is a different date for
// four hours of every evening.
const checkDeaAuthority = ({ user, schedule, today }) => {
  if (!isControlled(schedule)) return { ok: true, required: false };
  const reg = normalizeDeaRegistration(user);
  const who = (user && user.name) || 'This prescriber';
  if (!reg.deaNumber) {
    return {
      ok: false, required: true, code: 'DEA_NOT_ON_FILE',
      error: `${who} has no valid DEA registration on file, so a ${SCHEDULE_LABELS[schedule] || schedule} prescription cannot be recorded. An admin records the DEA number on the user record.`
    };
  }
  const day = isYmd(today) ? String(today) : new Date().toISOString().slice(0, 10);
  if (reg.deaExpiresAt && reg.deaExpiresAt < day) {
    return {
      ok: false, required: true, code: 'DEA_EXPIRED',
      error: `${who}'s DEA registration expired ${reg.deaExpiresAt}. A ${SCHEDULE_LABELS[schedule] || schedule} prescription cannot be recorded against an expired registration.`
    };
  }
  if (!reg.deaSchedules.includes(String(schedule))) {
    return {
      ok: false, required: true, code: 'DEA_SCHEDULE_NOT_COVERED',
      error: `${who}'s DEA registration covers ${reg.deaSchedules.join(', ') || 'no schedules'}; it does not cover ${SCHEDULE_LABELS[schedule] || schedule}.`,
      covers: reg.deaSchedules
    };
  }
  return { ok: true, required: true, registration: reg };
};

// ---- The PDMP attestation ----------------------------------------------
// Georgia requires a PDMP check before dispensing certain controlled
// substances. The app cannot query the PDMP, so what it records is the
// clinician's attestation that they did — which is what a chart can honestly
// carry. A date is required with it: "I checked it" with no date is not a
// record of having checked it on this occasion.
const buildPdmpAttestation = ({ input, schedule, today }) => {
  if (!isControlled(schedule)) return { attestation: null };
  const i = (input && typeof input === 'object') ? input : {};
  const day = isYmd(today) ? String(today) : new Date().toISOString().slice(0, 10);
  if (!i.checked) {
    return {
      error: `A ${SCHEDULE_LABELS[schedule] || schedule} prescription requires an attestation that the Georgia PDMP was checked.`,
      code: 'PDMP_ATTESTATION_REQUIRED'
    };
  }
  const checkedOn = isYmd(i.checkedOn) ? String(i.checkedOn) : null;
  if (!checkedOn) {
    return { error: 'The date the Georgia PDMP was checked is required (YYYY-MM-DD)', code: 'PDMP_NO_DATE' };
  }
  if (checkedOn > day) {
    return { error: 'The PDMP check date cannot be in the future', code: 'PDMP_DATE_FUTURE' };
  }
  return { attestation: { checked: true, checkedOn, registry: 'Georgia PDMP', notes: String(i.notes || '').trim().slice(0, 300) || null } };
};

// ---- The rule ----------------------------------------------------------
// Order matters and it is deliberate: credential first (a missing credential is
// fail-closed and every other check would be reasoning about an unknown
// prescriber), then the declaration against the drug text, then the scope
// prohibition, then the DEA registration, then the PDMP.
//
// THE APRN EMERGENCY OPIOID EXCEPTION IS A DELIBERATE NON-BUILD. Georgia's sole
// statutory exception lets an APRN prescribe hydrocodone, oxycodone or compounds
// thereof in an emergency, capped at a 5-day initial supply, with the authority
// written into the protocol agreement and a DEA registration updated for it.
// It is narrow, it is rare in home-based primary care, and A WRONGLY GRANTED
// EXCEPTION IS WORSE THAN ROUTING TO A PHYSICIAN — the refusal tells the NP to
// route it to the collaborating physician, which is a working answer. Building
// the exception would mean the app deciding "is this an emergency", which it
// cannot, on the strength of a checkbox.
const evaluatePrescription = ({ user, drug, schedule, pdmp, today }) => {
  const credential = PRESCRIBER_CREDENTIALS.includes(String((user && user.prescriberCredential) || ''))
    ? String(user.prescriberCredential) : null;
  if (!credential) {
    return {
      ok: false, code: 'PRESCRIBER_CREDENTIAL_UNKNOWN',
      error: `${(user && user.name) || 'This prescriber'} has no prescriber credential on file (MD, DO, NP or PA). A prescription cannot be recorded until an admin sets it, because Georgia's scope rules differ by credential.`
    };
  }
  const declared = SCHEDULES.includes(String(schedule || '')) ? String(schedule) : null;
  if (!declared) {
    return {
      ok: false, code: 'RX_NO_SCHEDULE',
      error: `A schedule is required on every prescription — one of ${SCHEDULES.join(', ')}. There is no default; the clinician chooses.`
    };
  }

  // THE BACKSTOP. This catches the realistic failure, which is not a clinician
  // lying about a schedule — it is one not thinking of Adderall as Schedule II.
  const matched = matchScheduleTwoTerm(drug);
  if (matched && declared !== 'CII') {
    return {
      ok: false, code: 'SCHEDULE_MISMATCH', matchedTerm: matched,
      error: `"${matched}" is a Schedule II controlled substance, but this prescription is declared as ${SCHEDULE_LABELS[declared] || declared}. Correct the schedule, or correct the drug name if this is a different agent.`
    };
  }

  if (declared === 'CII' && SCHEDULE_II_PROHIBITED_CREDENTIALS.includes(credential)) {
    return {
      ok: false, code: 'APRN_SCHEDULE_II_PROHIBITED', prescriberCredential: credential,
      error: `A Georgia ${credential} may not prescribe a Schedule I or II substance. Route this prescription to the collaborating physician, who can record it under their own credential.`
    };
  }

  const dea = checkDeaAuthority({ user, schedule: declared, today });
  if (!dea.ok) return { ok: false, code: dea.code, error: dea.error, ...(dea.covers ? { covers: dea.covers } : {}) };

  const att = buildPdmpAttestation({ input: pdmp, schedule: declared, today });
  if (att.error) return { ok: false, code: att.code, error: att.error };

  return {
    ok: true,
    schedule: declared,
    prescriberCredential: credential,
    matchedTerm: matched || null,
    dea: dea.registration || null,
    pdmpAttestation: att.attestation
  };
};

// ---- Existing prescriptions (B6) ---------------------------------------
// A migration FLAGS every prescription with no schedule as 'unclassified'. It
// does NOT guess: a schedule inferred from a drug string and then stored looks
// exactly like one a clinician declared, and the whole point of the declaration
// is that a person made it. It does not block reading them either — the chart
// is the chart.
const UNCLASSIFIED = 'unclassified';
const applyPrescriptionScheduleMigration = (rows) => {
  const out = [];
  const flagged = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || typeof r !== 'object') { out.push(r); continue; }
    if (r.schedule) { out.push(r); continue; }
    out.push({ ...r, schedule: UNCLASSIFIED, scheduleClassifiedBy: 'migration_4_10' });
    flagged.push({ id: r.id, drug: r.drug || '(no drug)', date: r.date || null, clientId: r.clientId || null });
  }
  return { rows: out, flagged };
};
const buildUnclassifiedWarning = (flagged) => {
  const rows = Array.isArray(flagged) ? flagged : [];
  if (!rows.length) return null;
  return [
    `⚠️  SESSION 4.10 — ${rows.length} prescription${rows.length === 1 ? '' : 's'} predate the schedule field and are marked "unclassified".`,
    '   Nothing was guessed: a schedule inferred from a drug name and stored looks',
    '   identical to one a clinician declared. They are readable as they always were.',
    '   They are listed at Admin hub → Clinical → Unclassified prescriptions.'
  ].join('\n');
};

module.exports = {
  SCHEDULES, CONTROLLED_SCHEDULES, SCHEDULE_LABELS, isControlled,
  PRESCRIBER_CREDENTIALS, PRESCRIBER_CREDENTIAL_LABELS, SCHEDULE_II_PROHIBITED_CREDENTIALS,
  CII_TERMS, NOT_CII_TERMS, matchScheduleTwoTerm,
  DEA_SCHEDULES, normalizeDea, normalizeDeaSchedules, normalizeDeaRegistration, checkDeaAuthority,
  buildPdmpAttestation,
  evaluatePrescription,
  UNCLASSIFIED, applyPrescriptionScheduleMigration, buildUnclassifiedWarning
};
