#!/usr/bin/env node
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { applyAdoption, planAdoption } from "./adopt.js";
import { checkInstructions, checkSkill, type Finding } from "./doctor.js";
import { displayPath, resolveLayout, TARGET_NAMES, type Layout, type Scope } from "./layout.js";
import { applyPlan, computePlan, WRITE_VERBS, type Action, type Linker, type Verb } from "./plan.js";
import { listSkills } from "./skill.js";

const VERSION = "0.1.0";

const HELP = `skilltether ${VERSION}
One .agents/ folder (skills + AGENTS.md) as the source of truth for Claude Code,
Codex and Claude Desktop. Dry run unless --write; never overwrites a hand edit
unless --force.

usage: skilltether <command> [options]

commands
  init      adopt skills found in ~/.claude/skills and ~/.codex/skills into the source
  sync      show the plan for every target; --write applies it
  status    drift per target; exits 1 when anything is out of sync
  doctor    check every skill against each tool's frontmatter rules

options
  --project        project scope: <root>/.agents/skills and <root>/AGENTS.md
  --root <dir>     project root (default: current directory)
  --home <dir>     home directory to use instead of yours (user scope)
  --write          apply the plan (init, sync)
  --force          overwrite hand edits and content skilltether did not write
  --copy           copy instead of linking, even where links work
  --dir <dir>      doctor: check this skills folder instead of the source
`;

export interface Io {
  out: (line: string) => void;
  link?: Linker;
}

interface Options {
  command: string;
  scope: Scope;
  root?: string;
  home?: string;
  dir?: string;
  write: boolean;
  force: boolean;
  copy: boolean;
}

class UsageError extends Error {}

function parseArgs(argv: string[]): Options {
  const opts: Options = { command: "", scope: "user", write: false, force: false, copy: false };
  const valueFor = (flag: string, i: number) => {
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new UsageError(`${flag} needs a directory`);
    return value;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--write") opts.write = true;
    else if (arg === "--force") opts.force = true;
    else if (arg === "--copy") opts.copy = true;
    else if (arg === "--project") opts.scope = "project";
    else if (arg === "--root") opts.root = resolve(valueFor(arg, i++));
    else if (arg === "--home") opts.home = resolve(valueFor(arg, i++));
    else if (arg === "--dir") opts.dir = resolve(valueFor(arg, i++));
    else if (arg === "--help" || arg === "-h") opts.command = "help";
    else if (arg === "--version") opts.command = "version";
    else if (arg.startsWith("-")) throw new UsageError(`unknown option ${arg}`);
    else if (!opts.command) opts.command = arg;
    else throw new UsageError(`unexpected argument ${arg}`);
  }
  if (opts.root) opts.scope = "project";
  return opts;
}

const SIGN: Record<Verb, string> = {
  add: "+", update: "+", takeover: "+", zip: "+", import: "+", remove: "-",
  blocked: "!", ok: "=", native: "=", note: "~", skip: "~",
};

function describe(layout: Layout, a: Action): string {
  if (a.verb === "add") return displayPath(layout, a.dest);
  if (a.reason) return a.reason;
  return displayPath(layout, a.dest);
}

function printActions(io: Io, layout: Layout, actions: Action[], opts: { showOk: boolean }) {
  const width = Math.max(24, ...actions.map((a) => a.label.length + 1));
  for (const target of TARGET_NAMES) {
    const rows = actions.filter((a) => a.target === target && (opts.showOk || a.verb !== "ok"));
    io.out(target);
    if (rows.length === 0) io.out("  everything in sync");
    for (const a of rows) {
      io.out(`  ${SIGN[a.verb]} ${a.verb.padEnd(8)} ${a.label.padEnd(width)} ${describe(layout, a)}`);
      for (const p of a.editedPaths ?? []) io.out(`             ${displayPath(layout, p)}`);
      for (const line of a.diff ?? []) io.out(`               ${line}`);
    }
  }
}

