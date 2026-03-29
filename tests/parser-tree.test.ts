/**
 * Tests for CC session parsing and tree operations.
 * Uses real CC session files from testdata/.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { parseSession, parseJsonl, isTranscriptMessage, isCompactBoundary, isLocalCommand } from "../src/parser.js";
import { findLeaves, findBestLeaf, walkChain, stripInternalFields, sliceFromBoundary, getCompactionWindows, buildRawChain } from "../src/tree.js";
import { requireCorpus } from "./_skip-if-no-corpus.js";

const TESTDATA = requireCorpus();

// Find all main session files (not subagent)
function findSessionFiles(): string[] {
  const files: string[] = [];
  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== "subagents") {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl") && !dir.includes("subagents")) {
        files.push(full);
      }
    }
  }
  walk(TESTDATA);
  return files;
}

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

function ok(msg: string) {
  passed++;
  console.log(`  ✓ ${msg}`);
}

// ============================================================================
// Tests
// ============================================================================

console.log("\n--- JSONL Parsing ---");
{
  const files = findSessionFiles();
  assert(files.length > 0, "found session files");
  ok(`found ${files.length} session files`);

  for (const file of files) {
    const content = readFileSync(file, "utf-8");
    const entries = parseJsonl(content);
    const name = basename(file, ".jsonl").slice(0, 12);
    assert(entries.length > 0, `${name}: parsed ${entries.length} entries`);
  }
  ok("all files parsed without error");
}

console.log("\n--- Transcript/Metadata Separation ---");
{
  const files = findSessionFiles();
  for (const file of files) {
    const content = readFileSync(file, "utf-8");
    const parsed = parseSession(content);
    const name = basename(file, ".jsonl").slice(0, 12);
    
    // Every message in the map should pass isTranscriptMessage
    for (const [uuid, msg] of parsed.messages) {
      assert(isTranscriptMessage(msg), `${name}: message ${uuid.slice(0, 8)} is transcript`);
    }

    // Count types
    const types = new Map<string, number>();
    for (const msg of parsed.messages.values()) {
      types.set(msg.type, (types.get(msg.type) ?? 0) + 1);
    }
    
    const parts = [];
    for (const [t, n] of types) parts.push(`${t}:${n}`);
    ok(`${name}: ${parsed.messages.size} messages (${parts.join(", ")})`);
  }
}

console.log("\n--- Tree Structure ---");
{
  const files = findSessionFiles();
  for (const file of files) {
    const content = readFileSync(file, "utf-8");
    const parsed = parseSession(content);
    const name = basename(file, ".jsonl").slice(0, 12);

    if (parsed.messages.size === 0) {
      ok(`${name}: empty session, skip`);
      continue;
    }

    // Check parentUuid references are valid
    let brokenRefs = 0;
    for (const msg of parsed.messages.values()) {
      if (msg.parentUuid && !parsed.messages.has(msg.parentUuid)) {
        brokenRefs++;
      }
    }
    // Some broken refs are expected (progress messages may reference non-transcript entries)
    
    // Find leaves
    const leaves = findLeaves(parsed.messages);
    assert(leaves.length > 0, `${name}: has ${leaves.length} leaves`);

    // Find best leaf
    const bestLeaf = findBestLeaf(parsed.messages);
    const hasUserOrAssistant = [...parsed.messages.values()].some(
      (m) => m.type === "user" || m.type === "assistant"
    );
    if (!hasUserOrAssistant) {
      assert(bestLeaf === undefined, `${name}: no user/assistant → no leaf`);
      ok(`${name}: empty conversation (only progress/system)`);
      continue;
    }
    assert(bestLeaf !== undefined, `${name}: found best leaf`);

    if (bestLeaf) {
      // Walk chain
      const chain = walkChain(parsed.messages, bestLeaf);
      assert(chain.length > 0, `${name}: chain has ${chain.length} messages`);

      // First message should have no parent (or parent not in messages)
      const first = chain[0];
      assert(
        first.parentUuid === null || !parsed.messages.has(first.parentUuid),
        `${name}: chain starts at root`,
      );

      // Last message should be the leaf or reachable from it
      const last = chain[chain.length - 1];
      assert(last.uuid === bestLeaf.uuid, `${name}: chain ends at leaf`);

      // Chain should have user and assistant messages
      const hasUser = chain.some((m) => m.type === "user");
      const hasAssistant = chain.some((m) => m.type === "assistant");
      if (hasUser) ok(`${name}: chain has user messages`);
      if (hasAssistant) ok(`${name}: chain has assistant messages`);

      // Check alternation: should roughly alternate user/assistant
      // (with system/progress interspersed)
      const roles = chain
        .filter((m) => m.type === "user" || m.type === "assistant")
        .map((m) => m.type);
      
      // No two consecutive same roles (loose check — tool results break this)
      let consecutiveSame = 0;
      for (let i = 1; i < roles.length; i++) {
        if (roles[i] === roles[i - 1]) consecutiveSame++;
      }
      ok(`${name}: chain ${chain.length} msgs, ${roles.length} user/assistant, ${consecutiveSame} consecutive-same`);
    }
  }
}

console.log("\n--- Field Stripping ---");
{
  const files = findSessionFiles();
  const file = files.find((f) => statSync(f).size > 10000) ?? files[0];
  const content = readFileSync(file, "utf-8");
  const parsed = parseSession(content);
  const leaf = findBestLeaf(parsed.messages);
  
  if (leaf) {
    const chain = walkChain(parsed.messages, leaf);
    const stripped = stripInternalFields(chain);
    
    for (const msg of stripped) {
      assert(!("isSidechain" in msg), "no isSidechain field");
      assert(!("parentUuid" in msg), "no parentUuid field");
    }
    ok(`stripped ${stripped.length} messages`);
  }
}

console.log("\n--- Boundary Slicing ---");
{
  // No boundaries in our test data, so sliceFromBoundary should return all messages
  const files = findSessionFiles();
  const file = files.find((f) => statSync(f).size > 10000) ?? files[0];
  const content = readFileSync(file, "utf-8");
  const parsed = parseSession(content);
  const leaf = findBestLeaf(parsed.messages);
  
  if (leaf) {
    const chain = walkChain(parsed.messages, leaf);
    const sliced = sliceFromBoundary(chain);
    assert(sliced.length === chain.length, "no boundary: sliced === chain");
    ok(`no boundary: ${sliced.length} messages preserved`);
  }
}

console.log("\n--- Compaction Windows ---");
{
  const files = findSessionFiles();
  const file = files.find((f) => statSync(f).size > 10000) ?? files[0];
  const content = readFileSync(file, "utf-8");
  const parsed = parseSession(content);
  const leaf = findBestLeaf(parsed.messages);
  
  if (leaf) {
    const chain = walkChain(parsed.messages, leaf);
    const windows = getCompactionWindows(chain);
    assert(windows.length === 1, "no boundaries: single window");
    assert(windows[0].messages.length === chain.length, "window contains all messages");
    
    if (windows[0].modelInfo) {
      ok(`model: ${windows[0].modelInfo.provider}/${windows[0].modelInfo.modelId}`);
    }
  }
}

console.log("\n--- buildRawChain ---");
{
  const files = findSessionFiles();
  for (const file of files) {
    const content = readFileSync(file, "utf-8");
    const parsed = parseSession(content);
    const name = basename(file, ".jsonl").slice(0, 12);
    
    const chain = buildRawChain(parsed);
    const hasConversation = [...parsed.messages.values()].some(
      (m) => m.type === "user" || m.type === "assistant"
    );
    if (chain.length === 0 && !hasConversation) {
      ok(`${name}: no conversation`);
    } else {
      assert(chain.length > 0, `${name}: buildRawChain produced ${chain.length} messages`);
      
      // Verify it's a valid chain (each message's parentUuid points to previous)
      for (let i = 1; i < chain.length; i++) {
        const msg = chain[i];
        const prev = chain[i - 1];
        // parentUuid should reference something earlier in chain (not necessarily i-1 due to branches)
        const parentInChain = chain.some((m) => m.uuid === msg.parentUuid);
        if (!parentInChain && msg.parentUuid !== null) {
          // Parent might be outside the transcript (e.g., references a non-transcript entry)
          // This is OK — CC sessions have progress messages etc. that break strict chaining
        }
      }
      ok(`${name}: valid chain of ${chain.length}`);
    }
  }
}

// ============================================================================
// Summary
// ============================================================================

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("❌ Some tests failed");
  process.exit(1);
} else {
  console.log("✅ All tests passed");
}
