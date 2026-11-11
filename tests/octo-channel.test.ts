// Prevent false delivery receipts, duplicate messages on card updates, and misleading approval instructions.
import assert from "node:assert/strict";
import test from "node:test";
import { deliver } from "../plugins/octo/channel.ts";
import { approvalPayload, listenForApprovals, readClick } from "../plugins/octo/approval.ts";

const settings = {
  endpoint: "https://octo.example/api/v1/bot/sendMessage",
  token: "test-bot-token",
  channelId: "group____thread",
  channelType: 5,
  answerCommand: "node /example/bin/agent-autoloop.ts answer",
};
const card = {
  id: 42,
  version: 1,
  ref: null,
  kind: "ask",
  state: "open",
  title: "SYNC：审核方案",
  text: "本轮只读。\n修改范围：API。",
  options: ["确认方案和范围", "退回修改"],
};
const signal = new AbortController().signal;

test("approval clicks must match the configured human, conversation and exact message", () => {
  const payload = approvalPayload(card);
  assert.equal(payload.type, 17);
  assert.equal(payload.profile, "octo/v2");
  assert.ok(
    payload.card.body.some((item) => item.type === "Input.Text" && "id" in item && item.id === "approval-note"),
  );
  const [approve] = payload.card.actions;
  assert(approve && "id" in approve);
  const event = {
    event_type: "card_action",
    event_data: {
      action_id: approve.id,
      message_id: "1000000000000000001",
      channel_id: settings.channelId,
      channel_type: settings.channelType,
      operator_uid: "owner",
    },
  };
  const scope = { ...settings, approver: "owner" };
  assert.deepEqual(readClick(event, scope), { card: 42, choice: 0, ref: "1000000000000000001", by: "owner" });
  const withNote = (note: unknown) => ({
    ...event,
    event_data: { ...event.event_data, inputs: { "approval-note": note } },
  });
  assert.equal(readClick(withNote("  请补一个空列表用例  "), scope)?.text, "请补一个空列表用例");
  assert.deepEqual(readClick(withNote("  "), scope), readClick(event, scope));
  for (const invalid of [
    { operator_uid: "other" },
    { channel_id: "other____thread" },
    { channel_type: 2 },
    { message_id: 1000000000000000001 },
    { action_id: "autoloop-42-8" },
    { inputs: { "approval-note": 123 } },
    { inputs: { "approval-note": "字".repeat(1001) } },
  ]) {
    assert.equal(readClick({ ...event, event_data: { ...event.event_data, ...invalid } }, scope), null);
  }
  assert.equal(readClick({ ...event, event_type: "message" }, scope), null);
});

test("the source Issue opens independently of approval and remains available after the decision", () => {
  const sourceLink = "https://example.invalid/issues/42";
  for (const state of ["open", "decided"]) {
    const actions = approvalPayload({ ...card, sourceLink, state }).card.actions;
    assert.deepEqual(
      actions.find((item) => item.type === "Action.OpenUrl"),
      {
        type: "Action.OpenUrl",
        title: "查看 Issue",
        url: sourceLink,
      },
    );
    assert.equal(actions.filter((item) => item.type === "Action.Submit").length, state === "open" ? 2 : 0);
  }
  assert.equal(
    approvalPayload({ ...card, sourceLink: "javascript:alert(1)" }).card.actions.some(
      (item) => item.type === "Action.OpenUrl",
    ),
    false,
  );
});

test("a valid click is acknowledged only after Hub accepts it, with exact Octo IDs", async (t) => {
  const stop = new AbortController();
  const scope = { ...settings, approver: "owner" };
  const handled: number[] = [];
  const event = (uid: string, id: string) =>
    `{"event_type":"card_action","event_id":${id},"event_data":${JSON.stringify({
      action_id: "autoloop-42-0",
      channel_id: settings.channelId,
      channel_type: settings.channelType,
      operator_uid: uid,
      inputs: { "approval-note": "请补一个空列表用例" },
    }).replace(/}$/, ',"message_id":1000000000000000001}')}}`;
  const request = t.mock.method(globalThis, "fetch", async (url: string) => {
    if (url.endsWith("/events")) {
      return new Response(
        `{"results":[${event("other", "1000000000000000002")},${event("owner", "1000000000000000003")}]}`,
      );
    }
    assert.equal(url, "https://octo.example/api/v1/bot/events/1000000000000000003/ack");
    assert.deepEqual(handled, [42]);
    stop.abort();
    return new Response(null, { status: 204 });
  });
  await listenForApprovals(
    scope,
    async (click) => {
      assert.equal(click.ref, "1000000000000000001");
      assert.equal(click.by, "owner");
      assert.equal(click.text, "请补一个空列表用例");
      handled.push(click.card);
      return true;
    },
    (line) => assert.fail(line),
    stop.signal,
  );
  assert.equal(request.mock.callCount(), 2);
});

