# My GFC, the staff portal

Owner, 2026-11-08: staff get a portal of their own, the counterpart of the patient portal. It holds their onboarding, their documents, the policies they work under, and the Drive folders their role needs. Ms. Godwins should be able to sign into the app and reach the files she needs, scoped to her permissions.

## What changed

- **`/my` (`public/my.html`)** is for **every employee**, scoped by role. It has seven sections: Home, Onboarding, My Documents, Policies, Shared Folders, Hours & Pay and Account. The admin team gets a seventh, Team Bios. It uses the sidebar layout on desktop and a bottom menu on a phone.
- **`routes/staffPortal.js`** serves `/api/my/*`. It is open to the eight staff account types and refuses clients and family (`STAFF_PORTAL_STAFF_ONLY`).
- **Ways in:**
  - The clinical workspace's "My Onboarding" button became **My Portal**.
  - The caregiver app's More tab has a **My GFC** button.
  - The Portal Hub shows a **My GFC** tile first for admins, managers and coordinators.
  - Office staff still reach Staff Onboarding through People.
- **`googledrive.listFolderChildren(folderId)`** lists one level of a folder.

## Shared Folders, and why Drive stays the gate

- An admin pastes a Drive folder link, names it, and picks who sees it: whole roles, named people, or both. Rows live in `staff_portal_folders` (registered, not PHI).
- The app checks the link is a real folder it can open before saving it, so a typo never becomes a tile that fails for everyone.
- A person sees only folders assigned to them. Browsing down is checked step by step: each subfolder must be a child of the one above it, so passing another folder's id is refused (`FOLDER_OUTSIDE_SCOPE`).
- **⚠️ A SHARED FILE OPENS IN DRIVE UNDER THE PERSON'S OWN GOOGLE SIGN-IN. THE APP NEVER STREAMS ONE.** Streaming through the service account would make its access everyone's access. So Drive's own sharing is still the gate on every file, and the app is a scoped map to it. Build-enforced.
- The folder must be shared with the GFC admin Google account so the app can list it.

## Other sections

- **My Documents has two parts** (owner, 2026-11-08: signed documents must not stay inside onboarding, which is for tracking):
  - **What You Signed** lists each policy acknowledgment at its version and date, linked to the canonical copy. An older version reads as superseded. A caregiver also sees her signed welcome packet and in-app attestations.
  - **Files on Record** lists everything in `caregiver_documents` under this person, named by the onboarding item it answered. Another person's file reads as absent (404). No Drive id reaches the browser.
- **Policies is the LIVE library** (owner, revised 2026-11-08):
  - Each policy a person works under is listed by role. Clinicians get the Clinical P&P, the admin team the Administrative P&P, and field staff the Field Addendum.
  - Each one always opens the canonical copy in Policies / Current, which the office updates in place. It can be previewed in Drive's own viewer or opened in Drive.
  - A policy updated since the person signed it says so.
  - Signed copies are not kept here; they are in My Documents.
