import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ProcessMemoryUsage {
  rssBytes?: number;
  virtualBytes?: number;
}

export interface ProcessSampleSnapshot {
  timestamp: number;
  processCount: number;
  aggregateRssBytes?: number;
  aggregateVirtualBytes?: number;
}

export interface SampleProcessSetResult {
  samples: ProcessSampleSnapshot[];
  sampleCount: number;
  maxObservedProcessCount: number;
  peakAggregateRssBytes?: number;
  peakAggregateVirtualBytes?: number;
}

function parseStatusKb(text: string, key: "VmRSS" | "VmSize"): number | undefined {
  const match = text.match(new RegExp(`^${key}:\\s+(\\d+)\\s+kB$`, "m"));
  return match ? Number(match[1]) * 1024 : undefined;
}

export async function readProcessMemoryUsage(pid: number): Promise<ProcessMemoryUsage | undefined> {
  try {
    const status = await readFile(`/proc/${pid}/status`, "utf8");
    return {
      rssBytes: parseStatusKb(status, "VmRSS"),
      virtualBytes: parseStatusKb(status, "VmSize"),
    };
  } catch {
    // fall through
  }

  try {
    const { stdout } = await execFileAsync("ps", ["-o", "rss=,vsz=", "-p", String(pid)], { timeout: 2000 });
    const [rssKb, vszKb] = stdout.trim().split(/\s+/).map((value) => Number(value));
    if (!Number.isFinite(rssKb) && !Number.isFinite(vszKb)) return undefined;
    return {
      rssBytes: Number.isFinite(rssKb) ? rssKb * 1024 : undefined,
      virtualBytes: Number.isFinite(vszKb) ? vszKb * 1024 : undefined,
    };
  } catch {
    return undefined;
  }
}

export async function sampleProcessSet(
  getPids: () => Iterable<number>,
  options: {
    intervalMs?: number;
    isDone: () => boolean;
  },
): Promise<SampleProcessSetResult> {
  const intervalMs = options.intervalMs ?? 10;
  const samples: ProcessSampleSnapshot[] = [];
  let maxObservedProcessCount = 0;
  let peakAggregateRssBytes: number | undefined;
  let peakAggregateVirtualBytes: number | undefined;

  while (true) {
    const pids = [...getPids()].filter((pid) => Number.isInteger(pid) && pid > 0);
    maxObservedProcessCount = Math.max(maxObservedProcessCount, pids.length);

    let aggregateRssBytes = 0;
    let aggregateVirtualBytes = 0;
    let sawRss = false;
    let sawVirtual = false;

    const usages = await Promise.all(pids.map((pid) => readProcessMemoryUsage(pid)));
    for (const usage of usages) {
      if (!usage) continue;
      if (typeof usage.rssBytes === "number") {
        aggregateRssBytes += usage.rssBytes;
        sawRss = true;
      }
      if (typeof usage.virtualBytes === "number") {
        aggregateVirtualBytes += usage.virtualBytes;
        sawVirtual = true;
      }
    }

    const snapshot: ProcessSampleSnapshot = {
      timestamp: Date.now(),
      processCount: pids.length,
      aggregateRssBytes: sawRss ? aggregateRssBytes : undefined,
      aggregateVirtualBytes: sawVirtual ? aggregateVirtualBytes : undefined,
    };
    samples.push(snapshot);

    if (typeof snapshot.aggregateRssBytes === "number") {
      peakAggregateRssBytes = Math.max(peakAggregateRssBytes ?? 0, snapshot.aggregateRssBytes);
    }
    if (typeof snapshot.aggregateVirtualBytes === "number") {
      peakAggregateVirtualBytes = Math.max(peakAggregateVirtualBytes ?? 0, snapshot.aggregateVirtualBytes);
    }

    if (options.isDone()) break;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  return {
    samples,
    sampleCount: samples.length,
    maxObservedProcessCount,
    peakAggregateRssBytes,
    peakAggregateVirtualBytes,
  };
}
