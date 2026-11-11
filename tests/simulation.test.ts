// Failure modes: faults lose accepted events, duplicate execution or answers, exceed parallel limits, change receipts,
// diverge from replay, or strand work after recovery; an enumerator silently skips one ordering; mutation checks do not run.
import assert from "node:assert/strict";
import { test } from "node:test";
import { simulate } from "../sim/random.ts";
import { enumerate } from "../sim/enumerate.ts";
import { World } from "../sim/world.ts";
import { AuthError } from "../kernel/errors.ts";
import { empty, evolve } from "../kernel/evolve.ts";
import { invariants } from "../sim/invariants.ts";

test("200000 deterministic fault steps preserve safety and recovered work terminates", () => {
  const result = simulate(0x5eed, 200000);
  assert.equal(result.steps, 200000);
  for (const fault of ["lost", "duplicate", "restart", "offline", "channel", "clock"])
    assert.ok(result.faults[fault] > 0, fault);
  assert.ok(result.completed > 0);
  console.log(JSON.stringify(result));
});

test("bounded exhaustive schedules use two workers, two events and one card", () => {
  const result = enumerate();
  assert.equal(result.paths, 40320);
  assert.equal(result.actions, 8);
  assert.ok(result.transitions >= 40320 * 8);
  console.log(JSON.stringify(result));
});

test("the simulator rejects a hub that refuses valid receipt replays", () => {
  const original = World.prototype.call;
  World.prototype.call = function (type: string, ...args: any[]) {
    const run = this.view.get("runs", args[0])!;
    if (type === "finish" && run?.last_issued && run.issued === null) throw new AuthError("故意拒绝有效重放");
    return original.call(this, type, ...args);
  };
  try {
    assert.throws(() => simulate(24301, 2048), /种子/);
  } finally {
    World.prototype.call = original;
  }
});

test("answer checks reject a run in the wrong subject lane", () => {
  const w = new World();
  w.call("createCard", {
    key: "q",
    kind: "ask",
    title: "选",
    options: ["甲", "乙"],
    rule: "one",
    lane: "#1",
    grp: "shared",
    source: "app",
  });
  w.call("answer", 1, { choice: 0 });
  const log = structuredClone(w.log);
  for (const f of log) for (const c of f.changes) if (c.table === "runs" && c.row) c.row.lane = "wrong-lane";
  assert.throws(() => invariants(evolve(new World().view, log.slice(1)), log), /原事项/);
});

test("the simulation catches omitted deadlines that strand deferred work", () => {
  const original = World.prototype.act;
  World.prototype.act = function (input) {
    const value = original.call(this, input);
    this.log = this.log.map((f) => ({ ...f, changes: f.changes.filter((c) => c.table !== "due") }));
    this.view.close();
    this.view = evolve(empty(), this.log);
    return value;
  };
  try {
    assert.throws(() => simulate(24301, 2048));
  } finally {
    World.prototype.act = original;
  }
});
