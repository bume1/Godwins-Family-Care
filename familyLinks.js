// ============================================================================
// familyLinks.js — which patients a family account belongs to (owner,
// 2026-10-20)
//
// A family account used to name ONE patient (`familyOfClientId`) with one POA
// tick (`familyIsPoa`). A daughter who is POA for both parents could not cover
// both with one login, so POAs had been signing in AS the patient, which put
// every signature and message they made under the patient's name.
//
// Now a family account carries a list of links, one per patient, and the POA
// tick lives on each link: POA for Mom does not make anyone POA for Dad.
//
//   familyLinks: [{ clientId, isPoa, relationship, addedAt, addedBy, via }]
//
// Two readers, two rules:
//   - A REQUEST works on one patient at a time, chosen per sign-in and kept on
//     the session row. authenticateToken copies that link onto
//     req.user.familyOfClientId / familyIsPoa, so every request-scoped reader
//     keeps working unchanged.
//   - A BACKGROUND reader (an email, a text, a recipient list) asks
//     familyFor(users, clientId) and never reads the stored mirror fields.
//     Those mirror only the FIRST link and exist for old scripts; reading them
//     for access misses every other patient.
//
// Email stays unique. Sign-in and forgot-password find a person by email, so
// two accounts on one address would leave one of them unable to sign in.
// ============================================================================
'use strict';

const VIA = ['admin', 'invite', 'signup', 'migration', 'poa_cutover'];
const PLACEHOLDER_DOMAIN = 'placeholder.local';

const str = (v) => (v == null ? '' : String(v));

// A login nobody uses: offline onboarding and no-email patients get one so the
// record has an address, and nobody can sign in with it.
const isPlaceholderEmail = (email) => /@placeholder\.local$/i.test(str(email).trim());
const placeholderEmailFor = (kind, id) => `${kind}+${id}@${PLACEHOLDER_DOMAIN}`;

// Every link a family user has. A record from before this change carries only
// the single fields, so they are read as one link; nothing has to be migrated
// for a reader to be right (the boot migration still writes the list).
function linksOf(user) {
  if (!user || user.role !== 'family') return [];
  if (Array.isArray(user.familyLinks)) {
    return user.familyLinks.filter(l => l && l.clientId).map(l => ({ ...l, clientId: str(l.clientId), isPoa: l.isPoa === true }));
  }
  const clientId = user.familyOfClientId || (Array.isArray(user.assignedClients) ? user.assignedClients[0] : null);
  if (!clientId) return [];
  return [{ clientId: str(clientId), isPoa: user.familyIsPoa === true, relationship: user.familyRelationship || null, addedAt: null, addedBy: null, via: 'migration' }];
}

const linkFor = (user, clientId) => linksOf(user).find(l => l.clientId === str(clientId)) || null;
const isFamilyOf = (user, clientId) => !!linkFor(user, clientId);
const isPoaFor = (user, clientId) => { const l = linkFor(user, clientId); return !!(l && l.isPoa); };

const activeAccount = (u) => u && (u.accountStatus || 'active') !== 'inactive';

// Everyone on the family side of one patient: [{ user, link }].
function familyFor(users, clientId, { poaOnly = false, activeOnly = true } = {}) {
  const out = [];
  for (const u of Array.isArray(users) ? users : []) {
    if (!u || u.role !== 'family') continue;
    if (activeOnly && !activeAccount(u)) continue;
    const link = linkFor(u, clientId);
    if (!link || (poaOnly && !link.isPoa)) continue;
    out.push({ user: u, link });
  }
  return out;
}

// The only writer. Dedupes by patient (the first wins) and keeps the old
// fields mirroring the first link so older scripts still read something true.
function applyLinks(user, links) {
  const seen = new Set();
  const clean = [];
  for (const l of Array.isArray(links) ? links : []) {
    if (!l || !l.clientId) continue;
    const clientId = str(l.clientId);
    if (seen.has(clientId)) continue;
    seen.add(clientId);
    clean.push({
      clientId,
      isPoa: l.isPoa === true,
      relationship: l.relationship ? str(l.relationship).slice(0, 80) : null,
      addedAt: l.addedAt || null,
      addedBy: l.addedBy || null,
      via: VIA.includes(l.via) ? l.via : 'admin'
    });
  }
  user.familyLinks = clean;
  user.familyOfClientId = clean[0] ? clean[0].clientId : null;
  user.familyIsPoa = clean[0] ? clean[0].isPoa : false;
  user.familyRelationship = clean[0] ? clean[0].relationship : (user.familyRelationship || null);
  return user;
}

