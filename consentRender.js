// ============================================================
// GODWINS FAMILY CARE — CONSENT RENDER DATA (Session 4.6, Scope G4)
//
// THE ONE-PASS RULE. A consent that needs a value RENDERS it from the client
// record for confirmation; it never re-collects it. The paper packet reached
// the same conclusion in 09/2026 by consolidating twelve repetitions of the
// same fields behind a single Client Information Face Sheet. This module is the
// app's face sheet: every `{ t:'data', source }` block in public/consent-text.js
// resolves here, from the client record, and nowhere else.
//
// ONE EXCEPTION, mirrored from the paper packet and no other: `clientIdentity`
// on roiProvider. That authorization leaves the building and reaches an outside
// provider who will never see the face sheet, so it carries the client's name
// and date of birth on its own.
//
// Pure functions over a client record — no I/O, no storage, no request context —
// so the portal (via the intake endpoint), the PDF generator, and the tests all
// read exactly the same values.
//
// TEST DATA ONLY until HIPAA-live.
// ============================================================

'use strict';

const money = (n) => {
  const v = Number(n);
  if (!isFinite(v)) return null;
  return '$' + v.toFixed(2).replace(/\.00$/, '');
};

const nonEmpty = (v) => v != null && String(v).trim() !== '';
const row = (label, value) => (nonEmpty(value) ? { label, value: String(value).trim() } : null);
const rows = (list) => list.filter(Boolean);

const clientName = (client) => {
  const i = client.intake || {};
  return client.name || [i.firstName, i.lastName].filter(Boolean).join(' ') || client.preferredName || '';
};

const addressLine = (addr) => {
  const a = addr || {};
  const street = [a.line1, a.line2].filter(nonEmpty).join(', ');
  const town = [a.city, a.state].filter(nonEmpty).join(', ');
  return [street, town, a.zip].filter(nonEmpty).join(' ').trim();
};

// ── The agreed rate table (Scope B2) ────────────────────────────────
// Lives on `client.rateAgreement`, set by an admin. There is no default and no
// fallback: a rate nobody agreed to is worse than a blocked consent, because
// the client would be signing a price the agency invented.
const RATE_FIELDS = ['hourlyRate', 'dailyMinimumHours'];

const hasRateAgreement = (client) => {
  const r = (client && client.rateAgreement) || {};
  return RATE_FIELDS.every(k => nonEmpty(r[k]) && Number(r[k]) > 0);
};

const rateTable = (client) => {
  const r = (client && client.rateAgreement) || {};
  if (!hasRateAgreement(client)) {
    return {
      blocked: true,
      code: 'RATE_NOT_SET',
      message: 'No agreed rate is on file for this client, so the financial agreement cannot be presented. An administrator sets the hourly rate and daily minimum on the client’s enrollment record first.',
      rows: []
    };
  }
  const min = Number(r.dailyMinimumHours);
  return {
    blocked: false,
    rows: rows([
      row('Hourly rate', money(r.hourlyRate) + ' per hour'),
      row('Daily minimum', min + (min === 1 ? ' hour' : ' hours') + ' on any day care is provided'),
      row('What is included', r.includedServices || 'Every service listed in your Service Agreement and plan of care, at the same hourly rate. There is no separate charge per task.'),
      row('Holidays', r.holidayTreatment || 'Billed at the standard hourly rate.'),
      row('Errand fuel and mileage', r.errandFuel || 'Not billed separately. Travel between the caregiver’s home and yours is never billed to you.'),
      row('Invoices', r.invoiceCadence || 'Every two weeks, due within fourteen days of the invoice date.'),
      row('Cancellation window', (r.cancellationWindowHours || 24) + ' hours notice; a later cancellation may be billed at the daily minimum.'),
      row('Notice before a rate change', (r.rateChangeNoticeDays || 30) + ' days written notice.'),
      row('Effective', r.effectiveDate || null)
    ])
  };
};

