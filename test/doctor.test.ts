import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { makeHome, run, skillText, writeFile } from "./fixture.js";

test("doctor passes clean skills", (t) => {
  const home = makeHome(t);
  const { code, out } = run(["doctor", "--home", home]);
  assert.equal(code, 0, out);
  assert.match(out, /0 errors, 0 warnings in 0 of 2 skills\./);
});

test("doctor flags a missing description for every tool, citing each tool's doc", (t) => {
  const home = makeHome(t);
  writeFile(join(home, ".agents/skills/gamma/SKILL.md"), skillText("gamma", null));
  const { code, out } = run(["doctor", "--home", home]);
  assert.equal(code, 1);
  assert.match(out, /^gamma$/m);
  assert.match(out, /error agent-skills\s+description is required \[\d\]/);
  assert.match(out, /error codex\s+description is missing; Codex refuses to load the skill/);
  assert.match(out, /warn\s+claude-code\s+no description/);
  assert.match(out, /error claude-desktop\s+description is required for upload/);
  assert.match(out, /https:\/\/agentskills\.io\/specification/);
  assert.match(out, /https:\/\/github\.com\/openai\/codex\/blob\/main\/codex-rs\/skills\/src\/parser\.rs/);
});

test("doctor catches what one tool accepts and another rejects", (t) => {
  const home = makeHome(t);
  writeFile(join(home, ".agents/skills/claude-post-2.0/SKILL.md"), skillText("claude-post-2.0", "Posts. Use when posting."));
  const long = "x".repeat(1600);
  writeFile(join(home, ".agents/skills/wordy/SKILL.md"), `---\nname: wordy\ndescription: ${long}\nwhen-to-use: typo field\n---\nbody\n`);
  const { code, out } = run(["doctor", "--home", home]);
  assert.equal(code, 1);
  assert.match(out, /error agent-skills\s+name "claude-post-2\.0" has characters outside a-z, 0-9 and "-"/);
  assert.match(out, /error claude-desktop\s+name contains reserved word "claude"/);
  assert.doesNotMatch(out, /claude-code\s+.*claude-post/);
  assert.match(out, /error agent-skills\s+description is 1600 characters; the limit is 1024/);
  assert.match(out, /warn\s+claude-code\s+description \+ when_to_use is 1600 characters; the skill listing truncates at 1536/);
  assert.match(out, /warn\s+claude-code\s+unknown field when-to-use ignored without an error/);
});

test("doctor reads folded and quoted descriptions as present", (t) => {
  const home = makeHome(t);
  writeFile(join(home, ".agents/skills/folded/SKILL.md"), "---\nname: folded\ndescription: >-\n  Spans two\n  lines.\n---\nbody\n");
  writeFile(join(home, ".agents/skills/quoted/SKILL.md"), '---\nname: quoted\ndescription: "Has: a colon"\nmetadata:\n  author: me\n---\nbody\n');
  const { code, out } = run(["doctor", "--home", home]);
  assert.equal(code, 0, out);
});

test("doctor flags a SKILL.md with no frontmatter", (t) => {
  const home = makeHome(t);
  writeFile(join(home, ".agents/skills/bare/SKILL.md"), "# Just text\n");
  const { out } = run(["doctor", "--home", home]);
  assert.match(out, /error codex\s+SKILL\.md has no YAML frontmatter; Codex skips the skill/);
});
