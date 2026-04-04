import { spawn } from "node:child_process";

export interface HeadlessRunRequest {
  prompt?: string;
  resume: string;
  cwd?: string;
  cliPath?: string;
  outputFormat?: "text" | "json" | "stream-json";
  extraArgs?: string[];
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  onSpawn?: (pid: number) => void;
}

export interface HeadlessRunResult {
  ok: boolean;
  pid?: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  command: string;
  args: string[];
}

export function buildClaudePrintArgs(request: HeadlessRunRequest): string[] {
  const args = [
    "--print",
    "--resume",
    request.resume,
    "--output-format",
    request.outputFormat ?? "json",
    ...(request.extraArgs ?? []),
  ];
  if (request.prompt) {
    args.push(request.prompt);
  }
  return args;
}

export async function runClaudeHeadless(request: HeadlessRunRequest): Promise<HeadlessRunResult> {
  const command = request.cliPath ?? "claude";
  const args = buildClaudePrintArgs(request);
  const start = Date.now();

  return await new Promise<HeadlessRunResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: request.cwd,
      env: { ...process.env, ...(request.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (child.pid) {
      request.onSpawn?.(child.pid);
    }

    let stdout = "";
    let stderr = "";
    let finished = false;
    let timeout: NodeJS.Timeout | undefined;

    const finish = (result: HeadlessRunResult) => {
      if (finished) return;
      finished = true;
      if (timeout) clearTimeout(timeout);
      resolve(result);
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (timeout) clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (exitCode, signal) => {
      finish({
        ok: exitCode === 0,
        pid: child.pid,
        exitCode,
        signal,
        stdout,
        stderr,
        durationMs: Date.now() - start,
        command,
        args,
      });
    });

    if (request.timeoutMs && request.timeoutMs > 0) {
      timeout = setTimeout(() => {
        child.kill("SIGTERM");
      }, request.timeoutMs);
    }
  });
}
