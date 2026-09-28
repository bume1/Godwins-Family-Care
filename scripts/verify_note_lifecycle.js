#!/usr/bin/env node
/**
 * The shared clinical note — HTTP round trip (2026-09-27).
 *
 * Drives the REAL server and the REAL routes: two clinicians editing one note,
 * the version conflict, an RN's author signature, the clinician addendum that
 * makes it billable, co-signatures, carry-forward, attaching a note to an
 * appointment booked afterwards, and discarding a draft. Every assertion reads
 * the STORED rows or the chart BACK — never a status code alone, which is the
 * trap that cost this repo the soap_note, encounter-PUT, allergy and both Phase
 * 6B defects.
 *
 * Stubbed, because none is reachable from a build sandbox: the KV store and the
 * OpenEMR transport. The fake EMR is STATEFUL — encounters, narrative notes,
 * vitals rows, charges and documents are kept and read back — so what is
 * asserted is what the chart would hold.
 *
 * NOT proven here, stated plainly: that OpenEMR 8.4 accepts an in-place PUT of
 * the NARRATIVE soap_note (updateSoapNote is proven live on the structured note
 * already), and that the encounter PUT accepts facility_id / pos_code / date.
 * Run against the deployment to close that half.
 *
 *   node scripts/verify_note_lifecycle.js
 */
process.env.PORT = process.env.PORT || '4611';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'note-lifecycle-verification-secret';
process.env.MFA_ENFORCE = 'false';
process.env.DATA_STORE = 'kv';

const path = require('path');
const Module = require('module');
const bcrypt = require('bcryptjs');

// ---- the store --------------------------------------------------------------
const STORE = new Map();
class MemDb {
  async get(k) { return STORE.has(k) ? JSON.parse(JSON.stringify(STORE.get(k))) : null; }
  async set(k, v) { STORE.set(k, JSON.parse(JSON.stringify(v))); return true; }
  async delete(k) { STORE.delete(k); return true; }
  async list(p) { return [...STORE.keys()].filter(k => !p || k.startsWith(p)); }
  async empty() { STORE.clear(); return true; }
}
const realResolve = Module._resolveFilename;
Module._resolveFilename = function (r, ...rest) {
  if (r === '@replit/database') return '__memdb__';
  return realResolve.call(this, r, ...rest);
};
require.cache['__memdb__'] = { id: '__memdb__', filename: '__memdb__', loaded: true, exports: MemDb };
const rows = (k) => STORE.get(k) || [];

