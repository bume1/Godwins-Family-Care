// ============================================================================
// enrollmentChanges.js — a service line or rate change that waits for the
// owner (owner, 2026-10-19).
//
// "Coordinators and managers can change service lines and rates, though my
// approval is needed." So a manager's or coordinator's change is a REQUEST
// stored on the client record; nothing about the client changes until the
// Super Admin approves it. An admin's own change applies at once, as before.
//
// Approving runs the SAME code path an admin's direct change runs (server.js
// commitServiceLine / commitRate), so the consent recompute and the
// re-signature flag happen once, in one place, whoever asked.
//
// Also here: the live view of the two consent banners. The flags are stored
// when a lane or rate changes and were pruned by hand in each signing route,
// and one route missed one of them, so a banner could stay up after the
// consent it named was signed. The detail view now shows only the lines that
// are still unsigned.
//
// Pure: no I/O.
// ============================================================================

const crypto = require('crypto');

const KINDS = Object.freeze({ SERVICE_LINE: 'service_line', RATE: 'rate' });
const KIND_LABELS = Object.freeze({ service_line: 'Service line', rate: 'Agreed rate' });
const STATUS = Object.freeze({ PENDING: 'pending', APPROVED: 'approved', DECLINED: 'declined', SUPERSEDED: 'superseded' });

// Only the Super Admin approves. A manager or coordinator asks.
const needsApproval = (user) => !user || user.role !== 'admin';
const canApprove = (user) => !!user && user.role === 'admin' && user.accountStatus !== 'inactive';

// What a value reads as on screen and in the audit trail.
const describe = (kind, value) => {
  if (value == null) return 'not set';
  if (kind === KINDS.SERVICE_LINE) return String(value);
  if (kind === KINDS.RATE) return `$${Number(value.hourlyRate)}/hr, ${Number(value.dailyMinimumHours)}-hour daily minimum`;
  return String(value);
};

// The value a request compares against. A rate compares on the two numbers
// the documents print; everything else on the rate card is wording.
const fingerprint = (kind, value) => {
  if (value == null) return null;
  if (kind === KINDS.RATE) return `${Number(value.hourlyRate)}|${Number(value.dailyMinimumHours)}`;
  return String(value);
};

const pendingOf = (client, kind) =>
  ((client && client.enrollmentChangeRequests) || []).find(r => r.status === STATUS.PENDING && (!kind || r.kind === kind)) || null;

// File a request. One pending request per kind: a newer ask replaces the older
// one, which is kept and marked superseded so the trail still shows it.
const fileRequest = (client, { kind, value, previous, actor, note }) => {
  if (!Object.values(KINDS).includes(kind)) throw new Error(`Unknown change kind: ${kind}`);
  const now = new Date().toISOString();
  const list = Array.isArray(client.enrollmentChangeRequests) ? client.enrollmentChangeRequests.slice() : [];
  for (let i = 0; i < list.length; i++) {
    if (list[i].kind === kind && list[i].status === STATUS.PENDING) {
      list[i] = { ...list[i], status: STATUS.SUPERSEDED, decidedAt: now };
    }
  }
  const row = {
    id: crypto.randomUUID(), kind, value, previous: previous == null ? null : previous,
    summary: `${KIND_LABELS[kind]}: ${describe(kind, previous)} → ${describe(kind, value)}`,
    note: String(note || '').trim().slice(0, 500) || null,
    requestedBy: { id: actor.id, name: actor.name || actor.email || 'Staff' },
    requestedAt: now, status: STATUS.PENDING
  };
  list.push(row);
  client.enrollmentChangeRequests = list;
  return row;
};

