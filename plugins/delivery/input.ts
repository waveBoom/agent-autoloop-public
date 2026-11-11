// What the delivery reads from the hub's context and hands back to it: which item an event means, and the receipt.
import type { Delivered } from "./delivery.ts";

export function subjectNumber<E extends { subject: string }>(repo: string, context: { events: E[] }) {
  const subjects = [...new Set(context.events.map((event) => event.subject))];
  const suffix = subjects[0]?.slice(repo.length + 1);
  if (subjects.length !== 1 || !subjects[0].startsWith(`${repo}#`) || !/^[1-9]\d*$/.test(suffix)) {
    throw new Error("事件没有指向规则指定仓库的同一个事项");
  }
  const number = Number(suffix);
  if (!Number.isSafeInteger(number)) throw new Error("事项编号不正确");
  return number;
}

export function question(issue: { number: number; title: string; body?: string; html_url: string }) {
  const lines = (issue.body ?? "").replace(/```[\s\S]*?```/g, "").split("\n");
  const text = lines
    .filter((line) => !/\/Users\/|\/home\/|Traceback|^\s+at /.test(line))
    .join("\n")
    .trim();
  return {
    key: `owner-${issue.number}`,
    title: [...issue.title].slice(0, 100).join(""),
    text: [...(text || issue.html_url)].slice(0, 1500).join(""),
    options: ["已处理", "暂不处理"],
    about: issue.html_url,
  };
}

export function deliveryReceipt(number: number, result: Delivered, attended: boolean) {
  if (!result.findings?.length) return result.summary;
  const text = result.findings.map((finding) => `${finding.title}：${finding.text}`).join("\n");
  if (attended) return `${result.summary}\n${text}`;
  const notice = { key: `review-${number}`, title: "交付前需要修复问题", text: [...text].slice(0, 1500).join("") };
  return `${result.summary}\n\`\`\`agent-autoloop\n${JSON.stringify({ notice: [notice] })}\n\`\`\``;
}

export function pendingEvents(
  repo: string,
  rows: { number: number; head: string; labelEvent: number; kind: string }[],
) {
  return rows.map(({ number, head, labelEvent, kind }) => ({
    id: `${repo}#${number}:${labelEvent}:${head}`,
    type: `${kind}.labeled`,
    subject: `${repo}#${number}`,
    link: `https://github.com/${repo}/${kind === "pull_request" ? "pull" : "issues"}/${number}`,
  }));
}
