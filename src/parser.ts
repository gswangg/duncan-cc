/**
 * CC Session JSONL Parser
 * 
 * Parses Claude Code session files into structured entries.
 * Separates transcript messages from metadata entries.
 * 
 * Equivalent to CC's mu() + G26() separation logic.
 */

// ============================================================================
// Types
// ============================================================================

export interface CCMessage {
  uuid: string;
  parentUuid: string | null;
  session_id?: string;
  type: "user" | "assistant" | "system" | "progress" | "attachment";
  timestamp: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  isVisibleInTranscriptOnly?: boolean;
  isCompactSummary?: boolean;
  isApiErrorMessage?: boolean;
  apiError?: string;
  requestId?: string;
  parent_tool_use_id?: string | null;
  parentToolUseID?: string | null;
  toolUseID?: string | null;
  toolUseResult?: string;
  sourceToolAssistantUUID?: string;
  imagePasteIds?: string[];
  permissionMode?: string;
  origin?: { kind: string };
  gitBranch?: string;
  teamName?: string;
  cwd?: string;
  subtype?: string;
  content?: string;
  compactMetadata?: {
    preservedSegment?: {
      headUuid: string;
      tailUuid: string;
      anchorUuid: string;
    };
  };
  attachment?: any;
  message: {
    role: string;
    content: string | any[];
    model?: string;
    usage?: any;
    id?: string;
    type?: string;
    stop_reason?: string | null;
    stop_sequence?: string | null;
  };
  // Additional fields we pass through
  [key: string]: any;
}

export interface SummaryEntry {
  type: "summary";
  leafUuid: string;
  summary: string;
}

export interface ContentReplacementEntry {
  type: "content-replacement";
  sessionId?: string;
  agentId?: string;
  replacements: Array<{
    kind: string;
    toolUseId: string;
    replacement: string;
  }>;
}

export interface MetadataEntry {
  type: string;
  sessionId?: string;
  [key: string]: any;
}

export interface ParsedSession {
  messages: Map<string, CCMessage>;
  summaries: Map<string, string>;          // leafUuid → summary text
  customTitles: Map<string, string>;       // sessionId → title
  tags: Map<string, string>;              // sessionId → tag
  agentNames: Map<string, string>;        // sessionId → name
  agentColors: Map<string, string>;       // sessionId → color
  agentSettings: Map<string, string>;     // sessionId → setting
  modes: Map<string, string>;            // sessionId → mode
  contentReplacements: Map<string, ContentReplacementEntry["replacements"]>; // sessionId → replacements
  contextCollapseCommits: any[];
  contextCollapseSnapshot: any | null;
}

// ============================================================================
// Entry type checks — mirrors CC's mi(), of(), Ns6()
// ============================================================================

/** Transcript message check — CC's mi() */
export function isTranscriptMessage(entry: any): entry is CCMessage {
  return (
    entry.type === "user" ||
    entry.type === "assistant" ||
    entry.type === "attachment" ||
    entry.type === "system" ||
    entry.type === "progress"
  );
}

/** Compact boundary check — CC's of() */
export function isCompactBoundary(entry: any): boolean {
  return entry?.type === "system" && entry.subtype === "compact_boundary";
}

/** Ephemeral progress types — CC's Ns6() */
const EPHEMERAL_PROGRESS_TYPES = new Set([
  "bash_progress",
  "powershell_progress",
  "mcp_progress",
]);

export function isEphemeralProgress(type: string): boolean {
  return typeof type === "string" && EPHEMERAL_PROGRESS_TYPES.has(type);
}

/** API error message check — CC's Lt1() */
const INTERNAL_ERROR_MODEL = "internal_error";
const SYNTHETIC_ERROR_MODEL = "<synthetic>";

/** Model strings that mark pseudo-assistant entries injected by the CC harness
 * (API errors, "Prompt is too long" boundaries, etc.) and should never be
 * forwarded to the Anthropic API as a real model id. */
export const NON_REAL_ASSISTANT_MODELS: ReadonlySet<string> = new Set([
  INTERNAL_ERROR_MODEL,
  SYNTHETIC_ERROR_MODEL,
]);

