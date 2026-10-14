// clinicalTasks.js — patient to-dos, and the daily digest built around them.
//
// Owner-directed, 2026-10-13. The clinician Tasks view listed only queues the
// app built itself (unsigned notes, results, referrals, overdue orders). There
// was nowhere to write "call the daughter about PT" or "recheck BP Friday", so
// those lived on paper or in somebody's head.
//
// THREE RULES SHAPE EVERYTHING HERE:
//
//   1. A to-do is seen ONLY by the person it is assigned to and the person who
//      wrote it (owner rule). Not admin, not the rest of the team. `canSee` is
//      the one answer, and every route and the digest ask it. A hidden to-do
//      answers 404, never 403, so a refusal does not confirm it exists.
//   2. Every to-do is about a patient. A to-do with no patient is a personal
//      note, and this is a clinical record.
//   3. The audit trail records THAT a to-do changed, never what it says. The
//      title is PHI ("recheck potassium"), and an audit log is not a second copy.
//
// The date math is Georgia's: a to-do due "today" must not turn overdue at
// 8pm Eastern because UTC already moved on. The caller passes `today` from the
// practice clock; nothing here reads the system date to decide a bucket.
'use strict';
const crypto = require('crypto');
const clinicalRoles = require('./clinicalRoles');

const STATUSES = Object.freeze(['open', 'done', 'cancelled']);
const PRIORITIES = Object.freeze(['routine', 'soon', 'urgent']);
const CATEGORIES = Object.freeze([
  { value: 'call', label: 'Call' },
  { value: 'follow_up', label: 'Follow-up' },
  { value: 'paperwork', label: 'Paperwork' },
  { value: 'coordination', label: 'Care coordination' },
  { value: 'clinical', label: 'Clinical' },
  { value: 'other', label: 'Other' }
]);
const CATEGORY_VALUES = CATEGORIES.map(c => c.value);
const TITLE_MAX = 200;
const DETAIL_MAX = 2000;
const NOTE_MAX = 1000;
// How far ahead "upcoming" looks. One constant.
const UPCOMING_DAYS = 7;

const BUCKETS = Object.freeze({
  OVERDUE: 'overdue', TODAY: 'today', UPCOMING: 'upcoming', LATER: 'later', NO_DATE: 'no_date', CLOSED: 'closed'
});

class TaskError extends Error {
  constructor(message, code, status = 400) { super(message); this.code = code; this.status = status; }
}

const isYmd = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) &&
  !Number.isNaN(new Date(`${s}T12:00:00Z`).getTime()) &&
  new Date(`${s}T12:00:00Z`).toISOString().slice(0, 10) === s;

