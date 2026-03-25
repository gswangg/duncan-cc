# duncan-cc

Query dormant Claude Code sessions. The [Duncan Idaho approach](https://github.com/gswangg/duncan-writeup) to agent memory, for CC.

When CC sessions end or get compacted, their conversation history is still on disk. Duncan loads that history into a fresh LLM call and asks it your question — leveraging the model's native attention mechanism instead of summaries or search.

## Install

```bash
git clone https://github.com/gswangg/duncan-cc.git
cd duncan-cc
npm install
```

## Configure CC to use duncan

Add to your Claude Code MCP config (`~/.claude/claude_desktop_config.json` or equivalent):

```json
{
  "mcpServers": {
    "duncan": {
      "command": "npx",
      "args": ["tsx", "/path/to/duncan-cc/src/mcp-server.ts"],
      "env": {
        "ANTHROPIC_API_KEY": "your-key"
      }
    }
  }
}
```

Or run standalone:

```bash
ANTHROPIC_API_KEY=sk-... npx tsx src/mcp-server.ts
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
2. **Relink preserved segments** — handle compaction tree surgery
3. **Walk tree** — follow parentUuid chain from leaf to root
4. **Normalize messages** — filter progress/system, convert types, merge adjacent, post-transforms
5. **Apply content replacements** — resolve persisted outputs from disk
6. **Microcompact** — truncate old tool results for time-gapped sessions
7. **Inject context** — CLAUDE.md + date as system-reminder
8. **System prompt** — reconstruct CC's system prompt (base + agent notes + environment)
9. **Convert to API format** — strip to `{role, content}` only
10. **Query** — call Anthropic API with `duncan_response` structured output tool

Each session window is queried independently. Responses include `hasContext` (boolean) and `answer` (string). Only sessions with relevant context are returned.

## Session storage

CC stores sessions at `~/.claude/projects/<hashed-cwd>/<session-id>.jsonl`. Each session is a tree of messages linked by `uuid`/`parentUuid`. Compaction creates boundary markers that split the session into independently queryable windows.

## Tests

```bash
npm test
```

5000+ assertions against real CC session files covering parsing, tree walk, normalization, content replacements, system prompt, pipeline integration, and session discovery.

## Related

- [pi-duncan](https://github.com/gswangg/pi-duncan) — the original duncan implementation for the [pi](https://github.com/badlogic/pi-mono) coding agent
- [The Duncan Idaho Approach to Agent Memory](https://github.com/gswangg/duncan-writeup) — writeup explaining the design
