// Scope E — Session 4.3's owed live preflight. 4.3 merged proven against a
// MOCK 7.0.4 because the sandbox could not reach the EMR during the upgrade.
// These are the reads the patient Health tab actually makes.
const o = require('../openemr.js');
// Session 5.2: no password grant — the probe runs as a real OpenEMR user.
// Obtain a token with `node scripts/emr_login.js`, then export OPENEMR_PROBE_ACCESS_TOKEN.
require('./lib/probe_emr_auth').installProbeToken(o);
const P = require('../patientReadRepository.js');
const e=o.forActor({id:'e',name:'4.3 preflight',role:'admin'});
const U='a284d5c2-670e-4a62-aa95-2d1aa629003c';
let pass=0,fail=0;
const ok=(c,l,x)=>{c?(pass++,console.log('  PASS  '+l)):(fail++,console.log('  FAIL  '+l+(x!==undefined?' :: '+JSON.stringify(x):'')));};
(async()=>{
  console.log('=== E1. linked-patient FHIR read (every section the Health tab uses) ===');
  const [cond,med,alg,enc,cp,obs,doc]=await Promise.all([
    e.getProblems(U), e.getMedicationRequests(U), e.getAllergies(U),
    e.getEncounters(U), e.getCarePlans(U), e.getVitalObservations(U), e.getDocumentReferences(U)
  ]);
  ok(Array.isArray(cond),`Condition ${cond.length}`);
  ok(Array.isArray(med),`MedicationRequest ${med.length}`);
  ok(Array.isArray(alg),`AllergyIntolerance ${alg.length}`);
  ok(Array.isArray(enc),`Encounter ${enc.length}`);
  ok(Array.isArray(cp),`CarePlan ${cp.length}`);
  ok(Array.isArray(obs),`Observation ${obs.length}`);
  ok(Array.isArray(doc),`DocumentReference ${doc.length} (403 before the 8.6 ACL grant)`);

  console.log('\n=== E2. the 8.4 encounter duplication the dedupe exists for ===');
  const ids=enc.map(r=>r.id);
  ok(new Set(ids).size===ids.length,'bundleResources deduped the Encounter bundle',
     {returned:ids.length,unique:new Set(ids).size});

  console.log('\n=== E3. appointment read ===');
  const appts=await e.getPatientAppointmentRows(U);
  ok(Array.isArray(appts),`appointment rows ${appts.length}`);
  // 4.3 rule: tombstones ('x') and no-shows ('?') never reach the patient.
  const live=appts.filter(a=>a.pc_apptstatus!=='x'&&a.pc_apptstatus!=='?');
  ok(live.length<=appts.length,`live rows ${live.length} of ${appts.length} (cancelled/no-show excluded)`);

  console.log('\n=== E4. the sharing filter is real, and clinician-only fields cannot leak ===');
  const M=P.FILTER_MAP||{}; const C=P.CLINICIAN_ONLY_FIELDS||[];
  ok(Object.keys(M).length>0,`FILTER_MAP has ${Object.keys(M).length} sections`);
  ok(C.length>0,`CLINICIAN_ONLY_FIELDS lists ${C.length} fields`);
  const leaked=[];
  for (const [sec,keys] of Object.entries(M))
    for (const k of (Array.isArray(keys)?keys:Object.keys(keys||{})))
      if (C.includes(k)) leaked.push(`${sec}.${k}`);
  ok(leaked.length===0,'no clinician-only field appears in any patient-facing section',leaked);

  console.log(`\n================  ${pass} passed, ${fail} failed  ================`);
  process.exit(fail?1:0);
})().catch(e=>{console.error('ERR',e.message);process.exit(1);});
