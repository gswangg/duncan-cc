export interface FanoutMetrics {
  targetCount: number;
  spawnCount: number;
  stageDirCount: number;
  totalStagedBytes: number;
  peakConcurrency: number;
  wallTimeMs: number;
  totalStageMs: number;
  totalRunMs: number;
  averageStageMs: number;
  averageRunMs: number;
}

export interface StageFanoutResult<TStage> {
  stage: TStage;
  stagedBytes: number;
  stageDirCount?: number;
}

export interface FanoutResult<TResult> {
  results: TResult[];
  metrics: FanoutMetrics;
}

export async function runFanout<TTarget, TStage, TResult>(
  targets: TTarget[],
  options: {
    concurrency: number;
    stageTarget: (target: TTarget, index: number) => Promise<StageFanoutResult<TStage>>;
    runTarget: (target: TTarget, staged: TStage, index: number) => Promise<TResult>;
  },
): Promise<FanoutResult<TResult>> {
  const concurrency = Math.max(1, options.concurrency);
  const results = new Array<TResult>(targets.length);
  let nextIndex = 0;
  let active = 0;
  let peakConcurrency = 0;
  let spawnCount = 0;
  let stageDirCount = 0;
  let totalStagedBytes = 0;
  let totalStageMs = 0;
  let totalRunMs = 0;
  const wallStart = Date.now();

  const worker = async () => {
    while (true) {
      const currentIndex = nextIndex;
      if (currentIndex >= targets.length) return;
      nextIndex += 1;
      const target = targets[currentIndex]!;
      active += 1;
      peakConcurrency = Math.max(peakConcurrency, active);
      try {
        const stageStart = Date.now();
        const staged = await options.stageTarget(target, currentIndex);
        totalStageMs += Date.now() - stageStart;
        totalStagedBytes += staged.stagedBytes;
        stageDirCount += staged.stageDirCount ?? 1;

        const runStart = Date.now();
        const result = await options.runTarget(target, staged.stage, currentIndex);
        totalRunMs += Date.now() - runStart;
        spawnCount += 1;
        results[currentIndex] = result;
      } finally {
        active -= 1;
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, () => worker()));

  return {
    results,
    metrics: {
      targetCount: targets.length,
      spawnCount,
      stageDirCount,
      totalStagedBytes,
      peakConcurrency,
      wallTimeMs: Date.now() - wallStart,
      totalStageMs,
      totalRunMs,
      averageStageMs: targets.length > 0 ? totalStageMs / targets.length : 0,
      averageRunMs: targets.length > 0 ? totalRunMs / targets.length : 0,
    },
  };
}
