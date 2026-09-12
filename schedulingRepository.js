// ============================================================================
// PHCP scheduling — pure helpers (Session 7)
// Spec: docs/GFC_App_Build_v2.md §5, §5.4 (data model)
//       docs/GFC_Caregiver_Profile_Schema_v1.md (licenseLevel, availability)
//       docs/GFC_Client_Care_Profile_Schema_v1.md (careTeam, careTier, address)
//
// PURE functions over plain data. No db, no express, no I/O — the same reason
// caregiverRepository.js and consentRegistry.js are shaped this way: the rules
// that matter here (who may see a shift, which state transitions are legal,
// whether a clock-in is inside the geofence) are testable without the app.
//
// TWO SCHEDULING SYSTEMS EXIST BY DESIGN.
// PHCP caregiver shifts live in the app store. Clinical appointments live in
// OpenEMR (Session 4.2). They are not coupled and share no code path. If a
// future edit reaches for openemr.js from this file, it is in the wrong lane —
// test/scheduling.test.js fails the build on it.
//
// The license-level vocabulary is REQUIRED from caregiverRepository.js rather
// than restated. Session 6 owns that enum; a second copy here would be the
// thing that silently drifts, and a drifting license enum decides who may take
// a skilled shift.
// ============================================================================

const cg = require('./caregiverRepository');

// ---- Availability ----------------------------------------------------------
// Caregivers and clinicians submit availability at least 30 days in advance so
// admin can build a schedule from it. Enforced here (and therefore server-side
// at the route), never only in the form.
const AVAILABILITY_LEAD_DAYS = 30;

const DAYS = Object.freeze(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);

const DAY_ALIASES = Object.freeze({
  sun: 'Sun', sunday: 'Sun', mon: 'Mon', monday: 'Mon', tue: 'Tue', tues: 'Tue',
  tuesday: 'Tue', wed: 'Wed', weds: 'Wed', wednesday: 'Wed', thu: 'Thu',
  thur: 'Thu', thurs: 'Thu', thursday: 'Thu', fri: 'Fri', friday: 'Fri',
  sat: 'Sat', saturday: 'Sat'
});

const normalizeDay = (v) => DAY_ALIASES[String(v || '').trim().toLowerCase()] || null;

