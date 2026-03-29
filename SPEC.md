# Duncan for Claude Code — Spec

## Overview

Duncan-cc replicates CC's full message pipeline to hydrate dormant CC sessions,
then queries them with questions via the Anthropic API. Exposed as an MCP server
(stdio transport) with two tools: `duncan_query` and `duncan_list_sessions`.

## Pipeline: Disk → API

```
Session file (.jsonl)
  │
  ▼
Parse JSONL — separate transcript from metadata
  │
  ▼
Preserved segment relinking (compaction tree surgery)
  │
  ▼
Walk parentUuid chain from leaf to root
  │
  ▼
Post-process: handle orphan tool results, deduplicate assistant splits
  │
  ▼
Strip internal fields (isSidechain, parentUuid)
  │
  ▼
Slice from last compact boundary onward
  │
  ▼
Content replacements (persisted-output resolution from tool-results/)
  │
  ▼
Microcompact (truncate old tool results)
  │
  ▼
Normalize messages:
  ├── Reorder attachments adjacent to referencing messages
  ├── Filter: progress, non-local system, API error messages
  ├── System messages → user messages (system-reminder wrapper)
  ├── Strip tool_references from user messages
  ├── Merge consecutive same-role messages
  ├── Merge split assistant messages (same message.id)
  ├── Convert attachment messages to user messages
  │
  ├── Post-transform 1: Relocate deferred tool_reference text
  ├── Post-transform 2: Filter orphaned thinking-only assistant messages
  ├── Post-transform 3: Remove trailing thinking from last assistant
  ├── Post-transform 4: Remove whitespace-only assistants + re-merge users
  ├── Post-transform 5: Fix empty assistant content (placeholder)
  ├── Post-transform 6: Reorder system-reminder within tool_results
  ├── Post-transform 7: Flatten error tool_results (text-only)
  └── Post-transform 8: Fix orphaned tool_use (synthetic tool_result)
  │
  ▼
Inject userContext (<system-reminder> with CLAUDE.md + date)
  │
  ▼
Build system prompt (full parity with CC):
  ├── Identity/intro
  ├── System rules
  ├── Coding instructions
  ├── Careful actions guidelines
  ├── Tool usage
  ├── Tone and style
  ├── Output efficiency
  ├── Environment info (cwd, platform, model)
  ├── CLAUDE.md (from session's original cwd)
  ├── Memory (from project dir MEMORY.md)
  └── Language preference
  │
  ▼
Convert to API format: {role, content} only
  │
  ▼
Add cache_control breakpoints:
  ├── System prompt blocks: ephemeral cache
  └── Penultimate message: ephemeral cache (session context boundary)
  │
  ▼
Append duncan query as final user message
  │
  ▼
messages.create() with duncan_response tool
```

## Routing Modes

| Mode | Target | Self-exclusion |
|------|--------|----------------|
| `project` | All sessions in same project dir | ✅ via toolUseId |
| `global` | All sessions across all projects | ✅ via toolUseId |
| `session` | Specific session by ID/path | — |
| `self` | Own active window, N copies (sampling diversity) | — (queries self intentionally) |
| `ancestors` | Own prior compaction windows (excluding active) | Active window excluded |

### Self-exclusion

CC passes `toolUseId` in MCP request `_meta` as `"claudecode/toolUseId"`.
The assistant message containing that tool_use is written to the session JSONL
before the tool is invoked (`appendFileSync`). We scan the last 32KB of candidate
session files for the ID to deterministically identify the calling session.

### Self mode

Sends the question to N copies of the active window for sampling diversity.
Two-wave cache strategy:
1. Wave 1: 1 query primes the cache (full input cost)
2. Wave 2: remaining N-1 queries in batches (hit cached prefix)

### Ancestors mode

Queries compaction windows of the calling session excluding the active window.
Returns nothing if the session has no compaction boundaries. In CC (no dfork
lineage), "ancestors" = the compacted-away context from the current session.

## Authentication

Resolution order:
1. Explicit apiKey/token parameter
2. CC OAuth credentials (`~/.claude/.credentials.json`)
3. `ANTHROPIC_API_KEY` environment variable

OAuth requires identity prefix: `"You are Claude Code, Anthropic's official CLI
for Claude."` as first system block + beta headers
`claude-code-20250219,oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14`.

## Prompt Caching

Cache breakpoints placed on:
- **System prompt**: each text block gets `cache_control: { type: "ephemeral" }`
- **Messages**: breakpoint on last content block of penultimate message

This caches the session context (stable across queries) while letting the duncan
query question (last message) vary without invalidating cache.

## System Prompt Reconstruction

Static sections embedded verbatim from CC source:
- Identity/intro, system rules, coding instructions, careful actions,
  tool usage, tone/style, output efficiency

Dynamic sections reconstructed from session context:
- **Environment**: from session JSONL metadata (cwd, model) + local filesystem
- **CLAUDE.md**: from session's original cwd hierarchy (if paths exist)
- **Memory**: from CC project dir (`~/.claude/projects/<hash>/memory/MEMORY.md`)
- **Tool instructions**: adapted based on tool names from session's tool_use blocks
- **Language**: configurable

This matches CC's own resume behavior: rebuild system prompt from current state.

## Known Gaps

### MCP Server Instructions
CC injects MCP server `instructions` from the initialize handshake into the system
prompt. Cannot reconstruct for dormant sessions — instructions are fetched live and
not persisted to disk. Equivalent to resuming a CC session with tools disconnected.

### Compaction Test Coverage
No real CC sessions with compaction boundaries in the test corpus (CC's 30-day
`cleanupPeriodDays` default purged older sessions before the corpus was captured).
Compaction logic is tested with synthetic fixtures only.

## Session Storage

- **Config dir**: `~/.claude/`
- **Projects dir**: `~/.claude/projects/`
- **Project dir**: `~/.claude/projects/<hashed-cwd>/` (cwd with `/` → `-`)
- **Session file**: `<project-dir>/<session-id>.jsonl`
- **Subagent transcripts**: `<project-dir>/<session-id>/subagents/<subdir>/agent-<id>.jsonl`
- **Tool results**: `<project-dir>/<session-id>/tool-results/<id>.txt`
- **Memory**: `<project-dir>/memory/MEMORY.md`

## MCP Server

Two tools exposed via stdio transport:

### duncan_query
Query dormant sessions. Parameters:
- `question` (required): the question to ask
- `mode` (required): `project`, `global`, `session`, `self`, `ancestors`
- `projectDir`: for project mode
- `sessionId`: for session mode
- `cwd`: working directory context
- `limit`: max sessions/windows (default: 10)
- `offset`: pagination offset
- `copies`: for self mode, number of samples (default: 3)
- `includeSubagents`: include subagent transcripts (default: false)

### duncan_list_sessions
List available sessions. Parameters:
- `mode` (required): `project`, `global`
- `projectDir`, `cwd`, `limit`
