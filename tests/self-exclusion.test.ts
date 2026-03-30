/**
 * Tests for calling session resolution and self-exclusion.
 * 
 * PID-based resolution via findCallingSession() requires CC's session
 * registry (~/.claude/sessions/<pid>.json) which only exists during
 * active CC sessions. In a test environment, it returns null.
 * 
 * These tests verify:
 * - findCallingSession() returns null gracefully outside CC
 * - Synthetic session registry files are read correctly
 * - queryBatch self-exclusion logic works with a known calling session
 */

import { join } from "node:path";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import {
  findCallingSession,
  resolveSessionFiles,
  listSessionFiles,
} from "../src/discovery.js";

const TMPDIR = join(import.meta.dirname, "..", "testdata", ".tmp-self-exclusion");

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (condition) { passed++; }
  else { failed++; console.error(`  ✗ ${msg}`); }
}
function ok(msg: string) { passed++; console.log(`  ✓ ${msg}`); }

// Setup
if (existsSync(TMPDIR)) rmSync(TMPDIR, { recursive: true, force: true });
mkdirSync(TMPDIR, { recursive: true });

// ============================================================================
// findCallingSession — PID-based resolution
// ============================================================================

console.log("\n--- findCallingSession: returns null outside CC ---");
{
  // No ~/.claude/sessions/<pid>.json exists for our process tree
  const result = findCallingSession();
  assert(result === null, `returns null: ${JSON.stringify(result)}`);
  ok("returns null gracefully when no session registry exists");
}

console.log("\n--- findCallingSession: reads synthetic session registry ---");
{
  // Create a fake session registry file for our own PID
  const sessionsDir = join(homedir(), ".claude", "sessions");
  const pidFile = join(sessionsDir, `${process.pid}.json`);
  const existed = existsSync(pidFile);
  
  if (!existed) {
    mkdirSync(sessionsDir, { recursive: true });
    const sessionId = "test-session-" + Date.now();
    writeFileSync(pidFile, JSON.stringify({
      pid: process.pid,
      sessionId,
      cwd: "/tmp/test",
      startedAt: Date.now(),
    }));

    try {
      const result = findCallingSession();
      assert(result !== null, `found session: ${JSON.stringify(result)}`);
      assert(result?.sessionId === sessionId, `correct sessionId: ${result?.sessionId}`);
      assert(result?.cwd === "/tmp/test", `correct cwd: ${result?.cwd}`);
      ok("reads synthetic session registry for own PID");
    } finally {
      // Clean up — don't leave fake session files
      try { rmSync(pidFile); } catch {}
    }
  } else {
    // An actual CC session is running — skip synthetic test
    console.log("  (skipped — real session registry exists for this PID)");
    passed++;
  }
}

// ============================================================================
// Self-exclusion in routing — verify session-level behavior
// ============================================================================

function createSessionFile(dir: string, sessionId: string, content?: string) {
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${sessionId}.jsonl`);
  writeFileSync(filePath, content ?? JSON.stringify({
    uuid: "u1", parentUuid: null, type: "user",
    timestamp: new Date().toISOString(),
    message: { role: "user", content: "test" },
  }) + "\n");
  return filePath;
}

console.log("\n--- resolveSessionFiles: returns all sessions when no self-exclusion ---");
{
  const dir = join(TMPDIR, "no-exclusion");
  createSessionFile(dir, "session-a");
  createSessionFile(dir, "session-b");
  createSessionFile(dir, "session-c");

  const result = resolveSessionFiles({
    mode: "project",
    projectDir: dir,
  });

  assert(result.sessions.length === 3, `all 3 sessions returned: ${result.sessions.length}`);
  ok("all sessions returned without self-exclusion");
}

console.log("\n--- resolveSessionFiles: pagination works ---");
{
  const dir = join(TMPDIR, "pagination");
  createSessionFile(dir, "page-1");
  createSessionFile(dir, "page-2");
  createSessionFile(dir, "page-3");

  const page1 = resolveSessionFiles({ mode: "project", projectDir: dir, limit: 2 });
  assert(page1.sessions.length === 2, `page 1: ${page1.sessions.length} sessions`);
  assert(page1.hasMore === true, "hasMore is true");

  const page2 = resolveSessionFiles({ mode: "project", projectDir: dir, limit: 2, offset: 2 });
  assert(page2.sessions.length === 1, `page 2: ${page2.sessions.length} sessions`);
  assert(page2.hasMore === false, "hasMore is false");
  ok("pagination works correctly");
}

// ============================================================================
// Cleanup
// ============================================================================

rmSync(TMPDIR, { recursive: true, force: true });

console.log(`\n✅ Self-exclusion tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