function header(io: Io, layout: Layout, command: string, write: boolean) {
  const mode = write ? "writing" : "dry run (pass --write to apply)";
  io.out(`skilltether ${command} | ${layout.scope} scope | ${mode}`);
}

function sourceLine(io: Io, layout: Layout) {
  const skills = listSkills(layout.skillsDir).length;
  const agents = existsSync(layout.instructions) ? "present" : "missing";
  io.out(`source  ${displayPath(layout, layout.skillsDir)}  ${skills} skill${skills === 1 ? "" : "s"}, ${displayPath(layout, layout.instructions)} ${agents}`);
  io.out("");
}

function runSync(io: Io, layout: Layout, opts: Options): number {
  header(io, layout, "sync", opts.write);
  sourceLine(io, layout);
  const plan = computePlan(layout, { force: opts.force });
  printActions(io, layout, plan.actions, { showOk: false });

  const count = (pred: (a: Action) => boolean) => plan.actions.filter(pred).length;
  const writes = count((a) => WRITE_VERBS.has(a.verb));
  const blocked = count((a) => a.verb === "blocked");
  const skipped = count((a) => a.verb === "skip");
  const ok = count((a) => a.verb === "ok");
  io.out("");
  io.out(`${writes} to write, ${blocked} blocked, ${skipped} skipped, ${ok} already in sync.`);

  if (!opts.write) {
    io.out("Dry run: nothing changed.");
    return blocked ? 2 : 0;
  }
  if (blocked) {
    io.out(`Refusing to write: ${blocked} blocked. Resolve them or rerun with --force.`);
    return 2;
  }
  const fallbacks = applyPlan(layout, plan, { link: io.link, copyOnly: opts.copy });
  for (const line of fallbacks) io.out(`  ${line}`);
  io.out(`Wrote ${writes} change${writes === 1 ? "" : "s"}.`);
  const zips = plan.actions.filter((a) => a.verb === "zip").length;
  if (zips) {
    io.out(`Claude Desktop has no skills API: upload the ${zips} new or changed zip${zips === 1 ? "" : "s"} from ${displayPath(layout, layout.desktopZipDir)} in Customize > Skills.`);
  }
  return 0;
}

const DRIFT_WORD: Partial<Record<Verb, string>> = {
  add: "missing", update: "stale", takeover: "unmanaged copy", remove: "orphaned",
  zip: "zip out of date", import: "no AGENTS.md import", blocked: "blocked",
};

// A zip that was never built is not "out of date"; the plan's reason tells the two apart.
function driftWord(a: { verb: Verb; reason?: string }): string | undefined {
  if (a.verb === "zip" && a.reason?.startsWith("new")) return "zip not built";
  return DRIFT_WORD[a.verb];
}

function runStatus(io: Io, layout: Layout): number {
  io.out(`skilltether status | ${layout.scope} scope`);
  sourceLine(io, layout);
  const plan = computePlan(layout, { force: false });
  let drift = 0;
  for (const target of TARGET_NAMES) {
    const rows = plan.actions.filter((a) => a.target === target);
    const tally = new Map<string, number>();
    for (const a of rows) {
      const word = a.verb === "ok" ? "in sync" : driftWord(a);
      if (word) tally.set(word, (tally.get(word) ?? 0) + 1);
    }
    const summary = [...tally.entries()].map(([word, n]) => `${n} ${word}`).join(", ") || "nothing to track";
    io.out(`${target.padEnd(15)} ${summary}`);
    for (const a of rows.filter((r) => DRIFT_WORD[r.verb])) {
      drift++;
      io.out(`  ${SIGN[a.verb]} ${driftWord(a)!.padEnd(20)} ${a.label}`);
      for (const p of a.editedPaths ?? []) io.out(`      ${displayPath(layout, p)}`);
    }
    if (target === "claude-desktop") io.out("  upload state unknown: Claude Desktop exposes no API to compare against");
  }
  io.out("");
  io.out(drift ? `${drift} item${drift === 1 ? "" : "s"} out of sync. Run: skilltether sync` : "All targets in sync.");
  return drift ? 1 : 0;
}

