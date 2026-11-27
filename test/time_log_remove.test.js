'use strict';

// ============================================================================
// Hours changed on screen must change what payroll counts (owner, 2026-11-25)
//
// "We actually deleted that, but it doesn't delete from the payroll log ...
//  as we make manual changes to time on the UI, it reflects on the payroll
//  report."
//
// A caregiver's clock-in was left running for about a week. The office could
// CORRECT a time log, but there was no way to REMOVE one, so a clock-in that
// should not exist kept being paid by every payroll reader. These tests hold
// both halves: an edit reaches the payroll report and the payroll run, and a
// removal takes the hours out of both, while the record of what was removed
// is kept.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const engine = require('../payrollEngine');

const USERS = [
  { id: 'admin-1', name: 'Office Admin', role: 'admin' },
  { id: 'coord-1', name: 'Coco Ordinator', role: 'user', accountType: 'coordinator', isManager: true, clinicalRole: 'coordinator', employmentType: 'W2' },
  { id: 'cg-1', name: 'Cara Giver', role: 'vendor', accountType: 'caregiver', licenseLevel: 'pca', employmentType: 'W2', payRate: 15 },
  { id: 'client-1', name: 'Test Client', role: 'client' }
];

// A clock-in on Oct 14 that was not closed until Oct 22: about 183 hours.
const STUCK = {
  id: 'log-stuck', shift_id: 'shift-1', client_id: 'client-1', client_name: 'Test Client',
  caregiver_id: 'cg-1', caregiver_name: 'Cara Giver', license_level: 'pca',
  scheduled_start: '2026-10-14T13:00:00.000Z', scheduled_end: '2026-10-14T17:00:00.000Z',
  clock_in_at: '2026-10-14T13:00:00.000Z', clock_out_at: '2026-10-22T04:00:00.000Z',
  total_minutes: 183 * 60, flags: ['late_clock_out'], edited: false
};
// A normal visit the same caregiver also worked, which must be left alone.
const NORMAL = {
  ...STUCK, id: 'log-normal', shift_id: 'shift-2',
  scheduled_start: '2026-10-15T13:00:00.000Z', scheduled_end: '2026-10-15T17:00:00.000Z',
  clock_in_at: '2026-10-15T13:00:00.000Z', clock_out_at: '2026-10-15T17:00:00.000Z',
  total_minutes: 240, flags: []
};
const SHIFTS = [
  { id: 'shift-1', client_id: 'client-1', client_name: 'Test Client', caregiver_id: 'cg-1', caregiver_name: 'Cara Giver', status: 'completed', start: STUCK.scheduled_start, end: STUCK.scheduled_end },
  { id: 'shift-2', client_id: 'client-1', client_name: 'Test Client', caregiver_id: 'cg-1', caregiver_name: 'Cara Giver', status: 'completed', start: NORMAL.scheduled_start, end: NORMAL.scheduled_end }
];

