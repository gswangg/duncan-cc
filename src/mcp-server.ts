#!/usr/bin/env node
/**
 * Duncan CC — MCP Server
 * 
 * Exposes duncan session querying as an MCP tool that Claude Code can call.
 * Uses stdio transport.
 * 
 * Usage:
 *   npx tsx src/mcp-server.ts
 *   # or after build:
 *   node dist/mcp-server.js
 */

import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { processSessionFile, processSessionWindows } from "./pipeline.js";
import { resolveSessionFiles, getProjectsDir, listAllSessionFiles, listProjects, extractGitBranch, extractSessionPreview, cwdToProjectDirName } from "./discovery.js";
import { querySingleWindow, queryBatch, querySelf, queryAncestors, querySubagents } from "./query.js";

// ============================================================================
// Server setup
// ============================================================================

const server = new Server(
  { name: "duncan-cc", version: "0.4.0" },
  { capabilities: { tools: {} } },
);

// ============================================================================
// Tool definitions
// ============================================================================

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "duncan_query",
      description:
        "Query dormant Claude Code sessions to recall information from previous conversations. " +
        "Loads session context and asks the target session's model whether it has relevant information. " +
        "Use when you need to find something discussed in a previous CC session.",
      inputSchema: {
        type: "object" as const,
        properties: {
          question: {
            type: "string",
            description: "The question to ask previous sessions. Be specific and self-contained.",
          },
          mode: {
            type: "string",
            enum: ["project", "global", "session", "self", "ancestors", "subagents", "branch"],
            description:
              "Routing mode. 'project': sessions from a specific project dir. " +
              "'global': all sessions across all projects (newest first). " +
              "'session': a specific session file. " +
              "'self': query own active window N times for sampling diversity. " +
              "'ancestors': query own prior compaction windows (excluding active). " +
              "'subagents': query subagent transcripts of the active session. " +
              "'branch': sessions from the same project that share the current git branch.",
          },
          projectDir: {
            type: "string",
            description: "For 'project' mode: explicit project directory path. If omitted, uses cwd.",
          },
          sessionId: {
            type: "string",
            description: "For 'session' mode: session file path or session ID.",
          },
          cwd: {
            type: "string",
            description: "Working directory for context resolution (CLAUDE.md, git status). Defaults to process.cwd().",
          },
          limit: {
            type: "number",
            description: "Max sessions to query (default: 10).",
          },
          offset: {
            type: "number",
            description: "Skip this many sessions for pagination (default: 0).",
          },
          includeSubagents: {
            type: "boolean",
            description: "Include subagent transcripts in search (default: false).",
          },
          copies: {
            type: "number",
            description: "For 'self' mode: number of parallel queries for sampling diversity (default: 3).",
          },
          batchSize: {
            type: "number",
            description: "Max concurrent API calls per batch (default: 5).",
          },
          gitBranch: {
            type: "string",
            description: "For 'branch' mode: explicit git branch name. If omitted, uses the calling session's branch.",
          },
        },
        required: ["question", "mode"],
      },
    },
    {
      name: "duncan_projects",
      description:
        "List all Claude Code projects with metadata. Use to discover what projects exist " +
        "before targeting a specific project with duncan_query. Returns project directories, " +
        "session counts, last activity timestamps, and git branches.",
      inputSchema: {
        type: "object" as const,
        properties: {
          limit: {
            type: "number",
            description: "Max projects to list (default: 50).",
          },
          offset: {
            type: "number",
            description: "Pagination offset (default: 0).",
          },
        },
        required: [],
      },
    },
    {
      name: "duncan_list_sessions",
      description:
        "List available Claude Code sessions with previews. " +
        "Use to discover sessions before querying. " +
        "Returns session IDs, timestamps, sizes, git branches, working directories, " +
        "and first/last user message previews.",
      inputSchema: {
        type: "object" as const,
        properties: {
          mode: {
            type: "string",
            enum: ["project", "global"],
            description: "'project': sessions from a project dir. 'global': all sessions.",
          },
          projectDir: {
            type: "string",
            description: "For 'project' mode: explicit project directory path.",
          },
          projectPath: {
            type: "string",
            description: "For 'project' mode: original working directory path (resolved to project dir via CC's hashing).",
          },
          cwd: {
            type: "string",
            description: "For 'project' mode: working directory to resolve project dir.",
          },
          limit: {
            type: "number",
            description: "Max sessions to list (default: 20).",
          },
          previews: {
            type: "boolean",
            description: "Include message previews (default: true).",
          },
          previewLines: {
            type: "number",
            description: "Number of messages to show from head and tail of each session (default: 2).",
          },
        },
        required: ["mode"],
      },
    },
  ],
}));

