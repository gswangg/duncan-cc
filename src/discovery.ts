/**
 * Session Discovery
 * 
 * Finds CC session files on disk, supports routing modes:
 * - project: all sessions in the same project dir (same cwd)
 * - global: all sessions across all projects
 * - specific: a named session file
 * 
 * Also discovers subagent transcripts.
 */

import { readdirSync, statSync, existsSync, openSync, readSync, closeSync, readFileSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";

// ============================================================================
// Path resolution — mirrors CC's path layout
// ============================================================================

/** Max length before hash suffix is appended. Matches CC's constant. */
const MAX_DIR_NAME_LENGTH = 200;

/**
 * Java's String.hashCode() — matches CC's A58() implementation.
 * Used as fallback when not running under Bun.
 */
function javaStringHashCode(s: string): number {
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) - hash + s.charCodeAt(i)) | 0;
  }
  return hash;
}

/**
 * Sanitize a path into a CC project directory name.
 * Matches CC's X2() / TJK() — replaces all non-alphanumeric chars with '-',
 * and appends a hash suffix (base36) for paths longer than 200 chars.
 */
export function cwdToProjectDirName(cwd: string): string {
  const sanitized = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  if (sanitized.length <= MAX_DIR_NAME_LENGTH) return sanitized;
  const hashSuffix = Math.abs(javaStringHashCode(cwd)).toString(36);
  return `${sanitized.slice(0, MAX_DIR_NAME_LENGTH)}-${hashSuffix}`;
}

/** Get CC's projects directory */
export function getProjectsDir(): string {
  return join(homedir(), ".claude", "projects");
}

/** Get project dir for a given cwd (hashed) */
export function getProjectDir(cwd: string): string | null {
  const projectsDir = getProjectsDir();
  if (!existsSync(projectsDir)) return null;

  const hashed = cwdToProjectDirName(cwd);
  const fullPath = join(projectsDir, hashed);
  if (existsSync(fullPath)) return fullPath;

  return null;
}

// ============================================================================
// Session file discovery
// ============================================================================

export interface SessionFileInfo {
  path: string;
  sessionId: string;
  mtime: Date;
  size: number;
  projectDir: string;
  /** For subagents: agent type from .meta.json (e.g., "Explore", "Plan") */
  agentType?: string | null;
}

/** List all session files in a project directory */
export function listSessionFiles(projectDir: string): SessionFileInfo[] {
  if (!existsSync(projectDir)) return [];

  try {
    const entries = readdirSync(projectDir, { withFileTypes: true });
    const sessions: SessionFileInfo[] = [];

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const fullPath = join(projectDir, entry.name);
      try {
        const stat = statSync(fullPath);
        sessions.push({
          path: fullPath,
          sessionId: entry.name.replace(".jsonl", ""),
          mtime: stat.mtime,
          size: stat.size,
          projectDir,
        });
      } catch {}
    }

    // Sort by mtime, newest first
    sessions.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
    return sessions;
  } catch {
    return [];
  }
}

/** List all session files across all projects */
export function listAllSessionFiles(): SessionFileInfo[] {
  const projectsDir = getProjectsDir();
  if (!existsSync(projectsDir)) return [];

  const allSessions: SessionFileInfo[] = [];

  try {
    const projectDirs = readdirSync(projectsDir, { withFileTypes: true });
    for (const d of projectDirs) {
      if (!d.isDirectory()) continue;
      const sessions = listSessionFiles(join(projectsDir, d.name));
      allSessions.push(...sessions);
    }
  } catch {}

  // Sort by mtime, newest first
  allSessions.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  return allSessions;
}

/** List subagent transcript files for a session */
export function listSubagentFiles(sessionFile: string): SessionFileInfo[] {
  const sessionId = basename(sessionFile, ".jsonl");
  const sessionDir = join(dirname(sessionFile), sessionId, "subagents");

  if (!existsSync(sessionDir)) return [];

  const files: SessionFileInfo[] = [];

  try {
    // Subagents can be in subdirectories
    function scanDir(dir: string) {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          try {
            const stat = statSync(fullPath);

            // Read .meta.json for agent type if it exists
            const metaPath = fullPath.replace(".jsonl", ".meta.json");
            let agentType: string | null = null;
            if (existsSync(metaPath)) {
              try {
                const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
                agentType = meta.agentType ?? null;
              } catch {}
            }

            files.push({
              path: fullPath,
              sessionId: entry.name.replace(".jsonl", ""),
              mtime: stat.mtime,
              size: stat.size,
              projectDir: dirname(sessionFile),
              agentType,
            });
          } catch {}
        } else if (entry.isDirectory()) {
          scanDir(fullPath);
        }
      }
    }
    scanDir(sessionDir);
  } catch {}

  // Sort by mtime, newest first (deterministic ordering)
  files.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  return files;
}

