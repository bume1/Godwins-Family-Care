// orderRequisitions.js — Session 4.10, Scope A
//
// AN ORDER THAT CANNOT LEAVE THE BUILDING IS A RECORD OF INTENT. Before this
// session an order was documentation plus an OpenEMR copy: nothing was produced
// that could be sent, nothing recorded that it HAD been sent, referrals and DME
// did not exist as order types at all, and a result had nowhere to land.
//
// THE TRANSMISSION MODEL IS AN OWNER DECISION AND IT IS NOT NEGOTIABLE IN CODE:
// GFC has no e-fax integration. A human faxes, from the Doximity app on a phone.
// So the app GENERATES and A PERSON TRANSMITS — it never calls a fax API and it
// never claims a fax was sent. What it does is produce a fax-ready PDF and then
// record the send WITH PROVENANCE when the clinician confirms it.
//
// `channel` is an enum rather than a boolean precisely so an e-fax integration
// can slot in later without a data migration. That integration is a non-goal
// here; the seam is the whole point of the enum.

'use strict';

const roles = require('./clinicalRoles');

// ---- The two new order types --------------------------------------------
// PROVIDER-DIRECT ONLY, and that is safe BY CONSTRUCTION rather than by a new
// gate: `orderDirect` is a provider-only capability, and neither type appears in
// STANDING_ORDER_TYPES or in any role's CREDENTIAL_CEILING, so an RN, an LCSW or
// an LMSW is refused whether or not they name a protocol. The tests prove that
// construction rather than assuming it, because "nothing grants it" is exactly
// the kind of invariant a later session breaks by widening an enum.
const REFERRAL = 'referral';
const DME = 'dme';
const DOCUMENT_ORDER_TYPES = Object.freeze([REFERRAL, DME]);

// A referral's life is not a lab's life. A lab is sent and resulted; a referral
// is sent, the specialist's office schedules it, and it completes when the
// consult note comes back. Collapsing the two would mean a referral sitting at
// "sent" for six weeks with nothing saying an appointment exists.
const REFERRAL_STATUSES = Object.freeze(['ordered', 'sent', 'scheduled', 'completed', 'cancelled']);
const REFERRAL_TRANSITIONS = Object.freeze({
  ordered: ['sent', 'cancelled'],
  sent: ['scheduled', 'completed', 'cancelled'],
  scheduled: ['completed', 'cancelled'],
  completed: [],
  cancelled: []
});

const URGENCIES = Object.freeze(['routine', 'urgent', 'stat']);

// ---- How an order is transmitted ----------------------------------------
// The seam for a future e-fax integration. `doximity` is today's answer; the
// others exist because a referral does genuinely sometimes go by portal, by
// phone or handed to the patient, and recording "doximity" for one of those
// would be a false provenance record on a PHI disclosure.
const SEND_CHANNELS = Object.freeze(['doximity', 'efax', 'portal', 'phone', 'hand']);
const DEFAULT_SEND_CHANNEL = 'doximity';
// Which channels carry a fax number. Declared here rather than inline in the
// send builder AND again in the form: a portal submission has no fax number and
// inventing one would put a false number on a disclosure record, so the two
// halves must not be able to disagree about which is which.
const FAX_SEND_CHANNELS = Object.freeze(['doximity', 'efax']);
const SEND_CHANNEL_LABELS = Object.freeze({
  doximity: 'Doximity fax', efax: 'e-fax', portal: 'Payer / provider portal',
  phone: 'Read over the phone', hand: 'Handed to the patient'
});

// ---- Fax numbers --------------------------------------------------------
// A MISTYPED FAX NUMBER IS A MISDIRECTED PHI DISCLOSURE, which is why every fax
// field in this session validates rather than trusting the form. Ten digits,
// stored bare; a leading country code 1 is accepted and dropped because people
// type it. Nine or eleven digits is refused — there is no US fax number of
// either length, and guessing which digit was fat-fingered is worse than asking.
const normalizeFax = (raw) => {
  const digits = String(raw == null ? '' : raw).replace(/\D+/g, '');
  const bare = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  return /^[2-9]\d{9}$/.test(bare) ? bare : null;
};
const formatFax = (raw) => {
  const n = normalizeFax(raw);
  if (!n) return String(raw == null ? '' : raw).trim() || '';
  return `(${n.slice(0, 3)}) ${n.slice(3, 6)}-${n.slice(6)}`;
};

