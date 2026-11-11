// Failure modes: a task becomes shell syntax; a follow-up creates another browser session; an invalid URL or session
// reaches the browser; a failed bridge is reported as success or retried; the recipe works only inside this repository.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const root = mkdtempSync(join(tmpdir(), "autoloop-browser-template-"));
after(() => rmSync(root, { recursive: true, force: true }));
const session = "12345678-1234-1234-1234-123456789abc";

function fixture() {
  const dir = mkdtempSync(join(root, "case-"));
  copyFileSync(join(import.meta.dirname, "../examples/recipes/browser-handoff/handoff.ts"), join(dir, "handoff.ts"));
  const command = join(dir, "browser entry");
  writeFileSync(
    command,
    `#!${process.execPath}
import fs from 'node:fs';
fs.appendFileSync('called.jsonl', JSON.stringify(process.argv.slice(2))+'\\n');
console.log('页面证据：示例页面标题');
console.log('[Codex 会话 ID：${session}]');
process.exit(Number(process.env.BRIDGE_EXIT || 0));
`,
    { mode: 0o755 },
  );
  const task = {
    command: [command],
    url: "https://example.com/页面",
    checks: ["核实标题", "保留字面量 $(touch SHOULD_NOT_EXIST) 和 `echo x`"],
    allowedActions: ["只读页面", "仅关闭本次新建的标签"],
  };
  writeFileSync(join(dir, "browser.json"), JSON.stringify(task));
  const run = (args: string[] = [], code = 0) =>
    spawnSync(process.execPath, ["handoff.ts", "browser.json", ...args], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, BRIDGE_EXIT: String(code) },
    });
  return { dir, task, run };
}

test("the standalone launcher passes one literal task, preserves evidence and resumes the supplied session", () => {
  const { dir, run } = fixture();
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /页面证据/);
  assert.ok(first.stdout.includes(session));
  assert.equal(existsSync(join(dir, "SHOULD_NOT_EXIST")), false);
  const again = run(["--resume", session]);
  assert.equal(again.status, 0, again.stderr);
  const calls: string[][] = readFileSync(join(dir, "called.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(calls[0].length, 1);
  assert.ok(calls[0][0].includes("$(touch SHOULD_NOT_EXIST)"));
  assert.ok(calls[0][0].includes(new URL("https://example.com/页面").href));
  assert.deepEqual(calls[1].slice(0, 2), ["--resume", session]);
  assert.equal(calls[1].length, 3);
});

test("invalid scope or resume arguments do not launch a browser", () => {
  const { dir, task, run } = fixture();
  assert.notEqual(run(["--resume", "bad; command"]).status, 0);
  assert.notEqual(run(["--resume"]).status, 0);
  assert.notEqual(run(["--other"]).status, 0);
  writeFileSync(join(dir, "browser.json"), JSON.stringify({ ...task, url: "javascript:alert(1)" }));
  assert.notEqual(run().status, 0);
  assert.equal(existsSync(join(dir, "called.jsonl")), false);
});

test("a failed bridge keeps its evidence and exit code, with no retry", () => {
  const { dir, run } = fixture();
  const failed = run([], 23);
  assert.equal(failed.status, 23);
  assert.match(failed.stdout, /页面证据/);
  assert.equal(readFileSync(join(dir, "called.jsonl"), "utf8").trim().split("\n").length, 1);
});
