// emailCopy.js — the wording of every email, in one editable place.
//
// Owner, 2026-11-09: "update our email template library in-full so we can
// easily edit ANY email."
//
// ──────────────────────────────────────────────────────────────────────────
// THE ONE DESIGN DECISION EVERYTHING ELSE FOLLOWS FROM
//
// The editable unit is the set of PIECES `renderGfcEmail` already takes —
// subject, headline, an ordered list of paragraphs, a callout and its label,
// the button label — and never HTML, and never a prose blob something
// re-parses. Three guarantees come free that way:
//
//   1. `emailTemplates.js` escapes every value it is handed, so an admin's
//      wording cannot inject markup into either half of the email.
//   2. The house chrome stays in `emailTemplates.js`, which is the only file
//      in the repo allowed to contain email markup (test/email_branding.js
//      DISCOVERS senders and enforces that, so the rule covers files that do
//      not exist yet).
//   3. `safeUrl()` still owns every link, so a destination cannot be edited
//      into something that is not a GFC path.
//
// The old `email_templates` store held a `body` and an `htmlBody`, and that
// shape is exactly what let five emails opt out of the house style. If the
// ask ever becomes "just let me paste the email in", the answer is the
// per-paragraph editor, not a textarea.
//
// ──────────────────────────────────────────────────────────────────────────
// WHERE THE WORDING LIVES, AND WHERE THE EDITS LIVE
//
// The DEFAULTS are in this file, in code, so a wording improvement ships with
// a deploy and nothing in a database goes stale. The OVERRIDES are a sparse
// store (`email_copy_overrides`) holding only the fields an admin changed, so
// "reset to the built-in" is a delete and a built-in is never copied anywhere
// it can rot. That is the opposite of the lab-era library, which seeded its
// defaults into the store and then drifted from the code that sent them.
//
// This module is PURE. No database, no markup, no `require('./emailTemplates')`.
// `resolve` is synchronous, which is what lets the ~40 call sites that bypass
// the notifier use it without inheriting the notifier's dependencies.

'use strict';

// A placeholder is `{{name}}`. Whitespace inside the braces is tolerated
// because an admin typing one by hand will put it there.
const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g;

// The fields of a notice an admin may edit. Anything outside this list is
// refused BY NAME rather than dropped: a silent no-op is the worst of the
// three possible answers to "I changed this and saved it".
const EDITABLE_FIELDS = Object.freeze(['subject', 'headline', 'paragraphs', 'callout', 'calloutLabel', 'ctaLabel']);

// The two wordings a notice can have. `detailed` is what sends on a transport
// inside the BAA; `vague` is what sends when it is not, and it must say that
// something is waiting and nothing about what.
const VARIANTS = Object.freeze(['detailed', 'vague']);

const AUDIENCES = Object.freeze({
  client: 'Clients and family',
  caregiver: 'Caregivers',
  clinical: 'Clinical staff',
  office: 'The office'
});

const MAX_FIELD = 2000;
const MAX_PARAGRAPHS = 12;

// ──────────────────────────────────────────────────────────────────────────
// Substitution.
//
// ⚠️ `fill` DELIBERATELY DOES NO ESCAPING, and that is not an oversight.
// `emailTemplates.renderGfcEmail` escapes every value it is given, in both
// the HTML and the text half. Escaping here as well would double-encode and
// an ampersand would reach the reader as `&amp;amp;`. The next person to read
// this file will want to "fix" it; this comment is why they should not. The
// test `markup in an override is escaped end to end` proves the escaping
// happens where it should, by rendering a real email and reading it back.
const fill = (str, data) => String(str == null ? '' : str)
  .replace(PLACEHOLDER_RE, (_m, key) => {
    const v = data && data[key];
    return v === undefined || v === null ? '' : String(v);
  });

const placeholdersIn = (str) => {
  const out = [];
  String(str == null ? '' : str).replace(PLACEHOLDER_RE, (_m, k) => { out.push(k); return _m; });
  return out;
};

