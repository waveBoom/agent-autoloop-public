// Stale approvals must not queue work, and a comment between approval and claim must keep development read-only.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHandler } from "../kernel/http.ts";
import { digest } from "../kernel/credentials.ts";
import { environment, World } from "../sim/world.ts";

test("Full Access preserves the plan gate while using the configured runtime permissions", () => {
  const world = new World();
  try {
    world.call(
      "rules",
      parseRules(
        JSON.stringify({
          sources: { app: { name: "来源" } },
          agents: { dev: { name: "开发", worker: "w1", use: "codex", access: "full" } },
          rules: [
            {
              name: "开发",
              when: { source: "app", types: ["task.created"] },
              to: "dev",
              cwd: "/work",
              prompt: "处理",
              parallel: 1,
              planApproval: true,
            },
          ],
        }),
        0,
        "UTC",
      ),
    );
    world.call("ingest", "app", { id: "created", type: "task.created", subject: "issue-1" });
    const planning = world.call("claimNext", "w1", "planning");
    assert.equal(planning.agent.access, "full");
    assert.equal(planning.context.approvedPlan, undefined);
    world.finish(planning.run, {
      outcome: "done",
      ask: [{ key: "development-plan", title: "方案", text: "修改入口", options: ["确认方案和范围", "退回修改"] }],
    });
    world.call("answer", 1, { by: "本人", choice: 0 });
    const coding = world.call("claimNext", "w1", "coding");
    assert.equal(coding.agent.access, "full");
    assert.equal(coding.context.approvedPlan, "修改入口");
  } finally {
    world.view.close();
  }
});

test("Octo business stages require deployment, confirmation and a notification receipt", async () => {
  const world = new World();
  const subject = "loop:report:task-1";
  const rule = "开发";
  const key = `issue:${JSON.stringify([rule, subject])}`;
  const stage = () => world.view.get("config", key);
  const record = (action: string, detail = {}) => world.call("issueDisposition", { rule, subject, action, ...detail });
  const event = (id: string, type: string) =>
    world.call("ingest", "app", { id, type, subject, summary: "DEMO-1 示例任务" });
  const start = (id: string) => {
    const job = world.call("claimNext", "w1", id);
    world.call("started", job.run, job.token, {});
    return job.run;
  };
  try {
    world.call(
      "rules",
      parseRules(
        JSON.stringify({
          sources: { app: { name: "来源" } },
          agents: { dev: { name: "开发", worker: "w1", use: "codex", access: "edit" } },
          rules: [
            {
              name: rule,
              when: { source: "app", types: ["task.created", "task.comment"] },
              to: "dev",
              cwd: "/work",
              prompt: "处理",
              parallel: 1,
              planApproval: true,
            },
          ],
        }),
        0,
        "UTC",
      ),
    );
    event("created", "task.created");
    assert.equal(stage()?.stage, "accepted");
    record("set-display-status", { status: "released" });
    record("add-progress", { reason: "正在重跑报告" });
    record("edit-progress", { index: 0, expectedText: "正在重跑报告", expectedEditedAt: null, reason: "报告重跑完成" });
    assert.throws(
      () =>
        record("edit-progress", {
          index: 0,
          expectedText: "正在重跑报告",
          expectedEditedAt: null,
          reason: "旧页面提交",
        }),
      /进展已更新/,
    );
    assert.equal(stage()?.stage, "accepted");
    assert.equal(stage()?.manualStatus.label, "已上线");
    const planning = start("planning");
    assert.equal(stage()?.stage, "planning");
    assert.equal(stage()?.manualStatus, null);
    assert.equal(stage()?.manualStatusHistory[0].label, "已上线");
    assert.equal(stage()?.progressNotes[0].text, "报告重跑完成");
    world.finish(planning, {
      outcome: "done",
      ask: [{ key: "development-plan", title: "方案", text: "修改入口", options: ["确认方案和范围", "退回修改"] }],
    });
    assert.equal(stage()?.stage, "plan_review");
    world.call("answer", 1, { by: "本人", choice: 0 });
    const coding = start("coding");
    assert.equal(stage()?.stage, "coding");
    world.finish(coding, { outcome: "done", testBranchesPushed: ["developcustom"] });
    assert.equal(stage()?.stageLabel, "测试分支已推送: developcustom");
    record("deployed", { version: "build-1", environment: "QA", reason: "已自测，运行版本一致" });
    const review = stage()?.reviewCard;
    assert.equal(stage()?.stage, "deployed");
    assert.throws(() => record("test-notified", { receipt: "123", expectedStageAt: stage()?.stageAt }), /阶段已变化/);
    assert.throws(() => world.call("answer", review, { by: "本人", choice: 1 }), /修改意见/);
    assert.throws(() => world.call("answer", review, { by: "链接", choice: 0 }), /负责人/);
    const notifications: string[][] = [];
    const token = "test-owner";
    world.call("key", "owner", "test-owner", digest(token));
    const handle = createHandler({
      now: () => world.now,
      view: () => world.view,
      environment,
      commit: "test",
      dispatch: (type, args) => world.call(type, ...args),
      state: () => null,
      why: () => null,
      card: () => undefined,
      wait: async () => {},
      stream: () => new ReadableStream(),
      adapt: async () => [],
      notifyApprovedTest: (...notification) => {
        notifications.push(notification);
      },
    });
    const submit = () =>
      handle(
        new Request(`http://localhost/v1/cards/${review}/answer`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body: JSON.stringify({ choice: 0 }),
        }),
      );
    assert.deepEqual(await (await submit()).json(), { changed: true, state: "closed", notificationQueued: true });
    assert.deepEqual(await (await submit()).json(), { changed: false, state: "closed" });
    assert.equal(stage()?.stage, "test_approved");
    assert.deepEqual(notifications, [["DEMO-1", stage()?.stageAt, rule]]);
    record("test-notified", { receipt: "123", expectedStageAt: stage()?.stageAt });
    world.restart();
    assert.equal(stage()?.stageLabel, "已提测");
    event("feedback", "task.comment");
    assert.equal(stage()?.stage, "accepted");
    assert.throws(() => record("test-notified", { receipt: "123", expectedStageAt: stage()?.stageAt }), /仍在运行/);
    world.finish(start("feedback"));
    record("coded", { reason: "第二版提交已核验" });
    record("deployed", { version: "build-2", environment: "QA", reason: "第二版已部署" });
    const returned = stage()?.reviewCard;
    world.call("answer", returned, { by: "本人", choice: 1, text: "补一个边界用例" });
    assert.equal(stage()?.stage, "accepted");
    assert.equal(world.view.get("cards", returned)?.answer, "补一个边界用例");
    const resumed = world.call("claimNext", "w1", "returned");
    assert.equal(resumed.agent.access, "read");
    assert.equal(resumed.context.approvedPlan, undefined);
    assert.equal(resumed.context.continuity.previousPlan.card, 1);
    assert.equal(resumed.context.continuity.previousPlan.text, "修改入口");
    assert.equal(resumed.context.continuity.originalIssue.summary, "DEMO-1 示例任务");
  } finally {
    world.view.close();
  }
});
import { parseRules } from "../protocol/rules.ts";

