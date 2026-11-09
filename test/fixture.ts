import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { TestContext } from "node:test";
import { main } from "../src/cli.js";
import type { Linker } from "../src/plan.js";

export function writeFile(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

export function skillText(name: string, description: string | null, body = "Do the thing.\n"): string {
  const desc = description === null ? "" : `description: ${description}\n`;
  return `---\nname: ${name}\n${desc}---\n# ${name}\n\n${body}`;
}

export function tempDir(t: TestContext, prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true }));
  return dir;
}

// A fake home with two source skills, an AGENTS.md, and two files no target
// may touch: Claude's own settings and its account-synced skills folder.
export function makeHome(t: TestContext): string {
  const home = tempDir(t, "skilltether-");
  writeFile(join(home, ".agents/skills/alpha/SKILL.md"), skillText("alpha", "Alpha. Use when testing alpha.", "line one\nline two\n"));
  writeFile(join(home, ".agents/skills/beta/SKILL.md"), skillText("beta", "Beta. Use when testing beta."));
  writeFile(join(home, ".agents/skills/beta/scripts/run.sh"), "echo beta\n");
  writeFile(join(home, ".agents/AGENTS.md"), "# Shared rules\n\nRun the tests before saying done.\n");
  writeFile(join(home, ".claude/settings.json"), '{"theme":"dark"}\n');
  writeFile(join(home, ".claude/skills/synced/acct/SKILL.md"), skillText("acct", "Account skill."));
  return home;
}

export function run(args: string[], link?: Linker): { code: number; out: string } {
  const lines: string[] = [];
  const code = main(args, { out: (line) => lines.push(line), link });
  return { code, out: lines.join("\n") };
}

// Every path under root with its content hash, or its link target; links are
// recorded, not followed, so a snapshot sees exactly what is on disk.
export function snapshot(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (dir: string, rel: string) => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      const key = rel ? `${rel}/${name}` : name;
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) result[key] = `link:${readlinkSync(abs)}`;
      else if (st.isDirectory()) walk(abs, key);
      else result[key] = createHash("sha256").update(readFileSync(abs)).digest("hex");
    }
  };
  walk(root, "");
  return result;
}
