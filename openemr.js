// ============================================================
// OpenEMR FHIR/REST client (Session 4.1)
//
// The app is a FRONT END to OpenEMR: one patient record lives in OpenEMR and
// this module renders/edits it. It never duplicates the clinical record into
// the KV store — the only app-side clinical pointers are client.openEmrPatientId,
// client.carePlan, and audit/activity entries (see CLAUDE.md architecture rule).
//
// Transport (approved deviation, 08/2026): OpenEMR 7.0.4's FHIR R4 API is
// read-only for clinical resources, so READS go through FHIR
// (/apis/<site>/fhir/*) while clinical WRITES (encounter, vitals, soap note,
// problem list, medications, allergies, documents) go through OpenEMR's
// standard REST API (/apis/<site>/api/*). Patient create/update is FHIR.
//
// Auth (approved for the dev window, 08/2026): OAuth2 password grant with the
// dedicated gfc-app-api OpenEMR user + confidential client. Tokens live ONLY
// in this server process — the browser never sees them. Migration to
// authorization_code + refresh_token is a Session 5 scope item.
//
// Every FHIR/REST call is logged through the activity logger injected by
// server.js (setActivityLogger) with user, role, patientId, resource, action.
// ============================================================

// Uses Node's global fetch (Node 18+) — plays correctly with proxied
// environments where axios's env-proxy handling does not.
const config = require('./config');

const BASE_URL = (config.OPENEMR.BASE_URL || '').replace(/\/+$/, '');
const SITE = config.OPENEMR.SITE || 'default';

const fhirUrl = (path) => `${BASE_URL}/apis/${SITE}/fhir/${path.replace(/^\/+/, '')}`;
const apiUrl = (path) => `${BASE_URL}/apis/${SITE}/api/${path.replace(/^\/+/, '')}`;
const tokenUrl = () => `${BASE_URL}/oauth2/${SITE}/token`;

const REQUIRED_ENV = [
  ['OPENEMR_BASE_URL', () => BASE_URL],
  ['OPENEMR_CLIENT_ID', () => config.OPENEMR.CLIENT_ID],
  ['OPENEMR_CLIENT_SECRET', () => config.OPENEMR.CLIENT_SECRET],
  ['OPENEMR_API_USERNAME', () => config.OPENEMR.API_USERNAME],
  ['OPENEMR_API_PASSWORD', () => config.OPENEMR.API_PASSWORD]
];
// Which required env vars are absent/blank. NAMES ONLY — never values, so this
// is safe to surface in the UI for setup diagnostics.
const missingConfig = () => REQUIRED_ENV.filter(([, read]) => !String(read() || '').trim()).map(([name]) => name);
const isConfigured = () => missingConfig().length === 0;

// ---- Activity logging (injected by server.js to avoid a require cycle) ----
let activityLogger = null;
const setActivityLogger = (fn) => { activityLogger = fn; };
const logEmrAccess = (actor, action, resource, patientId, details) => {
  if (!activityLogger || !actor) return;
  // Fire-and-forget: audit failure must never fail the clinical call itself
  Promise.resolve(activityLogger(
    actor.id, actor.name || actor.email, `emr_${action}`, `openemr:${resource}`,
    patientId || null, { role: actor.role, resource, action, ...details }
  )).catch(err => console.error('OpenEMR activity log failed:', err.message));
};

// ---- Token management (server-side only) ----
let tokenState = { accessToken: null, refreshToken: null, expiresAt: 0, grantedScopes: [] };
let authInFlight = null;