// "HH:MM" 24-hour. Anything else is not a time and is refused rather than
// coerced to midnight — a window that silently became 00:00–00:00 would post
// a caregiver as available all night.
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const isTime = (v) => TIME_RE.test(String(v || ''));
const minutesOfDay = (hhmm) => {
  const m = TIME_RE.exec(String(hhmm || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

const isIsoDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !isNaN(new Date(`${v}T00:00:00Z`).getTime());

const dayStartUtc = (isoDate) => new Date(`${isoDate}T00:00:00Z`).getTime();
const DAY_MS = 86400000;

// Whole days between "today" and the effective date, both taken as UTC dates so
// a submission at 23:59 is not counted as a day later than one at 00:01.
function daysUntil(effectiveFrom, now = new Date()) {
  if (!isIsoDate(effectiveFrom)) return null;
  const nowDate = new Date(now).toISOString().slice(0, 10);
  return Math.round((dayStartUtc(effectiveFrom) - dayStartUtc(nowDate)) / DAY_MS);
}

// Validates an availability submission. Returns { valid, errors, clean }.
// Errors are specific: an admin reading the log should know which window was
// wrong, not merely that "availability was invalid".
function validateAvailability(input, now = new Date()) {
  const body = input && typeof input === 'object' ? input : {};
  const errors = [];

  const lead = daysUntil(body.effectiveFrom, now);
  if (lead === null) {
    errors.push({ field: 'effectiveFrom', code: 'EFFECTIVE_FROM_INVALID', message: 'Give the date this availability starts, as YYYY-MM-DD.' });
  } else if (lead < AVAILABILITY_LEAD_DAYS) {
    errors.push({
      field: 'effectiveFrom', code: 'AVAILABILITY_LEAD_TIME',
      message: `Availability is submitted at least ${AVAILABILITY_LEAD_DAYS} days ahead. That date is ${lead} day${lead === 1 ? '' : 's'} out.`,
      daysOut: lead, required: AVAILABILITY_LEAD_DAYS
    });
  }

  const windows = [];
  const rawWindows = Array.isArray(body.windows) ? body.windows : [];
  if (rawWindows.length === 0) {
    errors.push({ field: 'windows', code: 'NO_WINDOWS', message: 'Add at least one day and time you can work.' });
  }
  rawWindows.forEach((w, i) => {
    const day = normalizeDay(w && w.day);
    if (!day) {
      errors.push({ field: `windows[${i}].day`, code: 'DAY_INVALID', message: 'Pick a day of the week.' });
      return;
    }
    if (!isTime(w.start) || !isTime(w.end)) {
      errors.push({ field: `windows[${i}]`, code: 'TIME_INVALID', message: 'Times are HH:MM on a 24-hour clock.' });
      return;
    }
    const start = minutesOfDay(w.start);
    const end = minutesOfDay(w.end);
    // An overnight window is legitimate (shiftType "overnight"), so end < start
    // is allowed and read as crossing midnight. end === start is not a window.
    if (start === end) {
      errors.push({ field: `windows[${i}]`, code: 'WINDOW_EMPTY', message: 'That window starts and ends at the same time.' });
      return;
    }
    windows.push({ day, start: w.start, end: w.end, overnight: end < start });
  });

  const blackoutDates = [];
  for (const d of (Array.isArray(body.blackoutDates) ? body.blackoutDates : [])) {
    if (!isIsoDate(d)) {
      errors.push({ field: 'blackoutDates', code: 'BLACKOUT_INVALID', message: `"${d}" is not a date.` });
      continue;
    }
    if (!blackoutDates.includes(d)) blackoutDates.push(d);
  }

  return {
    valid: errors.length === 0,
    errors,
    clean: { effectiveFrom: body.effectiveFrom, windows, blackoutDates, note: String(body.note || '').trim().slice(0, 500) }
  };
}

// Does this availability record cover the shift? Used to rank and to warn, NOT
// as a hard gate: a caregiver may pick up a shift outside their stated window,
// and blocking that would leave real coverage gaps unfilled.
function availabilityCoversShift(availability, shift) {
  if (!availability || !shift) return false;
  const start = new Date(shift.start);
  const end = new Date(shift.end);
  if (isNaN(start.getTime()) || isNaN(end.getTime())) return false;

  const date = start.toISOString().slice(0, 10);
  if (availability.effectiveFrom && date < availability.effectiveFrom) return false;
  if (Array.isArray(availability.blackoutDates) && availability.blackoutDates.includes(date)) return false;

  const day = DAYS[start.getUTCDay()];
  const shiftStart = start.getUTCHours() * 60 + start.getUTCMinutes();
  const shiftEnd = shiftStart + Math.round((end.getTime() - start.getTime()) / 60000);

  return (availability.windows || []).some(w => {
    if (w.day !== day) return false;
    const ws = minutesOfDay(w.start);
    let we = minutesOfDay(w.end);
    if (ws === null || we === null) return false;
    if (we <= ws) we += 24 * 60;                    // overnight window
    return shiftStart >= ws && shiftEnd <= we;
  });
}

// ---- Shift lifecycle -------------------------------------------------------
// Open → Claimed/Assigned → Confirmed → In Progress → Completed.
// Two pathways reach Confirmed and they are NOT the same:
//   A (caregiver self-select): open → claimed → admin approves → confirmed.
//     A claim does not confirm anything. Admin declining returns it to open.
//   B (admin assignment):      open → assigned → caregiver accepts → confirmed.
//     A decline returns it to open.
// Cancellation is available to admin until work starts.
const SHIFT_STATUSES = Object.freeze([
  'open', 'claimed', 'assigned', 'confirmed', 'in_progress', 'completed', 'cancelled'
]);

const SHIFT_TRANSITIONS = Object.freeze({
  open: ['claimed', 'assigned', 'cancelled'],
  claimed: ['confirmed', 'open', 'cancelled'],       // admin approves / declines
  assigned: ['confirmed', 'open', 'cancelled'],      // caregiver accepts / declines
  confirmed: ['in_progress', 'open', 'cancelled'],   // clock in / released / cancelled
  in_progress: ['completed'],                        // clock out only
  completed: [],
  cancelled: []
});

const canTransitionShift = (from, to) => (SHIFT_TRANSITIONS[from] || []).includes(to);

// The reason a transition is refused, in words a caller can show. Never coerce
// to a legal state: a shift that quietly jumps to confirmed is a shift nobody
// agreed to work.
function transitionRefusal(from, to) {
  if (!SHIFT_STATUSES.includes(to)) return { code: 'UNKNOWN_STATUS', message: `"${to}" is not a shift status.` };
  if (!SHIFT_STATUSES.includes(from)) return { code: 'UNKNOWN_STATUS', message: `"${from}" is not a shift status.` };
  if (canTransitionShift(from, to)) return null;
  if (from === 'completed') return { code: 'SHIFT_COMPLETED', message: 'That shift is finished and cannot change.' };
  if (from === 'cancelled') return { code: 'SHIFT_CANCELLED', message: 'That shift was cancelled.' };
  if (from === 'in_progress' && to !== 'completed') {
    return { code: 'SHIFT_IN_PROGRESS', message: 'That shift is under way. It can only be completed by clocking out.' };
  }
  if (to === 'confirmed' && from === 'open') {
    return { code: 'SHIFT_NOT_TAKEN', message: 'Nobody has claimed or been assigned that shift yet.' };
  }
  return { code: 'INVALID_SHIFT_TRANSITION', message: `A ${from.replace(/_/g, ' ')} shift cannot become ${to.replace(/_/g, ' ')}.` };
}

// Which timestamp a transition stamps. Every state change is timestamped, so
// the row carries its own history rather than only its current state.
const SHIFT_STATUS_TIMESTAMP = Object.freeze({
  claimed: 'claimed_at', assigned: 'assigned_at', confirmed: 'confirmed_at',
  in_progress: 'started_at', completed: 'completed_at', cancelled: 'cancelled_at',
  open: 'reopened_at'
});

// ---- License requirement on a shift ----------------------------------------
// A shift's requirement has three readings and they are NOT the same:
//   'any'            explicitly open to every license level — a stated intent
//   a license level  that level or higher (scope is cumulative up the ladder)
//   anything else    unrecognized, so the shift is invisible to everyone
//
// "Open to all" used to be expressed only by leaving the field blank, which
// meant an admin who never touched the dropdown posted a skilled shift to the
// whole roster by accident. 'any' makes the permissive case something someone
// chose. A blank is still read as open — rows already stored carry one — but
// the admin form no longer has a blank default.
const LICENSE_REQUIREMENT_ANY = 'any';

function normalizeLicenseRequirement(raw) {
  const v = String(raw === null || raw === undefined ? '' : raw).trim().toLowerCase();
  if (v === '' || v === LICENSE_REQUIREMENT_ANY) return { ok: true, level: null };
  const level = cg.normalizeLevel(v);
  return level ? { ok: true, level } : { ok: false, level: null };
}

const shiftRequirement = (shift) =>
  normalizeLicenseRequirement(shift && (shift.required_license_level !== undefined && shift.required_license_level !== null
    ? shift.required_license_level
    : shift.requiredLicenseLevel));

// What the requirement says, in words. Silence is not the same as a stated
// fact, so an open-to-all shift SAYS it rather than simply omitting a line.
function shiftLevelLabel(shift) {
  const r = shiftRequirement(shift);
  if (!r.ok) return 'Requirement not recognized — nobody can take this shift';
  if (!r.level) return 'Open to all license levels';
  if (r.level === 'lpn') return 'LPN only';
  return `${cg.LICENSE_LABELS[r.level]} and above`;
}

const isOpenToAllLevels = (shift) => {
  const r = shiftRequirement(shift);
  return r.ok && !r.level;
};

// ---- Open-pool eligibility -------------------------------------------------
// A caregiver sees an open shift only when their license level meets the
// requirement AND the shift is open to them. Anything else is invisible —
// enforced at the API, not by hiding a row in the UI.
function isEligibleForShift(caregiver, shift, client) {
  if (!cg.isCaregiver(caregiver)) return false;
  if (caregiver.accountStatus === 'inactive') return false;
  if (!shift) return false;

  const level = cg.normalizeLevel(caregiver.licenseLevel);
  // 'any' (or a legacy blank) is open to every caregiver; a level means that
  // level or higher. An unrecognized requirement is NOT treated as "no
  // requirement" — that would open a skilled shift to a sitter.
  const required = shiftRequirement(shift);
  if (!required.ok) return false;
  if (required.level && cg.LEVEL_RANK[level] < cg.LEVEL_RANK[required.level]) return false;

  const visibility = shift.pool_visibility || shift.poolVisibility || 'all_eligible';
  if (visibility === 'care_team') {
    return !!client && cg.isAssignedToCaregiver(caregiver, client);
  }
  return true;
}

// Why a caregiver is not eligible — for the admin view, so "why can't Adaeze
// see this shift" has an answer that is not guesswork.
function eligibilityReason(caregiver, shift, client) {
  if (!cg.isCaregiver(caregiver)) return 'not a caregiver';
  if (caregiver.accountStatus === 'inactive') return 'account inactive';
  const level = cg.normalizeLevel(caregiver.licenseLevel);
  const required = shiftRequirement(shift);
  if (!required.ok) {
    return 'the shift\'s license requirement is not recognized, so nobody can take it';
  }
  if (required.level && cg.LEVEL_RANK[level] < cg.LEVEL_RANK[required.level]) {
    return `license level ${cg.LICENSE_LABELS[level]} is below the required ${cg.LICENSE_LABELS[required.level]}`;
  }
  const visibility = shift && (shift.pool_visibility || shift.poolVisibility);
  if (visibility === 'care_team' && !(client && cg.isAssignedToCaregiver(caregiver, client))) {
    return 'shift is limited to the client\'s care team';
  }
  return null;
}

// Two shifts for the same caregiver that overlap in time. Checked before a
// claim or an assignment confirms — one person cannot be in two homes at once.
function shiftsOverlap(a, b) {
  const as = new Date(a.start).getTime(), ae = new Date(a.end).getTime();
  const bs = new Date(b.start).getTime(), be = new Date(b.end).getTime();
  if ([as, ae, bs, be].some(n => isNaN(n))) return false;
  return as < be && bs < ae;
}

const BLOCKING_STATUSES = Object.freeze(['claimed', 'assigned', 'confirmed', 'in_progress']);

function findShiftConflict(rows, caregiverId, shift) {
  return (rows || []).find(r =>
    r && r.id !== shift.id &&
    r.caregiver_id === caregiverId &&
    BLOCKING_STATUSES.includes(r.status) &&
    shiftsOverlap({ start: r.start, end: r.end }, shift)
  ) || null;
}

// ---- Geofence + time-log flags --------------------------------------------
// 150m default, per-client override. An out-of-radius clock-in is FLAGGED, not
// blocked: a caregiver may legitimately be transporting the client, and a
// blocked clock-in means unpaid work and no record of the visit at all.
const DEFAULT_GEOFENCE_METERS = 150;
const DEFAULT_GRACE_MINUTES = 10;

const EARTH_RADIUS_M = 6371000;
const toRad = (deg) => (deg * Math.PI) / 180;

function distanceMeters(a, b) {
  if (!a || !b) return null;
  const lat1 = Number(a.lat), lng1 = Number(a.lng), lat2 = Number(b.lat), lng2 = Number(b.lng);
  if ([lat1, lng1, lat2, lng2].some(n => !isFinite(n))) return null;
  // 0,0 is in the Gulf of Guinea. Treated as "no coordinate" because it is far
  // more often an unset field than a real location for a Georgia home-care visit.
  if ((lat1 === 0 && lng1 === 0) || (lat2 === 0 && lng2 === 0)) return null;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h))));
}

