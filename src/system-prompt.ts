/**
 * System Prompt + Context Reconstruction
 * 
 * Replicates CC's system prompt assembly:
 * - Base prompt (sH8/kP1)
 * - Agent notes (dQ6)
 * - Environment info (Sr9)
 * - CLAUDE.md loading (bO/FE1)
 * - userContext injection (aR8) — CLAUDE.md + currentDate
 * - systemContext injection (cYq) — git status
 */

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve, parse as parsePath } from "node:path";
import { platform, release } from "node:os";
import type { CCMessage } from "./parser.js";

// ============================================================================
// Base system prompt — CC's sH8() / kP1
// ============================================================================

const BASE_PROMPT = "You are Claude Code, Anthropic's official CLI for Claude.";

// ============================================================================
// Agent notes — CC's dQ6() additions
// ============================================================================

const AGENT_NOTES = `Notes:
- Agent threads always have their cwd reset between bash calls, as a result please only use absolute file paths.
- In your final response, share file paths (always absolute, never relative) that are relevant to the task. Include code snippets only when the exact text is load-bearing (e.g., a bug you found, a function signature the caller asked for) — do not recap code you merely read.
- For clear communication with the user the assistant MUST avoid using emojis.
- Do not use a colon before tool calls. Text like "Let me read the file:" followed by a read tool call should just be "Let me read the file." with a period.`;

// ============================================================================
// Environment info — CC's Sr9()
// ============================================================================

export interface EnvironmentInfo {
  cwd: string;
  isGitRepo?: boolean;
  additionalDirs?: string[];
  modelName?: string;
  modelId?: string;
  knowledgeCutoff?: string;
}

function buildEnvironmentBlock(env: EnvironmentInfo): string {
  const isGit = env.isGitRepo ?? checkIsGitRepo(env.cwd);
  const additionalDirs = env.additionalDirs?.length
    ? `Additional working directories: ${env.additionalDirs.join(", ")}\n`
    : "";

  const modelLine = env.modelName
    ? `You are powered by the model named ${env.modelName}. The exact model ID is ${env.modelId ?? env.modelName}.`
    : env.modelId
      ? `You are powered by the model ${env.modelId}.`
      : "";

  const cutoff = env.knowledgeCutoff
    ? `\nAssistant knowledge cutoff is ${env.knowledgeCutoff}.`
    : "";

  return `Here is useful information about the environment you are running in:
<env>
Working directory: ${env.cwd}
Is directory a git repo: ${isGit ? "Yes" : "No"}
${additionalDirs}Platform: ${platform()}
OS Version: ${release()}
</env>
${modelLine}
${cutoff}
`;
}

function checkIsGitRepo(cwd: string): boolean {
  try {
    let dir = cwd;
    while (true) {
      if (existsSync(join(dir, ".git"))) return true;
      const parent = dirname(dir);
      if (parent === dir) return false;
      dir = parent;
    }
  } catch {
    return false;
  }
}

// ============================================================================
// CLAUDE.md loading — CC's bO() / FE1()
// ============================================================================

interface ClaudeMdSource {
  type: "Project" | "User" | "Local" | "Managed" | "AutoMem" | "TeamMem";
  path: string;
  content: string;
}

const CLAUDE_MD_HEADER = "Codebase and user instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.";

/**
 * Load CLAUDE.md files from all sources.
 * Replicates CC's bO() path resolution.
 */
function loadClaudeMdSources(cwd: string): ClaudeMdSource[] {
  const sources: ClaudeMdSource[] = [];
  const seen = new Set<string>();

  function tryLoad(path: string, type: ClaudeMdSource["type"]): void {
    const resolved = resolve(path);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    try {
      if (!existsSync(resolved)) return;
      const stat = statSync(resolved);
      if (!stat.isFile()) return;
      const content = readFileSync(resolved, "utf-8").trim();
      if (content) sources.push({ type, path: resolved, content });
    } catch {}
  }

  function tryLoadDir(dir: string, type: ClaudeMdSource["type"]): void {
    try {
      if (!existsSync(dir) || !statSync(dir).isDirectory()) return;
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && /\.(md|txt)$/i.test(entry.name)) {
          tryLoad(join(dir, entry.name), type);
        }
      }
    } catch {}
  }

  // User-level CLAUDE.md
  const homeDir = process.env.HOME || process.env.USERPROFILE || "";
  if (homeDir) {
    tryLoad(join(homeDir, ".claude", "CLAUDE.md"), "User");
    tryLoadDir(join(homeDir, ".claude", "rules"), "User");
  }

  // Project-level: walk from cwd up to root
  let dir = resolve(cwd);
  const root = parsePath(dir).root;
  const projectDirs: string[] = [];
  while (dir !== root) {
    projectDirs.push(dir);
    dir = dirname(dir);
  }

  for (const d of projectDirs.reverse()) {
    tryLoad(join(d, "CLAUDE.md"), "Project");
    tryLoad(join(d, ".claude", "CLAUDE.md"), "Project");
    tryLoadDir(join(d, ".claude", "rules"), "Project");
    tryLoad(join(d, "CLAUDE.local.md"), "Local");
  }

  // AutoMem (MEMORY.md) — look in ~/.claude/memory/ and project memory/
  if (homeDir) {
    tryLoad(join(homeDir, ".claude", "MEMORY.md"), "AutoMem");
  }

  return sources;
}

