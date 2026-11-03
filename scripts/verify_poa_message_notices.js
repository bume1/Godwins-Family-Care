#!/usr/bin/env node
// A POA is told about, and can open, every portal message the patient is on
// (owner, 2026-10-26). Real server, in-memory store. One patient has no login
// of their own (placeholder email), one has their own; the same POA covers both.
//   node scripts/verify_poa_message_notices.js
process.env.PORT='4641';process.env.JWT_SECRET='msg-probe';process.env.AUTO_CHANGELOG='false';process.env.MFA_ENFORCE='false';
const ROOT=require('path').join(__dirname,'..');const path=require('path');const Module=require('module');
const STORE=new Map();class MemDb{async get(k){return STORE.has(k)?JSON.parse(JSON.stringify(STORE.get(k))):null}async set(k,v){STORE.set(k,JSON.parse(JSON.stringify(v)));return true}async delete(k){STORE.delete(k);return true}async list(p){return[...STORE.keys()].filter(k=>!p||k.startsWith(p))}async empty(){STORE.clear()}}
const rr=Module._resolveFilename;Module._resolveFilename=function(r,...a){if(r==='@replit/database')return'__memdb__';return rr.call(this,r,...a)};require.cache['__memdb__']={id:'__memdb__',filename:'__memdb__',loaded:true,exports:MemDb};
const jwt=require('jsonwebtoken');let fail=0;
const BASE='http://127.0.0.1:4641';
const tok=(u)=>{const sid='s_'+u.id;const at=new Date().toISOString();STORE.set('auth_session:'+sid,{id:sid,userId:u.id,role:u.role,createdAt:at,lastSeenAt:at,revokedAt:null,mfaVerified:true});return jwt.sign({id:u.id,email:u.email,name:u.name,role:u.role,sid},'msg-probe',{expiresIn:'1h'})};
const call=async(m,url,t,body)=>{const r=await fetch(BASE+url,{method:m,headers:Object.assign({Authorization:'Bearer '+t},body?{'Content-Type':'application/json'}:{}),body:body?JSON.stringify(body):undefined});return{status:r.status,body:await r.json().catch(()=>({}))}};
const U={
 admin:{id:'adm',role:'admin',email:'adm@x.test',name:'Ad Min'},
 fnp:{id:'fnp',role:'user',email:'fnp@x.test',name:'Fay Fnp',hasClinicalAccess:true,clinicalRole:'provider',accountType:'provider'},
 cm:{id:'cm',role:'caseManager',email:'cm@x.test',name:'Cee Cm'},
 cg:{id:'cg',role:'vendor',email:'cg@x.test',name:'Cal Cg',licenseLevel:'cna'},
 joe:{id:'joe',role:'client',email:'client+joe@placeholder.local',name:'Joseph Hendricks',slug:'joe',enrollmentStatus:'enrolled',serviceLine:'BOTH',consents:{},careTeam:{assignedFNPs:['fnp'],assignedCaseManager:'cm',primaryCaregiver:'cg'}},
 ann:{id:'ann',role:'client',email:'ann@x.test',name:'Ann Self',slug:'ann',enrollmentStatus:'enrolled',serviceLine:'BOTH',consents:{},careTeam:{assignedFNPs:['fnp'],assignedCaseManager:'cm',primaryCaregiver:'cg'}},
 steph:{id:'steph',role:'family',email:'steph@x.test',name:'Stephanie Hendricks',familyLinks:[{clientId:'joe',isPoa:true},{clientId:'ann',isPoa:true}]},
};
(async()=>{
 STORE.set('users',Object.values(U));
 require(ROOT+'/server.js');await new Promise(r=>setTimeout(r,2500));
 const T={};for(const k in U)T[k]=tok(U[k]);
 const sent=()=> (STORE.get('pending_notifications')||[]).concat(STORE.get('notification_log')||[]);
 const cases=[
  ['care_team','fnp','joe'],['care_team','fnp','ann'],
  ['clinical_escalation','fnp','joe'],['direct_care','cg','joe'],
  ['support','admin','joe'],['care_update','fnp','joe'],['admin_direct','admin','joe'],
  ['clinical_escalation','fnp','ann'],['direct_care','cg','ann'],['support','admin','ann'],
 ];
 for(const [ch,who,client] of cases){
   const before=sent().length;
   const r=await call('POST','/api/messaging/threads',T[who],{channel:ch,clientId:U[client].id,body:'Test message about '+ch,format:'plain'});
   await new Promise(x=>setTimeout(x,200));
   const n=sent().slice(before).filter(x=>x.type==='message_received');
   const toPoa=n.some(x=>x.recipientUserId==='steph'&&x.templateData&&x.templateData.ctaUrl===`/portal?for=${U[client].id}#messages`);
   const toPlaceholder=n.some(x=>/@placeholder\.local$/.test(x.recipientEmail||''));
   let canOpen=false;
   if (r.body && r.body.thread && r.body.thread.id) { await call('POST','/api/gfc/active-client',T.steph,{clientId:U[client].id}); canOpen=(await call('GET','/api/messaging/threads/'+r.body.thread.id,T.steph)).status===200; }
   const ok=toPoa&&!toPlaceholder&&canOpen; if(!ok) fail++;
   console.log(`  ${ok?'✅':'❌'} ${ch} about ${client}: POA emailed with ${client}'s link=${toPoa}, POA can open=${canOpen}, placeholder emailed=${toPlaceholder}`);
   continue;
   const to=n.map(x=>x.recipientEmail+(x.templateData&&x.templateData.ctaUrl?(' ['+x.templateData.ctaUrl+']'):'')).join(', ');
   let open='';
   if (r.body && r.body.thread && r.body.thread.id) {
     await call('POST','/api/gfc/active-client',T.steph,{clientId:U[client].id});
     const o=await call('GET','/api/messaging/threads/'+r.body.thread.id,T.steph);
     open=' | POA can open: '+o.status+(o.status!==200?' '+JSON.stringify(o.body).slice(0,160)+' parts='+JSON.stringify((STORE.get('message_threads')||[]).find(t=>t.id===r.body.thread.id).participant_ids):'');
   }
   console.log(`${ch.padEnd(20)} from ${who.padEnd(5)} about ${client}: ${r.status} ${r.status!==200&&r.status!==201?JSON.stringify(r.body).slice(0,90):''}${open}\n    emailed: ${to||'(nobody)'}`);
 }
 console.log(fail?`\n${fail} failed`:'\nall passed'); process.exit(fail?1:0);
})().catch(e=>{console.error(e);process.exit(1)});