// ============================================================================
// Session preview extraction
// ============================================================================

export interface PreviewMessage {
  role: "user" | "assistant";
  text: string;
}

export interface SessionPreview {
  /** First N messages from the session */
  headMessages: PreviewMessage[];
  /** Last N messages from the session */
  tailMessages: PreviewMessage[];
  /** Git branch */
  gitBranch: string | null;
  /** Working directory from session */
  cwd: string | null;
}

/** Extract text from a JSONL entry's message content. */
function extractMessageText(entry: any): string | null {
  if (!entry.message?.content) return null;
  const content = entry.message.content;
  const text = typeof content === "string"
    ? content
    : (Array.isArray(content)
        ? content.find((b: any) => b.type === "text")?.text
        : null) ?? "";
  return text || null;
}

/**
 * Extract preview information from a session file via full JSONL parse.
 * Reads the entire file to guarantee all messages are considered regardless
 * of position. Returns first N and last N user/assistant messages.
 * 
 * @param previewLines Number of messages to extract from head and tail (default: 2)
 */
export function extractSessionPreview(filePath: string, previewLines: number = 2): SessionPreview {
  const preview: SessionPreview = {
    headMessages: [],
    tailMessages: [],
    gitBranch: null,
    cwd: null,
  };

  try {
    const content = readFileSync(filePath, "utf-8");
    const allMessages: PreviewMessage[] = [];

    let pos = 0;
    const len = content.length;

    while (pos < len) {
      let end = content.indexOf("\n", pos);
      if (end === -1) end = len;
      const line = content.substring(pos, end);
      pos = end + 1;

      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);

        // Metadata: grab first gitBranch and cwd
        if (!preview.gitBranch && entry.gitBranch) {
          preview.gitBranch = entry.gitBranch;
        }
        if (!preview.cwd && entry.cwd) {
          preview.cwd = entry.cwd;
        }

        // Collect user/assistant messages with text content
        if (entry.type === "user" || entry.type === "assistant") {
          const text = extractMessageText(entry);
          if (text) {
            allMessages.push({
              role: entry.type as "user" | "assistant",
              text: text.slice(0, 200),
            });
          }
        }
      } catch {}
    }

    // Take first N and last N
    preview.headMessages = allMessages.slice(0, previewLines);
    const tailStart = Math.max(previewLines, allMessages.length - previewLines);
    preview.tailMessages = allMessages.slice(tailStart);

    // If head and tail overlap (short session), clear tail to avoid duplication
    if (allMessages.length <= previewLines * 2) {
      preview.tailMessages = [];
    }
  } catch {}

  return preview;
}

// ============================================================================
// Git branch extraction
// ============================================================================

/** Size of head chunk to scan for gitBranch (bytes). */
const HEAD_SCAN_BYTES = 8_192;

/**
 * Extract git branch(es) from a session file by scanning the head.
 * Returns unique branches found. Scans only the first HEAD_SCAN_BYTES
 * since gitBranch appears in the earliest entries.
 */
export function extractGitBranches(filePath: string): string[] {
  try {
    const stat = statSync(filePath);
    const readSize = Math.min(stat.size, HEAD_SCAN_BYTES);
    const buf = Buffer.alloc(readSize);
    const fd = openSync(filePath, "r");
    readSync(fd, buf, 0, readSize, 0);
    closeSync(fd);

    const text = buf.toString("utf-8");
    const branches = new Set<string>();
    const re = /"gitBranch":"([^"]+)"/g;
    let match;
    while ((match = re.exec(text)) !== null) {
      branches.add(match[1]);
    }
    return [...branches];
  } catch {
    return [];
  }
}

/**
 * Extract the primary git branch for a session (first found).
 */
export function extractGitBranch(filePath: string): string | null {
  const branches = extractGitBranches(filePath);
  return branches.length > 0 ? branches[0] : null;
}

// ============================================================================
// Project listing
// ============================================================================

