import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runFanout } from "../src/headless/fanout.js";
import { sampleProcessSet } from "../src/headless/resource-sampler.js";

async function fileSize(path: string): Promise<number> {
  const info = await stat(path);
  return info.size;
}

const root = await mkdtemp(join(tmpdir(), "duncan-cc-headless-memory-"));
const childScript = join(process.cwd(), "tests", "fixtures", "headless-memory-child.mjs");
const targets = Array.from({ length: 20 }, (_, i) => ({
  id: `target-${i}`,
  stageBytes: 64 * 1024 + i * 101,
  childMemoryMb: 4,
  childSleepMs: 180,
}));

const sweepResults: Array<Record<string, number | null>> = [];

for (const concurrency of [1, 5, 10, 20]) {
  const activePids = new Set<number>();
  let finished = false;

  const samplerPromise = sampleProcessSet(() => activePids, {
    intervalMs: 5,
    isDone: () => finished,
  });

  const result = await runFanout(targets, {
    concurrency,
    stageTarget: async (target, index) => {
      const stageDir = join(root, `c${concurrency}`, `stage-${index}`);
      const sessionFile = join(stageDir, "session.jsonl");
      await mkdir(stageDir, { recursive: true });
      const payload = `${target.id}:${"x".repeat(target.stageBytes - target.id.length - 1)}`;
      await writeFile(sessionFile, payload, "utf8");
      return {
        stage: { stageDir, sessionFile, expectedBytes: Buffer.byteLength(payload), target },
        stagedBytes: Buffer.byteLength(payload),
        stageDirCount: 1,
      };
    },
    runTarget: async (_target, staged, index) => {
      const child = spawn(process.execPath, [childScript, String(staged.target.childMemoryMb), String(staged.target.childSleepMs)], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (child.pid) activePids.add(child.pid);

      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });

      const exitCode = await new Promise<number>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (code) => resolve(code ?? -1));
      });
      if (child.pid) activePids.delete(child.pid);

      assert.equal(exitCode, 0, `child ${index} failed: ${stderr}`);
      const observedBytes = await fileSize(staged.sessionFile);
      assert.equal(observedBytes, staged.expectedBytes);
      return { ok: true, observedBytes, stdoutLength: stdout.length };
    },
  });

  finished = true;
  const sample = await samplerPromise;
  const totalObservedBytes = result.results.reduce((sum, entry) => sum + entry.observedBytes, 0);
  const stageTreeBytes = targets.reduce((sum, target) => sum + target.stageBytes, 0);

  assert.equal(result.metrics.targetCount, 20);
  assert.equal(result.metrics.spawnCount, 20);
  assert.equal(result.metrics.stageDirCount, 20);
  assert.equal(result.metrics.totalStagedBytes, totalObservedBytes);
  assert.ok(sample.maxObservedProcessCount <= concurrency, `observed ${sample.maxObservedProcessCount} active children with cap ${concurrency}`);
  assert.ok(sample.sampleCount > 0);
  assert.ok(result.metrics.totalStagedBytes >= stageTreeBytes);
  if (sample.peakAggregateRssBytes !== undefined) {
    assert.ok(sample.peakAggregateRssBytes > 0);
  }
  if (sample.peakAggregateVirtualBytes !== undefined) {
    assert.ok(sample.peakAggregateVirtualBytes > 0);
  }

  sweepResults.push({
    concurrency,
    wallTimeMs: result.metrics.wallTimeMs,
    peakProcesses: sample.maxObservedProcessCount,
    peakRssBytes: sample.peakAggregateRssBytes ?? null,
    peakVirtualBytes: sample.peakAggregateVirtualBytes ?? null,
    totalStagedBytes: result.metrics.totalStagedBytes,
  });
}

console.log("headless-fanout-memory.test.ts: ok", JSON.stringify(sweepResults));
