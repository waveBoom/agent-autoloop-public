import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs, parseEnv, promisify } from "node:util";
import { eventRule, typeMatches, type Rules } from "../kernel/rules.ts";
import { hubClient } from "../protocol/client.ts";
import { issueRouteCandidates, routeCandidates } from "../protocol/route.ts";
import { parseRules } from "../protocol/rules.ts";
import { parseEvent, type EventInput } from "../protocol/validate.ts";
import {
  clarificationNotification,
  confirmedRequester,
  rememberObservedRequester,
  startNotification,
} from "../plugins/octo/requester.ts";
import { readRequesterRoute, requesterDelivery } from "../plugins/octo/requester-delivery.ts";

const statuses = ["backlog", "todo", "in_progress", "in_review"];
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const run = promisify(execFile);
type Scope = { workspaceId: string; assigneeUid: string; hubUrl: string };
type Route = { rule: string; source: string };
type RouteProgress = { created: boolean; comments: string[]; route?: Route; legacyEventIds?: boolean };
type Tracked = RouteProgress & {
  branches?: RouteProgress[];
  historical?: boolean;
  manuallyAdmitted?: boolean;
};
export type OctoState = { version: 1; scope: Scope; baselineAt: number; tasks: Record<string, Tracked> };
export type OctoTask = {
  task_id: string;
  workspace_id: string;
  assignee_octo_uid: string;
  status: string;
  title: string;
  description: string;
  created_at: string;
  identifier?: string;
  url?: string;
  creatorUid?: string;
};
type Comment = { comment_id: string; content: string; created_at: string };
type Input = {
  scope: Scope;
  rules: Rules;
  tasks: OctoTask[];
  routes: Record<string, string>;
  now: number;
  comments(task: string): Promise<Comment[]>;
  save(state: OctoState): void;
  emit(route: Route, event: EventInput): Promise<void>;
  sourceReady?(source: string): boolean;
  notifyStarted?(task: OctoTask): Promise<void>;
  notifyClarification?(task: OctoTask): Promise<void>;
  onRoute?(route: Route): void;
  selectedIssue?: string;
  selectedRule?: string;
};

export function issueSelector(input: string) {
  const short = /^[A-Z][A-Z0-9_]*-\d+$/i;
  const valid = (value: string) => uuid.test(value) || short.test(value);
  const raw = input.trim();
  if (valid(raw)) return raw.toUpperCase();
  const link = issueUrl(raw);
  if (!link) throw new Error("请提供 Issue 短编号、UUID，或带编号的 HTTP(S) 链接");
  const url = new URL(link);
  const segments = url.pathname.split("/").map(decodeURIComponent);
  const explicit = ["taskId", "task_id", "issueId", "issue_id", "identifier"].flatMap((key) =>
    url.searchParams.getAll(key),
  );
  const last = segments.filter(Boolean).at(-1);
  const candidates = [
    ...new Set([...explicit, ...(last ? [last] : [])].filter(valid).map((value) => value.toUpperCase())),
  ];
  if (candidates.length !== 1) throw new Error("链接未包含唯一的 Issue 编号，请直接填写编号");
  return candidates[0];
}

const eligible = (task: OctoTask, scope: Scope) =>
  task.workspace_id === scope.workspaceId &&
  task.assignee_octo_uid === scope.assigneeUid &&
  statuses.includes(task.status);
const clip = (value: string, length: number) => [...value].slice(0, length).join("");
function issueUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return;
  try {
    const url = new URL(value);
    if (
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      /^[\x21-\x7e]{1,500}$/.test(url.href)
    )
      return url.href;
  } catch {}
}
const matching = (rules: Rules, source: string, type: string) =>
  rules.rules.filter((rule) => eventRule(rule) && rule.when.source === source && typeMatches(rule.when.types, type));

function octoTypes(types: string[]) {
  const projects = types.filter((type) => /^task\.[a-z][a-z0-9-]*\.created$/.test(type));
  if (projects.length > 1) return;
  const created = projects[0] ?? "task.created";
  return { created, comment: created.replace(/\.created$/, ".comment") };
}

