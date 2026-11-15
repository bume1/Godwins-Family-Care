// ============================================================================
// DOCUMENTS TO REVIEW OR SIGN: the shared screens (owner, 2026-11-09)
// ============================================================================
// Loaded by My GFC (my.html, caregiver.html), the admin hub and the onboarding
// page, so a staff member signs a document the same way wherever they meet it,
// and the office sends one the same way from a person's record or by type.
//
//   GFCDocSign.WaitingOnYou   the staff member's list: open, acknowledge, sign
//   GFCDocSign.OfficeDocuments the office: send a document, see who has done it
//
// The signature pad is the shared one in /welcome-packet-ui.js. Every class
// starts with `ds-` so the page's own styles never reach it.
// ============================================================================
(function () {
const { useState, useEffect, useCallback } = React;

(function injectStyles() {
  if (document.getElementById('docsign-styles')) return;
  const el = document.createElement('style');
  el.id = 'docsign-styles';
  el.textContent = `.ds{--n:#033D50;--g:#C9A44A;--m:#41555f;--e:#E1D7C5;--w:#F6EFE2;--ok:#1d7a5a;--bad:#B5462E;font-family:'DM Sans',system-ui,sans-serif;color:#1a2a32}
.ds *{box-sizing:border-box}
.ds-row{display:flex;align-items:center;gap:10px;padding:11px 2px;border-bottom:1px solid #ECE4D6;flex-wrap:wrap}
.ds-row:last-child{border-bottom:0}
.ds-grow{flex:1;min-width:180px} .ds-grow b{display:block;color:var(--n);font-weight:700;overflow-wrap:anywhere} .ds-grow small{display:block;color:var(--m);font-size:13px}
.ds-btn{display:inline-flex;align-items:center;gap:6px;border-radius:10px;padding:8px 13px;font:600 14px/1.3 inherit;font-family:inherit;cursor:pointer;border:1px solid var(--n);background:var(--n);color:#fff;width:auto;margin:0}
.ds-btn.ds-ghost{background:#fff;color:var(--n);border:1.5px solid var(--e)}
.ds-btn.ds-warn{background:#fff;color:var(--bad);border:1.5px solid rgba(181,70,46,.4)}
.ds-btn[disabled]{opacity:.5;cursor:not-allowed}
.ds-pill{display:inline-flex;border-radius:999px;padding:3px 10px;font-size:12.5px;font-weight:600;background:var(--w);color:var(--n);white-space:nowrap}
.ds-pill.ds-ok{background:#e7f4ee;color:var(--ok)} .ds-pill.ds-wait{background:#FBF1DC;color:#6b5121}
.ds-box{border:1px solid var(--e);border-radius:14px;padding:14px;margin:8px 0 12px;background:#fff}
.ds label.ds-l{display:block;font-size:13px;font-weight:600;color:var(--m);margin:12px 0 5px}
.ds input[type=text],.ds textarea,.ds select{width:100%;background:#fff;border:1px solid var(--e);border-radius:10px;padding:10px 12px;font:inherit;color:#1a2a32}
.ds .ds-check{display:flex;gap:8px;align-items:flex-start;font-size:14px;margin:8px 0;font-weight:500;color:#1a2a32}
.ds .ds-check input{width:auto;margin-top:3px}
.ds-note{background:var(--w);border:1px solid #ECE4D6;border-radius:12px;padding:11px 13px;color:var(--m);font-size:14px;margin:6px 0}
.ds-err{background:#fdecea;border:1px solid rgba(181,70,46,.3);color:var(--bad);border-radius:10px;padding:10px 12px;margin:8px 0;font-size:14px}
.ds-okmsg{background:#e7f4ee;color:var(--ok);border-radius:10px;padding:10px 12px;margin:8px 0;font-size:14px}
.ds-acts{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
.ds-who{font-size:13px;color:var(--m);margin-top:4px}
.ds button.btn{display:inline-flex;align-items:center;border-radius:10px;padding:7px 12px;font:600 13.5px/1.3 inherit;font-family:inherit;cursor:pointer;background:#fff;color:var(--n);border:1.5px solid var(--e);width:auto}`;
  document.head.appendChild(el);
})();

const getToken = () => localStorage.getItem('admin_token') || localStorage.getItem('unified_token') || localStorage.getItem('portal_token');
const call = async (path, opts = {}) => {
  const isForm = typeof FormData !== 'undefined' && opts.body instanceof FormData;
  const headers = { Authorization: `Bearer ${getToken()}` };
  if (!isForm) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, { method: opts.method || 'GET', headers,
    body: opts.body ? (isForm ? opts.body : JSON.stringify(opts.body)) : undefined });
  let data = null; try { data = await res.json(); } catch (_) { /* empty */ }
  if (!res.ok) { const e = new Error((data && data.error) || `Request failed (${res.status})`); e.code = data && data.code; throw e; }
  return data;
};
// Opens through the app, token in the header. A new tab where the browser
// allows it; otherwise it downloads, so a phone that blocks the tab still
// gets the document.
const openPdf = async (path, name) => {
  const res = await fetch(path, { headers: { Authorization: `Bearer ${getToken()}` } });
  if (!res.ok) { let m = 'That document could not be opened.'; try { m = (await res.json()).error || m; } catch (_) {} throw new Error(m); }
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url; a.target = '_blank'; a.rel = 'noopener';
  if (/iPhone|iPad|iPod/.test(navigator.userAgent)) a.download = name || 'document.pdf';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
};
const TZ = window.GFC_TIME && window.GFC_TIME.PRACTICE_TIMEZONE;
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: TZ }) : '');
const verb = (action) => (action === 'sign' ? 'Sign' : 'Acknowledge');
const done = (action) => (action === 'sign' ? 'Signed' : 'Acknowledged');

