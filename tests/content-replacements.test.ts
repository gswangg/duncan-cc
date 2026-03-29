/**
 * Tests for content replacements and microcompact.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { parseSession } from "../src/parser.js";
import { buildRawChain } from "../src/tree.js";
import { normalizeMessages } from "../src/normalize.js";
import { applyContentReplacements, microcompact } from "../src/content-replacements.js";
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

console.log("\n--- Content Replacements: persisted output resolution ---");
{
  // The codex session 630fd2b9 has persisted-output markers and tool-results/ files
  const sessionFile = join(
    TESTDATA,
    "-Users-wednesdayniemeyer-Documents-gniemeyer-Projects-codex",
    "630fd2b9-d94d-4287-8c24-e225fbedfc5c.jsonl"
  );
  const content = readFileSync(sessionFile, "utf-8");
  const parsed = parseSession(content);
  const chain = buildRawChain(parsed);
  const normalized = normalizeMessages(chain);

  // Count persisted-output markers before replacement
  let markersBefore = 0;
  for (const msg of normalized) {
    if (msg.type !== "user") continue;
    const c = msg.message.content;
    if (Array.isArray(c)) {
      for (const block of c) {
        if (block.type === "tool_result" && typeof block.content === "string" && block.content.includes("<persisted-output>")) {
          markersBefore++;
        }
      }
    }
  }

  const replaced = applyContentReplacements(normalized, parsed, sessionFile);

  // Count persisted-output markers after replacement
  let markersAfter = 0;
  let resolved = 0;
  for (const msg of replaced) {
    if (msg.type !== "user") continue;
    const c = msg.message.content;
    if (Array.isArray(c)) {
      for (const block of c) {
        if (block.type === "tool_result" && typeof block.content === "string") {
          if (block.content.includes("<persisted-output>")) markersAfter++;
          // Check if it was resolved from disk
          if (block.content.length > 200 && !block.content.includes("<persisted-output>")) resolved++;
        }
      }
    }
  }

  ok(`630fd2b9: ${markersBefore} persisted-output markers before, ${markersAfter} after, ${resolved} resolved from disk`);

  // Check that tool-results/ directory exists for this session
  const toolResultsDir = join(
    dirname(sessionFile),
    "630fd2b9-d94d-4287-8c24-e225fbedfc5c",
    "tool-results"
  );
  assert(existsSync(toolResultsDir), "tool-results/ dir exists");

  // Check files in it
  const toolResultFiles = readdirSync(toolResultsDir);
  ok(`tool-results/ has ${toolResultFiles.length} files: ${toolResultFiles.join(", ")}`);
}

console.log("\n--- Content Replacements: no-op for sessions without replacements ---");
{
  const files = findSessionFiles();
  for (const file of files) {
    const content = readFileSync(file, "utf-8");
    const parsed = parseSession(content);
    const chain = buildRawChain(parsed);
    const name = basename(file, ".jsonl").slice(0, 12);

    if (chain.length === 0) continue;

    const normalized = normalizeMessages(chain);
    const replaced = applyContentReplacements(normalized, parsed, file);

    // Should be same length (no messages added/removed)
    assert(replaced.length === normalized.length, `${name}: same length after replacement`);
  }
  ok("all sessions: replacement preserves message count");
}

console.log("\n--- Microcompact: synthetic test ---");
{
  // Create synthetic messages with a time gap
  const now = new Date();
  const oldTime = new Date(now.getTime() - 60 * 60 * 1000); // 1 hour ago

  const messages: any[] = [
    {
      type: "user", uuid: "u1", parentUuid: null, timestamp: oldTime.toISOString(),
      message: { role: "user", content: [
        { type: "tool_result", tool_use_id: "old_tool_1", content: "old result 1" },
        { type: "tool_result", tool_use_id: "old_tool_2", content: "old result 2" },
      ]},
    },
    {
      type: "assistant", uuid: "a1", parentUuid: "u1", timestamp: oldTime.toISOString(),
      message: { role: "assistant", content: [
        { type: "text", text: "Here's what I found..." },
        { type: "tool_use", id: "recent_tool_1", name: "Read", input: {} },
      ]},
    },
    {
      type: "user", uuid: "u2", parentUuid: "a1", timestamp: oldTime.toISOString(),
      message: { role: "user", content: [
        { type: "tool_result", tool_use_id: "recent_tool_1", content: "recent result" },
      ]},
    },
    {
      type: "assistant", uuid: "a2", parentUuid: "u2", timestamp: oldTime.toISOString(),
      message: { role: "assistant", content: [
        { type: "text", text: "Done." },
      ]},
    },
  ];

  // keepRecentTurns=2: keeps tool_use IDs from the last 2 assistant messages (a1 + a2)
  const compacted = microcompact(messages, 30, 2);

  // Old tool results (not from recent assistants) should be truncated
  const u1 = compacted[0];
  const u1Content = u1.message.content as any[];
  assert(
    u1Content[0].content.includes("truncated"),
    "old_tool_1 truncated",
  );
  assert(
    u1Content[1].content.includes("truncated"),
    "old_tool_2 truncated",
  );

  // Recent tool result (from a1, which is in the last 2 assistants) should be preserved
  const u2 = compacted[2];
  const u2Content = u2.message.content as any[];
  assert(
    u2Content[0].content === "recent result",
    "recent_tool_1 preserved",
  );

  ok("microcompact correctly truncates old, preserves recent");
}

console.log("\n--- Microcompact: no-op for recent sessions ---");
{
  // Create messages that are recent (no gap)
  const now = new Date();

  const messages: any[] = [
    {
      type: "user", uuid: "u1", parentUuid: null, timestamp: now.toISOString(),
      message: { role: "user", content: [
        { type: "tool_result", tool_use_id: "t1", content: "result" },
      ]},
    },
    {
      type: "assistant", uuid: "a1", parentUuid: "u1", timestamp: now.toISOString(),
      message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
    },
  ];

  const compacted = microcompact(messages, 30, 1);
  const u1Content = compacted[0].message.content as any[];
  assert(u1Content[0].content === "result", "no truncation for recent session");
  ok("microcompact no-op for recent sessions");
}

// ============================================================================

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("❌ Some tests failed");
  process.exit(1);
} else {
  console.log("✅ All tests passed");
}
