/**
 * CC Message Normalization — HX()/p2() equivalent
 * 
 * Converts internal CC message format to API-compatible format.
 * Handles: filtering, type conversion, merging, attachment conversion,
 * and 8 post-normalization transforms matching CC 2.1.85's chain:
 * 
 * Pipeline: $w3 → filter → type switch → Jw3 → Me8 → Cw3 → Pe8(+fw3) → Iw3 → LV4 → ww3
 */

import type { CCMessage } from "./parser.js";
import { isApiErrorMessage, isCompactBoundary, isLocalCommand } from "./parser.js";

// ============================================================================
// Helpers
// ============================================================================

/** Make a synthetic user message — CC's F8() */
function makeUserMessage(content: string | any[], opts: Partial<CCMessage> = {}): CCMessage {
  return {
    type: "user",
    uuid: opts.uuid ?? crypto.randomUUID(),
    parentUuid: null,
    timestamp: opts.timestamp ?? new Date().toISOString(),
    isMeta: opts.isMeta ?? true,
    message: {
      role: "user",
      content: content,
    },
    ...opts,
  };
}

/** Normalize content to array form */
function toContentArray(content: string | any[]): any[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  return content;
}

/** Merge two user messages — CC's rb8() */
function mergeUsers(a: CCMessage, b: CCMessage): CCMessage {
  const aContent = toContentArray(a.message.content);
  const bContent = toContentArray(b.message.content);

  // CC's uyq: tool_results first, then other content
  const toolResults = [...aContent, ...bContent].filter((c) => c.type === "tool_result");
  const other = [...aContent, ...bContent].filter((c) => c.type !== "tool_result");
  const merged = [...toolResults, ...other];

  return {
    ...a,
    uuid: a.isMeta ? b.uuid : a.uuid,
    message: {
      ...a.message,
      content: merged,
    },
  };
}

/** Check if a content block is a tool_reference — CC's bx() */
function isToolReference(block: any): boolean {
  return block?.type === "tool_reference" || block?.type === "server_tool_use";
}

/** Last element of array */
function last<T>(arr: T[]): T | undefined {
  return arr[arr.length - 1];
}

/** Check if content is thinking-only — CC's St1() */
function isThinkingBlock(block: any): boolean {
  return block?.type === "thinking" || block?.type === "redacted_thinking";
}

/** Check if all content blocks are whitespace-only text — CC's djY() */
function isWhitespaceOnly(content: any[]): boolean {
  if (content.length === 0) return false;
  return content.every(
    (c) => c.type === "text" && (c.text === undefined || c.text.trim() === "")
  );
}

// ============================================================================
// Attachment conversion — CC's sl1()
// 
// For duncan queries, we do a simplified version that preserves the
// semantic content without needing the full tool definitions.
// ============================================================================

