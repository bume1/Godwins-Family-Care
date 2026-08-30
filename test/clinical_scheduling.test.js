// ============================================================
// Session 4.2 — clinical scheduling invariants (build-fail guards)
//
// Pure-function tests over clinicalRepository.js scheduling helpers:
//   1. Appointment field validation (date/time/duration/provider, location
//      marker round-trips through OpenEMR's pc_hometext — no app-side store).
//   2. Conflict detection against live OpenEMR rows: overlaps rejected,
//      back-to-back allowed, cancelled/no-show rows never block a slot.
//   3. Tombstone swap payloads: the superseded slot is ALWAYS preserved as a
//      cancelled row (never a bare hard delete), reasons are stamped on.
//   4. Chart state derivation: documented / no-show / cancelled /
//      not-yet-documented (Scope B).
// Run: npm test
// ============================================================

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  APPT_STATUS,
  buildAppointmentFields,
  findAppointmentConflict,
  buildCancelTombstone,
  buildReschedulePayloads,
  buildStatusSwap,
  deriveAppointmentState,
  summarizeAppointmentRow,
  encodeAppointmentNotes,
  decodeAppointmentNotes,
  rowDurationMinutes
} = require('../clinicalRepository');

const DEFAULTS = { categoryId: '5', facilityId: '3' };
const GOOD_INPUT = {
  providerId: '1', date: '2026-09-02', startTime: '14:00',
  durationMinutes: 30, title: 'Follow-up', location: 'telehealth', notes: 'ring first'
};
// A live-shaped OpenEMR row (list endpoints omit pc_duration; end time carries it)
const ROW = {
  pc_eid: '8', pc_uuid: 'uuid-8', pc_aid: '1', pc_apptstatus: '-',
  pc_eventDate: '2026-09-02', pc_startTime: '14:00:00', pc_endTime: '14:30:00',
  pc_catid: '5', pc_facility: '3', pc_billing_location: '3',
  pc_title: 'Follow-up', pc_hometext: '[GFC location=home]\nring first',
  pid: '1', puuid: 'puuid-1', fname: 'TEST', lname: 'PatientOne'
};

// ---- 1. Field validation + location marker ----
test('buildAppointmentFields maps a valid request to OpenEMR POST fields', () => {
  const built = buildAppointmentFields(GOOD_INPUT, DEFAULTS);
  assert.ok(!built.error);
  assert.equal(built.fields.pc_eventDate, '2026-09-02');
  assert.equal(built.fields.pc_startTime, '14:00');
  assert.equal(built.fields.pc_duration, String(30 * 60)); // seconds
  assert.equal(built.fields.pc_apptstatus, APPT_STATUS.none);
  assert.equal(built.fields.pc_aid, '1');
  assert.match(built.fields.pc_hometext, /^\[GFC location=telehealth\]/);
});

test('buildAppointmentFields rejects bad date, time, duration, provider', () => {
  assert.equal(buildAppointmentFields({ ...GOOD_INPUT, date: '9/2/26' }, DEFAULTS).code, 'APPT_BAD_DATE');
  assert.equal(buildAppointmentFields({ ...GOOD_INPUT, startTime: '2pm' }, DEFAULTS).code, 'APPT_BAD_TIME');
  assert.equal(buildAppointmentFields({ ...GOOD_INPUT, durationMinutes: 0 }, DEFAULTS).code, 'APPT_BAD_DURATION');
  assert.equal(buildAppointmentFields({ ...GOOD_INPUT, durationMinutes: 9999 }, DEFAULTS).code, 'APPT_BAD_DURATION');
  assert.equal(buildAppointmentFields({ ...GOOD_INPUT, providerId: '' }, DEFAULTS).code, 'APPT_NO_PROVIDER');
  assert.equal(buildAppointmentFields({ ...GOOD_INPUT, providerId: 'abc' }, DEFAULTS).code, 'APPT_NO_PROVIDER');
});

test('location marker round-trips through pc_hometext (no app-side store)', () => {
  const enc = encodeAppointmentNotes('telehealth', 'ring first');
  assert.deepEqual(decodeAppointmentNotes(enc), { location: 'telehealth', notes: 'ring first' });
  assert.deepEqual(decodeAppointmentNotes('plain legacy note'), { location: null, notes: 'plain legacy note' });
  // Unknown location falls back to home
  const built = buildAppointmentFields({ ...GOOD_INPUT, location: 'moon' }, DEFAULTS);
  assert.equal(built.location, 'home');
});

// ---- 2. Conflict detection (OpenEMR is the availability authority) ----
test('overlapping slot for the same provider/date conflicts', () => {
  const hit = findAppointmentConflict([ROW], { providerId: '1', date: '2026-09-02', startTime: '14:15', durationMinutes: 30 });
  assert.equal(hit && String(hit.pc_eid), '8');
});

test('back-to-back slots do NOT conflict', () => {
  assert.equal(findAppointmentConflict([ROW], { providerId: '1', date: '2026-09-02', startTime: '14:30', durationMinutes: 30 }), null);
  assert.equal(findAppointmentConflict([ROW], { providerId: '1', date: '2026-09-02', startTime: '13:30', durationMinutes: 30 }), null);
});

