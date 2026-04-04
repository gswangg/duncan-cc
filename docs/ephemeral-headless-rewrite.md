# Ephemeral Headless Rewrite — Research + Architecture

branch: `duncan-cc-ephemeral-headless`

## Goal

Replace the current reverse-engineered dormant-session query path with an
**ephemeral headless Claude Code** execution path that stages session files on
disk, resumes them via the public CLI, and asks Duncan questions through the
real Claude Code runtime.

This rewrite is motivated by the likelihood that the OAuth path currently used
by `duncan-cc` will become unavailable or too brittle to rely on.

---

## Source Research Findings

### 1. Claude Code headless mode is the right execution surface

Relevant source:
- `claude-code-source/src/main.tsx`
- `claude-code-source/src/cli/print.ts`

Findings:
- Claude Code has a supported non-interactive mode via `-p` / `--print`.
- `--print` supports `--resume <session-id>`.
- In print mode, resume also accepts a **`.jsonl` transcript path**.
- `--output-format` supports `text`, `json`, and `stream-json`.
- `--resume-session-at <message id>` exists, but it narrows the resumed
  message list after loading; it is not a substitute for staging/truncating raw
  transcript files at compaction boundaries.

Implication:
- The cleanest rewrite path is: **prepare a staged transcript file**, then run
  `claude --print --resume <staged.jsonl>` in an isolated workspace.

### 1b. `--bare` exists in current Claude Code and is potentially useful

Relevant source:
- installed `claude --help`
- `claude-code-source/src/main.tsx`
- `claude-code-source/src/entrypoints/cli.tsx`
- `claude-code-source/src/utils/auth.ts`
- `claude-code-source/src/context.ts`
- `claude-code-source/src/setup.ts`
- `claude-code-source/src/skills/loadSkillsDir.ts`
- `claude-code-source/src/cli/print.ts`

Findings:
- Current Claude Code exposes `--bare` publicly in `--help`.
- `--bare` sets `CLAUDE_CODE_SIMPLE=1` very early.
- It skips a lot of ambient behavior:
  - hooks
  - LSP
  - plugin sync / marketplace auto-load
  - auto-memory
  - background prefetches
  - keychain / OAuth discovery
  - CLAUDE.md auto-discovery
  - most auto-discovered MCP config
- It still allows **explicit** context/config surfaces, including:
  - `--system-prompt`
  - `--append-system-prompt`
  - `--add-dir`
  - `--mcp-config`
  - `--settings`
  - `--agents`
  - `--plugin-dir`
- Anthropic auth under `--bare` is API-key-oriented / hermetic rather than OAuth-driven.

Assessment:
- `--bare` is **not a viable production path** for this rewrite if we want to rely on Claude Code's normal OAuth-backed auth flow.
- Source/help text explicitly say `--bare` disables OAuth/keychain auth and switches Anthropic auth to API-key/helper-only behavior.
- That makes it a mismatch for the rewrite goal: use real headless Claude Code with its normal auth/session machinery instead of replacing it with another custom auth path.
- Keep `--bare` only as a possible lab/debug curiosity if we ever want a hermetic API-key benchmark, but it should be treated as **out of scope for the actual rewrite path**.

### 2. Cross-directory resume from a raw JSONL path is explicitly supported

Relevant source:
- `claude-code-source/src/utils/conversationRecovery.ts`
- `claude-code-source/src/cli/print.ts`

Findings:
- `loadConversationForResume(source, sourceJsonlFile)` accepts a raw `.jsonl`
  path.
- Print mode routes `.jsonl` resume identifiers through that path.
- This is described as the cross-directory resume path.

Implication:
- We do **not** need private bridge/session APIs to load dormant sessions.
- The staged file can live in a temp directory; Claude Code will still load it.

### 3. Session storage layout matters

Relevant source:
- `claude-code-source/src/utils/sessionStorage.ts`
- `claude-code-source/src/utils/toolResultStorage.ts`
- `claude-code-source/src/tools/AgentTool/runAgent.ts`

Findings:
- Main transcript path: `~/.claude/projects/<project-slug>/<session-id>.jsonl`
- Session-specific artifacts live beside that transcript:
  - `<project-dir>/<session-id>/tool-results/...`
  - `<project-dir>/<session-id>/subagents/...`
- Subagent transcripts are separate JSONL files under `subagents/`.
- Content replacement / persisted tool output reconstruction depends on nearby
  per-session artifact paths.

Implication:
- Staging should copy **more than one JSONL file** when needed.
- The minimal viable stager must understand:
  - main session JSONL
  - session-sidecar directories (`tool-results`, possibly `subagents`)
  - project-level files that influence prompt behavior (`CLAUDE.md`, memory)

