// ============================================================================
// CAREGIVER ATTESTATIONS — the forms a caregiver signs HERE, in the app
// ============================================================================
// Seven of the welcome packet's Part Two items are not documents somebody has
// to find, print, sign and photograph. They are OUR forms. Making them upload
// slots meant a caregiver waited on a PDF from us, printed it, signed it,
// photographed it and sent it back — four steps and a printer, for a form we
// wrote. They are signed in the app now, at the same stage as the rest of the
// packet, the way a client signs a consent in the intake wizard.
//
// THIS MODULE IS THE ONLY PLACE THE WORDING LIVES. The page renders whatever
// it is served and names no clause of its own — the rule the packet sections,
// the competency catalog and the document kinds all follow, and the reason a
// page cannot drift from the validator that refuses an answer it did not
// offer. The signed-copy PDF reads the same bodies.
//
// VERSIONING, and it is the point of the whole design. A signed copy must
// reproduce the document AS PRESENTED AT SIGNING, never whatever the text says
// after a later revision. Every attestation carries a `version` stamped onto
// the record at signature time, and a superseded body stays reachable in
// ARCHIVE so an old signature still renders its own text. Bump the version and
// archive the outgoing body whenever wording changes — never edit a shipped
// one. A caregiver whose signed version is no longer current is asked to sign
// again; that is a NEW signature on a changed document, not an edit.
//
// THE WORDING IS APPROVED FOR USE (owner, 2026-11-10). The background check
// authorization stays a STANDALONE disclosure because the FCRA requires the
// disclosure to appear in a document consisting solely of it; folding it into
// the welcome packet's own signature would defeat that.
//
// Pure: no storage, no request context, no I/O.
// ============================================================================

'use strict';

// Block vocabulary, deliberately the consent registry's so the two render the
// same way and a reader moving between them sees one system:
//   { t:'p',      text }    paragraph (**bold** supported)
//   { t:'h',      text }    heading
//   { t:'ul',     items }   bullet list
//   { t:'note',   text }    muted aside
//   { t:'choice', key, label, options, required }
//                           a recorded election, stored as its own field on the
//                           record rather than buried in the signature
const p = (text) => ({ t: 'p', text });
const h = (text) => ({ t: 'h', text });
const ul = (items) => ({ t: 'ul', items });
const note = (text) => ({ t: 'note', text });
const choice = (key, label, options, required = true) => ({
  t: 'choice', key, label, required,
  options: options.map(([value, optLabel]) => ({ value, label: optLabel }))
});

// The version a NEW signature is stamped with. The stored id keeps the word
// "draft" from its first pass and MUST NOT be renamed: every signature on file
// is matched against it, and a new id would ask every caregiver to sign again.
// What people SEE is `versionLabel`, which never shows "draft" (owner,
// 2026-11-10: no draft wording on these forms anywhere).
const CURRENT_VERSION = '2026-09-draft-1';
const versionLabel = (v) => (v ? String(v).replace(/-?draft-?/ig, '-').replace(/--+/g, '-').replace(/^-|-$/g, '') : v);

// ---------------------------------------------------------------------------
// 1. Background check authorization
// ---------------------------------------------------------------------------
const BACKGROUND_CHECK_AUTH = [
  p('Godwins Family Care LLC ("GFC") may obtain one or more consumer reports or investigative consumer reports about you for employment purposes, now and, to the extent permitted by law, at any time during your employment.'),
  p('These reports may include criminal history records, a Georgia criminal history records check, sex offender registry results, abuse and neglect registry results, identity and address history, and verification of the licenses, certifications, education and employment you have told us about.'),
  h('Your rights'),
  ul([
    'You have the right to request a copy of any report obtained about you, and to know the name and address of the agency that prepared it.',
    'You have the right to dispute the accuracy or completeness of anything in a report, directly with the agency that prepared it.',
    'If anything in a report leads us not to hire you or not to continue your employment, we will tell you before we act, give you a copy of the report and a summary of your rights, and give you a reasonable chance to respond.',
    'A record in your past does not automatically disqualify you. We look at what it was, how long ago, and whether it relates to the work.'
  ]),
  h('What you are authorizing'),
  p('By signing, you authorize GFC and the consumer reporting agency it uses to obtain the reports described above, and you authorize any person or organization holding the information — including former employers, schools, licensing boards, and law enforcement and government agencies — to release it to them.'),
  p('You confirm that the personal information you have given us for this purpose, including your legal name, date of birth and Social Security number, is true and correct to the best of your knowledge.'),
  note('This authorization is for employment screening only. It does not authorize a credit check.')
];