function convertAttachment(msg: CCMessage): CCMessage[] {
  const attachment = msg.attachment;
  if (!attachment) return [];

  switch (attachment.type) {
    case "directory":
      return [
        makeUserMessage(
          `Called the Bash tool with the following input: ${JSON.stringify({ command: `ls ${attachment.path}` })}`,
          { isMeta: true, timestamp: msg.timestamp },
        ),
        makeUserMessage(
          `Result of calling the Bash tool: ${JSON.stringify({ stdout: attachment.content, stderr: "", interrupted: false })}`,
          { isMeta: true, timestamp: msg.timestamp },
        ),
      ];

    case "file": {
      const content = attachment.content;
      if (content?.type === "image") {
        return [makeUserMessage(
          Array.isArray(content.content) ? content.content : [content],
          { isMeta: true, timestamp: msg.timestamp },
        )];
      }
      // text, notebook, pdf
      const text = typeof content === "string"
        ? content
        : content?.text ?? content?.content ?? JSON.stringify(content);
      return [makeUserMessage(
        `Result of calling the Read tool: ${text}`,
        { isMeta: true, timestamp: msg.timestamp },
      )];
    }

    case "edited_text_file":
      return [makeUserMessage(
        `Note: ${attachment.filename} was modified, either by the user or by a linter. Here are the relevant changes:\n${attachment.snippet}`,
        { isMeta: true, timestamp: msg.timestamp },
      )];

    case "selected_lines_in_ide": {
      const content = attachment.content?.length > 2000
        ? attachment.content.substring(0, 2000) + "\n... (truncated)"
        : attachment.content;
      return [makeUserMessage(
        `The user selected lines ${attachment.lineStart} to ${attachment.lineEnd} from ${attachment.filename}:\n${content}\n\nThis may or may not be related to the current task.`,
        { isMeta: true, timestamp: msg.timestamp },
      )];
    }

    case "opened_file_in_ide":
      return [makeUserMessage(
        `The user opened the file ${attachment.filename} in the IDE. This may or may not be related to the current task.`,
        { isMeta: true, timestamp: msg.timestamp },
      )];

    case "compact_file_reference":
      return [makeUserMessage(
        `Note: ${attachment.filename} was read before the last conversation was summarized, but the contents are too large to include. Use Read tool if you need to access it.`,
        { isMeta: true, timestamp: msg.timestamp },
      )];

    case "plan_file_reference":
      return [makeUserMessage(
        `A plan file exists from plan mode at: ${attachment.planFilePath}\n\nPlan contents:\n\n${attachment.planContent}`,
        { isMeta: true, timestamp: msg.timestamp },
      )];

    case "invoked_skills": {
      if (!attachment.skills?.length) return [];
      const skillsText = attachment.skills
        .map((s: any) => `### Skill: ${s.name}\nPath: ${s.path}\n\n${s.content}`)
        .join("\n\n---\n\n");
      return [makeUserMessage(
        `The following skills were invoked in this session:\n\n${skillsText}`,
        { isMeta: true, timestamp: msg.timestamp },
      )];
    }

    case "pdf_reference":
      return [makeUserMessage(
        `PDF file: ${attachment.filename} (${attachment.pageCount} pages, ${attachment.fileSize}). Use the Read tool with pages parameter to read specific page ranges.`,
        { isMeta: true, timestamp: msg.timestamp },
      )];

    case "teammate_mailbox":
    case "team_context":
      // Simplified: include the raw content
      return [makeUserMessage(
        JSON.stringify(attachment),
        { isMeta: true, timestamp: msg.timestamp },
      )];

    case "todo_reminder": {
      if (!attachment.content?.length) return [];
      const todos = attachment.content
        .map((t: any, i: number) => `${i + 1}. [${t.status}] ${t.text}`)
        .join("\n");
      return [makeUserMessage(
        `Active todos:\n${todos}`,
        { isMeta: true, timestamp: msg.timestamp },
      )];
    }

    default:
      // Unknown attachment type — include as JSON
      return [makeUserMessage(
        `[Attachment: ${attachment.type}]\n${JSON.stringify(attachment)}`,
        { isMeta: true, timestamp: msg.timestamp },
      )];
  }
}

// ============================================================================
// Pre-step: Reorder attachments — CC's fjY()
// ============================================================================

function reorderAttachments(messages: CCMessage[]): CCMessage[] {
  const result: CCMessage[] = [];
  const pendingAttachments: CCMessage[] = [];

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.type === "attachment") {
      pendingAttachments.push(msg);
    } else if (
      (msg.type === "assistant" ||
        (msg.type === "user" &&
          Array.isArray(msg.message.content) &&
          msg.message.content[0]?.type === "tool_result")) &&
      pendingAttachments.length > 0
    ) {
      for (const att of pendingAttachments) result.push(att);
      result.push(msg);
      pendingAttachments.length = 0;
    } else {
      result.push(msg);
    }
  }
  // Remaining attachments
  for (const att of pendingAttachments) result.push(att);

  return result.reverse();
}

// ============================================================================
// Strip tool references from user messages — CC's It1()
// ============================================================================

function stripToolReferences(msg: CCMessage): CCMessage {
  const content = msg.message.content;
  if (!Array.isArray(content)) return msg;

  const hasRefs = content.some(
    (c) =>
      c.type === "tool_result" &&
      Array.isArray(c.content) &&
      c.content.some(isToolReference)
  );
  if (!hasRefs) return msg;

  return {
    ...msg,
    message: {
      ...msg.message,
      content: content.map((c) => {
        if (c.type !== "tool_result" || !Array.isArray(c.content)) return c;
        const filtered = c.content.filter((b: any) => !isToolReference(b));
        if (filtered.length === 0)
          return { ...c, content: [{ type: "text", text: "[Tool references removed]" }] };
        return { ...c, content: filtered };
      }),
    },
  };
}

// ============================================================================
// Main normalization — CC's HX()
// ============================================================================

