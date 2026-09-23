// ============================================================
// Session 4.12 — "My Day" and the pre-visit packet
// ============================================================
// Owner-directed after a live home visit, 2026-09-23. The workspace opened on
// a patient list. A house-call clinician does not start their day by looking
// up a patient; they start it by looking at the day.
//
// A NORMAL EHR ANSWERS "WHAT APPOINTMENTS DO I HAVE". A HOUSE-CALL EHR HAS TO
// ANSWER "IN WHAT ORDER SHOULD I SEE THESE PEOPLE, AND WHAT DO I NEED TO KNOW
// BEFORE I KNOCK." Everything here is built for reading on a phone, in a car,
// before getting out of it.
//
const sched = require('./schedulingRepository'); // clientCoords — the ONE reader
                                                 // for a client's location (see
                                                 // coordsOf below).

// PURE. No I/O, no db, no clock of its own — `now` and `today` are passed in,
// which is what makes the Eastern rule testable rather than hoped for. server.js
// wires it to the store, to OpenEMR's calendar and to the practice clock.

// ---- The day's visit lifecycle (Scope A5) --------------------------------
// This is NOT clinicalRepository.deriveAppointmentState. That one answers "has
// this visit been documented" and is a property of the record. This answers
// "where is the clinician right now" and is a property of the day — a visit can
// be `arrived` and undocumented, or `signed` and hours behind you.
const VISIT_STATE = Object.freeze({
  SCHEDULED: 'scheduled',
  EN_ROUTE: 'en_route',
  ARRIVED: 'arrived',
  IN_PROGRESS: 'in_progress',
  SIGNED: 'signed',
  CANCELLED: 'cancelled',
  NO_SHOW: 'no_show'
});

const VISIT_STATE_LABELS = Object.freeze({
  scheduled: 'Scheduled', en_route: 'En route', arrived: 'Arrived',
  in_progress: 'In progress', signed: 'Signed',
  cancelled: 'Cancelled', no_show: 'No-show'
});

// The stamps a clinician's own actions leave, in the order they happen. Read
// newest-first so the furthest-along stamp decides the state: a visit with an
// end time is finished whatever else is on the row.
const deriveVisitState = ({ appointment, timing, signed }) => {
  const a = appointment || {};
  if (a.status === 'x' || a.state === 'cancelled') return VISIT_STATE.CANCELLED;
  if (a.status === '?' || a.state === 'no_show') return VISIT_STATE.NO_SHOW;
  // SIGNED is the record's own answer, not a stamp anybody presses. A signed
  // encounter is signed even if the clinician never pressed Arrive — which is
  // exactly what a visit documented from the office afterwards looks like.
  if (signed) return VISIT_STATE.SIGNED;
  const t = timing || {};
  if (t.startedAt) return VISIT_STATE.IN_PROGRESS;
  if (t.arrivedAt) return VISIT_STATE.ARRIVED;
  if (t.enRouteAt) return VISIT_STATE.EN_ROUTE;
  return VISIT_STATE.SCHEDULED;
};

// ---- Visit timings (Scope F2) --------------------------------------------
// Arrival, start and end, and the total that supports time-based E/M leveling.
// The billing guide requires a time statement in every note and there was no
// field for it at all.
//
// KEYED BY APPOINTMENT, NOT BY ENCOUNTER, and that is load-bearing: ARRIVE is
// pressed at a front door, minutes before any encounter exists. Keying these to
// an encounter would mean the first stamp of the visit having nowhere to go.
const timingId = (eid) => `timing:${String(eid)}`;

const MAX_VISIT_MINUTES = 12 * 60;

// Whole minutes between two instants, or null. Null rather than 0 for an
// unfinished visit: a visit still running has no total, it does not have zero
// minutes — the `new Date(null)` trap this repo has now paid for twice, where
// the epoch is finite and an empty value silently became a real duration.
//
// WHICH GUARD DOES THE WORK, recorded because a mutation proved the difference.
// The `!fromIso || !toIso` line is BELT-AND-BRACES: loosening it to `&&` changes
// no outcome, because `new Date(null)` is the EPOCH — a finite, valid date — so
// a missing end time produces a hugely negative span that the `mins < 0` check
// refuses, and a missing start produces a ~29-million-minute span that the
// ceiling refuses. The two range checks below are the load-bearing ones. Do not
// remove either believing this first line covers them.
const minutesBetween = (fromIso, toIso) => {
  if (!fromIso || !toIso) return null;
  const a = new Date(fromIso), b = new Date(toIso);
  if (isNaN(a) || isNaN(b)) return null;
  const mins = Math.round((b.getTime() - a.getTime()) / 60000);
  if (mins < 0) return null;
  return mins > MAX_VISIT_MINUTES ? null : mins;
};

