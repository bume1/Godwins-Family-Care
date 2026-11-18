# Employee feature video: a recording harness (owner request, 2026-11-18)

Owner asked for a product feature video for employees, starting with My GFC, then onboarding, home care management and the clinical workspace.

- `scripts/demo/` records the REAL app in Chromium with an in-memory store and made-up people. Nothing touches a real database, OpenEMR, Drive or email. TEST DATA ONLY; no real PHI may ever be seeded into it.
- `demo_env.js` boots `server.js` on port 4777 with `MFA_ENFORCE=false` and a memory KV, and clears the forced first-login password change on demo accounts only.
- `browser.js` serves every outside file (React, Babel, fonts, icons) from a curl cache, so the browser never trusts the proxy and certificate checks stay on.
- `director.js` adds a visible pointer, a caption bar and title cards, since Playwright's video shows no cursor.
- `scene1_my_gfc.js` is Part 1 (sign-in and the My GFC tour). Run `node scripts/demo/scene1_my_gfc.js <outDir>`, then convert the webm with ffmpeg (libx264, yuv420p).
- Videos are output files, never committed.
- Open for the owner: Part 2 (onboarding) needs the office to start a checklist for a demo employee; Part 4 (clinical) needs a fake OpenEMR, which `scripts/verify_note_lifecycle.js` already shows how to build.
