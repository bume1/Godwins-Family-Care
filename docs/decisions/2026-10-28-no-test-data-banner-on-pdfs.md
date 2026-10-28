# No "test data" or review banner on any PDF

Owner, 2026-10-28: "make sure the pdf removes that 'this is test data' line."

- Staff copies of signed consents (the Release of Information to providers among them) and the staff enrollment packet printed "INTERNAL COPY — counsel and licensure review still open. Test data until HIPAA-live." The client's own copies never did (Scope E2).
- Staff copies get faxed and handed to providers, so the line is gone from every PDF. The `internal` option and both call sites in `server.js` are removed.
- The review status still shows on the admin enrollment screen (`CONSENT_REVIEW_BANNER`), which is the only place it belongs.
- The provider ROI form PDF (`generateProviderROIPDF`) never carried the line; checked by rendering one and reading the text back.
- `test/consent_registry.test.js` now fails if any PDF draws the banner or any caller asks for it.
