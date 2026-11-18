# Onboarding: drag-and-drop reorder, and editing a task's files

**Date:** 2026-11-18 · **Owner:**
- "this reorg button is a nuisance for the onboarding phases... needs to be more user friendly and modern"
- "we should be able to edit files too on these onboarding tasks", for admins and managers

## Reorder
- **The up and down arrows on every row are gone.** Each phase has one **Reorder** button.
- Reorder opens a drag-and-drop list: grip handles, numbered rows, and a gold highlight where the task will land.
- **It saves as you drop** and says "Saved". **Done** returns to the checklist.
- **Keyboard users** focus a handle and press the up or down arrow.
- **One save per phase:** `PUT /api/onboarding/admin/phases/:phaseId/order` with `{ chapter, userId, ids }`.
  - A task from another phase is refused (`ORDER_MISMATCH`).
  - Tasks not sent keep their places after the ones that were.
  - The order applies to everyone on that checklist.
- **The welcome packet task stays first.**
- The one-task-at-a-time `/move` route is removed, since nothing calls it now.

## Editing files on a task (admins and managers)
- Each file on a task gets three buttons: **Rename**, **Replace** (upload a new copy and take the old one off) and **Remove** (asks first).
- **Rename** also renames the copy on their Staff Record.
- **Remove** takes the file off the task only. The record keeps who removed it, and their Staff Record Documents keep the copy. Deleting it outright stays the Super Admin's, from the Staff Record.
- **Routes:** `PUT` and `DELETE /api/onboarding/admin/people/:userId/items/:itemId/files/:fileId`.
- **Not covered:** welcome packet files and signed forms. They are reviewed with Accept or Send Back, as before.

## Verified
- `test/onboarding_reorganize.test.js`, now 7 tests.
- Full suite passing.
- Chromium:
  - dragged the third task to the top and it saved
  - the file buttons appear on a task
