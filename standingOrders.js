// standingOrders.js — Session 4.8, Scope C
//
// A standing order is a CLINICAL DOCUMENT, not a permission flag. It is
// modelled on the care plan, which is already versioned: a provider authors
// and signs a protocol, it expires, it can be revised, and every order
// executed under it references the version it was executed under FOREVER.
//
// A standing order's whole defensibility is the ability to reconstruct who
// acted under whose authority, under which version, on what date. Everything
// here exists to make that reconstruction possible from the stored record
// rather than from somebody's recollection.
//
// The rules are enforced SERVER-SIDE, not in the UI. The endpoint refuses a
// test that is not on the protocol's list even when the UI would have
// prevented it — a form is styling; the refusal is the control.

const roles = require('./clinicalRoles');

const STATUSES = Object.freeze(['draft', 'active', 'expired', 'retired']);
const EXECUTABLE_STATUS = 'active';
// Who may be named as an executor. `provider` is deliberately NOT here: a
// provider places orders on their own authority and needs no protocol.
const EXECUTOR_ROLES = Object.freeze([
  roles.CLINICAL_ROLES.RN, roles.CLINICAL_ROLES.LCSW, roles.CLINICAL_ROLES.LMSW
]);
const PATIENT_SCOPES = Object.freeze(['panel', 'named']);

const clean = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const uniqStrings = (list, max, cap) => Array.from(new Set(
  (Array.isArray(list) ? list : []).map(v => clean(v, max)).filter(Boolean)
)).slice(0, cap);
const isIsoDate = (v) => {
  if (typeof v !== 'string' || !v.trim()) return false;
  const d = new Date(v);
  return !Number.isNaN(d.getTime());
};
const normalizeIcd10 = (raw) => {
  let s = String(raw || '').trim().toUpperCase().replace(/\s+/g, '');
  if (!s) return null;
  if (/^[A-Z][0-9][0-9A-Z][0-9A-Z]{1,4}$/.test(s)) s = `${s.slice(0, 3)}.${s.slice(3)}`;
  return /^[A-Z][0-9][0-9A-Z](\.[0-9A-Z]{1,4})?$/.test(s) ? s : null;
};

