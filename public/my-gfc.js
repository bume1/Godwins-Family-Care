// ============================================================================
// MY GFC — the shared staff portal pieces (owner, 2026-11-08)
// ============================================================================
// Loaded by public/my.html and by public/caregiver.html, which IS a
// caregiver's My GFC: one frame, one set of sections, one copy. Wrapped in a
// function so its names never collide with a page's own, and exported as
// window.MyGFC. Every class it styles starts with `mg-`, so a page's own
// .card or .btn can never restyle it, and it can never restyle theirs.
// ============================================================================
(function () {
const { useState, useEffect, useCallback } = React;

(function injectStyles() {
  if (document.getElementById('mygfc-styles')) return;
  const el = document.createElement('style');
  el.id = 'mygfc-styles';
  el.textContent = `.mygfc{--navy:#033D50;--goldd:#C9A44A;--gold-ink:#9A7430;--cream:#FAF7F2;--wash:#F6EFE2;--ink:#1a2a32;--mut:#41555f;--edge:#ECE4D6;--edge2:#E1D7C5;--green:#1d7a5a;--red:#B5462E;--mg-side:248px;font-family:'DM Sans',system-ui,sans-serif;color:var(--ink);background:var(--cream)}
.mygfc *{box-sizing:border-box}
.mg-shell{display:flex;min-height:100vh;position:relative}
.mg-side{display:none}
.mg-main{flex:1;min-width:0;position:relative}
.mg-body{padding:18px 16px 110px;max-width:1080px;margin:0 auto;position:relative;z-index:1}
.mg-top{position:sticky;top:0;z-index:20;background:rgba(250,247,242,.96);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid var(--edge)}
.mg-top img{height:34px} .mg-top a{font-size:14px;font-weight:600;text-decoration:none;color:var(--navy)}
.mg-top button{font-family:inherit;font-size:14px;font-weight:600;color:var(--navy);background:none;border:0;cursor:pointer;padding:0;width:auto;margin:0}
.mg-main.mg-home .mg-top{background:transparent;border-bottom:none;backdrop-filter:none;position:relative;z-index:2}
.mg-main.mg-home::before{content:"";position:absolute;left:0;right:0;top:0;height:380px;z-index:0;pointer-events:none;
  background:linear-gradient(to bottom,rgba(250,247,242,.35),rgba(250,247,242,.1) 38%,rgba(250,247,242,0) 55%),url('/banners/banner-portal.jpg') 36% top / cover no-repeat;
  -webkit-mask-image:linear-gradient(to bottom,#000 66%,transparent 100%);mask-image:linear-gradient(to bottom,#000 66%,transparent 100%)}
.mg-hello{padding:0 2px 96px}
.mg-hello h1,.mg-hello p{text-shadow:0 0 14px rgba(250,247,242,.95),0 0 4px rgba(250,247,242,.9)}
.mg-ptitle{margin:6px 0 18px}
.mg-hello h1,.mg-ptitle h1{font-family:'Cormorant Garamond',Georgia,serif;font-weight:600;color:var(--navy);margin:0;line-height:1.15;font-size:32px}
.mg-ptitle p,.mg-hello p{font-size:15.5px;color:var(--mut);margin:4px 0 0;font-weight:500}
.mg-card{background:#fff;border:1px solid var(--edge);border-radius:16px;padding:18px;margin-bottom:16px;box-shadow:0 1px 2px rgba(3,61,80,.04),0 6px 18px -12px rgba(3,61,80,.18)}
.mg-card h2,.mg-card h3{font-family:'Cormorant Garamond',Georgia,serif;font-weight:600;color:var(--navy);margin:0;line-height:1.15}
.mg-card h2{font-size:22px} .mg-card h3{font-size:19px;margin-top:18px}
.mg-card a{color:var(--navy)}
.mg-card-h{display:flex;justify-content:space-between;align-items:baseline;gap:10px;margin-bottom:6px;flex-wrap:wrap}
.mg-lead{margin:0 0 10px;color:var(--mut);font-size:14.5px}
.mg-tiles{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:18px}
.mg-tile{background:#fff;border:1px solid var(--edge);border-radius:16px;padding:14px;text-align:left;cursor:pointer;display:flex;flex-direction:column;gap:8px;min-height:118px;box-shadow:0 1px 2px rgba(3,61,80,.04),0 6px 18px -12px rgba(3,61,80,.18);font-family:inherit;width:auto;margin:0}
.mg-tile:hover{border-color:var(--goldd)}
.mg-ic{width:42px;height:42px;border-radius:12px;background:var(--wash);display:flex;align-items:center;justify-content:center;color:var(--navy);font-size:22px}
.mg-tile b{display:block;font-size:15px;font-weight:700;color:var(--navy)} .mg-tile small{display:block;font-size:13px;color:var(--gold-ink);font-weight:600}
.mg-row{display:flex;align-items:center;gap:12px;padding:12px 2px;border-bottom:1px solid var(--edge)}
.mg-row:last-child{border-bottom:0}
.mg-grow{flex:1;min-width:0} .mg-grow b{display:block;overflow-wrap:anywhere;color:var(--navy);font-weight:700} .mg-grow small{color:var(--mut);font-size:13px}
.mg-big{font-size:22px;color:var(--navy);width:40px;height:40px;border-radius:12px;background:var(--wash);display:flex;align-items:center;justify-content:center;flex:none}
.mg-btn{width:auto;margin:0;border-radius:12px;padding:10px 16px;font-family:inherit;font-size:14.5px;font-weight:600;cursor:pointer;border:1px solid var(--navy);background:var(--navy);color:#fff;display:inline-flex;gap:7px;align-items:center;justify-content:center;text-decoration:none;box-shadow:0 6px 16px -8px rgba(3,61,80,.6);line-height:1.3}
.mg-btn.mg-ghost{background:#fff;color:var(--navy);border:1.5px solid var(--edge2);box-shadow:none}
.mg-btn.mg-warn{background:#fff;color:var(--red);border:1.5px solid rgba(181,70,46,.4);box-shadow:none}
a.mg-btn,a.mg-btn:link,a.mg-btn:visited,a.mg-btn:hover{color:#fff;text-decoration:none}
a.mg-btn.mg-ghost,a.mg-btn.mg-ghost:link,a.mg-btn.mg-ghost:visited,a.mg-btn.mg-ghost:hover{color:var(--navy)}
.mg-btn.mg-sm{padding:7px 12px;font-size:13.5px;border-radius:10px} .mg-btn[disabled]{opacity:.5;cursor:not-allowed}
.mg-pill{display:inline-flex;border-radius:999px;padding:3px 10px;font-size:12.5px;font-weight:600;white-space:nowrap;background:var(--wash);color:var(--navy)}
.mg-pill.mg-ok{background:#e7f4ee;color:var(--green)} .mg-pill.mg-bad{background:#fdecea;color:var(--red)} .mg-pill.mg-wait{background:#FBF1DC;color:#6b5121}
.mg-bar{height:9px;background:var(--wash);border-radius:6px;overflow:hidden;margin:10px 0 14px}
.mg-bar>span{display:block;height:100%;background:var(--goldd)}
.mg-note{background:var(--wash);border:1px solid var(--edge);border-radius:12px;padding:12px 14px;color:var(--mut);font-size:14px;margin:6px 0}
.mg-err{background:#fdecea;border:1px solid rgba(181,70,46,.3);color:var(--red);border-radius:11px;padding:11px 13px;margin-bottom:12px;font-size:14px}
.mg-crumbs{display:flex;flex-wrap:wrap;gap:4px;align-items:center;margin-bottom:10px;font-size:14px}
.mg-crumbs button{background:none;border:0;color:var(--navy);cursor:pointer;padding:2px 4px;text-decoration:underline;font-size:14px;width:auto;margin:0}
.mg-card label{display:block;font-size:13px;font-weight:600;color:var(--mut);margin:12px 0 5px}
.mg-card input[type=text],.mg-card textarea{width:100%;background:#fff;border:1px solid var(--edge2);border-radius:11px;padding:11px 13px;font:inherit;color:var(--ink)}
.mg-card input[type=text]:focus,.mg-card textarea:focus{outline:none;border-color:var(--navy);box-shadow:0 0 0 3px rgba(3,61,80,.1)}
.mg-checks{display:flex;flex-wrap:wrap;gap:8px}
.mg-card .mg-checks label{display:inline-flex;gap:6px;align-items:center;margin:0;font-weight:500;color:var(--ink);border:1px solid var(--edge2);border-radius:10px;padding:6px 10px;background:#fff}
.mg-tabs{position:fixed;bottom:0;left:0;right:0;background:#fff;border-top:1px solid var(--edge);display:flex;z-index:30;box-shadow:0 -4px 16px rgba(3,61,80,.06);padding-bottom:env(safe-area-inset-bottom)}
.mg-tabs button{flex:1;width:auto;margin:0;background:none;border:none;padding:9px 2px 12px;cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:3px;color:var(--mut);font-family:inherit;font-size:11px;font-weight:600;position:relative}
.mg-tabs button i{font-size:22px;color:var(--navy)}
.mg-tabs button.mg-on{color:var(--gold-ink)} .mg-tabs button.mg-on i{color:var(--gold-ink)}
.mg-tabs button.mg-on::before{content:"";position:absolute;top:0;left:28%;right:28%;height:3px;border-radius:0 0 3px 3px;background:var(--goldd)}
.mg-menu{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:18px}
@media (min-width:640px){.mg-tiles,.mg-menu{grid-template-columns:repeat(3,1fr)} .mg-body{padding:22px 28px 110px}}
@media (min-width:1024px){
  .mg-shell{background:linear-gradient(90deg,#fff calc(var(--mg-side) - 1px),var(--edge) calc(var(--mg-side) - 1px),var(--edge) var(--mg-side),transparent var(--mg-side))}
  .mg-side{display:flex;flex-direction:column;width:var(--mg-side);flex-shrink:0;position:sticky;top:0;height:100vh;padding:22px 14px;overflow-y:auto}
  .mg-side img.mg-logo{height:46px;align-self:flex-start;margin:0 10px 8px}
  .mg-tag{font-family:'Cormorant Garamond',serif;font-size:18px;font-weight:600;color:var(--gold-ink);margin:0 14px 18px}
  .mg-side button{display:flex;width:100%;align-items:center;gap:13px;background:none;border:none;border-radius:12px;padding:12px 14px;margin:0 0 2px;font-family:inherit;font-size:15px;font-weight:600;color:var(--navy);cursor:pointer;text-align:left}
  .mg-side button i{font-size:21px;color:var(--navy)}
  .mg-side button:hover{background:var(--wash)}
  .mg-side button.mg-on{background:var(--goldd);color:#fff} .mg-side button.mg-on i{color:#fff}
  .mg-foot{margin-top:auto;padding:16px 8px 0;border-top:1px solid var(--edge);font-size:13px;color:var(--mut)}
  .mg-foot b{display:block;color:var(--navy);font-size:14px}
  .mg-foot a,.mg-foot button{display:inline-block;margin-top:8px;font-weight:600;text-decoration:none;color:var(--navy);padding:0;width:auto;font-size:13px}
  .mg-top,.mg-tabs,.mg-phone-only{display:none}
  .mg-body{padding:32px clamp(24px,3vw,48px) 48px;max-width:1160px}
  .mg-main.mg-home::before{height:clamp(300px,25vw,480px);background:url('/banners/banner-portal.jpg') right 40% / cover no-repeat;
    -webkit-mask-image:linear-gradient(90deg,transparent 0%,rgba(0,0,0,.14) 30%,rgba(0,0,0,.75) 56%,#000 72%),linear-gradient(to bottom,#000 58%,transparent 100%);
    -webkit-mask-composite:source-in;
    mask-image:linear-gradient(90deg,transparent 0%,rgba(0,0,0,.14) 30%,rgba(0,0,0,.75) 56%,#000 72%),linear-gradient(to bottom,#000 58%,transparent 100%);mask-composite:intersect}
  .mg-hello{padding:clamp(20px,3vw,48px) 0 clamp(48px,6vw,96px);min-height:clamp(180px,15vw,290px);display:flex;flex-direction:column;justify-content:center}
  .mg-hello h1,.mg-ptitle h1{font-size:40px}
  .mg-tiles{grid-template-columns:repeat(3,1fr);gap:16px}
}`;
  document.head.appendChild(el);
})();

const getToken = () => localStorage.getItem('admin_token') || localStorage.getItem('unified_token') || localStorage.getItem('portal_token');

const call = async (path, opts = {}) => {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: { Authorization: `Bearer ${getToken()}`, 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  let data = null;
  try { data = await res.json(); } catch (e) { /* empty */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || `Request failed (${res.status})`);
    err.code = data && data.code; err.status = res.status; err.detail = data && data.detail;
    throw err;
  }
  return data;
};

// A file opens through the app with the token in the HEADER, never the URL.
const openFile = async (path, name) => {
  const res = await fetch(path, { headers: { Authorization: `Bearer ${getToken()}` } });
  if (!res.ok) throw new Error('That file could not be opened.');
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name || 'document'; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
};

const TZ = window.GFC_TIME && window.GFC_TIME.PRACTICE_TIMEZONE;
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: TZ }) : '');
const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: TZ }) : '');

