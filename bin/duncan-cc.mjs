#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const entry = join(__dirname, "..", "src", "mcp-server.ts");

// Find tsx — may be in our own node_modules or a parent (npx hoists deps)
function findTsx() {
  let dir = join(__dirname, "..");
  while (true) {
    const candidate = join(dir, "node_modules", ".bin", "tsx");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const tsx = findTsx();
if (!tsx) {
  process.stderr.write("Error: tsx not found. Install with: npm install tsx\n");
  process.exit(1);
}

execFileSync(tsx, [entry], { stdio: "inherit" });
