export const HEADLESS_BATCH_SIZE_WARNING = "Warning: in headless mode, memory scales roughly with batchSize; on a 4 GB test machine, 5 concurrent Claude subprocesses used about 1.45 GB RSS and 10 used about 2.73 GB RSS.";

export function buildDuncanQueryToolDescription(): string {
  return [
    "Query dormant Claude Code sessions to recall information from previous conversations.",
    "Loads session context and asks the target session's model whether it has relevant information.",
    "Use when you need to find something discussed in a previous CC session.",
    "Default backend on this branch is the headless real-Claude path.",
    "Warning: larger batchSize values materially increase memory use for the headless real-Claude backend.",
  ].join(" ");
}

export function buildBackendDescription(): string {
  return "Execution backend. Default is 'headless', which stages the transcript and runs real Claude Code via --print --resume. 'api' remains available only as a temporary fallback on this branch.";
}

export function buildBatchSizeDescription(): string {
  return `Max concurrent queries per batch (default: 5). ${HEADLESS_BATCH_SIZE_WARNING}`;
}