export async function collectOcto(prior: OctoState | undefined, input: Input) {
  const { scope, rules, routes } = input;
  const tasks = input.tasks.filter(
    (task) => eligible(task, scope) && (!input.selectedIssue || task.task_id === input.selectedIssue),
  );
  if (input.selectedIssue && tasks.length !== 1) throw new Error("指定 Issue 不在当前工作区、指派人和状态范围内");
  const pending: { task: string; candidates: string[]; reason: string }[] = [];
  if (prior && (prior.version !== 1 || JSON.stringify(prior.scope) !== JSON.stringify(scope)))
    throw new Error("采集记录与当前工作区、指派人或 Hub 不一致，请使用独立的状态文件");
  const state: OctoState = prior ? structuredClone(prior) : { version: 1, scope, baselineAt: input.now, tasks: {} };
  if (!prior && !input.selectedIssue) {
    for (const task of tasks) state.tasks[task.task_id] = { created: false, comments: [], historical: true };
    input.save(state);
    return { baseline: tasks.length, eligible: tasks.length, created: 0, comments: 0, pending };
  }
  let created = 0;
  let comments = 0;
  const noticeFailures: string[] = [];
  for (const task of tasks) {
    const id = task.task_id;
    const subject = `loop:${scope.workspaceId}:${id}`;
    const tracked = Object.hasOwn(state.tasks, id) ? state.tasks[id] : { created: false, comments: [] };
    if (
      !input.selectedIssue &&
      !tracked.manuallyAdmitted &&
      (tracked.historical || Date.parse(task.created_at) <= state.baselineAt)
    )
      continue;
    const saved = tracked.branches ?? (tracked.route ? [tracked] : undefined);
    const explicit = input.selectedRule;
    const requested = explicit ?? (Object.hasOwn(routes, id) ? routes[id] : undefined);
    const requestedRules =
      requested === undefined
        ? []
        : rules.rules.some((item) => item.name === requested)
          ? [requested]
          : routeCandidates(rules, "", requested);
    const candidates = saved
      ? saved.map(({ route }) => route!.rule)
      : requested !== undefined
        ? requestedRules
        : issueRouteCandidates(rules, task.title, task.description);
    if (explicit && requestedRules.length !== 1) throw new Error("指定规则不存在或匹配到多条规则");
    if (!candidates.length || (requested !== undefined && !saved && candidates.length !== 1)) {
      pending.push({ task: id, candidates, reason: "需要确认规则归属" });
      if (!saved && requested === undefined) {
        try {
          await input.notifyClarification?.(task);
        } catch {
          noticeFailures.push(id);
        }
      }
      continue;
    }
    const names = explicit && saved ? requestedRules : candidates;
    const destinations = names.flatMap((name) => {
      const rule = rules.rules.find((item) => item.name === name);
      const progress = saved?.find(({ route }) => route?.rule === name);
      if (
        !rule ||
        !eventRule(rule) ||
        !rule.parallel ||
        (progress?.route && progress.route.source !== rule.when.source)
      ) {
        pending.push({ task: id, candidates: [name], reason: "需要确认规则归属" });
        return [];
      }
      const source = rule.when.source;
      const types = octoTypes(rule.when.types);
      if (
        !types ||
        !Object.values(types).every((type) => {
          const matches = matching(rules, source, type);
          return matches.length === 1 && matches[0].name === name;
        })
      ) {
        pending.push({ task: id, candidates: [name], reason: "创建与评论事件须各自唯一命中同一规则" });
        return [];
      }
      if (input.sourceReady && !input.sourceReady(source)) {
        pending.push({ task: id, candidates: [name], reason: `缺少来源 ${source} 的 Hub 密钥` });
        return [];
      }
      const route = { rule: name, source };
      return [{ route, types, progress: progress ?? { route, created: false, comments: [] } }];
    });
    if (!saved && destinations.length !== names.length) continue;
    if (!destinations.length) continue;
    if (saved && explicit && !saved.some(({ route }) => route?.rule === requestedRules[0])) {
      const previous = tracked.branches ?? [
        {
          route: tracked.route,
          created: tracked.created,
          comments: tracked.comments,
          legacyEventIds: true,
        },
      ];
      tracked.branches = [...previous, destinations[0].progress];
    } else if (!saved) {
      if (destinations.length === 1) {
        tracked.route = destinations[0].route;
        destinations[0].progress = tracked;
      } else {
        tracked.branches = destinations.map(({ progress }) => progress);
      }
    }
    if (input.selectedIssue) {
      tracked.manuallyAdmitted = true;
      delete tracked.historical;
    }
    state.tasks[id] = tracked;
    if (!saved || input.selectedIssue) input.save(state);
    const title = task.identifier ? `${task.identifier} ${task.title}` : task.title;
    const details = { subject, summary: clip(title, 200), link: issueUrl(task.url) };
    const eventPrefix = ({ rule }: Route, progress: RouteProgress) =>
      tracked.branches && !progress.legacyEventIds
        ? `${subject}:rule:${createHash("sha256").update(rule).digest("hex").slice(0, 24)}`
        : subject;
    for (const { route, types, progress } of destinations) {
      input.onRoute?.(route);
      if (progress.created) continue;
      await input.emit(
        route,
        parseEvent({
          ...details,
          id: `${eventPrefix(route, progress)}:created`,
          type: types.created,
          detail: clip(task.description, 4000),
        }),
      );
      progress.created = true;
      input.save(state);
      created++;
    }
    try {
      await input.notifyStarted?.(task);
    } catch {
      noticeFailures.push(id);
    }
    if (input.selectedIssue) continue;
    const replies = (await input.comments(id))
      .filter((comment) => Date.parse(comment.created_at) >= state.baselineAt)
      .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.comment_id.localeCompare(b.comment_id));
    for (const { route, types, progress } of destinations) {
      const seen = new Set(progress.comments);
      for (const comment of replies) {
        if (seen.has(comment.comment_id)) continue;
        await input.emit(
          route,
          parseEvent({
            ...details,
            id: `${eventPrefix(route, progress)}:comment:${comment.comment_id}`,
            type: types.comment,
            detail: clip(`新增评论：\n${comment.content}\n\n任务描述：\n${task.description}`, 4000),
          }),
        );
        seen.add(comment.comment_id);
        progress.comments.push(comment.comment_id);
        input.save(state);
        comments++;
      }
    }
  }
  return {
    baseline: 0,
    eligible: tasks.length,
    created,
    comments,
    pending,
    ...(noticeFailures.length && { noticeFailures }),
  };
}

