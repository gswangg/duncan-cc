# duncan-cc

Query dormant Claude Code sessions. The [Duncan Idaho approach](https://gswangg.net/posts/duncan-idaho-agent-memory) to agent memory, for CC.

When CC sessions end or get compacted, their conversation history is still on disk. Duncan loads that history into a fresh LLM call and asks it your question — leveraging the model's native attention mechanism instead of summaries or search.

## Install

```bash
git clone https://github.com/gswangg/duncan-cc.git
cd duncan-cc
npm install
```

## Authentication

Duncan resolves auth automatically:

1. Explicit apiKey/token parameter
2. CC OAuth credentials (`~/.claude/.credentials.json`)
3. `ANTHROPIC_API_KEY` environment variable

## Configure CC

```bash
claude mcp add duncan -- npx tsx /path/to/duncan-cc/src/mcp-server.ts
```

## Tools

### `duncan_query`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `question` | string | ✓ | The question to ask |
| `mode` | string | ✓ | `project`, `global`, `session`, `self`, `ancestors` |
| `projectDir` | string | | For project mode |
| `sessionId` | string | | For session mode |
| `cwd` | string | | Working directory for context resolution |
| `limit` | number | | Max sessions/windows (default: 10) |
| `offset` | number | | Pagination offset |
| `copies` | number | | For self mode: sample count (default: 3) |
| `includeSubagents` | boolean | | Include subagent transcripts |

### `duncan_list_sessions`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `mode` | string | ✓ | `project` or `global` |
| `projectDir` | string | | For project mode |
| `cwd` | string | | Working directory |
| `limit` | number | | Max sessions (default: 20) |

## Routing modes

| Mode | Target |
|------|--------|
| `project` | Sessions from same project dir (self-excluded) |
| `global` | All sessions across all projects (self-excluded) |
| `session` | Specific session by ID or path |
| `self` | Own active window, queried N times for sampling diversity |
| `ancestors` | Own prior compaction windows (excluding active) |

## How it works

Duncan replicates CC's full session-to-API pipeline, then substitutes its own query:

1. Parse JSONL session file
2. Relink preserved segments (compaction tree surgery)
3. Walk parentUuid chain from leaf to root
4. Post-process (merge split assistants, fix orphan tool results)
5. Normalize messages (filter, convert types, merge, 8 post-transforms)
6. Apply content replacements (persisted outputs from disk)
7. Microcompact (truncate old tool results)
8. Inject userContext (CLAUDE.md + date)
9. Build system prompt (full parity with CC's static sections + dynamic context from project dir)
10. Convert to API format
11. Add prompt caching breakpoints
12. Query with `duncan_response` structured output tool

Self-exclusion: the calling session is identified by scanning for the MCP `toolUseId` in session file tails — deterministic, zero config, swarm-safe.

## Known gaps

- **MCP server instructions** — not available for dormant sessions (fetched live, not persisted)
- **Tool schemas** — only `duncan_response` is sent; session's original tools aren't callable
- **Compaction test coverage** — synthetic tests only; no real compacted sessions in test corpus

## Tests

```bash
npm test
```

Corpus-dependent tests skip gracefully when `testdata/` is absent.

## Related

- [duncan-pi](https://github.com/gswangg/duncan-pi) — duncan for the [pi](https://github.com/badlogic/pi-mono) coding agent
- [The Duncan Idaho Approach to Agent Memory](https://gswangg.net/posts/duncan-idaho-agent-memory) — design writeup