const KIND_LABELS = { timesheet: 'Timesheet', visit_note: 'Signed visit note', mileage: 'Mileage or expense', certification: 'Certification',
  id_document: 'Photo ID', paystub: 'Paystub', w9: 'W-9', clinician_onboarding: 'Onboarding document', signed_document: 'Signed document', other: 'Other' };
const STATUS_PILL = { accepted: ['mg-ok', 'Accepted'], received: ['mg-wait', 'With the office'], rejected: ['mg-bad', 'Sent back'] };

function Section({ title, sub, children, right, id }) {
  return (
    <div className="mg-card" id={id}>
      {(title || right) && <div className="mg-card-h">{title ? <h2>{title}</h2> : <span />}{right}</div>}
      {sub && <p className="mg-lead">{sub}</p>}
      {children}
    </div>
  );
}

function Tile({ icon, title, sub, onClick }) {
  return (
    <button className="mg-tile" onClick={onClick}>
      <span className="mg-ic"><i className={`ti ${icon}`} /></span>
      <span><b>{title}</b><small>{sub}</small></span>
    </button>
  );
}

// ---- Onboarding ---------------------------------------------------------------
function OnboardingSummary({ onboarding, compact }) {
  if (!onboarding) return <p className="mg-note">Loading your onboarding…</p>;
  if (onboarding.error) return <p className="mg-note">Your onboarding could not be loaded right now.</p>;
  if (!onboarding.started) {
    return <p className="mg-note">The office hasn't started your onboarding checklist yet. It will show here once they do.</p>;
  }
  const c = onboarding.track.counts;
  const pct = c.items ? Math.round((c.complete / c.items) * 100) : 0;
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <span><b>{c.complete}</b> of {c.items} items done</span>
        <span>
          {c.waitingOnHer > 0 && <span className="mg-pill mg-wait" style={{ marginRight: 6 }}>{c.waitingOnHer} waiting on you</span>}
          {c.returned > 0 && <span className="mg-pill mg-bad">{c.returned} sent back</span>}
        </span>
      </div>
      <div className="mg-bar"><span style={{ width: `${pct}%` }} /></div>
      {!compact && <p style={{ color: 'var(--mut)', fontSize: 14 }}>Your checklist, uploads, policy acknowledgments and training all live on your onboarding page.</p>}
      <a className="mg-btn" href="/onboarding"><i className="ti ti-route" />Open My Onboarding</a>
    </div>
  );
}