// ---- a stateful fake OpenEMR --------------------------------------------------
const EMR = { seq: 100, encounters: new Map(), soap: new Map(), vitals: [], charges: [], documents: [], encounterUpdates: [], soapUpdates: 0 };
const FACILITIES = [
  { id: '3', name: 'Vinings office', pos_code: '11', service_location: '1', billing_location: '1', primary_business_entity: '1' },
  { id: '5', name: 'Private Residence', pos_code: '12', service_location: '1', billing_location: '0', primary_business_entity: '0' }
];
const APPOINTMENTS = {
  'uuid-note-patient': [
    { pc_eid: '900', pc_eventDate: '2026-09-20', pc_startTime: '10:00:00', pc_endTime: '11:00:00', pc_title: 'Home visit', pc_hometext: '[GFC location=home]', pc_apptstatus: '-', pc_aid: '7' },
    { pc_eid: '901', pc_eventDate: '2026-09-21', pc_startTime: '10:00:00', pc_endTime: '11:00:00', pc_title: 'Cancelled', pc_hometext: '', pc_apptstatus: 'x', pc_aid: '7' }
  ],
  'uuid-other-patient': [
    { pc_eid: '950', pc_eventDate: '2026-09-20', pc_startTime: '09:00:00', pc_endTime: '10:00:00', pc_title: 'Someone else', pc_hometext: '', pc_apptstatus: '-', pc_aid: '7' }
  ]
};
const openemr = require(path.join(__dirname, '..', 'openemr.js'));
openemr.isConfigured = () => true;
openemr.forActor = () => new Proxy({}, {
  get(_t, prop) {
    switch (prop) {
      case 'createEncounter': return async (puuid, fields) => {
        const eid = String(++EMR.seq); const euuid = `enc-${eid}`;
        EMR.encounters.set(euuid, { puuid, eid, ...fields });
        return { euuid, eid };
      };
      case 'getEncounterRow': return async (puuid, euuid) => {
        const e = EMR.encounters.get(euuid); if (!e) return null;
        const f = FACILITIES.find(x => x.id === String(e.facility_id));
        return { eid: e.eid, date: e.date, reason: e.reason, pos_code: e.pos_code || null, facility_id: e.facility_id || null, facility_name: f ? f.name : null };
      };
      case 'updateEncounter': return async (puuid, euuid, fields) => {
        EMR.encounterUpdates.push({ euuid, fields });
        Object.assign(EMR.encounters.get(euuid), fields);
        return {};
      };
      case 'addSoapNote': return async (puuid, euuid, note) => {
        const sid = String(++EMR.seq); EMR.soap.set(sid, { id: sid, euuid, ...note }); return { sid };
      };
      case 'updateSoapNote': return async (puuid, euuid, sid, note) => {
        if (!EMR.soap.has(String(sid))) throw new Error('no such soap_note');
        EMR.soapUpdates++; EMR.soap.set(String(sid), { id: String(sid), euuid, ...note }); return {};
      };
      case 'getSoapNote': return async (puuid, euuid, sid) => EMR.soap.get(String(sid)) || null;
      case 'getSoapNotes': return async (puuid, euuid) => [...EMR.soap.values()].filter(n => n.euuid === euuid);
      case 'addVitals': return async (puuid, euuid, v) => { EMR.vitals.push({ euuid, ...v }); return {}; };
      case 'postCharge': return async (puuid, euuid, p) => { const id = String(++EMR.seq); EMR.charges.push({ id, euuid, ...p }); return { id }; };
      case 'uploadPatientDocument': return async (puuid, fileName, buffer) => { EMR.documents.push({ puuid, fileName, bytes: buffer.length, head: buffer.slice(0, 5).toString() }); return true; };
      case 'getFacilities': return async () => FACILITIES;
      case 'getPatientAppointmentRows': return async (puuid) => APPOINTMENTS[puuid] || [];
      case 'getEncounters': return async () => { throw new Error('FHIR encounter list not stubbed — the app degrades to its own records'); };
      default:
        if (/^get/.test(String(prop))) return async () => [];
        return async () => { throw new Error(`openemr.${String(prop)} not stubbed`); };
    }
  }
});

// ---- the world -------------------------------------------------------------
const config = require(path.join(__dirname, '..', 'config.js'));
const BASE = `http://127.0.0.1:${process.env.PORT}`;
const PW = 'Probe12345!';
let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { pass++; console.log(`  ✅ ${n}`); } else { fail++; console.log(`  ❌ ${n}${d !== undefined ? ` — ${typeof d === 'string' ? d : JSON.stringify(d).slice(0, 400)}` : ''}`); } };
const call = async (m, u, t, b) => {
  const r = await fetch(`${BASE}${u}`, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: `Bearer ${t}` } : {}) }, body: b ? JSON.stringify(b) : undefined });
  let j = null; try { j = await r.json(); } catch (_) {}
  return { status: r.status, body: j };
};
const login = async (email) => { const r = await call('POST', '/api/auth/login', null, { email, password: PW }); return r.body && r.body.token; };
const record = (euuid) => rows('encounter_billing').find(r => r.encounterUuid === euuid);
const narrative = (euuid) => { const r = record(euuid); return r && r.narrativeNoteSid ? EMR.soap.get(String(r.narrativeNoteSid)) : null; };
const narrativeText = (euuid) => { const n = narrative(euuid); return n ? [n.subjective, n.objective, n.assessment, n.plan].join('\n') : ''; };