const requestToken = async (form) => {
  const body = new URLSearchParams({
    client_id: config.OPENEMR.CLIENT_ID,
    client_secret: config.OPENEMR.CLIENT_SECRET,
    ...form
  });
  const res = await fetch(tokenUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(20000)
  });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON error body */ }
  if (res.status !== 200 || !data || !data.access_token) {
    const hint = data && (data.error_description || data.error);
    throw new Error(`OpenEMR token request failed (HTTP ${res.status}${hint ? `: ${hint}` : ''})`);
  }
  tokenState = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || tokenState.refreshToken,
    // Refresh 60s before actual expiry
    expiresAt: Date.now() + (Math.max(120, data.expires_in || 3600) - 60) * 1000,
    // Granted scope set (names only) — surfaced by getStatus() so the
    // workspace can tell whether the deployed client carries the 4.2
    // appointment scopes (the OAuth client swap is a P0 deploy step).
    grantedScopes: String(data.scope || '').split(/\s+/).filter(Boolean)
  };
  return tokenState.accessToken;
};

const passwordGrant = () => requestToken({
  grant_type: 'password',
  user_role: 'users',
  username: config.OPENEMR.API_USERNAME,
  password: config.OPENEMR.API_PASSWORD,
  scope: config.OPENEMR.SCOPES
});

const getAccessToken = async () => {
  if (!isConfigured()) throw new Error('OpenEMR is not configured (missing env — see .env.example)');
  if (tokenState.accessToken && Date.now() < tokenState.expiresAt) return tokenState.accessToken;
  // Single-flight: concurrent requests share one auth round-trip
  if (!authInFlight) {
    authInFlight = (async () => {
      try {
        if (tokenState.refreshToken) {
          try {
            return await requestToken({ grant_type: 'refresh_token', refresh_token: tokenState.refreshToken });
          } catch (e) {
            tokenState.refreshToken = null; // stale refresh token → full re-auth
          }
        }
        return await passwordGrant();
      } finally {
        authInFlight = null;
      }
    })();
  }
  return authInFlight;
};

// Drop the cached token (e.g. after a 401) so the next call re-authenticates.
const invalidateToken = () => { tokenState = { accessToken: null, refreshToken: null, expiresAt: 0, grantedScopes: [] }; };

// ---- Low-level request with one automatic re-auth on 401 ----
// Returns { status, data } — data parsed as JSON when possible.
const rawRequest = async ({ method, url, body, headers, formData }) => {
  const attempt = async () => {
    const token = await getAccessToken();
    const h = { Authorization: `Bearer ${token}`, ...(headers || {}) };
    let payload;
    if (formData) {
      payload = formData; // global FormData — fetch sets the multipart boundary
    } else if (body !== undefined && body !== null) {
      h['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(url, {
      method, headers: h, body: payload,
      signal: AbortSignal.timeout(30000)
    });
    let data = null;
    const text = await res.text();
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 500) }; }
    return { status: res.status, data };
  };
  let res = await attempt();
  if (res.status === 401) { invalidateToken(); res = await attempt(); }
  return res;
};

class OpenEmrError extends Error {
  constructor(message, status, data) { super(message); this.name = 'OpenEmrError'; this.status = status; this.data = data; }
}

const expectOk = (res, what) => {
  if (res.status >= 200 && res.status < 300) return res.data;
  const detail = res.data && (res.data.error_description || res.data.error ||
    (res.data.validationErrors && JSON.stringify(res.data.validationErrors)) ||
    (res.data.issue && JSON.stringify(res.data.issue).slice(0, 300)));
  throw new OpenEmrError(`OpenEMR ${what} failed (HTTP ${res.status}${detail ? `: ${detail}` : ''})`, res.status, res.data);
};

// Standard-API responses wrap payloads as { validationErrors, internalErrors, data }.
const unwrapApi = (payload) => (payload && typeof payload === 'object' && 'data' in payload) ? payload.data : payload;

