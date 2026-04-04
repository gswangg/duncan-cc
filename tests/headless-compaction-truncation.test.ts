import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { deriveSessionWindowsFromEntries, renderJsonl, validateSessionWindow } from "../src/headless/session-boundaries.js";
import { stageSession } from "../src/headless/session-stager.js";

const sessionId = "session-src";

const entries = [
  { type: "user", uuid: "u1", parentUuid: null, timestamp: new Date().toISOString(), sessionId, message: { role: "user", content: "before 1" } },
  { type: "assistant", uuid: "a1", parentUuid: "u1", timestamp: new Date().toISOString(), sessionId, message: { role: "assistant", content: [{ type: "text", text: "reply 1" }], model: "claude-sonnet-4" } },
  { type: "system", subtype: "compact_boundary", uuid: "b1", parentUuid: null, timestamp: new Date().toISOString(), sessionId, message: { role: "system", content: "compact 1" }, compactMetadata: { preservedSegment: { headUuid: "u1", tailUuid: "a1", anchorUuid: "b1" } } },
  { type: "summary", leafUuid: "b1", summary: "summary 1" },
  { type: "user", uuid: "u2", parentUuid: "b1", timestamp: new Date().toISOString(), sessionId, message: { role: "user", content: "after 1" } },
  { type: "assistant", uuid: "a2", parentUuid: "u2", timestamp: new Date().toISOString(), sessionId, message: { role: "assistant", content: [{ type: "text", text: "reply 2" }], model: "claude-opus-4-1" } },
  { type: "system", subtype: "compact_boundary", uuid: "b2", parentUuid: null, timestamp: new Date().toISOString(), sessionId, message: { role: "system", content: "compact 2" } },
  { type: "summary", leafUuid: "b2", summary: "summary 2" },
  { type: "content-replacement", sessionId, replacements: [{ kind: "tool_result", toolUseId: "toolu_123", replacement: "trimmed" }] },
  { type: "user", uuid: "u3", parentUuid: "b2", timestamp: new Date().toISOString(), sessionId, message: { role: "user", content: "after 2" } },
];

{
  const noCompactionEntries = entries.slice(0, 2);
  const windows = deriveSessionWindowsFromEntries(noCompactionEntries);
  assert.equal(windows.length, 1);
  assert.equal(windows[0]?.kind, "full");
  assert.equal(windows[0]?.startEntryIndex, 0);
  assert.equal(windows[0]?.endEntryIndex, 2);
}

const windows = deriveSessionWindowsFromEntries(entries);
assert.equal(windows.length, 3);
assert.deepEqual(windows.map((window) => [window.kind, window.startEntryIndex, window.endEntryIndex]), [
  ["full", 0, 2],
  ["compaction", 2, 6],
  ["compaction", 6, 10],
]);

assert.throws(() => validateSessionWindow(entries, {
  windowIndex: 1,
  kind: "compaction",
  startEntryIndex: 3,
  endEntryIndex: 6,
  includesCompactBoundary: true,
}), /Compaction window must start/);

assert.throws(() => validateSessionWindow(entries, {
  windowIndex: 1,
  kind: "compaction",
  startEntryIndex: 2,
  endEntryIndex: 2,
  includesCompactBoundary: true,
}), /out of bounds/);

const root = await mkdtemp(join(tmpdir(), "duncan-cc-headless-compaction-"));
const sourceProjectDir = join(root, "project-src");
const sourceSessionFile = join(sourceProjectDir, `${sessionId}.jsonl`);
await mkdir(sourceProjectDir, { recursive: true });
const sourceContent = renderJsonl(entries);
await writeFile(sourceSessionFile, sourceContent, "utf8");

const stage = await stageSession({
  sourceSessionFile,
  sourceProjectDir,
  stageRootDir: join(root, "staged"),
  window: windows[1]!,
  stagedSessionId: sessionId,
  copyToolResults: false,
  copySubagents: false,
});

const stagedContent = await readFile(stage.stagedSessionFile, "utf8");
const expectedContent = renderJsonl(entries.slice(windows[1]!.startEntryIndex, windows[1]!.endEntryIndex));
assert.equal(stagedContent, expectedContent);
assert.match(stagedContent, /compact_boundary/);
assert.match(stagedContent, /"summary 1"/);
assert.doesNotMatch(stagedContent, /"summary 2"/);
assert.doesNotMatch(stagedContent, /"after 2"/);

console.log("headless-compaction-truncation.test.ts: ok");
