import assert from "node:assert/strict";

import { buildClaudePrintArgs } from "../src/headless/claude-runner.js";

const defaultArgs = buildClaudePrintArgs({
  resume: "/tmp/session.jsonl",
  outputFormat: "json",
  prompt: "pong",
});
assert.deepEqual(defaultArgs, [
  "--print",
  "--resume",
  "/tmp/session.jsonl",
  "--no-session-persistence",
  "--output-format",
  "json",
  "pong",
]);

const optOutArgs = buildClaudePrintArgs({
  resume: "/tmp/session.jsonl",
  outputFormat: "json",
  noSessionPersistence: false,
});
assert.deepEqual(optOutArgs, [
  "--print",
  "--resume",
  "/tmp/session.jsonl",
  "--output-format",
  "json",
]);

console.log("claude-runner.test.ts: ok");
