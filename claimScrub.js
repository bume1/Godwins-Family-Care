'use strict';
// claimScrub.js — the claim scrub (AI coding pipeline spec, 2026-11-04, Phase 1).
//
// PURE. No I/O, no clock unless the caller omits `today`, no model. It takes an
// encounter with its charge lines, the patient's payer, the facility records,
// the rendering provider, the code catalog, the ICD-10 lookups and the NCCI/MUE
// tables, every one of them already loaded by the caller, and returns every
// finding it can make. Nothing is decided here about what to DO with a finding:
// the routes refuse a release while any `block` is open, and the review screens
// list every finding in full.
//
// A finding is { severity: 'block' | 'warn', code, message, field, fieldLabel }.
//   field       machine path of what the finding concerns ("lines[1].units")
//   fieldLabel  the same in words ("Line 2 (99350): units")
//
// HOUSE RULES THIS FILE FOLLOWS
//   - A fact the caller could not read is reported as NOT CHECKED and blocks.
//     It is never read as a pass (the ICD-10 lesson: an empty or absent signal
//     is not a diagnosis).
//   - A message states what the record does or does not say. It never tells
//     anyone what to document to reach a different code (spec, standing
//     constraints).
//   - Phase 'pre_post' runs before the lines exist in OpenEMR, so it has no
//     price to judge and makes no price finding. Phase 'final' runs against the
//     charge lines OpenEMR actually holds, prices included. That is the release
//     check, and it is the one that catches a Fee Sheet edited after signing.

const clinicalRepo = require('./clinicalRepository');
const codeCatalog = require('./codeCatalog');
const insurance = require('./insuranceEligibility');
const emLevels = require('./emLevels');
const chronicCare = require('./serviceRules/chronicCare');
const transitionalCare = require('./serviceRules/transitionalCare');
const remoteMonitoring = require('./serviceRules/remoteMonitoring');
const psychotherapy = require('./serviceRules/psychotherapy');
const addOnRules = require('./addOnRules');

const SEVERITY = Object.freeze({ BLOCK: 'block', WARN: 'warn' });
const PHASES = Object.freeze(['pre_post', 'final']);

const str = (v) => (v == null ? '' : String(v).trim());
const upper = (v) => str(v).toUpperCase();
const isYmd = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));

// ---- Identifier formats -----------------------------------------------------

// NPI: 10 digits, the last a Luhn check digit computed over "80840" + the first
// nine digits. Source: CMS, "Requirements for the NPI check digit",
// https://www.cms.gov/Regulations-and-Guidance/Administrative-Simplification/NationalProvIdentStand/Downloads/NPIcheckdigit.pdf
const isValidNpi = (v) => {
  const s = str(v);
  if (!/^\d{10}$/.test(s)) return false;
  const digits = `80840${s.slice(0, 9)}`.split('').map(Number);
  let sum = 0;
  // Double every second digit counting from the right of the 14 digits.
  for (let i = digits.length - 1, dbl = true; i >= 0; i--, dbl = !dbl) {
    let d = digits[i];
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  const check = (10 - (sum % 10)) % 10;
  return check === Number(s[9]);
};

// Federal EIN: nine digits, printed XX-XXXXXXX.
const normalizeEin = (v) => str(v).replace(/[\s-]/g, '');
const isValidEin = (v) => /^\d{9}$/.test(normalizeEin(v));

// Health care provider taxonomy code: ten characters, the last always "X"
// (NUCC code set, https://taxonomy.nucc.org/), e.g. 363LF0000X.
const isValidTaxonomy = (v) => /^[0-9]{3}[0-9A-Z]{6}X$/.test(upper(v));

// MBI: CMS's published 11-character format, implemented in
// insuranceEligibility.js (MBI_RE) from "Understanding the Medicare
// Beneficiary Identifier (MBI) Format",
// https://www.cms.gov/medicare/new-medicare-card/understanding-the-mbi-with-format.pdf
// Reused here rather than restated: two copies of a format drift.
const checkMbi = insurance.checkMbi;

// ---- Dates ------------------------------------------------------------------

// The same calendar date one year on. Feb 29 rolls to Mar 1, which errs toward
// treating the date as still inside the window for one day.
const plusOneYear = (ymd) => {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(y + 1, m - 1, d));
  return t.toISOString().slice(0, 10);
};