// ---- Documents --------------------------------------------------------------
const signedFileUrl = (d) => (d.pdf === 'packet' ? '/api/caregiver/welcome-packet/signed.pdf'
  : d.pdf === 'taxform' ? `/api/my/pay-setup/forms/${d.form}.pdf`
  : `/api/caregiver/welcome-packet/attestations/${d.kind}.pdf`);

function Signed({ signed, onError }) {
  if (!signed) return <p className="mg-note">Loading…</p>;
  if (!signed.length) return <p className="mg-note">Nothing signed yet. What you sign during onboarding shows here.</p>;
  return signed.map(d => (
    <div className="mg-row" key={d.id}>
      <i className="ti ti-signature mg-big" />
      <div className="mg-grow">
        <b>{d.title}</b>
        <small>{d.version ? `Version ${d.version} · ` : ''}Signed {fmtDate(d.signedAt)}{d.filedByOffice ? ` · Filed by ${d.filedByName || 'the office'}` : ''}</small>
        {d.current === false && <small style={{ display: 'block', color: 'var(--red)' }}>A newer version is out. You'll be asked to sign it.</small>}
      </div>
      {d.pdf
        ? <button className="mg-btn mg-ghost mg-sm" onClick={() => openFile(signedFileUrl(d), `${d.title}.pdf`).catch(e => onError(e.message))}>Open</button>
        : (d.links || []).slice(0, 1).map(u => <a key={u} className="mg-btn mg-ghost mg-sm" href={u} target="_blank" rel="noopener noreferrer">Open</a>)}
    </div>
  ));
}

function Documents({ docs, onError }) {
  if (!docs) return <p className="mg-note">Loading…</p>;
  if (!docs.length) return <p className="mg-note">Nothing is on file for you yet. Documents you or the office upload will show here.</p>;
  return docs.map(d => {
    const pill = STATUS_PILL[d.status];
    return (
      <div className="mg-row" key={d.id}>
        <i className="ti ti-file mg-big" />
        <div className="mg-grow">
          <b>{d.fileName}</b>
          <small>{d.itemTitle || KIND_LABELS[d.kind] || 'Document'} · {fmtDate(d.uploadedAt)} · {d.filedByOffice ? `Filed by ${d.uploadedByName || 'the office'}` : 'You sent this'}</small>
          {d.reviewNote && <small style={{ display: 'block', color: 'var(--red)' }}>Sent back: {d.reviewNote}</small>}
        </div>
        {pill && <span className={`mg-pill ${pill[0]}`}>{pill[1]}</span>}
        <button className="mg-btn mg-ghost mg-sm" onClick={() => openFile(`/api/my/documents/${d.id}/file`, d.fileName).catch(e => onError(e.message))}>Open</button>
      </div>
    );
  });
}

// ---- Policies (live) --------------------------------------------------------------
// Always the canonical copy in Drive, which the office updates in place. The
// preview is Drive's own viewer, so it shows whatever version is current.
function Policies({ policies, isAdmin }) {
  const [open, setOpen] = useState(null);
  if (!policies) return <p className="mg-note">Loading…</p>;
  return (
    <div>
      {policies.map(p => (
        <div key={p.id}>
          <div className="mg-row">
            <i className="ti ti-book mg-big" />
            <div className="mg-grow">
              <b>{p.title}</b>
              <small>Current version {p.version}</small>
              {p.signed && p.signed.current && <small style={{ display: 'block', color: 'var(--green)' }}>You signed this version {fmtDate(p.signed.at)}</small>}
              {p.signed && !p.signed.current && <small style={{ display: 'block', color: 'var(--red)' }}>Updated since you signed version {p.signed.version}. Please read the new version.</small>}
            </div>
            <button className="mg-btn mg-ghost mg-sm" onClick={() => setOpen(open === p.id ? null : p.id)}>{open === p.id ? 'Close' : 'Preview'}</button>
            <a className="mg-btn mg-ghost mg-sm" href={p.url} target="_blank" rel="noopener noreferrer">Open in Drive</a>
          </div>
          {open === p.id && (
            <iframe title={p.title} src={p.previewUrl} style={{ width: '100%', height: 560, border: '1px solid var(--line)', borderRadius: 10, margin: '6px 0 12px' }} allow="autoplay" />
          )}
        </div>
      ))}
      {isAdmin && <p className="mg-note" style={{ marginTop: 12 }}>These always open the current version in Google Drive. Sign in with your GFC Google account if Drive asks. Copies you signed are in My Documents.</p>}
    </div>
  );
}

// ---- Shared folders ---------------------------------------------------------
function FolderBrowser({ folder, onBack }) {
  const [path, setPath] = useState([]);   // [{id, name}]
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    setData(null); setErr('');
    const q = path.map(p => p.id).join(',');
    call(`/api/my/folders/${folder.id}/items?path=${encodeURIComponent(q)}`)
      .then(setData).catch(e => setErr(e.message));
  }, [folder.id, path]);
  return (
    <div>
      <div className="mg-crumbs">
        <button onClick={onBack}>Shared Folders</button><span>/</span>
        <button onClick={() => setPath([])}>{folder.label}</button>
        {path.map((p, i) => (
          <React.Fragment key={p.id}><span>/</span><button onClick={() => setPath(path.slice(0, i + 1))}>{p.name}</button></React.Fragment>
        ))}
      </div>
      {err && <div className="mg-err">{err}</div>}
      {!data && !err && <p className="mg-note">Loading…</p>}
      {data && !data.items.length && <p className="mg-note">This folder is empty.</p>}
      {data && data.items.map(i => (
        <div className="mg-row" key={i.id}>
          <i className={`ti ${i.isFolder ? 'ti-folder' : 'ti-file'} mg-big`} />
          <div className="mg-grow"><b>{i.name}</b>{i.modifiedTime && <small>Updated {fmtDate(i.modifiedTime)}</small>}</div>
          {i.isFolder
            ? <button className="mg-btn mg-ghost mg-sm" onClick={() => setPath(path.concat([{ id: i.id, name: i.name }]))}>Open</button>
            : i.url && <a className="mg-btn mg-ghost mg-sm" href={i.url} target="_blank" rel="noopener noreferrer">Open in Drive</a>}
        </div>
      ))}
      <p className="mg-note" style={{ marginTop: 12 }}>Files open in Google Drive. Sign in with your GFC Google account if Drive asks.</p>
    </div>
  );
}