// ---------------------------------------------------------------------------
// 2. Registry attestation
// ---------------------------------------------------------------------------
const REGISTRY_ATTESTATION = [
  p('Georgia requires every person who provides hands-on care in a client\'s home to be screened against the registries that record findings of abuse, neglect and exploitation. This form is your own statement about those records. We verify it independently; we are not asking you to prove it.'),
  h('What you are attesting to'),
  p('To the best of your knowledge, and as of today:'),
  ul([
    'You have never had a finding of abuse, neglect, or misappropriation of property entered against you on the Georgia Nurse Aide Registry or on any comparable registry in any other state.',
    'You are not listed on any state or federal abuse, neglect, or exploitation registry.',
    'You are not listed on any sex offender registry.',
    'You are not excluded from participation in Medicare, Medicaid, or any other federal health care program.',
    'No professional license or certification of yours has been suspended, revoked, surrendered, or restricted by any state board.'
  ]),
  choice('attestation', 'Which is true for you?', [
    ['all_clear', 'All of the statements above are true for me.'],
    ['needs_discussion', 'One or more of these does not apply to me cleanly. I want to talk to the office about it.']
  ]),
  note('Choosing the second option is not a refusal and it is not a disqualification. It tells us to have a conversation before the screening comes back, which is better for everyone than a surprise.'),
  h('Keeping it current'),
  p('If any of this changes while you work for us — a charge, a finding, a licensing action, anything — you agree to tell the office within three business days. Telling us is not the thing that gets someone dismissed. Not telling us is.')
];

// ---------------------------------------------------------------------------
// 3. Physical ability
// ---------------------------------------------------------------------------
const PHYSICAL_ABILITY = [
  p('Caregiving is physical work, and how physical it is depends entirely on the assignment. This form tells us what you can do so we match you to work that fits, rather than to work that does not.'),
  h('The physical parts of the job'),
  p('Depending on the client and the assignment, the work may involve:'),
  ul([
    'Standing and walking for most of a shift.',
    'Bending, kneeling, reaching, and getting up and down from floor level.',
    'Helping a person transfer between a bed, a chair, a wheelchair and a toilet, sometimes bearing part of their weight.',
    'Lifting and carrying up to 25 pounds routinely, and more with a second person or with equipment.',
    'Pushing a wheelchair or a walker, including over a threshold or a ramp.',
    'Light housekeeping, laundry, and meal preparation.',
    'Responding quickly if someone loses their balance or falls.'
  ]),
  note('No client assignment involves all of these. A companionship assignment may involve almost none of them. We will tell you what a specific assignment needs before you accept it.'),
  choice('ability', 'Which describes you?', [
    ['able', 'I can perform the functions above, with or without a reasonable accommodation.'],
    ['accommodation', 'I can do this work, but I need a reasonable accommodation or a limit on some of it. I want to talk to the office.']
  ]),
  h('Asking for an accommodation'),
  p('If you need an accommodation, tell us. We are required to consider it and we want to — an accommodation that keeps a good caregiver working is worth far more to us than the assignment it changes. You do not have to give us a diagnosis or any medical detail to start that conversation.'),
  h('While you are working'),
  p('You agree to tell the office if something changes — an injury, a pregnancy, a new restriction from your own doctor — so we can adjust the assignment rather than have you work through it. You will never be asked to lift or transfer a person alone when the care plan says two people.')
];

// ---------------------------------------------------------------------------
// 4. Mandatory reporter acknowledgement
// ---------------------------------------------------------------------------
const MANDATORY_REPORTER = [
  p('In Georgia, people who care for older adults and adults with disabilities are required by law to report suspected abuse, neglect or exploitation. That duty is yours personally. It is not satisfied by telling your supervisor and leaving it there, and it is not something GFC can waive.'),
  h('What you must report'),
  ul([
    'Physical abuse — hitting, rough handling, restraint, or any injury you cannot account for.',
    'Neglect — a person left without food, water, medication, heat, or needed care, including by themselves.',
    'Exploitation — someone taking a client\'s money, property, benefits or identity.',
    'Sexual abuse of any kind.',
    'Emotional or verbal abuse — threats, intimidation, humiliation, isolation.',
    'Abandonment — a caregiver or family member leaving a person who cannot be left.'
  ]),
  p('**You report suspicion, not proof.** You are not required to be sure, to investigate, or to decide whether it really happened. Deciding is somebody else\'s job. Reporting what you saw is yours.'),
  h('How to report'),
  ul([
    'If someone is in immediate danger, call 911 first.',
    'Report to Georgia Adult Protective Services at 1-866-552-4464, or online through the Division of Aging Services. For a child, report to the Division of Family and Children Services at 1-855-422-4453.',
    'Tell GFC as well, through the app\'s Flag a concern button or by calling the office. We open an incident record and follow up with you.'
  ]),
  note('Reporting to us does not replace reporting to the state, and reporting to the state does not replace telling us. Both, every time.'),
  h('Protection and retaliation'),
  p('Georgia law protects a person who reports in good faith. GFC does not retaliate against anyone for making a report — not through scheduling, not through assignments, not through pay. If you believe you have been treated differently for reporting, tell the owner directly.'),
  p('Failing to report when you are required to is a criminal offense in Georgia and can end your employment here.')
];