function runDoctor(io: Io, layout: Layout, opts: Options): number {
  const dir = opts.dir ?? layout.skillsDir;
  const skills = listSkills(dir);
  io.out(`skilltether doctor | ${displayPath(layout, dir)} | ${skills.length} skills`);
  io.out("");
  const docs: string[] = [];
  const ref = (f: Finding) => {
    if (!docs.includes(f.doc)) docs.push(f.doc);
    return `[${docs.indexOf(f.doc) + 1}]`;
  };
  let errors = 0;
  let warnings = 0;
  let flagged = 0;
  const report = (label: string, findings: Finding[]) => {
    if (!findings.length) return;
    flagged++;
    io.out(label);
    for (const f of findings) {
      if (f.severity === "error") errors++;
      else warnings++;
      io.out(`  ${f.severity.padEnd(5)} ${f.tool.padEnd(14)} ${f.message} ${ref(f)}`);
    }
  };
  for (const skill of skills) report(skill.name, checkSkill(skill));
  if (!opts.dir) report(displayPath(layout, layout.instructions), checkInstructions(layout.instructions));

  if (docs.length) {
    io.out("");
    docs.forEach((doc, i) => io.out(`[${i + 1}] ${doc}`));
  }
  io.out("");
  io.out(`${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"} in ${flagged} of ${skills.length} skills.`);
  return errors ? 1 : 0;
}

function runInit(io: Io, layout: Layout, opts: Options): number {
  header(io, layout, "init", opts.write);
  io.out(`source  ${displayPath(layout, layout.skillsDir)}`);
  io.out("");
  const adoptions = planAdoption(layout);
  const width = Math.max(24, ...adoptions.map((a) => a.label.length + 1));
  const signs = { adopt: "+", same: "=", differs: "!", clash: "!", skip: "~" } as const;
  for (const a of adoptions) {
    if (a.verb === "same") continue;
    const from = a.from.map((p) => displayPath(layout, p)).join(", ");
    io.out(`  ${signs[a.verb]} ${a.verb.padEnd(8)} ${a.label.padEnd(width)} ${a.verb === "adopt" ? `from ${from}` : a.reason}`);
    if (a.verb !== "adopt") io.out(`             ${from}`);
  }
  const n = (verb: string) => adoptions.filter((a) => a.verb === verb).length;
  io.out("");
  io.out(`${n("adopt")} to adopt, ${n("same")} already in the source, ${n("differs") + n("clash")} conflicts, ${n("skip")} skipped.`);
  if (!opts.write) {
    io.out("Dry run: nothing changed. Targets are only read; init writes into the source alone.");
    return 0;
  }
  applyAdoption(adoptions);
  io.out(`Adopted ${n("adopt")}. Next: skilltether sync`);
  return 0;
}

export function main(argv: string[], io: Io = { out: (line) => console.log(line) }): number {
  let opts: Options;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    io.out(`skilltether: ${err.message}`);
    io.out("Run skilltether --help for usage.");
    return 64;
  }
  const layout = resolveLayout(opts.scope, { home: opts.home, root: opts.root });
  switch (opts.command) {
    case "sync": return runSync(io, layout, opts);
    case "status": return runStatus(io, layout);
    case "doctor": return runDoctor(io, layout, opts);
    case "init": return runInit(io, layout, opts);
    case "version": io.out(VERSION); return 0;
    case "":
    case "help": io.out(HELP); return 0;
    default:
      io.out(`skilltether: unknown command ${opts.command}`);
      io.out("Run skilltether --help for usage.");
      return 64;
  }
}

const invokedDirectly = process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
if (invokedDirectly) process.exitCode = main(process.argv.slice(2));
