// ============================================================================
// insuranceEligibility.js — ONE idea of who pays (B1, 2026-10-13).
//
// THE PROBLEM THIS REPLACES. The app spelled the payer four ways: the intake's
// structured blocks (medicare.id, medicaid.memberId…), the intake's payerType
// LABELS ('Medicare Part B', 'Dual eligible'), the payer summary's CODES
// (server.js ENUM.payerType → 'medicare_b', 'combination') and whatever each
// consumer happened to accept. `isMedicarePatient` accepted 'medicare' and
// 'medicare_advantage' and never 'medicare_b', and its two fallbacks read
// `intake.insurance.insuranceTypes` (intake fields are stored FLAT, so that
// object never exists) and `payer.primaryName` (nothing writes it). For a real
// record it answered false for every Medicare patient.
//
// So: every consumer asks THIS module, and nothing parses a raw payer string
// anywhere else. Stored records are read tolerantly through one translation
// table; nothing is migrated or rewritten in place.
//
// WHAT THIS MODULE DOES NOT DO, ON PURPOSE:
//   - No X12. Not a 270, not a 271, not ever. The biller checks eligibility in
//     the Availity portal (later through OpenEMR's own X12) and records five
//     typed facts here.
//   - No payer ids. Plan name → payer id is OpenEMR's insurance-company table.
//     The only id the app ever handles is OpenEMR's own company ROW id, picked
//     by the biller from OpenEMR's list at verification time.
//   - QMB is STATED, never inferred. Every QMB is dual eligible; not every
//     dual is QMB, and telling a biller "this patient cannot be billed" on a
//     guess is as wrong as missing it.
//   - Nothing auto-verifies and nothing auto-expires. A person states a fact;
//     a clock does not un-state it. Age is SHOWN, never enforced.
//   - Never blocks clinical work. An insurance problem blocks the CLAIM (the
//     billing gate) and a copay STATEMENT (QMB); never scheduling, a visit or
//     a signature.
// ============================================================================

const KINDS = Object.freeze([
  'medicare_ffs', 'medicare_advantage', 'medicaid', 'medicaid_mco',
  'commercial', 'va', 'ltc', 'private_pay'
]);
const KIND_LABELS = Object.freeze({
  medicare_ffs: 'Original Medicare', medicare_advantage: 'Medicare Advantage',
  medicaid: 'Medicaid', medicaid_mco: 'Medicaid managed care', commercial: 'Commercial insurance',
  va: 'VA', ltc: 'Long-term care insurance', private_pay: 'Private pay'
});
const MEDICARE_KINDS = Object.freeze(['medicare_ffs', 'medicare_advantage']);
// Kinds the practice sends a claim to. LTC reimburses the client and private
// pay is the client, so neither is a claim payer unless somebody ranks it.
const CLAIM_KINDS = Object.freeze(['medicare_ffs', 'medicare_advantage', 'medicaid', 'medicaid_mco', 'commercial', 'va']);

const RANKS = Object.freeze(['primary', 'secondary', 'tertiary', 'not_billed']);
const RANK_LABELS = Object.freeze({ primary: 'Primary', secondary: 'Secondary', tertiary: 'Tertiary', not_billed: 'Not billed' });
const QMB_VALUES = Object.freeze(['yes', 'no', 'unknown']);
const VERIFICATION_STATUSES = Object.freeze(['unverified', 'verified', 'mismatch', 'inactive']);
const VERIFICATION_METHODS = Object.freeze(['availity_portal', 'x12_270']);
const NOTE_MAX = 240;

// The payer blocks intake collects, in the order a rank is inferred.
const BLOCKS = Object.freeze(['medicare', 'medicaid', 'commercial', 'ltc']);

// ---- The Medicare Beneficiary Identifier ----------------------------------
// 11 characters, fixed positions:
//   1 numeric 1-9 · 2 letter · 3 letter/digit · 4 digit · 5 letter
//   6 letter/digit · 7 digit · 8 letter · 9 letter · 10 digit · 11 digit
// Letters EXCLUDE S, L, O, I, B and Z everywhere, because they are read as
// 5, 1, 0, 1, 8 and 2. CMS publishes this format; it is not a checksum, so a
// well-formed MBI can still belong to somebody else. That is what the
// eligibility check is for.
const MBI_LETTER = '[ACDEFGHJKMNPQRTUVWXY]';
const MBI_ALNUM = '[ACDEFGHJKMNPQRTUVWXY0-9]';
const MBI_RE = new RegExp(`^[1-9]${MBI_LETTER}${MBI_ALNUM}[0-9]${MBI_LETTER}${MBI_ALNUM}[0-9]${MBI_LETTER}${MBI_LETTER}[0-9][0-9]$`);

