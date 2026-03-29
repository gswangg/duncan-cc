/**
 * Duncan Query Dispatch
 * 
 * Queries CC sessions using the Anthropic API with structured output
 * via the duncan_response tool.
 */

import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { processSessionFile, processSessionWindows, type PipelineResult, type WindowPipelineResult } from "./pipeline.js";
import { resolveSessionFilesExcludingSelf, type RoutingParams, type RoutingResult } from "./discovery.js";

// ============================================================================
// OAuth token resolution
// ============================================================================

/**
 * Resolve Anthropic API key from:
 * 1. Explicit apiKey parameter
 * 2. ANTHROPIC_API_KEY env var
 * 3. CC's OAuth credentials (~/.claude/.credentials.json) → exchange for API key
 * 4. Pi's OAuth credentials (~/.pi/agent/auth.json) → exchange for API key
 */



interface ResolvedAuth {
  apiKey?: string | null;
  authToken?: string;
  defaultHeaders?: Record<string, string>;
}

function resolveAuth(explicit?: string): ResolvedAuth {
  if (explicit) {
    // If explicit key looks like OAuth token, use authToken
    if (explicit.includes("sk-ant-oat")) {
      return oauthClientConfig(explicit);
    }
    return { apiKey: explicit };
  }
  if (process.env.ANTHROPIC_API_KEY) return { apiKey: process.env.ANTHROPIC_API_KEY };

  // CC's OAuth
  const ccCredsPath = join(homedir(), ".claude", ".credentials.json");
  if (existsSync(ccCredsPath)) {
    try {
      const creds = JSON.parse(readFileSync(ccCredsPath, "utf-8"));
      if (creds.claudeAiOauth?.accessToken) {
        return oauthClientConfig(creds.claudeAiOauth.accessToken);
      }
    } catch {}
  }

  // Pi's OAuth
  const piAuthPath = join(homedir(), ".pi", "agent", "auth.json");
  if (existsSync(piAuthPath)) {
    try {
      const auth = JSON.parse(readFileSync(piAuthPath, "utf-8"));
      if (auth.anthropic?.access) {
        return oauthClientConfig(auth.anthropic.access);
      }
    } catch {}
  }

  throw new Error("No Anthropic auth found. Set ANTHROPIC_API_KEY or authenticate via Claude Code or pi.");
}

function oauthClientConfig(token: string): ResolvedAuth {
  return {
    apiKey: null,
    authToken: token,
    defaultHeaders: {
      "accept": "application/json",
      "anthropic-dangerous-direct-browser-access": "true",
      "anthropic-beta": "claude-code-20250219,oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14",
      "user-agent": "duncan-cc/0.1.0",
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
}

export interface DuncanQueryResult {
  queryId: string;
  sessionFile: string;
  sessionId: string;
  windowIndex: number;
  model: string;
  result: DuncanResult;
}

export interface DuncanBatchResult {
  queryId: string;
  question: string;
  results: DuncanQueryResult[];
  totalWindows: number;
  hasMore: boolean;
  offset: number;
}

// ============================================================================
// Single Session Query
// ============================================================================

const MAX_RETRIES = 3;

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

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const response = await client.messages.create({
      model,
      system: systemBlocks.length > 0 ? systemBlocks : undefined,
      messages: fixedMessages,
      tools: [DUNCAN_RESPONSE_TOOL],
      max_tokens: 16384,
    });

    // Look for duncan_response tool call
    const toolCall = response.content.find(
      (c): c is Anthropic.ToolUseBlock => c.type === "tool_use" && c.name === "duncan_response",
    );

    if (toolCall) {
      const input = toolCall.input as { hasContext: boolean; answer: string };
      if (typeof input.hasContext === "boolean" && typeof input.answer === "string") {
        return { hasContext: input.hasContext, answer: input.answer };
      }
    }

    // Retry: ask the model to use the tool
    if (attempt < MAX_RETRIES) {
      fixedMessages.push(
        { role: "assistant", content: response.content },
        {
          role: "user",
          content: "You must respond by calling the duncan_response tool with { hasContext: boolean, answer: string }. Do not respond with plain text.",
        },
      );
    }
  }

  throw new Error(`Duncan query failed after ${MAX_RETRIES} retries: model did not produce a valid duncan_response tool call`);
}

// ============================================================================
// Batch Query
// ============================================================================

/**
 * Query multiple sessions with a question.
 */
export async function queryBatch(
  question: string,
  routing: RoutingParams & { toolUseId?: string },
  opts: {
    apiKey?: string;
    model?: string;
    signal?: AbortSignal;
    batchSize?: number;
    onProgress?: (completed: number, total: number) => void;
  } = {},
): Promise<DuncanBatchResult> {
  const queryId = randomUUID();
  const resolved = resolveSessionFilesExcludingSelf(routing);

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

  // Process each session into windows
  const targets: Array<{
    sessionFile: string;
    sessionId: string;
    pipeline: WindowPipelineResult;
  }> = [];

  for (const session of resolved.sessions) {
    try {
      const windows = processSessionWindows(session.path);
      for (const w of windows) {
        if (w.messages.length === 0) continue;
        targets.push({
          sessionFile: session.path,
          sessionId: session.sessionId,
          pipeline: w,
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

  return {
    queryId,
    question,
    results,
    totalWindows: targets.length,
    hasMore: resolved.hasMore,
    offset: routing.offset ?? 0,
  };
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
 * Matches CC's caching strategy (sw3/cw3/Qw3) where the last content block
 * of each message gets cache_control when caching is enabled.
 */
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