// ---- Authoring / revising ------------------------------------------------
// RULE 1: only a `provider` may author, sign or revise. The caller checks the
// capability; this refuses again rather than trusting it, because a second
// route added later would otherwise be the hole.
// RULE 5: expiresAt is REQUIRED. A protocol with no expiry is a permission
//         flag wearing a document's clothes.
// RULE 6: permittedExecutorRoles is required and cannot be empty. The
//         authoring provider names which credentials may act on this protocol.
const buildStandingOrder = ({ id, input, author, at, existing }) => {
  const i = input || {};
  if (!roles.can(author, roles.CAPABILITIES.AUTHOR_STANDING_ORDER)) {
    return { error: roles.CAPABILITY_REASONS.authorStandingOrder, code: 'STANDING_ORDER_NOT_PROVIDER' };
  }
  const title = clean(i.title, 200);
  if (!title) return { error: 'A title is required', code: 'STANDING_ORDER_NO_TITLE' };

  const permittedOrderTypes = uniqStrings(i.permittedOrderTypes, 20, 4)
    .filter(t => roles.STANDING_ORDER_TYPES.includes(t));
  if (!permittedOrderTypes.length) {
    return { error: `permittedOrderTypes must name at least one of ${roles.STANDING_ORDER_TYPES.join(', ')}`, code: 'STANDING_ORDER_NO_TYPES' };
  }
  // Explicit list — no free text at execution.
  const permittedTests = uniqStrings(i.permittedTests, 200, 60);
  if (!permittedTests.length) {
    return { error: 'permittedTests must list the tests this protocol authorises — a protocol with no list authorises nothing', code: 'STANDING_ORDER_NO_TESTS' };
  }
  const permittedExecutorRoles = uniqStrings(i.permittedExecutorRoles, 20, 3)
    .filter(r => EXECUTOR_ROLES.includes(r));
  if (!permittedExecutorRoles.length) {
    return { error: `permittedExecutorRoles is required and must name at least one of ${EXECUTOR_ROLES.join(', ')}`, code: 'STANDING_ORDER_NO_EXECUTORS' };
  }
  const indications = Array.from(new Set(
    (Array.isArray(i.indications) ? i.indications : []).map(normalizeIcd10).filter(Boolean)
  )).slice(0, 40);
  if (!indications.length) {
    return { error: 'At least one ICD-10 indication is required — an order executed under this protocol must link to one', code: 'STANDING_ORDER_NO_INDICATIONS' };
  }
  const patientScope = PATIENT_SCOPES.includes(i.patientScope) ? i.patientScope : 'panel';
  const namedClientIds = patientScope === 'named' ? uniqStrings(i.namedClientIds, 80, 200) : [];
  if (patientScope === 'named' && !namedClientIds.length) {
    return { error: 'A named-scope standing order must name at least one client', code: 'STANDING_ORDER_NO_CLIENTS' };
  }
  if (!isIsoDate(i.expiresAt)) {
    return { error: 'expiresAt is required — a standing order with no expiry is refused. Annual review is the norm.', code: 'STANDING_ORDER_NO_EXPIRY' };
  }
  const now = at || new Date().toISOString();
  const effectiveAt = isIsoDate(i.effectiveAt) ? new Date(i.effectiveAt).toISOString() : now;
  const expiresAt = new Date(i.expiresAt).toISOString();
  if (expiresAt <= effectiveAt) {
    return { error: 'expiresAt must be after effectiveAt', code: 'STANDING_ORDER_BAD_DATES' };
  }
  // A signature makes it a signed document. Unsigned it stays a draft and
  // cannot be executed (rule 2).
  const signatureImage = typeof i.signatureImage === 'string' && /^data:image\/png;base64,/.test(i.signatureImage)
    ? i.signatureImage : null;
  if (signatureImage && signatureImage.length > 600 * 1024) {
    return { error: 'Signature image is too large', code: 'STANDING_ORDER_SIGNATURE_TOO_LARGE' };
  }
  const requestedStatus = STATUSES.includes(i.status) ? i.status : 'draft';
  if (requestedStatus === EXECUTABLE_STATUS && !signatureImage) {
    return { error: 'A standing order cannot be activated without the authorizing provider\'s signature', code: 'STANDING_ORDER_UNSIGNED' };
  }
  if (['expired', 'retired'].includes(requestedStatus)) {
    return { error: 'A standing order is authored as a draft or activated; expiry and retirement happen afterwards', code: 'STANDING_ORDER_BAD_STATUS' };
  }

  // VERSIONS ARE IMMUTABLE (rule 3). A revision is a NEW row at version n+1
  // pointing back at the row it supersedes; the old row is never rewritten.
  const version = existing && Number.isInteger(existing.version) ? existing.version + 1 : 1;

  const coSignWithinDaysRaw = parseInt(i.coSignWithinDays, 10);
  const requiresCoSign = !!i.requiresCoSign;

  return {
    standingOrder: {
      id,
      // The protocol's stable identity across versions. v1 is its own lineage
      // root, so a lineage can always be listed without a special case.
      lineageId: (existing && (existing.lineageId || existing.id)) || id,
      title,
      authorizingProvider: {
        userId: (author && author.id) || null,
        name: (author && author.name) || null,
        npi: (author && author.npi) || null,
        credential: (author && author.licenseLevel) || null
      },
      version,
      supersedesVersionId: (existing && existing.id) || null,
      status: requestedStatus,
      permittedOrderTypes,
      permittedTests,
      permittedExecutorRoles,
      indications,
      patientScope,
      namedClientIds,
      requiresCoSign,
      coSignWithinDays: requiresCoSign && Number.isInteger(coSignWithinDaysRaw) && coSignWithinDaysRaw > 0
        ? Math.min(coSignWithinDaysRaw, 90) : null,
      effectiveAt,
      expiresAt,
      signedAt: signatureImage ? now : null,
      signatureImage,
      notes: clean(i.notes, 2000) || null,
      createdAt: now,
      createdBy: { userId: (author && author.id) || null, name: (author && author.name) || null },
      updatedAt: now
    },
    // A revision supersedes its predecessor. The caller retires the old row;
    // it is returned here so the two cannot drift apart.
    supersededId: (existing && existing.id) || null
  };
};

// Status changes that do not rewrite the document: activate a signed draft,
// retire a protocol that is no longer in use. Expiry is derived, never typed.
const setStandingOrderStatus = (order, next, actor, at) => {
  if (!order) return { error: 'Standing order not found', code: 'STANDING_ORDER_NOT_FOUND' };
  if (!roles.can(actor, roles.CAPABILITIES.AUTHOR_STANDING_ORDER)) {
    return { error: roles.CAPABILITY_REASONS.authorStandingOrder, code: 'STANDING_ORDER_NOT_PROVIDER' };
  }
  if (!['active', 'retired'].includes(next)) {
    return { error: 'A standing order may be activated or retired', code: 'STANDING_ORDER_BAD_STATUS' };
  }
  if (next === 'active') {
    if (!order.signatureImage || !order.signedAt) {
      return { error: 'A standing order cannot be activated without the authorizing provider\'s signature', code: 'STANDING_ORDER_UNSIGNED' };
    }
    if (isExpired(order, at)) return { error: 'This standing order has expired — revise it instead', code: 'STANDING_ORDER_EXPIRED' };
  }
  const now = at || new Date().toISOString();
  return {
    standingOrder: {
      ...order, status: next, updatedAt: now,
      statusHistory: [...(order.statusHistory || []), { status: next, at: now, by: { userId: (actor && actor.id) || null, name: (actor && actor.name) || null } }]
    }
  };
};

