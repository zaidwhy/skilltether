import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Layout } from "./layout.js";
import { hashTree, isLink, listSkills, TreeLimitError } from "./skill.js";

export interface Adoption {
  kind: "skill" | "instructions";
  verb: "adopt" | "same" | "differs" | "clash" | "skip";
  label: string;
  from: string[];
  dest: string;
  reason?: string;
}

const claudeOwned = (name: string) => {
  const lower = name.toLowerCase();
  return lower === "synced" || lower.startsWith("anthropic-skills");
};

function skillHomes(layout: Layout): string[] {
  // ~/.codex/skills is where Codex kept user skills before it moved to
  // ~/.agents/skills; existing installs still have content there.
  return layout.scope === "user" ? [layout.claudeSkillsDir, join(layout.codexHome, "skills")] : [layout.claudeSkillsDir];
}

function realOrNull(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

// init only ever writes inside the source; targets are read, never changed.
export function planAdoption(layout: Layout): Adoption[] {
  const found = new Map<string, { dir: string; hash: string }[]>();
  const adoptions: Adoption[] = [];
  for (const home of skillHomes(layout)) {
    for (const skill of listSkills(home, claudeOwned)) {
      const inSource = realOrNull(join(layout.skillsDir, skill.name));
      if (isLink(skill.dir) && inSource && realOrNull(skill.dir) === inSource) continue;
      try {
        const list = found.get(skill.name) ?? [];
        list.push({ dir: skill.dir, hash: hashTree(skill.dir).hash });
        found.set(skill.name, list);
      } catch (err) {
        if (!(err instanceof TreeLimitError)) throw err;
        adoptions.push({ kind: "skill", verb: "skip", label: skill.name, from: [skill.dir], dest: "", reason: err.message });
      }
    }
  }

  for (const [name, copies] of [...found.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const dest = join(layout.skillsDir, name);
    const from = copies.map((c) => c.dir);
    if (existsSync(join(dest, "SKILL.md"))) {
      const sourceHash = hashTree(dest).hash;
      const differing = copies.filter((c) => c.hash !== sourceHash).map((c) => c.dir);
      adoptions.push(differing.length
        ? { kind: "skill", verb: "differs", label: name, from: differing, dest, reason: "differs from the source copy; the source wins, merge by hand if needed" }
        : { kind: "skill", verb: "same", label: name, from, dest });
      continue;
    }
    const distinct = new Set(copies.map((c) => c.hash));
    adoptions.push(distinct.size === 1
      ? { kind: "skill", verb: "adopt", label: name, from: [from[0]], dest }
      : { kind: "skill", verb: "clash", label: name, from, dest, reason: "copies disagree; copy the right one into the source by hand" });
  }

  if (!existsSync(layout.instructions)) {
    const candidates = (layout.codexAgentsMd ? [layout.codexAgentsMd, layout.claudeMd] : [layout.claudeMd])
      .filter((p) => existsSync(p))
      .map((p) => ({ p, text: readFileSync(p, "utf8").trim() }))
      .filter(({ text }) => text !== "" && text !== layout.claudeImport);
    const distinct = new Set(candidates.map((c) => c.text));
    const label = basename(layout.instructions);
    if (distinct.size === 1) adoptions.push({ kind: "instructions", verb: "adopt", label, from: [candidates[0].p], dest: layout.instructions });
    else if (distinct.size > 1) adoptions.push({ kind: "instructions", verb: "clash", label, from: candidates.map((c) => c.p), dest: layout.instructions, reason: "instruction files disagree; write AGENTS.md by hand" });
  }
  return adoptions;
}

export function applyAdoption(adoptions: Adoption[]): void {
  for (const a of adoptions) {
    if (a.verb !== "adopt") continue;
    mkdirSync(dirname(a.dest), { recursive: true });
    if (a.kind === "instructions") copyFileSync(a.from[0], a.dest);
    else cpSync(a.from[0], a.dest, { recursive: true, dereference: true, filter: (src) => basename(src) !== ".git" });
  }
}
