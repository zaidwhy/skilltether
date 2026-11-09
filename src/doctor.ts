import { existsSync, readFileSync, statSync } from "node:fs";
import { parseFrontmatter, type Skill } from "./skill.js";

export type Tool = "agent-skills" | "claude-code" | "codex" | "claude-desktop";

export interface Finding {
  tool: Tool;
  severity: "error" | "warn";
  message: string;
  doc: string;
}

// Every rule cites where it came from. When a vendor changes a limit, the fix
// is one line here and the citation shows which line.
export const DOCS = {
  spec: "https://agentskills.io/specification",
  claudeCode: "https://code.claude.com/docs/en/skills",
  codexParser: "https://github.com/openai/codex/blob/main/codex-rs/skills/src/parser.rs",
  codexAgentsMd: "https://learn.chatgpt.com/docs/agent-configuration/agents-md",
  claudeUpload: "https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview",
} as const;

const CLAUDE_CODE_FIELDS = new Set([
  "name", "description", "when_to_use", "argument-hint", "arguments", "disable-model-invocation",
  "user-invocable", "allowed-tools", "disallowed-tools", "model", "effort", "context", "agent",
  "background", "hooks", "paths", "shell", "metadata", "license", "compatibility",
]);

const NAME_MAX = 64;
const DESCRIPTION_MAX = 1024;
const COMPATIBILITY_MAX = 500;
const CLAUDE_LISTING_MAX = 1536;
const BODY_LINES_ADVISED = 500;
const CODEX_AGENTS_MD_MAX_BYTES = 32 * 1024;

const XML_TAG = /<\/?[A-Za-z][^>]*>/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f​‪-‮⁦-⁩]/;