type Row = Record<string, unknown>;
type Page = { data: Row[]; _pagination?: { page: number; page_size: number; total: number } };
type Read = (path: string, params: Row, workspaceId?: string) => Promise<Page>;

function octoReader(profile: string): Read {
  return async (path, params, workspaceId) => {
    try {
      const { stdout } = await run(
        "octo-cli",
        [
          "--profile",
          profile,
          "--format",
          "json",
          "--timeout",
          "15s",
          "--no-retry",
          "api",
          "GET",
          path,
          "--service",
          "loop",
          ...(workspaceId ? ["--workspace-id", workspaceId] : []),
          "--params",
          JSON.stringify(params),
        ],
        { timeout: 20_000, maxBuffer: 8 * 1024 * 1024 },
      );
      const page = JSON.parse(stdout);
      if (page.ok !== true) throw new Error("返回格式无效");
      if (Array.isArray(page.data)) return page;
      if (/^\/fleet\/api\/v1\/tasks\/[a-f0-9-]+$/i.test(path)) {
        const item = page.data?.data ?? page.data;
        if (item && typeof item === "object" && !Array.isArray(item)) return { data: [item] };
      }
      throw new Error("返回格式无效");
    } catch (error) {
      let code = "查询失败或返回格式无效";
      try {
        const value = JSON.parse((error as { stderr?: string }).stderr ?? "").error.code;
        if (typeof value === "string" && /^[A-Z_0-9]+$/.test(value)) code = value;
      } catch {}
      throw new Error(`Octo 只读查询失败：${code}`);
    }
  };
}

