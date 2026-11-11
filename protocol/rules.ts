// rules.json: the sources that may send events, the agents that do the work, the channels that reach the owner, the
// rules between them and, only to be shown, the scheduled tasks that run elsewhere. A mistake is caught here with a
// message saying where: at start it stops the hub, later it leaves the old rules running and the owner is told.
import { nextRun, parseCron } from "../kernel/cron.ts";
import { SCHEDULE, type Rule, type Rules } from "../kernel/rules.ts";
import { posix } from "node:path";
import { parseEvent } from "./validate.ts";

export class RulesError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`rules.json 有问题：\n${issues.join("\n")}`);
    this.issues = issues;
  }
}

const ACCESS = ["read", "edit", "full"];
const TELLS = ["always", "needed", "never"];
const ID = /^[a-z][a-z0-9-]*$/;
const TYPE_PATTERN = /^(\*|[a-z][a-z0-9_.-]{0,63}(\.\*)?)$/;
const ASK_FIRST = ["删数据", "停服", "花钱", "对外发消息", "改产品方向", "新建或轮换密钥", "修改权限"];
const NOT_EMPTY = "不能为空";
const ID_WORDS = "只能用小写字母、数字和 -";

type Check = (value: unknown) => boolean;
type Field = [name: string, check: Check, problem: string, optional?: boolean];

const isText: Check = (value) => typeof value === "string" && value.trim() !== "";
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isWords: Check = (value) => Array.isArray(value) && value.every(isText);
const isSomeWords: Check = (value) => isWords(value) && (value as string[]).length > 0;
const isId: Check = (value) => typeof value === "string" && ID.test(value);
const isCount: Check = (value) => Number.isInteger(value) && (value as number) > 0;
const isTypes: Check = (value) => isSomeWords(value) && (value as string[]).every((type) => TYPE_PATTERN.test(type));
const isCron: Check = (value) => typeof value === "string" && parseCron(value) !== null;
const isRepositoryPath: Check = (value) =>
  typeof value === "string" && /^(?:\/|~\/)/.test(value) && !/[\x00-\x1f\x7f]/.test(value);
const isBranch: Check = (value) =>
  typeof value === "string" &&
  !/[\x00-\x20\x7f]/.test(value) &&
  /^(?![-/])(?!@$)(?!.*(?:\.\.|@\{|\/\/))(?!.*[./]$)(?!.*(?:^|\/)\.)(?!.*\.lock(?:\/|$))[^\x00-\x20\x7f~^:?*\[\\]+$/.test(
    value,
  );

function isKeyOf(table: object): Check {
  return (value) => typeof value === "string" && value in table;
}

function isZone(zone: unknown) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone as string });
    return isText(zone);
  } catch {
    return false;
  }
}

/** Each field present and well formed, and no others: a misspelt field would otherwise be silently ignored. */
function checkFields(issues: string[], where: string, value: unknown, spec: Field[]) {
  if (!isObject(value)) return void issues.push(`${where}要是一个对象`);
  for (const [name, check, problem, optional] of spec) {
    if (!(name in value)) {
      if (!optional) issues.push(`${where}缺少 ${name}`);
    } else if (!check(value[name])) issues.push(`${where}的 ${name} ${problem}`);
  }
  for (const name of Object.keys(value)) {
    if (!spec.some(([known]) => known === name)) issues.push(`${where}有不认识的字段 ${name}`);
  }
}

const nameOf = (entry: unknown) => (isObject(entry) && typeof entry.name === "string" ? entry.name : "");