test("Octo displays the Issue and next step without putting terminal commands in the message body", async (t) => {
  const request = t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(url, settings.endpoint);
    assert.equal(init.redirect, "error");
    assert.deepEqual(init.headers, { authorization: "Bearer test-bot-token", "content-type": "application/json" });
    const body = JSON.parse(String(init.body));
    assert.equal(body.channel_id, settings.channelId);
    assert.equal(body.channel_type, 5);
    assert.equal(body.payload.type, 17);
    assert.match(body.payload.plain, /DEMO-246 · 待补资料或回复/);
    assert.match(body.payload.plain, /本轮只读。\n修改范围：API。/);
    assert.match(body.payload.plain, /在原 Issue DEMO-246 留评论/);
    assert.doesNotMatch(body.payload.plain, /node \/example/);
    assert.equal(body.payload.card.actions[0].text, "node /example/bin/agent-autoloop.ts answer 42 1");
    return new Response('{"message_id":1000000000000000001}');
  });
  assert.equal(await deliver({ ...card, sourceTitle: "DEMO-246 下载异常" }, settings, signal), "1000000000000000001");
  assert.equal(
    await deliver({ ...card, ref: "1000000000000000001", version: 2 }, settings, signal),
    "1000000000000000001",
  );
  assert.equal(request.mock.callCount(), 1);
});

test("ordinary questions offer native replies and accept the fifth option with a note", async (t) => {
  const question = { ...card, title: "补充情况", options: ["已恢复", "尚未恢复", "选项三", "选项四", "选项五"] };
  const scope = { ...settings, approver: "owner" };
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    const { payload } = JSON.parse(String(init.body));
    assert.match(payload.plain, /待补资料或回复/);
    assert.ok(payload.card.body.some((item: { type: string }) => item.type === "Input.Text"));
    const action = payload.card.actions[4];
    assert.equal(action.type, "Action.Submit");
    assert.deepEqual(
      readClick(
        {
          event_type: "card_action",
          event_data: {
            operator_uid: "owner",
            channel_id: settings.channelId,
            channel_type: 5,
            message_id: "123",
            action_id: action.id,
            inputs: { "approval-note": "数据库还未恢复" },
          },
        },
        scope,
      ),
      { card: 42, choice: 4, ref: "123", by: "owner", text: "数据库还未恢复" },
    );
    return new Response('{"message_id":123}');
  });
  assert.equal(await deliver(question, scope, signal), "native:123");
});

test("Octo errors and HTTP success without a receipt do not count as delivery", async (t) => {
  const request = t.mock.method(
    globalThis,
    "fetch",
    async () => new Response('{"error":"sensitive"}', { status: 403 }),
  );
  await assert.rejects(deliver(card, settings, signal), /^Error: Octo 发送失败（HTTP 403）$/);
  request.mock.mockImplementation(async () => new Response('{"error":"sensitive"}'));
  await assert.rejects(deliver(card, settings, signal), /^Error: Octo 未返回有效的消息编号$/);
});

test("Octo edits the original approval message to remove controls after a decision", async (t) => {
  const messageId = "1000000000000000001";
  const ref = `native:${messageId}`;
  const request = t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(url, "https://octo.example/api/v1/bot/message/edit");
    const body = JSON.parse(String(init.body));
    assert.equal(body.message_id, messageId);
    assert.equal(body.channel_id, settings.channelId);
    assert.equal(body.channel_type, settings.channelType);
    const frame = JSON.parse(body.content_edit);
    assert.equal(frame.card_seq, 2);
    assert.equal(frame.type, 17);
    assert.equal(frame.card.actions?.length ?? 0, 0);
    assert.ok(!frame.card.body.some((item: { type: string }) => item.type === "Input.Text"));
    assert.match(frame.plain, /已确认方案/);
    assert.match(frame.plain, /修改范围：API。/);
    return new Response(`{"message_id":${messageId},"card_seq":2}`);
  });
  assert.equal(
    await deliver({ ...card, planApproval: true, version: 2, state: "decided", choice: 0, ref }, settings, signal),
    ref,
  );
  assert.equal(request.mock.callCount(), 1);
  request.mock.mockImplementation(async () => new Response('{"message_id":"111","card_seq":2}'));
  await assert.rejects(deliver({ ...card, version: 2, state: "decided", choice: 0, ref }, settings, signal));
  assert.match(approvalPayload({ ...card, state: "decided", choice: 1 }).plain, /已退回修改/);
});

test("an edit without a message ID is confirmed by reading back the persisted frame", async (t) => {
  const id = "1000000000000000001";
  const updated = { ...card, version: 2, state: "decided", choice: 1, ref: `native:${id}` };
  let content: string;
  const request = t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    if (init.method === "POST") {
      content = JSON.parse(String(init.body)).content_edit;
      return new Response('{"status":200}');
    }
    assert.equal(url, `https://octo.example/api/v1/bot/groups/group/threads/thread/messages/${id}`);
    return Response.json({ message_idstr: id, message_extra: { content_edit: content } });
  });
  assert.equal(await deliver(updated, settings, signal), updated.ref);
  assert.equal(request.mock.callCount(), 2);
});
