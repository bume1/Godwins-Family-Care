# Google Drive — putting document storage back on AWS

_Last updated: 2026-09-13_

**Read this first:** every file upload in the app is broken on AWS right now,
and the fix below is the only thing that repairs it. Nothing in the app works
around it, and retrying an upload will never succeed until this is done.

---

## What is broken, and why

Drive used to authenticate through a **Replit connector**. `googledrive.js`
read `REPLIT_CONNECTORS_HOSTNAME` and `REPL_IDENTITY` and asked Replit's API for
an access token.

The app is on AWS. Those variables do not exist there, so the very first line
threw — before any request ever reached Google. Every upload route caught the
throw and returned:

> "We could not store that file. Please try again, or send it to your care team."

That message is honest but misleading in one way: **trying again cannot help.**
It is not a network blip.

### Everything it took down

One module handles all file storage, so all of it failed together:

| What | Who noticed |
|---|---|
| Client document uploads (photo ID, insurance card, advance directive) | The client, on the Documents tab |
| Caregiver documents (timesheets, certificates) | New — see below |
| Care plan PDFs filing to Drive | Nobody — it fails quietly behind a warning |
| Transfer-of-Care ROI PDFs | Staff, when the provider packet never appeared |
| Executed consent copies | On download |
| Offline packet scans in the admin hub | Whoever was filing the seven legacy packets |
| Reading any of the above back | Anyone opening a stored file |

**One thing was working correctly:** a failed upload is **refused**, not
recorded. The app never wrote a row pointing at a file that does not exist. A
client who saw the error genuinely did not send the file — which is the safe
failure, and the one to preserve.

---

## The fix

Drive now uses the **same Google service account the mailer already uses**, with
the Drive scope added to the delegation you already granted for Gmail. One
credential, one Admin console screen, one more scope.

There is no new secret to create if Gmail is already live. You are adding a
scope and sharing a folder.

---

## Setup — about 15 minutes, all in Google admin

Nothing here is done from the app.

### 1. Enable the Drive API on the existing project

Google Cloud console → the project you created for Gmail sending → **APIs &
Services** → **Enable APIs** → enable **Google Drive API**.

If you also want the Transfer-of-Care ROI's parallel Google Sheet logging to
keep working, enable **Google Sheets API** here too. It is optional — without
it only that Sheet logging fails, never a document upload.

### 2. Add the Drive scope to the existing domain-wide delegation

Google **Admin** console → **Security** → **Access and data control** → **API
controls** → **Manage Domain Wide Delegation**.

Find the entry for the service account's **Client ID** (the one you added for
Gmail). **Edit** it and make the scope list read:

```
https://www.googleapis.com/auth/gmail.send,https://www.googleapis.com/auth/drive
```

Add `,https://www.googleapis.com/auth/spreadsheets` on the end if you enabled
the Sheets API in step 1.

> **Replace the whole list, do not add a second entry.** Delegation is one row
> per client ID, and saving a scope list overwrites what was there. If you paste
> only the Drive scope, **email stops working** — Gmail's scope has to stay in
> the same line.

Save. Google applies delegation changes within a few minutes, occasionally up to
an hour.

### 3. Decide where the files live, and share it

The service account impersonates a real user and files land in **that user's
Drive**. Two options:

**Option A — a Shared Drive (recommended).**
Create a Shared Drive called **GFC Documents**. Add the service account's
address (`...@....iam.gserviceaccount.com`, on the service account's details
page) as a **Content manager**. Open the Shared Drive and copy the id out of the
URL — `drive.google.com/drive/folders/`**`0ABCdef...`**.

Better because the *organisation* owns the files. If the impersonated user's
account is ever deleted, the documents survive.

**Option B — a folder in admin@'s Drive.**
Create a folder called **GFC Documents**, share it with the service account
address as **Editor**, and copy the folder id from the URL.

Works, but the files are owned by that person, not the company.

### 4. Set the environment variables

In AWS Secrets Manager, alongside the ones Gmail already uses:

| Variable | Value |
|---|---|
| `GOOGLE_SERVICE_ACCOUNT_KEY` | **Already set** for Gmail. Unchanged. |
| `GOOGLE_DRIVE_IMPERSONATE` | The licensed user to act as, e.g. `admin@godwinsfamilycarellc.com`. **Optional** — falls back to `GMAIL_SEND_AS`, which is almost certainly the same account. |
| `GOOGLE_DRIVE_FOLDER_ID` | The id from step 3. Everything nests inside it. |

Restart the app.

> `GOOGLE_DRIVE_IMPERSONATE` must be a **real licensed Workspace user** — the
> same rule as `GMAIL_SEND_AS`. A Google Group or a bare alias cannot be
> impersonated. `support@` is an alias here, which is why the mailer sends as
> `admin@`; use the same account.

### 5. Prove it

```
node scripts/verify_drive_access.js
```

It uploads a real file, lists it, reads the bytes back and compares them, then
deletes it. It reports the service account, who it impersonated, and which
folder it wrote to.

**Do not treat the boot log as proof.** The boot log says the credential parses
and a subject is configured. Only this script proves Google accepted it — the
same distinction that let a narrowed OAuth token sit behind a green "OpenEMR
connected" for weeks.

---

## When it goes wrong

**First: read what the screen says now.** As of 2026-09-13 a failed upload or
download shown to an **administrator** carries Google's actual reason plus the
setup step that fixes it. A caregiver still sees a plain message, because
Google's errors name file ids and accounts they cannot act on. If you are
signed in as admin and still see only one sentence, the deployment is running
older code.

The failure messages Google returns are accurate and tell you nothing about what
to fix. These are the three that actually happen:

**`unauthorized_client`** — delegation is not granted for the Drive scope.
Step 2 was missed, saved without the Drive scope, or has not propagated yet.
Wait ten minutes and re-check the scope list is **both** scopes on one line.

**`invalid_grant`** — the impersonation subject is not a real licensed mailbox.
Check `GOOGLE_DRIVE_IMPERSONATE` (or `GMAIL_SEND_AS`) names a licensed user, not
an alias or a group.

**`File not found` on a folder you can see** — the service account has not been
added to the Shared Drive, or `GOOGLE_DRIVE_FOLDER_ID` points at a folder it was
never shared with. Step 3.

**`Service Accounts do not have storage quota`** — the impersonation subject is
missing entirely, so the service account tried to own the file itself. Set
`GOOGLE_DRIVE_IMPERSONATE`.

---

## Caregiver document upload (new, 2026-09-13)

Caregivers had no way to send a file at all, so a paper timesheet arrived by
text message or not at all. They can now upload: **timesheet · signed visit
note · mileage or expense log · certification or licence · other**, with an
optional pay-period start and end.

Three decisions worth knowing:

- **Filed under the CAREGIVER, never a client.** A timesheet routinely covers
  several clients in one week. Filing it against one of them would file it wrong
  *and* put it where that client's care team can read it.
- **A caregiver sees only their own.** Admin sees everyone's and can filter to
  one person; a caregiver cannot widen their view by passing someone else's id.
- **Rejecting one requires a reason, and the caregiver is told what it was.** A
  caregiver told only "not accepted" re-sends the same blurry photo.

**Payroll onboarding paperwork lives here too** — photo ID, paystub and W-9.
Admin files it from **User Management → edit the caregiver → Documents**, and
it appears in that caregiver's own app. **Gusto is where payroll paperwork is
actually submitted.** What the app holds is the office's copy; nothing here
sends anything to Gusto.

This needs no extra Google setup. The files go to a **GFC Caregiver Documents**
folder inside whatever you configured above, created on first upload.

---

## What is deliberately unchanged

- **PHI files are never link-shared.** No "anyone with link" grant is created
  unless `DRIVE_ALLOW_ANYONE_LINK=true`, which is off and must stay off with
  real data. Files are read back through the app so every read is audited.
- **A Drive failure still fails the upload.** It is never recorded as received.
- **The Replit code path is gone, not disabled.** The platform is AWS; a branch
  that can never run is not a fallback, it is a place for a future session to be
  misled about what is supported.
