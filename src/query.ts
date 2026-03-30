/**
 * Duncan Query Dispatch
 * 
 * Queries CC sessions using the Anthropic API with structured output
 * via the duncan_response tool.
 */

import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { homedir, platform, userInfo } from "node:os";
import { processSessionFile, processSessionWindows, type PipelineResult, type WindowPipelineResult } from "./pipeline.js";
import { resolveSessionFiles, findCallingSession, listAllSessionFiles, listSubagentFiles, type RoutingParams, type RoutingResult } from "./discovery.js";
import { recordQuery, buildLogRecord } from "./query-logger.js";

// ============================================================================
// OAuth token resolution
// ============================================================================

/**
 * Resolve Anthropic auth from:
 * 1. Explicit apiKey/token parameter
 * 2. CC's OAuth credentials (~/.claude/.credentials.json)
 * 3. ANTHROPIC_API_KEY env var
 */



interface ResolvedAuth {
  apiKey?: string | null;
  authToken?: string;
  defaultHeaders?: Record<string, string>;
}

/**
 * Read an OAuth token from the macOS keychain.
 * CC stores credentials under service name with account = $USER.
 * Returns null if not on macOS or keychain read fails.
 */
function readFromKeychain(service: string): string | null {
  if (platform() !== "darwin") return null;
  try {
    const account = process.env.USER || userInfo().username;
    const result = execFileSync("security", [
      "find-generic-password", "-a", account, "-w", "-s", service,
    ], { encoding: "utf-8", timeout: 5000 });
    const token = result.trim();
    return token || null;
  } catch {
    return null;
  }
}

function resolveAuth(explicit?: string): ResolvedAuth {
  if (explicit) {
    if (explicit.includes("sk-ant-oat")) {
      return oauthClientConfig(explicit);
    }
    return { apiKey: explicit };
  }

  // CC's OAuth from credentials file — primary auth for CC users
  const ccCredsPath = join(homedir(), ".claude", ".credentials.json");
  if (existsSync(ccCredsPath)) {
    try {
      const creds = JSON.parse(readFileSync(ccCredsPath, "utf-8"));
      if (creds.claudeAiOauth?.accessToken) {
        return oauthClientConfig(creds.claudeAiOauth.accessToken);
      }
    } catch {}
  }

  // macOS keychain — CC may store OAuth tokens here instead of / in addition to the file
  const keychainToken = readFromKeychain("Claude Code-credentials");
  if (keychainToken) {
    // Keychain may store the full JSON or just the token
    try {
      const parsed = JSON.parse(keychainToken);
      if (parsed.claudeAiOauth?.accessToken) {
        return oauthClientConfig(parsed.claudeAiOauth.accessToken);
      }
    } catch {
      // Not JSON — treat as raw token
      if (keychainToken.startsWith("sk-ant-")) {
        return oauthClientConfig(keychainToken);
      }
    }
  }

  // Fallback: API key from environment
  if (process.env.ANTHROPIC_API_KEY) return { apiKey: process.env.ANTHROPIC_API_KEY };

  throw new Error("No Anthropic auth found. Authenticate via Claude Code or set ANTHROPIC_API_KEY.");
}

function oauthClientConfig(token: string): ResolvedAuth {
  return {
    apiKey: null,
    authToken: token,
    defaultHeaders: {
      "accept": "application/json",
      "anthropic-dangerous-direct-browser-access": "true",
      "anthropic-beta": "claude-code-20250219,oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14",
      "user-agent": "duncan-cc/0.4.0",
      "x-app": "cli",
    },
  };
}

// ============================================================================
// Duncan Response Tool
// ============================================================================

const DUNCAN_RESPONSE_TOOL: Anthropic.Tool = {
  name: "duncan_response",
  description: "Provide your answer to the query.",
  input_schema: {
    type: "object" as const,
    properties: {
      hasContext: {
        type: "boolean",
        description: "true if the conversation contained specific information to answer the question, false if it did not",
      },
      answer: {
        type: "string",
        description: "Your answer based on the conversation context, or a brief explanation of why you lack context",
      },
    },
    required: ["hasContext", "answer"],
  },
};

