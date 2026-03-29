# duncan-cc

Query dormant Claude Code sessions. The [Duncan Idaho approach](https://gswangg.net/posts/duncan-idaho-agent-memory) to agent memory, for CC.

When CC sessions end or get compacted, their conversation history is still on disk. Duncan loads that history into a fresh LLM call and asks it your question — leveraging the model's native attention mechanism instead of summaries or search.

## Install

```bash
npm install -g @gswangg/duncan-cc
```

Or from source:

```bash
git clone https://github.com/gswangg/duncan-cc.git
cd duncan-cc
npm install
```

## Configure CC

```bash
# If installed globally via npm:
claude mcp add duncan -- npx @gswangg/duncan-cc

# If installed from source:
claude mcp add duncan -- npx tsx /path/to/duncan-cc/src/mcp-server.ts
```

## Authentication

Duncan resolves auth automatically in this order:

1. **Explicit** apiKey/token parameter (if passed)
2. **CC OAuth** credentials from `~/.claude/.credentials.json` (primary for CC users)
3. **API key** from `ANTHROPIC_API_KEY` environment variable

Most CC users authenticate via OAuth — duncan picks this up automatically with no configuration.

## Tools

Duncan exposes three MCP tools:

### `duncan_query`

Query dormant sessions to recall information from previous conversations. Loads session context and asks the target session's model whether it has relevant information.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `question` | string | ✓ | — | The question to ask. Be specific and self-contained. |
| `mode` | string | ✓ | — | Routing mode (see [Routing Modes](#routing-modes) below) |
| `projectDir` | string | | cwd-based | Explicit project directory path (for `project` and `branch` modes) |
| `sessionId` | string | | — | Session file path or ID (for `session` mode) |
| `cwd` | string | | process.cwd() | Working directory for context resolution |
| `limit` | number | | 10 | Max sessions/windows to query |
| `offset` | number | | 0 | Skip this many sessions for pagination |
| `copies` | number | | 3 | For `self` mode: number of parallel samples |
| `includeSubagents` | boolean | | false | Include subagent transcripts in search |
| `batchSize` | number | | 5 | Max concurrent API calls per batch |
| `gitBranch` | string | | auto-detected | For `branch` mode: explicit branch name |

### `duncan_projects`

List all CC projects with metadata. Use to discover what projects exist before targeting a specific project with `duncan_query`.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `limit` | number | | 50 | Max projects to list |
| `offset` | number | | 0 | Pagination offset |

Returns for each project:
- Original working directory path (reconstructed from CC's hashed directory name)
- Session count
- Most recent activity timestamp
- Git branches seen across recent sessions

### `duncan_list_sessions`

List available sessions for a project or globally.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `mode` | string | ✓ | — | `project` or `global` |
| `projectDir` | string | | cwd-based | For `project` mode |
| `cwd` | string | | process.cwd() | Working directory |
| `limit` | number | | 20 | Max sessions to list |

## Routing Modes

### `project`

Query all sessions from the same project directory. The calling session is automatically excluded via self-detection. Sessions are ordered by modification time (newest first).

Use when you want to search through recent work in the current project.

### `global`

Query all sessions across all CC projects (newest first). Self-excluded. The broadest search — useful when you don't know which project holds the information.

### `session`

Query a specific session by ID or file path. No self-exclusion (you might intentionally target a known session). Pass the session ID via the `sessionId` parameter — either a UUID or full file path.

### `self`

Query your own active window multiple times for **sampling diversity**. Instead of searching other sessions, this sends the same question to N independent copies of the current conversation context. Useful for exploring different perspectives on complex problems.

Uses a **two-wave cache strategy**:
1. **Wave 1**: 1 query primes the prompt cache (pays full input token cost)
2. **Wave 2**: remaining N-1 queries in parallel (hit cached prefix, ~90% cheaper)

The `copies` parameter controls how many samples to take (default: 3).

### `ancestors`

Query the calling session's **prior compaction windows**. When CC compacts a session, the old context is summarized but the original messages remain in the JSONL file. Ancestors mode lets you query that pre-compaction context.

Returns nothing if the session has no compaction boundaries. In CC (which has no dfork lineage), "ancestors" always means the session's own compacted-away history.

### `subagents`

Query **subagent transcripts** of the calling session. When CC spawns subagent tasks (e.g., parallel tool calls), their transcripts are stored alongside the main session. This mode searches through those transcripts.

Subagent files are sorted by modification time for deterministic pagination.

### `branch`

Query all sessions in the same project that share the **same git branch** as the calling session. CC records `gitBranch` in JSONL entries, so this grouping works without explicit lineage metadata.

Useful when work on a feature spans multiple sessions — `branch` naturally groups them by the git branch they were on.

If the calling session's branch can't be auto-detected, pass it explicitly via the `gitBranch` parameter.

## How It Works

### Pipeline

Duncan replicates CC's full session-to-API message pipeline, then substitutes its own query as the final message:

```
Session file (.jsonl)
  │
  ▼ Parse JSONL — separate transcript from metadata
  ▼ Relink preserved segments (compaction tree surgery)
  ▼ Walk parentUuid chain from leaf to root
  ▼ Post-process (merge split assistants, fix orphan tool results)
  ▼ Slice from last compaction boundary
  ▼ Normalize messages (filter, convert types, merge, 8 post-transforms)
  ▼ Content replacements (resolve persisted tool outputs from disk)
  ▼ Microcompact (truncate old tool results)
  ▼ Inject userContext (CLAUDE.md + date)
  ▼ Build system prompt (full CC parity)
  ▼ Convert to API format
  ▼ Add prompt cache breakpoints
  ▼ Append duncan question as final user message
  ▼ Query with duncan_response structured output tool
```

### Self-Exclusion

When CC calls an MCP tool, it writes the assistant message (containing the `tool_use` block) to the session JSONL *before* invoking the tool. CC passes the tool_use ID in the MCP request's `_meta` as `claudecode/toolUseId`.

Duncan scans the last 32KB of candidate session files for this ID to deterministically identify the calling session — no configuration needed, safe for concurrent sessions.

### System Prompt Reconstruction

Duncan rebuilds the system prompt with full parity to CC's own prompt:

**Static sections** (embedded verbatim from CC):
- Identity/intro, system rules, coding instructions
- Careful actions guidelines, tool usage, tone/style, output efficiency

**Dynamic sections** (reconstructed from session context):
- **Environment**: from session JSONL metadata (cwd, model) + local filesystem
- **CLAUDE.md**: loaded from session's original cwd hierarchy (if paths exist)
- **Memory**: from CC project directory (`~/.claude/projects/<hash>/memory/MEMORY.md`)
- **Tool-conditional instructions**: only included when the corresponding tools appear in the session (e.g., "use Read instead of cat" only when Read tool was used)
- **Language**: configurable

Tool schemas are NOT included — duncan sends only its own `duncan_response` tool. The session's original tools aren't callable during a duncan query.

### Prompt Caching

Cache breakpoints placed on:
- **System prompt**: each text block gets `cache_control: { type: "ephemeral" }`
- **Messages**: breakpoint on last content block of penultimate message

This caches the session context (stable across queries) while letting the duncan question (last message) vary without invalidating cache. For multi-session batch queries, each session's context is cached independently.

### Query Logging

Every query is logged to `~/.claude/duncan.jsonl` as append-only JSONL. Each record captures:

- Batch ID, question, answer, hasContext flag
- Target session, window index, source session
- Routing strategy, model used
- Token counts (input, output, cache creation, cache read)
- Latency in milliseconds, timestamp

Process with standard tools: `cat ~/.claude/duncan.jsonl | jq .`

### Progress Notifications

During batch queries, duncan sends MCP progress notifications via the standard `progressToken` mechanism. As each session window completes, a notification is sent so the calling session can display real-time status (e.g., "Querying 3/7 sessions...").

## Session Storage Layout

Duncan reads CC's native session storage:

```
~/.claude/
├── .credentials.json          # OAuth credentials
├── duncan.jsonl               # Query log (written by duncan)
└── projects/
    └── <hashed-cwd>/          # e.g., -Users-foo-bar
        ├── <session-id>.jsonl # Session transcript
        ├── <session-id>/
        │   ├── subagents/     # Subagent transcripts
        │   │   └── <subdir>/
        │   │       └── agent-<id>.jsonl
        │   └── tool-results/  # Persisted tool outputs
        │       └── <id>.txt
        └── memory/
            └── MEMORY.md      # Project memory
```

## Known Gaps

- **MCP server instructions** — CC injects MCP server `instructions` from the initialize handshake into the system prompt. These aren't persisted to disk, so duncan can't reconstruct them for dormant sessions. Equivalent to resuming a CC session with tools disconnected.
- **Tool schemas** — only `duncan_response` is sent; the session's original tools aren't callable during a duncan query.
- **Compaction test coverage** — compaction logic is tested with synthetic fixtures only. No real compacted sessions in the current test corpus (CC's 30-day `cleanupPeriodDays` default purged them before capture).

## Tests

```bash
npm test
```

Corpus-dependent tests skip gracefully when `testdata/` is absent.

## Related

- [duncan-pi](https://github.com/gswangg/duncan-pi) — Duncan for the [pi](https://github.com/badlogic/pi-mono) coding agent
- [The Duncan Idaho Approach to Agent Memory](https://gswangg.net/posts/duncan-idaho-agent-memory) — design writeup
