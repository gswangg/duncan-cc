/**
 * Tests for session discovery.
 */

import { join, basename } from "node:path";
import { listSessionFiles, listSubagentFiles, listAllSessionFiles, resolveSessionFiles } from "../src/discovery.js";

const TESTDATA = join(import.meta.dirname, "..", "testdata", "projects");

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (condition) { passed++; }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

function ok(msg: string) { passed++; console.log(`  ✓ ${msg}`); }

// ============================================================================

console.log("\n--- Session Discovery: list project sessions ---");
{
  const codexDir = join(TESTDATA, "-Users-wednesdayniemeyer-Documents-gniemeyer-Projects-codex");
  const sessions = listSessionFiles(codexDir);
  assert(sessions.length > 0, `found ${sessions.length} codex sessions`);

  // Verify sorted by mtime (newest first)
  for (let i = 1; i < sessions.length; i++) {
    assert(
      sessions[i - 1].mtime >= sessions[i].mtime,
      `sorted by mtime: ${sessions[i - 1].sessionId.slice(0, 8)} >= ${sessions[i].sessionId.slice(0, 8)}`,
    );
  }

  for (const s of sessions) {
    ok(`${s.sessionId.slice(0, 12)}: ${s.size} bytes, ${s.mtime.toISOString().slice(0, 10)}`);
  }
}

console.log("\n--- Session Discovery: list subagents ---");
{
  const codexSession = join(
    TESTDATA,
    "-Users-wednesdayniemeyer-Documents-gniemeyer-Projects-codex",
    "630fd2b9-d94d-4287-8c24-e225fbedfc5c.jsonl",
  );
  const subagents = listSubagentFiles(codexSession);
  assert(subagents.length > 0, `found ${subagents.length} subagent files`);
  ok(`subagents for 630fd2b9: ${subagents.map((s) => s.sessionId.slice(0, 15)).join(", ")}`);
}

console.log("\n--- Session Discovery: list all sessions ---");
{
  // Use testdata as projects dir by overriding — but listAllSessionFiles uses homedir.
  // We'll test listSessionFiles across multiple dirs instead.
  const dirs = [
    join(TESTDATA, "-Users-wednesdayniemeyer-Documents-gniemeyer-Projects-codex"),
    join(TESTDATA, "-Users-wednesdayniemeyer--claude-skills-inspect-claude-source"),
    join(TESTDATA, "-Users-wednesdayniemeyer-Documents-gniemeyer-Projects-sprites"),
  ];

  let total = 0;
  for (const dir of dirs) {
    const sessions = listSessionFiles(dir);
    total += sessions.length;
  }
  assert(total > 5, `found ${total} sessions across 3 projects`);
  ok(`${total} total sessions`);
}

console.log("\n--- Session Discovery: routing ---");
{
  // Project routing with explicit projectDir
  const codexDir = join(TESTDATA, "-Users-wednesdayniemeyer-Documents-gniemeyer-Projects-codex");
  const projectResult = resolveSessionFiles({
    mode: "project",
    projectDir: codexDir,
  });
  assert(projectResult.sessions.length > 0, `project routing: ${projectResult.sessions.length} sessions`);
  assert(projectResult.totalCount === projectResult.sessions.length, "totalCount matches");
  ok("project routing works");

  // Project routing with subagents
  const withSubagents = resolveSessionFiles({
    mode: "project",
    projectDir: codexDir,
    includeSubagents: true,
  });
  assert(
    withSubagents.sessions.length > projectResult.sessions.length,
    `with subagents: ${withSubagents.sessions.length} > ${projectResult.sessions.length}`,
  );
  ok("subagent inclusion works");

  // Session routing by path
  const sessionPath = join(codexDir, "630fd2b9-d94d-4287-8c24-e225fbedfc5c.jsonl");
  const sessionResult = resolveSessionFiles({
    mode: "session",
    sessionId: sessionPath,
  });
  assert(sessionResult.sessions.length === 1, "session routing: found 1");
  assert(sessionResult.sessions[0].sessionId === "630fd2b9-d94d-4287-8c24-e225fbedfc5c", "correct session");
  ok("session routing works");

  // Pagination
  const paginated = resolveSessionFiles({
    mode: "project",
    projectDir: codexDir,
    limit: 1,
    offset: 0,
  });
  assert(paginated.sessions.length === 1, "pagination: 1 session");
  if (projectResult.totalCount > 1) {
    assert(paginated.hasMore, "pagination: has more");
    ok("pagination works");
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
