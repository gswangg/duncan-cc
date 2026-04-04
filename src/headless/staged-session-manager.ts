import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { stageSession, type StageSessionRequest, type StageSessionResult } from "./session-stager.js";

export interface StagedSessionHandle {
  stage: StageSessionResult;
  manifestPath: string;
  cleanup: () => Promise<void>;
}

export interface StagedSessionManagerOptions {
  stageRootDir?: string;
  gcMaxAgeMs?: number;
}

interface StageManifest {
  createdAt: string;
  sourceSessionFile: string;
  stageDir: string;
  stagedSessionFile: string;
}

export class StagedSessionManager {
  readonly stageRootDir: string;
  readonly gcMaxAgeMs: number;

  constructor(options: StagedSessionManagerOptions = {}) {
    this.stageRootDir = options.stageRootDir ?? join(tmpdir(), "duncan-cc-headless-stage");
    this.gcMaxAgeMs = options.gcMaxAgeMs ?? 6 * 60 * 60 * 1000;
  }

  async createStage(request: Omit<StageSessionRequest, "stageRootDir">): Promise<StagedSessionHandle> {
    await mkdir(this.stageRootDir, { recursive: true });
    await this.garbageCollect();
    const isolatedRoot = await mkdtemp(join(this.stageRootDir, "run-"));
    const stage = await stageSession({
      ...request,
      stageRootDir: isolatedRoot,
    });
    const manifestPath = join(stage.stageDir, "stage-manifest.json");
    const manifest: StageManifest = {
      createdAt: new Date().toISOString(),
      sourceSessionFile: request.sourceSessionFile,
      stageDir: stage.stageDir,
      stagedSessionFile: stage.stagedSessionFile,
    };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    return {
      stage,
      manifestPath,
      cleanup: async () => {
        await rm(isolatedRoot, { recursive: true, force: true });
      },
    };
  }

  async garbageCollect(now = Date.now()): Promise<number> {
    let removed = 0;
    const entries = await readdir(this.stageRootDir, { withFileTypes: true }).catch(() => [] as any[]);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = join(this.stageRootDir, entry.name);
      try {
        const info = await stat(candidate);
        if (now - info.mtimeMs > this.gcMaxAgeMs) {
          await rm(candidate, { recursive: true, force: true });
          removed += 1;
          continue;
        }
        const nested = await readdir(candidate, { withFileTypes: true }).catch(() => [] as any[]);
        for (const child of nested) {
          if (!child.isDirectory()) continue;
          const manifestPath = join(candidate, child.name, "stage-manifest.json");
          const manifestText = await readFile(manifestPath, "utf8").catch(() => "");
          if (!manifestText) continue;
          const manifest = JSON.parse(manifestText) as StageManifest;
          const createdAt = Date.parse(manifest.createdAt);
          if (Number.isFinite(createdAt) && now - createdAt > this.gcMaxAgeMs) {
            await rm(candidate, { recursive: true, force: true });
            removed += 1;
            break;
          }
        }
      } catch {
        // best effort
      }
    }
    return removed;
  }
}

export function getDefaultStageProjectSlug(sourceSessionFile: string): string {
  return basename(sourceSessionFile, ".jsonl");
}
