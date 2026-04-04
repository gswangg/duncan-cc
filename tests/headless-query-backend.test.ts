import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DUNCAN_HEADLESS_JSON_SCHEMA,
  buildHeadlessQuestionPrompt,
  parseHeadlessStructuredResult,
  resolveHeadlessWindowBoundary,
  resolveQueryBackend,
} from "../src/headless/query-backend.js";

assert.equal(resolveQueryBackend(undefined), "headless");
process.env.DUNCAN_CC_QUERY_BACKEND = "api";
assert.equal(resolveQueryBackend(undefined), "api");
delete process.env.DUNCAN_CC_QUERY_BACKEND;
assert.equal(resolveQueryBackend("headless"), "headless");
assert.equal(resolveQueryBackend("api"), "api");
assert.equal(resolveQueryBackend("weird"), "headless");

assert.match(buildHeadlessQuestionPrompt("where was the bug?"), /where was the bug\?/);
assert.deepEqual(DUNCAN_HEADLESS_JSON_SCHEMA.required, ["hasContext", "answer"]);

const parsed = parseHeadlessStructuredResult({
  ok: true,
  exitCode: 0,
  signal: null,
  stdout: JSON.stringify({
    structured_output: { hasContext: true, answer: "in src/foo.ts" },
    usage: { input_tokens: 1, output_tokens: 2 },
  }),
  stderr: "",
  durationMs: 123,
  command: "claude",
  args: [],
});
assert.deepEqual(parsed, {
  hasContext: true,
  answer: "in src/foo.ts",
  usage: { input_tokens: 1, output_tokens: 2 },
  latencyMs: 123,
});

assert.throws(() => parseHeadlessStructuredResult({
  ok: true,
  exitCode: 0,
  signal: null,
  stdout: JSON.stringify({ result: "missing structured output" }),
  stderr: "",
  durationMs: 5,
  command: "claude",
  args: [],
}), /structured_output/);

const root = await mkdtemp(join(tmpdir(), "duncan-cc-headless-query-backend-"));
const sourceSessionFile = join(root, "session.jsonl");
await writeFile(sourceSessionFile, [
  JSON.stringify({ type: "system", subtype: "compact_boundary", uuid: "b1", parentUuid: null, timestamp: new Date().toISOString(), sessionId: "session-src", message: { role: "system", content: "compact" } }),
  JSON.stringify({ type: "user", uuid: "u1", parentUuid: "b1", timestamp: new Date().toISOString(), sessionId: "session-src", message: { role: "user", content: "hi" } }),
].join("\n") + "\n", "utf8");

const boundary = await resolveHeadlessWindowBoundary(sourceSessionFile, 1);
assert.equal(boundary.windowIndex, 1);
assert.equal(boundary.kind, "compaction");
assert.equal(boundary.startEntryIndex, 0);
assert.equal(boundary.endEntryIndex, 2);

const persisted = await readFile(sourceSessionFile, "utf8");
assert.match(persisted, /compact_boundary/);

console.log("headless-query-backend.test.ts: ok");
