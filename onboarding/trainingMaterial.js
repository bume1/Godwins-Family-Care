// ============================================================================
// TRAINING MATERIAL — what a module actually teaches from, answered honestly
// ============================================================================
// Owner, 2026-11-09: the Training Library has to be built on real SOPs. A
// module is only something a person can take when there is material behind
// it: a written SOP in Drive, or material the office added for that module.
//
// FOUR STATES, and the difference between them is the point of this file:
//
//   SOP_WRITTEN        the module teaches an SOP that exists in Drive
//   MATERIAL_ADDED     no written SOP, but the office added links or files
//   SOP_NOT_WRITTEN    the SOP it will teach is only "Set 2 · Planned"
//   NO_MATERIAL        no SOP planned and nothing added (reviews, shadowing)
//
// A fifth, SOP_MISSING_FROM_DRIVE, is reported only when the SOP document was
// read and the procedure the catalog names is not in it. An SOP the app could
// not read right now is NOT treated as missing: a Drive outage must not grey
// out a module that has a written procedure behind it.
//
// WHO SEES WHAT. Staff see one fact: ready or not. "SOP not written" and the
// planned procedure id are the office's work list, never shown to staff
// (owner: "the SOP not built can show for admin only").
//
// The material record holds LINKS and our own FILE rows. A Drive id is stored
// for the download and never leaves the server.
// ============================================================================

'use strict';

const COLLECTION = 'onboarding_training_materials';

const STATUS = Object.freeze({
  SOP_WRITTEN: 'SOP_WRITTEN',
  MATERIAL_ADDED: 'MATERIAL_ADDED',
  SOP_NOT_WRITTEN: 'SOP_NOT_WRITTEN',
  SOP_MISSING_FROM_DRIVE: 'SOP_MISSING_FROM_DRIVE',
  NO_MATERIAL: 'NO_MATERIAL'
});

const LINK_KINDS = Object.freeze(['video', 'document', 'link']);
const MAX_LINKS = 20;
const MAX_FILES = 20;
const MAX_NOTE = 2000;

const live = (rows) => (rows || []).filter(r => r && !r.removedAt);

/** True when the office has added anything a person can learn from. */
function hasAddedMaterial(entry) {
  return !!entry && (live(entry.links).length > 0 || live(entry.files).length > 0);
}

/**
 * The material state of one module.
 *   module       a catalog module (sopRefs, plannedSop)
 *   entry        the office's material record for it, or null
 *   sopIdsInDrive  a Set of SOP ids read from the SOP document, or null when
 *                the document could not be read (unknown, not missing)
 */
function materialFor(module, entry, sopIdsInDrive) {
  const refs = (module && module.sopRefs) || [];
  const known = sopIdsInDrive instanceof Set;
  const written = known ? refs.filter(s => sopIdsInDrive.has(s)) : refs.slice();
  const missing = known ? refs.filter(s => !sopIdsInDrive.has(s)) : [];
  const added = hasAddedMaterial(entry);
  let status;
  if (written.length) status = STATUS.SOP_WRITTEN;
  else if (added) status = STATUS.MATERIAL_ADDED;
  else if (missing.length) status = STATUS.SOP_MISSING_FROM_DRIVE;
  else if (module && module.plannedSop) status = STATUS.SOP_NOT_WRITTEN;
  else status = STATUS.NO_MATERIAL;
  return {
    status,
    ready: written.length > 0 || added,
    sops: written,
    missingSops: missing,
    plannedSop: (module && module.plannedSop) || null,
    links: live(entry && entry.links).map(publicLink),
    files: live(entry && entry.files).map(publicFile),
    note: (entry && entry.note) || '',
    updatedAt: (entry && entry.updatedAt) || null,
    updatedByName: (entry && entry.updatedByName) || null
  };
}

const publicLink = (l) => ({ id: l.id, label: l.label, url: l.url, kind: l.kind, addedAt: l.addedAt, addedByName: l.addedByName });
const publicFile = (f) => ({ id: f.id, name: f.name, mime: f.mime, addedAt: f.addedAt, addedByName: f.addedByName });

/** What staff are told: ready or not, and the material only when ready. */
function forStaff(material) {
  if (!material || !material.ready) return { ready: false };
  return { ready: true, sops: material.sops, links: material.links, files: material.files, note: material.note };
}

function fail(code, message) {
  const e = new Error(message);
  e.code = code; e.status = 400;
  return e;
}

/** A link the office adds. https only: a link is opened by staff, often on a phone. */
function validateLink(body) {
  const b = body || {};
  const label = String(b.label || '').trim().slice(0, 120);
  const url = String(b.url || '').trim();
  const kind = String(b.kind || 'link');
  if (!label) throw fail('LINK_LABEL_REQUIRED', 'Give the link a name staff will recognize.');
  if (!LINK_KINDS.includes(kind)) throw fail('LINK_KIND_INVALID', `Kind must be one of: ${LINK_KINDS.join(', ')}.`);
  if (url.length > 2000) throw fail('LINK_URL_INVALID', 'That link is too long.');
  let parsed;
  try { parsed = new URL(url); } catch (_) { throw fail('LINK_URL_INVALID', 'Paste a full link, starting with https://'); }
  if (parsed.protocol !== 'https:') throw fail('LINK_URL_INVALID', 'Only https:// links can be added.');
  return { label, url: parsed.toString(), kind };
}

