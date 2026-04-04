import { parseJsonl } from "../parser.js";

export type SessionWindowKind = "full" | "compaction";

export interface SessionWindowBoundary {
  windowIndex: number;
  kind: SessionWindowKind;
  startEntryIndex: number;
  endEntryIndex: number;
  includesCompactBoundary: boolean;
}

function isCompactBoundaryEntry(entry: any): boolean {
  return entry?.type === "system" && entry?.subtype === "compact_boundary";
}

export function deriveSessionWindowsFromEntries(entries: any[]): SessionWindowBoundary[] {
  if (entries.length === 0) return [];

  const boundaryIndices: number[] = [];
  for (let i = 0; i < entries.length; i++) {
    if (isCompactBoundaryEntry(entries[i])) {
      boundaryIndices.push(i);
    }
  }

  if (boundaryIndices.length === 0) {
    return [{
      windowIndex: 0,
      kind: "full",
      startEntryIndex: 0,
      endEntryIndex: entries.length,
      includesCompactBoundary: false,
    }];
  }

  const windows: SessionWindowBoundary[] = [];

  if (boundaryIndices[0] > 0) {
    windows.push({
      windowIndex: 0,
      kind: "full",
      startEntryIndex: 0,
      endEntryIndex: boundaryIndices[0],
      includesCompactBoundary: false,
    });
  }

  for (let i = 0; i < boundaryIndices.length; i++) {
    const start = boundaryIndices[i]!;
    const end = i + 1 < boundaryIndices.length ? boundaryIndices[i + 1]! : entries.length;
    windows.push({
      windowIndex: windows.length,
      kind: "compaction",
      startEntryIndex: start,
      endEntryIndex: end,
      includesCompactBoundary: true,
    });
  }

  return windows;
}

export function deriveSessionWindowsFromJsonl(content: string | Buffer): SessionWindowBoundary[] {
  return deriveSessionWindowsFromEntries(parseJsonl(content));
}

export function validateSessionWindow(entries: any[], window: SessionWindowBoundary): void {
  if (!Number.isInteger(window.startEntryIndex) || !Number.isInteger(window.endEntryIndex)) {
    throw new Error("Session window indices must be integers");
  }
  if (window.startEntryIndex < 0 || window.endEntryIndex > entries.length || window.startEntryIndex >= window.endEntryIndex) {
    throw new Error("Session window indices are out of bounds");
  }
  if (window.includesCompactBoundary && !isCompactBoundaryEntry(entries[window.startEntryIndex])) {
    throw new Error("Compaction window must start at a compact_boundary entry");
  }
}

export function sliceEntriesForWindow(entries: any[], window: SessionWindowBoundary): any[] {
  validateSessionWindow(entries, window);
  return entries.slice(window.startEntryIndex, window.endEntryIndex);
}

export function renderJsonl(entries: any[]): string {
  if (entries.length === 0) return "";
  return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}