const blockPlaceholders = (block) => {
  if (!block) return [];
  const parts = [block.subject, block.headline, block.callout, block.calloutLabel, block.ctaLabel]
    .concat(Array.isArray(block.paragraphs) ? block.paragraphs : []);
  return [...new Set(parts.flatMap(placeholdersIn))];
};

// ──────────────────────────────────────────────────────────────────────────
// The registry.
//
// `id` is a copyId and is deliberately NOT the notification `type`. Three
// cases in this app prove they cannot be the same thing: one builder sends
// `phc_document_accepted` and `phc_document_rejected` with different copy;
// `visitReminder` and `videoReminder` both send type `visit_reminder` with
// different wording; and `shift_assigned` is sent from three places with three
// different sentences. `type` owns dedupe and the cooldown. `copyId` owns
// wording.
//
// `placeholders` declares every value the copy may use. `phi: true` marks one
// that names or describes a patient: such a placeholder is REFUSED in a
// `vague` block, at save time and again at send time, because that block is
// what sends when the transport is not covered by a BAA.
const P = (key, label, example, opts = {}) => Object.freeze({
  key, label, example, phi: !!opts.phi, bodyOnly: !!opts.bodyOnly
});

const REGISTRY = Object.freeze({
  // ---- Clinical visits ---------------------------------------------------
  appointment_booked: {
    name: 'Clinician visit booked',
    when: 'A clinical visit is booked for a patient',
    audience: 'client',
    type: 'appointment_booked',
    whose: 'visit',
    placeholders: [
      P('when', 'Date and time', 'Tuesday, November 11 at 2:00 PM', { phi: true }),
      P('whoseVisit', 'Whose visit (reads "Your visit", or "Ada\'s visit" to a POA)', 'Your visit')
    ],
    variants: {
      detailed: {
        subject: 'Your visit is scheduled — {{when}}',
        headline: 'Your visit is scheduled',
        paragraphs: [
          '{{whoseVisit}} is booked. The details are below and in your portal.',
          'If the time does not work, call the office and we will move it.',
          'A reminder will reach you the day before.'
        ],
        ctaLabel: 'Open your portal'
      },
      vague: {
        subject: 'A visit has been scheduled',
        headline: 'Your visit is scheduled',
        paragraphs: [
          'A visit has been scheduled for you. The date and time are in your secure portal.',
          'For privacy we do not put visit details in email.'
        ],
        ctaLabel: 'Open your portal'
      }
    }
  },

  appointment_rescheduled: {
    name: 'Clinician visit moved',
    when: 'A clinical visit is rescheduled',
    audience: 'client',
    type: 'appointment_rescheduled',
    whose: 'visit',
    placeholders: [
      P('from', 'The old date and time', 'Wednesday, November 12 at 9:00 AM', { phi: true }),
      P('to', 'The new date and time', 'Thursday, November 13 at 2:00 PM', { phi: true }),
      P('whoseVisit', 'Whose visit', 'Your visit')
    ],
    variants: {
      detailed: {
        // "Clinician visit" is load-bearing: the caregiver-shift notices say
        // "caregiver visit", so a client reading either one knows which kind
        // of visit moved. Two notices that both read "your visit has been
        // rescheduled" left them to guess.
        subject: 'Your clinician visit has moved to {{to}}',
        headline: 'Your clinician visit has moved',
        paragraphs: [
          '{{whoseVisit}} with the clinician has moved from {{from}} to {{to}}.',
          'Nothing else about the visit has changed. Call the office if the new time does not work.'
        ],
        ctaLabel: 'Open your portal'
      },
      vague: {
        subject: 'A clinician visit has been rescheduled',
        headline: 'Your clinician visit has moved',
        paragraphs: [
          'A visit has been moved to a new time. The new details are in your secure portal.',
          'For privacy we do not put visit details in email.'
        ],
        ctaLabel: 'Open your portal'
      }
    }
  },

  appointment_cancelled: {
    name: 'Clinician visit cancelled',
    when: 'A clinical visit is cancelled',
    audience: 'client',
    type: 'appointment_cancelled',
    whose: 'visit',
    placeholders: [
      P('when', 'When the visit was', 'Wednesday, November 12 at 9:00 AM', { phi: true }),
      P('reason', 'Why it was cancelled (staff free text)', 'The clinician is unwell.', { phi: true }),
      P('whoseVisit', 'Whose visit', 'Your visit')
    ],
    variants: {
      detailed: {
        subject: 'Your visit on {{when}} is cancelled',
        headline: 'Your visit is cancelled',
        paragraphs: [
          '{{whoseVisit}} on {{when}} has been cancelled.',
          'Nothing else has changed about your care. Call the office when you are ready to rebook.'
        ],
        callout: '{{reason}}',
        calloutLabel: 'Why it was cancelled',
        ctaLabel: 'Open your portal'
      },
      vague: {
        subject: 'A visit has been cancelled',
        headline: 'Your visit is cancelled',
        paragraphs: [
          'A scheduled visit has been cancelled. The details are in your secure portal.',
          'Call the office when you are ready to rebook.'
        ],
        ctaLabel: 'Open your portal'
      }
    }
  },

  // ---- Client documents --------------------------------------------------
  phc_document_accepted: {
    name: 'Document accepted',
    when: 'The office accepts a document a client sent',
    audience: 'client',
    type: 'phc_document_accepted',
    placeholders: [
      P('thing', 'What the document is', 'your insurance card', { phi: true }),
      P('forWhom', 'Whose document, for a POA', ' for Ada Bell', { phi: true })
    ],
    variants: {
      detailed: {
        subject: 'We received your document',
        headline: 'Document received',
        paragraphs: ['We received {{thing}}{{forWhom}} and it is accepted. Nothing further is needed from you.'],
        ctaLabel: 'Open your portal'
      },
      vague: {
        subject: 'We received your document',
        headline: 'Document received',
        // ⚠️ {{forWhom}} IS DELIBERATELY ABSENT HERE. It is the patient's own
        // name, shown to their POA, and this is the wording that sends when
        // our email is not covered by a BAA. The old copy read "A document
        // for Ada Bell was received", which names a patient on an uncovered
        // transport — the exact thing the appointment notices avoid. Found by
        // the registry sweep in test/email_copy.test.js, not by reading.
        paragraphs: ['A document was received and accepted. Nothing further is needed from you.'],
        ctaLabel: 'Open your portal'
      }
    }
  },

  phc_document_rejected: {
    name: 'Document sent back',
    when: 'The office sends a client document back. The route REQUIRES a reason',
    audience: 'client',
    type: 'phc_document_rejected',
    placeholders: [
      P('thing', 'What the document is', 'your insurance card', { phi: true }),
      P('forWhom', 'Whose document, for a POA', ' for Ada Bell', { phi: true }),
      P('reason', 'Why it needs sending again (staff free text)', 'The photo is too blurry to read the expiry date.', { phi: true })
    ],
    variants: {
      detailed: {
        subject: 'A document needs another look',
        headline: 'A document needs another look',
        paragraphs: [
          'We looked at {{thing}}{{forWhom}} and need it sent again.',
          'Upload a replacement from the Documents tab in your portal. There is nothing else to do in the meantime.'
        ],
        callout: '{{reason}}',
        calloutLabel: 'Why we need it again',
        ctaLabel: 'Open your portal'
      },
      vague: {
        subject: 'A document needs another look',
        headline: 'A document needs another look',
        paragraphs: [
          // {{forWhom}} absent for the same reason as above.
          'One of the documents on file needs to be sent again.',
          'The reason is in the secure portal, along with the button to upload a replacement. For privacy we do not put document details in email.'
        ],
        ctaLabel: 'Open your portal'
      }
    }
  },

  // ---- Caregiver ---------------------------------------------------------
  caregiver_document_returned: {
    name: 'Caregiver document sent back',
    when: 'The office sends a caregiver document back. The route REQUIRES a reason',
    audience: 'caregiver',
    type: 'caregiver_document_returned',
    placeholders: [
      P('label', 'What the document is', 'TB test result'),
      P('reviewedByName', 'Who sent it back', 'GFC Admin'),
      P('reason', 'Why it needs sending again', 'The photo is too blurry to read the expiry date.')
    ],
    variants: {
      detailed: {
        subject: 'Needs another look — {{label}}',
        headline: 'One of your documents came back',
        paragraphs: ['{{reviewedByName}} sent back "{{label}}".', 'Open the app to send a clearer copy.'],
        callout: '{{reason}}',
        calloutLabel: 'Why we need it again',
        ctaLabel: 'Open my documents'
      }
    }
  },

  shift_cancelled_caregiver: {
    name: 'Shift cancelled (the caregiver)',
    when: 'A shift the caregiver held is cancelled',
    audience: 'caregiver',
    type: 'shift_cancelled',
    placeholders: [
      P('when', 'When the shift was', 'Tuesday, November 11 at 9:00 AM'),
      P('forClient', 'Which client, where one is named', ' for Ada Bell', { phi: true }),
      P('reason', 'Why it was cancelled', 'The family is away that week.', { phi: true })
    ],
    variants: {
      detailed: {
        subject: 'Shift cancelled — {{when}}',
        headline: 'A shift has been cancelled',
        paragraphs: [
          'Your {{when}} shift{{forClient}} has been cancelled. You do not need to go.',
          'Your schedule in the app is up to date.'
        ],
        callout: '{{reason}}',
        calloutLabel: 'Why it was cancelled',
        ctaLabel: 'Open my schedule'
      },
      vague: {
        subject: 'A shift has been cancelled',
        headline: 'A shift has been cancelled',
        paragraphs: [
          'One of your shifts has been cancelled. Open the app to see which one.',
          'For privacy we do not put visit details in email.'
        ],
        ctaLabel: 'Open my schedule'
      }
    }
  },

  // ---- The office --------------------------------------------------------
  password_reset_requested: {
    name: 'Password reset waiting',
    when: 'Somebody asks to have their password reset',
    audience: 'office',
    type: 'password_reset_requested',
    placeholders: [
      P('requesterName', 'Who is locked out', 'Ada Bell', { phi: true }),
      P('requesterEmail', 'Their address', 'ada@example.com', { phi: true })
    ],
    variants: {
      detailed: {
        subject: 'Someone is locked out and waiting',
        headline: 'A password reset is waiting',
        paragraphs: [
          '{{requesterName}} ({{requesterEmail}}) has asked for a password reset.',
          'They have been told an administrator will reach out, so this one is on the clock.'
        ],
        ctaLabel: 'Open the reset requests'
      },
      vague: {
        subject: 'Someone is locked out and waiting',
        headline: 'A password reset is waiting',
        paragraphs: [
          'Somebody has asked for a password reset and is waiting to be let back in.',
          'Open the admin hub to see who.'
        ],
        ctaLabel: 'Open the reset requests'
      }
    }
  },

  feedback_submitted: {
    name: 'Problem or feedback reported',
    when: 'Somebody submits feedback or a bug report',
    audience: 'office',
    type: 'feedback_submitted',
    placeholders: [
      P('subjectLine', 'The subject line', 'Somebody reported a problem'),
      P('from', 'Who reported it, with their address', 'Mo Diallo (mo@example.com)'),
      P('kind', 'Feedback, or a problem', 'a problem'),
      P('message', 'What they said (free text, can name a patient)', 'The schedule shows the wrong time for Ada Bell.', { phi: true })
    ],
    variants: {
      detailed: {
        subject: '{{subjectLine}}',
        headline: '{{subjectLine}}',
        paragraphs: ['{{from}} reported {{kind}}.'],
        callout: '{{message}}',
        calloutLabel: 'What they said',
        ctaLabel: 'Open the inbox'
      },
      vague: {
        subject: '{{subjectLine}}',
        headline: '{{subjectLine}}',
        paragraphs: [
          'Somebody reported {{kind}}. Open the admin hub to read it.',
          'For privacy we do not put the report in email.'
        ],
        ctaLabel: 'Open the inbox'
      }
    }
  },

  caregiver_packet_submitted: {
    name: 'Welcome packet submitted',
    when: 'A caregiver completes and signs their welcome packet',
    audience: 'office',
    type: 'caregiver_packet_submitted',
    placeholders: [
      P('caregiverName', 'Which caregiver', 'Mo Diallo'),
      P('outstandingLine', 'What is still outstanding', '3 documents are still outstanding on their checklist.')
    ],
    variants: {
      detailed: {
        subject: 'Welcome packet submitted — {{caregiverName}}',
        headline: 'A caregiver finished their welcome packet',
        paragraphs: [
          '{{caregiverName}} has completed and signed their caregiver welcome packet.',
          '{{outstandingLine}}',
          'Their packet and checklist are in the admin hub.'
        ],
        ctaLabel: 'Open the caregiver queue'
      }
    }
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Reading

const has = (id) => Object.prototype.hasOwnProperty.call(REGISTRY, id);
const entry = (id) => (has(id) ? REGISTRY[id] : null);
const ids = () => Object.keys(REGISTRY);

/** Metadata for the editor. Never the overrides; the route merges those. */
const listNotices = () => ids().map(id => {
  const e = REGISTRY[id];
  return {
    id, name: e.name, when: e.when, audience: e.audience,
    audienceLabel: AUDIENCES[e.audience] || e.audience,
    type: e.type,
    variants: VARIANTS.filter(v => !!e.variants[v]),
    placeholders: e.placeholders.map(p => ({ ...p })),
    builtIn: VARIANTS.reduce((acc, v) => (e.variants[v] ? { ...acc, [v]: e.variants[v] } : acc), {})
  };
});

const phiKeys = (id) => new Set((entry(id) || { placeholders: [] }).placeholders.filter(p => p.phi).map(p => p.key));
const declaredKeys = (id) => new Set((entry(id) || { placeholders: [] }).placeholders.map(p => p.key));

// ──────────────────────────────────────────────────────────────────────────
// Validating an override

/**
 * Is this patch a legal override of this notice's variant?
 * Refuses by NAME. A silent drop is how somebody types a correction, sees
 * "saved", and finds the old wording still going out.
 */
function validateOverride(id, variant, patch) {
  const errors = [];
  const e = entry(id);
  if (!e) return { ok: false, errors: [{ code: 'UNKNOWN_NOTICE', message: `There is no email called "${id}".` }] };
  if (!VARIANTS.includes(variant)) {
    return { ok: false, errors: [{ code: 'UNKNOWN_VARIANT', message: `A notice has a "detailed" and a "vague" wording, not "${variant}".` }] };
  }
  if (!e.variants[variant]) {
    return { ok: false, errors: [{ code: 'VARIANT_NOT_USED', message: `"${e.name}" has no ${variant} wording to edit.` }] };
  }
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, errors: [{ code: 'PATCH_INVALID', message: 'Send the fields you changed as an object.' }] };
  }

  const declared = declaredKeys(id);
  const phi = phiKeys(id);
  const fields = Object.keys(patch);

  for (const f of fields) {
    if (!EDITABLE_FIELDS.includes(f)) {
      errors.push({ code: 'FIELD_NOT_EDITABLE', field: f,
        message: `"${f}" is not something you can edit here. You can edit: ${EDITABLE_FIELDS.join(', ')}.` });
    }
  }

  const strings = [];
  for (const f of EDITABLE_FIELDS) {
    if (!(f in patch)) continue;
    const v = patch[f];
    if (f === 'paragraphs') {
      if (!Array.isArray(v)) {
        errors.push({ code: 'PARAGRAPHS_INVALID', field: f, message: 'Paragraphs are a list, one entry per paragraph.' });
        continue;
      }
      if (v.length > MAX_PARAGRAPHS) {
        errors.push({ code: 'TOO_MANY_PARAGRAPHS', field: f, message: `That is more than ${MAX_PARAGRAPHS} paragraphs.` });
      }
      v.forEach((para, i) => {
        if (typeof para !== 'string') errors.push({ code: 'PARAGRAPH_INVALID', field: `${f}[${i}]`, message: 'A paragraph is text.' });
        else strings.push([`${f}[${i}]`, para]);
      });
      continue;
    }
    if (v === null) continue;                     // clearing an optional field
    if (typeof v !== 'string') {
      errors.push({ code: 'FIELD_INVALID', field: f, message: `"${f}" is text.` });
      continue;
    }
    strings.push([f, v]);
  }

  for (const [field, text] of strings) {
    if (text.length > MAX_FIELD) {
      errors.push({ code: 'TOO_LONG', field, message: `That is longer than ${MAX_FIELD} characters.` });
    }
    // The look of an email is set by the house template, so this field is for
    // words. Refusing markup here is belt and braces: `renderGfcEmail`
    // escapes it either way, which is what actually keeps it safe.
    if (/<\s*\/?[a-zA-Z]/.test(text)) {
      errors.push({ code: 'NO_MARKUP', field,
        message: 'This is for words, not HTML. The look of the email is set by the house template.' });
    }
    for (const key of placeholdersIn(text)) {
      if (!declared.has(key)) {
        errors.push({ code: 'UNKNOWN_PLACEHOLDER', field, placeholder: key,
          message: `There is no {{${key}}} on this email. You can use: ${[...declared].map(k => `{{${k}}}`).join(', ') || 'none'}.` });
        continue;
      }
      if (variant === 'vague' && phi.has(key)) {
        errors.push({ code: 'PHI_IN_VAGUE', field, placeholder: key,
          message: `{{${key}}} names the patient. This is the wording that sends when our email is not covered by a BAA, so it must say that something is waiting and nothing about what.` });
      }
      const decl = e.placeholders.find(p => p.key === key);
      if (decl && decl.bodyOnly && field === 'subject') {
        errors.push({ code: 'NOT_IN_SUBJECT', field, placeholder: key,
          message: `{{${key}}} must not go in a subject line.` });
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

// ──────────────────────────────────────────────────────────────────────────
// Resolving what actually sends

const EMPTY = Object.freeze({});

/**
 * The copy to send, with the data filled in.
 *
 * An override is applied FIELD BY FIELD over the built-in, so an admin who
 * changed only the subject keeps every improvement later made to the body.
 *
 * A broken override falls back to the built-in FOR THE WHOLE VARIANT, never
 * field by field: a subject and a body from two different generations of the
 * wording is worse than either on its own.
 */
function resolve(id, { variant = 'detailed', data = EMPTY, overrides = EMPTY } = {}) {
  const e = entry(id);
  if (!e) return { problems: [`unknown notice "${id}"`], usedFallback: true, missing: true };
  const useVariant = e.variants[variant] ? variant : 'detailed';
  const builtIn = e.variants[useVariant];

  const patch = (((overrides && overrides[id]) || EMPTY)[useVariant]) || null;
  const problems = [];
  let block = builtIn;

  if (patch) {
    const check = validateOverride(id, useVariant, patch);
    if (!check.ok) {
      // Stored but no longer legal: the registry changed under it, or a
      // backup was restored. Say so and send the built-in.
      problems.push(...check.errors.map(x => x.message));
    } else {
      block = { ...builtIn };
      for (const f of EDITABLE_FIELDS) {
        if (f in patch) block[f] = patch[f];
      }
    }
  }

  const out = {
    subject: fill(block.subject, data),
    headline: fill(block.headline, data),
    paragraphs: (Array.isArray(block.paragraphs) ? block.paragraphs : [])
      .map(p => fill(p, data))
      // A paragraph that reduces to nothing was a line about a value this
      // event does not have. Dropping it beats sending a blank one.
      .map(p => p.trim())
      .filter(Boolean),
    callout: block.callout ? fill(block.callout, data).trim() || null : null,
    calloutLabel: block.calloutLabel ? fill(block.calloutLabel, data).trim() || null : null,
    ctaLabel: block.ctaLabel ? fill(block.ctaLabel, data) : null,
    variant: useVariant,
    usedFallback: problems.length > 0,
    problems
  };
  // A callout with no text has no label either, or the email carries a
  // heading over nothing.
  if (!out.callout) out.calloutLabel = null;
  return out;
}

module.exports = {
  REGISTRY, VARIANTS, AUDIENCES, EDITABLE_FIELDS, MAX_FIELD, MAX_PARAGRAPHS,
  listNotices, ids, has, entry, resolve, validateOverride,
  fill, placeholdersIn, blockPlaceholders, phiKeys, declaredKeys
};
