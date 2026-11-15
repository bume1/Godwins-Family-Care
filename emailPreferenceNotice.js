// ============================================================================
// WHEN SOMEONE UNSUBSCRIBES, THE OFFICE IS TOLD (owner, 2026-11-10)
// ============================================================================
// "I need to know if someone unsubscribes." An unsubscribe from the email
// footer used to flip `emailUnsubscribed` and tell nobody. From then on that
// person gets no announcements, reminders, shift notices or onboarding
// nudges, and the office found out only when something went unread.
//
// Now every active Super Admin is emailed when someone unsubscribes or turns
// email back on, with who and when, and a button to User Management.
//
// The person's name is in the BODY only, never the subject, and the notice is
// marked PHI: the person may be a client or family member, and a client's
// name is PHI (the 2026-10 staff-notice lesson). Only a real change sends a
// notice; clicking the same link twice says nothing new.
//
// Pure: builds the notices; server.js queues them.
// ============================================================================

'use strict';

const TYPE = 'email_preference_changed';

const KIND_LABEL = Object.freeze({
  admin: 'staff', user: 'staff', caseManager: 'staff', liaison: 'staff', manager: 'staff',
  vendor: 'caregiver', client: 'client', family: 'family member'
});

const fmtWhen = (iso) => new Date(iso).toLocaleString('en-US', {
  timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit'
});

/**
 * The notices to queue, one per Super Admin, or none.
 * → [{ type, userId, email, name, data, options }]
 */
function noticesFor({ person, unsubscribed, users, at, ctaUrl }) {
  if (!person) return [];
  const who = person.name || person.email || 'A user';
  const kind = KIND_LABEL[person.role] || 'user';
  const when = fmtWhen(at || new Date().toISOString());
  const body = unsubscribed
    ? `${who} (${kind}, ${person.email || 'no email on file'}) unsubscribed from automated GFC emails on ${when} Eastern.\n\n`
      + 'From now on they get no announcements, reminders, shift notices, onboarding emails or other automated emails from the app.\n\n'
      + 'If they still need those emails, check with them, then turn email back on in User Management.'
    : `${who} (${kind}, ${person.email || 'no email on file'}) turned automated GFC emails back on, on ${when} Eastern. They will get app emails again.`;
  return (users || [])
    .filter(u => u && u.role === 'admin' && u.email && u.accountStatus !== 'inactive' && String(u.id) !== String(person.id))
    .map(a => ({
      type: TYPE, userId: a.id, email: a.email, name: a.name || a.email,
      data: {
        subject: unsubscribed ? 'Someone unsubscribed from GFC emails' : 'Someone turned GFC emails back on',
        body, ctaUrl, ctaLabel: 'Open User Management'
      },
      options: { relatedEntityId: `${person.id}:${unsubscribed ? 'off' : 'on'}:${at}`, relatedEntityType: 'user', phi: true, createdBy: 'system' }
    }));
}

module.exports = { TYPE, noticesFor };