/**
 * Format CLAUDE.md sources into system prompt text — CC's FE1()
 */
function formatClaudeMd(sources: ClaudeMdSource[]): string {
  if (sources.length === 0) return "";

  const blocks = sources.map((s) => {
    const typeLabel =
      s.type === "Project" ? " (project instructions, checked into the codebase)" :
      s.type === "Local" ? " (user's private project instructions, not checked in)" :
      s.type === "User" ? " (user's private global instructions for all projects)" :
      s.type === "AutoMem" ? " (user's auto-memory, persists across conversations)" :
      s.type === "TeamMem" ? " (shared team memory, synced across the organization)" :
      "";

    if (s.type === "TeamMem") {
      return `Contents of ${s.path}${typeLabel}:\n\n<team-memory-content source="shared">\n${s.content}\n</team-memory-content>`;
    }

    return `Contents of ${s.path}${typeLabel}:\n\n${s.content}`;
  });

  return `${CLAUDE_MD_HEADER}\n\n${blocks.join("\n\n")}`;
}

// ============================================================================
// userContext — CC's Vz() → aR8()
// ============================================================================

/**
 * Build userContext and inject as <system-reminder> user message.
 * CC's aR8(messages, userContext).
 */
export function injectUserContext(
  messages: CCMessage[],
  cwd: string,
): CCMessage[] {
  const claudeMdSources = loadClaudeMdSources(cwd);
  const claudeMd = formatClaudeMd(claudeMdSources);

  const context: Record<string, string> = {};
  if (claudeMd) context["claudeMd"] = claudeMd;
  context["currentDate"] = `Today's date is ${new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}.`;

  if (Object.keys(context).length === 0) return messages;

  const contextText = Object.entries(context)
    .map(([key, value]) => `# ${key}\n${value}`)
    .join("\n\n");

  const reminderMsg: CCMessage = {
    type: "user",
    uuid: crypto.randomUUID(),
    parentUuid: null,
    timestamp: new Date().toISOString(),
    isMeta: true,
    message: {
      role: "user",
      content: `<system-reminder>\nAs you answer the user's questions, you can use the following context:\n${contextText}\n\n      IMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.\n</system-reminder>`,
    },
  };

  const toContentArray = (c: string | any[]): any[] =>
    typeof c === "string" ? [{ type: "text", text: c }] : c;

  // If first message is user, merge context into it to maintain alternation
  if (messages.length > 0 && messages[0].type === "user") {
    const first = messages[0];
    const contextContent = toContentArray(reminderMsg.message.content);
    const firstContent = toContentArray(first.message.content);
    return [
      {
        ...first,
        message: {
          ...first.message,
          content: [...contextContent, ...firstContent],
        },
      },
      ...messages.slice(1),
    ];
  }

  return [reminderMsg, ...messages];
}

// ============================================================================
// systemContext — CC's t2() → cYq()
// ============================================================================

/**
 * Get git status for the cwd (if it's a git repo).
 * CC's t2() / nE1().
 */
function getGitStatus(cwd: string): string | null {
  if (!checkIsGitRepo(cwd)) return null;
  try {
    const { execSync } = require("node:child_process");
    const status = execSync("git status --short 2>/dev/null", {
      cwd,
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
    return status || null;
  } catch {
    return null;
  }
}

// ============================================================================
// Full system prompt assembly
// ============================================================================

/**
 * Build the full system prompt for a duncan query against a CC session.
 * 
 * @param env - environment info (cwd, model, etc.)
 * @returns array of system prompt sections (joined with double newline)
 */
export function buildSystemPrompt(env: EnvironmentInfo): string[] {
  const sections: string[] = [];

  // Base
  sections.push(BASE_PROMPT);

  // Agent notes
  sections.push(AGENT_NOTES);

  // Environment
  sections.push(buildEnvironmentBlock(env));

  // Git status as systemContext
  const gitStatus = getGitStatus(env.cwd);
  if (gitStatus) {
    sections.push(`gitStatus: ${gitStatus}`);
  }

  return sections.filter(Boolean);
}

/**
 * Build system prompt as a single string.
 */
export function buildSystemPromptString(env: EnvironmentInfo): string {
  return buildSystemPrompt(env).join("\n\n");
}