const geofenceRadiusFor = (client) => {
  const raw = client && client.geofenceRadiusMeters;
  const n = Number(raw);
  return isFinite(n) && n > 0 ? Math.round(n) : DEFAULT_GEOFENCE_METERS;
};

const clientCoords = (client) => {
  const addr = (client && client.address) || {};
  const lat = Number(addr.lat), lng = Number(addr.lng);
  if (!isFinite(lat) || !isFinite(lng) || (lat === 0 && lng === 0)) return null;
  return { lat, lng };
};

// Returns the geofence verdict for one clock event.
//   inside            — within the radius
//   outside           — beyond it; FLAGGED, never blocked
//   unverifiable      — no client coordinates or no GPS from the device
// "unverifiable" is deliberately its own answer. Reporting a missing
// coordinate as "inside" would be the app claiming something it cannot observe.
function evaluateGeofence(client, gps) {
  const radius = geofenceRadiusFor(client);
  const home = clientCoords(client);
  const point = gps && isFinite(Number(gps.lat)) && isFinite(Number(gps.lng))
    ? { lat: Number(gps.lat), lng: Number(gps.lng) } : null;

  if (!home) return { verdict: 'unverifiable', reason: 'NO_CLIENT_COORDINATES', radius, distance: null };
  if (!point) return { verdict: 'unverifiable', reason: 'NO_DEVICE_GPS', radius, distance: null };

  const distance = distanceMeters(home, point);
  if (distance === null) return { verdict: 'unverifiable', reason: 'NO_DEVICE_GPS', radius, distance: null };
  return { verdict: distance <= radius ? 'inside' : 'outside', reason: null, radius, distance };
}

