# Duncan for Claude Code — Source Mapping & Spec

## CC Session Internals (v2.1.81)

### Session Storage

CC stores sessions as `.jsonl` files under `~/.claude/projects/<hashed-cwd>/<session-id>.jsonl`.

- **Projects dir**: `~/.claude/projects/` (`lx()`)
- **Project dir**: `~/.claude/projects/<hashed-cwd>/` — `IO(cwd)` = `join(projectsDir, hashCwd(cwd))`
- **Session file**: `<project-dir>/<session-id>.jsonl` — `WY()` / `Gv(sessionId)`
- **Subagent transcripts**: `<project-dir>/<session-id>/subagents/agent-<agent-id>.jsonl`

### JSONL Entry Types

Each line is a JSON object. The `isTranscriptMessage` check (`mi()`) accepts:
```
type: "user" | "assistant" | "attachment" | "system" | "progress"
```

Non-transcript entries (metadata):
```
type: "summary"        — compaction summary, keyed by leafUuid
type: "custom-title"   — session title, keyed by sessionId
type: "tag"            — session tag
type: "agent-name"     — agent name
type: "agent-color"    — agent color  
type: "agent-setting"  — agent setting
type: "mode"           — session mode
type: "worktree-state" — worktree info
type: "pr-link"        — PR link
type: "file-history-snapshot"
type: "attribution-snapshot"
type: "content-replacement"
type: "marble-origami-commit"    — context collapse commit
type: "marble-origami-snapshot"  — context collapse snapshot
```

### Message Structure

Each transcript message has:
```typescript
{
  uuid: string;           // unique ID
  parentUuid: string | null;  // parent in tree (like pi's parentId)
  session_id: string;     // session ID
  type: "user" | "assistant" | "system" | "progress" | "attachment";
  message: {
    role: string;
    content: ContentBlock[];
    model?: string;       // model ID on assistant messages
    usage?: Usage;        // token usage on assistant messages
    id?: string;          // API response ID on assistant messages
  };
  timestamp: string;
  isSidechain?: boolean;
  parent_tool_use_id?: string | null;
  gitBranch?: string;
  teamName?: string;
}
```

### Tree Structure — Same as Pi

CC uses the same `uuid`/`parentUuid` tree structure as pi's `id`/`parentId`. Session loading walks from leaf to root:

```javascript
// Vs6(messagesMap, leafMessage) — equivalent to pi's buildSessionContext
function Vs6(A, q) {
  let K = [], _ = new Set, Y = q;
  while (Y) {
    if (_.has(Y.uuid)) break;  // cycle detection
    _.add(Y.uuid);
    K.push(Y);
    Y = Y.parentUuid ? A.get(Y.parentUuid) : void 0;
  }
  return K.reverse(), OHY(A, K, _);  // OHY = post-process (relink compacted segments)
}
```

### Compaction — "Compact Boundary" System

CC's compaction is called "compact" internally. Key structures:

**Boundary marker**: a `system` message with `subtype: "compact_boundary"`. This is the equivalent of pi's compaction entry:
```javascript
function of(A) {
  return A?.type === "system" && A.subtype === "compact_boundary";
}
```

**Compaction result**:
```typescript
{
  boundaryMarker: Message;          // the compact_boundary system message
  summaryMessages: Message[];       // the summary (equivalent to pi's compaction summary)
  messagesToKeep?: Message[];       // kept messages (equivalent to pi's firstKeptEntryId onward)
  attachments: Message[];           // attachments to preserve
  hookResults: Message[];           // hook results to preserve
  userDisplayMessage?: string;      // optional display text
  preCompactTokenCount: number;
  postCompactTokenCount: number;
  compactionUsage?: Usage;
}
```

**Rebuilding context after compaction**: `yl()` function:
```javascript
function yl(A) {
  return [A.boundaryMarker, ...A.summaryMessages, ...A.messagesToKeep ?? [], ...A.attachments, ...A.hookResults];
}
```

**Preserved segment relinking**: When compaction keeps messages (`messagesToKeep`), the boundary marker stores `compactMetadata.preservedSegment` with `headUuid`, `tailUuid`, and `anchorUuid`. The `wHY()` function relinks the tree so the preserved segment is spliced into the right position relative to the boundary.

### Session Loading Pipeline

1. **Parse JSONL**: `mu(buffer)` — splits by newlines, JSON.parse each line
2. **Load transcript file**: `G26(path)` — reads file, handles pre-compact skipping for large files, separates transcript messages from metadata, handles preserved segment relinking via `wHY()`
3. **Find leaf**: Find the latest `user`/`assistant` message not referenced as a `parentUuid` by any other message (leaf detection)
4. **Walk tree**: `Vs6(messagesMap, leaf)` — walk `parentUuid` chain from leaf to root, reverse, post-process (relink compacted segments)
5. **Strip internal fields**: `Yt1(messages)` — removes `isSidechain`, `parentUuid` before sending to API
6. **API call**: Messages go to `client.beta.messages.create()` with `role`/`content` from each message

