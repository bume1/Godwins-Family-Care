// ============================================================================
// assessmentRequests.js — the website's free assessment, in the app
// (owner, 2026-11-25). Pure rules only; the routes live in server.js.
//
// The free assessment is the practice's front door. It used to be pages 1–4
// of the old WordPress form, posted to an Apps Script that wrote a Google
// Sheet row and a PDF shared with ANYONE WHO HAD THE LINK. It now saves
// straight into the app's own database, and the office works it from a queue
// on the Clients page.
//
// SHORT ON PURPOSE (owner, 2026-11-25): "only ask what's absolutely
// necessary... boom, boom, boom, submit." Who is asking, who the care is
// for, where they live, what they want, how it is paid for, and a few fit
// questions (bed-bound, two-person assist, memory). Everything else is asked
// at intake, after the office has called.
//
// A SUBMISSION IS A LEAD, NOT AN ACCOUNT. Anyone on the internet can send
// one, so nothing in it can sign in or see anything. Staff call the family,
// and when it is a fit they convert it into a client at intake_pending.
// ============================================================================

// The answers use the intake's own option catalogs (public/intake-fields.js),
// so a converted lead carries straight across. A second copy of the options
// is how the two start to differ.
const IF = require('./public/intake-fields.js');
const OPTIONS = Object.freeze({
  relationship: IF.OPTIONS.contactRelationship,
  usState: IF.OPTIONS.usState,
  servicePath: IF.OPTIONS.servicePath,
  insuranceTypes: IF.OPTIONS.insuranceTypes,
  medicaidWaiver: IF.OPTIONS.medicaidWaiver,
  ambulation: IF.OPTIONS.adlWalking,
  twoPersonAssist: IF.OPTIONS.twoPersonAssist,
  cognitionLevel: IF.OPTIONS.cognitionLevel,
  urgency: IF.OPTIONS.urgency
});
for (const [k, v] of Object.entries(OPTIONS)) {
  if (!Array.isArray(v) || !v.length) throw new Error(`assessmentRequests: intake-fields has no option list for ${k}`);
}
// Who is filling it in. Not an intake question (the intake is always the
// client's own record), so it is the one list declared here.
const WHO = Object.freeze(['client', 'family']);
// The insurance answers that mean Medicaid, so the waiver question applies.
const MEDICAID_TYPES = Object.freeze(['Medicaid', 'Dual eligible']);

// Where the office is with a lead. A lead is never deleted; "not a fit" and
// "converted" are where it ends.
const STATUSES = Object.freeze({
  new: 'New',
  contacted: 'Contacted',
  scheduled: 'Assessment scheduled',
  converted: 'Converted to client',
  not_a_fit: 'Not a fit'
});
const OPEN_STATUSES = Object.freeze(['new', 'contacted', 'scheduled']);
// Converting is its own action (it creates a client), so it is not settable here.
const SETTABLE_STATUSES = Object.freeze(['new', 'contacted', 'scheduled', 'not_a_fit']);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const clean = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
const cleanText = (v, max) => String(v == null ? '' : v).replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
const digits = (v) => String(v == null ? '' : v).replace(/\D/g, '');
const phoneOk = (p) => p.length === 10 || (p.length === 11 && p[0] === '1');

// An answer that was never offered is refused BY NAME, never dropped:
// silence would tell the family it was saved.
const BAD = 'That answer is not one of the choices for this question.';
function pickOne(b, key, list, fail, required, missing) {
  const v = clean(b[key], 120);
  if (!v) return required ? { error: fail(key, 'ASSESSMENT_REQUIRED', missing) } : { value: '' };
  if (!list.includes(v)) return { error: fail(key, 'ASSESSMENT_BAD_OPTION', BAD) };
  return { value: v };
}
function pickMany(b, key, list, fail) {
  const raw = Array.isArray(b[key]) ? b[key] : (b[key] ? [b[key]] : []);
  const out = [];
  for (const x of raw) {
    const v = clean(x, 120);
    if (!v) continue;
    if (!list.includes(v)) return { error: fail(key, 'ASSESSMENT_BAD_OPTION', BAD) };
    if (!out.includes(v)) out.push(v);
  }
  return { value: out };
}

