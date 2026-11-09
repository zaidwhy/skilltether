import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

// A skill folder bigger than this is almost always an accident (a vendored
// node_modules, a dataset); hashing or copying it would stall every run.
export const MAX_FILES_PER_SKILL = 2000;
export const MAX_BYTES_PER_SKILL = 50 * 1024 * 1024;

export interface Skill {
  name: string;
  dir: string;
  skillMd: string;
}

export interface Frontmatter {
  present: boolean;
  error?: string;
  fields: Map<string, string | null>;
  bodyLines: number;
}

export interface Tree {
  hash: string;
  files: Record<string, string>;
}

export class TreeLimitError extends Error {}

export function isLink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

export function pathExists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

// Dot entries are tool-internal (.system in ~/.codex/skills, .skilltether in
// the source); `exclude` carries names a target owns, like Claude's `synced`.
export function listSkills(skillsDir: string, exclude: (name: string) => boolean = () => false): Skill[] {
  if (!existsSync(skillsDir)) return [];
  const skills: Skill[] = [];
  for (const name of readdirSync(skillsDir).sort()) {
    if (name.startsWith(".") || exclude(name)) continue;
    const dir = join(skillsDir, name);
    let isDir = false;
    try {
      isDir = statSync(dir).isDirectory();
    } catch {
      continue;
    }
    const skillMd = join(dir, "SKILL.md");
    if (isDir && existsSync(skillMd)) skills.push({ name, dir, skillMd });
  }
  return skills;
}

function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function skillFiles(dir: string): string[] {
  const files: string[] = [];
  let bytes = 0;
  const walk = (abs: string, rel: string) => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const childAbs = join(abs, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const st = statSync(childAbs);
      if (st.isDirectory()) {
        walk(childAbs, childRel);
        continue;
      }
      files.push(childRel);
      bytes += st.size;
      if (files.length > MAX_FILES_PER_SKILL) {
        throw new TreeLimitError(`${dir} has more than ${MAX_FILES_PER_SKILL} files; skilltether refuses to hash or copy it`);
      }
      if (bytes > MAX_BYTES_PER_SKILL) {
        throw new TreeLimitError(`${dir} is larger than ${MAX_BYTES_PER_SKILL / 1024 / 1024} MB; skilltether refuses to hash or copy it`);
      }
    }
  };
  walk(dir, "");
  return files.sort();
}

// A file hashes as a one-entry tree keyed by its basename, so a skill folder
// and a single AGENTS.md go through the same drift logic.
export function hashTree(p: string): Tree {
  const files: Record<string, string> = {};
  if (statSync(p).isDirectory()) {
    for (const rel of skillFiles(p)) files[rel] = sha256(readFileSync(join(p, ...rel.split("/"))));
  } else {
    files[basename(p)] = sha256(readFileSync(p));
  }
  const listing = Object.keys(files)
    .sort()
    .map((rel) => `${rel}\0${files[rel]}\n`)
    .join("");
  return { hash: sha256(listing), files };
}

export function filePathInTree(root: string, rel: string): string {
  return statSync(root).isDirectory() ? join(root, ...rel.split("/")) : root;
}

const BLOCK_SCALAR = /^[|>][+-]?$/;

// A subset of YAML that covers every SKILL.md seen in the wild: top-level
// `key: value`, quoted scalars, folded and literal blocks, and nested maps
// (kept as null, since no rule here inspects their contents).
export function parseFrontmatter(text: string): Frontmatter {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const fields = new Map<string, string | null>();
  if (lines[0]?.trim() !== "---") return { present: false, fields, bodyLines: lines.length };
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
  if (end === -1) return { present: false, error: "frontmatter opened with --- but never closed", fields, bodyLines: lines.length };

  let i = 1;
  while (i < end) {
    const line = lines[i];
    const match = /^([A-Za-z0-9_-]+):(.*)$/.exec(line);
    if (!match) {
      i++;
      continue;
    }
    const key = match[1];
    const raw = match[2].trim();
    const block: string[] = [];
    let j = i + 1;
    while (j < end && (lines[j].trim() === "" || /^\s/.test(lines[j]))) {
      block.push(lines[j]);
      j++;
    }
    if (BLOCK_SCALAR.test(raw)) {
      const joined = raw.startsWith(">") ? block.map((l) => l.trim()).join(" ") : block.map((l) => l.trim()).join("\n");
      fields.set(key, joined.trim());
    } else if (raw === "" && block.some((l) => /^\s+[A-Za-z0-9_-]+:/.test(l) || /^\s+-/.test(l))) {
      fields.set(key, null);
    } else {
      fields.set(key, unquote([raw, ...block.map((l) => l.trim())].filter(Boolean).join(" ")));
    }
    i = j;
  }
  return { present: true, fields, bodyLines: lines.length - end - 1 };
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