// ---- The order reference printed on the requisition ---------------------
// THIS IS HOW AN INBOUND FAX FINDS ITS WAY BACK TO ITS ORDER. Somebody reads it
// off a faxed page, possibly a poor one, and types it in — so the alphabet
// excludes every character that is ambiguous in that situation: no 0/O, no
// 1/I/L, no 2/Z, no 5/S, no 8/B. What is left cannot be misread into another
// valid reference.
const REF_ALPHABET = '34679ACDEFGHJKMNPQRTUVWXY';
const REF_PREFIX = 'GFC-ORD-';
const REF_LENGTH = 6;
const buildOrderReference = (rand) => {
  const pick = typeof rand === 'function' ? rand : Math.random;
  let out = '';
  for (let i = 0; i < REF_LENGTH; i++) out += REF_ALPHABET[Math.floor(pick() * REF_ALPHABET.length) % REF_ALPHABET.length];
  return `${REF_PREFIX}${out}`;
};
// Read a reference out of free text — an inbound fax's typed-in "which order is
// this" field, or an OCR'd line. Case-insensitive, tolerant of a missing or
// doubled separator, because the person typing it is reading a fax.
const parseOrderReference = (raw) => {
  const s = String(raw == null ? '' : raw).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const m = s.match(/GFCORD([A-Z0-9]{6})/);
  if (!m) return null;
  const body = m[1];
  // A reference that carries a character the alphabet excludes is not one of
  // ours: returning it anyway would match nothing and read as "no such order"
  // when the real answer is "that is not a GFC reference".
  return [...body].every(c => REF_ALPHABET.includes(c)) ? `${REF_PREFIX}${body}` : null;
};

// ---- Shared envelope ----------------------------------------------------
// Referrals and DME share the order envelope — id, client, encounter, ordering
// clinician, diagnoses, priority, status, audit fields — so the board, the
// status machinery, the requisition generator and the overdue sweep all read one
// shape. What differs is the payload, which is where the type-specific rules
// live. Every order still anchors to an encounter and to at least one encounter
// diagnosis, exactly as a lab order does.
const clean = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const isYmd = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !Number.isNaN(new Date(`${v}T12:00:00Z`).getTime());

const normalizeIcd10 = (raw) => {
  let s = String(raw || '').trim().toUpperCase().replace(/\s+/g, '');
  if (!s) return null;
  if (/^[A-Z][0-9][0-9A-Z][0-9A-Z]{1,4}$/.test(s)) s = `${s.slice(0, 3)}.${s.slice(3)}`;
  return /^[A-Z][0-9][0-9A-Z](\.[0-9A-Z]{1,4})?$/.test(s) ? s : null;
};

const actorRecord = (actor) => ({
  id: (actor && actor.id) || null,
  name: (actor && actor.name) || null,
  licenseLevel: (actor && actor.licenseLevel) || null,
  npi: /^\d{10}$/.test(String((actor && actor.npi) || '').replace(/\D/g, '')) ? String(actor.npi).replace(/\D/g, '') : null,
  openEmrProviderId: actor && actor.openEmrProviderId ? String(actor.openEmrProviderId) : null
});

const buildEnvelope = ({ id, clientId, puuid, encounterUuid, orderType, input, actor, encounterDiagnoses, at, reference }) => {
  const i = input || {};
  const dxKnown = new Set((encounterDiagnoses || []).map(d => d && d.code).filter(Boolean));
  const diagnosisCodes = Array.from(new Set(
    (Array.isArray(i.diagnosisCodes) ? i.diagnosisCodes : []).map(normalizeIcd10).filter(Boolean)
  ));
  if (!diagnosisCodes.length) {
    return { error: 'Link the order to at least one encounter diagnosis', code: 'ORDER_NO_DIAGNOSIS' };
  }
  const unknown = diagnosisCodes.filter(c => !dxKnown.has(c));
  if (unknown.length) {
    return { error: `${unknown.join(', ')} is not a diagnosis on this encounter — add it to the encounter first`, code: 'ORDER_DX_UNKNOWN' };
  }
  const now = at || new Date().toISOString();
  const priority = URGENCIES.includes(i.priority) ? i.priority : 'routine';
  return {
    envelope: {
      id, clientId, puuid, encounterUuid: String(encounterUuid),
      orderType,
      orderReference: reference || buildOrderReference(),
      // Kept so every consumer that reads `tests` on an order keeps working.
      // A referral's "test" is the specialty; a DME order's is the item. The
      // requisition prints the payload, not this — but the board, the audit row
      // and the OpenEMR procedure_order copy all read `tests`, and giving them
      // an empty array would make a referral look like an order for nothing.
      tests: [],
      priority,
      diagnosisCodes,
      notes: clean(i.notes, 2000),
      orderingClinician: actorRecord(actor),
      status: 'ordered',
      statusHistory: [{ status: 'ordered', at: now, by: actorRecord(actor), note: null }],
      sends: [],
      transmission: 'manual',
      createdAt: now,
      updatedAt: now
    }
  };
};

