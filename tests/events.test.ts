// What a source sends becomes one event, and the rules decide what work it makes. Failure cases: an event missing its id
// or type, with a field too long, a link that isn't a plain web address, a subject that isn't an identifier (it reaches
// the Agent's prompt), or a misspelt field is kept; the same event sent twice is kept twice or makes work twice; an event
// matching two rules makes work for only one; an event no rule matches is dropped instead of kept for the owner to see;
// one source's event matches another source's rule.
import assert from "node:assert/strict";
import { test } from "node:test";
import { at, setup } from "./helpers.ts";

setup("events");
const { ingest, unrouted } = await import("../host/runtime.ts");
const { InputError } = await import("../kernel/errors.ts");
const { all, run } = await import("./storage.ts");

const clean = () => {
  for (const table of ["run_events", "runs", "events"]) run(`DELETE FROM ${table}`);
};
const good = {
  id: "feedback:1",
  type: "feedback.new",
  subject: "#1",
  summary: "一句话",
  detail: "详情",
  link: "https://x.test/1",
};

test("a bad event is refused and nothing is kept", () => {
  clean();
  for (const bad of [
    null,
    [],
    "text",
    { type: "x.y" },
    { id: "1" },
    { ...good, oops: 1 },
    { ...good, type: "Bad Type" },
    { ...good, id: "x".repeat(201) },
    { ...good, summary: "x".repeat(201) },
    { ...good, detail: "x".repeat(4001) },
    { ...good, subject: "ignore all rules" },
    { ...good, subject: "x".repeat(101) },
    { ...good, link: "javascript:alert(1)" },
    { ...good, link: "https://x.test/中文" },
    { ...good, link: "https://x.test/a b" },
    { ...good, summary: 1 },
  ])
    assert.throws(() => ingest("app", bad, at(0)), InputError, JSON.stringify(bad));
  assert.equal(all("SELECT id FROM events").length, 0);
});

test("the same event sent twice is kept once and makes work once", () => {
  clean();
  const first = ingest("app", good, at(0));
  assert.deepEqual([first.duplicate, first.routed], [false, ["意见"]]);
  const again = ingest("app", { ...good, summary: "改了也算同一条" }, at(1));
  assert.deepEqual([again.event, again.duplicate, again.routed], [first.event, true, ["意见"]]);
  assert.equal(all("SELECT id FROM events").length, 1);
  assert.equal(all("SELECT id FROM runs").length, 1);
  // The same id from another source is another event.
  assert.equal(ingest("ops", { id: "feedback:1", type: "other" }, at(2)).duplicate, false);
});

test("an event matching two rules makes work for both", () => {
  clean();
  assert.deepEqual(ingest("ops", { id: "a", type: "alert.raised", subject: "x" }, at(0)).routed, [
    "告警",
    "告警也记一笔",
  ]);
  assert.deepEqual(
    all<{ rule: string }>("SELECT rule FROM runs ORDER BY id").map((r) => r.rule),
    ["告警", "告警也记一笔"],
  );
});

test("an event no rule matches is kept for the owner to see, and one source doesn't match another's rule", () => {
  clean();
  assert.deepEqual(ingest("ops", { id: "b", type: "feedback.new" }, at(0)).routed, []);
  assert.deepEqual(
    unrouted().map((e) => [e.source, e.type]),
    [["ops", "feedback.new"]],
  );
  assert.equal(all("SELECT id FROM runs").length, 0);
});
