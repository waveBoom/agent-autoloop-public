// Failure modes: queued comments lose the previous session, resume crosses a task or execution target,
// or a resumed session grants editing without approval for this round.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRules } from "../protocol/rules.ts";
import { World } from "../sim/world.ts";

test("local debugging holds queued work until the matching handoff returns", () => {
  const world = new World();
  try {
    const issue = { rule: "one", subject: "issue-debug" };
    world.call("ingest", "app", { id: "debug", type: "one", subject: issue.subject });
    const { localDebug } = world.call("issueDisposition", {
      ...issue,
      action: "local-debug-start",
      name: "web",
      original: "refs/heads/main",
      repo: "/repo",
    });
    world.restart();
    assert.equal(world.call("claimNext", "w1", "paused"), null);
    assert.throws(
      () =>
        world.call("issueDisposition", {
          ...issue,
          action: "local-debug-return",
          name: "web",
          handoff: localDebug.id + 1,
        }),
      /状态已变化/,
    );
    world.call("issueDisposition", { ...issue, action: "local-debug-return", name: "web", handoff: localDebug.id });
    assert.ok(world.call("claimNext", "w1", "resumed"));
  } finally {
    world.view.close();
  }
});

test("App handoff pauses work and lets the resumed Agent resolve only verified task cards", () => {
  const world = new World();
  const issue = { rule: "one", subject: "issue-1" };
  const update = (action: string, detail: object) => world.call("issueDisposition", { ...issue, action, ...detail });
  const claim = (id: string) => world.call("claimNext", "w1", id);
  try {
    world.call("ingest", "app", { id: "first", type: "one", subject: issue.subject });
    const first = claim("first");
    world.call("started", first.run, first.token, { session: "app-session", link: "codex://threads/app-session" });
    assert.throws(() => update("app-handoff", { run: first.run }), /等当前轮次结束/);
    world.finish(first.run, {
      outcome: "done",
      ask: [
        { key: "desktop", title: "操作桌面", text: "复现后告诉我", options: ["已复现", "未复现"] },
        { key: "other", title: "独立确认", text: "请选择", options: ["继续", "取消"] },
      ],
    });
    update("app-handoff", { run: first.run });
    const key = `issue:${JSON.stringify([issue.rule, issue.subject])}`;
    const handoff = world.view.get("config", key)?.appHandoff.id;
    const { localDebug } = update("local-debug-start", {
      name: "web",
      original: "refs/heads/main",
      repo: "/repo",
    });
    assert.throws(() => update("app-return", { handoff, records: [] }), /先把本地调试分支交回/);
    update("local-debug-return", { name: "web", handoff: localDebug.id });
    assert.equal(world.view.get("config", key)?.appHandoff.id, handoff);
    world.call("ingest", "app", { id: "while-in-app", type: "one", subject: issue.subject });
    update("app-note", { handoff, reason: "已复现" });
    update("app-note", { handoff, reason: "已截图" });
    world.restart();
    assert.deepEqual(
      world.view.get("config", key)?.appHandoff.notes.map((note: { text: string }) => note.text),
      ["已复现", "已截图"],
    );
    assert.equal(claim("paused"), null);
    assert.equal(world.view.get("cards", 1)?.state, "open");
    const records = world.view.get("config", key)?.localRecords;
    update("add-local-record", { source: "manual", reason: "只留在看板" });
    update("edit-local-record", {
      record: records[0].id,
      expectedText: "已复现",
      expectedEditedAt: null,
      reason: "已复现，请核对日志",
    });
    update("app-return", { handoff, records: [records[0].id] });
    assert.equal(world.view.get("config", key)?.appResult.notes.length, 2);
    assert.throws(() => update("app-return", { handoff, reason: "重复提交" }), /已变化/);
    assert.equal(world.view.get("cards", 1)?.state, "open");
    assert.equal(world.view.get("cards", 2)?.state, "open");
    const blocked = claim("returned");
    world.finish(blocked.run, {
      outcome: "failed",
      session: "app-session",
      sessionBlocked: true,
      error: "原会话仍被占用",
    });
    assert.equal(world.view.get("runs", blocked.run)?.session_blocked, true);
    world.call("ingest", "app", { id: "while-blocked", type: "one", subject: issue.subject });
    assert.equal(claim("blocked"), null);
    assert.throws(() => world.call("retrySession", blocked.run, { note: "长".repeat(501) }), /500/);
    world.call("retrySession", blocked.run, { note: "先核对测试分支" });
    const continued = claim("retry");
    assert.equal(continued.run, blocked.run);
    assert.equal(continued.session, "app-session");
    assert.deepEqual(
      continued.context.open.map(({ card }: { card: number }) => card),
      [1, 2],
    );
    assert.deepEqual(
      continued.context.events
        .filter(({ type }: { type: string }) => type !== "session.retry")
        .map(({ id, detail }: { id: string; detail: string }) => [id, detail]),
      [
        ["while-in-app", ""],
        [`app-handoff:${handoff}`, "已复现，请核对日志"],
        ["while-blocked", ""],
      ],
    );
    assert.match(
      continued.context.events.find(({ type }: { type: string }) => type === "session.retry")?.detail ?? "",
      /先核对测试分支/,
    );
    world.finish(continued.run, {
      outcome: "done",
      resolve: [{ card: 1, reason: "已根据桌面操作结果核实复现" }],
      ask: [{ key: "logs", title: "确认日志时段", text: "请选择", options: ["上午", "下午"] }],
    });
    assert.equal(world.view.get("cards", 1)?.state, "closed");
    assert.equal(world.view.get("cards", 2)?.state, "open");
    assert.equal(world.view.get("cards", 3)?.state, "open");
    world.call("retrySession", continued.run, { note: "继续核对验收结果" });
    assert.throws(() => world.call("retrySession", continued.run), /还有未结束/);
    const latestRetry = claim("retry-latest");
    assert.notEqual(latestRetry.run, continued.run);
    assert.equal(latestRetry.session, "app-session");
    assert.match(latestRetry.context.events[0].detail, /继续核对验收结果/);
    assert.deepEqual(
      latestRetry.context.events.map(({ type }: { type: string }) => type),
      ["session.retry"],
    );
    world.call("started", latestRetry.run, latestRetry.token, {
      session: "app-session",
      link: "codex://threads/app-session",
    });
    world.finish(latestRetry.run, { outcome: "done", session: "app-session" });
    update("app-handoff", { run: latestRetry.run });
    const debugHandoff = world.view.get("config", key)?.appHandoff.id;
    const previousRecords = world.view.get("config", key)?.localRecords;
    update("app-return", { handoff: debugHandoff, records: [] });
    const sessionOnly = claim("session-only");
    assert.equal(sessionOnly.session, "app-session");
    assert.match(sessionOnly.context.events[0].detail, /直接续接原会话/);
    assert.deepEqual(world.view.get("config", key)?.localRecords, previousRecords);
  } finally {
    world.view.close();
  }
});

