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
    coverage: coverageForPatient(client)
  };
}

module.exports = { profileForPatient, coverageForPatient, last4 };
