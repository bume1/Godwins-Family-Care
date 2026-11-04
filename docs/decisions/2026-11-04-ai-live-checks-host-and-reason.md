# The daily Google checks could never pass on location "us", and hid why

Owner report, 2026-11-04: with every Vertex setting in place, both Google-side checks read "could not be completed".

- **The caching check called a host that does not exist.** It built `https://${location}-aiplatform.googleapis.com`, which for `VERTEX_LOCATION=us` is `us-aiplatform…`. The cacheConfig resource is project-wide but served only on a regional host. A multi-region location now goes to `us-central1`, the host Google's own instructions use. An explicit region (for example `us-east4`) is used as given.
- **Both checks threw Google's reason away.** Each failure now ends with "Google said: <status> <message>", run through `modelEngine.scrubForLog` and capped at 300 characters, so a missing permission and an unreachable host read differently.
- **Expected next finding, not fixed in code:** the setup guide grants the app's service account *Storage Object Admin* on the staging bucket. That role has no `storage.buckets.get`, which the bucket check needs to read location, public-access and lifecycle settings. If the bucket check now says "403 … storage.buckets.get", grant *Storage Legacy Bucket Reader* on that bucket too.
- **Verified:** two new tests in `test/vertex_transport.test.js` (the host for `us`, and the reason carried and scrubbed). Mutation-checked: reverting the host mapping fails the test. Full suite 2,990 passing and 0 failing. **Not proven here:** Google's answer from the live server.
