# A full chart review was cut off at the output limit

Owner report, 2026-11-04, on the first live review: "Model call failed: the answer was cut off at the output limit".

- **Cause:** the input was fine but the *answer* outgrew Gemini's default output limit. No `maxOutputTokens` was set, and `VERTEX_INPUT_TOKEN_LIMIT` is unset, so the whole chart went in one pass and produced one very long answer.
- **Explicit limit:** the transport now always sends `maxOutputTokens`, defaulting to 65,535 (`DEFAULT_MAX_OUTPUT_TOKENS`, the Gemini Flash maximum). It is never the model default.
- **Retry smaller:** `modelEngine` keeps the provider's reason on `err.causeCode`. When a review pass is cut off (`MODEL_FINISH_MAX_TOKENS`), the review restarts with twice as many passes, up to 16, and only while the chart can actually be split further. Any other failure fails at once.
- **Merge fallback:** if the merge call itself is cut off, `chartPacket.joinPassOutputs` joins the passes in code. Nothing is de-duplicated and nothing is dropped. Urgent findings come first, the timeline is sorted by date, and every citation is still enforced afterwards.
- **Never silent:** a chart that cannot be split further still fails with the same named message, never a truncated answer.
- **Verified:** the review job is lifted out of `server.js` and run against a fake engine: one pass cut off becomes two passes and finishes, a cut-off merge joins, and an unsplittable chart fails by name. Three mutations each caught. Full suite 2,997 passing and 0 failing. **Not proven here:** a live review, so run one after the rebuild.
