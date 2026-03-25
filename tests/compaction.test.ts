/**
 * Synthetic tests for compaction boundaries, preserved segments, and windowing.
 * Tests wHY relinking, vk slicing, and getCompactionWindows.
 */

import { parseSession } from "../src/parser.js";
import { relinkPreservedSegments, findBestLeaf, walkChain, sliceFromBoundary, getCompactionWindows } from "../src/tree.js";

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string) { if (c) passed++; else { failed++; console.error(`  ✗ ${m}`); } }
function ok(m: string) { passed++; console.log(`  ✓ ${m}`); }

// Helper: build a JSONL session string
function buildSession(entries: any[]): string {
  return entries.map(e => JSON.stringify(e)).join("\n");
}

let uuid = 0;
function id() { return `uuid-${++uuid}`; }

function userMsg(uid: string, parent: string | null, text: string) {
  return { type: "user", uuid: uid, parentUuid: parent, timestamp: new Date().toISOString(), message: { role: "user", content: text } };
}

function assistantMsg(uid: string, parent: string, text: string) {
  return { type: "assistant", uuid: uid, parentUuid: parent, timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text }], model: "claude-sonnet-4" } };
}

function compactBoundary(uid: string, parent: string, preserved?: { headUuid: string; tailUuid: string; anchorUuid: string }) {
  return {
    type: "system", subtype: "compact_boundary", uuid: uid, parentUuid: parent,
    timestamp: new Date().toISOString(),
    message: { role: "system", content: "Compact boundary" },
    ...(preserved ? { compactMetadata: { preservedSegment: preserved } } : {}),
  };
}

function summaryEntry(leafUuid: string, text: string) {
  return { type: "summary", leafUuid, summary: text };
}

// ============================================================================

console.log("\n--- No compaction: single window ---");
{
  const u1 = id(), a1 = id(), u2 = id(), a2 = id();
  const content = buildSession([
    userMsg(u1, null, "hello"),
    assistantMsg(a1, u1, "hi"),
    userMsg(u2, a1, "how are you"),
    assistantMsg(a2, u2, "good"),
  ]);
  const parsed = parseSession(content);
  const leaf = findBestLeaf(parsed.messages)!;
  const chain = walkChain(parsed.messages, leaf);
  const windows = getCompactionWindows(chain);

  assert(windows.length === 1, "1 window");
  assert(windows[0].messages.length === 4, "4 messages");
  ok("no compaction: single window with all messages");
}

console.log("\n--- One boundary, no preserved segment ---");
{
  const u1 = id(), a1 = id(), b = id(), u2 = id(), a2 = id();
  const content = buildSession([
    userMsg(u1, null, "old message"),
    assistantMsg(a1, u1, "old reply"),
    compactBoundary(b, a1),
    summaryEntry(b, "Summary of old conversation"),
    userMsg(u2, b, "new message"),
    assistantMsg(a2, u2, "new reply"),
  ]);
  const parsed = parseSession(content);
  const leaf = findBestLeaf(parsed.messages)!;
  const chain = walkChain(parsed.messages, leaf);

  // vk slicing: should start from boundary
  const sliced = sliceFromBoundary(chain);
  assert(sliced[0].uuid === b, "sliced starts at boundary");
  assert(sliced.length === 3, "boundary + 2 new messages");

  const windows = getCompactionWindows(chain);
  assert(windows.length === 2, "2 windows");
  assert(windows[0].messages.length === 2, "window 0: old messages");
  assert(windows[1].messages.length === 3, "window 1: boundary + new messages");
  ok("one boundary: correct windowing");
}