const staff = (id, name, clinicalRole, licenseLevel, extra = {}) => ({
  id, name: `${name} (TEST DATA)`, email: `${id}@example.test`, role: 'user', clinicalRole, licenseLevel,
  hasClinicalAccess: clinicalRole !== 'readOnly', npi: clinicalRole === 'provider' ? '1234567893' : null,
  openEmrProviderId: clinicalRole === 'provider' ? '7' : null, accountStatus: 'active', ...extra
});
const PATIENT = {
  id: 'c_note', role: config.ROLES.CLIENT, email: 'c_note@example.test', name: 'Note Probe Patient (TEST DATA)',
  slug: 'note-probe', serviceLine: 'IHPC', enrollmentStatus: 'enrolled', openEmrPatientId: 'uuid-note-patient',
  openEmrFacilityId: '5', usualLocation: 'home', intake: { dob: '1948-03-11' }
};
const OTHER = { ...PATIENT, id: 'c_other', email: 'c_other@example.test', name: 'Other Patient (TEST DATA)', slug: 'other', openEmrPatientId: 'uuid-other-patient' };
const RN = staff('rn_1', 'Ruth Nolan', 'rn', 'RN');
const FNP = staff('fnp_1', 'Bethel Godwins', 'provider', 'FNP');
const LCSW = staff('lcsw_1', 'Lena Cole', 'lcsw', 'LCSW');
const LMSW = staff('lmsw_1', 'Mara Shaw', 'lmsw', 'LMSW');
const CM = staff('cm_1', 'Casey Reed', 'readOnly', null, { role: 'caseManager', hasClinicalAccess: false });

// Formatted markup, the way the editor stores it.
const HP_NOTE = {
  kind: 'hp', visit: { appointmentType: 'pc_new_patient', modality: 'in_person', location: 'home' },
  chiefConcern: '**Fall** at home', subjective: '## History\n- dizzy for _two days_\n- __no__ head strike',
  assessment: 'Orthostatic hypotension, likely', plan: '1. Hold diuretic\n2. Recheck BP in **48h**',
  vitals: { bpRightSys: '118', bpRightDia: '70', hr: '88' }, hp: { systemsExam: { general: 'Alert, oriented' } }
};

