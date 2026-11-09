import {
  copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readlinkSync, realpathSync,
  renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { desktopBlocker } from "./doctor.js";
import { TARGET_NAMES, type Layout, type TargetName } from "./layout.js";
import { filePathInTree, hashTree, isLink, listSkills, pathExists, TreeLimitError, type Skill } from "./skill.js";
import { buildSkillZip } from "./zip.js";

export type Verb = "add" | "update" | "takeover" | "remove" | "zip" | "import" | "ok" | "native" | "note" | "skip" | "blocked";
export const WRITE_VERBS: ReadonlySet<Verb> = new Set(["add", "update", "takeover", "remove", "zip", "import"]);

export interface Action {
  target: TargetName;
  key: string;
  verb: Verb;
  label: string;
  dest: string;
  source?: string;
  kind: "tree" | "zip" | "import" | "info";
  reason?: string;
  editedPaths?: string[];
  diff?: string[];
}

export interface ManifestEntry {
  source: string;
  mode: "link" | "copy" | "zip" | "import";
  hash: string;
  files: Record<string, string>;
}

export interface Manifest {
  schema_version: 1;
  target: TargetName;
  entries: Record<string, ManifestEntry>;
}

export interface Plan {
  actions: Action[];
  manifests: Record<TargetName, Manifest>;
}

export type Linker = (source: string, dest: string, type: "junction" | "file") => void;

const CLAUDE_RESERVED = (name: string) => {
  const lower = name.toLowerCase();
  return lower === "synced" || lower.startsWith("anthropic-skills");
};

export function manifestPath(layout: Layout, target: TargetName): string {
  return join(layout.stateDir, `${target}.json`);
}

export function readManifest(layout: Layout, target: TargetName): Manifest {
  const path = manifestPath(layout, target);
  if (!existsSync(path)) return { schema_version: 1, target, entries: {} };
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Manifest;
  if (parsed.schema_version !== 1) {
    throw new Error(`${path} has schema_version ${parsed.schema_version}; this skilltether reads schema_version 1`);
  }
  return parsed;
}

function sameTarget(link: string, source: string): boolean {
  try {
    return realpathSync(link) === realpathSync(source);
  } catch {
    return false;
  }
}

function changedFiles(recorded: Record<string, string>, current: Record<string, string>): string[] {
  const keys = new Set([...Object.keys(recorded), ...Object.keys(current)]);
  return [...keys].filter((k) => recorded[k] !== current[k]).sort();
}

const DIFF_LINES_SHOWN = 10;
const DIFF_MAX_INPUT_LINES = 2000;

// What --force would do to this file: "-" lines are the user's and would be
// lost, "+" lines come from the source.
export function shortDiff(yours: string, incoming: string): string[] {
  const read = (p: string) => (existsSync(p) && statSync(p).isFile() ? readFileSync(p, "utf8").split(/\r?\n/) : []);
  const a = read(yours);
  const b = read(incoming);
  const out: string[] = [];
  if (a.length > DIFF_MAX_INPUT_LINES || b.length > DIFF_MAX_INPUT_LINES) {
    const at = a.findIndex((line, i) => line !== b[i]);
    if (at >= 0) out.push(`- ${a[at]}`, `+ ${b[at] ?? ""}`);
    return out;
  }
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      i++;
      j++;
    } else if (j < b.length && (i === a.length || lcs[i][j + 1] > lcs[i + 1][j])) {
      out.push(`+ ${b[j++]}`);
    } else {
      out.push(`- ${a[i++]}`);
    }
  }
  if (out.length > DIFF_LINES_SHOWN) {
    const hidden = out.length - DIFF_LINES_SHOWN;
    return [...out.slice(0, DIFF_LINES_SHOWN), `... ${hidden} more changed line${hidden > 1 ? "s" : ""}`];
  }
  return out;
}

