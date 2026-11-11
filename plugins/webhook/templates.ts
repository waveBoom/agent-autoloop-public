// Vendor message formats: links are listed in protocol.md so the fields can be checked against their owning APIs.
export function payload(platform: string, text: string): object {
  if (platform === "discord" && [...text].length > 2000) throw new Error("Discord 消息超过 2000 个字，请缩短卡片");
  if (platform === "wecom" && Buffer.byteLength(text) > 2048) throw new Error("企微消息超过 2048 字节，请缩短卡片");
  switch (platform) {
    case "dingtalk":
      return { msgtype: "text", text: { content: text }, at: { isAtAll: false } };
    case "wecom":
      return { msgtype: "text", text: { content: text } };
    case "slack":
      return { text, mrkdwn: false, unfurl_links: false, unfurl_media: false };
    case "discord":
      return { content: text, allowed_mentions: { parse: [] } };
    default:
      throw new Error(`没有这个 Webhook 模板：${platform}`);
  }
}

export async function accepted(platform: string, response: Response) {
  if (!response.ok) throw new Error(`返回 ${response.status}`);
  if (platform === "dingtalk" || platform === "wecom") {
    const result = await response.json();
    if (result.errcode !== 0) throw new Error(`发送失败：${result.errmsg ?? result.errcode}`);
  } else if (platform === "slack" && (await response.text()).trim() !== "ok") throw new Error("Slack 没有确认收到消息");
}
