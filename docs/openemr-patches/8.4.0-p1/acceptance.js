// Phase 6B acceptance. Proves the three patched routes end to end against a live
// OpenEMR 8.4 instance carrying the 8.4.0-p1 image.
//
// It asserts STORED VALUES, not HTTP status codes. That distinction is the whole
// point: every defect this caught returned 201 and looked correct in Billing
// Manager. A charge that stores the wrong code, or diagnosis pointers reading
// "ICD10|Array:", surfaces as a denial weeks later, not as an error here.
//
// Credentials come from the environment. Nothing is read from a file and nothing
// is written here — keep it that way.
//
//   OPENEMR_BASE_URL=https://emr.example.com \
//   OPENEMR_CLIENT_ID=… OPENEMR_CLIENT_SECRET=… \
//   OPENEMR_API_USERNAME=… OPENEMR_API_PASSWORD=… \
//   node acceptance.js
//
// TEST DATA ONLY. It writes a charge and an order to whatever encounter it finds
// on the TEST patient. Never run it against a real patient.
const need = (k) => {
  const v = process.env[k];
  if (!v) { console.error(`missing required env var ${k}`); process.exit(2); }
  return v;
};
const c = { client_id: need('OPENEMR_CLIENT_ID'), client_secret: need('OPENEMR_CLIENT_SECRET') };
const base = need('OPENEMR_BASE_URL').replace(/\/$/, '');
const site = process.env.OPENEMR_SITE || 'default';
// The app's own scope list, plus the five the patch registers.
let appScopes = '';
try {
  appScopes = require(require('path').resolve(__dirname, '../../../config.js')).OPENEMR.SCOPES;
} catch (e) {
  console.error('note: could not load config.js for the app scope list; requesting patch scopes only');
}
const scopes = [appScopes,
  'user/billing.read user/billing.write user/order.read user/order.write user/codes.read']
  .filter(Boolean).join(' ');
let pass = 0, fail = 0;
const ok = (cond, label, extra) => { cond ? (pass++, console.log(`  PASS  ${label}`)) : (fail++, console.log(`  FAIL  ${label}${extra ? ' :: ' + extra : ''}`)); };

