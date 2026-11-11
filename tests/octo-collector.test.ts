// Failure modes: history is dispatched at startup, replies get rerouted, or an unacknowledged event is skipped.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { collectOcto, listOcto, waitForOctoPoll, type OctoState, type OctoTask } from "../cli/collect-octo.ts";
import { parseRules } from "../protocol/rules.ts";
import { issueSelector } from "../cli/collect-octo.ts";

const rules = parseRules(
  JSON.stringify({
    sources: { report: { name: "REPORT" }, sync: { name: "SYNC" } },
    agents: { codex: { name: "Codex", worker: "mac", use: "codex" } },
    rules: ["report", "sync"].map((name) => ({
      name,
      aliases: [name],
      keywords: [name],
      when: { source: name, types: ["task.created", "task.comment"] },
      to: "codex",
      cwd: "/work",
      parallel: 1,
      prompt: "处理",
    })),
  }),
  0,
  "UTC",
);
const scope = { workspaceId: "workspace", assigneeUid: "user", hubUrl: "http://127.0.0.1:3350" };

test("a manual trigger wakes the watcher during its delay and is not lost during a poll", async (t) => {
  const fixture = mkdtempSync(join(tmpdir(), "octo-trigger-"));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const signal = join(fixture, "state.trigger");
  const waiting = waitForOctoPoll(signal, "", 1000);
  writeFileSync(signal, "trigger-1");
  assert.equal(await waiting, "trigger");
  writeFileSync(signal, "trigger-2");
  assert.equal(await waitForOctoPoll(signal, "trigger-1", 1000), "trigger");
  assert.equal(await waitForOctoPoll(signal, "trigger-2", 10), "interval");
});
const task = (id: string, title: string, status = "todo"): OctoTask => ({
  task_id: id,
  title,
  status,
  description: "",
  url: "https://example.invalid/issues/" + id,
  created_at: "2026-11-09T00:00:01Z",
  workspace_id: "workspace",
  assignee_octo_uid: "user",
});

test("explicit collection adds a route without replaying existing events or changing their IDs", async () => {
  const issue = task("extra", "report request");
  const subject = "loop:workspace:extra";
  let state: OctoState = {
    version: 1,
    scope,
    baselineAt: 0,
    tasks: { extra: { route: { rule: "report", source: "report" }, created: true, comments: ["old"] } },
  };
  const sent: string[] = [];
  const input = {
    scope,
    rules,
    tasks: [issue],
    routes: {},
    now: 1,
    save: (next: OctoState) => {
      state = structuredClone(next);
    },
    emit: async (route: { rule: string }, event: { id: string }) => {
      sent.push(`${route.rule} ${event.id}`);
    },
    comments: async () =>
      ["old", "new"].map((comment_id) => ({
        comment_id,
        content: comment_id,
        created_at: "2026-11-10T00:00:00Z",
      })),
  };
  const explicit = { ...input, selectedIssue: "extra", selectedRule: "sync" };
  assert.equal((await collectOcto(state, explicit)).created, 1);
  assert.equal((await collectOcto(state, explicit)).created, 0);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /^sync loop:workspace:extra:rule:[a-f0-9]+:created$/);
  await collectOcto(state, input);
  assert.deepEqual(
    sent.filter((item) => item.startsWith("report ")),
    [`report ${subject}:comment:new`],
  );
  assert.equal(sent.filter((item) => item.startsWith("sync ") && item.includes(":comment:")).length, 2);
});

test("an unclear Issue is deferred with a clarification and is retried after the project is supplied", async () => {
  let state: OctoState = { version: 1, scope, baselineAt: 0, tasks: {} };
  const sent: string[] = [];
  const pending: string[] = [];
  const common = {
    scope,
    rules,
    routes: {},
    now: 1,
    save(next: OctoState) {
      state = next;
    },
    emit: async (_route: unknown, event: { id: string }) => {
      sent.push(event.id);
    },
    comments: async () => [],
    notifyClarification: async ({ task_id }: OctoTask) => {
      pending.push(task_id);
    },
  };
  const issue = task("unclear", "下载错误");
  assert.equal((await collectOcto(state, { ...common, tasks: [issue] })).created, 0);
  assert.deepEqual(pending, ["unclear"]);
  assert.deepEqual(sent, []);
  assert.equal(
    (await collectOcto(state, { ...common, tasks: [{ ...issue, description: "项目：report\n下载错误" }] })).created,
    1,
  );
  assert.deepEqual(sent, ["loop:workspace:unclear:created"]);
});

