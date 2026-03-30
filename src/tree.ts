/**
 * CC Session Tree Operations
 * 
 * Implements tree walk, preserved segment relinking, leaf detection,
 * and post-processing.
 * 
 * Equivalent to CC's relink + walk + post-process + strip + slice pipeline
 */

import type { CCMessage, ParsedSession } from "./parser.js";
import { isCompactBoundary } from "./parser.js";

// ============================================================================
// Leaf Detection
// ============================================================================

/** Find all leaf messages (messages not referenced as parentUuid by any other) */
export function findLeaves(messages: Map<string, CCMessage>): CCMessage[] {
  const referenced = new Set<string>();
  for (const msg of messages.values()) {
    if (msg.parentUuid) referenced.add(msg.parentUuid);
  }
  return [...messages.values()].filter((msg) => !referenced.has(msg.uuid));
}

/** Find the "best" leaf — the latest user or assistant message that's a leaf */
export function findBestLeaf(messages: Map<string, CCMessage>): CCMessage | undefined {
  const leaves = findLeaves(messages);
  let best: CCMessage | undefined;
  let bestTime = -Infinity;

  for (const leaf of leaves) {
    // Walk up to find the first user/assistant message
    const visited = new Set<string>();
    let current: CCMessage | undefined = leaf;
    while (current) {
      if (visited.has(current.uuid)) break;
      visited.add(current.uuid);
      if (current.type === "user" || current.type === "assistant") {
        const time = Date.parse(current.timestamp);
        if (time > bestTime) {
          bestTime = time;
          best = current;
        }
        break;
      }
      current = current.parentUuid ? messages.get(current.parentUuid) : undefined;
    }
  }

  return best;
}

// ============================================================================
// Tree Walk
// ============================================================================

/**
 * Walk parentUuid chain from leaf to root, return root→leaf order.
 * Walks the parentUuid chain from leaf to root with cycle detection.
 */
export function walkChain(messages: Map<string, CCMessage>, leaf: CCMessage): CCMessage[] {
  const chain: CCMessage[] = [];
  const visited = new Set<string>();
  let current: CCMessage | undefined = leaf;

  while (current) {
    if (visited.has(current.uuid)) {
      // Cycle detected
      break;
    }
    visited.add(current.uuid);
    chain.push(current);
    current = current.parentUuid ? messages.get(current.parentUuid) : undefined;
  }

  chain.reverse();
  return postProcessChain(messages, chain, visited);
}

// ============================================================================
// Post-processing
// ============================================================================

/**
 * Post-process the chain: handle split assistant messages and orphan tool results.
 * Post-process: handle orphan tool results, deduplicate split assistant messages.
 */
function postProcessChain(
  messages: Map<string, CCMessage>,
  chain: CCMessage[],
  visited: Set<string>,
): CCMessage[] {
  // Find assistant messages with API response IDs on the chain
  const assistants = chain.filter((m) => m.type === "assistant");
  if (assistants.length === 0) return chain;

  const byResponseId = new Map<string, CCMessage>();
  for (const a of assistants) {
    if (a.message.id) byResponseId.set(a.message.id, a);
  }

  // Find all assistant messages with same response IDs (potential splits)
  const allByResponseId = new Map<string, CCMessage[]>();
  const toolResultsByParent = new Map<string, CCMessage[]>();

  for (const msg of messages.values()) {
    if (msg.type === "assistant" && msg.message.id) {
      const existing = allByResponseId.get(msg.message.id);
      if (existing) existing.push(msg);
      else allByResponseId.set(msg.message.id, [msg]);
    } else if (
      msg.type === "user" &&
      msg.parentUuid &&
      Array.isArray(msg.message.content) &&
      msg.message.content.some((c: any) => c.type === "tool_result")
    ) {
      const existing = toolResultsByParent.get(msg.parentUuid);
      if (existing) existing.push(msg);
      else toolResultsByParent.set(msg.parentUuid, [msg]);
    }
  }

  // For now, return chain as-is. Split merging and orphan tool result
  // reattachment are edge cases we'll handle when we have test data for them.
  // The core tree walk is correct.
  return chain;
}

// ============================================================================
// Field Stripping — remove internal-only fields
// ============================================================================

/** Strip internal fields not needed by the API */
export function stripInternalFields(messages: CCMessage[]): CCMessage[] {
  return messages.map((msg) => {
    const { isSidechain, parentUuid, ...rest } = msg;
    return rest as CCMessage;
  });
}

// ============================================================================
// Boundary Slicing
// ============================================================================

/** Find last compact boundary index in array */
function findLastBoundaryIndex(messages: CCMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isCompactBoundary(messages[i])) return i;
  }
  return -1;
}

