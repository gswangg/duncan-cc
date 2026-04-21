/**
 * Synthetic tests for compaction boundaries, preserved segments, and windowing.
 * Tests wHY relinking, vk slicing, and getCompactionWindows.
 */

import { parseSession } from "../src/parser.js";
import { buildRawChain, findBestLeaf, walkChain, sliceFromBoundary, getCompactionWindows } from "../src/tree.js";
import { processSessionContent, processSessionWindows, truncateHeadToFit } from "../src/pipeline.js";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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
    compactBoundary(b, null as any),
    summaryEntry(b, "Summary of old conversation"),
    userMsg(u2, b, "new message"),
    assistantMsg(a2, u2, "new reply"),
  ]);
  const parsed = parseSession(content);
  const chain = buildRawChain(parsed);

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
  // In real CC, boundary has parentUuid=null, orphaning the pre-boundary subtree.
  const content = buildSession([
    userMsg(u1, null, "very old"),
    assistantMsg(a1, u1, "very old reply"),
    userMsg(u2, a1, "kept message"),
    assistantMsg(a2, u2, "kept reply"),
    compactBoundary(b, null as any, { headUuid: u2, tailUuid: a2, anchorUuid: b }),
    userMsg(u3, b, "new message"),
    assistantMsg(a3, u3, "new reply"),
  ]);
  const parsed = parseSession(content);

  // buildRawChain reconstructs across boundaries — all messages present
  const chain = buildRawChain(parsed);
  assert(chain.length === 7, `chain length 7 (got ${chain.length})`);

  // Preserved messages appear in ancestor window (pre-boundary subtree)
  const windows = getCompactionWindows(chain);
  assert(windows.length === 2, `2 windows (got ${windows.length})`);
  assert(windows[0].messages.length === 4, "window 0: all pre-boundary msgs including preserved");
  assert(windows[1].messages.length === 3, "window 1: boundary + new messages");

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
    compactBoundary(b1, null as any),
    userMsg(u2, b1, "second"),
    assistantMsg(a2, u2, "second reply"),
    compactBoundary(b2, null as any),
    userMsg(u3, b2, "third"),
    assistantMsg(a3, u3, "third reply"),
  ]);
  const parsed = parseSession(content);
  const chain = buildRawChain(parsed);

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
    compactBoundary(b1, null as any),
    userMsg(u2, b1, "hello again"),
    { ...assistantMsg(a2, u2, "hi again"), message: { role: "assistant", content: [{ type: "text", text: "hi again" }], model: "claude-sonnet-4-20250514" } },
  ]);
  const parsed = parseSession(content);
  const chain = buildRawChain(parsed);
  const windows = getCompactionWindows(chain);

  assert(windows[0].modelInfo?.modelId === "claude-opus-4-6", "window 0: opus");
  assert(windows[1].modelInfo?.modelId === "claude-sonnet-4-20250514", "window 1: sonnet");
  ok("model extraction per window");
}

console.log("\n--- minimalSystemPrompt emits a tiny placeholder ---");
{
  const u1 = id(), a1 = id();
  const content = buildSession([
    userMsg(u1, null, "hello"),
    assistantMsg(a1, u1, "hi"),
  ]);

  const full = processSessionContent(content, undefined, {});
  const minimal = processSessionContent(content, undefined, { minimalSystemPrompt: true });
  const skipped = processSessionContent(content, undefined, { skipSystemPrompt: true });

  assert(full.systemPrompt.length > 5000, `full prompt large (got ${full.systemPrompt.length} chars)`);
  assert(minimal.systemPrompt.length > 0 && minimal.systemPrompt.length < 500, `minimal prompt short (got ${minimal.systemPrompt.length} chars)`);
  assert(skipped.systemPrompt === "", "skipSystemPrompt yields empty string");
  assert(minimal.systemPrompt !== full.systemPrompt, "minimal differs from full");
  ok(`minimal prompt: ${minimal.systemPrompt.length} chars vs full ${full.systemPrompt.length}`);
}

console.log("\n--- minimalSystemPrompt threads through processSessionWindows ---");
{
  const u1 = id(), a1 = id();
  const content = buildSession([
    userMsg(u1, null, "hello"),
    assistantMsg(a1, u1, "hi"),
  ]);
  const dir = mkdtempSync(join(tmpdir(), "duncan-test-"));
  const file = join(dir, "session.jsonl");
  writeFileSync(file, content);

  const fullWindows = processSessionWindows(file, {});
  const minWindows = processSessionWindows(file, { minimalSystemPrompt: true });
  assert(fullWindows[0].systemPrompt.length > 5000, "window: full prompt large");
  assert(minWindows[0].systemPrompt.length < 500 && minWindows[0].systemPrompt.length > 0, "window: minimal prompt short");
  ok("processSessionWindows respects minimalSystemPrompt");
}

console.log("\n--- truncateHeadToFit: returns input unchanged when under budget ---");
{
  const msgs = [
    { role: "user" as const, content: "hello" },
    { role: "assistant" as const, content: "hi" },
    { role: "user" as const, content: "more" },
    { role: "assistant" as const, content: "sure" },
  ];
  const { messages, droppedCount } = truncateHeadToFit(msgs, 100, 100_000);
  assert(droppedCount === 0, "no drops when under budget");
  assert(messages.length === 4, "4 messages kept");
  ok("under-budget passes through");
}

