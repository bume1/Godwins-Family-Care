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

/** A live file row, for the download. */
function findFile(entry, fileId) {
  return live(entry && entry.files).find(f => f.id === fileId) || null;
}

module.exports = {
  COLLECTION, STATUS, LINK_KINDS,
  hasAddedMaterial, materialFor, forStaff, validateLink,
  addLink, addFile, remove, setNote, findFile
};