const DUNCAN_PREFIX = `Answer solely based on the conversation above. If you don't explicitly have context from the conversation on this topic, say so. Use the duncan_response tool to provide your answer.

`;

// ============================================================================
// Types
// ============================================================================

export interface DuncanResult {
  hasContext: boolean;
  answer: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  latencyMs?: number;
}

export interface DuncanQueryResult {
  queryId: string;
  sessionFile: string;
  sessionId: string;
  windowIndex: number;
  windowType: "main" | "compaction" | "subagent";
  model: string;
  result: DuncanResult;
}

export interface DuncanUsageStats {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export interface DuncanBatchResult {
  queryId: string;
  question: string;
  results: DuncanQueryResult[];
  totalWindows: number;
  hasMore: boolean;
  offset: number;
  /** Aggregated token usage across all queries in this batch */
  usage: DuncanUsageStats;
}

// ============================================================================
// Single Session Query
// ============================================================================

/**
 * Query a single session window with a question.
 */
export async function querySingleWindow(
  pipeline: PipelineResult | WindowPipelineResult,
  question: string,
  opts: {
    apiKey?: string;
    model?: string;
    signal?: AbortSignal;
  } = {},
): Promise<DuncanResult> {
  const auth = resolveAuth(opts.apiKey);
  const isOAuth = !!auth.authToken;
  const client = new Anthropic({
    ...auth,
    dangerouslyAllowBrowser: true,
  } as any);
  const model = opts.model ?? pipeline.modelInfo?.modelId ?? "claude-sonnet-4-20250514";

  // Build messages: session context + question
  const messages: Anthropic.MessageParam[] = [
    ...pipeline.messages.map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    })),
    {
      role: "user" as const,
      content: DUNCAN_PREFIX + question,
    },
  ];

  // Ensure messages alternate correctly (the question might create user→user)
  const fixedMessages = ensureAlternation(messages);

  // Add cache_control breakpoints for prompt caching.
  // Strategy: cache the session context (stable across queries), let the
  // duncan query question (last user message) vary without invalidating cache.
  // Place breakpoint on the last content block of the penultimate message.
  addCacheBreakpoints(fixedMessages);

  // Build system prompt — OAuth requires Claude Code identity prefix
  // Each section gets cache_control for system prompt caching.
  const systemBlocks: Anthropic.TextBlockParam[] = [];
  if (isOAuth) {
    systemBlocks.push({
      type: "text",
      text: "You are Claude Code, Anthropic's official CLI for Claude.",
      cache_control: { type: "ephemeral" },
    } as any);
  }
  if (pipeline.systemPrompt) {
    systemBlocks.push({
      type: "text",
      text: pipeline.systemPrompt,
      cache_control: { type: "ephemeral" },
    } as any);
  }

  const startTime = Date.now();

  // Use .stream() instead of .create() to avoid SDK timeout warnings
  // on large contexts with high max_tokens. Accumulate via finalMessage().
  const stream = client.messages.stream({
    model,
    system: systemBlocks.length > 0 ? systemBlocks : undefined,
    messages: fixedMessages,
    tools: [DUNCAN_RESPONSE_TOOL],
    tool_choice: { type: "tool" as const, name: "duncan_response" },
    max_tokens: 65536,
  });
  const response = await stream.finalMessage();

  // With tool_choice forced, the response must contain the tool call
  const toolCall = response.content.find(
    (c): c is Anthropic.ToolUseBlock => c.type === "tool_use" && c.name === "duncan_response",
  );

  if (toolCall) {
    const input = toolCall.input as Record<string, unknown>;
    const parsed = coerceDuncanResponse(input);
    if (parsed) {
      const latencyMs = Date.now() - startTime;
      return { ...parsed, usage: response.usage as any, latencyMs };
    }

    // Malformed input — retry once with correction prompt
    const retryMessages = [
      ...fixedMessages,
      { role: "assistant" as const, content: response.content },
      {
        role: "user" as const,
        content: "Your duncan_response tool call had invalid input. Call it again with { hasContext: boolean, answer: string }.",
      },
    ];
    const retryStream = client.messages.stream({
      model,
      system: systemBlocks.length > 0 ? systemBlocks : undefined,
      messages: retryMessages,
      tools: [DUNCAN_RESPONSE_TOOL],
      tool_choice: { type: "tool" as const, name: "duncan_response" },
      max_tokens: 65536,
    });
    const retryResponse = await retryStream.finalMessage();
    const retryCall = retryResponse.content.find(
      (c): c is Anthropic.ToolUseBlock => c.type === "tool_use" && c.name === "duncan_response",
    );
    if (retryCall) {
      const retryParsed = coerceDuncanResponse(retryCall.input as Record<string, unknown>);
      if (retryParsed) {
        const latencyMs = Date.now() - startTime;
        return { ...retryParsed, usage: retryResponse.usage as any, latencyMs };
      }
    }
  }

  throw new Error("Duncan query failed: model did not produce a valid duncan_response tool call despite tool_choice constraint");
}

