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
const practiceTime = require('./public/gfc-time');   // every time read or shown is Eastern

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

  // READ IN EASTERN, not UTC. A caregiver who says "Tuesdays, 9am to 5pm" means
  // Georgia time; `getUTCDay()` puts a Tuesday 8pm shift on WEDNESDAY at 00:00
  // and matches it against the wrong window — or against none, which reads as
  // "outside their availability" for a shift squarely inside it. Same for the
  // blackout date and the effective date: both are days a person named.
  const parts = practiceTime.zonedParts(start);
  if (!parts) return false;

  const date = parts.isoDate;
  if (availability.effectiveFrom && date < availability.effectiveFrom) return false;
  if (Array.isArray(availability.blackoutDates) && availability.blackoutDates.includes(date)) return false;

  const day = DAYS[parts.weekdayIndex];
  const shiftStart = parts.minutesOfDay;
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

// ---- Open-pool VISIBILITY (owner rule, 2026-09-13) -------------------------
// Visibility and claimability are two different questions and this is the only
// place that answers both, so they cannot drift.
//
// The owner's rule: every caregiver sees every open shift. One whose licence
// requirement they do not meet is shown GREYED OUT with the reason, not hidden.
// A caregiver who can see the whole board knows what work exists and what
// credential would open it; a hidden row just looks like no work.
//
// That is safe because hiding was never the control — `isEligibleForShift()`
// still gates the claim at the API and is UNCHANGED by this. `claimable` is
// defined in terms of it rather than re-deriving the rule.
//
// ONE thing stays hidden, deliberately: a `care_team` shift. That restriction
// is about who may know this client is receiving care, not about licence, so
// widening it would put a client's name and address in front of caregivers who
// are not assigned to them. A licence gate greys out; a care-team gate hides.
function shiftVisibility(caregiver, shift, client) {
  if (!cg.isCaregiver(caregiver)) return { visible: false, claimable: false, reason: 'not a caregiver' };
  if (caregiver.accountStatus === 'inactive') return { visible: false, claimable: false, reason: 'account inactive' };
  if (!shift) return { visible: false, claimable: false, reason: 'no shift' };

  const visibility = shift.pool_visibility || shift.poolVisibility || 'all_eligible';
  if (visibility === 'care_team' && !(client && cg.isAssignedToCaregiver(caregiver, client))) {
    return { visible: false, claimable: false, reason: 'shift is limited to the client\'s care team' };
  }

  const claimable = isEligibleForShift(caregiver, shift, client);
  return {
    visible: true,
    claimable,
    reason: claimable ? null : eligibilityReason(caregiver, shift, client)
  };
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

// ---- Clock-in window -------------------------------------------------------
// A caregiver may clock in from two hours before the shift starts, and not a
// minute earlier. This one BLOCKS where the geofence only flags, and the
// asymmetry is deliberate: being somewhere unexpected has honest explanations
// (transporting the client), whereas starting the clock five hours early does
// not — it is either a mistake or time that was not worked.
//
// It constrains EARLY only. A caregiver arriving late must always be able to
// clock in: refusing them would mean unpaid work and no record of the visit,
// which is the outcome this whole subsystem exists to prevent. Lateness is
// already flagged (late_clock_in) and flagging is the right answer there.
const CLOCK_IN_WINDOW_MINUTES = 120;

// Pure so the rule is testable without a shift row or a clock.
//   { allowed, opensAt, minutesEarly }
// A shift whose start cannot be read is ALLOWED through: that shift is broken
// either way, and blocking a caregiver out of a visit over a data problem is
// the worse of the two failures.
function clockInWindow({ shift, at, windowMinutes = CLOCK_IN_WINDOW_MINUTES }) {
  const start = new Date((shift || {}).start);
  const now = new Date(at);
  if (isNaN(start.getTime()) || isNaN(now.getTime())) {
    return { allowed: true, opensAt: null, minutesEarly: null };
  }
  const opens = new Date(start.getTime() - windowMinutes * 60000);
  if (now >= opens) return { allowed: true, opensAt: opens.toISOString(), minutesEarly: 0 };
  return {
    allowed: false,
    opensAt: opens.toISOString(),
    minutesEarly: Math.ceil((opens.getTime() - now.getTime()) / 60000)
  };
}

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
  'early_clock_out', 'late_clock_out', 'no_clock_out', 'admin_edited',
  // Typed in by the office because no clock-in happened at all — a dead
  // phone, a forgotten tap, an unscheduled visit. It is a FLAG, not a quiet
  // row: these hours are attested by an administrator, not observed by the
  // app, and payroll and an audit both need to be able to tell the two apart.
  'manual_entry'
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
  // What we PAY, added 2026-09-13 once a caregiver pay rate existed to read.
  // An unset rate prints EMPTY, never 0.00: a blank cell is a question for
  // whoever runs payroll, a zero is an answer and the wrong one. `Rate Source`
  // says WHERE the number came from (shift · client · base · not set), because
  // "why is this person's rate different this week" needs an answer that is not
  // guesswork. Nothing clinical is added — still build-enforced.
  { key: 'payRate', header: 'Pay Rate' },
  { key: 'payRateSource', header: 'Rate Source' },
  { key: 'grossPay', header: 'Gross Pay' },
  { key: 'flags', header: 'Flags' },
  { key: 'edited', header: 'Edited' },
  { key: 'editReason', header: 'Edit Reason' },
  // Clocked on a device, or typed in by the office. A payroll run should not
  // have to infer that difference from a flags column.
  { key: 'source', header: 'Source' },
  { key: 'enteredBy', header: 'Entered By' },
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

// ============================================================================
// EDITING A POSTED SHIFT (owner request, 2026-09-20)
// ============================================================================
// A shift was write-once: posted, then moved through its lifecycle, and the
// only way to correct a wrong time was to cancel it and post another — which
// loses the claim, the assignment and the caregiver's acceptance along with the
// typo. The owner's ask is the plain one: fix the time, including on a shift
// that has already happened.
//
// WHAT MAY BE EDITED IS AN ALLOW-LIST, for the same reason the enrollment
// editor's is: a key the list does not carry never reaches the row. Two values
// are deliberately outside it.
//
//   clientId — moving a shift to another client is not a correction, it is a
//     different shift. It would have to re-run the enrollment gate, the
//     geofence, the care-team visibility and the caregiver's eligibility, and
//     any time log already filed against it names the old client. Cancel and
//     repost.
//   status — the lifecycle is a state machine with its own routes and its own
//     refusals. An editor that can set a status is a second, quieter way to
//     confirm a shift nobody accepted.
const SHIFT_EDITABLE_FIELDS = Object.freeze([
  'start', 'end', 'requiredLicenseLevel', 'poolVisibility', 'careTier', 'notes', 'payRate'
]);

// A cancelled shift is a tombstone: it did not happen, nothing is derived from
// it and there is nothing on it to correct. Everything else is editable —
// INCLUDING completed and in-progress, which is the owner's whole point.
const EDITABLE_SHIFT_STATUSES = Object.freeze([
  'open', 'claimed', 'assigned', 'confirmed', 'in_progress', 'completed'
]);

const canEditShift = (shift) => !!shift && EDITABLE_SHIFT_STATUSES.includes(shift.status);

// The field on the row each editable key writes to.
const SHIFT_EDIT_COLUMN = Object.freeze({
  start: 'start', end: 'end', requiredLicenseLevel: 'required_license_level',
  poolVisibility: 'pool_visibility', careTier: 'care_tier', notes: 'notes', payRate: 'pay_rate'
});

// An ABSENT key means "leave this alone"; a key present and empty means "clear
// it". Collapsing the two is how an edit form that cannot show a field wipes
// it — the trap the enrollment editor hit two days ago, one surface along.
function validateShiftEdit(shift, input) {
  const body = input && typeof input === 'object' ? input : {};
  const errors = [];
  const changes = [];
  const next = {};

  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);

  Object.keys(body).forEach(k => {
    if (k === 'clientId' || k === 'status') {
      errors.push({
        field: k, code: k === 'clientId' ? 'CLIENT_NOT_EDITABLE' : 'STATUS_NOT_EDITABLE',
        message: k === 'clientId'
          ? 'A shift cannot be moved to a different client. Cancel it and post a new one.'
          : 'Use the shift actions to move a shift through its lifecycle.'
      });
    }
  });

  // Times are validated as a PAIR against whatever the row will hold after the
  // edit, so moving only the start still gets checked against the existing end.
  const startIso = has('start') ? new Date(body.start).getTime() : new Date(shift.start).getTime();
  const endIso = has('end') ? new Date(body.end).getTime() : new Date(shift.end).getTime();
  if (has('start') && !isFinite(startIso)) errors.push({ field: 'start', code: 'START_INVALID', message: 'Give a start time.' });
  if (has('end') && !isFinite(endIso)) errors.push({ field: 'end', code: 'END_INVALID', message: 'Give an end time.' });
  if (isFinite(startIso) && isFinite(endIso)) {
    if (endIso <= startIso) errors.push({ field: 'end', code: 'END_BEFORE_START', message: 'The shift ends before it starts.' });
    else if (endIso - startIso > 24 * 3600 * 1000) {
      errors.push({ field: 'end', code: 'SHIFT_TOO_LONG', message: 'A single shift cannot run longer than 24 hours. Book consecutive shifts.' });
    }
  }
  // A time in the past is deliberately ACCEPTED. Correcting last Tuesday's
  // shift is the owner's stated reason for this route existing.
  if (has('start') && isFinite(startIso)) {
    const iso = new Date(startIso).toISOString();
    if (iso !== shift.start) { next.start = iso; changes.push('start'); }
  }
  if (has('end') && isFinite(endIso)) {
    const iso = new Date(endIso).toISOString();
    if (iso !== shift.end) { next.end = iso; changes.push('end'); }
  }

  if (has('requiredLicenseLevel')) {
    const required = normalizeLicenseRequirement(body.requiredLicenseLevel);
    if (!required.ok) {
      errors.push({
        field: 'requiredLicenseLevel', code: 'LICENSE_LEVEL_INVALID',
        message: `"${body.requiredLicenseLevel}" is not a license level. Use a level, or "any" to open the shift to every caregiver.`
      });
    } else if ((required.level || null) !== (shift.required_license_level || null)) {
      next.requiredLicenseLevel = required.level;
      changes.push('requiredLicenseLevel');
    }
  }

  if (has('poolVisibility')) {
    const v = body.poolVisibility || 'all_eligible';
    if (!['all_eligible', 'care_team'].includes(v)) {
      errors.push({ field: 'poolVisibility', code: 'VISIBILITY_INVALID', message: 'Visibility is all_eligible or care_team.' });
    } else if (v !== shift.pool_visibility) { next.poolVisibility = v; changes.push('poolVisibility'); }
  }

  if (has('careTier')) {
    const v = body.careTier ? String(body.careTier).trim().slice(0, 20) : null;
    if (v !== (shift.care_tier || null)) { next.careTier = v; changes.push('careTier'); }
  }

  if (has('notes')) {
    const v = String(body.notes === null || body.notes === undefined ? '' : body.notes).trim().slice(0, 2000);
    if (v !== (shift.notes || '')) { next.notes = v; changes.push('notes'); }
  }

  if (has('payRate')) {
    const v = cg.normalizePayRate(body.payRate);
    if (v !== cg.normalizePayRate(shift.pay_rate)) { next.payRate = v; changes.push('payRate'); }
  }

  return { valid: errors.length === 0, errors, clean: next, changes };
}


