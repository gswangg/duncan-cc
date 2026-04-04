import assert from "node:assert/strict";

import { deriveSessionWindowsFromEntries, renderJsonl, sliceEntriesForWindow, validateSessionWindow } from "../src/headless/session-boundaries.js";

function user(uuid: string, parentUuid: string | null, text: string) {
  return { type: "user", uuid, parentUuid, timestamp: new Date().toISOString(), sessionId: "session-src", message: { role: "user", content: text } };
}

function assistant(uuid: string, parentUuid: string | null, text: string) {
  return { type: "assistant", uuid, parentUuid, timestamp: new Date().toISOString(), sessionId: "session-src", message: { role: "assistant", content: [{ type: "text", text }] } };
}

function boundary(uuid: string) {
  return { type: "system", subtype: "compact_boundary", uuid, parentUuid: null, timestamp: new Date().toISOString(), sessionId: "session-src", message: { role: "system", content: "compact" } };
}

{
  const entries = [user("u1", null, "hello"), assistant("a1", "u1", "hi")];
  const windows = deriveSessionWindowsFromEntries(entries);
  assert.equal(windows.length, 1);
  assert.deepEqual(windows[0], {
    windowIndex: 0,
    kind: "full",
    startEntryIndex: 0,
    endEntryIndex: 2,
    includesCompactBoundary: false,
  });
}

{
  const entries = [
    user("u1", null, "first"),
    assistant("a1", "u1", "reply1"),
    boundary("b1"),
    user("u2", "b1", "second"),
    assistant("a2", "u2", "reply2"),
    boundary("b2"),
    user("u3", "b2", "third"),
  ];
  const windows = deriveSessionWindowsFromEntries(entries);
  assert.equal(windows.length, 3);
  assert.deepEqual(windows.map((w) => [w.kind, w.startEntryIndex, w.endEntryIndex]), [
    ["full", 0, 2],
    ["compaction", 2, 5],
    ["compaction", 5, 7],
  ]);

  const secondWindowEntries = sliceEntriesForWindow(entries, windows[1]!);
  assert.equal(secondWindowEntries[0].subtype, "compact_boundary");
  assert.equal(secondWindowEntries.length, 3);
  assert.equal(renderJsonl(secondWindowEntries).trim().split("\n").length, 3);
}

{
  const entries = [user("u1", null, "first"), boundary("b1"), user("u2", "b1", "second")];
  assert.throws(() => validateSessionWindow(entries, {
    windowIndex: 99,
    kind: "compaction",
    startEntryIndex: 0,
    endEntryIndex: 2,
    includesCompactBoundary: true,
  }), /Compaction window must start/);
}

{
  const entries = [boundary("b1"), user("u2", "b1", "second")];
  const windows = deriveSessionWindowsFromEntries(entries);
  assert.equal(windows.length, 1);
  assert.equal(windows[0]?.windowIndex, 1);
  assert.equal(windows[0]?.kind, "compaction");
}

console.log("headless-boundaries.test.ts: ok");
