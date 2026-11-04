# The admin hub went blank: one fix merged twice

Owner report, 2026-11-04: a blank screen on the admin hub right after #234 merged.

- **Cause:** #234 and #235 each fixed the same User Management crash by declaring `financialPending` and `loadFinancial` in `UsersPage`. Each PR was correct on its own. Merged together, the component declared both twice, and the browser's Babel refused the whole admin hub script ("Identifier 'financialPending' has already been declared"). A refused script renders nothing, so the screen was blank.
- **Fix:** removed #234's copy and kept #235's, which sits beside the rest of `UsersPage`'s loaders.
- **Guard:** `test/pages_compile.test.js` compiles every page's `text/babel` scripts with `@babel/standalone` (preset react), the same compiler the browser uses. It fails on the broken `main` and passes on the fix. It includes a self-check that a duplicate declaration really does throw, so the test cannot pass vacuously. `@babel/standalone` is a devDependency only, and the image installs with `--omit=dev`.
- **Lesson:** two sessions fixing the same reported bug in parallel will collide. When an owner bug report is being worked, check open PRs for the same file before opening another.
- **Verified:** full suite 2,988 passing and 0 failing. **Live only after the container is rebuilt.**