async function mount(t, extra = {}) {
  const seed = Object.assign({ users: USERS, time_logs: [STUCK, NORMAL], shifts: SHIFTS }, extra);
  const store = new Map(Object.entries(JSON.parse(JSON.stringify(seed))));
  const activity = [];
  const db = { get: async (k) => (store.has(k) ? JSON.parse(JSON.stringify(store.get(k))) : null), set: async (k, v) => { store.set(k, JSON.parse(JSON.stringify(v))); } };
  const router = require('../routes/scheduling')({
    db, config: require('../config'), logActivity: async (...a) => { activity.push(a); }, queueNotification: async () => {},
    getUsers: async () => await db.get('users'), invalidateUsersCache: () => {},
    authenticateToken: (req, _res, next) => { const u = USERS.find(x => x.id === (req.headers['x-as'] || 'admin-1')); req.user = { ...u, isManager: !!u.isManager }; next(); },
    uuidv4: () => `id-${Math.random().toString(36).slice(2, 10)}`
  });
  const app = express(); app.use(express.json()); app.use(router);
  const server = app.listen(0); t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, as) => {
    const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(as ? { 'x-as': as } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch (_) { /* csv */ }
    return { status: res.status, json, text };
  };
  // What the payroll report shows for the range, as numbers.
  const report = async () => {
    const r = await call('GET', '/api/scheduling/payroll?from=2026-10-01&to=2026-10-31');
    assert.strictEqual(r.status, 200, r.text);
    return r.json.rows;
  };
  const reportHours = async () => (await report()).reduce((a, row) => a + (Number(row.hours) || 0), 0);
  // What a payroll run (and the timesheets) would pay, from the same store.
  const runMinutes = async () => {
    const g = engine.gatherItems({
      period: { start: '2026-10-01', end: '2026-10-31' }, users: await db.get('users'), profilesById: new Map(),
      timeLogs: (await db.get('time_logs')) || [], shifts: (await db.get('shifts')) || [], visitTimings: [], imeCases: [],
      paidRefs: new Set(), localDate: (iso) => String(iso).slice(0, 10), resolvePayRate: () => ({ rate: 15, source: 'test' })
    });
    return (g.byUser.get('cg-1') || []).reduce((a, it) => a + (Number(it.minutes) || 0), 0);
  };
  return { store, call, report, reportHours, runMinutes, activity };
}

test('before any change, the stuck clock-in is counted in full (the reported problem)', async (t) => {
  const h = await mount(t);
  assert.strictEqual(await h.reportHours(), 187);
  assert.strictEqual(await h.runMinutes(), 187 * 60);
});

test('EDIT: correcting the times on screen changes the payroll report and the payroll run', async (t) => {
  const h = await mount(t);
  const r = await h.call('PUT', '/api/scheduling/time-logs/log-stuck', {
    clockInAt: '2026-10-14T13:00:00.000Z', clockOutAt: '2026-10-14T17:30:00.000Z', reason: 'Forgot to clock out at 1:30'
  });
  assert.strictEqual(r.status, 200, r.text);
  const row = (await h.report()).find(x => x.timeLogId === 'log-stuck');
  assert.strictEqual(row.hours, 4.5, 'the report reads the corrected time');
  assert.strictEqual(row.edited, 'yes');
  assert.strictEqual(await h.reportHours(), 8.5);
  assert.strictEqual(await h.runMinutes(), 270 + 240, 'the payroll run pays the corrected time');
});

test('REMOVE: taking the hours off the record takes them out of the payroll report and the payroll run', async (t) => {
  const h = await mount(t);
  const r = await h.call('POST', '/api/scheduling/time-logs/log-stuck/remove', { reason: 'Clock left running; real hours entered separately' });
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(r.json.removed, true);

  // Gone from what payroll reads ...
  assert.deepStrictEqual(h.store.get('time_logs').map(l => l.id), ['log-normal']);
  const rows = await h.report();
  assert.ok(!rows.some(x => x.timeLogId === 'log-stuck'), 'the removed hours are not on the report');
  assert.strictEqual(await h.reportHours(), 4, 'only the real visit is counted');
  assert.strictEqual(await h.runMinutes(), 240, 'the payroll run no longer pays the removed hours');
  // ... and the visit itself still shows, with NO hours, so nobody mistakes
  // "removed" for "worked nothing and nobody noticed".
  const gap = rows.find(x => x.rowKey === 'shift:shift-1');
  assert.ok(gap, 'the completed shift is still on the report');
  assert.strictEqual(gap.hours, null);
  assert.strictEqual(gap.source, 'No time recorded');

  // ... and never lost: archived whole, with who, when and why.
  const archived = h.store.get('time_logs_removed');
  assert.strictEqual(archived.length, 1);
  assert.strictEqual(archived[0].id, 'log-stuck');
  assert.strictEqual(archived[0].total_minutes, 183 * 60);
  assert.strictEqual(archived[0].removed_by, 'admin-1');
  assert.match(archived[0].removal_reason, /Clock left running/);
  const trail = h.store.get('time_log_edits');
  assert.strictEqual(trail.length, 1);
  assert.strictEqual(trail[0].kind, 'removed');
  assert.strictEqual(trail[0].before.totalMinutes, 183 * 60);
  assert.ok(h.activity.some(a => a[2] === 'time_log_removed' && a[4] === 'log-stuck'));
});

