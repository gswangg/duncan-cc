import { access, readFile, stat } from "node:fs/promises";
import { basename, dirname, sep } from "node:path";

import { parseJsonl } from "../parser.js";

export interface HeadlessSourceContext {
  sourceProjectDir: string;
  sourceSessionId: string;
  originalCwd?: string;
  isSubagentTranscript: boolean;
  shouldCopyToolResults: boolean;
  shouldCopySubagents: boolean;
}

function inferSourceProjectDir(sessionFile: string, sourceSessionId: string): { sourceProjectDir: string; isSubagentTranscript: boolean } {
  const subagentNeedle = `${sep}${sourceSessionId}${sep}subagents${sep}`;
  const explicitIdx = sessionFile.indexOf(subagentNeedle);
  if (explicitIdx !== -1) {
    return {
      sourceProjectDir: sessionFile.slice(0, explicitIdx),
      isSubagentTranscript: true,
    };
  }

  const genericNeedle = `${sep}subagents${sep}`;
  const genericIdx = sessionFile.indexOf(genericNeedle);
  if (genericIdx !== -1) {
    const beforeSubagents = sessionFile.slice(0, genericIdx);
    return {
      sourceProjectDir: dirname(beforeSubagents),
      isSubagentTranscript: true,
    };
  }

  return {
    sourceProjectDir: dirname(sessionFile),
    isSubagentTranscript: false,
  };
}

export async function resolveHeadlessSourceContext(sessionFile: string): Promise<HeadlessSourceContext> {
  const content = await readFile(sessionFile, "utf8");
  const entries = parseJsonl(content);
  const firstEntryWithSession = entries.find((entry) => typeof entry?.sessionId === "string" || typeof entry?.session_id === "string");
  const firstEntryWithCwd = entries.find((entry) => typeof entry?.cwd === "string");
  const sourceSessionId = firstEntryWithSession?.sessionId ?? firstEntryWithSession?.session_id ?? basename(sessionFile, ".jsonl");
  const originalCwd = typeof firstEntryWithCwd?.cwd === "string" ? firstEntryWithCwd.cwd : undefined;
  const inferred = inferSourceProjectDir(sessionFile, sourceSessionId);

  return {
    sourceProjectDir: inferred.sourceProjectDir,
    sourceSessionId,
    originalCwd,
    isSubagentTranscript: inferred.isSubagentTranscript,
    shouldCopyToolResults: true,
    shouldCopySubagents: inferred.isSubagentTranscript,
  };
}

export async function resolveHeadlessExecutionCwd(preferredCwd: string | undefined, fallbackCwd: string): Promise<string> {
  if (preferredCwd) {
    try {
      await access(preferredCwd);
      const info = await stat(preferredCwd);
      if (info.isDirectory()) {
        return preferredCwd;
      }
    } catch {
      // fall through
    }
  }
  return fallbackCwd;
}
