import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DraftRequired, intake, issueUrl, type ChatTurn, type Draft } from "./intake.ts";
import { requesterIssues, requesterProgress } from "./requester.ts";
import { issueRouteCandidates } from "../../protocol/route.ts";
import { parseRules } from "../../protocol/rules.ts";

export type Settings = {
  workspaceId: string;
  assigneeUid: string;
  channelId: string;
  apiUrl: string;
  botId: string;
  botToken: string;
  cli: string;
  hubDb?: string;
  rulesFile?: string;
  workspaceSlug?: string;
  taskUrlTemplate?: string;
};
type Row = Record<string, unknown>;

async function cli(settings: Settings, args: string[], body?: Row): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      settings.cli,
      ["--no-retry", "--timeout", "12s", "loop", ...args, "--workspace-id", settings.workspaceId],
      {
        env: {
          HOME: process.env.HOME,
          PATH: process.env.PATH,
          OCTO_BOT_ID: settings.botId,
          OCTO_API_BASE_URL: new URL(settings.apiUrl).origin,
          OCTO_TOKEN: settings.botToken,
        },
        stdio: ["pipe", "pipe", "ignore"],
        timeout: 15_000,
      },
    );
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      output += chunk;
      if (output.length > 2_000_000) child.kill();
    });
    child.stdin.on("error", () => {});
    child.on("error", () => reject(new Error("无法运行 Octo CLI")));
    child.on("close", (code) => {
      try {
        const response = JSON.parse(output);
        if (code === 0 && response.ok === true) return resolve(response.data);
      } catch {}
      reject(new Error("Octo 请求失败"));
    });
    child.stdin.end(body && JSON.stringify(body));
  });
}

async function* workspaceMembers(settings: Settings) {
  for (let page = 1; page <= 100; page++) {
    const data = await cli(settings, [
      "workspace",
      "member",
      "list",
      settings.workspaceId,
      "--page",
      String(page),
      "--page-size",
      "100",
    ]);
    if (!Array.isArray(data)) throw new Error("无法核对 Octo 工作区成员");
    for (const member of data as Row[]) {
      if (
        member.robot === 0 &&
        typeof member.uid === "string" &&
        typeof member.name === "string" &&
        member.name.trim()
      ) {
        yield { uid: member.uid, name: member.name.trim() };
      }
    }
    if (data.length < 100) return;
  }
  throw new Error("无法完整核对 Octo 工作区成员");
}

export async function isWorkspaceMember(settings: Settings, sender: string) {
  if (!sender) return false;
  for await (const member of workspaceMembers(settings)) if (member.uid === sender) return true;
  return false;
}

async function resolveAssignee(settings: Settings, value: string) {
  const names = new Map<string, { uid: string; name: string }>();
  for await (const member of workspaceMembers(settings)) {
    if (member.uid === value) return member;
    if (member.name === value) names.set(member.uid, member);
  }
  if (names.size === 1) return names.values().next().value;
}

export function gatewayIntake(
  db: DatabaseSync,
  settings: Settings,
  summarize: (selection: string, turn: ChatTurn) => Promise<Draft>,
) {
  db.exec("PRAGMA busy_timeout=3000; PRAGMA synchronous=FULL");
  const handle = (turn: ChatTurn) =>
    intake(db, {
      allowed: (sender) => isWorkspaceMember(settings, sender),
      resolveAssignee: (value) => resolveAssignee(settings, value),
      checkProject(content) {
        const file = settings.rulesFile ?? (settings.hubDb && join(dirname(settings.hubDb), "rules.json"));
        if (!file) return;
        const rules = parseRules(readFileSync(file, "utf8"), Date.now(), "Asia/Shanghai");
        const matches = issueRouteCandidates(rules, "", content);
        if (matches.length)
          return matches.map((name) => rules.rules.find((rule) => rule.name === name)?.aliases?.[0] ?? name).join("、");
      },
      summarize: (selected) => summarize(selected, turn),
      async create({ draft, channel, message, reference, assignee }) {
        const response = (await cli(settings, ["task", "create", "--data", "@-"], {
          title: draft.title,
          description: `${draft.description}\n\nOcto 提交出处：频道 ${channel}，消息 ${message}\n提交编号：${reference}`,
          assignee_type: "member",
          assignee_octo_uid: assignee.uid,
        })) as Row;
        const row = (response?.data ?? response) as Row;
        const id = row?.id ?? row?.task_id;
        if (typeof id !== "string" || !id) throw new Error("Octo 未返回 Issue 编号");
        const identifier =
          typeof row.identifier === "string" && /^[A-Za-z][A-Za-z0-9_-]*-\d+$/.test(row.identifier)
            ? row.identifier
            : undefined;
        const fallback =
          settings.taskUrlTemplate && settings.workspaceSlug && identifier
            ? settings.taskUrlTemplate
                .replaceAll("{workspaceSlug}", encodeURIComponent(settings.workspaceSlug))
                .replaceAll("{identifier}", encodeURIComponent(identifier))
            : undefined;
        return { id, url: issueUrl(row.url) ?? issueUrl(row.web_url) ?? issueUrl(fallback), identifier };
      },
    })(turn);
  return async (turn: ChatTurn) => {
    if (turn.channel !== settings.channelId || !/^\/(?:提需求|确认提需求)(?:\s|$)/.test(turn.text.trim())) return;
    try {
      return await handle(turn);
    } catch (error) {
      if (error instanceof DraftRequired) throw error;
      return "暂时无法处理需求，请联系流程负责人核对工作区权限或答疑服务。";
    }
  };
}