// ---- A caregiver asks for a shift to change --------------------------------
// Owner-directed, 2026-09-21: "caregivers should be able to request adjustments
// in scheduled shift times in the app."
//
// Before this, a caregiver holding a confirmed shift had NO route at all. They
// could decline an offer they had not yet accepted, and after that the only
// lever was phoning the office — so the ask left no record, and the pattern of
// who asks for what was invisible. This is the ask, in the app, with an answer
// that comes back to them.
//
// AN ASK IS NOT A CHANGE. The request writes nothing to the shift. An admin or
// a manager approves it, and the approval runs through the SAME editor a
// hand-typed correction runs through — the holder's eligibility, the overlap
// check, the time log following the shift, the derived flags being re-derived.
// A second writer for one value is how the board and the timesheet start
// disagreeing, which is the failure this repo keeps paying for.
const CHANGE_REQUEST_KINDS = Object.freeze(['time_change', 'drop']);

// Only a shift they have actually ACCEPTED. An `assigned` shift is an offer
// they have not answered yet and it already has accept/decline — giving it a
// second, quieter door would mean two ways to hand back the same shift, and
// one of them would drift. A started or finished shift is not a schedule
// question any more; that is a timesheet correction, which is admin's own
// route with its own mandatory reason.
const REQUESTABLE_SHIFT_STATUSES = Object.freeze(['confirmed']);