export function normalizeMessages(messages: CCMessage[]): CCMessage[] {
  // Pre-step: reorder attachments
  const reordered = reorderAttachments(messages);

  // Filter and convert
  const filtered = reordered.filter((msg) => {
    // Remove progress messages
    if (msg.type === "progress") return false;
    // Remove non-local-command system messages (including compact boundaries)
    if (msg.type === "system" && !isLocalCommand(msg)) return false;
    // Remove API error messages
    if (isApiErrorMessage(msg)) return false;
    return true;
  });

  const result: CCMessage[] = [];

  for (const msg of filtered) {
    switch (msg.type) {
      case "system": {
        // Only local_command system messages reach here
        // Convert to user message
        const userMsg = makeUserMessage(msg.content ?? "", {
          uuid: msg.uuid,
          timestamp: msg.timestamp,
        });
        const prev = last(result);
        if (prev?.type === "user") {
          result[result.length - 1] = mergeUsers(prev, userMsg);
        } else {
          result.push(userMsg);
        }
        break;
      }

      case "user": {
        // Strip tool references
        const stripped = stripToolReferences(msg);
        const prev = last(result);
        if (prev?.type === "user") {
          result[result.length - 1] = mergeUsers(prev, stripped);
        } else {
          result.push(stripped);
        }
        break;
      }

      case "assistant": {
        // Remap tool names (simplified: keep as-is for duncan)
        // Merge split assistant messages (same message.id)
        const prev = last(result);
        if (
          prev?.type === "assistant" &&
          prev.message.id &&
          msg.message.id &&
          prev.message.id === msg.message.id
        ) {
          // Merge content arrays
          result[result.length - 1] = {
            ...prev,
            message: {
              ...prev.message,
              content: [
                ...(Array.isArray(prev.message.content) ? prev.message.content : []),
                ...(Array.isArray(msg.message.content) ? msg.message.content : []),
              ],
            },
          };
        } else {
          result.push(msg);
        }
        break;
      }

      case "attachment": {
        const converted = convertAttachment(msg);
        for (const convMsg of converted) {
          const prev = last(result);
          if (prev?.type === "user") {
            result[result.length - 1] = mergeUsers(prev, convMsg);
          } else {
            result.push(convMsg);
          }
        }
        break;
      }
    }
  }

  // Post-transforms — matches CC's chain: Jw3 → Me8 → Cw3 → Pe8 → Iw3 → LV4 → fw3 → ww3
  let normalized = result;
  normalized = relocateDeferredToolRefText(normalized); // Jw3
  normalized = filterOrphanedThinking(normalized);     // Me8/pn6
  normalized = removeTrailingThinking(normalized);     // Cw3/QjY
  normalized = removeWhitespaceAssistant(normalized);  // Pe8/gn6 (includes fw3 re-merge)
  normalized = fixEmptyAssistantContent(normalized);   // Iw3/cjY
  normalized = reorderSystemReminders(normalized);     // LV4
  // fw3 (re-merge consecutive users) is inlined in removeWhitespaceAssistant
  normalized = flattenErrorToolResults(normalized);    // ww3
  normalized = fixOrphanedToolUse(normalized);         // ensure every tool_use has a tool_result

  return normalized;
}

// ============================================================================
// Post-transform 1: Filter orphaned thinking-only assistant messages — pn6()
// ============================================================================

function filterOrphanedThinking(messages: CCMessage[]): CCMessage[] {
  // Collect message IDs that have non-thinking content
  const hasNonThinking = new Set<string>();
  for (const msg of messages) {
    if (msg.type !== "assistant") continue;
    const content = msg.message.content;
    if (!Array.isArray(content)) continue;
    if (content.some((c) => !isThinkingBlock(c)) && msg.message.id) {
      hasNonThinking.add(msg.message.id);
    }
  }

  return messages.filter((msg) => {
    if (msg.type !== "assistant") return true;
    const content = msg.message.content;
    if (!Array.isArray(content) || content.length === 0) return true;
    // Keep if has non-thinking content
    if (!content.every(isThinkingBlock)) return true;
    // Keep if another message with same ID has non-thinking content
    if (msg.message.id && hasNonThinking.has(msg.message.id)) return true;
    // Filter out
    return false;
  });
}

// ============================================================================
// Post-transform 2: Remove trailing thinking from last assistant — QjY()
// ============================================================================