// Everything the form sends, checked. Returns { value } or { error, code, field }.
// Required: who is asking, the client's name, date of birth and address, a
// phone or email, what they want, how it is paid for, and the three fit
// questions. Each is one tap or one line.
function normalizeAssessment(body, { today } = {}) {
  const b = body || {};
  const fail = (field, code, error) => ({ field, code, error });

  const who = clean(b.who, 10);
  if (!WHO.includes(who)) return fail('who', 'ASSESSMENT_WHO', 'Tell us whether you are the person who needs care or a family member.');
  const isClient = who === 'client';

  const clientFirst = clean(b.clientFirst, 60);
  const clientLast = clean(b.clientLast, 60);
  if (!clientFirst || !clientLast) return fail(!clientFirst ? 'clientFirst' : 'clientLast', 'ASSESSMENT_CLIENT_NAME', 'Enter the first and last name of the person who needs care.');
  const dob = clean(b.dob, 10);
  if (!ISO_DATE.test(dob) || Number.isNaN(Date.parse(dob))) return fail('dob', 'ASSESSMENT_DOB', 'Enter their date of birth.');
  if ((today && dob > today) || dob < '1900-01-01') return fail('dob', 'ASSESSMENT_DOB', 'Check the date of birth.');

  const line1 = clean(b.addressLine1, 200);
  const city = clean(b.city, 80);
  if (!line1) return fail('addressLine1', 'ASSESSMENT_ADDRESS', 'Enter their street address.');
  if (!city) return fail('city', 'ASSESSMENT_ADDRESS', 'Enter their city.');
  const state = pickOne(b, 'state', OPTIONS.usState, fail, true, 'Choose their state.');
  if (state.error) return state.error;
  const zip = digits(b.zip).slice(0, 9);
  if (!(zip.length === 5 || zip.length === 9)) return fail('zip', 'ASSESSMENT_ZIP', 'Enter a 5-digit ZIP code.');

  // The person filling it in. A client is themselves; a family member gives
  // their own name and how they are related.
  const submitterFirst = isClient ? clientFirst : clean(b.submitterFirst, 60);
  const submitterLast = isClient ? clientLast : clean(b.submitterLast, 60);
  if (!submitterFirst || !submitterLast) return fail(!submitterFirst ? 'submitterFirst' : 'submitterLast', 'ASSESSMENT_SUBMITTER_NAME', 'Enter your first and last name.');
  let relationship = '';
  if (!isClient) {
    const r = pickOne(b, 'relationship', OPTIONS.relationship, fail, true, 'Choose how you are related to them.');
    if (r.error) return r.error;
    relationship = r.value;
  }
  const email = clean(b.email, 254).toLowerCase();
  if (email && !EMAIL_RE.test(email)) return fail('email', 'ASSESSMENT_EMAIL', 'Enter a valid email address.');
  const phone = digits(b.phone);
  if (phone && !phoneOk(phone)) return fail('phone', 'ASSESSMENT_PHONE', 'Enter a 10-digit phone number.');
  if (!email && !phone) return fail('phone', 'ASSESSMENT_CONTACT_REQUIRED', 'Give us a phone number or an email address so we can reach you.');

  const servicePath = pickOne(b, 'servicePath', OPTIONS.servicePath, fail, true, 'Choose the kind of care you are interested in.');
  if (servicePath.error) return servicePath.error;
  const insurance = pickMany(b, 'insuranceTypes', OPTIONS.insuranceTypes, fail);
  if (insurance.error) return insurance.error;
  if (!insurance.value.length) return fail('insuranceTypes', 'ASSESSMENT_REQUIRED', 'Choose how care would be paid for. Pick "Private pay only" if there is no coverage.');
  let medicaidWaiver = '';
  if (insurance.value.some(t => MEDICAID_TYPES.includes(t))) {
    const w = pickOne(b, 'medicaidWaiver', OPTIONS.medicaidWaiver, fail, false);
    if (w.error) return w.error;
    medicaidWaiver = w.value;
  }

  const fit = {};
  for (const [key, missing] of [
    ['ambulation', 'Tell us how they get around.'],
    ['twoPersonAssist', 'Tell us whether moving them takes two people.'],
    ['cognitionLevel', 'Tell us about any memory or thinking concerns.']
  ]) {
    const r = pickOne(b, key, OPTIONS[key], fail, true, missing);
    if (r.error) return r.error;
    fit[key] = r.value;
  }
  const urgency = pickOne(b, 'urgency', OPTIONS.urgency, fail, false);
  if (urgency.error) return urgency.error;

  return {
    value: {
      who,
      client: { firstName: clientFirst, lastName: clientLast, dob, address: { line1, city, state: state.value, zip: zip.slice(0, 5) } },
      submitter: { firstName: submitterFirst, lastName: submitterLast, isClient, relationship, email, phone },
      care: { servicePath: servicePath.value },
      coverage: { insuranceTypes: insurance.value, medicaidWaiver },
      fit,
      schedule: { urgency: urgency.value },
      familyNote: cleanText(b.notes, 1000)
    }
  };
}

