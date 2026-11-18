# Policy & SOP Files shows who can open each linked file (2026-11-18)

**Owner report:** staff said Drive links in the app would not open, naming some Admin SOPs and Team Roles and Responsibilities, and asked whether it was a phone bug.

**What it was:** not the code and not the phone. All 25 linked files exist, none are trashed, and the live `document_links` store holds no overrides. Most of them were **Private** in Drive (owner only, Kate on a few). Staff sign in to Drive with their own Google accounts, many on personal Gmail, so they hit "You need access". On Android the link opens the Drive app, which shows the same wall; the My GFC Preview iframes Drive's `/preview`, which only renders a link-shared file.

**What changed:**
- `googledrive.getLinkSharing(fileId)` reads a file's trash flag and permission types as the impersonated owner.
- `documentLinks.sharingVerdict` / `checkSharing`: only "anyone with the link" reads as open. Domain-only is flagged, because personal-Gmail staff cannot use it. A failed read is `unknown`, never open. A row with two files (the Handbook) takes the worse of the two.
- `GET /api/onboarding/admin/document-links/sharing` (office), separate from the list so a slow Drive never holds the list up; 503 when Drive is not connected.
- Policy & SOP Files gains a Staff access column and a red count with the fix (Share → General access → Anyone with the link, Viewer). It re-checks after a link change, because a newly uploaded file does not inherit the old one's sharing (Manage versions does).

**Not changed:** the app still links straight to Drive. Proxying files through the app would keep them private but a .docx cannot be shown on a phone that way, so it was not built.
