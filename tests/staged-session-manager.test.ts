import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { deriveSessionWindowsFromEntries } from "../src/headless/session-boundaries.js";
import { StagedSessionManager } from "../src/headless/staged-session-manager.js";

const root = await mkdtemp(join(tmpdir(), "duncan-cc-stage-manager-"));
const stageRootDir = join(root, "stages");
const sourceProjectDir = join(root, "project-src");
const sourceSessionId = "session-src";
const sourceSessionFile = join(sourceProjectDir, `${sourceSessionId}.jsonl`);

await mkdir(join(sourceProjectDir, sourceSessionId, "tool-results"), { recursive: true });
await writeFile(join(sourceProjectDir, sourceSessionId, "tool-results", "tool-1.txt"), "out\n", "utf8");

const entries = [
  { type: "user", uuid: "u1", parentUuid: null, timestamp: new Date().toISOString(), sessionId: sourceSessionId, message: { role: "user", content: "hello" } },
  { type: "assistant", uuid: "a1", parentUuid: "u1", timestamp: new Date().toISOString(), sessionId: sourceSessionId, message: { role: "assistant", content: [{ type: "text", text: "hi" }] } },
];
await writeFile(sourceSessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");

const windows = deriveSessionWindowsFromEntries(entries);
const manager = new StagedSessionManager({ stageRootDir, gcMaxAgeMs: 1_000 });
const handle = await manager.createStage({
  sourceSessionFile,
  sourceProjectDir,
  window: windows[0]!,
});

const manifestText = await readFile(handle.manifestPath, "utf8");
assert.match(manifestText, /sourceSessionFile/);
await stat(handle.stage.stagedSessionFile);
await handle.cleanup();
await assert.rejects(() => stat(handle.stage.stageDir));

const stale = await manager.createStage({
  sourceSessionFile,
  sourceProjectDir,
  window: windows[0]!,
});
const staleTime = new Date(Date.now() - 10_000);
await utimes(join(stageRootDir, (await readdirSafe(stageRootDir))[0]!), staleTime, staleTime);
const removed = await manager.garbageCollect(Date.now());
assert.ok(removed >= 1);
await stale.cleanup();

console.log("staged-session-manager.test.ts: ok");

async function readdirSafe(dir: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  return await readdir(dir);
}