console.log("\n--- One boundary with preserved segment ---");
{
  const u1 = id(), a1 = id(), u2 = id(), a2 = id();
  const b = id(), u3 = id(), a3 = id();

  // u1 → a1 → u2 → a2 → boundary(preserves u2,a2) → u3 → a3
  const content = buildSession([
    userMsg(u1, null, "very old"),
    assistantMsg(a1, u1, "very old reply"),
    userMsg(u2, a1, "kept message"),
    assistantMsg(a2, u2, "kept reply"),
    compactBoundary(b, a2, { headUuid: u2, tailUuid: a2, anchorUuid: b }),
    userMsg(u3, b, "new message"),
    assistantMsg(a3, u3, "new reply"),
  ]);
  const parsed = parseSession(content);

  // Before relinking
  assert(parsed.messages.has(u1), "u1 exists before relink");

  // Relink
  relinkPreservedSegments(parsed.messages);

  // After relinking: u1 and a1 should be deleted (pre-boundary, not preserved)
  assert(!parsed.messages.has(u1), "u1 deleted after relink");
  assert(!parsed.messages.has(a1), "a1 deleted after relink");

  // Preserved messages should still exist
  assert(parsed.messages.has(u2), "u2 preserved");
  assert(parsed.messages.has(a2), "a2 preserved");

  // u2 should now point to boundary as parent (relinked)
  const u2msg = parsed.messages.get(u2)!;
  assert(u2msg.parentUuid === b, "u2.parentUuid = boundary (relinked)");

  // u3 should point to a2 (tail of preserved segment)
  const u3msg = parsed.messages.get(u3)!;
  assert(u3msg.parentUuid === a2, "u3.parentUuid = a2 (relinked to tail)");

  // Walk should work: boundary → u2 → a2 → u3 → a3
  // Wait, the walk goes from leaf (a3) up: a3 → u3 → a2 → u2 → boundary
  const leaf = findBestLeaf(parsed.messages)!;
  const chain = walkChain(parsed.messages, leaf);

  assert(chain.length === 5, `chain length 5 (got ${chain.length})`);
  assert(chain[0].uuid === b, "chain starts at boundary");
  assert(chain[1].uuid === u2, "chain[1] = preserved u2");
  assert(chain[2].uuid === a2, "chain[2] = preserved a2");
  assert(chain[3].uuid === u3, "chain[3] = new u3");
  assert(chain[4].uuid === a3, "chain[4] = new a3");

  ok("preserved segment: relinked correctly, walk correct");
}

console.log("\n--- Two boundaries: three windows ---");
{
  const u1 = id(), a1 = id(), b1 = id();
  const u2 = id(), a2 = id(), b2 = id();
  const u3 = id(), a3 = id();

  const content = buildSession([
    userMsg(u1, null, "first"),
    assistantMsg(a1, u1, "first reply"),
    compactBoundary(b1, a1),
    userMsg(u2, b1, "second"),
    assistantMsg(a2, u2, "second reply"),
    compactBoundary(b2, a2),
    userMsg(u3, b2, "third"),
    assistantMsg(a3, u3, "third reply"),
  ]);
  const parsed = parseSession(content);
  const leaf = findBestLeaf(parsed.messages)!;
  const chain = walkChain(parsed.messages, leaf);

  const windows = getCompactionWindows(chain);
  assert(windows.length === 3, `3 windows (got ${windows.length})`);
  assert(windows[0].messages.length === 2, "window 0: 2 msgs (u1, a1)");
  assert(windows[1].messages.length === 3, "window 1: 3 msgs (b1, u2, a2)");
  assert(windows[2].messages.length === 3, "window 2: 3 msgs (b2, u3, a3)");

  // vk should slice from last boundary
  const sliced = sliceFromBoundary(chain);
  assert(sliced[0].uuid === b2, "sliced from last boundary");
  assert(sliced.length === 3, "3 messages after last boundary");

  ok("two boundaries: three windows, correct slicing");
}

console.log("\n--- Model extraction per window ---");
{
  const u1 = id(), a1 = id(), b1 = id(), u2 = id(), a2 = id();

  // a1 uses opus, a2 uses sonnet
  const content = buildSession([
    userMsg(u1, null, "hello"),
    { ...assistantMsg(a1, u1, "hi"), message: { role: "assistant", content: [{ type: "text", text: "hi" }], model: "claude-opus-4-6" } },
    compactBoundary(b1, a1),
    userMsg(u2, b1, "hello again"),
    { ...assistantMsg(a2, u2, "hi again"), message: { role: "assistant", content: [{ type: "text", text: "hi again" }], model: "claude-sonnet-4-20250514" } },
  ]);
  const parsed = parseSession(content);
  const leaf = findBestLeaf(parsed.messages)!;
  const chain = walkChain(parsed.messages, leaf);
  const windows = getCompactionWindows(chain);

  assert(windows[0].modelInfo?.modelId === "claude-opus-4-6", "window 0: opus");
  assert(windows[1].modelInfo?.modelId === "claude-sonnet-4-20250514", "window 1: sonnet");
  ok("model extraction per window");
}

// ============================================================================

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { console.log("❌ Some tests failed"); process.exit(1); }
else console.log("✅ All tests passed");