// Add or update one link, leaving the others alone.
function upsertLink(user, link) {
  const links = linksOf(user).filter(l => l.clientId !== str(link.clientId));
  const prior = linkFor(user, link.clientId);
  links.push({ ...(prior || {}), ...link, clientId: str(link.clientId) });
  return applyLinks(user, links);
}

// What the admin form posts. Each patient must be a real client account, the
// POA tick must be literally true, and a patient may appear once.
// → { links } | { error, code }
function normalizeLinksInput(input, { users, actorId = null, previous = [], now = () => new Date().toISOString() } = {}) {
  if (input == null) return { links: [] };
  if (!Array.isArray(input)) return { error: 'familyLinks must be a list.', code: 'FAMILY_LINKS_INVALID' };
  const clients = new Map((users || []).filter(u => u && u.role === 'client').map(u => [str(u.id), u]));
  const prior = new Map((previous || []).map(l => [str(l.clientId), l]));
  const seen = new Set();
  const links = [];
  for (const raw of input) {
    const clientId = str(raw && raw.clientId).trim();
    if (!clientId) continue;
    if (!clients.has(clientId)) return { error: 'One of the linked patients is not a patient account.', code: 'FAMILY_LINK_NOT_A_CLIENT' };
    if (seen.has(clientId)) return { error: 'A patient is listed twice.', code: 'FAMILY_LINK_DUPLICATE' };
    seen.add(clientId);
    const was = prior.get(clientId);
    links.push({
      clientId,
      isPoa: raw.isPoa === true,
      relationship: raw.relationship ? str(raw.relationship).trim().slice(0, 80) : null,
      addedAt: was ? was.addedAt : now(),
      addedBy: was ? was.addedBy : actorId,
      via: was ? was.via : 'admin'
    });
  }
  return { links };
}

// Which patient this request is about.
//   one link            → that one
//   several, valid pick → the pick
//   several, no pick    → none; the person chooses (needsChoice)
// A pick for a patient no longer linked is ignored, never honoured. The
// header is what the page believes it is showing: when it disagrees with
// the session, the page is a stale tab and must not write.
// → { link, needsChoice, mismatch }
function resolveActive({ user, sessionActiveId = null, headerId = null }) {
  const links = linksOf(user);
  let link = null;
  if (links.length === 1) link = links[0];
  else if (links.length > 1 && sessionActiveId) link = links.find(l => l.clientId === str(sessionActiveId)) || null;
  const needsChoice = links.length > 1 && !link;
  const mismatch = !!(headerId && link && str(headerId) !== link.clientId);
  return { link, needsChoice, mismatch };
}

// ---- Moving a shared login to the POA --------------------------------------
// Until now a POA signed in with the patient's own account. The cutover moves
// that login (email, password hash, MFA) onto a family account with a POA link,
// and gives the patient a placeholder login. The POA signs in exactly as
// before; from then on what they do reads as them.
//
// Passwords are never merged. A bcrypt hash cannot tell whether two passwords
// are the same, and quietly replacing one person's password with another's is
// how somebody gets locked out of their own account.
//
//   mode 'move'          → target: a new family account, or an existing one
//                          with no login of its own (placeholder email)
//   mode 'link_existing' → target: a family account with its own login; it
//                          gains the POA link and the patient's login retires
//
// Pure: returns what to write, or why not. → { error, code } |
//   { clientPatch, familyPatch, familyIsNew }
const MOVED_FIELDS = ['email', 'password', 'mfa', 'requirePasswordChange', 'emailUnsubscribed'];

