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
import { NON_REAL_ASSISTANT_MODELS, parseSession, type ParsedSession } from "./parser.js";
import { buildRawChain, sliceFromBoundary, stripInternalFields, getCompactionWindows, type CompactionWindow } from "./tree.js";
import { normalizeMessages } from "./normalize.js";
import { applyContentReplacements, microcompact } from "./content-replacements.js";
import { injectUserContext, buildSystemPromptString, buildSubagentSystemPrompt, extractToolNames, type SystemPromptOptions } from "./system-prompt.js";
import type { CCMessage } from "./parser.js";

// ============================================================================
// API Format Conversion
// ============================================================================

interface ApiMessage {
  role: "user" | "assistant";
  content: string | any[];
}

/**
 * Convert a CC message to API format — strip everything except role + content.
 * Converts internal messages to API format ({role, content} only).
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

/**
 * Tiny placeholder system prompt used when `minimalSystemPrompt` is set.
 * Just enough to frame the task — the DUNCAN_PREFIX on the final user message
 * and the forced duncan_response tool_choice carry the real instructions.
 * Keeps the transcript interpretable without the ~3k-token CC persona.
 */
const MINIMAL_SYSTEM_PROMPT =
  "You are reading a prior Claude Code session transcript to answer a question about it. " +
  "Tool definitions (Read, Edit, Bash, Grep, etc.) are omitted but tool_use blocks in the " +
  "transcript still show what was done and what results came back. Answer based solely on " +
  "the transcript content.";

/**
 * Char-to-token ratio used for cheap token estimation on message/prompt text.
 * Empirically calibrated against real CC session transcripts: a 2,817k-char
 * ancestor window measured 1,012k actual tokens → 2.78 chars/token. Using
 * 2.75 keeps us just-conservative so estimates match or slightly overshoot
 * reality, which is the safe direction for truncation (we'd rather drop an
 * extra message than fail the API call).
 *
 * English prose alone is closer to 3.5-4 chars/token — so for non-CC content
 * this estimator overcounts, triggering unnecessary truncation. That's
 * acceptable for the duncan use case; the inputs are always CC transcripts,
 * which are dense in JSON / tool_use blocks / file paths.
 */
const CHARS_PER_TOKEN = 2.75;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function estimateMessageTokens(msg: ApiMessage): number {
  const content =
    typeof msg.content === "string"
      ? msg.content
      : JSON.stringify(msg.content);
  // +4 for role + message overhead, matches Anthropic's rough-token guidance
  return estimateTokens(content) + 4;
}

/**
 * Collect all tool_use ids present in assistant messages.
 * Used to find orphan tool_result blocks after head truncation.
 */
function collectToolUseIds(messages: ApiMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    if (!Array.isArray(m.content)) continue;
    for (const block of m.content as any[]) {
      if (block?.type === "tool_use" && typeof block.id === "string") {
        ids.add(block.id);
      }
    }
  }
  return ids;
}

/**
 * Drop tool_result blocks from a user message whose tool_use_id is not in
 * the kept assistant tool_use ids. Returns null if the message ends up empty.
 */
function stripOrphanToolResults(msg: ApiMessage, keptToolUseIds: Set<string>): ApiMessage | null {
  if (msg.role !== "user" || !Array.isArray(msg.content)) return msg;
  const filtered = (msg.content as any[]).filter((block) => {
    if (block?.type === "tool_result" && typeof block.tool_use_id === "string") {
      return keptToolUseIds.has(block.tool_use_id);
    }
    return true;
  });
  if (filtered.length === 0) return null;
  if (filtered.length === msg.content.length) return msg;
  return { ...msg, content: filtered };
}

export interface TruncateHeadResult {
  messages: ApiMessage[];
  droppedCount: number;
}

/**
 * Drop oldest messages from the head until `messages` plus `systemPromptTokens`
 * fits under `maxPromptTokens`. Leaves a headroom of `reservedTokens` (default
 * 5000) for the duncan_response tool output. After dropping, strips orphan
 * tool_result blocks from the first kept user message.
 *
 * Returns the truncated list and the dropped count. If the input already fits,
 * returns it unchanged with droppedCount=0.
 */
export function truncateHeadToFit(
  messages: ApiMessage[],
  systemPromptTokens: number,
  maxPromptTokens: number,
  reservedTokens: number = 5000,
): TruncateHeadResult {
  const budget = maxPromptTokens - systemPromptTokens - reservedTokens;
  if (budget <= 0) {
    return { messages: [], droppedCount: messages.length };
  }

  const perMsgTokens = messages.map(estimateMessageTokens);
  let total = perMsgTokens.reduce((a, b) => a + b, 0);
  if (total <= budget) return { messages, droppedCount: 0 };

  const kept = [...messages];
  const keptTokens = [...perMsgTokens];
  let dropped = 0;

  // Drop from head until we fit. Leave at least one message so the API
  // has something to work with.
  while (total > budget && kept.length > 1) {
    kept.shift();
    total -= keptTokens.shift()!;
    dropped++;
  }

  // Strip orphan tool_result blocks from the first kept user message, since
  // their tool_use just got dropped. If the first kept message empties out,
  // drop it entirely and try again.
  while (kept.length > 0) {
    const toolUseIds = collectToolUseIds(kept);
    // Only the very first message can be an orphan — later user messages
    // reference tool_use blocks from assistant messages that are still present.
    const first = kept[0];
    const stripped = stripOrphanToolResults(first, toolUseIds);
    if (stripped === null) {
      kept.shift();
      total -= keptTokens.shift()!;
      dropped++;
      continue;
    }
    if (stripped !== first) {
      kept[0] = stripped;
      const newTokens = estimateMessageTokens(stripped);
      total = total - keptTokens[0] + newTokens;
      keptTokens[0] = newTokens;
    }
    break;
  }

  return { messages: kept, droppedCount: dropped };
}

