# Decision notes — one file per change

Each branch records what it locked in as **its own new file** in this folder. It does not edit `CLAUDE.md` or `docs/GFC_SESSION_PLAN.md`.

**Why:** every branch used to add its notes at the same few lines of `CLAUDE.md`: the "Last updated" line, "Current session focus", the status table and the top of "Recent decisions". Two branches open at once always clashed there, and each merge broke the next PR. New files never clash.

## How to write one

- Name: `YYYY-MM-DD-short-slug.md`, for example `2026-09-30-portal-calendar.md`.
- Start with a one-line title and the owner request it answers.
- Then bullets: what was decided, what a later session must not undo, how it was verified, and what is open for the owner.
- Write it in the same style as the "Recent decisions" entries in `CLAUDE.md`.

## Reading them

Read the newest files here first (`ls -t docs/decisions/`). They are newer than anything under "Recent decisions" in `CLAUDE.md`.

## Folding them in

After PRs merge, one docs-only PR updates `CLAUDE.md` and `docs/GFC_SESSION_PLAN.md`: the status table, merged PR numbers, "Current session focus" and the "Last updated" line. It may also move the must-not-undo points from these files into `CLAUDE.md`. That PR is the only place those shared lines change.