// Upper case, spaces and hyphens stripped. Cards print "1EG4-TE5-MK72".
const normalizeMbi = (v) => String(v == null ? '' : v).toUpperCase().replace(/[\s-]/g, '');

// Never refuses. A staff member transcribing a smudged card must be able to
// save what they have and fix it later; the validity is reported, not enforced.
const checkMbi = (v) => {
  const value = normalizeMbi(v);
  if (!value) return { value: '', valid: null, message: null };
  if (MBI_RE.test(value)) return { value, valid: true, message: null };
  const bad = value.match(/[SLOIBZ]/);
  const message = value.length !== 11
    ? `A Medicare number is 11 characters; this one has ${value.length}. It was saved, so it can be fixed later.`
    : bad
      ? `A Medicare number never uses the letter ${bad[0]} (it is easy to mix up with a number). Check the card. It was saved, so it can be fixed later.`
      : 'That does not look like a Medicare number. Check it against the card. It was saved, so it can be fixed later.';
  return { value, valid: false, message };
};

// ---- Small readers ---------------------------------------------------------
const str = (v) => (v == null ? '' : String(v).trim());
const ymd = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(str(v)) ? str(v) : null);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

// The intake rank select stores labels; a stored code is read too.
const readRank = (v) => {
  const s = str(v).toLowerCase().replace(/[\s-]+/g, '_');
  if (!s) return null;
  if (RANKS.includes(s)) return s;
  if (s === 'not_billed_by_gfc' || s === 'do_not_bill') return 'not_billed';
  return null;
};

// QMB: what somebody SAID. 'Yes'/'No'/'Unknown' labels from intake, a code, or
// a boolean somebody wrote onto the payer summary. Absent is 'unknown'.
const readQmb = (client) => {
  const c = client || {};
  const intake = obj(c.intake);
  const raw = intake.qmb !== undefined && intake.qmb !== '' && intake.qmb !== null ? intake.qmb : obj(c.payer).qmb;
  if (raw === true) return 'yes';
  if (raw === false) return 'no';
  const s = str(raw).toLowerCase();
  if (s === 'yes' || s.startsWith('yes')) return 'yes';
  if (s === 'no' || s.startsWith('no')) return 'no';
  return 'unknown';
};

// ---- THE ONE TRANSLATION TABLE ---------------------------------------------
// Every payer string the repo has ever produced or accepted. `null` means the
// string describes a SITUATION, not a payer, and the blocks must say who pays.
// Producer of the codes: server.js ENUM.payerType ('Medicare Part B' →
// 'medicare_b', 'Dual eligible' and 'Combination' → 'combination', …). The
// enrollment screen's old free-text box is why lower-case words appear too.
const LEGACY_TO_KIND = Object.freeze({
  // codes (server.js ENUM.payerType and the profile schema)
  medicare_b: 'medicare_ffs', private_pay: 'private_pay', ltc_insurance: 'ltc',
  medicaid_waiver: 'medicaid', va: 'va', combination: null,
  // codes the old isMedicarePatient accepted
  medicare: 'medicare_ffs', medicare_advantage: 'medicare_advantage', medicareadvantage: 'medicare_advantage', ma: 'medicare_advantage',
  // canonical kinds read as themselves
  medicare_ffs: 'medicare_ffs', medicaid: 'medicaid', medicaid_mco: 'medicaid_mco', commercial: 'commercial', ltc: 'ltc',
  // intake payerType labels (public/intake-fields.js OPTIONS.payerType)
  'private pay': 'private_pay', 'ltc insurance': 'ltc', 'medicaid waiver': 'medicaid',
  'medicare part b': 'medicare_ffs', 'dual eligible': null, 'combination': null,
  // intake insuranceTypes labels (OPTIONS.insuranceTypes)
  'medicare part a & b': 'medicare_ffs', 'medicare advantage': 'medicare_advantage',
  'va benefits': 'va', 'commercial insurance': 'commercial', 'managed care organization': 'medicaid_mco',
  'long-term care insurance': 'ltc', 'private pay only': 'private_pay',
  // medicare.type labels (OPTIONS.medicareType)
  'part a & b': 'medicare_ffs', 'medicare advantage (part c)': 'medicare_advantage'
});
const kindFromLegacy = (s) => {
  const k = str(s).toLowerCase();
  if (!k) return undefined;
  return Object.prototype.hasOwnProperty.call(LEGACY_TO_KIND, k) ? LEGACY_TO_KIND[k] : undefined;
};
// A situation label: the payer is "more than one", and the blocks say which.
const SITUATIONS = Object.freeze(['combination', 'dual eligible']);
const isSituation = (s) => SITUATIONS.includes(str(s).toLowerCase());