// ============================================================================
// Logging Helper
// ============================================================================

/**
 * Log all results in a batch to ~/.claude/duncan.jsonl.
 */
function logBatchResults(
  batchResult: DuncanBatchResult,
  strategy: string,
  sourceSession: string | null,
): void {
  for (const r of batchResult.results) {
    recordQuery(buildLogRecord({
      batchId: batchResult.queryId,
      question: batchResult.question,
      answer: r.result.answer,
      hasContext: r.result.hasContext,
      targetSession: r.sessionId,
      windowIndex: r.windowIndex,
      windowType: r.windowType,
      sourceSession,
      strategy,
      model: r.model,
      usage: r.result.usage,
      latencyMs: r.result.latencyMs ?? 0,
    }));
  }
}

// ============================================================================
// Batch Query
// ============================================================================

/**
 * Query multiple sessions with a question.
 */
export async function queryBatch(
  question: string,
  routing: RoutingParams,
  opts: {
    apiKey?: string;
    model?: string;
    signal?: AbortSignal;
    batchSize?: number;
    onProgress?: (completed: number, total: number) => void;
  } = {},
): Promise<DuncanBatchResult> {
  const queryId = randomUUID();
  const resolved = resolveSessionFiles(routing);

  if (resolved.sessions.length === 0) {
    return {
      queryId,
      question,
      results: [],
      totalWindows: 0,
      hasMore: false,
      offset: routing.offset ?? 0,
    };
  }

  // Find the calling session for self-exclusion (window-level, not session-level).
  // For the calling session: keep compaction windows, drop only the active (last) window.
  // For all other sessions: include all windows.
  const callingSessionId = routing.toolUseId
    ? findCallingSession(routing.toolUseId, resolved.sessions)
    : null;

  // Process each session into windows
  const targets: Array<{
    sessionFile: string;
    sessionId: string;
    pipeline: WindowPipelineResult;
    windowType: "main" | "compaction";
  }> = [];

  for (const session of resolved.sessions) {
    try {
      const windows = processSessionWindows(session.path, {
        agentType: session.agentType,
      });
      const isCalling = session.sessionId === callingSessionId;

      for (let wi = 0; wi < windows.length; wi++) {
        const w = windows[wi];
        if (w.messages.length === 0) continue;

        const isActiveWindow = wi === windows.length - 1;
        const windowType = isActiveWindow ? "main" as const : "compaction" as const;

        // Self-exclusion: skip only the active window of the calling session
        if (isCalling && isActiveWindow) continue;

        targets.push({
          sessionFile: session.path,
          sessionId: session.sessionId,
          pipeline: w,
          windowType,
        });
      }
    } catch {
      // Skip unprocessable sessions
    }
  }

  const batchSize = opts.batchSize ?? 5;
  const results: DuncanQueryResult[] = [];
  let completed = 0;

  for (let i = 0; i < targets.length; i += batchSize) {
    if (opts.signal?.aborted) break;

    const batch = targets.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map(async (target) => {
        try {
          const result = await querySingleWindow(target.pipeline, question, {
            apiKey: opts.apiKey,
            model: opts.model ?? target.pipeline.modelInfo?.modelId,
            signal: opts.signal,
          });
          completed++;
          opts.onProgress?.(completed, targets.length);
          return {
            queryId,
            sessionFile: target.sessionFile,
            sessionId: target.sessionId,
            windowIndex: target.pipeline.windowIndex,
            windowType: target.windowType,
            model: target.pipeline.modelInfo?.modelId ?? "unknown",
            result,
          };
        } catch (err: any) {
          completed++;
          opts.onProgress?.(completed, targets.length);
          return {
            queryId,
            sessionFile: target.sessionFile,
            sessionId: target.sessionId,
            windowIndex: target.pipeline.windowIndex,
            windowType: target.windowType,
            model: target.pipeline.modelInfo?.modelId ?? "unknown",
            result: {
              hasContext: false,
              answer: `Error: ${err.message}`,
            },
          };
        }
      }),
    );

    results.push(...batchResults);
  }

  const batchResult: DuncanBatchResult = {
    queryId,
    question,
    results,
    totalWindows: targets.length,
    hasMore: resolved.hasMore,
    offset: routing.offset ?? 0,
    usage: aggregateUsage(results),
  };
  logBatchResults(batchResult, routing.mode, callingSessionId);
  return batchResult;
}

