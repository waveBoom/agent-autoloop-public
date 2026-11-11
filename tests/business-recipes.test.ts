// Failure modes: an HTTP 200 error page or redirect is called healthy; a continuing outage wakes the model or notifies
// again; recovery closes an unrelated card; Feishu is read as the bot, pages or selected fields are lost, an unrelated
// report is included, credentials fail but an old snapshot is summarized, or report text leaks into notifications.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { probe, receipt } from "../examples/recipes/website-watch/check.ts";
import { readMessage, resultFrom } from "../worker/contract.ts";

const scratch = mkdtempSync(join(tmpdir(), "agent-autoloop-business-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
const target = { id: "site", name: "示例网站", url: "https://example.com/health", contains: '"ok":true' };
const empty = { events: [{ id: "tick-1" }], open: [] };

test("website checks status and body without following redirects, and records transport failures", async () => {
  const response = (status: number, body: string) =>
    (async (_url, options) => {
      assert.equal(options?.redirect, "manual");
      return new Response(body, { status });
    }) as typeof fetch;
  assert.equal((await probe(target, response(200, '{"ok":true}'))).ok, true);
  for (const [status, body] of [
    [200, "登录后继续"],
    [503, '{"ok":true}'],
    [302, "跳转"],
  ] as const) {
    assert.equal((await probe(target, response(status, body))).ok, false);
  }
  assert.equal(
    (
      await probe(target, async () => {
        throw new TypeError("network");
      })
    ).ok,
    false,
  );
});

test("website outage wakes once while its card is open, recovery closes only that site's card", () => {
  const first = receipt(target, { ok: false, reason: "返回 503" }, empty);
  assert.equal(first.events?.[0].type, "site.down");
  assert.equal(first.notice?.length, 1);
  const pending = {
    ...empty,
    open: [
      { card: 7, title: first.notice![0].title },
      { card: 8, title: "另一网站异常" },
    ],
  };
  assert.deepEqual(receipt(target, { ok: false, reason: "返回 503" }, pending), {});
  const recovered = receipt(target, { ok: true, reason: "已核实状态和关键内容" }, pending);
  assert.deepEqual(
    recovered.resolve?.map((r) => r.card),
    [7],
  );
  assert.equal(recovered.events?.[0].type, "site.recovered");
  assert.deepEqual(receipt(target, { ok: true, reason: "正常" }, empty), {});
});

test("a Chinese health URL remains a valid event link in the worker receipt", () => {
  const result = receipt({ ...target, url: "https://例子.测试/健康" }, { ok: false, reason: "连接失败" }, empty);
  const parsed = resultFrom(readMessage(`已检查\n\`\`\`agent-autoloop\n${JSON.stringify(result)}\n\`\`\``), {});
  assert.equal(parsed.problem, undefined);
  assert.equal(parsed.result.events![0].link, new URL("https://例子.测试/健康").href);
});

function collect(mode = "ok") {
  const dir = mkdtempSync(join(scratch, "brief-"));
  const cli = join(dir, "lark-cli");
  writeFileSync(
    cli,
    `#!${process.execPath}
import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync('calls.jsonl', JSON.stringify(args) + '\\n');
if (${JSON.stringify(mode)} === 'auth') {
  console.error(JSON.stringify({ok:false,error:{type:'authorization',message:'secret must not be copied'}})); process.exit(1);
}
let data;
if (args[0] === 'api') {
 const body = JSON.parse(args[args.indexOf('--data')+1]);
 const task = {task_id:'report-1',rule_name:'工作周报',from_user_id:'ou_demo',commit_time:body.commit_start_time+60,form_contents:[{field_name:'本周进展',field_value:'敏感原文'}]};
 data = {items:[task,{...task,task_id:'outside',from_user_id:'ou_other'},{...task,task_id:'wrong-rule',rule_name:'自由汇报'}],has_more:false};
} else {
 const offset = Number(args[args.indexOf('--offset')+1]);
 const file = args[args.indexOf('--output')+1];
 fs.writeFileSync(file, JSON.stringify({record_id:'record-'+offset,项目:'演示项目',状态:'进行中'})+'\\n');
 data = {records_count:1,has_more:offset===0,next_offset:offset+1,rev:'1'};
 fs.writeFileSync(file.replace(/\\.ndjson$/, '.manifest.json'), JSON.stringify(data));
}
console.log(JSON.stringify({ok:true,identity:'user',data}));
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(dir, "sources.json"),
    JSON.stringify({
      reportRule: "工作周报",
      reportUsers: ["ou_demo"],
      tables: [
        {
          name: "项目表",
          baseToken: "demo",
          tableId: "tbl_demo",
          fields: ["项目", "状态"],
          url: "https://example.com/projects",
        },
      ],
    }),
  );
  writeFileSync(join(dir, "context.json"), JSON.stringify({ answers: [], open: [], events: [] }));
  writeFileSync(join(dir, "weekly-input.json"), '{"id":"old","reports":["old data"]}');
  const run = spawnSync(
    process.execPath,
    [join(import.meta.dirname, "../examples/recipes/feishu-brief/collect.ts"), "sources.json"],
    {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, AGENT_AUTOLOOP_CONTEXT: join(dir, "context.json") },
    },
  );
  return { dir, run, parsed: resultFrom(readMessage(run.stdout), {}) };
}

test("Feishu collection uses the reader, filters reports and fields, and consumes all table pages", () => {
  const { dir, run, parsed } = collect();
  assert.equal(run.status, 0, run.stderr);
  assert.equal(parsed.problem, undefined);
  assert.equal(parsed.result.events?.[0].type, "brief.ready");
  assert.doesNotMatch(run.stdout, /敏感原文|演示项目/);
  const snapshot = JSON.parse(readFileSync(join(dir, "weekly-input.json"), "utf8"));
  assert.deepEqual(
    snapshot.reports.map((r: { task_id: string }) => r.task_id),
    ["report-1"],
  );
  assert.equal(snapshot.tables[0].records.length, 2);
  const calls: string[][] = readFileSync(join(dir, "calls.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.ok(calls.every((args) => args[args.indexOf("--as") + 1] === "user"));
  const baseCalls = calls.filter((args) => args[0] === "base");
  assert.equal(baseCalls.length, 2);
  assert.ok(baseCalls.every((args) => args.includes("--field-id") && args.includes("状态")));
  assert.equal(snapshot.id, parsed.result.events![0].id);
});

test("Feishu authorization failure asks once and never publishes the old snapshot or CLI details", () => {
  const { dir, run, parsed } = collect("auth");
  assert.equal(run.status, 0, run.stderr);
  assert.equal(parsed.problem, undefined);
  assert.equal(parsed.result.outcome, "done");
  assert.equal(parsed.result.ask?.length, 1);
  assert.equal(parsed.result.events, undefined);
  assert.doesNotMatch(run.stdout + run.stderr, /secret must not|old data/);
  assert.equal(JSON.parse(readFileSync(join(dir, "weekly-input.json"), "utf8")).id, "old");
});
