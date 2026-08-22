// ============================================================
// Clinician scheduling — pure helpers (Session 4.2)
//
// OpenEMR is the source of truth for clinical appointments (v2 §6 / the 4.2
// architecture rule). This module holds only PURE logic: OpenEMR pc_* field
// mapping, conflict detection, and calendar grouping. No I/O — server.js wires
// it to openemr.js, and test/clinical_scheduling.test.js exercises it directly
// so the invariants (no double-booking, no silent field loss) are build-enforced.
//
// NOTE: PHCP caregiver shifts (Session 7) are a SEPARATE system backed by the
// app store. Nothing here may be reused to schedule caregivers — two scheduling
// systems by design.
// ============================================================

// App-level status vocabulary ↔ OpenEMR pc_apptstatus single-char codes.
const APPT_STATUS_TO_EMR = {
  scheduled:  '-',
  confirmed:  '*',
  arrived:    '@',
  cancelled:  'x',
  no_show:    '?',
  checked_out:'%'
};
const EMR_TO_APPT_STATUS = Object.fromEntries(
  Object.entries(APPT_STATUS_TO_EMR).map(([k, v]) => [v, k]));
const APPOINTMENT_STATUSES = Object.keys(APPT_STATUS_TO_EMR);
// Statuses that no longer occupy the provider's slot.
const RELEASING_STATUSES = ['cancelled', 'no_show'];

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const YMD = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