// ---- Finding helpers --------------------------------------------------------

const lineLabel = (line, i) => `Line ${i + 1}${line && line.code ? ` (${line.code})` : ''}`;

// Blockers first, then warnings; within each, the order the rules ran in.
const sortFindings = (findings) => {
  const rank = { block: 0, warn: 1 };
  return findings.map((f, i) => ({ f, i }))
    .sort((a, b) => (rank[a.f.severity] - rank[b.f.severity]) || (a.i - b.i))
    .map(x => x.f);
};

const countFindings = (findings) => ({
  block: findings.filter(f => f.severity === SEVERITY.BLOCK).length,
  warn: findings.filter(f => f.severity === SEVERITY.WARN).length
});

// ---- THE SCRUB --------------------------------------------------------------

const scrubClaim = (input = {}) => {
  const phase = PHASES.includes(input.phase) ? input.phase : 'pre_post';
  const today = isYmd(input.today) ? input.today : new Date().toISOString().slice(0, 10);
  const findings = [];
  const add = (severity, code, field, fieldLabel, message) => findings.push({ severity, code, field, fieldLabel, message });
  const block = (...a) => add(SEVERITY.BLOCK, ...a);
  const warn = (...a) => add(SEVERITY.WARN, ...a);

  const enc = input.encounter || {};
  const lines = Array.isArray(input.lines) ? input.lines.filter(Boolean) : [];
  const diagnoses = Array.isArray(input.diagnoses) ? input.diagnoses.filter(Boolean) : [];
  const dxCodes = new Set(diagnoses.map(d => upper(d.code)));

  // 1. The billing facility: NPI, federal EIN, taxonomy.
  const bf = input.billingFacility;
  if (!bf || !bf.id) {
    block('BILLING_FACILITY_UNKNOWN', 'billingFacility', 'Billing facility',
      `The billing facility could not be resolved${bf && bf.error ? ` (${bf.error})` : ''}. Its NPI, EIN and taxonomy cannot be checked.`);
  } else if (!bf.fieldsRead) {
    block('BILLING_FACILITY_NOT_READ', 'billingFacility', `Billing facility (${bf.name || bf.id})`,
      `The app's copy of OpenEMR's facility list does not include the NPI, EIN and taxonomy fields, so they cannot be checked. An admin presses Sync facilities on the coding queue.`);
  } else {
    const name = bf.name || bf.id;
    if (!str(bf.npi)) block('BILLING_FACILITY_NPI', 'billingFacility.npi', `Billing facility (${name}): NPI`, `The billing facility has no NPI on its OpenEMR facility record.`);
    else if (!isValidNpi(bf.npi)) block('BILLING_FACILITY_NPI', 'billingFacility.npi', `Billing facility (${name}): NPI`, `The billing facility's NPI "${str(bf.npi)}" is not a valid NPI (10 digits with a valid check digit).`);
    if (!str(bf.ein)) block('BILLING_FACILITY_EIN', 'billingFacility.ein', `Billing facility (${name}): federal EIN`, `The billing facility has no federal EIN on its OpenEMR facility record.`);
    else if (!isValidEin(bf.ein)) block('BILLING_FACILITY_EIN', 'billingFacility.ein', `Billing facility (${name}): federal EIN`, `The billing facility's federal EIN "${str(bf.ein)}" is not nine digits.`);
    if (!str(bf.taxonomy)) block('BILLING_FACILITY_TAXONOMY', 'billingFacility.taxonomy', `Billing facility (${name}): taxonomy`, `The billing facility has no taxonomy code on its OpenEMR facility record.`);
    else if (!isValidTaxonomy(bf.taxonomy)) block('BILLING_FACILITY_TAXONOMY', 'billingFacility.taxonomy', `Billing facility (${name}): taxonomy`, `The billing facility's taxonomy "${str(bf.taxonomy)}" is not a valid taxonomy code (ten characters ending in X).`);
  }

  // 2. The rendering provider's individual NPI.
  const rp = input.renderingProvider || {};
  const rpName = rp.name || 'the rendering provider';
  if (!str(rp.npi)) block('RENDERING_PROVIDER_NPI', 'renderingProvider.npi', `Rendering provider (${rpName}): NPI`, `${rpName} has no individual NPI on file.`);
  else if (!isValidNpi(rp.npi)) block('RENDERING_PROVIDER_NPI', 'renderingProvider.npi', `Rendering provider (${rpName}): NPI`, `${rpName}'s NPI "${str(rp.npi)}" is not a valid NPI (10 digits with a valid check digit).`);

  // 3. The encounter's facility, and a place of service derived from it.
  const facts = enc.facts || null;
  if (!facts || !facts.checked) {
    block('ENCOUNTER_FACILITY_NOT_CHECKED', 'encounter.facility', 'Encounter: facility and place of service',
      `The encounter has not been read from OpenEMR${facts && facts.error ? ` (${facts.error})` : ''}, so its facility and place of service are unconfirmed.`);
  } else if (!str(facts.facilityId)) {
    block('ENCOUNTER_NO_FACILITY', 'encounter.facility', 'Encounter: facility', 'The encounter in OpenEMR has no facility.');
  } else {
    const fr = input.encounterFacility;
    const frName = (fr && fr.name) || facts.facilityName || `facility ${facts.facilityId}`;
    if (input.facilityListKnown && !fr) {
      block('ENCOUNTER_FACILITY_UNKNOWN', 'encounter.facility', 'Encounter: facility',
        `The encounter's facility (id ${facts.facilityId}) is not in OpenEMR's facility list.`);
    } else if (fr && !str(fr.pos_code)) {
      block('FACILITY_NO_POS', 'encounter.posCode', `Encounter: place of service`,
        `${frName} has no place of service on its OpenEMR facility record, so none can be derived for the encounter.`);
    }
    if (!str(facts.posCode)) {
      block('ENCOUNTER_NO_POS', 'encounter.posCode', 'Encounter: place of service', 'The encounter in OpenEMR has no place of service.');
    } else if (fr && str(fr.pos_code) && str(fr.pos_code) !== str(facts.posCode)) {
      block('POS_NOT_FROM_FACILITY', 'encounter.posCode', 'Encounter: place of service',
        `The encounter's place of service (${str(facts.posCode)}) is not the one on its facility record (${frName}, ${str(fr.pos_code)}). The place of service comes from the facility, never typed on the encounter.`);
    } else if (!input.facilityListKnown) {
      block('ENCOUNTER_FACILITY_NOT_CHECKED', 'encounter.posCode', 'Encounter: place of service',
        `OpenEMR's facility list is not available, so the place of service (${str(facts.posCode)}) cannot be checked against the facility record.`);
    }
  }

  // 4. Diagnoses and charge lines.
  if (!diagnoses.length) block('CLAIM_NO_DIAGNOSIS', 'diagnoses', 'Diagnoses', 'The encounter has no diagnosis.');
  if (!lines.length) block('CLAIM_NO_LINES', 'lines', 'Charge lines', 'The encounter has no charge lines.');

  const catalog = input.catalog;
  const catalogLoaded = codeCatalog.isLoaded(catalog);
  if (!catalogLoaded) {
    block('CODE_CATALOG_NOT_LOADED', 'catalog', 'OpenEMR code catalog',
      `OpenEMR's code catalog has never been cached, so no line's code can be checked against it. An admin presses Refresh Catalog.`);
  } else if (codeCatalog.isStale(catalog, input.now)) {
    warn('CODE_CATALOG_STALE', 'catalog', 'OpenEMR code catalog',
      `The code catalog is stale: last refreshed ${catalog.fetchedAt}. Lines are checked against that copy.`);
  }

  const pointed = new Set();
  lines.forEach((line, i) => {
    const label = lineLabel(line, i);
    const links = (Array.isArray(line.dxLinks) ? line.dxLinks : []).map(upper).filter(Boolean);
    if (!links.length) {
      block('LINE_NO_DIAGNOSIS', `lines[${i}].dxLinks`, `${label}: diagnosis pointer`, `${label} points at no diagnosis.`);
    }
    for (const l of links) {
      if (!dxCodes.has(l)) block('LINE_DX_NOT_ON_ENCOUNTER', `lines[${i}].dxLinks`, `${label}: diagnosis pointer`, `${label} points at ${l}, which is not a diagnosis on this encounter.`);
      else pointed.add(l);
    }
    if (catalogLoaded) {
      const state = codeCatalog.lookupCode(catalog, line.code);
      if (state === 'missing') block('LINE_CODE_MISSING', `lines[${i}].code`, `${label}: code`, `${upper(line.code) || 'The code'} is not in OpenEMR's code table.`);
      else if (state === 'inactive') block('LINE_CODE_INACTIVE', `lines[${i}].code`, `${label}: code`, `${upper(line.code)} is inactive in OpenEMR's code table.`);
    }
    if (phase === 'final') {
      const fee = line.fee;
      if (fee == null || fee === '' || !Number.isFinite(Number(fee))) {
        block('LINE_PRICE_UNKNOWN', `lines[${i}].fee`, `${label}: price`, `OpenEMR reports no price for ${label}.`);
      } else if (Number(fee) <= 0) {
        block('LINE_PRICE_ZERO', `lines[${i}].fee`, `${label}: price`, `${label} carries a price of $${Number(fee).toFixed(2)}. OpenEMR has no price for this code at the patient's price level.`);
      }
    }
  });

  // Every diagnosis a line points at: in OpenEMR's ICD-10 table, and flagged
  // when it is unspecified and OpenEMR lists a more specific code beside it.
  const icd = input.icd10 || {};
  for (const code of pointed) {
    const look = icd[code];
    const label = `Diagnosis ${code}`;
    if (!look) {
      block('DX_NOT_CHECKED', `diagnoses.${code}`, label, `${code} has not been checked against OpenEMR's ICD-10 table.`);
    } else if (!look.exists) {
      block('DX_NOT_IN_ICD10', `diagnoses.${code}`, label, `${code} is not in OpenEMR's ICD-10 table.`);
    } else if (look.unspecified && Array.isArray(look.moreSpecific) && look.moreSpecific.length) {
      const shown = look.moreSpecific.slice(0, 3);
      warn('DX_UNSPECIFIED', `diagnoses.${code}`, label,
        `${code} is an unspecified code. OpenEMR lists more specific codes in the same category (${shown.join(', ')}${look.moreSpecific.length > shown.length ? ', …' : ''}).`);
    }
  }

  // 5. NCCI PTP and MUE, re-run here against THIS charge set. A stale dataset is
  // always stated, with the date it was last loaded, whether or not there are
  // lines to check.
  const ncci = input.ncci || {};
  const stale = clinicalRepo.ncciStaleness(ncci.sourceVersion);
  if (stale) {
    const v = clinicalRepo.normalizeNcciSourceVersion(ncci.sourceVersion);
    const when = (h) => (h.quarter === 'UNLOADED' ? 'never loaded' : `${h.quarter}, loaded ${h.loadedAt || 'on an unknown date'}`);
    block('NCCI_DATA_STALE', 'ncci', 'NCCI/MUE reference data',
      `The NCCI/MUE reference data is stale (PTP: ${when(v.ptp)}; MUE: ${when(v.mue)}). Pairs and units cannot be checked until scripts/load_ncci_tables.js runs.`);
  } else if (lines.length) {
    const asServices = lines.map(l => ({ code: upper(l.code), units: l.units, modifiers: Array.isArray(l.modifiers) ? l.modifiers : [] }));
    const r = clinicalRepo.checkNcciBundling(asServices, enc.visit || null, { ptpEdits: ncci.ptpEdits, mueByCode: ncci.mueByCode, sourceVersion: ncci.sourceVersion });
    const d = r.details || {};
    for (const [a, b] of d.blocked || []) {
      block('NCCI_PTP_BLOCKED', 'lines', `Lines ${a} and ${b}`, `${a} and ${b} cannot be billed together on one date (NCCI PTP, modifier indicator 0). No modifier resolves this pair.`);
    }
    for (const [a, b] of d.modifierNeeded || []) {
      block('NCCI_PTP_MODIFIER_REQUIRED', 'lines', `Lines ${a} and ${b}`, `${a} and ${b} are an NCCI PTP pair (modifier indicator 1) and neither line carries an unbundling modifier.`);
    }
    for (const [a, b] of d.flagged || []) {
      warn('NCCI_PTP_MODIFIER_PRESENT', 'lines', `Lines ${a} and ${b}`, `${a} and ${b} are an NCCI PTP pair (modifier indicator 1) billed together under an unbundling modifier. The record must show the services were separately identifiable.`);
    }
    const lineIndexOf = (code) => lines.findIndex(l => upper(l.code) === code);
    for (const m of d.mueExceeded || []) {
      const i = lineIndexOf(m.code);
      block('MUE_ABSOLUTE', `lines[${i}].units`, `${lineLabel(lines[i], i)}: units`,
        `${m.code} is billed at ${m.units} units, over its MUE of ${m.cap}${m.mai ? ` (MAI ${m.mai})` : ' (MAI unknown, treated as absolute)'}. ${m.mai === '2' ? 'MAI 2 is an absolute limit that documentation cannot exceed.' : 'An MUE whose adjudication indicator is unknown is treated as absolute.'}`);
    }
    for (const m of d.mueOverDocumentable || []) {
      const i = lineIndexOf(m.code);
      warn('MUE_DOCUMENTATION_REQUIRED', `lines[${i}].units`, `${lineLabel(lines[i], i)}: units`,
        `${m.code} is billed at ${m.units} units, over its MUE of ${m.cap} (MAI ${m.mai}). MAI ${m.mai} can be exceeded when the record supports it; the documentation supporting the extra units must be on file.`);
    }
  }

  // 6. The patient's insurance.
  const payer = input.payer || null;
  if (input.payerProblem) {
    block('PATIENT_PAYER_UNRESOLVED', 'patient.insurance', 'Patient insurance', str(input.payerProblem));
  } else if (!payer) {
    block('PATIENT_NO_INSURANCE', 'patient.insurance', 'Patient insurance', 'No primary payer is on file for the patient.');
  } else if (payer.kind !== 'private_pay') {
    const pname = payer.payerName || 'The primary payer';
    if (!str(payer.memberId)) {
      block('PATIENT_NO_POLICY_NUMBER', 'patient.insurance.policyNumber', `Patient insurance (${pname}): policy number`, `${pname} has no policy or member number on file.`);
    } else if (payer.kind === 'medicare_ffs') {
      const mbi = checkMbi(payer.memberId);
      if (mbi.valid !== true) {
        block('PATIENT_MBI_FORMAT', 'patient.insurance.policyNumber', 'Patient insurance (Medicare): MBI',
          `The Medicare number "${mbi.value}" does not match CMS's 11-character MBI format.`);
      }
    }
  }

  // 7. Date of service: not in the future, and within twelve months.
  const dos = str(enc.date).slice(0, 10);
  if (!isYmd(dos)) {
    block('DOS_MISSING', 'encounter.date', 'Date of service', 'The encounter has no date of service.');
  } else if (dos > today) {
    block('DOS_FUTURE', 'encounter.date', 'Date of service', `The date of service (${dos}) is in the future.`);
  } else if (today > plusOneYear(dos)) {
    block('DOS_OUTSIDE_12_MONTHS', 'encounter.date', 'Date of service', `The date of service (${dos}) is more than twelve months ago.`);
  }

  // ---- Warnings that release but are surfaced ----

  // Modifier 25 with no other billable service on the same date.
  const sameDay = (Array.isArray(input.sameDayOtherCodes) ? input.sameDayOtherCodes : []).map(upper).filter(Boolean);
  lines.forEach((line, i) => {
    const mods = (Array.isArray(line.modifiers) ? line.modifiers : []).map(upper);
    if (!mods.includes('25')) return;
    const others = lines.some((l, j) => j !== i && upper(l.code) && upper(l.code) !== upper(line.code)) || sameDay.length > 0;
    if (!others) {
      warn('MODIFIER_25_ALONE', `lines[${i}].modifiers`, `${lineLabel(line, i)}: modifier 25`,
        `${lineLabel(line, i)} carries modifier 25, and no other billable service is recorded for this patient on the same date.`);
    }
  });

  // The selected E/M level is the highest in its family.
  lines.forEach((line, i) => {
    if (!emLevels.isHighestInFamily(line.code)) return;
    const fam = emLevels.familyOf(line.code);
    warn('EM_HIGHEST_LEVEL', `lines[${i}].code`, `${lineLabel(line, i)}: E/M level`,
      `${upper(line.code)} is the highest level in its family (${fam.label}). Not wrong; worth a second look against the note.`);
  });

  // ---- Cross-family rules that block (spec 3b.4) ----
  // `sameMonthOtherLines` are this patient's other encounters' lines in the
  // same calendar month: { code, renderingProviderId }. The month stands in for
  // RPM's 30-day period, which the app does not track by device.
  const here = lines.map(l => upper(l.code));
  const monthOthers = (Array.isArray(input.sameMonthOtherLines) ? input.sameMonthOtherLines : []).filter(Boolean);
  const monthAll = [...here, ...monthOthers.map(o => upper(o.code))];
  const rpId = input.renderingProviderId || null;
  const sameProvider = [...here, ...monthOthers.filter(o => rpId && o.renderingProviderId === rpId).map(o => upper(o.code))];
  const apcmBase = [chronicCare.APCM.low, chronicCare.APCM.multi, chronicCare.APCM.multiQmb];
  const families = [
    ['APCM', apcmBase], ['CCM', chronicCare.CCM_CODES], ['TCM', transitionalCare.CODES]
  ].filter(([, codes]) => sameProvider.some(c => codes.includes(c)));
  if (families.length > 1 && here.some(c => [...apcmBase, ...chronicCare.CCM_CODES, ...transitionalCare.CODES].includes(c))) {
    block('CARE_MANAGEMENT_SAME_MONTH', 'lines', 'Care management this month',
      `${families.map(([n]) => n).join(' and ')} are billed for this patient in the same month by the same practitioner. APCM, CCM and TCM cannot be billed together that way.`);
  }
  const addOns = here.filter(c => chronicCare.APCM_ADD_ONS.includes(c));
  if (addOns.length && !monthAll.some(c => apcmBase.includes(c))) {
    block('APCM_ADD_ON_WITHOUT_BASE', 'lines', 'APCM behavioral add-on',
      `${addOns.join(', ')} ${addOns.length === 1 ? 'is an APCM behavioral add-on' : 'are APCM behavioral add-ons'}, and no base APCM code is billed for this patient this month.`);
  }
  const pairs = [
    [remoteMonitoring.RPM.supply.full, remoteMonitoring.RPM.supply.short, 'for the same device in the same 30-day period'],
    [remoteMonitoring.RTM.supply.musculoskeletal.full, remoteMonitoring.RTM.supply.musculoskeletal.short, 'for the same device in the same 30-day period'],
    [remoteMonitoring.RPM.management.brief, remoteMonitoring.RPM.management.base, 'in the same month; they are not additive, one is chosen by the month\'s total minutes']
  ];
  for (const [a, b, why] of pairs) {
    if ((here.includes(a) || here.includes(b)) && monthAll.includes(a) && monthAll.includes(b)) {
      block('MUTUALLY_EXCLUSIVE_SAME_PERIOD', 'lines', `Lines ${a} and ${b}`, `${a} and ${b} cannot both be billed ${why}.`);
    }
  }
  // A psychotherapy add-on and an E/M may not claim more minutes together than
  // the encounter's documented total. Psychotherapy minutes are documented
  // separately; a missing one is NOT CHECKED and blocks.
  const psyAddOn = here.find(c => psychotherapy.ADD_ONS.includes(c));
  if (psyAddOn && here.some(c => emLevels.isEmCode(c))) {
    const psy = Number(input.psychotherapyMinutes);
    const total = Number(input.totalMinutes);
    if (!Number.isFinite(psy) || psy <= 0) {
      block('PSYCHOTHERAPY_TIME_NOT_RECORDED', 'psychotherapyMinutes', 'Psychotherapy time',
        `${psyAddOn} is billed with an E/M, and no psychotherapy minutes are recorded separately from the E/M time, so the two cannot be checked against the total.`);
    } else if (!Number.isFinite(total) || total <= 0) {
      block('TOTAL_TIME_NOT_RECORDED', 'totalMinutes', 'Total time', `${psyAddOn} is billed with an E/M, and the encounter has no total time to check them against.`);
    } else {
      const der = input.emDerivation;
      const emMinutes = der && der.finalBasis === 'time' && der.time ? Number(der.time.minutes) : 0;
      if (psy + emMinutes > total || psy > total) {
        block('TIME_COUNTED_TWICE', 'psychotherapyMinutes', 'Psychotherapy and E/M time',
          `${psy} psychotherapy minutes${emMinutes ? ` and ${emMinutes} E/M minutes` : ''} come to more than the ${total} minutes documented for the encounter.`);
      }
    }
  }

  // The derived level (Phase 3). An open LEVEL_AMBIGUOUS flag is the coder's to
  // work, stated in full: both candidates and what the note does not say. A
  // billed E/M line that is not the confirmed level is surfaced too. Neither
  // blocks: the claim releases at the lower level, and a corrected claim can be
  // filed inside the twelve-month window once the flag is resolved.
  const der = input.emDerivation;
  if (der && der.flag && !der.flag.resolvedAt) {
    const cands = (der.flag.candidates || []).map(c => `${c.code} by ${c.basis === 'time' ? `time (${c.minutes} minutes)` : `medical decision making (${c.mdm})`}`).join('; ');
    const absent = (der.flag.absent || []).join(' ');
    warn('LEVEL_AMBIGUOUS', 'emDerivation', 'E/M level review',
      `The level is flagged for review. Candidates: ${cands}. Coded at ${der.finalCode}.${absent ? ` ${absent}` : ''}`);
  }
  if (der && der.finalCode) {
    const billedEm = lines.map(l => upper(l.code)).filter(c => emLevels.isEmCode(c));
    if (billedEm.length && !billedEm.includes(upper(der.finalCode))) {
      warn('EM_DIFFERS_FROM_DERIVED', 'lines', 'E/M level',
        `The E/M line billed (${billedEm.join(', ')}) is not the level derived from the clinician's confirmed facts (${der.finalCode}).`);
    } else if (!billedEm.length && lines.length) {
      warn('EM_DIFFERS_FROM_DERIVED', 'lines', 'E/M level', `The clinician's confirmed facts derive ${der.finalCode}, and no E/M line is billed.`);
    }
  }

  // ---- Add-on codes and modifiers (Phase 4.2). Offers are returned beside
  // the findings and are never applied by anything.
  const addOn = addOnRules.evaluate({
    lines, visit: enc.visit || null, emDerivation: input.emDerivation || null,
    totalMinutes: input.totalMinutes, continuingCare: !!input.continuingCare,
    justifications: input.modifierJustifications || {}, tcm: input.tcm || null,
    priorAwvDates: input.priorAwvDates || [], dos, sameDayOtherCodes: input.sameDayOtherCodes || []
  });
  findings.push(...addOn.findings);

  const sorted = sortFindings(findings);
  const counts = countFindings(sorted);
  return { phase, findings: sorted, counts, ok: counts.block === 0, offers: addOn.offers };
};

