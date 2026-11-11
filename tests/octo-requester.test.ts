// Private queries must preserve ownership, and group queries must expose only tracked progress.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  clarificationNotification,
  milestoneNotification,
  notification,
  rememberObservedRequester,
  requesterIssues,
  requesterProgress,
  startNotification,
} from "../plugins/octo/requester.ts";

test("milestone notices identify the verified requester and deduplicate by stage and feedback cycle", async () => {
  using db = new DatabaseSync(":memory:");
  const issue = { id: "uuid", workspace: "report", label: "DEMO-256", title: "调整日报导出", cycle: 1 };
  rememberObservedRequester(db, { workspace: issue.workspace, issue: issue.id, sender: "creator" });
  const route = { intakeChannel: "intake", requesterChannel: "notify" };
  const notice = milestoneNotification(db, issue, "test", route, "https://example.test/");
  assert.equal(notice.sender, "creator");
  assert.match(notice.text, /可以开始测试[\s\S]+测试地址/);
  assert.match(notice.text, /Issue 标题：调整日报导出/);
  let sends = 0;
  const send = async () => String(++sends);
  assert.equal(await notice.send(send), "1");
  assert.equal(await notice.send(send), "1");
  const release = milestoneNotification(db, issue, "release", route);
  assert.match(release.text, /需求已上线/);
  assert.match(release.text, /Issue 标题：调整日报导出/);
  assert.equal(await release.send(send), "2");
  assert.equal(await milestoneNotification(db, { ...issue, cycle: 2 }, "test", route).send(send), "3");
});

test("a direct Octo Issue uses its verified creator without masquerading as a Bot submission", async () => {
  using intake = new DatabaseSync(":memory:");
  using hub = new DatabaseSync(":memory:");
  hub.exec("CREATE TABLE projections (collection TEXT, data TEXT)");
  const record = { workspace: "report", issue: "task-1", sender: "creator", identifier: "DEMO-255" };
  rememberObservedRequester(intake, record);
  assert.throws(() => rememberObservedRequester(intake, { ...record, sender: "other" }));
  assert.equal(requesterProgress(intake, hub, "report", "other", "DEMO-255"), undefined);
  assert.equal(requesterProgress(intake, hub, "report", "creator", "DEMO-255")?.label, "DEMO-255");
  assert.deepEqual(requesterIssues(intake, hub, "report", "creator"), []);
  const notice = startNotification(
    intake,
    record.issue,
    { intakeChannel: "input", requesterChannel: "output" },
    record.identifier,
    undefined,
    record.sender,
  );
  assert.equal(notice?.sender, record.sender);
});
import { requesterCard, requesterMention } from "../plugins/octo/requester-delivery.ts";
import { readTestDeliveryProfile } from "../plugins/octo/test-delivery-profile.ts";
import { fileURLToPath } from "node:url";

test("clarification and test-ready cards expose only the actions appropriate to each node", async () => {
  using db = new DatabaseSync(":memory:");
  const pending = clarificationNotification(db, "issue-1", "DEMO-246", "requester");
  const card = requesterCard(pending.text);
  assert.match(card.plain, /暂未安排 Agent/);
  assert.match(card.plain, /项目：规则别名/);
  assert.match(card.plain, /下一轮定时采集/);
  assert.deepEqual(card.card.actions, []);
  let sends = 0;
  const send = async () => {
    sends++;
    return "ref";
  };
  await pending.send(send);
  await pending.send(send);
  assert.equal(sends, 1);
  const profile = readTestDeliveryProfile(fileURLToPath(new URL("../examples/test-delivery.json", import.meta.url)));
  const ready = requesterCard(`DEMO-246 · 可以开始测试\n测试地址：${profile.testUrl}`);
  assert.deepEqual(ready.card.actions, [{ type: "Action.OpenUrl", title: "打开测试环境", url: profile.testUrl }]);
  assert.deepEqual(requesterCard("准备提测\n测试地址：javascript:alert(1)").card.actions, []);
});

test("one Issue reports its independently routed project states", () => {
  using hub = new DatabaseSync(":memory:");
  hub.exec("CREATE TABLE projections (collection TEXT, data TEXT)");
  const put = hub.prepare("INSERT INTO projections VALUES (?,?)");
  const subject = "loop:report:task-1";
  for (const [id, rule, state] of [
    [1, "REPORT", "done"],
    [2, "SYNC", "claimed"],
  ] as const) {
    put.run(
      "events",
      JSON.stringify({
        id,
        subject,
        type: "task.created",
        source: "octo-issue",
        summary: "DEMO-246 issue",
        routed: JSON.stringify([rule]),
      }),
    );
    put.run("runs", JSON.stringify({ id, rule, lane: subject, state }));
  }
  put.run("config", JSON.stringify({ rule: "REPORT", subject, closed: true }));
  const result = requesterProgress(undefined, hub, "report", "requester", "DEMO-246", undefined, false, true);
  assert.equal(result?.publicState, "2 个项目");
  assert.deepEqual(
    result?.projects?.map(({ rule, state }) => [rule, state]),
    [
      ["REPORT", "已结案"],
      ["SYNC", "进行中"],
    ],
  );
});