// ---- The staff member ---------------------------------------------------------
// Open the document, then acknowledge or sign it. Nothing is recorded by
// opening it; the button records it.
function SignPanel({ doc, onDone, onCancel }) {
  const [name, setName] = useState('');
  const [ack, setAck] = useState(false);
  const [sig, setSig] = useState('');
  const [opened, setOpened] = useState(false);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const Pad = window.GFCWelcomePacketUI && window.GFCWelcomePacketUI.SignaturePad;
  const open = () => openPdf(`/api/my/document-sends/${encodeURIComponent(doc.id)}/file`, doc.fileName).then(() => setOpened(true)).catch(e => setErr(e.message));
  const ready = name.trim() && ack && (doc.action !== 'sign' || sig);
  const submit = async () => {
    setBusy(true); setErr('');
    try {
      await call(`/api/my/document-sends/${encodeURIComponent(doc.id)}/sign`, { method: 'POST',
        body: { printedName: name.trim(), acknowledged: ack, signaturePng: doc.action === 'sign' ? sig : undefined } });
      await onDone();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <div className="ds-box">
      {doc.note && <div className="ds-note">{doc.note}</div>}
      <button className="ds-btn ds-ghost" onClick={open}><i className="ti ti-file-text" />Open Document</button>
      {!opened && <div className="ds-who">Read it before you {doc.action === 'sign' ? 'sign' : 'acknowledge'} it.</div>}
      <label className="ds-check"><input type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)} />
        <span>I have read and understood this document{doc.action === 'sign' ? ', and I agree to it' : ''}.</span></label>
      <label className="ds-l">Your full name</label>
      <input type="text" value={name} maxLength={160} onChange={e => setName(e.target.value)} autoComplete="name" />
      {doc.action === 'sign' && (
        <div>
          <label className="ds-l">Your signature</label>
          {Pad ? <Pad onChange={setSig} /> : <div className="ds-note">Loading the signature pad…</div>}
        </div>
      )}
      <div className="ds-who">Your {doc.action === 'sign' ? 'signed' : 'acknowledged'} copy files to My Documents, where you and the office can open it.</div>
      {err && <div className="ds-err">{err}</div>}
      <div className="ds-acts">
        <button className="ds-btn" disabled={busy || !ready} onClick={submit}>{busy ? 'Saving…' : verb(doc.action)}</button>
        {onCancel && <button className="ds-btn ds-ghost" disabled={busy} onClick={onCancel}>Cancel</button>}
      </div>
    </div>
  );
}