// Where the structured blocks live: intake first (what the client or staff
// typed), the payer summary second (a record whose intake carries no block).
const blockOf = (client, name) => {
  const c = client || {};
  const fromIntake = obj(obj(c.intake)[name]);
  if (Object.keys(fromIntake).length) return { block: fromIntake, source: `intake.${name}` };
  const fromPayer = obj(obj(c.payer)[name]);
  if (Object.keys(fromPayer).length) return { block: fromPayer, source: `payer.${name}` };
  return { block: {}, source: null };
};

const entry = (fields) => Object.assign({
  rank: null, rankSource: null, kind: null, payerName: null, memberId: null, groupNumber: null,
  coverageStart: null, coverageEnd: null, qmb: 'unknown', memberIdValid: null, source: null,
  block: null, missing: []
}, fields);

// ---- THE NORMALISER --------------------------------------------------------
// Any recorded payer → ranked canonical entries plus whatever could not be
// resolved. The biller sees `unresolved`; nothing is guessed to fill it.
const normalizePayers = (client) => {
  const c = client || {};
  const intake = obj(c.intake);
  const payer = obj(c.payer);
  const qmb = readQmb(c);
  const entries = [];
  const unresolved = [];

  // Medicare: an Advantage plan is a DIFFERENT payer from Original Medicare
  // (the claim goes to the plan, not to Palmetto), so the block decides which.
  const mc = blockOf(c, 'medicare');
  if (mc.source) {
    const m = mc.block;
    const isMa = !!(str(m.advantagePlan) || str(m.advMemberId)) || kindFromLegacy(m.type) === 'medicare_advantage';
    const mbi = checkMbi(m.id);
    if (isMa) {
      entries.push(entry({
        kind: 'medicare_advantage', payerName: str(m.advantagePlan) || 'Medicare Advantage',
        memberId: str(m.advMemberId) || null, groupNumber: str(m.advGroupNum) || null,
        memberIdValid: null, source: mc.source, block: 'medicare', mbi: mbi.value || null, mbiValid: mbi.valid
      }));
    } else if (mbi.value || kindFromLegacy(m.type) === 'medicare_ffs') {
      entries.push(entry({
        kind: 'medicare_ffs', payerName: 'Medicare', memberId: mbi.value || null,
        memberIdValid: mbi.valid, source: mc.source, block: 'medicare'
      }));
    }
  }
  const md = blockOf(c, 'medicaid');
  if (md.source && (str(md.block.memberId) || str(md.block.plan))) {
    entries.push(entry({
      kind: str(md.block.plan) ? 'medicaid_mco' : 'medicaid',
      payerName: str(md.block.plan) || 'Georgia Medicaid', memberId: str(md.block.memberId) || null,
      source: md.source, block: 'medicaid'
    }));
  }
  const cm = blockOf(c, 'commercial');
  if (cm.source && (str(cm.block.carrier) || str(cm.block.memberId) || str(cm.block.planName))) {
    entries.push(entry({
      kind: 'commercial', payerName: [str(cm.block.carrier), str(cm.block.planName)].filter(Boolean).join(' ') || 'Commercial insurance',
      memberId: str(cm.block.memberId) || null, groupNumber: str(cm.block.groupNum) || null,
      source: cm.source, block: 'commercial'
    }));
  }
  const lt = blockOf(c, 'ltc');
  const ltcCarrier = str(lt.block.carrier) === 'Other' ? str(lt.block.carrierOther) : str(lt.block.carrier);
  if (lt.source && ((ltcCarrier && ltcCarrier !== 'Not applicable') || str(lt.block.policyNum))) {
    entries.push(entry({
      kind: 'ltc', payerName: ltcCarrier || 'Long-term care insurance', memberId: str(lt.block.policyNum) || null,
      source: lt.source, block: 'ltc'
    }));
  }

  // A payer with no block of its own: VA and private pay are never blocks, and
  // an older record may carry only the summary code or the payerType label.
  const typeLabel = intake.payerType || payer.type;
  const typeKind = kindFromLegacy(typeLabel);
  const has = (k) => entries.some(e => e.kind === k || (k === 'medicare_ffs' && e.kind === 'medicare_advantage'));
  if (typeKind && !has(typeKind)) {
    entries.push(entry({ kind: typeKind, payerName: KIND_LABELS[typeKind], source: intake.payerType ? 'intake.payerType' : 'payer.type' }));
  } else if (typeKind === undefined && str(typeLabel) && !isSituation(typeLabel)) {
    unresolved.push({ code: 'PAYER_TYPE_UNKNOWN', message: `The payer type "${str(typeLabel).slice(0, 60)}" is not one this app recognises. Record the coverage in the insurance section.` });
  }
  // The insurance-types checklist is a closed list, read through the same
  // table. It only ADDS a payer nothing else recorded, and carries no id.
  const types = Array.isArray(intake.insuranceTypes) ? intake.insuranceTypes : (Array.isArray(payer.insuranceTypes) ? payer.insuranceTypes : []);
  for (const t of types) {
    const k = kindFromLegacy(t);
    if (k && !has(k)) entries.push(entry({ kind: k, payerName: KIND_LABELS[k], source: 'insuranceTypes' }));
  }
  if (isSituation(typeLabel) || types.some(isSituation)) {
    // 'Dual eligible' means Medicare AND Medicaid; say so if either is missing.
    if (str(typeLabel).toLowerCase() === 'dual eligible' || types.some(t => str(t).toLowerCase() === 'dual eligible')) {
      if (!has('medicare_ffs')) entries.push(entry({ kind: 'medicare_ffs', payerName: 'Medicare', source: 'dual_eligible' }));
      if (!entries.some(e => e.kind === 'medicaid' || e.kind === 'medicaid_mco')) entries.push(entry({ kind: 'medicaid', payerName: 'Georgia Medicaid', source: 'dual_eligible' }));
    }
  }

  // Coverage dates and stated ranks come from the entry's own block.
  for (const e of entries) {
    const b = e.block ? blockOf(c, e.block).block : {};
    e.coverageStart = ymd(b.coverageStart);
    e.coverageEnd = ymd(b.coverageEnd);
    const stated = readRank(b.rank);
    if (stated) { e.rank = stated; e.rankSource = 'stated'; }
    e.qmb = qmb;
    if (e.memberId && !e.coverageStart) e.missing.push('coverageStart');
  }

  // RANK. Stated ranks win. Where nobody stated one, infer only what the data
  // supports: one claim payer is primary; Medicare plus Medicaid is Medicare
  // first (Medicaid is the payer of last resort). Anything else is unresolved.
  const anyStated = entries.some(e => e.rankSource === 'stated');
  const claim = entries.filter(e => CLAIM_KINDS.includes(e.kind));
  if (!anyStated) {
    const isMcd = (e) => e.kind === 'medicaid' || e.kind === 'medicaid_mco';
    const isMcr = (e) => MEDICARE_KINDS.includes(e.kind);
    if (claim.length === 1) {
      claim[0].rank = 'primary'; claim[0].rankSource = 'inferred';
    } else if (claim.length === 2 && claim.some(isMcr) && claim.some(isMcd)) {
      claim.find(isMcr).rank = 'primary'; claim.find(isMcr).rankSource = 'inferred';
      claim.find(isMcd).rank = 'secondary'; claim.find(isMcd).rankSource = 'inferred';
    } else if (claim.length > 1) {
      unresolved.push({ code: 'PAYER_RANK_NOT_STATED', message: `${claim.map(e => e.payerName).join(' and ')} are both on file and nobody has said which is billed first. Set the rank on each.` });
    } else if (entries.length === 1 && entries[0].kind === 'private_pay') {
      entries[0].rank = 'primary'; entries[0].rankSource = 'inferred';
    }
    for (const e of entries) if (!e.rank && !CLAIM_KINDS.includes(e.kind)) { e.rank = 'not_billed'; e.rankSource = 'inferred'; }
  } else {
    for (const e of entries) {
      if (!e.rank) unresolved.push({ code: 'PAYER_RANK_MISSING', message: `${e.payerName} has no rank. Say whether it is primary, secondary, tertiary or not billed.` });
    }
  }
  const primaries = entries.filter(e => e.rank === 'primary');
  if (primaries.length > 1) {
    unresolved.push({ code: 'PAYER_RANK_DUPLICATE_PRIMARY', message: `${primaries.map(e => e.payerName).join(' and ')} are both marked primary. Only one payer is billed first.` });
  }
  const order = { primary: 0, secondary: 1, tertiary: 2, not_billed: 3 };
  entries.sort((a, b) => (order[a.rank] ?? 9) - (order[b.rank] ?? 9));
  return {
    entries, unresolved, qmb,
    primary: primaries.length === 1 ? primaries[0] : null,
    secondary: entries.find(e => e.rank === 'secondary') || null
  };
};

