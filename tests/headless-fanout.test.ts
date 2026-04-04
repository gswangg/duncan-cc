import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";

import { runFanout } from "../src/headless/fanout.js";

const targets = Array.from({ length: 20 }, (_, i) => ({ id: `target-${i}`, bytes: 100 + i }));

const result = await runFanout(targets, {
  concurrency: 5,
  stageTarget: async (target, index) => {
    await sleep(2);
    return {
      stage: { stageId: `stage-${index}`, targetId: target.id },
      stagedBytes: target.bytes,
      stageDirCount: 1,
    };
  },
  runTarget: async (target, staged, index) => {
    await sleep(4);
    return { ok: true, targetId: target.id, stageId: staged.stageId, index };
  },
});

assert.equal(result.results.length, 20);
assert.equal(result.metrics.targetCount, 20);
assert.equal(result.metrics.spawnCount, 20);
assert.equal(result.metrics.stageDirCount, 20);
assert.equal(result.metrics.totalStagedBytes, targets.reduce((sum, target) => sum + target.bytes, 0));
assert.ok(result.metrics.peakConcurrency <= 5, `peak concurrency ${result.metrics.peakConcurrency} exceeded cap`);
assert.ok(result.metrics.peakConcurrency >= 2, `expected some parallelism, got ${result.metrics.peakConcurrency}`);
assert.ok(result.metrics.wallTimeMs >= 20, `expected measurable wall time, got ${result.metrics.wallTimeMs}`);
assert.ok(result.metrics.averageStageMs >= 0);
assert.ok(result.metrics.averageRunMs >= 0);

console.log("headless-fanout.test.ts: ok");