console.log("\n--- truncateHeadToFit: drops from head until fits ---");
{
  // Each message is ~1000 chars => ~286 tokens. Make 10 of them.
  const big = "x".repeat(1000);
  const msgs = Array.from({ length: 10 }, (_, i) => ({
    role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
    content: `${big}-${i}`,
  }));
  // Budget that should fit ~3-4 messages.
  const { messages, droppedCount } = truncateHeadToFit(msgs, 0, 1500, 0);
  assert(droppedCount > 0, `dropped some (got ${droppedCount})`);
  assert(messages.length < 10, `kept fewer than 10 (got ${messages.length})`);
  assert(messages.length > 0, "kept at least 1");
  // Tail preserved — last kept message should be the last original message
  const lastKept = messages[messages.length - 1];
  const lastContent = typeof lastKept.content === "string" ? lastKept.content : "";
  assert(lastContent.includes("-9"), `tail preserved (last content: ${lastContent.slice(0, 20)}...)`);
  ok(`dropped ${droppedCount}, kept ${messages.length} tail messages`);
}

console.log("\n--- truncateHeadToFit: strips orphan tool_results after head drop ---");
{
  // Setup: user(tool_result for tu-A), assistant(tu-B), user(tool_result for tu-B), assistant(done)
  // After dropping first 1: user(tool_result for tu-A, ORPHANED) → should strip that block
  const msgs: any[] = [
    { role: "assistant", content: [{ type: "tool_use", id: "tu-A", name: "Read", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "tu-A", content: "file content" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "tu-B", name: "Edit", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "tu-B", content: "edited" }] },
  ];
  // Budget that forces dropping the first assistant but keeps the tool_result user msg.
  // Each message is tiny; force aggressive truncation.
  const { messages, droppedCount } = truncateHeadToFit(msgs, 0, 50, 0);
  // After the first drop, the user(tool_result for tu-A) has no matching tu-A → should be stripped
  // or the whole message dropped if it had only that block.
  for (const m of messages) {
    if (m.role === "user" && Array.isArray(m.content)) {
      for (const block of m.content as any[]) {
        if (block.type === "tool_result") {
          const keptToolUseIds = new Set<string>();
          for (const mm of messages) {
            if (mm.role === "assistant" && Array.isArray(mm.content)) {
              for (const b of mm.content as any[]) {
                if (b.type === "tool_use" && b.id) keptToolUseIds.add(b.id);
              }
            }
          }
          assert(keptToolUseIds.has(block.tool_use_id), `no orphan tool_results remain (${block.tool_use_id})`);
        }
      }
    }
  }
  ok(`orphan tool_results stripped after drop (dropped ${droppedCount}, kept ${messages.length})`);
}

console.log("\n--- maxPromptTokens in pipeline: appends truncation note to system prompt ---");
{
  // Build a session with many turns
  const entries: any[] = [];
  let prev: string | null = null;
  for (let i = 0; i < 20; i++) {
    const u = id();
    entries.push(userMsg(u, prev, "user text ".repeat(200)));
    const a = id();
    entries.push(assistantMsg(a, u, "assistant text ".repeat(200)));
    prev = a;
  }
  const content = buildSession(entries);
  // Use minimalSystemPrompt so headroom is small. Cap forces truncation but
  // keeps enough budget to retain ~a few messages at the tail.
  const truncated = processSessionContent(content, undefined, {
    maxPromptTokens: 10_000,
    minimalSystemPrompt: true,
  });
  const fullRes = processSessionContent(content, undefined, { minimalSystemPrompt: true });
  assert(truncated.messages.length > 0, `kept some tail (got ${truncated.messages.length})`);
  assert(truncated.messages.length < fullRes.messages.length, `truncated has fewer messages (${truncated.messages.length} < ${fullRes.messages.length})`);
  assert(truncated.systemPrompt.includes("Transcript truncation notice"), "system prompt mentions truncation");
  ok(`maxPromptTokens truncated ${fullRes.messages.length} → ${truncated.messages.length} messages (tail kept)`);
}

console.log("\n--- Model extraction skips <synthetic> / internal_error entries ---");
{
  // Regression: CC injects pseudo-assistant entries with model=<synthetic>
  // (e.g. "Prompt is too long" errors at compaction boundaries) and
  // model=internal_error. resolveModel must not latch onto these — forwarding
  // them to the Anthropic API 404s with `model: <synthetic>`.
  const u1 = id(), a1 = id(), aErr = id(), aSynth = id();
  const content = buildSession([
    userMsg(u1, null, "hello"),
    { ...assistantMsg(a1, u1, "hi"), message: { role: "assistant", content: [{ type: "text", text: "hi" }], model: "claude-opus-4-7" } },
    { ...assistantMsg(aErr, a1, "err"), isApiErrorMessage: true, message: { role: "assistant", content: [{ type: "text", text: "API error" }], model: "internal_error" } },
    { ...assistantMsg(aSynth, aErr, "synth"), isApiErrorMessage: true, message: { role: "assistant", content: [{ type: "text", text: "Prompt is too long" }], model: "<synthetic>" } },
  ]);
  const parsed = parseSession(content);
  const chain = buildRawChain(parsed);
  const windows = getCompactionWindows(chain);

  assert(windows[0].modelInfo?.modelId === "claude-opus-4-7", `expected claude-opus-4-7, got ${windows[0].modelInfo?.modelId}`);
  ok("synthetic/internal_error entries skipped during model resolution");
}

// ============================================================================

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { console.log("❌ Some tests failed"); process.exit(1); }
else console.log("✅ All tests passed");