// ---- ICD-10 lookups -----------------------------------------------------------
// Built from OpenEMR's own code search (the caller runs it with a person's
// session). `exact` is the search for the code itself; `category` is the search
// for its parent (the code less its last character). Nothing here guesses.

const isUnspecifiedText = (t) => /\bunspecified\b/i.test(String(t || ''));
const parentOf = (code) => {
  const c = clinicalRepo.normalizeIcd10(code);
  if (!c) return null;
  const p = c.slice(0, -1).replace(/\.$/, '');
  return p.length >= 3 ? p : null;
};
const buildIcd10Lookup = (code, exactRows, categoryRows) => {
  const c = clinicalRepo.normalizeIcd10(code);
  const rows = (r) => (Array.isArray(r) ? r : []).map(x => ({ code: clinicalRepo.normalizeIcd10(x && x.code), text: str(x && (x.code_text || x.description)) })).filter(x => x.code);
  const hit = rows(exactRows).find(x => x.code === c) || rows(categoryRows).find(x => x.code === c);
  if (!hit) return { exists: false, description: null, unspecified: false, moreSpecific: [] };
  const parent = parentOf(c);
  const unspecified = isUnspecifiedText(hit.text);
  const seen = new Set();
  const moreSpecific = unspecified && parent
    ? rows(categoryRows).filter(x => x.code !== c && x.code.replace('.', '').startsWith(parent.replace('.', '')) && !isUnspecifiedText(x.text))
      .map(x => x.code).filter(x => !seen.has(x) && seen.add(x))
    : [];
  return { exists: true, description: hit.text || null, unspecified, moreSpecific };
};