test('other provider / other date / cancelled / no-show rows never block a slot', () => {
  const probe = { providerId: '1', date: '2026-09-02', startTime: '14:00', durationMinutes: 30 };
  assert.equal(findAppointmentConflict([{ ...ROW, pc_aid: '2' }], probe), null);
  assert.equal(findAppointmentConflict([{ ...ROW, pc_eventDate: '2026-09-03' }], probe), null);
  assert.equal(findAppointmentConflict([{ ...ROW, pc_apptstatus: APPT_STATUS.cancelled }], probe), null);
  assert.equal(findAppointmentConflict([{ ...ROW, pc_apptstatus: APPT_STATUS.noShow }], probe), null);
});

test('ignoreEids lets a reschedule keep (or overlap) its own old slot', () => {
  const probe = { providerId: '1', date: '2026-09-02', startTime: '14:00', durationMinutes: 30, ignoreEids: ['8'] };
  assert.equal(findAppointmentConflict([ROW], probe), null);
});

test('duration falls back to the start→end span when pc_duration is absent', () => {
  assert.equal(rowDurationMinutes(ROW), 30);
  assert.equal(rowDurationMinutes({ ...ROW, pc_duration: 3600 }), 60);
});

// ---- 3. Tombstone swap payloads (never a bare hard delete) ----
test('cancel tombstone preserves the slot and stamps the reason, status x', () => {
  const t = buildCancelTombstone(ROW, { reason: 'patient request', byName: 'Bethel Godwins, FNP-C', at: '2026-08-29T12:00:00Z' });
  assert.equal(t.pc_apptstatus, APPT_STATUS.cancelled);
  assert.equal(t.pc_eventDate, ROW.pc_eventDate);
  assert.equal(t.pc_startTime, '14:00');
  assert.equal(t.pc_duration, String(30 * 60));
  assert.equal(t.pc_aid, ROW.pc_aid);
  assert.match(t.pc_hometext, /CANCELLED 2026-08-29T12:00:00Z by Bethel Godwins, FNP-C/);
  assert.match(t.pc_hometext, /Reason: patient request/);
  // The original notes survive on the tombstone
  assert.match(t.pc_hometext, /ring first/);
});

test('reschedule builds a new active row AND a cancelled tombstone of the old slot', () => {
  const built = buildAppointmentFields({ ...GOOD_INPUT, date: '2026-09-03', startTime: '10:00' }, DEFAULTS);
  const { newRow, tombstone } = buildReschedulePayloads(ROW, built, { byName: 'Bethel', at: '2026-08-29T12:00:00Z' });
  assert.equal(newRow.pc_eventDate, '2026-09-03');
  assert.equal(newRow.pc_startTime, '10:00');
  assert.equal(newRow.pc_apptstatus, APPT_STATUS.none);
  assert.match(newRow.pc_hometext, /Rescheduled from 2026-09-02 14:00/);
  assert.equal(tombstone.pc_apptstatus, APPT_STATUS.cancelled);
  assert.equal(tombstone.pc_eventDate, '2026-09-02'); // old slot preserved
  assert.equal(tombstone.pc_startTime, '14:00');
  assert.match(tombstone.pc_hometext, /Rescheduled to 2026-09-03 10:00/);
});

test('no-show swap keeps the slot and flips only the status', () => {
  const s = buildStatusSwap(ROW, APPT_STATUS.noShow, { byName: 'Bethel', at: '2026-08-29T12:00:00Z' });
  assert.equal(s.pc_apptstatus, APPT_STATUS.noShow);
  assert.equal(s.pc_eventDate, ROW.pc_eventDate);
  assert.equal(s.pc_startTime, '14:00');
  assert.match(s.pc_hometext, /Marked no-show/);
});

// ---- 4. Chart state derivation (Scope B) ----
test('appointment state: documented > cancelled > no_show > scheduled/needs_documentation', () => {
  const now = new Date('2026-09-01T12:00:00');
  assert.equal(deriveAppointmentState(ROW, 'enc-uuid', now), 'documented');
  assert.equal(deriveAppointmentState({ ...ROW, pc_apptstatus: 'x' }, null, now), 'cancelled');
  assert.equal(deriveAppointmentState({ ...ROW, pc_apptstatus: '?' }, null, now), 'no_show');
  assert.equal(deriveAppointmentState(ROW, null, now), 'scheduled'); // future
  assert.equal(deriveAppointmentState(ROW, null, new Date('2026-09-05T12:00:00')), 'needs_documentation'); // past, no encounter
});

test('summarizeAppointmentRow exposes the calendar/chart shape', () => {
  const s = summarizeAppointmentRow(ROW, null, new Date('2026-09-01T12:00:00'));
  assert.equal(s.eid, '8');
  assert.equal(s.startTime, '14:00');
  assert.equal(s.endTime, '14:30');
  assert.equal(s.durationMinutes, 30);
  assert.equal(s.location, 'home');
  assert.equal(s.notes, 'ring first');
  assert.equal(s.patientName, 'TEST PatientOne');
  assert.equal(s.state, 'scheduled');
  assert.equal(s.encounterUuid, null);
});