function SharedFolders({ folders }) {
  const [open, setOpen] = useState(null);
  if (open) return <FolderBrowser folder={open} onBack={() => setOpen(null)} />;
  if (!folders) return <p className="mg-note">Loading…</p>;
  if (!folders.length) return <p className="mg-note">No shared folders are assigned to you yet. The office adds them for your role.</p>;
  return folders.map(f => (
    <div className="mg-row" key={f.id} style={{ cursor: 'pointer' }} onClick={() => setOpen(f)}>
      <i className="ti ti-folder mg-big" />
      <div className="mg-grow"><b>{f.label}</b>{f.description && <small>{f.description}</small>}</div>
      <i className="ti ti-chevron-right" />
    </div>
  ));
}

// Quick picks. The admin team is administrators, managers AND care
// coordinators (owner, 2026-11-08).
const AUDIENCE_GROUPS = [
  { id: 'adminTeam', label: 'Admin team', types: ['admin', 'manager', 'coordinator'] },
  { id: 'clinicians', label: 'All clinicians', types: ['provider', 'rn', 'lcsw', 'lmsw'] },
  { id: 'caregivers', label: 'Caregivers', types: ['caregiver'] }
];

// The admin team's side: which folders each role or person sees.
function ManageFolders({ onChanged }) {
  const [data, setData] = useState(null);
  const [form, setForm] = useState({ link: '', label: '', description: '', types: [], userIds: [] });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => call('/api/my/admin/folders').then(setData).catch(e => setErr(e.message)), []);
  useEffect(() => { load(); }, [load]);
  const toggle = (key, v) => setForm(f => ({ ...f, [key]: f[key].includes(v) ? f[key].filter(x => x !== v) : f[key].concat([v]) }));
  const add = async () => {
    setBusy(true); setErr('');
    try {
      await call('/api/my/admin/folders', { method: 'POST', body: form });
      setForm({ link: '', label: '', description: '', types: [], userIds: [] });
      await load(); onChanged();
    } catch (e) { setErr(e.detail ? `${e.message} (${e.detail})` : e.message); }
    setBusy(false);
  };
  const remove = async (id) => {
    if (!window.confirm('Remove this folder from My GFC? Nothing in Drive is deleted.')) return;
    try { await call(`/api/my/admin/folders/${id}`, { method: 'DELETE' }); await load(); onChanged(); } catch (e) { setErr(e.message); }
  };
  if (!data) return err ? <div className="mg-err">{err}</div> : <p className="mg-note">Loading…</p>;
  const typeLabel = Object.fromEntries(data.types.map(t => [t.id, t.label]));
  const personName = Object.fromEntries(data.people.map(p => [p.id, p.name]));
  return (
    <div>
      {err && <div className="mg-err">{err}</div>}
      {data.folders.map(f => (
        <div className="mg-row" key={f.id}>
          <i className="ti ti-folder mg-big" />
          <div className="mg-grow">
            <b>{f.label}</b>
            <small>Seen by: {f.types.map(t => typeLabel[t]).concat(f.userIds.map(id => personName[id] || 'a removed account')).join(', ')}</small>
          </div>
          <button className="mg-btn mg-warn mg-sm" onClick={() => remove(f.id)}>Remove</button>
        </div>
      ))}
      {!data.folders.length && <p className="mg-note">No folders assigned yet.</p>}
      <h3 style={{ marginTop: 18, fontSize: 19 }}>Add a folder</h3>
      <label>Drive folder link</label>
      <input type="text" value={form.link} onChange={e => setForm({ ...form, link: e.target.value })} placeholder="https://drive.google.com/drive/folders/…" />
      <label>Name people will see</label>
      <input type="text" value={form.label} onChange={e => setForm({ ...form, label: e.target.value })} placeholder="Clinical Forms" />
      <label>Description (optional)</label>
      <input type="text" value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} />
      <label>Everyone in these roles</label>
      <div className="mg-checks" style={{ marginBottom: 8 }}>
        {AUDIENCE_GROUPS.map(g => (
          <button key={g.id} type="button" className="mg-btn mg-ghost mg-sm" onClick={() => setForm(f => ({ ...f, types: Array.from(new Set(f.types.concat(g.types))) }))}>+ {g.label}</button>
        ))}
      </div>
      <div className="mg-checks">
        {data.types.map(t => (
          <label key={t.id}><input type="checkbox" checked={form.types.includes(t.id)} onChange={() => toggle('types', t.id)} />{t.label}</label>
        ))}
      </div>
      <label>Or these people</label>
      <div className="mg-checks">
        {data.people.map(p => (
          <label key={p.id}><input type="checkbox" checked={form.userIds.includes(p.id)} onChange={() => toggle('userIds', p.id)} />{p.name}</label>
        ))}
      </div>
      <p className="mg-note" style={{ marginTop: 12 }}>
        The folder has to be shared with the GFC admin Google account so the app can list it. Each person still opens files under their own Google sign-in, so Drive's sharing settings decide who can read a file.
      </p>
      <button className="mg-btn" disabled={busy || !form.link || !form.label} onClick={add}><i className="ti ti-plus" />Add Folder</button>
    </div>
  );
}

// ---- Hours & pay -------------------------------------------------------------
const usd = (n) => (n == null ? '' : Number(n).toLocaleString('en-US', { style: 'currency', currency: 'USD' }));
// A bare pay date read at midday UTC, so it is the same calendar day in Georgia.
const fmtDay = (ymd) => (ymd ? fmtDate(`${ymd}T12:00:00Z`) : '');

// Today in Georgia, so a stub for a payday still ahead never reads as paid.
const todayYmd = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
function PayStubs({ stubs, onError }) {
  if (!stubs) return <p className="mg-note">Loading…</p>;
  if (!stubs.length) return <p className="mg-note">No pay stubs yet. Each one shows here after payroll runs.</p>;
  return stubs.map(p => (
    <div className="mg-row" key={p.id}>
      <i className="ti ti-receipt mg-big" />
      <div className="mg-grow">
        <b>{p.payDate > todayYmd() ? 'Payday' : 'Paid'} {fmtDay(p.payDate)} · {usd(p.net)} net</b>
        <small>{fmtDay(p.periodStart)} – {fmtDay(p.periodEnd)} · {usd(p.gross)} gross{p.hours != null ? ` · ${p.hours} hours` : ''}</small>
      </div>
      {p.hasPdf && <button className="mg-btn mg-ghost mg-sm" onClick={() => openFile(`/api/my/paystubs/${p.id}/file`, `Pay stub ${p.payDate}.pdf`).catch(e => onError(e.message))}>Open</button>}
    </div>
  ));
}

function Hours({ hours }) {
  if (!hours) return <p className="mg-note">Loading…</p>;
  return (
    <div>
      <p style={{ marginTop: 0 }}>You clock in and out from <a href="/caregiver#schedule">My Schedule</a>. <b>{hours.totalHours || 0}</b> hours on record in the last 30 days.</p>
      {hours.timeLogs.slice(0, 15).map(l => (
        <div className="mg-row" key={l.id}>
          <i className="ti ti-clock mg-big" />
          <div className="mg-grow"><b>{fmtTime(l.clockInAt)}{l.clientName ? ` · ${l.clientName}` : ''}</b><small>{l.totalMinutes != null ? `${(l.totalMinutes / 60).toFixed(2)} hours` : 'Still clocked in'}</small></div>
        </div>
      ))}
      <a className="mg-btn mg-ghost" href="#" onClick={(e) => { e.preventDefault(); openFile('/api/scheduling/my-hours.csv', 'my-hours.csv').catch(() => {}); }}>
        <i className="ti ti-download" />Download My Hours
      </a>
    </div>
  );
}

