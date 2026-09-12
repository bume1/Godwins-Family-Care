# Email transport — switching the app to Google Workspace

_Last updated: 2026-09-10_

## Why

The app has always sent email through **Resend**. Resend is a third-party relay
and **there is no BAA with them**. That is why every email the app sends today
is deliberately PHI-free — the enrollment receipt, the ROI confirmation, the
document reminder all say "open your portal" rather than saying anything about
the person's health. The constraint was real, and the code comment at the ROI
admin email has flagged it since Session 3.4.

GFC already holds a **Google Workspace BAA** (it is what covers Drive for
consents and care plans). Gmail is inside that same BAA. Moving the mailer onto
Workspace puts email inside the compliance boundary and lets a notification say
something useful — a visit date, a clinician's name — instead of only pointing
at the portal.

## What "BAA-covered" means here, precisely

The BAA covers a **Workspace domain**, not "Google" in general. A personal
`@gmail.com` mailbox is Google and is **not** covered. So the app checks the
**sending address**, not the transport's name:

- `no-reply@godwinsfamilycarellc.com` → covered, PHI permitted.
- `godwinsfamilycare@gmail.com` → **not** covered. The app refuses to treat it
  as a PHI-capable sender and falls back rather than sending.

The list of covered domains is `EMAIL_BAA_DOMAINS`, defaulting to
`godwinsfamilycarellc.com`.

## The setup — about 20 minutes, mostly in Workspace admin

This is an admin task, not a code task. Nothing below is done from the app.

**1. Create a Google Cloud project and a service account**

- In the Google Cloud console, create (or reuse) a project.
- Enable the **Gmail API** on it.
- Create a **service account**. No project roles are needed.
- Create a **JSON key** for it and download the file.
- On the service account's details page, copy its **Unique ID** (a long number,
  sometimes called the Client ID). You need it in the next step.

**2. Grant it domain-wide delegation in Workspace admin**

- Google Workspace admin → **Security → Access and data control → API controls
  → Domain-wide delegation → Add new**.
- **Client ID**: the service account's Unique ID from step 1.
- **OAuth scope**: `https://www.googleapis.com/auth/gmail.send`
  — this scope only permits sending. It grants no ability to read any mailbox.
- Save.

**3. Pick the mailbox it sends as**

Two different addresses, doing two different jobs:

| | Address | What it is |
|---|---|---|
| `GMAIL_SEND_AS` | `no-reply@godwinsfamilycarellc.com` | who the mail is **from** |
| `ORG_SUPPORT_EMAIL` | `support@godwinsfamilycarellc.com` | where a **reply** goes |

Every message goes out from no-reply@ and carries `Reply-To: support@`, so a
client who hits Reply reaches the support queue rather than a mailbox nobody
watches. Both transports produce the identical pair, so this does not change
when you switch from Resend to Workspace.

**`GMAIL_SEND_AS` must be a REAL, LICENSED WORKSPACE USER.** This is the single
most likely thing to cost you a cycle, and no-reply@ is exactly the kind of
address that gets set up as something else:

- A **Google Group** cannot be impersonated. Delegation signs in *as* an
  account, and a group is not an account.
- A **bare alias** on another mailbox cannot either — the alias is not itself
  an account.

If no-reply@ is currently a group or an alias, either create it as a real user
(it needs a licence, and nobody ever has to sign in to it) or set
`GMAIL_SEND_AS` to a mailbox that is one. Getting this wrong produces
`invalid_grant`, which the app translates for you at step 6.

`support@` has no such constraint. It is only a header, so it can be a group,
an alias, or a shared inbox — whatever your team actually reads.

**4. Set two environment variables on the deployment**

```
GOOGLE_SERVICE_ACCOUNT_KEY=<contents of the JSON key file>
GMAIL_SEND_AS=no-reply@godwinsfamilycarellc.com
```

`ORG_SUPPORT_EMAIL` defaults to `support@godwinsfamilycarellc.com` and only
needs setting if you want replies somewhere else.

`GOOGLE_SERVICE_ACCOUNT_KEY` takes the raw JSON, or the same JSON base64-encoded
if the hosting panel mangles multi-line values. Both are accepted.

Restart the app.

**5. Confirm it took**

The boot log now says which mailer is live:

```
📧 Email: gmail as Godwins Family Care <no-reply@godwinsfamilycarellc.com> — BAA-covered, PHI permitted
```

Then send real mail and confirm it arrives:

```
node scripts/verify_email_transport.js you@godwinsfamilycarellc.com
```

That sends four messages (plain+HTML, one with a PDF attached, and two as a
batch) and reports what the provider accepted. **Accepted is not the same as
delivered** — open the inbox and confirm all four arrived, and check spam.

## Rollback

Set `EMAIL_TRANSPORT=resend` and restart. Resend stays fully wired; nothing was
removed. Clearing `GMAIL_SEND_AS` has the same effect, since `auto` falls back.

## What changes for the app once Workspace is live

| | Resend (today) | Workspace |
|---|---|---|
| Non-PHI mail | sends | sends |
| Mail marked `{ phi: true }` | **refused**, with `EMAIL_PHI_TRANSPORT_BLOCKED` | sends |
| Attachments | yes | yes |
| Batch sends | one API call per 100 | one message at a time |
| Inside the BAA | no | yes |
| From / Reply-To | no-reply@ / support@ | no-reply@ / support@ (identical) |

A message marked as carrying PHI is **refused, never downgraded**. The caller is
the only place that knows what to cut, so silently stripping detail would be the
wrong fix — and a silent success is the exact failure mode that cost this repo
five defects on the OpenEMR side.

## Volume

Workspace allows roughly 2,000 recipients per day per mailbox, and the Gmail API
is not a bulk sender. The app's own ceiling (`NOTIFICATION_DAILY_SEND_LIMIT`) is
500/day, well inside that. If GFC ever needs true bulk mail — a newsletter to
every family, say — that belongs on a separate non-PHI path, not on this one.

## What is proven, and what is not

- **Proven** in `test/email_transport.test.js` (24 tests, each mutation-checked
  so a broken guard actually fails the build): the message the app builds is a
  valid RFC 2822 message, decoded back rather than string-matched — headers,
  multipart structure, attachment bytes byte-for-byte, UTF-8 subjects, and
  header-injection through a subject line. Plus the transport-selection matrix
  and the PHI gate.
- **Not proven anywhere but on the deployment**: that Google accepts and
  delivers it. That needs live credentials. It is step 5 above.