// ============================================================================
// Self Query — multiple samples from the active window
// ============================================================================

/**
 * Query the calling session's own active window N times for sampling diversity.
 *
 * Uses a two-wave strategy to leverage prompt caching:
 * 1. Wave 1: Send 1 query to prime the cache (pays full input cost)
 * 2. Wave 2: Send remaining N-1 queries in batches (hit cached prefix)
 *
 * The active session is identified by toolUseId (from MCP _meta).
 */
export async function querySelf(
  question: string,
  opts: {
    toolUseId: string;
    copies?: number;
    batchSize?: number;
    apiKey?: string;
    model?: string;
    signal?: AbortSignal;
    onProgress?: (completed: number, total: number) => void;
  },
): Promise<DuncanBatchResult> {
  const queryId = randomUUID();
  const copies = opts.copies ?? 3;

  // Find the calling session by toolUseId
  const allSessions = listAllSessionFiles();
  const callingSessionId = findCallingSession(opts.toolUseId, allSessions);
  if (!callingSessionId) {
    return {
      queryId, question, results: [], totalWindows: 0, hasMore: false, offset, usage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }: 0, usage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
    };
  }

  const session = allSessions.find(s => s.sessionId === callingSessionId);
  if (!session) {
    return {
      queryId, question, results: [], totalWindows: 0, hasMore: false, offset, usage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }: 0, usage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
    };
  }

  // Process the session and get the LAST (active) window
  const windows = processSessionWindows(session.path);
  if (windows.length === 0) {
    return {
      queryId, question, results: [], totalWindows: 0, hasMore: false, offset, usage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }: 0, usage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
    };
  }
  const activeWindow = windows[windows.length - 1];
  if (activeWindow.messages.length === 0) {
    return {
      queryId, question, results: [], totalWindows: 0, hasMore: false, offset, usage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }: 0, usage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
    };
  }

  const total = copies;
  let completed = 0;
  const results: DuncanQueryResult[] = [];

  const queryOnce = async (): Promise<DuncanQueryResult> => {
    try {
      const result = await querySingleWindow(activeWindow, question, {
        apiKey: opts.apiKey,
        model: opts.model ?? activeWindow.modelInfo?.modelId,
        signal: opts.signal,
      });
      completed++;
      opts.onProgress?.(completed, total);
      return {
        queryId,
        sessionFile: session.path,
        sessionId: session.sessionId,
        windowIndex: activeWindow.windowIndex,
        windowType: "main" as const,
        model: activeWindow.modelInfo?.modelId ?? "unknown",
        result,
      };
    } catch (err: any) {
      completed++;
      opts.onProgress?.(completed, total);
      return {
        queryId,
        sessionFile: session.path,
        sessionId: session.sessionId,
        windowIndex: activeWindow.windowIndex,
        windowType: "main" as const,
        model: activeWindow.modelInfo?.modelId ?? "unknown",
        result: { hasContext: false, answer: `Error: ${err.message}` },
      };
    }
  };

  // Wave 1: prime the cache with a single query
  results.push(await queryOnce());
  if (opts.signal?.aborted || copies <= 1) {
    const batchResult: DuncanBatchResult = { queryId, question, results, totalWindows: total, hasMore: false, offset: 0, usage: aggregateUsage(results) };
    logBatchResults(batchResult, "self", callingSessionId);
    return batchResult;
  }

  // Wave 2: remaining copies in batches, hitting cached prefix
  const remaining = copies - 1;
  const batchSize = opts.batchSize ?? 5;
  for (let i = 0; i < remaining; i += batchSize) {
    if (opts.signal?.aborted) break;
    const batchCount = Math.min(batchSize, remaining - i);
    const batchResults = await Promise.all(
      Array.from({ length: batchCount }, () => queryOnce()),
    );
    results.push(...batchResults);
  }

  const batchResult: DuncanBatchResult = { queryId, question, results, totalWindows: total, hasMore: false, offset: 0, usage: aggregateUsage(results) };
  logBatchResults(batchResult, "self", callingSessionId);
  return batchResult;
}