export interface ProjectInfo {
  /** The hashed project directory name (e.g., "-Users-foo-bar") */
  dirName: string;
  /** Full path to the project directory under ~/.claude/projects/ */
  projectDir: string;
  /** Reconstructed original working directory path */
  cwd: string;
  /** Number of sessions in this project */
  sessionCount: number;
  /** Most recent session activity */
  lastActivity: Date;
  /** Git branches seen across sessions */
  branches: string[];
}

/**
 * Reconstruct the original cwd from a CC project directory name.
 * CC sanitizes all non-alphanumeric chars to `-`, so this is inherently lossy
 * (spaces, dots, underscores, hyphens all become `-`). We apply heuristics:
 * - Leading `-` → `/` (absolute path)
 * - `-Users-` or `-home-` prefix → `/Users/` or `/home/` (common OS paths)
 * - Otherwise just replace `-` with `/` as a best guess
 * 
 * The result is approximate — callers should treat it as a display hint, not a reliable path.
 */
function cwdFromDirName(dirName: string): string {
  // Strip hash suffix if present (after the 200-char truncation point)
  // Hash suffix is `-<base36>` at the end when original sanitized name was >200 chars
  let name = dirName;
  if (name.length > MAX_DIR_NAME_LENGTH) {
    // Could have a hash suffix — but we can't reliably strip it without knowing
    // the original, so just work with what we have
  }
  return name.replace(/-/g, "/");
}

/**
 * List all CC projects with metadata.
 */
export function listProjects(opts?: { limit?: number; offset?: number }): {
  projects: ProjectInfo[];
  totalCount: number;
  hasMore: boolean;
} {
  const projectsDir = getProjectsDir();
  if (!existsSync(projectsDir)) {
    return { projects: [], totalCount: 0, hasMore: false };
  }

  const allProjects: ProjectInfo[] = [];

  try {
    const dirs = readdirSync(projectsDir, { withFileTypes: true });
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const fullPath = join(projectsDir, d.name);
      const sessions = listSessionFiles(fullPath);
      if (sessions.length === 0) continue;

      // Collect branches from recent sessions (scan up to 5 for efficiency)
      const branchSet = new Set<string>();
      for (const s of sessions.slice(0, 5)) {
        for (const b of extractGitBranches(s.path)) {
          branchSet.add(b);
        }
      }

      allProjects.push({
        dirName: d.name,
        projectDir: fullPath,
        cwd: cwdFromDirName(d.name),
        sessionCount: sessions.length,
        lastActivity: sessions[0].mtime, // sessions already sorted newest-first
        branches: [...branchSet],
      });
    }
  } catch {
    return { projects: [], totalCount: 0, hasMore: false };
  }

  // Sort by last activity, newest first
  allProjects.sort((a, b) => b.lastActivity.getTime() - a.lastActivity.getTime());

  const limit = opts?.limit ?? 50;
  const offset = opts?.offset ?? 0;
  const page = allProjects.slice(offset, offset + limit);
  return {
    projects: page,
    totalCount: allProjects.length,
    hasMore: offset + limit < allProjects.length,
  };
}

// ============================================================================
// Routing
// ============================================================================

export type RoutingMode = "project" | "global" | "session" | "self" | "ancestors" | "subagents" | "branch";

export interface RoutingParams {
  mode: RoutingMode;
  /** For "project" mode: the cwd to find sessions for */
  cwd?: string;
  /** For "project" mode: explicit project dir path */
  projectDir?: string;
  /** For "session" mode: specific session file path or ID */
  sessionId?: string;
  /** Include subagent transcripts */
  includeSubagents?: boolean;
  /** Max sessions to return */
  limit?: number;
  /** Offset for pagination */
  offset?: number;
  /** For "branch" mode: explicit git branch (auto-detected from calling session if omitted) */
  gitBranch?: string;
}

export interface RoutingResult {
  sessions: SessionFileInfo[];
  totalCount: number;
  hasMore: boolean;
}