// `only` limits the list to one sent document (the onboarding drawer).
function WaitingOnYou({ only, showDone = true, onChanged, emptyText }) {
  const [d, setD] = useState(null); const [err, setErr] = useState(''); const [open, setOpen] = useState(only || null);
  const [msg, setMsg] = useState('');
  const load = useCallback(() => call('/api/my/document-sends').then(setD).catch(e => setErr(e.message)), []);
  useEffect(() => { load(); }, [load]);
  if (err) return <div className="ds"><div className="ds-err">{err}</div></div>;
  if (!d) return <div className="ds"><div className="ds-note">Loading…</div></div>;
  const pick = (list) => (only ? list.filter(x => x.id === only) : list);
  const waiting = pick(d.waiting); const finished = pick(d.done);
  const after = async (doc) => { setOpen(null); setMsg(`${done(doc.action)}. Your copy is in My Documents.`); await load(); if (onChanged) await onChanged(); };
  return (
    <div className="ds">
      {msg && <div className="ds-okmsg">{msg}</div>}
      {!waiting.length && !finished.length && <div className="ds-note">{emptyText || 'Nothing is waiting on you.'}</div>}
      {waiting.map(x => (
        <div key={x.id}>
          <div className="ds-row">
            <i className="ti ti-signature" style={{ fontSize: 22, color: 'var(--n)' }} />
            <div className="ds-grow"><b>{x.title}</b><small>Sent {fmtDate(x.sentAt)}{x.sentByName ? ` by ${x.sentByName}` : ''} · to {x.action === 'sign' ? 'sign' : 'acknowledge'}</small></div>
            <span className="ds-pill ds-wait">Waiting on you</span>
            {open !== x.id && <button className="ds-btn" onClick={() => setOpen(x.id)}>{verb(x.action)}</button>}
          </div>
          {open === x.id && <SignPanel doc={x} onDone={() => after(x)} onCancel={only ? null : () => setOpen(null)} />}
        </div>
      ))}
      {showDone && finished.map(x => (
        <div className="ds-row" key={x.id}>
          <i className="ti ti-circle-check" style={{ fontSize: 22, color: 'var(--ok)' }} />
          <div className="ds-grow"><b>{x.title}</b><small>{done(x.action)} {fmtDate(x.doneAt)}</small></div>
          {x.documentId && <button className="ds-btn ds-ghost" onClick={() => openPdf(`/api/my/documents/${encodeURIComponent(x.documentId)}/file`, `${x.title}.pdf`).catch(e => setErr(e.message))}>Open My Copy</button>}
        </div>
      ))}
    </div>
  );
}