function removeTrailingThinking(messages: CCMessage[]): CCMessage[] {
  if (messages.length === 0) return messages;
  const lastMsg = messages[messages.length - 1];
  if (lastMsg.type !== "assistant") return messages;

  const content = lastMsg.message.content;
  if (!Array.isArray(content)) return messages;

  // Find last non-thinking index
  const lastBlock = content[content.length - 1];
  if (!lastBlock || !isThinkingBlock(lastBlock)) return messages;

  let lastNonThinking = content.length - 1;
  while (lastNonThinking >= 0 && isThinkingBlock(content[lastNonThinking])) {
    lastNonThinking--;
  }

  const trimmed =
    lastNonThinking < 0
      ? [{ type: "text", text: "[No message content]", citations: [] }]
      : content.slice(0, lastNonThinking + 1);

  const result = [...messages];
  result[messages.length - 1] = {
    ...lastMsg,
    message: { ...lastMsg.message, content: trimmed },
  };
  return result;
}

// ============================================================================
// Post-transform 3: Remove whitespace-only assistant messages — gn6()
// ============================================================================

function removeWhitespaceAssistant(messages: CCMessage[]): CCMessage[] {
  let hasRemoval = false;
  const filtered = messages.filter((msg) => {
    if (msg.type !== "assistant") return true;
    const content = msg.message.content;
    if (!Array.isArray(content) || content.length === 0) return true;
    if (isWhitespaceOnly(content)) {
      hasRemoval = true;
      return false;
    }
    return true;
  });

  if (!hasRemoval) return messages;

  // Merge resulting adjacent user messages
  const merged: CCMessage[] = [];
  for (const msg of filtered) {
    const prev = last(merged);
    if (msg.type === "user" && prev?.type === "user") {
      merged[merged.length - 1] = mergeUsers(prev, msg);
    } else {
      merged.push(msg);
    }
  }
  return merged;
}

// ============================================================================
// Post-transform 4: Fix empty assistant content — cjY()
// ============================================================================

function fixEmptyAssistantContent(messages: CCMessage[]): CCMessage[] {
  const PLACEHOLDER = "[No message content]";

  return messages.map((msg, i) => {
    if (msg.type !== "assistant") return msg;
    // Don't fix the last message
    if (i === messages.length - 1) return msg;
    const content = msg.message.content;
    if (Array.isArray(content) && content.length === 0) {
      return {
        ...msg,
        message: {
          ...msg.message,
          content: [{ type: "text", text: PLACEHOLDER, citations: [] }],
        },
      };
    }
    return msg;
  });
}

// ============================================================================
// Post-transform 5: Relocate deferred tool_reference text — Jw3()
// Moves text blocks from user messages that contain tool_references into the
// next user message that has tool_results (but no tool_references itself).
// This keeps reference context adjacent to the tool output it describes.
// ============================================================================

function hasToolReferences(content: any[]): boolean {
  return content.some((c: any) => c.type === "tool_reference");
}

function relocateDeferredToolRefText(messages: CCMessage[]): CCMessage[] {
  const result = [...messages];

  for (let i = 0; i < result.length; i++) {
    const msg = result[i];
    if (msg.type !== "user") continue;
    const content = msg.message.content;
    if (!Array.isArray(content)) continue;
    if (!hasToolReferences(content)) continue;

    const textBlocks = content.filter((c: any) => c.type === "text");
    if (textBlocks.length === 0) continue;

    // Find the next user message with tool_results but without tool_references
    let targetIdx = -1;
    for (let j = i + 1; j < result.length; j++) {
      const candidate = result[j];
      if (candidate.type !== "user") continue;
      const cc = candidate.message.content;
      if (!Array.isArray(cc)) continue;
      if (!cc.some((c: any) => c.type === "tool_result")) continue;
      if (hasToolReferences(cc)) continue;
      targetIdx = j;
      break;
    }

    if (targetIdx === -1) continue;

    // Move text blocks from source to target
    result[i] = {
      ...msg,
      message: {
        ...msg.message,
        content: content.filter((c: any) => c.type !== "text"),
      },
    };

    const target = result[targetIdx];
    result[targetIdx] = {
      ...target,
      message: {
        ...target.message,
        content: [...target.message.content, ...textBlocks],
      },
    };
  }

  return result;
}

// ============================================================================
// Post-transform 6: Reorder system-reminder blocks in tool_results — LV4()
// Moves <system-reminder> text blocks from user messages into the last
// tool_result in that same message, keeping them adjacent to tool output.
// ============================================================================

