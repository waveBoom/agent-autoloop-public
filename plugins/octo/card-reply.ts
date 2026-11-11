import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import type { Config } from "../../host/config.ts";
import { HubError, hubClient } from "../../protocol/client.ts";
import type { ChatTurn } from "./intake.ts";

export const cardReplyCommand = /^\/回复卡(?:\s|$)/;

export async function replyToCard(turn: ChatTurn, botDir: string, hubDb: unknown, home: string, config: Config) {
  const channel = config.channels?.octo;
  if (
    !config.hub ||
    hubDb !== join(home, "hub.db") ||
    !channel?.key ||
    channel.botConfig !== join(botDir, "config.json") ||
    channel.approver !== turn.sender ||
    channel.channelId !== turn.channel ||
    channel.channelType !== turn.channelType ||
    ![2, 5].includes(turn.channelType ?? 0)
  )
    return "此命令仅限指定审批人在审批群或子区使用。";

  const match = /^\/回复卡\s+([1-9]\d*)\s+([1-5])(?:\s+([\s\S]+))?$/.exec(turn.text.trim());
  const issue = /^\/回复卡\s+([A-Za-z][A-Za-z0-9_-]*-\d+)$/.exec(turn.text.trim())?.[1];
  const card = Number(match?.[1]);
  const choice = Number(match?.[2]) - 1;
  const text = match?.[3]?.trim();
  if (!issue && (!match || !Number.isSafeInteger(card)))
    return "用法：/回复卡 Issue编号 查看选项，或 /回复卡 卡号 选项序号 [补充说明] 提交。";
  if (text && [...text].length > 1000) return "补充说明最多 1000 字。";

  try {
    using db = new DatabaseSync(hubDb, { readOnly: true });
    if (issue) {
      const rows = db
        .prepare(
          `
        SELECT json_extract(c.data,'$.id') AS id, json_extract(c.data,'$.title') AS title,
               json_extract(c.data,'$.options') AS options
        FROM projections c JOIN projections d ON d.collection='deliveries'
          AND json_extract(d.data,'$.card_id')=json_extract(c.data,'$.id')
          AND json_extract(d.data,'$.channel')='octo' AND json_extract(d.data,'$.ref') IS NOT NULL
        WHERE c.collection='cards' AND json_extract(c.data,'$.kind')='ask'
          AND json_extract(c.data,'$.state')='open'
          AND upper(substr(json_extract(c.data,'$.source_title') || ' ',1,length(?) + 1))=?
        ORDER BY id DESC
      `,
        )
        .all(issue, issue.toUpperCase() + " ");
      if (!rows.length) return `${issue.toUpperCase()} 没有待回复的提问卡。`;
      return rows
        .map(({ id, title, options }) =>
          [
            `卡片 #${id} · ${title}`,
            ...(JSON.parse(String(options)) as string[]).map((label, index) => `${index + 1}. ${label}`),
            `提交方式：@issue-dispatcher /回复卡 ${id} 选项序号 [补充说明]`,
          ].join("\n"),
        )
        .join("\n\n");
    }
    const row = db
      .prepare(
        `
      SELECT json_extract(d.data,'$.ref') AS ref
      FROM projections c JOIN projections d
        ON d.collection='deliveries' AND json_extract(d.data,'$.card_id')=?
        AND json_extract(d.data,'$.channel')='octo'
      WHERE c.collection='cards' AND json_extract(c.data,'$.id')=? AND json_extract(c.data,'$.kind')='ask'
    `,
      )
      .get(card, card);
    if (typeof row?.ref !== "string" || !/^(?:native:)?[1-9]\d*$/.test(row.ref))
      return `找不到已发到此 Octo 审批通道的提问卡 #${card}。`;
    const result = await hubClient(config.url, channel.key).answer(card, {
      choice,
      text,
      by: turn.sender,
      ref: row.ref,
    });
    if (result?.notificationQueued) return `卡片 #${card} 已确认，Hub 正在处理提测通知。`;
    return result?.changed === true ? `Hub 已记录卡片 #${card} 的回复。` : `卡片 #${card} 已处理或关闭。`;
  } catch (error) {
    if (error instanceof HubError && error.status === 400) return error.message;
    if (error instanceof HubError && error.status === 409) return `卡片 #${card} 的方案已过期，请查看最新卡片。`;
    return `暂未确认 Hub 是否收到卡片 #${card} 的回复，请查看卡片状态后再试。`;
  }
}
