// Failure modes: the real-process crash harness misses log/projection divergence or leaves killed processes and databases.
import assert from "node:assert/strict";
import { test } from "node:test";
import { crashCheck } from "../sim/crash.ts";
test("three seeded real-process crashes exercise recovery in the fast checks", async () => {
  assert.equal((await crashCheck(3, 0xc0ffee)).kills, 3);
});