function reorderSystemReminders(messages: CCMessage[]): CCMessage[] {
  return messages.map((msg) => {
    if (msg.type !== "user") return msg;
    const content = msg.message.content;
    if (!Array.isArray(content)) return msg;
    if (!content.some((c: any) => c.type === "tool_result")) return msg;

    // Separate system-reminder text blocks from everything else
    const reminders: any[] = [];
    const rest: any[] = [];
    for (const block of content) {
      if (
        block.type === "text" &&
        typeof block.text === "string" &&
        block.text.startsWith("<system-reminder>")
      ) {
        reminders.push(block);
      } else {
        rest.push(block);
      }
    }

    if (reminders.length === 0) return msg;

    // Find the last tool_result and inject reminders into its content
    const lastToolResultIdx = rest.map((c: any) => c.type).lastIndexOf("tool_result");
    if (lastToolResultIdx === -1) return msg;

    const lastToolResult = rest[lastToolResultIdx];
    const existingContent = Array.isArray(lastToolResult.content)
      ? lastToolResult.content
      : typeof lastToolResult.content === "string"
        ? [{ type: "text", text: lastToolResult.content }]
        : [];

    const updated = {
      ...lastToolResult,
      content: [...existingContent, ...reminders],
    };

    const newContent = [...rest.slice(0, lastToolResultIdx), updated, ...rest.slice(lastToolResultIdx + 1)];
    return {
      ...msg,
      message: { ...msg.message, content: newContent },
    };
  });
}

// ============================================================================
// Post-transform 7: Flatten error tool_results — ww3()
// Error tool_results that contain non-text blocks (images, etc.) get stripped
// to text-only content. Prevents sending binary content in error responses.
// ============================================================================

function flattenErrorToolResults(messages: CCMessage[]): CCMessage[] {
  return messages.map((msg) => {
    if (msg.type !== "user") return msg;
    const content = msg.message.content;
    if (!Array.isArray(content)) return msg;

    let changed = false;
    const newContent = content.map((block: any) => {
      if (block.type !== "tool_result" || !block.is_error) return block;
      const inner = block.content;
      if (!Array.isArray(inner)) return block;
      // If all content is text, leave it alone
      if (inner.every((c: any) => c.type === "text")) return block;

      changed = true;
      const textParts = inner.filter((c: any) => c.type === "text").map((c: any) => c.text);
      return {
        ...block,
        content: textParts.length > 0 ? [{ type: "text", text: textParts.join("\n\n") }] : [],
      };
    });

    if (!changed) return msg;
    return { ...msg, message: { ...msg.message, content: newContent } };
  });
}

// ============================================================================
// Post-transform 8: Fix orphaned tool_use blocks
// Ensure every tool_use in an assistant message has a corresponding tool_result
// in the following user message. Insert synthetic results for missing ones.
// ============================================================================

function fixOrphanedToolUse(messages: CCMessage[]): CCMessage[] {
  const result: CCMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    result.push(messages[i]);

    const msg = messages[i];
    if (msg.type !== "assistant" || !Array.isArray(msg.message.content)) continue;

    const toolUses = msg.message.content.filter((c: any) => c.type === "tool_use");
    if (toolUses.length === 0) continue;

    // Check next message for matching tool_results
    const next = messages[i + 1];
    const nextContent = (next?.type === "user" && Array.isArray(next?.message?.content))
      ? next.message.content
      : [];
    const existingResultIds = new Set(
      nextContent.filter((c: any) => c.type === "tool_result").map((c: any) => c.tool_use_id)
    );

    const orphaned = toolUses.filter((tu: any) => !existingResultIds.has(tu.id));
    if (orphaned.length === 0) continue;

    // Build synthetic tool_result blocks
    const syntheticResults = orphaned.map((tu: any) => ({
      type: "tool_result",
      tool_use_id: tu.id,
      content: "[Tool execution interrupted]",
      is_error: true,
    }));

    if (next?.type === "user" && Array.isArray(next?.message?.content)) {
      // Inject into the existing user message
      messages[i + 1] = {
        ...next,
        message: {
          ...next.message,
          content: [...syntheticResults, ...nextContent],
        },
      };
    } else {
      // Insert a new user message with the synthetic results
      result.push(makeUserMessage(syntheticResults, {
        timestamp: msg.timestamp,
        isMeta: true,
      }));
    }
  }

  return result;
}