// Answers that usually mean GFC cannot safely staff the case, flagged for the
// office to look at on the call. A flag never declines anyone: a family may
// have a second person in the home, and that is a conversation.
function fitFlags(row) {
  const f = row.fit || {};
  const out = [];
  if (f.ambulation === 'Bed-bound') out.push('Bed-bound');
  if (f.twoPersonAssist === 'Yes routinely') out.push('Needs two-person assist');
  else if (f.twoPersonAssist === 'Sometimes') out.push('Sometimes needs two-person assist');
  if (f.cognitionLevel === 'Significant') out.push('Significant memory concerns');
  return out;
}

function buildRow({ id, value, at, ipHash }) {
  return {
    id, ...value,
    status: 'new', statusHistory: [{ status: 'new', at, by: null }],
    notes: [], createdAt: at, updatedAt: at, ipHash: ipHash || null, source: 'website_free_assessment'
  };
}

const clientName = (row) => `${row.client.firstName} ${row.client.lastName}`.trim();
const submitterName = (row) => `${row.submitter.firstName} ${row.submitter.lastName}`.trim();

// Most urgent first among open leads, then newest. An "Immediately" from a
// family at their breaking point should not sit under last week's browsers.
const URGENCY_RANK = { 'Immediately': 0, 'Within a week': 1, 'Within a month': 2, 'Just exploring': 3, '': 4 };
function sortForQueue(rows) {
  return [...rows].sort((a, b) => {
    const ao = OPEN_STATUSES.includes(a.status) ? 0 : 1;
    const bo = OPEN_STATUSES.includes(b.status) ? 0 : 1;
    if (ao !== bo) return ao - bo;
    if (ao === 0) {
      const u = (URGENCY_RANK[a.schedule.urgency] ?? 4) - (URGENCY_RANK[b.schedule.urgency] ?? 4);
      if (u) return u;
    }
    return String(b.createdAt).localeCompare(String(a.createdAt));
  });
}

// A status change, a note, or both. Checked in one place so the route cannot drift.
function checkUpdate(row, { status, note }) {
  if (!row) return { error: 'Assessment not found.', code: 'ASSESSMENT_NOT_FOUND' };
  if (row.status === 'converted') return { error: 'This assessment was already converted to a client. Work it from the client record.', code: 'ASSESSMENT_CONVERTED' };
  const hasStatus = status != null && status !== '';
  const text = cleanText(note, 2000);
  if (!hasStatus && !text) return { error: 'Choose a status or write a note.', code: 'ASSESSMENT_UPDATE_EMPTY' };
  if (hasStatus && !SETTABLE_STATUSES.includes(status)) return { error: `Status must be one of: ${SETTABLE_STATUSES.join(', ')}.`, code: 'ASSESSMENT_BAD_STATUS' };
  if (hasStatus && status === 'not_a_fit' && !text) return { error: 'Write a short note saying why it is not a fit.', code: 'ASSESSMENT_REASON_REQUIRED' };
  return null;
}

