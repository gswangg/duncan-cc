/**
 * Tests for self-exclusion — finding and excluding the calling session
 * by scanning for toolUseId in session file tails.
 */

import { join } from "node:path";
import { mkdirSync, writeFileSync, rmSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  findCallingSession,
  resolveSessionFilesExcludingSelf,
  listSessionFiles,
  type SessionFileInfo,
} from "../src/discovery.js";

const TESTDATA = join(import.meta.dirname, "..", "testdata", "projects");
const TMPDIR = join(import.meta.dirname, "..", "testdata", ".tmp-self-exclusion");

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (condition) { passed++; }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

function ok(msg: string) { passed++; console.log(`  ✓ ${msg}`); }

// ============================================================================
// Helpers
// ============================================================================

/** Create a minimal JSONL session file with a tool_use block near the end. */
function createSessionFile(dir: string, sessionId: string, toolUseId: string, paddingKB = 0): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sessionId}.jsonl`);

  const lines: string[] = [];

  // Optional padding to push the tool_use away from file start
  if (paddingKB > 0) {
    const padding = "x".repeat(1024);
    for (let i = 0; i < paddingKB; i++) {
      lines.push(JSON.stringify({
        type: "user", uuid: randomUUID(), parentUuid: null,
        session_id: sessionId, timestamp: new Date().toISOString(),
        message: { role: "user", content: [{ type: "text", text: padding }] },
      }));
    }
  }

  // User message
  lines.push(JSON.stringify({
    type: "user", uuid: randomUUID(), parentUuid: null,
    session_id: sessionId, timestamp: new Date().toISOString(),
    message: { role: "user", content: [{ type: "text", text: "query something" }] },
  }));

  // Assistant message with tool_use
  lines.push(JSON.stringify({
    type: "assistant", uuid: randomUUID(), parentUuid: null,
    session_id: sessionId, timestamp: new Date().toISOString(),
    message: {
      role: "assistant",
      content: [{
        type: "tool_use", id: toolUseId, name: "duncan_query",
        input: { question: "test", mode: "project" },
      }],
    },
  }));

  writeFileSync(path, lines.join("\n") + "\n");
  return path;
}

function fileInfo(path: string, sessionId: string, projectDir: string): SessionFileInfo {
  const stat = statSync(path);
  return { path, sessionId, mtime: stat.mtime, size: stat.size, projectDir };
}

// ============================================================================
// Setup / Teardown
// ============================================================================

rmSync(TMPDIR, { recursive: true, force: true });

// ============================================================================
// Tests: findCallingSession
// ============================================================================

console.log("\n--- findCallingSession: basic ---");
{
  const dir = join(TMPDIR, "basic");
  const toolUseId = "toolu_01TestBasicId0000000000";
  const callingPath = createSessionFile(dir, "calling-session", toolUseId);
  const otherPath = createSessionFile(dir, "other-session", "toolu_01OtherToolId0000000000");

  const candidates = [
    fileInfo(callingPath, "calling-session", dir),
    fileInfo(otherPath, "other-session", dir),
  ];

  const result = findCallingSession(toolUseId, candidates);
  assert(result === "calling-session", `found calling session: ${result}`);
  ok("identifies correct session by toolUseId");
}

console.log("\n--- findCallingSession: not found ---");
{
  const dir = join(TMPDIR, "notfound");
  const otherPath = createSessionFile(dir, "other-session", "toolu_01OtherToolId1111111111");

  const candidates = [fileInfo(otherPath, "other-session", dir)];

  const result = findCallingSession("toolu_01NonexistentId999999999", candidates);
  assert(result === null, `returns null when not found: ${result}`);
  ok("returns null for missing toolUseId");
}

console.log("\n--- findCallingSession: empty toolUseId ---");
{
  const result = findCallingSession("", []);
  assert(result === null, `returns null for empty ID: ${result}`);
  ok("returns null for empty toolUseId");
}

console.log("\n--- findCallingSession: large file (tail scan) ---");
{
  const dir = join(TMPDIR, "largefile");
  const toolUseId = "toolu_01LargeFileTest000000000";
  // Create a ~40KB file — tool_use at the end, within 32KB tail window
  const callingPath = createSessionFile(dir, "large-session", toolUseId, 40);

  const candidates = [fileInfo(callingPath, "large-session", dir)];

  const result = findCallingSession(toolUseId, candidates);
  assert(result === "large-session", `found in large file: ${result}`);
  ok("finds toolUseId in tail of large file");
}

console.log("\n--- findCallingSession: tool_use beyond tail scan window ---");
{
  const dir = join(TMPDIR, "beyond-tail");
  // The tool_use is at ~40KB but we only scan last 32KB
  // However, the tool_use entry itself is near the END (after padding)
  // So this should still work — the padding is before the tool_use
  const toolUseId = "toolu_01BeyondTailTest00000000";
  const callingPath = createSessionFile(dir, "far-session", toolUseId, 50);

  const candidates = [fileInfo(callingPath, "far-session", dir)];

  const result = findCallingSession(toolUseId, candidates);
  // The tool_use is the last entry, so it's within the 32KB tail window
  // even though the file is 50KB+ total
  assert(result === "far-session", `found despite large file: ${result}`);
  ok("tool_use at end of large file is within tail scan window");
}

console.log("\n--- findCallingSession: multiple sessions, correct one identified ---");
{
  const dir = join(TMPDIR, "multi");
  const targetId = "toolu_01MultiTargetId000000000";

  const paths = [];
  for (let i = 0; i < 5; i++) {
    const sid = `session-${i}`;
    const tid = i === 3 ? targetId : `toolu_01Other${i}Pad00000000000`;
    paths.push({ path: createSessionFile(dir, sid, tid), sid });
  }

  const candidates = paths.map((p) => fileInfo(p.path, p.sid, dir));

  const result = findCallingSession(targetId, candidates);
  assert(result === "session-3", `found session-3 among 5: ${result}`);
  ok("finds correct session among multiple candidates");
}

// ============================================================================
// Tests: findCallingSession on real test data
// ============================================================================

console.log("\n--- findCallingSession: real session data ---");
{
  const codexDir = join(TESTDATA, "-Users-wednesdayniemeyer-Documents-gniemeyer-Projects-codex");
  const sessions = listSessionFiles(codexDir);
  assert(sessions.length > 0, `have codex sessions: ${sessions.length}`);

  // Pick a real tool_use ID from the test data
  const targetId = "toolu_01ApH1X3AiGqZw7C9QjUXeGp";
  const sourceDir = join(TESTDATA, "-Users-wednesdayniemeyer--claude-skills-inspect-claude-source");
  const sourceSessions = listSessionFiles(sourceDir);

  // Search all test sessions — should find it in the inspect-claude-source project
  const allCandidates = [...sessions, ...sourceSessions];
  const result = findCallingSession(targetId, allCandidates);
  assert(result === "28e532ae-cb50-4f6f-9f08-914cbf6563b7", `found real session: ${result}`);
  ok("finds toolUseId in real CC session data");
}

// ============================================================================
// Tests: resolveSessionFilesExcludingSelf
// ============================================================================

console.log("\n--- resolveSessionFilesExcludingSelf: excludes calling session ---");
{
  const dir = join(TMPDIR, "resolve-exclude");
  const toolUseId = "toolu_01ResolveExclude000000000";

  createSessionFile(dir, "active-session", toolUseId);
  createSessionFile(dir, "dormant-session-1", "toolu_01Dormant1Pad0000000000");
  createSessionFile(dir, "dormant-session-2", "toolu_01Dormant2Pad0000000000");

  const result = resolveSessionFilesExcludingSelf({
    mode: "project",
    projectDir: dir,
    toolUseId,
  });

  assert(result.excludedSessionId === "active-session", `excluded: ${result.excludedSessionId}`);
  assert(result.sessions.length === 2, `2 sessions remain: ${result.sessions.length}`);
  assert(result.totalCount === 2, `totalCount adjusted: ${result.totalCount}`);
  assert(
    result.sessions.every((s) => s.sessionId !== "active-session"),
    "active session not in results",
  );
  ok("excludes calling session, returns others");
}

console.log("\n--- resolveSessionFilesExcludingSelf: no toolUseId → no exclusion ---");
{
  const dir = join(TMPDIR, "resolve-no-id");
  createSessionFile(dir, "session-a", "toolu_01SessionA000000000000");
  createSessionFile(dir, "session-b", "toolu_01SessionB000000000000");

  const result = resolveSessionFilesExcludingSelf({
    mode: "project",
    projectDir: dir,
  });

  assert(result.excludedSessionId === null, `no exclusion: ${result.excludedSessionId}`);
  assert(result.sessions.length === 2, `all sessions returned: ${result.sessions.length}`);
  ok("no exclusion when toolUseId not provided");
}

console.log("\n--- resolveSessionFilesExcludingSelf: toolUseId not found → no exclusion ---");
{
  const dir = join(TMPDIR, "resolve-miss");
  createSessionFile(dir, "session-x", "toolu_01SessionX000000000000");

  const result = resolveSessionFilesExcludingSelf({
    mode: "project",
    projectDir: dir,
    toolUseId: "toolu_01CompletelyUnknown000000",
  });

  assert(result.excludedSessionId === null, `no exclusion: ${result.excludedSessionId}`);
  assert(result.sessions.length === 1, `all sessions returned: ${result.sessions.length}`);
  ok("no exclusion when toolUseId not found in any file");
}

// ============================================================================
// Cleanup & Summary
// ============================================================================

rmSync(TMPDIR, { recursive: true, force: true });

console.log(`\n✅ Self-exclusion tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