const totalVisitMinutes = (timing) => minutesBetween(timing && timing.startedAt, timing && timing.endedAt);

// The sentence that goes in the note. Built here, once, so the note and the
// visit information block can never disagree about how long the visit was.
const timeStatement = (timing) => {
  const mins = totalVisitMinutes(timing);
  if (mins == null) return null;
  const therapy = Number(timing && timing.psychotherapyMinutes) || 0;
  // Psychotherapy minutes are documented SEPARATELY from E/M minutes and the
  // same minute is never counted twice (billing guide). Stating both, with the
  // E/M figure net of therapy, is what keeps that true on the page.
  if (therapy > 0 && therapy <= mins) {
    return `Total visit time ${mins} minutes, of which ${therapy} minutes of psychotherapy; ` +
      `${mins - therapy} minutes of evaluation and management, separate and distinct from the psychotherapy time.`;
  }
  return `Total visit time ${mins} minutes, including face-to-face time with the patient and time spent on this date reviewing the record and coordinating care.`;
};

// ---- Drive time and distance ---------------------------------------------
// THIS IS WHERE THE GEOCODING DECISION BITES, AND IT IS AN OPEN OWNER ITEM.
// Drive times and miles need a routing provider, and one that handles patient
// addresses needs a BAA or an architecture that never sends identifying data
// with the coordinates. Until that is decided there is NO provider wired.
//
// So the day is built WITHOUT distances and says so, rather than showing a
// plausible "8 min away" derived from nothing. The app must not claim a state
// it cannot observe — the rule the ICD-10 correction bought and the geofence
// followed: no coordinates is `unavailable` with a reason, never `0 miles`.
const DISTANCE_UNAVAILABLE = 'no_routing_provider';

// Straight-line miles, which is the ONLY thing coordinates alone can honestly
// give. It is deliberately NOT presented as drive time: a 3-mile straight line
// across a river is a 20-minute drive, and a clinician planning a day on a
// number labelled "drive time" that is actually a crow's flight will be late.
const EARTH_RADIUS_MILES = 3958.8;
const haversineMiles = (a, b) => {
  const ok = (p) => p && isFinite(Number(p.lat)) && isFinite(Number(p.lng))
    && !(Number(p.lat) === 0 && Number(p.lng) === 0);
  if (!ok(a) || !ok(b)) return null;
  const rad = (d) => (Number(d) * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(EARTH_RADIUS_MILES * 2 * Math.asin(Math.sqrt(h)) * 10) / 10;
};

// WHERE A CLIENT LIVES HAS EXACTLY ONE READER AND IT IS NOT THIS MODULE.
//
// The caregiver side already solved this: there is no geocoding service
// anywhere in this app. An admin right-clicks the front door in Google Maps and
// pastes the coordinates into /scheduling → Locations, and that route writes
// them to `client.address.lat/lng`. The geofence has read them since Session 7.
//
// The first version of this function wrote its OWN reader and looked in
// `client.intake.address` first. That object exists on every enrolled client —
// the enrollment wizard fills in line1/city/state/zip — and carries no
// coordinates, so it won every time and this module reported "no coordinates"
// for every patient in the practice while the real ones sat one field away.
// Reproduced before the fix: the scheduling reader returned the coordinates and
// this one returned null on the same client.
//
// So it delegates. One answer to "where does this client live", owned by the
// module that owns the write. The dependency runs clinical → scheduling, which
// is the safe direction: test/scheduling.test.js forbids the reverse.
const coordsOf = (client) => sched.clientCoords(client);

const addressLineOf = (client) => {
  const intake = (client && client.intake) || {};
  const a = intake.address || {};
  const parts = [a.line1, a.line2].filter(Boolean).join(', ');
  const cityLine = [a.city, a.state, a.zip].filter(Boolean).join(' ');
  const structured = [parts, cityLine].filter(Boolean).join(', ');
  return structured || intake.addressLine1 || null;
};


// ---- Scope B2/B5: plotting the day, and filling a trip ---------------------
// NO MAP TILES, DELIBERATELY. A tile provider would receive the coordinates of
// every patient's home on every render, which is a disclosure of where people
// live to a third party with no BAA — and for the question this screen answers
// ("in what order should I see these people") a street map adds nothing a
// relative plot does not. The brief's own sketch is dots joined by lines.
//
// So the plot is computed HERE and drawn as an SVG from coordinates the app
// already holds. Nothing leaves the boundary.
const MAP_PADDING = 0.08; // fraction of the box kept clear at each edge

const plotStops = ({ stops, width = 100, height = 100 }) => {
  const placed = (stops || []).filter(s => s && s.coords);
  if (!placed.length) return { points: [], bounds: null, unplaceable: (stops || []).length };
  const lats = placed.map(s => s.coords.lat);
  const lngs = placed.map(s => s.coords.lng);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  // A single stop, or several at one address, collapses the span to zero.
  // Dividing by it is NaN, and flooring the span to 1 is not enough on its own:
  // the ratio then reads 0 and every pin lands in a corner, which is what a
  // one-visit day looked like. A degenerate axis is CENTRED instead.
  const latSpan = maxLat - minLat;
  const lngSpan = maxLng - minLng;
  const ratio = (value, min, span) => (span > 0 ? (value - min) / span : 0.5);
  const pad = MAP_PADDING;
  const points = placed.map((s, i) => ({
    eid: s.eid || null,
    clientId: s.clientId || null,
    label: s.patientName || null,
    order: i + 1,
    state: s.state || null,
    time: s.time || null,
    // Latitude increases NORTHWARD and SVG y increases DOWNWARD, so y is
    // inverted. Without that the day is drawn upside down and reads as a
    // completely different route.
    x: Math.round((pad + (1 - 2 * pad) * ratio(s.coords.lng, minLng, lngSpan)) * width * 10) / 10,
    y: Math.round((pad + (1 - 2 * pad) * (1 - ratio(s.coords.lat, minLat, latSpan))) * height * 10) / 10
  }));
  return {
    points,
    bounds: { minLat, maxLat, minLng, maxLng },
    unplaceable: (stops || []).length - placed.length
  };
};

// B5 — geographic clustering. When a visit is being booked, who else lives
// near that address and is due to be seen? A house call is mostly driving, so
// a trip that fills two slots instead of one is the single biggest lever there
// is on a day.
//
// "DUE" IS DEFINED BY A LAST VISIT DATE AND NOTHING CLEVERER. A patient with
// no visit on file is due; one seen last week is not. Inventing a recall
// interval per patient would be a clinical judgement the app has no basis for.
const DUE_AFTER_DAYS = 60;

const daysBetweenYmd = (from, to) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(from || '')) || !/^\d{4}-\d{2}-\d{2}$/.test(String(to || ''))) return null;
  return Math.round((new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / 86400000);
};