// ---- Referral -----------------------------------------------------------
// The clinical summary is REQUIRED and is described on the form as the question
// you want answered, because a referral with no question is a referral the
// specialist has to phone about.
const REFERRAL_ATTACHMENT_KINDS = Object.freeze(['encounter_note', 'result']);
const buildReferral = ({ id, clientId, puuid, encounterUuid, input, actor, encounterDiagnoses, at, reference }) => {
  const env = buildEnvelope({ id, clientId, puuid, encounterUuid, orderType: REFERRAL, input, actor, encounterDiagnoses, at, reference });
  if (env.error) return env;
  const i = input || {};
  const specialty = clean(i.specialty, 120);
  if (!specialty) return { error: 'A specialty is required', code: 'REFERRAL_NO_SPECIALTY' };
  const reason = clean(i.reason, 1000);
  if (!reason) return { error: 'A reason for referral is required', code: 'REFERRAL_NO_REASON' };
  const clinicalSummary = clean(i.clinicalSummary, 4000);
  if (!clinicalSummary) {
    return { error: 'A clinical summary is required — it is the question you want the specialist to answer', code: 'REFERRAL_NO_SUMMARY' };
  }
  const receivingFax = normalizeFax(i.receivingFax);
  if (!receivingFax) {
    return { error: 'A valid 10-digit receiving fax number is required — this is the number the requisition is faxed to', code: 'REFERRAL_BAD_FAX' };
  }
  // PRIOR AUTHORIZATION. Medicare Advantage plans frequently require one and
  // it is the single most commonly forgotten step in a referral, so it is a
  // flag on the record rather than a line in the summary: a flag can be
  // reported on, chased and printed prominently.
  const priorAuthRequired = !!i.priorAuthRequired;
  const priorAuthNumber = clean(i.priorAuthNumber, 60) || null;
  const attachments = (Array.isArray(i.attachments) ? i.attachments : [])
    .map(a => (a && typeof a === 'object') ? a : null)
    .filter(a => a && REFERRAL_ATTACHMENT_KINDS.includes(String(a.kind)) && clean(a.id, 120))
    .map(a => ({ kind: String(a.kind), id: clean(a.id, 120), label: clean(a.label, 160) || null }))
    .slice(0, 12);
  return {
    order: {
      ...env.envelope,
      tests: [specialty],
      referral: {
        specialty,
        receivingPractice: clean(i.receivingPractice, 160) || null,
        receivingProvider: clean(i.receivingProvider, 160) || null,
        receivingFax,
        receivingPhone: clean(i.receivingPhone, 40) || null,
        reason,
        urgency: URGENCIES.includes(i.urgency) ? i.urgency : env.envelope.priority,
        clinicalSummary,
        attachments,
        priorAuthRequired,
        priorAuthNumber,
        appointmentDate: null
      }
    }
  };
};

// ---- DME: CMS's Standard Written Order ----------------------------------
// The SWO's six required elements (CMS Pub. 100-08 / 42 CFR 410.38) are
// SERVER-ENFORCED before the order can be finalized, one refusal each, because
// a supplier holding an SWO missing any of them cannot bill — and the order
// having looked complete on our screen is not a defence.
//
//   1. beneficiary name or MBI          4. quantity to be dispensed
//   2. order date                       5. treating practitioner name or NPI
//   3. general description of the item  6. treating practitioner signature
//
// Elements 1, 2, 5 and 6 come from the record rather than from the form: the
// patient is the patient, the date is the order date, the practitioner is the
// ordering clinician, and the signature is the electronic signature statement
// the requisition prints. So they are validated against what we HAVE, and the
// refusal names which one is missing rather than asking for it twice.
const SWO_ELEMENTS = Object.freeze([
  { key: 'beneficiary', label: 'Beneficiary name or MBI', code: 'DME_SWO_NO_BENEFICIARY' },
  { key: 'orderDate', label: 'Order date', code: 'DME_SWO_NO_ORDER_DATE' },
  { key: 'itemDescription', label: 'General description of the item', code: 'DME_SWO_NO_ITEM' },
  { key: 'quantity', label: 'Quantity to be dispensed', code: 'DME_SWO_NO_QUANTITY' },
  { key: 'practitioner', label: 'Treating practitioner name or NPI', code: 'DME_SWO_NO_PRACTITIONER' },
  { key: 'signature', label: 'Treating practitioner signature', code: 'DME_SWO_NO_SIGNATURE' }
]);

// A face-to-face encounter supporting a DME order must fall within the SIX
// MONTHS BEFORE the order date. Measured in calendar months rather than 180
// days, because that is how the rule reads and a February order would otherwise
// be judged by a different window than an August one.
const F2F_MONTHS = 6;
const f2fWindowStart = (orderDate) => {
  const d = new Date(`${orderDate}T12:00:00Z`);
  const out = new Date(d.getTime());
  out.setUTCMonth(out.getUTCMonth() - F2F_MONTHS);
  return out.toISOString().slice(0, 10);
};