test("only an owner's approval of the current plan enables editing for its continuation", () => {
  const world = new World();
  try {
    world.call(
      "rules",
      parseRules(
        JSON.stringify({
          sources: { app: { name: "任务" } },
          agents: { dev: { name: "开发", worker: "w1", use: "codex", access: "edit" } },
          channels: {
            octo: { name: "交互审批", planApprovals: true, answerers: ["owner-uid"] },
            other: { name: "其他通道", answerers: ["owner-uid"] },
          },
          rules: [
            {
              name: "开发",
              when: { source: "app", types: ["task.created", "task.comment"] },
              to: "dev",
              cwd: "/work",
              prompt: "处理",
              parallel: 1,
              planApproval: true,
              prepareWorktrees: true,
              repositories: { web: { path: "/code/web", baseBranch: "main" } },
              resumeOn: ["task.comment"],
            },
          ],
        }),
        0,
        "UTC",
      ),
    );
    const issueLink = "https://example.invalid/issues/issue-1";
    const event = (id: string, type: string) =>
      world.call("ingest", "app", {
        id,
        type,
        subject: "issue-1",
        ...(type === "task.created" && { link: issueLink }),
      });
    const propose = (claim: string) => {
      const job = world.call("claimNext", "w1", claim);
      assert.equal(job.agent.access, "read");
      world.finish(job.run, {
        outcome: "done",
        session: "plan-session",
        ask: [
          {
            key: "development-plan",
            title: "开发方案",
            text: "范围：web 导出接口。验证：回归导出。",
            repositories: ["web"],
            options: ["确认方案和范围", "退回修改"],
          },
        ],
      });
      return job;
    };
    event("one", "task.created");
    propose("first");
    assert.throws(() => world.call("answer", 1, { choice: 0, by: "链接" }), /本人/);
    const click = { choice: 0, channel: "octo", by: "owner-uid", ref: "octo-1" };
    world.call("delivered", "octo", 1, 1, click.ref);
    event("two", "task.comment");
    const before = world.log.length;
    assert.throws(() => world.call("answer", 1, { choice: 0, by: "本人" }), /方案已过期/);
    assert.throws(() => world.call("answer", 1, click), /方案已过期/);
    assert.equal(world.log.length, before);
    assert.equal(world.view.get("cards", 1)?.state, "open");
    propose("second");
    const card = world.call("nextCard", "octo");
    assert.equal(card.planApproval, true);
    assert.equal(card.sourceLink, issueLink);
    const fresh = { ...click, ref: "octo-2", text: "请补一个空列表用例" };
    world.call("delivered", "octo", 2, 1, fresh.ref);
    world.call("delivered", "other", 2, 1, fresh.ref);
    assert.throws(() => world.call("answer", 2, { ...fresh, by: "someone-else" }), /不能回答/);
    assert.throws(() => world.call("answer", 2, { ...fresh, ref: click.ref }), /不是发出去/);
    assert.throws(() => world.call("answer", 2, { ...fresh, channel: "other" }), /本人/);
    assert.equal(world.call("answer", 2, fresh).changed, true);
    assert.equal(world.call("answer", 2, fresh).changed, false);
    const approved = world.call("claimNext", "w1", "third");
    assert.equal(approved.agent.access, "edit");
    assert.equal(approved.session, "plan-session");
    assert.match(approved.context.approvedPlan, /准备这些仓库的任务 worktree：web/);
    assert.equal(approved.context.answers[0].text, fresh.text);
    assert.ok(!approved.context.approvedPlan.includes(fresh.text));
    assert.deepEqual(approved.context.approvedRepositories, ["web"]);
    assert.equal(approved.context.issueSubject, "issue-1");
    world.finish(approved.run, { outcome: "done", session: "development-session" });
    event("three", "task.comment");
    assert.equal(propose("fourth").session, "development-session");
    world.call("answer", 3, { choice: 0, by: "本人" });
    event("four", "task.comment");
    const followup = world.call("claimNext", "w1", "fifth");
    assert.equal(followup.agent.access, "read");
    assert.equal(followup.context.approvedPlan, undefined);
  } finally {
    world.view.close();
  }
});
