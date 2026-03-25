/**
 * Full Pipeline Integration
 * 
 * Wires all layers together:
 * parse → relink → walk → slice → strip → normalize → 
 * content-replace → microcompact → userContext → API format
 * 
 * Produces the final messages array ready for an API call.
 */

import { readFileSync } from "node:fs";
import { parseSession, type ParsedSession } from "./parser.js";
import { buildRawChain, sliceFromBoundary, stripInternalFields, getCompactionWindows, type CompactionWindow } from "./tree.js";
import { normalizeMessages } from "./normalize.js";
import { applyContentReplacements, microcompact } from "./content-replacements.js";
import { injectUserContext, buildSystemPromptString, type EnvironmentInfo } from "./system-prompt.js";
import type { CCMessage } from "./parser.js";

// ============================================================================
// API Format Conversion — CC's ejY() / AJY()
// ============================================================================

interface ApiMessage {
  role: "user" | "assistant";
  content: string | any[];
}

/**
 * Convert a CC message to API format — strip everything except role + content.
 * CC's ejY() for user, AJY() for assistant.
 */
function toApiMessage(msg: CCMessage): ApiMessage {
  return {
    role: msg.type === "assistant" ? "assistant" : "user",
    content: Array.isArray(msg.message.content)
      ? [...msg.message.content]
      : msg.message.content,
  };
}

/**
 * Convert an array of CC messages to API format.
 */
export function toApiMessages(messages: CCMessage[]): ApiMessage[] {
  return messages.map(toApiMessage);
}

// ============================================================================
// Pipeline Options
// ============================================================================

export interface PipelineOptions {
  /** Working directory the session was run from */
  cwd?: string;
  /** Apply content replacements (default: true) */
  applyReplacements?: boolean;
  /** Apply microcompact (default: true) */
  applyMicrocompact?: boolean;
  /** Microcompact gap threshold in minutes (default: 30) */
  microcompactGapMinutes?: number;
  /** Microcompact: number of recent turns to keep (default: 2) */
  microcompactKeepTurns?: number;
  /** Inject userContext (CLAUDE.md + date) (default: true) */
  injectContext?: boolean;
  /** Skip system prompt building (default: false) */
  skipSystemPrompt?: boolean;
}

// ============================================================================
// Pipeline Result
// ============================================================================

export interface PipelineResult {
  /** Messages ready for the API (role + content only) */
  messages: ApiMessage[];
  /** System prompt string */
  systemPrompt: string;
  /** Model info extracted from session */
  modelInfo?: { provider: string; modelId: string };
  /** Number of messages before normalization */
  rawMessageCount: number;
  /** Session CWD (extracted from messages) */
  sessionCwd: string;
}

// ============================================================================
// Full Pipeline
// ============================================================================

/**
 * Run the full pipeline on a session file.
 * Returns API-ready messages + system prompt.
 */
export function processSessionFile(sessionFile: string, opts: PipelineOptions = {}): PipelineResult {
  const content = readFileSync(sessionFile, "utf-8");
  return processSessionContent(content, sessionFile, opts);
}

/**
 * Run the full pipeline on session content (string).
 */
export function processSessionContent(
  content: string,
  sessionFile?: string,
  opts: PipelineOptions = {},
): PipelineResult {
  const parsed = parseSession(content);
  return processSession(parsed, sessionFile, opts);
}

/**
 * Run the full pipeline on a parsed session.
 */
export function processSession(
  parsed: ParsedSession,
  sessionFile?: string,
  opts: PipelineOptions = {},
): PipelineResult {
  // 1. Build raw chain (relink + tree walk)
  const chain = buildRawChain(parsed);
  if (chain.length === 0) {
    return {
      messages: [],
      systemPrompt: "",
      rawMessageCount: 0,
      sessionCwd: opts.cwd ?? process.cwd(),
    };
  }

  // Extract CWD from session messages
  const sessionCwd = opts.cwd ?? extractCwd(chain) ?? process.cwd();

  // Extract model info
  const modelInfo = extractModelInfo(chain);

  // 2. Slice from last boundary
  let messages = sliceFromBoundary(chain);

  // 3. Strip internal fields
  messages = stripInternalFields(messages);

  // 4. Normalize (filter, convert, merge, post-transform)
  messages = normalizeMessages(messages);

  // 5. Content replacements
  if (opts.applyReplacements !== false) {
    messages = applyContentReplacements(messages, parsed, sessionFile);
  }

  // 6. Microcompact
  if (opts.applyMicrocompact !== false) {
    messages = microcompact(
      messages,
      opts.microcompactGapMinutes ?? 30,
      opts.microcompactKeepTurns ?? 2,
    );
  }

  // 7. Inject userContext
  if (opts.injectContext !== false) {
    messages = injectUserContext(messages, sessionCwd);
  }

  // 8. Build system prompt
  const systemPrompt = opts.skipSystemPrompt
    ? ""
    : buildSystemPromptString({
        cwd: sessionCwd,
        modelId: modelInfo?.modelId,
        modelName: modelInfo?.modelId,
      });

  // 9. Convert to API format
  const apiMessages = toApiMessages(messages);

  return {
    messages: apiMessages,
    systemPrompt,
    modelInfo,
    rawMessageCount: chain.length,
    sessionCwd,
  };
}

// ============================================================================
// Compaction Window Pipeline
// ============================================================================

export interface WindowPipelineResult extends PipelineResult {
  windowIndex: number;
}

/**
 * Process a session into compaction windows, each independently queryable.
 */
export function processSessionWindows(
  sessionFile: string,
  opts: PipelineOptions = {},
): WindowPipelineResult[] {
  const content = readFileSync(sessionFile, "utf-8");
  const parsed = parseSession(content);
  const chain = buildRawChain(parsed);

  if (chain.length === 0) return [];

  const windows = getCompactionWindows(chain);
  const sessionCwd = opts.cwd ?? extractCwd(chain) ?? process.cwd();

  return windows.map((window) => {
    let messages = stripInternalFields(window.messages);
    messages = normalizeMessages(messages);

    if (opts.applyReplacements !== false) {
      messages = applyContentReplacements(messages, parsed, sessionFile);
    }

    if (opts.applyMicrocompact !== false) {
      messages = microcompact(
        messages,
        opts.microcompactGapMinutes ?? 30,
        opts.microcompactKeepTurns ?? 2,
      );
    }

    if (opts.injectContext !== false) {
      messages = injectUserContext(messages, sessionCwd);
    }

    const modelInfo = window.modelInfo;
    const systemPrompt = opts.skipSystemPrompt
      ? ""
      : buildSystemPromptString({
          cwd: sessionCwd,
          modelId: modelInfo?.modelId,
          modelName: modelInfo?.modelId,
        });

    return {
      windowIndex: window.windowIndex,
      messages: toApiMessages(messages),
      systemPrompt,
      modelInfo,
      rawMessageCount: window.messages.length,
      sessionCwd,
    };
  });
}

// ============================================================================
// Helpers
// ============================================================================

function extractCwd(chain: CCMessage[]): string | undefined {
  // Try to find cwd from messages (most messages have a cwd field)
  for (const msg of chain) {
    if (msg.cwd) return msg.cwd;
  }
  return undefined;
}

function extractModelInfo(chain: CCMessage[]): { provider: string; modelId: string } | undefined {
  // Find the last assistant message with a model
  for (let i = chain.length - 1; i >= 0; i--) {
    const msg = chain[i];
    if (msg.type === "assistant" && msg.message.model) {
      return { provider: "anthropic", modelId: msg.message.model };
    }
  }
  return undefined;
}