// ---- Headshot and bio -----------------------------------------------------------
// An image behind the token: fetched with the header, shown from a blob URL.
function AuthImage({ path, version, alt, size }) {
  const [src, setSrc] = useState(null);
  useEffect(() => {
    if (!path) return undefined;
    let url = null; let live = true;
    fetch(path, { headers: { Authorization: `Bearer ${getToken()}` } })
      .then(r => (r.ok ? r.blob() : null)).then(b => { if (b && live) { url = URL.createObjectURL(b); setSrc(url); } }).catch(() => {});
    return () => { live = false; if (url) URL.revokeObjectURL(url); };
  }, [path, version]);
  const box = { width: size, height: size, borderRadius: '50%', objectFit: 'cover', background: '#EEF4F6', flex: 'none',
    display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--navy)', fontSize: size / 2.6 };
  return src ? <img src={src} alt={alt} style={box} /> : <span style={box}><i className="ti ti-user" /></span>;
}

function BioEditor() {
  const [bio, setBio] = useState(null);
  const [form, setForm] = useState({ title: '', bio: '' });
  const [msg, setMsg] = useState(''); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => { call('/api/my/bio').then(b => { setBio(b); setForm({ title: b.title, bio: b.bio }); }).catch(e => setErr(e.message)); }, []);
  const save = async () => {
    setBusy(true); setErr(''); setMsg('');
    try { setBio(await call('/api/my/bio', { method: 'PUT', body: form })); setMsg('Saved.'); } catch (e) { setErr(e.message); }
    setBusy(false);
  };
  const uploadPhoto = async (file) => {
    if (!file) return;
    setBusy(true); setErr(''); setMsg('');
    const fd = new FormData(); fd.append('file', file);
    try {
      const res = await fetch('/api/my/bio/headshot', { method: 'POST', headers: { Authorization: `Bearer ${getToken()}` }, body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'That photo could not be uploaded.');
      setBio(data); setMsg('Photo updated.');
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };
  if (!bio) return err ? <div className="mg-err">{err}</div> : <p className="mg-note">Loading…</p>;
  return (
    <div>
      {err && <div className="mg-err">{err}</div>}
      <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
        <AuthImage path={bio.hasHeadshot ? '/api/my/bio/headshot' : ''} version={bio.updatedAt} alt="Your headshot" size={96} />
        <label className="mg-btn mg-ghost mg-sm" style={{ margin: 0 }}>
          <i className="ti ti-camera" />{bio.hasHeadshot ? 'Replace Photo' : 'Upload Photo'}
          <input type="file" accept="image/jpeg,image/png" style={{ display: 'none' }} onChange={e => uploadPhoto(e.target.files[0])} />
        </label>
      </div>
      <label>Title as it should read on the website</label>
      <input type="text" value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} placeholder="Family Nurse Practitioner" />
      <label>Bio</label>
      <textarea rows={6} value={form.bio} onChange={e => setForm({ ...form, bio: e.target.value })} placeholder="A few sentences about you, your experience and why you do this work." />
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 10 }}>
        <button className="mg-btn" disabled={busy} onClick={save}>Save Bio</button>
        {msg && <span style={{ color: 'var(--green)' }}>{msg}</span>}
      </div>
    </div>
  );
}



// ---- The W-2 time clock -------------------------------------------------------
// The SAME clock caregivers use (owner, 2026-11-08: "nothing should be
// recreated"): the shared schedule component, mounted in staff mode, writing
// the same time logs the admin corrects and exports on the scheduling board.
// The shared availability form for any staff member (owner, 2026-11-09).
function StaffAvailabilityMount() {
  const id = 'mygfc-staff-availability';
  useEffect(() => {
    const lib = window.GFCCaregiverSchedule;
    if (!lib) return undefined;
    lib.mount(id, { authToken: getToken(), onlyTabs: ['availability'] });
    return () => lib.unmount(id);
  }, []);
  return <div id={id} />;
}

function StaffClockMount() {
  const id = 'mygfc-staff-clock';
  useEffect(() => {
    const lib = window.GFCCaregiverSchedule;
    if (!lib) return undefined;
    lib.mount(id, { authToken: getToken(), staffOnly: true });
    return () => lib.unmount(id);
  }, []);
  return <div id={id} />;
}

// ---- A liaison's clients --------------------------------------------------------
// The enrollment summary of each client assigned to this liaison: status, how
// complete, and what is still needed. Nothing clinical (owner, 2026-11-08).
const ENROLLMENT_LABELS = { intake_pending: ['mg-wait', 'Intake in progress'], ready_for_review: ['mg-wait', 'With the office for review'],
  needs_followup: ['mg-bad', 'Needs follow-up'], enrolled: ['mg-ok', 'Enrolled'] };
const SERVICE_LINE_LABELS = { PHC: 'Private Home Care', IHPC: 'In-Home Primary Care', BOTH: 'Home Care and Primary Care' };

function LiaisonClients() {
  const [clients, setClients] = useState(null); const [err, setErr] = useState(''); const [open, setOpen] = useState(null);
  useEffect(() => { call('/api/my/clients').then(d => setClients(d.clients)).catch(e => setErr(e.message)); }, []);
  if (err) return <div className="mg-err">{err}</div>;
  if (!clients) return <p className="mg-note">Loading…</p>;
  if (!clients.length) return <p className="mg-note">No clients are assigned to you yet. The office assigns them on your account.</p>;
  return clients.map(c => {
    const st = ENROLLMENT_LABELS[c.reviewState] || ['', c.enrollmentStatus];
    const needed = c.stillNeeded.consents.length + c.stillNeeded.details.length;
    return (
      <div key={c.id}>
        <div className="mg-row" style={{ cursor: 'pointer' }} onClick={() => setOpen(open === c.id ? null : c.id)}>
          <i className="ti ti-user mg-big" />
          <div className="mg-grow">
            <b>{c.name}</b>
            <small>{SERVICE_LINE_LABELS[c.serviceLine] || 'Service not chosen yet'} · {c.completionPct}% complete{c.submittedAt ? ` · Intake sent ${fmtDate(c.submittedAt)}` : ''}</small>
          </div>
          <span className={`mg-pill ${st[0]}`}>{st[1]}</span>
          <i className={`ti ${open === c.id ? 'ti-chevron-up' : 'ti-chevron-down'}`} />
        </div>
        {open === c.id && (
          <div style={{ padding: '4px 4px 14px 54px' }}>
            <div className="mg-bar"><span style={{ width: `${c.completionPct}%` }} /></div>
            {needed === 0
              ? <p className="mg-note">Nothing is outstanding on this client's enrollment.</p>
              : (
                <div>
                  {c.stillNeeded.consents.length > 0 && (<div><b style={{ color: 'var(--navy)' }}>Forms still to sign</b>
                    <ul style={{ margin: '4px 0 10px', paddingLeft: 20 }}>{c.stillNeeded.consents.map(x => <li key={x}>{x}</li>)}</ul></div>)}
                  {c.stillNeeded.details.length > 0 && (<div><b style={{ color: 'var(--navy)' }}>Details still needed</b>
                    <ul style={{ margin: '4px 0 0', paddingLeft: 20 }}>{c.stillNeeded.details.map(x => <li key={x}>{x}</li>)}</ul></div>)}
                </div>
              )}
          </div>
        )}
      </div>
    );
  });
}