const buildDmeOrder = ({ id, clientId, puuid, encounterUuid, input, actor, encounterDiagnoses, client, at, reference }) => {
  const env = buildEnvelope({ id, clientId, puuid, encounterUuid, orderType: DME, input, actor, encounterDiagnoses, at, reference });
  if (env.error) return env;
  const i = input || {};
  const intake = (client && client.intake) || {};

  // ── SWO element 3 ──
  const itemDescription = clean(i.itemDescription, 400);
  if (!itemDescription) {
    return { error: 'A general description of the item is required (narrative, HCPCS code, or brand and model) — SWO element 3', code: 'DME_SWO_NO_ITEM' };
  }
  // ── SWO element 4 ──
  const quantity = parseInt(i.quantity, 10);
  if (!Number.isInteger(quantity) || quantity <= 0 || quantity > 999) {
    return { error: 'A quantity to be dispensed is required and must be a whole number greater than 0 — SWO element 4', code: 'DME_SWO_NO_QUANTITY' };
  }
  // ── SWO element 2 ──
  const orderDate = isYmd(i.orderDate) ? String(i.orderDate) : (at || new Date().toISOString()).slice(0, 10);
  if (!isYmd(orderDate)) {
    return { error: 'An order date is required — SWO element 2', code: 'DME_SWO_NO_ORDER_DATE' };
  }
  // ── SWO element 1: from the RECORD, not the form ──
  const beneficiaryName = clean(client && client.name, 160) ||
    [clean(intake.firstName, 80), clean(intake.lastName, 80)].filter(Boolean).join(' ');
  const mbi = clean(i.mbi || (client && client.mbi) || intake.mbi || ((client && client.payer) || {}).memberId, 40) || null;
  if (!beneficiaryName && !mbi) {
    return { error: 'The beneficiary has neither a name nor an MBI on file — SWO element 1. Fill in the client record first.', code: 'DME_SWO_NO_BENEFICIARY' };
  }
  // ── SWO element 5: the treating practitioner ──
  const practitioner = env.envelope.orderingClinician;
  if (!practitioner.name && !practitioner.npi) {
    return { error: 'The treating practitioner has neither a name nor an NPI on file — SWO element 5', code: 'DME_SWO_NO_PRACTITIONER' };
  }
  // ── SWO element 6: the signature. An NPI is what makes the electronic
  // signature statement a signature a supplier can act on, so an ordering
  // clinician with no NPI is refused HERE rather than at PDF time — refusing at
  // PDF time would mean a finalized DME order that can never be sent.
  if (!practitioner.npi) {
    return { error: `${practitioner.name || 'This clinician'} has no NPI on file, so the requisition cannot carry the treating practitioner's signature — SWO element 6. An admin sets it on the user record.`, code: 'DME_SWO_NO_SIGNATURE' };
  }

  const supplierFax = normalizeFax(i.supplierFax);
  if (!supplierFax) {
    return { error: 'A valid 10-digit supplier fax number is required — this is the number the written order is faxed to', code: 'DME_BAD_SUPPLIER_FAX' };
  }
  const supplierName = clean(i.supplierName, 160);
  if (!supplierName) return { error: 'A supplier name is required', code: 'DME_NO_SUPPLIER' };
  const lengthOfNeed = clean(i.lengthOfNeed, 80);
  if (!lengthOfNeed) {
    return { error: 'A length of need is required (for example "99 months" for permanent need)', code: 'DME_NO_LENGTH_OF_NEED' };
  }

  // THE TWO FLAGS ARE THE PROVIDER'S, AND CMS'S REQUIRED LIST IS NOT IN CODE.
  // That list changes, and a stale copy of it in a source file would either
  // block a legitimate order or wave through one that needed a written order
  // before delivery. The provider sets the flags; the UI links to the current
  // list.
  const requiresF2F = !!i.requiresF2F;
  let faceToFaceDate = null;
  if (requiresF2F) {
    faceToFaceDate = isYmd(i.faceToFaceDate) ? String(i.faceToFaceDate) : null;
    if (!faceToFaceDate) {
      return { error: 'This item requires a face-to-face encounter, so a face-to-face date is required', code: 'DME_NO_F2F_DATE' };
    }
    const start = f2fWindowStart(orderDate);
    if (faceToFaceDate < start || faceToFaceDate > orderDate) {
      return {
        error: `The face-to-face encounter of ${faceToFaceDate} is outside the six months before the order date (${start} to ${orderDate}). A new face-to-face encounter is needed.`,
        code: 'DME_F2F_OUT_OF_WINDOW', windowStart: start, windowEnd: orderDate
      };
    }
  }

  return {
    order: {
      ...env.envelope,
      tests: [itemDescription],
      dme: {
        // The six SWO elements, stored as the order carries them so a later
        // reader does not have to re-derive which rule each value satisfied.
        beneficiaryName: beneficiaryName || null,
        mbi,
        orderDate,
        itemDescription,
        hcpcsCode: clean(i.hcpcsCode, 20).toUpperCase() || null,
        quantity,
        practitionerName: practitioner.name,
        practitionerNpi: practitioner.npi,
        // The signature itself is the electronic signature statement the
        // requisition prints; this records that the element is satisfied and
        // by whom, which is what a supplier audit asks.
        signatureMethod: 'electronic',
        supplierName,
        supplierFax,
        supplierPhone: clean(i.supplierPhone, 40) || null,
        lengthOfNeed,
        requiresF2F,
        faceToFaceDate,
        // Link the face-to-face to the encounter it came from when one exists,
        // so the supporting documentation is findable rather than asserted.
        faceToFaceEncounterUuid: requiresF2F ? (clean(i.faceToFaceEncounterUuid, 80) || String(encounterUuid)) : null,
        requiresWOPD: !!i.requiresWOPD
      }
    }
  };
};