// The one Medicare question. A record whose payer cannot be read is NOT
// Medicare: warning everybody makes the warning meaningless.
const isMedicare = (client) => normalizePayers(client).entries.some(e => MEDICARE_KINDS.includes(e.kind));

// Refused at save: exactly one block may be primary. (Ranks are a new field,
// so nothing already stored can trip this.)
const validateRanks = (intake) => {
  const i = obj(intake);
  const bad = [];
  const primaries = [];
  for (const name of BLOCKS) {
    const raw = obj(i[name]).rank;
    if (raw == null || raw === '') continue;
    const r = readRank(raw);
    if (!r) bad.push(name);
    else if (r === 'primary') primaries.push(name);
  }
  if (bad.length) return { error: `The payer rank for ${bad.join(', ')} must be Primary, Secondary, Tertiary or Not billed.`, code: 'PAYER_RANK_INVALID' };
  if (primaries.length > 1) return { error: `Only one payer can be primary; ${primaries.join(' and ')} are both marked primary.`, code: 'PAYER_RANK_DUPLICATE_PRIMARY' };
  return { ok: true };
};

// Applied to the intake before it is stored: the MBI is upper-cased and its
// spaces and hyphens dropped, and its validity is stamped so the screens can
// say so. Never refuses.
const normalizeIntakeInsurance = (intake) => {
  const i = obj(intake);
  if (!i.medicare || typeof i.medicare !== 'object') return { intake: i, mbi: null };
  const mbi = checkMbi(i.medicare.id);
  const medicare = { ...i.medicare };
  if (medicare.id !== undefined) medicare.id = mbi.value;
  medicare.idValid = mbi.valid;
  return { intake: { ...i, medicare }, mbi };
};

