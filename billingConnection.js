'use strict';
// ── Is billing connected to OpenEMR? (owner, 2026-11-04) ──
//
// The billing page opens with this answer. A claim travels: signed note in
// the app → Submit to billing posts the charge lines to OpenEMR's Fee Sheet →
// Release here records that a person checked them → OpenEMR's Billing Manager
// generates the 837 and sends it to the clearinghouse. Every link in that
// chain the app can observe is one check below, named, with what fixes it.
//
// PURE. The route gathers the facts; this only judges them, so the rules are
// testable without a server.
//
// Three states, never two:
//   ok       — read, and it is right
//   blocked  — read, and it is wrong; claims will be refused or come back
//   unknown  — could not be read. NEVER reported as ok: a check that could not
//              run is not a pass (the same rule the claim scrub follows).
// And one more for the link the app cannot see:
//   outside  — happens in OpenEMR, not here. Stated, never claimed.

const STATES = Object.freeze({ OK: 'ok', BLOCKED: 'blocked', UNKNOWN: 'unknown', OUTSIDE: 'outside' });

const present = (v) => v !== undefined && v !== null && String(v).trim() !== '';

const check = (key, label, state, detail, fix) => ({ key, label, state, detail: detail || '', fix: fix || null });

const buildBillingConnection = ({ emr, payer, facilityInfo, catalog, ncci } = {}) => {
  const out = [];
  const e = emr || {};

  // 1. This person's own OpenEMR sign-in. Charges post under the login of the
  //    person pressing Submit (per-user OAuth, Session 5.2): there is no
  //    shared account to fall back on.
  if (e.configured === false) {
    out.push(check('emr_signin', 'Your OpenEMR sign-in', STATES.BLOCKED,
      `OpenEMR is not configured on the server${(e.missing || []).length ? ` (missing ${e.missing.join(', ')})` : ''}.`,
      'An admin adds the OpenEMR settings and restarts the app.'));
  } else if (e.reachable === false) {
    out.push(check('emr_signin', 'Your OpenEMR sign-in', STATES.UNKNOWN,
      `OpenEMR did not answer${e.error ? ` (${e.error})` : ''}.`, 'Check that OpenEMR is up, then check again.'));
  } else if (!e.connected) {
    out.push(check('emr_signin', 'Your OpenEMR sign-in', STATES.BLOCKED,
      e.disconnectReason ? 'Your OpenEMR sign-in has lapsed.' : 'You are not signed in to OpenEMR, so nothing can post under your name.',
      'Sign in to OpenEMR.'));
  } else {
    out.push(check('emr_signin', 'Your OpenEMR sign-in', STATES.OK,
      `Signed in${e.emrUser && e.emrUser.username ? ` as ${e.emrUser.username}` : ''}. Charges you submit post under that login.`));
  }

  // 2. The billing routes on that sign-in. A narrowed token is how a stale
  //    OAuth client hid behind a green "connected" for weeks (Session 4.5).
  if (e.connected) {
    if (e.billingRouteScopes === false) {
      out.push(check('emr_scopes', 'Billing access in OpenEMR', STATES.BLOCKED,
        `Your OpenEMR token is missing the billing scopes${(e.missingScopes || []).length ? ` (${e.missingScopes.slice(0, 6).join(', ')})` : ''}, so posting a charge will fail.`,
        'An admin checks the OpenEMR client is the v4 client, then you sign in again.'));
    } else if (e.billingRouteScopes === true) {
      out.push(check('emr_scopes', 'Billing access in OpenEMR', STATES.OK, 'Your token can post charges, read them back and void them.'));
    } else {
      out.push(check('emr_scopes', 'Billing access in OpenEMR', STATES.UNKNOWN, 'OpenEMR did not say which scopes your token holds.', 'Sign in to OpenEMR again.'));
    }
  }

  // 3. The billing provider NPI (spec §2.5). Never a literal in the code.
  const p = payer || {};
  out.push(present(p.billing_npi_used)
    ? check('billing_npi', 'Billing provider NPI', STATES.OK, `${p.billing_npi_used}${p.billing_provider_name ? ` · ${p.billing_provider_name}` : ''}`)
    : check('billing_npi', 'Billing provider NPI', STATES.BLOCKED, 'Not set. No visit can be submitted without it.', 'An admin sets it under Settings on this page.'));

  // 4. The billing facility as OpenEMR holds it. This record, not the app,
  //    prints on the claim's billing-provider loop.
  const f = facilityInfo || {};
  if (!f.facilityListKnown) {
    out.push(check('billing_facility', 'Billing facility in OpenEMR', STATES.UNKNOWN,
      'OpenEMR\'s facility list has never been read, so the billing facility is unchecked.', 'Press Sync Facilities.'));
  } else if (!f.billingFacility || !f.billingFacility.id) {
    out.push(check('billing_facility', 'Billing facility in OpenEMR', STATES.BLOCKED,
      (f.billingFacility && f.billingFacility.error) || 'No billing facility is configured or flagged in OpenEMR.',
      'Mark the billing entity as the primary business entity in OpenEMR, then Sync Facilities.'));
  } else {
    const bf = f.billingFacility;
    const name = `${bf.name || `Facility ${bf.id}`}`;
    if (!bf.fieldsRead) {
      out.push(check('billing_facility', 'Billing facility in OpenEMR', STATES.UNKNOWN,
        `${name}: the saved facility list predates the NPI, EIN and taxonomy fields, so they are unchecked.`, 'Press Sync Facilities.'));
    } else {
      const missing = [['npi', 'NPI'], ['ein', 'federal EIN'], ['taxonomy', 'taxonomy']].filter(([k]) => !present(bf[k])).map(([, l]) => l);
      out.push(missing.length
        ? check('billing_facility', 'Billing facility in OpenEMR', STATES.BLOCKED,
            `${name} has no ${missing.join(', ')} in OpenEMR. Every claim would be refused at the scrub.`,
            `Fill in the ${missing.join(', ')} on ${name} in OpenEMR (Administration → Facilities), then Sync Facilities.`)
        : check('billing_facility', 'Billing facility in OpenEMR', STATES.OK, `${name} · NPI ${bf.npi} · EIN on file · taxonomy ${bf.taxonomy}`));
    }
  }

  // 5. OpenEMR's code catalog, which every service code is checked against.
  const c = catalog || null;
  if (!c) out.push(check('code_catalog', 'Code list from OpenEMR', STATES.UNKNOWN, 'The cached code list could not be read.'));
  else if (!c.loaded) out.push(check('code_catalog', 'Code list from OpenEMR', STATES.BLOCKED, 'The code list has never been read from OpenEMR, so no service code can be checked.', 'An admin refreshes the code catalog.'));
  else if (c.stale) out.push(check('code_catalog', 'Code list from OpenEMR', STATES.UNKNOWN, `Last read ${c.fetchedAt ? String(c.fetchedAt).slice(0, 10) : 'a while ago'}; it may be out of date.`, 'An admin refreshes the code catalog.'));
  else out.push(check('code_catalog', 'Code list from OpenEMR', STATES.OK, `Read ${c.fetchedAt ? String(c.fetchedAt).slice(0, 10) : ''}.`.trim()));

  // 6. The NCCI tables the bundling edits read.
  const n = (ncci && ncci.ncciSourceVersion) || null;
  if (!n) out.push(check('ncci', 'NCCI edit tables', STATES.UNKNOWN, 'The NCCI tables could not be read.'));
  else {
    const unloaded = ['ptp', 'mue'].filter(k => !n[k] || n[k].quarter === 'UNLOADED').map(k => k.toUpperCase());
    out.push(unloaded.length
      ? check('ncci', 'NCCI edit tables', STATES.BLOCKED, `${unloaded.join(' and ')} not loaded, so bundling edits cannot be checked.`, 'An admin loads this quarter\'s NCCI tables.')
      : check('ncci', 'NCCI edit tables', STATES.OK, `PTP ${n.ptp.quarter} · MUE ${n.mue.quarter}`));
  }

  // 7. The clearinghouse. It is wired to OpenEMR's Billing Manager, not to
  //    this app, and nothing here can see it. Said plainly, never claimed.
  out.push(check('clearinghouse', 'Clearinghouse', STATES.OUTSIDE,
    'Claims go to the clearinghouse from OpenEMR\'s Billing Manager, which this app cannot see. Generate claims there only for visits released here.',
    'Set up the clearinghouse (Availity) in OpenEMR\'s X12 partners, then generate claims from Billing Manager.'));

  const blocked = out.filter(x => x.state === STATES.BLOCKED).length;
  const unknown = out.filter(x => x.state === STATES.UNKNOWN).length;
  return { checks: out, ready: blocked === 0 && unknown === 0, blocked, unknown };
};

module.exports = { STATES, buildBillingConnection };
