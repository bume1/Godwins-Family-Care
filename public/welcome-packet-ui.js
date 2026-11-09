// ============================================================================
// THE WELCOME PACKET, SHARED (owner, 2026-11-09: "exactly the same welcome
// packet format as the caregivers"). One field renderer and one signature pad,
// used by the caregiver app's welcome packet and by the staff welcome packet in
// My GFC, plus the staff packet's wizard. Loaded as <script type="text/babel"
// src>, an IIFE exporting window.GFCWelcomePacketUI.
//
// The caregiver app styles these with its own sheet. Anywhere else they sit
// inside `.wpk`, which carries the same look, injected once.
// ============================================================================
(function () {
const { useState, useEffect, useRef, useCallback } = React;

(function injectCss() {
  if (document.getElementById('wpk-css')) return;
  const el = document.createElement('style');
  el.id = 'wpk-css';
  el.textContent = `.wpk{--navy:#033D50;--gold:#C9A44A;--cream:#FAF7F2;--ink:#1a2a32;--mut:#6f6a60;--red:#B5462E}
.wpk .sub{font-size:14px;color:var(--mut);margin-bottom:16px}
.wpk .card{background:#fff;border:1px solid #ECE4D6;border-radius:16px;padding:16px 18px;margin-bottom:14px;box-shadow:0 1px 2px rgba(3,61,80,.04),0 6px 18px -12px rgba(3,61,80,.18)}
.wpk .card h3{font-family:'Cormorant Garamond',serif;font-size:19px;color:var(--navy);font-weight:600;margin:0 0 6px}
.wpk .btn{display:block;width:100%;background:var(--navy);color:var(--cream);border:1px solid var(--navy);border-radius:10px;padding:14px;font-size:16px;font-weight:600;cursor:pointer;font-family:inherit;margin:0 0 10px;text-align:center;text-decoration:none}
.wpk .btn.gold{background:var(--gold);border-color:var(--gold);color:var(--navy)}
.wpk .btn.ghost{background:#fff;color:var(--navy)}
.wpk .btn:disabled{opacity:.5;cursor:not-allowed}
.wpk .fld{margin-bottom:13px}
.wpk .fld label{display:block;font-size:12px;letter-spacing:.5px;text-transform:uppercase;color:var(--mut);margin-bottom:5px;font-weight:600}
.wpk .inp{width:100%;box-sizing:border-box;background:#fff;border:1px solid #ddd3c0;border-radius:9px;padding:12px;font-size:16px;color:var(--ink);font-family:inherit}
.wpk textarea.inp{min-height:88px;resize:vertical}
.wpk .chips{display:flex;flex-wrap:wrap;gap:8px}
.wpk .chip{border:1.5px solid #d8cdb8;background:#fff;border-radius:20px;padding:8px 14px;font-size:15px;color:var(--navy);cursor:pointer;font-family:inherit}
.wpk .chip.on{background:var(--navy);border-color:var(--navy);color:var(--gold)}
.wpk .lvl{font-size:12px;background:rgba(245,205,133,.16);color:#9A7430;border:1px solid rgba(245,205,133,.5);border-radius:14px;padding:3px 11px}
.wpk .err{background:#fdeeee;border:1px solid #e7bcbc;color:#7d2020;border-radius:9px;padding:12px;font-size:15px;margin-bottom:13px}
.wpk .ok{background:#eef6f1;border:1px solid #bfdccc;color:#1d5b40;border-radius:9px;padding:12px;font-size:15px;margin-bottom:13px}
.wpk .mu{color:var(--mut)}`;
  document.head.appendChild(el);
})();

const SignaturePad = ({ onChange }) => {
  const canvasRef = useRef(null);
  const drawing = useRef(false);
  const dirty = useRef(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // Drawn at device resolution, or a signature on a phone comes out furry.
    const ratio = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * ratio;
    canvas.height = rect.height * ratio;
    const ctx = canvas.getContext('2d');
    ctx.scale(ratio, ratio);
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#0d2438';
  }, []);

  const pointFrom = (e) => {
    const rect = canvasRef.current.getBoundingClientRect();
    const source = e.touches ? e.touches[0] : e;
    return { x: source.clientX - rect.left, y: source.clientY - rect.top };
  };

  const start = (e) => {
    e.preventDefault();
    drawing.current = true;
    const ctx = canvasRef.current.getContext('2d');
    const p = pointFrom(e);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
  };
  const move = (e) => {
    if (!drawing.current) return;
    e.preventDefault();
    const ctx = canvasRef.current.getContext('2d');
    const p = pointFrom(e);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    dirty.current = true;
  };
  const end = () => {
    if (!drawing.current) return;
    drawing.current = false;
    if (dirty.current) onChange(canvasRef.current.toDataURL('image/png'));
  };
  const clear = () => {
    const canvas = canvasRef.current;
    canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
    dirty.current = false;
    onChange(null);
  };

  return (
    <div>
      <canvas ref={canvasRef}
        style={{ width: '100%', height: 150, border: '1.5px dashed #d8cdb8', borderRadius: 10, background: '#fff', touchAction: 'none' }}
        onMouseDown={start} onMouseMove={move} onMouseUp={end} onMouseLeave={end}
        onTouchStart={start} onTouchMove={move} onTouchEnd={end} />
      <button type="button" className="btn ghost" style={{ marginTop: 8 }} onClick={clear}>Clear Signature</button>
    </div>
  );
};

// One field, rendered from its served definition. Nothing here knows what any
// particular question is.
const PacketField = ({ field, value, onChange, imported }) => {
  const set = (v) => onChange(field.id, v);

  const label = (
    <label>
      {field.label}
      {field.required ? <span style={{ color: '#b3261e' }}> *</span> : null}
      {imported ? <span className="lvl" style={{ marginLeft: 8, fontSize: 10 }}>from your packet — check this</span> : null}
    </label>
  );

  if (field.type === 'single') {
    return (
      <div className="fld">
        {label}
        <div className="chips">
          {field.options.map(o => (
            <button type="button" key={o.value}
              className={`chip ${value === o.value ? 'on' : ''}`}
              onClick={() => set(value === o.value ? '' : o.value)}>{o.label}</button>
          ))}
        </div>
      </div>
    );
  }

  if (field.type === 'multi') {
    const picked = Array.isArray(value) ? value : [];
    return (
      <div className="fld">
        {label}
        {field.hint ? <p className="sub" style={{ marginBottom: 8 }}>{field.hint}</p> : null}
        <div className="chips">
          {field.options.map(o => (
            <button type="button" key={o.value}
              className={`chip ${picked.includes(o.value) ? 'on' : ''}`}
              onClick={() => set(picked.includes(o.value) ? picked.filter(v => v !== o.value) : [...picked, o.value])}>
              {o.label}
            </button>
          ))}
        </div>
      </div>
    );
  }

  if (field.type === 'grid') {
    const grid = (value && typeof value === 'object') ? value : {};
    return (
      <div className="fld">
        {label}
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', padding: '6px 4px', color: '#6f6a60', fontWeight: 600 }}></th>
                {field.columns.map(c => (
                  <th key={c.value} style={{ padding: '6px 4px', color: '#6f6a60', fontWeight: 600, fontSize: 11 }}>{c.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {field.rows.map(r => (
                <tr key={r.value} style={{ borderTop: '1px solid #ece6db' }}>
                  <td style={{ padding: '8px 4px', fontWeight: 600, color: '#0d2438' }}>{r.label}</td>
                  {field.columns.map(c => {
                    const on = (grid[r.value] || []).includes(c.value);
                    return (
                      <td key={c.value} style={{ padding: '6px 4px', textAlign: 'center' }}>
                        <button type="button"
                          aria-label={`${r.label} ${c.label}`}
                          aria-pressed={on}
                          className={`chip ${on ? 'on' : ''}`}
                          style={{ padding: '6px 10px', minWidth: 36 }}
                          onClick={() => {
                            const current = grid[r.value] || [];
                            const next = on ? current.filter(v => v !== c.value) : [...current, c.value];
                            set({ ...grid, [r.value]: next });
                          }}>{on ? '✓' : ''}</button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  if (field.type === 'rows') {
    const rows = Array.isArray(value) ? value : [];
    return (
      <div className="fld">
        {label}
        {Array.from({ length: field.rowCount }).map((_, i) => (
          <div key={i} className="card" style={{ marginBottom: 10 }}>
            <p className="sub" style={{ marginBottom: 8 }}>Reference {i + 1}</p>
            {field.rowFields.map(rf => (
              <div className="fld" key={rf.id} style={{ marginBottom: 9 }}>
                <label>{rf.label}</label>
                <input className="inp" type={rf.type === 'tel' ? 'tel' : 'text'}
                  value={(rows[i] || {})[rf.id] || ''}
                  onChange={(e) => {
                    const next = Array.from({ length: field.rowCount }).map((__, j) => ({ ...(rows[j] || {}) }));
                    next[i][rf.id] = e.target.value;
                    set(next);
                  }} />
              </div>
            ))}
          </div>
        ))}
      </div>
    );
  }

  if (field.type === 'textarea') {
    return (
      <div className="fld">
        {label}
        {field.hint ? <p className="sub" style={{ marginBottom: 8 }}>{field.hint}</p> : null}
        <textarea className="inp" rows={4} value={value || ''} maxLength={field.max || 2000}
          onChange={(e) => set(e.target.value)} />
      </div>
    );
  }

  const inputType = field.type === 'date' ? 'date' : (field.type === 'email' ? 'email' : (field.type === 'tel' ? 'tel' : 'text'));
  return (
    <div className="fld">
      {label}
      <input className="inp" type={inputType} value={value || ''} maxLength={field.max || undefined}
        onChange={(e) => set(e.target.value)} />
    </div>
  );
};


// ---- the staff welcome packet's wizard ----------------------------------------
const tokenOf = () => localStorage.getItem('admin_token') || localStorage.getItem('unified_token') || localStorage.getItem('portal_token');
const req = async (path, opts = {}) => {
  const res = await fetch(path, { method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenOf()}` },
    body: opts.body ? JSON.stringify(opts.body) : undefined });
  let data = null; try { data = await res.json(); } catch (e) { /* empty */ }
  if (!res.ok) { const e = new Error((data && data.error) || `Request failed (${res.status})`); e.data = data; throw e; }
  return data;
};
const downloadPdf = async (path, name) => {
  const res = await fetch(path, { headers: { Authorization: `Bearer ${tokenOf()}` } });
  if (!res.ok) throw new Error('That packet could not be opened.');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(await res.blob()); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
};

// The shared availability form, mounted for step 3. It lives in the
// scheduling area afterwards, so it is never a copy kept in the packet.
const AvailabilityMount = () => {
  const id = 'wpk-availability';
  useEffect(() => {
    const lib = window.GFCCaregiverSchedule;
    if (!lib) return undefined;
    lib.mount(id, { authToken: tokenOf(), onlyTabs: ['availability'] });
    return () => lib.unmount(id);
  }, []);
  return <div id={id} />;
};

const AVAILABILITY_STEP = 'availability';
const StaffWelcomePacket = ({ onDone }) => {
  const [packet, setPacket] = useState(null);
  const [data, setData] = useState({});
  const [step, setStep] = useState('start');
  const [signature, setSignature] = useState(null);
  const [printedName, setPrintedName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [missing, setMissing] = useState([]);

  const load = useCallback(async () => {
    const p = await req('/api/my/welcome-packet');
    setPacket(p); setData(p.data || {}); setMissing(p.missing || []);
    return p;
  }, []);
  useEffect(() => { load().catch(e => setErr(e.message)); }, [load]);

  if (err && !packet) return <div className="wpk"><div className="err">{err}</div></div>;
  if (!packet) return <div className="wpk"><p className="sub">Loading…</p></div>;

  if (packet.status === 'submitted') {
    return (
      <div className="wpk">
        <div className="ok">Your welcome packet is signed{packet.signedAt ? ` (${new Date(packet.signedAt).toLocaleDateString('en-US')})` : ''}. Thank you.</div>
        <button className="btn ghost" onClick={() => downloadPdf('/api/my/welcome-packet/signed.pdf', 'GFC Welcome Packet.pdf').catch(e => setErr(e.message))}>Download My Completed Packet</button>
        {err && <div className="err">{err}</div>}
      </div>
    );
  }

  // Sections in number order, with the availability step as number 3.
  const ordered = packet.sections.slice().sort((a, b) => a.number - b.number);
  const steps = ['start'];
  ordered.forEach(s => { if (s.number > 3 && !steps.includes(AVAILABILITY_STEP)) steps.push(AVAILABILITY_STEP); steps.push(s.id); });
  if (!steps.includes(AVAILABILITY_STEP)) steps.push(AVAILABILITY_STEP);
  steps.push('sign');
  const index = steps.indexOf(step);
  const section = ordered.find(s => s.id === step) || null;
  const progress = Math.round((index / (steps.length - 1)) * 100);

  const save = async () => {
    setBusy(true); setErr('');
    try { const r = await req('/api/my/welcome-packet', { method: 'PUT', body: { data } }); setMissing(r.missing || []); return true; }
    catch (e) { setErr(e.message); return false; } finally { setBusy(false); }
  };
  const go = async (target) => {
    if (section && !(await save())) return;
    if (step === AVAILABILITY_STEP && steps.indexOf(target) > index) {
      const p = await load();
      if (!p.availabilityOnFile) { setErr('Submit your availability above before you continue.'); return; }
    }
    setErr(''); setStep(target); window.scrollTo(0, 0);
  };
  const submit = async () => {
    setBusy(true); setErr('');
    try {
      await req('/api/my/welcome-packet/submit', { method: 'POST', body: { data, signaturePng: signature, printedName } });
      await load(); onDone && onDone();
    } catch (e) {
      setErr(e.message);
      if (e.data && e.data.missing) {
        setMissing(e.data.missing);
        const first = e.data.missing[0];
        if (first && steps.includes(first.section)) setStep(first.section);
      }
    }
    setBusy(false);
  };

  return (
    <div className="wpk">
      <div style={{ height: 4, background: '#ece6db', borderRadius: 3, marginBottom: 16 }}>
        <div style={{ height: '100%', width: `${progress}%`, background: '#c9a227', borderRadius: 3, transition: 'width .2s' }} />
      </div>
      {err && <div className="err">{err}</div>}

      {step === 'start' && (
        <div>
          <div className="card">
            <h3>Welcome to the Godwins Family Care team!</h3>
            <p className="sub">A short welcome packet: how to reach you, your emergency contact, your availability, and how you like to learn and be contacted. About five minutes. It saves as you go.</p>
          </div>
          <button className="btn" onClick={() => go(steps[1])}>Fill In Here</button>
        </div>
      )}

      {section && (
        <div>
          <div className="card">
            <h3>{section.number}. {section.title}</h3>
            {section.intro ? <p className="sub">{section.intro}</p> : null}
            {section.fields.map(field => (
              <PacketField key={field.id} field={field} value={data[field.id]}
                onChange={(fid, v) => setData(d => ({ ...d, [fid]: v }))} />
            ))}
          </div>
          <button className="btn" disabled={busy} onClick={() => go(steps[index + 1])}>{busy ? 'Saving…' : 'Save & Continue'}</button>
          {index > 1 && <button className="btn ghost" disabled={busy} onClick={() => go(steps[index - 1])}>Back</button>}
        </div>
      )}

      {step === AVAILABILITY_STEP && (
        <div>
          <div className="card">
            <h3>3. Your Availability</h3>
            <p className="sub">Submit the days and hours you are available. It is saved to your scheduling area, where you can update it any time.</p>
            <AvailabilityMount />
          </div>
          <button className="btn" disabled={busy} onClick={() => go(steps[index + 1])}>Continue</button>
          <button className="btn ghost" disabled={busy} onClick={() => go(steps[index - 1])}>Back</button>
        </div>
      )}

      {step === 'sign' && (
        <div>
          {missing.length > 0 && (
            <div className="err">Still needed before you can sign:
              <ul style={{ margin: '8px 0 0 18px' }}>{missing.map(m => <li key={m.id}>{m.label} <span className="mu">({m.sectionTitle})</span></li>)}</ul>
            </div>
          )}
          <div className="card">
            <h3>Sign your packet</h3>
            <p className="sub">{packet.signNote}</p>
            <div className="fld"><label>Printed name</label>
              <input className="inp" type="text" value={printedName} onChange={(e) => setPrintedName(e.target.value)} placeholder="Type your name as it should appear" /></div>
            <div className="fld"><label>Signature</label><SignaturePad onChange={setSignature} /></div>
          </div>
          <button className="btn gold" disabled={busy || !signature || !printedName.trim()} onClick={submit}>{busy ? 'Submitting…' : 'Submit Packet'}</button>
          <button className="btn ghost" disabled={busy} onClick={() => go(steps[index - 1])}>Back</button>
        </div>
      )}
    </div>
  );
};

window.GFCWelcomePacketUI = { PacketField, SignaturePad, StaffWelcomePacket, downloadPdf };
})();