// What is missing, for a screen that wants to show the checklist rather than
// discover the refusals one at a time. The ROUTE is the control; this is so the
// form can be honest before the click.
const swoGaps = (order) => {
  const d = (order && order.dme) || {};
  const have = {
    beneficiary: !!(d.beneficiaryName || d.mbi),
    orderDate: !!d.orderDate,
    itemDescription: !!d.itemDescription,
    quantity: Number.isInteger(d.quantity) && d.quantity > 0,
    practitioner: !!(d.practitionerName || d.practitionerNpi),
    signature: !!d.practitionerNpi
  };
  return SWO_ELEMENTS.filter(e => !have[e.key]).map(e => ({ element: e.key, label: e.label, code: e.code }));
};

// ---- 42 CFR 424.507: the ordering practitioner's Medicare enrolment -----
//
// When the practitioner who ORDERED a clinical lab test, imaging study or
// DMEPOS item is not enrolled in Medicare in approved status, the LAB's, the
// IMAGING CENTRE's or the SUPPLIER's claim is denied. That is not GFC's claim,
// which is exactly why it is easy to forget — and why it is GFC's problem: the
// supplier calls the patient, or writes the order off, and the patient does not
// get the equipment.
//
// WARN AND RECORD, DO NOT HARD-BLOCK. Commercial patients exist, urgent care
// exists, and a clinician who is mid-enrolment still has to be able to order a
// test for someone who needs one today. What is not acceptable is it happening
// silently, so the acknowledgment carries a reason and lands on the order.
//
// 'opted_out' passes deliberately: an opted-out practitioner is outside
// Medicare by choice and the patient is in a private contract, which is a
// different arrangement rather than a missing enrolment.
const ENROLLMENT_STATUSES = Object.freeze(['approved', 'pending', 'none', 'opted_out']);
const ENROLLMENT_LABELS = Object.freeze({
  approved: 'Enrolled — approved',
  pending: 'Enrolment pending',
  none: 'Not enrolled',
  opted_out: 'Opted out of Medicare'
});
const ENROLLMENT_OK = Object.freeze(['approved', 'opted_out']);
// The order types 424.507 reaches. REFERRALS ARE DELIBERATELY ABSENT: a
// referral to a specialist is not an ordered service under 424.507, and warning
// on it would train clinicians to click past the warning that matters.
const ENROLLMENT_GATED_TYPES = Object.freeze(['lab', 'imaging', DME]);

const normalizeMedicareEnrollment = (raw) => {
  const v = (raw && typeof raw === 'object') ? raw : {};
  const status = ENROLLMENT_STATUSES.includes(String(v.status || '')) ? String(v.status) : null;
  return {
    status,
    effectiveDate: isYmd(v.effectiveDate) ? String(v.effectiveDate) : null,
    verifiedAt: v.verifiedAt ? String(v.verifiedAt).slice(0, 40) : null,
    verifiedBy: clean(v.verifiedBy, 120) || null
  };
};

// Is this patient a Medicare patient? Read off the client's payer block, which
// the intake mirror assembles. UNKNOWN IS NOT MEDICARE: warning every patient
// whose payer we cannot read would make the warning meaningless, and the payer
// block is the same thing billing reads.
const isMedicarePatient = (client) => {
  const payer = (client && client.payer) || {};
  const type = String(payer.type || '').toLowerCase();
  if (['medicare', 'medicare_advantage', 'medicareadvantage', 'ma'].includes(type)) return true;
  // The intake's own structured insurance block, for a record written before
  // the payer summary existed.
  const ins = ((client && client.intake) || {}).insurance || {};
  const types = Array.isArray(ins.insuranceTypes) ? ins.insuranceTypes.map(t => String(t).toLowerCase()) : [];
  if (types.some(t => t.includes('medicare'))) return true;
  return /medicare/i.test(String(payer.primaryName || payer.name || ''));
};