test("a comment queued during execution resumes the finished session after replay", () => {
  const world = new World();
  const config = {
    sources: { app: { name: "任务" } },
    agents: { dev: { name: "开发", worker: "w1", use: "codex", access: "edit" } },
    rules: [
      {
        name: "开发",
        when: { source: "app", types: ["task.created", "task.comment"] },
        to: "dev",
        cwd: "/work",
        prompt: "处理",
        parallel: 2,
        planApproval: true,
        resumeOn: ["task.comment"],
      },
    ],
  };
  const load = () => world.call("rules", parseRules(JSON.stringify(config), 0, "UTC"));
  const event = (id: string, type: string, subject: string) => world.call("ingest", "app", { id, type, subject });
  const claim = (id: string, worker = "w1") => world.call("claimNext", worker, id);
  try {
    load();
    event("created", "task.created", "issue-1");
    assert.throws(
      () => world.call("issueDisposition", { rule: "开发", subject: "issue-1", action: "close", reason: "提前结案" }),
      /暂不能结案/,
    );
    const first = claim("first");
    assert.equal(first.session, null);
    event("comment", "task.comment", "issue-1");
    assert.equal(claim("too-early"), null);
    world.finish(first.run, { outcome: "done", session: "first-session" });
    world.restart();
    const continued = claim("continued");
    assert.equal(continued.session, "first-session");
    assert.equal(continued.agent.access, "read");
    assert.equal(continued.context.approvedPlan, undefined);
    assert.equal(claim("continued").session, "first-session");
    world.finish(continued.run, { outcome: "done", session: "latest-session" });

    const issue = { rule: "开发", subject: "issue-1" };
    const issueKey = `issue:${JSON.stringify([issue.rule, issue.subject])}`;
    world.call("issueDisposition", { ...issue, action: "testing" });
    assert.equal(world.view.get("config", issueKey)?.stage, "testing");
    assert.equal(event("comment", "task.comment", "issue-1").duplicate, true);
    assert.equal(world.view.get("config", issueKey)?.stage, "testing");
    world.call("issueDisposition", { ...issue, action: "archive" });
    world.call("issueDisposition", { ...issue, action: "close", reason: "人工验收完成" });
    world.restart();
    assert.deepEqual(event("closed-comment", "task.comment", "issue-1").routed, ["开发"]);
    assert.equal(claim("closed"), null);
    world.call("issueDisposition", { ...issue, action: "reopen" });
    world.call("issueDisposition", { ...issue, action: "restore" });
    assert.equal(event("closed-comment", "task.comment", "issue-1").duplicate, true);
    assert.equal(claim("after-reopen"), null);
    event("other", "task.comment", "issue-2");
    const other = claim("other");
    assert.equal(other.session, null);
    world.finish(other.run, { outcome: "done", session: "other-session" });
    world.call("issueDisposition", { ...issue, action: "testing" });
    event("followup", "task.comment", "issue-1");
    assert.equal(world.view.get("config", issueKey)?.stage, null);
    const followup = claim("followup");
    assert.equal(followup.session, "latest-session");
    assert.deepEqual(followup.context.previousSessions, ["first-session", "latest-session"]);
    world.finish(followup.run, { outcome: "done", session: "latest-session" });

    config.agents.dev.worker = "w2";
    load();
    event("moved", "task.comment", "issue-1");
    assert.equal(claim("moved", "w2").session, null);
  } finally {
    world.view.close();
  }
});
