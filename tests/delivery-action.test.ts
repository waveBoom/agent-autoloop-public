// Failure modes from Ship: a later docs-only commit suppresses a queued code release; an unhealthy endpoint authorizes
// skipping release; the action imports a project's mutable copy of the engine or accepts a non-commit target.
import assert from "node:assert/strict";
import { test } from "node:test";
import { decideShip } from "../plugins/delivery/action.ts";
test("Ship compares live to target and only runtime changes can supersede", async () => {
  const calls: any[] = [];
  const required = (a: string, b: string) => {
    calls.push([a, b]);
    return a === "live" || b === "new-code";
  };
  assert.deepEqual(decideShip("target", "docs-after", { sha: "live", release: "live" }, required), {
    release: true,
    superseded: false,
  });
  assert.deepEqual(calls, [
    ["live", "target"],
    ["target", "docs-after"],
  ]);
  assert.deepEqual(decideShip("target", "new-code", { sha: "target", release: "target" }, required), {
    release: false,
    superseded: true,
  });
  assert.deepEqual(decideShip("target", "target", null, required), { release: true, superseded: false });
});
