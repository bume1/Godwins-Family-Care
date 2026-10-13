// referralDirectory.js — the running list of outside providers GFC refers to
// (owner, 2026-10-12).
//
// Every outside referral used to be typed from scratch: practice, provider,
// specialty and fax, each time. The list remembers them. Three rules shape it:
//
//   1. A SAVED FAX IS A STANDING INSTRUCTION ABOUT WHERE PHI GOES. If a practice
//      changes its fax and the entry does not, every referral after that goes to
//      the wrong place without anyone typing anything. So an entry is never
//      changed by placing a referral: what the clinician types on the referral
//      changes THAT referral only. Editing the entry is its own step, and
//      changing its fax needs a reason, kept in the entry's history.
//   2. DUPLICATES ARE CAUGHT BY FAX, NOT BY NAME. "Atlanta Cardiology" and
//      "Atlanta Cardiology Assoc." are one place with one fax. Two doctors at one
//      practice can share a fax too, so a match is not refused outright: it is
//      shown, and saving a second entry anyway is a deliberate `confirmDistinct`.
//   3. NOTHING HERE IS PHI. It is the address book of other practices, not of
//      patients, so it carries no client id and nothing about who was referred.
'use strict';

const { normalizeFax, formatFax } = require('./orderRequisitions');

const clean = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const FIELDS = Object.freeze([
  { key: 'name', label: 'Provider', max: 160 },
  { key: 'practice', label: 'Practice', max: 160 },
  { key: 'specialty', label: 'Specialty', max: 120 },
  { key: 'fax', label: 'Fax', fax: true },
  { key: 'phone', label: 'Phone', max: 40 }
]);
const stamp = (actor) => ({ id: (actor && actor.id) || null, name: (actor && (actor.name || actor.email)) || null });
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// A new entry. A practice or a provider name is required (something to pick in
// the list), and a valid fax is required (the reason the entry exists).
const buildProviderEntry = ({ id, input, actor, at, source }) => {
  const i = (input && typeof input === 'object') ? input : {};
  const name = clean(i.name, 160);
  const practice = clean(i.practice, 160);
  if (!name && !practice) return { error: 'A practice or provider name is required', code: 'REFERRAL_PROVIDER_NO_NAME', status: 400 };
  const fax = normalizeFax(i.fax);
  if (!fax) return { error: 'A valid 10-digit fax number is required — it is where referrals to them are faxed', code: 'REFERRAL_PROVIDER_BAD_FAX', status: 400 };
  const now = at || new Date().toISOString();
  return {
    entry: {
      id, name: name || null, practice: practice || null,
      specialty: clean(i.specialty, 120) || null,
      fax, phone: clean(i.phone, 40) || null,
      active: true,
      source: source || 'manual',
      createdAt: now, createdBy: stamp(actor),
      updatedAt: now, updatedBy: stamp(actor),
      lastUsedAt: null, useCount: 0,
      history: []
    }
  };
};

// Entries already saved with this fax. Shown before a second one is saved.
const findByFax = (entries, fax) => {
  const f = normalizeFax(fax);
  if (!f) return [];
  return (Array.isArray(entries) ? entries : []).filter(e => e && e.active !== false && e.fax === f);
};
// The same place saved twice: same fax AND the same practice/provider name.
// That is never a distinct entry, so it is matched rather than duplicated even
// with confirmDistinct.
const sameEntry = (e, input) => {
  const i = input || {};
  return normalizeFax(i.fax) === e.fax &&
    norm(i.name) === norm(e.name) && norm(i.practice) === norm(e.practice);
};

