// ============================================================================
// portalProfile.js — the patient's own Profile screen (portal redesign,
// owner mockup 9, 10/2026). Pure: builds what the screen shows from the
// client record. Read by the patient and a designated POA only.
//
// MEMBER IDS SHOW THE LAST FOUR ONLY. The screen may be open on a shared
// phone or a family computer, and the full ID is what a fraudster needs. The
// office holds the full number; the patient's card does too.
// ============================================================================

const last4 = (v) => {
  const s = String(v == null ? '' : v).replace(/\s+/g, '');
  return s.length >= 4 ? s.slice(-4) : null;
};
const str = (v) => (v == null ? '' : String(v).trim());

// One line per kind of coverage on file. Nothing is listed that is not there.
function coverageForPatient(client) {
  const p = (client && client.payer) || {};
  const intake = (client && client.intake) || {};
  const pick = (k) => (p[k] && typeof p[k] === 'object' ? p[k] : (intake[k] && typeof intake[k] === 'object' ? intake[k] : {}));
  const out = [];
  const mc = pick('medicare');
  if (str(mc.advantagePlan) || str(mc.advMemberId)) {
    out.push({ kind: 'Medicare Advantage', plan: str(mc.advantagePlan) || null, memberIdLast4: last4(mc.advMemberId), group: str(mc.advGroupNum) || null });
  }
  if (str(mc.id)) out.push({ kind: 'Medicare', plan: str(mc.type) || null, memberIdLast4: last4(mc.id), group: null });
  const md = pick('medicaid');
  if (str(md.memberId) || str(md.plan)) out.push({ kind: 'Medicaid', plan: str(md.plan) || str(md.waiver) || null, memberIdLast4: last4(md.memberId), group: null });
  const cm = pick('commercial');
  if (str(cm.carrier) || str(cm.memberId)) out.push({ kind: str(cm.carrier) || 'Insurance', plan: str(cm.planName) || null, memberIdLast4: last4(cm.memberId), group: str(cm.groupNum) || null });
  const ltc = pick('ltc');
  const ltcCarrier = str(ltc.carrier) === 'Other' ? str(ltc.carrierOther) : str(ltc.carrier);
  if (ltcCarrier || str(ltc.policyNum)) out.push({ kind: 'Long-term care insurance', plan: ltcCarrier || null, memberIdLast4: last4(ltc.policyNum), group: null });
  const cards = Array.isArray(p.insuranceIds) ? p.insuranceIds : (Array.isArray(intake.insuranceIds) ? intake.insuranceIds : []);
  for (const c of cards) {
    if (!c || !(str(c.carrier) || str(c.memberId))) continue;
    const l4 = last4(c.memberId);
    // The same card typed twice (block + list) is listed once.
    if (out.some(o => o.memberIdLast4 && o.memberIdLast4 === l4)) continue;
    out.push({ kind: str(c.carrier) || 'Insurance', plan: null, memberIdLast4: l4, group: str(c.group) || null });
  }
  return out;
}