const findNearbyDue = ({ origin, candidates, radiusMiles = 10, today, dueAfterDays = DUE_AFTER_DAYS, excludeClientIds }) => {
  const skip = new Set((excludeClientIds || []).map(String));
  return (candidates || [])
    .filter(c => c && !skip.has(String(c.clientId)))
    .map(c => {
      const miles = haversineMiles(origin, c.coords);
      if (miles == null || miles > radiusMiles) return null;
      const sinceDays = daysBetweenYmd(c.lastVisitAt, today);
      // No visit on file is DUE, and says so as its own reason rather than
      // being ranked against a number it does not have.
      const due = c.lastVisitAt ? (sinceDays != null && sinceDays >= dueAfterDays) : true;
      if (!due) return null;
      return {
        clientId: c.clientId, name: c.name || null, address: c.address || null,
        miles, lastVisitAt: c.lastVisitAt || null,
        daysSinceLastVisit: c.lastVisitAt ? sinceDays : null,
        reason: c.lastVisitAt ? 'due_by_interval' : 'never_seen'
      };
    })
    .filter(Boolean)
    // Nearest first: the question is "who can I add to this trip", and the
    // answer is ordered by how little extra driving it costs.
    .sort((a, b) => a.miles - b.miles);
};

// ---- The day -------------------------------------------------------------

// A non-visit block — lunch, travel, admin — rendered in the timeline so the
// day reads as a day and not as a list of appointments with holes in it.
const NON_VISIT_KINDS = Object.freeze(['lunch', 'travel', 'admin', 'blocked']);

