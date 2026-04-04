import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseJsonl } from "../parser.js";
import { runClaudeHeadless, type HeadlessRunRequest, type HeadlessRunResult } from "./claude-runner.js";
import { deriveSessionWindowsFromEntries, type SessionWindowBoundary } from "./session-boundaries.js";
import { resolveHeadlessExecutionCwd, resolveHeadlessSourceContext } from "./source-context.js";
import { StagedSessionManager } from "./staged-session-manager.js";

export type QueryBackend = "api" | "headless";

export interface HeadlessQueryResult {
  hasContext: boolean;
  answer: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  latencyMs?: number;
}

export interface HeadlessQueryOptions {
  model?: string;
  cliPath?: string;
  timeoutMs?: number;
  stageRootDir?: string;
  env?: NodeJS.ProcessEnv;
}

const defaultStageManager = new StagedSessionManager({
  stageRootDir: join(tmpdir(), "duncan-cc-headless-stage"),
});

export const DUNCAN_HEADLESS_JSON_SCHEMA = {
  type: "object",
  properties: {
    hasContext: { type: "boolean" },
    answer: { type: "string" },
  },
  required: ["hasContext", "answer"],
  additionalProperties: false,
} as const;

export function resolveQueryBackend(explicit?: string | null): QueryBackend {
  const value = explicit ?? process.env.DUNCAN_CC_QUERY_BACKEND ?? "headless";
  return value === "api" ? "api" : "headless";
}

export async function resolveHeadlessWindowBoundary(
  sessionFile: string,
  windowIndex: number,
): Promise<SessionWindowBoundary> {
  const content = await readFile(sessionFile, "utf8");
  const entries = parseJsonl(content);
  const windows = deriveSessionWindowsFromEntries(entries);
  const match = windows.find((window) => window.windowIndex === windowIndex);
  if (!match) {
    throw new Error(`Could not resolve raw session window ${windowIndex} for ${sessionFile}`);
  }
  return match;
}

export function buildHeadlessQuestionPrompt(question: string): string {
  return [
    "Answer solely based on the resumed conversation.",
    "If you do not explicitly have enough context from the conversation, set hasContext=false and say so briefly in answer.",
    question,
  ].join("\n\n");
}

export function parseHeadlessStructuredResult(run: HeadlessRunResult): HeadlessQueryResult {
  let parsed: any;
  try {
    parsed = JSON.parse(run.stdout);
  } catch (error) {
    throw new Error(`Failed to parse headless Claude JSON output: ${String(error)}`);
  }

  const structured = parsed?.structured_output;
  if (!structured || typeof structured !== "object") {
    throw new Error(`Headless Claude response did not include structured_output`);
  }
  if (typeof structured.hasContext !== "boolean" || typeof structured.answer !== "string") {
    throw new Error(`Headless Claude structured_output was malformed`);
  }

  return {
    hasContext: structured.hasContext,
    answer: structured.answer,
    usage: parsed?.usage,
    latencyMs: typeof run.durationMs === "number" ? run.durationMs : undefined,
  };
}

export async function querySingleWindowHeadless(
  sessionFile: string,
  windowIndex: number,
  question: string,
  opts: HeadlessQueryOptions = {},
): Promise<HeadlessQueryResult> {
  const window = await resolveHeadlessWindowBoundary(sessionFile, windowIndex);
  const sourceContext = await resolveHeadlessSourceContext(sessionFile);
  const stageManager = opts.stageRootDir
    ? new StagedSessionManager({ stageRootDir: opts.stageRootDir })
    : defaultStageManager;
  const staged = await stageManager.createStage({
    sourceSessionFile: sessionFile,
    sourceProjectDir: sourceContext.sourceProjectDir,
    sourceSessionId: sourceContext.sourceSessionId,
    window,
    copyToolResults: sourceContext.shouldCopyToolResults,
    copySubagents: sourceContext.shouldCopySubagents,
  });

  const extraArgs: string[] = [
    "--tools",
    "",
    "--effort",
    "low",
    "--json-schema",
    JSON.stringify(DUNCAN_HEADLESS_JSON_SCHEMA),
  ];
  if (opts.model) {
    extraArgs.unshift(opts.model);
    extraArgs.unshift("--model");
  }

  const runRequest: HeadlessRunRequest = {
    cwd: await resolveHeadlessExecutionCwd(sourceContext.originalCwd, staged.stage.stageProjectDir),
    resume: staged.stage.stagedSessionFile,
    prompt: buildHeadlessQuestionPrompt(question),
    outputFormat: "json",
    timeoutMs: opts.timeoutMs ?? 180000,
    cliPath: opts.cliPath,
    env: opts.env,
    extraArgs,
  };

  try {
    const run = await runClaudeHeadless(runRequest);
    if (!run.ok) {
      throw new Error(run.stderr || run.stdout || `Headless Claude run failed with exit code ${run.exitCode}`);
    }
    return parseHeadlessStructuredResult(run);
  } finally {
    await staged.cleanup();
  }
}