// ---- The shell -------------------------------------------------------------------
// One frame for every staff member (owner, 2026-11-08): the patient portal's
// look. A white sidebar on a computer, a white menu along the bottom of a
// phone. `sections` fill the sidebar; `phoneTabs` fill the phone menu, which
// only fits about five.
// Back to the Portal Hub to reach other areas (owner, 2026-11-09). The query
// keeps the hub from sending them straight back to their landing page.
const PORTAL_HUB = '/login?hub=1';
// `tag` names the area under the logo; the Admin Hub uses this same frame
// (owner, 2026-11-09) and passes its own.
function Shell({ sections, phoneTabs, view, go, name, typeLabel, home, title, subtitle, firstName, banner, children, footExtra, tag = 'My GFC' }) {
  const isHome = view === 'home';
  return (
    <div className="mygfc">
      <div className="mg-shell">
        <aside className="mg-side">
          <img className="mg-logo" src="/brand/logo-full-color-transparent.png" alt="Godwins Family Care" />
          <div className="mg-tag">{tag}</div>
          <nav>
            {sections.map(s => (
              <button key={s.id} className={view === s.id ? 'mg-on' : ''} onClick={() => go(s.id)}><i className={`ti ${s.icon}`} />{s.label}{s.count > 0 && <span className="mg-pill mg-wait" style={{ marginLeft: 'auto' }}>{s.count}</span>}</button>
            ))}
            <button onClick={() => { window.location.href = PORTAL_HUB; }}><i className="ti ti-layout-grid" />Portal Hub</button>
          </nav>
          <div className="mg-foot">
            <b>{name}</b>{typeLabel}
            {home && <div><a href={home.href}>← {home.label}</a></div>}
            {footExtra}
          </div>
        </aside>
        <main className={`mg-main${isHome ? ' mg-home' : ''}`}>
          <div className="mg-top">
            <img src="/brand/logo-full-color-transparent.png" alt="Godwins Family Care" />
            {home ? <a href={home.href}>← {home.label}</a> : (footExtra || <span />)}
          </div>
          {banner}
          <div className="mg-body">
            {isHome
              ? <div className="mg-hello"><h1>Hi, {firstName}</h1><p>{typeLabel} · Godwins Family Care</p></div>
              : (title && <div className="mg-ptitle"><h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</div>)}
            {children}
          </div>
        </main>
        <nav className="mg-tabs">
          {phoneTabs.map(s => (
            <button key={s.id} className={(s.match ? s.match.includes(view) : view === s.id) ? 'mg-on' : ''} onClick={() => go(s.id)}><i className={`ti ${s.icon}`} />{s.short || s.label}{s.count > 0 ? ` (${s.count})` : ''}</button>
          ))}
        </nav>
      </div>
    </div>
  );
}

// ---- Documents waiting on you (owner, 2026-11-13) ------------------------------
// One banner on Home, straight to My Documents, like the announcement banner.
function DocsWaitingBanner({ docs, onOpen }) {
  if (!docs || !docs.length) return null;
  const one = docs[0];
  return (
    <button onClick={onOpen} style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, textAlign: 'left', margin: '0 0 14px', padding: '12px 14px', borderRadius: 14, border: 'none', background: '#033D50', color: '#fff', fontFamily: 'inherit', fontSize: 15, fontWeight: 600, cursor: 'pointer' }}>
      <i className="ti ti-signature" style={{ fontSize: 20, color: '#F5CD85' }} />
      <span style={{ flex: 1 }}>{docs.length === 1 ? `Document to ${one.action === 'sign' ? 'sign' : 'acknowledge'}: ${one.title}` : `${docs.length} documents waiting on you`}</span>
      <i className="ti ti-chevron-right" />
    </button>
  );
}