// OWNER DECISION, 2026-09-21: a request needs a notice minimum, and inside it
// the caregiver phones instead. ONE constant — change this line to change the
// policy. The refusal deliberately names the office and says to call rather
// than just saying no: a dead end is how a control gets worked around, and a
// caregiver who cannot tell us at all is worse than one who tells us late.
const CHANGE_REQUEST_NOTICE_MINUTES = 24 * 60;

const CHANGE_REQUEST_STATUSES = Object.freeze(['pending', 'approved', 'declined', 'withdrawn']);

// Can this caregiver ask about this shift, right now? Split out from the route
// so the SCREEN and the API answer the same question — the app must never
// offer a control the server is going to refuse.
function canRequestShiftChange(shift, at = new Date()) {
  if (!shift) return { ok: false, code: 'SHIFT_NOT_FOUND', message: 'Shift not found.' };
  if (!REQUESTABLE_SHIFT_STATUSES.includes(shift.status)) {
    return {
      ok: false, code: 'SHIFT_NOT_REQUESTABLE', status: shift.status,
      message: shift.status === 'assigned'
        ? 'This shift is still an offer. Accept it, or decline it, from the offer itself.'
        : `A ${String(shift.status).replace(/_/g, ' ')} shift cannot be changed by request. Speak to the office.`
    };
  }
  const startMs = shift.start ? new Date(shift.start).getTime() : NaN;
  if (!isFinite(startMs)) return { ok: false, code: 'SHIFT_START_INVALID', message: 'That shift has no usable start time.' };

  // `new Date(null)` is the EPOCH and the epoch is finite, so an empty `at`
  // would read as 1970 and make every shift look like it had decades of
  // notice. Same trap the flag re-derivation hit on 2026-09-20.
  const nowMs = (at === null || at === undefined || at === '') ? NaN : new Date(at).getTime();
  if (!isFinite(nowMs)) return { ok: false, code: 'NOW_INVALID', message: 'Could not read the current time.' };

  const minutesOfNotice = Math.floor((startMs - nowMs) / 60000);
  if (minutesOfNotice <= 0) {
    return {
      ok: false, code: 'SHIFT_ALREADY_STARTED', minutesOfNotice,
      message: 'That shift has already started. Speak to the office.'
    };
  }
  if (minutesOfNotice < CHANGE_REQUEST_NOTICE_MINUTES) {
    return {
      ok: false, code: 'CHANGE_REQUEST_TOO_LATE', minutesOfNotice,
      requiredMinutes: CHANGE_REQUEST_NOTICE_MINUTES,
      message: `A change is requested at least ${Math.round(CHANGE_REQUEST_NOTICE_MINUTES / 60)} hours ahead, and that shift starts in ${describeNotice(minutesOfNotice)}. Call the office so somebody can act on it today.`
    };
  }
  return { ok: true, minutesOfNotice };
}

