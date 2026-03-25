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

import { readdirSync, statSync, existsSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { homedir } from "node:os";

// ============================================================================
// Path resolution — mirrors CC's path layout
// ============================================================================

/** Get CC's projects directory */
export function getProjectsDir(): string {
  return join(homedir(), ".claude", "projects");
}

/** Get project dir for a given cwd (hashed) */
export function getProjectDir(cwd: string): string | null {
  const projectsDir = getProjectsDir();
  if (!existsSync(projectsDir)) return null;

  // CC hashes the cwd into the directory name
  // The format is: the cwd with / replaced by - and leading - stripped
  // e.g., /Users/foo/bar → -Users-foo-bar
  const hashed = cwd.replace(/\//g, "-");

  const fullPath = join(projectsDir, hashed);
  if (existsSync(fullPath)) return fullPath;

  // Try to find by scanning (the hash might differ slightly)
  try {
    const dirs = readdirSync(projectsDir, { withFileTypes: true });
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      // Check if the directory name ends with the last component(s) of cwd
      if (d.name === hashed || d.name.endsWith(hashed)) {
        return join(projectsDir, d.name);
      }
    }
  } catch {}

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
            files.push({
              path: fullPath,
              sessionId: entry.name.replace(".jsonl", ""),
              mtime: stat.mtime,
              size: stat.size,
              projectDir: dirname(sessionFile),
            });
          } catch {}
        } else if (entry.isDirectory()) {
          scanDir(fullPath);
        }
      }
    }
    scanDir(sessionDir);
  } catch {}

  return files;
}

// ============================================================================
// Routing
// ============================================================================

export type RoutingMode = "project" | "global" | "session";

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

    default:
      return { sessions: [], totalCount: 0, hasMore: false };
  }

  const totalCount = allSessions.length;
  const sessions = allSessions.slice(offset, offset + limit);
  const hasMore = offset + limit < totalCount;

  return { sessions, totalCount, hasMore };
}