export function checkSkill(skill: Skill): Finding[] {
  const findings: Finding[] = [];
  const add = (tool: Tool, severity: Finding["severity"], message: string, doc: string) =>
    findings.push({ tool, severity, message, doc });

  const fm = parseFrontmatter(readFileSync(skill.skillMd, "utf8"));
  if (!fm.present) {
    const why = fm.error ?? "SKILL.md has no YAML frontmatter";
    add("agent-skills", "error", why, DOCS.spec);
    add("codex", "error", `${why}; Codex skips the skill`, DOCS.codexParser);
    add("claude-desktop", "error", `${why}; name and description are required`, DOCS.claudeUpload);
    add("claude-code", "warn", `${why}; Claude Code loads it but has no description to match against`, DOCS.claudeCode);
    return findings;
  }

  const name = fm.fields.get("name") ?? undefined;
  const description = (fm.fields.get("description") ?? "").trim();
  const whenToUse = fm.fields.get("when_to_use") ?? "";
  const compatibility = fm.fields.get("compatibility");
  const effectiveName = name ?? skill.name;

  // Agent Skills spec: the contract Codex, Cursor, Gemini CLI and OpenCode share.
  if (name === undefined) add("agent-skills", "error", "name is required", DOCS.spec);
  else {
    if (name.length < 1 || name.length > NAME_MAX) add("agent-skills", "error", `name is ${name.length} characters; the limit is 1-${NAME_MAX}`, DOCS.spec);
    if (!/^[a-z0-9-]*$/.test(name)) add("agent-skills", "error", `name "${name}" has characters outside a-z, 0-9 and "-"`, DOCS.spec);
    if (name.startsWith("-") || name.endsWith("-")) add("agent-skills", "error", `name "${name}" starts or ends with "-"`, DOCS.spec);
    if (name.includes("--")) add("agent-skills", "error", `name "${name}" contains "--"`, DOCS.spec);
    if (name !== skill.name) add("agent-skills", "error", `name "${name}" does not match its folder "${skill.name}"`, DOCS.spec);
  }
  if (!description) add("agent-skills", "error", "description is required", DOCS.spec);
  else if (description.length > DESCRIPTION_MAX) add("agent-skills", "error", `description is ${description.length} characters; the limit is ${DESCRIPTION_MAX}`, DOCS.spec);
  if (compatibility && compatibility.length > COMPATIBILITY_MAX) add("agent-skills", "error", `compatibility is ${compatibility.length} characters; the limit is ${COMPATIBILITY_MAX}`, DOCS.spec);
  if (fm.bodyLines > BODY_LINES_ADVISED) add("agent-skills", "warn", `SKILL.md body is ${fm.bodyLines} lines; keep it under ${BODY_LINES_ADVISED} and move detail to referenced files`, DOCS.spec);

  // Codex: the parser defaults name to the folder, caps it, and rejects an empty description.
  if (effectiveName.length > NAME_MAX) add("codex", "error", `name is ${effectiveName.length} characters; Codex rejects more than ${NAME_MAX}`, DOCS.codexParser);
  if (!description) add("codex", "error", "description is missing; Codex refuses to load the skill", DOCS.codexParser);

  // Claude Code: lenient loader, so most problems are silent rather than fatal.
  const folder = skill.name.toLowerCase();
  if (folder === "synced") add("claude-code", "error", 'folder name "synced" is reserved for account-synced skills', DOCS.claudeCode);
  if (folder === "anthropic-skills" || folder.startsWith("anthropic-skills:")) add("claude-code", "error", `folder name "${skill.name}" is reserved`, DOCS.claudeCode);
  if (/[<>]/.test(effectiveName) || CONTROL_CHARS.test(effectiveName)) add("claude-code", "error", "name contains <, > or an invisible control character; Claude Code refuses it", DOCS.claudeCode);
  if (!description) add("claude-code", "warn", "no description; Claude cannot decide when to use the skill", DOCS.claudeCode);
  const listing = description.length + whenToUse.length;
  if (listing > CLAUDE_LISTING_MAX) add("claude-code", "warn", `description + when_to_use is ${listing} characters; the skill listing truncates at ${CLAUDE_LISTING_MAX}`, DOCS.claudeCode);
  const unknown = [...fm.fields.keys()].filter((key) => !CLAUDE_CODE_FIELDS.has(key));
  if (unknown.length) add("claude-code", "warn", `unknown field${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")} ignored without an error`, DOCS.claudeCode);

  // Claude Desktop / claude.ai upload: the strictest of the four.
  if (name === undefined) add("claude-desktop", "error", "name is required for upload", DOCS.claudeUpload);
  else {
    if (name.length > NAME_MAX || !/^[a-z0-9-]+$/.test(name)) add("claude-desktop", "error", `name "${name}" must be at most ${NAME_MAX} lowercase letters, numbers and hyphens`, DOCS.claudeUpload);
    const reserved = ["anthropic", "claude"].find((word) => name.toLowerCase().includes(word));
    if (reserved) add("claude-desktop", "error", `name contains reserved word "${reserved}"`, DOCS.claudeUpload);
    if (XML_TAG.test(name)) add("claude-desktop", "error", "name contains an XML tag", DOCS.claudeUpload);
  }
  if (!description) add("claude-desktop", "error", "description is required for upload", DOCS.claudeUpload);
  else {
    if (description.length > DESCRIPTION_MAX) add("claude-desktop", "error", `description is ${description.length} characters; upload allows ${DESCRIPTION_MAX}`, DOCS.claudeUpload);
    if (XML_TAG.test(description)) add("claude-desktop", "error", "description contains an XML tag", DOCS.claudeUpload);
  }
  return findings;
}

export function checkInstructions(agentsMd: string): Finding[] {
  if (!existsSync(agentsMd)) return [];
  const size = statSync(agentsMd).size;
  if (size <= CODEX_AGENTS_MD_MAX_BYTES) return [];
  return [{
    tool: "codex",
    severity: "warn",
    message: `AGENTS.md is ${size} bytes; Codex stops reading instructions at ${CODEX_AGENTS_MD_MAX_BYTES} (project_doc_max_bytes)`,
    doc: DOCS.codexAgentsMd,
  }];
}

export function desktopBlocker(skill: Skill): string | undefined {
  return checkSkill(skill).find((f) => f.tool === "claude-desktop" && f.severity === "error")?.message;
}
