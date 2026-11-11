// `rules explain` and `emit --dry-run`: what this machine's rules file says, without asking a hub or writing a fact.
import { describeCron, nextRun, parseCron } from "../kernel/cron.ts";
import { cronOf, eventRule, typeMatches, type Rule, type Rules } from "../kernel/rules.ts";
import { parseRules } from "../protocol/rules.ts";
import { parseEvent } from "../protocol/validate.ts";

const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const clock = (zone: string) =>
  ({ timeZone: zone, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }) as const;
const when = (rule: Rule, rules: Rules, now: number) =>
  eventRule(rule)
    ? `来源 ${rule.when.source} · ${rule.when.types.join("、")}`
    : `定时 ${describeCron(cronOf(rule))}（下次 ${new Date(
        nextRun(parseCron(cronOf(rule))!, now, rules.timezone)!,
      ).toLocaleString("zh-CN", clock(rules.timezone))}）`;

function details(rule: Rule, rules: Rules, now: number) {
  const parts = [when(rule, rules, now), `→ ${rule.to}`, rule.cwd];
  if (rule.parallel) parts.push(`并发 ${rule.parallel}`);
  if (rule.group !== rule.name) parts.push(`组 ${rule.group}`);
  if (rule.tell !== "needed") parts.push(`通知 ${rule.tell}`);
  if (rule.skill) parts.push("有 Skill");
  if (rule.prompt) parts.push("有 Prompt");
  if (rule.aliases) parts.push(`别名 ${rule.aliases.join("、")}`);
  if (rule.keywords) parts.push(`关键词 ${rule.keywords.join("、")}`);
  if (rule.planApproval) parts.push("开发前需本人确认方案");
  if (rule.resumeOn) parts.push(`续接会话 ${rule.resumeOn.join("、")}`);
  if (rule.issueWorktrees) parts.push(`已登记 ${Object.keys(rule.issueWorktrees).length} 个事项的工作区`);
  if (rule.emits) parts.push(`可发 ${rule.emits.source} ${rule.emits.types.join("、")}`);
  for (const [name, repository] of Object.entries(rule.repositories ?? {})) {
    parts.push(`仓库 ${name}：${repository.path}（基线 ${repository.baseBranch}）`);
  }
  return parts.join(" · ");
}

/** The rules as this machine would run them, one line per thing an owner asks about. */
export function explainRules(text: string, now = Date.now(), zone = localZone()): string[] {
  const rules = parseRules(text, now, zone);
  const lines = [
    `时区 ${rules.timezone}；先问你：${rules.askFirst.join("、")}；${rules.rules.length} 条规则`,
    `来源：${Object.entries(rules.sources)
      .map(([id, source]) => `${id}（${source.name}）`)
      .join("、")}`,
    `Agent：${Object.entries(rules.agents)
      .map(([id, agent]) => `${id}（${agent.name}，${agent.worker}，权限 ${agent.access}）`)
      .join("、")}`,
  ];
  if (Object.keys(rules.channels).length)
    lines.push(
      `通道：${Object.entries(rules.channels)
        .map(([id, channel]) => {
          const answerers = channel.answerers?.length ? `，回答人 ${channel.answerers.join("、")}` : "";
          return `${id}（${channel.name}${answerers}${channel.links ? "，带链接" : ""}）`;
        })
        .join("、")}`,
    );
  lines.push("规则：");
  for (const rule of rules.rules) lines.push(`  ${rule.name}：${details(rule, rules, now)}`);
  for (const task of rules.elsewhere) lines.push(`  ${task.name}：在别处（${task.where}）${describeCron(task.cron)}`);
  return lines;
}

/** What a source event would be handed to, by the rules file alone: no hub, no log, no key. */
export function previewEvent(
  text: string,
  source: string,
  event: unknown,
  now = Date.now(),
  zone = localZone(),
): string[] {
  const rules = parseRules(text, now, zone);
  const parsed = parseEvent(event);
  const lines = [`事件：${source} ${parsed.type}${parsed.subject ? ` ${parsed.subject}` : ""}`];
  if (!rules.sources[source]) lines.push(`来源 ${source} 没有登记在 rules.json 的 sources 里`);
  const matched = rules.rules.filter(
    (rule) => eventRule(rule) && rule.when.source === source && typeMatches(rule.when.types, parsed.type),
  );
  if (!matched.length) {
    lines.push("没有规则接这条事件；真发出去会记成「没有规则接的事件」。");
    return lines;
  }
  lines.push("会派给：");
  for (const rule of matched) lines.push(`  ${rule.name} → ${rule.to} · ${rule.cwd}`);
  return lines;
}