// Can this pending request still be approved? If the value moved since it was
// asked, approving would apply someone's reasoning about one value to another.
const checkDecision = (client, requestId, decision, note, currentValue) => {
  const row = ((client && client.enrollmentChangeRequests) || []).find(r => r.id === requestId);
  if (!row) return { ok: false, status: 404, code: 'CHANGE_REQUEST_NOT_FOUND', error: 'That change request was not found.' };
  if (row.status !== STATUS.PENDING) return { ok: false, status: 409, code: 'CHANGE_REQUEST_DECIDED', error: `That request was already ${row.status}.` };
  if (!['approve', 'decline'].includes(decision)) return { ok: false, status: 400, code: 'BAD_DECISION', error: 'Decision must be approve or decline.' };
  if (decision === 'decline' && !String(note || '').trim()) {
    return { ok: false, status: 400, code: 'DECLINE_REASON_REQUIRED', error: 'Say why, so the person who asked knows what to do next.' };
  }
  if (decision === 'approve' && fingerprint(row.kind, currentValue) !== fingerprint(row.kind, row.previous)) {
    return {
      ok: false, status: 409, code: 'CHANGE_REQUEST_STALE',
      error: `The ${KIND_LABELS[row.kind].toLowerCase()} changed since this was asked (it was ${describe(row.kind, row.previous)}, it is now ${describe(row.kind, currentValue)}). Decline it and ask for a fresh request.`
    };
  }
  return { ok: true, row };
};

const recordDecision = (client, requestId, decision, actor, note) => {
  const now = new Date().toISOString();
  client.enrollmentChangeRequests = (client.enrollmentChangeRequests || []).map(r => r.id !== requestId ? r : {
    ...r, status: decision === 'approve' ? STATUS.APPROVED : STATUS.DECLINED,
    decidedBy: { id: actor.id, name: actor.name || actor.email || 'Admin' }, decidedAt: now,
    decisionNote: String(note || '').trim().slice(0, 500) || null
  });
  return client.enrollmentChangeRequests.find(r => r.id === requestId);
};

// What the enrollment screen shows: everything pending, plus the last 30 days
// of decisions so the person who asked sees the answer and the reason.
const RECENT_DAYS = 30;
const forDisplay = (client, now = Date.now()) => {
  const list = (client && client.enrollmentChangeRequests) || [];
  const cutoff = now - RECENT_DAYS * 86400000;
  return list
    .filter(r => r.status === STATUS.PENDING ||
      ((r.status === STATUS.APPROVED || r.status === STATUS.DECLINED) && Date.parse(r.decidedAt || 0) >= cutoff))
    .map(r => ({ ...r, kindLabel: KIND_LABELS[r.kind] || r.kind }))
    .sort((a, b) => String(b.requestedAt).localeCompare(String(a.requestedAt)));
};
const pendingCount = (client) => ((client && client.enrollmentChangeRequests) || []).filter(r => r.status === STATUS.PENDING).length;

// A consent banner shows only the consents still waiting. "Waiting" is not the
// same as "unsigned": the rate banner exists BECAUSE the money documents are
// signed, at the old rate. So a line clears when that consent was signed or
// recorded AFTER the banner went up (flag.at). A paper signature counts from
// when it was recorded, since the date on the paper can be older than the
// banner. Returns null once nothing is left, so the banner goes away by itself.
const latestSignature = (meta) => {
  if (!meta) return 0;
  return Math.max(Date.parse(meta.signedAt || 0) || 0, Date.parse(meta.recordedAt || 0) || 0);
};
const liveConsentFlag = (flag, consents, consentMeta, isSatisfied, titleFor) => {
  if (!flag || !Array.isArray(flag.consents)) return flag || null;
  const raisedAt = Date.parse(flag.at || 0) || 0;
  const done = (t) => isSatisfied((consents || {})[t]) && latestSignature((consentMeta || {})[t]) > raisedAt;
  const left = flag.consents.filter(t => !done(t));
  if (!left.length) return null;
  return { ...flag, consents: left, titles: left.map(t => titleFor(t)) };
};

module.exports = {
  KINDS, KIND_LABELS, STATUS, RECENT_DAYS,
  needsApproval, canApprove, describe, fingerprint, pendingOf,
  fileRequest, checkDecision, recordDecision, forDisplay, pendingCount,
  liveConsentFlag
};
