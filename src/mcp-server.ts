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

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { processSessionFile, processSessionWindows } from "./pipeline.js";
import { resolveSessionFiles, getProjectsDir, listAllSessionFiles } from "./discovery.js";
import { querySingleWindow, queryBatch } from "./query.js";

// ============================================================================
// Server setup
// ============================================================================

const server = new Server(
  { name: "duncan-cc", version: "0.1.0" },
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
            enum: ["project", "global", "session"],
            description:
              "Routing mode. 'project': sessions from a specific project dir. " +
              "'global': all sessions across all projects (newest first). " +
              "'session': a specific session file.",
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
        },
        required: ["question", "mode"],
      },
    },
    {
      name: "duncan_list_sessions",
      description: "List available Claude Code sessions. Use to discover sessions before querying.",
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
            description: "For 'project' mode: project directory path.",
          },
          cwd: {
            type: "string",
            description: "For 'project' mode: working directory to resolve project dir.",
          },
          limit: {
            type: "number",
            description: "Max sessions to list (default: 20).",
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
  const { name, arguments: args } = request.params;

  switch (name) {
    case "duncan_query":
      return handleDuncanQuery(args as any);
    case "duncan_list_sessions":
      return handleListSessions(args as any);
    default:
      return {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true,
      };
  }
});

async function handleDuncanQuery(args: {
  question: string;
  mode: string;
  projectDir?: string;
  sessionId?: string;
  cwd?: string;
  limit?: number;
  offset?: number;
  includeSubagents?: boolean;
}) {
  try {
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
      },
      {
        apiKey: undefined, // resolved automatically from CC/pi OAuth or ANTHROPIC_API_KEY
      },
    );

    if (result.results.length === 0) {
      return {
        content: [{ type: "text", text: "No sessions found matching the routing criteria." }],
      };
    }

    const withContext = result.results.filter((r) => r.result.hasContext);
    const relevant = withContext.length > 0 ? withContext : result.results;

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

    if (result.hasMore) {
      const nextOffset = (args.offset ?? 0) + (args.limit ?? 10);
      const remaining = result.totalWindows - nextOffset;
      parts.push(
        `\n\n---\n*Queried ${result.results.length} of ${result.totalWindows} windows. ${remaining} more available — call again with offset: ${nextOffset}.*`,
      );
    }

    const contextCount = withContext.length;
    const totalCount = result.results.length;
    parts.push(`\n\n*${contextCount}/${totalCount} sessions had relevant context. queryId: ${result.queryId}*`);

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

async function handleListSessions(args: {
  mode: string;
  projectDir?: string;
  cwd?: string;
  limit?: number;
}) {
  try {
    const resolved = resolveSessionFiles({
      mode: args.mode as any,
      projectDir: args.projectDir,
      cwd: args.cwd,
      limit: args.limit ?? 20,
    });

    if (resolved.sessions.length === 0) {
      return {
        content: [{ type: "text", text: "No sessions found." }],
      };
    }

    const lines = resolved.sessions.map((s) => {
      const date = s.mtime.toISOString().slice(0, 16);
      const size = s.size > 1024 * 1024
        ? `${(s.size / 1024 / 1024).toFixed(1)}MB`
        : `${(s.size / 1024).toFixed(0)}KB`;
      return `${s.sessionId.slice(0, 12)}  ${date}  ${size}  ${s.projectDir.split("/").slice(-1)[0]}`;
    });

    const header = `${resolved.totalCount} sessions${resolved.hasMore ? ` (showing ${resolved.sessions.length})` : ""}:`;
    return {
      content: [{ type: "text", text: `${header}\n\n${lines.join("\n")}` }],
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