const toMinutes = (hhmm) => {
  const m = HHMM.exec(String(hhmm || ''));
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
};
const toHHMM = (mins) => {
  const v = ((Math.round(mins) % 1440) + 1440) % 1440;
  return `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;
};

// ---- Validation + mapping: app shape → OpenEMR standard-API appointment ----
// OpenEMR takes pc_duration in SECONDS; everything the app speaks is minutes.
const validateAppointmentInput = (input) => {
  const i = input || {};
  if (!YMD.test(String(i.date || ''))) return { error: 'date must be YYYY-MM-DD', code: 'APPT_BAD_DATE' };
  if (toMinutes(i.startTime) === null) return { error: 'startTime must be HH:MM (24h)', code: 'APPT_BAD_TIME' };
  const dur = Number(i.durationMinutes);
  if (!Number.isFinite(dur) || dur <= 0 || dur > 480) {
    return { error: 'durationMinutes must be between 1 and 480', code: 'APPT_BAD_DURATION' };
  }
  if (toMinutes(i.startTime) + dur > 1440) {
    return { error: 'Appointment would run past midnight; split it across days', code: 'APPT_OVERNIGHT' };
  }
  if (!i.providerId) return { error: 'providerId is required', code: 'APPT_NO_PROVIDER' };
  if (i.status && !APPOINTMENT_STATUSES.includes(i.status)) {
    return { error: `status must be one of ${APPOINTMENT_STATUSES.join(', ')}`, code: 'APPT_BAD_STATUS' };
  }
  return { ok: true };
};

const toEmrAppointment = (input, defaults) => {
  const v = validateAppointmentInput(input);
  if (v.error) return v;
  const d = defaults || {};
  const i = input;
  return {
    fields: {
      pc_catid: String(i.categoryId || d.categoryId || '5'),
      pc_title: String(i.title || 'Home visit').slice(0, 150),
      pc_duration: String(Math.round(Number(i.durationMinutes) * 60)),  // seconds
      pc_hometext: String(i.comments || '').slice(0, 2000),
      pc_apptstatus: APPT_STATUS_TO_EMR[i.status || 'scheduled'],
      pc_eventDate: i.date,
      pc_startTime: i.startTime,
      pc_facility: String(i.facilityId || d.facilityId || '3'),
      pc_billing_location: String(i.facilityId || d.facilityId || '3'),
      pc_aid: String(i.providerId)
    }
  };
};

// ---- Mapping: OpenEMR standard-API row → app display shape ----
const fromEmrAppointment = (row) => {
  if (!row || typeof row !== 'object') return null;
  const durSec = Number(row.pc_duration);
  const durationMinutes = Number.isFinite(durSec) && durSec > 0 ? Math.round(durSec / 60) : null;
  const startTime = String(row.pc_startTime || '').slice(0, 5);
  const startMin = toMinutes(startTime);
  return {
    id: row.pc_eid != null ? String(row.pc_eid) : (row.pc_uuid || row.uuid || null),
    uuid: row.pc_uuid || row.uuid || null,
    date: row.pc_eventDate || null,
    startTime: startTime || null,
    endTime: (startMin !== null && durationMinutes) ? toHHMM(startMin + durationMinutes) : null,
    durationMinutes,
    title: row.pc_title || 'Visit',
    comments: row.pc_hometext || '',
    status: EMR_TO_APPT_STATUS[row.pc_apptstatus] || 'scheduled',
    providerId: row.pc_aid != null ? String(row.pc_aid) : null,
    patientId: row.pc_pid != null ? String(row.pc_pid) : null,
    patientName: [row.fname, row.lname].filter(Boolean).join(' ') || null,
    encounterUuid: row.pc_eventDate && row.encounter ? String(row.encounter) : null
  };
};

// ---- Mapping: FHIR Appointment → app display shape (read-back verification) ----
const fromFhirAppointment = (r) => {
  if (!r || r.resourceType !== 'Appointment') return null;
  const start = r.start ? new Date(r.start) : null;
  const end = r.end ? new Date(r.end) : null;
  const valid = start && !isNaN(start.getTime());
  const pad = (n) => String(n).padStart(2, '0');
  return {
    id: r.id,
    date: valid ? `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}` : null,
    startTime: valid ? `${pad(start.getHours())}:${pad(start.getMinutes())}` : null,
    durationMinutes: (valid && end && !isNaN(end.getTime())) ? Math.round((end - start) / 60000) : null,
    title: r.description || (r.serviceType && r.serviceType[0] && r.serviceType[0].text) || 'Visit',
    status: r.status || null
  };
};

// ---- Conflict detection (the non-negotiable invariant) ----
// Two appointments collide when they belong to the SAME provider, fall on the
// same date, their [start, end) ranges overlap, and neither has been released
// (cancelled / no-show). `ignoreId` lets a reschedule skip its own row.
const overlaps = (aStart, aDur, bStart, bDur) =>
  aStart < bStart + bDur && bStart < aStart + aDur;

const findConflicts = (candidate, existing, options) => {
  const opts = options || {};
  const c = candidate || {};
  const cStart = toMinutes(c.startTime);
  const cDur = Number(c.durationMinutes);
  if (cStart === null || !Number.isFinite(cDur) || cDur <= 0) return [];
  if (RELEASING_STATUSES.includes(c.status)) return [];   // booking a cancellation blocks nothing
  const ignoreId = opts.ignoreId != null ? String(opts.ignoreId) : null;

  return (existing || []).filter(e => {
    if (!e) return false;
    if (ignoreId && String(e.id) === ignoreId) return false;
    if (RELEASING_STATUSES.includes(e.status)) return false;
    if (String(e.providerId) !== String(c.providerId)) return false;
    if (e.date !== c.date) return false;
    const eStart = toMinutes(e.startTime);
    const eDur = Number(e.durationMinutes);
    if (eStart === null || !Number.isFinite(eDur) || eDur <= 0) return false;
    return overlaps(cStart, cDur, eStart, eDur);
  });
};

const describeConflict = (conflict) =>
  `${conflict.startTime}–${conflict.endTime || toHHMM(toMinutes(conflict.startTime) + (conflict.durationMinutes || 0))}` +
  `${conflict.patientName ? ` (${conflict.patientName})` : ''}`;

// ---- Calendar grouping ----
const DAY_MS = 86400000;
const isoDate = (d) => {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
// Monday-anchored week containing `dateStr`.
const weekRange = (dateStr) => {
  const base = new Date(`${dateStr}T00:00:00`);
  if (isNaN(base.getTime())) return null;
  const dow = (base.getDay() + 6) % 7;                 // Mon=0 … Sun=6
  const start = new Date(base.getTime() - dow * DAY_MS);
  const days = Array.from({ length: 7 }, (_, i) => isoDate(new Date(start.getTime() + i * DAY_MS)));
  return { start: days[0], end: days[6], days };
};

// Group appointments into { 'YYYY-MM-DD': [appt, …] }, each day sorted by time.
const groupByDay = (appointments, days) => {
  const out = {};
  for (const d of (days || [])) out[d] = [];
  for (const a of (appointments || [])) {
    if (!a || !a.date) continue;
    if (days && !(a.date in out)) continue;
    (out[a.date] = out[a.date] || []).push(a);
  }
  for (const d of Object.keys(out)) {
    out[d].sort((x, y) => (toMinutes(x.startTime) ?? 0) - (toMinutes(y.startTime) ?? 0));
  }
  return out;
};

const upcomingFor = (appointments, fromDate, limit) => {
  const from = fromDate || isoDate(new Date());
  return (appointments || [])
    .filter(a => a && a.date && a.date >= from && !RELEASING_STATUSES.includes(a.status))
    .sort((a, b) => a.date === b.date
      ? (toMinutes(a.startTime) ?? 0) - (toMinutes(b.startTime) ?? 0)
      : a.date.localeCompare(b.date))
    .slice(0, limit || 10);
};

module.exports = {
  APPOINTMENT_STATUSES,
  APPT_STATUS_TO_EMR,
  EMR_TO_APPT_STATUS,
  RELEASING_STATUSES,
  toMinutes,
  toHHMM,
  validateAppointmentInput,
  toEmrAppointment,
  fromEmrAppointment,
  fromFhirAppointment,
  findConflicts,
  describeConflict,
  weekRange,
  groupByDay,
  upcomingFor,
  isoDate
};
