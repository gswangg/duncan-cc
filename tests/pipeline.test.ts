/**
 * End-to-end pipeline tests.
 * Verifies the full path: session file → API-ready messages.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { processSessionFile, processSessionWindows, toApiMessages } from "../src/pipeline.js";

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

console.log("\n--- Full Pipeline: all sessions ---");
{
  const files = findSessionFiles();
  for (const file of files) {
    const name = basename(file, ".jsonl").slice(0, 12);
    try {
      const result = processSessionFile(file);

      if (result.messages.length === 0) {
        ok(`${name}: empty session`);
        continue;
      }

      // All messages should have role + content
      for (const msg of result.messages) {
        assert(
          msg.role === "user" || msg.role === "assistant",
          `${name}: valid role (${msg.role})`,
        );
        assert(
          msg.content !== undefined && msg.content !== null,
          `${name}: has content`,
        );
      }

      // First message should be user (system-reminder from context injection)
      assert(
        result.messages[0].role === "user",
        `${name}: starts with user`,
      );

      // Role alternation (user/assistant must alternate)
      for (let i = 1; i < result.messages.length; i++) {
        assert(
          result.messages[i].role !== result.messages[i - 1].role,
          `${name}: alternation at ${i} (${result.messages[i - 1].role} → ${result.messages[i].role})`,
        );
      }

      // System prompt should be non-empty
      assert(result.systemPrompt.length > 0, `${name}: has system prompt`);

      // Should have extracted cwd
      assert(result.sessionCwd.length > 0, `${name}: has cwd`);

      ok(`${name}: ${result.rawMessageCount} raw → ${result.messages.length} API msgs, model: ${result.modelInfo?.modelId ?? "none"}, cwd: ${result.sessionCwd.slice(-30)}`);
    } catch (err: any) {
      failed++;
      console.error(`  ✗ ${name}: pipeline error: ${err.message}`);
    }
  }
}

console.log("\n--- Full Pipeline: window processing ---");
{
  const files = findSessionFiles();
  // Pick a session with content
  const file = files.find((f) => readFileSync(f, "utf-8").length > 100000) ?? files[0];
  const name = basename(file, ".jsonl").slice(0, 12);

  const windows = processSessionWindows(file);

  // No compaction boundaries in test data → single window
  assert(windows.length === 1, `${name}: 1 window (no boundaries)`);

  if (windows.length > 0) {
    const w = windows[0];
    assert(w.windowIndex === 0, "window index 0");
    assert(w.messages.length > 0, "window has messages");
    assert(w.systemPrompt.length > 0, "window has system prompt");
    ok(`${name}: window 0: ${w.messages.length} msgs`);
  }
}

console.log("\n--- Full Pipeline: options ---");
{
  const file = findSessionFiles().find((f) => readFileSync(f, "utf-8").length > 10000) ?? findSessionFiles()[0];
  const name = basename(file, ".jsonl").slice(0, 12);

  // With all options disabled
  const minimal = processSessionFile(file, {
    applyReplacements: false,
    applyMicrocompact: false,
    injectContext: false,
    skipSystemPrompt: true,
  });

  // With all options enabled
  const full = processSessionFile(file);

  // Minimal should have fewer messages (no context injection)
  assert(
    full.messages.length >= minimal.messages.length,
    `${name}: full (${full.messages.length}) >= minimal (${minimal.messages.length})`,
  );

  // Minimal should have empty system prompt
  assert(minimal.systemPrompt === "", `${name}: no system prompt when skipped`);

  // Full should have system prompt
  assert(full.systemPrompt.length > 0, `${name}: has system prompt when enabled`);

  ok(`${name}: options work correctly`);
}

console.log("\n--- Full Pipeline: API message format ---");
{
  const file = findSessionFiles().find((f) => readFileSync(f, "utf-8").length > 50000) ?? findSessionFiles()[0];
  const result = processSessionFile(file);
  const name = basename(file, ".jsonl").slice(0, 12);

  for (const msg of result.messages) {
    // Should only have role and content
    const keys = Object.keys(msg);
    assert(
      keys.length === 2 && keys.includes("role") && keys.includes("content"),
      `${name}: API message has only role+content (got: ${keys.join(", ")})`,
    );

    // Content should be string or array
    assert(
      typeof msg.content === "string" || Array.isArray(msg.content),
      `${name}: content is string or array`,
    );
  }
  ok(`${name}: all API messages have correct format`);
}

// ============================================================================

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("❌ Some tests failed");
  process.exit(1);
} else {
  console.log("✅ All tests passed");
}
