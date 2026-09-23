// ============================================================
// Session 4.12 Scope J — what this app actually does with OpenEMR
// ============================================================
// WHY THIS FILE EXISTS. Five sessions have now hit the same wall from
// different directions: a capability that looked wired and was not. The
// document upload that returned `true` and could be read back by nothing. The
// allergy route that answered HTTP 200 with `data: []`. The narrowed OAuth
// token sitting behind a green "OpenEMR connected". `acknowledgeAbnormalResult`
// with no route for two sessions. Every one of those was invisible because
// nothing anywhere said, in one place, what had been PROVEN against the live
// instance as distinct from what had merely been written.
//
// So this is that one place, and its three lists are three different facts:
//
//   live            — exercised against the live instance and the STORED
//                     VALUE read back. Not a status code: this repo has been
//                     burned six times by a 200 that wrote nothing.
//   wired_unproven  — the code exists and is called, and nobody has run it
//                     against a real EMR. It may 403 on the org ACL, 404 on a
//                     route 8.4 does not serve, or work perfectly. We do not
//                     know, and saying so is the point of the row.
//   not_wired       — deliberately absent, with the reason. A gap somebody
//                     chose is a different fact from a gap nobody noticed,
//                     and only one of them is a bug.
//
// THE BUILD FAILS ON AN UNTRIAGED CAPABILITY: a FHIR resource the transport
// calls with no row here, or a row with no status from that enum. A capability
// that nobody has classified is exactly the one that turns out not to work.
//
// `note` is what somebody needs to know to act on the row — what was proven,
// or what is likely to be wrong, or why it was not built. Never a restatement
// of the status.

const STATUSES = Object.freeze(['live', 'wired_unproven', 'not_wired']);