export function canReadGroupProgress(requesterChannel: unknown, turn: Pick<ChatTurn, "channel" | "channelType">) {
  return (
    typeof requesterChannel === "string" &&
    /^[A-Za-z0-9-]+____[1-9]\d*$/.test(requesterChannel) &&
    ((turn.channelType === 5 && turn.channel === requesterChannel) ||
      (turn.channelType === 2 && turn.channel === requesterChannel.split("____", 1)[0]))
  );
}

export async function handleGatewayIntake(
  bot: Pick<Settings, "apiUrl" | "botToken" | "botId"> & { dataDir: string },
  turn: ChatTurn,
  summarize: (selection: string, turn: ChatTurn) => Promise<Draft>,
) {
  const command = turn.text.trim();
  const progress = /^\/(查进度|进度|查时间线)(?:\s+([\s\S]*))?$/.exec(command);
  const list = command === "/我的需求";
  const help = command === "/流程帮助" || command === "/help";
  if (!progress && !list && !help && !/^\/(?:提需求|确认提需求)(?:\s|$)/.test(command)) return;
  const configFile = join(dirname(bot.dataDir), "intake.json");
  if (!existsSync(configFile)) return;
  const local = JSON.parse(readFileSync(configFile, "utf8"));
  if (local.botId !== bot.botId) return;
  if (help)
    return [
      "Issue 流程命令",
      "/提需求 指派给 姓名或UID：下一行填写需求，在建单子区生成草稿",
      "/确认提需求 确认码：确认草稿并创建 Issue",
      "/我的需求：查看自己最近提交的 10 条 Issue",
      "/查进度 Issue编号：查看受理时间和当前处理阶段",
      "/查时间线 Issue编号：查看排查用的详细执行记录",
      "/回复卡 Issue编号：查看卡号和选项（仅审批人）",
      "/回复卡 卡号 选项序号 [补充说明]：在审批群或子区提交回复",
      "/通知 Issue编号 提测|需求上线：通知需求方（仅审批人）",
      "/完成 Issue编号 [结案原因]：手动结案（仅审批人）",
      "/流程帮助：查看本菜单",
    ].join("\n");
  if (!progress && !list && local.channelId !== turn.channel) return;
  const settings = { ...local, ...bot } as Settings;
  if (new URL(settings.apiUrl).origin !== local.apiOrigin) throw new Error("Octo 网关与配置不符");
  const dbPath = join(bot.dataDir, "intake.sqlite");
  if (progress || list) {
    if (progress && !/^\S{1,80}$/.test(progress[2] ?? "")) return `请发送 /${progress[1]} Issue编号。`;
    const groupAccess =
      !!progress &&
      (progress[1] === "查时间线"
        ? canReadGroupProgress(local.requesterChannelId, turn)
        : turn.channelType === 2 || turn.channelType === 5);
    const missing = groupAccess
      ? "Hub 未采集到这条 Issue。"
      : list
        ? "找不到你提交的 Issue。"
        : "找不到你提交的这条 Issue。";
    if (!settings.hubDb || (!groupAccess && !existsSync(dbPath))) return missing;
    try {
      if (!groupAccess && !(await isWorkspaceMember(settings, turn.sender))) return missing;
      using db = groupAccess ? undefined : new DatabaseSync(dbPath);
      using hub = new DatabaseSync(settings.hubDb, { readOnly: true });
      if (list) {
        if (!db) return missing;
        const issues = requesterIssues(db, hub, settings.workspaceId, turn.sender, settings.assigneeUid);
        if (!issues.length) return missing;
        const tracked = (await resolveAssignee(settings, settings.assigneeUid))?.name;
        const coverage = tracked
          ? `Hub 只跟踪当前指派给${tracked}的 Issue。`
          : "Hub 只跟踪当前采集配置指定负责人的 Issue。";
        return [
          coverage,
          ...issues.map(({ label, state, assignee }) => `${label} · 提交时指派：${assignee ?? "未记录"} · ${state}`),
        ].join("\n");
      }
      const detailed = progress?.[1] === "查时间线";
      const result = requesterProgress(
        db,
        hub,
        settings.workspaceId,
        turn.sender,
        progress![2],
        !detailed && turn.channelType === 1 ? turn.channel : undefined,
        detailed,
        groupAccess,
      );
      if (!result) return missing;
      const format = new Intl.DateTimeFormat("zh-CN", {
        dateStyle: "short",
        timeStyle: "short",
        timeZone: "Asia/Shanghai",
      });
      const entries = detailed
        ? (result.timeline ?? [])
        : result.receivedAt
          ? [{ state: "已受理", at: result.receivedAt }]
          : [];
      const steps = entries.map(({ state, at }) =>
        at && Number.isFinite(Date.parse(at)) ? `${format.format(new Date(at))} · ${state}` : state,
      );
      const url = result.url ? new URL(result.url) : undefined;
      const showUrl =
        url &&
        (turn.channelType === 1 ||
          (url.origin === local.apiOrigin &&
            /^\/fleet\/[^/]+\/issues\/[A-Za-z][A-Za-z0-9_-]*-\d+\/?$/.test(url.pathname)));
      return [
        `${result.label}：${result.publicState}`,
        ...(result.projects ?? []).map(
          ({ rule, state, latestProgress }) =>
            `${rule} · ${state}${latestProgress ? `（${latestProgress.replace(/\s+/g, " ")}）` : ""}`,
        ),
        ...(result.latestProgress ? [`最新进展：${result.latestProgress.replace(/\s+/g, " ")}`] : []),
        ...steps,
        ...(showUrl ? [url.href] : []),
      ].join("\n");
    } catch {
      return "暂时无法读取 Hub 进度，请稍后再试。";
    }
  }
  try {
    closeSync(openSync(dbPath, "wx", 0o600));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  using db = new DatabaseSync(dbPath);
  return await gatewayIntake(db, settings, summarize)(turn);
}
