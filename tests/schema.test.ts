// Failure modes: published schemas accept an impersonated source, malformed receipts, or credentials in event data;
// the wire contract drifts from the validators, and conformance accepts a server that opens the wrong door.
// Required job structure and inherited object names must not bypass schema checks; Unicode limits count code points.
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkSchema } from "../protocol/schema.ts";
import { parseEvent, parseResult } from "../protocol/validate.ts";

test("wire schemas agree with event and receipt boundaries", () => {
  for (const input of [
    { id: "one", type: "app.changed" },
    { id: " ", type: "app.changed", summary: null },
    { id: "one", type: "app.changed", source: "other" },
    { id: 7, type: "invalid" },
    { id: "one", type: "bad type" },
  ]) {
    let accepted = true;
    try {
      parseEvent(input);
    } catch {
      accepted = false;
    }
    assert.equal(checkSchema("event", input).length === 0, accepted);
  }
  for (const input of [
    { outcome: "done" },
    { outcome: "done", events: [{ id: "x", type: "app.changed" }] },
    { outcome: "unknown" },
    { outcome: "done", ask: [{ title: "选", text: "内容", options: ["一"] }] },
    { outcome: "done", ask: [{ title: "选", text: "内容", options: ["一", "二"], recommend: 2 }] },
    { outcome: "done", later: [{ key: "k", at: "badZ", about: "后来" }] },
  ]) {
    let accepted = true;
    try {
      parseResult(input);
    } catch {
      accepted = false;
    }
    assert.equal(checkSchema("result", input).length === 0, accepted);
  }
});

test("schema checks reject inherited names and incomplete tasks or question cards", () => {
  assert.ok(checkSchema("event", { id: "x", type: "one", constructor: "unexpected" }).length);
  assert.ok(checkSchema("job", { run: 1, token: "t", rule: {}, agent: {}, context: {} }).length);
  assert.ok(
    checkSchema("card", { id: 1, version: 1, kind: "ask", state: "open", title: "选", text: "内容", options: [] })
      .length,
  );
  assert.throws(() => checkSchema("constructor", {}));
});

test("published text limits count Unicode characters, including astral code points", () => {
  const event = { id: "x", type: "one", summary: "😀".repeat(200) };
  assert.deepEqual(checkSchema("event", event), []);
  assert.equal(parseEvent(event).summary, event.summary);
  assert.deepEqual(checkSchema("tell-source", { key: "unicode", text: "😀".repeat(20000) }), []);
  const receipt = { outcome: "done", summary: "😀".repeat(500) };
  assert.deepEqual(checkSchema("result", receipt), []);
  assert.equal(parseResult(receipt).summary, receipt.summary);
});

test("usage must be an object of finite nonnegative amounts", () => {
  for (const usage of [[1], { cost: -1 }, { cost: Infinity }, { input: NaN }]) {
    assert.throws(() => parseResult({ outcome: "done", usage }));
    assert.ok(checkSchema("result", { outcome: "done", usage }).length);
  }
});

test("timer timestamps are real calendar dates in the documented ISO format", () => {
  for (const at of ["2000Z", "2026-02-30T10:00:00Z", "2026-01-01T25:00:00Z"]) {
    const result = { outcome: "done", later: [{ key: "later", at, about: "再查" }] };
    assert.throws(() => parseResult(result));
    assert.ok(checkSchema("result", result).length);
  }
  const result = { outcome: "done", later: [{ key: "later", at: "2028-02-29T10:00:00+08:00", about: "再查" }] };
  assert.doesNotThrow(() => parseResult(result));
  assert.deepEqual(checkSchema("result", result), []);
});
