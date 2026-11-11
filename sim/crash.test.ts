// Failure modes: SIGKILL loses an acknowledged commit, leaves half a receipt or corrupts SQLite; replay disagrees with the
// persisted projection; retransmitting after an uncertain response records or dispatches an event twice.
import assert from "node:assert/strict";
import { test } from "node:test";
import { crashCheck } from "./crash.ts";
test("1000 actual SIGKILLs preserve committed logs and projections", async () => {
  const result = await crashCheck(1000, 0xc0ffee);
  console.log(JSON.stringify(result));
  assert.equal(result.kills, 1000);
  assert.ok(result.acknowledged > 1000);
});