const isExpired = (order, at) => {
  if (!order || !order.expiresAt) return true;
  return new Date(order.expiresAt).getTime() <= new Date(at || Date.now()).getTime();
};
// Status is derived for display so an expired protocol reads as expired the
// moment it lapses, without a sweep job having to have run.
const effectiveStatus = (order, at) => {
  if (!order) return null;
  if (order.status === 'retired' || order.status === 'draft') return order.status;
  return isExpired(order, at) ? 'expired' : order.status;
};

// ---- Execution (§4) ------------------------------------------------------
// The check is: role ∈ permittedExecutorRoles AND every requested order type ∈
// that role's CREDENTIAL CEILING. The two are independent on purpose — a
// mis-authored protocol that names an LMSW and permits a CBC must not be able
// to authorise out-of-scope work. The provider's signature on a document is
// not a licence extension.
const authorizeExecution = ({ standingOrder, actor, orderType, tests, diagnosisCodes, clientId, at }) => {
  if (!standingOrder) return { error: 'Standing order not found', code: 'STANDING_ORDER_NOT_FOUND', status: 404 };

  // RULE 2: unsigned, expired or non-active protocols cannot be executed.
  const status = effectiveStatus(standingOrder, at);
  if (status !== EXECUTABLE_STATUS) {
    const why = {
      draft: 'This standing order is still a draft — it has not been signed and activated.',
      expired: `This standing order expired ${String(standingOrder.expiresAt || '').slice(0, 10)}. A provider must revise it before it can be executed again.`,
      retired: 'This standing order has been retired.'
    }[status] || 'This standing order is not active.';
    return { error: why, code: `STANDING_ORDER_${String(status).toUpperCase()}`, status: 409 };
  }
  if (!standingOrder.signedAt) {
    return { error: 'This standing order carries no provider signature and cannot be executed.', code: 'STANDING_ORDER_UNSIGNED', status: 409 };
  }

  const role = roles.resolveClinicalRole(actor);
  if (!(standingOrder.permittedExecutorRoles || []).includes(role)) {
    return {
      error: `This protocol authorises ${(standingOrder.permittedExecutorRoles || []).join(', ') || 'nobody'} to act on it; your clinical role is ${role || 'none'}.`,
      code: 'STANDING_ORDER_ROLE_NOT_PERMITTED', status: 403
    };
  }

  const type = String(orderType || '').trim();
  if (!(standingOrder.permittedOrderTypes || []).includes(type)) {
    return {
      error: `This protocol permits ${(standingOrder.permittedOrderTypes || []).join(', ')} orders; it does not permit a ${type || 'blank'} order.`,
      code: 'STANDING_ORDER_TYPE_NOT_PERMITTED', status: 403
    };
  }

  // THE CREDENTIAL CEILING — checked independently of the protocol.
  const ceiling = roles.withinCredentialCeiling(role, [type]);
  if (!ceiling.ok) {
    return {
      error: `A ${role} may execute ${ceiling.allowed.join(', ') || 'no'} orders under a standing order. This protocol names ${role} and permits a ${type} order, but a signed protocol cannot extend a licence — the ${type} order is refused.`,
      code: 'CREDENTIAL_CEILING', status: 403, ceiling: ceiling.allowed, requested: type
    };
  }

  // RULE 4: execution cannot exceed the protocol. Tests come from
  // permittedTests BY SELECTION — a test typed in is refused even posted
  // straight at the API.
  const permitted = new Set((standingOrder.permittedTests || []).map(t => t.toLowerCase()));
  const requested = uniqStrings(tests, 200, 30);
  if (!requested.length) return { error: 'At least one test / study is required', code: 'ORDER_NO_TESTS', status: 400 };
  const outside = requested.filter(t => !permitted.has(t.toLowerCase()));
  if (outside.length) {
    return {
      error: `${outside.join(', ')} is not on this standing order. It permits: ${(standingOrder.permittedTests || []).join(', ')}.`,
      code: 'STANDING_ORDER_TEST_NOT_PERMITTED', status: 403, outside
    };
  }

  // The named-scope protocol reaches only the clients it names.
  if (standingOrder.patientScope === 'named' && !(standingOrder.namedClientIds || []).includes(String(clientId || ''))) {
    return { error: 'This standing order does not cover this client.', code: 'STANDING_ORDER_CLIENT_NOT_IN_SCOPE', status: 403 };
  }

  // At least one linked diagnosis must appear in the protocol's indications.
  // (The existing encounter-diagnosis linkage rule still applies and is
  // checked by buildOrder — this is additional, not a replacement.)
  const dx = (Array.isArray(diagnosisCodes) ? diagnosisCodes : []).map(normalizeIcd10).filter(Boolean);
  const indications = standingOrder.indications || [];
  if (!dx.some(c => indications.includes(c))) {
    return {
      error: `An order under this protocol must link to one of its indications (${indications.join(', ')}).`,
      code: 'STANDING_ORDER_NO_MATCHING_INDICATION', status: 400
    };
  }

  const now = at || new Date().toISOString();
  return {
    ok: true,
    // What the ORDER records. Legally the order is under the authorizing
    // provider's authority, not the nurse's — so they are the ordering
    // clinician of record and the acting user is `executedBy`.
    authority: 'standing_order',
    standingOrderRef: { id: standingOrder.id, version: standingOrder.version, title: standingOrder.title, lineageId: standingOrder.lineageId || standingOrder.id },
    orderingClinician: {
      id: standingOrder.authorizingProvider.userId,
      name: standingOrder.authorizingProvider.name,
      licenseLevel: standingOrder.authorizingProvider.credential,
      npi: standingOrder.authorizingProvider.npi,
      openEmrProviderId: null
    },
    executedBy: {
      id: (actor && actor.id) || null,
      name: (actor && actor.name) || null,
      credential: (actor && actor.licenseLevel) || null,
      clinicalRole: role
    },
    coSign: standingOrder.requiresCoSign
      ? {
          coSignStatus: 'pending',
          coSignDueAt: standingOrder.coSignWithinDays
            ? new Date(new Date(now).getTime() + standingOrder.coSignWithinDays * 86400000).toISOString()
            : null,
          coSignedAt: null, coSignedBy: null
        }
      : { coSignStatus: 'not_required', coSignDueAt: null, coSignedAt: null, coSignedBy: null }
  };
};

