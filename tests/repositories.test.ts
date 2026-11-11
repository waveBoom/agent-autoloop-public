// Failure modes: repository configuration is silently dropped before execution, invalid definitions are accepted,
// a reload changes a claimed job, or declaring repositories changes legacy rules or grants filesystem access.
// All state in this file is in memory; no services or external programs are started.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseRules } from "../protocol/rules.ts";
import { parseEvent } from "../protocol/validate.ts";
import { checkSchema } from "../protocol/schema.ts";
import { decide } from "../kernel/decide.ts";
import { empty } from "../kernel/evolve.ts";
import { commit } from "../kernel/store.ts";
import { promptFor } from "../worker/contract.ts";
import { explainRules } from "../cli/explain.ts";

const now = Date.parse("2026-11-05T00:00:00Z");
const fixture = () => JSON.parse(readFileSync(new URL("./rules.fixture.json", import.meta.url), "utf8"));
const repositories = {
  web: { path: "/code/sync-web", baseBranch: "main" },
  api: { path: "~/code/sync-api", baseBranch: "release/next" },
};
const parse = (value: unknown) => parseRules(JSON.stringify(value), now, "Asia/Shanghai");

test("legacy rules stay unchanged and repository maps accept multiple local repositories", () => {
  const legacy = parse(fixture());
  assert.equal(Object.hasOwn(legacy.rules[0], "repositories"), false);
  const input = fixture();
  input.rules[0].repositories = repositories;
  assert.deepEqual(parse(input).rules[0].repositories, repositories);
  input.rules[0].repositories = {};
  assert.deepEqual(parse(input).rules[0].repositories, {});
});

test("invalid repository definitions identify their rule and field", () => {
  for (const value of [
    null,
    [],
    "web",
    { "Bad Name": repositories.web },
    { "web\n": repositories.web },
    { web: null },
    { web: [] },
    { web: { path: "relative", baseBranch: "main" } },
    { web: { path: "/code\nother", baseBranch: "main" } },
    { web: { path: "/code\n", baseBranch: "main" } },
    { web: { path: "/code" } },
    { web: { baseBranch: "main" } },
    { web: { ...repositories.web, typo: true } },
    ...["", "-main", "a..b", "a//b", "a@{b", "a.lock", "a/.hidden", "a b", "a/", "@", "main\n"].map((baseBranch) => ({
      web: { path: "/code", baseBranch },
    })),
  ]) {
    const input = fixture();
    input.rules[0].repositories = value;
    assert.throws(() => parse(input), /规则「意见」.*repositories/);
  }
  assert.throws(() => parseEvent({ id: "x", type: "feedback.new", repositories }), /不认识的字段/);
});

test("repository definitions reach jobs and prompts and stay pinned to the claimed rules version", () => {
  let view = empty();
  const env = { secret: "test-only", publicUrl: "" };
  const call = (type: string, ...args: any[]) => {
    let value: any;
    view = commit(view.db, view, () => {
      const decision = decide(view, { type, args }, now, env);
      value = decision.value;
      return decision.facts;
    });
    return value;
  };
  try {
    const input = fixture();
    call("rules", parse(input));
    call("ingest", "app", { id: "old", type: "feedback.new", subject: "old" });
    const legacy = call("claimNext", "w1", "legacy");
    assert.equal(Object.hasOwn(legacy.rule, "repositories"), false);
    call("finish", legacy.run, legacy.token, { outcome: "done" });
    input.rules[0].repositories = repositories;
    call("rules", parse(input));
    call("ingest", "app", { id: "one", type: "feedback.new", subject: "one" });
    const first = call("claimNext", "w1", "first");
    assert.deepEqual(first.rule.repositories, repositories);
    assert.equal(first.rule.cwd, "~/x");
    assert.equal(first.agent.access, "edit");
    assert.deepEqual(checkSchema("job", JSON.parse(JSON.stringify(first))), []);
    const prompt = promptFor(first, "/context.json");
    assert.ok(prompt.includes(JSON.stringify(repositories)));
    assert.match(prompt, /不代表.*写权限/);
    assert.match(explainRules(JSON.stringify(input), now).join("\n"), /web.*\/code\/sync-web.*main/);
    call("ingest", "app", { id: "two", type: "feedback.new", subject: "two" });
    input.rules[0].repositories = { web: { path: "/code/new", baseBranch: "develop" } };
    call("rules", parse(input));
    const held = call("claimNext", "w1", "first");
    assert.deepEqual(held.rule.repositories, repositories);
    call("finish", held.run, held.token, { outcome: "done" });
    assert.deepEqual(call("claimNext", "w1", "second").rule.repositories, input.rules[0].repositories);
    for (const invalid of [
      { path: "/code" },
      { path: "relative", baseBranch: "main" },
      { path: "/code\n", baseBranch: "main" },
      { path: "/code", baseBranch: "main\n" },
      { path: "/code", baseBranch: "a..b" },
    ]) {
      first.rule.repositories = { web: invalid };
      assert.ok(checkSchema("job", JSON.parse(JSON.stringify(first))).length);
    }
  } finally {
    view.close();
  }
});
