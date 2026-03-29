/**
 * Duncan Query Logger
 * 
 * Appends structured records to ~/.claude/duncan.jsonl for every query.
 * Captures tokens, latency, cache hits, routing strategy, and results.
 * Append-only JSONL — easy to process with standard tools.
 */

import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
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
    const claudeDir = join(homedir(), ".claude");
    if (!existsSync(claudeDir)) {
      mkdirSync(claudeDir, { recursive: true });
    }
    logPath = join(claudeDir, "duncan.jsonl");
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
 * Helper to create a log record from query context.
 */
export function buildLogRecord(opts: {
  batchId: string;
  question: string;
  answer: string;
  hasContext: boolean;
  targetSession: string;
  windowIndex: number;
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
