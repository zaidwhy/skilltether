import assert from "node:assert/strict";
import { appendFileSync, existsSync, lstatSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { inflateRawSync } from "node:zlib";
import { makeHome, run, skillText, snapshot, tempDir, writeFile } from "./fixture.js";

const read = (p: string) => readFileSync(p, "utf8");

test("sync without --write prints the plan and changes nothing on disk", (t) => {
  const home = makeHome(t);
  const before = snapshot(home);
  const { code, out } = run(["sync", "--home", home]);
  assert.equal(code, 0);
  assert.match(out, /\+ link\s+alpha\s+~\/\.claude\/skills\/alpha/);
  assert.match(out, /\+ import\s+CLAUDE\.md\s+create with @\.\.\/\.agents\/AGENTS\.md/);
  assert.match(out, /\+ zip\s+beta\.zip/);
  assert.match(out, /Dry run: nothing changed\./);
  assert.deepEqual(snapshot(home), before);
});

test("sync --write builds every target and leaves files outside them alone", (t) => {
  const home = makeHome(t);
  const settings = read(join(home, ".claude/settings.json"));
  const accountSkill = read(join(home, ".claude/skills/synced/acct/SKILL.md"));

  const { code, out } = run(["sync", "--home", home, "--write"]);
  assert.equal(code, 0, out);
  assert.equal(read(join(home, ".claude/skills/alpha/SKILL.md")), read(join(home, ".agents/skills/alpha/SKILL.md")));
  assert.equal(read(join(home, ".claude/skills/beta/scripts/run.sh")), "echo beta\n");
  assert.equal(read(join(home, ".claude/CLAUDE.md")), "@../.agents/AGENTS.md\n");
  assert.equal(read(join(home, ".codex/AGENTS.md")), read(join(home, ".agents/AGENTS.md")));
  assert.ok(existsSync(join(home, ".agents/.skilltether/claude-desktop/alpha.zip")));
  assert.ok(existsSync(join(home, ".agents/.skilltether/claude-code.json")));
  assert.match(out, /upload the 2 new or changed zips/);

  assert.equal(read(join(home, ".claude/settings.json")), settings);
  assert.equal(read(join(home, ".claude/skills/synced/acct/SKILL.md")), accountSkill);

  const again = run(["sync", "--home", home]);
  assert.equal(again.code, 0);
  assert.match(again.out, /0 to write, 0 blocked/);
});

test("a hand edit in a copied skill blocks sync, names the file and shows the diff", (t) => {
  const home = makeHome(t);
  assert.equal(run(["sync", "--home", home, "--write", "--copy"]).code, 0);
  const target = join(home, ".claude/skills/alpha/SKILL.md");
  appendFileSync(target, "my local tweak\n");
  appendFileSync(join(home, ".agents/skills/alpha/SKILL.md"), "new upstream line\n");
  const before = snapshot(home);

  const { code, out } = run(["sync", "--home", home, "--write"]);
  assert.equal(code, 2);
  assert.match(out, /! blocked\s+alpha\s+hand-edited since the last sync/);
  assert.match(out, /~\/\.claude\/skills\/alpha\/SKILL\.md/);
  assert.match(out, /- my local tweak/);
  assert.match(out, /\+ new upstream line/);
  assert.match(out, /Refusing to write: 1 blocked/);
  assert.deepEqual(snapshot(home), before, "a blocked sync must write nothing at all");
});

test("--force overwrites the hand edit with the source", (t) => {
  const home = makeHome(t);
  run(["sync", "--home", home, "--write", "--copy"]);
  const target = join(home, ".claude/skills/alpha/SKILL.md");
  appendFileSync(target, "my local tweak\n");

  const { code, out } = run(["sync", "--home", home, "--write", "--copy", "--force"]);
  assert.equal(code, 0, out);
  assert.match(out, /\+ update\s+alpha\s+overwrites hand edits \(--force\)/);
  assert.equal(read(target), read(join(home, ".agents/skills/alpha/SKILL.md")));
});

test("status reports drift per target and exits 1", (t) => {
  const home = makeHome(t);
  run(["sync", "--home", home, "--write", "--copy"]);
  assert.equal(run(["status", "--home", home]).code, 0);

  appendFileSync(join(home, ".agents/skills/alpha/SKILL.md"), "changed at the source\n");
  appendFileSync(join(home, ".claude/skills/beta/SKILL.md"), "changed in the target\n");
  const { code, out } = run(["status", "--home", home]);
  assert.equal(code, 1);
  assert.match(out, /claude-code\s+1 stale, 1 blocked, 1 in sync/);
  assert.match(out, /\+ stale\s+alpha/);
  assert.match(out, /! blocked\s+beta\n\s+~\/\.claude\/skills\/beta\/SKILL\.md/);
  assert.match(out, /\+ zip out of date\s+alpha\.zip/);
  assert.match(out, /upload state unknown/);
});

test("when linking throws, sync copies instead and still guards the copy", (t) => {
  const home = makeHome(t);
  const refuse = () => {
    throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
  };
  const { code, out } = run(["sync", "--home", home, "--write"], refuse);
  assert.equal(code, 0, out);
  assert.match(out, /alpha: link failed \(EPERM\), copied instead/);
  const target = join(home, ".claude/skills/alpha");
  assert.equal(lstatSync(target).isSymbolicLink(), false);
  assert.equal(read(join(target, "SKILL.md")), read(join(home, ".agents/skills/alpha/SKILL.md")));
  const manifest = JSON.parse(read(join(home, ".agents/.skilltether/claude-code.json")));
  assert.equal(manifest.entries["skill:alpha"].mode, "copy");

  appendFileSync(join(target, "SKILL.md"), "edit\n");
  assert.equal(run(["sync", "--home", home, "--write"], refuse).code, 2);
});

test("an existing CLAUDE.md without the import blocks; --force prepends and keeps its text", (t) => {
  const home = makeHome(t);
  writeFile(join(home, ".claude/CLAUDE.md"), "Claude-only rule.\n");
  const blocked = run(["sync", "--home", home, "--write"]);
  assert.equal(blocked.code, 2);
  assert.match(blocked.out, /does not import AGENTS\.md; add the line @\.\.\/\.agents\/AGENTS\.md/);
  assert.equal(read(join(home, ".claude/CLAUDE.md")), "Claude-only rule.\n");

  assert.equal(run(["sync", "--home", home, "--write", "--force"]).code, 0);
  assert.equal(read(join(home, ".claude/CLAUDE.md")), "@../.agents/AGENTS.md\n\nClaude-only rule.\n");
});

test("an identical unmanaged copy is taken over; a different one blocks", (t) => {
  const home = makeHome(t);
  writeFile(join(home, ".claude/skills/alpha/SKILL.md"), read(join(home, ".agents/skills/alpha/SKILL.md")));
  writeFile(join(home, ".claude/skills/beta/SKILL.md"), skillText("beta", "Someone else's beta."));
  const { code, out } = run(["sync", "--home", home]);
  assert.equal(code, 2);
  assert.match(out, /\+ relink\s+alpha\s+identical copy already there/);
  assert.match(out, /! blocked\s+beta\s+exists and was not written by skilltether/);
  assert.match(out, /- description: Someone else's beta\./);
});

test("a skill deleted from the source is removed from targets it was synced to", (t) => {
  const home = makeHome(t);
  run(["sync", "--home", home, "--write"]);
  rmSync(join(home, ".agents/skills/beta"), { recursive: true });
  const { code, out } = run(["sync", "--home", home, "--write"]);
  assert.equal(code, 0, out);
  assert.match(out, /- remove\s+beta\s+gone from the source/);
  assert.equal(existsSync(join(home, ".claude/skills/beta")), false);
  assert.equal(existsSync(join(home, ".agents/.skilltether/claude-desktop/beta.zip")), false);
  assert.ok(existsSync(join(home, ".claude/skills/alpha/SKILL.md")));
});

test("Desktop zips put the skill folder at the top level and skip names upload rejects", (t) => {
  const home = makeHome(t);
  writeFile(join(home, ".agents/skills/claude-helper/SKILL.md"), skillText("claude-helper", "Helps."));
  writeFile(join(home, ".agents/skills/alpha/.claude-plugin/plugin.json"), "{}\n");
  const { out } = run(["sync", "--home", home, "--write"]);
  assert.match(out, /~ skip\s+claude-helper\.zip\s+upload would be rejected: name contains reserved word "claude"/);
  assert.equal(existsSync(join(home, ".agents/.skilltether/claude-desktop/claude-helper.zip")), false);

  const zip = readFileSync(join(home, ".agents/.skilltether/claude-desktop/alpha.zip"));
  const names: string[] = [];
  let offset = 0;
  let skillMd: Buffer | undefined;
  while (zip.readUInt32LE(offset) === 0x04034b50) {
    const packedSize = zip.readUInt32LE(offset + 18);
    const nameLength = zip.readUInt16LE(offset + 26);
    const name = zip.subarray(offset + 30, offset + 30 + nameLength).toString("utf8");
    const body = zip.subarray(offset + 30 + nameLength, offset + 30 + nameLength + packedSize);
    if (name === "alpha/SKILL.md") skillMd = inflateRawSync(body);
    names.push(name);
    offset += 30 + nameLength + packedSize;
  }
  assert.deepEqual(names, ["alpha/SKILL.md"]);
  assert.equal(skillMd?.toString("utf8"), read(join(home, ".agents/skills/alpha/SKILL.md")));
});

test("project scope links .claude/skills, imports the root AGENTS.md and writes nothing for Codex", (t) => {
  const root = tempDir(t, "skilltether-repo-");
  writeFile(join(root, ".agents/skills/alpha/SKILL.md"), skillText("alpha", "Alpha. Use when testing."));
  writeFile(join(root, "AGENTS.md"), "# Repo rules\n");

  const { code, out } = run(["sync", "--root", root, "--write"]);
  assert.equal(code, 0, out);
  assert.match(out, /= native\s+AGENTS\.md\s+Codex reads the repo AGENTS\.md itself/);
  assert.equal(read(join(root, ".claude/skills/alpha/SKILL.md")), read(join(root, ".agents/skills/alpha/SKILL.md")));
  assert.equal(read(join(root, "CLAUDE.md")), "@AGENTS.md\n");
  assert.equal(existsSync(join(root, ".codex")), false);
});

test("unknown options are refused with the option named", () => {
  const { code, out } = run(["sync", "--wrte"]);
  assert.equal(code, 64);
  assert.match(out, /unknown option --wrte/);
});