const stamp = (entry, actor, now) => Object.assign(entry, { updatedAt: now, updatedByName: actor.name });

function addLink(entry, body, actor, now, id) {
  const e = Object.assign({ links: [], files: [] }, entry || {});
  if (live(e.links).length >= MAX_LINKS) throw fail('LINK_LIMIT', `A module holds at most ${MAX_LINKS} links.`);
  const l = validateLink(body);
  e.links = (e.links || []).concat([Object.assign({ id, addedAt: now, addedById: actor.id, addedByName: actor.name }, l)]);
  return stamp(e, actor, now);
}

function addFile(entry, file, actor, now) {
  const e = Object.assign({ links: [], files: [] }, entry || {});
  if (live(e.files).length >= MAX_FILES) throw fail('FILE_LIMIT', `A module holds at most ${MAX_FILES} files.`);
  e.files = (e.files || []).concat([Object.assign({ addedAt: now, addedById: actor.id, addedByName: actor.name }, file)]);
  return stamp(e, actor, now);
}

// Removing keeps the row with who and when: a person who completed the module
// learned from it, and the record of what they learned from stays readable.
function remove(entry, list, id, actor, now) {
  const e = Object.assign({ links: [], files: [] }, entry || {});
  const row = (e[list] || []).find(r => r.id === id && !r.removedAt);
  if (!row) { const x = new Error('Nothing with that id is on this module.'); x.code = 'MATERIAL_UNKNOWN'; x.status = 404; throw x; }
  row.removedAt = now; row.removedByName = actor.name;
  return stamp(e, actor, now);
}

function setNote(entry, note, actor, now) {
  const e = Object.assign({ links: [], files: [] }, entry || {});
  e.note = String(note || '').trim().slice(0, MAX_NOTE);
  return stamp(e, actor, now);
}

// The office's working fields on the library page (2026-11-10): what the
// training still needs, and a note. Office only, never sent to staff, and they
// never make a training ready.
const NEXT_STEPS = Object.freeze(['write', 'attach', 'done', 'external', 'none', 'confirm', 'gap']);
function setOffice(entry, body, actor, now) {
  const b = body || {};
  const e = Object.assign({ links: [], files: [] }, entry || {});
  const prev = e.office || {};
  const nextStep = b.nextStep === undefined ? prev.nextStep : (b.nextStep === null || b.nextStep === '' ? null : String(b.nextStep));
  if (nextStep && !NEXT_STEPS.includes(nextStep)) throw fail('NEXT_STEP_INVALID', `Next step must be one of: ${NEXT_STEPS.join(', ')}.`);
  e.office = {
    nextStep: nextStep || null,
    note: b.note === undefined ? (prev.note || '') : String(b.note || '').trim().slice(0, MAX_NOTE),
    // The policy line the training ties to (owner, 2026-11-10). Absent keeps
    // the office's earlier edit, null goes back to the catalog's line.
    policy: b.policy === undefined ? (prev.policy || null) : cleanPolicy(b.policy),
    at: now, byId: actor.id, byName: actor.name
  };
  return e;
}

const MAX_POLICY = 200;
function cleanPolicy(p) {
  if (p === null) return null;
  if (typeof p !== 'object') throw fail('POLICY_INVALID', 'The policy needs a document name.');
  const document = String(p.document || '').trim().slice(0, MAX_POLICY);
  if (!document) throw fail('POLICY_INVALID', 'The policy needs a document name.');
  const sections = String(p.sections || '').trim().slice(0, MAX_POLICY);
  let url = String(p.url || '').trim() || null;
  if (url) {
    let u = null; try { u = new URL(url); } catch (e) { u = null; }
    if (!u || u.protocol !== 'https:') throw fail('POLICY_URL_INVALID', 'The policy link must start with https://.');
    url = u.toString();
  }
  return { document, sections, url };
}

/** The office's own policy line for a training, or null to use the catalog's. */
const policyOverride = (entry) => (entry && entry.office && entry.office.policy) || null;

/** A live file row, for the download. */
function findFile(entry, fileId) {
  return live(entry && entry.files).find(f => f.id === fileId) || null;
}

