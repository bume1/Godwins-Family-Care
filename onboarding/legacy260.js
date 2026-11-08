// ============================================================================
// CARRYING #260's RECORDS ONTO THE PLAYBOOK v3.0 CHECKLIST
// ============================================================================
// The clinician wizard shipped in #260 recorded progress against its own item
// ids (CORE-01, CLIN-06, NP-04 ...), built from repo documents the Playbook
// v3.0 superseded. Nothing a person did is dropped.
//
// DISPLAY ONLY. A carried record is shown on the Chapter C item it matches,
// as evidence, with who did it and when. It NEVER completes the new item by
// itself: the old items are finer-grained than the Playbook's, so three old
// ticks (I-9, W-4, direct deposit) are not proof that one new step is done,
// and claiming a state the new item never recorded is the failure this repo
// keeps paying for. The office confirms the new step, filing on her behalf.
//
// Every #260 item is accounted for, build-enforced: a Chapter C item, a
// training module, or `null` with the reason it has no Chapter C home.
// ============================================================================

'use strict';

const item = (id) => ({ item: id });
const mod = (id) => ({ module: id });
const none = (reason) => ({ none: reason });

const NOT_C = 'Chapter D or E (contracted or hybrid), not Chapter C.';
const PHYS = 'Supervising Physician reference (R1), not a clinician\'s checklist.';
const UNVERIFIED_STATE = 'North Carolina and Alabama requirements are unverified (Playbook R1.4).';
const NOT_IN_PLAYBOOK_C = 'Not listed in Playbook v3.0 Chapter C. Kept as history; owner to decide whether it stays.';
const SCOPE = 'Recorded as the approved scope in each C.8 readiness determination.';

