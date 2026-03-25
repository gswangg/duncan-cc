/**
 * Duncan Query Dispatch
 * 
 * Queries CC sessions using the Anthropic API with structured output
 * via the duncan_response tool.
 */

import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import { processSessionFile, processSessionWindows, type PipelineResult, type WindowPipelineResult } from "./pipeline.js";
import { resolveSessionFiles, type RoutingParams, type RoutingResult } from "./discovery.js";

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
  const client = new Anthropic({ apiKey: opts.apiKey });
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

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const response = await client.messages.create({
      model,
      system: pipeline.systemPrompt,
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