const addressLine = (a) => {
  if (!a) return null;
  if (typeof a === 'string') return str(a) || null;
  const line = [str(a.street || a.line1), str(a.line2 || a.unit), str(a.city), [str(a.state), str(a.zip)].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return line || null;
};

function profileForPatient(client, loginUser) {
  const intake = (client && client.intake) || {};
  const name = str(client && (client.name)) || [str(intake.firstName), str(intake.lastName)].filter(Boolean).join(' ');
  return {
    name: name || null,
    preferredName: str(intake.preferredName || (client && client.preferredName)) || null,
    dateOfBirth: str(intake.dob || intake.dateOfBirth) || null,
    phone: str(intake.phone || (client && client.phone)) || null,
    email: str(loginUser && loginUser.email) || null,
    address: addressLine(intake.address || (client && client.address)),
    primaryContact: intake.primaryContact && str(intake.primaryContact.name)
      ? { name: str(intake.primaryContact.name), relationship: str(intake.primaryContact.relationship) || null, phone: str(intake.primaryContact.phone) || null }
      : null,
    coverage: coverageForPatient(client),
    // What the edit form starts from: the stored parts, never a joined line.
    edit: {
      preferredName: str(intake.preferredName),
      phone: str(intake.phone || (client && client.phone)),
      email: str(loginUser && loginUser.email),
      address: (() => {
        const a = intake.address && typeof intake.address === 'object' ? intake.address : {};
        return { line1: str(a.line1 || a.street), line2: str(a.line2 || a.unit), city: str(a.city), state: str(a.state), zip: str(a.zip) };
      })(),
      primaryContact: (() => {
        const pc = intake.primaryContact || {};
        return { name: str(pc.name), relationship: str(pc.relationship), phone: str(pc.phone), email: str(pc.email) };
      })()
    }
  };
}

// ---- What a patient (or POA) may change themselves (owner, 2026-10-13) ----
// Contact details only. Name, date of birth, insurance, the medical team and
// everything clinical stay with the office: those print onto signed consents
// and claims, and a change there is a correction staff make.
const PATIENT_EDITABLE_PATHS = Object.freeze([
  'preferredName', 'phone',
  'address.line1', 'address.line2', 'address.city', 'address.state', 'address.zip',
  'primaryContact.name', 'primaryContact.relationship', 'primaryContact.phone', 'primaryContact.email'
]);
// The fields OpenEMR's own demographics carry; a change to one of these is
// sent to the chart (with a clinician's sign-in, since a patient has none).
const EMR_CONTACT_PATHS = Object.freeze(['phone', 'address.line1', 'address.line2', 'address.city', 'address.state', 'address.zip', 'email']);

const getPath = (o, path) => path.split('.').reduce((x, k) => (x == null ? undefined : x[k]), o);

// Keep only the allowed fields, nested the way the enrollment editor reads
// them. Anything else in the body is ignored and named back.
function pickPatientEdits(body) {
  const out = {};
  const ignored = [];
  const b = body || {};
  for (const path of PATIENT_EDITABLE_PATHS) {
    const v = Object.prototype.hasOwnProperty.call(b, path) ? b[path] : getPath(b, path);
    if (v === undefined) continue;
    const parts = path.split('.');
    let cur = out;
    while (parts.length > 1) { const k = parts.shift(); cur[k] = cur[k] || {}; cur = cur[k]; }
    cur[parts[0]] = v == null ? '' : String(v).slice(0, 200);
  }
  const allowedTop = new Set(['email', 'preferredName', 'phone', 'address', 'primaryContact']);
  Object.keys(b).forEach(k => { if (!allowedTop.has(k) && !PATIENT_EDITABLE_PATHS.includes(k)) ignored.push(k); });
  return { edits: out, ignored };
}

// The patient's address as one line, for the places that print one.
const composedAddress = (a) => {
  const x = a || {};
  return [str(x.line1), str(x.line2), str(x.city), [str(x.state), str(x.zip)].filter(Boolean).join(' ')].filter(Boolean).join(', ');
};

// OpenEMR's standard-API patient fields for the contact details.
function emrContactFrom(intake, email) {
  const a = (intake && intake.address) || {};
  return {
    phone_home: str(intake && intake.phone) || undefined,
    street: [str(a.line1), str(a.line2)].filter(Boolean).join(' ') || undefined,
    city: str(a.city) || undefined,
    state: str(a.state) || undefined,
    postal_code: str(a.zip) || undefined,
    email: str(email) || undefined
  };
}

const TITLES = /^(mr|mrs|ms|miss|mx|dr|rev|sir|madam)\.?$/i;
function greetingName(client) {
  const c = client || {};
  const intake = c.intake || {};
  const preferred = str(c.preferredName || intake.preferredName);
  if (preferred) return preferred.slice(0, 40);
  const first = str(intake.firstName || intake.clientFirst);
  if (first) return first;
  const words = str(c.name).split(/\s+/).filter(Boolean);
  const w = words.find(x => !TITLES.test(x));
  return w || 'there';
}

module.exports = { profileForPatient, coverageForPatient, last4, greetingName, PATIENT_EDITABLE_PATHS, EMR_CONTACT_PATHS, pickPatientEdits, composedAddress, emrContactFrom };
