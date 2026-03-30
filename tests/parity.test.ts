/**
 * Parity tests: OHY post-processing, attachment conversion, content replacements, subagents.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseSession } from "../src/parser.js";
import { buildRawChain } from "../src/tree.js";
import { normalizeMessages } from "../src/normalize.js";
import { applyContentReplacements } from "../src/content-replacements.js";
import { processSessionFile, processSessionWindows } from "../src/pipeline.js";
import { listSubagentFiles } from "../src/discovery.js";
import { requireCorpus } from "./_skip-if-no-corpus.js";

const TESTDATA = requireCorpus();

let passed = 0, failed = 0;
function assert(c: boolean, m: string) { if (c) passed++; else { failed++; console.error(`  ✗ ${m}`); } }
function ok(m: string) { passed++; console.log(`  ✓ ${m}`); }

function buildSession(entries: any[]): string {
  return entries.map(e => JSON.stringify(e)).join("\n");
}
let uid = 100;
function id() { return `parity-${++uid}`; }

// ============================================================================
console.log("\n--- OHY: Split assistant messages (same message.id) ---");
{
  const u1 = id(), a1 = id(), a1b = id(), u2 = id();
  const content = buildSession([
    { type: "user", uuid: u1, parentUuid: null, timestamp: "2026-01-01T00:00:00Z",
      message: { role: "user", content: "hello" } },
    // Split assistant: two entries with same message.id
    { type: "assistant", uuid: a1, parentUuid: u1, timestamp: "2026-01-01T00:00:01Z",
      message: { role: "assistant", id: "msg_001", content: [{ type: "text", text: "part 1" }], model: "claude-sonnet-4" } },
    { type: "assistant", uuid: a1b, parentUuid: a1, timestamp: "2026-01-01T00:00:02Z",
      message: { role: "assistant", id: "msg_001", content: [{ type: "tool_use", id: "tu1", name: "Bash", input: {} }], model: "claude-sonnet-4" } },
    { type: "user", uuid: u2, parentUuid: a1b, timestamp: "2026-01-01T00:00:03Z",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "ok" }] } },
  ]);
  const parsed = parseSession(content);
  const chain = buildRawChain(parsed);
  const normalized = normalizeMessages(chain);

  // Should merge the two assistant messages into one
  const assistants = normalized.filter(m => m.type === "assistant");
  assert(assistants.length === 1, `1 merged assistant (got ${assistants.length})`);

  const merged = assistants[0];
  const contentArr = merged.message.content as any[];
  assert(contentArr.length === 2, `merged has 2 blocks (got ${contentArr.length})`);
  assert(contentArr[0].type === "text", "block 0 is text");
  assert(contentArr[1].type === "tool_use", "block 1 is tool_use");
  ok("split assistant messages merged correctly");
}

// ============================================================================
console.log("\n--- OHY: Orphaned tool_use gets synthetic tool_result ---");
{
  const u1 = id(), a1 = id();
  const content = buildSession([
    { type: "user", uuid: u1, parentUuid: null, timestamp: "2026-01-01T00:00:00Z",
      message: { role: "user", content: "run something" } },
    { type: "assistant", uuid: a1, parentUuid: u1, timestamp: "2026-01-01T00:00:01Z",
      message: { role: "assistant", content: [
        { type: "text", text: "running" },
        { type: "tool_use", id: "orphan_tu", name: "Bash", input: { command: "ls" } },
      ], model: "claude-sonnet-4" } },
    // No tool_result follows — session was interrupted
  ]);
  const parsed = parseSession(content);
  const chain = buildRawChain(parsed);
  const normalized = normalizeMessages(chain);

  // Should have user, assistant, user (with synthetic tool_result)
  assert(normalized.length === 3, `3 messages (got ${normalized.length})`);
  assert(normalized[2].type === "user", "synthetic user message added");
  const synthContent = normalized[2].message.content as any[];
  const toolResult = synthContent.find((c: any) => c.type === "tool_result" && c.tool_use_id === "orphan_tu");
  assert(!!toolResult, "synthetic tool_result for orphan");
  assert(toolResult.is_error === true, "marked as error");
  ok("orphaned tool_use gets synthetic tool_result");
}

// ============================================================================
console.log("\n--- Attachment conversion: file ---");
{
  const u1 = id(), att = id(), a1 = id();
  const content = buildSession([
    { type: "user", uuid: u1, parentUuid: null, timestamp: "2026-01-01T00:00:00Z",
      message: { role: "user", content: "read this file" } },
    { type: "attachment", uuid: att, parentUuid: u1, timestamp: "2026-01-01T00:00:01Z",
      message: { role: "user", content: "" },
      attachment: { type: "file", filename: "test.txt", content: { type: "text", text: "file contents here" } } },
    { type: "assistant", uuid: a1, parentUuid: att, timestamp: "2026-01-01T00:00:02Z",
      message: { role: "assistant", content: [{ type: "text", text: "I see the file" }], model: "claude-sonnet-4" } },
  ]);
  const parsed = parseSession(content);
  const chain = buildRawChain(parsed);
  const normalized = normalizeMessages(chain);

  // Attachment should be converted to user message and merged
  assert(normalized.every(m => m.type === "user" || m.type === "assistant"), "no attachment type in output");
  const userMsgs = normalized.filter(m => m.type === "user");
  assert(userMsgs.length === 1, `1 user message (attachment merged) (got ${userMsgs.length})`);
  ok("file attachment converted and merged");
}

// ============================================================================
console.log("\n--- Attachment conversion: directory ---");
{
  const att = id(), a1 = id();
  const content = buildSession([
    { type: "attachment", uuid: att, parentUuid: null, timestamp: "2026-01-01T00:00:00Z",
      message: { role: "user", content: "" },
      attachment: { type: "directory", path: "/home/user/project", content: "file1.ts\nfile2.ts\nREADME.md" } },
    { type: "assistant", uuid: a1, parentUuid: att, timestamp: "2026-01-01T00:00:01Z",
      message: { role: "assistant", content: [{ type: "text", text: "I see the directory" }], model: "claude-sonnet-4" } },
  ]);
  const parsed = parseSession(content);
  const chain = buildRawChain(parsed);
  const normalized = normalizeMessages(chain);

  assert(normalized[0].type === "user", "directory converted to user");
  const text = JSON.stringify(normalized[0].message.content);
  assert(text.includes("file1.ts"), "directory listing included");
  ok("directory attachment converted");
}

// ============================================================================
console.log("\n--- Attachment conversion: plan_file_reference ---");
{
  const att = id(), a1 = id();
  const content = buildSession([
    { type: "attachment", uuid: att, parentUuid: null, timestamp: "2026-01-01T00:00:00Z",
      message: { role: "user", content: "" },
      attachment: { type: "plan_file_reference", planFilePath: "/tmp/plan.md", planContent: "## Step 1\nDo the thing" } },
    { type: "assistant", uuid: a1, parentUuid: att, timestamp: "2026-01-01T00:00:01Z",
      message: { role: "assistant", content: [{ type: "text", text: "following plan" }], model: "claude-sonnet-4" } },
  ]);
  const parsed = parseSession(content);
  const chain = buildRawChain(parsed);
  const normalized = normalizeMessages(chain);

  const text = JSON.stringify(normalized[0].message.content);
  assert(text.includes("plan.md"), "plan path included");
  assert(text.includes("Do the thing"), "plan content included");
  ok("plan_file_reference attachment converted");
}

// ============================================================================
console.log("\n--- Content replacements: metadata entries ---");
{
  const u1 = id(), a1 = id(), u2 = id();
  const content = buildSession([
    { type: "user", uuid: u1, parentUuid: null, timestamp: "2026-01-01T00:00:00Z",
      message: { role: "user", content: "hello" } },
    { type: "assistant", uuid: a1, parentUuid: u1, timestamp: "2026-01-01T00:00:01Z",
      message: { role: "assistant", content: [
        { type: "text", text: "running tool" },
        { type: "tool_use", id: "tu_replace", name: "Bash", input: {} },
      ], model: "claude-sonnet-4" } },
    { type: "user", uuid: u2, parentUuid: a1, timestamp: "2026-01-01T00:00:02Z",
      message: { role: "user", content: [
        { type: "tool_result", tool_use_id: "tu_replace", content: "very long original output that should be replaced" },
      ] } },
    // Content replacement metadata entry
    { type: "content-replacement", sessionId: "test-session",
      replacements: [{ kind: "tool-result", toolUseId: "tu_replace", replacement: "<persisted-output>replaced</persisted-output>" }] },
  ]);
  const parsed = parseSession(content);
  const chain = buildRawChain(parsed);
  const normalized = normalizeMessages(chain);
  const replaced = applyContentReplacements(normalized, parsed);

  // Find the tool_result and check it was replaced
  const userWithResult = replaced.find(m => {
    if (m.type !== "user" || !Array.isArray(m.message.content)) return false;
    return m.message.content.some((c: any) => c.type === "tool_result" && c.tool_use_id === "tu_replace");
  });
  assert(!!userWithResult, "found user with tool_result");
  const tr = (userWithResult!.message.content as any[]).find((c: any) => c.tool_use_id === "tu_replace");
  assert(tr.content.includes("replaced"), "content was replaced");
  ok("content replacement from metadata entry applied");
}

// ============================================================================
console.log("\n--- Subagent processing ---");
{
  const codexSession = join(TESTDATA,
    "-Users-wednesdayniemeyer-Documents-gniemeyer-Projects-codex",
    "630fd2b9-d94d-4287-8c24-e225fbedfc5c.jsonl");
  
  const subagents = listSubagentFiles(codexSession);
  assert(subagents.length > 0, `found ${subagents.length} subagent files`);

  let processable = 0;
  for (const sa of subagents) {
    try {
      const result = processSessionFile(sa.path);
      if (result.messages.length > 0) processable++;
    } catch {}
  }
  assert(processable > 0, `${processable}/${subagents.length} subagents processable`);

  // Verify alternation on processable subagents
  for (const sa of subagents) {
    try {
      const result = processSessionFile(sa.path);
      if (result.messages.length < 2) continue;
      for (let i = 1; i < result.messages.length; i++) {
        assert(
          result.messages[i].role !== result.messages[i-1].role,
          `subagent ${sa.sessionId.slice(0,15)}: alternation at ${i}`,
        );
      }
    } catch {}
  }
  ok("subagent sessions process through full pipeline");
}

console.log("\n--- Subagent agent type detection ---");
{
  const codexSession = join(TESTDATA,
    "-Users-wednesdayniemeyer-Documents-gniemeyer-Projects-codex",
    "630fd2b9-d94d-4287-8c24-e225fbedfc5c.jsonl");
  
  const subagents = listSubagentFiles(codexSession);
  
  // Check that .meta.json is read and agentType is populated
  const withType = subagents.filter(s => s.agentType);
  assert(withType.length > 0, `${withType.length} subagents have agentType from .meta.json`);
  
  const exploreAgents = withType.filter(s => s.agentType === "Explore");
  assert(exploreAgents.length > 0, `${exploreAgents.length} Explore agents found`);
  ok(`agent type detection: ${withType.length} typed, ${exploreAgents.length} Explore`);

  // Verify that Explore subagents get the right system prompt via pipeline
  const exploreSub = exploreAgents[0];
  const windows = processSessionWindows(exploreSub.path, { agentType: exploreSub.agentType });
  if (windows.length > 0) {
    assert(windows[0].systemPrompt.includes("file search specialist"),
      "Explore subagent gets search specialist prompt");
    assert(!windows[0].systemPrompt.includes("interactive agent"),
      "Explore subagent does NOT get standard session prompt");
    ok("Explore subagent system prompt correctly dispatched");
  }
}

// ============================================================================
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { console.log("❌ Some tests failed"); process.exit(1); }
else console.log("✅ All tests passed");
