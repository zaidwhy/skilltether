# skilltether

Keep one `.agents/` folder as the source of truth for your agent skills and instructions, and tether Claude Code, Codex and Claude Desktop to it. Every write is planned first and shown to you; nothing you edited by hand is ever overwritten without `--force`.

## Thesis

- **Data:** plain files. The source is `~/.agents/skills/` plus `~/.agents/AGENTS.md` (user scope) or `<repo>/.agents/skills/` plus `<repo>/AGENTS.md` (project scope). Per target, one small JSON manifest in `.agents/.skilltether/` records the source path and content hash of everything skilltether wrote. Nothing outside the configured targets is touched.
- **Failure mode 1: silently overwriting a hand edit in a target.** Guarded by the manifest and by dry run as the default. A copied file whose hash no longer matches what skilltether wrote blocks the whole run; the path and a short diff are printed, and nothing is written until you resolve it or pass `--force`.
- **Failure mode 2: a skill valid for one tool but rejected or truncated by another.** Guarded by `doctor`, which checks every skill against each tool's rules (required fields, name charset, length caps, reserved words) and cites the document or source file each rule came from. `sync` will not zip a skill the Claude upload dialog would reject.
- **Opinion: import, do not duplicate.** Instructions live once, in `AGENTS.md`. Claude Code gets a `CLAUDE.md` whose only job is the line `@AGENTS.md`, because Claude Code expands `@path` imports. Skills are linked, not copied, wherever the OS allows it.

## Why it exists

Two open requests on `anthropics/claude-code`:

- [#31005 Support for AGENTS.md and .agents/skills/](https://github.com/anthropics/claude-code/issues/31005). Claude Code v2.1.277 reads `AGENTS.md` when there is no `CLAUDE.md`, but it still does not read `.agents/skills/`, and its docs list no user-level location for `AGENTS.md` (`~/.agents/AGENTS.md` is not read). The thread's workarounds are a whole-folder symlink (`ln -s ~/.agents/skills ~/.claude/skills`), per-skill symlinks, and a one-line `CLAUDE.md` containing `@AGENTS.md`.
- [#20697 Sync Skills between Claude Desktop and Claude Code CLI](https://github.com/anthropics/claude-code/issues/20697). Desktop and claude.ai take skills only as uploaded zips; users report rebuilding zips by hand after every edit, upload rejections, and drift they could only find with home-made hash scripts.

What breaks with the plain workarounds, and what skilltether does instead:

| Workaround | What breaks | skilltether |
|---|---|---|
| `ln -s ~/.agents/skills ~/.claude/skills` | Claude Code owns entries in that folder (`synced/` holds account-synced skills), so they leak into the shared source, or the link replaces them | one link per skill; `synced` and dot folders are never touched |
| symlinks on Windows | file symlinks need Developer Mode | directory junctions for skills (no admin needed); a guarded copy for files |
| copying files | copies drift and edits get lost | content-hash manifest; a hand edit blocks the sync |
| zipping for Desktop | wrong layout, plugin manifest inside, names the uploader rejects | `<name>/SKILL.md` at the top level, `.claude-plugin/plugin.json` left out, rejected names skipped with the reason |

## Install

Not on npm yet. The name `skilltether` was free on both npm and PyPI when checked on 2026-11-09 (the working folder is `agent-sync`). From a clone:

```
npm install
npm run build
node dist/src/cli.js --help
```

Once published it runs as `npx skilltether <command>`. Node 20 or later, no runtime dependencies.

## What gets written where

| Target | User scope | Project scope |
|---|---|---|
| Claude Code skills | `~/.claude/skills/<name>`, one link (or guarded copy) per skill | `.claude/skills/<name>` |
| Claude Code instructions | `~/.claude/CLAUDE.md` containing `@../.agents/AGENTS.md` | `CLAUDE.md` containing `@AGENTS.md` |
| Codex skills | nothing: Codex reads `~/.agents/skills` itself | nothing: Codex reads `.agents/skills` itself |
| Codex instructions | `~/.codex/AGENTS.md` (or `$CODEX_HOME`), linked or copied | nothing: Codex reads the repo `AGENTS.md` |
| Claude Desktop | `~/.agents/.skilltether/claude-desktop/<name>.zip` | `.agents/.skilltether/claude-desktop/<name>.zip` |

At project scope the instructions file is the repo-root `AGENTS.md`, not `.agents/AGENTS.md`, because the root is where Codex, Claude Code and the other agents already look; moving it would force a copy.

## Output from a real run

A temp home with two skills in `~/.agents/skills`, one older skill in `~/.claude/skills`, and an `AGENTS.md`. After `skilltether init --write` adopted the older skill into the source:

```
$ npx skilltether sync
skilltether sync | user scope | dry run (pass --write to apply)
source  ~/.agents/skills  3 skills, ~/.agents/AGENTS.md present

claude-code
  + takeover old-helper               identical copy already there
  + add      pdf-forms                ~/.claude/skills/pdf-forms
  + add      release-notes            ~/.claude/skills/release-notes
  + import   CLAUDE.md                create with @../.agents/AGENTS.md
codex
  = native   skills                   Codex reads .agents/skills itself; nothing to write
  + add      AGENTS.md                ~/.codex/AGENTS.md
claude-desktop
  ~ skip     old-helper.zip           upload would be rejected: description is required for upload
  + zip      pdf-forms.zip            new; upload it once
  + zip      release-notes.zip        new; upload it once

7 to write, 0 blocked, 1 skipped, 0 already in sync.
Dry run: nothing changed.
```

Then `sync --write --copy`, a hand edit to `~/.claude/skills/pdf-forms/SKILL.md`, and a separate edit to the source:

```
$ npx skilltether status
skilltether status | user scope
source  ~/.agents/skills  3 skills, ~/.agents/AGENTS.md present

claude-code     3 in sync, 1 blocked
  ! blocked              pdf-forms
      ~/.claude/skills/pdf-forms/SKILL.md
codex           1 in sync
claude-desktop  1 zip out of date, 1 in sync
  + zip out of date      pdf-forms.zip
  upload state unknown: Claude Desktop exposes no API to compare against

2 items out of sync. Run: skilltether sync

$ npx skilltether sync --write
...
claude-code
  ! blocked  pdf-forms                hand-edited since the last sync
             ~/.claude/skills/pdf-forms/SKILL.md
               - Use pdfplumber instead.
               + Never fill a signed form.
...
1 to write, 1 blocked, 1 skipped, 5 already in sync.
Refusing to write: 1 blocked. Resolve them or rerun with --force.
```

`-` lines are yours and would be lost; `+` lines come from the source.

## Commands

| Command | Does | Exit code |
|---|---|---|
| `init` | Finds skills in `~/.claude/skills` and `~/.codex/skills` (or `.claude/skills` in a project) and copies new ones into the source. Reports a skill that differs from the source copy, and a name whose copies disagree, without adopting either. Adopts an existing `~/.codex/AGENTS.md` or `CLAUDE.md` when the source has no `AGENTS.md`. Reads targets only. | 0 |
| `sync` | Prints the plan for every target. `--write` applies it, all or nothing: one blocked item stops the run. | 0, or 2 when anything is blocked |
| `status` | Drift per target: missing, stale, unmanaged copy, orphaned, blocked, zip out of date. | 0 in sync, 1 drift |
| `doctor` | Checks each skill against every tool's rules. `--dir <path>` checks any skills folder, for example `~/.claude/skills` before `init`. | 0, or 1 on any error |

Options: `--project` or `--root <dir>` for project scope, `--write`, `--force`, `--copy` (never link), `--home <dir>` to point at another home directory.

## Rules `doctor` enforces

| Tool | Rule | Source |
|---|---|---|
| Agent Skills spec (the shared format) | `name` required, 1-64 chars of `a-z 0-9 -`, no leading, trailing or double hyphen, matches its folder; `description` required, at most 1024; `compatibility` at most 500; body under 500 lines advised | [agentskills.io/specification](https://agentskills.io/specification) |
| Codex | frontmatter required; `description` non-empty; `name` (defaults to the folder) at most 64 | [codex-rs/skills/src/parser.rs](https://github.com/openai/codex/blob/main/codex-rs/skills/src/parser.rs) |
| Codex instructions | `AGENTS.md` over 32 KiB is cut at `project_doc_max_bytes` | [Codex AGENTS.md docs](https://learn.chatgpt.com/docs/agent-configuration/agents-md) |
| Claude Code | folder `synced` and `anthropic-skills` reserved; no `<`, `>` or control characters in the name; `description` plus `when_to_use` truncated at 1536 in the listing; unknown fields ignored without an error | [code.claude.com/docs/en/skills](https://code.claude.com/docs/en/skills) |
| Claude Desktop / claude.ai upload | `name` required, at most 64 lowercase letters, digits and hyphens, no `anthropic` or `claude`, no XML tags; `description` required, at most 1024, no XML tags | [Agent Skills overview](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview) |

Run against a copy of a real 36-skill setup, `doctor` found 7 errors in 5 skills, for example `claude-api` (reserved word for upload) and `linkedin-auto-post-2.0` (a `.` in the name, which the spec and the uploader both refuse while Claude Code loads it without complaint).

## What it cannot do

- **Upload to Claude Desktop or claude.ai.** There is no public API for account skills, and skilltether will not drive a login or a private endpoint. It builds the zips, tells you which ones changed, and you upload them in Customize > Skills. For the same reason it cannot tell whether an upload is current; `status` says so.
- **Reach Cowork through the CLAUDE.md import.** Claude Code skips user-scope imports that point outside the working directory in Cowork sessions, per its memory docs.
- **Link files on Windows without Developer Mode.** Skill folders become junctions, which need no admin rights; `~/.codex/AGENTS.md` becomes a copy, and the manifest guards it like any other copy.
- **Override Codex's `AGENTS.override.md`.** When that file is non-empty Codex reads it instead of `AGENTS.md`; `sync` notes it and leaves it alone.
- **Watch for changes.** Linked targets need no re-sync; copies and zips update when you run `sync --write`.
- **Sync commands, subagents, hooks or MCP config.** Skills and instructions only.
- **Parse all of YAML.** The frontmatter reader handles top-level keys, quoted strings, folded and literal blocks and nested maps, which covers every SKILL.md it was tried on, not the full spec.

## Development

```
npm test        # tsc, then node --test over dist/test
```

The tests run the CLI in-process against temp directories and assert on what a user sees: the printed plan, exit codes, files on disk, and files that must stay untouched.

## License

MIT
