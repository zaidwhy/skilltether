# skilltether handoff (2026-11-10)

State: pushed to private zaidwhy/skilltether. 21 tests. Answers claude-code #31005 and #20697.

Live test 2026-11-10: read-only doctor/init/sync/status on the real home (28 skills, 27 to adopt, 0 conflicts); in a probe project, `sync --project --write` made a Windows junction and a CLAUDE.md `@AGENTS.md` import, and a real `claude -p` session with file tools disabled listed the skill and knew the AGENTS.md codename. Not verified: Codex (its login had expired) and Claude Desktop (no API; zips are uploaded by hand). Real-home `sync --write` not run: Zaid decides. The dry run flagged 4 skills Claude Desktop would reject (claude-api, fable, refine-repo, linkedin-auto-post-2.0).
Next: Zaid runs it on his setup; npm publish is his call (outward-facing).

Published to npm 2026-11-10: skilltether 0.1.0 (maintainer zaidwhy); `npx skilltether@0.1.0 --help` verified from a clean directory.

Unreleased on main: `status` says "zip not built" instead of "zip out of date" for zips that never existed. Ship as 0.1.1 with `npm version patch` + `npm publish --auth-type=web` when wanted.