function planTree(
  base: Omit<Action, "verb">,
  source: string,
  dest: string,
  entry: ManifestEntry | undefined,
  force: boolean,
): Action {
  if (!pathExists(dest)) return { ...base, verb: "add" };
  if (isLink(dest)) {
    if (sameTarget(dest, source)) return { ...base, verb: "ok" };
    const pointsAt = readlinkSync(dest);
    return force
      ? { ...base, verb: "update", reason: `replaces a link to ${pointsAt} (--force)` }
      : { ...base, verb: "blocked", reason: `is a link to ${pointsAt}, not to the source` };
  }
  const desired = hashTree(source);
  const current = hashTree(dest);
  if (entry?.mode === "copy") {
    const edited = changedFiles(entry.files, current.files);
    if (edited.length === 0) {
      return current.hash === desired.hash ? { ...base, verb: "ok" } : { ...base, verb: "update", reason: "source changed" };
    }
    if (force) return { ...base, verb: "update", reason: "overwrites hand edits (--force)" };
    const editedPaths = edited.map((rel) => (statSync(dest).isDirectory() ? join(dest, ...rel.split("/")) : dest));
    return {
      ...base,
      verb: "blocked",
      reason: "hand-edited since the last sync",
      editedPaths,
      diff: shortDiff(editedPaths[0], filePathInTree(source, edited[0])),
    };
  }
  if (current.hash === desired.hash) return { ...base, verb: "takeover", reason: "identical copy already there" };
  if (force) return { ...base, verb: "update", reason: "replaces content skilltether did not write (--force)" };
  const firstDiffering = changedFiles(desired.files, current.files)[0];
  const yours = firstDiffering ? filePathInTree(dest, firstDiffering) : dest;
  return {
    ...base,
    verb: "blocked",
    reason: "exists and was not written by skilltether",
    editedPaths: [yours],
    diff: firstDiffering ? shortDiff(yours, filePathInTree(source, firstDiffering)) : [],
  };
}

function planOrphan(base: Omit<Action, "verb">, entry: ManifestEntry, force: boolean): Action {
  const { dest } = base;
  if (!pathExists(dest) || isLink(dest) || entry.mode === "zip") return { ...base, verb: "remove", reason: "gone from the source" };
  const edited = changedFiles(entry.files, hashTree(dest).files);
  if (edited.length === 0 || force) return { ...base, verb: "remove", reason: "gone from the source" };
  return {
    ...base,
    verb: "blocked",
    reason: "gone from the source, but hand-edited here; delete it yourself or pass --force",
    editedPaths: edited.map((rel) => filePathInTree(dest, rel)),
  };
}

function guarded(base: Omit<Action, "verb">, build: () => Action): Action {
  try {
    return build();
  } catch (err) {
    if (err instanceof TreeLimitError) return { ...base, verb: "blocked", reason: err.message };
    throw err;
  }
}

function planClaudeCode(layout: Layout, skills: Skill[], manifest: Manifest, force: boolean): Action[] {
  const target: TargetName = "claude-code";
  const actions: Action[] = [];
  const live = new Set<string>();
  for (const skill of skills) {
    const key = `skill:${skill.name}`;
    const dest = join(layout.claudeSkillsDir, skill.name);
    const base = { target, key, label: skill.name, dest, source: skill.dir, kind: "tree" as const };
    if (CLAUDE_RESERVED(skill.name)) {
      actions.push({ ...base, kind: "info", verb: "skip", reason: "folder name is reserved by Claude Code" });
      continue;
    }
    live.add(key);
    actions.push(guarded(base, () => planTree(base, skill.dir, dest, manifest.entries[key], force)));
  }
  for (const [key, entry] of Object.entries(manifest.entries)) {
    if (!key.startsWith("skill:") || live.has(key)) continue;
    const label = key.slice("skill:".length);
    const base = { target, key, label, dest: join(layout.claudeSkillsDir, label), kind: "tree" as const };
    actions.push(guarded(base, () => planOrphan(base, entry, force)));
  }

  if (existsSync(layout.instructions)) {
    const dest = layout.claudeMd;
    const base = { target, key: "file:CLAUDE.md", label: "CLAUDE.md", dest, source: layout.instructions, kind: "import" as const };
    if (!existsSync(dest)) {
      actions.push({ ...base, verb: "import", reason: `create with ${layout.claudeImport}` });
    } else {
      const text = readFileSync(dest, "utf8");
      const imports = text.split(/\r?\n/).some((line) => line.trim() === layout.claudeImport);
      if (imports) actions.push({ ...base, verb: "ok" });
      else if (force) {
        const duplicate = text.trim() === readFileSync(layout.instructions, "utf8").trim();
        actions.push({ ...base, verb: "import", reason: duplicate ? `replace the duplicated text with ${layout.claudeImport}` : `prepend ${layout.claudeImport}` });
      } else {
        actions.push({ ...base, verb: "blocked", reason: `does not import AGENTS.md; add the line ${layout.claudeImport} or pass --force to prepend it`, editedPaths: [dest] });
      }
    }
  }
  return actions;
}