// ---- Verification ----------------------------------------------------------
// What was checked is fingerprinted, so a verification of last month's member
// id is not read as covering a member id typed in today. That is not expiry:
// the clock never changes this answer, only the data does.
const fingerprint = (e) => e ? [e.kind, str(e.memberId).toUpperCase(), str(e.payerName).toLowerCase()].join('|') : '';

const buildVerification = ({ current, body, actor, now }) => {
  const b = obj(body);
  const status = str(b.status);
  if (!VERIFICATION_STATUSES.includes(status) || status === 'unverified') {
    return { error: 'Record what the check found: verified, mismatch or inactive.', code: 'VERIFICATION_STATUS_INVALID' };
  }
  const method = str(b.method);
  if (!VERIFICATION_METHODS.includes(method)) return { error: 'Say how it was checked: the Availity portal or an X12 270.', code: 'VERIFICATION_METHOD_INVALID' };
  const planTypeAsFound = str(b.planTypeAsFound);
  if (!KINDS.includes(planTypeAsFound)) return { error: `Plan type as found must be one of: ${KINDS.map(k => KIND_LABELS[k]).join(', ')}.`, code: 'VERIFICATION_PLAN_TYPE_INVALID' };
  const payerAsFound = str(b.payerAsFound).slice(0, 120);
  if (!payerAsFound) return { error: 'Record the payer name as the check returned it.', code: 'VERIFICATION_PAYER_REQUIRED' };
  const today = String(now || new Date().toISOString()).slice(0, 10);
  const checkedAt = ymd(b.checkedAt) || today;
  if (checkedAt > today) return { error: 'The check date cannot be in the future.', code: 'VERIFICATION_DATE_INVALID' };
  const note = str(b.note);
  if (note.length > NOTE_MAX) return { error: `Keep the note to ${NOTE_MAX} characters.`, code: 'VERIFICATION_NOTE_TOO_LONG' };
  if (!current) return { error: 'There is no payer at that rank to verify. Record the coverage first.', code: 'VERIFICATION_NO_PAYER' };

  // MISMATCH IS THE POINT OF THE LOOP. A plan type found that differs from
  // what intake recorded (above all Medicare Advantage where intake said
  // Original Medicare) is a mismatch whatever the biller selected, and BOTH
  // values are kept: collapsing to one hides which was wrong.
  const differs = planTypeAsFound !== current.kind;
  const finalStatus = status === 'verified' && differs ? 'mismatch' : status;
  return {
    value: {
      rank: current.rank, status: finalStatus, method, checkedAt,
      checkedBy: actor ? { id: actor.id || null, name: actor.name || actor.email || null } : null,
      recordedAt: now || new Date().toISOString(),
      payerAsFound, planTypeAsFound, note: note || null,
      recorded: { kind: current.kind, payerName: current.payerName, memberId: current.memberId || null },
      fingerprint: fingerprint(current),
      autoMismatch: status === 'verified' && differs
    }
  };
};

