# The provider Release of Information copy prints one copy per provider

Owner, 2026-10-28: "the roi wizard produces just ONE pdf copy per provider." Owner chose to split the enrollment consent's copy per provider, leaving the consent wording and signature as they are.

- The enrollment-wizard consent "Release of Information — Providers" (`roiProvider`) printed ONE combined copy listing every prior provider. A page faxed to one office named all the others.
- Its signed copy (portal, staff, enrollment packet ZIP, blank copy for a paper signature) now prints one copy per named provider. Each copy names only its own provider, which is what the wording already says ("Complete one page for each provider"). One copy can still run to two pages, because the consent wording is long.
- The same office listed twice (spelling, case, spacing) is one copy; blank rows are dropped. One or no provider is one copy, as before. No other consent splits. `pdf-generator.js` `consentProviderCopies()`.
- Unchanged: the per-provider Transfer-of-Care release from the record release form (portal or upload link), which was already one PDF per provider and merges duplicate providers within a submission.
- Verified: 2 tests in `test/roi_rebuild.test.js` (the split, and a two-provider copy rendering exactly twice the pages of a one-provider copy), both fail when the split is switched off; `scripts/verify_46_consents.js` 64/64; full suite green.
