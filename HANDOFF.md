# skilltether handoff (2026-11-10)

State: pushed to zaidwhy/skilltether (public since 2026-11-10). 22 tests. Answers claude-code #31005 and #20697.

Live test 2026-11-10: read-only doctor/init/sync/status on the real home (28 skills, 27 to adopt, 0 conflicts); in a probe project, `sync --project --write` made a Windows junction and a CLAUDE.md `@AGENTS.md` import, and a real `claude -p` session with file tools disabled listed the skill and knew the AGENTS.md codename. Not verified: Codex (its login had expired) and Claude Desktop (no API; zips are uploaded by hand). Real-home `sync --write` not run: Zaid decides. The dry run flagged 4 skills Claude Desktop would reject (claude-api, fable, refine-repo, linkedin-auto-post-2.0).
Next: Zaid runs it on his setup; npm publish is his call (outward-facing).

Published to npm 2026-11-10: skilltether 0.1.0 (maintainer zaidwhy); `npx skilltether@0.1.0 --help` verified from a clean directory.

Released 2026-11-10: skilltether 0.1.1 on npm (`status` says "zip not built" for zips that never existed). Ready to publish: 0.1.2 (adds `repository`, `homepage` and `bugs` to package.json, nothing else). Tag `v0.1.2` is on the bump commit. Zaid runs `npm publish --auth-type=web` in his own terminal; npm serves 0.1.1 until then.

Tag note: v0.1.1 on GitHub points at 570d410 (version bump); npm 0.1.1 is built from the next commit, which only makes `--version` read package.json. Not retagged because that needs a force-push.