function checkRule(issues: string[], rules: Rules, rule: Rule, names: Set<string>, now: number) {
  const name = nameOf(rule);
  if (names.has(name)) issues.push(`规则名「${name}」重复了`);
  names.add(name);
  const where = `规则「${name}」`;
  const when = isObject(rule) ? rule.when : undefined;
  checkFields(issues, where, rule, [
    ["name", isText, NOT_EMPTY],
    ["when", isObject, "要是一个对象"],
    ["to", isKeyOf(rules.agents), `不是已登记的 Agent：${isObject(rule) ? rule.to : ""}`],
    ["cwd", (value) => typeof value === "string" && /^(~\/|\/)/.test(value), "要是以 ~/ 或 / 开头的目录"],
    ["skill", isText, NOT_EMPTY, true],
    ["prompt", isText, NOT_EMPTY, true],
    ["group", isText, NOT_EMPTY, true],
    ["parallel", isCount, "要是正整数", true],
    ["tell", (value) => TELLS.includes(value as string), `只能是 ${TELLS.join("、")}`, true],
    ["emits", isObject, "要是一个对象", true],
    ["repositories", isObject, "要是仓库名称到配置的对象", true],
    ["issueWorktrees", isObject, "要是事项到工作区配置的对象", true],
    ["prepareWorktrees", (value) => typeof value === "boolean", "要是 true 或 false", true],
    ["aliases", isSomeWords, "要是非空的别名列表", true],
    ["keywords", isSomeWords, "要是非空的关键词列表", true],
    ["planApproval", (value) => typeof value === "boolean", "要是 true 或 false", true],
    ["resumeOn", isTypes, "要是事件类型的列表，可以用 x.* 或 *", true],
  ]);
  if (isObject(when) && "source" in when) {
    checkFields(issues, `${where}的 when `, when, [
      ["source", isKeyOf(rules.sources), `不是已登记的来源：${when.source}`],
      ["types", isTypes, "要是事件类型的列表，可以用 x.* 或 *"],
    ]);
  } else if (isObject(when)) {
    if (isCron(when.cron) && nextRun(parseCron(when.cron as string)!, now, rules.timezone) === null) {
      issues.push(`${where}的定时永远不会到来：${when.cron}`);
    }
    checkFields(issues, `${where}的 when `, when, [["cron", isCron, "不是有效的 cron"]]);
  }
  if (!isObject(rule)) return;
  if (rule.prepareWorktrees === true && (!rule.planApproval || !Object.keys(rule.repositories ?? {}).length))
    issues.push(`${where}的 prepareWorktrees 要开启 planApproval 并登记 repositories`);
  if (isObject(rule.issueWorktrees)) {
    if (!isObject(when) || !("source" in when) || !isCount(rule.parallel))
      issues.push(`${where}的 issueWorktrees 要配置事件触发和 parallel`);
    for (const [subject, bindings] of Object.entries(rule.issueWorktrees)) {
      const issueWhere = `${where}的 issueWorktrees.${subject}`;
      try {
        if (!subject || subject.trim() !== subject) throw new Error();
        parseEvent({ id: "binding", type: "task.created", subject });
      } catch {
        issues.push(`${issueWhere} 要使用有效且非空的 subject`);
      }
      if (!isObject(bindings) || !Object.keys(bindings).length) {
        issues.push(`${issueWhere} 要列出至少一个仓库的工作区`);
        continue;
      }
      for (const [alias, binding] of Object.entries(bindings)) {
        const bindingWhere = `${issueWhere}.${alias}`;
        const repo =
          rule.repositories && Object.hasOwn(rule.repositories, alias) ? rule.repositories[alias] : undefined;
        if (!repo) issues.push(`${bindingWhere} 要引用规则已登记的仓库`);
        checkFields(issues, bindingWhere, binding, [
          [
            "path",
            (value) =>
              typeof value === "string" &&
              value.startsWith("/") &&
              !value.endsWith("/") &&
              posix.normalize(value) === value &&
              isRepositoryPath(value),
            "要是规范的绝对目录",
          ],
          ["branch", (value) => isBranch(value) && value !== repo?.baseBranch, "要是不同于基线的任务分支名"],
          [
            "baseCommit",
            (value) => typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$(?![\s\S])/.test(value),
            "要是完整的小写基线提交号",
          ],
        ]);
      }
    }
  }
  if (rule.resumeOn !== undefined && (!isObject(when) || !("source" in when) || !isCount(rule.parallel))) {
    issues.push(`${where}的 resumeOn 要配置事件触发和 parallel，按 subject 隔离事项`);
  }
  if (rule.planApproval === true) {
    const agent = rules.agents[rule.to];
    if (agent?.use !== "codex") issues.push(`${where}的 planApproval 要用 codex 插件`);
    if (!isObject(when) || !("source" in when) || !isCount(rule.parallel))
      issues.push(`${where}的 planApproval 要配置事件触发和 parallel，按 subject 隔离事项`);
  }
  if (isObject(rule.repositories)) {
    for (const [id, repository] of Object.entries(rule.repositories)) {
      const repositoryWhere = `${where}的 repositories.${id}`;
      if (!ID.test(id) || id.trim() !== id) issues.push(`${repositoryWhere} 的仓库名称${ID_WORDS}，以小写字母开头`);
      checkFields(issues, repositoryWhere, repository, [
        ["path", isRepositoryPath, "要是以 / 或 ~/ 开头且不含控制字符的本机路径"],
        ["baseBranch", isBranch, "要是有效的分支名"],
      ]);
    }
  }
  // A plain command needs no words: a script that polls something is an agent too.
  if (!rule.skill && !rule.prompt && rules.agents[rule.to]?.use !== "command") {
    issues.push(`${where}的 skill 和 prompt 至少写一个`);
  }
  if (isObject(rule.emits)) {
    const emittable: Check = (value) => value !== SCHEDULE && isKeyOf(rules.sources)(value);
    checkFields(issues, `${where}的 emits `, rule.emits, [
      ["source", emittable, `不是已登记的来源：${rule.emits.source}`],
      ["types", isTypes, "要是事件类型的列表"],
    ]);
  }
  rule.group ??= rule.name;
  rule.tell ??= "needed";
}