const CATALOG = Object.freeze([
  // ---- FHIR reads proven against the live instance ----
  { resource: 'Patient', kind: 'read', status: 'live', since: '4.1',
    note: 'Search and read; the link step creates through it. Exercised in verify_43_patient_read.' },
  { resource: 'Condition', kind: 'read', status: 'live', since: '4.1',
    note: 'Returns, but on this instance carries NO ICD coding — OpenEMR\'s FHIR mapper drops it (settled 2026-09-08). The standard API returns the coding, so T1 fills it back in from the app\'s prior coded encounter.' },
  { resource: 'AllergyIntolerance', kind: 'read', status: 'live', since: '4.1',
    note: 'The allergen is in text.div, NOT in code — code holds the data-absent reason "Unknown", which displayed as every allergy reading "Unknown" until 2026-09-08.' },
  { resource: 'MedicationRequest', kind: 'read', status: 'live', since: '4.1',
    note: 'The med list reads through this because the standard-API list GET 500s on uuid-less rows.' },
  { resource: 'Encounter', kind: 'read', status: 'live', since: '4.1',
    note: 'Returns every row TWICE on 8.4; the transport dedupes by id. Still present as of the 4.5 preflight.' },
  { resource: 'CarePlan', kind: 'read', status: 'live', since: '4.1', note: 'Read only; the plan of care is authored in the app and filed as a document.' },
  { resource: 'DocumentReference', kind: 'read', status: 'live', since: '4.5',
    note: '403 until the Phase 8.6 org ACL grant; 200 since 2026-09-08. Reported total 0 instance-wide even for filed documents, which is why the chart index is assembled app-side and merges whatever FHIR returns.' },
  { resource: 'Observation', kind: 'read', status: 'live', since: '4.1', note: 'Vital-signs category only. The bundle grew after the 8.4 vitals POST fix, which is how that fix was confirmed.' },
  { resource: 'Practitioner', kind: 'read', status: 'live', since: '4.2',
    note: '403 at the ACL layer until the 8.6 grant. The provider list degrades to mapped app clinicians rather than reading empty.' },

  // ---- FHIR reads added in 4.12, NOT yet run against the live instance ----
  // Each of these is one line of transport and a chart section. What none of
  // them is, is proven. 8.4 may serve them, may 403 them on the org ACL, or
  // may not route them at all — and those are three different problems with
  // three different fixes, so the screen names which one it got.
  { resource: 'Coverage', kind: 'read', status: 'wired_unproven', since: '4.12',
    note: 'Answered 403 on the org ACL before the 8.6 grant and 200 after (verified 2026-09-08) — but nothing has read an actual coverage row back. The payer summary the app bills from is its own, from intake.' },
  { resource: 'Immunization', kind: 'read', status: 'wired_unproven', since: '4.12',
    note: 'Never called before this session. Home-based primary care gives flu and COVID vaccines, so this is the one most likely to hold real rows.' },
  { resource: 'CareTeam', kind: 'read', status: 'wired_unproven', since: '4.12',
    note: 'The app holds its own careTeam on the client record and that stays the source of truth for routing an escalation. This read is for what OpenEMR believes, which may differ.' },
  { resource: 'RelatedPerson', kind: 'read', status: 'wired_unproven', since: '4.12',
    note: 'Family and POA live on the app\'s user records; this is OpenEMR\'s own view. Never treat it as the POA designation — that is an app field set only after the document is verified.' },
  { resource: 'Goal', kind: 'read', status: 'wired_unproven', since: '4.12',
    note: 'Care-plan goals are authored in the app. This read exists so a goal entered directly in OpenEMR is visible rather than invisible.' },
  { resource: 'Device', kind: 'read', status: 'wired_unproven', since: '4.12',
    note: 'DME ordered through 4.10 is app-side and does not write here. A device recorded in OpenEMR would otherwise be unreadable from the app.' },
  { resource: 'Media', kind: 'read', status: 'wired_unproven', since: '4.12',
    note: 'Wound photographs are the realistic content. 8.4 may not route it at all; the chart says which failure it got.' },
  { resource: 'QuestionnaireResponse', kind: 'read', status: 'wired_unproven', since: '4.12',
    note: 'OWNER 2026-09-23: OpenEMR ALREADY HOLDS these templates — PHQ-9, GAD-7 and the rest — so this read is how they surface and the app must not rebuild them. Unproven only in that nobody has run the read yet; that the templates exist is not in doubt.' },
  { resource: 'Procedure', kind: 'read', status: 'wired_unproven', since: '4.12',
    note: 'Orders file into procedure_order through the 6B patch, not through FHIR. Whether they surface here is unknown.' },

  // ---- Standard REST, proven ----
  { resource: 'encounter', kind: 'write', status: 'live', since: '4.1',
    note: 'Create and update. The PUT needs `user` and `group` in the body or it answers HTTP 200 with a validationErrors map and writes NOTHING — check the body, never the status code.' },
  { resource: 'soap_note', kind: 'write', status: 'live', since: '4.4',
    note: 'Keyed by NUMERIC pid and eid; uuid-keyed writes coerce to pid 0 and orphan. The list endpoint leaks other encounters\' rows, so notes are read back by sid.' },
  { resource: 'vital', kind: 'write', status: 'live', since: '4.5', note: 'The 7.0.4 unconditional 500 is fixed on 8.4; POST returns 201 and the Observation bundle grows.' },
  { resource: 'medical_problem', kind: 'write', status: 'live', since: '4.1', note: 'begdate must be a plain date.' },
  { resource: 'allergy', kind: 'write', status: 'live', since: '4.1',
    note: 'begdate must be a plain DATE — a datetime is refused as HTTP 200 with data: []. Severity and reaction ride in the comment because severity_ale and reaction are empty option lists on this instance.' },
  { resource: 'medication', kind: 'write', status: 'live', since: '4.1', note: 'Keyed by numeric pid, resolved and cached from the uuid.' },
  { resource: 'prescription', kind: 'write', status: 'live', since: '4.5',
    note: 'Links on `encounter` with the NUMERIC eid; the uuid silently does not link. Reads date_added — start_date is accepted and discarded. Route and frequency ride in the note because drug_route and drug_interval are empty option lists here.' },
  { resource: 'appointment', kind: 'write', status: 'live', since: '4.2',
    note: 'No update route on 8.4 — reschedule and cancel use the tombstone swap. The LIST endpoints omit pc_hometext, pc_duration and pc_room; only the single-row GET returns them. Create can answer 200 with a validationErrors map.' },
  { resource: 'facility', kind: 'read', status: 'live', since: '4.5', note: 'Where the POS actually comes from. Hickory Log still has service_location unset.' },
  { resource: 'document', kind: 'write', status: 'live', since: '4.5', note: 'Keyed by NUMERIC pid. The uuid is rejected, which silently stopped care-plan filing after the 8.4 upgrade.' },
  { resource: 'document', kind: 'read', status: 'live', since: '4.9',
    note: 'Through the 6B patch, singular /document — the plural path would demand a sixth OAuth scope and a new client. Verified 29/29 with bytes read back. DELETE the override block when upstream fixes its CSRF-500 read.' },

  // ---- The Phase 6B patch routes ----
  { resource: 'billing', kind: 'write', status: 'live', since: '4.5',
    note: 'The 6B patch over BillingUtilities::addBilling(). Acceptance 17/17, and it took three runs — assert stored values, not status codes.' },
  { resource: 'order', kind: 'write', status: 'live', since: '4.5',
    note: 'procedure_order plus order-code rows. The controller reads name/title on the order half and code_text on the charge half, so all three keys are sent.' },
  { resource: 'codes', kind: 'read', status: 'live', since: '4.5',
    note: 'Through OpenEMR\'s own main_code_set_search. ICD-10 returns; CPT returns 0 rows and that is CORRECT — AMA copyright, OpenEMR ships none.' },

  // ---- Deliberately not wired ----
  { resource: 'AuditEvent', kind: 'read', status: 'not_wired', since: '—',
    note: 'DELIBERATE — it 404s on 8.4, as do api/log and fhir/Provenance. An accounting of disclosures cannot be produced from OpenEMR; the app\'s own durable audit_log (Session 5.4) is the record.' },
  { resource: 'Coverage', kind: 'write', status: 'not_wired', since: '—',
    note: 'DELIBERATE — eligibility is Track D / B1 (Availity). Writing a coverage row the app cannot verify would put an unchecked payer on a claim.' },
  { resource: 'Immunization', kind: 'write', status: 'not_wired', since: '—',
    note: 'DELIBERATE — recording an administration needs lot, site, route and a VIS date, which nothing in the app collects. A half-recorded immunization is worse than none.' },
  { resource: 'Questionnaire', kind: 'write', status: 'not_wired', since: '—',
    note: 'DELIBERATE, and the reason is now stronger: the templates EXIST in OpenEMR (owner, 2026-09-23), so writing one from here would create a second copy of an instrument that already has an authoritative version. Scores are read; the instrument stays the EMR\'s.' },
  { resource: 'Media', kind: 'write', status: 'not_wired', since: '—',
    note: 'DELIBERATE — a wound photograph goes to the chart as a document through the route that already exists and is proven, rather than through a second unproven path.' },
  { resource: 'Goal', kind: 'write', status: 'not_wired', since: '—',
    note: 'DELIBERATE — care-plan goals are authored and versioned in the app, and the signed plan is filed as a document. Two writers for one goal is how the two disagree.' },
  { resource: 'CareTeam', kind: 'write', status: 'not_wired', since: '—',
    note: 'DELIBERATE — the app\'s careTeam routes escalations and decides visibility. Mirroring it into OpenEMR would create a second answer to who is on this patient\'s team.' },
  { resource: 'procedure', kind: 'write', status: 'not_wired', since: '—',
    note: 'DELIBERATE — user/procedure.write does not exist on 8.4 (verified at the 4.5 preflight). Orders go through the 6B order route instead.' }
]);

const byStatus = (status) => CATALOG.filter(r => r.status === status);

// A resource the transport CALLS but nobody has classified. That is the row
// most likely to be broken, because nobody has looked at it.
const untriaged = (transportSource) => {
  const called = new Set();
  // Matches the fhirGet call sites: fhirGet(`Resource?…` or fhirGet('Resource'
  const re = /fhirGet\(\s*[`'"]([A-Za-z]+)[?`'\/]/g;
  let m;
  while ((m = re.exec(String(transportSource || ''))) !== null) called.add(m[1]);
  const declared = new Set(CATALOG.map(r => r.resource));
  return [...called].filter(r => !declared.has(r)).sort();
};

// Takes the rows so it can be GIVEN a bad one. With a clean catalog and no
// argument it returns [] whether or not it checks anything, so a test that
// only ran it against CATALOG could not distinguish a working detector from a
// deleted one — which is exactly what happened on the first mutation run.
const malformed = (rows = CATALOG) => rows
  .filter(r => !STATUSES.includes(r.status) || !r.resource || !r.kind || !String(r.note || '').trim())
  .map(r => r.resource || '(no resource)');

module.exports = { STATUSES, CATALOG, byStatus, untriaged, malformed };
