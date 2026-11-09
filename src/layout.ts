import { homedir } from "node:os";
import { join, relative, sep } from "node:path";

export type Scope = "user" | "project";
export type TargetName = "claude-code" | "codex" | "claude-desktop";
export const TARGET_NAMES: TargetName[] = ["claude-code", "codex", "claude-desktop"];

// Every path the tool may read or write, derived once per run. Nothing outside
// these paths is touched; tests assert that against sibling files.
export interface Layout {
  scope: Scope;
  base: string;
  skillsDir: string;
  instructions: string;
  stateDir: string;
  claudeSkillsDir: string;
  claudeMd: string;
  // Relative to the CLAUDE.md that holds it: Claude Code resolves @imports
  // against the importing file, so this works for any home directory.
  claudeImport: string;
  codexHome: string;
  // null at project scope: Codex reads <repo>/AGENTS.md and .agents/skills itself.
  codexAgentsMd: string | null;
  desktopZipDir: string;
}

export function resolveLayout(scope: Scope, opts: { home?: string; root?: string; env?: NodeJS.ProcessEnv }): Layout {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const codexHome = opts.home ? join(home, ".codex") : env.CODEX_HOME || join(home, ".codex");
  if (scope === "user") {
    const agents = join(home, ".agents");
    return {
      scope,
      base: home,
      skillsDir: join(agents, "skills"),
      instructions: join(agents, "AGENTS.md"),
      stateDir: join(agents, ".skilltether"),
      claudeSkillsDir: join(home, ".claude", "skills"),
      claudeMd: join(home, ".claude", "CLAUDE.md"),
      claudeImport: "@../.agents/AGENTS.md",
      codexHome,
      codexAgentsMd: join(codexHome, "AGENTS.md"),
      desktopZipDir: join(agents, ".skilltether", "claude-desktop"),
    };
  }
  const root = opts.root ?? process.cwd();
  return {
    scope,
    base: root,
    skillsDir: join(root, ".agents", "skills"),
    // The repo root is where Codex, Cursor, Copilot and Claude Code all look
    // for AGENTS.md, so the project source of truth lives there, not in .agents/.
    instructions: join(root, "AGENTS.md"),
    stateDir: join(root, ".agents", ".skilltether"),
    claudeSkillsDir: join(root, ".claude", "skills"),
    claudeMd: join(root, "CLAUDE.md"),
    claudeImport: "@AGENTS.md",
    codexHome,
    codexAgentsMd: null,
    desktopZipDir: join(root, ".agents", ".skilltether", "claude-desktop"),
  };
}

export function displayPath(layout: Layout, p: string): string {
  const rel = relative(layout.base, p);
  if (rel.startsWith("..") || rel === p) return p.split(sep).join("/");
  const prefix = layout.scope === "user" ? "~/" : "./";
  return prefix + rel.split(sep).join("/");
}