// ---- Where an encounter sits in the hold queue ----------------------------------
// awaiting_billing: signed, codes not yet submitted (the biller's worklist).
// held:             submitted and posted, not yet released by a person.
// released:         a person released it after a clean final scrub.
const holdState = (record, billingStatus) => {
  const BS = clinicalRepo.BILLING_STATUS;
  if (billingStatus === BS.AWAITING_BILLING) return 'awaiting_billing';
  if (billingStatus === BS.BILLED) return record && record.claimRelease && record.claimRelease.at ? 'released' : 'held';
  return null;
};

// OpenEMR's posted billing rows → scrub lines. Only CPT4/HCPCS rows are charge
// lines; the ICD10 rows OpenEMR also keeps on the encounter are its pointers.
// `justify` comes back X12-shaped ("ICD10|E11.9:ICD10|I10:").
const linesFromCharges = (rows) => (Array.isArray(rows) ? rows : [])
  .filter(r => r && ['CPT4', 'HCPCS'].includes(upper(r.code_type)))
  .map(r => {
    const units = parseInt(r.units, 10);
    const fee = r.fee == null || r.fee === '' || !Number.isFinite(Number(r.fee)) ? null : Number(r.fee);
    return {
      code: upper(r.code),
      modifiers: upper(r.modifier).split(':').map(s => s.trim()).filter(Boolean),
      units: Number.isInteger(units) && units > 0 ? units : 1,
      dxLinks: String(r.justify || '').split(':').map(p => p.replace(/^ICD10\|/i, '')).map(c => clinicalRepo.normalizeIcd10(c)).filter(Boolean),
      fee
    };
  });

