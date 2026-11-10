import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { makeHome, run, skillText, snapshot, writeFile } from "./fixture.js";

function homeWithStrays(t: Parameters<typeof makeHome>[0]): string {
  const home = makeHome(t);
  writeFile(join(home, ".claude/skills/gamma/SKILL.md"), skillText("gamma", "Gamma."));
  writeFile(join(home, ".claude/skills/alpha/SKILL.md"), skillText("alpha", "A diverged alpha."));
  writeFile(join(home, ".codex/skills/delta/SKILL.md"), skillText("delta", "Delta."));
  writeFile(join(home, ".codex/skills/.system/skill-creator/SKILL.md"), skillText("skill-creator", "Bundled."));
  writeFile(join(home, ".claude/skills/eps/SKILL.md"), skillText("eps", "Claude's eps."));
  writeFile(join(home, ".codex/skills/eps/SKILL.md"), skillText("eps", "Codex's eps."));
  return home;
}

test("init dry run lists adoptions and conflicts and writes nothing", (t) => {
  const home = homeWithStrays(t);
  const before = snapshot(home);
  const { code, out } = run(["init", "--home", home]);
  assert.equal(code, 0);
  assert.match(out, /\+ adopt\s+gamma\s+from ~\/\.claude\/skills\/gamma/);
  assert.match(out, /\+ adopt\s+delta\s+from ~\/\.codex\/skills\/delta/);
  assert.match(out, /! differs\s+alpha\s+differs from the source copy/);
  assert.match(out, /! clash\s+eps\s+copies disagree/);
  assert.doesNotMatch(out, /acct|skill-creator/);
  assert.match(out, /2 to adopt, 0 already in the source, 2 conflicts/);
  assert.deepEqual(snapshot(home), before);
});

test("init --write copies new skills into the source and leaves targets as they were", (t) => {
  const home = homeWithStrays(t);
  const claudeBefore = snapshot(join(home, ".claude"));
  const { code } = run(["init", "--home", home, "--write"]);
  assert.equal(code, 0);
  assert.equal(readFileSync(join(home, ".agents/skills/gamma/SKILL.md"), "utf8"), skillText("gamma", "Gamma."));
  assert.ok(existsSync(join(home, ".agents/skills/delta/SKILL.md")));
  assert.equal(existsSync(join(home, ".agents/skills/eps")), false, "a clash is never adopted");
  assert.equal(readFileSync(join(home, ".agents/skills/alpha/SKILL.md"), "utf8").includes("diverged"), false);
  assert.deepEqual(snapshot(join(home, ".claude")), claudeBefore);
});

test("init adopts the only instruction file when the source has no AGENTS.md", (t) => {
  const home = makeHome(t);
  writeFile(join(home, ".agents/AGENTS.md"), "");
  const fresh = join(home, "fresh");
  writeFile(join(fresh, ".codex/AGENTS.md"), "# Codex rules\n");
  const { out } = run(["init", "--home", fresh, "--write"]);
  assert.match(out, /\+ adopt\s+AGENTS\.md\s+from ~\/\.codex\/AGENTS\.md/);
  assert.equal(readFileSync(join(fresh, ".agents/AGENTS.md"), "utf8"), "# Codex rules\n");
});

test("the built CLI runs as a bin and prints its version", () => {
  const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");
  const result = spawnSync(process.execPath, [cli, "--version"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json"), "utf8"));
  assert.equal(result.stdout.trim(), pkg.version);
});