// ── Every other data source ─────────────────────────────────────────
const SOURCES = {
  parties: (client) => {
    const i = client.intake || {};
    const pc = i.primaryContact || {};
    return rows([
      row('Client', clientName(client)),
      row('Date of birth', i.dob || client.dob),
      row('Residence', addressLine(i.address)),
      row('Phone', i.phone || client.phone),
      row('Representative', nonEmpty(pc.name) ? pc.name + (nonEmpty(pc.relationship) ? ' (' + pc.relationship + ')' : '') : null),
      row('Representative phone', pc.phone)
    ]);
  },

  // The one-pass EXCEPTION — this document leaves the building.
  clientIdentity: (client) => {
    const i = client.intake || {};
    return rows([
      row('Client name', clientName(client)),
      row('Date of birth', i.dob || client.dob),
      row('Address', addressLine(i.address)),
      row('Phone', i.phone || client.phone)
    ]);
  },

  rateTable,

  schedule: (client) => {
    const s = (client.intake || {}).schedule || {};
    return rows([
      row('Requested start', s.startDate || s.start),
      row('Hours per week', s.hoursPerWeek || s.hours),
      row('Days', Array.isArray(s.days) ? s.days.join(', ') : s.days),
      row('Recurring', s.recurring),
      row('Urgency', s.urgency)
    ]);
  },

  ltcPolicy: (client) => {
    const l = (client.intake || {}).ltc || {};
    return rows([
      row('Carrier', l.carrier === 'Other' ? (l.carrierOther || 'Other') : l.carrier),
      row('Policy number', l.policyNum),
      row('Policy holder', l.policyHolder),
      row('Daily / monthly benefit', l.benefit),
      row('Elimination period', l.elimination)
    ]);
  },

  careCoordinationContacts: (client) => {
    const i = client.intake || {};
    const mt = i.medicalTeam || {};
    const pc = i.primaryContact || {};
    return rows([
      row('Primary contact', nonEmpty(pc.name) ? pc.name + (nonEmpty(pc.relationship) ? ' (' + pc.relationship + ')' : '') : null),
      row('Primary care provider', [mt.pcpName, mt.pcpPractice].filter(nonEmpty).join(', ')),
      row('Specialist', mt.specialist1Name),
      row('Specialist', mt.specialist2Name),
      row('Pharmacy', [mt.preferredPharmacy, mt.pharmacyPhone].filter(nonEmpty).join(' · ')),
      row('Preferred hospital', mt.preferredHospital)
    ]);
  },

  advanceDirective: (client) => {
    const ad = (client.intake || {}).advanceDirective || client.advanceDirective || {};
    return rows([
      row('On file', ad.status || 'Not recorded'),
      row('Copy provided', (client.intake || {}).advanceDirectiveUrl ? 'Yes — on file with Godwins Family Care' : null)
    ]);
  },

  faceSheetEmergency: (client) => {
    const i = client.intake || {};
    const mt = i.medicalTeam || {};
    const contacts = Array.isArray(i.emergencyContacts) ? i.emergencyContacts.filter(c => c && nonEmpty(c.name)) : [];
    return rows([
      ...contacts.map((c, n) => row('Emergency contact ' + (n + 1),
        c.name + (nonEmpty(c.relationship) ? ' (' + c.relationship + ')' : '') + (nonEmpty(c.phone) ? ' · ' + c.phone : ''))),
      row('Primary care provider', [mt.pcpName, mt.pcpPhone].filter(nonEmpty).join(' · ')),
      row('Preferred hospital', mt.preferredHospital),
      row('Pharmacy', [mt.preferredPharmacy, mt.pharmacyPhone].filter(nonEmpty).join(' · ')),
      row('Allergies', i.allergies || client.allergies || 'None reported')
    ]);
  },

  // Scope B5 — the notify-first contact and the order the caregiver works down.
  callOrder: (client) => {
    const i = client.intake || {};
    const mt = i.medicalTeam || {};
    const pc = i.primaryContact || {};
    const contacts = Array.isArray(i.emergencyContacts) ? i.emergencyContacts.filter(c => c && nonEmpty(c.name)) : [];
    return rows([
      row('Notify first', i.crisisNotify),
      row('911 authorization', i.auth911),
      row('Then', nonEmpty(pc.name) ? pc.name + (nonEmpty(pc.phone) ? ' · ' + pc.phone : '') : null),
      ...contacts.map((c, n) => row('Then', c.name + (nonEmpty(c.phone) ? ' · ' + c.phone : ''))),
      row('Primary care provider', [mt.pcpName, mt.pcpPhone].filter(nonEmpty).join(' · ')),
      row('Preferred hospital', mt.preferredHospital),
      row('Entry instructions for responders', i.entryInstructions || i.homeAccessNotes),
      row('Pets in the home', Array.isArray(i.homeSafetyFlags) && i.homeSafetyFlags.includes('pets') ? 'Yes' : (i.pets || null))
    ]);
  },

  roiFamilyDetail: (client) => {
    const d = (client.intake || {}).roiFamilyDetail || {};
    return rows([
      row('Authorized to receive information', d.authorized),
      row('Restrictions', d.restrictions || 'None stated')
    ]);
  },

  priorProviders: (client) => {
    const list = Array.isArray(client.priorProviders) ? client.priorProviders : [];
    if (!list.length) return [];
    return list.filter(pp => pp && nonEmpty(pp.name)).map(pp =>
      row(pp.roleLabel === 'hospital' ? 'Hospital' : (pp.roleLabel === 'pcp' ? 'Primary care' : 'Provider'),
        pp.name + (nonEmpty(pp.dept) ? ' — ' + pp.dept : '') + (nonEmpty(pp.phone) ? ' · ' + pp.phone : ''))
    ).filter(Boolean);
  },

  coverage: (client) => {
    const i = client.intake || {};
    const payer = client.payer || i.payer || {};
    const ids = Array.isArray(payer.insuranceIds) ? payer.insuranceIds : [];
    return rows([
      row('Payer type', payer.type),
      row('Medicare', (i.medicare || {}).number ? 'On file' : null),
      ...ids.filter(x => x && nonEmpty(x.carrier)).map(x =>
        row(x.carrier, [x.memberId ? 'Member ' + x.memberId : '', x.group ? 'Group ' + x.group : ''].filter(Boolean).join(' · ') || 'On file')),
      row('Billing contact', i.billingContact)
    ]);
  },

  responsibleParty: (client) => {
    const i = client.intake || {};
    const rp = i.responsibleParty || {};
    const pc = i.primaryContact || {};
    const name = rp.name || (rp.sameAsPrimaryContact ? pc.name : null);
    if (!nonEmpty(name)) {
      return [{ label: 'Responsible party', value: 'None — the client is financially responsible.' }];
    }
    return rows([
      row('Responsible party', name + (nonEmpty(rp.relationship || pc.relationship) ? ' (' + (rp.relationship || pc.relationship) + ')' : '')),
      row('Phone', rp.phone || pc.phone),
      row('Address', addressLine(rp.address) || addressLine(i.address))
    ]);
  }
};

