// Prevent double counting on restart/replay, negative usage after a counter reset, and invented zero usage or prices
// when a resumed session has no trustworthy baseline; prevent a session's total saved under one adapter being another's.
// No model, user session, or live hub is used.
import assert from "node:assert/strict";
import { test } from "node:test";
import { setup } from "./helpers.ts";
setup("session-usage");
const { loadUsage, saveUsage, usageDelta } = await import("../worker/usage.ts");

const first = { input: 52968, output: 126, cached: 26240 };
const total = { input: 108943, output: 207, cached: 80384 };
const delta = { input: 55975, output: 81, cached: 54144 };

test("persisted launch baseline survives advancing the session checkpoint and replay", () => {
  saveUsage("codex", "session", first);
  const launch = JSON.parse(JSON.stringify({ baseline: loadUsage("codex", "session") }));
  saveUsage("codex", "session", total);
  assert.deepEqual(usageDelta(total, launch.baseline), delta);
  assert.deepEqual(usageDelta(total, launch.baseline), delta);
  assert.deepEqual(loadUsage("codex", "session"), total);
  assert.equal(loadUsage("other", "session"), undefined);
});

test("unknown baselines and resets are missing, not cumulative usage or zero", () => {
  assert.equal(usageDelta(total, undefined), undefined);
  assert.equal(usageDelta(first, total), undefined);
  assert.equal(usageDelta({ input: 5 }, { output: 2 }), undefined);
  assert.deepEqual(usageDelta({ input: 5 }, { input: 5 }), { input: 0 });
  assert.deepEqual(usageDelta(total, first), delta);
});

test("new sessions and receipt repairs each contribute only their increment", () => {
  assert.deepEqual(usageDelta(first, { input: 0, output: 0, cached: 0, cost: 0 }), first);
  const repaired = { input: total.input + 100, output: total.output + 10, cached: total.cached + 50 };
  assert.deepEqual(usageDelta(repaired, total), { input: 100, output: 10, cached: 50 });
});
