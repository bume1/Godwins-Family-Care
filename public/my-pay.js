// ============================================================================
// MY PAY — the payroll pieces of My GFC's Hours & Pay section (2026-11-08)
// ============================================================================
// Loaded before /my-gfc.js on /my and /caregiver. Exports window.MyPay, which
// my-gfc.js draws inside Hours & Pay beside the pay stubs it already lists:
//   PaySetup            W-4, G-4, I-9, SSN, W-9, how you are paid, tax
//                       mailing address, electronic tax forms (pay and tax
//                       only; hiring paperwork is in onboarding)
//   ContractorInvoices  submit an invoice; see its status and 1099 total
//   TaxForms            W-2 / 1099-NEC once the office releases them
// Every value the server decides (which forms apply, what is missing) comes
// from the server; this page restates no payroll rule. Nothing secret comes
// back: once saved, a number shows as its last four.
// ============================================================================
(function () {
const { useState, useEffect } = React;

(function injectStyles() {
  if (document.getElementById('mypay-styles')) return;
  const el = document.createElement('style');
  el.id = 'mypay-styles';
  el.textContent = `.mp-form select,.mp-form input[type=date],.mp-form input[type=number],.mp-form input[type=password],.mp-form input[type=email]{width:100%;background:#fff;border:1px solid var(--edge2);border-radius:11px;padding:10px 12px;font:inherit;color:var(--ink)}
.mp-form .mp-check{display:flex;gap:8px;align-items:flex-start;font-weight:500;color:var(--ink);margin:10px 0}
.mp-form .mp-check input{margin-top:3px}
.mp-grid{display:grid;gap:10px;grid-template-columns:1fr} @media(min-width:700px){.mp-grid{grid-template-columns:1fr 1fr}}
.mp-items{display:flex;flex-direction:column;gap:6px;margin:4px 0 8px}
.mp-item{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:10px 12px;border:1px solid var(--edge);border-radius:12px;background:#fff}
.mp-item b{font-size:14.5px} .mp-item small{display:block;color:var(--mut);font-size:12.5px}
.mp-line{display:grid;grid-template-columns:120px 1fr 90px 70px 90px 30px;gap:6px;align-items:center;margin-bottom:6px}
@media(max-width:700px){.mp-line{grid-template-columns:1fr 1fr}}`;
  document.head.appendChild(el);
})();

const getToken = () => localStorage.getItem('admin_token') || localStorage.getItem('unified_token') || localStorage.getItem('portal_token');
const call = async (path, opts = {}) => {
  const res = await fetch(path, { method: opts.method || 'GET', headers: { Authorization: `Bearer ${getToken()}`, 'Content-Type': 'application/json' }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  let data = null;
  try { data = await res.json(); } catch (e) { /* empty */ }
  if (!res.ok) { const err = new Error((data && data.error) || `Request failed (${res.status})`); err.code = data && data.code; throw err; }
  return data;
};
const usd = (c) => `$${(Number(c || 0) / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
const today = () => new Date().toISOString().slice(0, 10);

// One signature block: the person types their name and ticks the statement.
function Sign({ statement, form, set }) {
  return (
    <div>
      <label className="mp-check"><input type="checkbox" checked={!!form.agree} onChange={e => set({ ...form, agree: e.target.checked })} /><span>{statement}</span></label>
      <label>Type your full name to sign</label>
      <input type="text" value={form.signedName || ''} onChange={e => set({ ...form, signedName: e.target.value })} />
    </div>
  );
}

const PERJURY = 'Under penalties of perjury, I declare that this certificate, to the best of my knowledge and belief, is true, correct and complete.';

function FormBody({ which, data, form, set }) {
  const o = data.options;
  if (which === 'w4') return (
    <div>
      <label>Step 1(c): filing status</label>
      <select value={form.filingStatus || ''} onChange={e => set({ ...form, filingStatus: e.target.value })}>
        <option value="">Choose…</option>{Object.entries(o.w4Filing).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
      </select>
      <label className="mp-check"><input type="checkbox" checked={!!form.multipleJobs} onChange={e => set({ ...form, multipleJobs: e.target.checked })} /><span>Step 2(c): I have two jobs at once, or I'm married filing jointly and my spouse also works, and the two jobs pay about the same.</span></label>
      <div className="mp-grid">
        <div><label>Step 3: dependents amount ($ a year)</label><input type="number" min="0" value={form.dependentsAmount || ''} onChange={e => set({ ...form, dependentsAmount: e.target.value })} /></div>
        <div><label>Step 4(a): other income ($ a year)</label><input type="number" min="0" value={form.otherIncome || ''} onChange={e => set({ ...form, otherIncome: e.target.value })} /></div>
        <div><label>Step 4(b): deductions ($ a year)</label><input type="number" min="0" value={form.deductions || ''} onChange={e => set({ ...form, deductions: e.target.value })} /></div>
        <div><label>Step 4(c): extra withholding ($ each paycheck)</label><input type="number" min="0" value={form.extraWithholding || ''} onChange={e => set({ ...form, extraWithholding: e.target.value })} /></div>
      </div>
      <label className="mp-check"><input type="checkbox" checked={!!form.exempt} onChange={e => set({ ...form, exempt: e.target.checked })} /><span>Exempt: I had no federal income tax liability last year and expect none this year.</span></label>
      <p className="mg-note">The IRS worksheets for Steps 2 to 4 are on the official form at irs.gov/FormW4. Enter the totals here.</p>
      <Sign statement={PERJURY} form={form} set={set} />
    </div>
  );
  if (which === 'g4') return (
    <div>
      <label>Line 3: marital status</label>
      <select value={form.filingStatus || ''} onChange={e => set({ ...form, filingStatus: e.target.value })}>
        <option value="">Choose…</option>{Object.entries(o.g4Filing).map(([k, v]) => <option key={k} value={k}>{k}. {v}</option>)}
      </select>
      <div className="mp-grid">
        <div><label>Line 4: dependent allowances</label><input type="number" min="0" value={form.dependentAllowances || ''} onChange={e => set({ ...form, dependentAllowances: e.target.value })} /></div>
        <div><label>Line 5: additional allowances</label><input type="number" min="0" value={form.additionalAllowances || ''} onChange={e => set({ ...form, additionalAllowances: e.target.value })} /></div>
        <div><label>Line 6: extra withholding ($ each paycheck)</label><input type="number" min="0" value={form.extraWithholding || ''} onChange={e => set({ ...form, extraWithholding: e.target.value })} /></div>
      </div>
      <label className="mp-check"><input type="checkbox" checked={!!form.exempt} onChange={e => set({ ...form, exempt: e.target.checked })} /><span>Exempt from Georgia withholding (line 8).</span></label>
      <Sign statement={PERJURY} form={form} set={set} />
    </div>
  );
  if (which === 'statecert') return (
    <div>
      <p className="mg-note">For {data.workStateName}, where you work.</p>
      <label>Filing status</label>
      <select value={form.filingStatus || ''} onChange={e => set({ ...form, filingStatus: e.target.value })}>
        <option value="">Choose…</option><option value="single">Single</option><option value="married">Married</option>
      </select>
      <div className="mp-grid">
        <div><label>Allowances</label><input type="number" min="0" value={form.allowances || ''} onChange={e => set({ ...form, allowances: e.target.value })} /></div>
        <div><label>Extra withholding ($ each paycheck)</label><input type="number" min="0" value={form.extraWithholding || ''} onChange={e => set({ ...form, extraWithholding: e.target.value })} /></div>
      </div>
      <label className="mp-check"><input type="checkbox" checked={!!form.exempt} onChange={e => set({ ...form, exempt: e.target.checked })} /><span>Exempt from {data.workStateName} withholding.</span></label>
      <Sign statement={PERJURY} form={form} set={set} />
    </div>
  );
  if (which === 'i9') return (
    <div>
      <label>Section 1: I attest that I am</label>
      <select value={form.status || ''} onChange={e => set({ ...form, status: e.target.value })}>
        <option value="">Choose…</option>{Object.entries(o.i9Status).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
      </select>
      <div className="mp-grid">
        <div><label>Date of birth</label><input type="date" value={form.dob || ''} onChange={e => set({ ...form, dob: e.target.value })} /></div>
        <div><label>Other last names used (if any)</label><input type="text" value={form.otherLastNames || ''} onChange={e => set({ ...form, otherLastNames: e.target.value })} /></div>
        <div><label>Phone (optional)</label><input type="tel" value={form.phone || ''} onChange={e => set({ ...form, phone: e.target.value })} /></div>
      </div>
      {form.status === 'lpr' && <div><label>A-Number or USCIS number</label><input type="text" autoComplete="off" value={form.alienNumber || ''} onChange={e => set({ ...form, alienNumber: e.target.value })} placeholder="7 to 9 digits" /></div>}
      {form.status === 'authorized' && (
        <div>
          <div><label>Work authorization expires (if it does)</label><input type="date" value={form.workAuthExpires || ''} onChange={e => set({ ...form, workAuthExpires: e.target.value })} /></div>
          <p className="mg-note">Give one of these three.</p>
          <div className="mp-grid">
            <div><label>A-Number or USCIS number</label><input type="text" autoComplete="off" value={form.alienNumber || ''} onChange={e => set({ ...form, alienNumber: e.target.value })} /></div>
            <div><label>Form I-94 admission number</label><input type="text" autoComplete="off" value={form.i94Number || ''} onChange={e => set({ ...form, i94Number: e.target.value })} /></div>
            <div><label>Foreign passport number and country</label><input type="text" autoComplete="off" value={form.passport || ''} onChange={e => set({ ...form, passport: e.target.value })} /></div>
          </div>
        </div>
      )}
      <p className="mg-note">Your name and address come from "Legal name and mailing address" above. Bring your identity and work authorization documents to the office; they complete Section 2 when they see them. Signing fills in the official Form I-9.</p>
      <Sign statement="I am aware that federal law provides for imprisonment and/or fines for false statements, or the use of false documents, in connection with the completion of this form." form={form} set={set} />
    </div>
  );
  if (which === 'ssn') return (
    <div><label>Social Security number</label><input type="password" autoComplete="off" value={form.ssn || ''} onChange={e => set({ ...form, ssn: e.target.value })} placeholder="9 digits" />
      <p className="mg-note">Stored encrypted. Only the last four show after you save.</p></div>
  );
  if (which === 'w9') return (
    <div>
      <label>Name on your tax return</label><input type="text" value={form.name || ''} onChange={e => set({ ...form, name: e.target.value })} />
      <label>Business name (if different)</label><input type="text" value={form.businessName || ''} onChange={e => set({ ...form, businessName: e.target.value })} />
      <label>Tax classification</label>
      <select value={form.taxClass || ''} onChange={e => set({ ...form, taxClass: e.target.value })}><option value="">Choose…</option>{Object.entries(o.w9Class).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
      <div className="mp-grid">
        <div><label>Taxpayer ID type</label><select value={form.tinType || 'ssn'} onChange={e => set({ ...form, tinType: e.target.value })}><option value="ssn">SSN</option><option value="ein">EIN</option></select></div>
        <div><label>Taxpayer ID</label><input type="password" autoComplete="off" value={form.tin || ''} onChange={e => set({ ...form, tin: e.target.value })} /></div>
      </div>
      <label>Address</label><input type="text" value={form.address || ''} onChange={e => set({ ...form, address: e.target.value })} />
      <Sign statement="Under penalties of perjury, I certify that the number shown is my correct taxpayer identification number and that I am a U.S. person." form={form} set={set} />
    </div>
  );
  if (which === 'pay') return (
    <div>
      <label>How you are paid</label>
      <select value={form.method || ''} onChange={e => set({ ...form, method: e.target.value })}>
        <option value="">Choose…</option><option value="direct_deposit">Direct deposit</option><option value="check">Paper check</option>{data.contractor && <option value="wise">Wise (outside the US)</option>}
      </select>
      {form.method === 'direct_deposit' && (
        <div>
          <label>Bank name</label><input type="text" value={form.bankName || ''} onChange={e => set({ ...form, bankName: e.target.value })} />
          <div className="mp-grid">
            <div><label>Routing number</label><input type="password" autoComplete="off" value={form.routing || ''} onChange={e => set({ ...form, routing: e.target.value })} /></div>
            <div><label>Account number</label><input type="password" autoComplete="off" value={form.account || ''} onChange={e => set({ ...form, account: e.target.value })} /></div>
          </div>
          <label>Account type</label>
          <select value={form.accountType || ''} onChange={e => set({ ...form, accountType: e.target.value })}><option value="">Choose…</option><option value="checking">Checking</option><option value="savings">Savings</option></select>
          <p className="mg-note">I authorize Godwins Family Care to deposit my pay into this account. Stored encrypted; only the last four show after you save.</p>
        </div>
      )}
      {form.method === 'wise' && <div><label>Wise email</label><input type="email" value={form.wiseEmail || ''} onChange={e => set({ ...form, wiseEmail: e.target.value })} /></div>}
    </div>
  );
  if (which === 'taxaddress') return (
    <div>
      <p className="mg-note">Exactly as on your Social Security card. This prints on your W-2 or 1099.</p>
      <div className="mp-grid">
        <div><label>First name</label><input type="text" value={form.firstName || ''} onChange={e => set({ ...form, firstName: e.target.value })} /></div>
        <div><label>Middle name or initial</label><input type="text" value={form.middle || ''} onChange={e => set({ ...form, middle: e.target.value })} /></div>
        <div><label>Last name</label><input type="text" value={form.lastName || ''} onChange={e => set({ ...form, lastName: e.target.value })} /></div>
        <div><label>Suffix</label><input type="text" value={form.suffix || ''} onChange={e => set({ ...form, suffix: e.target.value })} /></div>
      </div>
      <label>Street address</label><input type="text" value={form.line1 || ''} onChange={e => set({ ...form, line1: e.target.value })} />
      <label>Apartment or unit</label><input type="text" value={form.line2 || ''} onChange={e => set({ ...form, line2: e.target.value })} />
      <div className="mp-grid">
        <div><label>City</label><input type="text" value={form.city || ''} onChange={e => set({ ...form, city: e.target.value })} /></div>
        <div><label>State</label><input type="text" maxLength={2} value={form.state || ''} onChange={e => set({ ...form, state: e.target.value.toUpperCase() })} /></div>
        <div><label>ZIP</label><input type="text" inputMode="numeric" value={form.zip || ''} onChange={e => set({ ...form, zip: e.target.value })} /></div>
      </div>
    </div>
  );
  // The terms come from the server and the consent records their version
  // (Pub 1141 2.4: the disclosures must be shown before consent).
  if (which === 'edelivery') return (
    <div>
      <ul className="mg-note" style={{ paddingLeft: 18, margin: '0 0 10px' }}>{((data.options && data.options.eDelivery && data.options.eDelivery.disclosure) || []).map((t, i) => <li key={i}>{t}</li>)}</ul>
      <label className="mp-check"><input type="checkbox" checked={!!form.consented} onChange={e => set({ ...form, consented: e.target.checked, disclosureVersion: data.options && data.options.eDelivery && data.options.eDelivery.version })} /><span>I have read the above and agree to get my W-2 or 1099 electronically in My GFC.</span></label>
    </div>
  );
  return null;
}

const ROUTE = { w4: 'w4', g4: 'g4', statecert: 'state-cert', i9: 'i9', ssn: 'ssn', w9: 'w9', pay: 'pay-method', taxaddress: 'tax-address', edelivery: 'e-delivery' };
// The signed official form, filled from your answers (owner, 2026-11-13).
const FORM_PDF = { w4: 'w4', g4: 'g4', statecert: 'state', i9: 'i9', w9: 'w9' };
const downloadForm = async (key, setErr) => {
  try {
    const res = await fetch(`/api/my/pay-setup/forms/${FORM_PDF[key]}.pdf`, { headers: { Authorization: `Bearer ${getToken()}` } });
    if (!res.ok) { let m = 'That form could not be opened.'; try { m = (await res.json()).error || m; } catch (e) { /* not json */ } throw new Error(m); }
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a'); a.href = url; a.download = `${key.toUpperCase()}.pdf`; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  } catch (e) { setErr(e.message); }
};

function PaySetup() {
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(null);
  const [form, setForm] = useState({});
  const [err, setErr] = useState(''); const [msg, setMsg] = useState(''); const [busy, setBusy] = useState(false);
  const openRef = React.useRef(null);
  const load = () => call('/api/my/pay-setup').then(setData).catch(e => setErr(e.message));
  useEffect(() => { load(); }, []);
  // Bring the opened form into view, so a click always shows something.
  useEffect(() => { if (open && openRef.current && openRef.current.scrollIntoView) openRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, [open]);
  if (!data) return err ? <div className="mg-err">{err}</div> : <p className="mg-note">Loading…</p>;
  const save = async () => {
    setBusy(true); setErr(''); setMsg('');
    try {
      const r = await call(`/api/my/pay-setup/${ROUTE[open]}`, { method: 'PUT', body: form });
      setData({ ...data, profile: r.profile }); setOpen(null); setForm({}); setMsg('Saved.');
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };
  const p = data.profile;
  const detail = (k) => k === 'ssn' && p.ssnLast4 ? `On file, ending ${p.ssnLast4}` : k === 'pay' && p.payMethod ? (p.payMethod.method === 'direct_deposit' ? `${p.payMethod.bankName || 'Bank'} ••••${p.payMethod.accountLast4}` : p.payMethod.method === 'check' ? 'Paper check' : 'Wise') : k === 'w9' && p.tinLast4 ? `Taxpayer ID ending ${p.tinLast4}` : null;
  return (
    <div className="mp-form">
      <p className="mg-note" style={{ marginTop: 0 }}>What payroll needs to pay you and send your W-2 or 1099. Your other hiring paperwork is in onboarding.</p>
      {!data.secretsStorable && <div className="mg-note">Social Security and bank numbers can't be saved yet while the office finishes setting up payroll. You can fill in the other forms now and add those numbers later.</div>}
      {err && !open && <div className="mg-err">{err}</div>}
      {msg && <p style={{ color: 'var(--green)', margin: '0 0 8px' }}>{msg}</p>}
      <div className="mp-items">
        {p.checklist.map((c, i) => (
          <React.Fragment key={c.key}>
          {(i === 0 || p.checklist[i - 1].group !== c.group) && c.group && <div className="mp-group" style={{ fontWeight: 600, fontSize: 12.5, textTransform: 'uppercase', letterSpacing: '.04em', color: 'var(--muted, #6b6b6b)', margin: i === 0 ? '0 0 6px' : '14px 0 6px' }}>{c.group === 'tax' ? 'Tax forms' : 'Getting paid'}</div>}
          <div className="mp-item">
            <div><b>{c.label}</b><small>{c.done ? (detail(c.key) || 'Done') : c.optional ? 'Optional' : 'Not done yet'}{c.note ? ` · ${c.note}` : ''}</small></div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span className={`mg-pill ${c.done ? 'mg-ok' : c.optional ? 'mg-wait' : 'mg-bad'}`}>{c.done ? 'Done' : 'To do'}</span>
              {c.done && FORM_PDF[c.key] && !(c.key === 'i9' && p.i9 && p.i9.onFile && !p.i9.section1) && <button className="mg-btn mg-ghost mg-sm" onClick={() => { setErr(''); downloadForm(c.key, setErr); }}>Download PDF</button>}
              {!c.locked && <button className="mg-btn mg-ghost mg-sm" disabled={!data.secretsStorable && (c.key === 'ssn' || c.key === 'w9')} onClick={() => { setOpen(open === c.key ? null : c.key); setForm(c.key === 'edelivery' ? { consented: !!(p.eDelivery && p.eDelivery.consented), disclosureVersion: data.options && data.options.eDelivery && data.options.eDelivery.version } : c.key === 'taxaddress' && p.taxAddress ? { ...p.taxAddress, zip: `${p.taxAddress.zip || ''}${p.taxAddress.zip4 || ''}` } : {}); setErr(''); }}>{c.done ? 'Update' : 'Start'}</button>}
            </div>
          </div>
          {/* The form opens right under the item clicked (owner report,
              2026-11-13): drawn below the whole list it landed off-screen,
              and Start looked like it did nothing. */}
          {open === c.key && (
            <div className="mg-card mp-open" ref={openRef} style={{ boxShadow: 'none', margin: '4px 0 10px' }}>
              <FormBody which={open} data={data} form={form} set={setForm} />
              {err && <div className="mg-err">{err}</div>}
              <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
                <button className="mg-btn" disabled={busy} onClick={save}>{['w4', 'g4', 'statecert', 'i9', 'w9'].includes(open) ? 'Sign and Save' : 'Save'}</button>
                <button className="mg-btn mg-ghost" onClick={() => { setOpen(null); setForm({}); }}>Cancel</button>
              </div>
            </div>
          )}
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}


const EMPTY_LINE = { serviceDate: '', description: '', unit: 'hour', qty: '', rate: '' };
function ContractorInvoices({ Section }) {
  const [d, setD] = useState(null); const [f, setF] = useState(null); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const load = () => call('/api/my/contractor-invoices').then(setD).catch(e => setErr(e.message));
  useEffect(() => { load(); }, []);
  if (!d) return err ? <div className="mg-err">{err}</div> : <p className="mg-note">Loading…</p>;
  if (!d.contractor) return null;
  const Wrap = Section || (({ children }) => <div>{children}</div>);
  const submit = async () => {
    setBusy(true); setErr('');
    try { await call('/api/my/contractor-invoices', { method: 'POST', body: f }); setF(null); await load(); } catch (e) { setErr(e.message); }
    setBusy(false);
  };
  const setLine = (i, k, v) => setF({ ...f, lines: f.lines.map((l, j) => (j === i ? { ...l, [k]: v } : l)) });
  const pill = { submitted: ['mg-wait', 'With the office'], approved: ['mg-ok', 'Approved'], paid: ['mg-ok', 'Paid'], rejected: ['mg-bad', 'Sent back'] };
  return (
    <Wrap title="Contractor Invoices" sub="Send an invoice for contract work. The office approves it and pays it with the next payout.">
    <div className="mp-form">
      {err && <div className="mg-err">{err}</div>}
      <p style={{ marginTop: 0 }}>Paid to you this year: <b>{usd(d.paidThisYearCents)}</b>. This is the total on your 1099-NEC.</p>
      {!f && <button className="mg-btn" onClick={() => setF({ invoiceNo: '', periodStart: '', periodEnd: '', lines: [{ ...EMPTY_LINE }] })}>New Invoice</button>}
      {f && (
        <div className="mg-card" style={{ boxShadow: 'none' }}>
          <div className="mp-grid">
            <div><label>Your invoice number</label><input type="text" value={f.invoiceNo} onChange={e => setF({ ...f, invoiceNo: e.target.value })} /></div>
            <div><label>Period</label><div style={{ display: 'flex', gap: 6 }}><input type="date" value={f.periodStart} onChange={e => setF({ ...f, periodStart: e.target.value })} /><input type="date" value={f.periodEnd} onChange={e => setF({ ...f, periodEnd: e.target.value })} /></div></div>
          </div>
          <label>Lines</label>
          {f.lines.map((l, i) => (
            <div key={i} className="mp-line">
              <input type="date" value={l.serviceDate} onChange={e => setLine(i, 'serviceDate', e.target.value)} />
              <input type="text" placeholder="What you did" value={l.description} onChange={e => setLine(i, 'description', e.target.value)} />
              <select value={l.unit} onChange={e => setLine(i, 'unit', e.target.value)}><option value="hour">Hour</option><option value="visit">Visit</option><option value="exam">Exam</option><option value="flat">Flat</option></select>
              <input type="number" placeholder="Qty" value={l.qty} onChange={e => setLine(i, 'qty', e.target.value)} />
              <input type="number" placeholder="Rate $" value={l.rate} onChange={e => setLine(i, 'rate', e.target.value)} />
              <button className="mg-btn mg-ghost mg-sm" onClick={() => setF({ ...f, lines: f.lines.filter((_, j) => j !== i) })}>✕</button>
            </div>
          ))}
          <button className="mg-btn mg-ghost mg-sm" onClick={() => setF({ ...f, lines: [...f.lines, { ...EMPTY_LINE }] })}>Add Line</button>
          <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
            <button className="mg-btn" disabled={busy} onClick={submit}>Submit Invoice</button>
            <button className="mg-btn mg-ghost" onClick={() => setF(null)}>Cancel</button>
          </div>
        </div>
      )}
      <div className="mp-items" style={{ marginTop: 10 }}>
        {d.invoices.map(x => (
          <div key={x.id} className="mp-item">
            <div><b>Invoice {x.invoiceNo} · {usd(x.totalCents)}</b><small>{x.periodStart} to {x.periodEnd}{x.reviewNote ? ` · ${x.reviewNote}` : ''}</small></div>
            <span className={`mg-pill ${(pill[x.status] || [])[0] || ''}`}>{(pill[x.status] || [])[1] || x.status}</span>
          </div>
        ))}
      </div>
    </div>
    </Wrap>
  );
}

function TaxForms() {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => { call('/api/my/tax-forms').then(setD).catch(() => setD({ forms: [] })); }, []);
  if (!d) return <p className="mg-note">Loading…</p>;
  if (!d.forms.length) return <p className="mg-note">Your W-2 or 1099 shows here once the office releases it, by January 31.</p>;
  const open = async (f) => {
    // A PDF needs the sign-in header, so it is fetched, not linked.
    const r = await fetch(`/api/my/tax-forms/${encodeURIComponent(f.year)}/${encodeURIComponent(f.form)}.pdf`, { headers: { Authorization: `Bearer ${getToken()}` } });
    if (!r.ok) { setErr(r.status === 401 ? 'Your sign-in has expired. Sign in again to download.' : 'That form could not be opened. Try again, or ask the office.'); return; }
    setErr('');
    const url = URL.createObjectURL(await r.blob());
    const a = document.createElement('a'); a.href = url; a.download = `${f.year}_${f.label}.pdf`; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  };
  return <div>{err && <div className="mg-err">{err}</div>}<div className="mp-items">{d.forms.map(f => <div key={`${f.year}${f.form}`} className="mp-item"><div><b>{f.year} {f.label}{f.corrected ? ' (corrected)' : ''}</b><small>Print it and attach Copy B to your federal return. Keep Copy C.</small></div><button className="mg-btn mg-ghost mg-sm" onClick={() => open(f)}>Download</button></div>)}</div></div>;
}

// ---- My Timesheets (owner, 2026-11-13) ------------------------------------
// Each pay period's hours as payroll will pay them. Once the period ends the
// person says they look right, or what is wrong. The Super Admin approves them
// or sends them back with a note. Their pay is never held for it.
const hm = (mins) => { const m = Math.round(Number(mins) || 0); return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`; };
const OFFICE_LABEL = { approved: ['Approved', 'mg-ok'], changed: ['Changed since approved', 'mg-wait'], sent_back: ['Sent back to you', 'mg-bad'], waiting: ['Waiting for the office', 'mg-wait'] };
const EMP_LABEL = { confirmed: 'You said they look right', flagged: 'You flagged a problem', changed: 'Hours changed since you confirmed', not_yet: 'Not confirmed yet' };
// One shift on your timesheet. "Request a Change" sends the right times to the
// Super Admin with why; nothing changes until they approve it, and the office's
// Timesheets screen shows the same request (owner, 2026-11-13).
const GT = window.GFC_TIME;
const clockOf = (iso) => (iso && GT ? GT.fmtTime(iso) : '');
const hhmm = (iso) => { const p = iso && GT ? GT.zonedParts(iso) : null; return p ? `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}` : ''; };
function MyLine({ l, paid, onSaved }) {
  const [ask, setAsk] = useState(false); const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const date = l.clockIn && GT ? GT.zonedParts(l.clockIn).isoDate : l.date;
  const [f, setF] = useState({ date, tin: hhmm(l.clockIn), tout: hhmm(l.clockOut), reason: '' });
  const send = async () => {
    const a = GT.instantFromZoned(f.date, f.tin); let b = GT.instantFromZoned(f.date, f.tout);
    if (a && b && b <= a) b = GT.instantFromZoned(GT.addDays(f.date, 1), f.tout);
    if (!a || !b) { setErr('Give the date and both times.'); return; }
    setBusy(true); setErr('');
    try { await call(`/api/my/time-logs/${encodeURIComponent(l.timeLogId)}/adjustment-requests`, { method: 'POST', body: { clockInAt: a, clockOutAt: b, reason: f.reason } }); setAsk(false); await onSaved(); }
    catch (e) { setErr(e.message); }
    setBusy(false);
  };
  const row = { display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 13.5, padding: '4px 0', borderTop: '1px solid var(--edge)', alignItems: 'center' };
  return (
    <div>
      <div style={row}>
        <span>{l.date} · {l.source}{l.clockIn ? ` · ${clockOf(l.clockIn)} to ${clockOf(l.clockOut)}` : ''}{l.edited ? ' · corrected' : ''}</span>
        <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}><b>{l.kind === 'hours' ? hm(l.minutes) : `${l.count} ${l.kind}`}</b>
          {!paid && l.timeLogId && l.editable && !l.pendingChange && !ask && <button className="mg-btn mg-ghost mg-sm" onClick={() => setAsk(true)}>Request a Change</button>}</span>
      </div>
      {l.edited && l.editReason && <small style={{ color: 'var(--mut)', display: 'block' }}>Changed by the office: {l.editReason}</small>}
      {l.pendingChange && <div className="mg-note" style={{ marginTop: 4 }}>{l.pendingChange.self ? 'You asked' : `${l.pendingChange.by} asked`} to change this to {clockOf(l.pendingChange.clockIn)} to {clockOf(l.pendingChange.clockOut)}. Waiting on the office.</div>}
      {ask && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(130px,1fr))', gap: 8, margin: '6px 0' }}>
          <div><label>Date</label><input type="date" value={f.date} onChange={e => setF({ ...f, date: e.target.value })} /></div>
          <div><label>Clock in</label><input type="time" value={f.tin} onChange={e => setF({ ...f, tin: e.target.value })} /></div>
          <div><label>Clock out</label><input type="time" value={f.tout} onChange={e => setF({ ...f, tout: e.target.value })} /></div>
          <div style={{ gridColumn: '1 / -1' }}><label>Why</label><input type="text" maxLength={1000} placeholder="I forgot to clock out at 5:00" value={f.reason} onChange={e => setF({ ...f, reason: e.target.value })} /></div>
          <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 8 }}><button className="mg-btn mg-sm" disabled={busy || !f.reason.trim()} onClick={send}>Send to the Office</button><button className="mg-btn mg-ghost mg-sm" onClick={() => setAsk(false)}>Cancel</button></div>
        </div>
      )}
      {err && <div className="mg-err">{err}</div>}
    </div>
  );
}
function TimesheetCard({ t, onSaved }) {
  const [open, setOpen] = useState(() => t.lines.some(l => l.pendingChange));
  const [flag, setFlag] = useState(false); const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const send = async (status) => {
    setBusy(true); setErr('');
    try { await call(`/api/my/timesheets/${encodeURIComponent(t.schedule)}/${encodeURIComponent(t.period.start)}`, { method: 'POST', body: { status, note } }); setFlag(false); setNote(''); await onSaved(); }
    catch (e) { setErr(e.message); }
    setBusy(false);
  };
  const [label, pill] = t.paid ? ['Paid', 'mg-ok'] : (OFFICE_LABEL[t.status.office] || OFFICE_LABEL.waiting);
  const tot = t.paid && t.paidMinutes !== null ? t.paidMinutes : t.totals.minutes;
  return (
    <div className="mp-item" style={{ display: 'block' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center' }}>
        <div><b>{t.period.start} to {t.period.end}</b>
          <small>{hm(tot)}{t.totals.visits ? ` · ${t.totals.visits} visit${t.totals.visits === 1 ? '' : 's'}` : ''}{t.totals.exams ? ` · ${t.totals.exams} exam${t.totals.exams === 1 ? '' : 's'}` : ''} · paid {t.period.payDate}{!t.ended ? ' · this period is still going' : ''}</small></div>
        <span className={`mg-pill ${pill}`}>{label}</span>
      </div>
      {t.office && t.office.status === 'sent_back' && !t.paid && <div className="mg-err" style={{ marginTop: 8 }}>The office says: {t.office.note}</div>}
      {t.openClockIns.length > 0 && <div className="mg-note" style={{ marginTop: 8 }}>You are still clocked in from {t.openClockIns.map(o => o.date).join(', ')}. Clock out, or ask the office to fix it, or that shift is not paid.</div>}
      {t.cannotPay.length > 0 && <div className="mg-note" style={{ marginTop: 8 }}>Not counted yet: {t.cannotPay.join(' ')}</div>}
      {!t.paid && <small style={{ display: 'block', color: 'var(--mut)', marginTop: 6 }}>{EMP_LABEL[t.status.employee]}{t.employee && t.employee.note ? `: ${t.employee.note}` : ''}</small>}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
        <button className="mg-btn mg-ghost mg-sm" onClick={() => setOpen(!open)}>{open ? 'Hide Hours' : `See Hours (${t.lines.length})`}</button>
        {!t.paid && t.ended && t.status.employee !== 'confirmed' && <button className="mg-btn mg-sm" disabled={busy} onClick={() => send('confirmed')}>Looks Right</button>}
        {!t.paid && t.ended && !flag && <button className="mg-btn mg-ghost mg-sm" disabled={busy} onClick={() => setFlag(true)}>Something Is Wrong</button>}
      </div>
      {flag && (
        <div style={{ marginTop: 8 }}>
          <label>What is wrong? The office will correct it.</label>
          <textarea rows={3} style={{ width: '100%', border: '1px solid var(--edge2)', borderRadius: 11, padding: 10, font: 'inherit' }} value={note} maxLength={600} onChange={e => setNote(e.target.value)} />
          <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
            <button className="mg-btn mg-sm" disabled={busy || !note.trim()} onClick={() => send('flagged')}>Send to the Office</button>
            <button className="mg-btn mg-ghost mg-sm" onClick={() => { setFlag(false); setNote(''); }}>Cancel</button>
          </div>
        </div>
      )}
      {err && <div className="mg-err" style={{ marginTop: 8 }}>{err}</div>}
      {open && (
        <div style={{ marginTop: 8 }}>
          {t.lines.length === 0 && <small style={{ color: 'var(--mut)' }}>No hours recorded{t.paid ? ' still waiting (this period is paid)' : ''}.</small>}
          {t.lines.map(l => <MyLine key={l.ref} l={l} paid={t.paid} onSaved={onSaved} />)}
        </div>
      )}
    </div>
  );
}
function Timesheets() {
  const [d, setD] = useState(null); const [err, setErr] = useState('');
  const load = () => call('/api/my/timesheets').then(setD).catch(e => setErr(e.message));
  useEffect(() => { load(); }, []);
  if (err) return <div className="mg-err">{err}</div>;
  if (!d) return <p className="mg-note">Loading…</p>;
  if (!d.employee) return <p className="mg-note">Contractors send invoices instead. See Contractor Invoices below.</p>;
  return <div className="mp-items">{d.timesheets.map(t => <TimesheetCard key={t.period.start} t={t} onSaved={load} />)}</div>;
}

window.MyPay = { PaySetup, ContractorInvoices, TaxForms, Timesheets };
})();