test("the progress timeline uses recorded event times and omits internal text", () => {
  using intake = new DatabaseSync(":memory:");
  using hub = new DatabaseSync(":memory:");
  intake.exec(`CREATE TABLE octo_intake (issue TEXT, sender TEXT, state TEXT, url TEXT, identifier TEXT);
    INSERT INTO octo_intake VALUES ('task-1','requester','created',NULL,'DEMO-246')`);
  hub.exec("CREATE TABLE projections (collection TEXT, data TEXT)");
  const put = hub.prepare("INSERT INTO projections VALUES (?,?)");
  const subject = "loop:report:task-1";
  put.run(
    "events",
    JSON.stringify({
      id: 1,
      source: "octo-issue",
      type: "task.created",
      subject,
      summary: "DEMO-246 issue",
      received_at: "2026-11-09T01:00:00Z",
      detail: "sensitive",
    }),
  );
  put.run(
    "events",
    JSON.stringify({
      id: 2,
      source: "octo-issue",
      type: "task.comment",
      subject,
      received_at: "2026-11-09T01:02:00Z",
      detail: "private comment",
    }),
  );
  put.run(
    "runs",
    JSON.stringify({
      id: 1,
      lane: subject,
      state: "done",
      created_at: "2026-11-09T01:01:00Z",
      claimed_at: "2026-11-09T01:01:30Z",
      finished_at: "2026-11-09T01:03:00Z",
      summary: "internal log",
    }),
  );
  const result = requesterProgress(intake, hub, "report", "requester", "DEMO-246", undefined, true);
  assert.deepEqual(
    result?.timeline?.map((x) => x.state),
    ["Issue 已采集", "已入队", "运行中", "收到 Issue 评论", "执行轮次已完成"],
  );
  assert.equal(result?.timeline?.[2].at, "2026-11-09T01:01:30Z");
  assert.doesNotMatch(JSON.stringify(result), /sensitive|private comment|internal log/);
  const summary = requesterProgress(intake, hub, "report", "requester", "DEMO-246");
  assert.equal(summary?.publicState, "待跟进");
  assert.equal(summary?.receivedAt, "2026-11-09T01:00:00Z");
  assert.equal(summary?.timeline, undefined);
  assert.equal(requesterProgress(intake, hub, "report", "other", "DEMO-246"), undefined);
  assert.deepEqual(requesterProgress(undefined, hub, "report", "other", "DEMO-246", undefined, true, true), result);
  assert.equal(requesterProgress(undefined, hub, "other", "other", "DEMO-246", undefined, true, true), undefined);
});

test("a requester card can request progress without a fabricated Issue link", () => {
  const command = "@issue-dispatcher /查进度 DEMO-253";
  const card = requesterCard(
    `Issue DEMO-253 · 任务已开始\n需求已进入处理流程，当前可能还在排队。\n查进度请在群或子区发送 ${command}`,
  );
  assert.equal(card.type, 17);
  assert.ok(!("mention" in card));
  assert.deepEqual(card.card.actions, [
    { type: "Action.Submit", id: "autoloop-progress-DEMO-253", title: "查进度", data: {} },
  ]);
  assert.equal(card.profile, "octo/v2");
  assert.match(card.plain, /@issue-dispatcher \/help/);
  assert.match(card.plain, /DEMO-253.*任务已开始/);
  assert.ok(!JSON.stringify(card).includes("Action.OpenUrl"));
});

test("a supplied Octo Issue address becomes a separate navigation button", () => {
  const url = "https://octo.example.invalid/fleet/demo-workspace/issues/DEMO-254";
  const card = requesterCard(
    `Issue DEMO-254 · 任务已开始\n${url}\n查进度请在群或子区发送 @issue-dispatcher /查进度 DEMO-254`,
  );
  assert.deepEqual(card.card.actions[0], { type: "Action.OpenUrl", title: "查看 Issue", url });
});

test("the text reminder mentions only the requester and replies to the exact card", () => {
  const ref = "1000000000000000004";
  assert.deepEqual(requesterMention(ref, "请查看 DEMO-253", "requester-uid", "演示员"), {
    type: 1,
    content: "@演示员 请查看 DEMO-253",
    mention: { uids: ["requester-uid"], entities: [{ uid: "requester-uid", offset: 0, length: 4 }] },
    reply: { message_id: ref },
  });
});