(async () => {
  const hash = await bcrypt.hash(PW, 4);
  STORE.set('users', [PATIENT, OTHER, RN, FNP, LCSW, LMSW, CM].map(u => ({ ...u, password: hash })));
  STORE.set('gfc_payer_credentialing', { billing_npi_used: '1234567893', billing_provider_name: 'GFC' });
  const fresh = new Date().toISOString();
  STORE.set('gfc_ncci_source_version', { ptp: { quarter: '2026Q4', loadedAt: fresh }, mue: { quarter: '2026Q4', loadedAt: fresh } });

  require(path.join(__dirname, '..', 'server.js'));
  await new Promise(r => setTimeout(r, 3000));
  const tok = {};
  for (const [k, u] of Object.entries({ rn: RN, fnp: FNP, lcsw: LCSW, lmsw: LMSW, cm: CM })) tok[k] = await login(u.email);
  if (!tok.rn || !tok.fnp || !tok.lmsw) { console.log('LOGIN FAILED', tok); process.exit(1); }
  const P = `/api/clinical/patients/${PATIENT.id}`;

  console.log('\n── 1. Save draft writes the app AND OpenEMR in one action ──');
  let r = await call('POST', `${P}/notes`, tok.rn, { note: HP_NOTE });
  check('the RN\'s first save creates the note', r.status === 200, r.body);
  const hp = r.body && r.body.encounterUuid;
  check('an encounter now exists in OpenEMR', !!hp && EMR.encounters.has(hp));
  check('the note is stored on its encounter at version 1', record(hp) && record(hp).noteVersion === 1 && record(hp).note.chiefConcern === '**Fall** at home');
  check('the narrative is in OpenEMR', !!narrative(hp));
  // The H&P's "What kind of visit is this?" picker was never sent before this
  // change, so every note's visit type was empty. It must reach the record.
  check('the visit picked at the top of the note is stored', record(hp).note.visit && record(hp).note.visit.appointmentType === 'pc_new_patient' && record(hp).visit && record(hp).visit.appointmentType === 'pc_new_patient', { note: record(hp).note.visit, visit: record(hp).visit });
  const text1 = narrativeText(hp);
  check('OpenEMR text keeps the structure (bullets, capital heading, numbers)', /• dizzy for two days/.test(text1) && /HISTORY/.test(text1) && /1\. Hold diuretic/.test(text1), text1.slice(0, 300));
  check('OpenEMR text carries no formatting markers', !/\*\*|__|_two/.test(text1), text1.slice(0, 300));
  check('the save is stamped with its editor and time', /v1 {2}Ruth Nolan \(TEST DATA\), RN — /.test(text1));
  check('a revision row names the editor, never the text', (() => { const rv = rows('clinical_note_revisions').filter(x => x.encounterUuid === hp); return rv.length === 1 && rv[0].savedBy.id === RN.id && !JSON.stringify(rv[0]).includes('dizzy'); })());
  check('nothing was signed and no vitals row was written yet', !rows('encounter_attestations').length && EMR.vitals.length === 0);

  console.log('\n── 2. A second clinician edits the SAME note ──');
  r = await call('GET', `${P}/encounters/${hp}/note`, tok.fnp);
  check('the FNP reads the RN\'s draft at version 1', r.status === 200 && r.body.version === 1 && r.body.status === 'draft', r.body);
  const sidBefore = record(hp).narrativeNoteSid;
  r = await call('PUT', `${P}/encounters/${hp}/note`, tok.fnp, { note: { ...HP_NOTE, assessment: 'Orthostatic hypotension — **confirmed** on standing' }, baseVersion: 1 });
  check('the FNP\'s save is accepted', r.status === 200, r.body);
  check('the note is now version 2 with the FNP\'s text', record(hp).noteVersion === 2 && /confirmed/.test(record(hp).note.assessment));
  check('OpenEMR\'s narrative was UPDATED IN PLACE, not duplicated', record(hp).narrativeNoteSid === sidBefore && EMR.soapUpdates >= 1 && [...EMR.soap.values()].filter(n => n.euuid === hp && !/^\[GFC STRUCTURED/.test(n.subjective)).length === 1);
  check('the history names both editors', /Ruth Nolan/.test(narrativeText(hp)) && /Bethel Godwins/.test(narrativeText(hp)));
  check('the revision row says which section changed', (() => { const rv = rows('clinical_note_revisions').filter(x => x.encounterUuid === hp); return rv[1] && rv[1].sectionsChanged.includes('assessment') && rv[1].sectionsChanged.length === 1; })());

  console.log('\n── 3. The last save does NOT silently win ──');
  r = await call('PUT', `${P}/encounters/${hp}/note`, tok.rn, { note: { ...HP_NOTE, assessment: 'RN overwrite attempt' }, baseVersion: 1 });
  check('a save made against version 1 is refused', r.status === 409 && r.body.code === 'NOTE_CHANGED', r.body);
  check('the refusal names who saved first', r.body && r.body.lastSavedBy && /Bethel Godwins/.test(r.body.lastSavedBy.name));
  check('the refusal hands back their version', r.body && r.body.note && /confirmed/.test(r.body.note.assessment));
  check('the stored note is untouched', /confirmed/.test(record(hp).note.assessment) && record(hp).noteVersion === 2);

  console.log('\n── 4. An RN signs as AUTHOR — locked, not billable ──');
  r = await call('POST', `${P}/encounters/${hp}/sign`, tok.rn, { attest: true });
  check('an H&P without both arms is refused at SIGN (not at save)', r.status === 409 && r.body.code === 'HP_BP_BOTH_ARMS', r.body);
  r = await call('PUT', `${P}/encounters/${hp}/note`, tok.rn, { note: { ...HP_NOTE, assessment: record(hp).note.assessment, vitals: { ...HP_NOTE.vitals, bpLeftSys: '112', bpLeftDia: '68' } }, baseVersion: 2 });
  check('the RN adds the left-arm BP', r.status === 200 && record(hp).noteVersion === 3, r.body);
  // The section gate read a field nothing wrote, so a New Patient note could
  // never be signed. It is derived from the note now — and it NAMES what is
  // outstanding rather than counting it.
  r = await call('POST', `${P}/encounters/${hp}/sign`, tok.rn, { attest: true });
  check('a New Patient note is refused until its sections are written, and they are named', r.status === 409 && r.body.code === 'SIGN_NOTE_SECTIONS_INCOMPLETE' && /Social History/.test(r.body.error) && !/Chief Complaint|Assessment/.test(r.body.error), r.body);
  const SECTIONS = { pmhSurgical: 'HTN, CKD3', socialHistory: 'Lives alone; daughter visits daily', medReconciliation: 'Reconciled against the bottles', allergies: 'NKDA', followUp: 'Two weeks', mdmOrTime: 'Moderate MDM' };
  r = await call('PUT', `${P}/encounters/${hp}/note`, tok.rn, { note: { ...record(hp).note, sections: SECTIONS }, baseVersion: 3 });
  check('the RN writes the remaining sections', r.status === 200 && record(hp).noteVersion === 4, r.body);
  r = await call('POST', `${P}/encounters/${hp}/sign`, tok.rn, { attest: true });
  check('the RN signs — no codes needed for an author signature', r.status === 200, r.body);
  check('it is held: awaiting clinician addendum, nothing billed', record(hp).coSignStatus === 'pending' && EMR.charges.length === 0);
  check('the vitals row was written ONCE, at signing', EMR.vitals.filter(v => v.euuid === hp).length === 1);
  check('the signature is IN the note, marked author', /ELECTRONICALLY SIGNED/.test(narrativeText(hp)) && /Ruth Nolan \(TEST DATA\), RN — AUTHOR \(not a billing signature\)/.test(narrativeText(hp)), narrativeText(hp).slice(-500));
  check('the formatted signed PDF was filed to OpenEMR Documents', EMR.documents.some(d => /^Clinical_Note_/.test(d.fileName) && d.head === '%PDF-'));
  r = await call('PUT', `${P}/encounters/${hp}/note`, tok.fnp, { note: HP_NOTE, baseVersion: 4 });
  check('the note is locked after signing', r.status === 409 && r.body.code === 'ENCOUNTER_CLOSED', r.body);
  const inbox = await call('GET', '/api/clinical/inbox', tok.fnp);
  const item = inbox.body && (inbox.body.items || []).find(i => i.encounterUuid === hp);
  check('it reaches the FNP\'s inbox as actionable', item && item.actionable === true && /addendum/i.test(item.detail || ''), item);

  console.log('\n── 5. The clinician addendum is the billable signature ──');
  r = await call('PUT', `${P}/encounters/${hp}/coding`, tok.fnp, { diagnoses: [{ code: 'I95.1', description: 'Orthostatic hypotension' }], services: [{ code: '99345', dxLinks: ['I95.1'] }] });
  check('the FNP can still CODE a note awaiting their addendum', r.status === 200, r.body);
  r = await call('PUT', `${P}/encounters/${hp}/coding`, tok.rn, { diagnoses: [{ code: 'I10' }], services: [] });
  check('the author cannot recode a locked note', r.status === 409 || r.status === 403, r.body);
  r = await call('POST', `${P}/encounters/${hp}/co-sign`, tok.rn, { attest: true, text: 'Self review' });
  check('an RN cannot add the billable addendum', r.status === 403 && r.body.code === 'CO_SIGN_CREDENTIAL', r.body);
  r = await call('POST', `${P}/encounters/${hp}/co-sign`, tok.fnp, { attest: true, text: '' });
  check('the addendum needs text', r.status === 400, r.body);
  r = await call('POST', `${P}/encounters/${hp}/co-sign`, tok.lcsw, { attest: true, text: 'Reviewed' });
  check('an LCSW cannot bill an E/M note', r.status === 403 && r.body.code === 'CLINICAL_CODE_SET', r.body);
  r = await call('POST', `${P}/encounters/${hp}/co-sign`, tok.fnp, { attest: true, text: 'Seen with the RN. I agree with the **assessment**; hold the diuretic.' });
  check('the FNP adds the clinician addendum', r.status === 200, r.body);
  check('the FNP is now the rendering clinician', record(hp).renderingProvider && record(hp).renderingProvider.id === FNP.id && record(hp).coSignStatus === 'cleared');
  check('charges posted on the addendum, once', EMR.charges.filter(c => c.euuid === hp).length === 1);
  check('the addendum is stored as the clinician addendum', rows('encounter_addenda').some(a => a.encounterUuid === hp && a.kind === 'clinician_addendum' && a.by.id === FNP.id));
  check('both signatures are in the note', /Clinician addendum and billing signature: Bethel Godwins \(TEST DATA\), FNP \(NPI 1234567893\)/.test(narrativeText(hp)));
  check('the PDF was re-filed with the addendum', EMR.documents.filter(d => /^Clinical_Note_/.test(d.fileName)).length >= 2);

  console.log('\n── 6. Co-signatures: any licensed clinician, never billing ──');
  r = await call('POST', `${P}/encounters/${hp}/co-signatures`, tok.lmsw, { attest: true });
  check('an LMSW co-signs', r.status === 200, r.body);
  check('the co-signature is in the note', /Co-signed by Mara Shaw \(TEST DATA\), LMSW/.test(narrativeText(hp)));
  check('and it did not change who bills', record(hp).renderingProvider.id === FNP.id && EMR.charges.filter(c => c.euuid === hp).length === 1);
  r = await call('POST', `${P}/encounters/${hp}/co-signatures`, tok.lmsw, { attest: true });
  check('one co-signature per person', r.status === 409 && r.body.code === 'CO_SIGN_DUPLICATE', r.body);
  r = await call('POST', `${P}/encounters/${hp}/co-signatures`, tok.rn, { attest: true });
  check('the signer cannot co-sign their own note', r.status === 409 && r.body.code === 'CO_SIGN_SELF', r.body);
  r = await call('POST', `${P}/encounters/${hp}/co-signatures`, tok.cm, { attest: true });
  check('read-only staff cannot co-sign', r.status === 403, r.body);
  r = await call('POST', `${P}/encounters/${hp}/co-signatures`, tok.lcsw, { attest: true });
  check('a second clinician co-signs too', r.status === 200 && (record(hp).coSignatures || []).length === 2, r.body);

  console.log('\n── 7. Carry forward — the whole note but vitals, held for review ──');
  r = await call('GET', `${P}/notes/carry-forward-sources`, tok.fnp);
  check('the signed H&P is offered as a source', r.status === 200 && r.body.sources.some(s => s.encounterUuid === hp), r.body);
  r = await call('GET', `${P}/encounters/${hp}/note/carry-forward`, tok.fnp);
  const carried = r.body && r.body.content;
  check('the content carries the exam and the assessment', carried && carried.hp.systemsExam && /confirmed/.test(carried.assessment), r.body);
  check('and never the vitals or a signature', carried && !Object.keys(carried.vitals || {}).length && !/ELECTRONICALLY SIGNED|NOTE HISTORY/.test(JSON.stringify(carried)));
  r = await call('POST', `${P}/notes`, tok.fnp, { note: { ...carried, kind: 'followup' }, carryForwardFrom: hp });
  const cf = r.body && r.body.encounterUuid;
  check('a new note is started from it', r.status === 200 && !!cf, r.body);
  check('every carried field is pending review', r.body && r.body.carriedPending.includes('assessment') && r.body.carriedPending.includes('hp.systemsExam'), r.body && r.body.carriedPending);
  r = await call('PUT', `${P}/encounters/${cf}/coding`, tok.fnp, { diagnoses: [{ code: 'I95.1' }], services: [{ code: '99349', dxLinks: ['I95.1'] }] });
  r = await call('POST', `${P}/encounters/${cf}/sign`, tok.fnp, { attest: true });
  check('it cannot be signed while carried text is unreviewed', r.status === 409 && r.body.code === 'NOTE_CARRIED_FORWARD_UNREVIEWED', r.body);
  const pendingNow = record(cf).note.carriedForward ? Object.keys(record(cf).note.carriedForward.fields) : [];
  r = await call('PUT', `${P}/encounters/${cf}/note`, tok.fnp, {
    note: { ...record(cf).note, assessment: 'Improving on standing today' }, baseVersion: 1,
    confirmCarried: pendingNow.filter(k => k !== 'assessment')
  });
  check('editing one field and confirming the rest clears the hold', r.status === 200 && r.body.carriedPending.length === 0, r.body && r.body.carriedPending);
  r = await call('POST', `${P}/encounters/${cf}/sign`, tok.fnp, { attest: true });
  check('the FNP signs it directly — billable at once', r.status === 200 && record(cf).coSignStatus === 'not_required' && EMR.charges.some(c => c.euuid === cf), r.body);

  console.log('\n── 8. Attach a note to an appointment booked afterwards ──');
  r = await call('POST', `${P}/notes`, tok.rn, { note: { kind: 'followup', chiefConcern: 'Unscheduled wound check', subjective: 'Called in' } });
  const un = r.body && r.body.encounterUuid;
  check('an unscheduled note is saved with no appointment', r.status === 200 && !rows('appointment_encounters').some(l => l.encounterUuid === un), r.body);
  r = await call('PUT', `${P}/encounters/${un}/appointment`, tok.rn, { appointmentEid: '950' });
  check('another patient\'s appointment is refused', r.status === 400 && r.body.code === 'APPT_PATIENT_MISMATCH', r.body);
  r = await call('PUT', `${P}/encounters/${un}/appointment`, tok.rn, { appointmentEid: '901' });
  check('a cancelled appointment is refused', r.status === 409 && r.body.code === 'APPT_NOT_ATTACHABLE', r.body);
  r = await call('PUT', `${P}/encounters/${un}/appointment`, tok.rn, { appointmentEid: '900' });
  check('the note attaches to the appointment', r.status === 200, r.body);
  check('the link is stored', rows('appointment_encounters').some(l => l.encounterUuid === un && l.eid === '900'));
  check('the encounter took the appointment\'s date and place of service', EMR.encounters.get(un).date === '2026-09-20' && EMR.encounters.get(un).pos_code === '12' && record(un).date === '2026-09-20');
  r = await call('GET', `${P}/appointments`, tok.rn);
  check('the appointment now reads documented', r.status === 200 && (r.body.appointments || []).some(a => String(a.eid) === '900' && a.encounterUuid === un && a.state === 'documented'), (r.body.appointments || []).map(a => [a.eid, a.state, a.encounterUuid]));
  r = await call('POST', `${P}/notes`, tok.rn, { note: { kind: 'followup', chiefConcern: 'Second note' } });
  const second = r.body.encounterUuid;
  r = await call('PUT', `${P}/encounters/${second}/appointment`, tok.rn, { appointmentEid: '900' });
  check('an appointment cannot take two notes', r.status === 409 && r.body.code === 'APPT_ALREADY_DOCUMENTED', r.body);
  r = await call('PUT', `${P}/encounters/${hp}/appointment`, tok.fnp, { appointmentEid: '900' });
  check('a signed note cannot be attached (owner rule)', r.status === 409 && r.body.code === 'ENCOUNTER_CLOSED', r.body);

  console.log('\n── 9. Discarding a saved draft ──');
  r = await call('POST', `${P}/encounters/${second}/note/void`, tok.rn, { reason: '' });
  check('a discard needs a reason', r.status === 400, r.body);
  r = await call('POST', `${P}/encounters/${second}/note/void`, tok.rn, { reason: 'Started on the wrong patient visit' });
  check('the draft is discarded', r.status === 200 && record(second).noteStatus === 'voided', r.body);
  check('OpenEMR says so in words', /Draft discarded by Ruth Nolan/.test(narrativeText(second)));
  r = await call('POST', `${P}/encounters/${second}/sign`, tok.fnp, { attest: true });
  check('a discarded draft cannot be signed', r.status === 409 && r.body.code === 'NOTE_VOIDED', r.body);
  r = await call('GET', '/api/clinical/work-queues', tok.fnp);
  const unsigned = r.body && (r.body.unsignedEncounters || (r.body.queues && r.body.queues.unsignedEncounters));
  check('the work queue loads and lists the open drafts', r.status === 200 && Array.isArray(unsigned) && unsigned.some(q => q.encounterUuid === un), { status: r.status, keys: r.body && Object.keys(r.body) });
  check('and the discarded one waits on nobody', Array.isArray(unsigned) && !unsigned.some(q => q.encounterUuid === second));

  console.log('\n── 10. Who may write a note at all ──');
  r = await call('POST', `${P}/notes`, tok.lmsw, { note: { kind: 'followup', chiefConcern: 'Psychosocial check-in' } });
  check('an LMSW writes a note', r.status === 200, r.body);
  const lm = r.body.encounterUuid;
  r = await call('POST', `${P}/encounters/${lm}/sign`, tok.lmsw, { attest: true });
  check('and signs it as author — held for a clinician addendum', r.status === 200 && record(lm).coSignStatus === 'pending', r.body);
  r = await call('POST', `${P}/notes`, tok.cm, { note: { kind: 'followup', chiefConcern: 'x' } });
  check('read-only staff cannot write a note', r.status === 403, r.body);
  r = await call('POST', `${P}/notes`, tok.rn, { note: { kind: 'followup', chiefConcern: '<script>alert(1)</script>' } });
  check('typed HTML is stored as text and reaches OpenEMR as text', r.status === 200 && narrativeText(r.body.encounterUuid).includes('<script>alert(1)</script>'));

  console.log('\n── 11. Vitals: an older note opened by another user, and a draft\'s vitals in the chart ──');
  // A note filed with the old buttons: an encounter, an OpenEMR narrative and
  // a billing record with no app copy of the note. Its vitals row was written
  // at filing, the old way.
  const legacyEuuid = 'enc-legacy-1';
  EMR.encounters.set(legacyEuuid, { puuid: PATIENT.openEmrPatientId, eid: '777', date: '2026-09-26', reason: 'Initial visit' });
  EMR.soap.set('7771', { id: '7771', euuid: legacyEuuid,
    subjective: '[GFC CLINICIAN] Ruth Nolan, RN\n\nNew to the practice',
    objective: 'VITALS — BP right arm 132/82; BP left arm 128/80; HR 76; Temp 98.4; RR 16; SpO2 97; Wt 160; Ht 66\n\nSYSTEMS EXAM:\nGeneral: Alert\nLung Sounds: Clear',
    assessment: 'Stable', plan: 'Return in two weeks\nDocumented by Ruth Nolan' });
  STORE.set('encounter_billing', rows('encounter_billing').concat([{
    id: 'bill-legacy', clientId: PATIENT.id, puuid: PATIENT.openEmrPatientId, encounterUuid: legacyEuuid, encounterEid: '777',
    date: '2026-09-26', narrativeNoteSid: '7771', diagnoses: [], services: [], createdAt: '2026-09-26T14:00:00.000Z'
  }]));
  r = await call('GET', `${P}/encounters/${legacyEuuid}/note`, tok.fnp);
  check('another clinician opens the older note and sees its vitals', r.status === 200 && r.body.note && r.body.note.vitals.bpRightSys === '132' && r.body.note.vitals.bpLeftSys === '128' && r.body.note.vitals.hr === '76', r.body && r.body.note);
  check('it opens as an H&P, exam in its box', r.body.note.kind === 'hp' && r.body.note.hp.systemsExam && r.body.note.hp.systemsExam.lungSounds === 'Clear', r.body.note);
  const seededNote = r.body.note;
  r = await call('PUT', `${P}/encounters/${legacyEuuid}/note`, tok.fnp, { note: { ...seededNote, assessment: 'Stable — reviewed' }, baseVersion: 0 });
  check('their save is accepted', r.status === 200, r.body);
  check('the OpenEMR note still carries the vitals after the save', /VITALS — BP right arm 132\/82; BP left arm 128\/80; HR 76/.test(narrativeText(legacyEuuid)), narrativeText(legacyEuuid).slice(0, 300));
  check('the readings filed the old way are remembered', record(legacyEuuid).legacyVitals && record(legacyEuuid).legacyVitals.bpRightSys === '132');

  r = await call('GET', `${P}/chart`, tok.rn);
  const drafts = (r.body && r.body.draftVitals) || [];
  check('the chart shows the unsigned note\'s vitals, marked draft', r.status === 200 && drafts.some(d => d.encounterUuid === legacyEuuid && d.draft === true && /132\/82/.test(d.value)), { status: r.status, drafts });
  check('a signed note\'s vitals are not shown as a draft', !drafts.some(d => d.encounterUuid === hp || d.encounterUuid === cf));
  r = await call('GET', `${P}/pre-visit`, tok.rn);
  const lv = r.body && r.body.packet && r.body.packet.lastVitals;
  check('"Last vitals" shows the draft readings too', r.status === 200 && lv && lv.draft === true && /Blood pressure right 132\/82/.test(lv.value), { status: r.status, lv });

  const vitalsBefore = EMR.vitals.filter(v => v.euuid === legacyEuuid).length;
  r = await call('POST', `${P}/encounters/${legacyEuuid}/sign`, tok.rn, { attest: true });
  check('the older note is signed', r.status === 200, r.body);
  check('its unchanged vitals are NOT sent to OpenEMR a second time', EMR.vitals.filter(v => v.euuid === legacyEuuid).length === vitalsBefore && !!record(legacyEuuid).vitalsWrittenAt);
  r = await call('GET', `${P}/chart`, tok.rn);
  check('once signed, it leaves the draft list', !((r.body && r.body.draftVitals) || []).some(d => d.encounterUuid === legacyEuuid));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
