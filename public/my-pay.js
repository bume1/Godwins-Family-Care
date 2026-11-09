// ============================================================================
// MY PAY — the payroll pieces of My GFC's Hours & Pay section (2026-11-08)
// ============================================================================
// Loaded before /my-gfc.js on /my and /caregiver. Exports window.MyPay, which
// my-gfc.js draws inside Hours & Pay beside the pay stubs it already lists:
//   PaySetup            W-4, G-4, I-9, SSN, W-9, how you are paid, offer
//                       letter, handbook, electronic tax forms
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
  if (which === 'i9') return (
    <div>
      <label>Section 1: I attest that I am</label>
      <select value={form.status || ''} onChange={e => set({ ...form, status: e.target.value })}>
        <option value="">Choose…</option>{Object.entries(o.i9Status).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
      </select>
      {form.status === 'authorized' && <div><label>Work authorization expires (if it does)</label><input type="date" value={form.workAuthExpires || ''} onChange={e => set({ ...form, workAuthExpires: e.target.value })} /></div>}
      <p className="mg-note">Bring your identity and work authorization documents to the office. They complete Section 2 when they see them.</p>
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
  if (which === 'offer' || which === 'handbook') return (
    <Sign statement={which === 'offer' ? 'I have received and read my offer letter and accept its terms.' : 'I have received the Godwins Family Care employee handbook, and I agree to read it and follow it.'} form={form} set={set} />
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

const ROUTE = { w4: 'w4', g4: 'g4', i9: 'i9', ssn: 'ssn', w9: 'w9', pay: 'pay-method', taxaddress: 'tax-address', offer: 'offer', handbook: 'handbook', edelivery: 'e-delivery' };

function PaySetup() {
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(null);
  const [form, setForm] = useState({});
  const [err, setErr] = useState(''); const [msg, setMsg] = useState(''); const [busy, setBusy] = useState(false);
  const load = () => call('/api/my/pay-setup').then(setData).catch(e => setErr(e.message));
  useEffect(() => { load(); }, []);
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
      {!data.secretsStorable && <div className="mg-note">The office has not switched on secure storage yet, so bank and tax ID numbers cannot be saved. The forms still save.</div>}
      {err && <div className="mg-err">{err}</div>}
      {msg && <p style={{ color: 'var(--green)', margin: '0 0 8px' }}>{msg}</p>}
      <div className="mp-items">
        {p.checklist.map(c => (
          <div key={c.key} className="mp-item">
            <div><b>{c.label}</b><small>{c.done ? (detail(c.key) || 'Done') : c.optional ? 'Optional' : 'Not done yet'}{c.note ? ` · ${c.note}` : ''}</small></div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span className={`mg-pill ${c.done ? 'mg-ok' : c.optional ? 'mg-wait' : 'mg-bad'}`}>{c.done ? 'Done' : 'To do'}</span>
              <button className="mg-btn mg-ghost mg-sm" onClick={() => { setOpen(open === c.key ? null : c.key); setForm(c.key === 'edelivery' ? { consented: !!(p.eDelivery && p.eDelivery.consented), disclosureVersion: data.options && data.options.eDelivery && data.options.eDelivery.version } : c.key === 'taxaddress' && p.taxAddress ? { ...p.taxAddress, zip: `${p.taxAddress.zip || ''}${p.taxAddress.zip4 || ''}` } : {}); setErr(''); }}>{c.done ? 'Update' : 'Start'}</button>
            </div>
          </div>
        ))}
      </div>
      {open && (
        <div className="mg-card" style={{ boxShadow: 'none' }}>
          <FormBody which={open} data={data} form={form} set={setForm} />
          <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
            <button className="mg-btn" disabled={busy} onClick={save}>{['offer', 'handbook', 'w4', 'g4', 'i9', 'w9'].includes(open) ? 'Sign and Save' : 'Save'}</button>
            <button className="mg-btn mg-ghost" onClick={() => { setOpen(null); setForm({}); }}>Cancel</button>
          </div>
        </div>
      )}
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

window.MyPay = { PaySetup, ContractorInvoices, TaxForms };
})();