// ---- Client location (admin-set) -------------------------------------------
// Coordinates are the whole reason a clock-in can be checked at all. Without
// them evaluateGeofence answers `unverifiable` forever — honest, but it means
// nobody can tell a caregiver who was at the door from one who was not.
const GEOFENCE_MIN_METERS = 25;
const GEOFENCE_MAX_METERS = 5000;

function validateClientLocation(input) {
  const body = input && typeof input === 'object' ? input : {};
  const errors = [];

  // Both fields empty is a deliberate CLEAR, not a mistake: an address that
  // turns out to be wrong is better removed than left pointing somewhere else.
  const blank = (v) => v === null || v === undefined || String(v).trim() === '';
  const clearing = blank(body.lat) && blank(body.lng);

  let lat = null;
  let lng = null;
  if (!clearing) {
    lat = Number(body.lat);
    lng = Number(body.lng);
    if (!isFinite(lat) || lat < -90 || lat > 90) {
      errors.push({ field: 'lat', code: 'LAT_INVALID', message: 'Latitude is a number between -90 and 90.' });
    }
    if (!isFinite(lng) || lng < -180 || lng > 180) {
      errors.push({ field: 'lng', code: 'LNG_INVALID', message: 'Longitude is a number between -180 and 180.' });
    }
    // 0,0 is open ocean off West Africa. evaluateGeofence already reads it as an
    // UNSET field, so storing it would leave a client looking configured while
    // every clock-in there stayed unverifiable. Refuse it at the door instead.
    if (lat === 0 && lng === 0) {
      errors.push({
        field: 'lat', code: 'COORDINATES_NULL_ISLAND',
        message: '0, 0 is not a location. Leave both boxes empty to clear the coordinates.'
      });
    }
  }

  // An absent key keeps whatever is stored; an empty one resets to the default.
  const radiusProvided = Object.prototype.hasOwnProperty.call(body, 'geofenceRadiusMeters');
  let geofenceRadiusMeters = null;
  if (radiusProvided && !blank(body.geofenceRadiusMeters)) {
    const n = Number(body.geofenceRadiusMeters);
    if (!isFinite(n) || n < GEOFENCE_MIN_METERS || n > GEOFENCE_MAX_METERS) {
      errors.push({
        field: 'geofenceRadiusMeters', code: 'RADIUS_INVALID',
        message: `The radius is between ${GEOFENCE_MIN_METERS}m and ${GEOFENCE_MAX_METERS}m.`
      });
    } else {
      geofenceRadiusMeters = Math.round(n);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    clean: { lat: clearing ? null : lat, lng: clearing ? null : lng, clearing, radiusProvided, geofenceRadiusMeters }
  };
}

const TIME_LOG_FLAGS = Object.freeze([
  'outside_geofence', 'geofence_unverifiable', 'late_clock_in',
  'early_clock_out', 'late_clock_out', 'no_clock_out', 'admin_edited'
]);

// Flags for a clock-in. A flag is a signal to admin, never a refusal.
function clockInFlags({ shift, client, gps, at, graceMinutes = DEFAULT_GRACE_MINUTES }) {
  const flags = [];
  const geo = evaluateGeofence(client, gps);
  if (geo.verdict === 'outside') flags.push('outside_geofence');
  if (geo.verdict === 'unverifiable') flags.push('geofence_unverifiable');

  const scheduled = new Date(shift && shift.start).getTime();
  const actual = new Date(at).getTime();
  if (isFinite(scheduled) && isFinite(actual) && actual > scheduled + graceMinutes * 60000) {
    flags.push('late_clock_in');
  }
  return { flags, geo };
}

function clockOutFlags({ shift, client, gps, at, graceMinutes = DEFAULT_GRACE_MINUTES }) {
  const flags = [];
  const geo = evaluateGeofence(client, gps);
  if (geo.verdict === 'outside') flags.push('outside_geofence');
  if (geo.verdict === 'unverifiable') flags.push('geofence_unverifiable');

  const scheduled = new Date(shift && shift.end).getTime();
  const actual = new Date(at).getTime();
  if (isFinite(scheduled) && isFinite(actual)) {
    if (actual < scheduled - graceMinutes * 60000) flags.push('early_clock_out');
    if (actual > scheduled + graceMinutes * 60000) flags.push('late_clock_out');
  }
  return { flags, geo };
}

// Worked minutes. Never negative and never invented: a missing or unparseable
// clock-out yields null, which the CSV renders as blank rather than as zero
// hours worked.
function totalMinutes(clockInAt, clockOutAt) {
  const a = new Date(clockInAt).getTime();
  const b = new Date(clockOutAt).getTime();
  if (!isFinite(a) || !isFinite(b)) return null;
  const mins = Math.round((b - a) / 60000);
  return mins >= 0 ? mins : null;
}

const minutesToHours = (mins) => (mins === null || mins === undefined ? null : Math.round((mins / 60) * 100) / 100);

// ---- Pay periods -----------------------------------------------------------
// Bi-weekly by default, anchored on a configurable Monday so a change of anchor
// is one value rather than a rewrite. Callers may always just pass a date range.
const DEFAULT_PAY_PERIOD_ANCHOR = '2026-01-05';   // a Monday
const DEFAULT_PAY_PERIOD_DAYS = 14;

function payPeriodFor(date, { anchor = DEFAULT_PAY_PERIOD_ANCHOR, lengthDays = DEFAULT_PAY_PERIOD_DAYS } = {}) {
  const d = isIsoDate(date) ? date : new Date(date).toISOString().slice(0, 10);
  if (!isIsoDate(d)) return null;
  const elapsed = Math.floor((dayStartUtc(d) - dayStartUtc(anchor)) / DAY_MS);
  const index = Math.floor(elapsed / lengthDays);
  const startMs = dayStartUtc(anchor) + index * lengthDays * DAY_MS;
  return {
    start: new Date(startMs).toISOString().slice(0, 10),
    end: new Date(startMs + (lengthDays - 1) * DAY_MS).toISOString().slice(0, 10),
    index
  };
}

// ---- Payroll CSV -----------------------------------------------------------
// PROVISIONAL HEADER — the Session 7 brief says to confirm the column set with
// the owner before finalizing. Until that confirmation lands this is the
// documented default, and it is ONE constant so changing it is a one-line edit
// rather than a rewrite. It carries what a payroll run needs and nothing
// clinical: no diagnosis, no visit content, no care-plan text.
const PAYROLL_CSV_COLUMNS = Object.freeze([
  { key: 'caregiverName', header: 'Caregiver' },
  { key: 'licenseLevel', header: 'License Level' },
  { key: 'clientName', header: 'Client' },
  { key: 'shiftDate', header: 'Shift Date' },
  { key: 'scheduledStart', header: 'Scheduled Start' },
  { key: 'scheduledEnd', header: 'Scheduled End' },
  { key: 'clockInAt', header: 'Clock In' },
  { key: 'clockOutAt', header: 'Clock Out' },
  { key: 'hours', header: 'Hours' },
  { key: 'flags', header: 'Flags' },
  { key: 'edited', header: 'Edited' },
  { key: 'editReason', header: 'Edit Reason' },
  { key: 'payPeriodStart', header: 'Pay Period Start' },
  { key: 'payPeriodEnd', header: 'Pay Period End' }
]);

// ---- Client billing CSV ----------------------------------------------------
// What gets INVOICED, which is a different question from what gets PAID: one
// line per completed visit, grouped by client, carrying the hours that back
// the charge. No pay rate and nothing clinical — an invoice line says a visit
// of this length happened on this date, not what was done during it.
const BILLING_CSV_COLUMNS = Object.freeze([
  { key: 'clientName', header: 'Client' },
  { key: 'serviceDate', header: 'Service Date' },
  { key: 'caregiverName', header: 'Caregiver' },
  { key: 'licenseLevel', header: 'License Level' },
  { key: 'scheduledStart', header: 'Scheduled Start' },
  { key: 'scheduledEnd', header: 'Scheduled End' },
  { key: 'clockInAt', header: 'Actual In' },
  { key: 'clockOutAt', header: 'Actual Out' },
  { key: 'hours', header: 'Billable Hours' },
  { key: 'verification', header: 'Visit Verification' },
  { key: 'documented', header: 'Visit Documented' }
]);

// ---- A caregiver's own hours ----------------------------------------------
// Their own record of their own work, for their own files. Deliberately no
// other caregiver's rows and no edit-reason column: an admin correction and
// why it was made belongs on the payroll export, not in a personal copy that
// reads like a dispute.
const CAREGIVER_HOURS_CSV_COLUMNS = Object.freeze([
  { key: 'shiftDate', header: 'Date' },
  { key: 'clientName', header: 'Client' },
  { key: 'scheduledStart', header: 'Scheduled Start' },
  { key: 'scheduledEnd', header: 'Scheduled End' },
  { key: 'clockInAt', header: 'Clock In' },
  { key: 'clockOutAt', header: 'Clock Out' },
  { key: 'hours', header: 'Hours' },
  { key: 'flags', header: 'Flags' },
  { key: 'edited', header: 'Adjusted by office' }
]);

// RFC 4180 quoting. A field is quoted when it contains a comma, a quote, a
// newline, or leading/trailing space; embedded quotes are doubled. A leading
// =, +, - or @ is prefixed with a single quote so a spreadsheet does not
// evaluate a caregiver's note as a formula.
function csvCell(value) {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s) || /^\s|\s$/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toPayrollCsv(rows, columns = PAYROLL_CSV_COLUMNS) {
  const header = columns.map(c => csvCell(c.header)).join(',');
  const body = (rows || []).map(r => columns.map(c => csvCell(r[c.key])).join(','));
  // CRLF: Excel is the destination and it is the format's own line ending.
  return [header].concat(body).join('\r\n') + '\r\n';
}

// ---- Shift requests (client-initiated, Pathway A) --------------------------
const SHIFT_REQUEST_STATUSES = Object.freeze(['requested', 'posted', 'declined', 'withdrawn']);
const SHIFT_REQUEST_TRANSITIONS = Object.freeze({
  requested: ['posted', 'declined', 'withdrawn'],
  posted: [], declined: [], withdrawn: []
});
const canTransitionRequest = (from, to) => (SHIFT_REQUEST_TRANSITIONS[from] || []).includes(to);

// ---- Shift validation ------------------------------------------------------
function validateShift(input) {
  const body = input && typeof input === 'object' ? input : {};
  const errors = [];

  const start = new Date(body.start).getTime();
  const end = new Date(body.end).getTime();
  if (!isFinite(start)) errors.push({ field: 'start', code: 'START_INVALID', message: 'Give a start time.' });
  if (!isFinite(end)) errors.push({ field: 'end', code: 'END_INVALID', message: 'Give an end time.' });
  if (isFinite(start) && isFinite(end) && end <= start) {
    errors.push({ field: 'end', code: 'END_BEFORE_START', message: 'The shift ends before it starts.' });
  }
  if (isFinite(start) && isFinite(end) && end - start > 24 * 3600 * 1000) {
    // Live-in care is scheduled as consecutive days, not one 72-hour row, so a
    // shift longer than a day is a typo far more often than an intent.
    errors.push({ field: 'end', code: 'SHIFT_TOO_LONG', message: 'A single shift cannot run longer than 24 hours. Book consecutive shifts.' });
  }
  if (!body.clientId) errors.push({ field: 'clientId', code: 'CLIENT_REQUIRED', message: 'Pick a client.' });

  const required = normalizeLicenseRequirement(body.requiredLicenseLevel);
  if (!required.ok) {
    errors.push({
      field: 'requiredLicenseLevel', code: 'LICENSE_LEVEL_INVALID',
      message: `"${body.requiredLicenseLevel}" is not a license level. Use a level, or "any" to open the shift to every caregiver.`
    });
  }
  const visibility = body.poolVisibility || 'all_eligible';
  if (!['all_eligible', 'care_team'].includes(visibility)) {
    errors.push({ field: 'poolVisibility', code: 'VISIBILITY_INVALID', message: 'Visibility is all_eligible or care_team.' });
  }

  return {
    valid: errors.length === 0,
    errors,
    clean: {
      clientId: body.clientId,
      start: isFinite(start) ? new Date(start).toISOString() : null,
      end: isFinite(end) ? new Date(end).toISOString() : null,
      // 'any' is stored as null, so eligibility has exactly one shape to read
      // and no row carries a second spelling of "no requirement".
      requiredLicenseLevel: required.level,
      openToAllLevels: required.ok && !required.level,
      poolVisibility: visibility,
      careTier: body.careTier ? String(body.careTier).trim().slice(0, 20) : null,
      notes: String(body.notes || '').trim().slice(0, 2000)
    }
  };
}

module.exports = {
  AVAILABILITY_LEAD_DAYS, DAYS, normalizeDay, isTime, minutesOfDay, isIsoDate, daysUntil,
  validateAvailability, availabilityCoversShift,
  SHIFT_STATUSES, SHIFT_TRANSITIONS, SHIFT_STATUS_TIMESTAMP,
  canTransitionShift, transitionRefusal, validateShift,
  LICENSE_REQUIREMENT_ANY, normalizeLicenseRequirement, shiftLevelLabel, isOpenToAllLevels,
  isEligibleForShift, eligibilityReason, shiftsOverlap, findShiftConflict, BLOCKING_STATUSES,
  DEFAULT_GEOFENCE_METERS, DEFAULT_GRACE_MINUTES, distanceMeters, geofenceRadiusFor, clientCoords,
  evaluateGeofence, GEOFENCE_MIN_METERS, GEOFENCE_MAX_METERS, validateClientLocation, TIME_LOG_FLAGS, clockInFlags, clockOutFlags, totalMinutes, minutesToHours,
  DEFAULT_PAY_PERIOD_ANCHOR, DEFAULT_PAY_PERIOD_DAYS, payPeriodFor,
  PAYROLL_CSV_COLUMNS, BILLING_CSV_COLUMNS, CAREGIVER_HOURS_CSV_COLUMNS, csvCell, toPayrollCsv,
  SHIFT_REQUEST_STATUSES, SHIFT_REQUEST_TRANSITIONS, canTransitionRequest
};