export function isApiErrorMessage(entry: any): boolean {
  if (entry?.type !== "assistant") return false;
  if (entry.isApiErrorMessage === true) return true;
  const model = entry.message?.model;
  return typeof model === "string" && NON_REAL_ASSISTANT_MODELS.has(model);
}

/** Local command system message check — CC's gp1() */
export function isLocalCommand(entry: any): boolean {
  return entry.type === "system" && entry.subtype === "local_command";
}

// ============================================================================
// JSONL Parser — mirrors CC's mu()
// ============================================================================

export function parseJsonl(content: string | Buffer): any[] {
  const text = typeof content === "string" ? content : content.toString("utf-8");
  const results: any[] = [];
  let pos = 0;
  const len = text.length;

  while (pos < len) {
    let end = text.indexOf("\n", pos);
    if (end === -1) end = len;
    const line = text.substring(pos, end).trim();
    pos = end + 1;
    if (!line) continue;
    try {
      results.push(JSON.parse(line));
    } catch {
      // skip unparseable lines
    }
  }
  return results;
}

// ============================================================================
// Session Parser — mirrors CC's G26() separation logic
// ============================================================================

export function parseSession(content: string | Buffer): ParsedSession {
  const entries = parseJsonl(content);
  
  const messages = new Map<string, CCMessage>();
  const summaries = new Map<string, string>();
  const customTitles = new Map<string, string>();
  const tags = new Map<string, string>();
  const agentNames = new Map<string, string>();
  const agentColors = new Map<string, string>();
  const agentSettings = new Map<string, string>();
  const modes = new Map<string, string>();
  const contentReplacements = new Map<string, ContentReplacementEntry["replacements"]>();
  const contextCollapseCommits: any[] = [];
  let contextCollapseSnapshot: any | null = null;

  for (const entry of entries) {
    if (isTranscriptMessage(entry)) {
      // Skip ephemeral progress messages
      if (
        entry.type === "progress" &&
        entry.data &&
        typeof entry.data === "object" &&
        "type" in entry.data &&
        isEphemeralProgress(entry.data.type as string)
      ) {
        continue;
      }

      // Strip normalizedMessages from progress data (save memory)
      if (
        entry.type === "progress" &&
        entry.data &&
        typeof entry.data === "object" &&
        "normalizedMessages" in entry.data &&
        Array.isArray(entry.data.normalizedMessages) &&
        entry.data.normalizedMessages.length > 0
      ) {
        entry.data.normalizedMessages = [];
      }

      messages.set(entry.uuid, entry as CCMessage);
    } else if (entry.type === "summary" && entry.leafUuid) {
      summaries.set(entry.leafUuid, entry.summary);
    } else if (entry.type === "custom-title" && entry.sessionId) {
      customTitles.set(entry.sessionId, entry.customTitle);
    } else if (entry.type === "tag" && entry.sessionId) {
      tags.set(entry.sessionId, entry.tag);
    } else if (entry.type === "agent-name" && entry.sessionId) {
      agentNames.set(entry.sessionId, entry.agentName);
    } else if (entry.type === "agent-color" && entry.sessionId) {
      agentColors.set(entry.sessionId, entry.agentColor);
    } else if (entry.type === "agent-setting" && entry.sessionId) {
      agentSettings.set(entry.sessionId, entry.agentSetting);
    } else if (entry.type === "mode" && entry.sessionId) {
      modes.set(entry.sessionId, entry.mode);
    } else if (entry.type === "content-replacement") {
      const key = entry.agentId || entry.sessionId;
      if (key) {
        const existing = contentReplacements.get(key) ?? [];
        existing.push(...entry.replacements);
        contentReplacements.set(key, existing);
      }
    } else if (entry.type === "marble-origami-commit") {
      contextCollapseCommits.push(entry);
    } else if (entry.type === "marble-origami-snapshot") {
      contextCollapseSnapshot = entry;
    }
  }

  return {
    messages,
    summaries,
    customTitles,
    tags,
    agentNames,
    agentColors,
    agentSettings,
    modes,
    contentReplacements,
    contextCollapseCommits,
    contextCollapseSnapshot,
  };
}