const checkOrderingEnrollment = ({ orderType, client, orderingUser, acknowledgment }) => {
  if (!ENROLLMENT_GATED_TYPES.includes(String(orderType))) return { required: false, ok: true };
  if (!isMedicarePatient(client)) return { required: false, ok: true };
  const enrollment = normalizeMedicareEnrollment(orderingUser && orderingUser.medicareEnrollment);
  if (enrollment.status && ENROLLMENT_OK.includes(enrollment.status)) {
    return { required: true, ok: true, enrollment };
  }
  const who = (orderingUser && orderingUser.name) || 'The ordering clinician';
  const state = enrollment.status ? ENROLLMENT_LABELS[enrollment.status] : 'not recorded';
  const message = `${who} is ${state} in Medicare. Under 42 CFR 424.507 the ${orderType === DME ? "supplier's" : "performing facility's"} claim for this ${orderType} order will be denied because the ordering practitioner is not enrolled in approved status. Acknowledge and give a reason to place it anyway.`;
  const ack = (acknowledgment && typeof acknowledgment === 'object') ? acknowledgment : {};
  const reason = clean(ack.reason, 500);
  if (!ack.acknowledged || !reason) {
    return {
      required: true, ok: false, enrollment,
      error: message, code: 'ORDERING_PROVIDER_NOT_ENROLLED',
      needsReason: true
    };
  }
  return {
    required: true, ok: true, enrollment,
    // Recorded on the order. A warning acknowledged and not recorded is a
    // warning nobody can find afterwards, which is the same as no warning.
    acknowledgment: {
      acknowledged: true, reason,
      enrollmentStatus: enrollment.status || 'unrecorded',
      orderingClinicianId: (orderingUser && orderingUser.id) || null,
      orderingClinicianName: (orderingUser && orderingUser.name) || null
    }
  };
};

// ---- Recording the send -------------------------------------------------
// 'sent' IS NO LONGER REACHABLE FROM THE GENERIC STATUS ROUTE. A bare click
// that moved an order to "sent" recorded that somebody believed it had gone —
// not where it went, not to what number, and not on what channel. When the
// recipient is a fax number, that provenance IS the disclosure record.
//
// An order can be re-sent, and each send is its own row rather than an
// overwrite: a referral faxed to the wrong number and then to the right one is
// two disclosures, and only one of them is the one we meant.
const buildSendRecord = ({ input, actor, order, at }) => {
  const i = input || {};
  const channel = SEND_CHANNELS.includes(String(i.channel || '')) ? String(i.channel) : DEFAULT_SEND_CHANNEL;
  const recipientName = clean(i.recipientName, 160) || defaultRecipientName(order);
  if (!recipientName) return { error: 'Who it was sent to is required', code: 'SEND_NO_RECIPIENT' };
  // A fax number is required for the fax channels and meaningless for the
  // others — a portal submission has no fax number, and inventing one would put
  // a false number on a disclosure record.
  let recipientFax = null;
  if (FAX_SEND_CHANNELS.includes(channel)) {
    recipientFax = normalizeFax(i.recipientFax || defaultRecipientFax(order));
    if (!recipientFax) {
      return { error: 'A valid 10-digit fax number is required to record a fax send', code: 'SEND_BAD_FAX' };
    }
  }
  const now = at || new Date().toISOString();
  return {
    send: {
      channel,
      channelLabel: SEND_CHANNEL_LABELS[channel],
      recipientName,
      recipientFax,
      note: clean(i.note, 500) || null,
      sentAt: now,
      sentBy: { id: (actor && actor.id) || null, name: (actor && actor.name) || null },
      // Which requisition was actually sent. A re-generated requisition after an
      // edit is a different document, so the send names the one in hand.
      requisitionGeneratedAt: (order && order.requisitionGeneratedAt) || null
    }
  };
};
const defaultRecipientName = (order) => {
  if (!order) return '';
  if (order.orderType === REFERRAL) {
    const r = order.referral || {};
    return r.receivingPractice || r.receivingProvider || r.specialty || '';
  }
  if (order.orderType === DME) return (order.dme || {}).supplierName || '';
  return '';
};
const defaultRecipientFax = (order) => {
  if (!order) return '';
  if (order.orderType === REFERRAL) return (order.referral || {}).receivingFax || '';
  if (order.orderType === DME) return (order.dme || {}).supplierFax || '';
  return '';
};