// "in 3 hours", "in 45 minutes" — a caregiver reading a refusal on a phone
// needs to know how short they were, not a raw minute count.
function describeNotice(minutes) {
  const m = Math.max(0, Math.floor(Number(minutes) || 0));
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'}`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'}`;
  const d = Math.floor(h / 24);
  return `${d} day${d === 1 ? '' : 's'}`;
}

// What the caregiver is asking for. A `time_change` carries a proposed start
// and end; a `drop` carries neither and means "I cannot work this one".
//
// A REASON IS REQUIRED ON BOTH. The office is being asked to move a client's
// care or find a replacement, and "no reason given" is not something anyone can
// act on or weigh. It is also the only field that makes a repeated pattern
// readable later.
function validateChangeRequest(shift, input) {
  const body = input && typeof input === 'object' ? input : {};
  const errors = [];
  const clean = {};

  const kind = String(body.kind || '').trim();
  if (!CHANGE_REQUEST_KINDS.includes(kind)) {
    errors.push({
      field: 'kind', code: 'KIND_INVALID',
      message: 'Say whether you are asking to change the time or to hand the shift back.',
      options: CHANGE_REQUEST_KINDS.slice()
    });
  } else {
    clean.kind = kind;
  }

  const reason = String(body.reason === null || body.reason === undefined ? '' : body.reason).trim();
  if (!reason) {
    errors.push({ field: 'reason', code: 'REASON_REQUIRED', message: 'Tell the office why, in a sentence.' });
  } else {
    clean.reason = reason.slice(0, 1000);
  }

  if (kind === 'time_change') {
    const startMs = body.proposedStart ? new Date(body.proposedStart).getTime() : NaN;
    const endMs = body.proposedEnd ? new Date(body.proposedEnd).getTime() : NaN;
    if (!isFinite(startMs)) errors.push({ field: 'proposedStart', code: 'START_INVALID', message: 'Give the start time you are asking for.' });
    if (!isFinite(endMs)) errors.push({ field: 'proposedEnd', code: 'END_INVALID', message: 'Give the end time you are asking for.' });
    if (isFinite(startMs) && isFinite(endMs)) {
      if (endMs <= startMs) {
        errors.push({ field: 'proposedEnd', code: 'END_BEFORE_START', message: 'That ends before it starts.' });
      } else if (endMs - startMs > 24 * 3600 * 1000) {
        errors.push({ field: 'proposedEnd', code: 'SHIFT_TOO_LONG', message: 'A single shift cannot run longer than 24 hours.' });
      } else if (startMs <= Date.now()) {
        errors.push({ field: 'proposedStart', code: 'START_IN_PAST', message: 'Ask for a time that has not already passed.' });
      } else {
        const sIso = new Date(startMs).toISOString();
        const eIso = new Date(endMs).toISOString();
        // An ask that matches what is already on the board is not an ask. It
        // would sit in the queue, get approved, change nothing, and read to
        // everyone as though something had been done.
        if (sIso === shift.start && eIso === shift.end) {
          errors.push({
            field: 'proposedStart', code: 'NO_CHANGE_REQUESTED',
            message: 'That is the time the shift already has.'
          });
        } else {
          clean.proposedStart = sIso;
          clean.proposedEnd = eIso;
        }
      }
    }
  }

  return { valid: errors.length === 0, errors, clean };
}

// An open request is one still waiting on somebody. ONE per shift at a time:
// clicking Ask twice is the commonest way to get two of everything, and two
// pending asks about one shift means whoever works the queue answers the same
// question twice and the second answer overwrites the first.
const isOpenChangeRequest = (row) => !!row && row.status === 'pending';

function findOpenChangeRequest(rows, shiftId) {
  return (Array.isArray(rows) ? rows : []).find(r => isOpenChangeRequest(r) && String(r.shift_id) === String(shiftId)) || null;
}

// ---- The flags a corrected schedule makes wrong -----------------------------
// A time log carries two different kinds of flag and the difference decides
// what an edit may touch. `late_clock_in`, `early_clock_out` and
// `late_clock_out` are DERIVED — they are the gap between the schedule and what
// the caregiver did, so correcting a schedule that was wrong makes them wrong
// too. Somebody who arrived exactly on time for a 1pm visit posted at 9am is
// carrying a four-hour "late" mark they did not earn, and that mark is the
// whole reason the office is correcting the shift.
//
// The geofence verdicts, `no_clock_out`, `manual_entry` and `admin_edited` are
// OBSERVATIONS. Where somebody stood is not a function of what the calendar
// said, so an edit never rewrites them.
const SCHEDULE_DERIVED_FLAGS = Object.freeze(['late_clock_in', 'early_clock_out', 'late_clock_out']);

function rederiveScheduleFlags(log, shift, graceMinutes = DEFAULT_GRACE_MINUTES) {
  const kept = (log && Array.isArray(log.flags) ? log.flags : [])
    .filter(f => !SCHEDULE_DERIVED_FLAGS.includes(f));
  const derived = [];
  // `new Date(null)` is the EPOCH, not an invalid date, and the epoch is
  // finite — so a visit still running, with no clock-out yet, computed as
  // having clocked out in 1970 and earned an "early clock out". An empty value
  // is rejected before a Date is ever constructed. Same trap as the formatter
  // that printed "12/31/1969, 7:00 PM" for a missing time (2026-09-16).
  const at = (v) => (v === null || v === undefined || v === '' ? NaN : new Date(v).getTime());
  const start = at(shift && shift.start);
  const end = at(shift && shift.end);
  const inAt = at(log && log.clock_in_at);
  const outAt = at(log && log.clock_out_at);

  if (isFinite(start) && isFinite(inAt) && inAt > start + graceMinutes * 60000) derived.push('late_clock_in');
  if (isFinite(end) && isFinite(outAt)) {
    if (outAt < end - graceMinutes * 60000) derived.push('early_clock_out');
    if (outAt > end + graceMinutes * 60000) derived.push('late_clock_out');
  }
  // Order is preserved so a diff of the row reads as a change of substance
  // rather than a reshuffle.
  return kept.concat(derived.filter(f => !kept.includes(f)));
}

// ============================================================================
// BULK POSTING (owner request, 2026-09-20)
// ============================================================================
// Home care is a standing pattern — "Mon, Wed, Fri, 9 to 1, through the end of
// November" — and posting it one row at a time is forty identical form fills
// with forty chances to fat-finger one.
//
// The times are EASTERN WALL CLOCK, expanded here rather than in the browser.
// "9am every Monday" is 13:00Z in October and 14:00Z in November: a generator
// that adds seven days to an instant is an hour wrong for half the year, which
// is the availability-matcher bug (2026-09-16) pointed at creation instead of
// matching. Every occurrence is built from its own date through
// instantFromZoned, so the clock is right on both sides of the transition.
const MAX_BULK_OCCURRENCES = 200;

function expandRecurrence(input) {
  const body = input && typeof input === 'object' ? input : {};
  const errors = [];

  const startDate = String(body.startDate || '').trim();
  const endDate = String(body.endDate || '').trim();
  if (!isIsoDate(startDate)) errors.push({ field: 'startDate', code: 'START_DATE_INVALID', message: 'Give a first date.' });
  if (!isIsoDate(endDate)) errors.push({ field: 'endDate', code: 'END_DATE_INVALID', message: 'Give a last date.' });
  if (isIsoDate(startDate) && isIsoDate(endDate) && dayStartUtc(endDate) < dayStartUtc(startDate)) {
    errors.push({ field: 'endDate', code: 'DATE_RANGE_BACKWARDS', message: 'The last date is before the first.' });
  }

  const startTime = String(body.startTime || '').trim();
  const endTime = String(body.endTime || '').trim();
  if (!isTime(startTime)) errors.push({ field: 'startTime', code: 'START_TIME_INVALID', message: 'Give a start time as HH:MM.' });
  if (!isTime(endTime)) errors.push({ field: 'endTime', code: 'END_TIME_INVALID', message: 'Give an end time as HH:MM.' });

  const rawDays = Array.isArray(body.daysOfWeek) ? body.daysOfWeek : [];
  const days = [];
  rawDays.forEach(d => {
    const norm = normalizeDay(d);
    if (!norm) errors.push({ field: 'daysOfWeek', code: 'DAY_INVALID', message: `"${d}" is not a day of the week.` });
    else if (!days.includes(norm)) days.push(norm);
  });
  if (days.length === 0 && rawDays.length === 0) {
    errors.push({ field: 'daysOfWeek', code: 'DAYS_REQUIRED', message: 'Pick at least one day of the week.' });
  }

  // An overnight shift is legitimate — 10pm to 6am is a real home-care shift —
  // and it ends on the NEXT calendar day. Expressed here rather than refused,
  // the same way availability already models an overnight window.
  const overnight = isTime(startTime) && isTime(endTime) && minutesOfDay(endTime) <= minutesOfDay(startTime);

  if (errors.length > 0) return { valid: false, errors, occurrences: [] };

  const occurrences = [];
  let truncated = false;
  for (let ts = dayStartUtc(startDate); ts <= dayStartUtc(endDate); ts += DAY_MS) {
    const date = new Date(ts).toISOString().slice(0, 10);
    // The weekday of a plain calendar date, which has no timezone of its own.
    const weekday = DAYS[new Date(`${date}T00:00:00Z`).getUTCDay()];
    if (!days.includes(weekday)) continue;
    if (occurrences.length >= MAX_BULK_OCCURRENCES) { truncated = true; break; }
    const start = practiceTime.instantFromZoned(date, startTime);
    const endDay = overnight ? new Date(ts + DAY_MS).toISOString().slice(0, 10) : date;
    const end = practiceTime.instantFromZoned(endDay, endTime);
    if (!start || !end) continue;
    occurrences.push({ date, start, end });
  }

  if (occurrences.length === 0) {
    return {
      valid: false, occurrences: [],
      errors: [{
        field: 'daysOfWeek', code: 'NO_OCCURRENCES',
        message: 'No dates in that range fall on the days you picked.'
      }]
    };
  }
  if (truncated) {
    return {
      valid: false, occurrences: [],
      errors: [{
        field: 'endDate', code: 'TOO_MANY_OCCURRENCES',
        message: `That range is more than ${MAX_BULK_OCCURRENCES} shifts. Post it in shorter stretches.`
      }]
    };
  }
  return { valid: true, errors: [], occurrences, overnight };
}

// A shift that has already been posted twice for the same client at the same
// time is somebody clicking Post twice, not two visits. Bulk posting skips it
// rather than refusing the whole batch — and a CANCELLED row does not count,
// because reposting a shift that was called off is a real thing to do.
function findDuplicateShift(rows, clientId, start, end) {
  return (rows || []).find(r =>
    r && r.client_id === clientId && r.status !== 'cancelled' &&
    r.start === start && r.end === end) || null;
}

// ---- Removing in bulk ------------------------------------------------------
// Cancelling is the normal answer and it leaves a tombstone, because a shift
// somebody was confirmed on is a record of care that was promised. But a batch
// posted to the wrong client is a TYPO, and forty cancelled tombstones for a
// mistake nobody ever saw is clutter that makes the real cancellations harder
// to find.
//
// So a shift is deleted outright only when nobody has ever held it: still open,
// never claimed, never assigned, no caregiver, and no time log against it.
// Anything else cancels, with its reason, exactly as the single-shift route
// already does. Which of the two happened is reported per row, never guessed at
// by the caller.
function isNeverHeld(shift, timeLogs) {
  if (!shift || shift.status !== 'open') return false;
  if (shift.caregiver_id || shift.claimed_at || shift.assigned_at || shift.confirmed_at) return false;
  if (shift.started_at || shift.completed_at) return false;
  return !(timeLogs || []).some(l => l && String(l.shift_id) === String(shift.id));
}

module.exports = {
  AVAILABILITY_LEAD_DAYS, DAYS, normalizeDay, isTime, minutesOfDay, isIsoDate, daysUntil,
  validateAvailability, availabilityCoversShift,
  SHIFT_STATUSES, SHIFT_TRANSITIONS, SHIFT_STATUS_TIMESTAMP,
  canTransitionShift, transitionRefusal, validateShift,
  SHIFT_EDITABLE_FIELDS, EDITABLE_SHIFT_STATUSES, SHIFT_EDIT_COLUMN, canEditShift, validateShiftEdit,
  SCHEDULE_DERIVED_FLAGS, rederiveScheduleFlags,
  CHANGE_REQUEST_KINDS, CHANGE_REQUEST_STATUSES, CHANGE_REQUEST_NOTICE_MINUTES,
  REQUESTABLE_SHIFT_STATUSES, canRequestShiftChange, validateChangeRequest,
  describeNotice, isOpenChangeRequest, findOpenChangeRequest,
  MAX_BULK_OCCURRENCES, expandRecurrence, findDuplicateShift, isNeverHeld,
  LICENSE_REQUIREMENT_ANY, normalizeLicenseRequirement, shiftLevelLabel, isOpenToAllLevels,
  isEligibleForShift, eligibilityReason, shiftVisibility, shiftsOverlap, findShiftConflict, BLOCKING_STATUSES,
  DEFAULT_GEOFENCE_METERS, DEFAULT_GRACE_MINUTES, distanceMeters, geofenceRadiusFor, clientCoords,
  evaluateGeofence, GEOFENCE_MIN_METERS, GEOFENCE_MAX_METERS, validateClientLocation, TIME_LOG_FLAGS, clockInFlags, clockOutFlags, totalMinutes, minutesToHours,
  CLOCK_IN_WINDOW_MINUTES, clockInWindow,
  DEFAULT_PAY_PERIOD_ANCHOR, DEFAULT_PAY_PERIOD_DAYS, payPeriodFor,
  PAYROLL_CSV_COLUMNS, BILLING_CSV_COLUMNS, CAREGIVER_HOURS_CSV_COLUMNS, csvCell, toPayrollCsv,
  SHIFT_REQUEST_STATUSES, SHIFT_REQUEST_TRANSITIONS, canTransitionRequest
};
