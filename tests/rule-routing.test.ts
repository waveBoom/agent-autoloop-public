// Failure modes: explicit aliases silently fall back, shared keywords pick an arbitrary rule, or repo names match prefixes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRules } from "../protocol/rules.ts";
import { routeCandidates } from "../protocol/route.ts";

test("routing distinguishes explicit aliases, repo names and cross-project ambiguity", () => {
  const rule = (name: string, source: string, keywords: string[]) => ({
    name,
    when: { source, types: ["task.created"] },
    to: "codex",
    cwd: "/work",
    prompt: "处理任务",
    aliases: [source],
    keywords,
  });
  const config = {
    agents: { codex: { name: "Codex", worker: "mac", use: "codex" } },
    sources: { report: { name: "REPORT" }, sync: { name: "SYNC" } },
    rules: [rule("REPORT", "report", ["report"]), rule("SYNC", "sync", ["report-sync", "报表同步"])],
  };
  const rules = parseRules(JSON.stringify(config), 0, "UTC");
  assert.deepEqual(routeCandidates(rules, "修复 report-sync 导出"), ["SYNC"]);
  assert.deepEqual(routeCandidates(rules, "report 与 report-sync 联调"), ["REPORT", "SYNC"]);
  assert.deepEqual(routeCandidates(rules, "报表同步失败", " REPORT "), ["REPORT"]);
  assert.deepEqual(routeCandidates(rules, "报表同步失败", "unknown"), []);
  config.rules[1].aliases = [" REPORT "];
  assert.throws(() => parseRules(JSON.stringify(config), 0, "UTC"), /别名.*重复/);
});
