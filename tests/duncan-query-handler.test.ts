import assert from "node:assert/strict";

import { createDuncanHandlers, getToolDefinitions } from "../src/mcp-server.js";

const usage = { inputTokens: 10, outputTokens: 2, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };

const calls: Array<{ kind: string; backend?: string; batchSize?: number }> = [];
const handlers = createDuncanHandlers({
  findCallingSession: () => ({ cwd: "/tmp/project", sessionId: "session-current" } as any),
  querySelf: async (_question, opts) => {
    calls.push({ kind: "self", backend: opts.backend as string | undefined, batchSize: opts.batchSize });
    return {
      queryId: "q-self",
      question: "where?",
      results: [
        { queryId: "q-self", sessionFile: "/tmp/s.jsonl", sessionId: "session-current", windowIndex: 1, windowType: "main", model: "sonnet", result: { hasContext: true, answer: "self answer" } },
      ],
      totalWindows: 1,
      hasMore: false,
      offset: 0,
      usage,
    };
  },
  queryAncestors: async (_question, opts) => {
    calls.push({ kind: "ancestors", backend: opts.backend as string | undefined, batchSize: opts.batchSize });
    return {
      queryId: "q-anc",
      question: "where?",
      results: [
        { queryId: "q-anc", sessionFile: "/tmp/a.jsonl", sessionId: "session-current", windowIndex: 0, windowType: "compaction", model: "sonnet", result: { hasContext: true, answer: "ancestor answer" } },
      ],
      totalWindows: 1,
      hasMore: false,
      offset: 0,
      usage,
    };
  },
  querySubagents: async (_question, opts) => {
    calls.push({ kind: "subagents", backend: opts.backend as string | undefined, batchSize: opts.batchSize });
    return {
      queryId: "q-sub",
      question: "where?",
      results: [
        { queryId: "q-sub", sessionFile: "/tmp/sub.jsonl", sessionId: "agent-1", windowIndex: 0, windowType: "subagent", model: "sonnet", result: { hasContext: false, answer: "subagent answer" } },
      ],
      totalWindows: 1,
      hasMore: false,
      offset: 0,
      usage,
    };
  },
  queryBatch: async (_question, _routing, opts) => {
    calls.push({ kind: "batch", backend: opts.backend as string | undefined, batchSize: opts.batchSize });
    return {
      queryId: "q-batch",
      question: "where?",
      results: [
        { queryId: "q-batch", sessionFile: "/tmp/p.jsonl", sessionId: "project-session", windowIndex: 0, windowType: "main", model: "sonnet", result: { hasContext: true, answer: "project answer" } },
      ],
      totalWindows: 1,
      hasMore: false,
      offset: 0,
      usage,
    };
  },
});

const selfResult = await handlers.handleDuncanQuery({ question: "where?", mode: "self", backend: "headless", batchSize: 5 });
assert.equal(selfResult.isError, undefined);
assert.match(String(selfResult.content[0]?.text), /self answer/);
assert.match(String(selfResult.content[0]?.text), /1\/1 had relevant context/);

const ancestorsResult = await handlers.handleDuncanQuery({ question: "where?", mode: "ancestors", backend: "headless", batchSize: 5 });
assert.match(String(ancestorsResult.content[0]?.text), /ancestor answer/);
assert.match(String(ancestorsResult.content[0]?.text), /1\/1 windows had relevant context/);

const subagentsResult = await handlers.handleDuncanQuery({ question: "where?", mode: "subagents", backend: "headless", batchSize: 5 });
assert.match(String(subagentsResult.content[0]?.text), /subagent answer/);
assert.match(String(subagentsResult.content[0]?.text), /0\/1 subagent windows had relevant context/);

const projectResult = await handlers.handleDuncanQuery({ question: "where?", mode: "project", backend: "headless", batchSize: 5, projectDir: "/tmp/project" });
assert.match(String(projectResult.content[0]?.text), /project answer/);
assert.match(String(projectResult.content[0]?.text), /sessions had relevant context/);

assert.deepEqual(calls, [
  { kind: "self", backend: "headless", batchSize: 5 },
  { kind: "ancestors", backend: "headless", batchSize: 5 },
  { kind: "subagents", backend: "headless", batchSize: 5 },
  { kind: "batch", backend: "headless", batchSize: 5 },
]);

const tool = getToolDefinitions().find((entry) => entry.name === "duncan_query");
assert.ok(tool);
assert.match(String(tool?.description), /headless/);
assert.match(String((tool as any).inputSchema.properties.batchSize.description), /1\.45 GB RSS/);
assert.match(String((tool as any).inputSchema.properties.backend.description), /temporary fallback/);

console.log("duncan-query-handler.test.ts: ok");