// ============================================================================
// Ancestors Query — prior compaction windows of the active session
// ============================================================================

/**
 * Query the calling session's prior compaction windows (excluding active).
 *
 * In CC (no dfork), "ancestors" means the compacted windows of the current
 * session — the context that was summarized away. Returns nothing if the
 * session has no compaction boundaries.
 */
export async function queryAncestors(
  question: string,
  opts: {
    toolUseId: string;
    limit?: number;
    offset?: number;
    batchSize?: number;
    apiKey?: string;
    model?: string;
    signal?: AbortSignal;
    onProgress?: (completed: number, total: number) => void;
  },
): Promise<DuncanBatchResult> {
  const queryId = randomUUID();
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;

  // Find the calling session
  const allSessions = listAllSessionFiles();
  const callingSessionId = findCallingSession(opts.toolUseId, allSessions);
  if (!callingSessionId) {
    return { queryId, question, results: [], totalWindows: 0, hasMore: false, offset, usage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 } };
  }

  const session = allSessions.find(s => s.sessionId === callingSessionId);
  if (!session) {
    return { queryId, question, results: [], totalWindows: 0, hasMore: false, offset, usage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 } };
  }

  // Get all windows, drop the last (active) one
  const allWindows = processSessionWindows(session.path);
  const ancestorWindows = allWindows.slice(0, -1).filter(w => w.messages.length > 0);

  if (ancestorWindows.length === 0) {
    return { queryId, question, results: [], totalWindows: 0, hasMore: false, offset, usage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 } };
  }

  const totalWindows = ancestorWindows.length;
  const page = ancestorWindows.slice(offset, offset + limit);

  const batchSize = opts.batchSize ?? 5;
  const results: DuncanQueryResult[] = [];
  let completed = 0;

  for (let i = 0; i < page.length; i += batchSize) {
    if (opts.signal?.aborted) break;

    const batch = page.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map(async (window) => {
        try {
          const result = await querySingleWindow(window, question, {
            apiKey: opts.apiKey,
            model: opts.model ?? window.modelInfo?.modelId,
            signal: opts.signal,
          });
          completed++;
          opts.onProgress?.(completed, page.length);
          return {
            queryId,
            sessionFile: session.path,
            sessionId: session.sessionId,
            windowIndex: window.windowIndex,
            windowType: "compaction" as const,
            model: window.modelInfo?.modelId ?? "unknown",
            result,
          };
        } catch (err: any) {
          completed++;
          opts.onProgress?.(completed, page.length);
          return {
            queryId,
            sessionFile: session.path,
            sessionId: session.sessionId,
            windowIndex: window.windowIndex,
            windowType: "compaction" as const,
            model: window.modelInfo?.modelId ?? "unknown",
            result: { hasContext: false, answer: `Error: ${err.message}` },
          };
        }
      }),
    );
    results.push(...batchResults);
  }

  const batchResult: DuncanBatchResult = {
    queryId,
    question,
    results,
    totalWindows,
    hasMore: offset + limit < totalWindows,
    offset,
    usage: aggregateUsage(results),
  };
  logBatchResults(batchResult, "ancestors", callingSessionId);
  return batchResult;
}