function planPoaCutover({ client, target = null, mode = 'move', newFamily = null, clientPlaceholderEmail, clientPasswordHash, actorId = null, at = new Date().toISOString(), relationship = null }) {
  if (!client || client.role !== 'client') return { error: 'That is not a patient account.', code: 'POA_CUTOVER_NOT_A_CLIENT' };
  if (isPlaceholderEmail(client.email) || !str(client.email).trim()) return { error: 'This patient has no login to move.', code: 'POA_CUTOVER_NOTHING_TO_MOVE' };
  if (!clientPlaceholderEmail || !clientPasswordHash) return { error: 'A replacement login is required.', code: 'POA_CUTOVER_INVALID' };
  if (!['move', 'link_existing'].includes(mode)) return { error: 'Unknown cutover mode.', code: 'POA_CUTOVER_INVALID' };

  const link = { clientId: str(client.id), isPoa: true, relationship: relationship || null, addedAt: at, addedBy: actorId, via: 'poa_cutover' };
  const clientPatch = { email: clientPlaceholderEmail, password: clientPasswordHash, mfa: null, requirePasswordChange: false, emailUnsubscribed: false };

  if (mode === 'link_existing') {
    if (!target) return { error: 'Choose the POA’s existing account.', code: 'POA_CUTOVER_TARGET_REQUIRED' };
    if (target.role !== 'family') return { error: 'The POA account must be a family account.', code: 'POA_CUTOVER_TARGET_NOT_FAMILY' };
    if (isPlaceholderEmail(target.email)) return { error: 'That account has no login of its own. Move the patient’s login to it instead.', code: 'POA_CUTOVER_TARGET_HAS_NO_LOGIN' };
    const familyPatch = upsertLink({ ...target, familyLinks: linksOf(target) }, link);
    return { clientPatch, familyPatch: pick(familyPatch, ['familyLinks', 'familyOfClientId', 'familyIsPoa', 'familyRelationship']), familyIsNew: false, movedFields: [] };
  }

  // move
  if (target) {
    if (target.role !== 'family') return { error: 'The POA account must be a family account.', code: 'POA_CUTOVER_TARGET_NOT_FAMILY' };
    if (!isPlaceholderEmail(target.email)) return { error: 'That account already has its own login, so the two cannot be merged. Link the patient to it instead.', code: 'POA_CUTOVER_TARGET_HAS_LOGIN' };
  } else if (!newFamily || !str(newFamily.name).trim()) {
    return { error: 'Enter the POA’s name.', code: 'POA_CUTOVER_NAME_REQUIRED' };
  }
  const base = target ? { ...target, familyLinks: linksOf(target) } : { ...newFamily, role: 'family', familyLinks: [] };
  const moved = {};
  for (const f of MOVED_FIELDS) moved[f] = client[f] === undefined ? null : client[f];
  const familyPatch = upsertLink({ ...base, ...moved }, link);
  return {
    clientPatch,
    familyPatch: pick(familyPatch, [...MOVED_FIELDS, 'familyLinks', 'familyOfClientId', 'familyIsPoa', 'familyRelationship']),
    familyIsNew: !target,
    movedFields: MOVED_FIELDS.slice()
  };
}

function pick(obj, keys) { const o = {}; for (const k of keys) o[k] = obj[k] === undefined ? null : obj[k]; return o; }

// ---- Finding them ----------------------------------------------------------
// There is no sure way to tell a patient's own login from one their POA uses,
// so this only suggests. Each reason is a plain sentence for the admin.
function possiblePoaLoginReasons(client) {
  if (!client || client.role !== 'client' || isPlaceholderEmail(client.email)) return [];
  const intake = client.intake || {};
  const reasons = [];
  const legal = intake.legalDocs || {};
  // The intake asks this as a multi-select ('Healthcare POA activated',
  // 'Guardianship', 'Healthcare surrogate designated', ...).
  const legalSaysPoa = Array.isArray(legal) ? legal.some(x => /healthcare poa|guardian|surrogate/i.test(str(x))) : !!legal.powerOfAttorney;
  if (legalSaysPoa || (intake.decisionMaker && intake.decisionMaker.name)) reasons.push('A power of attorney or decision maker is on file.');
  const name = str(client.name).toLowerCase().replace(/[^a-z]/g, '');
  const meta = client.consentMeta || {};
  for (const k of Object.keys(meta)) {
    const typed = str(meta[k] && meta[k].typedName).toLowerCase().replace(/[^a-z]/g, '');
    if (typed && name && typed !== name) { reasons.push('A consent was signed with a different name.'); break; }
  }
  const contact = str(intake.primaryContact && intake.primaryContact.email).toLowerCase().trim();
  if (contact && contact === str(client.email).toLowerCase().trim()) reasons.push('The login email is the primary contact’s email.');
  return reasons;
}

module.exports = {
  VIA, PLACEHOLDER_DOMAIN, MOVED_FIELDS,
  isPlaceholderEmail, placeholderEmailFor,
  linksOf, linkFor, isFamilyOf, isPoaFor, familyFor,
  applyLinks, upsertLink, normalizeLinksInput, resolveActive,
  planPoaCutover, possiblePoaLoginReasons
};