const daysBetween = (a, b) => {
  const x = Date.parse(`${a}T12:00:00Z`); const y = Date.parse(`${b}T12:00:00Z`);
  return isFinite(x) && isFinite(y) ? Math.round((y - x) / 86400000) : null;
};

// The state of one ranked payer, as every screen reads it.
const verificationState = (client, { rank = 'primary', today } = {}) => {
  const norm = normalizePayers(client);
  const current = norm.entries.find(e => e.rank === rank) || null;
  const stored = obj(obj(obj(client).insuranceVerification)[rank]);
  const has = !!stored.status;
  const applies = has && current && stored.fingerprint === fingerprint(current);
  const status = !current ? null : (applies ? stored.status : 'unverified');
  const t = today || new Date().toISOString().slice(0, 10);
  const ageDays = applies && stored.checkedAt ? daysBetween(stored.checkedAt, t) : null;
  let label;
  if (!current) label = rank === 'primary' ? 'No primary payer on file' : null;
  else if (status === 'verified') label = `${current.payerName} verified ${stored.checkedAt}${ageDays != null ? ` (${ageDays} day${ageDays === 1 ? '' : 's'} ago)` : ''}`;
  else if (status === 'mismatch') label = `Mismatch: intake says ${KIND_LABELS[stored.recorded.kind] || stored.recorded.kind} (${stored.recorded.payerName}); check found ${KIND_LABELS[stored.planTypeAsFound]} (${stored.payerAsFound})`;
  else if (status === 'inactive') label = `${current.payerName} coverage found inactive ${stored.checkedAt}`;
  else label = has && !applies
    ? `${current.payerName} unverified (the coverage on file changed after the ${stored.checkedAt} check)`
    : `${current.payerName} unverified`;
  return {
    rank, status, label, ageDays,
    payer: current ? { kind: current.kind, kindLabel: KIND_LABELS[current.kind], payerName: current.payerName, memberIdValid: current.memberIdValid, missing: current.missing } : null,
    verification: applies ? stored : null,
    staleRecord: has && !applies ? { checkedAt: stored.checkedAt || null } : null,
    unresolved: norm.unresolved, qmb: norm.qmb
  };
};