function applyUpdate(row, { status, note }, { at, by }) {
  const next = { ...row, statusHistory: [...(row.statusHistory || [])], notes: [...(row.notes || [])], updatedAt: at };
  const text = cleanText(note, 2000);
  if (status && status !== row.status) {
    next.status = status;
    next.statusHistory.push({ status, at, by });
  }
  if (text) next.notes.push({ at, by, text });
  return next;
}

// The free assessment's answer about what service they want, mapped to the
// service line the intake starts on. "Not sure" leaves it unset, as a sign-up
// does, so the intake's own first step asks.
function serviceLineFor(servicePath) {
  if (servicePath === 'In-Home Primary Care') return 'IHPC';
  if (servicePath === 'Both') return 'BOTH';
  if (servicePath === 'Home Care') return 'PHC';
  return null;
}

// What a converted lead pre-fills on the client's intake, in the intake's own
// paths (public/intake-fields.js), so the family is not asked twice.
function intakeFor(row) {
  const c = row.client;
  const s = row.submitter;
  const put = (o, k, v) => { if (v != null && v !== '' && !(Array.isArray(v) && !v.length)) o[k] = v; return o; };
  const out = {
    clientFirst: c.firstName, clientLast: c.lastName, firstName: c.firstName, lastName: c.lastName,
    submitter: { first: s.firstName, last: s.lastName, email: s.email, phone: s.phone },
    source: 'free_assessment', assessmentRequestId: row.id
  };
  put(out, 'dob', c.dob);
  out.address = {};
  put(out.address, 'line1', c.address.line1); put(out.address, 'city', c.address.city);
  put(out.address, 'state', c.address.state); put(out.address, 'zip', c.address.zip);
  put(out, 'addressLine1', c.address.line1);
  // A client filling it in for themselves is their own phone; a family member
  // is the primary contact.
  if (s.isClient) put(out, 'phone', s.phone);
  else out.primaryContact = { name: submitterName(row), relationship: s.relationship || '', phone: s.phone || '', email: s.email || '', preferredChannel: '' };
  put(out, 'insuranceTypes', row.coverage.insuranceTypes);
  if (row.coverage.medicaidWaiver) out.medicaid = { waiver: row.coverage.medicaidWaiver };
  out.adl = {};
  put(out.adl, 'ambulation', row.fit.ambulation);
  if (!Object.keys(out.adl).length) delete out.adl;
  put(out, 'twoPersonAssist', row.fit.twoPersonAssist);
  out.situation = {};
  put(out.situation, 'cognitionLevel', row.fit.cognitionLevel);
  put(out.situation, 'mainReason', row.familyNote);
  if (!Object.keys(out.situation).length) delete out.situation;
  out.schedule = {};
  put(out.schedule, 'urgency', row.schedule.urgency);
  if (!Object.keys(out.schedule).length) delete out.schedule;
  return out;
}

// What staff see. Never the hashed address.
function staffRow(row) {
  const { ipHash, ...rest } = row; // eslint-disable-line no-unused-vars
  return { ...rest, clientName: clientName(row), submitterName: submitterName(row), statusLabel: STATUSES[row.status] || row.status, fitFlags: fitFlags(row) };
}

module.exports = {
  OPTIONS, STATUSES, OPEN_STATUSES, SETTABLE_STATUSES,
  normalizeAssessment, buildRow, sortForQueue, checkUpdate, applyUpdate,
  serviceLineFor, intakeFor, fitFlags, staffRow, clientName, submitterName
};
