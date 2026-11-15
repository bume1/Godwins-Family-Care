// ============================================================================
// CLIENT ACCOUNTS, SHARED (owner, 2026-11-09)
// ============================================================================
// Everything User Management used to do for a client or family account,
// in one place, read by the Clients page (/clients) and, for the pay and
// rate queue, by the Admin Hub. One copy, so the two screens cannot drift.
//
// Every save sends ONLY the keys it changes: PUT /api/users/:id keeps any key
// a body leaves out, so nothing here round-trips a whole user record.
// Module scope throughout, so typing never loses focus.
// ============================================================================
(function () {
  const { useState, useEffect, useRef } = React;
  const tokenOf = () => localStorage.getItem('admin_token') || localStorage.getItem('unified_token');

  // { ...json } on success, { error, code, existingUser } on failure. Never throws.
  async function req(path, { method = 'GET', body, token } = {}) {
    try {
      const res = await fetch(path, {
        method,
        headers: Object.assign({ Authorization: `Bearer ${token || tokenOf()}` }, body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        body: body !== undefined ? JSON.stringify(body) : undefined
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return { error: data.error || `The server answered ${res.status}.`, code: data.code || null, existingUser: data.existingUser || null };
      return data;
    } catch (e) { return { error: e.message || 'Could not reach the server.' }; }
  }
  const updateUser = (id, body) => req(`/api/users/${encodeURIComponent(id)}`, { method: 'PUT', body });
  const isSuperAdmin = (me) => !!me && me.role === 'admin';
  const isOffice = (me) => !!me && (me.role === 'admin' || me.isManager === true);

  // Stash the admin's own tokens, put the viewed person's token in every key
  // a page reads, and go where their own login would send them. Exit (the
  // banner from session-guard.js) puts the admin's tokens back.
  const VIEW_AS_TOKEN_KEYS = ['unified_token', 'admin_token', 'portal_token', 'unified_user', 'admin_user', 'portal_user'];
  async function startViewAs(token, user, setMessage) {
    if (!window.confirm(`View the app as ${user.name || user.email}?\n\nYou will see and use exactly what they do for up to 60 minutes. Signing anything, OpenEMR and their account settings stay off. Emails and notifications still send for real.\n\nEvery action is logged as you acting as them. Use the Exit button in the gold banner to come back.`)) return;
    const result = await req(`/api/admin/impersonate/${encodeURIComponent(user.id)}`, { method: 'POST', token });
    if (result.error || !result.token) { setMessage(`Error: ${result.error || 'Could not start View as.'}`); return; }
    const tokens = {};
    VIEW_AS_TOKEN_KEYS.forEach(k => { const v = localStorage.getItem(k); if (v) tokens[k] = v; });
    localStorage.setItem('gfc_view_as_return', JSON.stringify({ tokens, startedAt: new Date().toISOString() }));
    ['unified_token', 'admin_token', 'portal_token'].forEach(k => localStorage.setItem(k, result.token));
    ['unified_user', 'admin_user', 'portal_user'].forEach(k => localStorage.setItem(k, JSON.stringify(result.user)));
    window.location.href = result.destination || '/login';
  }

  // ── Moving a patient's login to their POA (owner, 2026-10-20) ───────────
  // POAs had been signing in with the patient's own account, so what they
  // signed reads as the patient. The server moves the login (email, password,
  // MFA) onto a family account with a POA link and gives the patient a
  // placeholder login; the POA signs in exactly as before.
  const PoaCutoverDialog = ({ token, client, users, onClose, onDone, initial }) => {
    const familyUsers = users.filter(u => u.role === 'family');
    const start = initial || {};
    const [mode, setMode] = useState('move');
    const [targetId, setTargetId] = useState('');
    const [name, setName] = useState(start.name || '');
    const [phone, setPhone] = useState(start.phone || '');
    const [relationship, setRelationship] = useState(start.relationship || '');
    const [note, setNote] = useState('');
    const [confirmName, setConfirmName] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    // A placeholder family account (no login of its own) can take the login;
    // one with its own login can only be linked, never merged.
    const noLoginFamily = familyUsers.filter(u => u.noLogin);
    const withLoginFamily = familyUsers.filter(u => !u.noLogin);
    const submit = async () => {
      setBusy(true); setError('');
      const body = { mode, confirmName, note, relationship };
      if (targetId) body.targetFamilyId = targetId;
      else { body.name = name; body.phone = phone; }
      const r = await req(`/api/gfc/admin/clients/${encodeURIComponent(client.id)}/poa-cutover`, { method: 'POST', body, token });
      setBusy(false);
      if (r.error) { setError(r.error); return; }
      onDone(r);
    };
    return (
      <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[60] p-4">
        <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg p-6 max-h-[90vh] overflow-y-auto">
          <h2 className="text-lg font-bold mb-2" style={{ color: '#033D50' }}>Move {client.name}'s login to their POA</h2>
          <p className="text-sm text-gray-600 mb-4">
            The POA keeps signing in with the same email and password. From now on, what they sign or send reads as them, acting as POA for {client.name}.
            {' '}{client.name}'s own sign-in stops working. Nothing already signed is changed.
          </p>
          <div className="space-y-2 mb-4">
            <label className="flex items-start gap-2 text-sm">
              <input type="radio" className="mt-1" checked={mode === 'move'} onChange={() => { setMode('move'); setTargetId(''); }} />
              <span><span className="font-medium">Move the login to the POA.</span> Use this when the POA has no account of their own yet.</span>
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input type="radio" className="mt-1" checked={mode === 'link_existing'} onChange={() => { setMode('link_existing'); setTargetId(''); }} />
              <span><span className="font-medium">The POA already has their own login.</span> Link {client.name} to it and retire this one. They then sign in with their own login only.</span>
            </label>
          </div>
          {mode === 'move' ? (
            <div className="space-y-3 mb-4">
              {noLoginFamily.length > 0 && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">POA account</label>
                  <select value={targetId} onChange={(e) => setTargetId(e.target.value)} className="w-full px-3 py-2 border rounded-lg">
                    <option value="">Create a new POA account</option>
                    {noLoginFamily.map(u => <option key={u.id} value={u.id}>{u.name} (no login yet)</option>)}
                  </select>
                </div>
              )}
              {!targetId && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">POA's name *</label>
                    <input type="text" value={name} onChange={(e) => setName(e.target.value)} className="w-full px-3 py-2 border rounded-lg" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">POA's phone</label>
                    <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} className="w-full px-3 py-2 border rounded-lg" />
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-1">The POA's existing account *</label>
              <select value={targetId} onChange={(e) => setTargetId(e.target.value)} className="w-full px-3 py-2 border rounded-lg">
                <option value="">Choose…</option>
                {withLoginFamily.map(u => <option key={u.id} value={u.id}>{u.name} ({u.email})</option>)}
              </select>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3 mb-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Relationship</label>
              <input type="text" value={relationship} placeholder="e.g. Husband" onChange={(e) => setRelationship(e.target.value)} className="w-full px-3 py-2 border rounded-lg" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Note (optional)</label>
              <input type="text" value={note} onChange={(e) => setNote(e.target.value)} className="w-full px-3 py-2 border rounded-lg" />
            </div>
          </div>
          <p className="text-xs text-gray-500 mb-3">Only do this once the POA document is verified on file. The POA will be signed out once and signs back in as usual.</p>
          <label className="block text-sm font-medium text-gray-700 mb-1">Type the patient's name to confirm</label>
          <input type="text" value={confirmName} placeholder={client.name} onChange={(e) => setConfirmName(e.target.value)} className="w-full px-3 py-2 border rounded-lg mb-3" />
          {error && <p className="text-sm text-red-700 mb-3">{error}</p>}
          <div className="flex gap-3">
            <button type="button" disabled={busy} onClick={submit} className="flex-1 px-4 py-2.5 text-white rounded-lg hover:opacity-90 disabled:opacity-50 font-medium" style={{ background: '#033D50' }}>
              {busy ? 'Moving…' : 'Move Login'}
            </button>
            <button type="button" onClick={onClose} className="px-4 py-2.5 border border-gray-300 rounded-lg hover:bg-gray-50 font-medium">Cancel</button>
          </div>
        </div>
      </div>
    );
  };

  // Pay and rate changes a manager or care coordinator asked for (owner,
  // 2026-11-03). The Super Admin approves or declines; everyone else sees
  // what is waiting so nobody asks twice.
  const fmtFinancial = (field, v) => {
    if (v === null || v === undefined) return 'not set';
    if (field === 'payRate') return `$${Number(v).toFixed(2)}/hr`;
    if (field === 'rateAgreement') return `$${Number(v.hourlyRate).toFixed(2)}/hr, ${v.dailyMinimumHours} hr daily minimum`;
    if (field === 'billingSettings') return v.copayCents == null ? 'no copay' : `$${(v.copayCents / 100).toFixed(2)} copay`;
    if (field === 'clientPayRates') return `${Object.keys(v).length} per-client rate${Object.keys(v).length === 1 ? '' : 's'}`;
    return String(v);
  };
  const FinancialChangeQueue = ({ token, requests, canDecide, onChanged }) => {
    const [notes, setNotes] = useState({});
    const [msg, setMsg] = useState('');
    if (!requests.length) return null;
    const decide = async (id, decision) => {
      setMsg('');
      const r = await req(`/api/users/financial-change-requests/${encodeURIComponent(id)}/decide`, { method: 'POST', body: { decision, note: notes[id] || '' }, token });
      if (r.error) setMsg(`Error: ${r.error}`); else { setMsg(decision === 'approved' ? 'Approved and saved on the record.' : 'Declined. Nothing changed.'); onChanged(); }
    };
    return (
      <div className="bg-amber-50 border border-amber-300 p-4 rounded-xl">
        <p className="font-semibold text-amber-900">{requests.length} pay or rate change{requests.length === 1 ? '' : 's'} waiting on the Super Admin</p>
        {msg && <p className="text-sm mt-1">{msg}</p>}
        <div className="mt-2 space-y-3">
          {requests.map(r => (
            <div key={r.id} className="text-sm text-amber-900">
              <div><b>{r.userName}</b>: {r.label} from {fmtFinancial(r.field, r.currentValue)} to {fmtFinancial(r.field, r.requestedValue)}. Asked by {r.requestedByName}{r.reason ? `: ${r.reason}` : '.'}</div>
              {canDecide && (
                <div className="flex flex-wrap gap-2 mt-1 items-center">
                  <input className="px-3 py-1.5 border border-amber-300 rounded-lg" placeholder="Note (optional)"
                    value={notes[r.id] || ''} onChange={e => setNotes({ ...notes, [r.id]: e.target.value })} />
                  <button type="button" className="px-3 py-1.5 text-white rounded-lg" style={{ background: '#033D50' }} onClick={() => decide(r.id, 'approved')}>Approve</button>
                  <button type="button" className="px-3 py-1.5 border border-amber-400 rounded-lg" onClick={() => decide(r.id, 'declined')}>Decline</button>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    );
  };

  // The app cannot tell for sure which patient logins are really the POA's,
  // so this only suggests, and says why. Nothing is ever moved on its own.
  const PossiblePoaLogins = ({ token, users, onOpen }) => {
    const [rows, setRows] = useState(null);
    const [open, setOpen] = useState(false);
    useEffect(() => {
      let live = true;
      req('/api/gfc/admin/clients/possible-poa-logins', { token }).then(r => {
        if (!live) return;
        const list = r && Array.isArray(r.clients) ? r.clients : [];
        setRows(list.filter(x => x && x.id).map(x => ({ id: String(x.id), name: typeof x.name === 'string' ? x.name : 'Patient', flagged: !!x.flagged, reasons: Array.isArray(x.reasons) ? x.reasons.map(String) : [] })));
      });
      return () => { live = false; };
    }, [token, users.length]);
    if (!rows || !rows.length) return null;
    const flagged = rows.filter(r => r.flagged).length;
    return (
      <div className="bg-blue-50 border border-blue-200 p-4 rounded-xl">
        <button type="button" onClick={() => setOpen(!open)} className="w-full text-left">
          <p className="font-semibold text-blue-900">
            {rows.length} patient login{rows.length === 1 ? '' : 's'} may be used by a POA{flagged ? ` (${flagged} flagged)` : ''} {open ? '▴' : '▾'}
          </p>
          <p className="text-sm text-blue-800 mt-1">When a POA signs in as the patient, what they sign reads as the patient. Open each one to check and, if so, move the login to the POA.</p>
        </button>
        {open && (
          <div className="mt-3 space-y-2">
            {rows.map(r => (
              <div key={r.id} className="flex items-start justify-between gap-3 bg-white border border-blue-200 rounded-lg p-3">
                <div>
                  <p className="text-sm font-medium text-gray-800">{r.name}{r.flagged ? ' · flagged' : ''}</p>
                  <ul className="text-xs text-gray-600 mt-1 list-disc ml-4">{r.reasons.map((x, i) => <li key={i}>{x}</li>)}</ul>
                </div>
                <button type="button" onClick={() => onOpen(r.id)} className="px-3 py-1.5 text-sm bg-white border border-blue-300 text-blue-900 rounded-lg hover:bg-blue-100 whitespace-nowrap">Open</button>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  // ── Small building blocks ──────────────────────────────────────────────
  const Field = ({ label, children, hint }) => (
    <div className="mb-3"><label className="label">{label}</label>{children}{hint && <p className="text-xs text-gray-500 mt-1">{hint}</p>}</div>
  );
  const Msg = ({ msg }) => (!msg ? null : <p className={`text-sm mt-2 ${/^Error/.test(msg) ? 'text-red-600' : 'text-green-700'}`}>{msg}</p>);
  const Block = ({ title, children, id }) => (
    <div id={id} className="border-t pt-4 mt-4 first:border-t-0 first:pt-0 first:mt-0"><h4 className="font-semibold text-gray-800 mb-2">{title}</h4>{children}</div>
  );
  // The care team pickers, the same lists User Management offered.
  const careTeamChoices = (users) => ({
    caregivers: users.filter(u => u.role === 'vendor'),
    caseManagers: users.filter(u => (u.role === 'caseManager' && u.clinicalRole !== 'coordinator') || (u.role === 'user' && ['lmsw', 'lcsw'].includes(u.clinicalRole))),
    fnps: users.filter(u => u.role === 'user' && u.hasClinicalAccess),
    coordinators: users.filter(u => u.clinicalRole === 'coordinator' && u.accountStatus !== 'inactive')
  });
  const EMPTY_TEAM = { assignedFNPs: [], assignedCaseManager: '', primaryCaregiver: '', backupCaregiver: '', careCoordinators: [], leadCaregivers: [] };

  const CareTeamFields = ({ team, setTeam, users }) => {
    const c = careTeamChoices(users);
    const t = Object.assign({}, EMPTY_TEAM, team || {});
    // A lead caregiver must still be this client's caregiver: changing the
    // primary or backup drops anyone who is no longer either from the leads.
    const pick = (k, v) => {
      const next = Object.assign({}, t, { [k]: v });
      const onTeam = [next.primaryCaregiver, next.backupCaregiver].filter(Boolean);
      next.leadCaregivers = (next.leadCaregivers || []).filter(id => onTeam.includes(id));
      setTeam(next);
    };
    const multi = (k) => (e) => pick(k, Array.from(e.target.selectedOptions).map(o => o.value));
    // Owner, 2026-11-11: a GFC caregiver an admin names here also sees what
    // was shared with the patient (shared documents, medicines and allergies,
    // visit summaries, appointments) in the caregiver app. Never clinical notes.
    const leads = t.leadCaregivers || [];
    const leadTick = (id) => id ? (
      <label className="flex items-start gap-2 text-xs text-gray-600 -mt-1 mb-3">
        <input type="checkbox" className="mt-0.5" checked={leads.includes(id)}
          onChange={e => setTeam(Object.assign({}, t, { leadCaregivers: e.target.checked ? [...leads.filter(x => x !== id), id] : leads.filter(x => x !== id) }))} />
        <span>Lead caregiver: can also see what was shared with the patient (documents, medicines, visit summaries, appointments). Not clinical notes or results.</span>
      </label>
    ) : null;
    return (
      <div className="grid md:grid-cols-2 gap-x-4">
        <Field label="Primary Caregiver">
          <select className="input" value={t.primaryCaregiver} onChange={e => pick('primaryCaregiver', e.target.value)}>
            <option value="">None</option>{c.caregivers.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
          {leadTick(t.primaryCaregiver)}
        </Field>
        <Field label="Backup Caregiver">
          <select className="input" value={t.backupCaregiver} onChange={e => pick('backupCaregiver', e.target.value)}>
            <option value="">None</option>{c.caregivers.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
          {leadTick(t.backupCaregiver)}
        </Field>
        <Field label="Assigned Case Manager">
          <select className="input" value={t.assignedCaseManager} onChange={e => pick('assignedCaseManager', e.target.value)}>
            <option value="">None</option>{c.caseManagers.map(u => <option key={u.id} value={u.id}>{u.name}{u.role === 'user' ? ` (${String(u.clinicalRole).toUpperCase()})` : ''}</option>)}
          </select>
        </Field>
        <Field label="Assigned FNPs" hint="Hold Ctrl or Cmd to choose more than one.">
          <select className="input" multiple size="4" value={t.assignedFNPs} onChange={multi('assignedFNPs')}>
            {c.fnps.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        </Field>
        <Field label="Care Coordinators" hint="They support this client's case manager and prepare notes for the clinician to sign.">
          <select className="input" multiple size="4" value={t.careCoordinators || []} onChange={multi('careCoordinators')}>
            {c.coordinators.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        </Field>
      </div>
    );
  };

  // A client photo: a headshot, stored as `logo` (the key predates GFC).
  const readPhoto = (file) => new Promise((resolve, reject) => {
    if (!file) return resolve(null);
    if (file.size > 2 * 1024 * 1024) return reject(new Error('The photo must be under 2 MB.'));
    const r = new FileReader(); r.onloadend = () => resolve(r.result); r.onerror = () => reject(new Error('That file could not be read.')); r.readAsDataURL(file);
  });

  // ── Account recovery (Super Admin) ─────────────────────────────────────
  const AccountRecovery = ({ token, person, me, onChanged }) => {
    const [busy, setBusy] = useState(false); const [msg, setMsg] = useState('');
    const [pw, setPw] = useState(''); const [showPw, setShowPw] = useState(false);
    if (!isSuperAdmin(me)) return null;
    const run = async (confirmText, fn, ok) => {
      if (confirmText && !window.confirm(confirmText)) return;
      setBusy(true); setMsg('');
      const r = await fn(); setBusy(false);
      if (r && r.error) { setMsg(`Error: ${r.error}`); return; }
      setMsg(typeof ok === 'function' ? ok(r) : ok); onChanged && onChanged();
    };
    const name = person.name || 'this person';
    return (
      <Block title="Account Recovery">
        <div className="flex flex-wrap gap-2">
          {person.accountStatus !== 'inactive' && <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => startViewAs(token, person, setMsg)}>View As</button>}
          <button type="button" className="btn btn-ghost" disabled={busy || !person.mfaEnrolled}
            onClick={() => run(`Reset ${name}'s authenticator? Every session they hold ends now and they set it up again at their next sign-in.`, () => req(`/api/users/${encodeURIComponent(person.id)}/mfa/reset`, { method: 'POST', token }), 'Authenticator reset.')}>Reset Authenticator</button>
          <button type="button" className="btn btn-ghost" disabled={busy || person.noLogin}
            onClick={() => run(`Email ${name} a password reset link?\n\nTheir current password stops working straight away and a secure link is emailed to ${person.email}.`, () => req(`/api/admin/reset-user-password/${encodeURIComponent(person.id)}`, { method: 'POST', body: {}, token }), `A password reset link has been emailed to ${person.email}. Their old password no longer works.`)}>Email Reset Link</button>
          <button type="button" className="btn btn-ghost" disabled={busy}
            onClick={() => run(`Sign ${name} out everywhere?\n\nEvery device they are signed in on is ended. Their password is unchanged.`, () => req(`/api/users/${encodeURIComponent(person.id)}/sessions/revoke`, { method: 'POST', token }),
              (r) => (r.revoked ? `${name} was signed out of ${r.revoked} session${r.revoked === 1 ? '' : 's'}.` : `${name} had no active sessions, so nothing was signed out.`))}>Sign Out Everywhere</button>
          <button type="button" className="btn btn-ghost" disabled={busy || person.noLogin} onClick={() => setShowPw(!showPw)}>Set a New Password</button>
        </div>
        <p className="text-xs text-gray-500 mt-2">Authenticator: {person.mfaEnrolled ? 'set up' : 'not set up'}.</p>
        {person.noLogin && <p className="text-xs text-gray-500 mt-2">No login of their own (a placeholder). Reset their POA's password instead.</p>}
        {showPw && (
          <div className="flex gap-2 mt-3 flex-wrap">
            <input className="input" style={{ maxWidth: 280 }} type="password" autoComplete="new-password" placeholder="New temporary password" value={pw} onChange={e => setPw(e.target.value)} />
            <button type="button" className="btn btn-primary" disabled={busy || !pw} onClick={() => run(null, () => updateUser(person.id, { password: pw, resetPassword: true }), 'Password set. They are emailed a link.').then(() => { setPw(''); setShowPw(false); })}>Save Password</button>
          </div>
        )}
        <Msg msg={msg} />
      </Block>
    );
  };

  // ── The client's account, on their record ──────────────────────────────
  // Account & Login for one client. Each block saves only its own keys.
  const ClientAccountSection = ({ token, client, users, projects, me, onChanged, onDeleted }) => {
    const [basic, setBasic] = useState({ name: client.name || '', email: client.email || '', phone: client.phone || '' });
    const [portalName, setPortalName] = useState(client.practiceName || '');
    const [status, setStatus] = useState(client.enrollmentStatus || 'intake_pending');
    const [assigned, setAssigned] = useState(client.assignedProjects || []);
    const [busy, setBusy] = useState(false); const [msg, setMsg] = useState('');
    const [cutover, setCutover] = useState(false);
    const photoRef = useRef(null);
    useEffect(() => {
      setBasic({ name: client.name || '', email: client.email || '', phone: client.phone || '' });
      setPortalName(client.practiceName || ''); setStatus(client.enrollmentStatus || 'intake_pending'); setAssigned(client.assignedProjects || []);
    }, [client.id, client.name, client.email, client.phone, client.practiceName, client.enrollmentStatus]);
    const save = async (body, ok) => {
      setBusy(true); setMsg('');
      const r = await updateUser(client.id, body); setBusy(false);
      if (r.error) { setMsg(`Error: ${r.error}`); return false; }
      setMsg(r.message || ok); onChanged && onChanged(); return true;
    };
    const active = client.accountStatus !== 'inactive';
    return (
      <div>
        <Block title="Name and Contact">
          <div className="grid md:grid-cols-3 gap-x-4">
            <Field label="Name"><input className="input" value={basic.name} onChange={e => setBasic({ ...basic, name: e.target.value })} /></Field>
            <Field label="Email">
              {client.noLogin
                ? <p className="text-sm text-gray-500 py-2">No login (placeholder). Their POA signs in with their own account.</p>
                : <input className="input" type="email" autoComplete="off" value={basic.email} onChange={e => setBasic({ ...basic, email: e.target.value })} />}
            </Field>
            <Field label="Phone"><input className="input" type="tel" value={basic.phone} onChange={e => setBasic({ ...basic, phone: e.target.value })} /></Field>
          </div>
          <button type="button" className="btn btn-primary" disabled={busy || !basic.name.trim()}
            onClick={() => save(client.noLogin ? { name: basic.name, phone: basic.phone } : basic, 'Saved.')}>Save</button>
          <p className="text-xs text-gray-500 mt-2">Account type: Client. A patient's account type can't be changed: it would hide their care team and records. If their POA has been using this login, use "Move this login to the POA" below.</p>
        </Block>

        <Block title="Status and Email">
          <div className="flex flex-wrap gap-2 items-center">
            <span className={`badge ${active ? 'bg-success-50 text-success-600' : 'bg-red-50 text-red-600'}`}>{active ? 'Active' : 'Inactive'}</span>
            <button type="button" className="btn btn-ghost" disabled={busy}
              onClick={() => { if (window.confirm(`${active ? 'Deactivate' : 'Reactivate'} ${client.name}'s account?${active ? '\n\nThey will be unable to sign in until reactivated.' : ''}`)) save({ accountStatus: active ? 'inactive' : 'active' }, active ? 'Account deactivated.' : 'Account reactivated.'); }}>
              {active ? 'Deactivate' : 'Reactivate'}
            </button>
            <span className={`badge ${client.emailUnsubscribed ? 'bg-orange-50 text-orange-600' : 'bg-gray-100 text-gray-600'}`}>{client.emailUnsubscribed ? 'Unsubscribed from emails' : 'Gets automated emails'}</span>
            <button type="button" className="btn btn-ghost" disabled={busy}
              onClick={() => { if (window.confirm(`${client.emailUnsubscribed ? 'Resubscribe' : 'Unsubscribe'} ${client.name} ${client.emailUnsubscribed ? 'to' : 'from'} automated emails?`)) save({ emailUnsubscribed: !client.emailUnsubscribed }, client.emailUnsubscribed ? 'Resubscribed to automated emails.' : 'Unsubscribed from automated emails.'); }}>
              {client.emailUnsubscribed ? 'Resubscribe' : 'Unsubscribe'}
            </button>
          </div>
        </Block>

        <Block title="Portal">
          <Field label="Name (shown on their portal)" hint="This also sets their portal address. Changing it keeps the old address working.">
            <div className="flex gap-2 flex-wrap">
              <input className="input" style={{ maxWidth: 360 }} value={portalName} onChange={e => setPortalName(e.target.value)} />
              <button type="button" className="btn btn-primary" disabled={busy || !portalName.trim() || portalName === client.practiceName} onClick={() => save({ practiceName: portalName }, 'Saved. Their portal address follows the new name.')}>Save</button>
            </div>
          </Field>
          {client.slug && <p className="text-sm text-gray-700"><span className="font-medium">Client Portal URL:</span> {window.location.origin}/portal/{client.slug}</p>}
          {(client.previousSlugs || []).length > 0 && <p className="text-xs text-gray-500 mt-1">Earlier addresses still work: {client.previousSlugs.map(s => `/portal/${s}`).join(', ')}</p>}
          <Field label="Client Photo" hint="A headshot helps caregivers recognise who they are visiting. Max 2 MB, PNG or JPEG.">
            <div className="flex items-center gap-3">
              {client.logo && <img src={client.logo} alt="" className="h-16 w-16 object-cover border rounded-full" />}
              <input type="file" ref={photoRef} accept="image/png,image/jpeg" className="hidden"
                onChange={async e => { try { const d = await readPhoto(e.target.files[0]); if (d) await save({ logo: d }, 'Photo saved.'); } catch (x) { setMsg(`Error: ${x.message}`); } e.target.value = ''; }} />
              <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => photoRef.current && photoRef.current.click()}>Upload Photo</button>
              {client.logo && <button type="button" className="btn btn-danger" disabled={busy} onClick={() => save({ logo: '' }, 'Photo removed.')}>Remove</button>}
            </div>
          </Field>
        </Block>

        <Block title="Enrollment Status">
          <div className="flex gap-2 flex-wrap">
            <select className="input" style={{ maxWidth: 260 }} value={status} onChange={e => setStatus(e.target.value)}>
              <option value="intake_pending">Intake Pending</option>
              <option value="intake_complete">Intake Complete</option>
              <option value="enrolled">Enrolled</option>
            </select>
            <button type="button" className="btn btn-primary" disabled={busy || status === (client.enrollmentStatus || 'intake_pending')} onClick={() => save({ enrollmentStatus: status }, 'Enrollment status saved.')}>Save</button>
          </div>
          <p className="text-xs text-gray-500 mt-1">Setting Enrolled while items are still outstanding is recorded as an override. Approve Enrollment below checks everything first.</p>
        </Block>

        {!client.noLogin && (
          <Block title="Who Uses This Login">
            <label className="flex items-start gap-2 text-sm text-gray-700">
              <input type="checkbox" className="mt-0.5" checked={!!client.loginHeldByPoa} disabled={busy}
                onChange={e => save({ loginHeldByPoa: e.target.checked }, 'Saved.')} />
              <span><span className="font-medium">This login is used by the patient's POA</span>, not the patient. Anything signed or sent with it reads as the patient.</span>
            </label>
            {client.loginHeldByPoa && (
              <button type="button" className="btn btn-primary mt-3" onClick={() => setCutover(true)}>Move This Login to the POA…</button>
            )}
          </Block>
        )}
        {client.poaCutover && (
          <p className="mt-3 text-xs text-gray-600 p-3 bg-gray-50 rounded-lg">
            This patient's login was moved to their POA on {new Date(client.poaCutover.at).toLocaleDateString()} by {(client.poaCutover.by && client.poaCutover.by.name) || 'an admin'}. Before then, entries made with it read as the patient.
          </p>
        )}

        {(projects || []).length > 0 && (
          <Block title="Project Access">
            <p className="text-xs text-gray-500 mb-2">Projects this client can view in their portal.</p>
            <div className="max-h-48 overflow-y-auto border rounded-lg p-2 space-y-1">
              {projects.map(p => (
                <label key={p.id} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={assigned.includes(p.id)} onChange={() => setAssigned(assigned.includes(p.id) ? assigned.filter(x => x !== p.id) : assigned.concat(p.id))} />
                  {p.name || p.clientName}
                </label>
              ))}
            </div>
            <button type="button" className="btn btn-primary mt-2" disabled={busy} onClick={() => save({ assignedProjects: assigned }, 'Project access saved.')}>Save</button>
          </Block>
        )}

        <AccountRecovery token={token} person={client} me={me} onChanged={onChanged} />

        {isSuperAdmin(me) && (
          <Block title="Delete Client">
            <button type="button" className="btn btn-danger" disabled={busy}
              onClick={async () => {
                if (!window.confirm(`Delete ${client.name}'s account? This cannot be undone.`)) return;
                setBusy(true); const r = await req(`/api/users/${encodeURIComponent(client.id)}`, { method: 'DELETE', token }); setBusy(false);
                if (r.error) setMsg(`Error: ${r.error}`); else onDeleted && onDeleted();
              }}>Delete Client</button>
          </Block>
        )}
        <Msg msg={msg} />
        {cutover && <PoaCutoverDialog token={token} client={client} users={users} onClose={() => setCutover(false)}
          onDone={() => { setCutover(false); setMsg('The login now belongs to the POA.'); onChanged && onChanged(); }} />}
      </div>
    );
  };

  // ── Care team, on their record ─────────────────────────────────────────
  const CareTeamSection = ({ client, users, onChanged }) => {
    const [team, setTeam] = useState(Object.assign({}, EMPTY_TEAM, client.careTeam || {}));
    const [busy, setBusy] = useState(false); const [msg, setMsg] = useState('');
    useEffect(() => { setTeam(Object.assign({}, EMPTY_TEAM, client.careTeam || {})); }, [client.id, JSON.stringify(client.careTeam || {})]);
    return (
      <div>
        <CareTeamFields team={team} setTeam={setTeam} users={users} />
        <button type="button" className="btn btn-primary" disabled={busy} onClick={async () => {
          setBusy(true); setMsg(''); const r = await updateUser(client.id, { careTeam: team }); setBusy(false);
          if (r.error) setMsg(`Error: ${r.error}`); else { setMsg('Care team saved.'); onChanged && onChanged(); }
        }}>Save Care Team</button>
        <Msg msg={msg} />
      </div>
    );
  };

  // ── Family and authorized contacts ─────────────────────────────────────
  const linksOf = (f) => (f.familyLinks || []).map(l => ({ clientId: String(l.clientId), isPoa: !!l.isPoa, relationship: l.relationship || '' }));
  const familyFor = (users, clientId) => users.filter(u => u.role === 'family' && linksOf(u).some(l => l.clientId === String(clientId)));

  // One family member's link to this client: relationship and POA, saved on
  // their own account (familyLinks), never on the client.
  const FamilyLinkRow = ({ family, clientId, me, token, onChanged }) => {
    const link = linksOf(family).find(l => l.clientId === String(clientId)) || { clientId: String(clientId), isPoa: false, relationship: '' };
    const [rel, setRel] = useState(link.relationship); const [poa, setPoa] = useState(link.isPoa);
    const [busy, setBusy] = useState(false); const [msg, setMsg] = useState('');
    const write = async (links, ok) => {
      setBusy(true); setMsg(''); const r = await updateUser(family.id, { familyLinks: links }); setBusy(false);
      if (r.error) setMsg(`Error: ${r.error}`); else { setMsg(ok); onChanged && onChanged(); }
    };
    const others = linksOf(family).filter(l => l.clientId !== String(clientId));
    return (
      <div className="border rounded-lg p-3 mb-2">
        <div className="flex justify-between gap-2 flex-wrap">
          <div><b>{family.name}</b> <span className="text-sm text-gray-500">{family.noLogin ? 'no login of their own' : family.email}{family.phone ? ` · ${family.phone}` : ''}</span>
            {family.accountStatus === 'inactive' && <span className="badge bg-red-50 text-red-600 ml-2">Inactive</span>}</div>
          {poa && <span className="badge bg-primary-50 text-primary-600">Power of Attorney</span>}
        </div>
        <div className="flex gap-2 flex-wrap items-center mt-2">
          <input className="input" style={{ maxWidth: 220 }} placeholder="Relationship, e.g. Daughter" value={rel} onChange={e => setRel(e.target.value)} />
          <label className="text-sm flex items-center gap-1"><input type="checkbox" checked={poa} onChange={e => setPoa(e.target.checked)} /> Designated Power of Attorney</label>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => write(others.concat({ clientId: String(clientId), relationship: rel, isPoa: poa }), 'Saved.')}>Save</button>
          <button type="button" className="btn btn-danger" disabled={busy} onClick={() => { if (window.confirm(`Remove ${family.name}'s access to this client? Their own account stays.`)) write(others, 'Removed.'); }}>Remove Link</button>
        </div>
        <p className="text-xs text-gray-500 mt-1">Only tick Power of Attorney once the POA document is verified on file. A POA can act for the client in the portal.</p>
        <Msg msg={msg} />
      </div>
    );
  };

  const FamilySection = ({ token, client, users, me, onChanged, onAddNew }) => {
    const linked = familyFor(users, client.id);
    const others = users.filter(u => u.role === 'family' && !linked.some(x => x.id === u.id));
    const [pick, setPick] = useState(''); const [rel, setRel] = useState(''); const [poa, setPoa] = useState(false);
    const [busy, setBusy] = useState(false); const [msg, setMsg] = useState('');
    return (
      <div>
        {linked.length === 0 && <p className="text-sm text-gray-500 mb-2">No family or authorized contacts are linked yet.</p>}
        {linked.map(f => <FamilyLinkRow key={f.id} family={f} clientId={client.id} me={me} token={token} onChanged={onChanged} />)}
        {others.length > 0 && (
          <div className="flex gap-2 flex-wrap items-center mt-3">
            <select className="input" style={{ maxWidth: 260 }} value={pick} onChange={e => setPick(e.target.value)}>
              <option value="">Link an existing family account…</option>
              {others.map(u => <option key={u.id} value={u.id}>{u.name}{u.email && !u.noLogin ? ` (${u.email})` : ''}</option>)}
            </select>
            <input className="input" style={{ maxWidth: 180 }} placeholder="Relationship" value={rel} onChange={e => setRel(e.target.value)} />
            <label className="text-sm flex items-center gap-1"><input type="checkbox" checked={poa} onChange={e => setPoa(e.target.checked)} /> POA</label>
            <button type="button" className="btn btn-primary" disabled={busy || !pick} onClick={async () => {
              const f = users.find(u => u.id === pick); if (!f) return;
              setBusy(true); setMsg('');
              const r = await updateUser(f.id, { familyLinks: linksOf(f).concat({ clientId: String(client.id), relationship: rel, isPoa: poa }) });
              setBusy(false);
              if (r.error) setMsg(`Error: ${r.error}`); else { setPick(''); setRel(''); setPoa(false); setMsg('Linked.'); onChanged && onChanged(); }
            }}>Link</button>
          </div>
        )}
        <button type="button" className="btn btn-gold mt-3" onClick={() => onAddNew && onAddNew(client.id)}>+ Add a New Family Contact</button>
        <Msg msg={msg} />
      </div>
    );
  };

  // ── Creating accounts ──────────────────────────────────────────────────
  // What to do when the email already belongs to someone (User Management's
  // email-clash panel, carried over).
  const EmailClash = ({ clash, form, users, token, onOpenClient, onOpenFamily, onDone }) => {
    const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
    const [cutover, setCutover] = useState(false);
    const existing = users.find(u => u.id === clash.id);
    const picked = (form.familyLinks || []).filter(l => l.clientId);
    const addToFamily = async () => {
      if (!existing) return;
      setBusy(true);
      const have = linksOf(existing);
      const merged = have.concat(picked.filter(l => !have.some(h => h.clientId === String(l.clientId))));
      const r = await updateUser(existing.id, { familyLinks: merged });
      setBusy(false);
      if (r.error) { setErr(r.error); return; }
      onDone(`Added to ${existing.name}'s existing account. They sign in as before and choose whose portal to open.`);
    };
    return (
      <div className="p-4 rounded-lg bg-blue-50 border border-blue-200 text-sm space-y-3 mt-3">
        {clash.kind === 'family' && (
          <>
            <p><b>{clash.name || 'This person'}</b> already has a family login with this email. Nothing new was created.</p>
            <div className="flex flex-wrap gap-2">
              {form.role === 'family' && picked.length > 0 && (
                <button type="button" disabled={busy} onClick={addToFamily} className="btn btn-primary">
                  {busy ? 'Adding…' : `Add ${picked.length === 1 ? 'This Patient' : 'These Patients'} to Their Account`}
                </button>
              )}
              {existing && <button type="button" className="btn btn-ghost" onClick={() => onOpenFamily(existing.id)}>Open Their Account</button>}
            </div>
          </>
        )}
        {clash.kind === 'patient' && (
          <>
            <p>This email is the login on <b>{clash.name || 'a patient'}</b>'s own account. Nothing new was created. If {form.name || 'this person'} is their POA and has been signing in with it, move that login to them. They keep the same email and password.</p>
            <div className="flex flex-wrap gap-2">
              {existing && <button type="button" className="btn btn-primary" onClick={() => setCutover(true)}>Move the Login to {form.name || 'the POA'}</button>}
              {existing && <button type="button" className="btn btn-ghost" onClick={() => onOpenClient(existing.id)}>Open the Patient</button>}
            </div>
          </>
        )}
        {clash.kind === 'other' && <p>This email is already a staff login. Use a different email.</p>}
        {err && <p className="text-red-600">{err}</p>}
        {cutover && existing && <PoaCutoverDialog token={token} client={existing} users={users}
          initial={{ name: form.name || '', phone: form.phone || '', relationship: (picked[0] && picked[0].relationship) || '' }}
          onClose={() => setCutover(false)} onDone={() => { setCutover(false); onDone('The login now belongs to the POA.'); }} />}
      </div>
    );
  };

  // The quick client account: User Management's Add User, for a client.
  const AddClientForm = ({ token, users, portals, onCreated, onCancel, onOpenClient, onOpenFamily }) => {
    const [f, setF] = useState({ name: '', email: '', noEmail: false, phone: '', password: '', practiceName: '', existingPortalSlug: '', logo: '',
      rateAgreement: { hourlyRate: '', dailyMinimumHours: '' }, careTeam: Object.assign({}, EMPTY_TEAM), sendWelcomeEmail: true });
    const [busy, setBusy] = useState(false); const [err, setErr] = useState(''); const [clash, setClash] = useState(null);
    const set = (k, v) => setF(Object.assign({}, f, { [k]: v }));
    const photoRef = useRef(null);
    const submit = async () => {
      setBusy(true); setErr(''); setClash(null);
      const body = Object.assign({}, f, { role: 'client', accountType: 'client', enrollmentStatus: 'intake_pending' });
      const r = await req('/api/users', { method: 'POST', body, token });
      setBusy(false);
      if (r.error) { setErr(r.error); if (r.existingUser) setClash(r.existingUser); return; }
      onCreated(r.id || (r.user && r.user.id), r.message);
    };
    const portal = (portals || []).find(p => p.slug === f.existingPortalSlug);
    return (
      <div className="card p-6 mb-6">
        <h2 className="font-serif text-2xl text-primary-500 font-semibold mb-1">Add a Client</h2>
        <p className="text-sm text-gray-500 mb-4">Creates their portal login. Their intake, consents and documents then follow on their record. For a client who signed the paper packet, use Full Face Sheet instead.</p>
        <div className="grid md:grid-cols-2 gap-x-4">
          <Field label="Name *"><input className="input" value={f.name} onChange={e => set('name', e.target.value)} /></Field>
          <Field label={`Email${f.noEmail ? '' : ' *'}`}>
            <input className="input" type="email" autoComplete="off" disabled={f.noEmail} value={f.noEmail ? '' : f.email} onChange={e => set('email', e.target.value)} />
            <label className="flex items-start gap-2 mt-2 text-xs text-gray-600">
              <input type="checkbox" className="mt-0.5" checked={f.noEmail} onChange={e => setF(Object.assign({}, f, { noEmail: e.target.checked, email: '', password: '' }))} />
              <span>No email for this patient. Their POA or family member will sign in with their own account instead. No welcome email is sent.</span>
            </label>
          </Field>
          <Field label="Phone (optional)"><input className="input" type="tel" value={f.phone} onChange={e => set('phone', e.target.value)} placeholder="(555) 123-4567" /></Field>
          <Field label={`Password${f.noEmail ? '' : ' *'}`}><input className="input" type="password" autoComplete="new-password" disabled={f.noEmail} placeholder={f.noEmail ? 'Not needed' : ''} value={f.noEmail ? '' : f.password} onChange={e => set('password', e.target.value)} /></Field>
        </div>
        <div className="p-4 bg-amber-50 rounded-xl mb-3">
          <h4 className="font-semibold text-gray-800 mb-1">Agreed rate (private home care)</h4>
          <p className="text-xs text-gray-500 mb-3">Needed before this client can sign the Financial Agreement or the Service Agreement, which both print it. Skip it for a clinical-only patient, who signs neither.</p>
          <div className="grid grid-cols-2 gap-3 max-w-md">
            <Field label="Billed rate ($/hour)"><input className="input" type="number" min="0" step="0.01" placeholder="e.g. 32.00" value={f.rateAgreement.hourlyRate} onChange={e => set('rateAgreement', Object.assign({}, f.rateAgreement, { hourlyRate: e.target.value }))} /></Field>
            <Field label="Daily minimum (hours)"><input className="input" type="number" min="0" step="0.5" placeholder="e.g. 4" value={f.rateAgreement.dailyMinimumHours} onChange={e => set('rateAgreement', Object.assign({}, f.rateAgreement, { dailyMinimumHours: e.target.value }))} /></Field>
          </div>
        </div>
        {(portals || []).length > 0 && (
          <Field label="Add to an existing portal">
            <select className="input" value={f.existingPortalSlug} onChange={e => {
              const p = (portals || []).find(x => x.slug === e.target.value);
              setF(Object.assign({}, f, p ? { existingPortalSlug: p.slug, practiceName: p.practiceName, logo: p.logo || f.logo, hubspotCompanyId: p.hubspotCompanyId || f.hubspotCompanyId } : { existingPortalSlug: '', practiceName: '' }));
            }}>
              <option value="">Create a new portal</option>
              {portals.map(p => <option key={p.slug} value={p.slug}>{p.practiceName} ({p.memberCount} {p.memberCount === 1 ? 'user' : 'users'})</option>)}
            </select>
            {portal && <p className="text-xs text-gray-500 mt-1">Adding to {window.location.origin}/portal/{portal.slug}. Current members: {(portal.members || []).map(m => m.name).join(', ')}</p>}
          </Field>
        )}
        <Field label={`Name on their portal${f.existingPortalSlug ? '' : ' *'}`} hint={f.existingPortalSlug ? 'Inherited from the existing portal.' : 'This sets their portal address.'}>
          <input className="input" value={f.practiceName} disabled={!!f.existingPortalSlug} onChange={e => set('practiceName', e.target.value)} />
        </Field>
        <Field label="Client Photo" hint="A headshot helps caregivers recognise who they are visiting. Max 2 MB, PNG or JPEG.">
          <div className="flex items-center gap-3">
            {f.logo && <img src={f.logo} alt="" className="h-16 w-16 object-cover border rounded-full" />}
            <input type="file" ref={photoRef} accept="image/png,image/jpeg" className="hidden" onChange={async e => { try { const d = await readPhoto(e.target.files[0]); if (d) set('logo', d); } catch (x) { setErr(x.message); } }} />
            <button type="button" className="btn btn-ghost" onClick={() => photoRef.current && photoRef.current.click()}>Upload Photo</button>
            {f.logo && <button type="button" className="btn btn-danger" onClick={() => set('logo', '')}>Remove</button>}
          </div>
        </Field>
        <h4 className="font-semibold text-gray-800 mt-2 mb-2">Care Team</h4>
        <CareTeamFields team={f.careTeam} setTeam={(t) => set('careTeam', t)} users={users} />
        {!f.noEmail && (
          <label className="flex items-start gap-2 p-3 bg-blue-50 border border-blue-200 rounded-lg text-sm text-blue-800">
            <input type="checkbox" className="mt-0.5" checked={f.sendWelcomeEmail} onChange={e => set('sendWelcomeEmail', e.target.checked)} />
            <span><b>Send welcome email</b>: email them their username and temporary password with a sign-in link.</span>
          </label>
        )}
        {err && <p className="text-sm text-red-600 mt-3">{err}</p>}
        {clash && <EmailClash clash={clash} form={Object.assign({ role: 'client' }, f)} users={users} token={token} onOpenClient={onOpenClient} onOpenFamily={onOpenFamily} onDone={(m) => onCreated(null, m)} />}
        <div className="flex gap-2 mt-4">
          <button type="button" className="btn btn-primary" disabled={busy || !f.name.trim() || (!f.noEmail && (!f.email.trim() || !f.password)) || (!f.existingPortalSlug && !f.practiceName.trim())} onClick={submit}>{busy ? 'Creating…' : 'Create Client'}</button>
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={onCancel}>Cancel</button>
        </div>
      </div>
    );
  };

  // A family or authorized contact: User Management's Add User, for family.
  const LinksEditor = ({ links, setLinks, clients }) => (
    <div>
      {links.map((l, i) => (
        <div key={i} className="border rounded-lg p-3 mb-2">
          <div className="grid md:grid-cols-2 gap-x-3">
            <Field label="Linked patient">
              <select className="input" value={l.clientId} onChange={e => setLinks(links.map((x, j) => (j === i ? Object.assign({}, x, { clientId: e.target.value }) : x)))}>
                <option value="">Choose a patient…</option>
                {clients.filter(c => c.id === l.clientId || !links.some(x => x.clientId === c.id)).map(c => <option key={c.id} value={c.id}>{c.name || c.practiceName || c.email}</option>)}
              </select>
            </Field>
            <Field label="Relationship"><input className="input" placeholder="e.g. Daughter" value={l.relationship} onChange={e => setLinks(links.map((x, j) => (j === i ? Object.assign({}, x, { relationship: e.target.value }) : x)))} /></Field>
          </div>
          <div className="flex justify-between items-center flex-wrap gap-2">
            <label className="text-sm flex items-center gap-1"><input type="checkbox" checked={!!l.isPoa} onChange={e => setLinks(links.map((x, j) => (j === i ? Object.assign({}, x, { isPoa: e.target.checked }) : x)))} /> Designated Power of Attorney for this patient</label>
            <button type="button" className="btn btn-danger" onClick={() => setLinks(links.filter((x, j) => j !== i))}>Remove</button>
          </div>
        </div>
      ))}
      {clients.length === 0 && <p className="text-sm text-amber-700">There are no patients to link yet. Add the client first.</p>}
      {links.length === 0 && clients.length > 0 && <p className="text-sm text-amber-700">Not linked to a patient yet. They will see nothing until they are.</p>}
      <button type="button" className="btn btn-ghost" onClick={() => setLinks(links.concat({ clientId: '', relationship: '', isPoa: false }))}>+ Add a Patient</button>
      <p className="text-xs text-gray-500 mt-1">Only tick Power of Attorney once the POA document is verified on file. One login can cover several patients.</p>
    </div>
  );

  const AddFamilyForm = ({ token, users, presetClientId, onCreated, onCancel, onOpenClient, onOpenFamily }) => {
    const clients = users.filter(u => u.role === 'client');
    const [f, setF] = useState({ name: '', email: '', phone: '', password: '', sendWelcomeEmail: true,
      familyLinks: presetClientId ? [{ clientId: String(presetClientId), relationship: '', isPoa: false }] : [] });
    const [busy, setBusy] = useState(false); const [err, setErr] = useState(''); const [clash, setClash] = useState(null);
    const set = (k, v) => setF(Object.assign({}, f, { [k]: v }));
    const submit = async () => {
      setBusy(true); setErr(''); setClash(null);
      const body = Object.assign({}, f, { role: 'family', accountType: 'family', familyLinks: f.familyLinks.filter(l => l.clientId) });
      const r = await req('/api/users', { method: 'POST', body, token });
      setBusy(false);
      if (r.error) { setErr(r.error); if (r.existingUser) setClash(r.existingUser); return; }
      onCreated(r.id || (r.user && r.user.id), r.message);
    };
    return (
      <div className="card p-6 mb-6">
        <h2 className="font-serif text-2xl text-primary-500 font-semibold mb-1">Add a Family Contact</h2>
        <p className="text-sm text-gray-500 mb-4">A family member or authorized contact with their own login, linked to the patients they may see.</p>
        <div className="grid md:grid-cols-2 gap-x-4">
          <Field label="Name *"><input className="input" value={f.name} onChange={e => set('name', e.target.value)} /></Field>
          <Field label="Email *"><input className="input" type="email" autoComplete="off" value={f.email} onChange={e => set('email', e.target.value)} /></Field>
          <Field label="Phone (optional)"><input className="input" type="tel" value={f.phone} onChange={e => set('phone', e.target.value)} /></Field>
          <Field label="Password *"><input className="input" type="password" autoComplete="new-password" value={f.password} onChange={e => set('password', e.target.value)} /></Field>
        </div>
        <h4 className="font-semibold text-gray-800 mb-2">Patients They Can See</h4>
        <LinksEditor links={f.familyLinks} setLinks={(l) => set('familyLinks', l)} clients={clients} />
        <label className="flex items-start gap-2 p-3 bg-blue-50 border border-blue-200 rounded-lg text-sm text-blue-800 mt-3">
          <input type="checkbox" className="mt-0.5" checked={f.sendWelcomeEmail} onChange={e => set('sendWelcomeEmail', e.target.checked)} />
          <span><b>Send welcome email</b>: email them their username and temporary password with a sign-in link.</span>
        </label>
        {err && <p className="text-sm text-red-600 mt-3">{err}</p>}
        {clash && <EmailClash clash={clash} form={Object.assign({ role: 'family' }, f)} users={users} token={token} onOpenClient={onOpenClient} onOpenFamily={onOpenFamily} onDone={(m) => onCreated(null, m)} />}
        <div className="flex gap-2 mt-4">
          <button type="button" className="btn btn-primary" disabled={busy || !f.name.trim() || !f.email.trim() || !f.password} onClick={submit}>{busy ? 'Creating…' : 'Create Family Contact'}</button>
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={onCancel}>Cancel</button>
        </div>
      </div>
    );
  };

  // A family account on its own: name, contact, links, status and recovery.
  const FamilyEditor = ({ token, family, users, me, onChanged, onClose, onDeleted }) => {
    const clients = users.filter(u => u.role === 'client');
    const [basic, setBasic] = useState({ name: family.name || '', email: family.email || '', phone: family.phone || '' });
    const [links, setLinks] = useState(linksOf(family));
    const [busy, setBusy] = useState(false); const [msg, setMsg] = useState('');
    const save = async (body, ok) => {
      setBusy(true); setMsg(''); const r = await updateUser(family.id, body); setBusy(false);
      if (r.error) { setMsg(`Error: ${r.error}`); return; }
      setMsg(r.message || ok); onChanged && onChanged();
    };
    const active = family.accountStatus !== 'inactive';
    return (
      <div className="card p-6 mb-6">
        <div className="flex justify-between gap-2 flex-wrap">
          <h2 className="font-serif text-2xl text-primary-500 font-semibold">{family.name}</h2>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Close</button>
        </div>
        <Block title="Name and Contact">
          <div className="grid md:grid-cols-3 gap-x-4">
            <Field label="Name"><input className="input" value={basic.name} onChange={e => setBasic({ ...basic, name: e.target.value })} /></Field>
            <Field label="Email">{family.noLogin ? <p className="text-sm text-gray-500 py-2">No login of their own (placeholder).</p> : <input className="input" type="email" value={basic.email} onChange={e => setBasic({ ...basic, email: e.target.value })} />}</Field>
            <Field label="Phone"><input className="input" type="tel" value={basic.phone} onChange={e => setBasic({ ...basic, phone: e.target.value })} /></Field>
          </div>
          <button type="button" className="btn btn-primary" disabled={busy || !basic.name.trim()} onClick={() => save(family.noLogin ? { name: basic.name, phone: basic.phone } : basic, 'Saved.')}>Save</button>
        </Block>
        <Block title="Patients They Can See">
          <LinksEditor links={links} setLinks={setLinks} clients={clients} />
          <button type="button" className="btn btn-primary mt-2" disabled={busy} onClick={() => save({ familyLinks: links.filter(l => l.clientId) }, 'Links saved.')}>Save Links</button>
        </Block>
        <Block title="Status and Email">
          <div className="flex flex-wrap gap-2 items-center">
            <span className={`badge ${active ? 'bg-success-50 text-success-600' : 'bg-red-50 text-red-600'}`}>{active ? 'Active' : 'Inactive'}</span>
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => { if (window.confirm(`${active ? 'Deactivate' : 'Reactivate'} ${family.name}'s account?`)) save({ accountStatus: active ? 'inactive' : 'active' }, active ? 'Account deactivated.' : 'Account reactivated.'); }}>{active ? 'Deactivate' : 'Reactivate'}</button>
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => save({ emailUnsubscribed: !family.emailUnsubscribed }, family.emailUnsubscribed ? 'Resubscribed.' : 'Unsubscribed.')}>{family.emailUnsubscribed ? 'Resubscribe to Emails' : 'Unsubscribe from Emails'}</button>
          </div>
        </Block>
        <AccountRecovery token={token} person={family} me={me} onChanged={onChanged} />
        {isSuperAdmin(me) && (
          <Block title="Delete Contact">
            <button type="button" className="btn btn-danger" disabled={busy} onClick={async () => {
              if (!window.confirm(`Delete ${family.name}'s account? This cannot be undone.`)) return;
              const r = await req(`/api/users/${encodeURIComponent(family.id)}`, { method: 'DELETE', token });
              if (r.error) setMsg(`Error: ${r.error}`); else onDeleted && onDeleted();
            }}>Delete Contact</button>
          </Block>
        )}
        <Msg msg={msg} />
      </div>
    );
  };

  // Every family account, with whom they can see.
  const FamilyList = ({ users, onEdit, onOpenClient }) => {
    const [q, setQ] = useState('');
    const fam = users.filter(u => u.role === 'family' && (!q || `${u.name} ${u.email}`.toLowerCase().includes(q.toLowerCase())));
    const nameOf = (id) => (users.find(u => String(u.id) === String(id)) || {}).name || 'Unknown patient';
    return (
      <div>
        <input className="input mb-3" style={{ maxWidth: 360 }} placeholder="Search family contacts" value={q} onChange={e => setQ(e.target.value)} />
        <div className="card overflow-hidden"><div className="overflow-x-auto">
          <table className="list w-full">
            <thead><tr><th>Contact</th><th>Patients</th><th>Status</th><th>Created</th></tr></thead>
            <tbody>
              {fam.length === 0 && <tr><td colSpan="4" className="text-center text-gray-400 py-10">No family contacts.</td></tr>}
              {fam.map(u => (
                <tr key={u.id} onClick={() => onEdit(u.id)}>
                  <td><div className="font-medium text-primary-500">{u.name}</div><div className="text-xs text-gray-500">{u.noLogin ? 'no login of their own' : u.email}</div></td>
                  <td>{linksOf(u).length === 0 ? <span className="text-amber-700 text-sm">Not linked</span>
                    : linksOf(u).map(l => <div key={l.clientId}><a href="#" onClick={e => { e.preventDefault(); e.stopPropagation(); onOpenClient(l.clientId); }}>{nameOf(l.clientId)}</a>{l.relationship ? ` · ${l.relationship}` : ''}{l.isPoa ? ' · POA' : ''}</div>)}</td>
                  <td><span className={`badge ${u.accountStatus === 'inactive' ? 'bg-red-50 text-red-600' : 'bg-success-50 text-success-600'}`}>{u.accountStatus === 'inactive' ? 'Inactive' : 'Active'}</span>
                    {u.emailUnsubscribed && <span className="badge bg-orange-50 text-orange-600 ml-1">Unsubscribed</span>}</td>
                  <td>{u.createdAt ? new Date(u.createdAt).toLocaleDateString() : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div></div>
      </div>
    );
  };

  // Password reset requests from client and family accounts.
  const ResetRequests = ({ token, users }) => {
    const [rows, setRows] = useState(null); const [msg, setMsg] = useState('');
    const load = () => req('/api/admin/password-reset-requests', { token }).then(r => setRows(Array.isArray(r) ? r : (r.requests || [])));
    useEffect(() => { load(); }, [token]);
    const mine = (rows || []).filter(r => { const u = users.find(x => x.id === r.userId); return u && ['client', 'family'].includes(u.role); });
    const reset = async (r) => {
      const pw = window.prompt('Enter a new password for this person:'); if (!pw) return;
      const x = await updateUser(r.userId, { password: pw, resetPassword: true });
      if (x.error) { setMsg(`Error: ${x.error}`); return; }
      await req(`/api/admin/password-reset-requests/${encodeURIComponent(r.id)}`, { method: 'DELETE', token });
      setMsg('Password reset.'); load();
    };
    return (
      <div className="card p-6">
        {rows === null && <p className="text-gray-400">Loading…</p>}
        {rows && mine.length === 0 && <p className="text-gray-500 text-center py-6">No password reset requests from clients or family.</p>}
        {mine.map(r => { const u = users.find(x => x.id === r.userId) || {}; return (
          <div key={r.id} className="flex justify-between items-center p-4 bg-yellow-50 border border-yellow-200 rounded-lg mb-2 gap-2 flex-wrap">
            <div><p className="font-medium">{u.name}</p><p className="text-sm text-gray-500">{u.email}</p><p className="text-xs text-gray-400">Requested: {new Date(r.requestedAt).toLocaleString()}</p></div>
            <div className="flex gap-2">
              <button type="button" className="btn btn-primary" onClick={() => reset(r)}>Reset Password</button>
              <button type="button" className="btn btn-ghost" onClick={async () => { await req(`/api/admin/password-reset-requests/${encodeURIComponent(r.id)}`, { method: 'DELETE', token }); load(); }}>Dismiss</button>
            </div>
          </div>
        ); })}
        <Msg msg={msg} />
      </div>
    );
  };

  // Export clients and family to a spreadsheet: User Management's columns.
  function exportClients(users) {
    if (!window.XLSX) { window.alert('The spreadsheet tool did not load. Refresh and try again.'); return; }
    const nameOf = (id) => (users.find(u => String(u.id) === String(id)) || {}).name || '';
    const rows = users.filter(u => ['client', 'family'].includes(u.role)).map(u => ({
      Name: u.name || '', Email: u.noLogin ? '' : (u.email || ''), 'Account Type': u.role === 'client' ? 'Client' : 'Family',
      Status: u.accountStatus === 'inactive' ? 'Inactive' : 'Active', Phone: u.phone || '',
      'Portal Name': u.practiceName || '', 'Enrollment Status': u.role === 'client' ? (u.enrollmentStatus || '') : '',
      'Linked Patients': u.role === 'family' ? linksOf(u).map(l => `${nameOf(l.clientId)}${l.isPoa ? ' (POA)' : ''}`).join('; ') : '',
      'Created At': u.createdAt ? new Date(u.createdAt).toLocaleDateString() : '', 'User ID': u.id
    }));
    const ws = window.XLSX.utils.json_to_sheet(rows); const wb = window.XLSX.utils.book_new();
    window.XLSX.utils.book_append_sheet(wb, ws, 'Clients');
    window.XLSX.writeFile(wb, `gfc-clients-${new Date().toISOString().slice(0, 10)}.xlsx`);
  }

  async function bulkResetClients(token) {
    if (!window.confirm('Reset passwords for all CLIENT users? They will be required to change their password at their next sign-in.')) return null;
    return req('/api/admin/bulk-password-reset', { method: 'POST', body: { userType: 'clients' }, token });
  }

  window.GFCClientAccount = {
    req, isOffice, isSuperAdmin, startViewAs, linksOf, familyFor,
    PoaCutoverDialog, FinancialChangeQueue, PossiblePoaLogins, fmtFinancial,
    ClientAccountSection, CareTeamSection, FamilySection, FamilyEditor, FamilyList,
    AddClientForm, AddFamilyForm, ResetRequests, exportClients, bulkResetClients
  };
})();