/**
 * Resolve one `{ t:'data', source }` block against a client record.
 * Returns { rows: [{label,value}], blocked?, code?, message? }.
 * An unknown source resolves to empty rather than throwing — a body must never
 * be un-renderable because of a typo in a block.
 */
function resolveDataSource(source, client) {
  const fn = SOURCES[source];
  if (!fn) return { rows: [] };
  const out = fn(client || {});
  return Array.isArray(out) ? { rows: out } : out;
}

/**
 * Resolve every data block a consent body needs, keyed by source, so the portal
 * can be handed one object per consent and the PDF can render the same values.
 */
function resolveForConsent(consentText, type, client) {
  const out = {};
  consentText.dataSourcesFor(type).forEach(src => { out[src] = resolveDataSource(src, client); });
  return out;
}

/**
 * Is this consent presentable to the client right now? A consent whose body
 * renders data that is blocked (today: the rate table) MUST NOT be shown or
 * signed — the client would otherwise be signing around an empty box.
 */
function presentability(consentText, type, client) {
  const resolved = resolveForConsent(consentText, type, client);
  const blocked = Object.keys(resolved).map(k => resolved[k]).find(v => v && v.blocked);
  if (blocked) return { presentable: false, code: blocked.code, message: blocked.message };
  return { presentable: true, code: null, message: null };
}

module.exports = {
  SOURCES,
  RATE_FIELDS,
  hasRateAgreement,
  resolveDataSource,
  resolveForConsent,
  presentability,
  clientName,
  addressLine
};
