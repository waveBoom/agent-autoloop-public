import { eventRule, type Rules } from "../kernel/rules.ts";

/** Resolve first-submission candidates. Callers retain the chosen rule for later comments. */
export function routeCandidates(rules: Rules, title: string, alias?: string): string[] {
  const requested = alias?.trim().toLowerCase();
  return rules.rules
    .filter(eventRule)
    .filter((rule) => {
      if (alias !== undefined) return rule.aliases?.some((value) => value.trim().toLowerCase() === requested);
      return rule.keywords?.some((value) => {
        const keyword = value.trim();
        const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const left = /^[a-z0-9_-]/i.test(keyword) ? "(?<![a-z0-9_-])" : "";
        const right = /[a-z0-9_-]$/i.test(keyword) ? "(?![a-z0-9_-])" : "";
        return new RegExp(left + escaped + right, "i").test(title);
      });
    })
    .map((rule) => rule.name);
}

export function issueRouteCandidates(rules: Rules, title: string, detail: string) {
  const declarations = [...detail.matchAll(/^\s*项目[：:]\s*([^\r\n]+)$/gm)].map((match) => match[1].trim());
  const unique = [
    ...new Set(declarations.flatMap((line) => line.split(/[、,，]/)).map((name) => name.trim().toLowerCase())),
  ];
  if (unique.length) {
    const matched = new Set<string>();
    for (const name of unique) {
      const named = rules.rules
        .filter((rule) => eventRule(rule) && rule.name.toLowerCase() === name)
        .map((rule) => rule.name);
      const candidates = [...new Set([...named, ...routeCandidates(rules, "", name)])];
      if (candidates.length !== 1) return [];
      matched.add(candidates[0]);
    }
    return [...matched];
  }
  return routeCandidates(rules, `${title}\n${detail}`);
}
