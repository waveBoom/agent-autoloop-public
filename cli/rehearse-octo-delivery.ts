import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as pause } from "node:timers/promises";
import { parseArgs } from "node:util";
import { hubClient } from "../protocol/client.ts";
import { approvalPayload } from "../plugins/octo/approval.ts";
import { deliver, readSettings, sendPayload } from "../plugins/octo/channel.ts";
import { deliveryReview, reviewCardKey } from "../plugins/octo/delivery-review.ts";
import { readRequesterRoute, requesterDelivery } from "../plugins/octo/requester-delivery.ts";
import { readTestDeliveryProfile } from "../plugins/octo/test-delivery-profile.ts";

async function main() {
  const { values } = parseArgs({
    options: {
      "hub-home": { type: "string" },
      "bot-dir": { type: "string" },
      issue: { type: "string" },
      label: { type: "string" },
      version: { type: "string" },
      "test-channel": { type: "string" },
      simulate: { type: "boolean" },
      "test-profile": { type: "string" },
    },
  });
  const { "hub-home": home, "bot-dir": botDir, issue, label, version, "test-channel": channel } = values;
  if (
    !values.simulate ||
    !home ||
    !isAbsolute(home) ||
    !botDir ||
    !isAbsolute(botDir) ||
    !issue ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(issue) ||
    !label ||
    !/^[A-Za-z][A-Za-z0-9_-]*-\d+$/.test(label) ||
    !version ||
    !/^sim-[a-z0-9._-]{1,60}$/i.test(version) ||
    !channel
  ) {
    throw new Error(
      "用法：node cli/rehearse-octo-delivery.ts --simulate --hub-home <隔离目录> --bot-dir <测试机器人目录> --issue <UUID> --label <短编号> --version sim-1 --test-channel <子区ID>",
    );
  }
  const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
  const url = new URL(config.url);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.port === "3350" ||
    config.hub?.listen !== url.host ||
    config.channels?.octo?.channelId !== channel ||
    config.channels.octo.channelType !== 5
  ) {
    throw new Error("演练只支持独立的本机 Hub 和指定测试子区");
  }
  const route = readRequesterRoute(botDir);
  if (
    route.requesterChannel !== channel ||
    route.intakeChannel !== channel ||
    route.local.hubDb !== join(home, "hub.db")
  ) {
    throw new Error("测试卡和测试通知必须使用同一子区及隔离 Hub");
  }
  const settings = readSettings(config.channels.octo);
  const approver = settings.approver;
  const rules = JSON.parse(readFileSync(join(home, "rules.json"), "utf8"));
  if (!approver || JSON.stringify(rules.channels.octo?.answerers) !== JSON.stringify([approver])) {
    throw new Error("测试通道必须配置唯一的审批账号");
  }
  const health = await fetch(url.origin + "/healthz", { redirect: "error", signal: AbortSignal.timeout(4000) });
  if (!health.ok || !(await health.json()).ok) throw new Error("隔离 Hub 未就绪");
  using intake = new DatabaseSync(join(botDir, "data", "intake.sqlite"), { readOnly: true });
  const requesters = intake
    .prepare("SELECT sender FROM octo_intake WHERE issue=? AND channel=? AND state='created'")
    .all(issue, channel);
  const requester = requesters[0]?.sender;
  if (requesters.length !== 1 || typeof requester !== "string" || !requester) throw new Error("缺少已核对的演练需求方");
  const transport = requesterDelivery(botDir, route);
  if (!(await transport.allowed(requester))) throw new Error("需求方不在工作区或测试群");
  using reviewDb = new DatabaseSync(join(home, "delivery-review.sqlite"));
  reviewDb.exec("PRAGMA busy_timeout=3000; PRAGMA synchronous=FULL");
  const profile = values["test-profile"] ? readTestDeliveryProfile(values["test-profile"]) : undefined;
  const environment = [
    "测试环境（模拟）",
    ...(profile?.testUrl ? [`测试地址：${profile.testUrl}`] : []),
    ...(profile?.testRequest ? [`测试请求：${profile.testRequest.method} ${profile.testRequest.url}`] : []),
  ].join("\n");
  const review = deliveryReview(reviewDb, { issue, version, environment, approver });
  const hub = hubClient(url.origin, config.channels.octo.key);
  if (review.claimCard()) {
    process.env.AGENT_AUTOLOOP_HOME = home;
    process.env.AGENT_AUTOLOOP_RULES = join(home, "rules.json");
    const runtime = await import("../host/runtime.ts");
    const spec = {
      key: reviewCardKey(issue, version),
      once: true,
      quiet: true,
      kind: "ask",
      title: `【部署演练】${label} · 确认交付测试`,
      text: `环境：${environment}\n版本：${version}\n模拟部署与环境检查：通过\n确认后向需求方发送测试提醒。`,
      options: ["确认交付测试", "退回暂不通知"],
    };
    const { card } = runtime.createCard(spec);
    runtime.db.close();
    const messageId = await sendPayload(settings, approvalPayload({ id: card, ...spec }), AbortSignal.timeout(30_000));
    const ref = `native:${messageId}`;
    await hub.delivered(card, 1, ref);
    review.bindCard(card, ref);
    console.log(JSON.stringify({ stage: "awaiting_confirmation", issue: label, version, card, messageId }));
  }
  using hubDb = new DatabaseSync(join(home, "hub.db"), { readOnly: true });
  while (true) {
    const row = review.read();
    if (row.state === "notified" || row.state === "returned") {
      console.log(JSON.stringify({ stage: row.state, issue: label, version, ref: row.notification_ref }));
      return;
    }
    if (row.state !== "awaiting_confirmation" && row.state !== "confirmed") {
      throw new Error(`演练状态待核对：${row.state}`);
    }
    const projection = hubDb
      .prepare("SELECT data FROM projections WHERE collection='cards' AND key=?")
      .get(String(row.card));
    const card = projection && JSON.parse(String(projection.data));
    if (card?.state === "decided") {
      if (row.state === "awaiting_confirmation" && !review.recordDecision(card))
        throw new Error("审批人或版本与演练部署记录不符");
      await deliver(
        { ...card, ref: row.card_ref, options: JSON.parse(card.options) },
        settings,
        AbortSignal.timeout(40_000),
      );
      await hub.delivered(card.id, card.version, row.card_ref);
      await review.notify(() =>
        transport.send(
          channel,
          [
            `【联调测试】Issue ${label} · 可以开始测试`,
            `环境：${environment}`,
            `版本：${version}，负责人已确认交付测试。`,
            "本条为演练通知。",
          ].join("\n"),
          requester,
        ),
      );
      continue;
    }
    if (card?.state === "closed") throw new Error("审批卡已关闭，演练未交付");
    await pause(1000);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "交付演练失败");
  process.exitCode = 1;
});