test("a start notice goes once to the verified original requester in the configured notice thread", async () => {
  using db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE octo_intake (issue TEXT, sender TEXT, state TEXT, url TEXT, channel TEXT);
    INSERT INTO octo_intake VALUES ('task-1', 'person-1', 'created', NULL, 'intake-thread')`);
  const route = { intakeChannel: "intake-thread", requesterChannel: "notice-thread" };
  assert.equal(startNotification(db, "task-1", { ...route, intakeChannel: "other-thread" }, "DEMO-12"), undefined);
  assert.equal(startNotification(db, "unknown-task", route, "DEMO-12"), undefined);
  const link = "https://example.invalid/issues/DEMO-12";
  const notice = startNotification(db, "task-1", route, "DEMO-12", link, undefined, "核对报表字段")!;
  let sends = 0;
  const send = async (channel: string, text: string, uid: string) => {
    sends++;
    assert.equal(channel, "notice-thread");
    assert.equal(uid, "person-1");
    assert.match(text, /Issue DEMO-12.*已入队/);
    assert.match(text, /Issue 标题：核对报表字段/);
    assert.doesNotMatch(text, /任务已开始|运行中/);
    assert.ok(text.includes(link));
    assert.match(text, /查进度命令：\/查进度 DEMO-12/);
    return "msg-1";
  };
  assert.equal(await notice.send(send), "msg-1");
  assert.equal(await notice.send(send), "msg-1");
  assert.equal(sends, 1);
  const review = notification(db, "task-1", "review", route);
  assert.equal(review.channel, "notice-thread");
  assert.equal(review.sender, "person-1");
});

test("requester sees an aggregate state without Hub internals and confirms a private return channel", () => {
  using intake = new DatabaseSync(":memory:");
  using hub = new DatabaseSync(":memory:");
  intake.exec(`CREATE TABLE octo_intake (issue TEXT, sender TEXT, state TEXT, url TEXT);
    INSERT INTO octo_intake VALUES ('task-1', 'person-1', 'created', NULL)`);
  hub.exec(`CREATE TABLE projections (collection TEXT, data TEXT);
    INSERT INTO projections VALUES ('events','{"source":"octo-issue","type":"task.report.created","subject":"loop:report:task-1","summary":"DEMO-12 confidential"}');
    INSERT INTO projections VALUES ('runs','{"lane":"loop:report:task-1","state":"queued"}');
    INSERT INTO projections VALUES ('cards','{"lane":"loop:report:task-1","state":"open","kind":"ask","text":"secret"}')`);
  assert.equal(requesterProgress(intake, hub, "report", "person-2", "DEMO-12", "dm-2"), undefined);
  assert.deepEqual(requesterProgress(intake, hub, "report", "person-1", "DEMO-12", "dm-1"), {
    label: "DEMO-12",
    state: "等待负责人确认",
    publicState: "排队中",
    receivedAt: undefined,
    url: undefined,
  });
  const history = requesterProgress(intake, hub, "report", "person-1", "DEMO-12", undefined, true);
  assert.equal(history?.timeline?.length, 1);
  assert.equal(history?.timeline?.[0].state, "排队中");
  assert.ok(!JSON.stringify(history).includes("secret"));
  assert.equal(requesterProgress(intake, hub, "report", "person-2", "DEMO-12", undefined, true), undefined);
  assert.deepEqual(requesterIssues(intake, hub, "report", "person-1"), [{ label: "DEMO-12", state: "排队中" }]);
  assert.deepEqual(requesterIssues(intake, hub, "report", "person-2"), []);
  assert.equal(notification(intake, "task-1", "review").channel, "dm-1");
});

test("a notification is claimed before delivery and repeated sends do not post again", async () => {
  using db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE octo_intake (issue TEXT, sender TEXT, state TEXT, url TEXT);
    INSERT INTO octo_intake VALUES ('task-1', 'person-1', 'created', NULL);
    CREATE TABLE octo_requester_dm (sender TEXT PRIMARY KEY, channel TEXT NOT NULL);
    INSERT INTO octo_requester_dm VALUES ('person-1', 'dm-1')`);
  const notice = notification(db, "task-1", "review");
  let calls = 0;
  const lost = async () => {
    calls++;
    throw new Error("lost response");
  };
  await assert.rejects(notice.send(lost), /核对/);
  await assert.rejects(notice.send(lost), /核对/);
  assert.equal(calls, 1);
});

test("my issues shows the original assignee and separates requests outside Hub tracking", () => {
  using intake = new DatabaseSync(":memory:");
  using hub = new DatabaseSync(":memory:");
  intake.exec(`CREATE TABLE octo_intake (issue TEXT, sender TEXT, state TEXT, url TEXT, identifier TEXT, assignee_uid TEXT, assignee_name TEXT);
    INSERT INTO octo_intake VALUES ('task-2', 'person-1', 'created', NULL, 'DEMO-20', 'other', '示例处理人')`);
  hub.exec("CREATE TABLE projections (collection TEXT, data TEXT)");
  assert.deepEqual(requesterIssues(intake, hub, "report", "person-1", "tracked"), [
    { label: "DEMO-20", state: "暂无 Hub 进度（提交时指派给其他人）", assignee: "示例处理人" },
  ]);
  assert.equal(requesterProgress(intake, hub, "report", "person-1", "DEMO-20")?.label, "DEMO-20");
});