// Applying a send: the status moves to 'sent' and the send row is appended.
// A cancelled or completed order is refused — "sent" after the fact is not a
// correction, it is a different event, and a resend of a live order is the
// thing this supports.
const SENDABLE_STATUSES = Object.freeze(['ordered', 'sent', 'scheduled']);
const applySend = ({ order, input, actor, at }) => {
  if (!order) return { error: 'Order not found', code: 'ORDER_NOT_FOUND', status: 404 };
  if (!SENDABLE_STATUSES.includes(String(order.status))) {
    return { error: `An order that is "${order.status}" cannot be recorded as faxed.`, code: 'ORDER_NOT_SENDABLE', status: 409 };
  }
  const built = buildSendRecord({ input, actor, order, at });
  if (built.error) return { ...built, status: 400 };
  const now = at || new Date().toISOString();
  const resend = (order.sends || []).length > 0;
  return {
    order: {
      ...order,
      status: 'sent',
      sends: [...(order.sends || []), built.send],
      lastSentAt: built.send.sentAt,
      statusHistory: [...(order.statusHistory || []), {
        status: 'sent', at: now, by: { id: (actor && actor.id) || null, name: (actor && actor.name) || null },
        note: `${resend ? 'Re-sent' : 'Sent'} by ${built.send.channelLabel} to ${built.send.recipientName}${built.send.recipientFax ? ` at ${formatFax(built.send.recipientFax)}` : ''}`
      }],
      updatedAt: now
    },
    send: built.send,
    resend
  };
};

// A referral's appointment date, recorded when the specialist's office calls
// back. This is the state a lab order has no equivalent of, and the reason a
// referral has its own transitions.
const applyReferralScheduled = ({ order, appointmentDate, actor, at }) => {
  if (!order) return { error: 'Order not found', code: 'ORDER_NOT_FOUND', status: 404 };
  if (order.orderType !== REFERRAL) {
    return { error: 'Only a referral is scheduled', code: 'ORDER_NOT_REFERRAL', status: 400 };
  }
  if (!(REFERRAL_TRANSITIONS[order.status] || []).includes('scheduled')) {
    return { error: `A referral that is "${order.status}" cannot be marked scheduled.`, code: 'ORDER_BAD_TRANSITION', status: 409 };
  }
  if (!isYmd(appointmentDate)) {
    return { error: 'An appointment date (YYYY-MM-DD) is required', code: 'REFERRAL_NO_APPOINTMENT_DATE', status: 400 };
  }
  const now = at || new Date().toISOString();
  return {
    order: {
      ...order, status: 'scheduled',
      referral: { ...(order.referral || {}), appointmentDate: String(appointmentDate) },
      statusHistory: [...(order.statusHistory || []), {
        status: 'scheduled', at: now, by: { id: (actor && actor.id) || null, name: (actor && actor.name) || null },
        note: `Appointment ${appointmentDate}`
      }],
      updatedAt: now
    }
  };
};

// ---- Overdue: the lost fax ----------------------------------------------
// THE LOST FAX IS THE FAILURE MODE OF A MANUAL WORKFLOW, and the harm is not
// that it was lost — it is that nobody noticed. An order sent and never
// answered looks exactly like an order working its way through a lab.
//
// Owner-confirmed thresholds. Named constants, in days, so changing one is a
// one-line edit rather than a hunt.
const OVERDUE_DAYS = Object.freeze({ lab: 7, imaging: 14, referral: 30, procedure: 14, dme: 14 });
const DAY_MS = 86400000;
const overdueThresholdFor = (orderType) => OVERDUE_DAYS[String(orderType)] ?? null;
// An order is overdue when it is SENT (not merely ordered — nothing is waiting
// on the outside world until it has gone) and no result has come back.
const isAwaitingResult = (order) => !!order && ['sent', 'scheduled'].includes(String(order.status));
const overdueAgeDays = (order, now) => {
  // The clock starts at the LAST send, not the first. A referral re-faxed to a
  // corrected number has been waiting since that fax, not since the one that
  // went nowhere — otherwise a corrected order reads as overdue on the day it
  // is finally sent properly.
  const lastSend = ((order && order.sends) || []).slice(-1)[0] || null;
  const sentAt = (order && order.lastSentAt) || (lastSend && lastSend.sentAt) || null;
  if (!sentAt) return null;
  const ms = new Date(now || Date.now()).getTime() - new Date(sentAt).getTime();
  return Number.isFinite(ms) ? Math.floor(ms / DAY_MS) : null;
};
const isOverdue = (order, now) => {
  if (!isAwaitingResult(order)) return false;
  const threshold = overdueThresholdFor(order.orderType);
  if (threshold == null) return false;
  const age = overdueAgeDays(order, now);
  return age != null && age >= threshold;
};
// The list, with the recipient and the fax number it went to, because the whole
// point of the screen is that somebody can pick up the phone.
const buildOverdueList = (orders, now) => (Array.isArray(orders) ? orders : [])
  .filter(o => isOverdue(o, now))
  .map(o => {
    const last = (o.sends || []).slice(-1)[0] || {};
    return {
      id: o.id, clientId: o.clientId, orderType: o.orderType, orderReference: o.orderReference,
      status: o.status, priority: o.priority,
      tests: o.tests || [],
      sentAt: o.lastSentAt || last.sentAt || null,
      ageDays: overdueAgeDays(o, now),
      thresholdDays: overdueThresholdFor(o.orderType),
      recipientName: last.recipientName || defaultRecipientName(o) || null,
      recipientFax: last.recipientFax || defaultRecipientFax(o) || null,
      channel: last.channel || null,
      orderingClinician: o.orderingClinician || null,
      encounterUuid: o.encounterUuid || null
    };
  })
  .sort((a, b) => (b.ageDays - a.ageDays) || String(a.orderReference).localeCompare(String(b.orderReference)));

