/**
 * CC Message Normalization — HX() equivalent
 * 
 * Converts internal CC message format to API-compatible format.
 * Handles: filtering, type conversion, merging, attachment conversion,
 * and 4 post-normalization transforms.
 * 
 * Pipeline: fjY → filter → type switch → post-transforms (pn6, QjY, gn6, cjY)
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

  // Post-transforms
  let normalized = result;
  normalized = filterOrphanedThinking(normalized);    // pn6
  normalized = removeTrailingThinking(normalized);    // QjY
  normalized = removeWhitespaceAssistant(normalized); // gn6
  normalized = fixEmptyAssistantContent(normalized);  // cjY

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