test('REMOVE then ENTER: the real hours entered by hand replace the removed ones on the report', async (t) => {
  const h = await mount(t);
  await h.call('POST', '/api/scheduling/time-logs/log-stuck/remove', { reason: 'Clock left running' });
  const entered = await h.call('POST', '/api/scheduling/time-logs', {
    caregiverId: 'cg-1', clientId: 'client-1', shiftId: 'shift-1',
    clockInAt: '2026-10-14T13:00:00.000Z', clockOutAt: '2026-10-14T17:00:00.000Z', reason: 'Hours confirmed with the client'
  });
  assert.strictEqual(entered.status, 200, entered.text);
  assert.strictEqual(await h.reportHours(), 8);
  assert.strictEqual(await h.runMinutes(), 480);
});

test('REMOVE needs a reason and the Super Admin', async (t) => {
  const h = await mount(t);
  assert.strictEqual((await h.call('POST', '/api/scheduling/time-logs/log-stuck/remove', {})).json.code, 'REMOVE_REASON_REQUIRED');
  const asCoord = await h.call('POST', '/api/scheduling/time-logs/log-stuck/remove', { reason: 'x' }, 'coord-1');
  assert.strictEqual(asCoord.status, 403);
  assert.strictEqual((await h.call('POST', '/api/scheduling/time-logs/nope/remove', { reason: 'x' })).status, 404);
  assert.strictEqual(h.store.get('time_logs').length, 2, 'nothing was removed');
});

test('REMOVE refuses hours already paid, already invoiced, waiting on a correction, or still running', async (t) => {
  const paid = await mount(t, { time_logs: [{ ...STUCK, payroll_run_id: 'run-1' }, NORMAL] });
  assert.strictEqual((await paid.call('POST', '/api/scheduling/time-logs/log-stuck/remove', { reason: 'x' })).json.code, 'TIME_LOG_PAYROLL_LOCKED');

  const invoiced = await mount(t, { patient_invoices: [{ id: 'inv-1', number: 'INV-7', status: 'sent', lines: [{ timeLogId: 'log-stuck' }] }] });
  assert.strictEqual((await invoiced.call('POST', '/api/scheduling/time-logs/log-stuck/remove', { reason: 'x' })).json.code, 'TIME_LOG_INVOICED');
  const voided = await mount(t, { patient_invoices: [{ id: 'inv-1', number: 'INV-7', status: 'void', lines: [{ timeLogId: 'log-stuck' }] }] });
  assert.strictEqual((await voided.call('POST', '/api/scheduling/time-logs/log-stuck/remove', { reason: 'x' })).status, 200, 'a void invoice does not hold the hours');

  const pending = await mount(t, { time_log_adjustment_requests: [{ id: 'req-1', time_log_id: 'log-stuck', status: 'pending' }] });
  assert.strictEqual((await pending.call('POST', '/api/scheduling/time-logs/log-stuck/remove', { reason: 'x' })).json.code, 'ADJUSTMENT_ALREADY_PENDING');

  const running = await mount(t, {
    time_logs: [{ ...STUCK, clock_out_at: null, total_minutes: null }, NORMAL],
    shifts: [{ ...SHIFTS[0], status: 'in_progress' }, SHIFTS[1]]
  });
  assert.strictEqual((await running.call('POST', '/api/scheduling/time-logs/log-stuck/remove', { reason: 'x' })).json.code, 'TIME_LOG_STILL_OPEN');

  for (const h of [paid, invoiced, pending, running]) assert.strictEqual(h.store.get('time_logs').length, 2, 'a refusal removes nothing');
});