/** Resolve session files based on routing parameters */
export function resolveSessionFiles(params: RoutingParams): RoutingResult {
  const limit = params.limit ?? 50;
  const offset = params.offset ?? 0;
  let allSessions: SessionFileInfo[];

  switch (params.mode) {
    case "project": {
      const projectDir = params.projectDir ?? (params.cwd ? getProjectDir(params.cwd) : null);
      if (!projectDir) {
        return { sessions: [], totalCount: 0, hasMore: false };
      }
      allSessions = listSessionFiles(projectDir);

      // Optionally include subagents
      if (params.includeSubagents) {
        const withSubagents: SessionFileInfo[] = [];
        for (const s of allSessions) {
          withSubagents.push(s);
          withSubagents.push(...listSubagentFiles(s.path));
        }
        allSessions = withSubagents;
      }
      break;
    }

    case "global": {
      allSessions = listAllSessionFiles();
      break;
    }

    case "session": {
      if (!params.sessionId) {
        return { sessions: [], totalCount: 0, hasMore: false };
      }
      // Try as full path first
      if (existsSync(params.sessionId)) {
        const stat = statSync(params.sessionId);
        allSessions = [{
          path: params.sessionId,
          sessionId: basename(params.sessionId, ".jsonl"),
          mtime: stat.mtime,
          size: stat.size,
          projectDir: dirname(params.sessionId),
        }];
      } else {
        // Try to find by session ID across all projects
        const all = listAllSessionFiles();
        allSessions = all.filter((s) => s.sessionId === params.sessionId);
      }
      break;
    }

    case "branch": {
      // Find all sessions in the same project that share a git branch with the current session.
      const projectDir = params.projectDir ?? (params.cwd ? getProjectDir(params.cwd) : null);
      if (!projectDir) {
        return { sessions: [], totalCount: 0, hasMore: false };
      }

      const projectSessions = listSessionFiles(projectDir);
      let targetBranch: string | null = null;

      // Resolve calling session's branch via PID-based lookup
      const calling = findCallingSession();
      if (calling) {
        const callingSession = projectSessions.find(s => s.sessionId === calling.sessionId);
        if (callingSession) {
          targetBranch = extractGitBranch(callingSession.path);
        }
      }

      // Fallback: use the explicit gitBranch param
      if (!targetBranch && params.gitBranch) {
        targetBranch = params.gitBranch;
      }

      if (!targetBranch) {
        return { sessions: [], totalCount: 0, hasMore: false };
      }

      // Filter to sessions that share the same branch
      allSessions = projectSessions.filter(s => {
        const branches = extractGitBranches(s.path);
        return branches.includes(targetBranch!);
      });
      break;
    }

    default:
      return { sessions: [], totalCount: 0, hasMore: false };
  }

  const totalCount = allSessions.length;
  const sessions = allSessions.slice(offset, offset + limit);
  const hasMore = offset + limit < totalCount;

  return { sessions, totalCount, hasMore };
}

// ============================================================================
// Calling session resolution — PID-based via CC's session registry
// ============================================================================

/**
 * Resolve the calling session via CC's session registry.
 *
 * CC writes `~/.claude/sessions/<pid>.json` for each active session,
 * containing `{ pid, sessionId, cwd, startedAt, kind }`. The file exists
 * for the lifetime of the CC process and is deleted on exit.
 *
 * Since the MCP server is a child (or grandchild) of the CC process,
 * we walk up the process tree from our PID until we find one that matches
 * a session registry file. This is deterministic and race-free — unlike
 * toolUseId tail-scanning, which depends on write ordering.
 *
 * @returns `{ sessionId, cwd }` or `null` if no matching session found
 */
export function findCallingSession(): { sessionId: string; cwd: string } | null {
  const sessionsDir = join(homedir(), ".claude", "sessions");
  if (!existsSync(sessionsDir)) return null;

  let pid = process.pid;
  while (pid > 1) {
    const sessionFile = join(sessionsDir, `${pid}.json`);
    if (existsSync(sessionFile)) {
      try {
        const info = JSON.parse(readFileSync(sessionFile, "utf-8"));
        if (info.sessionId) {
          return { sessionId: info.sessionId, cwd: info.cwd ?? process.cwd() };
        }
      } catch {}
    }
    const ppid = getParentPid(pid);
    if (!ppid || ppid === pid) break;
    pid = ppid;
  }
  return null;
}

/** Get parent PID. Uses process.ppid for self, `ps` for other processes. */
function getParentPid(pid: number): number | null {
  try {
    if (pid === process.pid) return process.ppid;
    const result = (execSync(`ps -o ppid= -p ${pid}`, {
      encoding: "utf-8",
      timeout: 1000,
      stdio: ["pipe", "pipe", "pipe"],
    }) as string).trim();
    const ppid = parseInt(result, 10);
    return Number.isFinite(ppid) ? ppid : null;
  } catch {
    return null;
  }
}