// Flatten a FHIR searchset Bundle to its resources. Deduped by
// resourceType/id: this 7.0.4 instance returns every Encounter twice in both
// the FHIR search and the standard-API list (a join duplication, verified live
// 2026-09-04), and a search bundle never legitimately repeats a resource.
const bundleResources = (bundle) => {
  const seen = new Set();
  return ((bundle && bundle.entry) || []).map(e => e.resource).filter(r => {
    if (!r) return false;
    const key = `${r.resourceType || ''}/${r.id || ''}`;
    if (r.id && seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

// OpenEMR 7.0.4 endpoint quirks (verified against the dev instance):
//  - medical_problem.begdate: plain YYYY-MM-DD
//  - allergy.begdate: datetime "YYYY-MM-DD 00:00:00"
//  - medication endpoints: numeric pid, NOT the patient uuid
const toEmrDatetime = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || '')) ? `${d} 00:00:00` : d;

// uuid → numeric pid cache (a pointer, not clinical data; in-memory only)
const pidCache = new Map();
// encounter uuid → numeric eid cache (same nature). The soap_note and vital
// routes key by NUMERIC pid + eid (verified against the 7.0.4 route table and
// live 2026-09-04: passing uuids is silently coerced to pid 0 / encounter 0,
// which ORPHANS the note from the encounter — the 4.1 note writes had been
// landing that way). Every note/vital call below resolves ids first.
const eidCache = new Map();

// ============================================================
// Actor-bound client: every route builds one per request so all
// EMR access is attributed to the acting user in the activity log.
// ============================================================
const forActor = (actor) => {
  const fhirGet = async (path, resource, patientId, what) => {
    const res = await rawRequest({ method: 'GET', url: fhirUrl(path) });
    const data = expectOk(res, what || `read ${resource}`);
    logEmrAccess(actor, 'read', resource, patientId, { path });
    return data;
  };
  const apiWrite = async (method, path, body, resource, patientId, what) => {
    const res = await rawRequest({ method, url: apiUrl(path), body });
    const data = expectOk(res, what || `write ${resource}`);
    logEmrAccess(actor, 'write', resource, patientId, { path });
    return unwrapApi(data);
  };
  // The medication endpoints key by numeric pid, not uuid — resolve once.
  const resolvePid = async (puuid) => {
    if (pidCache.has(puuid)) return pidCache.get(puuid);
    const res = await rawRequest({ method: 'GET', url: apiUrl(`patient/${encodeURIComponent(puuid)}`) });
    const row = unwrapApi(expectOk(res, 'read patient (pid resolve)'));
    const pid = row && row.id;
    if (pid == null) throw new OpenEmrError('Could not resolve OpenEMR pid for patient uuid', 404, null);
    pidCache.set(puuid, pid);
    return pid;
  };
  // Standard-API encounter row (has eid, reason, billing_note, provider_id…).
  const getEncounterRow = async (puuid, euuid) => {
    const res = await rawRequest({ method: 'GET', url: apiUrl(`patient/${encodeURIComponent(puuid)}/encounter/${encodeURIComponent(euuid)}`) });
    const data = expectOk(res, 'read encounter');
    logEmrAccess(actor, 'read', 'encounter', puuid, { euuid });
    const payload = unwrapApi(data);
    const row = Array.isArray(payload) ? payload[0] || null : payload || null;
    if (row && row.eid != null) eidCache.set(euuid, row.eid);
    return row;
  };
  const resolveEid = async (puuid, euuid) => {
    if (/^\d+$/.test(String(euuid))) return Number(euuid);
    if (eidCache.has(euuid)) return eidCache.get(euuid);
    const row = await getEncounterRow(puuid, euuid);
    if (!row || row.eid == null) throw new OpenEmrError('Could not resolve OpenEMR encounter id for encounter uuid', 404, null);
    return row.eid;
  };

  return {
    // ---- FHIR reads ----
    async searchPatients(params) {
      const q = new URLSearchParams(params || {}).toString();
      const bundle = await fhirGet(`Patient${q ? `?${q}` : ''}`, 'Patient', null, 'search Patient');
      return bundleResources(bundle);
    },
    async getPatient(puuid) {
      return fhirGet(`Patient/${encodeURIComponent(puuid)}`, 'Patient', puuid);
    },
    async getProblems(puuid) {
      return bundleResources(await fhirGet(`Condition?patient=${encodeURIComponent(puuid)}`, 'Condition', puuid));
    },
    async getAllergies(puuid) {
      return bundleResources(await fhirGet(`AllergyIntolerance?patient=${encodeURIComponent(puuid)}`, 'AllergyIntolerance', puuid));
    },
    async getMedicationRequests(puuid) {
      return bundleResources(await fhirGet(`MedicationRequest?patient=${encodeURIComponent(puuid)}`, 'MedicationRequest', puuid));
    },
    async getEncounters(puuid) {
      return bundleResources(await fhirGet(`Encounter?patient=${encodeURIComponent(puuid)}`, 'Encounter', puuid));
    },
    async getCarePlans(puuid) {
      return bundleResources(await fhirGet(`CarePlan?patient=${encodeURIComponent(puuid)}`, 'CarePlan', puuid));
    },
    async getDocumentReferences(puuid) {
      return bundleResources(await fhirGet(`DocumentReference?patient=${encodeURIComponent(puuid)}`, 'DocumentReference', puuid));
    },
    async getVitalObservations(puuid) {
      return bundleResources(await fhirGet(
        `Observation?patient=${encodeURIComponent(puuid)}&category=vital-signs`, 'Observation', puuid));
    },
    async getPractitioners() {
      return bundleResources(await fhirGet('Practitioner', 'Practitioner', null));
    },

    // ---- FHIR Patient create/update (the link step) ----
    async createPatient(fhirPatient) {
      const res = await rawRequest({ method: 'POST', url: fhirUrl('Patient'), body: fhirPatient });
      const data = expectOk(res, 'create Patient');
      // 7.0.4 quirk (verified live): the FHIR Patient POST does NOT echo the
      // created resource — it returns {"pid":N,"uuid":"..."}. Accept that, the
      // spec-shaped {id}, and the standard-API {data:{...}} wrapper, so the
      // link step works regardless of which shape the instance returns.
      const body = (data && typeof data === 'object' && data.data && typeof data.data === 'object') ? data.data : data;
      const puuid = body && (body.uuid || body.id || null);
      if (!puuid) {
        throw new OpenEmrError(
          `OpenEMR created the patient but returned no id (response keys: ${body && typeof body === 'object' ? Object.keys(body).join(', ') || 'none' : typeof body})`,
          res.status, data);
      }
      logEmrAccess(actor, 'write', 'Patient', puuid, { op: 'create' });
      // Normalize so callers can always read `.id` (the FHIR-shaped contract).
      return { ...body, id: puuid };
    },

    // ---- Standard-API clinical writes ----
    // OpenEMR wraps write responses as {validationErrors, internalErrors, data}.
    // The encounter POST requires pc_catid/facility/pos fields (verified on the
    // dev instance); defaults are env-overridable and pos_code 12 = Home, which
    // is what a home-visit practice wants.
    async createEncounter(puuid, fields) {
      const body = {
        pc_catid: config.OPENEMR.ENCOUNTER_CATEGORY,
        facility_id: config.OPENEMR.FACILITY_ID,
        billing_facility: config.OPENEMR.FACILITY_ID,
        sensitivity: 'normal',
        pos_code: config.OPENEMR.POS_CODE,
        provider_id: config.OPENEMR.PROVIDER_ID,
        ...fields
      };
      const row = await apiWrite('POST', `patient/${encodeURIComponent(puuid)}/encounter`, body, 'encounter', puuid);
      if (!row || (Array.isArray(row) && !row.length)) {
        throw new OpenEmrError('OpenEMR rejected the encounter (empty payload — check required fields)', 422, row);
      }
      // The create response carries both ids; remember the numeric one so the
      // note/vital writes that follow need no extra round-trip.
      if (row.euuid && row.eid != null) eidCache.set(row.euuid, row.eid);
      return row;
    },
    getEncounterRow,
    resolveEid,
    // Vitals + SOAP notes key by NUMERIC pid/eid (see eidCache note above).
    async addVitals(puuid, encounterUuid, vitals) {
      const [pid, eid] = await Promise.all([resolvePid(puuid), resolveEid(puuid, encounterUuid)]);
      return apiWrite('POST', `patient/${pid}/encounter/${eid}/vital`, vitals, 'vital', puuid);
    },
    // Returns { sid, fid } — sid is the form_soap row id needed to update the
    // note later (the GFC structured note is regenerated in place).
    async addSoapNote(puuid, encounterUuid, note) {
      const [pid, eid] = await Promise.all([resolvePid(puuid), resolveEid(puuid, encounterUuid)]);
      const res = await rawRequest({ method: 'POST', url: apiUrl(`patient/${pid}/encounter/${eid}/soap_note`), body: note });
      const data = expectOk(res, 'write soap_note');
      logEmrAccess(actor, 'write', 'soap_note', puuid, { eid });
      const body = unwrapApi(data) || {};
      // 7.0.4 answers HTTP 200 with a validation map (e.g. {"plan":{"LengthBetween::TOO_SHORT":…}})
      // when a section fails validation — no sid means NO note was written.
      if (body.sid == null) {
        throw new OpenEmrError(`OpenEMR rejected the SOAP note (${JSON.stringify(body).slice(0, 200)})`, 422, body);
      }
      return { sid: String(body.sid), fid: body.fid != null ? String(body.fid) : null };
    },
    async updateSoapNote(puuid, encounterUuid, sid, note) {
      const [pid, eid] = await Promise.all([resolvePid(puuid), resolveEid(puuid, encounterUuid)]);
      return apiWrite('PUT', `patient/${pid}/encounter/${eid}/soap_note/${encodeURIComponent(sid)}`, note, 'soap_note', puuid, 'update soap_note');
    },
    // One SOAP-note row by its form_soap id — the precise read (the single-row
    // query filters on encounter AND id).
    async getSoapNote(puuid, encounterUuid, sid) {
      const [pid, eid] = await Promise.all([resolvePid(puuid), resolveEid(puuid, encounterUuid)]);
      const res = await rawRequest({ method: 'GET', url: apiUrl(`patient/${pid}/encounter/${eid}/soap_note/${encodeURIComponent(sid)}`) });
      if (res.status === 404) return null;
      const data = expectOk(res, 'read soap_note');
      logEmrAccess(actor, 'read', 'soap_note', puuid, { eid, sid: String(sid) });
      const row = unwrapApi(data);
      return Array.isArray(row) ? row[0] || null : row || null;
    },
    // All SOAP-note rows on an encounter. CAUTION (7.0.4 quirk, verified live
    // 2026-09-04): the list query joins `forms` to `form_soap` on form_id
    // WITHOUT a formdir filter, so a non-SOAP form row on this encounter whose
    // form_id collides with another encounter's form_soap id leaks that other
    // note into the list (and rows can duplicate). Callers must prefer the
    // sids they recorded (getSoapNote) and treat this list as a hint only.
    async getSoapNotes(puuid, encounterUuid) {
      const [pid, eid] = await Promise.all([resolvePid(puuid), resolveEid(puuid, encounterUuid)]);
      const res = await rawRequest({ method: 'GET', url: apiUrl(`patient/${pid}/encounter/${eid}/soap_note`) });
      if (res.status === 404) return []; // 7.0.4 answers 404 (empty body) when the encounter has no notes yet
      const data = expectOk(res, 'read soap_note');
      logEmrAccess(actor, 'read', 'soap_note', puuid, { eid });
      const rows = unwrapApi(data);
      const seen = new Map();
      for (const r of Array.isArray(rows) ? rows : []) if (r && r.id != null && !seen.has(String(r.id))) seen.set(String(r.id), r);
      return [...seen.values()];
    },
    // Whole-instance encounter feed (FHIR search without a patient filter) for
    // the staff coding queue — one call instead of one per patient.
    async getAllEncounters(maxPages = 10) {
      const out = [];
      let path = 'Encounter?_count=200';
      for (let i = 0; i < maxPages && path; i++) {
        const bundle = await fhirGet(path, 'Encounter', null, 'search Encounter (all)');
        out.push(...bundleResources(bundle));
        const next = ((bundle && bundle.link) || []).find(l => l.relation === 'next');
        path = next && next.url ? next.url.replace(/^.*\/fhir\//, '') : null;
      }
      return out;
    },
    async addProblem(puuid, problem) {
      return apiWrite('POST', `patient/${encodeURIComponent(puuid)}/medical_problem`, problem, 'medical_problem', puuid);
    },
    async updateProblem(puuid, problemUuid, problem) {
      return apiWrite('PUT', `patient/${encodeURIComponent(puuid)}/medical_problem/${encodeURIComponent(problemUuid)}`, problem, 'medical_problem', puuid);
    },
    async getProblemRows(puuid) {
      const res = await rawRequest({ method: 'GET', url: apiUrl(`patient/${encodeURIComponent(puuid)}/medical_problem`) });
      const data = expectOk(res, 'read medical_problem');
      logEmrAccess(actor, 'read', 'medical_problem', puuid, {});
      return unwrapApi(data) || [];
    },
    async getMedicationRows(puuid) {
      const pid = await resolvePid(puuid);
      const res = await rawRequest({ method: 'GET', url: apiUrl(`patient/${pid}/medication`) });
      const data = expectOk(res, 'read medication');
      logEmrAccess(actor, 'read', 'medication', puuid, {});
      return unwrapApi(data) || [];
    },
    async addMedication(puuid, med) {
      const pid = await resolvePid(puuid);
      return apiWrite('POST', `patient/${pid}/medication`,
        { ...med, begdate: toEmrDatetime(med.begdate) }, 'medication', puuid);
    },
    async updateMedication(puuid, medUuid, med) {
      const pid = await resolvePid(puuid);
      return apiWrite('PUT', `patient/${pid}/medication/${encodeURIComponent(medUuid)}`,
        { ...med, begdate: toEmrDatetime(med.begdate), enddate: toEmrDatetime(med.enddate) }, 'medication', puuid);
    },
    async addAllergy(puuid, allergy) {
      return apiWrite('POST', `patient/${encodeURIComponent(puuid)}/allergy`,
        { ...allergy, begdate: toEmrDatetime(allergy.begdate) }, 'allergy', puuid);
    },

    // ---- Appointments (Session 4.2) ----
    // OpenEMR is the ONLY appointment ledger. 7.0.4 quirks (verified against
    // the dev instance): every appointment endpoint keys by NUMERIC pid (the
    // POST rejects uuids with "pid must be for a valid patient"), and the API
    // is create/delete only — no PUT/PATCH in any shape, FHIR Appointment is
    // read-only. Reschedule/cancel therefore go through swapAppointment()
    // below (tombstone swap, approved 08/2026).
    async getPractitionerRows() {
      const res = await rawRequest({ method: 'GET', url: apiUrl('practitioner') });
      const data = expectOk(res, 'read practitioner');
      logEmrAccess(actor, 'read', 'practitioner', null, {});
      return unwrapApi(data) || [];
    },
    // Whole-calendar read — the conflict check and the admin unified view both
    // work from this live list (availability is never modeled app-side).
    async listAppointmentRows() {
      const res = await rawRequest({ method: 'GET', url: apiUrl('appointment') });
      const data = expectOk(res, 'read appointment list');
      logEmrAccess(actor, 'read', 'appointment', null, { scope: 'all' });
      return unwrapApi(data) || [];
    },
    async getPatientAppointmentRows(puuid) {
      const pid = await resolvePid(puuid);
      const res = await rawRequest({ method: 'GET', url: apiUrl(`patient/${pid}/appointment`) });
      const data = expectOk(res, 'read patient appointments');
      logEmrAccess(actor, 'read', 'appointment', puuid, {});
      return unwrapApi(data) || [];
    },
    // The LIST endpoints omit pc_hometext / pc_duration / pc_room (verified on
    // 7.0.4) — only this single-row GET returns the full record. Every swap
    // MUST build from it, or the original notes and location marker are lost.
    async getAppointmentRow(puuid, eid) {
      const pid = await resolvePid(puuid);
      const res = await rawRequest({ method: 'GET', url: apiUrl(`patient/${pid}/appointment/${encodeURIComponent(eid)}`) });
      const data = expectOk(res, 'read appointment');
      logEmrAccess(actor, 'read', 'appointment', puuid, { eid: String(eid) });
      const payload = unwrapApi(data);
      return Array.isArray(payload) ? payload[0] || null : payload || null;
    },
    async createAppointmentRow(puuid, fields) {
      const pid = await resolvePid(puuid);
      const row = await apiWrite('POST', `patient/${pid}/appointment`, fields, 'appointment', puuid, 'create appointment');
      const eid = row && (row.id ?? row.pc_eid);
      if (eid == null) throw new OpenEmrError('OpenEMR did not return an appointment id', 502, row);
      return String(eid);
    },
    // Tombstone swap: POST every replacement row FIRST (so a mid-swap failure
    // leaves a visible duplicate, never a lost appointment), then delete the
    // superseded row LAST. A failed tail-delete is reported as a warning, not
    // an error — the replacement rows already stand.
    async swapAppointment(puuid, oldEid, replacements) {
      const pid = await resolvePid(puuid);
      const newEids = [];
      for (const fields of replacements) {
        const row = await apiWrite('POST', `patient/${pid}/appointment`, fields, 'appointment', puuid, 'create appointment (swap)');
        const eid = row && (row.id ?? row.pc_eid);
        if (eid == null) throw new OpenEmrError('OpenEMR did not return an appointment id during swap', 502, row);
        newEids.push(String(eid));
      }
      let deleted = false; let deleteError = null;
      try {
        const res = await rawRequest({ method: 'DELETE', url: apiUrl(`patient/${pid}/appointment/${encodeURIComponent(oldEid)}`) });
        expectOk(res, 'remove superseded appointment');
        deleted = true;
      } catch (e) {
        deleteError = e.message;
      }
      logEmrAccess(actor, 'write', 'appointment', puuid, { op: 'swap', oldEid: String(oldEid), newEids, deleted });
      return { newEids, deleted, deleteError };
    },

    // Signed PDFs and received records → OpenEMR patient Documents. The upload
    // becomes readable through FHIR DocumentReference, which satisfies the
    // "DocumentReference written to OpenEMR" requirement on 7.0.4.
    async uploadPatientDocument(puuid, fileName, buffer, mimeType, categoryPath) {
      const fd = new FormData(); // global (Node 18+)
      fd.append('document', new Blob([buffer], { type: mimeType || 'application/pdf' }), fileName);
      const path = `patient/${encodeURIComponent(puuid)}/document?path=${encodeURIComponent(categoryPath || '/Medical Record')}`;
      const res = await rawRequest({ method: 'POST', url: apiUrl(path), formData: fd });
      const data = expectOk(res, 'upload document');
      logEmrAccess(actor, 'write', 'document', puuid, { fileName });
      return unwrapApi(data);
    }
  };
};

// Connectivity probe for the workspace sync indicator + preflight.
const getStatus = async () => {
  const missing = missingConfig();
  if (missing.length) return { configured: false, connected: false, missing };
  try {
    await getAccessToken();
    const granted = tokenState.grantedScopes || [];
    return {
      configured: true, connected: true, baseUrl: BASE_URL,
      grantedScopeCount: granted.length,
      // 4.2 appointment client swap deployed? (P0 deploy step, spec §1 #15)
      appointmentScopes: granted.includes('user/appointment.read') && granted.includes('user/appointment.write')
    };
  } catch (err) {
    return { configured: true, connected: false, baseUrl: BASE_URL, error: err.message };
  }
};

module.exports = {
  isConfigured,
  missingConfig,
  setActivityLogger,
  forActor,
  getStatus,
  invalidateToken,
  // exported for unit tests
  _internal: { fhirUrl, apiUrl, bundleResources, unwrapApi }
};