// Material the app ships with (owner, 2026-11-10): SOP 1, "Signing In and
// Onboarding", is what TRN-004 "Application tour at first login" teaches,
// since the app has no built-in tour. Seeded at boot ONCE per module: only
// when the module has no material and was never seeded, so an office that
// removes or replaces it is never overridden by the next restart.
const drive = (id) => `https://drive.google.com/file/d/${id}/view`;
// Each module can carry SEVERAL default files (owner, 2026-11-10: the app
// training is one module holding a guide per area of the app). Each default has
// a stable `key`, and a key is seeded once: a file the office removes or
// replaces never comes back, and a default added later still reaches a
// module that was seeded before it existed.
const DEFAULT_MATERIAL = Object.freeze({
  // The app training (owner, 2026-11-11): the controlled SOP sets in Drive,
  // replacing the working SOP 1 Google Doc, which is retired (RETIRED_URLS).
  // The Staff Pay Guide sits on each onboarding list's pay setup step instead.
  'TRN-004': Object.freeze([
    Object.freeze({ key: 'sop-set1', label: 'Administrative SOPs Set 1: Signing In and Onboarding', kind: 'document', url: drive('1vXFFEqeAJHGEidNdhB3atE59ZffHu7ma') }),
    Object.freeze({ key: 'sop-set2', label: 'Administrative SOPs Set 2: Documents to Sign', kind: 'document', url: drive('1fLC9VWBJ3uzzjMgKUUtRThtF3M3m4P5j') })
  ]),
  // Material that already exists in Drive (owner's Training Material Tracker).
  'TRN-001': Object.freeze([Object.freeze({ key: 'team-roles', label: 'Team Roles and Responsibilities v2', url: drive('1Z6v89NQvbcY7yBmixo8hw-LIPQ3YE5yc'), kind: 'document' })]),
  'TRN-002': Object.freeze([Object.freeze({ key: 'team-roles', label: 'Team Roles and Responsibilities v2: your role card (pages 12 to 21)', url: drive('1Z6v89NQvbcY7yBmixo8hw-LIPQ3YE5yc'), kind: 'document' })]),
  'TRN-501': Object.freeze([Object.freeze({ key: 'video', label: 'Video: Accepting Shifts, Clocking In', url: drive('1YcwdwNhYIa1NKqmEdibsAYKlhekcQgHA'), kind: 'video' })]),
  'TRN-502': Object.freeze([Object.freeze({ key: 'video', label: 'Video: Submitting the Visit Report, Clocking Out', url: drive('1wWRk_njfMZIeJH0ogOwxheEXjv2fS04P'), kind: 'video' })]),
  'TRN-503': Object.freeze([
    Object.freeze({ key: 'video', label: 'Video: Home Care Staff Onboarding Documents', url: drive('1na5b7HVJyXdVGBhuhzh655YmMT3TJuIR'), kind: 'video' }),
    // Caregivers sign documents in the same app (owner, 2026-11-11). The pay
    // guide is on the pay setup step of the onboarding list, not here.
    Object.freeze({ key: 'sop-set2', label: 'Administrative SOPs Set 2: Documents to Sign (SOP-SIG-02 is yours)', kind: 'document', url: drive('1fLC9VWBJ3uzzjMgKUUtRThtF3M3m4P5j') })
  ])
});

// Material the app once seeded and has since replaced. Taken off a module once,
// keeping the row with who and when, so a training does not keep pointing at a
// withdrawn document. A link the office added by hand to the same document is
// taken off too: the document itself is withdrawn.
const RETIRED_URLS = Object.freeze({
  'TRN-004': Object.freeze(['https://docs.google.com/document/d/1Bs-wgsurXK3SbJt2aLFD1AtmUEqp2FPqapqM_OA0oFw/view'])
});
function seedDefaults(all, now) {
  const out = Object.assign({}, all || {});
  const seeded = [];
  for (const [moduleId, defaults] of Object.entries(DEFAULT_MATERIAL)) {
    let e = out[moduleId] || null;
    // Seeded before keys existed (the first SOP 1 seed, 2026-11-10).
    const done = new Set((e && e.defaultKeysSeeded) || (e && e.defaultSeededAt && moduleId === 'TRN-004' ? ['sop1'] : []));
    let changed = false;
    for (const url of RETIRED_URLS[moduleId] || []) {
      if (e && (e.links || []).some(x => x.url === url && !x.removedAt)) e = Object.assign({}, e, { links: e.links.map(x => Object.assign({}, x)) });
      for (const l of ((e && e.links) || []).filter(x => x.url === url && !x.removedAt)) {
        e = remove(e, 'links', l.id, { id: 'system', name: 'GFC (retired, replaced by the SOP sets)' }, now);
        changed = true;
      }
    }
    for (const d of defaults) {
      if (done.has(d.key)) continue;
      const already = e && (e.links || []).some(l => l.url === d.url);
      if (!already) e = addLink(e, d, { id: 'system', name: 'GFC (built in)' }, now, `default-${moduleId}-${d.key}`);
      done.add(d.key); changed = true;
    }
    if (changed) {
      e = Object.assign({}, e, { defaultKeysSeeded: Array.from(done), defaultSeededAt: (e && e.defaultSeededAt) || now });
      out[moduleId] = e;
      seeded.push(moduleId);
    }
  }
  return { all: out, seeded };
}

module.exports = {
  COLLECTION, STATUS, LINK_KINDS,
  hasAddedMaterial, materialFor, forStaff, validateLink,
  addLink, addFile, remove, setNote, findFile,
  DEFAULT_MATERIAL, RETIRED_URLS, seedDefaults, NEXT_STEPS, setOffice, policyOverride
};
