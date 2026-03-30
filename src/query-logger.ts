/**
 * Duncan Query Logger
 * 
 * Appends structured records to ~/.claude/duncan.jsonl for every query.
 * Captures tokens, latency, cache hits, routing strategy, and results.
 * Append-only JSONL — easy to process with standard tools.
 * 
 * Override log path with DUNCAN_LOG env var.
 */

import { appendFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

// ============================================================================
// Types
// ============================================================================

export interface DuncanLogRecord {
  /** Batch ID grouping related queries */
  batchId: string;
  /** The question asked */
  question: string;
  /** The answer returned */
  answer: string;
  /** Whether the session had relevant context */
  hasContext: boolean;
  /** Target session ID */
  targetSession: string;
  /** Window index within the session */
  windowIndex: number;
  /** Window type: main (active), compaction (prior), or subagent */
  windowType: string;
  /** Source session ID (the calling session, if known) */
  sourceSession: string | null;
  /** Routing strategy used */
  strategy: string;
  /** Model used for the query */
  model: string;
  /** Input tokens consumed */
  inputTokens: number;
  /** Output tokens generated */
  outputTokens: number;
  /** Cache creation input tokens */
  cacheCreationInputTokens: number;
  /** Cache read input tokens */
  cacheReadInputTokens: number;
  /** Query latency in milliseconds */
  latencyMs: number;
  /** ISO timestamp */
  timestamp: string;
}

// ============================================================================
// Logger
// ============================================================================

let logPath: string | null = null;

function getLogPath(): string {
  if (!logPath) {
    // Allow override via env var
    if (process.env.DUNCAN_LOG) {
      logPath = process.env.DUNCAN_LOG;
      const dir = dirname(logPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    } else {
      const claudeDir = join(homedir(), ".claude");
      if (!existsSync(claudeDir)) {
        mkdirSync(claudeDir, { recursive: true });
      }
      logPath = join(claudeDir, "duncan.jsonl");
    }
  }
  return logPath;
}

/**
 * Record a single query result to the log file.
 */
export function recordQuery(record: DuncanLogRecord): void {
  try {
    const line = JSON.stringify(record) + "\n";
    appendFileSync(getLogPath(), line, "utf-8");
  } catch {
    // Logging is best-effort — don't let it break queries
  }
}

/**
 * Read all query log records from the log file.
 * Returns empty array if file doesn't exist or is unreadable.
 */
export function readQueryLog(path?: string): DuncanLogRecord[] {
  const logFile = path ?? getLogPath();
  try {
    if (!existsSync(logFile)) return [];
    const content = readFileSync(logFile, "utf-8");
    const records: DuncanLogRecord[] = [];
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line));
      } catch {}
    }
    return records;
  } catch {
    return [];
  }
}

/**
 * Helper to create a log record from query context.
 */
export function buildLogRecord(opts: {
  batchId: string;
  question: string;
  answer: string;
  hasContext: boolean;
  targetSession: string;
  windowIndex: number;
  windowType?: string;
  sourceSession?: string | null;
  strategy: string;
  model: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  latencyMs: number;
}): DuncanLogRecord {
  return {
    batchId: opts.batchId,
    question: opts.question,
    answer: opts.answer,
    hasContext: opts.hasContext,
    targetSession: opts.targetSession,
    windowIndex: opts.windowIndex,
    windowType: opts.windowType ?? "main",
    sourceSession: opts.sourceSession ?? null,
    strategy: opts.strategy,
    model: opts.model,
    inputTokens: opts.usage?.input_tokens ?? 0,
    outputTokens: opts.usage?.output_tokens ?? 0,
    cacheCreationInputTokens: opts.usage?.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: opts.usage?.cache_read_input_tokens ?? 0,
    latencyMs: opts.latencyMs,
    timestamp: new Date().toISOString(),
  };
}
