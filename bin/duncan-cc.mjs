#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const entry = join(__dirname, "..", "src", "mcp-server.ts");
const tsx = join(__dirname, "..", "node_modules", ".bin", "tsx");

try {
  execFileSync(tsx, [entry], { stdio: "inherit" });
} catch (e) {
  // tsx not found locally — try npx
  try {
    execFileSync("npx", ["tsx", entry], { stdio: "inherit" });
  } catch {
    process.stderr.write("Error: could not find tsx. Install with: npm install -g tsx\n");
    process.exit(1);
  }
}
