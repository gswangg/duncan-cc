import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveHeadlessExecutionCwd, resolveHeadlessSourceContext } from "../src/headless/source-context.js";

const root = await mkdtemp(join(tmpdir(), "duncan-cc-headless-source-context-"));
const liveProjectDir = join(root, "live-project");
await mkdir(liveProjectDir, { recursive: true });

const mainProjectDir = join(root, "project-main");
await mkdir(mainProjectDir, { recursive: true });
const mainSessionFile = join(mainProjectDir, "session-main.jsonl");
await writeFile(mainSessionFile, `${JSON.stringify({ type: "user", uuid: "u1", parentUuid: null, timestamp: new Date().toISOString(), sessionId: "session-main", cwd: liveProjectDir, message: { role: "user", content: "hi" } })}\n`, "utf8");

const mainContext = await resolveHeadlessSourceContext(mainSessionFile);
assert.equal(mainContext.sourceProjectDir, mainProjectDir);
assert.equal(mainContext.sourceSessionId, "session-main");
assert.equal(mainContext.originalCwd, liveProjectDir);
assert.equal(mainContext.isSubagentTranscript, false);
assert.equal(mainContext.shouldCopyToolResults, true);
assert.equal(mainContext.shouldCopySubagents, false);

const subagentProjectDir = join(root, "project-sub");
const subagentRootDir = join(subagentProjectDir, "session-root", "subagents", "worker-1");
await mkdir(subagentRootDir, { recursive: true });
const subagentFile = join(subagentRootDir, "agent-123.jsonl");
await writeFile(subagentFile, `${JSON.stringify({ type: "assistant", uuid: "a1", parentUuid: null, timestamp: new Date().toISOString(), sessionId: "session-root", cwd: liveProjectDir, message: { role: "assistant", content: [{ type: "text", text: "hello" }] } })}\n`, "utf8");

const subagentContext = await resolveHeadlessSourceContext(subagentFile);
assert.equal(subagentContext.sourceProjectDir, subagentProjectDir);
assert.equal(subagentContext.sourceSessionId, "session-root");
assert.equal(subagentContext.isSubagentTranscript, true);
assert.equal(subagentContext.shouldCopyToolResults, true);
assert.equal(subagentContext.shouldCopySubagents, true);

const fallbackDir = join(root, "fallback");
await mkdir(fallbackDir, { recursive: true });
assert.equal(await resolveHeadlessExecutionCwd(liveProjectDir, fallbackDir), liveProjectDir);
assert.equal(await resolveHeadlessExecutionCwd(join(root, "missing-cwd"), fallbackDir), fallbackDir);

console.log("headless-source-context.test.ts: ok");
