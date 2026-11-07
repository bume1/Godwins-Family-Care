# 25 MB, and files into the office's own Drive structure

**2026-11-07, owner-directed.** *"Increase file size max to 25 MB and I want
these files to upload to the appropriate onboarding folder in our drive
according to our new Google Drive structure."*

## The ceiling is one number now

It was 10 MB in config, and three other places had their own idea:

- The clinician proof route built multer with its own **15 MB literal** while
  the shared preparer read the configured 10 MB. **The stricter of two ceilings
  always wins silently and always reports the wrong reason** — multer would
  have refused a 20 MB file the preparer would have taken, citing a limit
  nobody set. multer is built inside the factory from `config.MAX_FILE_SIZE`
  now; the one remaining literal is a fallback for a caller wiring no config.
- Three messages in `server.js` said *"File exceeds 10 MB limit."* and would
  now be lying to somebody holding a 20 MB file the app accepts.

**Checked, not assumed:** a 25 MB file reaches the caregiver door as ~33.4 MB
of base64 in a JSON body; the body parser allows 50 MB, so it fits. A test pins
that relationship, because raising the ceiling again could silently break it.

⚠️ It also broke a test harness in a way worth keeping: `drive_storage.test.js`
carried its own 20 MB JSON limit, so base64 of an oversize file was rejected by
the **harness** with 413 before the route's size check ran — the test proved
nothing about the check it was written for. **A harness stricter than
production exercises a different function.**

## ⚠️ `06 People` IS NOT ONE FOLDER

Read out of the office's live Drive, 2026-11-07:

```
06 People
├── Onboarding Library      ← the READING pack: Clinician (W2) | (1099) | (Hybrid)
├── Training                → Clinician
├── Credentialing & Licensure   Bethel Godwins, FNP · Protocol Agreements (NPA)
│                               Payer and Vendor Enrollment · Playbooks
├── Personnel Files         → GFC Caregiver Documents  ← the app's folder, already moved here
├── Contracts & Offer Letters   Kathryn Strickland · offer letters · agreements
└── Recruiting
```

Two findings that decide the design:

1. **`GFC Caregiver Documents` already sits inside `Personnel Files`.** The app
   finds it by name wherever it is, so caregiver uploads have been landing in
   the new structure already.
2. **`Onboarding Library / Clinician (W2|1099|Hybrid)` is the pack a new
   clinician OPENS**, not where her documents go. Dropping a licence scan there
   would put a personal document in the folder the whole team reads from.
   Build-enforced that it is never a destination.

## Sorted by what the document is

| Document | Folder |
|---|---|
| Offer, engagement letter, employment agreement, ICA, scope letter, NDA | **Contracts & Offer Letters** |
| I-9, W-4, direct deposit, W-9, handbook, code of conduct, HIPAA training, emergency contact; and the whole employment arrangement (W2/1099/Hybrid blocks) | **Personnel Files** |
| Licence, DEA, board certification, NPI, malpractice, background check, and every clinical block | **Credentialing & Licensure** |

Routed **by block, with named exceptions**, because `CORE` is the one block
that splits: the offer is a contract, the I-9 is personnel. The mapping is one
table in `staffDocuments.js`.

**The default is Credentialing & Licensure, the most restricted of the three**,
so an item whose home nobody has decided lands somewhere narrower than it needs
rather than wider. `CORE-16` (FCRA background check) takes that default
deliberately — the office already files its FCRA forms there.

Per-person subfolders are named as the office already names them: `Thanmayie
Rao, FNP-BC` where a credential is on file, the plain name otherwise. A blank
name is **refused**, or every unnamed person shares one folder.

## ⚠️ BY FOLDER ID, NEVER BY NAME

Every other upload in this app calls `findOrCreateFolder(name, …)`, which
creates the folder when it is missing. Pointed at `06 People` that would
**build a second one at the root of whatever account the service identity
impersonates, and nobody would look in it.** So the three section ids are
config (`DRIVE_FOLDERS`, env-overridable), `uploadStaffDocumentFile` proves the
section folder opens **before** anything is written, and a wrong id fails by
name (`DRIVE_SECTION_FOLDER_UNREACHABLE`) rather than as a confusing permission
error. Only the **person's own** subfolder is created, because that is new
every time somebody joins.

A folder it cannot reach **refuses the upload**, the same rule as a Drive
outage: better no row than a credentialing item ticked against a file nobody
can find. With no id configured at all it falls back to the old caregiver
folder and **logs why** — not silently.

**No anyone-link.** These are a person's licence, ID and tax forms; they are
read back through the app, where the read is audited.

The row records where it went (`drive_section`, `drive_folder`), so the office
can see the folder without opening Drive — and a later session can tell a file
filed under the new structure from one filed before it existed.

## Verified

86 tests in the file, suite **3236, 0 failing**. **13 of 13 mutations caught** —
everything dumped in one folder, the I-9 routed as a credential, the default
widened, a blank name becoming one shared folder, a name climbing out of its
folder, the section folder created by name, a wrong id no longer failing by
name, an anyone-link added, the reading library made a destination, an id
hardcoded outside config, and the row no longer saying where it went. (One
reported a harness escaping error and was redone by reading the real line out
of the file rather than hand-escaping it.)

The routing is **driven end to end** with a fake Drive — a licence to
Credentialing, an I-9 to Personnel, through the same route — because a source
scan cannot show which folder a file reached.

**Also fixed on the way:** the test harness passed `config: {}`, so the route
took the unconfigured fallback and was exercising a different path from
production. It uses the real config now.

## Not proven here, stated plainly

**That the app's service identity can open these folders.** Drive is not
configured in this sandbox, and the ids were read through the owner's own
session, not the app's. The app impersonates `GOOGLE_DRIVE_IMPERSONATE`
(falling back to `GMAIL_SEND_AS`), so it should see what that account sees —
but only a live upload proves it. Run `scripts/verify_drive_access.js` on the
deployment, then file one real document and look for it in
`06 People / Credentialing & Licensure`.

## Open for the owner

1. **Confirm the three-way split is what you want.** It follows your own folder
   names, but it does mean one clinician's documents live in three folders. One
   table in `staffDocuments.js` changes it.
2. **Per-person folder naming.** Your Drive has both `Bethel Godwins, FNP` and
   `Kathryn Strickland`. The app appends a credential where it holds one.
3. **Sharing.** `Personnel Files` will now receive I-9s and photo IDs from the
   app. Check who that folder is shared with before the first real upload.
