/**
 * Content Replacements + Microcompact
 * 
 * Replicates CC's L34() content replacement and Kp() microcompact.
 * 
 * Content replacements: replace large tool_result content with persisted
 * output references. The persisted outputs live in tool-results/ dirs.
 * 
 * Microcompact: on session resume after time gap, truncate old tool results.
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import type { CCMessage, ParsedSession } from "./parser.js";

// ============================================================================
// Content Replacements — CC's L34() / pI9()
// ============================================================================

const PERSISTED_OUTPUT_MARKER = "<persisted-output>";

/**
 * Apply content replacements to messages.
 * 
 * Two sources:
 * 1. content-replacement entries from session metadata
 * 2. persisted output files on disk (tool-results/ directory)
 * 
 * @param messages - messages to process
 * @param parsed - parsed session with contentReplacements map
 * @param sessionFile - path to session file (for resolving tool-results/ dir)
 */
export function applyContentReplacements(
  messages: CCMessage[],
  parsed: ParsedSession,
  sessionFile?: string,
): CCMessage[] {
  // Build replacement map from session metadata
  const replacements = new Map<string, string>();
  for (const [, repls] of parsed.contentReplacements) {
    for (const r of repls) {
      if (r.kind === "tool-result" && r.toolUseId && r.replacement) {
        replacements.set(r.toolUseId, r.replacement);
      }
    }
  }

  // Also check for persisted output files on disk
  const toolResultsDir = sessionFile
    ? join(dirname(sessionFile), basename(sessionFile), "tool-results")
    : null;

  if (replacements.size === 0 && !toolResultsDir) return messages;

  return messages.map((msg) => {
    if (msg.type !== "user") return msg;
    const content = msg.message.content;
    if (!Array.isArray(content)) return msg;

    let changed = false;
    const newContent = content.map((block) => {
      if (block.type !== "tool_result") return block;

      const toolUseId = block.tool_use_id;
      if (!toolUseId) return block;

      // Check metadata replacements first
      const replacement = replacements.get(toolUseId);
      if (replacement) {
        changed = true;
        return { ...block, content: replacement };
      }

      // Check if content is a persisted-output reference that we can resolve
      const blockContent = typeof block.content === "string" ? block.content : "";
      if (blockContent.includes(PERSISTED_OUTPUT_MARKER) && toolResultsDir) {
        const resolved = resolvePersistedOutput(toolUseId, toolResultsDir);
        if (resolved) {
          changed = true;
          return { ...block, content: resolved };
        }
      }

      return block;
    });

    if (!changed) return msg;
    return { ...msg, message: { ...msg.message, content: newContent } };
  });
}

/**
 * Try to resolve a persisted output from the tool-results directory.
 * Files are named by tool_use_id or a hash.
 */
function resolvePersistedOutput(toolUseId: string, toolResultsDir: string): string | null {
  if (!existsSync(toolResultsDir)) return null;

  // Try exact match first
  const exactPath = join(toolResultsDir, `${toolUseId}.txt`);
  if (existsSync(exactPath)) {
    try {
      return readFileSync(exactPath, "utf-8");
    } catch {
      return null;
    }
  }

  return null;
}

function basename(path: string): string {
  return path.replace(/\.jsonl$/, "");
}

// ============================================================================
// Microcompact — CC's Kp() / Oe9()
// ============================================================================

const MICROCOMPACT_PLACEHOLDER = "[content truncated — tool result from previous session segment]";

/**
 * Microcompact: truncate old tool results when there's a time gap.
 * 
 * CC does this on session resume after a gap > threshold minutes.
 * For duncan, we apply it based on the time gap between the last
 * assistant message and the current time (or a specified reference time).
 * 
 * @param messages - messages to process (post-normalization)
 * @param gapThresholdMinutes - minutes of gap to trigger microcompact (default: 30)
 * @param keepRecentTurns - number of recent turns to keep intact (default: 1)
 */
export function microcompact(
  messages: CCMessage[],
  gapThresholdMinutes: number = 30,
  keepRecentTurns: number = 1,
): CCMessage[] {
  // Find the last assistant message
  const lastAssistant = [...messages].reverse().find((m) => m.type === "assistant");
  if (!lastAssistant) return messages;

  const lastTime = Date.parse(lastAssistant.timestamp);
  const now = Date.now();
  const gapMinutes = (now - lastTime) / 60000;

  if (!Number.isFinite(gapMinutes) || gapMinutes < gapThresholdMinutes) {
    return messages;
  }

  // Identify tool_use IDs from recent turns to keep
  const recentToolUseIds = new Set<string>();
  const assistantMessages = messages.filter((m) => m.type === "assistant");
  const recentAssistants = assistantMessages.slice(-keepRecentTurns);

  for (const msg of recentAssistants) {
    const content = msg.message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block.type === "tool_use" && block.id) {
        recentToolUseIds.add(block.id);
      }
    }
  }

  // Truncate old tool results
  return messages.map((msg) => {
    if (msg.type !== "user") return msg;
    const content = msg.message.content;
    if (!Array.isArray(content)) return msg;

    let changed = false;
    const newContent = content.map((block) => {
      if (block.type !== "tool_result") return block;
      if (recentToolUseIds.has(block.tool_use_id)) return block;
      // Already truncated
      if (block.content === MICROCOMPACT_PLACEHOLDER) return block;

      changed = true;
      return { ...block, content: MICROCOMPACT_PLACEHOLDER };
    });

    if (!changed) return msg;
    return { ...msg, message: { ...msg.message, content: newContent } };
  });
}
