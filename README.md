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

Duncan resolves auth automatically in this order:

1. `ANTHROPIC_API_KEY` environment variable
2. CC's OAuth credentials (`~/.claude/.credentials.json`)
3. Pi's OAuth credentials (`~/.pi/agent/auth.json`)

OAuth tokens use the `claude-code-20250219` and `oauth-2025-04-20` beta headers with the required Claude Code identity system prompt prefix.

## Configure CC to use duncan

Add to your Claude Code MCP config:

```bash
claude mcp add duncan -- npx tsx /path/to/duncan-cc/src/mcp-server.ts
```

Or with explicit API key:

```bash
claude mcp add -e ANTHROPIC_API_KEY=sk-... duncan -- npx tsx /path/to/duncan-cc/src/mcp-server.ts
```

## Tools

### `duncan_query`

Query past sessions with a question.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `question` | string | ✓ | The question to ask. Be specific and self-contained. |
| `mode` | string | ✓ | `"project"`, `"global"`, or `"session"` |
| `projectDir` | string | | For project mode: explicit project dir path |
| `sessionId` | string | | For session mode: session file path or ID |
| `cwd` | string | | Working directory for CLAUDE.md resolution |
| `limit` | number | | Max sessions to query (default: 10) |
| `offset` | number | | Pagination offset (default: 0) |
| `includeSubagents` | boolean | | Include subagent transcripts (default: false) |

### `duncan_list_sessions`

List available sessions before querying.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `mode` | string | ✓ | `"project"` or `"global"` |
| `projectDir` | string | | For project mode: project dir path |
| `cwd` | string | | Working directory to resolve project dir |
| `limit` | number | | Max sessions to list (default: 20) |

## How it works

Duncan replicates CC's full session-to-API pipeline:

1. **Parse JSONL** — read session file, separate transcript from metadata
2. **Relink preserved segments** — handle compaction tree surgery (`wHY` equivalent)
3. **Walk tree** — follow `parentUuid` chain from leaf to root (`Vs6` equivalent)
4. **Post-process** — merge split assistant messages, fix orphan tool results (`OHY` equivalent)
5. **Normalize messages** — filter progress/system, convert types, merge adjacent, attachment conversion, 4 post-transforms (`HX` equivalent)
6. **Fix orphaned tool_use** — insert synthetic `tool_result` for interrupted tool calls
7. **Apply content replacements** — resolve persisted outputs from session metadata and disk
8. **Microcompact** — truncate old tool results for time-gapped sessions
9. **Inject context** — CLAUDE.md + date as `<system-reminder>` (`aR8` equivalent)
10. **System prompt** — base identity + agent notes + environment info (`dQ6`/`Sr9` equivalent)
11. **Convert to API format** — strip to `{role, content}` (`ejY`/`AJY` equivalent)
12. **Query** — call Anthropic API with `duncan_response` structured output tool

## Parity status

Tested against 13 real CC sessions + 193 subagent transcripts + synthetic test sessions.

| Feature | Status | Notes |
|---------|--------|-------|
| JSONL parsing | ✅ | All entry types handled |
| Tree walk (parentUuid chain) | ✅ | Cycle detection, leaf finding |
| Preserved segment relinking | ✅ | Synthetic tests pass |
| Compaction windowing | ✅ | Multi-boundary, model-per-window |
| Message normalization | ✅ | Filter, merge, type conversion, 4 post-transforms |
| Split assistant merging | ✅ | Same `message.id` detection |
| Orphaned tool_use fix | ✅ | Synthetic tool_result insertion |
| Attachment conversion | ✅ | file, directory, plan, skill, compact_file_reference |
| Content replacements | ✅ | Metadata entries + persisted output files |
| Microcompact | ✅ | Time-gap detection, recent turn preservation |
| System prompt | ✅ | Base + notes + env + CLAUDE.md |
| userContext injection | ✅ | CLAUDE.md + date |
| OAuth auth | ✅ | CC + pi OAuth, beta headers, identity prefix |
| Subagent processing | ✅ | Discovery + full pipeline |
| API format conversion | ✅ | role + content only |
| MCP server | ✅ | stdio transport, list + query tools |

### Known gaps

- **Large file optimization**: CC skips pre-boundary content for files >5MB. Duncan reads the full file.
- **Persisted output hash naming**: One of CC's tool-result file naming schemes uses hashes not tool IDs. Partial resolution.
- **`OHY` orphan tool result reattachment**: Simplified — handles the common cases but may miss edge cases with complex branching.
- **Real compacted sessions**: Synthetic tests pass, but no real CC sessions with compaction boundaries in test corpus.

## Tests

```bash
npm test
```

5500+ assertions across 8 test files covering parsing, tree walk, normalization, compaction, content replacements, system prompt, pipeline integration, session discovery, and parity.

## Related

- [pi-duncan](https://github.com/gswangg/pi-duncan) — duncan for the [pi](https://github.com/badlogic/pi-mono) coding agent
- [The Duncan Idaho Approach to Agent Memory](https://gswangg.net/posts/duncan-idaho-agent-memory) — design writeup
