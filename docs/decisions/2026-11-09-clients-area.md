# One standalone Clients area

**Date:** 2026-11-09 · **Owner-directed**

**The problem.** The Portal Hub's Clients area had two links, Enrollment and "Client & Family Accounts". The second was the Admin Hub's User Management with a clients filter. It read as an odd version of User Management, and clicking any other Admin Hub tab lost it.

**The owner's choice.** One Clients area, carrying every detail and action the User Management client view had.

## What changed
- **`/clients` is the Clients page.** It is the enrollment view, grown.
  - `/admin/enrollment` redirects to it and keeps `?client=`, so links in sent emails still work.
  - The Portal Hub's Clients area is one tile.
- **Top of the page:**
  - Add Client (the quick account)
  - Full Face Sheet (the paper-packet path)
  - Add Family Contact
  - Export
  - Bulk Reset (Super Admin)
  - the pay and rate queue (client rows)
  - the possible-POA-logins panel (Super Admin)
- **Tabs:**
  - Clients: the enrollment list, plus a Login column
  - Family & Contacts
  - Sign-ups
  - Password Resets (Super Admin, client and family requests only)
- **Each client is one record.** A section menu jumps to:
  - **Account & Login:**
    - name, email, phone
    - active or inactive, email opt-out
    - portal name, URL and earlier addresses
    - photo
    - enrollment status
    - "login used by the POA" and the move to the POA
    - project access
    - account recovery (Super Admin)
    - delete (Super Admin)
  - **Care Team.**
  - **Family & Contacts:**
    - each contact's relationship and POA
    - remove the link
    - link an existing family account
    - add a new contact
    - family invites
  - **Then the existing enrollment record**, unchanged.
- **The address carries where you are** (`?client=`, `?family=`, `?tab=`), so the browser's back button and reloading both land in the right place.

## Must not undo
- **One copy.** `public/client-account-ui.js` holds the client and family account pieces. The Admin Hub reads the POA dialog and the pay and rate queue from it.
- **User Management is our team.**
  - A client or family row opens `/clients`.
  - Its account-type picker no longer offers Client or Family, and the old client and family form blocks are gone, so there are never two editors.
  - `?group=clients` redirects to `/clients`.
- **Every save sends only its own keys.** `PUT /api/users/:id` keeps any key a body leaves out. No server API changed.
- **Who can do what:**
  - The account sections are the office's (admin, manager, care coordinator), the same gate as the user list.
  - Account recovery and delete are the Super Admin's.
  - Clinical staff and case managers still read the enrollment record as before.

## Verified
- `test/clients_area.test.js`: 7 tests, including a checklist of every carried-over detail; 7 of 7 mutations caught.
- 13 existing tests were repointed to the pieces' new home.
- Full suite 3461, 0 failing.
- **Against the real server in Chromium, at 1440 and 390:**
  - the list, the Family tab and a full client record
  - a name and care-team edit survived a reload
  - a family contact was added from the record
  - a quick client was added and opened
  - the old address redirected with its deep link
  - no page errors

## Follow-up: User Management is internal staff only (owner, same day)
- Client and family accounts no longer appear in User Management at all, under any filter, rather than appearing as rows that link out.
- The same holds for its count, its export and its Password Resets tab. A manager or coordinator sees caregivers there.
- Bulk Reset there resets staff only. The server's `'users'` type now leaves out family as well as clients. Clients and family are reset from the Clients page.
- The full user list is still loaded, because the caregiver and liaison client pickers read it. Only what the page shows is filtered.
- Verified:
  - 7 of 7 mutations caught
  - in Chromium against the real server, no client or family row under any filter, and the count matches the staff accounts
