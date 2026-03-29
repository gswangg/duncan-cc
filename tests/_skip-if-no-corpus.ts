import { existsSync } from "node:fs";
import { join } from "node:path";

const TESTDATA = join(import.meta.dirname, "..", "testdata", "projects");

export function requireCorpus(): string {
  if (!existsSync(TESTDATA)) {
    console.log("⊘ skipped (no testdata/ — corpus tests require session data)");
    process.exit(0);
  }
  return TESTDATA;
}
