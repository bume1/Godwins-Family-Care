// Session 4.5 Scope D — per-visit billing facility, live.
//
// Proves it persists on form_encounter AND stays off the charge row.
// addBilling() has no billing_facility parameter and the billing table no such
// column; putting it on a charge would be silently dropped, so this asserts
// both halves. Restores the original facility when done. TEST DATA only.
//
// Result on 2026-09-08: 7/7.
const o = require('../openemr.js');
const R = require('../clinicalRepository.js');
const e=o.forActor({id:'d',name:'4.5 scope D',role:'admin'});
const U='a284d5c2-670e-4a62-aa95-2d1aa629003c';
let pass=0,fail=0;
const ok=(c,l,x)=>{c?(pass++,console.log('  PASS  '+l)):(fail++,console.log('  FAIL  '+l+(x!==undefined?' :: '+JSON.stringify(x):'')));};
(async()=>{
  console.log('=== D1. facilities ===');
  const fac=await e.getFacilities();
  ok(fac.length>=2,'facility list reads back',fac.length);
  const billable=fac.filter(f=>String(f.billing_location)==='1');
  ok(billable.length>=2,'at least two are billing locations',billable.map(f=>f.name));
  const [f1,f2]=billable;

  console.log('\n=== D2. billing facility persists on form_encounter ===');
  const euuid=(await e.getEncounters(U))[0].id;
  const before=await e.getEncounterRow(U,euuid);
  console.log(`  current billing_facility: ${before.billing_facility}`);
  const target=String(before.billing_facility)===String(f1.id)?f2:f1;
  await e.updateEncounter(U,euuid,{billing_facility:String(target.id)});
  const after=await e.getEncounterRow(U,euuid);
  ok(String(after.billing_facility)===String(target.id),
     `changed to ${target.name} (${target.id}) and read back`,after.billing_facility);

  console.log('\n=== D3. it is NOT on the charge ===');
  const rows=await e.getCharges(U,euuid);
  ok(rows.length>0,'encounter has charges to inspect',rows.length);
  ok(rows.every(r=>!('billing_facility' in r)),'no charge row carries billing_facility',
     Object.keys(rows[0]||{}).filter(k=>/facil/i.test(k)));
  const payloads=R.buildChargePayloads({diagnoses:[{code:'E11.9'}],services:[{code:'99348',codeType:'CPT4'}]},{providerId:5});
  ok(payloads.every(p=>!('billing_facility' in p)),'the builder never emits it either');

  // restore
  await e.updateEncounter(U,euuid,{billing_facility:String(before.billing_facility)});
  const restored=await e.getEncounterRow(U,euuid);
  ok(String(restored.billing_facility)===String(before.billing_facility),'restored to the original');

  console.log(`\n================  ${pass} passed, ${fail} failed  ================`);
  process.exit(fail?1:0);
})().catch(e=>{console.error('ERR',e.message);process.exit(1);});
