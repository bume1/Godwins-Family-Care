# Sign in with a phone number, hear from us by text (2026-11-18)

**Owner ask:** "For clients like Ms. Dorothy that don't use email, but have a phone number, can we make it where a phone number OR email is needed? And that those who don't have emails get notifications of updates via text message instead? Down to the reset links?"

## What changed

- **`loginPhone` on a client or family account.** The sign-in box takes an email or a phone number (`phoneLogin.findByIdentifier`). A phone number is matched only against `loginPhone`, never a contact phone on a record, so a number on a profile is never quietly a way in. One number, one login. Staff keep email (MFA and every staff notice assume an inbox).
- **No email still means a placeholder address under the hood.** A phone sign-in keeps `email = …@placeholder.local`, so nothing that keys on email changes. `noLogin` now means "placeholder AND no phone sign-in".
- **Notices go by text when there is no inbox.** `queueNotification` checks `textInPlaceOfEmail` before the placeholder skip, so every notice that goes through the queue is covered with one check. The text is fixed and PHI-free ("You have a new update in your portal. Sign in to see it: <link>"). Only the link reaches it, never the email's wording. Same cooldown as email, quiet hours (9pm to 8am Eastern) from the existing Quo outbox, one waiting text per person so a burst overnight is one text at 8am. The two notices that bypass the queue (statements, enrollment complete) call the same helper.
- **Password links by text.** Forgot Password takes an email or phone. A phone number typed means a text, to the number on the account only. Token rules are `passwordSetLinks.js`'s, unchanged: 1 hour (24 for office-sent), one use, 3 per hour, only the hash stored. If the text does not leave (Quo not set up, or refused), the request goes to the office Inbox as before. Office "Reset link" buttons text it when the person has no email. "Your password was changed" also goes by text, with no link.
- **⚠️ A reset text is never stored.** The outbox keeps a SHA-256 of the words, not the words, so the Quo webhook for our own send is still recognised as ours and is never recorded into a Care Team thread as "a reply typed in the Quo app". The row is written before the send, so a webhook that beats our write still finds it.
- **Welcome by text.** Creating a phone sign-in account texts a 24-hour link to choose their own password. No password is ever texted.
- **Replies are recognised.** `quoSms.matchPhone` knows a sign-in phone, so Ms. Dorothy texting back lands in her Care Team thread.
- **Screens:** Add a Client ("No email" → "They sign in with their mobile number"), Add a Family Contact ("No email" checkbox), a "Sign In by Phone" block on every client and family record, and a "Text Reset Link" button where there is no email.

## Judgement calls, flag for the owner

1. **Update texts go without a separate opt-in.** The house rule for Care Team message texts is "only after they turn texts on". A phone sign-in has chosen text as their only channel, so update notices go unless they reply STOP or switch texts off in the portal. The first text says "Reply STOP to stop texts." Care Team message *content* by text still needs the opt-in, unchanged.
2. **Update texts say nothing specific.** Not "your visit is tomorrow", only "you have an update". A text sits on a lock screen anyone can read. Visit reminders could carry the time later if wanted.
3. **A reset link the person asked for goes even if they said STOP.** They asked for it on screen just now. Carriers may still block it, in which case the office request is filed.
4. **Bulk password reset skips phone sign-ins** (it emails temporary passwords). Reset them one at a time from their record.

## Needs to be live

`QUO_API_KEY` must be set on the deployment (it already is for Care Team texts). Texts go from the Care Team line.
