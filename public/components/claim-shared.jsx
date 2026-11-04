// Shared by the clinical workspace and the billing page (2026-11-04).
//
// One copy of what both screens show of a signed visit: the note as signed,
// the signature, the code search and the service-line editor. A clinician
// codes before signing in /clinical; billing finishes the claim in /billing.
// Two copies of "what a service line is" is how one page starts accepting
// what the other refuses, so both read this file.
//
// Loaded as <script type="text/babel" src>. Babel runs it before the page's
// own script, in document order. Everything is inside one function so its
// names do not collide with the page's; the page takes what it needs from
// window.GFC_CLAIM_SHARED and hands in its API call with configure().
//
// Needs window.GFC_NOTE_FORMAT (/note-format.js) and React.
(function () {
const { useState, useEffect } = React;
const NF = window.GFC_NOTE_FORMAT;
// The page's own API call, set by configure(). Nothing here talks to the
// server itself, so the page's auth and error handling apply unchanged.
const deps = { codeSearch: null };
const fmtTs = (iso) => iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';

// Read-only formatted text. renderHtml ESCAPES every character before it
// applies a shape, so nothing a person typed can become live markup — the
// only raw-HTML render either page has.
const FormattedView = ({ markup, className }) => (
  <div className={`fmt ${className || ''}`} dangerouslySetInnerHTML={{ __html: NF.renderHtml(markup || '') }} />
);

// The signature, bold and set apart at the bottom of the note — the one
// thing on the screen that has to be unmistakable.
const SignatureBlock = ({ signature }) => {
  if (!signature) return null;
  const who = (p) => `${p.name || 'Unknown'}${p.licenseLevel ? `, ${p.licenseLevel}` : ''}${p.npi ? ` (NPI ${p.npi})` : ''}`;
  return (
    <div className="sigblock mt-3">
      <div className="text-[13px] font-extrabold text-primary tracking-wide mb-1">ELECTRONICALLY SIGNED</div>
      <div className="text-[13px] font-bold">
        Signed by {who(signature.signer)}{signature.signer.capacity === 'author' ? ' — author (not a billing signature)' : ''} — {fmtTs(signature.signer.at)}
      </div>
      {signature.billing && <div className="text-[13px] font-bold">Clinician addendum and billing signature: {who(signature.billing)} — {fmtTs(signature.billing.at)}</div>}
      {signature.awaitingAddendum && <div className="text-[13px] font-bold text-amber-800">Awaiting clinician addendum — not billable until a provider (or an LCSW, for behavioral health) adds it.</div>}
      {(signature.coSignatures || []).map((c, i) => <div key={i} className="text-[13px] font-bold">Co-signed by {who(c)} — {fmtTs(c.at)}</div>)}
    </div>
  );
};

// Every saved draft: who saved it and when.
const NoteHistory = ({ revisions }) => {
  const saves = (revisions || []).filter(r => r.action !== 'sign');
  if (!saves.length) return null;
  const label = { create: 'started', save: 'saved', carry_forward: 'carried forward & saved', void: 'discarded' };
  return (
    <details className="text-[11.5px] text-stone-500 mt-2">
      <summary className="cursor-pointer">Note history — {saves.length} save{saves.length === 1 ? '' : 's'}</summary>
      <ul className="mt-1 grid gap-0.5">
        {saves.map(r => (
          <li key={r.id}>v{r.version} · {label[r.action] || 'saved'} by <b>{r.savedBy && r.savedBy.name}</b>{r.savedBy && r.savedBy.licenseLevel ? `, ${r.savedBy.licenseLevel}` : ''} · {fmtTs(r.savedAt)}
            {r.sectionsChanged && r.sectionsChanged.length ? ` · ${r.sectionsChanged.length} section${r.sectionsChanged.length === 1 ? '' : 's'} changed` : ''}</li>
        ))}
      </ul>
    </details>
  );
};

const humanize = (k) => String(k).replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase());
const SignedNoteView = ({ note, noteSections, signature, revisions }) => {
  const n = note || {};
  const v = n.vitals || {};
  const vitalsText = Object.keys(v).length
    ? ((v.bpRightSys || v.bpLeftSys || v.bpRightUnable || v.bpLeftUnable)
      ? ['Right', 'Left'].map(side => {
          const s = `bp${side}`;
          return `${side === 'Right' ? 'BP right' : 'left'} ${v[`${s}Unable`] ? `unable to obtain${v[`${s}UnableReason`] ? ` (${v[`${s}UnableReason`]})` : ''}` : `${v[`${s}Sys`] || '—'}/${v[`${s}Dia`] || '—'}`}`;
        }).join(' · ')
      : `BP ${v.bpSys || '—'}/${v.bpDia || '—'}`) + ` · HR ${v.hr || '—'} · Temp ${v.temp || '—'} · RR ${v.rr || '—'} · SpO₂ ${v.spo2 || '—'}`
    : null;
  const labelOf = (k) => ((noteSections || []).find(s => s.key === k) || {}).label || humanize(k);
  const block = (label, markup) => (markup && !NF.isBlank(markup)
    ? <div key={label}><div className="text-[11px] font-bold text-primary uppercase tracking-wide mb-0.5">{label}</div><FormattedView markup={markup} /></div>
    : null);
  return (
    <div className="grid gap-3">
      {block('Chief concern', n.chiefConcern)}
      {block('Subjective', n.subjective)}
      {vitalsText && <div><div className="text-[11px] font-bold text-primary uppercase tracking-wide mb-0.5">Vitals</div><div className="text-[13px]">{vitalsText}</div></div>}
      {block('Objective', n.objective)}
      {Object.entries(n.hp || {}).filter(([k, o]) => k !== 'triage' && o && Object.keys(o).length).map(([k, o]) => (
        <div key={k}><div className="text-[11px] font-bold text-primary uppercase tracking-wide mb-0.5">{humanize(k)}</div>
          <div className="text-[13px]">{Object.entries(o).map(([kk, vv]) => <div key={kk}>{humanize(kk)}: {vv}</div>)}</div></div>
      ))}
      {block('Assessment', n.assessment)}
      {block('Plan', n.plan)}
      {Object.entries(n.sections || {}).map(([k, m]) => block(labelOf(k), m))}
      <SignatureBlock signature={signature} />
      <NoteHistory revisions={revisions} />
    </div>
  );
};

const SOURCE_META = {
  problem_list: { label: 'Problem list (OpenEMR)', chip: 'bg-emerald-50 text-emerald-700' },
  prior_encounter: { label: 'Prior encounter', chip: 'bg-emerald-50 text-emerald-700' },
  favorite: { label: 'My favorites', chip: 'bg-primary-50 text-primary' },
  practice: { label: 'Practice fee schedule', chip: 'bg-primary-50 text-primary' },
  typed: { label: 'Typed — OpenEMR resolves on read-back', chip: 'bg-amber-50 text-amber-800' },
  manual: { label: 'Entered', chip: 'bg-stone-100 text-stone-600' }
};
const SourceChip = ({ source }) => {
  const m = SOURCE_META[source] || SOURCE_META.manual;
  return <span className={`chip ${m.chip}`}>{m.label}</span>;
};
const npiLabel = (p) => p ? `${p.name || '—'}${p.licenseLevel ? `, ${p.licenseLevel}` : ''} · ${p.npi ? `NPI ${p.npi}` : 'NPI not on file'}` : '—';

// Code picker: results come ONLY from OpenEMR-sourced data (this patient's
// problem list, the clinician's own prior picks, the practice favorites).
// A full code typed in is accepted on format and flagged until OpenEMR
// resolves it. The app holds no code list (spec §7).
const CodePicker = ({ set, clientId, exclude, onPick, placeholder }) => {
  const [q, setQ] = useState('');
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    setBusy(true);
    const t = setTimeout(() => {
      deps.codeSearch({ set, q, clientId: clientId || '' })
        .then(r => { if (alive) setRes(r); })
        .catch(e => { if (alive) setRes({ results: [], error: e.message }); })
        .finally(() => alive && setBusy(false));
    }, 220);
    return () => { alive = false; clearTimeout(t); };
  }, [set, q, clientId]);
  const rows = ((res && res.results) || []).filter(r => !(exclude || []).includes(r.code));
  return (
    <div className="border border-stone-200 rounded-lg p-2 bg-cream">
      <input className="inp" placeholder={placeholder || (set === 'ICD10' ? 'Search code or description, or type a full ICD-10 code (e.g. E11.9)' : 'Type a CPT/HCPCS code (e.g. 99348)')}
        value={q} onChange={e => setQ(e.target.value)} />
      <div className="max-h-44 overflow-y-auto mt-1.5">
        {busy && !res && <p className="text-xs text-stone-400 px-1">Searching…</p>}
        {res && res.error && <p className="text-xs text-red-600 px-1">{res.error}</p>}
        {res && !rows.length && !busy && <p className="text-xs text-stone-400 px-1">{q ? 'No match. Type the full code to add it.' : 'Start typing, or pick from your favorites below.'}</p>}
        {rows.map(r => (
          <button key={r.code} type="button" className="w-full text-left flex items-center justify-between gap-2 px-2 py-1.5 rounded hover:bg-white" onClick={() => { onPick(r); setQ(''); }}>
            <span className="text-[13px]"><b className="font-mono">{r.code}</b> {r.description || r.label || ''}</span>
            <SourceChip source={r.source} />
          </button>
        ))}
      </div>
      {res && res.notice && <p className="text-[10px] text-stone-400 px-1 mt-1">{res.notice}</p>}
    </div>
  );
};