export function parseRules(json: string, now: number, timezone: string): Rules {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new RulesError([`不是 JSON：${(error as Error).message}`]);
  }
  const issues: string[] = [];
  checkFields(issues, "rules.json ", parsed, [
    ["timezone", isZone, "不是有效的时区", true],
    ["askFirst", isWords, "要是文字的列表", true],
    ["sources", isObject, "要是一个对象"],
    ["agents", isObject, "要是一个对象"],
    ["channels", isObject, "要是一个对象", true],
    ["rules", Array.isArray, "要是一个列表"],
    ["elsewhere", Array.isArray, "要是一个列表", true],
  ]);
  if (issues.length) throw new RulesError(issues);
  const rules = parsed as Rules;
  rules.timezone ??= timezone;
  rules.askFirst ??= ASK_FIRST;
  rules.channels ??= {};
  rules.elsewhere ??= [];
  if (SCHEDULE in rules.sources) issues.push(`来源 ${SCHEDULE} 是保留的，定时用规则的 cron`);
  for (const [id, source] of Object.entries(rules.sources)) {
    if (!ID.test(id)) issues.push(`来源的编号${ID_WORDS}：${id}`);
    checkFields(issues, `来源 ${id} `, source, [
      ["name", isText, NOT_EMPTY],
      ["adapter", isText, NOT_EMPTY, true],
    ]);
  }
  rules.sources[SCHEDULE] = { name: "定时" };
  for (const [id, channel] of Object.entries(rules.channels)) {
    if (!ID.test(id)) issues.push(`通道的编号${ID_WORDS}：${id}`);
    checkFields(issues, `通道 ${id} `, channel, [
      ["name", isText, NOT_EMPTY],
      ["answerers", isWords, "要是文字的列表", true],
      ["links", (value) => typeof value === "boolean", "要是 true 或 false", true],
      ["planApprovals", (value) => typeof value === "boolean", "要是 true 或 false", true],
    ]);
    if (channel?.planApprovals === true && !isSomeWords(channel.answerers)) {
      issues.push(`通道 ${id} 启用方案审批时必须列出 answerers`);
    }
  }
  for (const [id, agent] of Object.entries(rules.agents)) {
    if (!ID.test(id)) issues.push(`Agent 的编号${ID_WORDS}：${id}`);
    checkFields(issues, `Agent ${id} `, agent, [
      ["name", isText, NOT_EMPTY],
      ["worker", isId, ID_WORDS],
      ["use", isId, ID_WORDS],
      ["model", isText, NOT_EMPTY, true],
      ["effort", isText, NOT_EMPTY, true],
      ["access", (value) => ACCESS.includes(value as string), `只能是 ${ACCESS.join("、")}`, true],
      ["command", isSomeWords, "要是命令行的列表", !isObject(agent) || agent.use !== "command"],
      ["timeout", isCount, "要是正整数（分钟）", true],
    ]);
    if (isObject(agent)) agent.access ??= "edit";
  }
  const names = new Set<string>();
  for (const rule of rules.rules) checkRule(issues, rules, rule, names, now);
  if (issues.length) throw new RulesError(issues);
  const limits = new Map<string, number | undefined>();
  const aliases = new Set<string>();
  const worktreePaths = new Set<string>();
  const worktreeBranches = new Set<string>();
  for (const rule of rules.rules) {
    const worker = rules.agents[rule.to].worker;
    for (const bindings of Object.values(rule.issueWorktrees ?? {})) {
      for (const [alias, binding] of Object.entries(bindings)) {
        const key = JSON.stringify([worker, binding.path]);
        const branch = JSON.stringify([worker, rule.repositories![alias].path, binding.branch]);
        if (worktreePaths.has(key) || worktreeBranches.has(branch))
          issues.push(`规则「${rule.name}」的 worktree 路径或分支重复登记：${binding.path}`);
        worktreePaths.add(key);
        worktreeBranches.add(branch);
      }
    }
  }
  for (const { group, parallel, name, aliases: ruleAliases } of rules.rules) {
    for (const alias of ruleAliases ?? []) {
      const key = alias.trim().toLowerCase();
      if (aliases.has(key)) issues.push(`规则「${name}」的别名「${alias}」重复`);
      aliases.add(key);
    }
    if (limits.has(group) && limits.get(group) !== parallel) issues.push(`组「${group}」里的规则 parallel 要一致`);
    limits.set(group, parallel);
  }
  for (const task of rules.elsewhere) {
    const name = nameOf(task);
    if (names.has(name)) issues.push(`定时任务「${name}」和别的规则或定时任务重名`);
    names.add(name);
    checkFields(issues, `定时任务「${name}」`, task, [
      ["name", isText, NOT_EMPTY],
      ["source", isKeyOf(rules.sources), "不是已登记的来源"],
      ["to", isKeyOf(rules.agents), "不是已登记的 Agent"],
      ["cron", isCron, "不是有效的 cron"],
      ["where", isText, NOT_EMPTY],
    ]);
  }
  if (issues.length) throw new RulesError(issues);
  return rules;
}
