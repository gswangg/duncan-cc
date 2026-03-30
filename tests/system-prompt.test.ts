/**
 * Tests for system prompt + context reconstruction.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { parseSession } from "../src/parser.js";
import { buildRawChain } from "../src/tree.js";
import { normalizeMessages } from "../src/normalize.js";
import { buildSystemPrompt, buildSystemPromptString, buildSubagentSystemPrompt, injectUserContext } from "../src/system-prompt.js";
import { requireCorpus } from "./_skip-if-no-corpus.js";

const TESTDATA = requireCorpus();

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
    modelId: "claude-sonnet-4-20250514",
    toolNames: new Set(["Read", "Edit", "Write", "Bash", "Grep", "Glob"]),
  });

  assert(prompt.includes("interactive agent"), "includes identity intro");
  assert(prompt.includes("software engineering"), "includes SE context");
  assert(prompt.includes("/workspace"), "includes cwd");
  assert(prompt.includes("claude-sonnet"), "includes model name");
  assert(prompt.includes("Platform:"), "includes platform");
  assert(prompt.includes("# System"), "includes system section");
  assert(prompt.includes("# Doing tasks"), "includes doing tasks section");
  assert(prompt.includes("# Executing actions with care"), "includes careful actions");
  assert(prompt.includes("# Using your tools"), "includes tool usage");
  assert(prompt.includes("# Tone and style"), "includes tone section");
  assert(prompt.includes("# Output efficiency"), "includes output efficiency");
  assert(prompt.includes("Read instead of cat"), "includes tool-specific instructions");
  ok(`system prompt: ${prompt.length} chars`);
}

console.log("\n--- System Prompt: sections ---");
{
  const sections = buildSystemPrompt({
    cwd: "/workspace",
    modelId: "claude-opus-4-6",
  });

  assert(sections.length >= 7, `has ${sections.length} sections (need >= 7)`);
  assert(sections[0].includes("interactive agent"), "section 0: identity");
  assert(sections[1].includes("# System"), "section 1: system rules");
  assert(sections.some(s => s.includes("<env>")), "has environment section");
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

console.log("\n--- System Prompt: tool name extraction ---");
{
  const file = join(
    TESTDATA,
    "-Users-wednesdayniemeyer-Documents-gniemeyer-Projects-codex",
    "630fd2b9-d94d-4287-8c24-e225fbedfc5c.jsonl"
  );
  const content = readFileSync(file, "utf-8");
  const parsed = parseSession(content);
  const chain = buildRawChain(parsed);

  const { extractToolNames } = await import("../src/system-prompt.js");
  const toolNames = extractToolNames(chain);
  assert(toolNames.size > 0, `found ${toolNames.size} tool names`);
  // CC sessions use standard tools
  const hasStandard = toolNames.has("Read") || toolNames.has("Bash") || toolNames.has("Grep");
  assert(hasStandard, `has standard tools: ${[...toolNames].join(", ")}`);
  ok(`extracted ${toolNames.size} tools: ${[...toolNames].slice(0, 5).join(", ")}...`);

  // System prompt should include tool-specific instructions when tools are provided
  const prompt = buildSystemPromptString({
    cwd: "/workspace",
    toolNames,
  });
  if (toolNames.has("Read")) {
    assert(prompt.includes("Read instead of cat"), "prompt has Read-specific instructions");
  }
  if (toolNames.has("Bash")) {
    assert(prompt.includes("Bash exclusively for system commands"), "prompt has Bash-specific instructions");
  }
  ok("tool-specific instructions present in system prompt");
}

console.log("\n--- System Prompt: memory from project dir ---");
{
  // The ideas project has memory/MEMORY.md
  const projectDir = join(TESTDATA, "-Users-wednesdayniemeyer-Documents-gniemeyer-Projects-ideas");
  const prompt = buildSystemPromptString({
    cwd: "/workspace",
    projectDir,
  });
  assert(prompt.includes("auto memory"), "includes memory section header");
  assert(prompt.includes("persistent, file-based memory system"), "includes memory system description");
  assert(prompt.includes("When to access memories"), "includes access instructions");
  assert(prompt.includes("Before recommending from memory"), "includes verification instructions");
  assert(prompt.includes("MEMORY.md"), "includes MEMORY.md reference");
  ok("memory loaded from project dir with instructions");

  // No memory project dir — should still have instructions with empty notice
  const promptNoMem = buildSystemPromptString({
    cwd: "/workspace",
    projectDir: join(TESTDATA, "-Users-wednesdayniemeyer-Documents-gniemeyer-Projects-codex"),
  });
  // codex project has a memory dir — check if MEMORY.md exists there
  const codexMemory = join(TESTDATA, "-Users-wednesdayniemeyer-Documents-gniemeyer-Projects-codex", "memory", "MEMORY.md");
  if (!existsSync(codexMemory)) {
    assert(promptNoMem.includes("currently empty"), "empty memory notice when no MEMORY.md");
  }
  ok("memory section handles missing MEMORY.md");
}

console.log("\n--- System Prompt: language ---");
{
  const prompt = buildSystemPromptString({
    cwd: "/workspace",
    language: "Japanese",
  });
  assert(prompt.includes("# Language"), "has language section");
  assert(prompt.includes("Japanese"), "includes language name");
  ok("language section present");

  const promptNoLang = buildSystemPromptString({ cwd: "/workspace" });
  assert(!promptNoLang.includes("# Language"), "no language section by default");
  ok("no language section when not specified");
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
// Subagent system prompt dispatch
// ============================================================================

console.log("\n--- Subagent system prompt: Explore agent ---");
{
  const prompt = buildSubagentSystemPrompt("Explore", { cwd: "/tmp/test" });
  assert(prompt.includes("file search specialist"), `explore prompt contains identity: ${prompt.slice(0, 50)}`);
  assert(prompt.includes("READ-ONLY"), "explore prompt is read-only");
  assert(!prompt.includes("# System"), "explore prompt does NOT include standard system rules");
  ok("Explore agent gets dedicated search prompt");
}

console.log("\n--- Subagent system prompt: Plan agent ---");
{
  const prompt = buildSubagentSystemPrompt("Plan", { cwd: "/tmp/test" });
  assert(prompt.includes("software architect"), `plan prompt contains identity: ${prompt.slice(0, 50)}`);
  assert(prompt.includes("READ-ONLY"), "plan prompt is read-only");
  assert(prompt.includes("Critical Files"), "plan prompt has required output format");
  assert(!prompt.includes("# System"), "plan prompt does NOT include standard system rules");
  ok("Plan agent gets dedicated architect prompt");
}

console.log("\n--- Subagent system prompt: unknown agent → standard prompt ---");
{
  const prompt = buildSubagentSystemPrompt("general-purpose", { cwd: "/tmp/test" });
  assert(prompt.includes("interactive agent"), "unknown agent falls back to standard prompt");
  ok("Unknown agent type falls back to standard prompt");
}

console.log("\n--- Subagent system prompt: null agent → standard prompt ---");
{
  const prompt = buildSubagentSystemPrompt(null, { cwd: "/tmp/test" });
  assert(prompt.includes("interactive agent"), "null agent falls back to standard prompt");
  ok("Null agent type falls back to standard prompt");
}

// ============================================================================

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("❌ Some tests failed");
  process.exit(1);
} else {
  console.log("✅ All tests passed");
}