- **Hours & Pay:**
  - **Pay stubs come from the payroll Apps Script.** It POSTs to `/api/payroll/paystubs` with `X-GFC-Payroll-Key`, which must equal `PAYROLL_INGEST_KEY`. Without that variable the door answers 503 and stores nothing.
  - Each person is matched by sign-in email. A stub carries the pay date, period, gross, net and hours, plus a PDF sent as bytes (filed in the person's role folder) or as a Drive file id.
  - The same person, pay date and reference replace an earlier stub rather than doubling it. Rows the app cannot place are returned to the script with the reason.
  - `scripts/payroll_paystubs.gs` is the starter the owner pastes in.
  - Caregivers also see their clocked hours.
- **Account:**
  - Each person uploads a **headshot** (JPG or PNG, typed by its bytes) and writes a **title and bio** for the website (`staff_profiles`).
  - The **admin team**, meaning administrators, managers and care coordinators, reads everyone's in Team Bios and can download photos.
  - Sign-in and security still link to `/account`.
- **Who counts as the admin team:** administrators, managers and care coordinators manage shared folders and read Team Bios. Folder assignment has quick picks for "Admin team", "All clinicians" and "Caregivers".
- **Onboarding** shows progress and links to `/onboarding`.

## What a later session must not undo

- **No route under `/api/my/folders` may send file bytes.**
- **The pay stub door stays shut without `PAYROLL_INGEST_KEY`,** and the key is compared in constant time.
- **Every folder step is verified against Drive's own parent listing.**
- `/api/my` is a PHI-prefix audit path: who opened which document or folder is recorded.

## Verified

- `test/staff_portal.test.js`: 14 tests through the real router.
- Seven mutations, each caught:
  - folder path verification dropped
  - the audience check always true
  - the payroll key check skipped
  - the shut door opened
  - another person's pay stubs shown
  - a headshot accepted that is not an image
  - a signed acknowledgment dropped
- Full suite: 3247 passing, 0 failing.
- Rendered in Chromium (documents, hours, account and team bios) at 1280px and 390px. No page errors.

## Not proven here

- That Google lists a real folder for the service account. The first folder an admin adds proves it, because the add is refused if Drive cannot open the folder.
- A live run of the payroll script. Its first run returns `stored`, `updated` and `skipped` counts.

## Open for the owner

1. **Set `PAYROLL_INGEST_KEY`** on the deployment, and the same value in the Apps Script's properties.
2. **Moving the caregiver app into My GFC.** For now it links across.
3. **Which folders each role gets.** That is an admin setup task in the portal.

## The caregiver app became the caregiver's My GFC (owner, 2026-11-08)

- **`/caregiver` is a caregiver's My GFC.** It uses the same frame as everyone's: the patient-portal look, a white sidebar on a computer and a white bottom menu on a phone. The sections are:
  - Home, Schedule, Clients, Feed and Logs & Messages
  - Onboarding (the welcome packet checklist)
  - My Documents (what they signed, plus the office upload they always had)
  - Policies, Shared Folders, Hours & Pay, and Account
- **The phone menu fits five buttons:** Home, Schedule, Clients and Feed, which are used every shift, plus More. More leads to everything else.
- **Moved, not rewritten.** Clock-in and clock-out, the visit-log-before-clock-out rule, the offline queue, the welcome packet gate, the schedule component and messaging are the same code.
- A caregiver who opens `/my` is sent to `/caregiver` with the same `#section`.
- Shift emails (`/caregiver#schedule`) and message emails (`/caregiver#more`) still land where they did.
- **One shared file, `public/my-gfc.js`,** holds the frame and the staff sections for both pages. It runs in its own scope as `window.MyGFC`, and every class it styles starts with `mg-`, so neither page's styles can restyle the other's.
- Rendered in Chromium at 1280px and 390px as a caregiver: Home, My Documents, Hours & Pay, More and Schedule. No page errors.

## Who lands where, and the Community Care Liaison (owner, 2026-11-08)

- **Caregivers** land in My GFC, which is `/caregiver`.
- **Clinicians** (provider, RN, LCSW, LMSW / case manager) land in the clinical workspace. **My GFC is a sidebar item** above Settings, and is in the phone's More menu.
- **Admins, managers and care coordinators** land on the Portal Hub, where the My GFC tile comes first.
- **Community Care Liaison** is a new account type:
  - **It is its own role, `liaison`.** No existing gate admits it, because `user` would have been enrollment staff and clinical everywhere.
  - A liaison lands straight in My GFC. There are no hub tiles and no clinical workspace.
  - They use **two-step sign-in**, because they read client names and enrollment status. `liaison` is on `MFA_REQUIRED_ROLES_FLOOR`.
  - They get every My GFC section except Logs & Messages.
  - **My Clients** lists only the clients assigned to them on their account. Assignment uses the same `assignedClients` list a caregiver's uses, ticked under "Liaison's Clients" on the user form. Only an admin creates a liaison.
  - For each client they see the **enrollment summary only** (`liaisonEnrollmentView` in `server.js`): status, how complete, and which forms and details are still needed. They never see the intake answers, the chart or a document.
  - Liaison uploads land in `GFC Community Care Liaison Documents`.