// ============================================================================
// Tool handlers
// ============================================================================

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args, _meta } = request.params;

  // CC passes tool_use ID in _meta — used for self-exclusion
  const meta = _meta as Record<string, unknown> | undefined;
  const toolUseId = meta?.["claudecode/toolUseId"] as string | undefined;
  const progressToken = meta?.progressToken as string | number | undefined;

  switch (name) {
    case "duncan_query":
      return handleDuncanQuery(args as any, toolUseId, progressToken);
    case "duncan_projects":
      return handleListProjects(args as any);
    case "duncan_list_sessions":
      return handleListSessions(args as any);
    default:
      return {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true,
      };
  }
});

/**
 * Format token usage stats for display.
 */
function formatTokenStats(usage: { inputTokens: number; outputTokens: number; cacheCreationInputTokens: number; cacheReadInputTokens: number }): string {
  const fmt = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
  const parts = [`${fmt(usage.inputTokens)} in`, `${fmt(usage.outputTokens)} out`];
  if (usage.cacheReadInputTokens > 0) parts.push(`${fmt(usage.cacheReadInputTokens)} cache-read`);
  if (usage.cacheCreationInputTokens > 0) parts.push(`${fmt(usage.cacheCreationInputTokens)} cache-write`);
  return `Tokens: ${parts.join(", ")}`;
}

/**
 * Send an MCP progress notification if a progressToken was provided.
 */
async function sendProgress(progressToken: string | number | undefined, progress: number, total: number): Promise<void> {
  if (progressToken === undefined) return;
  try {
    await server.notification({
      method: "notifications/progress",
      params: { progressToken, progress, total },
    });
  } catch {
    // Best-effort — don't let progress notifications break queries
  }
}

