// ============================================================================
// THE POLICIES EACH PERSON SIGNS OR ACKNOWLEDGES (owner, 2026-11-15)
// ============================================================================
// "Documents that need to be signed should be shared with staff for signing,
// versus documents that need to be acknowledged." Each policy declares one
// action (chapterC ACKNOWLEDGMENTS, `action`), and the same answer is read by
// onboarding, My Documents, the Home banner and the office's view.
//
// Which policies a person owes: the ones their onboarding chapter acknowledges
// (the chapter on their onboarding record, or the one their account would get).
// A policy with no file in Drive is not offered here: there is nothing to open,
// and the office files it (the job description for the role).
//
// Done means: a signing at the current version that satisfies the policy's
// action (track.ackSatisfies), either in staff_policy_signings (signed in the
// app) or on their onboarding record (which also carries the office's
// paper filings). PURE: the route passes the rows in.
//
//   signing: { id, userId, policyId, version, action, method: 'signed'|'acknowledged',
//              printedName, signedAt, ipHash, documentId, sourceSha256 }
// ============================================================================

'use strict';

const T = require('./track');

const docById = (id) => T.ALL_ACKS.find(a => a.id === id) || null;

// Every policy this person's checklist acknowledges, in checklist order, with
// a file. `inputs` are their onboarding inputs (chapter and the answers that
// decide which items apply, such as whether the role enters a home), so the
// Field Addendum reaches only the people their own checklist gives it to.
function policiesFor(inputs) {
  const ids = [];
  for (const it of T.composeChecklist(inputs || {})) for (const id of it.acknowledges || []) if (!ids.includes(id)) ids.push(id);
  return ids.map(docById).filter(d => d && (d.driveFileIds || []).length);
}

// Where this policy stands for this person.
function statusOf(doc, { signings, record, userId }) {
  const mine = (signings || []).filter(r => r && String(r.userId) === String(userId) && r.policyId === doc.id)
    .sort((a, b) => String(b.signedAt).localeCompare(String(a.signedAt)));
  const fromApp = mine.find(r => T.ackSatisfies(doc, { version: r.version, method: r.method })) || null;
  let fromRecord = null; let older = null;
  for (const st of Object.values((record && record.items) || {})) {
    const got = st && st.acknowledgments && st.acknowledgments[doc.id];
    if (!got) continue;
    if (T.ackSatisfies(doc, got)) fromRecord = fromRecord || got; else older = older || got;
  }
  const done = fromApp || fromRecord;
  const action = T.ackAction(doc);
  return {
    policyId: doc.id, title: doc.title, version: doc.version, action,
    done: !!done,
    doneAt: done ? (done.signedAt || done.at) : null,
    documentId: done ? (done.documentId || null) : null,
    method: done ? (done.method || null) : null,
    // They acknowledged it before it had to be signed: shown as such.
    needsSignature: !done && action === 'sign' && !!(older || mine[0]),
    previousAt: !done && (older || mine[0]) ? ((older && older.at) || (mine[0] && mine[0].signedAt)) : null
  };
}

function forPerson({ inputs, signings, record, userId }) {
  return policiesFor(inputs).map(doc => statusOf(doc, { signings, record, userId }));
}

module.exports = { docById, policiesFor, statusOf, forPerson };