test("an explicit Issue bypasses the historical baseline without replaying the create or other issues", async () => {
  const chosen = { ...task("old", "report request"), created_at: "2026-11-08T00:00:00Z" };
  let state: OctoState = {
    version: 1,
    scope,
    baselineAt: Date.parse("2026-11-09T00:00:00Z"),
    tasks: { old: { created: false, comments: [], historical: true } },
  };
  const sent: string[] = [];
  const input = {
    scope,
    rules,
    tasks: [chosen, task("other", "report request")],
    routes: {},
    now: state.baselineAt,
    selectedIssue: "old",
    save: (next: OctoState) => {
      state = next;
    },
    emit: async (_route: unknown, event: { id: string }) => {
      sent.push(event.id);
    },
    comments: async () => {
      throw new Error("direct intake should not replay comments");
    },
  };
  assert.equal((await collectOcto(state, input)).created, 1);
  assert.equal((await collectOcto(state, input)).created, 0);
  assert.equal(state.tasks.old.historical, undefined);
  assert.deepEqual(sent, ["loop:workspace:old:created"]);
  assert.equal(issueSelector("https://example.invalid/tasks/demo-253"), "DEMO-253");
  assert.equal(
    issueSelector("https://example.invalid/?taskId=8300b9e0-86c5-435b-b2f4-ef21dfee11c7"),
    "8300B9E0-86C5-435B-B2F4-EF21DFEE11C7",
  );
});

test("a requester notice waits for Hub acceptance and does not block comment intake on failure", async () => {
  let state: OctoState | undefined;
  const steps: string[] = [];
  const input = {
    scope,
    rules,
    tasks: [task("new", "report request")],
    routes: {},
    now: Date.parse("2026-11-09T00:00:00Z"),
    save: (next: OctoState) => {
      state = structuredClone(next);
    },
    emit: async (_route: unknown, event: { type: string }) => {
      steps.push(event.type);
    },
    notifyStarted: async () => {
      steps.push("notice");
      throw new Error("offline");
    },
    comments: async () => [{ comment_id: "reply", content: "补充", created_at: "2026-11-09T00:00:01Z" }],
  };
  await collectOcto(undefined, { ...input, tasks: [] });
  await assert.rejects(
    collectOcto(state, {
      ...input,
      emit: async () => {
        throw new Error("no acknowledgement");
      },
    }),
  );
  assert.deepEqual(steps, []);
  assert.deepEqual((await collectOcto(state, input)).noticeFailures, ["new"]);
  assert.deepEqual(steps, ["task.created", "notice", "task.comment"]);
});

