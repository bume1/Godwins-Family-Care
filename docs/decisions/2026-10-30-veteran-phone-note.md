# Veterans (IME): the "no mobile number" note names only the chosen provider (owner, 2026-10-30)

The owner's report: adding a veteran showed a note listing every care team member with no phone on file.

- **Admin hub:** the Add Veteran form now shows the note only for the provider picked, and only when that provider has no mobile number.
- **Clinical workspace:** a provider sees the note only about their own record. Admins see no list.
- **Nothing about who is texted changed.** The app has only ever texted the one assigned provider, and only when their veteran signs in.
- **Verified:** rendered in Chromium. No note before a provider is picked, a note for a provider without a number, and none for a provider with one. Full suite passes.