module.exports = {
  SEVERITY, PHASES,
  isValidNpi, isValidEin, isValidTaxonomy, normalizeEin,
  scrubClaim, sortFindings, countFindings,
  isUnspecifiedText, parentOf, buildIcd10Lookup,
  holdState, linesFromCharges
};

// ---- Documentation gate (spec §1.4) ---------------------------------------------
// An encounter enters the coding queue only with a total time in minutes for the
// date of service (a number, never prose), at least one diagnosis, and a signed
// or sign-ready note. Pure: the middleware in server.js loads, this decides.
const TOTAL_MINUTES_MAX = 24 * 60;
const parseTotalMinutes = (v) => {
  const s = str(v);
  if (!/^\d{1,4}$/.test(s)) return { ok: false, error: 'Total time must be a whole number of minutes, like 45.' };
  const n = Number(s);
  if (n < 1 || n > TOTAL_MINUTES_MAX) return { ok: false, error: `Total time must be between 1 and ${TOTAL_MINUTES_MAX} minutes.` };
  return { ok: true, minutes: n };
};
const hasWords = (v) => {
  if (v == null) return false;
  if (typeof v === 'string') return /[A-Za-z0-9]/.test(v);
  if (Array.isArray(v)) return v.some(hasWords);
  if (typeof v === 'object') return Object.values(v).some(hasWords);
  return false;
};
const GATE_ITEMS = Object.freeze({
  total_time: 'a total time in minutes for the date of service',
  diagnosis: 'at least one ICD-10 diagnosis',
  note: 'a signed or sign-ready note'
});
// noteState: 'signed' (an author already signed it) | 'draft' (being signed now).
const documentationGate = ({ record, totalMinutes, noteState }) => {
  const missing = [];
  if (!(Number.isInteger(totalMinutes) && totalMinutes > 0)) missing.push('total_time');
  if (!((record && record.diagnoses) || []).length) missing.push('diagnosis');
  const noteOk = noteState === 'signed' || !!(record && (record.narrativeNoteSid || hasWords(record.note)));
  if (!noteOk) missing.push('note');
  if (!missing.length) return { ok: true, missing: [] };
  const words = missing.map(k => GATE_ITEMS[k]);
  const list = words.length === 1 ? words[0] : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
  return { ok: false, missing, error: `This visit cannot go to the coding queue yet. It needs ${list}.` };
};

module.exports.TOTAL_MINUTES_MAX = TOTAL_MINUTES_MAX;
module.exports.parseTotalMinutes = parseTotalMinutes;
module.exports.documentationGate = documentationGate;
module.exports.GATE_ITEMS = GATE_ITEMS;
module.exports.hasWords = hasWords;
