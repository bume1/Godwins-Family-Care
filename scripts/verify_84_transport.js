// Session 4.5 — live verification of the 8.4 native writes and the Phase 6B
// routes, through the app's own openemr.js transport.
//
// Run it the way Phase 6B's acceptance.js is run: credentials from the
// environment, nothing read from a file, TEST DATA only. It writes a
// prescription, an encounter reason, a charge (then voids it) and an order to
// the TEST patient. Never point it at a real patient.
//
//   OPENEMR_BASE_URL=… OPENEMR_CLIENT_ID=… OPENEMR_CLIENT_SECRET=… \
//   OPENEMR_PROBE_ACCESS_TOKEN=… (from scripts/emr_login.js) node scripts/verify_84_transport.js
//
// It asserts STORED VALUES read back, never status codes. The charge block in
// particular re-checks the defect that took Phase 6B three runs to catch: a
// loop reusing the variable holding the CPT, so the charge billed the
// diagnosis. That returns 201 and looks right in Billing Manager; it surfaces
// weeks later as a denial. Hence "stored code is the CPT, not a diagnosis" and
// "CPT did NOT leak into the diagnosis pointers" as separate assertions.
//
// Result on 2026-09-08 against the live instance: 23/23.
const o=require('../openemr.js');
// Session 5.2: no password grant — the probe runs as a real OpenEMR user.
// Obtain a token with `node scripts/emr_login.js`, then export OPENEMR_PROBE_ACCESS_TOKEN.
require('./lib/probe_emr_auth').installProbeToken(o);
const e=o.forActor({id:'4.5probe',name:'4.5 probe',role:'admin'});
const U='a284d5c2-670e-4a62-aa95-2d1aa629003c';
let pass=0,fail=0;
const ok=(c,l,x)=>{c?(pass++,console.log('  PASS  '+l)):(fail++,console.log('  FAIL  '+l+(x!==undefined?' :: '+JSON.stringify(x):'')));};
(async()=>{
  const encs=await e.getEncounters(U); const euuid=encs[0].id;
  const provs=await e.getPractitionerRows();
  const PROV=Number((provs.find(p=>p.id)||{}).id);
  console.log(`encounter ${euuid}   provider_id ${PROV}\n`);

  console.log('=== A1. prescription (native 8.4 write) ===');
  const drug='TEST DATA metformin '+Date.now();
  const rx=await e.createPrescription(U,{drug,dosage:'500 mg',quantity:'60',route:'oral',interval:'BID',note:'4.5 probe'});
  const list=await e.getPrescriptions(U);
  const found=list.find(r=>r.drug===drug);
  ok(!!found,'prescription reads back by drug name');
  ok(found&&found.dosage==='500 mg','dosage stored',found&&found.dosage);
  ok(found&&String(found.quantity)==='60','quantity stored',found&&found.quantity);
  const mr=await e.getMedicationRequests(U);
  ok(mr.some(m=>JSON.stringify(m).includes(drug)),'appears in FHIR MedicationRequest');

  console.log('\n=== A2. encounter PUT (user + group injected) ===');
  const marker='4.5 probe '+Date.now();
  await e.updateEncounter(U,euuid,{reason:marker});
  const back=await e.getEncounterRow(U,euuid);
  ok(back&&back.reason===marker,'reason stored and read back',back&&back.reason);

  console.log('\n=== B1. charge write — the CPT/ICD swap check ===');
  const CPT='99348', DX1='E11.9', DX2='I10';
  const c=await e.postCharge(U,euuid,{code_type:'CPT4',code:CPT,code_text:'Home visit est. patient (TEST DATA)',
    units:1,fee:'187.50',modifier:'25',provider_id:PROV,diagnoses:[{code_type:'ICD10',code:DX1},{code_type:'ICD10',code:DX2}]});
  const chargeId=c&&c.id;
  const rows=await e.getCharges(U,euuid);
  const row=rows.find(r=>String(r.id)===String(chargeId));
  ok(!!row,'charge reads back');
  ok(row&&row.code===CPT,'stored code is the CPT, not a diagnosis',row&&row.code);
  ok(row&&row.code_type==='CPT4','code_type is CPT4',row&&row.code_type);
  ok(row&&row.justify===`ICD10|${DX1}:ICD10|${DX2}:`,'diagnoses stored as ICD pointers',row&&row.justify);
  ok(row&&!String(row.justify||'').includes(CPT),'CPT did NOT leak into the diagnosis pointers');
  ok(row&&String(row.modifier)==='25','modifier stored',row&&row.modifier);
  ok(row&&Number(row.fee)===187.5,'fee stored',row&&row.fee);
  ok(row&&String(row.provider_id)===String(PROV),'rendering provider stored',row&&row.provider_id);
  ok(row&&!('billing_facility' in row),'billing_facility is NOT on the charge row');

  console.log('\n=== B2. void is a void, not a delete ===');
  const v=await e.voidCharge(U,euuid,chargeId);
  ok(v&&Number(v.activity)===0,'void response reports activity 0',v);
  const after=await e.getCharges(U,euuid);
  ok(!after.some(r=>String(r.id)===String(chargeId)),'voided charge gone from the ACTIVE list');
  const v2=await e.voidCharge(U,euuid,chargeId).then(()=>null).catch(er=>er);
  ok(v2 && /No such active charge/.test(String(v2.message||'')),'re-voiding refuses (row still exists, just inactive)');

  console.log('\n=== B3. order create + status advance ===');
  const oc='85025';
  const or=await e.postOrder(U,euuid,{provider_id:PROV,codes:[{code:oc,code_text:'CBC w/ diff (TEST DATA)',
    diagnoses:[{code_type:'ICD10',code:DX1}]}],order_status:'pending',order_priority:'normal'});
  const oid=or&&or.procedure_order_id;
  ok(oid!=null,'order created with an id',oid);
  const olist=await e.getOrders(U,euuid);
  const orow=olist.find(x=>String(x.procedure_order_id)===String(oid));
  ok(!!orow,'order reads back');
  ok(orow&&(orow.codes||[])[0]&&(orow.codes[0].procedure_code===oc),'order procedure code stored',orow&&(orow.codes||[])[0]);
  await e.updateOrderStatus(U,euuid,oid,'routed');
  const olist2=await e.getOrders(U,euuid);
  const orow2=olist2.find(x=>String(x.procedure_order_id)===String(oid));
  ok(orow2&&orow2.order_status==='routed','status advanced and read back as routed',orow2&&orow2.order_status);

  console.log('\n=== B4. code search ===');
  const r1=await e.searchCodes({type:'ICD10',search:'E11'});
  ok(Array.isArray(r1),'code search returns an array even when the table is empty');
  console.log(`  (ICD10 "E11" → ${r1.length} rows; 0 = load still pending)`);
  const r2=await e.searchCodes({search:'x'});
  ok(Array.isArray(r2)&&r2.length===0,'a <2-char term short-circuits to []');

  console.log(`\n================  ${pass} passed, ${fail} failed  ================`);
  process.exit(fail?1:0);
})().catch(e=>{console.error('ERR',e.message);process.exit(1);});