function appendTruncationNote(systemPrompt: string, droppedCount: number): string {
  if (droppedCount === 0) return systemPrompt;
  const note =
    `\n\n# Transcript truncation notice\n` +
    `The earliest ${droppedCount} message${droppedCount === 1 ? "" : "s"} of this session ` +
    `were dropped to fit the prompt within the context window. You are seeing only the tail ` +
    `of the conversation. If the question requires context from earlier in the session ` +
    `that isn't visible in the remaining transcript, say so explicitly rather than guessing.`;
  return systemPrompt ? systemPrompt + note : note.trimStart();
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
  /**
   * Emit a tiny placeholder system prompt instead of the full CC persona
   * (default: false). Drops ~3k tokens. Useful when the session transcript
   * is at or near the 1M context cap, or when the full persona isn't needed
   * for simple recall queries.
   */
  minimalSystemPrompt?: boolean;
  /**
   * Cap on total prompt tokens (system + messages). When set and the pipeline
   * output would exceed it, drop oldest messages from the head one-by-one
   * until the prompt fits, then append a note to the system prompt explaining
   * how many messages were dropped. Recommended: 950000 for 1M-context models,
   * 180000 for 200k. Uses a char-based token estimate (chars / 3.5) so leave
   * ~5k headroom below the hard limit.
   */
  maxPromptTokens?: number;
  /** CC project directory (~/.claude/projects/<hash>/) for memory loading */
  projectDir?: string | null;
  /** Agent type for subagent transcripts (from .meta.json) */
  agentType?: string | null;
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

  // 8. Build system prompt (full parity with CC's U2)
  const toolNames = extractToolNames(messages);
  let systemPrompt = opts.skipSystemPrompt
    ? ""
    : opts.minimalSystemPrompt
      ? MINIMAL_SYSTEM_PROMPT
      : buildSystemPromptString({
          cwd: sessionCwd,
          modelId: modelInfo?.modelId,
          toolNames,
          projectDir: opts.projectDir ?? null,
        });

  // 9. Convert to API format
  let apiMessages = toApiMessages(messages);

  // 10. Optional head truncation to fit under maxPromptTokens
  if (opts.maxPromptTokens && opts.maxPromptTokens > 0) {
    const sysTokens = estimateTokens(systemPrompt);
    const truncated = truncateHeadToFit(apiMessages, sysTokens, opts.maxPromptTokens);
    if (truncated.droppedCount > 0) {
      apiMessages = truncated.messages;
      systemPrompt = appendTruncationNote(systemPrompt, truncated.droppedCount);
    }
  }

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
  /** For subagent windows: the agent type (e.g., "Explore", "Plan") */
  agentType?: string | null;
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
    const promptOpts = {
      cwd: sessionCwd,
      modelId: modelInfo?.modelId,
    };
    let systemPrompt = opts.skipSystemPrompt
      ? ""
      : opts.minimalSystemPrompt
        ? MINIMAL_SYSTEM_PROMPT
        : opts.agentType
          ? buildSubagentSystemPrompt(opts.agentType, promptOpts)
          : buildSystemPromptString(promptOpts);

    let apiMessages = toApiMessages(messages);

    if (opts.maxPromptTokens && opts.maxPromptTokens > 0) {
      const sysTokens = estimateTokens(systemPrompt);
      const truncated = truncateHeadToFit(apiMessages, sysTokens, opts.maxPromptTokens);
      if (truncated.droppedCount > 0) {
        apiMessages = truncated.messages;
        systemPrompt = appendTruncationNote(systemPrompt, truncated.droppedCount);
      }
    }

    return {
      windowIndex: window.windowIndex,
      messages: apiMessages,
      systemPrompt,
      modelInfo,
      rawMessageCount: window.messages.length,
      sessionCwd,
      agentType: opts.agentType ?? null,
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
  // Find the last assistant message with a real model (skip API-error /
  // <synthetic> entries injected by the CC harness — forwarding those to the
  // Anthropic API 404s).
  for (let i = chain.length - 1; i >= 0; i--) {
    const msg = chain[i];
    if (
      msg.type === "assistant" &&
      msg.message.model &&
      !NON_REAL_ASSISTANT_MODELS.has(msg.message.model)
    ) {
      return { provider: "anthropic", modelId: msg.message.model };
    }
  }
  return undefined;
}
