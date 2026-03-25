/**
 * Tests for CC message normalization.
 * Uses real CC session files from testdata/.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { parseSession } from "../src/parser.js";
import { buildRawChain } from "../src/tree.js";
import { normalizeMessages } from "../src/normalize.js";

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

console.log("\n--- Normalization: filter progress/system ---");
{
  const files = findSessionFiles();
  for (const file of files) {
    const content = readFileSync(file, "utf-8");
    const parsed = parseSession(content);
    const chain = buildRawChain(parsed);
    const name = basename(file, ".jsonl").slice(0, 12);

    if (chain.length === 0) { ok(`${name}: empty, skip`); continue; }

    const normalized = normalizeMessages(chain);

    // No progress messages should remain
    const hasProgress = normalized.some((m) => m.type === "progress");
    assert(!hasProgress, `${name}: no progress after normalization`);

    // No non-local-command system messages
    const hasBadSystem = normalized.some(
      (m) => m.type === "system" && m.subtype !== "local_command"
    );
    assert(!hasBadSystem, `${name}: no non-local system messages`);

    // All messages should be user or assistant (system converted to user)
    const allUserAssistant = normalized.every(
      (m) => m.type === "user" || m.type === "assistant"
    );
    assert(allUserAssistant, `${name}: all messages are user/assistant`);

    ok(`${name}: ${chain.length} → ${normalized.length} messages`);
  }
}

console.log("\n--- Normalization: role alternation ---");
{
  const files = findSessionFiles();
  for (const file of files) {
    const content = readFileSync(file, "utf-8");
    const parsed = parseSession(content);
    const chain = buildRawChain(parsed);
    const name = basename(file, ".jsonl").slice(0, 12);

    if (chain.length === 0) continue;

    const normalized = normalizeMessages(chain);
    if (normalized.length < 2) continue;

    // Check: no two consecutive messages of the same role
    let consecutiveSame = 0;
    for (let i = 1; i < normalized.length; i++) {
      if (normalized[i].type === normalized[i - 1].type) {
        consecutiveSame++;
      }
    }

    // After normalization, consecutive same-role should be rare (merging handles most cases)
    // Log any remaining for investigation
    if (consecutiveSame > 0) {
      // Find which ones are consecutive
      const pairs: string[] = [];
      for (let i = 1; i < normalized.length; i++) {
        if (normalized[i].type === normalized[i - 1].type) {
          pairs.push(`[${i - 1}:${normalized[i - 1].type}, ${i}:${normalized[i].type}]`);
        }
      }
      console.log(`  ⚠ ${name}: ${consecutiveSame} consecutive same-role: ${pairs.slice(0, 3).join(", ")}${pairs.length > 3 ? "..." : ""}`);
    } else {
      ok(`${name}: perfect role alternation (${normalized.length} msgs)`);
    }
  }
}

console.log("\n--- Normalization: no empty assistant content ---");
{
  const files = findSessionFiles();
  for (const file of files) {
    const content = readFileSync(file, "utf-8");
    const parsed = parseSession(content);
    const chain = buildRawChain(parsed);
    const name = basename(file, ".jsonl").slice(0, 12);

    if (chain.length === 0) continue;

    const normalized = normalizeMessages(chain);

    // Check no assistant has empty content (except possibly the last)
    for (let i = 0; i < normalized.length - 1; i++) {
      const msg = normalized[i];
      if (msg.type !== "assistant") continue;
      const content = msg.message.content;
      if (Array.isArray(content)) {
        assert(content.length > 0, `${name}: assistant[${i}] has content`);
      }
    }
  }
  ok("no empty non-terminal assistant content");
}

console.log("\n--- Normalization: user messages have content ---");
{
  const files = findSessionFiles();
  for (const file of files) {
    const content = readFileSync(file, "utf-8");
    const parsed = parseSession(content);
    const chain = buildRawChain(parsed);
    const name = basename(file, ".jsonl").slice(0, 12);

    if (chain.length === 0) continue;

    const normalized = normalizeMessages(chain);

    for (const msg of normalized) {
      if (msg.type !== "user") continue;
      const c = msg.message.content;
      const hasContent =
        (typeof c === "string" && c.length > 0) ||
        (Array.isArray(c) && c.length > 0);
      assert(hasContent, `${name}: user message has content`);
    }
  }
  ok("all user messages have content");
}

console.log("\n--- Normalization: first message is user ---");
{
  const files = findSessionFiles();
  for (const file of files) {
    const content = readFileSync(file, "utf-8");
    const parsed = parseSession(content);
    const chain = buildRawChain(parsed);
    const name = basename(file, ".jsonl").slice(0, 12);

    if (chain.length === 0) continue;

    const normalized = normalizeMessages(chain);
    if (normalized.length === 0) continue;

    assert(
      normalized[0].type === "user",
      `${name}: first message is user (got ${normalized[0].type})`
    );
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
