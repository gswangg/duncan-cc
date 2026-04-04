import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { deriveSessionWindowsFromEntries } from "../src/headless/session-boundaries.js";
import { stageSession } from "../src/headless/session-stager.js";

const root = await mkdtemp(join(tmpdir(), "duncan-cc-headless-stage-"));
const sourceProjectDir = join(root, "project-src");
const sourceSessionId = "session-src";
const sourceSessionFile = join(sourceProjectDir, `${sourceSessionId}.jsonl`);

await mkdir(join(sourceProjectDir, sourceSessionId, "tool-results"), { recursive: true });
await writeFile(join(sourceProjectDir, sourceSessionId, "tool-results", "tool-1.txt"), "large output\n", "utf8");

const entries = [
  { type: "user", uuid: "u1", parentUuid: null, timestamp: new Date().toISOString(), sessionId: sourceSessionId, session_id: sourceSessionId, message: { role: "user", content: "before compact" } },
  { type: "assistant", uuid: "a1", parentUuid: "u1", timestamp: new Date().toISOString(), sessionId: sourceSessionId, message: { role: "assistant", content: [{ type: "text", text: "reply" }] } },
  { type: "system", subtype: "compact_boundary", uuid: "b1", parentUuid: null, timestamp: new Date().toISOString(), sessionId: sourceSessionId, message: { role: "system", content: "compact" } },
  { type: "user", uuid: "u2", parentUuid: "b1", timestamp: new Date().toISOString(), sessionId: sourceSessionId, message: { role: "user", content: "after compact" } },
];
await writeFile(sourceSessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");

const windows = deriveSessionWindowsFromEntries(entries);
assert.equal(windows.length, 2);

const fullStage = await stageSession({
  sourceSessionFile,
  sourceProjectDir,
  stageRootDir: join(root, "staged"),
  window: windows[0]!,
});

assert.equal(fullStage.stagedSessionId, sourceSessionId);
assert.ok(fullStage.stagedSessionFile.endsWith(`${fullStage.stagedSessionId}.jsonl`));
const fullStageContent = await readFile(fullStage.stagedSessionFile, "utf8");
assert.equal(fullStageContent.trim().split("\n").length, 2);
assert.ok(fullStage.stats.copiedToolResultFiles >= 1);
const stagedToolResult = await readFile(join(fullStage.stageProjectDir, fullStage.stagedSessionId, "tool-results", "tool-1.txt"), "utf8");
assert.equal(stagedToolResult, "large output\n");
const fullStageEntries = fullStageContent.trim().split("\n").map((line) => JSON.parse(line));
assert.equal(fullStageEntries[0].sessionId, sourceSessionId);
assert.equal(fullStageEntries[0].session_id, sourceSessionId);

const sourceContentAfterStage = await readFile(sourceSessionFile, "utf8");
assert.equal(sourceContentAfterStage.trim().split("\n").length, 4);
assert.match(sourceContentAfterStage, /session-src/);

const compactStage = await stageSession({
  sourceSessionFile,
  sourceProjectDir,
  stageRootDir: join(root, "staged-compact"),
  window: windows[1]!,
});
const compactStageEntries = fullStageContent ? (await readFile(compactStage.stagedSessionFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line)) : [];
assert.equal(compactStageEntries.length, 2);
assert.equal(compactStageEntries[0].subtype, "compact_boundary");
assert.equal(compactStageEntries[0].sessionId, compactStage.stagedSessionId);
assert.equal(compactStageEntries[0].session_id, undefined);

const rewrittenStage = await stageSession({
  sourceSessionFile,
  sourceProjectDir,
  stageRootDir: join(root, "staged-rewritten"),
  window: windows[1]!,
  stagedSessionId: "session-rewritten",
  rewriteEntrySessionIds: true,
});
const rewrittenEntries = (await readFile(rewrittenStage.stagedSessionFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
assert.equal(rewrittenStage.stagedSessionId, "session-rewritten");
assert.equal(rewrittenEntries[0].sessionId, "session-rewritten");
assert.equal(rewrittenEntries[0].session_id, "session-rewritten");

console.log("headless-stager.test.ts: ok");