export async function listOcto(read: Read, path: string, params: Row = {}, workspaceId?: string): Promise<Row[]> {
  const rows: Row[] = [];
  const pageSize = 100;
  for (let page = 1; page <= 100; page++) {
    const result = await read(path, { ...params, page, page_size: pageSize }, workspaceId);
    rows.push(...result.data);
    const meta = result._pagination;
    if (
      meta &&
      (!Number.isInteger(meta.total) ||
        meta.total < 0 ||
        meta.page !== page ||
        !Number.isInteger(meta.page_size) ||
        meta.page_size < 1)
    )
      throw new Error("Octo 分页信息无效");
    if (meta ? meta.page * meta.page_size >= meta.total : result.data.length < pageSize) return rows;
    if (!result.data.length) throw new Error("Octo 分页未完整返回");
  }
  throw new Error("Octo 查询超过分页上限，本次不使用部分数据");
}

type Config = {
  profile: string;
  workspace: string;
  assignee: string;
  hubUrl?: string;
  rulesFile: string;
  stateFile: string;
  sourceKeyEnv: Record<string, string>;
  routes?: Record<string, string>;
  intervalSeconds?: number;
  taskUrlTemplate?: string;
  requesterBotDir?: string;
};

function creatorUid(row: Row) {
  return typeof row.creator_octo_uid === "string" && !["bot", "agent"].includes(String(row.creator_type))
    ? row.creator_octo_uid
    : undefined;
}

