import assert from "node:assert/strict";

import {
  HEADLESS_BATCH_SIZE_WARNING,
  buildBackendDescription,
  buildBatchSizeDescription,
  buildDuncanQueryToolDescription,
} from "../src/query-config.js";

assert.match(HEADLESS_BATCH_SIZE_WARNING, /1\.45 GB RSS/);
assert.match(HEADLESS_BATCH_SIZE_WARNING, /2\.73 GB RSS/);
assert.match(buildDuncanQueryToolDescription(), /batchSize/);
assert.match(buildBackendDescription(), /headless/);
assert.match(buildBatchSizeDescription(), /memory scales roughly with batchSize/);

console.log("query-config.test.ts: ok");