// Editing a saved entry. A fax change needs a reason; every change is kept in
// `history` with who, when, from and to. A field absent from the body is left
// alone; a key that is not an entry field is refused by name.
const applyProviderEdit = ({ entry, input, actor, at }) => {
  if (!entry) return { error: 'Provider not found', code: 'REFERRAL_PROVIDER_NOT_FOUND', status: 404 };
  const i = (input && typeof input === 'object') ? input : {};
  const known = new Set([...FIELDS.map(f => f.key), 'changeReason', 'active']);
  const stray = Object.keys(i).filter(k => !known.has(k));
  if (stray.length) {
    return { error: `${stray.join(', ')} ${stray.length === 1 ? 'is' : 'are'} not part of a saved provider`, code: 'REFERRAL_PROVIDER_FIELD_UNKNOWN', status: 400 };
  }
  const next = { ...entry };
  const changes = [];
  for (const f of FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(i, f.key)) continue;
    let value;
    if (f.fax) {
      value = normalizeFax(i[f.key]);
      if (!value) return { error: 'A valid 10-digit fax number is required', code: 'REFERRAL_PROVIDER_BAD_FAX', status: 400 };
    } else {
      value = clean(i[f.key], f.max) || null;
    }
    const before = entry[f.key] == null || entry[f.key] === '' ? null : entry[f.key];
    if (before === value) continue;
    next[f.key] = value;
    changes.push({ field: f.key, label: f.label, from: before, to: value });
  }
  if (Object.prototype.hasOwnProperty.call(i, 'active')) {
    const active = i.active !== false;
    if (active !== (entry.active !== false)) {
      next.active = active;
      changes.push({ field: 'active', label: 'In the list', from: entry.active !== false, to: active });
    }
  }
  if (!next.name && !next.practice) {
    return { error: 'A practice or provider name is required', code: 'REFERRAL_PROVIDER_NO_NAME', status: 400 };
  }
  if (!changes.length) return { error: 'Nothing changed', code: 'REFERRAL_PROVIDER_NO_CHANGE', status: 400 };
  const reason = clean(i.changeReason, 500) || null;
  const faxChanged = changes.some(c => c.field === 'fax');
  if (faxChanged && !reason) {
    return {
      error: 'Say why the fax number is changing (for example, "the practice confirmed a new referral fax"). Every referral after this goes to the new number.',
      code: 'REFERRAL_PROVIDER_REASON_REQUIRED', status: 400
    };
  }
  const now = at || new Date().toISOString();
  return {
    entry: {
      ...next,
      updatedAt: now, updatedBy: stamp(actor),
      history: [...(entry.history || []), { at: now, by: stamp(actor), changes, reason }]
    },
    changes, faxChanged
  };
};

// Placing a referral to a saved entry bumps it up the list; nothing else on it
// changes (rule 1).
const markUsed = (entry, at) => ({
  ...entry, lastUsedAt: at || new Date().toISOString(), useCount: (Number(entry.useCount) || 0) + 1
});

// The list as the form shows it: active entries, most recently used first,
// then by name.
const label = (e) => [e.name, e.practice].filter(Boolean).join(' · ') || formatFax(e.fax);
const publicEntry = (e) => ({
  id: e.id, name: e.name || null, practice: e.practice || null, specialty: e.specialty || null,
  fax: e.fax, faxFormatted: formatFax(e.fax), phone: e.phone || null,
  label: label(e), lastUsedAt: e.lastUsedAt || null, useCount: Number(e.useCount) || 0,
  updatedAt: e.updatedAt || null, updatedBy: e.updatedBy || null
});
const listForForm = (entries) => (Array.isArray(entries) ? entries : [])
  .filter(e => e && e.active !== false)
  .sort((a, b) => String(b.lastUsedAt || '').localeCompare(String(a.lastUsedAt || '')) || label(a).localeCompare(label(b)))
  .map(publicEntry);

// SEEDED FROM THE REFERRALS ALREADY ON FILE so the list is not empty on day one.
// One entry per fax; a fax already in the list is left alone. Idempotent: a second
// run adds nothing. Internal referrals and agency-pending ones (no fax) are skipped.
const seedFromOrders = ({ entries, orders, makeId, at }) => {
  const list = Array.isArray(entries) ? entries.slice() : [];
  const have = new Set(list.map(e => e && e.fax).filter(Boolean));
  const added = [];
  const sorted = (Array.isArray(orders) ? orders : [])
    .filter(o => o && o.orderType === 'referral' && (o.referral || {}).destination !== 'internal')
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  for (const o of sorted) {
    const r = o.referral || {};
    const fax = normalizeFax(r.receivingFax);
    if (!fax || have.has(fax)) continue;
    const built = buildProviderEntry({
      id: makeId(), at,
      actor: { id: null, name: 'Seeded from referral history' },
      source: 'seed',
      input: { name: r.receivingProvider, practice: r.receivingPractice || r.specialty, specialty: r.specialty, fax, phone: r.receivingPhone }
    });
    if (built.error) continue;
    built.entry.lastUsedAt = o.createdAt || null;
    list.push(built.entry);
    have.add(fax);
    added.push(built.entry);
  }
  return { entries: list, added };
};

module.exports = {
  FIELDS, buildProviderEntry, findByFax, sameEntry, applyProviderEdit, markUsed,
  publicEntry, listForForm, seedFromOrders
};
