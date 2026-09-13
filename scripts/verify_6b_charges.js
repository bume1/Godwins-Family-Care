// Session 4.5 Scope B — the Phase 6B charge and order path, live.
//
// This drives the SAME payload builders the sign-and-close and order routes
// use (clinicalRepository.buildChargePayloads / buildOrderPayload) rather than
// hand-written payloads, so what it proves is what those routes actually send.
//
// TEST DATA only — it writes charges and an order to the TEST patient's
// encounter and voids one of them.
//
//   OPENEMR_BASE_URL=… OPENEMR_CLIENT_ID=… OPENEMR_CLIENT_SECRET=… \\
//   OPENEMR_PROBE_ACCESS_TOKEN=… (from scripts/emr_login.js) node scripts/verify_6b_charges.js
//
// Result on 2026-09-08 against the live instance: 24/24.
const o=require('../openemr.js');
// Session 5.2: no password grant — the probe runs as a real OpenEMR user.
// Obtain a token with `node scripts/emr_login.js`, then export OPENEMR_PROBE_ACCESS_TOKEN.
require('./lib/probe_emr_auth').installProbeToken(o);
const R=require('../clinicalRepository.js');
const e=o.forActor({id:'b',name:'4.5 scope B',role:'admin'});
const U='a284d5c2-670e-4a62-aa95-2d1aa629003c';
let pass=0,fail=0;
const ok=(c,l,x)=>{c?(pass++,console.log('  PASS  '+l)):(fail++,console.log('  FAIL  '+l+(x!==undefined?' :: '+JSON.stringify(x):'')));};
(async()=>{
  const euuid=(await e.getEncounters(U))[0].id;
  const PROV=5; // Bethel Godwins

  // A realistic signed encounter_billing record, exactly as the sign route holds it.
  const record={
    diagnoses:[{code:'E11.9',description:'Type 2 diabetes mellitus without complications'},
               {code:'I10',description:'Essential (primary) hypertension'}],
    services:[{code:'99348',codeType:'CPT4',description:'Home visit, established patient, moderate',units:1,modifier:'25'},
              {code:'G0180',codeType:'HCPCS',description:'Physician certification home health',units:1}]
  };

  console.log('=== B1. the route\'s own payloads, posted live ===');
  const payloads=R.buildChargePayloads(record,{providerId:PROV});
  ok(payloads.length===2,'one charge line per service',payloads.length);
  ok(payloads[0].code==='99348'&&payloads[1].code==='G0180','codes are the SERVICES');
  ok(payloads.every(p=>p.diagnoses.every(d=>['E11.9','I10'].includes(d.code))),'diagnoses are only ICD codes');
  ok(payloads.every(p=>!p.diagnoses.some(d=>['99348','G0180'].includes(d.code))),'no service code leaked into diagnoses');
  ok(!('billing_facility' in payloads[0]),'billing_facility absent from the charge payload');

  const ids=[];
  for(const p of payloads){ const row=await e.postCharge(U,euuid,p); ids.push(String(row.id)); }
  const back=await e.getCharges(U,euuid);
  for(const [i,p] of payloads.entries()){
    const r=back.find(x=>String(x.id)===ids[i]);
    ok(!!r,`line ${i+1} reads back`);
    ok(r&&r.code===p.code,`line ${i+1} stored code is ${p.code}`,r&&r.code);
    ok(r&&r.code_type===p.code_type,`line ${i+1} code_type ${p.code_type}`,r&&r.code_type);
    ok(r&&r.justify==='ICD10|E11.9:ICD10|I10:',`line ${i+1} diagnosis pointers`,r&&r.justify);
    ok(r&&String(r.provider_id)===String(PROV),`line ${i+1} rendering provider`,r&&r.provider_id);
  }

  console.log('\n=== B2. void one line, the other survives ===');
  await e.voidCharge(U,euuid,ids[0]);
  const after=await e.getCharges(U,euuid);
  ok(!after.some(r=>String(r.id)===ids[0]),'voided line left the active list');
  ok(after.some(r=>String(r.id)===ids[1]),'the other line is untouched');

  console.log('\n=== B3. re-post skips what is already posted ===');
  const posted=[{id:ids[1],code:'G0180',codeType:'HCPCS'}];
  const already=new Set(posted.map(c=>`${c.codeType}:${c.code}`));
  const repost=R.buildChargePayloads(record,{providerId:PROV}).filter(p=>!already.has(`${p.code_type}:${p.code}`));
  ok(repost.length===1&&repost[0].code==='99348','re-post targets only the unposted line — no double-bill',repost.map(p=>p.code));

  console.log('\n=== B4. order payload from a real app order ===');
  const order={status:'ordered',priority:'urgent',orderType:'lab',date:new Date().toISOString().slice(0,10),
    clinicalHistory:'TEST DATA',instructions:'Fasting',diagnoses:['E11.9'],
    tests:[{code:'80048',name:'Basic metabolic panel (TEST DATA)'}]};
  const op=R.buildOrderPayload(order,{providerId:PROV});
  ok(op.order_status==='pending','app "ordered" maps to EMR "pending"',op.order_status);
  ok(op.order_priority==='high','app "urgent" maps to EMR "high"',op.order_priority);
  ok(op.procedure_order_type==='laboratory_test','lab maps to laboratory_test',op.procedure_order_type);
  const orow=await e.postOrder(U,euuid,op);
  const oid=orow&&orow.procedure_order_id;
  ok(oid!=null,'order created',oid);
  const ol=(await e.getOrders(U,euuid)).find(x=>String(x.procedure_order_id)===String(oid));
  ok(ol&&(ol.codes||[])[0]&&ol.codes[0].procedure_code==='80048','order code stored',ol&&(ol.codes||[])[0]);
  await e.updateOrderStatus(U,euuid,oid,R.orderStatusToEmr('sent'));
  const ol2=(await e.getOrders(U,euuid)).find(x=>String(x.procedure_order_id)===String(oid));
  ok(ol2&&ol2.order_status==='routed','app "sent" advanced EMR to "routed"',ol2&&ol2.order_status);

  console.log(`\n================  ${pass} passed, ${fail} failed  ================`);
  process.exit(fail?1:0);
})().catch(e=>{console.error('ERR',e.message);process.exit(1);});