### Key Differences from Pi

| Aspect | Pi | Claude Code |
|--------|-----|-------------|
| Entry types | `session`, `message`, `compaction`, `model_change`, `branch_summary`, `label`, `custom`, `thinking_level_change` | `user`, `assistant`, `system`, `progress`, `attachment` + metadata types (`summary`, `custom-title`, etc.) |
| ID fields | `id` / `parentId` | `uuid` / `parentUuid` |
| Compaction marker | `type: "compaction"` entry with `summary`, `firstKeptEntryId` | `type: "system"` with `subtype: "compact_boundary"` + `compactMetadata.preservedSegment` |
| Summary storage | Inline in compaction entry (`summary` field) | Separate `type: "summary"` entries keyed by `leafUuid` |
| Message→LLM | `buildSessionContext()` → `convertToLlm()` → `streamSimple()` | `Vs6()` (tree walk) → `Yt1()` (strip fields) → `messages.create()` |
| Session dir | `~/.pi/agent/sessions/<hashed-cwd>/` | `~/.claude/projects/<hashed-cwd>/` |
| File naming | `<timestamp>_<uuid>.jsonl` | `<session-id>.jsonl` |
| Parent session link | `parentSession` field in session header | `parent_session_id` in telemetry (not in session file header) |
| Model tracking | `model_change` entries + assistant message `provider`/`model` fields | Assistant message `model` field |

## Duncan CC Implementation Plan

### Phase 1: Session Parsing

Implement CC session parsing that mirrors the pi implementation:

1. **Parse JSONL**: Read `.jsonl` file, JSON.parse each line (same as pi's `parseSessionEntries`)
2. **Filter transcript messages**: Keep only entries where `isTranscriptMessage(entry)` returns true
3. **Build message map**: Map `uuid` → message
4. **Find leaf**: Latest message not referenced as `parentUuid` by any other

### Phase 2: Compaction Windows

Adapt `getCompactionWindows()` for CC's compact boundary system:

1. Walk `parentUuid` chain from leaf to root (same tree walk as pi)
2. Find all `compact_boundary` entries on the path
3. Split into windows:
   - Window 0: messages before first boundary
   - Window N: boundary + summary (from `type: "summary"` entries) + kept messages + new messages until next boundary
4. Extract model info from assistant messages in each window

**Key difference**: CC stores summaries as separate `type: "summary"` entries keyed by `leafUuid`, not inline in the compaction entry. Need to resolve summaries by matching `leafUuid` to the boundary marker's uuid.

### Phase 3: Query Dispatch

Same as pi duncan:
1. For each target window, rebuild the message list
2. Strip `parentUuid`, `isSidechain` (like CC's `Yt1()`)
3. Append the duncan question as a user message
4. Call `messages.create()` with the `duncan_response` tool
5. Parse structured response

### Phase 4: Session Discovery

CC session files live in `~/.claude/projects/<hashed-cwd>/`. Need to:
1. Enumerate session files in the current project dir
2. Parse headers to find session relationships (CC doesn't have explicit `parentSession` in files — may need to use creation timestamps or content heuristics)
3. Support ancestors/descendants/project/global routing

**Note**: CC lacks pi's explicit parent-child session links in the file format. Lineage for CC will likely be based on:
- Temporal ordering (all sessions in same project dir, sorted by mtime)
- Fork metadata (if `--fork-session` was used)
- The `parent_session_id` field exists in telemetry but may not be reliably available in session files

### Phase 5: Integration

Options for shipping:
1. **Standalone CLI tool**: `duncan-cc` command that reads CC session files directly
2. **CC hook/extension**: If CC has a hook system (PostCompact hook exists per the schema)
3. **MCP server**: Expose duncan as an MCP tool that CC can call

The MCP server approach is likely the most practical since CC supports MCP natively.

## Open Questions

1. **Parent session tracking**: How reliably does CC track parent-child session relationships in the session files? `--fork-session` exists but does it record the parent in the transcript?
2. **Preserved segment relinking**: The `wHY()` function is complex. Do we need to replicate it for duncan, or can we work with the raw tree walk?
3. **Large file optimization**: CC skips pre-compact sections of large files (`Sr8` threshold). Should duncan do the same, or read everything?
4. **Subagent transcripts**: Should duncan also query subagent session files?
5. **Summary resolution**: The `type: "summary"` entries are keyed by `leafUuid` of the compacted branch. Need to confirm: is this the uuid of the boundary marker, or the uuid of the last message before compaction?
