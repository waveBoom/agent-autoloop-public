// The smallest channel there is: anything that takes a JSON POST (a group robot in DingTalk, WeCom, Slack, Discord…).
// Words and a link, no buttons: pair it with "links": true in rules.json so the link itself can answer that one card.
//   "channels": { "dingtalk": { "use": "webhook", "key": "…", "url": "https://…",
//                               "body": { "msgtype": "text", "text": { "content": "{text}" } } } }
import { accepted, payload } from "./templates.ts";
import type { Card, ChannelContext } from "../../host/channels.ts";

function fill(template: unknown, text: string): unknown {
  if (typeof template === "string") return template.replaceAll("{text}", () => text);
  if (Array.isArray(template)) return template.map((item) => fill(item, text));
  if (template && typeof template === "object") {
    return Object.fromEntries(Object.entries(template).map(([key, value]) => [key, fill(value, text)]));
  }
  return template;
}

function words(card: Card) {
  const choices = card.options.map((option, index) => `${index + 1}. ${option}`).join("\n");
  const parts = [card.title, card.text, ...(card.state === "open" ? [choices, card.link] : [])];
  return parts.filter(Boolean).join("\n\n");
}

export default async function webhook({ hub, options, log, signal }: ChannelContext) {
  while (!signal.aborted) {
    let card: Card | null;
    try {
      ({ card } = await hub.nextCard(50));
    } catch (error) {
      log(`couldn't reach the hub: ${error}`);
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      continue;
    }
    if (!card) continue;
    // It can't change a message once sent: an update has nothing to do.
    if (card.ref) {
      await hub.delivered(card.id, card.version, card.ref);
      continue;
    }
    try {
      const response = await fetch(options.url as string, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          options.platform
            ? payload(String(options.platform), words(card))
            : fill(options.body ?? { text: "{text}" }, words(card)),
        ),
        signal: AbortSignal.timeout(30_000),
      });
      await accepted(String(options.platform ?? ""), response);
      await hub.delivered(card.id, card.version, `sent-${card.id}`);
    } catch (error) {
      log(`card ${card.id} not sent: ${error}`);
      await hub.failed(card.id, card.version, String(error)).catch(() => {});
    }
  }
}
