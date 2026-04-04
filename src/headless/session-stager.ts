import { randomUUID } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { parseJsonl } from "../parser.js";
import { renderJsonl, sliceEntriesForWindow, type SessionWindowBoundary } from "./session-boundaries.js";

export interface StageSessionRequest {
  sourceSessionFile: string;
  stageRootDir: string;
  window: SessionWindowBoundary;
  sourceProjectDir?: string;
  stageProjectSlug?: string;
  stagedSessionId?: string;
  rewriteEntrySessionIds?: boolean;
  copyToolResults?: boolean;
  copySubagents?: boolean;
}

export interface StageSessionResult {
  stageDir: string;
  stageProjectDir: string;
  stagedSessionFile: string;
  sourceSessionId: string;
  stagedSessionId: string;
  stats: {
    sourceBytes: number;
    stagedBytes: number;
    copiedToolResultFiles: number;
    copiedSubagentFiles: number;
  };
}

function replaceSessionIds(value: unknown, sourceSessionId: string, stagedSessionId: string): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => replaceSessionIds(entry, sourceSessionId, stagedSessionId));
  }
  if (!value || typeof value !== "object") {
    return value === sourceSessionId ? stagedSessionId : value;
  }
  const input = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, entryValue] of Object.entries(input)) {
    if ((key === "sessionId" || key === "session_id") && entryValue === sourceSessionId) {
      out[key] = stagedSessionId;
      continue;
    }
    out[key] = replaceSessionIds(entryValue, sourceSessionId, stagedSessionId);
  }
  if ("sessionId" in input || "session_id" in input) {
    const normalizedSessionId = (out.sessionId ?? out.session_id ?? input.sessionId ?? input.session_id) === sourceSessionId
      ? stagedSessionId
      : (out.sessionId ?? out.session_id ?? input.sessionId ?? input.session_id);
    out.sessionId = normalizedSessionId;
    out.session_id = normalizedSessionId;
  }
  return out;
}

async function countFiles(dir: string): Promise<number> {
  try {
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(dir, { withFileTypes: true });
    let count = 0;
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) count += await countFiles(path);
      else if (entry.isFile()) count += 1;
    }
    return count;
  } catch {
    return 0;
  }
}

export async function stageSession(request: StageSessionRequest): Promise<StageSessionResult> {
  const sourceProjectDir = request.sourceProjectDir ?? dirname(request.sourceSessionFile);
  const sourceSessionId = basename(request.sourceSessionFile, ".jsonl");
  const stagedSessionId = request.stagedSessionId ?? sourceSessionId;
  const rewriteEntrySessionIds = request.rewriteEntrySessionIds ?? stagedSessionId !== sourceSessionId;
  const stageProjectSlug = request.stageProjectSlug ?? basename(sourceProjectDir);
  const stageDir = join(request.stageRootDir, `stage-${randomUUID()}`);
  const stageProjectDir = join(stageDir, stageProjectSlug);
  const stagedSessionFile = join(stageProjectDir, `${stagedSessionId}.jsonl`);

  await mkdir(stageProjectDir, { recursive: true });

  const sourceContent = await readFile(request.sourceSessionFile, "utf8");
  const entries = parseJsonl(sourceContent);
  const sliced = sliceEntriesForWindow(entries, request.window).map((entry) =>
    rewriteEntrySessionIds ? replaceSessionIds(entry, sourceSessionId, stagedSessionId) : entry,
  );
  const stagedContent = renderJsonl(sliced as any[]);
  await writeFile(stagedSessionFile, stagedContent, "utf8");

  let copiedToolResultFiles = 0;
  if (request.copyToolResults !== false) {
    const sourceToolResults = join(sourceProjectDir, sourceSessionId, "tool-results");
    const stagedToolResults = join(stageProjectDir, stagedSessionId, "tool-results");
    try {
      await mkdir(join(stageProjectDir, stagedSessionId), { recursive: true });
      await cp(sourceToolResults, stagedToolResults, { recursive: true, force: true });
      copiedToolResultFiles = await countFiles(stagedToolResults);
    } catch {
      copiedToolResultFiles = 0;
    }
  }

  let copiedSubagentFiles = 0;
  if (request.copySubagents) {
    const sourceSubagents = join(sourceProjectDir, sourceSessionId, "subagents");
    const stagedSubagents = join(stageProjectDir, stagedSessionId, "subagents");
    try {
      await mkdir(join(stageProjectDir, stagedSessionId), { recursive: true });
      await cp(sourceSubagents, stagedSubagents, { recursive: true, force: true });
      copiedSubagentFiles = await countFiles(stagedSubagents);
    } catch {
      copiedSubagentFiles = 0;
    }
  }

  return {
    stageDir,
    stageProjectDir,
    stagedSessionFile,
    sourceSessionId,
    stagedSessionId,
    stats: {
      sourceBytes: Buffer.byteLength(sourceContent),
      stagedBytes: Buffer.byteLength(stagedContent),
      copiedToolResultFiles,
      copiedSubagentFiles,
    },
  };
}
