import { setTimeout as pause } from "node:timers/promises";

type Route = { endpoint: string; token: string; channelId: string; channelType: number };
type Scope = Route & { approver: string };
type Question = {
  id: number;
  title: string;
  text: string;
  options: string[];
  state?: string;
  choice?: number | null;
  sourceLink?: string;
};
type Click = { card: number; choice: number; ref: string; by: string; text?: string };
const decimal = /^[1-9]\d*$/;
const noteId = "approval-note";
const maxNoteLength = 1_000;

export function approvalPayload(card: Question, ordinaryReply = false) {
  const open = card.state === undefined || card.state === "open";
  const delivery = card.options[0] === "确认交付测试";
  const sourceLink = approvalSourceLink(card.sourceLink);
  const status = ordinaryReply
    ? open
      ? { label: "待补资料或回复", color: "accent" }
      : { label: card.state === "closed" ? "已关闭" : "已记录回复" }
    : open
      ? { label: "待你审批", color: "accent" }
      : card.state === "closed"
        ? { label: "审批已关闭" }
        : card.choice === 0
          ? { label: delivery ? "已确认交付测试" : "已确认方案", color: "good" }
          : card.choice === 1
            ? { label: delivery ? "已退回，暂不通知" : "已退回修改", color: "warning" }
            : { label: "已记录决定" };
  const replyHint = `卡片 #${card.id} · ${card.options.map((option, index) => `${index + 1}. ${option}`).join(" / ")}\n按钮不可用时，可 @issue-dispatcher 发送 /回复卡 ${card.id} 选项序号 [补充说明]`;
  const body = [
    [{ type: "TextRun", text: status.label, weight: "Bolder", color: status.color }],
    [{ type: "TextRun", text: card.title, weight: "Bolder" }],
    [{ type: "TextRun", text: card.text }],
    ...(open ? [[{ type: "TextRun", text: replyHint }]] : []),
  ].map((inlines) => ({
    type: "RichTextBlock",
    inlines,
  }));
  return {
    type: 17,
    profile: "octo/v2",
    card_version: "1.5",
    card: {
      type: "AdaptiveCard",
      version: "1.5",
      body: open
        ? [
            ...body,
            {
              type: "Input.Text",
              id: noteId,
              label: "补充说明（选填）",
              placeholder: ordinaryReply ? "例如：数据库仍无法访问，仓库已恢复" : "例如：请补一个空列表用例",
              maxLength: maxNoteLength,
            },
          ]
        : body,
      actions: [
        ...(open
          ? card.options.map((title, choice) => ({
              type: "Action.Submit",
              id: `autoloop-${card.id}-${choice}`,
              title,
              ...(choice === 0 && { style: "positive" }),
              data: {},
            }))
          : []),
        ...(sourceLink ? [{ type: "Action.OpenUrl", title: "查看 Issue", url: sourceLink }] : []),
      ],
    },
    plain: [status.label, card.title, card.text, ...(open ? [replyHint] : [])].join("\n"),
  };
}

export function approvalSourceLink(value?: string) {
  if (!value) return;
  try {
    const url = new URL(value);
    if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password) return url.href;
  } catch {}
}

export function readClick(event: unknown, scope: Pick<Scope, "approver" | "channelId" | "channelType">): Click | null {
  if (!event || typeof event !== "object") return null;
  const { event_type, event_data } = event as { event_type: unknown; event_data?: Record<string, unknown> };
  if (event_type !== "card_action" || !event_data) return null;
  const { operator_uid, channel_id, channel_type, message_id, action_id, inputs } = event_data;
  if (
    operator_uid !== scope.approver ||
    channel_id !== scope.channelId ||
    channel_type !== scope.channelType ||
    typeof message_id !== "string" ||
    !decimal.test(message_id) ||
    typeof action_id !== "string"
  )
    return null;
  const match = /^autoloop-([1-9]\d*)-([0-4])$/.exec(action_id);
  if (!match || !Number.isSafeInteger(Number(match[1]))) return null;
  if (inputs != null && (typeof inputs !== "object" || Array.isArray(inputs))) return null;
  const note = (inputs as Record<string, unknown> | null | undefined)?.[noteId];
  if (note !== undefined && (typeof note !== "string" || note.length > maxNoteLength)) return null;
  const text = note?.trim();
  return {
    card: Number(match[1]),
    choice: Number(match[2]),
    ref: message_id,
    by: scope.approver,
    ...(text && { text }),
  };
}

async function post(route: Route, path: string, body: string, signal: AbortSignal) {
  const endpoint = route.endpoint.replace(/\/sendMessage$/, path);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${route.token}`, "content-type": "application/json" },
    body,
    redirect: "error",
    signal: AbortSignal.any([signal, AbortSignal.timeout(25_000)]),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`Octo 事件接口返回 HTTP ${response.status}`);
  }
  return response;
}

export async function listenForApprovals(
  scope: Scope,
  handle: (click: Click) => Promise<boolean>,
  log: (line: string) => void,
  signal: AbortSignal,
  handleOther?: (event: unknown) => Promise<boolean>,
) {
  let cursor = "0";
  while (!signal.aborted) {
    try {
      const response = await post(scope, "/events", `{"event_id":${cursor},"limit":20,"wait":15}`, signal);
      // Keep int64 identifiers exact while preserving the numeric wire cursor.
      const text = (await response.text()).replace(/"(event_id|message_id)"\s*:\s*(\d+)(?=\s*[,}])/g, '"$1":"$2"');
      const { results } = JSON.parse(text);
      if (!Array.isArray(results)) throw new Error("Octo 事件列表格式无效");
      for (const event of results) {
        const id = event?.event_id;
        if (typeof id !== "string" || !decimal.test(id) || BigInt(id) <= BigInt(cursor)) continue;
        const click = readClick(event, scope);
        if (click ? await handle(click) : await handleOther?.(event)) {
          const ack = await post(scope, `/events/${id}/ack`, "{}", signal);
          await ack.body?.cancel();
        }
        cursor = id;
      }
    } catch {
      if (!signal.aborted) log("Octo 卡片事件暂未处理，将重试。");
    }
    await pause(1_000, undefined, { signal }).catch(() => {});
  }
}