### 4. Compaction boundaries are real transcript boundaries, not just logical markers

Relevant source:
- `claude-code-source/src/utils/sessionStorage.ts`
- `claude-code-source/src/services/compact/compact.ts`
- `claude-code-source/src/utils/messages.ts`
- `duncan-cc/src/tree.ts`

Findings:
- `compact_boundary` is a system message subtype.
- Compaction resets / breaks parts of the parent chain around boundaries.
- Duncan already reconstructs compaction windows with `buildRawChain()` and
  `getCompactionWindows()`.
- The existing Duncan pipeline works on **normalized logical windows**, but the
  headless rewrite needs **raw-file-compatible staged transcripts**.

Implication:
- We need a staging layer that operates at **raw transcript-entry granularity**.
- For compatibility, staged sessions should be created by:
  1. copying the original session transcript,
  2. truncating it at exact session-window boundaries,
  3. renaming/writing it into a new session-shaped location.

### 5. Branch/fork code shows Claude Code already tolerates transcript copying

Relevant source:
- `claude-code-source/src/commands/branch/branch.ts`

Findings:
- Claude Code already creates forked sessions by copying transcript entries to a
  new file.
- It preserves lots of original metadata and rewrites session-level identity.
- It also carries content-replacement records forward.

Implication:
- File-based transcript staging is not alien to Claude Code’s own model.
- We can borrow that mental model, even if our staging rules differ.

### 6. Fanout overhead will come mostly from process startup + file staging

Relevant source:
- `duncan-cc/src/query.ts`
- `claude-code-source/src/bridge/sessionRunner.ts`
- `claude-code-source/src/cli/print.ts`

Findings:
- Current Duncan fanout is API-call concurrency (`batchSize`).
- The headless rewrite will replace one API client call with one subprocess.
- Claude’s own bridge session runner uses `--print`, `stream-json`, and a
  session-oriented child process model.

Implication:
- The main resource costs to benchmark are:
  - temp dir creation
  - transcript copy/truncation size
  - process spawn latency
  - peak concurrent process count
  - aggregate wall clock at 20-way fanout

---

## Rewrite Shape

### High-level execution model

```text
Resolve target dormant session/window
  ↓
Stage an isolated ephemeral workspace
  ↓
Copy transcript + required sidecars
  ↓
Truncate transcript at chosen boundary/window
  ↓
Rename/write staged transcript into Claude-compatible layout
  ↓
Spawn `claude --print --resume <staged.jsonl>`
  ↓
Ask Duncan question through stdin/args
  ↓
Collect output + usage + diagnostics
  ↓
Destroy staged workspace
```

---

## Proposed Modules

### 1. `src/headless/session-stager.ts`

Responsibilities:
- create ephemeral stage dir
- materialize Claude-compatible project/session layout
- copy transcript + required sidecars
- truncate transcript to the requested boundary/window
- preserve raw JSONL entries by default
- optionally rewrite session ids only when explicitly requested
- return staged paths + staging stats

Core types:
- `StageRequest`
- `StageResult`
- `StagedSessionLayout`
- `StageStats`

### 2. `src/headless/session-boundaries.ts`

Responsibilities:
- map a dormant session into raw staging windows
- identify safe truncate points
- reject invalid cuts (e.g. mid-turn / malformed boundaries)

Core types:
- `SessionBoundary`
- `BoundaryKind = "full" | "compaction-window" | "subagent"`
- `BoundaryResolution`

### 3. `src/headless/claude-runner.ts`

Responsibilities:
- spawn headless Claude Code subprocesses
- standardize command-line args
- collect stdout/stderr/exit status/duration
- expose cancellation / timeout support

Core types:
- `HeadlessRunRequest`
- `HeadlessRunResult`
- `HeadlessRunner`

### 4. `src/headless/fanout.ts`

Responsibilities:
- schedule many staged headless runs
- control concurrency
- collect resource/latency stats
- report fanout overhead

Core types:
- `FanoutPlan`
- `FanoutResult`
- `FanoutMetrics`

### 5. `src/headless/resource-meter.ts`

Responsibilities:
- capture lightweight benchmark/resource metrics for fanout tests
- count bytes copied, temp dirs created, subprocess count, peak concurrency,
  staging duration, run duration

---

## Three Spikes to Prove

### Spike 1 — staged-session correctness

Question:
- Can we stage a dormant session into an isolated directory and produce the
  exact file/layout shape our headless runner expects?

Tests should prove:
- stage dir is created deterministically
- transcript is copied and renamed correctly
- session-specific sidecars are copied into the right relative paths
- staged session metadata points at the new stage, not the original path
- raw transcript content is preserved by default
- optional session-id rewriting is available when explicitly requested
- no accidental mutation of the source transcript