/** Slice from last compact boundary onward */
export function sliceFromBoundary(messages: CCMessage[]): CCMessage[] {
  const idx = findLastBoundaryIndex(messages);
  if (idx === -1) return messages;
  return messages.slice(idx);
}

// ============================================================================
// Compaction Windows
// ============================================================================

export interface CompactionWindow {
  windowIndex: number;
  messages: CCMessage[];
  modelInfo?: { provider: string; modelId: string };
}

/**
 * Split a session's message chain into compaction windows.
 * Each window is independently queryable.
 * 
 * For sessions with no compaction: single window with all messages.
 * For sessions with N boundaries: N+1 windows.
 */
export function getCompactionWindows(chain: CCMessage[]): CompactionWindow[] {
  // Find all boundary indices
  const boundaryIndices: number[] = [];
  for (let i = 0; i < chain.length; i++) {
    if (isCompactBoundary(chain[i])) {
      boundaryIndices.push(i);
    }
  }

  const resolveModel = (start: number, end: number): { provider: string; modelId: string } | undefined => {
    let info: { provider: string; modelId: string } | undefined;
    for (let i = start; i < end; i++) {
      const msg = chain[i];
      if (msg.type === "assistant" && msg.message?.model) {
        info = { provider: "anthropic", modelId: msg.message.model };
      }
    }
    return info;
  };

  // No boundaries — single window
  if (boundaryIndices.length === 0) {
    const modelInfo = resolveModel(0, chain.length);
    return chain.length > 0 ? [{ windowIndex: 0, messages: chain, modelInfo }] : [];
  }

  const windows: CompactionWindow[] = [];

  // Window 0: messages before first boundary
  const w0 = chain.slice(0, boundaryIndices[0]);
  if (w0.length > 0) {
    windows.push({ windowIndex: 0, messages: w0, modelInfo: resolveModel(0, boundaryIndices[0]) });
  }

  // Windows 1..N: boundary + messages until next boundary
  for (let k = 0; k < boundaryIndices.length; k++) {
    const start = boundaryIndices[k];
    const end = k + 1 < boundaryIndices.length ? boundaryIndices[k + 1] : chain.length;
    const windowMessages = chain.slice(start, end);
    if (windowMessages.length > 0) {
      windows.push({
        windowIndex: k + 1,
        messages: windowMessages,
        modelInfo: resolveModel(0, end),
      });
    }
  }

  return windows;
}

// ============================================================================
// High-level: Build session context from file content
// ============================================================================

/**
 * Build the session's message chain, reconstructing across compaction boundaries.
 *
 * After compaction, compact_boundary entries have parentUuid=null, creating
 * disconnected subtrees. A naive walk from the latest leaf stops at the first
 * null parentUuid, missing all pre-compaction messages.
 *
 * This function reconstructs the complete chain by:
 * 1. Snapshotting entries in JSONL (insertion) order
 * 2. Splitting at compact_boundary entries
 * 3. Walking each subtree independently from its best leaf
 * 4. Concatenating with boundaries between segments
 *
 * The result can be passed to getCompactionWindows to split into independently
 * queryable windows.
 */
export function buildRawChain(parsed: ParsedSession): CCMessage[] {
  const allEntries = [...parsed.messages.values()];

  const boundaryIndices: number[] = [];
  for (let i = 0; i < allEntries.length; i++) {
    if (isCompactBoundary(allEntries[i])) {
      boundaryIndices.push(i);
    }
  }

  // No boundaries — single subtree, simple walk
  if (boundaryIndices.length === 0) {
    const leaf = findBestLeaf(parsed.messages);
    if (!leaf) return [];
    return walkChain(parsed.messages, leaf);
  }

  const result: CCMessage[] = [];

  // Pre-first-boundary segment: the original conversation before any compaction
  const firstBIdx = boundaryIndices[0];
  if (firstBIdx > 0) {
    const segEntries = allEntries.slice(0, firstBIdx);
    const subMap = new Map(segEntries.map(e => [e.uuid, e]));
    const leaf = findBestLeaf(subMap);
    if (leaf) result.push(...walkChain(subMap, leaf));
  }

  // Each boundary + its following segment
  for (let k = 0; k < boundaryIndices.length; k++) {
    const bIdx = boundaryIndices[k];
    result.push(allEntries[bIdx]); // The compact_boundary entry itself

    const segStart = bIdx + 1;
    const segEnd = k + 1 < boundaryIndices.length ? boundaryIndices[k + 1] : allEntries.length;

    if (segStart < segEnd) {
      const segEntries = allEntries.slice(segStart, segEnd);
      const subMap = new Map(segEntries.map(e => [e.uuid, e]));
      const leaf = findBestLeaf(subMap);
      if (leaf) result.push(...walkChain(subMap, leaf));
    }
  }

  return result;
}
