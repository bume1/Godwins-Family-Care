# Enrollment in the clinical workspace sidebar (2026-10-14)

Owner request: "add an enrollment button to the left panel area, under Reports, in the clinical workspace."

- **The Enrollment entry sits directly under Reports** in the sidebar, in `NAV_VIEWS`. Because it comes from that one list, it also shows under More on a phone.
- **It opens the existing page, `/admin/enrollment`.** It does not create a workspace view. The entry carries `href`, and the click handler leaves the workspace for it.
- **Access is unchanged.** The enrollment page decides who may read it and who may edit it. Nothing about who can see enrollment moved.
- **The old "Staff Tools → Enrollment" button in Settings stays.** It now does the same thing as the sidebar entry.
- **Verified:**
  - The repointed nav test asserts the entry sits under Reports and that the page link navigates.
  - A mutation removing the entry is caught.
  - Full suite: 2,471 tests, 0 failing.
  - The page compiles.