// ---------------------------------------------------------------------------
// 5–7. Employment acknowledgments (owner, 2026-11-10)
// ---------------------------------------------------------------------------
// These three used to be read and signed in Gusto, with a photographed copy
// uploaded back here. Gusto is no longer part of caregiver onboarding: they are
// signed in the app like the four forms above. Each acknowledges a GFC policy
// document the office keeps current; the key points are restated so the
// caregiver signs something she has actually read on her phone.
const EMPLOYEE_HANDBOOK = [
  p('The Godwins Family Care Employee Handbook explains how we work: pay and pay periods, scheduling and time off, clocking in and out, documentation, safety, and how concerns are raised and handled.'),
  h('What you are agreeing to'),
  ul([
    'You have received the current Employee Handbook, or know how to get it from the office at any time.',
    'You have read it, or will read it before your first shift, and you will ask the office about anything that is not clear.',
    'You will follow the handbook and the policies it points to, including the ones that change after today.',
    'The handbook is not a contract and does not change your status as an at-will W-2 employee.'
  ]),
  note('When the handbook changes in a way that affects you, we will tell you and may ask you to sign again.')
];

const PRIVACY_POLICY = [
  p("Our clients trust us with their homes, their health and their personal information. Federal law (HIPAA) and Georgia law require us to protect that information, and so do you."),
  h('What you agree to'),
  ul([
    'You use client information only to give care, and you share it only with people who need it for that care.',
    'You never post about a client, their home or their family on social media, even without a name.',
    'You never text, email or photograph client information outside the GFC app.',
    'You keep your app sign-in to yourself and sign out on any shared device.',
    'You tell the office right away if client information is lost, sent to the wrong person, or seen by someone who should not have it.'
  ]),
  p('This duty continues after you stop working with GFC. Breaking it can end your employment and can carry legal penalties.'),
  note('We do not share any client details with you until this is signed.')
];

const CODE_OF_CONDUCT = [
  p('This is what we expect from everyone on a shift, and what our clients and their families can expect from you.'),
  h('On every shift'),
  ul([
    'Arrive on time, clock in and out in the app, and file your visit log before you leave.',
    'Treat every client with dignity and respect, and honor their choices and routines.',
    'Do only the tasks on the care plan and within your role. Ask the office before doing anything else.',
    'Never accept money, gifts or loans from a client or their family, and never borrow from them.'
  ]),
  h('Attendance'),
  p('If you cannot work a shift, tell the office as early as you can. Not showing up without notice leaves a client without care and can end your employment.'),
  h('Incidents'),
  p('Report any fall, injury, change in condition, safety concern or unusual event to the office the same day, through the app. Call 911 first in an emergency.')
];

// ---------------------------------------------------------------------------
// The registry of bodies.
// ---------------------------------------------------------------------------
// `kind` matches the checklist item's kind, so the item and the document it
// opens cannot drift. `standalone` marks a document that must be presented and
// signed on its own — the FCRA disclosure is the reason that flag exists.
const ATTESTATIONS = Object.freeze({
  background_check_auth: Object.freeze({
    kind: 'background_check_auth',
    title: 'Background Check Authorization',
    intro: 'Read this and sign it. We cannot start your screening without it, and the screening is the longest wait on the list.',
    standalone: true,
    blocks: Object.freeze(BACKGROUND_CHECK_AUTH)
  }),
  registry_attestation: Object.freeze({
    kind: 'registry_attestation',
    title: 'Registry Attestation',
    intro: 'Your own statement about abuse and neglect registries. Takes a minute.',
    standalone: false,
    blocks: Object.freeze(REGISTRY_ATTESTATION)
  }),
  physical_ability: Object.freeze({
    kind: 'physical_ability',
    title: 'Physical Ability Acknowledgement',
    intro: 'What the work involves physically, and what you can do. This is how we match you to an assignment that fits.',
    standalone: false,
    blocks: Object.freeze(PHYSICAL_ABILITY)
  }),
  mandatory_reporter: Object.freeze({
    kind: 'mandatory_reporter',
    title: 'Mandatory Reporter Acknowledgement',
    intro: 'Georgia law makes this your personal duty. Read it before you sign it.',
    standalone: false,
    blocks: Object.freeze(MANDATORY_REPORTER)
  }),
  employee_handbook: Object.freeze({
    kind: 'employee_handbook',
    title: 'Employee Handbook Acknowledgement',
    intro: 'How we work, in one place. Read the key points and sign.',
    standalone: false,
    blocks: Object.freeze(EMPLOYEE_HANDBOOK)
  }),
  privacy_policy: Object.freeze({
    kind: 'privacy_policy',
    title: 'Privacy and Confidentiality Agreement',
    intro: "How we protect our clients' information. Signed before we share any client details with you.",
    standalone: false,
    blocks: Object.freeze(PRIVACY_POLICY)
  }),
  code_of_conduct: Object.freeze({
    kind: 'code_of_conduct',
    title: 'Code of Conduct, Attendance and Incident Reporting',
    intro: 'What we expect on a shift, and how to tell us when something goes wrong.',
    standalone: false,
    blocks: Object.freeze(CODE_OF_CONDUCT)
  })
});