test('removed hours are a registered collection, so a data migration carries them', () => {
  const m = require('../dataMigration');
  const reg = m.COLLECTION_REGISTRY || m.REGISTRY;
  const keys = (Array.isArray(reg) ? reg : Object.values(reg || {})).map(r => r.key);
  assert.ok(keys.includes('time_logs_removed'));
});

// ---- A shift cancelled after it was clocked (owner, 2026-11-27) -----------
// "the fix of payroll changes when shifts deleted or adjusted showing in the
// report is not fixed." Setting a worked shift to cancelled by hand (the
// status override) left its clocked hours on every payroll reader.

test('CANCEL: setting a clocked shift to cancelled takes its hours off the report, the run and billing', async (t) => {
  const h = await mount(t);
  const r = await h.call('POST', '/api/scheduling/shifts/shift-2/status', { status: 'cancelled', reason: 'Visit did not happen' });
  assert.strictEqual(r.status, 200, r.text);
  assert.match(r.json.message, /no longer count/);
  const rows = await h.report();
  assert.ok(!rows.some(x => x.timeLogId === 'log-normal'), 'the cancelled shift is not on the report');
  assert.strictEqual(await h.reportHours(), 183);
  assert.strictEqual(await h.runMinutes(), 183 * 60, 'the payroll run no longer pays it');
  const bill = await h.call('GET', '/api/scheduling/billing?from=2026-10-01&to=2026-10-31');
  assert.strictEqual(bill.status, 200, bill.text);
  assert.ok(!bill.json.rows.some(x => x.timeLogId === 'log-normal'), 'nor is it billed');
  // The time log itself is untouched, so setting the shift back restores it.
  assert.ok(h.store.get('time_logs').some(l => l.id === 'log-normal'));
  const back = await h.call('POST', '/api/scheduling/shifts/shift-2/status', { status: 'completed', reason: 'It did happen' });
  assert.strictEqual(back.status, 200, back.text);
  assert.match(back.json.message, /count again/);
  assert.strictEqual(await h.reportHours(), 187);
});

test('CANCEL: a visit the office ended while under way keeps its hours', async (t) => {
  const ended = { ...NORMAL, ended_by_office: true };
  const h = await mount(t, { time_logs: [STUCK, ended], shifts: [SHIFTS[0], { ...SHIFTS[1], status: 'cancelled' }] });
  assert.strictEqual(await h.reportHours(), 187);
  assert.strictEqual(await h.runMinutes(), 187 * 60);
});

test('CANCEL: hours already paid in a run stay on the report', async (t) => {
  const paid = { ...NORMAL, payroll_run_id: 'run-1' };
  const h = await mount(t, { time_logs: [STUCK, paid], shifts: [SHIFTS[0], { ...SHIFTS[1], status: 'cancelled' }] });
  assert.ok((await h.report()).some(x => x.timeLogId === 'log-normal'));
});

test('hoursVoidedByCancel is the one rule, and invoice-run hours use it', () => {
  const sched = require('../schedulingRepository');
  const idx = sched.shiftIndex([{ id: 's1', status: 'cancelled' }, { id: 's2', status: 'completed' }]);
  assert.strictEqual(sched.hoursVoidedByCancel({ shift_id: 's1' }, idx), true);
  assert.strictEqual(sched.hoursVoidedByCancel({ shift_id: 's2' }, idx), false);
  assert.strictEqual(sched.hoursVoidedByCancel({ shift_id: 's1', ended_by_office: true }, idx), false);
  assert.strictEqual(sched.hoursVoidedByCancel({ shift_id: 's1', payroll_run_id: 'r' }, idx), false);
  assert.strictEqual(sched.hoursVoidedByCancel({ kind: 'staff' }, idx), false);
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'server.js'), 'utf8');
  const at = src.indexOf('phcInvoices.rowsFromTimeLogs(');
  assert.ok(at > 0 && src.slice(at - 600, at).includes('hoursVoidedByCancel'), 'invoice runs filter cancelled-shift hours');
});
