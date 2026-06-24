---
name: CDN Babel version pinning
description: Why the in-browser Babel CDN must be version-pinned in this app's HTML pages
---

# Pin in-browser Babel (and CDN libs) to a major version

The frontend is React-via-CDN with JSX transformed in-browser by `@babel/standalone`.
All `public/*.html` pages must load Babel pinned to v7, e.g.
`https://unpkg.com/@babel/standalone@7/babel.min.js` — never the unpinned
`@babel/standalone/babel.min.js`.

**Why:** unpkg's unpinned "latest" rolled forward to Babel 8, whose parser change
threw `Unexpected token '{'. import call expects one or two arguments.` while
transforming the app scripts. That aborts the transform, React never mounts, and
every page renders as a blank gradient. The app code was unchanged — the CDN moved.

**How to apply:** if pages suddenly render blank with a Babel parse/import error in
the console, check the Babel CDN URL first. Keep all HTML pages pinned to the same
major. Same caution applies to other unpinned CDN libs (React is pinned to `@18`).
