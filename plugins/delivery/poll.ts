// What's waiting for delivery, as events: each labelled item, with an id that stays the same until something changes.
import { github, pages } from "./github.ts";
import { pendingEvents } from "./input.ts";

export async function poll(repo: string) {
  const api = github(repo);
  const rows = [];
  for (const label of ["deliver", "ask-owner"]) {
    for (const issue of pages(repo, `issues?state=all&labels=${label}&per_page=100`)) {
      if (!issue.pull_request && issue.state !== "open") continue;
      const events = pages(repo, `issues/${issue.number}/events?per_page=100`);
      const marked = events.filter((event) => event.event === "labeled" && event.label?.name === label).at(-1);
      if (!marked) throw new Error(`找不到事项 ${issue.number} 的标签记录`);
      const pr = issue.pull_request ? await api(`pulls/${issue.number}`) : null;
      if (pr?.state === "closed" && !pr.merged_at) continue;
      rows.push({
        number: issue.number,
        head: pr?.head.sha ?? "",
        labelEvent: marked.id,
        kind: pr ? "pull_request" : "issues",
      });
    }
  }
  return pendingEvents(repo, rows);
}

if (import.meta.main) {
  const events = await poll(process.argv[2]);
  console.log(`看过了，${events.length} 件待处理\n\`\`\`agent-autoloop\n${JSON.stringify({ events })}\n\`\`\``);
}
