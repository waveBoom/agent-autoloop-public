import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { approvalPayload, approvalSourceLink, listenForApprovals } from "./approval.ts";
import { canReadGroupProgress, handleGatewayIntake } from "./intake-gateway.ts";
import { requesterCard } from "./requester-delivery.ts";

type Card = {
  id: number;
  version: number;
  ref: string | null;
  kind: string;
  state: string;
  title: string;
  text: string;
  options: string[];
  planApproval?: true;
  choice?: number | null;
  sourceLink?: string;
  sourceTitle?: string;
};
type Context = {
  hub: {
    nextCard(wait: number): Promise<{ card: Card | null }>;
    delivered(card: number, version: number, ref: string): Promise<unknown>;
    failed(card: number, version: number, error: string): Promise<unknown>;
    answer(card: number, body: { choice: number; ref: string; by: string; text?: string }): Promise<unknown>;
  };
  options: Record<string, unknown>;
  log: (line: string) => void;
  signal: AbortSignal;
};

export function readSettings({ botConfig, channelId, channelType, answerCommand, approver }: Context["options"]) {
  if (typeof botConfig !== "string" || !isAbsolute(botConfig)) throw new Error("Octo botConfig 必须是绝对路径");
  if (typeof channelId !== "string" || !channelId.trim() || (channelType !== 2 && channelType !== 5)) {
    throw new Error("Octo 需要 channelId 和 channelType（2 为群，5 为子区）");
  }
  if (answerCommand !== undefined && (typeof answerCommand !== "string" || !answerCommand.trim())) {
    throw new Error("Octo answerCommand 必须是非空文字");
  }
  if (approver !== undefined && (typeof approver !== "string" || !approver.trim() || approver.length > 500)) {
    throw new Error("Octo approver 必须是一个有效的 Octo UID");
  }
  try {
    const { botToken, apiUrl } = JSON.parse(readFileSync(botConfig, "utf8"));
    const url = new URL(apiUrl);
    if (
      typeof botToken !== "string" ||
      !botToken.trim() ||
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error();
    }
    return {
      endpoint: `${url.href.replace(/\/+$/, "")}/v1/bot/sendMessage`,
      token: botToken,
      channelId,
      channelType,
      answerCommand: answerCommand ?? "agent-autoloop answer",
      ...(approver && { approver }),
    };
  } catch {
    throw new Error("无法读取 Octo Bot 配置：需要 botToken 和 HTTPS apiUrl");
  }
}

function displayCard(card: Card, answerCommand: string, issue?: string) {
  const waiting = card.kind === "ask" && card.state === "open";
  const status = waiting ? (card.planApproval ? "待确认方案" : "待补资料或回复") : "进展通知";
  const heading = issue ? `${issue} · ${status}` : status;
  const lines = [heading, card.title, card.text];
  if (waiting && issue && !card.planApproval) lines.push(`如需补充资料，请在原 Issue ${issue} 留评论。`);
  if (waiting) lines.push("需要直接回答此卡时，可复制对应命令到 Hub 所在机器执行。");
  if (card.kind === "notice" && !/^下一步[：:]/m.test(card.text)) {
    lines.push("下一步：本条进展通知无需回复。如有待办，请看同一 Issue 的提问卡。");
  }
  const sourceLink = approvalSourceLink(card.sourceLink);
  return {
    type: 17,
    profile: "octo/v1",
    card_version: "1.5",
    plain: lines.filter(Boolean).join("\n"),
    card: {
      type: "AdaptiveCard",
      version: "1.5",
      body: lines.filter(Boolean).map((text, index) => ({
        type: "RichTextBlock",
        inlines: [
          { type: "TextRun", text, ...(index < 2 && { weight: "Bolder" }), ...(index === 0 && { color: "accent" }) },
        ],
      })),
      actions: [
        ...(sourceLink ? [{ type: "Action.OpenUrl", title: "查看 Issue", url: sourceLink }] : []),
        ...(waiting
          ? card.options.map((title, index) => ({
              type: "Action.CopyToClipboard",
              title,
              text: `${answerCommand} ${card.id} ${index + 1}`,
            }))
          : []),
      ],
    },
  };
}