// Adds whole days to a bare calendar date. Read at midday UTC so no zone can
// move it across a day boundary.
const addDays = (ymd, n) => {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

// Who may write, complete and be assigned a to-do: admin, a manager, a case
// manager, or any licensed clinician. One predicate, in clinicalRoles.
const canManageTasks = (user) => clinicalRoles.canManageTasks(user);

const canSee = (task, user) => !!task && !!user && user.id != null && (
  String(task.assigneeId) === String(user.id) || String(task.createdById) === String(user.id));

const bucketFor = (task, today) => {
  if (!task || task.status !== 'open') return BUCKETS.CLOSED;
  if (!task.dueDate) return BUCKETS.NO_DATE;
  if (task.dueDate < today) return BUCKETS.OVERDUE;
  if (task.dueDate === today) return BUCKETS.TODAY;
  if (task.dueDate <= addDays(today, UPCOMING_DAYS)) return BUCKETS.UPCOMING;
  return BUCKETS.LATER;
};

const cleanText = (v, max) => String(v == null ? '' : v).replace(/\r\n?/g, '\n').trim().slice(0, max);

// Validates the editable fields. `partial` means an edit: an absent key is
// left alone. Refuses BY NAME rather than dropping a bad value.
const validateFields = (input, { partial = false, findUser } = {}) => {
  const src = (input && typeof input === 'object') ? input : {};
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(src, k);
  if (!partial || has('title')) {
    const t = cleanText(src.title, TITLE_MAX + 1);
    if (!t) throw new TaskError('A to-do needs a title.', 'TASK_TITLE_REQUIRED');
    if (t.length > TITLE_MAX) throw new TaskError(`Keep the title under ${TITLE_MAX} characters; put the rest in the details.`, 'TASK_TITLE_TOO_LONG');
    out.title = t;
  }
  if (has('detail')) {
    const d = cleanText(src.detail, DETAIL_MAX + 1);
    if (d.length > DETAIL_MAX) throw new TaskError(`Details are limited to ${DETAIL_MAX} characters.`, 'TASK_DETAIL_TOO_LONG');
    out.detail = d || null;
  }
  if (has('dueDate')) {
    const v = src.dueDate == null || src.dueDate === '' ? null : String(src.dueDate);
    if (v !== null && !isYmd(v)) throw new TaskError('The due date must be a real date (YYYY-MM-DD).', 'TASK_DUE_INVALID');
    out.dueDate = v;
  }
  if (!partial || has('priority')) {
    const p = src.priority == null || src.priority === '' ? 'routine' : String(src.priority);
    if (!PRIORITIES.includes(p)) throw new TaskError(`Priority must be one of: ${PRIORITIES.join(', ')}.`, 'TASK_PRIORITY_INVALID');
    out.priority = p;
  }
  if (!partial || has('category')) {
    const c = src.category == null || src.category === '' ? 'other' : String(src.category);
    if (!CATEGORY_VALUES.includes(c)) throw new TaskError(`Category must be one of: ${CATEGORY_VALUES.join(', ')}.`, 'TASK_CATEGORY_INVALID');
    out.category = c;
  }
  if (has('assigneeId')) {
    const id = src.assigneeId == null || src.assigneeId === '' ? null : String(src.assigneeId);
    if (id !== null) {
      const u = findUser ? findUser(id) : null;
      if (!u) throw new TaskError('That person was not found.', 'TASK_ASSIGNEE_NOT_FOUND', 404);
      if (!canManageTasks(u)) {
        throw new TaskError(`${u.name || 'That person'} is not on the clinical team, so a to-do cannot be assigned to them.`, 'TASK_ASSIGNEE_NOT_ELIGIBLE');
      }
      out.assigneeId = String(u.id);
      out.assigneeName = u.name || null;
    }
  }
  return out;
};

const changedKeys = (before, after) =>
  Object.keys(after).filter(k => JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null));

// History rows carry field NAMES, never values: the title and details are PHI.
const historyRow = (actor, action, fields, at) => ({
  at, action, byId: String(actor.id), byName: actor.name || null, ...(fields && fields.length ? { fields } : {})
});

const createTask = ({ input, actor, client, findUser, now }) => {
  if (!client) throw new TaskError('Choose the patient this to-do is about.', 'TASK_CLIENT_REQUIRED');
  const at = now || new Date().toISOString();
  const fields = validateFields({ assigneeId: actor.id, ...input }, { findUser });
  return {
    id: `task_${crypto.randomBytes(8).toString('hex')}`,
    clientId: String(client.id),
    title: fields.title,
    detail: fields.detail || null,
    dueDate: fields.dueDate || null,
    priority: fields.priority,
    category: fields.category,
    assigneeId: fields.assigneeId,
    assigneeName: fields.assigneeName,
    createdById: String(actor.id),
    createdByName: actor.name || null,
    createdAt: at,
    updatedAt: at,
    status: 'open',
    completedAt: null, completedById: null, completedByName: null, completionNote: null,
    cancelReason: null,
    history: [historyRow(actor, 'created', null, at)]
  };
};