const buildDayRow = ({ appointment, client, timing, signed, previousCoords, homeVisitFields }) => {
  const a = appointment || {};
  const coords = coordsOf(client);
  const miles = haversineMiles(previousCoords, coords);
  const hv = (client && client.homeVisit) || {};
  return {
    eid: a.eid || null,
    clientId: (client && client.id) || a.clientId || null,
    encounterUuid: a.encounterUuid || null,
    time: a.startTime || null,
    endTime: a.endTime || null,
    date: a.date || null,
    patientName: (client && client.name) || a.patientName || null,
    visitType: a.title || 'Clinical visit',
    serviceLine: (client && client.serviceLine) || null,
    address: addressLineOf(client),
    coords,
    // Straight-line only, and LABELLED as such. Drive time needs a routing
    // provider that does not exist yet (see DISTANCE_UNAVAILABLE above).
    distance: coords && previousCoords
      ? { miles, kind: 'straight_line', driveMinutes: null, reason: DISTANCE_UNAVAILABLE }
      : { miles: null, kind: null, driveMinutes: null,
        reason: coords ? 'first_stop' : 'no_coordinates' },
    state: deriveVisitState({ appointment: a, timing, signed }),
    timing: timing
      ? { enRouteAt: timing.enRouteAt || null, arrivedAt: timing.arrivedAt || null,
        startedAt: timing.startedAt || null, endedAt: timing.endedAt || null,
        totalMinutes: totalVisitMinutes(timing) }
      : null,
    // A2 — what you read in the car. From the PATIENT record, never a visit.
    homeVisit: (homeVisitFields || []).reduce((acc, [k, label]) => {
      if (hv[k]) acc.push({ key: k, label, value: hv[k] });
      return acc;
    }, []),
    location: a.location || null,
    notes: a.notes || null
  };
};

// An unsigned note from an EARLIER day is pinned at the top, in red. It is the
// practice's biggest silent risk: nothing chases it, the visit already happened,
// and the longer it sits the less anybody remembers of it.
const buildUnsignedBacklog = ({ rows, today }) => rows
  .filter(r => r && r.date && String(r.date) < String(today))
  .sort((a, b) => String(a.date).localeCompare(String(b.date)));

const buildMyDay = ({
  date, appointments, clientsById, timingsByEid, signedEids,
  unsignedEarlier, openTasks, blocks, homeVisitFields, startCoords
}) => {
  const visits = [];
  let previousCoords = startCoords || null;
  (appointments || [])
    .slice()
    .sort((a, b) => String(a.startTime || '').localeCompare(String(b.startTime || '')))
    .forEach(a => {
      const client = (clientsById && clientsById.get(String(a.clientId))) || null;
      const row = buildDayRow({
        appointment: a,
        client,
        timing: (timingsByEid && timingsByEid.get(String(a.eid))) || null,
        signed: !!(signedEids && signedEids.has(String(a.eid))),
        previousCoords,
        homeVisitFields
      });
      // Only a stop you actually drive to advances the position. A cancelled
      // visit measured as a leg would inflate every mile after it.
      if (row.coords && row.state !== VISIT_STATE.CANCELLED) previousCoords = row.coords;
      visits.push(row);
    });

  const counted = visits.filter(v => v.state !== VISIT_STATE.CANCELLED);
  const legs = counted.map(v => v.distance && v.distance.miles).filter(m => typeof m === 'number');
  // Every stop must be measurable for a total to mean anything. One patient with
  // no coordinates makes "31 miles" an understatement nobody can see, so the
  // total says it is partial and how many stops it could not place.
  const unplaceable = counted.filter(v => !v.coords).length;
  return {
    date,
    visits,
    blocks: (blocks || []).filter(b => b && NON_VISIT_KINDS.includes(b.kind)),
    unsigned: buildUnsignedBacklog({ rows: unsignedEarlier || [], today: date }),
    totals: {
      visits: counted.length,
      miles: legs.length ? Math.round(legs.reduce((s, m) => s + m, 0) * 10) / 10 : null,
      milesKind: legs.length ? 'straight_line' : null,
      milesPartial: unplaceable > 0,
      unplaceableStops: unplaceable,
      driveMinutes: null,
      driveMinutesReason: DISTANCE_UNAVAILABLE,
      openTasks: Number(openTasks) || 0
    }
  };
};