// ---- The return-fax settings block --------------------------------------
// "Return results to:" on every requisition. THE NUMBER LIVES IN THE DATABASE,
// never in code: it changes the day GFC has an org fax line, and that must be a
// settings edit, not a deploy. `seedReturnFax` writes it ONLY IF UNSET, so a
// re-run, or a boot after an admin has changed it, never overwrites the admin's
// value.
const DEFAULT_RETURN_FAX_LABEL = 'Godwins Family Care — clinical';
const normalizeRequisitionSettings = (stored, fallback) => {
  const s = (stored && typeof stored === 'object') ? stored : {};
  const f = (fallback && typeof fallback === 'object') ? fallback : {};
  const fax = normalizeFax(s.returnFax);
  return {
    returnFax: fax,
    returnFaxFormatted: fax ? formatFax(fax) : null,
    returnFaxLabel: clean(s.returnFaxLabel, 120) || DEFAULT_RETURN_FAX_LABEL,
    requisitionPhone: clean(s.requisitionPhone, 40) || clean(f.phone, 40) || null,
    updatedAt: s.updatedAt || null,
    updatedBy: s.updatedBy || null
  };
};
// Returns { settings, changed, reason } — pure, so the boot path and the test
// exercise the same function rather than two copies of the rule.
const seedReturnFax = (stored, seedValue) => {
  const s = (stored && typeof stored === 'object') ? { ...stored } : {};
  const seed = normalizeFax(seedValue);
  if (!seed) return { settings: s, changed: false, reason: 'no valid seed value supplied' };
  if (normalizeFax(s.returnFax)) {
    return { settings: s, changed: false, reason: `already set to ${formatFax(s.returnFax)} — left alone` };
  }
  return {
    settings: { ...s, returnFax: seed, seededAt: new Date().toISOString(), seededFrom: 'migration' },
    changed: true,
    reason: `seeded ${formatFax(seed)}`
  };
};

// ---- The requisition filename ------------------------------------------
// GFC_[type]_[lastname]_[yyyymmdd]_[ref].pdf — through contentDisposition.js
// like every other download in this app, because a real surname breaks a
// hand-built header (a macOS screenshot filename once 500'd every document
// download in this repo).
const requisitionFileName = (order, client) => {
  const last = String(((client && client.intake) || {}).lastName || String((client && client.name) || '').trim().split(/\s+/).slice(-1)[0] || 'patient')
    .replace(/[^A-Za-z0-9-]/g, '') || 'patient';
  const ymd = String((order && (order.dme || {}).orderDate) || (order && order.createdAt) || new Date().toISOString()).slice(0, 10).replace(/-/g, '');
  const ref = String((order && order.orderReference) || '').replace(REF_PREFIX, '') || 'noref';
  return `GFC_${String((order && order.orderType) || 'order')}_${last}_${ymd}_${ref}.pdf`;
};

// Which OpenEMR document category a generated requisition files into. The chart
// must hold EXACTLY what was sent.
const REQUISITION_CATEGORY = '/Orders';

module.exports = {
  REFERRAL, DME, DOCUMENT_ORDER_TYPES,
  REFERRAL_STATUSES, REFERRAL_TRANSITIONS, URGENCIES,
  SEND_CHANNELS, DEFAULT_SEND_CHANNEL, FAX_SEND_CHANNELS, SEND_CHANNEL_LABELS, SENDABLE_STATUSES,
  normalizeFax, formatFax,
  REF_ALPHABET, REF_PREFIX, buildOrderReference, parseOrderReference,
  buildReferral, buildDmeOrder, REFERRAL_ATTACHMENT_KINDS,
  SWO_ELEMENTS, swoGaps, F2F_MONTHS, f2fWindowStart,
  ENROLLMENT_STATUSES, ENROLLMENT_LABELS, ENROLLMENT_OK, ENROLLMENT_GATED_TYPES,
  normalizeMedicareEnrollment, isMedicarePatient, checkOrderingEnrollment,
  buildSendRecord, applySend, applyReferralScheduled,
  defaultRecipientName, defaultRecipientFax,
  OVERDUE_DAYS, overdueThresholdFor, isAwaitingResult, overdueAgeDays, isOverdue, buildOverdueList,
  DEFAULT_RETURN_FAX_LABEL, normalizeRequisitionSettings, seedReturnFax,
  requisitionFileName, REQUISITION_CATEGORY,
  normalizeIcd10
};
