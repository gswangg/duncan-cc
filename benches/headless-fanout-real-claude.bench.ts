import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseJsonl } from "../src/parser.js";
import { runFanout } from "../src/headless/fanout.js";
import { sampleProcessSet } from "../src/headless/resource-sampler.js";
import { deriveSessionWindowsFromEntries } from "../src/headless/session-boundaries.js";
import { stageSession } from "../src/headless/session-stager.js";
import { runClaudeHeadless } from "../src/headless/claude-runner.js";
import { requireCorpus } from "../tests/_skip-if-no-corpus.js";

function parseClaudeJson(stdout: string): any {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`Failed to parse Claude JSON output: ${String(error)}\nSTDOUT:\n${stdout}`);
  }
}

const corpus = requireCorpus();
const sourceSessionFile = join(
  corpus,
  "-Users-wednesdayniemeyer--claude-skills-inspect-claude-source",
  "28e532ae-cb50-4f6f-9f08-914cbf6563b7.jsonl",
);
const sourceProjectDir = join(corpus, "-Users-wednesdayniemeyer--claude-skills-inspect-claude-source");
const sourceEntries = parseJsonl(await readFile(sourceSessionFile, "utf8"));
const windows = deriveSessionWindowsFromEntries(sourceEntries);
assert.ok(windows.length >= 1, "expected at least one stageable window");

const prompt = "Reply with exactly: pong";
const root = await mkdtemp(join(tmpdir(), "duncan-cc-real-claude-fanout-"));
const model = process.env.DUNCAN_CC_REAL_BENCH_MODEL ?? "sonnet";
const concurrencySweep = (process.env.DUNCAN_CC_REAL_BENCH_CONCURRENCIES ?? "5")
  .split(",")
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isInteger(value) && value > 0);
assert.ok(concurrencySweep.length > 0, "expected at least one valid concurrency value");
const sweepResults: Array<Record<string, number | string | null>> = [];

for (const concurrency of concurrencySweep) {
  console.log(`running real Claude fanout benchmark at concurrency=${concurrency}`);
  const targets = Array.from({ length: concurrency }, (_, i) => ({ id: `c${concurrency}-target-${i}` }));
  const activePids = new Set<number>();
  let finished = false;
  const samplerPromise = sampleProcessSet(() => activePids, {
    intervalMs: 10,
    isDone: () => finished,
  });

  const result = await runFanout(targets, {
    concurrency,
    stageTarget: async (_target, index) => {
      const stage = await stageSession({
        sourceSessionFile,
        sourceProjectDir,
        stageRootDir: join(root, `c${concurrency}`),
        stageProjectSlug: `project-${concurrency}`,
        window: windows[0]!,
        copyToolResults: false,
        copySubagents: false,
      });
      const stagedStat = await stat(stage.stagedSessionFile);
      return {
        stage,
        stagedBytes: stagedStat.size,
        stageDirCount: 1,
      };
    },
    runTarget: async (_target, stage, index) => {
      const bench = await runClaudeHeadless({
        cwd: stage.stageProjectDir,
        resume: stage.stagedSessionFile,
        prompt,
        outputFormat: "json",
        timeoutMs: 180000,
        extraArgs: ["--model", model, "--tools", "", "--effort", "low"],
        onSpawn: (pid) => activePids.add(pid),
      });
      if (bench.pid) activePids.delete(bench.pid);
      assert.equal(bench.ok, true, `real claude run ${index} failed: ${bench.stderr || bench.stdout}`);
      const parsed = parseClaudeJson(bench.stdout);
      assert.equal(String(parsed.result).trim(), "pong", `unexpected result for concurrency ${concurrency}: ${parsed.result}`);
      return {
        ok: true,
        durationMs: bench.durationMs,
        totalCostUsd: typeof parsed.total_cost_usd === "number" ? parsed.total_cost_usd : null,
        inputTokens: parsed.usage?.input_tokens ?? null,
        outputTokens: parsed.usage?.output_tokens ?? null,
      };
    },
  });

  finished = true;
  const sample = await samplerPromise;
  const totalCostUsd = result.results.reduce((sum, entry) => sum + (typeof entry.totalCostUsd === "number" ? entry.totalCostUsd : 0), 0);
  const maxDurationMs = result.results.reduce((max, entry) => Math.max(max, entry.durationMs), 0);

  assert.equal(result.metrics.targetCount, concurrency);
  assert.equal(result.metrics.spawnCount, concurrency);
  assert.ok(sample.maxObservedProcessCount <= concurrency, `observed ${sample.maxObservedProcessCount} active Claude subprocesses with cap ${concurrency}`);
  if (sample.peakAggregateRssBytes !== undefined) {
    assert.ok(sample.peakAggregateRssBytes > 0);
  }
  if (sample.peakAggregateVirtualBytes !== undefined) {
    assert.ok(sample.peakAggregateVirtualBytes > 0);
  }

  sweepResults.push({
    concurrency,
    model,
    wallTimeMs: result.metrics.wallTimeMs,
    maxSingleRunMs: maxDurationMs,
    peakProcesses: sample.maxObservedProcessCount,
    peakRssBytes: sample.peakAggregateRssBytes ?? null,
    peakVirtualBytes: sample.peakAggregateVirtualBytes ?? null,
    totalStagedBytes: result.metrics.totalStagedBytes,
    totalCostUsd: Number(totalCostUsd.toFixed(6)),
  });
}

console.log("headless-fanout-real-claude.bench.ts: ok", JSON.stringify(sweepResults));