// ---- The billing gate (E1–E3) ---------------------------------------------
// The CLAIM, never the signature. Private pay has nothing to verify. A
// verified-but-stale record is shown with its age and still passes: a person
// stated it, and a clock does not un-state it.
const checkInsuranceForBilling = (client, { override, actor, isAdmin, today } = {}) => {
  const s = verificationState(client, { rank: 'primary', today });
  const norm = normalizePayers(client);
  let problem = null;
  if (!s.payer) {
    const dup = norm.unresolved.find(u => u.code === 'PAYER_RANK_DUPLICATE_PRIMARY' || u.code === 'PAYER_RANK_NOT_STATED');
    problem = dup
      ? { code: 'BILLING_PAYER_UNRESOLVED', message: `Cannot submit to billing: ${dup.message}` }
      : { code: 'BILLING_NO_PRIMARY_PAYER', message: 'Cannot submit to billing: no primary payer is recorded for this patient.' };
  } else if (s.payer.kind === 'private_pay') {
    return { ok: true, status: 'not_applicable' };
  } else if (s.status === 'mismatch') {
    problem = { code: 'BILLING_INSURANCE_MISMATCH', message: `Cannot submit to billing: ${s.payer.payerName} coverage does not match what the eligibility check found (${KIND_LABELS[s.verification.planTypeAsFound]}, ${s.verification.payerAsFound}). Correct the coverage and check it again.` };
  } else if (s.status === 'inactive') {
    problem = { code: 'BILLING_INSURANCE_INACTIVE', message: `Cannot submit to billing: ${s.payer.payerName} coverage was found inactive on ${s.verification.checkedAt}.` };
  } else if (s.status !== 'verified') {
    problem = { code: 'BILLING_INSURANCE_UNVERIFIED', message: `Cannot submit to billing: ${s.payer.payerName} coverage is unverified.` };
  }
  if (!problem) return { ok: true, status: 'verified', state: s };

  // E3: a business control, not a law of physics. An admin who knows the
  // coverage is good may proceed, and must say why. The reason is stored.
  const o = obj(override);
  if (o.reason !== undefined || o.apply) {
    if (!isAdmin) return { ok: false, ...problem, overrideRefused: 'Only an admin can override the insurance check.' };
    const reason = str(o.reason).slice(0, 500);
    if (!reason) return { ok: false, ...problem, code: 'BILLING_OVERRIDE_REASON_REQUIRED', message: 'An insurance override needs a reason.' };
    return {
      ok: true, status: 'overridden', state: s,
      override: { reason, overrode: problem.code, by: actor ? { id: actor.id || null, name: actor.name || actor.email || null } : null, at: new Date().toISOString() }
    };
  }
  return { ok: false, ...problem, overridable: true, state: s };
};

// ---- QMB: no patient statement (E4) ---------------------------------------
// A Qualified Medicare Beneficiary may not be billed Medicare cost sharing AT
// ALL — under Original Medicare and under Medicare Advantage, and even when
// Medicaid pays less than the full amount. A copay statement is cost sharing,
// so it is never created or sent. There is NO override: if the QMB answer is
// wrong, the fix is to correct it on the intake, where it is stated.
// Home care hours are private-pay personal care, not a Medicare-covered
// service, so they are not cost sharing and are not blocked. Collection tasks
// and balance transfers do not exist in this app yet; when they do, they call
// this same function.
const COST_SHARE_KINDS = Object.freeze(['copay', 'collection_task', 'balance_transfer']);
const qmbBlocksPatientBilling = (client, kind) => {
  if (!COST_SHARE_KINDS.includes(kind)) return { blocked: false };
  if (readQmb(client) !== 'yes') return { blocked: false };
  return {
    blocked: true, code: 'QMB_NO_PATIENT_BILLING',
    message: 'This patient is a Qualified Medicare Beneficiary. Federal law prohibits billing them for Medicare cost sharing, including copays, under Original Medicare or Medicare Advantage. No statement was created.'
  };
};

// ---- OpenEMR insurance row (C2) -------------------------------------------
// One row per ranked payer, in the shape OpenEMR 8.4's
// POST /api/patient/:puuid/insurance validates (src/Validators/
// CoverageValidator.php). `subscriber_ss` is optional there and is NEVER sent:
// the app holds only the last four, and a self-subscriber row with an SSN is
// checked against the patient's own. Every refusal is named.
const SUB_RELATION = Object.freeze({ self: 'self', spouse: 'spouse', child: 'child', parent: 'other', other: 'other' });
const sexFor = (g) => { const s = str(g).toLowerCase(); return s.startsWith('f') ? 'Female' : s.startsWith('m') ? 'Male' : 'UNK'; };
const splitName = (full) => {
  const parts = str(full).split(/\s+/).filter(Boolean);
  return { first: parts[0] || '', last: parts.length > 1 ? parts[parts.length - 1] : '' };
};