export async function deliver(card: Card, settings: ReturnType<typeof readSettings>, signal: AbortSignal) {
  const issue = /^[A-Za-z][A-Za-z0-9_-]*-\d+(?=\s|$)/.exec(card.sourceTitle ?? "")?.[0];
  const labelled = issue && !card.title.includes(issue) ? { ...card, title: `${issue} · ${card.title}` } : card;
  if (card.ref) {
    const nativeId = /^native:([1-9]\d*)$/.exec(card.ref)?.[1];
    if (nativeId && card.state !== "open") await editApproval(settings, labelled, nativeId, signal);
    return card.ref;
  }
  if (settings.approver && card.kind === "ask" && card.state === "open") {
    const ref = await sendPayload(settings, approvalPayload(labelled, !card.planApproval), signal);
    return `native:${ref}`;
  }
  return sendPayload(settings, displayCard(card, settings.answerCommand, issue), signal);
}

export async function sendText(
  settings: { endpoint: string; token: string; channelId: string; channelType: number },
  content: string,
  signal: AbortSignal,
) {
  return sendPayload(settings, { type: 1, content }, signal);
}

type Route = { endpoint: string; token: string; channelId: string; channelType: number };

export async function sendPayload(settings: Route, payload: object, signal: AbortSignal) {
  const receipt = await postMessage(settings, "sendMessage", { payload, client_msg_no: randomUUID() }, signal);
  if (typeof receipt.messageId !== "string" || !/^[1-9]\d*$/.test(receipt.messageId)) {
    throw new Error("Octo 未返回有效的消息编号");
  }
  return receipt.messageId;
}

async function editApproval(settings: Route, card: Card, messageId: string, signal: AbortSignal) {
  const frame = { ...approvalPayload(card, !card.planApproval), card_seq: card.version };
  const content_edit = JSON.stringify(frame);
  const receipt = await postMessage(settings, "message/edit", { message_id: messageId, content_edit }, signal);
  if (receipt.messageId === undefined) {
    await verifyApprovalEdit(settings, messageId, frame, signal);
    return;
  }
  if (receipt.messageId !== messageId || (receipt.cardSeq !== undefined && receipt.cardSeq !== card.version)) {
    throw new Error("Octo 更新回执与原卡片不匹配");
  }
}

async function verifyApprovalEdit(
  settings: Route,
  messageId: string,
  frame: ReturnType<typeof approvalPayload> & { card_seq: number },
  signal: AbortSignal,
) {
  const parts = settings.channelType === 5 ? settings.channelId.split("____") : [settings.channelId];
  const [group, thread] = parts.map(encodeURIComponent);
  if (!group || (settings.channelType === 5 && (!thread || parts.length !== 2))) {
    throw new Error("Octo 无法定位原审批卡片");
  }
  const path = `groups/${group}${thread ? `/threads/${thread}` : ""}/messages/${messageId}`;
  const response = await fetch(settings.endpoint.replace(/sendMessage$/, path), {
    headers: { authorization: `Bearer ${settings.token}` },
    redirect: "error",
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`Octo 无法核实卡片更新（HTTP ${response.status}）`);
  }
  const message = await response.json();
  const content = message.message_extra?.content_edit;
  const saved = typeof content === "string" ? JSON.parse(content) : content;
  if (
    message.message_idstr !== messageId ||
    saved?.type !== 17 ||
    saved.card_seq !== frame.card_seq ||
    saved.card?.body?.[0]?.inlines?.[0]?.text !== frame.plain.split("\n", 1)[0] ||
    (saved.card.actions?.length ?? 0) !== frame.card.actions.length ||
    frame.card.actions.some((action, i) => {
      const actual = saved.card.actions[i];
      return actual?.type !== action.type || actual?.url !== ("url" in action ? action.url : undefined);
    }) ||
    saved.card.body.some((item: { type?: string }) => item.type === "Input.Text")
  ) {
    throw new Error("Octo 原卡片尚未显示此次更新");
  }
}