function requesterNotifier(dir: string, workspaceId: string, stateFile: string, read: Read) {
  const route = readRequesterRoute(dir);
  const { local } = route;
  if (local.workspaceId !== workspaceId || !local.hubDb || !local.botId || !local.cli) {
    throw new Error("需求通知须与 Octo 建单及查进度配置使用同一个工作区");
  }
  const transport = requesterDelivery(dir, route);
  const intakeFile = join(dir, "data", "intake.sqlite");
  async function lookupCreator(task: OctoTask) {
    if (task.creatorUid) return task.creatorUid;
    const [detail] = (await read(`/fleet/api/v1/tasks/${task.task_id}`, {}, workspaceId)).data;
    if ((detail?.task_id ?? detail?.id) === task.task_id && detail.workspace_id === workspaceId)
      return creatorUid(detail);
  }
  async function started(task: OctoTask) {
    if (!existsSync(intakeFile)) {
      mkdirSync(join(dir, "data"), { recursive: true, mode: 0o700 });
      try {
        writeFileSync(intakeFile, "", { mode: 0o600, flag: "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    using db = new DatabaseSync(intakeFile);
    db.exec("PRAGMA busy_timeout=3000; PRAGMA synchronous=FULL");
    const existing = startNotification(db, task.task_id, route, task.identifier, task.url, undefined, task.title);
    const creator = existing ? undefined : await lookupCreator(task);
    const notice =
      existing ?? startNotification(db, task.task_id, route, task.identifier, task.url, creator, task.title);
    if (!notice) throw new Error("无法核实需求方");
    if (!notice.pending()) return;
    if (!(await transport.allowed(notice.sender))) throw new Error("需求方不在工作区或通知群");
    if (creator)
      rememberObservedRequester(db, {
        workspace: workspaceId,
        issue: task.task_id,
        sender: creator,
        identifier: task.identifier,
        url: task.url,
      });
    await notice.send(transport.send);
  }
  async function clarification(task: OctoTask) {
    let sender = task.creatorUid;
    if (existsSync(intakeFile)) {
      using intake = new DatabaseSync(intakeFile, { readOnly: true });
      sender = confirmedRequester(intake, task.task_id, route.intakeChannel)?.sender ?? sender;
    }
    const file = `${stateFile}.clarification.sqlite`;
    try {
      writeFileSync(file, "", { mode: 0o600, flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    using db = new DatabaseSync(file);
    db.exec("PRAGMA busy_timeout=3000; PRAGMA synchronous=FULL");
    const prior = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='octo_requester_notice'").get();
    if (
      prior &&
      db
        .prepare("SELECT 1 FROM octo_requester_notice WHERE issue=? AND stage='clarification' AND ref IS NOT NULL")
        .get(task.task_id)
    )
      return;
    if (!sender) sender = await lookupCreator(task);
    if (!sender) throw new Error("找不到可核实的需求方");
    if (!(await transport.allowed(sender))) throw new Error("需求方不在工作区或通知群");
    const label = task.identifier && /^[A-Za-z0-9_-]{1,80}$/.test(task.identifier) ? task.identifier : task.task_id;
    const notice = clarificationNotification(db, task.task_id, label, sender, task.title);
    await notice.send(() => transport.send(route.requesterChannel, notice.text, notice.sender));
  }
  return { started, clarification };
}

function readTrigger(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

export async function waitForOctoPoll(file: string, previous: string, ms: number): Promise<"trigger" | "interval"> {
  const deadline = performance.now() + ms;
  while (readTrigger(file) === previous) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) return "interval";
    await delay(Math.min(1000, remaining));
  }
  return "trigger";
}

export async function collectOctoCommand(args = process.argv.slice(2)) {
  const { values } = parseArgs({
    args,
    options: {
      config: { type: "string" },
      watch: { type: "boolean" },
      "dry-run": { type: "boolean" },
      baseline: { type: "boolean" },
      trigger: { type: "boolean" },
      issue: { type: "string" },
      rule: { type: "string" },
      "env-file": { type: "string" },
      "log-events": { type: "boolean" },
    },
  });
  if (!values.config)
    throw new Error(
      "用法：node cli/collect-octo.ts --config <配置文件> [--watch | --baseline | --trigger] [--issue <编号或链接> [--rule <规则名或别名>]] [--dry-run]",
    );
  if (values.baseline && (values.watch || values["dry-run"])) throw new Error("--baseline 须单独运行");
  if (values.issue !== undefined && (values.watch || values.baseline)) throw new Error("--issue 须单次运行");
  if (values.rule !== undefined && (!values.issue || !values.rule.trim()))
    throw new Error("--rule 须与 --issue 一起使用");
  if (values.trigger && (values.watch || values.baseline || (values["dry-run"] && values.issue === undefined)))
    throw new Error("--trigger 须单独运行或与 --issue 一起使用");
  const selected = values.issue === undefined ? undefined : issueSelector(values.issue);
  const file = resolve(values.config);
  const config = JSON.parse(readFileSync(file, "utf8")) as Config;
  const credentialFile = values["env-file"];
  const suppliedKeys = credentialFile ? parseEnv(readFileSync(credentialFile, "utf8")) : {};
  if (
    config.requesterBotDir !== undefined &&
    (typeof config.requesterBotDir !== "string" || !isAbsolute(config.requesterBotDir))
  ) {
    throw new Error("requesterBotDir 须为机器人配置目录的绝对路径");
  }
  if (
    config.taskUrlTemplate !== undefined &&
    (typeof config.taskUrlTemplate !== "string" ||
      !/\{(?:taskId|identifier)\}/.test(config.taskUrlTemplate) ||
      !issueUrl(config.taskUrlTemplate.replace(/\{[a-z]+\}/gi, "placeholder")))
  )
    throw new Error("taskUrlTemplate 须为带 {taskId} 或 {identifier} 的 HTTP(S) 地址");
  for (const value of [config.profile, config.workspace, config.assignee]) {
    if (typeof value !== "string" || !value.trim()) throw new Error("须填写 profile、workspace、assignee");
  }
  if (![config.rulesFile, config.stateFile].every((value) => typeof value === "string" && isAbsolute(value)))
    throw new Error("rulesFile 和 stateFile 须为绝对路径");
  const triggerFile = resolve(`${config.stateFile}.trigger`);
  if ([resolve(config.stateFile), triggerFile].some((path) => path === resolve(config.rulesFile) || path === file))
    throw new Error("采集状态或触发信号不能写入配置文件");
  if (values.trigger && !selected) {
    const temp = `${triggerFile}.${randomUUID()}.tmp`;
    writeFileSync(temp, randomUUID() + "\n", { mode: 0o600, flag: "wx" });
    renameSync(temp, triggerFile);
    console.log("已提交采集请求，运行中的采集器会处理");
    return;
  }
  if (values.baseline && existsSync(config.stateFile)) throw new Error("已有采集基线，保留原状态");
  const url = new URL(config.hubUrl ?? "http://127.0.0.1:3350");
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("hubUrl 须为本机回环 HTTP 地址");
  const seconds = config.intervalSeconds ?? 600;
  if (!Number.isSafeInteger(seconds) || seconds < 10 || seconds > 86400) throw new Error("采集间隔须为 10 到 86400 秒");
  const read = octoReader(config.profile);
  const workspaces = (await listOcto(read, "/fleet/api/v1/workspaces")).filter(
    (item) => item.name === config.workspace,
  );
  const workspaceId = workspaces[0]?.workspace_id;
  if (workspaces.length !== 1 || typeof workspaceId !== "string" || !uuid.test(workspaceId))
    throw new Error("未找到唯一的工作区，请核对名称和访问权限");
  const members = (await listOcto(read, `/fleet/api/v1/workspaces/${workspaceId}/members`, {}, workspaceId)).filter(
    (item) => item.name === config.assignee && item.robot !== 1,
  );
  const assigneeUid = members[0]?.uid;
  if (members.length !== 1 || typeof assigneeUid !== "string" || !assigneeUid)
    throw new Error("未找到唯一的指派成员，请核对姓名和访问权限");
  const scope = { workspaceId, assigneeUid, hubUrl: url.origin };
  const notifier =
    !values["dry-run"] && !values.baseline && config.requesterBotDir
      ? requesterNotifier(config.requesterBotDir, workspaceId, config.stateFile, read)
      : undefined;
  const readComments = async (id: string): Promise<Comment[]> => {
    const rows = await listOcto(read, `/fleet/api/v1/tasks/${id}/comments`, {}, workspaceId);
    return rows.map((row) => {
      if (
        row.task_id !== id ||
        typeof row.comment_id !== "string" ||
        !/^[A-Za-z0-9._:-]{1,100}$/.test(row.comment_id) ||
        typeof row.created_at !== "string" ||
        !Number.isFinite(Date.parse(row.created_at)) ||
        typeof row.content !== "string"
      )
        throw new Error("Octo 评论字段无效");
      return { comment_id: row.comment_id, content: row.content, created_at: row.created_at };
    });
  };
  const sourceKey = (source: string) => {
    const name = config.sourceKeyEnv?.[source];
    return typeof name === "string" && /^[A-Z_][A-Z_0-9]*$/.test(name)
      ? (process.env[name] ?? suppliedKeys[name])
      : undefined;
  };
  do {
    const triggerAtStart = values.watch ? readTrigger(triggerFile) : "";
    const events: { rule: string; subject: string; type: string; title: string; hubEvent?: number; outcome: string }[] =
      [];
    let omittedEvents = 0;
    try {
      const now = Date.now();
      const rules = parseRules(readFileSync(config.rulesFile, "utf8"), now, "Asia/Shanghai");
      const state: OctoState | undefined = existsSync(config.stateFile)
        ? JSON.parse(readFileSync(config.stateFile, "utf8"))
        : undefined;
      if (values.baseline && state !== undefined) throw new Error("已有采集基线，保留原状态");
      const rows = await listOcto(
        read,
        "/fleet/api/v1/tasks",
        {
          assignee_octo_uid: assigneeUid,
          statuses: statuses.join(","),
        },
        workspaceId,
      );
      const selectedRows = selected
        ? rows.filter((row) =>
            [row.task_id, row.identifier].some(
              (field) => typeof field === "string" && field.toUpperCase() === selected,
            ),
          )
        : rows;
      if (selected && selectedRows.length !== 1) throw new Error("没有找到唯一符合当前采集范围的 Issue");
      const tasks = selectedRows.map((row): OctoTask => {
        if (
          row.workspace_id !== workspaceId ||
          row.assignee_octo_uid !== assigneeUid ||
          typeof row.status !== "string" ||
          !statuses.includes(row.status) ||
          typeof row.task_id !== "string" ||
          !uuid.test(row.task_id) ||
          typeof row.title !== "string" ||
          typeof row.created_at !== "string" ||
          !Number.isFinite(Date.parse(row.created_at))
        )
          throw new Error("Octo 返回了筛选范围外的任务或字段无效");
        const fields: Record<string, unknown> = {
          taskId: row.task_id,
          identifier: row.identifier,
          workspaceId,
          workspaceSlug: workspaces[0].slug,
        };
        const template = config.taskUrlTemplate?.replace(/\{([a-zA-Z]+)\}/g, (match, field: string) => {
          const value = fields[field];
          return typeof value === "string" && value ? encodeURIComponent(value) : match;
        });
        return {
          task_id: row.task_id,
          workspace_id: workspaceId,
          assignee_octo_uid: assigneeUid,
          status: row.status,
          title: row.title,
          description: typeof row.description === "string" ? row.description : "",
          created_at: row.created_at,
          identifier: typeof row.identifier === "string" ? row.identifier : undefined,
          creatorUid: creatorUid(row),
          url:
            issueUrl(row.url) ??
            issueUrl(row.web_url) ??
            issueUrl(template && !template.includes("{") ? template : undefined),
        };
      });
      const previewRules: string[] = [];
      const result = await collectOcto(state, {
        scope,
        rules,
        tasks,
        routes: config.routes ?? {},
        now,
        comments: readComments,
        sourceReady: (source) => Boolean(values["dry-run"] || sourceKey(source)),
        notifyStarted: notifier?.started,
        notifyClarification: notifier?.clarification,
        selectedIssue: selected ? tasks[0].task_id : undefined,
        selectedRule: values.rule,
        onRoute:
          selected && values["dry-run"]
            ? (route) => {
                previewRules.push(route.rule);
              }
            : undefined,
        save: (next) => {
          if (values["dry-run"]) return;
          if (values.baseline) {
            writeFileSync(config.stateFile, JSON.stringify(next) + "\n", { mode: 0o600, flag: "wx" });
            return;
          }
          const temp = `${config.stateFile}.${randomUUID()}.tmp`;
          writeFileSync(temp, JSON.stringify(next) + "\n", { mode: 0o600, flag: "wx" });
          renameSync(temp, config.stateFile);
        },
        emit: async (route, event) => {
          if (values.baseline) throw new Error("建立基线时不能提交事件");
          if (values["dry-run"]) return;
          const entry: (typeof events)[number] = {
            rule: route.rule,
            subject: event.subject,
            type: event.type,
            title: event.summary
              .replace(/\b(?:bearer|token|password|api[_ -]?key)\s*[:= ]\s*\S+/gi, "[已隐藏]")
              .replace(/\b(?:sk-|gh[pousr]_)[A-Za-z0-9_-]{16,}/g, "[已隐藏]"),
            outcome: "未确认",
          };
          if (values["log-events"]) {
            if (events.length < 150) events.push(entry);
            else omittedEvents++;
          }
          const key = sourceKey(route.source);
          if (!key) throw new Error(`缺少来源 ${route.source} 的 Hub 密钥`);
          const ack = await hubClient(scope.hubUrl, key).event(event);
          if (
            !Number.isSafeInteger(ack?.event) ||
            ack.event < 1 ||
            !Array.isArray(ack.routed) ||
            ack.routed.length !== 1 ||
            ack.routed[0] !== route.rule
          )
            throw new Error("Hub 回执的规则归属与采集配置不一致，请核对运行中的规则");
          entry.hubEvent = ack.event;
          entry.outcome = ack.duplicate ? "重复事件" : "已接收";
        },
      });
      console.log(
        JSON.stringify(
          previewRules.length
            ? { ...result, rules: previewRules, ...(previewRules.length === 1 && { rule: previewRules[0] }) }
            : values["log-events"]
              ? { ...result, events, omittedEvents }
              : result,
        ),
      );
      if (selected && result.pending.length) process.exitCode = 1;
    } catch (error) {
      if (values["log-events"]) console.log(JSON.stringify({ events, omittedEvents }));
      if (!values.watch) throw error;
      console.error((error as Error).message);
    }
    if (values.watch) await waitForOctoPoll(triggerFile, triggerAtStart, seconds * 1000);
  } while (values.watch);
}

if (import.meta.main) {
  collectOctoCommand().catch((error: Error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