const LEGACY_MAP = Object.freeze({
  'CORE-01': item('C.5.01'), 'CORE-02': none(NOT_C), 'CORE-03': item('C.5.01'), 'CORE-04': none(NOT_C),
  'CORE-05': none(NOT_C), 'CORE-06': item('C.5.03'), 'CORE-07': item('C.5.03'), 'CORE-08': item('C.5.03'),
  'CORE-09': none(NOT_C),
  'CORE-10': none('Playbook R3.3: no separate non-disclosure agreement is used for employees.'),
  'CORE-11': item('C.5.04'), 'CORE-12': item('C.5.04'), 'CORE-13': mod('TRN-002'), 'CORE-14': item('C.5.04'),
  'CORE-15': item('C.5.03'), 'CORE-16': item('C.6.01'),
  'CLIN-01': item('C.6.01'), 'CLIN-02': item('C.6.02'), 'CLIN-03': item('C.4.02'), 'CLIN-04': item('C.6.08'),
  'CLIN-05': item('C.6.01'), 'CLIN-06': item('C.4.05'), 'CLIN-07': item('C.4.04'), 'CLIN-08': item('C.6.01'),
  'CLIN-09': item('C.6.01'), 'CLIN-10': item('C.6.06'), 'CLIN-11': item('C.6.01'),
  'CLIN-12': none(NOT_IN_PLAYBOOK_C + ' Clinical Manual §16.5 requires TB documentation before patient contact.'),
  'CLIN-13': none(NOT_IN_PLAYBOOK_C + ' Clinical Manual §16.5.'),
  'CLIN-14': none(NOT_IN_PLAYBOOK_C),
  'CLIN-15': item('C.6.09'), 'CLIN-16': mod('TRN-007'), 'CLIN-17': mod('TRN-006'),
  'CLIN-18': none(NOT_IN_PLAYBOOK_C + ' Clinical Manual §5.3.'),
  'CLIN-19': item('C.7.01'), 'CLIN-20': none('Time recording is a Chapter F phase, not a Chapter C item.'),
  'NP-01': item('C.6.01'), 'NP-02': item('C.6.01'), 'NP-03': item('C.6.01'), 'NP-04': item('C.6.03'),
  'NP-05': item('C.6.03'), 'NP-06': item('C.6.03'),
  'NP-07': none('Open item: the non-prescribing protocol under O.C.G.A. 43-34-23 requires counsel (Playbook R3.7).'),
  'NP-08': item('C.6.03'),
  'FNP-01': item('C.6.01'), 'PMH-01': item('C.6.01'), 'PMH-02': item('C.6.02'), 'PMH-03': item('C.6.03'),
  'PMH-04': item('C.7.04'),
  'MD-01': none(PHYS), 'MD-02': none(PHYS), 'MD-03': none(PHYS), 'MD-04': none(PHYS), 'MD-05': none(PHYS),
  'MD-06': none(PHYS), 'MD-07': none(PHYS), 'MD-08': none(PHYS), 'MD-09': none(PHYS), 'MD-10': none(PHYS),
  'MD-11': none(PHYS), 'MD-12': none(PHYS), 'MD-13': none(PHYS),
  'DIR-01': none(PHYS), 'DIR-02': none(PHYS), 'DIR-03': none(PHYS),
  'W2-01': item('C.5.02'), 'W2-02': mod('TRN-204'), 'W2-03': none(NOT_IN_PLAYBOOK_C),
  'W2-04': item('C.5.05'), 'W2-05': none('The 30, 60 and 90 day reviews are now TRN-403 to TRN-405.'),
  'C99-01': none(NOT_C), 'C99-02': none(NOT_C),
  'HYB-01': none(NOT_C), 'HYB-02': none(NOT_C), 'HYB-03': none(NOT_C), 'HYB-04': none(NOT_C),
  'LCL-01': none(SCOPE), 'LCL-02': mod('TRN-003'), 'LCL-03': mod('TRN-301'), 'LCL-04': item('C.7.05'),
  'LCL-05': mod('TRN-202'), 'LCL-06': item('C.9.01'),
  'EXM-01': none(SCOPE), 'EXM-02': none('Examiner credentialing is a condition of the IME readiness determination (C.8).'),
  'EXM-03': none('Examiner credentialing is a condition of the IME readiness determination (C.8).'),
  'EXM-04': mod('TRN-102'), 'EXM-05': mod('TRN-103'), 'EXM-06': item('C.6.01'), 'EXM-07': mod('TRN-104'),
  'EXM-08': none(SCOPE), 'EXM-09': none('Examiner credentialing is a condition of the IME readiness determination (C.8).'),
  'EXM-10': mod('TRN-106'),
  'PRV-01': none(SCOPE), 'PRV-02': none(SCOPE), 'PRV-03': none(SCOPE),
  'RX-01': item('C.6.03'), 'RX-02': item('C.7.01'), 'RX-03': none(NOT_IN_PLAYBOOK_C),
  'CS-01': item('C.6.05'), 'CS-02': item('C.6.05'), 'CS-03': item('C.6.05'), 'CS-04': item('C.6.05'),
  'CS-05': item('C.7.01'),
  'TH-01': none(NOT_IN_PLAYBOOK_C), 'TH-02': none(NOT_IN_PLAYBOOK_C), 'TH-03': mod('TRN-218'),
  'INS-01': item('C.6.07'), 'INS-02': item('C.6.07'), 'INS-03': item('C.6.07'), 'INS-04': item('C.6.07'),
  'NC-01': none(UNVERIFIED_STATE), 'NC-02': none(UNVERIFIED_STATE), 'NC-03': none(UNVERIFIED_STATE), 'NC-04': none(UNVERIFIED_STATE),
  'AL-01': none(UNVERIFIED_STATE), 'AL-02': none(UNVERIFIED_STATE), 'AL-03': none(UNVERIFIED_STATE), 'AL-04': none(UNVERIFIED_STATE)
});

/**
 * Sorts a #260 record's item states onto the new checklist.
 * `titles` maps an old id to its old title (from clinicianItems.js), so the
 * evidence reads as what it was called when she did it.
 */
function carryOver(oldItems, titles) {
  const byItem = {}; const byModule = {}; const unmapped = [];
  for (const [oldId, st] of Object.entries(oldItems || {})) {
    if (!st || !st.status || st.status === 'not_started') continue;
    const ev = {
      oldId, title: (titles && titles[oldId]) || oldId, status: st.status,
      at: st.verifiedAt || st.completedAt || st.at || null,
      byName: st.verifiedByName || st.byName || null,
      proofFiles: Array.isArray(st.proofFiles) ? st.proofFiles.map(f => ({ id: f.id, name: f.name, uploadedAt: f.uploadedAt })) : []
    };
    const m = LEGACY_MAP[oldId];
    if (m && m.item) (byItem[m.item] = byItem[m.item] || []).push(ev);
    else if (m && m.module) (byModule[m.module] = byModule[m.module] || []).push(ev);
    else unmapped.push(Object.assign(ev, { reason: m ? m.none : 'Not a known #260 item.' }));
  }
  return { byItem, byModule, unmapped };
}

module.exports = { LEGACY_MAP, carryOver };
