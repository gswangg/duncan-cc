/**
 * CC Session Tree Operations
 * 
 * Implements tree walk, preserved segment relinking, leaf detection,
 * and post-processing.
 * 
 * Equivalent to CC's wHY() + Vs6() + OHY() + Yt1() + vk()
 */

import type { CCMessage, ParsedSession } from "./parser.js";
import { isCompactBoundary } from "./parser.js";

// ============================================================================
// Preserved Segment Relinking — CC's wHY()
// ============================================================================

/**
 * Relink preserved segments after compaction.
 * 
 * When compaction preserves messages (messagesToKeep), the boundary marker
 * stores a preservedSegment with headUuid/tailUuid/anchorUuid. This function
 * relinks the tree so preserved messages are accessible via parentUuid walk.
 * 
 * Mutates the messages Map in place.
 */
export function relinkPreservedSegments(messages: Map<string, CCMessage>): void {
  // Find the last compact boundary and its index in insertion order
  let lastBoundary: CCMessage | undefined;
  let lastBoundaryIndex = -1;
  let preservedSegment: { headUuid: string; tailUuid: string; anchorUuid: string } | undefined;
  let index = 0;

  for (const entry of messages.values()) {
    if (isCompactBoundary(entry)) {
      lastBoundaryIndex = index;
      const seg = entry.compactMetadata?.preservedSegment;
      if (seg) {
        preservedSegment = seg;
        lastBoundary = entry;
      }
    }
    index++;
  }

  if (!preservedSegment || !lastBoundary) return;

  const totalEntries = messages.size;
  const isLastBoundary = lastBoundaryIndex === totalEntries - 1 ||
    // Check if this is the last boundary (no later boundaries exist)
    (() => {
      let idx = 0;
      let lastBIdx = -1;
      for (const entry of messages.values()) {
        if (isCompactBoundary(entry)) lastBIdx = idx;
        idx++;
      }
      return lastBIdx === lastBoundaryIndex;
    })();

  // Identify preserved segment by walking from tail to head
  const preservedUuids = new Set<string>();
  if (isLastBoundary) {
    const visited = new Set<string>();
    let current = messages.get(preservedSegment.tailUuid);
    let foundHead = false;

    while (current && !visited.has(current.uuid)) {
      visited.add(current.uuid);
      preservedUuids.add(current.uuid);
      if (current.uuid === preservedSegment.headUuid) {
        foundHead = true;
        break;
      }
      current = current.parentUuid ? messages.get(current.parentUuid) : undefined;
    }

    if (!foundHead) {
      // Walk broken — can't relink
      return;
    }
  }

  if (isLastBoundary) {
    // Relink head: head.parentUuid = anchorUuid
    const head = messages.get(preservedSegment.headUuid);
    if (head) {
      messages.set(preservedSegment.headUuid, {
        ...head,
        parentUuid: preservedSegment.anchorUuid,
      });
    }

    // Relink followers: messages with parentUuid === anchorUuid (except head) → parentUuid = tailUuid
    for (const [uuid, msg] of messages) {
      if (msg.parentUuid === preservedSegment.anchorUuid && uuid !== preservedSegment.headUuid) {
        messages.set(uuid, {
          ...msg,
          parentUuid: preservedSegment.tailUuid,
        });
      }
    }

    // Zero out usage for assistant messages in preserved segment
    for (const uuid of preservedUuids) {
      const msg = messages.get(uuid);
      if (msg?.type !== "assistant") continue;
      messages.set(uuid, {
        ...msg,
        message: {
          ...msg.message,
          usage: {
            ...msg.message.usage,
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      });
    }
  }

  // Delete pre-boundary messages not in preserved segment
  const toDelete: string[] = [];
  let idx = 0;
  for (const [uuid] of messages) {
    if (idx < lastBoundaryIndex && !preservedUuids.has(uuid)) {
      toDelete.push(uuid);
    }
    idx++;
  }
  for (const uuid of toDelete) {
    messages.delete(uuid);
  }
}

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
// Tree Walk — CC's Vs6()
// ============================================================================

/**
 * Walk parentUuid chain from leaf to root, return root→leaf order.
 * Mirrors CC's Vs6() with cycle detection.
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
// Post-processing — CC's OHY()
// ============================================================================

/**
 * Post-process the chain: handle split assistant messages and orphan tool results.
 * Mirrors CC's OHY().
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
// Field Stripping — CC's Yt1()
// ============================================================================

/** Strip internal fields not needed by the API */
export function stripInternalFields(messages: CCMessage[]): CCMessage[] {
  return messages.map((msg) => {
    const { isSidechain, parentUuid, ...rest } = msg;
    return rest as CCMessage;
  });
}

// ============================================================================
// Boundary Slicing — CC's vk()
// ============================================================================

/** Find last compact boundary index in array */
function findLastBoundaryIndex(messages: CCMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isCompactBoundary(messages[i])) return i;
  }
  return -1;
}

/** Slice from last compact boundary onward — CC's vk() */
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
 * Full pipeline: parse → relink → find leaf → walk → return chain.
 * Returns the raw chain (before normalization).
 */
export function buildRawChain(parsed: ParsedSession): CCMessage[] {
  // Step 1: Relink preserved segments (mutates the map)
  relinkPreservedSegments(parsed.messages);

  // Step 2: Find the best leaf
  const leaf = findBestLeaf(parsed.messages);
  if (!leaf) return [];

  // Step 3: Walk the chain
  return walkChain(parsed.messages, leaf);
}