// One function for every change: edit, done, cancel, reopen. Returns the new
// row; never mutates the input.
const applyTaskAction = ({ task, action, input, actor, findUser, now }) => {
  const at = now || new Date().toISOString();
  const next = { ...task, history: [...(task.history || [])] };
  const src = (input && typeof input === 'object') ? input : {};
  if (action === 'edit') {
    if (task.status !== 'open') throw new TaskError('Reopen this to-do before editing it.', 'TASK_NOT_OPEN', 409);
    const fields = validateFields(src, { partial: true, findUser });
    const keys = changedKeys(task, fields).filter(k => k !== 'assigneeName');
    if (!keys.length) return { task, changed: [] };
    Object.assign(next, fields, { updatedAt: at });
    next.history.push(historyRow(actor, 'edited', keys, at));
    return { task: next, changed: keys };
  }
  if (action === 'done') {
    if (task.status !== 'open') throw new TaskError('Only an open to-do can be marked done.', 'TASK_NOT_OPEN', 409);
    Object.assign(next, {
      status: 'done', completedAt: at, completedById: String(actor.id), completedByName: actor.name || null,
      completionNote: cleanText(src.note, NOTE_MAX) || null, updatedAt: at
    });
    next.history.push(historyRow(actor, 'done', null, at));
    return { task: next, changed: ['status'] };
  }
  if (action === 'cancel') {
    if (task.status !== 'open') throw new TaskError('Only an open to-do can be cancelled.', 'TASK_NOT_OPEN', 409);
    const reason = cleanText(src.reason, NOTE_MAX);
    if (!reason) throw new TaskError('Say why this to-do is being cancelled.', 'TASK_CANCEL_REASON_REQUIRED');
    Object.assign(next, { status: 'cancelled', cancelReason: reason, updatedAt: at });
    next.history.push(historyRow(actor, 'cancelled', null, at));
    return { task: next, changed: ['status'] };
  }
  if (action === 'reopen') {
    if (task.status === 'open') throw new TaskError('This to-do is already open.', 'TASK_ALREADY_OPEN', 409);
    Object.assign(next, {
      status: 'open', completedAt: null, completedById: null, completedByName: null,
      completionNote: null, cancelReason: null, updatedAt: at
    });
    next.history.push(historyRow(actor, 'reopened', null, at));
    return { task: next, changed: ['status'] };
  }
  throw new TaskError('Unknown action. Use edit, done, cancel or reopen.', 'TASK_ACTION_INVALID');
};