function planCodex(layout: Layout, manifest: Manifest, force: boolean): Action[] {
  const target: TargetName = "codex";
  const actions: Action[] = [{
    target, key: "info:skills", kind: "info", verb: "native", label: "skills", dest: layout.skillsDir,
    reason: "Codex reads .agents/skills itself; nothing to write",
  }];
  if (!layout.codexAgentsMd) {
    actions.push({ target, key: "info:agents", kind: "info", verb: "native", label: "AGENTS.md", dest: layout.instructions, reason: "Codex reads the repo AGENTS.md itself" });
    return actions;
  }
  const dest = layout.codexAgentsMd;
  const key = "file:AGENTS.md";
  const base = { target, key, label: "AGENTS.md", dest, source: layout.instructions, kind: "tree" as const };
  if (existsSync(layout.instructions)) actions.push(planTree(base, layout.instructions, dest, manifest.entries[key], force));
  else if (manifest.entries[key]) actions.push(planOrphan(base, manifest.entries[key], force));
  const override = join(dirname(dest), "AGENTS.override.md");
  if (existsSync(override) && readFileSync(override, "utf8").trim()) {
    actions.push({ target, key: "info:override", kind: "info", verb: "note", label: "AGENTS.override.md", dest: override, reason: "non-empty, so Codex reads it instead of AGENTS.md" });
  }
  return actions;
}

function planDesktop(layout: Layout, skills: Skill[], manifest: Manifest): Action[] {
  const target: TargetName = "claude-desktop";
  const actions: Action[] = [];
  const live = new Set<string>();
  for (const skill of skills) {
    const key = `zip:${skill.name}`;
    const dest = join(layout.desktopZipDir, `${skill.name}.zip`);
    const base = { target, key, label: `${skill.name}.zip`, dest, source: skill.dir, kind: "zip" as const };
    const blocker = desktopBlocker(skill);
    if (blocker) {
      actions.push({ ...base, kind: "info", verb: "skip", reason: `upload would be rejected: ${blocker}` });
      continue;
    }
    live.add(key);
    actions.push(guarded(base, () => {
      const entry = manifest.entries[key];
      if (entry && existsSync(dest) && entry.hash === hashTree(skill.dir).hash) return { ...base, verb: "ok" };
      return { ...base, verb: "zip", reason: entry ? "source changed; upload it again" : "new; upload it once" };
    }));
  }
  for (const key of Object.keys(manifest.entries)) {
    if (live.has(key)) continue;
    const label = key.slice("zip:".length);
    actions.push({ target, key, label: `${label}.zip`, dest: join(layout.desktopZipDir, `${label}.zip`), kind: "zip", verb: "remove", reason: "gone from the source" });
  }
  return actions;
}

export function computePlan(layout: Layout, opts: { force: boolean }): Plan {
  const manifests = Object.fromEntries(TARGET_NAMES.map((t) => [t, readManifest(layout, t)])) as Record<TargetName, Manifest>;
  const skills = listSkills(layout.skillsDir);
  const actions = [
    ...planClaudeCode(layout, skills, manifests["claude-code"], opts.force),
    ...planCodex(layout, manifests.codex, opts.force),
    ...planDesktop(layout, skills, manifests["claude-desktop"]),
  ];
  return { actions, manifests };
}

function materialize(source: string, dest: string, link: Linker, copyOnly: boolean): { mode: "link" | "copy"; fallback?: string } {
  mkdirSync(dirname(dest), { recursive: true });
  const isDir = statSync(source).isDirectory();
  let fallback: string | undefined;
  if (!copyOnly) {
    try {
      link(source, dest, isDir ? "junction" : "file");
      return { mode: "link" };
    } catch (err) {
      fallback = (err as NodeJS.ErrnoException).code ?? String(err);
    }
  }
  if (isDir) cpSync(source, dest, { recursive: true, filter: (src) => basename(src) !== ".git" });
  else copyFileSync(source, dest);
  return { mode: "copy", fallback };
}