async function handleDuncanQuery(args: {
  question: string;
  mode: string;
  projectDir?: string;
  sessionId?: string;
  cwd?: string;
  limit?: number;
  offset?: number;
  includeSubagents?: boolean;
  copies?: number;
  batchSize?: number;
  gitBranch?: string;
}, toolUseId?: string, progressToken?: string | number) {
  try {
    // Self mode: query own active window N times for sampling diversity
    if (args.mode === "self") {
      if (!toolUseId) {
        return {
          content: [{ type: "text", text: "Self mode requires toolUseId from _meta (only available when called from CC)." }],
          isError: true,
        };
      }
      const result = await querySelf(args.question, {
        toolUseId,
        copies: args.copies ?? 3,
        batchSize: args.batchSize,
        apiKey: undefined,
        onProgress: (completed, total) => sendProgress(progressToken, completed, total),
      });

      if (result.results.length === 0) {
        return {
          content: [{ type: "text", text: "Could not find calling session for self-query." }],
          isError: true,
        };
      }

      // Format: show all N answers
      const answers = result.results.map((r, i) => {
        return `### Sample ${i + 1}\n${r.result.answer}\n*— ${r.model}*`;
      }).join("\n\n---\n\n");

      const contextCount = result.results.filter(r => r.result.hasContext).length;
      return {
        content: [{ type: "text", text: `**${args.question}** (${result.results.length} samples)\n\n${answers}\n\n*${contextCount}/${result.results.length} had relevant context. ${formatTokenStats(result.usage)}. queryId: ${result.queryId}*` }],
      };
    }

    // Ancestors mode: query prior compaction windows of the calling session
    if (args.mode === "ancestors") {
      if (!toolUseId) {
        return {
          content: [{ type: "text", text: "Ancestors mode requires toolUseId from _meta (only available when called from CC)." }],
          isError: true,
        };
      }
      const result = await queryAncestors(args.question, {
        toolUseId,
        limit: args.limit ?? 50,
        offset: args.offset ?? 0,
        batchSize: args.batchSize,
        apiKey: undefined,
        onProgress: (completed, total) => sendProgress(progressToken, completed, total),
      });

      if (result.results.length === 0) {
        return {
          content: [{ type: "text", text: "No ancestor windows found. This session has no compaction boundaries." }],
        };
      }

      const withContext = result.results.filter(r => r.result.hasContext);
      const relevant = withContext.length > 0 ? withContext : result.results;

      const answers = relevant.map((r) => {
        const label = relevant.length === 1 ? "" : `### Window ${r.windowIndex}\n`;
        return `${label}${r.result.answer}\n*— ${r.model}*`;
      }).join("\n\n---\n\n");

      const parts = [`**${args.question}**\n\n${answers}`];

      if (result.hasMore) {
        const nextOffset = (args.offset ?? 0) + (args.limit ?? 50);
        const remaining = result.totalWindows - nextOffset;
        parts.push(`\n\n---\n*Queried ${result.results.length} of ${result.totalWindows} windows. ${remaining} more available — call again with offset: ${nextOffset}.*`);
      }

      const contextCount = withContext.length;
      parts.push(`\n\n*${contextCount}/${result.results.length} windows had relevant context. ${formatTokenStats(result.usage)}. queryId: ${result.queryId}*`);

      return { content: [{ type: "text", text: parts.join("") }] };
    }

    // Subagents mode: query subagent transcripts of the calling session
    if (args.mode === "subagents") {
      if (!toolUseId) {
        return {
          content: [{ type: "text", text: "Subagents mode requires toolUseId from _meta (only available when called from CC)." }],
          isError: true,
        };
      }
      const result = await querySubagents(args.question, {
        toolUseId,
        limit: args.limit ?? 50,
        offset: args.offset ?? 0,
        batchSize: args.batchSize,
        apiKey: undefined,
        onProgress: (completed, total) => sendProgress(progressToken, completed, total),
      });

      if (result.results.length === 0) {
        return {
          content: [{ type: "text", text: "No subagent transcripts found for this session." }],
        };
      }

      const errors = result.results.filter(r => r.result.answer.startsWith("Error: "));
      const nonErrors = result.results.filter(r => !r.result.answer.startsWith("Error: "));
      const withContext = nonErrors.filter(r => r.result.hasContext);
      const relevant = withContext.length > 0 ? withContext : nonErrors.length > 0 ? nonErrors : result.results;

      const answers = relevant.map((r) => {
        const label = relevant.length === 1 ? "" : `### ${r.sessionId.slice(0, 20)} (window ${r.windowIndex})\n`;
        return `${label}${r.result.answer}\n*— ${r.model}*`;
      }).join("\n\n---\n\n");

      const parts = [`**${args.question}**\n\n${answers}`];

      if (errors.length > 0) {
        const errorLines = errors.map(r => `- ${r.sessionId.slice(0, 20)} (window ${r.windowIndex}): ${r.result.answer}`).join("\n");
        parts.push(`\n\n---\n**${errors.length} error(s):**\n${errorLines}`);
      }

      if (result.hasMore) {
        const nextOffset = (args.offset ?? 0) + (args.limit ?? 50);
        const remaining = result.totalWindows - nextOffset;
        parts.push(`\n\n---\n*Queried ${result.results.length} of ${result.totalWindows} windows. ${remaining} more available — call again with offset: ${nextOffset}.*`);
      }

      const contextCount = withContext.length;
      parts.push(`\n\n*${contextCount}/${result.results.length} subagent windows had relevant context. ${formatTokenStats(result.usage)}. queryId: ${result.queryId}*`);

      return { content: [{ type: "text", text: parts.join("") }] };
    }

    const result = await queryBatch(
      args.question,
      {
        mode: args.mode as any,
        projectDir: args.projectDir,
        sessionId: args.sessionId,
        cwd: args.cwd,
        limit: args.limit ?? 10,
        offset: args.offset ?? 0,
        includeSubagents: args.includeSubagents ?? false,
        toolUseId, // for self-exclusion + branch detection
        gitBranch: args.gitBranch,
      },
      {
        apiKey: undefined,
        batchSize: args.batchSize,
        onProgress: (completed, total) => sendProgress(progressToken, completed, total),
      },
    );

    if (result.results.length === 0) {
      return {
        content: [{ type: "text", text: "No sessions found matching the routing criteria." }],
      };
    }

    const errors = result.results.filter((r) => r.result.answer.startsWith("Error: "));
    const nonErrors = result.results.filter((r) => !r.result.answer.startsWith("Error: "));
    const withContext = nonErrors.filter((r) => r.result.hasContext);
    const relevant = withContext.length > 0 ? withContext : nonErrors.length > 0 ? nonErrors : result.results;

    const answers = relevant
      .map((r) => {
        const label = relevant.length === 1
          ? ""
          : `### ${r.sessionId.slice(0, 12)} (window ${r.windowIndex})\n`;
        const modelLine = `\n*— ${r.model}*`;
        return `${label}${r.result.answer}${modelLine}`;
      })
      .join("\n\n---\n\n");

    const parts = [`**${args.question}**\n\n${answers}`];

    if (errors.length > 0) {
      const errorLines = errors.map((r) => `- ${r.sessionId.slice(0, 12)} (window ${r.windowIndex}): ${r.result.answer}`).join("\n");
      parts.push(`\n\n---\n**${errors.length} error(s):**\n${errorLines}`);
    }

    if (result.hasMore) {
      const nextOffset = (args.offset ?? 0) + (args.limit ?? 10);
      const remaining = result.totalWindows - nextOffset;
      parts.push(
        `\n\n---\n*Queried ${result.results.length} of ${result.totalWindows} windows. ${remaining} more available — call again with offset: ${nextOffset}.*`,
      );
    }

    const contextCount = withContext.length;
    const totalCount = result.results.length;
    parts.push(`\n\n*${contextCount}/${totalCount} sessions had relevant context. ${formatTokenStats(result.usage)}. queryId: ${result.queryId}*`);

    return {
      content: [{ type: "text", text: parts.join("") }],
    };
  } catch (err: any) {
    return {
      content: [{ type: "text", text: `Duncan query error: ${err.message}` }],
      isError: true,
    };
  }
}

