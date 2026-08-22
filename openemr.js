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

const isConfigured = () => !!(BASE_URL && config.OPENEMR.CLIENT_ID && config.OPENEMR.CLIENT_SECRET &&
  config.OPENEMR.API_USERNAME && config.OPENEMR.API_PASSWORD);

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
let tokenState = { accessToken: null, refreshToken: null, expiresAt: 0 };
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
    expiresAt: Date.now() + (Math.max(120, data.expires_in || 3600) - 60) * 1000
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
const invalidateToken = () => { tokenState = { accessToken: null, refreshToken: null, expiresAt: 0 }; };

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

// Flatten a FHIR searchset Bundle to its resources.
const bundleResources = (bundle) =>
  ((bundle && bundle.entry) || []).map(e => e.resource).filter(Boolean);

// OpenEMR 7.0.4 endpoint quirks (verified against the dev instance):
//  - medical_problem.begdate: plain YYYY-MM-DD
//  - allergy.begdate: datetime "YYYY-MM-DD 00:00:00"
//  - medication endpoints: numeric pid, NOT the patient uuid
const toEmrDatetime = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || '')) ? `${d} 00:00:00` : d;

// uuid → numeric pid cache (a pointer, not clinical data; in-memory only)
const pidCache = new Map();

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
      const puuid = data && data.id;
      logEmrAccess(actor, 'write', 'Patient', puuid, { op: 'create' });
      return data;
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
      return row;
    },
    async addVitals(puuid, encounterUuid, vitals) {
      return apiWrite('POST', `patient/${encodeURIComponent(puuid)}/encounter/${encodeURIComponent(encounterUuid)}/vital`, vitals, 'vital', puuid);
    },
    async addSoapNote(puuid, encounterUuid, note) {
      return apiWrite('POST', `patient/${encodeURIComponent(puuid)}/encounter/${encodeURIComponent(encounterUuid)}/soap_note`, note, 'soap_note', puuid);
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
  if (!isConfigured()) return { configured: false, connected: false };
  try {
    await getAccessToken();
    return { configured: true, connected: true, baseUrl: BASE_URL };
  } catch (err) {
    return { configured: true, connected: false, baseUrl: BASE_URL, error: err.message };
  }
};

module.exports = {
  isConfigured,
  setActivityLogger,
  forActor,
  getStatus,
  invalidateToken,
  // exported for unit tests
  _internal: { fhirUrl, apiUrl, bundleResources, unwrapApi }
};