// Service (CPT/HCPCS) editor: each line must link to ≥1 encounter diagnosis.
const SvcEditor = ({ services, setServices, diagnoses, practiceFavorites, favorites, readOnly }) => {
  const has = (code) => services.some(s => s.code === code);
  const add = (r) => { if (!has(r.code)) setServices([...services, { code: r.code, codeType: r.codeType, label: r.label || r.description || '', units: 1, dxLinks: diagnoses.map(d => d.code), modifiers: [] }]); };
  const update = (code, patch) => setServices(services.map(s => s.code === code ? { ...s, ...patch } : s));
  const remove = (code) => setServices(services.filter(s => s.code !== code));
  const favCodes = new Set((favorites || []).map(f => f.code));
  const quick = [...(favorites || []).map(f => ({ ...f, source: 'favorite' })), ...(practiceFavorites || []).filter(f => !favCodes.has(f.code)).map(f => ({ ...f, source: 'practice' }))];
  return (
    <div className="grid gap-2">
      {services.length === 0 && <p className="text-xs text-stone-400">No service codes on this encounter yet.</p>}
      {services.map(s => (
        <div key={s.code} className="py-1.5 border-b border-stone-100">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-[13px]"><b className="font-mono">{s.code}</b> <span className="text-stone-500">{s.codeType}</span> {s.label}</div>
            {!readOnly && (
              <div className="flex items-center gap-2 text-xs">
                <label className="flex items-center gap-1">units <input className="inp !w-14 !py-0.5" value={s.units} onChange={e => update(s.code, { units: e.target.value.replace(/\D/g, '') || 1 })} /></label>
                <label className="flex items-center gap-1">mod <input className="inp !w-20 !py-0.5" placeholder="25" value={(s.modifiers || []).join(',')} onChange={e => update(s.code, { modifiers: e.target.value.split(',').map(x => x.trim()).filter(Boolean) })} /></label>
                <button type="button" className="text-red-600" onClick={() => remove(s.code)}><i className="ti ti-x" /></button>
              </div>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-1.5 mt-1 text-[11px] text-stone-500">
            Linked dx:
            {diagnoses.length === 0 && <span className="text-amber-700">add a diagnosis first</span>}
            {diagnoses.map(d => (
              <label key={d.code} className={`chip border cursor-pointer ${(s.dxLinks || []).includes(d.code) ? 'bg-primary text-white border-primary' : 'bg-white text-primary border-stone-200'}`}>
                <input type="checkbox" className="hidden" disabled={readOnly} checked={(s.dxLinks || []).includes(d.code)}
                  onChange={e => update(s.code, { dxLinks: e.target.checked ? [...(s.dxLinks || []), d.code] : (s.dxLinks || []).filter(c => c !== d.code) })} />
                {d.code}
              </label>
            ))}
            {!(s.dxLinks || []).length && diagnoses.length > 0 && <span className="text-red-600">must link to at least one</span>}
          </div>
        </div>
      ))}
      {!readOnly && (
        <div>
          <div className="lblu mb-1">Quick pick — your most-used first, then the practice fee schedule</div>
          <div className="flex flex-wrap gap-1.5 mb-2">
            {quick.filter(f => !has(f.code)).map(f => (
              <button key={f.code} type="button" className={`chip border ${f.source === 'favorite' ? 'bg-primary-50 text-primary border-primary' : 'bg-white text-primary border-stone-200'}`} onClick={() => add(f)} title={f.source === 'favorite' ? `used ${f.count}×` : 'practice favorite'}>
                + {f.code}{f.label ? ` · ${f.label}` : ''}
              </button>
            ))}
            {quick.length === 0 && <span className="text-xs text-stone-400">No favorites yet — an admin can seed the practice list in Settings.</span>}
          </div>
          <CodePicker set="SERVICE" exclude={services.map(s => s.code)} onPick={add} />
        </div>
      )}
    </div>
  );
};

window.GFC_CLAIM_SHARED = {
  configure: (d) => Object.assign(deps, d || {}),
  fmtTs, humanize, npiLabel, SOURCE_META,
  FormattedView, SignatureBlock, NoteHistory, SignedNoteView, SourceChip, CodePicker, SvcEditor
};
})();