// ---- Announcements (owner, 2026-11-10) -----------------------------------------
// Office news and upgrade notes. The rows are the caregiver Feed's, read
// through one audience rule on the server, so caregivers see the same posts in
// their Feed. One composer for everyone who posts: the admin team.
function AnnouncementList({ items, onReviewed, onError }) {
  if (!items) return <p className="mg-note">Loading…</p>;
  if (!items.length) return <p className="mg-note">No announcements right now.</p>;
  const mark = (id) => call(`/api/my/announcements/${id}/reviewed`, { method: 'POST' }).then(onReviewed).catch(e => onError(e.message));
  return items.map(a => (
    <div className="mg-row" key={a.id} style={{ alignItems: 'flex-start' }}>
      <i className="ti ti-speakerphone mg-big" />
      <div className="mg-grow">
        <b>{a.title}</b>
        <small>{fmtDate(a.at)}{a.byName ? ` · ${a.byName}` : ''}</small>
        {a.body && <p style={{ whiteSpace: 'pre-wrap', margin: '6px 0' }}>{a.body}</p>}
        {a.link && <a className="mg-btn mg-ghost mg-sm" href={a.link} target="_blank" rel="noopener noreferrer">Open the guide</a>}
      </div>
      {a.reviewedAt
        ? <span className="mg-pill mg-ok">Reviewed</span>
        : <button className="mg-btn mg-sm" onClick={() => mark(a.id)}>I've Reviewed This</button>}
    </div>
  ));
}

function ManageAnnouncements({ onChanged }) {
  const [data, setData] = useState(null);
  const [form, setForm] = useState({ title: '', body: '', link: '', everyone: true, roles: [], userIds: [] });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(null);
  const load = useCallback(() => call('/api/my/admin/announcements').then(setData).catch(e => setErr(e.message)), []);
  useEffect(() => { load(); }, [load]);
  const post = async () => {
    setBusy(true); setErr('');
    try {
      await call('/api/caregiver/broadcasts', { method: 'POST', body: {
        title: form.title, body: form.body, link: form.link,
        audience: form.everyone ? 'all_staff' : form.roles,
        userIds: form.everyone ? [] : form.userIds
      } });
      setForm({ title: '', body: '', link: '', everyone: true, roles: [], userIds: [] });
      await load(); onChanged();
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };
  const retire = async (id) => {
    if (!window.confirm('Take this announcement down? It stays in the record.')) return;
    try { await call(`/api/caregiver/broadcasts/${id}/retire`, { method: 'POST' }); await load(); onChanged(); } catch (e) { setErr(e.message); }
  };
  if (!data) return err ? <div className="mg-err">{err}</div> : <p className="mg-note">Loading…</p>;
  const label = Object.fromEntries(data.roles.map(r => [r.value, r.label]));
  const toggle = (v) => setForm(f => ({ ...f, roles: f.roles.includes(v) ? f.roles.filter(x => x !== v) : f.roles.concat([v]) }));
  const togglePerson = (v) => setForm(f => ({ ...f, userIds: f.userIds.includes(v) ? f.userIds.filter(x => x !== v) : f.userIds.concat([v]) }));
  const nameOf = Object.fromEntries((data.people || []).map(p => [String(p.id), p.name]));
  return (
    <div>
      {err && <div className="mg-err">{err}</div>}
      <p className="mg-note">An announcement reaches everyone you choose, on their My GFC Home and, for caregivers, their Feed. Each person also gets it by email, word for word. Write it for the whole team: no client names or health details.</p>
      <label>Title</label>
      <input type="text" value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} placeholder="App update: what's new this week" />
      <label>Message</label>
      <textarea rows={5} value={form.body} onChange={e => setForm({ ...form, body: e.target.value })} />
      <label>Link to a guide (optional)</label>
      <input type="text" value={form.link} onChange={e => setForm({ ...form, link: e.target.value })} placeholder="https://docs.google.com/…" />
      <label>Who sees it</label>
      <div className="mg-checks">
        <label><input type="checkbox" checked={form.everyone} onChange={() => setForm(f => ({ ...f, everyone: !f.everyone }))} />Everyone on the team</label>
        {!form.everyone && data.roles.map(r => (
          <label key={r.value}><input type="checkbox" checked={form.roles.includes(r.value)} onChange={() => toggle(r.value)} />{r.label}</label>
        ))}
      </div>
      {!form.everyone && (
        <div>
          <label>Or these people</label>
          <div className="mg-checks">
            {(data.people || []).map(p => (
              <label key={p.id}><input type="checkbox" checked={form.userIds.includes(p.id)} onChange={() => togglePerson(p.id)} />{p.name}{p.typeLabel ? ` (${p.typeLabel})` : ''}</label>
            ))}
          </div>
        </div>
      )}
      <button className="mg-btn" style={{ marginTop: 10 }} disabled={busy || !form.title.trim() || (!form.everyone && !form.roles.length && !form.userIds.length)} onClick={post}><i className="ti ti-send" />Post Announcement</button>

      <h3 style={{ marginTop: 22, fontSize: 19 }}>Posted</h3>
      {!data.announcements.length && <p className="mg-note">Nothing posted yet.</p>}
      {data.announcements.map(a => (
        <div className="mg-row" key={a.id} style={{ alignItems: 'flex-start', opacity: a.active ? 1 : 0.6 }}>
          <div className="mg-grow">
            <b>{a.title}</b>
            <small>{fmtDate(a.at)} · {a.audience === 'all_staff' ? 'Everyone' : a.audience.map(t => label[t] || t).concat((a.userIds || []).map(id => nameOf[String(id)] || 'a former staff member')).join(', ')}{a.active ? '' : ' · Taken down'} · {a.reviewed.length} reviewed, {a.notReviewed.length} not yet</small>
            {open === a.id && (
              <div style={{ marginTop: 6 }}>
                <div><small><b>Not yet:</b> {a.notReviewed.join(', ') || 'Everyone has reviewed it.'}</small></div>
                <div><small><b>Reviewed:</b> {a.reviewed.join(', ') || 'No one yet.'}</small></div>
              </div>
            )}
          </div>
          <button className="mg-btn mg-ghost mg-sm" onClick={() => setOpen(open === a.id ? null : a.id)}>{open === a.id ? 'Hide' : 'Who'}</button>
          {a.active && <button className="mg-btn mg-warn mg-sm" onClick={() => retire(a.id)}>Take Down</button>}
        </div>
      ))}
    </div>
  );
}

// ---- What every staff member has ---------------------------------------------------
const STAFF_SECTIONS = [
  // The staff welcome packet (owner, 2026-11-09): not for caregivers, whose
  // welcome packet is in the caregiver app.
  { id: 'welcome', label: 'Welcome Packet', icon: 'ti-confetti', short: 'Welcome', notCaregiver: true, subtitle: 'How to reach you, your emergency contact, your availability, and how you like to learn.' },
  // Caregivers read announcements in their Feed, so the section is not theirs.
  { id: 'announcements', label: 'Announcements', icon: 'ti-speakerphone', short: 'News', notCaregiver: true, subtitle: 'News and app updates from the office.' },
  { id: 'onboarding', label: 'Onboarding', icon: 'ti-route', subtitle: 'Your checklist, uploads and training.' },
  { id: 'documents', label: 'My Documents', icon: 'ti-file-text', short: 'Documents', subtitle: 'What you signed, and every file on record for you.' },
  { id: 'policies', label: 'Policies', icon: 'ti-book', subtitle: 'The latest version of every policy you work under.' },
  { id: 'folders', label: 'Shared Folders', icon: 'ti-folders', short: 'Folders', subtitle: 'The Drive folders set up for your role.' },
  { id: 'hours', label: 'Hours & Pay', icon: 'ti-clock', short: 'Pay', subtitle: 'Your time clock, pay stubs, pay setup and tax forms.' },
  // Headshots and bios are read by the admin team on each person's User
  // Management form, not on a page here (owner, 2026-11-09).
  { id: 'account', label: 'My Profile', icon: 'ti-user-circle', short: 'Profile', subtitle: 'Your headshot, website bio and sign-in.' }
];
const staffSectionsFor = (profile) => {
  const list = STAFF_SECTIONS.filter(s => (!s.adminTeam || (profile && profile.isAdmin)) && !(s.notCaregiver && profile && profile.isCaregiver));
  // First until it is signed; after that it sits at the end, beside My Profile.
  if (profile && profile.welcomeDone) return list.filter(s => s.id !== 'welcome').concat(list.filter(s => s.id === 'welcome'));
  return list;
};

// Loads everything the staff sections read. One hook, so both pages read the
// same data the same way.
function useStaffData() {
  const [profile, setProfile] = useState(null);
  const [fatal, setFatal] = useState('');
  const [onboarding, setOnboarding] = useState(null);
  const [docs, setDocs] = useState(null);
  const [signed, setSigned] = useState(null);
  const [policies, setPolicies] = useState(null);
  const [stubs, setStubs] = useState(null);
  const [folders, setFolders] = useState(null);
  const [hours, setHours] = useState(null);
  const [news, setNews] = useState(null);
  const [sends, setSends] = useState(null);
  const [err, setErr] = useState('');
  const loadFolders = useCallback(() => call('/api/my/folders').then(d => setFolders(d.folders)).catch(e => setErr(e.message)), []);
  const loadNews = useCallback(() => call('/api/my/announcements').then(d => setNews(d.announcements)).catch(e => setErr(e.message)), []);
  // Documents the office sent to sign or acknowledge (owner, 2026-11-13): read
  // once here so Home and the menu can say something is waiting.
  const loadSends = useCallback(() => call('/api/my/document-sends').then(d => setSends(d.waiting || [])).catch(() => setSends([])), []);
  useEffect(() => {
    if (!getToken()) { window.location.href = '/login'; return; }
    call('/api/my/profile').then(p => {
      setProfile(p);
      call('/api/onboarding/me').then(setOnboarding).catch(() => setOnboarding({ error: true }));
      call('/api/my/documents').then(d => { setDocs(d.documents); setSigned(d.signed); }).catch(e => setErr(e.message));
      call('/api/my/policies').then(d => setPolicies(d.policies)).catch(e => setErr(e.message));
      call('/api/my/paystubs').then(d => setStubs(d.paystubs)).catch(e => setErr(e.message));
      loadFolders();
      loadNews();
      loadSends();
      if (p.isCaregiver) {
        const from = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
        call(`/api/scheduling/time-logs?from=${from}`).then(setHours).catch(() => setHours({ timeLogs: [], totalHours: 0 }));
      }
    }).catch(e => setFatal(e.code === 'STAFF_PORTAL_STAFF_ONLY' ? 'My GFC is for GFC staff.' : e.message));
  }, [loadFolders, loadNews, loadSends]);
  const reloadProfile = useCallback(() => call('/api/my/profile').then(setProfile).catch(() => {}), []);
  // A document signed here files a copy; the list below shows it at once.
  const reloadDocs = useCallback(() => { loadSends(); return call('/api/my/documents').then(d => { setDocs(d.documents); setSigned(d.signed); }).catch(e => setErr(e.message)); }, [loadSends]);
  return { profile, fatal, onboarding, docs, signed, policies, stubs, folders, hours, news, loadNews, waitingDocs: sends || [], err, setErr, loadFolders, reloadProfile, reloadDocs };
}

// The tiles on Home that lead to the staff sections.
function StaffTiles({ data, go, only, extra }) {
  const { docs, signed, policies, folders, stubs } = data;
  const all = [
    { id: 'onboarding', el: <Tile key="onboarding" icon="ti-route" title="Onboarding" sub="Your checklist and training" onClick={() => go('onboarding')} /> },
    { id: 'documents', el: <Tile key="documents" icon="ti-file-text" title="My Documents" sub={docs && signed ? `${signed.length} signed · ${docs.length} on file` : 'What you signed and sent'} onClick={() => go('documents')} /> },
    { id: 'policies', el: <Tile key="policies" icon="ti-book" title="Policies" sub={policies && policies.some(p => p.signed && !p.signed.current) ? 'A policy was updated' : 'The current version of each policy'} onClick={() => go('policies')} /> },
    { id: 'folders', el: <Tile key="folders" icon="ti-folders" title="Shared Folders" sub={folders ? `${folders.length} assigned to you` : 'Drive folders for your role'} onClick={() => go('folders')} /> },
    { id: 'hours', el: <Tile key="hours" icon="ti-clock" title="Hours & Pay" sub={stubs && stubs.length ? `Last paid ${fmtDay(stubs[0].payDate)}` : 'Pay stubs'} onClick={() => go('hours')} /> },
    { id: 'account', el: <Tile key="account" icon="ti-user-circle" title="My Profile" sub="Headshot, bio and sign-in" onClick={() => go('account')} /> }
  ];
  return <div className="mg-tiles">{extra}{all.filter(t => !only || only.includes(t.id)).map(t => t.el)}</div>;
}

// The body of one staff section. Returns null for a view it does not own.
function StaffView({ view, data }) {
  const { profile, onboarding, docs, signed, policies, stubs, folders, hours, setErr, loadFolders } = data;
  if (view === 'onboarding') return <Section><OnboardingSummary onboarding={onboarding} /></Section>;
  if (view === 'welcome' && !profile.isCaregiver) {
    const UI = window.GFCWelcomePacketUI;
    return <Section>{UI ? <UI.StaffWelcomePacket onDone={() => { if (data.reloadProfile) data.reloadProfile(); }} /> : <p className="mg-note">Loading…</p>}</Section>;
  }
  if (view === 'documents') {
    return (
      <div>
        {/* Documents the office sent to sign or acknowledge (owner, 2026-11-09). */}
        {window.GFCDocSign && <Section title="Waiting on You" sub="Documents the office sent you to read and sign or acknowledge. Your copy files below."><window.GFCDocSign.WaitingOnYou onChanged={data.reloadDocs} /></Section>}
        <Section title="What You Signed" sub="Policies and forms you signed, with the version and date."><Signed signed={signed} onError={setErr} /></Section>
        <Section title="Files on Record" sub="Everything on file for you, whether you sent it or the office filed it."><Documents docs={docs} onError={setErr} /></Section>
      </div>
    );
  }
  if (view === 'announcements' && !profile.isCaregiver) {
    return (
      <div>
        <Section><AnnouncementList items={data.news} onReviewed={data.loadNews} onError={setErr} /></Section>
        {profile.isAdmin && <Section title="Post an Announcement" sub="One place to post for the whole team, caregivers included."><ManageAnnouncements onChanged={data.loadNews} /></Section>}
      </div>
    );
  }
  if (view === 'policies') return <Section><Policies policies={policies} isAdmin={!!profile.isAdmin} /></Section>;
  if (view === 'folders') {
    return (
      <div>
        <Section><SharedFolders folders={folders} /></Section>
        {profile.isAdmin && <Section title="Manage Shared Folders" sub="Choose which Drive folders each role or person sees here."><ManageFolders onChanged={loadFolders} /></Section>}
      </div>
    );
  }
  if (view === 'hours') {
    return (
      <div>
        {!profile.isCaregiver && (profile.employmentType === 'W2' || !profile.employmentType) && <Section id="mg-clock" title="Time Clock and Shifts" sub="Clock in when you start work and out when you stop. Shifts the office assigns you are here to accept and clock in on."><StaffClockMount /></Section>}
        {!profile.isCaregiver && profile.employmentType === 'HYBRID' && <Section id="mg-clock" title="Time Clock" sub="For your employed clinical work only. Exam cases are paid by case and are not clocked here."><StaffClockMount /></Section>}
        {!profile.isCaregiver && profile.employmentType === '1099' && <Section id="mg-clock" title="Time Clock"><p className="mg-note">As a contractor, your hours are recorded on your own platform.</p></Section>}
        {!profile.isCaregiver && <Section id="mg-availability" title="My Availability" sub="The days and hours you are available. Update it any time."><StaffAvailabilityMount /></Section>}
        {window.MyPay && window.MyPay.Timesheets && profile.employmentType !== '1099' && <Section id="mg-timesheets" title="My Timesheets" sub="Check your hours after each pay period ends. Tell the office if something is wrong, before payroll runs."><window.MyPay.Timesheets /></Section>}
        <Section title="Pay Stubs" sub="Your pay stubs from payroll. Tax and pay questions go to the office."><PayStubs stubs={stubs} onError={setErr} /></Section>
        {profile.isCaregiver && <Section title="My Hours"><Hours hours={hours} /></Section>}
        {profile.isAdmin && <Section title="Staff Hours"><p className="mg-note">Everyone's clocked hours, caregivers and W-2 staff alike, are corrected in Staff Scheduling → Time Logs. Payroll is run, and the hours file exported, in Payroll.</p><div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}><a className="mg-btn mg-ghost" href="/scheduling">Open Staff Scheduling</a><a className="mg-btn mg-ghost" href="/payroll">Open Payroll</a></div></Section>}
        {/* Payroll (2026-11-08): public/my-pay.js, loaded before this file. */}
        {window.MyPay && <Section id="mg-pay" title="Pay Setup" sub="Your tax forms and how you are paid. Payroll needs these before it can pay you."><window.MyPay.PaySetup /></Section>}
        {window.MyPay && <window.MyPay.ContractorInvoices Section={Section} />}
        {window.MyPay && <Section title="Tax Forms" sub="Your W-2 or 1099."><window.MyPay.TaxForms /></Section>}
      </div>
    );
  }
  if (view === 'account') {
    return (
      <div>
        <Section title="Headshot and Bio" sub="Used for your profile on the GFC website."><BioEditor /></Section>
        {/* The one account area (owner, 2026-11-09): the same cards /account
            shows clients and family, from /account-cards.js. */}
        <Section title="Sign-in and Security" sub="Your password, two-step sign-in, backup codes and the devices you're signed in on.">
          {window.GFCAccount ? <window.GFCAccount.AccountCards /> : <p className="mg-note">Loading…</p>}
        </Section>
      </div>
    );
  }
  return null;
}

window.MyGFC = { DocsWaitingBanner, Shell, Section, Tile, Signed, StaffTiles, StaffView, useStaffData, STAFF_SECTIONS, staffSectionsFor, AnnouncementList,
  OnboardingSummary, LiaisonClients, call, getToken, openFile };
})();
