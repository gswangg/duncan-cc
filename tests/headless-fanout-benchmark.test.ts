import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { runFanout } from "../src/headless/fanout.js";

const root = await mkdtemp(join(tmpdir(), "duncan-cc-headless-fanout-"));
const targets = Array.from({ length: 20 }, (_, i) => ({
  id: `target-${i}`,
  bytes: 512 + i * 17,
  stageDelayMs: 2 + (i % 3),
  runDelayMs: 4 + (i % 4),
}));

let activeRuns = 0;
let observedPeakRuns = 0;

const result = await runFanout(targets, {
  concurrency: 4,
  stageTarget: async (target, index) => {
    const stageDir = join(root, `stage-${index}`);
    await mkdir(stageDir, { recursive: true });
    const payload = `${target.id}:${"x".repeat(target.bytes - target.id.length - 1)}`;
    await writeFile(join(stageDir, "session.jsonl"), payload, "utf8");
    await sleep(target.stageDelayMs);
    return {
      stage: { stageDir, sessionFile: join(stageDir, "session.jsonl"), payloadBytes: Buffer.byteLength(payload) },
      stagedBytes: Buffer.byteLength(payload),
      stageDirCount: 1,
    };
  },
  runTarget: async (target, staged, index) => {
    activeRuns += 1;
    observedPeakRuns = Math.max(observedPeakRuns, activeRuns);
    try {
      const content = await readFile(staged.sessionFile, "utf8");
      await sleep(target.runDelayMs);
      return {
        ok: true,
        index,
        targetId: target.id,
        stageDir: staged.stageDir,
        observedBytes: Buffer.byteLength(content),
      };
    } finally {
      activeRuns -= 1;
    }
  },
});

const expectedBytes = result.results.reduce((sum, entry) => sum + entry.observedBytes, 0);

assert.equal(result.results.length, 20);
assert.equal(result.metrics.targetCount, 20);
assert.equal(result.metrics.spawnCount, 20);
assert.equal(result.metrics.stageDirCount, 20);
assert.equal(result.metrics.totalStagedBytes, expectedBytes);
assert.ok(result.metrics.peakConcurrency <= 4, `fanout peak concurrency ${result.metrics.peakConcurrency} exceeded cap`);
assert.ok(observedPeakRuns <= 4, `run peak concurrency ${observedPeakRuns} exceeded cap`);
assert.ok(result.metrics.totalStageMs > 0);
assert.ok(result.metrics.totalRunMs > 0);
assert.ok(result.metrics.wallTimeMs > 0);
assert.ok(result.metrics.averageStageMs > 0);
assert.ok(result.metrics.averageRunMs > 0);

console.log("headless-fanout-benchmark.test.ts: ok", JSON.stringify({
  wallTimeMs: result.metrics.wallTimeMs,
  totalStagedBytes: result.metrics.totalStagedBytes,
  peakConcurrency: result.metrics.peakConcurrency,
  observedPeakRuns,
}));