const buildOpenEmrInsuranceRow = ({ entry: e, client, companyId, assignmentSigned }) => {
  const c = client || {};
  const intake = obj(c.intake);
  if (!e) return { error: 'There is no payer at that rank.', code: 'EMR_INSURANCE_NO_PAYER' };
  if (!['primary', 'secondary', 'tertiary'].includes(e.rank)) return { error: `${e.payerName} is not ranked as a billed payer, so it is not written to OpenEMR.`, code: 'EMR_INSURANCE_NOT_BILLED' };
  if (!/^\d+$/.test(str(companyId))) return { error: 'Pick the insurance company from OpenEMR\'s list.', code: 'EMR_INSURANCE_COMPANY_REQUIRED' };
  const policy = str(e.memberId);
  if (policy.length < 2) return { error: `${e.payerName} has no member id on file.`, code: 'EMR_INSURANCE_NO_MEMBER_ID' };
  if (!e.coverageStart) return { error: `${e.payerName} needs a coverage start date; OpenEMR's insurance record is date-ranged.`, code: 'EMR_INSURANCE_NO_START' };

  // Subscriber: the patient, unless a commercial policy names somebody else.
  const cm = obj(intake.commercial);
  const rel = e.kind === 'commercial' ? str(cm.policyHolderRel).toLowerCase() : 'self';
  const self = !rel || rel === 'self';
  const addr = obj(intake.address);
  let first; let last; let dob; let sex;
  if (self) {
    const n = splitName(c.name);
    first = str(intake.clientFirst) || n.first; last = str(intake.clientLast) || n.last;
    dob = ymd(intake.dob || c.dob); sex = sexFor(intake.gender);
  } else {
    const n = splitName(cm.policyHolder);
    first = n.first; last = n.last; dob = ymd(cm.policyHolderDob); sex = 'UNK';
  }
  const missing = [];
  if (!first) missing.push('subscriber first name');
  if (last.length < 2) missing.push('subscriber last name');
  if (!dob) missing.push('subscriber date of birth');
  if (str(addr.street || addr.line1).length < 2) missing.push('street');
  if (str(addr.city).length < 2) missing.push('city');
  if (!str(addr.state)) missing.push('state');
  if (str(addr.zip || addr.postalCode).length < 2) missing.push('ZIP');
  if (missing.length) return { error: `OpenEMR needs ${missing.join(', ')} to store ${e.payerName}.`, code: 'EMR_INSURANCE_SUBSCRIBER_INCOMPLETE', missing };

  const row = {
    type: e.rank, provider: str(companyId), plan_name: str(e.payerName).slice(0, 255),
    policy_number: policy.slice(0, 255),
    subscriber_fname: first, subscriber_lname: last,
    subscriber_relationship: self ? 'self' : (SUB_RELATION[rel] || 'other'),
    subscriber_DOB: dob, subscriber_sex: sex,
    subscriber_street: str(addr.street || addr.line1), subscriber_city: str(addr.city),
    subscriber_state: str(addr.state).toUpperCase(), subscriber_postal_code: str(addr.zip || addr.postalCode),
    // Signature on file: the signed Assignment of Benefits consent.
    accept_assignment: assignmentSigned ? 'TRUE' : 'FALSE',
    date: e.coverageStart
  };
  if (str(e.groupNumber).length >= 2) row.group_number = str(e.groupNumber).slice(0, 255);
  if (e.coverageEnd) row.date_end = e.coverageEnd;
  return { row };
};

// The intake rank options, served to the forms.
const RANK_OPTIONS = Object.freeze(['Primary', 'Secondary', 'Tertiary', 'Not billed']);
const QMB_OPTIONS = Object.freeze(['Unknown', 'Yes', 'No']);

module.exports = {
  KINDS, KIND_LABELS, MEDICARE_KINDS, CLAIM_KINDS, RANKS, RANK_LABELS, QMB_VALUES,
  VERIFICATION_STATUSES, VERIFICATION_METHODS, NOTE_MAX, LEGACY_TO_KIND, COST_SHARE_KINDS,
  RANK_OPTIONS, QMB_OPTIONS,
  MBI_RE, normalizeMbi, checkMbi,
  readQmb, readRank, kindFromLegacy,
  normalizePayers, isMedicare, validateRanks, normalizeIntakeInsurance,
  fingerprint, buildVerification, verificationState,
  checkInsuranceForBilling, qmbBlocksPatientBilling,
  buildOpenEmrInsuranceRow
};