// ============================================================================
// Subagents Query — subagent transcripts of the active session
// ============================================================================

/**
 * Query the calling session's subagent transcripts.
 */
export async function querySubagents(
  question: string,
  opts: {
    toolUseId: string;
    limit?: number;
    offset?: number;
    batchSize?: number;
    apiKey?: string;
    model?: string;
    signal?: AbortSignal;
    onProgress?: (completed: number, total: number) => void;
  },
): Promise<DuncanBatchResult> {
  const queryId = randomUUID();
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;

  const allSessions = listAllSessionFiles();
  const callingSessionId = findCallingSession(opts.toolUseId, allSessions);
  if (!callingSessionId) {
    return { queryId, question, results: [], totalWindows: 0, hasMore: false, offset, usage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 } };
  }

  const session = allSessions.find(s => s.sessionId === callingSessionId);
  if (!session) {
    return { queryId, question, results: [], totalWindows: 0, hasMore: false, offset, usage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 } };
  }

  const subagentFiles = listSubagentFiles(session.path);
  if (subagentFiles.length === 0) {
    return { queryId, question, results: [], totalWindows: 0, hasMore: false, offset, usage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 } };
  }

  // Expand subagent files to windows, passing agent type for prompt dispatch
  const allTargets: Array<{ sessionFile: string; sessionId: string; pipeline: WindowPipelineResult }> = [];
  for (const sub of subagentFiles) {
    try {
      const windows = processSessionWindows(sub.path, { agentType: sub.agentType });
      for (const w of windows) {
        if (w.messages.length === 0) continue;
        allTargets.push({ sessionFile: sub.path, sessionId: sub.sessionId, pipeline: w });
      }
    } catch {}
  }

  if (allTargets.length === 0) {
    return { queryId, question, results: [], totalWindows: 0, hasMore: false, offset, usage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 } };
  }

  const totalWindows = allTargets.length;
  const page = allTargets.slice(offset, offset + limit);

  const batchSize = opts.batchSize ?? 5;
  const results: DuncanQueryResult[] = [];
  let completed = 0;

  for (let i = 0; i < page.length; i += batchSize) {
    if (opts.signal?.aborted) break;
    const batch = page.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map(async (target) => {
        try {
          const result = await querySingleWindow(target.pipeline, question, {
            apiKey: opts.apiKey,
            model: opts.model ?? target.pipeline.modelInfo?.modelId,
            signal: opts.signal,
          });
          completed++;
          opts.onProgress?.(completed, page.length);
          return {
            queryId, sessionFile: target.sessionFile, sessionId: target.sessionId,
            windowIndex: target.pipeline.windowIndex,
            windowType: "subagent" as const,
            model: target.pipeline.modelInfo?.modelId ?? "unknown", result,
          };
        } catch (err: any) {
          completed++;
          opts.onProgress?.(completed, page.length);
          return {
            queryId, sessionFile: target.sessionFile, sessionId: target.sessionId,
            windowIndex: target.pipeline.windowIndex,
            windowType: "subagent" as const,
            model: target.pipeline.modelInfo?.modelId ?? "unknown",
            result: { hasContext: false, answer: `Error: ${err.message}` },
          };
        }
      }),
    );
    results.push(...batchResults);
  }

  const batchResult: DuncanBatchResult = {
    queryId, question, results, totalWindows,
    hasMore: offset + limit < totalWindows, offset,
    usage: aggregateUsage(results),
  };
  logBatchResults(batchResult, "subagents", callingSessionId);
  return batchResult;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Add cache_control breakpoints to messages for prompt caching.
 *
 * Places an ephemeral cache breakpoint on the last content block of the
 * penultimate message. This caches all session context while allowing
 * the duncan query (last message) to vary without invalidating the cache.
 *
 * Matches CC's caching strategy (CC API format functions) where the last content block
 * of each message gets cache_control when caching is enabled.
 */