async function postMessage(settings: Route, path: "sendMessage" | "message/edit", body: object, signal: AbortSignal) {
  const action = path === "sendMessage" ? "发送" : "更新";
  let response: Response;
  try {
    response = await fetch(settings.endpoint.replace(/sendMessage$/, path), {
      method: "POST",
      headers: { authorization: `Bearer ${settings.token}`, "content-type": "application/json" },
      redirect: "error",
      body: JSON.stringify({
        channel_id: settings.channelId,
        channel_type: settings.channelType,
        ...body,
      }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    });
  } catch {
    throw new Error(`Octo ${action}请求失败`);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    // Retrying after a lost acknowledgement can hit the same stored sequence.
    if (path === "message/edit" && response.status === 409) return {};
    throw new Error(`Octo ${action}失败（HTTP ${response.status}）`);
  }
  try {
    // Parse int64 message IDs before JavaScript can round them.
    const body = (await response.text()).replace(/"message_id"\s*:\s*(\d+)(?=\s*[,}])/g, '"message_id":"$1"');
    const { message_id, card_seq } = JSON.parse(body);
    return { messageId: message_id as unknown, cardSeq: card_seq as unknown };
  } catch {}
  return {};
}

async function deliverCards({ hub, log, signal }: Context, settings: ReturnType<typeof readSettings>) {
  while (!signal.aborted) {
    const { card } = await hub.nextCard(50);
    if (!card || signal.aborted) continue;
    let ref: string;
    try {
      ref = await deliver(card, settings, signal);
    } catch (error) {
      if (signal.aborted) return;
      const reason = error instanceof Error ? error.message : "Octo 发送失败";
      log(`卡片 #${card.id}：${reason}`);
      await hub.failed(card.id, card.version, reason);
      continue;
    }
    await hub.delivered(card.id, card.version, ref);
  }
}

async function replyToProgressClick(
  event: unknown,
  settings: ReturnType<typeof readSettings>,
  botDir: string,
  signal: AbortSignal,
) {
  const envelope = event as { event_type?: unknown; event_data?: Record<string, unknown> } | null;
  if (envelope?.event_type !== "card_action" || !envelope.event_data) return false;
  const { operator_uid, channel_id, channel_type, message_id, action_id } = envelope.event_data;
  if (
    typeof operator_uid !== "string" ||
    !operator_uid.trim() ||
    typeof channel_id !== "string" ||
    (channel_type !== 2 && channel_type !== 5) ||
    typeof message_id !== "string" ||
    !/^[1-9]\d*$/.test(message_id) ||
    typeof action_id !== "string"
  )
    return false;
  const match = /^autoloop-progress-([A-Za-z0-9_-]{1,80})$/.exec(action_id);
  if (!match) return false;
  const config = join(botDir, "intake.json");
  if (!existsSync(config)) return false;
  const local = JSON.parse(readFileSync(config, "utf8"));
  const turn = {
    channel: channel_id,
    channelType: channel_type,
    sender: operator_uid,
    message: message_id,
    text: `/查进度 ${match[1]}`,
  };
  if (!canReadGroupProgress(local.requesterChannelId, turn)) return false;
  const apiUrl = settings.endpoint.replace(/\/v1\/bot\/sendMessage$/, "");
  const reply = await handleGatewayIntake(
    { apiUrl, botToken: settings.token, botId: local.botId, dataDir: join(botDir, "data") },
    turn,
    async () => {
      throw new Error("进度查询不需要生成草稿");
    },
  );
  if (!reply) return false;
  await sendPayload(
    { ...settings, channelId: turn.channel, channelType: turn.channelType },
    requesterCard(reply),
    signal,
  );
  return true;
}

export default async function octo(context: Context) {
  const settings = readSettings(context.options);
  if (!settings.approver) return deliverCards(context, settings);
  const stop = new AbortController();
  const signal = AbortSignal.any([context.signal, stop.signal]);
  try {
    await Promise.all([
      deliverCards({ ...context, signal }, settings),
      listenForApprovals(
        { ...settings, approver: settings.approver },
        async ({ card, ref, ...body }) => {
          try {
            await context.hub.answer(card, { ...body, ref: `native:${ref}` });
            return true;
          } catch (error) {
            const status = (error as { status?: number }).status;
            if (status === 409) {
              context.log(`卡片 #${card} 的方案已过期。`);
              return true;
            }
            if (status === 401 || status === 404) return false;
            throw error;
          }
        },
        context.log,
        signal,
        (event) => replyToProgressClick(event, settings, dirname(String(context.options.botConfig)), signal),
      ),
    ]);
  } finally {
    stop.abort();
  }
}