// The audit row. Every execution writes the standing order id AND VERSION, the
// authorizing provider, the executing user and credential, the tests, the
// diagnoses and the patient.
const buildExecutionAudit = ({ order, standingOrder, actor, clientId }) => ({
  standingOrderId: standingOrder.id,
  standingOrderLineageId: standingOrder.lineageId || standingOrder.id,
  standingOrderVersion: standingOrder.version,
  standingOrderTitle: standingOrder.title,
  authorizingProviderId: standingOrder.authorizingProvider.userId,
  authorizingProviderName: standingOrder.authorizingProvider.name,
  authorizingProviderNpi: standingOrder.authorizingProvider.npi,
  executedByUserId: (actor && actor.id) || null,
  executedByName: (actor && actor.name) || null,
  executedByCredential: (actor && actor.licenseLevel) || null,
  executedByClinicalRole: roles.resolveClinicalRole(actor),
  orderId: order.id,
  orderType: order.orderType,
  tests: order.tests,
  diagnoses: order.diagnosisCodes,
  patientId: clientId,
  encounterUuid: order.encounterUuid,
  at: order.createdAt
});

// Clearing a pending co-signature on an executed order. The clinical inbox
// that will queue these is out of scope for this session (§7) — the field is
// here, and this is what clears it, so it is not left inert.
const applyOrderCoSign = (order, actor, at) => {
  if (!order) return { error: 'Order not found', code: 'ORDER_NOT_FOUND' };
  if (order.coSignStatus !== 'pending') {
    return { error: 'This order is not waiting on a co-signature', code: 'ORDER_NOT_PENDING_CO_SIGN' };
  }
  if (!roles.canCoSignEncounter(actor)) {
    return { error: 'A co-signature is provided by an LCSW or a provider', code: 'CO_SIGN_CREDENTIAL' };
  }
  const now = at || new Date().toISOString();
  return {
    order: {
      ...order, coSignStatus: 'cleared', coSignedAt: now,
      coSignedBy: { id: (actor && actor.id) || null, name: (actor && actor.name) || null, clinicalRole: roles.resolveClinicalRole(actor) },
      updatedAt: now
    }
  };
};

module.exports = {
  STATUSES,
  EXECUTABLE_STATUS,
  EXECUTOR_ROLES,
  PATIENT_SCOPES,
  buildStandingOrder,
  setStandingOrderStatus,
  isExpired,
  effectiveStatus,
  authorizeExecution,
  buildExecutionAudit,
  applyOrderCoSign,
  normalizeIcd10
};
