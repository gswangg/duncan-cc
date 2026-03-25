/**
 * Tests for system prompt + context reconstruction.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { parseSession } from "../src/parser.js";
import { buildRawChain } from "../src/tree.js";
import { normalizeMessages } from "../src/normalize.js";
import { buildSystemPrompt, buildSystemPromptString, injectUserContext } from "../src/system-prompt.js";

const TESTDATA = join(import.meta.dirname, "..", "testdata", "projects");

function findSessionFiles(): string[] {
  const files: string[] = [];
  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== "subagents") walk(full);
      else if (entry.isFile() && entry.name.endsWith(".jsonl") && !dir.includes("subagents")) files.push(full);
    }
  }
  walk(TESTDATA);
  return files;
}

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (condition) { passed++; }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

function ok(msg: string) { passed++; console.log(`  ✓ ${msg}`); }

// ============================================================================

console.log("\n--- System Prompt: base construction ---");
{
  const prompt = buildSystemPromptString({
    cwd: "/workspace",
    modelName: "claude-sonnet-4-20250514",
    modelId: "claude-sonnet-4-20250514",
  });

  assert(prompt.includes("Claude Code"), "includes Claude Code identity");
  assert(prompt.includes("absolute file paths"), "includes absolute paths note");
  assert(prompt.includes("/workspace"), "includes cwd");
  assert(prompt.includes("claude-sonnet"), "includes model name");
  assert(prompt.includes("Platform:"), "includes platform");
  ok(`system prompt: ${prompt.length} chars`);
}

console.log("\n--- System Prompt: sections ---");
{
  const sections = buildSystemPrompt({
    cwd: "/workspace",
    modelId: "claude-opus-4-6",
    knowledgeCutoff: "April 2025",
  });

  assert(sections.length >= 3, `has ${sections.length} sections`);
  assert(sections[0].includes("Claude Code"), "section 0: base prompt");
  assert(sections[1].includes("Notes:"), "section 1: agent notes");
  assert(sections[2].includes("<env>"), "section 2: environment");
  ok("sections structured correctly");
}

console.log("\n--- userContext injection ---");
{
  const files = findSessionFiles();
  const file = files.find((f) => {
    const content = readFileSync(f, "utf-8");
    return content.length > 10000;
  }) ?? files[0];

  const content = readFileSync(file, "utf-8");
  const parsed = parseSession(content);
  const chain = buildRawChain(parsed);
  const name = basename(file, ".jsonl").slice(0, 12);

  if (chain.length > 0) {
    const normalized = normalizeMessages(chain);
    const withContext = injectUserContext(normalized, "/workspace");

    // If first message was user, context is merged in (same count)
    // If first message was assistant, context is prepended (+1)
    const firstWasUser = normalized.length > 0 && normalized[0].type === "user";
    const expectedLen = firstWasUser ? normalized.length : normalized.length + 1;
    assert(
      withContext.length === expectedLen,
      `${name}: correct length after context injection (${withContext.length} vs ${expectedLen})`,
    );

    // First message should contain the system-reminder
    const first = withContext[0];
    assert(first.type === "user", "first message is user");

    const content = typeof first.message.content === "string"
      ? first.message.content
      : JSON.stringify(first.message.content);
    assert(content.includes("system-reminder"), "has system-reminder");
    assert(content.includes("currentDate"), "has currentDate");

    ok(`${name}: context injected, ${content.length} chars`);
  }
}

console.log("\n--- userContext: CLAUDE.md loading from cwd ---");
{
  // Test with a directory that has CLAUDE.md (if any exist in testdata)
  // Since our testdata is CC sessions, not project files, just verify the function doesn't crash
  const withContext = injectUserContext([], "/nonexistent/path");
  assert(withContext.length === 1, "injects context even for empty messages");
  assert(
    typeof withContext[0].message.content === "string" &&
    withContext[0].message.content.includes("currentDate"),
    "includes currentDate even without CLAUDE.md",
  );
  ok("handles missing CLAUDE.md gracefully");
}

console.log("\n--- System Prompt: model extraction from session ---");
{
  // Extract model from a real session's assistant messages
  const file = join(
    TESTDATA,
    "-Users-wednesdayniemeyer-Documents-gniemeyer-Projects-codex",
    "630fd2b9-d94d-4287-8c24-e225fbedfc5c.jsonl"
  );
  const content = readFileSync(file, "utf-8");
  const parsed = parseSession(content);
  const chain = buildRawChain(parsed);

  // Find model from assistant messages
  const assistant = chain.find((m) => m.type === "assistant" && m.message.model);
  assert(assistant !== undefined, "found assistant with model");
  if (assistant) {
    const model = assistant.message.model!;
    ok(`extracted model: ${model}`);

    // Build system prompt with this model
    const prompt = buildSystemPromptString({
      cwd: "/Users/wednesdayniemeyer/Documents/gniemeyer/Projects/codex",
      modelId: model,
      modelName: model,
    });
    assert(prompt.includes(model), "system prompt includes session model");
    ok("system prompt uses session's model");
  }
}

// ============================================================================

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("❌ Some tests failed");
  process.exit(1);
} else {
  console.log("✅ All tests passed");
}