### Spike 2 — compaction-boundary compatibility

Question:
- Can we truncate at session/compaction boundaries in a way that remains
  compatible with Claude Code’s resume expectations?

Tests should prove:
- no-boundary sessions stage as a single full transcript
- compacted sessions can be split into stageable windows
- truncation occurs only at safe entry boundaries
- invalid mid-window truncation is rejected
- staged transcripts preserve exact raw JSONL entries up to the cut

### Spike 3 — 20-way fanout overhead

Question:
- Is 20-way ephemeral headless fanout operationally acceptable?

Tests/benchmarks should measure:
- bytes copied per stage
- total temp storage written
- spawn count
- peak concurrent subprocesses
- wall clock at configurable concurrency
- average/median staging latency
- average/median subprocess latency

This spike does **not** need real Claude model calls in CI. A fake runner is
acceptable for deterministic resource tests, as long as the real runner contract
is the same.

---

## Test Strategy

### Unit / contract tests

1. `tests/headless-stager.test.ts`
   - stage layout correctness
   - copy isolation
   - path rewriting behavior

2. `tests/headless-boundaries.test.ts`
   - raw boundary extraction
   - safe truncation
   - invalid boundary rejection

3. `tests/headless-fanout.test.ts`
   - fake 20-way fanout
   - peak concurrency accounting
   - aggregate bytes / temp dirs / wall clock metrics

### Optional manual / integration spike

4. `tests/headless-runner.integration.ts` (guarded / opt-in)
   - only runs if a local `claude` binary is available
   - stages a tiny fixture session
   - invokes `claude --print --resume <jsonl>`
   - asserts process success and machine-readable output shape

---

## Granular Implementation Plan

### Phase A — research + contracts
1. document Claude source findings and staging assumptions
2. define `StageRequest`, `StageResult`, `HeadlessRunRequest`, `FanoutMetrics`
3. add failing tests for the three spikes

### Phase B — staging layer
4. implement ephemeral workspace creation
5. implement transcript copy + rename
6. implement sidecar copy logic (`tool-results`, optional subagents)
7. implement raw truncate-by-boundary helper
8. make spike-1 + spike-2 tests pass

### Phase C — headless runner
9. implement subprocess wrapper for `claude --print --resume <jsonl>`
10. standardize args/env/output capture
11. add opt-in integration test hooks

### Phase D — fanout harness
12. implement fake-runner-compatible fanout executor
13. add 20-way resource benchmark test
14. record per-stage + aggregate metrics
15. make spike-3 tests pass

### Phase E — query-path integration
16. add a parallel query mode that uses the new staged headless path
17. keep the existing pipeline path intact during migration
18. add toggle/config for choosing the execution backend

### Phase F — migration
19. compare answer quality / latency / token behavior
20. decide whether to fully replace the reverse-engineered path
21. remove obsolete auth/protocol code only after confidence is high

---

## Open Questions

1. **What exact sidecars are mandatory for useful staged resume?**
   - likely `tool-results/`
   - possibly subagent files for some query modes

2. **Do we need project-level memory/CLAUDE.md copied, symlinked, or merely
   executed with cwd pointing at the original project?**

3. **Should fanout stage by copying or by hardlinking where possible?**
   - hardlinks reduce copy cost but complicate mutation safety guarantees

4. **Should each staged run get a fresh synthetic session id, or can we safely
   resume directly from a staged `.jsonl` path without rewriting IDs?**

5. **Do we want the headless backend to coexist with the old API backend during
   rollout, or replace it immediately on this branch?**

---

## Current Spike Findings

Status after the first pass:
- spike 1 — **passing**
- spike 2 — **passing**
- spike 3 — **passing**

Concrete findings:
- staging should preserve raw JSONL entries by default; forced transcript mutation created avoidable compatibility risk
- unique ephemeral isolation can come from the staged directory/layout rather than rewriting every session id inside the transcript
- explicit session-id rewriting is still useful as an opt-in escape hatch for experiments
- compaction-window staging works best as exact raw-entry slicing from `compact_boundary` to the next boundary/end
- a simple 20-target fanout harness is operationally cheap enough to keep iterating locally, with concurrency caps enforced in-process
- a minimal `claude --print --resume <jsonl>` runner wrapper is straightforward; the remaining uncertainty is not invocation shape but fidelity of staged filesystem context

Latest validation on this branch:
- full `npm test` suite: **passing**
- headless spike tests: **passing**

## Current Recommendation

Do **not** jump straight to a full rewrite.

First prove, in order:
1. staged-session correctness
2. compaction-boundary truncation correctness
3. 20-way fanout overhead

Then wire the real headless runner behind those contracts.