// ---- Route optimisation (Scope B4) ---------------------------------------
// PROPOSES an order and never applies one. The clinician accepts or discards,
// and accepting rebooks through the existing appointment routes so the patient
// is told (the 4.11 reschedule notice). A schedule that silently rewrote itself
// would move a visit a patient is expecting without anybody deciding to.
//
// Nearest-neighbour on straight-line distance. It is a HEURISTIC and says so:
// without a routing provider there is no drive time to optimise against, so
// this orders by proximity, which is better than booking order and is not the
// same thing as an optimal route.
const proposeRouteOrder = ({ visits, startCoords }) => {
  const movable = (visits || []).filter(v =>
    v && v.coords && v.state === VISIT_STATE.SCHEDULED);
  const fixed = (visits || []).filter(v => !movable.includes(v));
  if (movable.length < 2) {
    return { proposal: null, reason: movable.length ? 'only_one_movable_stop' : 'nothing_to_reorder' };
  }
  const remaining = movable.slice();
  const ordered = [];
  let at = startCoords || movable[0].coords;
  while (remaining.length) {
    let bestIdx = 0, bestMiles = Infinity;
    remaining.forEach((v, i) => {
      const m = haversineMiles(at, v.coords);
      if (m != null && m < bestMiles) { bestMiles = m; bestIdx = i; }
    });
    const next = remaining.splice(bestIdx, 1)[0];
    ordered.push(next);
    at = next.coords;
  }
  const before = movable.map(v => v.eid);
  const after = ordered.map(v => v.eid);
  const changed = before.some((eid, i) => eid !== after[i]);
  return {
    proposal: {
      // The TIMES stay where they are; what is proposed is which patient is
      // seen in which slot. The clinician still has to accept it, and accepting
      // rebooks through the appointment routes.
      order: ordered.map((v, i) => ({
        eid: v.eid, clientId: v.clientId, patientName: v.patientName,
        fromTime: v.time, toTime: movable[i] ? movable[i].time : v.time
      })),
      unchanged: !changed,
      fixedStops: fixed.map(v => ({ eid: v.eid, state: v.state })),
      kind: 'straight_line_nearest_neighbour',
      caveat: 'Ordered by straight-line proximity. Drive time needs a routing provider, which is not configured.'
    },
    reason: changed ? null : 'already_in_proximity_order'
  };
};

// ---- The pre-visit packet (Scope E) --------------------------------------
// Everything on it is DERIVED. Nothing is typed twice. It is read on a phone in
// a car, so the route that serves it assembles it in one request rather than
// making the page wait on a full chart.
const buildPreVisitPacket = ({
  client, appointment, banner, lastVisitAt, lastVitals, activeProblems,
  recentResults, medicationChanges, openOrders, unacknowledgedResults,
  openReferrals, carePlanGoalsUnmet, homeVisitFields
}) => {
  const hv = (client && client.homeVisit) || {};
  const openItems = [];
  (openReferrals || []).forEach(r => openItems.push({
    kind: 'referral', text: `${r.specialty || 'Referral'} referral ${r.status || 'pending'}`, id: r.id || null
  }));
  (openOrders || []).forEach(o => openItems.push({
    kind: 'order', text: `${o.label || o.orderType || 'Order'} outstanding${o.orderedAt ? ` since ${String(o.orderedAt).slice(0, 10)}` : ''}`, id: o.id || null
  }));
  (unacknowledgedResults || []).forEach(r => openItems.push({
    kind: 'result', text: `${r.label || 'Result'} not yet acknowledged${r.interpretation ? ` (${r.interpretation})` : ''}`, id: r.id || null
  }));
  (carePlanGoalsUnmet || []).forEach(g => openItems.push({ kind: 'goal', text: g, id: null }));
  return {
    clientId: (client && client.id) || null,
    patientName: (client && client.name) || null,
    banner: banner || null,
    reason: (appointment && (appointment.title || appointment.notes)) || null,
    when: appointment ? { date: appointment.date, startTime: appointment.startTime } : null,
    lastVisitAt: lastVisitAt || null,
    lastVitals: lastVitals || null,
    activeProblems: activeProblems || [],
    recentResults: recentResults || [],
    medicationChanges: medicationChanges || [],
    openItems,
    // Standing facts, from the PATIENT. The third of the three surfaces that
    // read this one field — the banner and the My Day row are the others.
    homeVisit: (homeVisitFields || []).reduce((acc, [k, label]) => {
      if (hv[k]) acc.push({ key: k, label, value: hv[k] });
      return acc;
    }, [])
  };
};

module.exports = {
  VISIT_STATE, VISIT_STATE_LABELS, NON_VISIT_KINDS,
  deriveVisitState,
  timingId, minutesBetween, totalVisitMinutes, timeStatement, MAX_VISIT_MINUTES,
  DISTANCE_UNAVAILABLE, haversineMiles, coordsOf, addressLineOf,
  buildDayRow, buildUnsignedBacklog, buildMyDay,
  proposeRouteOrder,
  plotStops, MAP_PADDING,
  findNearbyDue, DUE_AFTER_DAYS, daysBetweenYmd,
  buildPreVisitPacket
};
