import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readSettings, sendPayload } from "./channel.ts";
import { isWorkspaceMember, type Settings } from "./intake-gateway.ts";
import { issueUrl } from "./intake.ts";

export function requesterCard(text: string) {
  const [heading, ...lines] = text.split("\n");
  const command = lines
    .at(-1)
    ?.match(/^(?:查进度命令：|查进度请在群或子区发送 @issue-dispatcher )(\/查进度 [A-Za-z0-9_-]{1,80})$/)?.[1];
  const help = "需要帮助？在 Octo 的 @ 菜单选中机器人，再发送 @issue-dispatcher /help。";
  const testUrl = issueUrl(lines.find((line) => line.startsWith("测试地址："))?.slice("测试地址：".length));
  const issueLink = lines.map(issueUrl).find((link) => {
    if (!link) return false;
    const url = new URL(link);
    return /^\/fleet\/[^/]+\/issues\/[A-Za-z][A-Za-z0-9_-]*-\d+\/?$/.test(url.pathname);
  });
  const body = [
    { type: "RichTextBlock", inlines: [{ type: "TextRun", text: heading, weight: "Bolder", color: "accent" }] },
    ...(command ? [...lines.slice(0, -1), help] : lines).filter(Boolean).map((line) => ({
      type: "RichTextBlock",
      inlines: [{ type: "TextRun", text: line }],
    })),
  ];
  return {
    type: 17,
    profile: command ? "octo/v2" : "octo/v1",
    card_version: "1.5",
    plain: command ? [heading, ...lines.slice(0, -1), help].join("\n") : text,
    card: {
      type: "AdaptiveCard",
      version: "1.5",
      body,
      actions: [
        ...(issueLink ? [{ type: "Action.OpenUrl", title: "查看 Issue", url: issueLink }] : []),
        ...(testUrl ? [{ type: "Action.OpenUrl", title: "打开测试环境", url: testUrl }] : []),
        ...(command
          ? [{ type: "Action.Submit", id: `autoloop-progress-${command.split(" ")[1]}`, title: "查进度", data: {} }]
          : []),
      ],
    },
  };
}

export function requesterMention(cardRef: string | null, text: string, uid: string, name = "需求方") {
  if ((cardRef !== null && !/^[1-9]\d*$/.test(cardRef)) || !uid) throw new Error("无法定位需求通知卡或需求方");
  const at = `@${name}`;
  return {
    type: 1,
    content: `${at} ${text}`,
    mention: { uids: [uid], entities: [{ uid, offset: 0, length: at.length }] },
    ...(cardRef !== null && { reply: { message_id: cardRef } }),
  };
}

export function readRequesterRoute(dir: string) {
  const local = JSON.parse(readFileSync(join(dir, "intake.json"), "utf8"));
  if (
    typeof local.channelId !== "string" ||
    !local.channelId ||
    typeof local.requesterChannelId !== "string" ||
    !/^[A-Za-z0-9-]+____[1-9]\d*$/.test(local.requesterChannelId)
  ) {
    throw new Error("须分别配置建单子区 channelId 和需求通知子区 requesterChannelId");
  }
  return { local, intakeChannel: String(local.channelId), requesterChannel: String(local.requesterChannelId) };
}

export function requesterDelivery(dir: string, route: ReturnType<typeof readRequesterRoute>) {
  const { local, requesterChannel } = route;
  const transport = readSettings({ botConfig: join(dir, "config.json"), channelId: requesterChannel, channelType: 5 });
  const apiUrl = new URL(transport.endpoint).origin;
  if (apiUrl !== local.apiOrigin) throw new Error("需求通知与 Octo 网关地址不符");
  const memberSettings = { ...local, apiUrl, botToken: transport.token } as Settings;
  const [group] = requesterChannel.split("____");
  const memberNames = new Map<string, string>();
  const mention = (cardRef: string | null, text: string, uid: string, name?: string) =>
    sendPayload(transport, requesterMention(cardRef, text, uid, name), AbortSignal.timeout(30_000));
  return {
    mention,
    async allowed(uid: string) {
      if (!(await isWorkspaceMember(memberSettings, uid))) return false;
      const endpoint = transport.endpoint.replace(/sendMessage$/, `groups/${group}/members`);
      const response = await fetch(endpoint, {
        headers: { authorization: `Bearer ${transport.token}` },
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new Error("无法核对需求通知群成员");
      }
      const data = await response.json();
      const members: { uid?: string; name?: string }[] = Array.isArray(data) ? data : data.members;
      if (!Array.isArray(members)) throw new Error("无法核对需求通知群成员");
      const member = members.find((entry) => entry.uid === uid);
      if (member?.name?.trim()) memberNames.set(uid, member.name.trim().replace(/[\r\n]+/g, " "));
      return Boolean(member);
    },
    async send(channelId: string, text: string, uid: string) {
      if (channelId !== requesterChannel) throw new Error("需求通知目的地不符");
      const cardRef = await sendPayload(transport, requesterCard(text), AbortSignal.timeout(30_000));
      await mention(null, text.split("\n", 1)[0], uid, memberNames.get(uid));
      return cardRef;
    },
  };
}