// ---- The office ---------------------------------------------------------------
// Send a document: to one person (`userId`) or, with no userId, to everyone of
// the chosen types, now and later.
function SendForm({ userId, userName, types, onSent, onCancel }) {
  const [f, setF] = useState({ title: '', note: '', action: 'sign', types: [] });
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const set = (k, v) => setF(Object.assign({}, f, { [k]: v }));
  const toggle = (t) => set('types', f.types.includes(t) ? f.types.filter(x => x !== t) : f.types.concat([t]));
  const ready = f.title.trim() && file && (userId || f.types.length);
  const send = async () => {
    setBusy(true); setErr('');
    try {
      const fd = new FormData();
      fd.append('file', file); fd.append('title', f.title.trim()); fd.append('note', f.note); fd.append('action', f.action);
      fd.append('scope', JSON.stringify(userId ? { userId } : { types: f.types }));
      const out = await call('/api/my/admin/document-sends', { method: 'POST', body: fd });
      await onSent(out.send);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <div className="ds-box">
      <label className="ds-l">Document name</label>
      <input type="text" value={f.title} maxLength={200} onChange={e => set('title', e.target.value)} placeholder="e.g. Employment Agreement 2027" />
      <label className="ds-l">The PDF</label>
      <input type="file" accept="application/pdf,.pdf" onChange={e => setFile(e.target.files[0] || null)} />
      <label className="ds-l">What they do with it</label>
      <label className="ds-check"><input type="radio" checked={f.action === 'sign'} onChange={() => set('action', 'sign')} /><span><b>Sign</b>: they draw their signature and type their name</span></label>
      <label className="ds-check"><input type="radio" checked={f.action === 'acknowledge'} onChange={() => set('action', 'acknowledge')} /><span><b>Acknowledge</b>: they confirm they read it and type their name</span></label>
      <label className="ds-l">A note for them (optional)</label>
      <textarea rows={2} value={f.note} maxLength={1000} onChange={e => set('note', e.target.value)} placeholder="What it is, and anything they should know" />
      {userId ? <div className="ds-who">Goes to {userName || 'this person'} only.</div> : (
        <div>
          <label className="ds-l">Who gets it (everyone of these types, now and later)</label>
          <label className="ds-check"><input type="checkbox" checked={f.types.includes('all')} onChange={() => toggle('all')} /><span>All staff</span></label>
          {!f.types.includes('all') && (types || []).map(t => (
            <label key={t.id} className="ds-check"><input type="checkbox" checked={f.types.includes(t.id)} onChange={() => toggle(t.id)} /><span>{t.label}</span></label>
          ))}
        </div>
      )}
      <div className="ds-who">They sign it alone. Put anything GFC signs on the PDF before you send it.</div>
      {err && <div className="ds-err">{err}</div>}
      <div className="ds-acts">
        <button className="ds-btn" disabled={busy || !ready} onClick={send}>{busy ? 'Sending…' : 'Send Document'}</button>
        {onCancel && <button className="ds-btn ds-ghost" disabled={busy} onClick={onCancel}>Cancel</button>}
      </div>
    </div>
  );
}

const scopeText = (scope, types) => {
  if (!scope) return '';
  if (scope.userId) return 'One person';
  if (scope.chapter) return 'An onboarding task';
  if (scope.types && scope.types.includes('all')) return 'All staff';
  const label = (id) => ((types || []).find(t => t.id === id) || { label: id }).label;
  return (scope.types || []).map(label).join(', ');
};

// Sent documents with who has and hasn't done them. With `userId`, only the
// documents that reach that person, and their own status on each.
function OfficeDocuments({ userId, userName }) {
  const [d, setD] = useState(null); const [err, setErr] = useState('');
  const [adding, setAdding] = useState(false); const [openId, setOpenId] = useState(null); const [msg, setMsg] = useState('');
  const load = useCallback(() => call(`/api/my/admin/document-sends${userId ? `?userId=${encodeURIComponent(userId)}` : ''}`).then(setD).catch(e => setErr(e.message)), [userId]);
  useEffect(() => { setD(null); load(); }, [load]);
  const withdraw = async (s) => {
    if (!window.confirm(`Withdraw "${s.title}"? Anyone who has not done it yet will no longer see it. Copies already signed stay filed.`)) return;
    try { await call(`/api/my/admin/document-sends/${encodeURIComponent(s.id)}`, { method: 'DELETE' }); setMsg('Withdrawn.'); await load(); } catch (e) { setErr(e.message); }
  };
  const openOriginal = (s) => openPdf(`/api/my/document-sends/${encodeURIComponent(s.id)}/file`, s.fileName).catch(e => setErr(e.message));
  const openCopy = (r, s) => openPdf(`/api/caregiver/documents/${encodeURIComponent(r.documentId)}/file`, `${s.title} - ${r.name}.pdf`).catch(e => setErr(e.message));
  return (
    <div className="ds">
      {err && <div className="ds-err">{err}</div>}{msg && <div className="ds-okmsg">{msg}</div>}
      {!adding && <button className="ds-btn" onClick={() => { setAdding(true); setMsg(''); }}><i className="ti ti-send" />Send a Document</button>}
      {adding && <SendForm userId={userId} userName={userName} types={d && d.types} onCancel={() => setAdding(false)}
        onSent={async () => { setAdding(false); setMsg('Sent. It is waiting on them in My GFC.'); await load(); }} />}
      {!d ? <div className="ds-note">Loading…</div> : !d.sends.length ? <div className="ds-note" style={{ marginTop: 10 }}>{userId ? 'No documents have been sent to this person.' : 'No documents have been sent yet.'}</div> : d.sends.map(s => {
        const mine = userId ? s.recipients.find(r => r.userId === String(userId)) : null;
        const doneCount = s.recipients.filter(r => r.done).length;
        return (
          <div key={s.id}>
            <div className="ds-row">
              <i className="ti ti-file-certificate" style={{ fontSize: 22, color: 'var(--n)' }} />
              <div className="ds-grow"><b>{s.title}</b>
                <small>{s.action === 'sign' ? 'To sign' : 'To acknowledge'} · sent {fmtDate(s.createdAt)}{s.createdByName ? ` by ${s.createdByName}` : ''}{userId ? '' : ` · ${scopeText(s.scope, d.types)}`}</small></div>
              {mine
                ? <span className={`ds-pill ${mine.done ? 'ds-ok' : 'ds-wait'}`}>{mine.done ? `${done(s.action)} ${fmtDate(mine.doneAt)}` : 'Not yet'}</span>
                : <span className="ds-pill">{doneCount} of {s.recipients.length} done</span>}
              <button className="ds-btn ds-ghost" onClick={() => openOriginal(s)}>Original</button>
              {mine && mine.done && mine.documentId && <button className="ds-btn ds-ghost" onClick={() => openCopy(mine, s)}>Signed Copy</button>}
              {!userId && <button className="ds-btn ds-ghost" onClick={() => setOpenId(openId === s.id ? null : s.id)}>{openId === s.id ? 'Hide' : 'Who'}</button>}
              {/* On one person's record, only what went to them alone: a
                  by-type document is withdrawn from the Documents to Sign page. */}
              {(!userId || (s.scope && s.scope.userId === String(userId))) && <button className="ds-btn ds-warn" onClick={() => withdraw(s)}>Withdraw</button>}
            </div>
            {openId === s.id && (
              <div className="ds-box">
                {!s.recipients.length && <div className="ds-note">Nobody of these types is on staff yet. Anyone added later will get it.</div>}
                {s.recipients.map(r => (
                  <div className="ds-row" key={r.userId}>
                    <div className="ds-grow"><b>{r.name}</b></div>
                    <span className={`ds-pill ${r.done ? 'ds-ok' : 'ds-wait'}`}>{r.done ? `${done(s.action)} ${fmtDate(r.doneAt)}` : 'Not yet'}</span>
                    {r.done && r.documentId && <button className="ds-btn ds-ghost" onClick={() => openCopy(r, s)}>Signed Copy</button>}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

window.GFCDocSign = { WaitingOnYou, SignPanel, SendForm, OfficeDocuments, openPdf };
})();
