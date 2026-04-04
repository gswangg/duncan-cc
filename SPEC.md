# Duncan for Claude Code — Spec

## Overview

Duncan-cc currently replicates CC's full message pipeline to hydrate dormant CC
sessions, then queries them with questions via the Anthropic API. Exposed as an
MCP server (stdio transport) with three tools: `duncan_query`,
`duncan_projects`, and `duncan_list_sessions`.

The rewrite in progress adds a second execution backend:
- `api` — current direct Anthropic API path
- `headless` — staged transcript + real `claude --print --resume <jsonl>` path

Short-term goal: land the headless backend beside the current backend, prove it
works well enough, then decide whether it should replace the reverse-engineered
API/OAuth path.

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
  ├── Tool usage (+ per-tool instructions based on session's tools)
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
| `subagents` | Subagent transcripts of the active session | — |
| `branch` | Sessions sharing the same git branch in the project | ✅ via toolUseId |

### Self-exclusion

CC passes `toolUseId` in MCP request `_meta` as `"claudecode/toolUseId"`.
The assistant message containing that tool_use is written to the session JSONL
before the tool is invoked (`appendFileSync`). We scan the last 32KB of candidate
session files for the ID to deterministically identify the calling session.

Self-exclusion is window-level: only the active (last) window of the calling
session is excluded. Compaction windows are kept — they contain context that was
summarized away from the active window.

### Self mode

Sends the question to N copies of the active window for sampling diversity.
Two-wave cache strategy:
1. Wave 1: 1 query primes the cache (full input cost)
2. Wave 2: remaining N-1 queries in batches (hit cached prefix)

### Ancestors mode

Queries compaction windows of the calling session excluding the active window.
Returns nothing if the session has no compaction boundaries. In CC (no dfork
lineage), "ancestors" = the compacted-away context from the current session.

### Branch mode

Collects all sessions from the same project directory that share a git branch
with the calling session, ordered by mtime. CC sessions store `gitBranch` in
their JSONL entries. If the calling session's branch can't be auto-detected,
it can be passed explicitly via the `gitBranch` parameter.

## Authentication

Resolution order:
1. Explicit apiKey/token parameter
2. CC OAuth credentials (`~/.claude/.credentials.json`)
3. macOS keychain (`security find-generic-password` — macOS only)
4. `ANTHROPIC_API_KEY` environment variable

## Prompt Caching

Cache breakpoints placed on:
- **System prompt**: each text block gets `cache_control: { type: "ephemeral" }`
- **Messages**: breakpoint on last content block of penultimate message

This caches the session context (stable across queries) while letting the duncan
query question (last message) vary without invalidating cache.

## System Prompt Reconstruction

Static sections embedded verbatim from CC source:
- Identity/intro, system rules, coding instructions, careful actions,
  tool usage (conditionally includes per-tool instructions like "use Read
  instead of cat" based on which tools appear in the session), tone/style,
  output efficiency

Dynamic sections reconstructed from session context:
- **Environment**: from session JSONL metadata (cwd, model) + local filesystem
- **CLAUDE.md**: from session's original cwd hierarchy (if paths exist)
- **Memory**: from CC project dir (`~/.claude/projects/<hash>/memory/MEMORY.md`)
- **Language**: configurable

This matches CC's own resume behavior: rebuild system prompt from current state.

For subagent transcripts, the system prompt is dispatched based on agent type
(read from `.meta.json` alongside the subagent JSONL):
- **Explore**: read-only search specialist prompt
- **Plan**: software architect prompt (read-only)
- **Other/unknown**: falls back to the standard session prompt

Note: tool schemas are NOT included — duncan sends only its own `duncan_response`
tool. The session's original tools are not callable during a duncan query.

## Headless Backend Notes

The headless backend stages transcript files and resumes them through real
Claude Code. Current proven pieces:
- staged transcript layout and raw-window slicing
- compaction-window truncation contracts
- real `claude --print --resume <jsonl>` invocation wrapper
- real-Claude memory benchmarking at controlled concurrency

Observed real-Claude memory profile on this 4 GB Linux machine, measuring only
Claude child PIDs:
- batch/concurrency `5` → peak aggregate RSS about **1.45 GB**
- batch/concurrency `10` → peak aggregate RSS about **2.73 GB**

Interpretation:
- RSS scales roughly linearly with concurrency for this workload
- virtual size is huge and noisy, but RSS is the meaningful capacity signal
- `batchSize` must be treated as a memory knob for the headless backend, not
  just a throughput knob

## Query Logging

Every query is logged to `~/.claude/duncan.jsonl` as append-only JSONL. Each record:
- `batchId`, `question`, `answer`, `hasContext`
- `targetSession`, `windowIndex`, `sourceSession`
- `strategy`, `model`
- `inputTokens`, `outputTokens`, `cacheCreationInputTokens`, `cacheReadInputTokens`
- `latencyMs`, `timestamp`

Logging is best-effort (failures don't break queries).

## MCP Progress Notifications

During batch queries, progress notifications are sent via MCP's standard
`progressToken` mechanism. Each completed session window sends a notification
with `{ progress: completed, total: totalWindows }`. Requires the caller to
include `_meta.progressToken` in the request.

## Known Gaps

### MCP Server Instructions
CC injects MCP server `instructions` from the initialize handshake into the system
prompt. Cannot reconstruct for dormant sessions — instructions are fetched live and
not persisted to disk. Equivalent to resuming a CC session with tools disconnected.

### Custom Agent System Prompts
CC supports custom agents defined in `.claude/agents/<name>.md` with user-defined system
prompts. Duncan handles built-in agent types (Explore, Plan) by reading the `.meta.json`
file alongside subagent transcripts and dispatching the correct system prompt. Custom agent
prompts are not recoverable from the transcript — those sessions fall back to the standard
prompt.

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
- **Query log**: `~/.claude/duncan.jsonl`

## MCP Server

Three tools exposed via stdio transport:

### duncan_query
Query dormant sessions. Parameters:
- `question` (required): the question to ask
- `mode` (required): `project`, `global`, `session`, `self`, `ancestors`, `subagents`, `branch`
- `projectDir`: for project/branch mode
- `sessionId`: for session mode
- `cwd`: working directory context
- `limit`: max sessions/windows (default: 10)
- `offset`: pagination offset
- `copies`: for self mode, number of samples (default: 3)
- `includeSubagents`: include subagent transcripts (default: false)
- `batchSize`: max concurrent queries per batch (default: 5). Warning: for the headless real-Claude backend, memory use scales roughly linearly with `batchSize`; on this 4 GB test machine, `5` concurrent Claude subprocesses used about 1.45 GB RSS and `10` used about 2.73 GB RSS.
- `gitBranch`: for branch mode, explicit branch name

### duncan_projects
List all CC projects with metadata. Parameters:
- `limit`: max projects (default: 50)
- `offset`: pagination offset

Returns: project cwd, session count, last activity, git branches.

### duncan_list_sessions
List available sessions. Parameters:
- `mode` (required): `project`, `global`
- `projectDir`, `cwd`, `limit`
