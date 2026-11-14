'use strict';

// ============================================================================
// ONE APPROVAL, EVERY VIEW (owner, 2026-11-13: "we have reviewed and approved
// most of these items for a caregiver, yet it did not automatically check off").
//
// The caregiver's clearance list, her own checklist and the scheduling gate
// read the welcome packet stores (caregiver_documents by kind, the packet's
// office items). The onboarding module reads them too. So an approval made in
// onboarding is written INTO those stores, never kept beside them.
// ============================================================================

const wp = require('../welcomePacketRepository');

const KIND_BY = Object.fromEntries(wp.DOCUMENT_ITEMS.map(d => [d.kind, d]));
const isOfficeKind = (k) => wp.OFFICE_ITEM_KINDS.includes(k);
// The packet kinds a file can be filed under (an upload item).
const uploadKindsOf = (item) => ((item && item.packet) || []).filter(k => KIND_BY[k] && KIND_BY[k].upload);

/**
 * Accept her files of these kinds that are waiting on review.
 * → number of files accepted
 */
async function acceptWaitingDocs(db, caregiverId, kinds, by, now) {
  if (!kinds || !kinds.length) return 0;
  const rows = (await db.get('caregiver_documents')) || [];
  let n = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r || String(r.caregiver_id) !== String(caregiverId) || r.deleted_at) continue;
    if (!kinds.includes(r.kind) || r.status !== 'received') continue;
    rows[i] = { ...r, status: 'accepted', reviewed_at: now, reviewed_by_name: by.name || null, review_note: null };
    n++;
  }
  if (n) await db.set('caregiver_documents', rows);
  return n;
}

// The same empty packet the welcome packet routes start from.
const blankPacket = (caregiverId, now) => ({
  id: `wpkt_${caregiverId}`, caregiver_id: caregiverId, version: wp.PACKET_VERSION, status: 'not_started', data: {},
  signature_png: null, printed_name: null, signed_at: null, signer_ip_hash: null, signed_offline: false,
  imported_from: null, import_source: null, imported_at: null, office: {}, created_at: now, updated_at: now
});

/** Set one office item (fingerprinting, orientation, app training, skills check). */
async function setOfficeItem(db, caregiverId, kind, status, by, now, note) {
  if (!isOfficeKind(kind) || !wp.OFFICE_STATUSES.includes(status)) throw new Error('Unknown office item or status.');
  const rows = (await db.get('welcome_packets')) || [];
  let idx = rows.findIndex(r => r && String(r.caregiver_id) === String(caregiverId));
  if (idx === -1) {
    rows.push(blankPacket(caregiverId, now));
    idx = rows.length - 1;
  }
  const packet = rows[idx];
  packet.office = { ...(packet.office || {}) };
  packet.office[kind] = { status, note: String(note || '').trim().slice(0, 500) || null, at: now, byId: by.id || null, byName: by.name || null };
  packet.updated_at = now;
  await db.set('welcome_packets', rows);
  return packet;
}

/**
 * The office recorded a step on a caregiver's item: what it names in her
 * packet is approved there too. Every item that names an office document has
 * a single office step, so recording it is the office saying it is done.
 * → { accepted, officeDone: [kinds] }
 */
async function syncApproval(db, { item, caregiverId, by, now }) {
  const kinds = (item && item.packet) || [];
  if (!kinds.length) return { accepted: 0, officeDone: [] };
  const accepted = await acceptWaitingDocs(db, caregiverId, kinds.filter(k => KIND_BY[k] && KIND_BY[k].upload), by, now);
  const officeDone = kinds.filter(isOfficeKind);
  for (const k of officeDone) await setOfficeItem(db, caregiverId, k, 'done', by, now);
  return { accepted, officeDone };
}

module.exports = { blankPacket, uploadKindsOf, acceptWaitingDocs, setOfficeItem, syncApproval, isOfficeKind };

/**
 * Once, at boot: approvals the office made in onboarding before this sync
 * existed reach the welcome packet, and files uploaded in onboarding against
 * a one-document packet item are filed under that document.
 * → { rekinded, accepted, officeDone, unsure }
 */
const REPAIR_MARKER = 'onboarding_packet_sync_repair';
async function repairOnce(db, { findItem, now }) {
  const done = await db.get(REPAIR_MARKER);
  if (done && done.version === 1) return { skipped: true };
  const out = { rekinded: 0, accepted: 0, officeDone: 0, unsure: 0 };
  const recs = ((await db.get('onboarding_records')) || []).filter(r => r && r.inputs && r.inputs.chapter === 'A');

  // 1. Files uploaded in onboarding: file each under its packet document.
  const docs = (await db.get('caregiver_documents')) || [];
  let docsChanged = false;
  for (let i = 0; i < docs.length; i++) {
    const d = docs[i];
    if (!d || d.kind !== 'clinician_onboarding' || !d.onboarding_item_id || d.deleted_at) continue;
    if (!recs.some(r => String(r.userId) === String(d.caregiver_id))) continue;
    const kinds = uploadKindsOf(findItem(d.onboarding_item_id));
    if (kinds.length === 1) {
      docs[i] = { ...d, kind: kinds[0], status: d.status === 'received' && d.uploaded_by_office ? 'accepted' : d.status };
      docsChanged = true; out.rekinded++;
    } else if (kinds.length > 1) out.unsure++;
  }
  if (docsChanged) await db.set('caregiver_documents', docs);

  // 2. Steps the office already recorded.
  for (const rec of recs) {
    for (const [id, st] of Object.entries(rec.items || {})) {
      const item = findItem(id);
      if (!item || !item.packet || !item.packet.length || !st || !st.steps) continue;
      const officeIdx = item.steps.map((s, i) => (s.actor === 'NEW_HIRE' ? -1 : i)).filter(i => i >= 0);
      if (!officeIdx.some(i => st.steps[i])) continue;
      const step = st.steps[officeIdx.find(i => st.steps[i])];
      const by = { id: step.byId || null, name: step.byName || null };
      out.accepted += await acceptWaitingDocs(db, rec.userId, uploadKindsOf(item), by, now);
      if (officeIdx.every(i => st.steps[i])) {
        const pk = ((await db.get('welcome_packets')) || []).find(p => p && String(p.caregiver_id) === String(rec.userId));
        for (const k of item.packet.filter(isOfficeKind)) {
          if (pk && pk.office && pk.office[k] && pk.office[k].status === 'done') continue;
          await setOfficeItem(db, rec.userId, k, 'done', by, now);
          out.officeDone++;
        }
      }
    }
  }
  await db.set(REPAIR_MARKER, { version: 1, at: now, ...out });
  return out;
}

module.exports.repairOnce = repairOnce;
module.exports.REPAIR_MARKER = REPAIR_MARKER;