// ---------------------------------------------------------------------------
// ARCHIVE — superseded body versions.
// ---------------------------------------------------------------------------
// A signed attestation renders the text it was signed against, forever. Empty
// today because nothing has been superseded yet: the first revision to any
// body puts the outgoing text here under its own version id. Never delete an
// archived version while a signature still points at it.
//
// A PLAIN OBJECT, like the consent registry's, not a frozen one — the tests
// register a version in it to exercise the lookup, which is the only way to
// prove the version argument on `bodyFor` is load-bearing while the real
// archive is empty. Without that seam the archive path is code nothing can
// distinguish from its own fallback.
const ARCHIVE = {};

const KINDS = Object.freeze(Object.keys(ATTESTATIONS));

const isAttestationKind = (kind) => Object.prototype.hasOwnProperty.call(ATTESTATIONS, kind);

const titleFor = (kind) => (ATTESTATIONS[kind] ? ATTESTATIONS[kind].title : null);

const currentVersion = (kind) => (ATTESTATIONS[kind] ? CURRENT_VERSION : null);

/**
 * The body a record should render. Pass the version stored ON THE RECORD; omit
 * it for the current text. An unknown version falls back to the current body
 * and is reported by `hasArchivedBody`, so a reader is never shown text
 * silently attributed to a version it is not.
 */
const bodyFor = (kind, version) => {
  const def = ATTESTATIONS[kind];
  if (!def) return [];
  if (!version || version === CURRENT_VERSION) return def.blocks;
  const archived = ARCHIVE[version] && ARCHIVE[version][kind];
  return archived || def.blocks;
};

const hasArchivedBody = (kind, version) =>
  !!(version && version !== CURRENT_VERSION && ARCHIVE[version] && ARCHIVE[version][kind]);

/** The elections this document records as their own fields. */
const choicesFor = (kind, version) => bodyFor(kind, version).filter(b => b.t === 'choice');

/**
 * What the page is served. The blocks and the version travel together: a page
 * that renders one body and posts against another is signing the wrong
 * document, silently.
 */
const servedDocument = (kind) => {
  const def = ATTESTATIONS[kind];
  if (!def) return null;
  return {
    kind: def.kind,
    title: def.title,
    intro: def.intro,
    standalone: def.standalone,
    version: CURRENT_VERSION,
    blocks: def.blocks
  };
};

const servedDocuments = () => KINDS.map(servedDocument);

/**
 * Validate a submitted set of elections against the document's own choices.
 * An unanswered required choice, or an option the document never offered, is
 * refused — the same rule the packet's own validator follows. Returns
 * { ok, elections, missing, invalid }.
 */
function validateElections(kind, submitted) {
  const required = choicesFor(kind);
  const given = (submitted && typeof submitted === 'object') ? submitted : {};
  const elections = {};
  const missing = [];
  const invalid = [];

  for (const block of required) {
    const answer = given[block.key];
    if (answer == null || answer === '') {
      if (block.required) missing.push({ key: block.key, label: block.label });
      continue;
    }
    const allowed = block.options.some(o => o.value === answer);
    if (!allowed) { invalid.push({ key: block.key, value: String(answer).slice(0, 80) }); continue; }
    elections[block.key] = answer;
  }

  return { ok: missing.length === 0 && invalid.length === 0, elections, missing, invalid };
}

/**
 * Is this stored record a satisfied signature for the CURRENT text?
 *
 * A record signed against a superseded version is deliberately NOT satisfied:
 * the wording changed, so the signature is on a different document. It is kept
 * and still renders its own text — it just no longer ticks the checklist.
 */
function isSigned(record) {
  return !!(record && record.signed_at && record.version === CURRENT_VERSION);
}

/** Signed, but against wording we have since replaced. */
function isSupersededSignature(record) {
  return !!(record && record.signed_at && record.version !== CURRENT_VERSION);
}

module.exports = {
  versionLabel,
  CURRENT_VERSION,
  ATTESTATIONS,
  ARCHIVE,
  KINDS,
  isAttestationKind,
  titleFor,
  currentVersion,
  bodyFor,
  hasArchivedBody,
  choicesFor,
  servedDocument,
  servedDocuments,
  validateElections,
  isSigned,
  isSupersededSignature
};
