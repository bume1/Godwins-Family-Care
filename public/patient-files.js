// ============================================================
// GODWINS FAMILY CARE — the patient's Documents screen, sorted once.
//
// Owner, 2026-10-12: "there still remains a couple duplications in how
// consents show. Can you create a cleaner files view for the patients?"
//
// The screen used to draw from two lists that overlap: /api/gfc/documents
// (signed consents, the packet, the checklist with what they sent) and
// /api/gfc/clinical/documents (the chart index, which ALSO lists every
// signed consent and every upload). So a signed consent showed twice, an
// upload showed twice, and the packet PDF and the ZIP were two rows for the
// same set of signatures. This file turns both into ONE list where every
// document appears once, in one group. Pure, so a test can run it.
//
// Rules:
//  - A consent comes from signedConsents only; the chart's consent:* rows
//    are dropped.
//  - An upload comes from the checklist (it carries the open link for every
//    patient, clinical or not); a chart upload:* row is kept only when the
//    checklist does not already list that upload (a shared staff filing of a
//    kind outside the checklist).
//  - The packet PDF is one row; the ZIP rides on it as a second link.
//  - A rejected upload is not a document on file. It shows on the "still
//    needed" item with its reason, never in the list.
// ============================================================
(function () {
  const GROUPS = [
    { key: 'forms', label: 'Signed forms' },
    { key: 'plans', label: 'Care plans' },
    { key: 'results', label: 'Test results' },
    { key: 'sent', label: 'Sent by you' },
    { key: 'team', label: 'From your care team' },
    { key: 'releases', label: 'Record releases' }
  ];

  const consentSub = (s) => s.status === 'na' ? 'Declined or not applicable'
    : s.status === 'optin_recorded' ? 'Preference recorded'
    : s.status === 'signed_offline' ? 'Signed on paper'
    : (s.signerName ? `Signed by ${s.signerName}` : 'Signed');

  function buildPatientFiles({ docs, clinicalDocs }) {
    const d = docs || {};
    const items = [];
    const push = (x) => items.push(Object.assign({ date: null, sub: '', open: null, extra: null }, x));

    // 1. Signed forms.
    if (d.enrollmentPacket) {
      push({
        id: 'packet', group: 'forms', icon: 'ti-file-certificate', title: 'Enrollment packet',
        sub: 'Your intake summary and every form you signed',
        open: { type: 'pdf', url: d.enrollmentPacket.url },
        extra: d.consentPacketZip ? { label: 'Separate files (ZIP)', open: { type: 'zip', url: d.consentPacketZip.url } } : null,
        pinned: true
      });
    }
    for (const s of d.signedConsents || []) {
      push({
        id: `consent:${s.key}`, group: 'forms', icon: 'ti-signature', title: s.label,
        sub: consentSub(s), date: s.signedAt || null,
        open: s.copyUrl ? { type: 'pdf', url: s.copyUrl } : null,
        extra: s.scanUrl ? { label: 'Paper copy', open: { type: 'link', url: s.scanUrl } } : null
      });
    }
    (d.offlinePacketFiles || []).forEach((f, i) => push({
      id: f.id || `offline-${i}`, group: 'forms', icon: 'ti-file-text', title: f.title || `Paper packet page ${i + 1}`,
      sub: 'Paper packet, scanned by your care team', open: { type: 'link', url: f.url }
    }));

    // 2. What they sent, and what staff filed and shared, from the checklist.
    const seenUploads = new Set();
    for (const row of d.checklist || []) {
      for (const f of row.files || []) {
        if (f.status === 'rejected' || seenUploads.has(f.id)) continue;
        seenUploads.add(f.id);
        const fromTeam = f.source === 'staff';
        push({
          id: `upload:${f.id}`, group: fromTeam ? 'team' : 'sent', icon: 'ti-file', title: row.label || f.fileName,
          sub: [f.fileName, fromTeam ? null : (f.status === 'accepted' ? 'Reviewed' : 'With the office')].filter(Boolean).join(' · '),
          date: f.uploadedAt || null, open: { type: 'file', url: f.url }
        });
      }
    }

    // 3. The chart index (clinical patients only), minus what is above.
    for (const c of clinicalDocs || []) {
      const sep = String(c.id || '').indexOf(':');
      const kind = sep === -1 ? c.id : c.id.slice(0, sep);
      const ref = sep === -1 ? '' : c.id.slice(sep + 1);
      if (kind === 'consent') continue;
      if (kind === 'upload' && seenUploads.has(ref)) continue;
      const group = kind === 'careplan' ? 'plans' : kind === 'result' ? 'results' : kind === 'roi' ? 'releases'
        : kind === 'upload' ? (c.category === 'You sent this' ? 'sent' : 'team') : 'team';
      const icon = kind === 'careplan' ? 'ti-clipboard-heart' : kind === 'result' ? 'ti-flask' : kind === 'roi' ? 'ti-file-symlink' : 'ti-file';
      push({
        id: c.id, group, icon, title: c.title, sub: c.note || '', date: c.date || null,
        open: c.openable ? { type: 'chart', id: c.id } : null
      });
    }

    // 4. Files staff shared the older way (client_documents).
    for (const f of d.documents || []) {
      push({
        id: `shared:${f.id}`, group: 'team', icon: 'ti-file-text', title: f.title || f.name || 'Document',
        sub: f.description || '', date: f.createdAt || f.uploadedAt || null,
        open: f.url ? { type: typeof f.url === 'string' && f.url.startsWith('/') ? 'file' : 'link', url: f.url } : null
      });
    }

    // Pinned first, then newest first, undated last.
    items.sort((a, b) => {
      if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
      if (!a.date && !b.date) return 0;
      if (!a.date) return 1;
      if (!b.date) return -1;
      return String(b.date).localeCompare(String(a.date));
    });

    const groups = GROUPS.map(g => ({ ...g, count: items.filter(i => i.group === g.key).length })).filter(g => g.count);
    return { items, groups };
  }

  // What still needs sending: required or asked-for items with nothing on file.
  // Optional items they have not sent sit apart, under "Send something else".
  function neededFrom(checklist) {
    const rows = checklist || [];
    return {
      needed: rows.filter(r => r.status === 'missing' && (r.required || r.requested)),
      optional: rows.filter(r => r.status === 'missing' && !r.required && !r.requested)
    };
  }

  const api = { GROUPS, buildPatientFiles, neededFrom };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.GFC_PATIENT_FILES = api;
})();