const PRIORITY_RANK = { urgent: 0, soon: 1, routine: 2 };
// Overdue and today first, then by due date, then priority, then oldest.
const sortTasks = (rows, today) => {
  const order = { overdue: 0, today: 1, upcoming: 2, later: 3, no_date: 4, closed: 5 };
  return [...rows].sort((a, b) =>
    (order[bucketFor(a, today)] - order[bucketFor(b, today)]) ||
    String(a.dueDate || '9999').localeCompare(String(b.dueDate || '9999')) ||
    ((PRIORITY_RANK[a.priority] ?? 2) - (PRIORITY_RANK[b.priority] ?? 2)) ||
    String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
};

// What the browser receives. The history is reduced to who/when/what, which
// is all it ever holds, and the bucket is decided here so the page decides no
// date math of its own.
const publicTask = (task, viewer, today) => ({
  id: task.id, clientId: task.clientId, patientName: task.patientName || null,
  title: task.title, detail: task.detail, dueDate: task.dueDate,
  priority: task.priority, category: task.category,
  assigneeId: task.assigneeId, assigneeName: task.assigneeName,
  createdById: task.createdById, createdByName: task.createdByName, createdAt: task.createdAt,
  status: task.status, completedAt: task.completedAt, completedByName: task.completedByName,
  completionNote: task.completionNote, cancelReason: task.cancelReason,
  bucket: bucketFor(task, today),
  mine: !!viewer && String(task.assigneeId) === String(viewer.id),
  assignedByMe: !!viewer && String(task.createdById) === String(viewer.id),
  history: (task.history || []).map(h => ({ at: h.at, action: h.action, byName: h.byName, fields: h.fields || null }))
});

// Filters to what the viewer may see, then by scope. `mine` = assigned to me;
// `assigned_by_me` = I wrote it for somebody else; `all` = either.
const listForViewer = ({ tasks, viewer, scope = 'all', clientId = null, includeClosed = false }) =>
  (tasks || []).filter(t => canSee(t, viewer))
    .filter(t => !clientId || String(t.clientId) === String(clientId))
    .filter(t => includeClosed || t.status === 'open')
    .filter(t => {
      if (scope === 'mine') return String(t.assigneeId) === String(viewer.id);
      if (scope === 'assigned_by_me') return String(t.createdById) === String(viewer.id) && String(t.assigneeId) !== String(viewer.id);
      return true;
    });

// ---- The daily digest ------------------------------------------------------
// "What needs me now" versus "what is coming". Built from what the app holds,
// scoped to the viewer, in one place so the My Day card and the Tasks screen
// cannot disagree. Every line carries where its work is done (`open`).
//
//   PENDING  my to-dos overdue or due today · inbox items waiting on me ·
//            results routed to me and not acknowledged · my orders overdue
//   UPCOMING my to-dos due in the next UPCOMING_DAYS · my visits in that
//            window (when the calendar could be read) · referrals I placed
//            that are still waiting to be scheduled
const buildDigest = ({
  viewer, today, tasks, inboxItems, results, overdueOrders, orders, appointments, calendar, nameOf
}) => {
  const name = (id) => (nameOf ? nameOf(id) : null) || 'Unnamed patient';
  const isMe = (id) => id != null && viewer && String(id) === String(viewer.id);
  const horizon = addDays(today, UPCOMING_DAYS);
  const pending = [];
  const upcoming = [];

  const mineTasks = listForViewer({ tasks, viewer, scope: 'mine' });
  for (const t of sortTasks(mineTasks, today)) {
    const b = bucketFor(t, today);
    const line = {
      kind: 'todo', id: t.id, clientId: t.clientId, patientName: name(t.clientId),
      title: t.title, when: t.dueDate, priority: t.priority, overdue: b === BUCKETS.OVERDUE,
      from: String(t.createdById) !== String(viewer.id) ? (t.createdByName || null) : null,
      open: { view: 'queues', tab: 'todos' }
    };
    if (b === BUCKETS.OVERDUE || b === BUCKETS.TODAY) pending.push(line);
    else if (b === BUCKETS.UPCOMING) upcoming.push(line);
  }

  for (const i of (inboxItems || [])) {
    if (!i || !i.actionable) continue;
    pending.push({
      kind: 'inbox', id: `inbox:${i.kind}:${i.id}`, clientId: i.clientId, patientName: i.patientName || name(i.clientId),
      title: i.label, when: i.dueAt ? String(i.dueAt).slice(0, 10) : null, overdue: !!i.overdue,
      encounterUuid: i.encounterUuid || null,
      open: { view: 'inbox' }
    });
  }

  for (const r of (results || [])) {
    if (!r || r.acknowledgedAt) continue;
    if (!isMe(r.routeTo && r.routeTo.userId)) continue;
    pending.push({
      kind: 'result', id: `result:${r.id}`, clientId: r.clientId, patientName: name(r.clientId),
      title: `${r.interpretation === 'critical' ? 'Critical result' : r.interpretation === 'abnormal' ? 'Abnormal result' : 'Result'} to review`,
      when: r.receivedAt ? String(r.receivedAt).slice(0, 10) : null,
      overdue: r.interpretation === 'critical',
      open: { view: 'chart', tab: 'results' }
    });
  }

  for (const o of (overdueOrders || [])) {
    if (!o || !isMe(o.orderingClinician && o.orderingClinician.id)) continue;
    pending.push({
      kind: 'order', id: `order:${o.id}`, clientId: o.clientId, patientName: name(o.clientId),
      title: `${o.orderType ? o.orderType.charAt(0).toUpperCase() + o.orderType.slice(1) : 'Order'} not answered after ${o.ageDays} days`,
      when: o.sentAt ? String(o.sentAt).slice(0, 10) : null, overdue: true,
      open: { view: 'chart', tab: 'orders' }
    });
  }

  for (const a of (appointments || [])) {
    if (!a || !a.date || a.date < today || a.date > horizon) continue;
    if (a.state === 'cancelled' || a.status === 'x' || a.status === '?') continue;
    upcoming.push({
      kind: 'visit', id: `visit:${a.eid}`, clientId: a.clientId, patientName: a.patientName || name(a.clientId),
      title: a.title || 'Clinical visit', when: a.date, time: a.startTime || null,
      open: { view: 'schedule' }
    });
  }

  for (const o of (orders || [])) {
    if (!o || o.orderType !== 'referral') continue;
    if (!isMe(o.orderingClinician && o.orderingClinician.id)) continue;
    if (!['ordered', 'sent'].includes(String(o.status))) continue;
    if (o.referral && o.referral.destination === 'internal') continue; // the inbox carries those
    upcoming.push({
      kind: 'referral', id: `referral:${o.id}`, clientId: o.clientId, patientName: name(o.clientId),
      title: `Referral${o.referral && o.referral.specialty ? ` to ${o.referral.specialty}` : ''} waiting to be scheduled`,
      when: null, open: { view: 'chart', tab: 'referrals' }
    });
  }

  const byWhen = (a, b) => (a.overdue === b.overdue ? 0 : a.overdue ? -1 : 1) ||
    String(a.when || '9999').localeCompare(String(b.when || '9999')) ||
    String(a.time || '').localeCompare(String(b.time || ''));
  pending.sort(byWhen);
  upcoming.sort(byWhen);
  return {
    today, upcomingDays: UPCOMING_DAYS,
    counts: { pending: pending.length, upcoming: upcoming.length, overdue: pending.filter(p => p.overdue).length },
    pending, upcoming,
    calendar: calendar || { ok: true, error: null }
  };
};

// ---------------------------------------------------------------------------
// THE DAILY EMAIL SWEEP (owner, 2026-10-14: "email every time a task is
// assigned, due, overdue (one email about task a day) and then marked
// completed.")
// ---------------------------------------------------------------------------
// Assigned and completed are EVENTS and are sent where they happen, at the
// route. Due and overdue are a STATE, so they are swept: a due date can be
// edited after the fact, which is exactly why nothing is scheduled at write
// time the way a visit reminder is. A to-do lives in this app's own store, so
// a background sweep may read it — the rule that stops the visit reminders
// being swept is OpenEMR's per-clinician OAuth, and it does not apply here.
//
// 9am Eastern, like the visit reminders. One constant.
const TASK_EMAIL_SEND_HOUR_ET = 9;

// ONE EMAIL ABOUT A TO-DO PER DAY, and the key is what guarantees it rather
// than the queue's cooldown window. Keyed on GEORGIA'S date, so a restart, a
// second scan or a changed scan interval cannot send twice, and the next
// calendar day is a new key rather than a duplicate.
const reminderKey = (task, kind, today) => `${task && task.id}:${kind}:${today}`;

// Whole days between two bare calendar dates, read at midday UTC so no zone
// moves either across a boundary.
const daysBetween = (from, to) =>
  Math.round((new Date(`${to}T12:00:00Z`) - new Date(`${from}T12:00:00Z`)) / 86400000);

// Which to-dos want an email right now. PURE: the caller passes Georgia's date
// and Georgia's hour, so nothing here reads a clock and the test does not have
// to run in Eastern to mean anything.
//
// NOTHING GOES OUT BEFORE THE SEND HOUR. The scanner runs every few minutes;
// without this a to-do created at 00:05 would be emailed at 00:05. After the
// hour every later scan that day re-derives the same rows and the date key
// above drops them, so the first scan past 9am is the one that sends.
//
// A to-do is due OR overdue, never both — `bucketFor` decides, and a closed,
// cancelled or undated one is never chased.
const remindersDue = ({ tasks, today, hourEt }) => {
  if (!isYmd(today) || !Number.isFinite(hourEt) || hourEt < TASK_EMAIL_SEND_HOUR_ET) return [];
  const out = [];
  for (const task of tasks || []) {
    // WHAT ACTUALLY DOES THE WORK is `bucketFor` below: it answers CLOSED for
    // a to-do that is not open and NO_DATE for one with no due date, so
    // neither reaches the two branches. This line is belt-and-braces, and is
    // recorded as such so a later simplification does not drop the real guard
    // believing this one covers it.
    if (!task || task.status !== 'open' || !task.dueDate) continue;
    const bucket = bucketFor(task, today);
    if (bucket === BUCKETS.TODAY) out.push({ task, kind: 'due', daysLate: 0 });
    else if (bucket === BUCKETS.OVERDUE) out.push({ task, kind: 'overdue', daysLate: daysBetween(task.dueDate, today) });
  }
  return out;
};

module.exports = {
  STATUSES, PRIORITIES, CATEGORIES, CATEGORY_VALUES, BUCKETS, UPCOMING_DAYS,
  TITLE_MAX, DETAIL_MAX, TaskError,
  isYmd, addDays, canManageTasks, canSee, bucketFor, validateFields,
  createTask, applyTaskAction, sortTasks, publicTask, listForViewer, buildDigest,
  TASK_EMAIL_SEND_HOUR_ET, reminderKey, daysBetween, remindersDue
};