/**
 * Coerce a duncan_response tool input to the expected shape.
 * Handles common model quirks: hasContext as string, missing fields.
 */
/** Aggregate usage stats from all results in a batch. */
function aggregateUsage(results: DuncanQueryResult[]): DuncanUsageStats {
  const stats: DuncanUsageStats = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  };
  for (const r of results) {
    if (r.result.usage) {
      stats.inputTokens += r.result.usage.input_tokens ?? 0;
      stats.outputTokens += r.result.usage.output_tokens ?? 0;
      stats.cacheCreationInputTokens += r.result.usage.cache_creation_input_tokens ?? 0;
      stats.cacheReadInputTokens += r.result.usage.cache_read_input_tokens ?? 0;
    }
  }
  return stats;
}

function coerceDuncanResponse(input: Record<string, unknown>): { hasContext: boolean; answer: string } | null {
  if (!input || typeof input !== "object") return null;

  let hasContext: boolean;
  if (typeof input.hasContext === "boolean") {
    hasContext = input.hasContext;
  } else if (typeof input.hasContext === "string") {
    hasContext = input.hasContext === "true";
  } else {
    return null;
  }

  const answer = typeof input.answer === "string" ? input.answer : null;
  if (answer === null) return null;

  return { hasContext, answer };
}

function addCacheBreakpoints(messages: Anthropic.MessageParam[]): void {
  if (messages.length < 2) return;

  // Find the penultimate message (last session context message before the duncan query)
  const penultimate = messages[messages.length - 2];
  if (!penultimate) return;

  const content = penultimate.content;
  if (typeof content === "string") {
    // Convert to block format to add cache_control
    penultimate.content = [
      {
        type: "text" as const,
        text: content,
        cache_control: { type: "ephemeral" as const },
      } as any,
    ];
  } else if (Array.isArray(content) && content.length > 0) {
    // Add cache_control to the last block
    const lastBlock = content[content.length - 1] as any;
    content[content.length - 1] = {
      ...lastBlock,
      cache_control: { type: "ephemeral" as const },
    };
  }
}

/** Ensure messages alternate user/assistant */
function ensureAlternation(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  if (messages.length === 0) return messages;

  const result: Anthropic.MessageParam[] = [messages[0]];
  for (let i = 1; i < messages.length; i++) {
    const prev = result[result.length - 1];
    if (messages[i].role === prev.role) {
      // Merge same-role messages
      const prevContent = Array.isArray(prev.content) ? prev.content : [{ type: "text" as const, text: prev.content }];
      const curContent = Array.isArray(messages[i].content) ? messages[i].content : [{ type: "text" as const, text: messages[i].content as string }];
      result[result.length - 1] = {
        role: prev.role,
        content: [...prevContent, ...curContent] as any,
      };
    } else {
      result.push(messages[i]);
    }
  }

  // Ensure first message is user
  if (result[0].role !== "user") {
    result.unshift({ role: "user", content: "[Session context follows]" });
  }

  return result;
}