test("baseline, stable routing, scoped filtering and lost acknowledgements", async () => {
  let state: OctoState | undefined;
  let fail = false;
  const sent: [string, string, string][] = [];
  const queried: string[] = [];
  const comments = [{ comment_id: "old", content: "旧评论", created_at: "2026-11-08T00:00:00Z" }];
  const poll = (tasks: OctoTask[], routes: Record<string, string> = {}) =>
    collectOcto(state, {
      scope,
      rules,
      tasks,
      routes,
      now: Date.parse("2026-11-09T00:00:00Z"),
      comments: async (id) => {
        queried.push(id);
        return comments;
      },
      save: (next) => {
        state = structuredClone(next);
      },
      emit: async (route, event) => {
        assert.equal(event.link, "https://example.invalid/issues/" + event.subject.split(":").at(-1));
        sent.push([route.source, event.id, event.type]);
        if (fail) throw new Error("lost response");
      },
    });
  await poll([task("old", "report")]);
  assert.equal(sent.length, 0);
  comments.push({ comment_id: "later", content: "历史 Issue 的新评论", created_at: "2026-11-09T00:01:00Z" });
  await poll([task("old", "report"), { ...task("reassigned", "report"), created_at: "2026-11-08T00:00:00Z" }]);
  assert.equal(sent.length, 0);
  assert.equal(queried.length, 0);
  comments.pop();
  fail = true;
  await assert.rejects(poll([task("new", "report")]), /lost response/);
  fail = false;
  await poll([task("new", "sync")]);
  assert.equal(sent[0][1], sent[1][1]);
  assert.equal(sent[1][0], "report", "route was persisted before first send");
  comments.push({ comment_id: "new-comment", content: "新评论", created_at: "2026-11-09T00:01:00Z" });
  await poll([task("new", "sync", "blocked")]);
  assert.equal(sent.length, 2);
  await poll([task("new", "sync"), task("ambiguous", "未指明项目")]);
  assert.deepEqual(
    sent.map(([source, , type]) => [source, type]),
    [
      ["report", "task.created"],
      ["report", "task.created"],
      ["report", "task.comment"],
    ],
  );
  await poll([task("new", "sync")]);
  assert.equal(sent.length, 3);
  await poll([task("ambiguous", "report sync")], { ambiguous: "sync" });
  assert.equal(sent[3][0], "sync");
});

test("pagination follows the server's actual page size and refuses incomplete pages", async () => {
  const seen: number[] = [];
  const rows = await listOcto(
    async (_path, params) => {
      const page = Number(params.page);
      seen.push(page);
      assert.equal(params.assignee_octo_uid, "user");
      return { data: [{ task_id: page }], _pagination: { page, page_size: 1, total: 2 } };
    },
    "/fleet/api/v1/tasks",
    { assignee_octo_uid: "user" },
  );
  assert.deepEqual(seen, [1, 2]);
  assert.deepEqual(
    rows.map((row) => row.task_id),
    [1, 2],
  );
  await assert.rejects(
    listOcto(
      async () => ({
        data: [],
        _pagination: { page: 1, page_size: 1, total: 2 },
      }),
      "/fleet/api/v1/tasks",
    ),
    /未完整返回/,
  );
});

test("one Octo source uses distinct event types for each project rule", async () => {
  const shared = {
    ...rules,
    sources: { "octo-issue": { name: "Octo Issue" } },
    rules: rules.rules.map((rule) => ({
      ...rule,
      when: { source: "octo-issue", types: [`task.${rule.name}.created`, `task.${rule.name}.comment`] },
    })),
  };
  const sent: [string, string, string][] = [];
  let state: OctoState = { version: 1, scope, baselineAt: Date.parse("2026-11-09T00:00:00Z"), tasks: {} };
  let fail = true;
  const poll = () =>
    collectOcto(state, {
      scope,
      rules: shared,
      tasks: [task("one", "report sync")],
      routes: {},
      now: 0,
      comments: async () => [{ comment_id: "reply", content: "补充", created_at: "2026-11-09T01:00:00Z" }],
      save: (next) => {
        state = structuredClone(next);
      },
      emit: async (route, event) => {
        assert.equal(event.subject, "loop:workspace:one");
        sent.push([route.source, event.type, event.id]);
        if (fail && route.rule === "sync") throw new Error("lost response");
      },
    });
  await assert.rejects(poll(), /lost response/);
  fail = false;
  const result = await poll();
  await poll();
  assert.deepEqual(result.pending, []);
  assert.deepEqual(
    sent.map(([source, type]) => [source, type]),
    [
      ["octo-issue", "task.report.created"],
      ["octo-issue", "task.sync.created"],
      ["octo-issue", "task.sync.created"],
      ["octo-issue", "task.report.comment"],
      ["octo-issue", "task.sync.comment"],
    ],
  );
  assert.notEqual(sent[0][2], sent[1][2]);
  assert.equal(sent[1][2], sent[2][2]);
  assert.notEqual(sent[3][2], sent[4][2]);
});