async function handleListProjects(args: {
  limit?: number;
  offset?: number;
}) {
  try {
    const result = listProjects({ limit: args.limit, offset: args.offset });

    if (result.projects.length === 0) {
      return {
        content: [{ type: "text", text: "No projects found." }],
      };
    }

    const lines = result.projects.map((p) => {
      const date = p.lastActivity.toISOString().slice(0, 16);
      const branches = p.branches.length > 0 ? p.branches.join(", ") : "—";
      return `${p.cwd}\n  sessions: ${p.sessionCount}  last: ${date}  branches: ${branches}`;
    });

    const header = `${result.totalCount} projects${result.hasMore ? ` (showing ${result.projects.length})` : ""}:`;
    return {
      content: [{ type: "text", text: `${header}\n\n${lines.join("\n\n")}` }],
    };
  } catch (err: any) {
    return {
      content: [{ type: "text", text: `Error listing projects: ${err.message}` }],
      isError: true,
    };
  }
}

async function handleListSessions(args: {
  mode: string;
  projectDir?: string;
  projectPath?: string;
  cwd?: string;
  limit?: number;
  previews?: boolean;
  previewLines?: number;
}) {
  try {
    // Resolve projectDir from projectPath if provided
    const projectDir = args.projectDir
      ?? (args.projectPath ? join(getProjectsDir(), cwdToProjectDirName(args.projectPath)) : undefined);

    const resolved = resolveSessionFiles({
      mode: args.mode as any,
      projectDir,
      cwd: args.cwd,
      limit: args.limit ?? 20,
    });

    if (resolved.sessions.length === 0) {
      return {
        content: [{ type: "text", text: "No sessions found." }],
      };
    }

    const showPreviews = args.previews !== false;
    const previewLines = args.previewLines ?? 2;

    const lines = resolved.sessions.map((s) => {
      const date = s.mtime.toISOString().slice(0, 16);
      const size = s.size > 1024 * 1024
        ? `${(s.size / 1024 / 1024).toFixed(1)}MB`
        : `${(s.size / 1024).toFixed(0)}KB`;

      let line = `**${s.sessionId.slice(0, 12)}**  ${date}  ${size}`;

      if (showPreviews) {
        const preview = extractSessionPreview(s.path, previewLines);
        if (preview.gitBranch) line += `  branch: ${preview.gitBranch}`;
        if (preview.cwd) line += `\n  cwd: ${preview.cwd}`;

        const roleIcon = (role: string) => role === "assistant" ? "◇" : "▸";
        const formatMsg = (m: { role: string; text: string }) => {
          const truncated = m.text.replace(/\n/g, " ").slice(0, 120);
          return `${roleIcon(m.role)} ${truncated}${m.text.length > 120 ? "…" : ""}`;
        };

        if (preview.headMessages.length > 0) {
          for (const m of preview.headMessages) {
            line += `\n  ${formatMsg(m)}`;
          }
        }
        if (preview.tailMessages.length > 0) {
          line += `\n  ...`;
          for (const m of preview.tailMessages) {
            line += `\n  ${formatMsg(m)}`;
          }
        }
      }

      return line;
    });

    const header = `${resolved.totalCount} sessions${resolved.hasMore ? ` (showing ${resolved.sessions.length})` : ""}:`;
    return {
      content: [{ type: "text", text: `${header}\n\n${lines.join("\n\n")}` }],
    };
  } catch (err: any) {
    return {
      content: [{ type: "text", text: `Error listing sessions: ${err.message}` }],
      isError: true,
    };
  }
}

// ============================================================================
// Start server
// ============================================================================

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("duncan-cc MCP server running on stdio");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