(async () => {
  const body = new URLSearchParams({ grant_type: 'password', client_id: c.client_id, client_secret: c.client_secret,
    user_role: 'users', username: process.env.OPENEMR_API_USERNAME, password: process.env.OPENEMR_API_PASSWORD, scope: scopes });
  const t = await (await fetch(`${base}/oauth2/${site}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body })).json();
  if (!t.access_token) { console.log('TOKEN FAILED', JSON.stringify(t).slice(0, 300)); process.exit(1); }
  const H = { authorization: 'Bearer ' + t.access_token, 'content-type': 'application/json' };
  const api = async (m, p, b) => { const r = await fetch(`${base}/apis/${site}${p}`, { method: m, headers: H, ...(b ? { body: JSON.stringify(b) } : {}) });
    const txt = await r.text(); let j; try { j = JSON.parse(txt); } catch { j = { raw: txt.slice(0, 300) }; } return { status: r.status, j }; };

  console.log('\n--- resolve TEST patient + encounter ---');
  const pats = await api('GET', '/fhir/Patient?name=PatientOne');
  const puuid = pats.j?.entry?.[0]?.resource?.id;
  const pname = (pats.j?.entry?.[0]?.resource?.name?.[0]?.given || []).join(' ') + ' ' + (pats.j?.entry?.[0]?.resource?.name?.[0]?.family || '');
  const encs = await api('GET', `/fhir/Encounter?patient=${puuid}`);
  const euuid = encs.j?.entry?.[0]?.resource?.id;
  const one = await api('GET', `/api/patient/${puuid}/encounter/${euuid}`);
  const pid = one.j?.data?.pid, eid = one.j?.data?.eid ?? one.j?.data?.encounter;
  console.log(`  patient: ${pname.trim()} (pid ${pid})   encounter eid ${eid}`);
  const users = await api('GET', '/api/practitioner');
  const prov = (users.j?.data || []).find(u => u.id) || {};
  console.log(`  provider_id candidate: ${prov.id} (${prov.username})`);

  console.log('\n--- 1. POST a fee-sheet charge ---');
  const charge = { code_type: 'CPT4', code: '99348', code_text: 'Home visit, established patient (TEST DATA)',
    modifier: '25', units: 1, fee: '187.50', provider_id: Number(prov.id),
    diagnoses: [{ code_type: 'ICD10', code: 'E11.9' }, { code_type: 'ICD10', code: 'I10' }] };
  const post = await api('POST', `/api/patient/${pid}/encounter/${eid}/billing`, charge);
  console.log(`  HTTP ${post.status}  ${JSON.stringify(post.j).slice(0, 220)}`);
  ok(post.status === 201, 'charge POST returns 201');
  const chargeId = post.j?.data?.id;

  console.log('\n--- 2. GET the charge back and check every field ---');
  const get = await api('GET', `/api/patient/${pid}/encounter/${eid}/billing`);
  const rows = get.j?.data || [];
  const row = rows.find(r => String(r.id) === String(chargeId)) || rows[0] || {};
  console.log(`  HTTP ${get.status}  rows: ${rows.length}`);
  console.log(`  ${JSON.stringify(row).slice(0, 320)}`);
  ok(get.status === 200, 'charge GET returns 200');
  ok(row.code === '99348', 'code stored', row.code);
  ok(String(row.modifier) === '25', 'modifier stored', row.modifier);
  ok(Number(row.units) === 1, 'units stored', row.units);
  ok(Number(row.fee) === 187.5, 'fee stored', row.fee);
  ok(String(row.provider_id) === String(prov.id), 'rendering provider stored', row.provider_id);
  ok(row.justify === 'ICD10|E11.9:ICD10|I10:', 'diagnosis pointers in X12 format', JSON.stringify(row.justify));

  console.log('\n--- 3. POST a procedure order ---');
  const order = { order_type: 'lab', description: 'CBC with differential (TEST DATA)', provider_id: Number(prov.id),
    codes: [{ code: '85025', code_text: 'CBC w/ auto diff (TEST DATA)',
      // Object-shaped, same as the charge. The first acceptance run sent no
      // diagnoses here, which is why the order path's identical "Array" bug
      // went unnoticed while the charge's was caught.
      diagnoses: [{ code_type: 'ICD10', code: 'E11.9' }, { code_type: 'ICD10', code: 'I10' }] }] };
  const po = await api('POST', `/api/patient/${pid}/encounter/${eid}/order`, order);
  console.log(`  HTTP ${po.status}  ${JSON.stringify(po.j).slice(0, 220)}`);
  ok(po.status === 201, 'order POST returns 201');

  console.log('\n--- 4. GET orders back ---');
  const go = await api('GET', `/api/patient/${pid}/encounter/${eid}/order`);
  const orows = go.j?.data || [];
  console.log(`  HTTP ${go.status}  orders: ${orows.length}  ${JSON.stringify(orows[0] || {}).slice(0, 260)}`);
  ok(go.status === 200, 'order GET returns 200');
  ok(orows.length >= 1, 'order readable back');
  const newest = orows.reduce((a, b) => (Number(b.procedure_order_id) > Number(a?.procedure_order_id ?? -1) ? b : a), null) || {};
  const ocode = (newest.codes || [])[0] || {};
  ok((newest.codes || []).length >= 1, 'order-code rows attached');
  ok(ocode.procedure_code === '85025', 'order procedure code stored', ocode.procedure_code);
  ok(ocode.diagnoses === 'ICD10:E11.9;ICD10:I10', 'order diagnoses stored', JSON.stringify(ocode.diagnoses));

  console.log('\n--- 5. the die() guard: charge against a non-existent encounter ---');
  const bad = await api('POST', `/api/patient/${pid}/encounter/99999999/billing`, charge);
  console.log(`  HTTP ${bad.status}  ${JSON.stringify(bad.j).slice(0, 200)}`);
  ok(bad.status === 400, 'bad encounter returns clean 400, not a die() HTML page');
  ok(!String(JSON.stringify(bad.j)).includes('<'), 'response is JSON, not HTML');

  console.log('\n--- 6. code search ---');
  const cs = await api('GET', '/api/codes?type=ICD10&search=E11');
  console.log(`  HTTP ${cs.status}  results: ${(cs.j?.data || []).length}  (ICD-10 not loaded yet, so 0 is expected)`);
  ok(cs.status === 200, 'code search returns 200');

  console.log(`\n================  ${pass} passed, ${fail} failed  ================`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