function removeTarget(dest: string): void {
  if (!pathExists(dest)) return;
  if (isLink(dest)) unlinkSync(dest);
  else rmSync(dest, { recursive: true });
}

function recordTree(layout: Layout, source: string, dest: string, mode: "link" | "copy"): ManifestEntry {
  const tree = hashTree(mode === "copy" ? dest : source);
  return { source: relative(layout.base, source), mode, hash: tree.hash, files: mode === "copy" ? tree.files : {} };
}

export interface ApplyOptions {
  link?: Linker;
  copyOnly?: boolean;
}

// Returns one line per link that fell back to a copy, so the caller can say so.
export function applyPlan(layout: Layout, plan: Plan, opts: ApplyOptions = {}): string[] {
  const link: Linker = opts.link ?? ((s, d, type) => symlinkSync(s, d, type));
  const copyOnly = opts.copyOnly ?? false;
  const fallbacks: string[] = [];
  const note = (a: Action, fallback?: string) => {
    if (fallback) fallbacks.push(`${a.label}: link failed (${fallback}), copied instead`);
  };

  for (const a of plan.actions) {
    const entries = plan.manifests[a.target].entries;
    if (a.verb === "ok" && a.kind === "tree" && a.source && !entries[a.key]) {
      entries[a.key] = recordTree(layout, a.source, a.dest, isLink(a.dest) ? "link" : "copy");
      continue;
    }
    if (!WRITE_VERBS.has(a.verb)) continue;

    if (a.verb === "remove") {
      removeTarget(a.dest);
      delete entries[a.key];
    } else if (a.kind === "tree" && a.source) {
      if (a.verb === "takeover") {
        if (copyOnly) {
          entries[a.key] = recordTree(layout, a.source, a.dest, "copy");
          continue;
        }
        const parked = `${a.dest}.skilltether-old`;
        renameSync(a.dest, parked);
        try {
          link(a.source, a.dest, statSync(a.source).isDirectory() ? "junction" : "file");
          rmSync(parked, { recursive: true });
          entries[a.key] = recordTree(layout, a.source, a.dest, "link");
        } catch (err) {
          renameSync(parked, a.dest);
          entries[a.key] = recordTree(layout, a.source, a.dest, "copy");
          note(a, (err as NodeJS.ErrnoException).code ?? String(err));
        }
        continue;
      }
      if (a.verb === "update") removeTarget(a.dest);
      const made = materialize(a.source, a.dest, link, copyOnly);
      note(a, made.fallback);
      entries[a.key] = recordTree(layout, a.source, a.dest, made.mode);
    } else if (a.kind === "zip" && a.source) {
      mkdirSync(dirname(a.dest), { recursive: true });
      writeFileSync(a.dest, buildSkillZip(a.label.replace(/\.zip$/, ""), a.source).zip);
      entries[a.key] = { source: relative(layout.base, a.source), mode: "zip", hash: hashTree(a.source).hash, files: {} };
    } else if (a.kind === "import" && a.source) {
      const existing = existsSync(a.dest) ? readFileSync(a.dest, "utf8") : "";
      const duplicate = existing.trim() !== "" && existing.trim() === readFileSync(a.source, "utf8").trim();
      const text = existing.trim() === "" || duplicate ? `${layout.claudeImport}\n` : `${layout.claudeImport}\n\n${existing}`;
      mkdirSync(dirname(a.dest), { recursive: true });
      writeFileSync(a.dest, text);
      entries[a.key] = { source: relative(layout.base, a.source), mode: "import", hash: hashTree(a.dest).hash, files: {} };
    }
  }

  mkdirSync(layout.stateDir, { recursive: true });
  for (const target of TARGET_NAMES) {
    writeFileSync(manifestPath(layout, target), `${JSON.stringify(plan.manifests[target], null, 2)}\n`);
  }
  return fallbacks;
}
